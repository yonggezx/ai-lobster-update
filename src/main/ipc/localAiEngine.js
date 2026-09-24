/**
 * 本地 AI 模型推理引擎（非 Ollama）
 * ------------------------------------------------------------
 * 解决的问题：导入的本地模型文件（GGUF 等）原来只是**登记在配置里**，
 * 既没有进程加载它，也没变成可选的 provider → 导入完"无法正常使用"。
 *
 * 做法：把本地模型接到 **OpenAI 兼容的本地服务**上（这是 llama.cpp / LM Studio /
 * vLLM / text-generation-webui 的通用形态），于是它能直接复用现有的对话链路，
 * 不需要给应用塞进任何原生推理依赖：
 *
 *   1) 本机已有在跑的服务（LM Studio :1234、llama.cpp :8080…）→ 直接复用，不重复启动；
 *   2) 否则用 llama-server.exe 把 GGUF 拉起来（-m <path> --host --port），
 *      轮询健康检查直到就绪，再问 /v1/models 拿到真实 model id；
 *   3) 把结果交给 aiOps 注册成一个 `local: true` 的 provider 并设为当前模型。
 *
 * 只支持 llama.cpp 系能跑的格式（GGUF / GGML）。safetensors / onnx 是训练/通用格式，
 * 本地没有运行时能直接加载 —— 这种情况必须如实告诉用户，而不是让他导入完在那儿干等。
 */
const fs = require('fs');
const path = require('path');
const net = require('net');
const http = require('http');
const { spawn } = require('child_process');
const os = require('os');
const ToolAutoInstall = require('./toolAutoInstall');
let autoInstallDir = null;

// llama.cpp 系能吃、且我们能拉起来的格式
const RUNNABLE_FORMATS = ['gguf', 'ggml'];
// 常见的本地 OpenAI 兼容端口（按优先级）：llama.cpp / LM Studio / vLLM / text-gen-webui / Jan
const CANDIDATE_PORTS = [8080, 1234, 8000, 5000, 11434, 1337];
const DEFAULT_PORT = 8080;
/**
 * 根据本机资源计算安全的推理参数，预留系统内存和 CPU 避免卡顿。
 * 返回 { contextSize, threads, reservedRamGB }
 */

/**
 * 探测 NVIDIA GPU 显存（nvidia-smi）。返回 { totalGB, freeGB, name } 或 null。
 * 非 N 卡 / 无驱动 / 无 nvidia-smi 时返回 null，调用方回退到保守估计。
 */
function detectGPUVRAM() {
  try {
    const r = require('child_process').execSync(
      'nvidia-smi --query-gpu=memory.total,memory.free,name --format=csv,noheader,nounits',
      { timeout: 3000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }
    ).toString().trim();
    const line = r.split('\n')[0];
    if (!line) return null;
    const parts = line.split(',').map(s => s.trim());
    const total = Number(parts[0]) / 1024;
    const free = Number(parts[1]) / 1024;
    const name = parts[2] || '';
    if (!isNaN(total) && !isNaN(free)) return { totalGB: total, freeGB: free, name };
  } catch (_) { /* 无 nvidia-smi 或非 N 卡 */ }
  return null;
}

/**
 * 根据模型大小、上下文和可用显存计算最优 GPU 卸载层数（-ngl）。
 * 原则：权重 + KV cache + 1GB 开销不超过可用显存的 85%，超出则按比例减少层数。
 * 50 系 Blackwell 原生 FP4 权重显存约为 FP16 的 1/4，但模型文件本身已是量化格式，
 * 这里按文件大小估算权重显存（GGUF 文件大小 ≈ 加载后权重占用）。
 */
