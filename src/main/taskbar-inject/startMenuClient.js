/**
 * 开始菜单/系统弹窗透明化 · XAML TAP 客户端
 *
 * 与任务栏不同，开始菜单运行在 StartMenuExperienceHost.exe 独立进程中。
 * 技术方案：注入 aiLobsterTap_menu.dll → TAP 附着 → 修改 XAML 视觉树
 *
 * 时序关键（2026-09-13 实测修复，不要删）：
 *   TAP 附着成功后，XAML 初始树转储是异步的（几千条事件要跑几秒）。
 *   如果注入后立刻发命令，命令会在视觉树枚举出元素之前执行
 *   （响应里 found=0 / hrSet=0x80004005），表现为"不生效"。
 *   => applyEffect 必须先等 TAP 附着（state=2 && advised=1），再带重试地发命令，
 *      直到返回 found>0 且 hrSet=0x00000000 为止。
 *
 * 支持的外观 —— 四种效果**统一走 Opacity 方案**（FULL_TRANSPARENT，改元素 Opacity，
 * 保留系统自带的亚克力材质），取值必须与 DLL 侧 AutoApplyThreadProc 完全一致：
 *   - transparent（全透明）：FULL_TRANSPARENT 0    —— Opacity=0，壁纸原样透出
 *   - blur（模糊）：        FULL_TRANSPARENT 550   —— Opacity=0.55
 *   - acrylic（亚克力）：    FULL_TRANSPARENT 400   —— Opacity=0.40
 *   - normal（还原）：      FULL_TRANSPARENT 1000  —— Opacity=1，还原系统默认
 *
 * 【2026-09-13 修复：切换到亚克力后每次打开开始菜单闪烁】
 *   旧实现里 blur/acrylic 走 FILL_BORDER（改 Border.Background 画刷、不动 Opacity），
 *   而 DLL 的自动应用线程对同一状态走 FULL_TRANSPARENT（改 Opacity、不动 Background）。
 *   两条路径改的不是同一个属性：菜单每次打开/元素集合变化时 DLL 重放 FULL_TRANSPARENT，
 *   Opacity 从 1 跳到 0.4 → 背景出现可见跳变（闪烁）。
 *   transparent/normal 从不闪，正是因为两边属性与取值一致、重放幂等。
 *   ⇒ 现在与任务栏 tapClient.js 对齐，统一只用 FULL_TRANSPARENT，不再混用两套属性。
 */

const path = require('path');
const os = require('os');
const fs = require('fs');
const net = require('net');
const genericInjector = require('./genericInjector');

const TAP_PIPE_PREFIX = 'AI_Lobster_Tap';

class StartMenuClient {
  constructor() {
    this.dllPath = null;
    this.isInjected = false;
    this.injectedPid = null;
    this.pipeName = null;
  }

  /**
   * 获取开始菜单进程 PID
   */
  getStartMenuPid() {
    return genericInjector.getPidByProcessName('StartMenuExperienceHost.exe');
  }

  /**
   * 注入 DLL 到开始菜单进程
   * DLL 必须使用纯英文路径（中文路径会导致 LoadLibraryW 失败）：
   * inject() 内部会经 ensureLoadableDll 自动复制到纯 ASCII 临时目录，无需外部预置。
   */
  inject(dllPath) {
    if (!dllPath) {
      dllPath = path.join(__dirname, 'aiLobsterTap_menu.dll');
    }
    this.dllPath = genericInjector.ensureLoadableDll(dllPath, 'aiLobsterTap_menu.dll');
    if (!this.dllPath) {
      console.error('[StartMenuClient] DLL 无法定位/复制:', dllPath);
      return false;
    }

    if (!fs.existsSync(this.dllPath)) {
      console.error('[StartMenuClient] DLL 文件不存在:', this.dllPath);
      return false;
    }

    const pid = this.getStartMenuPid();
    if (!pid) {
      console.error('[StartMenuClient] 未找到开始菜单进程');
      return false;
    }

    if (this.isInjected && this.injectedPid === pid) {
      console.log('[StartMenuClient] DLL 已注入，跳过');
      return true;
    }

    // ⚠️ 精确文件名，别用 /aiLobsterTap/i 正则 —— 同一套 DLL 有多个变体
    //    （aiLobsterTap.dll 任务栏 / _tray 溢出区 / _cc 快速设置），
    //    正则会把别的变体当成"已加载"从而跳过注入（tapClient 就踩过，见其注释）。
    if (genericInjector.hasModule(pid, 'aiLobsterTap_menu.dll')) {
      console.log('[StartMenuClient] 检测到 DLL 已加载，跳过注入');
      this.isInjected = true;
      this.injectedPid = pid;
      return true;
    }

    console.log('[StartMenuClient] 注入 DLL 到开始菜单 (pid=' + pid + ')');
    const result = genericInjector.inject(pid, this.dllPath);
    if (result) {
      this.isInjected = true;
      this.injectedPid = pid;
    }
    return result;
  }

