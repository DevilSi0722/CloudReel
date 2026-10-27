import {app, BrowserWindow} from 'electron';
import koffi from 'koffi';
import path from 'node:path';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {PlayerOverlay} from '../../electron/services/player-overlay.mjs';
import {NativeVideoHost} from '../../electron/services/native-video.mjs';

const directory = process.env.CLOUDREEL_TEST_DIRECTORY;
app.setName('CloudReel-Restore-Regression'); app.setPath('userData',path.join(directory,'profile'));
fs.mkdirSync(path.join(directory,'dist'),{recursive:true}); fs.mkdirSync(path.join(directory,'electron'),{recursive:true});
fs.writeFileSync(path.join(directory,'dist/index.html'),'<!doctype html><html><body></body></html>');
fs.writeFileSync(path.join(directory,'electron/preload.cjs'),'');
const wait = ms=>new Promise(resolve=>setTimeout(resolve,ms));
let parent, overlay, host;
app.whenReady().then(async()=>{
  parent = new BrowserWindow({show:false,width:980,height:680});
  await parent.loadURL('data:text/html,<!doctype html><html><body>Hidden test</body></html>');
  // Pretend the test owner is on screen for lifecycle logic only. Suppress
  // showInactive below: no test window is ever made visible on the desktop.
  const owner = new Proxy(parent,{get(target,key){if(key==='isVisible')return()=>true;const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
  host = new NativeVideoHost(()=>owner,()=>1); host.layout({x:0,y:38,width:960,height:600});host.prepare();
  overlay = new PlayerOverlay({parent:()=>owner,videoHost:host,root:directory}); await overlay.create();
  let shows=0; overlay.window.showInactive=()=>{shows++;}; overlay.bind();
  overlay.update({player:{itemId:'test'}});
  const api=koffi.load('user32.dll'),hwnd=parent.getNativeWindowHandle().readBigUInt64LE();
  const get=api.func('intptr_t __stdcall GetWindowLongPtrW(intptr_t,int)'),set=api.func('intptr_t __stdcall SetWindowLongPtrW(intptr_t,int,intptr_t)'),send=api.func('intptr_t __stdcall SendMessageW(intptr_t,uint32_t,uintptr_t,intptr_t)');
  const style=BigInt(get(hwnd,-16)), bounds={...host.bounds};
  const create=api.func('intptr_t __stdcall CreateWindowExW(uint32_t,str16,str16,uint32_t,int,int,int,int,intptr_t,intptr_t,intptr_t,void *)');
  const destroy=api.func('bool __stdcall DestroyWindow(intptr_t)');
  // Simulate Chromium raising its opaque child surface during a view change.
  const blocker=create(0,'STATIC','Hidden renderer sibling',0x50000004,0,0,960,640,hwnd,0,0,null);
  host.layout(bounds);
  // SetWindowPos is deliberately asynchronous; wait for its native result,
  // not a fixed delay which flakes when other GPU/media tests are starting.
  for(let i=0;i<100&&!host.diagnostics().frontmost;i++)await wait(20);
  const native=host.diagnostics();assert.equal(native.frontmost,true,'video must be above the opaque Chromium sibling');
  assert.deepEqual(native.nativeSize,{width:960,height:600});assert.equal(native.shown,true);destroy(blocker);
  for(let cycle=0;cycle<12;cycle++){
    set(hwnd,-16,style|0x20000000n);send(hwnd,5,1,0);
    assert.equal(parent.isMinimized(),true);assert.equal(host.suspended,true);
    host.layout({x:0,y:0,width:1,height:1});assert.deepEqual(host.bounds,bounds);
    set(hwnd,-16,style);send(hwnd,5,0,BigInt((640<<16)|960));
    assert.equal(parent.isMinimized(),false);
    // Incoming playback updates must not cancel scheduled restoration.
    for(let i=0;i<4;i++){overlay.update({player:{itemId:'test'}});await wait(25);}
    assert.equal(host.suspended,false);assert.equal(overlay.suspended,false);
    assert.deepEqual(host.bounds,bounds);
    assert.equal(await parent.webContents.executeJavaScript('6*7'),42);
    assert.equal(await overlay.window.webContents.executeJavaScript('6*7'),42);
  }
  host.hide(); overlay.update({player:null});
  const hiddenBounds={...host.bounds};
  for(let cycle=0;cycle<3;cycle++){
    set(hwnd,-16,style|0x20000000n);send(hwnd,5,1,0);
    set(hwnd,-16,style);send(hwnd,5,0,BigInt((640<<16)|960));await wait(120);
    assert.equal(host.active,false);assert.equal(host.suspended,false);assert.deepEqual(host.bounds,hiddenBounds);
    assert.equal(BigInt(get(BigInt(host.handle),-16)) & 0x10000000n,0n,'returning to the library must not reveal stale video');
  }
  assert.ok(shows>0);assert.equal(BrowserWindow.getAllWindows().some(w=>w.isVisible()),false);
  console.log(JSON.stringify({hiddenNativeMinimizeRestoreCycles:12,mainAndControlsResponsive:true,geometryPreserved:true,visibleWindowsOpened:0}));
  overlay.destroy();host.destroy();parent.destroy();app.quit();
}).catch(error=>{console.error(error.stack);overlay?.destroy();host?.destroy();parent?.destroy();app.exit(1);});
