import {test} from 'node:test';
import assert from 'node:assert/strict';
import {LibraryScanner} from '../electron/services/scanner.mjs';
import {LibraryRefresh} from '../electron/services/library-refresh.mjs';
import {MetadataService} from '../electron/services/metadata.mjs';
import {memoryStore} from './helpers.mjs';

function setup() {
  let connected=false,automatic=false,tick,cleared;
  const roots=[{id:'local',source:'local',enabled:true},{id:'cloud',source:'baidu',enabled:true},{id:'disabled',source:'local',enabled:false}],calls=[];
  const scanner={state:{running:false},roots:()=>roots,refresh:(ids,options)=>{calls.push({ids,options});scanner.state.running=true;}};
  const scheduler=new LibraryRefresh(scanner,{baiduConnected:()=>connected,automatic:()=>automatic,setTimer:(callback,ms)=>{assert.equal(ms,900000);tick=callback;return 1;},clearTimer:id=>cleared=id});
  return {scanner,scheduler,calls,roots,connect:()=>connected=true,automatic:value=>automatic=value,tick:()=>tick(),cleared:()=>cleared};
}
test('startup refresh is silent regardless of periodic preference and waits for cloud login',()=>{
  const f=setup();f.scheduler.start();
  assert.deepEqual(f.calls,[{ids:['local'],options:{background:true}}]);
  f.connect();f.scheduler.startup();assert.deepEqual(f.calls[1],{ids:['cloud'],options:{background:true}});
  f.scheduler.startup();assert.equal(f.calls.length,2);
  f.scanner.state.running=false;f.tick();assert.equal(f.calls.length,2,'automatic off skips subsequent ticks');
  f.roots.push({id:'new-mount',source:'local',enabled:true});f.tick();assert.equal(f.calls.length,2,'mounting is not a second startup');
  f.scheduler.stop();assert.equal(f.cleared(),1);f.tick();assert.equal(f.calls.length,2);
});
test('periodic refresh respects switch, available roots and an already running scan',()=>{
  const f=setup();f.connect();f.scheduler.start();f.scanner.state.running=false;
  f.automatic(true);f.tick();assert.deepEqual(f.calls[1],{ids:['local','cloud'],options:{background:true}});
  f.tick();assert.equal(f.calls.length,2);f.scanner.state.running=false;f.automatic(false);f.tick();assert.equal(f.calls.length,2);
});
test('manual refresh reveals background traversal and queues missing roots without restarting it',async()=>{
  const store=memoryStore(),listed=[],completed=[];let release;
  const scanner=new LibraryScanner(store,{list:async directory=>{listed.push(directory);if(directory==='/One')await new Promise(resolve=>release=resolve);return {files:[],hasMore:false};}},()=>{},current=>completed.push(current.background));
  const one=scanner.add('baidu','/One'),two=scanner.add('baidu','/Two');
  scanner.refresh([one.id],{background:true});assert.equal(scanner.state.background,true);const task=scanner.active;
  scanner.refresh();assert.equal(scanner.state.background,false);assert.equal(scanner.active,task);
  scanner.refresh([two.id]);release();await scanner.active;
  assert.deepEqual(listed,['/One','/Two']);assert.deepEqual(completed,[false]);
});
test('silent scans update additions/removals without success log spam; cancellation preserves library',async()=>{
  const store=memoryStore();let files=[{fs_id:'42',path:'/Shows/Show.S01E01.mkv',server_filename:'Show.S01E01.mkv',isdir:0,size:10}],complete;
  const scanner=new LibraryScanner(store,{list:async()=>({files,hasMore:false})},()=>{},current=>complete=current.background);scanner.add('baidu','/Shows');
  scanner.refresh(undefined,{background:true});await scanner.active;const item=store.data.items[0];item.progress={position:50};
  assert.equal(complete,true);assert.equal(store.data.logs.length,0);files=[];
  scanner.refresh(undefined,{background:true});await scanner.active;assert.equal(item.unavailable,true);assert.equal(item.progress.position,50);
  delete item.unavailable;complete=null;scanner.refresh(undefined,{background:true});scanner.cancel();await scanner.active;
  assert.equal(item.unavailable,undefined);assert.equal(complete,null);
});
test('silent failures retain library and record diagnostics without becoming foreground work',async()=>{
  const store=memoryStore();store.data.items=[{id:'one',source:'baidu',path:'/Shows/1.mkv'}];
  const scanner=new LibraryScanner(store,{list:async()=>{throw new Error('offline');}});scanner.add('baidu','/Shows');
  scanner.refresh(undefined,{background:true});await scanner.active;
  assert.equal(scanner.state.background,true);assert.ok(scanner.state.error);assert.equal(store.data.items[0].unavailable,undefined);assert.equal(store.data.logs.length,1);
});
test('background metadata remains silent and an explicit request can reveal the same run',async()=>{
  const store=memoryStore();store.setSecret('tmdbToken','test');let release;
  const item={id:'one',source:'local',path:'/Film.mkv',filename:'Film.mkv',title:'Film',kind:'movie',identificationLocked:true,catalog:{source:'tmdb',id:'1',kind:'movie',title:'Film',pending:true}};
  store.data.items=[item];
  const service=new MetadataService(store,{cache:async()=>null},{fetcher:async()=>new Response('{}')});
  service.apply=async()=>new Promise(resolve=>release=resolve);
  const task=service.run({background:true});assert.equal(service.status().background,true);
  await Promise.resolve();service.foreground();assert.equal(service.status().background,false);release();await task;assert.equal(store.data.logs.length,1);
  item.catalog.pending=true;const silent=service.run({background:true});await Promise.resolve();release();await silent;
  assert.equal(service.status().background,true);assert.equal(store.data.logs.length,1,'silent completion must not generate a foreground completion log');
});

test('metadata follow-ups include new files, coalesce, stay foreground after promotion, and respect stop',async()=>{
  const service=new MetadataService(memoryStore(),{}),runs=[];let release;
  service.performRun=async options=>{service.running=true;service.progress={...options,running:true};runs.push(options);await new Promise(resolve=>release=resolve);service.running=false;};
  const first=service.schedule({background:true});
  const next=service.schedule({background:true});assert.equal(service.schedule({background:true}),next);
  service.foreground();release();await first;await Promise.resolve();
  assert.deepEqual(runs,[{refresh:false,background:true},{refresh:false,background:false}]);release();await next;
  const active=service.schedule({background:true}),cancelled=service.schedule({background:true});
  service.cancel();release();await Promise.all([active,cancelled]);
  assert.equal(runs.length,3,'stop must discard scheduled metadata instead of restarting it');
});