function computeOptimalGpuLayers(modelSizeGB, contextSize, kvCacheType, gpu) {
  const kvBytes = { 'f16': 2, 'q8_0': 1, 'q8_1': 1, 'q4_0': 0.55, 'q4_1': 0.6, 'iq4_nl': 0.55, 'iq4_xxs': 0.5 }[kvCacheType] || 1;
  // KV cache 粗估：每 1K 上下文 × 模型参数量(B) × 0.18 GB（FP16 基准），再乘量化系数
  const kvCacheGB = (contextSize / 1024) * (modelSizeGB / 2) * 0.18 * (kvBytes / 2);
  const overheadGB = 1.0; // CUDA context + 临时缓冲
  const totalNeededGB = modelSizeGB * 1.05 + kvCacheGB + overheadGB;

  if (!gpu) {
    // 无显存信息：保守用 99（llama-server 装不下会自动回退部分层到 CPU，不会崩溃）
    return { layers: 99, reason: '未探测到GPU显存，默认全卸载', kvCacheGB: Math.round(kvCacheGB * 100) / 100 };
  }
  const safeLimit = gpu.freeGB * 0.85;
  if (totalNeededGB <= safeLimit) {
    return { layers: 99, reason: '模型+KV缓存 fits 显存（需' + Math.round(totalNeededGB * 10) / 10 + 'GB / 可用' + Math.round(gpu.freeGB * 10) / 10 + 'GB）', kvCacheGB: Math.round(kvCacheGB * 100) / 100 };
  }
  // 显存不够：按可用空间比例减少卸载层数，至少留 10 层在 GPU（embedding/output 必须在 GPU）
  const ratio = Math.max(0.1, (safeLimit - kvCacheGB - overheadGB) / (modelSizeGB * 1.05));
  const layers = Math.max(10, Math.min(99, Math.floor(99 * ratio)));
  return { layers, reason: '显存不足（需' + Math.round(totalNeededGB * 10) / 10 + 'GB / 可用' + Math.round(gpu.freeGB * 10) / 10 + 'GB），降级到 ' + layers + ' 层', kvCacheGB: Math.round(kvCacheGB * 100) / 100 };
}
function computeSafeInferenceParams(modelSizeGB) {
  const totalRAM = os.totalmem() / (1024 ** 3); // GB
  const cpuCount = os.cpus().length;
  // 预留至少 0.5GB 给系统，其余全部给模型和 KV cache
  const reservedRAM = Math.max(0.5, totalRAM * 0.05);
  const availableRAM = Math.max(1, totalRAM - reservedRAM);
  let contextSize = 8192; // 默认值
  const modelRAM = (modelSizeGB || 2) * 1.15; // 权重 + 运行时开销
  const remainingForKV = Math.max(0.5, availableRAM - modelRAM);
  // KV cache 粗略：每 1K 上下文约 0.12~0.15GB
  const maxCtxByRAM = Math.floor(remainingForKV / 0.15) * 1024;
  contextSize = Math.min(32768, Math.max(4096, maxCtxByRAM));
  // CPU 线程：留 2 核给系统，最少 2 线程
  const threads = Math.max(2, cpuCount - 2);
  return { contextSize, threads, reservedRAM: Math.round(reservedRAM * 10) / 10, totalRAM: Math.round(totalRAM * 10) / 10 };
}

let engine = null;   // 我们启动的进程 { child, port, modelId, modelPath, startedAt }
let hooks = { log: console.log, logFile: null };

function init(options = {}) {
  if (options.log) hooks.log = options.log;
  hooks.logFile = options.logFile || null;
  return true;
}

function isRunnableFormat(fmt) {
  return RUNNABLE_FORMATS.includes(String(fmt || '').toLowerCase());
}

// ---------- 基础工具 ----------

function httpGetJson(url, timeout = 1500) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    try {
      const req = http.get(url, (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(data); } catch (e) { /* 非 JSON（如 /health 返回纯文本）也算可达 */ }
          finish({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, json, text: data.slice(0, 200) });
        });
      });
      req.on('error', () => finish({ ok: false }));
      req.setTimeout(timeout, () => { try { req.destroy(); } catch (e) {} finish({ ok: false, timeout: true }); });
    } catch (e) {
      finish({ ok: false });
    }
  });
}

