// Entry point ONLY for isolated installer acceptance packages. Never included
// in the production build, and never opens a visible window or a real session.
import {app,BrowserWindow,safeStorage} from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import updater from 'electron-updater';
import {AppUpdateService} from './app-updater.mjs';
const context=JSON.parse(fs.readFileSync(new URL('./test-context.json',import.meta.url),'utf8'));
const directory=context.directory;
if(!directory||!path.basename(directory).startsWith('cloudreel-update-install-'))process.exit(2);
app.setName('CloudReel-Update-Acceptance');app.setPath('userData',path.join(directory,'profile'));
let service;
app.whenReady().then(async()=>{
  const profile=app.getPath('userData'),stateFile=path.join(profile,'state.json');
  if(app.getVersion()==='0.3.21'){
    fs.mkdirSync(profile,{recursive:true});
    fs.writeFileSync(stateFile,JSON.stringify({items:[{id:'test',progress:{position:42},favorite:true}],settings:{rootDir:'/isolated'},encryptedSecret:safeStorage.encryptString('synthetic-login-sentinel').toString('base64')}));
    fs.mkdirSync(path.join(profile,'Partitions','isolated','Network'),{recursive:true});fs.writeFileSync(path.join(profile,'Partitions','isolated','Network','sentinel'),'synthetic-session');
    fs.copyFileSync(stateFile,path.join(directory,'before.json'));
    const engine=new updater.NsisUpdater({provider:'generic',url:context.feed});engine.disableDifferentialDownload=true;
    Object.defineProperty(engine.app,'baseCachePath',{value:path.join(directory,'cache')});
    service=new AppUpdateService({engine,currentVersion:app.getVersion(),notify:()=>fs.writeFileSync(path.join(directory,'progress.json'),JSON.stringify(service.status()))});
    await service.check();assert.equal(service.status().phase,'error');assert.match(service.status().error,/校验/);
    await fetch(context.feed+'verified-corruption');
    await service.check();assert.equal(service.status().phase,'downloaded');
    assert.equal(BrowserWindow.getAllWindows().some(window=>window.isVisible()),false);
    await service.install();
  }else{
    assert.equal(app.getVersion(),'0.3.22');assert.equal(fs.readFileSync(stateFile,'utf8'),fs.readFileSync(path.join(directory,'before.json'),'utf8'));
    const state=JSON.parse(fs.readFileSync(stateFile,'utf8'));assert.equal(safeStorage.decryptString(Buffer.from(state.encryptedSecret,'base64')),'synthetic-login-sentinel');
    assert.equal(fs.readFileSync(path.join(profile,'Partitions','isolated','Network','sentinel'),'utf8'),'synthetic-session');
    assert.equal(BrowserWindow.getAllWindows().some(window=>window.isVisible()),false);
    fs.writeFileSync(path.join(directory,'result.json'),JSON.stringify({passed:true,from:'0.3.21',to:'0.3.22',checksumRejection:true,downloadRetry:true,realNsisInstall:true,automaticRelaunch:true,profilePreserved:true,encryptedSecretPreserved:true,sessionPartitionPreserved:true,visibleWindows:0}));app.quit();
  }
}).catch(error=>{fs.writeFileSync(path.join(directory,'result.json'),JSON.stringify({passed:false,type:error.name,message:String(error.message).replace(/https?:\/\/\S+/g,'[URL]').slice(0,500)}));app.exit(1);});
