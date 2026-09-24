const { ipcRenderer, contextBridge } = require('electron');

contextBridge.exposeInMainWorld('actionPanel', {
  trigger: (type, value) => ipcRenderer.send('action-panel:trigger', { type, value }),
  close: () => ipcRenderer.send('action-panel:close'),
  dragMove: (dx, dy) => ipcRenderer.send('window:drag-move', { dx, dy })
});
