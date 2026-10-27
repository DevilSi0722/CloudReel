import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('此脚本安装 Windows x64 mpv，其他系统请自行安装后在设置中选择。');
const require = createRequire(import.meta.url), { path7za } = require('7zip-bin');
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url))), target = path.join(root, '.runtime', 'mpv');
await fs.mkdir(target, { recursive: true });
// Pin a specific upstream build for reproducible installation.
const filename = 'mpv-x86_64-20261021-git-e471496c56.7z';
const url = 'https://github.com/shinchiro/mpv-winbuild-cmake/releases/download/20261021/' + filename;
const archive = path.join(root, '.runtime', filename);
const run = (binary, args) => new Promise((resolve, reject) => {
  const child = spawn(binary, args, { stdio: 'inherit', windowsHide: true });
  child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(new Error(`命令执行失败：${code}`)));
});
let cached = false;
try { await fs.access(archive); await run(path7za, ['t', archive]); cached = true; } catch { /* A missing/partial archive is downloaded again. */ }
if (!cached) {
  console.log('从 shinchiro/mpv-winbuild-cmake 下载 Windows x64 mpv…');
  const partial = archive + '.partial';
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(45000) });
    if (!response.ok) throw new Error(`下载失败：HTTP ${response.status}`);
    await pipeline(Readable.fromWeb(response.body), createWriteStream(partial));
  } catch {
    // Native Windows networking also respects the user's system proxy settings.
    console.log('改用 Windows 系统网络下载…');
    await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Invoke-WebRequest -Uri '${url}' -OutFile '${partial.replaceAll("'", "''")}' -TimeoutSec 180`]);
  }
  await fs.rename(partial, archive);
}
await new Promise((resolve, reject) => {
  const child = spawn(path7za, ['x', '-y', `-o${target}`, archive], { stdio: 'inherit', windowsHide: true });
  child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(new Error(`解压失败：${code}`)));
});
await fs.access(path.join(target, 'mpv.exe'));
await fs.writeFile(path.join(target, 'CLOUDREEL-SOURCE.txt'), `Source: ${url}\nmpv and its components retain their own licenses. See accompanying files and https://mpv.io/copyright/\n`);
await fs.unlink(archive);
console.log('mpv 已安装，重新打开应用即可播放。');
