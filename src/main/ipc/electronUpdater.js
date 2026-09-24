/**
 * electron-updater 封装模块
 *
 * 使用 electron-updater + GitHub Releases 作为更新源。
 * - 更新元数据通过 api.github.com 获取（非直接外链，避免滥用警告）
 * - 安装包下载通过 objects.githubusercontent.com（GitHub 官方 CDN）
 * - ★ 国内镜像加速：通过 webRequest.onBeforeRequest 将 GitHub 下载请求重定向到国内镜像
 * - 支持双渠道：beta（内测，对应 Pre-release）和 latest（正式，对应 Latest release）
 *
 * 与原有 UpdateOps 的接口保持兼容，IPC 层无需大幅改动。
 */

const { app, session } = require('electron');
const { autoUpdater } = require('electron-updater');
const fs = require('fs');
const path = require('path');

// 渠道配置文件路径
const channelConfigPath = path.join(app.getPath('userData'), 'update-channel.json');
// 镜像配置文件路径
const mirrorConfigPath = path.join(app.getPath('userData'), 'update-mirror.json');

// 内置镜像源列表（按优先级，均为「前缀+原始URL」模式，空前缀表示直连不加速）
// ★ 2026-09-03 实测复核后重排：原列表里 5 个镜像有 4 个已失效——
//   ghproxy.com 连接被重置、mirror.ghproxy.com 域名已不存在、download.nuaa.cf 超时、
//   gh.api.99988866.xyz TLS 握手失败。而 raw.githubusercontent.com / api.github.com 直连本身可达，
//   所以默认走直连，镜像只作为兜底。
const BUILTIN_MIRRORS = [
  { name: 'gh-proxy.org', url: 'https://gh-proxy.org/' },
  { name: 'gh-proxy', url: 'https://gh-proxy.com/' },
  { name: 'ghproxy.net', url: 'https://ghproxy.net/' },
  { name: 'ghproxy', url: 'https://ghproxy.com/' },
  { name: '直连（不加速）', url: '' }
];

// 当前更新状态
let currentState = {
  checking: false,
  downloadProgress: 0,
  updateInfo: null,
  downloaded: false,
  error: null
};

// 镜像配置
let mirrorConfig = {
  enabled: true,
  currentIndex: 0,
  customUrl: ''  // 用户自定义镜像前缀
};

// 事件回调（由 main.js 注册，转发到渲染进程）
let eventCallbacks = {
  onProgress: null,
  onUpdateAvailable: null,
  onUpdateNotAvailable: null,
  onError: null,
  onDownloaded: null
};

// ========== 镜像配置 ==========

function loadMirrorConfig() {
  try {
    if (fs.existsSync(mirrorConfigPath)) {
      const cfg = JSON.parse(fs.readFileSync(mirrorConfigPath, 'utf-8').replace(/^\uFEFF/, ''));
      mirrorConfig = { ...mirrorConfig, ...cfg };
    }
  } catch (e) {
    console.error('[Updater] 读取镜像配置失败:', e.message);
  }
}

function saveMirrorConfig() {
  try {
    fs.writeFileSync(mirrorConfigPath, JSON.stringify(mirrorConfig, null, 2), 'utf-8');
  } catch (e) {
    console.error('[Updater] 保存镜像配置失败:', e.message);
  }
}

function getMirrorList() {
  const list = [...BUILTIN_MIRRORS];
  if (mirrorConfig.customUrl) {
    list.unshift({ name: 'custom', url: mirrorConfig.customUrl });
  }
  return list;
}

function getCurrentMirror() {
  const list = getMirrorList();
  const idx = mirrorConfig.currentIndex % list.length;
  return list[idx];
}

function setMirrorIndex(idx) {
  const list = getMirrorList();
  mirrorConfig.currentIndex = Math.max(0, Math.min(idx, list.length - 1));
  saveMirrorConfig();
  return { success: true, mirror: getCurrentMirror() };
}

function setMirrorEnabled(enabled) {
  mirrorConfig.enabled = !!enabled;
  saveMirrorConfig();
  return { success: true, enabled: mirrorConfig.enabled };
}

function setCustomMirror(url) {
  mirrorConfig.customUrl = url || '';
  mirrorConfig.currentIndex = 0; // 自定义镜像排第一
  saveMirrorConfig();
  return { success: true, mirror: getCurrentMirror() };
}

function getMirrorStatus() {
  return {
    enabled: mirrorConfig.enabled,
    current: getCurrentMirror(),
    list: getMirrorList(),
    currentIndex: mirrorConfig.currentIndex
  };
}

