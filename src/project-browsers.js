// One persistent Chrome profile and network-policy proxy per Git project.
// Each OpenCode chat still owns a separate browser runtime and its own tabs.
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createChromeProcess } from './chrome-process.js';
import { originGrants, networkGrants } from './config.js';
import { createPolicyProxy } from './policy-proxy.js';

export const projectIdFor = (directory) => {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) {
    throw new Error('Browser project requires an absolute directory');
  }
  // Canonicalize worktrees to their common Git directory. A normal folder
  // uses its real path. We do not use an agent-supplied project ID.
  const real = fs.realpathSync(directory);
  let identity = real;
  try {
    const gitDir = execFileSync('git',
      ['-C', real, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
      { encoding: 'utf8', timeout: 1500, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    identity = fs.realpathSync(gitDir);
  } catch {
    // Non-Git projects work as well.
  }
  return crypto.createHash('sha256').update(identity).digest('hex');
};

export const createProjectBrowsers = ({
  chromePath = null,
  profileRoot = path.join(os.homedir(), '.local', 'share', 'openchamber-server-browser', 'profiles'),
  allowedOrigins = [],
  allowedNetworks = [],
  configPath = null,
  devServers = null,
  resolveProject = projectIdFor,
} = {}) => {
  const projects = new Map();
  const grants = [...originGrants(allowedOrigins), ...networkGrants(allowedNetworks)];
  const acquire = (context) => {
    const id = resolveProject(context.directory);
    let entry = projects.get(id);
    if (!entry) {
      const proxy = createPolicyProxy({
        grants, configPath,
        devServerGrants: devServers ? () => devServers.grants() : null,
      });
      const owners = new Map();
      const profileDir = path.join(profileRoot, id);
      let chrome = null;
      let pending = null;
      entry = {
        id, proxy, owners, profileDir, refs: 0,
        async ensure() {
          if (!pending) {
            pending = (async () => {
              const proxyAddress = await proxy.listen();
              chrome = createChromeProcess({
                chromePath, profileDir,
                proxyServer: proxyAddress,
              });
              chrome.onExit((detail) => {
                for (const listener of entry.exitListeners) listener(detail);
              });
              return chrome.ensure();
            })();
          }
          return pending;
        },
        onExit(listener) {
          // Installed before first action, when Chrome has not started yet.
          const callbacks = entry.exitListeners;
          callbacks.add(listener);
          return () => callbacks.delete(listener);
        },
        exitListeners: new Set(),
        claim(targetId, scopeId) { owners.set(targetId, scopeId); },
        owner(targetId) { return owners.get(targetId); },
        forget(targetId, scopeId) {
          if (owners.get(targetId) === scopeId) owners.delete(targetId);
        },
        async shutdown() {
          // The browser's disk profile is never deleted on a normal shutdown.
          await chrome?.close();
          await proxy.close();
          owners.clear();
        },
      };
      projects.set(id, entry);
    }
    entry.refs += 1;
    let released = false;
    return {
      id,
      ensure: () => entry.ensure(),
      claim: (targetId, scopeId) => entry.claim(targetId, scopeId),
      owner: (targetId) => entry.owner(targetId),
      forget: (targetId, scopeId) => entry.forget(targetId, scopeId),
      onExit: (listener) => entry.onExit(listener),
      async release() {
        if (released) return;
        released = true;
        entry.refs -= 1;
        if (entry.refs === 0) {
          projects.delete(id);
          await entry.shutdown();
        }
      },
    };
  };
  return { acquire, get size() { return projects.size; } };
};
