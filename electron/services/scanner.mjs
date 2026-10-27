import fs from 'node:fs/promises';
import path from 'node:path';
import {isVideo, localItem, baiduItem} from '../core/media.mjs';
import {identifyLibrary} from '../core/identification.mjs';
const within = (file, root, source) => source === 'local' ? path.relative(root, file) === '' || !path.relative(root, file).startsWith('..') && !path.isAbsolute(path.relative(root,file)) : file.startsWith(root.replace(/\/$/, '') + '/');
export class LibraryScanner {
  constructor(store, baidu, notify = () => {}, onComplete = () => {}) {Object.assign(this, {store, baidu, notify, onComplete}); this.state = {running:false,count:0,added:0,changed:0,directory:'',error:null};}
  roots() {return this.store.data.scanRoots ??= [];}
  add(source, directory) {
    if (!['local','baidu'].includes(source) || typeof directory !== 'string' || !directory.trim()) throw new Error('请选择有效的影视目录。');
    const location = source === 'local' ? path.resolve(directory) : path.posix.normalize('/' + directory.replace(/^\/+/, ''));
    let root = this.roots().find(r => r.source === source && r.path === location);
    if (!root) {root = {id:crypto.randomUUID(),source,path:location,enabled:true}; this.roots().push(root); this.store.persist();}
    return root;
  }
  cancel() {if(this.state.running) this.state.cancelled = true; this.notify();}
  refresh(ids) {
    if (this.state.running) throw new Error('扫描正在进行。');
    const roots = this.roots().filter(r => r.enabled !== false && (!ids || ids.includes(r.id)));
    if (!roots.length) throw new Error('请先添加影视目录。');
    const current = this.state = {running:true,count:0,added:0,changed:0,directory:'',error:null,cancelled:false};
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
    this.store.log(current.cancelled ? '扫描已停止，已完成的目录保持更新。' : `片库已更新 · 新增 ${current.added}，更新 ${current.changed}${current.error ? '，部分目录稍后重试' : ''}。`);
    this.notify(); this.onComplete();
  }
  async scanRoot(root,current) {
    const queue = [root.path], seen = new Set(), found = new Map();
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
    for(const item of byId.values()) if(item.source===root.source && within(item.path,root.path,root.source)) {if(!found.has(item.id)) item.unavailable=true;else delete item.unavailable;}
    this.store.data.items=[...byId.values()];identifyLibrary(this.store.data.items);
    root.lastScannedAt=at;root.count=found.size;root.error=null;
  }
}
