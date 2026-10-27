import {app,BrowserWindow,ipcMain} from 'electron';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('../../',import.meta.url));
app.setName('CloudReel-Motion-Regression');
app.setPath('userData',path.join(process.env.CLOUDREEL_TEST_DIRECTORY,'profile'));
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const image=n=>'data:image/svg+xml,'+encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720"><defs><linearGradient id="g"><stop stop-color="${['#304c65','#51435e','#3d574b','#705441','#455176'][n%5]}"/><stop offset="1" stop-color="#15191f"/></linearGradient></defs><path fill="url(#g)" d="M0 0h1280v720H0z"/><circle cx="880" cy="300" r="210" fill="#d6dee4" opacity=".14"/></svg>`);
const catalog=n=>({source:'tmdb',id:String(n+1),kind:'movie',title:`影片 ${n+1}`,poster:image(n),backdrop:image(n),overview:'这是用于检查视觉稳定性的独立测试片库。',rating:8,genres:['剧情']});
const state={settings:{autoSync:false,autoScrape:false,autoNext:false},accounts:{baidu:{connected:false},trakt:{connected:false}},items:[],collections:[],logs:[],pendingCount:0,
  scrape:{running:false},scan:{running:false},scanRoots:[],runtime:{desktop:true,version:'0.3.18',mpvReady:true},player:null};
