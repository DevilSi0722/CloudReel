import {app, BrowserWindow} from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import koffi from 'koffi';
import {PlayerOverlay} from '../../electron/services/player-overlay.mjs';

const root = process.env.CLOUDREEL_TEST_DIRECTORY;
app.setName('CloudReel-Overlay-Regression'); app.setPath('userData', path.join(root, 'profile'));
fs.mkdirSync(path.join(root, 'dist'), {recursive:true}); fs.mkdirSync(path.join(root, 'electron'), {recursive:true});
fs.writeFileSync(path.join(root, 'dist/index.html'), '<!doctype html><html><body></body></html>');
fs.writeFileSync(path.join(root, 'electron/preload.cjs'), '');
let parent, overlay;
app.whenReady().then(async () => {
  parent = new BrowserWindow({show:false});
  overlay = new PlayerOverlay({parent:()=>parent, videoHost:{bounds:{x:0,y:0,width:980,height:600}}, root});
  await overlay.create(); const window = overlay.window;
  assert.equal(window.isFocusable(), false, 'overlay must not activate and reveal the taskbar');
  const hwnd = window.getNativeWindowHandle().readBigUInt64LE();
  const user32 = koffi.load('user32.dll'), dwm = koffi.load('dwmapi.dll');
  const getStyle = user32.func('intptr_t __stdcall GetWindowLongPtrW(intptr_t, int)');
  assert.notEqual(BigInt(getStyle(hwnd, -20)) & 0x08000000n, 0n, 'WS_EX_NOACTIVATE must be set');
  const getBackdrop = dwm.func('int32_t __stdcall DwmGetWindowAttribute(intptr_t, uint32_t, void *, uint32_t)');
  const backdrop = Buffer.alloc(4), result = getBackdrop(hwnd, 38, backdrop, 4);
  // Older Windows versions do not expose this attribute. When available,
  // DWMSBT_NONE=1 must remain set while panels are visible and after hiding.
  if (result === 0) assert.equal(backdrop.readInt32LE(), 1, 'whole-window backdrop would blur native video');
  overlay.setRegions({regions:[{x:10,y:10,width:200,height:60,radius:20}],opacity:1});
  overlay.setRegions({regions:[],opacity:0});
  const getProp = user32.func('intptr_t __stdcall GetPropA(intptr_t,str)');
  overlay.setRegions({regions:[],opacity:0,cursorHidden:true});
  assert.equal(Number(getProp(hwnd,'CloudReelHiddenCursor')),1,'hidden cursor is scoped to the player HWND');
  overlay.setRegions({regions:[],opacity:0,cursorHidden:false});
  assert.equal(Number(getProp(hwnd,'CloudReelHiddenCursor')),0,'showing controls resets native cursor state');
  assert.equal(window.getOpacity(), 1, 'clear video must retain mouse input after controls fade');
  assert.equal(overlay.controlsOpacity,0);
  const gdi = koffi.load('gdi32.dll'), createRegion = gdi.func('intptr_t __stdcall CreateRectRgn(int,int,int,int)'), deleteRegion = gdi.func('bool __stdcall DeleteObject(intptr_t)');
  const region = createRegion(0,0,0,0), getRegion = user32.func('int __stdcall GetWindowRgn(intptr_t,intptr_t)');
  assert.equal(getRegion(hwnd,region), 0, 'native video must remain covered by the clear gesture surface'); deleteRegion(region);
  const hitTest = user32.func('intptr_t __stdcall SendMessageW(intptr_t, uint32_t, uintptr_t, intptr_t)');
  assert.equal(Number(hitTest(hwnd,0x21,parent.getNativeWindowHandle().readBigUInt64LE(),0x02010001)),3,'native mouse activation must preserve, rather than eat, the first click');
  const bounds = window.getBounds(), x = Math.round(bounds.x + bounds.width / 2), y = Math.round(bounds.y + bounds.height / 2);
  assert.equal(Number(hitTest(hwnd,0x84,0,BigInt(((y & 65535) << 16) | (x & 65535)))),1,'clear video must hit the interaction surface');
  assert.equal(BrowserWindow.getAllWindows().some(w=>w.isVisible()), false);
  console.log(JSON.stringify({noWindowBackdrop:true,noMouseActivation:true,clearVideoReceivesMouseWhenControlsHide:true,visibleWindowsOpened:0}));
  overlay.destroy();
  // Retire/destroy/recreate across separate event-loop turns, then destroy the
  // owner. A raw JS WndProc hook can pass clicks yet crash this later teardown.
  for(let cycle=0;cycle<6;cycle++){
    await new Promise(resolve=>setTimeout(resolve,25));
    overlay=new PlayerOverlay({parent:()=>parent,videoHost:{bounds:{x:0,y:0,width:980,height:600}},root});
    await overlay.create();
    assert.equal(Number(hitTest(overlay.window.getNativeWindowHandle().readBigUInt64LE(),0x21,parent.getNativeWindowHandle().readBigUInt64LE(),0x02010001)),3);
    overlay.destroy();
  }
  await new Promise(resolve=>setTimeout(resolve,50));parent.destroy();app.quit();
}).catch(error=>{console.error(error.stack);overlay?.destroy();parent?.destroy();app.exit(1);});
