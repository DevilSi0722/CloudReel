import { ApiError, jsonRequest, withQuery } from '../core/http.mjs';
import {baiduFileInfo, rememberBaiduFile} from '../core/baidu-file.mjs';
import {isVideo} from '../core/media.mjs';

export const BAIDU_WEB_HOME = 'https://pan.baidu.com/disk/main';
export function isBaiduPage(value) {
  try { const url = new URL(value); return url.protocol === 'https:' && /(^|\.)baidu\.com$/.test(url.hostname); }
  catch { return false; }
}
export function isBaiduMediaUrl(value) {
  try { const url = new URL(value); return url.protocol === 'https:' && /(^|\.)(baidu\.com|baidupcs\.com|baidubce\.com)$/.test(url.hostname); }
  catch { return false; }
}

// The desktop website signs its own download requests with a session-specific
// RC4 transform. Implement the transform locally; never evaluate returned sign2.
export function webDownloadSign(key, value) {
  if (typeof key !== 'string' || !key.length || typeof value !== 'string' || !value.length) throw new Error('百度网页没有返回下载签名，请重新登录后重试。');
  const state = Array.from({ length: 256 }, (_, index) => index);
  let j = 0;
  for (let i = 0; i < 256; i++) { j = (j + state[i] + key.charCodeAt(i % key.length)) % 256; [state[i], state[j]] = [state[j], state[i]]; }
  const bytes = []; let i = 0; j = 0;
  for (let offset = 0; offset < value.length; offset++) {
    i = (i + 1) % 256; j = (j + state[i]) % 256; [state[i], state[j]] = [state[j], state[i]];
    bytes.push(value.charCodeAt(offset) ^ state[(state[i] + state[j]) % 256]);
  }
  return Buffer.from(bytes).toString('base64');
}

