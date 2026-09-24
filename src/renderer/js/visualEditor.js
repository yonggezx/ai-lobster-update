// visualEditor.js — 「宠物显示 / 代码 / AI 控制」面板
//
// 原需求：可视化编辑界面（自由拖动旋转模型、参数调节、代码操控、AI 助手）。
// 经确认：这些能力统一收进「模型 → 新增动作 / 修改动作」的动作编辑器窗口内，
// 不再作为主窗口的独立标签页。动作编辑器自带 3D 预览 / 拖拽旋转 / 关键帧编辑。
//
// 设计要点（与底部「AI 生成关键帧」融合后）：
//   - 本面板的「AI 助手」与「代码控制台」统一驱动两类能力：
//       ① 微调模型外观/动作（pet.*，实时作用于桌面龙虾）
//       ② 生成并“累加”编辑当前动作的关键帧（ae.*）
//   - ae API 直接操作当前 ae.def（动作定义的活对象），天然“在上一次基础上累加”，
//     并由 window.refreshActionEditor 统一重绘，避免整段覆盖/重置。
//   - 原来的底部独立「AI 生成关键帧」条已移除，AI 入口收敛到本面板的「AI 助手」一张卡片。
//
// 对外暴露：
//   window.buildVisualControlPanel(container, ae) —— 注入面板并接管当前动作编辑器状态 ae
//   window.visualEditorPet —— 便于调试的 pet API 对象
//
// 当前生效的 MMD 预览（动作编辑器里的 _actionPreview）通过 window.__aePreview 暴露，
// 这样 pet.rotate / pet.zoom / pet.reset 既能驱动动作编辑器里的 3D 预览，也不会在缺失时报错。
(function () {
  'use strict';

  const ACTIONS = [
    'sleep', 'dance', 'wave', 'happy', 'think', 'idle', 'confuse', 'shy', 'angry', 'lazy',
    'turn', 'turn_away', 'nod', 'shake', 'bow', 'jump', 'squat', 'sit', 'stand', 'stretch',
    'clap', 'point', 'yawn', 'cross', 'reset'
  ];

  let initialized = false;
  let currentAeApi = null; // 当前动作编辑器的关键帧 API（由 buildVisualControlPanel 注入），供代码控制台 / AI 助手使用

  // ---- 动作关键帧 API 构造（操作当前动作定义，天然“在上一次基础上累加”）----
  // 补充别名：覆盖 AI 常见的 MMD 英文骨名 / 部位词（app.js 的 BONE_ALIAS / BODY_PART_TO_BONE
  // 已覆盖中文别名，这里补英文/MMD 侧，运行时合并）。目的：AI 用 hip/pelvis/knee/leftArm 等
  // 非标准 key 时能归一到 ACTION_BONES 的标准 key，避免 renderKeyframeBody 显示全 0。
  const BONE_ALIAS_EXTRA = {
    head: 'head', headbone: 'head', skull: 'head',
    neck: 'neck', cervical: 'neck',
    upperBody: 'upperBody', upperbody: 'upperBody', upperchest: 'upperBody', spine: 'upperBody', chest: 'upperBody2', torso: 'upperBody', upperback: 'upperBody',
    upperBody2: 'upperBody2', upperbody2: 'upperBody2', chestupper: 'upperBody2',
    lowerBody: 'lowerBody', lowerbody: 'lowerBody', hip: 'lowerBody', hips: 'lowerBody', pelvis: 'lowerBody', waist: 'lowerBody', lowerback: 'lowerBody', lowerspine: 'lowerBody', root: 'lowerBody',
    lShoulder: 'lShoulder', lshoulder: 'lShoulder', leftshoulder: 'lShoulder', lclavicle: 'lShoulder', leftclavicle: 'lShoulder', l_clavicle: 'lShoulder',
    rShoulder: 'rShoulder', rshoulder: 'rShoulder', rightshoulder: 'rShoulder', rclavicle: 'rShoulder', rightclavicle: 'rShoulder', r_clavicle: 'rShoulder',
    lArm: 'lArm', larm: 'lArm', leftarm: 'lArm', lupperarm: 'lArm', leftupperarm: 'lArm', l_upperarm: 'lArm',
    rArm: 'rArm', rarm: 'rArm', rightarm: 'rArm', rupperarm: 'rArm', rightupperarm: 'rArm', r_upperarm: 'rArm',
    lElbow: 'lElbow', lelbow: 'lElbow', leftelbow: 'lElbow', lforearm: 'lElbow', leftforearm: 'lElbow', l_forearm: 'lElbow',
    rElbow: 'rElbow', relbow: 'rElbow', rightelbow: 'rElbow', rforearm: 'rElbow', rightforearm: 'rElbow', r_forearm: 'rElbow',
    lWrist: 'lWrist', lwrist: 'lWrist', leftwrist: 'lWrist', lhand: 'lWrist', lefthand: 'lWrist', l_hand: 'lWrist',
    rWrist: 'rWrist', rwrist: 'rWrist', rightwrist: 'rWrist', rhand: 'rWrist', righthand: 'rWrist', r_hand: 'rWrist',
    lLeg: 'lLeg', lleg: 'lLeg', leftleg: 'lLeg', lthigh: 'lLeg', leftthigh: 'lLeg', l_thigh: 'lLeg',
    rLeg: 'rLeg', rleg: 'rLeg', rightleg: 'rLeg', rthigh: 'rLeg', rightthigh: 'rLeg', r_thigh: 'rLeg',
    lKnee: 'lKnee', lknee: 'lKnee', leftknee: 'lKnee', lcalf: 'lKnee', leftcalf: 'lKnee', lshin: 'lKnee', leftshin: 'lKnee', l_calf: 'lKnee', l_shin: 'lKnee',
    rKnee: 'rKnee', rknee: 'rKnee', rightknee: 'rKnee', rcalf: 'rKnee', rightcalf: 'rKnee', rshin: 'rKnee', rightshin: 'rKnee', r_calf: 'rKnee', r_shin: 'rKnee',
    lAnkle: 'lAnkle', lankle: 'lAnkle', leftankle: 'lAnkle', lfoot: 'lAnkle', leftfoot: 'lAnkle', l_foot: 'lAnkle',
    rAnkle: 'rAnkle', rankle: 'rAnkle', rightankle: 'rAnkle', rfoot: 'rAnkle', rightfoot: 'rAnkle', r_foot: 'rAnkle'
  };
  // 表情补充别名（app.js 的 MORPH_ALIAS 已覆盖中文，这里补英文容错）
  const MORPH_ALIAS_EXTRA = {
    happy: 'happy', smile: 'happy', laugh: 'happy',
    sad: 'sad', cry: 'sad',
    angry: 'angry', mad: 'angry',
    surprise: 'surprise', surprised: 'surprise', shock: 'surprise',
    shy: 'shy', blush: 'shy',
    think: 'think', thinking: 'think',
    confuse: 'confuse', confused: 'confuse',
    greet: 'greet', wave: 'greet',
    love: 'love', heart: 'love',
    sleepy: 'sleepy', sleep: 'sleepy', yawn: 'sleepy'
  };
  // 取标准 key 集合（来自 app.js 的 ACTION_BONES / ACTION_MORPHS，若未加载则空）
  function stdBoneKeys() { return (typeof ACTION_BONES !== 'undefined' && ACTION_BONES) ? ACTION_BONES.map(b => b[0]) : []; }
  function stdMorphKeys() { return (typeof ACTION_MORPHS !== 'undefined' && ACTION_MORPHS) ? ACTION_MORPHS.map(m => m[0]) : []; }
  // 合并所有别名来源：app.js BONE_ALIAS + BODY_PART_TO_BONE + 本文件 BONE_ALIAS_EXTRA
  function allBoneAliases() {
    const m = Object.assign({}, BONE_ALIAS_EXTRA);
    if (typeof BONE_ALIAS !== 'undefined' && BONE_ALIAS) Object.assign(m, BONE_ALIAS);
    if (typeof BODY_PART_TO_BONE !== 'undefined' && BODY_PART_TO_BONE) Object.assign(m, BODY_PART_TO_BONE);
    return m;
  }
  function allMorphAliases() {
    const m = Object.assign({}, MORPH_ALIAS_EXTRA);
    if (typeof MORPH_ALIAS !== 'undefined' && MORPH_ALIAS) Object.assign(m, MORPH_ALIAS);
    return m;
  }
  // 规范化 key 字符串：去空格、统一小写、去下划线/连字符，用于模糊匹配
  function normKeyStr(k) { return String(k == null ? '' : k).trim().toLowerCase().replace(/[-_\s]+/g, ''); }
  // 将任意 bone key 归一到标准 key（命中返回标准 key，未命中返回 null）
  let __boneAliasCache = null, __stdBoneSet = null;
  function resolveBoneKey(key) {
    if (!__boneAliasCache) { __boneAliasCache = allBoneAliases(); __stdBoneSet = new Set(stdBoneKeys()); }
    const k = String(key == null ? '' : key).trim();
    if (!k) return null;
    if (__stdBoneSet.has(k)) return k;            // 精确命中标准 key（区分大小写，如 lArm）
    const aliases = __boneAliasCache;
    if (aliases[k]) return aliases[k];            // 别名精确命中
    const kk = normKeyStr(k);
    if (__stdBoneSet.has(kk)) return kk;          // 小写后命中标准
    if (aliases[kk]) return aliases[kk];         // 小写后命中别名
    return null;
  }
  let __morphAliasCache = null, __stdMorphSet = null;
  function resolveMorphKey(key) {
    if (!__morphAliasCache) { __morphAliasCache = allMorphAliases(); __stdMorphSet = new Set(stdMorphKeys()); }
    const k = String(key == null ? '' : key).trim();
    if (!k) return null;
    if (__stdMorphSet.has(k)) return k;
    const aliases = __morphAliasCache;
    if (aliases[k]) return aliases[k];
    const kk = normKeyStr(k);
    if (__stdMorphSet.has(kk)) return kk;
    if (aliases[kk]) return aliases[kk];
    return null;
  }
  // 归一化单个 bone 的值：数字 n → {x:0,y:0,z:n}；对象 → 补缺轴为 0
  function normBoneVal(v) {
    if (typeof v === 'number') return { x: 0, y: 0, z: v };
    if (v && typeof v === 'object') {
      return {
        x: (typeof v.x === 'number' && isFinite(v.x)) ? v.x : 0,
        y: (typeof v.y === 'number' && isFinite(v.y)) ? v.y : 0,
        z: (typeof v.z === 'number' && isFinite(v.z)) ? v.z : 0
      };
    }
    return { x: 0, y: 0, z: 0 };
  }
  // 归一化整个 bones 对象：key→标准 key，值→{x,y,z}；丢弃无法识别的 key（console.warn 便于诊断）
  function normalizeBones(bones) {
    if (!bones || typeof bones !== 'object') return {};
    const out = {};
    let dropped = [];
    for (const k in bones) {
      if (!Object.prototype.hasOwnProperty.call(bones, k)) continue;
      const std = resolveBoneKey(k);
      if (std) {
        // 同一标准 key 被多次命中时后者覆盖前者（AI 极少同帧同骨重复，覆盖比丢更安全）
        out[std] = normBoneVal(bones[k]);
      } else {
        dropped.push(k + '=' + safeStringify(bones[k]));
      }
    }
    if (dropped.length) console.warn('[ae.normKf] 无法识别的骨骼键已丢弃（不在 ACTION_BONES 且无别名映射）：', dropped.join(', '));
    return out;
  }
  function normalizeMorphs(morphs) {
    if (!morphs || typeof morphs !== 'object') return {};
    const out = {};
    let dropped = [];
    for (const k in morphs) {
      if (!Object.prototype.hasOwnProperty.call(morphs, k)) continue;
      const std = resolveMorphKey(k);
      if (std) {
        let w = Number(morphs[k]);
        if (!isFinite(w)) w = 0;
        out[std] = Math.max(0, Math.min(1, w));
      } else {
        dropped.push(k + '=' + morphs[k]);
      }
    }
    if (dropped.length) console.warn('[ae.normKf] 无法识别的表情键已丢弃：', dropped.join(', '));
    return out;
  }
  function normRoot(root) {
    if (!root || typeof root !== 'object') return {};
    const num = (v) => (typeof v === 'number' && isFinite(v)) ? v : 0;
    // 结构与 app.js normalizeKeyframe 一致：{ y, rotX, rotY, rotZ }
    // 兼容 AI 用 x/z 表示旋转的写法（y 是垂直位移，不参与旋转）
    const y = Math.max(-0.6, Math.min(0.6, num(root.y)));
    const rotX = num(root.rotX != null ? root.rotX : root.x);
    const rotY = num(root.rotY);
    const rotZ = num(root.rotZ != null ? root.rotZ : root.z);
    return { y, rotX, rotY, rotZ };
  }
  function normKf(kf) {
    kf = kf || {};
    return {
      t: (typeof kf.t === 'number' && isFinite(kf.t)) ? Math.max(0, Math.min(1, kf.t)) : 0,
      bones: normalizeBones(kf.bones),
      root: normRoot(kf.root),
      morphs: normalizeMorphs(kf.morphs)
    };
  }
  function deepMergeKf(target, patch) {
    if (patch && patch.bones) {
      // patch.bones 先归一化，再与 target.bones 浅合并（patch 覆盖同 key）
      const nb = normalizeBones(patch.bones);
      target.bones = Object.assign({}, target.bones, nb);
    }
    if (patch && patch.root) {
      const nr = normRoot(patch.root);
      target.root = Object.assign({}, target.root, nr);
    }
    if (patch && patch.morphs) {
      const nm = normalizeMorphs(patch.morphs);
      target.morphs = Object.assign({}, target.morphs, nm);
    }
    if (patch && typeof patch.t === 'number') target.t = Math.max(0, Math.min(1, patch.t));
    return target;
  }
  function refreshAe(ae) { if (typeof window.refreshActionEditor === 'function') window.refreshActionEditor(ae); }
  // 内置动作只读：任何修改关键帧的调用都抛出清晰中文错误，引导用户先「复制为可编辑动作」
  const BUILTIN_READONLY_MSG = '当前是内置动作，关键帧为只读，无法直接编辑/优化。请先点击「复制为可编辑动作」生成可编辑副本后再运行。';
  function ensureEditable(ae) {
    if (ae.isBuiltin) throw new Error(BUILTIN_READONLY_MSG);
    return true;
  }
  // 取当前动作定义的安全快照：内置动作 keyframes 为 null，必须规整为 []，否则脚本 d.keyframes.forEach 会崩溃
  function snapshotDef(ae) {
    const clone = JSON.parse(JSON.stringify(ae.def || { keyframes: [] }));
    if (!Array.isArray(clone.keyframes)) clone.keyframes = [];
    if (!clone.morphs || typeof clone.morphs !== 'object') clone.morphs = {};
    if (!clone.root || typeof clone.root !== 'object') clone.root = {};
    return clone;
  }
  function buildAeApi(ae) {
    return {
      isBuiltin: !!ae.isBuiltin,
      getDef: () => snapshotDef(ae),
      setMeta: (patch) => { ensureEditable(ae); Object.assign(ae.def, patch || {}); refreshAe(ae); return true; },
      addKeyframe: (kf) => {
        ensureEditable(ae);
        ae.def.keyframes = ae.def.keyframes || [];
        ae.def.keyframes.push(normKf(kf));
        ae.def.keyframes.sort((a, b) => a.t - b.t);
        ae.kfIndex = ae.def.keyframes.length - 1;
        refreshAe(ae);
        return ae.def.keyframes.length;
      },
      updateKeyframe: (i, patch) => {
        ensureEditable(ae);
        // 兼容 AI 误把时间 t 当下标传入：非整数时自动按时间找最近帧
        let idx = i;
        if (typeof idx !== 'number' || !Number.isInteger(idx)) {
          const kfs = ae.def.keyframes || [];
          if (!kfs.length) return false;
          let best = 0, bestDist = Math.abs(kfs[0].t - Number(idx));
          for (let j = 1; j < kfs.length; j++) {
            const d = Math.abs(kfs[j].t - Number(idx));
            if (d < bestDist) { bestDist = d; best = j; }
          }
          idx = best;
        }
        const kf = ae.def.keyframes && ae.def.keyframes[idx];
        if (!kf) return false;
        deepMergeKf(kf, patch);
        refreshAe(ae);
        return true;
      },
      removeKeyframe: (i) => {
        ensureEditable(ae);
        if (!ae.def.keyframes) return false;
        // 兼容非整数索引：按时间找最近帧删除
        let idx = i;
        if (typeof idx !== 'number' || !Number.isInteger(idx)) {
          const kfs = ae.def.keyframes;
          if (!kfs.length) return false;
          let best = 0, bestDist = Math.abs(kfs[0].t - Number(idx));
          for (let j = 1; j < kfs.length; j++) {
            const d = Math.abs(kfs[j].t - Number(idx));
            if (d < bestDist) { bestDist = d; best = j; }
          }
          idx = best;
        }
        if (idx < 0 || idx >= ae.def.keyframes.length) return false;
        ae.def.keyframes.splice(idx, 1);
        if (ae.kfIndex >= ae.def.keyframes.length) ae.kfIndex = Math.max(0, ae.def.keyframes.length - 1);
        refreshAe(ae);
        return true;
      },
      boneKeys: () => (typeof ACTION_BONES !== 'undefined' ? ACTION_BONES.map(b => b[0]) : []),
      morphKeys: () => (typeof ACTION_MORPHS !== 'undefined' ? ACTION_MORPHS.map(m => m[0]) : []),
      // 按时间 t 查找最接近的关键帧索引（AI 更习惯用时间定位，而非数组下标）
      findKeyframeIndex: (t) => {
        const kfs = ae.def.keyframes || [];
        if (!kfs.length) return -1;
        let best = 0, bestDist = Math.abs(kfs[0].t - t);
        for (let i = 1; i < kfs.length; i++) {
          const d = Math.abs(kfs[i].t - t);
          if (d < bestDist) { bestDist = d; best = i; }
        }
        return best;
      },
      // 按时间 t 更新关键帧（内部找到最接近的帧再 updateKeyframe），返回是否成功
      updateKeyframeAt: (t, patch) => {
        const i = (currentAeApi && currentAeApi.findKeyframeIndex) ? currentAeApi.findKeyframeIndex(t) : -1;
        if (i < 0) return false;
        return currentAeApi.updateKeyframe(i, patch);
      },
      render: () => refreshAe(ae),
      previewInPet: () => { if (window.api && window.api.previewActionInPet) window.api.previewActionInPet(JSON.parse(JSON.stringify(ae.def))).catch(() => {}); }
    };
  }

  // ---- 工具 ----
  function clamp(v, lo, hi) { v = Number(v); if (!isFinite(v)) v = lo; return Math.max(lo, Math.min(hi, v)); }
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $all(sel, root) { return Array.from((root || document).querySelectorAll(sel)); }
  function el(id) { return document.getElementById(id); }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function safeStringify(v) {
    try {
      if (typeof v === 'string') return v;
      return JSON.stringify(v, null, 2);
    } catch (e) { return String(v); }
  }
  function activePreview() { return (typeof window !== 'undefined' && window.__aePreview) ? window.__aePreview : null; }

  // ---- 宠物配置读写（实时作用于桌面龙虾，并持久化）----
  async function applyPet(patch) {
    const cfg = await window.api.getConfig();
    cfg.pet = Object.assign({}, cfg.pet || {}, patch);
    await window.api.setConfig(cfg);
    await window.api.applyPetSettings(patch);
    return true;
  }
  async function nudgePet(dx, dy) {
    const pos = await window.api.getPetPosition();
    if (!pos) return false;
    await window.api.petDrag(pos.x + dx, pos.y + dy);
    return true;
  }

  // ---- pet API（代码控制台 / AI 助手 共用）----
  const pet = {
    size: (v) => applyPet({ size: clamp(v, 0.2, 4) }),
    opacity: (v) => applyPet({ opacity: clamp(v, 0, 1) }),        // 透明度：0=清晰 1=全透明
    move: (dx, dy) => nudgePet(Number(dx) || 0, Number(dy) || 0),  // 相对移动（像素）
    rotate: (a) => { const p = activePreview(); if (!p) return null; const v = p.getView(); p.setView({ yaw: (a && a.yaw != null ? a.yaw : v.yaw), pitch: (a && a.pitch != null ? a.pitch : v.pitch) }); return p.getView(); },
    zoom: (z) => { const p = activePreview(); if (!p) return null; p.setView({ zoom: clamp(z, 0.3, 3) }); return p.getView(); },
    reset: () => { const p = activePreview(); if (!p) return true; p.setView({ yaw: 0, pitch: 0, zoom: 1 }); return true; },
    action: (name) => window.api.petDoAction(name),
    listActions: () => ACTIONS.slice(),
    info: async () => {
      const cfg = await window.api.getConfig();
      return { pet: cfg.pet || {}, currentModel: (await window.api.listModels()).find(m => m.id === (cfg.currentModel)) || null };
    }
  };
  window.visualEditorPet = pet; // 便于调试

  // ---- 代码控制台执行 ----
  // 安全创建可执行函数：把 SyntaxError 的行号/位置提取出来，避免只显示 "Unexpected token ')'"
  function safeCreateFn(code) {
    try {
      return new Function('pet', 'api', 'ACTIONS', 'ae',
        'return (async () => {\n' + code + '\n})();');
    } catch (err) {
      // SyntaxError: 尝试从 message 中提取位置，并附上代码片段定位
      const msg = err && err.message ? err.message : String(err);
      const lines = String(code).split('\n');
      let hint = '';
      const m = msg.match(/line (\d+)/i);
      if (m) {
        const ln = parseInt(m[1], 10) - 1; // Function 包装体第一行是我们注入的空行，所以减1
        if (lines[ln]) hint = '\n第' + (ln + 1) + '行: ' + lines[ln].trim().slice(0, 80);
      } else if (lines.length <= 20) {
        hint = '\n--- 代码 ---\n' + lines.map((l, i) => (i + 1) + ': ' + l).join('\n');
      }
      throw new Error('代码语法错误: ' + msg + hint);
    }
  }

  async function runCode(code) {
    const out = el('ve-console-output');
    if (!out) return;
    const log = (msg, cls) => {
      const div = document.createElement('div');
      div.className = 've-console-line' + (cls ? ' ' + cls : '');
      div.textContent = msg;
      out.appendChild(div);
      out.scrollTop = out.scrollHeight;
    };
    log('> ' + code, 'cmd');
    try {
      const fn = safeCreateFn(code);
      const result = await fn(pet, window.api, ACTIONS, currentAeApi);
      if (result !== undefined) log('← ' + safeStringify(result), 'ok');
      log('执行完成', 'ok');
    } catch (err) {
      log('✗ ' + (err && err.message ? err.message : String(err)), 'err');
    }
  }

  // ---- AI 助手（询问 → 执行，独立会话，不污染主窗口「AI 对话」）----
  // 既能微调模型外观/动作（pet.*），也能编辑当前动作的关键帧（ae.*）；关键帧编辑必须“在上一次基础上累加”。
  // 调用 window.api.chat 时传 silent:true：结果只通过 IPC 返回值回传本面板，不会广播到主窗口聊天记录（避免“对话串台”）。

  // ---- AI 助手专用工具定义（让AI能够调用工具进行思考和完善）----
  const VE_TOOLS = [
    {
      type: 'function',
      function: {
        name: 'get_model_bones',
        description: '获取当前3D模型的可用骨骼列表，返回所有可操作的骨骼键名和中文说明。在生成动作关键帧前必须先调用此工具，确认哪些骨骼可用。',
        parameters: { type: 'object', properties: {}, required: [] }
      }
    },
    {
      type: 'function',
      function: {
        name: 'get_morph_list',
        description: '获取当前3D模型的可用表情（morph）列表，返回所有可触发的表情键名和中文说明。',
        parameters: { type: 'object', properties: {}, required: [] }
      }
    },
    {
      type: 'function',
      function: {
        name: 'get_current_action',
        description: '获取当前正在编辑的动作定义，包括总时长、是否循环、所有关键帧的骨骼旋转和表情权重。在修改已有动作前必须先调用此工具，了解当前状态。',
        parameters: { type: 'object', properties: {}, required: [] }
      }
    },
    {
      type: 'function',
      function: {
        name: 'execute_code',
        description: '执行JavaScript代码来操作模型和动作关键帧。可用对象：pet（控制模型外观/视角）、ae（编辑当前动作关键帧）。代码执行后会返回执行结果。',
        parameters: {
          type: 'object',
          properties: {
            code: { type: 'string', description: '要执行的JavaScript代码，如 ae.addKeyframe({t:0.5, bones:{rArm:{z:-1}}})' }
          },
          required: ['code']
        }
      }
    }
  ];

  // 工具执行函数
  async function executeVETool(name, args) {
    try {
      switch (name) {
        case 'get_model_bones': {
          const preview = window.__aePreview;
          let boneMap = {};
          if (preview && typeof preview.getBoneMap === 'function') {
            boneMap = preview.getBoneMap();
          }
          const boneLabels = {
            head: '头', neck: '颈', upperBody: '上半身', upperBody2: '上半身2/胸', lowerBody: '下半身/腰',
            lShoulder: '左肩', lArm: '左大臂', lElbow: '左肘', lWrist: '左手腕',
            rShoulder: '右肩', rArm: '右大臂', rElbow: '右肘', rWrist: '右手腕',
            lLeg: '左腿/大腿', lKnee: '左膝/小腿', lAnkle: '左脚踝',
            rLeg: '右腿/大腿', rKnee: '右膝/小腿', rAnkle: '右脚踝'
          };
          const result = [];
          for (const key in boneLabels) {
            const actualName = boneMap[key];
            result.push({
              key: key,
              label: boneLabels[key],
              available: actualName !== null && actualName !== undefined,
              actualBoneName: actualName || null
            });
          }
          return { success: true, bones: result, total: result.length, availableCount: result.filter(b => b.available).length };
        }
        case 'get_morph_list': {
          const morphLabels = {
            happy: '开心/笑', sad: '悲伤', angry: '生气', surprise: '惊讶',
            shy: '害羞/脸红', think: '思考', confuse: '困惑', greet: '问候/微笑',
            love: '喜爱/爱心', sleepy: '困倦/闭眼'
          };
          const result = Object.entries(morphLabels).map(([key, label]) => ({ key, label }));
          return { success: true, morphs: result, total: result.length };
        }
        case 'get_current_action': {
          if (!currentAeApi) {
            return { success: false, error: '当前没有正在编辑的动作' };
          }
          const def = currentAeApi.getDef();
          const simplifiedKeyframes = (def.keyframes || []).map((kf, i) => ({
            index: i,
            t: kf.t,
            bones: kf.bones || {},
            root: kf.root || {},
            morphs: kf.morphs || {}
          }));
          return {
            success: true,
            duration: def.duration,
            loop: def.loop,
            speed: def.speed,
            keyframeCount: simplifiedKeyframes.length,
            keyframes: simplifiedKeyframes
          };
        }
        case 'execute_code': {
          if (!args || !args.code) {
            return { success: false, error: '缺少 code 参数' };
          }
          try {
            const fn = safeCreateFn(args.code);
            const res = await fn(pet, window.api, ACTIONS, currentAeApi);
            return { success: true, result: res !== undefined ? safeStringify(res) : '执行成功（无返回值）' };
          } catch (err) {
            return { success: false, error: err && err.message ? err.message : String(err) };
          }
        }
        default:
          return { success: false, error: '未知工具: ' + name };
      }
    } catch (err) {
      return { success: false, error: '工具执行异常: ' + (err && err.message ? err.message : String(err)) };
    }
  }

  // 从AI回复中提取工具调用（兼容多种格式）
  function extractToolCalls(text) {
    if (!text) return [];
    const calls = [];
    const seen = new Set();
    
    function addCall(name, args) {
      if (!name) return;
      const key = name + JSON.stringify(args || {});
      if (seen.has(key)) return;
      seen.add(key);
      calls.push({ name, arguments: args || {} });
    }
    
    function parseJsonStr(jsonStr) {
      if (!jsonStr) return null;
      try {
        return JSON.parse(jsonStr.trim());
      } catch (e) {
        // 尝试修复常见的JSON格式问题
        try {
          const fixed = jsonStr.trim()
            .replace(/'/g, '"')
            .replace(/([{,]\s*)(\w+)\s*:/g, '$1"$2":');
          return JSON.parse(fixed);
        } catch (e2) {
          return null;
        }
      }
    }
    
    function processParsed(parsed) {
      if (!parsed) return;
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (item && item.name) {
            addCall(item.name, item.arguments || item.args || item.params || {});
          }
        }
      } else if (parsed.name) {
        addCall(parsed.name, parsed.arguments || parsed.args || parsed.params || {});
      } else if (parsed.tool_calls || parsed.toolCalls) {
        const tc = parsed.tool_calls || parsed.toolCalls;
        if (Array.isArray(tc)) {
          for (const item of tc) {
            const func = item.function || item.func || {};
            if (func.name || item.name) {
              addCall(func.name || item.name, func.arguments || item.arguments || {});
            }
          }
        }
      }
    }
    
    // 格式1: 标准JSON数组（纯文本）
    const parsed1 = parseJsonStr(text);
    if (parsed1) processParsed(parsed1);
    
    // 格式2: markdown代码块中的JSON（有结束反引号）
    const fencePattern = /```(?:json|javascript)?\s*([\s\S]*?)```/gi;
    let match;
    while ((match = fencePattern.exec(text)) !== null) {
      const parsed = parseJsonStr(match[1]);
      if (parsed) processParsed(parsed);
    }
    
    // 格式3: 没有结束反引号的代码块（AI可能只输出了开始标记）
    const openFencePattern = /```(?:json|javascript)?\s*([\s\S]*)$/i;
    const openMatch = text.match(openFencePattern);
    if (openMatch && openMatch[1]) {
      // 尝试提取JSON数组或对象
      const jsonPattern = /(\[[\s\S]*\]|\{[\s\S]*\})/;
      const jsonMatch = openMatch[1].match(jsonPattern);
      if (jsonMatch) {
        const parsed = parseJsonStr(jsonMatch[1]);
        if (parsed) processParsed(parsed);
      }
    }
    
    // 格式4: 行内JSON（没有代码块标记）
    const inlinePattern = /\[\s*\{[\s\S]*?\}\s*\]/g;
    while ((match = inlinePattern.exec(text)) !== null) {
      const parsed = parseJsonStr(match[0]);
      if (parsed) processParsed(parsed);
    }
    
    console.log('[VE-AI] extractToolCalls: 找到', calls.length, '个工具调用', calls.map(c => c.name));
    return calls;
  }

  // SVG图标工具函数（替换emoji颜表情）
  function veIcon(name, size = 16) {
    const icons = {
      // 机器人图标（AI思考中）
      robot: '<svg width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="8" width="18" height="12" rx="2"/><path d="M12 8V4"/><circle cx="12" cy="3" r="1"/><path d="M8 14h.01"/><path d="M16 14h.01"/><path d="M9 18h6"/></svg>',
      // 工具/扳手图标（调用工具）
      tool: '<svg width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>',
      // 成功/对勾图标
      success: '<svg width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>',
      // 失败/叉号图标
      error: '<svg width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>',
      // 警告图标
      warning: '<svg width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
      // 播放图标
      play: '<svg width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>',
      // 暂停图标
      pause: '<svg width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>',
      // 代码图标
      code: '<svg width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>',
      // 思考/大脑图标
      thinking: '<svg width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 1.98-3A2.5 2.5 0 0 1 9.5 2Z"/><path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-1.98-3A2.5 2.5 0 0 0 14.5 2Z"/></svg>'
    };
    return icons[name] || icons.robot;
  }

  // 工具名称中文映射
  const TOOL_NAMES_CN = {
    'get_model_bones': '获取骨骼列表',
    'get_morph_list': '获取表情列表',
    'get_current_action': '获取当前动作',
    'execute_code': '执行代码'
  };
  
  function getToolNameCN(name) {
    return TOOL_NAMES_CN[name] || name;
  }
  
  function formatToolArgs(args) {
    if (!args || Object.keys(args).length === 0) return '无参数';
    try {
      return JSON.stringify(args, null, 2);
    } catch (e) {
      return String(args);
    }
  }


  const AI_SYS_PROMPT = `你是一个"浮灵饰界"桌面宠物灵汐的动作/外观协同助手，具备工具调用能力，可以进行多轮思考和完善。

## 工作流程（重要）
1. **持续执行直到解决问题**：可以反复调用任何工具，直到用户的需求被完全满足。
2. **合理安排工具调用**：
   - 先调用工具获取必要信息（骨骼列表、表情列表、当前动作等）
   - 根据返回结果分析问题，决定下一步操作
   - 可以多次调用同一个工具（如多次调用execute_code逐步调整动作）
   - 可以调用不同工具组合使用
3. **每次工具调用后**：根据返回结果继续思考，判断是否还需要继续调用工具。
4. **任务完成的判断标准**：
   - 用户要求的动作/效果已经实现
   - 代码可以正确执行
   - 不需要再调用其他工具
5. **最终输出**：当任务完成时，给出完整的JavaScript代码和简要说明，代码必须放在 \`\`\`javascript 代码块中。
6. **禁止行为**：
   - 在问题还没解决时就停止
   - 无限循环调用相同工具（参数相同且结果相同）
   - 调用与任务无关的工具
   - 只在思考中描述工具调用而不实际输出工具调用JSON

## 可用工具
- **get_model_bones**: 获取当前3D模型的可用骨骼列表
- **get_morph_list**: 获取当前3D模型的可用表情列表
- **get_current_action**: 获取当前正在编辑的动作定义
- **execute_code**: 执行JavaScript代码来操作模型和动作关键帧

## 工具调用格式
当你需要调用工具时，输出以下JSON格式（不要任何多余文字）：
\`\`\`json
[{"name": "工具名", "arguments": {"参数名": "参数值"}}]
\`\`\`

## pet API（微调模型外观/视角）
- pet.size(v)            设置大小（v 范围 0.2~4，1 为原始大小）
- pet.opacity(v)         设置透明度（v 范围 0~1，1 清晰，0 全透明）
- pet.rotate({yaw,pitch}) 旋转当前3D预览模型（角度）
- pet.zoom(z)            缩放当前3D预览模型（z 范围 0.3~3）
- pet.reset()            重置预览视角
- pet.action(name)       让宠物做动作（name 可取自：${ACTIONS.join(', ')}）

## ae API（编辑当前动作的关键帧）
⚠️ **核心原则：每次编辑都必须"建立在上一次的基础上、累加进行"，绝不可用全新动作覆盖掉未涉及的已有帧。**
- ae.getDef()                         返回当前动作定义快照
- ae.setMeta({duration,loop,speed})   设置总时长(秒)/是否循环/速度倍率(默认1)
- ae.addKeyframe({t,bones,root,morphs})  在时刻t(0~1)新增一帧（按t自动排序）
- ae.updateKeyframe(i,{bones,root,morphs,t})  只修改第i帧指定的字段（浅合并，未提及的字段原样保留）
- ae.updateKeyframeAt(t,{bones,root,morphs})  按时间t找到最近的关键帧再修改（推荐）
- ae.removeKeyframe(i)                删除第i帧
- ae.boneKeys() / ae.morphKeys()      返回当前模型可用的骨骼名/表情名

## 骨骼旋转角度说明
- 骨骼值为 x/y/z 旋转弧度（0 表示不动）
- 轻微动作（单轴 0.1~0.4 弧度）更自然，避免大幅扭转
- 膝盖弯曲：lKnee/rKnee 的 x 轴取正值（0.6~1.0 弧度）
- 手臂抬起：lArm/rArm 的 z 轴（正值向外，负值向内）
- 身体前倾：upperBody 的 x 轴取负值

## 复合姿势示例（跪下）
\`\`\`javascript
ae.setMeta({duration:1.2, loop:false, speed:1});
ae.addKeyframe({t:0, bones:{}, morphs:{}});
ae.addKeyframe({t:0.4, bones:{lKnee:{x:0.7}, rKnee:{x:0.7}, lAnkle:{x:0.5}, rAnkle:{x:0.5}, lowerBody:{x:-0.35}, upperBody:{x:0.15}}, morphs:{}});
ae.addKeyframe({t:1, bones:{lKnee:{x:0.9}, rKnee:{x:0.9}, lAnkle:{x:0.6}, rAnkle:{x:0.6}, lowerBody:{x:-0.45}, upperBody:{x:0.2}}, morphs:{}});
\`\`\`

## 规则
- **必须先调用工具获取信息，再生成代码**，不要凭空猜测骨骼是否可用
- 骨骼键必须取自 get_model_bones 返回的可用骨骼key，严禁使用 leftArm/rightArm/arm/leg 等英文简写
- 只能使用 pet / ae API，禁止访问其他对象、网络、文件或DOM
- 如果 ae.isBuiltin 为 true（内置动作），关键帧只读，请先告诉用户点击"复制为可编辑动作"创建副本
- 修改动作时：微调已有动作只对涉及的帧 updateKeyframe，其余帧原样保留；空白/全新动作可先清空再构建
- 最终回复时，给出完整的代码和简要说明，代码放在 javascript 代码块中`;

  function extractJson(text) {
    if (!text) return null;
    let raw = String(text).trim();
    const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) raw = fence[1].trim();
    try { return JSON.parse(raw); } catch (e) { /* continue */ }
    const open = raw.search(/\{/);
    if (open < 0) return null;
    let depth = 0, end = -1;
    for (let i = open; i < raw.length; i++) {
      if (raw[i] === '{') depth++;
      else if (raw[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    if (end < 0) return null;
    try { return JSON.parse(raw.slice(open, end + 1)); } catch (e) { return null; }
  }

  async function askAI(userText) {
    const respEl = el('ve-ai-response');
    if (!respEl) return;
    
    // 初始化消息历史
    const messages = [
      { role: 'system', content: AI_SYS_PROMPT },
      { role: 'user', content: userText }
    ];
    
    let round = 0;
    const maxRounds = 10; // 合理上限，避免无限循环，但不显示给用户
    let finalCode = null;
    let finalExplain = null;
    let toolHistory = [];
    
    // 显示思考状态
    let currentThinking = '';
    function updateStatus(html, thinking) {
      if (thinking !== undefined) currentThinking = thinking;
      const thinkingHtml = currentThinking ? '<div class="ve-ai-thinking-section"><div class="ve-ai-thinking-header" onclick="var n=this.nextElementSibling;n.style.display=n.style.display===\'none\'?\'block\':\'none\';this.querySelector(\'.toggle\').textContent=n.style.display===\'none\'?\'▶\':\'▼\';"><span class="toggle">▼</span> 思考过程</div><div class="ve-ai-thinking-content" style="display:block;">' + escapeHtml(currentThinking) + '</div></div>' : '';
      respEl.innerHTML = thinkingHtml + html;
    }
    
    try {
      while (round < maxRounds) {
        round++;
        updateStatus(`<div class="ve-ai-loading"><span class="ve-icon"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="8" width="18" height="12" rx="2"/><path d="M12 8V4"/><circle cx="12" cy="3" r="1"/><path d="M8 14h.01"/><path d="M16 14h.01"/><path d="M9 18h6"/></svg></span> AI 思考中...</div>
          <div class="ve-ai-tool-history">
            ${toolHistory.length > 0 ? '<div class="ve-ai-th-title">已调用工具：</div>' + toolHistory.map((t, i) => `<div class="ve-ai-th-item">${i+1}. ${getToolNameCN(t.name)} ${t.success ? '<span class="ve-icon ve-icon-success">` + successSVG + `</span>' : '<span class="ve-icon ve-icon-error">` + errorSVG + `</span>'} ${t.success ? ' ✅' : ' ❌'}</div>`).join('') : ''}
          </div>`);
        
        // 调用AI
        const result = await window.api.chat({
          messages: messages,
          silent: true
        });
        
        if (!result || !result.success) {
          respEl.innerHTML = `<div class="ve-ai-err">AI 请求失败：${((result && result.error) || '未知错误')}（请先在「AI 配置」中配置可用的 AI 服务）</div>`;
          return;
        }
        
        const aiText = result.content || '';
        // 提取思考过程（支持多种字段名和多种API响应结构）
        let thinking = '';
        // 1. 直接在result上
        thinking = result.thinking || result.reasoning || result.thought || result.thinking_content || '';
        // 2. 在result.data上（完整API响应）
        if (!thinking && result.data) {
          thinking = result.data.thinking || result.data.reasoning || result.data.thought || result.data.thinking_content || '';
          // 3. 在result.data.message上（Ollama格式）
          if (!thinking && result.data.message) {
            thinking = result.data.message.thinking || result.data.message.reasoning || result.data.message.thought || '';
          }
          // 4. 在result.data.choices[0].message上（OpenAI格式）
          if (!thinking && result.data.choices && result.data.choices[0] && result.data.choices[0].message) {
            thinking = result.data.choices[0].message.thinking || result.data.choices[0].message.reasoning || result.data.choices[0].message.reasoning_content || '';
          }
        }
        if (thinking) {
          currentThinking = thinking;
          console.log('[VE-AI] 思考过程:', thinking.substring(0, 200));
          console.log('[VE-AI] 思考过程长度:', thinking.length);
        } else {
          console.log('[VE-AI] 未找到思考过程，result keys:', Object.keys(result));
          if (result.data) console.log('[VE-AI] result.data keys:', Object.keys(result.data));
          if (result.data && result.data.message) console.log('[VE-AI] result.data.message keys:', Object.keys(result.data.message));
        }
        messages.push({ role: 'assistant', content: aiText });
        
        // 检查是否有工具调用
        const toolCalls = extractToolCalls(aiText);
        
        if (toolCalls.length > 0) {
          // 执行工具调用
          for (const call of toolCalls) {
            updateStatus(`<div class="ve-ai-loading"><span class="ve-icon"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg></span> 正在调用工具：${getToolNameCN(call.name)}...</div>
              <div class="ve-ai-tool-history">
              ${toolHistory.length > 0 ? '<div class="ve-ai-th-title">已调用工具：</div>' + toolHistory.map((t, i) => `<div class="ve-ai-th-item">${i+1}. ${getToolNameCN(t.name)} ${t.success ? '<span class="ve-icon ve-icon-success">` + successSVG + `</span>' : '<span class="ve-icon ve-icon-error">` + errorSVG + `</span>'}</div>`).join('') : ''}
              </div>`);
            
            const toolResult = await executeVETool(call.name, call.arguments || {});
            toolHistory.push({ name: call.name, success: toolResult.success, result: toolResult });
            
            // 将工具结果添加到消息中
            messages.push({
              role: 'user',
              content: `工具 ${call.name} 的执行结果：\n${JSON.stringify(toolResult, null, 2)}\n\n请根据工具结果继续思考，如果需要调用其他工具请继续输出工具调用JSON，如果已经完成请给出最终代码和说明。`
            });
          }
          continue; // 继续下一轮
        }
        
        // 没有工具调用，检查是否有最终代码
        // 尝试从回复中提取JavaScript代码
        const codeMatch = aiText.match(/```javascripts*([sS]*?)```/i);
        if (codeMatch) {
          finalCode = codeMatch[1].trim();
          // 提取说明（代码块之前的文字）
          const explainMatch = aiText.substring(0, aiText.indexOf(codeMatch[0])).trim();
          finalExplain = explainMatch || 'AI 已生成动作代码';
          break;
        }
        
        // 如果没有代码块，检查是否有JSON格式的 {explain, code}
        const jsonMatch = aiText.match(/{[sS]*?"explain"[sS]*?"code"[sS]*?}/);
        if (jsonMatch) {
          try {
            const parsed = JSON.parse(jsonMatch[0]);
            if (parsed.code) {
              finalCode = parsed.code;
              finalExplain = parsed.explain || 'AI 已生成动作代码';
              break;
            }
          } catch (e) { /* 解析失败 */ }
        }
        
        // 如果既没有工具调用也没有代码，可能是纯文本说明
        finalExplain = aiText.trim();
        break;
      }
      
      // 显示最终结果
      if (finalCode) {
        respEl.innerHTML = `
          <div class="ve-ai-plan">
            <div class="ve-ai-explain"><span class="ve-icon"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="8" width="18" height="12" rx="2"/><path d="M12 8V4"/><circle cx="12" cy="3" r="1"/><path d="M8 14h.01"/><path d="M16 14h.01"/><path d="M9 18h6"/></svg></span> ${escapeHtml(finalExplain)}</div>
            <div class="ve-ai-rounds">调用 ${toolHistory.length} 个工具</div>
            <pre class="ve-ai-code">${escapeHtml(finalCode)}</pre>
            <div class="ve-ai-actions">
              <button class="btn btn-primary" id="ve-ai-run">执行</button>
              <button class="btn" id="ve-ai-cancel">取消</button>
            </div>
            <div class="ve-ai-result" id="ve-ai-result"></div>
          </div>`;
        
        el('ve-ai-run').addEventListener('click', async () => {
          const r = el('ve-ai-result');
          r.textContent = '执行中…';
          try {
            const fn = safeCreateFn(finalCode);
            const res = await fn(pet, window.api, ACTIONS, currentAeApi);
            r.className = 've-ai-result ok';
            r.textContent = '✓ 已执行' + (res !== undefined ? '：' + safeStringify(res) : '');
            if (window.showToast) window.showToast('AI 已执行', finalExplain || '', 'success');
          } catch (err) {
            r.className = 've-ai-result err';
            r.textContent = '✗ 执行出错：' + (err && err.message ? err.message : String(err));
          }
        });
        el('ve-ai-cancel').addEventListener('click', () => {
          respEl.innerHTML = '<div class="ve-ai-canceled">已取消执行</div>';
        });
      } else if (finalExplain) {
        respEl.innerHTML = `<div class="ve-ai-explain-only"><span class="ve-icon"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="8" width="18" height="12" rx="2"/><path d="M12 8V4"/><circle cx="12" cy="3" r="1"/><path d="M8 14h.01"/><path d="M16 14h.01"/><path d="M9 18h6"/></svg></span> ${escapeHtml(finalExplain)}</div>`;
      } else {
        respEl.innerHTML = '<div class="ve-ai-err">AI 未返回有效内容，请重试或调整指令</div>';
      }
    } catch (err) {
      respEl.innerHTML = '<div class="ve-ai-err">AI 调用异常：' + (err && err.message ? err.message : String(err)) + '</div>';
    }
  }

  // ---- 构建面板（注入到「动作编辑器」窗口内部）----
  // 包含：宠物显示参数滑块 + 代码控制台 + AI 助手（独立会话）。
  // 代码控制台 / AI 助手 既能微调模型（pet.*），也能“累加”编辑当前动作的关键帧（ae.*）。
  function buildVisualControlPanel(container, ae) {
    if (!container) return;
    // 打开面板时对已有 def 做一次原地 sanitize：把历史遗留的非标准 bone/morph key 归一到标准 key，
    // 值格式补全为 {x,y,z} / 数字。这样即使用户之前用 AI 生成时写进了 hip/knee 等非标准键，
    // 重新打开编辑器后也能在骨骼面板里看到数值、点击关键帧能正确显示。只对可编辑（非内置）动作执行。
    if (ae && ae.def && !ae.isBuiltin && Array.isArray(ae.def.keyframes)) {
      let changed = false;
      ae.def.keyframes = ae.def.keyframes.map(kf => {
        const nk = normKf(kf);
        // 保留原 t（normKf 已处理），仅当 key/值确实变化时标记
        if (JSON.stringify(nk) !== JSON.stringify({ t: kf.t, bones: kf.bones || {}, root: kf.root || {}, morphs: kf.morphs || {} })) changed = true;
        return nk;
      });
      if (changed) {
        ae.def.keyframes.sort((a, b) => a.t - b.t);
        console.log('[ae.sanitize] 已把当前动作的非标准骨骼/表情键归一化到 ACTION_BONES 标准 key');
      }
    }
    currentAeApi = (ae && typeof ae.def !== 'undefined') ? buildAeApi(ae) : null;
    container.innerHTML = `
      <div class="ae-subhead">代码 / AI 控制</div>

      <div class="ve-card">
        <div class="ve-card-title">代码控制台 <span class="ve-card-sub">用 JS 操控 pet 与 ae（动作关键帧）</span></div>
        <textarea id="ve-code" class="ve-code" rows="4" placeholder="例如：await pet.size(1.5); ae.addKeyframe({t:0.5, bones:{rArm:{z:-1}}});">await pet.size(1.3);</textarea>
        <div class="ve-code-actions">
          <button class="btn btn-sm btn-primary" id="ve-run-code">运行</button>
          <button class="btn btn-sm" id="ve-clear-console">清屏</button>
          <span class="ve-card-sub" data-info-tip="codeConsole">可用 API 说明</span>
        </div>
        <div class="ve-console-output" id="ve-console-output"></div>
      </div>

      <div class="ve-card">
        <div class="ve-card-title">AI 助手</div>
        <textarea id="ve-ai-input" class="ve-ai-input" rows="3" placeholder="例如：让左手举再高一点 / 做一个 3 秒循环挥手"></textarea>
        <div class="ve-code-actions">
          <button class="btn btn-sm btn-primary" id="ve-ai-send">让 AI 执行</button>
          <span class="ve-card-sub" data-info-tip="aiAssistant">AI 工作原理</span>
        </div>
        <div class="ve-ai-response" id="ve-ai-response"></div>
      </div>`;

    // 代码控制台
    el('ve-run-code').addEventListener('click', () => runCode(el('ve-code').value));
    el('ve-code').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); runCode(el('ve-code').value); }
    });
    el('ve-clear-console').addEventListener('click', () => { el('ve-console-output').innerHTML = ''; });

    // AI 助手（独立会话：调用 chat 时 silent:true，结果只回传本面板，不广播到主窗口「AI 对话」）
    el('ve-ai-send').addEventListener('click', () => askAI(el('ve-ai-input').value));
    el('ve-ai-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); askAI(el('ve-ai-input').value); }
    });

    initialized = true;
  }

  window.buildVisualControlPanel = buildVisualControlPanel;
})();
