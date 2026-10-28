// Manual real-source acceptance for the details -> selected episode -> play flow.
// Only this app's copied Baidu partition is opened; all library writes are in memory.
import {app, BrowserWindow, ipcMain} from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {memoryStore} from '../helpers.mjs';

const root=process.env.CLOUDREEL_PACKAGE_ROOT || fileURLToPath(new URL('../../',import.meta.url));
const load=relative=>import(pathToFileURL(path.join(root,'electron',relative)).href);
const {createBaiduLogin}=await load('services/baidu-login.mjs');
const {PlayerService,discoverMpv}=await load('services/player.mjs');
const {MediaProbeService}=await load('services/media-probe.mjs');
const {NativeVideoHost}=await load('services/native-video.mjs');
const {groupLibrary}=await load('core/identification.mjs');
const {episodeChoices}=await load('core/versions.mjs');
const resources=process.env.CLOUDREEL_PACKAGE_ROOT ? path.dirname(root) : process.resourcesPath;
const playerDirectory=process.env.CLOUDREEL_PACKAGE_ROOT ? path.join(resources,'player') : path.join(root,'electron');
app.setName('CloudReel-Real-Details-Acceptance');app.setPath('userData',process.env.CLOUDREEL_TEST_DIRECTORY);
let window,host,login,player,probe,stage='startup',playRequests=[];
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check,timeout=45000) {const end=Date.now()+timeout;while(Date.now()<end){if(await check())return;await wait(120);}throw new Error('timeout');}
app.whenReady().then(async()=>{
  const original=JSON.parse(fs.readFileSync(path.join(process.env.CLOUDREEL_SOURCE_PROFILE,'state.json'),'utf8'));
  const available=original.items.filter(item=>item.source==='baidu' && item.kind==='episode' && !item.unavailable && item.size>50*1024**2 && item.size<8*1024**3);
  const groups=groupLibrary(available);
  let sources;
  for(const group of groups) {
    const choices=episodeChoices(available.filter(item=>group.itemIds.includes(item.id))).sort((a,b)=>(a.season??1)-(b.season??1) || (a.episode??0)-(b.episode??0));
    const pair=choices.filter(item=>(item.season??1)===(choices[0]?.season??1)).slice(0,2);
    if(pair.length===2){sources=pair;break;}
  }
  if(!sources)throw new Error('two real episodes unavailable');
  const store=memoryStore();Object.assign(store.data.settings,{autoSync:false,autoNext:false,autoScrape:false,autoRefresh:false});
  const catalog={source:'tmdb',id:'real-details-acceptance',kind:'episode',title:'真实片源验收',overview:'仅用于隐藏窗口验收的内存片库。'};
  store.data.items=sources.map(item=>({...Object.fromEntries(Object.entries(item).filter(([key])=>['id','source','fsId','filename','path','size','fileModifiedAt','kind','season','episode','addedAt'].includes(key))),title:catalog.title,seriesTitle:catalog.title,catalog}));
  const [first,second]=store.data.items;
  // A newer resume on another episode must not override the initial selection.
  second.progress={position:500,duration:3000,percent:16.7,updatedAt:new Date().toISOString()};
  window=new BrowserWindow({show:false,width:1440,height:1000,webPreferences:{preload:path.join(root,'electron/preload.cjs'),contextIsolation:true,nodeIntegration:false,backgroundThrottling:false,offscreen:true}});
  for(const method of ['show','showInactive','focus'])window[method]=()=>{throw new Error('visibility prohibited');};
  host=new NativeVideoHost(()=>window,()=>1);host.layout({x:0,y:0,width:1440,height:1000});
  const snapshot=()=>({settings:store.data.settings,items:store.data.items,collections:groupLibrary(store.data.items),accounts:{baidu:{connected:true},trakt:{connected:false}},mediaProbes:probe?.states??{},scan:{running:false},scrape:{running:false},logs:[],pendingCount:0,runtime:{desktop:true,playerOverlay:true,version:'0.3.18'},player:player?.status()??null});
  const notify=()=>{if(window && !window.isDestroyed())window.webContents.send('cloudreel:state',snapshot());};
  login=createBaiduLogin(store,notify,()=>window);stage='session restore';await login.restore();if(!login.service.connected)throw new Error('session unavailable');
  const resolveMpv=()=>discoverMpv('',resources,root);
  player=new PlayerService(store,login.service,{}, {eligible:()=>false,start:async()=>{},checkpoint:async()=>{}},{resolveMpv,notify,videoHost:host,inputConfig:path.join(playerDirectory,'player-keys.conf'),spawnPlayer:(binary,args,options)=>{const quiet=[...args];quiet.splice(quiet.indexOf('--'),0,'--mute=yes');return spawn(binary,quiet,options);}});
  probe=new MediaProbeService(store,login.service,resolveMpv,notify);
  ipcMain.handle('cloudreel:invoke',async(_event,method,payload)=>{
    if(method==='media:probe')probe.request(payload.id,Boolean(payload.force));
    if(method==='player:play'){playRequests.push(payload.id);probe.cancel();await player.play(payload.id,true);}
    return {ok:true,value:snapshot()};
  });
  await window.loadFile(path.join(root,'dist/index.html'));
  const web=window.webContents,js=code=>web.executeJavaScript(code);
  stage='open details';await until(()=>js("Boolean(document.querySelector('.collection-poster'))"));
  await js("document.querySelector('.collection-poster').click()");
  stage='first selected probe';await until(()=>first.technical?.verified,45000);
  if(playRequests.length || player.session)throw new Error('opening details started playback');
  const label=await js("document.querySelector('[aria-label=\"当前选集\"]').textContent");
  if(!label.includes(`第 ${first.episode} 集`))throw new Error('wrong default episode');
  const results=[];
  for(const [index,item] of store.data.items.entries()) {
    if(index) {
      const before=playRequests.length;
      stage='select second episode';await js("document.querySelectorAll('.episode-still')[1].click()");await wait(200);
      if(playRequests.length!==before || player.session)throw new Error('selecting episode started playback');
    }
    stage='selected media probe '+index;await until(()=>item.technical?.verified,45000);
    await until(()=>js("!Array.from(document.querySelectorAll('.title-media-facts dd')).some(e=>e.textContent==='—')"));
    const displayedSize=await js("document.querySelector('.title-media-facts>div:last-child dd').textContent");
    const expectedSize=item.size>=1073741824 ? `${(item.size/1073741824).toFixed(1)} GB` : `${(item.size/1048576).toFixed(1)} MB`;
    if(displayedSize!==expectedSize)throw new Error('selected media does not match file');
    stage='play selected episode '+index;await js("document.querySelector('.detail-buttons .primary').click()");
    await until(()=>player.session?.item.id===item.id && player.session?.position>1 && player.session?.videoParams && player.session?.videoTarget,60000);
    if(playRequests.at(-1)!==item.id)throw new Error('wrong playback file');
    results.push({selectedFileMatches:true,realProbeVerified:true,decoded:true,dynamicRange:player.status().video?.source});
    await player.stop();await wait(150);
  }
  stage='continue-watching entry';
  // Production playback has changed only the memory store. Set a known resume
  // there to verify that the Continue card opens and plays the same real file.
  second.progress={position:500,duration:3000,percent:16.7,updatedAt:new Date().toISOString()};notify();
  await js("document.querySelector('.back-link').click()");
  await until(()=>js("Boolean(document.querySelector('.continue-details'))"));
  const before=playRequests.length;
  await js("document.querySelector('.continue-details').click()");
  await until(()=>js(`document.querySelector('[aria-label="当前选集"]')?.textContent.includes('第 ${second.episode} 集')`));
  if(playRequests.length!==before)throw new Error('resume entry started playback');
  stage='play continued detail episode';await js("document.querySelector('.detail-buttons .primary').click()");
  await until(()=>player.session?.item.id===second.id && player.session?.position>1 && player.session?.videoParams && player.session?.videoTarget,60000);
  if(playRequests.at(-1)!==second.id)throw new Error('wrong continued playback file');
  await player.stop();
  if(BrowserWindow.getAllWindows().some(view=>view.isVisible()))throw new Error('visible window');
  console.log('REAL_PLAYBACK_RESULT '+JSON.stringify({passed:true,detailsSelection:true,resumeEntryAndPlayback:true,productionSessionRelayPlayer:true,selectionDoesNotPlay:true,selectedMediaAndPlayback:true,sources:results,traktWrites:0,visibleWindowsOpened:0}));
  probe.cancel();login.close();host.destroy();window.destroy();app.quit();
}).catch(async()=>{
  console.log('REAL_PLAYBACK_RESULT '+JSON.stringify({passed:false,stage,detailsSelection:true,playbackRequests:playRequests.length,probeErrors:probe?Object.values(probe.states).filter(status=>status.error).length:0}));
  probe?.cancel();try{await player?.stop();}catch{}login?.close();host?.destroy();window?.destroy();app.exit(1);
});
