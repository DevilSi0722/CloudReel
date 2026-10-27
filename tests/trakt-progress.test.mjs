import {test} from 'node:test';
import assert from 'node:assert/strict';
import {applyTraktProgress, matchesTraktEntry, matchesTraktShow} from '../electron/core/trakt-progress.mjs';
import {chooseResume} from '../electron/core/media.mjs';
import {jsonRequest} from '../electron/core/http.mjs';
import {SyncService} from '../electron/services/sync.mjs';
import {memoryStore} from './helpers.mjs';

const before = '2026-10-23T12:00:00Z', after = '2026-10-24T12:00:00Z';
const show = {title: 'Silicon Valley', ids: {trakt: 60157, tmdb: 60573}};
const file = (episode = 4) => ({id: `episode-${episode}`, kind: 'episode', title: '硅谷', season: 2, episode, catalog: {source: 'tmdb', id: '60573'}});
const entry = (progress = 55.0887) => ({show, episode: {season: 2, number: 4, title: 'The Lady', ids: {trakt: 1780386}}, progress, paused_at: after});

test('an unplayed episode matches by TMDB show, season and episode and retains Chinese metadata', () => {
  const item = file(); item.episodeMetadata = {title: '女士'};
  assert.ok(matchesTraktEntry(item, entry()));
  assert.equal(matchesTraktEntry(file(3), entry()), false);
  assert.equal(matchesTraktEntry({...file(), season: 1}, entry()), false);
  assert.equal(matchesTraktEntry({...file(), catalog: {...file().catalog, id: '999'}}, entry()), false);
  const summary = applyTraktProgress([item], {playback: [entry()]});
  assert.equal(summary.positions, 1); assert.equal(item.remoteProgress.progress, 55.0887);
  assert.equal(item.metadata.ids.trakt, 1780386); assert.equal(item.metadata.showIds.trakt, 60157);
  assert.equal(item.title, '硅谷'); assert.equal(item.episodeMetadata.title, '女士'); assert.equal(item.progress, undefined);
});

test('manual identities are respected and movie IDs never match series IDs', () => {
  assert.equal(matchesTraktEntry({...file(), metadata: {type: 'episode', ids: {trakt: 123}}}, entry()), false);
  assert.equal(matchesTraktEntry({...file(), kind: 'movie'}, entry()), false);
  assert.ok(matchesTraktEntry({kind:'movie', catalog:{source:'tmdb',id:'550'}}, {movie:{ids:{tmdb:550,trakt:1}}}));
  assert.equal(matchesTraktShow({...file(), metadata:{ids:{trakt:1780386},showIds:{trakt:77}}},show),false);
});

test('watching status never fabricates a percentage and a 204 is a valid empty response', async () => {
  const item=file(), watching={...entry(),started_at:before,expires_at:'2026-10-25T12:00:00Z'};
  delete watching.progress; delete watching.paused_at;
  const state=applyTraktProgress([item],{playback:[],watching},{now:Date.parse(after)});
  assert.equal(state.watching.itemId,item.id);assert.equal(item.remoteProgress,undefined);
  assert.equal(item.remoteWatching.startedAt,before);
  applyTraktProgress([item],{playback:[],watching:null});assert.equal(item.remoteWatching,undefined);
  assert.equal(await jsonRequest('https://example.com',{},async()=>new Response(null,{status:204})),null);
});

test('fresh remote completion prevents stale local resume, while a newer rewatch wins', () => {
  const item=file(3);item.progress={position:100,percent:10,updatedAt:before};
  const watchedShows=[{show,last_watched_at:after,seasons:[{number:2,episodes:[{number:3,plays:1,last_watched_at:after}]}],next_episode:{season:2,number:4}}];
  const next=file();applyTraktProgress([item,next],{playback:[],watchedShows});
  assert.equal(item.remoteProgress.progress,100);assert.equal(chooseResume(item.progress,item.remoteProgress),null);
  assert.equal(next.remoteNext.watchedAt,after);
  const replay={...entry(20),episode:{...entry().episode,number:3},paused_at:'2026-10-25T12:00:00Z'};
  applyTraktProgress([item],{playback:[replay],watchedShows});assert.equal(item.remoteProgress.progress,20);
});

test('removed resume points clear stale caches and active local playback is never overwritten', () => {
  const a=file(), b={...file(),id:'active'};
  a.remoteProgress={progress:30,paused_at:before}; b.remoteProgress={progress:40,paused_at:before};
  applyTraktProgress([a,b],{playback:[],watching:null},{activeItemId:'active'});
  assert.equal(a.remoteProgress,undefined);assert.equal(b.remoteProgress.progress,40);
  a.remoteProgress={progress:100,paused_at:before,source:'history'};
  applyTraktProgress([a],{playback:[],watchedShows:[{show}]});assert.equal(a.remoteProgress.progress,100);
});

test('pull handles missing seasons, caches show history and does not upload imported progress', async () => {
  const store=memoryStore();store.setSecret('traktToken',{access_token:'test'});store.data.items=[file(),file(3)];
  let reads=0;
  const trakt={playback:async type=>type==='episode'?[entry()]:[], watching:async()=>null,
    watched:async type=>type==='episode'?[{show,last_watched_at:before}]:[],
    showProgress:async()=>{reads++;return {seasons:[{number:2,episodes:[{number:3,completed:true,last_watched_at:before}]}],next_episode:{season:2,number:4}};}};
  const sync=new SyncService(store,trakt);await sync.pull();await sync.pull();
  assert.equal(reads,1);assert.equal(store.data.traktSync.positions,1);assert.equal(store.data.traktSync.watched,1);
  assert.equal(store.data.items[1].remoteProgress.progress,100);assert.equal(store.data.pending.length,0);
});

test('disconnect cancels a delayed pull, disabling auto sync skips background pulls', async () => {
  const store=memoryStore();store.setSecret('traktToken',{});store.data.items=[file()];
  let finish;
  const trakt={playback:async type=>type==='episode'?new Promise(resolve=>{finish=resolve;}):[],watched:async()=>[],watching:async()=>null};
  const sync=new SyncService(store,trakt);const pending=sync.pull();sync.reset();store.setSecret('traktToken',null);finish([entry()]);await pending;
  assert.equal(store.data.items[0].remoteProgress,undefined);assert.equal(store.data.traktSync,undefined);
  store.setSecret('traktToken',{});store.data.settings.autoSync=false;await sync.pull();assert.equal(sync.pulling,null);
});

test('unavailable watched history does not prevent saved positions being imported', async () => {
  const store=memoryStore();store.setSecret('traktToken',{});store.data.items=[file()];
  const trakt={playback:async type=>type==='episode'?[entry()]:[],watched:async()=>{throw new Error('offline');},watching:async()=>null};
  await new SyncService(store,trakt).pull();
  assert.equal(store.data.items[0].remoteProgress.progress,55.0887);assert.ok(store.data.traktSync.warning);assert.equal(store.data.traktSync.error,null);
});
