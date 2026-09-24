const { app, BrowserWindow, ipcMain, Tray, Menu, dialog, shell, nativeImage, screen, protocol, net, session } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { exec } = require('child_process');

// ★ 主进程补丁加载器：必须在所有业务模块 require 之前加载
//   安装 Module._load 钩子，使 src/main/ 下的主进程代码也能被补丁包覆盖
// ★ 安全加载器：必须在所有业务模块 require 之前加载
//   负责 asar AES 解密、反调试、防 dump、Module._compile 钩子
require('./security-loader');

require('./patch-loader');

// Windows 控制台 UTF-8 输出，避免中文日志乱码（GBK 控制台显示 UTF-8 中文会乱码）
if (process.platform === 'win32') {
  try { require('child_process').execSync('chcp 65001 >nul 2>&1', { stdio: 'ignore' }); } catch (_) {}
}

const FileOps = require('./ipc/fileOps');
const CommandOps = require('./ipc/commandOps');
const InstallOps = require('./ipc/installOps');
const AIOps = require('./ipc/aiOps');
const UiVerify = require('./ipc/uiVerify');
const ModelManager = require('./ipc/modelManager');
const UpdateOps = require('./ipc/updateOps');

// WaveIn 音频采集器（主进程采集，避免渲染进程崩溃）
let WaveInRecorder = null;
try {
  WaveInRecorder = require('./waveInRecorder');
  console.log('[Main] WaveInRecorder 加载成功');
} catch (e) {
  console.error('[Main] WaveInRecorder 加载失败:', e.message);
}
let activeRecorder = null;
const ElectronUpdater = require('./ipc/electronUpdater');
const SupabaseAuth = require('./ipc/supabaseAuth');
const ConfigManager = require('./configManager');
const Changelog = require('./changelog');
const GlobalKeyboard = require('./globalKeyboard');
const GlobalMouse = require('./globalMouse');

// 任务栏透明化模块（Windows only，使用Explorer进程注入技术）
let TaskbarInjector = null;
try {
  TaskbarInjector = require('./taskbar-inject/taskbarInjector');
  console.log('[Main] TaskbarInjector 加载成功');
} catch (e) {
  console.error('[Main] TaskbarInjector 加载失败:', e.message);
}

// ============================================================
// 内存与进程优化模块
// ============================================================
const MemoryOptimizer = {
  // 内存使用阈值（MB），超过后触发优化
  memoryThreshold: 500,
  // 上次优化时间
  lastOptimizeTime: 0,
  // 优化间隔（毫秒）
  optimizeInterval: 5 * 60 * 1000, // 5分钟

  // 获取当前内存使用情况
  getMemoryUsage() {
    const mem = process.memoryUsage();
    return {
      heapUsed: Math.round(mem.heapUsed / 1024 / 1024),
      heapTotal: Math.round(mem.heapTotal / 1024 / 1024),
      rss: Math.round(mem.rss / 1024 / 1024),
      external: Math.round(mem.external / 1024 / 1024)
    };
  },

  // 执行内存优化
  optimize() {
    const now = Date.now();
    if (now - this.lastOptimizeTime < this.optimizeInterval) return;
    this.lastOptimizeTime = now;

    const mem = this.getMemoryUsage();
    console.log('[MemoryOptimizer] 当前内存使用:', JSON.stringify(mem));

    // 触发V8垃圾回收（如果可用）
    if (global.gc) {
      try {
        global.gc();
        console.log('[MemoryOptimizer] 已触发V8垃圾回收');
      } catch (e) {
        console.error('[MemoryOptimizer] 垃圾回收失败:', e.message);
      }
    }

    // 清理不需要的窗口
    this.cleanupUnusedWindows();

    // 清理全局键盘/鼠标钩子（如果主窗口和宠物窗口都隐藏）
    this.cleanupGlobalHooksIfNeeded();

    const memAfter = this.getMemoryUsage();
    console.log('[MemoryOptimizer] 优化后内存使用:', JSON.stringify(memAfter));
    console.log('[MemoryOptimizer] 内存释放:', (mem.rss - memAfter.rss) + 'MB');
  },

  // 清理不需要的窗口
  cleanupUnusedWindows() {
    const windows = BrowserWindow.getAllWindows();
    console.log('[MemoryOptimizer] 当前窗口数量:', windows.length);

    // 关闭隐藏且长时间未使用的临时窗口（右键菜单、动作面板等）
    windows.forEach(win => {
      if (!win || win.isDestroyed()) return;
      const title = win.getTitle();
      // 临时窗口类型
      const isTempWindow = title.includes('菜单') || title.includes('面板') || title.includes('输入栏') || title.includes('项目菜单');
      if (isTempWindow && !win.isVisible()) {
        console.log('[MemoryOptimizer] 关闭隐藏的临时窗口:', title);
        try { win.close(); } catch (e) {}
      }
    });
  },

  // 如果主窗口和宠物窗口都隐藏，清理临时窗口（全局钩子保持运行，不关闭）
  cleanupGlobalHooksIfNeeded() {
    try {
      // 全局钩子始终运行，不做暂停处理
      // 只在应用完全退出时才关闭全局钩子（在will-quit中处理）
    } catch (e) {
      console.error('[MemoryOptimizer] 全局钩子管理失败:', e.message);
    }
  },

  // 启动内存监控定时器
  startMonitoring() {
    setInterval(() => {
      const mem = this.getMemoryUsage();
      // 内存超过阈值时自动优化
      if (mem.rss > this.memoryThreshold) {
        console.log('[MemoryOptimizer] 内存超过阈值 (' + this.memoryThreshold + 'MB)，触发优化');
        this.optimize();
      }
    }, 60 * 1000); // 每分钟检查一次

    console.log('[MemoryOptimizer] 内存监控已启动，阈值:', this.memoryThreshold + 'MB');
  }
};

// 暴露给渲染进程查询内存使用
ipcMain.handle('system:get-memory-usage', () => {
  return MemoryOptimizer.getMemoryUsage();
});

// 暴露给渲染进程手动触发内存优化
ipcMain.handle('system:optimize-memory', () => {
  MemoryOptimizer.optimize();
  return { success: true, memory: MemoryOptimizer.getMemoryUsage() };
});

let mainWindow = null;
let petWindow = null;

// 销毁宠物窗口并释放渲染进程（隐藏时调用，而不是仅 hide 占用内存）
function destroyPetWindow() {
  if (!petWindow || petWindow.isDestroyed()) { petWindow = null; return; }
  petWindow.removeAllListeners('close');
  petWindow.destroy();
  petWindow = null;
}

// 显示宠物窗口（已存在则显示，否则新建），返回状态用于提示
function showPetWindow() {
  if (petWindow && !petWindow.isDestroyed() && petWindow.isVisible()) {
    return { already: 'visible' };
  }
  if (!petWindow || petWindow.isDestroyed()) {
    createPetWindow();
  } else {
    petWindow.showInactive();
    petWindow.focus();
  }
  return { ok: true, action: 'shown' };
}

// 隐藏宠物窗口（销毁释放进程），返回状态用于提示
function hidePetWindow() {
  if (!petWindow || petWindow.isDestroyed()) {
    return { already: 'hidden' };
  }
  destroyPetWindow();
  return { ok: true, action: 'hidden' };
}
let actionEditorWindow = null;
let debugLogWindow = null; // 独立调试日志窗口
let globalKeyboardRunning = false;
let globalMouseRunning = false;
let _editorForceClosing = false; // 渲染进程确认退出后调 editor:close 触发真正关闭，避免 close 事件再次拦截
let tray = null;
let isQuitting = false;

// 任务栏/标题栏窗口图标：直接用打包同款的 icon.ico（多尺寸 ICO），
// Windows 任务栏按 DPI 自动选取合适帧，与打包后的 exe 图标完全一致，不会有白底/黑边棱角。
function getWindowIcon() {
  return path.join(__dirname, '..', '..', 'assets', 'icons', 'icon.ico');
}

// 记录上次应用到宠物窗口的设置，避免重复调用导致位移
let lastPetSettings = null;

// 防抖保存宠物窗口位置和大小，避免频繁写文件
let savePetBoundsTimer = null;
function savePetBoundsDebounced() {
  if (savePetBoundsTimer) clearTimeout(savePetBoundsTimer);
  savePetBoundsTimer = setTimeout(() => {
    savePetBoundsTimer = null;
    if (!petWindow || petWindow.isDestroyed()) return;
    try {
      const [x, y] = petWindow.getPosition();
      const [w, h] = petWindow.getSize();
      const config = ConfigManager.getConfig();
      config.pet = config.pet || {};
      config.pet.position = { x, y };
      // 从窗口尺寸反推 size 值（w = 320 * size → size = w / 320）
      const sizeFromWidth = w / 320;
      const sizeFromHeight = h / 460;
      // 取平均值以减少舍入误差
      config.pet.size = Math.round(((sizeFromWidth + sizeFromHeight) / 2) * 100) / 100;
      ConfigManager.setConfig(config);
    } catch (e) {
      // 忽略保存失败
    }
  }, 500);
}

// 立即保存宠物窗口位置和大小（退出时调用，跳过防抖）
function savePetBoundsImmediate() {
  if (savePetBoundsTimer) {
    clearTimeout(savePetBoundsTimer);
    savePetBoundsTimer = null;
  }
  if (!petWindow || petWindow.isDestroyed()) return;
  try {
    const [x, y] = petWindow.getPosition();
    const [w, h] = petWindow.getSize();
    const config = ConfigManager.getConfig();
    config.pet = config.pet || {};
    config.pet.position = { x, y };
    const sizeFromWidth = w / 320;
    const sizeFromHeight = h / 460;
    config.pet.size = Math.round(((sizeFromWidth + sizeFromHeight) / 2) * 100) / 100;
    ConfigManager.setConfig(config);
  } catch (e) {
    // 忽略保存失败
  }
}

const isDev = process.argv.includes('--dev');

// 设置 AppUserModelId，让 Windows 正确识别应用身份（影响任务栏分组、通知等）
if (process.platform === 'win32') {
  app.setAppUserModelId('com.fuling.shijie.desktop');
}

// Windows: 将窗口设置为工具窗口（WS_EX_TOOLWINDOW）
// 工具窗口不出现在 Alt+Tab 中，在任务管理器中更接近后台进程行为
function setToolWindowStyle(win) {
  if (process.platform !== 'win32' || !win || win.isDestroyed()) return;
  try {
    const hwndBuf = win.getNativeWindowHandle();
    const hwnd = hwndBuf.readBigInt64LE(0).toString();
    const scriptPath = path.join(os.tmpdir(), `pet_toolwin_${Date.now()}.ps1`);
    const script = `Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WinApi {
  [DllImport("user32.dll", SetLastError=true)]
  public static extern int GetWindowLong(IntPtr hWnd, int nIndex);
  [DllImport("user32.dll", SetLastError=true)]
  public static extern int SetWindowLong(IntPtr hWnd, int nIndex, int dwNewLong);
}
"@
$hwnd = [IntPtr]::new(${hwnd})
$GWL_EXSTYLE = -20
$WS_EX_TOOLWINDOW = 0x00000080
$style = [WinApi]::GetWindowLong($hwnd, $GWL_EXSTYLE)
[WinApi]::SetWindowLong($hwnd, $GWL_EXSTYLE, $style -bor $WS_EX_TOOLWINDOW)
`;
    fs.writeFileSync(scriptPath, script, 'utf-8');
    const psExe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    exec(`"${psExe}" -NoProfile -ExecutionPolicy Bypass -File "${scriptPath}"`, (err) => {
      try { fs.unlinkSync(scriptPath); } catch (_) {}
      if (err) console.warn('[pet] setToolWindowStyle failed:', err.message);
    });
  } catch (e) {
    console.warn('[pet] setToolWindowHandle failed:', e.message);
  }
}

// ★ 便携模式：数据目录跟随程序安装目录，安装在哪盘数据就保存在哪盘
// 开发模式使用项目本地 data 目录；打包后优先使用安装目录下的 data 文件夹，
// 如果安装目录无写入权限（如 Program Files），回退到系统 userData 目录。
// 递归复制目录（用于老用户数据迁移）
function copyDirSync(src, dest) {
  if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(s, d);
    } else if (entry.isFile()) {
      try { fs.copyFileSync(s, d); } catch (_) {}
    }
  }
}
let projectDataPath;
if (app.isPackaged) {
  // 打包模式：便携模式（数据跟随安装目录），但要兼容老用户数据
  const installDir = path.dirname(process.execPath);
  const portableDataPath = path.join(installDir, 'data');
  const systemDataPath = app.getPath('userData');
  const portableHasData = fs.existsSync(path.join(portableDataPath, 'config.json'));
  const systemHasData = fs.existsSync(path.join(systemDataPath, 'config.json'));

  // 如果便携目录已有数据，继续用便携目录；如果系统目录有老数据但便携目录是空的，迁移老数据到便携目录
  try {
    if (!fs.existsSync(portableDataPath)) {
      fs.mkdirSync(portableDataPath, { recursive: true });
    }
    const testFile = path.join(portableDataPath, '.write_test');
    fs.writeFileSync(testFile, 'test');
    fs.unlinkSync(testFile);

    if (!portableHasData && systemHasData) {
      // 老用户：把系统目录的数据复制到便携目录，避免登录后变成默认
      console.log('[DataPath] 检测到老用户数据在系统目录，迁移到便携目录...');
      copyDirSync(systemDataPath, portableDataPath);
      projectDataPath = portableDataPath;
      console.log('[DataPath] 迁移完成，数据目录 =', projectDataPath);
    } else if (portableHasData) {
      projectDataPath = portableDataPath;
      console.log('[DataPath] 便携模式（已有数据）: 数据目录 =', projectDataPath);
    } else {
      // 全新安装
      projectDataPath = portableDataPath;
      console.log('[DataPath] 全新便携安装: 数据目录 =', projectDataPath);
    }
  } catch (e) {
    projectDataPath = systemDataPath;
    console.log('[DataPath] 安装目录无写入权限，使用系统目录:', projectDataPath, '原因:', e.message);
  }
} else {
  // 开发模式：使用项目本地 data 目录
  projectDataPath = path.join(__dirname, '..', '..', 'data');
}
if (!fs.existsSync(projectDataPath)) fs.mkdirSync(projectDataPath, { recursive: true });
app.setPath('userData', projectDataPath);

const userDataPath = projectDataPath;
const configPath = path.join(userDataPath, 'config.json');
const modelsPath = path.join(userDataPath, 'models');
const logsPath = path.join(userDataPath, 'logs');

[modelsPath, logsPath].forEach(p => {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
});

// ⚠️ 崩溃兜底必须最早装上：stdout 断管（EPIPE）+ uncaughtException 处理器里再打日志 = 同步无限递归，
// 曾致 26 万个错误文件、主进程 100% CPU、鼠标卡死。实现与限流参数见 src/main/ipc/crashGuard.js。
try { require('./ipc/crashGuard').installCrashGuard({ logsPath }); } catch (e) { /* 兜底装不上也只能继续 */ }

ConfigManager.init(configPath);
ModelManager.init(modelsPath);
AIOps.init(ConfigManager.getConfig().ai || {});
// 长期记忆库：与 config.json 同目录，供 Agent 的 memory_* 工具与「AI 记忆」面板读写
try { AIOps.initMemory(path.join(userDataPath, 'memory.json')); } catch (e) { console.warn('[Memory] 初始化失败:', e.message); }
// 待办事项：按会话隔离，与 config.json 同目录
try { AIOps.initTodo(path.join(userDataPath, 'todos.json')); } catch (e) { console.warn('[Todo] 初始化失败:', e.message); }
// 本地 AI 模型推理引擎（非 Ollama：llama-server / 复用已在运行的本地服务）
try { AIOps.initLocalEngine(path.join(logsPath, 'llama-server.log'), path.join(userDataPath, 'tools')); } catch (e) { console.warn('[LocalAI] 初始化失败:', e.message); }
// UI 自验证：把窗口句柄提供给 capture_window / verify_ui（这些 var 是 let，闭包按调用时取值）
UiVerify.setWindowProvider(() => ({
  main: mainWindow,
  pet: petWindow,
  editor: actionEditorWindow,
  debugLog: debugLogWindow
}));

// 任务栏外观：启动时**不再**自动注入 DLL / 改写 accent。
// 任务栏外观（Phase B / XAML TAP）
// 技术依据：docs/任务栏-PhaseB-可行性报告.md
//   Win11 25H2 (build 26200) 上任务栏可见背景由 XAML 的 BackgroundFill 矩形绘制，
//   SCA (SetWindowCompositionAttribute) 完全无效。正确方案是 XAML 诊断 TAP 附着后修改画刷。
// 启动时根据配置自动注入并应用效果（注入后 TAP 附着需要几秒，异步进行不阻塞启动）。
if (process.platform === 'win32') {
  // 延迟3秒执行任务栏注入，避免和主窗口初始渲染抢主线程导致启动卡顿
  setTimeout(() => {
    try {
      const config = ConfigManager.getConfig();
      const tbConfig = config.taskbar || {};
      const smConfig = config.startMenu || {};
      const TapClient = require('./taskbar-inject/tapClient');
      const StartMenuClient = require('./taskbar-inject/startMenuClient');

      // 先注入并探测，保存原始画刷供后续还原使用。
      // ⚠️ TapClient.inject() 是**同步**方法（返回 boolean），千万不能 .catch() ——
      //    写成 `TapClient.inject().catch(...)` 会抛 "catch is not a function"，
      //    而这一抛会炸掉整个外观初始化块 → 任务栏/开始菜单/弹层效果**全都不执行**
      //    （表现就是"启动后效果没应用、设置里切换也失败"，实测踩过）。
      try { TapClient.inject(); } catch (e) { console.warn('[Main] 任务栏 TAP 注入失败:', e.message); }

      // 任务栏外观（★ 直接读 effect，不再要求 enabled 字段 —— 那会让重启后效果全部丢失）
      if (tbConfig.effect && tbConfig.effect !== 'normal') {
        console.log(`[Main] 任务栏外观：启用 TAP 方案，效果=${tbConfig.effect}`);
        TapClient.applyEffect(tbConfig.effect).then(r => {
          if (r.success) {
            console.log('[Main] 任务栏外观应用成功');
          } else {
            console.warn('[Main] 任务栏外观应用失败:', r.error);
          }
        }).catch(e => {
          console.error('[Main] 任务栏外观应用异常:', e.message);
        });
      } else {
        console.log('[Main] 任务栏外观：默认，尝试还原（处理上次强制结束的情况）');
        TapClient.applyEffect('normal').catch(() => {});
      }

      // 开始菜单外观（独立配置）
      if (smConfig.effect && smConfig.effect !== 'normal') {
        console.log(`[Main] 开始菜单外观：启用，效果=${smConfig.effect}`);
        StartMenuClient.applyEffect(smConfig.effect).then(r => {
          if (r.success) {
            console.log('[Main] 开始菜单外观应用成功');
          } else {
            console.warn('[Main] 开始菜单外观应用失败:', r.error);
          }
        }).catch(e => {
          console.error('[Main] 开始菜单外观应用异常:', e.message);
        });
      } else {
        console.log('[Main] 开始菜单外观：未启用，尝试还原（处理上次强制结束的情况）');
        StartMenuClient.applyEffect('normal').catch(() => {});
      }

      // 弹层（任务栏程序右键的跳转列表）/ 通知栏 —— 跟随任务栏效果，
      // 但受「弹出窗口/通知同步任务栏效果」二级独立开关控制（每个目标单独开关）。
      // 走进程外 SCA，不注入、不影响 explorer；宿主窗口每次打开都是新句柄，
      // 因此既设一次目标效果，又要开常驻轮询持续套用到新窗口。
      // ★ 直接读 effect，不再有 enabled===false 的旧字段劫持（那是"重启变默认"的根源）。
      try {
        const syncMap = flyoutSyncMap(config);
        // 用模块级变量（不在回调里重新 require）：加载失败时它已是 null，这里自然跳过。
        if (ShellSurfaceAccent) {
          const tbEffective = tbConfig.effect || 'normal';
          ShellSurfaceAccent.setTargetSync(syncMap);
          ShellSurfaceAccent.setEffect(tbEffective);
          // 「默认」时不需要常驻轮询（原生外观本来就对）；有实体效果才需要持续套用到新窗口。
          if (tbEffective !== 'normal') ShellSurfaceAccent.start();
          else ShellSurfaceAccent.stop();
          console.log(`[Main] 弹层/通知栏外观：效果=${tbEffective} 同步开关=${JSON.stringify(syncMap)}`);
        }
      } catch (e) {
        console.error('[Main] 弹层/通知栏外观初始化失败:', e.message);
      }

      // 托盘溢出区 / 快速设置（WiFi）—— 跟随任务栏效果（同样受二级独立开关控制）。
      // ★ 轮询**常开**（包括"默认"状态）：这几个宿主会被系统随时回收重建，
      //   normal 时轮询负责"保持原生 + 补完未竟的还原"，transparent 时负责补注入重放。
      try {
        if (ShellFlyoutTap) {
          const tbEffective = tbConfig.effect || 'normal';
          ShellFlyoutTap.setTargetSync(flyoutSyncMap(config));
          ShellFlyoutTap.setEffect(tbEffective).catch(() => {});
          ShellFlyoutTap.start();
          console.log(`[Main] 托盘溢出/快速设置：效果=${tbEffective}（轮询常开，二级开关已下发）`);
        }
      } catch (e) {
        console.error('[Main] 托盘溢出/快速设置初始化失败:', e.message);
      }
    } catch (e) {
      console.error('[Main] 任务栏/开始菜单外观初始化失败:', e.message);
    }
  }, 3000);  // 延迟 3 秒，等 explorer 和 XAML 都就绪
}

