const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const http = require('http');
const { URL } = require('url');
// 工具调用恢复相关纯函数（无 electron 依赖，可独立单测）
const { extractToolCallFromText, getLastUserMessage, normalizeAgentMessages, createInlineThinkSplitter } = require('./agentToolUtils');
// 长期记忆（memory_save / memory_search / memory_list / memory_delete 的存储层）
const MemoryStore = require('./memoryStore');
// 待办事项（todo_write / todo_update / todo_read 的存储层，按会话隔离）
const TodoStore = require('./todoStore');
// 本地 AI 模型推理引擎适配（非 Ollama：llama.cpp / LM Studio / vLLM 等 OpenAI 兼容服务）
const LocalAiEngine = require('./localAiEngine');
const ToolAutoInstall = require('./toolAutoInstall');
// UI 自验证（capture_window / verify_ui 的截图与布局自检实现）
const UiVerify = require('./uiVerify');


// 将 API 错误响应简化为用户可读的简短提示，避免展示原始 JSON
function simplifyApiError(statusCode, rawData) {
  const code = parseInt(statusCode, 10);
  let detail = '';
  try {
    const parsed = JSON.parse(rawData);
    const e = parsed.error || parsed;
    detail = (e && (e.message || e.message_zh || e.code)) || parsed.message || '';
    if (typeof detail !== 'string') detail = '';
  } catch (_) { detail = (rawData || '').toString(); }
  // 去掉详情中的 URL、request_id 等技术信息，只保留核心语义
  detail = detail.replace(/https?:\/\/\S+/g, '').replace(/request[_-]?id["':\s]+[a-f0-9-]+/gi, '').trim();
  if (detail.length > 80) detail = detail.substring(0, 80) + '...';
  const map = {
    401: 'API 密钥无效，请检查提供商的 API Key 配置',
    403: '没有访问权限，请检查账户状态或套餐配额',
    404: '请求地址不存在，请检查 API 地址是否正确',
    429: '请求过于频繁或额度已用完，请稍后再试',
    500: '服务器内部错误，请稍后再试',
    502: '服务暂时不可用，请稍后再试',
    503: '服务暂时不可用，请稍后再试',
    504: '服务响应超时，请稍后再试',
  };
  let msg = map[code] || ('请求失败（' + code + '）');
  if (detail && !map[code]) msg += '：' + detail;
  return msg;
}

// 本地模型显存释放：回答结束后空闲 5 分钟自动停止 llama-server，释放 GPU/内存
let localUnloadTimer = null;
let localRequestInFlight = false; // 请求进行中不允许卸载
const LOCAL_UNLOAD_DELAY_MS = 5 * 60 * 1000; // 5分钟无新请求才卸载
function scheduleLocalModelUnload() {
  if (localUnloadTimer) clearTimeout(localUnloadTimer);
  localUnloadTimer = setTimeout(() => {
    localUnloadTimer = null;
    if (localRequestInFlight) { scheduleLocalModelUnload(); return; }
    try {
      const r = LocalAiEngine.stop();
      console.log('[LocalAI] 空闲超时，释放本地模型显存:', r.stopped ? '已停止' : '无托管进程');
    } catch (e) { console.warn('[LocalAI] 释放显存失败:', e.message); }
  }, LOCAL_UNLOAD_DELAY_MS);
}
function cancelLocalModelUnload() {
  if (localUnloadTimer) { clearTimeout(localUnloadTimer); localUnloadTimer = null; }
}
let aiConfig = null;
let toolInstallDir = null;
let statusCache = null;

// 工具调用授权确认
let pendingToolConfirm = null; // { resolve, tool, args }
function requestToolConfirm(tool, args, emitFn) {
  return new Promise((resolve) => {
    pendingToolConfirm = { resolve, tool, args };
    emitFn('agent-tool-confirm', { tool, args });
    // 30秒超时自动拒绝
    setTimeout(() => {
      if (pendingToolConfirm) {
        const p = pendingToolConfirm;
        pendingToolConfirm = null;
        p.resolve({ allowed: false, reason: '确认超时（30秒）' });
      }
    }, 30000);
  });
}
function resolveToolConfirm(allowed) {
  if (pendingToolConfirm) {
    const p = pendingToolConfirm;
    pendingToolConfirm = null;
    p.resolve({ allowed: !!allowed });
  }
}
// 有操作风险的工具（需要在设置中显式启用，且执行前需要确认）
// 无风险工具（只读/安全）默认启用，不需要用户确认，直接执行
const RISKY_TOOLS = new Set([
  'run_shell',
  'write_file',
  'move_file',
  'copy_file',
  'create_directory',
  'download_file',
  'http_request',
  'open_url'
]);
const TOOLS_REQUIRE_CONFIRM = RISKY_TOOLS;

// 新增的只读/低风险工具：对**所有角色**默认放开（含用户早先保存的自定义角色）。
// memory_* 只动本应用自己的 memory.json，capture/verify 只读画面与布局，都不碰用户文件。
const TOOLS_ALWAYS_ALLOWED = [
  'memory_save', 'memory_search', 'memory_list', 'memory_delete',
  'capture_window', 'verify_ui', 'analyze_screenshot',
  'todo_write', 'todo_update', 'todo_read'
];

// 预设提供商模板
const PROVIDER_PRESETS = {
  ollama: {
    name: 'Ollama (本地)',
    type: 'ollama',
    apiUrl: 'http://localhost:11434',
    apiKey: '',
    model: 'llama3',
    description: 'Ollama 本地大模型服务，无需 API Key'
  },
  bailian: {
    name: '阿里云百炼 (DashScope)',
    type: 'dashscope',
    apiUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
    apiKey: '',
    model: 'qwen-plus',
    description: '阿里云百炼大模型平台，OpenAI 兼容模式'
  },
  openai: {
    name: 'OpenAI',
    type: 'openai',
    apiUrl: 'https://api.openai.com/v1/chat/completions',
    apiKey: '',
    model: 'gpt-4',
    description: 'OpenAI 官方 API'
  },
  deepseek: {
    name: 'DeepSeek',
    type: 'openai',
    apiUrl: 'https://api.deepseek.com/v1/chat/completions',
    apiKey: '',
    model: 'deepseek-chat',
    description: 'DeepSeek API（OpenAI 兼容）'
  },
  tencent: {
    name: '腾讯云混元',
    type: 'openai',
    apiUrl: 'https://api.hunyuan.cloud.tencent.com/v1/chat/completions',
    apiKey: '',
    model: 'hunyuan-pro',
    description: '腾讯云混元大模型（OpenAI 兼容）'
  },
  tencentmaas: {
    name: '腾讯云 TokenHub (MaaS)',
    type: 'openai',
    apiUrl: 'https://tokenhub.tencentmaas.com/v1/chat/completions',
    apiKey: '',
    model: 'hy3',
    description: '腾讯云 TokenHub MaaS 网关（OpenAI 兼容），需填写 TokenHub 的 API Key 与模型名；模型名以 TokenHub 控制台为准（如 hy3）'
  },
  zhipu: {
    name: '智谱 GLM',
    type: 'openai',
    apiUrl: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    apiKey: '',
    model: 'glm-4',
    description: '智谱 AI GLM 系列（OpenAI 兼容）'
  },
  baidu: {
    name: '百度千帆',
    type: 'openai',
    apiUrl: 'https://qianfan.baidubce.com/v2/chat/completions',
    apiKey: '',
    model: 'ernie-4.0-8k',
    description: '百度智能云千帆大模型（OpenAI 兼容）'
  },
  moonshot: {
    name: '月之暗面 Kimi',
    type: 'openai',
    apiUrl: 'https://api.moonshot.cn/v1/chat/completions',
    apiKey: '',
    model: 'moonshot-v1-8k',
    description: 'Kimi 大模型（OpenAI 兼容）'
  },
  anthropic: {
    name: 'Anthropic Claude',
    type: 'openai',
    apiUrl: 'https://api.anthropic.com/v1/chat/completions',
    apiKey: '',
    model: 'claude-3-5-sonnet-20241022',
    description: 'Anthropic Claude 系列（OpenAI 兼容）'
  },
  google: {
    name: 'Google Gemini',
    type: 'openai',
    apiUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    apiKey: '',
    model: 'gemini-1.5-pro',
    description: 'Google Gemini 系列（OpenAI 兼容）'
  },
  bytedance: {
    name: '字节豆包 (火山引擎)',
    type: 'openai',
    apiUrl: 'https://ark.cn-beijing.volces.com/api/v3/chat/completions',
    apiKey: '',
    model: 'doubao-pro-32k',
    description: '字节跳动火山引擎豆包大模型（OpenAI 兼容）'
  },
  minimax: {
    name: 'MiniMax',
    type: 'openai',
    apiUrl: 'https://api.minimax.chat/v1/text/chatcompletion_v2',
    apiKey: '',
    model: 'abab6.5s-chat',
    description: 'MiniMax 大模型（OpenAI 兼容）'
  },
  stepfun: {
    name: '阶跃星辰',
    type: 'openai',
    apiUrl: 'https://api.stepfun.com/v1/chat/completions',
    apiKey: '',
    model: 'step-1-8k',
    description: '阶跃星辰大模型（OpenAI 兼容）'
  }
};

function init(config) {
  aiConfig = config;
  statusCache = { initialized: true, timestamp: Date.now() };
}

function getStatus() {
  const localCount = aiConfig?.localModels?.length || 0;
  const cloudCount = aiConfig?.cloudProviders?.length || 0;

  // 若 activeProvider 未设置或已失效，自动解析到第一个已启用的提供商
  let activeProvider = aiConfig?.activeProvider || null;
  if (activeProvider) {
    const stillExists = aiConfig?.cloudProviders?.some(p => p.id === activeProvider && p.enabled);
    if (!stillExists) activeProvider = null;
  }
  if (!activeProvider && aiConfig?.cloudProviders) {
    const enabled = aiConfig.cloudProviders.find(p => p.enabled);
    if (enabled) activeProvider = enabled.id;
  }

  return {
    initialized: true,
    localModelsCount: localCount,
    cloudProvidersCount: cloudCount,
    activeProvider,
    temperature: aiConfig?.temperature || 0.7,
    maxTokens: aiConfig?.maxTokens || 2048,
    lastChecked: statusCache?.timestamp
  };
}

function getProviderPresets() {
  return PROVIDER_PRESETS;
}

// ==================== Ollama 支持 ====================

async function listOllamaModels(host = 'http://localhost:11434') {
  return new Promise((resolve) => {
    try {
      const url = new URL(host + '/api/tags');
      const client = url.protocol === 'https:' ? https : http;
      const req = client.get(url, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            const models = (parsed.models || []).map(m => ({
              name: m.name,
              size: m.size,
              sizeFormatted: formatModelSize(m.size || 0),
              modifiedAt: m.modified_at,
              digest: m.digest
            }));
            resolve({ success: true, models, connected: true });
          } catch (e) {
            resolve({ success: false, error: '解析响应失败: ' + e.message, connected: true });
          }
        });
      });
      req.on('error', (err) => {
        resolve({ success: false, error: '无法连接到 Ollama: ' + err.message, connected: false });
      });
      req.setTimeout(5000, () => {
        req.destroy();
        resolve({ success: false, error: '连接超时（5秒），请确认 Ollama 服务正在运行', connected: false });
      });
    } catch (e) {
      resolve({ success: false, error: e.message, connected: false });
    }
  });
}

async function testOllamaConnection(host = 'http://localhost:11434') {
  return new Promise((resolve) => {
    try {
      const url = new URL(host + '/api/tags');
      const client = url.protocol === 'https:' ? https : http;
      const req = client.get(url, (res) => {
        resolve({ success: res.statusCode === 200, connected: res.statusCode === 200 });
      });
      req.on('error', () => {
        resolve({ success: false, connected: false });
      });
      req.setTimeout(3000, () => {
        req.destroy();
        resolve({ success: false, connected: false });
      });
    } catch (e) {
      resolve({ success: false, connected: false });
    }
  });
}


/**
 * 检测 Python 环境（用于 HF → GGUF 转换）
 */

/**
 * 检测所有工具状态
 */
async function testMirrorConnectivity(urls) {
  return ToolAutoInstall.testMirrorConnectivity(urls || []);
}

async function checkTools() {
  const dir = toolInstallDir || path.join(os.homedir(), '.ai-lobster', 'tools');
  return ToolAutoInstall.checkTools(dir);
}

/**
 * 下载指定工具（需用户已确认并选择目录）
 * tool: 'llama-server' | 'convert-script'
 */
async function downloadTool(tool, installDir, onProgress) {
  if (!installDir) throw new Error('未指定安装目录');
  fs.mkdirSync(installDir, { recursive: true });
  toolInstallDir = installDir;

  ToolAutoInstall.setProgressCallback((p) => { if (onProgress) onProgress(p); });

  if (tool === 'llama-server') {
    return await ToolAutoInstall.downloadLlamaServer(installDir, onProgress);
  } else if (tool === 'convert-script') {
    const p = await ToolAutoInstall.downloadConvertScript(installDir, onProgress);
    return { path: p };
  } else {
    throw new Error('未知工具: ' + tool);
  }
}
function detectPythonEnv() {
  return ToolAutoInstall.detectPython();
}

/**
 * 将 HuggingFace 模型目录转换为 GGUF
 * 返回 { success, ggufPath } 或 { success: false, error }
 */
async function convertLocalModelToGguf(modelId, onProgress) {
  const model = (aiConfig?.localModels || []).find(m => m.id === modelId);
  if (!model) return { success: false, error: '模型不存在' };

  const detected = LocalAiEngine.detectModelFormat(model.path);
  if (detected.runnable) {
    return { success: false, error: '该模型已经是 GGUF 格式，无需转换' };
  }
  if (detected.format !== 'huggingface' && detected.format !== 'safetensors') {
    return { success: false, error: '仅支持 HuggingFace (safetensors) 格式转换为 GGUF' };
  }

  const py = await ToolAutoInstall.detectPython();
  if (!py.available) {
    return { success: false, error: '未检测到 Python 3，无法自动转换。请安装 Python 3.10+ 和 torch/transformers 后重试。' };
  }
  if (!py.hasDeps) {
    return { success: false, error: 'Python 已安装但缺少 torch/transformers。请运行: pip install torch transformers sentencepiece protobuf' };
  }

  // 输出路径：模型同目录下的 .gguf 文件
  const modelDir = model.isDirectory ? model.path : path.dirname(model.path);
  const baseName = model.name || path.basename(modelDir);
  const ggufPath = path.join(modelDir, baseName + '.gguf');

  try {
    ToolAutoInstall.setProgressCallback((p) => {
      if (onProgress) onProgress(p);
    });
    const scriptDir = toolInstallDir || path.join(os.homedir(), '.ai-lobster', 'tools');
    await ToolAutoInstall.convertHfToGguf(modelDir, ggufPath, py.command, scriptDir, onProgress);

    // 验证 GGUF 文件确实生成且非空
    if (!fs.existsSync(ggufPath) || fs.statSync(ggufPath).size === 0) {
      return { success: false, error: '转换完成但输出文件不存在或为空: ' + ggufPath };
    }
    const ggufSize = fs.statSync(ggufPath).size;

    // 转换成功后，更新模型条目指向新的 GGUF 文件（path 也更新，避免目录检测混淆）
    model.path = ggufPath;
    model.entryPath = ggufPath;
    model.format = 'gguf';
    model.runnable = true;
    model.isDirectory = false;
    model.modelType = 'single';
    model.fileCount = 1;
    model.size = ggufSize;
    model.sizeFormatted = formatModelSize(ggufSize);
    model.convertedFrom = detected.format;
    model.description = '已从 ' + detected.format + ' 自动转换为 GGUF（' + formatModelSize(ggufSize) + '）';
    saveAIConfig();

    return { success: true, ggufPath, model };
  } catch (e) {
    return { success: false, error: '转换失败: ' + e.message };
  }
}
// ==================== 本地模型（文件） ====================

function listLocalModels() {
  // 老版本导入的条目没有 runnable 字段 → 按格式回填，界面才能正确提示"能不能本地跑"
  return (aiConfig?.localModels || []).map(m => ({
    ...m,
    runnable: m.runnable !== undefined ? m.runnable : LocalAiEngine.isRunnableFormat(m.format)
  }));
}

