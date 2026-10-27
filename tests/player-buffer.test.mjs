import {test} from 'node:test';
import assert from 'node:assert/strict';
import {bufferedRanges} from '../electron/core/player-buffer.mjs';
import {PlayerService} from '../electron/services/player.mjs';
import {memoryStore} from './helpers.mjs';

test('cached time ranges preserve seek gaps, merge overlaps, and exclude invalid or out-of-file values', () => {
  assert.deepEqual(bufferedRanges({'seekable-ranges':[
    {start:90,end:130},{start:-5,end:20},{start:10,end:35},{start:70,end:60},
    {start:NaN,end:50},{start:40,end:Infinity},{start:'40',end:50},{start:150,end:180},null
  ]},120), [{start:0,end:35},{start:90,end:120}]);
  assert.deepEqual(bufferedRanges(null,120),[]);
  assert.deepEqual(bufferedRanges({'seekable-ranges':[{start:0,end:20}]},0),[]);
});

test('player exposes only actual cache, clears unavailable cache, and rejects old-file updates during replacement', () => {
  const store=memoryStore();store.data.items=[{id:'one',title:'One',kind:'movie'}];
  const player=new PlayerService(store,{}, {}, {}, {resolveMpv:()=>''});
  const session=player.session={item:store.data.items[0],duration:600,position:20,tracks:[],speed:1,lastSave:Date.now()};
  const cache=data=>player.event(session,{event:'property-change',name:'demuxer-cache-state',data});
  assert.deepEqual(player.status().buffered,[]);
  cache({'seekable-ranges':[{start:0,end:80},{start:300,end:340}]});
  assert.deepEqual(player.status().buffered,[{start:0,end:80},{start:300,end:340}]);
  session.position=400;
  assert.equal(player.status().buffered.at(-1).end,340,'position alone must not imply downloaded media');
  cache(null);assert.deepEqual(player.status().buffered,[]);
  session.acceptProperties=false;cache({'seekable-ranges':[{start:0,end:500}]});
  assert.deepEqual(player.status().buffered,[]);
  player.event(session,{event:'start-file'});cache({'seekable-ranges':[{start:400,end:420}]});
  assert.deepEqual(player.status().buffered,[{start:400,end:420}]);
  player.event({...session},{event:'property-change',name:'demuxer-cache-state',data:{'seekable-ranges':[{start:0,end:600}]}});
  assert.deepEqual(player.status().buffered,[{start:400,end:420}]);
});
