import {test} from 'node:test';
import assert from 'node:assert/strict';
import {discoveryWork,namingPlan,availableName,safeName} from '../electron/core/discovery-naming.mjs';
import {organizeSavedCopies,transferReceipt} from '../electron/services/discovery-organizer.mjs';
import {BaiduShareService} from '../electron/services/baidu-share.mjs';
import {BaiduWebService} from '../electron/services/baidu-web.mjs';
import {MetadataService} from '../electron/services/metadata.mjs';
import {LibraryScanner} from '../electron/services/scanner.mjs';
import {Store} from '../electron/core/store.mjs';
import {memoryStore} from './helpers.mjs';

const file=(name,fsId='10',directory='/share')=>({fs_id:fsId,server_filename:name,path:directory+'/'+name,isdir:0,size:100});
const show={title:'硅谷',originalTitle:'Silicon Valley',kind:'episode',season:4,year:2017};
const until=async check=>{for(let i=0;i<200;i++){if(check())return;await new Promise(resolve=>setTimeout(resolve,5));}throw Error('timeout');};

test('site facts distinguish season-specific series, movies, years and original titles',()=>{
  const work=discoveryWork({heading:'硅谷 第四季 Silicon Valley Season 4',workTitle:'硅谷 第四季',facts:'首播: 2017-04-23(美国) 集数: 10'});
  assert.equal(work.title,'硅谷');assert.equal(work.originalTitle,'Silicon Valley');assert.equal(work.season,4);assert.equal(work.kind,'episode');
  const movie=discoveryWork({heading:'1917',workTitle:'1917',facts:'上映日期: 2019-12-25 集数: 1'});
  assert.equal(movie.title,'1917');assert.equal(movie.year,2019);assert.equal(movie.kind,'movie');
});

test('episode naming handles explicit and numeric episodes without replacing extensions or quality',()=>{
  const names=['03.mkv','EP04.MP4','第十二集.mkv','[05].mkv','Silicon.Valley.S04E06.1080p.WEB-DL.x265.mkv','硅谷07.mkv'];
  const plan=namingPlan(names.map((name,index)=>file(name,String(index+1))),show);
  assert.deepEqual(plan.map(value=>value.identity.episode),[3,4,12,5,6,7]);
  assert.equal(plan[0].name,'硅谷 - S04E03.mkv');assert.equal(plan[1].name,'硅谷 - S04E04.MP4');
  assert.equal(plan[4].name,'硅谷 - S04E06 - 1080p WEB-DL HEVC.mkv');
  assert.equal(namingPlan([file('02.mkv')],{...show,season:undefined},{season:3})[0].name,'硅谷 - S03E02.mkv');
});

test('unknown episodes, conflicting seasons, multi-episode files, collections and extras keep their names',()=>{
  for(const name of ['random.mkv','S02E03.mkv','S04E01E02.mkv','S04E01-E02.mkv','第1-2集.mkv','sample.S04E03.mkv','其他片名03.mkv']){
    const plan=namingPlan([file(name)],show)[0];assert.ok(plan.reason,name);assert.equal(plan.name,name);assert.equal(plan.identity,null);
  }
  assert.ok(namingPlan([file('03.mkv','10','/全集合/硅谷1-6季合集')],show)[0].reason);
  assert.equal(namingPlan([file('01.mkv','10','/Specials')],show)[0].name,'硅谷 - S00E01.mkv');
});

test('movie names include year, subtitles follow their video, and mixed films are never relabelled as one',()=>{
  const work={title:'星际穿越',kind:'movie',year:2014};
  const plan=namingPlan([file('abc.2160p.mkv'),file('abc.2160p.chs.ass','11'),file('abc.2160p.chs.srt','12'),file('abc.2160p.eng.srt','13')],work);
  assert.equal(plan[0].name,'星际穿越 (2014) - 2160p.mkv');assert.equal(plan[1].name,'星际穿越 (2014) - 2160p.chs.ass');assert.equal(plan[1].videoSourceId,'10');
  assert.equal(plan.length,4);assert.equal(plan[2].name,'星际穿越 (2014) - 2160p.chs.srt');assert.equal(plan[3].videoSourceId,'10');
  assert.ok(namingPlan([file('a.mkv'),file('b.mp4','11')],work).every(value=>value.reason));
  assert.equal(availableName('星际穿越 (2014).mkv',['星际穿越 (2014).mkv'],'old.mkv'),'星际穿越 (2014) - 版本 2.mkv');
  assert.ok(Buffer.byteLength(safeName('标题'.repeat(100)))<=150);assert.equal(safeName('CON'),'CON_');assert.equal(safeName('A:B / C'),'A B C');
});