function importLocalModel({ path: modelPath, name, description }) {
  try {
    if (!modelPath || !fs.existsSync(modelPath)) {
      return { success: false, error: '模型文件不存在' };
    }

    const stat = fs.statSync(modelPath);
    const isDir = stat.isDirectory();

    // 单文件才校验扩展名；目录用 detectModelFormat 综合判断
    if (!isDir) {
      const ext = path.extname(modelPath).toLowerCase();
      const validExtensions = ['.gguf', '.ggml', '.bin', '.safetensors', '.onnx'];
      if (!validExtensions.includes(ext)) {
        return { success: false, error: '不支持的模型格式: ' + ext };
      }
    }

    // 统一检测格式（单文件 / 分片 GGUF / HuggingFace 目录 / 嵌套目录）
    const detected = LocalAiEngine.detectModelFormat(modelPath);
    const format = detected.format || (isDir ? 'directory' : path.extname(modelPath).toLowerCase().replace('.', ''));
    const runnable = detected.runnable !== undefined ? detected.runnable : LocalAiEngine.isRunnableFormat(format);
    const entryPath = detected.entryPath || modelPath;
    // 分片文件被识别为目录模型时，有效路径是目录而非文件
    const effectivePath = detected.isDirectory ? entryPath : modelPath;
    const effectiveIsDir = detected.isDirectory || isDir;


    // 计算总大小（目录递归统计）
    let totalSize = 0;
    if (effectiveIsDir) {
      const walk = (d) => {
        try {
          const entries = fs.readdirSync(d, { withFileTypes: true });
          for (const e of entries) {
            const fp = path.join(d, e.name);
            if (e.isFile()) { try { totalSize += fs.statSync(fp).size; } catch (_) {} }
            else if (e.isDirectory()) walk(fp);
          }
        } catch (_) {}
      };
      walk(effectivePath);
    } else {
      totalSize = stat.size;
    }

    if (!aiConfig.localModels) aiConfig.localModels = [];

    // 同一个文件/目录重复导入只更新元信息，不产生重复条目
    const resolved = path.resolve(effectivePath);
    const dup = aiConfig.localModels.find(m => path.resolve(m.path) === resolved);

    if (dup) {
      Object.assign(dup, { path: effectivePath, size: totalSize, sizeFormatted: formatModelSize(totalSize), runnable, format, entryPath, fileCount: detected.fileCount || 1, modelType: detected.modelType || 'single', isDirectory: !!detected.isDirectory });
      if (name) dup.name = name;
      if (detected.hint) dup.description = detected.hint;
      saveAIConfig();
      return {
        success: true,
        updated: true,
        data: dup,
        message: runnable ? ('该模型已在列表中，已更新信息' + (detected.hint ? '（' + detected.hint + '）' : '')) : '该模型已在列表中，但当前格式无法本地加载'
      };
    }

    const modelName = name || (effectiveIsDir ? path.basename(effectivePath) : path.basename(modelPath, path.extname(modelPath)));
    const modelInfo = {
      id: crypto.randomUUID(),
      name: modelName,
      path: effectivePath,
      entryPath: entryPath,
      size: totalSize,
      sizeFormatted: formatModelSize(totalSize),
      format,
      runnable,
      fileCount: detected.fileCount || 1,
      modelType: detected.modelType || 'single',
      isDirectory: !!detected.isDirectory,
      description: description || (detected.hint || ''),
      importedAt: new Date().toISOString()
    };

    aiConfig.localModels.push(modelInfo);
    saveAIConfig();

    return {
      success: true,
      data: modelInfo,
      ...(runnable ? {} : {
        warning: detected.hint || (format.toUpperCase() + ' 是训练/通用格式，本机没有能直接加载它的本地运行时。要本地跑请先转成 GGUF，或改用 Ollama。')
      })
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
}
/**
 * 让某个本地模型真正可用：把推理服务拉起来（或复用已在跑的），
 * 再注册成一个 OpenAI 兼容 provider 并设为当前模型。
 * 这是「导入后无法正常使用」的核心修复点。
 */
async function useLocalModel(modelId) {
  const model = (aiConfig?.localModels || []).find(m => m.id === modelId);
  if (!model) return { success: false, error: '模型不存在，请重新导入' };

  const engineCfg = aiConfig?.localEngine || {};
  const r = await LocalAiEngine.ensureRunning(model, { engineConfig: engineCfg });
  if (!r.success) return { success: false, error: r.error, hint: r.hint };

  if (!aiConfig.cloudProviders) aiConfig.cloudProviders = [];
  const apiUrl = String(r.base || ('http://127.0.0.1:' + r.port)).replace(/\/$/, '') + '/v1/chat/completions';

  let provider = aiConfig.cloudProviders.find(p => p.local && p.modelId === modelId);
  if (!provider) {
    provider = {
      id: 'local-' + crypto.randomUUID(),
      name: '本地模型 · ' + model.name,
      type: 'openai',
      apiKey: '',
      description: r.reused ? '本地推理（复用已在运行的服务）' : '本地推理（由 浮灵饰界 启动）',
      addedAt: new Date().toISOString(),
      enabled: true,
      local: true,
      modelId
    };
    aiConfig.cloudProviders.push(provider);
  }
  provider.apiUrl = apiUrl;
  provider.model = r.modelId || model.name;   // 用服务端真实上报的 model id，猜的名字会被上游拒绝
  provider.enabled = true;
  provider.lastStartedAt = new Date().toISOString();
  aiConfig.activeProvider = provider.id;
  saveAIConfig();

  return {
    success: true,
    provider,
    engine: { port: r.port, reused: r.reused, managed: r.managed, modelId: provider.model, loadMs: r.loadMs || 0 },
    message: (r.reused ? '已复用本机运行中的服务' : '本地服务已启动') + '，当前模型已切换为 ' + provider.model
  };
}

function stopLocalModel() {
  return LocalAiEngine.stop();
}

async function getLocalEngineStatus() {
  const st = LocalAiEngine.status();
  const providers = (aiConfig?.cloudProviders || []).filter(p => p.local);
  return { ...st, providers: providers.map(p => ({ id: p.id, name: p.name, apiUrl: p.apiUrl, model: p.model, modelId: p.modelId })) };
}

async function detectLocalEngine() {
  return LocalAiEngine.detect();
}

/**
 * 对话前确保本地服务在线：模型挂掉/重启后用户直接发消息也能自动拉起，
 * 而不是收到一句 ECONNREFUSED。只在 provider 标记为 local 时生效。
 */
async function ensureLocalProviderReady(provider, onStatus) {
  if (!provider || !provider.local || !provider.modelId) return { ok: true };
  const model = (aiConfig?.localModels || []).find(m => m.id === provider.modelId);
  if (!model) {
    return { ok: false, error: '本地模型已从列表移除，请在「AI模型配置」里重新选择模型' };
  }
  // 先看在用的端口是否还活着（最省事）
  const port = (() => {
    try { return Number(new URL(provider.apiUrl).port) || 0; } catch (e) { return 0; }
  })();
  if (port) {
    const p = await LocalAiEngine.probePort(port, 900);
    if (p.ready && p.openAiCompatible) return { ok: true, port };
  }
  console.log('[AI] 本地服务不可达，尝试自动拉起:', model.name);
  // 加载可能要几十秒：把进度透传给界面，别让用户对着"等待模型响应…"干等
  if (typeof onStatus === 'function') {
    try { onStatus('正在启动本地模型「' + model.name + '」（首次加载可能需要几十秒）…'); } catch (e) { /* 忽略 */ }
  }
  const r = await LocalAiEngine.ensureRunning(model, { engineConfig: aiConfig?.localEngine || {}, onStatus });
  if (!r.success) return { ok: false, error: r.error, hint: r.hint };
  const newUrl = String(r.base || ('http://127.0.0.1:' + r.port)).replace(/\/$/, '') + '/v1/chat/completions';
  if (provider.apiUrl !== newUrl) {
    provider.apiUrl = newUrl;
    saveAIConfig();
  }
  return { ok: true, port: r.port, restarted: true };
}

function deleteLocalModel(modelId) {
  try {
    if (!aiConfig.localModels) return { success: false, error: '模型不存在' };
    const index = aiConfig.localModels.findIndex(m => m.id === modelId);
    if (index === -1) return { success: false, error: '模型不存在' };

    aiConfig.localModels.splice(index, 1);
    saveAIConfig();
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// ==================== 云端提供商 ====================

function listCloudProviders() {
  return aiConfig?.cloudProviders || [];
}

function normalizeApiUrl(url) {
  if (!url) return url;
  let u = url.trim();
  if (u.startsWith('//')) u = 'https:' + u;
  if (!/^https?:\/\//i.test(u) && !u.startsWith('localhost') && !/^\d+\.\d+\.\d+\.\d+/.test(u)) {
    u = 'https://' + u;
  }
  return u;
}

function addCloudProvider({ name, apiUrl, apiKey, model, description, type = 'openai' }) {
  try {
    if (!name || !apiUrl) {
      return { success: false, error: '名称和API地址不能为空' };
    }
    apiUrl = normalizeApiUrl(apiUrl);

    const provider = {
      id: crypto.randomUUID(),
      name,
      type,
      apiUrl,
      apiKey: apiKey || '',
      model: model || 'gpt-4',
      description: description || '',
      addedAt: new Date().toISOString(),
      enabled: true
    };

    if (!aiConfig.cloudProviders) aiConfig.cloudProviders = [];
    aiConfig.cloudProviders.push(provider);
    saveAIConfig();

    return { success: true, data: provider };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

function addProviderByPreset(presetKey, overrides = {}) {
  const preset = PROVIDER_PRESETS[presetKey];
  if (!preset) {
    return { success: false, error: '未知的预设类型' };
  }
  return addCloudProvider({ ...preset, ...overrides });
}

function updateCloudProvider({ id, ...updates }) {
  try {
    if (!aiConfig.cloudProviders) return { success: false, error: '提供商不存在' };
    const index = aiConfig.cloudProviders.findIndex(p => p.id === id);
    if (index === -1) return { success: false, error: '提供商不存在' };

    if (updates.apiUrl) updates.apiUrl = normalizeApiUrl(updates.apiUrl);
    aiConfig.cloudProviders[index] = { ...aiConfig.cloudProviders[index], ...updates };
    saveAIConfig();
    return { success: true, data: aiConfig.cloudProviders[index] };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

function deleteCloudProvider(id) {
  try {
    if (!aiConfig.cloudProviders) return { success: false, error: '提供商不存在' };
    const index = aiConfig.cloudProviders.findIndex(p => p.id === id);
    if (index === -1) return { success: false, error: '提供商不存在' };

    aiConfig.cloudProviders.splice(index, 1);
    saveAIConfig();
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/** 对话入口统一用这个：本地 provider 未就绪就自动拉起，失败则返回可读错误（含操作建议） */
async function prepareLocalProvider(provider, onStatus) {
  const r = await ensureLocalProviderReady(provider, onStatus);
  if (r.ok) return null;
  return { success: false, error: r.error + (r.hint ? '\n' + r.hint : '') };
}

// ==================== 对话 ====================

async function chat({ messages, providerId, temperature, maxTokens, systemPrompt, silent, workdir }, broadcastFn) {
  const provider = findProvider(providerId);
  if (!provider) {
    return { success: false, error: '未找到AI提供商' };
  }
  cancelOllamaUnload();
  localRequestInFlight = true;
  const notReady = await prepareLocalProvider(provider);
    if (notReady) { localRequestInFlight = false; return notReady; }

  const temp = temperature ?? aiConfig?.temperature ?? 0.7;
  const tokens = maxTokens ?? aiConfig?.maxTokens ?? 2048;
  let systemPromptFinal = systemPrompt || aiConfig?.systemPrompt || '';
  if (workdir) {
    systemPromptFinal += '\n\n## 当前项目工作目录\n- 你当前的工作目录（项目根）是：' + workdir + '\n- 所有相对路径都基于此目录解析；执行命令时也默认在此目录下运行。\n- 除非用户明确要求操作其他位置，否则不要把文件写到该目录之外。';
  }

  const formattedMessages = [];
  if (systemPromptFinal) {
    formattedMessages.push({ role: 'system', content: systemPromptFinal });
  }
  // 前端历史里 role 是 'ai'，各家 API 只认 'assistant'：不归一化会直接被上游 400 拒绝
  formattedMessages.push(...normalizeAgentMessages(messages));

  try {
    const result = await callProviderAPI(provider, formattedMessages, temp, tokens);

    // silent（如动作编辑器的 AI 调试）：不把结果作为聊天消息广播到聊天窗口
    if (broadcastFn && result.success && !silent) {
      broadcastFn('ai:response', {
        type: 'complete',
        content: result.content,
        usage: result.data?.usage,
        providerId: provider.id
      });
      broadcastFn('ai:provider-sync', { activeProvider: provider.id });
    }

    return { ...result, providerId: provider.id };
  } catch (error) {
    return { success: false, error: error.message };
  } finally {
    // 确保请求被销毁，释放网络和GPU资源
    try { if (activeReq) { activeReq.destroy(); activeReq = null; } } catch(e) {}
    // 主动卸载 Ollama 模型，释放 GPU 显存
    if (provider && provider.type === 'ollama') unloadOllamaModel(provider);
    // 本地模型空闲超时后自动释放显存
    localRequestInFlight = false;
    if (provider && provider.local) scheduleLocalModelUnload();
  }
}

async function streamChat({ messages, providerId, temperature, maxTokens, systemPrompt, workdir }, broadcastFn) {
  chatCancelled = false;
  const provider = findProvider(providerId);
  if (!provider) {
    return { success: false, error: '未找到AI提供商' };
  }
  cancelLocalModelUnload();
  cancelOllamaUnload();
  localRequestInFlight = true;
  const notReady = await prepareLocalProvider(provider);
    if (notReady) { localRequestInFlight = false; return notReady; }

  const temp = temperature ?? aiConfig?.temperature ?? 0.7;
  const tokens = maxTokens ?? aiConfig?.maxTokens ?? 2048;
  let systemPromptFinal = systemPrompt || aiConfig?.systemPrompt || '';
  if (workdir) {
    systemPromptFinal += '\n\n## 当前项目工作目录\n- 你当前的工作目录（项目根）是：' + workdir + '\n- 所有相对路径都基于此目录解析；执行命令时也默认在此目录下运行。\n- 除非用户明确要求操作其他位置，否则不要把文件写到该目录之外。';
  }

  const formattedMessages = [];
  if (systemPromptFinal) {
    formattedMessages.push({ role: 'system', content: systemPromptFinal });
  }
  // 同 chat()：role 'ai' 必须归一化为 'assistant'，否则上游 400
  formattedMessages.push(...normalizeAgentMessages(messages));

  try {
    let streamReasoningStarted = false;
    let streamContentStarted = false;
    const result = await callProviderAPI(provider, formattedMessages, temp, tokens, true, (delta) => {
      if (chatCancelled) return;
      if (broadcastFn) {
        // 兼容旧格式：delta 可能是字符串或对象 { type, content }
        if (typeof delta === 'string') {
          broadcastFn('ai:response', {
            type: 'stream-chunk',
            content: delta
          });
        } else if (delta && delta.type === 'reasoning') {
          // 思考过程：通过 stream-chunk 发送，加标记区分（普通模式下也能看到）
          if (!streamReasoningStarted) {
            streamReasoningStarted = true;
            broadcastFn('ai:response', {
              type: 'stream-chunk',
              content: '\n▼ 思考过程\n'
            });
          }
          broadcastFn('ai:response', {
            type: 'stream-chunk',
            content: delta.content
          });
        } else if (delta && delta.type === 'content') {
          // 正式回答开始前，加分隔标记
          if (streamReasoningStarted && !streamContentStarted) {
            streamContentStarted = true;
            broadcastFn('ai:response', {
              type: 'stream-chunk',
              content: '\n▲ 思考结束\n\n'
            });
          }
          // 正式回答
          broadcastFn('ai:response', {
            type: 'stream-chunk',
            content: delta.content
          });
        }
      }
    });

    if (broadcastFn && result.success) {
      broadcastFn('ai:response', {
        type: 'stream-complete',
        fullContent: result.content,
        usage: result.data?.usage
      });
      broadcastFn('ai:provider-sync', { activeProvider: provider.id });
    }

    // 主动卸载 Ollama 模型，释放 GPU 显存
    if (provider.type === 'ollama') unloadOllamaModel(provider);
    localRequestInFlight = false;
    if (provider.local) scheduleLocalModelUnload();
    return { ...result, providerId: provider.id };
  } catch (error) {
    if (provider.type === 'ollama') unloadOllamaModel(provider);
    localRequestInFlight = false;
    if (provider.local) scheduleLocalModelUnload();
    return { success: false, error: error.message };
  }
}

function findProvider(providerId) {
  if (!aiConfig?.cloudProviders) return null;
  if (providerId) {
    const p = aiConfig.cloudProviders.find(p => p.id === providerId && p.enabled);
    if (p) return p;
  }
  if (aiConfig.activeProvider) {
    const p = aiConfig.cloudProviders.find(p => p.id === aiConfig.activeProvider && p.enabled);
    if (p) return p;
  }
  // Fallback: use first enabled provider and sync activeProvider
  const fallback = aiConfig.cloudProviders.find(p => p.enabled);
  if (fallback && fallback.id !== aiConfig.activeProvider) {
    aiConfig.activeProvider = fallback.id;
    saveAIConfig();
  }
  return fallback;
}

// 统一调用入口，根据 type 分发
async function callProviderAPI(provider, messages, temperature, maxTokens, stream = false, onStreamChunk = null) {
  const type = provider.type || 'openai';
  // 发送前统一消毒：非字符串 content、半截工具参数、孤立代理项都会让上游直接 400
  const safeMessages = sanitizeOutgoingMessages(messages, type === 'ollama');
  if (type === 'ollama') {
    return callOllamaAPI(provider, safeMessages, temperature, maxTokens, stream, onStreamChunk);
  }
  return callOpenAICompatibleAPI(provider, safeMessages, temperature, maxTokens, stream, onStreamChunk);
}

// Ollama API（不同的请求格式和流式格式）
function callOllamaAPI(provider, messages, temperature, maxTokens, stream = false, onStreamChunk = null) {
  return new Promise((resolve) => {
    const baseUrl = provider.apiUrl.replace(/\/$/, '');
    const url = new URL(baseUrl + '/api/chat');
    const client = url.protocol === 'https:' ? https : http;

    const body = JSON.stringify({
      model: provider.model,
      messages,
      stream,
      keep_alive: 0,  // 响应完成后立即从GPU显存卸载模型，避免长时间占用导致卡顿
      options: {
        temperature,
        num_predict: maxTokens
      }
    });

    const options = {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname.replace(/\/$/, '') + (url.search || ''),
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    };

    const req = client.request(options, (res) => {
      activeReq = req;
      let data = '';
      let fullContent = '';

      if (stream) {
        // Ollama 流式：每行一个 JSON 对象 { message: { content }, done }
        let buffer = '';
        res.on('data', (chunk) => {
          buffer += chunk.toString();
          const lines = buffer.split('\n');
          buffer = lines.pop(); // 保留最后不完整的一行
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const parsed = JSON.parse(line);
              const delta = parsed.message?.content || '';
              if (delta) {
                fullContent += delta;
                if (onStreamChunk) onStreamChunk(delta);
              }
            } catch (e) {}
          }
        });

        res.on('end', () => {
          // 处理缓冲区中剩余内容
          if (buffer.trim()) {
            try {
              const parsed = JSON.parse(buffer);
              const delta = parsed.message?.content || '';
              if (delta) {
                fullContent += delta;
                if (onStreamChunk) onStreamChunk(delta);
              }
            } catch (e) {}
          }
          resolve({
            success: res.statusCode >= 200 && res.statusCode < 300,
            content: fullContent,
            data: {},
            statusCode: res.statusCode
          });
        });
      } else {
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          // 非 2xx：把错误体转成可读信息（Ollama 常见为纯文本或 JSON）
          if (res.statusCode < 200 || res.statusCode >= 300) {
            let errorMsg = data || ('HTTP ' + res.statusCode);
            try {
              const parsed = JSON.parse(data);
              errorMsg = (parsed.error && (parsed.error.message || parsed.error.code)) || parsed.error || parsed.message || data;
            } catch (_) { /* 保留原始文本 */ }
            if (typeof errorMsg !== 'string') errorMsg = JSON.stringify(errorMsg);
            resolve({
              success: false,
              error: 'Ollama 接口返回 ' + res.statusCode + (errorMsg ? '：' + errorMsg : ''),
              data,
              statusCode: res.statusCode
            });
            return;
          }
          try {
            const parsed = JSON.parse(data);
            const content = parsed.message?.content || '';
            resolve({ success: true, content, data: parsed, statusCode: res.statusCode });
          } catch (e) {
            resolve({ success: true, content: '', data, statusCode: res.statusCode });
          }
        });
      }
    });

    req.on('error', (err) => {
      resolve({ success: false, error: 'Ollama 连接失败: ' + err.message + '（请确认 Ollama 服务已启动）' });
    });

    req.setTimeout(120000, () => {
      req.destroy();
      resolve({ success: false, error: 'Ollama 请求超时' });
    });

    safeWriteRequest(req, body, (e) => resolve({ success: false, error: 'Ollama 请求发送失败: ' + e.message }));
  });
}

// OpenAI 兼容 API（支持 OpenAI、DashScope 百炼、DeepSeek 等）
function callOpenAICompatibleAPI(provider, messages, temperature, maxTokens, stream = false, onStreamChunk = null) {
  return new Promise((resolve) => {
    const apiUrl = normalizeApiUrl(provider.apiUrl);
    const url = new URL(apiUrl);
    const isHttps = url.protocol === 'https:';
    const client = isHttps ? https : http;

    const bodyObj = {
      model: provider.model,
      messages,
      temperature,
      stream
    };
    if (maxTokens) bodyObj.max_tokens = maxTokens;
    // 流式请求时要求返回 usage，否则 token 统计缺失
    if (stream && supportsStreamOptions(provider)) bodyObj.stream_options = { include_usage: true };
    // 本地模型（Qwen3 等思考模型）默认启用思考过程，llama-server 需 chat_template_kwargs.enable_thinking
    const thinkParams = thinkingParams(provider, true);
    if (Object.keys(thinkParams).length) Object.assign(bodyObj, thinkParams);
    const body = JSON.stringify(bodyObj);

    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body)
    };
    // Ollama 无需 Authorization 头
    if (provider.apiKey) {
      headers['Authorization'] = `Bearer ${provider.apiKey}`;
    }

    const options = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname.replace(/\/$/, '') + (url.search || ''),
      method: 'POST',
      headers
    };

    const req = client.request(options, (res) => {
      activeReq = req;
      let data = '';
      let fullContent = '';
      let isStream = stream && (res.headers['content-type']?.includes('text/event-stream'));
      let streamUsage = null;

      if (isStream) {
        res.on('data', (chunk) => {
          const lines = chunk.toString().split('\n').filter(l => l.trim());
          for (const line of lines) {
            if (line.startsWith('data: ')) {
              const jsonStr = line.slice(6);
              if (jsonStr === '[DONE]') continue;
              try {
                const parsed = JSON.parse(jsonStr);
                // 提取 usage 信息（通常在最后一条消息中）
                if (parsed.usage) {
                  streamUsage = parsed.usage;
                } else if (parsed.x_gigacontext?.token_usage) {
                  // 智谱等平台在 x_gigacontext 中返回
                  streamUsage = parsed.x_gigacontext.token_usage;
                }
                const delta = parsed.choices?.[0]?.delta || {};
                const contentDelta = delta.content || '';
                const reasoningDelta = delta.reasoning_content || '';
                if (contentDelta) {
                  fullContent += contentDelta;
                  if (onStreamChunk) onStreamChunk({ type: 'content', content: contentDelta });
                }
                if (reasoningDelta) {
                  if (onStreamChunk) onStreamChunk({ type: 'reasoning', content: reasoningDelta });
                }
              } catch (e) {}
            }
          }
        });

        res.on('end', () => {
          resolve({
            success: res.statusCode >= 200 && res.statusCode < 300,
            content: fullContent,
            data: streamUsage ? { usage: streamUsage } : {},
            statusCode: res.statusCode
          });
        });
      } else {
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          // 非 2xx：把服务端返回的错误体转成可读信息，避免"调用无效果且无原因"（如 tokenhub 401/400）
          if (res.statusCode < 200 || res.statusCode >= 300) {
            let err = simplifyApiError(res.statusCode, data);
            if (res.statusCode === 404) err += '（请检查 API 地址是否以 /chat/completions 结尾）';
            resolve({ success: false, error: err, statusCode: res.statusCode });
            return;
          }
          try {
            const parsed = JSON.parse(data);
            let content = parsed.choices?.[0]?.message?.content
              || parsed.output?.choices?.[0]?.message?.content
              || parsed.choices?.[0]?.delta?.content
              || parsed.output?.text
              || '';
            const reasoning = parsed.choices?.[0]?.message?.reasoning_content || '';
            if (reasoning) content = '▼ 思考过程\n' + reasoning + '\n▲ 思考结束\n\n' + content;
            if (!content && (parsed.error || parsed.code || parsed.message)) {
              const errMsg = parsed.error?.message || parsed.error || parsed.message || parsed.code || 'api error';
              resolve({ success: false, error: typeof errMsg === 'string' ? errMsg : JSON.stringify(errMsg), data: parsed, statusCode: res.statusCode });
              return;
            }
            if (!content) {
              const snippet = data.slice(0, 500);
              resolve({ success: false, error: 'empty response (HTTP ' + res.statusCode + '): ' + snippet, data: parsed, statusCode: res.statusCode });
              return;
            }
            resolve({ success: true, content, data: parsed, statusCode: res.statusCode });
          } catch (e) {
            resolve({ success: false, error: 'parse failed: ' + e.message + ', raw: ' + data.slice(0, 300), data, statusCode: res.statusCode });
          }
        });
      }
    });

    req.on('error', (err) => {
      resolve({ success: false, error: err.message });
    });

    req.setTimeout(120000, () => {
      req.destroy();
      resolve({ success: false, error: '请求超时' });
    });

    safeWriteRequest(req, body, (e) => resolve({ success: false, error: '请求发送失败: ' + e.message }));
  });
}

// ========== Agent 引擎：工具调用 + 思考过程 + 多轮执行 ==========

// 工具定义（OpenAI function calling 格式）
const AGENT_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'run_shell',
      description: '执行 Windows 命令行命令，返回输出结果。仅限只读/安全命令，禁止删除系统文件等危险操作。',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: '要执行的命令，如 dir、ipconfig、node -v 等' },
          timeout: { type: 'number', description: '超时时间（毫秒），默认 15000', default: 15000 }
        },
        required: ['command']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: '读取文本文件内容，返回文件文本。用于查看配置、代码、日志等。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件绝对路径' }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: '写入文本文件，覆盖已有内容。用于保存配置、生成脚本等。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件绝对路径' },
          content: { type: 'string', description: '要写入的文本内容' }
        },
        required: ['path', 'content']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_system_info',
      description: '获取当前系统信息（操作系统、CPU、内存、Node版本、应用版本等）。'
    }
  },
  {
    type: 'function',
    function: {
      name: 'pet_action',
      description: '触发桌面宠物执行指定动作或表情。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', description: '动作名称，如 shy、happy、sad 等' }
        },
        required: ['action']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: '使用搜索引擎搜索网络信息，返回搜索结果列表。用于查询最新资讯、技术文档、百科知识等需要外部信息的任务。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索关键词，如 "electron updater 教程"、"今天天气" 等' },
          max_results: { type: 'number', description: '返回结果数量，默认 8，最多 20', default: 8 }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'web_fetch',
      description: '抓取指定 URL 的网页内容，返回页面文本。用于读取具体网页、文档、博客文章等详细内容。',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '要抓取的网页 URL，必须以 http:// 或 https:// 开头' },
          max_length: { type: 'number', description: '返回内容最大长度，默认 8000 字符', default: 8000 }
        },
        required: ['url']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'http_request',
      description: '发送 HTTP 请求（GET/POST/PUT/DELETE），返回响应状态和内容。用于调用 API、测试接口等。',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '请求 URL' },
          method: { type: 'string', description: '请求方法，GET/POST/PUT/DELETE，默认 GET', default: 'GET' },
          headers: { type: 'object', description: '请求头，如 {"Content-Type": "application/json"}' },
          body: { type: 'string', description: '请求体内容' },
          timeout: { type: 'number', description: '超时时间（毫秒），默认 15000', default: 15000 }
        },
        required: ['url']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'file_search',
      description: '在指定目录中搜索文件，支持按名称、扩展名过滤。用于查找项目文件、配置文件、日志等。',
      parameters: {
        type: 'object',
        properties: {
          directory: { type: 'string', description: '搜索的根目录绝对路径' },
          pattern: { type: 'string', description: '文件名匹配模式，支持通配符 *，如 "*.js"、"config*"' },
          max_results: { type: 'number', description: '最大返回结果数，默认 50', default: 50 }
        },
        required: ['directory', 'pattern']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'directory_list',
      description: '列出指定目录下的文件和子目录，返回名称、大小、修改时间等信息。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '目录绝对路径' },
          show_hidden: { type: 'boolean', description: '是否显示隐藏文件，默认 false', default: false }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'copy_file',
      description: '复制文件或目录到目标位置。',
      parameters: {
        type: 'object',
        properties: {
          source: { type: 'string', description: '源文件或目录绝对路径' },
          destination: { type: 'string', description: '目标文件或目录绝对路径' },
          overwrite: { type: 'boolean', description: '是否覆盖已存在文件，默认 false', default: false }
        },
        required: ['source', 'destination']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'move_file',
      description: '移动或重命名文件/目录。',
      parameters: {
        type: 'object',
        properties: {
          source: { type: 'string', description: '源文件或目录绝对路径' },
          destination: { type: 'string', description: '目标文件或目录绝对路径' }
        },
        required: ['source', 'destination']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'create_directory',
      description: '创建目录，支持递归创建多级目录。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '要创建的目录绝对路径' }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'download_file',
      description: '从 URL 下载文件到本地指定路径。',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '文件下载 URL' },
          destination: { type: 'string', description: '保存的本地绝对路径' },
          timeout: { type: 'number', description: '超时时间（毫秒），默认 60000', default: 60000 }
        },
        required: ['url', 'destination']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_current_time',
      description: '获取当前日期和时间，返回格式化的时间字符串。'
    }
  },
  {
    type: 'function',
    function: {
      name: 'calculator',
      description: '执行数学计算，支持加减乘除、幂运算、括号等复杂表达式。如 "2+3*4"、"(10-5)/2"、"Math.sqrt(16)"。',
      parameters: {
        type: 'object',
        properties: {
          expression: { type: 'string', description: '数学表达式，如 "2+3*4"、"Math.PI * 10^2"' }
        },
        required: ['expression']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'check_url',
      description: '检查 URL 是否可访问，返回 HTTP 状态码和响应时间。用于验证链接有效性、测试网站可用性。',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '要检查的 URL' },
          timeout: { type: 'number', description: '超时时间（毫秒），默认 10000', default: 10000 }
        },
        required: ['url']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'open_url',
      description: '在默认浏览器中打开指定 URL。',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '要打开的网页 URL' }
        },
        required: ['url']
      }
    }
  },

  // ==================== 待办事项（需求整理 / 实现过程追踪） ====================
  {
    type: 'function',
    function: {
      name: 'todo_write',
      description: '【需求整理·先做这一步】把用户的需求整理成一份待办清单并整表替换（首次规划、需求变更都用它）。每条必须写清"做到什么算完成"(done_when)，把模糊说法翻译成可验证的目标；这样用户能一眼确认你要做什么、怎么算做完。',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '这次任务的一句话目标（便于用户确认），如"修复窄窗下工具栏按钮被裁"' },
          items: {
            type: 'array',
            description: '待办条目（3~7 条最佳，最多 12 条）。按执行顺序排列。',
            items: {
              type: 'object',
              properties: {
                text: { type: 'string', description: '要做的事，动词开头、具体可执行；禁止"优化一下""处理相关问题"这类空话' },
                status: { type: 'string', description: 'pending(待办) / in_progress(进行中，全局只能一条) / completed(已完成)', default: 'pending' },
                done_when: { type: 'string', description: '完成判据：怎么算做完了（可观测、可验证），如"900px 窗口下 4 个按钮都完整可见"' },
                note: { type: 'string', description: '补充说明或已完成的证据（如截图路径、验证结论）' },
                id: { type: 'string', description: '已有条目的 id（更新时带上，保持条目身份稳定）' }
              },
              required: ['text']
            }
          }
        },
        required: ['items']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'todo_update',
      description: '更新**单条**待办的状态/说明（日常推进进度用它，比整表重写省 token）。完成一条立刻标记，note 里写清结果或证据。传 status=in_progress 时其它进行中的会自动退回待办。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '待办 id（todo_write / todo_read 返回的 id）' },
          text: { type: 'string', description: '没有 id 时用原文定位' },
          status: { type: 'string', description: 'pending / in_progress / completed' },
          note: { type: 'string', description: '结果说明或证据（如"已改 style.css 的 .panel-actions，验证 0 溢出"）' },
          done_when: { type: 'string', description: '修正完成判据' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'todo_read',
      description: '读取当前会话的待办清单与进度。开始一轮工作前确认"上一轮做到哪了"，或不确定条目 id 时用它。',
      parameters: { type: 'object', properties: {} }
    }
  },

  // ==================== 长期记忆 ====================
  {
    type: 'function',
    function: {
      name: 'memory_save',
      description: '把「跨会话仍然成立」的信息写入长期记忆，之后每次对话都会自动带上。适合记：用户偏好与习惯、项目约定与硬规则、环境限制、踩过的坑与修复结论。不要记闲聊、一次性任务、或能直接从代码/文件里读到的内容。',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '要记住的内容，一句话讲清楚（不超过 500 字）' },
          tags: { type: 'array', items: { type: 'string' }, description: '检索标签，如 ["electron","UI","用户偏好"]' },
          kind: { type: 'string', description: '类型: fact(事实) / preference(偏好) / project(项目) / fix(修复经验) / note(备注)', default: 'note' },
          pinned: { type: 'boolean', description: '置顶后必定注入系统提示词（慎用，只给几条最关键的）', default: false },
          id: { type: 'string', description: '要覆盖的已有记忆 id（先用 memory_search 拿到），不传则新增' }
        },
        required: ['text']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'memory_search',
      description: '在长期记忆里按关键词检索，返回命中的记忆条目、id、标签与相关度。修改/删除记忆前先用它拿到 id。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '检索关键词，如 "electron 透明"、"用户偏好"' },
          limit: { type: 'number', description: '最多返回条数，默认 10', default: 10 }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'memory_list',
      description: '列出长期记忆（置顶优先、最近更新在前），可按标签或类型过滤。用于确认"我已经记了什么"。',
      parameters: {
        type: 'object',
        properties: {
          tag: { type: 'string', description: '按标签过滤' },
          kind: { type: 'string', description: '按类型过滤: fact / preference / project / fix / note' },
          limit: { type: 'number', description: '最多返回条数，默认 50', default: 50 }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'memory_delete',
      description: '删除长期记忆：给 id 删单条；给 query 则删掉关键词命中的若干条（如"忘掉关于 X 的记忆"）。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '要删除的记忆 id' },
          query: { type: 'string', description: '按关键词删除（与 id 二选一）' },
          limit: { type: 'number', description: '按关键词删除时的最大条数，默认 10', default: 10 }
        }
      }
    }
  },

  // ==================== 截图 / 界面自验证 ====================
  {
    type: 'function',
    function: {
      name: 'capture_window',
      description: '截取「需要验证的那个程序」的窗口画面并存成 PNG，返回文件路径。默认抓本应用自己的窗口（改完本程序界面后用这个）；被验证的程序不是本应用时，用 title 指定它的窗口标题关键字。',
      parameters: {
        type: 'object',
        properties: {
          which: { type: 'string', description: '抓本应用哪个窗口: main(主窗口, 默认) / pet(桌宠) / editor / debugLog，也可传窗口标题片段' },
          title: { type: 'string', description: '抓其它程序的窗口：窗口标题关键字（传了 title 就忽略 which）' },
          index: { type: 'number', description: '标题匹配到多个窗口时取第几个，默认 0' },
          save_path: { type: 'string', description: '保存路径（绝对路径或文件名），默认存到 数据目录/screenshots/ 下自动命名' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'verify_ui',
      description: '【修复自验证·必用】量当前界面的真实布局，判断改动到底有没有生效，并返回结论 pass/warn/fail。能查出：元素被容器或窗口边缘裁掉、内容被 overflow:hidden 藏住、元素跑出可视区域、控件被别的元素盖住点不到、尺寸塌陷。改完界面代码后必须调用它自证，不要只说"应该修好了"。',
      parameters: {
        type: 'object',
        properties: {
          selectors: { type: 'array', items: { type: 'string' }, description: '只验证这些 CSS 选择器（含子树），如 ["#btn-clear-chat"]；留空则扫描整页' },
          checks: { type: 'array', items: { type: 'string' }, description: '要跑的检查项，默认 ["clipped","overflow-hidden","out-of-viewport"]，可加 "occluded"(控件被遮挡)、"zero-size"(尺寸塌陷)' },
          which: { type: 'string', description: '验证哪个窗口，默认 main' },
          screenshot: { type: 'boolean', description: '是否同时截图留证，默认 true', default: true },
          analyze: { type: 'boolean', description: '是否再让视觉模型看图复核（需要配置视觉模型），默认 true', default: true },
          expect: { type: 'string', description: '本次改动期望达到的效果，交给视觉模型对照判断，如"清空按钮完整可见，不再被右边缘裁掉"' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'analyze_screenshot',
      description: '让视觉模型看一张截图并回答具体问题。用于"量不出来只能靠看"的问题：错位、颜色不对、图标丢失、被遮挡、排版混乱、文字被截断。需要提供商支持视觉模型（如 qwen-vl-max / gpt-4o / glm-4v）。',
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string', description: '要模型重点判断什么，越具体越好，如"清空按钮是否完整可见、有没有被右边缘切掉"' },
          image_path: { type: 'string', description: '图片绝对路径；不传则用最近一次截图' },
          provider_id: { type: 'string', description: '用哪个提供商（可选，默认跟随当前激活模型）' },
          model: { type: 'string', description: '视觉模型名（可选，默认按提供商推断）' }
        },
        required: ['question']
      }
    }
  }
];

// Agent 系统提示词

// ==================== 多角色智能体管理 ====================
// 预设角色模板：每个角色有独立的系统提示词、工具权限、温度等配置
const PRESET_AGENT_ROLES = [
  {
    id: 'general',
    name: '通用助手',
    nameEn: 'General Assistant',
    emoji: '🤖',
    description: '全能型助手，可处理各类任务，支持所有工具',
    systemPrompt: null, // null 表示使用默认 AGENT_SYSTEM_PROMPT
    tools: ['run_shell', 'read_file', 'write_file', 'get_system_info', 'pet_action', 'web_search', 'web_fetch', 'http_request', 'file_search', 'directory_list', 'copy_file', 'move_file', 'create_directory', 'download_file', 'get_current_time', 'calculator', 'check_url', 'open_url', 'memory_save', 'memory_search', 'memory_list', 'memory_delete', 'todo_write', 'todo_update', 'todo_read', 'capture_window', 'verify_ui', 'analyze_screenshot'],
    temperature: 0.7,
    maxIterations: 8,
    allowDangerous: false,
    isPreset: true
  },
  {
    id: 'coder',
    name: '程序员',
    nameEn: 'Programmer',
    emoji: '💻',
    description: '专注代码编写、调试、项目开发，擅长读写文件和运行命令',
    systemPrompt: `你是浮灵饰界的程序员智能体灵汐，专精软件开发和代码工作。
## 核心能力
- 编写、调试、重构代码（支持 Python/JS/HTML/CSS/Shell 等）
- 读写项目文件，运行构建和测试命令
- 分析报错日志，定位并修复 bug
- 生成可直接运行的完整脚本和项目

## 工作规范（必须遵守）
1. **任务拆解**：接到需求后先拆解为可执行的子任务，按顺序执行
2. **先读后写**：修改文件前必须先用 read_file 读取现有内容
3. **结果校验**：写完代码后用 run_shell 运行验证，确认无语法错误
4. **边界判断**：不确定的依赖或环境先查询，不编造 API 和函数名
5. **终止判定**：代码可运行且满足需求后停止，不做无关修改

## 输出要求
- 代码完整可运行，不省略关键部分
- 说明文件路径和运行方式
- 报错时给出具体原因和修复方案`,
    tools: ['run_shell', 'read_file', 'write_file', 'get_system_info', 'web_search', 'web_fetch', 'http_request', 'file_search', 'directory_list', 'copy_file', 'move_file', 'create_directory', 'download_file', 'get_current_time', 'calculator', 'check_url', 'memory_save', 'memory_search', 'memory_list', 'memory_delete', 'todo_write', 'todo_update', 'todo_read', 'capture_window', 'verify_ui', 'analyze_screenshot'],
    temperature: 0.3,
    maxIterations: 10,
    allowDangerous: false,
    isPreset: true
  },
  {
    id: 'researcher',
    name: '研究员',
    nameEn: 'Researcher',
    emoji: '🔬',
    description: '专注信息分析、资料整理、深度调研，擅长读取和分析文件',
    systemPrompt: `你是浮灵饰界的研究员智能体灵汐，专精信息分析和深度调研。
## 核心能力
- 读取和分析本地文件、日志、数据
- 整理资料，提取关键信息
- 对比分析多份文档，生成结构化报告
- 系统调研某个主题，给出全面结论

## 工作规范（必须遵守）
1. **任务拆解**：将调研需求拆解为信息收集→分析→总结的步骤
2. **事实优先**：所有结论必须基于 read_file 读取的真实内容，不编造
3. **来源标注**：引用文件内容时标注来源文件
4. **缺失识别**：信息不足时明确说明缺失了什么，不猜测
5. **终止判定**：信息充分且结论清晰后停止

## 输出要求
- 结构化输出，分点清晰
- 区分"已查证事实"和"分析推断"
- 长报告先给摘要，再给详情`,
    tools: ['read_file', 'get_system_info', 'write_file', 'web_search', 'web_fetch', 'http_request', 'file_search', 'directory_list', 'download_file', 'get_current_time', 'calculator', 'check_url', 'memory_save', 'memory_search', 'memory_list', 'memory_delete', 'todo_write', 'todo_update', 'todo_read', 'capture_window', 'verify_ui', 'analyze_screenshot'],
    temperature: 0.5,
    maxIterations: 8,
    allowDangerous: false,
    isPreset: true
  },
  {
    id: 'writer',
    name: '文案写手',
    nameEn: 'Writer',
    emoji: '✍️',
    description: '专注创意写作、文案创作、内容生成，擅长写文件保存作品',
    systemPrompt: `你是浮灵饰界的文案写手智能体灵汐，专精创意写作和内容创作。
## 核心能力
- 撰写文章、故事、文案、脚本
- 生成营销文案、社交媒体内容
- 写作后用 write_file 保存为文件
- 根据反馈修改和润色

## 工作规范（必须遵守）
1. **任务拆解**：先确定主题→大纲→正文→润色的步骤
2. **用户意图**：准确理解用户想要的风格、长度、用途
3. **结果校验**：写完后检查是否满足所有要求
4. **保存成果**：较长的作品主动用 write_file 保存到桌面或指定路径
5. **终止判定**：作品完成且符合要求后停止

## 输出要求
- 内容有创意，不套模板
- 格式规范，排版清晰
- 主动建议保存路径`,
    tools: ['write_file', 'read_file', 'web_search', 'web_fetch', 'file_search', 'directory_list', 'get_current_time', 'memory_save', 'memory_search', 'memory_list', 'memory_delete', 'todo_write', 'todo_update', 'todo_read'],
    temperature: 0.8,
    maxIterations: 6,
    allowDangerous: false,
    isPreset: true
  },
  {
    id: 'ops',
    name: '运维工程师',
    nameEn: 'DevOps Engineer',
    emoji: '⚙️',
    description: '专注系统运维、环境配置、命令执行，擅长系统管理',
    systemPrompt: `你是浮灵饰界的运维工程师智能体灵汐，专精系统管理和运维操作。
## 核心能力
- 执行系统命令，管理进程和服务
- 配置环境变量、安装依赖
- 查看系统状态、日志、资源使用
- 排查系统问题，给出运维方案

## 工作规范（必须遵守）
1. **任务拆解**：运维操作先确认环境→备份→执行→验证
2. **安全第一**：禁止执行删除系统文件、格式化、修改注册表等危险操作
3. **先查后做**：操作前先用 get_system_info 和 run_shell 确认环境
4. **结果校验**：执行命令后检查输出，确认操作成功
5. **边界判断**：不确定的命令先解释风险，不盲目执行
6. **终止判定**：运维目标达成后停止

## 输出要求
- 命令附带说明和预期结果
- 报错时给出排查思路
- 重要操作提醒用户确认`,
    tools: ['run_shell', 'read_file', 'get_system_info', 'web_search', 'web_fetch', 'http_request', 'file_search', 'directory_list', 'copy_file', 'move_file', 'create_directory', 'download_file', 'get_current_time', 'check_url', 'open_url', 'memory_save', 'memory_search', 'memory_list', 'memory_delete', 'todo_write', 'todo_update', 'todo_read', 'capture_window', 'verify_ui', 'analyze_screenshot'],
    temperature: 0.2,
    maxIterations: 8,
    allowDangerous: false,
    isPreset: true
  },
  {
    id: 'analyst',
    name: '数据分析师',
    nameEn: 'Data Analyst',
    emoji: '📊',
    description: '专注数据处理、统计分析、报表生成，擅长处理数据文件',
    systemPrompt: `你是浮灵饰界的数据分析师智能体灵汐，专精数据处理和统计分析。
## 核心能力
- 读取 CSV/JSON/日志等数据文件
- 数据清洗、统计、聚合分析
- 生成分析报告和可视化建议
- 编写数据处理脚本

## 工作规范（必须遵守）
1. **任务拆解**：分析任务按 读取数据→清洗→统计→结论 步骤执行
2. **数据真实**：所有数字必须来自 read_file 的真实数据，不编造
3. **结果校验**：计算结果用脚本验证，不手算
4. **缺失识别**：数据不足时说明缺什么，不臆造
5. **终止判定**：分析完成且结论有数据支撑后停止

## 输出要求
- 用表格展示关键数据
- 结论附带数据依据
- 主动建议保存分析结果`,
    tools: ['read_file', 'run_shell', 'write_file', 'get_system_info', 'web_search', 'web_fetch', 'file_search', 'directory_list', 'calculator', 'get_current_time', 'download_file', 'memory_save', 'memory_search', 'memory_list', 'memory_delete', 'todo_write', 'todo_update', 'todo_read', 'capture_window', 'verify_ui', 'analyze_screenshot'],
    temperature: 0.3,
    maxIterations: 8,
    allowDangerous: false,
    isPreset: true
  }
];

// 自定义角色存储路径
function getCustomRolesPath() {
  const dataDir = path.join(process.cwd(), 'data');
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  return path.join(dataDir, 'agent_roles.json');
}

// 加载自定义角色
function loadCustomRoles() {
  try {
    const p = getCustomRolesPath();
    if (fs.existsSync(p)) {
      const data = JSON.parse(fs.readFileSync(p, 'utf8'));
      return Array.isArray(data) ? data : [];
    }
  } catch (e) { console.log('[AgentRoles] 加载自定义角色失败:', e.message); }
  return [];
}

// 保存自定义角色
function saveCustomRoles(roles) {
  try {
    fs.writeFileSync(getCustomRolesPath(), JSON.stringify(roles, null, 2), 'utf8');
    return true;
  } catch (e) { console.log('[AgentRoles] 保存自定义角色失败:', e.message); return false; }
}

// 获取所有角色（预设 + 自定义）
function getAgentRoles() {
  const custom = loadCustomRoles();
  return [...PRESET_AGENT_ROLES, ...custom];
}

// 根据 ID 获取角色
function getAgentRoleById(roleId) {
  if (!roleId) return PRESET_AGENT_ROLES[0]; // 默认通用助手
  return getAgentRoles().find(r => r.id === roleId) || PRESET_AGENT_ROLES[0];
}

// 保存/更新角色（自定义角色）
function saveAgentRole(role) {
  if (!role || !role.id || !role.name) return { success: false, error: '角色ID和名称不能为空' };
  const custom = loadCustomRoles();
  const idx = custom.findIndex(r => r.id === role.id);
  const roleData = { ...role, isPreset: false };
  if (idx >= 0) custom[idx] = roleData; else custom.push(roleData);
  saveCustomRoles(custom);
  return { success: true, role: roleData };
}

// 删除自定义角色
function deleteAgentRole(roleId) {
  const preset = PRESET_AGENT_ROLES.find(r => r.id === roleId);
  if (preset) return { success: false, error: '预设角色不能删除' };
  const custom = loadCustomRoles().filter(r => r.id !== roleId);
  saveCustomRoles(custom);
  return { success: true };
}


const AGENT_SYSTEM_PROMPT = `你是浮灵饰界的智能助手灵汐，具备思考和工具调用能力。你不是普通聊天机器人，必须主动使用工具完成任务。

## 核心原则
- 用户要求写代码/脚本/文件时，**必须调用 write_file 写入文件**，不要只在对话中展示代码
- 用户要求运行/执行时，**必须调用 run_shell 执行命令**，并返回执行结果
- 需要查看文件内容时，**必须调用 read_file**
- 完成任务后，用简洁语言总结做了什么

## 工作方式
1. 先思考（reasoning），分析用户需求并规划步骤
2. 需要外部信息或操作时，**必须实际输出 tool_calls 调用工具**，绝对不能只在思考中描述"我要调用xx工具"而不实际输出
3. **重要：思考（reasoning）只是你的内部规划过程，不是工具调用本身。如果你在思考中决定要调用某个工具，就必须在回答中实际输出该工具的 tool_calls 结构化数据，否则工具不会被执行。**
4. 根据工具返回结果继续思考，直到任务完成
- **多步任务必须逐步执行**：执行完一个工具后，必须查看工具返回结果，判断是否需要继续调用其他工具。不要执行一步就直接给最终答案，除非任务确实只需要一步。
- **工具结果校验**：每次工具执行后，检查返回的 success 字段和具体内容。如果失败，分析原因并重试或换方案；如果成功但信息不足，继续调用其他工具补充。
- **只有确认任务全部完成后才输出最终答案**：最终答案前不要再输出 tool_calls；如果还有未完成的步骤，继续调用工具。
5. 最终回答要简洁、实用、面向用户

## 工具使用规则
- run_shell：执行命令获取系统信息、运行脚本、检查环境
- read_file：读取文件内容
- write_file：写入文件（生成代码、配置、脚本等）
- get_system_info：获取系统概况
- pet_action：让宠物做动作
- web_search：**网络搜索**，查询最新资讯、技术文档、百科知识等外部信息。当用户问题需要外部信息或最新数据时，**必须先搜索**，不要凭记忆回答
- web_fetch：**抓取网页内容**，读取具体网页、文档、博客文章的详细内容。搜索到相关链接后，用此工具获取详细内容
- http_request：发送 HTTP 请求，调用 API、测试接口
- file_search：在目录中搜索文件，按名称或扩展名过滤
- directory_list：列出目录下的文件和子目录
- copy_file：复制文件或目录
- move_file：移动或重命名文件/目录
- create_directory：创建目录
- download_file：从 URL 下载文件到本地
- get_current_time：获取当前日期和时间
- calculator：执行数学计算
- check_url：检查 URL 是否可访问
- open_url：在默认浏览器中打开 URL
- memory_save / memory_search / memory_list / memory_delete：**长期记忆**的写入、检索、列举与删除
- todo_write / todo_update / todo_read：**待办清单**的整理、单条推进与读取
- capture_window：截取「需要验证的程序」窗口画面（默认本应用）
- verify_ui：**界面自验证**，量真实布局并返回 pass/warn/fail
- analyze_screenshot：让视觉模型看截图并回答具体问题

## 需求整理与待办规范（重要）
**先把需求变成可确认的清单，再动手。**
1. **多步骤 / 模糊需求**：动手前先调 todo_write，把用户那句话拆成 3~7 条待办；这就是"需求确认"——
   用户能一眼看出你理解成了什么。理解有歧义时，**在开头用一句话写明你的理解**再继续，不要默默假设。
2. **每条待办必须精确、可验证**：
   - text 用动词开头写"做什么"（"改 .panel-actions 的收缩规则"，不写"优化布局"）
   - done_when 写**完成判据**：怎么算做完了，必须可观测、可复核（"900px 窗口下 4 个按钮都完整可见"）
   - 禁止出现"优化一下""处理相关问题""完善功能"这类无法验证的说法
3. **过程要如实推进**：同一时刻只把一条标成 in_progress；做完立刻 todo_update 成 completed，
   并在 note 里写结果或证据（命令输出、截图路径、验证结论）。不要攒到最后一次性全标完成。
4. **需求变了**：用户在过程中改需求 → 用 todo_write 整表替换（可保留已完成条目的 id）。
5. **交答案之前必须让清单落地**：只要本轮建过或改过清单，给最终答复之前必须先用 todo_update
   把每条标成 completed（note 写证据）或写明为何未完成。**应用会在收尾时检查这件事**，
   清单没落地会被退回重做一轮 —— 所以别等提醒，做一条就标一条。
6. **汇报**：逐条对应待办说明完成情况；不要把没做的偷偷标成完成。

## 长期记忆使用规范
- **该记**：用户偏好与习惯（"不要每次都问我""回复要简短"）、项目约定与硬规则、环境限制（路径/端口/依赖）、踩过的坑与修复结论
- **不该记**：闲聊、一次性任务、能直接从代码或文件里读到的信息、临时状态
- 判断标准：**这条信息下次对话还有用吗？** 有用就 memory_save，否则不要存
- 一条记忆只讲一件事，写得具体（"Electron 版设置页是 column-count:2 双列瀑布流，隐藏控件会让整列跳位"），不要写空泛的大道理
- 用户说"记住…"时立即 memory_save；用户说"忘掉…"时先 memory_search 拿到 id 再 memory_delete
- 用户纠正了你的记忆时，用 memory_save 传同一个 id 覆盖，不要新增矛盾条目

## 修复自验证规范（重要）
改了代码/界面/配置后，**不能只说"已修复"，必须给出验证证据**：
1. 界面类问题（布局错乱、按钮被遮挡/裁切、元素不显示、样式没生效）→ 必须调用 **verify_ui** 自证：
   - 只验证刚改的部分时传 selectors（如 ["#btn-clear-chat"]），整页回归时留空
   - 看它返回的 verdict：pass 才算修好；warn/fail 必须继续改，并把 issues 里的 element/detail 当作线索
   - 需要"看"才能判断的（颜色、图标、错位）→ 再调 analyze_screenshot 并给出具体的 expect
2. 逻辑类问题（命令、脚本、接口）→ 用 run_shell / read_file 复现并确认输出符合预期
3. 涉及外部程序时，用 capture_window（传 title）抓对方窗口留证
4. 最终回答要明确写出：**改了什么 → 怎么验的 → 验证结论（通过/未通过 + 证据路径）**。没验证成功要如实说没通过，不许含糊


## 搜索与信息获取流程
1. 用户问题需要外部信息时，**先调用 web_search 搜索**
2. 从搜索结果中选择最相关的链接
3. 调用 web_fetch 抓取该网页的详细内容
4. 基于抓取的内容整理回答，**必须注明信息来源**
5. 如果搜索失败，尝试更换关键词或使用其他工具

## 注意
- 不要重复调用相同参数的工具
- 工具调用失败时**必须分析原因并立即尝试替代方案**，不能只回复文本说明失败
- write_file 写入失败时，检查路径权限，尝试更换到用户目录（如 C:\\Users\\<用户名>\\Desktop）
- run_shell 执行失败时，检查命令语法，尝试其他命令或参数
- 最终回答不要暴露工具调用细节，除非用户要求
- 用户上传的文件内容会在消息中给出，可以直接分析
- Windows 系统桌面路径优先使用 C:\\Users\\<用户名>\\Desktop，不要用 C:\\Users\\Public\\Desktop（需要管理员权限）`;

// 供渲染进程动态渲染"启用工具"/"角色可用工具"列表，避免前端硬编码导致新工具永远不生效
function getAgentTools() {
  // 只返回有风险的工具给前端设置页面（无风险工具默认启用，不需要用户配置）
  return AGENT_TOOLS
    .filter(t => RISKY_TOOLS.has(t.function.name))
    .map(t => ({
    name: t.function.name,
    description: t.function.description || '',
    parameters: t.function.parameters || null
  }));
}

// 粗略 token 估算（CJK 1 字符 ≈ 1 token，其他 4 字符 ≈ 1 token）
function approxTokens(str) {
  const s = typeof str === 'string' ? str : JSON.stringify(str || '');
  if (!s) return 0;
  const cjk = (s.match(/[\u2E80-\u9FFF\uF900-\uFAFF\uAC00-\uD7AF\uFF00-\uFFEF]/g) || []).length;
  return Math.ceil(cjk + (s.length - cjk) * 0.26);
}

// 供渲染进程估算"上下文占用"：工具定义 + 系统提示词的真实开销（这部分前端拿不到原文）
function getContextMeta() {
  return {
    toolCount: AGENT_TOOLS.length,
    toolsTokens: approxTokens(JSON.stringify(AGENT_TOOLS)),
    systemPromptTokens: approxTokens(AGENT_SYSTEM_PROMPT || ''),
    toolNames: AGENT_TOOLS.map(t => t.function.name)
  };
}


// 从思考内容中提取工具调用意图（qwen3小模型常只在思考里描述不输出tool_calls，此函数手动提取并执行）
function extractToolCallFromReasoning(reasoning, userMessage) {
  if (!reasoning) return null;
  const text = reasoning + ' ' + (userMessage || '');

  // web_search：提取搜索关键词
  if (/web_search|搜索|查找|查询|检索|搜一下/i.test(text)) {
    // 尝试提取引号中的关键词
    let query = null;
    // 引号要覆盖中文弯引号 “ ” ‘ ’ 和直角引号——模型最常把关键词用 “xxx” 包起来
    const quoteMatch = text.match(/[""「」『』“”“”‘’]([^""「」『』“”“”‘’]{2,50})[""「」『』“”“”‘’]/);
    if (quoteMatch) query = quoteMatch[1];
    // 尝试提取"搜索xxx"、"查询xxx"模式
    if (!query) {
      const searchMatch = text.match(/(?:搜索|查找|查询|检索|搜一下)[：: ]*([^\n，。；！]{2,50})/);
      if (searchMatch) query = searchMatch[1].trim();
    }
    // 尝试提取"关键词xxx"模式
    if (!query) {
      const kwMatch = text.match(/关键词[为是：: ]*([^\n，。；！]{2,50})/);
      if (kwMatch) query = kwMatch[1].trim();
    }
    if (query && query.length >= 2) {
      console.log('[Agent] 从思考中提取到 web_search 调用，query:', query);
      return { name: 'web_search', arguments: { query, max_results: 5 } };
    }
  }

  // web_fetch：提取URL
  if (/web_fetch|抓取|访问网页|打开链接|读取网页/i.test(text)) {
    const urlMatch = text.match(/https?:\/\/[^\s，。；！"')]+/);
    if (urlMatch) {
      console.log('[Agent] 从思考中提取到 web_fetch 调用，url:', urlMatch[0]);
      return { name: 'web_fetch', arguments: { url: urlMatch[0] } };
    }
  }

  return null; // 复杂工具（write_file/run_shell等）不自动提取，避免误执行
}

// ==================== 搜索引擎解析（web_search 用） ====================
const SEARCH_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

function stripTags(s) {
  return String(s || '').replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ').trim();
}

function parseBingResults(html, max) {
  const out = [];
  const blocks = String(html || '').split(/<li class="b_algo/).slice(1);
  for (const b of blocks) {
    const m = b.match(/<h2[^>]*>[\s\S]*?<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!m) continue;
    const url = String(m[1] || '').replace(/&amp;/g, '&');
    const title = stripTags(m[2]);
    if (!title || !/^https?:\/\//i.test(url)) continue;
    const sn = b.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    const snippet = sn ? stripTags(sn[1]) : '';
    out.push({ title, url, snippet });
    if (out.length >= max) break;
  }
  return out;
}

function parseDuckDuckGoResults(html, max) {
  const out = [];
  const re = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>[\s\S]*?<a[^>]*class="result__snippet"[^>]*>(.*?)<\/a>/g;
  let m;
  while ((m = re.exec(String(html || ''))) !== null && out.length < max) {
    const title = stripTags(m[2]);
    const url = String(m[1] || '').replace(/&amp;/g, '&');
    if (!title || !url) continue;
    out.push({ title, url, snippet: stripTags(m[3]) });
  }
  return out;
}

function parseSo360Results(html, max) {
  const out = [];
  const blocks = String(html || '').split(/<li class="res-list/).slice(1);
  for (const b of blocks) {
    const m = b.match(/<h3[^>]*>[\s\S]*?<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!m) continue;
    let url = String(m[1] || '').replace(/&amp;/g, '&');
    const title = stripTags(m[2]);
    if (!title) continue;
    // 360 的跳转链接可能是 /link?url=xxx
    const enc = url.match(/[?&]url=([^&]+)/);
    if (enc) { try { url = decodeURIComponent(enc[1]); } catch (e) {} }
    if (!/^https?:\/\//i.test(url)) continue;
    const sn = b.match(/<p[^>]*class="res-desc"[^>]*>([\s\S]*?)<\/p>/i)
      || b.match(/<p[^>]*class="res-rich"[^>]*>([\s\S]*?)<\/p>/i)
      || b.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    out.push({ title, url, snippet: sn ? stripTags(sn[1]) : '' });
    if (out.length >= max) break;
  }
  return out;
}

// 多引擎搜索：逐个尝试，任一成功即返回（国内网络 DuckDuckGo 基本不可达，Bing 优先）
async function searchWeb(query, maxResults) {
  const q = encodeURIComponent(query || '');
  const engines = [
    { name: 'bing-cn', url: 'https://cn.bing.com/search?q=' + q, parse: parseBingResults },
    { name: 'bing', url: 'https://www.bing.com/search?q=' + q, parse: parseBingResults },
    { name: 'duckduckgo', url: 'https://html.duckduckgo.com/html/?q=' + q, parse: parseDuckDuckGoResults },
    { name: '360so', url: 'https://www.so.com/s?q=' + q, parse: parseSo360Results }
  ];
  const errors = [];
  for (const eng of engines) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    try {
      const resp = await fetch(eng.url, {
        headers: { 'User-Agent': SEARCH_UA, 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' },
        signal: controller.signal,
        redirect: 'follow'
      });
      clearTimeout(timer);
      const html = await resp.text();
      const results = eng.parse(html, maxResults);
      if (results.length > 0) {
        console.log('[web_search] 引擎 ' + eng.name + ' 命中 ' + results.length + ' 条');
        return { success: true, query, engine: eng.name, results, count: results.length };
      }
      errors.push(eng.name + ': 未解析到结果');
    } catch (e) {
      clearTimeout(timer);
      errors.push(eng.name + ': ' + (e && e.message ? e.message : String(e)));
    }
  }
  return { success: false, error: '搜索失败（已尝试 ' + engines.map(e => e.name).join(' / ') + '）：' + errors.join('；') };
}

// ==================== 长期记忆 / 视觉复核 的辅助实现 ====================

// 精简记忆条目再回给模型（去掉 createdAt 之类噪音，省 token）
function memoryBrief(it) {
  if (!it) return null;
  return {
    id: it.id,
    text: it.text,
    tags: it.tags || [],
    kind: it.kind,
    pinned: !!it.pinned,
    updatedAt: new Date(it.updatedAt || Date.now()).toLocaleString('zh-CN'),
    ...(Number.isFinite(it.score) ? { score: it.score } : {})
  };
}

// 最近一次截图路径：analyze_screenshot 不带 image_path 时复用
let lastScreenshotPath = null;

// 常见提供商的视觉模型推断。
// ⚠️ 不能只匹配域名：很多人用的是中转 / 自建网关 / 反代，apiUrl 根本不是官方域名。
// 所以对「提供商名称 + apiUrl + 当前模型名」整串做匹配，顺序从具体到宽泛（openai 放最后兜底）。
const VISION_MODEL_HINTS = [
  [/dashscope|aliyuncs|百炼|通义|qwen/i, 'qwen-vl-max'],
  [/glm|智谱|bigmodel|chatglm/i, 'glm-4v-flash'],
  [/hunyuan|混元|tencent/i, 'hunyuan-vision'],
  [/ernie|qianfan|千帆|文心|baidubce/i, 'ernie-4.5-turbo-vl'],
  [/kimi|moonshot/i, 'moonshot-v1-8k-vision-preview'],
  [/volces|doubao|豆包|火山/i, 'doubao-1.5-vision-pro'],
  [/stepfun|阶跃/i, 'step-1v-8k'],
  [/gemini|generativelanguage|google/i, 'gemini-2.0-flash'],
  [/ollama|llava|localhost:11434|127\.0\.0\.1:11434/i, 'llava'],
  [/minimax|abab/i, 'abab6.5-vl'],
  [/openai|gpt|azure/i, 'gpt-4o']
];

/**
 * 解析用于「看图」的提供商与模型。
 * 优先级：入参指定 model > 提供商自带 visionModel > aiConfig.vision.model >
 *         aiConfig.vision.providerId 指定 > 当前激活提供商 + 模型名推断
 */
function resolveVisionTarget({ providerId, model } = {}) {
  const cfgVision = aiConfig?.vision || {};
  const p = findProvider(providerId || cfgVision.providerId) ||
            (providerId ? null : findProvider(null));
  if (!p) return { error: '当前没有已启用的 AI 提供商，无法看图' };

  let resolved = model || p.visionModel || cfgVision.model;
  if (!resolved) {
    const hay = (p.name || '') + ' ' + (p.apiUrl || '') + ' ' + (p.model || '');
    const hit = VISION_MODEL_HINTS.find(([re]) => re.test(hay));
    resolved = hit ? hit[1] : null;
  }
  if (!resolved) {
    return {
      error: '提供商「' + p.name + '」没有推断出视觉模型，请配置 aiConfig.vision = { providerId, model }，或在调用时显式传 model（如 qwen-vl-max / gpt-4o / glm-4v-flash）'
    };
  }
  return { provider: p, model: resolved };
}

/**
 * 把图片交给视觉模型分析。
 * 注意：这里不能走 callProviderAPI —— 它的 sanitizeOutgoingMessages 会把数组型 content 拍平成字符串，
 * 多模态消息会被破坏，所以单独发一次请求。
 */
async function analyzeImageWithVision({ imagePath, question, providerId, model, maxTokens = 1024 }) {
  const target = resolveVisionTarget({ providerId, model });
  if (target.error) return { success: false, error: target.error };

  if (!imagePath || !fs.existsSync(imagePath)) {
    return { success: false, error: '截图文件不存在: ' + (imagePath || '(空)') };
  }

  // 压一下体积：视觉模型不需要原图，过大反而容易请求超时
  let dataUrl;
  let sentNote;
  try {
    const { nativeImage } = require('electron');
    const img = nativeImage.createFromPath(imagePath);
    const size = img.getSize();
    const resized = size.width > 1440 ? img.resize({ width: 1440 }) : img;
    const pngBuf = resized.toPNG();
    if (pngBuf.length <= 1.2 * 1024 * 1024) {
      dataUrl = 'data:image/png;base64,' + pngBuf.toString('base64');
      sentNote = resized.getSize().width + 'x' + resized.getSize().height + ' PNG';
    } else {
      const jpg = resized.toJPEG(82);
      dataUrl = 'data:image/jpeg;base64,' + jpg.toString('base64');
      sentNote = resized.getSize().width + 'x' + resized.getSize().height + ' JPEG';
    }
  } catch (e) {
    try {
      dataUrl = 'data:image/png;base64,' + fs.readFileSync(imagePath).toString('base64');
      sentNote = '原图 PNG';
    } catch (e2) {
      return { success: false, error: '读取截图失败: ' + e2.message };
    }
  }

  const url = new URL(target.provider.apiUrl);
  const client = url.protocol === 'https:' ? https : http;
  const bodyObj = {
    model: target.model,
    stream: false,
    max_tokens: maxTokens,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: question },
        { type: 'image_url', image_url: { url: dataUrl } }
      ]
    }]
  };
  const body = JSON.stringify(bodyObj);

  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) };
    if (target.provider.apiKey) headers['Authorization'] = 'Bearer ' + target.provider.apiKey;

    const req = client.request({
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname.replace(/\/$/, '') + (url.search || ''),
      method: 'POST',
      headers
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          done({ success: false, error: simplifyApiError(res.statusCode, data), model: target.model, provider: target.provider.name });
          return;
        }
        try {
          const parsed = JSON.parse(data);
          const content = parsed?.choices?.[0]?.message?.content;
          const text = typeof content === 'string'
            ? content
            : (Array.isArray(content) ? content.map(p => p?.text || '').join('\n') : '');
          if (!text) {
            done({ success: false, error: '视觉模型返回空内容', model: target.model, raw: String(data).slice(0, 300) });
            return;
          }
          done({ success: true, model: target.model, provider: target.provider.name, sentImage: sentNote, analysis: text.trim() });
        } catch (e) {
          done({ success: false, error: '解析视觉模型响应失败: ' + e.message, raw: String(data).slice(0, 300) });
        }
      });
    });
    req.on('error', (e) => done({ success: false, error: '视觉模型请求失败: ' + e.message }));
    req.setTimeout(90000, () => { try { req.destroy(); } catch (e) {} done({ success: false, error: '视觉模型请求超时（90 秒）' }); });
    safeWriteRequest(req, body, (e) => done({ success: false, error: '视觉模型请求发送失败: ' + e.message }));
  });
}

