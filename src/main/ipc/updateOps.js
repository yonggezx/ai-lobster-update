const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { app } = require('electron');

// ========== 更新源配置 ==========
// 更新源使用 GitHub。注意：默认分支是 main，不是 master——写错会 404。
const GITHUB_OWNER = 'yonggezx';
const GITHUB_REPO = 'fuling-shijie-update';
const GITHUB_BRANCH = 'main';

// ★ 外链滥用规避：raw.githubusercontent.com 被 GitHub 官方明确声明「不是 CDN」，
//   拿它给客户端当更新源属于灰色用法，量大有被限流/封禁的风险。
//   所以所有链接统一以 raw 为「规范形式」（便于生成等价地址），实际请求按下面顺序取用：
//     1) GitHub Pages  —— 官方静态托管服务，本就是给公开分发用的，零滥用风险（首选）
//     2) jsDelivr      —— GitHub 官方合作 CDN，允许生产外链（兜底；有 7 天缓存，见下）
//     3) raw           —— 仅在上面两者都不可用时救急
//   jsDelivr 缓存提醒：它按 URL 缓存 7 天，若清单内容变了而 URL 没变，客户端会拿到旧数据。
//   发布新版时若必须走 jsDelivr，请在清单路径里带上版本号（如 update/beta.json?v=1.0.8 查询串会绕过缓存）。
const PAGES_BASE = `https://${GITHUB_OWNER}.github.io/${GITHUB_REPO}`;
const RAW_BASE = `https://raw.githubusercontent.com/${GITHUB_OWNER}/${GITHUB_REPO}/${GITHUB_BRANCH}`;

const UPDATE_META_URL = `${RAW_BASE}/update/latest.json`;
const BETA_META_URL = `${RAW_BASE}/update/beta.json`;
const FULL_INSTALL_URL = `${RAW_BASE}/update/full-install.json`;

// ========== 系统代理支持 ==========
let _proxyAgent = null;
function getWindowsSystemProxy() {
  try {
    const { execSync } = require('child_process');
    const out = execSync('reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable', { encoding: 'utf-8', windowsHide: true });
    if (!/0x1/.test(out)) return null;
    const out2 = execSync('reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyServer', { encoding: 'utf-8', windowsHide: true });
    const m = out2.match(/ProxyServer\s+REG_SZ\s+(\S+)/);
    if (m && m[1]) {
      let p = m[1];
      if (!/^https?:\/\//i.test(p)) p = 'http://' + p;
      return p;
    }
  } catch (e) {}
  return null;
}
function getProxyAgent() {
  const proxy = getWindowsSystemProxy();
  if (!proxy) return null;
  if (_proxyAgent && _proxyAgent._url === proxy) return _proxyAgent.agent;
  try {
    const { HttpsProxyAgent } = require('https-proxy-agent');
    const agent = new HttpsProxyAgent(proxy);
    _proxyAgent = { _url: proxy, agent };
    return agent;
  } catch (e) { return null; }
}

const patchesDir = path.join(app.getPath('userData'), 'patches');
const versionOverrideFile = path.join(patchesDir, 'version-override.json');
const appliedFile = path.join(patchesDir, 'applied.json');
const pendingFile = path.join(patchesDir, 'pending.json');
const updateStateFile = path.join(patchesDir, 'update-state.json');

if (!fs.existsSync(patchesDir)) fs.mkdirSync(patchesDir, { recursive: true });

// 启动时激活待生效的补丁（确保补丁必须重启后才生效）
function activatePendingPatches() {
  try {
    if (!fs.existsSync(pendingFile)) return;
    const pending = JSON.parse(fs.readFileSync(pendingFile, 'utf-8'));
    const vers = pending.versions || (pending.version ? [pending.version] : []);
    if (vers.length === 0) { fs.unlinkSync(pendingFile); return; }
    // 全部写入 applied.json
    let applied = [];
    if (fs.existsSync(appliedFile)) {
      try { applied = JSON.parse(fs.readFileSync(appliedFile, 'utf-8')); } catch (e) {}
    }
    for (const v of vers) {
      if (!applied.includes(v)) applied.push(v);
    }
    fs.writeFileSync(appliedFile, JSON.stringify(applied));
    // version-override 设为最新版本，并记录该版本补丁的 sha256
    const latest = vers.sort((a, b) => compareVersions(b, a))[0];
    const latestSha = (pending.sha256 && pending.sha256[latest]) || '';
    setVersionOverride(latest, latestSha);
    // 删除 pending
    fs.unlinkSync(pendingFile);
    console.log('[Update] 待生效补丁已激活:', vers.join(', '), '→ 当前版本', latest);
  } catch (e) { console.error('[Update] 激活待生效补丁失败:', e.message); }
}
activatePendingPatches();

function getCurrentVersion() {
  try {
    // 待生效补丁（已下载但未重启）也视为当前版本，避免重复提示更新
    if (fs.existsSync(pendingFile)) {
      const data = JSON.parse(fs.readFileSync(pendingFile, 'utf-8'));
      // 兼容旧格式 { version } 和新格式 { versions: [...] }
      const vers = data.versions || (data.version ? [data.version] : []);
      if (vers.length > 0) {
        // 返回最新的待生效版本
        return vers.sort((a, b) => compareVersions(b, a))[0];
      }
    }
    if (fs.existsSync(versionOverrideFile)) {
      const data = JSON.parse(fs.readFileSync(versionOverrideFile, 'utf-8'));
      if (data.version) return data.version;
    }
  } catch (e) {}
  return app.getVersion();
}

function setVersionOverride(version, sha256) {
  const data = { version, updatedAt: Date.now() };
  if (sha256) data.sha256 = sha256;
  fs.writeFileSync(versionOverrideFile, JSON.stringify(data));
}

// 统一内容指纹格式：历史清单里有的字段叫 sha256（裸 hex），有的叫 checksum（"sha256:hex" 带前缀）。
// 一律归一化成「裸 hex 小写」，避免字段名/前缀不同导致比较时永远不相等。
function normalizeHash(value) {
  if (!value) return '';
  return String(value).replace(/^sha256:/i, '').replace(/^md5:/i, '').trim().toLowerCase();
}

// 读取补丁条目 / 补丁信息声明的内容指纹（兼容 checksum 与 sha256 两种字段名）
function patchContentHash(patchInfo) {
  return normalizeHash(patchInfo && (patchInfo.checksum || patchInfo.sha256));
}

function getInstalledSha256() {
  try {
    if (fs.existsSync(versionOverrideFile)) {
      const data = JSON.parse(fs.readFileSync(versionOverrideFile, 'utf-8'));
      return normalizeHash(data.sha256);
    }
  } catch (e) {}
  return '';
}

function isBetaVersion(version) {
  if (!version) return false;
  const v = version.toLowerCase();
  return v.includes('beta') || v.includes('alpha') || v.includes('rc') || v.includes('preview') || v.split('.').length > 3;
}

function getMetaUrl() {
  return isBetaVersion(getCurrentVersion()) ? BETA_META_URL : UPDATE_META_URL;
}

function compareVersions(a, b) {
  const pa = String(a).replace(/[^0-9.]/g, '').split('.').map(Number);
  const pb = String(b).replace(/[^0-9.]/g, '').split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const da = pa[i] || 0, db = pb[i] || 0;
    if (da > db) return 1;
    if (da < db) return -1;
  }
  return 0;
}

