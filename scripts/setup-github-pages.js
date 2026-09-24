/**
 * 检查 / 开启 GitHub Pages（fuling-shijie-update 仓库）。
 *
 * 为什么：raw.githubusercontent.com 官方明说不是 CDN，拿它当更新源有被限流封禁的风险；
 * GitHub Pages 是官方静态托管服务，专门用于公开文件分发，是更新源的最合规落点。
 *
 * 用法：
 *   node scripts/setup-github-pages.js           # 只查询当前状态
 *   node scripts/setup-github-pages.js --enable  # 未开启则开启（main 分支根目录）
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');

const OWNER = 'yonggezx';
const REPO = 'fuling-shijie-update';
const BRANCH = 'main';
const ROOT = path.resolve(__dirname, '..');

const ENABLE = process.argv.includes('--enable');

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

function apiRequest(method, apiPath, body, token) {
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
        'Authorization': 'Bearer ' + token
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
          reject(new Error(`GitHub API ${res.statusCode}: ${data.substring(0, 300)}`));
        }
      });
    });
    req.on('error', reject);
    if (postData) req.write(postData);
    req.end();
  });
}

const TOKEN = getToken();

(async () => {
  if (!TOKEN) {
    console.error('未找到 GitHub Token。');
    process.exit(1);
  }

  console.log(`检查 ${OWNER}/${REPO} 的 GitHub Pages 状态...\n`);

  let pages = null;
  try {
    pages = await apiRequest('GET', `/repos/${OWNER}/${REPO}/pages`, null, TOKEN);
    console.log('Pages 已开启：');
    console.log('  站点地址:', pages.html_url);
    console.log('  来源:', pages.source && pages.source.branch, pages.source && pages.source.path);
    console.log('  状态:', pages.status);
  } catch (e) {
    if (/404/.test(e.message)) {
      console.log('Pages 尚未开启。');
      if (!ENABLE) {
        console.log('\n如需开启，请运行：node scripts/setup-github-pages.js --enable');
        console.log('或在仓库 Settings → Pages → Source 选择 main 分支 / (root)。');
        return;
      }
      console.log('\n正在开启（main 分支根目录）...');
      try {
        const res = await apiRequest('POST', `/repos/${OWNER}/${REPO}/pages`, {
          source: { branch: BRANCH, path: '/' }
        }, TOKEN);
        console.log('已提交开启请求：', res.html_url || JSON.stringify(res));
        console.log('首次部署需要几分钟，稍后访问验证。');
      } catch (err) {
        console.error('开启失败:', err.message);
        console.log('\n可能原因：Token 缺少 repo 权限，或仓库设置禁止 Pages。');
        console.log('可手动开启：Settings → Pages → Source → main / (root)');
      }
    } else {
      console.error('查询失败:', e.message);
    }
  }
})();
