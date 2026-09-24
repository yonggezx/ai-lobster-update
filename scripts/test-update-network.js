/**
 * 更新链路联通性回归测试
 *
 * 覆盖：
 *   1. 正式清单 latest.json 可读且是合法 JSON
 *   2. 内测清单 beta.json 可读且是合法 JSON
 *   3. 清单内容完整
 *   4. 补丁包可下载，且内容 sha256 与清单声明一致
 *   5. 多源回退：直连被阻断时仍能通过镜像拿到清单
 *
 * 说明：updateOps.js 依赖 electron，无法在纯 Node 下直接 require，
 * 这里复刻其网络层逻辑（同样的 URL 构造 + 同样的回退顺序）做等价验证。
 *
 * 用法：node scripts/test-update-network.js
 */

const https = require('https');
const http = require('http');
const crypto = require('crypto');

const OWNER = 'yonggezx';
const REPO = 'fuling-shijie-update';
const BRANCH = 'main';
const RAW_BASE = `https://raw.githubusercontent.com/${OWNER}/${REPO}/${BRANCH}`;
const BETA_URL = `${RAW_BASE}/update/beta.json`;
const LATEST_URL = `${RAW_BASE}/update/latest.json`;

// 第三方加速镜像（救急用，实测 ghproxy.com / mirror.ghproxy.com / nuaa / 99988866 均已失效）
const GH_MIRRORS = [
  { name: 'gh-proxy', prefix: 'https://gh-proxy.com/' },
  { name: 'ghproxy-net', prefix: 'https://ghproxy.net/' }
];

// 与 updateOps.buildUrlCandidates 保持一致：Pages → jsDelivr → 第三方镜像 → raw
function buildUrlCandidates(url) {
  const m = String(url).match(/^https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/);
  if (!m) return [url];
  const [, owner, repo, branch, filePath] = m;
  const list = [
    `https://${owner}.github.io/${repo}/${filePath}`,
    `https://cdn.jsdelivr.net/gh/${owner}/${repo}@${branch}/${filePath}`,
    ...GH_MIRRORS.map(mr => mr.prefix + url),
    url
  ];
  return list.filter((u, i) => list.indexOf(u) === i);
}

function fetchJsonOnce(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, { headers: { 'User-Agent': 'fuling-shijie-updater' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return fetchJsonOnce(res.headers.location, timeoutMs).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('JSON parse error')); }
      });
    });
    req.setTimeout(timeoutMs || 15000, () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
  });
}

