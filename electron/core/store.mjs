import fs from 'node:fs';
import path from 'node:path';
import {playbackDefaults, validatePlayback} from './playback-preferences.mjs';

export const defaultSettings = { baiduMode: 'web', baiduClientId: '', traktClientId: '', traktRedirectUri: '', mpvPath: '', rootDir: '/', autoSync: true, autoScrape: true, autoNext: true, autoRefresh: true };
export class Store {
  constructor(directory, crypto) {
    this.file = path.join(directory, 'state.json'); this.crypto = crypto;
    fs.mkdirSync(directory, { recursive: true });
    this.data = { version: 1, settings: { ...defaultSettings }, secrets: {}, items: [], pending: [], watchPending: [], logs: [], libraryPreferences: {}, scanRoots: [], playbackDefaults: {...playbackDefaults}, playbackPreferences: {} };
    if (fs.existsSync(this.file)) {
      // Preserve a damaged file for recovery rather than silently overwriting it.
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (saved.version !== 1) throw new Error('不支持的数据版本，请保留 state.json 后升级应用。');
      this.data = { ...this.data, ...saved, settings: { ...defaultSettings, ...saved.settings } };
      if (!saved.settings?.baiduMode && saved.secrets?.baiduToken) this.data.settings.baiduMode = 'oauth';
      this.data.playbackDefaults = {...playbackDefaults, ...validatePlayback(saved.playbackDefaults)};
    }
  }
  persist() {
    fs.writeFileSync(this.file + '.tmp', JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.renameSync(this.file + '.tmp', this.file);
  }
  secret(name) {
    const value = this.data.secrets[name];
    if (!value) return null;
    try { return JSON.parse(this.crypto.decryptString(Buffer.from(value, 'base64'))); }
    catch { throw new Error('无法解密本机授权信息，请在当前 Windows 用户下重新连接账号。'); }
  }
  setSecret(name, value) {
    if (value === null) delete this.data.secrets[name];
    else {
      if (!this.crypto.isEncryptionAvailable()) throw new Error('系统凭据加密不可用，暂时无法保存授权。');
      this.data.secrets[name] = this.crypto.encryptString(JSON.stringify(value)).toString('base64');
    }
    this.persist();
  }
  saveSettings(input) {
    if (input.baiduMode !== undefined && !['web', 'oauth'].includes(input.baiduMode)) throw new Error('不支持的百度登录方式。');
    if (input.tmdbToken !== undefined && typeof input.tmdbToken !== 'string') throw new Error('无效的 TMDB Token。');
    if (input.tmdbToken?.length > 4096) throw new Error('TMDB Token 过长，请检查输入。');
    const previous = { ...this.data.settings };
    for (const key of Object.keys(defaultSettings)) {
      if (input[key] !== undefined) this.data.settings[key] = ['autoSync', 'autoScrape', 'autoNext', 'autoRefresh'].includes(key) ? Boolean(input[key]) : String(input[key]).trim();
    }
    if (input.baiduSecret?.trim()) this.setSecret('baiduAppSecret', input.baiduSecret.trim());
    if (input.tmdbToken?.trim()) this.setSecret('tmdbToken', input.tmdbToken.trim().replace(/^Bearer\s+/i, ''));
    if (input.clearTmdbToken === true) delete this.data.secrets.tmdbToken;
    if (previous.baiduClientId !== this.data.settings.baiduClientId) { delete this.data.secrets.baiduToken; delete this.data.baiduProfile; }
    if (previous.traktClientId !== this.data.settings.traktClientId) { delete this.data.secrets.traktToken; delete this.data.traktProfile; this.data.pending = []; }
    this.persist();
  }
  upsert(items) {
    const byId = new Map(this.data.items.map(item => [item.id, item]));
    for (const item of items) byId.set(item.id, { ...byId.get(item.id), ...item });
    this.data.items = [...byId.values()]; this.persist();
  }
  item(id) { const item = this.data.items.find(item => item.id === id); if (!item) throw new Error('媒体条目不存在。'); return item; }
  log(message, level = 'info') {
    this.data.logs.unshift({ id: crypto.randomUUID(), at: new Date().toISOString(), level, message });
    this.data.logs = this.data.logs.slice(0, 60); this.persist();
  }
  queue(job) {
    this.data.pending = this.data.pending.filter(old => old.itemId !== job.itemId);
    this.data.pending.push({ ...job, id: crypto.randomUUID() }); this.persist();
  }
  snapshot() {
    return { settings: this.data.settings, items: this.data.items, scanRoots: this.data.scanRoots, playbackDefaults: this.data.playbackDefaults, libraryPreferences: this.data.libraryPreferences, pendingCount: this.data.pending.length + (this.data.watchPending?.length ?? 0),
      logs: this.data.logs, accounts: {
        baidu: { connected: Boolean(this.data.secrets.baiduToken), profile: this.data.baiduProfile ?? null, configured: Boolean(this.data.settings.baiduClientId && this.data.secrets.baiduAppSecret) },
        trakt: { connected: Boolean(this.data.secrets.traktToken), profile: this.data.traktProfile ?? null, configured: Boolean(this.data.settings.traktClientId && this.data.settings.traktRedirectUri) }
      }, hasBaiduSecret: Boolean(this.data.secrets.baiduAppSecret), hasTmdbToken: Boolean(this.data.secrets.tmdbToken) };
  }
}
