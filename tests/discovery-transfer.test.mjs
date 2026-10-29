import {test} from 'node:test';
import assert from 'node:assert/strict';
import {BaiduShareService,shareJson} from '../electron/services/baidu-share.mjs';
import {DiscoveryService} from '../electron/services/discovery.mjs';
import {LibraryScanner} from '../electron/services/scanner.mjs';
import {memoryStore} from './helpers.mjs';
import {Store} from '../electron/core/store.mjs';

const json = value => new Response(JSON.stringify(value));
const until = async check => {for(let i=0;i<100;i++){if(check()) return;await new Promise(resolve => setTimeout(resolve,5));}throw new Error('timeout');};
function setup(fetcher, options = {}) {
  const store = memoryStore(), imports = [];
  const web = {connected:true,sessionVariables:async () => ({uk:'123',bdstoken:'PRIVATE-TOKEN'}),fileInfo:async () => ({fs_id:'300',path:'/Movies',isdir:1})};
  const service = new BaiduShareService({store,web,browserSession:{fetch:fetcher},importDirectory:async target => {imports.push(target);return 2;},pollDelay:1,...options});
  service.handles.set('preview',{shareId:'50',ownerId:'60',sekey:'PRIVATE-SEKEY',url:'https://pan.baidu.com/s/1TEST',title:'Example',at:Date.now(),files:new Map([['9007199254740993123',{fs_id:'9007199254740993123',server_filename:'video.mkv',path:'/video.mkv',size:100,isdir:0}]]),directories:new Set(['/'])});
  return {service,store,imports,web,input:{handle:'preview',fsIds:['9007199254740993123'],target:{fsId:'300'},mount:true}};
}

test('share JSON preserves int64 transfer identities and never exposes returned payloads in errors',async () => {
  const data = await shareJson(async () => new Response('{"errno":0,"taskid":9007199254740993123,"list":[{"to_fs_id":9007199254740993124}]}'),'/share/list');
  assert.equal(data.taskid,'9007199254740993123');assert.equal(data.list[0].to_fs_id,'9007199254740993124');
  await assert.rejects(shareJson(async () => json({errno:-62,message:'PRIVATE-SEKEY'}),'/share/list'),error => /验证/.test(error.message) && !error.message.includes('PRIVATE'));
});
test('transfer submits numeric IDs once, never overwrites names, and waits for asynchronous success before ingestion',async () => {
  let submits=0,queries=0;
  const {service,store,imports,input} = setup(async (value,options) => {
    const url = new URL(value);
    if(url.pathname === '/share/transfer') {submits++;assert.equal(url.searchParams.get('ondup'),'newcopy');assert.equal(new URLSearchParams(options.body).get('fsidlist'),'[9007199254740993123]');return json({errno:0,taskid:'77'});}
    queries++;assert.equal(imports.length,0);return json({errno:0,status:queries === 1 ? 'running' : 'success'});
  });
  const first = await service.transfer(input), second = await service.transfer(input);assert.equal(first.id,second.id);
  await until(() => service.status()[0].status === 'complete');assert.equal(submits,1);assert.equal(queries,2);assert.equal(imports.length,1);
  assert.ok(!JSON.stringify(store.data).includes('PRIVATE'));assert.equal(Object.hasOwn(service.status()[0],'taskId'),false);
});
test('uncertain transfer cannot be blindly retried and partial failures cannot claim success',async () => {
  let submits=0;
  const {service,imports,input} = setup(async () => {submits++;return json({errno:12,message:'private'});});
  await service.transfer(input);await until(() => service.status()[0].status === 'uncertain');
  await service.transfer(input);assert.equal(submits,1);assert.equal(imports.length,0);
});
test('real Baidu synchronous response task_id zero completes without polling an invalid task',async () => {
  let calls=0;
  const {service,imports,input}=setup(async value=>{calls++;assert.equal(new URL(value).pathname,'/share/transfer');return json({errno:0,task_id:0,extra:{list:[{to_fs_id:'500'}]}});});
  await service.transfer(input);await until(()=>service.status()[0].status==='complete');assert.equal(calls,1);assert.equal(imports.length,1);
});
test('invalid selection, destination, account and overlapping parent selections are checked before writes',async () => {
  let submits=0;
  const {service,web,input} = setup(async () => {submits++;return json({errno:0,extra:{list:[{}]}});});
  await assert.rejects(service.transfer({...input,fsIds:['999']}),/请选择/);
  await assert.rejects(service.transfer({...input,target:{path:'/unverified'}}),/保存目录/);
  await assert.rejects(service.transfer({...input,target:{path:'/'}}),/保存目录/);
  web.connected=false;await assert.rejects(service.transfer(input),/登录/);assert.equal(submits,0);
});

