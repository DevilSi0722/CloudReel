import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {AppShutdown} from '../electron/services/app-shutdown.mjs';
import {PlayerService} from '../electron/services/player.mjs';
import {SyncService} from '../electron/services/sync.mjs';
import {memoryStore} from './helpers.mjs';

test('shutdown cancels once and persists before cleanup, even when a preparation step throws',async()=>{
  const actions=[],app={quit:()=>actions.push('quit'),exit:()=>actions.push('exit')},event={preventDefault:()=>actions.push('prevent')};
  let release;const shutdown=new AppShutdown({app,prepare:[()=>{actions.push('prepare');throw Error('cleanup');},()=>actions.push('cancel')],cleanup:[()=>new Promise(resolve=>release=resolve)],persist:()=>actions.push('persist'),dispose:()=>actions.push('dispose')});
  shutdown.handle(event);shutdown.handle(event);await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(actions,['prevent','prepare','cancel','persist','prevent']);release();await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(actions.slice(-3),['persist','dispose','quit']);shutdown.handle(event);assert.equal(actions.filter(a=>a==='prepare').length,1);assert.equal(shutdown.ready,true);
});

test('shutdown exits within its deadline when network cleanup never resolves',async()=>{
  const actions=[];const shutdown=new AppShutdown({app:{quit:()=>actions.push('quit'),exit:()=>{}},cleanup:[()=>new Promise(()=>{})],persist:()=>actions.push('persist'),dispose:()=>actions.push('dispose'),timeout:30});
  shutdown.handle({preventDefault(){}});await new Promise(resolve=>setTimeout(resolve,60));assert.deepEqual(actions,['persist','persist','dispose','quit']);assert.equal(shutdown.ready,true);
});

test('player shutdown queues final progress without waiting for an in-flight Trakt operation',async()=>{
  const store=memoryStore();store.data.secrets.traktToken={};
  let networkCalls=0;const sync=new SyncService(store,{scrobble:async()=>{networkCalls++;}});sync.flushing=new Promise(()=>{});
  const player=new PlayerService(store,{}, {},sync,{resolveMpv(){},rightPressed:null});
  const child=new EventEmitter();child.exitCode=null;child.kill=()=>{};
  const item={id:'test',kind:'movie',metadata:{ids:{trakt:123}}};store.data.items=[item];
  player.session={item,started:true,position:120,duration:1200,sequence:new Promise(()=>{}),child,socket:{write:()=>{queueMicrotask(()=>{child.exitCode=0;child.emit('exit',0);});},destroy(){}},transport:{requests:new Map()}};
  player.subtitles.cleanup=async()=>{};
  await player.shutdown();assert.equal(player.session,null);assert.equal(item.progress.position,120);assert.equal(store.data.pending.length,1);assert.equal(store.data.pending[0].action,'stop');assert.equal(networkCalls,0);
});

test('closing the main window exits a hidden Electron app even with an auxiliary window and stalled cleanup',{skip:process.platform!=='win32',timeout:12000},async()=>{
  const root=fileURLToPath(new URL('../',import.meta.url)),directory=await fs.mkdtemp(path.join(os.tmpdir(),'cloudreel-shutdown-'));
  try{
    const result=await new Promise((resolve,reject)=>{
      const child=spawn(createRequire(import.meta.url)('electron'),[path.join(root,'tests/fixtures/app-shutdown-window.mjs')],{cwd:root,windowsHide:true,env:{...process.env,CLOUDREEL_TEST_DIRECTORY:directory}});
      let output='';child.stdout.on('data',data=>output+=data);child.stderr.on('data',data=>output+=data);
      const timer=setTimeout(()=>{child.kill();reject(Error('shutdown timed out'));},8000);
      child.once('error',reject);child.once('exit',code=>{clearTimeout(timer);resolve({code,output});});
    });assert.equal(result.code,0,result.output);assert.match(result.output,/"closedMainWithHiddenWindow":true/);
    const state=JSON.parse(await fs.readFile(path.join(directory,'state.json'),'utf8'));assert.equal(state.progress,120);assert.equal(state.queuedStop,true);
  }finally{assert.equal(path.dirname(directory),os.tmpdir());assert.ok(path.basename(directory).startsWith('cloudreel-shutdown-'));await fs.rm(directory,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
});
