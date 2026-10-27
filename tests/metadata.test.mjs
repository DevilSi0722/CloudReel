import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MetadataService, matchScore } from '../electron/services/metadata.mjs';
import { ArtworkCache, isArtworkUrl } from '../electron/services/artwork.mjs';
import { Store } from '../electron/core/store.mjs';
import { PlayerService } from '../electron/services/player.mjs';
import { TraktService } from '../electron/services/trakt.mjs';
import { memoryStore } from './helpers.mjs';
const json = value => new Response(JSON.stringify(value), {headers: {'content-type':'application/json'}});
const artwork = {cache: async url => url ? 'cloudreel-art://cache/test' : undefined};
test('TMDB is preferred with a bearer token; public fallback never receives credentials', async () => {
  const store = memoryStore(); store.setSecret('tmdbToken', 'PRIVATE-TOKEN'); let calls = [];
  const metadata = new MetadataService(store, artwork, {fetcher: async (url, options) => {calls.push({url, headers:options.headers}); return json({results:[{id:157336,title:'星际穿越',original_title:'Interstellar',release_date:'2014-11-05'}]});}});
  const result = await metadata.search('Interstellar'); assert.equal(result[0].source,'tmdb'); assert.equal(calls.length,1); assert.equal(calls[0].headers.Authorization,'Bearer PRIVATE-TOKEN');
  assert.match(calls[0].url,/language=zh-CN/);
  calls=[]; metadata.clearCache(); metadata.fetcher=async (url, options) => {calls.push({url,headers:options.headers}); if(url.includes('themoviedb')) return new Response('',{status:401}); return json([{id:'1889243',title:'星际穿越',sub_title:'Interstellar',year:'2014',img:'https://img1.doubanio.com/example.jpg'}]);};
  assert.equal((await metadata.search('Interstellar'))[0].source,'douban'); assert.equal(calls[1].headers.Authorization,undefined);
  await assert.rejects(metadata.search('Interstellar','movie','tmdb'),/Token 无效/);
});
test('TMDB detail attaches per-episode metadata without changing playback progress or Trakt identity', async () => {
  const store=memoryStore();store.setSecret('tmdbToken','token');store.data.items=[{id:'a',kind:'episode',title:'Severance',season:2,episode:1,progress:{position:100},metadata:{ids:{trakt:7}}}];
  const metadata=new MetadataService(store,artwork,{fetcher:async url=>url.includes('/season/')?json({episodes:[{id:45,episode_number:1,name:'你好，Ms. Cobel',runtime:48,still_path:'/still.jpg'}]}):json({id:95396,name:'人生切割术',first_air_date:'2022-02-18',poster_path:'/poster.jpg',genres:[{name:'悬疑'}],credits:{cast:[{name:'Adam Scott'}]},external_ids:{imdb_id:'tt11280740'}})});
  await metadata.apply(['a'],{source:'tmdb',id:'95396',kind:'episode'},true);const item=store.item('a');assert.equal(item.catalog.source,'tmdb');assert.equal(item.episodeMetadata.title,'你好，Ms. Cobel');assert.equal(item.progress.position,100);assert.equal(item.metadata.ids.trakt,7);assert.equal(item.identificationLocked,true);
  assert.ok(matchScore({kind:'episode',title:'人生切割术',year:2025},{kind:'episode',title:'人生切割术',year:2022})>=.9);
  assert.ok(matchScore({kind:'movie',title:'Dune',year:1984},{kind:'movie',title:'Dune',year:2021})<.82);
});

test('matching handles bilingual titles, common English variants, typos, years and explicit regional editions',()=>{
  for (const [title,original] of [['阿甘正传 Forrest Gump','Forrest Gump'],['Lilo and Stitch','Lilo & Stitch'],['F1 The Movie','F1'],['Deadpool & Wolfrine','Deadpool & Wolverine']]) {
    assert.ok(matchScore({kind:'movie',title,year:2025},{kind:'movie',title:'译名',originalTitle:original,year:2025})>=.82,title);
  }
  const item={kind:'movie',title:'Elemental',year:2023};
  assert.ok(matchScore(item,{kind:'movie',title:'Elemental',year:2023})-matchScore(item,{kind:'movie',title:'Elemental'})>=.05);
  assert.ok(matchScore(item,{kind:'movie',title:'Elemental',year:2023})-matchScore(item,{kind:'movie',title:'Elemental',year:2024})>=.05);
  const show={kind:'episode',title:'无耻之徒',searchTitles:['无耻之徒','Shameless U S']};
  assert.equal(matchScore(show,{kind:'episode',title:'无耻之徒',originCountries:['US']}),1);
  assert.ok(matchScore(show,{kind:'episode',title:'无耻之徒',originCountries:['GB']})<.82);
  assert.equal(matchScore({kind:'episode',title:'The Last of Us'},{kind:'episode',title:'The Last of Us',originCountries:['GB']}),.9);
  assert.ok(matchScore({kind:'movie',title:'Alien',year:1979},{kind:'movie',title:'Aliens',year:1986})<.82);
});
test('saving TMDB credentials trims bearer prefix, encrypts, preserves blank input and supports removal',()=>{
  const directory=mkdtempSync(path.join(tmpdir(),'cloudreel-token-'));
  try{const crypto={isEncryptionAvailable:()=>true,encryptString:s=>Buffer.from(Buffer.from(s).toString('base64')),decryptString:b=>Buffer.from(b.toString(),'base64').toString()};const store=new Store(directory,crypto);
    store.saveSettings({tmdbToken:' Bearer PRIVATE-TOKEN '});assert.equal(store.secret('tmdbToken'),'PRIVATE-TOKEN');assert.ok(store.snapshot().hasTmdbToken);assert.ok(!JSON.stringify(store.snapshot()).includes('PRIVATE-TOKEN'));assert.ok(!readFileSync(store.file,'utf8').includes('PRIVATE-TOKEN'));
    store.saveSettings({tmdbToken:''});assert.equal(store.secret('tmdbToken'),'PRIVATE-TOKEN');assert.throws(()=>store.saveSettings({tmdbToken:2,rootDir:'/changed'}));assert.equal(store.data.settings.rootDir,'/');store.saveSettings({clearTmdbToken:true});assert.equal(store.secret('tmdbToken'),null);
  }finally{rmSync(directory,{recursive:true});}
});

