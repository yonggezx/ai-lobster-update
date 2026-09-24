/**
 * 弹层 / 通知栏外观跟随任务栏
 *
 * ⚠️ 这个方案的性质必须说清楚（实测结论，别再走回头路）：
 *   SCA 只能**在窗口后面加一层材质**，**永远无法去掉 XAML 自己画的那层背景**。
 *   所以它的上限是"改背板"，不是"让组件本身变透明"。
 *   要真正纯透明，只有改 XAML（任务栏/开始菜单那条 DLL+TAP 的路）或
 *   关掉窗口级 SystemBackdrop（仅适用于用 DWM 画 Acrylic 的表面）。
 *
 * ── 实测数据 ──────────────────────────────────────────────────────
 *   · 弹层宿主在**没显示**时本来就是纯透明的（与背景像素差 Δ=0.06，均值 243 一样）。
 *     一旦对它下发任何 accent，窗口就被 DWM 合成出来 → 屏幕上凭空多出一块
 *     Δ≈137 的暗色块。**这就是"在相关组件后面加了个背景"的根源。**
 *     ⇒ 必须先用 WindowFromPoint 确认"这块像素真的是它在渲染"才允许下发。
 *
 *   · 已验证的 SCA 取值语义（对真实 XAML 弹层 Xaml_WindowedPopupClass 实测）：
 *       state=2 (TRANSPARENTGRADIENT) + GradientColor 全 0 → **纯透明**，弹层整个消失，
 *       透出背后的画面。
 *       state=3/4 (BLUR/ACRYLICBLUR) → 会加一层材质；GradientColor 的 alpha 就是"额外底色"，
 *       给 0x66 就是凭空加 40% 黑底 —— 绝对不要用非 0 的 alpha。
 *
 *   · 托盘溢出面板 `TopLevelWindowForOverflowXamlIsland` 实测：
 *       它的可见背景是窗口级 DWM SystemBackdrop（ Acrylic ），不是 XAML Background。
 *       对其所有元素 put_Background 透明 → 0 像素变化。
 *       SCA transparent → 凭空加一块暗色背景。
 *       DwmSetWindowAttribute(DWMWA_SYSTEMBACKDROP_TYPE, DWMSBT_NONE) → 直接透壁纸。
 *       ⇒ 该目标走 DWM SystemBackdrop 路径。
 *
 * ── 为什么不能注入（换条路之前先看这段）──────────────────────────────
 * 通知中心 / 右键跳转列表跑在 **ShellExperienceHost.exe**：Low IL + AppContainer，
 * 而且**没显示面板时整个进程是挂起（frozen）的** ——
 * 注入的线程永远不返回。所以注入本身没问题，是目标进程被冻住了。
 * → 要改它的 XAML，得在面板真显示时再试。
 *
 * ── 设计要点 ─────────────────────────────────────────────────────
 * 1. 弹层窗口每次打开都是新 HWND → 必须轮询发现；
 * 2. ★ 只处理"真的在屏幕上渲染"的窗口（WindowFromPoint 抽查过半命中），
 *    否则会把常驻但没显示的宿主窗口合成出一块假背景；
 * 3. 只还原"我们改过的窗口"，绝不碰从未动过的窗口；
 * 4. effect='normal'（默认）时不留任何改动。
 */

const koffi = require('koffi');

const user32 = koffi.load('user32.dll');
const kernel32 = koffi.load('kernel32.dll');
const dwmapi = koffi.load('dwmapi.dll');