  /**
   * 查找并连接到 TAP 管道
   */
  async connectPipe(timeout = 10000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      try {
        const pipes = fs.readdirSync('\\\\.\\pipe\\');
        const aiPipes = pipes.filter(p =>
          p.startsWith(TAP_PIPE_PREFIX) && p.includes('p' + this.injectedPid)
        );
        if (aiPipes.length > 0) {
          this.pipeName = '\\\\.\\pipe\\' + aiPipes[aiPipes.length - 1];
          console.log('[StartMenuClient] 找到管道:', this.pipeName);
          return true;
        }
      } catch (e) {
        // 继续等待
      }
      await new Promise(r => setTimeout(r, 300));
    }
    console.error('[StartMenuClient] 未找到 TAP 管道');
    return false;
  }

  /**
   * 发送命令到 TAP DLL
   */
  async send(cmd, timeout = 5000) {
    if (!this.pipeName) {
      const connected = await this.connectPipe();
      if (!connected) return null;
    }

    return new Promise((resolve) => {
      const client = net.connect(this.pipeName, () => {
        client.write(cmd + '\n');
      });

      let data = '';
      const timer = setTimeout(() => {
        client.destroy();
        resolve(data);
      }, timeout);

      client.on('data', (chunk) => {
        data += chunk.toString();
        if (data.includes('END') || data.includes('ERR')) {
          clearTimeout(timer);
          client.end();
          resolve(data);
        }
      });

      client.on('error', () => {
        clearTimeout(timer);
        console.error('[StartMenuClient] 管道错误，重置');
        this.pipeName = null;
        resolve(null);
      });
    });
  }

  /**
   * 解析 STATUS 响应（S|... 与 S2|... 行），返回数字字段对象
   */
  _parseStatus(resp) {
    if (!resp) return {};
    const out = {};
    for (const line of String(resp).split('\n')) {
      if (!line.startsWith('S|') && !line.startsWith('S2|')) continue;
      const parts = line.split('|');
      for (const p of parts.slice(1)) {
        const eq = p.indexOf('=');
        if (eq <= 0) continue;
        const k = p.slice(0, eq).trim();
        const raw = p.slice(eq + 1).trim();
        if (!k || raw === '') continue;
        const num = parseInt(raw, 10);
        out[k] = isNaN(num) ? raw : num;
      }
    }
    return out;
  }

  /**
   * 等待 TAP 附着完成（state=2 且 advised=1）
   * @returns {Promise<{ok:boolean, error?:string}>}
   */
  async waitForReady(timeout = 15000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      let st = null;
      try {
        const resp = await this.send('STATUS', 2000);
        st = this._parseStatus(resp);
      } catch (e) {
        // 管道尚未就绪，继续等
      }
      if (st && st.state === 2 && st.advised === 1) return { ok: true };
      if (st && st.state === 3) return { ok: false, error: 'TAP 附着失败 (state=3)' };
      await new Promise(r => setTimeout(r, 400));
    }
    return { ok: false, error: 'TAP 附着超时 ' + timeout + 'ms' };
  }

  /**
   * 应用外观效果到开始菜单
   * @param {'transparent'|'blur'|'acrylic'|'normal'} effect
   */
  async applyEffect(effect) {
    console.log('[StartMenuClient] 应用开始菜单效果:', effect);

    // 确保已注入
    if (!this.isInjected) {
      const injected = this.inject();
      if (!injected) {
        return { success: false, error: '注入失败' };
      }
    }

    // 检查进程是否重启
    const pid = this.getStartMenuPid();
    if (pid && this.injectedPid && pid !== this.injectedPid) {
      console.log('[StartMenuClient] 开始菜单进程已重启，重新注入');
      this.isInjected = false;
      this.pipeName = null;
      const injected = this.inject();
      if (!injected) {
        return { success: false, error: '重新注入失败' };
      }
    }

    // 连接管道
    const connected = await this.connectPipe();
    if (!connected) {
      return { success: false, error: '管道连接失败' };
    }

    // 等 TAP 附着 + 视觉树就绪（不等会在树转储完成前执行 → found=0 → 假失败）
    const ready = await this.waitForReady();
    if (!ready.ok) {
      return { success: false, error: ready.error };
    }

    try {
      // 写状态文件：新宿主（进程重启）由 DLL 附着时自动应用，消除闪屏
      try { fs.writeFileSync(path.join(os.tmpdir(), 'ai_startmenu_state.txt'), String(effect)); } catch (e) {}

      // 统一走 Opacity 方案：FULL_TRANSPARENT <0-1000>
      //   0 = 全透明（壁纸原样透出）、1000 = 完全还原、中间值 = 半透明
      //   ★ 取值必须与 DLL 侧 AutoApplyThreadProc 一致，否则 DLL 重放时会覆盖成另一个值，
      //     表现为"每次打开开始菜单闪一下"（切亚克力后尤其明显）。
      const ftMap = {
        transparent: 0,
        blur: 550,
        acrylic: 400,
        normal: 1000
      };
      const val = Object.prototype.hasOwnProperty.call(ftMap, effect) ? ftMap[effect] : ftMap.normal;

      let lastResp = null;
      for (let attempt = 0; attempt < 8; attempt++) {
        const resp = await this.send('FULL_TRANSPARENT ' + val, 5000);
        lastResp = resp;
        if (!resp) {
          await new Promise(r => setTimeout(r, 600));
          continue;
        }
        const m = resp.match(/found=(-?\d+)/);
        const found = m ? parseInt(m[1], 10) : 0;
        const ok = resp.includes('FULL_TRANSPARENT') && resp.includes('hrSet=0x00000000') && found > 0;
        if (ok) {
          console.log('[StartMenuClient] FULL_TRANSPARENT ' + val + ' (' + effect + ') 生效 (attempt=' + (attempt + 1) + ', found=' + found + ')');
          return { success: true, effect, raw: resp };
        }
        console.warn('[StartMenuClient] FULL_TRANSPARENT ' + val + ' (' + effect + ') 未生效 (attempt=' + (attempt + 1) + ', found=' + found + ')，等待视觉树就绪后重试');
        await new Promise(r => setTimeout(r, 800));
      }
      return { success: false, effect, raw: lastResp, error: '视觉树尚未就绪（背景元素未找到）或设置失败' };
    } catch (e) {
      console.error('[StartMenuClient] 应用效果失败:', e.message);
      return { success: false, error: e.message };
    }
  }
}

// 单例
const startMenuClient = new StartMenuClient();

module.exports = startMenuClient;
