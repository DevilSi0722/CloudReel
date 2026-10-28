import {app, BrowserWindow, ipcMain} from 'electron';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {groupLibrary} from '../../electron/core/identification.mjs';
import {versionKey} from '../../electron/core/versions.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
app.setName('CloudReel-Details-Regression');
app.setPath('userData', path.join(process.env.CLOUDREEL_TEST_DIRECTORY, 'profile'));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const image = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720"><defs><linearGradient id="g"><stop stop-color="#343f50"/><stop offset="1" stop-color="#171923"/></linearGradient></defs><path fill="url(#g)" d="M0 0h1280v720H0z"/><circle cx="800" cy="300" r="240" fill="#a7b4d4" opacity=".16"/></svg>');
const catalog = {source:'tmdb', id:'71', kind:'episode', title:'群山之间', originalTitle:'Between the Mountains', year:2025, poster:image, backdrop:image, overview:'一部用于验证选集和简介阅读的独立测试剧集。', genres:['剧情'], rating:8.4};
const synopsis = '一封迟来的信打破了小镇平静的生活，主人公沿着山间小路寻找失散多年的朋友，却在旅途中发现了被隐瞒的往事。每一次相遇都让真相更加清晰，也让他们重新理解亲情与选择。'.repeat(4);
catalog.overview=synopsis;
const make = (id, season, episode, width=1920) => ({id, season, episode, kind:'episode', title:catalog.title, seriesTitle:catalog.title, catalog, source:'baidu', fsId:id, path:`/fixture/${id}.mkv`, filename:`${id}.mkv`, size:width*1024**2, addedAt:'2026-10-28', episodeMetadata:{title:`山间故事 ${episode}`, overview:episode===2 ? '短简介。' : synopsis, runtime:45, still:image}, technical:{verified:true, width, height:width*9/16, dynamicRange:width===3840 ? 'HDR10' : 'SDR', audio:width===3840 ? 'eac3' : 'aac', duration:width===3840 ? 3600 : 2700, fileSize:width*1024**2}});
// Scrambled order and recent progress must not change the default first episode.
const first=make('s1e1',1,1), second=make('s1e2',1,2), last=make('s1e12',1,12), alternative=make('s1e1-4k',1,1,3840), special=make('special',0,1), nextSeason=make('s2e1',2,1);
last.progress={position:1400,duration:2700,percent:52,updatedAt:'2026-10-28T01:00:00Z'};
const unavailable=make('s2e2',2,2);unavailable.unavailable=true;
const state={settings:{autoSync:false,autoScrape:false,autoNext:false}, accounts:{baidu:{connected:false},trakt:{connected:false}}, items:[last,special,alternative,second,nextSeason,first,unavailable], collections:[], logs:[], pendingCount:0, mediaProbes:{}, scrape:{running:false}, scan:{running:false}, scanRoots:[], runtime:{desktop:true,version:'0.3.18',mpvReady:true}, player:null};
first.versionPreferred=true;
const calls=[];
let window;
app.whenReady().then(async()=>{
  const send=()=>{state.collections=groupLibrary(state.items);window?.webContents.send('cloudreel:state',state);return {ok:true,value:state};};
  ipcMain.handle('cloudreel:invoke',(_event,method,payload)=>{
    calls.push({method,payload});
    if(method==='library:version') for(const item of state.items) if(versionKey(item)===versionKey(state.items.find(item=>item.id===payload))) item.versionPreferred=item.id===payload;
    state.collections=groupLibrary(state.items);
    return method==='state' || method==='library:version' || method==='media:probe' ? send() : {ok:true};
  });
  window=new BrowserWindow({show:false,width:1440,height:1100,webPreferences:{preload:path.join(root,'electron/preload.cjs'),contextIsolation:true,nodeIntegration:false,backgroundThrottling:false,offscreen:true}});
  for(const method of ['show','showInactive','focus']) window[method]=()=>{throw new Error('visibility prohibited');};
  await window.loadFile(path.join(root,'dist/index.html'));
  const web=window.webContents,js=code=>web.executeJavaScript(code);
  web.debugger.attach('1.3');await web.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true});
  await wait(160);
  const open=async()=>{await js("document.querySelector('.collection-poster').click()");await wait(200);};
  const selectedLabel=()=>js("document.querySelector('[aria-label=\"当前选集\"]').textContent");
  const facts=()=>js("Array.from(document.querySelectorAll('.title-media-facts dd')).map(e=>e.textContent)");
  const playCount=()=>calls.filter(call=>call.method==='player:play').length;
  const choose=async index=>{await js(`document.querySelectorAll('.episode-still')[${index}].click()`);await wait(100);};
  const season=async n=>{await js(`(()=>{const s=document.querySelector('[aria-label="选择季数"]');s.value='${n}';s.dispatchEvent(new Event('change',{bubbles:true}));})()`);await wait(120);};
  await open();
  assert.match(await selectedLabel(),/第 1 季 · 第 1 集/);
  assert.equal(await js("document.querySelectorAll('.episode-card').length"),3,'duplicate versions render as a single logical episode');
  assert.equal(await js("document.querySelector('.episode-still').getAttribute('aria-pressed')"),'true');
  assert.deepEqual(await facts(),['1080P','SDR','AAC','45 分钟','1.9 GB']);
  assert.equal(await js("document.querySelectorAll('.episode-links,.episode-caption select,.episode-caption .still-play').length"),0);
  assert.equal(await js("Array.from(document.querySelectorAll('.episode-caption button')).some(b=>/标记|媒体信息|修正|Trakt/.test(b.textContent))"),false);
  assert.equal(playCount(),0);
  assert.equal(calls.filter(call=>call.method==='media:probe').at(-1).payload.id,first.id);
  // Both the image and title select; neither path sends a playback command.
  await choose(1);assert.match(await selectedLabel(),/第 2 集/);assert.equal(playCount(),0);
  assert.equal(calls.filter(call=>call.method==='media:probe').at(-1).payload.id,second.id);
  await js("document.querySelectorAll('.episode-title')[2].click()");await wait(100);
  assert.match(await selectedLabel(),/第 12 集/);assert.equal(playCount(),0);
  await js("document.querySelector('.detail-buttons .primary').click()");await wait(40);
  assert.deepEqual(calls.filter(call=>call.method==='player:play').at(-1).payload,{id:last.id});
  // Background progress and unrelated probe results must not steal selection.
  second.technical={...second.technical,width:3840,height:2160,dynamicRange:'HDR10'};last.watchHistory={watched:true,checkedAt:new Date().toISOString()};send();await wait(100);
  assert.match(await selectedLabel(),/第 12 集/);assert.deepEqual(await facts(),['1080P','SDR','AAC','45 分钟','1.9 GB']);
  for(const item of state.items)item.catalog={...catalog,id:'new-metadata-identity'};
  send();await wait(100);assert.match(await selectedLabel(),/第 12 集/,'late metadata identity must not reset selection');
  await choose(0);
  await js("(()=>{const s=document.querySelector('.title-copy .version-select select');s.value='s1e1-4k';s.dispatchEvent(new Event('change',{bubbles:true}));})()");await wait(100);
  assert.deepEqual(await facts(),['2160P','HDR10','DDP','1 小时','3.8 GB']);
  assert.match(await selectedLabel(),/第 1 集/);
  assert.equal(calls.filter(call=>call.method==='media:probe').at(-1).payload.id,alternative.id);
  await js("document.querySelector('.detail-buttons .primary').click()");await wait(40);
  assert.deepEqual(calls.filter(call=>call.method==='player:play').at(-1).payload,{id:alternative.id});
  await season(2);assert.match(await selectedLabel(),/第 2 季 · 第 1 集/);
  await choose(1);assert.match(await selectedLabel(),/暂不可用/);
  assert.equal(await js("document.querySelector('.detail-buttons .primary').disabled"),true);
  await season(0);assert.match(await selectedLabel(),/特别篇 · 第 1 集/);
  await season(1);await choose(1);
  // Reading full overviews is modal: no reflow, episode selection or playback.
  const count=playCount();
  const geometry=()=>js("Array.from(document.querySelectorAll('.detail-hero,.episode-card,.episodes-section')).map(e=>{const r=e.getBoundingClientRect();return [r.x,r.y,r.width,r.height]})");
  assert.equal(await js("document.querySelectorAll('.episode-card')[1].querySelector('.overview-more')===null"),true);
  const before=await geometry();
  for(const selector of ['.title-overview .overview-more','.episode-overview .overview-more']) {
    await js(`document.querySelector('${selector}').click()`);await wait(250);
    assert.match(await selectedLabel(),/第 2 集/);assert.equal(playCount(),count);
    assert.equal(await js("document.querySelector('.synopsis-full').textContent"),synopsis);
    assert.deepEqual(await geometry(),before,'dialog never moves the underlying layout');
    assert.equal(await js("(()=>{const d=document.querySelector('.synopsis-dialog'),p=d.querySelector('.synopsis-full');return p.scrollHeight>=p.clientHeight && d.clientHeight<=innerHeight-60})()"),true);
    // Clicking the content stays open; clicking only the backdrop dismisses.
    await js("document.querySelector('.synopsis-full').dispatchEvent(new MouseEvent('mousedown',{bubbles:true}))");
    assert.equal(await js("Boolean(document.querySelector('.synopsis-dialog'))"),true);
    await js("document.querySelector('.modal-backdrop').dispatchEvent(new MouseEvent('mousedown',{bubbles:true}))");await wait(190);
    assert.equal(await js("document.querySelector('[role=dialog]')===null"),true);
    assert.deepEqual(await geometry(),before);
  }
  // A one-line overview reserves the same two-line space as a long overview.
  const heroHeight=await js("document.querySelector('.detail-hero').clientHeight");
  for(const item of state.items)item.catalog={...item.catalog,overview:'短简介。'};
  send();await wait(100);
  assert.equal(await js("document.querySelector('.title-overview .overview-more')===null"),true);
  assert.equal(await js("document.querySelector('.detail-hero').clientHeight"),heroHeight);
  for(const item of state.items)item.catalog={...item.catalog,overview:synopsis};send();await wait(100);
  await js("document.querySelector('.title-overview .overview-more').click()");await wait(240);
  await js("window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");await wait(180);
  assert.equal(await js("document.querySelector('[role=dialog]')===null"),true);
  // Hidden-in-menu correction operates on the selected episode, not the latest watched one.
  await js("document.querySelector('[aria-label=\"影片更多操作\"]').click()");await wait(60);
  await js("Array.from(document.querySelectorAll('[role=menuitem]')).find(b=>b.textContent==='修正所选分集').click()");await wait(200);
  const fields=await js("Array.from(document.querySelectorAll('.episode-fields input')).map(i=>i.value)");assert.deepEqual(fields,['1','2']);
  await js("document.querySelector('[aria-label=\"关闭窗口\"]').click()");await wait(180);
  for(const [width,height,scale] of [[980,680,1],[1440,900,1],[1920,1080,1.25],[2560,1440,1],[3840,2160,1.5]]) {
    await web.debugger.sendCommand('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:scale,mobile:false});await wait(100);
    assert.equal(await js('document.documentElement.scrollWidth<=innerWidth'),true,`no overflow at ${width}`);
    assert.equal(await js("(()=>{const p=document.querySelector('.episode-overview p'),s=getComputedStyle(p);return Math.abs(p.clientHeight/parseFloat(s.lineHeight)-2)<.1;})()"),true,'collapsed synopsis shows complete lines');
    assert.equal(await js("(()=>{const p=document.querySelector('.title-overview p');return Math.abs(p.clientHeight/parseFloat(getComputedStyle(p).lineHeight)-2)<.1})()"),true,'hero reserves exactly two lines');
    await js("document.querySelector('.title-overview .overview-more').click()");await wait(240);
    assert.equal(await js("(()=>{const r=document.querySelector('.synopsis-dialog').getBoundingClientRect();return r.left>=0 && r.right<=innerWidth && r.top>=0 && r.bottom<=innerHeight})()"),true,'dialog fits viewport');
    await js("document.querySelector('[aria-label=\"关闭窗口\"]').click()");await wait(180);
  }
  if(process.env.CLOUDREEL_UI_OUTPUT) {
    await web.debugger.sendCommand('Emulation.setDeviceMetricsOverride',{width:1920,height:1250,deviceScaleFactor:1,mobile:false});await wait(140);
    fs.mkdirSync(process.env.CLOUDREEL_UI_OUTPUT,{recursive:true});web.invalidate();await wait(120);
    fs.writeFileSync(path.join(process.env.CLOUDREEL_UI_OUTPUT,'episode-details.png'),(await web.capturePage()).toPNG());
    await js("document.querySelector('.episode-overview .overview-more').click()");await wait(250);web.invalidate();await wait(80);
    fs.writeFileSync(path.join(process.env.CLOUDREEL_UI_OUTPUT,'episode-overview-dialog.png'),(await web.capturePage()).toPNG());
    await js("document.querySelector('[aria-label=\"关闭窗口\"]').click()");await wait(180);
  }
  await js("document.querySelector('.back-link').click()");await wait(100);await open();
  assert.match(await selectedLabel(),/第 1 季 · 第 1 集/);
  // Both continue-watching detail entry points use the displayed resume episode.
  for(const selector of ['.continue-details','.continue-caption']) {
    await js("document.querySelector('.back-link').click()");await wait(160);
    const beforePlay=playCount();
    await js(`document.querySelector('${selector}').click()`);await wait(200);
    assert.match(await selectedLabel(),/第 1 季 · 第 12 集/);assert.equal(playCount(),beforePlay);
    assert.equal(calls.filter(call=>call.method==='media:probe').at(-1).payload.id,last.id);
    await choose(1);send();await wait(80);assert.match(await selectedLabel(),/第 2 集/,'later state does not restore the initial resume selection');
  }
  nextSeason.progress={position:200,duration:2700,percent:7,updatedAt:'2026-10-29T01:00:00Z'};send();await wait(80);
  await js("document.querySelector('.back-link').click()");await wait(160);
  await js("document.querySelector('.continue-play').click()");await wait(50);
  assert.deepEqual(calls.filter(call=>call.method==='player:play').at(-1).payload,{id:nextSeason.id});
  await js("document.querySelector('.continue-details').click()");await wait(200);
  assert.match(await selectedLabel(),/第 2 季 · 第 1 集/,'resume entry also opens the correct season');
  delete nextSeason.progress;send();await wait(80);
  await js("document.querySelector('.back-link').click()");await wait(160);await open();
  assert.match(await selectedLabel(),/第 1 季 · 第 1 集/,'ordinary library entry still defaults to the first episode');
  // Removal is resolved to an existing episode, never to a stale file ID.
  state.items=state.items.filter(item=>item.id!==first.id && item.id!==alternative.id);send();await wait(100);
  assert.match(await selectedLabel(),/第 2 集/);
  await js("document.querySelector('.episode-card').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:500,clientY:500}))");await wait(50);
  await js("Array.from(document.querySelectorAll('[role=menuitem]')).find(b=>b.textContent==='标记为未观看').click()");await wait(160);
  assert.deepEqual(calls.filter(call=>call.method==='library:watch').at(-1).payload,{ids:[second.id],watched:false},'episode watch marking stays available in the context menu');
  // A film still respects the chosen version, with low-frequency actions in one menu.
  const film=make('film',1,1),film4k=make('film-4k',1,1,3840);
  for(const item of [film,film4k]){item.kind='movie';item.title='归途';item.catalog={...catalog,id:'film',kind:'movie',title:item.title};delete item.episodeMetadata;}
  film4k.versionPreferred=true;state.items.push(film,film4k);send();await wait(80);
  await js("document.querySelector('.back-link').click()");await wait(100);
  await js("document.querySelector('[aria-label=\"归途 详情\"]').click()");await wait(180);
  assert.equal(await js("document.querySelector('.episode-grid')===null"),true);
  assert.deepEqual(await facts(),['2160P','HDR10','DDP','1 小时','3.8 GB']);
  await js("document.querySelector('.detail-buttons .primary').click()");await wait(40);
  assert.deepEqual(calls.filter(call=>call.method==='player:play').at(-1).payload,{id:film4k.id});
  await js("document.querySelector('[aria-label=\"影片更多操作\"]').click()");await wait(50);
  await js("Array.from(document.querySelectorAll('[role=menuitem]')).find(b=>b.textContent==='从头播放').click()");await wait(160);
  assert.deepEqual(calls.filter(call=>call.method==='player:play').at(-1).payload,{id:film4k.id,fromBeginning:true});
  assert.equal(BrowserWindow.getAllWindows().some(view=>view.isVisible()),false);
  console.log(JSON.stringify({firstEpisodeDefault:true,resumeEntryEpisodeAndSeason:true,selectionDoesNotPlay:true,selectedMediaAndVersion:true,seasonSelection:true,twoLineSynopsis:true,synopsisDialogWithoutReflow:true,selectedPlayback:true,visibleWindowsOpened:0}));
  window.destroy();app.quit();
}).catch(error=>{console.error(error.stack);window?.destroy();app.exit(1);});
