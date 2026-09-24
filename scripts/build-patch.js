/**
 * 补丁包打包脚本
 * 用法：
 *   node scripts/build-patch.js --version=1.0.5 --from=1.0.4 --files=renderer/index.html,renderer/js/app.js
 *   node scripts/build-patch.js --version=1.0.5 --from=1.0.4 --files=renderer/ --changes="修复了xxx"
 *
 * 参数：
 *   --version   目标版本号（必填）
 *   --from      适用的起始版本（必填，用于增量补丁链）
 *   --files     变更文件或目录，逗号分隔（必填，相对于项目根目录）
 *   --min       最低兼容版本（默认等于 from）
 *   --changes   更新说明文本
 *   --output    输出目录（默认 ./update/patches）
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

// 解析参数（支持 --key=value 和 --flag 两种格式）
function parseArgs() {
  const args = {};
  process.argv.slice(2).forEach(arg => {
    const match = arg.match(/^--(\w+)(?:=(.+))?$/);
    if (match) args[match[1]] = match[2] !== undefined ? match[2] : true;
  });
  return args;
}

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  const data = fs.readFileSync(filePath);
  hash.update(data);
  return hash.digest('hex');
}

function copyRecursive(src, dest) {
  if (!fs.existsSync(src)) return;
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      copyRecursive(path.join(src, entry), path.join(dest, entry));
    }
  } else {
    const destDir = path.dirname(dest);
    if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
    fs.copyFileSync(src, dest);
  }
}

function collectFiles(dir, baseDir, result = []) {
  if (!fs.existsSync(dir)) return result;
  for (const entry of fs.readdirSync(dir)) {
    const full = path.join(dir, entry);
    const rel = path.relative(baseDir, full).replace(/\\/g, '/');
    if (fs.statSync(full).isDirectory()) {
      collectFiles(full, baseDir, result);
    } else {
      result.push(rel);
    }
  }
  return result;
}

async function main() {
  const args = parseArgs();
  const version = args.version;
  const fromVersion = args.from;
  const filesArg = args.files;
  const minVersion = args.min || fromVersion;
  const changes = args.changes || '';
  const outputDir = path.resolve(args.output || './update/patches');

  if (!version || !fromVersion || !filesArg) {
    console.error('用法: node scripts/build-patch.js --version=1.0.5 --from=1.0.4 --files=renderer/index.html,renderer/js/app.js');
    process.exit(1);
  }

  const projectRoot = path.resolve(__dirname, '..');
  const tempDir = path.join(outputDir, `_temp_${version}`);
  const zipPath = path.join(outputDir, `patch-${version}.zip`);

  // 清理临时目录
  if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
  fs.mkdirSync(tempDir, { recursive: true });

  // 复制变更文件
  // ★ 路径映射：将 src/main/ → main/，src/renderer/ → renderer/
  //   使补丁包内部结构统一为 main/ 和 renderer/，与 patch-loader 和 setupPatchOverride 一致
  function mapPatchPath(relPath) {
    let p = relPath.replace(/\\/g, '/');
    if (p.startsWith('src/main/')) p = p.substring('src/'.length);      // src/main/xxx → main/xxx
    else if (p.startsWith('src/renderer/')) p = p.substring('src/'.length); // src/renderer/xxx → renderer/xxx
    return p;
  }

  const files = filesArg.split(',').map(f => f.trim());
  const allFiles = [];
  for (const file of files) {
    const src = path.join(projectRoot, file);
    if (!fs.existsSync(src)) {
      console.warn(`警告: 文件不存在，跳过: ${file}`);
      continue;
    }
    const mappedFile = mapPatchPath(file);
    const dest = path.join(tempDir, mappedFile);
    copyRecursive(src, dest);
    if (fs.statSync(src).isDirectory()) {
      collectFiles(dest, tempDir, allFiles);
    } else {
      allFiles.push(mappedFile);
    }
  }

  if (allFiles.length === 0) {
    console.error('没有有效的变更文件');
    process.exit(1);
  }

  // 生成 manifest.json
  // ★ 自动检测是否包含主进程文件（main/ 目录），主进程补丁需要重启才能生效
  const hasMainFiles = allFiles.some(f => f.startsWith('main/') || f === 'main' || f.includes('/main/'));
  const manifest = {
    version,
    from: fromVersion,
    to: version,
    minVersion,
    releaseDate: new Date().toISOString().split('T')[0],
    files: allFiles,
    changes,
    requiresRestart: hasMainFiles
  };
  fs.writeFileSync(path.join(tempDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

  // 打包 ZIP（用 PowerShell Compress-Archive）
  console.log(`正在打包 ${allFiles.length} 个文件...`);
  if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
  const psCmd = `Compress-Archive -Path "${tempDir}\\*" -DestinationPath "${zipPath}" -Force`;
  execSync(`powershell -NoProfile -Command "${psCmd}"`, { stdio: 'inherit' });

  // 计算校验和
  const checksum = sha256File(zipPath);
  const fileSize = fs.statSync(zipPath).size;

  // 清理临时目录
  fs.rmSync(tempDir, { recursive: true, force: true });

  // 输出结果
  console.log('\n========== 补丁包生成成功 ==========');
  console.log(`版本: ${fromVersion} → ${version}`);
  console.log(`文件: ${zipPath}`);
  console.log(`大小: ${(fileSize / 1024 / 1024).toFixed(2)} MB`);
  console.log(`SHA256: ${checksum}`);
  console.log(`变更文件数: ${allFiles.length}`);
  console.log(`包含主进程文件: ${hasMainFiles ? '是（需重启生效）' : '否（渲染进程文件，可热更新）'}`);

  // 输出 latest.json 片段
  const patchEntry = {
    from: fromVersion,
    to: version,
    url: `https://github.com/你的用户名/你的仓库/releases/download/v${version}/patch-${version}.zip`,
    size: fileSize,
    checksum: `sha256:${checksum}`,
    changes
  };

  console.log('\n========== latest.json 片段 ==========');
  console.log(JSON.stringify(patchEntry, null, 2));
  console.log('\n请将以上内容添加到 update/latest.json 的 patches 数组中');
}

main().catch(e => {
  console.error('执行失败:', e.message);
  process.exit(1);
});
