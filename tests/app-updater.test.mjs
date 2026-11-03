import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {AppUpdateService} from '../electron/services/app-updater.mjs';

const info=(version='0.3.23')=>({version,files:[{url:`CloudReel-Setup-${version}-win-x64.exe`,sha512:Buffer.alloc(64,7).toString('base64')}],releaseNotes:'<b>更新</b>\n- 改进体验'});
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
function setup(options={}){const engine=new EventEmitter();let checks=0,downloads=0,installs=0;engine.checkForUpdates=async()=>{checks++;return {updateInfo:info()};};engine.downloadUpdate=async()=>{downloads++;return ['cache/update.exe'];};engine.quitAndInstall=(silent,restart)=>{assert.equal(silent,true);assert.equal(restart,true);installs++;};const service=new AppUpdateService({engine,currentVersion:'0.3.22',...options});return {service,engine,counts:()=>({checks,downloads,installs})};}

test('stable installed update is downloaded once, notes remain plain text and restart always requires an explicit action',async()=>{
  const {service,engine,counts}=setup();assert.equal(engine.autoInstallOnAppQuit,false);assert.equal(engine.autoDownload,false);assert.equal(engine.allowDowngrade,false);
  await Promise.all([service.check(),service.check()]);assert.deepEqual(counts(),{checks:1,downloads:1,installs:0});
  assert.equal(service.status().phase,'downloaded');assert.equal(service.status().notes,'更新\n- 改进体验');
  await service.check();assert.equal(counts().downloads,1);await service.install();assert.equal(counts().installs,1);await service.install();assert.equal(counts().installs,1);
});
test('blocked playback, cloud operations and sync never invoke preparation or the installer',async()=>{
  let busy=true,prepared=0;const {service,counts}=setup({blocked:()=>busy,prepare:async()=>{prepared++;}});await service.check();
  await assert.rejects(service.install(),/结束播放/);assert.equal(prepared,0);assert.equal(counts().installs,0);assert.equal(service.status().phase,'downloaded');
  busy=false;await service.install();assert.equal(prepared,1);assert.equal(counts().installs,1);
});
test('downgrades and same-version releases are current, while prereleases, portable assets and missing hashes cannot download',async()=>{
  for(const version of ['0.3.22','0.3.21']){const {service,engine,counts}=setup();engine.checkForUpdates=async()=>({updateInfo:info(version)});await service.check();assert.equal(service.status().phase,'current');assert.equal(counts().downloads,0);}
  for(const manifest of [info('0.3.23-beta.1'),{...info(),files:[{url:'CloudReel-0.3.23-win-x64.exe',sha512:info().files[0].sha512}]},{...info(),files:[{url:info().files[0].url}]},{...info(),packages:{x64:{}}},{...info(),files:[...info().files,{url:'unknown.exe'}]}]){const {service,engine,counts}=setup();engine.checkForUpdates=async()=>({updateInfo:manifest});await service.check();assert.equal(service.status().phase,'error');assert.equal(counts().downloads,0);await assert.rejects(service.install(),/完成更新下载/);}
});
test('download errors expose a safe message, keep the app running and recheck before retry',async()=>{
  const {service,engine,counts}=setup();engine.downloadUpdate=async()=>{const error=Object.assign(Error('private signed URL token=SECRET'),{code:'ERR_CHECKSUM_MISMATCH'});engine.emit('error',error);throw error;};
  await service.check();assert.equal(service.status().phase,'error');assert.match(service.status().error,/校验/);assert.ok(!JSON.stringify(service.status()).includes('SECRET'));assert.equal(counts().installs,0);
  engine.downloadUpdate=async()=>['cache/valid.exe'];await service.check();assert.equal(counts().checks,2);assert.equal(service.status().phase,'downloaded');
});
test('progress is bounded and an install preparation or launch error releases the operation lock for retry',async()=>{
  const pending=deferred();let resumed=0,fail=true;const {service,engine,counts}=setup({prepare:async()=>{if(fail)throw Error('private path');},resume:()=>{resumed++;}});engine.downloadUpdate=()=>pending.promise;
  const check=service.check();await new Promise(resolve=>setImmediate(resolve));engine.emit('download-progress',{percent:150,transferred:5,total:10});assert.equal(service.status().percent,100);assert.equal(service.status().phase,'downloading');pending.resolve(['cached.exe']);await check;
  await service.install();assert.equal(resumed,1);assert.equal(service.installing,false);assert.equal(counts().installs,0);assert.equal(service.status().phase,'downloaded');
  fail=false;await service.install();engine.emit('error',Error('launch failed'));assert.equal(service.installing,false);assert.equal(resumed,2);assert.equal(service.status().phase,'downloaded');
});
test('portable and development runs have no network/update engine, and stopping ignores late network replies',async()=>{
  const unsupported=new AppUpdateService({engine:null,currentVersion:'0.3.22',supported:false});unsupported.start();await unsupported.check();await assert.rejects(unsupported.install());assert.equal(unsupported.status().phase,'unsupported');
  const {service,engine,counts}=setup(),wait=deferred();engine.checkForUpdates=()=>wait.promise;const check=service.check();service.stop();wait.resolve({updateInfo:info()});await check;assert.equal(counts().downloads,0);assert.equal(counts().installs,0);
});
