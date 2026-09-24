/**
 * 主进程补丁加载器
 *
 * 功能：在应用启动最早期安装 Module._load 钩子，使主进程代码（src/main/ 下的模块）
 *       也能被补丁包覆盖，而不仅仅是渲染进程（renderer/）的文件。
 *
 * 原理：
 *   1. 读取 userData/patches/applied.json，获取所有已应用的补丁版本
 *   2. 按版本号降序扫描每个补丁的 main/ 目录，构建「相对路径 → 补丁文件绝对路径」映射
 *   3. 安装 Module._load 钩子：当 require 解析后的路径在 app.asar/src/main/ 下时，
 *      若补丁映射中有对应文件，则用 Module._compile 手动编译补丁文件，
 *      并将 __filename 伪装成原始 app.asar 路径——这样补丁文件内部的相对 require
 *      （如 require('./config')）会正确解析到 app.asar 中的原始文件，
 *      若该文件也在补丁中则再次被钩子拦截加载补丁版本。
 *
 * 注意：本文件必须在 main.js 中所有业务模块 require 之前加载（electron require 之后即可）。
 *       主进程补丁需要重启应用才能生效（因为模块在启动时加载）。
 */

const Module = require('module');
const path = require('path');
const fs = require('fs');

// ========== 初始化：读取已应用补丁，构建文件映射 ==========

let patchesDir = '';
let patchFileMap = {}; // key: 'src/main/ipc/updateOps.js'  value: 补丁文件的绝对路径
let initialized = false;

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

function scanPatchDir(dir, relBase, map) {
  if (!fs.existsSync(dir)) return;
  try {
    for (const entry of fs.readdirSync(dir)) {
      const full = path.join(dir, entry);
      const rel = relBase + '/' + entry;
      let stat;
      try { stat = fs.statSync(full); } catch (e) { continue; }
      if (stat.isDirectory()) {
        scanPatchDir(full, rel, map);
      } else {
        // 高版本优先：按降序遍历时，先遇到的高版本先写入，低版本不覆盖
        if (!map[rel]) {
          map[rel] = full;
        }
      }
    }
  } catch (e) {
    console.error('[PatchLoader] 扫描补丁目录失败:', dir, e.message);
  }
}

function init() {
  if (initialized) return;
  initialized = true;

  try {
    const { app } = require('electron');
    patchesDir = path.join(app.getPath('userData'), 'patches');
    const appliedFile = path.join(patchesDir, 'applied.json');
    const pendingFile = path.join(patchesDir, 'pending.json');

    // ★ 自行处理待生效补丁：将 pending.json 中的版本合并到 applied.json
    //   因为 patch-loader 在 updateOps 之前加载，必须自己完成 pending→applied 的转换，
    //   否则当次下载的补丁需要两次重启才能生效。
    //   updateOps 中的 activatePendingPatches 仍然保留（幂等，pending 已被删除则跳过）。
    if (fs.existsSync(pendingFile)) {
      try {
        const pending = JSON.parse(fs.readFileSync(pendingFile, 'utf-8').replace(/^\uFEFF/, ''));
        const pendingVers = pending.versions || (pending.version ? [pending.version] : []);
        if (pendingVers.length > 0) {
          let applied = [];
          if (fs.existsSync(appliedFile)) {
            try { applied = JSON.parse(fs.readFileSync(appliedFile, 'utf-8').replace(/^\uFEFF/, '')); } catch (e) { applied = []; }
          }
          if (!Array.isArray(applied)) applied = [];
          for (const v of pendingVers) {
            if (!applied.includes(v)) applied.push(v);
          }
          fs.writeFileSync(appliedFile, JSON.stringify(applied));
          console.log('[PatchLoader] 待生效补丁已激活:', pendingVers.join(', '));
        }
        fs.unlinkSync(pendingFile);
      } catch (e) {
        console.error('[PatchLoader] 处理待生效补丁失败:', e.message);
      }
    }

    if (!fs.existsSync(appliedFile)) {
      console.log('[PatchLoader] 无已应用补丁，跳过');
      return;
    }

    let applied = JSON.parse(fs.readFileSync(appliedFile, 'utf-8').replace(/^\uFEFF/, ''));
    if (!Array.isArray(applied) || applied.length === 0) {
      console.log('[PatchLoader] 已应用补丁列表为空，跳过');
      return;
    }

    // 按版本号降序排列（高版本优先，先写入映射，低版本不覆盖）
    applied.sort((a, b) => compareVersions(b, a));

    console.log('[PatchLoader] 已应用补丁版本（降序）:', applied.join(', '));

    // 扫描每个补丁的 main/ 目录
    for (const ver of applied) {
      const mainDir = path.join(patchesDir, String(ver), 'main');
      if (fs.existsSync(mainDir)) {
        scanPatchDir(mainDir, 'src/main', patchFileMap);
      }
    }

    const count = Object.keys(patchFileMap).length;
    if (count > 0) {
      console.log('[PatchLoader] 主进程补丁文件映射已构建，共', count, '个文件:');
      for (const [rel, abs] of Object.entries(patchFileMap)) {
        console.log('  -', rel, '→', abs);
      }
    } else {
      console.log('[PatchLoader] 补丁中无主进程文件（main/ 目录为空）');
    }
  } catch (e) {
    console.error('[PatchLoader] 初始化失败:', e.message);
  }
}