// 「效果自动维持」已按需求移除（原开始菜单守护 / explorer 重建守护 / 外观配置巡检）。
// 现在的语义：程序启动时按上次保存的选择自动应用效果（上面这段启动逻辑），
// 程序退出时自动恢复默认（before-quit / will-quit 的还原逻辑）；
// 再次启动（重启程序/电脑）会从 config 记住之前的选择并重新应用。
// 注意：运行期间 explorer / 宿主进程被系统重建后效果**不会**自动补回，重启本程序即可。

// 注册自定义协议，确保打包后能可靠加载本地模型文件
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'live2d',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      bypassCSP: true
    }
  },
  {
    scheme: 'patch',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      bypassCSP: true
    }
  }
]);

function createPetWindow() {
  const { workAreaSize } = screen.getPrimaryDisplay();
  const config = ConfigManager.getConfig();
  const petConfig = config.pet || {};
  const petSize = petConfig.size || 1.0;
  const petOpacity = petConfig.opacity != null ? petConfig.opacity : 0;
  const petWidth = Math.round(320 * petSize);
  const petHeight = Math.round(460 * petSize);

  // 默认位置：右下角
  const defaultX = workAreaSize.width - petWidth - 20;
  const defaultY = workAreaSize.height - petHeight - 40;

  // 尝试恢复上次保存的位置
  let initX = defaultX;
  let initY = defaultY;
  if (petConfig.position && typeof petConfig.position.x === 'number' && typeof petConfig.position.y === 'number') {
    const savedX = petConfig.position.x;
    const savedY = petConfig.position.y;
    // 验证保存的位置在某个显示器的可见范围内
    // 放宽验证：只要窗口至少有 50% 在某个显示器的工作区内即可恢复
    const matchingDisplay = screen.getDisplayMatching({ x: savedX, y: savedY, width: petWidth, height: petHeight });
    const wa = matchingDisplay.workArea;
    // 计算窗口与工作区的重叠区域
    const overlapX = Math.max(0, Math.min(savedX + petWidth, wa.x + wa.width) - Math.max(savedX, wa.x));
    const overlapY = Math.max(0, Math.min(savedY + petHeight, wa.y + wa.height) - Math.max(savedY, wa.y));
    const overlapArea = overlapX * overlapY;
    const windowArea = petWidth * petHeight;
    // 至少 30% 的窗口在屏幕内才恢复位置，否则使用默认位置
    if (overlapArea >= windowArea * 0.3) {
      initX = savedX;
      initY = savedY;
    }
  }

  petWindow = new BrowserWindow({
    width: petWidth,
    height: petHeight,
    x: initX,
    y: initY,
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: petConfig.alwaysOnTop !== false,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: false,
      backgroundThrottling: false
    }
  });

  // ★ 透明度只作用于模型画布（渲染端通过 --model-opacity 仅控制 canvas），
  //   不再用 petWindow.setOpacity 整体调窗，否则输入框/菜单等 UI 会一并变淡，
  //   且重启后窗口整体透明度无法通过滑块恢复（导致"降到0还是透明"的问题）。
  // 窗口整体透明度始终保持 1（完全不透明），透明效果由画布 CSS 变量控制。
  petWindow.setOpacity(1);

  if (petConfig.alwaysOnTop !== false) {
    petWindow.setAlwaysOnTop(true, 'floating');
  }
  petWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  // 始终启用前向模式的鼠标事件穿透
  // 渲染进程会根据像素透明度动态切换：透明区域穿透，模型像素捕获
  petWindow.setIgnoreMouseEvents(true, { forward: true });

  // 恢复初始位置（setOpacity / setAlwaysOnTop 在 Windows 上可能导致透明窗口位移）
  const [actualX, actualY] = petWindow.getPosition();
  if (actualX !== initX || actualY !== initY) {
    petWindow.setPosition(initX, initY);
  }

  // 初始化上次应用设置记录
  lastPetSettings = {
    opacity: petOpacity,
    size: petSize,
    frameRate: petConfig.frameRate || 60,
    alwaysOnTop: petConfig.alwaysOnTop !== false,
    clickThrough: petConfig.clickThrough || false
  };

  UpdateOps.setupPatchOverride(petWindow.webContents.session);
  petWindow.loadFile(path.join(__dirname, '..', 'renderer', 'pet.html'));

  petWindow.once('ready-to-show', () => {
    petWindow.showInactive();
    // 设置为工具窗口，减少在前台的"存在感"
    setToolWindowStyle(petWindow);
  });

  petWindow.on('close', (e) => {
    // 拦截关闭事件：隐藏时销毁窗口释放渲染进程，真正退出时才允许关闭
    if (!isQuitting) {
      e.preventDefault();
      destroyPetWindow();
    }
  });

  petWindow.on('closed', () => {
    petWindow = null;
  });

  // 窗口移动时自动保存位置（防抖，避免频繁写文件）
  petWindow.on('move', () => {
    savePetBoundsDebounced();
  });

  // 窗口大小变化时自动保存尺寸和位置（防抖）
  petWindow.on('resize', () => {
    savePetBoundsDebounced();
  });

  // 窗口隐藏时暂停渲染循环，显示时恢复，避免后台占用 CPU/GPU
  petWindow.on('hide', () => {
    if (!petWindow.isDestroyed()) {
      petWindow.webContents.send('pet:pause-animations');
    }
  });
  petWindow.on('show', () => {
    if (!petWindow.isDestroyed()) {
      petWindow.webContents.send('pet:resume-animations');
    }
  });

  // 转发渲染进程 console 日志到主进程终端（调试用），同时写入文件
  const petLogPath = path.join(app.getPath('userData'), 'pet-console.log');
  try { fs.writeFileSync(petLogPath, '[main] pet window created at ' + new Date().toISOString() + '\n'); } catch (_) {}
  petWindow.webContents.on('console-message', (_e, level, message) => {
    const tag = level === 2 ? '[pet-ERR]' : '[pet]';
    const line = tag + ' ' + message + '\n';
    console.log(tag, message);
    try { fs.appendFileSync(petLogPath, line); } catch (_) {}
    // 同时转发到调试日志窗口
    if (debugLogWindow && !debugLogWindow.isDestroyed()) {
      debugLogWindow.webContents.send('debug-log:message', { type: level === 2 ? 'error' : 'log', message });
    }
  });
  petWindow.webContents.on('did-finish-load', () => {
    try { fs.appendFileSync(petLogPath, '[main] did-finish-load\n'); } catch (_) {}
  });
  petWindow.webContents.on('did-fail-load', (_e, errorCode, errorDescription) => {
    try { fs.appendFileSync(petLogPath, '[main] did-fail-load: ' + errorCode + ' ' + errorDescription + '\n'); } catch (_) {}
  });
  petWindow.webContents.on('dom-ready', () => {
    try { fs.appendFileSync(petLogPath, '[main] dom-ready\n'); } catch (_) {}
  });

  // 渲染进程崩溃捕获：把崩溃原因写入 crash.log 并弹窗提示，避免“闪退无日志”。
  petWindow.webContents.on('crashed', (event, killed) => {
    const msg = '宠物窗口渲染进程崩溃 killed=' + killed + ' reason=' + (event && event.reason || 'unknown');
    writeCrashLog('[webContents.crashed] ' + msg);
    // ★ 使用项目风格对话框替代原生 showErrorBox，视觉与 AppDialog 一致
    try {
      showProjectDialog({
        type: 'error',
        title: '宠物窗口崩溃',
        message: '宠物窗口（渲染进程）崩溃了。',
        detail: '原因：' + msg + '\n\n常见诱因：模型纹理过大（如 8192px）导致显卡显存不足 / WebGL 上下文丢失。\n崩溃日志已保存到：' + path.join(app.getPath('userData'), 'crash.log'),
        buttons: ['知道了'],
        primaryIndex: 0,
        cancelId: 0,
        parentWindow: petWindow || mainWindow
      }).catch(e => { try { dialog.showErrorBox('宠物窗口崩溃', msg); } catch (_) {} });
    } catch (e) {
      // 兜底：自定义窗口创建失败时退回原生（确保崩溃信息至少能呈现）
      try { dialog.showErrorBox('宠物窗口崩溃', msg); } catch (_) {}
    }
  });

  petWindow.webContents.on('did-finish-load', () => {
    petWindow.webContents.send('init:config', ConfigManager.getConfig());
    petWindow.webContents.send('init:models', ModelManager.getModelList());
  });
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 780,
    minWidth: 900,
    minHeight: 650,
    frame: false,
    title: '浮灵饰界 - 智能桌面助手',
    icon: getWindowIcon(),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.setMenuBarVisibility(false);
  UpdateOps.setupPatchOverride(mainWindow.webContents.session);
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // ★ 后台运行优化：窗口隐藏时启用后台节流，限制CPU和渲染资源使用
  mainWindow.webContents.setBackgroundThrottling(true);

  if (isDev) {
    mainWindow.webContents.openDevTools();
  }

  mainWindow.on('close', (e) => {
    // ★ 内存优化：关闭主窗口时真正销毁窗口，释放渲染进程资源
    // 不再使用hide()隐藏到托盘，而是完全关闭，需要时通过托盘菜单重新创建
    // 这样后台运行时只保留宠物窗口进程，内存占用与开机自启时一致
    if (!isQuitting) {
      // 不阻止关闭，让窗口真正销毁
      // 关闭前先触发内存优化
      console.log('[MemoryOptimizer] 主窗口关闭，释放渲染进程资源');
      setTimeout(() => MemoryOptimizer.optimize(), 500);
    }
  });

  // ★ 窗口隐藏时触发内存优化（其他原因导致的隐藏）
  mainWindow.on('hide', () => {
    console.log('[MemoryOptimizer] 主窗口隐藏，触发内存优化');
    setTimeout(() => MemoryOptimizer.optimize(), 1000);
  });

  mainWindow.on('closed', () => {
    if (!isQuitting) {
      mainWindow = null;
    }
  });

  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow.webContents.send('init:config', ConfigManager.getConfig());
    mainWindow.webContents.send('init:models', ModelManager.getModelList());
    mainWindow.webContents.send('init:system-info', {
      os: os.platform(),
      arch: os.arch(),
      cpuCount: os.cpus().length,
      totalMem: Math.round(os.totalmem() / 1024 / 1024 / 1024),
      hostname: os.hostname()
    });
  });
}

// 动作编辑器：独立窗口（与主窗口一致的自定义标题栏，frame:false）
function createActionEditorWindow(modelId, actionKey, isNew, isBuiltin) {
  if (actionEditorWindow && !actionEditorWindow.isDestroyed()) {
    actionEditorWindow.focus();
    // 已打开时直接切换到新请求的动作，而不是只聚焦（修复「新建/编辑共用单一窗口，无法打开/切换到另一个动作」）
    actionEditorWindow.webContents.send('editor:load', { modelId, actionKey, isNew, isBuiltin });
    return;
  }
  actionEditorWindow = new BrowserWindow({
    width: 1040,
    height: 780,
    minWidth: 860,
    minHeight: 620,
    frame: false,
    title: '浮灵饰界 - 动作编辑器',
    icon: getWindowIcon(),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  actionEditorWindow.setMenuBarVisibility(false);
  actionEditorWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'), {
    query: {
      mode: 'editor',
      modelId: String(modelId || ''),
      actionKey: String(actionKey || ''),
      isNew: isNew ? '1' : '0',
      isBuiltin: isBuiltin ? '1' : '0'
    }
  });
  // 窗口加载完成后发送配置信息（确保动作编辑器能正确读取主题设置等）
  actionEditorWindow.webContents.on('did-finish-load', () => {
    if (actionEditorWindow && !actionEditorWindow.isDestroyed()) {
      actionEditorWindow.webContents.send('init:config', ConfigManager.getConfig());
      actionEditorWindow.webContents.send('init:models', global.modelManager ? global.modelManager.getModels() : []);
      actionEditorWindow.webContents.send('init:system-info', {
        platform: process.platform,
        arch: process.arch,
        version: process.version,
        totalMemory: require('os').totalmem(),
        cpuCount: require('os').cpus().length
      });
    }
  });
  actionEditorWindow.on('closed', () => { actionEditorWindow = null; });
  // 拦截关闭事件：让渲染进程检查是否有未保存修改，有则弹确认框
  // _editorForceClosing 守卫：渲染进程确认退出后调 editor:close 触发真正关闭，避免 close 事件再次拦截形成死循环
  actionEditorWindow.on('close', (e) => {
    if (_editorForceClosing) return; // 已经是用户确认后的真正关闭，放行
    if (actionEditorWindow && !actionEditorWindow.isDestroyed()) {
      e.preventDefault(); // 先阻止关闭
      actionEditorWindow.webContents.send('editor:beforeclose');
    }
  });
}

function createTray() {
  // 使用高分辨率 icon.png 缩放到托盘尺寸，避免旧 tray.png 在高分屏模糊
  const hiResPath = path.join(__dirname, '..', '..', 'assets', 'icons', 'icon.png');
  let trayIcon;
  if (fs.existsSync(hiResPath)) {
    trayIcon = nativeImage.createFromPath(hiResPath).resize({ width: 32, height: 32, quality: 'best' });
  } else {
    const fallback = path.join(__dirname, '..', '..', 'assets', 'icons', 'tray.png');
    trayIcon = fs.existsSync(fallback) ? nativeImage.createFromPath(fallback) : nativeImage.createEmpty();
  }

  tray = new Tray(trayIcon);
  tray.setToolTip('浮灵饰界');

  const contextMenu = Menu.buildFromTemplate([
    { label: '显示主界面', click: () => { if (!mainWindow) { createMainWindow(); mainWindow.show(); mainWindow.focus(); } else { mainWindow.show(); mainWindow.focus(); } } },
    { label: '显示灵汐', click: () => { showPetWindow(); } },
    { label: '隐藏灵汐', click: () => { hidePetWindow(); } },
    { type: 'separator' },
    { label: '设置', click: () => { if (!mainWindow) createMainWindow(); else { mainWindow.show(); mainWindow.focus(); } } },
    { type: 'separator' },
    { label: '退出', click: () => { isQuitting = true; app.quit(); } }
  ]);

  tray.setContextMenu(contextMenu);
  tray.on('double-click', () => {
    if (!mainWindow) { createMainWindow(); mainWindow.show(); mainWindow.focus(); }
    else { mainWindow.show(); mainWindow.focus(); }
  });
}

function broadcastToWindows(channel, data) {
  if (petWindow && !petWindow.isDestroyed()) petWindow.webContents.send(channel, data);
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, data);
}

// ==================== IPC Handlers ====================

// --- Window Control ---
// ★ 支持传入 tab 参数，打开主窗口后自动切换到指定页面（如 'models' 模型管理）
ipcMain.handle('window:open-main', (_e, tab) => {
  if (!mainWindow) {
    createMainWindow();
    // 修复：首次创建主窗口后必须显式 show/focus，否则被 alwaysOnTop 的宠物窗口挡住
    mainWindow.show();
    mainWindow.focus();
    // 主窗口创建后需要等待加载完成再发送导航消息
    mainWindow.webContents.once('did-finish-load', () => {
      // 加载完成后再次确保窗口可见并置顶
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.show();
        mainWindow.focus();
      }
      if (tab) {
        mainWindow.webContents.send('main:navigate', tab);
      }
    });
  } else {
    mainWindow.show();
    mainWindow.focus();
    if (tab) {
      mainWindow.webContents.send('main:navigate', tab);
    }
  }
});

// 用户同意免责声明后，创建并显示宠物窗口
ipcMain.handle('disclaimer:accepted', () => {
  if (!petWindow) {
    createPetWindow();
  } else if (!petWindow.isVisible()) {
    petWindow.showInactive();
  }
  return { success: true };
});

ipcMain.handle('window:close-main', () => {
  // ★ 内存优化：关闭主窗口时真正销毁窗口，释放渲染进程资源
  // 不再使用hide()隐藏，而是完全关闭，需要时通过托盘菜单重新创建
  if (mainWindow && !mainWindow.isDestroyed()) {
    console.log('[MemoryOptimizer] 渲染进程请求关闭主窗口，释放渲染进程资源');
    mainWindow.close();
  }
});

ipcMain.handle('window:minimize', () => {
  if (mainWindow) mainWindow.minimize();
});

ipcMain.handle('window:maximize', () => {
  if (!mainWindow) return false;
  if (mainWindow.isMaximized()) {
    mainWindow.unmaximize();
    return false;
  } else {
    mainWindow.maximize();
    return true;
  }
});

ipcMain.handle('window:is-maximized', () => {
  if (!mainWindow) return false;
  return mainWindow.isMaximized();
});

