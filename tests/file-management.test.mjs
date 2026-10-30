import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildFilePlan, validFilename} from '../electron/core/file-management.mjs';
import {FileManagementService} from '../electron/services/file-management.mjs';
import {BaiduWebService} from '../electron/services/baidu-web.mjs';
import {BaiduService} from '../electron/services/baidu.mjs';
import {LibraryScanner} from '../electron/services/scanner.mjs';
import {LibraryRefresh} from '../electron/services/library-refresh.mjs';
import {memoryStore} from './helpers.mjs';

const file = (id, name, extra = {}) => ({fs_id: String(id), server_filename: name, path: '/Mount/' + name, size: 100, isdir: 0, ...extra});
const directory = {fs_id: '10', path: '/Mount', server_filename: 'Mount', isdir: 1, size: 0};
const rule = {mode: 'replace', search: 'old', replacement: 'new'};
const previewInput = {rootId: 'mount', ids: ['1'], action: 'rename', rule};
function fixture(options = {}) {
  const store = memoryStore(); store.data.scanRoots = [{id: 'mount', source: 'baidu', path: '/Mount', fsId: '10'}];
  let files = [file('1', 'old.mkv'), file('2', 'old.chs.ass')], account = 'viewer', writes = [], blocked = false;
  const baidu = {
    async fileInfo(id) {const value = String(id) === '10' ? directory : files.find(value => String(value.fs_id) === String(id)); if (!value) throw new Error('missing'); return {...value};},
    async list() {return {files: files.map(value => ({...value})), hasMore: false, nextStart: files.length};},
    async manageFile(action, value, name) {writes.push({action, id: value.fs_id, name}); if (action === 'delete') files = files.filter(file => file.fs_id !== value.fs_id); else Object.assign(files.find(file => file.fs_id === value.fs_id), {server_filename: name, path: '/Mount/' + name}); return baidu.fileInfo(value.fs_id).catch(() => ({deleted: true}));}
  };
  const manager = new FileManagementService(store, baidu, {account: () => account, blocked: () => blocked, ...options});
  return {store, baidu, manager, writes, get files() {return files;}, set files(value) {files = value;}, set account(value) {account = value;}, set blocked(value) {blocked = value;}};
}