// 从视觉模型回答里抽取「通过 / 不通过」结论
function parseVisionVerdict(text) {
  if (!text) return null;
  const head = String(text).slice(0, 400);
  if (/结论\s*[:：]?\s*不通过|不通过|未通过|仍有问题|依然被裁|存在缺陷/i.test(head)) return 'fail';
  if (/结论\s*[:：]?\s*通过|验证通过|没有问题|未发现(明显)?问题/i.test(head)) return 'pass';
  return null;
}

/**
 * 同步写请求体并结束请求。
 * ⚠️ 对端已断（本地模型被杀/重启、socket 已销毁）时 req.write 会**同步抛 EPIPE**，
 * 不兜住就会变成 uncaughtException（再叠加断管日志就是异常风暴）。
 */
function safeWriteRequest(req, body, onFail) {
  try {
    req.write(body);
    req.end();
    return true;
  } catch (e) {
    if (onFail) { try { onFail(e); } catch (e2) { /* 忽略 */ } }
    return false;
  }
}

// 执行工具
// ctx: { conversationId } —— 待办清单按会话隔离，靠它定位
async function executeTool(name, args, workdir, ctx) {
  const { exec, execSync } = require('child_process');
  const os = require('os');
  // 相对路径解析到项目工作目录；未选项目或已是绝对路径则原样返回
  const resolveProjPath = (p) => {
    if (!p || typeof p !== 'string') return p;
    if (!workdir) return p;
    return path.isAbsolute(p) ? p : path.resolve(workdir, p);
  };
  try {
    switch (name) {
      case 'run_shell': {
        const cmd = args.command;
        const timeout = args.timeout || 15000;
        // 安全限制：禁止危险命令
        const dangerous = /^(del|rmdir|format|diskpart|shutdown.*\/s|reg delete)/i;
        if (dangerous.test(cmd.trim())) {
          return { success: false, error: '命令被安全策略拦截（可能危险）' };
        }
        // start 命令启动外部程序，不等待退出
        if (/^start\s/i.test(cmd.trim())) {
          try {
            exec(cmd, { windowsHide: true, timeout: 5000, cwd: workdir || undefined });
            return { success: true, output: '已启动: ' + cmd };
          } catch(e) {
            return { success: false, error: e.message };
          }
        }
        // 普通命令用 Promise 包装 exec，避免阻塞
        return new Promise((resolve) => {
          let resolved = false;
          const child = exec(cmd, { encoding: 'utf8', timeout, windowsHide: true, maxBuffer: 1024 * 1024, cwd: workdir || undefined }, (error, stdout, stderr) => {
            if (resolved) return;
            resolved = true;
            if (error && error.killed) {
              // 超时：尝试杀死整个进程树
              try {
                execSync(`taskkill /F /T /PID ${child.pid} 2>nul`, { windowsHide: true, timeout: 5000 });
              } catch(e) { /* 进程可能已经退出 */ }
              resolve({ success: false, error: '命令执行超时（' + (timeout/1000) + '秒），已终止进程树', output: (stdout || '').slice(0, 3000) });
            } else if (error) {
              resolve({ success: false, error: error.message, output: (stdout + stderr).slice(0, 3000) });
            } else {
              resolve({ success: true, output: (stdout || '').slice(0, 5000) });
            }
          });
          // 额外的超时保护：确保即使 exec 的 timeout 不生效也能 resolve
          setTimeout(() => {
            if (!resolved) {
              resolved = true;
              try {
                execSync(`taskkill /F /T /PID ${child.pid} 2>nul`, { windowsHide: true, timeout: 5000 });
              } catch(e) { /* 忽略 */ }
              resolve({ success: false, error: '命令执行超时（' + (timeout/1000) + '秒），已强制终止', output: '' });
            }
          }, timeout + 2000);
        });
      }
      case 'read_file': {
        const p = resolveProjPath(args.path);
        if (!fs.existsSync(p)) return { success: false, error: '文件不存在: ' + p };
        const stat = fs.statSync(p);
        if (stat.size > 5 * 1024 * 1024) return { success: false, error: '文件过大（>5MB），请用其他方式查看' };
        const content = fs.readFileSync(p, 'utf8');
        return { success: true, content: content.slice(0, 20000) };
      }
      case 'write_file': {
        let p = resolveProjPath(args.path);
        try {
          fs.writeFileSync(p, args.content || '', 'utf8');
          return { success: true, message: '已写入: ' + p };
        } catch (e) {
          const isPermError = e.code === 'EPERM' || e.code === 'EACCES' || e.message.includes('permission') || e.message.includes('拒绝');
          if (isPermError) {
            // 尝试用 PowerShell 提权写入（触发 UAC 弹窗）
            // 使用异步 exec + 超时，避免 UAC 弹窗导致永久挂起
            try {
              const tmpFile = path.join(os.tmpdir(), 'ailobster_write_' + Date.now() + '.tmp');
              fs.writeFileSync(tmpFile, args.content || '', 'utf8');
              const destDir = path.dirname(p);
              const psCmd = `Start-Process powershell -Verb RunAs -Wait -ArgumentList '-Command', 'if (!(Test-Path "${destDir}")) { New-Item -ItemType Directory -Path "${destDir}" -Force }; Copy-Item -Path "${tmpFile}" -Destination "${p}" -Force; Remove-Item "${tmpFile}" -Force'`;
              
              // 异步执行，最多等待30秒（UAC弹窗用户确认时间）
              const adminResult = await new Promise((resolve) => {
                let done = false;
                const child = exec(psCmd, { windowsHide: true, timeout: 30000 }, (error) => {
                  if (done) return;
                  done = true;
                  resolve(!error);
                });
                // 额外超时保护
                setTimeout(() => {
                  if (!done) {
                    done = true;
                    try { child.kill(); } catch(e) {}
                    resolve(false);
                  }
                }, 32000);
              });
              
              if (adminResult && fs.existsSync(p)) {
                return { success: true, message: '已通过管理员权限写入: ' + p };
              }
            } catch (eAdmin) {
              console.log('[Agent] 提权写入失败或用户拒绝:', eAdmin.message);
            }
            // 提权失败，如果是 Public 桌面，自动尝试用户桌面
            if (p.includes('Public\\Desktop') || p.includes('Public/Desktop')) {
              const userDesktop = path.join(os.homedir(), 'Desktop');
              const fileName = path.basename(p);
              const newPath = path.join(userDesktop, fileName);
              try {
                if (!fs.existsSync(userDesktop)) fs.mkdirSync(userDesktop, { recursive: true });
                fs.writeFileSync(newPath, args.content || '', 'utf8');
                return { success: true, message: '原路径无权限，已自动写入用户桌面: ' + newPath };
              } catch (e2) {
                return { success: false, error: '写入失败: ' + e.message + '，提权和自动改路径均失败' };
              }
            }
            return { success: false, error: '写入失败（需要管理员权限，已尝试提权）: ' + e.message };
          }
          return { success: false, error: '写入失败: ' + e.message };
        }
      }
      case 'get_system_info': {
        return {
          success: true,
          info: {
            platform: os.platform(),
            release: os.release(),
            arch: os.arch(),
            cpu: os.cpus()[0]?.model,
            cpuCores: os.cpus().length,
            totalMem: Math.round(os.totalmem() / 1024 / 1024) + ' MB',
            freeMem: Math.round(os.freemem() / 1024 / 1024) + ' MB',
            nodeVersion: process.version,
            appVersion: require('electron').app?.getVersion() || 'unknown',
            hostname: os.hostname()
          }
        };
      }
      case 'pet_action': {
        // 通过全局事件通知主进程触发宠物动作
        try {
          const { app } = require('electron');
          app.emit('agent:pet-action', args.action);
        } catch(e) {}
        return { success: true, message: '已触发宠物动作: ' + args.action };
      }
      case 'web_search': {
        const query = args.query;
        const maxResults = Math.min(args.max_results || 8, 20);
        if (!query || !String(query).trim()) {
          return { success: false, error: '搜索关键词为空' };
        }
        // 旧实现里 DuckDuckGo 一旦抛异常就直接失败，Bing 备用形同虚设；
        // 国内网络 DDG 基本不可达 → 搜索 100% 失败。改为多引擎逐个尝试。
        return await searchWeb(query, maxResults);
      }
      case 'web_fetch': {
        const url = args.url;
        const maxLength = args.max_length || 8000;
        const fetchTimeout = 20000;
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), fetchTimeout);
          const response = await fetch(url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
            signal: controller.signal
          });
          clearTimeout(timer);
          const contentType = response.headers.get('content-type') || '';
          let text = await response.text();
          // 如果是 HTML，移除标签，只保留文本
          if (contentType.includes('text/html')) {
            // 移除 script 和 style 标签
            text = text.replace(/<script[\s\S]*?<\/script>/gi, '');
            text = text.replace(/<style[\s\S]*?<\/style>/gi, '');
            // 移除 HTML 标签
            text = text.replace(/<[^>]*>/g, ' ');
            // 合并空白
            text = text.replace(/\s+/g, ' ').trim();
          }
          return { success: true, url, status: response.status, content: text.slice(0, maxLength), truncated: text.length > maxLength };
        } catch (e) {
          return { success: false, error: '抓取失败: ' + e.message };
        }
      }
      case 'http_request': {
        const url = args.url;
        const method = (args.method || 'GET').toUpperCase();
        const headers = args.headers || {};
        const body = args.body;
        const timeout = args.timeout || 15000;
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), timeout);
          const options = { method, headers, signal: controller.signal };
          if (body && method !== 'GET') {
            options.body = body;
          }
          const response = await fetch(url, options);
          clearTimeout(timer);
          const responseText = await response.text();
          const responseHeaders = {};
          response.headers.forEach((value, key) => { responseHeaders[key] = value; });
          return { success: true, url, method, status: response.status, statusText: response.statusText, headers: responseHeaders, body: responseText.slice(0, 10000) };
        } catch (e) {
          return { success: false, error: '请求失败: ' + e.message };
        }
      }
      case 'file_search': {
        const directory = resolveProjPath(args.directory);
        const pattern = args.pattern;
        const maxResults = args.max_results || 50;
        try {
          if (!fs.existsSync(directory)) {
            return { success: false, error: '目录不存在: ' + directory };
          }
          // 将通配符模式转换为正则表达式
          const regexPattern = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
          const regex = new RegExp('^' + regexPattern + '$', 'i');
          const results = [];
          function searchDir(dir) {
            if (results.length >= maxResults) return;
            try {
              const entries = fs.readdirSync(dir, { withFileTypes: true });
              for (const entry of entries) {
                if (results.length >= maxResults) break;
                const fullPath = path.join(dir, entry.name);
                if (entry.isFile() && regex.test(entry.name)) {
                  const stat = fs.statSync(fullPath);
                  results.push({ path: fullPath, name: entry.name, size: stat.size, modified: stat.mtime.toISOString() });
                } else if (entry.isDirectory() && !entry.name.startsWith('.')) {
                  searchDir(fullPath);
                }
              }
            } catch (e) { /* 忽略无权限目录 */ }
          }
          searchDir(directory);
          return { success: true, directory, pattern, results, count: results.length };
        } catch (e) {
          return { success: false, error: '搜索失败: ' + e.message };
        }
      }
      case 'directory_list': {
        const dirPath = resolveProjPath(args.path);
        const showHidden = args.show_hidden || false;
        try {
          if (!fs.existsSync(dirPath)) {
            return { success: false, error: '目录不存在: ' + dirPath };
          }
          const entries = fs.readdirSync(dirPath, { withFileTypes: true });
          const result = [];
          for (const entry of entries) {
            if (!showHidden && entry.name.startsWith('.')) continue;
            const fullPath = path.join(dirPath, entry.name);
            try {
              const stat = fs.statSync(fullPath);
              result.push({
                name: entry.name,
                type: entry.isDirectory() ? 'directory' : 'file',
                size: entry.isFile() ? stat.size : null,
                modified: stat.mtime.toISOString()
              });
            } catch (e) { /* 忽略 */ }
          }
          // 目录在前，文件在后
          result.sort((a, b) => {
            if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
            return a.name.localeCompare(b.name);
          });
          return { success: true, path: dirPath, entries: result, count: result.length };
        } catch (e) {
          return { success: false, error: '列出目录失败: ' + e.message };
        }
      }
      case 'copy_file': {
        const source = resolveProjPath(args.source);
        const destination = resolveProjPath(args.destination);
        const overwrite = args.overwrite || false;
        try {
          if (!fs.existsSync(source)) {
            return { success: false, error: '源文件不存在: ' + source };
          }
          if (fs.existsSync(destination) && !overwrite) {
            return { success: false, error: '目标文件已存在，设置 overwrite=true 可覆盖' };
          }
          const stat = fs.statSync(source);
          if (stat.isDirectory()) {
            // 复制目录
            function copyDir(src, dest) {
              if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
              const entries = fs.readdirSync(src, { withFileTypes: true });
              for (const entry of entries) {
                const srcPath = path.join(src, entry.name);
                const destPath = path.join(dest, entry.name);
                if (entry.isDirectory()) {
                  copyDir(srcPath, destPath);
                } else {
                  fs.copyFileSync(srcPath, destPath);
                }
              }
            }
            copyDir(source, destination);
          } else {
            // 确保目标目录存在
            const destDir = path.dirname(destination);
            if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
            fs.copyFileSync(source, destination);
          }
          return { success: true, message: '已复制: ' + source + ' -> ' + destination };
        } catch (e) {
          return { success: false, error: '复制失败: ' + e.message };
        }
      }
      case 'move_file': {
        const source = resolveProjPath(args.source);
        const destination = resolveProjPath(args.destination);
        try {
          if (!fs.existsSync(source)) {
            return { success: false, error: '源文件不存在: ' + source };
          }
          // 确保目标目录存在
          const destDir = path.dirname(destination);
          if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
          fs.renameSync(source, destination);
          return { success: true, message: '已移动: ' + source + ' -> ' + destination };
        } catch (e) {
          // 如果跨盘移动失败，尝试复制+删除
          try {
            if (fs.existsSync(source)) {
              const stat = fs.statSync(source);
              if (stat.isDirectory()) {
                function copyDir(src, dest) {
                  if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
                  const entries = fs.readdirSync(src, { withFileTypes: true });
                  for (const entry of entries) {
                    const srcPath = path.join(src, entry.name);
                    const destPath = path.join(dest, entry.name);
                    if (entry.isDirectory()) copyDir(srcPath, destPath);
                    else fs.copyFileSync(srcPath, destPath);
                  }
                }
                copyDir(source, destination);
                fs.rmSync(source, { recursive: true, force: true });
              } else {
                fs.copyFileSync(source, destination);
                fs.unlinkSync(source);
              }
              return { success: true, message: '已移动（跨盘）: ' + source + ' -> ' + destination };
            }
          } catch (e2) {
            return { success: false, error: '移动失败: ' + e2.message };
          }
          return { success: false, error: '移动失败: ' + e.message };
        }
      }
      case 'create_directory': {
        const dirPath = resolveProjPath(args.path);
        try {
          if (fs.existsSync(dirPath)) {
            return { success: true, message: '目录已存在: ' + dirPath };
          }
          fs.mkdirSync(dirPath, { recursive: true });
          return { success: true, message: '已创建目录: ' + dirPath };
        } catch (e) {
          return { success: false, error: '创建目录失败: ' + e.message };
        }
      }
      case 'download_file': {
        const url = args.url;
        const destination = resolveProjPath(args.destination);
        const timeout = args.timeout || 60000;
        try {
          // 确保目标目录存在
          const destDir = path.dirname(destination);
          if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), timeout);
          const response = await fetch(url, {
            signal: controller.signal,
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
          });
          clearTimeout(timer);
          if (!response.ok) {
            return { success: false, error: '下载失败，HTTP 状态: ' + response.status };
          }
          const buffer = Buffer.from(await response.arrayBuffer());
          fs.writeFileSync(destination, buffer);
          return { success: true, message: '已下载: ' + url + ' -> ' + destination, size: buffer.length, path: destination };
        } catch (e) {
          return { success: false, error: '下载失败: ' + e.message };
        }
      }
      case 'get_current_time': {
        const now = new Date();
        return {
          success: true,
          timestamp: now.getTime(),
          iso: now.toISOString(),
          local: now.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }),
          date: now.toLocaleDateString('zh-CN'),
          time: now.toLocaleTimeString('zh-CN'),
          weekday: ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][now.getDay()]
        };
      }
      case 'calculator': {
        const expression = args.expression;
        try {
          // 安全计算：只允许数字、运算符、Math 函数和括号
          const sanitized = expression.replace(/[^0-9+\-*/().,\sMath.PIE.sqrtpowabsceilfloorroundminmaxlogsin cos tan asin acos atan]/g, '');
          if (!sanitized || sanitized.trim() === '') {
            return { success: false, error: '无效的数学表达式' };
          }
          // 使用 Function 构造函数计算（比 eval 稍安全）
          const result = new Function('"use strict"; return (' + sanitized + ')')();
          if (typeof result !== 'number' || !isFinite(result)) {
            return { success: false, error: '计算结果无效' };
          }
          return { success: true, expression, result };
        } catch (e) {
          return { success: false, error: '计算失败: ' + e.message };
        }
      }
      case 'check_url': {
        const url = args.url;
        const timeout = args.timeout || 10000;
        try {
          const startTime = Date.now();
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), timeout);
          const response = await fetch(url, {
            method: 'HEAD',
            signal: controller.signal,
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
          });
          clearTimeout(timer);
          const responseTime = Date.now() - startTime;
          return { success: true, url, status: response.status, statusText: response.statusText, responseTime: responseTime + 'ms', accessible: response.ok };
        } catch (e) {
          return { success: false, url, accessible: false, error: '检查失败: ' + e.message };
        }
      }
      case 'open_url': {
        const url = args.url;
        try {
          const { shell } = require('electron');
          // 为 shell.openExternal 添加超时保护
          const openResult = await Promise.race([
            shell.openExternal(url),
            new Promise((resolve, reject) => setTimeout(() => reject(new Error('打开超时')), 10000))
          ]);
          return { success: true, message: '已在浏览器中打开: ' + url };
        } catch (e) {
          // 备用：使用系统命令打开
          try {
            const { exec } = require('child_process');
            exec('start "" "' + url + '"', { timeout: 5000 });
            return { success: true, message: '已在浏览器中打开: ' + url };
          } catch (e2) {
            return { success: false, error: '打开失败: ' + (e.message || e2.message) };
          }
        }
      }
      // ==================== 待办事项 ====================
      case 'todo_write': {
        const r = TodoStore.write(ctx && ctx.conversationId, args.items, args.title);
        return { ...r, hint: r.progress.completed < r.progress.total
          ? '清单已更新。先把当前这条做完（todo_update 标记），再开始下一条。'
          : '全部完成，可以汇报结果了。' };
      }
      case 'todo_update': {
        const r = TodoStore.update(ctx && ctx.conversationId, {
          id: args.id,
          text: args.text,
          status: args.status,
          note: args.note,
          done_when: args.done_when,
          new_text: args.new_text
        });
        return r;
      }
      case 'todo_read': {
        const r = TodoStore.read(ctx && ctx.conversationId);
        return r.items.length ? r : { ...r, hint: '当前会话还没有待办清单。多步骤需求应当先 todo_write 整理出来。' };
      }

      // ==================== 长期记忆 ====================
      case 'memory_save': {
        const r = MemoryStore.add({
          text: args.text,
          tags: args.tags,
          kind: args.kind,
          pinned: args.pinned,
          id: args.id,
          source: 'agent'
        });
        if (!r.success) return r;
        return {
          success: true,
          action: r.updated ? 'updated' : 'added',
          item: memoryBrief(r.item),
          total: r.total,
          message: (r.updated ? '已更新记忆 ' : '已记住 ') + r.item.id + '（记忆库共 ' + r.total + ' 条）'
        };
      }
      case 'memory_search': {
        const items = MemoryStore.search(args.query, args.limit || 10);
        return {
          success: true,
          query: args.query,
          count: items.length,
          items: items.map(memoryBrief),
          stats: MemoryStore.stats(),
          ...(items.length ? {} : { hint: '没有匹配的记忆。若这条信息以后还用得上，用 memory_save 记下来。' })
        };
      }
      case 'memory_list': {
        const items = MemoryStore.list({ tag: args.tag, kind: args.kind, limit: args.limit || 50 });
        return { success: true, count: items.length, items: items.map(memoryBrief), stats: MemoryStore.stats() };
      }
      case 'memory_delete': {
        if (args.id) {
          const r = MemoryStore.remove(args.id);
          if (!r.success) return r;
          return { success: true, removed: [memoryBrief(r.removed)], total: r.total };
        }
        if (args.query) {
          const r = MemoryStore.removeByQuery(args.query, args.limit || 10);
          if (!r.success) return r;
          return { success: true, removed: r.removed.map(memoryBrief), total: r.total };
        }
        return { success: false, error: '需要提供 id 或 query 之一' };
      }

      // ==================== 截图 / 界面自验证 ====================
      case 'capture_window': {
        const res = args.title
          ? await UiVerify.captureProgramWindow({ title: args.title, index: args.index, savePath: args.save_path })
          : await UiVerify.captureAppWindow({ which: args.which || 'main', savePath: args.save_path });
        if (res.success) lastScreenshotPath = res.path;
        return res;
      }
      case 'verify_ui': {
        const which = args.which || 'main';
        const audit = await UiVerify.runUiAudit({
          which,
          selectors: args.selectors,
          checks: args.checks,
          maxIssues: 25
        });

        // 截图留证
        let shot = null;
        if (args.screenshot !== false) {
          shot = await UiVerify.captureAppWindow({ which });
          if (shot.success) lastScreenshotPath = shot.path;
        }

        // 视觉复核（配置了视觉模型才有）
        let vision = null;
        if (args.analyze !== false) {
          const question =
            (args.expect ? '本次改动期望达到的效果：' + args.expect + '\n\n' : '') +
            '请只针对界面缺陷做判断：有没有元素被裁掉/被遮挡、内容溢出被藏住、元素跑出窗口、排版错位、文字被截断、元素丢失？\n' +
            '第一行必须是结论，格式严格为「结论：通过」或「结论：不通过」，第二行起再分点说明你看到的证据（引用具体位置）。';
          vision = await analyzeImageWithVision({
            imagePath: shot && shot.success ? shot.path : lastScreenshotPath,
            question
          });
        }

        const issues = audit.success ? (audit.issues || []) : [];
        const highCount = issues.filter(i => i.severity === 'high').length;
        const midCount = issues.filter(i => i.severity === 'medium').length;
        const visionVerdict = vision && vision.success ? parseVisionVerdict(vision.analysis) : null;

        let verdict = 'pass';
        if (highCount > 0 || visionVerdict === 'fail') verdict = 'fail';
        else if (midCount > 0) verdict = 'warn';

        const lines = [];
        if (!audit.success) {
          lines.push('⚠️ 布局自检没能执行：' + audit.error);
        } else if (issues.length === 0) {
          lines.push('✅ 布局自检：未发现裁切 / 溢出 / 越界问题（扫描 ' + audit.scanned + ' 个可见元素）');
        } else {
          lines.push('❌ 布局自检发现 ' + issues.length + ' 个问题（严重 ' + highCount + ' / 中等 ' + midCount + '）');
          issues.slice(0, 6).forEach(i => lines.push('   - [' + i.type + '] ' + i.element + ' ' + i.detail));
        }
        if (vision) {
          if (vision.success) lines.push('👁 视觉复核（' + vision.provider + ' / ' + vision.model + '）：' +
            String(vision.analysis).split('\n').slice(0, 4).join(' / '));
          else lines.push('👁 视觉复核跳过：' + vision.error);
        }
        lines.push('→ 结论：' + (verdict === 'pass' ? '通过（pass）' : verdict === 'warn' ? '基本通过，存在中等问题（warn）' : '未通过（fail）'));

        return {
          success: true,   // 注意：这是「工具执行成功」，不是「验证通过」
          verdict,
          passed: verdict === 'pass',
          summary: lines.join('\n'),
          audit: audit.success ? {
            viewport: audit.viewport,
            scanned: audit.scanned,
            issueCount: audit.issueCount,
            byType: audit.byType,
            issues,
            truncated: audit.truncated,
            focus: audit.focus,
            badSelectors: audit.badSelectors,
            checksUsed: audit.checksUsed
          } : { error: audit.error },
          screenshot: shot && shot.success ? shot.path : null,
          vision: vision ? (vision.success
            ? { model: vision.model, provider: vision.provider, verdict: visionVerdict, analysis: vision.analysis }
            : { error: vision.error }) : null,
          next: verdict === 'pass'
            ? '验证通过，可以结束本轮并如实向用户汇报（附上截图路径）。'
            : '未通过：请按上面 issues/vision 的线索继续修改，改完再调用 verify_ui 复验，直到 verdict=pass。'
        };
      }
      case 'analyze_screenshot': {
        const imgPath = args.image_path || lastScreenshotPath;
        if (!imgPath) return { success: false, error: '没有可分析的截图，请先用 capture_window 或 verify_ui 截图' };
        const res = await analyzeImageWithVision({
          imagePath: imgPath,
          question: String(args.question || '请描述这张界面截图') +
            '\n第一行先给结论（格式：「结论：通过」或「结论：不通过」），第二行起分点说明依据。',
          providerId: args.provider_id,
          model: args.model
        });
        return { ...res, image: imgPath };
      }
      default:
        return { success: false, error: '未知工具: ' + name };
    }
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// 对话取消控制（统一：普通对话 + Agent）
let activeReq = null;
let chatCancelled = false;
function cancelChat() {
  chatCancelled = true;
  if (activeReq) { try { activeReq.destroy(); } catch(e) {} activeReq = null; }
}
function cancelAgentChat() { cancelChat(); }

