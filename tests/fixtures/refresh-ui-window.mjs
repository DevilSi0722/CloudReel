import {app, BrowserWindow, ipcMain} from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {memoryStore} from '../helpers.mjs';

const root = process.env.CLOUDREEL_PACKAGE_ROOT || fileURLToPath(new URL('../../', import.meta.url));
const {LibraryScanner} = await import(pathToFileURL(path.join(root, 'electron/services/scanner.mjs')));
const {LibraryRefresh} = await import(pathToFileURL(path.join(root, 'electron/services/library-refresh.mjs')));
const {baiduItem} = await import(pathToFileURL(path.join(root, 'electron/core/media.mjs')));
const {groupLibrary} = await import(pathToFileURL(path.join(root, 'electron/core/identification.mjs')));
app.setName('CloudReel-Refresh-Regression');
app.setPath('userData', path.join(process.env.CLOUDREEL_TEST_DIRECTORY, 'profile'));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const store = memoryStore(), calls = [], listings = [];
let window, scheduler, releaseList, releasePull;
const file = {fs_id:'42', path:'/Films/Arrival.2016.mkv', server_filename:'Arrival.2016.mkv', size:1024, isdir:0};
store.data.items = [{...baiduItem(file), catalog:{source:'tmdb', id:'329865', kind:'movie', title:'降临', year:2016}}];
Object.assign(store.data.settings, {autoRefresh:false, autoScrape:true, autoNext:true, baiduMode:'web'});
const state = {settings:store.data.settings, accounts:{baidu:{connected:true, configured:true}, trakt:{connected:true, configured:true, profile:{username:'测试账号'}, sync:{positions:3, watched:5}}}, pendingCount:2,
  scrape:{running:false, done:0, total:0, tmdbConfigured:true}, runtime:{desktop:true, version:'0.3.20', mpvReady:true, windowChrome:true}, player:null};
const snapshot = () => ({...state, items:store.data.items, collections:groupLibrary(store.data.items), scan:scanner.state, scanRoots:scanner.roots(), logs:[]});
const publish = () => {if(window && !window.isDestroyed()) window.webContents.send('cloudreel:state', snapshot());};
const scanner = new LibraryScanner(store, {
  list:async directory => {listings.push(directory);await new Promise(resolve => releaseList = resolve);return {files:directory === '/Films' ? [file] : [], hasMore:false};},
  fileInfo:async () => ({fs_id:'200', path:'/Shows', isdir:1})
}, publish);
scanner.add('baidu', '/Films');

