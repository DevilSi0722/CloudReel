import {app,BrowserWindow} from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {AppShutdown} from '../../electron/services/app-shutdown.mjs';
app.setName('CloudReel-Shutdown-Acceptance');app.setPath('userData',process.env.CLOUDREEL_TEST_DIRECTORY);
app.whenReady().then(async()=>{
  const main=new BrowserWindow({show:false}),auxiliary=new BrowserWindow({show:false});
  for(const view of [main,auxiliary])for(const method of ['show','showInactive','focus'])view[method]=()=>{throw Error('visibility prohibited');};
  await main.loadURL('data:text/html,isolated');
  const shutdown=new AppShutdown({app,prepare:[()=>assert.equal(BrowserWindow.getAllWindows().some(view=>view.isVisible()),false)],cleanup:[()=>new Promise(()=>{})],persist:()=>fs.writeFileSync(path.join(process.env.CLOUDREEL_TEST_DIRECTORY,'state.json'),JSON.stringify({progress:120,queuedStop:true})),dispose:()=>auxiliary.destroy(),timeout:200});
  shutdown.bind(main);
  app.on('will-quit',()=>{assert.equal(shutdown.ready,true);console.log(JSON.stringify({closedMainWithHiddenWindow:true,stalledCleanupBounded:true,visibleWindows:0}));});
  main.close();
}).catch(error=>{console.error(error.stack);app.exit(1);});
