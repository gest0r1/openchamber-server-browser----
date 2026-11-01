import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { createProjectBrowsers, projectIdFor } from '../src/project-browsers.js';
import { createBrowserRuntime } from '../src/browser-runtime.js';
import { resolveChromePath } from '../src/chrome-process.js';

let availableChrome = null;
try { availableChrome = resolveChromePath(); } catch {}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'oc-persistent-project-'));
const waitFor = async (predicate, timeout = 5000) => {
  const until = Date.now() + timeout;
  for (;;) {
    try { if (await predicate()) return; } catch {}
    if (Date.now() >= until) throw new Error('Timed out waiting for browser');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};
const evaluate = async (page, expression) => {
  const result = await page.cdp.sendSession(page.sessionId, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
  return result.result.value;
};
const visit = async (page, url) => {
  await page.cdp.sendSession(page.sessionId, 'Page.navigate', { url });
  await waitFor(async () => (await evaluate(page, 'document.readyState')) === 'complete'
    && (await evaluate(page, 'location.href')) === url);
};

test('project IDs normalize symlinks and separate ordinary directories', () => {
  const root = tmp();
  try {
    fs.mkdirSync(path.join(root, 'a'));
    fs.mkdirSync(path.join(root, 'b'));
    fs.symlinkSync(path.join(root, 'a'), path.join(root, 'alias'));
    assert.equal(projectIdFor(path.join(root, 'a')), projectIdFor(path.join(root, 'alias')));
    assert.notEqual(projectIdFor(path.join(root, 'a')), projectIdFor(path.join(root, 'b')));
    assert.throws(() => projectIdFor('../relative'), /absolute/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Git worktrees share a project ID', () => {
  const root = tmp();
  try {
    const repo = path.join(root, 'repo');
    const worktree = path.join(root, 'worktree');
    fs.mkdirSync(repo);
    execFileSync('git', ['init', '-q', repo]);
    execFileSync('git', ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'base']);
    execFileSync('git', ['-C', repo, 'worktree', 'add', '--detach', '-q', worktree]);
    assert.equal(projectIdFor(repo), projectIdFor(worktree));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('project profile shares cookies and localStorage across chats, survives restart, and isolates projects',
  { skip: availableChrome ? false : 'Chromium unavailable' },
  async () => {
    const root = tmp();
    const projectA = path.join(root, 'a');
    const projectB = path.join(root, 'b');
    const profileRoot = path.join(root, 'profiles');
    fs.mkdirSync(projectA);
    fs.mkdirSync(projectB);
    const server = http.createServer((request, response) => {
      response.setHeader('content-type', 'text/html');
      response.end('<title>Project profile test</title><body>ready</body>');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const pool = createProjectBrowsers({ profileRoot, allowedOrigins: [origin], chromePath: availableChrome });
    const sessions = new Set();
    const open = (directory, sessionId) => {
      const runtime = createBrowserRuntime({
        sharedProject: pool.acquire({ directory }),
        scopeId: JSON.stringify([directory, sessionId]),
      });
      sessions.add(runtime);
      return runtime;
    };
    try {
      const a1 = open(projectA, 'one');
      const pageA1 = await a1.ensurePage();
      await visit(pageA1, origin + '/login');
      await evaluate(pageA1, `document.cookie='oc_test=authenticated; path=/'; localStorage.setItem('oc_test','authenticated')`);
      const a2 = open(projectA, 'two');
      const pageA2 = await a2.ensurePage();
      await visit(pageA2, origin + '/dashboard');
      assert.match(await evaluate(pageA2, 'document.cookie'), /oc_test=authenticated/);
      assert.equal(await evaluate(pageA2, "localStorage.getItem('oc_test')"), 'authenticated');
      await assert.rejects(a2.agentPage(pageA1.targetId), /no tab/);
      const b = open(projectB, 'three');
      const pageB = await b.ensurePage();
      await visit(pageB, origin + '/dashboard');
      assert.doesNotMatch(await evaluate(pageB, 'document.cookie'), /oc_test/);
      assert.equal(await evaluate(pageB, "localStorage.getItem('oc_test')"), null);
      await a1.close();
      sessions.delete(a1);
      assert.match(await evaluate(pageA2, 'document.cookie'), /oc_test=authenticated/);
      await a2.close();
      sessions.delete(a2);
      assert.ok(fs.existsSync(path.join(profileRoot, projectIdFor(projectA))), 'profile retained on disk');
      const a3 = open(projectA, 'four');
      const pageA3 = await a3.ensurePage();
      await visit(pageA3, origin + '/dashboard');
      assert.match(await evaluate(pageA3, 'document.cookie'), /oc_test=authenticated/);
      assert.equal(await evaluate(pageA3, "localStorage.getItem('oc_test')"), 'authenticated');
    } finally {
      for (const runtime of sessions) await runtime.close().catch(() => {});
      await new Promise((resolve) => server.close(resolve));
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