/** 探一个端口上的服务是否就绪，并尽量拿到它提供的 model id 列表 */
async function probePort(port, timeout = 1200) {
  const base = 'http://127.0.0.1:' + port;
  const models = await httpGetJson(base + '/v1/models', timeout);
  if (models.ok) {
    const ids = (models.json && Array.isArray(models.json.data) ? models.json.data : [])
      .map(m => m && (m.id || m.name)).filter(Boolean);
    return { ready: true, openAiCompatible: true, port, modelIds: ids, base };
  }
  const health = await httpGetJson(base + '/health', timeout);
  if (health.ok) return { ready: true, openAiCompatible: false, port, modelIds: [], base };
  return { ready: false, openAiCompatible: false, port };
}

/** 找一个空闲端口（优先用配置端口，被占用则往后找）。
 * ⚠️ Windows 上 Node 默认带 SO_REUSEADDR：别的进程绑了 0.0.0.0:8000 时，我们再绑 127.0.0.1:8000 也可能"成功"，
 * 导致端口探测误判空闲、最后和真正的主人抢流量（本机实测：8000 上有个 FastAPI 服务）。
 * 所以除了 bind 探测，还要确认该端口上没有已经在应答的 HTTP 服务。 */
async function findFreePort(preferred) {
  const bindable = (p) => new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(p, '127.0.0.1');
  });
  const reallyFree = async (p) => {
    if (!await bindable(p)) return false;
    const p2 = await probePort(p, 700);
    return !p2.ready;   // 已有服务在应答 → 视为占用
  };
  if (preferred && await reallyFree(preferred)) return preferred;
  for (const p of CANDIDATE_PORTS) {
    if (p === preferred) continue;
    if (await reallyFree(p)) return p;
  }
  // 全被占 → 让系统分配
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
    srv.on('error', () => resolve(DEFAULT_PORT));
  });
}

/** 在常见位置找 llama-server.exe（llama.cpp 官方包 / 应用自带 resources / PATH） */
function findLlamaServer(configuredPath) {
  const exe = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';
  const candidates = [];
  if (configuredPath) candidates.push(configuredPath);
  try {
    const { app } = require('electron');
    if (app && app.isPackaged) {
      candidates.push(path.join(process.resourcesPath, exe));
      candidates.push(path.join(process.resourcesPath, 'llama', exe));
    }
  } catch (e) { /* 非 Electron 环境（测试）忽略 */ }
  candidates.push(path.join(__dirname, '..', '..', '..', 'resources', exe));
  // PATH 里找
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (dir) candidates.push(path.join(dir, exe));
  }
  // 常见安装位置
  const la = process.env.LOCALAPPDATA || '';
  if (la) {
    candidates.push(path.join(la, 'Programs', 'llama.cpp', exe));
    candidates.push(path.join(la, 'llama.cpp', exe));
    candidates.push(path.join(la, 'Microsoft', 'WinGet', 'Links', exe));
  }
  candidates.push(path.join('C:', 'llama.cpp', exe));
  candidates.push(path.join('C:', 'llama', exe));

  for (const c of candidates) {
    try { if (c && fs.existsSync(c) && fs.statSync(c).isFile()) return c; } catch (e) { /* ignore */ }
  }
  return null;
}

// ---------- 启动 / 复用 ----------

function modelMatches(modelIds, model) {
  const want = String(model.name || path.basename(model.path || '', path.extname(model.path || ''))).toLowerCase();
  const file = String(path.basename(model.path || '')).toLowerCase();
  return modelIds.some(id => {
    const s = String(id).toLowerCase();
    return (want && (s.includes(want) || want.includes(s))) || (file && (s.includes(file) || file.includes(s)));
  });
}


// ---------- 模型格式检测（单文件 / 分片 GGUF / HuggingFace 目录 / 嵌套目录） ----------

/**
 * 读取文件前 4 字节判断是否为 GGUF 魔数（用于 .bin 等模糊扩展名）
 */
function isGgufByMagic(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(4);
    fs.readSync(fd, buf, 0, 4, 0);
    fs.closeSync(fd);
    return buf.toString('ascii') === 'GGUF';
  } catch (_) { return false; }
}

