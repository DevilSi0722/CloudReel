import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BaiduWebService, webDownloadSign, isBaiduPage } from '../electron/services/baidu-web.mjs';
import { TraktService } from '../electron/services/trakt.mjs';
import { memoryStore } from './helpers.mjs';
import { fetchSessionMedia } from '../electron/services/session-media.mjs';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

const json = data => new Response(JSON.stringify(data));
test('web login requires real directory access and does not persist session variables', async () => {
  const store = memoryStore(); const requests = [];
  const service = new BaiduWebService(store, { fetcher: async (input, options) => {
    const url = new URL(input); requests.push(url);
    assert.equal(options.credentials, 'include');
    if (url.pathname === '/api/gettemplatevariable') return json({ errno: 0, result: { bdstoken: 'PRIVATE-SESSION', loginstate: 1, username: 'Viewer', is_svip: '0' } });
    return json({ errno: 0, list: [] });
  } });
  assert.equal(service.status().connected, false);
  assert.equal(await service.check(), true);
  assert.equal(requests.at(-1).pathname, '/api/list');
  assert.equal(service.status().profile.netdisk_name, 'Viewer');
  assert.equal(service.status().profile.vip, '');
  assert.ok(!JSON.stringify(store.data).includes('PRIVATE-SESSION'));
  assert.ok(!JSON.stringify(service.status()).includes('PRIVATE-SESSION'));
  service.reset(); assert.equal(service.status().connected, false);
});
test('a login page, expired session and late login response cannot mark an account connected', async () => {
  const store = memoryStore();
  const anonymous = new BaiduWebService(store, { fetcher: async () => json({ errno: 0, result: { loginstate: 0 } }) });
  assert.equal(await anonymous.check(), false);
  const expired = new BaiduWebService(store, { fetcher: async input => new URL(input).pathname.includes('gettemplate') ? json({ errno: 0, result: { bdstoken: 'x', loginstate: 1 } }) : json({ errno: -6 }) });
  await assert.rejects(expired.check(), /会话/); assert.equal(expired.connected, false);
  let finish;
  const delayed = new BaiduWebService(store, { fetcher: async () => new Promise(resolve => { finish = resolve; }) });
  const checking = delayed.check(); delayed.reset(); finish(json({ result: { bdstoken: 'x', loginstate: 1 } }));
  assert.equal(await checking, false); assert.equal(delayed.connected, false);
});
test('web file pagination preserves int64 IDs and download signatures never evaluate server code', async () => {
  assert.equal(webDownloadSign('Key', 'Plaintext'), Buffer.from('BBF316E8D940AF0AD3', 'hex').toString('base64'));
  const store = memoryStore(); let download;
  const service = new BaiduWebService(store, { fetcher: async (input, options) => {
    const url = new URL(input);
    if (url.pathname.includes('gettemplate')) {
      const fields = new URLSearchParams(options.body).get('fields');
      return json({ result: fields.includes('sign1') ? { sign1: 'Plaintext', sign3: 'Key', sign2: 'throw new Error("must never run")', timestamp: 123 } : { bdstoken: 'x', loginstate: 1 } });
    }
    if (url.pathname === '/api/download') { download = url; return json({ errno: 0, dlink: [{ dlink: 'https://d.pcs.baidu.com/file/video' }] }); }
    if (url.searchParams.get('num') === '1') return json({ errno: 0, list: [] });
    assert.equal(url.searchParams.get('page'), '2');
    return new Response('{"errno":0,"list":[{"fs_id":987654321012345678,"isdir":0}]}');
  } });
  const listing = await service.list('/影视', 200); assert.equal(listing.files[0].fs_id, '987654321012345678');
  assert.equal(await service.streamUrl('987654321012345678'), 'https://d.pcs.baidu.com/file/video');
  assert.equal(download.searchParams.get('fidlist'), '[987654321012345678]');
  assert.equal(download.searchParams.get('sign'), webDownloadSign('Key', 'Plaintext'));
});
test('official login navigation rejects lookalike domains and non-HTTPS targets', () => {
  assert.equal(isBaiduPage('https://passport.baidu.com/v2/'), true);
  for (const value of ['http://pan.baidu.com', 'https://baidu.com.attacker.test', 'https://baidu.com@attacker.test', 'file:///C:/Windows', 'javascript:alert(1)']) assert.equal(isBaiduPage(value), false);
});
test('media requests retain the isolated browser session and Range without the OAuth user agent', async () => {
  const signal = new AbortController().signal;
  const service = new BaiduWebService(memoryStore(), { fetcher: async (_url, options) => {
    const headers = new Headers(options.headers);
    assert.equal(options.credentials, 'include'); assert.equal(options.signal, signal);
    assert.equal(headers.get('range'), 'bytes=100-199'); assert.equal(headers.get('referer'), 'https://pan.baidu.com/disk/main');
    assert.equal(headers.has('user-agent'), false); assert.equal(headers.has('cookie'), false);
    return new Response('media', { status: 206 });
  } });
  const response = await service.fetchMedia('https://d.pcs.baidu.com/video', { signal, headers: { Range: 'bytes=100-199', 'User-Agent': 'pan.baidu.com' } });
  assert.equal(response.status, 206);
});
test('media uses Chromium login session, no-cache, native cookies and validated redirects', async () => {
  const browser = {getUserAgent: () => 'Browser UA'}; let followed = 0, request;
  const response = await fetchSessionMedia(browser, 'https://pcs.baidu.com/file', {headers: {Range:'bytes=0-1023',Cookie:'must-not-forward',Authorization:'must-not-forward'}}, options => {
    assert.equal(options.session,browser); assert.equal(options.credentials,'include'); assert.equal(options.cache,'no-store'); assert.equal(options.redirect,'manual'); assert.equal(options.referrerPolicy,'unsafe-url');
    assert.equal(options.headers.range,'bytes=0-1023'); assert.equal(options.headers['user-agent'],'Browser UA'); assert.equal(options.headers.cookie,undefined); assert.equal(options.headers.authorization,undefined);
    request = new EventEmitter(); request.abort = () => request.emit('close'); request.followRedirect = () => followed++;
    request.end = () => queueMicrotask(() => {
      request.emit('redirect',302,'GET','https://cdn.baidupcs.com/file');
      const incoming=new PassThrough(); incoming.statusCode=206; incoming.headers={'content-range':['bytes 0-1023/2048'],'set-cookie':['PRIVATE=cookie']};
      request.emit('response',incoming); incoming.end('chunk');
    }); return request;
  });
  assert.equal(response.status,206); assert.equal(await response.text(),'chunk'); assert.equal(followed,1); assert.equal(response.headers.has('set-cookie'),false);
  request.emit('close');
  await assert.rejects(fetchSessionMedia(browser,'https://pcs.baidu.com/file',{},() => {
    const denied = new EventEmitter(); denied.abort = () => denied.emit('close'); denied.followRedirect = () => assert.fail('must never follow an untrusted redirect');
    denied.end = () => queueMicrotask(() => denied.emit('redirect',302,'GET','https://untrusted.example/file')); return denied;
  }), /不支持的地址/);
});

