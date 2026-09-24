const { ipcRenderer, contextBridge } = require('electron');

contextBridge.exposeInMainWorld('inputBar', {
  send: (text) => ipcRenderer.send('input-bar:send', text),
  focusChange: (focused) => ipcRenderer.send('input-bar:focus-change', focused),
  dragMove: (dx, dy) => ipcRenderer.send('window:drag-move', { dx, dy })
});