/**
 * 在目录中查找 GGUF 文件，支持分片（model-00001-of-00003.gguf）
 * 返回 { entryPath, fileCount, splitFiles }
 */
function findGgufInDir(dir) {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const ggufFiles = entries.filter(e => e.isFile() && /\.gguf$/i.test(e.name))
      .map(e => e.name).sort();
    if (ggufFiles.length === 0) return null;

    // 分片文件：找 model-00001 或按名称排序第一个
    let entry = ggufFiles[0];
    const splitMatch = ggufFiles.find(n => /-0+1(?:-of-\d+)?\.gguf$/i.test(n));
    if (splitMatch) entry = splitMatch;

    return {
      entryPath: path.join(dir, entry),
      fileCount: ggufFiles.length,
      splitFiles: ggufFiles.length > 1 ? ggufFiles : null
    };
  } catch (_) { return null; }
}

/**
 * 综合检测模型格式，支持文件和目录
 * 返回 { format, runnable, entryPath, fileCount, isDirectory, modelType, hint, splitFiles }
 */
function detectModelFormat(modelPath) {
  if (!modelPath || !fs.existsSync(modelPath)) {
    return { format: 'unknown', runnable: false, entryPath: modelPath, fileCount: 0, isDirectory: false, modelType: 'unknown', hint: '路径不存在' };
  }

  const stat = fs.statSync(modelPath);

  // ===== 单文件 =====
  if (stat.isFile()) {
    const ext = path.extname(modelPath).toLowerCase();
    if (ext === '.gguf' || ext === '.ggml') {
      return { format: ext.replace('.', ''), runnable: true, entryPath: modelPath, fileCount: 1, isDirectory: false, modelType: 'single' };
    }
    if (ext === '.bin' && isGgufByMagic(modelPath)) {
      return { format: 'gguf', runnable: true, entryPath: modelPath, fileCount: 1, isDirectory: false, modelType: 'single', hint: '.bin 文件实际为 GGUF 格式' };
    }
    if (ext === '.safetensors') {
      // 分片 safetensors（model-00001-of-00002.safetensors）：自动检测父目录是否为完整 HF 模型
      const baseName = path.basename(modelPath);
      const shardMatch = /^(.+)-\d{5}-of-\d{5}\.safetensors$/i.exec(baseName);
      if (shardMatch) {
        const parentDir = path.dirname(modelPath);
        try {
          const parentEntries = fs.readdirSync(parentDir, { withFileTypes: true });
          const hasConfig = parentEntries.some(e => e.isFile() && /^config\.json$/i.test(e.name));
          const stFiles = parentEntries.filter(e => e.isFile() && /\.safetensors$/i.test(e.name));
          if (hasConfig && stFiles.length > 0) {
            return {
              format: 'huggingface',
              runnable: false,
              entryPath: parentDir,
              fileCount: stFiles.length,
              isDirectory: true,
              modelType: 'huggingface-directory',
              hint: '检测到分片 safetensors，已自动识别为完整 HuggingFace 模型目录（' + stFiles.length + ' 个分片）。\n转换方法：python convert_hf_to_gguf.py "' + parentDir + '" --outfile output.gguf\n需安装：pip install torch transformers sentencepiece protobuf'
            };
          }
        } catch (_) {}
      }
      return { format: 'safetensors', runnable: false, entryPath: modelPath, fileCount: 1, isDirectory: false, modelType: 'single',
        hint: 'Safetensors 是 HuggingFace 训练格式，llama.cpp 不能直接加载。\n转换方法：python convert_hf_to_gguf.py ' + modelPath + ' --outfile output.gguf' };
    }
    if (ext === '.onnx') {
      return { format: 'onnx', runnable: false, entryPath: modelPath, fileCount: 1, isDirectory: false, modelType: 'single',
        hint: 'ONNX 格式 llama.cpp 不能直接加载。请转成 GGUF 后使用，或改用支持 ONNX 的推理引擎。' };
    }
    if (ext === '.bin') {
      return { format: 'bin', runnable: false, entryPath: modelPath, fileCount: 1, isDirectory: false, modelType: 'single',
        hint: '.bin 文件不是 GGUF 格式（魔数不匹配）。可能是 PyTorch 权重，需转换为 GGUF。' };
    }
    return { format: ext.replace('.', '') || 'unknown', runnable: false, entryPath: modelPath, fileCount: 1, isDirectory: false, modelType: 'single',
      hint: '不支持的格式: ' + ext };
  }

  // ===== 目录 =====
  const entries = fs.readdirSync(modelPath, { withFileTypes: true });
  const hasConfigJson = entries.some(e => e.isFile() && /^config\.json$/i.test(e.name));
  const hasSafetensors = entries.some(e => e.isFile() && /\.safetensors$/i.test(e.name));

  // 1. 目录中有 GGUF 文件（单文件或分片）
  const ggufResult = findGgufInDir(modelPath);
  if (ggufResult) {
    return {
      format: 'gguf',
      runnable: true,
      entryPath: ggufResult.entryPath,
      fileCount: ggufResult.fileCount,
      isDirectory: true,
      modelType: ggufResult.splitFiles ? 'split-gguf' : 'directory-gguf',
      splitFiles: ggufResult.splitFiles,
      hint: ggufResult.splitFiles ? ('分片 GGUF 模型，共 ' + ggufResult.fileCount + ' 个文件，已自动定位入口文件') : null
    };
  }

  // 2. HuggingFace 格式目录（config.json + safetensors）
  if (hasConfigJson && hasSafetensors) {
    const stFiles = entries.filter(e => e.isFile() && /\.safetensors$/i.test(e.name));
    return {
      format: 'huggingface',
      runnable: false,
      entryPath: modelPath,
      fileCount: stFiles.length,
      isDirectory: true,
      modelType: 'huggingface-directory',
      hint: 'HuggingFace 模型目录（' + stFiles.length + ' 个 safetensors 分片）。\n转换方法：python convert_hf_to_gguf.py "' + modelPath + '" --outfile output.gguf\n需安装：pip install torch transformers sentencepiece protobuf'
    };
  }

  // 3. 只有 safetensors 没有 config.json
  if (hasSafetensors && !hasConfigJson) {
    const stFiles = entries.filter(e => e.isFile() && /\.safetensors$/i.test(e.name));
    return {
      format: 'safetensors',
      runnable: false,
      entryPath: modelPath,
      fileCount: stFiles.length,
      isDirectory: true,
      modelType: 'huggingface-empty',
      hint: '目录中有 safetensors 但缺少 config.json，可能不是完整的 HuggingFace 模型。'
    };
  }

  // 4. 递归查找子目录中的 GGUF
  for (const e of entries) {
    if (e.isDirectory()) {
      const sub = findGgufInDir(path.join(modelPath, e.name));
      if (sub) {
        return {
          format: 'gguf', runnable: true, entryPath: sub.entryPath, fileCount: sub.fileCount,
          isDirectory: true, modelType: 'nested-gguf',
          hint: '在子目录 "' + e.name + '" 中找到 GGUF 模型'
        };
      }
    }
  }

  // 5. 无法识别
  return {
    format: 'unknown', runnable: false, entryPath: modelPath, fileCount: entries.length,
    isDirectory: true, modelType: 'unknown-directory',
    hint: '无法识别的模型目录格式。请确认包含 GGUF 文件或完整的 HuggingFace 模型（config.json + safetensors）。'
  };
}
/**
 * 确保某个本地模型可用。返回 { success, port, modelId, base, reused } 或 { success:false, error, hint }
 * @param {object} model  aiConfig.localModels 里的一条
 * @param {object} opts   { engineConfig, timeoutMs }
 */
