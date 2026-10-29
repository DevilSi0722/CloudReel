import {app,BrowserWindow} from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {memoryStore} from '../helpers.mjs';
const root=process.env.CLOUDREEL_PACKAGE_ROOT||fileURLToPath(new URL('../../',import.meta.url));
const load=relative=>import(pathToFileURL(path.join(root,'electron',relative)).href);
const {createBaiduLogin}=await load('services/baidu-login.mjs');
const {PlayerService,discoverMpv}=await load('services/player.mjs');
const {NativeVideoHost}=await load('services/native-video.mjs');
const {LibraryScanner}=await load('services/scanner.mjs');
const resources=process.env.CLOUDREEL_PACKAGE_ROOT?path.dirname(root):process.resourcesPath;
app.setName('CloudReel-Mount-Rename-Acceptance');app.setPath('userData',process.env.CLOUDREEL_TEST_DIRECTORY);
let window,host,player,stage='startup';
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check,timeout=60000){const end=Date.now()+timeout;while(Date.now()<end){if(await check())return;await wait(150);}throw new Error('timeout');}
app.whenReady().then(async()=>{
  const original=JSON.parse(fs.readFileSync(path.join(process.env.CLOUDREEL_SOURCE_PROFILE,'state.json'),'utf8'));
  const first=original.items.find(item=>String(item.fsId)==='1177721402590')||original.items.find(item=>item.source==='baidu'&&!item.unavailable);
  assert.ok(first);
  const store=memoryStore();Object.assign(store.data.settings,{autoSync:false,autoNext:false,autoRefresh:false,autoScrape:false});
  const selections=[first,...['HDR10','Dolby Vision'].map(format=>original.items.find(item=>item.source==='baidu'&&!item.unavailable&&item.technical?.dynamicRange===format))].filter((item,index,items)=>item&&items.findIndex(other=>other?.id===item.id)===index);
  store.data.items=selections.map(item=>({...Object.fromEntries(Object.entries(item).filter(([key])=>['id','source','fsId','path','filename','size','title','kind','season','episode'].includes(key))),identificationLocked:true,progress:{position:73,percent:10},metadata:{ids:{trakt:999999}}}));
  window=new BrowserWindow({show:false,width:1280,height:800,webPreferences:{backgroundThrottling:false}});
  for(const method of ['show','showInactive','focus'])window[method]=()=>{throw new Error('visibility prohibited');};
  host=new NativeVideoHost(()=>window,()=>1);host.layout({x:0,y:0,width:1280,height:800});
  const login=createBaiduLogin(store,()=>{},()=>window);stage='restore';await login.restore();assert.equal(login.service.connected,true);
  stage='mount identity';
  const parent=path.posix.dirname(first.path),grandparent=path.posix.dirname(parent);let directory;
  for(let start=0;start<20000;){const page=await login.service.list(grandparent,start);directory=page.files.find(file=>file.path===parent&&Number(file.isdir)===1);if(directory||!page.hasMore)break;start=page.nextStart;}
  assert.ok(directory);
  let listings=0;
  const scanner=new LibraryScanner(store,{fileInfo:(...args)=>login.service.fileInfo(...args),list:(directory,start)=>{assert.ok(directory===parent||directory.startsWith(parent+'/'));listings++;return login.service.list(directory,start);}});
  const mounted=await scanner.mountBaidu({fsId:String(directory.fs_id),path:'/intentionally-stale-folder'});await scanner.active;
  assert.equal(mounted.path,parent);assert.equal(mounted.error,null);assert.ok(mounted.count>0);
  mounted.path='/intentionally-stale-folder';scanner.refresh([mounted.id]);await scanner.active;assert.equal(mounted.path,parent);assert.equal(mounted.error,null);
  const countBeforePlayback=listings,results=[];
  player=new PlayerService(store,login.service,{}, {eligible:()=>false,start:async()=>{},checkpoint:async()=>{}},{resolveMpv:()=>discoverMpv('',resources,root),videoHost:host,inputConfig:path.join(process.env.CLOUDREEL_PACKAGE_ROOT?path.join(resources,'player'):path.join(root,'electron'),'player-keys.conf'),spawnPlayer:(binary,args,options)=>{const quiet=[...args];quiet.splice(quiet.indexOf('--'),0,'--mute=yes');return spawn(binary,quiet,options);}});
  for(const selection of selections){
    const item=store.item(selection.id),actual=await login.service.fileInfo(item.fsId),progress=item.progress,metadata=item.metadata;
    item.path='/intentionally-stale-folder/old-name.mkv';item.filename='old-name.mkv';
    stage='stale path preparation '+(results.length+1);const prepared=await player.prepareMedia(item,{quiet:true});prepared.relay.close();
    stage='recovered path '+(results.length+1);assert.equal(item.path,actual.path);
    stage='watch identity '+(results.length+1);assert.equal(item.progress,progress);assert.equal(item.metadata,metadata);
    item.path='/intentionally-stale-folder/old-name.mkv';item.filename='old-name.mkv';
    stage='stale path playback '+(results.length+1);await player.play(item.id,true);
    await until(()=>player.session?.position>1&&player.session?.videoParams&&player.session?.videoTarget);
    assert.equal(item.path,actual.path);assert.equal(item.metadata,metadata);
    player.seek({itemId:item.id,seconds:45});await until(()=>!player.status().seek?.pending&&Math.abs(player.session.position-45)<8);
    stage='cache after seek '+(results.length+1);await until(()=>player.status().buffered.length>0);results.push({stableIdResolved:true,decoded:true,seek:true,dynamicRange:player.status().video?.source});
    await player.stop();
  }
  assert.equal(listings,countBeforePlayback);assert.equal(BrowserWindow.getAllWindows().some(view=>view.isVisible()),false);
  console.log('REAL_PLAYBACK_RESULT '+JSON.stringify({mountScope:true,folderRename:true,playbackWithoutRescan:true,originalProfileWrites:0,visibleWindowsOpened:0,sources:results}));
  host.destroy();window.destroy();app.quit();
}).catch(async error=>{
  const message=String(error.message),rejection=/媒体服务器拒绝/.test(message)?{http:Number(message.match(/HTTP (\d+)/)?.[1]),code:Number(message.match(/百度错误 (\d+)/)?.[1])||undefined}:undefined;
  console.log('REAL_PLAYBACK_RESULT '+JSON.stringify({passed:false,stage,errorType:error.name,mediaRejection:rejection,identityMismatch:/信息与所选文件 ID 不一致/.test(message)}));
  await player?.stop().catch(()=>{});host?.destroy();window?.destroy();app.exit(1);
});
