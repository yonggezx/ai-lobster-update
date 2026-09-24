/**
 * 诊断日志（性能监控专用，2026-09-14）
 *
 * 目的：定位"弹层/切换异常卡顿"还剩多少、卡在哪一步。
 * 记录三类事件，全部带耗时：
 *   · inject          —— 远程线程注入（含 300ms 等待结果）
 *   · applyOne        —— 单个弹层目标的一轮应用/还原（含状态变化）
 *   · syncRound       —— 整轮轮询总耗时（只在慢的时候记，避免刷屏）
 *   · cmd             —— 通道命令（AUTOBG/BGTRANSPARENT/BGRESTORE，>300ms 或超时才记）
 *   · dllStatus       —— DLL 端 AUTOBG 状态回读（含宿主端累计耗时 bgCostMs）
 *
 * 输出：%LOCALAPPDATA%\AIL\diag\diag-YYYY-MM-DD.log（一行一条 JSON）
 * 特点：
 *   · 只写内存 + appendFileSync，无网络、无 IPC，异常时静默丢弃（绝不影响主流程）；
 *   · 超过 2MB 轮转成 .old；
 *   · 调用方多为热路径（每 1.5s 轮询），所以模块内提供 slow() 只在超过阈值时落盘。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const MAX_LOG_BYTES = 2 * 1024 * 1024;

function diagDir() {
  const base = process.env.LOCALAPPDATA || os.homedir();
  return path.join(base, 'AIL', 'diag');
}

function diagFile() {
  const d = new Date();
  const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return path.join(diagDir(), `diag-${ymd}.log`);
}

/** 高精度毫秒（process.hrtime 包装，调用方 t0 = nowMs()） */
function nowMs() {
  const t = process.hrtime.bigint();
  return Number(t) / 1e6;   // 返回浮点毫秒，相减即耗时
}

/** 写一条事件。fields 为附加字段对象；写失败静默（诊断绝不拖垮主流程） */
function event(name, fields) {
  try {
    const dir = diagDir();
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const file = diagFile();
    try {
      // 轮转：>2MB 改名 .old（同一天多次轮转覆盖旧 .old，可接受）
      if (fs.existsSync(file) && fs.statSync(file).size > MAX_LOG_BYTES) {
        try { fs.unlinkSync(file + '.old'); } catch (e) { /* ignore */ }
        fs.renameSync(file, file + '.old');
      }
    } catch (e) { /* 轮转失败不影响写入 */ }
    const rec = Object.assign({ t: new Date().toISOString(), ev: name }, fields || {});
    fs.appendFileSync(file, JSON.stringify(rec) + '\n', 'utf8');
  } catch (e) { /* ignore */ }
}

/** 只在耗时 >= thresholdMs 时才记录（热路径用这个，避免日志刷屏） */
function slow(name, t0, thresholdMs, fields) {
  const ms = nowMs() - t0;
  if (ms >= thresholdMs) event(name, Object.assign({ ms: Math.round(ms) }, fields || {}));
  return ms;
}

module.exports = { event, slow, nowMs, diagDir };
