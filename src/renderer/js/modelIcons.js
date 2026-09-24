/**
 * LobeHub 模型图标集成模块
 * 自动识别 AI 提供商/模型名称，匹配对应的矢量图标
 * 图标来源：https://lobehub.com/zh/icons
 * CDN：阿里云 npmmirror（国内访问快）
 */

(function () {
  'use strict';

  // LobeHub 图标 CDN 基础地址（阿里云，国内优先）
  const CDN_BASE = 'https://registry.npmmirror.com/@lobehub/icons-static-svg/latest/files/icons';
  // 备用 CDN
  const CDN_FALLBACK = 'https://unpkg.com/@lobehub/icons-static-svg@latest/icons';

  // 图标 SVG 缓存（内存）
  const svgCache = {};
  // 正在加载中的 Promise
  const loadingPromises = {};

  /**
   * 常见提供商/模型关键词到 LobeHub 图标的映射
   * key: 匹配关键词（小写），value: LobeHub 图标 ID（小写）
   */
  const ICON_MAPPINGS = [
    // ===== 国际主流厂商 =====
    // OpenAI（匹配优先级最高，避免被其他规则误匹配）
    { keywords: ['openai', 'chatgpt', 'gpt-', 'gpt ', 'o1-', 'o3-', 'api.openai.com', 'openai.azure.com'], icon: 'openai' },
    // Anthropic / Claude
    { keywords: ['anthropic', 'claude-', 'claude ', 'claude.ai', 'api.anthropic.com'], icon: 'anthropic' },
    // Google / Gemini
    { keywords: ['google', 'gemini-', 'gemini ', 'gemma-', 'gemma ', 'bard', 'generativelanguage.googleapis.com'], icon: 'google' },
    // Meta / Llama（注意：llama 系列归 meta，ollama 单独匹配）
    { keywords: ['meta-llama', 'meta llama', 'llama-3', 'llama-2', 'llama-1', 'llama3:', 'llama2:', 'meta.ai'], icon: 'meta' },
    // Mistral
    { keywords: ['mistral', 'mixtral', 'mistral.ai'], icon: 'mistral' },
    // Groq
    { keywords: ['groq', 'api.groq.com'], icon: 'groq' },
    // Cohere
    { keywords: ['cohere', 'command-r', 'command-', 'cohere.ai'], icon: 'cohere' },
    // Perplexity
    { keywords: ['perplexity', 'pplx-', 'sonar-', 'perplexity.ai'], icon: 'perplexity' },
    // AWS / Bedrock
    { keywords: ['aws', 'bedrock', 'amazon', 'amazonaws.com'], icon: 'aws' },
    // Microsoft / Azure
    { keywords: ['microsoft', 'azure', 'azure.com', 'azure-openai'], icon: 'microsoft' },
    // GitHub
    { keywords: ['github', 'copilot', 'github.com'], icon: 'github' },
    // HuggingFace
    { keywords: ['huggingface', 'hf.co', 'huggingface.co', 'hugging face'], icon: 'huggingface' },
    // OpenRouter
    { keywords: ['openrouter', 'openrouter.ai'], icon: 'openrouter' },

    // ===== 国内厂商 =====
    // DeepSeek
    { keywords: ['deepseek', 'api.deepseek.com', 'deepseek.com'], icon: 'deepseek' },
    // 智谱 AI / GLM
    { keywords: ['zhipu', '智谱', '智谱ai', '智谱清言', 'glm-', 'glm ', 'chatglm', 'bigmodel', 'bigmodel.cn', 'open.bigmodel', '清言'], icon: 'zhipu' },
    // 阿里云 / 通义千问 / 百炼（统一一个条目）
    { keywords: ['aliyun', 'alibaba', 'alibabacloud', 'alibaba cloud', '阿里云', '阿里', 'qwen-', 'qwen ', 'tongyi', '通义', '千问', 'dashscope', 'bailian', '百炼', 'aliyuncs.com', 'dashscope.aliyuncs.com'], icon: 'alibabacloud' },
    // 腾讯云 / 混元
    { keywords: ['tencent', '腾讯', '腾讯云', 'hunyuan', '混元', 'tokenhub', 'tencentmaas', 'tencent-cloud', 'qq.com', 'tencent.com'], icon: 'tencent' },
    // 百度 / 文心一言 / 千帆
    { keywords: ['baidu', '百度', 'wenxin', 'ernie-', 'ernie ', 'qianfan', '千帆', '文心', '文心一言', 'baidu.com', 'baidubce.com'], icon: 'baidu' },
    // 月之暗面 / Kimi
    { keywords: ['moonshot', '月之暗面', 'kimi', 'kimi ', 'moonshot.cn', 'api.moonshot', 'kimi.moonshot'], icon: 'moonshot' },
    // 字节跳动 / 豆包 / 火山引擎
    { keywords: ['bytedance', '字节', '字节跳动', 'doubao', '豆包', 'volcengine', '火山引擎', 'volces.com', 'ark.cn-beijing', 'bytedance.com'], icon: 'bytedance' },
    // MiniMax
    { keywords: ['minimax', 'abab-', 'abab ', 'mini-max', 'minimax.io', '海螺AI'], icon: 'minimax' },
    // 阶跃星辰 / StepFun
    { keywords: ['stepfun', 'step-', 'step ', '阶跃星辰', 'stepfun.com'], icon: 'stepfun' },
    // 零一万物 / Yi（LobeHub 无独立图标，用 minimax 替代）
    { keywords: ['lingyi', '01.ai', '零一万物', 'yi-34b', 'yi-6b', 'yi-large', 'yi-medium'], icon: 'minimax' },

    // ===== 本地 / 推理框架 =====
    // Ollama（必须在 meta 之后，避免 llama 误匹配；用更具体的关键词）
    { keywords: ['ollama', 'localhost:11434', '127.0.0.1:11434', '0.0.0.0:11434', 'ollama.com', 'ollama run'], icon: 'ollama' },

    // ===== 其他（LobeHub 无独立图标，用 default） =====
    { keywords: ['sensetime', '商汤', 'sensechat', 'senseauto'], icon: 'default' },
    { keywords: ['xfyun', 'iflytek', '讯飞', 'spark-', 'spark ', 'xinghuo', '星火'], icon: 'default' },
    { keywords: ['360', 'zhinao', '智脑', 'so.com', '360.cn'], icon: 'default' },
    { keywords: ['siliconflow', '硅基流动', 'api.siliconflow.cn'], icon: 'default' },
    { keywords: ['replicate', 'replicate.com'], icon: 'default' },
    { keywords: ['together', 'together.ai', 'together.ai'], icon: 'default' },
    { keywords: ['fireworks', 'fireworks.ai', 'fireworksai'], icon: 'default' },
    { keywords: ['novita', 'novita.ai'], icon: 'default' },
  ];

  // 模型名到图标的映射（用于根据具体模型名识别）
  const MODEL_ICON_MAPPINGS = [
    // OpenAI 模型
    { keywords: ['gpt-4', 'gpt-3.5', 'gpt-4o', 'gpt-4t', 'o1-', 'o3-', 'o1 ', 'o3 '], icon: 'openai' },
    // Anthropic 模型
    { keywords: ['claude-3', 'claude-4', 'claude-opus', 'claude-sonnet', 'claude-haiku'], icon: 'anthropic' },
    // Google 模型
    { keywords: ['gemini-', 'gemma-', 'gemma2'], icon: 'google' },
    // DeepSeek 模型
    { keywords: ['deepseek-', 'deepseek-coder', 'deepseek-chat'], icon: 'deepseek' },
    // 智谱模型
    { keywords: ['glm-4', 'glm-3', 'chatglm-', 'glm-4v'], icon: 'zhipu' },
    // 阿里模型
    { keywords: ['qwen-', 'qwen2', 'qwen3', 'tongyi-', 'qwen-max', 'qwen-plus', 'qwen-turbo'], icon: 'alibabacloud' },
    // 腾讯模型
    { keywords: ['hunyuan-', 'hunyuan ', 'hy-', 'hy '], icon: 'tencent' },
    // 百度模型
    { keywords: ['ernie-', 'ernie-4', 'ernie-3', 'ernie-bot'], icon: 'baidu' },
    // 月之暗面模型
    { keywords: ['moonshot-', 'kimi-', 'moonshot-v1'], icon: 'moonshot' },
    // 字节模型
    { keywords: ['doubao-', 'doubao ', 'doubao-pro', 'doubao-lite'], icon: 'bytedance' },
    // Meta 模型（具体版本号）
    { keywords: ['llama-3', 'llama-2', 'llama-1', 'meta-llama'], icon: 'meta' },
    // Mistral 模型
    { keywords: ['mistral-', 'mixtral-', 'mistral-large', 'mistral-small'], icon: 'mistral' },
    // MiniMax 模型
    { keywords: ['abab-', 'abab ', 'minimax-'], icon: 'minimax' },
    // 阶跃模型
    { keywords: ['step-', 'step-1', 'step-2'], icon: 'stepfun' },
    // 零一万物模型
    { keywords: ['yi-34b', 'yi-6b', 'yi-large', 'yi-medium', 'yi-lightning'], icon: 'minimax' },
  ];

  /**
   * 根据文本自动识别图标 ID
   * @param {string} text - 提供商名称、URL 或模型名
   * @returns {string|null} 图标 ID 或 null
   */
  function detectIconId(text) {
    if (!text) return null;
    const lower = String(text).toLowerCase();

    // 先匹配提供商映射
    for (const mapping of ICON_MAPPINGS) {
      for (const keyword of mapping.keywords) {
        if (lower.includes(keyword.toLowerCase())) {
          return mapping.icon;
        }
      }
    }

    // 再匹配模型名映射
    for (const mapping of MODEL_ICON_MAPPINGS) {
      for (const keyword of mapping.keywords) {
        if (lower.includes(keyword.toLowerCase())) {
          return mapping.icon;
        }
      }
    }

    return null;
  }

  /**
   * 根据提供商信息综合识别图标
   * @param {Object} provider - 提供商对象 { name, type, apiUrl, model }
   * @returns {string} 图标 ID
   */
  function detectProviderIcon(provider) {
    if (!provider) return 'default';

    // 按优先级匹配：name > type > apiUrl > model
    const candidates = [
      provider.name,
      provider.type,
      provider.apiUrl,
      provider.model,
    ];

    for (const text of candidates) {
      const iconId = detectIconId(text);
      if (iconId) return iconId;
    }

    return 'default';
  }

  /**
   * 生成图标 CDN URL
   * @param {string} iconId - 图标 ID
   * @param {boolean} useFallback - 是否使用备用 CDN
   * @returns {string} 图标 URL
   */
  function getIconUrl(iconId, useFallback = false) {
    const base = useFallback ? CDN_FALLBACK : CDN_BASE;
    return `${base}/${iconId}.svg`;
  }

  /**
   * 加载图标 SVG 内容（带缓存）
   * @param {string} iconId - 图标 ID
   * @returns {Promise<string>} SVG 字符串
   */
  async function loadIconSvg(iconId) {
    if (!iconId || iconId === 'default') return getDefaultIconSvg();
    if (svgCache[iconId]) return svgCache[iconId];
    if (loadingPromises[iconId]) return loadingPromises[iconId];

    loadingPromises[iconId] = (async () => {
      try {
        // 优先阿里云 CDN
        let url = getIconUrl(iconId, false);
        let response = await fetch(url);
        if (!response.ok) {
          // 失败用备用 CDN
          url = getIconUrl(iconId, true);
          response = await fetch(url);
        }
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        let svg = await response.text();
        // 移除 SVG 中的 <title> 元素，避免鼠标悬停时显示不必要的 tooltip
        svg = svg.replace(/<title[^>]*>[\s\S]*?<\/title>/gi, '');
        svgCache[iconId] = svg;
        return svg;
      } catch (e) {
        console.warn(`[ModelIcons] 加载图标失败: ${iconId}`, e.message);
        svgCache[iconId] = getDefaultIconSvg();
        return svgCache[iconId];
      } finally {
        delete loadingPromises[iconId];
      }
    })();

    return loadingPromises[iconId];
  }

  /**
   * 默认图标 SVG（当没有匹配到图标时使用）
   */
  function getDefaultIconSvg() {
    return `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" width="100%" height="100%">
      <circle cx="12" cy="12" r="10" fill="currentColor" opacity="0.15"/>
      <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z" fill="currentColor"/>
    </svg>`;
  }

  /**
   * 渲染图标为 HTML 字符串（异步加载，先显示默认图标）
   * @param {string} iconId - 图标 ID
   * @param {string} className - CSS 类名
   * @param {string} size - 尺寸
   * @returns {string} HTML 字符串
   */
  function renderIconHtml(iconId, className = 'model-icon', size = '24px') {
    const safeId = iconId || 'default';
    return `<span class="${className}" data-icon-id="${safeId}" style="width:${size};height:${size};display:inline-flex;align-items:center;justify-content:center;flex-shrink:0;color:var(--text-secondary);">${getDefaultIconSvg()}</span>`;
  }

  /**
   * 异步更新页面上所有模型图标（加载真实 SVG）
   * @param {HTMLElement} container - 容器元素
   */
  async function updateIconsInContainer(container) {
    if (!container) container = document;
    const iconEls = container.querySelectorAll('[data-icon-id]');
    for (const el of iconEls) {
      const iconId = el.dataset.iconId;
      if (!iconId || iconId === 'default' || el.dataset.loaded === '1') continue;
      try {
        const svg = await loadIconSvg(iconId);
        el.innerHTML = svg;
        el.dataset.loaded = '1';
        // 移除默认颜色，让 SVG 使用自身颜色
        const svgEl = el.querySelector('svg');
        if (svgEl) {
          svgEl.style.width = '100%';
          svgEl.style.height = '100%';
        }
      } catch (e) {
        // 保持默认图标
      }
    }
  }

  // 暴露到全局
  window.ModelIcons = {
    detectIconId,
    detectProviderIcon,
    getIconUrl,
    loadIconSvg,
    renderIconHtml,
    updateIconsInContainer,
    getDefaultIconSvg,
    ICON_MAPPINGS,
  };

  console.log('[ModelIcons] LobeHub 模型图标模块已加载，支持 ' + ICON_MAPPINGS.length + ' 个提供商识别');
})();