// ========== 候选源生成（外链滥用规避的核心）==========
// 仓库内所有链接都以 raw.githubusercontent.com 形式存储（规范形式），
// 这里在请求前把它翻译成更合规的等价地址。顺序即优先级：
//   1. GitHub Pages（官方静态托管，首选）
//   2. jsDelivr（官方合作 CDN）
//   3. raw 直连 / 第三方加速镜像（救急）
// 实测（2026-09-03）：ghproxy.com 已失效（ECONNRESET）、mirror.ghproxy.com 域名不存在、
// download.nuaa.cf 超时、gh.api.99988866.xyz 握手失败，故第三方镜像只保留两个可用的。
const GH_MIRRORS = [
  { name: 'gh-proxy', prefix: 'https://gh-proxy.com/' },
  { name: 'ghproxy-net', prefix: 'https://ghproxy.net/' }
];

// raw 链接 → 各源的等价地址。非 raw 链接（GitHub API 等）原样返回。
function buildUrlCandidates(url) {
  const m = String(url).match(/^https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/);
  if (!m) return [url];
  const [, owner, repo, branch, filePath] = m;
  const list = [
    `https://${owner}.github.io/${repo}/${filePath}`,                      // Pages：官方托管，首选
    `https://cdn.jsdelivr.net/gh/${owner}/${repo}@${branch}/${filePath}`,  // jsDelivr：官方合作 CDN
    ...GH_MIRRORS.map(mr => mr.prefix + url),                              // 第三方加速镜像
    url                                                                     // raw 直连：最后救急
  ];
  return list.filter((u, i) => list.indexOf(u) === i);
}

// ========== 元数据缓存（削减外链请求量）==========
// 每次启动都打一次外链，用户量上来后请求数很可观，容易被当成滥用。两层削减：
//   1) TTL：同一 URL 在 TTL 内直接读本地缓存，完全不发请求
//   2) 条件请求：带 If-None-Match / If-Modified-Since，未变更时服务端回 304，几乎不占配额
// 5 分钟是"用户点了检查更新要有反应"和"别拿外链当轮询接口"之间的折中。
const META_CACHE_TTL_MS = 5 * 60 * 1000;
const metaCacheFile = path.join(patchesDir, 'meta-cache.json');

