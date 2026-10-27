import { BrowserWindow, session } from 'electron';
import { isTraktPage, isTraktCallback } from '../core/trakt-auth.mjs';

export function createTraktLogin(trakt, store, notify, parent, icon, onConnected = () => {}) {
  let window = null, exchanging = false, error = null;
  const partition = session.fromPartition('persist:cloudreel-trakt-login');
  partition.setPermissionRequestHandler((_contents, _permission, done) => done(false));
  partition.on('will-download', event => event.preventDefault());
  return {
    status: () => ({loginOpen: Boolean(window && !window.isDestroyed()), authorizing: exchanging, authorizationError: error}),
    open() {
      if (window && !window.isDestroyed()) {
        if (!error && trakt.authorization?.expires > Date.now()) {window.show(); window.focus(); return;}
        window.close();
      }
      const auth = trakt.beginAuth(), authorization = trakt.authorization;
      const current = new BrowserWindow({ parent: parent(), width: 620, height: 780, minWidth: 520, title: '连接 Trakt', autoHideMenuBar: true,
        icon,
        webPreferences: { session: partition, contextIsolation: true, nodeIntegration: false, sandbox: true } });
      window = current; exchanging = false; error = null;
      const navigate = (event, value) => {
        try { new URL(value); } catch { event.preventDefault(); return; }
        if (isTraktCallback(value, authorization.redirect)) {
          event.preventDefault(); if (exchanging) return;
          exchanging = true; notify();
          void trakt.completeAuth(value).then(() => { store.log('Trakt 已连接。'); if (!current.isDestroyed()) current.close(); onConnected(); })
            .catch(reason => { if (window !== current) return; error = reason.message; store.log(error, 'error'); exchanging = false; }).finally(notify);
        } else if (!isTraktPage(value)) event.preventDefault();
      };
      current.webContents.on('will-navigate', navigate); current.webContents.on('will-redirect', navigate);
      current.webContents.setWindowOpenHandler(({ url }) => { if (isTraktPage(url)) void current.loadURL(url).catch(() => {}); return { action: 'deny' }; });
      current.on('closed', () => { if (window === current) {window = null; exchanging = false;} if (trakt.authorization === authorization) trakt.authorization = null; notify(); });
      void current.loadURL(auth.url).catch(() => { if (window !== current) return; error = 'Trakt 登录页面加载失败，请检查网络后重试。'; store.log(error, 'warning'); notify(); });
      notify();
    },
    close() { if (window && !window.isDestroyed()) window.close(); trakt.authorization = null; exchanging = false; error = null; notify(); }
  };
}