// 切换到下一个镜像（下载失败时调用）
function switchToNextMirror() {
  const list = getMirrorList();
  mirrorConfig.currentIndex = (mirrorConfig.currentIndex + 1) % list.length;
  saveMirrorConfig();
  console.log('[Updater] 镜像切换为:', getCurrentMirror().name);
  return getCurrentMirror();
}

// ========== 渠道配置 ==========

function getChannel() {
  try {
    if (fs.existsSync(channelConfigPath)) {
      const cfg = JSON.parse(fs.readFileSync(channelConfigPath, 'utf-8').replace(/^\uFEFF/, ''));
      return cfg.channel || 'beta';
    }
  } catch (e) {}
  return 'beta';
}

function setChannel(channel) {
  const valid = ['beta', 'latest'];
  const ch = valid.includes(channel) ? channel : 'beta';
  try {
    fs.writeFileSync(channelConfigPath, JSON.stringify({ channel: ch }, null, 2), 'utf-8');
  } catch (e) {}
  autoUpdater.channel = ch;
  return { success: true, channel: ch };
}

// ========== 镜像加速：webRequest 拦截 ==========

function getWindowsSystemProxy() {
  try {
    const { execSync } = require('child_process');
    const out = execSync('reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable', { encoding: 'utf-8', windowsHide: true });
    if (!/0x1/.test(out)) return null;
    const out2 = execSync('reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyServer', { encoding: 'utf-8', windowsHide: true });
    const m = out2.match(/ProxyServer\s+REG_SZ\s+(\S+)/);
    if (m && m[1]) return m[1];
  } catch (e) {}
  return null;
}

function setupMirrorInterceptor() {
  if (!autoUpdater.netSession) {
    console.warn('[Updater] netSession 不可用，跳过镜像加速设置');
    return Promise.resolve();
  }

  // ★ 设置系统代理（让 api.github.com 等所有请求都走代理）
  const sysProxy = getWindowsSystemProxy();
  const proxyPromises = [];
  if (sysProxy) {
    const proxyRules = `http=${sysProxy};https=${sysProxy}`;
    if (autoUpdater.netSession) {
      proxyPromises.push(autoUpdater.netSession.setProxy({ proxyRules}).then(() => console.log('[Updater] netSession 代理已设置')).catch(e => console.warn('[Updater] netSession 代理失败:', e.message)));
    }
    proxyPromises.push(session.defaultSession.setProxy({ proxyRules }).then(() => console.log('[Updater] 默认 session 代理已设置')).catch(e => console.warn('[Updater] 默认 session 代理失败:', e.message)));
    process.env.HTTPS_PROXY = 'http://' + sysProxy;
    process.env.HTTP_PROXY = 'http://' + sysProxy;
    console.log('[Updater] 检测到系统代理:', sysProxy);
  } else {
    console.log('[Updater] 未检测到系统代理');
  }

  autoUpdater.netSession.webRequest.onBeforeRequest((details, callback) => {
    if (!mirrorConfig.enabled) return callback({});

    const url = details.url;
    // 排除已经带镜像前缀的 URL，防止无限叠加
    const allMirrors = [...BUILTIN_MIRRORS];
    if (mirrorConfig.customUrl) allMirrors.push({ name: 'custom', url: mirrorConfig.customUrl });
    // 注意跳过空前缀（直连项），否则 startsWith('') 恒为真，会让所有请求都被误判成"已加速"
    const alreadyMirrored = allMirrors.some(m => m.url && url.startsWith(m.url));
    // 拦截 GitHub 下载相关请求：
    // 1. github.com/.../releases/download/ （Release 资产下载）
    // 2. objects.githubusercontent.com （GitHub CDN 实际下载地址）
    const isGithubDownload = !alreadyMirrored && (
      (url.includes('github.com') && url.includes('/releases/download/')) ||
      url.includes('objects.githubusercontent.com')
    );

    if (isGithubDownload) {
      const mirror = getCurrentMirror();
      // 前缀为空 = 直连，保持原 URL（若重定向到自身会触发无限循环）
      if (!mirror.url) return callback({});
      const redirectUrl = mirror.url + url;
      console.log('[Updater] 镜像加速:', mirror.name, '←', url.substring(0, 80) + '...');
      return callback({ redirectURL: redirectUrl });
    }

    callback({});
  });

  console.log('[Updater] 镜像加速已启用，当前镜像:', getCurrentMirror().name);
  return Promise.all(proxyPromises);
}

// ========== 初始化 ==========

let proxyReady = Promise.resolve();

