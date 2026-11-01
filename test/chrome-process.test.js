import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createChromeProcess, resolveChromePath, windowsChromeMajor } from '../src/chrome-process.js';

// A VS_VERSIONINFO resource as chrome.exe carries it: lengths and type, the key,
// padding to a 32-bit boundary, then VS_FIXEDFILEINFO.
const versionResource = (major, minor, build, patch) => {
  const fixed = Buffer.alloc(52);
  fixed.writeUInt32LE(0xfeef04bd, 0);
  fixed.writeUInt32LE(0x00010000, 4);
  fixed.writeUInt32LE(major * 0x10000 + minor, 8);
  fixed.writeUInt32LE(build * 0x10000 + patch, 12);
  return Buffer.concat([Buffer.alloc(6), Buffer.from('VS_VERSION_INFO\0', 'utf16le'), Buffer.alloc(2), fixed]);
};

test('reads Chrome\'s major version from a Windows executable', () => {
  // Given an executable whose version resource says 156.0.8078.73, after stray signature bytes and an
  // unrelated mention of the key, as in the real chrome.exe.
  const image = Buffer.concat([
    Buffer.from([0xbd, 0x04, 0xef, 0xfe, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x7c, 0x24]),
    Buffer.alloc(52),
    Buffer.from('VS_VERSION_INFO\0', 'utf16le'),
    Buffer.alloc(64),
    versionResource(156, 0, 8078, 73),
  ]);

  // Then the major version is 156, and an executable without the resource has none.
  assert.equal(windowsChromeMajor(image), 156);
  assert.equal(windowsChromeMajor(Buffer.alloc(256)), null);
  assert.equal(windowsChromeMajor(versionResource(156, 0, 8078, 73).subarray(0, 50)), null);
});

let chromium = null;
try { chromium = resolveChromePath(); } catch {}

test('persistent profile ignores stale DevToolsActivePort and starts a fresh Chrome',
  { skip: chromium ? false : 'Chromium unavailable' }, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-chrome-stale-port-'));
    const profileDir = path.join(root, 'persistent');
    fs.mkdirSync(profileDir);
    fs.writeFileSync(path.join(profileDir, 'DevToolsActivePort'),
      '34711\\n/devtools/browser/no-longer-running\\n');
    const browser = createChromeProcess({ chromePath: chromium, profileDir, startupTimeoutMs: 20000 });
    try {
      const info = await browser.ensure();
      assert.notEqual(new URL(info.endpoint).port, '34711');
      assert.equal(info.profileDir, profileDir);
    } finally {
      await browser.close();
      assert.equal(fs.existsSync(profileDir), true, 'persistent profile must remain on disk');
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

test('a failed Chrome startup can be retried without restarting the service',
  { skip: process.platform === 'win32' ? 'POSIX executable fixture' : false }, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-chrome-retry-'));
    const launcher = path.join(root, 'fake-chrome');
    const marker = path.join(root, 'launch-count');
    const profileDir = path.join(root, 'profile');
    // --version is probed separately. Each real launch fails immediately.
    fs.writeFileSync(launcher, `#!/bin/sh
if [ "$1" = "--version" ]; then echo "Chromium 144.0.0.0"; exit 0; fi
echo launched >> "${marker}"
exit 9
`, { mode: 0o700 });
    const browser = createChromeProcess({ chromePath: launcher, profileDir, startupTimeoutMs: 5000 });
    try {
      await assert.rejects(browser.ensure(), /Chrome exited during startup/);
      await assert.rejects(browser.ensure(), /Chrome exited during startup/);
      assert.equal(fs.readFileSync(marker, 'utf8').trim().split('\\n').length, 2);
    } finally {
      await browser.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
