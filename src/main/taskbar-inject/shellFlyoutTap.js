/**
 * 额外弹层的 XAML TAP 客户端：托盘溢出区 + 快速设置（WiFi）
 *
 * ── 为什么单独一个模块 ────────────────────────────────────────────────
 * 任务栏（tapClient）和开始菜单（startMenuClient）各有自己的宿主；这里的两个目标
 * 宿主又不一样，且**通信方式不同**，所以单列：
 *
 *   1) 托盘溢出区（点任务栏 ^ 展开的隐藏图标面板）
 *        窗口 TopLevelWindowForOverflowXamlIsland @ explorer.exe
 *        → 注入 aiLobsterTap_tray.dll，走**命名管道**
 *   2) 快速设置 / WiFi 弹窗
 *        窗口 ControlCenterWindow @ ShellHost.exe
 *        → 注入 aiLobsterTap_cc.dll，走**文件通道**
 *           （ShellHost 虽然是 Medium IL，但实测 CreateNamedPipe 必失败）
 *
 * ── 为什么必须是 XAML 改写 ────────────────────────────────────────────
 * 进程外 SCA / DWM SystemBackdrop 对这两个目标都做不出"看到壁纸"的真透明
 * （shellSurfaceAccent.js 里那两条路的上限是"改背板"，实测：
 *  溢出面板 put_Background 无效、SCA 反而凭空加暗色块）。
 * 只有 XAML TAP 附着后在视觉树回调里换掉背景画刷才真透明。
 *
 * ── 效果语义 ─────────────────────────────────────────────────────────
 *   'transparent' → 把背景板换成透明画刷
 *   其它值        → 还原成系统原生（BGRESTORE）
 * （模糊/亚克力这两个目标暂无实现：需要换 AcrylicBrush，属后续增强。）
 *
 * ── 部署要点 ─────────────────────────────────────────────────────────
 *   · DLL 必须在**纯 ASCII 且非 asar** 的目录里（中文项目路径 + app.asar 都不行）；
 *   · 文件通道以 **DLL 所在目录**为根（cmd/resp 两个固定文件名），
 *     所以两个变体必须放在**不同目录**，否则同一个目录里会互相抢命令；
 *   · ShellHost 会被系统按需拉起/回收 → 必须常驻轮询补注入。
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const koffi = require('koffi');
const { createPipeClient } = require('./pipeClient');
const diag = require('./diagLog');

// ---------------------------------------------------------------- 关闭窗口级 DWM SystemBackdrop
// ⚠️ 这一条是**必需**的，不是可选项：这两个弹层的"可见背景"其实主要不是 XAML 画出来的，
//    而是窗口级 DWM SystemBackdrop（Acrylic）。
//    只把 XAML 元素的 Background 改透明 → **只剩一层灰**（实测：控制中心、托盘溢出面板都如此），
//    表现为用户说的"改不动 / 没变化"。必须把它一起关掉才真的透出壁纸。
const user32k = koffi.load('user32.dll');
const dwmapi = koffi.load('dwmapi.dll');
const FindWindowW = user32k.func('FindWindowW', 'void*', ['str16', 'str16']);
const FindWindowExW = user32k.func('FindWindowExW', 'void*', ['void*', 'void*', 'str16', 'str16']);
const GetWindowTextW = user32k.func('GetWindowTextW', 'int', ['void*', 'void*', 'int']);
const DwmSetWindowAttribute = dwmapi.func('DwmSetWindowAttribute', 'long',
  ['void*', 'int32', 'void*', 'uint32']);
const DWMWA_SYSTEMBACKDROP_TYPE = 38;
const DWMSBT_NONE = 1;        // 关掉 → 透出下层内容
const DWMSBT_AUTO = 0;        // 系统默认（还原用）

const TAP_PIPE_PREFIX = 'AI_Lobster_Tray';

// 变体 DLL 名（与 compile-tap-variants.bat 的产物名一致）
const DLL_OVERFLOW = 'aiLobsterTap_tray.dll';
const DLL_QUICKSETTINGS = 'aiLobsterTap_cc.dll';

/** 部署根目录：%LOCALAPPDATA%\AIL（纯 ASCII，且用户可写） */
function deployRoot() {
  const base = process.env.LOCALAPPDATA || os.homedir();
  return path.join(base, 'AIL');
}

/**
 * ShellExperienceHost 的包本地目录。
 *
 * ⚠️ 这个宿主是 **AppContainer**：它读不到 `%LOCALAPPDATA%\AIL\...` 这种普通目录，
 *    必须把 DLL 放进**它自己包的可读目录**（LocalCache\Local 下），否则 LoadLibrary 直接失败
 *    （模块数不变、也没有任何日志，非常难查）。文件通道也以这个目录为根。
 */