// Agent 对话（支持工具调用循环 + 思考过程流式输出）
async function agentChat({ messages, providerId, temperature, maxTokens, thinkMode, enabledTools, autoAuthorize, roleId, systemPrompt: customSystemPrompt, contextWindow, workdir, conversationId }, broadcastFn) {
  chatCancelled = false;
  // 待办清单按会话隔离；前端没传时退化为 'default'（旧版本前端也能跑）
  const convCtx = { conversationId: conversationId || 'default' };
  const provider = findProvider(providerId);
  if (!provider) return { success: false, error: '未找到 AI 提供商配置' };
  cancelLocalModelUnload();
  cancelOllamaUnload();
  localRequestInFlight = true;
  // 本地模型启动/加载要几十秒：把进度推进对话气泡，替代干等的"等待模型响应…"
  const notReady = await prepareLocalProvider(provider, (msg) => {
    try { emit('agent-content', { text: '\n> ' + msg, iteration: 0 }); } catch (e) { /* 忽略 */ }
  });
    if (notReady) { localRequestInFlight = false; return notReady; }
  // 确保函数结束时清理活动请求，释放网络和GPU资源
  const cleanup = () => {
    try { if (activeReq) { activeReq.destroy(); activeReq = null; } } catch(e) {}
    localRequestInFlight = false;
    if (provider && provider.local) scheduleLocalModelUnload();
  };

  // 加载角色配置（多角色智能体）
  const role = getAgentRoleById(roleId);
  // 关键：在角色 systemPrompt 后追加通用工具调用强制要求，确保所有角色（含自定义角色）都能正确输出 tool_calls
  const basePrompt = customSystemPrompt || role.systemPrompt || AGENT_SYSTEM_PROMPT;
  const roleSystemPrompt = basePrompt + `

## 工具调用强制要求（所有角色必须遵守）
- 当你决定需要使用工具时，**必须实际输出 tool_calls 结构化数据**，绝对不能只在思考（reasoning）中描述"我要调用xx工具"而不实际输出
- 思考（reasoning）只是你的内部规划过程，不是工具调用本身。只在思考中描述工具调用不会执行任何工具
- 如果你在思考中决定要调用某个工具，就必须在回答中实际输出该工具的 tool_calls 结构化数据（包含 name 和 arguments）
- 工具调用格式：输出包含 function.name 和 function.arguments 的 tool_calls 数组，不要用文本描述代替`;
  // 项目工作目录：若用户选择了项目，在 system prompt 末尾告知 AI 所有相对路径/命令都在此目录内进行
  let finalSystemPrompt = roleSystemPrompt;
  if (workdir) {
    finalSystemPrompt += `

## 当前项目工作目录
- 你当前的工作目录（项目根）是：${workdir}
- 所有相对路径（如 src/xxx.js、./data）都基于此目录解析；读写文件、列目录、搜索文件时，未给绝对路径的一律相对于该目录。
- 执行命令（run_shell）时也默认在此目录下运行。
- 除非用户明确要求操作其他位置，否则不要把文件写到该目录之外。`;
  }
  // 长期记忆注入：按当前问题的相关度挑若干条塞进系统提示词，让 AI 不用每次重新问用户
  try {
    const memBlock = MemoryStore.buildPromptBlock(getLastUserMessage(messages));
    if (memBlock) {
      finalSystemPrompt += '\n\n' + memBlock;
      console.log('[Agent] 已注入长期记忆（' + MemoryStore.stats().total + ' 条中挑选）');
    }
  } catch (e) {
    console.warn('[Agent] 注入长期记忆失败:', e.message);
  }
  // 待办清单注入：让模型每一轮都能看到「整体目标 + 现在做到哪一步」，这是"保留实现过程"的关键
  try {
    const todoBlock = TodoStore.buildPromptBlock(convCtx.conversationId);
    if (todoBlock) {
      finalSystemPrompt += '\n\n' + todoBlock;
      console.log('[Agent] 已注入待办清单:', TodoStore.read(convCtx.conversationId).progress);
    }
  } catch (e) {
    console.warn('[Agent] 注入待办清单失败:', e.message);
  }
  const ALL_TOOL_NAMES = AGENT_TOOLS.map(t => t.function.name);
  const roleTools = (role.tools && role.tools.length > 0 ? role.tools : ALL_TOOL_NAMES)
    .filter(n => ALL_TOOL_NAMES.includes(n));
  // 后加的安全工具（记忆 / 界面自验证）对所有角色强制放开：
  // 老版本保存的自定义角色 tools 里没有这些名字，不做并集的话升级后它们永久不可见。
  TOOLS_ALWAYS_ALLOWED.forEach(n => {
    if (ALL_TOOL_NAMES.includes(n) && !roleTools.includes(n)) roleTools.push(n);
  });

  const temp = typeof temperature === 'number' ? temperature : (role.temperature || 0.7);
  const isOllama = provider.type === 'ollama';
  // token 上限：
  // - Ollama 模式：不自动提升，直接使用用户设置或默认值（Ollama 本地模型有自己的 token 管理，num_predict 默认 2048）
  // - 其他模式（API）：思考模式需要预留足够空间输出 tool_calls，默认提高到 8192；用户设置过低时强制提升
  let tokens;
  if (isOllama) {
    // Ollama 模式：不需要设置 max_tokens，不传递 num_predict，让 Ollama 使用自己的默认值
    // 用户显式设置了才传递，否则传 null 表示不设置
    tokens = maxTokens || null;
    console.log('[Agent] Ollama 模式，不设置 max_tokens，使用 Ollama 默认 num_predict');
  } else {
    // 其他模式：思考模式默认提高到 8192，预留足够空间输出思考和工具调用
    tokens = maxTokens || (thinkMode ? 8192 : 4096);
    // 安全兜底：思考模式下若用户设置过低（<2048），强制提升，避免思考耗尽 token 导致工具调用被截断
    if (thinkMode && tokens < 2048) tokens = 8192;
  }
  let accumulatedContent = '';
  // 根据设置过滤工具：优先用用户指定的 enabledTools，否则用角色配置的工具。
  // 注意：早期前端只暴露了 5 个工具，enabledTools 一旦非空就会把 web_search 等关键工具
  // 静默屏蔽掉，模型"有想法没工具"→ 反复重试 → 空输出。这里做三层兜底：
  // ① 过滤掉不存在的工具名；② 过滤后为空则回退角色工具；③ 运行时模型点名了已注册但未启用的工具，自动放行。
  // 工具权限策略：
  // - 无风险工具（只读/安全）：始终默认启用，不需要用户在设置中勾选
  // - 有风险工具：需要用户在设置中显式启用（enabledTools），且执行前需要确认
  const requestedTools = Array.isArray(enabledTools)
    ? enabledTools.filter(n => ALL_TOOL_NAMES.includes(n))
    : [];
  // 无风险工具 = 全部工具 - 有风险工具
  const safeToolNames = ALL_TOOL_NAMES.filter(n => !RISKY_TOOLS.has(n));
  // 有风险工具 = 用户显式启用的 ∩ 角色允许的
  const enabledRiskyTools = requestedTools.filter(n => RISKY_TOOLS.has(n) && roleTools.includes(n));
  // 最终启用的工具 = 无风险工具（角色允许的）+ 用户显式启用的有风险工具
  const activeToolNames = [
    ...safeToolNames.filter(n => roleTools.includes(n)),
    ...enabledRiskyTools
  ];
  let activeTools = AGENT_TOOLS.filter(t => activeToolNames.includes(t.function.name));
  if (activeTools.length === 0) {
    console.log('[Agent] 工具过滤后无可用工具，回退为角色工具:', roleTools.join(','));
    activeToolNames.length = 0;
    roleTools.forEach(n => activeToolNames.push(n));
    activeTools = AGENT_TOOLS.filter(t => activeToolNames.includes(t.function.name));
  }
  console.log('[Agent] 本次会话可用工具(' + activeTools.length + '):', activeToolNames.join(','));

  // 模型点名了已注册但当前未启用的工具 → 自动放行，避免"想用却用不了"的死循环
  const ensureToolEnabled = (name) => {
    if (!name || !ALL_TOOL_NAMES.includes(name)) return false;
    if (activeToolNames.includes(name)) return true;
    // 角色的工具范围仍然生效：角色明确排除的工具不自动放行
    if (!roleTools.includes(name)) {
      console.log('[Agent] 工具 ' + name + ' 不在当前角色允许范围内，拒绝自动启用');
      return false;
    }
    console.log('[Agent] 工具 ' + name + ' 未在启用列表中，按模型请求自动放行');
    activeToolNames.push(name);
    const def = AGENT_TOOLS.find(t => t.function.name === name);
    if (def) activeTools.push(def);
    emit('agent-content', { text: '\n> ⚙️ 自动启用工具 `' + name + '`（模型请求）', iteration });
    return true;
  };

  // 构建消息：角色系统提示词 + 历史（历史里 role=ai 需归一化为 assistant）
  const fullMessages = [{ role: 'system', content: finalSystemPrompt }, ...normalizeAgentMessages(messages)];

  const emit = (type, data) => {
    if (broadcastFn) broadcastFn('ai:response', { type, ...data, roleId: role.id });
  };

  let iteration = 0;
  const maxIterations = role.maxIterations || 8;
  let hasRetriedNoToolCalls = false; // 防止"只说不做"无限重试
  let hasRetriedMalformed = false;   // 防止"请求体不合法(400)"重试死循环
  let currentThinkMode = thinkMode; // 重试时可关闭 think 模式，强制模型直接输出 tool_calls
  // 待办收尾对账：本轮碰过待办清单（规划或推进过），交答案前必须让清单落地，
  // 否则模型干完活直接回答、清单停在 0/3 —— 用户看到的现象就是"做完了但不会画线结束"。
  let todoTouched = false;
  let todoReconciled = false;
  let toolExecutedLastIteration = false; // 上一轮是否执行了工具（用于判断模型回答是中间步骤还是最终答案）

  while (iteration < maxIterations) {
    if (chatCancelled) { emit('agent-done', { content: '(已停止)', iteration }); cleanup(); if (provider.type === 'ollama') unloadOllamaModel(provider); return { success: true, content: accumulatedContent, cancelled: true }; }
    iteration++;
    emit('agent-iteration', { iteration, maxIterations });

    // —— 上下文护栏：请求体估算超过窗口时，从最旧开始精简工具轮次，避免"越过限制思考回答" ——
    // 窗口由渲染层按模型识别/用户覆盖后传入；本进程看不到完整历史外的固定开销，预留输出 token 后
    // 以「窗口 − 输出预留 − 512」为输入上限。精简后仍放不下 → 明确报错，不再发必然被上游拒绝的请求。
    const ctxWindow = (typeof contextWindow === 'number' && contextWindow > 0) ? contextWindow : 0;
    if (ctxWindow > 0) {
      const outputReserve = provider.type === 'ollama' ? 0 : (tokens || 4096);
      const maxInputTokens = Math.max(512, ctxWindow - outputReserve - 512);
      let est = estimateMessagesTokens(fullMessages);
      if (est > maxInputTokens) {
        const removed = pruneHeadToolRounds(fullMessages, maxInputTokens);
        if (removed > 0) {
          console.log('[Agent] 上下文接近窗口上限：估算', est, 'tokens / 窗口', ctxWindow, '，已从头部精简', removed, '条工具轮次消息');
          emit('agent-content', { text: '\n> 上下文接近模型窗口上限，已自动精简较早的工具调用记录，继续执行...', iteration });
          est = estimateMessagesTokens(fullMessages);
        }
        if (est > maxInputTokens) {
          console.log('[Agent] 上下文超出窗口上限：估算', est, 'tokens / 窗口', ctxWindow, '，停止本轮 Agent 执行');
          emit('agent-done', { content: '上下文已超出模型窗口上限，无法继续执行。请新建会话或手动压缩上下文后重试。', iteration, error: true });
          cleanup();
          if (provider.type === 'ollama') unloadOllamaModel(provider);
          return { success: false, error: '上下文超出模型窗口上限' };
        }
      }
    }

    // 调用 API（带 tools）
    const result = await callProviderAPIWithTools(provider, fullMessages, temp, tokens, activeTools, currentThinkMode, (delta) => {
      if (chatCancelled) return;
      // 流式推送：思考过程 / 正文 / 工具调用
      if (delta.reasoning) emit('agent-reasoning', { text: delta.reasoning, iteration });
      if (delta.content) { accumulatedContent += delta.content; emit('agent-content', { text: delta.content, iteration }); }
      if (delta.toolCall) emit('agent-tool-call-start', { tool: delta.toolCall, iteration });
    });

    if (!result.success) {
      // 关键修复：错误/截断时必须广播结束事件，否则前端一直显示"等待模型响应..."
      const errMsg = result.error || 'AI 调用失败';
      console.log('[Agent] 调用失败:', errMsg);
      // 偶发 400（上游解析请求体失败，多为流式输出被截断后残留的半截工具参数）：
      // 丢弃最近一轮工具调用相关消息后重试一次，避免整段对话直接失败
      if (!hasRetriedMalformed && isMalformedRequestError(errMsg)) {
        hasRetriedMalformed = true;
        const removed = dropTailToolRound(fullMessages);
        if (removed > 0) {
          console.log('[Agent] 检测到请求体不合法(400)，已清理异常上下文消息数=' + removed + '，重试一次');
          emit('agent-content', { text: '\n> 上游拒绝了本次请求（上下文里存在不完整的工具参数），已清理异常上下文并自动重试...', iteration });
          iteration--; // 重试不占用迭代次数
          continue;
        }
      }
      emit('agent-content', { text: '\n\n> ⚠️ ' + errMsg, iteration });
      emit('agent-done', { content: errMsg, iteration, error: true });
      cleanup();
      if (provider.type === 'ollama') unloadOllamaModel(provider);
      return { success: false, error: errMsg };
    }

    // 把助手回复加入消息
    const assistantMsg = { role: 'assistant', content: result.content || '' };
    if (result.toolCalls && result.toolCalls.length > 0) {
      assistantMsg.tool_calls = result.toolCalls;
    }
    fullMessages.push(assistantMsg);

    // 没有工具调用
    if (!result.toolCalls || result.toolCalls.length === 0) {
      const reasoningText = result.reasoning || '';
      const contentText = result.content || '';
      // rawContent 是模型真正输出的正文；content 可能是"从思考末尾兜底提取"的、
      // 判断"模型有没有给出回答"必须用 rawContent，否则兜底文本会掩盖"没输出"的事实
      const realContent = (result.rawContent !== undefined ? result.rawContent : result.content) || '';
      // 关键修复：不能取数组末尾（那里是刚 push 的 assistant 消息），必须从后往前找真正的 user 消息
      const lastUserMsg = getLastUserMessage(fullMessages);

      // 手动执行一次"被识别出来的"工具调用：伪造 tool_calls 消息 → 执行 → 回灌结果
      const runExtractedTool = async (extracted, source) => {
        if (!extracted) return false;
        if (!ensureToolEnabled(extracted.name)) return false;
        fullMessages.pop(); // 移除刚 push 的 assistantMsg
        const fakeToolCallId = 'extracted_' + Date.now();
        // 关键：Ollama 的历史里 arguments 必须是对象（传字符串会导致下一次请求 400
        // "Value looks like object, but can't find closing '}'"），OpenAI 兼容接口则要求字符串
        const argsForHistory = provider.type === 'ollama' ? extracted.arguments : JSON.stringify(extracted.arguments);
        fullMessages.push({
          role: 'assistant',
          content: '',
          tool_calls: [{ id: fakeToolCallId, type: 'function', function: { name: extracted.name, arguments: argsForHistory } }]
        });
        emit('agent-tool-exec', { tool: extracted.name, args: extracted.arguments, iteration });
        emit('agent-content', { text: '\n> ' + source + '，正在执行 ' + extracted.name + '...', iteration });
        let toolResult;
        // 安全：走恢复链路执行的敏感工具（run_shell / write_file）同样要过用户确认，
        // 不能因为"是从文本里解析出来的"就绕过确认弹窗
        // 优化：用户显式勾选启用的风险工具（enabledRiskyTools）自动执行不弹窗，
        // 只有模型请求的未启用工具才需要确认
        const isUserEnabledRiskyTool = enabledRiskyTools.includes(extracted.name);
        if (!autoAuthorize && !isUserEnabledRiskyTool && TOOLS_REQUIRE_CONFIRM.has(extracted.name)) {
          const confirm = await requestToolConfirm(extracted.name, extracted.arguments, emit);
          if (!confirm.allowed) {
            toolResult = { success: false, error: '用户拒绝执行' + (confirm.reason ? '（' + confirm.reason + '）' : '') };
            emit('agent-tool-result', { tool: extracted.name, result: toolResult, iteration, denied: true });
            fullMessages.push({ role: 'tool', tool_call_id: fakeToolCallId, content: JSON.stringify(toolResult) });
            return true;
          }
        }
        try {
          const toolPromise = executeTool(extracted.name, extracted.arguments, workdir, convCtx);
          const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('工具执行超时(60s)')), 60000));
          toolResult = await Promise.race([toolPromise, timeoutPromise]);
        } catch (toolErr) {
          toolResult = { success: false, error: toolErr.message || '工具执行失败' };
        }
        console.log('[Agent] 手动执行工具结果:', extracted.name, 'success=', toolResult.success, (toolResult.error || '').substring(0, 100));
        fullMessages.push({ role: 'tool', tool_call_id: fakeToolCallId, content: JSON.stringify(toolResult) });
        emit('agent-tool-result', { tool: extracted.name, result: toolResult, iteration });
        return true;
      };

      // 方案A0：模型把 tool_calls 当普通文本写进了正文（提示词强制输出时最常见）→ 直接解析执行
      // 不限制迭代次数：只要模型确实写出了合法调用就应该执行
      let extracted = extractToolCallFromText(contentText, ALL_TOOL_NAMES);
      if (extracted && await runExtractedTool(extracted, '从回答中识别到工具调用')) continue;

      // 方案A：模型只在思考里说要调用但没输出（"只说不做"）→ 从思考/用户问题里推断
      const mentionedTools = activeToolNames.filter(name => reasoningText.includes(name));
      const actionWords = ['搜索', '查找', '查询', '抓取', '写入', '执行', '调用', '下载', '打开', '计算', '列出', '复制', '移动', '创建', '读取', '检查', '获取'];
      const mentionedAction = actionWords.some(w => reasoningText.includes(w));
      const mentionedCallIntent = /调用|执行|使用|search|fetch|write|read|shell|tool/i.test(reasoningText);
      let inferredTool = mentionedTools[0] || '';
      if (!inferredTool) {
        if (/搜索|查找|查询|最新|资讯|百科/i.test(reasoningText) || /搜索|查找|查询|最新|资讯|百科/i.test(lastUserMsg)) inferredTool = 'web_search';
        else if (/抓取|网页|链接|url|http/i.test(reasoningText)) inferredTool = 'web_fetch';
        else if (/写入|文件|代码|脚本|保存/i.test(reasoningText)) inferredTool = 'write_file';
        else if (/执行|命令|运行|shell|cmd/i.test(reasoningText)) inferredTool = 'run_shell';
        else if (/读取|查看|内容|文件/i.test(reasoningText)) inferredTool = 'read_file';
      }
      // 只有在模型确实"没给出可用回答"时才去推断工具：
      // ① 正文为空；② 正文是推脱/表示做不到（此时手里明明有工具，应该代替它执行）。
      // 否则模型已经给出了正式回答，不该再强行插一次工具调用。
      const looksLikeInability = /无法(直接)?(访问|搜索|获取|打开|联网|读取)|不能(直接)?(访问|搜索|获取)|没法|抱歉|请自行|建议您|建议通过|自己(搜索|查(找|询)?)|没有权限|不支持|暂不|没有相关工具/.test(contentText);
      const noUsableAnswer = !realContent.trim() || looksLikeInability;
      const shouldRetryNoToolCalls = noUsableAnswer && !hasRetriedNoToolCalls && iteration <= 2
        && (mentionedTools.length > 0 || mentionedAction || mentionedCallIntent) && inferredTool;

      if (shouldRetryNoToolCalls) {
        let inferred = null;
        // 优先从思考里提取模型自己拟好的关键词（通常更精准，如 “影视飓风官网”）
        if (inferredTool === 'web_search') {
          inferred = extractToolCallFromReasoning(reasoningText, lastUserMsg);
          if (inferred) console.log('[Agent] 从思考中提取到工具调用:', inferred.name, JSON.stringify(inferred.arguments).substring(0, 200));
        }
        // 兜底：拿用户原始问题当搜索词（这一步过去因为 lastUserMsg 取错而一直失效）
        if (!inferred && inferredTool === 'web_search' && lastUserMsg && lastUserMsg.length >= 2) {
          // 只去掉首尾的客套词，保留核心关键词（过度清洗会把"影视飓风的官网"洗成"影视飓风出来"）
          let searchQuery = lastUserMsg
            .replace(/^(帮我|请|麻烦|我想|我想要|请问|能不能|可以)+/i, '')
            .replace(/(给我|一下|呢|吧|啊|谢谢| thanks)+$/i, '')
            .replace(/[？?。.！!~～,，、\s]+$/, '')
            .trim();
          if (searchQuery.length < 2) searchQuery = lastUserMsg;
          if (searchQuery.length > 50) searchQuery = searchQuery.substring(0, 50);
          inferred = { name: 'web_search', arguments: { query: searchQuery, max_results: 5 } };
          console.log('[Agent] 直接用用户问题构造 web_search：', lastUserMsg.substring(0, 100), '→', searchQuery);
        }
        if (!inferred && inferredTool !== 'web_search') {
          inferred = extractToolCallFromReasoning(reasoningText, lastUserMsg);
          if (inferred) console.log('[Agent] 从思考中提取到工具调用:', inferred.name, JSON.stringify(inferred.arguments).substring(0, 200));
        }
        if (inferred && await runExtractedTool(inferred, '从思考中识别到工具调用')) continue;
      }

      // 方案B：仍拿不到可执行的调用 → 退回到重试（关闭思考模式 + 强制要求输出 tool_calls）
      if (shouldRetryNoToolCalls) {
        hasRetriedNoToolCalls = true;
        console.log('[Agent] 检测到模型"只说不做"：推断工具=' + inferredTool + ' content=' + contentText.length + '字符 reasoning=' + reasoningText.length + '字符，自动重试一次');
        fullMessages.pop();
        const toolExample = inferredTool === 'web_search'
          ? '{"name":"web_search","arguments":{"query":"搜索关键词"}}'
          : inferredTool === 'web_fetch'
          ? '{"name":"web_fetch","arguments":{"url":"https://example.com"}}'
          : inferredTool === 'write_file'
          ? '{"name":"write_file","arguments":{"path":"C:\\\\Users\\\\用户名\\\\Desktop\\\\file.txt","content":"文件内容"}}'
          : inferredTool === 'run_shell'
          ? '{"name":"run_shell","arguments":{"command":"dir"}}'
          : '{"name":"' + inferredTool + '","arguments":{}}';
        fullMessages.push({
          role: 'user',
          content: '【强制要求】你刚才只在思考中描述了要执行操作，但没有实际输出 tool_calls！\n\n现在思考模式已关闭，你必须直接输出 tool_calls 结构化数据，不要输出任何文本描述，不要输出思考摘要，不要说"我要调用xx工具"。\n\n立即输出以下格式的 tool_calls（这是唯一正确的响应方式）：\n' + toolExample
        });
        // 关键：重试时关闭 think 模式，强制模型直接输出 tool_calls（qwen3小模型在think模式下倾向于只描述不输出）
        if (currentThinkMode) {
          currentThinkMode = false;
          console.log('[Agent] 重试时已关闭 think 模式，强制模型直接输出 tool_calls');
        }
        emit('agent-content', { text: '\n> 检测到模型未实际调用工具，自动重试（已关闭思考模式，强制输出 tool_calls）...', iteration });
        continue;
      }

      // 边界情况：有思考过程但没有正文也没有工具调用（模型"想了但没做"）
      // 注意：callProviderAPIWithTools 已尝试从 thinking 末尾兜底提取回答到 result.content
      if (!result.content || !result.content.trim()) {
        const noToolHint = activeTools.length === 0
          ? '当前没有任何可用工具（设置里的「启用工具」为空），请在对话设置中至少启用 web_search 等工具后重试。'
          : '';
        const hint = noToolHint
          || (result.reasoning && result.reasoning.length > 50
            ? '模型完成思考但未输出回答或工具调用（finishReason=' + (result.finishReason || 'unknown') + '）。常见原因：所需工具未启用、token 上限不足或模型不支持工具调用。可在设置中开启「思考模式」、启用 web_search 等工具后重试。'
            : '模型未返回有效内容（finishReason=' + (result.finishReason || 'unknown') + '）。请重试；若频繁出现，请在设置中开启「思考模式」或增大最大 Token。');
        console.log('[Agent] 无正文无工具调用，finishReason=' + result.finishReason + ' reasoning=' + (result.reasoning || '').length + '字符 totalLines=' + result.totalLines + ' 可用工具=' + activeTools.length);
        emit('agent-content', { text: '\n\n> ' + hint, iteration });
        emit('agent-done', { content: hint, iteration, usage: result.usage });
        cleanup();
        if (provider.type === 'ollama') unloadOllamaModel(provider);
        return { success: true, content: hint, iterations: iteration, empty: true };
      }
      // ---- 待办收尾对账（"做完了但清单不会画线结束"的根治点）----
      // 模型很容易规划完就闷头干活、干完直接给答案而忘了更新清单；不能指望它记得，交答案前卡一道：
      // 本轮碰过待办且还有未完成项 → 退回一轮，要求它先按事实把清单落地（完成 / 或说明为什么没做）。
      if (todoTouched && !todoReconciled) {
        const pending = TodoStore.read(convCtx.conversationId).items.filter(i => i.status !== 'completed');
        if (pending.length) {
          todoReconciled = true;
          const listText = pending.map(i => '- ' + i.id + ' ' + i.text).join('\n');
          console.log('[Agent] 待办收尾对账：还有', pending.length, '条未完成，要求模型先更新清单');
          emit('agent-content', { text: '\n> 待办清单还有 ' + pending.length + ' 条未标记完成，先对账再收尾...', iteration });
          // 把"已经说出口的答案"补成 assistant 消息，保持对话结构正常（避免连续两条 user）
          fullMessages.push({ role: 'assistant', content: result.content || '（继续）' });
          fullMessages.push({
            role: 'user',
            content: '【收尾检查】你还没更新待办清单，下面这些条目的状态与事实不符：\n' + listText +
              '\n\n请立刻用 todo_update 逐条处理：真的做完了就标记 status=completed 并在 note 写清结果/证据；' +
              '没做或没做完的保持 pending 并在 note 写明原因，不要谎报完成。' +
              '处理完（可以一次调多个 todo_update）再给最终答复。'
          });
          continue;
        }
      }
      // —— 工具执行后模型只输出文本没有 tool_calls：判断是中间步骤还是最终答案 ——
      // 本地模型/Ollama 常把"下一步要做什么"写成文本而不是结构化 tool_calls，
      // 如果刚执行过工具且回答较短/含继续意图，注入提示要求继续输出工具调用。
      if (toolExecutedLastIteration && iteration < maxIterations - 1) {
        const intermediatePatterns = /(接下来|下一步|然后|现在|让我|我需要|我将|需要继续|还需要|再|接着|随后|首先|其次|最后|let me|next|then|now|i need|i will|continue|further|also|additionally)/i;
        const isIntermediate = intermediatePatterns.test(contentText) && contentText.length < 500;
        const hasNoFinalAnswer = !/(总结|综上|因此|所以|最终|完成|好了|以上就是|希望|in summary|to summarize|therefore|finally|done|complete)/i.test(contentText);
        if (isIntermediate && hasNoFinalAnswer) {
          console.log('[Agent] 检测到工具执行后的中间步骤回答（' + contentText.length + '字符），注入继续提示');
          fullMessages.push({
            role: 'user',
            content: '你刚才执行了工具并得到了结果。如果任务还未完成，请直接输出下一个 tool_calls 结构化数据（包含 name 和 arguments），不要只输出文本描述。如果任务已经完成，请给出最终答案。'
          });
          emit('agent-content', { text: '\n> 检测到中间步骤，要求模型继续执行...', iteration });
          continue;
        }
      }
      emit('agent-done', { content: result.content, iteration, usage: result.usage });
      cleanup();
      if (provider.type === 'ollama') unloadOllamaModel(provider);
      return { success: true, content: result.content, iterations: iteration };
    }

    toolExecutedLastIteration = false;
    // 执行工具调用
    for (const tc of result.toolCalls) {
      const fnName = (tc.function?.name || '').trim();
      // 工具名校验：必须是已注册的工具，避免模型输出多个工具名拼接等异常。
      // 已注册但未启用的工具按模型请求自动放行，避免"模型想用、列表里没有"直接失败。
      if (fnName && ALL_TOOL_NAMES.includes(fnName) && !activeToolNames.includes(fnName)) ensureToolEnabled(fnName);
      const validToolNames = activeTools.map(t => t.function.name);
      if (!fnName || !validToolNames.includes(fnName)) {
        console.log('[Agent] 跳过无效工具调用:', fnName, '，可用:', validToolNames.join(','));
        fullMessages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: JSON.stringify({ success: false, error: '未知工具: ' + fnName + '，可用工具: ' + validToolNames.join(', ') })
        });
        continue;
      }
      // 本轮动过待办清单 → 收尾时要对账（见下面"待办收尾对账"）
      if (fnName === 'todo_write' || fnName === 'todo_update') todoTouched = true;
      let fnArgs = {};
      const rawArgs = tc.function?.arguments;
      if (rawArgs && typeof rawArgs === 'object') {
        // Ollama 格式：arguments 已经是对象
        fnArgs = rawArgs;
      } else if (typeof rawArgs === 'string' && rawArgs.trim()) {
        // OpenAI 格式：arguments 是 JSON 字符串
        try { 
          fnArgs = JSON.parse(rawArgs); 
        } catch(e) { 
          console.log('[Agent] arguments JSON 解析失败，尝试修复:', rawArgs.substring(0, 100));
          // 先按"半截 JSON"修复（补未闭合引号/括号），再退回常见的引号、多余逗号修复
          let fixed = repairTruncatedJson(rawArgs);
          if (!fixed) fixed = rawArgs.replace(/'/g, '"').replace(/,\s*}/g, '}').replace(/,\s*]/g, ']');
          try {
            fnArgs = JSON.parse(fixed);
            tc._argsIncomplete = true;
          } catch(e2) {
            fnArgs = {};
            tc._argsIncomplete = true;
            emit('agent-tool-result', { tool: fnName, result: { success: false, error: '工具参数解析失败: ' + rawArgs.substring(0,200) }, iteration });
          }
        }
    toolExecutedLastIteration = true;
    continue; // 工具执行完毕，回到循环让模型根据结果决定下一步
      }
      if (tc._argsIncomplete) {
        // 参数被截断/修复过：必须让用户知道，风险工具一律重新确认，避免拿残缺参数执行写文件/跑命令
        console.log('[Agent] 警告: 工具参数不完整（已尽力修复）:', fnName, JSON.stringify(fnArgs).substring(0, 120));
        emit('agent-content', { text: '\n> 模型输出被截断，' + fnName + ' 的参数不完整（已自动补全），请核对后再执行。', iteration });
      }
      console.log('[Agent] 工具调用:', fnName, '参数:', JSON.stringify(fnArgs).substring(0, 200));

      emit('agent-tool-exec', { tool: fnName, args: fnArgs, iteration });

      // 需要用户确认的工具
      let toolResult;
      // 优化：用户显式勾选启用的风险工具自动执行不弹窗；但参数被截断过时必须重新确认
        const isUserEnabledRiskyTool2 = enabledRiskyTools.includes(fnName);
        const needConfirm = TOOLS_REQUIRE_CONFIRM.has(fnName)
          && ((!autoAuthorize && !isUserEnabledRiskyTool2) || tc._argsIncomplete);
        if (needConfirm) {
        const confirm = await requestToolConfirm(fnName, fnArgs, emit);
        if (!confirm.allowed) {
          toolResult = { success: false, error: '用户拒绝执行' + (confirm.reason ? '（' + confirm.reason + '）' : '') };
          emit('agent-tool-result', { tool: fnName, result: toolResult, iteration, denied: true });
          fullMessages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: JSON.stringify(toolResult)
          });
          continue;
        }
      }

      // 为工具执行添加超时保护（最长60秒），避免工具挂起导致整个对话卡死
      const toolTimeoutMs = 60000;
      const toolStartTime = Date.now();
      // 心跳：每5秒推送一次工具执行状态，避免前端显示"暂停"
      const heartbeatInterval = setInterval(() => {
        emit('agent-tool-progress', { tool: fnName, elapsed: Date.now() - toolStartTime, iteration });
      }, 5000);
      
      try {
        toolResult = await Promise.race([
          executeTool(fnName, fnArgs, workdir, convCtx),
          new Promise(resolve => setTimeout(() => resolve({ 
            success: false, 
            error: `工具执行超时（${toolTimeoutMs/1000}秒），已自动终止。请检查命令是否需要交互输入、网络连接或文件权限。` 
          }), toolTimeoutMs))
        ]);
      } catch (toolErr) {
        toolResult = { success: false, error: '工具执行异常: ' + (toolErr.message || String(toolErr)) };
      } finally {
        clearInterval(heartbeatInterval);
      }
      
      const toolDuration = Date.now() - toolStartTime;
      console.log('[Agent] 工具执行完成:', fnName, '耗时:', toolDuration + 'ms', '成功:', toolResult.success);
      emit('agent-tool-result', { tool: fnName, result: toolResult, iteration, duration: toolDuration });

      // 工具结果加入消息
      fullMessages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: JSON.stringify(toolResult)
      });
    }
  }

  emit('agent-done', { content: '（已达到最大迭代次数，停止执行）', iteration });
  cleanup();
  // 主动卸载 Ollama 模型，释放 GPU 显存
  if (provider.type === 'ollama') unloadOllamaModel(provider);
  return { success: true, content: fullMessages[fullMessages.length - 1]?.content || '', iterations: iteration, truncated: true };
}

