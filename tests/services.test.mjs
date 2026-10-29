import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { BaiduService } from '../electron/services/baidu.mjs';
import { TraktService } from '../electron/services/trakt.mjs';
import { SyncService } from '../electron/services/sync.mjs';
import { createStreamRelay } from '../electron/services/stream.mjs';
import { memoryStore } from './helpers.mjs';

const response = (data, status = 200) => new Response(JSON.stringify(data), { status });
test('concurrent Baidu requests refresh an expired token once and use pagination correctly', async () => {
  const store = memoryStore(); store.setSecret('baiduAppSecret', 'app-secret'); store.setSecret('baiduToken', { access_token: 'expired', refresh_token: 'refresh', expiresAt: 0 });
  let refreshes = 0; const calls = [];
  const baidu = new BaiduService(store, { fetcher: async url => {
    url = new URL(url); calls.push(url);
    if (url.pathname.endsWith('/token')) { refreshes++; await new Promise(resolve => setTimeout(resolve, 10)); return response({ access_token: 'fresh', refresh_token: 'rotated', expires_in: 3600 }); }
    assert.equal(url.searchParams.get('access_token'), 'fresh'); return response({ errno: 0, list: [] });
  } });
  await Promise.all([baidu.list('/电影', 200), baidu.list('/剧集', 0)]);
  assert.equal(refreshes, 1); assert.equal(store.secret('baiduToken').refresh_token, 'rotated');
  const list = calls.find(url => url.searchParams.get('dir') === '/电影');
  assert.equal(list.searchParams.get('start'), '200'); assert.equal(list.searchParams.get('limit'), '200');
});
test('Baidu dlink uses numeric JSON for int64 IDs and appends the access token', async () => {
  const store = memoryStore(); store.setSecret('baiduToken', { access_token: 'my-token', expiresAt: Date.now() + 3600000 });
  const baidu = new BaiduService(store, { fetcher: async url => { assert.equal(new URL(url).searchParams.get('fsids'), '[987654321012345678]'); return response({ errno: 0, list: [{fs_id:'987654321012345678',path:'/test.mkv',isdir:0,dlink: 'https://d.pcs.baidu.com/file/test' }] }); } });
  const url = new URL(await baidu.streamUrl('987654321012345678')); assert.equal(url.searchParams.get('access_token'), 'my-token');
});
test('Trakt PKCE rejects forged callbacks and exchanges without a client secret', async () => {
  const store = memoryStore(); let exchange;
  const trakt = new TraktService(store, { fetcher: async (url, options) => {
    if (String(url).endsWith('/oauth/token')) { exchange = JSON.parse(options.body); return response({ access_token: 'token', refresh_token: 'refresh', expires_in: 3600 }); }
    return response({ user: { username: 'viewer' } });
  } });
  const auth = new URL(trakt.beginAuth().url);
  assert.equal(auth.origin, 'https://auth.trakt.tv'); assert.equal(auth.searchParams.get('code_challenge_method'), 'S256');
  await assert.rejects(trakt.completeAuth('https://example.com/callback?code=stolen&state=wrong'), /state/);
  const callback = `https://example.com/callback?code=ok&state=${auth.searchParams.get('state')}`;
  await trakt.completeAuth(callback);
  assert.equal(createHash('sha256').update(exchange.code_verifier).digest('base64url'), auth.searchParams.get('code_challenge'));
  assert.equal(exchange.client_secret, undefined); assert.equal(store.secret('traktToken').access_token, 'token');
});
test('Trakt reads all playback pages, not just first 100 results', async () => {
  const store = memoryStore(); store.setSecret('traktToken', { access_token: 'ok', expiresAt: Date.now() + 3600000 });
  const pages = [];
  const trakt = new TraktService(store, { fetcher: async url => { const page = Number(new URL(url).searchParams.get('page')); pages.push(page); return response(page === 1 ? Array.from({ length: 100 }, (_, id) => ({ id })) : [{ id: 101 }]); } });
  assert.equal((await trakt.playback('movie')).length, 101); assert.deepEqual(pages, [1, 2]);
});
test('pause above 80% never falls back to stop and falsely marks a movie watched', async () => {
  const store = memoryStore(); store.setSecret('traktToken', { access_token: 'ok', expiresAt: Date.now() + 3600000 }); let calls = 0;
  const trakt = new TraktService(store, { fetcher: async () => { calls++; return response({}, 404); } });
  await assert.rejects(trakt.scrobble({ type: 'movie', ids: { trakt: 1 } }, 85, 'pause'));
  assert.equal(calls, 1); assert.equal(await trakt.scrobble({ type: 'movie', ids: { trakt: 1 } }, 0.2, 'stop'), null);
});
test('failed sync is retained, then retries successfully; newer device progress wins', async () => {
  const store = memoryStore(); store.setSecret('traktToken', { access_token: 'token' });
  const item = { id: 'test', title: 'Test', metadata: { type: 'movie', ids: { trakt: 1 } }, progress: { percent: 40, updatedAt: new Date().toISOString() } }; store.data.items.push(item);
  let fail = true, calls = 0; const trakt = { scrobble: async () => { calls++; if (fail) throw new Error('offline'); }, resume: async () => ({ progress: 20, paused_at: new Date().toISOString() }) };
  const sync = new SyncService(store, trakt); await sync.checkpoint(item, 'stop'); assert.equal(store.data.pending.length, 1);
  fail = false; await sync.flush(); assert.equal(store.data.pending.length, 0); assert.equal(calls, 2);
  store.queue({ itemId: item.id, metadata: item.metadata, progress: 70, action: 'stop', at: new Date(Date.now() - 120000).toISOString() });
  await sync.flush(); assert.equal(store.data.pending.length, 0); assert.equal(calls, 2);
});
test('stream relay forwards Range and UA and refreshes an expired URL without exposing it', async () => {
  let links = 0, reads = 0;
  const relay = await createStreamRelay(async ({refresh}) => {assert.equal(refresh, links > 0);return `https://d.pcs.baidu.com/file/${++links}?access_token=secret`;}, { fetcher: async (url, options) => {
    reads++; assert.equal(options.headers.Range, 'bytes=2-5'); assert.equal(options.headers['User-Agent'], 'pan.baidu.com');
    if (reads === 1) return new Response('', { status: 403 });
    return new Response('cdef', { status: 206, headers: { 'content-range': 'bytes 2-5/10', 'content-length': '4' } });
  } });
  try {
    assert.ok(!relay.url.includes('secret')); const result = await fetch(relay.url, { headers: { Range: 'bytes=2-5' } });
    assert.equal(result.status, 206); assert.equal(await result.text(), 'cdef'); assert.equal(result.headers.get('content-range'), 'bytes 2-5/10'); assert.equal(links, 2);
    assert.equal((await fetch(new URL('/wrong-path', relay.url))).status, 404);
  } finally { relay.close(); }
});

test('media denial keeps the actual Baidu error code but never echoes its signed error payload',async()=>{
  const errors=[];let attempts=0;
  const relay=await createStreamRelay(async()=>{attempts++;return 'https://pcs.baidu.com/file?sign=private';},{fetcher:async()=>new Response(JSON.stringify({error_code:31360,error_msg:'private https://pcs.baidu.com/?sign=private'}),{status:403,headers:{'content-type':'text/plain'}}),onError:error=>errors.push(error.message)});
  try{
    const response=await fetch(relay.url);assert.equal(response.status,403);assert.equal(attempts,2);
    assert.match(errors[0],/31360/);assert.match(errors[0],/过期/);assert.equal(errors.some(x=>x.includes('private')),false);assert.equal((await response.text()).includes('private'),false);
  }finally{relay.close();}
});
