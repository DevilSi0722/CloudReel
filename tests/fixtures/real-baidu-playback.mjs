import {app, BrowserWindow, ipcMain} from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {memoryStore} from '../helpers.mjs';

const root=process.env.CLOUDREEL_PACKAGE_ROOT || fileURLToPath(new URL('../../',import.meta.url));
const load=relative=>import(pathToFileURL(path.join(root,'electron',relative)).href);
const {createBaiduLogin}=await load('services/baidu-login.mjs');
const {PlayerService,discoverMpv}=await load('services/player.mjs');
const {NativeVideoHost}=await load('services/native-video.mjs');
const {PlayerOverlay}=await load('services/player-overlay.mjs');
const {groupLibrary}=await load('core/identification.mjs');
const resources=process.env.CLOUDREEL_PACKAGE_ROOT ? path.dirname(root) : process.resourcesPath;
const playerDirectory=process.env.CLOUDREEL_PACKAGE_ROOT ? path.join(resources,'player') : path.join(root,'electron');
app.setName('CloudReel-Real-Playback-Acceptance');app.setPath('userData',process.env.CLOUDREEL_TEST_DIRECTORY);
let window,controls,host,player,login,stage='startup';
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check,timeout=45000) {const end=Date.now()+timeout;while(Date.now()<end){if(await check())return;await wait(150);}throw new Error('timeout');}
app.whenReady().then(async()=>{
  const original=JSON.parse(fs.readFileSync(path.join(process.env.CLOUDREEL_SOURCE_PROFILE,'state.json'),'utf8'));
  const sourceItems=original.items.filter(item=>item.source==='baidu' && !item.unavailable && item.size>50*1024*1024 && item.size<8*1024**3);
  const first=sourceItems.find(item=>item.kind==='episode') || sourceItems[0];
  const second=sourceItems.find(item=>item.kind==='movie' && item.id!==first?.id) || sourceItems.find(item=>item.id!==first?.id);
  if(!first || !second) throw new Error('sources unavailable');
  const store=memoryStore();Object.assign(store.data.settings,{autoSync:false,autoNext:false,autoScrape:false,autoRefresh:false});
  // Only media identities enter this in-memory store; Trakt tokens and the
  // source library/progress are never copied into a writable application state.
  store.data.items=[first,second].map((item,index)=>Object.fromEntries(Object.entries({...item,title:`真实片源验证 ${index+1}`}).filter(([key])=>['id','source','fsId','filename','path','size','title','kind','season','episode','addedAt'].includes(key))));
  window=new BrowserWindow({show:false,width:1280,height:800,webPreferences:{preload:path.join(root,'electron/preload.cjs'),contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
  host=new NativeVideoHost(()=>window,()=>1);host.layout({x:0,y:0,width:1280,height:800});
  controls=new PlayerOverlay({parent:()=>window,videoHost:host,root});
  await controls.create();
  // Defense in depth: acceptance windows remain hidden for their entire life.
  for(const view of [window,controls.window]) for(const method of ['show','showInactive','focus']) view[method]=()=>{throw new Error('visibility prohibited');};
  const snapshot=()=>({settings:store.data.settings,items:store.data.items,collections:groupLibrary(store.data.items),accounts:{baidu:{connected:true},trakt:{connected:false}},scan:{running:false},scrape:{running:false},logs:[],pendingCount:0,runtime:{desktop:true,playerOverlay:true,version:'0.3.17'},player:player?.status() ?? null});
  const notify=()=>{if(controls?.ready) controls.update(snapshot());};
  login=createBaiduLogin(store,notify,()=>window);stage='session restore';await login.restore();if(!login.service.connected)throw new Error('session unavailable');
  player=new PlayerService(store,login.service,{}, {eligible:()=>false,start:async()=>{},checkpoint:async()=>{}},{resolveMpv:()=>discoverMpv('',resources,root),notify,videoHost:host,inputConfig:path.join(playerDirectory,'player-keys.conf'),spawnPlayer:(binary,args,options)=>{const quiet=[...args];quiet.splice(quiet.indexOf('--'),0,'--mute=yes');return spawn(binary,quiet,options);}});
  ipcMain.handle('cloudreel:invoke',async(_event,method,payload)=>{
    if(method==='player:overlayRegions') {controls.setRegions(payload);if(payload.subtitleLayout)player.subtitleLayout(payload.subtitleLayout);}
    if(method==='player:seek') return {ok:true,value:player.seek(payload)};
    return {ok:true,value:snapshot()};
  });
  // Overlay requested its initial state before the handler existed; reload once
  // the production services are ready, still without making any window visible.
  await new Promise(resolve=>{controls.window.webContents.once('did-finish-load',resolve);controls.window.webContents.reload();});
  const results=[];
  for(const item of store.data.items) {
    stage='source '+(results.length+1)+' playback';
    await player.play(item.id,true);
    await until(()=>player.session?.position>1 && player.session?.videoParams && player.session?.videoTarget,60000);
    await until(()=>player.status().buffered.some(range=>range.end>player.status().position+1),30000);
    const s=player.status();
    await until(()=>controls.window.webContents.executeJavaScript("document.querySelectorAll('.timeline-buffered').length>0"));
    await controls.window.webContents.executeJavaScript("document.querySelector('[aria-label=\"字幕\"]').click()");
    await until(()=>controls.window.webContents.executeJavaScript("Boolean(document.querySelector('[aria-label=\"字幕字体\"]'))"));
    const picker=await controls.window.webContents.executeJavaScript("(()=>{const select=document.querySelector('[aria-label=\"字幕字体\"]');select.showPicker();return getComputedStyle(select).appearance==='base-select' && select.matches(':open');})()",true);
    if(!picker) throw new Error('player picker');
    await controls.window.webContents.executeJavaScript("document.querySelector('[aria-label=\"关闭菜单\"]').click()");
    const before=player.session.position;
    await until(()=>player.session.position>before+.4,10000);
    stage='source '+(results.length+1)+' forward seek';
    const target=Math.min(s.duration*.3,180);
    player.seek({seconds:target,itemId:item.id,requestId:'real-cache-seek'});
    await until(()=>!player.status().seek?.pending && Math.abs(player.status().position-target)<8,30000);
    stage='source '+(results.length+1)+' cache after seek';
    await until(()=>player.status().buffered.some(range=>range.start<=player.status().position && range.end>player.status().position+1),60000);
    stage='source '+(results.length+1)+' backward seek';
    player.seek({seconds:30,itemId:item.id,requestId:'real-cache-back'});
    await until(()=>!player.status().seek?.pending && Math.abs(player.status().position-30)<8,30000);
    results.push({source:item.kind,decoded:true,cacheRanges:player.status().buffered.length,forwardAndBackwardSeek:true,bufferVisible:true,styledPlayerPicker:true});
  }
  await player.stop();await until(()=>controls.window.webContents.executeJavaScript("document.querySelectorAll('.timeline-buffered').length===0"));
  if(BrowserWindow.getAllWindows().some(view=>view.isVisible()))throw new Error('visible window');
  console.log('REAL_PLAYBACK_RESULT '+JSON.stringify({passed:true,packagedResources:Boolean(process.env.CLOUDREEL_PACKAGE_ROOT),productionSessionRelayPlayer:true,sources:results,traktWrites:0,visibleWindowsOpened:0}));
  login.close();controls.destroy();host.destroy();window.destroy();app.quit();
}).catch(async()=>{
  const status=player?.status();
  console.log('REAL_PLAYBACK_RESULT '+JSON.stringify({passed:false,stage,playback:status ? {position:status.position,duration:status.duration,buffering:status.buffering,seekPending:status.seek?.pending,seekError:Boolean(status.seek?.error),buffered:status.buffered} : null}));
  try{await player?.stop();}catch{}login?.close();controls?.destroy();host?.destroy();window?.destroy();app.exit(1);
});