function readMetaCache() {
  try { return JSON.parse(fs.readFileSync(metaCacheFile, 'utf-8')); } catch (e) { return {}; }
}
function writeMetaCache(cache) {
  try { fs.writeFileSync(metaCacheFile, JSON.stringify(cache)); } catch (e) {}
}

// 单次请求：带超时、自动跟随 302、支持条件请求
function fetchJsonOnce(url, timeoutMs, conditional) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const headers = { 'User-Agent': 'fuling-shijie-updater' };
    if (conditional) {
      if (conditional.etag) headers['If-None-Match'] = conditional.etag;
      if (conditional.lastModified) headers['If-Modified-Since'] = conditional.lastModified;
    }
    const opts = { headers };
    const agent = getProxyAgent();
    if (agent) opts.agent = agent;
    const req = client.get(url, opts, (res) => {
      clearTimeout(connectWatchdog);
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return fetchJsonOnce(res.headers.location, timeoutMs).then(resolve).catch(reject);
      }
      // 304 = 内容没变，直接用缓存，本次几乎不消耗配额
      if (res.statusCode === 304) {
        res.resume();
        return resolve({ notModified: true });
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error('HTTP ' + res.statusCode));
      }
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(data); } catch (e) { return reject(new Error('JSON parse error')); }
        resolve({
          data: parsed,
          etag: res.headers.etag,
          lastModified: res.headers['last-modified']
        });
      });
    });
    // ★ 连接看门狗：req.setTimeout 只统计 socket 空闲，连接建立前不生效。
    //   实测 raw.githubusercontent.com 偶发在握手阶段卡 60 秒，必须单独限时。
    const connectWatchdog = setTimeout(() => {
      try { req.destroy(new Error('连接超时（15 秒未收到响应）')); } catch (e) {}
    }, Math.min(timeoutMs || 15000, 15000));
    // ★ 必须设超时：否则网络不可达时会一直挂着，界面永远停在"检查更新中"
    req.setTimeout(timeoutMs || 15000, () => {
      req.destroy(new Error('请求超时'));
    });
    req.on('error', (e) => { clearTimeout(connectWatchdog); reject(e); });
  });
}

// 多源回退 + 缓存：某个源挂了自动换下一个，全挂才抛错
async function fetchJson(url) {
  const cache = readMetaCache();
  const entry = cache[url];
  const now = Date.now();

  // 1) TTL 内直接命中缓存，一个请求都不发
  if (entry && entry.data !== undefined && (now - (entry.fetchedAt || 0)) < META_CACHE_TTL_MS) {
    return entry.data;
  }

  const candidates = buildUrlCandidates(url);
  let lastErr = null;
  for (let i = 0; i < candidates.length; i++) {
    try {
      // 条件头只在首选源上用：不同源的 ETag 不一定通用，避免在备用源上误判 304
      const r = await fetchJsonOnce(candidates[i], 15000, i === 0 ? entry : null);
      if (r.notModified && entry) {
        entry.fetchedAt = now;
        cache[url] = entry;
        writeMetaCache(cache);
        return entry.data;
      }
      cache[url] = { data: r.data, etag: r.etag, lastModified: r.lastModified, fetchedAt: now };
      writeMetaCache(cache);
      return r.data;
    } catch (e) {
      lastErr = e;
      // 404 只记一行普通日志，别刷屏。注意不能因为 404 就放弃换源——
      // Pages 重新部署期间会短暂 404，而 jsDelivr 上同一文件可能已经好了。
      const level = /HTTP 404/.test(e.message) ? 'log' : 'warn';
      console[level]('[Update] 源不可用，尝试下一个:', candidates[i], '→', e.message);
    }
  }
  // 所有源都挂了但本地有旧缓存 → 降级返回，至少界面上还有内容可显示
  if (entry && entry.data !== undefined) {
    console.warn('[Update] 所有更新源均失败，降级使用本地缓存:', url);
    return entry.data;
  }
  throw lastErr || new Error('所有更新源均不可用');
}

// 下载也走多源：直连失败逐个换镜像（补丁体积不大，重试代价可接受）
async function downloadWithFallback(url, destPath, onProgress) {
  const candidates = buildUrlCandidates(url);
  let lastErr = null;
  for (let i = 0; i < candidates.length; i++) {
    try {
      if (i > 0) console.log('[Update] 换源重试下载:', candidates[i]);
      return await downloadSingleFile(candidates[i], destPath, onProgress);
    } catch (e) {
      lastErr = e;
      try { if (fs.existsSync(destPath)) fs.unlinkSync(destPath); } catch (ex) {}
      console.warn('[Update] 下载失败:', candidates[i], '→', e.message);
    }
  }
  throw lastErr || new Error('所有下载源均不可用');
}

