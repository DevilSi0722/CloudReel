import { ApiError, jsonRequest, withQuery, tokenRecord } from '../core/http.mjs';
import {baiduFileInfo, rememberBaiduFile} from '../core/baidu-file.mjs';

export class BaiduService {
  constructor(store, { fetcher = fetch, oauthBase = 'https://openapi.baidu.com', apiBase = 'https://pan.baidu.com' } = {}) {
    this.store = store; this.fetcher = fetcher; this.oauthBase = oauthBase; this.apiBase = apiBase; this.refreshing = null;
  }
  credentials() {
    const clientId = this.store.data.settings.baiduClientId, secret = this.store.secret('baiduAppSecret');
    if (!clientId || !secret) throw new Error('请先在设置中填写百度应用 AppKey 与 SecretKey。');
    return { client_id: clientId, client_secret: secret };
  }
  oauth(values) { return jsonRequest(withQuery(this.oauthBase + '/oauth/2.0/token', values), {}, this.fetcher); }
  async beginAuth() {
    const { client_id } = this.credentials();
    return jsonRequest(withQuery(this.oauthBase + '/oauth/2.0/device/code', { response_type: 'device_code', client_id, scope: 'basic,netdisk' }), {}, this.fetcher);
  }
  async pollAuth(deviceCode, isCurrent = () => true) {
    try {
      const data = await this.oauth({ ...this.credentials(), grant_type: 'device_token', code: deviceCode });
      if (!isCurrent()) return { status: 'cancelled' };
      this.store.setSecret('baiduToken', tokenRecord(data));
      try { this.store.data.baiduProfile = await this.request('/rest/2.0/xpan/nas', { method: 'uinfo' }); } catch { this.store.data.baiduProfile = null; }
      this.store.persist(); return { status: 'connected' };
    } catch (error) {
      if (['authorization_pending', 'slow_down'].includes(error.code)) return { status: error.code };
      throw error;
    }
  }
  async refresh() {
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      const token = this.store.secret('baiduToken');
      if (!token) throw new Error('请先登录百度网盘。');
      const data = await this.oauth({ ...this.credentials(), grant_type: 'refresh_token', refresh_token: token.refresh_token });
      this.store.setSecret('baiduToken', tokenRecord(data));
    })().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }
  async token() {
    let token = this.store.secret('baiduToken');
    if (!token) throw new Error('请先登录百度网盘。');
    if (token.expiresAt < Date.now() + 60000) { await this.refresh(); token = this.store.secret('baiduToken'); }
    return token.access_token;
  }
  async request(route, params = {}, retry = true) {
    const access_token = await this.token();
    try { return await jsonRequest(withQuery(this.apiBase + route, { ...params, access_token }), {}, this.fetcher); }
    catch (error) {
      if (retry && ([-6, 110, 111].includes(Number(error.code)) || error.status === 401)) { await this.refresh(); return this.request(route, params, false); }
      throw error;
    }
  }
  async list(directory = '/', start = 0) {
    if (typeof directory !== 'string' || !directory.startsWith('/') || directory.includes('\0')) throw new Error('网盘路径必须以 / 开头。');
    const data = await this.request('/rest/2.0/xpan/file', { method: 'list', dir: directory, order: 'name', start, limit: 200 });
    const files = data.list ?? [];
    return { files, hasMore: files.length === 200, nextStart: start + files.length };
  }
  async fileInfo(fsId, {dlink = false} = {}) {
    if (!/^\d+$/.test(String(fsId))) throw new Error('无效的网盘文件 ID。');
    // Serialize fsids as numeric JSON without losing precision through Number().
    const data = await this.request('/rest/2.0/xpan/multimedia', { method: 'filemetas', fsids: `[${fsId}]`, dlink: dlink ? 1 : 0 });
    return baiduFileInfo(data.list, fsId);
  }
  async streamUrl(fsId) {
    const info = await this.fileInfo(fsId, {dlink: true});
    if (Number(info.isdir) === 1) throw new Error('所选网盘文件是文件夹，无法播放。');
    const link = info.dlink;
    if (!link) throw new ApiError('百度未返回原文件地址，请检查应用下载权限。');
    const url = new URL(link);
    if (url.protocol !== 'https:' || !/(^|\.)(baidu\.com|baidupcs\.com)$/.test(url.hostname)) throw new Error('百度返回了无法识别的下载域名。');
    url.searchParams.set('access_token', await this.token()); rememberBaiduFile(this.store, info); return url.toString();
  }
}
