/**
 * 任务栏透明化 - Explorer进程注入模块
 * 使用DLL注入技术，将任务栏透明化DLL注入到Explorer进程中
 * 参考 TranslucentTB 实现原理
 */

const koffi = require('koffi');
const path = require('path');
const fs = require('fs');
const genericInjector = require('./genericInjector');

// ============================================================
// Windows API 声明
// ============================================================

// 加载 kernel32.dll
const kernel32 = koffi.load('kernel32.dll');

// OpenProcess - 打开进程
const OpenProcess = kernel32.func('OpenProcess', 'void*', ['uint32', 'int', 'uint32']);

// VirtualAllocEx - 在目标进程中分配内存
const VirtualAllocEx = kernel32.func('VirtualAllocEx', 'void*', ['void*', 'void*', 'size_t', 'uint32', 'uint32']);

// WriteProcessMemory - 写入进程内存
const WriteProcessMemory = kernel32.func('WriteProcessMemory', 'int', ['void*', 'void*', 'void*', 'size_t', 'size_t*']);

// CreateRemoteThread - 创建远程线程
const CreateRemoteThread = kernel32.func('CreateRemoteThread', 'void*', ['void*', 'void*', 'size_t', 'void*', 'void*', 'uint32', 'uint32*']);

// CloseHandle - 关闭句柄
const CloseHandle = kernel32.func('CloseHandle', 'int', ['void*']);

// GetModuleHandleW - 获取模块句柄
const GetModuleHandleW = kernel32.func('GetModuleHandleW', 'void*', ['str16']);

// GetProcAddress - 获取函数地址
const GetProcAddress = kernel32.func('GetProcAddress', 'void*', ['void*', 'str']);

// VirtualFreeEx - 释放进程内存
const VirtualFreeEx = kernel32.func('VirtualFreeEx', 'int', ['void*', 'void*', 'size_t', 'uint32']);

// WaitForSingleObject - 等待对象
const WaitForSingleObject = kernel32.func('WaitForSingleObject', 'uint32', ['void*', 'uint32']);

// GetExitCodeThread - 取远程线程返回值（= LoadLibraryW 返回的 HMODULE；0 表示加载失败）
const GetExitCodeThread = kernel32.func('GetExitCodeThread', 'int', ['void*', 'uint32*']);

// 模块枚举：用来确认 DLL 是不是真的进了 explorer（CreateRemoteThread 成功 ≠ DLL 加载成功）
const CreateToolhelp32Snapshot = kernel32.func('CreateToolhelp32Snapshot', 'void*', ['uint32', 'uint32']);
const Module32FirstW = kernel32.func('Module32FirstW', 'int', ['void*', 'void*']);
const Module32NextW = kernel32.func('Module32NextW', 'int', ['void*', 'void*']);

// 加载 psapi.dll (用于枚举进程)
let psapi = null;
try {
  psapi = koffi.load('psapi.dll');
} catch (e) {
  // psapi可能在某些系统上不可用
}

// EnumProcesses - 枚举进程
let EnumProcesses = null;
if (psapi) {
  try {
    EnumProcesses = psapi.func('EnumProcesses', 'int', ['uint32*', 'uint32', 'uint32*']);
  } catch (e) {}
}

// 加载 user32.dll
const user32 = koffi.load('user32.dll');

// GetWindowThreadProcessId - 获取窗口所属进程ID
const GetWindowThreadProcessId = user32.func('GetWindowThreadProcessId', 'uint32', ['void*', 'uint32*']);

// FindWindowW - 查找窗口
const FindWindowW = user32.func('FindWindowW', 'void*', ['str16', 'str16']);

// ============================================================
// 常量定义
// ============================================================

// 进程访问权限
const PROCESS_ALL_ACCESS = 0x1F0FFF;
const PROCESS_CREATE_THREAD = 0x0002;
const PROCESS_QUERY_INFORMATION = 0x0400;
const PROCESS_VM_OPERATION = 0x0008;
const PROCESS_VM_WRITE = 0x0020;
const PROCESS_VM_READ = 0x0010;

// 内存分配常量
const MEM_COMMIT = 0x1000;
const MEM_RESERVE = 0x2000;
const MEM_RELEASE = 0x8000;
const PAGE_READWRITE = 0x04;

// ============================================================
// 命名管道通信
// ============================================================
// 管道名每次装载都唯一（含 explorer pid + 装载时刻），由客户端枚举 \\.\pipe\ 发现，
// 详见 pipeClient.js。这样历史遗留的"僵尸实例"只会被跳过，不会让功能整体失效。
const pipeClient = require('./pipeClient');

