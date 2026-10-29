import {createHash, randomUUID} from 'node:crypto';
import {baiduShare, sharePageState} from '../core/discovery.mjs';
import {namingPlan,safeName} from '../core/discovery-naming.mjs';
import {directoryFiles,organizeSavedCopies,transferReceipt} from './discovery-organizer.mjs';

const id = value => /^\d{1,24}$/.test(String(value)) && /[1-9]/.test(String(value)) ? String(value) : null;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const cleanFile = file => {
  const fsId = id(file.fs_id);
  if (!fsId || typeof file.server_filename !== 'string' || typeof file.path !== 'string' || !file.path.startsWith('/') || /[\u0000-\u001f]/.test(file.path) || file.path.split('/').some(part=>part==='.'||part==='..') || file.path.split('/').at(-1)!==file.server_filename) throw new Error('分享返回了无效的文件信息。');
  return {fs_id:fsId, server_filename:file.server_filename, path:file.path, size:Number(file.size) || 0, isdir:Number(file.isdir) === 1 ? 1 : 0};
};

export async function shareJson(fetcher, route, params = {}, options = {}) {
  const url = new URL(route, 'https://pan.baidu.com');
  if (url.origin !== 'https://pan.baidu.com' || !['/share/list','/share/transfer','/share/taskquery'].includes(url.pathname)) throw new Error('无效的分享请求。');
  for (const [key,value] of Object.entries({web:1,clienttype:0,app_id:250528,...params})) if (value !== undefined) url.searchParams.set(key,String(value));
  let response;
  try {response = await fetcher(url.href,{...options, credentials:'include', cache:'no-store', signal:options.signal || AbortSignal.timeout(25000), headers:{Referer:'https://pan.baidu.com/',...options.headers}});} catch {throw new Error('网盘请求中断，请检查网络后确认任务状态。');}
  let data;
  try {data = JSON.parse(await response.text(),(key,value,context) => /(?:^|_)(?:fs_id|fsid|shareid|share_id|uk|taskid|task_id)$/.test(key) && typeof value === 'number' ? context?.source ?? String(value) : value);}
  catch {throw new Error('网盘暂时没有返回有效结果，可能需要在官方页面完成验证。');}
  if (!response.ok || Number(data.errno ?? 0) !== 0) {
    const code = Number(data.errno);
    const hints = {'-6':'百度登录已失效，请重新登录。','-9':'分享已失效或文件不存在，请换一个资源。','-12':'分享提取码不正确，请换一个资源。','-62':'百度要求安全验证，请打开官方页面完成验证后重试。','12':'部分文件无法转存，请确认分享仍然有效。','4':'提取码验证失败，请打开官方页面检查。','-30':'网盘空间不足，请清理空间后再保存。'};
    const error = new Error(hints[code] || `百度没有完成请求（${Number.isFinite(code) ? code : response.status}），请在官方页面检查。`); error.code = code; throw error;
  }
  return data;
}