// ---------------------------------------------------------------- Win32
// ⚠️ 刻意**不用** EnumWindows：本机实测它枚举不到 Shell_TrayWnd 这类外壳窗口
//    （FindWindowW 能拿到、同桌面、无父窗口、WS_VISIBLE，但 EnumWindows 的 242 个结果里没有它），
//    原因不明且不可依赖。改用按类名的定点枚举：
//    FindWindowExW(NULL, prev, className, NULL) 会遍历**该类的所有顶层窗口**，实测可靠。
const FindWindowExW = user32.func('FindWindowExW', 'void*', ['void*', 'void*', 'str16', 'str16']);
const GetClassNameW = user32.func('GetClassNameW', 'int', ['void*', 'void*', 'int']);
const GetWindowTextW = user32.func('GetWindowTextW', 'int', ['void*', 'void*', 'int']);
const GetWindowThreadProcessId = user32.func('GetWindowThreadProcessId', 'uint32', ['void*', 'uint32*']);
const GetWindowRect = user32.func('GetWindowRect', 'int', ['void*', 'void*']);
const IsWindowVisible = user32.func('IsWindowVisible', 'int', ['void*']);
const IsWindow = user32.func('IsWindow', 'int', ['void*']);
// 判断"这块像素上真的是它在渲染"—— 见文件头第 2 条设计要点
const POINT = koffi.struct('AIL_POINT', { x: 'int32', y: 'int32' });
const WindowFromPoint = user32.func('WindowFromPoint', 'void*', [POINT]);
const GetAncestor = user32.func('GetAncestor', 'void*', ['void*', 'uint32']);
const GetSystemMetrics = user32.func('GetSystemMetrics', 'int', ['int']);
const GA_ROOT = 2;

const OpenProcess = kernel32.func('OpenProcess', 'void*', ['uint32', 'int', 'uint32']);
const QueryFullProcessImageNameW = kernel32.func('QueryFullProcessImageNameW', 'int',
  ['void*', 'uint32', 'void*', 'uint32*']);
const CloseHandle = kernel32.func('CloseHandle', 'int', ['void*']);

// ---------------------------------------------------------------- SCA
const ACCENTPOLICY = koffi.struct('AI_ACCENTPOLICY', {
  AccentState: 'uint32',
  AccentFlags: 'uint32',
  GradientColor: 'uint32',
  AnimationId: 'uint32'
});
const WINCOMPATTRDATA = koffi.struct('AI_WINCOMPATTRDATA', {
  Attribute: 'int32',
  Data: koffi.pointer(ACCENTPOLICY),
  SizeOfData: 'size_t'
});
const SetWindowCompositionAttribute =
  user32.func('SetWindowCompositionAttribute', 'int', ['void*', koffi.pointer(WINCOMPATTRDATA)]);

const WCA_ACCENT_POLICY = 19;
const ACCENT_DISABLED = 0;
const ACCENT_ENABLE_GRADIENT = 1;
const ACCENT_ENABLE_TRANSPARENTGRADIENT = 2;
const ACCENT_ENABLE_BLURBEHIND = 3;
const ACCENT_ENABLE_ACRYLICBLURBEHIND = 4;

/**
 * 效果 → SCA 参数。
 *
 * ★★ GradientColor 的 alpha = 「往组件后面额外抹多少底色」。这里**一律 0x00**。
 *    之前为了绕"面板变白"写成 0x11，那是**在组件后面加了一层 6.7% 黑底** ——
 *    用户看到的"半透明/加了个背景"就是它。透明就该是什么都不加。
 */
const EFFECT_ACCENT = {
  // 纯透明：state 2 + 全 0 ⇒ DWM 什么都不画，弹层整个透过去
  transparent: { state: ACCENT_ENABLE_TRANSPARENTGRADIENT, flags: 0, color: 0x00000000 },
  // 模糊 / 亚克力：同样 alpha=0 —— 只借 DWM 做背景模糊，不加任何底色
  blur: { state: ACCENT_ENABLE_BLURBEHIND, flags: 0, color: 0x00000000 },
  acrylic: { state: ACCENT_ENABLE_ACRYLICBLURBEHIND, flags: 0, color: 0x00000000 },
  // 默认：完全不动它（系统原生）
  normal: { state: ACCENT_DISABLED, flags: 0, color: 0x00000000 }
};

