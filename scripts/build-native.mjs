import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';

if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('原生输入组件需要 Windows x64 构建环境。');
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url))),require=createRequire(import.meta.url);
const archive=path.join(root,'.runtime/tcc-0.9.27-win64-bin.zip'),compiler=path.join(root,'.runtime/tcc-0.9.27/tcc/tcc.exe');
const expected='34a721949a2583fdff725312da092fa0f5f1f284b702e6f811c6954714faabb2';
const url='https://download.savannah.gnu.org/releases/tinycc/tcc-0.9.27-win64-bin.zip';
const valid=()=>fs.existsSync(archive)&&createHash('sha256').update(fs.readFileSync(archive)).digest('hex')===expected;
const run=(binary,args)=>new Promise((resolve,reject)=>{
  const child=spawn(binary,args,{cwd:root,windowsHide:true,stdio:'inherit'});
  child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(new Error(`原生输入组件构建失败：${code}`)));
});
fs.mkdirSync(path.dirname(archive),{recursive:true});
if(!valid()){
  const partial=archive+'.partial';
  await run('powershell.exe',['-NoProfile','-NonInteractive','-Command',`Invoke-WebRequest -Uri '${url}' -OutFile '${partial.replaceAll("'","''")}' -TimeoutSec 180`]);
  if(createHash('sha256').update(fs.readFileSync(partial)).digest('hex')!==expected)throw new Error('TinyCC SHA256 不匹配，未执行下载的程序。');
  fs.renameSync(partial,archive);
}
if(!fs.existsSync(compiler))await run(require('7zip-bin').path7za,['x','-y','-bd',`-o${path.dirname(path.dirname(compiler))}`,archive]);
await run(compiler,['-m64','-shared','-o','electron/native/cloudreel-input.dll','electron/native/player-input.c','electron/native/comctl32.def','-luser32']);
console.log('CloudReel native mouse input built from player-input.c.');
