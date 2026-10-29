// Manual acceptance: the human authorized writes only within this test folder.
import {app,BrowserWindow} from 'electron';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {memoryStore} from '../helpers.mjs';
const root=process.env.CLOUDREEL_PACKAGE_ROOT || fileURLToPath(new URL('../../',import.meta.url));
const load=relative=>import(pathToFileURL(path.join(root,'electron',relative)).href);
const {createBaiduLogin}=await load('services/baidu-login.mjs');
const {DiscoveryBrowser}=await load('services/discovery-browser.mjs');
const {DiscoveryService}=await load('services/discovery.mjs');
const {BaiduShareService}=await load('services/baidu-share.mjs');
const {LibraryScanner}=await load('services/scanner.mjs');
const {Store}=await load('core/store.mjs');
const {PlayerService,discoverMpv}=await load('services/player.mjs');
const {NativeVideoHost}=await load('services/native-video.mjs');
const {isVideo}=await load('core/media.mjs');
const resources=process.env.CLOUDREEL_PACKAGE_ROOT ? path.dirname(root) : process.resourcesPath;
const TARGET='/CloudReel-SeedHub-Test';
app.setName('CloudReel-Discovery-Acceptance');app.setPath('userData',process.env.CLOUDREEL_TEST_DIRECTORY);
app.on('window-all-closed',()=>{});
let stage='startup',window,host,player,discovery,shares,login;
const summary={originalProfileWrites:0,traktWrites:0,remoteWriteScope:TARGET};
const progress=value=>console.log('REAL_PLAYBACK_RESULT '+JSON.stringify({progress:value}));
const until=async(check,timeout=160000)=>{const end=Date.now()+timeout;while(Date.now()<end){if(await check())return;await new Promise(resolve=>setTimeout(resolve,250));}throw new Error('timeout');};
app.whenReady().then(async()=>{
  const store=memoryStore();store.upsert=Store.prototype.upsert;Object.assign(store.data.settings,{autoSync:false,autoScrape:false,autoRefresh:false,autoNext:false});
  window=new BrowserWindow({show:false,width:1280,height:800,webPreferences:{backgroundThrottling:false}});
  for(const method of ['show','showInactive','focus'])window[method]=()=>{throw new Error('visibility prohibited');};
  login=createBaiduLogin(store,()=>{},()=>window);stage='restore';await login.restore();if(!login.service.connected)throw new Error('login unavailable');
  const originalRequest=login.service.request.bind(login.service);
  login.service.request=async(route,params,options)=>{
    try {return await originalRequest(route,params,options);} catch(error){if(stage.startsWith('playback'))progress({route,requestFailed:true,code:Number.isFinite(Number(error.code))?Number(error.code):undefined});throw error;}
  };
  discovery=new DiscoveryService({createBrowser:()=>new DiscoveryBrowser('https://sidhub.cc')});
  const scanner=new LibraryScanner(store,login.service);
  const transport={cookies:login.browserSession.cookies,fetch:async(input,options)=>{
    const response=await login.browserSession.fetch(input,options),route=new URL(input).pathname;
    if(['/share/transfer','/share/taskquery'].includes(route)) {
      const data=await response.clone().json().catch(()=>({}));
      progress({route,keys:Object.keys(data),errno:data.errno,status:data.status,taskIdPresent:Boolean(data.taskid||data.task_id),extraKeys:Object.keys(data.extra||{})});
    }
    return response;
  }};
  shares=new BaiduShareService({store,web:login.service,browserSession:transport,createBrowser:()=>new DiscoveryBrowser('https://pan.baidu.com',{browserSession:login.browserSession}),importDirectory:async target=>{
    if(target.path!==TARGET)throw new Error('out of scope');return scanner.importBaiduDirectory(target.path);
  }});
  stage='catalog';const catalog=process.env.CLOUDREEL_DISCOVERY_REUSE ? {movies:[]} : await discovery.catalog();let chosen,preview;
  for(const movie of catalog.movies.slice(0,2)) {
    const detail=await discovery.detail(movie.id);
    for(const resource of detail.resources.slice(0,3)) {
      try {
        stage='share inspection';preview=await shares.inspect(await discovery.resolve(resource.id),'转存验收');
        const queue=[{files:preview.files,depth:0}];let visits=0;
        while(queue.length&&!chosen&&visits++<12) {
          const current=queue.shift();chosen=current.files.filter(file=>!file.isdir&&isVideo(file.server_filename)&&file.size>1024**2&&file.size<6*1024**3).sort((a,b)=>a.size-b.size)[0];
          if(!chosen&&current.depth<3)for(const folder of current.files.filter(file=>file.isdir).slice(0,4)) {const result=await shares.list({handle:preview.handle,directory:folder.path,page:1});queue.push({files:result.files,depth:current.depth+1});}
        }
      } catch {continue;}
      if(chosen)break;
    }
    if(chosen)break;
  }
  if(!chosen&&!process.env.CLOUDREEL_DISCOVERY_REUSE)throw new Error('no suitable source');
  if(chosen)progress({shareRead:true,selectedVideo:true,sizeMB:Math.round(chosen.size/1024**2)});
  stage='test destination';let destination;
  for(let start=0;start<20000;){const result=await login.service.list('/',start);destination=result.files.find(file=>file.path===TARGET&&Number(file.isdir)===1);if(destination||!result.hasMore)break;start=result.nextStart;}
  if(!destination&&process.env.CLOUDREEL_DISCOVERY_REUSE)throw new Error('existing destination unavailable');
  if(!destination) {
    const variables=await login.service.sessionVariables();
    destination=await login.service.request('/api/create',{bdstoken:variables.bdstoken},{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({path:TARGET,isdir:'1',block_list:'[]'}).toString()});
  }
  if(!destination.fs_id)throw new Error('destination unavailable');
  const before=await login.service.list(TARGET),beforeIds=new Set(before.files.map(file=>String(file.fs_id)));
  // Reuse the previously authorized write, even if the live catalog changed.
  const existing=before.files.find(file=>!file.isdir&&isVideo(file.server_filename));
  if(existing) {
    stage='existing transfer ingestion';await scanner.importBaiduDirectory(TARGET);summary.reusedSavedTestFile=true;summary.additionalTransferWrites=0;
  } else {
    if(!chosen||process.env.CLOUDREEL_DISCOVERY_REUSE)throw new Error('existing test file unavailable');
    stage='transfer';const job=await shares.transfer({handle:preview.handle,fsIds:[chosen.fs_id],target:{fsId:String(destination.fs_id),path:TARGET},mount:false});
    await until(()=>['complete','saved','failed','uncertain'].includes(shares.status().find(task=>task.id===job.id)?.status));
    const result=shares.status().find(task=>task.id===job.id);progress({transferState:result.status,ingestedVideos:store.data.items.length});
    const after=await login.service.list(TARGET);summary.newFiles=after.files.filter(file=>!beforeIds.has(String(file.fs_id))).length;
    if(result.status!=='complete')throw new Error('transfer not confirmed');
  }
  const item=store.data.items.find(value=>existing ? String(value.fsId)===String(existing.fs_id) : !beforeIds.has(String(value.fsId)));if(!item)throw new Error('ingestion unavailable');
  stage='playback';host=new NativeVideoHost(()=>window,()=>1);host.layout({x:0,y:0,width:1280,height:800});
  player=new PlayerService(store,login.service,{}, {eligible:()=>false,start:async()=>{},checkpoint:async()=>{}},{resolveMpv:()=>discoverMpv('',resources,root),videoHost:host,inputConfig:path.join(process.env.CLOUDREEL_PACKAGE_ROOT?path.join(resources,'player'):path.join(root,'electron'),'player-keys.conf'),spawnPlayer:(binary,args,options)=>{const quiet=[...args];quiet.splice(quiet.indexOf('--'),0,'--mute=yes');return spawn(binary,quiet,options);}});
  stage='playback preparation';await player.play(item.id,true);progress({prepared:true});
  stage='playback decode';await until(()=>player.session?.position>1&&player.session?.videoParams&&player.session?.videoTarget,60000);
  progress({decoded:true,duration:Math.round(player.session.duration)});
  stage='playback seek';player.seek({itemId:item.id,seconds:30});await until(()=>!player.status().seek?.pending&&Math.abs(player.session.position-30)<8,45000);
  summary.passed=true;summary.decoded=true;summary.seek=true;summary.mountedRoots=store.data.scanRoots?.length||0;
}).catch(error=>{
  summary.passed=false;summary.stage=stage;summary.errorType=error.name;
  // Emit only allowlisted diagnostics, never upstream payloads or media URLs.
  const message=String(error.message);
  summary.reason=message==='timeout'?'timeout':/媒体服务器拒绝/.test(message)?'media-rejected':/媒体连接失败|原文件暂时无法读取/.test(message)?'media-connection':/文件信息与所选文件 ID/.test(message)?'file-identity-mismatch':/文件已删除|无法访问/.test(message)?'file-inaccessible':/会话|登录/.test(message)?'session':/mpv|播放器/.test(message)?'player':/视频画面/.test(message)?'native-host':'other';
  if(Number.isFinite(error.code))summary.errorCode=error.code;
  summary.frame=String(error.stack).split('\n').slice(1,3).map(line=>line.replace(/file:\/\/\//g,'').replace(/D:.*?(?=\/electron\/|\/tests\/)/g,'workspace'));
  if(player){const status=player.status();summary.player={present:Boolean(status),position:status?.position,duration:status?.duration,buffering:status?.buffering,video:Boolean(player.session?.videoParams),target:Boolean(player.session?.videoTarget),loadError:Boolean(status?.loadError),seekError:Boolean(status?.seek?.error)};}
}).finally(async()=>{
  await player?.stop().catch(()=>{});shares?.close();discovery?.close();host?.destroy();
  summary.visibleWindows=BrowserWindow.getAllWindows().filter(view=>view.isVisible()).length;window?.destroy();
  await new Promise(resolve=>process.stdout.write('REAL_PLAYBACK_RESULT '+JSON.stringify(summary)+'\n',resolve));app.exit(summary.passed?0:1);
});
