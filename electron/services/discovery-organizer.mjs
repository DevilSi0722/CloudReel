import path from 'node:path';
import {availableName} from '../core/discovery-naming.mjs';

const inside=(value,directory)=>value.startsWith(directory.replace(/\/$/,'')+'/');
export async function directoryFiles(web,directory) {
  const files=[];
  for(let start=0,page=0;page<1000;page++) {
    const result=await web.list(directory,start);
    for(const file of result.files){if(path.posix.dirname(file.path)!==directory)throw new Error('保存目录返回了异常路径。');files.push(file);}
    if(!result.hasMore)return files;
    if(!Number.isSafeInteger(result.nextStart)||result.nextStart<=start)throw new Error('保存目录分页异常。');
    start=result.nextStart;
  }
  throw new Error('保存目录过大，请更换目录。');
}

// Keep only copy identities from the receipt. Upstream payloads, share URLs,
// session fields and extraction codes must never become persisted task data.
export function transferReceipt(data) {
  return (data.extra?.list||data.list||[]).flatMap(value=>{
    const fsId=String(value.to_fs_id||'');if(!/^[1-9]\d{0,23}$/.test(fsId))return [];
    return [{fsId,sourceId:String(value.from_fs_id||value.fs_id||''),sourcePath:typeof value.from==='string'?value.from:undefined}];
  });
}

export async function organizeSavedCopies(job,web,checkAccount,save=()=>{}) {
  const identities=[],counts={renamed:0,unchanged:0,skipped:0,failed:0};
  if(!job.naming)return {identities,counts};
  await checkAccount();
  const target=await web.fileInfo(job.targetFsId);
  if(Number(target.isdir)!==1)throw new Error('保存目录不可用。');
  job.target=target.path;
  const before=new Set(job.naming.beforeIds),top=await directoryFiles(web,target.path),roots=[];
  for(const source of job.naming.roots) {
    const receipts=(job.copyReceipt||[]).filter(value=>value.sourceId===source.fs_id||value.sourcePath===source.path);
    const eligible=top.filter(file=>!before.has(String(file.fs_id))&&Number(file.isdir)===source.isdir&&(source.isdir||Number(file.size)===Number(source.size)));
    // An explicit copy receipt wins. Without one, only a single new exact-name
    // match is safe; ambiguous copies remain untouched rather than guessing.
    const candidates=eligible.filter(file=>receipts.some(value=>value.fsId===String(file.fs_id)));
    const exact=eligible.filter(file=>file.server_filename===source.server_filename);
    const file=candidates.length===1?candidates[0]:!receipts.length&&exact.length===1?exact[0]:null;
    if(file&&!roots.some(value=>value.destination.fs_id===file.fs_id))roots.push({source,destination:file});
  }
  const siblings=new Map(),listings=new Map([[target.path,top]]);
  const listing=async directory=>{if(!listings.has(directory))listings.set(directory,await directoryFiles(web,directory));return listings.get(directory);};
  for(const plan of job.naming.plan) {
    if(plan.reason){counts.skipped++;continue;}
    try {
      if(job.cancelled)throw new Error('任务已停止');
      await checkAccount();
      let record=job.naming.results.find(value=>value.sourceId===plan.sourceId);
      const root=roots.find(value=>value.source.fs_id===plan.sourceId||value.source.isdir&&inside(plan.sourcePath,value.source.path));
      if(!root&&!record){counts.failed++;continue;}
      let file;
      if(record)file=await web.fileInfo(record.fsId);
      else {
        const expected=root.source.isdir?root.destination.path+plan.sourcePath.slice(root.source.path.length):root.destination.path;
        if(root.source.isdir)file=(await listing(path.posix.dirname(expected))).find(value=>value.path===expected);
        else file=root.destination;
        if(!file)throw new Error('已保存文件尚未出现');
        record={sourceId:plan.sourceId,fsId:String(file.fs_id),originalPath:file.path};job.naming.results.push(record);save();
      }
      if(Number(file.isdir)||!inside(file.path,target.path)||Number(file.size)!==Number(plan.size))throw new Error('已保存文件信息变化');
      const directory=path.posix.dirname(file.path);
      if(!siblings.has(directory))siblings.set(directory,(await listing(directory)).map(value=>value.server_filename));
      const video=plan.videoSourceId&&job.naming.results.find(value=>value.sourceId===plan.videoSourceId&&value.complete);
      if(plan.videoSourceId&&!video)throw new Error('视频尚未完成命名');
      const intended=video?video.name.slice(0,-path.posix.extname(video.name).length)+plan.subtitleSuffix:plan.name;
      const names=siblings.get(directory),newname=record.name||availableName(intended,names,file.server_filename);
      if(!record.name){record.name=newname;save();}
      if(file.server_filename!==newname) {
        // A timeout can occur after a successful rename. Verify the same ID
        // before reporting failure; never resubmit a transfer or touch a peer.
        try {file=await web.renameFile(file,newname);}catch {file=await web.fileInfo(record.fsId);if(file.server_filename!==newname)throw new Error('重命名未确认');}
        names.push(newname);counts.renamed++;
      } else counts.unchanged++;
      record.complete=true;save();
      if(plan.identity)identities.push({fsId:record.fsId,...plan.identity});
    } catch {counts.failed++;}
  }
  return {identities,counts};
}
