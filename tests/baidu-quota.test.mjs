import {test} from 'node:test';
import assert from 'node:assert/strict';
import {normalizeBaiduQuota} from '../electron/core/baidu-quota.mjs';
import {BaiduQuotaMonitor} from '../electron/services/baidu-quota.mjs';
import {BaiduWebService} from '../electron/services/baidu-web.mjs';
import {BaiduService} from '../electron/services/baidu.mjs';
import {memoryStore} from './helpers.mjs';

const json = data => new Response(JSON.stringify(data));
const deferred = () => {let resolve, reject; const promise = new Promise((a, b) => {resolve = a; reject = b;}); return {promise, resolve, reject};};
function fixture(read = async () => ({total: 1000, used: 250})) {
  let time = 100000, account = 'one', calls = 0, notifications = 0, tick;
  const delays = new Map(), cancelled = [];
  const monitor = new BaiduQuotaMonitor({read: () => {calls++; return read();}, identity: () => account, now: () => time, notify: () => notifications++,
    setTimer: callback => {tick = callback; return 0;}, clearTimer: value => cancelled.push(value),
    setDelay: (callback, ms) => {assert.equal(ms, 2000);const handle = {};delays.set(handle, callback);return handle;}, clearDelay: handle => delays.delete(handle)});
  return {monitor, calls: () => calls, notifications: () => notifications, advance: ms => time += ms, account: value => account = value,
    tick: () => tick(), delays, cancelled, delayed: async () => {const [handle, callback] = [...delays][0];delays.delete(handle);await callback();}};
}

test('quota validates byte counts, accepts decimal strings and clamps available space after plan expiry', () => {
  assert.deepEqual(normalizeBaiduQuota({total: '2199023255552', used: 0}), {total: 2199023255552, used: 0, available: 2199023255552});
  assert.deepEqual(normalizeBaiduQuota({total: 100, used: 150}), {total: 100, used: 150, available: 0});
  for (const data of [null, {}, {total: 0, used: 0}, {total: 10}, {total: 10, used: null}, {total: 10, used: ''}, {total: 10, used: -1}, {total: Infinity, used: 1}, {total: Number.MAX_SAFE_INTEGER + 1, used: 1}, {total: 10, used: true}, {total: '1e3', used: '0'}, {total: 10, used: 1.1}]) assert.throws(() => normalizeBaiduQuota(data), /容量/);
});

test('web quota reads the authenticated endpoint without enumerating files or persisting data', async () => {
  const store = memoryStore(), before = JSON.stringify(store.data), calls = [];
  const service = new BaiduWebService(store, {fetcher: async (input, options) => {
    const url = new URL(input);calls.push(url.pathname);
    assert.equal(url.pathname, '/api/quota');assert.equal(url.searchParams.get('bdstoken'), 'fixture-session');
    assert.equal(options.credentials, 'include');assert.equal(options.cache, 'no-store');assert.equal(options.method, undefined);
    assert.equal(url.searchParams.get('checkexpire'), '1');assert.equal(url.searchParams.get('checkfree'), '1');
    return json({errno: 0, total: 1000, used: 250});
  }});
  service.variables = {bdstoken: 'fixture-session'};service.variablesAt = Date.now();service.connected = true;
  assert.deepEqual(await service.quota(), {total: 1000, used: 250, available: 750});
  assert.deepEqual(calls, ['/api/quota']);assert.equal(JSON.stringify(store.data), before);
});

test('OAuth quota uses the access token and rejects incomplete or failed responses', async () => {
  const store = memoryStore();store.setSecret('baiduToken', {access_token: 'fixture-token', expiresAt: Date.now() + 3600000});
  let response = {errno: 0, total: '1000', used: '250'};
  const service = new BaiduService(store, {fetcher: async input => {
    const url = new URL(input);assert.equal(url.pathname, '/api/quota');assert.equal(url.searchParams.get('access_token'), 'fixture-token');
    return json(response);
  }});
  assert.deepEqual(await service.quota(), {total: 1000, used: 250, available: 750});
  response = {errno: 0};await assert.rejects(service.quota(), /容量/);
  response = {errno: 31034};await assert.rejects(service.quota(), /权限/);
});

