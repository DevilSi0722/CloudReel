import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PlayerGestures} from '../electron/core/player-gestures.mjs';
import {overlayRegions, playerOverlayBounds, pointInside} from '../electron/core/player-overlay.mjs';
import {PlayerService} from '../electron/services/player.mjs';
import {memoryStore} from './helpers.mjs';

function gestures() {
  let session = {position: 60, speed: 1.5, paused: false}, id = 0;
  const pending = new Map(), controls = [], seeks = []; let pauses = 0;
  const input = new PlayerGestures({session: () => session, control: input => controls.push(input), seek: value => seeks.push(value), pause: () => pauses++, notify() {}, delay: fn => {pending.set(++id, fn); return id;}, clear: id => pending.delete(id)});
  return {input, controls, seeks, get session() {return session;}, set session(next) {session = next;}, get pauses() {return pauses;}, tick() {for (const [id, fn] of pending) {pending.delete(id); fn();}}};
}
test('a short Right seeks once, repeat events do not create additional holds', () => {
  const g = gestures(); g.input.rightDown(); g.input.rightDown(); g.input.rightUp(); g.tick();
  assert.deepEqual(g.seeks, [65]); assert.deepEqual(g.controls, []);
});
test('holding Right boosts and restores the exact original speed without seeking', () => {
  const g = gestures(); g.input.rightDown(); g.tick();
  assert.equal(g.session.boosting, true); assert.deepEqual(g.controls, [{speed: 3}]);
  g.input.rightUp(); assert.deepEqual(g.controls, [{speed: 3}, {speed: 1.5}]); assert.deepEqual(g.seeks, []); assert.equal(g.session.boosting, false);
});
test('focus loss restores held speed and cancels a pending tap', () => {
  const g = gestures(); g.input.rightDown(); g.input.cancel(); g.tick(); assert.deepEqual(g.seeks, []);
  g.input.rightDown(); g.tick(); g.input.cancel(); assert.deepEqual(g.controls, [{speed: 3}, {speed: 1.5}]);
});
test('held input never changes a replacement episode and never slows an existing 4x speed', () => {
  const g = gestures(); g.session.speed = 4; g.input.rightDown(); g.tick(); g.input.rightUp(); assert.deepEqual(g.controls, [{speed: 4}, {speed: 4}]);
  g.controls.length = 0; g.input.rightDown(); g.session = {position: 0, speed: 1, paused: false}; g.tick(); g.input.rightUp(); assert.deepEqual(g.controls, []); assert.deepEqual(g.seeks, []);
});
test('double click cancels delayed pause; replacing a video cancels its old click', () => {
  const g = gestures(); g.input.singleClick(); g.input.doubleClick(); g.input.singleClick(); g.tick(); assert.equal(g.pauses, 0);
  g.input.singleClick(); g.session = {}; g.tick(); assert.equal(g.pauses, 0);
  g.input.singleClick(); g.tick(); assert.equal(g.pauses, 1);
});
test('native and renderer shortcut paths share seek/volume/temporary speed behavior', async () => {
  const p = new PlayerService(memoryStore(), {}, {}, {}, {resolveMpv() {}}), commands = [];
  const s = {socket: {write: value => commands.push(JSON.parse(value).command)}, position: 2, duration: 100, speed: 1.25, volume: 95, muted: true}; p.session = s;
  p.event(s, {event: 'client-message', args: ['cloudreel', 'backward']}); assert.deepEqual(commands.pop(), ['seek', 0, 'absolute+exact']);
  await p.shortcut('volume-up'); assert.deepEqual(commands.splice(-2), [['set_property', 'volume', 100], ['set_property', 'mute', false]]);
  await p.shortcut('right-down'); p.gestures.right.boosting = true; s.boosting = true;
  p.control({speed: 2}); assert.deepEqual(commands.splice(-2), [['set_property', 'speed', 1.25], ['set_property', 'speed', 2]]); assert.equal(s.boosting, false);
  await assert.rejects(p.shortcut('unknown'), /不支持/);
});
test('native Escape delegates to the UI before stopping playback', async () => {
  const actions = []; const p = new PlayerService(memoryStore(), {}, {}, {}, {resolveMpv() {}, onAction: action => {actions.push(action); return true;}});
  p.session = {socket: {}}; p.stop = () => {throw new Error('should close the menu first');};
  await p.shortcut('escape'); await p.shortcut('help'); assert.deepEqual(actions, ['escape', 'help']);
});
test('overlay screen bounds follow the fixed video rectangle and preserve DIP coordinates', () => {
  const content = {x: -1440, y: 40, width: 1380, height: 900}, video = {x: 0, y: 38, width: 1380, height: 862};
  assert.deepEqual(playerOverlayBounds(content, video), {x: -1440, y: 78, width: 1380, height: 862});
  assert.equal(pointInside({x: -1440, y: 78}, playerOverlayBounds(content, video)), true);
  assert.equal(pointInside({x: -60, y: 78}, playerOverlayBounds(content, video)), false);
  assert.equal(playerOverlayBounds(content, null), null);
});
test('visual panel diagnostics clamp offscreen edges and reject invalid rectangles', () => {
  const regions = overlayRegions([{x: -10, y: 20, width: 50, height: 80}, {x: 2000, y: 0, width: 10, height: 10}], {width: 980, height: 600});
  assert.deepEqual(regions, [{x: 0, y: 20, width: 40, height: 80, radius: 0}]);
  assert.throws(() => overlayRegions([{x: NaN}], {width: 980, height: 600}), /无效/);
});

test('persistent media 403 reports its cause before creating a video window or mpv',async()=>{
  const store=memoryStore(),refreshes=[];store.data.items.push({id:'denied',source:'baidu',fsId:'123',title:'Denied test'});
  const player=new PlayerService(store,{
    streamUrl:async(_id,options)=>{refreshes.push(options.refresh);return 'https://pcs.baidu.com/file?sign=private';},
    fetchMedia:async(_url,options)=>{assert.equal(options.headers.Range,'bytes=0-0');return new Response('denied',{status:403});}
  },{},{eligible:()=>false},{resolveMpv:()=> 'never-spawned',videoHost:{prepare:()=>assert.fail('must not prepare a video before media is readable')},spawnPlayer:()=>assert.fail('must not spawn mpv on HTTP 403')});
  await assert.rejects(player.play('denied'),/HTTP 403/);
  assert.deepEqual(refreshes,[false,true]);assert.equal(player.status(),null);assert.equal(player.opening,false);
  assert.ok(store.data.logs.some(message=>message.includes('HTTP 403')));assert.ok(!JSON.stringify(store.data.logs).includes('private'));
});