function init() {
  // 加载镜像配置
  loadMirrorConfig();

  // 不自动下载，由用户手动触发
  autoUpdater.autoDownload = false;
  // 不自动安装，由用户确认后调用 quitAndInstall
  autoUpdater.autoInstallOnAppQuit = false;
  // 开发模式下也允许检查更新（否则会被跳过）
  autoUpdater.forceDevUpdateConfig = true;
  // 设置渠道
  autoUpdater.channel = getChannel();
  // 允许降级（内测版切回正式版时可能需要）
  autoUpdater.allowDowngrade = true;

  // ★ 设置国内镜像加速（必须在 checkForUpdates 之前设置）
  proxyReady = setupMirrorInterceptor();

  // 注册事件
  autoUpdater.on('checking-for-update', () => {
    currentState.checking = true;
    console.log('[Updater] 正在检查更新...');
  });

  autoUpdater.on('update-available', (info) => {
    currentState.checking = false;
    currentState.updateInfo = info;
    currentState.downloaded = false;
    console.log('[Updater] 发现新版本:', info.version);
    if (eventCallbacks.onUpdateAvailable) {
      eventCallbacks.onUpdateAvailable({
        version: info.version,
        releaseName: info.releaseName,
        releaseNotes: info.releaseNotes,
        releaseDate: info.releaseDate,
        files: (info.files || []).map(f => ({ url: f.url, size: f.size }))
      });
    }
  });

  autoUpdater.on('update-not-available', (info) => {
    currentState.checking = false;
    currentState.updateInfo = null;
    console.log('[Updater] 已是最新版本');
    if (eventCallbacks.onUpdateNotAvailable) {
      eventCallbacks.onUpdateNotAvailable({ version: info.version });
    }
  });

  autoUpdater.on('download-progress', (progress) => {
    currentState.downloadProgress = progress.percent;
    if (eventCallbacks.onProgress) {
      eventCallbacks.onProgress({
        percent: Math.round(progress.percent),
        bytesPerSecond: progress.bytesPerSecond,
        total: progress.total,
        transferred: progress.transferred
      });
    }
  });

  autoUpdater.on('update-downloaded', (info) => {
    currentState.downloaded = true;
    currentState.downloadProgress = 100;
    console.log('[Updater] 更新包下载完成:', info.version);
    if (eventCallbacks.onDownloaded) {
      eventCallbacks.onDownloaded({ version: info.version });
    }
  });

  autoUpdater.on('error', (err) => {
    currentState.checking = false;
    currentState.error = err.message;
    console.error('[Updater] 更新错误:', err.message);
    // 下载失败时自动切换镜像（如果是网络错误）
    if (err.message && (err.message.includes('ETIMEDOUT') || err.message.includes('ECONNRESET') ||
        err.message.includes('ENOTFOUND') || err.message.includes('网络') || err.message.includes('timeout'))) {
      if (mirrorConfig.enabled) {
        const next = switchToNextMirror();
        console.log('[Updater] 下载失败，已自动切换镜像:', next.name);
      }
    }
    if (eventCallbacks.onError) {
      eventCallbacks.onError({ message: err.message });
    }
  });

  console.log('[Updater] 初始化完成，渠道:', autoUpdater.channel, '镜像:', mirrorConfig.enabled ? getCurrentMirror().name : '关闭');
}

// ========== 版本号比较 ==========
function compareVersion(a, b) {
  const pa = String(a).replace(/^v/, '').split('.').map(Number);
  const pb = String(b).replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] || 0, nb = pb[i] || 0;
    if (na > nb) return 1;
    if (na < nb) return -1;
  }
  return 0;
}

// ========== 通过代理下载文本（用于 patches.json），支持重定向 ==========
function downloadTextViaProxy(url, redirects) {
  redirects = redirects || 0;
  if (redirects > 5) return Promise.reject(new Error('重定向次数过多'));
  return new Promise((resolve, reject) => {
    const https = require('https');
    const u = new URL(url);
    const opts = { hostname: u.hostname, path: u.pathname + u.search, method: 'GET', headers: { 'User-Agent': 'fuling-shijie-updater' } };
    try {
      const { execSync } = require('child_process');
      const pe = execSync('reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable', { encoding: 'utf-8', windowsHide: true });
      if (/0x1/.test(pe)) {
        const ps = execSync('reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyServer', { encoding: 'utf-8', windowsHide: true });
        const m = ps.match(/ProxyServer\s+REG_SZ\s+(\S+)/);
        if (m && m[1]) {
          const { HttpsProxyAgent } = require('https-proxy-agent');
          opts.agent = new HttpsProxyAgent('http://' + m[1]);
        }
      }
    } catch (e) {}
    const req = https.request(opts, (res) => {
      // 跟随重定向
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        const nextUrl = res.headers.location.startsWith('http') ? res.headers.location : (u.protocol + '//' + u.host + res.headers.location);
        downloadTextViaProxy(nextUrl, redirects + 1).then(resolve, reject);
        return;
      }
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(data);
        else reject(new Error(`HTTP ${res.statusCode}`));
      });
    });
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error('下载超时')));
    req.end();
  });
}