// ===== 动作编辑器独立窗口控制（操作 actionEditorWindow，不影响主窗口）=====
ipcMain.handle('editor:open', (_e, params) => {
  createActionEditorWindow(
    params && params.modelId,
    params && params.actionKey,
    !!(params && params.isNew),
    !!(params && params.isBuiltin)
  );
  return true;
});
ipcMain.handle('editor:minimize', () => {
  if (actionEditorWindow && !actionEditorWindow.isDestroyed()) actionEditorWindow.minimize();
});
ipcMain.handle('editor:maximize', () => {
  if (!actionEditorWindow || actionEditorWindow.isDestroyed()) return false;
  if (actionEditorWindow.isMaximized()) { actionEditorWindow.unmaximize(); return false; }
  actionEditorWindow.maximize();
  return true;
});
ipcMain.handle('editor:is-maximized', () => {
  if (!actionEditorWindow || actionEditorWindow.isDestroyed()) return false;
  return actionEditorWindow.isMaximized();
});
ipcMain.handle('editor:close', () => {
  if (actionEditorWindow && !actionEditorWindow.isDestroyed()) {
    _editorForceClosing = true; // 放行真正的关闭，不再拦截 close 事件
    actionEditorWindow.close();
  }
});
// 编辑器保存后通知主窗口刷新对应模型详情
ipcMain.handle('editor:saved', (_e, modelId) => {
  broadcastToWindows('model:actions-changed', modelId);
  return true;
});

ipcMain.handle('window:toggle-pet', (_e, show) => {
  if (show) return showPetWindow();
  else return hidePetWindow();
});

ipcMain.on('pet:drag', (_e, { screenX, screenY }) => {
  if (petWindow) {
    const x = Math.round(screenX);
    const y = Math.round(screenY);
    // Windows 透明窗口在 setPosition 时可能触发 resize，使用 setBounds 原子性地设置位置和大小
    const config = ConfigManager.getConfig();
    const petSize = config.pet?.size || 1.0;
    const expectedW = Math.round(320 * petSize);
    const expectedH = Math.round(460 * petSize);
    petWindow.setBounds({ x, y, width: expectedW, height: expectedH });
  }
});

