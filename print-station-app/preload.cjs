// The only bridge between the window and the station: a fixed set of calls.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('ps', {
  state: () => ipcRenderer.invoke('state'),
  onState: (cb) => ipcRenderer.on('state', (_e, s) => cb(s)),
  discover: () => ipcRenderer.invoke('discover'),
  choose: (p) => ipcRenderer.invoke('choose', p),
  changePrinter: () => ipcRenderer.invoke('change-printer'),
  test: () => ipcRenderer.invoke('test'),
  unpair: () => ipcRenderer.invoke('unpair'),
  openPair: () => ipcRenderer.invoke('open-pair'),
  login: (on) => ipcRenderer.invoke('login', on),
});