// 主动从 GPU 显存卸载 Ollama 模型（keep_alive:0 有时不会立即生效，主动调用更保险）
// Ollama 延迟卸载：回答结束后 5 分钟无新请求才卸载，避免持续对话反复加载
let ollamaUnloadTimer = null;
const OLLAMA_UNLOAD_DELAY_MS = 5 * 60 * 1000;
function cancelOllamaUnload() {
  if (ollamaUnloadTimer) { clearTimeout(ollamaUnloadTimer); ollamaUnloadTimer = null; }
}
function unloadOllamaModelImmediate(provider) {
  try {
    const baseUrl = (provider.apiUrl || 'http://localhost:11434').replace(/\/$/, '');
    const body = JSON.stringify({ model: provider.model, keep_alive: 0, stream: false });
    const url = new URL(baseUrl + '/api/generate');
    const client = url.protocol === 'https:' ? https : http;
    const req = client.request({
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, () => {});
    req.on('error', () => {});
    req.setTimeout(3000, () => { try { req.destroy(); } catch(e) {} });
    safeWriteRequest(req, body);
    console.log('[Agent] 已请求卸载 Ollama 模型:', provider.model);
  } catch (e) {
    console.log('[Agent] 卸载模型失败:', e.message);
  }
}
function unloadOllamaModel(provider) {
  cancelOllamaUnload();
  ollamaUnloadTimer = setTimeout(() => {
    ollamaUnloadTimer = null;
    if (localRequestInFlight) { unloadOllamaModel(provider); return; }
    unloadOllamaModelImmediate(provider);
  }, OLLAMA_UNLOAD_DELAY_MS);
}

// 手动释放 GPU 显存：卸载所有已配置的 Ollama 模型（用户可在设置中点击触发）
function releaseGPUMemory() {
  let count = 0;
  if (aiConfig?.cloudProviders) {
    for (const p of aiConfig.cloudProviders) {
      if (p.type === 'ollama' && p.model) {
        unloadOllamaModelImmediate(p);
        count++;
      }
    }
  }
  console.log('[Agent] 手动释放 GPU 显存，已请求卸载', count, '个 Ollama 模型');
  return { success: true, unloaded: count };
}

// ==================== 请求体健壮性（防"Unterminated string"类 400） ====================
// 背景：模型流式输出被 token 上限截断或连接中断时，累积到的 tool_calls.arguments 可能是半截
// JSON（如 '{"query":"影视飓风 2025'）。这些残缺参数会被原样写回对话历史，下一次请求上游
// 解析该字符串就会失败 → HTTP 400 "Unterminated string starting at: line 1 column 65 (char 64)"
// （偶现：只在特定截断轮次出现）。因此：① 修复半截 JSON；② 每次请求前统一消毒 messages；
// ③ 无法修复的参数降级为空对象，绝不让非法 JSON 进入请求体。

// 补全未闭合的引号/括号（不保证语义正确，只保证结果是合法 JSON）
function closeOpenStructures(str) {
  let out = '';
  const stack = [];
  let inStr = false;
  let esc = false;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (esc) { out += ch; esc = false; continue; }
    if (ch === '\\') { out += ch; if (inStr) esc = true; continue; }
    if (ch === '"') { out += ch; inStr = !inStr; continue; }
    out += ch;
    if (inStr) continue;
    if (ch === '{' || ch === '[') stack.push(ch);
    else if (ch === '}' || ch === ']') stack.pop();
  }
  if (esc) out = out.slice(0, -1);                                  // 末尾孤立的反斜杠
  if (inStr) out += '"';                                            // 未闭合的字符串
  out = out.replace(/[,\s]+$/, '');                                 // 悬挂的逗号
  if (/:\s*$/.test(out)) out = out.replace(/:\s*$/, ':null');       // 悬挂的冒号
  while (stack.length) out += (stack.pop() === '{' ? '}' : ']');     // 补齐括号
  return out;
}

