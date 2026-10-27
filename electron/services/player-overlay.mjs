import {BrowserWindow, screen} from 'electron';
import path from 'node:path';
import {overlayRegions, playerOverlayBounds, pointInside} from '../core/player-overlay.mjs';
import {preserveOverlayMouseInput, setOverlayCursorHidden} from './native-input.mjs';

// Native mpv video occupies a child HWND. An owned transparent surface
// draws controls above it without resizing the video or creating a taskbar entry.
// The clear surface also handles video gestures; it never activates independently
// of the fullscreen owner. Windows system backdrops affect the whole HWND even
// when shaped, so only individual CSS panels provide the frosted appearance.
export class PlayerOverlay {
  constructor({parent, videoHost, root, icon, devUrl}) {
    Object.assign(this, {parent, videoHost, root, icon, devUrl});
    this.window = null; this.state = null; this.ready = false; this.lastPointer = null; this.pointerInside = null; this.regions = [];
    this.suspended = false; this.layoutTimer = null; this.restoreTimer = null; this.listeners = [];
    this.timer = setInterval(() => this.pointer(), 90); this.timer.unref();
  }
  owns(contents) { return Boolean(this.window && !this.window.isDestroyed() && this.window.webContents === contents); }
  async create() {
    if (this.window) return;
    const parent = this.parent(); if (!parent || parent.isDestroyed()) return;
    const window = new BrowserWindow({parent, show: false, frame: false, transparent: true, backgroundColor: '#00000000',
      ...(process.platform === 'win32' ? {backgroundMaterial: 'none'} : {}),
      width: 980, height: 600, focusable: false, skipTaskbar: true, hasShadow: false, resizable: false, minimizable: false, maximizable: false,
      fullscreenable: false, autoHideMenuBar: true, title: 'CloudReel · 播放控制', icon: this.icon,
      webPreferences: {preload: path.join(this.root, 'electron/preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false}});
    this.window = window; this.ready = false; window.setMenu(null);
    window.setFocusable(false);
    this.releaseMouseInput = preserveOverlayMouseInput(window);
    window.webContents.setWindowOpenHandler(() => ({action: 'deny'}));
    window.webContents.on('will-navigate', event => event.preventDefault());
    window.on('closed', () => {if (this.window === window) {this.window = null; this.ready = false;}});
    window.on('close', event => {if (this.state?.player) {event.preventDefault(); this.parent()?.close();}});
    this.setRegions([]);
    try {
      if (this.devUrl) {const url = new URL(this.devUrl); url.hash = 'player-controls'; await window.loadURL(url.toString());}
      else await window.loadFile(path.join(this.root, 'dist/index.html'), {hash: 'player-controls'});
      if (window.isDestroyed()) return;
      this.ready = true; this.update(this.state);
    } catch (error) {window.destroy(); this.onError?.(error);}
  }
  bind() {
    const parent = this.parent();
    const listen = (event, callback) => {parent.on(event, callback); this.listeners.push([parent, event, callback]);};
    for (const event of ['move', 'resize', 'enter-full-screen', 'leave-full-screen']) listen(event, () => this.scheduleLayout());
    for (const event of ['restore', 'show']) listen(event, () => this.restore());
    for (const event of ['minimize', 'hide']) listen(event, () => this.suspend());
    listen('closed', () => this.destroy());
  }
  scheduleLayout() {
    clearTimeout(this.layoutTimer);
    this.layoutTimer = setTimeout(() => {
      this.layoutTimer = null;
      const parent = this.parent(); if (!parent || parent.isDestroyed()) return;
      this.layout();
    }, 0);
  }
  beginTransition() {this.transitioning = true;}
  endTransition() {this.transitioning = false;this.scheduleLayout();}
  suspend() {
    clearTimeout(this.restoreTimer);
    this.suspended = true; this.lastPointer = null; this.pointerInside = null; this.videoHost.suspend?.();
    // Native owner transitions are in progress inside minimize/hide callbacks.
    // Defer control-window changes until Windows unwinds that message stack.
    this.scheduleLayout();
  }
  restore() {
    this.suspended = false;
    clearTimeout(this.restoreTimer);
    this.restoreTimer = setTimeout(() => {
      const parent = this.parent(); if (!parent || parent.isDestroyed() || parent.isMinimized() || !parent.isVisible()) return;
      this.videoHost.restore?.(); parent.webContents.invalidate();
      if (this.window && !this.window.isDestroyed()) {
        this.window.webContents.invalidate();
        this.window.webContents.send('cloudreel:player-activity');
      }
      this.scheduleLayout();
    }, 80);
    this.scheduleLayout();
  }
  update(state) {
    this.state = state;
    if (!state?.player) {this.scheduleLayout(); this.lastPointer = null; this.pointerInside = null; setOverlayCursorHidden(this.window, false); return;}
    if (!this.window) {void this.create(); return;}
    if (!this.ready) return;
    this.window.webContents.send('cloudreel:state', state); this.scheduleLayout();
  }
  action(action) {
    if (!this.ready || !this.window || this.window.isDestroyed() || !this.state?.player) return false;
    this.window.webContents.send('cloudreel:player-action', action); return true;
  }
  layout() {
    if (this.transitioning) return;
    const parent = this.parent(), window = this.window;
    if (!parent || parent.isDestroyed() || !window || window.isDestroyed() || !this.ready) return;
    if (this.suspended || !this.state?.player || !parent.isVisible() || parent.isMinimized()) {setOverlayCursorHidden(window, false); if (window.isVisible()) window.hide(); return;}
    const bounds = playerOverlayBounds(parent.getContentBounds(), this.videoHost.bounds);
    if (!bounds) return;
    const previous = window.getBounds();
    if (Object.keys(bounds).some(key => bounds[key] !== previous[key])) window.setBounds(bounds);
    if (!window.isVisible()) window.showInactive();
  }
  setRegions(input) {
    const window = this.window; if (!window || window.isDestroyed()) return;
    const [width, height] = window.getContentSize();
    const opacity = Array.isArray(input) ? 1 : input?.opacity;
    if (!Number.isFinite(opacity) || opacity < 0 || opacity > 1) throw new Error('无效的播放器控件透明度。');
    this.regions = overlayRegions(Array.isArray(input) ? input : input.regions, {width, height});
    this.controlsOpacity = opacity;
    if (!Array.isArray(input) && typeof input.cursorHidden === 'boolean') {
      this.cursorHidden = input.cursorHidden;
      setOverlayCursorHidden(window, input.cursorHidden);
    }
    // Regions describe visual panels for diagnostics, not native input holes.
    // Keep the full transparent interaction surface alive when controls fade so
    // video clicks/wheel do not depend on mpv's embedded-window mouse handling.
  }
  pointer() {
    const window = this.window, parent = this.parent();
    if (!this.state?.player || !window || window.isDestroyed() || !window.isVisible() || !parent || parent.isDestroyed()) return;
    const point = screen.getCursorScreenPoint();
    const inside = pointInside(point, window.getBounds()) && (parent.isFocused() || window.isFocused());
    if (this.cursorHidden && inside) setOverlayCursorHidden(window, true);
    if (inside !== this.pointerInside) {this.pointerInside = inside; window.webContents.send('cloudreel:player-pointer', inside);}
    if (this.lastPointer?.x === point.x && this.lastPointer?.y === point.y) return;
    this.lastPointer = point;
    if (inside) window.webContents.send('cloudreel:player-activity');
  }
  destroy() {
    clearInterval(this.timer); clearTimeout(this.layoutTimer); clearTimeout(this.restoreTimer);
    for (const [target, event, callback] of this.listeners) target.removeListener(event, callback);
    this.listeners = []; this.state = null; this.releaseMouseInput?.(); this.releaseMouseInput = null; this.window?.destroy(); this.window = null;
  }
}
