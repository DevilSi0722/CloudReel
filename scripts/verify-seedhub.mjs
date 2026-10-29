import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cloudreel-discovery-'));
let summary;
try {
  const code = await new Promise((resolve, reject) => {
    const child = spawn(createRequire(import.meta.url)('electron'), [path.join(root, 'experiments/seedhub/live.mjs'), ...process.argv.slice(2)], {
      cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: {...process.env, CLOUDREEL_DISCOVERY_TEST_DIRECTORY: directory}
    });
    let pending = '';
    child.stdout.on('data', chunk => {
      pending += chunk.toString();
      const lines = pending.split('\n'); pending = lines.pop();
      for (const line of lines) {
        if (line.startsWith('SEEDHUB_RESEARCH_RESULT ')) summary = JSON.parse(line.slice('SEEDHUB_RESEARCH_RESULT '.length));
        if (line.startsWith('SEEDHUB_RESEARCH_PROGRESS ')) console.log(line);
      }
    });
    child.stderr.resume();
    const timer = setTimeout(() => { child.kill(); }, 180000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', result => { clearTimeout(timer); resolve(result ?? 1); });
  });
  if (code !== 0 || !summary) throw new Error('隐藏研究进程没有正常完成。');
} finally {
  if (path.dirname(path.resolve(directory)) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith('cloudreel-discovery-')) throw new Error('Unexpected research directory');
  await fs.rm(directory, {recursive: true, force: true, maxRetries: 12, retryDelay: 250});
}
console.log(JSON.stringify({...summary, temporaryProfileRemoved: true}, null, 2));
// A blocked live probe is not an integration pass.
if (summary.result === 'blocked') process.exitCode = 2;