// ========== 测试镜像速度（下载小文件，返回耗时毫秒，不可用返回 Infinity） ==========
function testMirrorSpeed(mirrorUrl) {
  return new Promise((resolve) => {
    const https = require('https');
    // 用实际的更新 JSON 测试，比 HEAD 更准确
    const testUrl = mirrorUrl + 'https://raw.githubusercontent.com/yonggezx/fuling-shijie-update/main/update/latest.json';
    let u;
    try { u = new URL(testUrl); } catch(e) { resolve(Infinity); return; }
    const opts = { hostname: u.hostname, path: u.pathname + u.search, method: 'GET', headers: { 'User-Agent': 'fuling-shijie-updater' }, timeout: 5000 };
    try {
      const { execSync } = require('child_process');
      const pe = execSync('reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable', { encoding: 'utf-8', windowsHide: true });
      if (/0x1/.test(pe)) {
        const ps = execSync('reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyServer', { encoding: 'utf-8', windowsHide: true });
        const m = ps.match(/ProxyServer\s+REG_SZ\s+(\S+)/);
        if (m && m[1]) { const { HttpsProxyAgent } = require('https-proxy-agent'); opts.agent = new HttpsProxyAgent('http://' + m[1]); }
      }
    } catch (e) {}
    const start = Date.now();
    const req = https.request(opts, (res) => {
      // 只要收到响应头就算成功，不下载全部内容
      const elapsed = Date.now() - start;
      req.destroy();
      resolve(res.statusCode < 500 ? elapsed : Infinity);
    });
    req.on('error', () => resolve(Infinity));
    req.on('timeout', () => { resolve(Infinity); req.destroy(); });
    req.end();
  });
}

// ========== 自动选择最快镜像（并发测速） ==========
async function selectWorkingMirror() {
  const list = [...BUILTIN_MIRRORS];
  if (mirrorConfig.customUrl) list.unshift({ name: 'custom', url: mirrorConfig.customUrl });
  // 测速时排除直连（大文件下载必超时），只测镜像
  const mirrorList = list.filter(m => m.url !== '');
  const direct = list.find(m => m.url === '') || { name: '直连（不加速）', url: '' };
  console.log('[Updater] 并发测速', mirrorList.length, '个镜像（排除直连）...');
  const results = await Promise.all(mirrorList.map(async (m) => {
    const speed = await testMirrorSpeed(m.url);
    return { ...m, speed };
  }));
  results.sort((a, b) => a.speed - b.speed);
  const fastest = results[0];
  if (fastest && fastest.speed < Infinity) {
    console.log('[Updater] 最快镜像:', fastest.name, '(' + fastest.speed + 'ms)');
    results.forEach(r => console.log(`  ${r.name}: ${r.speed === Infinity ? '不可用' : r.speed + 'ms'}`));
    return fastest;
  }
  console.warn('[Updater] 所有镜像均不可用，使用直连兜底');
  return direct;
}

