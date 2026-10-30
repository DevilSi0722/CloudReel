// Only this app's isolated session is used. The fixture reads account quota;
// it never enumerates the library or writes remote files.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const source = process.env.CLOUDREEL_SESSION_SNAPSHOT || path.join(process.env.APPDATA, 'CloudReel');
const packageRoot = process.argv.includes('--packaged') ? path.join(root, 'release/win-unpacked/resources/app.asar') : '';
if (packageRoot) await fs.access(packageRoot);
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cloudreel-quota-check-'));
try {
  const partition = path.join('Partitions', 'cloudreel-baidu-web');
  await fs.mkdir(path.join(directory, partition), {recursive: true});
  await fs.copyFile(path.join(source, 'Local State'), path.join(directory, 'Local State'));
  await fs.cp(path.join(source, partition, 'Network'), path.join(directory, partition, 'Network'), {recursive: true});
  const code = await new Promise((resolve, reject) => {
    const child = spawn(createRequire(import.meta.url)('electron'), [path.join(root, 'tests/fixtures/real-baidu-quota.mjs')], {cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: {...process.env, CLOUDREEL_TEST_DIRECTORY: directory, CLOUDREEL_PACKAGE_ROOT: packageRoot}});
    let output = '';
    child.stdout.on('data', chunk => {
      output += chunk;
      const lines = output.split('\n');output = lines.pop();
      for (const line of lines) if (line.startsWith('REAL_QUOTA_RESULT ')) process.stdout.write(line + '\n');
    });child.stderr.resume();
    const timer = setTimeout(() => {child.kill();resolve(1);}, 90000);
    child.once('error', reject);child.once('exit', result => {clearTimeout(timer);resolve(result ?? 1);});
  });
  if (code !== 0) throw new Error('Read-only quota acceptance failed; no live profile was modified.');
} finally {
  if (path.dirname(path.resolve(directory)) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith('cloudreel-quota-check-')) throw new Error('Unexpected verification directory');
  await fs.rm(directory, {recursive: true, force: true, maxRetries: 12, retryDelay: 250});
}