test('account changes before submission prevent writes and after saving prevent ingestion',async () => {
  let submits=0;
  const first=setup(async()=>{submits++;return json({errno:0,extra:{list:[{}]}});});
  first.web.check=async()=>{first.web.sessionVariables=async()=>({uk:'999',bdstoken:'PRIVATE'});return true;};
  await first.service.transfer(first.input);await until(()=>first.service.status()[0].status==='failed');assert.equal(submits,0);assert.equal(first.imports.length,0);
  const second=setup(async()=>{submits++;second.web.sessionVariables=async()=>({uk:'999',bdstoken:'PRIVATE'});return json({errno:0,extra:{list:[{}]}});});
  await second.service.transfer(second.input);await until(()=>second.service.status()[0].status==='saved');assert.equal(submits,1);assert.equal(second.imports.length,0);assert.equal(second.service.busy,false);
});
test('restart retains task history without resubmitting writes, and ingestion failure stays saved',async () => {
  const first = setup(async () => json({errno:0,extra:{list:[{}]}}),{importDirectory:async () => {throw new Error('offline');}});
  await first.service.transfer(first.input);await until(() => first.service.status()[0].status === 'saved');
  const store=memoryStore();store.data.discoveryTransfers=[{id:'old',status:'submitting',message:'old'}];let requests=0;
  const service=new BaiduShareService({store,web:{},browserSession:{fetch:async () => {requests++;}}});
  assert.equal(service.status()[0].status,'uncertain');assert.equal(requests,0);
});
test('provider requests serialize and cached resource handles never expose arbitrary URLs to renderer callers',async () => {
  let active=0,max=0,calls=0;
  const service=new DiscoveryService({createBrowser:() => ({page:async url => {calls++;active++;max=Math.max(max,active);await new Promise(resolve => setTimeout(resolve,5));active--;return {url,status:200,anchors:[{href:'/movies/1/',text:'Movie'}]};}})});
  await Promise.all([service.catalog(),service.catalog({category:'shows'})]);await service.catalog();
  assert.equal(max,1);assert.equal(calls,2);assert.throws(() => service.resolve('https://attacker.test'),/过期/);
  await service.catalog({fresh:true});assert.equal(calls,3,'explicit refresh bypasses the catalog cache');
});

test('recently popular follows the site default route and retains its sort while paging',async () => {
  const routes=[];
  const service=new DiscoveryService({createBrowser:()=>({destroy(){},page:async input=>{const url=new URL(input);routes.push(url);return {url:input,status:200,anchors:[{href:'/movies/1/',text:'Movie'},{href:'/?page=2',text:'下一页'}]};}})});
  const home=await service.catalog();assert.equal(routes[0].search,'');assert.equal(home.next,'https://sidhub.cc/?page=2');
  await service.catalog({page:2});assert.equal(routes[1].searchParams.get('page'),'2');assert.equal(routes[1].searchParams.has('order'),false);
  await service.catalog({order:'update'});assert.equal(routes[2].searchParams.get('order'),'update');
  service.close();
});
test('transfer ingestion is scoped, additions-only and preserves an active scan and existing watch identity',async () => {
  const store=memoryStore(), old={id:'baidu:1',source:'baidu',fsId:'1',path:'/Movies/old.mkv',progress:{position:42},catalog:{id:'real'}};store.data.items=[old];
  store.upsert = Store.prototype.upsert;
  const requests=[];const scanner=new LibraryScanner(store,{list:async directory => {requests.push(directory);return {files:directory === '/Movies' ? [{fs_id:'1',server_filename:'old.mkv',path:'/Movies/old.mkv',isdir:0,size:2},{fs_id:'2',server_filename:'New.2025.mkv',path:'/Movies/New.2025.mkv',isdir:0,size:3}] : [],hasMore:false};}});
  scanner.state={running:true,background:true};const scan=scanner.state;
  assert.equal(await scanner.importBaiduDirectory('/Movies'),1);assert.equal(scanner.state,scan);assert.equal(store.data.items[0],old);assert.equal(old.progress.position,42);assert.deepEqual(requests,['/Movies']);
});