function shellExperienceHostDir() {
  const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(base, 'Packages',
    'Microsoft.Windows.ShellExperienceHost_cw5n1h2txyewy', 'LocalCache', 'Local', 'AIL');
}

const TARGETS = [
  {
    key: 'notification',
    label: '通知中心/跳转列表',
    proc: 'ShellExperienceHost.exe',
    // 与 explorer 的任务栏模块是**同一个变体**（默认名单 = 通知中心/跳转列表元素）
    dll: 'aiLobsterTap.dll',
    dir: shellExperienceHostDir(),
    channel: 'file',
    // 通知中心走老路（AUTOBG）：它每次打开都会**重建视觉树**，Add 回调必然出现，
    // 所以那条路本来就可靠；而且它的窗口类 Windows.UI.Core.CoreWindow 是共享的
    // （通知中心 + 各种跳转列表都在用），按类名去关 DWM backdrop 容易误伤别的窗口 → 用标题筛。
    useAutoBg: true,
    titleRe: /(通知中心|跳转列表)/,
    // 宿主短命：还原时直接结束它让系统重拉（比 XAML 回滚可靠，见 applyOne 注释）
    canRestartHost: true
  },
  {
    key: 'overflow',
    label: '托盘溢出区',
    proc: 'explorer.exe',
    dll: DLL_OVERFLOW,
    // 溢出区宿主是 explorer，管道可用 → 走命名管道（比文件通道更可靠）
    dir: path.join(deployRoot(), 'overflow'),
    channel: 'pipe',
    // 关 DWM backdrop 用的窗口类名（必填才能真透明，见文件头注释）
    cls: 'TopLevelWindowForOverflowXamlIsland',
    // 用 BGTRANSPARENT 逐个打透的元素（比 AUTOBG 可靠：经 UI 线程封送立即生效）
    names: ['OverflowFlyoutBackgroundBorder', 'OverflowRootGrid']
  },
  {
    key: 'quicksettings',
    label: '快速设置/WiFi',
    proc: 'ShellHost.exe',
    dll: DLL_QUICKSETTINGS,
    // ★ 文件通道根目录 = 这里（DLL 与 cmd/resp 三个文件同目录）
    dir: path.join(deployRoot(), 'quicksettings'),
    channel: 'file',
    cls: 'ControlCenterWindow',
    // 宿主短命：还原时直接结束它让系统重拉
    canRestartHost: true,
    names: ['RootGrid', 'RootContent', 'ControlCenterRegion', 'ControlCenterView']
  }
];

const POLL_MS = 1500;
const FILE_CMD_TIMEOUT = 4000;

// ---------------------------------------------------------------- 文件通道
/**
 * 与目标目录里的 ail_popup_cmd.txt / ail_popup_resp.txt 通信。
 *
 * ⚠️ 判"新响应到了"不能靠 mtime/size 变化：模块每次都是 CREATE_ALWAYS 重写 resp，
 *    两次响应的长度可能完全相同、mtime 又可能因为文件系统时间戳粒度看不到变化，
 *    于是"响应已经到了"会被判成"还没来"（实测踩过，表现为偶尔超时）。
 *    可靠做法：**发命令前先把 resp 删掉**（模块不依赖旧文件），
 *    这样"resp 文件重新出现"就是确定的完成信号。
 */
