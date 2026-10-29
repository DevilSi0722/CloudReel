import {BrowserWindow, session} from 'electron';
import {randomUUID} from 'node:crypto';
import jsQR from 'jsqr';
import {DiscoveryError, baiduShare, sharePageState} from '../core/discovery.mjs';

// Only extract DOM data. There is no preload, app bridge or access to an app
// profile, and no third-party page code is evaluated in Node's context.
export function pageSnapshot() {
  const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
  return {
    url: location.href, title: document.title,
    heading: clean(document.querySelector('h1')?.textContent),
    overview: clean([...document.querySelectorAll('h2')].find(node => node.textContent.includes('简介'))?.nextElementSibling?.textContent),
    poster: document.querySelector('img[alt*="海报"]')?.src,
    text: clean(document.body?.innerText).slice(0, 150000),
    fileRows: [...document.querySelectorAll('.file-name, .filename, .wp-s-pan-table__file-name')].filter(node => clean(node.textContent) && node.getClientRects().length).length,
    anchors: [...document.querySelectorAll('a[href]')].slice(0, 3000).map(anchor => {
      const image = anchor.querySelector('img');
      let sourceHost = '';
      try {const hint=anchor.getAttribute('data-link');if(hint){const url=new URL(hint.includes('://')?hint:'https://'+hint);if(url.protocol==='https:'&&!url.username&&!url.password&&!url.port)sourceHost=url.hostname;}} catch {}
      return {href: anchor.href, text: clean(anchor.textContent), image: image?.currentSrc || image?.src || image?.getAttribute('data-src'), imageAlt: image?.alt, sourceHost};
    }),
    forms: [...document.forms].map(form => ({action: form.action, method: form.method, fields: [...form.elements].map(field => field.name).filter(Boolean)}))
  };
}

