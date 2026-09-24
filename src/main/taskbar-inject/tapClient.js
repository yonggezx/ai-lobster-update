/**
 * 任务栏外观 · XAML TAP 客户端（Phase B）
 *
 * 封装 aiLobsterTap.dll 的注入 + 命名管道通信 + 外观改写命令。
 * 技术依据：docs/任务栏-PhaseB-可行性报告.md
 *   - Win11 25H2 (build 26200) 上任务栏可见背景由 XAML 的 BackgroundFill 矩形绘制
 *   - SCA (SetWindowCompositionAttribute) 完全无效（窗口本身已透明）
 *   - 正确方案：XAML 诊断 TAP 附着 → 修改 BackgroundFill.Fill 画刷
 *
 * 支持的外观：
 *   - transparent (透明)：SolidColorBrush，alpha 极低（近全透明）
 *   - blur (模糊)：SolidColorBrush，半透明（Win11 上 TranslucentTB 也不支持真模糊，用半透明模拟）
 *   - acrylic (亚克力)：AcrylicBrush{ BackgroundSource=Backdrop }
 *   - normal (还原)：RESTORE 原始画刷
 */

const path = require('path');
const fs = require('fs');
const { createPipeClient } = require('./pipeClient');
const os = require('os');

// TAP 管道前缀（与 explorerTap.cpp 中的 PIPE_PREFIX 对应）
const TAP_PIPE_PREFIX = 'AI_Lobster_Tap';

class TapClient {
  constructor() {
    this.dllPath = null;
    this.isInjected = false;
    this.injectedPid = null;
    this.pipeClient = createPipeClient(TAP_PIPE_PREFIX);
    this._injector = null;  // 延迟加载，避免循环依赖
  }

  /**
   * 获取注入器（延迟加载，避免循环依赖）
   */
  _getInjector() {
    if (!this._injector) {
      this._injector = require('./taskbarInjector');
    }
    return this._injector;
  }

  /**
   * 获取 Explorer 进程 ID
   */
  getExplorerPid() {
    return this._getInjector().getExplorerPid();
  }

  /**
   * 检查 DLL 是否已注入（通过模块枚举）
   *
   * ⚠️ 必须用**精确文件名**判断，不能用 /aiLobsterTap/i 这种正则：
   *    同一个 explorer 里可能同时存在别的变体（aiLobsterTap_tray.dll = 托盘溢出区），
   *    正则会把它当成"任务栏模块已加载" → 于是跳过注入 → 任务栏永远改不动，
   *    而且失败点出现在 waitForAttach（表现为"TAP 附着失败"，很容易查错方向）。
   */
  isModuleLoaded(pid) {
    return this._getInjector().hasModule(pid, 'aiLobsterTap.dll');
  }

  /**
   * 注入 aiLobsterTap.dll 到 Explorer
   * @param {string} dllPath - DLL 路径
   * @returns {boolean} 是否成功
   */
  inject(dllPath) {
    if (!dllPath) {
      dllPath = path.join(__dirname, 'aiLobsterTap.dll');
    }

    const pid = this.getExplorerPid();
    if (!pid) {
      console.error('[TapClient] 未找到 Explorer 进程');
      return false;
    }

    // ★ 顺序很重要：**先判断目标进程里有没有模块，再考虑部署 DLL**。
    //   反过来写会踩一个大坑：模块已经在 explorer 里时，DLL 副本正被宿主占用，
    //   部署（复制到 %TEMP% 等）必然 EBUSY 失败 → 直接 return false →
    //   用户看到"切换失败 / 注入失败"，而实际上根本不需要重新注入（实测踩过）。
    if (this.isInjected && this.injectedPid === pid) {
      console.log('[TapClient] DLL 已注入，跳过');
      this.pipeClient.setPidFilter(pid);
      return true;
    }
    if (this.isModuleLoaded(pid)) {
      console.log('[TapClient] 检测到 aiLobsterTap.dll 已加载，跳过注入');
      this.isInjected = true;
      this.injectedPid = pid;
      this.pipeClient.setPidFilter(pid);
      return true;
    }

    // 只有确实需要注入时才部署（打包后 DLL 在 app.asar 内 / 中文路径都会导致 LoadLibraryW 失败，
    // 统一确保落到可加载路径）。
    this.dllPath = this._getInjector().ensureLoadableDll(dllPath, 'aiLobsterTap.dll');
    if (!this.dllPath) {
      console.error('[TapClient] DLL 无法定位/复制:', dllPath);
      return false;
    }

    if (!fs.existsSync(this.dllPath)) {
      console.error('[TapClient] DLL 文件不存在:', this.dllPath);
      return false;
    }

    console.log('[TapClient] 注入 aiLobsterTap.dll 到 Explorer (pid=' + pid + ')');
    const result = this._getInjector().inject(this.dllPath);
    if (result) {
      this.isInjected = true;
      this.injectedPid = pid;
      this.pipeClient.setPidFilter(pid);
    }
    return result;
  }

