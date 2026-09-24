/**
 * XAML 岛通用注入器
 * 支持注入到任意 Windows 进程（开始菜单、通知中心、搜索等）
 * 使用 koffi + Buffer（与 taskbarInjector.js 一致）
 */

const koffi = require('koffi');
const path = require('path');
const fs = require('fs');
const os = require('os');
const diag = require('./diagLog');

// ============================================================
// Windows API 声明
// ============================================================
const kernel32 = koffi.load('kernel32.dll');

const OpenProcess = kernel32.func('OpenProcess', 'void*', ['uint32', 'int', 'uint32']);
const VirtualAllocEx = kernel32.func('VirtualAllocEx', 'void*', ['void*', 'void*', 'size_t', 'uint32', 'uint32']);
const WriteProcessMemory = kernel32.func('WriteProcessMemory', 'int', ['void*', 'void*', 'void*', 'size_t', 'size_t*']);
const CreateRemoteThread = kernel32.func('CreateRemoteThread', 'void*', ['void*', 'void*', 'size_t', 'void*', 'void*', 'uint32', 'uint32*']);
const CloseHandle = kernel32.func('CloseHandle', 'int', ['void*']);
const GetModuleHandleW = kernel32.func('GetModuleHandleW', 'void*', ['str16']);
const GetProcAddress = kernel32.func('GetProcAddress', 'void*', ['void*', 'str']);
const VirtualFreeEx = kernel32.func('VirtualFreeEx', 'int', ['void*', 'void*', 'size_t', 'uint32']);
const WaitForSingleObject = kernel32.func('WaitForSingleObject', 'uint32', ['void*', 'uint32']);
const GetExitCodeThread = kernel32.func('GetExitCodeThread', 'int', ['void*', 'uint32*']);
const CreateToolhelp32Snapshot = kernel32.func('CreateToolhelp32Snapshot', 'void*', ['uint32', 'uint32']);
const Process32FirstW = kernel32.func('Process32FirstW', 'int', ['void*', 'void*']);
const Process32NextW = kernel32.func('Process32NextW', 'int', ['void*', 'void*']);
const Module32FirstW = kernel32.func('Module32FirstW', 'int', ['void*', 'void*']);
const Module32NextW = kernel32.func('Module32NextW', 'int', ['void*', 'void*']);

// 常量
const PROCESS_CREATE_THREAD = 0x0002;
const PROCESS_QUERY_INFORMATION = 0x0400;
const PROCESS_VM_OPERATION = 0x0008;
const PROCESS_VM_WRITE = 0x0020;
const PROCESS_VM_READ = 0x0010;
const MEM_COMMIT = 0x1000;
const MEM_RESERVE = 0x2000;
const MEM_RELEASE = 0x8000;
const PAGE_READWRITE = 0x04;
const TH32CS_SNAPPROCESS = 0x00000002;
const TH32CS_SNAPMODULE = 0x00000008;
const TH32CS_SNAPMODULE32 = 0x00000010;

/**
 * 确保 DLL 位于可被 LoadLibraryW 加载的路径，返回最终路径；失败返回 null。
 *
 * LoadLibraryW 的三个硬约束（2026-09-13 实测/踩坑）：
 *   1) 路径不能含非 ASCII 字符（中文路径会 LoadLibraryW 失败）；
 *   2) 打包后 DLL 在 app.asar 内，LoadLibraryW 无法从 asar 读取；
 *   3) 源文件必须真实存在。
 * 任一不满足时，把 DLL 复制到纯 ASCII 的临时目录（%TEMP% → C:\Temp → C:\Windows\Temp），
 * 让开发模式与打包版都走同一条可靠路径。
 * @param {string} dllPath  源 DLL 路径（可不存在/在 asar 内/含中文）
 * @param {string} [preferredName] 复制后的文件名（默认取源文件名）
 * @returns {string|null}
 */
