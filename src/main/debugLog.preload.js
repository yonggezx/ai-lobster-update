// 调试日志窗口的 preload 脚本
const { contextBridge, ipcRenderer, clipboard } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // 接收主进程转发的单条日志
  onDebugLog: (callback) => {
    ipcRenderer.on('debug-log:add', (_e, type, msg) => {
      callback(type, msg);
    });
    // 接收主进程转发的批量日志（窗口打开时发送缓存的历史日志）
    ipcRenderer.on('debug-log:batch', (_e, logs) => {
      if (Array.isArray(logs)) {
        for (const log of logs) {
          callback(log.type, log.msg);
        }
      }
    });
  },
  // 主动请求主进程发送缓存的历史日志（页面加载完成后调用，避免丢失）
  requestDebugLogs: () => {
    return ipcRenderer.invoke('debug-log:request');
  },
  // 复制文本到剪贴板（使用 Electron 原生 clipboard，比 navigator.clipboard 更可靠）
  copyToClipboard: (text) => {
    try {
      clipboard.writeText(text);
      return true;
    } catch (e) {
      console.error('[DebugLog] 复制失败:', e.message);
      return false;
    }
  },
  // 关闭调试日志窗口
  closeDebugLogWindow: () => {
    return ipcRenderer.invoke('debug-log:close');
  }
});