// ========== 通过 GitHub API 获取最新 Release 下载地址（走系统代理） ==========
// forceLatest=true 时始终取正式版 latest（完整包用）；否则按渠道取（补丁包用）
function fetchLatestReleaseUrl(channel, forceLatest) {
  return new Promise((resolve, reject) => {
    const https = require('https');
    const isBeta = !forceLatest && channel === 'beta';
    // ★ 不再使用 /releases/latest：该接口只返回「正式 Release」，
    //   仓库里唯一的 Release 是 pre-release 时它直接 404，导致检查更新整条链失败。
    //   统一走列表接口自己挑——列表按创建时间倒序，第一个即最新。
    const apiPath = '/repos/yonggezx/fuling-shijie-update/releases?per_page=10';

    const opts = {
      hostname: 'api.github.com',
      path: apiPath,
      method: 'GET',
      headers: {
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'fuling-shijie-updater',
        'X-GitHub-Api-Version': '2022-11-28'
      }
    };
    // 系统代理
    try {
      const { execSync } = require('child_process');
      const pe = execSync('reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable', { encoding: 'utf-8', windowsHide: true });
      if (/0x1/.test(pe)) {
        const ps = execSync('reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyServer', { encoding: 'utf-8', windowsHide: true });
        const m = ps.match(/ProxyServer\s+REG_SZ\s+(\S+)/);
        if (m && m[1]) {
          const { HttpsProxyAgent } = require('https-proxy-agent');
          opts.agent = new HttpsProxyAgent('http://' + m[1]);
        }
      }
    } catch (e) {}

    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`GitHub API ${res.statusCode}`));
        try {
          const json = JSON.parse(data);
          const list = (Array.isArray(json) ? json : [json])
            .filter(r => r && !r.draft && r.tag_name);
          let release;
          if (isBeta) {
            // 内测渠道：取最新一条，pre-release 也要
            release = list[0];
          } else {
            // 正式渠道：只取正式 Release，没有正式版就不提示更新（绝不回退到 pre-release）
            release = list.find(r => !r.prerelease);
          }
          if (!release) return reject(new Error(isBeta ? '该仓库还没有任何 Release' : '暂无正式版更新'));
          // 构造下载目录：https://github.com/{owner}/{repo}/releases/download/{tag}
          const downloadBase = `https://github.com/yonggezx/fuling-shijie-update/releases/download/${release.tag_name}`;
          resolve({ tag: release.tag_name, downloadBase, name: release.name, body: release.body, assets: release.assets || [] });
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(20000, () => { req.destroy(new Error('GitHub API 请求超时')); });
    req.end();
  });
}

// ========== 更新检查/下载/安装 ==========

// ========== 通过 GitHub API 获取指定版本的安装包下载地址（非直链） ==========
async function fetchReleaseDownloadUrl(tag, mirror) {
  const apiUrl = `https://api.github.com/repos/yonggezx/fuling-shijie-update/releases/tags/${tag}`;
  const mirrorUrl = mirror.url + apiUrl;
  console.log('[Updater] 通过 GitHub API 获取下载地址:', mirrorUrl.substring(0, 80));
  try {
    const data = await downloadTextViaProxy(mirrorUrl);
    const release = JSON.parse(data);
    // 找 .exe 安装包
    const exeAsset = (release.assets || []).find(a => a.name && a.name.endsWith('.exe'));
    if (!exeAsset) throw new Error('Release 中无 .exe 安装包');
    console.log('[Updater] 找到安装包:', exeAsset.name);
    return exeAsset.browser_download_url;
  } catch (e) {
    console.warn('[Updater] GitHub API 获取下载地址失败:', e.message);
    throw e;
  }
}

// ========== 从仓库静态 JSON 获取更新信息（优先于 GitHub API，更快更稳定） ==========
async function fetchUpdateFromJson(channel, mirror) {
  const jsonFile = channel === 'beta' ? 'beta.json' : 'latest.json';
  const rawUrl = `https://raw.githubusercontent.com/yonggezx/fuling-shijie-update/main/update/${jsonFile}`;
  const mirrorUrl = mirror.url + rawUrl;
  console.log('[Updater] 尝试从静态 JSON 获取更新:', mirrorUrl.substring(0, 80));
  try {
    const data = await downloadTextViaProxy(mirrorUrl);
    const json = JSON.parse(data);
    const version = json.version || json.latestVersion;
    if (!version) throw new Error('JSON 中无版本号');
    // 下载地址：支持完整 URL 或文件名
    let downloadUrl = json.downloadUrl || json.fileName || json.url || '';
    if (downloadUrl && !downloadUrl.startsWith('http')) {
      // 文件名，拼接 Release 下载地址
      const tag = json.tag || `v${version}`;
      downloadUrl = `https://github.com/yonggezx/fuling-shijie-update/releases/download/${tag}/${downloadUrl}`;
    }
    const result = {
      version,
      releaseDate: json.releaseDate || json.date || '',
      releaseNotes: json.releaseNotes || json.notes || json.changes || '',
      downloadUrl,
      fileSize: json.fileSize || json.size || 0,
      sha512: json.sha512 || '',
      patch: json.patch || null
    };
    console.log('[Updater] 静态 JSON 获取成功，最新版本:', version);
    return result;
  } catch (e) {
    console.warn('[Updater] 静态 JSON 获取失败，回退 GitHub API:', e.message);
    return null;
  }
}