async function checkForUpdate() {
  const current = getCurrentVersion();
  try {
    const meta = await fetchJson(getMetaUrl());
    // 完整包信息：从独立的 full-install.json 获取，所有客户端通用
    let fullInstallInfo = null;
    try {
      const fullData = await fetchJson(FULL_INSTALL_URL);
      if (fullData && fullData.fullInstall) {
        fullInstallInfo = { ...fullData.fullInstall, from: current, to: fullData.fullInstall.version };
      }
    } catch (e) {}
    // 同版本号但补丁内容已更新（内容指纹不同）→ 也提示更新（"小补丁不改版本号"）
    if (compareVersions(current, meta.latestVersion) === 0) {
      const installedSha = getInstalledSha256();
      const allPatches = meta.patches || [];
      // ★ 原来只认 p.sha256，而清单里字段是 checksum（"sha256:xxx"），
      //   导致 latestPatch 恒为 undefined → 同版本修复包永远检测不到 → 一直报"已是最新版本"。
      // 同版本刷新补丁：必须 from === to === current（避免误匹配到 1.0.4→1.0.5 这类已应用补丁）
      const latestPatch = allPatches.find(p =>
        p.to === meta.latestVersion &&
        (!p.from || p.from === current) &&
        patchContentHash(p)
      );
      const latestHash = patchContentHash(latestPatch);
      // ★ 允许 installedSha 为空：全新安装（从未打过补丁、无指纹记录）也能收到同版本修复包；
      //   打完补丁会记录指纹，因此不会重复提示。
      if (latestPatch && latestHash && latestHash !== installedSha) {
        return {
          success: true, hasUpdate: true, currentVersion: current,
          latestVersion: meta.latestVersion, releaseDate: meta.releaseDate || '',
          changes: meta.changes || '', patches: [latestPatch], ignored: false,
          channel: meta.channel || (isBetaVersion(meta.latestVersion) ? 'beta' : 'stable'),
          sameVersionRefresh: true, fullInstall: fullInstallInfo
        };
      }
      // 无同版本补丁，但完整包版本更高 → 提示完整包更新
      if (fullInstallInfo && compareVersions(fullInstallInfo.version, current) > 0) {
        return {
          success: true, hasUpdate: true, currentVersion: current,
          latestVersion: fullInstallInfo.version, releaseDate: fullInstallInfo.releaseDate || '',
          changes: fullInstallInfo.changes || '', patches: [fullInstallInfo], ignored: false,
          channel: meta.channel || (isBetaVersion(fullInstallInfo.version) ? 'beta' : 'stable'),
          requiresFullInstall: true, isFullPackage: true, fullInstall: fullInstallInfo
        };
      }
      return { success: true, hasUpdate: false, currentVersion: current, latestVersion: meta.latestVersion, fullInstall: fullInstallInfo };
    }
    if (compareVersions(current, meta.latestVersion) > 0) {
      // 当前版本高于补丁最新版，但完整包版本更高 → 提示完整包更新
      if (fullInstallInfo && compareVersions(fullInstallInfo.version, current) > 0) {
        return {
          success: true, hasUpdate: true, currentVersion: current,
          latestVersion: fullInstallInfo.version, releaseDate: fullInstallInfo.releaseDate || '',
          changes: fullInstallInfo.changes || '', patches: [fullInstallInfo], ignored: false,
          channel: meta.channel || (isBetaVersion(fullInstallInfo.version) ? 'beta' : 'stable'),
          requiresFullInstall: true, isFullPackage: true, fullInstall: fullInstallInfo
        };
      }
      return { success: true, hasUpdate: false, currentVersion: current, latestVersion: meta.latestVersion, fullInstall: fullInstallInfo };
    }
    const allPatches = meta.patches || [];
    // 1. 优先直连补丁（current -> latest）
    const direct = allPatches.find(p => p.from === current && p.to === meta.latestVersion);
    if (direct) {
      return {
        success: true, hasUpdate: true, currentVersion: current,
        latestVersion: meta.latestVersion, releaseDate: meta.releaseDate || '',
        changes: meta.changes || '', patches: [direct], ignored: false,
        channel: meta.channel || (isBetaVersion(meta.latestVersion) ? 'beta' : 'stable'),
        requiresFullInstall: !!direct.requiresFullInstall, fullInstall: fullInstallInfo
      };
    }
    // 2. 构建连续版本链
    const chain = [];
    let cursor = current;
    const maxSteps = allPatches.length + 1;
    for (let step = 0; step < maxSteps; step++) {
      const candidates = allPatches.filter(p => p.from === cursor && compareVersions(p.to, cursor) > 0);
      if (candidates.length === 0) break;
      candidates.sort((a, b) => compareVersions(b.to, a.to));
      const next = candidates[0];
      chain.push(next);
      cursor = next.to;
      if (compareVersions(cursor, meta.latestVersion) >= 0) break;
    }
    if (chain.length > 0 && compareVersions(cursor, meta.latestVersion) < 0) {
      const finalJump = allPatches.find(p => p.from === cursor && p.to === meta.latestVersion);
      if (finalJump) { chain.push(finalJump); cursor = finalJump.to; }
    }
    if (chain.length === 0) {
      if (fullInstallInfo) {
        return {
          success: true, hasUpdate: true, currentVersion: current,
          latestVersion: fullInstallInfo.version, releaseDate: fullInstallInfo.releaseDate || '',
          changes: fullInstallInfo.changes || '', patches: [fullInstallInfo], ignored: false,
          channel: meta.channel || (isBetaVersion(fullInstallInfo.version) ? 'beta' : 'stable'),
          requiresFullInstall: true, isFullPackage: true, fullInstall: fullInstallInfo
        };
      }
      return { success: true, hasUpdate: false, currentVersion: current, latestVersion: meta.latestVersion, note: '无可用更新路径', fullInstall: fullInstallInfo };
    }
    return {
      success: true, hasUpdate: true, currentVersion: current,
      latestVersion: meta.latestVersion, releaseDate: meta.releaseDate || '',
      changes: meta.changes || '', patches: chain, ignored: false,
      channel: meta.channel || (isBetaVersion(meta.latestVersion) ? 'beta' : 'stable'),
      requiresFullInstall: chain.some(p => p.requiresFullInstall),
      multiStep: chain.length > 1, fullInstall: fullInstallInfo
    };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

async function downloadSingleFile(url, destPath, onProgress) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const headers = { 'User-Agent': 'fuling-shijie-updater' };
    const reqOpts = { headers };
    const agent = getProxyAgent();
    if (agent) reqOpts.agent = agent;
    const req = client.get(url, reqOpts, (res) => {
      clearTimeout(connectWatchdog); // 收到响应头，解除连接看门狗
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        // 302 跳转到 CDN 真实地址，递归下载
        downloadSingleFile(res.headers.location, destPath, onProgress).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) { try { fs.unlinkSync(destPath); } catch(e){} return reject(new Error('HTTP ' + res.statusCode)); }
      const total = parseInt(res.headers['content-length']) || 0;
      let downloaded = 0;
      const stream = fs.createWriteStream(destPath);
      res.on('data', (chunk) => {
        downloaded += chunk.length;
        if (onProgress) onProgress({ downloaded, total });
      });
      res.pipe(stream);
      stream.on('finish', () => {
        stream.close(() => resolve({ size: downloaded }));
      });
      stream.on('error', (e) => { try { fs.unlinkSync(destPath); } catch(ex){} reject(e); });
    });
    // ★ 连接看门狗：req.setTimeout 统计的是 socket 空闲时间，连接建立前不生效，
    //   实测遇到过 DNS/握手阶段卡 60 秒不动的情况，必须单独盯住「多久没拿到响应头」。
    const connectWatchdog = setTimeout(() => {
      try { req.destroy(new Error('连接超时（20 秒未收到响应）')); } catch (e) {}
    }, 20000);
    // 空闲超时：只在连接卡死或长时间断流时触发，正常下载过程持续有数据不会中断
    req.setTimeout(30000, () => {
      clearTimeout(connectWatchdog);
      try { fs.unlinkSync(destPath); } catch(e){}
      req.destroy(new Error('下载超时（30 秒无数据传输）'));
    });
    req.on('error', (e) => { clearTimeout(connectWatchdog); reject(e); });
  });
}

