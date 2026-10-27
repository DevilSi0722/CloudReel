const { contextBridge, ipcRenderer, webUtils } = require('electron');
contextBridge.exposeInMainWorld('cloudreel', {
  filePath: file => webUtils.getPathForFile(file),
  invoke: async (method, payload) => {
    const response = await ipcRenderer.invoke('cloudreel:invoke', method, payload);
    if (!response.ok) throw new Error(response.error);
    return response.value;
  },
  onState: callback => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('cloudreel:state', listener);
    return () => ipcRenderer.removeListener('cloudreel:state', listener);
  },
  onPlayerAction: callback => {
    const listener = (_event, action) => callback(action);
    ipcRenderer.on('cloudreel:player-action', listener);
    return () => ipcRenderer.removeListener('cloudreel:player-action', listener);
  },
  onPlayerActivity: callback => {
    const listener = () => callback();
    ipcRenderer.on('cloudreel:player-activity', listener);
    return () => ipcRenderer.removeListener('cloudreel:player-activity', listener);
  },
  onPlayerPointer: callback => {
    const listener = (_event, inside) => callback(inside === true);
    ipcRenderer.on('cloudreel:player-pointer', listener);
    return () => ipcRenderer.removeListener('cloudreel:player-pointer', listener);
  }
});