function ensureLoadableDll(dllPath, preferredName) {
  const name = preferredName || path.basename(dllPath || '');
  const srcExists = !!dllPath && fs.existsSync(dllPath);
  const isLoadable = srcExists &&
    dllPath.indexOf('app.asar') === -1 &&
    !/[^\x00-\x7F]/.test(dllPath);
  if (isLoadable) return path.resolve(dllPath);

  if (!srcExists) {
    console.error('[GenericInjector] DLL 源文件不存在，无法复制:', dllPath);
    return null;
  }

  // 按优先序尝试纯 ASCII 临时目录（逐个尝试，直到复制成功）
  const candidates = [os.tmpdir(), 'C:\\Temp', 'C:\\Windows\\Temp']
    .filter((d, i, a) => d && a.indexOf(d) === i);
  for (const dir of candidates) {
    try {
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const dest = path.join(dir, name);
      if (/[^\x00-\x7F]/.test(dest)) continue;          // 临时目录本身含中文 → 换下一个
      fs.copyFileSync(dllPath, dest);
      fs.accessSync(dest, fs.constants.R_OK);
      console.log('[GenericInjector] DLL 已复制到可加载路径:', dest);
      return dest;
    } catch (e) {
      // ⚠️ 复制失败最常见的原因是**目标文件正被宿主进程加载**（EBUSY）——
      //    这种情况不该整体失败：现有副本本身就是可用的（同版本时完全等价），
      //    直接复用即可。否则会报出"注入失败"这种误导性错误（实测踩过：
      //    %TEMP% / C:\Temp / C:\Windows\Temp 三个候选全被占用 → 全部注入调用失败）。
      try {
        const dest = path.join(dir, name);
        if (fs.existsSync(dest) && fs.statSync(dest).size > 0) {
          console.log('[GenericInjector] DLL 更新被占用，复用现有副本:', dest);
          return dest;
        }
      } catch (e2) { /* 继续试下一个目录 */ }
    }
  }
  console.error('[GenericInjector] 无法把 DLL 复制到任何可加载路径:', dllPath);
  return null;
}

/**
 * 通用进程注入器
 */
class GenericInjector {
  constructor() {
    this.injections = new Map(); // pid -> { hProcess, dllPath }
  }

  /**
   * 根据进程名获取 PID
   */
  getPidByProcessName(processName) {
    const snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (!snapshot) return null;

    // PROCESSENTRY32W: dwSize(4) + cntUsage(4) + th32ProcessID(4) + th32DefaultHeapID(8) + 
    // th32ModuleID(4) + cntThreads(4) + th32ParentProcessID(4) + pcPriClassBase(4) + dwFlags(4) + szExeFile(520)
    // 64位下总大小 568 字节，szExeFile 偏移 44
    const buf = Buffer.alloc(568);
    buf.writeUInt32LE(568, 0);

    let pid = null;
    let ok = Process32FirstW(snapshot, buf);
    while (ok) {
      const name = buf.toString('utf16le', 44, 44 + 520).split('\0')[0];
      if (name.toLowerCase() === processName.toLowerCase()) {
        pid = buf.readUInt32LE(8);
        break;
      }
      ok = Process32NextW(snapshot, buf);
    }

    CloseHandle(snapshot);
    return pid;
  }

  /**
   * 检查进程中是否已加载指定 DLL
   * @param {number} pid - 进程 ID
   * @param {string|RegExp} dllName - DLL 名称（字符串或正则表达式）
   */
  hasModule(pid, dllName) {
    // 诊断：模块快照查询本身也可能卡（目标进程被冻结时 Toolhelp 快照会变慢），
    // 超 100ms 就落一条日志 —— 轮询每 1.5s 查一次，慢查询会直接拖慢事件循环。
    const t0 = diag.nowMs();
    const snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPMODULE | TH32CS_SNAPMODULE32, pid);
    if (!snapshot) { diag.slow('hasModule', t0, 100, { pid, result: 'no-snapshot' }); return false; }

    // MODULEENTRY32W: 64位下总大小 1080 字节，szModule 偏移 48，长度 256 字符(512字节)
    const buf = Buffer.alloc(1080);
    buf.writeUInt32LE(1080, 0);

    let found = false;
    let ok = Module32FirstW(snapshot, buf);
    while (ok) {
      const name = buf.toString('utf16le', 48, 48 + 520).split('\0')[0];
      if (dllName instanceof RegExp) {
        if (dllName.test(name)) {
          found = true;
          break;
        }
      } else if (name.toLowerCase() === String(dllName).toLowerCase()) {
        found = true;
        break;
      }
      ok = Module32NextW(snapshot, buf);
    }