async function fileCmd(dir, cmd, timeout = FILE_CMD_TIMEOUT) {
  const cmdPath = path.join(dir, 'ail_popup_cmd.txt');
  const respPath = path.join(dir, 'ail_popup_resp.txt');
  // ⚠️ 两套计时各司其职，**绝不能混用**（踩过：hrtime 浮点喂给 Date.now() 相减，
  //    差值恒为巨大负数 → 等待循环一次都不跑，所有命令瞬间"假超时"，
  //    文件通道整个瘫痪 —— 表现为"不卡了但效果迟迟不来"）：
  //    · 循环超时判断用 Date.now()（epoch 毫秒）
  //    · 诊断耗时用 diag.nowMs()（hrtime，只做相减）
  const t0 = Date.now();
  const td0 = diag.nowMs();

  // 发命令前先把 resp 删掉（模块不依赖旧文件），
  // 这样"resp 文件重新出现"就是确定的完成信号。
  try {
    fs.mkdirSync(dir, { recursive: true });
    try { fs.unlinkSync(respPath); } catch (e) { /* 本来就没有也正常 */ }
    // 命令内容一定带上唯一后缀：模块是按"cmd 内容变了"来触发的
    fs.writeFileSync(cmdPath, `${cmd}\n# ${Date.now()}${String(process.hrtime.bigint() % 1000n)}\n`, 'utf8');
  } catch (e) {
    diag.event('cmd', { ch: 'file', cmd, ms: 0, result: 'write-failed' });
    return null;
  }

  while (Date.now() - t0 < timeout) {
    await new Promise((r) => setTimeout(r, 70));
    if (!fs.existsSync(respPath)) continue;
    const txt = (() => { try { return fs.readFileSync(respPath, 'utf8'); } catch (e) { return null; } })();
    if (!txt) continue;
    // 等 100ms 再读一次，确认已经写完整（响应可能是多行的）
    await new Promise((r) => setTimeout(r, 100));
    const txt2 = (() => { try { return fs.readFileSync(respPath, 'utf8'); } catch (e) { return null; } })();
    const resp = (txt2 || txt).trim();
    // 诊断：通道命令超过 300ms 或超时才记录（超时 = 宿主冻结/命令没到，是卡顿线索）
    const ms = Math.round(diag.nowMs() - td0);
    if (!resp || ms >= 300) {
      diag.event('cmd', { ch: 'file', cmd, ms, result: resp ? 'ok' : 'empty', resp: resp ? resp.split('\n')[0].slice(0, 120) : null });
    }
    return resp;
  }
  diag.event('cmd', { ch: 'file', cmd, ms: Math.round(diag.nowMs() - td0), result: 'timeout' });
  return null;
}

class ShellFlyoutTap {
  constructor() {
    this.effect = 'normal';
    this.timer = null;
    this._injector = null;
    this.pipe = createPipeClient(TAP_PIPE_PREFIX);
    /** @type {Map<string, {pid:number|null, dllPath:string|null, deployed:boolean, applied:string|null, lastError:string|null}>} */
    this.state = new Map();
    for (const t of TARGETS) {
      this.state.set(t.key, {
        pid: null, dllPath: null, deployed: false, applied: null, lastError: null, lastCmd: null
      });
    }
    this.stats = { syncs: 0, injections: 0, applies: 0, restores: 0, errors: 0 };
    // ★ 二级独立开关：每个弹层目标单独决定是否跟随任务栏效果（main 进程从配置读入）。
    //   关掉的目标会被还原为系统原生，并且不再注入/改写（见 applyOne）。
    this.targetSync = { notification: true, overflow: true, quicksettings: true };
  }

  /** 某个弹层目标的同步开关是否开启（默认开） */
  isSyncEnabled(key) {
    return this.targetSync[key] !== false;
  }

  /**
   * 更新每个目标的「同步任务栏效果」开关。
   * 关掉的目标立即还原为系统原生；打开的目标按当前 effect 重新应用。
   * @param {{notification?:boolean, overflow?:boolean, quicksettings?:boolean}} map
   */
  async setTargetSync(map) {
    let changed = false;
    for (const t of TARGETS) {
      const want = !(map && map[t.key] === false);
      if (this.targetSync[t.key] !== want) {
        this.targetSync[t.key] = want;
        changed = true;
      }
    }
    if (changed) {
      // 开关状态变了 → 所有目标的"已应用"记录作废，重新评估（该还原的还原、该应用的应用）
      for (const st of this.state.values()) st.applied = null;
      const t0 = diag.nowMs();
      const out = await this.syncOnce();
      // 用户切二级开关也是关键路径，全记
      diag.event('setTargetSync', { map: JSON.stringify(map), ms: Math.round(diag.nowMs() - t0), results: out.map(o => `${o.key}:${o.ok ? 'ok' : 'pend'}`).join(' ') });
      return out;
    }
    return [];
  }

  _getInjector() {
    if (!this._injector) this._injector = require('./genericInjector');
    return this._injector;
  }