export class DiscoveryBrowser {
  constructor(origin, {browserSession} = {}) {
    this.origin = origin;
    this.ownsSession = !browserSession;
    this.session = browserSession || session.fromPartition('cloudreel-discovery-' + randomUUID());
    this.session.setUserAgent(this.session.getUserAgent().replace(/\s(?:Electron|CloudReel|cloudreel)[^\s]*\/[^\s]+/g, ''));
    this.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    this.session.setPermissionCheckHandler(() => false);
    this.session.on('will-download', event => event.preventDefault());
    this.window = new BrowserWindow({show: false, focusable: false, skipTaskbar: true,
      webPreferences: {session: this.session, sandbox: true, contextIsolation: true, nodeIntegration: false, disableDialogs: true, backgroundThrottling: false, offscreen: true}});
    for (const method of ['show', 'showInactive', 'focus']) this.window[method] = () => { throw new Error('Research windows must stay hidden.'); };
    this.window.webContents.setWindowOpenHandler(({url}) => { this.popupUrl = url; return {action: 'deny'}; });
    const restrict = (event, target) => { if (!this.allowed(target)) {this.blockedNavigation = target; event.preventDefault();} };
    this.window.webContents.on('will-navigate', restrict);
    this.window.webContents.on('will-redirect', restrict);
    this.session.webRequest.onHeadersReceived({urls: [origin + '/*']}, (details, callback) => {
      if (details.resourceType === 'mainFrame') this.status = details.statusCode;
      callback({});
    });
  }
  allowed(input) {
    try { const url = new URL(input); return url.origin === this.origin && !url.username && !url.password; } catch { return false; }
  }
  async page(input, {timeout = 20000} = {}) {
    if (!this.allowed(input)) throw new DiscoveryError('invalid-url', '研究浏览器拒绝访问其他站点。');
    this.status = 0;
    let timer;
    try {
      return await Promise.race([
        (async () => {
          // A 403 challenge is still a useful observable page, so inspect the
          // DOM even if Chromium rejects the load's HTTP status.
          await new Promise(resolve => {
            const ready = () => {this.window.webContents.removeListener('dom-ready',ready);resolve();};
            this.window.webContents.once('dom-ready',ready);
            void this.window.loadURL(input).catch(ready);
          });
          if (!this.allowed(this.window.webContents.getURL())) throw new DiscoveryError('navigation-failed', '页面没有完成预期导航。');
          const read = () => this.window.webContents.executeJavaScript('(' + pageSnapshot.toString() + ')()');
          let snapshot = await read();
          // Give ordinary browser verification time to finish by itself. No
          // interaction with challenges, token injection or verification bypass.
          const until = Date.now() + 6000;
          while (/Just a moment|Checking your browser/i.test(snapshot.title) && Date.now() < until) {
            await new Promise(resolve => setTimeout(resolve, 500));
            snapshot = await read();
          }
          const qrLinks = new URL(input).pathname === '/link_start/' ? await this.qrLinks() : [];
          return {...snapshot, qrLinks, status: this.status};
        })(),
        new Promise((_resolve, reject) => { timer = setTimeout(() => { this.window.webContents.stop(); reject(new DiscoveryError('timeout', '页面读取超时。')); }, timeout); })
      ]);
    } finally { clearTimeout(timer); }
  }
  async qrLinks() {
    const images = await this.window.webContents.executeJavaScript(`(() => {
      return [...document.querySelectorAll('canvas, img[src^="data:image"]')].slice(0, 6).flatMap(node => {
        try {
          const width = node.width || node.naturalWidth, height = node.height || node.naturalHeight;
          if (!width || !height || width > 1024 || height > 1024) return [];
          const canvas = node.tagName === 'CANVAS' ? node : document.createElement('canvas');
          if (node.tagName !== 'CANVAS') {canvas.width = width; canvas.height = height; canvas.getContext('2d').drawImage(node, 0, 0);}
          return [{width, height, data: [...canvas.getContext('2d').getImageData(0, 0, width, height).data]}];
        } catch { return []; }
      });
    })()`);
    return images.flatMap(image => {
      const decoded = jsQR(new Uint8ClampedArray(image.data), image.width, image.height);
      return decoded?.data ? [decoded.data] : [];
    });
  }
  async search(query) {
    if (this.origin !== 'https://sidhub.cc' || typeof query !== 'string' || !query.trim() || query.length > 80) throw new DiscoveryError('invalid-search', '无效的搜索请求。');
    const before = this.window.webContents.getURL();
    this.popupUrl = null; this.blockedNavigation = null;
    const present = await this.window.webContents.executeJavaScript(`(() => {
      const input = document.querySelector('input[aria-label]');
      if (!input) return false;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(query)});
      input.dispatchEvent(new Event('input', {bubbles:true}));
      for (const type of ['keydown','keypress','keyup']) input.dispatchEvent(new KeyboardEvent(type, {key:'Enter', code:'Enter', keyCode:13, which:13, charCode:13, bubbles:true}));
      return true;
    })()`);
    if (!present) return {state: 'input-not-found'};
    const until = Date.now() + 4000;
    while (Date.now() < until && this.window.webContents.getURL() === before && !this.popupUrl && !this.blockedNavigation) await new Promise(resolve => setTimeout(resolve, 100));
    const observed = this.popupUrl || this.blockedNavigation || this.window.webContents.getURL();
    if (observed !== before && !this.allowed(observed)) return {state: 'external-search', host: new URL(observed).hostname};
    if (observed === before) return {state: 'route-not-confirmed'};
    // Reload the route observed from the site's own search interaction. Do not
    // invent undocumented API endpoints or infer results from the old catalog.
    return {state: 'route-observed', snapshot: await this.page(observed)};
  }
  async previewShare(input) {
    const share = baiduShare(input);
    if (this.origin !== 'https://pan.baidu.com' || !share) throw new DiscoveryError('invalid-share', '无效的百度分享地址。');
    let snapshot = await this.page(share.url);
    const read = async () => {
      try { return await this.window.webContents.executeJavaScript('(' + pageSnapshot.toString() + ')()'); }
      catch { return snapshot; } // A legitimate share-code redirect can replace the context.
    };
    // The official page may verify ?pwd asynchronously after did-finish-load.
    let until = Date.now() + 2500;
    while (Date.now() < until && !['files-visible', 'unavailable', 'verification-required'].includes(sharePageState(snapshot))) {
      await new Promise(resolve => setTimeout(resolve, 250)); snapshot = await read();
    }
    let submittedCode = false;
    if (share.password && sharePageState(snapshot) === 'password-required') {
      // Enter only the code supplied by the public share, through the official
      // page's own controls. Never handle login fields or solve a challenge.
      submittedCode = await this.window.webContents.executeJavaScript(`(() => {
        const input = document.querySelector('input.pickpw, .pickpw input, #accessCode, input[placeholder*="提取码"]');
        const button = [...document.querySelectorAll('button,a,[role="button"]')].find(node => /^(提取文件|访问文件)$/.test(node.textContent.trim()));
        if (!input || !button || input.tagName !== 'INPUT') return false;
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(share.password)});
        input.dispatchEvent(new Event('input', {bubbles:true})); input.dispatchEvent(new Event('change', {bubbles:true}));
        button.click(); return true;
      })()`);
      until = Date.now() + 7000;
      while (submittedCode && Date.now() < until && !['files-visible', 'unavailable', 'verification-required'].includes(sharePageState(snapshot))) {
        await new Promise(resolve => setTimeout(resolve, 250)); snapshot = await read();
      }
    }
    return {snapshot, submittedCode};
  }
  async shareMetadata() {
    return this.window.webContents.executeJavaScript(`(() => {
      const data = window.yunData || {}, get = key => {try {return window.locals?.get?.(key) ?? data[key];} catch {return data[key];}};
      const id = value => typeof value === 'string' && /^\\d+$/.test(value) ? value : Number.isSafeInteger(value) && value > 0 ? String(value) : '';
      return {shareId:id(get('shareid')), ownerId:id(get('share_uk'))};
    })()`);
  }
  destroy() { if (!this.window.isDestroyed()) this.window.destroy(); }
  async close() {
    this.destroy();
    if (this.ownsSession) {await this.session.clearStorageData(); await this.session.clearCache();}
  }
}
