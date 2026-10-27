import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url))), require = createRequire(import.meta.url);
const electronDirectory = path.join(root, 'node_modules', 'electron');
const { version } = require(path.join(electronDirectory, 'package.json'));
if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('当前项目验证的是 Windows x64，请在该平台运行桌面版本。');
const dist = path.join(electronDirectory, 'dist');
try {
  if (fs.existsSync(path.join(dist, 'electron.exe')) && fs.readFileSync(path.join(dist, 'version'), 'utf8').trim().replace(/^v/, '') === version && fs.readFileSync(path.join(electronDirectory, 'path.txt'), 'utf8').trim() === 'electron.exe') process.exit(0);
} catch { /* Install the missing/incomplete runtime below. */ }
const filename = `electron-v${version}-win32-x64.zip`, archive = path.join(root, '.runtime', filename);
const expected = require(path.join(electronDirectory, 'checksums.json'))[filename];
if (!expected) throw new Error('Electron npm 包未提供此构建的校验值，已停止安装。');
fs.mkdirSync(path.dirname(archive), { recursive: true });
const valid = file => fs.existsSync(file) && createHash('sha256').update(fs.readFileSync(file)).digest('hex') === expected;
const run = (binary, args) => new Promise((resolve, reject) => {
  const child = spawn(binary, args, { stdio: 'inherit', windowsHide: true });
  child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(new Error(`安装命令退出：${code}`)));
});
if (!valid(archive)) {
  console.log(`下载 Electron ${version}（使用 Windows 系统网络）…`);
  const partial = archive + '.partial';
  const url = `https://github.com/electron/electron/releases/download/v${version}/${filename}`;
  await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Invoke-WebRequest -Uri '${url}' -OutFile '${partial.replaceAll("'", "''")}' -TimeoutSec 180`]);
  if (!valid(partial)) throw new Error('Electron SHA256 校验不匹配，未执行下载的程序。');
  fs.renameSync(partial, archive);
}
const { path7za } = require('7zip-bin');
await run(path7za, ['x', '-y', '-bd', `-o${dist}`, archive]);
fs.writeFileSync(path.join(electronDirectory, 'path.txt'), 'electron.exe');
console.log(`Electron ${version} 已校验并安装。`);
