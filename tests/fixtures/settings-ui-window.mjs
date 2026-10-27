import {app, BrowserWindow, ipcMain} from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';

const root=process.env.CLOUDREEL_PACKAGE_ROOT || fileURLToPath(new URL('../../',import.meta.url));
app.setName('CloudReel-Settings-Regression');
app.commandLine.appendSwitch('disable-lcd-text');
app.setPath('userData',path.join(process.env.CLOUDREEL_TEST_DIRECTORY,'profile'));
let window;
const state={settings:{baiduMode:'web',rootDir:'/',autoSync:true,autoScrape:true,autoNext:true,autoRefresh:true,mpvPath:'',baiduClientId:'',traktClientId:'',traktRedirectUri:''},
  accounts:{baidu:{connected:false,configured:true},trakt:{connected:false,configured:true}},items:[],collections:[],logs:[],pendingCount:0,
  scrape:{running:false,done:0,total:0,tmdbConfigured:true},scan:{running:false,count:0},scanRoots:[],
  playbackDefaults:{audioLanguage:'auto',subtitleLanguage:'zh-Hans',speed:1,subtitleDelay:0,subtitleSize:44,subtitleFont:'Microsoft YaHei',rememberPlayback:true},
  runtime:{desktop:true,version:'0.3.18',mpvReady:true},player:null};
