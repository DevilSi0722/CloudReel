import {app,BrowserWindow,ipcMain} from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {fileURLToPath,pathToFileURL} from 'node:url';
const root=process.env.CLOUDREEL_PACKAGE_ROOT||fileURLToPath(new URL('../../',import.meta.url));
app.setName('CloudReel-Discovery-UI');app.setPath('userData',process.env.CLOUDREEL_TEST_DIRECTORY);
let window,provider,liveCatalog;
const state={settings:{baiduMode:'web',autoSync:false,autoScrape:false},accounts:{baidu:{connected:true,mode:'web',profile:{}},trakt:{connected:false}},items:[],collections:[],logs:[],pendingCount:0,scrape:{running:false},scan:{running:false},scanRoots:[],discoveryTransfers:[],runtime:{desktop:true,version:'0.3.20',mpvReady:true},player:null};
const calls=[],wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));let pageThreeFailed=false;
const until=async check=>{for(let i=0;i<100;i++){if(await check())return;await wait(40);}throw new Error('UI timeout');};
app.whenReady().then(async()=>{
  if(process.env.CLOUDREEL_DISCOVERY_LIVE_IMAGES){
    const {DiscoveryBrowser}=await import(pathToFileURL(path.join(root,'electron/services/discovery-browser.mjs')).href);
    const {DiscoveryService}=await import(pathToFileURL(path.join(root,'electron/services/discovery.mjs')).href);
    provider=new DiscoveryService({createBrowser:()=>new DiscoveryBrowser('https://sidhub.cc')});liveCatalog=await provider.catalog();
    assert.equal(liveCatalog.movies.length,20);
  }
  ipcMain.handle('cloudreel:invoke',async(_event,method,payload)=>{
    calls.push({method,payload});let value=state;
    if(method==='discovery:catalog') {
      await wait(payload.query==='旧查询'?400:60);
      if(!payload.query&&payload.page===3&&!pageThreeFailed){pageThreeFailed=true;return {ok:false,error:'暂时无法读取下一页，请重试。'};}
      const start=payload.page===2?20:payload.page===3?40:1;
      value={movies:Array.from({length:payload.query?2:20},(_,index)=>({id:String(start+index),title:payload.query?payload.query+' '+(index+1):liveCatalog?.movies[index]?.title||'影视作品 '+(start+index),poster:liveCatalog?.movies[index]?.poster||null})),next:!payload.query&&payload.page<3?'next':null};
    }
    if(method==='discovery:detail') value={title:'硅谷 第四季',overview:'理想与现实之间，总有新的故事。选择版本后，将影片保存到自己的云端影院。',poster:null,resources:[...Array.from({length:14},(_,index)=>({id:'r'+index,title:'硅谷 第四季 · 1080P · 中英字幕 · 资源 '+(index+1),provider:'baidu'})),{id:'quark1',title:'夸克版本 1',provider:'quark'},{id:'quark2',title:'夸克版本 2',provider:'quark'},{id:'xunlei1',title:'迅雷版本',provider:'xunlei'},{id:'unknown1',title:'未标注版本',provider:'unknown'}]};
    if(method==='discovery:preview') value={handle:'preview',work:{title:'硅谷',kind:'episode',season:4,year:2014},directory:'/',page:1,hasMore:false,files:[{fs_id:'100',server_filename:'硅谷 第四季',path:'/Silicon.Valley',isdir:1,size:0}]};
    if(method==='discovery:naming'){await wait(100);value={total:1,renamed:1,skipped:0,files:[{original:'Silicon.Valley.S04E03.mkv',name:'硅谷 - S04E03.mkv',reason:''}]};}
    if(method==='discovery:files') value={directory:'/Silicon.Valley',page:1,hasMore:false,files:[{fs_id:'101',server_filename:'Silicon.Valley.S04E03.mkv',path:'/Silicon.Valley/Silicon.Valley.S04E03.mkv',isdir:0,size:1024**3}]};
    if(method==='baidu:folders') value={files:[{fs_id:'300',server_filename:'电影',path:'/Movies',isdir:1,size:0}],hasMore:false,nextStart:1};
    if(method==='discovery:transfer') {state.discoveryTransfers=[{id:'job',status:'submitted',title:'硅谷 第四季',target:'/Movies',message:'百度正在保存文件',at:new Date().toISOString(),count:0,canCheck:true}];window.webContents.send('cloudreel:state',state);value=state.discoveryTransfers[0];}
    return {ok:true,value};
  });
  window=new BrowserWindow({show:false,width:1380,height:900,webPreferences:{preload:path.join(root,'electron/preload.cjs'),contextIsolation:true,nodeIntegration:false,backgroundThrottling:false,offscreen:true}});
  for(const method of ['show','showInactive','focus'])window[method]=()=>{throw new Error('visibility prohibited');};
  await window.loadFile(path.join(root,'dist/index.html'));const js=script=>window.webContents.executeJavaScript(script);
  const click=label=>js(`Array.from(document.querySelectorAll('button')).find(button=>button.textContent.trim()===${JSON.stringify(label)}).click()`);
  const capture=async name=>{if(!process.env.CLOUDREEL_UI_OUTPUT)return;fs.mkdirSync(process.env.CLOUDREEL_UI_OUTPUT,{recursive:true});await wait(300);window.webContents.invalidate();await window.webContents.capturePage();await wait(120);fs.writeFileSync(path.join(process.env.CLOUDREEL_UI_OUTPUT,name),(await window.webContents.capturePage()).toPNG());};
  await until(()=>js("Boolean(document.querySelector('.nav-item'))"));assert.equal(calls.some(call=>call.method==='discovery:catalog'),false);
  await click('发现');await until(()=>js("document.querySelectorAll('.discovery-card').length===20"));
  assert.equal(calls.find(call=>call.method==='discovery:catalog').payload.order,'hot');
  assert.equal(await js("document.querySelector('.discovery-sort button[aria-pressed=true]').textContent"),'近期热门');
  if(liveCatalog){await until(()=>js("Array.from(document.querySelectorAll('.discovery-cover img')).filter(img=>img.naturalWidth>0).length>=6"));console.log(JSON.stringify({liveArtworkLoaded:await js("Array.from(document.querySelectorAll('.discovery-cover img')).filter(img=>img.naturalWidth>0).length")}));}
  await capture('discovery-grid.png');
  await js("window.scrollTo(0,document.documentElement.scrollHeight)");await until(()=>js("document.querySelectorAll('.discovery-card').length===39"));
  assert.equal(calls.filter(call=>call.method==='discovery:catalog'&&call.payload.page===2).length,1,'one request per automatic page, with duplicate cards merged');
  await js("window.scrollTo(0,document.documentElement.scrollHeight)");await until(()=>js("Boolean(document.querySelector('.discovery-page-error'))"));await wait(250);
  assert.equal(calls.filter(call=>call.method==='discovery:catalog'&&call.payload.page===3).length,1,'pagination failures do not repeatedly retry');
  assert.equal(await js("document.querySelectorAll('.discovery-card').length"),39,'a pagination failure preserves loaded cards');
  await click('重试加载');await until(()=>js("document.querySelectorAll('.discovery-card').length===59"));
  await js("window.scrollTo(0,document.documentElement.scrollHeight)");await wait(200);assert.equal(calls.some(call=>call.method==='discovery:catalog'&&call.payload.page>3),false);
  await js("window.scrollTo(0,0)");
  await js("document.querySelector('[aria-label=\"刷新发现页\"]').click()");await until(()=>calls.some(call=>call.method==='discovery:catalog'&&call.payload.fresh===true));await until(()=>js("!document.querySelector('[aria-label=\"刷新发现页\"]').disabled"));
  await js("document.querySelector('.discovery-tabs button:nth-child(3)').click()");await until(()=>calls.some(call=>call.method==='discovery:catalog'&&call.payload.category==='shows'));
  await js("(()=>{const input=document.querySelector('[aria-label=\"搜索片源\"]');const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;setter.call(input,'旧查询');input.dispatchEvent(new Event('input',{bubbles:true}));})()");await wait(370);
  await js("(()=>{const input=document.querySelector('[aria-label=\"搜索片源\"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'硅谷');input.dispatchEvent(new Event('input',{bubbles:true}));})()");
  await until(()=>js("document.querySelector('.discovery-card strong')?.textContent==='硅谷 1'"));assert.equal(await js("Boolean(document.querySelector('.view-discovery'))"),true);
  await js("document.querySelector('.discovery-card').click()");await until(()=>js("document.querySelectorAll('.discovery-resource').length===12"));
  assert.equal(await js("document.querySelector('.discovery-provider-tabs button[aria-pressed=true]').dataset.provider"),'baidu');
  assert.equal(await js("[...document.querySelectorAll('.discovery-resource .discovery-provider')].every(node=>node.textContent==='百度网盘')"),true);
  await js("document.querySelector('[data-provider=quark]').click()");assert.equal(await js("document.querySelectorAll('.discovery-resource:disabled').length"),2);
  await js("document.querySelector('[data-provider=all]').click()");await click('显示更多资源');assert.equal(await js("document.querySelectorAll('.discovery-resource').length"),18);
  assert.equal(await js("document.querySelectorAll('.discovery-resource:disabled').length"),3,'other providers are labelled without pretending to support saving');
  await js("document.querySelector('[data-provider=baidu]').click()");
  await click('显示更多资源');assert.equal(await js("document.querySelectorAll('.discovery-resource').length"),14);await capture('discovery-detail.png');
  await js("document.querySelector('.discovery-resource').click()");await until(()=>js("Boolean(document.querySelector('.share-file'))"));
  assert.equal(await js("document.querySelector('.share-save-footer .primary').disabled"),true);
  await js("document.querySelector('.share-file input').click()");await js("document.querySelector('.share-file>button').click()");await until(()=>js("document.querySelector('.share-file button span')?.textContent.includes('S04E03')"));
  assert.equal(await js("document.querySelector('.share-file input').checked"),false,'opening a selected folder must not retain whole-season selection');
  await js("document.querySelector('.share-file input').click()");await click('选择文件夹');await until(()=>js("document.querySelectorAll('.folder-choice').length===1"));
  assert.equal(await js("document.querySelector('.folder-picker-footer button').disabled"),true,'root cannot trigger a whole-account ingestion');
  assert.equal(await js("document.querySelectorAll('[role=dialog]').length"),1,'destination picker has one focus trap');
  await js("document.querySelector('.folder-choice').click()");await until(()=>js("document.querySelector('.folder-picker-selection p')?.textContent==='/Movies'"));await until(()=>js("!document.querySelector('.folder-picker-footer button').disabled"));await click('保存到此文件夹');
  await until(()=>js("Boolean(document.querySelector('.share-save-footer'))"));await until(()=>js("Boolean(document.querySelector('.share-naming details'))"));assert.equal(calls.some(call=>call.method==='library:mountBaidu'),false);
  assert.equal(await js("document.querySelector('.share-naming input[type=checkbox]').checked"),true);
  assert.equal(await js("document.querySelector('[aria-label=\"保存剧集季数\"]').value"),'4');
  await js("document.querySelector('.share-naming summary').click()");assert.equal(await js("document.querySelector('.share-naming-preview span').textContent"),'硅谷 - S04E03.mkv');
  await capture('discovery-naming.png');await js("document.querySelector('.share-naming summary').click()");
  assert.equal(await js("document.querySelector('.share-destination p').textContent"),'/Movies');assert.equal(await js("document.querySelector('.share-save-footer .primary').disabled"),false);await capture('discovery-save.png');
  window.setSize(980,720);await wait(100);
  const bounds=await js("(()=>{const r=document.querySelector('.share-save-footer .primary').getBoundingClientRect();return {inside:r.bottom<=innerHeight&&r.right<=innerWidth&&r.left>=0};})()");assert.equal(bounds.inside,true);
  await click('保存并加入片库');await until(()=>js("Boolean(document.querySelector('.discovery-submitted'))"));
  const writes=calls.filter(call=>call.method==='discovery:transfer');assert.equal(writes.length,1);assert.deepEqual(writes[0].payload,{handle:'preview',fsIds:['101'],target:{path:'/Movies',fsId:'300'},mount:true,autoRename:true,season:4});
  await click('继续浏览');await until(()=>js("!document.querySelector('[role=dialog]')"));assert.equal(await js("document.querySelector('.discovery-task p').textContent"),'百度正在保存文件');
  assert.equal(BrowserWindow.getAllWindows().some(view=>view.isVisible()),false);
  console.log(JSON.stringify({nativeDiscovery:true,recentPopular:true,infiniteScroll:true,paginationRetry:true,providerFilters:true,staleSearchIgnored:true,progressiveResources:true,singleEpisodeSelection:true,destinationWithoutMount:true,transferSubmittedOnce:true,responsiveSave:true,visibleWindows:0}));provider?.close();window.destroy();app.quit();
}).catch(error=>{console.error(error.stack);provider?.close();window?.destroy();app.exit(1);});