  // ------------------------------------------------------------ 部署
  /**
   * 把变体 DLL 部署到纯 ASCII 的目标目录（打包后在 app.asar 内 / 路径含中文时必需）。
   * 返回可加载的最终路径；失败返回 null。
   */
  deployOne(target) {
    const st = this.state.get(target.key);
    if (st.dllPath && fs.existsSync(st.dllPath)) return st.dllPath;

    const src = path.join(__dirname, target.dll);
    const dst = path.join(target.dir, target.dll);
    try {
      fs.mkdirSync(target.dir, { recursive: true });
      const needCopy = !fs.existsSync(dst) ||
        fs.statSync(dst).size !== fs.statSync(src).size ||
        fs.statSync(dst).mtimeMs < fs.statSync(src).mtimeMs;
      if (needCopy) {
        try {
          fs.copyFileSync(src, dst);
        } catch (e) {
          // 目标被占用（宿主正加载着这个 DLL）→ **退回用现有文件继续**，
          // 别让整个效果因此失败：旧版本通常同样能干活，
          // 真要更新就等宿主重启（届时它自己会释放）。
          if (fs.existsSync(dst)) {
            console.warn(`[ShellFlyoutTap] ${target.label}：DLL 更新被占用，沿用现有副本`);
            st.dllPath = dst;
            st.deployed = true;
            return dst;
          }
          throw e;
        }
      }
      st.dllPath = dst;
      st.deployed = true;
      return dst;
    } catch (e) {
      // 源不存在（未编译）或目标不可写
      st.lastError = `部署失败: ${e.message}`;
      this.stats.errors++;
      return null;
    }
  }

  /** 找目标进程 pid（按进程名，而不是按窗口 —— 窗口可能还没出现） */
  getPid(procName) {
    const pid = this._getInjector().getPidByProcessName(procName);
    return pid || null;
  }

  // ------------------------------------------------------------ 注入
  /**
   * 确保 DLL 已注入目标进程；返回是否"当前处于已注入"状态。
   * @param {object} target
   * @param {boolean} [onlyIfLoaded] 仅当模块已经在目标里时才继续 ——
   *   用于"切回默认"的场景：宿主里没装过我们的模块 = 本来就是原生外观，
   *   不该为了还原专门往里塞一个模块（那反而是污染）。
   */
  ensureInjected(target, onlyIfLoaded) {
    const st = this.state.get(target.key);
    const pid = this.getPid(target.proc);
    if (!pid) { st.pid = null; return false; }
    st.pid = pid;

    const dllPath = this.deployOne(target);
    if (!dllPath) return false;

    // 模块已在（可能是本进程早先注入的，也可能上一次注入残留）→ 直接复用。
    // ⚠️ 用**精确文件名**判断，不要用正则 —— 正则容易把同名不同版本/不同目标的
    //    副本（例如调试时留下的 aiLobsterTap_tray2.dll）也算成"已注入"，
    //    结果命令发给了完全不认识它的旧模块，表现为"没反应还没报错"（踩过）。
    if (this._getInjector().hasModule(pid, target.dll)) return true;
    if (onlyIfLoaded) return false;

    const ok = this._getInjector().inject(pid, dllPath);
    if (ok) {
      this.stats.injections++;
      console.log(`[ShellFlyoutTap] 已注入 ${target.label} (${target.proc} pid=${pid})`);
    } else {
      st.lastError = '注入失败';
      this.stats.errors++;
    }
    return ok;
  }

  // ------------------------------------------------------------ 命令
  /**
   * 溢出区走管道。前缀是 `AI_Lobster_Tray_`（DLL 侧按 AIL_TRAY_TARGET 单独定义的），
   * 和注入同一 explorer 的其它 TAP 模块（`AI_Lobster_Tap_`）天然隔离 ——
   * 否则同一进程里两条管道，命令很容易打到不认识它的那个模块上。
   */
  async sendPipe(cmd, timeout = 4000) {
    return this.pipe.send(cmd, timeout);
  }

  async send(target, cmd, timeout) {
    if (target.channel === 'file') return fileCmd(target.dir, cmd, timeout);
    return this.sendPipe(cmd, timeout);
  }

  // ------------------------------------------------------------ 应用
  /**
   * 找目标的所有顶层窗口句柄：
   *   · `titleRe` 按标题正则筛（通知中心/跳转列表用共享窗口类，必须按标题区分）
   *   · `cls`     按窗口类定点找（独占类名）
   */
  findTargetWindows(target) {
    const hwnds = [];
    try {
      if (target.titleRe) {
        let prev = null;
        for (let i = 0; i < 64; i++) {
          const h = FindWindowExW(null, prev, 'Windows.UI.Core.CoreWindow', null);
          if (!h) break;
          prev = h;
          const buf = Buffer.alloc(512);
          const len = GetWindowTextW(h, buf, 255);
          const title = len > 0 ? buf.toString('utf16le', 0, len * 2) : '';
          if (target.titleRe.test(title)) hwnds.push(h);
        }
      } else if (target.cls) {
        const h = FindWindowW(target.cls, null);
        if (h) hwnds.push(h);
      }
    } catch (e) { /* ignore */ }
    return hwnds;
  }

  /** 目标面板当前是否开着（窗口存在即认为开着） */
  isTargetWindowOpen(target) {
    return this.findTargetWindows(target).length > 0;
  }

