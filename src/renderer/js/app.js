// 内嵌完整包信息（兜底：主进程版本过滤导致 fullInstall 为空时使用）
const EMBEDDED_FULL_INSTALL = {"version":"1.0.7","url":"https://github.com/yonggezx/fuling-shijie-update/releases/download/v1.0.7/AiLobster-Setup-v1.0.7.exe","size":0,"checksum":"","changes":"","releaseDate":"","isFullPackage":true};

// ==================== 全局错误处理（防止白屏） ====================
window.addEventListener('error', (e) => {
  console.error('[Global Error]', e.message, e.filename, e.lineno, e.colno);
  // 阻止错误导致页面崩溃
  e.preventDefault();
  return true;
}, true);

window.addEventListener('unhandledrejection', (e) => {
  console.error('[Unhandled Rejection]', e.reason);
  // 阻止Promise未捕获异常导致页面崩溃
  e.preventDefault();
  return true;
});

// 安全调用函数：包裹try-catch防止白屏
function safeCall(fn, fallback = null) {
  try {
    return fn();
  } catch (e) {
    console.error('[SafeCall Error]', e);
    return fallback;
  }
}

// ==================== 轻量级 Markdown 渲染器 ====================
// 支持表格、代码块、行内代码、粗体、斜体、列表、标题、链接、换行
function renderMarkdown(text) {
  if (!text) return '';
  
  // 1. HTML转义（防止XSS）
  let html = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
  
  // 2. 提取代码块（```...```），先保存起来避免被其他规则处理
  const codeBlocks = [];
  html = html.replace(/```([\s\S]*?)```/g, (match, code) => {
    const idx = codeBlocks.length;
    codeBlocks.push(code);
    return `\u0000CODEBLOCK${idx}\u0000`;
  });
  
  // 3. 表格渲染（| 分隔的表格）
  const lines = html.split('\n');
  let result = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    // 检测表格行：包含 | 且不是代码块占位
    if (line.includes('|') && !line.includes('\u0000CODEBLOCK')) {
      // 检查下一行是否是分隔行（|---|---|）
      if (i + 1 < lines.length && /^\s*\|?[\s\-:|]+\|?\s*$/.test(lines[i + 1])) {
        // 开始表格
        const tableRows = [];
        // 表头
        const headerCells = line.split('|').map(c => c.trim()).filter((c, idx, arr) => {
          // 过滤首尾空单元格
          if (idx === 0 && c === '') return false;
          if (idx === arr.length - 1 && c === '') return false;
          return true;
        });
        tableRows.push({ cells: headerCells, isHeader: true });
        i += 2; // 跳过表头和分隔行
        // 数据行
        while (i < lines.length && lines[i].includes('|') && !lines[i].includes('\u0000CODEBLOCK') && lines[i].trim() !== '') {
          const dataCells = lines[i].split('|').map(c => c.trim()).filter((c, idx, arr) => {
            if (idx === 0 && c === '') return false;
            if (idx === arr.length - 1 && c === '') return false;
            return true;
          });
          tableRows.push({ cells: dataCells, isHeader: false });
          i++;
        }
        // 生成表格HTML
        let tableHtml = '<div class="md-table-wrapper"><table class="md-table">';
        tableRows.forEach((row, rowIdx) => {
          const tag = row.isHeader ? 'th' : 'td';
          tableHtml += '<tr>';
          row.cells.forEach(cell => {
            // 单元格内也渲染行内Markdown
            const cellContent = renderInlineMarkdown(cell);
            tableHtml += `<${tag}>${cellContent}</${tag}>`;
          });
          tableHtml += '</tr>';
        });
        tableHtml += '</table></div>';
        result.push(tableHtml);
        continue;
      }
    }
    result.push(line);
    i++;
  }
  html = result.join('\n');
  
  // 4. 标题渲染（# 开头）
  html = html.replace(/^######\s+(.+)$/gm, '<h6 class="md-h6">$1</h6>');
  html = html.replace(/^#####\s+(.+)$/gm, '<h5 class="md-h5">$1</h5>');
  html = html.replace(/^####\s+(.+)$/gm, '<h4 class="md-h4">$1</h4>');
  html = html.replace(/^###\s+(.+)$/gm, '<h3 class="md-h3">$1</h3>');
  html = html.replace(/^##\s+(.+)$/gm, '<h2 class="md-h2">$1</h2>');
  html = html.replace(/^#\s+(.+)$/gm, '<h1 class="md-h1">$1</h1>');
  
  // 5. 无序列表渲染（- 或 * 开头）
  html = html.replace(/^(\s*)[-*+]\s+(.+)$/gm, (match, indent, content) => {
    const level = Math.floor(indent.length / 2);
    return `<li class="md-li md-li-ul" data-level="${level}">${renderInlineMarkdown(content)}</li>`;
  });
  // 包裹连续的列表项
  html = html.replace(/(<li class="md-li md-li-ul"[^>]*>[\s\S]*?<\/li>)(?=\s*<li class="md-li md-li-ul"|$)/g, (match) => {
    return `<ul class="md-ul">${match}</ul>`;
  });
  
  // 6. 有序列表渲染（数字. 开头）
  html = html.replace(/^(\s*)(\d+)\.\s+(.+)$/gm, (match, indent, num, content) => {
    const level = Math.floor(indent.length / 2);
    return `<li class="md-li md-li-ol" data-level="${level}">${renderInlineMarkdown(content)}</li>`;
  });
  html = html.replace(/(<li class="md-li md-li-ol"[^>]*>[\s\S]*?<\/li>)(?=\s*<li class="md-li md-li-ol"|$)/g, (match) => {
    return `<ol class="md-ol">${match}</ol>`;
  });
  
  // 7. 引用块渲染（> 开头）
  html = html.replace(/^>\s+(.+)$/gm, '<blockquote class="md-blockquote">$1</blockquote>');
  
  // 8. 水平线渲染（--- 或 ***）
  html = html.replace(/^(-{3,}|\*{3,}|_{3,})$/gm, '<hr class="md-hr">');
  
  // 9. 行内Markdown渲染（粗体、斜体、行内代码、链接）
  html = renderInlineMarkdown(html);
  
  // 10. 恢复代码块
  html = html.replace(/\u0000CODEBLOCK(\d+)\u0000/g, (match, idx) => {
    const code = codeBlocks[parseInt(idx)];
    // 移除代码块开头的语言标识（如 ```javascript）
    let cleanCode = code.replace(/^[a-zA-Z0-9+-]*\n/, '');
    return `<pre class="md-pre"><code class="md-code">${cleanCode}</code></pre>`;
  });
  
  // 11. 换行渲染（保留换行）
  html = html.replace(/\n/g, '<br>');
  
  return html;
}

// 行内Markdown渲染（粗体、斜体、行内代码、链接）
function renderInlineMarkdown(text) {
  if (!text) return '';
  
  let result = text;
  
  // 行内代码（`...`）
  result = result.replace(/`([^`]+)`/g, '<code class="md-inline-code">$1</code>');
  
  // 粗体斜体（***...***）
  result = result.replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>');
  
  // 粗体（**...**）
  result = result.replace(/\*\*([^*]+)\*\*/g, '<strong class="md-strong">$1</strong>');
  
  // 斜体（*...* 或 _..._）
  result = result.replace(/\*([^*]+)\*/g, '<em class="md-em">$1</em>');
  result = result.replace(/_([^_]+)_/g, '<em class="md-em">$1</em>');
  
  // 删除线（~~...~~）
  result = result.replace(/~~([^~]+)~~/g, '<del class="md-del">$1</del>');
  
  // 链接（[text](url)）
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" class="md-link">$1</a>');
  
  // 图片（![alt](url)）
  result = result.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1" class="md-img" style="max-width:100%;border-radius:8px;">');
  
  return result;
}

let state = {

  currentTab: 'chat',
  chatHistory: [],           // 兼容旧版：当前活跃会话的消息
  conversations: [],         // 新版：所有会话 [{id, title, messages: [], createdAt, updatedAt}]
  activeConversationId: null,// 当前活跃会话ID
  activeRequestConversationId: null, // 当前正在进行的AI请求所属的会话ID（用于删除会话时取消请求）
  models: [],
  currentModelId: null,
  fileTree: [],
  currentPath: '',
  selectedFiles: new Set(),
  commandHistory: [],
  softwareList: [],
  localModels: [],
  cloudProviders: [],
  activeProviderId: null,
  settings: {},
  systemInfo: {},
  isStreaming: false
};

// 临时变量：用于在 agent-done 事件和消息保存逻辑之间传递 usage 和 elapsedMs
// 因为 agent-done 事件中会把 state.agentState 置为 null，所以需要用独立变量传递
let pendingAgentUsage = null;
let pendingAgentElapsedMs = 0;

// Agent 设置存档 key：聊天页「Agent 设置」面板与上下文自动压缩开关共用同一份存档
const AGENT_SETTINGS_KEY = 'ai-lobster-agent-settings-v2';

// 记录上次发送给主进程的宠物设置快照，避免重复发送导致窗口位移
let lastSentPetSettings = null;


// ========== 高级信息提示框（300ms 延迟 + 复杂内容 + 智能位置） ==========
const INFO_TIP_CONTENTS = {
  temperature: `<div class="tip-title">温度 (Temperature)</div>
    <div class="tip-desc">控制 AI 输出的随机性。值越低输出越确定、保守；值越高输出越随机、多样。温度为 0 时等价于贪心解码，总是选择概率最高的词。</div>
    <div class="tip-section">推荐值</div>
    <div class="tip-list">
      <div class="tip-item"><span class="tip-tag">代码 / 结构化输出</span><span class="tip-val">0 - 0.3</span></div>
      <div class="tip-item"><span class="tip-tag">事实问答 / 翻译</span><span class="tip-val">0.2 - 0.5</span></div>
      <div class="tip-item"><span class="tip-tag">普通对话</span><span class="tip-val default">0.5 - 1.0（默认 0.7）</span></div>
      <div class="tip-item"><span class="tip-tag">创意写作 / 头脑风暴</span><span class="tip-val">0.7 - 1.2</span></div>
    </div>`,
  maxTokens: `<div class="tip-title">最大Token (Max Tokens)</div>
    <div class="tip-desc">限制 AI 单次回复的最大长度。Token 是模型处理文本的基本单位，1 个 token ≈ 0.5 个中文字或 0.75 个英文单词。达到上限后模型会强制停止，可能导致回复被截断。</div>
    <div class="tip-section">推荐值</div>
    <div class="tip-list">
      <div class="tip-item"><span class="tip-tag">短对话 / 问答</span><span class="tip-val">1024 - 2048</span></div>
      <div class="tip-item"><span class="tip-tag">普通对话</span><span class="tip-val default">2048 - 4096（默认 2048）</span></div>
      <div class="tip-item"><span class="tip-tag">长文本 / 代码生成</span><span class="tip-val">4096 - 8192</span></div>
      <div class="tip-item"><span class="tip-tag">Agent / 思考模式</span><span class="tip-val">建议 8192 或更高</span></div>
    </div>
    <div class="tip-section" style="margin-top:8px;">注意</div>
    <div class="tip-desc" style="margin-bottom:0;">设置过小会导致回复被截断；设置过大会增加响应时间和资源消耗。Ollama 本地模型无需设置，使用默认值即可。</div>`,
  systemPrompt: `<div class="tip-title">系统提示词 (System Prompt)</div>
    <div class="tip-desc">设置 AI 的角色、行为和回答风格。系统提示词会在每次对话开始时发送给模型，影响模型的整体表现。可以用来设定 AI 的身份、语气、知识范围、回答格式等。</div>
    <div class="tip-section">使用示例</div>
    <div class="tip-list">
      <div class="tip-item"><span class="tip-tag">设定角色</span><span class="tip-val">"你是一个专业的编程助手"</span></div>
      <div class="tip-item"><span class="tip-tag">设定风格</span><span class="tip-val">"回答简洁明了，使用中文"</span></div>
      <div class="tip-item"><span class="tip-tag">设定限制</span><span class="tip-val">"只回答技术问题"</span></div>
      <div class="tip-item"><span class="tip-tag">设定格式</span><span class="tip-val">"使用 Markdown 格式回答"</span></div>
    </div>
    <div class="tip-section" style="margin-top:8px;">注意</div>
    <div class="tip-desc" style="margin-bottom:0;">留空则使用 AI 的默认行为。系统提示词会影响所有对话，建议根据使用场景调整。</div>`,
  codeConsole: `<div class="tip-title">代码控制台使用说明</div>
    <div class="tip-desc">在这里输入 JavaScript 代码，可以实时控制模型外观和编辑动作关键帧。代码支持 async/await 语法，按 Ctrl+Enter 快速运行。</div>
    <div class="tip-section">一、控制模型外观 (pet.*)</div>
    <div class="tip-list">
      <div class="tip-item"><span class="tip-tag">pet.size(1.5)</span><span class="tip-val">放大模型 (0.2~4)</span></div>
      <div class="tip-item"><span class="tip-tag">pet.opacity(0.8)</span><span class="tip-val">设置透明度 (0~1)</span></div>
      <div class="tip-item"><span class="tip-tag">pet.rotate({yaw:30})</span><span class="tip-val">左右旋转模型</span></div>
      <div class="tip-item"><span class="tip-tag">pet.rotate({pitch:15})</span><span class="tip-val">上下旋转模型</span></div>
      <div class="tip-item"><span class="tip-tag">pet.zoom(1.2)</span><span class="tip-val">缩放视角 (0.3~3)</span></div>
      <div class="tip-item"><span class="tip-tag">pet.reset()</span><span class="tip-val">重置视角和大小</span></div>
      <div class="tip-item"><span class="tip-tag">pet.action('挥手')</span><span class="tip-val">播放指定动作</span></div>
    </div>
    <div class="tip-section" style="margin-top:8px;">二、编辑动作关键帧 (ae.*)</div>
    <div class="tip-list">
      <div class="tip-item"><span class="tip-tag">ae.getDef()</span><span class="tip-val">查看当前动作完整定义</span></div>
      <div class="tip-item"><span class="tip-tag">ae.boneKeys()</span><span class="tip-val">查看所有可用骨骼名称</span></div>
      <div class="tip-item"><span class="tip-tag">ae.morphKeys()</span><span class="tip-val">查看所有可用表情名称</span></div>
      <div class="tip-item"><span class="tip-tag">ae.setMeta({duration:3})</span><span class="tip-val">设置动作总时长(秒)</span></div>
      <div class="tip-item"><span class="tip-tag">ae.setMeta({loop:true})</span><span class="tip-val">设置是否循环播放</span></div>
      <div class="tip-item"><span class="tip-tag">ae.setMeta({speed:1.5})</span><span class="tip-val">设置播放速度倍率</span></div>
      <div class="tip-item"><span class="tip-tag">ae.addKeyframe({t:0.5, bones:{rArm:{z:-1}}})</span><span class="tip-val">在0.5秒处新增关键帧</span></div>
      <div class="tip-item"><span class="tip-tag">ae.updateKeyframe(0, {bones:{lArm:{z:1}}})</span><span class="tip-val">修改第0个关键帧</span></div>
      <div class="tip-item"><span class="tip-tag">ae.updateKeyframeAt(1.0, {morphs:{眨眼:1}})</span><span class="tip-val">修改1.0秒处的关键帧</span></div>
      <div class="tip-item"><span class="tip-tag">ae.removeKeyframe(2)</span><span class="tip-val">删除第2个关键帧</span></div>
      <div class="tip-item"><span class="tip-tag">ae.render()</span><span class="tip-val">手动刷新预览视图</span></div>
    </div>
    <div class="tip-section" style="margin-top:8px;">三、使用示例</div>
    <div class="tip-desc" style="margin-bottom:0;">
      • 放大模型：await pet.size(1.5)<br>
      • 新增挥手帧：ae.addKeyframe({t:0.5, bones:{rArm:{z:-1}}})<br>
      • 设置循环：ae.setMeta({loop:true, duration:2})<br>
      • 查看骨骼：console.log(ae.boneKeys())
    </div>`,
  aiAssistant: `<div class="tip-title">AI 助手使用说明</div>
    <div class="tip-desc">用自然语言描述你想要的动作效果，AI 会自动思考并生成代码来操控模型和编辑关键帧。AI 具备工具调用能力，可以先查询模型信息，再生成代码，还能根据结果迭代优化。</div>
    <div class="tip-section">一、AI 工作流程</div>
    <div class="tip-list">
      <div class="tip-item"><span class="tip-tag">第1步：查询信息</span><span class="tip-val">AI 先调用工具获取模型骨骼、表情和当前动作信息</span></div>
      <div class="tip-item"><span class="tip-tag">第2步：思考方案</span><span class="tip-val">根据查询到的信息，思考如何实现你描述的效果</span></div>
      <div class="tip-item"><span class="tip-tag">第3步：生成代码</span><span class="tip-val">生成 JavaScript 代码并执行，实时作用于模型</span></div>
      <div class="tip-item"><span class="tip-tag">第4步：检查优化</span><span class="tip-val">检查执行结果，如果不理想会继续调整和优化</span></div>
    </div>
    <div class="tip-section" style="margin-top:8px;">二、AI 可调用的工具</div>
    <div class="tip-list">
      <div class="tip-item"><span class="tip-tag">get_model_bones</span><span class="tip-val">获取模型所有可用骨骼名称和说明</span></div>
      <div class="tip-item"><span class="tip-tag">get_morph_list</span><span class="tip-val">获取模型所有可用表情名称</span></div>
      <div class="tip-item"><span class="tip-tag">get_current_action</span><span class="tip-val">获取当前正在编辑的动作完整定义</span></div>
      <div class="tip-item"><span class="tip-tag">execute_code</span><span class="tip-val">执行 JavaScript 代码操控模型和关键帧</span></div>
    </div>
    <div class="tip-section" style="margin-top:8px;">三、使用示例</div>
    <div class="tip-desc" style="margin-bottom:0;">
      • "让左手举得更高一点"<br>
      • "做一个 3 秒的循环挥手动作"<br>
      • "让模型眨眨眼，然后微笑"<br>
      • "把右手旋转 45 度"<br>
      • "让动作播放速度变慢一点"
    </div>
    <div class="tip-section" style="margin-top:8px;">四、注意事项</div>
    <div class="tip-desc" style="margin-bottom:0;">
      • AI 编辑关键帧时是"累加"进行的，不会重置你已有的动作<br>
      • 最多进行 6 轮工具调用和思考<br>
      • 如果 AI 生成的效果不理想，可以继续用自然语言描述调整方向<br>
      • 需要先在「AI 配置」中设置可用的 AI 服务
    </div>`
};
let infoTipEl = null;
let infoTipTimer = null;
let infoTipCurrentEl = null;


// ==================== 统一自定义 Tooltip 组件 ====================
// 替换浏览器默认 tooltip，使用项目统一的深色/浅色主题样式
function initCustomTooltip() {
  if (document.getElementById('custom-tooltip')) return;

  const tooltipEl = document.createElement('div');
  tooltipEl.id = 'custom-tooltip';
  // 使用与 .info-tip 相同的样式（背景、边框、阴影、圆角），保持项目统一
  tooltipEl.style.cssText = 'position:fixed;z-index:999999;display:none;padding:8px 12px;background:rgba(20,22,30,0.97);color:#eef1f6;border:1px solid rgba(255,255,255,0.1);border-radius:10px;font-size:12px;line-height:1.5;pointer-events:none;box-shadow:0 8px 28px rgba(0,0,0,0.5),0 0 0 1px rgba(255,255,255,0.08);max-width:280px;max-height:120px;overflow-y:auto;word-wrap:break-word;transition:opacity 0.15s ease,transform 0.15s ease;backdrop-filter:blur(8px);opacity:0;transform:translateY(4px);';
  document.body.appendChild(tooltipEl);

  let showTimer = null;
  let activeEl = null;

  function hideTooltip() {
    clearTimeout(showTimer);
    if (activeEl) {
      const saved = activeEl.getAttribute('data-tt-title');
      if (saved) {
        activeEl.setAttribute('title', saved);
        activeEl.removeAttribute('data-tt-title');
      }
      activeEl = null;
    }
    tooltipEl.style.opacity = '0';
    setTimeout(() => { if (tooltipEl.style.opacity === '0') tooltipEl.style.display = 'none'; }, 150);
  }

  document.addEventListener('mouseover', function(e) {
    const target = e.target.closest('[title]');
    if (!target || !target.title) return;
    // 跳过空标题或纯空格，避免显示空黑框
    const titleText = target.title.trim();
    if (!titleText) return;

    activeEl = target;
    clearTimeout(showTimer);
    showTimer = setTimeout(function() {
      if (!activeEl || !activeEl.getAttribute('title')) return;
      const text = activeEl.getAttribute('title');
      // 保存并清空 title，阻止浏览器默认 tooltip
      activeEl.setAttribute('data-tt-title', text);
      activeEl.removeAttribute('title');

      tooltipEl.textContent = text;
      tooltipEl.style.display = 'block';
      tooltipEl.style.opacity = '0';

      // 位置计算：优先显示在元素下方，下方空间不足则显示在上方
      const rect = activeEl.getBoundingClientRect();
      // 先设置位置获取实际尺寸
      tooltipEl.style.left = '0px';
      tooltipEl.style.top = '0px';
      const tw = tooltipEl.offsetWidth;
      const th = tooltipEl.offsetHeight;

      let left = rect.left + rect.width / 2 - tw / 2;
      let top = rect.bottom + 6;

      // 水平边界
      if (left < 6) left = 6;
      if (left + tw > window.innerWidth - 6) left = window.innerWidth - tw - 6;
      // 垂直边界：下方不够则放上方
      if (top + th > window.innerHeight - 6) {
        top = rect.top - th - 6;
        if (top < 6) top = 6; // 上方也不够则贴顶
      }

      tooltipEl.style.left = left + 'px';
      tooltipEl.style.top = top + 'px';
      tooltipEl.style.opacity = '1';
    }, 300);
  });

  // 用 mouseleave 更可靠：鼠标离开文档或进入无title元素时隐藏
  document.addEventListener('mouseout', function(e) {
    if (!activeEl) return;
    // 检查鼠标是否还在 activeEl 或其子元素内
    const related = e.relatedTarget;
    if (related && activeEl.contains(related)) return;
    hideTooltip();
  });

  // 点击时隐藏
  document.addEventListener('click', hideTooltip, true);
  // 滚动时隐藏
  document.addEventListener('scroll', hideTooltip, true);
  // 窗口大小改变时隐藏
  window.addEventListener('resize', hideTooltip);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initCustomTooltip);
} else {
  initCustomTooltip();
}

// 龙虾钳鼠标光标：使用用户提供的PNG图片，正常/等待/点击/拖动四种状态

function ensureInfoTipEl() {
  if (!infoTipEl) {
    infoTipEl = document.createElement('div');
    infoTipEl.className = 'info-tip';
    infoTipEl.setAttribute('role', 'tooltip');
    document.body.appendChild(infoTipEl);
  }
  return infoTipEl;
}

function showInfoTip(targetEl) {
  const tipKey = targetEl.getAttribute('data-info-tip');
  // 优先从 i18n 获取提示内容（支持中英文切换），回退到硬编码的 INFO_TIP_CONTENTS
  // 注意：i18n找不到翻译时会返回key本身，需要检查并回退
  let content = null;
  const i18nKey = 'aiConfig.' + tipKey + 'Tip';
  const i18nResult = window.I18N?.t?.(i18nKey);
  if (i18nResult && i18nResult !== i18nKey && !i18nResult.startsWith('aiConfig.')) {
    content = i18nResult;
  }
  if (!content) content = INFO_TIP_CONTENTS[tipKey];
  if (!content) return;

  const tip = ensureInfoTipEl();
  tip.innerHTML = content;
  infoTipCurrentEl = targetEl;

  // 先显示以获取尺寸
  tip.style.visibility = 'hidden';
  tip.style.display = 'block';
  tip.classList.add('visible');

  // 计算位置
  const rect = targetEl.getBoundingClientRect();
  const tipRect = tip.getBoundingClientRect();
  const viewportW = window.innerWidth;
  const viewportH = window.innerHeight;
  const gap = 8;

  // 优先显示在上方，空间不够则显示在下方
  let top, left;
  const spaceAbove = rect.top;
  const spaceBelow = viewportH - rect.bottom;

  if (spaceAbove >= tipRect.height + gap + 16) {
    top = rect.top - tipRect.height - gap;
  } else if (spaceBelow >= tipRect.height + gap + 16) {
    top = rect.bottom + gap;
  } else {
    top = Math.max(8, rect.top - tipRect.height - gap);
  }

  // 水平居中，确保不超出视口
  left = rect.left + rect.width / 2 - tipRect.width / 2;
  left = Math.max(8, Math.min(left, viewportW - tipRect.width - 8));

  tip.style.top = top + 'px';
  tip.style.left = left + 'px';
  tip.style.visibility = 'visible';
}

function hideInfoTip() {
  if (infoTipEl) {
    infoTipEl.classList.remove('visible');
    infoTipCurrentEl = null;
    setTimeout(() => {
      if (!infoTipCurrentEl && infoTipEl) {
        infoTipEl.style.display = 'none';
      }
    }, 150);
  }
}

function initInfoTips() {
  document.addEventListener('mouseover', (e) => {
    const target = e.target.closest('[data-info-tip]');
    if (!target || target === infoTipCurrentEl) return;
    if (infoTipTimer) {
      clearTimeout(infoTipTimer);
      infoTipTimer = null;
    }
    infoTipTimer = setTimeout(() => {
      showInfoTip(target);
      infoTipTimer = null;
    }, 300);
  });

  document.addEventListener('mouseout', (e) => {
    const target = e.target.closest('[data-info-tip]');
    if (!target) return;
    if (infoTipTimer) {
      clearTimeout(infoTipTimer);
      infoTipTimer = null;
    }
    if (infoTipCurrentEl === target) {
      hideInfoTip();
    }
  });

  window.addEventListener('scroll', () => {
    if (infoTipCurrentEl) hideInfoTip();
  }, true);

;
}

// ==================== 初始化 ====================
// 全局禁用拼写检查，防止输入或修改文本时文字下方出现红色波浪线（^）
function disableSpellCheckGlobally() {
  // 禁用所有现有输入框和文本域的拼写检查
  const disableForElement = (el) => {
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) {
      el.spellcheck = false;
      el.setAttribute('spellcheck', 'false');
    }
  };

  // 处理现有元素
  document.querySelectorAll('input, textarea, [contenteditable="true"]').forEach(disableForElement);

  // 使用 MutationObserver 监听动态创建的输入框
  const observer = new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
      mutation.addedNodes.forEach((node) => {
        if (node.nodeType === Node.ELEMENT_NODE) {
          // 检查新增的元素本身
          disableForElement(node);
          // 检查新增元素的子元素
          if (node.querySelectorAll) {
            node.querySelectorAll('input, textarea, [contenteditable="true"]').forEach(disableForElement);
          }
        }
      });
    });
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true
  });
}


/**
 * 代码块复制按钮：事件委托，点击复制对应代码块内容到剪贴板
 */
function setupCodeCopyButtons() {
  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('.md-copy-btn');
    if (!btn) return;
    e.stopPropagation();
    const block = btn.closest('.md-code-block');
    if (!block) return;
    const codeEl = block.querySelector('code.md-code');
    if (!codeEl) return;
    const text = codeEl.textContent;
    try {
      await navigator.clipboard.writeText(text);
    } catch (_) {
      // 降级：用 textarea + execCommand
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } catch (__) {}
      document.body.removeChild(ta);
    }
    const original = btn.textContent;
    btn.textContent = '已复制';
    btn.classList.add('copied');
    setTimeout(() => {
      btn.textContent = original;
      btn.classList.remove('copied');
    }, 2000);
  });
}
async function init() {
  injectIcons();
  // 全局禁用拼写检查，防止输入或修改文本时文字下方出现红色波浪线（^）
  disableSpellCheckGlobally();
  if (IS_EDITOR_WINDOW) {
    // 动作编辑器独立窗口：复用同一 index.html，只初始化编辑器所需部分
    setupEditorWindowControls();
    setupIpcListeners();
    // 初始化高级信息提示框（温度/API说明等悬停提示）
    if (typeof initInfoTips === 'function') initInfoTips();
    await bootstrapEditorWindow();
    return;
  }
  setupNavigation();
  setupUpdateModal();
  setupDownloadCenter();
  setupWindowControls();
  setupEventListeners();
  setupCodeCopyButtons();
  setupIpcListeners();
  setupPresetCards();
  initRoleManagement();

  await loadInitialData();
  // Delay Ollama connection check to ensure service has time to start
  setTimeout(() => {
    checkOllamaConnection(3);
    updatePresetCardStatus();
  }, 2000);
  setupChangelogModal();
  checkForUpdates();
  // 初始化工具栏图标样式（浅色模式下使用描边式）
  setTimeout(() => updateToolbarIconStyles(), 100);

  // ★ 渲染进程内存优化：定期清理
  startRendererMemoryOptimization();

  // ★ 后台模式处理：主窗口隐藏时暂停不必要的渲染和计算
  if (window.api && window.api.on) {
    window.api.on('app:background-mode', (data) => {
      if (data && data.enabled) {
        console.log('[MemoryOptimizer] 进入后台模式，暂停不必要的渲染和计算');
        enterBackgroundMode();
      } else {
        console.log('[MemoryOptimizer] 退出后台模式，恢复渲染和计算');
        exitBackgroundMode();
      }
    });
  }
}

// ============================================================
// 后台模式管理
// ============================================================
let isBackgroundMode = false;
let backgroundModeTimers = [];

function enterBackgroundMode() {
  if (isBackgroundMode) return;
  isBackgroundMode = true;

  // 1. 暂停动画帧循环（如果有）
  if (window.animationFrameId) {
    cancelAnimationFrame(window.animationFrameId);
    window.animationFrameId = null;
  }

  // 2. 暂停不必要的定时器（记录下来以便恢复）
  // 这里可以根据需要暂停特定的定时器

  // 3. 触发垃圾回收
  if (window.gc) {
    try { window.gc(); } catch (e) {}
  }

  // 4. 通知主进程进行内存优化
  if (window.api && window.api.optimizeMemory) {
    window.api.optimizeMemory().catch(() => {});
  }

  console.log('[MemoryOptimizer] 后台模式已启用');
}

function exitBackgroundMode() {
  if (!isBackgroundMode) return;
  isBackgroundMode = false;

  // 1. 恢复渲染（重新渲染当前界面）
  try {
    renderChat();
    renderConversationList();
  } catch (e) {}

  // 2. 恢复定时器（如果有暂停的）

  console.log('[MemoryOptimizer] 后台模式已退出，渲染已恢复');
}

// ============================================================
// 渲染进程内存优化
// ============================================================
function startRendererMemoryOptimization() {
  // 每10分钟执行一次内存清理
  setInterval(() => {
    try {
      cleanupRendererMemory();
    } catch (e) {
      console.error('[MemoryOptimizer] 渲染进程内存清理失败:', e.message);
    }
  }, 10 * 60 * 1000);

  // 页面隐藏时立即执行内存清理
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      setTimeout(() => cleanupRendererMemory(), 1000);
    }
  });

  console.log('[MemoryOptimizer] 渲染进程内存优化已启动');
}

function cleanupRendererMemory() {
  console.log('[MemoryOptimizer] 开始渲染进程内存清理...');

  // 1. 清理聊天历史记录（通过saveConversations中的限制逻辑）
  if (state.conversations && state.conversations.length > 0) {
    saveConversations();
  }

  // 2. 清理不需要的DOM元素（已关闭的弹窗、临时元素等）
  const tempElements = document.querySelectorAll('.temp-element, .toast-container .toast:not(.show)');
  tempElements.forEach(el => {
    if (el && el.parentNode) {
      el.parentNode.removeChild(el);
    }
  });

  // 3. 清理已完成的下载记录（保留最近20条）
  if (state.completedDownloads && state.completedDownloads.length > 20) {
    state.completedDownloads = state.completedDownloads.slice(-20);
  }

  // 4. 触发浏览器垃圾回收（如果可用）
  if (window.gc) {
    try { window.gc(); } catch (e) {}
  }

  // 5. 通知主进程进行内存优化
  if (window.api && window.api.optimizeMemory) {
    window.api.optimizeMemory().catch(() => {});
  }

  console.log('[MemoryOptimizer] 渲染进程内存清理完成');
}

// ========== 应用更新 ==========
const BETA_JSON_URL = 'https://raw.githubusercontent.com/yonggezx/fuling-shijie-update/main/update/beta.json';
let currentUpdateInfo = null;

function isBetaVersion(version) {
  if (!version) return false;
  const v = version.toLowerCase();
  return v.includes('beta') || v.includes('alpha') || v.includes('rc') || v.includes('preview') || v.split('.').length > 3;
}

function compareVer(a, b) {
  const pa = String(a).replace(/[^0-9.]/g, '').split('.').map(Number);
  const pb = String(b).replace(/[^0-9.]/g, '').split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const da = pa[i] || 0, db = pb[i] || 0;
    if (da > db) return 1; if (da < db) return -1;
  }
  return 0;
}

async function fetchUpdateFromUrl(url, currentVersion) {
  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) return { success: false, error: 'HTTP ' + res.status };
    const meta = await res.json();
    if (compareVer(currentVersion, meta.latestVersion) >= 0)
      return { success: true, hasUpdate: false, currentVersion, latestVersion: meta.latestVersion };
    const direct = (meta.patches || []).find(p => p.from === currentVersion && p.to === meta.latestVersion);
    const patches = direct ? [direct] : (meta.patches || []).filter(p => compareVer(p.from, currentVersion) >= 0 && compareVer(p.to, meta.latestVersion) <= 0);
    return { success: true, hasUpdate: true, currentVersion, latestVersion: meta.latestVersion, releaseDate: meta.releaseDate || '', changes: meta.changes || '', patches, ignored: false, channel: meta.channel || 'beta', requiresFullInstall: patches.some(p => p.requiresFullInstall) };
  } catch (e) { return { success: false, error: e.message }; }
}

async function checkForAppUpdate(manual, forceBeta) {
  const btn = document.getElementById('btn-check-update');
  if (btn) { btn.disabled = true; btn.textContent = I18N.t('update.checking'); }
  try {
    const result = await window.api.updateCheck();
    if (!result || !result.success) {
      if (manual) showToast(I18N.t('update.checkFailed'), (result && result.error) || I18N.t('update.networkError'), 'error');
      return;
    }
    if (result.hasUpdate && !result.ignored) {
      currentUpdateInfo = result;
      showUpdateModal(result);
    } else if (manual) {
      showToast(I18N.t('update.alreadyLatest'), 'v' + result.currentVersion, 'success');
    }
  } catch (err) {
    if (manual) showToast(I18N.t('update.checkFailed'), err.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = I18N.t('settings.checkUpdate'); }
  }
}

function showUpdateModal(info) {
  const onlyFull = !info.hasUpdate && info.fullInstall;
  const displayVersion = onlyFull ? info.fullInstall.version : info.latestVersion;
  document.getElementById('update-new-version').textContent = 'v' + displayVersion;
  document.getElementById('update-beta-badge').style.display = info.channel === 'beta' ? 'inline-block' : 'none';
  document.getElementById('update-release-date').textContent = info.fullInstall ? (info.fullInstall.releaseDate || '') : (info.releaseDate || '');
  const stepsInfo = info.multiStep && info.patches ? `（跨 ${info.patches.length} 个版本连续更新）` : '';
  const refreshInfo = info.sameVersionRefresh ? '（内容已更新，建议修复更新）' : '';
  const fullOnlyInfo = onlyFull ? '（完整安装包，含主进程更新）' : '';
  document.getElementById('update-changes').textContent = (info.fullInstall ? info.fullInstall.changes : info.changes || '') + stepsInfo + refreshInfo + fullOnlyInfo;
  document.getElementById('update-progress-wrap').style.display = 'none';
  document.getElementById('update-status').textContent = '';
  // 完整包下载按钮：有完整包信息时显示
  const fullBtn = document.getElementById('update-full-package');
  if (fullBtn) {
    if (info.fullInstall && !info.isFullPackage) {
      fullBtn.style.display = 'inline-block';
      fullBtn.disabled = false;
      fullBtn.onclick = () => {
        document.getElementById('update-modal-overlay').classList.remove('show');
        startFullDownload(info.fullInstall);
        switchTab('downloads');
      };
    } else {
      fullBtn.style.display = 'none';
    }
  }
  const confirmBtn = document.getElementById('update-confirm');
  if (onlyFull) {
    confirmBtn.style.display = 'none';
  } else {
    confirmBtn.style.display = 'inline-block';
    confirmBtn.disabled = false;
    confirmBtn.textContent = info.sameVersionRefresh ? I18N.t('update.repairNow') : I18N.t('update.updateNow');
    confirmBtn.onclick = doUpdate;
  }
  document.getElementById('update-modal-overlay').classList.add('show');
}

async function doUpdate() {
  if (!currentUpdateInfo || !currentUpdateInfo.patches.length) return;
  const confirmBtn = document.getElementById('update-confirm');
  confirmBtn.disabled = true;
  confirmBtn.textContent = I18N.t('update.updating');
  document.getElementById('update-progress-wrap').style.display = 'block';
  const progressBar = document.getElementById('update-progress-bar');
  const progressText = document.getElementById('update-progress-percent');
  const statusEl = document.getElementById('update-status');
  const total = currentUpdateInfo.patches.length;
  let completed = 0;

  window.api.onUpdateDownloadProgress(function(data) {
    // 多版本整体进度 = (已完成*100 + 当前补丁进度) / 总数
    const overall = total > 1 ? Math.round((completed * 100 + data.percent) / total) : data.percent;
    progressBar.style.width = overall + '%';
    progressText.textContent = overall + '%';
  });

  let lastApplyResult = null;
  let allSuccess = true;
  for (let i = 0; i < total; i++) {
    const patch = currentUpdateInfo.patches[i];
    statusEl.textContent = I18N.t('update.downloadingPatch').replace('{i}', i + 1).replace('{total}', total).replace('{from}', patch.from).replace('{to}', patch.to);
    const dlResult = await window.api.updateDownload(patch);
    if (!dlResult.success) { statusEl.textContent = I18N.t('update.downloadFailed') + ': ' + dlResult.error; allSuccess = false; break; }
    if (patch.checksum) {
      const v = await window.api.updateVerify({ zipPath: dlResult.zipPath, checksum: patch.checksum });
      if (!v.success) { statusEl.textContent = I18N.t('update.verifyFailed'); allSuccess = false; break; }
    }
    statusEl.textContent = I18N.t('update.applyingPatch').replace('{i}', i + 1).replace('{total}', total).replace('{from}', patch.from).replace('{to}', patch.to);
    const applyResult = await window.api.updateApply({ zipPath: dlResult.zipPath, patchInfo: patch });
    if (!applyResult.success) { statusEl.textContent = I18N.t('update.applyFailed') + ': ' + applyResult.error; allSuccess = false; break; }
    lastApplyResult = applyResult;
    completed++;
  }

  if (allSuccess) {
    progressBar.style.width = '100%';
    progressText.textContent = '100%';
    if (lastApplyResult && lastApplyResult.isFullPackage) {
      statusEl.textContent = I18N.t('update.fullReady');
      confirmBtn.textContent = I18N.t('update.restartInstall');
      confirmBtn.disabled = false;
      const installerPath = lastApplyResult.installerPath;
      confirmBtn.onclick = function() { window.api.updateRunInstaller({ installerPath }); };
    } else {
      statusEl.textContent = total > 1 ? I18N.t('update.multiVersionDone').replace('{total}', total) : I18N.t('update.updateDone');
      confirmBtn.textContent = I18N.t('update.restart');
      confirmBtn.disabled = false;
      confirmBtn.onclick = function() { window.api.relaunchApp(); };
    }
    if (typeof updateVersionDisplay === 'function' && currentUpdateInfo) {
      updateVersionDisplay(currentUpdateInfo.latestVersion);
    }
  } else {
    confirmBtn.disabled = false;
    confirmBtn.textContent = I18N.t('update.retry');
    confirmBtn.onclick = doUpdate;
  }
}

// 完整包下载安装
async function doFullPackageUpdate(fullInfo) {
  const fullBtn = document.getElementById('update-full-package');
  const confirmBtn = document.getElementById('update-confirm');
  const progressWrap = document.getElementById('update-progress-wrap');
  const progressBar = document.getElementById('update-progress-bar');
  const progressText = document.getElementById('update-progress-percent');
  const statusEl = document.getElementById('update-status');

  fullBtn.disabled = true;
  confirmBtn.disabled = true;
  progressWrap.style.display = 'block';
  statusEl.textContent = I18N.t('update.downloadingFull');

  window.api.onUpdateDownloadProgress(function(data) {
    progressBar.style.width = data.percent + '%';
    progressText.textContent = data.percent + '%';
  });

  try {
    const dlResult = await window.api.updateDownload(fullInfo);
    if (!dlResult.success) { statusEl.textContent = '下载失败: ' + dlResult.error; fullBtn.disabled = false; confirmBtn.disabled = false; return; }
    if (fullInfo.checksum) {
      statusEl.textContent = I18N.t('update.verifyingFull');
      const v = await window.api.updateVerify({ zipPath: dlResult.zipPath, checksum: fullInfo.checksum });
      if (!v.success) { statusEl.textContent = '校验失败，文件可能已损坏'; fullBtn.disabled = false; confirmBtn.disabled = false; return; }
    }
    statusEl.textContent = I18N.t('update.preparingInstaller');
    const applyResult = await window.api.updateApply({ zipPath: dlResult.zipPath, patchInfo: fullInfo });
    if (!applyResult.success) { statusEl.textContent = '失败: ' + applyResult.error; fullBtn.disabled = false; confirmBtn.disabled = false; return; }
    progressBar.style.width = '100%';
    progressText.textContent = '100%';
    statusEl.textContent = '完整安装包已就绪，点击下方按钮重启并安装';
    confirmBtn.textContent = '重启并安装';
    confirmBtn.disabled = false;
    confirmBtn.onclick = function() { window.api.updateRunInstaller({ installerPath: applyResult.installerPath }); };
    fullBtn.style.display = 'none';
    if (typeof updateVersionDisplay === 'function') updateVersionDisplay(fullInfo.version);
  } catch (err) {
    statusEl.textContent = I18N.t('update.error') + ': ' + err.message;
    fullBtn.disabled = false;
    confirmBtn.disabled = false;
  }
}

// ========== 下载中心 ==========
const activeDownloads = new Map(); // id -> { fullInstall, phase, percent, message, error }
let downloadIdCounter = 0;

function startFullDownload(fullInstall) {
  if (activeDownloads.size > 0) {
    showToast(I18N.t('download.existingTask'), I18N.t('download.waitExisting'), 'info');
    switchTab('downloads');
    return;
  }
  const id = ++downloadIdCounter;
  const item = {
    id,
    version: fullInstall.version,
    name: `浮灵饰界 v${fullInstall.version} 完整安装包`,
    phase: 'downloading',
    percent: 0,
    message: I18N.t('download.preparing'),
    fullInstall
  };
  activeDownloads.set(id, item);
  renderDownloads();

  // 监听进度
  const offProgress = window.api.onFullDownloadProgress(function(data) {
    item.phase = data.phase;
    item.percent = data.percent;
    item.message = data.message;
    renderDownloads();
  });

  window.api.updateDownloadFull(fullInstall).then(function(result) {
    offProgress();
    if (result.success) {
      item.phase = 'complete';
      item.percent = 100;
      item.message = I18N.t('download.completed');
      item.installerPath = result.installerPath;
      item.size = result.size;
      showToast(I18N.t('download.completed'), item.name + ' ' + I18N.t('download.completedSuffix'), 'success');
    } else {
      item.phase = 'error';
      item.message = I18N.t('download.failed') + ': ' + result.error;
      showToast(I18N.t('download.failed'), result.error, 'error');
    }
    activeDownloads.delete(id);
    renderDownloads();
    loadCompletedDownloads();
  }).catch(function(err) {
    offProgress();
    item.phase = 'error';
    item.message = '错误: ' + err.message;
    activeDownloads.delete(id);
    renderDownloads();
    loadCompletedDownloads();
  });
}

function renderDownloads() {
  const activeEl = document.getElementById('downloads-active');
  const completedEl = document.getElementById('downloads-completed');
  if (!activeEl || !completedEl) return;

  // 正在下载
  if (activeDownloads.size === 0) {
    activeEl.innerHTML = '<div class="downloads-empty">暂无下载任务</div>';
  } else {
    activeEl.innerHTML = '';
    for (const item of activeDownloads.values()) {
      let statusClass = 'status-downloading', statusText = '下载中';
      if (item.phase === 'merging') { statusClass = 'status-merging'; statusText = '合并中'; }
      else if (item.phase === 'verifying') { statusClass = 'status-verifying'; statusText = '校验中'; }
      else if (item.phase === 'error') { statusClass = 'status-error'; statusText = '失败'; }
      activeEl.innerHTML += `
        <div class="download-item">
          <div class="download-item-icon">${window.ElIcons.getIcon('archive')}</div>
          <div class="download-item-info">
            <div class="download-item-name">${item.name}</div>
            <div class="download-item-meta">${item.message}</div>
            <div class="download-item-progress"><div class="download-item-progress-bar" style="width:${item.percent}%"></div></div>
          </div>
          <span class="download-item-status ${statusClass}">${statusText} ${item.phase !== 'error' ? item.percent + '%' : ''}</span>
        </div>`;
    }
  }
}

async function loadCompletedDownloads() {
  const completedEl = document.getElementById('downloads-completed');
  if (!completedEl) return;
  try {
    const result = await window.api.updateGetDownloads();
    const packages = result.packages || [];
    if (packages.length === 0) {
      completedEl.innerHTML = '<div class="downloads-empty">暂无已下载的安装包</div>';
      return;
    }
    completedEl.innerHTML = '';
    for (const pkg of packages) {
      completedEl.innerHTML += `
        <div class="download-item">
          <div class="download-item-icon">${window.ElIcons.getIcon('success')}</div>
          <div class="download-item-info">
            <div class="download-item-name">${pkg.name}</div>
            <div class="download-item-meta">${pkg.sizeMB} MB · ${new Date(pkg.createdAt).toLocaleString('zh-CN')}</div>
            <div class="download-item-meta" style="margin-top:2px;opacity:0.7;font-size:11px;">${pkg.path}</div>
          </div>
          <span class="download-item-status status-complete">已完成</span>
          <div class="download-item-actions">
            <button class="btn btn-sm btn-primary" onclick="installDownloadedPackage('${pkg.path.replace(/\\/g, '\\\\')}')">安装</button>
            <button class="btn btn-sm" onclick="showInFolder('${pkg.path.replace(/\\/g, '\\\\')}')" title="在文件夹中显示">${window.ElIcons.getIcon('folder')}</button>
            <button class="btn btn-sm" onclick="deleteDownloadedPackage('${pkg.path.replace(/\\/g, '\\\\')}')">删除</button>
          </div>
        </div>`;
    }
  } catch (e) {
    completedEl.innerHTML = '<div class="downloads-empty">加载失败: ' + e.message + '</div>';
  }
}

async function installDownloadedPackage(filePath) {
  try {
    await window.api.updateRunInstaller({ installerPath: filePath });
  } catch (e) {
    showToast('安装失败', e.message, 'error');
  }
}

async function deleteDownloadedPackage(filePath) {
  try {
    const result = await window.api.updateDeleteDownload({ filePath });
    if (result.success) {
      showToast('已删除', '安装包已删除', 'success');
      loadCompletedDownloads();
    } else {
      showToast('删除失败', result.error, 'error');
    }
  } catch (e) {
    showToast('删除失败', e.message, 'error');
  }
}

async function showInFolder(filePath) {
  try {
    await window.api.updateShowInFolder({ filePath });
  } catch (e) {
    showToast('打开失败', e.message, 'error');
  }
}

function setupDownloadCenter() {
  // 暴露到 window 供 onclick 调用
  window.installDownloadedPackage = installDownloadedPackage;
  window.deleteDownloadedPackage = deleteDownloadedPackage;
  window.showInFolder = showInFolder;
  // 刷新按钮
  const refreshBtn = document.getElementById('btn-refresh-downloads');
  if (refreshBtn) refreshBtn.onclick = function() { loadCompletedDownloads(); renderDownloads(); };
  // 下载目录设置
  initDownloadDirSetting();
}

async function initDownloadDirSetting() {
  const input = document.getElementById('download-dir');
  if (!input) return;
  try {
    const result = await window.api.updateGetDownloadDir();
    input.value = result.dir || '';
  } catch (e) {}
  const chooseBtn = document.getElementById('btn-choose-download-dir');
  if (chooseBtn) chooseBtn.onclick = async function() {
    try {
      const result = await window.api.updateChooseDownloadDir();
      if (!result.canceled && result.dir) {
        const saveRes = await window.api.updateSetDownloadDir({ dir: result.dir });
        if (saveRes.success) {
          input.value = saveRes.dir || result.dir;
          showToast('已保存', '下载目录已更新', 'success');
        } else {
          showToast('保存失败', saveRes.error, 'error');
        }
      }
    } catch (e) { showToast('选择失败', e.message, 'error'); }
  };
  const resetBtn = document.getElementById('btn-reset-download-dir');
  if (resetBtn) resetBtn.onclick = async function() {
    try {
      const result = await window.api.updateResetDownloadDir();
      if (result.success) {
        input.value = result.dir;
        showToast('已恢复', '下载目录已恢复默认', 'success');
      }
    } catch (e) { showToast('操作失败', e.message, 'error'); }
  };
}

function setupUpdateModal() {
  document.getElementById('update-modal-close').onclick = function() {
    document.getElementById('update-modal-overlay').classList.remove('show');
  };
  document.getElementById('update-ignore-today').onclick = async function() {
    if (currentUpdateInfo) await window.api.updateIgnore({ version: currentUpdateInfo.latestVersion, type: 'today' });
    document.getElementById('update-modal-overlay').classList.remove('show');
  };
  document.getElementById('update-ignore-forever').onclick = async function() {
    if (currentUpdateInfo) await window.api.updateIgnore({ version: currentUpdateInfo.latestVersion, type: 'forever' });
    document.getElementById('update-modal-overlay').classList.remove('show');
  };
  const btn = document.getElementById('btn-check-update');
  if (btn) btn.onclick = function() { checkForAppUpdate(true); };
  const fullBtn = document.getElementById('btn-full-package-download');
  if (fullBtn) fullBtn.onclick = async function() {
    fullBtn.disabled = true;
    fullBtn.textContent = '获取中...';
    try {
      let fullInstallInfo = null;
      try {
        const result = await window.api.getFullInstall();
        if (result && result.success && result.fullInstall) fullInstallInfo = result.fullInstall;
      } catch(e) {}
      // 兜底：网络异常时使用内嵌信息
      if (!fullInstallInfo) fullInstallInfo = EMBEDDED_FULL_INSTALL;
      if (fullInstallInfo) {
        startFullDownload(fullInstallInfo);
        switchTab('downloads');
      } else {
        showToast('暂无完整包', '当前没有可用的完整安装包', 'info');
      }
    } catch (e) {
      showToast('获取失败', e.message, 'error');
    } finally {
      fullBtn.disabled = false;
      fullBtn.innerHTML = '<span class="el-icon" data-icon="download"></span><span>完整包下载</span>';
    }
  };
}

// 注入 Element UI 风格 SVG 图标到 DOM
function injectIcons() {
  const ICONS = window.ElIcons.ICONS;

  // ID-based injection (nav icons, preset icons)
  const iconMap = {
    'nav-icon-chat': 'chat',
    'nav-icon-models': 'models',
    'nav-icon-files': 'files',
    'nav-icon-terminal': 'terminal',
    'nav-icon-software': 'software',
    'nav-icon-downloads': 'download',
    'nav-icon-ai': 'aiConfig',
    'nav-icon-settings': 'settings',
    'nav-icon-about': 'about',
  };
  for (const [id, name] of Object.entries(iconMap)) {
    const el = document.getElementById(id);
    if (el && ICONS[name]) el.innerHTML = ICONS[name];
  }

  // data-icon attribute injection (buttons, etc.)
  document.querySelectorAll('[data-icon]').forEach(el => {
    const name = el.dataset.icon;
    if (ICONS[name]) {
      el.innerHTML = ICONS[name];
    }
  });

  // 一键接入卡片使用 LobeHub 品牌图标
  if (window.ModelIcons) {
    const presetIcons = {
      'preset-ollama-icon': { name: 'Ollama', type: 'ollama', apiUrl: 'http://localhost:11434' },
      'preset-bailian-icon': { name: '阿里云百炼', type: 'dashscope', apiUrl: 'https://dashscope.aliyuncs.com' },
      'preset-deepseek-icon': { name: 'DeepSeek', type: 'deepseek', apiUrl: 'https://api.deepseek.com' },
      'preset-openai-icon': { name: 'OpenAI', type: 'openai', apiUrl: 'https://api.openai.com' },
      'preset-anthropic-icon': { name: 'Anthropic Claude', type: 'openai', apiUrl: 'https://api.anthropic.com' },
      'preset-google-icon': { name: 'Google Gemini', type: 'openai', apiUrl: 'https://generativelanguage.googleapis.com' },
      'preset-zhipu-icon': { name: '智谱 GLM', type: 'openai', apiUrl: 'https://open.bigmodel.cn' },
      'preset-tencent-icon': { name: '腾讯混元', type: 'openai', apiUrl: 'https://api.hunyuan.cloud.tencent.com' },
      'preset-baidu-icon': { name: '百度千帆', type: 'openai', apiUrl: 'https://qianfan.baidubce.com' },
      'preset-moonshot-icon': { name: '月之暗面 Kimi', type: 'openai', apiUrl: 'https://api.moonshot.cn' },
      'preset-bytedance-icon': { name: '字节豆包', type: 'openai', apiUrl: 'https://ark.cn-beijing.volces.com' },
    };
    for (const [id, provider] of Object.entries(presetIcons)) {
      const el = document.getElementById(id);
      if (el) {
        const iconId = window.ModelIcons.detectProviderIcon(provider);
        el.innerHTML = window.ModelIcons.renderIconHtml(iconId, '', '28px');
        el.style.background = 'transparent';
        el.style.color = 'inherit';
        window.ModelIcons.updateIconsInContainer(el);
      }
    }
  }
}

async function loadInitialData() {
  try {
    const [config, models, systemInfo, appVersion] = await Promise.all([
      window.api.getConfig(),
      window.api.listModels(),
      window.api.getSystemInfo(),
      window.api.getAppVersion()
    ]);

    state.settings = config;
    state.models = models;
    state.currentModelId = config.currentModel;
    state.systemInfo = systemInfo;

    // 加载本地保存的聊天记录（兼容旧版格式）
    try {
      const chatResult = await window.api.loadChatHistory();
      if (chatResult.success && chatResult.data) {
        const data = chatResult.data;
        if (Array.isArray(data) && data.length > 0) {
          // 判断是新版格式 [{id, title, messages, ...}] 还是旧版格式 [{role, content, ...}]
          if (data[0].id && data[0].messages) {
            // 新版多会话格式
            state.conversations = data;
            state.activeConversationId = data[0].id;
            state.chatHistory = data[0].messages;
          } else {
            // 旧版单会话格式：转为新格式
            state.conversations = [{
              id: generateId(),
              title: '历史对话',
              messages: data,
              createdAt: data[0]?.time || Date.now(),
              updatedAt: data[data.length - 1]?.time || Date.now()
            }];
            state.activeConversationId = state.conversations[0].id;
            state.chatHistory = data;
            // 自动迁移到新格式
            saveConversations();
          }
        } else {
          // 空数据：创建默认会话
          createNewConversation();
        }
      } else {
        // 无数据：创建默认会话
        createNewConversation();
      }
    } catch (e) {
      console.warn('加载聊天记录失败:', e.message);
      createNewConversation();
    }

    // 确保会话列表已渲染（仅在已有会话数据时，createNewConversation 内部已调用）
    if (state.conversations.length > 0) {
      renderConversationList();
    }
    // 按当前激活会话恢复项目工作目录（各会话独立保存）
    if (typeof window.syncProjectFromActiveConv === 'function') window.syncProjectFromActiveConv();

    updateVersionDisplay(appVersion);
    updateSystemInfoDisplay();
    renderModelList();
    loadCloudProviders();
    loadLocalModels();
    applySettings();
    updateModelStatusBar();

    // 自动选择已启用的AI提供商（如果没有活跃提供商但有已启用的提供商）
    if (!state.activeProviderId) {
      const enabledProviders = state.cloudProviders.filter(p => p.enabled);
      if (enabledProviders.length > 0) {
        state.activeProviderId = enabledProviders[0].id;
        syncAISettings();
        const ai = buildAIConfig();
        await window.api.setConfig({ ai });
        state.settings.ai = ai;
      }
    }

    updateActiveProviderDisplay();
  } catch (err) {
    console.error('加载初始数据失败:', err);
    showToast('加载失败', err.message, 'error');
  }
}

// 动态设置界面版本号（统一从 package.json 读取）
function updateVersionDisplay(version) {
  const sidebarVersion = document.getElementById('sidebar-version');
  const aboutVersion = document.getElementById('about-version');
  if (sidebarVersion) sidebarVersion.textContent = `v${version}`;
  var settingsVer = document.getElementById('settings-current-version');
  if (settingsVer) settingsVer.textContent = 'v' + version;
  if (aboutVersion) aboutVersion.textContent = `${I18N.t('about.versionPrefix')} ${version}`;
}

// ==================== 导航 ====================
function setupNavigation() {
  let lastNavClickTime = 0;
  const NAV_CLICK_COOLDOWN = 300; // 300ms内连续点击视为无效，防止快速切换卡顿

  document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', () => {
      const now = Date.now();
      if (now - lastNavClickTime < NAV_CLICK_COOLDOWN) return;
      lastNavClickTime = now;
      const tab = item.dataset.tab;
      switchTab(tab);
    });
  });

  // ★ 监听主进程导航消息（从宠物窗口右键菜单"更换模型"等触发），自动切换到指定页面
  if (window.api && typeof window.api.on === 'function') {
    window.api.on('main:navigate', (tab) => {
      if (tab && typeof tab === 'string') {
        switchTab(tab);
      }
    });
  }
}

function switchTab(tabName) {
  state.currentTab = tabName;
  document.querySelectorAll('.nav-item').forEach(n => n.classList.toggle('active', n.dataset.tab === tabName));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === `tab-${tabName}`));

  onTabActivated(tabName);
}

function onTabActivated(tab) {
  switch (tab) {
    case 'chat': renderConversationList(); renderChat(); break;
    case 'models': renderModelList(); break;
    case 'files': loadFileList(); break;
    case 'terminal': break;
    case 'software': loadSoftwareList(); break;
    case 'ai-config': renderAIConfig(); break;
    case 'settings': renderSettings(); break;
    case 'about': renderAboutChangelog(); break;
    case 'downloads': loadCompletedDownloads(); break;
  }
}

// ==================== 窗口控制 ====================
function setupWindowControls() {
  document.getElementById('btn-minimize').addEventListener('click', () => {
    window.api.minimize();
  });

  document.getElementById('btn-maximize').addEventListener('click', async () => {
    const isMaximized = await window.api.maximize();
    updateMaximizeIcon(isMaximized);
  });

  document.getElementById('btn-close').addEventListener('click', () => {
    window.api.closeMain();
  });

  document.getElementById('btn-show-pet').addEventListener('click', async () => {
    const r = await window.api.togglePet(true);
    if (r && r.already === 'visible') showToast('灵汐已显示', '她已经在桌面上了', 'info');
    else showToast('灵汐出现了！', '灵汐来陪你了', 'info');
  });

  document.getElementById('btn-hide-pet').addEventListener('click', async () => {
    const r = await window.api.togglePet(false);
    if (r && r.already === 'hidden') showToast('灵汐已隐藏', '她已经不在桌面上了', 'info');
    else showToast('灵汐躲起来了', '灵汐已隐藏', 'info');
  });

  // Titlebar使用 -webkit-app-region: drag 实现原生拖拽（最稳定）
  // 双击最大化
  const titlebar = document.querySelector('.titlebar');
  if (titlebar) {
    titlebar.addEventListener('dblclick', (e) => {
      const target = e.target;
      if (target.closest('button, a, input, select, textarea, [role="button"], [data-action], .account-topbar, .account-top-login, .account-top-user, .window-controls')) return;
      e.preventDefault();
      window.api.maximize();
    });
  }

  // Initialize maximize icon state
  updateMaximizeIcon();
}

async function updateMaximizeIcon(isMaximized) {
  const icon = document.getElementById('maximize-icon');
  if (!icon) return;
  if (isMaximized === undefined) {
    isMaximized = await window.api.isMaximized();
  }
  const ICONS = window.ElIcons.ICONS;
  icon.innerHTML = ICONS[isMaximized ? 'restore' : 'maximize'] || ICONS.maximize;
}

// ==================== 编辑器独立窗口控制（与主窗口标题栏一致，但操作 editor 窗口）====================
function setupEditorWindowControls() {
  const mini = document.getElementById('btn-minimize');
  if (mini) mini.addEventListener('click', () => window.api.editor.minimize());
  const max = document.getElementById('btn-maximize');
  if (max) max.addEventListener('click', async () => {
    const isMax = await window.api.editor.maximize();
    updateEditorMaximizeIcon(isMax);
  });
  const close = document.getElementById('btn-close');
  if (close) close.addEventListener('click', () => closeActionEditor());
  updateEditorMaximizeIcon();
}

async function updateEditorMaximizeIcon(isMax) {
  const icon = document.getElementById('maximize-icon');
  if (!icon) return;
  if (isMax === undefined) isMax = await window.api.editor.isMaximized();
  const ICONS = window.ElIcons.ICONS;
  icon.innerHTML = ICONS[isMax ? 'restore' : 'maximize'] || ICONS.maximize;
}

// 编辑器窗口引导：加载配置/模型/动作，渲染编辑器（独立窗口，无模态）
async function bootstrapEditorWindow() {
  document.body.classList.add('editor-mode');
  const params = new URLSearchParams(location.search);
  const modelId = params.get('modelId');
  const actionKey = params.get('actionKey') || '';
  const isNew = params.get('isNew') === '1';
  const isBuiltin = params.get('isBuiltin') === '1';
  try {
    const config = await window.api.getConfig();
    state.settings = config || {};
    state.activeProviderId = (config && config.ai && config.ai.activeProvider) || null;
    // 编辑器独立窗口也需同步云端提供商列表，否则下方 updateActiveProviderDisplay 找不到提供商，状态栏永远显示「AI 未连接」
    state.cloudProviders = (config && config.ai && config.ai.cloudProviders) || [];
    const lang = (config && (config.system && config.system.language)) || config.language || 'zh-CN';
    if (window.I18N && window.I18N.applyLanguage) { try { window.I18N.applyLanguage(lang); } catch (e) {} }
    // 应用主题设置（确保编辑器窗口随主程序主题切换）
    const theme = (config && config.system && config.system.theme) || 'dark';
    applyTheme(theme);
    applyAccent(config && config.system && config.system.accent);
  } catch (e) { /* 配置加载失败不影响编辑 */ }
  const model = await window.api.getModel(modelId);
  if (!model) { showToast('模型不存在', '', 'error'); return; }
  // 立即把标题栏中央替换为动作编辑标题，避免在 openActionEditor 异步完成前闪过主窗口的电脑配置
  const tEd = window.I18N?.t || ((k) => k);
  const center = document.getElementById('titlebar-center');
  if (center) {
    const titleText = (isNew ? tEd('actions.editorTitleNew') : tEd('actions.editorTitle')) + (model.name ? ' · ' + model.name : '');
    center.innerHTML = `<span class="editor-title">${escapeHtml(titleText)}</span>`;
    document.title = titleText;
  }
  // 让独立窗口的状态栏（模型名 / AI 连接状态）反映真实配置，而不是默认的占位文案
  state.models = [model];
  state.currentModelId = model.id;
  openActionEditor(model, actionKey, isNew, isBuiltin, { standalone: true });
  updateModelStatusBar();
  updateActiveProviderDisplay();

  // 编辑器窗口已打开时，主进程会发来 editor:load 让本窗口切换到另一个动作（修复「只能打开/切换一个」）
  if (IS_EDITOR_WINDOW) {
    // 监听配置更新（确保主题等设置能随主程序同步切换）
    window.api.on('init:config', (config) => {
      state.settings = config || {};
      const theme = (config && config.system && config.system.theme) || 'dark';
      applyTheme(theme);
      applyAccent(config && config.system && config.system.accent);
      const lang = (config && config.system && config.system.language) || 'zh-CN';
      if (window.I18N && window.I18N.applyLanguage) { try { window.I18N.applyLanguage(lang); } catch (e) {} }
    });
    window.api.on('editor:load', (params) => {
      const p = params || {};
      reloadEditorWindow(p.modelId, p.actionKey || '', !!p.isNew, !!p.isBuiltin);
    });
    // 主进程拦截窗口关闭(X按钮)时发来此消息，检查未保存修改
    window.api.on('editor:beforeclose', () => {
      closeActionEditor().then(() => {
        // closeActionEditor 内部：有脏数据→confirm 弹窗，用户确认才真关；无脏数据→直接关闭
        // 用户取消时 closeActionEditor 提前 return（不调 window.api.editor.close()），窗口保持打开
        // 用户确认或无脏数据时 → 已调 window.api.editor.close() → 主进程执行真正关闭
      });
    });
  }
}

// 在已打开的编辑器独立窗口内，重新载入并渲染另一个动作（新建/编辑切换）
async function reloadEditorWindow(modelId, actionKey, isNew, isBuiltin) {
  const t = window.I18N?.t || ((k) => k);
  const model = await window.api.getModel(modelId);
  if (!model) { showToast('模型不存在', '', 'error'); return; }
  state.models = [model];
  state.currentModelId = model.id;
  // 立即更新标题栏，避免切换瞬间闪过旧标题
  const center = document.getElementById('titlebar-center');
  if (center) {
    const titleText = (isNew ? t('actions.editorTitleNew') : t('actions.editorTitle')) + (model.name ? ' · ' + model.name : '');
    center.innerHTML = `<span class="editor-title">${escapeHtml(titleText)}</span>`;
    document.title = titleText;
  }
  openActionEditor(model, actionKey, isNew, isBuiltin, { standalone: true });
  updateModelStatusBar();
  updateActiveProviderDisplay();
}

// ==================== 事件监听 ====================
function setupEventListeners() {
  // 聊天发送
  document.getElementById('btn-send').addEventListener('click', sendChatMessage);
  document.getElementById('btn-stop').addEventListener('click', () => {
    if (window.api.cancelChat) window.api.cancelChat();
    state.isStreaming = false;
    document.getElementById('btn-send').disabled = false;
    document.getElementById('btn-send').style.display = '';
    document.getElementById('btn-stop').style.display = 'none';
  });
  // 文件上传入口已删除（与「选择项目」按钮重复），改为在输入框直接粘贴文件（Ctrl+V）
  const pasteInputEl = document.getElementById('chat-input');
  if (pasteInputEl) {
    pasteInputEl.addEventListener('paste', async (e) => {
      const items = e.clipboardData && e.clipboardData.items;
      if (!items) return;
      const files = [];
      for (const item of Array.from(items)) {
        if (item.kind === 'file') {
          const f = item.getAsFile();
          if (f) files.push(f);
        }
      }
      if (files.length === 0) return; // 纯文本粘贴，不拦截
      e.preventDefault();
      for (const file of files) {
        await addUploadedFile(file);
      }
    });
  }
  // 拖拽上传
  const chatArea = document.getElementById('chat-messages');
  const inputArea = document.querySelector('.chat-input-area');
  let dragCounter = 0;
  const dragOverlay = document.createElement('div');
  dragOverlay.id = 'drag-overlay';
  dragOverlay.style.cssText = 'display:none;position:absolute;inset:0;background:rgba(99,102,241,0.1);border:2px dashed #6366f1;border-radius:12px;z-index:100;pointer-events:none;align-items:center;justify-content:center;font-size:16px;color:#6366f1;font-weight:600;';
  dragOverlay.textContent = '松开鼠标上传文件';
  document.querySelector('.chat-main').style.position = 'relative';
  document.querySelector('.chat-main').appendChild(dragOverlay);
  ['dragenter','dragover'].forEach(evt => {
    chatArea.addEventListener(evt, (e) => { e.preventDefault(); dragCounter++; dragOverlay.style.display='flex'; });
    inputArea.addEventListener(evt, (e) => { e.preventDefault(); dragCounter++; dragOverlay.style.display='flex'; });
  });
  ['dragleave','drop'].forEach(evt => {
    chatArea.addEventListener(evt, (e) => { e.preventDefault(); dragCounter=Math.max(0,dragCounter-1); if(dragCounter===0) dragOverlay.style.display='none'; });
    inputArea.addEventListener(evt, (e) => { e.preventDefault(); dragCounter=Math.max(0,dragCounter-1); if(dragCounter===0) dragOverlay.style.display='none'; });
  });
  chatArea.addEventListener('drop', async (e) => {
    e.preventDefault();
    dragCounter = 0;
    dragOverlay.style.display = 'none';
    for (const file of Array.from(e.dataTransfer.files)) { await addUploadedFile(file); }
  });
  inputArea.addEventListener('drop', async (e) => {
    e.preventDefault();
    dragCounter = 0;
    dragOverlay.style.display = 'none';
    for (const file of Array.from(e.dataTransfer.files)) { await addUploadedFile(file); }
  });
  // 鼠标离开窗口时也隐藏
  document.addEventListener('dragleave', (e) => {
    if (!e.relatedTarget || e.relatedTarget.nodeName === 'HTML') {
      dragCounter = 0;
      dragOverlay.style.display = 'none';
    }
  });
  // Agent 设置面板
  const settingsPanel = document.getElementById('agent-settings-panel');
  document.getElementById('btn-agent-settings').addEventListener('click', () => {
    const show = settingsPanel.style.display === 'none';
    settingsPanel.style.display = show ? 'block' : 'none';
    // 每次打开都拉一次长期记忆，保证看到的是最新内容
    if (show) loadMemories();
  });
  document.getElementById('btn-close-agent-settings').addEventListener('click', () => {
    settingsPanel.style.display = 'none';
  });
  // 项目工作目录选择：下拉菜单支持最近项目切换、打开已有项目、新建项目
  (function setupProjectPicker() {
    const projectBtn = document.getElementById('btn-select-project');
    const projectText = document.getElementById('project-picker-text');
    if (!projectBtn || !projectText) return;
    function renderProjectLabel() {
      const wd = state.workdir;
      if (wd) {
        const base = wd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || wd;
        projectText.textContent = base;
        projectBtn.title = '项目工作目录：' + wd + '\n（点击切换）';
      } else {
        projectText.textContent = '选择项目';
        projectBtn.title = '选择项目工作目录：AI 的文件读写与命令执行都在此目录内进行';
      }
    }
    function getRecentProjects() {
      try { return JSON.parse(localStorage.getItem('recentProjects')) || []; } catch (e) { return []; }
    }
    function pushRecent(wd) {
      if (!wd) return;
      let list = getRecentProjects().filter(p => p !== wd);
      list.unshift(wd);
      if (list.length > 8) list = list.slice(0, 8);
      localStorage.setItem('recentProjects', JSON.stringify(list));
    }
    function removeRecent(wd) {
      let list = getRecentProjects().filter(p => p !== wd);
      localStorage.setItem('recentProjects', JSON.stringify(list));
    }
    let workdirSetExplicitly = false;
    window.setProjectWorkdir = function (wd) {
      state.workdir = wd || '';
      workdirSetExplicitly = !!wd;
      if (wd) pushRecent(wd);
      const conv = state.conversations.find(c => c.id === state.activeConversationId);
      if (conv) {
        conv.workdir = state.workdir;
      } else {
        // conv 暂不可用时暂存，等会话就绪后由 sync 补写
        state._pendingWorkdir = state.workdir;
      }
      saveConversations();
      renderProjectLabel();
    };
    window.syncProjectFromActiveConv = function () {
      const conv = state.conversations.find(c => c.id === state.activeConversationId);
      // 补写暂存的 workdir
      if (conv && state._pendingWorkdir && !conv.workdir) {
        conv.workdir = state._pendingWorkdir;
        delete state._pendingWorkdir;
        saveConversations();
      }
      // 只有当 conv 中有保存的 workdir，或本次不是用户显式设置时，才同步覆盖
      if (conv && conv.workdir) {
        state.workdir = conv.workdir;
        workdirSetExplicitly = true;
      } else if (!workdirSetExplicitly) {
        state.workdir = '';
      }
      renderProjectLabel();
    };
    try { window.syncProjectFromActiveConv(); } catch (e) {}
    let dropdown = null;
    function closeDropdown() {
      if (dropdown) { dropdown.remove(); dropdown = null; }
      document.removeEventListener('click', onDocClick, true);
    }
    function onDocClick(e) {
      if (dropdown && !dropdown.contains(e.target) && e.target !== projectBtn && !projectBtn.contains(e.target)) {
        closeDropdown();
      }
    }
    function shortName(p) {
      return p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;
    }
    function esc(s) { return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'); }
    function openProject(p) {
      window.setProjectWorkdir(p);
      showToast('已切换项目', p, 'info');
      closeDropdown();
    }
    async function pickExisting() {
      closeDropdown();
      try {
        const dirs = await window.api.selectDirectory();
        if (dirs && dirs[0]) openProject(dirs[0]);
      } catch (e) {
        showToast('选择项目失败', (e && e.message) || String(e), 'error');
      }
    }
    function showNewProjectModal() {
      closeDropdown();
      // 移除旧弹窗
      const old = document.getElementById('new-project-modal');
      if (old) old.remove();
      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay show';
      overlay.id = 'new-project-modal';
      overlay.innerHTML = `
        <div class="modal" style="min-width:420px;">
          <div class="modal-header">
            <h3>新建项目</h3>
            <span class="modal-close" id="npm-close">✕</span>
          </div>
          <div class="modal-body" style="padding:16px;">
            <div class="modal-form-group">
              <label>项目名称</label>
              <input type="text" id="npm-name" placeholder="输入项目名称" />
            </div>
            <div class="modal-form-group">
              <label>本地工作目录</label>
              <div style="display:flex;gap:8px;">
                <input type="text" id="npm-path" placeholder="点击右侧选择文件夹…" readonly style="flex:1;background:var(--bg-tertiary);" />
                <button class="btn btn-sm" id="npm-browse">选择…</button>
              </div>
            </div>
          </div>
          <div class="modal-footer">
            <button class="btn" id="npm-cancel">取消</button>
            <button class="btn btn-primary" id="npm-ok">创建并打开</button>
          </div>
        </div>`;
      document.body.appendChild(overlay);
      const nameInput = overlay.querySelector('#npm-name');
      const pathInput = overlay.querySelector('#npm-path');
      nameInput.focus();
      let parentDir = '';
      function close() { overlay.remove(); }
      overlay.querySelector('#npm-close').onclick = close;
      overlay.querySelector('#npm-cancel').onclick = close;
      overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
      overlay.querySelector('#npm-browse').onclick = async () => {
        try {
          const dirs = await window.api.selectDirectory();
          if (dirs && dirs[0]) { parentDir = dirs[0]; pathInput.value = dirs[0]; }
        } catch (e) {}
      };
      async function submit() {
        const name = nameInput.value.trim();
        if (!name) { showToast('请输入项目名称', '', 'warning'); return; }
        if (!parentDir) { showToast('请选择存放位置', '', 'warning'); return; }
        const target = parentDir.replace(/[\\/]+$/, '') + '\\' + name;
        try {
          await window.api.createDir({ path: target });
          close();
          openProject(target);
        } catch (e) {
          showToast('新建项目失败', (e && e.message) || String(e), 'error');
        }
      }
      overlay.querySelector('#npm-ok').onclick = submit;
      nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    }
    function showDropdown() {
      if (dropdown) { closeDropdown(); return; }
      const recent = getRecentProjects();
      const current = state.workdir || '';
      dropdown = document.createElement('div');
      dropdown.className = 'project-dropdown';
      let html = '';
      if (current) {
        html += '<div class="pd-section">当前项目</div>';
        html += '<div class="pd-item pd-current" data-path="' + esc(current) + '">'
             + '<span class="el-icon">' + window.ElIcons.ICONS.folder + '</span>'
             + '<span class="pd-label">' + esc(shortName(current)) + '</span>'
             + '<span class="pd-clear" data-clear="1" title="移除当前项目">✕</span></div>';
      }
      const others = recent.filter(p => p !== current);
      if (others.length) {
        html += '<div class="pd-section">最近项目</div>';
        others.slice(0, 8).forEach(p => {
          html += '<div class="pd-item" data-path="' + esc(p) + '">'
               + '<span class="el-icon">' + window.ElIcons.ICONS.folder + '</span>'
               + '<span class="pd-label" title="' + esc(p) + '">' + esc(shortName(p)) + '</span></div>';
        });
      }
      if (current || others.length) {
        html += '<div class="pd-divider"></div>';
      }
      html += '<div class="pd-item pd-action" data-act="open"><span class="el-icon">' + window.ElIcons.ICONS.folderPlus + '</span>从本地文件夹创建…</div>';
      html += '<div class="pd-item pd-action" data-act="new"><span class="el-icon">' + window.ElIcons.ICONS.plusSimple + '</span>新建项目…</div>';
      dropdown.innerHTML = html;
      const rect = projectBtn.getBoundingClientRect();
      dropdown.style.position = 'fixed';
      dropdown.style.bottom = (window.innerHeight - rect.top + 6) + 'px';
      dropdown.style.left = Math.min(rect.left, window.innerWidth - 260) + 'px';
      document.body.appendChild(dropdown);
      setTimeout(() => document.addEventListener('click', onDocClick, true), 0);
      dropdown.querySelectorAll('.pd-item').forEach(item => {
        item.addEventListener('click', (e) => {
          e.stopPropagation();
          const clear = item.querySelector('[data-clear="1"]');
          if (clear && clear.contains(e.target)) {
            removeRecent(current);
            window.setProjectWorkdir('');
            showToast('已移除当前项目', '', 'info');
            closeDropdown();
            return;
          }
          const act = item.dataset.act;
          if (act === 'open') return pickExisting();
          if (act === 'new') return showNewProjectModal();
          const p = item.dataset.path;
          if (p) openProject(p);
        });
      });
    }
    projectBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      showDropdown();
    });
  })();
  // 工作/聊天模式切换：聊天模式纯对话（隐藏项目选择），工作模式带工具和项目目录
  (function setupModeToggle() {
    const modeBtn = document.getElementById("btn-mode-toggle");
    const modeIcon = document.getElementById("mode-toggle-icon");
    const projBtn = document.getElementById("btn-select-project");
    const agentCheckbox = document.getElementById("agent-mode");
    if (!modeBtn || !modeIcon) return;
    function applyMode() {
      const isWork = agentCheckbox ? agentCheckbox.checked : false;
      // 聊天模式用对话气泡图标，工作模式用机器人图标
      const ICONS = window.ElIcons.ICONS;
      modeIcon.innerHTML = isWork ? ICONS.computer : ICONS.chat;
      modeBtn.classList.toggle("work-mode", isWork);
      modeBtn.title = isWork ? "工作模式：带工具调用和项目目录（点击切换到聊天）" : "聊天模式：纯对话（点击切换到工作）";
      if (projBtn) projBtn.style.display = isWork ? "" : "none";
    }
    modeBtn.addEventListener("click", () => {
      if (agentCheckbox) {
        agentCheckbox.checked = !agentCheckbox.checked;
        agentCheckbox.dispatchEvent(new Event("change"));
      }
      applyMode();
    });
    if (agentCheckbox) agentCheckbox.addEventListener("change", applyMode);
    setTimeout(applyMode, 100);
  })();
  document.addEventListener('click', (e) => {
    const settingsBtn = document.getElementById('btn-agent-settings');
    if (settingsPanel.style.display === 'block'
        && !settingsPanel.contains(e.target)
        && !settingsBtn.contains(e.target)) {
      settingsPanel.style.display = 'none';
    }
  });
  // Agent 设置持久化
  // v2：工具清单改为从主进程动态获取，旧版本只存了 5 个工具，会把 web_search 等关键工具
  // 永久排除在外（表现为"模型想用工具但没有工具可调"）。升 key 让旧存档自然失效，全部工具默认启用。
  function saveAgentSettings() {
    const settings = {
      agentMode: document.getElementById('agent-mode')?.checked || false,
      streamMode: document.getElementById('stream-mode')?.checked || false,
      thinkMode: document.getElementById('agent-think-mode')?.checked || false,
      toolConfirm: document.getElementById('agent-tool-confirm')?.checked !== false, // 默认开启
      autoCompress: document.getElementById('agent-auto-compress')?.checked !== false, // 默认开启
      enabledTools: Array.from(document.querySelectorAll('.agent-tool-check:checked')).map(cb => cb.value)
    };
    localStorage.setItem(AGENT_SETTINGS_KEY, JSON.stringify(settings));
  }
  function loadAgentSettings() {
    try {
      const saved = localStorage.getItem(AGENT_SETTINGS_KEY);
      if (!saved) return;
      const settings = JSON.parse(saved);
      const agentModeEl = document.getElementById('agent-mode');
      const streamModeEl = document.getElementById('stream-mode');
      const thinkModeEl = document.getElementById('agent-think-mode');
      const toolConfirmEl = document.getElementById('agent-tool-confirm');
      const autoCompressEl = document.getElementById('agent-auto-compress');
      if (agentModeEl) agentModeEl.checked = !!settings.agentMode;
      if (streamModeEl) streamModeEl.checked = settings.streamMode !== false;
      if (thinkModeEl) thinkModeEl.checked = !!settings.thinkMode;
      if (toolConfirmEl) toolConfirmEl.checked = settings.toolConfirm !== false;
      if (autoCompressEl) autoCompressEl.checked = settings.autoCompress !== false;
      if (Array.isArray(settings.enabledTools)) {
        document.querySelectorAll('.agent-tool-check').forEach(cb => {
          cb.checked = settings.enabledTools.includes(cb.value);
        });
      }
    } catch(e) { console.warn('加载Agent设置失败:', e); }
  }
  // 暴露给外部：工具清单是异步渲染的，渲染完需要重新套用勾选状态
  applyAgentSettings = loadAgentSettings;
  onAgentToolToggle = saveAgentSettings;
  loadAgentSettings();
  // 监听设置变化自动保存
  ['agent-mode', 'stream-mode', 'agent-think-mode', 'agent-tool-confirm', 'agent-auto-compress'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('change', () => {
      saveAgentSettings();
      // Agent 模式会额外占用工具定义等开销；自动压缩开关会影响弹窗里的状态显示
      renderContextBar();
    });
  });
  document.querySelectorAll('.agent-tool-check').forEach(cb => {
    cb.addEventListener('change', saveAgentSettings);
  });
  // 工具执行确认弹窗
  const toolConfirmModal = document.getElementById('tool-confirm-modal');
  document.getElementById('confirm-tool-allow').addEventListener('click', () => {
    toolConfirmModal.style.display = 'none';
    window.api.confirmToolResponse(true);
  });
  document.getElementById('confirm-tool-deny').addEventListener('click', () => {
    toolConfirmModal.style.display = 'none';
    window.api.confirmToolResponse(false);
  });
  document.getElementById('chat-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendChatMessage();
    }
  });

  // 语音按钮：按住说话，松开识别（渲染进程采集 PCM → WAV，主进程 SAPI 识别）
  const voiceBtn = document.getElementById('btn-voice');
  voiceBtn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    console.log('[Voice] pointerdown 触发');
    try {
      startVoiceCapture();
    } catch(err) {
      console.error('[Voice] startVoiceCapture异常:', err);
    }
  });
  voiceBtn.addEventListener('pointerup', (e) => {
    e.preventDefault();
    e.stopPropagation();
    try { stopVoiceCapture(); } catch(err) { console.error('[Voice] stopVoiceCapture异常:', err); }
  });
  voiceBtn.addEventListener('pointerleave', () => {
    try { if (voiceRec && voiceRec.recording) stopVoiceCapture(); } catch(e) {}
  });
  voiceBtn.addEventListener('pointercancel', () => {
    try { if (voiceRec && voiceRec.recording) stopVoiceCapture(); } catch(e) {}
  });
  voiceBtn.addEventListener('contextmenu', (e) => e.preventDefault());

  // 清空当前会话
  document.getElementById('btn-clear-chat').addEventListener('click', async () => {
    const conv = getActiveConversation();
    if (!conv) return;
    conv.messages = [];
    state.chatHistory = [];
    setCompressNotice(null);
  state.uploadedFiles = [];
  state.currentRoleId = 'general'; // 当前智能体角色
  state.agentRoles = []; // 角色列表
  state.agentTools = []; // 主进程注册的全部工具（单一数据源，避免前端硬编码遗漏）
    conv.updatedAt = Date.now();
    saveConversations();
    renderChat();
    showToast('会话已清空', '', 'info');
  });

  // 新建会话
  document.getElementById('btn-new-chat').addEventListener('click', () => {
    createNewConversation();
    showToast('已创建新会话', '', 'info');
  });

  // 上下文环形指示：悬停看用量（title），点击看明细（弹窗内含"立即压缩"）
  const ctxBarEl = document.getElementById('ctx-bar');
  if (ctxBarEl) {
    ctxBarEl.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleContextPopup();
    });
    ctxBarEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleContextPopup(); }
    });
  }
  // 点击别处关闭明细弹窗
  document.addEventListener('click', (e) => {
    const popup = document.getElementById('ctx-popup');
    if (!popup || popup.style.display === 'none') return;
    if (popup.contains(e.target)) return;
    if (ctxBarEl && ctxBarEl.contains(e.target)) return;
    popup.style.display = 'none';
  });
  // 输入框内容变化会影响"待发送"的估算，做防抖刷新
  const chatInputEl = document.getElementById('chat-input');
  if (chatInputEl) {
    let ctxRefreshTimer = null;
    chatInputEl.addEventListener('input', () => {
      if (ctxRefreshTimer) clearTimeout(ctxRefreshTimer);
      ctxRefreshTimer = setTimeout(() => renderContextBar(), 300);
    });
  }
  primeContextMeta();
  renderContextBar();

  // 切换历史会话
  document.getElementById('conversation-select').addEventListener('change', (e) => {
    const id = e.target.value;
    if (!id) return;
    switchConversation(id);
  });

  // 删除历史会话
  document.getElementById('btn-delete-conv').addEventListener('click', async () => {
    const conv = getActiveConversation();
    if (!conv) return;
    const confirmed = await showConfirm({
      type: 'warning',
      title: '删除会话',
      message: `确定要删除会话「${conv.title}」吗？`,
      detail: '此操作不可恢复，会话中的所有消息将被永久删除。'
    });
    if (confirmed) {
      deleteConversation(conv.id);
      showToast('会话已删除', '', 'info');
    }
  });

  // AI模型选择（走统一入口：校验 + 持久化 + 同步各选择器与状态灯）
  document.getElementById('chat-provider').addEventListener('change', async (e) => {
    await setActiveProvider(e.target.value || null, { toast: null });
    // 换模型会改变上下文窗口与预留输出，容量条要跟着刷新
    renderContextBar();
  });

  // 模型管理
  document.getElementById('btn-import-model').addEventListener('click', importModelFile);
  document.getElementById('btn-import-model-dir').addEventListener('click', importModelDirectory);

  // BongoCat 专用
  const btnLaunchBongo = document.getElementById('btn-launch-bongocat');
  const btnBongoPath = document.getElementById('btn-bongocat-path');
  if (btnLaunchBongo) btnLaunchBongo.addEventListener('click', launchBongocatWindow);
  if (btnBongoPath) btnBongoPath.addEventListener('click', setBongocatPath);
  // 加载时更新BongoCat状态
  updateBongocatStatus();

  // 文件管理
  document.getElementById('btn-back').addEventListener('click', () => {
    if (state.currentPath) {
      const parent = window.api.path.dirname(state.currentPath);
      state.currentPath = parent;
      loadFileList();
    }
  });
  document.getElementById('btn-home').addEventListener('click', () => {
    state.currentPath = '';
    loadFileList();
  });
  document.getElementById('btn-new-folder').addEventListener('click', createNewFolder);
  document.getElementById('btn-upload-file').addEventListener('click', uploadFile);
  document.getElementById('file-search').addEventListener('input', debounce(searchFiles, 300));

  // 文件视图切换
  document.getElementById('view-list').addEventListener('click', () => {
    document.getElementById('view-list').classList.add('active');
    document.getElementById('view-grid').classList.remove('active');
    document.getElementById('file-list').classList.remove('grid-view');
    renderFileList(state.fileTree);
  });
  document.getElementById('view-grid').addEventListener('click', () => {
    document.getElementById('view-grid').classList.add('active');
    document.getElementById('view-list').classList.remove('active');
    document.getElementById('file-list').classList.add('grid-view');
    renderFileList(state.fileTree);
  });

  // 终端
  document.getElementById('btn-exec-cmd').addEventListener('click', executeCommand);
  document.getElementById('terminal-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') executeCommand();
  });
  document.getElementById('btn-clear-terminal').addEventListener('click', () => {
    document.getElementById('terminal-output').innerHTML = '';
  });

  // 软件管理
  // ★ 刷新按钮强制重新扫描（绕过缓存），进入页面时使用缓存
  document.getElementById('btn-refresh-software').addEventListener('click', () => loadSoftwareList(true));
  document.getElementById('btn-install-software').addEventListener('click', installSoftware);
  document.getElementById('software-search').addEventListener('input', debounce(filterSoftware, 300));

  // 初始化高级信息提示框
  if (typeof initInfoTips === 'function') initInfoTips();

  // AI配置
  document.getElementById('btn-add-local-model').addEventListener('click', addLocalModel);
  const btnAddLocalModelDir = document.getElementById('btn-add-local-model-dir');
  if (btnAddLocalModelDir) btnAddLocalModelDir.addEventListener('click', addLocalModelDirectory);
  const btnRefreshTools = document.getElementById('btn-refresh-tools');
  if (btnRefreshTools) btnRefreshTools.addEventListener('click', renderTools);
  // 添加提供商按钮已从UI移除，保留函数供其他地方调用
  const btnAddCloud = document.getElementById('btn-add-cloud');
  if (btnAddCloud) btnAddCloud.addEventListener('click', addCloudProvider);
  document.getElementById('temperature').addEventListener('input', (e) => {
    document.getElementById('temperature-value').textContent = e.target.value;
  });
  document.getElementById('max-tokens').addEventListener('change', saveAISettings);
  // 最大Token 自定义步进器
  const maxTokensInput = document.getElementById('max-tokens');
  document.getElementById('max-tokens-increase').addEventListener('click', () => {
    const step = parseInt(maxTokensInput.step) || 128;
    const max = parseInt(maxTokensInput.max) || 128000;
    const val = Math.min(parseInt(maxTokensInput.value) + step, max);
    maxTokensInput.value = val;
    saveAISettings();
  });
  document.getElementById('max-tokens-decrease').addEventListener('click', () => {
    const step = parseInt(maxTokensInput.step) || 128;
    const min = parseInt(maxTokensInput.min) || 1;
    const val = Math.max(parseInt(maxTokensInput.value) - step, min);
    maxTokensInput.value = val;
    saveAISettings();
  });
  document.getElementById('system-prompt').addEventListener('change', saveAISettings);
  // 上下文窗口（空/0 = 按模型名自动识别，具体口径见标签的提示气泡）
  const contextWindowInput = document.getElementById('context-window');
  if (contextWindowInput) {
    contextWindowInput.addEventListener('change', () => {
      saveAISettings();
      renderContextBar();
    });
    document.getElementById('context-window-decrease')?.addEventListener('click', () => {
      const step = parseInt(contextWindowInput.step) || 1024;
      const min = parseInt(contextWindowInput.min) || 0;
      const val = Math.max((parseInt(contextWindowInput.value) || 0) - step, min);
      contextWindowInput.value = val > 0 ? val : ''; // 0 显示为 placeholder「自动」
      saveAISettings();
      renderContextBar();
    });
    document.getElementById('context-window-increase')?.addEventListener('click', () => {
      const step = parseInt(contextWindowInput.step) || 1024;
      const max = parseInt(contextWindowInput.max) || 2000000;
      contextWindowInput.value = Math.min((parseInt(contextWindowInput.value) || 0) + step, max);
      saveAISettings();
      renderContextBar();
    });
  }
  document.getElementById('active-provider').addEventListener('change', (e) => {
    state.activeProviderId = e.target.value || null;
    saveAISettings();
    updateMaxTokensVisibility();
    renderContextBar();
    // 切换AI模型服务时，自动刷新下方页面（聊天页面的模型选择器、状态显示、图标等）
    updateActiveProviderDisplay();
    // 刷新提供商列表，确保当前选中状态正确显示
    renderCloudProviders();
  });

  // 设置 - 仅针对设置面板内的开关
  document.getElementById('pet-size').addEventListener('input', (e) => {
    document.getElementById('pet-size-value').textContent = (e.target.value * 100).toFixed(0) + '%';
  });
  document.getElementById('pet-size').addEventListener('change', () => saveSettings());
  document.getElementById('pet-opacity').addEventListener('input', (e) => {
    document.getElementById('pet-opacity-value').textContent = (e.target.value * 100).toFixed(0) + '%';
  });
  document.getElementById('pet-opacity').addEventListener('change', () => saveSettings());
  // ★ 透明度重置按钮：一键恢复默认透明度（0），解决设置后无法回到最初默认值的问题
  const btnResetOpacity = document.getElementById('btn-reset-opacity');
  if (btnResetOpacity) {
    btnResetOpacity.addEventListener('click', async () => {
      const opacityEl = document.getElementById('pet-opacity');
      if (opacityEl) {
        opacityEl.value = 0;
        document.getElementById('pet-opacity-value').textContent = '0%';
      }
      // 重置 lastSentPetSettings，确保新设置被发送到主进程
      lastSentPetSettings = null;
      await saveSettings();
      if (window.showToast) window.showToast('已恢复默认', '透明度已重置为 0%', 'success');
    });
  }

  // 桌宠外观 - 色彩调节（饱和度/亮度/色相）
  const colSatEl = document.getElementById('pet-col-sat');
  const colBriEl = document.getElementById('pet-col-bri');
  const colHueEl = document.getElementById('pet-col-hue');
  if (colSatEl) {
    colSatEl.addEventListener('input', (e) => { document.getElementById('pet-col-sat-value').textContent = parseFloat(e.target.value).toFixed(2); });
    colSatEl.addEventListener('change', () => saveSettings());
  }
  if (colBriEl) {
    colBriEl.addEventListener('input', (e) => { document.getElementById('pet-col-bri-value').textContent = parseFloat(e.target.value).toFixed(2); });
    colBriEl.addEventListener('change', () => saveSettings());
  }
  if (colHueEl) {
    colHueEl.addEventListener('input', (e) => { document.getElementById('pet-col-hue-value').textContent = e.target.value + '°'; });
    colHueEl.addEventListener('change', () => saveSettings());
  }

  document.getElementById('pet-framerate').addEventListener('change', () => saveSettings());

  // 桌宠外观 - 渲染倍率（同时影响模型和键盘叠加层清晰度，立即生效）
  const renderScaleEl = document.getElementById('pet-render-scale');
  if (renderScaleEl) {
    renderScaleEl.addEventListener('input', (e) => {
      document.getElementById('pet-render-scale-value').textContent = parseFloat(e.target.value).toFixed(1) + 'x';
    });
    renderScaleEl.addEventListener('change', () => {
      const scale = parseFloat(renderScaleEl.value);
      if (window.api && typeof window.api.setPetRenderScale === 'function') {
        window.api.setPetRenderScale(scale);
      }
      saveSettings();
    });
  }
  document.getElementById('btn-reset-pet').addEventListener('click', resetPetDisplay);

  // 仅监听设置面板内的开关，避免捕获其他面板（如流式输出）的开关
  const settingsSwitches = document.querySelectorAll('#tab-settings .switch-toggle input');
  settingsSwitches.forEach(input => {
    input.addEventListener('change', () => saveSettings());
  });

  document.querySelectorAll('.theme-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.theme-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      saveSettings();
    });
  });
  document.querySelectorAll('.accent-dot').forEach(dot => {
    dot.addEventListener('click', () => {
      document.querySelectorAll('.accent-dot').forEach(d => d.classList.remove('active'));
      dot.classList.add('active');
      applyAccent(dot.dataset.accent);
      saveSettings();
    });
  });
  document.getElementById('language').addEventListener('change', async () => {
    await saveSettings();
    // 实时切换语言，无需重启
    const lang = document.getElementById('language').value;
    if (window.I18N && window.I18N.applyLanguage) {
      window.I18N.applyLanguage(lang);
    }
    // 重新渲染依赖语言的动态内容
    renderModelList();
    renderAIConfig();
    updateModelStatusBar();
    const desc = lang === 'en-US' ? 'Switched to English' : '已切换至中文';
    showToast(window.I18N?.t?.('toast.langSaved') || '语言设置已保存', desc, 'info');
  });
  document.getElementById('btn-reset-config').addEventListener('click', resetConfig);
  document.getElementById('btn-export-config').addEventListener('click', exportConfig);
  document.getElementById('btn-import-config').addEventListener('click', importConfig);

  // 系统外观（Windows only）—— 任务栏 + 开始菜单各自独立设置，无总开关
  // XAML TAP 方案：注入 aiLobsterTap.dll，修改 XAML 视觉树元素的 Opacity
  // 可选效果：默认(系统原生) / 透明 / 模糊 / 亚克力 —— 「默认」即把 Opacity 还原为 1.0

  const tbEffectSelect = document.getElementById('taskbar-effect-select');
  const smEffectSelect = document.getElementById('startmenu-effect-select');

  // 任务栏效果选择变化：即选即用，无需总开关
  if (tbEffectSelect) {
    tbEffectSelect.addEventListener('change', async () => {
      if (!window.api || !window.api.taskbarApplyEffect) return;

      const effect = tbEffectSelect.value;
      try {
        const r = await window.api.taskbarApplyEffect(effect);
        if (r && r.ok) {
          const cfg = await window.api.getConfig();
          cfg.taskbar = cfg.taskbar || {};
          cfg.taskbar.effect = effect;
          await window.api.saveConfig(cfg);
          // 任务栏效果为「默认」时，弹层同步开关没有可同步的效果 → 全部置灰
          for (const key of ['notification', 'overflow', 'quicksettings']) {
            const toggle = document.getElementById('flyout-sync-' + key);
            if (toggle) toggle.disabled = (effect === 'normal');
          }
        } else {
          showToast('切换失败', (r && r.error) || '未知错误', 'error');
        }
      } catch (e) {
        showToast('切换失败', e.message, 'error');
      }
    });
  }

  // 开始菜单效果选择变化：即选即用，与任务栏互不影响
  if (smEffectSelect) {
    smEffectSelect.addEventListener('change', async () => {
      if (!window.api || !window.api.startMenuApplyEffect) return;

      const effect = smEffectSelect.value;
      try {
        const r = await window.api.startMenuApplyEffect(effect);
        if (r && r.ok) {
          const cfg = await window.api.getConfig();
          cfg.startMenu = cfg.startMenu || {};
          cfg.startMenu.effect = effect;
          await window.api.saveConfig(cfg);
        } else {
          showToast('切换失败', (r && r.error) || '未知错误', 'error');
        }
      } catch (e) {
        showToast('切换失败', e.message, 'error');
      }
    });
  }

  // 弹出窗口/通知同步任务栏效果开关：只影响弹层（通知中心/托盘溢出/快速设置/跳转列表等），
  // 关闭后弹层立即还原为系统原生外观，任务栏本身的效果不变
  // 弹出窗口/通知同步任务栏效果：二级独立开关（每个弹层目标单独开启/还原）。
  // 右键菜单（任务栏右键）受系统限制不支持透明（SCA 在 26200 上会合成灰底、TAP 不可见），
  // 保持系统原生外观，「托盘弹窗」开关只管托盘溢出面板本体。
  const FLYOUT_SYNC_ITEMS = [
    { key: 'notification', id: 'flyout-sync-notification', name: '通知中心' },
    { key: 'overflow', id: 'flyout-sync-overflow', name: '托盘弹窗' },
    { key: 'quicksettings', id: 'flyout-sync-quicksettings', name: '快速设置' }
  ];
  for (const item of FLYOUT_SYNC_ITEMS) {
    const toggle = document.getElementById(item.id);
    if (!toggle) continue;
    toggle.addEventListener('change', async () => {
      if (!window.api || !window.api.taskbarSetFlyoutSync) return;
      try {
        const r = await window.api.taskbarSetFlyoutSync(item.key, toggle.checked);
        if (r && r.ok) {
          showToast(
            toggle.checked ? `已开启${item.name}同步` : `已关闭${item.name}同步`,
            toggle.checked ? `${item.name}将跟随任务栏效果` : `${item.name}将保持系统原生外观`,
            'success'
          );
        } else {
          toggle.checked = !toggle.checked;   // 失败回滚 UI
          showToast('设置失败', (r && r.error) || '未知错误', 'error');
        }
      } catch (e) {
        toggle.checked = !toggle.checked;
        showToast('设置失败', e.message, 'error');
      }
    });
  }

  // 模态框关闭：仅通过 × 按钮或页脚按钮关闭；【不响应点击空白处】，
  // 避免误触丢失表单输入（程序规范：弹窗必须显式操作才能关闭）
  document.getElementById('modal-close').addEventListener('click', () => {
    // 动作编辑器模态（带 .ae-modal 标记）：关闭前走脏检查 + 自制确认弹窗；其余模态直接关闭
    const modalEl = document.getElementById('modal');
    if (modalEl && modalEl.classList.contains('ae-modal')) { closeActionEditor(); }
    else { closeModal(); }
  });
}

function setupIpcListeners() {
  // 编辑器独立窗口：不需要主窗口的各类 UI 广播（避免操作不存在的 DOM）
  if (IS_EDITOR_WINDOW) return;
  window.api.on('init:config', (config) => {
    state.settings = config;
    // 同步语言设置
    const lang = config.system?.language || 'zh-CN';
    if (window.I18N && window.I18N.applyLanguage) {
      window.I18N.applyLanguage(lang);
    }
    const langSelect = document.getElementById('language');
    if (langSelect) langSelect.value = lang;
  });

  window.api.on('init:models', (models) => {
    state.models = models;
    renderModelList();
  });

  window.api.on('init:system-info', (info) => {
    state.systemInfo = info;
    updateSystemInfoDisplay();
  });

  window.api.on('model:changed', (modelInfo) => {
    if (modelInfo === null) {
      // 恢复默认模型
      state.currentModelId = null;
      renderModelList();
      updateModelStatusBar();
      showToast('已恢复默认', '灵汐恢复默认造型！', 'success');
    } else {
      // 兼容：modelInfo 可能是完整对象或纯 id 字符串
      const modelId = typeof modelInfo === 'string' ? modelInfo : modelInfo?.id;
      state.currentModelId = modelId;
      renderModelList();
      updateModelStatusBar();
      showToast('模型已切换', '灵汐换装成功！', 'success');
    }
  });

  // 编辑器独立窗口保存后，刷新主窗口当前展示的模型详情（若匹配）
  window.api.on('model:actions-changed', (modelId) => {
    if (currentShownModel && currentShownModel.id === modelId) {
      showModelInfo(currentShownModel);
    }
  });

  window.api.on('ai:response', (data) => {
    // 检查该响应是否属于当前活跃会话，如果不是则忽略（防止删除会话后响应被带到新会话）
    if (state.activeRequestConversationId && state.activeRequestConversationId !== state.activeConversationId) {
      console.log('[AI] 忽略不属于当前会话的AI响应，请求会话:', state.activeRequestConversationId, '当前会话:', state.activeConversationId);
      return;
    }
    // Agent 模式事件处理（仅当元素还在 DOM 中）
    if (state.agentState && state.agentState.currentMsgEl && state.agentState.currentMsgEl.isConnected) {
      const el = state.agentState.currentMsgEl;
      if (data.type === 'agent-reasoning') {
        state.agentState.reasoning += data.text || '';
        const section = el.querySelector('.agent-reasoning-section');
        section.style.display = 'block';
        const contentEl = el.querySelector('.agent-reasoning-content');
        contentEl.style.display = 'block';
        contentEl.textContent = state.agentState.reasoning;
        el.querySelector('.reasoning-toggle').textContent = '▼';
        // 思考过程开始输出时，清除"等待模型响应"占位
        const bubble = el.querySelector('.agent-content-bubble');
        if (bubble) bubble.style.display = 'none';
      } else if (data.type === 'agent-content') {
        state.agentState.content += data.text || '';
        // 开始输出内容时显示输入框
        const inputArea = document.querySelector('.chat-input-area');
        if (inputArea) inputArea.style.display = '';
        const bubble = el.querySelector('.agent-content-bubble');
        if (bubble) {
          bubble.style.display = '';
          if (bubble.querySelector('.loading-text')) bubble.innerHTML = '';
          // 保存原始文本，用于双击编辑
          bubble.dataset.originalContent = state.agentState.content;
          // 使用Markdown渲染
          bubble.innerHTML = renderMarkdown(state.agentState.content);
        }
      } else if (data.type === 'agent-tool-exec') {
        state.agentState.tools.push({ tool: data.tool, args: data.args, result: null });
        if (isTodoTool(data.tool)) {
          // 待办不画通用工具卡片，直接画清单卡片
          renderTodoCard(el, null);
        } else {
          appendAgentToolCard(data.tool, data.args);
        }
      } else if (data.type === 'agent-tool-result') {
        if (isTodoTool(data.tool)) {
          if (data.result?.success) {
            renderTodoCard(el, data.result);
            persistActiveTodos(data.result);
          } else {
            // 失败时退回通用卡片，避免把错误信息藏起来
            renderTodoCard(el, null);
            appendAgentToolCard(data.tool, data.result || {});
          }
        } else {
          const cards = el.querySelectorAll('.agent-tool-card');
          const lastCard = cards[cards.length - 1];
          if (lastCard) {
            const resultDiv = lastCard.querySelector('.tool-result');
            const statusEl = lastCard.querySelector('.tool-status');
            const toggleEl = lastCard.querySelector('.tool-toggle');
            // 更新状态文字
            if (statusEl) {
              statusEl.textContent = data.result.success ? '✓ 完成' : '✗ 失败';
              statusEl.style.color = data.result.success ? 'var(--success-color,#4ade80)' : 'var(--error-color,#f87171)';
            }
            // 更新结果内容（不强制显示，由展开/收起控制）
            resultDiv.textContent = data.result.success ? JSON.stringify(data.result, null, 2).slice(0, 2000) : '失败: ' + (data.result.error || '未知错误');
            // 如果卡片已展开，则显示结果
            if (toggleEl && toggleEl.textContent === '▼') {
              resultDiv.style.display = 'block';
            }
          }
        }
      } else if (data.type === 'agent-tool-confirm') {
        // 显示工具执行确认弹窗
        const modal = document.getElementById('tool-confirm-modal');
        document.getElementById('confirm-tool-name').textContent = toolLabel(data.tool);
        // 生成友好的中文提示
        let friendlyDesc = '';
        const args = data.args || {};
        if (data.tool === 'write_file') {
          friendlyDesc = '文件路径：' + (args.path || '（未指定）') + '\n';
          if (args.content) friendlyDesc += '内容大小：' + args.content.length + ' 字符';
        } else if (data.tool === 'run_shell') {
          friendlyDesc = '命令：' + (args.command || '（未指定）');
          if (args.timeout) friendlyDesc += '\n超时：' + args.timeout + 'ms';
        } else if (data.tool === 'read_file') {
          friendlyDesc = '文件路径：' + (args.path || '（未指定）');
        } else if (data.tool === 'pet_action') {
          friendlyDesc = '动作：' + (args.action || args.name || '（未指定）');
        } else if (data.tool === 'get_system_info') {
          friendlyDesc = '获取当前系统概况信息';
        } else {
          friendlyDesc = JSON.stringify(args, null, 2);
        }
        document.getElementById('confirm-tool-args').textContent = friendlyDesc;
        modal.style.display = 'flex';
      } else if (data.type === 'agent-done') {
        state.agentState.done = true;
        state.isStreaming = false;
        state.activeRequestConversationId = null; // 清除请求会话ID
        const btn = document.getElementById('btn-send');
        if (btn) btn.disabled = false;
        // 确保输入框和内容气泡显示
        const inputArea = document.querySelector('.chat-input-area');
        if (inputArea) inputArea.style.display = '';
        const contentBubble = el.querySelector('.agent-content-bubble');
        if (contentBubble) {
          contentBubble.style.display = '';
          // 结束时清除"等待模型响应..."占位（截断/出错时可能没收到 agent-content）
          const loadingEl = contentBubble.querySelector('.loading-text');
          if (loadingEl) {
            if (data.content) {
              // 保存原始文本，用于双击编辑
              contentBubble.dataset.originalContent = data.content;
              // 使用Markdown渲染
              contentBubble.innerHTML = renderMarkdown(data.content);
            }
            else contentBubble.innerHTML = '';
          } else if ((!contentBubble.textContent.trim() || contentBubble.querySelector('.loading-text')) && data.content) {
            // 保存原始文本，用于双击编辑
            contentBubble.dataset.originalContent = data.content;
            // 使用Markdown渲染
            contentBubble.innerHTML = renderMarkdown(data.content);
          }
        }
        // 渲染 Token 消耗统计栏，并保存到临时变量供后续持久化
        // （因为这里会把 state.agentState 置为 null，所以不能存在 agentState 中）
        const agentUsage = data.usage || null;
        const agentElapsed = state.agentState?.startTime ? (Date.now() - state.agentState.startTime) : 0;
        if (agentUsage || agentElapsed > 0) {
          renderTokenStatsBar(el, agentUsage, agentElapsed);
          pendingAgentUsage = agentUsage;
          pendingAgentElapsedMs = agentElapsed;
        } else {
          pendingAgentUsage = null;
          pendingAgentElapsedMs = 0;
        }
        state.agentState = null;
      }
      scrollChatToBottomIfNeeded();
      return;
    }
    // 清理已失效的 agent 状态
    if (state.agentState && (!state.agentState.currentMsgEl || !state.agentState.currentMsgEl.isConnected)) {
      state.agentState = null;
    }
    // 普通模式流式更新
    if (data.type === 'stream-chunk' && state.currentAIMsgEl) {
      state.currentAIContent += data.content || '';
      const bubble = state.currentAIMsgEl.querySelector('.chat-bubble');
      if (bubble.querySelector('span')) bubble.innerHTML = '';
      // 保存原始文本，用于双击编辑
      bubble.dataset.originalContent = state.currentAIContent;
      // 使用Markdown渲染
      bubble.innerHTML = renderMarkdown(state.currentAIContent);
      scrollChatToBottomIfNeeded();
    }
    if (data.type === 'complete') {
      state.isStreaming = false;
      state.activeRequestConversationId = null; // 清除请求会话ID
      const btn = document.getElementById('btn-send');
      if (btn) btn.disabled = false;
    }
    // 流式完成事件：捕获 usage（部分平台只在流结束时返回 token 统计）
    if (data.type === 'stream-complete' && data.usage && state.currentAIMsgEl) {
      const conv = state.conversations?.find(c => c.id === state.activeConversationId);
      const aiMsg = conv?.messages?.[conv.messages.length - 1];
      if (aiMsg && aiMsg.role === 'ai') {
        aiMsg.usage = data.usage;
        renderTokenStatsBar(state.currentAIMsgEl, data.usage, 0);
      }
    }
    if (data.providerId && data.providerId !== state.activeProviderId) {
      state.activeProviderId = data.providerId;
      updateActiveProviderDisplay();
    }
  });

  window.api.on('ai:provider-sync', (data) => {
    if (data.activeProvider && data.activeProvider !== state.activeProviderId) {
      state.activeProviderId = data.activeProvider;
      syncAISettings();
      updateActiveProviderDisplay();
    }
  });
}

// ==================== 系统信息显示 ====================
function updateSystemInfoDisplay() {
  const info = state.systemInfo;
  if (!info) return;

  document.querySelector('#os-info .info-txt').textContent = info.os === 'win32' ? 'Windows' : info.os === 'darwin' ? 'macOS' : 'Linux';
  document.querySelector('#cpu-info .info-txt').textContent = `${info.cpuCount}核`;
  document.querySelector('#mem-info .info-txt').textContent = `${info.totalMem}GB`;
}

// 更新底部状态栏的当前模型名称
function updateModelStatusBar() {
  const txt = document.getElementById('status-model-txt');
  if (!txt) return;
  const t = window.I18N?.t || ((k) => k);
  if (!state.currentModelId) {
    txt.textContent = t('chat.defaultModel');
  } else {
    const model = state.models.find(m => m.id === state.currentModelId);
    txt.textContent = model ? model.name : t('chat.defaultModel');
  }
}

// ==================== 会话管理 ====================

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2, 6);
}

function getActiveConversation() {
  if (!state.activeConversationId || state.conversations.length === 0) return null;
  return state.conversations.find(c => c.id === state.activeConversationId) || null;
}

function getActiveMessages() {
  const conv = getActiveConversation();
  return conv ? conv.messages : state.chatHistory;
}

function createNewConversation() {
  const id = generateId();
  const conv = {
    id,
    title: '新对话',
    messages: [],
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
  state.conversations.unshift(conv);
  state.activeConversationId = id;
  setCompressNotice(null); // 提示属于单个会话
  saveConversations();
  renderConversationList();
  renderChat();
  // 新建会话不沿用旧会话的项目工作目录，重置为未选择状态
  if (typeof window.setProjectWorkdir === 'function') window.setProjectWorkdir('');
}

function switchConversation(id) {
  // 如果切换到不同的会话，且当前有正在进行的AI请求属于旧会话，取消请求
  if (state.activeConversationId !== id && state.activeRequestConversationId && state.activeRequestConversationId !== id) {
    console.log('[Session] 切换会话，取消旧会话的AI请求');
    if (window.api.cancelChat) {
      try { window.api.cancelChat(); } catch (e) {}
    }
    state.isStreaming = false;
    state.activeRequestConversationId = null;
    state.currentAIMsgEl = null;
    state.currentAIContent = '';
    state.agentState = null;
    const sendBtn = document.getElementById('btn-send');
    const stopBtn = document.getElementById('btn-stop');
    if (sendBtn) {
      sendBtn.disabled = false;
      sendBtn.style.display = '';
    }
    if (stopBtn) stopBtn.style.display = 'none';
    const inputArea = document.querySelector('.chat-input-area');
    if (inputArea) inputArea.style.display = '';
  }
  state.activeConversationId = id;
  setCompressNotice(null);
  // 同步 chatHistory 到兼容格式
  const conv = state.conversations.find(c => c.id === id);
  if (conv) {
    state.chatHistory = conv.messages;
  }
  // 恢复该会话绑定的项目工作目录（各会话独立，不互相影响）
  if (typeof window.syncProjectFromActiveConv === 'function') window.syncProjectFromActiveConv();
  renderConversationList();
  renderChat();
}

function deleteConversation(id) {
  const index = state.conversations.findIndex(c => c.id === id);
  if (index === -1) return;

  // 如果删除的是当前正在进行AI请求的会话，取消请求并清理状态
  if (state.activeRequestConversationId === id) {
    console.log('[Session] 删除正在进行AI请求的会话，取消请求并清理状态');
    // 取消正在进行的AI请求
    if (window.api.cancelChat) {
      try { window.api.cancelChat(); } catch (e) {}
    }
    // 清理AI请求相关状态
    state.isStreaming = false;
    state.activeRequestConversationId = null;
    state.currentAIMsgEl = null;
    state.currentAIContent = '';
    state.agentState = null;
    // 恢复发送按钮显示
    const sendBtn = document.getElementById('btn-send');
    const stopBtn = document.getElementById('btn-stop');
    if (sendBtn) {
      sendBtn.disabled = false;
      sendBtn.style.display = '';
    }
    if (stopBtn) stopBtn.style.display = 'none';
    // 显示输入框
    const inputArea = document.querySelector('.chat-input-area');
    if (inputArea) inputArea.style.display = '';
  }

  state.conversations.splice(index, 1);
  if (state.activeConversationId === id) {
    if (state.conversations.length > 0) {
      switchConversation(state.conversations[0].id);
    } else {
      state.activeConversationId = null;
      state.chatHistory = [];
      renderChat();
    }
  }
  saveConversations();
  renderConversationList();
}

function autoTitleConversation(conv, userMessage) {
  if (conv.title === '新对话' && userMessage) {
    conv.title = userMessage.slice(0, 20) + (userMessage.length > 20 ? '...' : '');
  }
}

// 聊天历史记录限制（内存优化）
const MAX_CONVERSATIONS = 50; // 最多保留50个会话
const MAX_MESSAGES_PER_CONVERSATION = 200; // 每个会话最多保留200条消息

function saveConversations() {
  // ★ 内存优化：限制会话数量和每个会话的消息数量
  let cleaned = false;

  // 限制会话数量：超过上限时删除最旧的会话（按updatedAt排序）
  if (state.conversations.length > MAX_CONVERSATIONS) {
    state.conversations.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    const removed = state.conversations.splice(MAX_CONVERSATIONS);
    console.log('[MemoryOptimizer] 清理旧会话:', removed.length, '个');
    cleaned = true;
  }

  // 限制每个会话的消息数量：超过上限时删除最旧的消息
  state.conversations.forEach(conv => {
    if (conv.messages && conv.messages.length > MAX_MESSAGES_PER_CONVERSATION) {
      const removeCount = conv.messages.length - MAX_MESSAGES_PER_CONVERSATION;
      conv.messages = conv.messages.slice(removeCount);
      console.log('[MemoryOptimizer] 清理会话', conv.title, '的旧消息:', removeCount, '条');
      cleaned = true;
    }
  });

  // 同步 chatHistory
  const activeConv = state.conversations.find(c => c.id === state.activeConversationId);
  if (activeConv) {
    state.chatHistory = activeConv.messages;
  }

  window.api.saveChatHistory(state.conversations).catch(() => {});

  if (cleaned) {
    // 如果清理了数据，重新渲染会话列表和聊天界面
    renderConversationList();
    renderChat();
  }
}

function renderConversationList() {
  const select = document.getElementById('conversation-select');
  const delBtn = document.getElementById('btn-delete-conv');
  if (!select) return;

  // 记录当前选中值，便于重建后恢复
  const currentValue = select.value;

  // 清空（保留第一个占位 option）
  while (select.options.length > 1) {
    select.remove(1);
  }

  // 无会话时隐藏选择器和删除按钮
  if (state.conversations.length === 0) {
    select.style.display = 'none';
    if (delBtn) delBtn.style.display = 'none';
    return;
  }

  select.style.display = '';
  state.conversations.forEach(conv => {
    const option = document.createElement('option');
    option.value = conv.id;
    option.textContent = conv.title;
    if (conv.id === state.activeConversationId) {
      option.selected = true;
    }
    select.appendChild(option);
  });

  // 确保 active 选项被选中（即使 select value 已正确设置）
  if (state.activeConversationId) {
    select.value = state.activeConversationId;
  }

  // 有选中会话时显示删除按钮，仅剩一个会话时也允许删除（删除后会创建新会话）
  if (delBtn) {
    delBtn.style.display = state.activeConversationId ? '' : 'none';
  }
}

// ==================== AI 对话 ====================
function renderChat() {
  const messagesContainer = document.getElementById('chat-messages');
  messagesContainer.innerHTML = '';

  const messages = getActiveMessages();
  let lastAiMsgEl = null;
  const streamingToThisConv = state.isStreaming &&
    (!state.activeRequestConversationId || state.activeRequestConversationId === state.activeConversationId);
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    // ★ 流式进行中，最后一条正在生成的 AI 消息：Agent 模式用 appendAgentMessage 重建特殊 DOM 结构
    const isStreamingLastAi = streamingToThisConv &&
      i === messages.length - 1 && msg.role === 'ai' &&
      (state.agentState || state.currentAIMsgEl);
    const el = (isStreamingLastAi && state.agentState) ? appendAgentMessage(msg) : appendChatMessage(msg);
    if (el && msg.role === 'ai') {
      lastAiMsgEl = el;
    }
  }

  // ★ 恢复当前会话的待办清单卡片（工具卡片本身不落库，只有清单单独恢复 —— 它是"任务目标"，
  //   用户切走再切回来必须还能看到做到哪一步了）
  const activeConv = state.conversations?.find(c => c.id === state.activeConversationId);
  if (activeConv && Array.isArray(activeConv.activeTodos) && activeConv.activeTodos.length) {
    const card = buildTodoCardEl(activeConv.activeTodos, (() => {
      const total = activeConv.activeTodos.length;
      const completed = activeConv.activeTodos.filter(i => i.status === 'completed').length;
      return { total, completed, percent: total ? Math.round(completed / total * 100) : 0 };
    })(), activeConv.activeTodoTitle);
    if (card) messagesContainer.appendChild(card);
  }

  if (messages.length === 0) {
    const welcome = document.createElement('div');
    welcome.className = 'chat-message ai';
    // 欢迎消息不显示头像
    welcome.innerHTML = `
      <div style="flex:1;min-width:0;text-align:left;">
        <div class="chat-bubble" style="display:inline-block;text-align:left;">你好！我是灵汐，浮灵饰界的智能助手，很高兴认识你！我可以帮你：

· 回答问题、聊天解闷
· 管理本地文件
· 执行系统命令
· 安装/卸载软件
· 调用本地或云端AI

请先在"AI配置"页面设置AI模型，然后就可以和我对话啦！</div>
      </div>
    `;
    messagesContainer.appendChild(welcome);
  }

  messagesContainer.scrollTop = messagesContainer.scrollHeight;
  renderCompressNotice(); // 压缩状态提示（若正在/刚完成自动压缩）跟在最后
  renderContextBar();

  // ★ 修复：流式进行中重建 DOM 后，重新绑定正在生成的 AI 消息元素，
  // 避免切到其他功能页再切回 chat 时，正在生成的回复显示为空（用户误以为对话被关闭）。
  if (streamingToThisConv && lastAiMsgEl) {
    if (state.agentState) {
      // Agent 模式：重新绑定元素并恢复已积累的 reasoning/content
      state.agentState.currentMsgEl = lastAiMsgEl;
      if (state.agentState.reasoning) {
        const rSection = lastAiMsgEl.querySelector('.agent-reasoning-section');
        const rContent = lastAiMsgEl.querySelector('.agent-reasoning-content');
        if (rSection && rContent) {
          rSection.style.display = 'block';
          rContent.style.display = 'block';
          rContent.textContent = state.agentState.reasoning;
        }
      }
      if (state.agentState.content) {
        const bubble = lastAiMsgEl.querySelector('.agent-content-bubble');
        if (bubble) {
          bubble.innerHTML = renderMarkdown(state.agentState.content);
          bubble.dataset.originalContent = state.agentState.content;
        }
      }
    } else if (state.currentAIMsgEl) {
      // 普通模式：重新绑定元素并恢复已积累的内容
      state.currentAIMsgEl = lastAiMsgEl;
      const bubble = lastAiMsgEl.querySelector('.chat-bubble');
      if (bubble && state.currentAIContent) {
        bubble.innerHTML = renderMarkdown(state.currentAIContent);
      }
    }
  }
}


// ==================== 上下文容量 & 会话压缩 ====================
// 上下文窗口（token）自动识别表：按模型名/提供商名匹配，用户可在 AI 配置里手动覆盖。
const CONTEXT_WINDOW_TABLE = [
  { re: /gemini/i, size: 1000000 },
  { re: /minimax|abab/i, size: 245000 },
  { re: /claude/i, size: 200000 },
  { re: /grok/i, size: 131072 },
  { re: /glm|chatglm|智谱/i, size: 128000 },
  { re: /moonshot|kimi/i, size: 128000 },
  { re: /gpt-4\.1|gpt-4o|gpt-4-turbo|o1-|o3-|o4-/i, size: 128000 },
  { re: /deepseek/i, size: 64000 },
  { re: /qwen|通义|tongyi/i, size: 32768 },
  { re: /doubao|豆包/i, size: 32768 },
  { re: /hunyuan|混元/i, size: 32768 },
  { re: /step-|阶跃/i, size: 32768 },
  { re: /spark|星火/i, size: 32768 },
  { re: /ernie|文心/i, size: 30000 },
  { re: /gpt-3\.5|gpt-35/i, size: 16384 },
  { re: /llama|mistral|gemma|phi-|qwen2\.5-coder/i, size: 8192 },
];
const DEFAULT_CONTEXT_WINDOW = 32768;   // 无法识别时的保守默认值（与 Ollama num_ctx 一致）
const AUTO_COMPRESS_THRESHOLD = 85;     // 上下文使用率超过该百分比时自动压缩
const COMPRESS_KEEP_RECENT = 20;        // 压缩时保留最近的 N 条真实消息，其余压缩为摘要（保留最近对话，更早的进摘要）
const SINGLE_MESSAGE_TOKEN_CAP = 2000;  // 单条历史消息进入请求体的 token 上限（超出截断）
const CONTEXT_BAR_WARN = 70;            // 容量条变黄阈值(%)
const CONTEXT_BAR_DANGER = 90;          // 容量条变红阈值(%)

// 粗略 token 估算：CJK 约 1 字 1 token，其他约 4 字符 1 token
function estimateTokens(text) {
  if (!text) return 0;
  const s = typeof text === 'string' ? text : String(text);
  if (!s) return 0;
  const cjk = (s.match(/[\u2E80-\u9FFF\uF900-\uFAFF\uAC00-\uD7AF\uFF00-\uFFEF]/g) || []).length;
  return Math.ceil(cjk + (s.length - cjk) * 0.26);
}

function formatTokenCount(n) {
  const v = Math.max(0, Math.round(n || 0));
  if (v >= 1000000) return (v / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (v >= 1000) return (v / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
  return String(v);
}

function getActiveProviderConfig() {
  return state.cloudProviders.find(p => p.id === state.activeProviderId) || null;
}

function isAgentModeEnabled() {
  return !!document.getElementById('agent-mode')?.checked;
}

// 上下文窗口：用户手动值优先，其次按模型名自动识别，最后保守默认
function getContextWindow(provider) {
  const override = parseInt(state.settings.ai?.contextWindow, 10);
  if (override > 0) return override;
  const p = provider || getActiveProviderConfig();
  const name = ((p?.model || '') + ' ' + (p?.name || '')).trim();
  if (name) {
    for (const item of CONTEXT_WINDOW_TABLE) if (item.re.test(name)) return item.size;
  }
  return DEFAULT_CONTEXT_WINDOW;
}

function getContextWindowSource() {
  const override = parseInt(state.settings.ai?.contextWindow, 10);
  if (override > 0) return 'manual';
  const p = getActiveProviderConfig();
  const name = ((p?.model || '') + ' ' + (p?.name || '')).trim();
  if (name && CONTEXT_WINDOW_TABLE.some(item => item.re.test(name))) return 'auto';
  return 'default';
}

// 工具定义/系统提示词的真实开销在主进程（前端拿不到原文），启动后取一次缓存
let contextMetaCache = null;
async function primeContextMeta() {
  try {
    if (window.api?.getContextMeta) {
      const meta = await window.api.getContextMeta();
      if (meta && typeof meta.toolsTokens === 'number') {
        contextMetaCache = meta;
        renderContextBar();
      }
    }
  } catch (e) { /* 忽略：拿不到就用兜底估算 */ }
  return contextMetaCache;
}

// 输出 token 预留：与主进程的 max_tokens 决策完全一致，否则"占用估算"会少算一大块，
// 导致上下文满了却不触发自动压缩、请求越过模型窗口上限。
// 主进程 agentChat：渲染层不传 maxTokens → 非 Ollama 时 tokens = thinkMode ? 8192 : 4096
// （思考模式固定预留 8192，保证"思考 + 工具调用"不被输出上限截断）。
function resolveOutputTokens(isAgent, userMaxTokens) {
  const cap = 32768;
  if (!isAgent) return Math.min(userMaxTokens || 2048, cap);
  const thinkMode = !!document.getElementById('agent-think-mode')?.checked;
  return Math.min(thinkMode ? 8192 : 4096, cap);
}

// 请求体的固定开销：系统提示词 + 工具定义 + 预留给模型输出的 token
function estimateBaseCost(isAgent, maxOutput) {
  const ai = state.settings.ai || {};
  let systemTokens = estimateTokens(ai.systemPrompt || '');
  const role = (state.agentRoles || []).find(r => r.id === state.currentRoleId);
  if (role?.systemPrompt) systemTokens = Math.max(systemTokens, estimateTokens(role.systemPrompt));
  if (isAgent) {
    // Agent 模式：主进程用 AGENT_SYSTEM_PROMPT（无自定义角色时）+ 工具调用强制要求
    systemTokens = Math.max(systemTokens, contextMetaCache?.systemPromptTokens || 0) + 600;
  }
  const toolsTokens = isAgent ? (contextMetaCache?.toolsTokens || 3200) : 0;
  return { systemTokens, toolsTokens, outputTokens: maxOutput, total: systemTokens + toolsTokens + maxOutput };
}

// 过长的历史消息在发送前截断（保留最新一条完整，避免正在回答的问题被切）
function trimHistoryContent(content, isLatest) {
  const text = content || '';
  if (isLatest) return text;
  const charCap = SINGLE_MESSAGE_TOKEN_CAP * 4;
  if (text.length <= charCap) return text;
  const kept = text.slice(0, charCap);
  return kept + '\n……（历史消息过长，此处省略约 ' + formatTokenCount(estimateTokens(text) - estimateTokens(kept)) + ' tokens）';
}

// 把单条文本按估算 token 预算截断（从头保留，附省略说明；返回结果的估算 ≤ maxTokens）。
// 用于硬性上限兜底：最新一条消息本身大到放不进窗口时，也按预算截断，绝不发出必然被上游拒绝的请求。
function trimTextToTokens(text, maxTokens) {
  const s = text || '';
  if (!s || maxTokens <= 0) return s;
  if (estimateTokens(s) <= maxTokens) return s;
  const SUFFIX_OVERHEAD = 40; // 省略说明后缀的估算预算
  const target = Math.max(40, maxTokens - SUFFIX_OVERHEAD);
  // 先按"非中文 4 字符 ≈ 1 token"粗切，再按估算精确收缩（中文 1 字符 ≈ 1 token，只会更保守）
  let kept = s.slice(0, Math.max(80, target * 4));
  let guard = 0;
  while (kept.length > 80 && estimateTokens(kept) > target && guard++ < 40) {
    kept = kept.slice(0, Math.floor(kept.length * 0.92));
  }
  let suffix = '\n……（消息过长，此处省略约 ' + formatTokenCount(estimateTokens(s) - estimateTokens(kept)) + ' tokens）';
  // 后缀可能把总估算带出预算，再收缩一次（正文）
  guard = 0;
  while (kept.length > 80 && estimateTokens(kept + suffix) > maxTokens && guard++ < 40) {
    kept = kept.slice(0, Math.floor(kept.length * 0.92));
    suffix = '\n……（消息过长，此处省略约 ' + formatTokenCount(estimateTokens(s) - estimateTokens(kept)) + ' tokens）';
  }
  return kept + suffix;
}

// 按上下文预算挑选要发送的历史消息：
// 从最新一条往前累积，直到预算用尽；摘要消息始终带上（它覆盖更早的历史）。
// 返回值可同时用于"实际发送"和"容量展示"，保证两者口径一致。
function buildOutgoingMessages(conv, opts = {}) {
  const ai = state.settings.ai || {};
  const provider = getActiveProviderConfig();
  const ctxWindow = getContextWindow(provider);
  const isAgent = opts.agent !== undefined ? !!opts.agent : isAgentModeEnabled();
  const maxOutput = resolveOutputTokens(isAgent, parseInt(ai.maxTokens, 10) || 0);
  const base = estimateBaseCost(isAgent, maxOutput);
  // 用最近一次真实 prompt_tokens 校准估算误差（仅普通模式校准；Agent 模式中间插入的工具消息前端看不到）
  const calib = Math.min(3, Math.max(0.5, Number(conv?.ctxCalib?.factor) || 1));
  const budget = Math.max(1000, ctxWindow - base.total - 256);

  const all = (conv?.messages || []).filter(m => m && typeof m.content === 'string' && m.content.trim());
  let summaryIdx = -1;
  for (let i = all.length - 1; i >= 0; i--) { if (all[i].isSummary) { summaryIdx = i; break; } }
  const afterSummary = summaryIdx >= 0 ? all.slice(summaryIdx + 1) : all;

  const kept = [];
  let historyTokens = 0;
  let historyChars = 0;
  let droppedFromWindow = 0;
  for (let i = afterSummary.length - 1; i >= 0; i--) {
    const m = afterSummary[i];
    const isLatest = i === afterSummary.length - 1;
    const content = trimHistoryContent(m.aiContent || m.content, isLatest);
    const cost = Math.ceil((estimateTokens(content) + 4) * calib);
    if (kept.length >= 2 && historyTokens + cost > budget) { droppedFromWindow = i + 1; break; }
    historyTokens += cost;
    historyChars += content.length;
    kept.unshift({ role: m.role, content });
  }

  const messages = [];
  if (summaryIdx >= 0) {
    const summaryContent = all[summaryIdx].content +
      '\n（说明：以上是更早对话的压缩摘要，作为背景信息参考，不是用户的原话。）';
    messages.push({ role: 'assistant', content: summaryContent });
    historyTokens += estimateTokens(summaryContent) + 4;
    historyChars += summaryContent.length;
  }
  messages.push(...kept);

  // —— 硬性上限：请求体（系统+工具+摘要+历史）估算必须 ≤ 上下文窗口，绝不发出会越过限制的请求 ——
  // 选择循环只对"历史"做预算，摘要与无条件保留的最新消息可能把总量顶破窗口，这里统一收口。
  let overLimit = false;
  if (historyTokens > budget && messages.length) {
    // ① 摘要超预算 → 先按预算的 20%（下限 200 token）截断摘要
    if (summaryIdx >= 0) {
      const summaryMax = Math.max(200, Math.floor(budget * 0.2));
      const before = messages[0].content;
      const trimmed = trimTextToTokens(before, summaryMax);
      if (trimmed.length < before.length) {
        historyTokens -= (estimateTokens(before) - estimateTokens(trimmed));
        historyChars -= before.length - trimmed.length;
        messages[0].content = trimmed;
      }
    }
    // ② 仍超 → 从最旧的历史开始丢弃（保留摘要与最新 1 条 = 用户当前消息），直到放得下
    let dropIdx = summaryIdx >= 0 ? 1 : 0;
    while (historyTokens > budget && messages.length > 1) {
      const removed = messages.splice(dropIdx, 1)[0];
      if (!removed) break;
      historyTokens -= estimateTokens(removed.content || '') + 4;
      historyChars -= (removed.content || '').length;
      droppedFromWindow++;
      if (dropIdx > 0 && messages.length <= 2) dropIdx = 1; // 摘要仍在最前
    }
    // ③ 仍超（最新一条本身超大）→ 把最新一条截断到剩余预算（下限 200 token）
    if (historyTokens > budget && messages.length) {
      const last = messages[messages.length - 1];
      const lastCost = estimateTokens(last.content || '') + 4;
      const avail = Math.max(200, budget - (historyTokens - lastCost));
      const before = last.content;
      const trimmed = trimTextToTokens(before, avail);
      historyTokens = historyTokens - lastCost + estimateTokens(trimmed) + 4;
      historyChars -= before.length - trimmed.length;
      last.content = trimmed;
      if (historyTokens > budget) overLimit = true; // 预算 <200 的极端配置才会走到
    }
  }

  // 输入框里还没发出去的内容也计入占用，让"发出去会不会超"一眼可见
  const draftEl = document.getElementById('chat-input');
  const draftText = draftEl ? String(draftEl.value || '').trim() : '';
  const draftTokens = draftText ? Math.ceil(estimateTokens(draftText) * calib) : 0;

  return {
    messages,
    stats: {
      ctxWindow, base, historyTokens, draftTokens,
      used: base.total + historyTokens + draftTokens,
      charCount: historyChars + draftText.length,
      keptCount: kept.length,
      droppedFromWindow,
      overLimit,
      // 摘要覆盖的原始消息条数（取摘要消息自带的元信息，压缩多次时是最新一轮的条数）
      coveredBySummary: summaryIdx >= 0 ? (all[summaryIdx].summaryMeta?.covered || 0) : 0,
      hasSummary: summaryIdx >= 0,
      calib, maxOutput, isAgent, budget
    }
  };
}

// 当前上下文占用（展示用）：单位与 buildOutgoingMessages 完全一致
function computeContextUsage(conv) {
  const built = buildOutgoingMessages(conv);
  const s = built.stats;
  const percent = s.ctxWindow > 0 ? Math.min(100, (s.used / s.ctxWindow) * 100) : 0;
  return { ...s, percent, calibrated: Math.abs(s.calib - 1) > 0.02 };
}

// 可压缩的真实消息条数（保留最近 N 条不动）
function countCompressible(conv) {
  const real = (conv?.messages || []).filter(m => m && typeof m.content === 'string' && m.content.trim() && !m.isSummary);
  return Math.max(0, real.length - COMPRESS_KEEP_RECENT);
}

function isAutoCompressEnabled() {
  // Agent 设置面板里的开关（与其它 Agent 开关同一个 localStorage 存档），默认开启
  try {
    const saved = localStorage.getItem(AGENT_SETTINGS_KEY);
    if (saved) {
      const s = JSON.parse(saved);
      if (typeof s.autoCompress === 'boolean') return s.autoCompress;
    }
  } catch (e) { /* 解析失败按默认值 */ }
  return state.settings.ai?.autoCompress !== false;
}

const CTX_RING_CIRCUMFERENCE = 100.53; // 2πr, r=16（与 index.html/SVG 中一致）

function renderContextBar() {
  const bar = document.getElementById('ctx-bar');
  if (!bar) return;
  const conv = getActiveConversation();
  const usage = computeContextUsage(conv);
  const ringFill = document.getElementById('ctx-ring-fill');
  const percent = usage.percent;
  let level = 'ok';
  if (percent >= CONTEXT_BAR_DANGER) level = 'danger';
  else if (percent >= CONTEXT_BAR_WARN) level = 'warn';
  bar.dataset.level = level;

  const t = (k, p) => (window.I18N?.t ? window.I18N.t(k, p) : k);
  if (ringFill) {
    ringFill.style.strokeDashoffset = String(CTX_RING_CIRCUMFERENCE * (1 - Math.min(100, percent) / 100));
  }
  // 界面上不显示任何数字：用量只在悬停提示与点击后的明细里出现
  bar.title = t('chat.contextBarTip', {
    p: percent.toFixed(percent < 10 ? 1 : 0),
    used: formatTokenCount(usage.used),
    total: formatTokenCount(usage.ctxWindow),
    chars: usage.charCount.toLocaleString()
  });

  const popup = document.getElementById('ctx-popup');
  if (popup && popup.style.display !== 'none') {
    popup.innerHTML = buildContextPopupHTML(usage, conv);
    bindContextPopup(usage, conv);
    popup.style.display = 'block';
  }
}

function buildContextPopupHTML(usage, conv) {
  const t = (k, p) => (window.I18N?.t ? window.I18N.t(k, p) : k);
  const win = usage.ctxWindow || 1;
  const pctOf = (v) => (v / win) * 100;
  // 分段构成（占比按上下文窗口计算，与总量对齐）
  const segments = [
    { key: 'chat.ctxSystemPrompt', val: usage.base.systemTokens, color: '#8b5cf6' },
    { key: 'chat.ctxTools', val: usage.base.toolsTokens, color: '#22c55e' },
    { key: 'chat.ctxHistory', val: usage.historyTokens, color: '#f59e0b' },
    { key: 'chat.ctxOutput', val: usage.base.outputTokens, color: '#38bdf8' },
    { key: 'chat.ctxDraft', val: usage.draftTokens, color: '#ec4899' }
  ].filter(s => s.val > 0);

  let html = '<div class="ctx-popup-head">';
  html += '<span class="ctx-popup-title">' + t('chat.ctxDetailTitle') + '</span>';
  html += '<button type="button" class="ctx-popup-close" id="ctx-popup-close" aria-label="' + t('chat.ctxClose') + '">×</button>';
  html += '</div>';

  // 大号使用率 + 已使用量 / 窗口
  html += '<div class="ctx-popup-metric">';
  html += '<span class="ctx-popup-percent">' + usage.percent.toFixed(1) + '%</span>';
  html += '<span class="ctx-popup-used">' + t('chat.ctxUsedLabel') + ' ' + formatTokenCount(usage.used) +
    ' / ' + formatTokenCount(usage.ctxWindow) + '</span>';
  html += '</div>';

  // 分段色条 + 图例（每类给百分比）
  if (segments.length) {
    html += '<div class="ctx-seg-bar">';
    for (const s of segments) {
      html += '<span class="ctx-seg" style="width:' + Math.max(0.6, pctOf(s.val)).toFixed(2) +
        '%;background:' + s.color + '"></span>';
    }
    html += '</div>';
    html += '<div class="ctx-legend">';
    for (const s of segments) {
      html += '<div class="ctx-legend-item">' +
        '<span class="ctx-dot" style="background:' + s.color + '"></span>' +
        '<span class="ctx-legend-name">' + t(s.key) + '</span>' +
        '<span class="ctx-legend-val">' + pctOf(s.val).toFixed(1) + '%</span>' +
        '</div>';
    }
    html += '</div>';
  }

  // 一行紧凑统计 + 压缩入口（不再堆说明文字）
  const compressible = countCompressible(conv);
  html += '<div class="ctx-popup-foot">';
  if (compressible > 0) {
    html += '<button type="button" class="ctx-popup-action" id="ctx-compress-now"' +
      (state.isStreaming || state.compressBusy ? ' disabled' : '') + '>' +
      window.ElIcons.ICONS.archive + '<span>' +
      t(state.compressBusy ? 'chat.compressing' : 'chat.compressNow', { n: compressible }) + '</span></button>';
  }
  html += '<span class="ctx-auto-flag' + (isAutoCompressEnabled() ? ' on' : '') + '">' +
    t('chat.autoCompress') + '：' + t(isAutoCompressEnabled() ? 'chat.ctxAutoOnShort' : 'chat.ctxAutoOffShort') + '</span>';
  html += '</div>';
  return html;
}

function bindContextPopup(usage, conv) {
  const closeBtn = document.getElementById('ctx-popup-close');
  if (closeBtn) {
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const popup = document.getElementById('ctx-popup');
      if (popup) popup.style.display = 'none';
    });
  }
  const btn = document.getElementById('ctx-compress-now');
  if (btn) {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      // 弹窗刚打开的 250ms 内忽略点击：防止"打开弹窗那一下"被算成点了压缩按钮
      if (Date.now() - (state.ctxPopupOpenedAt || 0) < 250) return;
      const popup = document.getElementById('ctx-popup');
      if (popup) popup.style.display = 'none';
      await compressConversation({ auto: false });
    });
  }
}

function toggleContextPopup(force) {
  const popup = document.getElementById('ctx-popup');
  if (!popup) return;
  const show = force !== undefined ? force : popup.style.display === 'none';
  if (!show) { popup.style.display = 'none'; return; }
  state.ctxPopupOpenedAt = Date.now();
  const conv = getActiveConversation();
  const usage = computeContextUsage(conv);
  popup.innerHTML = buildContextPopupHTML(usage, conv);
  bindContextPopup(usage, conv);
  popup.style.display = 'block';
}

// ==================== 会话压缩 ====================
const SUMMARY_SYSTEM_PROMPT = `你是对话压缩助手。把一段正在进行的对话压缩成简洁但信息完整的摘要，供后续对话继续使用。
要求：
1. 保留：用户的目标与需求、已达成的结论与决定、关键事实/数据/文件路径/代码要点、未完成的任务与下一步、用户的偏好与约束、助手已执行的操作及其结果。
2. 舍弃：寒暄客套、重复内容、失败的中间尝试、可以重新推导的细节。
3. 输出中文，用要点列表，按「🎯 目标 / ✅ 已完成 / 📌 关键信息 / ⏭ 待办」四段组织；某段没有内容可省略。
4. 不要编造原文没有的信息，不要输出与摘要无关的解释。`;

function setCompressBusy(busy) {
  state.compressBusy = busy;
  // 界面上唯一的压缩入口在明细弹窗里，交给 renderContextBar 统一刷新（含"压缩中..."状态）
  renderContextBar();
}

// 把较早的历史消息（含旧摘要）交给当前模型压缩成一条摘要消息
async function compressConversation({ auto = false, keepRecent = COMPRESS_KEEP_RECENT } = {}) {
  const conv = getActiveConversation();
  if (!conv) return { success: false, error: 'no_conversation' };
  if (state.isStreaming) {
    if (!auto) showToast('暂时无法压缩', '请等待当前回复结束后再压缩上下文', 'warning');
    return { success: false, error: 'streaming' };
  }
  if (state.compressBusy) return { success: false, error: 'busy' };

  const arr = conv.messages || [];
  const realIdx = [];
  arr.forEach((m, i) => {
    if (m && typeof m.content === 'string' && m.content.trim() && !m.isSummary) realIdx.push(i);
  });
  if (realIdx.length <= keepRecent) {
    if (!auto) showToast('无需压缩', '当前会话消息较少，还不需要压缩上下文', 'warning');
    return { success: false, error: 'too_few_messages' };
  }

  const firstKeptIdx = realIdx[realIdx.length - keepRecent];
  const toCompress = arr.slice(0, firstKeptIdx).filter(m => m && typeof m.content === 'string' && m.content.trim());
  const tail = arr.slice(firstKeptIdx);
  if (!toCompress.length) return { success: false, error: 'too_few_messages' };

  let transcript = toCompress.map(m => {
    const who = m.isSummary ? '【此前摘要】' : (m.role === 'user' ? '用户' : '助手');
    return who + '：' + m.content;
  }).join('\n\n');
  const MAX_TRANSCRIPT_CHARS = 12000; // 控制压缩请求本身的体积（优先保留较新的内容）
  if (transcript.length > MAX_TRANSCRIPT_CHARS) {
    transcript = '（更早的内容已省略）\n' + transcript.slice(transcript.length - MAX_TRANSCRIPT_CHARS);
  }

  // 压缩一律在聊天流里提示"压缩中 → 已压缩"，不再额外弹 toast；
  // 提示插在"被压缩的那段对话"末尾（firstKeptIdx 之前），作为压缩边界标记
  setCompressNotice('running', 0, firstKeptIdx);
  setCompressBusy(true);
  try {
    const res = await window.api.chat({
      messages: [{ role: 'user', content: '请把下面这段对话压缩成摘要（摘要是给后续对话看的背景资料）：\n\n' + transcript }],
      providerId: state.activeProviderId,
      systemPrompt: SUMMARY_SYSTEM_PROMPT,
      temperature: 0.3,
      maxTokens: 1536,
      silent: true
    });
    const summaryText = (res?.content || '').trim();
    if (!res || !res.success || !summaryText) {
      const err = res?.error || '模型未返回摘要内容';
      // 失败：流内显示"压缩失败"；手动压缩再补一个带原因的 toast
      setCompressNotice('failed', 6000);
      if (!auto) showToast('压缩失败', err, 'error');
      return { success: false, error: err };
    }

    const summaryMsg = {
      role: 'ai',
      content: '【历史对话摘要】\n' + summaryText,
      isSummary: true,
      time: Date.now(),
      summaryMeta: {
        covered: toCompress.length,
        kept: tail.length,
        model: getActiveProviderConfig()?.model || '',
        auto: !!auto,
        at: Date.now()
      }
    };
    // 保留全部原始消息，只在压缩边界插入一条摘要标记。
    // 模型侧：buildOutgoingMessages 只取"最后一条摘要 + 其后的最近消息"发给模型（更早的原文不再重发，节省上下文）；
    // 用户侧：完整对话历史一直保留在会话里、界面上照常可翻，不会因为压缩而丢失。
    conv.messages = [...arr.slice(0, firstKeptIdx), summaryMsg, ...tail];
    conv.ctxCalib = null; // 历史变了，之前的校准系数失效
    conv.updatedAt = Date.now();
    saveConversations();
    renderChat();
    renderContextBar();
    // 摘要卡片现在位于 DOM 第 firstKeptIdx 位（前面还压着保留的旧消息），
    // "已压缩"提示落在摘要卡片正下方 → 锚点 = firstKeptIdx + 1
    setCompressNotice('done', 5000, firstKeptIdx + 1);
    console.log('[Context] 压缩完成：压缩', toCompress.length, '条，保留', tail.length, '条，摘要', summaryText.length, '字符');
    return { success: true, covered: toCompress.length, summary: summaryText };
  } catch (e) {
    const err = e?.message || String(e);
    console.log('[Context] 压缩失败:', err);
    setCompressNotice('failed', 6000);
    if (!auto) showToast('压缩失败', err, 'error');
    return { success: false, error: err };
  } finally {
    setCompressBusy(false);
    renderContextBar();
  }
}

function t_(key, params) {
  return window.I18N?.t ? window.I18N.t(key, params) : key;
}

// ==================== 压缩状态提示（聊天流内，作为压缩边界标记） ====================
// 位置：紧跟在"被压缩的那段对话"之后（压缩中=最后一条被压缩消息之后；压缩完成=摘要卡片之后），
// 用一条虚线把它与压缩前的对话隔开，后面继续正常对话。
let compressNoticeSeq = 0;

// anchorIndex：插入位置（相对于 #chat-messages 的子元素下标）。不传就沿用上一次的位置。
function setCompressNotice(status, autoClearMs = 0, anchorIndex = null) {
  const seq = ++compressNoticeSeq;
  if (status) {
    const keepAnchor = anchorIndex !== null ? anchorIndex : (state.compressNotice ? state.compressNotice.anchorIndex : null);
    state.compressNotice = { status, anchorIndex: keepAnchor, at: Date.now() };
  } else {
    state.compressNotice = null;
  }
  renderCompressNotice();
  if (autoClearMs > 0) {
    setTimeout(() => {
      if (compressNoticeSeq !== seq) return; // 期间有新状态/已清理，忽略本次
      state.compressNotice = null;
      renderCompressNotice();
    }, autoClearMs);
  }
}

function renderCompressNotice() {
  const container = document.getElementById('chat-messages');
  if (!container) return;
  container.querySelectorAll('.chat-compress-note').forEach(el => el.remove());
  const notice = state.compressNotice;
  if (!notice) return;
  const textKey = notice.status === 'running' ? 'chat.compressRunning'
    : (notice.status === 'done' ? 'chat.compressDone' : 'chat.compressFailed');
  const div = document.createElement('div');
  div.className = 'chat-compress-note ' + notice.status;
  div.innerHTML = '<span class="ccn-text">' + t_(textKey) + '</span>';
  // 插到压缩边界处（没有锚点时放到末尾）
  const kids = Array.from(container.children);
  const rawIdx = notice.anchorIndex === null || notice.anchorIndex === undefined ? kids.length : notice.anchorIndex;
  const idx = Math.max(0, Math.min(rawIdx, kids.length));
  container.insertBefore(div, kids[idx] || null);
}

// 摘要消息的折叠卡片式渲染
// 摘要消息：内容只作为上下文发给模型，**界面上不显示**。
// 但必须保留一个占位元素——#chat-messages 的元素与 conv.messages 是一条条对应的，
// 少了它会算错压缩提示的插入锚点。
function appendSummaryMessage(msg) {
  const container = document.getElementById('chat-messages');
  if (!container) return;
  const card = document.createElement('div');
  card.className = 'chat-summary-card';
  card.dataset.summaryLength = String((msg.content || '').length);
  container.appendChild(card);
}

// 供自检脚本 / 调试使用（与 window.AccountAPI 同类，只读能力 + 主动压缩）
window.ContextAPI = {
  estimateTokens,
  formatTokenCount,
  getContextWindow,
  getContextWindowSource,
  buildOutgoingMessages,
  computeContextUsage,
  countCompressible,
  compressConversation,
  renderContextBar,
  toggleContextPopup,
  CONTEXT_WINDOW_TABLE
};


// ==================== Token 消耗统计栏 ====================
function renderTokenStatsBar(msgEl, usage, elapsedMs) {
  if (!msgEl) return;
  const bar = msgEl.querySelector('.token-stats-bar');
  if (!bar) return;

  // 兼容多种usage格式：OpenAI(prompt_tokens/completion_tokens)、其他(input_tokens/output_tokens)
  const promptTokensRaw = usage?.prompt_tokens ?? usage?.input_tokens ?? 0;
  const completionTokensRaw = usage?.completion_tokens ?? usage?.output_tokens ?? 0;
  const totalTokens = usage?.total_tokens || (promptTokensRaw + completionTokensRaw);
  const seconds = Math.floor(elapsedMs / 1000);
  const minutes = Math.floor(seconds / 60);
  const remainSeconds = seconds % 60;
  const timeStr = minutes > 0 ? minutes + 'm ' + remainSeconds + 's' : remainSeconds + 's';

  bar.style.display = 'flex';
  bar.style.alignItems = 'center';
  bar.style.gap = '16px';
  bar.style.fontSize = '12px';
  bar.style.color = '#888';
  bar.style.userSelect = 'none';
  bar.style.position = 'relative';

  let html = '';
  // Tokens 统计（可点击/悬停显示明细）
  if (totalTokens > 0) {
    html += '<div class="token-stats-item" style="display:inline-flex;align-items:center;gap:4px;cursor:pointer;padding:2px 8px;border-radius:4px;transition:background 0.2s;">';
    html += '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 9h6M9 13h6M9 17h4"/></svg>';
    html += '<span>Tokens: <strong>' + totalTokens.toLocaleString() + '</strong></span>';
    html += '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>';
    html += '</div>';
  }
  // 耗时统计
  if (elapsedMs > 0) {
    html += '<div class="time-stats-item" style="display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:4px;">';
    html += '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>';
    html += '<span>耗时: <strong>' + timeStr + '</strong></span>';
    html += '</div>';
  }
  bar.innerHTML = html;

  // 明细弹窗容器
  let detailPopup = null;
  let hoverTimer = null;

  const showDetail = function() {
    if (detailPopup) return;
    if (!usage) return;

    const promptTokens = usage.prompt_tokens ?? usage.input_tokens ?? 0;
    const completionTokens = usage.completion_tokens ?? usage.output_tokens ?? 0;
    const cachedTokens = usage.prompt_tokens_details?.cached_tokens ?? usage.input_tokens_details?.cached_tokens ?? 0;
    const reasoningTokens = usage.completion_tokens_details?.reasoning_tokens ?? usage.output_tokens_details?.reasoning_tokens ?? 0;
    const cacheMissTokens = Math.max(0, promptTokens - cachedTokens);
    const replyTokens = Math.max(0, completionTokens - reasoningTokens);
    const cacheHitRate = promptTokens > 0 ? (cachedTokens / promptTokens * 100) : 0;

    // 使用项目统一的 .info-tip 样式（与温度提示相同）
    detailPopup = document.createElement('div');
    detailPopup.className = 'info-tip';
    detailPopup.style.cssText = 'position:absolute;z-index:99999;bottom:100%;left:0;margin-bottom:8px;min-width:260px;max-width:320px;pointer-events:auto;';
    let popupHtml = '<div class="tip-title">Token 消耗明细</div>';
    popupHtml += '<div class="tip-section">总计</div>';
    popupHtml += '<div class="tip-list">';
    popupHtml += '<div class="tip-item"><span class="tip-tag">总 Tokens</span><span class="tip-val default">' + totalTokens.toLocaleString() + '</span></div>';
    popupHtml += '</div>';
    popupHtml += '<div class="tip-section" style="margin-top:8px;">输入</div>';
    popupHtml += '<div class="tip-list">';
    popupHtml += '<div class="tip-item"><span class="tip-tag">输入总量</span><span class="tip-val">' + promptTokens.toLocaleString() + '</span></div>';
    popupHtml += '<div class="tip-item"><span class="tip-tag">缓存命中</span><span class="tip-val">' + cachedTokens.toLocaleString() + '</span></div>';
    popupHtml += '<div class="tip-item"><span class="tip-tag">缓存未命中</span><span class="tip-val">' + cacheMissTokens.toLocaleString() + '</span></div>';
    popupHtml += '</div>';
    popupHtml += '<div class="tip-section" style="margin-top:8px;">输出</div>';
    popupHtml += '<div class="tip-list">';
    popupHtml += '<div class="tip-item"><span class="tip-tag">输出总量</span><span class="tip-val">' + completionTokens.toLocaleString() + '</span></div>';
    popupHtml += '<div class="tip-item"><span class="tip-tag">思考过程</span><span class="tip-val">' + reasoningTokens.toLocaleString() + '</span></div>';
    popupHtml += '<div class="tip-item"><span class="tip-tag">回复内容</span><span class="tip-val">' + replyTokens.toLocaleString() + '</span></div>';
    popupHtml += '</div>';
    popupHtml += '<div class="tip-section" style="margin-top:8px;">缓存命中率</div>';
    popupHtml += '<div class="tip-list">';
    popupHtml += '<div class="tip-item"><span class="tip-tag">命中率</span><span class="tip-val default">' + cacheHitRate.toFixed(1) + '%</span></div>';
    popupHtml += '</div>';
    detailPopup.innerHTML = popupHtml;
    // 手动添加visible类以触发动画
    requestAnimationFrame(() => detailPopup.classList.add('visible'));

    bar.appendChild(detailPopup);
  };

  const hideDetail = function() {
    if (detailPopup) {
      detailPopup.remove();
      detailPopup = null;
    }
    if (hoverTimer) {
      clearTimeout(hoverTimer);
      hoverTimer = null;
    }
  };

  // 绑定 Tokens 项的点击和悬停事件
  const tokenItem = bar.querySelector('.token-stats-item');
  if (tokenItem) {
    tokenItem.addEventListener('click', function(e) {
      e.stopPropagation();
      if (detailPopup) {
        hideDetail();
      } else {
        showDetail();
      }
    });
    tokenItem.addEventListener('mouseenter', function() {
      hoverTimer = setTimeout(showDetail, 300);
    });
    tokenItem.addEventListener('mouseleave', function() {
      if (hoverTimer) {
        clearTimeout(hoverTimer);
        hoverTimer = null;
      }
      // 延迟隐藏，方便鼠标移动到弹窗
      setTimeout(function() {
        if (!detailPopup?.matches(':hover')) {
          hideDetail();
        }
      }, 200);
    });
    // 悬停效果
    tokenItem.addEventListener('mouseenter', function() {
      tokenItem.style.background = 'rgba(99,102,241,0.1)';
    });
    tokenItem.addEventListener('mouseleave', function() {
      tokenItem.style.background = 'transparent';
    });
  }

  // 点击其他地方关闭弹窗
  document.addEventListener('click', function(e) {
    if (detailPopup && !bar.contains(e.target)) {
      hideDetail();
    }
  });
}

function appendChatMessage(msg) {
  // 压缩摘要消息用独立的折叠卡片渲染，不参与普通气泡布局
  if (msg && msg.isSummary) { appendSummaryMessage(msg); return null; }
  const container = document.getElementById('chat-messages');
  const messageDiv = document.createElement('div');
  messageDiv.className = `chat-message ${msg.role}`;
  // 用户消息显示头像，AI消息不显示头像
  // 优先使用登录用户的真实头像，未登录/无头像时回退为默认 user 图标
  let avatarHtml = '';
  if (msg.role === 'user') {
    const curUser = window.AccountAPI?.getCurrentUser?.();
    const avatarUrl = curUser?.avatar_url;
    avatarHtml = avatarUrl
      ? `<div class="chat-avatar"><img src="${avatarUrl}" alt="avatar" onerror="this.remove()"></div>`
      : `<div class="chat-avatar"><span class="el-icon">${window.ElIcons.ICONS.user}</span></div>`;
  }
  messageDiv.innerHTML = `
    ${avatarHtml}
    <div style="flex:1;min-width:0;text-align:${msg.role === 'user' ? 'right' : 'left'};">
      <div class="chat-bubble" style="display:inline-block;text-align:left;"></div>
      <!-- 编辑区域（默认隐藏）- 气泡样式，inline-block与原气泡布局一致 -->
      <div class="message-edit-area" style="display:none;vertical-align:top;">
        <div style="display:inline-block;max-width:100%;text-align:right;">
          <div class="message-edit-bubble" style="display:inline-block;max-width:100%;background:transparent;border:1.5px solid var(--accent);border-radius:18px;border-bottom-right-radius:6px;box-shadow:0 0 12px var(--accent-glow),inset 0 0 8px rgba(79,195,247,0.05);padding:0;vertical-align:top;text-align:left;position:relative;overflow:hidden;">
            <textarea class="message-edit-textarea" style="width:100%;min-height:44px;padding:10px 14px;margin:0;background:transparent;color:var(--text-primary);border:none;outline:none;box-shadow:none;resize:none;font-size:14px;line-height:1.7;font-family:inherit;box-sizing:border-box;overflow:hidden;display:block;"></textarea>
          </div>
          <div style="display:flex;gap:8px;margin-top:8px;justify-content:flex-end;">
            <button class="message-edit-cancel" style="padding:6px 16px;background:var(--bg-tertiary);color:var(--accent);border:1px solid var(--border-color);border-radius:6px;cursor:pointer;font-size:13px;transition:all 0.2s;">取消</button>
            <button class="message-edit-send" style="padding:6px 16px;background:var(--bg-tertiary);color:var(--accent);border:1px solid var(--accent);border-radius:6px;cursor:pointer;font-size:13px;transition:all 0.2s;">发送</button>
          </div>
        </div>
      </div>
      <div class="message-time">${new Date(msg.time).toLocaleTimeString()}</div>
      <div class="token-stats-bar" style="display:none;margin-top:6px;"></div>
    </div>
  `;
    const bubble = messageDiv.querySelector('.chat-bubble');
  // 保存原始文本，用于双击编辑
  bubble.dataset.originalContent = msg.content || '';
  // AI消息使用Markdown渲染，用户消息保持纯文本
  if (msg.role === 'ai') {
    bubble.innerHTML = renderMarkdown(msg.content);
  } else {
    bubble.textContent = msg.content;
  }
  // 用户消息有附件时，显示文件图标标签
  if (msg.role === 'user' && msg.attachments && msg.attachments.length > 0) {
    const attachDiv = document.createElement('div');
    attachDiv.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;margin-top:8px;';
    msg.attachments.forEach(att => {
      const isDir = att.name && !att.name.includes('.');
      const icon = isDir ? window.ElIcons.ICONS.folder : window.ElIcons.ICONS.document;
      const tag = document.createElement('div');
      tag.style.cssText = 'display:inline-flex;align-items:center;gap:4px;padding:3px 10px;background:rgba(99,102,241,0.1);border:1px solid rgba(99,102,241,0.3);border-radius:12px;font-size:12px;cursor:default;';
      tag.title = att.path || '';
      tag.innerHTML = `<span>${icon}</span><span>${att.name}</span>`;
      attachDiv.appendChild(tag);
    });
    bubble.appendChild(attachDiv);
  }
  if (msg.role === 'user') {
    messageDiv.style.cursor = 'pointer';
    messageDiv.title = '双击编辑重发';
    messageDiv.addEventListener('dblclick', () => {
      const bubble = messageDiv.querySelector('.chat-bubble');
      const editArea = messageDiv.querySelector('.message-edit-area');
      const textarea = messageDiv.querySelector('.message-edit-textarea');
      const cancelBtn = messageDiv.querySelector('.message-edit-cancel');
      const sendBtn = messageDiv.querySelector('.message-edit-send');
      
      if (!editArea || !textarea) return;
      
      // 停止当前生成
      if (state.isStreaming && window.api.cancelChat) window.api.cancelChat();
      
      // 保存原始文本
      const originalText = bubble.dataset.originalContent || bubble.textContent;
      
      // 显示编辑区域，隐藏原消息气泡（使用inline-block保持布局一致）
      bubble.style.display = 'none';
      editArea.style.display = 'inline-block';
      textarea.value = originalText;
      
      // 自动调整高度函数（完全根据内容调整，无最大高度限制）
      const autoResize = () => {
        textarea.style.height = 'auto';
        textarea.style.height = textarea.scrollHeight + 'px';
      };
      
      // 自动调整高度并聚焦
      setTimeout(() => {
        autoResize();
        textarea.focus();
        textarea.setSelectionRange(textarea.value.length, textarea.value.length);
      }, 0);
      
      // 取消按钮：恢复原消息，不删除任何内容
      const cancelEdit = () => {
        editArea.style.display = 'none';
        bubble.style.display = 'inline-block';
        // 移除事件监听，避免重复绑定
        cancelBtn.removeEventListener('click', cancelEdit);
        sendBtn.removeEventListener('click', sendEdit);
        textarea.removeEventListener('keydown', handleKeydown);
      };
      
      // 发送按钮：删除该消息及之后的消息，重新发送
      const sendEdit = () => {
        const newContent = textarea.value.trim();
        if (!newContent) return;
        
        // 删除该消息及之后的所有消息
        const container = document.getElementById('chat-messages');
        let sibling = messageDiv;
        while (sibling) { const next = sibling.nextSibling; container.removeChild(sibling); sibling = next; }
        
        // 同步会话历史
        const conv = getActiveConversation();
        if (conv) {
          const idx = conv.messages.findIndex(m => m.time === msg.time && m.content === originalText);
          if (idx >= 0) conv.messages = conv.messages.slice(0, idx);
          state.chatHistory = conv.messages;
          saveConversations();
        }
        
        // 发送编辑后的内容
        const input = document.getElementById('chat-input');
        if (input) {
          input.value = newContent;
          sendChatMessage();
        }
      };
      
      // 键盘事件：Ctrl+Enter发送，Esc取消
      const handleKeydown = (e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          cancelEdit();
        } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          sendEdit();
        }
      };
      
      // 绑定事件
      cancelBtn.addEventListener('click', cancelEdit);
      sendBtn.addEventListener('click', sendEdit);
      textarea.addEventListener('keydown', handleKeydown);
      
      // 输入时自动调整高度（完全根据内容调整）
      textarea.addEventListener('input', autoResize);
    });
  }
  container.appendChild(messageDiv);
  container.scrollTop = container.scrollHeight;
  // 加载历史消息时恢复 Token 消耗统计栏渲染
  if (msg.role === 'ai' && (msg.usage || msg.elapsedMs > 0)) {
    setTimeout(() => renderTokenStatsBar(messageDiv, msg.usage, msg.elapsedMs), 0);
  }
  return messageDiv;
}

// Agent 消息渲染（支持思考过程折叠 + 工具调用展开）
function appendAgentMessage(msg) {
  const container = document.getElementById('chat-messages');
  const messageDiv = document.createElement('div');
  messageDiv.className = 'chat-message ai agent-message';
  // AI消息不显示头像
  messageDiv.innerHTML = `
    <div style="flex:1;min-width:0;text-align:left;">
      <div class="agent-reasoning-section" style="display:none;">
        <div class="agent-reasoning-header">
          <span class="reasoning-toggle">▶</span> 思考过程
        </div>
        <div class="agent-reasoning-content" style="display:none;"></div>
      </div>
      <div class="agent-tools-section"></div>
      <div class="chat-bubble agent-content-bubble" style="min-height:24px;display:inline-block;text-align:left;"><span class="loading-text">等待模型响应...</span></div>
      <div class="message-time">${new Date(msg.time).toLocaleTimeString()}</div>
      <div class="token-stats-bar" style="display:none;margin-top:6px;"></div>
    </div>
  `;
  // 思考过程折叠
  const header = messageDiv.querySelector('.agent-reasoning-header');
  const rContent = messageDiv.querySelector('.agent-reasoning-content');
  header.addEventListener('click', () => {
    const isOpen = rContent.style.display !== 'none';
    rContent.style.display = isOpen ? 'none' : 'block';
    header.querySelector('.reasoning-toggle').textContent = isOpen ? '▶' : '▼';
  });
  container.appendChild(messageDiv);
  container.scrollTop = container.scrollHeight;
  // 加载历史 Agent 消息时恢复 Token 消耗统计栏渲染
  if (msg.usage || msg.elapsedMs > 0) {
    setTimeout(() => renderTokenStatsBar(messageDiv, msg.usage, msg.elapsedMs), 0);
  }
  // 只有在新消息（非历史加载）时才设置 currentMsgEl
  if (state.agentState && state.agentState.currentMsgEl === null) {
    state.agentState.currentMsgEl = messageDiv;
  }
  return messageDiv;
}

// 追加 Agent 工具调用卡片
// 聊天区域自动滚动：只有用户在底部时才自动滚动，避免用户往上看时被强制拉回
function isChatAtBottom() {
  const el = document.getElementById('chat-messages');
  if (!el) return true;
  return el.scrollHeight - el.scrollTop - el.clientHeight < 60;
}
function scrollChatToBottomIfNeeded() {
  if (isChatAtBottom()) {
    const el = document.getElementById('chat-messages');
    if (el) el.scrollTop = el.scrollHeight;
  }
}

function appendAgentToolCard(toolName, args) {
  if (!state.agentState?.currentMsgEl) return;
  const section = state.agentState.currentMsgEl.querySelector('.agent-tools-section');
  const card = document.createElement('div');
  card.className = 'agent-tool-card';
  
  // 默认收起：只显示头部，参数和结果隐藏，点击头部展开/收起
  card.innerHTML = `
    <div class="tool-header" style="cursor:pointer;user-select:none;display:flex;align-items:center;gap:6px;">
      <span class="tool-toggle" style="display:inline-block;width:12px;text-align:center;font-size:10px;color:var(--text-secondary,#888);">▶</span>
      <span class="tool-icon" style="display:inline-flex;align-items:center;">${getToolIcon(toolName)}</span>
      <span class="tool-name">${toolLabel(toolName)}</span>
      <span class="tool-status">执行中...</span>
    </div>
    <div class="tool-args" style="display:none;margin-top:6px;padding:8px;background:var(--bg-tertiary,#252532);border-radius:6px;font-size:12px;font-family:monospace;white-space:pre-wrap;word-break:break-all;max-height:150px;overflow-y:auto;"></div>
    <div class="tool-result" style="display:none;margin-top:6px;padding:8px;background:var(--bg-tertiary,#252532);border-radius:6px;font-size:12px;font-family:monospace;white-space:pre-wrap;word-break:break-all;max-height:200px;overflow-y:auto;"></div>
  `;
  card.querySelector('.tool-args').textContent = JSON.stringify(args, null, 2);
  
  // 点击头部展开/收起
  const header = card.querySelector('.tool-header');
  const toggle = card.querySelector('.tool-toggle');
  const argsEl = card.querySelector('.tool-args');
  const resultEl = card.querySelector('.tool-result');
  let expanded = false;
  header.addEventListener('click', function() {
    expanded = !expanded;
    argsEl.style.display = expanded ? 'block' : 'none';
    // 结果只有在有内容时才显示
    if (expanded && resultEl.textContent.trim()) {
      resultEl.style.display = 'block';
    } else {
      resultEl.style.display = 'none';
    }
    toggle.textContent = expanded ? '▼' : '▶';
  });
  
  section.appendChild(card);
  scrollChatToBottomIfNeeded();
  return card;
}

// ==================== 待办清单卡片（需求整理 / 实现过程追踪） ====================
// 模型调 todo_write / todo_update 时不显示原始 JSON，而是画成一份可读的清单：
// 用户一眼能看到"目标是什么、做到第几步、每步的完成判据"，这就是需求确认与过程留痕。
const TODO_TOOLS = ['todo_write', 'todo_update', 'todo_read'];
const TODO_MARK = { completed: '✓', in_progress: '▶', pending: '○' };

function isTodoTool(name) { return TODO_TOOLS.includes(name); }

function todoText(key, fallback) {
  const v = window.t ? window.t(key) : null;
  return (v && v !== key) ? v : fallback;
}

/** 构建待办卡片 DOM。items 为空时不显示卡片（返回 null）。 */
function buildTodoCardEl(items, progress, title, opts = {}) {
  if (!Array.isArray(items) || !items.length) return null;
  const card = document.createElement('div');
  card.className = 'agent-todo-card';

  const head = document.createElement('div');
  head.className = 'todo-head';
  const label = document.createElement('span');
  label.className = 'todo-label';
  label.textContent = todoText('chat.todoTitle', '待办清单');
  head.appendChild(label);

  const prog = progress || { completed: 0, total: items.length, percent: 0 };
  const counter = document.createElement('span');
  counter.className = 'todo-counter';
  counter.textContent = prog.completed + '/' + prog.total;
  head.appendChild(counter);

  if (title) {
    const t = document.createElement('span');
    t.className = 'todo-goal';
    t.textContent = title;
    t.title = title;
    head.appendChild(t);
  }

  const clearBtn = document.createElement('button');
  clearBtn.className = 'todo-clear';
  clearBtn.type = 'button';
  clearBtn.textContent = '×';
  clearBtn.title = todoText('chat.todoClear', '清除待办清单');
  clearBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    clearActiveTodos();
  });
  head.appendChild(clearBtn);
  card.appendChild(head);

  const bar = document.createElement('div');
  bar.className = 'todo-bar';
  const fill = document.createElement('i');
  fill.style.width = Math.max(0, Math.min(100, prog.percent || 0)) + '%';
  bar.appendChild(fill);
  card.appendChild(bar);

  const list = document.createElement('ul');
  list.className = 'todo-list';
  for (const it of items) {
    const li = document.createElement('li');
    li.className = 'todo-item ' + (it.status || 'pending');
    const mk = document.createElement('span');
    mk.className = 'todo-mark';
    mk.textContent = TODO_MARK[it.status] || '○';
    // 手动兜底：AI 忘了标记时，用户可以自己点一下把这条划掉（状态写回主进程，两处卡片同步）
    mk.title = it.status === 'completed' ? '点击改回「待办」' : '点击标记为「已完成」';
    mk.addEventListener('click', (e) => { e.stopPropagation(); toggleTodoItem(it); });
    li.appendChild(mk);

    const body = document.createElement('div');
    body.className = 'todo-body';
    const txt = document.createElement('div');
    txt.className = 'todo-text';
    txt.textContent = it.text || '';
    body.appendChild(txt);
    if (it.done_when) {
      const dw = document.createElement('div');
      dw.className = 'todo-done-when';
      dw.textContent = todoText('chat.todoDoneWhen', '完成判据') + '：' + it.done_when;
      body.appendChild(dw);
    }
    if (it.note) {
      const nt = document.createElement('div');
      nt.className = 'todo-note';
      nt.textContent = '→ ' + it.note;
      body.appendChild(nt);
    }
    li.appendChild(body);
    list.appendChild(li);
  }
  card.appendChild(list);
  return card;
}

/** 在消息元素里插入或就地更新待办卡片（插在工具卡片之上，先看计划再看过程） */
function renderTodoCard(msgEl, result) {
  if (!msgEl) return null;
  let card = msgEl.querySelector('.agent-todo-card');
  const items = result && Array.isArray(result.items) ? result.items : null;

  // 结果还没回来 → 先占个位，让用户知道"正在整理需求"
  if (!items) {
    if (card) return card;
    card = document.createElement('div');
    card.className = 'agent-todo-card todo-loading';
    card.textContent = todoText('chat.todoPlanning', '正在整理需求…');
    const tools = msgEl.querySelector('.agent-tools-section');
    if (tools && tools.parentElement) tools.parentElement.insertBefore(card, tools);
    else msgEl.appendChild(card);
    return card;
  }

  const fresh = buildTodoCardEl(items, result.progress, result.title);
  if (!fresh) {
    // 清单被清空了
    if (card) card.remove();
    return null;
  }
  if (card && card.parentElement) card.parentElement.replaceChild(fresh, card);
  else {
    const tools = msgEl.querySelector('.agent-tools-section');
    if (tools && tools.parentElement) tools.parentElement.insertBefore(fresh, tools);
    else msgEl.appendChild(fresh);
  }
  scrollChatToBottomIfNeeded();
  return fresh;
}

/** 把最新清单存到会话对象上，切走再切回来还能看到 */
function persistActiveTodos(result) {
  if (!result || !Array.isArray(result.items)) return;
  const conv = state.conversations?.find(c => c.id === state.activeConversationId);
  if (!conv) return;
  conv.activeTodos = result.items;
  conv.activeTodoTitle = result.title || conv.activeTodoTitle || '';
  saveConversations();
}

/** 清除当前会话的待办（卡片上的 × 按钮） */
async function clearActiveTodos() {
  const conv = state.conversations?.find(c => c.id === state.activeConversationId);
  try {
    await window.api.todo.clear(state.activeConversationId);
  } catch (e) { /* 主进程没起来也不影响前端清理 */ }
  if (conv) {
    conv.activeTodos = [];
    conv.activeTodoTitle = '';
    saveConversations();
  }
  document.querySelectorAll('#chat-messages .agent-todo-card').forEach(el => el.remove());
  showToast('已清除待办清单', '', 'success');
}

function todoProgressOf(items) {
  const total = items.length;
  const completed = items.filter(i => i.status === 'completed').length;
  return { total, completed, inProgress: items.filter(i => i.status === 'in_progress').length, percent: total ? Math.round(completed / total * 100) : 0 };
}

/** 用户手动点掉一条（AI 忘了标记时的兜底）：写回主进程，并把聊天里所有卡片同步重画 */
async function toggleTodoItem(item) {
  const next = item.status === 'completed' ? 'pending' : 'completed';
  const conv = state.conversations?.find(c => c.id === state.activeConversationId);
  try {
    const r = await window.api.todo.update(state.activeConversationId, {
      id: item.id,
      status: next,
      ...(next === 'completed' ? { note: item.note || '用户手动标记完成' } : {})
    });
    if (!r || !r.success) {
      showToast('更新待办失败', (r && r.error) || '未知错误', 'error');
      return;
    }
    if (conv) {
      conv.activeTodos = r.items;
      saveConversations();
    }
    // 同一份清单可能同时存在于"消息里的卡片"和"会话恢复的卡片"，一起重画
    const title = conv?.activeTodoTitle || '';
    const progress = r.progress || todoProgressOf(r.items);
    document.querySelectorAll('#chat-messages .agent-todo-card').forEach(el => {
      const fresh = buildTodoCardEl(r.items, progress, title);
      if (fresh) el.parentElement.replaceChild(fresh, el);
      else el.remove();
    });
  } catch (e) {
    showToast('更新待办失败', String(e && e.message || e), 'error');
  }
}


// 指令意图 → 桌宠动作（与宠物的本地指令识别保持一致，统一走通用匹配模块）。
// 当用户的话是在指挥桌宠做动作时，返回对应语义分类名，供 petDoAction 调用，
// 避免龙虾只回一句"搞定"却没有任何实际行动。
// 覆盖文档十大固定分类：greet/dance/sleep/confuse/happy/shy/angry/sad/lazy/idle。
function detectPetAction(text) {
  if (!window.CommandMatch) return null;
  const hits = window.CommandMatch.get_hit_categories(text);
  if (hits.length) {
    // 优先返回非 idle 的分类，纯 idle 意图也允许（如"安静待着"）
    const nonIdle = hits.find(c => c !== 'idle');
    return nonIdle || hits[0];
  }
  // 兼容历史控制指令：醒来（文档十大分类无 wake，但唤醒是必要控制，非情绪分类）
  if (/(起床|醒来|醒醒|wake)/i.test(text || '')) return 'wake';
  return null;
}

async function sendChatMessage() {
  const input = document.getElementById('chat-input');
  const content = input.value.trim();
  if (!content || state.isStreaming || state.compressBusy) return; // 压缩进行中不接受新的发送

  // 如果没有活跃会话，自动创建
  if (!getActiveConversation()) {
    createNewConversation();
  }

  if (!state.activeProviderId) {
    const providers = state.cloudProviders.filter(p => p.enabled);
    if (providers.length === 0) {
      showToast('未配置AI模型', '请先在"AI配置"中添加AI模型服务', 'warning');
      switchTab('ai-config');
      return;
    } else {
      state.activeProviderId = providers[0].id;
      document.getElementById('active-provider').value = providers[0].id;
      syncAISettings();
      const ai = buildAIConfig();
      await window.api.setConfig({ ai });
      state.settings.ai = ai;
    }
  }

  // 先把用户消息投进会话并显示出来（压缩期间界面不停滞，压缩完成后自动继续把这轮喂给 AI）
  let aiContent = content;
  if (state.uploadedFiles && state.uploadedFiles.length > 0) {
    const fileList = state.uploadedFiles.map(f => `- ${f.name}（路径：${f.path}）`).join('\n');
    const fileNotice = `[用户上传了以下文件，请使用 read_file 工具读取文件内容后再回答：]\n${fileList}`;
    aiContent = content ? content + '\n\n' + fileNotice : fileNotice;
  }
  const userMsg = { role: 'user', content, time: Date.now(), aiContent, attachments: state.uploadedFiles?.map(f => ({name:f.name,size:f.size,path:f.path})) };
  const conv = getActiveConversation();
  conv.messages.push(userMsg);
  // 清空已上传文件
  state.uploadedFiles = [];
  renderUploadedFiles();
  state.chatHistory = conv.messages; // 保持兼容
  appendChatMessage(userMsg);
  autoTitleConversation(conv, content);
  conv.updatedAt = Date.now();

  // 上下文接近上限 → 压缩历史（用户这条消息属于"最近若干条"，不会被压进摘要）
  // 压缩结束后流程自动继续：下面正常构建请求并发送，不需要用户再点一次
  if (isAutoCompressEnabled()) {
    const preUsage = computeContextUsage(conv);
    if (preUsage.percent >= AUTO_COMPRESS_THRESHOLD) {
      const sendBtn = document.getElementById('btn-send');
      if (sendBtn) sendBtn.disabled = true;   // 压缩期间先锁住发送
      const compressRes = await compressConversation({ auto: true });
      if (sendBtn) sendBtn.disabled = false;
      // 压缩失败不再静默：提示用户，后续请求仍按预算硬性裁剪（buildOutgoingMessages 保证不越过窗口）
      if (compressRes && !compressRes.success && compressRes.error &&
          compressRes.error !== 'too_few_messages' && compressRes.error !== 'busy') {
        showToast('自动压缩失败', compressRes.error || '未知错误', 'warning');
      }
    }
  }
  input.value = '';
  input.style.height = 'auto';

  // 如果用户的话是在指挥桌宠做动作（如"睡觉""跳舞"），立刻让龙虾执行对应动作，
  // 而不是只在聊天里回一句"搞定"却不操作。
  const petAct = detectPetAction(content);
  if (petAct && window.api.petDoAction) {
    window.api.petDoAction(petAct).catch(() => {});
  }

  state.isStreaming = true;
  state.activeRequestConversationId = conv.id; // 记录当前请求所属的会话ID
  document.getElementById('btn-send').disabled = true;
  document.getElementById('btn-send').style.display = 'none';
  document.getElementById('btn-stop').style.display = '';

  try {
    const useAgent = document.getElementById('agent-mode').checked;
    const useStream = document.getElementById('stream-mode').checked;
    // 按上下文预算挑选历史（替代原先写死的"最近 10 条"）；摘要消息始终带上
    const outgoing = buildOutgoingMessages(conv, { agent: useAgent });
    const msgs = outgoing.messages;
    state.lastSentEstimate = {
      convId: conv.id,
      tokens: outgoing.stats.used,
      historyTokens: outgoing.stats.historyTokens,
      isAgent: useAgent,
      at: Date.now()
    };
    if (outgoing.stats.droppedFromWindow > 0) {
      console.log('[Context] 本次请求省略较早消息', outgoing.stats.droppedFromWindow,
        '条；实际发送', msgs.length, '条，估算', outgoing.stats.used, 'tokens');
    }
    if (outgoing.stats.overLimit) {
      // 极端兜底：估算仍超窗口（预算过小），提示用户，避免发送必然失败的请求
      console.warn('[Context] 请求体估算仍超出窗口（overLimit），已按最小预算截断');
      showToast('消息超出上下文窗口', '当前会话内容过多，已截断发送；建议新建会话后重试', 'warning');
    }

    // 非 Agent 模式时清理旧的 agent 状态，避免拦截流式事件
    if (!useAgent) state.agentState = null;

    if (useAgent) {
      // Agent 模式：支持思考过程 + 工具调用
      state.agentState = { reasoning: '', content: '', tools: [], currentMsgEl: null, done: false, startTime: Date.now() };
      // 输入框在思考过程中保持可见，不隐藏（用户可能需要随时输入新消息或停止对话）
      // 创建 AI 消息占位
      const aiMsg = { role: 'ai', content: '', time: Date.now(), isAgent: true };
      conv.messages.push(aiMsg);
      state.chatHistory = conv.messages;
      appendAgentMessage(aiMsg);
      // 读取 Agent 设置
      const thinkMode = document.getElementById('agent-think-mode')?.checked || false;
      const enabledTools = Array.from(document.querySelectorAll('.agent-tool-check:checked')).map(cb => cb.value);
      const toolConfirm = document.getElementById('agent-tool-confirm')?.checked !== false;
      const result = await window.api.agentChat({
        messages: msgs,
        conversationId: conv.id,   // 待办清单按会话隔离，靠它定位
        providerId: state.activeProviderId,
        thinkMode,
        enabledTools,
        autoAuthorize: !toolConfirm,
        roleId: state.currentRoleId,
        workdir: state.workdir || null,
        contextWindow: getContextWindow(getActiveProviderConfig())
      });
      if (!result || !result.success) {
        showToast('Agent响应失败', result?.error || '未知错误', 'error');
        // 响应失败时显示输入框
        const inputArea = document.querySelector('.chat-input-area');
        if (inputArea) inputArea.style.display = '';
      }
      aiMsg.content = (state.agentState?.content) || result?.content || '（无响应）';
      aiMsg.reasoning = state.agentState?.reasoning;
      aiMsg.tools = state.agentState?.tools;
      // 保存 Token 消耗信息（从 agent-done 事件中保存的临时变量读取）
      if (pendingAgentUsage || pendingAgentElapsedMs > 0) {
        aiMsg.usage = pendingAgentUsage;
        aiMsg.elapsedMs = pendingAgentElapsedMs;
        // 保存后清空临时变量
        pendingAgentUsage = null;
        pendingAgentElapsedMs = 0;
      }
      saveConversations();
      renderConversationList();
    } else {
      // 先创建占位消息，显示等待状态
      const aiMsg = { role: 'ai', content: '', time: Date.now() };
      conv.messages.push(aiMsg);
      state.chatHistory = conv.messages;
      const msgEl = appendChatMessage(aiMsg);
      const bubble = msgEl.querySelector('.chat-bubble');
      bubble.innerHTML = '<span style="color:#888;font-style:italic;">等待模型响应...</span>';
      state.currentAIMsgEl = msgEl;
      state.currentAIContent = '';

      // 记录请求开始时间，用于计算耗时
        const requestStartTime = Date.now();
        const result = useStream
        ? await window.api.streamChat({
            messages: msgs,
            providerId: state.activeProviderId,
            workdir: state.workdir || null
          })
        : await window.api.chat({
            messages: msgs,
            providerId: state.activeProviderId,
            workdir: state.workdir || null
          });

      state.currentAIMsgEl = null;
      if (result.success) {
        if (result.providerId && result.providerId !== state.activeProviderId) {
          state.activeProviderId = result.providerId;
          updateActiveProviderDisplay();
        }
        aiMsg.content = state.currentAIContent || result.content || result.data?.choices?.[0]?.message?.content || '（无响应）';
        // 保存原始文本，用于双击编辑
        bubble.dataset.originalContent = aiMsg.content;
        // 使用Markdown渲染
        bubble.innerHTML = renderMarkdown(aiMsg.content);
        // 保存并渲染 Token 消耗统计栏
        const usage = result.usage || result.data?.usage;
        const elapsedMs = Date.now() - requestStartTime;
        if (usage || elapsedMs > 0) {
          aiMsg.usage = usage;
          aiMsg.elapsedMs = elapsedMs;
          renderTokenStatsBar(msgEl, usage, elapsedMs);
        }
        // 用真实 prompt_tokens 校准容量估算（Agent 模式中间插入的工具消息前端看不到，不参与校准）
        updateContextCalibration(conv, usage, useAgent);
        conv.updatedAt = Date.now();
        saveConversations();
        renderConversationList();
      } else {
        bubble.textContent = '响应失败: ' + (result.error || '未知错误');
        bubble.style.color = '#ef4444';
        showToast('AI响应失败', result.error || '未知错误', 'error');
      }
    }
  } catch (err) {
    showToast('请求失败', err.message, 'error');
  } finally {
    state.isStreaming = false;
    document.getElementById('btn-send').disabled = false;
    document.getElementById('btn-send').style.display = '';
    document.getElementById('btn-stop').style.display = 'none';
    renderContextBar();
  }
}

// 用上一次请求的真实 prompt_tokens 校准 token 估算偏差，让容量条更接近真实占用
function updateContextCalibration(conv, usage, isAgent) {
  const anchor = state.lastSentEstimate;
  const promptTokens = usage?.prompt_tokens ?? usage?.input_tokens ?? 0;
  if (isAgent || !anchor || !conv || anchor.convId !== conv.id || !(promptTokens > 0) || !(anchor.tokens > 0)) return;
  const factor = Math.min(3, Math.max(0.5, promptTokens / anchor.tokens));
  conv.ctxCalib = { factor, promptTokens, at: Date.now() };
  console.log('[Context] 校准系数 =', factor.toFixed(3), '（实际输入', promptTokens, '/ 估算', anchor.tokens, '）');
}

// ==================== 语音识别（按住录音，松开识别） ====================
// 使用主进程 WaveIn API 采集音频（完全避免渲染进程崩溃）
// 渲染进程只负责触发和显示结果，完全不接触音频流
let voiceRec = null; // { recording, startTime, btn }

function startVoiceCapture() {
  console.log('[Voice] === startVoiceCapture 开始 ===');
  try {
    if (voiceRec && voiceRec.recording) {
      console.log('[Voice] 已在录音中，跳过');
      return;
    }
    
    // 检查语音识别接口
    if (!window.api || !window.api.speechRecordStart) {
      console.log('[Voice] 语音录制接口不可用');
      try { showToast('语音不可用', '当前环境不支持语音录制', 'warning'); } catch(e) {}
      return;
    }

    console.log('[Voice] 开始初始化...');
    
    // 获取按钮元素并添加recording类
    let btn = null;
    try {
      btn = document.getElementById('btn-voice');
      if (btn) btn.classList.add('recording');
      console.log('[Voice] 按钮状态已更新');
    } catch(e) {
      console.error('[Voice] 更新按钮状态失败:', e);
    }
    
    // 初始化voiceRec
    voiceRec = { recording: true, startTime: Date.now(), btn: btn };
    console.log('[Voice] voiceRec 初始化完成');

    // 调用主进程开始录制（主进程采集音频，渲染进程不接触音频流）
    console.log('[Voice] 调用主进程开始录制...');
    window.api.speechRecordStart()
      .then((result) => {
        console.log('[Voice] 主进程录制启动结果:', result);
        
        if (!result.success) {
          console.log('[Voice] 录制启动失败:', result.error);
          voiceRec.recording = false;
          if (btn) try { btn.classList.remove('recording'); } catch(e) {}
          voiceRec = null;
          try { showToast('录音失败', result.error, 'error'); } catch(e) {}
          return;
        }
        
        console.log('[Voice] 录制已开始');
        try { showToast('开始录音', '按住说话，松开自动识别', 'info'); } catch(e) {}
      })
      .catch((err) => {
        console.error('[Voice] 录制启动异常:', err);
        if (voiceRec) {
          voiceRec.recording = false;
          if (btn) try { btn.classList.remove('recording'); } catch(e) {}
          voiceRec = null;
        }
        try { showToast('录音失败', (err && err.message) ? err.message : '未知错误', 'error'); } catch(e) {}
      });
    
    console.log('[Voice] === startVoiceCapture 结束 ===');
  } catch(err) {
    console.error('[Voice] startVoiceCapture顶层异常:', err);
    voiceRec = null;
  }
}

function stopVoiceCapture() {
  console.log('[Voice] === stopVoiceCapture 开始 ===');
  if (!voiceRec || !voiceRec.recording) {
    console.log('[Voice] 未在录音中，跳过');
    return;
  }
  
  console.log('[Voice] 停止录音...');
  voiceRec.recording = false;
  
  const btn = voiceRec.btn;
  try { if (btn) btn.classList.remove('recording'); } catch(e) {}
  
  const recData = voiceRec;
  voiceRec = null;
  
  // 调用主进程停止录制并获取WAV数据
  console.log('[Voice] 调用主进程停止录制...');
  window.api.speechRecordStop()
    .then(async (result) => {
      console.log('[Voice] 主进程录制停止结果:', result.success ? '成功，WAV大小: ' + (result.wavBuffer ? result.wavBuffer.byteLength : 0) + ' bytes' : '失败: ' + result.error);
      
      if (!result.success) {
        console.log('[Voice] 录制停止失败:', result.error);
        if (result.error && result.error !== '未采集到音频数据') {
          try { showToast('录音失败', result.error, 'error'); } catch(e) {}
        } else {
          try { showToast('录音结束', '未采集到音频', 'info'); } catch(e) {}
        }
        return;
      }
      
      if (!result.wavBuffer || result.wavBuffer.byteLength === 0) {
        console.log('[Voice] 未录制到音频数据');
        try { showToast('录音结束', '未采集到音频', 'info'); } catch(e) {}
        return;
      }
      
      // 检查语音识别接口
      if (!window.api || !window.api.speechRecognizeWav) {
        console.log('[Voice] 语音识别接口不可用');
        try { showToast('识别失败', '语音识别接口不可用', 'error'); } catch(e) {}
        return;
      }
      
      // 调用主进程 SAPI 识别（WAV文件输入）
      console.log('[Voice] 调用主进程语音识别（WAV）...');
      try { showToast('识别中', '正在识别语音...', 'info'); } catch(e) {}
      
      try {
        const recognizeResult = await window.api.speechRecognizeWav(result.wavBuffer);
        console.log('[Voice] 识别结果:', recognizeResult);
        
        if (recognizeResult.success && recognizeResult.text) {
          console.log('[Voice] 识别成功:', recognizeResult.text);
          try {
            document.getElementById('chat-input').value = recognizeResult.text;
            sendChatMessage();
          } catch(e) {
            console.error('[Voice] 发送消息失败:', e);
          }
        } else if (recognizeResult.error && recognizeResult.error !== 'cancelled') {
          console.log('[Voice] 识别失败:', recognizeResult.error);
          try { showToast('识别失败', recognizeResult.error, 'error'); } catch(e) {}
        } else {
          console.log('[Voice] 未识别到语音内容');
          try { showToast('录音结束', '未识别到语音内容', 'info'); } catch(e) {}
        }
      } catch(err) {
        console.error('[Voice] 识别异常:', err);
        try { showToast('识别失败', (err && err.message) ? err.message : '未知错误', 'error'); } catch(e) {}
      }
    })
    .catch((err) => {
      console.error('[Voice] 停止录制异常:', err);
      try { showToast('录音失败', (err && err.message) ? err.message : '未知错误', 'error'); } catch(e) {}
    });
  
  console.log('[Voice] === stopVoiceCapture 结束（等待主进程处理）===');
}

// ==================== 模型管理 ====================
function renderModelList() {
  const listEl = document.getElementById('model-list');
  listEl.innerHTML = '';
  updateModelStatusBar();

  // 默认皮肤条目（始终显示在最前面）
  const defaultItem = document.createElement('div');
  defaultItem.className = 'model-item' + (!state.currentModelId ? ' selected' : '');
  defaultItem.innerHTML = `
    <div class="model-thumbnail">
      <div class="model-thumb-wrap default-lobster-thumb"><img src="../../assets/icons/pet-lingxi-512.png" alt="灵汐" style="width:100%;height:100%;object-fit:contain;"></div>
    </div>
    <div class="model-info">
      <div class="model-name">灵汐</div>
      <div class="model-meta">
        <span>内置形象</span>
        <span>浮灵饰界</span>
      </div>
    </div>
    <div class="model-actions">
      ${state.currentModelId ? `<button class="btn btn-sm btn-primary" data-action="apply-default">应用</button>` : '<span class="status-indicator connected"><span class="indicator-dot"></span>使用中</span>'}
      <button class="btn btn-sm" data-action="info-default">详情</button>
    </div>
  `;
  defaultItem.addEventListener('click', (e) => {
    const action = e.target.closest('[data-action]')?.dataset.action;
    if (action === 'apply-default') {
      restoreDefaultModel();
    } else if (action === 'info-default') {
      showDefaultModelInfo();
    }
  });
  listEl.appendChild(defaultItem);

  if (!state.models || state.models.length === 0) {
    listEl.appendChild(createEmptyState());
    return;
  }

  state.models.forEach(model => {
    const item = document.createElement('div');
    item.className = 'model-item' + (model.id === state.currentModelId ? ' selected' : '');
    const isBongo = model.isBongocat === true;
    item.innerHTML = `
      <div class="model-thumbnail">${getModelIcon(model.format, model.thumbnail)}</div>
      <div class="model-info">
        <div class="model-name">
          ${escapeHtml(model.name)}
          ${isBongo ? '<span class="bongocat-badge">BongoCat</span>' : ''}
        </div>
        <div class="model-meta">
          <span>${model.format || 'Live2D'}</span>
          <span>${formatSize(model.size)}</span>
          <span>${model.importedAt ? new Date(model.importedAt).toLocaleDateString() : ''}</span>
        </div>
      </div>
      <div class="model-actions">
        ${model.id !== state.currentModelId ? `<button class="btn btn-sm btn-primary" data-action="apply">应用</button>` : '<span class="status-indicator connected"><span class="indicator-dot"></span>使用中</span>'}
        <button class="btn btn-sm" data-action="info">详情</button>
        <button class="btn btn-sm btn-danger" data-action="delete">删除</button>
      </div>
    `;

    item.addEventListener('click', (e) => {
      const action = e.target.closest('[data-action]')?.dataset.action;
      if (action === 'apply') {
        applyModel(model.id);
      } else if (action === 'info') {
        showModelInfo(model);
      } else if (action === 'delete') {
        deleteModel(model);
      } else {
        showModelInfo(model);
      }
    });

    listEl.appendChild(item);
  });
  // 异步加载模型图标（替换默认占位为真实 SVG）
  if (window.ModelIcons && window.ModelIcons.updateIconsInContainer) {
    setTimeout(() => window.ModelIcons.updateIconsInContainer(listEl), 50);
  }


  // 刷新BongoCat模型下拉菜单
  refreshBongocatModelSelect();
  // 异步加载模型缩略图（IPC 读取转 base64）
  loadModelThumbnails();
}

async function importModelFile() {
  const paths = await window.api.selectFiles({
    filters: [
      { name: 'Live2D / MMD 模型', extensions: ['json', 'pmx', 'pmd'] },
      { name: '所有文件', extensions: ['*'] }
    ]
  });
  if (!paths || paths.length === 0) return;

  const path = paths[0];
  showToast('正在导入模型...', path, 'info');

  const result = await window.api.importModel(path);
  if (result.success) {
    state.models = await window.api.listModels();
    renderModelList();
    const count = result.count || 1;
    if (count > 1) {
      showToast('导入成功', `共导入 ${count} 个模型`, 'success');
    } else {
      showToast('导入成功', `${result.data.name} 已导入`, 'success');
    }
  } else {
    showToast('导入失败', result.error, 'error');
  }
}

async function importModelDirectory() {
  const dirs = await window.api.selectDirectory();
  if (!dirs || dirs.length === 0) return;

  const dirPath = dirs[0];
  showToast('正在导入模型目录...', dirPath, 'info');

  const result = await window.api.importModel(dirPath);
  if (result.success) {
    state.models = await window.api.listModels();
    renderModelList();
    const count = result.count || 1;
    if (count > 1) {
      showToast('导入成功', `共从目录导入 ${count} 个模型`, 'success');
    } else {
      showToast('导入成功', `${result.data.name} 已导入`, 'success');
    }
  } else {
    showToast('导入失败', result.error, 'error');
  }
}

// ==================== BongoCat 键盘猫专用 ====================
async function setBongocatPath() {
  const current = await window.api.getBongocatModel();
  const input = window.prompt('输入 BongoCat 模型 .model3.json 文件的完整路径：', current || '');
  if (input === null) return;
  const result = await window.api.setBongocatModel(input.trim());
  if (result && result.success) {
    showToast('路径已更新', input.trim(), 'success');
    updateBongocatStatus();
  } else {
    showToast('设置失败', result?.error || '路径无效', 'error');
  }
}

async function launchBongocatWindow() {
  // 优先使用下拉菜单中选中的模型
  const selectEl = document.getElementById('bongocat-model-select');
  let modelPath = selectEl && selectEl.value ? selectEl.value : null;

  // 如果下拉菜单没有选中，使用配置的模型路径
  if (!modelPath) {
    modelPath = await window.api.getBongocatModel();
  }

  if (!modelPath) {
    showToast('未选择模型', '请先在下拉菜单中选择已导入的BongoCat模型', 'warning');
    return;
  }
  // 验证文件存在
  const exists = await window.api.fileExists(modelPath);
  if (!exists) {
    showToast('模型文件不存在', modelPath, 'error');
    return;
  }
  // 保存到配置
  await window.api.setBongocatModel(modelPath);
  const result = await window.api.launchBongocat(modelPath);
  if (result && result.success) {
    showToast('BongoCat 已启动', '键盘猫模式已激活，全局键盘响应已开启', 'success');
  } else {
    showToast('启动失败', result?.error || '未知错误', 'error');
  }
}

// 填充BongoCat模型下拉菜单（从已导入模型中筛选isBongocat的模型）
function refreshBongocatModelSelect() {
  const selectEl = document.getElementById('bongocat-model-select');
  if (!selectEl) return;
  // 保留默认选项
  selectEl.innerHTML = '<option value="">-- 请选择已导入的BongoCat模型 --</option>';
  if (!state.models || state.models.length === 0) return;
  let hasBongo = false;
  state.models.forEach(model => {
    if (model.isBongocat === true) {
      hasBongo = true;
      const option = document.createElement('option');
      option.value = model.modelFile || model.path || '';
      option.textContent = model.name + (model.format ? ' (' + model.format + ')' : '');
      selectEl.appendChild(option);
    }
  });
  if (!hasBongo) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = '-- 暂无BongoCat模型，请先导入 --';
    option.disabled = true;
    selectEl.appendChild(option);
  }
}

async function updateBongocatStatus() {
  const statusEl = document.getElementById('bongocat-status');
  if (!statusEl) return;
  try {
    const modelPath = await window.api.getBongocatModel();
    if (modelPath) {
      const exists = await window.api.fileExists(modelPath);
      const modelDir = window.api.path.dirname(modelPath);
      const hasKeys = await window.api.fileExists(modelDir + '/resources/left-keys');
      statusEl.innerHTML = `
        <div style="color:#81c784;">✓ 已配置模型路径</div>
        <div style="margin-top:4px; word-break:break-all;">${modelPath}</div>
        <div style="margin-top:4px; font-size:11px;">
          ${exists ? '<span style="color:#81c784;">✓ 文件存在</span>' : '<span style="color:#ef5350;">✗ 文件不存在</span>'}
          ${hasKeys ? ' · <span style="color:#81c784;">✓ 含按键图片</span>' : ' · <span style="color:#ffb74d;">⚠ 无按键图片</span>'}
        </div>`;
    } else {
      statusEl.innerHTML = '未配置 BongoCat 模型路径。支持含 <code style="color:#4fc3f7;">resources/left-keys/</code> 按键图片的 Live2D Cubism3/4 模型。';
    }
  } catch(e) {
    statusEl.textContent = '状态读取失败: ' + e.message;
  }
}

async function applyModel(modelId) {
  const result = await window.api.setCurrentModel(modelId);
  if (result) {
    state.currentModelId = modelId;
    renderModelList();
  }
}

async function restoreDefaultModel() {
  const result = await window.api.setCurrentModel(null);
  if (result) {
    state.currentModelId = null;
    renderModelList();
  }
}

function showDefaultModelInfo() {
  const panel = document.getElementById('model-info-panel');
  panel.innerHTML = `
    <div class="model-detail-section">
      <div class="model-detail-icon default-lobster-detail"><img src="../../assets/icons/pet-lingxi-512.png" alt="灵汐" style="width:100%;height:100%;object-fit:contain;"></div>
      <h3 class="model-detail-title">灵汐</h3>
    </div>
    <div class="model-detail-section">
      <div class="detail-row"><span class="label">类型</span><span>内置形象</span></div>
      <div class="detail-row"><span class="label">来源</span><span>浮灵饰界</span></div>
      <div class="detail-row"><span class="label">描述</span><span>应用内置的默认灵汐形象，无需加载外部模型</span></div>
    </div>
    <div class="model-detail-actions">
      <button class="btn btn-primary" id="btn-apply-default">${!state.currentModelId ? '当前使用中' : '应用此模型'}</button>
    </div>
  `;
  document.getElementById('btn-apply-default')?.addEventListener('click', () => {
    if (state.currentModelId) restoreDefaultModel();
  });
}

async function deleteModel(model) {
  const confirmed = await showConfirm({
    type: 'warning',
    title: '删除模型',
    message: `确定要删除模型「${model.name}」吗？`,
    detail: '此操作不可恢复，模型文件将被永久删除。'
  });

  if (confirmed) {
    const result = await window.api.deleteModel(model.id);
    if (result.success) {
      state.models = await window.api.listModels();
      renderModelList();
      showToast('删除成功', '', 'success');
    } else {
      showToast('删除失败', result.error, 'error');
    }
  }
}

async function showModelInfo(model) {
  currentShownModel = model;
  const panel = document.getElementById('model-info-panel');
  const t = window.I18N?.t || ((k) => k);

  // 自动重新扫描缩略图：优先识别模型目录中的 GIF 动图
  // 这样已导入的旧模型（静态缩略图）也能自动刷新为 GIF 动图预览
  try {
    const res = await window.api.rescanThumbnail(model.id);
    if (res && res.success && res.data && res.data.thumbnail !== model.thumbnail) {
      model.thumbnail = res.data.thumbnail;
      // 同步更新 state.models 中的缓存
      const cached = state.models.find(m => m.id === model.id);
      if (cached) cached.thumbnail = model.thumbnail;
      renderModelList();
    }
  } catch (e) { /* 忽略，回退到原缩略图 */ }

  const thumbHtml = model.thumbnail
    ? `<div id="model-edit-thumb-wrap" data-thumb="${model.thumbnail.replace(/"/g, '&quot;')}">${window.ElIcons.getIcon('model')}</div>`
    : `<div class="model-edit-thumb-placeholder"><span class="el-icon">${window.ElIcons.getIcon('modelFile')}</span></div>`;

  const isCurrent = model.id === state.currentModelId;
  const isMMD = (model.type === 'MMD' || (model.format || '').toUpperCase().includes('MMD'));
  const isBongocat = model.isBongocat === true;

  panel.innerHTML = `
    <div class="model-detail-section model-edit-head">
      <div class="model-edit-thumb" id="model-edit-thumb">
        ${thumbHtml}
      </div>
    </div>

    ${isBongocat ? `
    <div class="bongocat-detail-section">
      <div class="bongocat-detail-title">BongoCat 键盘猫模型</div>
      <div class="bongocat-detail-desc">
        此模型含键盘按键图片和专用参数。点击「应用此模型」后自动启用<strong class="bongocat-highlight">全局键盘响应</strong>（窗口失焦也能打字），模型原地响应键盘和鼠标，无需额外操作。
      </div>
    </div>
    ` : ''}

    <div class="model-detail-section">
      <div class="modal-form-group">
        <label>${t('models.editName')}</label>
        <input type="text" id="input-edit-name" value="${escapeHtml(model.name)}" maxlength="50">
      </div>
      <div class="modal-form-group">
        <label>${t('models.editDesc')}</label>
        <textarea id="input-edit-desc" rows="3" placeholder="${t('models.editDescPlaceholder')}">${escapeHtml(model.description || '')}</textarea>
      </div>
    </div>

    <div class="model-detail-section">
      <div class="detail-row"><span class="label">${t('models.format')}</span><span>${model.format || '-'}</span></div>
      <div class="detail-row"><span class="label">${t('models.type')}</span><span>${model.type || '-'}${isBongocat ? ' BongoCat' : ''}</span></div>
      <div class="detail-row"><span class="label">${t('models.size')}</span><span>${formatSize(model.size)}</span></div>
      <div class="detail-row"><span class="label">${t('models.version')}</span><span>${model.version || '-'}</span></div>
      <div class="detail-row"><span class="label">${t('models.importedAt')}</span><span>${model.importedAt ? new Date(model.importedAt).toLocaleString() : '-'}</span></div>
    </div>

    <div class="model-detail-section" id="model-actions-section">
      ${isMMD
        ? `<div class="detail-loading">${t('models.loading') || '加载动作中...'}</div>`
        : `<div class="ae-note">${t('actions.mmdOnly')}</div>`}
    </div>

    <div class="model-detail-actions model-edit-actions">
      <button class="btn btn-primary" id="btn-save-model">${t('models.save')}</button>
      <button class="btn ${isCurrent ? '' : 'btn-primary'}" id="btn-apply-model" ${isCurrent ? 'disabled' : ''}>${isCurrent ? t('models.inUse') : t('models.apply')}</button>
      <button class="btn btn-danger" id="btn-delete-model">${t('models.delete')}</button>
    </div>
  `;

  document.getElementById('btn-save-model').addEventListener('click', () => saveModelEdits(model));
  if (!isCurrent) {
    document.getElementById('btn-apply-model').addEventListener('click', () => applyModel(model.id));
  }
  document.getElementById('btn-delete-model').addEventListener('click', () => deleteModel(model));

  if (isMMD) loadModelActionsSection(model);
  // 异步加载详情页缩略图
  if (model.thumbnail) {
    (async () => {
      try {
        const result = await window.api.readFile({ path: model.thumbnail, encoding: 'base64' });
        const wrap = document.getElementById('model-edit-thumb-wrap');
        if (!wrap) return;
        if (result && result.success && result.data) {
          const ext = (model.thumbnail.split('.').pop() || 'png').toLowerCase();
          const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : 'image/png';
          wrap.innerHTML = `<img class="model-edit-thumb-img" src="data:${mime};base64,${result.data}" alt="">`;
        } else {
          wrap.innerHTML = `<div class="model-edit-thumb-placeholder"><span class="el-icon">${window.ElIcons.getIcon('modelFile')}</span></div>`;
        }
      } catch (e) {}
    })();
  }
}

// ==================== 动作可视化编辑（每模型独立 actions.json）====================
// 显示在「模型管理」详情面板里：列出内置 + 自定义动作，设置待机动作，
// 编辑/新建关键帧动作（含 AI 生成、预览、保存并命名）、设置相关动作。
const BUILTIN_ACTIONS = [
  { key: 'turn', label: '转身' }, { key: 'turn_away', label: '背过身' },
  { key: 'nod', label: '点头' }, { key: 'shake', label: '摇头' }, { key: 'bow', label: '鞠躬' },
  { key: 'wave', label: '招手' }, { key: 'jump', label: '跳跃' }, { key: 'dance', label: '跳舞' },
  { key: 'squat', label: '蹲下' }, { key: 'sit', label: '坐下' }, { key: 'stand', label: '站起来' },
  { key: 'stretch', label: '伸懒腰' }, { key: 'think', label: '思考' }, { key: 'shy', label: '害羞' },
  { key: 'clap', label: '鼓掌' }, { key: 'point', label: '指向' }, { key: 'yawn', label: '打哈欠' },
  { key: 'cross', label: '叉腰' }
];
const ACTION_BONES = [
  ['head', '头'], ['neck', '颈'], ['upperBody', '上半身'], ['upperBody2', '上半身2'], ['lowerBody', '下半身'],
  ['lShoulder', '左肩'], ['lArm', '左大臂'], ['lElbow', '左肘'], ['lWrist', '左手腕'],
  ['rShoulder', '右肩'], ['rArm', '右大臂'], ['rElbow', '右肘'], ['rWrist', '右手腕'],
  ['lLeg', '左腿'], ['lKnee', '左膝'], ['lAnkle', '左踝'],
  ['rLeg', '右腿'], ['rKnee', '右膝'], ['rAnkle', '右踝']
];
const ACTION_MORPHS = [
  ['happy', '开心'], ['sad', '悲伤'], ['angry', '生气'], ['surprise', '惊讶'],
  ['shy', '害羞'], ['think', '思考'], ['confuse', '困惑'], ['greet', '问候'], ['love', '喜爱'], ['sleepy', '困倦']
];
// 中文骨骼名 → 逻辑键（容错 AI 可能用中文命名）
const BONE_ALIAS = {
  '头': 'head', '头部': 'head', '脑袋': 'head', '脖子': 'neck', '颈部': 'neck', '颈': 'neck',
  '上半身': 'upperBody', '上半身2': 'upperBody2', '胸': 'upperBody2', '胸口': 'upperBody2', '躯干': 'upperBody',
  '下半身': 'lowerBody', '腰': 'lowerBody', '腰部': 'lowerBody', '髋': 'lowerBody', '胯': 'lowerBody',
  '左肩': 'lShoulder', '左大臂': 'lArm', '左臂': 'lArm', '左上臂': 'lArm', '左小臂': 'lElbow', '左前臂': 'lElbow', '左肘': 'lElbow', '左手腕': 'lWrist', '左手': 'lWrist',
  '右肩': 'rShoulder', '右大臂': 'rArm', '右臂': 'rArm', '右上臂': 'rArm', '右小臂': 'rElbow', '右前臂': 'rElbow', '右肘': 'rElbow', '右手腕': 'rWrist', '右手': 'rWrist',
  '左腿': 'lLeg', '左大腿': 'lLeg', '左膝': 'lKnee', '左膝盖': 'lKnee', '左小腿': 'lKnee', '左踝': 'lAnkle', '左脚': 'lAnkle', '左脚踝': 'lAnkle',
  '右腿': 'rLeg', '右大腿': 'rLeg', '右膝': 'rKnee', '右膝盖': 'rKnee', '右小腿': 'rKnee', '右踝': 'rAnkle', '右脚': 'rAnkle', '右脚踝': 'rAnkle'
};
// 无法用具体骨骼表达、但可近似到逻辑骨骼的部位
const BODY_PART_TO_BONE = {
  '帽子': 'head', '发饰': 'head', '头发': 'head', '刘海': 'head',
  '手指': 'lWrist', '手掌': 'lWrist', '手腕': 'lWrist',
  '裙摆': 'lowerBody', '裙子': 'lowerBody', '马尾': 'head', '辫子': 'head',
  '呼吸': 'upperBody', '吸气': 'upperBody', '呼气': 'upperBody', '起伏': 'upperBody'
};
// 中文表情名 → 逻辑键（容错 AI 可能用中文命名表情）
const MORPH_ALIAS = {};
for (const [key, label] of ACTION_MORPHS) MORPH_ALIAS[label] = key;
Object.assign(MORPH_ALIAS, {
  '开心': 'happy', '高兴': 'happy', '笑': 'happy', '微笑': 'happy', '笑脸': 'happy',
  '悲伤': 'sad', '伤心': 'sad', '难过': 'sad', '哭': 'sad',
  '生气': 'angry', '愤怒': 'angry', '恼火': 'angry',
  '惊讶': 'surprise', '吃惊': 'surprise', '震惊': 'surprise',
  '害羞': 'shy', '羞涩': 'shy', '脸红': 'shy',
  '思考': 'think', '想': 'think', '冥想': 'think',
  '困惑': 'confuse', '疑惑': 'confuse', '迷糊': 'confuse',
  '问候': 'greet', '打招呼': 'greet', '问好': 'greet',
  '喜爱': 'love', '喜欢': 'love', '爱': 'love', '爱心': 'love',
  '困倦': 'sleepy', '困': 'sleepy', '瞌睡': 'sleepy', '想睡': 'sleepy'
});
// ===== 傻瓜式预设姿势模板（作为复杂动作的"编辑起点"，一键套用整套关键帧）=====
// 角度以"度"书写，运行时乘以 _R 转弧度；数值经人工校验，遵循骨骼链自然姿态约定
// （如肩 z 负/正=外展抬起、肘 z 正=屈肘、膝只取正值屈膝），避免穿模/反关节。
// 注意：这些模板是"起始骨架"，用户可在此基础上继续逐骨微调，满足"复杂修改"需求。
const _R = Math.PI / 180;
const POSE_TEMPLATES = {
  wave: { label: '挥手打招呼', duration: 1.5, loop: true, keyframes: [
    { t: 0,    bones: {}, morphs: { greet: 0.3 } },
    { t: 0.5,  bones: { rShoulder: { z: -35*_R }, rArm: { z: -70*_R }, rElbow: { z: 60*_R }, rWrist: { x: 25*_R, z: 12*_R }, head: { y: 8*_R } }, morphs: { greet: 0.5 } },
    { t: 1,    bones: {}, morphs: {} }
  ]},
  cheer: { label: '欢呼跳跃', duration: 1.2, loop: true, keyframes: [
    { t: 0,    bones: {}, morphs: { happy: 0.3 } },
    { t: 0.3,  bones: { lShoulder: { z: 55*_R }, rShoulder: { z: -55*_R }, lArm: { z: 55*_R }, rArm: { z: -55*_R }, lElbow: { z: 18*_R }, rElbow: { z: 18*_R }, head: { x: -8*_R } }, root: { y: 0.14 }, morphs: { happy: 0.7 } },
    { t: 0.65, bones: { lShoulder: { z: 55*_R }, rShoulder: { z: -55*_R }, lArm: { z: 55*_R }, rArm: { z: -55*_R } }, root: { y: 0 }, morphs: { happy: 0.5 } },
    { t: 1,    bones: {}, morphs: {} }
  ]},
  bow: { label: '鞠躬致谢', duration: 1.4, loop: true, keyframes: [
    { t: 0,    bones: {}, morphs: { greet: 0.3 } },
    { t: 0.5,  bones: { upperBody: { x: 30*_R }, upperBody2: { x: 18*_R }, neck: { x: 12*_R }, head: { x: 18*_R }, lArm: { z: 6*_R }, rArm: { z: -6*_R } }, morphs: { greet: 0.5 } },
    { t: 1,    bones: {}, morphs: {} }
  ]},
  think: { label: '思考托腮', duration: 2.0, loop: true, keyframes: [
    { t: 0,    bones: {}, morphs: { think: 0.3 } },
    { t: 0.5,  bones: { rShoulder: { z: -30*_R }, rArm: { z: -35*_R }, rElbow: { z: 80*_R }, rWrist: { x: 35*_R, z: 18*_R }, head: { x: 10*_R, y: -8*_R } }, morphs: { think: 0.6 } },
    { t: 1,    bones: {}, morphs: {} }
  ]},
  shy: { label: '害羞摆手', duration: 1.8, loop: true, keyframes: [
    { t: 0,    bones: {}, morphs: { shy: 0.3 } },
    { t: 0.5,  bones: { lShoulder: { z: 18*_R }, rShoulder: { z: -18*_R }, lArm: { z: 35*_R }, rArm: { z: -35*_R }, lElbow: { z: 55*_R }, rElbow: { z: 55*_R }, lWrist: { x: 18*_R }, rWrist: { x: 18*_R }, head: { x: 14*_R } }, morphs: { shy: 0.6 } },
    { t: 1,    bones: {}, morphs: {} }
  ]},
  victory: { label: '胜利举臂', duration: 1.5, loop: true, keyframes: [
    { t: 0,    bones: {}, morphs: { happy: 0.3 } },
    { t: 0.4,  bones: { lShoulder: { z: 65*_R }, rShoulder: { z: -65*_R }, lArm: { z: 65*_R }, rArm: { z: -65*_R }, lElbow: { z: 12*_R }, rElbow: { z: 12*_R }, head: { x: -10*_R } }, morphs: { happy: 0.7 } },
    { t: 1,    bones: {}, morphs: {} }
  ]}
};

// 套用预设模板：用整套关键帧覆盖当前动作（作为编辑起点），并刷新编辑器与预览
function applyPoseTemplate(ae, key) {
  const tpl = POSE_TEMPLATES[key];
  if (!tpl) return;
  ae.def.duration = tpl.duration;
  ae.def.loop = !!tpl.loop;
  ae.def.keyframes = tpl.keyframes.map(k => ({
    t: k.t,
    bones: JSON.parse(JSON.stringify(k.bones || {})),
    root: JSON.parse(JSON.stringify(k.root || {})),
    morphs: JSON.parse(JSON.stringify(k.morphs || {}))
  }));
  ae.kfIndex = 0;
  renderKeyframeList(ae); renderKeyframeBody(ae); renderTimelineMarkers(ae);
  _syncPreviewDef(ae); _aeDirty = true;
  if (window.showToast) window.showToast('已套用预设：' + tpl.label + '（可继续微调）', '', 'success');
}

// 镜像当前关键帧的左右姿势到对侧（让"只摆了一侧"的姿势一键变对称，便于复杂姿势快速成型）
// 规则：lX→rX、rX→lX，z 轴取反（左右侧张开的相反符号），x/y 保持不变。
function mirrorKeyframeLR(ae) {
  const kf = ae.def.keyframes[ae.kfIndex];
  if (!kf) return;
  const bones = kf.bones || {};
  const out = Object.assign({}, bones);
  for (const key in bones) {
    let mKey = null;
    if (key.length > 1 && key[0] === 'l' && ACTION_BONES.some(b => b[0] === 'r' + key.slice(1))) mKey = 'r' + key.slice(1);
    else if (key.length > 1 && key[0] === 'r' && ACTION_BONES.some(b => b[0] === 'l' + key.slice(1))) mKey = 'l' + key.slice(1);
    if (mKey) {
      const v = bones[key];
      out[mKey] = { x: v.x || 0, y: v.y || 0, z: -(v.z || 0) };
    }
  }
  kf.bones = out;
  renderKeyframeBody(ae); renderKeyframeList(ae); _syncPreviewDef(ae); _aeDirty = true;
  if (window.showToast) window.showToast('已镜像左右', '', 'success');
}

let _ae = null; // 动作编辑器当前状态 { model, isNew, isBuiltin, key, data, def, kfIndex }
// 编辑器是否以独立窗口（index.html?mode=editor）运行
const IS_EDITOR_WINDOW = (typeof location !== 'undefined') && new URLSearchParams(location.search).get('mode') === 'editor';
let currentShownModel = null; // 主窗口当前展示的模型，用于编辑器保存后刷新
let _actionPreview = null;   // 嵌入式实时 3D 预览实例（MmdPreview）
let _previewPlaying = false;
let _previewU = 0;
let _previewBundleLoading = false;
let _bpIndex = -1;           // 当前被选中的断点（相关动作行高亮）
let _previewResizeObserver = null; // 预览容器尺寸监听，窗口缩放/最大化时同步 WebGL 缓冲
let _previewResizeBound = false;  // 是否已绑定 window resize → 预览重算（只绑一次，避免重复监听）
let _aeDirty = false;             // 编辑器是否有未保存的修改
let _previewResizeScheduled = false; // 帧级防抖：本帧是否已调度过预览重算（防止 rAF + ResizeObserver 双重触发）
// 预览专用「模型组件调整」模式：开启时画布拖拽/滚轮改为移动/缩放当前对象（而非旋转视角）
let _aeAdjustMode = false;
let _aeAdjustDrag = null;   // (dx, dy) => void
let _aeAdjustWheel = null;  // (deltaY) => void
let _aeAdjustClick = null;  // (clientX, clientY) => void  点击模型拾取部件

// 懒加载独立预览 bundle（IIFE 全局 MmdPreview），只加载一次
function ensurePreviewBundle() {
  if (window.MmdPreview) return Promise.resolve(true);
  if (_previewBundleLoading) return _previewBundleLoading;
  _previewBundleLoading = new Promise((resolve) => {
    const s = document.createElement('script');
    s.src = 'js/mmdPreview.bundle.js';
    s.onload = () => resolve(!!window.MmdPreview);
    s.onerror = () => { _previewBundleLoading = false; resolve(false); };
    document.body.appendChild(s);
  });
  return _previewBundleLoading;
}

// 把当前 def 推给预览，参数改动时实时刷新姿态
function _syncPreviewDef(ae) {
  if (_actionPreview && _actionPreview.ready && ae && ae.def) {
    try { _actionPreview.setDef(ae.def); } catch (e) {}
  }
}

function   _destroyActionPreview() {
  if (_previewResizeObserver) { try { _previewResizeObserver.disconnect(); } catch (e) {} _previewResizeObserver = null; }
  if (_actionPreview) {
    try { _actionPreview.destroy(); } catch (e) {}
    _actionPreview = null;
  }
  window.__aePreview = null; // 清除当前生效的预览，pet.rotate/zoom/reset 不再指向已销毁的实例
  _previewPlaying = false;
  _previewU = 0;
}

// 动作编辑器 3D 预览：自由拖动旋转（环绕相机）+ 滚轮缩放，对应"可视化编辑"的拖拽需求
function wireActionPreviewOrbit(canvas, preview) {
  if (!canvas || !preview) return;
  let dragging = false, lastX = 0, lastY = 0, downX = 0, downY = 0, moved = 0;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  canvas.style.touchAction = 'none';
  canvas.addEventListener('pointerdown', (e) => {
    dragging = true; lastX = e.clientX; lastY = e.clientY;
    downX = e.clientX; downY = e.clientY; moved = 0;
    try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
    // 调整模型模式：按下即拾取光标下的关节（命中才选），随后拖动直接移动该关节——
    // 免去“先点选再拖”两步，让“拖关节”开箱即用（解决“拖动不管用”的困惑）
    if (_aeAdjustMode && typeof _aeAdjustClick === 'function') _aeAdjustClick(downX, downY);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const dx = e.clientX - lastX, dy = e.clientY - lastY;
    lastX = e.clientX; lastY = e.clientY;
    moved += Math.abs(dx) + Math.abs(dy);
    // 调整模型组件模式：拖拽改为移动/旋转当前对象（而非旋转视角）
    if (_aeAdjustMode && typeof _aeAdjustDrag === 'function') { _aeAdjustDrag(dx, dy); return; }
    const v = preview.getView();
    // 水平拖拽(yaw)取负：向右滑模型向右转（跟随手势），修正此前方向相反的问题
    preview.setView({ yaw: v.yaw - dx * 0.01, pitch: clamp(v.pitch + dy * 0.01, -1.2, 1.2) });
  });
  const end = () => {
    // 调整模式下，几乎未移动 = 视为点击 → 拾取模型部件（参考 Unity 点击选中）
    if (dragging && _aeAdjustMode && typeof _aeAdjustClick === 'function' && moved < 6) {
      _aeAdjustClick(downX, downY);
    }
    dragging = false;
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', () => { dragging = false; });
  canvas.addEventListener('pointerleave', () => { dragging = false; });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    // 调整模型组件模式：滚轮改为缩放当前对象（而非缩放视角）
    if (_aeAdjustMode && typeof _aeAdjustWheel === 'function') { _aeAdjustWheel(e.deltaY); return; }
    const v = preview.getView();
    preview.setView({ zoom: clamp(v.zoom * (1 - e.deltaY * 0.001), 0.3, 3) });
  }, { passive: false });
}

// 在编辑器弹窗里初始化嵌入式实时 3D 预览（不依赖龙虾窗口）
// 主动触发预览重算：分隔条拖拽 / 侧栏折叠 / 窗口缩放后，保证 WebGL 缓冲与画布 CSS 尺寸同步
// （解决「调高时间条 / 折叠侧栏后，模型预览窗口大小不变」的问题——仅 ResizeObserver 偶尔滞后，这里主动补一次）
// 主动触发预览重算（分隔条拖拽 / 侧栏折叠 / 窗口缩放）：统一走 rAF + 帧级防抖，
// 保证同一帧内无论 window resize 事件还是 ResizeObserver 都只真正重算一次（避免 fitCamera 每帧被调两次导致模型跳变）
function schedulePreviewResize() {
  const canvas = document.getElementById('ae-preview-canvas');
  if (!canvas || !_actionPreview || _previewResizeScheduled) return;
  _previewResizeScheduled = true;
  requestAnimationFrame(() => {
    _previewResizeScheduled = false;
    if (_actionPreview && canvas.clientWidth && canvas.clientHeight) {
      try { _actionPreview.resize(canvas.clientWidth, canvas.clientHeight); } catch (_) {}
    }
  });
}

async function initActionPreview(ae) {
  const t = window.I18N?.t || ((k) => k);
  const canvas = document.getElementById('ae-preview-canvas');
  const statusEl = document.getElementById('ae-preview-status');
  if (!canvas) return;
  if (!ae.model || !ae.model.modelFile) { if (statusEl) statusEl.textContent = t('actions.mmdOnly'); return; }
  if (statusEl) statusEl.textContent = t('actions.previewLoading');

  const ok = await ensurePreviewBundle();
  if (!ok || !window.MmdPreview) { if (statusEl) statusEl.textContent = t('actions.previewFailed'); return; }
  _destroyActionPreview();
  try {
    _actionPreview = window.MmdPreview.createMmdPreview(canvas);
  } catch (e) {
    if (statusEl) statusEl.textContent = t('actions.previewFailed');
    return;
  }
  // 注册当前预览，供宠物控制面板的 pet.rotate/zoom/reset 驱动；并启用自由拖动旋转 / 滚轮缩放
  window.__aePreview = _actionPreview;
  wireActionPreviewOrbit(canvas, _actionPreview);

  const pmxUrl = 'live2d:///' + encodeURI((ae.model.modelFile || '').replace(/\\/g, '/'));
  let loaded = false;
  try { loaded = await _actionPreview.load(pmxUrl); } catch (e) { loaded = false; }
  if (!loaded) { if (statusEl) statusEl.textContent = t('actions.previewFailed'); return; }

  try { _actionPreview.setDef(ae.def); } catch (e) {}
  const w = canvas.clientWidth || 300, h = canvas.clientHeight || 320;
  try { _actionPreview.resize(w, h); } catch (e) {}
  if (statusEl) statusEl.textContent = '';

  // 监听预览容器尺寸变化（窗口最大化/缩放/分屏），实时同步 WebGL 缓冲，避免画面被 CSS 拉伸变形
  if (window.ResizeObserver) {
    if (_previewResizeObserver) { try { _previewResizeObserver.disconnect(); } catch (_) {} }
    _previewResizeObserver = new ResizeObserver(() => {
      // 统一走 schedulePreviewResize（帧级防抖），与 window 'resize' 共享，避免同帧重复 resize
      schedulePreviewResize();
    });
    _previewResizeObserver.observe(canvas);
  }
  // 已有的 window.dispatchEvent(new Event('resize'))（分隔条 / 折叠处调用）统一在此驱动预览重算，只绑一次
  if (!_previewResizeBound) {
    _previewResizeBound = true;
    window.addEventListener('resize', schedulePreviewResize);
  }

  const playBtn = document.getElementById('ae-play');
  const pauseBtn = document.getElementById('ae-pause');
  const ruler = document.getElementById('ae-timeline-ruler');

  // 初始化时间轴（刻度、关键帧标记、播放头、编辑竖线、断点）
  buildTimelineTicks();
  renderTimelineMarkers(_ae);
  updatePlayhead(_previewU || 0);
  updateEditLine(_previewU || 0);

  // 标尺点击/拖动 → 定位「编辑竖线」（选择位置、调试姿态），而非播放头
  if (ruler) {
    const scrub = (clientX) => {
      const rect = ruler.getBoundingClientRect();
      let u = (clientX - rect.left) / rect.width;
      u = Math.max(0, Math.min(1, u));
      seekPreview(u);
    };
    let dragging = false;
    ruler.addEventListener('pointerdown', (e) => {
      if (e.target.classList.contains('ae-kf-marker')) return; // 标记自行处理拖动
      if (e.target.classList.contains('ae-bp')) return;        // 断点自行处理拖动/选择
      dragging = true;
      try { ruler.setPointerCapture(e.pointerId); } catch (_) {}
      scrub(e.clientX);
    });
    ruler.addEventListener('pointermove', (e) => { if (dragging) scrub(e.clientX); });
    ruler.addEventListener('pointerup', (e) => { dragging = false; try { ruler.releasePointerCapture(e.pointerId); } catch (_) {} });

  }

  // 「编辑竖线」独立拖动（选择位置调试模型姿态）
  const editLine = document.getElementById('ae-editline');
  if (editLine && ruler) {
    let edragging = false;
    const moveEdit = (clientX) => {
      const rect = ruler.getBoundingClientRect();
      let u = (clientX - rect.left) / rect.width; u = Math.max(0, Math.min(1, u));
      seekPreview(u);
    };
    editLine.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      edragging = true;
      try { editLine.setPointerCapture(e.pointerId); } catch (_) {}
      moveEdit(e.clientX);
    });
    editLine.addEventListener('pointermove', (e) => { if (edragging) moveEdit(e.clientX); });
    editLine.addEventListener('pointerup', (e) => { edragging = false; try { editLine.releasePointerCapture(e.pointerId); } catch (_) {} });
  }

  if (playBtn) playBtn.addEventListener('click', () => {
    if (!_actionPreview) return;
    _previewPlaying = true;
    _actionPreview.play((u) => { _previewU = u; updatePlayhead(u); });
  });
  if (pauseBtn) pauseBtn.addEventListener('click', () => {
    if (!_actionPreview) return;
    _previewPlaying = false;
    _actionPreview.pause();
  });
}

// 时间轴：绘制刻度（每 0.1 一档，整 0.5 加粗）
function buildTimelineTicks() {
  const ticks = document.getElementById('ae-tl-ticks');
  if (!ticks) return;
  ticks.innerHTML = '';
  const N = 10;
  for (let i = 0; i <= N; i++) {
    const tick = document.createElement('div');
    tick.className = 'ae-tl-tick' + (i % 5 === 0 ? ' major' : '');
    tick.style.left = (i / N * 100) + '%';
    ticks.appendChild(tick);
  }
}

// 时间轴：根据当前 def.keyframes 渲染关键帧菱形标记
function renderTimelineMarkers(ae) {
  const ruler = document.getElementById('ae-timeline-ruler');
  if (!ruler || !ae) return;
  ruler.querySelectorAll('.ae-kf-marker').forEach(el => el.remove());
  (ae.def.keyframes || []).forEach((kf, i) => {
    const m = document.createElement('div');
    m.className = 'ae-kf-marker' + (i === ae.kfIndex ? ' active' : '');
    m.style.left = (clampNum(kf.t, 0, 1, 0) * 100) + '%';
    m.title = '关键帧 ' + (i + 1) + '/' + ae.def.keyframes.length + ' · t=' + (+kf.t).toFixed(2) + ' · ' + summarizeKeyframe(kf);
    m.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      ae.kfIndex = i;
      renderKeyframeList(ae); renderKeyframeBody(ae); renderTimelineMarkers(ae);
      seekPreview(kf.t);
      // renderTimelineMarkers 会重建标记元素，需重新取当前激活的标记传给拖拽逻辑
      const fresh = ruler.querySelectorAll('.ae-kf-marker')[ae.kfIndex];
      startMarkerDrag(ae, kf, fresh || m);
    });
    ruler.appendChild(m);
  });

  // 断点：渲染相关动作沿时间轴的触发节点
  const bpLayer = document.getElementById('ae-bp-layer');
  if (bpLayer) {
    bpLayer.innerHTML = '';
    const dur = (ae.def.duration || 2);
    (ae.def.related || []).forEach((r, i) => {
      if (typeof r.t !== 'number') return;
      const label = (BUILTIN_ACTIONS.find(a => a.key === r.key) || {}).label || (ae.data.actions[r.key] && ae.data.actions[r.key].label) || r.key;
      const bp = document.createElement('div');
      bp.className = 'ae-bp';
      bp.style.left = (clampNum(r.t, 0, 1, 0) * 100) + '%';
      bp.title = label + ' @ ' + (r.t * dur).toFixed(2) + 's';
      bp.dataset.relIndex = i;
      bp.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        selectBreakpoint(ae, i);
        startBpDrag(ae, r, bp);
      });
      bpLayer.appendChild(bp);
    });
  }
}

// 拖动关键帧标记 → 修改其 t（实时重排、重绘、刷新预览）
function startMarkerDrag(ae, kf, markerEl) {
  const ruler = document.getElementById('ae-timeline-ruler');
  if (!ruler) return;
  let moved = false;
  const move = (clientX) => {
    const rect = ruler.getBoundingClientRect();
    let u = (clientX - rect.left) / rect.width;
    u = Math.max(0, Math.min(1, u));
    kf.t = +u.toFixed(3);
    moved = true;
    ae.def.keyframes.sort((a, b) => a.t - b.t);
    ae.kfIndex = ae.def.keyframes.indexOf(kf);
    markerEl.style.left = (u * 100) + '%';
    markerEl.title = 't=' + (+kf.t).toFixed(2);
    _syncPreviewDef(ae);
    seekPreview(kf.t);
    const items = document.querySelectorAll('#ae-kf-list .ae-kf-item');
    if (items[ae.kfIndex]) items[ae.kfIndex].querySelector('.ae-kf-t').textContent = (+kf.t).toFixed(2);
    const tv = document.getElementById('ae-kf-t-val'); if (tv) tv.textContent = (+kf.t).toFixed(2);
    const timeInput = document.getElementById('ae-kf-time'); if (timeInput) timeInput.value = (+kf.t).toFixed(2);
  };
  const up = () => {
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', up);
    if (moved) { renderKeyframeList(ae); renderKeyframeBody(ae); renderTimelineMarkers(ae); }
  };
  document.addEventListener('pointermove', move);
  document.addEventListener('pointerup', up);
}

// 定位「编辑竖线」并刷新预览姿态（拖动标尺、拖动标记、拖动编辑竖线、点击断点共用）
function seekPreview(u) {
  _previewU = u;
  if (_actionPreview) { try { _actionPreview.pause(); } catch (_) {} try { _actionPreview.seek(u); } catch (_) {} }
  _previewPlaying = false;
  updateEditLine(u);
}

// 移动播放头 + 更新时间读数（u 为 0..1，真实秒数 = u * duration）
function updatePlayhead(u) {
  const playhead = document.getElementById('ae-playhead');
  if (playhead) playhead.style.left = (clampNum(u, 0, 1, 0) * 100) + '%';
  const ro = document.getElementById('ae-time-readout');
  if (ro && _ae && _ae.def) {
    const dur = (_ae.def.duration || 2);
    ro.textContent = (u * dur).toFixed(2) + 's / ' + dur.toFixed(2) + 's';
  }
}

// 移动「编辑/选择竖线」（青色，用于定位与调试姿态）
function updateEditLine(u) {
  const el = document.getElementById('ae-editline');
  if (el) el.style.left = (clampNum(u, 0, 1, 0) * 100) + '%';
}

// 点击断点：定位编辑竖线（调试该姿态）+ 高亮对应相关动作行
function selectBreakpoint(ae, i) {
  const r = (ae.def.related || [])[i];
  if (!r) return;
  _bpIndex = i;
  seekPreview(r.t);
  const rows = document.querySelectorAll('#ae-related-list .ae-related-row');
  rows.forEach((row, idx) => row.classList.toggle('ae-rel-active', idx === i));
  const active = rows[i];
  if (active && active.scrollIntoView) active.scrollIntoView({ block: 'nearest' });
}

// 拖动断点节点：沿时间轴改变其触发时间点 t
function startBpDrag(ae, r, bp) {
  const ruler = document.getElementById('ae-timeline-ruler');
  if (!ruler) return;
  bp.classList.add('dragging');
  let moved = false;
  const move = (clientX) => {
    const rect = ruler.getBoundingClientRect();
    let u = (clientX - rect.left) / rect.width; u = Math.max(0, Math.min(1, u));
    r.t = +u.toFixed(3); moved = true;
    bp.style.left = (u * 100) + '%';
    const dur = (ae.def.duration || 2);
    const label = (BUILTIN_ACTIONS.find(a => a.key === r.key) || {}).label || (ae.data.actions[r.key] && ae.data.actions[r.key].label) || r.key;
    bp.title = label + ' @ ' + (r.t * dur).toFixed(2) + 's';
  };
  const up = () => {
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', up);
    bp.classList.remove('dragging');
    if (moved) { renderRelatedList(ae); renderTimelineMarkers(ae); }
  };
  document.addEventListener('pointermove', move);
  document.addEventListener('pointerup', up);
}

function degToRad(d) { return (d || 0) * Math.PI / 180; }
function radToDeg(r) { return (r || 0) * 180 / Math.PI; }
function num(v) { const n = Number(v); return isFinite(n) ? n : 0; }
function clampNum(v, lo, hi, def) { const n = num(v); if (!isFinite(n)) return def; return Math.max(lo, Math.min(hi, n)); }
function normalizeBoneKey(raw) {
  if (!raw) return null;
  if (ACTION_BONES.some(b => b[0] === raw)) return raw;
  const a = BONE_ALIAS[raw] || BONE_ALIAS[raw.toLowerCase()];
  if (a) return a;
  const b = BODY_PART_TO_BONE[raw] || BODY_PART_TO_BONE[raw.toLowerCase()];
  if (b) return b;
  return null;
}
function normalizeKeyframe(kf) {
  const out = { t: clampNum(kf.t, 0, 1, 0), bones: {}, root: {}, morphs: {} };
  if (kf.bones && typeof kf.bones === 'object') {
    for (const raw in kf.bones) {
      const bk = normalizeBoneKey(raw);
      if (!bk) continue;
      const v = kf.bones[raw] || {};
      out.bones[bk] = { x: num(v.x), y: num(v.y), z: num(v.z) };
    }
  }
  if (kf.root) {
    out.root = { y: num(kf.root.y), rotY: num(kf.root.rotY), rotX: num(kf.root.rotX), rotZ: num(kf.root.rotZ) };
  }
  if (kf.morphs && typeof kf.morphs === 'object') {
    for (const m in kf.morphs) {
      const w = num(kf.morphs[m]);
      if (w <= 0) continue;
      let mk = null;
      if (ACTION_MORPHS.some(x => x[0] === m)) mk = m;
      else mk = MORPH_ALIAS[m] || MORPH_ALIAS[m.toLowerCase()] || null;
      if (mk) out.morphs[mk] = w;
    }
  }
  return out;
}
function generateActionKey(data, label) {
  let base = 'act_' + (label || 'action').trim().replace(/[^\w一-龥]/g, '_').slice(0, 24);
  if (!base || base === 'act_') base = 'act_' + Date.now().toString(36);
  let key = base, i = 2;
  while (data.actions && data.actions[key]) { key = base + '_' + i; i++; }
  return key;
}
async function persistActions(model, data) {
  const r = await window.api.saveActions(model.id, data);
  if (r && r.success) {
    try { await window.api.setActionsInPet(data); } catch (e) { /* 龙虾未开时忽略，载入时仍生效 */ }
  }
  return r;
}

// 按内置动作类型生成「自然起手式」关键帧种子（BONE_KEYS 与 mmdPet 一致：
// head/upperBody/lowerBody/lArm/rArm/lLeg/rLeg 等；关键帧间已 easeInOut 缓动，无需手写插值）
function buildSeedKeyframes(builtinKey) {
  if (builtinKey === 'dance') {
    // 自然舞动：左右摆臂 + 髋/躯干随动 + 头部微摆 + 抬腿点地，幅度克制不扭曲
    return {
      duration: 2.4, loop: true,
      keyframes: [
        { t: 0,    bones: { lArm: { z: -0.2 }, rArm: { z: 0.2 }, upperBody: { z: 0 }, lowerBody: { x: 0 }, head: { z: 0 }, lLeg: { x: 0 }, rLeg: { x: 0 } }, root: {}, morphs: {} },
        { t: 0.25, bones: { lArm: { z: -0.8, y: 0.2 }, rArm: { z: 0.4, y: -0.2 }, upperBody: { z: 0.2 }, lowerBody: { x: -0.12 }, head: { z: 0.12 }, lLeg: { x: -0.15 }, rLeg: { x: 0 } }, root: {}, morphs: {} },
        { t: 0.5,  bones: { lArm: { z: 0.4, y: -0.2 }, rArm: { z: -0.8, y: 0.2 }, upperBody: { z: -0.2 }, lowerBody: { x: 0.12 }, head: { z: -0.12 }, lLeg: { x: 0 }, rLeg: { x: -0.15 } }, root: {}, morphs: {} },
        { t: 0.75, bones: { lArm: { z: -1.0 }, rArm: { z: 1.0 }, upperBody: { z: 0 }, lowerBody: { x: 0 }, head: { z: 0 }, lLeg: { x: 0 }, rLeg: { x: 0 } }, root: {}, morphs: {} },
        { t: 1,    bones: { lArm: { z: -0.2 }, rArm: { z: 0.2 }, upperBody: { z: 0 }, lowerBody: { x: 0 }, head: { z: 0 }, lLeg: { x: 0 }, rLeg: { x: 0 } }, root: {}, morphs: {} }
      ]
    };
  }
  // 其它内置动作：中性站姿 + 轻微呼吸/起伏，作为可编辑基线（避免从空白起步）
  return {
    duration: 2, loop: true,
    keyframes: [
      { t: 0,   bones: { upperBody: { z: 0 }, head: { z: 0 }, lArm: { z: 0 }, rArm: { z: 0 } }, root: {}, morphs: {} },
      { t: 0.5, bones: { upperBody: { z: 0.08 }, head: { z: 0.04 }, lArm: { z: -0.1 }, rArm: { z: 0.1 } }, root: {}, morphs: {} },
      { t: 1,   bones: { upperBody: { z: 0 }, head: { z: 0 }, lArm: { z: 0 }, rArm: { z: 0 } }, root: {}, morphs: {} }
    ]
  };
}

// 内置动作 → 可编辑自定义动作：派生副本并写入关键帧种子，重新以「非内置」方式打开，便于 AI / 代码优化
async function deriveBuiltinToEditable(ae) {
  if (!ae.isBuiltin) return;
  const t = window.I18N?.t || ((k) => k);
  const baseLabel = (ae.def.label || '动作');
  const newLabel = baseLabel + '·可编辑';
  const newKey = generateActionKey(ae.data, newLabel);
  const seed = buildSeedKeyframes(ae.key);
  ae.data.actions[newKey] = {
    key: newKey, label: newLabel, duration: seed.duration, loop: seed.loop, speed: 1,
    keyframes: seed.keyframes, related: []
  };
  const r = await persistActions(ae.model, ae.data);
  if (!r || !r.success) { showToast(t('actions.deriveFailed') || '复制失败', '', 'error'); return; }
  showToast(t('actions.deriveOk') || '已生成可编辑副本', newLabel, 'success');
  // 重新以非内置方式打开副本（动作编辑器左侧即出现关键帧编辑 + 代码/AI 面板操作的是这个新副本）
  window.api.editor.open({ modelId: ae.model.id, actionKey: newKey, isNew: false, isBuiltin: false });
}

async function loadModelActionsSection(model) {
  const t = window.I18N?.t || ((k) => k);
  const wrap = document.getElementById('model-actions-section');
  if (!wrap) return;
  let data = { idle: null, actions: {} };
  try {
    const res = await window.api.getActions(model.id);
    if (res && res.success && res.data) data = res.data;
  } catch (e) { /* 忽略，回退空配置 */ }
  renderActionsSection(model, data);
}

function renderActionsSection(model, data) {
  const t = window.I18N?.t || ((k) => k);
  const wrap = document.getElementById('model-actions-section');
  if (!wrap) return;
  data.actions = data.actions || {};
  data.deletedBuiltins = Array.isArray(data.deletedBuiltins) ? data.deletedBuiltins : [];
  const deletedBuiltinSet = new Set(data.deletedBuiltins);

  // 自定义列表排除内置动作键（内置动作的 related/idle 覆盖也存于 data.actions，但属于覆盖而非自定义动作）
  const customKeys = Object.keys(data.actions).filter(k => !BUILTIN_ACTIONS.some(a => a.key === k));

  // 默认(内置)动作：支持删除（除导入模型自带的原生动作外——模型自带动作不在本列表、不受影响）。
  // 被删除的内置动作进入"已隐藏"区，可一键恢复；同时会从待机组合候选中移除。
  const visibleBuiltins = BUILTIN_ACTIONS.filter(a => !deletedBuiltinSet.has(a.key));
  const hiddenBuiltins = BUILTIN_ACTIONS.filter(a => deletedBuiltinSet.has(a.key));
  const builtinRows = visibleBuiltins.map(a => `
    <div class="action-row">
      <span class="action-name">${a.label}</span>
      <span class="action-tags"></span>
      <span class="action-btns">
        <button class="btn btn-sm" data-edit="${a.key}" data-builtin="1">${t('actions.edit')}</button>
        <button class="btn btn-sm btn-danger" data-del-builtin="${a.key}">${t('actions.delete')}</button>
      </span>
    </div>`).join('');
  const hiddenBuiltinRows = hiddenBuiltins.length ? hiddenBuiltins.map(a => `
    <div class="action-row action-row-hidden">
      <span class="action-name">${a.label}</span>
      <span class="action-tags"><span class="tag">已隐藏</span></span>
      <span class="action-btns">
        <button class="btn btn-sm" data-restore-builtin="${a.key}">${t('actions.restore') || '恢复'}</button>
      </span>
    </div>`).join('') : '';

  const customRows = customKeys.length ? customKeys.map(k => `
    <div class="action-row">
      <span class="action-name">${escapeHtml(data.actions[k].label || k)}</span>
      <span class="action-tags">${data.actions[k].loop ? `<span class="tag">循环</span>` : ''}</span>
      <span class="action-btns">
        <button class="btn btn-sm" data-edit="${k}">${t('actions.edit')}</button>
        <button class="btn btn-sm btn-danger" data-del="${k}">${t('actions.delete')}</button>
      </span>
    </div>`).join('') : `<div class="ae-note">${t('actions.noCustom')}</div>`;

  wrap.innerHTML = `
    <div class="detail-row"><span class="label">${t('actions.title')}</span></div>
    <div class="action-idle-combo">
      <div class="action-idle-row">
        <label>${t('actions.idleCombo')} <span class="ae-hint">${t('actions.idleComboHint')}</span></label>
      </div>
      <div class="ae-combo-pool" id="ae-combo-pool"></div>
      <div class="ae-combo-seq" id="ae-combo-seq"></div>
      <div class="ae-combo-empty" id="ae-combo-empty">${t('actions.idleComboEmpty')}</div>
      <button class="btn btn-sm" id="ae-combo-clear">${t('actions.idleComboClear')}</button>
    </div>
    <div class="action-group-title">${t('actions.builtin')} <span class="ae-hint">${t('actions.builtinHint') || '导入模型自带动作不受影响'}</span></div>
    <div class="action-list">${builtinRows}</div>
    ${hiddenBuiltinRows ? `<div class="action-group-title action-group-title-sub">${t('actions.hiddenBuiltin') || '已隐藏的默认动作'}</div><div class="action-list">${hiddenBuiltinRows}</div>` : ''}
    <div class="action-group-title">${t('actions.custom')}</div>
    <div class="action-list">${customRows}</div>
    <button class="btn btn-sm btn-primary" id="btn-new-action">+ ${t('actions.new')}</button>
  `;

  wrap.querySelectorAll('[data-edit]').forEach(btn => btn.addEventListener('click', () => {
    window.api.editor.open({ modelId: model.id, actionKey: btn.dataset.edit, isNew: false, isBuiltin: btn.dataset.builtin === '1' });
  }));

  wrap.querySelectorAll('[data-del]').forEach(btn => btn.addEventListener('click', async () => {
    const confirmed = await showConfirm({ type: 'warning', title: t('models.delete'), message: t('actions.deleteConfirm') });
    if (!confirmed) return;
    delete data.actions[btn.dataset.del];
    const r = await persistActions(model, data);
    if (r && r.success) { showToast(t('actions.delete'), '', 'success'); renderActionsSection(model, data); }
  }));

  // 删除默认(内置)动作：记录到 data.deletedBuiltins（按模型隔离，不影响其他模型），
  // 并自动从待机组合候选中移除；导入模型自带的原生动作不在本列表，不受影响。
  wrap.querySelectorAll('[data-del-builtin]').forEach(btn => btn.addEventListener('click', async () => {
    const k = btn.dataset.delBuiltin;
    const confirmed = await showConfirm({
      type: 'warning',
      title: t('actions.delete'),
      message: t('actions.deleteBuiltinConfirm') || '确定要隐藏该默认动作吗？隐藏后将从动作列表与待机组合中移除，可随时恢复。'
    });
    if (!confirmed) return;
    if (!data.deletedBuiltins.includes(k)) data.deletedBuiltins.push(k);
    const r = await persistActions(model, data);
    if (r && r.success) { showToast(t('actions.delete'), '', 'success'); renderActionsSection(model, data); }
  }));

  // 恢复已隐藏的默认动作
  wrap.querySelectorAll('[data-restore-builtin]').forEach(btn => btn.addEventListener('click', async () => {
    const k = btn.dataset.restoreBuiltin;
    data.deletedBuiltins = data.deletedBuiltins.filter(x => x !== k);
    const r = await persistActions(model, data);
    if (r && r.success) { showToast(t('actions.restore') || '已恢复', '', 'success'); renderActionsSection(model, data); }
  }));

  // ===== 待机组合动作（有序多选，待机时循环播放）=====
  const COMBO_BASIC = [
    { key: 'tap', label: '轻点' }, { key: 'flick', label: '甩动' },
    { key: 'flickup', label: '上扬' }, { key: 'happy', label: '开心' }, { key: 'greet', label: '问候' }
  ];
  const comboLabelMap = { idle: t('actions.idleComboSway') };
  COMBO_BASIC.forEach(a => { comboLabelMap[a.key] = a.label; });
  BUILTIN_ACTIONS.forEach(a => { comboLabelMap[a.key] = a.label; });
  Object.keys(data.actions).forEach(k => { if (!comboLabelMap[k]) comboLabelMap[k] = data.actions[k].label || k; });
  data.idleCombo = Array.isArray(data.idleCombo) ? data.idleCombo.slice() : [];

  const poolEl = document.getElementById('ae-combo-pool');
  const seqEl = document.getElementById('ae-combo-seq');
  const emptyEl = document.getElementById('ae-combo-empty');

  const renderComboPool = () => {
    const delSet = new Set(data.deletedBuiltins || []);
    const poolKeys = ['idle'].concat(COMBO_BASIC.map(a => a.key), BUILTIN_ACTIONS.filter(a => !delSet.has(a.key)).map(a => a.key), Object.keys(data.actions));
    poolEl.innerHTML = poolKeys.map(k =>
      `<button type="button" class="ae-combo-chip${data.idleCombo.includes(k) ? ' active' : ''}" data-combo-key="${k}">${escapeHtml(comboLabelMap[k] || k)}</button>`
    ).join('');
  };
  const renderComboSeq = () => {
    if (!data.idleCombo.length) { seqEl.innerHTML = ''; emptyEl.style.display = ''; return; }
    emptyEl.style.display = 'none';
    seqEl.innerHTML = data.idleCombo.map((k, i) => `
      <span class="ae-combo-step">
        <span class="ae-combo-step-idx">${i + 1}</span>
        <span class="ae-combo-step-name">${escapeHtml(comboLabelMap[k] || k)}</span>
        <button type="button" class="ae-combo-step-btn" data-combo-move-idx="${i}" data-dir="-1" title="${t('actions.idleComboMoveLeft')}">◀</button>
        <button type="button" class="ae-combo-step-btn" data-combo-move-idx="${i}" data-dir="1" title="${t('actions.idleComboMoveRight')}">▶</button>
        <button type="button" class="ae-combo-step-btn ae-combo-step-del" data-combo-remove-idx="${i}" title="${t('actions.idleComboRemove')}">✕</button>
      </span>`).join('');
  };
  const persistCombo = async () => {
    const r = await persistActions(model, data);
    if (r && r.success) showToast(t('actions.idleComboUpdated'), '', 'success');
  };
  const toggleComboKey = async (k) => {
    const idx = data.idleCombo.indexOf(k);
    if (idx >= 0) data.idleCombo.splice(idx, 1);
    else data.idleCombo.push(k);
    renderComboPool();
    renderComboSeq();
    await persistCombo();
  };

  renderComboPool();
  renderComboSeq();

  poolEl.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-combo-key]');
    if (!btn) return;
    await toggleComboKey(btn.dataset.comboKey);
  });
  seqEl.addEventListener('click', async (e) => {
    const moveBtn = e.target.closest('[data-combo-move-idx]');
    if (moveBtn) {
      const i = parseInt(moveBtn.dataset.comboMoveIdx, 10);
      const dir = parseInt(moveBtn.dataset.dir, 10) || 0;
      const ni = i + dir;
      if (ni >= 0 && ni < data.idleCombo.length) {
        const arr = data.idleCombo;
        const tmp = arr[i]; arr[i] = arr[ni]; arr[ni] = tmp;
        renderComboPool();
        renderComboSeq();
        await persistCombo();
      }
      return;
    }
    const delBtn = e.target.closest('[data-combo-remove-idx]');
    if (delBtn) {
      const i = parseInt(delBtn.dataset.comboRemoveIdx, 10);
      if (i >= 0 && i < data.idleCombo.length) {
        data.idleCombo.splice(i, 1);
        renderComboPool();
        renderComboSeq();
        await persistCombo();
      }
    }
  });
  document.getElementById('ae-combo-clear').addEventListener('click', async () => {
    data.idleCombo = [];
    renderComboPool();
    renderComboSeq();
    await persistCombo();
  });

  document.getElementById('btn-new-action').addEventListener('click', () => window.api.editor.open({ modelId: model.id, actionKey: '', isNew: true, isBuiltin: false }));
}

async function openActionEditor(model, actionKey, isNew, isBuiltin, opts = {}) {
  const t = window.I18N?.t || ((k) => k);
  let res;
  try { res = await window.api.getActions(model.id); } catch (e) { res = null; }
  const data = (res && res.success && res.data) ? res.data : { idle: null, actions: {} };
  data.actions = data.actions || {};

  let def;
  if (isNew) {
    def = { key: '', label: '', duration: 2, loop: false, speed: 1,
      keyframes: [ { t: 0, bones: {}, root: {}, morphs: {} }, { t: 1, bones: {}, root: {}, morphs: {} } ],
      related: [] };
  } else {
    const src = data.actions[actionKey] || { key: actionKey, label: actionKey, duration: 2, loop: false, speed: 1, related: [] };
    def = JSON.parse(JSON.stringify(src));
    def.key = actionKey;
    def.keyframes = Array.isArray(def.keyframes) ? def.keyframes : (isBuiltin ? null : []);
    if (!Array.isArray(def.related)) def.related = [];
    if (typeof def.speed !== 'number' || def.speed <= 0) def.speed = 1;
  }

  _ae = { model, isNew, isBuiltin: !!isBuiltin, key: isNew ? null : actionKey, data, def, kfIndex: 0 };
  _aeDirty = false; // 打开编辑器时重置脏标记

  const standalone = IS_EDITOR_WINDOW || opts.standalone;
  if (standalone) {
    const root = document.getElementById('action-editor-root');
    if (root) {
      root.innerHTML = buildActionEditorBody(_ae, t);
      root.classList.add('show');
      const center = document.getElementById('titlebar-center');
      if (center) center.innerHTML = `<span class="editor-title">${(isNew ? t('actions.editorTitleNew') : t('actions.editorTitle')) + (def.label ? ' · ' + escapeHtml(def.label) : '')}</span>`;
      document.title = (isNew ? t('actions.editorTitleNew') : t('actions.editorTitle')) + (def.label ? ' · ' + def.label : '');
    }
    wireActionEditor(_ae);
    if (!isBuiltin) { renderKeyframeList(_ae); renderKeyframeBody(_ae); }
    renderRelatedList(_ae);
    initActionPreview(_ae);
    if (root) wrapNumberSteppers(root);
  } else {
    showModal({
      title: isNew ? t('actions.editorTitleNew') : t('actions.editorTitle'),
      body: buildActionEditorBody(_ae, t),
      footer: ''
    });
    const modalEl = document.getElementById('modal');
    if (modalEl) modalEl.classList.add('ae-modal');
    wireActionEditor(_ae);
    if (!isBuiltin) { renderKeyframeList(_ae); renderKeyframeBody(_ae); }
    renderRelatedList(_ae);
    initActionPreview(_ae);
    wrapNumberSteppers(document.getElementById('modal'));
  }
}

// 预览框左上角悬浮控件：复位视角 + 色彩设置（含饱和度/亮度/色相滑块）
function aePreviewOverlay(t) {
  // 预览专用「模型组件调整」：选中身体部件以「位移」方式移动关节（拖拽 → 关节随手势平移，
  // 下游子骨骼刚性跟随；整体模型仍可位移/缩放/旋转取景），绝不做缩放以免骨骼粗细/大小被拉伸扭曲；
  // 仅作用于预览，永不写入关键帧
  const AE_ADJUST_PARTS = [
    ['head', 'actions.adjustHead'], ['neck', 'actions.adjustNeck'],
    ['upperBody', 'actions.adjustUpper'], ['lowerBody', 'actions.adjustLower'],
    ['lArm', 'actions.adjustLArm'], ['rArm', 'actions.adjustRArm'],
    ['lWrist', 'actions.adjustLWrist'], ['rWrist', 'actions.adjustRWrist'],
    ['lLeg', 'actions.adjustLLeg'], ['rLeg', 'actions.adjustRLeg']
  ];
  const partOpts = AE_ADJUST_PARTS.map(([k, lk]) => `<option value="${k}">${t(lk)}</option>`).join('');
  return `<div class="ae-preview-overlay">
      <button class="ae-ov-btn" id="ae-reset-view" title="${t('actions.resetView') || '复位视角'}">${window.ElIcons.getIcon('refresh')}</button>
      <button class="ae-ov-btn" id="ae-color-btn" title="${t('color.settings') || '色彩设置'}">${window.ElIcons.getIcon('palette')}</button>
      <button class="ae-ov-btn" id="ae-adjust-btn" title="${t('actions.adjustTip') || '调整模型：开启后点击部件选中、拖拽变换、滚轮缩放'}">${window.ElIcons.getIcon('edit')}</button>
      <div class="ae-color-pop" id="ae-color-pop">
        <div class="ae-color-row"><label>${t('color.saturation') || '饱和度'}</label><input type="range" id="ae-col-sat" min="0.3" max="2.5" step="0.01"><span class="ae-col-val" id="ae-col-sat-v"></span></div>
        <div class="ae-color-row"><label>${t('color.brightness') || '亮度'}</label><input type="range" id="ae-col-bri" min="0.5" max="1.8" step="0.01"><span class="ae-col-val" id="ae-col-bri-v"></span></div>
        <div class="ae-color-row"><label>${t('color.hue') || '色相'}</label><input type="range" id="ae-col-hue" min="-180" max="180" step="1"><span class="ae-col-val" id="ae-col-hue-v"></span></div>
        <button class="btn btn-sm" id="ae-col-reset">${t('color.reset') || '恢复默认'}</button>
      </div>
    </div>
    <div class="ae-adjust-bar" id="ae-adjust-bar">
      <div class="ae-adj-modes">
        <button class="ae-adj-mode active" data-mode="move">${t('actions.adjustMove') || '移动'}</button>
      </div>
      <div class="ae-adj-target-row">
        <select id="ae-adj-target" class="ae-adj-select" title="${t('actions.adjustTarget') || '调整对象'}">
          <option value="">${t('actions.adjustWhole') || '整体模型'}</option>
          ${partOpts}
        </select>
      </div>
      <button class="btn btn-sm ae-adj-reset" id="ae-adj-reset">${t('actions.adjustReset') || '重置'}</button>
      <div class="ae-adj-note">${t('actions.adjustNote') || '点击模型选中部件 · 拖拽移动关节位置（仅预览，不影响保存）'}</div>
    </div>`;
}

function buildActionEditorBody(ae, t) {
  const def = ae.def;
  let html = `<div class="action-editor">`;

  // 顶部工具栏：保存（图标）+ 预览到宠物（非内置）
  html += `<div class="ae-toolbar">
      ${!ae.isBuiltin ? `<button class="btn" id="ae-preview">${t('actions.previewInPet')}</button>` : ''}
      <button class="btn btn-primary ae-icon-btn" id="ae-save" title="${t('actions.saveName')}">${window.ElIcons.getIcon('save')}</button>
    </div>`;

  if (ae.isBuiltin) {
    // 内置动作：关键帧为系统预设（不可编辑），但仍提供预览 + 时间轴以便观看；属性/相关可改
    html += `<div class="ae-grid">
      <aside class="ae-side ae-side-left" id="ae-side-left">
        <div class="ae-side-body ae-col-left">
          <div class="ae-section">
            <div class="ae-subhead ae-sec-head" data-collapse>内置动作（预览）<span class="ae-sec-caret">▾</span></div>
            <div class="ae-section-body">
              <div class="ae-note">${t('actions.builtinNote')}</div>
              <button class="btn btn-sm btn-primary" id="ae-derive" style="margin-top:8px">复制为可编辑动作</button>
              <div class="ae-note" style="margin-top:6px">复制后生成一份可编辑副本（内置「跳舞」会带自然舞动起手式），可在此基础上让 AI / 代码优化。</div>
            </div>
          </div>
          <div class="ae-section">
            <div class="ae-subhead ae-sec-head" data-collapse>${t('actions.petDisplay')}<span class="ae-sec-caret">▾</span></div>
            <div class="ae-section-body">
              <div class="ae-visual-panel" id="ae-visual-panel"></div>
            </div>
          </div>
        </div>
      </aside>
      <section class="ae-col ae-col-center">
        <div class="ae-stage">
          <div class="ae-subhead">${t('actions.previewTitle')}</div>
          <div class="ae-preview-canvas-wrap">
            <canvas id="ae-preview-canvas" data-tip="${t('actions.previewHint')}"></canvas>
            <div class="ae-preview-status" id="ae-preview-status">${t('actions.previewLoading')}</div>
            ${aePreviewOverlay(t)}
          </div>
        </div>
      </section>
      <aside class="ae-side ae-side-right" id="ae-side-right">
        <div class="ae-side-body ae-col-right">
          <div class="ae-section">
            <div class="ae-subhead ae-sec-head" data-collapse>${t('actions.properties')}<span class="ae-sec-caret">▾</span></div>
            <div class="ae-section-body">
              <div class="ae-prop">
                <div class="ae-field"><label>${t('actions.name')}</label><input type="text" id="ae-label" value="${escapeHtml(def.label || '')}" maxlength="30" placeholder="如：挥手打招呼"></div>
                <div class="ae-field"><label>${t('actions.duration')}</label><input type="number" id="ae-duration" min="0.2" max="30" step="0.1" value="${def.duration != null ? def.duration : 2}"></div>
                <div class="ae-field"><label>${t('actions.speed')}</label><input type="number" id="ae-speed" min="0.1" max="3" step="0.05" value="${def.speed != null ? def.speed : 1}"></div>
                <label class="ae-check"><input type="checkbox" id="ae-loop" ${def.loop ? 'checked' : ''}> ${t('actions.loop')}</label>
              </div>
            </div>
          </div>
          <div class="ae-section">
            <div class="ae-subhead ae-sec-head" data-collapse>${t('actions.related')}<span class="ae-sec-caret">▾</span></div>
            <div class="ae-section-body">
              <div class="ae-related-list" id="ae-related-list"></div>
            </div>
          </div>
        </div>
      </aside>
    </div>`;
  } else {
    // 三栏布局：左=关键帧编辑器 + 代码/AI 面板，中=预览(顶)，右=属性(名称/时长/速率/循环)+相关
    html += `<div class="ae-grid">
      <aside class="ae-side ae-side-left" id="ae-side-left">
        <div class="ae-side-body ae-col-left">
          <div class="ae-section">
            <div class="ae-subhead ae-sec-head" data-collapse>预设姿势 <span class="ae-sec-caret">▾</span></div>
            <div class="ae-section-body">
              <div class="ae-template-list">
                ${Object.keys(POSE_TEMPLATES).map(k => `<button class="btn btn-sm ae-template-btn" data-template="${k}">${POSE_TEMPLATES[k].label}</button>`).join('')}
              </div>
              <div class="ae-note">点击套用整套关键帧（覆盖当前帧，作为复杂动作的编辑起点）</div>
            </div>
          </div>
          <div class="ae-section">
            <div class="ae-subhead ae-sec-head" data-collapse>${t('actions.keyframes')} <button class="btn btn-sm" id="ae-add-kf">+ ${t('actions.addKeyframe')}</button><span class="ae-sec-caret">▾</span></div>
            <div class="ae-section-body">
              <div class="ae-kf-list" id="ae-kf-list"></div>
            </div>
          </div>
          <div class="ae-section">
            <div class="ae-subhead ae-sec-head" data-collapse>${t('actions.keyframeEdit')}: <span id="ae-kf-t-val"></span><span class="ae-sec-caret">▾</span></div>
            <div class="ae-section-body">
              <div class="ae-kf-body" id="ae-kf-body"></div>
            </div>
          </div>
          <div class="ae-section">
            <div class="ae-subhead ae-sec-head" data-collapse>${t('actions.petDisplay')}<span class="ae-sec-caret">▾</span></div>
            <div class="ae-section-body">
              <div class="ae-visual-panel" id="ae-visual-panel"></div>
            </div>
          </div>
        </div>
      </aside>

      <section class="ae-col ae-col-center">
        <div class="ae-stage">
          <div class="ae-subhead">${t('actions.previewTitle')}</div>
          <div class="ae-preview-canvas-wrap">
            <canvas id="ae-preview-canvas" data-tip="${t('actions.previewHint')}"></canvas>
            <div class="ae-preview-status" id="ae-preview-status">${t('actions.previewLoading')}</div>
            ${aePreviewOverlay(t)}
          </div>
        </div>
      </section>

      <aside class="ae-side ae-side-right" id="ae-side-right">
        <div class="ae-side-body ae-col-right">
          <div class="ae-section">
            <div class="ae-subhead ae-sec-head" data-collapse>${t('actions.properties')}<span class="ae-sec-caret">▾</span></div>
            <div class="ae-section-body">
              <div class="ae-prop">
                <div class="ae-field"><label>${t('actions.name')}</label><input type="text" id="ae-label" value="${escapeHtml(def.label || '')}" maxlength="30" placeholder="如：挥手打招呼"></div>
                <div class="ae-field"><label>${t('actions.duration')}</label><input type="number" id="ae-duration" min="0.2" max="30" step="0.1" value="${def.duration != null ? def.duration : 2}"></div>
                <div class="ae-field"><label>${t('actions.speed')}</label><input type="number" id="ae-speed" min="0.1" max="3" step="0.05" value="${def.speed != null ? def.speed : 1}"></div>
                <label class="ae-check"><input type="checkbox" id="ae-loop" ${def.loop ? 'checked' : ''}> ${t('actions.loop')}</label>
              </div>
            </div>
          </div>
          <div class="ae-section">
            <div class="ae-subhead ae-sec-head" data-collapse>${t('actions.related')}<span class="ae-sec-caret">▾</span></div>
            <div class="ae-section-body">
              <div class="ae-related-list" id="ae-related-list"></div>
            </div>
          </div>
        </div>
      </aside>
    </div>`;
  }

  // 时间条：独立于三栏布局，铺满整行（全宽），紧贴预览框下方
  html += `<div class="ae-timeline" data-tip="${t('actions.timelineHint')}">
    <div class="ae-tl-controls">
      <button class="btn btn-sm" id="ae-play">${window.ElIcons.getIcon('play')} ${t('actions.previewPlay')}</button>
      <button class="btn btn-sm" id="ae-pause">${window.ElIcons.getIcon('pause')} ${t('actions.previewPause')}</button>
      <span class="ae-tl-time" id="ae-time-readout">0.00s / 0.00s</span>
    </div>
    <div class="ae-tl-ruler" id="ae-timeline-ruler">
      <div class="ae-tl-ticks" id="ae-tl-ticks"></div>
      <div class="ae-editline" id="ae-editline"></div>
      <div class="ae-bp-layer" id="ae-bp-layer"></div>
      <div class="ae-playhead" id="ae-playhead"></div>
    </div>
  </div>`;

  html += `</div>`;
  return html;
}

function wireActionEditor(ae) {
  const def = ae.def;
  const labelEl = document.getElementById('ae-label');
  if (labelEl) labelEl.addEventListener('input', () => { def.label = labelEl.value; _aeDirty = true; });
  const durEl = document.getElementById('ae-duration');
  if (durEl) durEl.addEventListener('input', () => { const v = parseFloat(durEl.value); def.duration = isFinite(v) ? v : 2; _syncPreviewDef(ae); _aeDirty = true; });
  const loopEl = document.getElementById('ae-loop');
  if (loopEl) loopEl.addEventListener('change', () => { def.loop = loopEl.checked; _aeDirty = true; });
  const speedEl = document.getElementById('ae-speed');
  if (speedEl) speedEl.addEventListener('input', () => { const v = parseFloat(speedEl.value); def.speed = (isFinite(v) && v > 0) ? v : 1; _aeDirty = true; });

  if (!ae.isBuiltin) {
    const addBtn = document.getElementById('ae-add-kf');
    if (addBtn) addBtn.addEventListener('click', () => {
      const kfs = def.keyframes;
      const lastT = kfs.length ? kfs[kfs.length - 1].t : 0;
      const nt = Math.min(1, +(lastT + 0.25).toFixed(2));
      kfs.push({ t: nt, bones: {}, root: {}, morphs: {} });
      ae.kfIndex = kfs.length - 1;
      renderKeyframeList(ae); renderKeyframeBody(ae); renderTimelineMarkers(ae);
      _syncPreviewDef(ae);
      _aeDirty = true;
    });
    const prevBtn = document.getElementById('ae-preview');
    if (prevBtn) prevBtn.addEventListener('click', () => previewCurrentAction(ae));
    // 预设姿势模板按钮（仅非内置动作存在）
    document.querySelectorAll('.ae-template-btn').forEach(btn => {
      btn.addEventListener('click', () => applyPoseTemplate(ae, btn.dataset.template));
    });
  }

  const saveBtn = document.getElementById('ae-save');
  if (saveBtn) saveBtn.addEventListener('click', () => saveActionEditor(ae));

  // 把「宠物显示 / 代码 / AI 控制」面板（可视化编辑）注入动作编辑器
  const vePanel = document.getElementById('ae-visual-panel');
  if (vePanel && typeof window.buildVisualControlPanel === 'function') {
    window.buildVisualControlPanel(vePanel, ae);
  }

  // 内置动作：提供「复制为可编辑动作」入口（派生一份可编辑副本，便于 AI / 代码优化）
  const deriveBtn = document.getElementById('ae-derive');
  if (deriveBtn) deriveBtn.addEventListener('click', () => deriveBuiltinToEditable(ae));

  // 注入可拖拽分隔条（左/中/右 水平 + 主区/时间轴 垂直），实现自由调整各区域大小
  initSplitters();

  // 预览框悬浮控件：复位视角 + 色彩设置（饱和度/亮度/色相）
  wireActionColorControls(ae);

  // 预览专用「模型组件调整」：整体/部件位移与缩放（仅预览，不影响保存姿态）
  wireActionAdjust(ae);

  // 侧栏标题栏点击展开/折叠对应功能区块
  setupSectionCollapse(document.querySelector('.action-editor'));
}

// 动作编辑器：侧栏各功能区块标题栏（.ae-subhead[data-collapse]）点击展开/折叠
function setupSectionCollapse(root) {
  if (!root) return;
  root.querySelectorAll('.ae-subhead[data-collapse]').forEach(head => {
    head.addEventListener('click', (e) => {
      // 标题内的按钮（如「+ 添加关键帧」）点击不应触发折叠
      if (e.target.closest('button')) return;
      const section = head.closest('.ae-section');
      if (section) section.classList.toggle('collapsed');
    });
  });
}

// 动作编辑器：预览模型色彩设置（饱和度/亮度/色相）持久化 + 复位视角
function wireActionColorControls(ae) {
  const canvas = document.getElementById('ae-preview-canvas');
  const resetViewBtn = document.getElementById('ae-reset-view');
  const colorBtn = document.getElementById('ae-color-btn');
  const colorPop = document.getElementById('ae-color-pop');
  const satEl = document.getElementById('ae-col-sat');
  const briEl = document.getElementById('ae-col-bri');
  const hueEl = document.getElementById('ae-col-hue');
  const satVal = document.getElementById('ae-col-sat-v');
  const briVal = document.getElementById('ae-col-bri-v');
  const hueVal = document.getElementById('ae-col-hue-v');
  const resetColorBtn = document.getElementById('ae-col-reset');

  const DEF = { saturation: 1, brightness: 1, hue: 0 };
  const numOr = (v, d) => (typeof v === 'number' && isFinite(v)) ? v : d;

  // 初始值：优先读取已保存配置
  let color = { ...DEF };
  try {
    const saved = (state.settings && state.settings.pet && state.settings.pet.color) || {};
    color = {
      saturation: numOr(saved.saturation, DEF.saturation),
      brightness: numOr(saved.brightness, DEF.brightness),
      hue: numOr(saved.hue, DEF.hue)
    };
  } catch (e) { /* 配置缺失时用默认值 */ }

  function filterStr() {
    return `saturate(${color.saturation}) brightness(${color.brightness}) hue-rotate(${color.hue}deg)`;
  }
  function applyColor() {
    if (canvas) canvas.style.filter = filterStr();
    if (satVal) satVal.textContent = (+color.saturation).toFixed(2);
    if (briVal) briVal.textContent = (+color.brightness).toFixed(2);
    if (hueVal) hueVal.textContent = (color.hue > 0 ? '+' : '') + Math.round(color.hue) + '°';
  }
  function syncInputs() {
    if (satEl) satEl.value = color.saturation;
    if (briEl) briEl.value = color.brightness;
    if (hueEl) hueEl.value = color.hue;
  }
  function persist() {
    try { window.api.setConfig({ pet: { color: { saturation: color.saturation, brightness: color.brightness, hue: color.hue } } }); } catch (e) {}
  }

  // 初始化
  syncInputs();
  applyColor();

  // 复位视角：重置轨道相机到默认前视
  if (resetViewBtn) {
    resetViewBtn.addEventListener('click', () => {
      if (_actionPreview && typeof _actionPreview.setView === 'function') {
        _actionPreview.setView({ yaw: 0, pitch: 0, zoom: 1 });
      }
    });
  }

  // 色彩设置弹窗开合
  if (colorBtn && colorPop) {
    colorBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      colorPop.classList.toggle('open');
    });
    // 点击面板/按钮以外区域关闭弹窗
    document.addEventListener('click', (e) => {
      if (colorPop.classList.contains('open') && !colorPop.contains(e.target) && e.target !== colorBtn && !colorBtn.contains(e.target)) {
        colorPop.classList.remove('open');
      }
    });
  }

  if (satEl) satEl.addEventListener('input', () => { color.saturation = parseFloat(satEl.value); applyColor(); persist(); });
  if (briEl) briEl.addEventListener('input', () => { color.brightness = parseFloat(briEl.value); applyColor(); persist(); });
  if (hueEl) hueEl.addEventListener('input', () => { color.hue = parseFloat(hueEl.value); applyColor(); persist(); });
  if (resetColorBtn) resetColorBtn.addEventListener('click', () => {
    color = { ...DEF };
    syncInputs();
    applyColor();
    persist();
  });
}

// 预览专用「模型组件调整」：整体 / 选中身体部件的位移(X/Y/Z) + 缩放 + 旋转。
// 仅作用于预览，永不写入关键帧。支持「点击模型拾取部件」（参考 Unity 点击选中物体）。
function wireActionAdjust(ae) {
  const btn = document.getElementById('ae-adjust-btn');
  const bar = document.getElementById('ae-adjust-bar');
  const targetSel = document.getElementById('ae-adj-target');
  const modeBtns = bar ? Array.from(bar.querySelectorAll('.ae-adj-mode')) : [];
  const resetBtn = document.getElementById('ae-adj-reset');
  if (!btn || !bar) return;

  // 每个调整对象的状态（UI 直接存世界位移量，单位与模型一致；传给引擎叠加到基准位置）。
  // 部件调整以「位移」为主——拖拽关节即平移该关节，其下游子骨骼刚性跟随，不产生旋转累积（不会一直转）。
  const DEF_ST = () => ({ dx: 0, dy: 0, dz: 0 });
  ae._adjustByTarget = ae._adjustByTarget || { '': DEF_ST() };
  ae._adjTarget = ae._adjTarget || '';
  ae._adjMode = ae._adjMode || 'move';
  ae._previewAdjust = ae._previewAdjust || { root: { dx: 0, dy: 0, dz: 0, scale: 1 }, part: null };

  // 每次打开编辑器都重置为「环绕视角」模式，避免上次遗留的 _aeAdjustMode 仍为真导致画布一开就处于变换态
  _aeAdjustMode = false;
  btn.classList.remove('active');
  bar.classList.remove('open');

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  function valsFor(tgt) { return ae._adjustByTarget[tgt] || (ae._adjustByTarget[tgt] = DEF_ST()); }
  function setMode(m) {
    ae._adjMode = m;
    modeBtns.forEach((b) => b.classList.toggle('active', b.dataset.mode === m));
  }
  function syncTarget() { if (targetSel) targetSel.value = ae._adjTarget; }
  // 把当前调整状态推给引擎（仅叠加在预览上，永不写入关键帧）。
  // 部件以「位移」方式移动（dx/dy/dz 为世界空间增量，引擎会按父骨骼朝向转为局部并叠加到基准位置）。
  function applyAdj() {
    const st = valsFor(ae._adjTarget);
    const adj = {
      root: ae._adjustByTarget[''],   // 整体模型：仅用于取景（位移/等比缩放/整体旋转），不影响骨骼
      part: ae._adjTarget ? {
        name: ae._adjTarget,
        dx: st.dx, dy: st.dy, dz: st.dz   // 世界空间位移增量（引擎用）
      } : null
    };
    ae._previewAdjust = adj;
    if (_actionPreview && typeof _actionPreview.setAdjust === 'function') _actionPreview.setAdjust(adj);
  }

  setMode(ae._adjMode);
  syncTarget();

  // 齿轮按钮：开/关「调整模型」模式。开启后画布可直接点选部件、拖拽变换；关闭则恢复环绕视角
  btn.addEventListener('click', () => {
    const open = bar.classList.toggle('open');
    _aeAdjustMode = open;
    btn.classList.toggle('active', open);
    if (open) { setMode(ae._adjMode); syncTarget(); }
  });
  if (targetSel) targetSel.addEventListener('change', () => { ae._adjTarget = targetSel.value; applyAdj(); });
  modeBtns.forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
  if (resetBtn) resetBtn.addEventListener('click', () => {
    ae._adjustByTarget[ae._adjTarget] = DEF_ST();
    applyAdj();
  });

  // 画布拖拽：以「移动关节」为主——水平拖拽 → 世界 X（右为正），垂直拖拽 → 世界 Y（上为正）。
  // 直接平移当前选中关节，下游骨骼随之刚性跟随；不再做旋转，避免「一直旋转停不下来」。
  const MOVE_SENS = 0.03;   // 每像素对应的世界位移量
  const MOVE_LIMIT = 10;    // 单轴最大位移，防止关节被拖飞
  _aeAdjustDrag = (dx, dy) => {
    const st = valsFor(ae._adjTarget);
    st.dx = clamp(st.dx + dx * MOVE_SENS, -MOVE_LIMIT, MOVE_LIMIT);  // 水平拖拽 → 世界 X
    st.dy = clamp(st.dy - dy * MOVE_SENS, -MOVE_LIMIT, MOVE_LIMIT);  // 垂直拖拽 → 世界 Y（屏幕向下为负）
    applyAdj();
  };
  // 滚轮在「调整模型」模式下不再缩放对象，交由视角缩放（避免局部骨骼被缩放扭曲）。
  _aeAdjustWheel = null;
  // 点击模型拾取部件（参考 Unity 点击选中）：射线命中模型表面，选中离命中点最近的身体部件
  _aeAdjustClick = (clientX, clientY) => {
    if (!_actionPreview || typeof _actionPreview.pickPart !== 'function') return;
    const k = _actionPreview.pickPart(clientX, clientY);
    if (!k) return;
    ae._adjTarget = k;
    syncTarget();
    setMode('move'); // 选中部件后默认进入移动模式
    applyAdj();
  };
}

// 注入拖拽分隔条并绑定拖动逻辑（左↔中、中↔右、主区↔时间轴）
function initSplitters() {
  const grid = document.querySelector('.action-editor .ae-grid');
  if (!grid) return;
  const left = document.getElementById('ae-side-left');
  const center = grid.querySelector('.ae-col-center');
  const right = document.getElementById('ae-side-right');
  const timeline = document.querySelector('.action-editor .ae-timeline');

  // 水平分隔条：左↔中、中↔右
  if (left && center) {
    const spL = document.createElement('div');
    spL.className = 'ae-splitter ae-splitter-h'; spL.dataset.side = 'left';
    grid.insertBefore(spL, center);
  }
  if (center && right) {
    const spR = document.createElement('div');
    spR.className = 'ae-splitter ae-splitter-h'; spR.dataset.side = 'right';
    grid.insertBefore(spR, right);
  }
  // 垂直分隔条：主区 ↔ 时间轴（全宽）
  if (timeline && timeline.parentElement) {
    const spV = document.createElement('div');
    spV.className = 'ae-splitter ae-splitter-v';
    timeline.parentElement.insertBefore(spV, timeline);
  }

  grid.querySelectorAll('.ae-splitter-h').forEach(sp => sp.addEventListener('pointerdown', (e) => startSplitH(e, sp)));
  const spV = document.querySelector('.action-editor .ae-splitter-v');
  if (spV) spV.addEventListener('pointerdown', (e) => startSplitV(e, spV));
}

function startSplitH(e, sp) {
  e.preventDefault();
  const side = sp.dataset.side;
  const aside = document.getElementById(side === 'left' ? 'ae-side-left' : 'ae-side-right');
  const grid = aside.parentElement;
  const rect = grid.getBoundingClientRect();
  const move = (ev) => {
    let nb = side === 'left' ? (ev.clientX - rect.left) : (rect.right - ev.clientX);
    nb = Math.max(180, Math.min(560, nb));
    aside.style.flexBasis = nb + 'px';
    aside.dataset.basis = nb;
    window.dispatchEvent(new Event('resize'));
  };
  dragSplitEnd(sp, move);
}

function startSplitV(e, sp) {
  e.preventDefault();
  const timeline = document.querySelector('.action-editor .ae-timeline');
  const editor = document.querySelector('.action-editor');
  const startY = e.clientY;
  const startH = timeline.getBoundingClientRect().height;
  // 预览框最小保留高度：保证调高时间轴时模型永远不会被时间轴覆盖
  const MIN_PREVIEW = 160;
  const SPLITTER = 8;
  const TOOLBAR = (editor && editor.firstElementChild) ? editor.firstElementChild.getBoundingClientRect().height : 44;
  const maxH = editor ? Math.max(MIN_PREVIEW + SPLITTER, editor.clientHeight - TOOLBAR - SPLITTER - MIN_PREVIEW) : 520;
  const move = (ev) => {
    let dh = startH + (startY - ev.clientY); // 向上拖增大时间轴高度
    dh = Math.max(90, Math.min(maxH, dh));
    timeline.style.flex = '0 0 ' + dh + 'px';
    window.dispatchEvent(new Event('resize'));
  };
  dragSplitEnd(sp, move);
}

function dragSplitEnd(sp, move) {
  sp.classList.add('dragging');
  document.body.style.cursor = sp.classList.contains('ae-splitter-v') ? 'row-resize' : 'col-resize';
  document.body.style.userSelect = 'none';
  const up = () => {
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', up);
    sp.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    window.dispatchEvent(new Event('resize'));
  };
  document.addEventListener('pointermove', move);
  document.addEventListener('pointerup', up);
}

// 关闭动作编辑器：独立窗口关闭窗口，页内模态关闭模态
// 有未保存修改时弹出确认弹窗
async function closeActionEditor() {
  if (_aeDirty) {
    const confirmed = await showConfirm({
      type: 'warning',
      title: window.I18N?.t?.('unsavedTitle') || '未保存的修改',
      message: window.I18N?.t?.('unsavedMessage') || '当前动作有未保存的修改或新增内容，确定要退出吗？'
    });
    if (!confirmed) return; // 用户取消，不关闭
  }
  _destroyActionPreview();
  if (IS_EDITOR_WINDOW) { window.api.editor.close(); }
  else { closeModal(); }
}

// 把一个关键帧“浓缩”成一句人话：哪些骨骼被摆了、几个表情被触发，让列表/标记一眼看懂
function summarizeKeyframe(kf) {
  const bones = kf.bones || {};
  const morphs = kf.morphs || {};
  const labels = [];
  for (const [key, label] of ACTION_BONES) {
    const b = bones[key];
    if (b && (b.x || b.y || b.z)) labels.push(label);
  }
  let morphCount = 0;
  for (const k in morphs) if (morphs[k] > 0) morphCount++;
  const parts = [];
  if (labels.length) {
    const head = labels.slice(0, 3).join('·');
    parts.push(labels.length > 3 ? `${head}等${labels.length}骨` : `${head}骨`);
  }
  if (morphCount) parts.push(`${morphCount}表情`);
  return parts.length ? parts.join(' · ') : '仅整体位姿';
}

function renderKeyframeList(ae) {
  const t = window.I18N?.t || ((k) => k);
  const listEl = document.getElementById('ae-kf-list');
  if (!listEl) return;
  listEl.innerHTML = '';
  const CIRCLED = ['①','②','③','④','⑤','⑥','⑦','⑧','⑨','⑩'];
  ae.def.keyframes.forEach((kf, i) => {
    const item = document.createElement('div');
    item.className = 'ae-kf-item' + (i === ae.kfIndex ? ' active' : '');
    const idx = CIRCLED[i] || (i + 1);
    const sum = summarizeKeyframe(kf);
    item.innerHTML = `<span class="ae-kf-idx" title="关键帧 ${i + 1}">${idx}</span>
      <span class="ae-kf-t">${(+kf.t).toFixed(2)}</span>
      <span class="ae-kf-sum" title="${sum}">${sum}</span>
      <button class="ae-kf-del" title="${t('actions.removeKeyframe')}">×</button>`;
    item.addEventListener('click', (e) => {
      if (e.target.classList.contains('ae-kf-del')) {
        if (ae.def.keyframes.length <= 1) { showToast(t('actions.tooFewKeyframes'), '', 'warning'); return; }
        ae.def.keyframes.splice(i, 1);
        if (ae.kfIndex >= ae.def.keyframes.length) ae.kfIndex = ae.def.keyframes.length - 1;
        renderKeyframeList(ae); renderKeyframeBody(ae); renderTimelineMarkers(ae);
        _syncPreviewDef(ae);
        _aeDirty = true;
        return;
      }
      ae.kfIndex = i;
      renderKeyframeList(ae); renderKeyframeBody(ae); renderTimelineMarkers(ae);
      const kf = ae.def.keyframes[ae.kfIndex];
      if (kf) seekPreview(kf.t);
    });
    listEl.appendChild(item);
  });
}

function renderKeyframeBody(ae) {
  const t = window.I18N?.t || ((k) => k);
  const bodyEl = document.getElementById('ae-kf-body');
  if (!bodyEl) return;
  if (!ae || !ae.def || !Array.isArray(ae.def.keyframes)) { bodyEl.innerHTML = ''; return; }
  if (ae.kfIndex < 0 || ae.kfIndex >= ae.def.keyframes.length) { bodyEl.innerHTML = ''; return; }
  try {
  const kf = ae.def.keyframes[ae.kfIndex];
  if (!kf) { bodyEl.innerHTML = ''; return; }
  kf.bones = kf.bones || {}; kf.root = kf.root || {}; kf.morphs = kf.morphs || {};

  let html = `<div class="ae-field ae-kf-time-row"><label>${t('actions.time')}</label>
    <input type="number" id="ae-kf-time" min="0" max="1" step="0.01" value="${kf.t}">
    <button class="btn btn-sm" id="ae-mirror" title="把当前帧的左右姿势镜像到对侧（一键做对称姿势）">⇄ 镜像左右</button></div>`;

  html += `<div class="ae-bones-title">${t('actions.bones')}</div><div class="ae-bone-grid">`;
  for (const [key, label] of ACTION_BONES) {
    const b = kf.bones[key] || {};
    html += `<div class="ae-bone-row" data-bone="${key}">
      <span class="ae-bone-name" title="${key}">${label}</span>
      <div class="ae-axis-seg" data-bone="${key}">
        <button type="button" class="ae-axis-btn active" data-axis="x">X</button>
        <button type="button" class="ae-axis-btn" data-axis="y">Y</button>
        <button type="button" class="ae-axis-btn" data-axis="z">Z</button>
      </div>
      <input type="number" step="1" class="ae-bx" data-bone="${key}" data-axis="x" value="${radToDeg(b.x)}">
      <div class="ae-knob-slot" data-bone="${key}"></div>
    </div>`;
  }
  html += `</div>`;

  const r = kf.root;
  html += `<div class="ae-bones-title">${t('actions.root')}</div><div class="ae-root-row">
    <label class="ae-root-y-label">${t('actions.rootY')}</label><input type="number" id="ae-root-y" step="0.01" min="-0.6" max="0.6" value="${r.y || 0}">
    <span class="ae-bone-name">${t('actions.rootRot')}</span>
    <div class="ae-axis-seg" id="ae-root-axis">
      <button type="button" class="ae-axis-btn active" data-axis="x">X</button>
      <button type="button" class="ae-axis-btn" data-axis="y">Y</button>
      <button type="button" class="ae-axis-btn" data-axis="z">Z</button>
    </div>
    <div class="ae-knob-slot" id="ae-root-knob"></div>
    <input type="number" step="1" class="ae-root-rot" id="ae-root-rot" data-axis="x" value="${radToDeg(r.rotX)}">
  </div>`;

  html += `<div class="ae-bones-title">${t('actions.morphs')}</div><div class="ae-morph-grid">`;
  for (const [key, label] of ACTION_MORPHS) {
    const w = kf.morphs[key] || 0;
    const on = w > 0;
    html += `<div class="ae-morph-row">
      <input type="checkbox" class="ae-morph-cb" data-morph="${key}" ${on ? 'checked' : ''}>
      <span class="ae-morph-name">${label}</span>
      <input type="range" min="0" max="1" step="0.05" class="ae-morph-range" data-morph="${key}" value="${w}" ${on ? '' : 'disabled'}></div>`;
  }
  html += `</div>`;

  bodyEl.innerHTML = html;
  document.getElementById('ae-kf-t-val').textContent = (+kf.t).toFixed(2);

  document.getElementById('ae-kf-time').addEventListener('input', (e) => {
    let v = parseFloat(e.target.value); if (!isFinite(v)) v = 0;
    kf.t = Math.max(0, Math.min(1, v));
    ae.def.keyframes.sort((a, b) => a.t - b.t);
    ae.kfIndex = ae.def.keyframes.indexOf(kf);
    renderKeyframeList(ae); renderTimelineMarkers(ae);
    const items = document.querySelectorAll('#ae-kf-list .ae-kf-item');
    if (items[ae.kfIndex]) items[ae.kfIndex].querySelector('.ae-kf-t').textContent = (+kf.t).toFixed(2);
    const tv = document.getElementById('ae-kf-t-val'); if (tv) tv.textContent = (+kf.t).toFixed(2);
    _syncPreviewDef(ae); updatePlayhead(kf.t);
    _aeDirty = true;
  });
  const mirrorBtn = document.getElementById('ae-mirror');
  if (mirrorBtn) mirrorBtn.addEventListener('click', () => mirrorKeyframeLR(ae));
  // 骨骼旋转：旋钮 + XYZ 轴选择（旋转角度用旋钮定位）
  bodyEl.querySelectorAll('.ae-bone-row').forEach(row => {
    const key = row.dataset.bone;
    const knobSlot = row.querySelector('.ae-knob-slot');
    const num = row.querySelector('.ae-bx');
    const segBtns = row.querySelectorAll('.ae-axis-btn');
    const axisOf = () => row.querySelector('.ae-axis-btn.active').dataset.axis;
    const degOf = (axis) => radToDeg((kf.bones[key] || {})[axis] || 0);
    const writeBone = (axis, deg) => {
      kf.bones[key] = kf.bones[key] || {};
      kf.bones[key][axis] = degToRad(deg);
      if (!kf.bones[key].x && !kf.bones[key].y && !kf.bones[key].z) delete kf.bones[key];
    };
    const knob = makeKnob({ value: degOf('x'), onChange: (deg) => { writeBone(axisOf(), deg); num.value = Math.round(deg); _syncPreviewDef(ae); _aeDirty = true; } });
    knobSlot.appendChild(knob.el);
    segBtns.forEach(btn => btn.addEventListener('click', () => {
      segBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const axis = btn.dataset.axis;
      const deg = degOf(axis);
      knob.setValue(deg);
      num.dataset.axis = axis;
      num.value = Math.round(deg);
    }));
    num.addEventListener('input', () => {
      const axis = axisOf();
      const deg = parseFloat(num.value) || 0;
      writeBone(axis, deg);
      knob.setValue(deg);
      _syncPreviewDef(ae);
      _aeDirty = true;
    });
  });

  // 根旋转：旋钮 + XYZ 轴选择
  {
    const rootAxis = bodyEl.querySelector('#ae-root-axis');
    const rootKnobSlot = bodyEl.querySelector('#ae-root-knob');
    const rootNum = bodyEl.querySelector('#ae-root-rot');
    if (rootAxis && rootKnobSlot && rootNum) {
      const segBtns = rootAxis.querySelectorAll('.ae-axis-btn');
      const axisOf = () => rootAxis.querySelector('.ae-axis-btn.active').dataset.axis;
      const degOf = (axis) => radToDeg((kf.root['rot' + axis.toUpperCase()] || 0));
      const writeRot = (axis, deg) => { kf.root['rot' + axis.toUpperCase()] = degToRad(deg); };
      const knob = makeKnob({ value: degOf('x'), onChange: (deg) => { writeRot(axisOf(), deg); rootNum.value = Math.round(deg); _syncPreviewDef(ae); _aeDirty = true; } });
      rootKnobSlot.appendChild(knob.el);
      segBtns.forEach(btn => btn.addEventListener('click', () => {
        segBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const axis = btn.dataset.axis;
        const deg = degOf(axis);
        knob.setValue(deg);
        rootNum.dataset.axis = axis;
        rootNum.value = Math.round(deg);
      }));
      rootNum.addEventListener('input', () => {
        const axis = axisOf();
        const deg = parseFloat(rootNum.value) || 0;
        writeRot(axis, deg);
        knob.setValue(deg);
        _syncPreviewDef(ae);
        _aeDirty = true;
      });
    }
  }

  const ry = document.getElementById('ae-root-y'); if (ry) ry.addEventListener('input', () => { kf.root.y = parseFloat(ry.value) || 0; _syncPreviewDef(ae); _aeDirty = true; });
  bodyEl.querySelectorAll('.ae-morph-cb').forEach(cb => cb.addEventListener('change', () => {
    const key = cb.dataset.morph;
    if (cb.checked) {
      // 单选：一个关键帧只对应一个表情，勾选时取消其它已选表情
      kf.morphs = {};
      bodyEl.querySelectorAll('.ae-morph-cb').forEach(other => {
        if (other === cb) return;
        other.checked = false;
        const or = bodyEl.querySelector(`.ae-morph-range[data-morph="${other.dataset.morph}"]`);
        if (or) or.disabled = true;
      });
      const range = bodyEl.querySelector(`.ae-morph-range[data-morph="${key}"]`);
      if (range) { range.disabled = false; kf.morphs[key] = parseFloat(range.value) || 0.6; }
      else kf.morphs[key] = 0.6;
    } else {
      delete kf.morphs[key];
    }
    _syncPreviewDef(ae);
    _aeDirty = true;
  }));
  bodyEl.querySelectorAll('.ae-morph-range').forEach(rg => rg.addEventListener('input', () => {
    const key = rg.dataset.morph;
    if (kf.morphs[key] != null) kf.morphs[key] = parseFloat(rg.value) || 0;
    _syncPreviewDef(ae);
    _aeDirty = true;
  }));
  wrapNumberSteppers(bodyEl);
  } catch (e) {
    console.error('[renderKeyframeBody] 渲染失败:', e);
    bodyEl.innerHTML = '<div style="color:#f66;padding:8px;font-size:12px">关键帧参数渲染失败: ' + escapeHtml(e.message) + '</div>';
  }
}

// 把容器内的 <input type="number"> 包裹成主题化 −/+ 步进器（复用系统设置页 .stepper-wrapper 组件）：
// 点击 −/+ 按 step 增减并触发 input 事件，使现有监听器（骨骼/位移/表情/相关参数）照常生效。
function wrapNumberSteppers(scope) {
  if (!scope || !window.ElIcons) return;
  scope.querySelectorAll('input[type="number"]').forEach(inp => {
    if (inp.closest('.stepper-wrapper')) return;
    const wrap = document.createElement('span');
    wrap.className = 'stepper-wrapper';
    inp.parentNode.insertBefore(wrap, inp);
    wrap.appendChild(inp);
    const dec = document.createElement('button');
    dec.type = 'button'; dec.className = 'stepper-btn'; dec.title = '−';
    dec.innerHTML = window.ElIcons.getIcon('minus');
    const inc = document.createElement('button');
    inc.type = 'button'; inc.className = 'stepper-btn'; inc.title = '+';
    inc.innerHTML = window.ElIcons.getIcon('plusSimple');
    wrap.insertBefore(dec, inp);
    wrap.appendChild(inc);
    const stepOf = () => { const s = parseFloat(inp.getAttribute('step')); return (isFinite(s) && s !== 0) ? Math.abs(s) : 1; };
    const clamp = (v) => {
      const min = parseFloat(inp.getAttribute('min'));
      const max = parseFloat(inp.getAttribute('max'));
      if (isFinite(min) && v < min) v = min;
      if (isFinite(max) && v > max) v = max;
      return v;
    };
    const bump = (dir) => {
      let v = parseFloat(inp.value);
      if (!isFinite(v)) v = parseFloat(inp.getAttribute('value')) || 0;
      v = clamp(+(v + dir * stepOf()).toFixed(6));
      inp.value = String(v);
      inp.dispatchEvent(new Event('input', { bubbles: true }));
    };
    dec.addEventListener('click', () => bump(-1));
    inc.addEventListener('click', () => bump(1));
  });
}

// 旋转角度旋钮（圆盘拖拽 + 滚轮微调）：返回 { el, setValue }。
// 交互：在圆盘上按下并绕中心画圆 → 角度跟随（0° 在 12 点方向，顺时针为正）；
// 也支持鼠标滚轮 ±1°。value 单位：度，范围 [min,max]。
function makeKnob({ value = 0, min = -180, max = 180, size = 46, onChange } = {}) {
  const NS = 'http://www.w3.org/2000/svg';
  const el = document.createElement('div');
  el.className = 'ae-knob';
  el.title = '拖拽旋转 / 滚轮微调角度';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 100 100');
  svg.setAttribute('width', '100%'); svg.setAttribute('height', '100%');
  const track = document.createElementNS(NS, 'circle');
  track.setAttribute('cx', 50); track.setAttribute('cy', 50); track.setAttribute('r', 40);
  track.setAttribute('class', 'ae-knob-track');
  const ptr = document.createElementNS(NS, 'line');
  ptr.setAttribute('x1', 50); ptr.setAttribute('y1', 50);
  ptr.setAttribute('x2', 50); ptr.setAttribute('y2', 12);
  ptr.setAttribute('class', 'ae-knob-ptr');
  const txt = document.createElementNS(NS, 'text');
  txt.setAttribute('x', 50); txt.setAttribute('y', 56);
  txt.setAttribute('text-anchor', 'middle');
  txt.setAttribute('class', 'ae-knob-val');
  svg.appendChild(track); svg.appendChild(ptr); svg.appendChild(txt);
  el.appendChild(svg);

  let val = value;
  const clamp = (v) => Math.max(min, Math.min(max, v));
  function render() {
    ptr.setAttribute('transform', `rotate(${val} 50 50)`);
    txt.textContent = Math.round(val) + '°';
  }
  function setVal(v, fire = true) { val = clamp(v); render(); if (fire && onChange) onChange(val); }

  const topAngle = (clientX, clientY) => {
    const r = svg.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    // 标准 atan2：0° 在 3 点方向，顺时针为正（屏幕 y 向下）；+90° 使 0° 落在 12 点方向
    return Math.atan2(clientY - cy, clientX - cx) * 180 / Math.PI + 90;
  };
  let dragging = false, prevTop = 0;
  const onMove = (e) => {
    if (!dragging) return;
    let d = topAngle(e.clientX, e.clientY) - prevTop;
    while (d > 180) d -= 360; while (d < -180) d += 360;
    prevTop = topAngle(e.clientX, e.clientY);
    setVal(val + d);
  };
  const onUp = () => {
    dragging = false;
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    el.classList.remove('dragging');
  };
  el.addEventListener('pointerdown', (e) => {
    dragging = true; prevTop = topAngle(e.clientX, e.clientY);
    el.classList.add('dragging');
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    e.preventDefault();
  });
  el.addEventListener('wheel', (e) => { e.preventDefault(); setVal(val + (e.deltaY < 0 ? 1 : -1)); }, { passive: false });

  render();
  return { el, setValue: (v) => setVal(v, false) };
}

// 相关动作条目规范化：兼容旧格式「字符串键」与新格式「{key,count,interval,loop}」
function normalizeRelatedEntry(r, idx, arr) {
  const n = (arr && arr.length) ? arr.length : 1;
  const spread = (idx + 1) / (n + 1); // 缺省沿时间轴均布
  if (typeof r === 'string') return { key: r, count: 1, interval: 0, loop: false, t: spread };
  if (!r || !r.key) return null;
  const t = (typeof r.t === 'number' && isFinite(r.t)) ? Math.max(0, Math.min(1, r.t)) : spread;
  return {
    key: r.key,
    count: (r.count && r.count > 1) ? r.count : 1,
    interval: (r.interval && r.interval > 0) ? r.interval : 0,
    loop: !!r.loop,
    t
  };
}

function renderRelatedList(ae) {
  const t = window.I18N?.t || ((k) => k);
  const listEl = document.getElementById('ae-related-list');
  if (!listEl) return;
  // 规范化：旧格式字符串或新格式对象统一处理
  ae.def.related = (ae.def.related || []).map(normalizeRelatedEntry).filter(r => r && r.key);

  const labelOf = (key) => {
    const bu = BUILTIN_ACTIONS.find(a => a.key === key);
    if (bu) return bu.label;
    if (ae.data.actions[key]) return ae.data.actions[key].label || key;
    return key;
  };

  const rel = ae.def.related;
  const dur = (ae.def.duration || 2);
  if (rel.length === 0) {
    listEl.innerHTML = `<div class="ae-note">${t('actions.noRelated')}</div>`;
  } else {
    listEl.innerHTML = rel.map((r, i) => `
      <div class="ae-related-row${_bpIndex === i ? ' ae-rel-active' : ''}">
        <div class="ae-rel-reorder">
          <button class="ae-rel-btn" data-edit="${r.key}" title="${t('related.edit')}">${window.ElIcons.getIcon('edit')}</button>
          <button class="ae-rel-btn" data-up="${i}" ${i === 0 ? 'disabled' : ''} title="${t('related.up')}">${window.ElIcons.getIcon('up')}</button>
          <button class="ae-rel-btn" data-down="${i}" ${i === rel.length - 1 ? 'disabled' : ''} title="${t('related.down')}">${window.ElIcons.getIcon('down')}</button>
        </div>
        <div class="ae-rel-main">
          <div class="ae-rel-label">${escapeHtml(labelOf(r.key))}</div>
          <div class="ae-rel-params">
            <label class="ae-rel-field"><span>${t('related.time')}</span><input type="number" class="ae-rel-t" data-i="${i}" min="0" max="${dur}" step="0.05" value="${(r.t * dur).toFixed(2)}"></label>
            <label class="ae-rel-field"><span>${t('related.count')}</span><input type="number" class="ae-rel-count" data-i="${i}" min="1" max="20" step="1" value="${r.count}"></label>
            <label class="ae-rel-field"><span>${t('related.interval')}</span><input type="number" class="ae-rel-interval" data-i="${i}" min="0" max="10" step="0.1" value="${r.interval}"></label>
            <label class="ae-rel-field ae-rel-loop"><input type="checkbox" class="ae-rel-loop" data-i="${i}" ${r.loop ? 'checked' : ''}><span>${t('actions.loop')}</span></label>
          </div>
        </div>
        <button class="ae-rel-btn ae-rel-remove" data-remove="${i}" title="${t('related.remove')}">×</button>
      </div>`).join('');
  }

  listEl.querySelectorAll('[data-up]').forEach(b => b.addEventListener('click', () => {
    const i = +b.dataset.up; if (i <= 0) return;
    const tmp = ae.def.related[i - 1]; ae.def.related[i - 1] = ae.def.related[i]; ae.def.related[i] = tmp;
    renderRelatedList(ae);
  }));
  listEl.querySelectorAll('[data-down]').forEach(b => b.addEventListener('click', () => {
    const i = +b.dataset.down; if (i >= ae.def.related.length - 1) return;
    const tmp = ae.def.related[i + 1]; ae.def.related[i + 1] = ae.def.related[i]; ae.def.related[i] = tmp;
    renderRelatedList(ae);
  }));
  listEl.querySelectorAll('[data-remove]').forEach(b => b.addEventListener('click', () => {
    ae.def.related.splice(+b.dataset.remove, 1);
    renderRelatedList(ae);
  }));
  // 直接打开「相关动作」进行编辑（绑定到该动作本身，而非联合/选择模式）
  listEl.querySelectorAll('[data-edit]').forEach(b => b.addEventListener('click', () => {
    const key = b.dataset.edit;
    if (!key) return;
    const isBuiltin = !!BUILTIN_ACTIONS.find(a => a.key === key);
    window.api.editor.open({ modelId: ae.model.id, actionKey: key, isNew: false, isBuiltin });
  }));
  listEl.querySelectorAll('.ae-rel-count').forEach(inp => inp.addEventListener('input', () => {
    const i = +inp.dataset.i; const v = parseInt(inp.value, 10);
    if (ae.def.related[i]) ae.def.related[i].count = (v > 1 ? v : 1);
  }));
  listEl.querySelectorAll('.ae-rel-interval').forEach(inp => inp.addEventListener('input', () => {
    const i = +inp.dataset.i; const v = parseFloat(inp.value);
    if (ae.def.related[i]) ae.def.related[i].interval = (isFinite(v) && v > 0 ? v : 0);
  }));
  listEl.querySelectorAll('.ae-rel-loop').forEach(cb => cb.addEventListener('change', () => {
    const i = +cb.dataset.i;
    if (ae.def.related[i]) ae.def.related[i].loop = cb.checked;
  }));
  listEl.querySelectorAll('.ae-rel-t').forEach(inp => inp.addEventListener('input', () => {
    const i = +inp.dataset.i; const d = (ae.def.duration || 2); const v = parseFloat(inp.value);
    if (ae.def.related[i] && isFinite(v)) ae.def.related[i].t = Math.max(0, Math.min(d, v)) / d;
  }));

  // 添加相关动作（排除自身与已添加的）
  const curKey = ae.isNew ? null : ae.key;
  const usedKeys = new Set(ae.def.related.map(r => r.key));
  const all = BUILTIN_ACTIONS.concat(
    Object.keys(ae.data.actions).map(k => ({ key: k, label: ae.data.actions[k].label || k }))
  );
  const avail = all.filter(a => a.key !== curKey && !usedKeys.has(a.key));
  const addWrap = document.createElement('div');
  addWrap.className = 'ae-rel-add';
  addWrap.innerHTML = `
    <select class="ae-rel-select" id="ae-rel-select">
      <option value="">${t('related.select')}</option>
      ${avail.map(a => `<option value="${a.key}">${escapeHtml(a.label)}</option>`).join('')}
    </select>
    <button class="btn btn-sm" id="ae-rel-add-btn">+ ${t('related.add')}</button>`;
  listEl.appendChild(addWrap);
  document.getElementById('ae-rel-add-btn').addEventListener('click', () => {
    const sel = document.getElementById('ae-rel-select');
    const key = sel && sel.value;
    if (!key) return;
    ae.def.related.push({ key, count: 1, interval: 0, loop: false });
    renderRelatedList(ae);
  });
  wrapNumberSteppers(listEl);
  // 首次渲染时自绘下拉 wrapper 的 flex 宽度可能算偏几像素，把右侧「+ 添加相关动作」按钮顶出
  // 滚动容器右边界被裁（表现为默认打开按钮缺一个字，手动 resize 窗口后正常）。
  // 下一帧强制重排一次，等价于手动调整窗口大小，确保首屏布局即正确。
  requestAnimationFrame(() => requestAnimationFrame(() => window.dispatchEvent(new Event('resize'))));
}


function buildActionDef(ae) {
  const def = JSON.parse(JSON.stringify(ae.def));
  def.keyframes = (def.keyframes || []).map(normalizeKeyframe).sort((a, b) => a.t - b.t);
  def.speed = (typeof def.speed === 'number' && def.speed > 0) ? def.speed : 1;
  return def;
}

function previewCurrentAction(ae) {
  const t = window.I18N?.t || ((k) => k);
  if (ae.isBuiltin) { showToast(t('actions.previewNoPet'), '', 'info'); return; }
  if (!ae.def.keyframes || !ae.def.keyframes.length) { showToast(t('actions.tooFewKeyframes'), '', 'warning'); return; }
  const def = buildActionDef(ae);
  window.api.previewActionInPet(def).catch(() => {});
  showToast(t('actions.previewInPet'), t('actions.previewSent'), 'info');
}

// 供 visualEditor 的代码控制台 / AI 助手调用：修改 ae.def 后统一重绘动作编辑器（关键帧列表/编辑/时间轴/相关动作/预览同步）
window.refreshActionEditor = function (ae) {
  if (!ae) return;
  if (!ae.isBuiltin) {
    if (typeof renderKeyframeList === 'function') renderKeyframeList(ae);
    if (typeof renderKeyframeBody === 'function') renderKeyframeBody(ae);
    if (typeof renderTimelineMarkers === 'function') renderTimelineMarkers(ae);
  }
  if (typeof renderRelatedList === 'function') renderRelatedList(ae);
  if (typeof _syncPreviewDef === 'function') _syncPreviewDef(ae);
  const kf = (ae.def.keyframes && ae.def.keyframes[ae.kfIndex]) ? ae.def.keyframes[ae.kfIndex] : null;
  if (typeof seekPreview === 'function') seekPreview((kf && kf.t) || 0);
};

async function saveActionEditor(ae) {
  const t = window.I18N?.t || ((k) => k);
  const def = ae.def;
  if (!def.label || !def.label.trim()) { showToast('请填写动作名称', '', 'warning'); return; }
  def.label = def.label.trim();
  if (!ae.isBuiltin) {
    if (!def.keyframes || def.keyframes.length === 0) { showToast(t('actions.tooFewKeyframes'), '', 'warning'); return; }
    def.keyframes = def.keyframes.map(normalizeKeyframe).sort((a, b) => a.t - b.t);
  }
  def.related = (def.related || []).map(normalizeRelatedEntry).filter(r => r && r.key);
  if (ae.isNew || !def.key) def.key = generateActionKey(ae.data, def.label);
  def.key = String(def.key);
  ae.data.actions[def.key] = def;
  const r = await persistActions(ae.model, ae.data);
  if (r && r.success) {
    showToast(t('actions.saved'), '', 'success');
    _aeDirty = false; // 保存成功，重置脏标记
    if (IS_EDITOR_WINDOW) {
      try { await window.api.editor.saved(ae.model.id); } catch (e) {}
      closeActionEditor();
    } else {
      closeModal();
      showModelInfo(ae.model);
    }
  } else {
    showToast(t('actions.saveFail'), (r && r.error) || '', 'error');
  }
}

// 缩略图改为导入时智能匹配模型目录中的图片，不再提供手动编辑（见 modelManager.importModel）

// 保存模型名称与描述
async function saveModelEdits(model) {
  const name = document.getElementById('input-edit-name').value.trim();
  const description = document.getElementById('input-edit-desc').value;
  if (!name) {
    showToast('名称不能为空', '', 'warning');
    return;
  }
  const result = await window.api.updateModel(model.id, { name, description });
  if (result.success) {
    state.models = await window.api.listModels();
    renderModelList();
    const updated = state.models.find(m => m.id === model.id) || model;
    showModelInfo(updated);
    updateModelStatusBar();
    showToast('已保存', '', 'success');
  } else {
    showToast('保存失败', result.error, 'error');
  }
}

function getModelIcon(format, thumbnail) {
  if (thumbnail) {
    // 用 data-thumb 标记，渲染后通过 IPC 异步读取转 base64（规避协议/CORS 问题）
    return `<div class="model-thumb-wrap" data-thumb="${thumbnail.replace(/"/g, '&quot;')}">${window.ElIcons.getIcon('model')}</div>`;
  }
  return window.ElIcons.getIcon('model');
}

// 异步加载模型缩略图（IPC 读取 → base64 data URL）
async function loadModelThumbnails() {
  const wraps = document.querySelectorAll('.model-thumb-wrap[data-thumb]');
  for (const wrap of wraps) {
    const thumbPath = wrap.dataset.thumb;
    if (!thumbPath || wrap.dataset.loaded) continue;
    wrap.dataset.loaded = '1';
    try {
      const result = await window.api.readFile({ path: thumbPath, encoding: 'base64' });
      if (result && result.success && result.data) {
        const ext = (thumbPath.split('.').pop() || 'png').toLowerCase();
        const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : 'image/png';
        wrap.innerHTML = `<img class="model-thumb-img" src="data:${mime};base64,${result.data}" alt="">`;
      } else {
        wrap.innerHTML = window.ElIcons.getIcon('model');
      }
    } catch (e) {
      wrap.innerHTML = window.ElIcons.getIcon('model');
    }
  }
}

function createEmptyState() {
  const div = document.createElement('div');
  div.className = 'empty-state';
  div.innerHTML = `
    <div class="empty-icon">${window.ElIcons.getIcon('models')}</div>
    <div class="empty-text">还没有导入自定义模型</div>
    <div class="empty-hint">支持 Live2D (.model3.json / .model2.json) 和 MMD (.pmx / .pmd)</div>
  `;
  return div;
}

function createSoftwareEmptyState() {
  const div = document.createElement('div');
  div.className = 'empty-state';
  div.innerHTML = `
    <div class="empty-icon">${window.ElIcons.getIcon('software')}</div>
    <div class="empty-text">未检测到已安装软件</div>
    <div class="empty-hint">点击"刷新列表"重新扫描系统已安装的软件</div>
  `;
  return div;
}

// ==================== 文件管理 ====================
async function loadFileList() {
  const pathInput = document.getElementById('current-path');
  const pathValue = state.currentPath || window.api.os.homedir() || '';
  pathInput.value = pathValue;

  try {
    const result = await window.api.listFiles({ path: pathValue });
    if (result.success) {
      state.fileTree = result.data;
      state.currentPath = result.path;
      renderFileList(result.data);
      document.getElementById('file-count').textContent = (window.I18N?.t || ((k) => k))('files.itemCount', { count: result.total });
    } else {
      showToast('加载失败', result.error, 'error');
    }
  } catch (err) {
    showToast('加载失败', err.message, 'error');
  }
}

function renderFileList(files) {
  const listEl = document.getElementById('file-list');
  listEl.innerHTML = '';

  // 上级目录
  if (state.currentPath) {
    const upItem = document.createElement('div');
    upItem.className = 'file-item';
    upItem.innerHTML = `
      <div class="file-item-icon">${window.ElIcons.ICONS.folder}</div>
      <div class="file-item-name">.. (上级目录)</div>
      <div class="file-item-size"></div>
      <div class="file-item-date"></div>
      <div class="file-item-actions"></div>
    `;
    upItem.addEventListener('dblclick', () => {
      state.currentPath = window.api.path.dirname(state.currentPath);
      loadFileList();
    });
    listEl.appendChild(upItem);
  }

  const sorted = [...files].sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  for (const file of sorted) {
    const item = document.createElement('div');
    item.className = 'file-item';
    const sizeText = file.accessDenied ? '不可访问' : (file.isDirectory ? '' : formatSize(file.size));
    const dateText = file.modified ? new Date(file.modified).toLocaleDateString() : '';
    item.innerHTML = `
      <div class="file-item-icon">${file.isDirectory ? window.ElIcons.ICONS.folder : getFileIcon(file.name)}</div>
      <div class="file-item-name" title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</div>
      <div class="file-item-size">${sizeText}</div>
      <div class="file-item-date">${dateText}</div>
      <div class="file-item-actions">
        <button class="file-action-btn" title="打开">${file.isDirectory ? window.ElIcons.ICONS.folder : window.ElIcons.ICONS.externalLink}</button>
        <button class="file-action-btn danger" title="删除">${window.ElIcons.ICONS.delete}</button>
      </div>
    `;

    item.addEventListener('dblclick', () => {
      if (file.isDirectory) {
        state.currentPath = file.path;
        loadFileList();
      } else {
        openFile(file);
      }
    });

    item.querySelectorAll('.file-action-btn')[0].addEventListener('click', () => openFile(file));
    item.querySelectorAll('.file-action-btn')[1].addEventListener('click', () => deleteFile(file));

    listEl.appendChild(item);
  }
}

function getFileIcon(name) {
  return window.ElIcons.getFileIconSVG(name);
}

async function openFile(file) {
  if (file.isDirectory) {
    state.currentPath = file.path;
    loadFileList();
  } else {
    await window.api.openPath(file.path);
  }
}

async function deleteFile(file) {
  const isDanger = file.path && (state.settings.system?.confirmDangerOps !== false);

  if (isDanger) {
    const confirmed = await showConfirm({
      type: 'warning',
      title: '删除确认',
      message: `确定要删除「${file.name}」吗？`,
      detail: `路径：${file.path}\n此操作不可恢复。`
    });
    if (!confirmed) return;
  }

  const result = await window.api.deleteFile({ path: file.path, recursive: file.isDirectory });
  if (result.success) {
    showToast('删除成功', '', 'success');
    loadFileList();
  } else {
    showToast('删除失败', result.error, 'error');
  }
}

async function createNewFolder() {
  const name = await window.AppDialog.prompt({
    title: '新建文件夹',
    message: '请输入文件夹名称：',
    placeholder: '文件夹名称'
  });
  if (!name) return;

  const path = window.api.path.join(state.currentPath || window.api.os.homedir(), name);
  const result = await window.api.createDir({ path });
  if (result.success) {
    showToast('创建成功', '', 'success');
    loadFileList();
  } else {
    showToast('创建失败', result.error, 'error');
  }
}

async function uploadFile() {
  const paths = await window.api.selectFiles();
  if (!paths || paths.length === 0) return;

  showToast('正在上传...', `${paths.length} 个文件`, 'info');

  for (const filePath of paths) {
    const fileName = window.api.path.basename(filePath);
    const destPath = window.api.path.join(state.currentPath || window.api.os.homedir(), fileName);
    await window.api.copyFile({ sourcePath: filePath, destPath });
  }

  showToast('上传完成', `${paths.length} 个文件已上传`, 'success');
  loadFileList();
}

async function searchFiles() {
  const query = document.getElementById('file-search').value.trim();
  if (!query) {
    loadFileList();
    return;
  }
  try {
    const searchPath = state.currentPath || window.api.os.homedir();
    const result = await window.api.searchFiles({ query, path: searchPath });
    if (result.success) {
      state.fileTree = result.data;
      renderFileList(result.data);
      document.getElementById('file-count').textContent = (window.I18N?.t || ((k) => k))('files.itemCount', { count: result.total });
    } else {
      showToast('搜索失败', result.error, 'error');
    }
  } catch (err) {
    showToast('搜索失败', err.message, 'error');
  }
}

// ==================== 命令终端 ====================
async function executeCommand() {
  const input = document.getElementById('terminal-input');
  const cmd = input.value.trim();
  if (!cmd) return;

  input.value = '';

  appendTerminalLine('cmd', `❯ ${cmd}`);

  try {
    const result = await window.api.executeCommand({ command: cmd });

    if (result.stdout) appendTerminalLine('output', result.stdout);
    if (result.stderr) appendTerminalLine('error', result.stderr);

    if (result.timedOut) {
      appendTerminalLine('error', '[命令执行超时]');
    }

    addToHistory(cmd);
  } catch (err) {
    appendTerminalLine('error', err.message);
  }
}

function appendTerminalLine(type, text) {
  const container = document.getElementById('terminal-output');
  const line = document.createElement('div');
  line.className = `terminal-line ${type}`;
  line.textContent = text;
  container.appendChild(line);
  container.scrollTop = container.scrollHeight;
}

function addToHistory(cmd) {
  if (state.commandHistory.includes(cmd)) return;
  state.commandHistory.unshift(cmd);
  if (state.commandHistory.length > 20) state.commandHistory.pop();
  renderHistory();
}

function renderHistory() {
  const list = document.getElementById('history-list');
  list.innerHTML = '';
  state.commandHistory.forEach(cmd => {
    const item = document.createElement('div');
    item.className = 'history-item';
    item.textContent = cmd;
    item.addEventListener('click', () => {
      document.getElementById('terminal-input').value = cmd;
    });
    list.appendChild(item);
  });
}

// ==================== 软件管理 ====================
let _softwareLoading = false; // 防重复点击标志
async function loadSoftwareList(forceRefresh = false) {
  // ★ 防重复点击：加载期间禁用刷新按钮，避免多次扫描导致系统卡顿
  if (_softwareLoading) return;
  _softwareLoading = true;
  const refreshBtn = document.getElementById('btn-refresh-software');
  if (refreshBtn) {
    refreshBtn.disabled = true;
    refreshBtn.style.opacity = '0.5';
    refreshBtn.style.cursor = 'not-allowed';
  }

  try {
    showToast('正在加载软件列表...', '', 'info');
    const result = await window.api.listInstalled(forceRefresh);

    if (result.success) {
      state.softwareList = result.data;
      renderSoftwareList(result.data);
      document.getElementById('software-count').textContent = `${result.total} 个软件`;
      showToast('加载完成', `${result.total} 个已安装软件`, 'success');
    } else {
      showToast('加载失败', result.error, 'error');
    }
  } finally {
    _softwareLoading = false;
    if (refreshBtn) {
      refreshBtn.disabled = false;
      refreshBtn.style.opacity = '';
      refreshBtn.style.cursor = '';
    }
  }
}

function renderSoftwareList(software) {
  const listEl = document.getElementById('software-list');
  listEl.innerHTML = '';

  if (software.length === 0) {
    listEl.appendChild(createSoftwareEmptyState());
    return;
  }

  // ★ 优化：使用 DocumentFragment 批量添加 DOM 节点，减少重排次数
  // 原实现逐个 appendChild，软件多时会触发多次重排导致 UI 卡顿
  const fragment = document.createDocumentFragment();
  const defaultIcon = '<svg viewBox="0 0 1024 1024" width="1em" height="1em" fill="currentColor"><path d="M832 64H192c-35.3 0-64 28.7-64 64v768c0 35.3 28.7 64 64 64h640c35.3 0 64-28.7 64-64V128c0-35.3-28.7-64-64-64z m0 832H192V128h640v768z M480 384h64c17.7 0 32-14.3 32-32s-14.3-32-32-32h-64c-17.7 0-32 14.3-32 32s14.3 32 32 32z M480 544h64c17.7 0 32-14.3 32-32s-14.3-32-32-32h-64c-17.7 0-32 14.3-32 32s14.3 32 32 32z M480 704h64c17.7 0 32-14.3 32-32s-14.3-32-32-32h-64c-17.7 0-32 14.3-32 32s14.3 32 32 32z"/></svg>';
  const iconSvg = (window.ElIcons && window.ElIcons.ICONS && window.ElIcons.ICONS.archive) || defaultIcon;

  for (const sw of software) {
    if (!sw.name) continue;
    const item = document.createElement('div');
    item.className = 'software-item';
    item.innerHTML = `
      <div class="sw-icon"><span class="el-icon">${iconSvg}</span></div>
      <div class="sw-info">
        <div class="sw-name">${escapeHtml(sw.name)}</div>
        <div class="sw-meta">
          ${sw.version ? `<span class="sw-meta-tag">v${escapeHtml(sw.version)}</span>` : ''}
          ${sw.publisher ? `<span class="sw-meta-tag">${escapeHtml(sw.publisher)}</span>` : ''}
          ${sw.installLocation ? `<span class="sw-meta-tag location" title="${escapeHtml(sw.installLocation)}">${escapeHtml(sw.installLocation)}</span>` : ''}
        </div>
      </div>
      <div class="sw-actions">
        <button class="btn btn-sm btn-danger">卸载</button>
      </div>
    `;
    item.querySelector('.btn-danger').addEventListener('click', () => uninstallSoftware(sw));
    fragment.appendChild(item);
  }
  listEl.appendChild(fragment);
}

function filterSoftware() {
  const query = document.getElementById('software-search').value.trim().toLowerCase();
  if (!query) {
    renderSoftwareList(state.softwareList);
    return;
  }
  const filtered = state.softwareList.filter(sw =>
    sw.name && sw.name.toLowerCase().includes(query)
  );
  renderSoftwareList(filtered);
}

async function installSoftware() {
  const paths = await window.api.selectFiles({
    filters: [
      { name: '安装包', extensions: ['exe', 'msi', 'dmg', 'pkg', 'deb', 'rpm', 'AppImage'] },
      { name: '所有文件', extensions: ['*'] }
    ]
  });
  if (!paths || paths.length === 0) return;

  const confirmed = await showConfirm({
    type: 'warning',
    title: '安装软件',
    message: `即将安装：${window.api.path.basename(paths[0])}`,
    detail: '安装过程可能需要管理员权限，请耐心等待。'
  });
  if (!confirmed) return;

  showToast('正在安装...', paths[0], 'info');
  const result = await window.api.installSoftware({ sourcePath: paths[0] });

  if (result.success) {
    showToast('安装完成', '', 'success');
    loadSoftwareList();
  } else {
    showToast('安装失败', result.error, 'error');
  }
}

async function uninstallSoftware(sw) {
  const confirmed = await showConfirm({
    type: 'warning',
    title: '卸载软件',
    message: `确定要卸载「${sw.name}」吗？`,
    detail: '此操作将删除软件及其相关文件，部分配置可能保留。'
  });
  if (!confirmed) return;

  showToast('正在卸载...', sw.name, 'info');
  const result = await window.api.uninstallSoftware({ name: sw.name });

  if (result.success) {
    showToast('卸载完成', '', 'success');
    loadSoftwareList();
  } else {
    showToast('卸载失败', result.error, 'error');
  }
}

// ==================== AI 配置 ====================
function loadCloudProviders() {
  state.cloudProviders = state.settings.ai?.cloudProviders || [];
  state.activeProviderId = state.settings.ai?.activeProvider || null;
}

function loadLocalModels() {
  state.localModels = state.settings.ai?.localModels || [];
}

// 将渲染进程的 cloudProviders / localModels 同步到 state.settings.ai，
// 防止后续 setConfig 调用使用旧数据覆盖主进程中已更新的提供商列表
function syncAISettings() {
  if (!state.settings.ai) state.settings.ai = {};
  state.settings.ai.cloudProviders = state.cloudProviders;
  state.settings.ai.localModels = state.localModels;
  state.settings.ai.activeProvider = state.activeProviderId;
}

// 构建完整的 AI 配置对象（始终包含最新的提供商和模型列表）
function buildAIConfig(overrides = {}) {
  if (!state.settings.ai) state.settings.ai = {};
  return {
    ...state.settings.ai,
    cloudProviders: state.cloudProviders,
    localModels: state.localModels,
    activeProvider: state.activeProviderId,
    ...overrides
  };
}

function renderAIConfig() {
  renderLocalModels();
  renderCloudProviders();
  renderAISettings();
  refreshLocalEngineStatus();   // 异步补一个"本地服务是否在跑"的实时状态
}

// 本地推理服务的运行状态（用于列表顶部提示 + 停止按钮）
async function refreshLocalEngineStatus() {
  try {
    state.localEngine = await window.api.getLocalEngineStatus();
  } catch (e) {
    state.localEngine = { running: false };
  }
  renderLocalModels();
}

function renderLocalModels() {
  const listEl = document.getElementById('local-models-list');
  listEl.innerHTML = '';

  // 顶部：由本应用启动的本地服务正在跑 → 给个明显的状态 + 停止入口
  const eng = state.localEngine;
  if (eng && eng.running) {
    const bar = document.createElement('div');
    bar.className = 'local-engine-bar';
    const txt = document.createElement('span');
    txt.textContent = (eng.managed ? '本地服务运行中' : '复用本机运行中的服务') +
      '（端口 ' + eng.port + (eng.modelId ? '，模型 ' + eng.modelId : '') + '）';
    bar.appendChild(txt);
    if (eng.managed) {
      const stopBtn = document.createElement('button');
      stopBtn.className = 'btn btn-sm';
      stopBtn.textContent = '停止';
      stopBtn.title = '停止由浮灵饰界启动的本地推理服务，释放显存';
      stopBtn.addEventListener('click', async () => {
        const r = await window.api.stopLocalModel();
        showToast(r.stopped ? '已停止本地服务' : '无需停止', r.message || '', r.stopped ? 'success' : 'info');
        refreshLocalEngineStatus();
      });
      bar.appendChild(stopBtn);
    }
    listEl.appendChild(bar);
  }

  if (state.localModels.length === 0) {
    listEl.innerHTML = `
      <div class="empty-state-sm">
        <div class="empty-text">未添加本地模型</div>
        <div class="empty-hint">本地直接可跑的是 GGUF / GGML（经 llama.cpp）；Safetensors / ONNX 需先转换</div>
      </div>
    `;
    return;
  }

  state.localModels.forEach(model => {
    const runnable = model.runnable !== false;   // 老数据没有该字段时按可用来试
    const isCurrent = state.activeProviderId === localProviderIdOf(model.id);
    const item = document.createElement('div');
    item.className = 'config-item' + (isCurrent ? ' provider-active' : '');
    item.innerHTML = `
      <div class="config-item-info">
        <div class="config-item-name"></div>
        <div class="config-item-meta">
          <span>${escapeHtml(String(model.format || '').toUpperCase())}</span>
          <span>${escapeHtml(model.sizeFormatted || '')}</span>
          ${runnable ? '' : '<span class="local-badge warn">需转 GGUF</span>'}
          ${isCurrent ? '<span class="local-badge ok">当前模型</span>' : ''}
        </div>
        ${runnable ? '' : '<div class="local-model-tip">Safetensors / ONNX 本机没有可直接加载的运行时；请转成 GGUF 后重新导入，或改用 Ollama。</div>'}
      </div>
      <div class="config-item-actions"></div>
    `;
    item.querySelector('.config-item-name').textContent = model.name || '(未命名)';

    const actions = item.querySelector('.config-item-actions');
    if (runnable) {
      const useBtn = document.createElement('button');
      useBtn.className = 'btn btn-sm ' + (isCurrent ? '' : 'btn-primary');
      useBtn.textContent = isCurrent ? '重新加载' : '使用';
      useBtn.title = isCurrent ? '重启本地服务并重新加载该模型' : '启动本地推理服务并切换为当前模型';
      useBtn.addEventListener('click', () => useLocalModel(model, useBtn));
      actions.appendChild(useBtn);
    }
    // 非 GGUF 的 HuggingFace/safetensors 模型：提供一键转换
    if (!runnable && (model.format === 'huggingface' || model.format === 'safetensors')) {
      const convBtn = document.createElement('button');
      convBtn.className = 'btn btn-sm';
      convBtn.textContent = '转GGUF';
      convBtn.title = '自动调用 llama.cpp convert_hf_to_gguf.py 转换为 GGUF（需 Python + torch + transformers）';
      convBtn.addEventListener('click', () => promptModelConversion(model, convBtn));
      actions.appendChild(convBtn);
    }
    const delBtn = document.createElement('button');
    delBtn.className = 'btn btn-sm btn-danger';
    delBtn.textContent = '删除';
    delBtn.addEventListener('click', async () => {
      const result = await window.api.deleteLocalModel(model.id);
      if (result.success) {
        state.localModels = state.localModels.filter(m => m.id !== model.id);
        syncAISettings();
        renderLocalModels();
        showToast('删除成功', '', 'success');
      }
    });
    actions.appendChild(delBtn);
    listEl.appendChild(item);
  });
}


// 本地推理工具管理面板
async function renderTools() {
  const listEl = document.getElementById('tools-list');
  if (!listEl) return;
  try {
    const tools = await window.api.checkTools();
    const items = [];

    // llama-server
    const ls = tools.llamaServer;
    items.push({
      name: 'llama.cpp 工具包',
      desc: 'llama-server 推理服务 + llama-quantize 显存量化优化 + llama-cli 命令行',
      installed: ls.installed,
      path: ls.path,
      extra: [ls.hasQuantize ? '含量化工具' : '', ls.hasCli ? '含CLI' : ''].filter(Boolean).join(' · '),
      tool: 'llama-server',
    });

    // convert script
    const cs = tools.convertScript;
    items.push({
      name: 'convert_hf_to_gguf.py',
      desc: 'HuggingFace 模型 → GGUF 格式转换脚本（需 Python + torch + transformers）',
      installed: cs.installed,
      path: cs.path,
      extra: '',
      tool: 'convert-script',
    });

    // Python
    const py = tools.python;
    items.push({
      name: 'Python 环境',
      desc: py.available ? (py.version + (py.hasDeps ? ' · torch/transformers 已安装' : ' · 缺少 torch/transformers')) : '未检测到 Python 3',
      installed: py.available && py.hasDeps,
      path: py.available ? py.command : '',
      extra: py.available && !py.hasDeps ? 'pip install torch transformers sentencepiece protobuf' : '',
      tool: null,
    });

    // 顶部：镜像源测速按钮
    const testBar = document.createElement('div');
    testBar.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:12px;padding:8px 12px;background:var(--bg-tertiary);border-radius:8px;';
    testBar.innerHTML = '<span style="font-size:12px;color:var(--text-secondary);">下载源：</span>';
    const testBtn = document.createElement('button');
    testBtn.className = 'btn btn-sm';
    testBtn.textContent = '测速选最优';
    const testResult = document.createElement('span');
    testResult.style.cssText = 'font-size:11px;color:var(--text-secondary);';
    testBtn.addEventListener('click', async () => {
      testBtn.disabled = true;
      testBtn.textContent = '测速中...';
      testResult.textContent = '';
      try {
        const urls = [
          'https://raw.gitmirror.com/ggerganov/llama.cpp/master/convert_hf_to_gguf.py',
          'https://ghproxy.com/https://raw.githubusercontent.com/ggerganov/llama.cpp/master/convert_hf_to_gguf.py',
          'https://mirror.ghproxy.com/https://raw.githubusercontent.com/ggerganov/llama.cpp/master/convert_hf_to_gguf.py',
          'https://raw.githubusercontent.com/ggerganov/llama.cpp/master/convert_hf_to_gguf.py',
        ];
        const results = await window.api.testMirrors(urls);
        const ok = results.filter(r => r.ok);
        if (ok.length > 0) {
          const fastest = ok.sort((a,b) => a.latency - b.latency)[0];
          const host = new URL(fastest.url).hostname;
          testResult.innerHTML = '<span style="color:var(--success);">最快: ' + host + ' (' + fastest.latency + 'ms)</span> · 可用 ' + ok.length + '/' + results.length;
        } else {
          testResult.innerHTML = '<span style="color:var(--danger);">全部不可用，请检查网络</span>';
        }
      } catch (e) {
        testResult.textContent = '测速失败: ' + (e.message || e);
      } finally {
        testBtn.disabled = false;
        testBtn.textContent = '测速选最优';
      }
    });
    testBar.appendChild(testBtn);
    testBar.appendChild(testResult);

    listEl.innerHTML = '';
    listEl.appendChild(testBar);
    for (const item of items) {
      const div = document.createElement('div');
      div.className = 'config-item';
      div.innerHTML = `
        <div class="config-item-info">
          <div class="config-item-name">${escapeHtml(item.name)}</div>
          <div class="config-item-meta">
            <span class="local-badge ${item.installed ? 'ok' : 'warn'}">${item.installed ? '已安装' : '未安装'}</span>
            ${item.extra ? '<span>' + escapeHtml(item.extra) + '</span>' : ''}
          </div>
          ${item.path ? '<div style="font-size:11px;color:var(--text-secondary);margin-top:4px;word-break:break-all;">' + escapeHtml(item.path) + '</div>' : ''}
          <div style="font-size:11px;color:var(--text-secondary);margin-top:2px;">${escapeHtml(item.desc)}</div>
        </div>
        <div class="config-item-actions"></div>
      `;
      const actions = div.querySelector('.config-item-actions');
      if (item.tool) {
        const btn = document.createElement('button');
        btn.className = 'btn btn-sm ' + (item.installed ? '' : 'btn-primary');
        btn.textContent = item.installed ? '重新下载' : '下载';
        btn.addEventListener('click', async () => {
          const dl = await promptAndDownloadTool(item.tool, { defaultDir: tools.installDir || '' });
          if (dl.success) renderTools();
        });
        actions.appendChild(btn);
      }
      listEl.appendChild(div);
    }
  } catch (e) {
    listEl.innerHTML = '<div class="empty-state-sm"><div class="empty-text">检测失败: ' + escapeHtml(String(e.message || e)) + '</div></div>';
  }
}
// provider id 规则与主进程一致（local-<uuid>），用来判断哪个本地模型正在被使用
function localProviderIdOf(modelId) {
  const p = (state.cloudProviders || []).find(x => x.local && x.modelId === modelId);
  return p ? p.id : null;
}



// 模型转换弹窗：显示 Python 环境状态、依赖、转换进度
async function promptModelConversion(model, triggerBtn) {
  if (triggerBtn) { triggerBtn.disabled = true; }

  const body = `
    <div style="padding: 8px 0;">
      <p style="margin:0 0 12px;color:var(--text-secondary);line-height:1.6;">将 <strong style="color:var(--text-primary);">${escapeHtml(model.name)}</strong> 转换为 GGUF 格式</p>
      <div id="conv-env-status" style="margin-bottom:16px;">
        <div style="font-size:12px;color:var(--text-secondary);">正在检测 Python 环境...</div>
      </div>
      <div id="conv-progress" style="display:none;margin-top:8px;">
        <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--text-secondary);margin-bottom:4px;">
          <span id="conv-progress-text">准备中...</span>
          <span id="conv-progress-pct"></span>
        </div>
        <div style="height:6px;background:var(--bg-tertiary);border-radius:3px;overflow:hidden;">
          <div id="conv-progress-bar" style="height:100%;width:0%;background:var(--accent);transition:width 0.3s;"></div>
        </div>
      </div>
    </div>
  `;
  const footer = `
    <button class="btn" id="conv-cancel-btn">取消</button>
    <button class="btn btn-primary" id="conv-start-btn" disabled>开始转换</button>
  `;
  showModal({ title: '转换模型为 GGUF', body, footer });

  const envStatus = document.getElementById('conv-env-status');
  const progressWrap = document.getElementById('conv-progress');
  const progressText = document.getElementById('conv-progress-text');
  const progressPct = document.getElementById('conv-progress-pct');
  const progressBar = document.getElementById('conv-progress-bar');
  const startBtn = document.getElementById('conv-start-btn');
  const cancelBtn = document.getElementById('conv-cancel-btn');

  let pyInfo = null;
  let canConvert = false;

  // 异步检测 Python（不阻塞 UI）
  try {
    pyInfo = await window.api.detectPython();
  } catch (e) {
    pyInfo = { available: false };
  }

  if (!pyInfo.available) {
    envStatus.innerHTML = `
      <div style="background:rgba(255,82,82,0.1);border:1px solid rgba(255,82,82,0.3);border-radius:6px;padding:10px 14px;">
        <div style="color:#ff5252;font-weight:500;margin-bottom:4px;">未检测到 Python 3</div>
        <div style="font-size:12px;color:var(--text-secondary);line-height:1.5;">请先安装 Python 3.10+，然后在终端运行：<br><code style="background:var(--bg-primary);padding:2px 6px;border-radius:3px;">pip install torch transformers sentencepiece protobuf</code></div>
      </div>`;
    startBtn.disabled = true;
    startBtn.textContent = '需要 Python';
  } else if (!pyInfo.hasDeps) {
    envStatus.innerHTML = `
      <div style="background:rgba(255,152,0,0.1);border:1px solid rgba(255,152,0,0.3);border-radius:6px;padding:10px 14px;">
        <div style="color:#ff9800;font-weight:500;margin-bottom:4px;">${escapeHtml(pyInfo.version || 'Python 3')} 已安装，但缺少依赖</div>
        <div style="font-size:12px;color:var(--text-secondary);line-height:1.5;">请在终端运行：<br><code style="background:var(--bg-primary);padding:2px 6px;border-radius:3px;word-break:break-all;">pip install torch transformers sentencepiece protobuf</code></div>
      </div>`;
    startBtn.disabled = true;
    startBtn.textContent = '缺少依赖';
  } else {
    envStatus.innerHTML = `
      <div style="background:rgba(76,175,80,0.1);border:1px solid rgba(76,175,80,0.3);border-radius:6px;padding:10px 14px;">
        <div style="color:#4caf50;font-weight:500;">环境就绪</div>
        <div style="font-size:12px;color:var(--text-secondary);margin-top:2px;">${escapeHtml(pyInfo.version || '')} · torch / transformers 已安装</div>
      </div>`;
    canConvert = true;
    startBtn.disabled = false;
  }

  cancelBtn.addEventListener('click', () => {
    closeModal();
    if (triggerBtn) triggerBtn.disabled = false;
  });
  // X 按钮也能关闭（全局 modal-close 监听可能被覆盖，这里直接绑定）
  const xBtn1 = document.getElementById('modal-close');
  if (xBtn1) xBtn1.addEventListener('click', () => { closeModal(); if (triggerBtn) triggerBtn.disabled = false; }, { once: true });

  startBtn.addEventListener('click', async () => {
    if (!canConvert) return;
    startBtn.disabled = true;
    cancelBtn.disabled = true;
    progressWrap.style.display = 'block';
    progressText.textContent = '正在转换（大模型可能需要几分钟）...';

    // 监听转换进度（后端通过 IPC 事件推送）
    const off = window.api.onToolDownloadProgress ? window.api.onToolDownloadProgress((p) => {
      progressText.textContent = p.message || p.phase || '转换中...';
      if (p.percent >= 0) {
        progressPct.textContent = p.percent + '%';
        progressBar.style.width = p.percent + '%';
      }
    }) : null;

    try {
      const r = await window.api.convertModelToGguf(model.id);
      if (r.success) {
        progressText.textContent = '转换完成';
        progressBar.style.width = '100%';
        progressPct.textContent = '100%';
        setTimeout(async () => {
          closeModal();
          showToast('转换完成', '已生成 GGUF 文件，可直接使用', 'success');
          state.localModels = await window.api.listLocalModels();
          renderLocalModels();
        }, 800);
      } else {
        progressText.textContent = '转换失败';
        startBtn.disabled = false;
        cancelBtn.disabled = false;
        startBtn.textContent = '重试';
        envStatus.innerHTML += `<div style="margin-top:10px;color:#ff5252;font-size:12px;word-break:break-all;">${escapeHtml(r.error || '未知错误')}</div>`;
      }
    } catch (e) {
      progressText.textContent = '转换失败';
      startBtn.disabled = false;
      cancelBtn.disabled = false;
      envStatus.innerHTML += `<div style="margin-top:10px;color:#ff5252;font-size:12px;">${escapeHtml(String(e.message || e))}</div>`;
    } finally {
      if (off) off();
      if (triggerBtn) triggerBtn.disabled = false;
    }
  });
}
// 工具下载确认弹窗：用户同意 + 自选目录 + 进度显示
async function promptAndDownloadTool(tool, options = {}) {
  const toolNames = {
    'llama-server': 'llama.cpp 工具包（llama-server 推理服务 + llama-quantize 显存优化 + llama-cli）',
    'convert-script': 'convert_hf_to_gguf.py 转换脚本',
  };
  const toolName = toolNames[tool] || tool;
  let chosenDir = options.defaultDir || '';

  return new Promise((resolve) => {
    const body = `
      <div style="padding: 8px 0;">
        <p style="margin:0 0 12px;color:var(--text-secondary);line-height:1.6;">需要下载以下工具才能继续：</p>
        <div style="background:var(--bg-tertiary);border:1px solid var(--border);border-radius:6px;padding:10px 14px;margin-bottom:16px;">
          <strong style="color:var(--accent);">${escapeHtml(toolName)}</strong>
        </div>
        <div style="margin-bottom:12px;">
          <label style="display:block;font-size:12px;color:var(--text-secondary);margin-bottom:6px;">安装目录</label>
          <div style="display:flex;gap:8px;align-items:center;">
            <input type="text" id="tool-install-dir" readonly value="${escapeHtml(chosenDir)}"
              style="flex:1;background:var(--bg-primary);border:1px solid var(--border);border-radius:4px;padding:6px 10px;color:var(--text-primary);font-size:12px;" />
            <button class="btn btn-sm" id="tool-choose-dir">浏览...</button>
          </div>
        </div>
        <div id="tool-download-progress" style="display:none;margin-top:8px;">
          <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--text-secondary);margin-bottom:4px;">
            <span id="tool-progress-text">准备中...</span>
            <span id="tool-progress-pct"></span>
          </div>
          <div style="height:6px;background:var(--bg-tertiary);border-radius:3px;overflow:hidden;">
            <div id="tool-progress-bar" style="height:100%;width:0%;background:var(--accent);transition:width 0.3s;"></div>
          </div>
        </div>
      </div>
    `;
    const footer = `
      <button class="btn" id="tool-cancel-btn">取消</button>
      <button class="btn btn-primary" id="tool-download-btn">确认下载</button>
    `;
    showModal({ title: '下载工具', body, footer });

    const dirInput = document.getElementById('tool-install-dir');
    const chooseBtn = document.getElementById('tool-choose-dir');
    const dlBtn = document.getElementById('tool-download-btn');
    const cancelBtn = document.getElementById('tool-cancel-btn');
    const progressWrap = document.getElementById('tool-download-progress');
    const progressText = document.getElementById('tool-progress-text');
    const progressPct = document.getElementById('tool-progress-pct');
    const progressBar = document.getElementById('tool-progress-bar');

    chooseBtn.addEventListener('click', async () => {
      const dirs = await window.api.selectDirectory();
      if (dirs && dirs.length > 0) { chosenDir = dirs[0]; dirInput.value = chosenDir; }
    });

    cancelBtn.addEventListener('click', () => { closeModal(); resolve({ cancelled: true }); });
    const xBtn2 = document.getElementById('modal-close');
    if (xBtn2) xBtn2.addEventListener('click', () => { closeModal(); resolve({ cancelled: true }); }, { once: true });

    dlBtn.addEventListener('click', async () => {
      if (!chosenDir) { showToast('请选择安装目录', '', 'warning'); return; }
      dlBtn.disabled = true; chooseBtn.disabled = true; cancelBtn.disabled = true;
      progressWrap.style.display = 'block';
      progressText.textContent = '正在下载...';

      const off = window.api.onToolDownloadProgress((p) => {
        progressText.textContent = p.message || p.phase;
        if (p.percent >= 0) {
          progressPct.textContent = p.percent + '%';
          progressBar.style.width = p.percent + '%';
        }
      });

      try {
        const r = await window.api.downloadTool(tool, chosenDir);
        progressText.textContent = '下载完成';
        progressBar.style.width = '100%';
        progressPct.textContent = '100%';
        setTimeout(() => { closeModal(); resolve({ success: true, path: r.path, installDir: chosenDir }); }, 800);
      } catch (e) {
        progressText.textContent = '下载失败: ' + (e.message || e);
        dlBtn.disabled = false; chooseBtn.disabled = false; cancelBtn.disabled = false;
      } finally {
        if (off) off();
      }
    });
  });
}
// 让本地模型真正跑起来：主进程会复用已在运行的本地服务，或拉起 llama-server
async function useLocalModel(model, btn) {
  const original = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = '加载中…'; }
  showToast('正在加载本地模型', model.name + '（首次加载可能需要几十秒）', 'info');
  try {
    let r = await window.api.useLocalModel(model.id);
    // 工具缺失：弹窗让用户确认下载 + 选择目录，完成后重试
    if (!r.success && r.toolMissing) {
      const tools = await window.api.checkTools();
      const dl = await promptAndDownloadTool(r.tool || 'llama-server', { defaultDir: tools.installDir || '' });
      if (dl.cancelled || !dl.success) { return; }
      showToast('工具安装完成', '正在重新加载模型...', 'info');
      r = await window.api.useLocalModel(model.id);
    }
    if (!r.success) {
      try {
        await window.api.showError('本地模型无法使用', r.error || '未知错误', r.hint || '');
      } catch (e) {
        showToast('本地模型无法使用', (r.error || '') + (r.hint ? ' ' + r.hint : ''), 'error', { duration: 12000 });
      }
      return;
    }
    await reloadProvidersAndActive();
    renderLocalModels();
    renderCloudProviders();
    showToast('已切换为本地模型', r.message || '', 'success');
  } catch (e) {
    showToast('本地模型启动失败', String(e && e.message || e), 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = original; }
  }
}

// 主进程改了 activeProvider / 新增 provider 之后，把渲染层状态和下拉同步过来
async function reloadProvidersAndActive() {
  try {
    const [providers, status] = await Promise.all([
      window.api.listCloudProviders(),
      window.api.getAIStatus()
    ]);
    state.cloudProviders = providers || [];
    syncAISettings();
    if (status && status.activeProvider) {
      state.activeProviderId = status.activeProvider;
      const sel = document.getElementById('chat-provider');
      if (sel) {
        if (!Array.from(sel.options).some(o => o.value === state.activeProviderId)) {
          const opt = document.createElement('option');
          opt.value = state.activeProviderId;
          opt.textContent = (state.cloudProviders.find(p => p.id === state.activeProviderId) || {}).name || '本地模型';
          sel.appendChild(opt);
        }
        sel.value = state.activeProviderId;
        if (window.CustomSelect) window.CustomSelect.sync(sel);
      }
    }
    if (typeof updateActiveProviderDisplay === 'function') updateActiveProviderDisplay();
    if (typeof updateProviderIconDisplay === 'function') updateProviderIconDisplay();
  } catch (e) {
    console.warn('刷新提供商状态失败:', e);
  }
}

function renderCloudProviders() {
  const listEl = document.getElementById('cloud-providers-list');
  listEl.innerHTML = '';

  if (state.cloudProviders.length === 0) {
    listEl.innerHTML = `
      <div class="empty-state-sm">
        <div class="empty-text">未配置AI模型服务</div>
        <div class="empty-hint">支持任何兼容OpenAI API的服务</div>
      </div>
    `;
    return;
  }

  state.cloudProviders.forEach(provider => {
    const item = document.createElement('div');
    // ★ 当前活跃的提供商添加高亮样式
    const isActive = provider.enabled && provider.id === state.activeProviderId;
    item.className = 'config-item' + (isActive ? ' provider-active' : '');
    const meta = PROVIDER_TYPES.find(p => p.value === provider.type) || { label: 'OpenAI兼容', icon: 'cloud' };
    const typeLabel = meta.label || 'OpenAI兼容';
    // 使用 LobeHub 图标自动识别
    const iconId = window.ModelIcons ? window.ModelIcons.detectProviderIcon(provider) : 'default';
    const typeIcon = window.ModelIcons ? window.ModelIcons.renderIconHtml(iconId, 'config-type-icon', '28px') : window.ElIcons.getIcon(meta.icon || 'cloud');
    item.innerHTML = `
      <div class="config-toggle ${provider.enabled ? 'active' : ''}" data-id="${provider.id}"></div>
      ${typeIcon}
      <div class="config-item-info" data-action="set-active" data-id="${provider.id}" style="cursor:pointer;flex:1;">
        <div class="config-item-name">${escapeHtml(provider.name)}${isActive ? ' <span class="active-badge">当前使用</span>' : ''}</div>
        <div class="config-item-meta">
          <span class="provider-type-badge">${typeLabel}</span>
          <span>${escapeHtml(provider.model)}</span>
          <span>${escapeHtml(provider.apiUrl)}</span>
        </div>
      </div>
      <button class="btn btn-sm">编辑</button>
      <button class="btn btn-sm btn-danger">删除</button>
    `;
    // 异步加载真实 SVG 图标
    if (window.ModelIcons) window.ModelIcons.updateIconsInContainer(item);

    // ★ 点击提供商信息区域切换为活跃模型（仅已启用的提供商）—— 与开关走同一个入口
    const infoEl = item.querySelector('.config-item-info');
    if (infoEl) {
      infoEl.addEventListener('click', async (e) => {
        // 避免点击编辑/删除按钮时触发
        if (e.target.closest('button')) return;
        const switched = await setActiveProvider(infoEl.dataset.id);
        if (switched) {
          // 重建列表以刷新高亮与「当前使用」徽标（setActiveProvider 不重建 DOM）
          renderCloudProviders();
          renderAISettings();
        }
      });
    }

    item.querySelector('.config-toggle').addEventListener('click', async (e) => {
      const toggle = e.target;
      const id = toggle.dataset.id;
      const provider = state.cloudProviders.find(p => p.id === id);
      if (provider) {
        provider.enabled = !provider.enabled;
        toggle.classList.toggle('active', provider.enabled);
        await window.api.updateCloudProvider({ id, enabled: provider.enabled });
        syncAISettings();
        // ★ 开启即选中：启用某个模型服务后直接把它设为当前使用的模型，无需再选一次
        if (provider.enabled) {
          await setActiveProvider(provider.id);
        } else if (state.activeProviderId === provider.id) {
          // 禁用了当前活跃的提供商，自动切换到其他已启用的
          const next = state.cloudProviders.find(p => p.enabled && p.id !== provider.id);
          await setActiveProvider(next ? next.id : null, {
            toast: next
              ? { title: '当前模型已禁用', message: `已切换到：${next.name}` }
              : { title: '当前模型已禁用', message: '暂无其他已启用的模型' }
          });
        }
        // ★ 重新渲染：列表高亮/「当前使用」徽标 + 参数区（"活跃模型"下拉的 option 列表）
        // （updateActiveProviderDisplay 只设置 value，不重新生成 option 列表）
        renderCloudProviders();
        renderAISettings();
        updateActiveProviderDisplay();
      }
    });

    item.querySelectorAll('button')[0].addEventListener('click', () => editCloudProvider(provider));
    item.querySelectorAll('button')[1].addEventListener('click', async () => {
      const confirmed = await showConfirm({
        type: 'warning',
        title: '删除提供商',
        message: `确定要删除「${provider.name}」吗？`
      });
      if (confirmed) {
        await window.api.deleteCloudProvider(provider.id);
        state.cloudProviders = state.cloudProviders.filter(p => p.id !== provider.id);
        syncAISettings();
        renderCloudProviders();
        updateActiveProviderDisplay();
        showToast('删除成功', '', 'success');
      }
    });

    listEl.appendChild(item);
  });

  updateActiveProviderDisplay();
}

// 根据当前活跃模型类型显示/隐藏 max_tokens 设置项（Ollama 模型不需要设置）
function updateMaxTokensVisibility() {
  const item = document.getElementById('max-tokens-item');
  if (!item) return;
  const provider = state.cloudProviders.find(p => p.id === state.activeProviderId);
  const isOllama = provider && provider.type === 'ollama';
  item.style.display = isOllama ? 'none' : '';
}

function renderAISettings() {
  // ★ 没有已启用的模型时隐藏"参数设置"部分
  const enabledProviders = state.cloudProviders.filter(p => p.enabled);
  const paramsSection = document.getElementById('ai-params-section');
  if (paramsSection) {
    paramsSection.style.display = enabledProviders.length > 0 ? '' : 'none';
  }

  document.getElementById('temperature').value = state.settings.ai?.temperature || 0.7;
  document.getElementById('temperature-value').textContent = document.getElementById('temperature').value;
  document.getElementById('max-tokens').value = state.settings.ai?.maxTokens || 2048;
  // Ollama 模型隐藏 max_tokens 设置项
  updateMaxTokensVisibility();
  // 上下文窗口：0/空 = 按模型名自动识别（无覆盖值时留空显示 placeholder「自动」）
  const ctxWinEl = document.getElementById('context-window');
  if (ctxWinEl) {
    const v = parseInt(state.settings.ai?.contextWindow, 10) || 0;
    ctxWinEl.value = v > 0 ? v : '';
  }
  document.getElementById('system-prompt').value = state.settings.ai?.systemPrompt || '';

  const select = document.getElementById('active-provider');
  if (select) {
    select.innerHTML = '<option value="">-- 选择 --</option>';
    enabledProviders.forEach(p => {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.name;
      if (p.id === state.activeProviderId) opt.selected = true;
      select.appendChild(opt);
    });
  }

  updateActiveProviderDisplay();
}

function updateActiveProviderDisplay() {
  const select = document.getElementById('chat-provider');
  if (select) {
    select.innerHTML = '<option value="">选择AI模型...</option>';
    state.cloudProviders.filter(p => p.enabled).forEach(p => {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.name;
      if (p.id === state.activeProviderId) opt.selected = true;
      select.appendChild(opt);
    });
  }
  // 更新当前模型图标
  updateProviderIconDisplay();

  // 验证活跃提供商是否存在且已启用
  const activeProvider = state.cloudProviders.find(p => p.id === state.activeProviderId);
  const isConnected = state.activeProviderId && activeProvider && activeProvider.enabled;

  const statusEl = document.getElementById('ai-status');
  const statusText = document.getElementById('ai-status-text');
  const t = window.I18N?.t || ((k) => k);
  if (statusEl && statusText) {
    if (isConnected) {
      statusEl.classList.add('connected');
      statusText.textContent = t('chat.aiConnected');
    } else {
      statusEl.classList.remove('connected');
      statusText.textContent = t('chat.aiNotConnected');
    }
  }

  // 同步 AI 配置页的活跃提供商下拉
  const configSelect = document.getElementById('active-provider');
  if (configSelect) {
    configSelect.value = state.activeProviderId || '';
  }
}

/**
 * 把某个模型服务设为「当前使用」的活跃模型并持久化。
 *
 * 这是「设置活跃模型」的唯一入口。用户**开启**或**新增**一个模型服务，本身就已经表达了
 * "我要用这个模型"的意图，所以直接生效，不需要再去点一次列表行或拉一次下拉框（二次选择）。
 *
 * @param {string|null} providerId 目标提供商 id；传 null / 空串表示清除活跃模型
 * @param {{ toast?: { title: string, message?: string } | null }} [options]
 *        toast 省略 → 默认提示「已切换模型」；传 null → 静默（调用方自己提示）
 * @returns {Promise<boolean>} 是否真的发生了切换
 */
async function setActiveProvider(providerId, options = {}) {
  const target = providerId ? state.cloudProviders.find(p => p.id === providerId) : null;
  // 只有已启用的模型才能成为活跃模型（新增的提供商默认就是启用状态）
  if (providerId && (!target || !target.enabled)) return false;

  const nextId = target ? target.id : null;
  if (nextId === (state.activeProviderId || null)) return false;

  state.activeProviderId = nextId;
  // 持久化到配置（始终带上最新的 cloudProviders / localModels，避免覆盖主进程数据）
  const ai = buildAIConfig({ activeProvider: nextId });
  await window.api.setConfig({ ai });
  state.settings.ai = ai;

  // 同步聊天页选择器 / 状态灯 / 图标 / max_tokens 显隐
  updateActiveProviderDisplay();
  updateMaxTokensVisibility();

  const toast = options.toast === undefined
    ? { title: '已切换模型', message: target ? `当前使用：${target.name}` : '' }
    : options.toast;
  if (toast && window.showToast) {
    window.showToast(toast.title, toast.message || '', 'success');
  }
  return true;
}


async function addLocalModelDirectory() {
  const dirs = await window.api.selectDirectory();
  if (!dirs || dirs.length === 0) return;

  const dirPath = dirs[0];
  showToast('正在导入模型目录...', dirPath, 'info');

  const name = window.api.path.basename(dirPath);
  const result = await window.api.importLocalModel({ path: dirPath, name });

  if (result.success) {
    if (result.updated) {
      state.localModels = await window.api.listLocalModels();
    } else {
      state.localModels.push(result.data);
    }
    syncAISettings();
    renderLocalModels();
    if (result.warning) {
      showToast('已导入，但无法本地加载', result.warning, 'warning', { duration: 12000 });
    } else {
      const fc = result.data.fileCount || 1;
      showToast('添加成功', `${result.data.name}（${fc > 1 ? fc + '个文件' : '单文件'}）已添加，点「使用」即可加载`, 'success');
    }
  } else {
    showToast('添加失败', result.error, 'error');
  }
}
async function addLocalModel() {
  const paths = await window.api.selectFiles({
    filters: [
      { name: 'AI模型', extensions: ['gguf', 'ggml', 'safetensors', 'bin', 'onnx'] },
      { name: '所有文件', extensions: ['*'] }
    ]
  });
  if (!paths || paths.length === 0) return;

  const name = window.api.path.basename(paths[0], window.api.path.extname(paths[0]));
  const result = await window.api.importLocalModel({ path: paths[0], name });

  if (result.success) {
    // 重复导入返回的是 updated：别 push 第二条，改成整表刷新
    if (result.updated) {
      state.localModels = await window.api.listLocalModels();
    } else {
      state.localModels.push(result.data);
    }
    syncAISettings();
    renderLocalModels();
    if (result.warning) {
      showToast('已导入，但无法本地加载', result.warning, 'warning', { duration: 9000 });
    } else {
      showToast('添加成功', `${result.data.name} 已添加，点「使用」即可加载为当前模型`, 'success');
    }
  } else {
    showToast('添加失败', result.error, 'error');
  }
}

// 云端提供商类型元数据：兼容任何 OpenAI 兼容接口（腾讯云混元/DeepSeek/智谱/百度千帆/Kimi 等）
// 后端 callProviderAPI 仅区分 ollama 与其余（均按 OpenAI 兼容处理），故这里列出常见厂商便于选择并预填地址
const PROVIDER_TYPES = [
  { value: 'openai',    label: 'OpenAI 兼容（自定义）', icon: 'cloud',   url: 'https://api.openai.com/v1/chat/completions',                              model: 'gpt-4',     hint: '腾讯云混元、DeepSeek、智谱、百度千帆、Kimi、Groq 等任何 OpenAI 兼容接口，均选此项' },
  { value: 'ollama',    label: 'Ollama 本地',          icon: 'ollama',  url: 'http://localhost:11434',                                                    model: 'llama3',    hint: '本地大模型服务，无需 API Key' },
  { value: 'dashscope', label: '阿里云百炼',           icon: 'bailian', url: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',       model: 'qwen-plus', hint: '' },
  { value: 'tencent',   label: '腾讯云混元',           icon: 'cloud',   url: 'https://api.hunyuan.cloud.tencent.com/v1/chat/completions',                model: 'hunyuan-pro', hint: '' },
  { value: 'tencentmaas', label: '腾讯云 TokenHub',    icon: 'cloud',   url: 'https://tokenhub.tencentmaas.com/v1/chat/completions',                     model: 'hy3',        hint: '腾讯云 TokenHub MaaS 网关（OpenAI 兼容），需填写 TokenHub 的 API Key 与模型名；模型名以 TokenHub 控制台为准（如 hy3）' },
  { value: 'deepseek',  label: 'DeepSeek',             icon: 'cloud',   url: 'https://api.deepseek.com/v1/chat/completions',                            model: 'deepseek-chat', hint: '' },
  { value: 'zhipu',     label: '智谱 GLM',             icon: 'cloud',   url: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',                   model: 'glm-4',     hint: '' },
  { value: 'baidu',     label: '百度千帆',             icon: 'cloud',   url: 'https://qianfan.baidubce.com/v2/chat/completions',                        model: 'ernie-4.0-8k', hint: '' },
  { value: 'moonshot',  label: '月之暗面 Kimi',        icon: 'cloud',   url: 'https://api.moonshot.cn/v1/chat/completions',                             model: 'moonshot-v1-8k', hint: '' }
];

function providerTypeOptions(currentType) {
  return PROVIDER_TYPES.map(p =>
    `<option value="${p.value}" ${p.value === currentType ? 'selected' : ''}>${p.label}</option>`
  ).join('');
}


// 从 API 获取可用模型列表并填充到模型输入框（下拉选择）
async function fetchAndFillModels(modelInput, provider) {
  if (!modelInput || !provider) return;
  const btn = document.getElementById('btn-fetch-models');
  if (btn) { btn.textContent = '获取中...'; btn.disabled = true; }
  try {
    const result = await window.api.fetchProviderModels(provider);
    if (result.success && result.models && result.models.length > 0) {
      // 创建临时下拉选择
      const select = document.createElement('select');
      select.style.cssText = 'position:absolute;top:100%;left:0;right:0;z-index:10001;background:var(--bg-primary,#1e1e2e);border:1px solid var(--border-color,#444);border-radius:6px;color:#fff;font-size:13px;max-height:200px;overflow-y:auto;';
      result.models.forEach(m => {
        const opt = document.createElement('option');
        opt.value = m; opt.textContent = m;
        select.appendChild(opt);
      });
      modelInput.parentElement.style.position = 'relative';
      modelInput.parentElement.appendChild(select);
      select.focus();
      select.addEventListener('change', () => { modelInput.value = select.value; select.remove(); });
      select.addEventListener('blur', () => { setTimeout(() => select.remove(), 200); });
      showToast('获取成功', `找到 ${result.models.length} 个模型`, 'success');
    } else {
      showToast('获取失败', result.error || '未找到模型', 'warning');
    }
  } catch (e) {
    showToast('获取失败', e.message, 'error');
  } finally {
    if (btn) { btn.textContent = '获取模型'; btn.disabled = false; }
  }
}

// 选择厂商后预填 API 地址与默认模型（URL 为空或匹配旧默认地址时更新；模型始终更新为新厂商默认值）
function wireProviderTypeSelect() {
  const sel = document.getElementById('input-type');
  if (!sel) return;
  sel.addEventListener('change', () => {
    const meta = PROVIDER_TYPES.find(p => p.value === sel.value);
    if (!meta) return;
    const urlEl = document.getElementById('input-url');
    const modelEl = document.getElementById('input-model');
    if (urlEl) {
      const cur = urlEl.value.trim();
      // URL 为空，或当前 URL 是某个厂商的默认地址时，自动更新为新厂商地址
      const isDefaultUrl = !cur || PROVIDER_TYPES.some(p => p.url === cur);
      if (isDefaultUrl) urlEl.value = meta.url;
    }
    // 默认模型始终跟随厂商类型更新
    if (modelEl) modelEl.value = meta.model;
  });
}

async function addCloudProvider() {
  showModal({
    title: '添加AI模型提供商',
    body: `
      <div class="modal-form-group">
        <label>提供商类型</label>
        <select id="input-type" data-search="true">
          ${providerTypeOptions()}
        </select>
        <div class="modal-form-hint">腾讯云混元、DeepSeek、智谱、百度千帆、Kimi 等任何 OpenAI 兼容接口均可添加，选择对应厂商会自动预填地址</div>
      </div>
      <div class="modal-form-group" style="display:flex;align-items:center;gap:16px;">
        <div class="model-icon-preview" id="provider-icon-preview">
          <span data-icon-id="default" style="width:32px;height:32px;display:inline-flex;color:var(--text-secondary);"></span>
        </div>
        <div style="flex:1;">
          <label>提供商名称</label>
          <input type="text" id="input-name" placeholder="例如：My AI Service">
          <div class="icon-detected-label" id="icon-detected-text">输入名称/地址后自动识别图标</div>
        </div>
      </div>
      <div class="modal-form-group">
        <label>API 地址</label>
        <input type="text" id="input-url" placeholder="Ollama: http://localhost:11434 | OpenAI: https://api.example.com/v1/chat/completions">
      </div>
      <div class="modal-form-group">
        <label>API 密钥（Ollama 可留空）</label>
        <input type="password" id="input-key" placeholder="sk-...">
      </div>
      <div class="modal-form-group">
        <label>默认模型</label>
        <input type="text" id="input-model" placeholder="Ollama: llama3 | 百炼: qwen-plus | OpenAI: gpt-4">
      </div>
      <div class="modal-form-group">
        <label>描述（可选）</label>
        <input type="text" id="input-desc" placeholder="备注信息">
      </div>
    `,
    footer: `
      <button class="btn" id="btn-cancel">取消</button>
      <button class="btn btn-primary" id="btn-save">保存</button>
    `
  });

  document.getElementById('btn-cancel').addEventListener('click', closeModal);
  wireProviderTypeSelect();
  const fetchBtnAdd = document.getElementById('btn-fetch-models');
  if (fetchBtnAdd) fetchBtnAdd.addEventListener('click', () => {
    const provider = {
      type: document.getElementById('input-type').value,
      apiUrl: document.getElementById('input-url').value.trim(),
      apiKey: document.getElementById('input-key').value.trim(),
      model: document.getElementById('input-model').value.trim()
    };
    fetchAndFillModels(document.getElementById('input-model'), provider);
  });

  // 图标实时识别
  function updateProviderIconPreview() {
    if (!window.ModelIcons) return;
    const name = document.getElementById('input-name')?.value || '';
    const type = document.getElementById('input-type')?.value || '';
    const url = document.getElementById('input-url')?.value || '';
    const model = document.getElementById('input-model')?.value || '';
    const iconId = window.ModelIcons.detectProviderIcon({ name, type, apiUrl: url, model });
    const preview = document.getElementById('provider-icon-preview');
    const detectedText = document.getElementById('icon-detected-text');
    if (preview) {
      preview.innerHTML = window.ModelIcons.renderIconHtml(iconId, '', '32px');
      window.ModelIcons.updateIconsInContainer(preview);
    }
    if (detectedText) {
      detectedText.textContent = iconId === 'default' ? '未识别到特定图标，使用默认图标' : '已识别图标: ' + iconId;
    }
  }
  ['input-name', 'input-url', 'input-model', 'input-type'].forEach(id => {
    document.getElementById(id)?.addEventListener('input', updateProviderIconPreview);
    document.getElementById(id)?.addEventListener('change', updateProviderIconPreview);
  });
  setTimeout(updateProviderIconPreview, 100);

  document.getElementById('btn-save').addEventListener('click', async () => {
    const type = document.getElementById('input-type').value;
    const name = document.getElementById('input-name').value.trim();
    const apiUrl = document.getElementById('input-url').value.trim();
    const apiKey = document.getElementById('input-key').value.trim();
    const model = document.getElementById('input-model').value.trim() || (type === 'ollama' ? 'llama3' : 'gpt-4');
    const description = document.getElementById('input-desc').value.trim();

    if (!name || !apiUrl) {
      showToast('信息不完整', '名称和API地址为必填项', 'warning');
      return;
    }

    const result = await window.api.addCloudProvider({ name, apiUrl, apiKey, model, description, type });
    if (result.success) {
      state.cloudProviders.push(result.data);
      syncAISettings();
      await setActiveProvider(result.data.id, { toast: null }); // 新增即选中
      renderCloudProviders();
      renderAISettings();
      closeModal();
      showToast('添加成功', `${name} 已设为当前模型`, 'success');
    } else {
      showToast('添加失败', result.error, 'error');
    }
  });
}

async function editCloudProvider(provider) {
  showModal({
    title: '编辑提供商',
    body: `
      <div class="modal-form-group">
        <label>提供商类型</label>
        <select id="input-type" data-search="true">
          ${providerTypeOptions(provider.type)}
        </select>
        <div class="modal-form-hint">腾讯云混元、DeepSeek、智谱、百度千帆、Kimi 等任何 OpenAI 兼容接口均可添加，选择对应厂商会自动预填地址</div>
      </div>
      <div class="modal-form-group">
        <label>提供商名称</label>
        <input type="text" id="input-name" value="${escapeHtml(provider.name)}">
      </div>
      <div class="modal-form-group">
        <label>API 地址</label>
        <input type="text" id="input-url" value="${escapeHtml(provider.apiUrl)}">
      </div>
      <div class="modal-form-group">
        <label>API 密钥（Ollama 可留空）</label>
        <input type="password" id="input-key" value="${escapeHtml(provider.apiKey)}">
      </div>
      <div class="modal-form-group">
        <label>默认模型</label>
        <div style="display:flex;gap:8px;align-items:center;">
          <input type="text" id="input-model" value="${escapeHtml(provider.model)}" style="flex:1;">
          <button type="button" class="btn btn-sm" id="btn-fetch-models" style="white-space:nowrap;">获取模型</button>
        </div>
      </div>
      <div class="modal-form-group">
        <label>描述（可选）</label>
        <input type="text" id="input-desc" value="${escapeHtml(provider.description || '')}">
      </div>
    `,
    footer: `
      <button class="btn" id="btn-cancel">取消</button>
      <button class="btn btn-primary" id="btn-save">保存</button>
    `
  });

  document.getElementById('btn-cancel').addEventListener('click', closeModal);
  wireProviderTypeSelect();
  const fetchBtnEdit = document.getElementById('btn-fetch-models');
  if (fetchBtnEdit) fetchBtnEdit.addEventListener('click', () => {
    const provider = {
      type: document.getElementById('input-type').value,
      apiUrl: document.getElementById('input-url').value.trim(),
      apiKey: document.getElementById('input-key').value.trim(),
      model: document.getElementById('input-model').value.trim()
    };
    fetchAndFillModels(document.getElementById('input-model'), provider);
  });
  document.getElementById('btn-save').addEventListener('click', async () => {
    const updates = {
      type: document.getElementById('input-type').value,
      name: document.getElementById('input-name').value.trim(),
      apiUrl: document.getElementById('input-url').value.trim(),
      apiKey: document.getElementById('input-key').value.trim(),
      model: document.getElementById('input-model').value.trim(),
      description: document.getElementById('input-desc').value.trim()
    };

    if (!updates.name || !updates.apiUrl) {
      showToast('信息不完整', '名称和API地址为必填项', 'warning');
      return;
    }

    const result = await window.api.updateCloudProvider({ id: provider.id, ...updates });
    if (result.success) {
      const idx = state.cloudProviders.findIndex(p => p.id === provider.id);
      if (idx !== -1) state.cloudProviders[idx] = result.data;
      syncAISettings();
      renderCloudProviders();
      closeModal();
      showToast('保存成功', '', 'success');
    } else {
      showToast('保存失败', result.error, 'error');
    }
  });
}

// ==================== Ollama 与预设 ====================
async function checkOllamaConnection(retries = 3) {
  const statusEl = document.getElementById('ollama-status');
  if (!statusEl) return;
  
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const result = await window.api.ollamaTest('http://localhost:11434');
      if (result.connected) {
        statusEl.textContent = '已连接';
        statusEl.classList.add('connected');
        statusEl.classList.remove('error');
        const ollamaSection = document.getElementById('ollama-section');
        if (ollamaSection) ollamaSection.style.display = 'block';
        loadOllamaModels();
        return;
      }
    } catch (e) {
      console.log('[Ollama] connection check failed (attempt ' + (attempt + 1) + '/' + retries + '):' + e.message);
    }
    
    if (attempt < retries - 1) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
  
  statusEl.textContent = '未连接';
  statusEl.classList.add('error');
  statusEl.classList.remove('connected');
}

// Update preset card status
function updatePresetCardStatus() {
  if (!state.cloudProviders || !Array.isArray(state.cloudProviders)) return;
  
  const presetTypeMap = {
    'ollama': 'ollama',
    'bailian': 'bailian',
    'deepseek': 'deepseek',
    'openai': 'openai',
    'anthropic': 'anthropic',
    'google': 'google',
    'zhipu': 'zhipu',
    'tencent': 'tencent',
    'baidu': 'baidu',
    'moonshot': 'moonshot',
    'bytedance': 'bytedance'
  };
  
  const presetCards = document.querySelectorAll('.preset-card');
  presetCards.forEach(card => {
    const presetType = card.getAttribute('data-preset');
    const statusEl = card.querySelector('.preset-status');
    if (!statusEl || !presetType) return;
    
    if (presetType === 'ollama') return;
    
    const providerType = presetTypeMap[presetType] || presetType;
    const hasProvider = state.cloudProviders.some(p => p.type === providerType);
    
    if (hasProvider) {
      statusEl.textContent = '已配置';
      statusEl.classList.add('connected');
      statusEl.classList.remove('error');
      card.classList.add('configured');
    } else {
      if (statusEl.textContent !== '已配置') {
        statusEl.textContent = '点击配置';
      }
    }
  });
}

async function loadOllamaModels() {
  const listEl = document.getElementById('ollama-models-list');
  if (!listEl) return;
  listEl.innerHTML = '<div class="empty-state-sm"><div class="empty-text">正在获取模型列表...</div></div>';

  const result = await window.api.ollamaListModels('http://localhost:11434');
  if (!result.success || !result.models || result.models.length === 0) {
    listEl.innerHTML = `
      <div class="empty-state-sm">
        <div class="empty-text">${result.connected ? 'Ollama 中暂无模型' : 'Ollama 未连接'}</div>
        <div class="empty-hint">${result.connected ? '使用 ollama pull <模型名> 下载模型' : '请先启动 Ollama 服务'}</div>
      </div>
    `;
    return;
  }

  listEl.innerHTML = '';
  result.models.forEach(model => {
    const item = document.createElement('div');
    item.className = 'ollama-model-item';
    const alreadyAdded = state.cloudProviders.some(p => p.type === 'ollama' && p.model === model.name);
    // 根据模型名称自动识别对应图标（如 qwen→阿里, llama→Meta, mistral→Mistral）
    const modelIconId = window.ModelIcons ? window.ModelIcons.detectIconId(model.name) : 'ollama';
    item.innerHTML = `
      <span class="config-type-icon model-icon-wrap">${window.ModelIcons ? window.ModelIcons.renderIconHtml(modelIconId, 'model-icon', '24px') : window.ElIcons.getIcon('ollama')}</span>
      <div class="ollama-model-info">
        <div class="ollama-model-name">${escapeHtml(model.name)}</div>
        <div class="ollama-model-meta">${model.sizeFormatted || '-'}${model.modifiedAt ? ' · ' + model.modifiedAt.split('T')[0] : ''}</div>
      </div>
      <button class="btn btn-sm ${alreadyAdded ? '' : 'btn-primary'}" ${alreadyAdded ? 'disabled' : ''}>
        ${alreadyAdded ? '已添加' : '添加为提供商'}
      </button>
    `;
    if (!alreadyAdded) {
      item.querySelector('button').addEventListener('click', async () => {
        const r = await window.api.addCloudProvider({
          name: `Ollama · ${model.name}`,
          apiUrl: 'http://localhost:11434',
          apiKey: '',
          model: model.name,
          description: `Ollama 本地模型 ${model.sizeFormatted || ''}`,
          type: 'ollama'
        });
        if (r.success) {
          state.cloudProviders.push(r.data);
          syncAISettings();
          await setActiveProvider(r.data.id, { toast: null }); // 新增即选中
          renderCloudProviders();
          renderAISettings();
          loadOllamaModels();
          updatePresetCardStatus();
          showToast('添加成功', `${model.name} 已添加并设为当前模型`, 'success');
        } else {
          showToast('添加失败', r.error, 'error');
        }
      });
    }
    listEl.appendChild(item);
  });
}

function setupPresetCards() {
  document.querySelectorAll('.preset-card').forEach(card => {
    card.addEventListener('click', () => {
      const preset = card.dataset.preset;
      handlePresetClick(preset);
    });
  });

  const refreshBtn = document.getElementById('btn-refresh-ollama');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => {
      checkOllamaConnection();
    });
  }
}

async function handlePresetClick(preset) {
  if (preset === 'custom') {
    // 其他/自定义：打开添加提供商弹窗
    addCloudProvider();
    return;
  }
  if (preset === 'ollama') {
    // Ollama: 刷新连接状态并展开模型列表
    await checkOllamaConnection();
    if (document.getElementById('ollama-section').style.display === 'block') {
      loadOllamaModels();
      showToast('Ollama 已连接', '请在下方选择要添加的模型', 'success');
    } else {
      // 如果未连接，仍可手动添加
      const exists = state.cloudProviders.some(p => p.type === 'ollama');
      if (!exists) {
        addOllamaManual();
      } else {
        showToast('Ollama 未连接', '请先启动 Ollama 服务（ollama serve）', 'warning');
      }
    }
    return;
  }

  // 百炼 / DeepSeek / OpenAI: 弹出配置对话框
  const presets = await window.api.getProviderPresets();
  const p = presets[preset];
  if (!p) return;

  const exists = state.cloudProviders.some(pro => pro.name === p.name);
  if (exists) {
    showToast('已存在', `${p.name} 已经添加过了`, 'info');
    return;
  }

  showPresetConfigModal(preset, p);
}

function addOllamaManual() {
  showModal({
    title: '配置 Ollama',
    body: `
      <div class="modal-info-box">
        <strong>使用前提：</strong><br>
        1. 已安装 Ollama（<a href="#" id="ollama-link">ollama.com</a>）<br>
        2. Ollama 服务正在运行（命令行执行 <code>ollama serve</code>）<br>
        3. 已拉取模型（如 <code>ollama pull llama3</code>）
      </div>
      <div class="modal-form-group">
        <label>Ollama 服务地址</label>
        <input type="text" id="input-url" value="http://localhost:11434">
      </div>
      <div class="modal-form-group">
        <label>模型名称</label>
        <input type="text" id="input-model" placeholder="llama3 / qwen2 / mistral ..." value="llama3">
      </div>
      <div class="modal-form-group">
        <label>显示名称（可选）</label>
        <input type="text" id="input-name" placeholder="Ollama 本地" value="Ollama 本地">
      </div>
    `,
    footer: `
      <button class="btn" id="btn-cancel">取消</button>
      <button class="btn btn-primary" id="btn-save">保存</button>
    `
  });
  document.getElementById('btn-cancel').addEventListener('click', closeModal);
  document.getElementById('btn-save').addEventListener('click', async () => {
    const apiUrl = document.getElementById('input-url').value.trim();
    const model = document.getElementById('input-model').value.trim();
    const name = document.getElementById('input-name').value.trim() || `Ollama · ${model}`;
    if (!apiUrl || !model) {
      showToast('信息不完整', '服务地址和模型名称为必填项', 'warning');
      return;
    }
    const r = await window.api.addCloudProvider({
      name, apiUrl, apiKey: '', model, description: 'Ollama 本地模型', type: 'ollama'
    });
    if (r.success) {
      state.cloudProviders.push(r.data);
      syncAISettings();
      await setActiveProvider(r.data.id, { toast: null }); // 新增即选中
      renderCloudProviders();
      renderAISettings();
      closeModal();
      showToast('添加成功', `${name} 已添加并设为当前模型`, 'success');
    } else {
      showToast('添加失败', r.error, 'error');
    }
  });
}

function showPresetConfigModal(preset, p) {
  const isBailian = preset === 'bailian';
  const titleText = isBailian ? '配置阿里云百炼' : `配置 ${p.name}`;
  showModal({
    title: titleText,
    body: `
      ${isBailian ? `
      <div class="modal-info-box">
        <strong>获取 API Key：</strong><br>
        1. 访问阿里云百炼控制台（bailian.console.aliyun.com）<br>
        2. 开通服务并创建 API-KEY<br>
        3. 常用模型：qwen-plus / qwen-turbo / qwen-max / qwen-long
      </div>
      ` : ''}
      <div class="modal-form-group">
        <label>提供商名称</label>
        <input type="text" id="input-name" value="${escapeHtml(p.name)}">
      </div>
      <div class="modal-form-group">
        <label>API 地址</label>
        <input type="text" id="input-url" value="${escapeHtml(p.apiUrl)}">
      </div>
      <div class="modal-form-group">
        <label>API 密钥</label>
        <input type="password" id="input-key" placeholder="${p.type === 'ollama' ? 'Ollama 无需密钥' : 'sk-...'}">
      </div>
      <div class="modal-form-group">
        <label>模型名称</label>
        <input type="text" id="input-model" value="${escapeHtml(p.model)}">
      </div>
      <div class="modal-form-group">
        <label>描述</label>
        <input type="text" id="input-desc" value="${escapeHtml(p.description)}">
      </div>
    `,
    footer: `
      <button class="btn" id="btn-cancel">取消</button>
      <button class="btn btn-primary" id="btn-save">保存</button>
    `
  });

  document.getElementById('btn-cancel').addEventListener('click', closeModal);
  document.getElementById('btn-save').addEventListener('click', async () => {
    const name = document.getElementById('input-name').value.trim();
    const apiUrl = document.getElementById('input-url').value.trim();
    const apiKey = document.getElementById('input-key').value.trim();
    const model = document.getElementById('input-model').value.trim();
    const description = document.getElementById('input-desc').value.trim();
    if (!name || !apiUrl) {
      showToast('信息不完整', '名称和API地址为必填项', 'warning');
      return;
    }
    const r = await window.api.addCloudProvider({
      name, apiUrl, apiKey, model, description, type: p.type
    });
    if (r.success) {
      state.cloudProviders.push(r.data);
      syncAISettings();
      await setActiveProvider(r.data.id, { toast: null }); // 新增即选中
      renderCloudProviders();
      renderAISettings();
      closeModal();
      showToast('添加成功', `${name} 已设为当前模型`, 'success');
    } else {
      showToast('添加失败', r.error, 'error');
    }
  });
}

async function saveAISettings() {
  const ctxWinEl = document.getElementById('context-window');
  const ai = buildAIConfig({
    temperature: parseFloat(document.getElementById('temperature').value),
    maxTokens: parseInt(document.getElementById('max-tokens').value),
    // 0 / 空 = 自动识别上下文窗口，保存为 0 便于读取统一
    contextWindow: ctxWinEl ? (parseInt(ctxWinEl.value, 10) || 0) : (parseInt(state.settings.ai?.contextWindow, 10) || 0),
    systemPrompt: document.getElementById('system-prompt').value
  });

  await window.api.setConfig({ ai });
  state.settings.ai = ai;
}

// ==================== 设置 ====================
function renderSettings() {
  const pet = state.settings.pet || {};
  const sys = state.settings.system || {};

  document.getElementById('pet-size').value = pet.size || 1;
  document.getElementById('pet-size-value').textContent = ((pet.size || 1) * 100).toFixed(0) + '%';
  document.getElementById('pet-opacity').value = pet.opacity != null ? pet.opacity : 0;
  document.getElementById('pet-opacity-value').textContent = ((pet.opacity != null ? pet.opacity : 0) * 100).toFixed(0) + '%';
  document.getElementById('pet-framerate').value = String(pet.frameRate || 60);
  if (window.CustomSelect) window.CustomSelect.sync(document.getElementById('pet-framerate'));
  // 色彩调节（饱和度/亮度/色相）
  const col = pet.color || {};
  const colSat = (typeof col.saturation === 'number' && isFinite(col.saturation)) ? col.saturation : 1;
  const colBri = (typeof col.brightness === 'number' && isFinite(col.brightness)) ? col.brightness : 1;
  const colHue = (typeof col.hue === 'number' && isFinite(col.hue)) ? col.hue : 0;
  const colSatNode = document.getElementById('pet-col-sat');
  const colBriNode = document.getElementById('pet-col-bri');
  const colHueNode = document.getElementById('pet-col-hue');
  if (colSatNode) { colSatNode.value = colSat; document.getElementById('pet-col-sat-value').textContent = colSat.toFixed(2); }
  if (colBriNode) { colBriNode.value = colBri; document.getElementById('pet-col-bri-value').textContent = colBri.toFixed(2); }
  if (colHueNode) { colHueNode.value = colHue; document.getElementById('pet-col-hue-value').textContent = colHue + '°'; }
  document.getElementById('pet-topmost').checked = pet.alwaysOnTop !== false;
  document.getElementById('pet-clickthrough').checked = pet.clickThrough || false;
  const showInputEl = document.getElementById('pet-show-input');
  if (showInputEl) showInputEl.checked = pet.showInput !== false;
  const showCtxEl = document.getElementById('pet-show-contextmenu');
  if (showCtxEl) showCtxEl.checked = pet.showContextMenu !== false;
  // 渲染倍率（同时影响模型和键盘叠加层清晰度）
  const renderScaleEl = document.getElementById('pet-render-scale');
  if (renderScaleEl) {
    const rs = (typeof pet.renderScale === 'number' && isFinite(pet.renderScale)) ? pet.renderScale : 1.0;
    renderScaleEl.value = rs;
    document.getElementById('pet-render-scale-value').textContent = rs.toFixed(1) + 'x';
  }
  document.getElementById('confirm-danger').checked = sys.confirmDangerOps !== false;
  document.getElementById('show-notifications').checked = sys.showNotifications !== false;
  document.getElementById('auto-start').checked = sys.autoStart || false;
  document.getElementById('language').value = sys.language || 'zh-CN';
  if (window.CustomSelect) window.CustomSelect.sync(document.getElementById('language'));

  const theme = sys.theme || 'dark';
  document.querySelectorAll('.theme-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.theme === theme);
  });
  const accent = sys.accent || 'red';
  document.querySelectorAll('.accent-dot').forEach(d => {
    d.classList.toggle('active', d.dataset.accent === accent);
  });

  // 系统外观（Windows only）—— 任务栏 + 开始菜单统一管理
  const sysSection = document.getElementById('system-appearance-section');
  if (sysSection) {
    sysSection.style.display = '';
    loadSystemAppearanceState();
  }
}

/**
 * 渲染"系统外观"面板：任务栏效果 + 开始菜单效果（各自独立，无总开关）。
 * 配置里没有 effect 时回落到 'normal'（默认=系统原生外观）。
 */
async function loadSystemAppearanceState() {
  const tbEffectSelect = document.getElementById('taskbar-effect-select');
  const smEffectSelect = document.getElementById('startmenu-effect-select');

  try {
    const cfg = await window.api.getConfig();
    const tbCfg = (cfg && cfg.taskbar) || {};
    const smCfg = (cfg && cfg.startMenu) || {};

    // 兼容旧配置：上一版有"启用自定义系统外观"总开关，enabled=false 时实际就是系统原生
    // 外观（旧版只在开关打开时才应用 effect），此时下拉回落到「默认」，
    // 避免界面显示「透明/亚克力」而系统实际是原生外观。
    // ★ 直接读 effect：不再有 `enabled===false → 强制 normal` 的旧字段兼容 ——
    //   defaultConfig 里 enabled 恰好是 false，会把用户选好的效果在读回时整体劫持成
    //   "默认"（表现为"重启/关页面后设置变回默认"，实际存储是好的）。已废弃该字段语义。
    const tbEffect = tbCfg.effect || 'normal';
    const smEffect = smCfg.effect || 'normal';

    // ★ 设完 value 必须同步自绘下拉的显示标签：CustomSelect 把原生 select 藏起来
    //   自绘文字，程序化 .value 赋值不触发 change → 标签不刷新，收起状态永远显示
    //   「默认」（实际效果已生效）。见 custom-select.js 的 CustomSelect.sync 注释。
    if (tbEffectSelect) {
      tbEffectSelect.value = tbEffect;
      if (window.CustomSelect) window.CustomSelect.sync(tbEffectSelect);
    }
    if (smEffectSelect) {
      smEffectSelect.value = smEffect;
      if (window.CustomSelect) window.CustomSelect.sync(smEffectSelect);
    }

    // 弹层同步二级开关回显（每个弹层目标独立）。
    // 兼容旧格式：布尔 false = 全关；true/无字段 = 全开；对象 = 按键取值。
    // 任务栏效果为「默认」时没有可同步的效果 → 全部置灰（不改高度，避免双列重排）。
    const syncMap = (() => {
      const v = tbCfg.flyoutSync;
      const allOff = v === false;
      const obj = (v && typeof v === 'object') ? v : {};
      return {
        notification: !allOff && obj.notification !== false,
        // 旧 contextmenu（右击菜单栏）已并入托盘弹窗：旧配置为 false 时跟随关闭
        overflow: !allOff && obj.overflow !== false && obj.contextmenu !== false,
        quicksettings: !allOff && obj.quicksettings !== false
      };
    })();
    const flyoutDisabled = (tbEffect === 'normal');
    for (const key of ['notification', 'overflow', 'quicksettings']) {
      const toggle = document.getElementById('flyout-sync-' + key);
      if (toggle) {
        toggle.checked = syncMap[key];
        toggle.disabled = flyoutDisabled;
      }
    }
  } catch (e) {
    console.warn('加载系统外观配置失败:', e);
  }
}

async function saveSettings() {
  const pet = {
    size: parseFloat(document.getElementById('pet-size').value),
    opacity: parseFloat(document.getElementById('pet-opacity').value),
    frameRate: parseInt(document.getElementById('pet-framerate').value),
    alwaysOnTop: document.getElementById('pet-topmost').checked,
    clickThrough: document.getElementById('pet-clickthrough').checked,
    showInput: document.getElementById('pet-show-input')?.checked ?? true,
    showContextMenu: document.getElementById('pet-show-contextmenu')?.checked ?? true,
    renderScale: parseFloat(document.getElementById('pet-render-scale')?.value ?? 1.0),
    color: {
      saturation: parseFloat(document.getElementById('pet-col-sat')?.value ?? 1),
      brightness: parseFloat(document.getElementById('pet-col-bri')?.value ?? 1),
      hue: parseInt(document.getElementById('pet-col-hue')?.value ?? 0, 10)
    }
  };

  const sys = {
    confirmDangerOps: document.getElementById('confirm-danger').checked,
    showNotifications: document.getElementById('show-notifications').checked,
    autoStart: document.getElementById('auto-start').checked,
    language: document.getElementById('language').value,
    theme: document.querySelector('.theme-btn.active')?.dataset.theme || 'dark',
    accent: document.querySelector('.accent-dot.active')?.dataset.accent || 'red'
  };

  // 任务栏外观不进应用配置：它直接对应系统设置（开关值实时从注册表读），存两份会不一致。
  // 旧的 taskbar.enabled / taskbar.effect 已废弃 —— 那个效果在本机无法安全实现。
  await window.api.setConfig({ pet, system: sys });
  state.settings.pet = { ...state.settings.pet, ...pet };
  state.settings.system = { ...state.settings.system, ...sys };

  // ★ 内存优化：设置中关闭输入框或右键菜单时，关闭对应的独立窗口，释放资源
  if (!pet.showInput) {
    console.log('[MemoryOptimizer] 设置中关闭输入框，关闭输入框窗口');
    if (window.api && window.api.hideInputBar) {
      window.api.hideInputBar().catch(() => {});
    }
  }
  if (!pet.showContextMenu) {
    console.log('[MemoryOptimizer] 设置中关闭右键菜单，关闭右键菜单窗口');
    if (window.api && window.api.closeContextMenu) {
      window.api.closeContextMenu().catch(() => {});
    }
  }

  applyTheme(sys.theme);

  // 仅当宠物设置实际变化时才发送到主进程，避免不必要的窗口操作导致位移
  const petSnapshot = JSON.stringify({
    size: Math.round(pet.size * 100) / 100,
    opacity: Math.round(pet.opacity * 100) / 100,
    frameRate: pet.frameRate,
    alwaysOnTop: pet.alwaysOnTop,
    clickThrough: pet.clickThrough,
    renderScale: Math.round(pet.renderScale * 100) / 100,
    color: {
      saturation: Math.round(pet.color.saturation * 100) / 100,
      brightness: Math.round(pet.color.brightness * 100) / 100,
      hue: pet.color.hue
    }
  });
  if (petSnapshot !== lastSentPetSettings) {
    try {
      await window.api.applyPetSettings(pet);
      lastSentPetSettings = petSnapshot;
    } catch (e) {
      console.warn('应用宠物设置失败:', e.message);
    }
  }

  // 实时设置开机自启
  try {
    await window.api.setAutoStart(sys.autoStart);
  } catch (e) {
    console.warn('设置开机自启失败:', e.message);
  }
}

// 当前主题设置（dark/light/auto），用于系统主题变化时判断是否自动切换
let currentThemeSetting = 'dark';
// 系统主题变化监听器引用，用于切换主题时移除旧监听器
let systemThemeListener = null;

function applyTheme(theme) {
  currentThemeSetting = theme || 'dark';

  // 移除之前的系统主题变化监听器
  if (systemThemeListener) {
    try {
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      if (mq.removeEventListener) mq.removeEventListener('change', systemThemeListener);
      else if (mq.removeListener) mq.removeListener(systemThemeListener);
    } catch (e) {}
    systemThemeListener = null;
  }

  if (theme === 'auto') {
    // 跟随系统：检测当前系统主题并应用
    const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    document.documentElement.setAttribute('data-theme', isDark ? 'dark' : 'light');

    // 监听系统主题变化，自动切换
    systemThemeListener = (e) => {
      if (currentThemeSetting === 'auto') {
        document.documentElement.setAttribute('data-theme', e.matches ? 'dark' : 'light');
        updateLogoColors();
      }
    };;
    try {
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      if (mq.addEventListener) mq.addEventListener('change', systemThemeListener);
      else if (mq.addListener) mq.addListener(systemThemeListener);
    } catch (e) {}
  } else {
    // 固定主题：直接应用 dark/light
    document.documentElement.setAttribute('data-theme', theme);
  }
  // 更新工具栏图标样式（浅色模式下使用描边式）
  updateToolbarIconStyles();
  // 深色模式 Logo 用粉色版，浅色模式用原色
  updateLogoColors();
}

// 根据当前主题切换 Logo 颜色（深色=粉色线稿，浅色=原黑色线稿）
function updateLogoColors() {
  const isDark = document.documentElement.getAttribute('data-theme') !== 'light';
  const pinkSrc = '../../assets/icons/logo-pink.png';
  const origSrc = '../../assets/icons/logo.png';
  document.querySelectorAll('.logo-icon-img, .about-logo-img').forEach(img => {
    img.src = isDark ? pinkSrc : origSrc;
  });
}
// 强调色（主题色）切换：作用于 <html data-accent="...">，覆盖 --accent/--primary 系列
function applyAccent(accent) {
  document.documentElement.setAttribute('data-accent', accent || 'red');
}

// 基于当前宠物位置做相对位移（滑块为 Δx/Δy，应用后归零）
async function applyPetPositionNudge() {
  const dx = parseInt(document.getElementById('pet-posx')?.value || '0', 10);
  const dy = parseInt(document.getElementById('pet-posy')?.value || '0', 10);
  try {
    const pos = await window.api.getPetPosition();
    if (pos) {
      await window.api.petDrag((pos.x || 0) + dx, (pos.y || 0) + dy);
    }
    const px = document.getElementById('pet-posx'), py = document.getElementById('pet-posy');
    if (px) { px.value = 0; document.getElementById('pet-posx-value').textContent = '0'; }
    if (py) { py.value = 0; document.getElementById('pet-posy-value').textContent = '0'; }
    if (window.showToast) window.showToast('已移动灵汐', `Δx=${dx} Δy=${dy}`, 'success');
  } catch (e) {
    console.warn('应用位置失败:', e.message);
    if (window.showToast) window.showToast('移动失败', e.message, 'error');
  }
}

// 仅恢复桌宠外观默认值（大小/透明度/色彩/渲染倍率），其余设置不变
async function resetPetDisplay() {
  const sizeEl = document.getElementById('pet-size');
  const opacityEl = document.getElementById('pet-opacity');
  if (sizeEl) { sizeEl.value = 1; document.getElementById('pet-size-value').textContent = '100%'; }
  if (opacityEl) { opacityEl.value = 0; document.getElementById('pet-opacity-value').textContent = '0%'; }
  const colSatEl = document.getElementById('pet-col-sat');
  const colBriEl = document.getElementById('pet-col-bri');
  const colHueEl = document.getElementById('pet-col-hue');
  if (colSatEl) { colSatEl.value = 1; document.getElementById('pet-col-sat-value').textContent = '1.00'; }
  if (colBriEl) { colBriEl.value = 1; document.getElementById('pet-col-bri-value').textContent = '1.00'; }
  if (colHueEl) { colHueEl.value = 0; document.getElementById('pet-col-hue-value').textContent = '0°'; }
  // 重置渲染倍率
  const renderScaleEl = document.getElementById('pet-render-scale');
  if (renderScaleEl) {
    renderScaleEl.value = 1.0;
    document.getElementById('pet-render-scale-value').textContent = '1.0x';
    if (window.api && typeof window.api.setPetRenderScale === 'function') {
      window.api.setPetRenderScale(1.0);
    }
  }
  // ★ 重置 lastSentPetSettings，确保新设置被发送到主进程（解决设置后无法回到默认值的问题）
  lastSentPetSettings = null;
  await saveSettings();
  if (window.showToast) window.showToast('已恢复默认', '大小/透明度/色彩/渲染倍率已重置', 'success');
}

async function resetConfig() {
  const confirmed = await showConfirm({
    type: 'warning',
    title: '重置配置',
    message: '确定要重置所有配置吗？',
    detail: '所有个性化设置将被清除，恢复默认值。此操作不可撤销。'
  });
  if (!confirmed) return;

  await window.api.resetConfig();
  state.settings = await window.api.getConfig();
  lastSentPetSettings = null; // 重置快照，确保新设置被发送
  applySettings();
  loadCloudProviders();
  loadLocalModels();
  renderAIConfig();
  updateModelStatusBar();
  showToast('已重置', '所有配置已恢复默认', 'success');
}

async function exportConfig() {
  const filePath = await window.api.saveFile({
    defaultPath: `ai_lobster_config_${Date.now()}.json`,
    filters: [{ name: 'JSON', extensions: ['json'] }]
  });
  if (!filePath) return;
  const config = await window.api.getConfig();
  const result = await window.api.writeFile({ path: filePath, content: JSON.stringify(config, null, 2) });
  if (result.success) {
    showToast('导出成功', '配置已保存到所选文件', 'success');
  } else {
    showToast('导出失败', result.error, 'error');
  }
}

async function importConfig() {
  const paths = await window.api.selectFiles({
    filters: [{ name: 'JSON', extensions: ['json'] }]
  });
  if (!paths || paths.length === 0) return;
  const result = await window.api.readFile({ path: paths[0] });
  if (!result.success) {
    showToast('读取失败', result.error, 'error');
    return;
  }
  try {
    const importedConfig = JSON.parse(result.data);
    await window.api.setConfig(importedConfig);
    state.settings = await window.api.getConfig();
    lastSentPetSettings = null; // 重置快照，确保导入的设置被发送
    applySettings();
    loadCloudProviders();
    loadLocalModels();
    renderAIConfig();
    updateModelStatusBar();
    showToast('导入成功', '配置已恢复', 'success');
  } catch (e) {
    showToast('导入失败', '配置文件格式错误', 'error');
  }
}


function applySettings() {
  const sys = state.settings.system || {};
  if (sys.theme) applyTheme(sys.theme);
  applyAccent(sys.accent || 'red');

  // 应用语言（实时翻译整个界面）
  const lang = sys.language || 'zh-CN';
  if (window.I18N && window.I18N.applyLanguage) {
    window.I18N.applyLanguage(lang);
  }
  const langSelect = document.getElementById('language');
  if (langSelect) {
    langSelect.value = lang;
    if (window.CustomSelect) window.CustomSelect.sync(langSelect);
  }

  // 填充设置表单
  renderSettings();

  // 启动时应用宠物外观设置
  const pet = state.settings.pet || {};
  if (Object.keys(pet).length > 0) {
    // 初始化快照，避免首次 saveSettings 时重复发送
    lastSentPetSettings = JSON.stringify({
      size: Math.round((pet.size || 1) * 100) / 100,
      opacity: Math.round((pet.opacity != null ? pet.opacity : 0) * 100) / 100,
      frameRate: pet.frameRate || 60,
      alwaysOnTop: pet.alwaysOnTop !== false,
      clickThrough: pet.clickThrough || false,
      renderScale: Math.round((pet.renderScale || 1.0) * 100) / 100
    });
    // 启动时应用渲染倍率
    if (pet.renderScale && window.api && typeof window.api.setPetRenderScale === 'function') {
      window.api.setPetRenderScale(pet.renderScale);
    }
    window.api.applyPetSettings(pet).catch(() => {});
  }
}

// ==================== 对话框 ====================
function showModal({ title, body, footer }) {
  document.getElementById('modal-title').textContent = title;
  document.getElementById('modal-body').innerHTML = body;
  document.getElementById('modal-footer').innerHTML = footer || '';
  document.getElementById('modal-overlay').classList.add('show');
}

function closeModal() {
  document.getElementById('modal-overlay').classList.remove('show');
  const m = document.getElementById('modal');
  if (m) m.classList.remove('ae-modal');
  _destroyActionPreview();
}

async function showConfirm({ type = 'warning', title, message, detail, buttons = ['确定', '取消'] }) {
  // 使用应用内自定义对话框（非系统原生弹窗），返回 boolean（点击主按钮为 true）
  return await window.AppDialog.confirm({ type, title, message, detail, buttons });
}

// ==================== Toast ====================
function showToast(title, message, type = 'info', options = {}) {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  const I = window.ElIcons.getIcon;
  const icons = { success: 'success', error: 'error', warning: 'warning', info: 'info' };
  toast.innerHTML = `
    <div class="toast-icon">${I(icons[type] || 'info')}</div>
    <div>
      <div class="toast-title">${escapeHtml(title)}</div>
      ${message ? `<div class="toast-message">${(options && options.useHtml) ? message : escapeHtml(message)}</div>` : ''}
    </div>
  `;
  container.appendChild(toast);

  // options.duration：报错时带操作建议的提示需要多留一会儿（默认 3.5s 来不及看）
  const lifespan = Number(options && options.duration) || 3500;
  setTimeout(() => {
    toast.style.transition = 'all 0.3s ease';
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(120%)';
    setTimeout(() => toast.remove(), 300);
  }, lifespan);
}

// ==================== 更新公告 ====================

const CHANGE_TYPE_META = {
  feature:     { icon: 'sparkles',  color: '#4fc3f7', label: '新功能' },
  fix:         { icon: 'check',     color: '#4caf50', label: '修复' },
  improvement: { icon: 'lightning', color: '#ff9800', label: '优化' },
  notice:      { icon: 'warning',   color: '#f44336', label: '公告' }
};

// 渲染更新公告页面（融入关于页面）- 默认只展开最新版本
async function getPatchedChangelog() {
  try {
    // 从模型路径推断 userData 目录（兼容打包版，无需主进程改动）
    const models = await window.api.listModels();
    let userData = null;
    if (models && models.length > 0) {
      const mp = models[0].installPath || models[0].path || models[0].modelPath || '';
      const idx = mp.indexOf('ai-lobster');
      if (idx > 0) userData = mp.substring(0, idx + 'ai-lobster'.length);
    }
    if (!userData) return null;
    const sep = userData.includes('/') ? '/' : '\\';
    // 读取 applied.json
    const appliedRes = await window.api.readFile({ path: userData + sep + 'patches' + sep + 'applied.json' });
    if (!appliedRes || !appliedRes.success) return null;
    const applied = JSON.parse(appliedRes.data);
    if (!Array.isArray(applied) || applied.length === 0) return null;
    // 版本降序
    applied.sort((a, b) => {
      const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
      for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        if ((pa[i]||0) !== (pb[i]||0)) return (pb[i]||0) - (pa[i]||0);
      }
      return 0;
    });
    // 收集所有补丁中的更新日志
    const allEntries = [];
    const seenVersions = new Set();
    for (const ver of applied) {
      const clRes = await window.api.readFile({ path: userData + sep + 'patches' + sep + ver + sep + 'renderer' + sep + 'data' + sep + 'changelog.json' });
      if (clRes && clRes.success) {
        const data = JSON.parse(clRes.data);
        if (Array.isArray(data) && data.length > 0) {
          for (const entry of data) {
            if (entry && entry.version && !seenVersions.has(entry.version)) {
              seenVersions.add(entry.version);
              allEntries.push(entry);
            }
          }
        }
      }
    }
    // 合并包体中的更新日志（window.CHANGELOG 或 data/changelog.json）
    let packageChangelog = null;
    if (window.CHANGELOG && Array.isArray(window.CHANGELOG) && window.CHANGELOG.length > 0) {
      packageChangelog = window.CHANGELOG;
    } else {
      try {
        const resp = await fetch('data/changelog.json', { cache: 'no-store' });
        if (resp.ok) packageChangelog = await resp.json();
      } catch (e) {}
    }
    if (packageChangelog && Array.isArray(packageChangelog)) {
      for (const entry of packageChangelog) {
        if (entry && entry.version && !seenVersions.has(entry.version)) {
          seenVersions.add(entry.version);
          allEntries.push(entry);
        }
      }
    }
    // 按版本号降序排序
    allEntries.sort((a, b) => {
      const pa = String(a.version).split('.').map(Number), pb = String(b.version).split('.').map(Number);
      for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        if ((pa[i]||0) !== (pb[i]||0)) return (pb[i]||0) - (pa[i]||0);
      }
      return 0;
    });
    if (allEntries.length > 0) return allEntries;
  } catch (e) { console.error('[changelog] 读取补丁公告失败:', e); }
  return null;
}

async function renderAboutChangelog() {
  const container = document.getElementById('about-changelog-list');
  if (!container) return;

  try {
    let changelog = null;
    // 1. 优先从补丁目录读取（打包版也能用）
    changelog = await getPatchedChangelog();
    // 2. 回退 window.CHANGELOG（由 data/changelog.js 注入）
    if (!changelog && window.CHANGELOG && Array.isArray(window.CHANGELOG) && window.CHANGELOG.length > 0) {
      changelog = window.CHANGELOG;
    }
    // 3. 回退 fetch JSON
    if (!changelog) {
      try {
        const resp = await fetch('data/changelog.json', { cache: 'no-store' });
        if (resp.ok) changelog = await resp.json();
      } catch (e) {}
    }
    // 4. 最终回退：主进程 IPC（内置公告）
    if (!changelog || !Array.isArray(changelog)) {
      try { changelog = await window.api.getChangelog(); } catch (e) {}
    }
    if (!changelog || changelog.length === 0) {
      container.innerHTML = '<div class="changelog-empty">暂无更新记录</div>';
      return;
    }

    container.innerHTML = changelog.map((version, index) => {
      const isLatest = index === 0;
      const changesHtml = version.changes.map(change => {
        const meta = CHANGE_TYPE_META[change.type] || CHANGE_TYPE_META.notice;
        return `
          <div class="changelog-change-item">
            <span class="change-badge" style="color: ${meta.color}; border-color: ${meta.color};">
              ${meta.label}
            </span>
            <div class="change-content">
              <div class="change-title">${escapeHtml(change.title)}</div>
              ${change.desc ? `<div class="change-desc">${escapeHtml(change.desc)}</div>` : ''}
            </div>
          </div>
        `;
      }).join('');

      return `
        <div class="changelog-version ${isLatest ? 'expanded' : 'collapsed'}">
          <div class="version-header ${isLatest ? '' : 'clickable'}" data-toggle-version="${index}">
            <div class="version-toggle-icon">${isLatest ? '▾' : '▸'}</div>
            <div class="version-info">
              <span class="version-tag">v${escapeHtml(version.version)}</span>
              <span class="version-date">${escapeHtml(version.date)}</span>
            </div>
            <h3 class="version-title">${escapeHtml(version.title)}</h3>
          </div>
          <div class="version-changes" style="${isLatest ? '' : 'display:none;'}">
            ${changesHtml}
          </div>
        </div>
      `;
    }).join('');

    // 绑定折叠/展开事件
    container.querySelectorAll('.version-header.clickable').forEach(header => {
      header.addEventListener('click', function() {
        const versionDiv = this.closest('.changelog-version');
        const changesDiv = versionDiv.querySelector('.version-changes');
        const icon = this.querySelector('.version-toggle-icon');
        const isExpanded = versionDiv.classList.contains('expanded');

        if (isExpanded) {
          versionDiv.classList.remove('expanded');
          versionDiv.classList.add('collapsed');
          changesDiv.style.display = 'none';
          icon.textContent = '▸';
        } else {
          versionDiv.classList.add('expanded');
          versionDiv.classList.remove('collapsed');
          changesDiv.style.display = '';
          icon.textContent = '▾';
        }
      });
    });
  } catch (err) {
    console.error('加载更新公告失败:', err);
    container.innerHTML = '<div class="changelog-empty">加载失败，请稍后重试</div>';
  }
}

// 检查版本更新，首次启动新版本时自动弹窗
async function checkForUpdates() {
  try {
    const result = await window.api.checkUpdate();
    if (result && result.hasUpdate && result.changes) {
      showChangelogModal(result.changes, result.version);
    }
  } catch (err) {
    console.error('检查更新失败:', err);
  }
}

// 显示更新公告弹窗
function showChangelogModal(versionData, version) {
  const overlay = document.getElementById('changelog-modal-overlay');
  const titleEl = document.getElementById('changelog-modal-title');
  const bodyEl = document.getElementById('changelog-modal-body');
  if (!overlay || !titleEl || !bodyEl) return;

  titleEl.textContent = `更新到 v${version} - ${versionData.title || ''}`;

  const changesHtml = (versionData.changes || []).map(change => {
    const meta = CHANGE_TYPE_META[change.type] || CHANGE_TYPE_META.notice;
    return `
      <div class="changelog-change-item">
        <span class="change-badge" style="color: ${meta.color}; border-color: ${meta.color};">
          ${meta.label}
        </span>
        <div class="change-content">
          <div class="change-title">${escapeHtml(change.title)}</div>
          ${change.desc ? `<div class="change-desc">${escapeHtml(change.desc)}</div>` : ''}
        </div>
      </div>
    `;
  }).join('');

  bodyEl.innerHTML = `
    <div class="changelog-modal-version">
      <span class="version-tag">v${escapeHtml(version)}</span>
      <span class="version-date">${escapeHtml(versionData.date || '')}</span>
    </div>
    <div class="changelog-modal-changes">
      ${changesHtml}
    </div>
  `;

  overlay.classList.add('show');
}

// 设置更新公告弹窗事件监听
function setupChangelogModal() {
  const overlay = document.getElementById('changelog-modal-overlay');
  const closeBtn = document.getElementById('changelog-modal-close');
  const okBtn = document.getElementById('changelog-modal-ok');
  if (!overlay) return;

  const closeModal = () => overlay.classList.remove('show');

  if (closeBtn) closeBtn.addEventListener('click', closeModal);
  if (okBtn) okBtn.addEventListener('click', closeModal);

  // 不响应点击空白处关闭（程序规范：须点击 × / 知道了 关闭）

  // ESC 关闭
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && overlay.classList.contains('show')) {
      closeModal();
    }
  });
}

// ==================== 工具函数 ====================
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}

function formatSize(bytes) {
  if (!bytes && bytes !== 0) return '-';
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const k = 1024;
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + units[i];
}

function debounce(fn, delay) {
  let timer = null;
  return function (...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), delay);
  };
}

// 启动
document.addEventListener('DOMContentLoaded', init);


// ==================== 文件附件上传 ====================
async function addUploadedFile(file) {
  // 上传只保存路径，不限制大小（AI 用 read_file 读取时会自行处理）
  // Electron 的 File 对象有 path 属性（真实本地路径）
  const filePath = file.path || file.name;
  state.uploadedFiles = state.uploadedFiles || [];
  state.uploadedFiles.push({ name: file.name, size: file.size, path: filePath });
  renderUploadedFiles();
  showToast('已添加文件', file.name, 'success');
}

function renderUploadedFiles() {
  let container = document.getElementById('uploaded-files-bar');
  if (!container) {
    container = document.createElement('div');
    container.id = 'uploaded-files-bar';
    container.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;padding:4px 12px;';
    const inputArea = document.querySelector('.chat-input-area');
    inputArea.insertBefore(container, inputArea.firstChild);
  }
  if (!state.uploadedFiles || state.uploadedFiles.length === 0) {
    container.style.display = 'none';
    container.innerHTML = '';
    return;
  }
  container.style.display = 'flex';
  container.innerHTML = state.uploadedFiles.map((f, i) => `
    <div style="display:flex;align-items:center;gap:4px;padding:4px 10px;background:rgba(99,102,241,0.1);border:1px solid rgba(99,102,241,0.3);border-radius:16px;font-size:12px;color:var(--text-primary);">
      <span style="display:inline-flex;align-items:center;gap:6px;">${window.ElIcons.ICONS.document} ${f.name}</span>
      <span style="color:var(--text-muted);font-size:11px;">(${(f.size/1024).toFixed(1)}KB)</span>
      <button onclick="removeUploadedFile(${i})" style="background:none;border:none;color:var(--text-muted);cursor:pointer;padding:0 2px;font-size:14px;line-height:1;">×</button>
    </div>
  `).join('');
}

function removeUploadedFile(index) {
  state.uploadedFiles.splice(index, 1);
  renderUploadedFiles();
}


// ==================== 多角色智能体管理 ====================
async function loadAgentRoles() {
  try {
    state.agentRoles = await window.api.getAgentRoles();
    renderRoleList();
    updateCurrentRoleDisplay();
  } catch (e) {
    console.error('加载角色列表失败:', e);
  }
}

function renderRoleList() {
  const list = document.getElementById('role-list');
  if (!list) return;
  list.innerHTML = state.agentRoles.map(role => `
    <div class="role-item ${role.id === state.currentRoleId ? 'active' : ''}" data-role-id="${role.id}">
      <div class="role-item-icon">${window.RoleIcons ? window.RoleIcons.getRoleIcon(role.id, '28px') : window.ElIcons.ICONS.ai}</div>
      <div class="role-item-info">
        <div class="role-item-name">${role.name}</div>
        <div class="role-item-desc">${role.description || ''}</div>
      </div>
      ${role.isPreset ? '' : '<button class="role-item-edit" data-edit="${role.id}">编辑</button><button class="role-item-delete" data-delete="${role.id}">×</button>'}
    </div>
  `).join('');

  // 角色点击选择
  list.querySelectorAll('.role-item').forEach(item => {
    item.addEventListener('click', (e) => {
      if (e.target.classList.contains('role-item-edit') || e.target.classList.contains('role-item-delete')) return;
      const roleId = item.dataset.roleId;
      selectRole(roleId);
      document.getElementById('role-select-panel').style.display = 'none';
    });
  });

  // 编辑按钮
  list.querySelectorAll('.role-item-edit').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const roleId = btn.dataset.edit;
      openRoleEditModal(roleId);
    });
  });

  // 删除按钮
  list.querySelectorAll('.role-item-delete').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const roleId = btn.dataset.delete;
      if (confirm('确定删除这个角色吗？')) {
        await window.api.deleteAgentRole(roleId);
        if (state.currentRoleId === roleId) state.currentRoleId = 'general';
        await loadAgentRoles();
      }
    });
  });
}

function selectRole(roleId) {
  state.currentRoleId = roleId;
  // 保存到 localStorage
  try { localStorage.setItem('ai-lobster-current-role', roleId); } catch(e) {}
  updateCurrentRoleDisplay();
  renderRoleList();
  const role = state.agentRoles.find(r => r.id === roleId);
  if (role) {
    const roleIcon = window.RoleIcons ? window.RoleIcons.getRoleIcon(role.id, '16px') : '';
    showToast('已切换角色', roleIcon + ' ' + role.name, 'success', { useHtml: true });
  }
}

function updateCurrentRoleDisplay() {
  const role = state.agentRoles.find(r => r.id === state.currentRoleId) || state.agentRoles[0];
  const emojiEl = document.getElementById('current-role-emoji');
  if (emojiEl && role) {
    if (window.RoleIcons) {
      emojiEl.innerHTML = window.RoleIcons.getRoleIcon(role.id, '18px');
      emojiEl.style.display = 'inline-flex';
      emojiEl.style.alignItems = 'center';
      emojiEl.style.justifyContent = 'center';
    } else {
      emojiEl.innerHTML = window.RoleIcons ? window.RoleIcons.getRoleIcon(role.id, '24px') : window.ElIcons.ICONS.ai;
    }
  }
  // 更新工具栏图标样式（浅色模式下使用描边式）
  updateToolbarIconStyles();
  // 深色模式 Logo 用粉色版，浅色模式用原色
  updateLogoColors();
}

// 更新工具栏图标样式：浅色模式下闪电/机器人/扳手使用描边式，深色模式恢复填充式
function updateToolbarIconStyles() {
  // 工具栏图标样式主要通过CSS控制（[data-theme="light"] #btn-xxx）
  // 此函数作为备用，确保RoleIcons图标的颜色正确
  const isLight = document.documentElement.getAttribute('data-theme') === 'light';
  const roleBtn = document.getElementById('btn-role-select');
  if (roleBtn) {
    const roleIcon = roleBtn.querySelector('.role-svg-icon');
    if (roleIcon) {
      if (isLight) {
        roleIcon.style.color = '#1a1a2e';
      } else {
        roleIcon.style.color = '';
      }
    }
  }
}

function openRoleEditModal(roleId) {
  const modal = document.getElementById('role-edit-modal');
  const isNew = !roleId;
  const defaultTools = state.agentTools.length
    ? state.agentTools.map(t => t.name)
    : ['run_shell', 'read_file', 'write_file', 'get_system_info', 'pet_action', 'web_search', 'web_fetch', 'http_request', 'file_search', 'directory_list', 'copy_file', 'move_file', 'create_directory', 'download_file', 'get_current_time', 'calculator', 'check_url', 'open_url'];
  const role = isNew ? { id: 'custom_' + Date.now(), name: '', emoji: '', description: '', systemPrompt: '', tools: defaultTools, temperature: 0.7, maxIterations: 8 } : state.agentRoles.find(r => r.id === roleId);
  if (!role) return;

  document.getElementById('role-edit-title').textContent = isNew ? '新建角色' : '编辑角色';
  document.getElementById('role-edit-name').value = role.name || '';
  document.getElementById('role-edit-emoji').value = role.emoji || '';
  document.getElementById('role-edit-desc').value = role.description || '';
  document.getElementById('role-edit-prompt').value = role.systemPrompt || '';
  document.getElementById('role-edit-temp').value = role.temperature || 0.7;
  document.getElementById('role-edit-iter').value = role.maxIterations || 8;

  document.querySelectorAll('.role-tool-check').forEach(cb => {
    cb.checked = (role.tools || []).includes(cb.value);
  });

  modal.style.display = 'flex';
  modal.dataset.editingId = isNew ? role.id : roleId;
  modal.dataset.isNew = isNew ? '1' : '0';
}

function closeRoleEditModal() {
  document.getElementById('role-edit-modal').style.display = 'none';
}

async function saveRoleFromModal() {
  const modal = document.getElementById('role-edit-modal');
  const id = modal.dataset.editingId;
  const isNew = modal.dataset.isNew === '1';
  const name = document.getElementById('role-edit-name').value.trim();
  if (!name) { alert('角色名称不能为空'); return; }

  const tools = Array.from(document.querySelectorAll('.role-tool-check:checked')).map(cb => cb.value);
  const role = {
    id,
    name,
    emoji: document.getElementById('role-edit-emoji').value.trim() || '',
    description: document.getElementById('role-edit-desc').value.trim(),
    systemPrompt: document.getElementById('role-edit-prompt').value.trim() || null,
    tools,
    temperature: parseFloat(document.getElementById('role-edit-temp').value) || 0.7,
    maxIterations: parseInt(document.getElementById('role-edit-iter').value) || 8
  };

  await window.api.saveAgentRole(role);
  closeRoleEditModal();
  await loadAgentRoles();
  showToast('保存成功', role.emoji + ' ' + role.name, 'success');
}

// ==================== 工具清单（从主进程 AGENT_TOOLS 动态获取） ====================
// 这两个钩子由 setupEventListeners 注入（设置持久化函数定义在它内部，外部拿不到）
let applyAgentSettings = null;
let onAgentToolToggle = null;

async function loadAgentTools() {
  try {
    const tools = await window.api.getAgentTools();
    if (Array.isArray(tools) && tools.length) state.agentTools = tools;
  } catch (e) {
    console.warn('加载工具清单失败:', e);
  }
  renderAgentToolList();
  renderRoleToolList();
  // 渲染完成后重新套用已保存的勾选状态，并绑定 change 事件
  if (typeof applyAgentSettings === 'function') applyAgentSettings();
  document.querySelectorAll('.agent-tool-check').forEach(cb => {
    if (!cb.dataset.bound) {
      cb.dataset.bound = '1';
      cb.addEventListener('change', () => {
        if (typeof onAgentToolToggle === 'function') onAgentToolToggle();
      });
    }
  });
}

function toolLabel(name) {
  const t = window.t ? window.t('tool.' + name) : null;
  return (t && t !== 'tool.' + name) ? t : name;
}

// 根据工具名称返回对应的SVG图标
function getToolIcon(name) {
  const iconMap = {
    'run_shell': 'terminal',
    'write_file': 'edit',
    'read_file': 'document',
    'get_system_info': 'cpu',
    'pet_action': 'lobster',
    'web_search': 'search',
    'web_fetch': 'globe',
    'http_request': 'refresh',
    'file_search': 'files',
    'directory_list': 'list',
    'copy_file': 'copy',
    'move_file': 'move',
    'create_directory': 'folderPlus',
    'download_file': 'download',
    'get_current_time': 'clock',
    'calculator': 'calculator',
    'check_url': 'eye',
    'open_url': 'externalLink',
    // 长期记忆 / 界面自验证
    'memory_save': 'save',
    'memory_search': 'search',
    'memory_list': 'brain',
    'memory_delete': 'delete',
    'capture_window': 'image',
    'verify_ui': 'success',
    'analyze_screenshot': 'eye',
    // 待办事项
    'todo_write': 'list',
    'todo_update': 'success',
    'todo_read': 'list',
  };
  const iconName = iconMap[name] || 'terminal';
  return window.ElIcons.ICONS[iconName] || window.ElIcons.ICONS.terminal;
}

function renderAgentToolList() {
  const box = document.getElementById('agent-tools-list');
  if (!box || !state.agentTools.length) return;
  box.innerHTML = state.agentTools.map(t => `
    <label class="agent-tool-item" title="${t.description || ''}">
      <input type="checkbox" class="agent-tool-check" value="${t.name}" checked>
      <span data-i18n="tool.${t.name}">${toolLabel(t.name)}</span>
    </label>`).join('');
}

function renderRoleToolList() {
  const box = document.getElementById('role-edit-tools');
  if (!box || !state.agentTools.length) return;
  box.innerHTML = state.agentTools.map(t => `
    <label style="display:flex;align-items:center;gap:4px;font-size:12px;color:var(--text-primary);cursor:pointer;" title="${t.description || ''}">
      <input type="checkbox" value="${t.name}" class="role-tool-check"> ${toolLabel(t.name)}
    </label>`).join('');
}

// ==================== AI 长期记忆（Agent 设置面板「AI 记忆」） ====================
// 记忆由主进程的 memory_* 工具写入，这里只做查看/删除/清空，方便用户知道 AI 记了什么。
let memoryCache = [];
const MEMORY_KIND_LABEL = { fact: '事实', preference: '偏好', project: '项目', fix: '修复经验', note: '备注' };

async function loadMemories() {
  const box = document.getElementById('agent-memory-list');
  if (!box) return;
  box.innerHTML = '<div class="agent-memory-empty">加载中…</div>';
  try {
    const items = await window.api.memory.list({ limit: 100 });
    memoryCache = Array.isArray(items) ? items : [];
  } catch (e) {
    console.warn('加载 AI 记忆失败:', e);
    memoryCache = [];
    box.innerHTML = '<div class="agent-memory-empty">读取记忆失败，请查看日志</div>';
    return;
  }
  renderMemoryList();
}

function renderMemoryList() {
  const box = document.getElementById('agent-memory-list');
  if (!box) return;
  box.innerHTML = '';
  if (!memoryCache.length) {
    const empty = document.createElement('div');
    empty.className = 'agent-memory-empty';
    empty.textContent = '还没有记忆。让 AI「记住…」之后，会显示在这里。';
    box.appendChild(empty);
    return;
  }
  // 用 DOM 拼装（而非 innerHTML 模板）——记忆正文是模型写的，可能含 < > 等字符
  for (const m of memoryCache) {
    const row = document.createElement('div');
    row.className = 'agent-memory-item';

    const body = document.createElement('div');
    body.className = 'agent-memory-body';

    const text = document.createElement('div');
    text.className = 'agent-memory-text';
    text.textContent = m.text;
    body.appendChild(text);

    const meta = document.createElement('div');
    meta.className = 'agent-memory-meta';
    const kind = document.createElement('span');
    kind.className = 'agent-memory-tag kind';
    kind.textContent = MEMORY_KIND_LABEL[m.kind] || '备注';
    meta.appendChild(kind);
    if (m.pinned) {
      const pin = document.createElement('span');
      pin.className = 'agent-memory-tag pinned';
      pin.textContent = '置顶';
      meta.appendChild(pin);
    }
    for (const t of (m.tags || [])) {
      const tag = document.createElement('span');
      tag.className = 'agent-memory-tag';
      tag.textContent = t;
      meta.appendChild(tag);
    }
    body.appendChild(meta);
    row.appendChild(body);

    const del = document.createElement('button');
    del.className = 'agent-memory-del';
    del.type = 'button';
    del.title = '删除这条记忆';
    del.textContent = '×';
    del.dataset.memoryId = m.id;
    row.appendChild(del);

    box.appendChild(row);
  }
}

async function deleteMemory(id) {
  try {
    await window.api.memory.remove(id);
    memoryCache = memoryCache.filter(m => m.id !== id);
    renderMemoryList();
    showToast('已删除记忆', '', 'success');
  } catch (e) {
    showToast('删除失败', String(e && e.message || e), 'error');
  }
}

async function clearMemories() {
  if (!memoryCache.length) { showToast('没有可清空的记忆', '', 'info'); return; }
  const ok = await window.api.confirm({
    type: 'warning',
    title: '清空 AI 记忆',
    message: '确定清空全部 ' + memoryCache.length + ' 条长期记忆吗？',
    detail: '清空后 AI 不再记得这些跨会话信息（本次对话上下文不受影响）。此操作不可恢复。'
  });
  if (!ok) return;
  await window.api.memory.clear();
  memoryCache = [];
  renderMemoryList();
  showToast('已清空全部记忆', '', 'success');
}

function setupMemoryPanel() {
  const box = document.getElementById('agent-memory-list');
  if (!box) return;
  // 删除：事件委托（列表是动态重建的）
  box.addEventListener('click', (e) => {
    const btn = e.target.closest('.agent-memory-del');
    if (btn && btn.dataset.memoryId) deleteMemory(btn.dataset.memoryId);
  });
  const refreshBtn = document.getElementById('btn-memory-refresh');
  if (refreshBtn) refreshBtn.addEventListener('click', () => loadMemories());
  const clearBtn = document.getElementById('btn-memory-clear');
  if (clearBtn) clearBtn.addEventListener('click', () => clearMemories());
}

function initRoleManagement() {
  // 恢复上次选择的角色
  try {
    const saved = localStorage.getItem('ai-lobster-current-role');
    if (saved) state.currentRoleId = saved;
  } catch(e) {}

  loadAgentRoles();
  loadAgentTools();
  setupMemoryPanel();

  // 角色选择按钮
  document.getElementById('btn-role-select')?.addEventListener('click', () => {
    const panel = document.getElementById('role-select-panel');
    panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
  });

  // 关闭角色面板
  document.getElementById('btn-role-panel-close')?.addEventListener('click', () => {
    document.getElementById('role-select-panel').style.display = 'none';
  });

  // 点击外部关闭角色面板
  document.addEventListener('click', (e) => {
    const panel = document.getElementById('role-select-panel');
    const btn = document.getElementById('btn-role-select');
    if (panel && panel.style.display !== 'none' && !panel.contains(e.target) && !btn.contains(e.target)) {
      panel.style.display = 'none';
    }
  });

  // 管理角色按钮
  document.getElementById('btn-manage-roles')?.addEventListener('click', () => {
    document.getElementById('role-select-panel').style.display = 'none';
    openRoleEditModal(null);
  });

  // 角色编辑弹窗
  document.getElementById('role-edit-cancel')?.addEventListener('click', closeRoleEditModal);
  document.getElementById('role-edit-save')?.addEventListener('click', saveRoleFromModal);
}


// ==================== 模型图标显示辅助 ====================
function updateProviderIconDisplay() {
  const provider = state.cloudProviders.find(p => p.id === state.activeProviderId);
  const hasIcon = !!(provider && window.ModelIcons);
  const iconId = hasIcon ? window.ModelIcons.detectProviderIcon(provider) : 'default';

  // 对话页面图标：没有选中模型时隐藏占位，避免空方块
  const chatIcon = document.getElementById('chat-provider-icon');
  if (chatIcon) {
    if (!provider) {
      chatIcon.style.display = 'none';
      chatIcon.innerHTML = '';
    } else {
      chatIcon.style.display = 'inline-flex';
      if (window.ModelIcons) {
        chatIcon.innerHTML = window.ModelIcons.renderIconHtml(iconId, '', '20px');
        window.ModelIcons.updateIconsInContainer(chatIcon);
      }
    }
  }

  // 配置页面图标
  const configIcon = document.getElementById('active-provider-icon');
  if (configIcon) {
    if (!provider) {
      configIcon.style.display = 'none';
      configIcon.innerHTML = '';
    } else {
      configIcon.style.display = 'inline-flex';
      if (window.ModelIcons) {
        configIcon.innerHTML = window.ModelIcons.renderIconHtml(iconId, '', '20px');
        window.ModelIcons.updateIconsInContainer(configIcon);
      }
    }
  }
}

// 选择器变化时更新图标
document.addEventListener('change', (e) => {
  if (e.target.id === 'chat-provider' || e.target.id === 'active-provider') {
    setTimeout(updateProviderIconDisplay, 50);
  }
});