async function checkForUpdate() {
  currentState.error = null;
  try {
    await proxyReady; // 确保代理设置完成

    const channel = autoUpdater.channel || 'beta';
    const currentVersion = app.getVersion();
    const workingMirror = await selectWorkingMirror();

    // ★ 优先从静态 JSON 获取更新信息（更快更稳定）
    const jsonInfo = await fetchUpdateFromJson(channel, workingMirror);
    if (jsonInfo) {
      // 检查补丁包
      if (jsonInfo.patch) {
        const p = jsonInfo.patch;
        const patchFrom = p.from || p.minVersion || '0.0.0';
        const patchTo = p.to || jsonInfo.version;
        if (compareVersion(currentVersion, patchFrom) >= 0 && compareVersion(currentVersion, patchTo) < 0) {
          console.log('[Updater] 静态 JSON 找到适用补丁:', patchTo);
          let patchUrl = p.url || p.fileName || '';
          if (patchUrl && !patchUrl.startsWith('http')) {
            const tag = p.tag || `v${patchTo}`;
            patchUrl = `https://github.com/yonggezx/fuling-shijie-update/releases/download/${tag}/${patchUrl}`;
          }
          return {
            success: true,
            hasUpdate: true,
            type: 'patch',
            version: patchTo,
            from: patchFrom,
            to: patchTo,
            patchUrl: workingMirror.url + patchUrl,
            patchFileName: p.fileName || p.url || '',
            patchSize: p.size || 0,
            patchSha256: p.sha256 || p.checksum || '',
            requiresRestart: !!p.requiresRestart,
            changes: p.changes || jsonInfo.releaseNotes || '',
            releaseDate: jsonInfo.releaseDate,
            currentVersion: currentVersion,
            latestVersion: patchTo,
            channel: channel
          };
        }
      }
      // 完整包版本比较
      if (compareVersion(jsonInfo.version, currentVersion) > 0) {
        console.log('[Updater] 静态 JSON 检测到完整包更新:', jsonInfo.version);
        // 只保存版本和 tag，下载时通过 GitHub API 动态获取地址（避免直链）
        customFullInstallTag = jsonInfo.tag || `v${jsonInfo.version}`;
        customFullInstallVersion = jsonInfo.version;
        return {
          success: true,
          hasUpdate: true,
          type: 'full',
          version: jsonInfo.version,
          releaseName: jsonInfo.version,
          releaseNotes: jsonInfo.releaseNotes,
          releaseDate: jsonInfo.releaseDate,
          currentVersion: currentVersion,
          latestVersion: jsonInfo.version,
          changes: jsonInfo.releaseNotes,
          channel: 'latest', // 完整包不分内测/正式，始终显示为正式版
          fileSize: jsonInfo.fileSize,
          sha512: jsonInfo.sha512
        };
      }
      console.log('[Updater] 静态 JSON 已是最新版本:', currentVersion, '>=', jsonInfo.version);
      return { success: true, hasUpdate: false, currentVersion: currentVersion, latestVersion: jsonInfo.version };
    }

    // ★ 回退：用 GitHub API 获取最新 Release
    console.log('[Updater] 静态 JSON 不可用，回退 GitHub API');
    const releaseInfo = await fetchLatestReleaseUrl(channel);

    // ★ 混合模式：优先检测补丁包
    const patchAsset = releaseInfo.assets.find(a => a.name === 'patches.json');
    if (patchAsset) {
      try {
        const patchesJsonUrl = workingMirror.url + patchAsset.browser_download_url;
        console.log('[Updater] 检测到补丁索引，正在下载:', patchesJsonUrl.substring(0, 80));
        const patchesData = await downloadTextViaProxy(patchesJsonUrl);
        const patchIndex = JSON.parse(patchesData);
        // 找到适用于当前版本且匹配当前渠道的补丁：from <= currentVersion < to
        const applicable = (patchIndex.patches || []).find(p => {
          // 渠道过滤：补丁有 channel 字段时必须匹配当前渠道；无 channel 字段时兼容旧格式
          if (p.channel && p.channel !== channel) return false;
          return compareVersion(currentVersion, p.from) >= 0 && compareVersion(currentVersion, p.to) < 0;
        });
        if (applicable) {
          console.log('[Updater] 找到适用补丁:', applicable.version, '(需要重启:', applicable.requiresRestart + ')');
          return {
            success: true,
            hasUpdate: true,
            type: 'patch',
            version: applicable.version,
            from: applicable.from,
            to: applicable.to,
            patchUrl: workingMirror.url + releaseInfo.downloadBase + '/' + applicable.fileName,
            patchFileName: applicable.fileName,
            patchSize: applicable.size,
            patchSha256: applicable.sha256,
            requiresRestart: applicable.requiresRestart,
            changes: applicable.changes,
            releaseDate: applicable.releaseDate,
            currentVersion: currentVersion,
            latestVersion: applicable.version,
            channel: channel
          };
        }
        console.log('[Updater] 补丁索引中无适用当前版本的补丁，走完整包更新');
      } catch (e) {
        console.warn('[Updater] 补丁检测失败，回退完整包:', e.message);
      }
    }

    // ★ 完整包始终从 latest Release 获取（不分渠道）
    // 正式渠道复用第一次的 releaseInfo，避免重复 API 调用
    let fullReleaseInfo;
    if (channel === 'latest') {
      fullReleaseInfo = releaseInfo;
      console.log('[Updater] 正式渠道，复用 Release 信息检查完整包');
    } else {
      console.log('[Updater] 无适用补丁，获取 latest Release 检查完整包');
      fullReleaseInfo = await fetchLatestReleaseUrl(channel, true);
    }
    // 用最快镜像包装下载地址
    const genericUrl = workingMirror.url + fullReleaseInfo.downloadBase;
    console.log('[Updater] 使用 generic 下载源:', genericUrl);
    currentDownloadBase = fullReleaseInfo.downloadBase;
    currentDownloadChannel = channel;
    // 切换到 generic provider
    autoUpdater.setFeedURL({ provider: 'generic', url: genericUrl, channel: channel });

    const result = await autoUpdater.checkForUpdates();
    if (!result || !result.updateInfo) {
      return { success: true, hasUpdate: false, currentVersion: app.getVersion() };
    }
    const info = result.updateInfo;
    // ★ 只有更高版本才提示更新，同版本显示已是最新
    if (compareVersion(info.version, currentVersion) <= 0) {
      console.log('[Updater] 已是最新版本:', currentVersion, '>=', info.version);
      return { success: true, hasUpdate: false, currentVersion: currentVersion, latestVersion: info.version };
    }
    return {
      success: true,
      hasUpdate: true,
      type: 'full',
      version: info.version,
      releaseName: fullReleaseInfo.name || info.releaseName,
      releaseNotes: fullReleaseInfo.body || (typeof info.releaseNotes === 'string' ? info.releaseNotes : ''),
      releaseDate: info.releaseDate,
      currentVersion: app.getVersion(),
      latestVersion: info.version,
      changes: fullReleaseInfo.body || '',
      channel: channel
    };
  } catch (e) {
    console.error('[Updater] 检查更新失败:', e.message);
    return { success: false, hasUpdate: false, error: e.message, currentVersion: app.getVersion() };
  }
}