// ========== 安装 Module._load 钩子 ==========

const originalLoad = Module._load;
const originalResolveFilename = Module._resolveFilename;

Module._load = function (request, parent, isMain) {
  // 只在初始化完成后才拦截（init 内部 require electron 时不应被拦截）
  if (initialized && patchFileMap && Object.keys(patchFileMap).length > 0 && parent && parent.filename) {
    try {
      // 解析 require 的绝对路径
      const resolved = originalResolveFilename(request, parent, isMain);
      const normalized = resolved.replace(/\\/g, '/');

      // 只拦截 src/main/ 下的模块
      const mainIdx = normalized.indexOf('/src/main/');
      if (mainIdx !== -1) {
        const relPath = normalized.substring(mainIdx + 1); // 如 "src/main/ipc/updateOps.js"

        if (patchFileMap[relPath]) {
          const patchFile = patchFileMap[relPath];
          console.log('[PatchLoader] 加载补丁模块:', relPath);

          // 使用 Module._compile 手动编译补丁文件
          // 关键：将 filename 设为原始 app.asar 路径，这样补丁文件内部的
          // 相对 require（如 require('./config')）会基于原始路径解析，
          // 从而能正确找到 app.asar 中的依赖；若依赖也在补丁中则再次被钩子拦截
          const mod = new Module(resolved, parent);
          mod.filename = resolved;
          mod.paths = Module._nodeModulePaths(path.dirname(resolved));

          const ext = path.extname(patchFile).toLowerCase();
          if (ext === '.json') {
            // JSON 文件直接解析
            mod.exports = JSON.parse(fs.readFileSync(patchFile, 'utf-8').replace(/^\uFEFF/, ''));
          } else {
            // JS 文件用 _compile 编译（自动处理 BOM）
            const content = fs.readFileSync(patchFile, 'utf-8');
            mod._compile(content, resolved);
          }

          mod.loaded = true;
          return mod.exports;
        }
      }
    } catch (e) {
      // 解析失败或编译失败时，回退到原始加载逻辑
      // 不打印错误，避免干扰正常的模块不存在等情况
    }
  }

  return originalLoad(request, parent, isMain);
};

// 执行初始化（此时 electron 已可 require）
init();

module.exports = {
  getPatchFileMap: () => ({ ...patchFileMap }),
  getPatchesDir: () => patchesDir,
  isInitialized: () => initialized
};