test('standard rename uses matched library identity, quality and episode numbers; no list-order guesses', () => {
  const video = file('1', 'bad.2160p.WEB-DL.mkv'), subtitle = file('2', 'bad.2160p.WEB-DL.chs.ass');
  const plan = buildFilePlan([subtitle, video], ['2', '1'], [{source: 'baidu', fsId: '1', title: '硅谷', kind: 'episode', season: 4, episode: 3, identificationLocked: true}], {action: 'rename', rule: {mode: 'standard'}});
  assert.equal(plan[0].name, '硅谷 - S04E03 - 2160p WEB-DL.mkv');
  assert.equal(plan[1].name, '硅谷 - S04E03 - 2160p WEB-DL.chs.ass');
  const unknown = buildFilePlan([video], ['1'], [], {action: 'rename', rule: {mode: 'standard'}});
  assert.equal(unknown[0].status, 'blocked'); assert.match(unknown[0].reason, /匹配/);
});
test('text rules preserve extensions and companion language tags; companions can be excluded', () => {
  const files = [file('1', 'old.old.MKV'), file('2', 'old.old.zh-Hans.forced.ass')];
  const plan = buildFilePlan(files, ['1'], [], {action: 'rename', rule});
  assert.equal(plan[0].name, 'new.new.MKV'); assert.equal(plan[1].name, 'new.new.zh-Hans.forced.ass');
  assert.equal(buildFilePlan(files, ['1'], [], {action: 'delete', includeSubtitles: false}).length, 1);
  assert.equal(buildFilePlan(files, ['1'], [], {action: 'rename', rule: {mode: 'affix', prefix: 'A-', suffix: '-B'}})[1].name, 'A-old.old-B.zh-Hans.forced.ass');
});
test('a subtitle shared by two video extensions is never automatically changed for only one video', () => {
  const files = [file('1', 'old.mkv'), file('2', 'old.mp4'), file('3', 'old.chs.ass')];
  const plan = buildFilePlan(files, ['1'], [], {action: 'rename', rule});
  assert.equal(plan.length, 1); assert.equal(plan[0].fsId, '1');
  assert.equal(buildFilePlan(files, ['1', '2'], [], {action: 'delete'}).length, 2);
});
test('invalid names, existing files, case-insensitive collisions and duplicate target names are blocked', () => {
  for (const name of ['CON.mkv', 'aux.srt', '../evil.mkv', 'a/b.mkv', 'x?.mkv', 'x.mkv ', '影'.repeat(90)+'.mkv']) assert.equal(validFilename(name), false, name);
  const all = [file('1', 'old.mkv'), file('2', 'NEW.MKV')];
  assert.equal(buildFilePlan(all, ['1'], [], {action: 'rename', rule})[0].status, 'blocked');
  const duplicates = buildFilePlan([file('1', 'A.mkv'), file('2', 'B.mkv')], ['1', '2'], ['1', '2'].map(fsId => ({source: 'baidu', fsId, title: '电影', kind: 'movie', year: 2024, identificationLocked: true})), {action: 'rename', rule: {mode: 'standard'}});
  assert.ok(duplicates.every(value => value.status === 'blocked'));
});
test('folders, unsupported files and files absent from current directory cannot be selected', () => {
  for (const files of [[{...directory}], [file('10', 'note.txt')], []]) assert.throws(() => buildFilePlan(files, ['10'], [], {action: 'delete'}), /所选文件/);
});
test('preview never writes, and commit updates paths without changing watch or metadata identity', async () => {
  const f = fixture(), progress = {position: 83}, catalog = {id: '42'}, metadata = {ids: {trakt: 20}};
  f.store.data.items = [{id: 'baidu:1', source: 'baidu', fsId: '1', filename: 'old.mkv', path: '/Mount/old.mkv', progress, catalog, metadata, favorite: true}];
  const preview = await f.manager.preview(previewInput); assert.equal(preview.ready, 2); assert.equal(f.writes.length, 0);
  const report = await f.manager.commit({id: preview.id}); assert.equal(report.success, 2);
  const item = f.store.data.items[0]; assert.equal(item.path, '/Mount/new.mkv'); assert.equal(item.progress, progress); assert.equal(item.catalog, catalog); assert.equal(item.metadata, metadata); assert.equal(item.favorite, true);
  await assert.rejects(f.manager.commit({id: preview.id}), /失效/); assert.equal(f.writes.length, 2);
});
test('delete marks only successfully deleted sources unavailable and preserves progress and sync jobs', async () => {
  const f = fixture(), progress = {position: 21}; f.store.data.pending = [{itemId: 'baidu:1'}];
  f.store.data.items = [{source: 'baidu', fsId: '1', path: '/Mount/old.mkv', progress}, {source: 'local', fsId: '1'}];
  const preview = await f.manager.preview({...previewInput, action: 'delete'}); const report = await f.manager.commit({id: preview.id});
  assert.equal(report.success, 2); assert.equal(f.store.data.items[0].unavailable, true); assert.equal(f.store.data.items[0].progress, progress); assert.equal(f.store.data.items[1].unavailable, undefined); assert.equal(f.store.data.pending.length, 1);
});
test('changed path, size or MD5 after preview causes zero writes and preserves sidecars', async () => {
  for (const change of [{path: '/Mount/moved.mkv'}, {size: 101}, {md5: 'changed'}]) {
    const f = fixture(); f.files[0].md5 = 'original'; const preview = await f.manager.preview(previewInput); Object.assign(f.files[0], change);
    const report = await f.manager.commit({id: preview.id}); assert.equal(report.success, 0); assert.equal(f.writes.length, 0); assert.equal(report.results[1].status, 'skipped');
  }
});
test('one failed file does not block unrelated files; failed sidecars do not falsely report success', async () => {
  const f = fixture(); f.files.push(file('3', 'old-other.mkv')); const original = f.baidu.manageFile;
  f.baidu.manageFile = async (...args) => {if (args[1].fs_id === '1') throw new Error('timeout'); return original(...args);};
  const preview = await f.manager.preview({...previewInput, ids: ['1', '3']}); const report = await f.manager.commit({id: preview.id});
  assert.equal(report.success, 1); assert.equal(report.failed, 1); assert.equal(report.results.find(value => value.fsId === '2').status, 'skipped');
});
test('expired preview, changed account, removed mount and playback lock prevent writes', async () => {
  let clock = 1; const f = fixture({now: () => clock}); let preview = await f.manager.preview(previewInput); clock += 600001;
  await assert.rejects(f.manager.commit({id: preview.id}), /失效/);
  preview = await f.manager.preview(previewInput); f.account = 'another'; await assert.rejects(f.manager.commit({id: preview.id}), /失效/);
  f.account = 'viewer'; preview = await f.manager.preview(previewInput); f.blocked = true; await assert.rejects(f.manager.commit({id: preview.id}), /停止播放/);
  f.blocked = false; f.store.data.scanRoots = []; await assert.rejects(f.manager.commit({id: preview.id}), /挂载已移除/); assert.equal(f.writes.length, 0);
});
test('directory boundaries use IDs and reject similarly-prefixed folders and path injection', async () => {
  const f = fixture(); f.files.push(file('30', 'Other', {path: '/Mount-other', isdir: 1}));
  await assert.rejects(f.manager.browse({rootId: 'mount', directoryId: '30'}), /当前挂载/);
  await assert.rejects(f.manager.preview({...previewInput, ids: ['/Mount/old.mkv']}), /请选择/);
  await assert.rejects(f.manager.browse({rootId: 'mount', start: 1}), /分页/);
});
test('commit is exclusive while awaited and releases the scan lock after failure', async () => {
  let release, ended = 0; const f = fixture({begin: () => new Promise(resolve => {release = resolve;}), end: () => ended++});
  const preview = await f.manager.preview(previewInput); const commit = f.manager.commit({id: preview.id});
  await assert.rejects(f.manager.commit({id: preview.id}), /任务正在执行/); f.store.data.scanRoots = []; release(); await assert.rejects(commit, /挂载已移除/);
  assert.equal(ended, 1); assert.equal(f.manager.busy, false);
});
test('fresh account verification detects a changed login before any write', async () => {
  let fresh = false, f;
  f = fixture({verifyAccount: async () => {if (fresh) f.account = 'newly-detected-account';}});
  const preview = await f.manager.preview(previewInput); fresh = true;
  await assert.rejects(f.manager.commit({id: preview.id}), /账号已变化/); assert.equal(f.writes.length, 0);
});
test('cancel finishes the in-flight video and its sidecars, then skips other files', async () => {
  const f = fixture(); f.files.push(file('3', 'old-other.mkv')); const write = f.baidu.manageFile;
  f.baidu.manageFile = async (...args) => {const value = await write(...args); f.manager.cancel(); return value;};
  const preview = await f.manager.preview({...previewInput, ids: ['1', '3']}); const report = await f.manager.commit({id: preview.id});
  assert.equal(f.writes.length, 2); assert.equal(report.success, 2); assert.equal(report.results.find(value => value.fsId === '3').status, 'skipped'); assert.match(report.results.find(value => value.fsId === '3').message, /停止/);
});
test('browse preserves server pagination even when folders contain only nonmedia', async () => {
  const f = fixture(); f.baidu.list = async () => ({files: [file('1', 'notes.txt')], hasMore: true, nextStart: 200});
  const result = await f.manager.browse({rootId: 'mount'}); assert.deepEqual(result.files, []); assert.equal(result.nextStart, 200); assert.equal(result.hasMore, true);
});
test('lost rename acknowledgement is reconciled by ID without a second write', async () => {
  const f = fixture(); f.store.data.items = [{source: 'baidu', fsId: '1', path: '/Mount/old.mkv', filename: 'old.mkv'}];
  const write = f.baidu.manageFile;
  f.baidu.manageFile = async (...args) => {await write(...args); throw new Error('lost acknowledgement');};
  const preview = await f.manager.preview(previewInput), report = await f.manager.commit({id: preview.id});
  assert.equal(report.success, 2); assert.equal(f.writes.length, 2); assert.equal(f.store.data.items[0].path, '/Mount/new.mkv');
});
test('browsing reconciles uncertain names while preserving watch state; deleting updates mount counts', async () => {
  const f = fixture(), progress = {position: 15}; f.store.data.scanRoots[0].count = 1;
  f.store.data.items = [{source: 'baidu', fsId: '1', path: '/Mount/outdated.mkv', filename: 'outdated.mkv', progress}];
  await f.manager.browse({rootId: 'mount'}); assert.equal(f.store.data.items[0].path, '/Mount/old.mkv'); assert.equal(f.store.data.items[0].progress, progress);
  const preview = await f.manager.preview({...previewInput, action: 'delete'}); await f.manager.commit({id: preview.id}); assert.equal(f.store.data.scanRoots[0].count, 0);
});