// 把半截 JSON 字符串修复成合法 JSON 字符串；无法修复返回 null
function repairTruncatedJson(src) {
  const raw = String(src == null ? '' : src).trim();
  if (!raw) return null;
  try { JSON.parse(raw); return raw; } catch (_) { /* 继续修复 */ }
  // 先只补全结构；仍失败则逐个裁掉尾部字符重试（应对 '...{"a":tru' 这类半截字面量）
  for (let i = 0; i < 80 && raw.length - i > 1; i++) {
    const cand = closeOpenStructures(i === 0 ? raw : raw.slice(0, raw.length - i));
    try { JSON.parse(cand); return cand; } catch (_) { /* 再裁一个字符 */ }
  }
  return null;
}

// 统一工具调用 arguments 形态：OpenAI 兼容=合法 JSON 字符串；Ollama=对象
// 返回 'ok' | 'repaired' | 'broken'；非 ok 时打上 _argsIncomplete 标记供上层提醒用户
function normalizeToolCallArgs(tc, isOllama) {
  if (!tc || !tc.function) return 'broken';
  const args = tc.function.arguments;
  if (args && typeof args === 'object') {
    tc.function.arguments = isOllama ? args : JSON.stringify(args);
    return 'ok';
  }
  if (typeof args !== 'string' || !args.trim()) {
    tc.function.arguments = isOllama ? {} : '{}';
    return 'ok';
  }
  try {
    const obj = JSON.parse(args);
    // Ollama 的历史要求 arguments 是对象，传 JSON 字符串同样会 400
    if (isOllama && obj && typeof obj === 'object') tc.function.arguments = obj;
    return 'ok';
  } catch (_) { /* 半截 JSON，走修复 */ }
  const fixed = repairTruncatedJson(args);
  if (fixed) {
    tc.function.arguments = isOllama ? JSON.parse(fixed) : fixed;
    tc._argsIncomplete = true;
    return 'repaired';
  }
  tc.function.arguments = isOllama ? {} : '{}';
  tc._argsIncomplete = true;
  return 'broken';
}