// ---------------------------------------------------------------- DWM SystemBackdrop
const DwmSetWindowAttribute =
  dwmapi.func('DwmSetWindowAttribute', 'long', ['void*', 'int32', 'void*', 'uint32']);
const DwmGetWindowAttribute =
  dwmapi.func('DwmGetWindowAttribute', 'long', ['void*', 'int32', 'void*', 'uint32']);

const DWMWA_SYSTEMBACKDROP_TYPE = 38;
const DWMSBT = {
  auto: 0,        // 系统默认
  none: 1,        // 关掉 → 透出 XAML 内容/壁纸
  mainwindow: 2,  // Mica
  transient: 3,   // Acrylic
  tabbed: 4       // 更深 Acrylic
};
const EFFECT_DWMB = {
  transparent: DWMSBT.none,
  blur: DWMSBT.transient,
  acrylic: DWMSBT.tabbed,
  normal: DWMSBT.auto
};

/**
 * 目标窗口：类名 + 进程 + 处理方式。
 *
 * 实测：
 *   · `Windows.UI.Core.CoreWindow` @ ShellExperienceHost.exe：通知中心 + 跳转列表（靠标题区分）
 *   · `ControlCenterWindow` @ ShellHost.exe：快速设置/WiFi 面板
 *   · `TopLevelWindowForOverflowXamlIsland` @ explorer.exe：托盘溢出面板 → DWM SystemBackdrop
 */
const TARGETS = [
  // 控制中心（通知 + 快速设置）—— 另一条宿主路径，本机存在但未显示面板
  { cls: 'ControlCenterWindow', proc: 'ShellHost.exe', label: '控制中心', method: 'sca', syncKey: 'quicksettings' },
  // ★ 通知中心/跳转列表（CoreWindow @ ShellExperienceHost）已交由 shellFlyoutTap（XAML TAP）
  //   全权管理：AUTOBG 通配符 + 关 DWM backdrop。这里若再对它叠 SCA accent，
  //   面板打开约 200ms 后会被盖上一个合成层 —— 用户看到的"先透明、随后变灰"就是它。
  //   SCA 对这类窗口只会帮倒忙，不再扫描。
  // 托盘溢出面板（"显示隐藏的图标"展开的那块）→ 窗口级 SystemBackdrop
  { cls: 'TopLevelWindowForOverflowXamlIsland', proc: 'explorer.exe', label: '托盘溢出', method: 'dwmb', syncKey: 'overflow' }
];

/**
 * explorer 的通用 XAML 窗口化弹层（`Xaml_WindowedPopupClass`，任务栏右键菜单）。
 *
 * ★★ 2026-09-14 实测（Win11 26200）：**永久禁用**，SCA 对这个弹层只能帮倒忙。
 *   三态对照截图（scripts/probe-taskbar-menu-bg4.js）证明：
 *   · 原生：深色菜单，无灰底；
 *   · SCA state=2 + alpha=0：菜单周围**凭空合成一大块灰底**（用户报的"点击空白区域
 *     透明度异常"就是它）—— 老版本系统"SCA=纯透明"的结论在 26200 上已失效；
 *   · 撤销 accent：恢复原生，无灰底。
 *   同时 TAP 对这个弹层的 XAML 岛**完全不可见**（ENUM 证明，REATTACH 也带不进来），
 *   DWM SystemBackdrop 对它也无效果 —— 即此菜单在 26200 上没有可靠的真实透明通道，
 *   保持系统原生外观是唯一正确解。
 */
let includeExplorerPopups = false;   // 已废弃，恒 false（保留导出兼容旧调用）
/** 已废弃：右键菜单不再做任何透明处理，恒返回 false。 */
function setIncludeExplorerPopups() {
  return false;
}

const POLL_MS = 200;
const PROC_CACHE_MS = 5000;