export class BaiduShareService {
  constructor({store, web, browserSession, notify = () => {}, importDirectory = async () => 0, prepareWork = async work => work, createBrowser, pollDelay = 2500}) {
    Object.assign(this,{store,web,browserSession,notify,importDirectory,prepareWork,pollDelay});
    this.createBrowser = createBrowser;
    this.handles = new Map(); this.queue = Promise.resolve(); this.running = new Set(); this.closed = false;
    for (const job of this.jobs()) if (['submitting','submitted','renaming','importing'].includes(job.status)) {job.status = 'uncertain'; job.message = '上次任务被中断，请检查网盘中的保存结果。';}
  }
  jobs() {return this.store.data.discoveryTransfers ??= [];}
  status() {return this.jobs().slice(0,20).map(({id,title,status,message,target,count,at,taskId,copyConfirmed,namingSummary}) => ({id,title,status,message,target,count,at,namingSummary,canCheck:Boolean(taskId||copyConfirmed)}));}
  save() {this.store.persist();this.notify();}
  get busy() {return this.running.size > 0;}
  async account(job, refresh = false) {
    if (!this.web.connected || refresh && this.web.check && !await this.web.check()) throw new Error('请重新登录提交任务时的百度账号。');
    const variables = await this.web.sessionVariables();
    if (!id(variables.uk) || String(variables.uk) !== job.account) throw new Error('百度账号已变更，请使用提交任务时的账号检查结果。');
    return variables;
  }
  serial(work) {const result = this.queue.then(work); this.queue = result.catch(() => {}); return result;}
  request(route,params,options) {return shareJson((...args) => this.browserSession.fetch(...args),route,params,options);}
  inspect(input, title = '', work = null) {
    if (!baiduShare(input)) throw new Error('无效的百度分享链接。');
    return this.serial(async () => {
      const browser = this.browser ??= this.createBrowser();
      const {snapshot} = await browser.previewShare(input), state = sharePageState(snapshot);
      const hints = {'unavailable':'分享已失效，请选择其他资源。','verification-required':'百度要求安全验证，请打开官方页面验证后重试。','password-required':'百度没有接受分享提取码，请打开官方页面检查或选择其他资源。','login-required':'请先登录百度网盘，然后重新读取资源。'};
      if (state !== 'files-visible') throw new Error(hints[state] || '没有读取到分享文件，请稍后重试或打开官方页面。');
      const metadata = await browser.shareMetadata();
      if (!id(metadata.shareId) || !id(metadata.ownerId)) throw new Error('未能读取分享身份，请打开官方页面确认资源。');
      const cookies = await this.browserSession.cookies.get({url:'https://pan.baidu.com'});
      let sekey = cookies.find(cookie => cookie.name === 'BDCLND')?.value || '';
      try {sekey = decodeURIComponent(sekey);} catch {}
      const handle = randomUUID(), entry = {...metadata,sekey,url:input,title:String(title).slice(0,200),work:work?await this.prepareWork(work):null,files:new Map(),directories:new Set(['/']),trees:new Map(),at:Date.now()};
      this.handles.set(handle,entry); if (this.handles.size > 30) this.handles.delete(this.handles.keys().next().value);
      try {const result = await this.list({handle,directory:'/',page:1}); return {handle,work:entry.work,...result};}
      catch (error) {this.handles.delete(handle);throw error;}
    });
  }
  entry(handle) {const entry = this.handles.get(handle); if (!entry || Date.now()-entry.at > 30*60000) throw new Error('分享预览已过期，请重新选择资源。');return entry;}
  async list({handle,directory = '/',page = 1}) {
    const entry = this.entry(handle);
    if (!entry.directories.has(directory) || !Number.isInteger(page) || page < 1 || page > 1000) throw new Error('请选择分享内的有效文件夹。');
    const data = await this.request('/share/list',{uk:entry.ownerId,shareid:entry.shareId,sekey:entry.sekey,root:directory === '/' ? 1 : 0,dir:directory,page,num:100,order:'name',desc:0});
    if (!Array.isArray(data.list)) throw new Error('百度没有返回分享文件列表。');
    const files = data.list.map(cleanFile);
    for (const file of files) {entry.files.set(file.fs_id,file); if (file.isdir) entry.directories.add(file.path);}
    return {files,hasMore:data.has_more !== undefined ? Boolean(Number(data.has_more)) : files.length === 100,directory,page};
  }
  selection(entry,fsIds) {
    if (!Array.isArray(fsIds) || !fsIds.length || fsIds.length > 1000 || fsIds.some(value => !id(value) || !entry.files.has(String(value)))) throw new Error('请选择分享中的文件或文件夹。');
    return [...new Set(fsIds.map(String))].map(value => entry.files.get(value)).filter(file => !fsIds.some(other => {const parent = entry.files.get(String(other));return parent?.isdir && parent.fs_id !== file.fs_id && file.path.startsWith(parent.path + '/');}));
  }
  async selectedFiles(handle,selected) {
    const entry=this.entry(handle);entry.trees??=new Map();const key=selected.map(file=>file.fs_id).sort().join(',');
    if(entry.trees.has(key))return entry.trees.get(key);
    const result=[...selected.filter(file=>!file.isdir)],queue=selected.filter(file=>file.isdir).map(file=>file.path),seen=new Set();
    while(queue.length) {
      const directory=queue.shift();if(seen.has(directory))continue;seen.add(directory);
      if(seen.size>200||result.length>5000)throw new Error('所选文件过多，请分批保存并命名。');
      for(let page=1;page<=100;page++) {
        const listing=await this.list({handle,directory,page});
        for(const file of listing.files){if(file.path.slice(0,file.path.lastIndexOf('/'))!==directory)throw new Error('分享文件路径异常。');if(file.isdir)queue.push(file.path);else result.push(file);}
        if(!listing.hasMore)break;
        if(page===100)throw new Error('所选文件过多，请分批保存并命名。');
      }
    }
    if(result.length>5000)throw new Error('所选文件过多，请分批保存并命名。');
    entry.trees.set(key,result);return result;
  }
  async naming({handle,fsIds,season}) {
    const entry=this.entry(handle),selected=this.selection(entry,fsIds);
    const plan=namingPlan(await this.selectedFiles(handle,selected),entry.work,{season});
    return {total:plan.length,renamed:plan.filter(value=>!value.reason&&value.name!==value.original).length,skipped:plan.filter(value=>value.reason).length,files:plan.slice(0,100).map(({original,name,reason})=>({original,name,reason}))};
  }
  async transfer({handle,fsIds,target,mount = true,autoRename = false,season}) {
    if (!this.web.connected) throw new Error('请先登录百度网盘。');
    const entry = this.entry(handle),selected=this.selection(entry,fsIds);
    if (!id(target?.fsId)) throw new Error('请选择根目录下的影视文件夹作为保存目录。');
    const info = await this.web.fileInfo(target.fsId);
    if (Number(info.isdir) !== 1 || typeof info.path !== 'string') throw new Error('保存位置不是有效文件夹。');
    if (info.path === '/') throw new Error('请选择根目录下的影视文件夹作为保存目录。');
    const variables = await this.web.sessionVariables();
    if (!id(variables.uk) || !variables.bdstoken) throw new Error('请重新登录百度网盘后保存。');
    const key = createHash('sha256').update(JSON.stringify([String(variables.uk),entry.shareId,selected.map(file => file.fs_id).sort(),info.fs_id || '/'])).digest('hex');
    const previous = this.jobs().find(job => job.key === key && job.status !== 'failed');
    if (previous) return this.status().find(job => job.id === previous.id);
    if (this.running.size) throw new Error('请等待当前转存任务完成后再保存新的资源。');
    let naming;
    if(autoRename) {
      if(!entry.work?.title)throw new Error('未读取到作品信息，请重新打开资源。');
      if(new Set(selected.map(file=>file.server_filename.toLowerCase())).size!==selected.length)throw new Error('所选项目有同名文件或文件夹，请分批保存并命名。');
      const plan=namingPlan(await this.selectedFiles(handle,selected),entry.work,{season});
      naming={plan,roots:selected,beforeIds:[],results:[],selection:entry.work.selection};
    }
    if(this.running.size)throw new Error('请等待当前转存任务完成后再保存新的资源。');
    const job = {id:randomUUID(),key,title:entry.title || selected[0].server_filename,status:'submitting',message:'正在提交转存',target:info.path,targetFsId:info.fs_id && String(info.fs_id),count:0,at:new Date().toISOString(),mount:Boolean(mount),account:String(variables.uk),shareId:entry.shareId,ownerId:entry.ownerId,naming};
    this.jobs().unshift(job);this.store.data.discoveryTransfers = this.jobs().slice(0,40);this.save();
    this.running.add(job.id);
    void this.submit(job,entry,selected).finally(() => this.running.delete(job.id));
    return this.status().find(value => value.id === job.id);
  }
  async submit(job,entry,files) {
    let accepted = false, attempted = false;
    try {
      const variables = await this.account(job,true);
      if(job.naming)await this.createSaveFolder(job,entry.work);
      attempted = true;
      const data = await this.request('/share/transfer',{shareid:entry.shareId,from:entry.ownerId,sekey:entry.sekey,bdstoken:variables.bdstoken,ondup:'newcopy',async:1},{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({fsidlist:'['+files.map(file => file.fs_id).join(',')+']',path:job.target}).toString()});
      accepted = true;
      job.copyReceipt=transferReceipt(data);
      const taskId = id(data.taskid) || id(data.task_id);
      if (taskId) {job.taskId = taskId;job.status = 'submitted';job.message = '百度正在保存文件';this.save();await this.poll(job);}
      else if (Array.isArray(data.extra?.list) && data.extra.list.length) await this.finish(job);
      else {job.status = 'uncertain';job.message = '请求已送达，但尚未确认保存结果，请先检查网盘。';this.save();}
    } catch (error) {job.status = !attempted || !accepted && [-6,-9,-12,-62,-30,4].includes(error.code) ? 'failed' : 'uncertain';job.message = error.message;this.save();}
  }
  async createSaveFolder(job,work) {
    const parent=await this.web.fileInfo(job.targetFsId);
    if(Number(parent.isdir)!==1)throw new Error('保存目录不可用。');
    const siblings=await directoryFiles(this.web,parent.path),oldIds=new Set(siblings.map(file=>String(file.fs_id)));
    const base=safeName(work.title+(work.kind==='movie'&&work.year?` (${work.year})`:work.kind==='episode'&&work.season!==undefined?` - Season ${String(work.season).padStart(2,'0')}`:''));
    const names=new Set(siblings.map(file=>file.server_filename.toLowerCase()));
    for(let index=1;index<=100;index++) {
      const name=base+(index>1?` (${index})`:''),path=parent.path.replace(/\/$/,'')+'/'+name;if(names.has(name.toLowerCase()))continue;
      const variables=await this.account(job);
      let created;
      try{created=await this.web.request('/api/create',{a:'commit',bdstoken:variables.bdstoken},{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({path,isdir:'1',block_list:'[]',rtype:'0'}).toString()});}
      catch(error){if(Number(error.code)===-8){names.add(name.toLowerCase());continue;}throw error;}
      if(!id(created.fs_id)||oldIds.has(String(created.fs_id)))throw new Error('没有确认独立保存文件夹，请检查网盘。');
      const confirmed=await this.web.fileInfo(created.fs_id);
      if(Number(confirmed.isdir)!==1||confirmed.path!==path)throw new Error('没有确认独立保存文件夹，请检查网盘。');
      job.mountPath=parent.path;job.mountFsId=String(parent.fs_id);job.target=confirmed.path;job.targetFsId=String(confirmed.fs_id);job.naming.beforeIds=[];this.save();return;
    }
    throw new Error('保存目录同名文件夹过多，请更换目录。');
  }
  async poll(job) {
    for (let attempt=0;attempt<48 && !this.closed;attempt++) {
      const variables = await this.account(job);
      const data = await this.request('/share/taskquery',{taskid:job.taskId,shareid:job.shareId,from:job.ownerId,bdstoken:variables.bdstoken});
      const state = String(data.status ?? data.task_status ?? '');
      if (Number(data.task_errno || 0) !== 0 || ['failed','failure'].includes(state)) {job.status = 'failed';job.message = '百度未能完成转存，请在官方页面检查文件和空间。';this.save();return;}
      if (['success','done'].includes(state)) {const receipt=transferReceipt(data);if(receipt.length)job.copyReceipt=receipt;await this.finish(job);return;}
      await delay(this.pollDelay);
    }
    job.status = 'uncertain';job.message = '任务仍待确认，可以稍后检查状态。';this.save();
  }
  async check(jobId) {
    const job = this.jobs().find(value => value.id === jobId);
    if (!job || !job.taskId&&!job.copyConfirmed || this.running.has(job.id)) return this.status();
    this.running.add(job.id);job.status = 'submitted';job.message = '正在检查转存结果';this.save();
    void (job.copyConfirmed?this.finish(job):this.poll(job)).catch(error => {job.status = 'uncertain';job.message = error.message;this.save();}).finally(() => this.running.delete(job.id));
    return this.status();
  }
  async finish(job) {
    if (this.closed) return;
    job.copyConfirmed=true;
    let identities=[];
    if(job.naming) {
      job.status='renaming';job.message='已保存，正在规范文件名';this.save();
      try {await this.account(job,true);const result=await organizeSavedCopies(job,this.web,()=>{if(this.closed)throw new Error('任务已停止');return this.account(job);},()=>this.save());identities=result.identities;job.namingSummary=result.counts;}
      catch {job.namingSummary={failed:job.naming.plan.length,renamed:0,skipped:0,unchanged:0};}
    }
    if(this.closed)return;
    job.status = 'importing';job.message = '已保存，正在整理目标文件夹';this.save();
    try {await this.account(job,true);job.count = await this.importDirectory({path:job.target,fsId:job.targetFsId,mount:job.mount,mountPath:job.mountPath,mountFsId:job.mountFsId,identities,selection:job.naming?.selection});job.status = 'complete';job.message = job.count ? `已保存并添加 ${job.count} 个视频` : '已保存到网盘，目标目录中没有新增视频';if(job.namingSummary){const summary=job.namingSummary;job.message+=` · 规范 ${summary.renamed+summary.unchanged} 项`+(summary.skipped?`，${summary.skipped} 项保留原名`:'')+(summary.failed?`，${summary.failed} 项命名未完成，可检查状态`:'');if(summary.failed)job.status='saved';}}
    catch {job.status = 'saved';job.message = '文件已保存，入库暂未完成，请刷新目标文件夹。';}
    this.save();
  }
  close() {this.closed = true;this.browser?.destroy();this.handles.clear();}
}