function organizerSetup({collision=false,timeout=false}={}) {
  const source=file('03.mkv'),subtitle=file('03.chs.srt','11'),plan=namingPlan([source,subtitle],show);
  const dest=file('03.mkv','100','/Movies/New'),sub=file('03.chs.srt','101','/Movies/New');
  const files=[dest,sub,...(collision?[file('硅谷 - S04E03.mkv','102','/Movies/New')]:[])],renames=[];
  const job={target:'/Movies/New',targetFsId:'300',copyReceipt:[{fsId:'100',sourceId:'10'},{fsId:'101',sourceId:'11'}],naming:{roots:[source,subtitle],plan,beforeIds:collision?['102']:[],results:[]}};
  const web={fileInfo:async id=>String(id)==='300'?{fs_id:'300',path:'/Movies/New',isdir:1}:files.find(value=>value.fs_id===String(id)),list:async()=>({files,hasMore:false}),renameFile:async(current,name)=>{renames.push(current.fs_id);current.server_filename=name;current.path='/Movies/New/'+name;if(timeout)throw Error('timeout after success');return current;}};
  return {job,web,files,renames};
}

test('only copied IDs are renamed, collisions retain peers and subtitle stems follow the allocated video name',async()=>{
  const {job,web,files,renames}=organizerSetup({collision:true});
  const result=await organizeSavedCopies(job,web,async()=>{});
  assert.deepEqual(renames,['100','101']);assert.equal(result.counts.renamed,2);assert.equal(result.identities[0].episode,3);
  assert.equal(files[0].server_filename,'硅谷 - S04E03 - 版本 2.mkv');assert.equal(files[1].server_filename,'硅谷 - S04E03 - 版本 2.chs.srt');assert.equal(files[2].server_filename,'硅谷 - S04E03.mkv');
});

test('rename timeouts verify the copied ID, and a second status check never renames again',async()=>{
  const {job,web,renames}=organizerSetup({timeout:true});
  assert.equal((await organizeSavedCopies(job,web,async()=>{})).counts.renamed,2);
  assert.equal((await organizeSavedCopies(job,web,async()=>{})).counts.unchanged,2);assert.equal(renames.length,2);
});

test('missing receipts and ambiguous new names never allow changes to pre-existing or uncertain files',async()=>{
  const {job,web,files,renames}=organizerSetup();job.copyReceipt=[];job.naming.beforeIds=['100','101'];
  assert.equal((await organizeSavedCopies(job,web,async()=>{})).counts.failed,2);assert.equal(renames.length,0);
  job.naming.beforeIds=[];files.push(file('03.mkv','102','/Movies/New'));
  assert.ok((await organizeSavedCopies(job,web,async()=>{})).counts.failed>0);assert.ok(!renames.includes('100'));
});

test('transfer receipt extraction preserves exact int64 copy IDs and discards unrelated upstream fields',()=>{
  const result=transferReceipt({extra:{list:[{to_fs_id:'9007199254740993123',from_fs_id:'10',from:'/share/03.mkv',dlink:'PRIVATE',sekey:'PRIVATE'}]}});
  assert.equal(result[0].fsId,'9007199254740993123');assert.ok(!JSON.stringify(result).includes('PRIVATE'));
});