// 发送前消毒 messages：半截工具参数、孤立代理项、缺失/孤立的工具响应都会让上游 400
function sanitizeOutgoingMessages(messages, isOllama) {
  if (!Array.isArray(messages)) return messages;
  const notes = [];
  const cleaned = [];
  let remap = null; // 仅在"重命名了重复 id"后，用于同步改写紧随其后的 tool 消息
  for (const m of messages) {
    if (!m || typeof m !== 'object' || typeof m.role !== 'string') continue;
    const msg = { ...m };
    // content 必须是字符串（对象会被上游拒绝）；顺带剔除孤立代理项与 NUL
    if (msg.content !== null && msg.content !== undefined && typeof msg.content !== 'string') {
      msg.content = typeof msg.content === 'object' ? JSON.stringify(msg.content) : String(msg.content);
    }
    if (typeof msg.content === 'string') {
      const before = msg.content;
      msg.content = msg.content
        .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, '')
        .replace(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '')
        .replace(/\u0000/g, '');
      if (before !== msg.content) notes.push('content-sanitized');
    }
    if (msg.role === 'tool' && remap && msg.tool_call_id && remap.has(msg.tool_call_id)) {
      msg.tool_call_id = remap.get(msg.tool_call_id);
    } else if (msg.role !== 'tool') {
      remap = null;
    }
    if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
      const kept = [];
      // 注意：id 只在"同一条消息内"去重。不同轮次复用 'call_0' 这类回退 id 是正常现象，
      // 跨消息去重会打断 id 与工具结果的配对，反而制造孤立 tool 消息。
      const seenIds = new Set();
      for (const tc of msg.tool_calls) {
        if (!tc || !tc.function || !tc.function.name) { notes.push('drop-empty-toolcall'); continue; }
        let id = (typeof tc.id === 'string' && tc.id.trim()) ? tc.id : 'call_' + kept.length;
        if (seenIds.has(id)) {
          const newId = id + '_' + seenIds.size;
          remap = remap || new Map();
          remap.set(id, newId);
          notes.push('dup-toolcall-id');
          id = newId;
        }
        tc.id = id;
        tc.type = 'function';
        seenIds.add(id);
        const st = normalizeToolCallArgs(tc, isOllama);
        if (st !== 'ok') notes.push('args-' + st + ':' + tc.function.name);
        kept.push(tc);
      }
      if (kept.length) msg.tool_calls = kept;
      else { delete msg.tool_calls; remap = null; }
    }
    cleaned.push(msg);
  }
  // 上游要求：assistant 的每个 tool_call_id 后面必须跟一条对应 tool 消息，缺了就补，否则 400
  const out = [];
  for (let i = 0; i < cleaned.length; i++) {
    out.push(cleaned[i]);
    const ids = (cleaned[i].tool_calls || []).map(tc => tc.id).filter(Boolean);
    if (!ids.length) continue;
    const answered = new Set();
    for (let j = i + 1; j < cleaned.length && cleaned[j].role === 'tool'; j++) {
      if (cleaned[j].tool_call_id) answered.add(cleaned[j].tool_call_id);
    }
    for (const id of ids) {
      if (answered.has(id)) continue;
      out.push({ role: 'tool', tool_call_id: id, content: JSON.stringify({ success: false, error: '（该工具调用未返回结果，已自动补齐占位）' }) });
      notes.push('fill-tool-result');
    }
  }
  // 丢弃找不到对应工具调用的孤立 tool 消息（上游同样会 400）
  const finalMsgs = out.filter((m, idx) => {
    if (m.role !== 'tool') return true;
    for (let j = idx - 1; j >= 0; j--) {
      const tcs = out[j].tool_calls;
      if (tcs && tcs.length) return tcs.some(tc => tc.id === m.tool_call_id);
      if (out[j].role === 'user') break;
    }
    notes.push('drop-orphan-tool-msg');
    return false;
  });
  if (notes.length) console.log('[Agent] 请求体消毒:', notes.slice(0, 8).join(','), '(共' + notes.length + '处)');
  return finalMsgs;
}

