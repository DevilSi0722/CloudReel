import {app,BrowserWindow,ipcMain} from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
const root=process.env.CLOUDREEL_PACKAGE_ROOT||fileURLToPath(new URL('../../',import.meta.url));
app.setName('CloudReel-Sources-Regression');app.setPath('userData',path.join(process.env.CLOUDREEL_TEST_DIRECTORY,'profile'));
let window;
const state={settings:{baiduMode:'web',rootDir:'/Old',autoSync:false,autoScrape:false,autoNext:false},accounts:{baidu:{connected:true,mode:'web',profile:{netdisk_name:'我的网盘'}},trakt:{connected:false}},items:[],collections:[],logs:[],pendingCount:0,scrape:{running:false},scan:{running:false},scanRoots:[],runtime:{desktop:true,version:'0.3.19',mpvReady:true},player:null};
const calls=[],folder={fs_id:'100',server_filename:'剧集',path:'/剧集',isdir:1,size:0};let failNext=false;
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
app.whenReady().then(async()=>{
  ipcMain.handle('cloudreel:invoke',async(_event,method,payload)=>{
    calls.push({method,payload});
    if(method==='baidu:folders') {
      if(failNext){failNext=false;return {ok:false,error:'暂时无法读取文件夹'};}
      if(payload.directory==='/剧集'){await wait(300);return {ok:true,value:{files:[],hasMore:false,nextStart:0}};}
      return {ok:true,value:{files:payload.start?[{...folder,fs_id:'200',path:'/电影',server_filename:'电影'}]:[folder],hasMore:!payload.start,nextStart:payload.start?400:200}};
    }
    if(method==='library:mountBaidu') state.scanRoots.push({id:'root',source:'baidu',path:payload.path,fsId:payload.fsId,enabled:true,count:24,lastScannedAt:new Date().toISOString()});
    if(method==='library:removeRoot')state.scanRoots=[];
    window.webContents.send('cloudreel:state',state);return {ok:true,value:state};
  });
  window=new BrowserWindow({show:false,width:1280,height:900,webPreferences:{preload:path.join(root,'electron/preload.cjs'),contextIsolation:true,nodeIntegration:false,backgroundThrottling:false,offscreen:true}});
  for(const method of ['show','showInactive','focus'])window[method]=()=>{throw new Error('visibility prohibited');};
  await window.loadFile(path.join(root,'dist/index.html'));const js=script=>window.webContents.executeJavaScript(script);
  await wait(120);await js("Array.from(document.querySelectorAll('.nav-item')).find(b=>b.textContent==='百度网盘').click()");await wait(100);
  assert.equal(calls.filter(call=>/baidu:(list|folders)/.test(call.method)).length,0,'landing must not enumerate the drive');
  const mount=()=>js("Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='挂载文件夹').click()");
  await mount();await wait(100);assert.equal(await js("document.querySelectorAll('.folder-choice').length"),1);
  await js("document.querySelector('.load-more').click()");await wait(70);
  assert.equal(calls.filter(call=>call.method==='baidu:folders').at(-1).payload.start,200,'pagination uses server cursor, not filtered folder count');
  assert.equal(await js("document.querySelectorAll('.folder-choice').length"),2);
  await js("document.querySelector('.folder-choice').click()");await wait(30);await js("document.querySelector('[aria-label=\"上级目录\"]').click()");await wait(400);
  assert.equal(await js("document.querySelectorAll('.folder-choice').length"),1,'late child response cannot replace root');
  failNext=true;await js("document.querySelector('[aria-label=\"刷新文件夹列表\"]').click()");await wait(70);
  assert.equal(await js("Boolean(document.querySelector('.folder-picker [role=alert]'))"),true);
  assert.equal(await js("document.querySelector('.folder-picker-footer button').disabled"),true);
  await js("document.querySelector('.folder-picker .inline-error button').click()");await wait(70);
  await js("document.querySelector('.folder-choice').click()");await wait(380);
  assert.equal(await js("document.querySelector('.folder-picker-selection p').textContent"),'/剧集');
  assert.equal(await js("document.querySelector('.folder-picker-footer button').disabled"),false,'leaf folders can be mounted');
  if(process.env.CLOUDREEL_UI_OUTPUT){fs.mkdirSync(process.env.CLOUDREEL_UI_OUTPUT,{recursive:true});fs.writeFileSync(path.join(process.env.CLOUDREEL_UI_OUTPUT,'folder-picker.png'),(await window.webContents.capturePage()).toPNG());}
  await js("document.querySelector('.folder-picker-footer button').click()");await wait(120);
  assert.deepEqual(calls.find(call=>call.method==='library:mountBaidu').payload,{path:'/剧集',fsId:'100'});
  assert.equal(calls.some(call=>call.method==='settings:save'||call.method==='library:scan'),false);
  assert.equal(await js("document.querySelectorAll('.mount-card').length"),1);
  await mount();await wait(100);await js("document.querySelector('.folder-choice').click()");await wait(380);
  assert.equal(await js("document.querySelector('.folder-picker-footer button').disabled"),true);assert.match(await js("document.querySelector('.folder-picker-footer button').textContent"),/已挂载/);
  await js("document.querySelector('[aria-label=\"关闭窗口\"]').click()");await wait(200);
  for(const [width,height] of [[980,760],[1440,1000]]){window.setContentSize(width,height);await wait(80);assert.equal(await js('document.documentElement.scrollWidth<=innerWidth'),true);}
  if(process.env.CLOUDREEL_UI_OUTPUT)fs.writeFileSync(path.join(process.env.CLOUDREEL_UI_OUTPUT,'mounted-folders.png'),(await window.webContents.capturePage()).toPNG());
  await js("Array.from(document.querySelectorAll('.nav-item')).find(b=>b.textContent==='设置').click()");await wait(80);
  await js("Array.from(document.querySelectorAll('summary')).find(s=>s.textContent.includes('影视目录')).click()");await wait(80);
  await js("Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='挂载网盘文件夹').click()");await wait(80);
  assert.equal(await js("Boolean(document.querySelector('.folder-picker'))"),true);
  assert.equal(BrowserWindow.getAllWindows().some(view=>view.isVisible()),false);
  console.log(JSON.stringify({lazyMounts:true,serverPagination:true,staleRepliesIgnored:true,retry:true,stableFolderId:true,duplicatePrevented:true,narrowLayout:true,visibleWindowsOpened:0}));
  window.destroy();app.quit();
}).catch(error=>{console.error(error.stack);window?.destroy();app.exit(1);});