test('successful normalization feeds trusted identities into scoped ingestion without changing existing progress',async()=>{
  const store=memoryStore();store.upsert=Store.prototype.upsert;
  store.data.items=[{id:'baidu:1',source:'baidu',fsId:'1',path:'/Movies/old.mkv',filename:'old.mkv',identificationLocked:true,title:'Old',progress:{position:42}}];
  const scanner=new LibraryScanner(store,{list:async()=>({files:[file('nonsense.mkv','100','/Movies')],hasMore:false})});
  await scanner.importBaiduDirectory('/Movies',{identities:[{fsId:'100',...show,season:4,episode:3}],selection:{source:'tmdb',id:'60573',kind:'episode'}});
  assert.equal(store.data.items[1].title,'硅谷');assert.equal(store.data.items[1].season,4);assert.equal(store.data.items[1].episode,3);assert.equal(store.data.items[1].catalog.id,'60573');assert.equal(store.data.items[1].catalog.pending,true);
  assert.equal(store.data.items[0].progress.position,42);
});

test('metadata naming uses a unique confident TMDB match and leaves ambiguous titles unchanged',async()=>{
  const service=new MetadataService(memoryStore(),{},{tmdbToken:'test'});
  service.search=async()=>[{source:'tmdb',id:'60573',kind:'episode',title:'硅谷',originalTitle:'Silicon Valley',year:2014,voteCount:100}];
  const work=await service.discoveryWork(show);assert.equal(work.selection.id,'60573');assert.equal(work.year,2014);
  service.search=async()=>[{source:'tmdb',id:'1',kind:'movie',title:'Same',year:2000,voteCount:100},{source:'tmdb',id:'2',kind:'movie',title:'Same',year:2020,voteCount:100}];
  assert.equal((await service.discoveryWork({title:'Same',kind:'movie'})).selection,undefined);
});

test('web rename uses fail-on-collision, exact paths and ID verification without changing the original share',async()=>{
  const service=new BaiduWebService(memoryStore(),{}),current=file('03.mkv','100','/Movies/New');let requests=0;
  service.fileInfo=async()=>({...current});service.sessionVariables=async()=>({bdstoken:'PRIVATE'});
  service.request=async(route,params,options)=>{requests++;assert.equal(route,'/api/filemanager');assert.equal(params.opera,'rename');assert.equal(params.ondup,'fail');const list=JSON.parse(new URLSearchParams(options.body).get('filelist'));assert.deepEqual(list,[{path:'/Movies/New/03.mkv',newname:'硅谷 - S04E03.mkv'}]);current.path='/Movies/New/硅谷 - S04E03.mkv';current.server_filename='硅谷 - S04E03.mkv';return {errno:0,info:[{errno:0}]};};
  await service.renameFile({...current},'硅谷 - S04E03.mkv');assert.equal(requests,1);
  await assert.rejects(service.renameFile(file('wrong.mkv','100','/Movies/New'),'next.mkv'),/变化/);assert.equal(requests,1);
});

test('transfer creates an isolated work folder, normalizes only its copy and never resubmits after a status check',async()=>{
  const store=memoryStore(),source=file('03.mkv'),files=[],imports=[];let submits=0,creates=0;
  const web={connected:true,sessionVariables:async()=>({uk:'123',bdstoken:'PRIVATE'}),fileInfo:async id=>String(id)==='300'?{fs_id:'300',path:'/Movies',isdir:1}:String(id)==='301'?{fs_id:'301',path:'/Movies/硅谷 - Season 04',isdir:1}:files.find(file=>file.fs_id===String(id)),list:async directory=>({files:directory==='/Movies'?[]:files,hasMore:false}),request:async()=>{creates++;return {fs_id:'301'};},renameFile:async(file,name)=>{file.path='/Movies/硅谷 - Season 04/'+name;file.server_filename=name;return file;}};
  const service=new BaiduShareService({store,web,browserSession:{fetch:async()=>{submits++;files.push(file('03.mkv','100','/Movies/硅谷 - Season 04'));return new Response(JSON.stringify({errno:0,extra:{list:[{from_fs_id:'10',to_fs_id:'100'}]}}));}},importDirectory:async target=>{imports.push(target);return 1;}});
  service.handles.set('test',{shareId:'50',ownerId:'60',sekey:'PRIVATE',title:'硅谷',work:show,files:new Map([['10',source]]),directories:new Set(['/']) ,at:Date.now()});
  const input={handle:'test',fsIds:['10'],target:{fsId:'300'},mount:true,autoRename:true};
  const result=await service.transfer(input);await until(()=>service.status()[0].status==='complete');
  assert.equal(creates,1);assert.equal(submits,1);assert.equal(files[0].server_filename,'硅谷 - S04E03.mkv');assert.equal(imports[0].mountFsId,'300');assert.equal(imports[0].identities[0].episode,3);assert.equal(source.server_filename,'03.mkv');
  await service.check(result.id);await until(()=>!service.busy);assert.equal(submits,1);assert.equal(creates,1);assert.ok(!JSON.stringify(store.data).includes('PRIVATE'));
});

