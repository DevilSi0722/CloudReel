import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseFilename, chooseResume } from '../electron/core/media.mjs';
import { jsonRequest } from '../electron/core/http.mjs';
import { Store } from '../electron/core/store.mjs';

test('recognizes episode numbers and movie years without matching resolution as a title', () => {
  assert.deepEqual(parseFilename('Severance.S02E03.2025.2160p.WEB-DL.mkv'), { title: 'Severance', year: 2025, kind: 'episode', season: 2, episode: 3 });
  assert.deepEqual(parseFilename('Arrival (2016) 1080p.mkv'), { title: 'Arrival', year: 2016, kind: 'movie', season: undefined, episode: undefined });
  assert.equal(parseFilename('三体.1x02.1080p.mkv').episode, 2);
});
test('resume uses most recent event, allowing deliberate backward seeks on another device', () => {
  const local = { position: 600, percent: 80, updatedAt: '2026-10-22T10:00:00Z' };
  assert.deepEqual(chooseResume(local, { progress: 25, paused_at: '2026-10-23T10:00:00Z' }), { percent: 25, source: 'Trakt' });
  assert.deepEqual(chooseResume(local, { progress: 90, paused_at: '2026-10-21T10:00:00Z' }), { seconds: 600, source: '本机' });
  assert.equal(chooseResume({ ...local, percent: 100 }, null), null);
});
test('preserves a Baidu int64 ID and never includes token URLs in API errors', async () => {
  const data = await jsonRequest('https://example.com', {}, async () => new Response('{"list":[{"fs_id":987654321012345678}]}'));
  assert.equal(data.list[0].fs_id, '987654321012345678');
  await assert.rejects(jsonRequest('https://example.com?access_token=SECRET', {}, async () => { throw new Error('https://example.com?access_token=SECRET'); }), error => !error.message.includes('SECRET'));
});
test('store persists encrypted secrets without returning them to renderer', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'cloudreel-test-'));
  const crypto = { isEncryptionAvailable: () => true, encryptString: value => Buffer.from('encrypted:' + Buffer.from(value).toString('base64')), decryptString: value => Buffer.from(value.toString().slice(10), 'base64').toString() };
  try {
    const store = new Store(directory, crypto); store.setSecret('baiduToken', { access_token: 'SENSITIVE-TOKEN' });
    assert.equal(store.secret('baiduToken').access_token, 'SENSITIVE-TOKEN');
    assert.ok(!JSON.stringify(store.snapshot()).includes('SENSITIVE-TOKEN'));
    assert.ok(!readFileSync(path.join(directory, 'state.json'), 'utf8').includes('SENSITIVE-TOKEN'));
    assert.equal(new Store(directory, crypto).secret('baiduToken').access_token, 'SENSITIVE-TOKEN');
  } finally { rmSync(directory, { recursive: true }); }
});