async function fetchJson(url) {
  let lastErr = null;
  for (const u of buildUrlCandidates(url)) {
    try { return await fetchJsonOnce(u, 15000); }
    catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('所有更新源均不可用');
}

function downloadBuffer(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, { headers: { 'User-Agent': 'fuling-shijie-updater' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return downloadBuffer(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.setTimeout(60000, () => req.destroy(new Error('下载超时')));
    req.on('error', reject);
  });
}

// 下载也走多源回退（raw 直连已实测会 ECONNRESET，首选源是 Pages）
async function downloadWithFallback(url) {
  const candidates = buildUrlCandidates(url);
  let lastErr = null;
  for (const u of candidates) {
    try { return await downloadBuffer(u); }
    catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('所有下载源均不可用');
}

// 带条件头的请求，返回 { status, etag, headers }，用于验证 304 逻辑
function fetchConditional(url, etag) {
  return new Promise((resolve, reject) => {
    const headers = { 'User-Agent': 'fuling-shijie-updater' };
    if (etag) headers['If-None-Match'] = etag;
    const req = https.get(url, { headers }, (res) => {
      res.resume();
      resolve({ status: res.statusCode, etag: res.headers.etag, headers: res.headers });
    });
    req.setTimeout(20000, () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
  });
}

// 与 updateOps.normalizeHash 保持一致
function normalizeHash(v) {
  if (!v) return '';
  return String(v).replace(/^sha256:/i, '').replace(/^md5:/i, '').trim().toLowerCase();
}

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  ✓ ${name}${detail ? ' — ' + detail : ''}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

(async () => {
  console.log('=== 更新链路回归测试（GitHub 更新源）===\n');

  console.log('[1] 清单可读性');
  let beta = null, latest = null;
  try {
    beta = await fetchJson(BETA_URL);
    check('内测清单 beta.json', !!beta && !!beta.latestVersion, `latestVersion=${beta && beta.latestVersion}`);
  } catch (e) { check('内测清单 beta.json', false, e.message); }

  try {
    latest = await fetchJson(LATEST_URL);
    check('正式清单 latest.json', !!latest && !!latest.latestVersion, `latestVersion=${latest && latest.latestVersion}`);
  } catch (e) { check('正式清单 latest.json', false, e.message); }

  console.log('\n[2] 清单内容完整');
  if (beta) {
    const raw = JSON.stringify(beta);
    check('beta.json 格式正确', raw.includes('version'));
    check('beta.json 不引用 raw/master', !raw.includes('raw/master'));
    const urls = (beta.patches || []).map(p => p.url).filter(Boolean);
    const allGithub = urls.every(u => u.startsWith('https://raw.githubusercontent.com/'));
    check('全部补丁链接指向 raw.githubusercontent.com', allGithub, `${urls.length} 条`);
  }

  console.log('\n[3] 补丁包下载 + 校验');
  if (beta && beta.patches && beta.patches.length) {
    const last = beta.patches[beta.patches.length - 1];
    const expect = normalizeHash(last.checksum || last.sha256);
    try {
      const buf = await downloadWithFallback(last.url);
      const actual = crypto.createHash('sha256').update(buf).digest('hex');
      check('补丁下载成功', buf.length > 0, `${(buf.length / 1024).toFixed(1)} KB`);
      check('补丁大小与清单一致', !last.size || buf.length === last.size, `清单 ${last.size} / 实际 ${buf.length}`);
      check('补丁 sha256 一致', expect === actual, expect ? `期望 ${expect.slice(0, 16)}… / 实际 ${actual.slice(0, 16)}…` : '清单未声明校验值（跳过比对）');
    } catch (e) {
      check('补丁下载成功', false, e.message);
    }
  }

  console.log('\n[4] 源优先级与多源回退');
  const candidates = buildUrlCandidates(BETA_URL);
  check('候选源数量 > 1', candidates.length > 1, `${candidates.length} 个候选`);
  check('首选源是 GitHub Pages（非 raw）', /^https:\/\/[^.]+\.github\.io\//.test(candidates[0]), candidates[0]);
  check('raw 排在最后（仅救急）', candidates[candidates.length - 1] === BETA_URL);
  // 逐个试探备用源本身是否可用
  let usable = 0;
  for (const u of candidates.slice(1)) {
    try {
      const j = await fetchJsonOnce(u, 15000);
      if (j && j.latestVersion) usable++;
    } catch (e) {}
  }
  check('至少一个备用源可用', usable > 0, `${usable}/${candidates.length - 1} 个可用`);

  console.log('\n[5] 外链滥用规避');
  // 条件请求：带 If-None-Match 应回 304，几乎不消耗配额
  try {
    const first = await fetchConditional(candidates[0], null);
    const etag = first.etag;
    check('首选源返回 ETag', !!etag, etag ? etag.slice(0, 24) + '…' : '无');
    if (etag) {
      const second = await fetchConditional(candidates[0], etag);
      check('条件请求命中 304（未变更不重传）', second.status === 304, 'HTTP ' + second.status);
    }
    // 缓存头不应过长，否则发布新版后客户端拿不到
    const cc = (first.headers['cache-control'] || '');
    const maxAgeMatch = cc.match(/max-age=(\d+)/);
    const maxAge = maxAgeMatch ? parseInt(maxAgeMatch[1], 10) : null;
    check('缓存时长 ≤ 1 小时（避免新版延迟）', maxAge !== null && maxAge <= 3600, cc || '无 cache-control');
  } catch (e) {
    check('条件请求验证', false, e.message);
  }

  console.log('\n[6] Release 选取（曾因 /releases/latest 404 导致检查更新失败）');
  const API = `https://api.github.com/repos/${OWNER}/${REPO}`;
  try {
    const latestRes = await fetchConditional(`${API}/releases/latest`, null);
    check('记录 /releases/latest 现状', true, 'HTTP ' + latestRes.status + (latestRes.status === 404 ? '（正是之前的失败原因，已弃用该接口）' : ''));

    const listRaw = await fetchJsonOnce(`${API}/releases?per_page=10`, 15000);
    const releases = (Array.isArray(listRaw) ? listRaw : [listRaw]).filter(r => r && !r.draft);
    check('列表接口可用', releases.length > 0, `${releases.length} 个 Release`);

    const stable = releases.find(r => !r.prerelease);
    const picked = stable || releases[0];
    check('无正式版时回退到 pre-release（不再 404 中断）', !!picked, `选中 ${picked && picked.tag_name}`);

    const exe = picked && (picked.assets || []).find(a => a.name && a.name.endsWith('.exe'));
    check('选中 Release 含 exe 安装包', !!exe, exe ? `${exe.name} (${(exe.size / 1024 / 1024).toFixed(1)} MB)` : '无');
  } catch (e) {
    check('Release 选取验证', false, e.message);
  }

  console.log('\n[7] full-install.json（曾 404）');
  try {
    const fi = await fetchJson(`${RAW_BASE}/update/full-install.json`);
    check('full-install.json 可读', !!fi, fi && fi.fullInstall === null ? 'fullInstall = null（暂无完整包，符合预期）' : '');
  } catch (e) {
    check('full-install.json 可读', false, e.message);
  }

  console.log(`\n=== 结果：通过 ${pass}，失败 ${fail} ===`);
  process.exit(fail === 0 ? 0 : 1);
})();