const calls=[];
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
app.whenReady().then(async()=>{
  ipcMain.handle('cloudreel:invoke',(_event,method,payload)=>{
    if(method==='player:thumbnail') return {ok:true,value:{image:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aotkAAAAASUVORK5CYII=',seconds:payload.seconds}};
    if(method==='player:marker') calls.push(payload);
    if(method==='settings:save') {calls.push(payload);Object.assign(state.settings,payload);}
    if(method==='playback:defaults') {calls.push(payload);Object.assign(state.playbackDefaults,payload);}
    window.webContents.send('cloudreel:state',state);
    return {ok:true,value:state};
  });
  window=new BrowserWindow({show:false,width:1440,height:1100,webPreferences:{preload:path.join(root,'electron/preload.cjs'),contextIsolation:true,nodeIntegration:false,backgroundThrottling:false,offscreen:true}});
  await window.loadFile(path.join(root,'dist/index.html'));
  window.webContents.debugger.attach('1.3');
  await window.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true});
  const key=async(key,code,virtualKey)=>{for(const type of ['keyDown','keyUp']) await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type,key,code,windowsVirtualKeyCode:virtualKey});};
  const js=script=>window.webContents.executeJavaScript(script);
  await wait(150);
  await js("(()=>{window.__transitions=0;const animate=Element.prototype.animate;Element.prototype.animate=function(frames,options){if(options?.id==='cloudreel-page-reveal')window.__transitions++;return animate.call(this,frames,options);};})()");
  await js("Array.from(document.querySelectorAll('.nav-item')).find(b=>b.textContent==='设置').click()");await wait(120);
  assert.equal(await js("window.__transitions"),1,'page changes should use a content transition');
  assert.equal(await js("getComputedStyle(document.querySelector('.content')).viewTransitionName"),'none');
  await wait(400);
  await js("document.querySelector('[aria-label=\"添加媒体\"]').click()");await wait(60);
  assert.equal(await js("getComputedStyle(document.querySelector('.modal')).animationName"),'dialog-in');
  await js("document.querySelector('[aria-label=\"关闭窗口\"]').click()");await wait(40);
  assert.equal(await js("Boolean(document.querySelector('.modal-backdrop.is-dismissing'))"),true);
  await wait(180);assert.equal(await js("Boolean(document.querySelector('[role=dialog]'))"),false);
  for(const [width,height,scale] of [[1280,800,1],[1920,1080,1.25],[2560,1440,1],[3840,2160,1.5]]) {
    await window.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:scale,mobile:false});await wait(100);
    assert.equal(await js("document.documentElement.scrollWidth<=innerWidth"),true,`no horizontal overflow at ${width}/${scale}`);
    const fonts=await js("Array.from(document.querySelectorAll('.settings-section-copy small,.nav-label,.sidebar-version,.setting-row strong')).map(element=>parseFloat(getComputedStyle(element).fontSize))");
    assert.ok(fonts.length && fonts.every(size=>size>=13),`small text must remain legible at ${width}/${scale}`);
  }
  await window.webContents.debugger.sendCommand('Emulation.clearDeviceMetricsOverride');
  await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
  await js("Array.from(document.querySelectorAll('.nav-item')).find(b=>b.textContent==='设置').click()");await wait(100);
  assert.deepEqual(await js("Array.from(document.querySelectorAll('.settings-disclosure')).map(d=>d.open)"),[false,false,false,false]);
  assert.equal(await js("document.querySelector('[aria-label=\"TMDB API Read Access Token\"]').checkVisibility()"),false);
  // Opening a section rotates only its direct chevron, including nested panels.
  for (let index=0;index<4;index++) {
    for (const open of [true,false]) {
      await js(`document.querySelectorAll('.settings-disclosure')[${index}].querySelector('summary').click()`);await wait(250);
      assert.deepEqual(await js(`(()=>{const section=document.querySelectorAll('.settings-disclosure')[${index}];const rotation=selector=>{const m=new DOMMatrix(getComputedStyle(section.querySelector(selector)).transform);return [Math.round(m.a),Math.round(m.d)];};return {icon:rotation('.settings-section-icon svg'),arrow:rotation(':scope>summary>.disclosure-chevron')};})()`),{icon:[1,1],arrow:open?[-1,-1]:[1,1]},'category icons must stay upright while only the section chevron rotates');
      if(index===0 && open) {
        const nestedArrow="document.querySelector('.settings-nested>summary>svg')";
        assert.equal(await js(`new DOMMatrix(getComputedStyle(${nestedArrow}).transform).a`),1,'a closed nested panel must keep its chevron pointing down');
        await js("document.querySelector('.settings-nested>summary').click()");await wait(250);
        assert.equal(await js(`Math.round(new DOMMatrix(getComputedStyle(${nestedArrow}).transform).a)`),-1);
        await js("document.querySelector('.settings-nested>summary').click()");await wait(250);
      }
    }
  }
  await js("document.querySelector('[aria-label=\"自动播放下一集\"]').click()");await wait(100);
  assert.deepEqual(calls.shift(),{autoNext:false},'an immediate setting must not overwrite other preferences');
  const output=process.env.CLOUDREEL_UI_OUTPUT;
  const capture=async name=>{window.webContents.invalidate();await wait(200);await window.webContents.capturePage();await wait(100);fs.writeFileSync(path.join(output,name),(await window.webContents.capturePage()).toPNG());};
  if(output) {fs.mkdirSync(output,{recursive:true});await capture('settings.png');}
  await js("document.querySelector('.settings-disclosure>summary').click()");await wait(100);
  if(output) {await js("document.querySelector('.settings-disclosure>summary').scrollIntoView({block:'start'})");await capture('settings-expanded.png');}
  assert.equal(await js("document.querySelector('[aria-label=\"首选字幕语言\"]').checkVisibility()"),true);
  assert.equal(await js("document.querySelector('[aria-label=\"默认字幕字体\"]').checkVisibility()"),false);
  assert.equal(await js("CSS.supports('appearance','base-select')"),true);
  assert.equal(await js("getComputedStyle(document.querySelector('[aria-label=\"首选字幕语言\"]')).appearance"),'base-select');
  // Targeted renderer input stays inside this always-hidden window.
  await js("document.querySelector('[aria-label=\"首选字幕语言\"]').focus()");
  await window.webContents.executeJavaScript("document.querySelector('[aria-label=\"首选字幕语言\"]').showPicker()",true);await wait(100);
  assert.equal(await js("document.querySelector('[aria-label=\"首选字幕语言\"]').matches(':open')"),true);
  if(output) await capture('dropdown.png');
  await key('Home','Home',36);await key('Enter','Enter',13);await wait(100);
  assert.equal(await js("document.querySelector('[aria-label=\"首选字幕语言\"]').value"),'auto');
  await js("Array.from(document.querySelectorAll('.settings-disclosure button')).find(b=>b.textContent==='保存播放偏好').click()");await wait(80);
  assert.equal(calls.shift()?.subtitleLanguage,'auto');
  await window.setContentSize(980,760);await wait(80);
  assert.equal(await js('document.documentElement.scrollWidth <= innerWidth'),true);
  // Render buffered segments, including a disjoint cached range, through the app.
  state.items=[{id:'test',title:'Timeline',kind:'movie',source:'local',filename:'test.mkv',path:'test.mkv',size:0}];
  state.collections=[{id:'test',title:'Timeline',kind:'movie',itemIds:['test'],seasons:[]}];
  // Check detail layout and its five media facts at the smallest window, before
  // entering playback. This stays independent from any personal library.
  await js("Array.from(document.querySelectorAll('.nav-item')).find(b=>b.textContent==='电影').click()");
  window.webContents.send('cloudreel:state',state);await wait(100);
  await js("document.querySelector('[aria-label=\"Timeline 详情\"]').click()");await wait(100);
  assert.equal(await js("document.querySelectorAll('.title-media-facts dd').length"),5);
  assert.equal(await js("document.documentElement.scrollWidth<=innerWidth"),true,'larger type must not overflow the narrow detail page');
  if(output)await capture('details-narrow.png');
  state.player={itemId:'test',title:'Timeline',position:120,duration:600,paused:true,ready:true,speed:1,volume:100,tracks:[],buffered:[{start:0,end:200},{start:400,end:480}]};
  window.webContents.send('cloudreel:state',state);await wait(100);
  assert.deepEqual(await js("Array.from(document.querySelectorAll('.timeline-buffered')).map(s=>[Math.round(parseFloat(s.style.left)*100)/100,Math.round(parseFloat(s.style.width)*100)/100])"),[[0,33.33],[66.67,13.33]]);
  assert.equal(await js("getComputedStyle(document.querySelector('.timeline input')).backgroundImage"),'none');
  const move=async(x,y)=>window.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseMoved',x,y});
  const rail=await js("(()=>{const r=document.querySelector('.timeline input').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};})()");
  await move(rail.x+rail.width*.65,rail.y+rail.height/2);await wait(400);
  assert.equal(await js("Boolean(document.querySelector('.timeline-picture img')?.naturalWidth)"),true,'hover without dragging should show a preview image');
  state.player.paused=false;window.webContents.send('cloudreel:state',state);await wait(3300);
  assert.equal(await js("document.querySelector('.cinema').classList.contains('controls-visible')"),true,'waiting over the timeline must keep preview controls visible');
  await move(rail.x+rail.width*.95,rail.y+rail.height/2);await wait(400);
  assert.equal(await js("(()=>{const r=document.querySelector('.timeline-picture').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth;})()"),true);
  await move(20,20);await wait(100);assert.equal(await js("Boolean(document.querySelector('.timeline-picture'))"),false);
  state.player.chapters=[{id:0,time:0,title:'开始'},{id:1,time:300,title:'第二章'}];state.player.markers={introEnd:60,introEndScope:'episode',creditsStart:550,creditsStartScope:'episode'};
  window.webContents.send('cloudreel:state',state);await wait(80);
  await js("document.querySelector('[aria-label=\"章节与片头片尾\"]').click()");await wait(100);
  assert.equal(await js("document.querySelectorAll('.chapter-choice').length"),2);
  assert.equal(await js("document.querySelectorAll('.timeline-section-mark').length"),2);
  await js("document.querySelector('[aria-label=\"将当前位置设为片头结束\"]').click()");await wait(80);
  assert.deepEqual(calls.shift(),{itemId:'test',scope:'episode',field:'introEnd',current:true});
  assert.equal(BrowserWindow.getAllWindows().some(w=>w.isVisible()),false);
  console.log(JSON.stringify({progressiveDisclosure:true,uprightSectionIcons:true,independentNestedChevrons:true,isolatedSettingWrites:true,styledPickerKeyboard:true,bufferedSegmentsRendered:true,narrowLayout:true,visibleWindowsOpened:0}));
  window.destroy();app.quit();
}).catch(error=>{console.error(error.stack);window?.destroy();app.exit(1);});
