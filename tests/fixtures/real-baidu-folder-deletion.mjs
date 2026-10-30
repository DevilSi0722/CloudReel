// Remote writes are limited to a new, ID-verified directory under the user's
// previously authorized /CloudReel-SeedHub-Test. Originals are only read.
import {app, BrowserWindow} from 'electron';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {memoryStore} from '../helpers.mjs';
const root = process.env.CLOUDREEL_PACKAGE_ROOT || fileURLToPath(new URL('../../', import.meta.url));
const load = relative => import(pathToFileURL(path.join(root, 'electron', relative)).href);
const {createBaiduLogin} = await load('services/baidu-login.mjs');
const {FileManagementService} = await load('services/file-management.mjs');
const {LibraryScanner} = await load('services/scanner.mjs');
const {groupLibrary} = await load('core/identification.mjs');
const {baiduItem} = await load('core/media.mjs');
const {PlayerService, discoverMpv} = await load('services/player.mjs');
const {NativeVideoHost} = await load('services/native-video.mjs');
const TARGET = '/CloudReel-SeedHub-Test', tag = 'CloudReel-0322-' + randomUUID().slice(0, 8), target = TARGET + '/' + tag;
const resources = process.env.CLOUDREEL_PACKAGE_ROOT ? path.dirname(root) : process.resourcesPath;
app.setName('CloudReel-Folder-Deletion-Acceptance');app.setPath('userData', process.env.CLOUDREEL_TEST_DIRECTORY);
app.on('window-all-closed', () => {});
let stage = 'startup', window, host, player, web, created, passed = false;
const summary = {originalProfileWrites: 0, originalCloudWrites: 0, traktWrites: 0, visibleWindowsOpened: 0};
const output = data => console.log('REAL_PLAYBACK_RESULT ' + JSON.stringify(data));
const until = async (check, timeout = 120000) => {const end = Date.now() + timeout;while (Date.now() < end) {if (await check()) return;await new Promise(resolve => setTimeout(resolve, 200));}throw new Error('timeout');};
const list = async directory => {const files = [];for (let start = 0; start < 20000;) {const page = await web.list(directory, start);files.push(...page.files);if (!page.hasMore) return files;start = page.nextStart;}throw new Error('directory too large');};
const missing = error => [-9, 31066].includes(Number(error.code)) || /文件已删除或无法访问/.test(error.message);
app.whenReady().then(async () => {
  const original = JSON.parse(fs.readFileSync(path.join(process.env.CLOUDREEL_SOURCE_PROFILE, 'state.json'), 'utf8'));
  const matched = original.items.filter(item => JSON.stringify([item.title, item.path, item.filename]).includes('嫁金钗'));
  const live = matched.find(item => !item.unavailable && item.episode === 1) || original.items.find(item => item.source === 'baidu' && !item.unavailable);
  assert.ok(live);
  const store = memoryStore();Object.assign(store.data.settings, {autoSync: false, autoScrape: false, autoNext: false, autoRefresh: false});
  store.data.items = structuredClone(matched.length ? matched : [live]);
  const groups = groupLibrary(store.data.items), visible = new Set(groups.flatMap(group => group.itemIds));
  assert.ok(store.data.items.filter(item => item.unavailable).every(item => !visible.has(item.id)));
  assert.ok(visible.has(live.id));summary.existingMissingVersionsHidden = true;
  window = new BrowserWindow({show: false, width: 1280, height: 800, webPreferences: {backgroundThrottling: false}});
  for (const method of ['show', 'showInactive', 'focus']) window[method] = () => {throw new Error('visibility prohibited');};
  const login = createBaiduLogin(store, () => {}, () => window);web = login.service;stage = 'restore';await login.restore();assert.equal(web.connected, true);
  stage = 'verify remaining source';const liveInfo = await web.fileInfo(live.fsId);assert.equal(Number(liveInfo.isdir), 0);
  const deleted = matched.find(item => item.unavailable);
  if (deleted) {await assert.rejects(web.fileInfo(deleted.fsId), missing);summary.missingSourceConfirmed = true;}
  stage = 'create isolated fixture';
  const variables = await web.sessionVariables();
  const create = async directory => {
    assert.ok(directory === target || directory.startsWith(target + '/'));
    const result = await web.request('/api/create', {a: 'commit', bdstoken: variables.bdstoken}, {method: 'POST', headers: {'Content-Type': 'application/x-www-form-urlencoded'}, body: new URLSearchParams({path: directory, isdir: '1', block_list: '[]', rtype: '0'}).toString()});
    assert.equal(result.errno, 0);assert.equal(result.path, directory);assert.ok(result.fs_id);return result;
  };
  assert.ok((await list('/')).some(file => file.path === TARGET && Number(file.isdir) === 1));
  created = await create(target);const folder = await create(target + '/version-a'), nested = await create(folder.path + '/nested');
  const copies = [];
  for (const [directory, name] of [[folder.path, 'Show.S01E01.mkv'], [nested.path, 'Show.S01E02.mkv']]) {
    const copied = await web.request('/api/filemanager', {opera: 'copy', async: 0, ondup: 'fail', bdstoken: variables.bdstoken}, {method: 'POST', headers: {'Content-Type': 'application/x-www-form-urlencoded'}, body: new URLSearchParams({filelist: JSON.stringify([{path: liveInfo.path, dest: directory, newname: name, ondup: 'fail'}])}).toString()});
    assert.equal(copied.errno, 0);assert.ok(!copied.info?.some(value => Number(value.errno || 0) !== 0));
    const copy = (await list(directory)).find(file => file.server_filename === name);assert.ok(copy);assert.notEqual(String(copy.fs_id), String(live.fsId));copies.push(copy);
  }
  const history = {position: 42};
  store.data.items.push(...copies.map((file, index) => ({...baiduItem(file), catalog: live.catalog, title: live.title, seriesTitle: live.title, kind: live.kind, season: 1, episode: index + 1, identificationLocked: true, progress: history})));
  store.data.scanRoots = [{id: 'isolated', source: 'baidu', path: target, fsId: String(created.fs_id), count: copies.length}];
  const manager = new FileManagementService(store, web, {account: () => 'isolated-account'});
  stage = 'folder preview';const plan = await manager.preview({rootId: 'isolated', ids: [String(folder.fs_id)], action: 'delete'});
  assert.equal(plan.ready, 1);assert.equal(plan.files[0].isDirectory, true);
  assert.equal((await web.fileInfo(copies[0].fs_id)).path, copies[0].path);
  stage = 'folder deletion';const report = await manager.commit({id: plan.id});assert.equal(report.success, 1);assert.equal(report.failed, 0);
  for (const file of [folder, ...copies]) await assert.rejects(web.fileInfo(file.fs_id), missing);
  for (const file of copies) {const item = store.data.items.find(item => item.fsId === String(file.fs_id));assert.equal(item.unavailable, true);assert.equal(item.progress, history);}
  assert.equal(store.data.scanRoots[0].count, 0);assert.equal(store.item(live.id).unavailable, undefined);
  stage = 'rescan';const scanner = new LibraryScanner(store, web);scanner.refresh();await scanner.active;assert.equal(store.data.scanRoots[0].error, null);
  const displayed = groupLibrary(store.data.items).flatMap(group => group.itemIds);
  assert.ok(copies.every(file => !displayed.includes('baidu:' + file.fs_id)));assert.ok(displayed.includes(live.id));summary.realFolderDeletion = true;summary.refreshDoesNotRestoreDeletedVersions = true;
  stage = 'remaining version playback';
  host = new NativeVideoHost(() => window, () => 1);host.layout({x: 0, y: 0, width: 1280, height: 800});
  player = new PlayerService(store, web, {}, {eligible: () => false, start: async () => {}, checkpoint: async () => {}}, {resolveMpv: () => discoverMpv('', resources, root), videoHost: host, inputConfig: path.join(process.env.CLOUDREEL_PACKAGE_ROOT ? path.join(resources, 'player') : path.join(root, 'electron'), 'player-keys.conf'), spawnPlayer: (binary, args, options) => {const quiet = [...args];quiet.splice(quiet.indexOf('--'), 0, '--mute=yes');return spawn(binary, quiet, options);}});
  output({progress: 'folder deletion confirmed; checking remaining real source'});
  await player.play(live.id, true);await until(() => player.session?.position > 1 && player.session?.videoParams);
  player.seek({itemId: live.id, seconds: 30});await until(() => !player.status().seek?.pending && Math.abs(player.session.position - 30) < 8);
  await until(() => player.status().buffered.length > 0);await player.stop();summary.remainingVersionPlayback = true;
  assert.equal((await web.fileInfo(live.fsId)).path, liveInfo.path);
  assert.equal(BrowserWindow.getAllWindows().some(view => view.isVisible()), false);passed = true;
}).catch(error => {output({passed: false, stage, errorType: error.name, code: Number.isFinite(Number(error.code)) ? Number(error.code) : undefined});}).finally(async () => {
  await player?.stop().catch(() => {});let cleaned = true;
  if (created) try {
    const current = await web.fileInfo(created.fs_id);assert.equal(current.path, target);assert.ok(current.path.startsWith(TARGET + '/CloudReel-0322-'));
    await web.manageFile('delete', current);await assert.rejects(web.fileInfo(created.fs_id), missing);
  } catch {cleaned = false;}
  output({...summary, passed: passed && cleaned, cleanupConfirmed: cleaned});host?.destroy();window?.destroy();app.exit(passed && cleaned ? 0 : 1);
});
