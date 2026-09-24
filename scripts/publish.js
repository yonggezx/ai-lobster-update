#!/usr/bin/env node
/**
 * 浮灵饰界 - 更新发布脚本（GitHub 版，已移除蓝奏云与分卷上传）
 *
 * 功能：
 *   1. 补丁发布：打包增量补丁 → 更新 latest.json / beta.json（补丁直链指向 GitHub Releases）
 *   2. 完整包发布：计算校验和 → 更新 beta.json 的 full-install 信息（直链指向 GitHub Releases）
 *
 * 说明：真正的发布/上传由「AI龙虾-发布工具」完成（走 GitHub Releases + latest.yml）。
 * 本脚本仅用于生成/更新本地 update/ 目录下的元数据清单，随后提交到 fuling-shijie-update 仓库。
 *
 * 用法：
 *   # 更新补丁元数据
 *   node scripts/publish.js patch --version=1.0.9 --from=1.0.8 --files=renderer/js/app.js --changes="修复xxx"
 *
 *   # 更新完整包元数据
 *   node scripts/publish.js full --version=1.0.9 --installer=dist/AI龙虾_Setup_v1.0.9.exe
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const OWNER = 'yonggezx';
const REPO = 'fuling-shijie-update';

const ROOT = path.resolve(__dirname, '..');
const UPDATE_DIR = path.join(ROOT, 'update');
const PATCHES_DIR = path.join(UPDATE_DIR, 'patches');

// ========== 工具函数 ==========

function parseArgs() {
  const args = { _: [] };
  process.argv.slice(2).forEach(arg => {
    if (arg.startsWith('--')) {
      const match = arg.match(/^--(\w+)(?:=(.+))?$/);
      if (match) args[match[1]] = match[2] !== undefined ? match[2] : true;
    } else {
      args._.push(arg);
    }
  });
  return args;
}

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

function log(msg) { console.log(`\x1b[36m[publish]\x1b[0m ${msg}`); }
function err(msg) { console.error(`\x1b[31m[error]\x1b[0m ${msg}`); }

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readJson(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf-8').replace(/^\uFEFF/, ''));
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

// ========== 补丁发布 ==========

async function cmdPatch(args) {
  const version = args.version;
  const fromVersion = args.from;
  const filesArg = args.files;
  const changes = args.changes || '';
  const channel = args.channel || 'stable'; // stable / beta

  if (!version || !fromVersion || !filesArg) {
    err('参数不全。用法: node scripts/publish.js patch --version=1.0.9 --from=1.0.8 --files=renderer/js/app.js --changes="修复xxx"');
    process.exit(1);
  }

  log(`开始发布补丁: ${fromVersion} → ${version} (${channel} 通道)`);

  // Step 1: 调用 build-patch.js 打包
  log('Step 1: 打包补丁...');
  const buildArgs = [
    path.join(ROOT, 'scripts', 'build-patch.js'),
    `--version=${version}`,
    `--from=${fromVersion}`,
    `--files=${filesArg}`,
    `--changes=${changes}`
  ];
  const buildResult = spawnSync('node', buildArgs, { cwd: ROOT, stdio: 'inherit', encoding: 'utf8' });
  if (buildResult.status !== 0) {
    err('补丁打包失败');
    process.exit(1);
  }

  // Step 2: 计算补丁信息
  log('Step 2: 更新元数据...');
  ensureDir(PATCHES_DIR);
  const zipPath = path.join(PATCHES_DIR, `patch-${version}.zip`);
  if (!fs.existsSync(zipPath)) {
    err('补丁文件未找到: ' + zipPath);
    process.exit(1);
  }
  const checksum = sha256File(zipPath);
  const fileSize = fs.statSync(zipPath).size;

  const metaFile = channel === 'beta'
    ? path.join(UPDATE_DIR, 'beta.json')
    : path.join(UPDATE_DIR, 'latest.json');
  const meta = readJson(metaFile) || {
    latestVersion: version,
    releaseDate: new Date().toISOString().split('T')[0],
    changes: changes,
    channel: channel,
    minAutoUpdateVersion: '1.0.0',
    patches: []
  };

  meta.latestVersion = version;
  meta.releaseDate = new Date().toISOString().split('T')[0];
  if (changes) meta.changes = changes;
  meta.channel = channel;

  const patchEntry = {
    from: fromVersion,
    to: version,
    url: `https://github.com/${OWNER}/${REPO}/releases/download/v${version}/patch-${version}.zip`,
    size: fileSize,
    checksum: `sha256:${checksum}`,
    changes
  };

  // 移除同 from→to 的旧条目，添加新条目
  meta.patches = meta.patches.filter(p => !(p.from === fromVersion && p.to === version));
  meta.patches.push(patchEntry);

  writeJson(metaFile, meta);
  log(`元数据已更新: ${path.relative(ROOT, metaFile)}`);

  console.log('\n========== 发布完成 ==========');
  console.log(`版本: ${fromVersion} → ${version}`);
  console.log(`通道: ${channel}`);
  console.log(`补丁大小: ${(fileSize / 1024 / 1024).toFixed(2)} MB`);
  console.log(`SHA256: ${checksum}`);
  console.log(`直链: ${patchEntry.url}`);
  console.log(`\n请将 update/ 目录下的变更提交到 Git 仓库 ${OWNER}/${REPO}`);
}

// ========== 完整包发布 ==========

async function cmdFull(args) {
  const version = args.version;
  const installerPath = args.installer ? path.resolve(args.installer) : null;
  const changes = args.changes || '最新完整安装包';

  if (!version) {
    err('请指定 --version 参数');
    process.exit(1);
  }
  if (!installerPath || !fs.existsSync(installerPath)) {
    err('请指定有效的安装包路径: --installer=dist/xxx.exe');
    process.exit(1);
  }

  log(`开始发布完整安装包: v${version}`);
  log(`安装包: ${installerPath} (${(fs.statSync(installerPath).size / 1024 / 1024).toFixed(1)} MB)`);

  // Step 1: 计算校验和
  const checksum = sha256File(installerPath);
  const fileSize = fs.statSync(installerPath).size;

  // Step 2: 更新 full-install 信息到 beta.json（完整包信息统一放在 beta.json 中）
  log('更新元数据...');
  const betaFile = path.join(UPDATE_DIR, 'beta.json');
  const beta = readJson(betaFile) || { patches: [] };

  const fullInstall = {
    version: version,
    url: `https://github.com/${OWNER}/${REPO}/releases/download/v${version}/${path.basename(installerPath)}`,
    size: fileSize,
    checksum: `sha256:${checksum}`,
    changes: changes,
    releaseDate: new Date().toISOString().split('T')[0],
    isFullPackage: true
  };

  beta.fullInstall = fullInstall;
  writeJson(betaFile, beta);
  log(`元数据已更新: ${path.relative(ROOT, betaFile)}`);

  console.log('\n========== 完整包发布完成 ==========');
  console.log(`版本: ${version}`);
  console.log(`大小: ${(fileSize / 1024 / 1024).toFixed(2)} MB`);
  console.log(`SHA256: ${checksum}`);
  console.log(`直链: ${fullInstall.url}`);
  console.log(`\n请将 update/beta.json 的变更提交到 Git 仓库 ${OWNER}/${REPO}`);
}

// ========== 主入口 ==========

async function main() {
  const args = parseArgs();
  const command = args._[0];

  if (!command || args.help || args.h) {
    console.log(`
浮灵饰界 - 更新发布脚本（GitHub 版）

用法:
  node scripts/publish.js <command> [options]

命令:
  patch    发布增量补丁（打包 + 更新元数据 latest.json / beta.json）
  full     发布完整安装包（计算校验和 + 更新 beta.json 的 full-install）

示例:
  # 发布补丁
  node scripts/publish.js patch --version=1.0.9 --from=1.0.8 --files=renderer/js/app.js --changes="修复xxx"

  # 发布完整包
  node scripts/publish.js full --version=1.0.9 --installer=dist/AI龙虾_Setup_v1.0.9.exe
`);
    return;
  }

  try {
    switch (command) {
      case 'patch':
        await cmdPatch(args);
        break;
      case 'full':
        await cmdFull(args);
        break;
      default:
        err('未知命令: ' + command);
        process.exit(1);
    }
  } catch (e) {
    err('发布失败: ' + e.message);
    console.error(e.stack);
    process.exit(1);
  }
}

main();
