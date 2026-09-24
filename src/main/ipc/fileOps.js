const fs = require('fs');
const path = require('path');
const os = require('os');

const DANGEROUS_EXTENSIONS = ['.sys', '.dll', '.exe', '.bat', '.cmd', '.ps1', '.reg'];
const PROTECTED_DIRS = [
  process.env.SystemRoot || 'C:\\Windows',
  process.env.ProgramFiles || 'C:\\Program Files',
  process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)',
  process.env.APPDATA,
  process.env.LOCALAPPDATA
].filter(Boolean);

function isDangerousPath(targetPath) {
  const normalized = path.normalize(targetPath).toLowerCase();
  return PROTECTED_DIRS.some(dir => normalized.startsWith(dir.toLowerCase()));
}

function isDangerousExtension(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return DANGEROUS_EXTENSIONS.includes(ext);
}

async function list({ path: targetPath, recursive = false, showHidden = false }) {
  try {
    const dir = targetPath || os.homedir();
    if (!fs.existsSync(dir)) {
      return { success: false, error: '路径不存在', path: dir };
    }

    const entries = [];
    const readDir = (currentPath) => {
      const items = fs.readdirSync(currentPath, { withFileTypes: true });
      for (const item of items) {
        if (!showHidden && item.name.startsWith('.')) continue;
        const fullPath = path.join(currentPath, item.name);
        // 跳过无法访问的系统文件（如 DumpStack.log.tmp、pagefile.sys 等）
        let stat;
        try {
          stat = fs.statSync(fullPath);
        } catch (e) {
          // EPERM/EACCES/EBUSY 等权限错误，跳过该文件但仍显示基本信息
          if (e.code === 'EPERM' || e.code === 'EACCES' || e.code === 'EBUSY' || e.code === 'ENOENT') {
            entries.push({
              name: item.name,
              path: fullPath,
              isDirectory: item.isDirectory(),
              isFile: item.isFile(),
              size: null,
              modified: null,
              created: null,
              permissions: null,
              accessDenied: true
            });
            continue;
          }
          throw e;
        }
        entries.push({
          name: item.name,
          path: fullPath,
          isDirectory: item.isDirectory(),
          isFile: item.isFile(),
          size: stat.isFile() ? stat.size : null,
          modified: stat.mtime.toISOString(),
          created: stat.birthtime.toISOString(),
          permissions: stat.mode.toString(8)
        });
        if (recursive && item.isDirectory()) {
          readDir(fullPath);
        }
      }
    };
    readDir(dir);

    return { success: true, data: entries, path: dir, total: entries.length };
  } catch (error) {
    return { success: false, error: error.message, path: targetPath };
  }
}

async function read({ path: filePath, encoding = 'utf-8' }) {
  try {
    if (!fs.existsSync(filePath)) {
      return { success: false, error: '文件不存在', path: filePath };
    }
    const stat = fs.statSync(filePath);
    const content = fs.readFileSync(filePath, encoding);
    return {
      success: true,
      data: content,
      path: filePath,
      size: stat.size,
      modified: stat.mtime.toISOString()
    };
  } catch (error) {
    return { success: false, error: error.message, path: filePath };
  }
}

async function write({ path: filePath, content, encoding = 'utf-8' }) {
  try {
    if (!filePath) return { success: false, error: '文件路径不能为空' };
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, encoding);
    return { success: true, path: filePath };
  } catch (error) {
    return { success: false, error: error.message, path: filePath };
  }
}