// 当前下载配置（用于切换镜像重试）
let currentDownloadBase = '';
let currentDownloadChannel = 'beta';
// 自定义完整包下载（通过 GitHub API 动态获取地址，避免直链）
let customFullInstallTag = '';
let customFullInstallVersion = '';
let customFullInstallPath = '';

// 下载文件到临时目录（支持进度、超时、镜像重试）
function downloadFile(url, destPath, onProgress) {
  return new Promise((resolve, reject) => {
    const https = require('https');
    const fs = require('fs');
    let u;
    try { u = new URL(url); } catch(e) { reject(e); return; }
    const opts = { hostname: u.hostname, path: u.pathname + u.search, method: 'GET', headers: { 'User-Agent': 'fuling-shijie-updater' }, timeout: 120000 };
    try {
      const { execSync } = require('child_process');
      const pe = execSync('reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable', { encoding: 'utf-8', windowsHide: true });
      if (/0x1/.test(pe)) {
        const ps = execSync('reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyServer', { encoding: 'utf-8', windowsHide: true });
        const m = ps.match(/ProxyServer\s+REG_SZ\s+(\S+)/);
        if (m && m[1]) { const { HttpsProxyAgent } = require('https-proxy-agent'); opts.agent = new HttpsProxyAgent('http://' + m[1]); }
      }
    } catch (e) {}
    const req = https.request(opts, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        // 跟随重定向
        req.destroy();
        downloadFile(res.headers.location, destPath, onProgress).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error('HTTP ' + res.statusCode));
        return;
      }
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
            // 校验文件大小
            const stat = fs.statSync(destPath);
            if (total > 0 && stat.size !== total) {
              fs.unlinkSync(destPath);
              reject(new Error(`下载不完整：期望 ${total} 字节，实际 ${stat.size} 字节`));
              return;
            }
            // 校验是否为有效的 Windows 可执行文件（MZ 头）
            const fd = fs.openSync(destPath, 'r');
            const buf = Buffer.alloc(2);
            fs.readSync(fd, buf, 0, 2, 0);
            fs.closeSync(fd);
            if (buf[0] !== 0x4D || buf[1] !== 0x5A) { // 'MZ'
              fs.unlinkSync(destPath);
              reject(new Error('下载的文件不是有效的安装包（缺少 MZ 头）'));
              return;
            }
            resolve(destPath);
          } catch (e) {
            reject(e);
          }
        });
      });
      file.on('error', (e) => { try { fs.unlinkSync(destPath); } catch(_) {} reject(e); });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('下载超时')); });
    req.end();
  });
}