    CloseHandle(snapshot);
    diag.slow('hasModule', t0, 100, { pid, dll: String(dllName), result: found ? 'found' : 'missing' });
    return found;
  }

  /**
   * 注入 DLL 到指定进程
   */
  inject(pid, dllPath) {
    const t0 = diag.nowMs();
    if (!pid) {
      console.error('[GenericInjector] 无效的 PID');
      return false;
    }

    if (!fs.existsSync(dllPath)) {
      console.error('[GenericInjector] DLL 文件不存在:', dllPath);
      return false;
    }

    const dllName = path.basename(dllPath);
    if (this.hasModule(pid, dllName)) {
      diag.event('inject', { pid, dll: dllName, ms: Math.round(diag.nowMs() - t0), skipped: 'already-loaded' });
      return true;
    }

    const access = PROCESS_CREATE_THREAD | PROCESS_QUERY_INFORMATION |
                   PROCESS_VM_OPERATION | PROCESS_VM_WRITE | PROCESS_VM_READ;
    const hProcess = OpenProcess(access, 0, pid);
    if (!hProcess) {
      console.error('[GenericInjector] 打开进程失败:', pid);
      return false;
    }

    try {
      const dllPathBuf = Buffer.from(dllPath + '\0', 'utf16le');
      const remoteMem = VirtualAllocEx(hProcess, null, dllPathBuf.length, MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE);
      if (!remoteMem) {
        console.error('[GenericInjector] 分配远程内存失败');
        return false;
      }

      const bytesWritten = [0];
      const writeResult = WriteProcessMemory(hProcess, remoteMem, dllPathBuf, dllPathBuf.length, bytesWritten);
      if (!writeResult) {
        console.error('[GenericInjector] 写入远程内存失败');
        VirtualFreeEx(hProcess, remoteMem, 0, MEM_RELEASE);
        return false;
      }

      const loadLibraryAddr = GetProcAddress(GetModuleHandleW('kernel32.dll'), 'LoadLibraryW');
      if (!loadLibraryAddr) {
        console.error('[GenericInjector] 获取 LoadLibraryW 地址失败');
        VirtualFreeEx(hProcess, remoteMem, 0, MEM_RELEASE);
        return false;
      }

      const threadId = [0];
      const hThread = CreateRemoteThread(hProcess, null, 0, loadLibraryAddr, remoteMem, 0, threadId);
      if (!hThread) {
        console.error('[GenericInjector] 创建远程线程失败');
        VirtualFreeEx(hProcess, remoteMem, 0, MEM_RELEASE);
        return false;
      }

      // ★ 等待上限 5000 → 300ms（2026-09-14 卡顿真凶）：
      //   WaitForSingleObject 是**同步**调用，跑在 Electron 主进程事件循环上。
      //   目标宿主（ShellExperienceHost 等）空闲时被内核冻结，远程线程根本不被调度
      //   —— 等 5 秒 = 主进程整卡 5 秒（所有窗口 IPC/托盘全部冻结，表现为"系统异常卡顿"，
      //   且宿主被系统频繁回收重建 → 每次打开面板都可能注入 → 每次都卡）。
      //   等不到就先返回 false：常驻轮询的 hasModule 会在模块真正加载后自动接管
      //   （ensureInjected 每轮先查 hasModule，已加载就不再注入）。
      //   ⚠️ 线程没退出时**绝不能** VirtualFreeEx 远程缓冲 —— LoadLibraryW 还没读到
      //      路径字符串，先释放会在宿主里引发访问违规 → 宁可泄漏这几百字节。
      const WAIT_OBJECT_0 = 0;
      const waitStart = diag.nowMs();
      const waitRc = WaitForSingleObject(hThread, 300);
      const waitMs = Math.round(diag.nowMs() - waitStart);
      if (waitRc === WAIT_OBJECT_0) {
        const exitCode = [0];
        GetExitCodeThread(hThread, exitCode);
        CloseHandle(hThread);
        VirtualFreeEx(hProcess, remoteMem, 0, MEM_RELEASE);
      } else {
        // 线程还挂着（宿主冻结/繁忙）：只关自己的句柄，远程缓冲留给它用
        CloseHandle(hThread);
        console.log('[GenericInjector] 远程线程 300ms 内未退出（宿主可能被冻结），交给轮询确认加载');
      }

      // 检查 DLL 是否真的加载了（LoadLibraryW 返回 0 可能是因为路径编码问题，但 DLL 可能已经加载）
      const loaded = this.hasModule(pid, path.basename(dllPath));
      // 诊断：注入是卡顿的最大嫌疑点 —— 无论成败都落一条（注入本来就低频）
      diag.event('inject', {
        pid, dll: dllName, totalMs: Math.round(diag.nowMs() - t0),
        waitMs, waitRc: waitRc === WAIT_OBJECT_0 ? 'signaled' : 'timeout', loaded
      });
      if (!loaded) {
        console.error('[GenericInjector] DLL 未在目标进程中找到，注入可能失败');
        return false;
      }

      console.log('[GenericInjector] 注入成功: pid=' + pid + ' dll=' + dllName);
      this.injections.set(pid, { hProcess, dllPath });
      return true;
    } catch (e) {
      console.error('[GenericInjector] 注入异常:', e.message);
      diag.event('inject', { pid, dll: path.basename(dllPath || ''), totalMs: Math.round(diag.nowMs() - t0), error: e.message });
      return false;
    }
  }

  /**
   * 清理指定进程的注入资源
   */
  cleanup(pid) {
    const inj = this.injections.get(pid);
    if (inj && inj.hProcess) {
      CloseHandle(inj.hProcess);
    }
    this.injections.delete(pid);
  }

  /**
   * 清理所有注入资源
   */
  cleanupAll() {
    for (const pid of this.injections.keys()) {
      this.cleanup(pid);
    }
  }
}

module.exports = new GenericInjector();
module.exports.GenericInjector = GenericInjector;
module.exports.ensureLoadableDll = ensureLoadableDll;
