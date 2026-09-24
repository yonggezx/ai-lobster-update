/**
 * 任务栏外观 —— **系统级**配置（本机唯一安全可用的路径）
 *
 * ⚠️ 历史与边界（2026-09-12 实测，不要重复踩）：
 *   本文件过去用 SetWindowCompositionAttribute + 若干注册表写入来做"任务栏透明化"。
 *   在 Windows 11 build 26200 上逐项实测的结论是：
 *     · 进程外调 SCA：只有「不透明纯色」生效（ACCENT_ENABLE_GRADIENT），
 *       alpha 被完全忽略，TRANSPARENTGRADIENT 完全无效，BLURBEHIND/ACRYLIC 变近黑；
 *     · 在 explorer 进程内 hook 并改写 shell 自己的 accent → **explorer 崩溃重启**；
 *     · `UseOLEDTaskbarTransparency`(HKLM) / `TaskbarAcrylicOpacity`(HKCU) 是**本机不存在的值**，
 *       写了没有任何效果，只会在用户注册表里留垃圾（本机那个 =0 就是历史残留）。
 *   ⇒ 所以本模块现在只做两件事：
 *       1) 开关**系统自带**的「透明效果」（设置 > 个性化 > 颜色）；
 *       2) 清理历史版本留下的注册表垃圾。
 *   真正的"追平 TranslucentTB"需要 ExplorerTAP（XAML 视觉树 + 自绘 Direct2D 模糊），是独立工程。
 */

const { HKEY, readDword, writeDword, deleteValue } = require('./winreg');

// ---- 注册表位置 ----
const THEMES_PERSONALIZE = 'SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize';
const EXPLORER_ADVANCED = 'SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced';

// 历史版本写坏/写空的值 —— 只用于清理
const LEGACY_VALUES = [
  { root: HKEY.CURRENT_USER, subKey: EXPLORER_ADVANCED, name: 'TaskbarAcrylicOpacity' },
  { root: HKEY.LOCAL_MACHINE, subKey: EXPLORER_ADVANCED, name: 'UseOLEDTaskbarTransparency' },
];

// ---- user32：广播"设置已变更" ----
let user32 = null;
let SendMessageTimeoutW = null;
try {
  const koffi = require('koffi');
  user32 = koffi.load('user32.dll');
  SendMessageTimeoutW = user32.func('SendMessageTimeoutW', 'intptr',
    ['void*', 'uint32', 'intptr', 'intptr', 'uint32', 'uint32', 'void*']);
} catch (e) {
  // 非 Windows 或加载失败：广播静默降级
}

const HWND_BROADCAST = 0xffff;
const WM_SETTINGCHANGE = 0x001a;
const WM_THEMECHANGED = 0x031a;
const SMTO_ABORTIFHUNG = 0x0002;

/**
 * 广播"系统设置已变更"，让已打开的窗口尽量响应。
 * 实测：这**不会**让任务栏即时切换透明效果（仍需注销/重登），这里发只是为了尽力而为。
 */
function broadcastSettingsChanged() {
  if (!SendMessageTimeoutW) return false;
  try {
    const msg = Buffer.from('ImmersiveColorSet\0', 'utf16le');
    SendMessageTimeoutW(HWND_BROADCAST, WM_SETTINGCHANGE, 0,
      require('koffi').address(msg), SMTO_ABORTIFHUNG, 1000, null);
    SendMessageTimeoutW(HWND_BROADCAST, WM_THEMECHANGED, 0, 0,
      SMTO_ABORTIFHUNG, 1000, null);
    return true;
  } catch (e) {
    return false;
  }
}

/** 读取系统「透明效果」开关：true/false；读不到返回 null */
function getEnableTransparency() {
  const v = readDword(HKEY.CURRENT_USER, THEMES_PERSONALIZE, 'EnableTransparency');
  return v === null ? null : v !== 0;
}

/**
 * 设置系统「透明效果」。
 * 返回 { ok, liveApplied, note } —— **如实告知**：该值由 explorer/主题在登录时读取，
 * 运行中改动不会即时生效。
 */
function setEnableTransparency(enabled) {
  const res = writeDword(HKEY.CURRENT_USER, THEMES_PERSONALIZE, 'EnableTransparency', enabled ? 1 : 0);
  if (!res.ok) return { ok: false, error: res.error };
  broadcastSettingsChanged();
  return {
    ok: true,
    liveApplied: false,
    note: '已写入设置。Windows 在会话登录时读取该值，需要注销/重新登录（不是重启资源管理器）才会看到变化。',
  };
}

/** 列出历史残留值（存在的才列出） */
function getLegacyLeftovers() {
  const found = [];
  for (const v of LEGACY_VALUES) {
    const val = readDword(v.root, v.subKey, v.name);
    if (val !== null) found.push({ ...v, value: val, hive: v.root === HKEY.CURRENT_USER ? 'HKCU' : 'HKLM' });
  }
  return found;
}

/** 删除历史残留值（幂等） */
function cleanupLegacyRegistry() {
  const results = [];
  for (const v of LEGACY_VALUES) {
    const before = readDword(v.root, v.subKey, v.name);
    if (before === null) {
      results.push({ name: v.name, hive: v.root === HKEY.CURRENT_USER ? 'HKCU' : 'HKLM', changed: false, reason: '本来就不存在' });
      continue;
    }
    const d = deleteValue(v.root, v.subKey, v.name);
    results.push({
      name: v.name,
      hive: v.root === HKEY.CURRENT_USER ? 'HKCU' : 'HKLM',
      changed: d.ok,
      reason: d.ok ? `已删除（原值 ${before}）` : d.error,
    });
  }
  return results;
}

/**
 * 汇总状态。capabilities 是**如实**的能力声明，供 UI 展示，不要美化。
 */
function getState() {
  return {
    supported: process.platform === 'win32',
    enableTransparency: getEnableTransparency(),
    legacyLeftovers: getLegacyLeftovers(),
    capabilities: {
      // 这些是实测结论，UI 直接展示，不要写成"即将支持"
      accentRewrite: false,      // 进程内改写 accent → 崩 explorer，已禁用
      liveApply: false,          // 改系统透明效果需要注销/重登
      needsExplorerRestart: false, // 本模块任何操作都不需要重启资源管理器
    },
  };
}

module.exports = {
  getEnableTransparency,
  setEnableTransparency,
  broadcastSettingsChanged,
  getLegacyLeftovers,
  cleanupLegacyRegistry,
  getState,
  THEMES_PERSONALIZE,
  EXPLORER_ADVANCED,
};