async function downloadUpdate(patchInfo, onProgress) {
  // 自定义完整包下载（通过 GitHub API 动态获取地址，避免直链）
  if (customFullInstallTag) {
    const maxRetries = 3;
    let lastError = null;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const mirror = await selectWorkingMirror();
        console.log(`[Updater] 完整包下载尝试 ${attempt + 1}/${maxRetries}，镜像: ${mirror.name}`);
        // 通过 GitHub API 获取下载地址（非直链）
        const rawUrl = await fetchReleaseDownloadUrl(customFullInstallTag, mirror);
        const dlUrl = mirror.url + rawUrl;
        console.log('[Updater] 下载地址:', dlUrl.substring(0, 80));
        const tmpDir = require('os').tmpdir();
        const fileName = '浮灵饰界_Update_' + Date.now() + '.exe';
        const destPath = require('path').join(tmpDir, fileName);
        await downloadFile(dlUrl, destPath, (p) => {
          if (onProgress) onProgress({ percent: p });
          currentState.downloadProgress = p;
        });
        customFullInstallPath = destPath;
        currentState.downloaded = true;
        console.log('[Updater] 完整包下载完成:', destPath);
        return { success: true };
      } catch (e) {
        lastError = e;
        console.warn(`[Updater] 完整包下载失败（尝试 ${attempt + 1}/${maxRetries}）:`, e.message);
        if (attempt < maxRetries - 1) await new Promise(r => setTimeout(r, 1000));
      }
    }
    return { success: false, error: lastError ? lastError.message : '下载失败' };
  }
  // electron-updater 下载（补丁包或 GitHub API 路径）
  if (onProgress) eventCallbacks.onProgress = (p) => onProgress(p.percent);
  const maxRetries = 3;
  let lastError = null;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const mirror = await selectWorkingMirror();
      if (currentDownloadBase) {
        const genericUrl = mirror.url + currentDownloadBase;
        console.log(`[Updater] 下载尝试 ${attempt + 1}/${maxRetries}，镜像: ${mirror.name}`);
        autoUpdater.setFeedURL({ provider: 'generic', url: genericUrl, channel: currentDownloadChannel });
      }
      const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('下载超时（120秒）')), 120000));
      await Promise.race([autoUpdater.downloadUpdate(), timeoutPromise]);
      return { success: true };
    } catch (e) {
      lastError = e;
      console.warn(`[Updater] 下载失败（尝试 ${attempt + 1}/${maxRetries}）:`, e.message);
      if (attempt < maxRetries - 1) {
        console.log('[Updater] 切换镜像重试...');
        await new Promise(r => setTimeout(r, 1000));
      }
    }
  }
  return { success: false, error: lastError ? lastError.message : '下载失败' };
}

function applyUpdate() {
  // 自定义完整包：直接运行安装器
  if (customFullInstallPath) {
    try {
      const { spawn } = require('child_process');
      console.log('[Updater] 运行安装器:', customFullInstallPath);
      spawn(customFullInstallPath, ['/S'], { detached: true, stdio: 'ignore' });
      app.quit();
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }
  if (!currentState.downloaded) {
    return { success: false, error: '更新包尚未下载完成' };
  }
  try {
    autoUpdater.quitAndInstall(false, true);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function getCurrentVersion() {
  return app.getVersion();
}

function getUpdateState() {
  return {
    checking: currentState.checking,
    downloadProgress: currentState.downloadProgress,
    downloaded: currentState.downloaded,
    hasUpdate: !!currentState.updateInfo,
    updateVersion: currentState.updateInfo ? currentState.updateInfo.version : null,
    channel: autoUpdater.channel,
    error: currentState.error,
    mirror: getMirrorStatus()
  };
}

function on(event, callback) {
  if (eventCallbacks.hasOwnProperty(event)) {
    eventCallbacks[event] = callback;
  }
}

module.exports = {
  init,
  checkForUpdate,
  downloadUpdate,
  applyUpdate,
  getCurrentVersion,
  getUpdateState,
  getChannel,
  setChannel,
  on,
  autoUpdater,
  // 镜像管理
  getMirrorStatus,
  setMirrorIndex,
  setMirrorEnabled,
  setCustomMirror,
  switchToNextMirror
};