async function ensureRunning(model, opts = {}) {
  if (!model || !model.path) return { success: false, error: '模型信息不完整' };
  if (!fs.existsSync(model.path)) {
    return { success: false, error: '模型文件不存在（可能已被移动或删除）: ' + model.path };
  }
  // 综合检测格式：支持单文件、目录、分片 GGUF、HuggingFace 目录等
  const detected = detectModelFormat(model.path);
  if (!detected.runnable) {
    return {
      success: false,
      error: '本机没有能直接加载 ' + String(detected.format || model.format || '').toUpperCase() + ' 的本地运行时',
      hint: detected.hint || '非 Ollama 的本地推理走 llama.cpp 系（只吃 GGUF / GGML）。请把模型转成 GGUF（llama.cpp 的 convert_hf_to_gguf.py）后重新导入；' +
            '或改用已在运行的本地服务（LM Studio / vLLM / text-generation-webui）并在「本地模型」里填它的地址。'
    };
  }
  // 使用检测到的入口文件（目录/分片模型时指向第一个分片，llama-server 自动加载其余）
  const effectivePath = detected.entryPath || model.path;
  if (detected.hint) hooks.log('[LocalAI] ' + detected.hint);

  const cfg = opts.engineConfig || {};
  const timeoutMs = Math.max(5000, Number(opts.timeoutMs) || 120000);

  // 1) 已经由我们启动且还活着 → **无论 ready 与否都等它**。
  //    ⚠️ 加载中的模型再起第二份 = 双倍内存（实例越积越多，"运行时异常占用内存"的根源）。
  if (engine && engine.child && engine.child.exitCode === null && engine.modelPath === effectivePath) {
    const deadline = Date.now() + timeoutMs;
    let exited = false;
    while (Date.now() < deadline) {
      if (!engine || !engine.child || engine.child.exitCode !== null) { exited = true; break; }
      const p = await probePort(engine.port, 1000);
      if (p.ready && p.openAiCompatible) {
        engine.modelId = p.modelIds[0] || engine.modelId;
        hooks.log('[LocalAI] 既有实例已就绪：127.0.0.1:' + engine.port + '（等待 ' + Math.round((Date.now() - engine.startedAt) / 1000) + 's）');
        return { success: true, port: engine.port, modelId: engine.modelId, base: p.base, reused: true, managed: true, loadMs: Date.now() - engine.startedAt };
      }
      if (typeof opts.onStatus === 'function') {
        try { opts.onStatus('本地模型正在加载（已等待 ' + Math.round((Date.now() - engine.startedAt) / 1000) + ' 秒），复用同一实例、不会重复启动…'); } catch (e) { /* 忽略 */ }
      }
      await new Promise(r => setTimeout(r, 700));
    }
    if (!exited) {
      return {
        success: false,
        timeout: true,
        error: '本地模型加载超时（' + Math.round(timeoutMs / 1000) + ' 秒）',
        hint: '进程仍在后台加载，这里等它就绪而不是再起一份（避免双倍内存）；稍后重试会直接复用。详细输出见 ' + (hooks.logFile || '启动日志')
      };
    }
    hooks.log('[LocalAI] 既有实例已退出，重新拉起');
  }

  // 2) 本机已有在跑的服务，且它的模型跟我们要的一致 → 直接复用，不重复起一份
  const envPort = Number(cfg.port) || 0;
  const probeList = envPort ? [envPort] : CANDIDATE_PORTS;
  for (const port of probeList) {
    const p = await probePort(port, 1200);
    if (!p.ready) continue;
    if (p.openAiCompatible && p.modelIds.length > 0 && modelMatches(p.modelIds, model)) {
      hooks.log('[LocalAI] 复用已在运行的服务 127.0.0.1:' + port + '（' + (p.modelIds[0] || '未报告模型名') + '）');
      return {
        success: true, port, modelId: p.modelIds[0] || model.name, base: p.base,
        reused: true, managed: false
      };
    }
    hooks.log('[LocalAI] 端口 ' + port + ' 有服务但模型不匹配（' + p.modelIds.join(',') + '），跳过');
  }

  // 3) 拉起 llama-server（不静默下载，缺失时返回 toolMissing 让前端弹窗确认）
  const bin = findLlamaServer(cfg.binPath);
  if (!bin) {
    hooks.log('[LocalAI] 未找到 llama-server，需用户确认后下载');
    return {
      success: false,
      toolMissing: true,
      tool: 'llama-server',
      error: '未找到 llama-server（llama.cpp 服务端）',
      hint: '需要下载 llama.cpp 工具包（含 llama-server、llama-quantize 显存优化工具等）。' +
            '也可以先启动 LM Studio / vLLM 等本地服务（默认端口 1234 / 8000），会自动复用。'
    };
  }

  const port = await findFreePort(envPort || DEFAULT_PORT);
  // preArgs：前置参数（用 wsl / 包装脚本启动时把脚本路径插在最前面）。
  // 放前面是为了让标准参数落到被包装程序的 argv 上，而不是被包装器自己吃掉。
  // 估算模型大小，按本机资源计算安全的上下文/线程，预留系统内存避免卡顿
  let modelSizeGB = 2;
  try { modelSizeGB = fs.statSync(effectivePath).size / (1024 ** 3); } catch (_) {}
  const safe = computeSafeInferenceParams(modelSizeGB);
  const contextSize = Number(cfg.contextSize) || safe.contextSize;

  const args = [];
  if (Array.isArray(cfg.preArgs)) args.push(...cfg.preArgs.map(String));
  args.push('-m', effectivePath, '--host', '127.0.0.1', '--port', String(port));
  args.push('-c', String(contextSize));
  args.push('-t', String(safe.threads));
  // KV 缓存量化：q8_0 减少约 50% KV 显存，质量损失极小；q4_0 减少 75%，长上下文时质量略降
  const kvCacheType = String(cfg.kvCacheType || 'q8_0').toLowerCase();
  args.push('--cache-type-k', kvCacheType, '--cache-type-v', kvCacheType);
  // Flash Attention：GPU 上更快的注意力计算，减少显存占用
  args.push('--flash-attn', 'auto');
  // GPU 卸载：探测显存后智能分配层数，避免爆显存导致 OOM 或回退到 CPU 推理
  const gpu = detectGPUVRAM();
  const gpuOpt = computeOptimalGpuLayers(modelSizeGB, contextSize, kvCacheType, gpu);
  const gpuLayers = Number(cfg.gpuLayers) > 0 ? Number(cfg.gpuLayers) : gpuOpt.layers;
  args.push('-ngl', String(gpuLayers));
  if (Array.isArray(cfg.extraArgs)) args.push(...cfg.extraArgs.map(String));

  hooks.log('[LocalAI] 启动 ' + bin + ' ' + args.map(a => (/\s/.test(a) ? '"' + a + '"' : a)).join(' '));
  hooks.log('[LocalAI] 资源保护：模型 ' + Math.round(modelSizeGB * 100) / 100 + 'GB / 总内存 ' + safe.totalRAM + 'GB / 预留 ' + safe.reservedRAM + 'GB / 上下文 ' + contextSize + ' / 线程 ' + safe.threads + ' / KV缓存=' + kvCacheType + '(约' + gpuOpt.kvCacheGB + 'GB) / GPU层 ' + gpuLayers + '（' + gpuOpt.reason + '）' + (gpu ? ' / GPU=' + gpu.name + '(' + Math.round(gpu.freeGB * 10) / 10 + 'GB空闲)' : ''));

  let out = null;
  try {
    if (hooks.logFile) {
      fs.mkdirSync(path.dirname(hooks.logFile), { recursive: true });
      out = fs.openSync(hooks.logFile, 'a');
    }
  } catch (e) { out = null; }

  let child;
  try {
    child = spawn(bin, args, { windowsHide: true, stdio: out === null ? 'ignore' : ['ignore', out, out] });
  } catch (e) {
    return { success: false, error: '启动 llama-server 失败: ' + e.message, hint: '检查 ai.localEngine.binPath 是否是有效的可执行文件' };
  }

  let spawnError = null;
  child.on('error', (e) => { spawnError = e; });
  let exited = null;
  child.on('exit', (code) => { exited = code; if (engine && engine.child === child) engine = null; });

  engine = { child, port, modelId: model.name, modelPath: effectivePath, startedAt: Date.now(), bin };

  // 轮询健康检查（模型加载可能要几十秒）
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (spawnError) {
      engine = null;
      return { success: false, error: '启动 llama-server 失败: ' + spawnError.message };
    }
    if (exited !== null) {
      engine = null;
      return {
        success: false,
        error: 'llama-server 启动后立即退出（退出码 ' + exited + '）',
        hint: '常见原因：模型文件不完整 / 显存不足 / 参数不被该版本支持。详细输出见 ' + (hooks.logFile || '启动日志')
      };
    }
    const p = await probePort(port, 1000);
    if (p.ready && p.openAiCompatible) {
      const modelId = p.modelIds[0] || model.name;
      engine.modelId = modelId;
      hooks.log('[LocalAI] 就绪：127.0.0.1:' + port + ' model=' + modelId + '（耗时 ' + Math.round((Date.now() - engine.startedAt) / 1000) + 's）');
      return { success: true, port, modelId, base: p.base, reused: false, managed: true, bin, loadMs: Date.now() - engine.startedAt };
    }
    if (typeof opts.onStatus === 'function') {
      try { opts.onStatus('正在启动本地模型（已等待 ' + Math.round((Date.now() - engine.startedAt) / 1000) + ' 秒）…'); } catch (e) { /* 忽略 */ }
    }
    await new Promise(r => setTimeout(r, 700));
  }

  // 超时：进程还在说明只是加载慢，留着它继续加载，但本轮先如实报错
  return {
    success: false,
    error: '本地模型加载超时（' + Math.round(timeoutMs / 1000) + ' 秒）。大模型首次加载较慢，可稍后重试或选择更小的量化版本。',
    timeout: true,
    hint: '进程仍在后台加载中；也可以看 ' + (hooks.logFile || '启动日志') + ' 确认真实进度'
  };
}

