import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inferMedia, identifyLibrary, groupLibrary, mediaNumber } from '../electron/core/identification.mjs';
const file = path => ({ id: path, source: 'baidu', path, filename: path.split('/').at(-1), addedAt: '2026-10-24T00:00:00Z' });
test('identification uses numeric filenames, Chinese seasons and nested quality folders', () => {
  for (const [path, title, season, episode] of [
    ['/电视剧/庆余年/第二季/1080p/1.mp4', '庆余年', 2, 1],
    ['/Shows/Severance/Season 2/Disc 1/02.mkv', 'Severance', 2, 2],
    ['/剧集/三体/三体 第十二集.mp4', '三体', 1, 12],
    ['/电视剧/漫长的季节/EP03.mp4', '漫长的季节', 1, 3],
    ['/TV/三体/01 - 第一集.mkv', '三体', 1, 1],
    ['/电视剧/三体/第十二集.mp4', '三体', 1, 12],
    ['/shows/Some Show/Season 1/S01E02.mkv', 'Some Show', 1, 2],
    ['/电视剧/庆余年/庆余年02.mp4', '庆余年', 1, 2],
    ['/TV/The.Last.of.Us/The.Last.of.Us.S02E03.2025.1080p.mkv', 'The Last of Us', 2, 3]
    ,['/infuse电视剧/黑袍纠察队 第五季/The Boys S05E01 - 第 1 集 - 2160p.mkv', '黑袍纠察队', 5, 1]
  ]) { const result = inferMedia(file(path)); assert.equal(result.kind, 'episode', path); assert.equal(result.title, title, path); assert.equal(result.season, season, path); assert.equal(result.episode, episode, path); }
  assert.equal(mediaNumber('一百零二'), 102); assert.equal(mediaNumber('二十一'), 21);
});
test('movie collections and numbered movie titles are not flattened into a show', () => {
  assert.equal(inferMedia(file('/电影/1917 (2019)/1917.mkv')).title, '1917');
  assert.equal(inferMedia(file('/电影/1917 (2019)/1917.mkv')).year, 2019);
  for (const path of ['/电影/1917 (2019)/1917.mkv', '/Movies/1 (2013)/1.mp4', '/电影合集/Interstellar.2014.mkv']) assert.equal(inferMedia(file(path)).kind, 'movie', path);
});
test('series group across seasons and paths while preserving progress, manual corrections and Trakt IDs', () => {
  const items = ['/shows/三体/第一季/2.mp4', '/other/三体/第二季/1.mp4', '/shows/三体/第一季/1.mp4'].map(file);
  items[0].progress = { position: 80 }; items[0].metadata = { type: 'episode', ids: { trakt: 123 } };
  identifyLibrary(items); const groups = groupLibrary(items); assert.equal(groups.length, 1); assert.deepEqual(groups[0].seasons, [1, 2]);
  assert.deepEqual(groups[0].itemIds, [items[2].id, items[0].id, items[1].id]);
  assert.equal(items[0].progress.position, 80); assert.equal(items[0].metadata.ids.trakt, 123);
  items[0].title = '修正片名'; items[0].identificationLocked = true; identifyLibrary(items); assert.equal(items[0].title, '修正片名');
});
test('localized and original files share their folder identity; public season records do not split a series', () => {
  const items=['/电视剧/生万物/生万物.S01E01.mp4','/电视剧/生万物/[生万物].This.Thriving.Land.S01E30.mp4','/电视剧/硅谷 第一季/1.mp4','/电视剧/硅谷 第二季/1.mp4'].map(file);
  identifyLibrary(items);assert.equal(items[0].title,items[1].title);items[2].catalog={source:'douban',id:'1',title:'硅谷 第一季'};items[3].catalog={source:'douban',id:'2',title:'硅谷 第二季'};identifyLibrary(items);assert.equal(groupLibrary(items).length,2);
});
