// Builds a uniquely named application with its own installer identity, registry
// keys and synthetic profile. No real CloudReel process/profile is touched.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {createHash,randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url)),require=createRequire(import.meta.url);
const {build,Platform}=require('electron-builder');
const {Arch}=require('builder-util');
const directory=await fs.mkdtemp(path.join(os.tmpdir(),'cloudreel-update-install-')),appDir=path.join(directory,'app'),installDir=path.join(directory,'installed'),tag=randomUUID().slice(0,8),productName='CloudReel Update Acceptance '+tag;
let server,installed=false;
let target,sha512,corrupt=true,rejected=false;
const run=(binary,args,env=process.env)=>new Promise((resolve,reject)=>{const child=spawn(binary,args,{windowsHide:true,stdio:'ignore',env});const timer=setTimeout(()=>{child.kill();reject(Error('acceptance process timed out'));},300000);child.once('error',reject);child.once('exit',code=>{clearTimeout(timer);code===0?resolve():reject(Error('acceptance process failed: '+code));});});
const progress=message=>console.log('APP_UPDATE_ACCEPTANCE '+JSON.stringify({progress:message}));
try{
  await fs.mkdir(appDir,{recursive:true});
  await fs.copyFile(path.join(root,'tests/fixtures/app-update-installed.mjs'),path.join(appDir,'main.mjs'));
  await fs.copyFile(path.join(root,'electron/services/app-updater.mjs'),path.join(appDir,'app-updater.mjs'));
  await fs.copyFile(path.join(root,'electron/services/app-shutdown.mjs'),path.join(appDir,'app-shutdown.mjs'));
  server=http.createServer((request,response)=>{
    if(request.url==='/verified-corruption'){corrupt=false;rejected=true;response.end('ok');return;}
    if(request.url?.startsWith('/latest.yml')&&target){response.setHeader('Content-Type','text/yaml');response.end(`version: 0.3.22\nfiles:\n  - url: CloudReel-Setup-0.3.22-win-x64.exe\n    sha512: ${sha512}\n    size: ${target.length}\npath: CloudReel-Setup-0.3.22-win-x64.exe\nsha512: ${sha512}\nreleaseDate: 2026-11-03T00:00:00.000Z\n`);return;}
    if(request.url?.startsWith('/CloudReel-Setup-0.3.22-win-x64.exe')&&target){const bytes=Buffer.from(target);if(corrupt)bytes[bytes.length-1]^=1;response.setHeader('Content-Length',bytes.length);response.end(bytes);return;}
    response.statusCode=404;response.end();
  });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  await fs.writeFile(path.join(appDir,'test-context.json'),JSON.stringify({directory,feed:`http://127.0.0.1:${server.address().port}/`}));
  const engineVersion=JSON.parse(await fs.readFile(path.join(root,'node_modules/electron/package.json'),'utf8')).version;
  const updaterVersion=JSON.parse(await fs.readFile(path.join(root,'node_modules/electron-updater/package.json'),'utf8')).version;
  const outputs={};
  for(const version of ['0.3.21','0.3.22']){
    await fs.writeFile(path.join(appDir,'package.json'),JSON.stringify({name:'cloudreel-update-acceptance',productName,version,main:'main.mjs',type:'module',author:'CloudReel',description:'Isolated updater acceptance',dependencies:{'electron-updater':updaterVersion}}));
    if(version==='0.3.21')await run(process.execPath,[path.join(path.dirname(process.execPath),'node_modules/npm/bin/npm-cli.js'),'install','--prefix',appDir,'--omit=dev','--ignore-scripts','--no-audit','--no-fund']);
    const output=path.join(directory,'build-'+version);outputs[version]=output;
    await build({projectDir:appDir,targets:Platform.WINDOWS.createTarget('nsis',Arch.x64),publish:'never',config:{appId:'dev.cloudreel.updateacceptance.'+tag,productName,electronVersion:engineVersion,electronDist:path.join(root,'node_modules/electron/dist'),npmRebuild:false,compression:'store',directories:{app:appDir,output},files:['main.mjs','app-updater.mjs','app-shutdown.mjs','test-context.json','package.json'],win:{signExecutable:false},nsis:{oneClick:false,perMachine:false,allowElevation:false,createDesktopShortcut:false,createStartMenuShortcut:false,deleteAppDataOnUninstall:false,artifactName:'CloudReel-Setup-${version}-win-x64.exe'},publish:{provider:'generic',url:'http://127.0.0.1/isolated/'}}});
    progress('built '+version);
  }
  target=await fs.readFile(path.join(outputs['0.3.22'],'CloudReel-Setup-0.3.22-win-x64.exe'));sha512=createHash('sha512').update(target).digest('base64');
  const env={...process.env,CLOUDREEL_UPDATE_TEST_DIR:directory,CLOUDREEL_UPDATE_TEST_FEED:`http://127.0.0.1:${server.address().port}/`};
  installed=true;await run(path.join(outputs['0.3.21'],'CloudReel-Setup-0.3.21-win-x64.exe'),['/S','--force-run',`/D=${installDir}`],env);progress('installed baseline, checking download and restart');
  const deadline=Date.now()+180000;let result;
  while(Date.now()<deadline){try{result=JSON.parse(await fs.readFile(path.join(directory,'result.json'),'utf8'));break;}catch{}await new Promise(resolve=>setTimeout(resolve,500));}
  if(!result?.passed||!rejected)throw Error('installer round trip did not pass: '+JSON.stringify(result));
  console.log('APP_UPDATE_ACCEPTANCE '+JSON.stringify(result));
}finally{
  if(server)await new Promise(resolve=>server.close(resolve));
  if(installed){try{await run(path.join(installDir,'Uninstall '+productName+'.exe'),['/S']);}catch{console.log('APP_UPDATE_ACCEPTANCE '+JSON.stringify({cleanupPending:directory}));throw Error('isolated uninstaller cleanup failed');}}
  if(path.dirname(path.resolve(directory))!==path.resolve(os.tmpdir())||!path.basename(directory).startsWith('cloudreel-update-install-'))throw Error('unexpected acceptance path');
  await fs.rm(directory,{recursive:true,force:true,maxRetries:15,retryDelay:400});
}