test('media cancellation aborts the transport and errors do not expose signed URLs',async()=>{
  const controller=new AbortController(),browser={getUserAgent:()=> 'Browser UA'}; let request,aborted=false;
  const pending=fetchSessionMedia(browser,'https://pcs.baidu.com/file?sign=private',{signal:controller.signal},()=>{
    request=new EventEmitter(); request.end=()=>{}; request.abort=()=>{aborted=true;request.emit('close');}; return request;
  });
  controller.abort(new Error('cancelled')); await assert.rejects(pending,/cancelled/); assert.equal(aborted,true);
  await assert.rejects(fetchSessionMedia(browser,'https://pcs.baidu.com/file?sign=private',{},()=>{
    request=new EventEmitter(); request.abort=()=>request.emit('close'); request.end=()=>queueMicrotask(()=>request.emit('error',new Error('https://pcs.baidu.com/?sign=private'))); return request;
  }), error=> /媒体连接失败/.test(error.message)&&!error.message.includes('private'));
});

test('original-file metadata links use the selected path, preserve HDR bytes and require the download identity',async()=>{
  const store=memoryStore();store.data.items=[{source:'baidu',fsId:'987654321012345678',path:'/剧集/有空格 & 中文/1.DV.HDR.mkv'}];
  let metaCalls=0;
  const service=new BaiduWebService(store,{fetcher:async(input,options)=>{
    const url=new URL(input);
    if(url.pathname.includes('gettemplate'))return json({result:{bdstoken:'session',loginstate:1}});
    if(url.pathname==='/api/list')return json({list:[]});
    assert.equal(url.pathname,'/api/filemetas','must not fall back to the expired web download ticket');
    assert.equal(url.searchParams.get('target'),JSON.stringify([store.data.items[0].path])); assert.equal(url.searchParams.get('dlink'),'1');
    metaCalls++;return new Response('{"info":[{"fs_id":987654321012345678,"dlink":"https://d.pcs.baidu.com/file/original?sign=private"}]}');
  },mediaFetcher:async(url,options)=>{
    assert.equal(new Headers(options.headers).get('user-agent'),'pan.baidu.com');
    assert.equal(new Headers(options.headers).get('range'),'bytes=4294967296-4294967359');
    return new Response(new Uint8Array([0x1a,0x45,0xdf,0xa3]),{status:206});
  }});
  const link=await service.streamUrl('987654321012345678');
  const data=await service.fetchMedia(link,{headers:{Range:'bytes=4294967296-4294967359','User-Agent':'untrusted'}});
  assert.deepEqual([...new Uint8Array(await data.arrayBuffer())],[0x1a,0x45,0xdf,0xa3]);assert.equal(metaCalls,1);
  service.reset();assert.equal(service.mediaIdentities.size,0);
});