app.whenReady().then(async () => {
  ipcMain.handle('cloudreel:invoke', async (_event, method, payload) => {
    calls.push({method, payload});
    if(method === 'library:refresh') scanner.refresh();
    if(method === 'library:cancelScan') scanner.cancel();
    if(method === 'library:mountBaidu') await scanner.mountBaidu(payload);
    if(method === 'settings:save') Object.assign(state.settings, payload);
    if(method === 'trakt:pull') {
      state.accounts.trakt.sync.pulling = true;publish();
      await new Promise(resolve => releasePull = resolve);
      state.accounts.trakt.sync.pulling = false;
    }
    if(method === 'sync:retry') state.pendingCount = 0;
    if(method === 'account:disconnect') state.accounts.trakt = {connected:false, configured:true};
    publish();return {ok:true, value:snapshot()};
  });
  scheduler = new LibraryRefresh(scanner, {baiduConnected:() => true, automatic:() => state.settings.autoRefresh !== false});
  scheduler.start();
  window = new BrowserWindow({show:false, width:1440, height:1000, webPreferences:{preload:path.join(root, 'electron/preload.cjs'), contextIsolation:true, nodeIntegration:false, backgroundThrottling:false, offscreen:true}});
  for(const method of ['show', 'showInactive', 'focus']) window[method] = () => {throw new Error('visibility prohibited');};
  await window.loadFile(path.join(root, 'dist/index.html'));
  const js = async script => {try {return await window.webContents.executeJavaScript(script);} catch(error) {throw new Error(`Renderer check failed: ${script}`, {cause:error});}};
  const clickText = text => js(`Array.from(document.querySelectorAll('button')).find(b => b.textContent === ${JSON.stringify(text)}).click()`);
  const navigate = async name => {await js(`Array.from(document.querySelectorAll('.nav-item')).find(b => b.querySelector('span')?.textContent === ${JSON.stringify(name)}).click()`);await wait(100);};
  const capture = async name => {
    if(!process.env.CLOUDREEL_UI_OUTPUT) return;
    fs.mkdirSync(process.env.CLOUDREEL_UI_OUTPUT, {recursive:true});
    window.webContents.invalidate();await wait(180);
    fs.writeFileSync(path.join(process.env.CLOUDREEL_UI_OUTPUT, name), (await window.webContents.capturePage()).toPNG());
  };
  const silent = async () => {
    assert.equal(await js("Boolean(document.querySelector('.scan-strip,.busy-indicator,.toast'))"), false);
    assert.equal(await js("document.querySelector('[aria-label=\"刷新片库\"]').disabled"), false);
    assert.equal(await js("Boolean(document.querySelector('.sidebar-bottom .spin'))"), false);
  };
  await wait(150);
  assert.equal(scanner.state.background, true, 'startup is silent with periodic refresh disabled');
  await silent();assert.equal(await js("document.querySelector('.sidebar-bottom').textContent.includes('观看同步')"), false);
  await capture('refresh-background.png');
  await navigate('百度网盘');await silent();
  assert.equal(await js("document.querySelector('.view-sources').textContent.includes('正在更新')"), false);
  await navigate('设置');
  await js("Array.from(document.querySelectorAll('summary')).find(s => s.textContent.includes('海报与影片资料')).click()");
  state.scrape = {...state.scrape, running:true, background:true, total:5, done:1, current:'测试影片'};publish();await wait(80);
  await silent();assert.equal(await js("Boolean(document.querySelector('.metadata-settings .spin'))"), false);
  await js("document.querySelector('[aria-label=\"自动刷新片库\"]').click()");await wait(80);
  assert.deepEqual(calls.find(call => call.method === 'settings:save').payload, {autoRefresh:true});
  state.scrape.running = false;publish();await wait(50);
  const active = scanner.active;
  await js("document.querySelector('[aria-label=\"刷新片库\"]').click()");await wait(100);
  assert.equal(scanner.active, active);assert.equal(scanner.state.background, false);
  assert.equal(listings.length, 1, 'revealing a scan must not request the same directory twice');
  assert.equal(await js("Boolean(document.querySelector('.settings-page'))"), true, 'manual refresh preserves current page');
  assert.equal(await js("Boolean(document.querySelector('.scan-strip .spin'))"), true);
  assert.equal(await js("document.querySelector('[aria-label=\"刷新片库\"]').disabled"), true);
  await capture('refresh-visible.png');
  releaseList();await scanner.active;await wait(100);
  assert.equal(await js("Boolean(document.querySelector('.scan-strip'))"), false);
  state.scrape = {...state.scrape, running:true, background:false};publish();await wait(80);
  assert.match(await js("document.querySelector('.scan-strip').textContent"), /获取影片资料/);
  state.scrape.running = false;publish();await wait(60);

  await navigate('电影');await js("document.querySelector('[aria-label=\"降临 详情\"]').click()");await wait(100);
  scanner.refresh(undefined, {background:true});await wait(70);await silent();
  await js("document.querySelector('[aria-label=\"刷新片库\"]').click()");await wait(80);
  assert.equal(await js("Boolean(document.querySelector('.detail-content'))"), true, 'manual refresh preserves selected title');
  await js("document.querySelector('.scan-strip button').click()");await wait(50);
  assert.equal(scanner.state.cancelled, true);releaseList();await scanner.active;await wait(80);
  assert.equal(await js("Boolean(document.querySelector('.scan-strip'))"), false);

  // Initial mount still uses the same visible scanner and its stop control.
  await js("window.cloudreel.invoke('library:mountBaidu', {path:'/Shows', fsId:'200'})");await wait(80);
  assert.equal(scanner.state.background, false);
  assert.equal(await js("Boolean(document.querySelector('.scan-strip'))"), true);
  releaseList();await scanner.active;await wait(60);
  await navigate('设置');
  assert.equal(await js("document.querySelectorAll('.watch-sync-settings').length"), 1);
  assert.equal(await js("document.querySelector('.watch-sync-settings').checkVisibility()"), false);
  await clickText('管理同步2');await wait(100);
  assert.equal(await js("document.querySelector('.watch-sync-settings').closest('details').open"), true);
  assert.equal(await js("document.activeElement.tagName"), 'SUMMARY');
  for(const [width,height] of [[1440,1000], [980,760]]) {
    window.setContentSize(width,height);await wait(100);
    await js("document.querySelector('.watch-sync-settings').closest('details').scrollIntoView({block:'start'})");
    assert.equal(await js("document.querySelector('.watch-sync-settings').closest('details').querySelector('summary').getBoundingClientRect().top >= document.querySelector('.topbar').getBoundingClientRect().bottom"), true, 'sticky toolbar must not cover the opened section heading');
    assert.equal(await js('document.documentElement.scrollWidth <= innerWidth'), true);
    assert.equal(await js("Array.from(document.querySelectorAll('.watch-sync-settings button')).every(b => {const r=b.getBoundingClientRect();return r.left>=0 && r.right<=innerWidth;})"), true);
    await capture(`watch-sync-${width}.png`);
  }
  await clickText('读取进度');await wait(70);
  assert.equal(await js("Array.from(document.querySelectorAll('.watch-sync-settings button')).find(b => b.textContent === '正在读取').disabled"), true);
  releasePull();await wait(80);
  await js("document.querySelector('[aria-label=\"自动同步观看进度\"]').click()");await wait(80);
  assert.deepEqual(calls.filter(call => call.method === 'settings:save').at(-1).payload, {autoSync:false});
  await clickText('重试同步');await wait(80);
  assert.equal(state.pendingCount, 0);assert.equal(calls.some(call => call.method === 'sync:retry'), true);
  await clickText('断开 Trakt');await wait(80);
  assert.deepEqual(calls.find(call => call.method === 'account:disconnect').payload, 'trakt');
  assert.equal(await js("Array.from(document.querySelectorAll('.watch-sync-settings button')).find(b => b.textContent === '重试同步').disabled"), true);
  await clickText('登录 Trakt');await wait(80);
  assert.equal(calls.some(call => call.method === 'trakt:auth'), true);
  assert.equal(await js("Boolean(document.querySelector('[role=dialog]'))"), true);
  assert.equal(BrowserWindow.getAllWindows().some(view => view.isVisible()), false);
  console.log(JSON.stringify({silentStartup:true, manualPromotion:true, pagePreserved:true, visibleMount:true, watchSyncSettings:true, narrowLayout:true, visibleWindowsOpened:0}));
  scheduler.stop();window.destroy();app.quit();
}).catch(error => {console.error(error.stack);scheduler?.stop();window?.destroy();app.exit(1);});
