import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readMediaInfo} from '../electron/core/media-info.mjs';
import {MediaProbeService} from '../electron/services/media-probe.mjs';
import {memoryStore} from './helpers.mjs';
const tracks=[{id:1,type:'video',codec:'hevc','demux-w':3840,'demux-h':1600,selected:true},{id:2,type:'audio',codec:'eac3',lang:'en','audio-channels':6,'demux-samplerate':48000},{id:3,type:'sub',codec:'ass',lang:'zh-Hans'},{id:4,type:'sub',codec:'subrip',external:true,'external-filename':'private-path'}];
test('real decoder metadata distinguishes 10-bit SDR, PQ, HLG and Dolby Vision, never guessing from bit depth',()=>{
 const base={tracks,params:{w:3840,h:1600,gamma:'bt.1886',pixelformat:'yuv420p10le'},duration:600,fps:23.976};
 const info=readMediaInfo(base);assert.equal(info.dynamicRange,'SDR');assert.equal(info.bitDepth,10);assert.equal(info.audioTracks[0].channels,'6 声道');assert.equal(info.audioTracks[0].sampleRate,48000);assert.equal(info.subtitles.length,1);assert.ok(!JSON.stringify(info).includes('private-path'));
 assert.equal(readMediaInfo({...base,params:{...base.params,gamma:'pq'}}).dynamicRange,'HDR10');
 assert.equal(readMediaInfo({...base,params:{...base.params,gamma:'hlg'}}).dynamicRange,'HLG');
 assert.equal(readMediaInfo({...base,params:{...base.params,gamma:'pq',colormatrix:'dolbyvision'}}).dynamicRange,'Dolby Vision');
 assert.equal(readMediaInfo({tracks}).dynamicRange,undefined);assert.equal(readMediaInfo({}),null);
});
test('media probe caches verified unchanged files and refuses stale results after file replacement',async()=>{
 const store=memoryStore();store.data.items=[{id:'a',size:100,fileModifiedAt:1},{id:'b',size:200}];const service=new MediaProbeService(store,{},()=>null);let calls=0;
 service.probe=async()=>{calls++;return readMediaInfo({tracks,params:{w:3840,h:1600,gamma:'pq'}});};
 service.request('a');await new Promise(resolve=>setImmediate(resolve));assert.ok(store.item('a').technical.verified);service.request('a');await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,1);
 store.item('a').size=101;service.request('a');await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,2);
 let finish;service.probe=()=>new Promise(resolve=>{finish=resolve;});service.request('b');store.item('b').size=201;finish(readMediaInfo({tracks}));await new Promise(resolve=>setImmediate(resolve));assert.equal(store.item('b').technical,undefined);
});

test('a failed media request releases the serial probe queue so later files and a retry succeed',async()=>{
 const store=memoryStore();store.data.items=[{id:'bad',size:100},{id:'next',size:200}];const service=new MediaProbeService(store,{},()=>null);let fail=true;const calls=[];
 service.probe=async item=>{calls.push(item.id);if(item.id==='bad'&&fail)throw new Error('百度媒体响应无效');return readMediaInfo({tracks,params:{w:1920,h:1080,gamma:'bt.1886'},duration:120});};
 service.request('bad');service.request('next');await new Promise(resolve=>setImmediate(resolve));
 assert.deepEqual(calls,['bad','next']);assert.equal(service.states.bad.running,false);assert.ok(service.states.bad.error);assert.ok(store.item('next').technical.verified);assert.equal(service.active,null);
 fail=false;service.request('bad',true);await new Promise(resolve=>setImmediate(resolve));assert.ok(store.item('bad').technical.verified);assert.equal(service.states.bad.error,null);
});
