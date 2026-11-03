import fs from 'node:fs';
import path from 'node:path';
import updater from 'electron-updater';
import {AppUpdateService} from './app-updater.mjs';

export function createAppUpdater({app,testChannel=false,...options}) {
  const installed=process.platform==='win32'&&process.arch==='x64'&&app.isPackaged&&!testChannel&&!process.env.PORTABLE_EXECUTABLE_FILE&&fs.existsSync(path.join(path.dirname(app.getPath('exe')),'Uninstall CloudReel.exe'));
  // The feed is fixed in the main process; no renderer-supplied repository,
  // token, URL or local executable is accepted by this service.
  const engine=installed?new updater.NsisUpdater({provider:'github',owner:'DevilSi0722',repo:'CloudReel',private:false,releaseType:'release'}):null;
  return new AppUpdateService({engine,currentVersion:app.getVersion(),supported:installed,...options});
}