/** 只杀我们自己启动的进程（复用别人的服务时绝不能杀） */
function stop() {
  if (!engine || !engine.child) return { success: true, stopped: false, message: '当前没有由本应用启动的本地服务' };
  const { child, port, bin } = engine;
  engine = null;
  try {
    if (process.platform === 'win32') {
      // llama-server 可能还有子进程，用 taskkill 连树一起收
      spawn('taskkill', ['/F', '/T', '/PID', String(child.pid)], { windowsHide: true, stdio: 'ignore' });
    } else {
      child.kill('SIGTERM');
    }
  } catch (e) {
    try { child.kill(); } catch (e2) { /* ignore */ }
  }
  hooks.log('[LocalAI] 已停止本地服务（pid ' + child.pid + '，port ' + port + '）');
  return { success: true, stopped: true, port, bin };
}

function status() {
  if (engine && engine.child && engine.child.exitCode === null) {
    return {
      running: true, managed: true, port: engine.port, pid: engine.child.pid,
      modelPath: engine.modelPath, modelId: engine.modelId, uptimeMs: Date.now() - engine.startedAt, bin: engine.bin
    };
  }
  return { running: false, managed: false };
}

/** 引擎能力探测：给界面提供"能不能用本地模型、可选项有哪些"的依据 */
async function detect() {
  const llamaServer = findLlamaServer(null);
  const live = [];
  for (const port of CANDIDATE_PORTS) {
    const p = await probePort(port, 700);
    if (p.ready) live.push({ port, modelIds: p.modelIds, base: p.base });
  }
  return {
    llamaServer,
    hasLlamaServer: !!llamaServer,
    liveServers: live,
    runnableFormats: RUNNABLE_FORMATS,
    current: status()
  };
}

module.exports = {
  init, detect, ensureRunning, stop, status, probePort, findLlamaServer, findFreePort,
  isRunnableFormat, RUNNABLE_FORMATS, CANDIDATE_PORTS,
  detectModelFormat, findGgufInDir, isGgufByMagic
};
