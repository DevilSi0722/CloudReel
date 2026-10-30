import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
test('hidden file management UI requires preview, confirms cloud deletion and keeps partial results accessible', {skip: process.platform !== 'win32', timeout: 40000}, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cloudreel-file-ui-'));
  try {
    const result = await new Promise((resolve, reject) => {
      const child = spawn(createRequire(import.meta.url)('electron'), [path.join(root, 'tests/fixtures/file-management-ui-window.mjs')], {cwd: root, windowsHide: true, env: {...process.env, CLOUDREEL_TEST_DIRECTORY: directory}});
      let output = ''; child.stdout.on('data', chunk => output += chunk); child.stderr.on('data', chunk => output += chunk);
      const timer = setTimeout(() => {child.kill(); reject(new Error('Hidden file manager timeout'));}, 35000);
      child.once('error', reject); child.once('exit', code => {clearTimeout(timer); resolve({code, output});});
    });
    assert.equal(result.code, 0, result.output); assert.match(result.output, /"deleteConfirmation":true/);
  } finally {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir())); assert.ok(path.basename(directory).startsWith('cloudreel-file-ui-'));
    await fs.rm(directory, {recursive: true, force: true, maxRetries: 5, retryDelay: 100});
  }
});