test('changing an incorrect catalog match clears old Trakt identity and queued checkpoints, preserving local progress',async()=>{
  const store=memoryStore();store.data.items=[{id:'a',kind:'movie',title:'旧片名',catalog:{source:'tmdb',id:'1'},metadata:{ids:{tmdb:1,trakt:9}},remoteProgress:{progress:50},progress:{position:80}}];store.data.pending=[{itemId:'a'},{itemId:'b'}];
  const service=new MetadataService(store,artwork);service.detail=async()=>({source:'tmdb',id:'2',kind:'movie',title:'新片名'});
  await service.apply(['a'],{source:'tmdb',id:'2',kind:'movie'},true);
  assert.equal(store.item('a').metadata,undefined);assert.equal(store.item('a').remoteProgress,undefined);assert.equal(store.item('a').progress.position,80);assert.deepEqual(store.data.pending,[{itemId:'b'}]);
});

test('unrated ambiguous new records remain available for manual matching without being applied automatically',async()=>{
  const store=memoryStore();store.setSecret('tmdbToken','token');store.data.items=[{id:'a',kind:'movie',filename:'Trapped.2025.mp4',path:'/Movies/Trapped.2025.mp4',title:'Trapped',year:2025}];
  const service=new MetadataService(store,artwork,{fetcher:async()=>json({results:[{id:1,title:'Trapped',original_title:'Trapped',release_date:'2025-01-01',vote_count:0}]})});
  await service.run();assert.equal(store.item('a').catalog,undefined);assert.equal((await service.search('Trapped'))[0].id,'1');
});
test('artwork is cached once, serves image bytes and rejects untrusted URLs and traversal',async()=>{
  const directory=mkdtempSync(path.join(tmpdir(),'cloudreel-art-'));let requests=0;
  try {const cache=new ArtworkCache(directory,async()=>{requests++;return new Response(new Uint8Array([0x89,0x50,0x4e,0x47]),{headers:{'content-type':'image/png'}});});const [a,b]=await Promise.all([cache.cache('https://image.tmdb.org/t/p/w500/test.png'),cache.cache('https://image.tmdb.org/t/p/w500/test.png')]);assert.equal(a,b);assert.equal(requests,1);assert.equal(cache.response(a).headers.get('content-type'),'image/png');assert.equal(await cache.cache('http://127.0.0.1/private'),undefined);assert.equal(isArtworkUrl('https://image.tmdb.org.evil.test/a'),false);assert.equal(cache.response('cloudreel-art://cache/../../state.json').status,404);
  }finally{rmSync(directory,{recursive:true});}
});
test('player controls clamp seeking and volume and select adjacent distinct episodes',()=>{
  const store=memoryStore();store.data.items=[{id:'a',kind:'episode',title:'剧名',season:1,episode:1},{id:'b',kind:'episode',title:'剧名',season:1,episode:1},{id:'c',kind:'episode',title:'剧名',season:1,episode:2}];
  store.data.items.forEach(item => { item.filename = item.id + '.mp4'; });
  const service=new PlayerService(store,{},{},{},{resolveMpv:()=>''});const commands=[];service.session={item:store.item('a'),duration:100,tracks:[{id:2,type:'audio'}],socket:{write:v=>commands.push(JSON.parse(v).command)}};
  service.seek(500);service.control({volume:-2,speed:1.5,aid:2});assert.deepEqual(commands,[['seek',100,'absolute+exact'],['set_property','speed',1.5],['set_property','volume',0],['set_property','aid',2]]);assert.throws(()=>service.control({speed:20}));assert.throws(()=>service.control({sid:100}));assert.equal(service.nextItem(store.item('a')).id,'c');assert.equal(service.nextItem(store.item('a'),-1),null);
});
test('TMDB show IDs resolve to the correct Trakt episode without replacing localized titles',async()=>{
  const store=memoryStore(), calls=[];
  const item={id:'a',kind:'episode',title:'人生切割术',season:2,episode:3,catalog:{source:'tmdb',id:'95396'}};store.data.items=[item];
  const trakt=new TraktService(store,{fetcher:async url=>{calls.push(url);return json(url.includes('/search/')?[{type:'show',show:{ids:{trakt:123,tmdb:95396}}}]:url.includes('/episodes/')?{title:'Who Is Alive?',ids:{trakt:456,tmdb:55}}:{title:'Severance',ids:{trakt:123,tmdb:95396},year:2022});}});
  await trakt.resolveCatalog(item);assert.equal(item.metadata.ids.trakt,456);assert.equal(item.metadata.showIds.tmdb,95396);assert.equal(item.title,'人生切割术');assert.ok(calls.some(url=>url.includes('/seasons/2/episodes/3')));
});