test('background filename guesses yield to the saved identity while manually matched entries remain protected',async()=>{
  const store=memoryStore();store.upsert=Store.prototype.upsert;
  store.data.items=[{id:'baidu:100',source:'baidu',fsId:'100',path:'/Movies/a.mkv',filename:'a.mkv',catalog:{id:'wrong',source:'tmdb',kind:'movie',title:'Wrong'}},{id:'baidu:101',source:'baidu',fsId:'101',path:'/Movies/b.mkv',filename:'b.mkv',title:'Manual',identificationLocked:true}];
  const scanner=new LibraryScanner(store,{list:async()=>({files:[file('a.mkv','100','/Movies'),file('b.mkv','101','/Movies')],hasMore:false})});
  await scanner.importBaiduDirectory('/Movies',{identities:['100','101'].map(fsId=>({fsId,...show,episode:3}))});
  assert.equal(store.data.items[0].title,'硅谷');assert.equal(store.data.items[0].catalog,undefined);assert.equal(store.data.items[1].title,'Manual');
});

test('nested copied folders are traversed once and resuming a rename reuses recorded destination IDs',async()=>{
  const source={fs_id:'10',server_filename:'Season4',path:'/Season4',isdir:1,size:0},video=file('03.mkv','11','/Season4/1080p');
  const copied={...source,fs_id:'100',path:'/Movies/New/Season4'},dest=file('03.mkv','101','/Movies/New/Season4/1080p');let renames=0;
  const job={target:'/Movies/New',targetFsId:'300',copyReceipt:[{sourceId:'10',fsId:'100'}],naming:{roots:[source],beforeIds:[],results:[],plan:namingPlan([video],show)}};
  const web={fileInfo:async id=>id==='300'?{isdir:1,path:'/Movies/New'}:dest,list:async directory=>({files:directory==='/Movies/New'?[copied]:[dest],hasMore:false}),renameFile:async(file,name)=>{renames++;file.path='/Movies/New/Season4/1080p/'+name;file.server_filename=name;return file;}};
  assert.equal((await organizeSavedCopies(job,web,async()=>{})).counts.renamed,1);job.copyReceipt=[];
  assert.equal((await organizeSavedCopies(job,web,async()=>{})).counts.unchanged,1);assert.equal(renames,1);
});

test('a directly attached discovery identity hydrates metadata and episode details without searching filenames again',async()=>{
  const store=memoryStore();store.upsert=Store.prototype.upsert;
  const scanner=new LibraryScanner(store,{list:async()=>({files:[file('03.mkv','100','/Movies')],hasMore:false})});
  await scanner.importBaiduDirectory('/Movies',{identities:[{fsId:'100',...show,episode:3}],selection:{source:'tmdb',id:'60573',kind:'episode'}});
  const metadata=new MetadataService(store,{cache:async()=>undefined},{tmdbToken:'test'});let detailCalls=0,searches=0;
  metadata.search=async()=>{searches++;throw Error('filename search should not run');};
  metadata.detail=async selection=>{detailCalls++;assert.equal(selection.id,'60573');return {source:'tmdb',id:'60573',kind:'episode',title:'硅谷',year:2014};};
  metadata.localized=async route=>{assert.equal(route,'/tv/60573/season/4');return {episodes:[{episode_number:3,id:900,name:'第三集',overview:'已获取分集简介'}]};};
  metadata.titleArt=async()=>{};
  await metadata.run({background:true});assert.equal(searches,0);assert.equal(detailCalls,1);assert.equal(store.data.items[0].episodeMetadata.title,'第三集');assert.equal(store.data.items[0].catalog.pending,undefined);
});
