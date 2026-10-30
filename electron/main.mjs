import { app, BrowserWindow, ipcMain, safeStorage, shell, dialog, protocol, screen, session } from 'electron';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { Store } from './core/store.mjs';
import { baiduItem, localItem, isVideo } from './core/media.mjs';
import { BaiduService } from './services/baidu.mjs';
import { createBaiduLogin } from './services/baidu-login.mjs';
import { createTraktLogin } from './services/trakt-login.mjs';
import { serviceConfig } from './core/service-config.mjs';
import { TraktService } from './services/trakt.mjs';
import { SyncService } from './services/sync.mjs';
import { PlayerService, discoverMpv } from './services/player.mjs';
import { identifyLibrary, groupLibrary } from './core/identification.mjs';
import { ArtworkCache } from './services/artwork.mjs';
import { MetadataService } from './services/metadata.mjs';
import { NativeVideoHost } from './services/native-video.mjs';
import { PlayerOverlay } from './services/player-overlay.mjs';
import { createMetadataFetcher } from './services/desktop-network.mjs';
import {ThumbnailService} from './services/thumbnails.mjs';
import {MediaProbeService} from './services/media-probe.mjs';
import {LibraryScanner} from './services/scanner.mjs';
import {LibraryRefresh} from './services/library-refresh.mjs';
import {FileManagementService} from './services/file-management.mjs';
import {DiscoveryService} from './services/discovery.mjs';
import {DiscoveryBrowser} from './services/discovery-browser.mjs';
import {BaiduShareService} from './services/baidu-share.mjs';
import {validatePlayback} from './core/playback-preferences.mjs';
import {versionKey} from './core/versions.mjs';
import {forgetWatchIdentity} from './core/watch-state.mjs';

