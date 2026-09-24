const { ipcRenderer, contextBridge } = require('electron');

contextBridge.exposeInMainWorld('projectMenu', {
  select: (action) => ipcRenderer.send('project-menu:select', action),
  close: () => ipcRenderer.send('project-menu:close')
});
