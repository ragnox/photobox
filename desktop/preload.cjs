// The small set of native features the web UI may use when it runs in the desktop app.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('photobox', {
  platform: process.platform,
  pickFolder: () => ipcRenderer.invoke('pick-folder'),
  reveal: (path) => ipcRenderer.send('reveal', path),
  contextMenu: (items) => ipcRenderer.invoke('context-menu', items),
  share: (files, at) => ipcRenderer.invoke('share', files, at),
  whatsapp: () => ipcRenderer.invoke('whatsapp'),
  sendToWhatsApp: (files) => ipcRenderer.invoke('send-to-whatsapp', files),
  startDrag: (ids) => ipcRenderer.send('start-drag', ids),
  setProgress: (fraction) => ipcRenderer.send('progress', fraction),
  pathForFile: (file) => webUtils.getPathForFile(file),
  onMenu: (handler) => ipcRenderer.on('menu', (_event, action) => handler(action)),
});
