import {test} from 'node:test';
import assert from 'node:assert/strict';
import {forgetWatchIdentity, historyBody, isWatched, watchTarget} from '../electron/core/watch-state.mjs';
import {applyTraktProgress} from '../electron/core/trakt-progress.mjs';
import {SyncService} from '../electron/services/sync.mjs';
import {TraktService} from '../electron/services/trakt.mjs';
import {memoryStore} from './helpers.mjs';

const ep = (episode, season = 1) => ({id: `${season}-${episode}`, kind: 'episode', season, episode, catalog: {source: 'tmdb', id: '60573'}});
const movie = {id: 'movie', kind: 'movie', catalog: {source: 'tmdb', id: '550'}};
const at = '2026-10-24T12:00:00.000Z';
const connected = () => {const store = memoryStore(); store.setSecret('traktToken', {access_token: 'test', expiresAt: Date.now() + 3600000}); return store;};

test('rematching clears orphan pending indicators on duplicate copies while preserving unrelated work', () => {
  const store = memoryStore(), first = {...ep(1), watchState: {pending: true, jobId: 'job'}}, alias = {...first, id: 'alias'}, other = {...ep(2), watchState: {pending: true, jobId: 'job'}};
  store.data.items = [first, alias, other];
  store.data.watchPending = [{id: 'job', itemIds: ['1-1', 'alias', '1-2'], targets: [watchTarget(first), watchTarget(other)]}];
  forgetWatchIdentity(store, ['1-1']);
  assert.equal(first.watchState, undefined); assert.equal(alias.watchState, undefined); assert.equal(other.watchState.pending, true);
  assert.equal(store.data.watchPending[0].targets.length, 1);
});

test('history payloads target exact episodes across seasons, preserve specials, deduplicate, and never identify by title', () => {
  const targets = [ep(1), ep(2), ep(1, 0), movie, ep(1)].map(watchTarget);
  const body = historyBody(targets, at);
  assert.deepEqual(body.movies, [{ids: {tmdb: 550}, watched_at: at}]);
  assert.deepEqual(body.shows, [{ids: {tmdb: 60573}, seasons: [{number: 1, episodes: [{number: 1, watched_at: at}, {number: 2, watched_at: at}]}, {number: 0, episodes: [{number: 1, watched_at: at}]}]}]);
  assert.equal(watchTarget({kind: 'episode', title: '硅谷', season: 1, episode: 1}), null);
  assert.deepEqual(watchTarget({...ep(1), metadata: {ids: {trakt: 123}}}), {kind: 'episode', ids: {trakt: 123}});
  assert.equal(watchTarget({...ep(1), episode: undefined}), null);
});

test('manual marks survive stale pulls, clear old resume, and sync even with automatic syncing disabled', async () => {
  const store = connected(); store.data.items = [ep(1), ep(2), ep(3, 2)]; store.data.settings.autoSync = false;
  let release; const calls = [];
  const sync = new SyncService(store, {setWatched: async (...args) => {calls.push(args); await new Promise(resolve => {release = resolve;});}});
  const operation = sync.markWatched({ids: ['1-1', '1-2'], watched: true});
  assert.equal(store.data.watchPending.length, 1); assert.ok(isWatched(store.item('1-1'))); assert.equal(isWatched(store.item('2-3')), false);
  applyTraktProgress(store.data.items, {playback: [], watchedShows: []}); assert.ok(isWatched(store.item('1-1')));
  release(); assert.equal((await operation).pending, false); assert.equal(store.data.watchPending.length, 0); assert.equal(calls[0][0].length, 2);
  assert.equal(store.item('1-1').progress.percent, 100);
  const syncedAt = store.item('1-1').watchState.syncedAt;
  applyTraktProgress(store.data.items, {playback: [], watchedShows: []}, {now: Date.parse(syncedAt) + 1000}); assert.ok(isWatched(store.item('1-1')));
  applyTraktProgress(store.data.items, {playback: [], watchedShows: []}, {now: Date.parse(syncedAt) + 61000}); assert.equal(isWatched(store.item('1-1')), false);
});

test('unwatch queues on failure, persists intent for retry, and rejects an invalid selection atomically', async () => {
  const store = connected(); store.data.items = [{...movie, progress: {percent: 100, position: 600, duration: 600, updatedAt: at}}]; let failing = true;
  const sync = new SyncService(store, {setWatched: async () => {if (failing) throw new Error('offline');}});
  const result = await sync.markWatched({ids: ['movie'], watched: false});
  assert.equal(result.pending, true); assert.equal(store.item('movie').progress.position, 0); assert.equal(isWatched(store.item('movie')), false);
  assert.equal(store.data.watchPending.length, 1); failing = false; await sync.flush(); assert.equal(store.data.watchPending.length, 0); assert.equal(store.item('movie').watchState.pending, false);
  store.data.items.push({id: 'unknown', kind: 'movie'});
  await assert.rejects(sync.markWatched({ids: ['movie', 'unknown'], watched: true}), /匹配/); assert.equal(isWatched(store.item('movie')), false);
  const playing = new SyncService(store, {}, () => {}, () => 'movie'); await assert.rejects(playing.markWatched({ids: ['movie'], watched: true}), /退出/);
});

