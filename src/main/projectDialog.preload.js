// projectDialog.preload.js — 项目风格确认/错误弹窗（替代系统原生 showMessageBox / showErrorBox）
// 暴露 sendResult 给 projectDialog.html 用于回传用户选择的按钮索引。
// 主进程通过 ipcMain.on('project-dialog:result', ...) 接收 index。
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('projectDialog', {
  sendResult: (index) => {
    try { ipcRenderer.send('project-dialog:result', Number(index)); } catch (e) {}
  }
});
