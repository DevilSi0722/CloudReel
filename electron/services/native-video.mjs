import koffi from 'koffi';

let api;
// ASYNCWINDOWPOS | NOSENDCHANGING | NOOWNERZORDER | SHOWWINDOW | NOACTIVATE.
// HWND_TOP is intentional: Chromium may raise its black viewport HWND when
// React enters playback. NOZORDER leaves a perfectly decoded video behind it.
const videoPositionFlags = 0x4650;
function win32() {
  if (api) return api;
  if (process.platform !== 'win32') throw new Error('当前内嵌播放器仅支持 Windows。');
  const user32 = koffi.load('user32.dll');
  api = {
    create: user32.func('intptr_t __stdcall CreateWindowExW(uint32_t, str16, str16, uint32_t, int, int, int, int, intptr_t, intptr_t, intptr_t, void *)'),
    position: user32.func('bool __stdcall SetWindowPos(intptr_t, intptr_t, int, int, int, int, uint32_t)'),
    show: user32.func('bool __stdcall ShowWindowAsync(intptr_t, int)'),
    destroy: user32.func('bool __stdcall DestroyWindow(intptr_t)'),
    isChild: user32.func('bool __stdcall IsChild(intptr_t, intptr_t)'),
    rectangle: user32.func('bool __stdcall GetClientRect(intptr_t, void *)'),
    style: user32.func('intptr_t __stdcall GetWindowLongPtrW(intptr_t, int)'),
    child: user32.func('intptr_t __stdcall GetWindow(intptr_t, uint32_t)')
  };
  return api;
}

// A real WS_CHILD host keeps mpv inside the application's native client area.
// An owned transparent overlay draws the transport and episode list above this
// rectangle; their visibility never changes the native video's geometry.
export class NativeVideoHost {
  constructor(getWindow, getScale) { this.getWindow = getWindow; this.getScale = getScale; this.handle = null; this.bounds = null; this.active = false; this.suspended = false; this.pending = false; this.nextLayout = null; }
  parent() { const buffer = this.getWindow().getNativeWindowHandle(); return buffer.length === 8 ? buffer.readBigUInt64LE() : BigInt(buffer.readUInt32LE()); }
  prepare() {
    this.active = true; this.appliedLayout = null;
    const [width, height] = this.getWindow().getContentSize();
    if (!this.bounds) this.bounds = {x:0,y:0,width:Math.max(1,width),height:Math.max(1,height)};
    const scale = this.getScale(), initial = this.bounds;
    if (!this.handle) {
      // Start at a real size, before mpv creates its swapchain. The renderer
      // will subsequently provide the exact viewport (including title bar).
      this.handle = win32().create(0, 'STATIC', 'CloudReel Video', 0x46000004, Math.round(initial.x*scale), Math.round(initial.y*scale), Math.max(1,Math.round(initial.width*scale)), Math.max(1,Math.round(initial.height*scale)), this.parent(), 0, 0, null);
      if (!this.handle) throw new Error('无法创建软件内的视频画面。');
    }
    if (this.bounds) this.layout(this.bounds);
    return String(this.handle);
  }
  layout(input) {
    const { x, y, width, height } = input ?? {};
    if (![x, y, width, height].every(Number.isFinite) || x < 0 || y < 0 || width < 1 || height < 1) return;
    const window = this.getWindow(); if (!window || window.isDestroyed()) return;
    // Windows temporarily reports minimized geometry. Keep the last usable
    // video rectangle and do not synchronously resize an mpv child during it.
    if (this.suspended || window.isMinimized()) return;
    const [clientWidth, clientHeight] = window.getContentSize();
    if (x + width > clientWidth + 2 || y + height > clientHeight + 2) return;
    this.bounds = { x, y, width, height };
    if (!this.handle || !this.active) return;
    const scale = this.getScale();
    this.nextLayout = [Math.round(x * scale), Math.round(y * scale), Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale))];
    this.flushLayout();
  }
  flushLayout(layerRetries = 4) {
    if (this.pending || !this.nextLayout || !this.handle || this.suspended || !this.active) return;
    if (Date.now() < (this.transitionUntil || 0)) return;
    // Chromium can raise a sibling without changing our geometry. A cached
    // size alone must not suppress the positioning call that restores video.
    if (this.appliedLayout?.every((value,index) => value === this.nextLayout[index]) && win32().child(this.parent(),5) === this.handle) {this.nextLayout = null;return;}
    const handle = this.handle, geometry = this.nextLayout; this.nextLayout = null; this.pending = true;
    clearTimeout(this.layerTimer);
    // A synchronous SetWindowPos/ShowWindow can wait on the foreign mpv VO
    // thread while Windows is minimizing/restoring the owner. Queue the call
    // off the Electron UI thread and request async, nonactivating positioning.
    win32().position.async(handle, 0, ...geometry, videoPositionFlags, () => {
      this.pending = false; this.appliedLayout = geometry;
      if (this.handle !== handle || this.suspended) return;
      if (!this.active) {win32().show(handle, 0); return;}
      // mpv owns its child size and swapchain. Only resize our host; moving
      // the foreign child concurrently races its WinEvent/VO resize path.
      this.flushLayout();
      // ASYNCWINDOWPOS queues work on the owner thread. Chromium's first paint
      // can raise its surface after this callback, without a resize event.
      // Recheck the settled order briefly; never activate either window.
      const settleLayer = () => {
        if (this.handle !== handle || !this.active || this.suspended || this.pending || this.getWindow().isDestroyed() || !this.appliedLayout?.every((value,index) => value === geometry[index])) return;
        if (win32().child(this.parent(),5) !== handle) {
          this.nextLayout ??= geometry;
          this.flushLayout(--layerRetries);
        } else if (--layerRetries > 0) this.layerTimer = setTimeout(settleLayer, 100);
      };
      if (layerRetries > 0) this.layerTimer = setTimeout(settleLayer, 100);
    });
  }
  beginTransition() {
    this.transitionUntil = Date.now() + 180;
    clearTimeout(this.transitionTimer);
    this.transitionTimer = setTimeout(() => {this.transitionUntil = 0;this.flushLayout();}, 185);
  }
  suspend() { clearTimeout(this.layerTimer); this.suspended = true; this.nextLayout = null; }
  restore() { this.suspended = false; if (this.bounds && this.active) this.layout(this.bounds); }
  diagnostics() {
    const api = win32(), child = this.handle && api.child(this.handle,5);
    const size = handle => {const rectangle=Buffer.alloc(16);return handle && api.rectangle(handle,rectangle) ? {width:rectangle.readInt32LE(8),height:rectangle.readInt32LE(12)} : null;};
    return {embedded:Boolean(this.handle && api.isChild(this.parent(),this.handle)), videoChild:Boolean(child), bounds:this.bounds,
      nativeSize:size(this.handle), childSize:size(child), frontmost:Boolean(this.handle && api.child(this.parent(),5) === this.handle),
      shown:Boolean(this.handle && (BigInt(api.style(this.handle,-16)) & 0x10000000n))};
  }
  hide() { clearTimeout(this.layerTimer); this.active = false; this.nextLayout = null; if (this.handle) win32().show(this.handle, 0); }
  destroy() { clearTimeout(this.layerTimer); clearTimeout(this.transitionTimer); this.active = false; this.nextLayout = null; if (this.handle) { win32().destroy(this.handle); this.handle = null; } }
}
