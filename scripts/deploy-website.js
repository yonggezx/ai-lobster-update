/**
 * 通过 GitHub Contents API 部署官网
 * 简单可靠，每次直接覆盖文件
 */
const fs = require('fs');
const path = require('path');
const https = require('https');

const OWNER = 'yonggezx';
const REPO = 'fuling-shijie-website';
const BRANCH = 'main';
function getToken() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  const candidates = [
    'C:\\Users\\fan\\Desktop\\AI龙虾-发布工具\\data\\publisher-config.json',
    path.join(__dirname, '..', '..', 'AI龙虾-发布工具', 'data', 'publisher-config.json')
  ];
  for (const p of candidates) {
    try {
      const cfg = JSON.parse(fs.readFileSync(p, 'utf-8').replace(/^\uFEFF/, ''));
      if (cfg.githubToken) return cfg.githubToken;
    } catch (e) {}
  }
  return null;
}
const TOKEN = getToken();
if (!TOKEN) { console.error('缺少 GITHUB_TOKEN（可设环境变量或由 publisher-config.json 提供）'); process.exit(1); }
const WEBSITE_DIR = path.resolve(__dirname, '..', 'ai-lobster-website');

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
        'User-Agent': 'fuling-shijie-deployer',
        'Authorization': 'Bearer ' + TOKEN
      }
    };
    if (postData) {
      options.headers['Content-Type'] = 'application/json';
      options.headers['Content-Length'] = postData.length;
    }
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(data)); } catch (e) { resolve(data); }
        } else {
          reject(new Error(`GitHub API ${res.statusCode}: ${data.substring(0, 500)}`));
        }
      });
    });
    req.on('error', reject);
    if (postData) req.write(postData);
    req.end();
  });
}

function getAllFiles(dir, baseDir) {
  const files = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...getAllFiles(fullPath, baseDir));
    } else if (entry.isFile()) {
      const relativePath = path.relative(baseDir, fullPath).replace(/\\/g, '/');
      files.push({ path: relativePath, content: fs.readFileSync(fullPath) });
    }
  }
  return files;
}

async function uploadFile(file) {
  const contentBase64 = file.content.toString('base64');
  const apiPath = `/repos/${OWNER}/${REPO}/contents/${encodeURIComponent(file.path)}`;
  
  // 先获取文件的 SHA（如果已存在）
  let sha = null;
  try {
    const existing = await apiRequest('GET', `${apiPath}?ref=${BRANCH}`);
    sha = existing.sha;
  } catch (e) {
    // 文件不存在，不需要 sha
  }
  
  const body = {
    message: `部署: ${file.path}`,
    content: contentBase64,
    branch: BRANCH
  };
  if (sha) body.sha = sha;
  
  await apiRequest('PUT', apiPath, body);
  return sha ? 'updated' : 'created';
}

(async () => {
  console.log('开始部署 浮灵饰界官网到 GitHub Pages...');
  console.log('仓库:', `${OWNER}/${REPO}`);
  console.log('分支:', BRANCH);
  console.log('');

  // 1. 获取所有文件
  console.log('1. 读取官网文件...');
  const files = getAllFiles(WEBSITE_DIR, WEBSITE_DIR);
  console.log(`   找到 ${files.length} 个文件:`);
  files.forEach(f => console.log(`   - ${f.path} (${(f.content.length / 1024).toFixed(1)} KB)`));
  console.log('');

  // 2. 逐个上传文件
  console.log('2. 上传文件...');
  for (const file of files) {
    try {
      const result = await uploadFile(file);
      console.log(`   ✓ ${result}: ${file.path}`);
    } catch (e) {
      console.log(`   ✗ 失败: ${file.path} - ${e.message.substring(0, 100)}`);
      throw e;
    }
  }
  console.log('');

  // 3. 开启 GitHub Pages
  console.log('3. 配置 GitHub Pages...');
  try {
    const pages = await apiRequest('GET', `/repos/${OWNER}/${REPO}/pages`);
    console.log(`   Pages 已开启: ${pages.html_url}`);
    console.log(`   来源: ${pages.source.branch} / ${pages.source.path}`);
    if (pages.source.branch !== BRANCH) {
      console.log(`   更新来源为 ${BRANCH}...`);
      await apiRequest('PUT', `/repos/${OWNER}/${REPO}/pages`, {
        source: { branch: BRANCH, path: '/' }
      });
      console.log('   已更新');
    }
  } catch (e) {
    if (/404/.test(e.message)) {
      console.log('   Pages 尚未开启，正在开启...');
      try {
        await apiRequest('POST', `/repos/${OWNER}/${REPO}/pages`, {
          source: { branch: BRANCH, path: '/' }
        });
        console.log('   Pages 开启请求已提交');
      } catch (err) {
        console.log('   开启失败，请手动在 Settings → Pages 中开启');
      }
    } else {
      console.log('   查询失败:', e.message.substring(0, 100));
    }
  }
  console.log('');

  console.log('========================================');
  console.log('部署完成！');
  console.log('========================================');
  console.log('仓库: https://github.com/' + OWNER + '/' + REPO);
  console.log('官网地址: https://' + OWNER + '.github.io/' + REPO + '/');
  console.log('');
  console.log('首次部署需要 1-2 分钟构建，稍后访问即可。');
})().catch(e => {
  console.error('部署失败:', e.message);
  process.exit(1);
});