async function downloadPatch(patchInfo, onProgress) {
  const isExe = patchInfo.isFullPackage || (patchInfo.url && patchInfo.url.endsWith('.exe'));
  const ext = isExe ? '.exe' : '.zip';
  const tmpFile = path.join(patchesDir, `download_${Date.now()}${ext}`);

  const primaryUrl = patchInfo.url;

  // 单文件下载
  await downloadWithFallback(primaryUrl, tmpFile, ({ downloaded, total }) => {
    if (onProgress) {
      if (total) onProgress(Math.min(99, Math.round(downloaded / total * 100)));
      else onProgress(Math.min(99, Math.round(downloaded / (1024 * 1024) * 10)));
    }
  });
  if (onProgress) onProgress(100);
  return { zipPath: tmpFile, size: fs.statSync(tmpFile).size };
}

// ========== 完整包下载中心 ==========
let downloadsDir = path.join(app.getPath('userData'), 'downloads');
if (!fs.existsSync(downloadsDir)) fs.mkdirSync(downloadsDir, { recursive: true });

function setDownloadsDir(dir) {
  downloadsDir = dir;
  if (!fs.existsSync(downloadsDir)) fs.mkdirSync(downloadsDir, { recursive: true });
}

function getDownloadsDir() { return downloadsDir; }

/**
 * 下载完整安装包到持久化目录，分阶段汇报进度
 * @param {object} fullInstall - fullInstall 信息（version, url, checksum, changes）
 * @param {function} onProgress - 进度回调 { phase, percent, message }
 * @returns {Promise<{installerPath, size, version}>}
 */
