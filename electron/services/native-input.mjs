import koffi from 'koffi';
import {fileURLToPath} from 'node:url';

let api;
function win32() {
  if (api) return api;
  // Native loaders cannot read ASAR's virtual filesystem. The build explicitly
  // unpacks this DLL; the ordinary development path remains unchanged.
  const filename=fileURLToPath(new URL('../native/cloudreel-input.dll',import.meta.url)).replace(/app\.asar([\\/])/,'app.asar.unpacked$1');
  const library=koffi.load(filename);
  api = {
    install:library.func('bool __stdcall CloudReelInputInstall(intptr_t)'),
    remove:library.func('void __stdcall CloudReelInputRemove(intptr_t)'),
    cursor:library.func('void __stdcall CloudReelCursorHidden(intptr_t, bool)')
  };
  return api;
}

export function setOverlayCursorHidden(window, hidden) {
  if (process.platform !== 'win32' || !window || window.isDestroyed()) return;
  const buffer = window.getNativeWindowHandle(), hwnd = buffer.length === 8 ? buffer.readBigUInt64LE() : BigInt(buffer.readUInt32LE());
  win32().cursor(hwnd, Boolean(hidden));
}

// Electron's non-focusable top-level HWND returns MA_NOACTIVATEANDEAT (4).
// Keep nonactivation, but return MA_NOACTIVATE (3), which preserves the click.
// The native subclass runs entirely on the owning UI thread. It uses the
// ComCtl32 subclass chain and never replaces Chromium's WndProc with JS.
export function preserveOverlayMouseInput(window) {
  if (process.platform !== 'win32') return () => {};
  const native = win32(), buffer = window.getNativeWindowHandle();
  const hwnd = buffer.length === 8 ? buffer.readBigUInt64LE() : BigInt(buffer.readUInt32LE());
  let disposed = false;
  if (!native.install(hwnd)) throw new Error('无法初始化播放控件鼠标交互。');
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    native.remove(hwnd);
  };
  window.once('closed', dispose);
  return dispose;
}