// 保存宠物窗口当前位置和大小到配置文件（拖动结束时调用）
ipcMain.handle('pet:save-position', () => {
  if (!petWindow || petWindow.isDestroyed()) return { success: false };
  try {
    const [x, y] = petWindow.getPosition();
    const [w, h] = petWindow.getSize();
    const config = ConfigManager.getConfig();
    config.pet = config.pet || {};
    config.pet.position = { x, y };
    const sizeFromWidth = w / 320;
    const sizeFromHeight = h / 460;
    config.pet.size = Math.round(((sizeFromWidth + sizeFromHeight) / 2) * 100) / 100;
    ConfigManager.setConfig(config);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('pet:get-position', () => {
  if (!petWindow) return null;
  const [x, y] = petWindow.getPosition();
  const [w, h] = petWindow.getSize();
  return { x, y, width: w, height: h };
});

// 让外部（主界面/聊天/AI）指挥桌宠做语义动作。
// name 可为单个动作名（如 'sleep'）或动作名数组（复合叠加，如 ['happy','dance']），
// 直接转发给宠物窗口的 pet:action 事件处理（PetBrain.doAction / doActions）。
// 合法动作名见《Live2D通用桌面宠物-智能指令交互系统-开发文档》十大固定分类。
ipcMain.handle('pet:do-action', (_e, name) => {
  if (petWindow && !petWindow.isDestroyed()) {
    petWindow.webContents.send('pet:action', name);
    return { success: true };
  }
  return { success: false, error: 'pet window unavailable' };
});

// 动态鼠标事件穿透：渲染进程根据像素透明度切换
ipcMain.on('pet:set-ignore-mouse-events', (_e, { ignore, forward }) => {

  if (petWindow && !petWindow.isDestroyed()) {
    petWindow.setIgnoreMouseEvents(ignore, { forward: forward !== false });
  }
});

// 聚焦宠物窗口（使小键盘动作触发生效）
ipcMain.on('pet:focus', () => {
  if (petWindow && !petWindow.isDestroyed()) {
    petWindow.focus();
  }
});

// 设置桌宠渲染倍率（同时影响模型和键盘叠加层清晰度）
ipcMain.on('pet:set-render-scale', (_e, scale) => {
  if (petWindow && !petWindow.isDestroyed()) {
    petWindow.webContents.send('pet:render-scale', scale);
  }
});

// 桌宠平滑移动到指定屏幕坐标
ipcMain.handle('pet:move-to', (_e, { x, y, duration = 800 }) => {
  return new Promise((resolve) => {
    if (!petWindow) { resolve({ success: false }); return; }
    const [curX, curY] = petWindow.getPosition();
    const [w, h] = petWindow.getSize();
    const targetX = Math.round(x - w / 2);
    const targetY = Math.round(y - h / 2);
    const steps = Math.max(10, Math.floor(duration / 16));
    const stepX = (targetX - curX) / steps;
    const stepY = (targetY - curY) / steps;
    let step = 0;
    const timer = setInterval(() => {
      step++;
      if (step >= steps) {
        petWindow.setPosition(targetX, targetY);
        clearInterval(timer);
        resolve({ success: true, x: targetX, y: targetY });
      } else {
        petWindow.setPosition(
          Math.round(curX + stepX * step),
          Math.round(curY + stepY * step)
        );
      }
    }, 16);
  });
});

// 桌宠执行系统动作（模拟人类操作）
ipcMain.handle('pet:execute-action', (_e, action) => {
  return new Promise((resolve) => {
    const { type, target, text, combo, command } = action;
    // 使用完整路径调用 PowerShell，防止 PATH 中找不到 powershell.exe
    const shell = process.platform === 'win32'
      ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      : '/bin/bash';
    const shellArgs = process.platform === 'win32'
      ? ['-NoProfile', '-Command']
      : ['-c'];

    switch (type) {
      case 'open': {
        // 打开应用程序或网址
        // 综合搜索策略：App Paths 注册表 → 开始菜单快捷方式 → 常见安装目录 → cmd start 兜底
        const openTarget = (target || '').trim();
        if (!openTarget) {
          resolve({ success: false, error: '打开目标为空' });
          break;
        }

        // URL：使用 Electron shell.openExternal（最可靠）
        if (/^https?:\/\//i.test(openTarget)) {
          shell.openExternal(openTarget);
          resolve({ success: true });
          break;
        }

        // 本地文件路径：使用 Electron shell.openPath
        if (/^[a-zA-Z]:[\\\/]/.test(openTarget) && fs.existsSync(openTarget)) {
          shell.openPath(openTarget);
          resolve({ success: true });
          break;
        }

        if (process.platform === 'win32') {
          // 构建 PowerShell 脚本：综合搜索并启动应用程序
          // 使用单引号包裹目标名称，仅需转义单引号（'' → '）
          const safeName = openTarget.replace(/'/g, "''");
          const psScript = [
            '$ErrorActionPreference = "SilentlyContinue"',
            `$name = '${safeName}'`,
            '$found = $null',
            '',
            '# 1. 搜索 App Paths 注册表（QQ、微信等通常在此注册）',
            '$regBases = @(',
            '  "HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths",',
            '  "HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths",',
            '  "HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\App Paths"',
            ')',
            'foreach ($base in $regBases) {',
            '  if (Test-Path $base) {',
            '    Get-ChildItem $base | ForEach-Object {',
            '      $kn = $_.PSChildName',
            '      if ($kn -ieq $name -or $kn -ieq "$name.exe" -or $kn -like "*$name*") {',
            '        $v = (Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue)."(default)"',
            '        if ($v) { $p = $v.Trim(\'"\'); if (Test-Path $p) { $found = $p } }',
            '      }',
            '    }',
            '  }',
            '  if ($found) { break }',
            '}',
            '',
            '# 2. 搜索开始菜单快捷方式',
            'if (-not $found) {',
            '  $wsh = New-Object -ComObject WScript.Shell',
            '  $dirs = @("$env:APPDATA\\Microsoft\\Windows\\Start Menu\\Programs", "$env:ProgramData\\Microsoft\\Windows\\Start Menu\\Programs")',
            '  foreach ($d in $dirs) {',
            '    if (Test-Path $d) {',
            '      Get-ChildItem $d -Recurse -Filter *.lnk -ErrorAction SilentlyContinue | ForEach-Object {',
            '        $sc = $wsh.CreateShortcut($_.FullName)',
            '        if ($_.BaseName -ieq $name -or $_.BaseName -like "*$name*" -or $sc.TargetPath -like "*$name*") {',
            '          $found = $sc.TargetPath',
            '        }',
            '      }',
            '    }',
            '    if ($found) { break }',
            '  }',
            '}',
            '',
            '# 3. 搜索常见安装目录',
            'if (-not $found) {',
            '  $cpaths = @("$env:LOCALAPPDATA\\Programs", "$env:ProgramFiles", "${env:ProgramFiles(x86)}")',
            '  foreach ($cp in $cpaths) {',
            '    if (Test-Path $cp) {',
            '      $t1 = Join-Path $cp "$name.exe"',
            '      if (Test-Path $t1) { $found = $t1; break }',
            '      $t2 = Join-Path $cp $name',
            '      if (Test-Path $t2) { $found = $t2; break }',
            '    }',
            '  }',
            '}',
            '',
            '# 4. 找到则启动，否则用 cmd start 兜底（搜索 PATH + App Paths）',
            'if ($found) {',
            '  Start-Process $found',
            '  exit 0',
            '}',
            'cmd /c start "" "$name" 2>$null',
            'if ($LASTEXITCODE -eq 0) { exit 0 }',
            'exit 1'
          ].join('\n');

          // 使用 EncodedCommand 避免 shell 引号转义问题
          // 使用完整路径调用 PowerShell，防止 PATH 中找不到 powershell.exe
          const psExe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
          const encoded = Buffer.from(psScript, 'utf16le').toString('base64');
          exec(`"${psExe}" -NoProfile -EncodedCommand ${encoded}`, { timeout: 10000 }, (err) => {
            resolve({
              success: !err,
              error: err ? `找不到应用程序: ${openTarget}` : null
            });
          });
        } else {
          exec(`open "${openTarget}"`, (err) => {
            resolve({ success: !err, error: err?.message });
          });
        }
        break;
      }
      case 'type': {
        // 通过剪贴板粘贴文本（比SendKeys更可靠）
        const safeText = (text || '').replace(/'/g, "''");
        const psCmd = `Set-Clipboard -Value '${safeText}'; Add-Type -AssemblyName System.Windows.Forms; Start-Sleep -Milliseconds 100; [System.Windows.Forms.SendKeys]::SendWait('^v')`;
        exec(`"${shell}" ${shellArgs.join(' ')} "${psCmd.replace(/"/g, '\\"')}"`, (err) => {
          resolve({ success: !err, error: err?.message });
        });
        break;
      }
      case 'key': {
        // 发送键盘组合键
        const keyMap = { ctrl: '^', alt: '%', shift: '+', enter: '~', tab: '{TAB}', esc: '{ESC}', backspace: '{BACKSPACE}', delete: '{DELETE}', up: '{UP}', down: '{DOWN}', left: '{LEFT}', right: '{RIGHT}', space: ' ', home: '{HOME}', end: '{END}', pageup: '{PGUP}', pagedown: '{PGDN}', win: '^{ESC}', f1: '{F1}', f2: '{F2}', f3: '{F3}', f4: '{F4}', f5: '{F5}', f6: '{F6}', f7: '{F7}', f8: '{F8}', f9: '{F9}', f10: '{F10}', f11: '{F11}', f12: '{F12}' };
        const parts = (combo || '').toLowerCase().split('+').map(k => k.trim());
        let sendKeys = '';
        for (let i = 0; i < parts.length; i++) {
          const k = parts[i];
          if (i < parts.length - 1) {
            sendKeys += keyMap[k] || '';
          } else {
            sendKeys += keyMap[k] || k;
          }
        }
        const psCmd = `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${sendKeys}')`;
        exec(`"${shell}" ${shellArgs.join(' ')} "${psCmd.replace(/"/g, '\\"')}"`, (err) => {
          resolve({ success: !err, error: err?.message });
        });
        break;
      }
      case 'cmd': {
        // 执行系统命令
        exec(command || '', { timeout: 15000 }, (err, stdout, stderr) => {
          resolve({
            success: !err,
            stdout: stdout?.trim(),
            stderr: stderr?.trim(),
            error: err?.message
          });
        });
        break;
      }
      case 'wait': {
        const ms = parseInt(action.ms) || 1000;
        setTimeout(() => resolve({ success: true }), ms);
        break;
      }
      default:
        resolve({ success: false, error: `Unknown action type: ${type}` });
    }
  });
});

// --- Config ---
ipcMain.handle('config:get', () => ConfigManager.getConfig());
ipcMain.handle('config:set', (_e, config) => {
  const result = ConfigManager.setConfig(config);
  AIOps.init(ConfigManager.getConfig().ai || {});
  // 广播配置更新给所有窗口（确保主题等设置能同步到主窗口、动作编辑器等）
  const allWindows = [petWindow, mainWindow, actionEditorWindow];
  allWindows.forEach(win => {
    if (win && !win.isDestroyed()) {
      win.webContents.send('init:config', ConfigManager.getConfig());
    }
  });
  return result;
});
ipcMain.handle('config:reset', () => {
  const result = ConfigManager.resetConfig();
  AIOps.init(ConfigManager.getConfig().ai || {});
  return result;
});

// --- 任务栏外观（Windows only）---
// 设计原则：只暴露**本机实测安全可用**的能力，不计空头支票。
//   · 系统「透明效果」开关：真实有效（需注销/重登才生效）；
//   · 探针自检：注入→PING→确认模块驻留→卸载，用来验证注入链路是否健康；
//   · 历史注册表残留清理。
// 不再提供 taskbar:apply / taskbar:restore —— 那条路（进程内改写 accent）本机实测会让 explorer 崩溃。
// 新方案（Phase B / XAML TAP）：注入 aiLobsterTap.dll，通过 XAML 诊断修改 BackgroundFill 画刷。
// 详见 docs/任务栏-PhaseB-可行性报告.md
const TaskbarAppearance = process.platform === 'win32' ? require('./taskbarTransparency') : null;
const TapClient = process.platform === 'win32' ? require('./taskbar-inject/tapClient') : null;
const StartMenuClient = process.platform === 'win32' ? require('./taskbar-inject/startMenuClient') : null;
// 弹层（任务栏程序右键的跳转列表）/ 通知栏 —— 进程外 SCA，无需注入（详见模块头注释）
// 纯外观功能，加载失败（如 koffi 原生模块缺失）时降级为 null，绝不能让主程序起不来。
let ShellSurfaceAccent = null;
if (process.platform === 'win32') {
  try {
    ShellSurfaceAccent = require('./taskbar-inject/shellSurfaceAccent');
  } catch (e) {
    console.warn('[Main] 弹层/通知栏模块加载失败（已降级，不影响其它功能）:', e.message);
  }
}
// 托盘溢出区 / 快速设置（WiFi）：这两个只有 XAML 改写能做出真透明，
// 所以走注入 + TAP（和上面那条 SCA/DWM 的路互不替代，用途不同）。
let ShellFlyoutTap = null;
if (process.platform === 'win32') {
  try {
    ShellFlyoutTap = require('./taskbar-inject/shellFlyoutTap');
  } catch (e) {
    console.warn('[Main] 托盘溢出/快速设置模块加载失败（已降级，不影响其它功能）:', e.message);
  }
}

// 「弹出窗口/通知同步任务栏效果」二级独立开关（config.taskbar.flyoutSync）：
// 每个弹层目标（notification=通知中心、overflow=托盘弹窗（含右击弹窗）、
// quicksettings=快速设置）单独决定是否跟随任务栏效果。
// 兼容旧格式：布尔 false = 全关；true/无字段 = 全开（默认）；
// 新格式为对象 { notification, overflow, quicksettings }。
// 迁移：旧配置的 contextmenu（右击菜单栏，2026-09-14 并入托盘弹窗）为 false 时
// 视为用户不想要右击弹窗透明 → overflow 一并视为关。
function flyoutSyncMap(cfg) {
  const tb = (cfg && cfg.taskbar) || {};
  const legacyAllOff = tb.flyoutSync === false;
  const obj = (tb.flyoutSync && typeof tb.flyoutSync === 'object') ? tb.flyoutSync : {};
  const base = !legacyAllOff;
  return {
    notification: base && obj.notification !== false,
    // 旧 contextmenu=false 的用户：右击弹窗和托盘弹窗一起关
    overflow: base && obj.overflow !== false && obj.contextmenu !== false,
    quicksettings: base && obj.quicksettings !== false
  };
}

function taskbarDllPath() {
  return require('path').join(__dirname, 'taskbar-inject', 'taskbarInject.dll');
}

ipcMain.handle('taskbar:get-state', async () => {
  if (!TaskbarAppearance) return { supported: false };
  const st = TaskbarAppearance.getState();
  let probe = { healthy: false, note: '未自检' };
  if (TaskbarInjector) {
    probe = { healthy: await TaskbarInjector.isAlive().catch(() => false) };
  }
  return { ...st, probe };
});

// 开关系统「透明效果」（设置 > 个性化 > 颜色）
ipcMain.handle('taskbar:set-system-transparency', async (_e, enabled) => {
  if (!TaskbarAppearance) return { ok: false, error: '仅 Windows 支持' };
  try {
    const r = TaskbarAppearance.setEnableTransparency(!!enabled);
    return r;
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ============================================================
// Phase B / XAML TAP：任务栏外观（透明/模糊/亚克力）
// ============================================================

// 应用任务栏外观效果
ipcMain.handle('taskbar:apply-effect', async (_e, effect) => {
  if (!TapClient || process.platform !== 'win32') {
    return { ok: false, error: '当前平台不支持（仅 Windows）' };
  }
  try {
    const validEffects = ['transparent', 'blur', 'acrylic', 'normal'];
    if (!validEffects.includes(effect)) {
      return { ok: false, error: '无效的效果类型: ' + effect };
    }
    const r = await TapClient.applyEffect(effect);

    // 弹层 / 通知栏跟随任务栏效果：同宿主窗口每次打开都是新 HWND，交给常驻轮询去套用。
    // 各弹层目标是否跟随由其「二级同步开关」决定（开关逻辑在模块内部按目标处理）。
    if (ShellSurfaceAccent) {
      try {
        ShellSurfaceAccent.setEffect(effect);
        if (effect !== 'normal') {
          if (!ShellSurfaceAccent.getStatus().polling) ShellSurfaceAccent.start();
        } else {
          ShellSurfaceAccent.stop();
        }
      } catch (e) {
        console.warn('[Main] 弹层/通知栏效果同步失败:', e.message);
      }
    }

    // 托盘溢出区 / 快速设置：XAML 改写（真透明），同样跟随任务栏效果。
    // 这两个目标只有"透明 / 默认"两态，非 transparent 一律还原为系统原生。
    // ★ 不 await：syncOnce 里可能有 4~9s 的长超时命令（冻结宿主/无响应模块），
    //   阻塞 IPC 会让连续切换时界面像卡死一样 —— 交给常驻轮询去完成，这里立即返回。
    if (ShellFlyoutTap) {
      try {
        ShellFlyoutTap.setEffect(effect).catch(() => {});
        if (effect !== 'normal') ShellFlyoutTap.start();
      } catch (e) {
        console.warn('[Main] 托盘溢出/快速设置效果同步失败:', e.message);
      }
    }

    return { ok: r.success, effect, ...r };
  } catch (e) {
    console.error('[Main] taskbar:apply-effect 错误:', e);
    return { ok: false, error: e.message };
  }
});

// 应用开始菜单外观效果（独立开关）
ipcMain.handle('startmenu:apply-effect', async (_e, effect) => {
  if (!StartMenuClient || process.platform !== 'win32') {
    return { ok: false, error: '当前平台不支持（仅 Windows）' };
  }
  try {
    const validEffects = ['transparent', 'blur', 'acrylic', 'normal'];
    if (!validEffects.includes(effect)) {
      return { ok: false, error: '无效的效果类型: ' + effect };
    }
    const r = await StartMenuClient.applyEffect(effect);
    return { ok: r.success, effect, ...r };
  } catch (e) {
    console.error('[Main] startmenu:apply-effect 错误:', e);
    return { ok: false, error: e.message };
  }
});

// 「弹出窗口/通知同步任务栏效果」二级独立开关：只影响对应弹层目标，任务栏本身的效果不变。
// 关掉某目标时立即把它还原为系统原生外观；打开时立即按当前任务栏效果应用。
ipcMain.handle('taskbar:set-flyout-sync', async (_e, key, enabled) => {
  if (process.platform !== 'win32') return { ok: false, error: '仅 Windows 支持' };
  const validKeys = ['notification', 'overflow', 'quicksettings'];
  if (!validKeys.includes(key)) return { ok: false, error: '无效的弹层目标: ' + key };
  try {
    const c = ConfigManager.getConfig();
    const syncMap = flyoutSyncMap(c);
    syncMap[key] = !!enabled;
    c.taskbar = Object.assign({}, c.taskbar, { flyoutSync: syncMap });
    ConfigManager.setConfig(c);
    ConfigManager.save();

    // 立即生效：关掉的目标马上还原为原生，打开的马上按当前效果应用（模块内部按目标处理）
    if (ShellSurfaceAccent) {
      try {
        ShellSurfaceAccent.setTargetSync(syncMap);
        const tbEff = c.taskbar.effect || 'normal';
        if (tbEff !== 'normal') {
          if (!ShellSurfaceAccent.getStatus().polling) ShellSurfaceAccent.start();
        }
      } catch (e) {
        console.warn('[Main] 弹层同步开关：弹层/通知栏同步失败:', e.message);
      }
    }
    if (ShellFlyoutTap) {
      try {
        // 不 await（长超时命令交给常驻轮询，避免连续切换时 IPC 卡顿）
        ShellFlyoutTap.setTargetSync(syncMap).catch(() => {});
      } catch (e) {
        console.warn('[Main] 弹层同步开关：托盘/快速设置同步失败:', e.message);
      }
    }
    console.log(`[Main] 弹层同步[${key}] → ${enabled ? '开启' : '关闭'}（${JSON.stringify(syncMap)}）`);
    return { ok: true, key, enabled: !!enabled, flyoutSync: syncMap };
  } catch (e) {
    console.error('[Main] taskbar:set-flyout-sync 错误:', e);
    return { ok: false, error: e.message };
  }
});

// 获取 TAP 状态
ipcMain.handle('taskbar:tap-status', async () => {
  if (!TapClient || process.platform !== 'win32') {
    return { supported: false };
  }
  try {
    const status = await TapClient.getStatus().catch(() => null);
    return {
      supported: true,
      injected: TapClient.isInjected,
      pid: TapClient.injectedPid,
      attachState: status ? status.attachState : 0,
      advised: status ? status.advised : 0,
      attempts: status ? status.attempts : 0,
      lastHr: status ? status.lastHr : 0,
      fillHandle: status ? status.fill : 0,
      events: status ? status.events : 0
    };
  } catch (e) {
    return { supported: true, injected: false, error: e.message };
  }
});

// --- Model Management ---
ipcMain.handle('model:list', () => {
  // 每次列出模型时校验 registry，自动清除失效条目
  return ModelManager.validateRegistry();
});
ipcMain.handle('model:import', async (_e, sourcePath) => {
  const result = await ModelManager.importModel(sourcePath, modelsPath);
  if (result.success) {
    // 自动将导入的模型设为当前模型
    const importedModel = result.data;
    if (importedModel && importedModel.id) {
      const config = ConfigManager.getConfig();
      config.currentModel = importedModel.id;
      ConfigManager.setConfig(config);
    }
    broadcastToWindows('model:imported', result.data);
    // 关键修复：让宠物窗口立即加载并显示刚导入的模型。
    // 之前只广播 model:imported（宠物窗口仅弹气泡、并不加载模型），
    // 导致「导入后模型看不见」——宠物仍停在旧模型/CSS 龙虾形象。
    // 这里单独向宠物窗口发送 model:changed（携带完整模型信息），
    // 复用既有的模型加载逻辑（Live2D / MMD 均覆盖），导入后即时渲染。
    if (petWindow && !petWindow.isDestroyed()) {
      petWindow.webContents.send('model:changed', result.data);
    }
  }
  return result;
});
ipcMain.handle('model:delete', async (_e, modelId) => {
  // 如果删除的是当前模型，清除 currentModel 引用
  const config = ConfigManager.getConfig();
  if (config.currentModel === modelId) {
    config.currentModel = null;
    ConfigManager.setConfig(config);
  }
  return ModelManager.deleteModel(modelId);
});
ipcMain.handle('model:rename', (_e, modelId, newName) => {
  const result = ModelManager.renameModel(modelId, newName);
  if (result.success) {
    // 广播模型列表更新
    broadcastToWindows('init:models', ModelManager.getModelList());
  }
  return result;
});

ipcMain.handle('model:update', (_e, modelId, updates) => {
  const result = ModelManager.updateModel(modelId, updates);
  if (result.success) {
    // 广播模型列表更新，确保主界面/宠物窗口 UI 同步
    broadcastToWindows('init:models', ModelManager.getModelList());
  }
  return result;
});
ipcMain.handle('model:rescan-thumbnail', (_e, modelId) => {
  const result = ModelManager.rescanThumbnail(modelId);
  if (result.success) {
    broadcastToWindows('init:models', ModelManager.getModelList());
  }
  return result;
});

// 读取 / 保存模型动作配置（每模型独立的 actions.json：关键帧动作 + 相关动作 + 待机动作）
ipcMain.handle('model:get', (_e, modelId) => ModelManager.getModelList().find(m => m.id === modelId) || null);
ipcMain.handle('model:get-actions', (_e, modelId) => ModelManager.getActions(modelId));
ipcMain.handle('model:save-actions', (_e, modelId, data) => ModelManager.saveActions(modelId, data));

// 主窗口动作编辑器 → 宠物窗口预览某个关键帧动作定义
ipcMain.handle('pet:preview-action', (_e, def) => {
  if (petWindow && !petWindow.isDestroyed()) {
    petWindow.webContents.send('pet:preview-action', def);
  }
  return true;
});

// 主窗口保存动作配置后，实时推给宠物窗口使其立即生效
ipcMain.handle('pet:set-actions', (_e, data) => {
  if (petWindow && !petWindow.isDestroyed()) {
    petWindow.webContents.send('pet:set-actions', data);
  }
  return true;
});
ipcMain.handle('model:set-current', (_e, modelId) => {
  const config = ConfigManager.getConfig();
  config.currentModel = modelId;
  ConfigManager.setConfig(config);
  if (modelId) {
    // 应用指定模型：直接发送完整模型信息
    const modelInfo = ModelManager.getModelList().find(m => m.id === modelId);
    broadcastToWindows('model:changed', modelInfo || { id: modelId });

    // ★ 自动识别BongoCat模型：启动全局键盘钩子
    if (modelInfo && modelInfo.isBongocat === true) {
      if (!globalKeyboardRunning) {
        globalKeyboardRunning = GlobalKeyboard.startGlobalKeyboardHook((keyData) => {
          if (petWindow && !petWindow.isDestroyed()) {
            petWindow.webContents.send('bongocat:global-keydown', keyData);
          }
        });
        if (globalKeyboardRunning) {
          console.log('[BongoCat] 检测到BongoCat模型，全局键盘钩子已自动启动');
        }
      }
    } else {
      // 非BongoCat模型：停止全局键盘钩子
      if (globalKeyboardRunning) {
        GlobalKeyboard.stopGlobalKeyboardHook();
        globalKeyboardRunning = false;
        console.log('[BongoCat] 切换到普通模型，全局键盘钩子已停止');
      }
    }
  } else {
    // 恢复默认模型：发送 null 信号，停止全局键盘钩子
    broadcastToWindows('model:changed', null);
    if (globalKeyboardRunning) {
      GlobalKeyboard.stopGlobalKeyboardHook();
      globalKeyboardRunning = false;
    }
  }
  return true;
});

ipcMain.handle('model:validate', (_e, modelPath) => ModelManager.validateModel(modelPath));

// 扫描 Live2D 模型目录，返回发现的 motions/expressions 文件（运行时兜底，用于已导入但未补全的旧模型）
ipcMain.handle('model:scan-live2d-dir', (_e, dirPath) => ModelManager.scanLive2DDir(dirPath));

// 加载前自愈 model3.json：确保 Expressions/Motions 形状正确，否则动作模组点了没反应
ipcMain.handle('model:heal-live2d-json', (_e, modelPath) => ModelManager.healLive2DModelJson(modelPath));

// --- File Operations ---
ipcMain.handle('fs:list', (_e, params) => FileOps.list(params));
ipcMain.handle('fs:read', (_e, params) => FileOps.read(params));
ipcMain.handle('fs:write', (_e, params) => FileOps.write(params));
ipcMain.handle('fs:copy', (_e, params) => FileOps.copy(params));
ipcMain.handle('fs:move', (_e, params) => FileOps.move(params));
ipcMain.handle('fs:delete', (_e, params) => FileOps.delete(params));
ipcMain.handle('fs:create-dir', (_e, params) => FileOps.createDir(params));
ipcMain.handle('fs:rename', (_e, params) => FileOps.rename(params));
ipcMain.handle('fs:search', (_e, params) => FileOps.search(params));
ipcMain.handle('fs:get-info', (_e, params) => FileOps.getInfo(params));
ipcMain.handle('fs:open-path', (_e, filePath) => shell.openPath(filePath));
ipcMain.handle('fs:open-in-folder', (_e, filePath) => shell.showItemInFolder(filePath));
ipcMain.handle('fs:select-directory', async () => {
  const result = await dialog.showOpenDialog(mainWindow || petWindow, {
    properties: ['openDirectory', 'createDirectory']
  });
  return result.filePaths;
});
ipcMain.handle('fs:select-files', async (_e, options = {}) => {
  const result = await dialog.showOpenDialog(mainWindow || petWindow, {
    properties: ['openFile', 'multiSelections'],
    filters: options.filters || []
  });
  return result.filePaths;
});
ipcMain.handle('fs:save-file', async (_e, options = {}) => {
  const result = await dialog.showSaveDialog(mainWindow || petWindow, options);
  return result.filePath;
});

// --- Command Operations ---
ipcMain.handle('cmd:execute', (_e, params) => CommandOps.execute(params));
ipcMain.handle('cmd:list-terminals', () => CommandOps.listTerminals());
ipcMain.handle('cmd:kill', (_e, pid) => CommandOps.kill(pid));

// --- Software Install/Uninstall ---
ipcMain.handle('sw:list-installed', () => InstallOps.listInstalled());
ipcMain.handle('sw:install', (_e, params) => InstallOps.install(params));
ipcMain.handle('sw:uninstall', (_e, params) => InstallOps.uninstall(params));
ipcMain.handle('sw:get-install-info', (_e, name) => InstallOps.getInstallInfo(name));

// --- AI Operations ---
ipcMain.handle('ai:list-local-models', () => AIOps.listLocalModels());
ipcMain.handle('ai:import-local-model', (_e, params) => AIOps.importLocalModel(params));
ipcMain.handle('ai:delete-local-model', (_e, modelId) => AIOps.deleteLocalModel(modelId));
// 本地模型「真正可用」：拉起/复用本地推理服务并注册成 provider
ipcMain.handle('ai:use-local-model', (_e, modelId) => AIOps.useLocalModel(modelId));
ipcMain.handle('ai:stop-local-model', () => AIOps.stopLocalModel());
ipcMain.handle('ai:local-engine-status', () => AIOps.getLocalEngineStatus());
ipcMain.handle('ai:detect-local-engine', () => AIOps.detectLocalEngine());
ipcMain.handle('ai:detect-python', () => AIOps.detectPythonEnv());
ipcMain.handle('ai:check-tools', () => AIOps.checkTools());
ipcMain.handle('ai:test-mirrors', (_e, urls) => AIOps.testMirrorConnectivity(urls));
ipcMain.handle('ai:download-tool', (_e, tool, installDir) => AIOps.downloadTool(tool, installDir, (p) => {
  BrowserWindow.getAllWindows().forEach(w => { try { w.webContents.send('ai:tool-download-progress', p); } catch(e){} });
}));
ipcMain.handle('ai:convert-model-to-gguf', (_e, modelId) => AIOps.convertLocalModelToGguf(modelId, (p) => {
  BrowserWindow.getAllWindows().forEach(w => { try { w.webContents.send('ai:tool-download-progress', p); } catch(e){} });
}));
ipcMain.handle('ai:list-cloud-providers', () => AIOps.listCloudProviders());
ipcMain.handle('ai:add-cloud-provider', (_e, params) => AIOps.addCloudProvider(params));
ipcMain.handle('ai:add-provider-by-preset', (_e, presetKey, overrides) => AIOps.addProviderByPreset(presetKey, overrides));
ipcMain.handle('ai:get-provider-presets', () => AIOps.getProviderPresets());
ipcMain.handle('ai:update-cloud-provider', (_e, params) => AIOps.updateCloudProvider(params));
ipcMain.handle('ai:delete-cloud-provider', (_e, id) => AIOps.deleteCloudProvider(id));
ipcMain.handle('ai:fetch-provider-models', (_e, provider) => AIOps.fetchProviderModels(provider));
ipcMain.handle('ai:chat', (_e, params) => AIOps.chat(params, broadcastToWindows));
ipcMain.handle('ai:stream-chat', (_e, params) => AIOps.streamChat(params, broadcastToWindows));
ipcMain.handle('ai:agent-chat', (_e, params) => AIOps.agentChat(params, broadcastToWindows));
ipcMain.handle('ai:get-agent-tools', () => AIOps.getAgentTools());
ipcMain.handle('ai:get-context-meta', () => AIOps.getContextMeta());
ipcMain.handle('ai:cancel', () => { AIOps.cancelChat(); return { success: true }; });
ipcMain.handle('ai:release-gpu', () => AIOps.releaseGPUMemory());
ipcMain.handle('ai:tool-confirm-response', (_e, allowed) => { AIOps.resolveToolConfirm(allowed); return { success: true }; });
// ===== AI 长期记忆（设置面板「AI 记忆」区块）=====
ipcMain.handle('memory:list', (_e, opts) => AIOps.memory.list(opts || {}));
ipcMain.handle('memory:search', (_e, query, limit) => AIOps.memory.search(query, limit));
ipcMain.handle('memory:save', (_e, payload) => AIOps.memory.save(payload || {}));
ipcMain.handle('memory:update', (_e, id, patch) => AIOps.memory.update(id, patch || {}));
ipcMain.handle('memory:delete', (_e, id) => AIOps.memory.remove(id));
ipcMain.handle('memory:clear', () => AIOps.memory.clear());
ipcMain.handle('memory:stats', () => AIOps.memory.stats());
// ===== 待办事项（按会话隔离；清单本身由 todo_* 工具写，这里供界面读取/清理）=====
ipcMain.handle('todo:read', (_e, conversationId) => AIOps.todo.read(conversationId));
ipcMain.handle('todo:write', (_e, conversationId, items, title) => AIOps.todo.write(conversationId, items, title));
ipcMain.handle('todo:update', (_e, conversationId, patch) => AIOps.todo.update(conversationId, patch));
ipcMain.handle('todo:clear', (_e, conversationId) => AIOps.todo.clear(conversationId));
ipcMain.handle('todo:stats', () => AIOps.todo.stats());
// ===== UI 自验证（截图存盘 + 布局自检，供「验证界面」按钮/调试用）=====
ipcMain.handle('ui:capture', (_e, opts) => (opts && opts.title
  ? UiVerify.captureProgramWindow(opts)
  : UiVerify.captureAppWindow(opts || {})));
ipcMain.handle('ui:list-windows', () => UiVerify.listAppWindows());
ipcMain.handle('ui:audit', (_e, opts) => UiVerify.runUiAudit(opts || {}));
ipcMain.handle('ui:shots-dir', () => UiVerify.shotsDir());
// 多角色智能体管理
ipcMain.handle('agent:roles', () => AIOps.getAgentRoles());
ipcMain.handle('agent:role-save', (_e, role) => AIOps.saveAgentRole(role));
ipcMain.handle('agent:role-delete', (_e, roleId) => AIOps.deleteAgentRole(roleId));
// Agent 调用宠物动作
app.on('agent:pet-action', (action) => {
  if (petWindow && !petWindow.isDestroyed()) {
    petWindow.webContents.send('pet:do-action', action);
  }
});
ipcMain.handle('ai:get-status', () => AIOps.getStatus());
ipcMain.handle('ai:ollama-list-models', (_e, host) => AIOps.listOllamaModels(host));
ipcMain.handle('ai:ollama-test', (_e, host) => AIOps.testOllamaConnection(host));

// 桌宠专用对话（不广播到主窗口，避免重复处理）
ipcMain.handle('pet:chat', (_e, params) => AIOps.chat(params, null));
// 桌宠专用 Agent 对话（支持工具调用，结果通过回调返回给宠物窗口）
ipcMain.handle('pet:agent-chat', async (e, params) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  return await AIOps.agentChat(params, (channel, data) => {
    if (win && !win.isDestroyed()) win.webContents.send('pet:agent-event', data);
  });
});


// --- System Info ---
ipcMain.handle('sys:get-info', () => ({
  os: os.platform(),
  arch: os.arch(),
  cpuCount: os.cpus().length,
  totalMem: Math.round(os.totalmem() / 1024 / 1024 / 1024),
  hostname: os.hostname(),
  uptime: os.uptime(),
  freemem: Math.round(os.freemem() / 1024 / 1024 / 1024)
}));

ipcMain.handle('sys:browse-url', (e, url) => shell.openExternal(url));

ipcMain.handle('app:version', () => {
  try { const v = UpdateOps.getCurrentVersion(); if (v) return v; } catch(e) {}
  const pkg = require('../../package.json');
  return pkg.version || '1.0.1';
});

// 崩溃/异常日志：渲染进程上报的 window.error / 未捕获 Promise / WebGL 上下文丢失等
// 统一写入 userData/crash.log，便于定位“闪退”根因（如超大纹理导致显存溢出）。
function writeCrashLog(msg) {
  try {
    const fs = require('fs');
    const ud = app.getPath('userData');
    const file = path.join(ud, 'crash.log');
    const ts = new Date().toLocaleString('zh-CN', { hour12: false });
    const line = '[' + ts + '] ' + msg + '\n';
    fs.appendFileSync(file, line);
  } catch (e) { /* 忽略日志写入失败 */ }
}
ipcMain.handle('app:log-crash', (_e, msg) => {
  writeCrashLog(msg || 'unknown');
  return { success: true };
});
ipcMain.handle('app:get-crash-log', () => {
  try {
    const fs = require('fs');
    const file = path.join(app.getPath('userData'), 'crash.log');
    if (!fs.existsSync(file)) return { success: true, log: '' };
    const log = fs.readFileSync(file, 'utf8');
    return { success: true, log: log.slice(-4000) };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// GPU 进程崩溃（WebGL 上下文大面积丢失的常见表现）：记录并弹窗。
app.on('gpu-process-crashed', (event, killed) => {
  const msg = 'GPU 进程崩溃 killed=' + killed + ' reason=' + (event && event.reason || 'unknown');
  writeCrashLog('[gpu-process-crashed] ' + msg);
  // ★ 使用项目风格对话框替代原生 showErrorBox
  try {
    showProjectDialog({
      type: 'error',
      title: '显卡渲染进程崩溃',
      message: 'Electron GPU 进程崩溃了。',
      detail: '原因：' + msg + '\n\n常见诱因：模型纹理过大（如 8192px）导致显存不足。已自动降级超大纹理，\n若仍崩溃请更换或压缩模型纹理。\n崩溃日志：' + path.join(app.getPath('userData'), 'crash.log'),
      buttons: ['知道了'],
      primaryIndex: 0,
      cancelId: 0,
      parentWindow: mainWindow || petWindow
    }).catch(e => { try { dialog.showErrorBox('显卡渲染进程崩溃', msg); } catch (_) {} });
  } catch (e) {
    try { dialog.showErrorBox('显卡渲染进程崩溃', msg); } catch (_) {}
  }
});

// 退出整个应用（供桌宠右键菜单的"退出"使用）
ipcMain.handle('app:quit', () => {
  isQuitting = true;
  app.quit();
});

// 设置开机自启
ipcMain.handle('app:set-auto-start', (_e, enable) => {
  try {
    const args = ['--auto-started'];
    // 开发模式（未打包）下 execPath 是 node_modules 里的 electron.exe，
    // 必须显式带上应用路径，否则开机启动的是裸 electron，无法加载 AI龙虾
    if (!app.isPackaged) {
      args.unshift('"' + app.getAppPath() + '"');
    }
    app.setLoginItemSettings({
      openAtLogin: !!enable,
      path: process.execPath,
      args
    });
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// 实时应用宠物外观设置到宠物窗口
ipcMain.handle('pet:apply-settings', (_e, settings) => {
  try {
    if (!petWindow || petWindow.isDestroyed()) return { success: false, error: '宠物窗口不存在' };
    if (!lastPetSettings) lastPetSettings = {};

    // 辅助函数：保存/恢复窗口位置，防止 setOpacity 等操作导致位移
    function withPositionPreserved(fn) {
      const [px, py] = petWindow.getPosition();
      fn();
      // 恢复位置（setOpacity / setAlwaysOnTop 在 Windows 上可能导致透明窗口位移）
      const [ax, ay] = petWindow.getPosition();
      if (ax !== px || ay !== py) {
        petWindow.setPosition(px, py);
      }
    }

    // 仅在透明度实际变化时应用（使用四舍五入比较，避免浮点误差）
    // ★ 透明度只作用于模型画布（渲染端通过 --model-opacity 仅控制 canvas），
    //   不再用 petWindow.setOpacity 整体调窗，否则输入框/菜单等 UI 会一并变淡。
    const opacityRounded = typeof settings.opacity === 'number' ? Math.round(settings.opacity * 100) / 100 : undefined;
    const lastOpacityRounded = typeof lastPetSettings.opacity === 'number' ? Math.round(lastPetSettings.opacity * 100) / 100 : undefined;
    if (opacityRounded !== undefined && opacityRounded !== lastOpacityRounded) {
      const actualOpacity = Math.max(0.1, 1 - opacityRounded);
      if (petWindow && !petWindow.isDestroyed()) {
        petWindow.webContents.send('pet:opacity', actualOpacity);
      }
      lastPetSettings.opacity = opacityRounded;
    }

    // 仅在大小实际变化时调整窗口，避免位移
    const sizeRounded = typeof settings.size === 'number' ? Math.round(settings.size * 100) / 100 : undefined;
    const lastSizeRounded = typeof lastPetSettings.size === 'number' ? Math.round(lastPetSettings.size * 100) / 100 : undefined;
    if (sizeRounded !== undefined && sizeRounded !== lastSizeRounded) {
      const baseW = 320;
      const baseH = 460;
      const newW = Math.round(baseW * sizeRounded);
      const newH = Math.round(baseH * sizeRounded);
      const [curW, curH] = petWindow.getSize();
      if (curW !== newW || curH !== newH) {
        const [x, y] = petWindow.getPosition();
        // 保持窗口中心不变
        const newX = Math.round(x + (curW - newW) / 2);
        const newY = Math.round(y + (curH - newH) / 2);
        // 使用 setBounds 原子性地设置位置和大小，避免 setSize+setPosition 的视觉跳跃
        petWindow.setBounds({ x: newX, y: newY, width: newW, height: newH });
        petWindow.webContents.send('pet:resize', { width: newW, height: newH });
        // 大小变化后，同时保存新位置和 newSize 到配置文件
        const cfg = ConfigManager.getConfig();
        cfg.pet = cfg.pet || {};
        cfg.pet.position = { x: newX, y: newY };
        cfg.pet.size = sizeRounded;
        ConfigManager.setConfig(cfg);
      }
      lastPetSettings.size = sizeRounded;
    }

    // 仅在帧率实际变化时应用
    if (typeof settings.frameRate === 'number' && settings.frameRate !== lastPetSettings.frameRate) {
      petWindow.webContents.send('pet:frame-rate', settings.frameRate);
      lastPetSettings.frameRate = settings.frameRate;
    }

    // 仅在始终置顶实际变化时应用
    if (typeof settings.alwaysOnTop === 'boolean' && settings.alwaysOnTop !== lastPetSettings.alwaysOnTop) {
      withPositionPreserved(() => {
        if (settings.alwaysOnTop) {
          petWindow.setAlwaysOnTop(true, 'floating');
        } else {
          petWindow.setAlwaysOnTop(false);
        }
      });
      lastPetSettings.alwaysOnTop = settings.alwaysOnTop;
    }

    // 仅在点击穿透实际变化时应用
    if (typeof settings.clickThrough === 'boolean' && settings.clickThrough !== lastPetSettings.clickThrough) {
      withPositionPreserved(() => {
        // 无论开启还是关闭穿透，都先设为前向穿透模式
        // 开启时：完全穿透（渲染进程设 pointerEvents=none 不再切换）
        // 关闭时：动态穿透（渲染进程根据像素透明度动态切换）
        petWindow.setIgnoreMouseEvents(true, { forward: true });
      });
      petWindow.webContents.send('pet:clickthrough', settings.clickThrough);
      lastPetSettings.clickThrough = settings.clickThrough;
    }

    // 仅在色彩设置实际变化时推送到宠物窗口（实时生效，无需重载）
    if (settings.color && typeof settings.color === 'object') {
      const c = settings.color;
      const last = lastPetSettings.color || {};
      const changed =
        (typeof c.saturation === 'number' && c.saturation !== last.saturation) ||
        (typeof c.brightness === 'number' && c.brightness !== last.brightness) ||
        (typeof c.hue === 'number' && c.hue !== last.hue);
      if (changed) {
        petWindow.webContents.send('pet:color', c);
        lastPetSettings.color = { saturation: c.saturation, brightness: c.brightness, hue: c.hue };
      }
    }

    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// ★ 宠物窗口边界调整：按模型实际渲染边界包裹窗口（去除多余空白区域）
// 渲染进程在模型加载完成后计算实际边界，通知主进程调整窗口大小。
// 若提供 centerX/centerY，则保持窗口中心点不变（调整大小时模型仍在原位）；
// 否则保持窗口左上角位置不变。
ipcMain.handle('pet:set-window-bounds', (_e, { width, height, centerX, centerY }) => {
  try {
    if (!petWindow || petWindow.isDestroyed()) return { success: false, error: '宠物窗口不存在' };
    const w = Math.max(80, Math.round(width));
    const h = Math.max(80, Math.round(height));
    const [curX, curY] = petWindow.getPosition();
    const [curW, curH] = petWindow.getSize();

    let newX = curX;
    let newY = curY;

    if (typeof centerX === 'number' && typeof centerY === 'number') {
      // 保持中心点不变：新位置 = 中心点 - 新尺寸/2
      newX = Math.round(centerX - w / 2);
      newY = Math.round(centerY - h / 2);
    } else {
      // 默认保持中心点不变（相对于当前窗口），避免模型突然位移
      const centerCurX = curX + curW / 2;
      const centerCurY = curY + curH / 2;
      newX = Math.round(centerCurX - w / 2);
      newY = Math.round(centerCurY - h / 2);
    }

    petWindow.setSize(w, h);
    petWindow.setPosition(newX, newY);

    // 记录当前模型边界尺寸，供后续大小调整参考
    if (!lastPetSettings) lastPetSettings = {};
    lastPetSettings.modelBoundsWidth = w;
    lastPetSettings.modelBoundsHeight = h;

    return { success: true, width: w, height: h, x: newX, y: newY };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// --- Chat History ---
const chatHistoryPath = path.join(userDataPath, 'chat_history.json');

ipcMain.handle('chat:save', (_e, history) => {
  try {
    fs.writeFileSync(chatHistoryPath, JSON.stringify(history, null, 2), 'utf-8');
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('chat:load', () => {
  try {
    if (fs.existsSync(chatHistoryPath)) {
      const data = fs.readFileSync(chatHistoryPath, 'utf-8');
      return { success: true, data: JSON.parse(data) };
    }
    return { success: true, data: [] };
  } catch (error) {
    return { success: false, error: error.message, data: [] };
  }
});

ipcMain.handle('chat:clear', () => {
  try {
    fs.writeFileSync(chatHistoryPath, '[]', 'utf-8');
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// --- Windows SAPI 语音识别 ---
// 使用 Windows 内置 System.Speech 进行语音识别，绕过 Electron 的 Web Speech API 限制
// （Electron 中 webkitSpeechRecognition 需要 Google 在线语音服务，无法直接使用）
let activeSpeechProcess = null;

// 检查麦克风权限和设备状态
function checkMicrophoneAccess() {
  try {
    // 使用 PowerShell 检查麦克风设备状态和权限
    const checkScript = `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Speech

# 检查是否有音频输入设备
$audioDevices = Get-CimInstance -ClassName Win32_SoundDevice -ErrorAction SilentlyContinue
$hasInputDevice = $false
foreach ($dev in $audioDevices) {
  if ($dev.Status -eq 'OK') { $hasInputDevice = $true; break }
}

# 尝试创建识别引擎并设置输入（测试权限）
try {
  $engine = New-Object System.Speech.Recognition.SpeechRecognitionEngine
  $engine.SetInputToDefaultAudioDevice()
  $engine.Dispose()
  Write-Output 'OK'
} catch {
  Write-Output ('ERROR:' + $_.Exception.Message)
}
`;
    const checkPath = path.join(os.tmpdir(), `mic_check_${Date.now()}.ps1`);
    fs.writeFileSync(checkPath, '\ufeff' + checkScript, 'utf-8');
    
    const psExe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const result = require('child_process').execSync(
      `"${psExe}" -NoProfile -ExecutionPolicy Bypass -File "${checkPath}"`,
      { timeout: 5000, encoding: 'utf-8' }
    ).trim();
    
    try { fs.unlinkSync(checkPath); } catch (_) {}
    
    console.log('[Speech] 麦克风检查结果:', result);
    return result === 'OK';
  } catch(e) {
    console.error('[Speech] 麦克风检查失败:', e.message);
    return false;
  }
}

ipcMain.handle('speech:recognize', () => {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') {
      resolve({ success: false, error: '当前系统不支持此语音识别方式' });
      return;
    }

    // 如果已有活跃的识别进程，则停止（切换效果）
    if (activeSpeechProcess) {
      try { activeSpeechProcess.kill(); } catch (e) {}
      activeSpeechProcess = null;
      resolve({ success: false, error: 'cancelled' });
      return;
    }

    // 预检查麦克风权限（避免一直弹出权限请求）
    console.log('[Speech] 预检查麦克风权限...');
    const micOk = checkMicrophoneAccess();
    if (!micOk) {
      console.log('[Speech] 麦克风权限检查失败');
      resolve({ 
        success: false, 
        error: '麦克风不可用，请在Windows设置→隐私→麦克风中允许桌面应用访问麦克风，并确保麦克风已连接' 
      });
      return;
    }
    console.log('[Speech] 麦克风权限检查通过');

    // PowerShell 脚本：使用 System.Speech.Recognition 进行语音识别
    // 优先尝试中文识别，失败则回退到系统默认语言
    const script = `$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding

Add-Type -AssemblyName System.Speech

# 1) 识别引擎：优先 zh-CN，失败回退系统默认
try {
  $culture = New-Object System.Globalization.CultureInfo 'zh-CN'
  $engine = New-Object System.Speech.Recognition.SpeechRecognitionEngine $culture
} catch {
  $engine = New-Object System.Speech.Recognition.SpeechRecognitionEngine
}

# 2) 构建听写语法（多方案兜底，且每种都真正尝试 LoadGrammar，失败才换下一种）。
#    某些系统上无参 DictationGrammar 会静默返回 $null，导致原代码 LoadGrammar 报
#    "值不能为 null。参数名: grammar"。因此优先 GrammarBuilder.AppendDictation，
#    失败再回退 DictationGrammar 的多种构造；全失败则明确报错而非静默崩溃。
$loaded = $false
$errs = @()

# 方案A：GrammarBuilder + AppendDictation（最稳，已验证）
if (-not $loaded) {
  try {
    $b = New-Object System.Speech.Recognition.GrammarBuilder
    if ($culture) { $b.Culture = $culture }
    $b.AppendDictation()
    $g = New-Object System.Speech.Recognition.Grammar $b
    $g.Enabled = $true
    $engine.LoadGrammar($g)
    $loaded = $true
  } catch { $errs += ('A:' + $_.Exception.Message) }
}

# 方案B：无参 DictationGrammar
if (-not $loaded) {
  try {
    $g = New-Object System.Speech.Recognition.DictationGrammar
    $g.Enabled = $true
    $engine.LoadGrammar($g)
    $loaded = $true
  } catch { $errs += ('B:' + $_.Exception.Message) }
}

# 方案C：字符串构造 DictationGrammar
if (-not $loaded) {
  foreach ($fmt in @('grammar:dictation', 'grammar:dictation#spelling')) {
    try {
      $g = New-Object System.Speech.Recognition.DictationGrammar $fmt
      $g.Enabled = $true
      $engine.LoadGrammar($g)
      $loaded = $true
      break
    } catch { $errs += ('C:' + $fmt + ':' + $_.Exception.Message) }
  }
}

if (-not $loaded) {
  [Console]::Error.WriteLine('无法创建听写语法: ' + ($errs -join ' | '))
  exit 2
}

# 对短语音指令更友好的超时：6 秒内不开口即结束；说完后停顿 1.2 秒即输出
$engine.InitialSilenceTimeout = [TimeSpan]::FromSeconds(6)
$engine.EndSilenceTimeout = [TimeSpan]::FromSeconds(1.2)

# 设置输入到默认音频设备（如果失败，明确报错）
try {
  $engine.SetInputToDefaultAudioDevice()
} catch {
  [Console]::Error.WriteLine('无法访问麦克风: ' + $_.Exception.Message)
  exit 3
}

$timeout = [TimeSpan]::FromSeconds(10)
$result = $engine.Recognize($timeout)
if ($result) { Write-Output $result.Text }
$engine.Dispose()`;

    const scriptPath = path.join(os.tmpdir(), `speech_${Date.now()}.ps1`);
    // 写 UTF-8 BOM，确保 PowerShell -File 在不同系统代码页下都能正确解析（含中文注释）
    fs.writeFileSync(scriptPath, '﻿' + script, 'utf-8');

    const psExe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    activeSpeechProcess = exec(
      `"${psExe}" -NoProfile -ExecutionPolicy Bypass -File "${scriptPath}"`,
      { timeout: 15000, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        activeSpeechProcess = null;
        try { fs.unlinkSync(scriptPath); } catch (_) {}

        if (err) {
          if (err.killed) {
            resolve({ success: false, error: 'cancelled' });
          } else {
            const errMsg = (stderr || '').trim() || err.message || '未知错误';
            console.error('[Speech] 识别失败:', errMsg);
            
            // 根据错误类型给出更友好的提示
            let userMsg = errMsg.slice(0, 200);
            if (errMsg.includes('无法访问麦克风') || errMsg.includes('exit code 3') || err.code === 3) {
              userMsg = '无法访问麦克风，请在Windows设置→隐私→麦克风中允许桌面应用访问麦克风';
            } else if (errMsg.includes('无法创建听写语法') || errMsg.includes('exit code 2') || err.code === 2) {
              userMsg = '语音识别引擎初始化失败，请确保系统已安装中文语音识别包';
            } else if (errMsg.includes('找不到请求的数据项目') || errMsg.includes('SetInputToDefaultAudioDevice')) {
              userMsg = '麦克风设备绑定失败，请检查麦克风是否正常连接并设为默认设备';
            }
            
            resolve({ success: false, error: userMsg });
          }
          return;
        }

        const text = (stdout || '').trim();
        if (text) {
          resolve({ success: true, text });
        } else {
          resolve({ success: false, error: '未识别到语音内容' });
        }
      }
    );
  });
});

ipcMain.handle('speech:stop', () => {
  if (activeSpeechProcess) {
    try { activeSpeechProcess.kill(); } catch (e) {}
    activeSpeechProcess = null;
  }
  return { success: true };
});

// --- WaveIn 音频录制（主进程采集，避免渲染进程崩溃）---
// 使用 Windows WaveIn API 在主进程中采集麦克风音频，输出 WAV 格式数据
// 渲染进程只负责触发和显示结果，完全不接触音频流，不会导致渲染进程崩溃
ipcMain.handle('speech:record-start', () => {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') {
      resolve({ success: false, error: '当前系统不支持此语音识别方式' });
      return;
    }
    
    if (!WaveInRecorder) {
      resolve({ success: false, error: '音频采集模块未加载' });
      return;
    }
    
    // 检查是否有音频输入设备
    if (!WaveInRecorder.isAvailable()) {
      resolve({ success: false, error: '未检测到麦克风设备，请确保麦克风已正确连接并启用' });
      return;
    }
    
    // 如果已有活跃的录制器，先停止
    if (activeRecorder) {
      try { activeRecorder.stop(); } catch (e) {}
      activeRecorder = null;
    }
    
    try {
      console.log('[Speech] 开始 WaveIn 录制...');
      const recorder = new WaveInRecorder({
        sampleRate: 16000,
        channels: 1,
        bitsPerSample: 16,
        bufferSize: 4096,
        numBuffers: 4
      });
      
      recorder.start();
      activeRecorder = recorder;
      console.log('[Speech] WaveIn 录制已开始');
      resolve({ success: true });
    } catch (e) {
      console.error('[Speech] WaveIn 录制启动失败:', e.message);
      resolve({ success: false, error: '录音启动失败：' + e.message });
    }
  });
});

ipcMain.handle('speech:record-stop', () => {
  return new Promise((resolve) => {
    if (!activeRecorder) {
      resolve({ success: false, error: '未在录制中' });
      return;
    }
    
    try {
      console.log('[Speech] 停止录制...');
      const recorder = activeRecorder;
      activeRecorder = null;
      
      // 停止录制并获取 WAV 数据（MCIRecorder.stop() 返回 ArrayBuffer）
      const wavArrayBuffer = recorder.stop();
      
      if (!wavArrayBuffer || wavArrayBuffer.byteLength === 0) {
        console.log('[Speech] 未录制到音频数据');
        resolve({ success: false, error: '未采集到音频数据' });
        return;
      }
      
      console.log('[Speech] 录制完成，WAV 大小:', wavArrayBuffer.byteLength, 'bytes');
      
      // 直接返回 ArrayBuffer（MCIRecorder.stop() 已经返回 ArrayBuffer）
      resolve({ success: true, wavBuffer: wavArrayBuffer });
    } catch (e) {
      console.error('[Speech] 录制停止失败:', e.message);
      resolve({ success: false, error: '录音停止失败：' + e.message });
    }
  });
});

// --- Windows SAPI 语音识别（从 WAV 数据识别）---
// 渲染进程负责采集麦克风 PCM 并封装成 WAV 传过来，主进程用 SetInputToWaveFile 喂给
// SAPI。这样彻底绕开 SpeechRecognitionEngine.SetInputToDefaultAudioDevice 在部分机器上
// 报"找不到请求的数据项目"的设备绑定问题（WAV 文件输入不依赖默认音频设备）。
ipcMain.handle('speech:recognize-wav', (event, wavBuffer) => {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') {
      resolve({ success: false, error: '当前系统不支持此语音识别方式' });
      return;
    }
    if (!wavBuffer || (wavBuffer.byteLength !== undefined && wavBuffer.byteLength === 0) ||
        (wavBuffer.length !== undefined && wavBuffer.length === 0)) {
      resolve({ success: false, error: '未收到音频数据' });
      return;
    }

    let buf;
    try {
      buf = Buffer.isBuffer(wavBuffer) ? wavBuffer : Buffer.from(wavBuffer);
    } catch (e) {
      resolve({ success: false, error: '音频数据格式错误' });
      return;
    }

    const wavPath = path.join(os.tmpdir(), `speech_in_${Date.now()}.wav`);
    try { fs.writeFileSync(wavPath, buf); } catch (e) {
      resolve({ success: false, error: '无法写入临时音频: ' + e.message });
      return;
    }

    const safeWav = wavPath.replace(/'/g, "''");
    const script = `$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding
Add-Type -AssemblyName System.Speech

try {
  $culture = New-Object System.Globalization.CultureInfo 'zh-CN'
  $engine = New-Object System.Speech.Recognition.SpeechRecognitionEngine $culture
} catch {
  $engine = New-Object System.Speech.Recognition.SpeechRecognitionEngine
}

$loaded = $false
$errs = @()
if (-not $loaded) {
  try {
    $b = New-Object System.Speech.Recognition.GrammarBuilder
    if ($culture) { $b.Culture = $culture }
    $b.AppendDictation()
    $g = New-Object System.Speech.Recognition.Grammar $b
    $g.Enabled = $true
    $engine.LoadGrammar($g)
    $loaded = $true
  } catch { $errs += ('A:' + $_.Exception.Message) }
}
if (-not $loaded) {
  try {
    $g = New-Object System.Speech.Recognition.DictationGrammar
    $g.Enabled = $true
    $engine.LoadGrammar($g)
    $loaded = $true
  } catch { $errs += ('B:' + $_.Exception.Message) }
}
if (-not $loaded) {
  foreach ($fmt in @('grammar:dictation', 'grammar:dictation#spelling')) {
    try {
      $g = New-Object System.Speech.Recognition.DictationGrammar $fmt
      $g.Enabled = $true
      $engine.LoadGrammar($g)
      $loaded = $true
      break
    } catch { $errs += ('C:' + $fmt + ':' + $_.Exception.Message) }
  }
}
if (-not $loaded) {
  [Console]::Error.WriteLine('无法创建听写语法: ' + ($errs -join ' | '))
  exit 2
}

try {
  $engine.SetInputToWaveFile('${safeWav}')
  $timeout = [TimeSpan]::FromSeconds(30)
  $result = $engine.Recognize($timeout)
  if ($result) { Write-Output $result.Text }
  $engine.Dispose()
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}`;

    const scriptPath = path.join(os.tmpdir(), `speech_wav_${Date.now()}.ps1`);
    fs.writeFileSync(scriptPath, '﻿' + script, 'utf-8');

    const psExe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    exec(
      `"${psExe}" -NoProfile -ExecutionPolicy Bypass -File "${scriptPath}"`,
      { timeout: 40000, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        try { fs.unlinkSync(scriptPath); } catch (_) {}
        try { fs.unlinkSync(wavPath); } catch (_) {}
        if (err) {
          const errMsg = (stderr || '').trim() || err.message || '未知错误';
          resolve({ success: false, error: errMsg.slice(0, 200) });
          return;
        }
        const text = (stdout || '').trim();
        if (text) resolve({ success: true, text });
        else resolve({ success: false, error: null });
      }
    );
  });
});

// --- Changelog ---
ipcMain.handle('changelog:get', () => {
  // 优先从最新补丁中读取 changelog.json（支持热更新更新公告）
  try {
    const patchesDir = path.join(app.getPath('userData'), 'patches');
    const appliedFile = path.join(patchesDir, 'applied.json');
    if (fs.existsSync(appliedFile)) {
      const applied = JSON.parse(fs.readFileSync(appliedFile, 'utf-8'));
      if (Array.isArray(applied) && applied.length > 0) {
        // 按版本号降序，找最新的包含 changelog.json 的补丁
        const sorted = [...applied].sort((a, b) => {
          const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
          for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
            if ((pa[i] || 0) !== (pb[i] || 0)) return (pb[i] || 0) - (pa[i] || 0);
          }
          return 0;
        });
        for (const ver of sorted) {
          const clPath = path.join(patchesDir, ver, 'renderer', 'data', 'changelog.json');
          if (fs.existsSync(clPath)) {
            const data = JSON.parse(fs.readFileSync(clPath, 'utf-8'));
            if (Array.isArray(data) && data.length > 0) return data;
          }
        }
      }
    }
  } catch (e) { console.error('[changelog] 读取补丁公告失败:', e.message); }
  return Changelog.getChangelog();
});

// 检查版本更新：比较当前版本与上次记录的版本，返回是否有更新及变更内容
ipcMain.handle('changelog:check-update', () => {
  const pkg = require('../../package.json');
  const currentVersion = pkg.version || '1.0.1';
  const config = ConfigManager.getConfig();
  const lastSeenVersion = config.lastSeenVersion || '';

  if (lastSeenVersion !== currentVersion) {
    // 更新记录的版本
    config.lastSeenVersion = currentVersion;
    ConfigManager.setConfig(config);

    // 返回当前版本的变更内容
    const allChanges = Changelog.getChangelog();
    const versionChanges = allChanges.filter(v => v.version === currentVersion);
    return {
      hasUpdate: true,
      version: currentVersion,
      changes: versionChanges.length > 0 ? versionChanges[0] : null
    };
  }

  return { hasUpdate: false, version: currentVersion };
});


// ========== 应用更新 IPC ==========
ipcMain.handle('update:check', async () => {
  try { return await ElectronUpdater.checkForUpdate(); }
  catch (e) { return { hasUpdate: false, error: e.message, currentVersion: app.getVersion() }; }
});

ipcMain.handle('update:get-version', () => ({ version: ElectronUpdater.getCurrentVersion() }));

ipcMain.handle('update:get-state', () => ElectronUpdater.getUpdateState());

ipcMain.handle('update:get-channel', () => ({ channel: ElectronUpdater.getChannel() }));

ipcMain.handle('update:set-channel', (_e, { channel }) => ElectronUpdater.setChannel(channel));

ipcMain.handle('update:mirror-status', () => ElectronUpdater.getMirrorStatus());
ipcMain.handle('update:mirror-set-index', (_e, { index }) => ElectronUpdater.setMirrorIndex(index));
ipcMain.handle('update:mirror-set-enabled', (_e, { enabled }) => ElectronUpdater.setMirrorEnabled(enabled));
ipcMain.handle('update:mirror-set-custom', (_e, { url }) => ElectronUpdater.setCustomMirror(url));
ipcMain.handle('update:mirror-switch', () => ElectronUpdater.switchToNextMirror());


ipcMain.handle('update:download', async (event, updateInfo) => {
  try {
    if (updateInfo && updateInfo.type === 'patch') {
      const patchInfo = { url: updateInfo.patchUrl, version: updateInfo.version, to: updateInfo.to, from: updateInfo.from, sha256: updateInfo.patchSha256, checksum: updateInfo.patchSha256, requiresRestart: updateInfo.requiresRestart, changes: updateInfo.changes };
      const result = await UpdateOps.downloadPatch(patchInfo, (percent) => { event.sender.send('update:download-progress', { percent, patch: updateInfo }); });
      if (result.success && result.zipPath) {
        const applyResult = UpdateOps.applyPatch(result.zipPath, patchInfo);
        return { success: true, type: 'patch', zipPath: result.zipPath, requiresRestart: updateInfo.requiresRestart };
      }
      return { success: false, error: result.error || '补丁下载失败' };
    }
    const result = await ElectronUpdater.downloadUpdate(updateInfo, (percent) => { event.sender.send('update:download-progress', { percent, patch: updateInfo }); });
    return result;
  } catch (e) { return { success: false, error: e.message }; }
});

ipcMain.handle('update:apply', async () => ElectronUpdater.applyUpdate());
ipcMain.handle('update:verify', (_e, { zipPath, checksum }) => {
  const ok = UpdateOps.verifyChecksum(zipPath, checksum);
  return { success: ok, error: ok ? null : '校验失败' };
});

// ★ 校验数据包：检查已生效的补丁层文件是否与 manifest 声明一致。
// 用于「小补丁不改版本号」场景——版本不变时靠内容哈希判断数据是否完整/被破坏，
// 发现问题时上层可提示用户重新应用修复包自愈。
ipcMain.handle('update:verify-data-package', () => {
  try { return UpdateOps.verifyDataPackage(); }
  catch (e) { return { ok: false, error: e.message, issues: [], checkedVersions: [] }; }
});

ipcMain.handle('update:apply-patch', async (_e, { zipPath, patchInfo }) => {
  try { return UpdateOps.applyPatch(zipPath, patchInfo); }
  catch (e) { return { success: false, error: e.message }; }
});


ipcMain.handle('update:get-full-install', async () => {
  try { return await UpdateOps.getFullInstall(); }
  catch (e) { return { success: false, error: e.message, fullInstall: null }; }
});

ipcMain.handle('update:run-installer', (_e, { installerPath }) => {
  return UpdateOps.runInstallerAndQuit(installerPath);
});

// 完整包下载中心
ipcMain.handle('update:download-full', async (event, fullInstall) => {
  try {
    const result = await UpdateOps.downloadFullPackage(fullInstall, (progress) => {
      event.sender.send('update:full-progress', progress);
    });
    return { success: true, ...result };
  } catch (e) { return { success: false, error: e.message }; }
});

ipcMain.handle('update:get-downloads', () => ({ packages: UpdateOps.getDownloadedPackages() }));

ipcMain.handle('update:delete-download', (_e, { filePath }) => UpdateOps.deleteDownloadedPackage(filePath));

ipcMain.handle('update:show-in-folder', (_e, { filePath }) => {
  const { shell } = require('electron');
  shell.showItemInFolder(filePath);
  return { success: true };
});

ipcMain.handle('update:get-file-icon', async (_e, { filePath }) => {
  try {
    const icon = await app.getFileIcon(filePath, { size: 'large' });
    return { success: true, dataUrl: icon.toDataURL() };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// 下载目录设置
const downloadDirFile = path.join(app.getPath('userData'), 'download-dir.json');
function getDownloadDir() {
  try {
    if (fs.existsSync(downloadDirFile)) {
      const data = JSON.parse(fs.readFileSync(downloadDirFile, 'utf-8'));
      if (data.dir && fs.existsSync(data.dir)) return data.dir;
    }
  } catch (e) {}
  return path.join(app.getPath('userData'), 'downloads');
}
function setDownloadDir(dir) {
  fs.writeFileSync(downloadDirFile, JSON.stringify({ dir, updatedAt: Date.now() }, null, 2), 'utf-8');
}

ipcMain.handle('update:get-download-dir', () => ({ dir: getDownloadDir() }));
ipcMain.handle('update:set-download-dir', (_e, { dir }) => {
  if (!dir || !fs.existsSync(dir)) return { success: false, error: '目录不存在' };
  const oldDir = getDownloadDir();
  let targetDir = dir;
  // 如果目标目录非空，自动创建子目录
  try {
    const entries = fs.readdirSync(dir);
    if (entries.length > 0) {
      targetDir = path.join(dir, 'fuling-shijie-downloads');
      if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
    }
  } catch (e) {}
  // 迁移旧目录中的 exe 文件
  try {
    if (oldDir && fs.existsSync(oldDir) && oldDir !== targetDir) {
      for (const f of fs.readdirSync(oldDir)) {
        if (f.endsWith('.exe')) {
          const src = path.join(oldDir, f);
          const dest = path.join(targetDir, f);
          try { fs.renameSync(src, dest); } catch(e) {
            // 跨盘移动 rename 失败，用 copy + delete
            try {
              fs.copyFileSync(src, dest);
              fs.unlinkSync(src);
            } catch(e2){}
          }
        }
      }
    }
  } catch (e) {}
  setDownloadDir(targetDir);
  UpdateOps.setDownloadsDir(targetDir);
  return { success: true, dir: targetDir };
});
ipcMain.handle('update:reset-download-dir', () => {
  try { fs.unlinkSync(downloadDirFile); } catch(e){}
  const defaultDir = path.join(app.getPath('userData'), 'downloads');
  UpdateOps.setDownloadsDir(defaultDir);
  return { success: true, dir: defaultDir };
});
ipcMain.handle('update:choose-download-dir', async () => {
  const { dialog } = require('electron');
  const result = await dialog.showOpenDialog(mainWindow || petWindow, {
    title: '选择下载目录',
    properties: ['openDirectory', 'createDirectory']
  });
  if (result.canceled || result.filePaths.length === 0) return { canceled: true };
  return { canceled: false, dir: result.filePaths[0] };
});

ipcMain.handle('update:rollback', async (_e, version) => {
  try { return UpdateOps.rollbackToVersion(version); }
  catch (e) { return { success: false, error: e.message }; }
});

ipcMain.handle('update:ignore', (_e, { version, type }) => {
  UpdateOps.ignoreVersion(version, type);
  return { success: true };
});

ipcMain.handle('update:get-backups', () => ({ versions: UpdateOps.getBackupList() }));

ipcMain.handle('app:relaunch', () => { app.relaunch(); app.exit(0); });

// --- Notifications ---
ipcMain.handle('notify:show', (_e, { title, body }) => {
  if (Notification) {
    new Notification({ title, body, icon: path.join(__dirname, '..', '..', 'assets', 'icons', 'icon.png') }).show();
  }
});

// --- Dialogs ---

// 项目风格对话框：通过创建一个小型的无边框 BrowserWindow 加载 projectDialog.html，
// 视觉与 AppDialog 一致（深色卡片 + 主题色按钮 + SVG 图标）。
// 彻底替代 dialog.showMessageBox / showErrorBox，避免在不同 Windows 主题/语言下出现
// 风格与程序其它部分不一致的"OS 原生对话框"（用户反馈"关闭提示弹窗风格不符合要求"）。
function showProjectDialog(opts) {
  const parent = (opts && opts.parentWindow) || mainWindow || petWindow;
  const buttons = (opts && Array.isArray(opts.buttons) && opts.buttons.length) ? opts.buttons : ['确定'];
  const primaryIndex = (opts && typeof opts.primaryIndex === 'number') ? opts.primaryIndex : 0;
  const cancelId = (opts && typeof opts.cancelId === 'number') ? opts.cancelId : Math.max(0, buttons.length - 1);
  const dlgWidth = 480;
  const dlgHeight = opts && opts.detail ? 360 : 260;

  // ★ 计算居中位置 + 屏幕边界检测，确保弹窗居中显示且不会跑出屏幕外
  let centerX, centerY;
  if (parent && !parent.isDestroyed()) {
    const [px, py] = parent.getPosition();
    const [pw, ph] = parent.getSize();
    centerX = px + pw / 2;
    centerY = py + ph / 2;
  } else {
    const display = screen.getPrimaryDisplay();
    const wa = display.workArea;
    centerX = wa.x + wa.width / 2;
    centerY = wa.y + wa.height / 2;
  }
  // 初始居中位置
  let dlgX = Math.round(centerX - dlgWidth / 2);
  let dlgY = Math.round(centerY - dlgHeight / 2);
  // 屏幕边界检测：确保窗口在当前显示器的工作区内
  const display = screen.getDisplayMatching({ x: dlgX, y: dlgY, width: dlgWidth, height: dlgHeight });
  const wa = display.workArea;
  if (dlgX + dlgWidth > wa.x + wa.width) dlgX = wa.x + wa.width - dlgWidth;
  if (dlgY + dlgHeight > wa.y + wa.height) dlgY = wa.y + wa.height - dlgHeight;
  if (dlgX < wa.x) dlgX = wa.x;
  if (dlgY < wa.y) dlgY = wa.y;

  const query = new URLSearchParams({
    type: (opts && opts.type) || 'info',
    title: (opts && opts.title) || '',
    message: (opts && opts.message) || '',
    detail: (opts && opts.detail) || '',
    buttons: JSON.stringify(buttons),
    primaryIndex: String(primaryIndex),
    cancelId: String(cancelId)
  }).toString();

  const win = new BrowserWindow({
    width: dlgWidth,
    height: dlgHeight,
    x: dlgX,
    y: dlgY,
    useContentSize: true,
    minWidth: 360,
    parent: parent || undefined,
    modal: !!parent,
    frame: false,
    // ★ 透明窗口：只显示卡片部分，无遮罩背景，符合"不要遮罩"需求
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    alwaysOnTop: false,
    webPreferences: {
      preload: path.join(__dirname, 'projectDialog.preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  try { win.setMenuBarVisibility(false); } catch (e) {}

  return new Promise((resolve) => {
    let resolved = false;
    const onResult = (_e, index) => {
      if (resolved) return;
      resolved = true;
      try { win.close(); } catch (e) {}
      resolve(typeof index === 'number' ? index : -1);
    };
    ipcMain.on('project-dialog:result', onResult);
    win.on('closed', () => {
      ipcMain.removeListener('project-dialog:result', onResult);
      if (!resolved) { resolved = true; resolve(-1); }
    });
    // ★ 使用 loadURL 手动构建文件 URL，确保查询参数正确传递（loadFile 的 query 选项在某些情况下不可靠）
    const dialogUrl = 'file://' + path.join(__dirname, 'projectDialog.html').replace(/\\/g, '/') + '?' + query;
    win.loadURL(dialogUrl)
      .catch(err => {
        console.error('[projectDialog] loadURL 失败:', err.message);
        if (!resolved) { resolved = true; resolve(-1); }
        try { win.close(); } catch (e) {}
      });
  });
}

ipcMain.handle('dialog:confirm', async (e, { type = 'warning', title, message, detail, buttons = ['确定', '取消'] }) => {
  const parent = BrowserWindow.fromWebContents(e.sender) || mainWindow || petWindow;
  const index = await showProjectDialog({ type, title, message, detail, buttons, primaryIndex: 0, cancelId: buttons.length - 1, parentWindow: parent });
  return index === 0;
});

ipcMain.handle('dialog:error', async (e, { title, message, detail }) => {
  const parent = BrowserWindow.fromWebContents(e.sender) || mainWindow || petWindow;
  await showProjectDialog({
    type: 'error',
    title: title || '出错了',
    message: message || '',
    detail: detail || '',
    buttons: ['知道了'],
    primaryIndex: 0,
    cancelId: 0,
    parentWindow: parent
  });
  return true;
});

// --- 右键菜单（独立窗口，不遮挡模型，样式与退出弹窗一致）---
let projectMenuWindow = null;
let projectMenuParent = null;

function showProjectMenu({ x, y, items, parentWindow }) {
  // 如果已有菜单窗口，先关闭
  if (projectMenuWindow && !projectMenuWindow.isDestroyed()) {
    projectMenuWindow.close();
  }
  projectMenuParent = parentWindow || petWindow;

  const menuWidth = 220;
  // 估算菜单高度（每项约 36px + 分隔线/分组标题）
  const estimatedHeight = Math.min(items.length * 36 + 24, 400);

  // 屏幕边界检测
  const display = screen.getDisplayMatching({ x, y, width: menuWidth, height: estimatedHeight });
  const wa = display.workArea;
  let menuX = x;
  let menuY = y;
  if (menuX + menuWidth > wa.x + wa.width) menuX = wa.x + wa.width - menuWidth;
  if (menuY + estimatedHeight > wa.y + wa.height) menuY = wa.y + wa.height - estimatedHeight;
  if (menuX < wa.x) menuX = wa.x;
  if (menuY < wa.y) menuY = wa.y;

  const query = new URLSearchParams({
    items: encodeURIComponent(JSON.stringify(items))
  }).toString();

  projectMenuWindow = new BrowserWindow({
    width: menuWidth,
    height: estimatedHeight,
    x: menuX,
    y: menuY,
    useContentSize: true,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    focusable: false,
    webPreferences: {
      preload: path.join(__dirname, 'projectMenu.preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  try { projectMenuWindow.setMenuBarVisibility(false); } catch (e) {}
  // 右键菜单专用置顶级别，确保在宠物窗口之上
  try { projectMenuWindow.setAlwaysOnTop(true, 'pop-up-menu'); } catch (e) {}

  // 用 pathToFileURL 正确编码中文路径，避免 ERR_FAILED
  const menuUrl = new URL('file://' + path.join(__dirname, 'projectMenu.html').replace(/\\/g, '/'));
  menuUrl.search = query;
  projectMenuWindow.loadURL(menuUrl.href).catch(err => {
    console.error('[projectMenu] loadURL 失败:', err.message);
  });

  // 点击菜单外部关闭：轮询鼠标位置和左键状态（focusable:false 不会触发 blur）
  let menuCloseTimer = setInterval(() => {
    if (!projectMenuWindow || projectMenuWindow.isDestroyed()) { clearInterval(menuCloseTimer); return; }
    try {
      const pt = screen.getCursorScreenPoint();
      const bounds = projectMenuWindow.getBounds();
      const outside = pt.x < bounds.x || pt.x > bounds.x + bounds.width || pt.y < bounds.y || pt.y > bounds.y + bounds.height;
      if (outside) {
        // 用 Windows API 检测左键是否按下
        const koffi = require('koffi');
        const user32 = koffi.load('user32.dll');
        const GetAsyncKeyState = user32.func('short __stdcall GetAsyncKeyState(int vKey)');
        if ((GetAsyncKeyState(0x01) & 0x8000) !== 0) {
          clearInterval(menuCloseTimer);
          projectMenuWindow.close();
        }
      }
    } catch(e) {}
  }, 50);

  projectMenuWindow.on('closed', () => {
    clearInterval(menuCloseTimer);
    projectMenuWindow = null;
    projectMenuParent = null;
  });
}

// --- 动作模组面板（独立窗口）---
let actionPanelWindow = null;
let actionPanelParent = null;
function showActionPanel({ x, y, actions, parentWindow }) {
  if (actionPanelWindow && !actionPanelWindow.isDestroyed()) actionPanelWindow.close();
  actionPanelParent = parentWindow || petWindow;
  const panelWidth = 280;
  const estimatedHeight = Math.min((actions.length || 1) * 36 + 70, 500);
  const display = screen.getDisplayMatching({ x, y, width: panelWidth, height: estimatedHeight });
  const wa = display.workArea;
  let px = x, py = y;
  if (px + panelWidth > wa.x + wa.width) px = wa.x + wa.width - panelWidth;
  if (py + estimatedHeight > wa.y + wa.height) py = wa.y + wa.height - estimatedHeight;
  if (px < wa.x) px = wa.x;
  if (py < wa.y) py = wa.y;
  const query = new URLSearchParams({ 
    actions: encodeURIComponent(JSON.stringify(actions)),
    theme: ConfigManager.getConfig().system?.theme || 'dark'
  }).toString();
  actionPanelWindow = new BrowserWindow({
    width: panelWidth, height: estimatedHeight, x: Math.round(px), y: Math.round(py),
    useContentSize: true, frame: false, transparent: true, backgroundColor: "#00000000",
    resizable: false, minimizable: false, maximizable: false, skipTaskbar: true,
    focusable: false,
    webPreferences: { preload: path.join(__dirname, "actionPanel.preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: false }
  });
  try { actionPanelWindow.setMenuBarVisibility(false); } catch (e) {}
  actionPanelWindow.setAlwaysOnTop(true, "pop-up-menu");
  const panelUrl = new URL("file://" + path.join(__dirname, "actionPanel.html").replace(/\\/g, "/"));
  panelUrl.search = query;
  actionPanelWindow.loadURL(panelUrl.href).catch(() => {});
  // 点击面板外部关闭（focusable:false 不会触发 blur）
  let panelCloseTimer = setInterval(() => {
    if (!actionPanelWindow || actionPanelWindow.isDestroyed()) { clearInterval(panelCloseTimer); return; }
    try {
      const pt = screen.getCursorScreenPoint();
      const b = actionPanelWindow.getBounds();
      const outside = pt.x < b.x || pt.x > b.x + b.width || pt.y < b.y || pt.y > b.y + b.height;
      if (outside) {
        const koffi = require('koffi');
        const user32 = koffi.load('user32.dll');
        const GetAsyncKeyState = user32.func('short __stdcall GetAsyncKeyState(int vKey)');
        if ((GetAsyncKeyState(0x01) & 0x8000) !== 0) { clearInterval(panelCloseTimer); actionPanelWindow.close(); }
      }
    } catch(e) {}
  }, 50);
  actionPanelWindow.on("closed", () => {
    clearInterval(panelCloseTimer);
    if (actionPanelParent && !actionPanelParent.isDestroyed()) actionPanelParent.webContents.send("action-panel:closed");
    actionPanelWindow = null; actionPanelParent = null;
  });
}
function hideActionPanel() { if (actionPanelWindow && !actionPanelWindow.isDestroyed()) actionPanelWindow.close(); }
ipcMain.handle("pet:show-action-panel", (e, { x, y, actions }) => {
  const parent = BrowserWindow.fromWebContents(e.sender);
  let sx = x, sy = y;
  if (parent && !parent.isDestroyed()) { const [pwx, pwy] = parent.getPosition(); sx = pwx + x; sy = pwy + y; }
  showActionPanel({ x: sx, y: sy, actions, parentWindow: parent });
  return { success: true };
});
ipcMain.handle("pet:hide-action-panel", () => { hideActionPanel(); return { success: true }; });
ipcMain.on("action-panel:trigger", (_e, data) => {
  if (actionPanelParent && !actionPanelParent.isDestroyed()) actionPanelParent.webContents.send("action-panel:trigger", data);
});
ipcMain.on("action-panel:close", () => { hideActionPanel(); });

// --- 输入框（独立窗口）---
let inputBarWindow = null;
let inputBarParent = null;
function showInputBar({ x, y, parentWindow }) {
  if (inputBarWindow && !inputBarWindow.isDestroyed()) { inputBarWindow.moveTop(); return; }
  inputBarParent = parentWindow || petWindow;
  const barWidth = 336, barHeight = 76;
  const display = screen.getDisplayMatching({ x, y, width: barWidth, height: barHeight });
  const wa = display.workArea;
  let bx = x - barWidth / 2, by = y;
  if (bx + barWidth > wa.x + wa.width) bx = wa.x + wa.width - barWidth;
  if (by + barHeight > wa.y + wa.height) by = wa.y + wa.height - barHeight;
  if (bx < wa.x) bx = wa.x;
  if (by < wa.y) by = wa.y;
  inputBarWindow = new BrowserWindow({
    width: barWidth, height: barHeight, x: Math.round(bx), y: Math.round(by),
    useContentSize: true, frame: false, transparent: true, backgroundColor: "#00000000",
    resizable: false, minimizable: false, maximizable: false, skipTaskbar: true,
    focusable: true,
    // ★ 先不显示，随后用 showInactive() 显示：输入框作为独立层级浮在宠物上方，
    //   但不抢宠物窗口焦点（抢焦点会触发宠物 blur → 取消正在进行的拖拽）
    //   focusable 必须为 true，否则输入框无法获得焦点、无法打字
    show: false,
    webPreferences: { preload: path.join(__dirname, "inputBar.preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: false }
  });
  inputBarWindow.setAlwaysOnTop(true, "pop-up-menu");
  try { inputBarWindow.setMenuBarVisibility(false); } catch (e) {}
  inputBarWindow.loadURL("file://" + path.join(__dirname, "inputBar.html").replace(/\\/g, "/")).catch(() => {});
  // ★ 不抢焦点显示：宠物窗口保持焦点，模型仍可正常拖拽
  //   （用户点进输入框时它仍会正常获得焦点，不影响打字）
  try { inputBarWindow.showInactive(); } catch (e) { try { inputBarWindow.show(); } catch (_) {} }
  // ★ 只有"曾经真正获得过焦点"（用户点进去打字）后失焦才自动关闭。
  //   showInactive 显示的窗口从未获得焦点，若也走 blur 自关会一闪就没。
  let inputBarHadFocus = false;
  inputBarWindow.on("focus", () => { inputBarHadFocus = true; });
  inputBarWindow.on("blur", () => {
    if (!inputBarHadFocus) return;
    setTimeout(() => {
      if (inputBarWindow && !inputBarWindow.isDestroyed() && !inputBarWindow.isFocused()) {
        inputBarWindow.close();
      }
    }, 200);
  });
  inputBarWindow.on("closed", () => {
    if (inputBarParent && !inputBarParent.isDestroyed()) inputBarParent.webContents.send("input-bar:closed");
    inputBarWindow = null; inputBarParent = null;
  });
}
function hideInputBar() { if (inputBarWindow && !inputBarWindow.isDestroyed()) inputBarWindow.close(); }
ipcMain.handle("pet:show-input-bar", (e, { x, y }) => {
  const parent = BrowserWindow.fromWebContents(e.sender);
  let sx = x, sy = y;
  if (parent && !parent.isDestroyed()) { const [pwx, pwy] = parent.getPosition(); sx = pwx + x; sy = pwy + y; }
  showInputBar({ x: sx, y: sy, parentWindow: parent });
  return { success: true };
});
ipcMain.handle("pet:hide-input-bar", () => { hideInputBar(); return { success: true }; });
ipcMain.on("input-bar:send", (_e, text) => {
  if (inputBarParent && !inputBarParent.isDestroyed()) inputBarParent.webContents.send("input-bar:send", text);
});
ipcMain.on("input-bar:focus-change", (_e, focused) => {
  if (inputBarParent && !inputBarParent.isDestroyed()) inputBarParent.webContents.send("input-bar:focus-change", focused);
});

// 独立窗口拖动（输入框、动作面板通用）
ipcMain.on("window:drag-move", (e, { dx, dy }) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (win && !win.isDestroyed()) {
    const [x, y] = win.getPosition();
    win.setPosition(x + Math.round(dx), y + Math.round(dy));
  }
});
// 设置窗口绝对位置（用于稳定拖拽）
ipcMain.on("window:set-position", (e, { x, y }) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (win && !win.isDestroyed()) {
    win.setPosition(Math.round(x), Math.round(y));
  }
});
// 拖拽开始：禁止窗口调整大小，防止误触发resize
ipcMain.on("window:drag-start", (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (win && !win.isDestroyed()) {
    win.setResizable(false);
  }
});
// 拖拽结束：恢复窗口调整大小
ipcMain.on("window:drag-end", (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (win && !win.isDestroyed()) {
    win.setResizable(true);
  }
});
// 获取窗口位置
ipcMain.handle("window:get-position", (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (win && !win.isDestroyed()) {
    return win.getPosition();
  }
  return [0, 0];
});
// 菜单项选择：通知父窗口（宠物窗口）执行相应操作
ipcMain.on('project-menu:select', (_e, action) => {
  if (projectMenuParent && !projectMenuParent.isDestroyed()) {
    projectMenuParent.webContents.send('pet:context-menu-action', action);
  }
  if (projectMenuWindow && !projectMenuWindow.isDestroyed()) {
    projectMenuWindow.close();
  }
});

// 菜单关闭
ipcMain.on('project-menu:close', () => {
  if (projectMenuWindow && !projectMenuWindow.isDestroyed()) {
    projectMenuWindow.close();
  }
});

// ★ 设置中关闭右键菜单时调用（从渲染进程主动关闭菜单窗口，释放资源）
ipcMain.handle('pet:close-context-menu', () => {
  if (projectMenuWindow && !projectMenuWindow.isDestroyed()) {
    projectMenuWindow.close();
  }
  return { success: true };
});

// 宠物窗口调用：显示右键菜单
ipcMain.handle('pet:show-context-menu', (e, { x, y, items }) => {
  const parent = BrowserWindow.fromWebContents(e.sender);
  // 将屏幕坐标转换为菜单窗口的位置
  // x, y 是宠物窗口内的坐标，需要加上宠物窗口的位置
  let screenX = x;
  let screenY = y;
  if (parent && !parent.isDestroyed()) {
    const [px, py] = parent.getPosition();
    screenX = px + x;
    screenY = py + y;
  }
  showProjectMenu({ x: screenX, y: screenY, items, parentWindow: parent });
  return { success: true };
});

// ==================== Single Instance Lock ====================

// 单实例锁：防止程序被多次打开，第二次启动时聚焦已有窗口而非新开实例
const isDevMode = process.argv.includes('--dev') || app.commandLine.hasSwitch('dev');
const gotTheLock = isDevMode || app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    // 用户尝试再次启动程序，优先显示主界面
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    } else {
      // 主界面不存在则创建（宠物窗口启动时已自动创建，这里只处理主界面）
      createMainWindow();
      mainWindow.show();
      mainWindow.focus();
    }
    // 同时确保宠物窗口可见
    if (petWindow && !petWindow.isDestroyed() && !petWindow.isVisible()) {
      petWindow.showInactive();
    }
  });
}

// ==================== BongoCat 键盘猫 IPC ====================
// 不再创建独立窗口，改为在宠物窗口中加载BongoCat模型 + 全局键盘钩子
ipcMain.handle('bongocat:get-model', () => {
  const config = ConfigManager.getConfig();
  return config.bongocat ? config.bongocat.modelPath : null;
});

ipcMain.handle('bongocat:set-model', (_e, modelPath) => {
  try {
    if (!modelPath || !fs.existsSync(modelPath)) {
      return { success: false, error: '模型文件不存在: ' + modelPath };
    }
    const config = ConfigManager.getConfig();
    config.bongocat = config.bongocat || {};
    config.bongocat.modelPath = modelPath;
    ConfigManager.setConfig(config);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// 启动BongoCat：在宠物窗口中加载模型 + 启动全局键盘钩子
ipcMain.handle('bongocat:launch', (_e, modelPath) => {
  try {
    const path = modelPath || (ConfigManager.getConfig().bongocat || {}).modelPath;
    if (!path) return { success: false, error: '未配置BongoCat模型路径' };

    // 确保宠物窗口存在
    if (!petWindow || petWindow.isDestroyed()) {
      createPetWindow();
    }

    // 通知宠物窗口加载BongoCat模型
    petWindow.webContents.send('bongocat:load-model', path);

    // 启动全局键盘钩子（窗口失去焦点也能响应键盘）
    if (!globalKeyboardRunning) {
      globalKeyboardRunning = GlobalKeyboard.startGlobalKeyboardHook((keyData) => {
        if (petWindow && !petWindow.isDestroyed()) {
          petWindow.webContents.send('bongocat:global-keydown', keyData);
        }
      });
      if (globalKeyboardRunning) {
        console.log('[BongoCat] 全局键盘钩子已启动');
      }
    }
    // ★ 启动全局鼠标跟踪（鼠标在屏幕任意位置移动时，BongoCat 都能做眼球跟踪）
    if (!globalMouseRunning) {
      globalMouseRunning = GlobalMouse.startGlobalMouseTracking((mouseData) => {
        if (petWindow && !petWindow.isDestroyed()) {
          petWindow.webContents.send('bongocat:global-mousemove', mouseData);
        }
      });
      if (globalMouseRunning) {
        console.log('[BongoCat] 全局鼠标跟踪已启动');
      }
    }

    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// 关闭BongoCat：停止全局键盘钩子和鼠标跟踪
ipcMain.handle('bongocat:close', () => {
  if (globalKeyboardRunning) {
    GlobalKeyboard.stopGlobalKeyboardHook();
    globalKeyboardRunning = false;
    console.log('[BongoCat] 全局键盘钩子已停止');
  }
  if (globalMouseRunning) {
    GlobalMouse.stopGlobalMouseTracking();
    globalMouseRunning = false;
    console.log('[BongoCat] 全局鼠标跟踪已停止');
  }
  return { success: true };
});

// 启动 / 停止全局键盘钩子（由渲染端在 BongoCat 模式启停时统一调用）
// 之前只有「主界面点启动BongoCat按钮」走 bongocat:load-model 路径会在主进程启动钩子，
// 但「从模型列表应用一个 BongoCat 模型」走 model:changed 路径时主进程根本不知道，
// 导致 mouse follow 工作、global keydown 始终不响应 → 「BongoCat 特性不可用」。
ipcMain.handle('bongocat:set-active', (_e, active) => {
  try {
    if (active) {
      if (!globalKeyboardRunning) {
        console.log('[BongoCat] set-active: 开始启动全局键盘钩子...');
        globalKeyboardRunning = GlobalKeyboard.startGlobalKeyboardHook((keyData) => {
          if (petWindow && !petWindow.isDestroyed()) {
            petWindow.webContents.send('bongocat:global-keydown', keyData);
          }
        });
        if (globalKeyboardRunning) {
          console.log('[BongoCat] 全局键盘钩子已启动(set-active) ✓');
        } else {
          console.error('[BongoCat] 全局键盘钩子启动失败(set-active) ✗ - GlobalKeyboard.startGlobalKeyboardHook 返回 false');
        }
      } else {
        console.log('[BongoCat] set-active: 全局键盘钩子已在运行，跳过');
      }
      // ★ 启动全局鼠标跟踪：鼠标在屏幕任意位置移动时，BongoCat 都能做眼球跟踪
      if (!globalMouseRunning) {
        globalMouseRunning = GlobalMouse.startGlobalMouseTracking((mouseData) => {
          if (petWindow && !petWindow.isDestroyed()) {
            petWindow.webContents.send('bongocat:global-mousemove', mouseData);
          }
        });
        if (globalMouseRunning) console.log('[BongoCat] 全局鼠标跟踪已启动(set-active)');
      }
    } else {
      if (globalKeyboardRunning) {
        GlobalKeyboard.stopGlobalKeyboardHook();
        globalKeyboardRunning = false;
        console.log('[BongoCat] 全局键盘钩子已停止(set-active)');
      }
      if (globalMouseRunning) {
        GlobalMouse.stopGlobalMouseTracking();
        globalMouseRunning = false;
        console.log('[BongoCat] 全局鼠标跟踪已停止(set-active)');
      }
    }
    return { success: true, running: !!globalKeyboardRunning, mouseRunning: !!globalMouseRunning };
  } catch (e) {
    console.error('[BongoCat] set-active 异常:', e.message, e.stack);
    return { success: false, error: e.message };
  }
});

ipcMain.handle('bongocat:file-exists', (_e, filePath) => {
  try {
    return fs.existsSync(filePath);
  } catch (e) {
    return false;
  }
});

// ★ 获取模型目录中的键盘叠加层图片列表（resources/left-keys 和 right-keys）
// 之前 preload.js 暴露了 bongocatGetKeyImages 但主进程没有实现这个 IPC 处理器，
// 导致渲染端调用后永远拿不到数据，键盘叠加层完全不工作。
ipcMain.handle('bongocat:get-key-images', (_e, modelDir) => {
  try {
    if (!modelDir || !fs.existsSync(modelDir)) {
      return { left: [], right: [] };
    }
    const imgExts = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'];
    // ★ 递归查找名为 dirName 的目录（兼容模型文件在子目录，如 "镜流 · 标准模式/resources/left-keys"）
    const findKeyDir = (dirName) => {
      let found = null;
      const MAX_DEPTH = 8;
      const scan = (dir, depth) => {
        if (found || depth > MAX_DEPTH) return;
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
        for (const e of entries) {
          if (found) return;
          const full = path.join(dir, e.name);
          if (e.isDirectory()) {
            if (e.name.toLowerCase() === dirName) { found = full; return; }
            scan(full, depth + 1);
          }
        }
      };
      scan(modelDir, 0);
      return found;
    };
    const scanDir = (dir) => {
      if (!dir || !fs.existsSync(dir)) return [];
      try {
        const files = fs.readdirSync(dir);
        return files
          .filter(f => imgExts.includes(path.extname(f).toLowerCase()))
          .map(f => ({
            code: f.replace(/\.[^.]+$/, ''), // 文件名（不含扩展名）作为键名，如 "KeyA"、"Shift"
            file: path.join(dir, f) // 绝对路径
          }));
      } catch (e) {
        return [];
      }
    };
    const result = {
      left: scanDir(findKeyDir('left-keys')),
      right: scanDir(findKeyDir('right-keys'))
    };
    console.log('[BongoCat] get-key-images:', modelDir, 'left=', result.left.length, 'right=', result.right.length);
    return result;
  } catch (e) {
    console.error('[BongoCat] get-key-images 失败:', e.message);
    return { left: [], right: [] };
  }
});

// ==================== 独立调试日志窗口 ====================
// 日志缓存：窗口未打开时缓存日志，打开后一次性发送，避免丢失早期日志
const DEBUG_LOG_CACHE_MAX = 1000;
let debugLogCache = [];

function cacheDebugLog(type, msg) {
  debugLogCache.push({ type, msg, time: Date.now() });
  if (debugLogCache.length > DEBUG_LOG_CACHE_MAX) {
    debugLogCache = debugLogCache.slice(-DEBUG_LOG_CACHE_MAX);
  }
}

// 创建/显示独立调试日志窗口，不受宠物窗口大小限制，可自由拖动和调整大小
function showDebugLogWindow() {
  if (debugLogWindow && !debugLogWindow.isDestroyed()) {
    debugLogWindow.show();
    debugLogWindow.focus();
    return;
  }
  debugLogWindow = new BrowserWindow({
    width: 600,
    height: 500,
    minWidth: 400,
    minHeight: 300,
    frame: false,
    transparent: false,
    backgroundColor: '#0a0a12',
    resizable: true,
    minimizable: true,
    maximizable: true,
    skipTaskbar: false,
    alwaysOnTop: false,
    title: '调试日志',
    webPreferences: {
      preload: path.join(__dirname, 'debugLog.preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  try { debugLogWindow.setMenuBarVisibility(false); } catch (e) {}

  debugLogWindow.loadFile(path.join(__dirname, '..', 'renderer', 'debug-log.html'))
    .catch(err => {
      console.error('[DebugLog] loadFile 失败:', err.message);
    });

  // 窗口加载完成后，把缓存的日志一次性发送过去
  debugLogWindow.webContents.once('did-finish-load', () => {
    if (debugLogCache.length > 0) {
      debugLogWindow.webContents.send('debug-log:batch', debugLogCache);
      console.log('[DebugLog] 已发送缓存日志 ' + debugLogCache.length + ' 条');
    }
  });

  debugLogWindow.on('closed', () => {
    debugLogWindow = null;
  });
}

// 关闭调试日志窗口
function closeDebugLogWindow() {
  if (debugLogWindow && !debugLogWindow.isDestroyed()) {
    debugLogWindow.close();
  }
}

// 切换调试日志窗口显示/隐藏
function toggleDebugLogWindow() {
  if (debugLogWindow && !debugLogWindow.isDestroyed()) {
    if (debugLogWindow.isVisible()) {
      debugLogWindow.hide();
    } else {
      debugLogWindow.show();
      debugLogWindow.focus();
    }
  } else {
    showDebugLogWindow();
  }
}

// 宠物窗口请求打开/切换调试日志窗口
ipcMain.handle('debug-log:toggle', () => {
  toggleDebugLogWindow();
  return { visible: !!(debugLogWindow && debugLogWindow.isVisible()) };
});

// 调试日志窗口请求关闭
ipcMain.handle('debug-log:close', () => {
  closeDebugLogWindow();
  return { success: true };
});

// 宠物窗口发送日志到调试日志窗口（同时缓存，窗口未打开时不丢失）
ipcMain.on('debug-log:send', (_e, type, msg) => {
  cacheDebugLog(type, msg);
  if (debugLogWindow && !debugLogWindow.isDestroyed()) {
    debugLogWindow.webContents.send('debug-log:add', type, msg);
  }
});

// 调试日志页面主动请求缓存的历史日志（页面加载完成后调用，避免推送时机问题导致丢失）
ipcMain.handle('debug-log:request', () => {
  const logs = debugLogCache.slice();
  return { success: true, count: logs.length, logs };
});


// ==================== App Lifecycle ====================

app.whenReady().then(() => {
  // ★ 启动内存与进程优化监控
  try {
    MemoryOptimizer.startMonitoring();
    // 启动后30秒执行一次初始优化
    setTimeout(() => MemoryOptimizer.optimize(), 30000);
  } catch (e) {
    console.error('[MemoryOptimizer] 启动失败:', e.message);
  }

  // 加载自定义下载目录
  try { UpdateOps.setDownloadsDir(getDownloadDir()); } catch(e) {}

  // ★ 初始化 Supabase 认证（配置内置在程序中，正式版用户无需手动填写）
  try {
    SupabaseAuth.init(userDataPath);
  } catch(e) { console.error('[SupabaseAuth] 初始化失败:', e.message); }

  // ★ 初始化 electron-updater（GitHub Releases 更新源）
  try {
    ElectronUpdater.init();
    // 转发更新事件到所有窗口
    ElectronUpdater.on('onProgress', (p) => {
      BrowserWindow.getAllWindows().forEach(w => { try { w.webContents.send('update:download-progress', p); } catch(e){} });
    });
    ElectronUpdater.on('onUpdateAvailable', (info) => {
      BrowserWindow.getAllWindows().forEach(w => { try { w.webContents.send('update:available', info); } catch(e){} });
    });
    ElectronUpdater.on('onDownloaded', (info) => {
      BrowserWindow.getAllWindows().forEach(w => { try { w.webContents.send('update:downloaded', info); } catch(e){} });
    });
    ElectronUpdater.on('onError', (err) => {
      BrowserWindow.getAllWindows().forEach(w => { try { w.webContents.send('update:error', err); } catch(e){} });
    });
  } catch(e) { console.error('[Updater] 初始化失败:', e.message); }
  // 授予麦克风等权限：Electron 默认拒绝媒体设备访问，需要手动授权
  // 支持的权限类型：media(媒体设备)、audioCapture(麦克风)、videoCapture(摄像头)
  const ALLOWED_PERMISSIONS = new Set([
    'media', 'audioCapture', 'videoCapture',
    'clipboard-read', 'clipboard-sanitized-write',
    'fullscreen', 'pointerLock', 'openExternal',
    'notifications', 'geolocation'
  ]);
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    const allowed = ALLOWED_PERMISSIONS.has(permission);
    console.log('[Permission] 请求权限:', permission, '->', allowed ? '允许' : '拒绝');
    callback(allowed);
  });
  session.defaultSession.setPermissionCheckHandler((webContents, permission) => {
    const allowed = ALLOWED_PERMISSIONS.has(permission);
    return allowed;
  });

  // 注册 live2d 自定义协议：将 live2d:///C:/path 转为本地文件路径
  // 使用 protocol.handle（替代已废弃的 registerFileProtocol）
  // 优先用 net.fetch（支持流式），失败时降级到 fs 读取（支持 ASAR 归档）
  const MIME_TYPES = {
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.moc': 'application/octet-stream',
    '.moc3': 'application/octet-stream',
    '.mtn': 'application/octet-stream',
    '.motion3.json': 'application/json',
    '.physics3.json': 'application/json',
    '.cdi3.json': 'application/json',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
  };

  protocol.handle('live2d', async (request) => {
    let url = request.url;
    console.log('[live2d协议] 收到请求:', url);

    // Chromium（standard:true）会将 live2d:///C:/path 规范化为 live2d://c/path
    // 即把盘符 C: 当作 host（小写 c），路径中丢失了 C: 前缀。
    // 这里需要还原正确的文件路径。
    let encodedPath;

    // 情况1：盘符被当作 host — live2d://c/Users/fan/...
    const driveMatch = url.match(/^live2d:\/\/([a-zA-Z])\/(.*)$/);
    if (driveMatch) {
      encodedPath = driveMatch[1].toUpperCase() + ':/' + driveMatch[2];
    } else {
      // 情况2：盘符在路径中 — live2d:///C:/Users/fan/...
      encodedPath = url.replace(/^live2d:\/\//, '').replace(/^\/+/, '');
    }

    const filePath = path.normalize(decodeURIComponent(encodedPath));
    const fileFetchUrl = 'file:///' + encodedPath;
    console.log('[live2d协议] 解析后 filePath=', filePath, 'fileFetchUrl=', fileFetchUrl);

    // 禁用缓存响应头：确保编辑模型/动作源文件后，重载模型即能读到最新文件，
    // 而不会被当前会话内已缓存的旧文件覆盖（这是"改了模型动作文件龙虾却不变"的根因之一）。
    const NO_CACHE_HEADERS = {
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      'Pragma': 'no-cache',
      'Expires': '0'
    };
    function withNoCache(response, extraHeaders) {
      const headers = { ...Object.fromEntries(response.headers || []), ...NO_CACHE_HEADERS };
      if (extraHeaders) Object.assign(headers, extraHeaders);
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers
      });

    }

    // 先尝试 net.fetch（对普通文件路径高效，支持流式读取）
    try {
      const response = await net.fetch(fileFetchUrl);
      console.log('[live2d协议] net.fetch 结果:', response.status, response.ok, fileFetchUrl);
      if (response.ok && response.status === 200) return withNoCache(response);
      console.log('[live2d协议] net.fetch non-200:', response.status, fileFetchUrl);
    } catch (e) {
      console.log('[live2d协议] net.fetch 异常:', e.message, e.code || '', fileFetchUrl);
    }

    // 降级方案：使用 fs 读取（ASAR 感知，能读取打包在 app.asar 内的文件）
    const ext = path.extname(filePath).toLowerCase();
    // 对 .motion3.json / .physics3.json 等双扩展名做更准确的匹配
    let contentType = MIME_TYPES[ext] || 'application/octet-stream';
    if (ext === '.json') {
      // 检查双扩展名
      const doubleExt = path.extname(filePath.slice(0, -ext.length)).toLowerCase() + ext;
      if (MIME_TYPES[doubleExt]) contentType = MIME_TYPES[doubleExt];
    }
    try {
      const stat = fs.statSync(filePath);
      const buffer = await fs.promises.readFile(filePath);
      console.log('[live2d] fs fallback OK:', filePath, '(' + buffer.length + ' bytes)');
      const extraHeaders = { 'Content-Type': contentType };
      try { if (stat && typeof stat.mtimeMs === 'number') extraHeaders['Last-Modified'] = new Date(stat.mtimeMs).toUTCString(); } catch (_) {}
      return new Response(new Uint8Array(buffer), {
        status: 200,
        headers: { ...extraHeaders, ...NO_CACHE_HEADERS }
      });
    } catch (err) {
      console.error('[live2d] fs.readFile failed:', err.message, filePath);
      return new Response(null, { status: 404, statusText: 'Not Found' });
    }
  });

  // patch 自定义协议：将 patch://version/path 映射到 patches 目录
  protocol.handle('patch', async (request) => {
    try {
      const url = new URL(request.url);
      const version = url.hostname;
      const relPath = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
      const patchesDir = UpdateOps.getPatchesDir();
      const filePath = path.join(patchesDir, version, relPath);
      const ext = path.extname(relPath).toLowerCase();
      const mime = {'.html':'text/html','.js':'application/javascript','.css':'text/css','.json':'application/json','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.svg':'image/svg+xml','.woff':'font/woff','.woff2':'font/woff2','.ttf':'font/ttf'}[ext] || 'application/octet-stream';
      // 1. 优先从补丁目录读取
      if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        const data = fs.readFileSync(filePath);
        return new Response(data, { headers: { 'Content-Type': mime } });
      }
      // 2. 回退到 app.asar 原始文件（补丁未覆盖的资源，如 CSS、图片、字体）
      const appPath = app.getAppPath();
      const tryPaths = [
        path.join(appPath, 'src', relPath),
        path.join(appPath, relPath),
      ];
      for (const tp of tryPaths) {
        if (fs.existsSync(tp)) {
          const data = fs.readFileSync(tp);
          return new Response(data, { headers: { 'Content-Type': mime } });
        }
      }
      return new Response('Not Found: ' + relPath, { status: 404 });
    } catch(e) {
      return new Response('Error: ' + e.message, { status: 500 });
    }
  });

  if (!fs.existsSync(path.join(userDataPath, 'config.json'))) {
    ConfigManager.init(configPath);
  }

  // 检查免责声明是否已同意
  const config = ConfigManager.getConfig();
  const disclaimerAccepted = config.disclaimer?.accepted === true;

  createTray();

  if (disclaimerAccepted) {
    // 已同意免责声明：只创建宠物窗口，不弹出主窗口
    createPetWindow();
  } else {
    // 首次安装（未同意免责声明）：弹出主界面显示免责声明，宠物窗口暂不创建
    // 用户同意后通过 IPC 通知主进程创建宠物窗口
    createMainWindow();
  }

  app.on('activate', () => {
    // macOS: 点击 Dock 图标时创建主窗口
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on('window-all-closed', (e) => {
  // 阻止默认退出行为：应用驻留托盘，用户可通过托盘菜单重新打开窗口
  if (!isQuitting) {
    e.preventDefault();
  }
});

app.on('before-quit', () => {
  isQuitting = true;
  // 退出前立即保存宠物窗口位置和大小，下次启动时恢复
  savePetBoundsImmediate();
  // 收掉由我们启动的本地推理服务，否则 llama-server 会留着占显存
  try { AIOps.stopLocalModel(); } catch (e) { /* 忽略 */ }
});

// 退出前把任务栏探针卸掉（若还在驻留），并还原 TAP 外观。
// 自检流程本身是"用完即卸"，这里只是兜底。用 before-quit + 有界等待，避免拖住退出。
let taskbarUnloadDone = false;
app.on('before-quit', (e) => {
  if (taskbarUnloadDone) return;
  taskbarUnloadDone = true;
  e.preventDefault();

  const tasks = [];

  // 还原 TAP 任务栏外观（如果已注入）
  if (TapClient && TapClient.isInjected) {
    tasks.push(TapClient.applyEffect('normal').catch(() => false));
  }

  // 还原开始菜单外观（如果已注入）
  if (StartMenuClient && StartMenuClient.isInjected) {
    tasks.push(StartMenuClient.applyEffect('normal').catch(() => false));
  }

  // 注意：TAP 附着是每个 explorer 生命周期只能一次的不可逆资源
  // （拆除后 InitializeXamlDiagnosticsEx 永久返回 0x80070490，只能重启 explorer 恢复），
  // 所以退出时【绝不卸载】aiLobsterTap.dll，只把效果还原为 normal（Opacity=1），
  // DLL 常驻 explorer 供下次启动复用。重启 explorer 进程才会让 DLL 随宿主消失。

  const bounded = Promise.race([
    Promise.all(tasks),
    new Promise((r) => setTimeout(() => r('timeout'), 2000)),
  ]);
  bounded.then((r) => {
    console.log('[Main] 退出前任务栏清理完成:', r);
    app.quit();
  });
});

app.on('will-quit', () => {
  // 停止全局键盘钩子
  if (globalKeyboardRunning) {
    GlobalKeyboard.stopGlobalKeyboardHook();
    globalKeyboardRunning = false;
  }
  if (petWindow && !petWindow.isDestroyed()) petWindow.close();
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();

  // 本次运行中被改写过的弹层 / 通知栏窗口，退出前还原成系统原生外观，避免残留改动。
  // 只还原"我们改过的"（进程外 SCA 是进程级状态，随窗口销毁而消失；这里做的是显式清理）。
  try {
    if (ShellSurfaceAccent) ShellSurfaceAccent.restoreAll();
  } catch (e) {
    console.warn('[Main] 弹层/通知栏外观还原失败:', e.message);
  }

  // 托盘溢出区 / 快速设置：把 XAML 背景画刷还原成系统原生。
  // ⚠️ 这一步是**异步**的（还原要等宿主下一次视觉树回调，见 shellFlyoutTap 注释），
  //    will-quit 不会等它 —— 所以只是"尽力而为"；正常情况下用户切回"默认"
  //    时就已经还原过了，这里是防"强退"。
  try {
    if (ShellFlyoutTap) {
      ShellFlyoutTap.stop();
      ShellFlyoutTap.restoreAll().catch(() => {});
    }
  } catch (e) {
    console.warn('[Main] 托盘溢出/快速设置还原失败:', e.message);
  }
});

process.on('unhandledRejection', (reason) => {
  try { console.error('Unhandled Rejection:', reason); } catch (e) { /* stdout 可能已断 */ }
});
// （uncaughtException / stdout 断管已由 crashGuard 统一接管，见文件顶部）
