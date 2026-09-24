/**
 * UI 自验证：截图 + 界面几何自检
 * ------------------------------------------------------------
 * 为什么需要它：AI 改完界面代码后，光"看代码"是没法知道改没改对的。
 *   本模块给 Agent 两件确定性工具：
 *   1) capture：把「被验证的程序」的窗口抓成 PNG 存盘（本应用窗口 / 按标题抓任意程序窗口）；
 *   2) audit  ：把一段检测脚本注入渲染进程，量真实布局 —— 元素是否被容器裁掉、
 *               内容是否被 overflow:hidden 藏住、交互控件是否被别的元素盖住。
 *   「被窗口外边框遮盖」这类 bug 正是 audit 的 clipped / occluded 两类命中。
 *
 * 依赖说明：只用 Electron 自带能力（webContents.capturePage / desktopCapturer / executeJavaScript），
 *          不引入新依赖，也不需要 Python 之类的运行时。
 */
const fs = require('fs');
const path = require('path');
const { app, desktopCapturer, screen } = require('electron');

let windowProvider = () => ({});

/** 由 main.js 注册：返回 { 逻辑名: BrowserWindow } */
function setWindowProvider(fn) {
  if (typeof fn === 'function') windowProvider = fn;
}

function shotsDir() {
  const dir = path.join(app.getPath('userData'), 'screenshots');
  try { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); } catch (e) { /* ignore */ }
  return dir;
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function savePng(buffer, savePath) {
  const file = savePath && path.isAbsolute(savePath)
    ? savePath
    : path.join(shotsDir(), (savePath || ('shot-' + stamp())) + (String(savePath || '').endsWith('.png') ? '' : '.png'));
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, buffer);
  return file;
}

/** 列出本应用所有已创建的窗口，供模型选择抓哪一个 */
function listAppWindows() {
  const map = windowProvider() || {};
  const out = [];
  for (const [key, win] of Object.entries(map)) {
    if (!win || (typeof win.isDestroyed === 'function' && win.isDestroyed())) continue;
    let title = '';
    try { title = win.getTitle(); } catch (e) { /* ignore */ }
    let size = {};
    try { const b = win.getBounds(); size = { x: b.x, y: b.y, w: b.width, h: b.height }; } catch (e) { /* ignore */ }
    out.push({
      which: key,
      title,
      visible: (() => { try { return win.isVisible(); } catch (e) { return false; } })(),
      minimized: (() => { try { return win.isMinimized(); } catch (e) { return false; } })(),
      ...size
    });
  }
  return out;
}

function pickAppWindow(which) {
  const map = windowProvider() || {};
  const keys = Object.keys(map);
  if (!keys.length) return { error: '当前没有可用窗口' };
  const wanted = String(which || 'main').toLowerCase();
  if (map[wanted]) return { win: map[wanted], which: wanted };
  // 支持按标题片段匹配
  for (const k of keys) {
    const win = map[k];
    if (!win || (typeof win.isDestroyed === 'function' && win.isDestroyed())) continue;
    let title = '';
    try { title = win.getTitle(); } catch (e) { /* ignore */ }
    if (title && title.toLowerCase().includes(wanted)) return { win, which: k };
  }
  // 兜底：第一个可见窗口
  for (const k of keys) {
    const win = map[k];
    if (!win || (typeof win.isDestroyed === 'function' && win.isDestroyed())) continue;
    try { if (win.isVisible()) return { win, which: k, fallback: true }; } catch (e) { /* ignore */ }
  }
  return {
    error: '未找到窗口 "' + which + '"，可用: ' + listAppWindows().map(w => w.which).join(' / '),
    available: listAppWindows()
  };
}

/**
 * 抓本应用自身窗口（「被验证的程序」通常就是他自己）。
 * 支持 which = 逻辑名（main / pet / editor / debugLog …）或标题片段。
 */
