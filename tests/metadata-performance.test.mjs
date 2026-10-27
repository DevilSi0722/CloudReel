import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {MetadataService} from '../electron/services/metadata.mjs';
import {ArtworkCache} from '../electron/services/artwork.mjs';
import {memoryStore} from './helpers.mjs';
const json = value => new Response(JSON.stringify(value));
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {let resolve; const promise = new Promise(done => {resolve = done;}); return {promise, resolve};};
const storeWithToken = () => {const store = memoryStore(); store.setSecret('tmdbToken', 'test-only'); return store;};
const show = {id: 123, name: '中文剧名', overview: '中文简介', poster_path: '/poster.jpg', backdrop_path: '/backdrop.jpg', first_air_date: '2020-01-01'};

test('TMDB coalesces concurrent requests, isolates cached objects, expires entries and refreshes explicitly', async () => {
  let requests = 0; const gate = deferred(), store = storeWithToken();
  const service = new MetadataService(store, {}, {fetcher: async () => {requests++; await gate.promise; return json(show);}});
  const a = service.tmdb('/tv/123'), b = service.tmdb('/tv/123'); await tick(); assert.equal(requests, 1); gate.resolve();
  const [first, second] = await Promise.all([a, b]); first.name = 'changed'; assert.equal(second.name, show.name);
  assert.equal((await service.tmdb('/tv/123')).name, show.name); assert.equal(requests, 1);
  service.requests.values().next().value.expires = 0; await service.tmdb('/tv/123'); assert.equal(requests, 2);
  service.clearCache(); await service.tmdb('/tv/123'); assert.equal(requests, 3);
  await service.test(); await service.test(); assert.equal(requests, 5, 'connection tests must actually contact the service');
  store.setSecret('tmdbToken', 'replacement'); await service.tmdb('/tv/123'); assert.equal(requests, 6);
});

test('TMDB API concurrency is bounded and cancelling queued work never sends it', async () => {
  const gate = deferred(), started = [], controller = new AbortController();
  const service = new MetadataService(storeWithToken(), {}, {fetcher: async url => {started.push(url); await gate.promise; return json(show);}});
  const requests = Array.from({length: 9}, (_, n) => service.tmdb('/tv/' + n, {}, {signal: controller.signal}));
  const settled = Promise.allSettled(requests); await tick(); assert.equal(started.length, 3);
  controller.abort(); gate.resolve(); await settled; assert.equal(started.length, 3);
  assert.equal(service.requests.size, 0, 'cancelled responses never populate the cache');
});

test('episode metadata publishes before images, with bounded parallel episode art', async () => {
  const store = storeWithToken(), gate = deferred(); let active = 0, peak = 0;
  store.data.items = Array.from({length: 12}, (_, index) => ({id: String(index), kind: 'episode', title: show.name, season: 1, episode: index + 1, progress: {position: 42}}));
  const service = new MetadataService(store, {cache: async url => {if (!url) return; active++; peak = Math.max(peak, active); await gate.promise; active--; return 'cloudreel-art://cache/test';}}, {
    fetcher: async url => json(url.includes('/season/') ? {episodes: store.data.items.map(item => ({id: Number(item.id) + 1, episode_number: item.episode, name: '中文集名', overview: '中文分集简介', still_path: '/still' + item.id + '.jpg'}))} : show)
  });
  const work = service.apply(store.data.items.map(item => item.id), {source: 'tmdb', id: '123', kind: 'episode'}, true);
  await tick(); assert.ok(store.data.items.every(item => item.catalog?.title === show.name && item.catalog?.id === '123'));
  assert.ok(store.data.items.every(item => item.episodeMetadata?.title === '中文集名'));
  assert.ok(active >= 4, 'stills download together instead of one per episode'); gate.resolve(); await work;
  assert.ok(peak <= 6, 'only two cover tasks and four episode workers at a time');
  assert.ok(store.data.items.every(item => item.episodeMetadata.still && item.progress.position === 42));
});

