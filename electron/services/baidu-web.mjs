import { ApiError, jsonRequest, withQuery } from '../core/http.mjs';

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
  async streamUrl(fsId, { refresh = false, path } = {}) {
    if (!/^\d+$/.test(String(fsId))) throw new Error('无效的网盘文件 ID。');
    // A rejected link needs a fresh session check and signer even when the
    // ordinary five-minute variable cache is still warm.
    if (refresh && !await this.check()) throw new Error('请先在百度官方网页中登录账号。');
    const variables = await this.sessionVariables();
    const filePath = path ?? this.store.data.items?.find(item => item.source === 'baidu' && String(item.fsId) === String(fsId))?.path;
    if (filePath !== undefined && (typeof filePath !== 'string' || !filePath.startsWith('/') || filePath.includes('\0'))) throw new Error('无效的网盘文件路径。');
    if (filePath) {
      // The website download endpoint can return already-expired tickets for
      // otherwise readable files. File metadata supplies a fresh original-file
      // link, with no transcode or HDR loss. Its CDN requires Baidu's download
      // user agent; a browser UA yields 31326 / hitcode 119.
      const data = await this.request('/api/filemetas', {target: JSON.stringify([filePath]), dlink: 1, bdstoken: variables.bdstoken});
      const info = data.info?.[0];
      if (info && ((info.fs_id !== undefined && String(info.fs_id) !== String(fsId)) || (info.path !== undefined && info.path !== filePath) || Number(info.isdir) === 1)) throw new Error('百度返回的文件信息与所选影片不一致，请重新扫描该目录。');
      if (info?.dlink) return this.rememberMediaLink(info.dlink, 'pan.baidu.com');
    }
    const values = await this.template(['sign1', 'sign3', 'timestamp']);
    if (!Number.isFinite(Number(values.timestamp)) || Number(values.timestamp) <= 0) throw new Error('百度网页下载参数不可用，请在官方网页确认该文件能正常下载。');
    const data = await this.request('/api/download', { type: 'dlink', fidlist: `[${fsId}]`, sign: webDownloadSign(values.sign3, values.sign1), timestamp: values.timestamp, bdstoken: variables.bdstoken });
    return this.rememberMediaLink(data.dlink?.[0]?.dlink, null);
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
