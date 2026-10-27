import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mergeLocalized, mergeLocalizedSeason} from '../electron/core/localization.mjs';
import {MetadataService} from '../electron/services/metadata.mjs';
import {createMetadataFetcher, metadataNetworkError} from '../electron/services/desktop-network.mjs';
import {memoryStore} from './helpers.mjs';

test('Simplified Chinese wins, missing fields use Traditional Chinese then English independently', () => {
  const merged=mergeLocalized({'zh-CN':{id:1,title:'星际穿越',overview:'',tagline:''},'zh-TW':{id:1,title:'星際效應',overview:'繁體中文簡介',tagline:''},'en-US':{id:1,title:'Interstellar',overview:'English overview',tagline:'An English tagline'}});
  assert.equal(merged.title,'星际穿越');assert.equal(merged.overview,'繁體中文簡介');assert.equal(merged.tagline,'An English tagline');assert.deepEqual(merged.metadataLanguages,{title:'zh-CN',overview:'zh-TW',tagline:'en-US'});
  assert.equal(mergeLocalized({'zh-CN':{title:'Interstellar'},'zh-TW':{title:'星際效應'},'en-US':{title:'Interstellar'}}).title,'星際效應');
});
test('each episode chooses its own translated name and overview, retaining season and episode IDs',()=>{
  const merged=mergeLocalizedSeason({'zh-CN':{episodes:[{id:1,episode_number:1,name:'简体片名',overview:''},{id:2,episode_number:2,name:'第 2 集',overview:'简体简介'}]},'zh-TW':{episodes:[{id:1,episode_number:1,name:'繁體片名',overview:'繁體簡介'},{id:2,episode_number:2,name:'真正的集名',overview:''}]},'en-US':{episodes:[{id:1,episode_number:1,name:'English',overview:'English'},{id:2,episode_number:2,name:'English 2',overview:'English 2'}]}});
  assert.equal(merged.episodes[0].name,'简体片名');assert.equal(merged.episodes[0].overview,'繁體簡介');assert.equal(merged.episodes[1].name,'真正的集名');assert.equal(merged.episodes[1].overview,'简体简介');assert.equal(merged.episodes[1].id,2);
});
test('localized TMDB requests follow zh-CN, zh-TW, en-US and preserve filled Chinese fields',async()=>{
  const calls=[],store=memoryStore();store.setSecret('tmdbToken','token');
  const service=new MetadataService(store,{cache:async()=>undefined},{fetcher:async url=>{const language=new URL(url).searchParams.get('language');calls.push(language);return new Response(JSON.stringify({id:1,title:language==='zh-CN'?'简体名称':language==='zh-TW'?'繁體名稱':'English',overview:language==='en-US'?'English synopsis':'',tagline:''}));}});
  const data=await service.localized('/movie/1');assert.deepEqual(calls,['zh-CN','zh-TW','en-US']);assert.equal(data.title,'简体名称');assert.equal(data.overview,'English synopsis');
  calls.length=0;service.clearCache();service.fetcher=async url=>{calls.push(new URL(url).searchParams.get('language'));return new Response(JSON.stringify({title:'完整中文片名',overview:'完整中文简介'}));};await service.localized('/movie/1');assert.deepEqual(calls,['zh-CN']);
});
test('desktop service transport uses Chromium, omits cookies and blocks redirects to third parties',async()=>{
  let sent;const fetcher=createMetadataFetcher({fetch:async(url,options)=>{sent={url,options};return new Response('{}');}});
  await fetcher('https://api.themoviedb.org/3/configuration',{headers:{Authorization:'Bearer TEST'},credentials:'include',redirect:'follow'});
  assert.equal(sent.options.credentials,'omit');assert.equal(sent.options.redirect,'error');assert.equal(sent.options.headers.Authorization,'Bearer TEST');
  assert.throws(()=>fetcher('https://evil.test/'),/不支持/);assert.throws(()=>fetcher('https://api.themoviedb.org.evil.test/'),/不支持/);assert.throws(()=>fetcher('http://api.themoviedb.org/'),/不支持/);
  assert.match(metadataNetworkError(new Error('net::ERR_PROXY_CONNECTION_FAILED')),/系统代理/);assert.match(metadataNetworkError(new Error('net::ERR_CERT_AUTHORITY_INVALID')),/安全连接/);assert.match(metadataNetworkError(new Error('sensitive-token-in-message')),/^无法连接元数据服务/);assert.ok(!metadataNetworkError(new Error('SECRET')).includes('SECRET'));
});

test('fallback fills taglines and retains episodes only present in a fallback language',async()=>{
  const store=memoryStore();store.setSecret('tmdbToken','token');const calls=[];
  const service=new MetadataService(store,{cache:async()=>undefined},{fetcher:async url=>{const language=new URL(url).searchParams.get('language');calls.push(language);return new Response(JSON.stringify({title:'中文片名',overview:'中文简介',tagline:language==='zh-TW'?'繁體宣傳語':''}));}});
  const data=await service.localized('/movie/1');assert.equal(data.tagline,'繁體宣傳語');assert.deepEqual(calls,['zh-CN','zh-TW']);
  const merged=mergeLocalizedSeason({'zh-CN':{episodes:[{id:1,episode_number:1,name:'第一集'}]},'en-US':{episodes:[{id:1,episode_number:1,name:'One'},{id:2,episode_number:2,name:'Two',overview:'English overview'}]}});
  assert.deepEqual(merged.episodes.map(e=>e.id),[1,2]);assert.equal(merged.episodes[0].name,'第一集');assert.equal(merged.episodes[1].name,'Two');
});