async function downloadFullPackage(fullInstall, onProgress) {
  const version = fullInstall.version || 'unknown';
  const installerName = `AiLobster-Setup-v${version}.exe`;
  const installerPath = path.join(downloadsDir, installerName);
  // ★ 先下载到临时文件，全部完成并校验通过后再重命名为正式安装包，
  //   避免下载中途/损坏的 .exe 被下载中心误判为「已完成」，点安装导致闪退。
  const tmpPath = path.join(downloadsDir, `.dl-${Date.now()}-${installerName}`);

  // 如果已存在同名文件，先删除
  if (fs.existsSync(installerPath)) {
    try { fs.unlinkSync(installerPath); } catch(e){}
  }

  try {
    // 单文件下载到临时文件
    if (onProgress) onProgress({ phase: 'downloading', percent: 0, message: '正在下载...' });
    const fullUrl = fullInstall.url;
    await downloadWithFallback(fullUrl, tmpPath, ({ downloaded, total }) => {
      if (onProgress) {
        const percent = total ? Math.min(99, Math.round(downloaded / total * 100)) : Math.min(99, Math.round(downloaded / (1024 * 1024) * 10));
        onProgress({ phase: 'downloading', percent, message: '正在下载...' });
      }
    });
    if (fullInstall.checksum) {
      if (onProgress) onProgress({ phase: 'verifying', percent: 100, message: '正在校验安装包完整性...' });
      if (!verifyChecksum(tmpPath, fullInstall.checksum)) {
        throw new Error('安装包校验失败，文件可能已损坏');
      }
    }

    // ★ 全部完成且校验通过后，再重命名为正式安装包名（此时才会出现在下载记录中）
    fs.renameSync(tmpPath, installerPath);
    if (onProgress) onProgress({ phase: 'complete', percent: 100, message: '下载完成' });
    return { installerPath, size: fs.statSync(installerPath).size, version };
  } catch (e) {
    try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (ex) {}
    throw e;
  }
}