async function captureAppWindow({ which = 'main', savePath } = {}) {
  const picked = pickAppWindow(which);
  if (picked.error) return { success: false, error: picked.error, available: picked.available || listAppWindows() };
  const { win, which: usedWhich, fallback } = picked;

  try {
    if (win.isMinimized && win.isMinimized()) {
      return {
        success: false,
        error: '窗口 "' + usedWhich + '" 处于最小化状态，抓不到画面。请先把它还原（restore）再截图。',
        available: listAppWindows()
      };
    }
    if (!win.isVisible || !win.isVisible()) win.showInactive && win.showInactive();
    // 让渲染进程把当前帧画完再抓，避免抓到上一步的旧画面
    await new Promise(r => setTimeout(r, 180));

    const image = await win.webContents.capturePage();
    if (!image || image.isEmpty()) {
      return { success: false, error: '窗口 "' + usedWhich + '" 捕获到空图像（可能被最小化或尚未渲染完成）' };
    }
    const size = image.getSize();
    const file = savePng(image.toPNG(), savePath);
    return {
      success: true,
      which: usedWhich,
      fallback: !!fallback,
      path: file,
      width: size.width,
      height: size.height,
      note: '已抓取本应用窗口画面。可用 analyze_screenshot 让视觉模型看图，或用 verify_ui 直接量布局。'
    };
  } catch (e) {
    return { success: false, error: '截图失败: ' + (e && e.message ? e.message : String(e)) };
  }
}

/**
 * 按标题抓「另一个程序」的窗口（被验证的程序不是本应用时用这个）。
 * 走 desktopCapturer，返回该窗口当前画面。
 */
async function captureProgramWindow({ title, index = 0, savePath } = {}) {
  if (!title) return { success: false, error: '需要提供 title（目标窗口标题的关键字）' };
  try {
    const primary = screen.getPrimaryDisplay();
    const scale = primary.scaleFactor || 1;
    const thumbW = Math.min(Math.round(primary.size.width * scale), 3840);
    const sources = await desktopCapturer.getSources({
      types: ['window'],
      thumbnailSize: { width: thumbW, height: Math.round(thumbW * 0.7) },
      fetchWindowIcons: false
    });
    const needle = String(title).toLowerCase();
    const matched = sources.filter(s => (s.name || '').toLowerCase().includes(needle));
    if (!matched.length) {
      return {
        success: false,
        error: '没有标题包含「' + title + '」的窗口',
        candidates: sources.map(s => s.name).filter(Boolean).slice(0, 40)
      };
    }
    const src = matched[Math.min(index, matched.length - 1)];
    const image = src.thumbnail;
    if (!image || image.isEmpty()) {
      return { success: false, error: '窗口「' + src.name + '」画面为空（可能已最小化或受保护）' };
    }
    const size = image.getSize();
    const file = savePng(image.toPNG(), savePath);
    return {
      success: true,
      matched: src.name,
      matchedCount: matched.length,
      path: file,
      width: size.width,
      height: size.height
    };
  } catch (e) {
    return { success: false, error: '抓取程序窗口失败: ' + (e && e.message ? e.message : String(e)) };
  }
}

/**
 * 注入渲染进程的布局自检脚本。
 * 必须是自包含函数（会被 toString 序列化后执行），不能引用外部变量。
 */
