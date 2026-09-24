// 全局龙虾钳光标 —— 单元素切换版（低开销）
//
// 【为什么要改】
// 旧实现把「状态切换」做成「给 body 加类 + 通配后代选择器重写 cursor」：
//     body.lobster-click * , body.lobster-click *::before , body.lobster-click *::after { cursor: ...!important }
// cursor 是继承属性，且选择器命中全树，所以每一次按下/抬起鼠标，浏览器都必须为
// **整棵 DOM** 重新计算样式。实测（scripts/test-cursor-perf.js，真实 style.css + 3000 节点）：
//     一次点击（按下+抬起）样式重算中位数 ≈ 115ms，6000 节点时 ≈ 315ms
// 表现为：点任何功能按钮都明显卡顿，页面越"重"（模型中心/软件列表/长聊天记录）越卡。
// 对比：同样条件下完全不注入光标样式时为 0ms。
//
// 【现方案】
// 1) 静态层只注入一次：「* { cursor: inherit !important }」让全树继承根节点光标，
//    根节点给出正常态光标；输入框 / 禁用态 / 状态栏用静态规则单独处理。状态切换不动它。
// 2) 运行时切换状态时，只给「指针当前所在的那一个元素」写内联 !important 光标，
//    其余节点一个都不碰 → 实测 0.0ms，且与 DOM 规模无关。
//    （内联 !important 的优先级高于任何作者样式表 !important，所以照样能压过
//      style.css 里的 cursor:pointer / cursor:text，以及 index.html 里的内联 cursor）
// 3) 光标位图直接用 48x48 小图（assets/cursors/*.png，2~3KB）。
//    旧实现每次启动都要把 2048x2048 大图解码后缩到 48x48 再 toDataURL：
//    4 张 ≈140ms 主线程阻塞 + 64MB 临时位图。降采样已离线化到
//    scripts/optimize-cursor-assets.js，运行时不再做任何图片处理。
// 4) 兜底：补丁只能覆盖 renderer/，assets/ 里的光标图不会随补丁更新。若检测到
//    资源仍是大图（旧安装包），空闲时静默降采样成 48x48，行为与旧版一致。
(function () {
  'use strict';

  var HOTSPOT = '12 16';
  var RUNTIME_SIZE = 48;   // 运行时降采样尺寸（与离线资源保持一致）
  var MAX_CURSOR_PX = 128; // 超过该尺寸视为"未优化的大图"
  var NAMES = ['normal', 'wait', 'click', 'drag'];

  // 测试/调试可覆盖资源根路径
  var BASE = window.__lobsterCursorAssetBase || '../../assets/cursors/';
  var PATHS = {};
  // activeUrls 是"实际使用的地址"：正常是小图文件路径；若资源未随补丁更新
  // （仍是 2048 大图），verifyAssets() 会把它替换成运行时降采样后的 data URL。
  // 基础态和 click/wait/drag 态都必须走这里，否则会出现"基础态正常、一点击变巨图"。
  var activeUrls = {};
  NAMES.forEach(function (n) {
    PATHS[n] = BASE + 'cursor-' + n + '.png';
    activeUrls[n] = PATHS[n];
  });

  function valueOf(name) {
    return 'url("' + (activeUrls[name] || activeUrls.normal) + '") ' + HOTSPOT + ', auto';
  }

  // 静态层：只注入一次，之后只在"旧安装包兜底"时整体重写一次
  function buildStaticCss(getValue) {
    return [
      '/* 全树继承根光标：让根节点成为唯一的光标来源，状态切换不再触碰整树 */',
      '*, *::before, *::after { cursor: inherit !important; }',
      'html { cursor: ' + getValue('normal') + ' !important; }',
      '/* 文本输入固定 I 形光标 */',
      'input[type="text"]:not([readonly]):not([disabled]),',
      'input[type="password"]:not([readonly]):not([disabled]),',
      'input[type="email"]:not([readonly]):not([disabled]),',
      'input[type="number"]:not([readonly]):not([disabled]),',
      'input[type="search"]:not([readonly]):not([disabled]),',
      'input[type="tel"]:not([readonly]):not([disabled]),',
      'input[type="url"]:not([readonly]):not([disabled]),',
      'textarea:not([readonly]):not([disabled]),',
      '[contenteditable="true"]:not([readonly]):not([disabled]) { cursor: text !important; }',
      '/* 禁用态 */',
      '[disabled], [aria-disabled="true"], .disabled { cursor: not-allowed !important; }',
      '/* 滚动条跟随根光标 */',
      '::-webkit-scrollbar, ::-webkit-scrollbar-thumb, ::-webkit-scrollbar-track,',
      '::-webkit-scrollbar-corner { cursor: inherit !important; }',
      '/* 状态栏：style.css 末尾有一条 `.status-bar * { cursor: default !important }`，',
      '   优先级高于通配静态层，必须用同优先级 + 更靠后的顺序压回龙虾光标 */',
      '.status-bar, .status-bar * { cursor: inherit !important; user-select: none !important; }'
    ].join('\n');
  }

  var styleEl = null;

  /* ---------------- 运行时状态 ---------------- */
  var mode = 'normal';   // normal | click | wait | drag
  var waitCount = 0;     // fetch / XHR 在途数量
  var clicking = false;  // 仅在"按下超过一帧"后置位（保留原有的快速点击过滤）
  var dragging = false;

  var hoverEl = null;      // 指针当前所在元素
  var stateEl = null;      // 当前挂着内联光标的元素（最多一个）
  var stateElSaved = null; // 该元素原有的内联 cursor 声明，用于无损还原
  var clickRafId = null;

  /* ---------------- 单元素状态渲染 ---------------- */
  function restoreEl() {
    if (!stateEl) return;
    try {
      if (stateElSaved) stateEl.style.setProperty('cursor', stateElSaved.value, stateElSaved.priority);
      else stateEl.style.removeProperty('cursor');
    } catch (e) { /* 元素可能已脱离文档 */ }
    stateEl = null;
    stateElSaved = null;
  }

  function paintEl(el) {
    if (stateEl === el) return;
    restoreEl();
    if (!el) return;
    var value = el.style.getPropertyValue('cursor');
    stateElSaved = value
      ? { value: value, priority: el.style.getPropertyPriority('cursor') }
      : null;
    stateEl = el;
    el.style.setProperty('cursor', valueOf(mode), 'important');
  }

  // 与旧版 CSS 的优先级保持一致：drag > wait > click > normal
  function preferredMode() {
    if (dragging) return 'drag';
    if (waitCount > 0) return 'wait';
    if (clicking) return 'click';
    return 'normal';
  }

  function sync(force) {
    var next = preferredMode();
    if (next === mode && !force) return;
    mode = next;
    if (mode === 'normal') { restoreEl(); return; }
    // 只给指针下这一个元素上色；拿不到（从未移动过/元素被重渲染）才退回根节点
    var target = (hoverEl && hoverEl.isConnected) ? hoverEl : document.documentElement;
    paintEl(target);
  }

  /* ---------------- 事件 ---------------- */
  function onPointerOver(e) {
    hoverEl = e.target;
    // 状态保持期间指针移到别的元素上时，把光标挪过去（O(1)）
    if (mode !== 'normal') paintEl(hoverEl);
  }

  function onPointerDown(e) {
    if (e.button !== 0) return;
    hoverEl = e.target;
    if (clickRafId) cancelAnimationFrame(clickRafId);
    clickRafId = requestAnimationFrame(function () {
      clickRafId = null;
      clicking = true;
      sync();
    });
  }

  function onPointerUp(e) {
    if (e.button !== 0) return;
    if (clickRafId) { cancelAnimationFrame(clickRafId); clickRafId = null; } // 同一帧内抬起：快速点击，不进点击态
    if (!clicking) return;
    clicking = false;
    sync();
  }

  function onPointerCancel() {
    if (clickRafId) { cancelAnimationFrame(clickRafId); clickRafId = null; }
    if (!clicking) return;
    clicking = false;
    sync();
  }

  function onDragStart(e) {
    if (e.target) hoverEl = e.target;
    dragging = true;
    sync();
  }

  function onDragEnd() {
    if (!dragging) return;
    dragging = false;
    sync();
  }

  // 窗口失焦 / 指针移出窗口 / 拖到窗外没有 dragend —— 兜底复位，避免光标卡在点击态或拖动态
  // （旧实现只监听 pointerup，按下时若窗口失焦会把光标永久卡在点击态）
  function resetTransient() {
    if (clickRafId) { cancelAnimationFrame(clickRafId); clickRafId = null; }
    var changed = clicking || dragging;
    clicking = false;
    dragging = false;
    if (changed) sync();
  }

  /* ---------------- 等待态（网络请求） ---------------- */
  function beginWait() {
    waitCount++;
    if (waitCount === 1) sync();
  }

  function endWait() {
    if (waitCount > 0) waitCount--;
    if (waitCount === 0) sync();
  }

  function patchNetwork() {
    var origFetch = window.fetch;
    if (typeof origFetch === 'function') {
      window.fetch = function () {
        var args = arguments;
        beginWait();
        var p;
        try {
          p = origFetch.apply(this, args);
        } catch (err) {
          endWait();
          throw err;
        }
        if (p && typeof p.then === 'function') {
          return p.then(function (v) { endWait(); return v; },
                        function (err) { endWait(); throw err; });
        }
        endWait();
        return p;
      };
    }

    if (typeof XMLHttpRequest === 'function' && XMLHttpRequest.prototype) {
      var origSend = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.send = function () {
        var args = arguments;
        beginWait();
        var done = false;
        var finish = function () {
          if (done) return;
          done = true;
          endWait();
        };
        this.addEventListener('loadend', finish);
        this.addEventListener('error', finish);
        this.addEventListener('abort', finish);
        this.addEventListener('timeout', finish);
        try {
          return origSend.apply(this, args);
        } catch (err) {
          finish();
          throw err;
        }
      };
    }
  }

  /* ---------------- 旧安装包兜底：大图降采样 ---------------- */
  function downscaleToDataUrl(img) {
    var c = document.createElement('canvas');
    c.width = RUNTIME_SIZE;
    c.height = RUNTIME_SIZE;
    var ctx = c.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, RUNTIME_SIZE, RUNTIME_SIZE);
    return c.toDataURL('image/png');
  }

  // 补丁只能覆盖 renderer/，assets/ 里的光标图不会随补丁更新。若发现资源还是
  // 2048x2048 的大图（旧安装包），就地降采样，避免浏览器把整张大图当光标位图。
  function verifyAssets() {
    return new Promise(function (resolve) {
      var dataUrls = {};
      var left = NAMES.length;
      var oversized = false;

      NAMES.forEach(function (name) {
        var img = new Image();
        img.onload = function () {
          if (img.naturalWidth > MAX_CURSOR_PX || img.naturalHeight > MAX_CURSOR_PX) {
            oversized = true;
            try { dataUrls[name] = downscaleToDataUrl(img); } catch (e) { /* 忽略 */ }
          }
          done();
        };
        img.onerror = done;
        img.src = PATHS[name];
      });

      function done() {
        if (--left > 0) return;
        if (!oversized) { resolve(false); return; } // 资源已是小图，正常运行路径不付出任何额外成本
        NAMES.forEach(function (n) { if (dataUrls[n]) activeUrls[n] = dataUrls[n]; });
        styleEl.textContent = buildStaticCss(valueOf);
        restoreEl();
        sync(true);
        console.log('[GlobalCursor] 检测到未优化的大图资源，已运行时降采样为 ' + RUNTIME_SIZE + 'x' + RUNTIME_SIZE);
        resolve(true);
      }
    });
  }

  /* ---------------- 安装 ---------------- */
  function install() {
    styleEl = document.createElement('style');
    styleEl.id = 'lobster-cursor-style';
    styleEl.textContent = buildStaticCss(valueOf);
    (document.head || document.documentElement).appendChild(styleEl);

    var opt = { capture: true, passive: true };
    document.addEventListener('pointerover', onPointerOver, opt);
    document.addEventListener('pointerdown', onPointerDown, opt);
    document.addEventListener('pointerup', onPointerUp, opt);
    document.addEventListener('pointercancel', onPointerCancel, opt);
    document.addEventListener('dragstart', onDragStart, opt);
    document.addEventListener('dragend', onDragEnd, opt);
    document.addEventListener('drop', onDragEnd, opt);
    document.addEventListener('mouseleave', resetTransient);
    window.addEventListener('blur', resetTransient);
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) resetTransient();
    });

    patchNetwork();

    // 空闲时校验资源尺寸，不阻塞启动
    if (typeof requestIdleCallback === 'function') requestIdleCallback(verifyAssets, { timeout: 3000 });
    else setTimeout(verifyAssets, 1500);

    // 对外 API（保持与旧版同名，便于外部调用 / 调试）
    window.LobsterCursor = {
      setNormal: function () { waitCount = 0; clicking = false; dragging = false; sync(); },
      setWait: function () { waitCount = 1; sync(); },
      setClick: function () { clicking = true; sync(); },
      setDrag: function () { dragging = true; sync(); },
      setHoverElement: function (el) { hoverEl = el; },
      // 调试/测试用
      getMode: function () { return mode; },
      getPaintedElement: function () { return stateEl; },
      getWaitCount: function () { return waitCount; },
      verifyAssets: verifyAssets,
      assetPaths: PATHS,
      activeUrls: activeUrls
    };

    console.log('[GlobalCursor] 龙虾钳光标已启用（单元素切换版 / 静态继承层）');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', install);
  } else {
    install();
  }
})();
