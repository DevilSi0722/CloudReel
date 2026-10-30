import path from 'node:path';
import {buildFilePlan, inside, manageable} from '../core/file-management.mjs';
import {rememberBaiduFile} from '../core/baidu-file.mjs';
import {isVideo} from '../core/media.mjs';

export class FileManagementService {
  constructor(store, baidu, {notify = () => {}, account = () => '', verifyAccount = async () => {}, blocked = () => false, begin = async () => {}, end = () => {}, now = Date.now} = {}) {
    Object.assign(this, {store, baidu, notify, account, verifyAccount, blocked, begin, end, now});
    this.plans = new Map(); this.busy = false; this.progress = {running: false, done: 0, total: 0}; this.lastReport = null;
  }
  status() {return {...this.progress};}
  cancel() {if (this.busy) {this.progress.cancelling = true; this.notify();} return this.status();}
  invalidate() {this.plans.clear(); this.lastReport = null;}
  async location({rootId, directoryId}) {
    const root = this.store.data.scanRoots?.find(value => value.id === rootId && value.source === 'baidu' && value.enabled !== false);
    if (!root) throw new Error('此挂载已移除，请重新选择文件夹。');
    const mount = root.fsId ? await this.baidu.fileInfo(root.fsId) : {path: root.path, isdir: 1};
    if (Number(mount.isdir) !== 1) throw new Error('挂载文件夹已不可用。');
    const directory = directoryId ? await this.baidu.fileInfo(directoryId) : mount;
    if (Number(directory.isdir) !== 1 || directory.path !== mount.path && !inside(directory.path, mount.path)) throw new Error('只能管理当前挂载内的文件。');
    return {root, mount, directory};
  }
  async browse(input) {
    if (this.busy) throw new Error('正在处理文件，请稍后刷新。');
    const start = input?.start ?? 0;
    if (!Number.isSafeInteger(start) || start < 0 || start % 200 !== 0) throw new Error('无效的目录分页位置。');
    const {root, mount, directory} = await this.location(input);
    const result = await this.baidu.list(directory.path, start);
    if (this.busy) throw new Error('正在处理文件，请稍后刷新。');
    const files = result.files.filter(file => path.posix.dirname(file.path) === directory.path && (Number(file.isdir) === 1 || manageable(file))).map(file => ({fs_id: String(file.fs_id), path: file.path, server_filename: file.server_filename, size: Number(file.size), isdir: Number(file.isdir)}));
    let changed = false;
    if (root.path !== mount.path) {root.path = mount.path; changed = true;}
    for (const file of files.filter(manageable)) rememberBaiduFile({data: this.store.data, persist: () => {changed = true;}}, file);
    if (changed) {this.store.persist(); this.notify();}
    return {...result, files, directory: {path: directory.path, fsId: directory.fs_id ? String(directory.fs_id) : undefined}, mountPath: mount.path};
  }
  async listing(directory) {
    const files = [];
    for (let start = 0, page = 0; page < 250; page++) {
      const result = await this.baidu.list(directory, start);
      if (result.files.some(file => path.posix.dirname(file.path) !== directory)) throw new Error('网盘返回了目录之外的文件。');
      files.push(...result.files);
      if (!result.hasMore) return files;
      if (!Number.isSafeInteger(result.nextStart) || result.nextStart <= start) throw new Error('目录分页异常，请稍后重试。');
      start = result.nextStart;
    }
    throw new Error('当前文件夹过大，请使用更小的影视文件夹。');
  }
  async preview(input) {
    if (this.busy) throw new Error('正在处理文件，请稍后重试。');
    if (!Array.isArray(input?.ids) || !input.ids.length || input.ids.length > 500 || input.ids.some(id => !/^\d+$/.test(String(id)))) throw new Error('请选择 1 至 500 个视频或字幕。');
    await this.verifyAccount();
    const account = this.account(), {directory, mount} = await this.location(input);
    const all = await this.listing(directory.path);
    const entries = buildFilePlan(all, input.ids, this.store.data.items, input);
    if (entries.length > 1000) throw new Error('关联字幕过多，请减少本次选择。');
    if (account !== this.account()) throw new Error('账号已变化，请重新预览。');
    const id = crypto.randomUUID(), plan = {id, rootId: input.rootId, directoryId: input.directoryId, directory: directory.path, mountPath: mount.path, account, action: input.action, entries, at: this.now()};
    for (const [key, value] of this.plans) if (this.now() - value.at > 10 * 60000) this.plans.delete(key);
    if (this.plans.size >= 8) this.plans.delete(this.plans.keys().next().value);
    this.plans.set(id, plan);
    return {id, action: plan.action, files: entries.map(({fsId, original, name, reason, companion, status}) => ({fsId, original, name, reason, companion, status})), ready: entries.filter(entry => entry.status === 'ready').length};
  }
  async commit({id} = {}) {
    if (this.busy) throw new Error('已有文件任务正在执行。');
    const plan = this.plans.get(id);
    if (!plan || this.now() - plan.at > 10 * 60000 || plan.account !== this.account()) throw new Error('预览已失效，请重新预览后确认。');
    if (this.blocked()) throw new Error('请先停止播放，并等待扫描或转存完成后再处理文件。');
    this.busy = true; this.progress = {running: true, action: plan.action, done: 0, total: plan.entries.filter(entry => entry.status === 'ready').length}; this.notify();
    const results = [];
    try {
      await this.begin();
      await this.verifyAccount();
      const {directory, mount} = await this.location(plan);
      if (directory.path !== plan.directory || mount.path !== plan.mountPath || plan.account !== this.account()) throw new Error('文件夹或账号已变化，请重新预览。');
      this.plans.delete(id); // A network failure must never replay a destructive request.
      for (const entry of plan.entries) {
        if (entry.status !== 'ready') {results.push({fsId: entry.fsId, original: entry.original, status: 'skipped', message: entry.reason || '名称无需更改'}); continue;}
        const finishingCompanion = entry.parentId && results.some(value => value.fsId === entry.parentId && value.status === 'success');
        if (this.progress.cancelling && !finishingCompanion) {results.push({fsId: entry.fsId, original: entry.original, status: 'skipped', message: '已停止后续操作，保留原文件'}); continue;}
        const companionParent = entry.parentId && plan.entries.find(value => value.fsId === entry.parentId);
        if (companionParent && results.find(value => value.fsId === companionParent.fsId)?.status === 'failed') {results.push({fsId: entry.fsId, original: entry.original, status: 'skipped', message: '对应视频未处理，已保留字幕'}); this.progress.done++; this.notify(); continue;}
        try {
          if (plan.account !== this.account()) throw new Error('账号已变化，已停止处理。');
          const current = await this.baidu.fileInfo(entry.fsId), expected = entry.file;
          if (!manageable(current) || current.path !== expected.path || Number(current.size) !== Number(expected.size) || expected.md5 && current.md5 && current.md5 !== expected.md5) throw new Error('文件已变化，请刷新后重试');
          // Re-resolve the mount for every write, in case it moved outside our
          // preview while this task was running. Never write using renderer paths.
          const location = await this.location(plan);
          if (location.mount.path !== plan.mountPath || location.directory.path !== plan.directory) throw new Error('文件夹已变化，已停止处理');
          const updated = await this.baidu.manageFile(plan.action, current, entry.name);
          if (plan.action === 'rename') rememberBaiduFile(this.store, updated, this.notify);
          else {
            for (const item of this.store.data.items) if (item.source === 'baidu' && String(item.fsId) === entry.fsId) item.unavailable = true;
            if (isVideo(entry.original)) for (const root of this.store.data.scanRoots ?? []) if (root.source === 'baidu' && inside(entry.file.path, root.path) && Number.isInteger(root.count)) root.count = Math.max(0, root.count - 1);
            this.store.persist();
          }
          results.push({fsId: entry.fsId, original: entry.original, status: 'success', message: plan.action === 'rename' ? entry.name : '已从网盘删除'});
        } catch (error) {
          // A lost acknowledgement may follow a successful rename. Reconcile
          // by stable ID, without ever repeating the write.
          let reconciled;
          if (plan.action === 'rename') try {
            const current = await this.baidu.fileInfo(entry.fsId);
            if (manageable(current) && current.path === path.posix.join(plan.directory, entry.name) && Number(current.size) === Number(entry.file.size) && !(entry.file.md5 && current.md5 && entry.file.md5 !== current.md5)) reconciled = current;
          } catch {}
          if (reconciled) {
            rememberBaiduFile(this.store, reconciled, this.notify);
            results.push({fsId: entry.fsId, original: entry.original, status: 'success', message: entry.name});
          } else {
            const hint = {'-8': '目标名称已存在，已跳过', '-9': '文件已不存在，请刷新目录', '31066': '文件已不存在，请刷新目录', '-6': '登录已失效，请重新登录后核对', '31034': '百度账号或应用没有文件管理权限'}[String(error.code)];
            const message = /^(?:文件已变化|文件夹已变化|账号已变化)/.test(error.message) ? error.message : hint || '未确认成功，请刷新文件夹核对后重试';
            results.push({fsId: entry.fsId, original: entry.original, status: 'failed', message});
          }
        }
        this.progress.done++; this.notify();
      }
      const success = results.filter(value => value.status === 'success').length, failed = results.filter(value => value.status === 'failed').length;
      this.store.log(`${plan.action === 'rename' ? '网盘重命名' : '网盘删除'} · 成功 ${success}${failed ? `，${failed} 个需核对` : ''}。`, failed ? 'warning' : 'info');
      this.lastReport = {rootId: plan.rootId, directory: plan.directory, action: plan.action, results, success, failed};
      return this.lastReport;
    } finally {this.busy = false; this.progress.running = false; this.end(); this.notify();}
  }
}
