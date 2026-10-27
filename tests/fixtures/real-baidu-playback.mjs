import {app, BrowserWindow, ipcMain, nativeImage} from 'electron';
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
const {ThumbnailService,thumbnailKey}=await load('services/thumbnails.mjs');
const {groupLibrary}=await load('core/identification.mjs');
const resources=process.env.CLOUDREEL_PACKAGE_ROOT ? path.dirname(root) : process.resourcesPath;
const playerDirectory=process.env.CLOUDREEL_PACKAGE_ROOT ? path.join(resources,'player') : path.join(root,'electron');
app.setName('CloudReel-Real-Playback-Acceptance');app.setPath('userData',process.env.CLOUDREEL_TEST_DIRECTORY);
let window,controls,host,player,login,thumbnails,stage='startup',previewCalls=[],seekCalls=[];
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let syncWrites=0;
async function until(check,timeout=45000) {const end=Date.now()+timeout;while(Date.now()<end){if(await check())return;await wait(150);}throw new Error('timeout');}
app.whenReady().then(async()=>{
  const original=JSON.parse(fs.readFileSync(path.join(process.env.CLOUDREEL_SOURCE_PROFILE,'state.json'),'utf8'));
  const sourceItems=original.items.filter(item=>item.source==='baidu' && !item.unavailable && item.size>50*1024*1024 && item.size<8*1024**3);
  const first=sourceItems.find(item=>item.kind==='episode' && item.technical?.dynamicRange==='SDR') || sourceItems.find(item=>item.kind==='episode') || sourceItems[0];
  const second=sourceItems.find(item=>item.kind==='movie' && item.id!==first?.id) || sourceItems.find(item=>item.id!==first?.id);
  if(!first || !second) throw new Error('sources unavailable');
  const store=memoryStore();Object.assign(store.data.settings,{autoSync:false,autoNext:false,autoScrape:false,autoRefresh:false});
  // Only media identities enter this in-memory store; Trakt tokens and the
  // source library/progress are never copied into a writable application state.
  const selections=[first,second,...['HDR10','Dolby Vision'].map(format=>original.items.find(item=>item.source==='baidu' && !item.unavailable && item.technical?.dynamicRange===format))].filter((item,index,items)=>item && items.findIndex(other=>other?.id===item.id)===index);
  store.data.items=selections.map((item,index)=>Object.fromEntries(Object.entries({...item,title:`真实片源验证 ${index+1}`}).filter(([key])=>['id','source','fsId','filename','path','size','title','kind','season','episode','addedAt'].includes(key))));
  window=new BrowserWindow({show:false,width:1280,height:800,webPreferences:{preload:path.join(root,'electron/preload.cjs'),contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
  host=new NativeVideoHost(()=>window,()=>1);host.layout({x:0,y:0,width:1280,height:800});
  controls=new PlayerOverlay({parent:()=>window,videoHost:host,root,offscreen:true});
  await controls.create();
  // Defense in depth: acceptance windows remain hidden for their entire life.
  for(const view of [window,controls.window]) for(const method of ['show','showInactive','focus']) view[method]=()=>{throw new Error('visibility prohibited');};
  const snapshot=()=>({settings:store.data.settings,items:store.data.items,collections:groupLibrary(store.data.items),accounts:{baidu:{connected:true},trakt:{connected:false}},scan:{running:false},scrape:{running:false},logs:[],pendingCount:0,runtime:{desktop:true,playerOverlay:true,version:'0.3.18'},player:player?.status() ?? null});
  const notify=()=>{if(controls?.ready) controls.update(snapshot());};
  login=createBaiduLogin(store,notify,()=>window);stage='session restore';await login.restore();if(!login.service.connected)throw new Error('session unavailable');
  player=new PlayerService(store,login.service,{}, {eligible:()=>false,start:async()=>{},checkpoint:async()=>{}},{resolveMpv:()=>discoverMpv('',resources,root),notify,videoHost:host,inputConfig:path.join(playerDirectory,'player-keys.conf'),spawnPlayer:(binary,args,options)=>{const quiet=[...args];quiet.splice(quiet.indexOf('--'),0,'--mute=yes');return spawn(binary,quiet,options);}});
  thumbnails=player.thumbnails=new ThumbnailService(process.env.CLOUDREEL_TEST_DIRECTORY,player);
  ipcMain.handle('cloudreel:invoke',async(_event,method,payload)=>{
    if(method==='player:overlayRegions') {controls.setRegions(payload);if(payload.subtitleLayout)player.subtitleLayout(payload.subtitleLayout);}
    if(method==='player:seek') {seekCalls.push({seconds:payload.seconds});return {ok:true,value:player.seek(payload)};}
    if(method==='player:thumbnail') {const entry={seconds:payload.seconds};previewCalls.push(entry);const value=await thumbnails.request(payload);entry.success=Boolean(value);return {ok:true,value};}
    if(method==='player:cancelThumbnail') {thumbnails.cancel();return {ok:true};}
    if(method==='player:marker') return {ok:true,value:player.setMarker(payload)};
    if(method==='player:skipSection') return {ok:true,value:player.skipSection(payload)};
    return {ok:true,value:snapshot()};
  });
  // Overlay requested its initial state before the handler existed; reload once
  // the production services are ready, still without making any window visible.
  await new Promise(resolve=>{controls.window.webContents.once('did-finish-load',resolve);controls.window.webContents.reload();});
  controls.window.webContents.debugger.attach('1.3');
  await controls.window.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true});
  const js=script=>controls.window.webContents.executeJavaScript(script);
  const geometry=()=>js("Array.from(document.querySelectorAll('.cinema-header,.cinema-controls,.player-menu')).map(element=>{const r=element.getBoundingClientRect(),s=getComputedStyle(element);return {x:r.x,y:r.y,width:r.width,height:r.height,transform:s.transform,scale:s.scale,translate:s.translate};})");
  await js("window.__pointerEvents=[];window.__pointerErrors=[];for(const type of ['pointerdown','pointerup','pointercancel','gotpointercapture','lostpointercapture'])document.addEventListener(type,e=>window.__pointerEvents.push({type:e.type,tag:e.target.tagName,id:e.pointerId,buttons:e.buttons}),true);window.addEventListener('error',e=>window.__pointerErrors.push({name:e.error?.name,capture:e.message.includes('setPointerCapture')}))");
  const move=async(x,y,buttons=0)=>controls.window.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseMoved',x,y,buttons,button:buttons?'left':'none'});
  const pointer=async(type,x,y)=>controls.window.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type,x,y,button:'left',clickCount:1});
  const results=[];
  for(const item of store.data.items) {
    stage='source '+(results.length+1)+' playback';
    await player.play(item.id,true);
    await until(()=>player.session?.position>1 && player.session?.videoParams && player.session?.videoTarget,60000);
    await until(()=>player.status().buffered.some(range=>range.end>player.status().position+1),30000);
    const s=player.status();
    stage='source '+(results.length+1)+' stable overlay motion';
    controls.window.webContents.send('cloudreel:player-activity');await wait(250);
    await js("document.querySelector('[aria-label=\"播放倍速\"]').click()");await wait(20);
    const menuGeometry=await geometry();
    if(menuGeometry.length!==3 || menuGeometry.some(r=>r.transform!=='none' || r.scale!=='none' || r.translate!=='none')) throw new Error('overlay text transform');
    await wait(160);
    if(JSON.stringify(await geometry())!==JSON.stringify(menuGeometry)) throw new Error('overlay menu drift');
    await js("document.querySelector('[aria-label=\"关闭菜单\"]').click()");await wait(100);
    stage='source '+(results.length+1)+' uncached thumbnail';
    await until(()=>!player.session.buffering);
    const previewTarget=Math.floor(s.duration*.65/5)*5;
    if(s.buffered.some(range=>range.start<=previewTarget && range.end>=previewTarget))throw new Error('preview must be unbuffered');
    const positionBefore=player.session.position, coldAt=performance.now(), frame=await thumbnails.request({itemId:item.id,seconds:previewTarget});
    const coldMs=Math.round(performance.now()-coldAt);
    if(!frame)throw new Error('preview generation');
    const image=nativeImage.createFromDataURL(frame.image), dimensions=image.getSize();
    if(image.isEmpty() || dimensions.width!==320 || dimensions.height<40)throw new Error('preview image');
    if(process.env.CLOUDREEL_UI_OUTPUT) {fs.mkdirSync(process.env.CLOUDREEL_UI_OUTPUT,{recursive:true});fs.writeFileSync(path.join(process.env.CLOUDREEL_UI_OUTPUT,'preview-'+results.length+'.png'),image.toPNG());}
    if(Math.abs(player.session.position-previewTarget)<10 || player.session.position<positionBefore)throw new Error('preview altered playback');
    stage='source '+(results.length+1)+' cached thumbnail';
    const cachedAt=performance.now(),cached=await thumbnails.request({itemId:item.id,seconds:previewTarget}),cachedMs=Math.round(performance.now()-cachedAt);
    if(!cached || cached.image!==frame.image)throw new Error('preview cache');
    const another=await thumbnails.request({itemId:item.id,seconds:previewTarget+15});
    if(!another || another.seconds===frame.seconds || another.image===frame.image)throw new Error('preview seek');
    stage='source '+(results.length+1)+' pointer preview';
    controls.window.webContents.send('cloudreel:player-activity');await wait(400);
    const rect=await js("(()=>{const r=document.querySelector('.timeline input').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};})()");
    const x=rect.x+6+previewTarget/s.duration*(rect.width-12),y=rect.y+rect.height/2;
    await move(x-1,y);await wait(80);await move(x,y);
    await until(()=>js("Boolean(document.querySelector('.timeline-picture img')?.complete && document.querySelector('.timeline-picture img')?.naturalWidth)"),15000);
    stage='source '+(results.length+1)+' preview layout';
    const previewLayout=await js("(()=>{const r=document.querySelector('.timeline-picture').getBoundingClientRect();return {width:r.width,inside:r.left>=0&&r.right<=innerWidth&&r.top>=0};})()");
    if(!previewLayout.inside || previewLayout.width<200)throw new Error('preview layout');
    if(player.session.seek?.pending)throw new Error('hover must not seek');
    stage='source '+(results.length+1)+' drag press';
    await pointer('mousePressed',x,y);await wait(100);await move(x+3,y,1);await wait(100);
    if(!await js("document.querySelector('.timeline').classList.contains('is-scrubbing')"))throw new Error('drag not started');
    if(player.session.seek?.pending)throw new Error('drag must not seek before release');
    stage='source '+(results.length+1)+' drag release';
    await pointer('mouseReleased',x+3,y);
    await until(()=>!player.status().seek?.pending && player.session.position>s.duration*.5,45000);
    await move(20,20);await until(()=>js("!document.querySelector('.timeline-picture')"));
    stage='source '+(results.length+1)+' chapter and marker UI';
    await controls.window.webContents.executeJavaScript("document.querySelector('[aria-label=\"章节与片头片尾\"]').click()");
    await until(()=>controls.window.webContents.executeJavaScript("Boolean(document.querySelector('[aria-label=\"片头片尾应用范围\"]'))"));
    player.setMarker({itemId:item.id,scope:'episode',field:'introEnd',seconds:60});
    player.setMarker({itemId:item.id,scope:'episode',field:'creditsStart',seconds:s.duration-20});
    await until(()=>controls.window.webContents.executeJavaScript("document.querySelectorAll('.timeline-section-mark').length===2"));
    await controls.window.webContents.executeJavaScript("document.querySelector('[aria-label=\"关闭菜单\"]').click()");
    if(player.status().chapters.length) {
      const target=player.status().chapters.find(chapter=>chapter.time>0)?.time;
      if(target) {
        await js("document.querySelector('[aria-label=\"章节与片头片尾\"]').click()");
        await js("document.querySelectorAll('.chapter-choice')[1].click()");
        await until(()=>!player.status().seek?.pending && Math.abs(player.session.position-target)<8,45000);
      }
    }
    player.seek({itemId:item.id,seconds:30});await until(()=>!player.status().seek.pending,45000);
    player.skipSection({itemId:item.id,section:'intro'});await until(()=>!player.status().seek.pending && Math.abs(player.session.position-60)<8,45000);
    if(results.length===0) {
      player.session.preferences.skipIntro='auto';player.session.introSkipped=false;
      player.seek({itemId:item.id,seconds:30});
      await until(()=>!player.status().seek.pending && player.session.position>=60,45000);
      player.session.preferences.skipIntro='manual';
    }
    let prefetchedMs;
    if(results.length===0) {
      stage='background storyboard and instant cached lookup';
      const identity=thumbnailKey(item,null);
      await until(()=>[...thumbnails.frames.values()].filter(frame=>frame.identity===identity).length>=3,30000);
      const prefetched=[...thumbnails.frames.values()].find(frame=>frame.identity===identity && frame.target!==previewTarget && frame.target!==previewTarget+15);
      if(!prefetched)throw new Error('background frame unavailable');
      const before=player.session.position,at=performance.now();
      const cached=await thumbnails.request({itemId:item.id,seconds:prefetched.target,cachedOnly:true});prefetchedMs=Math.round(performance.now()-at);
      if(!cached || cached.image!==prefetched.image || Math.abs(player.session.position-before)>3)throw new Error('prefetch isolation');
    }
    if(process.env.CLOUDREEL_UI_OUTPUT && results.length===0) {
      stage='source 1 navigation capture';
      fs.mkdirSync(process.env.CLOUDREEL_UI_OUTPUT,{recursive:true});
      await js("document.querySelector('[aria-label=\"章节与片头片尾\"]').click()");await wait(300);
      controls.window.webContents.invalidate();await controls.window.webContents.capturePage();await wait(200);
      fs.writeFileSync(path.join(process.env.CLOUDREEL_UI_OUTPUT,'player-navigation.png'),(await controls.window.webContents.capturePage()).toPNG());
      stage='source 1 thumbnail capture';
      await js("document.querySelector('[aria-label=\"关闭菜单\"]').click()");await wait(100);await move(20,20);await move(x,y);await until(()=>js("Boolean(document.querySelector('.timeline-picture img')?.naturalWidth)"),15000);
      controls.window.webContents.invalidate();await controls.window.webContents.capturePage();await wait(200);
      fs.writeFileSync(path.join(process.env.CLOUDREEL_UI_OUTPUT,'player-thumbnail.png'),(await controls.window.webContents.capturePage()).toPNG());await move(20,20);
    }
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
    results.push({source:item.kind,dynamicRange:s.video?.source,decoded:true,stableOverlayMotion:true,cacheRanges:player.status().buffered.length,forwardAndBackwardSeek:true,bufferVisible:true,styledPlayerPicker:true,unbufferedThumbnail:true,thumbnailDimensions:dimensions,thumbnailCache:true,thumbnailSeek:true,previewColdMs:coldMs,previewCachedMs:cachedMs,prefetchedPreviewMs:prefetchedMs,hoverAndDragPreview:true,chapters:player.status().chapters.length,introSkip:true,markerUI:true});
    if(results.length===store.data.items.length) {
      stage='credits seek and skip';
      player.seek({itemId:item.id,seconds:s.duration-10});
      await until(()=>!player.status()?.seek?.pending && player.session.position>=s.duration-15,45000);
      await until(()=>js("document.querySelector('.skip-section')?.textContent.includes('跳过片尾')"));
      await js("document.querySelector('.skip-section').click()");
      await until(()=>!player.session || player.session.eof || player.session.position>=s.duration-.5,45000);
      results.at(-1).creditsSkip=true;
    }
  }
  await player.stop();await until(()=>controls.window.webContents.executeJavaScript("document.querySelectorAll('.timeline-buffered').length===0"));
  if(BrowserWindow.getAllWindows().some(view=>view.isVisible()))throw new Error('visible window');
  console.log('REAL_PLAYBACK_RESULT '+JSON.stringify({passed:true,packagedResources:Boolean(process.env.CLOUDREEL_PACKAGE_ROOT),productionSessionRelayPlayer:true,sources:results,traktWrites:syncWrites,visibleWindowsOpened:0}));
  await thumbnails.reset();login.close();controls.destroy();host.destroy();window.destroy();app.quit();
}).catch(async()=>{
  const status=player?.status();
  const ui=await controls?.window?.webContents.executeJavaScript("(()=>({className:document.querySelector('.cinema')?.className,timeline:document.querySelector('.timeline')?.className,preview:Boolean(document.querySelector('.timeline-picture')),image:Boolean(document.querySelector('.timeline-picture img')?.naturalWidth),caption:document.querySelector('.timeline-picture-caption')?.textContent,previewRect:document.querySelector('.timeline-picture')?.getBoundingClientRect().toJSON(),viewport:[innerWidth,innerHeight],events:window.__pointerEvents,errors:window.__pointerErrors}))()").catch(()=>null);
  console.log('REAL_PLAYBACK_RESULT '+JSON.stringify({passed:false,stage,ui,previewCalls,seekCalls,playback:status ? {position:status.position,duration:status.duration,buffering:status.buffering,seekPending:status.seek?.pending,seekError:Boolean(status.seek?.error),buffered:status.buffered} : null}));
  try{await player?.stop();await thumbnails?.reset();}catch{}login?.close();controls?.destroy();host?.destroy();window?.destroy();app.exit(1);
});