function auditInPage(opts) {
  const CHECK = opts.checks || ['clipped', 'overflow-hidden', 'out-of-viewport'];
  const MAX = opts.maxIssues || 25;
  const issues = [];
  const scanned = { elements: 0 };
  const styleCache = new Map();

  function cs(el) {
    let s = styleCache.get(el);
    if (!s) { s = getComputedStyle(el); styleCache.set(el, s); }
    return s;
  }
  function desc(el) {
    if (!el || el.nodeType !== 1) return '?';
    let s = el.tagName.toLowerCase();
    if (el.id) s += '#' + el.id;
    else {
      const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).slice(0, 3).join('.') : '';
      if (cls) s += '.' + cls;
    }
    return s;
  }
  function rectOf(el) {
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
  }
  function visible(el) {
    const s = cs(el);
    if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) return false;
    if (el.offsetParent === null && s.position !== 'fixed') return false;
    const r = el.getBoundingClientRect();
    return r.width >= 1 && r.height >= 1;
  }
  // 正在播放动画/过渡的元素：位置是中间态（如 toast 从右侧滑入），量出来的几何没有意义 → 跳过
  function animating(el) {
    let node = el;
    for (let i = 0; node && i < 4; i++, node = node.parentElement) {
      try {
        if (node.getAnimations && node.getAnimations({ subtree: false })
          .some(a => a.playState === 'running')) return true;
      } catch (e) { /* 忽略 */ }
    }
    return false;
  }
  // 最近的可裁剪祖先 + 是否可滚动
  function clipperOf(el) {
    let p = el.parentElement;
    while (p && p !== document.documentElement && p !== document.body) {
      const s = cs(p);
      if (s.overflowX !== 'visible' || s.overflowY !== 'visible') {
        return { el: p, scrollable: /(auto|scroll)/.test(s.overflowX + ' ' + s.overflowY) };
      }
      p = p.parentElement;
    }
    return null;
  }
  function hasScrollableAncestor(el) {
    let p = el.parentElement;
    while (p && p !== document.documentElement) {
      const s = cs(p);
      if (/(auto|scroll)/.test(s.overflowX + ' ' + s.overflowY)) return true;
      p = p.parentElement;
    }
    return false;
  }
  // overflow:hidden 的裁剪边界 = padding box
  function padBox(el) {
    const r = el.getBoundingClientRect();
    const s = cs(el);
    return {
      left: r.left + (parseFloat(s.borderLeftWidth) || 0),
      right: r.right - (parseFloat(s.borderRightWidth) || 0),
      top: r.top + (parseFloat(s.borderTopWidth) || 0),
      bottom: r.bottom - (parseFloat(s.borderBottomWidth) || 0)
    };
  }
  function push(type, severity, el, detail, extra) {
    if (issues.length >= MAX * 3) return;
    issues.push({
      type, severity,
      element: desc(el),
      text: (el.textContent || '').trim().slice(0, 24),
      rect: rectOf(el),
      detail,
      ...(extra || {})
    });
  }
  // 同一个问题往往命中一整条链（按钮 → 图标 span → svg）。只报最外层那个，
  // 否则模型要在一堆同源条目里翻（而且它们会一起挤掉真正不同的其它问题）。
  // 注意：只让「裁切 / 越界」这类**位置性**问题去屏蔽后代，
  // 容器自身的 overflow-hidden 不能屏蔽——否则父容器先入列会把子元素的裁切真相盖掉。
  const blocking = [];
  const selfReported = new Set();
  function coveredByAncestor(el) {
    for (const r of blocking) if (r === el || r.contains(el)) return true;
    return false;
  }

  // ===== 收集待检查元素 =====
  const badSelectors = [];
  const focus = [];
  let roots = [];
  if (Array.isArray(opts.selectors) && opts.selectors.length) {
    for (const sel of opts.selectors) {
      let found = null;
      try { found = document.querySelectorAll(sel); } catch (e) { badSelectors.push(sel); continue; }
      if (!found.length) badSelectors.push(sel + '（未匹配到元素）');
      found.forEach(el => { roots.push(el); focus.push(el); });
    }
    roots.forEach(el => {
      el.querySelectorAll('*').forEach(c => roots.push(c));
    });
  } else {
    roots = [document.body];
    document.body.querySelectorAll('*').forEach(el => roots.push(el));
  }

  const W = window.innerWidth, H = window.innerHeight;

  for (const el of roots) {
    if (!el || el.nodeType !== 1) continue;
    const tag = el.tagName ? el.tagName.toLowerCase() : '';
    if (tag === 'script' || tag === 'style' || tag === 'link' || tag === 'meta' || tag === 'title') continue;
    // SVG 图元（path/circle/g/text…）参照 viewBox 绘制、<svg> 本身就是裁剪视口，
    // 溢出/超出边界是正常现象 → 一律跳过，否则满屏误报（踩过）。
    if (tag !== 'svg' && el.closest && el.closest('svg')) continue;
    if (!visible(el)) continue;
    if (animating(el)) continue;
    scanned.elements++;
    const r = el.getBoundingClientRect();
    const s = cs(el);
    const isFixed = s.position === 'fixed';

    // ① 被不可滚动的祖先裁掉（"按钮被外框盖住"就是这一类）
    if (CHECK.includes('clipped') && !isFixed) {
      const c = clipperOf(el);
      if (c && !c.scrollable) {
        const box = padBox(c.el);
        const overRight = r.right - box.right;
        const overLeft = box.left - r.left;
        const overBottom = r.bottom - box.bottom;
        const overTop = box.top - r.top;
        const over = Math.max(overRight, overLeft, overBottom, overTop);
        if (over > 1.5 && !coveredByAncestor(el)) {
          const dir = over === overRight ? '右' : over === overLeft ? '左' : over === overBottom ? '下' : '上';
          push('clipped', 'high', el,
            '被祖先 ' + desc(c.el) + ' 的 overflow:hidden 裁掉 ' + Math.round(over) + 'px（超出' + dir + '边界）',
            { clipper: desc(c.el), overflowPx: Math.round(over), direction: dir });
          blocking.push(el);
        }
      }
    }

    // ② 容器内容溢出但被藏住（含子元素右边缘超出容器）
    if (CHECK.includes('overflow-hidden')) {
      if (s.overflowX === 'hidden' && s.textOverflow !== 'ellipsis' && !selfReported.has(el)) {
        const ov = el.scrollWidth - el.clientWidth;
        if (ov > 2 && el.clientWidth > 0) {
          push('overflow-hidden', 'medium', el,
            '内容横向溢出 ' + Math.round(ov) + 'px 且 overflow-x:hidden，超出部分不可见',
            { overflowPx: Math.round(ov) });
          selfReported.add(el);
        }
      }
    }

    // ③ 超出视口且祖先里没有可滚动容器 → 永远看不到
    if (CHECK.includes('out-of-viewport') && !isFixed) {
      const outside = r.right > W + 1 || r.left < -1 || r.bottom > H + 1 || r.top < -1;
      if (outside && !hasScrollableAncestor(el) && !coveredByAncestor(el)) {
        push('out-of-viewport', 'high', el,
          '元素超出窗口可视区域（窗口 ' + W + '×' + H + '），且没有可滚动祖先，用户无法看到/点到',
          { viewport: { w: W, h: H } });
        blocking.push(el);
      }
    }

    // ④ 尺寸塌陷
    if (CHECK.includes('zero-size')) {
      const collapsed = (r.width < 1 || r.height < 1) && (el.textContent || '').trim().length > 0;
      if (collapsed) push('zero-size', 'medium', el, '可见元素被压成 0 尺寸，文字无法显示', { rect: rectOf(el) });
    }

    // ⑤ 被其它元素盖住（只在要求时开，易受装饰层干扰）
    if (CHECK.includes('occluded')) {
      const interactive = el.matches('button, a, input, select, textarea, [role="button"], .btn, .tool-btn, .nav-item, .switch-toggle');
      if (interactive) {
        const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        if (cx >= 0 && cy >= 0 && cx < W && cy < H) {
          const top = document.elementFromPoint(cx, cy);
          if (top && top !== el && !el.contains(top) && !top.contains(el)) {
            push('occluded', 'high', el,
              '控件中心点被 ' + desc(top) + ' 盖住，用户点不到',
              { occluder: desc(top) });
          }
        }
      }
    }
  }

  // 焦点元素单独给出几何数据，方便模型判断"改完到底在哪儿"
  const focusInfo = focus.map(el => ({
    element: desc(el),
    visible: visible(el),
    rect: rectOf(el),
    clipped: issues.some(i => i.type === 'clipped' && i.element === desc(el))
  }));

  // 去重 + 排序（high 优先）
  const uniq = [];
  const seen = new Set();
  for (const it of issues) {
    const k = it.type + '|' + it.element + '|' + it.rect.x + ',' + it.rect.y;
    if (seen.has(k)) continue;
    seen.add(k);
    uniq.push(it);
  }
  uniq.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'high' ? -1 : 1));

  const byType = {};
  for (const it of uniq) byType[it.type] = (byType[it.type] || 0) + 1;

  return {
    viewport: { w: W, h: H, dpr: window.devicePixelRatio },
    scanned: scanned.elements,
    issueCount: uniq.length,
    byType,
    issues: uniq.slice(0, MAX),
    truncated: uniq.length > MAX,
    focus: focusInfo,
    badSelectors
  };
}