test('monitor starts on connection, coalesces requests and throttles automatic and manual refresh', async () => {
  const pending = deferred(), f = fixture(() => pending.promise);
  f.account(null);f.monitor.start();await Promise.resolve();assert.equal(f.calls(), 0);
  f.account('one');const first = f.monitor.refresh();assert.equal(f.monitor.status().loading, true);
  assert.equal(f.monitor.refresh({force: true}), first);pending.resolve({total: 1000, used: 250});await first;
  assert.equal(f.calls(), 1);assert.equal(f.monitor.status().loading, false);assert.ok(f.monitor.status().updatedAt);
  await f.monitor.refresh({force: true});assert.equal(f.calls(), 1);
  f.advance(1000);await f.monitor.refresh({force: true});assert.equal(f.calls(), 2);
  f.advance(59999);await f.monitor.refresh();assert.equal(f.calls(), 2);
  f.advance(1);await f.tick();await f.monitor.pending;assert.equal(f.calls(), 3);
  f.monitor.start();f.monitor.stop();assert.deepEqual(f.cancelled, [0]);f.tick();await Promise.resolve();assert.equal(f.calls(), 3);
});

test('failed reads retain the last valid numbers and expose a safe stale state', async () => {
  let response = {total: 1000, used: 250};
  const f = fixture(() => {if (response instanceof Error) throw response;return response;});
  await f.monitor.refresh();const updatedAt = f.monitor.status().updatedAt;
  response = new Error('private diagnostic');f.advance(60000);await f.monitor.refresh();
  assert.deepEqual({...f.monitor.status(), error: null}, {loading: false, total: 1000, used: 250, available: 750, updatedAt, error: null});
  assert.match(f.monitor.status().error, /上次读数/);assert.ok(!JSON.stringify(f.monitor.status()).includes('private'));
  f.account('two');await f.monitor.refresh();assert.equal(f.monitor.status().total, null);assert.match(f.monitor.status().error, /无法读取/);
  response = {total: 1000, used: 300};f.advance(1000);await f.monitor.refresh({force: true});assert.equal(f.monitor.status().error, null);
});

test('account changes and disconnect discard late replies without clearing the new account request', async () => {
  const old = deferred(), next = deferred();let request = old;
  const f = fixture(() => request.promise), first = f.monitor.refresh();await Promise.resolve();
  f.monitor.changed();assert.equal(f.delays.size, 1);
  f.account('two');request = next;const second = f.monitor.refresh();await Promise.resolve();assert.equal(f.delays.size, 0);
  old.resolve({total: 1000, used: 950});await first;
  assert.equal(f.monitor.status().total, null);assert.equal(f.monitor.status().loading, true);assert.equal(f.monitor.pending, second);
  next.resolve({total: 2000, used: 200});await second;assert.equal(f.monitor.status().used, 200);
  f.account(null);assert.equal(f.monitor.status().total, null);await f.monitor.refresh({force: true});assert.equal(f.calls(), 2);
});

test('post-operation updates debounce and make a trailing read after an existing request', async () => {
  const pending = deferred(), f = fixture(() => pending.promise);
  const first = f.monitor.refresh();await Promise.resolve();f.monitor.changed();f.monitor.changed();assert.equal(f.delays.size, 1);
  const trailing = f.delayed();pending.resolve({total: 1000, used: 250});await first;await trailing;
  assert.equal(f.delays.size, 1);f.advance(2000);await f.delayed();assert.equal(f.calls(), 2);
  f.monitor.changed();f.monitor.stop();assert.equal(f.delays.size, 0);
});

test('reset or stop before a deferred request starts prevents the read entirely', async () => {
  const f = fixture();const first = f.monitor.refresh();f.monitor.reset();await first;assert.equal(f.calls(), 0);
  const second = f.monitor.refresh();f.monitor.stop();await second;assert.equal(f.calls(), 0);
});