  /**
   * 等待 TAP 附着成功（XAML 附着需要时间，最长 30 秒）
   * @param {number} timeout - 超时毫秒
   * @returns {Promise<boolean>}
   */
  async waitForAttach(timeout = 35000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      try {
        const status = await this.getStatus();
        // state: 0=未开始 1=进行中 2=成功 3=失败
        // advised: 0=未订阅 1=已订阅
        const attachState = status ? (status.attachState || status.state || 0) : 0;
        const advised = status ? (status.advised || 0) : 0;
        if (attachState === 2 && advised === 1) {
          console.log('[TapClient] TAP 附着成功 (attempts=' + (status.attempts || 0) + ', events=' + (status.events || 0) + ')');
          return true;
        }
        if (attachState === 3) {
          console.error('[TapClient] TAP 附着失败 (lastHr=0x' + (status.lastHr || 0).toString(16) + ')');
          return false;
        }
      } catch (e) {
        // 管道还没就绪，继续等
      }
      await new Promise(r => setTimeout(r, 500));
    }
    console.error('[TapClient] TAP 附着超时');
    return false;
  }

  /**
   * 发送命令到 TAP DLL
   */
  async send(cmd, timeout = 3000) {
    return this.pipeClient.send(cmd, timeout);
  }

  /**
   * 获取状态
   */
  async getStatus() {
    const resp = await this.send('STATUS');
    if (!resp) return null;
    const lines = resp.trim().split('\n');
    const result = {};
    for (const line of lines) {
      if (line.startsWith('S|')) {
        const parts = line.substring(2).split('|');
        for (const p of parts) {
          const [k, v] = p.split('=');
          if (k && v !== undefined) {
            const num = parseInt(v, 10);
            result[k] = isNaN(num) ? v : num;
          }
        }
      } else if (line.startsWith('S2|')) {
        const parts = line.substring(3).split('|');
        for (const p of parts) {
          const [k, v] = p.split('=');
          if (k && v !== undefined) {
            const num = parseInt(v, 10);
            result[k] = isNaN(num) ? v : num;
          }
        }
      }
    }
    return result;
  }

  /**
   * 探测 BackgroundFill（读取当前画刷，并存原始画刷供 RESTORE）
   */
  async probe() {
    const resp = await this.send('PROBE', 5000);
    return this._parseResult(resp);
  }

  /**
   * 设置 SolidColorBrush（透明/半透明）
   * @param {string} argb - AARRGGBB 格式，如 '01FFFFFF'（近全透明）或 '33FFFFFF'（20%不透明白）
   */
  async setFill(argb) {
    const resp = await this.send('FILL ' + argb, 5000);
    return this._parseResult(resp);
  }

  /**
   * 设置 AcrylicBrush（亚克力）
   * @param {string} argb - 可选色调 AARRGGBB，默认 '33FFFFFF'
   */
  async setAcrylic(argb) {
    const cmd = argb ? 'ACRYLIC ' + argb : 'ACRYLIC';
    const resp = await this.send(cmd, 5000);
    return this._parseResult(resp);
  }

  /**
   * 还原原始画刷
   */
  async restore() {
    const resp = await this.send('RESTORE', 5000);
    return this._parseResult(resp);
  }

  /**
   * 应用外观效果
   * @param {'transparent'|'blur'|'acrylic'|'normal'} effect
   */
  async applyEffect(effect) {
    console.log('[TapClient] 应用效果:', effect);

    // 确保已注入并附着
    if (!this.isInjected) {
      const injected = this.inject();
      if (!injected) {
        return { success: false, error: '注入失败' };
      }
    }

    // 检查 explorer 是否重启过
    const pid = this.getExplorerPid();
    if (pid && this.injectedPid && pid !== this.injectedPid) {
      console.log('[TapClient] Explorer 已重启，重新注入');
      this.isInjected = false;
      this.pipeClient.invalidate();
      const injected = this.inject();
      if (!injected) {
        return { success: false, error: '重新注入失败' };
      }
    }

    // 等待附着
    const attached = await this.waitForAttach();
    if (!attached) {
      return { success: false, error: 'TAP 附着失败' };
    }

    try {
      // 无论应用效果还是还原，都先探测保存原始画刷（DLL 内部只保存第一次，不会覆盖）
      await this.probe();

      // 统一走 Opacity 方案：FULL_TRANSPARENT <0-1000>（0=全透明，1000=完全还原，中间=半透明模拟）
      // 还原是纯 Opacity 操作，跨会话/跨重启都保证能回到系统默认，不再依赖原始画刷快照
      const ftMap = {
        transparent: { v: 0,    state: 'transparent' },
        blur:        { v: 550,  state: 'blur' },
        acrylic:     { v: 400,  state: 'acrylic' },
        normal:      { v: 1000, state: 'normal' }
      };
      const cfg = ftMap[effect] || ftMap.normal;
      try { fs.writeFileSync(path.join(os.tmpdir(), 'ai_taskbar_state.txt'), cfg.state); } catch (e) {}
      const resp = await this.send('FULL_TRANSPARENT ' + cfg.v, 5000);
      const m = resp ? resp.match(/found=(-?\d+)/) : null;
      const found = m ? parseInt(m[1], 10) : 0;
      const ok = !!resp && resp.includes('FULL_TRANSPARENT') && resp.includes('hrSet=0x00000000') && found > 0;
      if (!ok) {
        return { success: false, effect, raw: resp, error: 'FULL_TRANSPARENT 未生效 (found=' + found + ')' };
      }
      return { success: true, effect, raw: resp };
    } catch (e) {
      console.error('[TapClient] 应用效果失败:', e.message);
      return { success: false, error: e.message };
    }
  }

  /**
   * 解析 TAP 命令的多行结果
   */
  _parseResult(resp) {
    if (!resp) return { success: false, error: '无响应' };
    const lines = resp.trim().split('\n');
    const result = { success: false, raw: resp };
    for (const line of lines) {
      if (line.startsWith('R|')) {
        result.success = line.includes('done=1');
        const parts = line.substring(2).split('|');
        for (const p of parts) {
          const [k, v] = p.split('=');
          if (k && v !== undefined) result[k] = v;
        }
      } else if (line.startsWith('T|')) {
        const parts = line.substring(2).split('|');
        for (const p of parts) {
          const [k, v] = p.split('=');
          if (k && v !== undefined) result[k] = v;
        }
      } else if (line.startsWith('X|')) {
        const parts = line.substring(2).split('|');
        for (const p of parts) {
          const [k, v] = p.split('=');
          if (k && v !== undefined) result[k] = v;
        }
      } else if (line.startsWith('S|')) {
        const parts = line.substring(2).split('|');
        for (const p of parts) {
          const [k, v] = p.split('=');
          if (k && v !== undefined) result[k] = v;
        }
      } else if (line.startsWith('Q|')) {
        const parts = line.substring(2).split('|');
        for (const p of parts) {
          const [k, v] = p.split('=');
          if (k && v !== undefined) result[k] = v;
        }
      } else if (line.startsWith('D|')) {
        const parts = line.substring(2).split('|');
        for (const p of parts) {
          const [k, v] = p.split('=');
          if (k && v !== undefined) result[k] = v;
        }
      } else if (line.startsWith('W|')) {
        result.warning = line.substring(2);
      } else if (line.startsWith('ERR')) {
        result.error = line;
      }
    }
    return result;
  }
}

// 单例
const tapClient = new TapClient();

module.exports = tapClient;
