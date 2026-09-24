/**
 * 被注入 DLL 的命名管道客户端（可指定前缀，供多个注入模块复用）。
 *
 * 为什么不做成"固定管道名"：
 *   命名管道的实例数与安全属性都挂在**名字**上。一旦旧版本（或被杀掉的探针）泄漏了实例，
 *   同名新实例就可能直接建不出来（ACCESS_DENIED），或者客户端 connect 到那个"僵尸实例"上
 *   永远等不到应答。实测这两种坑都踩过，非常难查。
 *
 * 做法：
 *   · DLL 每次装载用**唯一名字**（含 explorer pid + 装载时刻），绝不与历史实例相撞；
 *   · 客户端枚举 \\.\pipe\ 下前缀匹配的名字，逐个 PING，谁回 PONG 谁就是当前活着的服务端。
 *   这样即便有僵尸实例残留，也只是被跳过而已。
 *
 * 目前的使用方：
 *   · 'AI_Lobster_Taskbar' → taskbarInject.dll（SCA 探针）
 *   · 'AI_Lobster_Tap'     → aiLobsterTap.dll（XAML TAP 观测 + M2 改写模块）
 */
const koffi = require('koffi');
const net = require('net');

const kernel32 = koffi.load('kernel32.dll');
const FindFirstFileW = kernel32.func('FindFirstFileW', 'void*', ['str16', 'void*']);
const FindNextFileW = kernel32.func('FindNextFileW', 'int', ['void*', 'void*']);
const FindClose = kernel32.func('FindClose', 'int', ['void*']);

/**
 * 造一个绑定到指定管道前缀的客户端。
 * @param {string} PIPE_PREFIX  不含 \\.\pipe\ 前缀，例如 'AI_Lobster_Tap'
 * @param {number} [pidFilter]  可选，只连接到指定 PID 的管道
 */
function createPipeClient(PIPE_PREFIX, pidFilter) {
  /**
   * 枚举 \\.\pipe\ 下我们前缀的管道，返回完整路径数组
   */
  function listPipes() {
    const out = [];
    const buf = Buffer.alloc(600);           // WIN32_FIND_DATAW
    const h = FindFirstFileW('\\\\.\\pipe\\' + PIPE_PREFIX + '*', buf);
    if (!h || Number(h) === -1) return out;  // INVALID_HANDLE_VALUE
    do {
      // WIN32_FIND_DATAW: cFileName 在偏移 44，260 个 wchar
      const name = buf.toString('utf16le', 44, 44 + 520).split('\0')[0];
      if (name) {
        // 如果指定了 PID 过滤，只保留匹配的管道
        if (pidFilter) {
          // 管道名称格式: AI_Lobster_Tap_p<pid>_<timestamp>
          const match = name.match(/_p(\d+)_/);
          if (match && parseInt(match[1], 10) === pidFilter) {
            out.push('\\\\.\\pipe\\' + name);
          }
        } else {
          out.push('\\\\.\\pipe\\' + name);
        }
      }
    } while (FindNextFileW(h, buf));
    FindClose(h);
    return out;
  }

  /**
   * 向指定管道发一条命令。
   * 写完立刻半关闭(s.end())，否则服务端会一直阻塞在下一个 ReadFile 上，
   * 客户端永远等不到 close —— 表现为"超时/无响应"，而管道其实是通的（踩过）。
   */
  function sendTo(pipeName, cmd, timeout = 2000) {
    return new Promise((resolve, reject) => {
      const s = new net.Socket();
      let buf = '';
      let done = false;
      let settle = null;
      const finish = (ok, msg) => {
        if (done) return;
        done = true;
        clearTimeout(t);
        if (settle) clearTimeout(settle);
        try { s.destroy(); } catch (e) { /* noop */ }
        ok ? resolve(buf) : reject(new Error(msg || '无响应'));
      };
      const t = setTimeout(() => finish(false, '超时'), timeout);
      s.on('data', (d) => {
        buf += d.toString();
        if (settle) clearTimeout(settle);
        settle = setTimeout(() => finish(true), 250);
      });
      s.on('close', () => (buf.length ? finish(true) : finish(false, '关闭无数据')));
      s.on('error', (e) => { if (!done) { done = true; clearTimeout(t); if (settle) clearTimeout(settle); reject(e); } });
      s.connect(pipeName, () => s.end(cmd));
    });
  }

  let _cached = null;

  /**
   * 发现当前活着的探针管道（带缓存）。返回管道路径，找不到返回 null。
   *
   * ⚠️ 必须重试，不能"一次不中就放弃"：
   *   服务端是「服务完一个连接 → DisconnectNamedPipe → CloseHandle → 再建新实例」的循环，
   *   关旧实例与建新实例之间有一个**空窗期**。客户端此刻枚举 \\.\pipe\ 会一个实例都没有，
   *   直接判"模块未注入"，表现为命令随机失败（实测踩过，误以为是 explorer 崩了）。
   *   实际上模块一直活着、管道马上就回来，所以这里退避重试几次即可。
   */
  async function resolvePipe(probeTimeout = 1200) {
    for (let attempt = 0; attempt < 4; attempt++) {
      const candidates = listPipes();
      if (candidates.length) {
        // 缓存优先
        if (_cached && candidates.includes(_cached)) {
          try { if ((await sendTo(_cached, 'PING', probeTimeout)).trim() === 'PONG') return _cached; }
          catch (e) { /* 缓存失效，继续探测 */ }
        }
        for (const p of candidates) {
          try {
            if ((await sendTo(p, 'PING', probeTimeout)).trim() === 'PONG') { _cached = p; return p; }
          } catch (e) { /* 这是僵尸实例，跳过 */ }
        }
      }
      _cached = null;
      if (attempt < 3) await new Promise((r) => setTimeout(r, 120));
    }
    return null;
  }

  /**
   * 高层发送：自动发现 + 发送。连接类失败会退避重试，避免服务端空窗期导致命令丢失。
   * 注意：重试意味着命令可能被服务端执行两次 —— 只对**幂等命令**安全
   * （PING/STATUS/LOG/PROBE/FILL 都是幂等的：FILL 重复设同一颜色无副作用）。
   */
  async function send(cmd, timeout = 2500) {
    let lastErr = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const p = await resolvePipe();
      if (p) {
        try {
          return await sendTo(p, cmd, timeout);
        } catch (e) {
          lastErr = e;
          _cached = null;
        }
      } else {
        lastErr = new Error('没有可用的探针管道（模块可能未注入）');
      }
      if (attempt < 2) await new Promise((r) => setTimeout(r, 150));
    }
    throw lastErr || new Error('发送失败');
  }

  function invalidate() { _cached = null; }

  function setPidFilter(pid) {
    pidFilter = pid;
    _cached = null;
  }

  return { listPipes, sendTo, resolvePipe, send, invalidate, setPidFilter, PIPE_PREFIX };
}

// 默认实例：SCA 探针（保持既有 require('./pipeClient').send(...) 用法不变）
const defaultClient = createPipeClient('AI_Lobster_Taskbar');

module.exports = {
  createPipeClient,
  ...defaultClient,
};
