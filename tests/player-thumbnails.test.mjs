import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {ThumbnailService, thumbnailKey, thumbnailTime} from '../electron/services/thumbnails.mjs';

test('thumbnail identities follow exact source and revision, never title or an expiring media address', () => {
  const item={source:'baidu',fsId:'123456789012345678',title:'Film',size:500,fileModifiedAt:10};
  assert.equal(thumbnailKey(item,30),thumbnailKey({...item,title:'Renamed'},30));
  for(const patch of [{fsId:'2'},{size:501},{fileModifiedAt:11}]) assert.notEqual(thumbnailKey(item,30),thumbnailKey({...item,...patch},30));
  assert.notEqual(thumbnailKey(item,30),thumbnailKey(item,35));
  assert.equal(thumbnailTime(36.7,100),35);assert.equal(thumbnailTime(100,100),95);
  assert.equal(thumbnailTime(thumbnailTime(100,100),100),95);
});
test('preview request replacement and cancellation never seek main player or return a stale frame', async () => {
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'cloudreel-thumb-test-'));
  const session={item:{id:'a',source:'baidu',fsId:'1'},duration:600}, service=new ThumbnailService(directory,{session});
  const frame=Buffer.from([255,216,...Array(150).fill(20)]);
  const worker={session,directory:await fs.mkdtemp(path.join(os.tmpdir(),'cloudreel-preview-')),seconds:30};
  let release;
  service.getWorker=async()=>{await new Promise(resolve=>release=resolve);service.worker=worker;return worker;};
  service.seek=async(_worker,seconds)=>{worker.seconds=seconds;};
  await fs.writeFile(path.join(worker.directory,'00000001.jpg'),frame);
  try {
    assert.equal(await service.request({itemId:'old',seconds:30}),null);
    const first=service.request({itemId:'a',seconds:30});
    while(!release)await new Promise(resolve=>setTimeout(resolve,5));
    const latest=service.request({itemId:'a',seconds:45});
    await new Promise(resolve=>setTimeout(resolve,15));service.cancel();release();
    assert.equal(await first,null);assert.equal(await latest,null);
    assert.equal(session.position,undefined);assert.equal(session.item.progress,undefined);
    await fs.writeFile(path.join(service.directory,thumbnailKey(session.item,30)+'.jpg'),frame);
    await fs.writeFile(path.join(service.directory,thumbnailKey(session.item,30)+'.json'),JSON.stringify({seconds:29.5}));
    const cached=await service.request({itemId:'a',seconds:30});assert.ok(cached.image.startsWith('data:image/jpeg;base64,'));
    assert.equal(cached.seconds,29.5,'cached keyframes retain their actual decoded timestamps');
  } finally {await service.reset();await fs.rm(directory,{recursive:true,force:true});await fs.rm(worker.directory,{recursive:true,force:true});}
});

test('background storyboard and neighbor samples share a bounded cache, retain actual times, and yield to buffering', async () => {
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'cloudreel-thumb-test-'));
  const session={item:{id:'a',source:'baidu',fsId:'1'},duration:600,position:1,loaded:true,videoParams:{}};
  const player={session,status:()=>({buffered:[{start:0,end:100}]})},service=new ThumbnailService(directory,player);
  const worker={session,directory:await fs.mkdtemp(path.join(os.tmpdir(),'cloudreel-preview-')),seconds:0};
  let decodes=0;
  service.getWorker=async()=>{decodes++;service.worker=worker;return worker;};
  service.seek=async(_worker,seconds)=>{worker.seconds=seconds;worker.position=seconds-.5;};
  await fs.writeFile(path.join(worker.directory,'00000001.jpg'),Buffer.from([255,216,...Array(150).fill(20)]));
  try {
    service.warm();service.warmAt=Date.now()-5000;
    const sample=service.queue[0].seconds;
    await service.drain();assert.equal(decodes,1);
    const sequence=service.sequence;
    const cached=await service.request({itemId:'a',seconds:sample+5,cachedOnly:true});
    assert.equal(cached.approximate,true);assert.equal(cached.seconds,sample-.5);assert.equal(service.sequence,sequence);
    assert.equal(decodes,1,'cache lookups must never start a decoder');
    const exact=await service.request({itemId:'a',seconds:sample});assert.equal(exact.target,sample);assert.equal(exact.seconds,sample-.5);
    service.lastInteraction=0;session.buffering=true;await service.drain();assert.equal(decodes,1);
    session.buffering=false;player.status=()=>({buffered:[{start:0,end:3}]});assert.equal(service.canPrefetch(session),false,'short buffers reserve bandwidth for playback');
    service.backgroundCount=32;player.status=()=>({buffered:[{start:0,end:100}]});assert.equal(service.canPrefetch(session),false);
    assert.ok(service.queue.length<=24);
  } finally {await service.reset();await fs.rm(directory,{recursive:true,force:true});await fs.rm(worker.directory,{recursive:true,force:true});}
});

test('foreground preview interrupts a speculative decoder instead of waiting behind its network seek', async () => {
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'cloudreel-thumb-test-'));
  const session={item:{id:'a',source:'baidu',fsId:'1'},duration:600,position:1,loaded:true,videoParams:{}};
  const service=new ThumbnailService(directory,{session,status:()=>({buffered:[{start:0,end:100}]})});
  const workers=await Promise.all([0,1].map(async()=>({session,directory:await fs.mkdtemp(path.join(os.tmpdir(),'cloudreel-preview-')),seconds:0})));
  for(const worker of workers)await fs.writeFile(path.join(worker.directory,'00000001.jpg'),Buffer.from([255,216,...Array(150).fill(20)]));
  let release,calls=0;
  service.getWorker=async()=>{const worker=workers[calls++];service.worker=worker;if(calls===1)await new Promise(resolve=>release=resolve);return worker;};
  service.seek=async(worker,seconds)=>{worker.seconds=seconds;worker.position=seconds-.25;};
  try {
    service.warm();service.warmAt=Date.now()-5000;
    const background=service.drain();while(!release)await new Promise(resolve=>setTimeout(resolve,5));
    const foreground=service.request({itemId:'a',seconds:50});
    while(!workers[0].closed)await new Promise(resolve=>setTimeout(resolve,5));
    release();await background;
    const frame=await foreground;assert.equal(frame.target,50);assert.equal(frame.seconds,49.75);assert.equal(calls,2);
    assert.equal(session.position,1);assert.equal(service.activeBackground,null);
  } finally {release?.();await service.reset();await fs.rm(directory,{recursive:true,force:true});for(const worker of workers)await fs.rm(worker.directory,{recursive:true,force:true});}
});
