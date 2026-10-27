import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PlayerService} from '../electron/services/player.mjs';
import {memoryStore} from './helpers.mjs';

function fixture() {
  const store = memoryStore(); store.data.items = [{id: 'test', title: 'Test', kind: 'movie'}];
  const writes = [], service = new PlayerService(store, {}, {}, {}, {resolveMpv: () => ''});
  const session = service.session = {item: store.item('test'), duration: 600, position: 20, speed: 1, started: true, lastSave: Date.now(), tracks: [], socket: {write: line => writes.push(JSON.parse(line))}};
  const event = data => service.event(session, data);
  return {store, service, session, writes, event, clean: () => clearTimeout(session.seekTimer)};
}

test('seeking waits for command acceptance, decoded restart, and actual target position instead of fabricating progress', () => {
  const f = fixture();
  try {
    f.service.seek({seconds: 300, itemId: 'test', requestId: 'drag-1'});
    assert.equal(f.service.status().position, 20); assert.equal(f.service.status().seek.target, 300);
    const request = f.writes[0].request_id;
    f.event({request_id: request, error: 'success'});
    f.event({event: 'seek'}); f.event({event: 'property-change', name: 'time-pos', data: 21});
    f.event({event: 'playback-restart'}); assert.equal(f.service.status().seek.pending, true);
    f.service.saveProgress(f.session); assert.equal(f.store.item('test').progress, undefined);
    f.event({event: 'property-change', name: 'time-pos', data: 300.1}); assert.equal(f.service.status().seek.pending, false);
    assert.equal(f.service.status().position, 300.1);
  } finally {f.clean();}
});

test('rapid seeks ignore old acknowledgements and stale positions; a rejected seek releases the preview', () => {
  const f = fixture();
  try {
    f.service.seek({seconds: 200, itemId: 'test', requestId: 'first'}); const first = f.writes[0].request_id;
    f.service.seek({seconds: 400, itemId: 'test', requestId: 'latest'}); const last = f.writes[1].request_id;
    f.event({request_id: first, error: 'success'}); f.event({event: 'seek'}); f.event({event: 'playback-restart'});
    f.event({event: 'property-change', name: 'time-pos', data: 200}); assert.equal(f.service.status().seek.pending, true);
    f.event({request_id: last, error: 'success'}); assert.equal(f.service.status().seek.pending, true);
    f.event({event: 'property-change', name: 'time-pos', data: 400}); assert.equal(f.service.status().seek.pending, false);
    f.service.seek({seconds: 450, itemId: 'test', requestId: 'failed'});
    f.event({request_id: f.writes[2].request_id, error: 'error running command'});
    assert.equal(f.service.status().seek.pending, false); assert.match(f.service.status().seek.error, /实际位置/);
    assert.throws(() => f.service.seek({seconds: 40, itemId: 'previous'}), /切换/);
    assert.throws(() => f.service.seek(NaN), /无效/);
  } finally {f.clean();}
});