class ShellSurfaceAccent {
  constructor() {
    this.effect = 'normal';
    this.timer = null;
    /** @type {Map<number, {effect:string, method:string}>} hwnd -> 上次应用的效果+方式 */
    this.applied = new Map();
    /** @type {Map<number, {name:string, t:number}>} pid -> 进程名（带过期） */
    this.procCache = new Map();
    this.stats = {
      scans: 0,
      applied: 0,
      scannedWindows: 0,
      /** 被"真的在显示"闸门拦下的宿主窗口数 */
      skippedNotDisplayed: 0,
      lastError: null
    };
    /** @type {Array<{hwnd:number, cls:string, reason:string}>} 最近一次扫描被跳过的窗口及原因 */
    this.lastRejects = [];
    // ★ 二级独立开关：每个弹层目标单独决定是否跟随任务栏效果（main 进程从配置读入）
    this.targetSync = {};
  }

  _syncKey(target) {
    return target.syncKey || target.cls;
  }

  isSyncEnabled(target) {
    return this.targetSync[this._syncKey(target)] !== false;
  }

  /**
   * 更新每个弹层目标的「同步任务栏效果」开关。
   * 关掉的目标在下一轮 syncOnce 里按 normal 处理（已改过的窗口会被还原）。
   * 注：右键菜单（Xaml_WindowedPopupClass）已永久退出 SCA 管理 —— 见文件内
   * setIncludeExplorerPopups 注释（26200 上 SCA 会合成灰底）。
   * @param {{notification?:boolean, overflow?:boolean, quicksettings?:boolean}} map
   */
  setTargetSync(map) {
    let changed = false;
    for (const key of ['notification', 'overflow', 'quicksettings']) {
      const want = !(map && map[key] === false);
      if (this.targetSync[key] !== want) {
        this.targetSync[key] = want;
        changed = true;
      }
    }
    if (changed && this.applied.size) this.syncOnce();   // 有在管的窗口 → 立刻按新开关重评
  }

  // ------------------------------------------------------------ 进程名
  procName(pid) {
    const hit = this.procCache.get(pid);
    const now = Date.now();
    if (hit && now - hit.t < PROC_CACHE_MS) return hit.name;

    let name = null;
    const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
    const h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
    if (h) {
      try {
        const buf = Buffer.alloc(1024);
        const size = Buffer.alloc(4);
        size.writeUInt32LE(512, 0);
        if (QueryFullProcessImageNameW(h, 0, buf, size)) {
          const full = buf.toString('utf16le').split('\0')[0];
          name = full.split('\\').pop();
        }
      } catch (e) { /* ignore */ }
      CloseHandle(h);
    }
    this.procCache.set(pid, { name, t: now });
    return name;
  }

  // ------------------------------------------------------------ 窗口枚举
  enumByClass(cls) {
    const out = [];
    let prev = null;
    try {
      for (let i = 0; i < 128; i++) {
        const h = FindWindowExW(null, prev, cls, null);
        if (!h) break;
        const n = Number(h);
        if (!n) break;
        out.push(n);
        prev = h;
      }
    } catch (e) {
      this.stats.lastError = e.message;
    }
    return out;
  }

  /**
   * ★ 这块像素上真的是它在渲染吗？
   * 判据：在窗口矩形里抽查若干点，用 WindowFromPoint 看最上层窗口是不是它（或它的根）。
   */
  probeDisplayed(hwnd, r) {
    const probes = [[0.3, 0.2], [0.7, 0.2], [0.5, 0.5], [0.3, 0.8], [0.7, 0.8]];
    const sw = GetSystemMetrics(0);
    const sh = GetSystemMetrics(1);
    let hit = 0;
    let n = 0;
    let topCls = '';
    const clsBuf = Buffer.alloc(256);
    for (const [fx, fy] of probes) {
      const x = Math.round(r.left + r.w * fx);
      const y = Math.round(r.top + r.h * fy);
      if (x < 0 || y < 0 || x >= sw || y >= sh) continue;
      let top;
      try {
        top = WindowFromPoint({ x, y });
      } catch (e) { continue; }
      if (!top) continue;
      n++;
      const tn = Number(top);
      if (tn === hwnd) { hit++; continue; }
      const root = Number(GetAncestor(top, GA_ROOT));
      if (root === hwnd) { hit++; continue; }
      if (!topCls) {
        try {
          const k = GetClassNameW(top, clsBuf, 255);
          topCls = k > 0 ? clsBuf.toString('utf16le', 0, k * 2) : '?';
        } catch (e) { topCls = '?'; }
      }
    }
    return { ok: n >= 3 && hit * 2 >= n, hit, n, topCls };
  }