/** 获取已下载的安装包列表 */
function getDownloadedPackages() {
  const list = [];
  if (!fs.existsSync(downloadsDir)) return list;
  for (const f of fs.readdirSync(downloadsDir)) {
    if (f.endsWith('.exe') && !f.startsWith('.')) {
      const fullPath = path.join(downloadsDir, f);
      try {
        const stat = fs.statSync(fullPath);
        list.push({
          name: f,
          path: fullPath,
          size: stat.size,
          sizeMB: (stat.size / 1024 / 1024).toFixed(2),
          createdAt: stat.birthtime.toISOString()
        });
      } catch(e){}
    }
  }
  return list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

/** 删除已下载的安装包 */
function deleteDownloadedPackage(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      return { success: true };
    }
    return { success: false, error: '文件不存在' };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function verifyChecksum(filePath, expected) {
  const crypto = require('crypto');
  if (!expected) return true;
  const algo = expected.startsWith('sha256:') ? 'sha256' : 'md5';
  const hash = expected.replace(/^sha256:/, '').replace(/^md5:/, '');
  const actual = crypto.createHash(algo).update(fs.readFileSync(filePath)).digest('hex');
  return actual.toLowerCase() === hash.toLowerCase();
}

/**
 * ★ 校验数据包：检查已生效的补丁层文件是否与各自 manifest 声明一致。
 *
 * 用途：支撑「小补丁不改版本号」的场景——版本号不变时，无法靠版本号判断是否需要修复，
 * 必须改为校验数据包本身（清单声明的文件是否存在、内容哈希是否匹配）。
 * 一旦文件缺失/损坏/被篡改，上层可据此提示用户重新应用修复包（自愈）。
 *
 * @returns {{ok:boolean, issues:Array<{version:string,file:string,reason:string}>, checkedVersions:string[], error?:string}}
 */
function verifyDataPackage() {
  const crypto = require('crypto');
  const issues = [];
  const checkedVersions = [];
  try {
    let applied = [];
    if (fs.existsSync(appliedFile)) {
      try { applied = JSON.parse(fs.readFileSync(appliedFile, 'utf-8')); } catch (e) { applied = []; }
    }
    for (const ver of applied) {
      const dir = path.join(patchesDir, ver);
      const manifestPath = path.join(dir, 'manifest.json');
      if (!fs.existsSync(manifestPath)) {
        issues.push({ version: String(ver), file: 'manifest.json', reason: 'manifest 缺失' });
        continue;
      }
      let manifest;
      try {
        manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8').replace(/^\uFEFF/, ''));
      } catch (e) {
        issues.push({ version: String(ver), file: 'manifest.json', reason: 'manifest 解析失败' });
        continue;
      }
      checkedVersions.push(String(ver));
      const files = manifest.files || [];
      const hashes = manifest.fileHashes || null;
      for (const rel of files) {
        const fp = path.join(dir, rel);
        if (!fs.existsSync(fp)) {
          issues.push({ version: String(ver), file: rel, reason: '文件缺失' });
          continue;
        }
        // 仅在 manifest 声明了逐文件哈希时才做内容校验（兼容老补丁包）
        if (hashes && hashes[rel]) {
          let actual;
          try {
            actual = crypto.createHash('sha256').update(fs.readFileSync(fp)).digest('hex').toLowerCase();
          } catch (e) {
            issues.push({ version: String(ver), file: rel, reason: '文件读取失败: ' + e.message });
            continue;
          }
          if (actual !== String(hashes[rel]).toLowerCase()) {
            issues.push({ version: String(ver), file: rel, reason: '内容哈希不匹配（可能已损坏或被篡改）' });
          }
        }
      }
    }
  } catch (e) {
    return { ok: false, error: e.message, issues, checkedVersions };
  }
  return { ok: issues.length === 0, issues, checkedVersions };
}

function applyPatch(zipPath, patchInfo) {
  // 完整安装包：不解压，校验后返回，由前端触发安装
  if (patchInfo.isFullPackage) {
    const version = patchInfo.version || patchInfo.to;
    const installerPath = path.join(patchesDir, `installer-${version}.exe`);
    try {
      fs.copyFileSync(zipPath, installerPath);
      fs.unlinkSync(zipPath);
    } catch (e) {
      return { success: false, error: '安装包保存失败: ' + e.message };
    }
    return { success: true, version, isFullPackage: true, installerPath, pendingRestart: true };
  }

  const version = patchInfo.to;
  const targetDir = path.join(patchesDir, version);
  if (fs.existsSync(targetDir)) fs.rmSync(targetDir, { recursive: true, force: true });
  fs.mkdirSync(targetDir, { recursive: true });

  // Extract zip
  const AdmZip = require('adm-zip');
  const zip = new AdmZip(zipPath);
  zip.extractAllTo(targetDir, true);

  // Validate manifest
  const manifestPath = path.join(targetDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    fs.rmSync(targetDir, { recursive: true, force: true });
    return { success: false, error: '补丁包缺少 manifest.json' };
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8').replace(/^\uFEFF/, ''));

  // ★ 检测补丁中是否包含主进程文件（main/ 目录）
  //   主进程代码在启动时加载，必须重启才能生效；渲染进程文件（renderer/）可通过 webRequest 立即覆盖
  const mainDirInPatch = path.join(targetDir, 'main');
  const hasMainFiles = fs.existsSync(mainDirInPatch) && fs.readdirSync(mainDirInPatch).length > 0;
  manifest.requiresRestart = hasMainFiles;
  // 回写 manifest（补充 requiresRestart 字段）
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  // Backup current version
  const current = getCurrentVersion();
  const backupDir = path.join(patchesDir, 'backup', current);
  if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });

  // 写入待生效标记（累积多版本，重启后统一激活）
  let pending = { versions: [], appliedAt: Date.now(), sha256: {} };
  try {
    if (fs.existsSync(pendingFile)) {
      const old = JSON.parse(fs.readFileSync(pendingFile, 'utf-8'));
      pending.versions = old.versions || (old.version ? [old.version] : []);
      pending.sha256 = old.sha256 || {};
    }
  } catch (e) {}
  if (!pending.versions.includes(version)) pending.versions.push(version);
  // ★ 原来只认 patchInfo.sha256，而补丁条目里是 checksum，导致指纹从未被记录，
  //   version-override.json 里没有 sha256，getInstalledSha256() 永远返回空。
  const contentHash = patchContentHash(patchInfo);
  if (contentHash) pending.sha256[version] = contentHash;
  fs.writeFileSync(pendingFile, JSON.stringify(pending));

  // Cleanup download
  try { fs.unlinkSync(zipPath); } catch (e) {}

  return { success: true, version, files: manifest.files || [], requiresRestart: hasMainFiles, pendingRestart: true, pendingVersions: pending.versions };
}

// 运行完整安装包并退出当前程序
function runInstallerAndQuit(installerPath) {
  const { spawn } = require('child_process');
  try {
    // ★ 先校验安装包真实存在且非空：避免下载不完整/无效的文件时，点了安装应用仍闪退
    if (!installerPath || typeof installerPath !== 'string') {
      return { success: false, error: '无效的安装包路径' };
    }
    if (!fs.existsSync(installerPath)) {
      return { success: false, error: '安装包不存在: ' + installerPath };
    }
    const st = fs.statSync(installerPath);
    if (st.size <= 0) {
      return { success: false, error: '安装包为空或未下载完成' };
    }
    // 用 detached PowerShell 启动安装器，等待安装完成后自动删除安装包
    // 父进程退出后 PowerShell 继续运行，安装完成后清理安装包
    const psCmd = `Start-Process -FilePath '${installerPath}' -Wait; Remove-Item -LiteralPath '${installerPath}' -Force -ErrorAction SilentlyContinue`;
    const cleaner = spawn('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', psCmd], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    });
    cleaner.unref();
    // 延迟退出，确保安装程序启动
    setTimeout(() => { app.quit(); }, 500);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

