// dialog.js — 应用内自定义对话框（替代系统原生 alert / confirm / prompt）
//
// 设计要点：
// 1. 自包含：首次使用时注入样式，动态创建覆盖层，不依赖任何第三方样式表，
//    因此主窗口、动作编辑器窗口、桌面宠物窗口（pet.html）均可直接使用。
// 2. 视觉与程序其它弹窗一致（深色半透明遮罩 + 圆角卡片 + 主题变量配色）。
// 3. 【程序规范】弹窗不会因「点击空白处」关闭 —— 必须点击按钮，或按 ESC（视为取消）。
//    避免误触丢失表单输入，也与原生系统弹窗行为解耦（不再出现 OS 风格对话框）。
// 4. z-index 高于普通模态框（#modal-overlay z-index:1000），可在动作编辑器之上弹出确认框。
(function () {
  'use strict';

  const STYLE_ID = 'app-dialog-styles';

  function escapeHtml(s) {
    if (s === null || s === undefined) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  const ICONS = {
    warning: '<svg viewBox="0 0 24 24" fill="none" stroke="#f5a623" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"><path d="M12 3 2 20h20L12 3z"/><line x1="12" y1="9.5" x2="12" y2="14.5"/><circle cx="12" cy="17.5" r="0.9" fill="#f5a623" stroke="none"/></svg>',
    error:   '<svg viewBox="0 0 24 24" fill="none" stroke="#e54d42" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><line x1="8" y1="8" x2="16" y2="16"/><line x1="16" y1="8" x2="8" y2="16"/></svg>',
    success: '<svg viewBox="0 0 24 24" fill="none" stroke="#4caf50" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M7.5 12.3 10.5 15.3 16.5 9"/></svg>',
    info:    '<svg viewBox="0 0 24 24" fill="none" stroke="#4fc3f7" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><line x1="12" y1="11" x2="12" y2="16"/><circle cx="12" cy="8" r="0.9" fill="#4fc3f7" stroke="none"/></svg>'
  };

  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const css = `
.app-dialog-overlay{position:fixed;inset:0;z-index:3000;background:rgba(0,0,0,.6);backdrop-filter:blur(4px);-webkit-backdrop-filter:blur(4px);display:flex;align-items:center;justify-content:center;animation:appDialogFade .18s ease;outline:none}
@keyframes appDialogFade{from{opacity:0}to{opacity:1}}
.app-dialog{background:var(--bg-secondary,#1b1f27);border:1px solid var(--border-color,rgba(255,255,255,.14));border-radius:14px;min-width:280px;max-width:min(520px,calc(100vw - 32px));max-height:min(82vh,calc(100vh - 32px));display:flex;flex-direction:column;box-shadow:0 16px 48px rgba(0,0,0,.45);overflow:hidden;color:var(--text-primary,#e8e8ef);margin:16px}
.app-dialog-header{display:flex;align-items:center;gap:10px;padding:18px 20px 0}
.app-dialog-icon{flex:0 0 auto;width:22px;height:22px;display:inline-flex}
.app-dialog-icon svg{width:100%;height:100%;display:block}
.app-dialog-title{font-size:15px;font-weight:600;color:var(--text-primary,#e8e8ef);line-height:1.4}
.app-dialog-body{padding:14px 20px 6px;font-size:13px;color:var(--text-secondary,#b9c2d0);line-height:1.6;overflow-y:auto}
.app-dialog-message{white-space:pre-wrap;word-break:break-word}
.app-dialog-detail{margin-top:10px;white-space:pre-wrap;word-break:break-word;font-size:12px;color:var(--text-weak,#8a94a6);background:var(--bg-tertiary,rgba(127,127,127,.08));border:1px solid var(--border-color,rgba(255,255,255,.08));border-radius:8px;padding:8px 10px;max-height:160px;overflow:auto}
.app-dialog-input{margin-top:14px;width:100%;box-sizing:border-box;padding:8px 10px;font:inherit;font-size:13px;color:var(--text-primary,#e8e8ef);background:var(--bg-tertiary,rgba(127,127,127,.08));border:1px solid var(--border-color,rgba(255,255,255,.14));border-radius:8px}
.app-dialog-input:focus{outline:none;border-color:var(--accent,#36d6c3);box-shadow:0 0 0 2px var(--accent-glow,rgba(54,214,195,.25))}
.app-dialog-footer{display:flex;justify-content:flex-end;gap:8px;padding:16px 20px 18px;flex:0 0 auto}
.app-dialog-btn{height:34px;padding:0 18px;border-radius:8px;border:1px solid var(--border-color,rgba(255,255,255,.18));background:var(--bg-tertiary,rgba(127,127,127,.12));color:var(--text-primary,#e8e8ef);font-size:13px;cursor:pointer;transition:background .12s,border-color .12s,filter .12s}
.app-dialog-btn:hover{background:var(--bg-hover,rgba(255,255,255,.1))}
.app-dialog-btn.primary{background:var(--accent,#36d6c3);border-color:var(--accent,#36d6c3);color:#06231f;font-weight:600}
.app-dialog-btn.primary:hover{filter:brightness(1.08)}
/* lite 模式：用于无边框/透明的桌面宠物窗口（frame:false, transparent:true）。
   移除半透明背景与背景模糊，避免在小窗口里出现"一大片灰黑团"的视觉丑陋。
   仍保留 position:fixed;inset:0 用于拦截鼠标（让 ESC/按钮交互不受底层点击穿透影响）。
   ★ 修复：宠物窗口较小（约324x466），原卡片 min-width:340px 会超出窗口边界导致显示不全。
   lite 模式下减小 min-width，并用 calc(100vw/vh) 确保卡片始终在窗口内。 */
.app-dialog-overlay--lite{background:transparent!important;backdrop-filter:none!important;-webkit-backdrop-filter:none!important;animation:none!important}
.app-dialog-overlay--lite .app-dialog{min-width:260px!important;max-width:calc(100vw - 24px)!important;max-height:calc(100vh - 24px)!important;margin:12px}
.app-dialog-overlay--lite .app-dialog-header{padding:14px 16px 0}
.app-dialog-overlay--lite .app-dialog-body{padding:10px 16px 4px}
.app-dialog-overlay--lite .app-dialog-footer{padding:12px 16px 14px}
`;
    const s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = css;
    document.head.appendChild(s);
  }

  // 通用打开函数：统一返回 Promise
  // opts: { type, title, message, detail, input:{defaultValue,placeholder}|null, buttons:[...], primaryIndex, lite }
  //   - lite: true 时使用无遮罩样式（适用于无边框/透明的桌面宠物窗口，避免"一大片灰黑团"）
  // 宠物窗口(pet.html)是 frame:false + transparent:true + 动态点击穿透。
  // 对话框打开时必须暂停穿透、强制捕获鼠标，否则按钮点击会穿透到桌面（"退出按钮无效"的根因）。
  // 用计数器支持多层对话框嵌套，最后一个关闭时才恢复穿透。
  let _petDialogDepth = 0;
  function _petDialogEnter() {
    if (!window.api || typeof window.api.setPetIgnoreMouseEvents !== 'function') return;
    _petDialogDepth++;
    if (_petDialogDepth === 1) {
      window.__petDialogActive = true;
      try { window.api.setPetIgnoreMouseEvents(false, false); } catch (_) {}
    }
  }
  function _petDialogLeave() {
    if (!window.api || typeof window.api.setPetIgnoreMouseEvents !== 'function') return;
    if (_petDialogDepth > 0) _petDialogDepth--;
    if (_petDialogDepth === 0) {
      window.__petDialogActive = false;
      // 恢复穿透：交给 pet.html 的 mousemove 动态判断当前位置是否需要捕获
      try { window.api.setPetIgnoreMouseEvents(true, true); } catch (_) {}
    }
  }

  function openDialog(opts) {
    ensureStyles();
    const type = opts.type || 'info';
    const title = opts.title || '';
    const message = opts.message || '';
    const detail = opts.detail || '';
    const inputCfg = opts.input || null;
    const buttons = opts.buttons && opts.buttons.length ? opts.buttons : ['确定'];
    const primaryIndex = (typeof opts.primaryIndex === 'number') ? opts.primaryIndex : 0;
    const hasInput = !!inputCfg;
    const lite = !!opts.lite;

    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'app-dialog-overlay' + (lite ? ' app-dialog-overlay--lite' : '');
      overlay.setAttribute('tabindex', '-1');

      const dlg = document.createElement('div');
      dlg.className = 'app-dialog';

      let inner = '';
      if (title) {
        inner += '<div class="app-dialog-header">'
          + '<span class="app-dialog-icon">' + (ICONS[type] || ICONS.info) + '</span>'
          + '<span class="app-dialog-title">' + escapeHtml(title) + '</span></div>';
      }
      inner += '<div class="app-dialog-body">';
      if (message) inner += '<div class="app-dialog-message">' + escapeHtml(message) + '</div>';
      if (detail) inner += '<div class="app-dialog-detail">' + escapeHtml(detail) + '</div>';
      if (hasInput) {
        inner += '<input class="app-dialog-input" type="text" value="' + escapeHtml(inputCfg.defaultValue || '')
          + '" placeholder="' + escapeHtml(inputCfg.placeholder || '') + '">';
      }
      inner += '</div><div class="app-dialog-footer"></div>';
      dlg.innerHTML = inner;
      overlay.appendChild(dlg);
      document.body.appendChild(overlay);
      _petDialogEnter();

      const footer = dlg.querySelector('.app-dialog-footer');
      const inputEl = dlg.querySelector('.app-dialog-input');

      let done = false;
      const close = (val) => {
        if (done) return;
        done = true;
        document.removeEventListener('keydown', onKey, true);
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
        _petDialogLeave();
        resolve(val);
      };

      const onKey = (e) => {
        if (e.key === 'Escape') {
          e.preventDefault(); e.stopPropagation();
          close(hasInput ? null : false);
        } else if (e.key === 'Enter') {
          e.preventDefault();
          if (hasInput) close(inputEl.value.trim());
          else close(true);
        }
      };

      buttons.forEach((label, i) => {
        const b = document.createElement('button');
        b.className = 'app-dialog-btn' + (i === primaryIndex ? ' primary' : '');
        b.textContent = label;
        b.addEventListener('click', () => {
          if (hasInput) close(i === primaryIndex ? inputEl.value.trim() : null);
          else close(i === primaryIndex ? true : false);
        });
        footer.appendChild(b);
      });

      document.addEventListener('keydown', onKey, true);

      // 焦点：输入框优先，否则聚焦主按钮
      if (inputEl) { inputEl.focus(); inputEl.select(); }
      else { const fb = footer.querySelector('button'); if (fb) fb.focus(); }
    });
  }

  window.AppDialog = {
    // 确认框：返回 boolean（点击主按钮 true，其余/cancel/ESC false）
    // opts.lite = true 时使用无遮罩样式（用于无边框透明桌面宠物窗口）
    confirm: (opts) => openDialog({
      type: (opts && opts.type) || 'warning',
      title: opts && opts.title,
      message: opts && opts.message,
      detail: opts && opts.detail,
      buttons: (opts && opts.buttons) || ['确定', '取消'],
      primaryIndex: 0,
      lite: !!(opts && opts.lite)
    }),
    // 输入框：返回 string（已 trim）或 null（取消/ESC）
    prompt: (opts) => openDialog({
      type: 'info',
      title: (opts && opts.title) || '',
      message: (opts && opts.message) || '',
      detail: opts && opts.detail,
      input: { defaultValue: (opts && opts.defaultValue) || '', placeholder: (opts && opts.placeholder) || '' },
      buttons: (opts && opts.buttons) || ['确定', '取消'],
      primaryIndex: 0,
      lite: !!(opts && opts.lite)
    }),
    // 提示框：返回 true
    alert: (opts) => openDialog({
      type: (opts && opts.type) || 'info',
      title: opts && opts.title,
      message: opts && opts.message,
      detail: opts && opts.detail,
      buttons: (opts && opts.buttons) || ['确定'],
      primaryIndex: 0,
      lite: !!(opts && opts.lite)
    })
  };
})();