test('real image cache bounds downloads, deduplicates subscribers and cancels only unneeded work', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'cloudreel-art-pool-')); const gate = deferred(); let active = 0, peak = 0, aborted = 0;
  const cache = new ArtworkCache(directory, async (_, {signal}) => {
    active++; peak = Math.max(peak, active);
    try {await Promise.race([gate.promise, new Promise((_, reject) => signal.addEventListener('abort', () => {aborted++; reject(signal.reason);}, {once: true}))]);
      return new Response(new Uint8Array([0x89, 0x50]), {headers: {'content-type': 'image/png'}});
    } finally {active--;}
  });
  try {
    const controller = new AbortController(), shared = 'https://image.tmdb.org/t/p/w300/shared.png';
    const cancelled = cache.cache(shared, {signal: controller.signal}); const rejection = assert.rejects(cancelled, {name: 'AbortError'});
    const retained = cache.cache(shared); await tick(); controller.abort(); await rejection; assert.equal(aborted, 0);
    const more = Array.from({length: 10}, (_, n) => cache.cache(`https://image.tmdb.org/t/p/w300/${n}.png`)); await tick(); assert.equal(active, 4);
    gate.resolve(); await Promise.all([retained, ...more]); assert.equal(peak, 4);
    const stop = new AbortController(); const canceledQueue = Array.from({length: 8}, (_, n) => cache.cache(`https://image.tmdb.org/t/p/w300/cancel${n}.png`, {signal: stop.signal}));
    const settled = Promise.allSettled(canceledQueue); stop.abort(); await settled; await tick();
    assert.equal(cache.pool.active, 0); assert.equal(cache.pool.queue.length, 0);
  } finally {rmSync(directory, {recursive: true});}
});

test('stopping a metadata run aborts its HTTP request without recording a network failure', async () => {
  const store = storeWithToken(); store.data.items = [{id: 'a', kind: 'movie', title: '中文片名', filename: '中文片名.2020.mp4', path: '/中文片名.2020.mp4', catalog: {source: 'tmdb', id: '1'}}];
  let requests = 0;
  const service = new MetadataService(store, {}, {fetcher: async (_, {signal}) => {requests++; return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), {once: true}));}});
  const work = service.run({refresh: true}); await tick(); assert.equal(requests, 1); service.cancel(); await work;
  assert.equal(service.progress.failed, 0); assert.equal(service.status().running, false); assert.equal(service.tmdbError, undefined);
});

test('refreshes reuse known IDs and process distinct films concurrently without altering progress', async () => {
  const store = storeWithToken(), gate = deferred(), requested = [];
  store.data.items = [1, 2, 3, 4].map(id => ({id: String(id), kind: 'movie', title: `电影${id}`, filename: `电影${id}.2020.mp4`, path: `/电影${id}.2020.mp4`, catalog: {source: 'tmdb', id: String(id)}, progress: {position: id * 10}}));
  const service = new MetadataService(store, {cache: async () => undefined}, {fetcher: async url => {requested.push(url); await gate.promise; return json({id: Number(new URL(url).pathname.split('/').at(-1)), title: '中文片名', overview: '中文简介'});}});
  const work = service.run({refresh: true}); await tick(); assert.equal(requested.length, 3); assert.ok(requested.every(url => !url.includes('/search/'))); gate.resolve(); await work;
  assert.equal(service.progress.matched, 4); assert.equal(service.progress.done, 4); assert.deepEqual(store.data.items.map(item => item.progress.position), [10, 20, 30, 40]);
});

test('cancelled progressive matches resume enrichment on the next normal run', async () => {
  const store = storeWithToken(); store.data.items = [{id: 'a', kind: 'movie', title: '中文片名', filename: '中文片名.2020.mp4', path: '/中文片名.2020.mp4', catalog: {source: 'tmdb', id: '123'}}];
  let waitForArt = true;
  const service = new MetadataService(store, {cache: async (_, {signal}) => {
    if (!waitForArt) return 'cloudreel-art://cache/test';
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), {once: true}));
  }}, {fetcher: async () => json({...show, title: show.name})});
  const first = service.run({refresh: true}); await tick(); assert.equal(store.item('a').catalog.pending, true); service.cancel(); await first;
  waitForArt = false; await service.run(); assert.equal(service.progress.total, 1); assert.equal(store.item('a').catalog.pending, undefined); assert.ok(store.item('a').catalog.poster);
});

test('failed artwork is briefly backed off without retrying the same unavailable image', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'cloudreel-art-backoff-')); let requests = 0;
  const cache = new ArtworkCache(directory, async () => {requests++; return new Response(null, {status: 404});});
  try {
    const url = 'https://image.tmdb.org/t/p/w300/unavailable.png'; await cache.cache(url); await cache.cache(url); assert.equal(requests, 1);
    cache.failed.clear(); await cache.cache(url); assert.equal(requests, 2);
  } finally {rmSync(directory, {recursive: true});}
});

test('TMDB Retry-After stops queued requests and remains cancellable', async () => {
  let calls = 0;
  const service = new MetadataService(storeWithToken(), {}, {fetcher: async () => {calls++; return new Response(null, {status: 429, headers: {'retry-after': '10'}});}});
  await assert.rejects(service.tmdb('/movie/1'), /429/); assert.ok(service.tmdbRetryAt > Date.now() + 9000);
  const controller = new AbortController(), queued = service.tmdb('/movie/2', {}, {signal: controller.signal});
  const rejection = assert.rejects(queued, {name: 'AbortError'}); await tick(); assert.equal(calls, 1); controller.abort(); await rejection;
});
