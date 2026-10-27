import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chooseTitleArt, titleArtDue} from '../electron/core/title-art.mjs';
import {MetadataService} from '../electron/services/metadata.mjs';
import {memoryStore} from './helpers.mjs';

const logo = (language, name, votes = 8) => ({iso_639_1: language, file_path: `/${name}.png`, width: 800, height: 300, vote_average: votes, vote_count: 10});
const json = value => new Response(JSON.stringify(value), {headers: {'content-type': 'application/json'}});
test('title art prefers Chinese scripts before English and accepts only valid transparent PNG paths', () => {
  const input = [logo('en', 'english', 10), logo('zh-TW', 'traditional'), logo('zh', 'chinese'), logo('zh-CN', 'simplified', 5)];
  assert.equal(chooseTitleArt(input).file_path, '/simplified.png');
  assert.equal(chooseTitleArt(input.slice(0, 3)).file_path, '/chinese.png');
  assert.equal(chooseTitleArt(input.slice(0, 2)).file_path, '/traditional.png');
  assert.equal(chooseTitleArt([logo(null, 'none'), input[0]]).file_path, '/english.png');
  assert.equal(chooseTitleArt([logo('ja', 'japanese'), {...input[0], file_path: '//evil.test/x.png'}, {...input[0], file_path: '/unsafe.svg'}]), undefined);
  assert.equal(chooseTitleArt([logo('en', 'low', 3), logo('en', 'high', 9)]).file_path, '/high.png');
});

test('existing locked metadata gains title art without re-searching or changing identities and watch state', async () => {
  const store = memoryStore(); store.setSecret('tmdbToken', 'fixture');
  const item = {id: 'a', kind: 'movie', title: '花样年华', filename: 'movie.mp4', path: '/movie.mp4', addedAt: new Date().toISOString(), metadataLocked: true, catalog: {source: 'tmdb', id: '843', kind: 'movie', title: '花样年华'}, metadata: {ids: {trakt: 7}}, progress: {position: 42}, watchState: {watched: false}};
  store.data.items = [item]; const before = structuredClone(item), calls = [];
  const service = new MetadataService(store, {cache: async url => {assert.match(url, /\/w500\/chinese.png$/); return 'cloudreel-art://cache/title';}}, {fetcher: async url => {calls.push(url); return json({logos: [logo('zh', 'chinese')]});}});
  await service.run(); assert.equal(item.catalog.logo, 'cloudreel-art://cache/title'); assert.equal(item.catalog.logoLanguage, 'zh');
  assert.equal(calls.length, 1); assert.match(calls[0], /\/movie\/843\/images\?/);
  assert.deepEqual(item.progress, before.progress); assert.deepEqual(item.metadata, before.metadata); assert.deepEqual(item.watchState, before.watchState); assert.equal(item.catalog.title, before.catalog.title);
  await service.run(); assert.equal(calls.length, 1, 'checked artwork is not refetched on each run');
});

test('empty title art is cached, download failure retries, and stale identity cannot receive late artwork', async () => {
  const store = memoryStore(); store.setSecret('tmdbToken', 'fixture');
  const item = {id: 'a', kind: 'episode', catalog: {source: 'tmdb', id: '123', kind: 'episode'}}; store.data.items = [item];
  const service = new MetadataService(store, {cache: async () => undefined}, {fetcher: async () => json({logos: []})});
  await service.titleArt(['a']); assert.ok(item.catalog.logoCheckedAt); assert.equal(titleArtDue(item.catalog), false);
  assert.equal(titleArtDue(item.catalog, Date.now() + 8 * 86400000), true);
  service.clearCache(); service.fetcher = async () => json({logos: [logo('en', 'english')]});
  await service.titleArt(['a'], {refresh: true}); assert.equal(item.catalog.logo, undefined); assert.ok(service.logoRetry.size);
  service.artwork.cache = async () => {item.catalog = {source: 'tmdb', id: '456', kind: 'episode'}; return 'cloudreel-art://cache/late';};
  await service.titleArt(['a'], {refresh: true}); assert.equal(item.catalog.logo, undefined); assert.equal(item.catalog.id, '456');
});
