import {app, BrowserWindow, ipcMain} from 'electron';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root = process.env.CLOUDREEL_PACKAGE_ROOT || fileURLToPath(new URL('../../', import.meta.url));
app.setName('CloudReel-File-UI-Regression'); app.setPath('userData', path.join(process.env.CLOUDREEL_TEST_DIRECTORY, 'profile'));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const state = {settings: {baiduMode: 'web', autoSync: false, autoScrape: false}, accounts: {baidu: {connected: true, mode: 'web', profile: {netdisk_name: '我的网盘'}}, trakt: {connected: false}}, items: [], collections: [], logs: [], pendingCount: 0, scrape: {running: false}, scan: {running: false}, scanRoots: [{id: 'mount', source: 'baidu', fsId: '10', path: '/影视', enabled: true, count: 12}], runtime: {desktop: true, version: '0.3.21'}, player: null};
const movie = (id, name) => ({fs_id: String(id), path: '/影视/' + name, server_filename: name, size: 12 * 1024 ** 3, isdir: 0});
const files = [movie('1', '难以识别的旧名称.2160p.WEB-DL.mkv'), movie('2', '难以识别的旧名称.2160p.WEB-DL.zh-Hans.ass'), movie('3', '另一个视频.mkv')];
let window, calls = [], fail = false, releaseCommit;
app.whenReady().then(async () => {
  ipcMain.handle('cloudreel:invoke', async (_event, method, payload) => {
    calls.push({method, payload});
    if (method === 'files:browse') {
      if (fail) {fail = false; return {ok: false, error: '暂时无法读取目录'};}
      if (payload.directoryId === '11') {await wait(170); return {ok: true, value: {directory: {path: '/影视/子目录', fsId: '11'}, mountPath: '/影视', files: [], hasMore: false, nextStart: 0}};}
      return {ok: true, value: {directory: {path: '/影视', fsId: '10'}, mountPath: '/影视', files: payload.start ? [movie('4', '分页视频.mkv')] : [{fs_id: '11', server_filename: '子目录', path: '/影视/子目录', isdir: 1}, ...files], hasMore: !payload.start, nextStart: payload.start ? 400 : 200}};
    }
    if (method === 'files:preview') return {ok: true, value: {id: 'preview', action: payload.action, ready: payload.ids.length, files: payload.ids.map(id => ({fsId: id, original: files.find(file => file.fs_id === id)?.server_filename || '分页视频.mkv', name: '硅谷 - S04E03 - 2160p WEB-DL.mkv', companion: false, status: 'ready', reason: ''}))}};
    if (method === 'files:commit') {
      await new Promise(resolve => {releaseCommit = resolve;});
      return {ok: true, value: {action: 'rename', success: 1, failed: 1, results: [{fsId: '1', original: '影片.mkv', status: 'success', message: '影片 (2024).mkv'}, {fsId: '2', original: '字幕.ass', status: 'failed', message: '请刷新核对'}]}};
    }
    return {ok: true, value: state};
  });
  window = new BrowserWindow({show: false, width: 1380, height: 900, webPreferences: {preload: path.join(root, 'electron/preload.cjs'), contextIsolation: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false}});
  for (const method of ['show', 'showInactive', 'focus']) window[method] = () => {throw new Error('visibility prohibited');};
  await window.loadFile(path.join(root, 'dist/index.html'));
  const js = async code => {try {return await window.webContents.executeJavaScript(code);} catch (error) {throw new Error(code + ': ' + error.message);}};
  const until = async code => {for (let i = 0; i < 100; i++) {if (await js(code)) return; await wait(30);} throw new Error('UI timeout: ' + code);};
  const clickText = text => js(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent===${JSON.stringify(text)}).click()`);
  const shot = async name => {await wait(350); if (process.env.CLOUDREEL_UI_OUTPUT) {fs.mkdirSync(process.env.CLOUDREEL_UI_OUTPUT, {recursive: true}); fs.writeFileSync(path.join(process.env.CLOUDREEL_UI_OUTPUT, name + '.png'), (await window.webContents.capturePage()).toPNG());}};
  await until('document.querySelectorAll(".nav-item").length>0'); await clickText('百度网盘'); await until('!!document.querySelector(".mount-manage")');
  assert.equal(calls.some(call => call.method === 'files:browse'), false, 'mount landing does not enumerate');
  await js('document.querySelector(".mount-manage").click()'); await until('document.querySelectorAll(".file-row").length===4');
  await shot('file-browser');
  await js('document.querySelector(".file-directory").click()'); await wait(25); await js('document.querySelector("[aria-label=返回上级文件夹]").click()');
  await until('document.querySelectorAll(".file-row").length===4'); await wait(200); assert.equal(await js('document.querySelectorAll(".file-row").length'), 4, 'late child reply ignored');
  await js('document.querySelector(".file-row input").click()'); await clickText('重命名'); await until('!!document.querySelector(".file-operation")');
  assert.equal(calls.some(call => call.method === 'files:commit'), false);
  await clickText('预览更改'); await until('!!document.querySelector(".file-plan-list")'); await shot('rename-preview');
  await js(`{let select=document.querySelector('[aria-label="重命名方式"]');select.value='replace';select.dispatchEvent(new Event('change',{bubbles:true}));}`);
  await until('!!document.querySelector("[aria-label=查找文字]")'); assert.equal(await js('!!document.querySelector(".file-plan-list")'), false, 'changing rule invalidates preview');
  await js(`{let input=document.querySelector('[aria-label="查找文字"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'旧');input.dispatchEvent(new Event('input',{bubbles:true}));}`);
  await clickText('预览更改'); await until('!!document.querySelector(".file-plan-list")');
  await js('document.querySelector(".file-operation-footer .primary").click()'); await until('document.querySelector(".file-operation-footer .primary").disabled');
  assert.equal(await js('document.querySelector(".file-operation [aria-label=关闭窗口]").disabled'), true);
  await js('window.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape"}))'); await wait(300); assert.equal(await js('!!document.querySelector(".file-operation")'), true, 'busy dialog cannot disappear');
  releaseCommit(); await until('document.querySelector(".file-operation").textContent.includes("文件处理结果")');
  await shot('file-results'); await clickText('完成'); await until('!document.querySelector(".file-operation")');
  await until('document.querySelectorAll(".file-row input").length===3');
  await js('document.querySelector("[aria-label=全选已显示文件]").click()'); await clickText('删除'); await until('!!document.querySelector(".file-operation")');
  assert.match(await js('document.querySelector(".file-delete-explanation").textContent'), /网盘中的原文件/);
  await clickText('预览删除文件'); await until('!!document.querySelector(".file-operation-footer .destructive")');
  assert.equal(calls.filter(call => call.method === 'files:commit').length, 1, 'delete remains preview until explicit confirmation');
  await shot('delete-preview');
  for (const [width, height] of [[980, 680], [1440, 1000]]) {
    window.setContentSize(width, height); await wait(80);
    assert.equal(await js('document.documentElement.scrollWidth<=innerWidth'), true);
    assert.equal(await js('{const r=document.querySelector(".file-operation").getBoundingClientRect();r.top>=0&&r.bottom<=innerHeight&&r.left>=0&&r.right<=innerWidth}'), true);
  }
  await clickText('取消'); await until('!document.querySelector(".file-operation")'); await js('document.querySelector("[aria-label=取消文件选择]").click()');
  await clickText('加载更多文件'); await until('document.querySelectorAll(".file-row input").length===4');
  assert.equal(calls.filter(call => call.method === 'files:browse').at(-1).payload.start, 200);
  fail = true; await js('document.querySelector("[aria-label=刷新文件列表]").click()'); await until('!!document.querySelector(".file-list [role=alert]")'); await clickText('重试'); await until('document.querySelectorAll(".file-row").length===4');
  assert.equal(BrowserWindow.getAllWindows().some(view => view.isVisible()), false);
  console.log(JSON.stringify({selection:true,previewRequired:true,invalidatedPreview:true,busyDismissBlocked:true,partialResults:true,deleteConfirmation:true,pagination:true,narrowLayout:true,visibleWindowsOpened:0}));
  window.destroy(); app.quit();
}).catch(error => {console.error(error.stack); window?.destroy(); app.exit(1);});