export class BaiduWebService {
  constructor(store, { fetcher, mediaFetcher = fetcher, notify = () => {} }) {
    this.store = store; this.fetcher = fetcher; this.mediaFetcher = mediaFetcher; this.notify = notify;
    this.connected = false; this.checking = false; this.variables = null; this.variablesAt = 0; this.generation = 0;
    this.mediaIdentities = new Map();
  }
  status() { return { connected: this.connected, configured: true, mode: 'web', checking: this.checking, profile: this.connected ? this.store.data.baiduWebProfile ?? null : null }; }
  async request(route, params = {}, options = {}) {
    const generation = this.generation;
    // These are the website's own public routing parameters, not an OAuth app key.
    const url = withQuery('https://pan.baidu.com' + route, { clienttype: 0, web: 1, app_id: 250528, ...params });
    try {
      return await jsonRequest(url, { ...options, cache: 'no-store', credentials: 'include', headers: { Referer: BAIDU_WEB_HOME, ...options.headers } }, this.fetcher);
    } catch (error) {
      if ([-6, 110, 111].includes(Number(error.code)) || [401, 403].includes(error.status)) {
        if (generation === this.generation) { this.connected = false; this.variables = null; this.notify(); }
        throw new ApiError('百度网页会话已失效或需要验证，请重新打开百度登录窗口。', error.status, error.code);
      }
      throw error;
    }
  }
  async template(fields) {
    const data = await this.request('/api/gettemplatevariable', {}, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ fields: JSON.stringify(fields) }).toString() });
    return data.result ?? {};
  }
  async check() {
    if (this.probing) return this.probing;
    const generation = this.generation;
    this.checking = true; this.notify();
    this.probing = (async () => {
      const variables = await this.template(['bdstoken', 'uk', 'username', 'netdisk_name', 'loginstate', 'is_vip', 'is_svip']);
      if (generation !== this.generation) return false;
      if (!variables.bdstoken || (variables.loginstate !== undefined && ![1, true, '1'].includes(variables.loginstate))) {
        this.connected = false; this.variables = null; return false;
      }
      // Confirm file access rather than treating the presence of a cookie as login.
      const listing = await this.request('/api/list', { dir: '/', num: 1, page: 1, order: 'name', desc: 0, bdstoken: variables.bdstoken });
      if (!Array.isArray(listing.list)) throw new Error('百度没有返回有效的文件列表，请在网页登录窗口确认账号状态。');
      if (generation !== this.generation) return false;
      this.variables = variables; this.variablesAt = Date.now(); this.connected = true;
      this.store.data.baiduWebProfile = { netdisk_name: variables.netdisk_name || variables.username || '百度网盘', uk: String(variables.uk ?? ''), vip: Number(variables.is_svip) === 1 ? 'SVIP' : Number(variables.is_vip) === 1 ? 'VIP' : '' };
      this.store.persist(); return true;
    })().finally(() => { this.probing = null; this.checking = false; this.notify(); });
    return this.probing;
  }
  reset() { this.generation++; this.connected = false; this.variables = null; this.mediaIdentities.clear(); delete this.store.data.baiduWebProfile; this.store.persist(); this.notify(); }
  async sessionVariables() {
    if (!this.variables || Date.now() - this.variablesAt > 5 * 60000) {
      if (!await this.check()) throw new Error('请先在百度官方网页中登录账号。');
    }
    return this.variables;
  }
  async list(directory = '/', start = 0) {
    if (typeof directory !== 'string' || !directory.startsWith('/') || directory.includes('\0')) throw new Error('请选择有效的网盘目录。');
    if (!Number.isSafeInteger(start) || start < 0 || start % 200 !== 0) throw new Error('无效的网盘分页位置。');
    const variables = await this.sessionVariables();
    const data = await this.request('/api/list', { dir: directory, num: 200, page: start / 200 + 1, order: 'name', desc: 0, showempty: 0, bdstoken: variables.bdstoken });
    if (!Array.isArray(data.list)) throw new Error('百度网页未返回有效目录，请刷新或重新登录。');
    const files = data.list;
    return { files, hasMore: files.length === 200, nextStart: start + files.length };
  }
  async fileInfo(fsId, {dlink = false} = {}) {
    if (!/^\d+$/.test(String(fsId))) throw new Error('无效的网盘文件 ID。');
    const variables = await this.sessionVariables();
    let data;
    try {data = await this.request('/api/filemetas', {fsids: `[${fsId}]`, dlink: dlink ? 1 : 0, bdstoken: variables.bdstoken});}
    catch (error) {
      if ([12, -9, 31066].includes(Number(error.code))) throw new ApiError('百度网盘中的文件已删除或无法访问，请确认文件仍在当前账号中。', error.status, error.code);
      throw error;
    }
    return baiduFileInfo(data.info, fsId);
  }
  async streamUrl(fsId, { refresh = false } = {}) {
    // A rejected link needs a fresh session check and signer even when the
    // ordinary five-minute variable cache is still warm.
    if (refresh && !await this.check()) throw new Error('请先在百度官方网页中登录账号。');
    // fsids survives both rename and move. Never use a stale path, which can
    // point at another file after the original name is reused.
    const info = await this.fileInfo(fsId, {dlink: true});
    if (Number(info.isdir) === 1) throw new Error('所选网盘文件是文件夹，无法播放。');
    // Metadata links can be present yet rejected by the media server (31362).
    // A relay retry must resolve a different original-file ticket, rather
    // than asking for the same unusable metadata ticket again.
    if (info.dlink && !refresh) {
      const link = this.rememberMediaLink(info.dlink, 'pan.baidu.com');
      rememberBaiduFile(this.store, info, this.notify); return link;
    }
    const variables = await this.sessionVariables();
    if (refresh && isVideo(info.path)) {
      // VideoURL with nom3u8/dlink returns the original file, not an HLS
      // transcode. Resolve the current path by ID first, then confirm it has
      // not changed while the path-based video endpoint was being queried.
      let data;
      try {data = await this.request('/api/mediainfo', {type:'VideoURL', path:info.path, fs_id:String(fsId), devuid:'0%1', clienttype:1, channel:'android_15_25010PN30C_bd-netdisk_1523a', nom3u8:1, dlink:1, media:1, origin:'dlna', bdstoken:variables.bdstoken});}
      catch (error) {if (!this.connected) throw error;}
      if (data?.info?.dlink) {
        const video = data.info, current = await this.fileInfo(fsId);
        if (Number(video.size) !== Number(info.size) || (video.md5 && info.md5 && video.md5 !== info.md5) || (video.fs_id !== undefined && String(video.fs_id) !== String(fsId)) || current.path !== info.path || Number(current.size) !== Number(info.size) || Number(current.isdir) === 1 || (current.md5 && info.md5 && current.md5 !== info.md5)) throw new Error('百度返回的视频信息与所选文件 ID 不一致，请重新播放。');
        const link = this.rememberMediaLink(video.dlink, 'pan.baidu.com');
        rememberBaiduFile(this.store, current, this.notify); return link;
      }
    }
    const values = await this.template(['sign1', 'sign3', 'timestamp']);
    if (!Number.isFinite(Number(values.timestamp)) || Number(values.timestamp) <= 0) throw new Error('百度网页下载参数不可用，请在官方网页确认该文件能正常下载。');
    const data = await this.request('/api/download', { type: 'dlink', fidlist: `[${fsId}]`, sign: webDownloadSign(values.sign3, values.sign1), timestamp: values.timestamp, bdstoken: variables.bdstoken });
    const link = this.rememberMediaLink(data.dlink?.[0]?.dlink, null);
    rememberBaiduFile(this.store, info, this.notify); return link;
  }
  async renameFile(file,newname) {
    if(typeof newname!=='string'||!newname.trim()||/[<>:"/\\|?*\u0000-\u001f]/.test(newname)||/[. ]$/.test(newname)||newname.length>240||Buffer.byteLength(newname)>255)throw new Error('无效的标准文件名。');
    const current=await this.fileInfo(file.fs_id);
    if(Number(current.isdir)===1||current.path!==file.path||Number(current.size)!==Number(file.size))throw new Error('文件已发生变化，已保留当前名称。');
    const variables=await this.sessionVariables();
    const result=await this.request('/api/filemanager',{opera:'rename',async:0,ondup:'fail',bdstoken:variables.bdstoken},{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({filelist:JSON.stringify([{path:current.path,newname}])}).toString()});
    if(result.info?.some(value=>Number(value.errno||0)!==0))throw new Error('部分文件未能重命名，已保留网盘中的文件。');
    const updated=await this.fileInfo(file.fs_id);
    if(updated.path!==current.path.slice(0,current.path.lastIndexOf('/')+1)+newname)throw new Error('重命名结果尚未确认，请在网盘中检查。');
    return updated;
  }
  rememberMediaLink(link, userAgent) {
    let url; try { url = new URL(link); } catch { throw new Error('百度网页未返回原文件地址，可能需要在网页中完成安全验证。'); }
    if (!isBaiduMediaUrl(url)) throw new Error('百度返回了无法识别的媒体地址。');
    const value = url.toString();
    this.mediaIdentities.set(value, userAgent);
    if (this.mediaIdentities.size > 32) this.mediaIdentities.delete(this.mediaIdentities.keys().next().value);
    return value;
  }
  fetchMedia(url, options) {
    const headers = new Headers(options.headers);
    // Metadata links require this identity; the legacy web-download fallback
    // retains the browser identity. Cookies remain in the isolated Session.
    headers.delete('User-Agent');
    const userAgent = this.mediaIdentities.get(String(url));
    if (userAgent) headers.set('User-Agent', userAgent);
    headers.set('Referer', BAIDU_WEB_HOME);
    return this.mediaFetcher(url, { ...options, credentials: 'include', headers });
  }
}
