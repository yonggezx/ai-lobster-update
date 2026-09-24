const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let modelRegistry = null;
let modelsPath = null;

function init(basePath) {
  modelsPath = basePath;
  const registryPath = path.join(basePath, 'registry.json');
  if (fs.existsSync(registryPath)) {
    try {
      modelRegistry = JSON.parse(fs.readFileSync(registryPath, 'utf-8'));
    } catch (e) {
      modelRegistry = [];
    }
  } else {
    modelRegistry = [];
    saveRegistry();
  }
}

function saveRegistry() {
  if (!modelsPath) return;
  const registryPath = path.join(modelsPath, 'registry.json');
  fs.writeFileSync(registryPath, JSON.stringify(modelRegistry, null, 2), 'utf-8');
}

function getModelList() {
  return modelRegistry || [];
}

function importModel(sourcePath, destBasePath) {
  try {
    if (!fs.existsSync(sourcePath)) {
      return { success: false, error: '源路径不存在' };
    }

    const stat = fs.statSync(sourcePath);

    // 收集源路径中所有有效的模型
    let sourceDir = sourcePath;
    let allModels = [];

    if (stat.isFile()) {
      // 单个文件：验证该文件，导入其所在目录
      const validation = validateModel(sourcePath);
      if (!validation.valid) {
        return { success: false, error: validation.error };
      }
      sourceDir = path.dirname(sourcePath);
      allModels = [validation];
    } else {
      // 目录：先检测是否为「组合模型包」（同目录含多个 MMD 文件，如 角色+武器）
      const mmdAll = findAllMMD(sourcePath);
      if (mmdAll.length >= 2) {
        const mmdValidations = mmdAll.map(f => ({
          valid: true,
          type: 'MMD',
          format: /\.pmd$/i.test(f) ? 'MMD/PMD' : 'MMD/PMX',
          name: path.basename(f, path.extname(f)),
          version: '1.0.0',
          description: '',
          modelFile: f
        }));
        return importComboModel(sourcePath, destBasePath, mmdValidations);
      }
      // 普通目录：查找目录中所有有效模型
      allModels = validateAllModels(sourcePath);
      if (allModels.length === 0) {
        return { success: false, error: '未找到有效的模型文件（Live2D 需 model3.json / Cubism2 JSON；MMD 需 .pmx / .pmd）' };
      }
    }

    // 为每个模型创建独立的导入记录
    const importedModels = [];

    for (const modelValidation of allModels) {
      const modelId = crypto.randomUUID();
      const destDir = path.join(destBasePath, modelId);
      fs.mkdirSync(destDir, { recursive: true });

      // 复制整个源目录到目标
      copyDir(sourceDir, destDir);

      // 自动补全 model3.json：很多 Cubism4 模型缺少 Motions/Expressions 引用，
      // 导致 pixi-live2d-display 发现不了磁盘上实际存在的动作/表情文件
      patchLive2DModelJson(destDir);

      // 检测是否为 BongoCat 键盘猫模型（含 resources/left-keys/ 或 right-keys/ 按键图片文件夹）
      // 注意：此函数有完整try-catch保护，检测失败不影响普通模型导入
      let isBongocat = false;
      try { isBongocat = detectBongocatModel(destDir); } catch(e) { isBongocat = false; }

      // 在目标目录中通过原始模型文件的相对路径找到对应的文件
      const relativePath = path.relative(sourceDir, modelValidation.modelFile);
      const installedModelFile = path.join(destDir, relativePath);

      const modelInfo = {
        id: modelId,
        name: modelValidation.name || path.basename(sourceDir),
        type: modelValidation.type,
        format: modelValidation.format,
        installPath: destDir,
        modelFile: installedModelFile,
        thumbnail: findCoverImage(path.dirname(installedModelFile), path.basename(installedModelFile, path.extname(installedModelFile))) || null,
        description: modelValidation.description || '',
        importedAt: new Date().toISOString(),
        version: modelValidation.version || '1.0.0',
        size: getDirSize(destDir),
        isBongocat: isBongocat  // ★ 标记是否为 BongoCat 键盘猫模型
      };

      modelRegistry.push(modelInfo);
      importedModels.push(modelInfo);
    }

    saveRegistry();

    // 兼容旧接口：返回 data 为单个模型（如果只有一个）或数组
    if (importedModels.length === 1) {
      return { success: true, data: importedModels[0], models: importedModels };
    }
    return { success: true, data: importedModels[0], models: importedModels, count: importedModels.length };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// 组合模型包导入：同目录含多个 MMD 文件（如 角色 + 武器），
// 复制整目录一次，生成【单个】逻辑模型条目，modelFile 指向主模型，
// comboModels 记录所有部件路径。这样在模型列表里它是一个整体、可整体选择/加载。
function importComboModel(sourcePath, destBasePath, mmdValidations) {
  try {
    const modelId = crypto.randomUUID();
    const destDir = path.join(destBasePath, modelId);
    fs.mkdirSync(destDir, { recursive: true });

    // 仅复制一次源目录（组合包所有部件共用同一安装目录）
    copyDir(sourcePath, destDir);

    const comboModels = mmdValidations.map(v => {
      const relativePath = path.relative(sourcePath, v.modelFile);
      const installedModelFile = path.join(destDir, relativePath);
      return {
        name: v.name,
        modelFile: installedModelFile,
        format: v.format
      };
    });
    // 智能选择主模型（身体/人物）：排除武器类名称后取体积最大者，
    // 避免「武器」被误选为主模型（之前固定取 comboModels[0]，排序后常为武器）。
    const primaryIndex = selectPrimaryIndex(comboModels);
    const primary = comboModels[primaryIndex];

    // 每个部件的相对变换（位置/旋转/缩放）。默认 null 表示「未微调、保持模型原始位姿」，
    // 由前端 Shift+F4 微调并保存后写入实际局部坐标，用于把武器精确放到人物手上。
    const partTransforms = comboModels.map(() => null);

    const modelInfo = {
      id: modelId,
      name: path.basename(sourcePath) + '（组合）',
      type: 'MMD',
      format: 'MMD/PMX 组合',
      isCombo: true,
      installPath: destDir,
      modelFile: primary.modelFile,
      primaryIndex: primaryIndex,
      comboModels: comboModels,
      partTransforms: partTransforms,
      thumbnail: findCoverImage(path.dirname(primary.modelFile), path.basename(primary.modelFile, path.extname(primary.modelFile))) || null,
      description: '组合模型包：' + comboModels.map(c => c.name).join(' + '),
      importedAt: new Date().toISOString(),
      version: '1.0.0',
      size: getDirSize(destDir)
    };

    modelRegistry.push(modelInfo);
    saveRegistry();

    return { success: true, data: modelInfo, models: [modelInfo], combo: true, count: 1 };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// 判断模型名是否为「明显配件」（武器/手持物），用于组合包主模型选择时排除。
function isAccessoryName(name) {
  if (!name) return false;
  const n = String(name).toLowerCase();
  const kw = ['杖', '武器', '枪', '炮', '刀', '剑', '盾', '弓', '棒', '锤', '叉', '戟', '鞭', '伞', '扇',
    'staff', 'weapon', 'sword', 'gun', 'bow', 'shield', 'spear', 'axe', 'club', 'wand', 'cane',
    'blade', 'knife', 'lance', 'halberd', 'mace'];
  return kw.some(k => n.includes(k));
}

// 组合包主模型选择：优先排除明显配件名称，再在候选里取文件体积最大者
// （完整人物模型骨骼/顶点远多于简单武器，体积通常大一个数量级）。
// 这样「角色 + 武器」类组合包会把人物设为主体（带动画引擎），武器作为附加部件。
function selectPrimaryIndex(comboModels) {
  if (!Array.isArray(comboModels) || comboModels.length === 0) return 0;
  if (comboModels.length === 1) return 0;
  const sizeOf = (m) => {
    try { return fs.statSync(m.modelFile).size || 0; } catch (e) { return 0; }
  };
  const nonAcc = comboModels
    .map((m, i) => ({ m, i }))
    .filter(({ m }) => !isAccessoryName(m.name));
  const pool = nonAcc.length ? nonAcc : comboModels.map((m, i) => ({ m, i }));
  let best = pool[0];
  for (const e of pool) if (sizeOf(e.m) > sizeOf(best.m)) best = e;
  return best.i;
}

// 在给定路径(文件或目录)中查找 MMD 模型文件(.pmx / .pmd)
// 返回首个匹配的文件绝对路径，未找到返回 null
function findMMDFile(modelPath) {
  try {
    if (!fs.existsSync(modelPath)) return null;
    if (fs.statSync(modelPath).isFile()) {
      return /\.(pmx|pmd)$/i.test(modelPath) ? modelPath : null;
    }
    const files = walkDir(modelPath);
    // 优先匹配 .pmx（新版 MMD 格式），其次 .pmd（旧版）
    const pmx = files.find(f => /\.pmx$/i.test(f));
    if (pmx) return pmx;
    const pmd = files.find(f => /\.pmd$/i.test(f));
    return pmd || null;
  } catch (e) {
    return null;
  }
}

// 查找目录中所有 MMD 模型文件(.pmx / .pmd)，返回全部匹配路径（组合模型包用）
function findAllMMD(modelPath) {
  try {
    if (!fs.existsSync(modelPath)) return [];
    if (fs.statSync(modelPath).isFile()) {
      return /\.(pmx|pmd)$/i.test(modelPath) ? [modelPath] : [];
    }
    const files = walkDir(modelPath).filter(f => /\.(pmx|pmd)$/i.test(f));
    // 优先 .pmx 再 .pmd，并按路径排序保持顺序稳定
    files.sort((a, b) => {
      const ax = /\.pmx$/i.test(a) ? 0 : 1;
      const bx = /\.pmx$/i.test(b) ? 0 : 1;
      if (ax !== bx) return ax - bx;
      return a.localeCompare(b);
    });
    return files;
  } catch (e) {
    return [];
  }
}

// 检测是否为 BongoCat 键盘猫模型：
// 1. 含 resources/left-keys/ 或 right-keys/ 按键图片文件夹（递归查找，兼容模型在子目录的情况）
// 2. 模型文件名含 cat/bongo/键盘猫 等关键词（递归查找）
// 3. 模型目录含 cdi3.json/cdi.json 且其中含 CatParam 或 ParamMouse 参数（递归查找）
// ★ 修复：之前只查 modelDir/resources/left-keys 顶层路径，对模型文件在子目录
//   （如 "镜流 · 标准模式/"）的 bongocat 模型会漏判，导致 isBongocat 标记错误、
//   运行时无法识别。现改为递归扫描整棵目录树。
function detectBongocatModel(modelDir, _depth) {
  try {
    if (!fs.existsSync(modelDir)) return false;
    let foundKeyDir = false;
    let foundFileName = false;
    let foundCdiParam = false;
    const MAX_DEPTH = 8;
    const scan = (dir, depth) => {
      if (foundKeyDir && foundFileName && foundCdiParam) return; // 三项都已命中可提前结束
      if (depth > MAX_DEPTH) return;
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
      for (const e of entries) {
        if (foundKeyDir && foundFileName && foundCdiParam) return;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          const low = e.name.toLowerCase();
          if (low === 'left-keys' || low === 'right-keys') {
            foundKeyDir = true;
            continue; // 命中后不再递归进该目录（里面只有图片）
          }
          scan(full, depth + 1);
        } else if (e.isFile()) {
          if (/\.model3\.json$/i.test(e.name) || /\.model\.json$/i.test(e.name)) {
            if (/\b(cat|bongo|neko|kitten)\b|键盘|猫/i.test(e.name)) foundFileName = true;
          }
          if (/\.cdi3?\.json$/i.test(e.name)) {
            try {
              const cdi = JSON.parse(fs.readFileSync(full, 'utf-8'));
              const params = (cdi.Parameters || []).map(p => p.Id || '').join(',');
              if (/CatParamLeftHandDown|CatParamRightHandDown|ParamMouseX|ParamMouseY/i.test(params)) foundCdiParam = true;
            } catch (_) {}
          }
        }
      }
    };
    scan(modelDir, 0);
    return foundKeyDir || foundFileName || foundCdiParam;
  } catch (e) {
    return false;
  }
}

// 在模型目录中智能匹配封面图，优先级：
// 1. thumbnail.ext（模型渲染后的图片/用户手动设置的缩略图）— 最高优先级
// 2. 文件名包含模型名称的图片 — 次高优先级
// 3. 文件名包含 preview/thumb/icon/cover/banner 等明确预览关键词的图片
// 如果没有以上图片，返回 null，不用模型目录中的其他图片（如纹理、截图等）代替。
// 跳过 textures/material 等贴图子目录，避免把模型贴图当成封面。
function findCoverImage(modelDir, baseName) {
  try {
    if (!fs.existsSync(modelDir)) return null;
    const imgExts = ['.gif', '.png', '.jpg', '.jpeg', '.webp', '.bmp'];
    const skipDirs = /(^|[\\/])(textures?|tex|materials?|material|toon|physics|animations?|motions?)([\\/]|$)/i;
    // 明确的预览图关键词：只有文件名包含这些词才认为是预览图
    const previewKeywords = /(preview|thumb|icon|cover|banner|main|model|image|screenshot|demo|showcase)/i;
    const files = walkDir(modelDir).filter(f => {
      const e = path.extname(f).toLowerCase();
      if (!imgExts.includes(e)) return false;
      if (skipDirs.test(f)) return false;
      const name = path.basename(f, path.extname(f));
      // ★ 保留：thumbnail（渲染后的图片）、文件名包含模型名称、或包含预览关键词
      if (name.toLowerCase() === 'thumbnail') return true;
      if (baseName && name.toLowerCase().includes(baseName.toLowerCase())) return true;
      if (previewKeywords.test(name)) return true;
      return false;
    });
    if (files.length === 0) return null;

    // 评分函数：优先级 thumbnail > 模型名称 > 预览关键词 > 目录深度
    const score = (f) => {
      const name = path.basename(f, path.extname(f)).toLowerCase();
      let s = 0;
      // 最高优先级：thumbnail（模型渲染后的图片/用户手动设置的缩略图）
      if (name === 'thumbnail') s += 10;
      // 次高优先级：文件名包含模型名称
      if (baseName && name.includes(baseName.toLowerCase())) s += 5;
      // 明确的预览关键词
      if (/preview|cover|banner|screenshot|demo|showcase/.test(name)) s += 3;
      if (/thumb|icon|main|model|image/.test(name)) s += 2;
      // 目录深度：根目录或一级子目录优先
      const depth = f.split(/[\\/]/).length - modelDir.split(/[\\/]/).length;
      if (depth <= 1) s += 1;
      return s;
    };

    // 优先返回 GIF 动图（模型目录中的 gif 通常就是预览动图）
    const gifs = files.filter(f => path.extname(f).toLowerCase() === '.gif');
    if (gifs.length > 0) {
      gifs.sort((a, b) => (score(b) - score(a)) || a.localeCompare(b));
      return gifs[0];
    }

    // 无 GIF 时回退到静态图片，按评分排序
    files.sort((a, b) => (score(b) - score(a)) || a.localeCompare(b));
    return files[0];
  } catch (e) {
    return null;
  }
}

function validateModel(modelPath) {
  try {
    if (!fs.existsSync(modelPath)) {
      return { valid: false, error: '路径不存在' };
    }

    // MMD 模型(.pmx / .pmd)：3D 模型，与 Live2D 完全不同的格式
    const mmdFile = findMMDFile(modelPath);
    if (mmdFile) {
      return {
        valid: true,
        type: 'MMD',
        format: /\.pmd$/i.test(mmdFile) ? 'MMD/PMD' : 'MMD/PMX',
        name: path.basename(mmdFile, path.extname(mmdFile)),
        version: '1.0.0',
        description: '',
        modelFile: mmdFile
      };
    }

    // 收集所有候选 JSON 文件
    let candidateFiles = [];
    if (fs.statSync(modelPath).isDirectory()) {
      const files = walkDir(modelPath);
      // 优先按文件名匹配标准格式
      candidateFiles = files.filter(f => /\.json$/i.test(f));
    } else {
      if (/\.json$/i.test(modelPath)) {
        candidateFiles = [modelPath];
      }
    }

    // 逐个检测 JSON 内容判断模型类型
    for (const jsonFile of candidateFiles) {
      try {
        const data = JSON.parse(fs.readFileSync(jsonFile, 'utf-8'));

        // Cubism 4: .model3.json — 含 FileReferences 和 Version
        if (data.FileReferences && (data.FileReferences.Moc || data.FileReferences.Physics)) {
          return {
            valid: true,
            type: 'Live2D',
            format: 'Cubism 4',
            name: data.FileReferences?.Moc || path.basename(path.dirname(jsonFile)),
            version: data.Version || '4',
            description: data.Description || '',
            modelFile: jsonFile,
            data
          };
        }

        // Cubism 2: 含 model + textures 字段（文件名可能是 model.json, xxx.json 等）
        if (data.model && data.textures && Array.isArray(data.textures)) {
          return {
            valid: true,
            type: 'Live2D',
            format: 'Cubism 2',
            name: data.name || path.basename(path.dirname(jsonFile)),
            version: data.version || '2',
            description: '',
            modelFile: jsonFile,
            data
          };
        }
      } catch (e) {
        // 不是有效 JSON，跳过
      }
    }

    return { valid: false, error: '未找到有效的模型文件（Live2D 需 model3.json / Cubism2 JSON；MMD 需 .pmx / .pmd）' };
  } catch (error) {
    return { valid: false, error: error.message };
  }
}

// 查找目录中所有有效的模型文件（Live2D 与 MMD 都收集，不提前return）
function validateAllModels(modelPath) {
  const results = [];
  try {
    if (!fs.existsSync(modelPath) || !fs.statSync(modelPath).isDirectory()) {
      return results;
    }

    const files = walkDir(modelPath);

    // MMD 模型：.pmx / .pmd（整目录作为一个模型，沿用原有「首个即代表」语义，
    // 组合模型包的多 MMD 检测在 importModel 内通过 findAllMMD 单独处理）
    const mmdFile = findMMDFile(modelPath);
    if (mmdFile) {
      results.push({
        valid: true,
        type: 'MMD',
        format: /\.pmd$/i.test(mmdFile) ? 'MMD/PMD' : 'MMD/PMX',
        name: path.basename(mmdFile, path.extname(mmdFile)),
        version: '1.0.0',
        description: '',
        modelFile: mmdFile
      });
      return results;
    }

    const candidateFiles = files.filter(f => /\.json$/i.test(f));

    for (const jsonFile of candidateFiles) {
      try {
        const data = JSON.parse(fs.readFileSync(jsonFile, 'utf-8'));

        // Cubism 4: .model3.json
        if (data.FileReferences && (data.FileReferences.Moc || data.FileReferences.Physics)) {
          results.push({
            valid: true,
            type: 'Live2D',
            format: 'Cubism 4',
            name: data.FileReferences?.Moc || path.basename(path.dirname(jsonFile)),
            version: data.Version || '4',
            description: data.Description || '',
            modelFile: jsonFile,
            data
          });
          continue;
        }

        // Cubism 2: model + textures
        if (data.model && data.textures && Array.isArray(data.textures)) {
          results.push({
            valid: true,
            type: 'Live2D',
            format: 'Cubism 2',
            name: data.name || path.basename(path.dirname(jsonFile)),
            version: data.version || '2',
            description: '',
            modelFile: jsonFile,
            data
          });
        }
      } catch (e) {
        // 不是有效 JSON，跳过
      }
    }
  } catch (error) {}

  return results;
}

// 可视化编辑模型元数据：支持修改 name / description / thumbnail
// updates.thumbnail:
//   - 字符串图片路径 → 复制进模型目录并记录（覆盖旧缩略图文件）
//   - null / ''      → 移除缩略图（删除缩略图文件，thumbnail 置空）
function updateModel(modelId, updates) {
  try {
    const model = modelRegistry.find(m => m.id === modelId);
    if (!model) {
      return { success: false, error: '模型不存在' };
    }

    if (!updates || typeof updates !== 'object') {
      return { success: false, error: '无效的更新数据' };
    }

    // 名称：复用与重命名相同的校验规则
    if (typeof updates.name === 'string') {
      const trimmedName = updates.name.trim();
      if (!trimmedName) {
        return { success: false, error: '名称不能为空' };
      }
      if (trimmedName.length > 50) {
        return { success: false, error: '名称不能超过50个字符' };
      }
      model.name = trimmedName;
    }

    // 描述
    if (typeof updates.description === 'string') {
      model.description = updates.description;
    }

    // 组合模型：主模型索引
    if (typeof updates.primaryIndex === 'number' && Number.isInteger(updates.primaryIndex) && updates.primaryIndex >= 0) {
      model.primaryIndex = updates.primaryIndex;
    }

    // 组合模型：每个部件的相对变换（位置/旋转/缩放），由前端 Shift+F4 微调后回写。
    // null 表示「未微调、保持模型原始位姿」；非 null 才应用实际局部坐标。
    if (updates.partTransforms && Array.isArray(updates.partTransforms)) {
      model.partTransforms = updates.partTransforms.map((t) => {
        if (!t || typeof t !== 'object') return null;
        return {
          position: Array.isArray(t.position) ? t.position.slice(0, 3) : null,
          rotation: Array.isArray(t.rotation) ? t.rotation.slice(0, 3) : null,
          scale: (typeof t.scale === 'number' && t.scale > 0) ? t.scale : 1
        };
      });
    }

    // 缩略图
    if (Object.prototype.hasOwnProperty.call(updates, 'thumbnail')) {
      const thumb = updates.thumbnail;
      if (thumb === null || thumb === '') {
        // 移除旧缩略图文件
        if (model.thumbnail && fs.existsSync(model.thumbnail)) {
          try { fs.unlinkSync(model.thumbnail); } catch (e) { /* ignore */ }
        }
        model.thumbnail = null;
      } else if (typeof thumb === 'string' && fs.existsSync(thumb)) {
        const ext = path.extname(thumb).toLowerCase();
        const allowed = ['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif'];
        if (!allowed.includes(ext)) {
          return { success: false, error: '缩略图仅支持 PNG / JPG / WEBP / BMP / GIF 格式' };
        }
        const destFile = path.join(model.installPath, 'thumbnail' + ext);
        fs.copyFileSync(thumb, destFile);
        // 清理旧的缩略图文件（避免多个残留）
        if (model.thumbnail && model.thumbnail !== destFile && fs.existsSync(model.thumbnail)) {
          try { fs.unlinkSync(model.thumbnail); } catch (e) { /* ignore */ }
        }
        model.thumbnail = destFile;
      } else {
        return { success: false, error: '缩略图文件不存在' };
      }
    }

    saveRegistry();
    return { success: true, data: model };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// 重新扫描模型目录中的图片，优先识别 GIF 动图作为缩略图
// 用于已导入模型在新版逻辑下自动刷新预览图（从静态图 → GIF 动图）
function rescanThumbnail(modelId) {
  try {
    const model = modelRegistry.find(m => m.id === modelId);
    if (!model) {
      return { success: false, error: '模型不存在' };
    }
    const modelFile = model.modelFile || '';
    const modelDir = model.installPath || path.dirname(modelFile);
    const baseName = path.basename(modelFile, path.extname(modelFile));
    const newThumb = findCoverImage(modelDir, baseName);
    // 如果新旧缩略图不同（包括从静态图变为 GIF），更新并保存
    if (newThumb !== model.thumbnail) {
      model.thumbnail = newThumb || null;
      saveRegistry();
    }
    return { success: true, data: model };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// 读取模型目录下的动作配置 actions.json（每模型独立一套动作）
function getActions(modelId) {
  try {
    const model = modelRegistry.find(m => m.id === modelId);
    if (!model) return { success: false, error: '模型不存在' };
    const actionsPath = path.join(model.installPath, 'actions.json');
    if (!fs.existsSync(actionsPath)) {
      return { success: true, data: { idle: null, actions: {} } };
    }
    const data = JSON.parse(fs.readFileSync(actionsPath, 'utf-8'));
    return { success: true, data };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// 写入模型目录下的动作配置 actions.json
function saveActions(modelId, data) {
  try {
    const model = modelRegistry.find(m => m.id === modelId);
    if (!model) return { success: false, error: '模型不存在' };
    if (!data || typeof data !== 'object') return { success: false, error: '无效的配置数据' };
    if (!data.actions || typeof data.actions !== 'object') {
      return { success: false, error: '配置缺少 actions 字段' };
    }
    const actionsPath = path.join(model.installPath, 'actions.json');
    fs.writeFileSync(actionsPath, JSON.stringify(data, null, 2), 'utf-8');
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

function deleteModel(modelId) {
  try {
    const index = modelRegistry.findIndex(m => m.id === modelId);
    if (index === -1) {
      return { success: false, error: '模型不存在' };
    }

    const model = modelRegistry[index];
    if (fs.existsSync(model.installPath)) {
      fs.rmSync(model.installPath, { recursive: true, force: true });
    }

    modelRegistry.splice(index, 1);
    saveRegistry();
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

function renameModel(modelId, newName) {
  try {
    const model = modelRegistry.find(m => m.id === modelId);
    if (!model) {
      return { success: false, error: '模型不存在' };
    }
    const trimmedName = (newName || '').trim();
    if (!trimmedName) {
      return { success: false, error: '名称不能为空' };
    }
    if (trimmedName.length > 50) {
      return { success: false, error: '名称不能超过50个字符' };
    }
    model.name = trimmedName;
    saveRegistry();
    return { success: true, data: model };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

function copyDir(src, dest) {
  if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function walkDir(dir) {
  const results = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...walkDir(fullPath));
      } else {
        results.push(fullPath);
      }
    }
  } catch (e) {}
  return results;
}

function getDirSize(dir) {
  let total = 0;
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        total += getDirSize(fullPath);
      } else {
        total += fs.statSync(fullPath).size;
      }
    }
  } catch (e) {}
  return total;
}

// 校验 registry 中所有模型文件是否存在，移除已失效的条目，返回有效模型列表
function validateRegistry() {
  if (!modelRegistry) return [];
  const valid = [];
  let changed = false;
  for (const model of modelRegistry) {
    if (model.modelFile && fs.existsSync(model.modelFile)) {
      valid.push(model);
    } else {
      changed = true;
      // 尝试清理失效的安装目录
      try {
        if (model.installPath && fs.existsSync(model.installPath)) {
          fs.rmSync(model.installPath, { recursive: true, force: true });
        }
      } catch (e) { /* ignore */ }
    }
  }
  if (changed) {
    modelRegistry = valid;
    saveRegistry();
  }
  return valid;
}

// 获取第一个有效模型（跳过 registry 中文件不存在的条目）
function getFirstValidModel() {
  if (!modelRegistry) return null;
  for (const model of modelRegistry) {
    if (model.modelFile && fs.existsSync(model.modelFile)) {
      return model;
    }
  }
  return null;
}

// ====== Live2D 模型 JSON 自动补全 ======
// 很多 Cubism 4 模型的 model3.json 缺少 FileReferences.Motions / Expressions 字段，
// 导致 pixi-live2d-display 无法发现磁盘上实际存在的 .motion3.json / .exp3.json 文件。
// 本函数在导入后扫描目录并自动注入引用，让动作模组面板/小键盘能正常工作。

function patchLive2DModelJson(destDir) {
  try {
    // 找模型配置文件（优先 Cubism 4 的 model3.json）
    const modelJsonPath = path.join(destDir, 'miku.model3.json') ||
      fs.readdirSync(destDir).find(f => /\.model3\.json$/i.test(f));
    let modelJsonFile = null;
    try {
      const entries = fs.readdirSync(destDir);
      modelJsonFile = entries.find(f => /\.model3\.json$/i.test(f)) || entries.find(f => /^model\.json$/i.test(f));
    } catch (e) { return; }
    if (!modelJsonFile) return;
    const fullPath = path.join(destDir, modelJsonFile);
    const raw = fs.readFileSync(fullPath, 'utf-8');
    const json = JSON.parse(raw);
    if (!json.FileReferences) return;

    const isCubism4 = /\.model3\.json$/i.test(modelJsonFile);
    let patched = false;

    // --- 补 Expressions（Cubism4: .exp3.json / Cubism2: .exp.json）---
    // pixi-live2d-display 要求 Expressions 是【数组】：[{ Name, File }]，每个条目是一个表情。
    if (!json.FileReferences.Expressions || (Array.isArray(json.FileReferences.Expressions) && json.FileReferences.Expressions.length === 0)) {
      try {
        const ext = isCubism4 ? '.exp3.json' : '.exp.json';
        const files = fs.readdirSync(destDir)
          .filter(f => f.toLowerCase().endsWith(ext) && f !== 'QQ人.exp3.json' && f !== '水印.exp3.json')
          .sort();
        if (files.length > 0) {
          json.FileReferences.Expressions = [];
          for (const f of files) {
            // 用文件名（去掉扩展名）作为 Name，文件名本身作为 File
            const name = path.basename(f, ext);
            json.FileReferences.Expressions.push({ Name: name, File: f });
          }
          patched = true;
          console.log('[ModelManager] 已补全 Expressions:', json.FileReferences.Expressions.map(e => e.Name));
        }
      } catch (e) {}
    }

    // --- 补 Motions（Cubism4: .motion3.json / .can3；Cubism2: .motion.json）---
    // pixi-live2d-display 要求 Motions 是【对象】：{ 组名: [ {File, FadeInTime, FadeOutTime} ] }，
    // 每个组的值必须是【数组】（库按 motions[group][i].File 遍历）。这里每个动作文件单独成组。
    // 注意淡入淡出字段名是 FadeInTime/FadeOutTime（秒），不是 FadeIn/FadeOut。
    if (!json.FileReferences.Motions || (typeof json.FileReferences.Motions === 'object' && !Array.isArray(json.FileReferences.Motions) && Object.keys(json.FileReferences.Motions).length === 0)) {
      try {
        const motionExts = isCubism4 ? ['.motion3.json', '.can3'] : ['.motion.json'];
        const files = fs.readdirSync(destDir)
          .filter(f => motionExts.some(ext => f.toLowerCase().endsWith(ext)))
          .sort();
        if (files.length > 0) {
          json.FileReferences.Motions = {};
          for (const f of files) {
            // 正确剥离扩展名：.motion3.json（两级）与 .can3（一级）都要处理
            const name = f.toLowerCase().endsWith('.motion3.json')
              ? path.basename(f, '.motion3.json')
              : path.basename(f, path.extname(f));
            json.FileReferences.Motions[name] = [{ File: f, FadeInTime: 0.5, FadeOutTime: 0.3 }];
          }
          patched = true;
          console.log('[ModelManager] 已补全 Motions:', Object.keys(json.FileReferences.Motions));
        }
      } catch (e) {}
    }

    if (patched) {
      fs.writeFileSync(fullPath, JSON.stringify(json, null, 2), 'utf-8');
    }
  } catch (e) {
    console.warn('[ModelManager] patchLive2DModelJson 失败:', e.message);
  }
}

// 运行时扫描已导入模型的目录，返回发现的 motions/expressions 文件列表
// （供渲染端 IPC 调用，对"导入时未补全"的旧模型做兜底）
function scanLive2DDir(dirPath) {
  const result = { motions: [], expressions: [] };
  try {
    if (!fs.existsSync(dirPath)) return result;

    // ★ 关键修复：先定位 model3.json/model.json 所在的实际目录。
    // 很多模型（如初音未来 runtime/ 导出结构）把 model3.json、moc3、motion/ 放在子目录，
    // 而 installPath 是模型根目录。直接扫描根目录会找不到任何 motion/expression，
    // 导致 discoverMotionsFallback 静默失败，模型"有文件但播不了动作"。
    function findModelDir(startDir, depth) {
      if (depth > 3) return startDir;
      let entries = [];
      try { entries = fs.readdirSync(startDir); } catch (e) { return startDir; }
      const hasModel = entries.some(f => /\.model3\.json$/i.test(f) || /^model\.json$/i.test(f) || /\.moc3$/i.test(f) || /\.moc$/i.test(f));
      if (hasModel) return startDir;
      // 递归查找子目录（优先 runtime、模型名等常见子目录）
      const subDirs = entries.filter(f => {
        try { return fs.statSync(path.join(startDir, f)).isDirectory(); } catch (e) { return false; }
      }).sort((a, b) => {
        // 优先 runtime、model、models 目录
        const aw = /^(runtime|model|models|src)$/i.test(a) ? 0 : 1;
        const bw = /^(runtime|model|models|src)$/i.test(b) ? 0 : 1;
        return aw - bw;
      });
      for (const sd of subDirs) {
        const found = findModelDir(path.join(startDir, sd), depth + 1);
        if (found !== path.join(startDir, sd) || fs.readdirSync(found).some(f => /\.model3\.json$/i.test(f) || /^model\.json$/i.test(f))) {
          return found;
        }
      }
      return startDir;
    }

    const modelDir = findModelDir(dirPath, 0);
    const entries = fs.readdirSync(modelDir);
    const isCubism4 = entries.some(f => /\.model3\.json$/i.test(f)) || entries.some(f => /\.moc3$/i.test(f));

    // ★ 递归扫描 motion/expression 文件（包括 motion/、expressions/ 等子目录），
    // 返回相对于 modelDir 的路径，这样 pixi-live2d-display 的 settings.resolveURL 能正确解析。
    function collectFiles(baseDir, currentDir, relPath, depth) {
      if (depth > 3) return;
      let files = [];
      try { files = fs.readdirSync(currentDir); } catch (e) { return; }
      for (const f of files) {
        const full = path.join(currentDir, f);
        const rel = relPath ? (relPath + '/' + f) : f;
        let isDir = false;
        try { isDir = fs.statSync(full).isDirectory(); } catch (e) {}
        if (isDir) {
          collectFiles(baseDir, full, rel, depth + 1);
          continue;
        }
        const fl = f.toLowerCase();
        if (isCubism4) {
          if (fl.endsWith('.exp3.json')) result.expressions.push({ name: path.basename(f, '.exp3.json'), file: rel.replace(/\\/g, '/') });
          if (fl.endsWith('.motion3.json')) result.motions.push({ name: path.basename(f, '.motion3.json'), file: rel.replace(/\\/g, '/') });
          else if (fl.endsWith('.can3')) result.motions.push({ name: path.basename(f, '.can3'), file: rel.replace(/\\/g, '/') });
        } else {
          if (fl.endsWith('.exp.json')) result.expressions.push({ name: path.basename(f, '.exp.json'), file: rel.replace(/\\/g, '/') });
          if (fl.endsWith('.motion.json')) result.motions.push({ name: path.basename(f, '.motion.json'), file: rel.replace(/\\/g, '/') });
          // ★ Cubism2 最常见的动作扩展名是 .mtn（如 tororo），之前漏扫导致动作兜底为空。
          // 注意顺序放在 .motion.json 之后：.motion.json 不以 .mtn 结尾，互不冲突。
          else if (fl.endsWith('.mtn')) result.motions.push({ name: path.basename(f, '.mtn'), file: rel.replace(/\\/g, '/') });
        }
      }
    }
    collectFiles(modelDir, modelDir, '', 0);
  } catch (e) {
    console.warn('[ModelManager] scanLive2DDir 失败:', e.message);
  }
  return result;
}

// 加载期自愈：在渲染端真正加载模型之前，确保 model3.json 拥有正确形状的
// FileReferences.Expressions / Motions，否则 pixi-live2d-display 不会创建
// expressionManager / motionManager.definitions，导致 currentModel.expression()/
// motion() 静默 no-op（面板有列表但点了没反应）。modelPath 为 .model3.json/model.json 文件本身。
function healLive2DModelJson(modelPath) {
  try {
    if (!modelPath) return { ok: false, reason: 'no path' };
    const isJson = path.extname(String(modelPath)).toLowerCase() === '.json';
    let modelJsonFile = isJson ? modelPath : null;
    let dir = isJson ? path.dirname(modelPath) : modelPath;
    if (!modelJsonFile || !fs.existsSync(modelJsonFile)) {
      let entries = [];
      try { entries = fs.readdirSync(dir); } catch (e) { return { ok: false, reason: 'no dir' }; }
      const found = entries.find(f => /\.model3\.json$/i.test(f)) || entries.find(f => /^model\.json$/i.test(f));
      if (!found) return { ok: false, reason: 'no model json' };
      modelJsonFile = path.join(dir, found);
    }
    const raw = fs.readFileSync(modelJsonFile, 'utf-8');
    const json = JSON.parse(raw);
    const isCubism4 = /\.model3\.json$/i.test(modelJsonFile) || !!(json.FileReferences && json.FileReferences.Moc3);
    // ★ FileReferences 是 Cubism4 专属结构，Cubism2 的 model.json 不需要，别注入脏键。
    if (isCubism4 && !json.FileReferences) json.FileReferences = {};
    const dir2 = path.dirname(modelJsonFile);

    // ★ 递归扫描子目录中的 motion/expression 文件（包括 motion/、expressions/ 等子目录）。
    // 之前只 readdirSync(dir2) 扫描当前目录，初音未来等模型的 motion 文件在 motion/ 子目录中，
    // 导致扫描不到 → Motions 为空 → 模型能显示但播不了动作。
    function collectFilesRecursive(baseDir, currentDir, relPath, depth, results) {
      if (depth > 4) return;
      let files = [];
      try { files = fs.readdirSync(currentDir); } catch (e) { return; }
      for (const f of files) {
        const full = path.join(currentDir, f);
        const rel = relPath ? (relPath + '/' + f) : f;
        let isDir = false;
        try { isDir = fs.statSync(full).isDirectory(); } catch (e) {}
        if (isDir) {
          // 跳过常见的非资源目录
          if (/^(node_modules|\.git|\.svn|__MACOSX)$/i.test(f)) continue;
          collectFilesRecursive(baseDir, full, rel, depth + 1, results);
          continue;
        }
        results.push({ name: f, rel: rel.replace(/\\/g, '/') });
      }
    }
    const allFiles = [];
    collectFilesRecursive(dir2, dir2, '', 0, allFiles);

    // ★★★ Cubism2（model.json）分支：必须用小写键 motions/expressions、file/name/fade_in/fade_out ★★★
    // pixi-live2d-display 的 Cubism2 运行时读 settings.motions[group][i].file（getMotionFile）
    // 与 settings.expressions[i].name（ExpressionManager），大写键对它完全无效；
    // 且 Cubism2 动作最常见扩展名是 .mtn，之前只扫 .motion.json 会漏掉。
    if (!isCubism4) {
      let changed2 = false;
      // 动作：.motion.json 与 .mtn 都算。已有的组保持不变（如 tororo 的 idle/""），
      // 只把未被任何组引用的动作文件补进以其文件名命名的新组。
      const motFiles2 = allFiles.filter(x => {
        const n = x.name.toLowerCase();
        return n.endsWith('.motion.json') || n.endsWith('.mtn');
      }).sort((a, b) => a.rel.localeCompare(b.rel));
      if (!json.motions || typeof json.motions !== 'object' || Array.isArray(json.motions)) json.motions = {};
      const referenced = new Set();
      for (const g of Object.keys(json.motions)) {
        const arr = json.motions[g];
        if (!Array.isArray(arr)) continue;
        for (const d of arr) { if (d && typeof d.file === 'string') referenced.add(d.file.replace(/\\/g, '/')); }
      }
      for (const x of motFiles2) {
        if (referenced.has(x.rel)) continue;
        const groupName = x.name.toLowerCase().endsWith('.motion.json')
          ? path.basename(x.name, '.motion.json')
          : path.basename(x.name, '.mtn');
        const target = groupName || 'motion';
        if (!Array.isArray(json.motions[target])) json.motions[target] = [];
        json.motions[target].push({ file: x.rel, fade_in: 0.5, fade_out: 0.3 });
        changed2 = true;
      }
      // 表情：.exp.json → [{name, file}]（小写键）
      const expFiles2 = allFiles.filter(x => x.name.toLowerCase().endsWith('.exp.json'))
        .sort((a, b) => a.rel.localeCompare(b.rel));
      if (expFiles2.length > 0) {
        if (!Array.isArray(json.expressions)) json.expressions = [];
        const haveExp = new Set(json.expressions.filter(d => d && typeof d.file === 'string').map(d => d.file.replace(/\\/g, '/')));
        for (const x of expFiles2) {
          if (haveExp.has(x.rel)) continue;
          json.expressions.push({ name: path.basename(x.name, '.exp.json'), file: x.rel });
          changed2 = true;
        }
      }
      if (changed2) {
        fs.writeFileSync(modelJsonFile, JSON.stringify(json, null, 2), 'utf-8');
        console.log('[ModelManager] healLive2DModelJson(Cubism2) 已修正:', modelJsonFile);
      }
      return { ok: true, changed: changed2, expressions: (json.expressions || []).length, motions: Object.keys(json.motions || {}).length };
    }

    // ===== Cubism4：Expressions → 数组 [{Name, File}]（排除 QQ人/水印 两张占位图）=====
    const expExt = isCubism4 ? '.exp3.json' : '.exp.json';
    const expFiles = allFiles
      .filter(x => x.name.toLowerCase().endsWith(expExt) && x.name !== 'QQ人.exp3.json' && x.name !== '水印.exp3.json')
      .sort((a, b) => a.rel.localeCompare(b.rel));
    const newExpressions = expFiles.map(x => ({ Name: path.basename(x.name, expExt), File: x.rel }));

    // Motions → { 组名: [ {File, FadeInTime, FadeOutTime} ] }
    // 注意：.can3 是 Cubism 动画文件，pixi-live2d-display 0.4.0 不支持，排除避免出死条目。
    const motExts = isCubism4 ? ['.motion3.json'] : ['.motion.json'];
    const motFiles = allFiles
      .filter(x => motExts.some(ext => x.name.toLowerCase().endsWith(ext)))
      .sort((a, b) => a.rel.localeCompare(b.rel));
    const newMotions = {};
    const oldMotions = json.FileReferences && json.FileReferences.Motions ? json.FileReferences.Motions : {};
    for (const x of motFiles) {
      const name = x.name.toLowerCase().endsWith('.motion3.json') ? path.basename(x.name, '.motion3.json') : path.basename(x.name, path.extname(x.name));
      const entry = { File: x.rel, FadeInTime: 0.5, FadeOutTime: 0.3 };
      // ★ 保留原有的 Sound / Text 字段（动作音效、台词），避免自愈时丢失
      if (oldMotions[name] && Array.isArray(oldMotions[name]) && oldMotions[name][0]) {
        const old = oldMotions[name][0];
        if (old.Sound) entry.Sound = old.Sound;
        if (old.Text) entry.Text = old.Text;
        if (old.Name) entry.Name = old.Name;
      }
      newMotions[name] = [entry];
    }

    let changed = false;
    if (expFiles.length > 0) {
      const cur = json.FileReferences.Expressions;
      const okArr = Array.isArray(cur) && cur.length === newExpressions.length &&
        cur.every((x, i) => x && x.Name === newExpressions[i].Name && x.File === newExpressions[i].File);
      if (!okArr) { json.FileReferences.Expressions = newExpressions; changed = true; }
    }
    if (motFiles.length > 0) {
      const cur = json.FileReferences.Motions;
      let okObj = false;
      if (cur && typeof cur === 'object' && !Array.isArray(cur) && Object.keys(cur).length === newMotions.length) {
        okObj = Object.keys(newMotions).every(k =>
          Array.isArray(cur[k]) && cur[k][0] && cur[k][0].File === newMotions[k][0].File && cur[k][0].FadeInTime === 0.5);
      }
      if (!okObj) { json.FileReferences.Motions = newMotions; changed = true; }
    }

    if (changed) {
      fs.writeFileSync(modelJsonFile, JSON.stringify(json, null, 2), 'utf-8');
      console.log('[ModelManager] healLive2DModelJson 已修正:', modelJsonFile);
    }
    return { ok: true, changed, expressions: newExpressions.length, motions: Object.keys(newMotions).length };
  } catch (e) {
    console.warn('[ModelManager] healLive2DModelJson 失败:', e.message);
    return { ok: false, reason: e.message };
  }
}

module.exports = { init, getModelList, importModel, validateModel, validateAllModels, deleteModel, renameModel, updateModel, rescanThumbnail, getActions, saveActions, validateRegistry, getFirstValidModel, patchLive2DModelJson, scanLive2DDir, healLive2DModelJson };