for(let n=0;n<5;n++) {
  const id=String(n+1),data=catalog(n);
  state.items.push({id,title:data.title,kind:'movie',source:'local',filename:'fixture.mkv',path:'fixture.mkv',size:1,catalog:data,addedAt:'2026-10-27'});
  state.collections.push({id,title:data.title,kind:'movie',itemIds:[id],seasons:[],catalog:data,addedAt:'2026-10-27'});
}
let window;
app.whenReady().then(async()=>{
  ipcMain.handle('cloudreel:invoke',()=>({ok:true,value:state}));
  window=new BrowserWindow({show:false,width:1440,height:1100,webPreferences:{preload:path.join(root,'electron/preload.cjs'),contextIsolation:true,nodeIntegration:false,backgroundThrottling:false,offscreen:true}});
  for(const method of ['show','showInactive','focus']) window[method]=()=>{throw new Error('visibility prohibited');};
  await window.loadFile(path.join(root,'dist/index.html'));
  const web=window.webContents,js=async code=>{try {return await web.executeJavaScript(code);} catch(error) {throw new Error(error.message+' in '+code.slice(0,180));}};
  web.debugger.attach('1.3');
  await web.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true});
  const media=async value=>web.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value}]});
  await media('no-preference');await wait(250);
  await js("(()=>{window.__pageMotions=[];const animate=Element.prototype.animate;Element.prototype.animate=function(frames,options){const result=animate.call(this,frames,options);if(options?.id==='cloudreel-page-reveal')window.__pageMotions.push(result);return result;};window.__bounds=selector=>{const r=document.querySelector(selector).getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};};})()");
  const bounds=selector=>js(`window.__bounds(${JSON.stringify(selector)})`);
  const move=(x,y)=>web.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseMoved',x,y});
  const mouse=(type,x,y)=>web.debugger.sendCommand('Input.dispatchMouseEvent',{type,x,y,button:'left',clickCount:1});
  const navigate=async label=>{await js(`Array.from(document.querySelectorAll('.nav-item')).find(b=>b.querySelector('span')?.textContent===${JSON.stringify(label)}).click()`);};
  const stableStyle=selector=>js(`(()=>{const s=getComputedStyle(document.querySelector(${JSON.stringify(selector)}));return [s.transform,s.scale,s.translate];})()`);
  const assertInPlace=async selector=>assert.deepEqual(await stableStyle(selector),['none','none','none'],`${selector} must not move or scale text or hit targets`);
  // The visual card tilts, but its button and caption remain identical before
  // hover, at opposite corners and while pressed. Illumination follows input.
  const poster=await bounds('.collection-poster'),caption=await bounds('.collection-caption');
  await move(poster.x+poster.width/2,poster.y+poster.height/2);await wait(240);
  assert.deepEqual(await bounds('.collection-poster'),poster);assert.deepEqual(await bounds('.collection-caption'),caption);
  await assertInPlace('.collection-poster');
  assert.ok(await js("new DOMMatrix(getComputedStyle(document.querySelector('.poster-art>img')).transform).a>1"));
  for(const [x,y] of [[.18,.18],[.82,.82],[.5,.5]]) {
    await move(poster.x+poster.width*x,poster.y+poster.height*y);await wait(210);
    const tilt=await js("(()=>{const element=document.querySelector('.dimensional-poster'),s=element.style;return {active:element.dataset.tilting,x:parseFloat(s.getPropertyValue('--tilt-x')),y:parseFloat(s.getPropertyValue('--tilt-y')),lightX:parseFloat(s.getPropertyValue('--poster-light-x')),lightY:parseFloat(s.getPropertyValue('--poster-light-y')),surface:getComputedStyle(element.querySelector('.poster-surface')).transform,glow:Number(getComputedStyle(element.querySelector('.poster-light')).opacity)};})()");
    assert.equal(tilt.active,'true');assert.ok(Math.abs(tilt.x)<=4 && Math.abs(tilt.y)<=4);
    assert.ok(Math.abs(tilt.x-(.5-y)*8)<.1 && Math.abs(tilt.y-(x-.5)*8)<.1,'opposite corners must tilt in opposite directions');
    assert.ok(Math.abs(tilt.lightX-x*100)<1 && Math.abs(tilt.lightY-y*100)<1,'soft light must follow the pointer');
    assert.notEqual(tilt.surface,'none');assert.ok(tilt.glow>.8);
    assert.deepEqual(await bounds('.collection-poster'),poster);assert.deepEqual(await bounds('.collection-caption'),caption);
  }
  await mouse('mousePressed',poster.x+poster.width/2,poster.y+poster.height/2);await wait(70);
  assert.deepEqual(await bounds('.collection-poster'),poster);assert.deepEqual(await bounds('.collection-caption'),caption);await assertInPlace('.collection-poster');
  await move(8,8);await mouse('mouseReleased',8,8);
  await wait(460);
  assert.equal(await js("document.querySelector('.dimensional-poster').hasAttribute('data-tilting')"),false);
  assert.equal(await js("new DOMMatrix(getComputedStyle(document.querySelector('.poster-surface')).transform).isIdentity"),true);
  assert.equal(await js("Number(getComputedStyle(document.querySelector('.poster-light')).opacity)"),0);
  await js("document.querySelector('.dimensional-poster').dispatchEvent(new PointerEvent('pointermove',{bubbles:true,pointerType:'touch',clientX:300,clientY:800}))");await wait(40);
  assert.equal(await js("document.querySelector('.dimensional-poster').hasAttribute('data-tilting')"),false,'touch must not start pointer-driven motion');
  // A menu is already at the correct anchor while it fades, and a state push
  // cannot replay its entrance or make its label jump.
  await js("document.querySelector('.collection-card .library-more').click()");await wait(20);
  const menu=await bounds('.library-menu');await assertInPlace('.library-menu');
  await js("window.__menuMotion=document.querySelector('.library-menu').getAnimations()[0]");
  web.send('cloudreel:state',state);await wait(160);
  assert.deepEqual(await bounds('.library-menu'),menu);
  assert.equal(await js("document.querySelector('.library-menu').getAnimations()[0]===window.__menuMotion || !document.querySelector('.library-menu').getAnimations().length"),true);
  await js("window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))");await wait(160);
  // Long and short pages reveal at the final coordinates, without screenshot
  // size interpolation, and rapid navigation cancels the previous reveal.
  await navigate('设置');await wait(30);
  await js("window.__pageMotions.at(-1).pause();window.__pageMotions.at(-1).currentTime=0");
  const heading=await bounds('.content h1');
  for(const time of [60,120,180]) {
    await js(`window.__pageMotions.at(-1).currentTime=${time}`);
    assert.deepEqual(await bounds('.content h1'),heading);await assertInPlace('.content');
  }
  await navigate('电影');await navigate('设置');await navigate('电影');await wait(30);
  assert.equal(await js("document.querySelectorAll('.content').length"),1);
  assert.equal(await js("document.querySelector('.content h1').textContent"),'电影');
  assert.ok(await js("window.__pageMotions.filter(a=>['running','paused'].includes(a.playState)).length<=1"));
  // Reserving the detail title-art slot prevents late artwork from squeezing
  // the ordinary title or pushing the description and buttons down.
  await js("document.querySelector('[aria-label=\"影片 1 详情\"]').click()");await wait(220);
  const title=await bounds('.title-copy h1'),facts=await bounds('.title-media-facts');
  state.items[0].catalog.logo=image(1);state.collections[0].catalog.logo=image(1);
  web.send('cloudreel:state',state);await wait(100);
  assert.deepEqual(await bounds('.title-copy h1'),title);assert.deepEqual(await bounds('.title-media-facts'),facts);
  // Settings expand once at their final height; neighbouring labels do not
  // slide repeatedly while the content height is being interpolated.
  await navigate('设置');await wait(220);
  await js("document.querySelector('.settings-disclosure>summary').click()");await wait(20);
  const sibling=await bounds('.settings-disclosure:nth-of-type(2)');await wait(220);
  assert.deepEqual(await bounds('.settings-disclosure:nth-of-type(2)'),sibling);
  // Rotation belongs to the disclosure glyph, not the summary text.
  await assertInPlace('.settings-disclosure>summary');
  // Reduced Motion disables camera drift and poster zoom, and navigation
  // remains immediate. Normal state pushes never create a page animation.
  await media('reduce');await navigate('现在观看');await wait(100);
  const animations=await js('window.__pageMotions.length');
  await navigate('电影');await wait(30);
  assert.equal(await js('window.__pageMotions.length'),animations);
  const stillPoster=await bounds('.collection-poster');await move(stillPoster.x+20,stillPoster.y+20);await wait(100);
  assert.equal(await js("getComputedStyle(document.querySelector('.poster-art>img')).transform"),'none');
  assert.equal(await js("getComputedStyle(document.querySelector('.poster-surface')).transform"),'none');
  assert.equal(await js("document.querySelector('.dimensional-poster').hasAttribute('data-tilting')"),false);
  await media('no-preference');await navigate('现在观看');await wait(240);
  const active=await js("document.querySelector('.featured-slide.is-active').getAttribute('aria-label')");
  await js("document.querySelector('[aria-label=\"下一部精选\"]').click()");await wait(60);
  assert.notEqual(await js("document.querySelector('.featured-slide.is-active').getAttribute('aria-label')"),active);
  await assertInPlace('.featured-slide.is-active .featured-copy');
  const featured=await bounds('.featured-slide.is-active .featured-title');
  web.send('cloudreel:state',state);await wait(100);
  assert.deepEqual(await bounds('.featured-slide.is-active .featured-title'),featured);
  const output=process.env.CLOUDREEL_UI_OUTPUT;
  // Reproduce the reported combination: large title art, long Chinese
  // overview, constrained card height, and Windows display scaling.
  const titleLogo='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="220"><path d="M0 8H1000M0 210H1000" stroke="#c3a96a" stroke-width="4"/><text x="10" y="160" fill="#e8d19c" font-family="Microsoft YaHei" font-size="138">风格化标题样本</text></svg>');
  for(const item of state.collections) item.catalog.overview='卢浮宫博物馆馆长被人杀害在卢浮宫内，临死前他费力地留下骇人的符号。面对难以解释的线索，研究者循着历史、艺术与秘密寻找真相。'.repeat(12);
  for(const item of state.items) item.catalog.overview=state.collections[0].catalog.overview;
  let mostLines=0,leastLines=5;
  for(const artwork of [false,true]) {
    for(const item of state.collections) {item.title='风格化标题样本与一段较长的影片名称';item.catalog.logo=artwork?titleLogo:undefined;}
    web.send('cloudreel:state',state);await wait(100);
    for(const [width,height,scale] of [[980,680,1],[1100,760,1],[1280,800,1.25],[1440,900,1],[1920,1080,1.25],[2560,1440,1],[3840,2160,1.5]]) {
      await web.debugger.sendCommand('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:scale,mobile:false});await wait(110);
      const layout=await js("(()=>{const root=document.querySelector('.featured'),copy=document.querySelector('.featured-slide.is-active .featured-copy'),p=copy.querySelector('p'),button=copy.querySelector('button'),title=copy.querySelector('h2'),s=getComputedStyle(p),r=p.getBoundingClientRect(),c=copy.getBoundingClientRect(),b=button.getBoundingClientRect(),t=title.getBoundingClientRect();return {lines:Number(s.webkitLineClamp),lineHeight:parseFloat(s.lineHeight),height:r.height,clamped:p.scrollHeight>p.clientHeight,overlap:r.bottom>b.top || t.bottom>r.top,inside:r.bottom<=c.bottom && b.bottom<=c.bottom && t.top>=c.top,navOverlap:b.bottom>document.querySelector('.featured-navigation').getBoundingClientRect().top,fullText:p.textContent.length>125,overflow:document.documentElement.scrollWidth>innerWidth};})()");
      assert.ok(layout.lines>=1 && layout.lines<=4,`sensible complete lines at ${width}/${scale}`);
      assert.ok(Math.abs(layout.height/layout.lineHeight-Math.round(layout.height/layout.lineHeight))<.02,`no half-cut line at ${width}/${scale}: ${JSON.stringify(layout)}`);
      assert.equal(layout.clamped,true);assert.equal(layout.overlap,false);assert.equal(layout.inside,true);assert.equal(layout.navOverlap,false);
      assert.equal(layout.fullText,true);assert.equal(layout.overflow,false);
      mostLines=Math.max(mostLines,layout.lines);leastLines=Math.min(leastLines,layout.lines);
      if(output && artwork && [980,1920].includes(width)) {fs.mkdirSync(output,{recursive:true});web.invalidate();await wait(120);fs.writeFileSync(path.join(output,`featured-${width}.png`),(await web.capturePage()).toPNG());}
    }
  }
  assert.ok(mostLines>leastLines,'larger compositions should reveal additional complete overview lines');
  await web.debugger.sendCommand('Emulation.clearDeviceMetricsOverride');await wait(100);
  // An OS preference change while hovering resets an active card immediately.
  await js("document.querySelector('.collection-poster').scrollIntoView({block:'center'})");await wait(60);
  const finalPoster=await bounds('.collection-poster');
  await move(finalPoster.x+finalPoster.width*.8,finalPoster.y+finalPoster.height*.2);await wait(200);
  assert.equal(await js("document.querySelector('.dimensional-poster').hasAttribute('data-tilting')"),true);
  if(output) {web.invalidate();await wait(100);fs.writeFileSync(path.join(output,'poster-tilt.png'),(await web.capturePage()).toPNG());}
  await media('reduce');await wait(40);
  assert.equal(await js("document.querySelector('.dimensional-poster').hasAttribute('data-tilting')"),false);
  assert.equal(await js("getComputedStyle(document.querySelector('.poster-surface')).transform"),'none');
  assert.equal(BrowserWindow.getAllWindows().some(view=>view.isVisible()),false);
  console.log(JSON.stringify({stablePosterCaptions:true,directionalTiltAndLight:true,completeAdaptiveOverviewLines:true,anchoredMenus:true,stationaryPageText:true,lateTitleArtStable:true,reducedMotion:true,visibleWindowsOpened:0}));
  window.destroy();app.quit();
}).catch(error=>{console.error(error.stack);window?.destroy();app.exit(1);});
