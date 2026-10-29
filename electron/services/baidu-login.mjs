import { BrowserWindow, session, net } from 'electron';
import { BaiduWebService, BAIDU_WEB_HOME, isBaiduPage } from './baidu-web.mjs';
import { fetchSessionMedia } from './session-media.mjs';

export function createBaiduLogin(store, notify, parent, icon) {
  const browserSession = session.fromPartition('persist:cloudreel-baidu-web');
  browserSession.setUserAgent(browserSession.getUserAgent().replace(/\s(?:Electron|CloudReel|cloudreel)\/[^\s]+/g, ''));
  browserSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  browserSession.on('will-download', event => event.preventDefault());
  const service = new BaiduWebService(store, { fetcher: (url, options) => browserSession.fetch(url, options), mediaFetcher: (url, options) => fetchSessionMedia(browserSession, url, options, request => net.request(request)), notify });
  let loginWindow = null, timer = null, closed = false;
  const stopTimer = () => { if (timer) clearInterval(timer); timer = null; };
  async function probe(reportErrors = false) {
    if (closed) return false;
    const wasConnected = service.connected;
    try {
      const connected = await service.check();
      if (connected && !closed) {
        if (!wasConnected) store.log('百度网盘已连接。');
        stopTimer(); if (loginWindow && !loginWindow.isDestroyed()) loginWindow.close();
        return true;
      }
    } catch (error) { if (reportErrors) throw error; /* The official page may still be waiting for login. */ }
    return false;
  }
  return {
    service,
    browserSession,
    status: () => ({ ...service.status(), loginOpen: Boolean(loginWindow && !loginWindow.isDestroyed()) }),
    async restore() {
      // Inspect only our own provider partition; never import another browser's cookies.
      const cookies = await browserSession.cookies.get({ url: 'https://pan.baidu.com' });
      if (cookies.some(cookie => ['BDUSS', 'BDUSS_BFESS', 'STOKEN'].includes(cookie.name))) await probe();
    },
    open() {
      closed = false;
      if (loginWindow && !loginWindow.isDestroyed()) { loginWindow.show(); loginWindow.focus(); return; }
      const current = new BrowserWindow({ parent: parent(), width: 1060, height: 760, minWidth: 820, minHeight: 640, title: '登录百度网盘', autoHideMenuBar: true, backgroundColor: '#ffffff',
        icon,
        webPreferences: { session: browserSession, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
      loginWindow = current;
      const restrict = (event, url) => { if (!isBaiduPage(url)) event.preventDefault(); };
      current.webContents.on('will-navigate', restrict); current.webContents.on('will-redirect', restrict);
      current.webContents.setWindowOpenHandler(({ url }) => { if (isBaiduPage(url)) void current.loadURL(url).catch(() => {}); return { action: 'deny' }; });
      current.webContents.on('did-finish-load', () => { void probe(); });
      current.on('closed', () => { if (loginWindow === current) loginWindow = null; stopTimer(); notify(); });
      current.webContents.on('did-fail-load', (_event, code, _description, _url, isMainFrame) => {
        if (isMainFrame && code !== -3) { store.log('百度登录页面加载失败，请检查网络后重新打开。', 'warning'); notify(); }
      });
      stopTimer(); timer = setInterval(() => { void probe(); }, 6000);
      void current.loadURL(BAIDU_WEB_HOME).catch(() => {}); notify();
    },
    async check() {
      closed = false;
      if (!await probe(true)) throw new Error('尚未检测到有效的百度网盘登录，请在官方网页中完成扫码或账号验证后重试。');
    },
    close() { closed = true; stopTimer(); if (loginWindow && !loginWindow.isDestroyed()) loginWindow.close(); },
    async disconnect() {
      this.close(); service.reset();
      await browserSession.clearStorageData(); await browserSession.clearCache(); await browserSession.cookies.flushStore();
      notify();
    }
  };
}