  /**
   * 关掉 / 还原目标窗口的 DWM SystemBackdrop。
   *
   * ★ 这一步**每个弹层都要做**，包括通知中心 —— 用户看到的"灰底/一层遮罩"就是它。
   *   面板每次打开都是新 HWND，SystemBackdrop 会重置回系统默认（Acrylic），
   *   所以 transparent 态下**每轮轮询都要补关**（调用方负责），不能只关一次。
   */
  setDwmBackdrop(target, off) {
    const t0 = diag.nowMs();
    const hwnds = this.findTargetWindows(target);
    if (!hwnds.length) return null;            // 面板没开 → 下次轮询再试

    const buf = Buffer.alloc(4);
    buf.writeInt32LE(off ? DWMSBT_NONE : DWMSBT_AUTO, 0);
    let ok = false;
    for (const h of hwnds) {
      try {
        if (DwmSetWindowAttribute(h, DWMWA_SYSTEMBACKDROP_TYPE, buf, 4) === 0) ok = true;
      } catch (e) { /* 单个失败不影响其它 */ }
    }
    // 看门狗每 300ms 都会调这里：变慢了（>50ms）说明窗口枚举/属性调用出问题，记下来
    diag.slow('dwmBackdrop', t0, 50, { key: target.key, off, windows: hwnds.length, ok });
    return ok;
  }

  /**
   * 对单个目标下发当前效果。
   *
   *  transparent：
   *    ① 关窗口级 DWM SystemBackdrop
   *    ② 用 `BGTRANSPARENT <元素名>` 逐个把 XAML 背景打透
   *       —— 这条命令经 DispatcherQueue **封送到 UI 线程**执行（返回里带 uiTid/qTid 可核对），
   *          所以**立即生效、不依赖"面板打开时的视觉树回调"**；
   *          而老路子 AUTOBG 依赖回调，面板元素复用时根本等不到回调（实测：控制中心只剩一层灰）。
   *  normal：把 DWM backdrop 还原 + AUTOBG 停用（BGRESTORE）。
   */
  /**
   * 对单个目标下发当前效果（诊断版外壳：记录耗时/状态变化，逻辑在 _applyOneInner）。
   * 只在"有意义"时落日志：状态变化 / 耗时 ≥200ms / 出错 / 还原待办 ——
   * 空转轮询（每 1.5s 一遍）不记录，避免刷屏。
   */
  async applyOne(target) {
    const t0 = diag.nowMs();
    const st = this.state.get(target.key);
    const appliedBefore = st.applied;
    const errBefore = st.lastError;
    let r;
    try {
      r = await this._applyOneInner(target);
    } catch (e) {
      diag.event('applyOne', { key: target.key, ms: Math.round(diag.nowMs() - t0), error: e.message });
      throw e;
    }
    const ms = Math.round(diag.nowMs() - t0);
    if (st.applied !== appliedBefore || ms >= 200 || st.lastError !== errBefore || st.restorePending) {
      diag.event('applyOne', {
        key: target.key, applied: st.applied, ok: !!r, ms,
        cmd: st.lastCmd ? String(st.lastCmd).slice(0, 140) : null,
        err: st.lastError !== errBefore ? st.lastError : undefined,
        restorePending: !!st.restorePending
      });
    }
    return r;
  }