/**
 * 发送命令到注入的DLL（带重试）
 */
async function sendCommand(command, timeout = 3000, retries = 3) {
  let lastErr = null;
  for (let i = 0; i < retries; i++) {
    try {
      return await pipeClient.send(command, timeout);
    } catch (e) {
      lastErr = e;
      pipeClient.invalidate();   // 清缓存，下次重新枚举发现
      if (i < retries - 1) await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  throw lastErr;
}

// ============================================================
// 任务栏透明化注入类
// ============================================================

class TaskbarInjector {
  constructor() {
    this.dllPath = null;
    this.isInjected = false;
    this.injectedPid = null;      // 注入时的 explorer pid；变了就说明 explorer 重启过，必须重注入
    this.hProcess = null;
    this.hThread = null;
    this.remoteMem = null;
  }

  /**
   * 获取Explorer进程ID
   */
  getExplorerPid() {
    // 方法1: 通过任务栏窗口获取进程ID
    const hwnd = FindWindowW('Shell_TrayWnd', null);
    if (hwnd) {
      const pidBuf = Buffer.alloc(4);
      GetWindowThreadProcessId(hwnd, pidBuf);
      const pid = pidBuf.readUInt32LE(0);
      if (pid > 0) return pid;
    }

    // 方法2: 枚举进程查找explorer.exe
    if (EnumProcesses) {
      const pids = Buffer.alloc(4096);
      const needed = Buffer.alloc(4);
      if (EnumProcesses(pids, 4096, needed)) {
        const count = needed.readUInt32LE(0) / 4;
        for (let i = 0; i < count; i++) {
          const pid = pids.readUInt32LE(i * 4);
          // 这里简化处理，实际应该检查进程名
          // 由于koffi的限制，我们使用另一种方法
        }
      }
    }

    // 方法3: 使用tasklist命令
    try {
      const { execSync } = require('child_process');
      const output = execSync('tasklist /fi "imagename eq explorer.exe" /fo csv /nh', { encoding: 'utf8' });
      const match = output.match(/"explorer\.exe","(\d+)"/);
      if (match) {
        return parseInt(match[1], 10);
      }
    } catch (e) {}

    return null;
  }

  /**
   * 注入DLL到Explorer进程
   */
  inject(dllPath) {
    if (this.isInjected) {
      console.log('[TaskbarInjector] DLL已注入，跳过');
      return true;
    }

    try {
      // 检查DLL文件是否存在
      if (!fs.existsSync(dllPath)) {
        console.error('[TaskbarInjector] DLL文件不存在:', dllPath);
        return false;
      }

      this.dllPath = path.resolve(dllPath);

      // 获取Explorer进程ID
      const pid = this.getExplorerPid();
      if (!pid) {
        console.error('[TaskbarInjector] 未找到Explorer进程');
        return false;
      }
      console.log('[TaskbarInjector] Explorer进程ID:', pid);

      // 打开进程
      const access = PROCESS_CREATE_THREAD | PROCESS_QUERY_INFORMATION |
                     PROCESS_VM_OPERATION | PROCESS_VM_WRITE | PROCESS_VM_READ;
      this.hProcess = OpenProcess(access, 0, pid);
      if (!this.hProcess) {
        console.error('[TaskbarInjector] 打开进程失败');
        return false;
      }

      // 在目标进程中分配内存
      const dllPathBuf = Buffer.from(this.dllPath + '\0', 'utf16le');
      this.remoteMem = VirtualAllocEx(
        this.hProcess,
        null,
        dllPathBuf.length,
        MEM_COMMIT | MEM_RESERVE,
        PAGE_READWRITE
      );
      if (!this.remoteMem) {
        console.error('[TaskbarInjector] 分配远程内存失败');
        this.cleanup();
        return false;
      }

      // 写入DLL路径到目标进程内存
      const bytesWritten = Buffer.alloc(8);
      const writeResult = WriteProcessMemory(
        this.hProcess,
        this.remoteMem,
        dllPathBuf,
        dllPathBuf.length,
        bytesWritten
      );
      if (!writeResult) {
        console.error('[TaskbarInjector] 写入远程内存失败');
        this.cleanup();
        return false;
      }

      // 获取LoadLibraryW的地址
      const hKernel32 = GetModuleHandleW('kernel32.dll');
      const loadLibraryAddr = GetProcAddress(hKernel32, 'LoadLibraryW');
      if (!loadLibraryAddr) {
        console.error('[TaskbarInjector] 获取LoadLibraryW地址失败');
        this.cleanup();
        return false;
      }

      // 创建远程线程，调用LoadLibraryW加载DLL
      this.hThread = CreateRemoteThread(
        this.hProcess,
        null,
        0,
        loadLibraryAddr,
        this.remoteMem,
        0,
        null
      );
      if (!this.hThread) {
        console.error('[TaskbarInjector] 创建远程线程失败');
        this.cleanup();
        return false;
      }

      // 等待线程结束，并读取它的返回值 = LoadLibraryW 的返回值（HMODULE）
      // 注意：CreateRemoteThread 成功**不代表** DLL 加载成功，必须看这个返回值。
      WaitForSingleObject(this.hThread, 5000);
      let loadResult = 0;
      try {
        const ec = Buffer.alloc(4);
        GetExitCodeThread(this.hThread, ec);
        loadResult = ec.readUInt32LE(0);
      } catch (e) { /* 取不到就靠 PING 复核 */ }
      CloseHandle(this.hThread);
      this.hThread = null;

      this.injectedPid = pid;

      if (!loadResult) {
        console.error('[TaskbarInjector] LoadLibraryW 返回 0：DLL 加载失败（依赖缺失或架构不符？）');
        this.cleanup();
        return false;
      }

      console.log(`[TaskbarInjector] DLL 注入成功: ${this.dllPath} (pid=${pid}, HMODULE=0x${(loadResult >>> 0).toString(16)})`);
      this.isInjected = true;
      return true;
    } catch (e) {
      console.error('[TaskbarInjector] 注入失败:', e.message);
      this.cleanup();
      return false;
    }
  }

  /**
   * 清理资源
   */
  cleanup() {
    if (this.hThread) {
      CloseHandle(this.hThread);
      this.hThread = null;
    }
    if (this.remoteMem && this.hProcess) {
      VirtualFreeEx(this.hProcess, this.remoteMem, 0, MEM_RELEASE);
      this.remoteMem = null;
    }
    if (this.hProcess) {
      CloseHandle(this.hProcess);
      this.hProcess = null;
    }
    this.isInjected = false;
  }

  /**
   * 测试DLL是否响应
   */
  async ping() {
    try {
      const response = await sendCommand('PING', 1000);
      console.log('[TaskbarInjector] PING响应:', response);
      return response === 'PONG';
    } catch (e) {
      console.log('[TaskbarInjector] PING失败:', e.message);
      return false;
    }
  }

  /**
   * 枚举 explorer 已加载模块，确认某个 DLL 是否真的驻留。
   * @param {number} pid
   * @param {RegExp} pattern 模块名匹配（默认匹配本项目的 SCA 探针）
   */
  hasModule(pid, pattern = /taskbarInject/i) {
    try {
      const snap = CreateToolhelp32Snapshot(0x08 | 0x10, pid);
      if (!snap) return false;
      const buf = Buffer.alloc(1080);
      buf.writeUInt32LE(1080, 0);
      let found = false;
      let ok = Module32FirstW(snap, buf);
      while (ok) {
        const name = buf.toString('utf16le', 48, 48 + 520).split('\0')[0];
        if (pattern.test(name)) { found = true; break; }
        ok = Module32NextW(snap, buf);
      }
      CloseHandle(snap);
      return found;
    } catch (e) {
      return false;
    }
  }

  /** 列出 explorer 里所有匹配 pattern 的模块名 */
  listModules(pid, pattern = /taskbarInject/i) {
    const out = [];
    try {
      const snap = CreateToolhelp32Snapshot(0x08 | 0x10, pid);
      if (!snap) return out;
      const buf = Buffer.alloc(1080);
      buf.writeUInt32LE(1080, 0);
      let ok = Module32FirstW(snap, buf);
      while (ok) {
        const name = buf.toString('utf16le', 48, 48 + 520).split('\0')[0];
        if (pattern.test(name)) out.push(name);
        ok = Module32NextW(snap, buf);
      }
      CloseHandle(snap);
    } catch (e) { /* noop */ }
    return out;
  }

  /**
   * 探针是否真的可用（PING 有应答）。
   * 这是**唯一可信**的"已注入"判据 —— 不能信 isInjected 布尔值：
   * explorer 重启后 DLL 早没了、内部状态也没了，但标志还写着 true（历史 bug，实测过）。
   */
  async isAlive() {
    return this.ping();
  }

  /**
   * 确保探针健康：explorer 重启 / 管道失联时**自动重新注入**，而不是留着假的 isInjected。
   * @returns {Promise<{healthy:boolean, pid:number|null, reinjected:boolean, reason?:string}>}
   */
  async ensureHealthy(dllPath) {
    const pid = this.getExplorerPid();
    if (!pid) {
      return { healthy: false, pid: null, reinjected: false, reason: '找不到 explorer（Shell_TrayWnd 不存在）' };
    }

    // 1) 探针还活着就直接复用
    if (await this.ping()) {
      this.isInjected = true;
      this.injectedPid = pid;
      return { healthy: true, pid, reinjected: false, reason: '探针在线' };
    }

    // 2) 不活着：explorer 重启过 / 管道断了 / 从未注入 → 重新注入
    const pidChanged = this.injectedPid !== null && this.injectedPid !== pid;
    this.isInjected = false;
    if (!this.inject(dllPath || this.dllPath)) {
      return { healthy: false, pid, reinjected: false, reason: '注入失败' };
    }

    // 3) 等探针起来（DLL 的 worker 线程需要一点时间建管道）
    for (let i = 0; i < 6; i++) {
      await new Promise((r) => setTimeout(r, 400));
      if (await this.ping()) {
        return {
          healthy: true, pid, reinjected: true,
          reason: pidChanged ? '检测到 explorer 重启，已自动重注入' : '首次注入成功',
        };
      }
    }
    return { healthy: false, pid, reinjected: false, reason: '注入后探针未响应（检查 %TEMP%\\ai_lobster_taskbar.log）' };
  }

  /**
   * 【实验性 · 默认禁用】改写任务栏 accent 参数。
   *
   * ⚠️ 2026-09-12 实测：在 explorer 进程内改写 shell 自己设的 accent → **explorer 崩溃重启**。
   *    所以这里默认直接拒绝；必须显式设置环境变量
   *    `AI_LOBSTER_TASKBAR_EXPERIMENTAL_ACCENT=1` 才放行（仅供受控环境下继续做 ExplorerTAP 方向验证）。
   *    命令协议是 `APPLY:<state>[:flags[:colorABGR]]`（旧代码写成 EFFECT:，是错的）。
   */
  async applyAccentOverride(state, flags = 2, color = 0) {
    if (process.env.AI_LOBSTER_TASKBAR_EXPERIMENTAL_ACCENT !== '1') {
      throw new Error('已禁用：进程内改写 accent 会导致 explorer 崩溃（详见 taskbarTransparency.js 头部说明）');
    }
    const hex = (color >>> 0).toString(16).padStart(8, '0');
    const response = await sendCommand(`APPLY:${state}:${flags}:0x${hex}`, 3000);
    return (response || '').trim() === 'OK';
  }

  /** 探针当前生效的 accent 覆盖值（0 = 纯透传、不改写任何外观） */
  async getEffect() {
    try {
      const response = await sendCommand('GET', 1500);
      return parseInt(response, 10) || 0;
    } catch (e) {
      return 0;
    }
  }

  /**
   * 让探针干净退出：摘 detour → 关管道 → FreeLibrary。
   * 应用退出时调用，避免在 explorer 里长期驻留一个什么都不做的 DLL。
   * （务必保证"先关管道再卸模块"，否则泄漏的管道实例会毒化后续会话）
   */
  async unload() {
    const pid = this.getExplorerPid();
    try {
      await sendCommand('UNLOAD', 3000);
    } catch (e) {
      // 预期之内：UNLOAD 会让探针关掉管道并立即自卸，客户端可能只看到连接中断（EPIPE）而读不到 "BYE"。
      // 所以下面以"模块是否真的消失"为准 —— 这比回应本身可信。
    }
    if (pid) {
      for (let i = 0; i < 5; i++) {
        if (!this.hasModule(pid)) {
          this.isInjected = false;
          this.injectedPid = null;
          return true;
        }
        await new Promise((r) => setTimeout(r, 200));
      }
      console.error('[TaskbarInjector] 已发送 UNLOAD，但模块仍在 explorer 中');
      return false;
    }
    this.isInjected = false;
    this.injectedPid = null;
    return false;
  }
}

// 导出单例
module.exports = new TaskbarInjector();
module.exports.TaskbarInjector = TaskbarInjector;
// 转发 ensureLoadableDll（实现位于 genericInjector，tapClient 经 _getInjector() 调用）
module.exports.ensureLoadableDll = genericInjector.ensureLoadableDll;