const _patchedSessions = new Set();
function setupPatchOverride(session) {
  if (_patchedSessions.has(session)) return; // 幂等：同一 session 只注册一次
  let applied = [];
  try { if (fs.existsSync(appliedFile)) applied = JSON.parse(fs.readFileSync(appliedFile, 'utf-8')); } catch (e) {}
  if (applied.length === 0) return;

  const versions = [...applied].sort((a, b) => compareVersions(b, a));
  session.webRequest.onBeforeRequest((details, callback) => {
    const url = details.url;
    if (!url.startsWith('file://')) return callback({});
    let filePath;
    try { filePath = decodeURIComponent(url.replace('file:///', '').replace('file://', '')); }
    catch (e) { return callback({}); }
    const idx = filePath.indexOf('renderer');
    if (idx === -1) return callback({});
    const relPath = filePath.substring(idx);
    for (const ver of versions) {
      const patchFile = path.join(patchesDir, ver, relPath);
      if (fs.existsSync(patchFile)) {
        return callback({ redirectURL: 'file:///' + patchFile.replace(/\\/g, '/') });
      }
    }
    callback({});
  });
  _patchedSessions.add(session);
  console.log('[PatchOverride] enabled:', versions.join(', '));
}

function getUpdateState() {
  try { if (fs.existsSync(updateStateFile)) return JSON.parse(fs.readFileSync(updateStateFile, 'utf-8')); } catch (e) {}
  return { ignoredVersions: [], ignoreUntil: null };
}

function saveUpdateState(state) {
  fs.writeFileSync(updateStateFile, JSON.stringify(state));
}

function ignoreVersion(version, type) {
  const state = getUpdateState();
  if (type === 'today') {
    const t = new Date(); t.setHours(23, 59, 59, 999);
    state.ignoreUntil = t.getTime();
  } else {
    if (!state.ignoredVersions.includes(version)) state.ignoredVersions.push(version);
  }
  saveUpdateState(state);
}

function isVersionIgnored(version) {
  const state = getUpdateState();
  if (state.ignoredVersions.includes(version)) return true;
  if (state.ignoreUntil && Date.now() < state.ignoreUntil) return true;
  return false;
}

function getBackupList() {
  const backupRoot = path.join(patchesDir, 'backup');
  if (!fs.existsSync(backupRoot)) return [];
  return fs.readdirSync(backupRoot).filter(d => fs.statSync(path.join(backupRoot, d)).isDirectory());
}

function rollbackToVersion(version) {
  const backupDir = path.join(patchesDir, 'backup', version);
  if (!fs.existsSync(backupDir)) return { success: false, error: '备份不存在' };
  // 清理待生效补丁
  try { if (fs.existsSync(pendingFile)) fs.unlinkSync(pendingFile); } catch (e) {}
  setVersionOverride(version);
  return { success: true };
}

// 独立获取完整包信息（从 GitHub Releases 获取最新安装包）
async function getFullInstall() {
  try {
    // ★ 不用 /releases/latest：它只返回「正式 Release」，仓库里只有 pre-release 时直接 404
    //   （这就是之前"检查更新失败 / GitHub API 404"的来源）。改用列表接口自己挑。
    const apiUrl = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases?per_page=10`;
    const data = await fetchJson(apiUrl);
    const releases = (Array.isArray(data) ? data : [data])
      .filter(r => r && !r.draft && Array.isArray(r.assets) && r.assets.length);
    const pickExe = (r) => r.assets.find(a => a.name && a.name.endsWith('.exe'));
    // 优先正式版里带 exe 的；仓库还没发过正式版则退回最新的 pre-release
    const release = releases.find(r => !r.prerelease && pickExe(r)) || releases.find(pickExe);
    if (!release) {
      return { success: true, fullInstall: null };
    }
    const exeAsset = pickExe(release);
    const version = (release.tag_name || '').replace(/^v/, '');
    return {
      success: true,
      fullInstall: {
        version: version,
        url: exeAsset.browser_download_url,
        size: exeAsset.size,
        name: exeAsset.name,
        releaseNotes: release.body || '',
        prerelease: !!release.prerelease
      }
    };
  } catch (e) {
    return { success: false, error: e.message, fullInstall: null };
  }
}

module.exports = {
  getCurrentVersion, setVersionOverride, checkForUpdate, downloadPatch,
  verifyChecksum, verifyDataPackage, applyPatch, setupPatchOverride, getUpdateState,
  ignoreVersion, isVersionIgnored, getBackupList, rollbackToVersion,
  compareVersions, isBetaVersion, getPatchesDir: () => patchesDir,
  downloadFullPackage, getDownloadedPackages, deleteDownloadedPackage,
  runInstallerAndQuit, setDownloadsDir, getDownloadsDir, getFullInstall
};