  /**
   * 找出当前所有匹配且**真的在显示**的目标窗口。
   */
  findTargets() {
    const out = [];
    const txtBuf = Buffer.alloc(512);
    const pidBuf = Buffer.alloc(4);
    const rectBuf = Buffer.alloc(16);
    const rejects = [];
    const reject = (hwnd, cls, reason) => {
      if (rejects.length < 25) rejects.push({ hwnd, cls, reason });
    };

    for (const target of TARGETS) {
      for (const hwnd of this.enumByClass(target.cls)) {
        try {
          this.stats.scannedWindows++;
          if (!IsWindowVisible(hwnd)) {
            reject(hwnd, target.cls, 'IsWindowVisible=false');
            continue;
          }

          GetWindowThreadProcessId(hwnd, pidBuf);
          const pid = pidBuf.readUInt32LE(0);
          const pn = this.procName(pid);
          if (pn !== target.proc) {
            reject(hwnd, target.cls, `进程不符(${pn} != ${target.proc})`);
            continue;
          }

          GetWindowRect(hwnd, rectBuf);
          const left = rectBuf.readInt32LE(0);
          const top = rectBuf.readInt32LE(4);
          const w = rectBuf.readInt32LE(8) - left;
          const h = rectBuf.readInt32LE(12) - top;
          if (w < 32 || h < 32) {
            reject(hwnd, target.cls, `太小(${w}x${h})`);
            continue;
          }

          const probe = this.probeDisplayed(hwnd, { left, top, w, h });
          if (!probe.ok) {
            this.stats.skippedNotDisplayed++;
            reject(hwnd, target.cls,
              `没在显示(命中${probe.hit}/${probe.n} 最上层=${probe.topCls})`);
            continue;
          }

          const tn = GetWindowTextW(hwnd, txtBuf, 255);
          const title = tn > 0 ? txtBuf.toString('utf16le', 0, tn * 2) : '';
          const label = title || target.label;

          out.push({
            hwnd, cls: target.cls, pid, label, w, h, title,
            method: target.method || 'sca',
            syncKey: this._syncKey(target),
            syncEnabled: this.isSyncEnabled(target)
          });
        } catch (e) { /* 单个窗口出错不影响整体 */ }
      }
    }
    this.lastRejects = rejects;
    return out;
  }

  // ------------------------------------------------------------ 应用
  /**
   * 对单个窗口下发 SCA accent。
   */
  applySca(hwnd, effect) {
    const cfg = EFFECT_ACCENT[effect] || EFFECT_ACCENT.normal;
    const policy = {
      AccentState: cfg.state,
      AccentFlags: cfg.flags,
      GradientColor: cfg.color,
      AnimationId: 0
    };
    const data = {
      Attribute: WCA_ACCENT_POLICY,
      Data: policy,
      SizeOfData: koffi.sizeof(ACCENTPOLICY)
    };
    try {
      return !!SetWindowCompositionAttribute(hwnd, data);
    } catch (e) {
      this.stats.lastError = e.message;
      return false;
    }
  }

  /**
   * 对单个窗口设置 DWM SystemBackdrop 类型。
   */
  applyDwmb(hwnd, effect) {
    const val = (effect === 'normal')
      ? DWMSBT.auto
      : (EFFECT_DWMB[effect] !== undefined ? EFFECT_DWMB[effect] : DWMSBT.auto);
    const buf = Buffer.alloc(4);
    buf.writeInt32LE(val, 0);
    try {
      const hr = DwmSetWindowAttribute(hwnd, DWMWA_SYSTEMBACKDROP_TYPE, buf, 4);
      return hr === 0;
    } catch (e) {
      this.stats.lastError = e.message;
      return false;
    }
  }

