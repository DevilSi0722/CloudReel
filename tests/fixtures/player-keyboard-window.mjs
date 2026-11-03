import {app,BrowserWindow} from 'electron';
import assert from 'node:assert/strict';
import {bindPlayerKeyboard} from '../../electron/services/player-keyboard.mjs';
import {PlayerService} from '../../electron/services/player.mjs';
import {memoryStore} from '../helpers.mjs';
app.setName('CloudReel-Keyboard-Regression');app.setPath('userData',process.env.CLOUDREEL_TEST_DIRECTORY);
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let window;
app.whenReady().then(async()=>{
  window=new BrowserWindow({show:false,webPreferences:{offscreen:true}});
  for(const method of ['show','showInactive','focus'])window[method]=()=>{throw Error('visibility prohibited');};
  await window.loadURL('data:text/html,keyboard%20regression');
  window.webContents.debugger.attach('1.3');await window.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true});
  // Disable physical polling deliberately: a tap must receive its real keyUp,
  // rather than passing only because the missing-release safeguard intervened.
  const player=new PlayerService(memoryStore(),{}, {},{}, {resolveMpv(){},rightPressed:null});
  const session=player.session={position:60,speed:1.25,paused:false,socket:{write:line=>{const {command}=JSON.parse(line);if(command[1]==='speed')session.speed=command[2];}}},seeks=[];
  player.seek=target=>seeks.push(target);
  bindPlayerKeyboard(window,player);
  const key=async(type,modifiers=[])=>{window.webContents.sendInputEvent({type,keyCode:'Right',modifiers});await wait(60);};
  await key('keyDown');await key('keyUp');await wait(420);
  assert.deepEqual(seeks,[65]);assert.equal(session.speed,1.25);assert.equal(session.boosting,false);assert.equal(player.gestures.right,null);
  seeks.length=0;await key('keyDown');await wait(380);assert.equal(session.speed,3);assert.equal(session.boosting,true);
  await key('keyUp',['control']);assert.equal(session.speed,1.25);assert.equal(session.boosting,false);assert.deepEqual(seeks,[]);
  assert.equal(BrowserWindow.getAllWindows().some(view=>view.isVisible()),false);
  console.log(JSON.stringify({nativeKeyRelease:true,oneTapOneSeek:true,holdRestoresOriginalSpeed:true,modifierRelease:true,visibleWindows:0}));window.destroy();app.quit();
}).catch(error=>{console.error(error.stack);window?.destroy();app.exit(1);});
