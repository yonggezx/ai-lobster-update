/**
 * 本地推理工具自动安装/下载（需用户确认 + 自选目录）
 * ------------------------------------------------------------
 * 工具清单：
 *   - llama-server   : llama.cpp 服务端（含 llama-quantize / llama-cli 等全套工具）
 *   - convert-script : convert_hf_to_gguf.py（HF → GGUF 转换脚本）
 *
 * 所有下载操作必须由前端先弹窗征得用户同意，并传入用户选择的安装目录。
 * 本模块不做任何静默下载。
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync, spawn } = require('child_process');
const os = require('os');

// 下载进度回调
let progressCallback = null;
function setProgressCallback(cb) { progressCallback = cb; }
function report(phase, percent, message) {
  if (progressCallback) { try { progressCallback({ phase, percent, message }); } catch (_) {} }
}

// ============================================================
// 通用下载（支持代理 / 重定向 / 进度）
// ============================================================
function getProxyAgent() {
  try {
    const pe = execSync('reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable', { encoding: 'utf-8', windowsHide: true });
    if (/0x1/.test(pe)) {
      const ps = execSync('reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyServer', { encoding: 'utf-8', windowsHide: true });
      const m = ps.match(/ProxyServer\s+REG_SZ\s+(\S+)/);
      if (m && m[1]) {
        const { HttpsProxyAgent } = require('https-proxy-agent');
        return new HttpsProxyAgent('http://' + m[1]);
      }
    }
  } catch (_) {}
  return null;
}

function downloadFile(url, destPath, onProgress) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { reject(e); return; }
    const opts = {
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'GET',
      headers: { 'User-Agent': 'fuling-shijie' },
      timeout: 300000
    };
    const agent = getProxyAgent();
    if (agent) opts.agent = agent;

    const req = https.request(opts, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        req.destroy();
        downloadFile(res.headers.location, destPath, onProgress).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) { reject(new Error('HTTP ' + res.statusCode)); return; }
      const total = parseInt(res.headers['content-length'] || '0', 10);
      let downloaded = 0;
      const file = fs.createWriteStream(destPath);
      res.on('data', (chunk) => {
        downloaded += chunk.length;
        if (onProgress && total > 0) onProgress(Math.round(downloaded / total * 100));
      });
      res.pipe(file);
      file.on('finish', () => {
        file.close(() => {
          try {
            const stat = fs.statSync(destPath);
            if (total > 0 && stat.size !== total) { fs.unlinkSync(destPath); reject(new Error('下载不完整')); return; }
            resolve(destPath);
          } catch (e) { reject(e); }
        });
      });
      file.on('error', reject);
    });
    // 连接超时：20 秒未建立连接即失败，快速切换镜像
    const connectTimer = setTimeout(() => { req.destroy(); reject(new Error('连接超时（20秒）')); }, 20000);
    req.on('response', () => clearTimeout(connectTimer));
    req.on('error', (e) => { clearTimeout(connectTimer); reject(e); });
    req.on('timeout', () => { clearTimeout(connectTimer); req.destroy(); reject(new Error('下载超时')); });
    req.end();
  });
}

// 带镜像源和重试的下载（解决国内 GitHub 连接重置/超时）

// 快速测速：并发 HEAD 请求所有镜像，返回最快的一个（8秒超时）
// 快速测速：并发请求所有镜像，返回最快的一个（用 GET 收到响应头即中止，兼容不支持 HEAD 的镜像）
async function findFastestMirror(urls, timeoutMs = 8000) {
  const results = await Promise.all(urls.map(async (url) => {
    const start = Date.now();
    try {
      await new Promise((resolve, reject) => {
        let u;
        try { u = new URL(url); } catch (e) { reject(e); return; }
        const opts = {
          hostname: u.hostname, path: u.pathname + u.search, method: 'GET',
          headers: { 'User-Agent': 'fuling-shijie', 'Range': 'bytes=0-0' }, timeout: timeoutMs
        };
        const agent = getProxyAgent();
        if (agent) opts.agent = agent;
        const req = https.request(opts, (res) => {
          // 收到响应头即算连通（不管状态码）
          req.destroy();
          resolve();
        });
        const timer = setTimeout(() => { req.destroy(); reject(new Error('timeout')); }, timeoutMs);
        req.on('response', () => { clearTimeout(timer); });
        req.on('error', (e) => { clearTimeout(timer); reject(e); });
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
        req.end();
      });
      return { url, latency: Date.now() - start, ok: true };
    } catch (_) {
      return { url, latency: Infinity, ok: false };
    }
  }));
  const okList = results.filter(r => r.ok).sort((a, b) => a.latency - b.latency);
  return okList.length > 0 ? okList[0].url : null;
}

// 测试所有镜像源连通性，返回详细结果
async function testMirrorConnectivity(urls, timeoutMs = 8000) {
  const results = await Promise.all(urls.map(async (url) => {
    const start = Date.now();
    try {
      await new Promise((resolve, reject) => {
        let u;
        try { u = new URL(url); } catch (e) { reject(e); return; }
        const opts = {
          hostname: u.hostname, path: u.pathname + u.search, method: 'GET',
          headers: { 'User-Agent': 'fuling-shijie', 'Range': 'bytes=0-0' }, timeout: timeoutMs
        };
        const agent = getProxyAgent();
        if (agent) opts.agent = agent;
        const req = https.request(opts, (res) => { req.destroy(); resolve(res.statusCode); });
        const timer = setTimeout(() => { req.destroy(); reject(new Error('timeout')); }, timeoutMs);
        req.on('response', () => { clearTimeout(timer); });
        req.on('error', (e) => { clearTimeout(timer); reject(e); });
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
        req.end();
      });
      return { url, latency: Date.now() - start, ok: true, status: 'ok' };
    } catch (e) {
      return { url, latency: timeoutMs, ok: false, status: e.message || 'fail' };
    }
  }));
  return results;
}

// 带镜像源和重试的下载：先测速选最快，再下载，失败自动切换
async function downloadFileWithMirrors(urls, destPath, onProgress, maxRetries = 2) {
  if (onProgress) onProgress({ phase: 'testing', percent: -1, message: '正在测速选择最快下载源...' });

  // 第一轮：测速选最快
  let fastest = await findFastestMirror(urls);
  let orderedUrls = fastest ? [fastest, ...urls.filter(u => u !== fastest)] : urls;

  let lastError = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    for (const url of orderedUrls) {
      try {
        const host = new URL(url).hostname;
        if (onProgress) onProgress({ phase: 'downloading', percent: -1, message: `正在从 ${host} 下载（尝试 ${attempt + 1}/${maxRetries + 1}）...` });
        await downloadFile(url, destPath, (pct) => {
          if (onProgress) onProgress({ phase: 'downloading', percent: pct, message: `下载中 ${pct}%` });
        });
        return destPath;
      } catch (e) {
        lastError = e;
        if (onProgress) onProgress({ phase: 'downloading', percent: -1, message: `源 ${new URL(url).hostname} 失败: ${e.message}，切换下一个...` });
      }
    }
    // 重试前重新测速（网络状况可能变化）
    if (attempt < maxRetries) {
      if (onProgress) onProgress({ phase: 'testing', percent: -1, message: '重新测速...' });
      fastest = await findFastestMirror(urls);
      orderedUrls = fastest ? [fastest, ...urls.filter(u => u !== fastest)] : urls;
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  throw new Error('所有下载源均失败: ' + (lastError ? lastError.message : 'unknown'));
}

// GitHub raw 内容的镜像 URL 列表
function githubRawUrls(repoPath) {
  return [
    'https://raw.githubusercontent.com/' + repoPath,
    'https://raw.gitmirror.com/' + repoPath,
    'https://ghproxy.com/https://raw.githubusercontent.com/' + repoPath,
    'https://mirror.ghproxy.com/https://raw.githubusercontent.com/' + repoPath,
  ];
}

// GitHub release 下载的镜像 URL 列表
function githubReleaseUrls(originalUrl) {
  return [
    originalUrl,
    'https://ghproxy.com/' + originalUrl,
    'https://mirror.ghproxy.com/' + originalUrl,
    'https://gh-proxy.com/' + originalUrl,
  ];
}

// ============================================================
// GitHub Release 解析
// ============================================================
async function getLatestLlamaReleaseUrl() {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: 'api.github.com',
      path: '/repos/ggerganov/llama.cpp/releases/latest',
      method: 'GET',
      headers: { 'User-Agent': 'fuling-shijie', 'Accept': 'application/vnd.github.v3+json' },
      timeout: 15000
    };
    const agent = getProxyAgent();
    if (agent) opts.agent = agent;

    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          const assets = json.assets || [];
          const priorities = [
            /win-cuda-cu12-x64\.zip$/i,
            /win-cuda-cu11-x64\.zip$/i,
            /win-cuda-x64\.zip$/i,
            /win-x64\.zip$/i,
            /win-avx2\.zip$/i,
          ];
          let chosen = null;
          for (const pat of priorities) { chosen = assets.find(a => pat.test(a.name)); if (chosen) break; }
          if (!chosen) chosen = assets.find(a => /win.*\.zip$/i.test(a.name));
          if (!chosen) { reject(new Error('未找到 Windows 版下载链接')); return; }
          resolve({ url: chosen.browser_download_url, name: chosen.name, size: chosen.size, version: json.tag_name || 'latest' });
        } catch (e) { reject(new Error('解析 release 失败: ' + e.message)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('GitHub API 超时')); });
    req.end();
  });
}

// ============================================================
// 解压
// ============================================================
function extractZip(zipPath, destDir) {
  return new Promise((resolve, reject) => {
    try {
      fs.mkdirSync(destDir, { recursive: true });
      const ps = spawn('powershell', ['-NoProfile', '-Command', `Expand-Archive -Path '${zipPath}' -DestinationPath '${destDir}' -Force`], { windowsHide: true });
      let err = '';
      ps.stderr.on('data', d => err += d);
      ps.on('close', (code) => {
        if (code === 0) resolve(destDir);
        else reject(new Error('解压失败: ' + err.slice(0, 300)));
      });
    } catch (e) { reject(e); }
  });
}

function findExeInDir(dir, exeName) {
  try {
    const walk = (d) => {
      const entries = fs.readdirSync(d, { withFileTypes: true });
      for (const e of entries) {
        const fp = path.join(d, e.name);
        if (e.isFile() && new RegExp(exeName + '\\.exe$', 'i').test(e.name)) return fp;
        if (e.isDirectory()) { const f = walk(fp); if (f) return f; }
      }
      return null;
    };
    return walk(dir);
  } catch (_) { return null; }
}

// ============================================================
// 工具：llama-server（完整 llama.cpp 包，含 quantize / cli 等）
// ============================================================
async function downloadLlamaServer(installDir, onProgress) {
  report('fetching', 0, '正在获取最新 llama.cpp 版本...');
  const release = await getLatestLlamaReleaseUrl();
  report('downloading', 5, `下载 llama.cpp ${release.version}（${(release.size / 1024 / 1024).toFixed(1)}MB）...`);

  fs.mkdirSync(installDir, { recursive: true });
  const zipPath = path.join(installDir, 'llama-cpp.zip');
  const extractDir = path.join(installDir, '_extract');

  try { if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath); } catch (_) {}
  try { if (fs.existsSync(extractDir)) fs.rmSync(extractDir, { recursive: true, force: true }); } catch (_) {}

  await downloadFile(release.url, zipPath, (pct) => {
    report('downloading', 5 + Math.round(pct * 0.7), `下载中 ${pct}%`);
    if (onProgress) onProgress({ phase: 'downloading', percent: pct, message: `下载中 ${pct}%` });
  });

  report('extracting', 80, '正在解压...');
  await extractZip(zipPath, extractDir);

  // 把所有 exe 和 dll 复制到 installDir
  const walk = (d) => {
    const entries = fs.readdirSync(d, { withFileTypes: true });
    for (const e of entries) {
      const fp = path.join(d, e.name);
      if (e.isFile() && /\.(exe|dll)$/i.test(e.name)) {
        fs.copyFileSync(fp, path.join(installDir, e.name));
      }
      if (e.isDirectory()) walk(fp);
    }
  };
  walk(extractDir);

  // 清理
  try { fs.unlinkSync(zipPath); } catch (_) {}
  try { fs.rmSync(extractDir, { recursive: true, force: true }); } catch (_) {}

  const exePath = path.join(installDir, 'llama-server.exe');
  if (!fs.existsSync(exePath)) throw new Error('解压后未找到 llama-server.exe');

  report('done', 100, '安装完成');
  return { path: exePath, version: release.version, installDir };
}

// ============================================================
// 工具：convert_hf_to_gguf.py
// ============================================================
// 一次性下载完整 llama.cpp 源码（含 convert_hf_to_gguf.py + gguf + conversion 等所有依赖）
async function downloadLlamaSource(installDir, onProgress) {
  fs.mkdirSync(installDir, { recursive: true });
  const sourceDir = path.join(installDir, 'llama.cpp-source');
  const scriptPath = path.join(sourceDir, 'convert_hf_to_gguf.py');

  // 已存在且脚本可用则直接返回
  if (fs.existsSync(scriptPath)) {
    if (onProgress) onProgress({ phase: 'done', percent: 100, message: '源码已存在' });
    return { sourceDir, scriptPath };
  }

  report('downloading', 0, '下载 llama.cpp 完整源码（含转换脚本及所有依赖）...');
  const zipPath = path.join(installDir, 'llama-cpp-source.zip');
  const extractDir = path.join(installDir, '_source_extract');

  try { if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath); } catch (_) {}
  try { if (fs.existsSync(extractDir)) fs.rmSync(extractDir, { recursive: true, force: true }); } catch (_) {}

  // GitHub 源码压缩包（master 分支），走镜像源
  const archiveUrl = 'https://github.com/ggerganov/llama.cpp/archive/refs/heads/master.zip';
  const urls = githubReleaseUrls(archiveUrl);
  await downloadFileWithMirrors(urls, zipPath, (p) => {
    if (onProgress) onProgress(p);
  });

  report('extracting', 80, '正在解压源码...');
  if (onProgress) onProgress({ phase: 'extracting', percent: 80, message: '正在解压源码...' });
  await extractZip(zipPath, extractDir);

  // 解压后目录名是 llama.cpp-master，重命名为 llama.cpp-source
  const extracted = path.join(extractDir, 'llama.cpp-master');
  if (fs.existsSync(sourceDir)) { try { fs.rmSync(sourceDir, { recursive: true, force: true }); } catch (_) {} }
  fs.renameSync(extracted, sourceDir);

  // 清理
  try { fs.unlinkSync(zipPath); } catch (_) {}
  try { fs.rmSync(extractDir, { recursive: true, force: true }); } catch (_) {}

  report('done', 100, '源码下载完成');
  return { sourceDir, scriptPath };
}

// 兼容旧接口：下载转换脚本（现在改为下载完整源码）
async function downloadConvertScript(installDir, onProgress) {
  const { scriptPath } = await downloadLlamaSource(installDir, onProgress);
  return scriptPath;
}

// ============================================================
// Python 环境检测
// ============================================================
// 异步检测 Python（不阻塞主进程，import torch 可能耗时数秒）
async function detectPython() {
  const { exec } = require('child_process');
  const candidates = ['python', 'python3', 'py'];
  for (const cmd of candidates) {
    try {
      const v = await new Promise((resolve, reject) => {
        exec(`${cmd} --version`, { encoding: 'utf-8', windowsHide: true, timeout: 5000 }, (err, stdout, stderr) => {
          if (err) reject(err); else resolve((stdout || stderr || '').trim());
        });
      });
      if (/Python\s+3/i.test(v)) {
        // 检测依赖（异步，超时 15 秒，torch 首次 import 较慢）
        let hasDeps = false;
        try {
          await new Promise((resolve, reject) => {
            exec(`${cmd} -c "import torch; import transformers"`, { encoding: 'utf-8', windowsHide: true, timeout: 15000 }, (err) => {
              if (err) reject(err); else resolve();
            });
          });
          hasDeps = true;
        } catch (_) {}
        return { available: true, command: cmd, hasDeps, version: v };
      }
    } catch (_) {}
  }
  return { available: false };
}

// 确保转换所需 Python 依赖都已安装（缺失时自动 pip install）
async function ensurePythonDeps(pythonCmd, onProgress) {
  const required = ['torch', 'transformers', 'sentencepiece', 'protobuf'];
  const missing = [];
  for (const pkg of required) {
    try {
      await new Promise((resolve, reject) => {
        const proc = spawn(pythonCmd, ['-c', `import ${pkg}`], { windowsHide: true });
        proc.on('close', (code) => { code === 0 ? resolve() : reject(); });
        proc.on('error', reject);
      });
    } catch (_) { missing.push(pkg); }
  }
  if (missing.length === 0) return true;
  if (onProgress) onProgress({ phase: 'install-deps', percent: -1, message: `正在安装缺失依赖: ${missing.join(', ')}...` });
  try {
    await new Promise((resolve, reject) => {
      const proc = spawn(pythonCmd, ['-m', 'pip', 'install', ...missing, '--quiet'], { windowsHide: true });
      let stderr = '';
      proc.stderr.on('data', (d) => { stderr += d; });
      proc.on('close', (code) => { code === 0 ? resolve() : reject(new Error('pip install failed: ' + stderr.slice(-200))); });
      proc.on('error', reject);
    });
    return true;
  } catch (e) {
    if (onProgress) onProgress({ phase: 'install-deps', percent: -1, message: '依赖安装失败: ' + e.message });
    return false;
  }
}

async function convertHfToGguf(modelDir, outPath, pythonCmd, scriptDir, onProgress) {
  // 兜底：传入的是文件时取其父目录（convert 脚本需要模型目录）
  if (fs.existsSync(modelDir) && fs.statSync(modelDir).isFile()) {
    modelDir = path.dirname(modelDir);
  }

  // 一次性下载完整源码（含所有依赖）
  const { sourceDir, scriptPath } = await downloadLlamaSource(scriptDir, onProgress);

  // 确保 Python 依赖（torch/transformers/sentencepiece/protobuf）都已安装
  const depsOk = await ensurePythonDeps(pythonCmd, onProgress);
  if (!depsOk) throw new Error('Python 依赖安装失败，请手动执行: pip install torch transformers sentencepiece protobuf');

  report('converting', 5, '正在转换...');
  return new Promise((resolve, reject) => {
    const args = [scriptPath, modelDir, '--outfile', outPath];
    // PYTHONPATH 包含源码根目录和 gguf-py 目录，确保 import gguf / conversion 等都能找到
    const ggufPyDir = path.join(sourceDir, 'gguf-py');
    const env = {
      ...process.env,
      PYTHONPATH: [sourceDir, ggufPyDir, process.env.PYTHONPATH || ''].filter(Boolean).join(path.delimiter),
    };
    const proc = spawn(pythonCmd, args, { windowsHide: true, env, cwd: sourceDir });
    let stderr = '', stdout = '';
    proc.stdout.on('data', (d) => {
      stdout += d;
      const lines = d.toString().split('\n').filter(l => l.trim());
      for (const line of lines) { if (onProgress) onProgress({ phase: 'converting', percent: -1, message: line.slice(0, 120) }); }
    });
    proc.stderr.on('data', (d) => { stderr += d; });
    proc.on('close', (code) => {
      if (code === 0 && fs.existsSync(outPath)) { report('done', 100, '转换完成'); resolve(outPath); }
      else reject(new Error('转换失败（退出码 ' + code + '）: ' + (stderr || stdout).slice(-500)));
    });
    proc.on('error', reject);
  });
}

// ============================================================
// 工具状态汇总
// ============================================================
async function checkTools(installDir) {
  const tools = {};

  // llama-server
  const llamaPath = findExeInDir(installDir, 'llama-server') || (() => {
    try { return execSync('where llama-server', { encoding: 'utf-8', windowsHide: true }).trim().split('\n')[0]; } catch (_) { return null; }
  })();
  tools.llamaServer = {
    installed: !!llamaPath,
    path: llamaPath,
    hasQuantize: !!findExeInDir(installDir, 'llama-quantize'),
    hasCli: !!findExeInDir(installDir, 'llama-cli'),
  };

  // convert script
  const scriptPath = path.join(installDir, 'convert_hf_to_gguf.py');
  tools.convertScript = { installed: fs.existsSync(scriptPath), path: scriptPath };

  // Python
  tools.python = await detectPython();

  // installDir
  tools.installDir = installDir;

  return tools;
}

module.exports = {
  setProgressCallback,
  downloadLlamaServer,
  downloadConvertScript,
  downloadLlamaSource,
  detectPython,
  convertHfToGguf,
  checkTools,
  getLatestLlamaReleaseUrl,
  testMirrorConnectivity,
  findFastestMirror,
};