  async _applyOneInner(target) {
    const st = this.state.get(target.key);
    // ★ 二级独立开关：未开启同步的目标一律按"还原为系统原生"处理（不再注入/改写）
    const want = (this.isSyncEnabled(target.key) && this.effect === 'transparent') ? 'transparent' : 'normal';
    if (st.applied === want) {
      if (want !== 'transparent') return true;
      // ★ transparent 态不能只信"上次已应用"就短路：
      //   ① 宿主可能被系统回收重建（DLL 随宿主消失 → 必须重新注入+重放）；
      //   ② 面板每次打开都是新 HWND，窗口级 DWM SystemBackdrop 会重置回 Acrylic
      //      —— 不补关就会出现"再次打开多一层灰底"。
      //   所以每轮轮询都要：校验模块还在 + 给当前窗口补关 backdrop。
      const pid = this.getPid(target.proc);
      if (pid && this._getInjector().hasModule(pid, target.dll)) {
        this.setDwmBackdrop(target, true);
        return true;
      }
      st.applied = null;   // 模块丢了 → 落到下面走完整重应用
    }

    // ★ 防卡顿：通知中心宿主（ShellExperienceHost）空闲时被内核冻结，面板没开时
    //   反复注入既失败又空耗 → 面板没开时**每个宿主 pid 只预注入一次**：
    //   宿主刚拉起还醒着时注入会成功 → 用户打开面板即透明、无注入卡顿；
    //   失败（已冻结）就记下 pid 不再尝试，等面板打开（宿主解冻）再正式注入。
    if (want === 'transparent' && target.useAutoBg && !this.isTargetWindowOpen(target)) {
      const pid = this.getPid(target.proc);
      if (pid && st.preinjectPid !== pid) {
        st.preinjectPid = pid;
        this.ensureInjected(target, false);
      }
      return false;
    }

    // ★ 防线程堆叠：刚对同一宿主尝试过注入（可能还在冻结队列里挂着）时，
    //   10s 内不重复 CreateRemoteThread —— 否则冻结期间每 1.5s 排一个远程线程，
    //   宿主解冻瞬间一口气全部执行，反而制造卡顿。
    //   例外：面板**正开着** = 宿主一定醒着，此时注入必能立刻执行 ——
    //   绕过节流直接注入（用户反馈"好久才生效"的主要来源就是白等这个节流）。
    if (want === 'transparent') {
      const pid0 = st.pid || this.getPid(target.proc);
      if (pid0) {
        const windowOpen = this.isTargetWindowOpen(target);
        const triedRecently = st.injectTriedPid === pid0 &&
          (Date.now() - (st.injectTriedAt || 0) < 10000);
        if (triedRecently && !windowOpen && !this._getInjector().hasModule(pid0, target.dll)) {
          return false;
        }
        if (!triedRecently) {
          st.injectTriedPid = pid0;
          st.injectTriedAt = Date.now();
        }
      }
    }

    const injected = this.ensureInjected(target, want === 'normal');
    if (!injected) {
      // 切回默认但宿主里本来就没我们的模块 → 它本来就是原生外观，视为已完成
      if (want === 'normal') { st.applied = 'normal'; return true; }
      return false;
    }

    if (want === 'transparent') {
      if (target.useAutoBg) {
        // ① 关窗口级 DWM backdrop —— **这一步不做，屏幕上就会留一层灰遮罩**
        //    （用户报的"会有一层遮罩"就是它；只改 XAML 元素背景是不够的）
        this.setDwmBackdrop(target, true);
        // ② ⚠️ 通知中心必须用**通配符**（AUTOBG ADD *），不能用固定名单：
        //    固定名单（NotificationCenterGrid/CalendarCenterGrid/...）盖不住"通知"那张卡片，
        //    它会一直挡在中间 —— 用户看到的就是"通知中心有白框遮挡 / 没变化"。
        //    通配符把所有元素的 Background 都打透，实测这才彻底透明（catchup 成功 52 个元素）。
        //    只改 Background，文字/图标（Foreground/Content）不受影响，所以不会把内容也擦掉。
        await this.send(target, 'AUTOBG CLEAR', 4000);
        const resp = await this.send(target, 'AUTOBG ADD *', 5000);
        st.lastCmd = `DWM backdrop off + ${resp ? resp.split('\n')[0].slice(0, 60) : '(AUTOBG 无响应)'}`;
        // 诊断：回读 DLL 端 AUTOBG 状态（CLEAR 已把宿主端计时清零 → 这里读到的是
        // 本次启用周期内宿主 UI 线程花在"换透明画刷"上的累计耗时 bgCostMs）
        const stq = await this.send(target, 'AUTOBG', 4000);
        if (stq) diag.event('dllStatus', { key: target.key, status: stq.split('\n')[0].slice(0, 260) });
        if (!resp) return false;
      } else {
        // 关窗口级 DWM backdrop + 逐个元素 BGTRANSPARENT（立即生效，不等回调）
        this.setDwmBackdrop(target, true);
        let okN = 0;
        for (const name of (target.names || [])) {
          const r = await this.send(target, 'BGTRANSPARENT ' + name, 6000);
          if (r && /hr=0x00000000/.test(r)) okN++;
        }
        st.lastCmd = `BGTRANSPARENT ${okN}/${(target.names || []).length} + DWM backdrop off`;
        // 诊断：回读 DLL 端状态（bgCostMs = 宿主 UI 线程花在换画刷上的累计耗时）
        const stq2 = await this.send(target, 'AUTOBG', 4000);
        if (stq2) diag.event('dllStatus', { key: target.key, status: stq2.split('\n')[0].slice(0, 260) });
        if (!okN) return false;               // 面板没开/宿主未就绪 → 下次轮询再试
      }
    } else {
      // === 还原成系统原生 ===
      //
      // 教训：XAML 的"回滚"两条路都不可靠 ——
      //   · 等视觉树回调（老实现）：面板元素是复用的，第二次打开几乎不产生回调 → 永远等不到；
      //   · 封送到 UI 线程立即还原（SubmitOp）：依赖 DispatcherQueue，而刚注入的模块里
      //     它还没就绪 → `BGRESTORE ... (未入队)`，等于没执行。
      //
      // 所以对**短命宿主**用最可靠的办法：**结束进程，让系统重拉一个干净的**。
      // 这几个宿主本来就是系统按需拉起/回收的（ShellHost / ShellExperienceHost），
      // 杀掉后用户无感，下次打开就是 100% 原生外观 —— 比任何 XAML 回滚都彻底。
      //
      // 例外：托盘溢出面板的宿主是 explorer，**不能**为还原文身重启资源管理器
      // （任务栏会闪），所以它只能走 BGRESTORE 尽力而为。
      if (target.canRestartHost) {
        const okKill = this.killHost(target);
        st.lastCmd = okKill ? `结束 ${target.proc}（系统下次自动重拉 = 原生）` : '结束宿主失败';
        if (!okKill) {
          st.restorePending = true;
          return false;   // 失败 → applied 保持 null，下轮轮询重试
        }
      } else {
        this.setDwmBackdrop(target, false);
        const resp = await this.send(target, 'BGRESTORE', 5000);
        st.lastCmd = resp ? resp.split('\n')[0] : null;
        const m = resp ? /ok=(\d+)/.exec(resp) : null;
        const accepted = !!(m && parseInt(m[1], 10) > 0);
        if (!accepted) {
          // ★ 之前的问题：BGRESTORE 没被接受（宿主忙/面板复用无回调）也把 applied 置成
          //   normal → 永远不再重试，托盘面板就一直透明（"托盘区不能正常恢复"）。
          //   现在保持待办状态，每轮轮询重发，直到某次面板回调里真正还原为止。
          st.restorePending = true;
          return false;
        }
        st.restorePending = false;
      }
    }

    st.applied = want;
    if (want === 'transparent') this.stats.applies++;
    else this.stats.restores++;
    st.restorePending = false;

    console.log(`[ShellFlyoutTap] ${target.label} → ${want} (${st.lastCmd})`);
    return true;
  }