test('local-only marking does not call Trakt and explicit unwatched beats an old completed position', async () => {
  const store = memoryStore(); store.data.items = [structuredClone(movie)];
  const sync = new SyncService(store, {setWatched: () => assert.fail('unexpected remote write')});
  assert.equal((await sync.markWatched({ids: ['movie'], watched: true})).connected, false); assert.ok(isWatched(store.item('movie')));
  await sync.markWatched({ids: ['movie'], watched: false}); assert.equal(isWatched(store.item('movie')), false);
  assert.equal(isWatched({watchHistory: {watched: true, checkedAt: at}, progress: {percent: 10, updatedAt: at}}), true);
});

test('Trakt history additions are safe to retry after a lost success response and delete only older matching resume points', async () => {
  const store = connected(); let watched = false, posts = 0; const deletes = [];
  const service = new TraktService(store, {fetcher: async (input, options) => {
    const url = new URL(input), route = url.pathname;
    const json = value => new Response(JSON.stringify(value), {headers: {'content-type': 'application/json'}});
    if (route === '/search/tmdb/550') return json([{type: 'movie', movie: {ids: {trakt: 1, tmdb: 550}}}]);
    if (route === '/sync/watched/movies') return json(watched ? [{plays: 1, movie: {ids: {trakt: 1, tmdb: 550}}}] : []);
    if (route === '/sync/history') {posts++; watched = true; throw new Error('response lost');}
    if (route === '/sync/playback/movies') return json([{id: 9, movie: {ids: {trakt: 1}}, paused_at: '2026-10-23T00:00:00Z'}, {id: 10, movie: {ids: {trakt: 1}}, paused_at: '2026-10-25T00:00:00Z'}, {id: 11, movie: {ids: {trakt: 2}}, paused_at: at}]);
    if (route.startsWith('/sync/playback/') && options.method === 'DELETE') {deletes.push(route); return new Response(null, {status: 204});}
    assert.fail(`unexpected route ${route}`);
  }});
  const targets = [watchTarget(movie)]; await assert.rejects(service.setWatched(targets, true, at), /无法连接/);
  await service.setWatched(targets, true, at); assert.equal(posts, 1); assert.deepEqual(deletes, ['/sync/playback/9']);
});

test('Trakt season writes include only selected unwatched episodes and unwatch uses history removal', async () => {
  const store = connected(), bodies = [];
  const service = new TraktService(store, {fetcher: async (input, options) => {
    const route = new URL(input).pathname, json = value => new Response(JSON.stringify(value));
    if (route === '/search/tmdb/60573') return json([{type: 'show', show: {ids: {trakt: 10, tmdb: 60573}}}]);
    if (route === '/shows/10/progress/watched') return json({seasons: [{number: 1, episodes: [{number: 1, completed: true}, {number: 2, completed: false}]}]});
    if (route === '/sync/history' || route === '/sync/history/remove') {bodies.push([route, JSON.parse(options.body)]); return json({not_found: {movies: [], episodes: [], shows: []}});}
    if (route === '/sync/playback/episodes') return json([]);
    assert.fail(route);
  }});
  await service.setWatched([ep(1), ep(2)].map(watchTarget), true, at);
  assert.deepEqual(bodies[0][1].shows[0].seasons[0].episodes, [{number: 2, watched_at: at}]);
  await service.setWatched([ep(1), ep(2)].map(watchTarget), false, at);
  assert.equal(bodies[1][0], '/sync/history/remove'); assert.deepEqual(bodies[1][1].shows[0].seasons[0].episodes, [{number: 1}, {number: 2}]);
});


test('mixed direct and show-based copies of one episode add only one Trakt play', async () => {
  const store = connected(), bodies = [];
  const service = new TraktService(store, {fetcher: async (input, options) => {
    const route = new URL(input).pathname;
    const json = value => new Response(JSON.stringify(value), {headers: {'content-type': 'application/json'}});
    if (route === '/search/tmdb/60573') return json([{type: 'show', show: {ids: {trakt: 10, tmdb: 60573}}}]);
    if (route === '/shows/10/seasons/1/episodes/1') return json({ids: {trakt: 999}});
    if (route === '/shows/10/progress/watched') return json({seasons: []});
    if (route === '/users/me/history/episodes/999') return json([]);
    if (route === '/sync/history') {bodies.push(JSON.parse(options.body)); return json({not_found: {}});}
    if (route === '/sync/playback/episodes') return json([]);
    assert.fail(route);
  }});
  await service.setWatched([watchTarget(ep(1)), {kind: 'episode', ids: {trakt: 999}}], true, at);
  assert.equal(bodies.length, 1); assert.equal(bodies[0].episodes.length, 1); assert.equal(bodies[0].shows, undefined);
});
