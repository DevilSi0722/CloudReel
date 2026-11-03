// Real Baidu media, production relay/player/controls, isolated application
// cookies, in-memory library and no Trakt writes. All input targets hidden
// test windows or mpv's private IPC; no system-wide keys/focus are sent.
import {app,BrowserWindow,ipcMain} from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
import {memoryStore} from '../helpers.mjs';
const root=process.env.CLOUDREEL_PACKAGE_ROOT||fileURLToPath(new URL('../../',import.meta.url));
const load=relative=>import(pathToFileURL(path.join(root,'electron',relative)).href);
const {createBaiduLogin}=await load('services/baidu-login.mjs');
const {PlayerService,discoverMpv}=await load('services/player.mjs');
const {NativeVideoHost}=await load('services/native-video.mjs');
const {PlayerOverlay}=await load('services/player-overlay.mjs');
const {bindPlayerKeyboard}=await load('services/player-keyboard.mjs');
const {AppShutdown}=await load('services/app-shutdown.mjs');
const {groupLibrary}=await load('core/identification.mjs');
const resources=process.env.CLOUDREEL_PACKAGE_ROOT?path.dirname(root):process.resourcesPath;
const playerDirectory=process.env.CLOUDREEL_PACKAGE_ROOT?path.join(resources,'player'):path.join(root,'electron');
app.setName('CloudReel-Shortcut-Acceptance');app.setPath('userData',process.env.CLOUDREEL_TEST_DIRECTORY);
let window,controls,host,player,login,stage='startup',pressed=false;
const keyEvents=[];
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const until=async(check,timeout=15000)=>{const end=Date.now()+timeout;while(Date.now()<end){if(await check())return;await wait(40);}throw Error('timeout');};
app.whenReady().then(async()=>{
  const original=JSON.parse(fs.readFileSync(path.join(process.env.CLOUDREEL_SOURCE_PROFILE,'state.json'),'utf8'));
  const candidates=original.items.filter(item=>item.source==='baidu'&&!item.unavailable&&item.size>50*1024*1024&&item.size<8*1024**3);
  const first=candidates.find(item=>item.kind==='episode'&&item.technical?.dynamicRange==='SDR')||candidates.find(item=>item.kind==='episode');
  const second=candidates.find(item=>item.kind==='movie')||candidates.find(item=>item.id!==first?.id);
  assert.ok(first&&second);
  const store=memoryStore();Object.assign(store.data.settings,{autoSync:false,autoNext:false,autoScrape:false,autoRefresh:false});store.data.playbackDefaults={speed:1.25};
  store.data.items=[first,second].map((item,index)=>Object.fromEntries(Object.entries({...item,title:`真实快捷键验证 ${index+1}`}).filter(([key])=>['id','source','fsId','filename','path','size','title','kind','season','episode','addedAt'].includes(key))));
  window=new BrowserWindow({show:false,width:1280,height:800,webPreferences:{preload:path.join(root,'electron/preload.cjs'),contextIsolation:true,nodeIntegration:false,backgroundThrottling:false,offscreen:true}});
  host=new NativeVideoHost(()=>window,()=>1);host.layout({x:0,y:0,width:1280,height:800});
  controls=new PlayerOverlay({parent:()=>window,videoHost:host,root,offscreen:true});await controls.create();
  for(const view of [window,controls.window])for(const method of ['show','showInactive','focus'])view[method]=()=>{throw Error('visibility prohibited');};
  const snapshot=()=>({settings:store.data.settings,items:store.data.items,collections:groupLibrary(store.data.items),accounts:{baidu:{connected:true},trakt:{connected:false}},scan:{running:false},scrape:{running:false},logs:[],pendingCount:0,runtime:{desktop:true,playerOverlay:true,version:'0.3.23'},player:player?.status()??null});
  const notify=()=>{if(controls?.ready)controls.update(snapshot());};
  login=createBaiduLogin(store,notify,()=>window);stage='session restore';await login.restore();assert.equal(login.service.connected,true);
  // Sync has no network implementation or account in this isolated store.
  player=new PlayerService(store,login.service,{}, {eligible:()=>false,start:async()=>{},checkpoint:async()=>{}},{resolveMpv:()=>discoverMpv('',resources,root),notify,videoHost:host,rightPressed:()=>pressed,inputConfig:path.join(playerDirectory,'player-keys.conf'),spawnPlayer:(binary,args,options)=>{const quiet=[...args];quiet.splice(quiet.indexOf('--'),0,'--mute=yes');return spawn(binary,quiet,options);}});
  bindPlayerKeyboard(window,player);
  window.webContents.on('before-input-event',(_event,input)=>{keyEvents.push({type:input.type,key:input.key,repeat:input.isAutoRepeat,control:input.control});if(keyEvents.length>16)keyEvents.shift();});
  ipcMain.handle('cloudreel:invoke',async(_event,method,payload)=>{
    if(method==='player:shortcut'){await player.shortcut(payload);return {ok:true};}
    if(method==='player:overlayRegions')controls.setRegions(payload);
    return {ok:true,value:snapshot()};
  });
  await new Promise(resolve=>{controls.window.webContents.once('did-finish-load',resolve);controls.window.webContents.reload();});
  await window.loadURL('data:text/html,isolated%20keyboard%20owner');
  window.webContents.debugger.attach('1.3');await window.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true});
  const js=code=>controls.window.webContents.executeJavaScript(code);
  const owner=async(type,modifiers=[])=>{window.webContents.sendInputEvent({type:type==='keydown'?'keyDown':'keyUp',keyCode:'Right',modifiers});await wait(20);};
  const renderer=type=>js(`window.dispatchEvent(new KeyboardEvent('${type}',{key:'ArrowRight',code:'ArrowRight',bubbles:true}))`);
  const native=type=>player.request(player.session,[type==='keydown'?'keydown':'keyup','RIGHT']);
  const seek=player.seek.bind(player),seeks=[];player.seek=input=>{const result=seek(input);seeks.push(result.target);return result;};
  const results=[];
  for(const item of store.data.items){
    stage='decode '+item.kind;await player.play(item.id,true);await until(()=>player.session?.position>1&&player.session.videoParams&&player.session.videoTarget,60000);
    player.seek({itemId:item.id,seconds:30});await until(()=>!player.status().seek?.pending&&!player.session.buffering,45000);
    for(const [name,key] of [['owner',owner],['renderer',renderer],['native',native]]){
      stage=item.kind+' '+name+' tap';const before=player.session.position;seeks.length=0;
      pressed=true;await key('keydown');await wait(60);pressed=false;await key('keyup');
      await until(()=>seeks.length===1&&!player.status().seek?.pending,30000);await wait(450);
      assert.ok(Math.abs(seeks[0]-before-5)<1.5);assert.equal(seeks.length,1);assert.equal(player.status().boosting,false);assert.equal(player.status().speed,1.25);
      if(name==='owner')assert.ok(keyEvents.some(event=>event.type==='keyUp'),'owner receives the matching key release');
      stage=item.kind+' '+name+' hold';seeks.length=0;pressed=true;await key('keydown');await until(()=>player.status().boosting&&player.status().speed===3);await wait(100);pressed=false;await key('keyup');await until(()=>!player.status().boosting&&player.status().speed===1.25);
      assert.equal(seeks.length,0);
    }
    stage=item.kind+' lost keyup';seeks.length=0;pressed=true;await owner('keydown');await until(()=>player.status().boosting&&player.status().speed===3);pressed=false;await until(()=>!player.status().boosting&&player.status().speed===1.25);assert.equal(seeks.length,0);await owner('keyup');
    stage=item.kind+' released before hold threshold';seeks.length=0;pressed=false;await native('keydown');await until(()=>seeks.length===1&&!player.status().seek?.pending,30000);await wait(450);assert.equal(player.status().speed,1.25);assert.equal(player.status().boosting,false);assert.equal(seeks.length,1);await native('keyup');
    stage=item.kind+' modifier hold';pressed=true;await owner('keydown');await until(()=>player.status().boosting);stage=item.kind+' modifier release';pressed=false;await owner('keyup',['control']);await until(()=>!player.status().boosting&&player.status().speed===1.25);
    stage=item.kind+' focus loss';seeks.length=0;pressed=true;await renderer('keydown');await until(()=>player.status().boosting);await js("window.dispatchEvent(new Event('blur'))");pressed=false;await until(()=>!player.status().boosting&&player.status().speed===1.25);assert.equal(seeks.length,0);
    assert.equal(player.preferencesFor(item).speed,1.25);await until(()=>player.status().buffered.length>0);
    results.push({source:item.kind,decoded:true,ownerRendererNativeTapAndHold:true,lostReleaseRestoresSpeed:true,shortTapNeverBoosts:true,modifierRelease:true,focusLoss:true,preferencesPreserved:true});
  }
  stage='close while playing';const child=player.session.child;
  const shutdown=new AppShutdown({app,prepare:[()=>login.close()],cleanup:[()=>player.shutdown(),()=>login.browserSession.cookies.flushStore()],persist:()=>store.persist(),dispose:()=>{
    const passed=(child.exitCode!==null||child.signalCode!=null)&&!player.session&&!BrowserWindow.getAllWindows().some(view=>view.isVisible());
    controls.destroy();host.destroy();
    console.log('REAL_PLAYBACK_RESULT '+JSON.stringify({passed,packagedResources:Boolean(process.env.CLOUDREEL_PACKAGE_ROOT),productionSessionRelayPlayer:true,sources:results,quitWhilePlaying:passed,traktWrites:0,visibleWindowsOpened:0}));
    if(!passed)app.exit(1);
  }});shutdown.bind(window);window.close();
}).catch(async()=>{
  console.log('REAL_PLAYBACK_RESULT '+JSON.stringify({passed:false,stage,keyEvents,playback:player?.session?{position:player.session.position,speed:player.session.speed,boosting:!!player.session.boosting,held:!!player.gestures.right,seekPending:!!player.session.seek?.pending}:null}));
  pressed=false;try{await player?.stop();}catch{}login?.close();controls?.destroy();host?.destroy();window?.destroy();app.exit(1);
});