const projectDirectory = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const applicationIcon = path.join(projectDirectory, 'assets', 'brand', 'app.ico');
const testChannel = JSON.parse(fs.readFileSync(path.join(projectDirectory,'package.json'),'utf8')).cloudreelChannel === 'seedhub-test';
app.setName(testChannel ? 'CloudReel-SeedHub-Test' : 'CloudReel');
// Grayscale text avoids ClearType colour fringes on translucent dark surfaces.
app.commandLine.appendSwitch('disable-lcd-text');
if (process.platform === 'win32') app.setAppUserModelId(testChannel ? 'dev.cloudreel.seedhubtest' : 'dev.cloudreel.player');
protocol.registerSchemesAsPrivileged([{ scheme: 'cloudreel-art', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
if (process.env.CLOUDREEL_DATA_DIR) app.setPath('userData', path.resolve(process.env.CLOUDREEL_DATA_DIR));
else app.setPath('userData', path.join(app.getPath('appData'), testChannel ? 'CloudReel-SeedHub-Test' : app.isPackaged ? 'CloudReel' : 'CloudReel-Dev'));
if (process.env.CLOUDREEL_DEBUG_PORT && !app.isPackaged) { app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1'); app.commandLine.appendSwitch('remote-debugging-port', process.env.CLOUDREEL_DEBUG_PORT); }
if (!app.requestSingleInstanceLock()) { app.quit(); }
else {
  app.whenReady().then(async () => {
  let window, controls, quitting = false, auth = null;
  const store = new Store(app.getPath('userData'), safeStorage);
  if (fs.existsSync(store.file) && !fs.existsSync(store.file + '.before-0.3')) fs.copyFileSync(store.file, store.file + '.before-0.3');
  identifyLibrary(store.data.items); store.persist();
  const metadataFetcher = createMetadataFetcher(session.fromPartition('cloudreel-metadata'));
  const oauthBaidu = new BaiduService(store), trakt = new TraktService(store, { ...serviceConfig(projectDirectory).trakt, fetcher: metadataFetcher });
  const usingWebBaidu = () => store.data.settings.baiduMode !== 'oauth';
  const resolveMpv = () => discoverMpv(store.data.settings.mpvPath, process.resourcesPath, projectDirectory);
  const snapshot = () => {
    const state = store.snapshot();
    if (usingWebBaidu()) state.accounts.baidu = webLogin.status();
    state.accounts.trakt.configured = trakt.configured();
    Object.assign(state.accounts.trakt, traktLogin.status());
    state.accounts.trakt.sync = sync.status();
    return { ...state, fileTask: fileManager.status(), discoveryTransfers: transfers.status(), collections: groupLibrary(store.data.items), scrape: metadata.status(), player: player.status(), scan: scanner.state, mediaProbes: mediaProbe.states, runtime: { mpvReady: Boolean(resolveMpv()), version: app.getVersion(), desktop: true, playerOverlay: true, windowChrome: process.platform === 'win32', fullscreen: Boolean(window?.isFullScreen()) } };
  };
  let notifyTimer;
  const notify = () => {
    if (notifyTimer) return;
    notifyTimer = setTimeout(() => { notifyTimer = null; if (window && !window.isDestroyed()) {const state = snapshot(); window.webContents.send('cloudreel:state', state); controls?.update(state);} }, 100);
  };
  const webLogin = createBaiduLogin(store, notify, () => window, applicationIcon);
  const traktLogin = createTraktLogin(trakt, store, notify, () => window, applicationIcon, () => {sync.reset(); void sync.pull();});
  const baidu = {
    list: (...args) => (usingWebBaidu() ? webLogin.service : oauthBaidu).list(...args),
    fileInfo: (...args) => (usingWebBaidu() ? webLogin.service : oauthBaidu).fileInfo(...args),
    manageFile: (...args) => (usingWebBaidu() ? webLogin.service : oauthBaidu).manageFile(...args),
    streamUrl: (...args) => (usingWebBaidu() ? webLogin.service : oauthBaidu).streamUrl(...args),
    fetchMedia: (url, options) => usingWebBaidu() ? webLogin.service.fetchMedia(url, options) : fetch(url, options)
  };
  const sync = new SyncService(store, trakt, notify, () => player.session?.item.id ?? null);
  const artwork = new ArtworkCache(app.getPath('userData'), metadataFetcher);
  protocol.handle('cloudreel-art', request => artwork.response(request.url));
  const metadata = new MetadataService(store, artwork, { notify, fetcher: metadataFetcher, tmdbToken: serviceConfig(projectDirectory).tmdbToken });
  const videoHost = new NativeVideoHost(() => window, () => screen.getDisplayMatching(window.getBounds()).scaleFactor * window.webContents.getZoomFactor());
  let fullscreenTimer;
  const toggleFullscreen = () => {
    if (fullscreenTimer || !window || window.isDestroyed()) return;
    videoHost.beginTransition(); controls?.beginTransition();
    window.setFullScreen(!window.isFullScreen());
    fullscreenTimer = setTimeout(() => {fullscreenTimer = null; layoutVideo(); controls?.endTransition(); notify();}, 150);
    notify();
  };
  function layoutVideo() {
    if (!window || window.isDestroyed() || window.isMinimized()) return;
    const [width,height] = window.getContentSize(), top = process.platform === 'win32' && !window.isFullScreen() ? 38 : 0;
    videoHost.layout({x:0,y:top,width,height:Math.max(1,height-top)});
  }
  // mpv is an external process: it cannot read Electron's virtual ASAR paths.
  const inputDirectory = app.isPackaged ? path.join(process.resourcesPath, 'player') : path.join(projectDirectory, 'electron');
  const player = new PlayerService(store, baidu, trakt, sync, { resolveMpv, notify, videoHost, inputConfig: path.join(inputDirectory, 'player-keys.conf'), fullscreen: () => window?.isFullScreen() ?? false, toggleFullscreen, onAction: action => controls?.action(action) ?? false });
  const thumbnails = player.thumbnails = new ThumbnailService(app.getPath('userData'), player);
  const mediaProbe = new MediaProbeService(store,baidu,resolveMpv,notify);
  const scanner = new LibraryScanner(store, baidu, notify, current => scrapeLater(false, current.background));
  const discovery = new DiscoveryService({createBrowser:() => new DiscoveryBrowser('https://sidhub.cc')});
  const transfers = new BaiduShareService({store,web:webLogin.service,browserSession:webLogin.browserSession,prepareWork:work=>metadata.discoveryWork(work),createBrowser:() => new DiscoveryBrowser('https://pan.baidu.com',{browserSession:webLogin.browserSession}),notify,importDirectory:async target => {
    // Resolve a renamed target before ingestion and limit the scan to it.
    const info = target.fsId ? await baidu.fileInfo(target.fsId) : {path:target.path};
    const count = await scanner.importBaiduDirectory(info.path,{identities:target.identities,selection:target.selection});
    const mountInfo=target.mountFsId?await baidu.fileInfo(target.mountFsId):info;
    if (target.mount && !scanner.roots().some(root => root.source === 'baidu' && root.enabled !== false && (mountInfo.path === root.path || mountInfo.path.startsWith(root.path.replace(/\/$/,'') + '/')))) scanner.add('baidu',mountInfo.path,target.mountFsId||target.fsId);
    scrapeLater(false,true);notify();return count;
  }});
  const libraryRefresh = new LibraryRefresh(scanner, {baiduConnected: () => usingWebBaidu() ? webLogin.service.connected : Boolean(store.data.secrets.baiduToken), automatic: () => store.data.settings.autoRefresh !== false});
  const fileManager = new FileManagementService(store, baidu, {
    notify,
    account: () => `${store.data.settings.baiduMode}:${usingWebBaidu() ? store.data.baiduWebProfile?.uk : store.data.baiduProfile?.uk}`,
    verifyAccount: async () => {if (usingWebBaidu()) {if (!await webLogin.service.check()) throw new Error('请先重新连接百度网盘。');} else await oauthBaidu.token();},
    blocked: () => Boolean(player.session || player.opening || scanner.state.running || transfers.busy),
    begin: async () => {scanner.suspended = true; mediaProbe.cancel(); metadata.cancel(); await metadata.activeRun;},
    end: () => {scanner.suspended = false; scrapeLater(false, true);}
  });
  function scrapeLater(refresh = false, background = false) {
    if(!store.data.settings.autoScrape || quitting) return;
    void metadata.schedule({refresh, background});
  }
  function requireIdle() { if (player.session || player.opening || scanner.state.running || sync.flushing || transfers.busy || fileManager.busy) throw new Error('请等待当前播放、扫描、文件处理、保存或同步操作结束，再修改账号及播放器设置。'); }
  function cancelAuth() { if (auth?.timer) clearTimeout(auth.timer); auth = null; }
  const externalOrigins = new Set(['https://pan.baidu.com', 'https://openapi.baidu.com', 'https://app.trakt.tv', 'https://trakt.tv', 'https://auth.trakt.tv', 'https://github.com', 'https://mpv.io', 'https://www.themoviedb.org', 'https://movie.douban.com', 'https://www.tvmaze.com']);
  async function openExternal(url) {
    const parsed = new URL(url); if (!externalOrigins.has(parsed.origin)) throw new Error('此链接不在应用支持的服务范围内。');
    await shell.openExternal(parsed.toString());
  }
  function openProviderWindow(title,url,browserSession,origin) {
    const view = new BrowserWindow({parent:window,width:1060,height:760,title,autoHideMenuBar:true,icon:applicationIcon,webPreferences:{session:browserSession,contextIsolation:true,nodeIntegration:false,sandbox:true,webviewTag:false}});
    const allowed = value => {try {const target = new URL(value);return target.protocol === 'https:' && !target.username && !target.password && (target.origin === origin || origin === 'https://pan.baidu.com' && target.origin === 'https://passport.baidu.com');} catch {return false;}};
    const restrict = (event,target) => {if(!allowed(target)) event.preventDefault();};
    view.webContents.on('will-navigate',restrict);view.webContents.on('will-redirect',restrict);view.webContents.setWindowOpenHandler(() => ({action:'deny'}));
    void view.loadURL(url).catch(() => {});
  }
  const handlers = {
    'state': () => snapshot(),
    'discovery:catalog': input => discovery.catalog(input),
    'discovery:detail': id => discovery.detail(id),
    'discovery:preview': async input => {const url = await discovery.resolve(input?.id); return transfers.inspect(url, typeof input?.title === 'string' ? input.title : '',discovery.work(input?.id));},
    'discovery:files': input => transfers.list(input),
    'discovery:naming': input => transfers.naming(input),
    'discovery:transfer': input => {if (fileManager.busy) throw new Error('请等待网盘文件操作完成。');if (!usingWebBaidu()) throw new Error('片源转存需要使用百度网页登录。');return transfers.transfer(input);},
    'discovery:tasks': () => transfers.status(),
    'discovery:check': id => transfers.check(id),
    'discovery:verifySite': () => {const browser = discovery.browser();openProviderWindow('SeedHub 网站验证','https://sidhub.cc/',browser.session,'https://sidhub.cc');},
    'discovery:openResource': async id => {const url = await discovery.resolve(id);openProviderWindow('百度网盘分享',url,webLogin.browserSession,'https://pan.baidu.com');},
    'settings:save': input => { if(['baiduMode','baiduClientId','baiduSecret','traktClientId','traktRedirectUri','mpvPath'].some(key => input?.[key] !== undefined)) {requireIdle(); cancelAuth(); webLogin.close(); traktLogin.close();} const previousTrakt = store.data.settings.traktClientId; store.saveSettings(input ?? {}); if (previousTrakt !== store.data.settings.traktClientId) sync.reset(); if (input?.tmdbToken?.trim()) void metadata.restart(); else if (input?.clearTmdbToken) {metadata.cancel(); metadata.clearCache();} else if (input?.autoScrape === false) metadata.cancel(); notify(); return snapshot(); },
    'external:open': url => openExternal(url),
    'mpv:select': async () => {
      const result = await dialog.showOpenDialog(window, { title: '选择 mpv 播放器', properties: ['openFile'], filters: [{ name: 'mpv', extensions: ['exe'] }] });
      return result.canceled ? null : result.filePaths[0];
    },
    'account:disconnect': async provider => {
      requireIdle(); if (!['baidu', 'trakt'].includes(provider)) throw new Error('无效的账号类型。');
      if (provider === 'baidu') fileManager.invalidate();
      cancelAuth(); store.setSecret(provider + 'Token', null); delete store.data[provider + 'Profile'];
      if (provider === 'baidu') await webLogin.disconnect();
      if (provider === 'trakt') traktLogin.close();
      if (provider === 'trakt') {store.data.pending = []; sync.reset();}
      store.persist(); notify(); return snapshot();
    },
    'baidu:auth': async () => {
      requireIdle(); cancelAuth();
      if (usingWebBaidu()) { webLogin.open(); return { mode: 'web' }; }
      const code = await oauthBaidu.beginAuth();
      const current = { code, expires: Date.now() + code.expires_in * 1000, interval: Math.max(5, code.interval ?? 5), timer: null }; auth = current;
      const poll = async () => {
        if (auth !== current) return;
        if (Date.now() > current.expires) { cancelAuth(); store.log('百度登录二维码已过期，请重新连接。', 'warning'); notify(); return; }
        try {
          const result = await oauthBaidu.pollAuth(code.device_code, () => auth === current); if (auth !== current) return;
          if (result.status === 'connected') { cancelAuth(); store.log('百度网盘已连接。'); notify(); return; }
          if (result.status === 'slow_down') current.interval += 5;
        } catch (error) { if (auth !== current) return; cancelAuth(); store.log(error.message, 'error'); notify(); return; }
        current.timer = setTimeout(poll, current.interval * 1000);
      };
      current.timer = setTimeout(poll, current.interval * 1000);
      return { userCode: code.user_code, verificationUrl: code.verification_url, qrcodeUrl: code.qrcode_url, expiresAt: current.expires };
    },
    'baidu:cancelAuth': () => cancelAuth(),
    'baidu:checkWeb': async () => { await webLogin.check(); return snapshot(); },
    'files:browse': input => fileManager.browse(input),
    'files:preview': input => fileManager.preview(input),
    'files:report': () => fileManager.lastReport,
    'files:cancel': () => fileManager.cancel(),
    'files:commit': async input => {const result = await fileManager.commit(input); notify(); return result;},
    'baidu:list': ({ directory, start = 0 }) => baidu.list(directory, Number(start)),
    'baidu:folders': async ({directory, start = 0}) => {
      const result = await baidu.list(directory, Number(start));
      return {...result, files: result.files.filter(file => Number(file.isdir) === 1)};
    },
    'library:mountBaidu': async input => {
      if (!(usingWebBaidu() ? webLogin.service.connected : store.data.secrets.baiduToken)) throw new Error('请先连接百度网盘。');
      await scanner.mountBaidu(input);metadata.foreground(); notify(); return snapshot();
    },
    'library:importBaidu': file => {
      if (!file || file.isdir || !isVideo(file.server_filename) || !/^\d+$/.test(String(file.fs_id))) throw new Error('请选择有效的视频文件。');
      const item = baiduItem(file); if (!store.data.items.some(old => old.id === item.id)) store.upsert([item]);
      identifyLibrary(store.data.items); store.persist(); scrapeLater(); notify(); return snapshot();
    },
    'library:importLocal': async () => {
      const result = await dialog.showOpenDialog(window, { title: '添加本地视频', properties: ['openFile', 'multiSelections'], filters: [{ name: '视频', extensions: ['mkv', 'mp4', 'm4v', 'avi', 'mov', 'wmv', 'ts', 'm2ts', 'webm'] }] });
      if (!result.canceled) {
        const items = result.filePaths.filter(isVideo).map(file => localItem(file, fs.statSync(file).size)).filter(item => !store.data.items.some(old => old.id === item.id));
        store.upsert(items); store.log(`已添加 ${items.length} 个本地视频。`); notify();
      }
      identifyLibrary(store.data.items); store.persist(); scrapeLater();
      return snapshot();
    },
    'library:importFolder': async () => {
      if (scanner.state.running && !scanner.state.background) throw new Error('请先结束当前扫描。');
      const selected = await dialog.showOpenDialog(window, {title:'选择本地影视目录',properties:['openDirectory']});
      if (!selected.canceled) {const root=scanner.add('local',selected.filePaths[0]);scanner.refresh([root.id]);metadata.foreground();}
      return snapshot();
    },
    'library:scan': () => {
      if (!(usingWebBaidu() ? webLogin.service.connected : store.data.secrets.baiduToken)) throw new Error('请先连接百度网盘。');
      const root=scanner.add('baidu',store.data.settings.rootDir || '/');return scanner.refresh([root.id]);
    },
    'library:refresh': input => {scanner.refresh(input?.ids);metadata.foreground();return snapshot();},
    'library:cancelScan': () => scanner.cancel(),
    'library:removeRoot': id => {
      if(scanner.state.running) throw new Error('请先停止扫描。');
      store.data.scanRoots=scanner.roots().filter(root=>root.id!==id);store.persist();notify();return snapshot();
    },
    'library:version': id => {
      const item=store.item(id),key=versionKey(item);
      for(const other of store.data.items) if(versionKey(other)===key) other.versionPreferred=other.id===id;
      store.persist();notify();return snapshot();
    },
    'playback:defaults': input => {store.data.playbackDefaults={...store.data.playbackDefaults,...validatePlayback(input)};store.persist();notify();return snapshot();},
    'library:watch': async input => {
      const result = await sync.markWatched(input); notify(); return result;
    },
    'library:organize': ({ids, favorite, hidden}) => {
      if (!Array.isArray(ids) || !ids.length || ids.length > 20000 || favorite !== undefined && typeof favorite !== 'boolean' || hidden !== undefined && typeof hidden !== 'boolean') throw new Error('无效的片库操作。');
      const entries = [...new Set(ids)].map(id => store.item(id)), at = new Date().toISOString();
      for (const item of entries) {if (favorite !== undefined) item.favorite = favorite; if (hidden !== undefined) {if (hidden) item.continueHiddenAt = at; else delete item.continueHiddenAt;}}
      store.persist(); notify(); return snapshot();
    },
    'library:preferences': input => {
      const allowed = {status: ['all', 'unwatched', 'in-progress', 'watched'], sort: ['recent', 'title', 'rating', 'year', 'watched'], source: ['all', 'baidu', 'local']};
      store.data.libraryPreferences ??= {};
      for (const key of Object.keys(allowed)) if (input?.[key] !== undefined && allowed[key].includes(input[key])) store.data.libraryPreferences[key] = input[key];
      for (const key of ['genre', 'year']) if (typeof input?.[key] === 'string' && input[key].length < 80) store.data.libraryPreferences[key] = input[key];
      store.persist(); return store.data.libraryPreferences;
    },
    'library:remove': id => {
      if (player.session?.item.id === id) throw new Error('请先停止该影片的播放。');
      store.data.items = store.data.items.filter(item => item.id !== id); store.persist(); notify(); return snapshot();
    },
    'library:identify': async ({ ids, title, kind, season, episode }) => {
      if (sync.flushing) throw new Error('请等待观看状态同步结束，再修改影片识别。');
      if (!Array.isArray(ids) || !ids.length || typeof title !== 'string' || !title.trim() || title.length > 160 || !['movie', 'episode'].includes(kind)) throw new Error('请填写有效的影片名称和类型。');
      if (ids.includes(player.session?.item.id)) throw new Error('请先停止该影片的播放。');
      if (season !== undefined && (!Number.isInteger(season) || season < 0 || season > 99) || episode !== undefined && (!Number.isInteger(episode) || episode < 1 || episode > 9999)) throw new Error('请填写有效的季集数。');
      ids.forEach(id => store.item(id)); metadata.cancel(); await metadata.activeRun;
      forgetWatchIdentity(store, ids);
      for (const id of ids) { const item = store.item(id); item.title = title.trim(); item.inferredTitle = item.title; item.kind = kind; item.identificationLocked = true; delete item.catalog; delete item.episodeMetadata; delete item.metadataLocked; delete item.metadata; delete item.remoteProgress; delete item.remoteWatching; delete item.remoteNext; if (kind === 'episode') { item.seriesTitle = item.title; if (season !== undefined) item.season = season; if (episode !== undefined && ids.length === 1) item.episode = episode; } else { delete item.seriesTitle; delete item.season; delete item.episode; } }
      store.data.pending = store.data.pending.filter(job => !ids.includes(job.itemId));
      store.persist(); notify(); scrapeLater(); return snapshot();
    },
    'metadata:search': async ({ query, kind, source }) => {
      const results = await metadata.search(query, kind, source);
      return Promise.all(results.slice(0, 15).map(async result => ({ ...result, query, poster: await artwork.cache(result.posterUrl) })));
    },
    'metadata:match': async ({ ids, selection }) => { if (sync.flushing) throw new Error('请等待观看状态同步结束，再修改影片资料。'); if (!Array.isArray(ids) || !ids.length || ids.includes(player.session?.item.id)) throw new Error('请先停止播放，再更改影片资料。'); ids.forEach(id => store.item(id)); metadata.cancel(); await metadata.activeRun; await metadata.apply(ids, selection, true); notify(); return snapshot(); },
    'metadata:refresh': () => { void metadata.restart(); return snapshot(); },
    'metadata:cancel': () => { metadata.cancel(); return snapshot(); },
    'metadata:test': () => metadata.test(),
    'trakt:auth': async () => { requireIdle(); traktLogin.open(); return { started: true }; },
    'trakt:cancelAuth': () => { traktLogin.close(); return snapshot(); },
    'trakt:complete': async callback => { requireIdle(); await trakt.completeAuth(callback); sync.reset(); void sync.pull(); store.log('Trakt 已连接。'); notify(); return snapshot(); },
    'trakt:search': ({ query, type }) => trakt.search(query, type),
    'trakt:match': async ({ id, selection }) => {
      if (sync.flushing) throw new Error('请等待观看状态同步结束，再修改影片匹配。');
      if (player.session?.item.id === id) throw new Error('请先停止播放，再修改影片匹配。');
      const item = store.item(id), match = await trakt.match(selection, item);
      if (sync.flushing) throw new Error('观看状态正在同步，请稍后重试匹配。');
      forgetWatchIdentity(store, [id]);
      if (item.catalog || item.identificationLocked) match.title = item.title;
      Object.assign(item, match); delete item.remoteProgress; delete item.remoteWatching; delete item.remoteNext; store.data.pending = store.data.pending.filter(job => job.itemId !== item.id); store.persist(); store.log(`已匹配：${item.title}`); notify(); return snapshot();
    },
    'trakt:pull': async () => {
      await sync.pull({manual: true}); return snapshot();
    },
    'sync:retry': async () => { await sync.flush(); notify(); return snapshot(); },
    'media:probe': ({id,force=false}) => {mediaProbe.request(id,Boolean(force));return snapshot();},
    'player:play': ({ id, fromBeginning = false }) => {if (fileManager.busy) throw new Error('请等待网盘文件操作完成后播放。');mediaProbe.cancel();return player.play(id, Boolean(fromBeginning));},
    'player:stop': () => player.stop(),
    'player:pause': () => player.togglePause(),
    'player:activate': () => {if (player.session && window && !window.isDestroyed() && !window.isFocused()) window.focus();},
    'player:thumbnail': input => thumbnails.request(input),
    'player:cancelThumbnail': () => thumbnails.cancel(),
    'player:marker': input => player.setMarker(input),
    'player:skipSection': input => player.skipSection(input),
    'player:seek': seconds => player.seek(seconds),
    'player:control': input => player.control(input),
    'player:cancelNext': () => player.cancelNext(),
    'player:resetPreferences': () => player.resetPreferences(),
    'player:importSubtitle': async () => {
      const itemId=player.session?.item.id;
      const result=await dialog.showOpenDialog(window,{title:'添加字幕',properties:['openFile','multiSelections'],filters:[{name:'字幕',extensions:['srt','ass','ssa','vtt']}]});
      if(!result.canceled && player.session?.item.id===itemId) await player.importSubtitles(result.filePaths);
    },
    'player:dropSubtitles': files => player.importSubtitles(files),
    'player:shortcut': action => player.shortcut(action),
    'player:adjacent': direction => { if (![1, -1].includes(direction)) throw new Error('无效的选集方向。'); return player.adjacent(direction); },
    'player:bounds': () => {layoutVideo(); controls?.scheduleLayout();},
    'player:overlayRegions': regions => {controls?.setRegions(regions); if (regions?.subtitleLayout) player.subtitleLayout(regions.subtitleLayout);},
    'player:fullscreen': () => { if (!player.session) return; toggleFullscreen(); },
    'player:diagnostics': () => videoHost.diagnostics()
  };
  ipcMain.handle('cloudreel:invoke', async (event, method, payload) => {
    const overlaySender = controls?.owns(event.sender);
    if (!window || !overlaySender && event.sender !== window.webContents || event.senderFrame !== event.sender.mainFrame) return { ok: false, error: '无效的调用来源。' };
    const overlayMethods = new Set(['state', 'player:stop', 'player:pause', 'player:activate', 'player:seek', 'player:control', 'player:shortcut', 'player:adjacent', 'player:play', 'player:fullscreen', 'player:overlayRegions', 'player:cancelNext', 'player:resetPreferences', 'player:importSubtitle', 'player:dropSubtitles', 'player:thumbnail', 'player:cancelThumbnail', 'player:marker', 'player:skipSection']);
    if (overlaySender && !overlayMethods.has(method) || !overlaySender && method === 'player:overlayRegions') return {ok: false, error: '无效的播放器调用。'};
    try {
      if (typeof method !== 'string' || !Object.hasOwn(handlers, method)) throw new Error('不支持的操作。');
      if (fileManager.busy && /^(?:settings:save|library:(?:removeRoot|importBaidu|importLocal|identify|remove)|metadata:(?:match|refresh)|trakt:match|discovery:check)$/.test(method)) throw new Error('请等待网盘文件操作完成。');
      return { ok: true, value: await handlers[method](payload) };
    } catch (error) { return { ok: false, error: error.message || '操作失败，请重试。' }; }
  });
  window = new BrowserWindow({ width: 1380, height: 900, minWidth: 980, minHeight: 680, title: '云映 CloudReel', backgroundColor: '#101012', autoHideMenuBar: true,
    ...(process.platform === 'win32' ? {titleBarStyle: 'hidden', titleBarOverlay: {color: '#101012', symbolColor: '#b9b9c2', height: 38}} : {}),
    icon: applicationIcon,
    webPreferences: { preload: path.join(projectDirectory, 'electron', 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window.on('resize', layoutVideo);
  window.on('enter-full-screen', () => {layoutVideo();notify();}); window.on('leave-full-screen', () => {layoutVideo();notify();});
  controls = new PlayerOverlay({parent: () => window, videoHost, root: projectDirectory, icon: applicationIcon, devUrl: !app.isPackaged && process.env.CLOUDREEL_DEV_URL});
  controls.onError = () => {void player.stop().finally(() => {store.log('播放控件载入失败，请重新打开影片。', 'error'); notify();});};
  controls.bind();
  // Chromium and the native video child have separate focus. Keep shortcuts
  // working immediately after Play, before the user first clicks the video.
  window.webContents.on('before-input-event', (event, input) => {
    if (!player.session || input.control || input.alt || input.meta || input.isComposing) return;
    const name = input.key.toLowerCase();
    const actions = {' ': 'pause', k: 'pause', p: 'pause', arrowleft: 'backward', arrowup: 'volume-up', arrowdown: 'volume-down', f: 'fullscreen', enter: 'fullscreen', m: 'mute', q: 'exit', '[': 'previous', ']': 'next', '?': 'help', escape: 'escape'};
    if (name === 'arrowright') {event.preventDefault(); if (input.type === 'keyUp') void player.shortcut('right-up'); else if (!input.isAutoRepeat) void player.shortcut('right-down'); return;}
    const action = actions[name]; if (!action) return;
    event.preventDefault();
    if (input.type === 'keyDown' && (!input.isAutoRepeat || ['arrowleft', 'arrowup', 'arrowdown'].includes(name))) void player.shortcut(action).catch(() => {});
  });
  window.on('blur', () => {void player.shortcut('cancel');});
  if (process.env.CLOUDREEL_DEV_URL && !app.isPackaged) await window.loadURL(process.env.CLOUDREEL_DEV_URL);
  else await window.loadFile(path.join(projectDirectory, 'dist', 'index.html'));
  app.on('second-instance', () => { if (window.isMinimized()) window.restore(); window.focus(); });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', event => {
    if (quitting) return; event.preventDefault(); discovery.close();transfers.close();libraryRefresh.stop();cancelAuth(); webLogin.close(); traktLogin.close(); scanner.cancel(); mediaProbe.cancel(); metadata.cancel();
    void player.stop().catch(() => {}).then(() => thumbnails.reset()).finally(() => { controls.destroy(); videoHost.destroy(); quitting = true; app.quit(); });
  });
  const retryTimer = setInterval(() => { void sync.flush(); }, 60000); retryTimer.unref();
  const pullTimer = setInterval(() => { if (!quitting) void sync.pull(); }, 30000); pullTimer.unref();
  window.on('focus', () => { if (!quitting && Date.now() - (Date.parse(sync.status().lastPulledAt ?? '') || 0) > 15000) void sync.pull(); });
  void sync.flush();
  void sync.pull();
  libraryRefresh.start();
  if (usingWebBaidu()) void webLogin.restore().then(() => libraryRefresh.startup()).catch(() => {});
  scrapeLater(false, true);
  }).catch(error => { console.error('CloudReel startup failed:', error.message); dialog.showErrorBox('云映启动失败', error.message); app.exit(1); });
}
