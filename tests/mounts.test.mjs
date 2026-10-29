import {test} from 'node:test';
import assert from 'node:assert/strict';
import {LibraryScanner} from '../electron/services/scanner.mjs';
import {memoryStore} from './helpers.mjs';

const file = {fs_id:'42',path:'/Shows/Show.S01E01.mkv',server_filename:'Show.S01E01.mkv',size:100,isdir:0};
test('mounts persist verified folder IDs, reuse legacy roots, and enumerate only the selected tree',async()=>{
  const store=memoryStore(),listed=[];
  const scanner=new LibraryScanner(store,{fileInfo:async id=>{assert.equal(String(id),'100');return {fs_id:'100',path:'/Shows',isdir:1};},list:async directory=>{listed.push(directory);return {files:[file],hasMore:false};}});
  const legacy=scanner.add('baidu','/Shows'),old=scanner.roots().length;
  const mounted=await scanner.mountBaidu({fsId:'100',path:'/outdated'});await scanner.active;
  assert.equal(mounted,legacy);assert.equal(mounted.fsId,'100');assert.equal(scanner.roots().length,old);assert.deepEqual(listed,['/Shows']);assert.equal(store.data.items.length,1);
  const item=store.data.items[0];item.progress={position:75};item.metadata={ids:{trakt:4}};item.identificationLocked=true;
  await scanner.mountBaidu({fsId:'100',path:'/Shows'});await scanner.active;
  assert.equal(scanner.roots().length,1);assert.equal(item.progress.position,75);assert.equal(item.metadata.ids.trakt,4);
});
test('mounted folder IDs follow rename/move while failed resolution preserves both library and root',async()=>{
  const store=memoryStore();let currentPath='/Shows',fail=false;
  const scanner=new LibraryScanner(store,{fileInfo:async()=>{if(fail)throw new Error('offline');return {fs_id:'100',path:currentPath,isdir:1};},list:async directory=>({files:[{...file,path:directory+'/Show.S01E01.mkv'}],hasMore:false})});
  const root=await scanner.mountBaidu({fsId:'100'});await scanner.active;
  const item=store.data.items[0];item.progress={position:70};item.identificationLocked=true;
  currentPath='/Moved/Shows';scanner.refresh();await scanner.active;
  assert.equal(root.path,currentPath);assert.equal(item.path,currentPath+'/Show.S01E01.mkv');assert.equal(item.progress.position,70);assert.equal(item.unavailable,undefined);
  fail=true;scanner.refresh();await scanner.active;
  assert.ok(root.error);assert.equal(root.path,currentPath);assert.equal(item.unavailable,undefined);
});
test('invalid, file and concurrent mount attempts never add a root',async()=>{
  const store=memoryStore(),scanner=new LibraryScanner(store,{fileInfo:async()=>({fs_id:'4',path:'/file.mkv',isdir:0})});
  await assert.rejects(scanner.mountBaidu({fsId:'4'}),/文件夹/);assert.equal(scanner.roots().length,0);
  scanner.state.running=true;await assert.rejects(scanner.mountBaidu({path:'/'}),/扫描/);assert.equal(scanner.roots().length,0);
});
