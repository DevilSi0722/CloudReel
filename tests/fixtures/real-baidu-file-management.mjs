// Manual acceptance. All remote writes stay inside the previously authorized
// sandbox. Restore renamed originals; delete only copies created by this run.
import {app, BrowserWindow} from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {memoryStore} from '../helpers.mjs';
const root = process.env.CLOUDREEL_PACKAGE_ROOT || fileURLToPath(new URL('../../', import.meta.url));
const load = relative => import(pathToFileURL(path.join(root, 'electron', relative)).href);
const {createBaiduLogin} = await load('services/baidu-login.mjs');
const {FileManagementService} = await load('services/file-management.mjs');
const {PlayerService, discoverMpv} = await load('services/player.mjs');
const {NativeVideoHost} = await load('services/native-video.mjs');
const {baiduItem, isVideo} = await load('core/media.mjs');
const TARGET = '/CloudReel-SeedHub-Test', tag = 'CloudReel-0321-' + randomUUID().slice(0, 8) + '-';
const resources = process.env.CLOUDREEL_PACKAGE_ROOT ? path.dirname(root) : process.resourcesPath;
app.setName('CloudReel-File-Management-Acceptance'); app.setPath('userData', process.env.CLOUDREEL_TEST_DIRECTORY);
app.on('window-all-closed', () => {});
let window, host, player, web, stage = 'startup', originals = [], temporaryCopy, copyDirectory, success = false;
const summary = {originalProfileWrites: 0, traktWrites: 0, visibleWindowsOpened: 0};
const output = data => console.log('REAL_PLAYBACK_RESULT ' + JSON.stringify(data));
const until = async (check, timeout = 120000) => {const end = Date.now() + timeout; while (Date.now() < end) {if (await check()) return; await new Promise(resolve => setTimeout(resolve, 200));} throw new Error('timeout');};
const within = value => value.startsWith(TARGET + '/');
const list = async directory => {const files = []; for (let start = 0; start < 20000;) {const page = await web.list(directory, start); files.push(...page.files); if (!page.hasMore) return files; start = page.nextStart;} throw new Error('directory too large');};
app.whenReady().then(async () => {
  const sourceFile = path.join(process.env.CLOUDREEL_SOURCE_PROFILE, 'state.json'), before = fs.readFileSync(sourceFile);
  const store = memoryStore(); Object.assign(store.data.settings, {autoSync: false, autoScrape: false, autoNext: false, autoRefresh: false});
  window = new BrowserWindow({show: false, width: 1280, height: 800, webPreferences: {backgroundThrottling: false}});
  for (const method of ['show', 'showInactive', 'focus']) window[method] = () => {throw new Error('visibility prohibited');};
  const login = createBaiduLogin(store, () => {}, () => window); web = login.service; stage = 'restore'; await login.restore(); assert.equal(web.connected, true);
  stage = 'test folder'; const mount = (await list('/')).find(file => file.path === TARGET && Number(file.isdir) === 1); assert.ok(mount);
  store.data.scanRoots = [{id: 'test-mount', source: 'baidu', path: TARGET, fsId: String(mount.fs_id), enabled: true}];
  const queue = [mount]; let video, parent;
  for (let visits = 0; queue.length && visits < 30 && !video; visits++) {
    const current = queue.shift(); assert.ok(current.path === TARGET || within(current.path)); const files = await list(current.path);
    video = files.find(file => !file.isdir && isVideo(file.server_filename)); if (video) parent = current;
    else queue.push(...files.filter(file => file.isdir));
  }
  assert.ok(video); assert.ok(within(video.path));
  const item = {...baiduItem(video), identificationLocked: true, progress: {position: 73, duration: 1000, percent: 7.3}};
  const progress = item.progress; store.data.items = [item];
  const manager = new FileManagementService(store, web, {account: () => 'isolated-test-account'});
  const location = {rootId: 'test-mount', directoryId: String(parent.fs_id)};
  stage = 'preview'; const preview = await manager.preview({...location, ids: [String(video.fs_id)], action: 'rename', rule: {mode: 'affix', prefix: tag}});
  originals = manager.plans.get(preview.id).entries.filter(entry => entry.status === 'ready').map(entry => ({id: entry.fsId, name: entry.original}));
  assert.ok(originals.length > 0); stage = 'rename'; const report = await manager.commit({id: preview.id}); assert.equal(report.failed, 0); assert.equal(report.success, originals.length);
  summary.realRename = true; assert.equal(item.progress, progress); assert.ok(item.filename.startsWith(tag));
  const updated = await web.fileInfo(video.fs_id); assert.equal(item.path, updated.path);
  host = new NativeVideoHost(() => window, () => 1); host.layout({x: 0, y: 0, width: 1280, height: 800});
  player = new PlayerService(store, web, {}, {eligible: () => false, start: async () => {}, checkpoint: async () => {}}, {resolveMpv: () => discoverMpv('', resources, root), videoHost: host, inputConfig: path.join(process.env.CLOUDREEL_PACKAGE_ROOT ? path.join(resources, 'player') : path.join(root, 'electron'), 'player-keys.conf'), spawnPlayer: (binary, args, options) => {const quiet = [...args]; quiet.splice(quiet.indexOf('--'), 0, '--mute=yes'); return spawn(binary, quiet, options);}});
  stage = 'playback after rename'; output({progress: 'real rename confirmed; checking production player'});
  await player.play(item.id, true); await until(() => player.session?.position > 1 && player.session?.videoParams);
  player.seek({itemId: item.id, seconds: 30}); await until(() => !player.status().seek?.pending && Math.abs(player.session.position - 30) < 8);
  await until(() => player.status().buffered.length > 0); await player.stop(); summary.renameWithoutRescanPlayback = true;
  stage = 'temporary delete fixture';
  // A provider-side copy avoids another download or share transfer. Its stable
  // ID must differ from the original before it becomes eligible for deletion.
  const current = await web.fileInfo(video.fs_id), variables = await web.sessionVariables(), copyName = tag + 'delete-check' + path.posix.extname(current.path);
  copyDirectory = parent.path;
  assert.ok(within(current.path)); assert.ok(parent.path === TARGET || within(parent.path));
  const copied = await web.request('/api/filemanager', {opera: 'copy', async: 0, ondup: 'fail', bdstoken: variables.bdstoken}, {method: 'POST', headers: {'Content-Type': 'application/x-www-form-urlencoded'}, body: new URLSearchParams({filelist: JSON.stringify([{path: current.path, dest: parent.path, newname: copyName, ondup: 'fail'}])}).toString()});
  assert.equal(copied.errno, 0); assert.ok(!copied.info?.some(value => Number(value.errno || 0) !== 0));
  temporaryCopy = (await list(parent.path)).find(file => file.server_filename === copyName); assert.ok(temporaryCopy); assert.notEqual(String(temporaryCopy.fs_id), String(video.fs_id));
  store.data.items.push({...baiduItem(temporaryCopy), progress: {position: 4}});
  stage = 'delete copy'; const deletion = await manager.preview({...location, ids: [String(temporaryCopy.fs_id)], action: 'delete', includeSubtitles: false});
  const deleted = await manager.commit({id: deletion.id}); assert.equal(deleted.success, 1); assert.equal(deleted.failed, 0);
  assert.equal((await list(parent.path)).some(file => String(file.fs_id) === String(temporaryCopy.fs_id)), false);
  assert.equal(store.data.items[1].unavailable, true); assert.equal(store.data.items[1].progress.position, 4); temporaryCopy = null; summary.realDelete = true;
  stage = 'restore originals';
  for (const original of originals) {const current = await web.fileInfo(original.id); assert.ok(within(current.path)); if (current.server_filename !== original.name) await web.manageFile('rename', current, original.name);}
  originals = []; summary.originalNamesRestored = true;
  assert.equal(Buffer.compare(before, fs.readFileSync(sourceFile)), 0); assert.equal(BrowserWindow.getAllWindows().some(view => view.isVisible()), false);
  success = true;
}).catch(error => {output({passed: false, stage, errorType: error.name, code: Number.isFinite(Number(error.code)) ? Number(error.code) : undefined});}).finally(async () => {
  await player?.stop().catch(() => {});
  let cleaned = true;
  if (temporaryCopy) try {const current = await web.fileInfo(temporaryCopy.fs_id); assert.ok(within(current.path)); assert.ok(current.server_filename.startsWith(tag)); await web.manageFile('delete', current);} catch {cleaned = false;}
  for (const original of originals) try {const current = await web.fileInfo(original.id); assert.ok(within(current.path)); if (current.server_filename !== original.name) await web.manageFile('rename', current, original.name);} catch {cleaned = false;}
  output({...summary, passed: success && cleaned, cleanupConfirmed: cleaned}); host?.destroy(); window?.destroy(); app.exit(success && cleaned ? 0 : 1);
});