  /**
   * 扫一遍所有目标。
   * ⚠️ 即使"不注入"也要跑：宿主（ShellHost/explorer）重启后模块会丢，必须补注入。
   */
  async syncOnce() {
    this.stats.syncs++;
    const t0 = diag.nowMs();
    const out = [];
    for (const target of TARGETS) {
      try {
        const r = await this.applyOne(target);
        out.push({ key: target.key, ok: r, pid: this.state.get(target.key).pid });
      } catch (e) {
        const st = this.state.get(target.key);
        st.lastError = e.message;
        this.stats.errors++;
      }
    }
    // 诊断：整轮耗时 ≥300ms 才记（目标多、命令多，正常空转应是几毫秒级）。
    // 这条能直接看出"卡顿轮"发生的频率和当时的各目标状态。
    const roundMs = Math.round(diag.nowMs() - t0);
    if (roundMs >= 300) {
      diag.event('syncRound', { ms: roundMs, targets: out.map(o => `${o.key}:${o.ok ? 'ok' : 'pend'}`).join(' ') });
    }
    return out;
  }

  /** 设置目标效果并立即同步一次 */
  async setEffect(effect) {
    const valid = effect === 'transparent' ? 'transparent' : 'normal';
    if (valid !== this.effect) {
      this.effect = valid;
      for (const st of this.state.values()) st.applied = null;   // 效果变了 → 允许重新下发
    }
    const t0 = diag.nowMs();
    const out = await this.syncOnce();
    // 用户主动切换效果 = 关键路径，无论快慢都记（切换卡顿就是这条）
    diag.event('setEffect', { effect: valid, ms: Math.round(diag.nowMs() - t0), results: out.map(o => `${o.key}:${o.ok ? 'ok' : 'pend'}`).join(' ') });
    return out;
  }