async function copy({ sourcePath, destPath, overwrite = false }) {
  try {
    if (!fs.existsSync(sourcePath)) {
      return { success: false, error: '源路径不存在' };
    }
    if (!overwrite && fs.existsSync(destPath)) {
      return { success: false, error: '目标已存在', needsConfirm: true };
    }
    const stat = fs.statSync(sourcePath);
    if (stat.isDirectory()) {
      fs.mkdirSync(destPath, { recursive: true });
      const entries = fs.readdirSync(sourcePath);
      for (const entry of entries) {
        await copy({
          sourcePath: path.join(sourcePath, entry),
          destPath: path.join(destPath, entry),
          overwrite
        });
      }
    } else {
      fs.copyFileSync(sourcePath, destPath);
    }
    return { success: true, source: sourcePath, dest: destPath };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

async function move({ sourcePath, destPath, overwrite = false }) {
  try {
    if (isDangerousPath(sourcePath)) {
      return { success: false, error: '危险路径操作被阻止', warning: true };
    }
    if (!overwrite && fs.existsSync(destPath)) {
      return { success: false, error: '目标已存在', needsConfirm: true };
    }
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.renameSync(sourcePath, destPath);
    return { success: true, source: sourcePath, dest: destPath };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

async function deleteItem({ path: targetPath, recursive = false, force = false }) {
  try {
    if (!force && isDangerousPath(targetPath)) {
      return {
        success: false,
        error: '此操作可能影响系统重要文件',
        warning: true,
        needsConfirm: true,
        message: `即将删除系统保护路径下的文件: ${targetPath}\n此操作可能导致系统不稳定，请确认继续。`
      };
    }
    if (!force && !fs.existsSync(targetPath)) {
      return { success: false, error: '路径不存在' };
    }
    const stat = fs.statSync(targetPath);
    if (stat.isDirectory()) {
      if (!recursive) {
        const entries = fs.readdirSync(targetPath);
        if (entries.length > 0) {
          return {
            success: false,
            error: '目录非空',
            needsConfirm: true,
            message: `目录包含 ${entries.length} 个项目，是否递归删除？`
          };
        }
      }
      fs.rmSync(targetPath, { recursive: true, force });
    } else {
      fs.unlinkSync(targetPath);
    }
    return { success: true, path: targetPath };
  } catch (error) {
    return { success: false, error: error.message, path: targetPath };
  }
}

async function createDir({ path: dirPath }) {
  try {
    fs.mkdirSync(dirPath, { recursive: true });
    return { success: true, path: dirPath };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

async function rename({ path: targetPath, newName }) {
  try {
    const newPath = path.join(path.dirname(targetPath), newName);
    if (fs.existsSync(newPath)) {
      return { success: false, error: '目标名称已存在' };
    }
    fs.renameSync(targetPath, newPath);
    return { success: true, oldPath: targetPath, newPath };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

async function search({ query, path: searchPath, fileType = 'all', maxResults = 100 }) {
  const results = [];
  const searchRecursive = (currentPath) => {
    if (results.length >= maxResults) return;
    try {
      const entries = fs.readdirSync(currentPath, { withFileTypes: true });
      for (const entry of entries) {
        if (results.length >= maxResults) break;
        const fullPath = path.join(currentPath, entry.name);
        if (entry.name.toLowerCase().includes(query.toLowerCase())) {
          if (fileType === 'all' ||
              (fileType === 'file' && entry.isFile()) ||
              (fileType === 'directory' && entry.isDirectory())) {
            let stat;
            try {
              stat = fs.statSync(fullPath);
            } catch (e) {
              if (e.code === 'EPERM' || e.code === 'EACCES' || e.code === 'EBUSY' || e.code === 'ENOENT') continue;
              throw e;
            }
            results.push({
              name: entry.name,
              path: fullPath,
              isDirectory: entry.isDirectory(),
              size: stat.isFile() ? stat.size : null,
              modified: stat.mtime.toISOString()
            });
          }
        }
        if (entry.isDirectory()) {
          searchRecursive(fullPath);
        }
      }
    } catch (e) {
      // Skip directories without permission
    }
  };
  try {
    if (fs.existsSync(searchPath)) {
      searchRecursive(searchPath);
    }
    return { success: true, data: results, total: results.length };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

async function getInfo({ path: targetPath }) {
  try {
    if (!fs.existsSync(targetPath)) {
      return { success: false, error: '路径不存在' };
    }
    const stat = fs.statSync(targetPath);
    const isDanger = isDangerousPath(targetPath) || isDangerousExtension(targetPath);
    return {
      success: true,
      data: {
        name: path.basename(targetPath),
        path: targetPath,
        isDirectory: stat.isDirectory(),
        isFile: stat.isFile(),
        size: stat.size,
        sizeFormatted: formatSize(stat.size),
        created: stat.birthtime.toISOString(),
        modified: stat.mtime.toISOString(),
        accessed: stat.atime.toISOString(),
        permissions: stat.mode.toString(8),
        isDangerous: isDanger,
        dangerReason: isDangerousPath(targetPath) ? '系统保护路径' : (isDangerousExtension(targetPath) ? '可执行文件类型' : null)
      }
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

function formatSize(bytes) {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const k = 1024;
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + units[i];
}

module.exports = { list, read, write, copy, move, delete: deleteItem, createDir, rename, search, getInfo, isDangerousPath, isDangerousExtension };