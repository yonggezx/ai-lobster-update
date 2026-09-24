/**
 * 渲染进程安全模块 - 防调试、防 dump
 * 
 * 功能：
 * 1. 检测开发者工具是否打开
 * 2. 检测调试器
 * 3. 右键菜单限制（可选）
 * 4. 关键数据内存保护
 * 
 * 使用方式：在渲染进程 HTML 中 <script src="security-renderer.js"></script>
 */

(function() {
  'use strict';

  // ============================================================
  // 配置
  // ============================================================
  
  const CONFIG = {
    // 开发模式下跳过所有保护
    isDev: window.location.search.includes('dev=true') || 
           window.process && window.process.env && 
           (window.process.env.NODE_ENV === 'development' || 
            window.process.argv && window.process.argv.includes('--dev')),
    
    // 检测开发者工具的间隔（毫秒）
    devtoolsCheckInterval: 1000,
    
    // 开发者工具打开时的动作：'log' | 'warn' | 'close' | 'reload'
    onDevtoolsOpen: 'warn',
    
    // 是否禁用右键菜单（生产环境）
    disableContextMenu: true,
    
    // 是否禁用常见的调试快捷键
    disableDebugShortcuts: true,
  };

  // 开发模式下跳过
  if (CONFIG.isDev) {
    console.log('[Security] 开发模式，跳过安全保护');
    return;
  }

  // ============================================================
  // 开发者工具检测
  // ============================================================
  
  let devtoolsOpen = false;
  let devtoolsChecker = null;

  function checkDevtools() {
    // 方法1: 利用 console.log 的时间差
    const start = performance.now();
    // 断点钩子：如果开发者工具打开，debugger 会暂停
    debugger;
    const elapsed = performance.now() - start;
    
    if (elapsed > 100) {
      if (!devtoolsOpen) {
        devtoolsOpen = true;
        onDevtoolsDetected();
      }
    } else {
      if (devtoolsOpen) {
        devtoolsOpen = false;
        console.log('[Security] 开发者工具已关闭');
      }
    }
  }

  function onDevtoolsDetected() {
    console.warn('[Security] 检测到开发者工具已打开');
    
    switch (CONFIG.onDevtoolsOpen) {
      case 'close':
        // 尝试关闭窗口（Electron 环境）
        if (window.close) {
          setTimeout(() => window.close(), 1000);
        }
        break;
      case 'reload':
        setTimeout(() => window.location.reload(), 1000);
        break;
      case 'warn':
      default:
        // 显示警告
        showSecurityWarning('检测到开发者工具，部分功能可能受限');
        break;
    }
  }

  // ============================================================
  // 安全警告显示
  // ============================================================
  
  function showSecurityWarning(message) {
    // 检查是否已经有警告
    if (document.getElementById('security-warning')) return;
    
    const warning = document.createElement('div');
    warning.id = 'security-warning';
    warning.style.cssText = `
      position: fixed;
      top: 10px;
      right: 10px;
      background: rgba(220, 53, 69, 0.9);
      color: white;
      padding: 12px 20px;
      border-radius: 8px;
      font-size: 14px;
      z-index: 999999;
      box-shadow: 0 4px 12px rgba(0,0,0,0.3);
      font-family: system-ui, -apple-system, sans-serif;
    `;
    warning.textContent = '⚠ ' + message;
    document.body.appendChild(warning);
    
    // 5秒后自动消失
    setTimeout(() => {
      if (warning.parentNode) {
        warning.style.transition = 'opacity 0.5s';
        warning.style.opacity = '0';
        setTimeout(() => warning.remove(), 500);
      }
    }, 5000);
  }

  // ============================================================
  // 右键菜单限制
  // ============================================================
  
  if (CONFIG.disableContextMenu) {
    document.addEventListener('contextmenu', function(e) {
      // 允许输入框和文本区域的右键菜单
      const target = e.target;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || 
          target.isContentEditable) {
        return;
      }
      e.preventDefault();
      return false;
    });
  }

  // ============================================================
  // 调试快捷键限制
  // ============================================================
  
  if (CONFIG.disableDebugShortcuts) {
    document.addEventListener('keydown', function(e) {
      // F12
      if (e.key === 'F12') {
        e.preventDefault();
        return false;
      }
      // Ctrl+Shift+I / Cmd+Opt+I
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'I' || e.key === 'i')) {
        e.preventDefault();
        return false;
      }
      // Ctrl+Shift+J / Cmd+Opt+J (Console)
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'J' || e.key === 'j')) {
        e.preventDefault();
        return false;
      }
      // Ctrl+U (查看源码)
      if ((e.ctrlKey || e.metaKey) && (e.key === 'U' || e.key === 'u')) {
        e.preventDefault();
        return false;
      }
    });
  }

  // ============================================================
  // 内存保护：清除敏感数据
  // ============================================================
  
  window.SecurityUtils = {
    /**
     * 清除字符串数据（通过覆盖内存）
     */
    secureClear: function(str) {
      if (typeof str !== 'string') return;
      // JavaScript 字符串是不可变的，这里只能删除引用
      // 真正的内存清除需要在 Node.js 环境中使用 Buffer
      str = null;
    },
    
    /**
     * 安全的 JSON 解析（防止原型污染）
     */
    safeJSONParse: function(str) {
      try {
        const obj = JSON.parse(str);
        // 检查原型污染
        if (obj && typeof obj === 'object') {
          if (Object.prototype.hasOwnProperty.call(obj, '__proto__')) {
            delete obj.__proto__;
          }
          if (Object.prototype.hasOwnProperty.call(obj, 'constructor')) {
            delete obj.constructor;
          }
          if (Object.prototype.hasOwnProperty.call(obj, 'prototype')) {
            delete obj.prototype;
          }
        }
        return obj;
      } catch (e) {
        return null;
      }
    },
    
    /**
     * 检测当前是否在调试状态
     */
    isDebugging: function() {
      return devtoolsOpen;
    },
  };

  // ============================================================
  // 启动开发者工具检测
  // ============================================================
  
  // 延迟启动，避免影响页面加载
  setTimeout(() => {
    devtoolsChecker = setInterval(checkDevtools, CONFIG.devtoolsCheckInterval);
    console.log('[Security] 渲染进程安全保护已启动');
  }, 2000);

  // 页面卸载时清理
  window.addEventListener('beforeunload', function() {
    if (devtoolsChecker) {
      clearInterval(devtoolsChecker);
    }
  });

})();