test('file metadata cannot silently select a different file or an untrusted link',async()=>{
  for(const info of [{fs_id:'456',dlink:'https://pcs.baidu.com/file'},{fs_id:'123',path:'/other',dlink:'https://pcs.baidu.com/file'},{fs_id:'123',dlink:'https://baidu.com.attacker.test/file'}]){
    const service=new BaiduWebService(memoryStore(),{fetcher:async input=>new URL(input).pathname==='/api/filemetas'?json({info:[info]}):assert.fail('no other API is expected')});
    service.variables={bdstoken:'session'};service.variablesAt=Date.now();
    await assert.rejects(service.streamUrl('123',{path:'/chosen'}),/不一致|无法识别/);
  }
});

test('rejected links force a fresh web-session check and signer without API cache',async()=>{
  let checks=0,signers=0;
  const service=new BaiduWebService(memoryStore(),{fetcher:async(input,options)=>{
    assert.equal(options.cache,'no-store'); const url=new URL(input);
    if(url.pathname.includes('gettemplate')){
      if(new URLSearchParams(options.body).get('fields').includes('sign1')) {signers++;return json({result:{sign1:'Plaintext',sign3:'Key',timestamp:signers}});}
      checks++;return json({result:{bdstoken:'session-'+checks,loginstate:1}});
    }
    if(url.pathname==='/api/download') {assert.equal(url.searchParams.get('bdstoken'),'session-'+checks);return json({dlink:[{dlink:'https://pcs.baidu.com/file'}]});}
    return json({list:[]});
  }});
  await service.streamUrl('123');await service.streamUrl('123');assert.equal(checks,1);
  await service.streamUrl('123',{refresh:true});assert.equal(checks,2);assert.equal(signers,3);
});
test('Trakt supports distributor configuration and cancels token exchange after disconnect', async () => {
  const store = memoryStore(); store.data.settings.traktClientId = ''; store.data.settings.traktRedirectUri = '';
  let complete;
  const trakt = new TraktService(store, { clientId: 'cloudreel-app', redirectUri: 'https://example.com/callback', fetcher: async () => new Promise(resolve => { complete = resolve; }) });
  assert.equal(trakt.configured(), true);
  const auth = new URL(trakt.beginAuth().url); assert.equal(auth.searchParams.get('client_id'), 'cloudreel-app');
  const exchange = trakt.completeAuth(`https://example.com/callback?code=ok&state=${auth.searchParams.get('state')}`);
  trakt.authorization = null; complete(json({ access_token: 'cancelled', refresh_token: 'refresh', expires_in: 3600 }));
  await assert.rejects(exchange, /取消/); assert.equal(store.secret('traktToken'), null);
});