for (const mode of ['web', 'oauth']) test(`${mode} file operations use POST, no overwrite and never retry an uncertain write`, async () => {
  const store = memoryStore(); store.data.secrets.baiduToken = {access_token: 'test-token', expiresAt: Date.now()+60000*10}; let current = file('90071992547409931', 'old.mkv'), posts = [], uncertain = false;
  const fetcher = async (input, options) => {
    const url = new URL(input);
    if (url.pathname.includes('gettemplatevariable')) return new Response(JSON.stringify({result: {bdstoken: 'test-token', loginstate: 1}}));
    if (url.pathname.endsWith('/list')) return new Response('{"list":[]}');
    if (url.pathname.includes('filemetas') || url.searchParams.get('method') === 'filemetas') return new Response(JSON.stringify({info: [current], list: [current]}));
    posts.push({url, options}); if (uncertain) throw new Error('network failure');
    if (url.searchParams.get('opera') === 'rename') {const name = JSON.parse(new URLSearchParams(options.body).get('filelist'))[0].newname; current = {...current, path: '/Mount/'+name, server_filename: name};}
    return new Response('{"errno":0,"info":[{"errno":0}]}');
  };
  const service = mode === 'web' ? new BaiduWebService(store, {fetcher}) : new BaiduService(store, {fetcher});
  const result = await service.manageFile('rename', current, 'new.mkv'); assert.equal(result.path, '/Mount/new.mkv');
  assert.equal(posts[0].options.method, 'POST'); assert.equal(posts[0].url.searchParams.get('opera'), 'rename'); assert.match(posts[0].options.body, /filelist=/);
  assert.ok(posts[0].url.searchParams.get('ondup') === 'fail' || new URLSearchParams(posts[0].options.body).get('ondup') === 'fail');
  await service.manageFile('delete', current); assert.deepEqual(JSON.parse(new URLSearchParams(posts[1].options.body).get('filelist')), ['/Mount/new.mkv']);
  uncertain = true; await assert.rejects(service.manageFile('delete', current)); assert.equal(posts.length, 3);
});
test('provider per-file errors and asynchronous task acknowledgements cannot mark a file deleted', async () => {
  for (const response of [{errno: 0, info: [{errno: -9}]}, {errno: 0, taskid: 'unconfirmed'}]) {
    const service = new BaiduWebService(memoryStore(), {fetcher: async () => new Response(JSON.stringify(response))});
    service.fileInfo = async () => file('1', 'old.mkv'); service.sessionVariables = async () => ({bdstoken: 'test-token'});
    await assert.rejects(service.manageFile('delete', file('1', 'old.mkv')), /未确认/);
  }
});
test('scan suspension blocks manual and periodic scans without consuming startup refresh', () => {
  const store = memoryStore(); store.data.scanRoots = [{id: 'mount', source: 'baidu', path: '/Mount'}];
  const scanner = new LibraryScanner(store, {}); scanner.suspended = true;
  const refresh = new LibraryRefresh(scanner, {baiduConnected: () => true, automatic: () => true}); refresh.startup(); refresh.tick();
  assert.equal(refresh.startedRoots.size, 0); assert.throws(() => scanner.refresh(), /文件操作/);
});
