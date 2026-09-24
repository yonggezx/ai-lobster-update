/**
 * 崩溃兜底（crash guard）
 * ------------------------------------------------------------
 * 解决的问题（2026-09-23 实测事故）：
 *   应用从 .bat 启动后控制台被关/管道断开 → stdout 断管（EPIPE）。
 *   此时 agent 会话里任何一句 console.log 都会**同步抛 EPIPE**，
 *   而 uncaughtException 处理器又调用 console.error → 再抛 → 再进处理器……
 *   同步无限递归，每层还 writeFileSync 一个错误文件：
 *   ~900 次/秒 × 5 分钟 = 26 万个 error_*.log，主进程 100% CPU → **鼠标异常卡顿**。
 *
 * 两道防线：
 *   1) stdout/stderr 挂 error 监听 → 断管静默，EPIPE 不再升级成 uncaughtException；
 *   2) 异常落盘**限流 + 去重**（同种错误 30s 一次、任何错误 1s 一次，均可注入覆盖），
 *      且处理器整体 try/catch —— 处理函数自身绝不抛。
 */
const fs = require('fs');
const path = require('path');

function installCrashGuard(options = {}) {
  const logsPath = options.logsPath || null;
  const minIntervalMs = options.minIntervalMs != null ? options.minIntervalMs : 1000;
  const sameKeyIntervalMs = options.sameKeyIntervalMs != null ? options.sameKeyIntervalMs : 30000;
  const log = options.log || console;
  const writeLog = options.writeLog !== false;

  let lastAt = 0;
  let lastKey = '';
  let suppressed = 0;

  // ---- 防线 1：断管的控制台不许再抛 ----
  for (const key of ['stdout', 'stderr']) {
    const s = process[key];
    if (s && typeof s.on === 'function') {
      try { s.on('error', () => { /* 断管就静默：日志不能害死应用 */ }); } catch (e) { /* 忽略 */ }
    }
  }

  function shouldWrite(key, now) {
    if (key === lastKey && now - lastAt < sameKeyIntervalMs) { suppressed++; return false; }
    if (now - lastAt < minIntervalMs) { suppressed++; return false; }
    return true;
  }

  // ---- 防线 2：异常落盘（限流 + 去重，自身零抛出）----
  process.on('uncaughtException', (err) => {
    try {
      const now = Date.now();
      const key = String((err && (err.stack || err.message)) || err).split('\n').slice(0, 2).join('|');
      if (!shouldWrite(key, now)) return;
      lastKey = key;
      lastAt = now;
      try { log.error ? log.error('Uncaught Exception:', err) : null; } catch (e) { /* 控制台可能已断 */ }
      if (!writeLog || !logsPath) return;
      try {
        fs.mkdirSync(logsPath, { recursive: true });
        fs.appendFileSync(path.join(logsPath, 'error_' + now + '.log'), new Date(now).toISOString() + '\n' + ((err && err.stack) || String(err)) + '\n');
      } catch (e) { /* 磁盘也失败就放弃 */ }
    } catch (e) { /* 处理器绝不抛 */ }
  });

  process.on('unhandledRejection', (reason) => {
    try { log.error ? log.error('Unhandled Rejection:', reason) : null; } catch (e) { /* 控制台可能已断 */ }
  });

  return {
    getState: () => ({ lastAt, lastKey, suppressed })
  };
}

module.exports = { installCrashGuard };