  /** 常驻轮询：ShellHost 是按需拉起/回收的进程，explorer 也可能重启 */
  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      // ★ 防卡顿：单轮里可能有 4~9s 的长超时命令（冻结宿主/无响应模块），
      //   上一轮没跑完就跳过本轮，避免命令层层叠加拖垮系统。
      if (this._syncing) return;
      this._syncing = true;
      this.syncOnce().catch(() => {}).finally(() => { this._syncing = false; });
    }, POLL_MS);
    if (this.timer.unref) this.timer.unref();

    // ★ 300ms 看门狗，干两件事（都比 1.5s 主轮询快，直接决定"生效速度"）：
    //   ① transparent 态下补关 DWM SystemBackdrop —— 宿主在面板打开/内容刷新时会
    //      自己把 SystemBackdrop 重新置回 Acrylic，表现为"打开一瞬间是透明的，随后又变灰"。
    //      纯 WinAPI 查窗口 + 设一个属性，开销可忽略。
    //   ② 面板**正开着**但效果还没应用上（注入中/命令在途）→ 立即补一轮 syncOnce，
    //      不等 1.5s 主轮询 —— 用户反馈"好久才生效"的另一半来源就是白等这个间隔。
    if (!this._wdTimer) {
      this._wdTimer = setInterval(() => {
        if (this._syncing) return;
        if (this.effect !== 'transparent') return;
        let needApply = false;
        for (const t of TARGETS) {
          if (!this.isSyncEnabled(t.key)) continue;
          const st = this.state.get(t.key);
          if (st.applied === 'transparent') {
            try { this.setDwmBackdrop(t, true); } catch (e) { /* ignore */ }
          } else if (this.isTargetWindowOpen(t)) {
            needApply = true;    // 面板开着、效果还没上 → 马上补
          }
        }
        if (needApply) {
          this._syncing = true;
          this.syncOnce().catch(() => {}).finally(() => { this._syncing = false; });
        }
      }, 300);
      if (this._wdTimer.unref) this._wdTimer.unref();
    }
  }

  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this._wdTimer) { clearInterval(this._wdTimer); this._wdTimer = null; }
  }

  /**
   * 还原所有目标（关掉效果时调用）。
   *
   * ⚠️ 两个目标的"还原"难度完全不同，所以走两条路：
   *
   *  · 快速设置（ShellHost.exe）—— **直接结束该进程**。
   *    它本来就是系统按需拉起/回收的短命进程，杀掉后系统会在用户下次打开快速设置时
   *    自动重启一个干净的实例 → 100% 回到系统原生。比"等下一次视觉树回调"可靠得多，
   *    而且用户通常感觉不到（没开面板时更是完全无感）。
   *
   *  · 托盘溢出面板（explorer.exe）—— **不能**为了还原文身重启资源管理器，
   *    只能下发 BGRESTORE，让 DLL 在它下一次视觉树回调里把原画刷放回去。
   *    现实是：面板第二次打开往往不产生回调（元素是复用的，只有首次会 Add），
   *    所以这一步可能一直"待办"，直到资源管理器重启才彻底恢复原生。
   *    → 状态里用 restorePending 标出来，UI 可以据此提示用户。
   */
  async restoreAll() {
    const prev = this.effect;
    this.effect = 'normal';
    for (const st of this.state.values()) st.applied = null;

    let ok = 0;
    for (const target of TARGETS) {
      try {
        if (target.key === 'quicksettings') {
          if (this.killHost(target)) { ok++; this.stats.restores++; }
          continue;
        }
        if (await this.applyOne(target)) ok++;
      } catch (e) { /* ignore */ }
    }
    this.effect = prev;
    return ok;
  }

  /**
   * 结束宿主进程（仅用于短命宿主，见 restoreAll 注释）。
   * 用 taskkill 是最省事且不需要额外权限的方式。
   */
  killHost(target) {
    const st = this.state.get(target.key);
    const pid = st.pid || this.getPid(target.proc);
    if (!pid) return true;                  // 本来就没在跑 = 已经是原生
    try {
      require('child_process').execFileSync('taskkill', ['/f', '/pid', String(pid)],
        { stdio: 'ignore', windowsHide: true });
      console.log(`[ShellFlyoutTap] ${target.label}：已结束宿主 ${target.proc}(${pid})，下次打开即系统原生`);
      st.pid = null;
      st.applied = 'normal';
      st.lastCmd = `killed ${target.proc}(${pid})`;
      return true;
    } catch (e) {
      st.lastError = '结束宿主失败: ' + e.message;
      this.stats.errors++;
      return false;
    }
  }

  getStatus() {
    const targets = {};
    for (const t of TARGETS) {
      const st = this.state.get(t.key);
      targets[t.key] = {
        label: t.label, proc: t.proc, pid: st.pid, applied: st.applied,
        lastCmd: st.lastCmd, lastError: st.lastError,
        restorePending: !!st.restorePending
      };
    }
    return { effect: this.effect, polling: !!this.timer, targets, stats: { ...this.stats } };
  }
}

module.exports = new ShellFlyoutTap();
module.exports.ShellFlyoutTap = ShellFlyoutTap;
module.exports.TARGETS = TARGETS;