/**
 * 在指定窗口的渲染进程里跑布局自检。
 * @param {string} which  窗口逻辑名，默认 main
 * @param {string[]} selectors  只检查这些选择器（含子树）；为空则整页扫描
 * @param {string[]} checks  默认 ['clipped','overflow-hidden','out-of-viewport']
 */
async function runUiAudit({ which = 'main', selectors, checks, maxIssues = 25 } = {}) {
  const picked = pickAppWindow(which);
  if (picked.error) return { success: false, error: picked.error, available: picked.available || listAppWindows() };
  const { win, which: usedWhich } = picked;

  const opts = {
    selectors: Array.isArray(selectors) ? selectors.filter(Boolean) : (selectors ? [selectors] : []),
    checks: Array.isArray(checks) && checks.length ? checks : ['clipped', 'overflow-hidden', 'out-of-viewport'],
    maxIssues: Math.max(1, Math.min(Number(maxIssues) || 25, 100))
  };

  try {
    const script = '(' + auditInPage.toString() + ')(' + JSON.stringify(opts) + ')';
    const res = await win.webContents.executeJavaScript(script, true);
    return { success: true, which: usedWhich, ...res, checksUsed: opts.checks };
  } catch (e) {
    return { success: false, error: '布局自检执行失败: ' + (e && e.message ? e.message : String(e)) };
  }
}

module.exports = {
  setWindowProvider,
  listAppWindows,
  captureAppWindow,
  captureProgramWindow,
  runUiAudit,
  shotsDir
};