  /**
   * 统一入口：按 method 选择 SCA 或 DWM SystemBackdrop。
   */
  applyOne(hwnd, effect, method) {
    if (method === 'dwmb') return this.applyDwmb(hwnd, effect);
    return this.applySca(hwnd, effect);
  }

  /**
   * 扫一遍所有目标窗口，把外观对齐到 this.effect。
   */
  syncOnce() {
    this.stats.scans++;
    const effect = this.effect;
    let targets = [];
    try {
      targets = this.findTargets();
    } catch (e) {
      this.stats.lastError = e.message;
      return [];
    }

    const alive = new Set();
    for (const t of targets) {
      alive.add(t.hwnd);
      // ★ 二级独立开关：未开启同步的目标按 normal 处理（还原已改的窗口，不再套新效果）
      const eff = (effect !== 'normal' && t.syncEnabled !== false) ? effect : 'normal';
      const prev = this.applied.get(t.hwnd);
      const method = t.method || 'sca';

      if (eff === 'normal') {
        if (!prev) continue;
        if (prev.effect === 'normal') { this.applied.delete(t.hwnd); continue; }
        const restoreMethod = prev.method || method;
        if (this.applyOne(t.hwnd, 'normal', restoreMethod)) {
          this.applied.delete(t.hwnd);
        }
        continue;
      }

      if (prev && prev.effect === eff && prev.method === method) continue;
      if (this.applyOne(t.hwnd, eff, method)) {
        this.applied.set(t.hwnd, { effect: eff, method });
        this.stats.applied++;
      }
    }

    // 清理已销毁的窗口记录
    for (const hwnd of [...this.applied.keys()]) {
      if (!alive.has(hwnd)) this.applied.delete(hwnd);
    }
    return targets;
  }

  /**
   * 设置目标效果并立即同步一次。
   * @param {'transparent'|'blur'|'acrylic'|'normal'} effect
   */
  setEffect(effect) {
    const valid = Object.prototype.hasOwnProperty.call(EFFECT_ACCENT, effect) ? effect : 'normal';
    if (valid !== this.effect) {
      const prevEffect = this.effect;
      this.effect = valid;
      // 把已应用的记录降级为"待重应用"
      for (const [hwnd, rec] of this.applied) {
        if (rec.effect === prevEffect) this.applied.set(hwnd, { ...rec, effect: '__stale__' });
      }
    }
    return this.syncOnce();
  }

  /** 开始轮询（弹层窗口每次打开都是新 HWND，必须持续发现） */
  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      try {
        this.syncOnce();
        if (this.effect === 'normal' && this.applied.size === 0) this.stop();
      } catch (e) { this.stats.lastError = e.message; }
    }, POLL_MS);
    if (this.timer.unref) this.timer.unref();
  }

  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  /** 停止轮询并把所有改过的窗口还原为系统原生 */
  restoreAll() {
    this.effect = 'normal';
    this.stop();
    const list = [...this.applied.entries()];
    for (const [hwnd, rec] of list) {
      if (IsWindow(hwnd)) this.applyOne(hwnd, 'normal', rec.method || 'sca');
    }
    this.applied.clear();
    return list.length;
  }

  getStatus() {
    return {
      effect: this.effect,
      polling: !!this.timer,
      tracked: this.applied.size,
      includeExplorerPopups,
      stats: { ...this.stats }
    };
  }
}

module.exports = new ShellSurfaceAccent();
module.exports.ShellSurfaceAccent = ShellSurfaceAccent;
module.exports.TARGETS = TARGETS;
module.exports.EFFECT_ACCENT = EFFECT_ACCENT;
module.exports.setIncludeExplorerPopups = setIncludeExplorerPopups;
