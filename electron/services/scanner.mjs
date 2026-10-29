import fs from 'node:fs/promises';
import path from 'node:path';
import {isVideo, localItem, baiduItem} from '../core/media.mjs';
import {identifyLibrary} from '../core/identification.mjs';
const within = (file, root, source) => source === 'local' ? path.relative(root, file) === '' || !path.relative(root, file).startsWith('..') && !path.isAbsolute(path.relative(root,file)) : file.startsWith(root.replace(/\/$/, '') + '/');
export class LibraryScanner {
  constructor(store, baidu, notify = () => {}, onComplete = () => {}) {Object.assign(this, {store, baidu, notify, onComplete}); this.state = {running:false,count:0,added:0,changed:0,directory:'',error:null};}
  roots() {return this.store.data.scanRoots ??= [];}
  add(source, directory, fsId) {
    if (!['local','baidu'].includes(source) || typeof directory !== 'string' || !directory.trim()) throw new Error('请选择有效的影视目录。');
    const location = source === 'local' ? path.resolve(directory) : path.posix.normalize('/' + directory.replace(/^\/+/, ''));
    let root = this.roots().find(r => r.source === source && (fsId && r.fsId === String(fsId) || r.path === location && (!fsId || !r.fsId)));
    if (!root) {root = {id:crypto.randomUUID(),source,path:location,enabled:true}; this.roots().push(root);}
    root.path = location; if(fsId) root.fsId = String(fsId); root.enabled = true; this.store.persist();
    return root;
  }
  async mountBaidu(input) {
    if(this.state.running && !this.state.background) throw new Error('请先结束当前扫描。');
    let directory = '/'; let fsId;
    if(input?.path !== '/' || input?.fsId) {
      const info = await this.baidu.fileInfo(input?.fsId);
      if(Number(info.isdir) !== 1) throw new Error('请选择网盘文件夹。');
      directory = info.path; fsId = info.fs_id;
    }
    // A different request may have started scanning while metadata was loading.
    if(this.state.running && !this.state.background) throw new Error('请先结束当前扫描。');
    const root = this.add('baidu',directory,fsId);this.refresh([root.id]);return root;
  }
  cancel() {if(this.state.running) this.state.cancelled = true; this.notify();}
  async importBaiduDirectory(directory,{identities=[],selection}={}) {
    // Additions only: never mark old files unavailable or restart a refresh.
    if (typeof directory !== 'string' || !directory.startsWith('/') || directory.includes('\0')) throw new Error('无效的保存目录。');
    const queue = [directory], seen = new Set(), found = new Map();
    while (queue.length) {
      const current = queue.shift(); if (seen.has(current)) continue; seen.add(current);
      if (seen.size > 10000) throw new Error('目标目录包含过多子文件夹，请手动刷新。');
      let start = 0;
      for (let page=0;page<1000;page++) {
        const result = await this.baidu.list(current,start);
        for (const file of result.files) {
          if (file.path !== directory && !file.path.startsWith(directory.replace(/\/$/,'') + '/')) throw new Error('文件超出了目标目录。');
          if (Number(file.isdir) === 1) queue.push(file.path);
          else if (isVideo(file.server_filename)) found.set(String(file.fs_id),file);
        }
        if (!result.hasMore) break;
        if (!Number.isFinite(result.nextStart) || result.nextStart <= start || page === 999) throw new Error('目标目录分页异常。');
        start = result.nextStart;
      }
    }
    const existing = new Set(this.store.data.items.map(item => item.id));
    const added = [...found.values()].map(baiduItem).filter(item => !existing.has(item.id));
    this.store.upsert(added);
    for(const identity of identities) {
      const item=this.store.data.items.find(value=>value.id==='baidu:'+identity.fsId);
      if(!item||!found.has(String(identity.fsId))||item.identificationLocked||item.metadataLocked||item.progress)continue;
      const {title,kind,year,season,episode}=identity;
      if(!title||!['movie','episode'].includes(kind)||kind==='episode'&&(!Number.isInteger(season)||!Number.isInteger(episode)))continue;
      // A background scan may see the new copy before renaming finishes. The
      // save identity supersedes that filename guess, while manual matches and
      // watched entries remain protected above.
      delete item.catalog;delete item.episodeMetadata;
      Object.assign(item,{title,inferredTitle:title,kind,year,season,episode,seriesTitle:kind==='episode'?title:undefined,identificationLocked:true,identification:{version:1,confidence:1,reason:'保存时的作品信息'}});
      if(selection?.source==='tmdb'&&/^\d+$/.test(String(selection.id))&&selection.kind===kind)item.catalog={source:'tmdb',id:String(selection.id),kind,title,year,pending:true};
    }
    identifyLibrary(this.store.data.items);this.store.persist();this.notify();
    return added.length;
  }
  refresh(ids, {background = false} = {}) {
    const roots = this.roots().filter(r => r.enabled !== false && (!ids || ids.includes(r.id)));
    if (!roots.length) throw new Error('请先添加影视目录。');
    if (this.state.running) {
      if(this.state.cancelled) throw new Error('正在停止扫描，请稍后重试。');
      // Reuse the current traversal when a user asks to see its progress. Roots
      // becoming available after login can join the same serial scan safely.
      for(const root of roots) if(!this.activeRoots.some(old => old.id === root.id)) this.activeRoots.push(root);
      if(!background) this.state.background = false;
      this.notify(); return this.state;
    }
    const current = this.state = {running:true,background,count:0,added:0,changed:0,directory:'',error:null,cancelled:false};
    this.activeRoots = roots;
    this.notify(); this.active = this.run(roots, current); return current;
  }
  async run(roots, current) {
    for (const root of roots) {
      if (current.cancelled) break;
      try {await this.scanRoot(root,current);}
      catch {root.error = root.source === 'baidu' ? '暂时无法读取网盘目录，已保留原片库。请检查登录或网络后刷新。' : '目录暂时不可用，已保留原片库。'; current.error = root.error;}
      this.store.persist(); this.notify();
    }
    current.running=false;
    if(!current.background || current.error) this.store.log(current.cancelled ? '扫描已停止，已完成的目录保持更新。' : `片库已更新 · 新增 ${current.added}，更新 ${current.changed}${current.error ? '，部分目录稍后重试' : ''}。`, current.error ? 'warning' : 'info');
    this.notify(); if(!current.cancelled) this.onComplete(current);
  }
  async scanRoot(root,current) {
    const previousPath = root.path; let rootPath = root.path;
    if(root.source === 'baidu' && root.fsId) {
      const info = await this.baidu.fileInfo(root.fsId);
      if(Number(info.isdir) !== 1) throw new Error('挂载目录不可用');
      if(current.cancelled) return;
      rootPath = info.path;
    }
    const queue = [rootPath], seen = new Set(), found = new Map();
    while(queue.length && !current.cancelled) {
      const directory = queue.shift(); if(seen.has(directory)) continue; seen.add(directory);
      if(seen.size > 10000) throw new Error('目录过多');
      current.directory=directory; let start=0;
      if(root.source === 'local') {
        const files = await fs.readdir(directory,{withFileTypes:true});
        for(const file of files) {
          const location=path.join(directory,file.name);
          if(file.isDirectory() && !file.name.startsWith('.')) queue.push(location);
          else if(file.isFile() && isVideo(file.name)) {const stat=await fs.stat(location),item=localItem(location,stat.size);item.fileModifiedAt=stat.mtimeMs;found.set(item.id,item);current.count++;}
        }
      } else {
        for(let page=0;page<1000;page++) {
          const result=await this.baidu.list(directory,start);
          if(current.cancelled) return;
          for(const file of result.files) {if(file.isdir) queue.push(file.path);else if(isVideo(file.server_filename)) {const item=baiduItem(file);item.fileModifiedAt=file.server_mtime || file.local_mtime || 0;found.set(item.id,item);current.count++;}}
          if(!result.hasMore) break;
          if(!Number.isFinite(result.nextStart) || result.nextStart <= start || page===999) throw new Error('目录分页异常');
          start=result.nextStart;
        }
      }
      this.notify();
    }
    // Only a completely enumerated root can declare files unavailable. A
    // cancellation or a network failure never removes existing library data.
    if(current.cancelled) return;
    const byId=new Map(this.store.data.items.map(item=>[item.id,item])),at=new Date().toISOString();
    for(const [id,item] of found) {
      const old=byId.get(id);
      if(!old) {byId.set(id,item);current.added++;}
      else if(old.path!==item.path || old.size!==item.size || old.fileModifiedAt!==item.fileModifiedAt || old.unavailable) {
        Object.assign(old,{path:item.path,filename:item.filename,size:item.size,fileModifiedAt:item.fileModifiedAt});delete old.unavailable;current.changed++;
      }
    }
    for(const item of byId.values()) if(item.source===root.source && (within(item.path,rootPath,root.source) || within(item.path,previousPath,root.source))) {if(!found.has(item.id)) item.unavailable=true;else delete item.unavailable;}
    this.store.data.items=[...byId.values()];identifyLibrary(this.store.data.items);
    root.path=rootPath;root.lastScannedAt=at;root.count=found.size;root.error=null;
  }
}
