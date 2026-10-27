import type { AppState, Bridge } from './types';
export const emptyState: AppState = {
  settings: { baiduMode: 'web', baiduClientId: '', traktClientId: '', traktRedirectUri: '', mpvPath: '', rootDir: '/', autoSync: true, autoScrape: true, autoNext: true },
  accounts: { baidu: { connected: false, configured: true, mode: 'web', profile: null }, trakt: { connected: false, configured: false, profile: null } },
  items: [], collections: [], scrape: {running: false, done: 0, total: 0, matched: 0, failed: 0, current: '', error: null, tmdbConfigured: false}, pendingCount: 0, logs: [], hasBaiduSecret: false, hasTmdbToken: false, player: null,
  scan: { running: false, count: 0, directory: '', error: null }, runtime: { mpvReady: false, version: '0.3.17', desktop: false }
};
export const bridge: Bridge = window.cloudreel ?? {
  async invoke<T>(method: string): Promise<T> {
    if (method === 'state') return structuredClone(emptyState) as T;
    throw new Error('当前是浏览器界面预览。请运行桌面应用使用此功能。');
  },
  onState: () => () => {}
};
