/**
 * 把本地 update/ 清单与补丁同步到 GitHub 仓库（fuling-shijie-update 的 main 分支）。
 *
 * 为什么需要它：客户端现在从 raw.githubusercontent.com 读更新清单，但发布工具
 * 只往 GitHub Release 传资产，不会往仓库里写文件，所以清单得单独同步一次。
 *
 * 用法：
 *   node scripts/sync-update-to-github.js            # 预演，只列出将要写入的文件
 *   node scripts/sync-update-to-github.js --apply    # 真正上传
 *
 * Token 读取优先级：环境变量 GITHUB_TOKEN > 发布工具配置 publisher-config.json
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');

const OWNER = 'yonggezx';
const REPO = 'fuling-shijie-update';
const BRANCH = 'main';
const ROOT = path.resolve(__dirname, '..');

const APPLY = process.argv.includes('--apply');

// ========== Token ==========
function getToken() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  const candidates = [
    'C:\\Users\\fan\\Desktop\\AI龙虾-发布工具\\data\\publisher-config.json',
    path.join(ROOT, '..', 'AI龙虾-发布工具', 'data', 'publisher-config.json')
  ];
  for (const p of candidates) {
    try {
      const cfg = JSON.parse(fs.readFileSync(p, 'utf-8').replace(/^\uFEFF/, ''));
      if (cfg.githubToken) return cfg.githubToken;
    } catch (e) {}
  }
  return null;
}

// ========== 系统代理 ==========
let _proxyAgent = null;
function getWindowsSystemProxy() {
  try {
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

// ========== GitHub Contents API ==========
function apiRequest(method, apiPath, body) {
  return new Promise((resolve, reject) => {
    const postData = body ? Buffer.from(JSON.stringify(body)) : null;
    const options = {
      hostname: 'api.github.com',
      path: apiPath,
      method,
      headers: {
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'fuling-shijie-updater',
        'Authorization': 'Bearer ' + TOKEN
      }
    };
    if (postData) {
      options.headers['Content-Type'] = 'application/json';
      options.headers['Content-Length'] = postData.length;
    }
    const agent = getProxyAgent();
    if (agent) options.agent = agent;
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(data)); } catch (e) { resolve(data); }
        } else {
          reject(new Error(`GitHub API ${res.statusCode}: ${data.substring(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    if (postData) req.write(postData);
    req.end();
  });
}

// 获取仓库中已有文件的 sha（更新文件必须带 sha，否则 422）
async function getRemoteSha(repoPath) {
  try {
    const res = await apiRequest('GET', `/repos/${OWNER}/${REPO}/contents/${encodeURI(repoPath)}?ref=${BRANCH}`);
    return res && res.sha ? res.sha : null;
  } catch (e) {
    if (/404/.test(e.message)) return null;
    throw e;
  }
}

async function uploadFile(localFile, repoPath, label) {
  const stat = fs.statSync(localFile);
  const sizeMB = (stat.size / 1024 / 1024).toFixed(2);
  if (!APPLY) {
    console.log(`  [预演] ${label} → ${repoPath} (${sizeMB} MB)`);
    return;
  }
  const sha = await getRemoteSha(repoPath);
  const content = fs.readFileSync(localFile).toString('base64');
  const body = {
    message: `chore(update): 同步 ${label}`,
    content,
    branch: BRANCH
  };
  if (sha) body.sha = sha;
  await apiRequest('PUT', `/repos/${OWNER}/${REPO}/contents/${repoPath}`, body);
  console.log(`  ✓ ${label} → ${repoPath} (${sizeMB} MB)${sha ? ' [更新]' : ' [新建]'}`);
}

// ========== 待上传清单 ==========
function buildFileList() {
  const list = [];
  const add = (local, remote, label) => {
    if (fs.existsSync(local)) list.push({ local, remote, label });
    else console.warn(`  ! 跳过（文件不存在）: ${local}`);
  };

  add(path.join(ROOT, 'update', 'beta.json'), 'update/beta.json', '内测更新清单');
  add(path.join(ROOT, 'update', 'latest.json'), 'update/latest.json', '正式更新清单');
  if (fs.existsSync(path.join(ROOT, 'update', 'full-install.json'))) {
    add(path.join(ROOT, 'update', 'full-install.json'), 'update/full-install.json', '完整包清单');
  }

  // 补丁包
  const patchesDir = path.join(ROOT, 'update', 'patches');
  if (fs.existsSync(patchesDir)) {
    for (const name of fs.readdirSync(patchesDir)) {
      if (name.endsWith('.zip') && /^patch-/.test(name)) {
        add(path.join(patchesDir, name), `patches/${name}`, `补丁 ${name}`);
      }
    }
  }

  return list;
}

// ========== 主流程 ==========
const TOKEN = getToken();

async function main() {
  if (!TOKEN) {
    console.error('未找到 GitHub Token。请设置环境变量 GITHUB_TOKEN，或先在发布工具里配置。');
    process.exit(1);
  }
  const files = buildFileList();
  if (!files.length) {
    console.log('没有需要同步的文件。');
    return;
  }
  console.log(`${APPLY ? '开始同步' : '预演模式'}：共 ${files.length} 个文件 → ${OWNER}/${REPO}@${BRANCH}\n`);

  let ok = 0, fail = 0;
  for (const f of files) {
    try {
      await uploadFile(f.local, f.remote, f.label);
      ok++;
    } catch (e) {
      fail++;
      console.error(`  ✗ ${f.label} 失败: ${e.message}`);
    }
  }
  console.log(`\n完成：成功 ${ok}，失败 ${fail}`);
  if (!APPLY) console.log('（预演未写入，加 --apply 才会真正上传）');
}

main();
