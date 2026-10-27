import {test} from 'node:test';
import assert from 'node:assert/strict';
import {subtitlePosition} from '../electron/core/player-subtitles.mjs';
import {PlayerService} from '../electron/services/player.mjs';
import {memoryStore} from './helpers.mjs';

test('subtitle safe area follows bottom controls across window sizes and restores when hidden', () => {
  assert.equal(subtitlePosition({visible: true, height: 900, bottomInset: 144}), 84);
  assert.equal(subtitlePosition({visible: true, height: 600, bottomInset: 144}), 76);
  assert.equal(subtitlePosition({visible: false, height: 900, bottomInset: 144}), 100);
  assert.equal(subtitlePosition({visible: true, height: 200, bottomInset: 180}), 50);
  for (const value of [null, {}, {visible: true, height: 0, bottomInset: 144}, {visible: true, height: 900, bottomInset: NaN}, {visible: true, height: 900, bottomInset: 1000}]) {
    assert.throws(() => subtitlePosition(value), /无效/);
  }
});

test('subtitle updates ignore stale episodes, deduplicate repeated layouts, and never resize video', () => {
  const commands = [];
  const player = new PlayerService(memoryStore(), {}, {}, {}, {resolveMpv() {}, videoHost: {layout() {assert.fail('subtitle changes must not resize video');}}});
  const layout = {itemId: 'new', visible: true, height: 900, bottomInset: 144};
  player.session = {item: {id: 'new'}, socket: {write: value => commands.push(JSON.parse(value).command)}};
  player.subtitleLayout({...layout, itemId: 'old'});
  player.subtitleLayout(layout); player.subtitleLayout(layout);
  player.subtitleLayout({...layout, visible: false});
  assert.deepEqual(commands, [['set_property', 'sub-pos', 84], ['set_property', 'sub-pos', 100]]);
  player.session = {item: {id: 'new'}};
  player.subtitleLayout(layout);
  assert.deepEqual(player.session.subtitleLayout, layout);
  assert.equal(player.session.subtitlePosition, undefined);
  player.session.finishing = true; player.subtitleLayout({...layout, visible: false});
  assert.deepEqual(player.session.subtitleLayout, layout);
});