// 判断是否为"请求体不合法"类 400（上游/中转解析请求 JSON 失败）
function isMalformedRequestError(errMsg) {
  if (!errMsg) return false;
  return /Unterminated string|BadRequestError|forward bad request|invoke model error|invalid_request_error|HTTP 400/i.test(String(errMsg));
}

// 估算一组消息的 token（与 approxTokens 同一口径，含角色/字段开销）
function estimateMessagesTokens(messages) {
  if (!Array.isArray(messages)) return 0;
  let t = 0;
  for (const m of messages) {
    if (!m || typeof m !== 'object') continue;
    t += approxTokens(m.content || '') + 8;
    if (Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        t += approxTokens(tc?.function?.arguments || '') + 12;
      }
    }
  }
  return t;
}

// 从消息数组头部丢弃"assistant(带 tool_calls) + 其后 tool 结果"整轮，直到估算 ≤ maxTokens。
// 用于 Agent 循环内上下文护栏：历史（含工具结果）逼近窗口上限时，较早的工具轮次已无保留价值，
// 整轮删除（assistant + tool 成对）不会破坏后续 tool_call_id 的配对关系。
// 返回实际移除的消息条数；0 表示没有可清理的工具轮次。
function pruneHeadToolRounds(messages, maxTokens) {
  if (!Array.isArray(messages) || messages.length <= 2) return 0;
  let removed = 0;
  let guard = 0;
  while (messages.length > 2 && estimateMessagesTokens(messages) > maxTokens && guard++ < 20) {
    // 找第一处"assistant 带 tool_calls"（跳过首条 system 与最新的对话，从头部开始）
    let start = -1;
    for (let i = 1; i < messages.length; i++) {
      const m = messages[i];
      if (m && m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) { start = i; break; }
    }
    if (start < 0) break; // 没有可丢弃的工具轮次
    let end = start + 1;
    while (end < messages.length && messages[end] && messages[end].role === 'tool') end++;
    const n = Math.max(1, end - start);
    messages.splice(start, n);
    removed += n;
  }
  return removed;
}

// 从历史尾部丢弃"最近一轮工具调用"相关消息（tool 结果 + 带 tool_calls 的 assistant 消息），
// 返回实际移除的消息数；返回 0 表示当前上下文里没有可清理的工具调用轮次
function dropTailToolRound(messages) {
  if (!Array.isArray(messages) || !messages.length) return 0;
  let removed = 0;
  while (messages.length && messages[messages.length - 1].role === 'tool') {
    messages.pop();
    removed++;
  }
  const tail = messages[messages.length - 1];
  if (tail && tail.role === 'assistant' && Array.isArray(tail.tool_calls) && tail.tool_calls.length) {
    messages.pop();
    removed++;
  }
  return removed;
}

// 混合思考模型（默认会/可以输出思考过程的那些）
const HYBRID_THINK_MODEL_RE = /qwen3|qwq|deepseek-r1|deepseek-v3\.1|glm-z1|glm-4\.5|hunyuan-t1|kimi-k2|minimax-m1|step-3/i;

function isLocalEndpoint(provider) {
  if (provider && provider.local) return true;
  try {
    const h = new URL(provider?.apiUrl || '').hostname.toLowerCase();
    return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '0.0.0.0' ||
      /^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h) || /\.local$/.test(h);
  } catch (e) { return false; }
}

/**
 * 思考模式的请求参数。
 * ⚠️ 各家**默认几乎都是关思考**，不显式打开就永远看不到思考过程（"本地 llama.cpp 不显示思考过程"的根因就在这）：
 * - llama.cpp / vLLM / SGLang：`chat_template_kwargs.enable_thinking = true`（llama-server 服务 Qwen3 时默认 false）
 * - 阿里云百炼 / DashScope 兼容模式：顶层 `enable_thinking = true`
 * 只对「本地端点」或「已知混合思考模型」下发，避免给严格的云端接口塞未知字段导致 400。
 */
// 哪些提供商支持 stream_options.include_usage（不支持的发了会 400）
function supportsStreamOptions(provider) {
  const t = String(provider?.type || '').toLowerCase();
  // OpenAI 原生、DeepSeek、智谱、月之暗面、OpenAI 兼容自定义 通常支持；
  // 百炼 DashScope、腾讯混元、百度千帆、火山引擎 等兼容层不一定支持，不发
  return ['openai', 'deepseek', 'zhipu', 'moonshot', 'anthropic'].includes(t);
}

function thinkingParams(provider, thinkMode) {
  if (!thinkMode) return {};
  const local = isLocalEndpoint(provider);
  if (local) {
    // llama.cpp / llama-server：只通过 chat_template_kwargs 控制思考，顶层字段会被忽略或报错
    return { chat_template_kwargs: { enable_thinking: true } };
  }
  // 云端：只有百炼 DashScope 明确支持顶层 enable_thinking；
  // 其他厂商（火山引擎、腾讯混元、百度等）发了会 400，即使模型名匹配也不发
  const t = String(provider?.type || '').toLowerCase();
  if (t === 'dashscope' && HYBRID_THINK_MODEL_RE.test(String(provider?.model || ''))) {
    return { enable_thinking: true };
  }
  return {};
}

// 带 tools 的 API 调用（流式，支持 reasoning_content 和 tool_calls）
function callProviderAPIWithTools(provider, messages, temperature, maxTokens, tools, thinkMode, onStreamChunk) {
  return new Promise((resolve) => {
    const isOllama = provider.type === 'ollama';
    messages = sanitizeOutgoingMessages(messages, isOllama);
    const apiUrl = isOllama ? provider.apiUrl.replace(/\/$/, '') + '/api/chat' : provider.apiUrl;
    const url = new URL(apiUrl);
    const isHttps = url.protocol === 'https:';
    const client = isHttps ? https : http;

    const useTools = tools && tools.length > 0 ? tools : AGENT_TOOLS;
    console.log('[Agent] callProviderAPIWithTools - isOllama:', isOllama, 'thinkMode:', thinkMode, 'tools count:', useTools.length);
    // Ollama：显式设置足够大的上下文窗口（默认仅2048~4096，装不下19个工具定义+系统提示词，会导致模型看不到工具而不调用）
    // keep_alive: 0 表示响应完成后立即从GPU显存卸载模型，避免长时间占用导致卡顿
    // Ollama 模式：只有显式设置了 maxTokens 才传递 num_predict，否则让 Ollama 使用默认值
    const ollamaOptions = { temperature, num_ctx: 32768 };
    if (maxTokens != null) ollamaOptions.num_predict = maxTokens;
    const thinkParams = thinkingParams(provider, thinkMode);
    const bodyObj = isOllama
      ? { model: provider.model, messages, tools: useTools, stream: true, think: !!thinkMode, keep_alive: 0, options: ollamaOptions }
      : (() => {
          const b = { model: provider.model, messages, tools: useTools, temperature, stream: true, ...thinkParams };
          if (maxTokens != null) b.max_tokens = maxTokens;
          // tool_choice 仅在有工具时发送，部分 API（火山引擎等）不支持该字段会 400
          if (useTools && useTools.length > 0) b.tool_choice = 'auto';
          // stream_options 仅发给支持的提供商
          if (supportsStreamOptions(provider)) b.stream_options = { include_usage: true };
          return b;
        })();
    if (!isOllama && thinkMode) {
      console.log('[Agent] 思考模式请求参数:', JSON.stringify(thinkParams), '（本地端点=' + isLocalEndpoint(provider) + '）');
    }
    const body = JSON.stringify(bodyObj);

    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body)
    };
    if (provider.apiKey) headers['Authorization'] = `Bearer ${provider.apiKey}`;

    const options = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname.replace(/\/$/, '') + (url.search || ''),
      method: 'POST',
      headers
    };

    const req = client.request(options, (res) => {
      activeReq = req;
      let fullContent = '';
      let fullReasoning = '';
      let toolCalls = [];
      let buffer = '';
      let finishReason = null;
      let totalLines = 0;
      // content 里可能混着内联思考（llama.cpp --reasoning-format none 启动时）。
      // 拆标签的逻辑抽到 agentToolUtils.createInlineThinkSplitter —— 可单测：
      // 跨 chunk 的标签、多种闭合标签（ASCII / 全角）、以及"尾巴长度为 0 时不能重复吐字"。
      const thinkSplitter = createInlineThinkSplitter();
      const lastRawLines = [];
      let streamUsage = null; // 保留最后12行原始内容，用于诊断"思考完无输出"问题

      if (res.statusCode < 200 || res.statusCode >= 300) {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => resolve({ success: false, error: simplifyApiError(res.statusCode, data), statusCode: res.statusCode }));
        return;
      }

      // 处理单行响应（提取为函数，data 和 end 时复用，避免最后一行残留丢失 tool_calls）
      const processLine = (line) => {
        if (!line || !line.trim()) return;
        totalLines++;
        lastRawLines.push(line.substring(0, 400));
        if (lastRawLines.length > 12) lastRawLines.shift();
        try {
          let parsed, delta;
          if (isOllama) {
            // Ollama 格式：每行一个 JSON { message: { content, tool_calls, reasoning/thinking }, done, done_reason }
            parsed = JSON.parse(line);
            if (parsed.usage) streamUsage = parsed.usage;
            delta = parsed.message || {};
            // 记录结束原因（length=被token上限截断，stop=正常结束）
            if (parsed.done_reason) finishReason = parsed.done_reason;
            // 兼容 reasoning 在顶层或 message 中的各种字段名
            if (!delta.reasoning && parsed.reasoning) delta.reasoning = parsed.reasoning;
            if (!delta.reasoning_content && parsed.reasoning_content) delta.reasoning_content = parsed.reasoning_content;
            if (!delta.reasoning && delta.thinking) delta.reasoning = delta.thinking;
            if (!delta.reasoning && parsed.thinking) delta.reasoning = parsed.thinking;
          } else {
            // OpenAI SSE 格式：data: {...}
            if (!line.startsWith('data: ')) return;
            const jsonStr = line.slice(6).trim();
            if (jsonStr === '[DONE]') return;
            parsed = JSON.parse(jsonStr);
            if (parsed.usage) streamUsage = parsed.usage;
            delta = parsed.choices?.[0]?.delta;
            if (parsed.choices?.[0]?.finish_reason) finishReason = parsed.choices[0].finish_reason;
          }
          if (!delta) return;

          // 思考过程（Ollama 用 reasoning/thinking，OpenAI 用 reasoning_content）
          const reasoningText = delta.reasoning_content || delta.reasoning;
          if (reasoningText) {
            fullReasoning += reasoningText;
            if (onStreamChunk) onStreamChunk({ reasoning: reasoningText });
          }
          // 正文（顺手把混在里面的内联思考拆到 reasoning）
          if (delta.content) {
            const split = thinkSplitter.push(delta.content);
            if (split.reasoning) {
              fullReasoning += split.reasoning;
              if (onStreamChunk) onStreamChunk({ reasoning: split.reasoning });
            }
            if (split.content) {
              fullContent += split.content;
              if (onStreamChunk) onStreamChunk({ content: split.content });
            }
          }
          // 工具调用
          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              // Ollama 的 index 在 function.index 内，OpenAI 在 tc.index；都做兼容
              const idx = (typeof tc.index === 'number' ? tc.index : (typeof tc.function?.index === 'number' ? tc.function.index : 0));
              if (!toolCalls[idx]) {
                toolCalls[idx] = { id: tc.id || 'call_' + idx, type: 'function', function: { name: '', arguments: '' } };
              }
              if (tc.id) toolCalls[idx].id = tc.id;
              if (tc.function?.name) {
                // Ollama 完整返回，直接赋值；OpenAI 增量返回，累加
                toolCalls[idx].function.name = isOllama ? tc.function.name : toolCalls[idx].function.name + tc.function.name;
              }
              if (tc.function?.arguments !== undefined && tc.function?.arguments !== null) {
                const argsVal = tc.function.arguments;
                if (isOllama) {
                  // Ollama：arguments 通常是对象，直接赋值；个别版本返回字符串
                  toolCalls[idx].function.arguments = argsVal;
                } else {
                  // OpenAI：arguments 是增量字符串，累加
                  toolCalls[idx].function.arguments = (toolCalls[idx].function.arguments || '') + (typeof argsVal === 'string' ? argsVal : JSON.stringify(argsVal));
                }
              }
              if (tc.function?.name && onStreamChunk) {
                onStreamChunk({ toolCall: { name: tc.function.name, index: idx } });
              }
            }
          }
        } catch (e) { 
          console.log('[Agent] 流式行解析错误:', e.message, '| 行内容:', line.substring(0, 150));
        }
      };

      res.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) processLine(line);
      });

      res.on('end', () => {
        // 关键修复：处理 buffer 中残留的最后一行（tool_calls 可能就在这一行）
        if (buffer.trim()) processLine(buffer);
        buffer = '';
        // 冲刷内联思考拆分的尾巴缓冲（不能丢字）
        const thinkTail = thinkSplitter.flush();
        if (thinkTail.reasoning) {
          fullReasoning += thinkTail.reasoning;
          if (onStreamChunk) onStreamChunk({ reasoning: thinkTail.reasoning });
        }
        if (thinkTail.content) {
          fullContent += thinkTail.content;
          if (onStreamChunk) onStreamChunk({ content: thinkTail.content });
        }
        // 归一化工具调用参数：半截 JSON 必须在这里修复，否则残缺参数会被写回历史 → 下一轮 400
        const finalToolCalls = toolCalls
          .filter(tc => tc && tc.function && tc.function.name)
          .map(tc => {
            const st = normalizeToolCallArgs(tc, isOllama);
            if (st !== 'ok') {
              console.log('[Agent] 工具参数不完整(' + st + '):', tc.function.name,
                JSON.stringify(tc.function.arguments).substring(0, 120));
            }
            return tc;
          });
        // 截断检测：思考/输出被 token 上限截断，导致没生成 tool_calls
        const truncated = finishReason === 'length';
        if (truncated && finalToolCalls.length === 0 && !fullContent.trim()) {
          console.log('[Agent] 诊断-截断: 最后12行原始内容:');
          lastRawLines.forEach((l, i) => console.log('  [' + (i+1) + '] ' + l));
          resolve({ 
            success: false, 
            error: '输出被 token 上限截断（done_reason=length），模型还没来得及调用工具。请在设置中增大 max_tokens 后重试。',
            truncated: true
          });
          return;
        }
        // 兜底：模型思考后异常停止（finishReason=stop 但 content 为空、toolCalls 为空）
        // 尝试从 reasoning 末尾提取最终回答（qwen3 偶发把回答写在 thinking 末尾而不输出 content）
        let effectiveContent = fullContent;
        if (!fullContent.trim() && finalToolCalls.length === 0 && fullReasoning.length > 50) {
          console.log('[Agent] 诊断-空输出: totalLines=' + totalLines + ' finishReason=' + finishReason + ' reasoning=' + fullReasoning.length + '字符');
          console.log('[Agent] 诊断-空输出: 最后12行原始内容:');
          lastRawLines.forEach((l, i) => console.log('  [' + (i+1) + '] ' + l));
          // 从 reasoning 末尾提取：找"最终回答"/"总结"/"因此"/"所以"等标记后的内容
          const markers = ['最终回答', '最终答案', '总结一下', '综上所述', '因此，', '所以，', '我的回答是', '简单来说'];
          let extracted = '';
          for (const m of markers) {
            const idx = fullReasoning.lastIndexOf(m);
            if (idx >= 0) {
              extracted = fullReasoning.substring(idx + m.length).trim();
              break;
            }
          }
          // 如果没找到标记，取 reasoning 最后一段（最后一个换行后的内容）
          if (!extracted) {
            const parts = fullReasoning.split(/\n+/).filter(s => s.trim().length > 20);
            if (parts.length > 0) extracted = parts[parts.length - 1].trim();
          }
          // 提取的内容如果看起来像回答（长度>10，不是纯思考标记），作为备选 content
          if (extracted && extracted.length > 10 && extracted.length < 2000) {
            effectiveContent = extracted;
            console.log('[Agent] 兜底: 从思考末尾提取到回答(' + extracted.length + '字符):', extracted.substring(0, 100));
          }
        }
        console.log('[Agent] 流式结束: content=' + fullContent.length + '字符 effectiveContent=' + effectiveContent.length + '字符 reasoning=' + fullReasoning.length + '字符 toolCalls=' + finalToolCalls.length + ' finishReason=' + finishReason + ' totalLines=' + totalLines);
        resolve({
          success: true,
          content: effectiveContent,
          rawContent: fullContent,
          reasoning: fullReasoning,
          toolCalls: finalToolCalls,
          finishReason,
          totalLines,
          usage: streamUsage
        });
      });
    });

    req.on('error', (err) => resolve({ success: false, error: err.message }));
    req.setTimeout(300000, () => { req.destroy(); resolve({ success: false, error: '请求超时（5分钟），请检查网络连接或稍后重试' }); });
    // 本地模型被杀/重启时 socket 已销毁，这里必须兜住，否则同步 EPIPE 会打进全局异常处理器
    safeWriteRequest(req, body, (e) => resolve({
      success: false,
      error: '请求发送失败（连接已断开，本地模型可能正在重启）: ' + e.message
    }));
  });
}

function formatModelSize(bytes) {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const k = 1024;
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + units[i];
}

function saveAIConfig() {
  if (!aiConfig) return;
  const { setConfig } = require('../configManager');
  setConfig({ ai: aiConfig });
}


// 从提供商 API 获取可用模型列表（调用 /v1/models）
function fetchProviderModels(provider) {
  return new Promise((resolve) => {
    try {
      const apiUrl = normalizeApiUrl(provider.apiUrl);
      // 从 chat completions 地址推导 models 地址
      const modelsUrl = apiUrl.replace(/\/chat\/completions\/?$/, '/models');
      if (modelsUrl === apiUrl) {
        resolve({ success: false, error: '无法从 API 地址推导 models 端点' });
        return;
      }
      const url = new URL(modelsUrl);
      const isHttps = url.protocol === 'https:';
      const client = isHttps ? https : http;

      const headers = {};
      if (provider.apiKey) headers['Authorization'] = `Bearer ${provider.apiKey}`;

      const options = {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname.replace(/\/$/, '') + (url.search || ''),
        method: 'GET',
        headers
      };

      const req = client.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              const parsed = JSON.parse(data);
              const models = (parsed.data || []).map(m => m.id).filter(Boolean);
              resolve({ success: true, models });
            } catch (e) {
              resolve({ success: false, error: '响应解析失败: ' + e.message });
            }
          } else {
            resolve({ success: false, error: `HTTP ${res.statusCode}` });
          }
        });
      });
      req.on('error', (err) => resolve({ success: false, error: err.message }));
      req.setTimeout(10000, () => { req.destroy(); resolve({ success: false, error: '请求超时' }); });
      req.end();
    } catch (e) {
      resolve({ success: false, error: e.message });
    }
  });
}

module.exports = {
  init, getStatus,
  getAgentTools,
  getContextMeta,
  getProviderPresets,
  listOllamaModels, testOllamaConnection,
  listLocalModels, importLocalModel, deleteLocalModel,
  useLocalModel, stopLocalModel, getLocalEngineStatus, detectLocalEngine, convertLocalModelToGguf, detectPythonEnv, checkTools, downloadTool, testMirrorConnectivity,
  initLocalEngine: (logFile, installDir) => { toolInstallDir = installDir; return LocalAiEngine.init({ logFile, installDir }); },
  listCloudProviders, addCloudProvider, addProviderByPreset, updateCloudProvider, deleteCloudProvider, fetchProviderModels,
  chat, streamChat, agentChat, cancelChat, cancelAgentChat,
  resolveToolConfirm,
  getAgentRoles, saveAgentRole, deleteAgentRole,
  releaseGPUMemory,
  // 长期记忆（供渲染层的「AI 记忆」面板读写）
  initMemory: (filePath) => MemoryStore.init(filePath),
  memory: {
    list: (opts) => MemoryStore.list(opts).map(memoryBrief),
    search: (query, limit) => MemoryStore.search(query, limit).map(memoryBrief),
    save: (payload) => MemoryStore.add(payload),
    update: (id, patch) => MemoryStore.update(id, patch),
    remove: (id) => MemoryStore.remove(id),
    clear: () => MemoryStore.clear(),
    stats: () => MemoryStore.stats()
  },
  // 待办事项（供渲染层读取/清理当前会话的清单）
  initTodo: (filePath) => TodoStore.init(filePath),
  todo: {
    read: (conversationId) => TodoStore.read(conversationId),
    write: (conversationId, items, title) => TodoStore.write(conversationId, items, title),
    update: (conversationId, patch) => TodoStore.update(conversationId, patch),
    clear: (conversationId) => TodoStore.clear(conversationId),
    stats: () => TodoStore.stats()
  },
  // 上下文护栏（纯函数，供单测）
  estimateMessagesTokens,
  pruneHeadToolRounds,
  // 仅给测试脚本用（scripts/test-vision-analyze.js 等）：把内部实现暴露出来做端到端校验
  __test: {
    analyzeImageWithVision,
    parseVisionVerdict,
    resolveVisionTarget,
    memoryBrief,
    thinkingParams,
    AGENT_TOOLS,
    RISKY_TOOLS,
    TOOLS_ALWAYS_ALLOWED,
    AGENT_SYSTEM_PROMPT
  }
};
