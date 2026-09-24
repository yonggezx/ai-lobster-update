/**
 * 智能体角色 SVG 图标库
 * 用矢量图标替换 emoji，适配深色/浅色主题
 */
(function () {
  'use strict';

  // 每个角色的 SVG 图标（使用 currentColor 适配主题）
  const ROLE_SVG_ICONS = {
    // 通用助手 - 机器人/AI 芯片
    general: `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" width="100%" height="100%">
      <rect x="4" y="6" width="16" height="14" rx="3" stroke="currentColor" stroke-width="1.8"/>
      <path d="M12 6V3M8 3h8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
      <circle cx="9" cy="12" r="1.5" fill="currentColor"/>
      <circle cx="15" cy="12" r="1.5" fill="currentColor"/>
      <path d="M9 16h6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
      <path d="M2 12v3M22 12v3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
    </svg>`,

    // 程序员 - 代码括号
    coder: `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" width="100%" height="100%">
      <path d="M8 6L3 12l5 6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M16 6l5 6-5 6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M13 4l-2 16" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
    </svg>`,

    // 研究员 - 放大镜+文档
    researcher: `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" width="100%" height="100%">
      <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2z" stroke="currentColor" stroke-width="1.8"/>
      <path d="M8 8h6M8 12h6M8 16h4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
      <circle cx="17" cy="17" r="3.5" stroke="currentColor" stroke-width="1.8"/>
      <path d="M20 20l2 2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
    </svg>`,

    // 文案写手 - 钢笔
    writer: `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" width="100%" height="100%">
      <path d="M12 19l7-7 3 3-7 7-3-3z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>
      <path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>
      <path d="M2 2l7.586 7.586" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
      <circle cx="11" cy="11" r="2" stroke="currentColor" stroke-width="1.8"/>
    </svg>`,

    // 运维工程师 - 齿轮+服务器
    ops: `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" width="100%" height="100%">
      <rect x="3" y="4" width="18" height="7" rx="2" stroke="currentColor" stroke-width="1.8"/>
      <rect x="3" y="13" width="18" height="7" rx="2" stroke="currentColor" stroke-width="1.8"/>
      <circle cx="7" cy="7.5" r="1.2" fill="currentColor"/>
      <circle cx="7" cy="16.5" r="1.2" fill="currentColor"/>
      <path d="M11 7.5h6M11 16.5h6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
    </svg>`,

    // 数据分析师 - 柱状图
    analyst: `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" width="100%" height="100%">
      <path d="M3 3v18h18" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
      <rect x="6" y="10" width="3.5" height="8" rx="1" fill="currentColor" opacity="0.6"/>
      <rect x="10.5" y="6" width="3.5" height="12" rx="1" fill="currentColor" opacity="0.8"/>
      <rect x="15" y="13" width="3.5" height="5" rx="1" fill="currentColor"/>
      <path d="M6 6l3-2 3 2 3-3 3 2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" opacity="0.5"/>
    </svg>`,

    // 默认图标
    default: `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" width="100%" height="100%">
      <circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.8"/>
      <path d="M12 8v4l3 2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
    </svg>`,
  };

  /**
   * 获取角色 SVG 图标
   * @param {string} roleId - 角色 ID
   * @param {string} size - 尺寸
   * @returns {string} HTML 字符串
   */
  function getRoleIcon(roleId, size = '24px') {
    const svg = ROLE_SVG_ICONS[roleId] || ROLE_SVG_ICONS.default;
    return `<span class="role-svg-icon" style="width:${size};height:${size};display:inline-flex;align-items:center;justify-content:center;color:var(--text-secondary);flex-shrink:0;">${svg}</span>`;
  }

  /**
   * 获取角色图标 SVG 原始内容
   */
  function getRoleIconSvg(roleId) {
    return ROLE_SVG_ICONS[roleId] || ROLE_SVG_ICONS.default;
  }

  // 暴露到全局
  window.RoleIcons = {
    getRoleIcon,
    getRoleIconSvg,
    ROLE_SVG_ICONS,
  };

  console.log('[RoleIcons] 角色 SVG 图标库已加载，共 ' + Object.keys(ROLE_SVG_ICONS).length + ' 个图标');
})();
