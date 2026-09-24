// mmdPet.js — AI龙虾 3D(MMD/PMX) 宠物渲染器
// 经 .workbuddy/mmdbuild/build.js 用 esbuild 打包成普通(classic)脚本 mmdPet.bundle.js，
// 在 pet.html 中通过 <script src> 以全局 window.MmdPet 暴露（file:// 下不能用 ES Module）。
// 与 Live2D 渲染完全独立：本模块只负责把 PMX 模型用 Three.js(r162, WebGL1) 渲染成可交互的桌面宠物，
// 并把现有宠物行为状态机（PetBrain）的意图映射到 MMD 的表情 morph / 程序化动作 / 睡眠姿势。
import * as THREE from 'three';
import { MMDLoader } from 'three/addons/loaders/MMDLoader.js';
import { MMDAnimationHelper } from 'three/addons/animation/MMDAnimationHelper.js';
import { MMDPhysics } from 'three/addons/animation/MMDPhysics.js';

// 表情 morph 关键词 → 权重（按 MMD 模型常见日文/英文命名模糊匹配）
const EXPR_DEFS = {
  happy:    [['笑い', 1], ['微笑', 0.85], ['ニコ', 0.8], ['smile', 1]],
  sad:      [['悲しい', 1], ['哀', 0.9], ['sad', 1]],
  angry:    [['怒り', 1], ['憤', 0.9], ['angry', 1]],
  surprise: [['驚き', 1], ['びっくり', 0.9], ['surprise', 1]],
  shy:      [['照れ', 1], ['恥', 0.85], ['blush', 1]],
  think:    [['困る', 0.5], ['think', 0.5]],
  confuse:  [['困る', 0.6], ['疑', 0.5]],
  greet:    [['笑い', 0.6], ['微笑', 0.5]],
  love:     [['照れ', 0.7], ['笑い', 0.4]],
  sleepy:   [['疲れ', 0.6], ['sleepy', 0.6]],
};
// 眨眼 morph 候选名（闭眼用）
const BLINK_NAMES = ['瞬き', 'まばたき', 'ウィンク', '閉じ', 'blink', 'wink'];

function findMorphIndex(dict, keywords) {
  if (!dict) return -1;
  const lower = keywords.map((k) => k.toLowerCase());
  for (const name in dict) {
    const nl = name.toLowerCase();
    for (const k of lower) {
      if (nl === k || nl.includes(k)) return dict[name];
    }
  }
  return -1;
}

function rand(a, b) {
  return a + Math.random() * (b - a);
}

export function createMmdPet(canvas) {
  let renderer = null;
  let scene = null;
  let camera = null;
  let helper = null;
  let mesh = null;
  let extraMeshes = [];   // 组合模型包附加部件（武器等）的 SkinnedMesh 列表
  let morphDict = {};
  let morphInf = [];
  let blinkIdx = -1;
  const exprIndex = {}; // emotion -> [{idx, weight}]
  let baseY = 0;
  let modelHeight = 20; // 模型身高（model 单位），动作幅度按其等比缩放，避免不同模型幅度差异过大
  // 骨骼系统（用于逐关节动作，而不只是整体旋转根节点）
  let skeleton = null;            // mesh.skeleton
  let bones = {};                 // 解析后的骨骼名 -> Bone（按 MMD 日文/英文候选命中）
  let boneRest = {};              // 名 -> 绑定姿态四元数（bind pose）
  let baseQuats = {};             // 名 -> 当前静止基线四元数（applyRelax 之后）；动作结束回到这里

  // ===== 分层动作融合（模块2）状态 =====
  // 模型资产配置（模块1 产物）：bone_limit（角度钳制，度）、breath（呼吸配置）。
  // 模块1 未接入前为空对象，钳制/自定义呼吸自动降级为默认行为，保证向后兼容。
  let modelConfig = {};
  let currentPmxName = '';        // 当前模型文件名（含扩展名），供 generateModelConfig 写 model_name
  const prevPose = {};            // 骨名 -> 上一帧「动作层平滑后」四元数（不含呼吸，防呼吸累积）
  let aiWeight = 0;               // AI 动作层权重（0~1，向 (activeAction?1:0) 指数逼近，实现 Layer2 0→1/1→0 过渡）
  const breathBoneSet = new Set();// 参与呼吸的骨骼（模型实际存在名），默认上半身/上半身2
  const _breathQ = new THREE.Quaternion(); // 呼吸临时四元数
  // 呼吸/平滑常量（可被 modelConfig.breath 覆盖）
  const BREATH_AMP_DEG = 1.0;     // 上半身正弦呼吸幅度（度），±0.5~1.5°
  const BREATH_PERIOD = 3.0;      // 呼吸周期（秒）
  const BREATH_AXIS = new THREE.Vector3(1, 0, 0); // 绕 X 轴前后微倾
  const ACTION_TAU = 0.12;        // 动作层平滑时间常数（≈0.3s 过渡，消除硬切 + 实现 Layer2 权重过渡）
  const AI_TAU = 0.18;            // AI 动作权重跟踪时间常数
  const BASE_IDLE = 1.0;          // 待机微动基础权重

  // ===== 模块4：AI 骨骼偏移关键帧（Layer2 AI 动作层）状态 =====
  let aiClip = null;              // 归一化后的剪辑：{ dur, frames:[{t, quats:{name:Quat}}], bones:Set<name> }
  let aiClipStart = 0;            // 剪辑起始的 elapsed 时间
  let aiClipActive = false;       // 剪辑正在播放（驱动 Layer2 权重 + 骨骼目标；独立于 activeAction）
  const _aiTmpQ = new THREE.Quaternion();   // 关键帧插值临时四元数
  const _aiIdentQ = new THREE.Quaternion(); // 单位四元数（关键帧缺失骨 = 保持 rest）

  // ===== 模块3：毛发/软组织次级动力学（Layer3，自定义弹簧）=====
  // 说明：物理启用时（见上方 Ammo/MMDPhysics），发/裙/布/胸 等次级「肉体」由 MMDPhysics 自然驱动，
  // 此时 hairEnabled 会被置 false 关闭本手写弹簧，避免双重摆动；若物理不可用（Ammo 缺失/降级），
  // 则退回本手写弹簧维持发/尾的滞后摆动（叠加在 applyLayerBlend 已写好的姿态之上，仅渲染用）。
  const hairBones = [];            // [{ b, parent, off:Vector3(欧拉弧度), vel:Vector3, parentPrevQ:Quat }]
  let hairEnabled = true;          // 是否启用毛发次级动力学（可被 modelConfig.hair_physics.enable 覆盖）
  let hairStiffness = 55;          // 回正刚度（越大回正越快）
  let hairDamping = 7;             // 阻尼（越大越不抖）
  let hairMaxDeg = 14;             // 单轴最大偏移（度），防甩飞
  let hairSensitivity = 22;        // 惯性输入灵敏度（父骨角速度 → 毛发滞后）
  const _hairTmpQ = new THREE.Quaternion();
  const _hairEuler = new THREE.Euler();

  let running = false;
  let rafId = 0;
  const clock = new THREE.Clock();

  // ===== 刚性/柔性碰撞物理（Ammo/Bullet 经 MMDPhysics）=====
  // 说明：MMD 模型自带的刚体分三类——
  //   type 0 = 运动学(骨骼)刚体：物理【不会】改写对应骨骼（1:1 透传，即主骨架 臂/腿/躯干/颈/头）；
  //   type 1 = 动态刚体：物理模拟并改写骨骼（发/裙/布/胸/臀 等次级「肉体」部位）；
  //   type 2 = 动态+骨骼：同上但额外回写位置。
  // 因此只要把「动态(type1/2)且非主骨架」的刚体交给 MMDPhysics，物理就只作用于发/裙/胸等软组织，
  // 永远碰不到动作引擎正在驱动的主骨架 → 二者天然不冲突，且自然产生「肉体变形」与碰撞。
  // 物理读取动作引擎每帧写好的主骨架姿态作为运动学输入，再让动态刚体在重力/约束下摆动。
  let physics = null;             // MMDPhysics 实例（null = 物理不可用/未启用，降级纯骨骼姿态）
  let physicsEnabled = false;     // 是否成功启用物理
  let _ammoReady = null;          // Promise<boolean>：Ammo 运行时是否就绪（仅首次加载模型时初始化一次）
  // 主骨架骨骼名（动作引擎驱动，物理必须排除，防止手臂/腿被物理拉乱）：中/英/日常见命名
  // 主骨架（臂/腿/躯干/头/颈）正则：物理绝不接管这些骨骼，避免与动作引擎(FK)争夺、导致"下半身编辑不了"与异常动作。
  // 注意：英文腿骨名(Thigh_L/Calf_L/Foot_L/Toe_L 等)以及 JP 的 腿/尻/腰/つま先/かかと/ふくらはぎ 等必须覆盖，
  // 否则这些动态刚体会漏进物理、每帧覆盖腿部 FK 旋转。下方 setupPhysics 还会用 BONE_KEYS 实际命中骨名做「显式排除」兜底。
  const MAIN_BONE_RE = /(arm|shoulder|elbow|wrist|finger|hand|leg|thigh|calf|shin|knee|ankle|foot|toe|sole|heel|butt|buttock|hip|pelvis|neck|head|spine|trunk|torso|waist|abdomen|upperbody|lowerbody|body|root|center|センター|上半身|下半身|腕|肩|肘|手|指|足|膝|首|頭|胴|体|腰|腿|尻|脊|椎|骨盤|つま先|かかと|ふくらはぎ|足ＩＫ|足IK)/i;

  // 初始化 Ammo(Bullet) wasm 运行时（只做一次）。wasm 以 base64 内嵌在 window.__AMMO_WASM_B64，
  // 解码后通过 wasmBinary 注入 Ammo，彻底规避 Electron file:///asar 下 fetch wasm 失败。
  // 任何失败都 resolve(false)，让物理优雅降级（模型照常渲染，只是没有碰撞/软组织物理）。
  function ensureAmmo() {
    if (_ammoReady) return _ammoReady;
    _ammoReady = new Promise((resolve) => {
      try {
        const AmmoFn = (typeof Ammo !== 'undefined') ? Ammo
          : (typeof window !== 'undefined' && window.Ammo);
        if (typeof AmmoFn !== 'function') {
          console.warn('[MMD] 未找到 Ammo 运行时，物理(刚性/柔性碰撞)不可用，降级为纯骨骼姿态');
          return resolve(false);
        }
        const b64 = (typeof window !== 'undefined' && window.__AMMO_WASM_B64) || null;
        if (!b64) {
          console.warn('[MMD] 未找到内嵌 wasm(__AMMO_WASM_B64)，物理不可用');
          return resolve(false);
        }
        const binary = (typeof atob === 'function')
          ? Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
          : new Uint8Array(Buffer.from(b64, 'base64'));
        const ready = AmmoFn({ wasmBinary: binary.buffer ? binary.buffer : binary });
        if (ready && typeof ready.then === 'function') {
          ready.then(() => { console.log('[MMD] Ammo 物理运行时就绪'); resolve(true); })
                .catch((e) => { console.warn('[MMD] Ammo 初始化失败:', e); resolve(false); });
        } else {
          console.log('[MMD] Ammo 物理运行时就绪(同步)');
          resolve(true);
        }
      } catch (e) {
        console.warn('[MMD] Ammo 初始化异常，物理降级:', e);
        resolve(false);
      }
    });
    return _ammoReady;
  }
  let elapsed = 0;
  const raycaster = new THREE.Raycaster(); // 点击穿透用：射线命中检测 3D 模型本体

  // 表情 / 眨眼
  const exprTarget = {}; // morphIdx -> target(0..1)
  let blinkTarget = 0;
  let blinkValue = 0;
  let blinkPhase = 'idle'; // idle | close | open
  let blinkTimer = 0;
  let nextBlinkAt = 0;
  let sleeping = false;

  // 动作 / 表情保持
  let emote = null; // {t, dur, amp}
  let activeComboToken = 0; // 待机组合循环令牌：被取代/停止时令进行中的组合失效
  let exprHoldTimer = 0;
  let activeAction = null; // 正在播放的程序化动作 {key, t, dur, base:{yaw,pitch,roll,y}}
  let actionQueue = [];    // 相关动作队列（主动作结束后依次播放，遗留无时间点条目）
  let pendingEntry = null; // 相关动作：延时/重播调度挂起项
  let pendingDelay = 0;    // 相关动作之间的间隔(秒)
  let timedEntries = [];   // 时间轴断点：主动作播放期间按 t 切入的相关动作（视频剪辑式切轨）
  let timedClock = 0;      // 主动作已播放时长（秒），用于比对断点 fireAt
  let suspendedMain = null;// 切轨时被挂起的主动作，播完相关动作后恢复
  let customActions = {};  // 每模型自定义关键帧动作：key -> def
  let actionRelated = {};  // 内置/自定义动作的"相关动作"覆盖：key -> [keys]
  let deletedBuiltinKeys = []; // 用户在本模型下删除(隐藏)的默认动作键，运行时禁止触发

  // 透明无边框窗口里，同一窗口同时活两个 WebGL 上下文（PIXI 的 + Three 的）时，
  // 后创建的那个极易被丢弃/失效，表现为着色器全部编译失败（program not valid）。
  // 因此调用方在加载 MMD 前应先销毁 PIXI 上下文，使这里成为窗口内唯一 WebGL 上下文。
  // 上下文获取策略：优先试 WebGL2（MMD 的 morph/骨骼在 WebGL2 下更稳），失败再回退 WebGL1；
  // 两种都先检测 isContextLost，避免拿到一个失效上下文还硬渲染。
  // 性能优化：内部渲染分辨率缩放（FSR / DLSS 的轻量近似）。
  // 以低于显示分辨率渲染，再由浏览器用双线性插值放大到画布尺寸，
  // 在 MMD 这种高顶点 / 多骨骼模型上显著降低 GPU 填充率与片段着色开销，缓解「使用卡顿」。
  // RENDER_SCALE=0.8 → 内部 80% 分辨率，视觉损失极小；MAX_DPR 封顶避免 HiDPI 下过度采样。
  let currentRenderScale = 0.8; // ★ 改为可动态调节的变量（原常量 RENDER_SCALE）
  const MAX_DPR = 1.5;
  let lastWidth = 320, lastHeight = 460; // 记录最后一次 resize 的尺寸，供 setRenderScale 使用
  // 渲染帧率封顶（避免高刷新率屏幕空转浪费 GPU；对低端机主要收益来自上面的分辨率缩放）。
  const TARGET_FPS = 60;

  function initRenderer() {
    const ctxAttrs = {
      alpha: true,
      antialias: true,
      depth: true,
      stencil: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
      failIfMajorPerformanceCaveat: false,
    };
    let gl = null;
    const tryCtx = (name) => {
      try { return canvas.getContext(name, ctxAttrs); } catch (e) { return null; }
    };
    // MMD 的骨骼蒙皮着色器（skinning_pars_vertex）使用了 GLSL ES 3.00 专属语法
    // （textureSize / texelFetch / 整数取模 %），只能在 WebGL2 上下文下编译。
    // 因此这里强制要求 WebGL2；拿不到就直接放弃（由调用方回退到 CSS/Live2D），
    // 绝不回退到 WebGL1 —— 否则会因 GLSL 版本不匹配导致着色器全部编译失败
    // （报 useProgram: program not valid / drawElements: no valid shader program）。
    gl = tryCtx('webgl2');
    if (!gl || gl.isContextLost()) {
      console.error('[MMD] 无法创建 WebGL2 上下文（MMD 骨骼蒙皮需要 WebGL2 / GLSL3）。' +
        '当前环境可能未启用硬件加速，或透明无边框窗口限制了 WebGL2。');
      return false;
    }

    renderer = new THREE.WebGLRenderer({ canvas, context: gl, alpha: true, antialias: true, premultipliedAlpha: false });
    renderer.debug.checkShaderErrors = true; // 着色器编译失败时输出详细 GLSL/infoLog，便于排查
    const isGL2 = (typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext);
    console.log('[MMD] WebGL 上下文已就绪:', gl.getParameter(gl.VERSION),
      '| isWebGL2:', isGL2,
      '| MAX_VERTEX_UNIFORM_VECTORS:', gl.getParameter(gl.MAX_VERTEX_UNIFORM_VECTORS),
      '| MAX_VERTEX_ATTRIBS:', gl.getParameter(gl.MAX_VERTEX_ATTRIBS));
    renderer.setClearColor(0x000000, 0);
    const w = canvas.clientWidth || canvas.width || 320;
    const h = canvas.clientHeight || canvas.height || 460;
    // 内部分辨率 = min(dpr, MAX_DPR) * currentRenderScale；画布 CSS 尺寸不变，由浏览器放大（FSR 式近似）。
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, MAX_DPR) * currentRenderScale);
    renderer.setSize(w, h, false);

    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(35, w / h, 0.1, 3000);

    // 修复"灰蒙蒙/雾状"与过曝：
    // 1) 输出设为 sRGB，并在 load() 中对颜色贴图显式标记 sRGB（否则被当线性采样会发灰发白）。
    // 2) 色调映射用 NeutralToneMapping（Khronos PBR Neutral）：只在亮度 >0.8 的高光区做柔和压缩、
    //    把削顶的死白拉回正常高光，同时几乎不污染中/暗部饱和度（不像 ACES Filmic 那样整体压成发灰雾面）。
    //    这样既能消除过曝，又保留模型固有色的鲜艳通透。
    // 3) 高对比布光 + 轮廓光（rim）把模型从背景里"抠"出来，消除平面灰、缺乏立体感。
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.NeutralToneMapping;
    renderer.toneMappingExposure = 1.0;

    // 布光：极低白色环境光 + 低半球光，最大限度保留模型固有色（不再被白光冲淡）；
    // 主光提亮补偿、补光冷色填充暗部、暖轮廓光勾边——高对比度让颜色鲜艳不灰。
    // 修复过曝：原主光 3.5 / 轮廓光 1.8 在 NoToneMapping 下会把明亮表面直接打到 >1 而削顶成死白；
    // 现下调主光≈2.0、轮廓光≈1.0、补光≈0.55，并把环境光抬到 0.25 以补偿暗部、避免发灰发脏，
    // 既消除大面积过曝，又保留鲜艳固有色与立体感。
    scene.add(new THREE.AmbientLight(0xffffff, 0.25));
    const key = new THREE.DirectionalLight(0xffffff, 2.0);
    key.position.set(0.5, 1.2, 0.8);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xbfd4ff, 0.55);
    fill.position.set(-0.8, 0.4, -0.5);
    scene.add(fill);
    const rim = new THREE.DirectionalLight(0xffd9b0, 1.0); // 轮廓光，从背后打，勾边、提升层次
    rim.position.set(-0.3, 0.8, -1.0);
    scene.add(rim);
    const hemi = new THREE.HemisphereLight(0xffffff, 0x555566, 0.22);
    scene.add(hemi);
    return true;
  }

  function discoverMorphs() {
    morphDict = mesh.morphTargetDictionary || {};
    morphInf = mesh.morphTargetInfluences || [];
    blinkIdx = findMorphIndex(morphDict, BLINK_NAMES);
    for (const emotion in EXPR_DEFS) {
      const list = [];
      for (const [kw, wgt] of EXPR_DEFS[emotion]) {
        const idx = findMorphIndex(morphDict, [kw]);
        if (idx >= 0) list.push({ idx, weight: wgt });
      }
      exprIndex[emotion] = list;
    }
    console.log('[MMD] 可用 morph:', Object.keys(morphDict), '眨眼morph idx=', blinkIdx);
  }

  function frameCamera() {
    mesh.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(mesh);
    if (box.isEmpty()) return;
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    // 居中 x/z，脚底贴 y=0
    mesh.position.x -= center.x;
    mesh.position.z -= center.z;
    mesh.position.y -= box.min.y;
    baseY = mesh.position.y;
    const maxY = size.y || 20;
    modelHeight = size.y || 20;
    const fov = (camera.fov * Math.PI) / 180;
    let dist = maxY / 2 / Math.tan(fov / 2);
    dist *= 1.7; // 留边距
    camera.position.set(0, maxY * 0.52, dist);
    camera.lookAt(0, maxY * 0.5, 0);
    camera.updateProjectionMatrix();
  }

  function applyExpr(emotion) {
    // 先把所有已知表情 morph 目标归 0，再置位匹配项
    for (const e in exprIndex) {
      for (const { idx } of exprIndex[e]) exprTarget[idx] = 0;
    }
    const list = exprIndex[emotion];
    if (list) for (const { idx, weight } of list) exprTarget[idx] = weight;
  }

  function resetExpr() {
    for (const e in exprIndex) {
      for (const { idx } of exprIndex[e]) exprTarget[idx] = 0;
    }
  }

  function mapIntentToEmotion(intent) {
    switch (intent) {
      case 'happy':
      case 'dance':
        return 'happy';
      case 'sad':
        return 'sad';
      case 'angry':
        return 'angry';
      case 'surprise':
        return 'surprise';
      case 'shy':
      case 'love':
        return 'shy';
      case 'think':
        return 'think';
      case 'confuse':
        return 'confuse';
      case 'greet':
      case 'wake':
        return 'greet';
      case 'lazy':
      case 'sleep':
        return 'sleepy';
      default:
        return null;
    }
  }

  function setExpression(intent) {
    const emo = mapIntentToEmotion(intent);
    if (emo) {
      applyExpr(emo);
      exprHoldTimer = 2.6;
    }
  }

  function playIntent(intent) {
    if (!mesh) return;
    // 状态机接管时，除显式"唤醒"意图外忽略其它动作意图（严格顺序控制，避免打乱状态）
    if (smActive) {
      if (intent === 'wake') return smWake();
      return;
    }
    const emo = mapIntentToEmotion(intent);
    if (emo) {
      applyExpr(emo);
      exprHoldTimer = 2.6;
    }
    // 优先播放对应的程序化 3D 动作（转身/点头/摇头/鞠躬/招手/跳/跳舞等）
    const actionName = INTENT_TO_ACTION[intent];
    if (actionName) {
      startAction(actionName);
      return;
    }
    // 兜底：无任何匹配动作时，用小幅弹跳表达情绪
    let amp = 0.5;
    let dur = 0.45;
    if (intent === 'happy' || intent === 'tap' || intent === 'click' || intent === 'flick') {
      amp = 0.8;
      dur = 0.5;
    } else if (intent === 'surprise') {
      amp = 1.5;
      dur = 0.6;
    } else if (intent === 'sad') {
      amp = -0.4;
      dur = 0.8;
    } else if (intent === 'greet' || intent === 'wake') {
      amp = 0.6;
      dur = 0.7;
    }
    emote = { t: 0, dur, amp };
  }

  // 计算某意图若被 playIntent 触发，其动作大致时长（秒）。
  // 与 playIntent 的分支保持一致：命中内置动作用 ACTIONS 时长，否则用兜底 emote 时长。
  function motionDurationForIntent(intent) {
    const actionName = INTENT_TO_ACTION[intent];
    if (actionName && ACTIONS[actionName]) return ACTIONS[actionName].dur;
    if (intent === 'happy' || intent === 'tap' || intent === 'click' || intent === 'flick') return 0.5;
    if (intent === 'surprise') return 0.6;
    if (intent === 'sad') return 0.8;
    if (intent === 'greet' || intent === 'wake') return 0.7;
    return 0.45;
  }

  // 顺序播放一段意图组合：逐个播完（含回位余量）后自动从头重播，直到 token 被取代/停止。
  // 用于桌面宠物「待机组合动作」循环——MMD 模型也支持完整序列，而非只播首个动作。
  function playCombo(intents, token) {
    if (!mesh || !Array.isArray(intents) || !intents.length) return;
    activeComboToken = token;
    let i = 0;
    const step = () => {
      if (token !== activeComboToken) return; // 已被新组合或 stopCombo 取代
      if (i >= intents.length) {              // 一轮结束：稍作间隔后重头循环
        i = 0;
        setTimeout(step, 250);
        return;
      }
      const intent = intents[i++];
      try { playIntent(intent); } catch (e) { /* 忽略单步异常，循环继续 */ }
      const hold = motionDurationForIntent(intent) * 1000 + 300; // 动作时长 + 回位余量
      setTimeout(step, hold);
    };
    step();
  }

  // 停止进行中的待机组合循环（令令牌失效）
  function stopCombo() {
    activeComboToken = -1;
  }

  // 命中检测：给定客户端坐标，射线投射判断是否落在 3D 模型本体上。
  // 用于桌面宠物的「动态点击穿透」——只有戳到龙虾身体才捕获鼠标（可拖动/点击），
  // 透明留白区域让点击穿透到后方窗口；同时避免逐像素 readPixels（性能差且需 preserveDrawingBuffer）。
  function hitTest(clientX, clientY) {
    if (!mesh || !camera || !renderer) return false;
    const el = renderer.domElement;
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const ndcX = ((clientX - rect.left) / rect.width) * 2 - 1;
    const ndcY = -((clientY - rect.top) / rect.height) * 2 + 1;
    if (ndcX < -1 || ndcX > 1 || ndcY < -1 || ndcY > 1) return false;
    raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), camera);
    try {
      const hits = raycaster.intersectObject(mesh, true);
      return hits.length > 0;
    } catch (e) {
      return false;
    }
  }

  function setSleeping(v) {
    // 状态机接管时，睡眠/唤醒走状态机（避免与静态状态冲突）
    if (smActive && mesh) {
      if (v) { if (smState !== SM_STATE.SLEEP) smEnter(SM_STATE.SLEEP); }
      else if (smState === SM_STATE.SLEEP) { smWake(); }
      return;
    }
    sleeping = v;
    if (v) {
      blinkTarget = 1; // 闭眼
      resetExpr();
    } else {
      blinkTarget = 0;
      blinkPhase = 'idle';
      nextBlinkAt = elapsed + rand(2, 5);
    }
  }

  function setMood(/* n */) {
    // 预留：高情绪时可在此叠加轻微默认表情。当前交给 setExpression 主动驱动。
  }

  // ===== 程序化 3D 动作引擎（无 VMD 动作文件时的真实身体表现）=====
  // MMD 模型骨骼动画需要 VMD 文件，本项目未内置。这里用根节点变换做一套
  // 可辨识的"全身动作"，让 AI 的每个意图都能驱动模型做出对应肢体语言，
  // 而不是只会循环播放一个微小弹跳。动作幅度按 modelHeight 等比缩放。
  function clamp01(x) { return x < 0 ? 0 : (x > 1 ? 1 : x); }
  function easeInOut(x) { return x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2; }
  function easeOut(x) { return 1 - Math.pow(1 - x, 2); }

  // ===== 骨骼（逐关节）动作系统 =====
  // 只旋转根节点只能整体转，无法分别控制手臂/头/腰。MMD 模型是带 Skeleton 的 SkinnedMesh，
  // 这里直接驱动骨骼，让每个动作真正"动关节"（像人一样每个关节可控）。
  // 多语言骨骼名（MMD 常用日文；部分模型带英文）：解析时按候选顺序命中第一个存在的。
  const BONE_KEYS = {
    root:       ['センター', 'Center', 'Root', 'センター2'],
    lowerBody:  ['下半身', 'LowerBody', 'Hips', '腰', '骨盤', 'Pelvis', 'Hip', 'Waist', 'Lowerbody'],
    upperBody:  ['上半身', 'UpperBody', 'Spine', 'Upperbody'],
    upperBody2: ['上半身2', 'UpperBody2', 'Chest', '上半身3', 'UpperBody3'],
    neck:       ['首', 'Neck'],
    head:       ['頭', 'Head'],
    lShoulder:  ['左肩', 'LeftShoulder', 'Shoulder_L', '左肩P'],
    lArm:       ['左腕', 'LeftArm', 'Arm_L'],
    lElbow:     ['左ひじ', 'LeftElbow', 'Elbow_L'],
    lWrist:     ['左手首', 'LeftWrist', 'Wrist_L'],
    rShoulder:  ['右肩', 'RightShoulder', 'Shoulder_R', '右肩P'],
    rArm:       ['右腕', 'RightArm', 'Arm_R'],
    rElbow:     ['右ひじ', 'RightElbow', 'Elbow_R'],
    rWrist:     ['右手首', 'RightWrist', 'Wrist_R'],
    lLeg:       ['左足', '左太もも', 'LeftLeg', 'Leg_L', 'Thigh_L', '左腿'],
    lKnee:      ['左ひざ', '左膝', 'LeftKnee', 'Knee_L'],
    lAnkle:     ['左足首', 'LeftAnkle', 'Ankle_L'],
    rLeg:       ['右足', '右太もも', 'RightLeg', 'Leg_R', 'Thigh_R', '右腿'],
    rKnee:      ['右ひざ', '右膝', 'RightKnee', 'Knee_R'],
    rAnkle:     ['右足首', 'RightAnkle', 'Ankle_R']
  };

  // ===== 模块1：骨骼约束预设表（度）=====
  // 宽范围：只拦"穿模级"离谱角度，正常动作不误伤；编辑器（模块5）可逐骨收紧。
  // 仅外部/AI 姿态（poseBoneFromRest 的 clampIt=true）走钳制；内置 ACTIONS 不钳制，避免扭曲既有动画。
  const BONE_LIMIT_PRESET = {
    lShoulder: { x_min: -50, x_max: 50, y_min: -50, y_max: 50, z_min: -90, z_max: 90 },
    rShoulder: { x_min: -50, x_max: 50, y_min: -50, y_max: 50, z_min: -90, z_max: 90 },
    lArm:      { x_min: -60, x_max: 60, y_min: -70, y_max: 70, z_min: -130, z_max: 130 },
    rArm:      { x_min: -60, x_max: 60, y_min: -70, y_max: 70, z_min: -130, z_max: 130 },
    lElbow:    { x_min: -10, x_max: 140, y_min: -30, y_max: 30, z_min: -40, z_max: 40 },
    rElbow:    { x_min: -10, x_max: 140, y_min: -30, y_max: 30, z_min: -40, z_max: 40 },
    lLeg:      { x_min: -70, x_max: 70, y_min: -50, y_max: 50, z_min: -50, z_max: 50 },
    rLeg:      { x_min: -70, x_max: 70, y_min: -50, y_max: 50, z_min: -50, z_max: 50 },
    lKnee:     { x_min: -10, x_max: 150, y_min: -30, y_max: 30, z_min: -30, z_max: 30 },
    rKnee:     { x_min: -10, x_max: 150, y_min: -30, y_max: 30, z_min: -30, z_max: 30 },
    lAnkle:    { x_min: -50, x_max: 50, y_min: -40, y_max: 40, z_min: -40, z_max: 40 },
    rAnkle:    { x_min: -50, x_max: 50, y_min: -40, y_max: 40, z_min: -40, z_max: 40 },
    neck:      { x_min: -35, x_max: 35, y_min: -45, y_max: 45, z_min: -35, z_max: 35 },
    head:      { x_min: -40, x_max: 40, y_min: -50, y_max: 50, z_min: -35, z_max: 35 },
    upperBody: { x_min: -30, x_max: 30, y_min: -30, y_max: 30, z_min: -25, z_max: 25 },
    upperBody2:{ x_min: -25, x_max: 25, y_min: -25, y_max: 25, z_min: -20, z_max: 20 },
    lowerBody: { x_min: -25, x_max: 25, y_min: -25, y_max: 25, z_min: -20, z_max: 20 },
    spine:     { x_min: -30, x_max: 30, y_min: -30, y_max: 30, z_min: -25, z_max: 25 },
    waist:     { x_min: -30, x_max: 30, y_min: -30, y_max: 30, z_min: -25, z_max: 25 }
  };
  // 关键词骨骼（模型特有，如龙虾尾巴/触须/钳）统一给宽范围
  const BONE_LIMIT_KEYWORD = [
    { re: /尾|tail|胴|abdomen|abdom|触|antenna/i, lim: { x_min: -80, x_max: 80, y_min: -90, y_max: 90, z_min: -60, z_max: 60 } },
    { re: /爪|claw|钩|pincer/i, lim: { x_min: -70, x_max: 70, y_min: -70, y_max: 70, z_min: -90, z_max: 90 } }
  ];
  // 模块3：毛发/软组织次级动力学（Layer3）识别用的「软骨骼」关键词（头发/尾巴/触手/裙/缎带等）。
  // 这些骨骼在逐关节动作引擎里本来就是静止的，给它加一个「滞后弹簧」摆动，最像真实 MMD 毛发物理且不与动作引擎打架。
  const HAIR_KEYWORD = /髪|ヘアー?|hair|尾|テール|tail|触手|触角|触|裙|スカート|skirt|リボン|ribbon|揺れ|sway/i;
  function rad2deg(r) { return r * 180 / Math.PI; }
  function _r1(x) { return Math.round(x * 10) / 10; }
  function _r2(x) { return Math.round(x * 100) / 100; }

  // 扭曲/捩骨关键词（MMD 常见 腕捩/足捩/捩れ 等，几乎与父骨共位，不是真正的肢体段）。
  // 这些骨常作为「主骨的第一个直接子骨」插入（如 左腕 → 左腕捩 → 左ひじ），
  // 若 poseBoneAim 误把它们当瞄准参考，会把整条手臂算错 → 手臂/手掌扭曲、左右交叉。
  const TWIST_RE = /捩|Tw|twist|捻|捩れ|捩り/i;
  // 每骨「瞄准参考骨」缓存（骨骼层级静态，只算一次）：通常为直接子骨；
  // 若直接子骨全是共位扭骨，则回退到最远后代（真正的肢体末端）。
  const aimRefCache = {};

  // 收集骨骼到全局注册表（含主模型 + 已挂载的组合模型部件的骨骼）。
  // 修复「3D 组合模型无法操作相关的骨骼和细节关节如手掌之类的」：附加部件(.pmx 武器/手等)
  // 经 addModel 挂载到主模型之下，其骨骼原本不被注册，导致 poseBoneFromRest/poseBoneAim 找不到、
  // 手掌/手指等细节关节无法被动作引擎操作。collectBones 遍历整棵子图（含挂载部件），把新骨骼补进
  // 注册表；只补充不存在的骨骼，保留已有骨骼（尤其主模型经 applyRelax 烘焙的静止基线 baseQuats 不被重置）。
  function collectBones() {
    if (!mesh) return;
    mesh.traverse((o) => {
      if (o.isBone && o.name) {
        if (!bones[o.name]) {
          bones[o.name] = o;
          boneRest[o.name] = o.quaternion.clone();
          baseQuats[o.name] = o.quaternion.clone(); // 新部件骨骼基线 = 自身绑定姿态
        }
      }
    });
  }

  function buildBones() {
    if (!mesh || !mesh.skeleton) return;
    skeleton = mesh.skeleton;
    bones = {};
    boneRest = {};
    baseQuats = {};
    collectBones(); // 首次：主模型 + 任何已预挂载部件
    for (const k in prevPose) delete prevPose[k]; // 换模型清空平滑轨迹
    aiWeight = 0;
    buildBreathBoneSet();
    buildHairSet(); // 模块3：重建软骨骼（毛发）集合
  }

  // 模块3：扫描骨骼，把匹配 HAIR_KEYWORD 的「软骨骼」收集进 hairBones（带弹簧状态）。
  function buildHairSet() {
    hairBones.length = 0;
    if (!skeleton) return;
    for (const b of Object.values(bones)) { // 含组合模型部件骨骼
      if (HAIR_KEYWORD.test(b.name)) {
        hairBones.push({
          b,
          parent: b.parent && b.parent.isBone ? b.parent : null,
          off: new THREE.Vector3(0, 0, 0),   // 当前附加偏移（欧拉，弧度）
          vel: new THREE.Vector3(0, 0, 0),   // 偏移角速度
          parentPrevQ: b.parent && b.parent.isBone ? b.parent.quaternion.clone() : null
        });
      }
    }
    console.log('[MMD][Hair] 软骨骼集合：', hairBones.length, '根');
  }

  // 按逻辑名取 Bone（先查多语言候选，再查原始骨骼名）
  function bone(name) {
    const keys = BONE_KEYS[name];
    if (keys) {
      for (const k of keys) if (bones[k]) return bones[k];
    }
    return bones[name] || null;
  }

  function quatFromEuler(e) {
    return new THREE.Quaternion().setFromEuler(
      new THREE.Euler(e.x || 0, e.y || 0, e.z || 0, 'ZXY')
    );
  }

  // 把某骨骼姿态设为其静止基线 + 相对旋转（每帧都从基线重算，避免累积漂移）
  // clampIt: 仅外部/AI 姿态（poseBone / 模块4）传 true 才做 bone_limit 钳制；
  // 内置 ACTIONS / playKeyframe / applyRelax 不传 → 不钳制，保留手绘动画原样。
  // 调试：累计未命中的逻辑骨骼键，便于发现模型用了 BONE_KEYS 未覆盖的命名
  const _missedBones = new Map();
  function poseBoneFromRest(name, euler, clampIt) {
    const b = bone(name);
    if (!b) {
      const c = (_missedBones.get(name) || 0) + 1;
      _missedBones.set(name, c);
      if (c === 1) console.warn('[MMD] 逻辑骨骼未匹配到任何模型骨骼:', name, '（次数+' + c + '）', '— 可能此模型用了未在 BONE_KEYS 命中的命名，请在 mmdPet.js 的 BONE_KEYS 加入候选别名');
      if (c === 50 || c === 200) console.warn('[MMD] 同一骨骼键', name, '已累计', c, '次未命中');
      return false;
    }
    const base = baseQuats[b.name] || boneRest[b.name];
    if (base) b.quaternion.copy(base);
    else b.rotation.set(0, 0, 0);
    if (euler && (euler.x || euler.y || euler.z)) {
      let ex = euler.x || 0, ey = euler.y || 0, ez = euler.z || 0;
      // 角度钳制（防 AI/动作输出离谱角度造成肢体穿模扭曲）：bone_limit 以"度"为单位（见设计文档），
      // 此处把 euler（弧度）与 limit（度→弧度）对齐后再 clamp。仅 clampIt=true 时生效（内置动作不钳制）。
      if (clampIt) {
        const lim = modelConfig.bone_limit && (modelConfig.bone_limit[name] || modelConfig.bone_limit[b.name]);
        if (lim) {
          const D = Math.PI / 180;
          // 需 min/max 同时有值才钳制，避免单侧缺失导致 clamp(…, undefined) 变 NaN
          if (typeof lim.x_min === 'number' && typeof lim.x_max === 'number') ex = THREE.MathUtils.clamp(ex, lim.x_min * D, lim.x_max * D);
          if (typeof lim.y_min === 'number' && typeof lim.y_max === 'number') ey = THREE.MathUtils.clamp(ey, lim.y_min * D, lim.y_max * D);
          if (typeof lim.z_min === 'number' && typeof lim.z_max === 'number') ez = THREE.MathUtils.clamp(ez, lim.z_min * D, lim.z_max * D);
        }
      }
      if (ex || ey || ez) b.quaternion.multiply(quatFromEuler({ x: ex, y: ey, z: ez }));
    }
    return true;
  }

  // 身体中线参考点（用于判断某骨骼在左还是右、向外方向）
  function bodyCenter() {
    const c = bone('root') || bone('lowerBody');
    if (c) { const v = new THREE.Vector3(); c.getWorldPosition(v); return v; }
    return new THREE.Vector3(0, 0, 0);
  }

  // 取某骨骼相对身体中线的「向外」水平方向（按骨骼世界 X 位置判断左右），手臂外展等用它保证不偏。
  function outwardDir(name) {
    const b = bone(name);
    const c = bodyCenter();
    if (!b) return new THREE.Vector3(1, 0, 0);
    const p = new THREE.Vector3(); b.getWorldPosition(p);
    const dir = new THREE.Vector3(p.x - c.x, 0, p.z - c.z);
    if (dir.lengthSq() < 1e-6) dir.set(1, 0, 0);
    return dir.normalize();
  }

  // 模型无关：把某骨骼「指向其直接子骨骼」的世界方向，对齐到目标世界方向（姿态相对静止基线叠加）。
  // 用于招手/叉腰/思考/害羞等手臂动作，保证关节落在人体正常位置，而不依赖各模型不同的局部轴向约定。
  // 与 dropArmToSide 同一思路：在世界空间求"当前子骨方向→目标方向"的旋转，再转到父骨局部左乘到基线。
  // 注意：若在同一个 run() 里先摆好父骨再摆子骨，子骨会相对"已摆好的父骨"计算，链路连贯（肩→大臂→小臂）。
  function poseBoneAim(name, worldDir) {
    const b = bone(name);
    if (!b || !b.parent || !skeleton) return false;
    const child = findAimRef(b); // 取真正的肢体段末端（跳过共位扭骨），保证瞄准方向正确
    if (!child) return false;
    const base = baseQuats[b.name] || boneRest[b.name];
    if (!base) return false;

    const target = new THREE.Vector3(worldDir.x, worldDir.y, worldDir.z).normalize();
    // 先在该骨骼静止基线上，看「父已摆好 + 本骨中性」时子骨骼指向（相对已摆父骨，保证链路连贯）
    b.quaternion.copy(base);
    mesh.updateMatrixWorld(true);
    const bPos = new THREE.Vector3(), cPos = new THREE.Vector3();
    b.getWorldPosition(bPos); child.getWorldPosition(cPos);
    const currentDir = cPos.clone().sub(bPos).normalize();

    if (currentDir.dot(target) > 0.985) { b.quaternion.copy(base); return true; }
    if (currentDir.dot(target) < -0.985) { b.quaternion.copy(base); return true; }

    // 世界空间：从当前子骨方向转到目标方向
    const corr = new THREE.Quaternion().setFromUnitVectors(currentDir, target);
    // 把世界旋转转换到父骨骼局部坐标系后左乘到基线
    const pqw = new THREE.Quaternion(); b.parent.getWorldQuaternion(pqw);
    const pinv = pqw.clone().invert();
    corr.premultiply(pinv).multiply(pqw);
    b.quaternion.copy(base).premultiply(corr);
    return true;
  }

  // 在绑定姿态上叠加一个小旋转（用于 applyRelax 在自然站姿与绑定姿态间取差）
  function relaxBone(name, euler) {
    const b = bone(name);
    if (!b) return;
    const r = boneRest[b.name];
    if (r) b.quaternion.copy(r);
    else b.rotation.set(0, 0, 0);
    if (euler && (euler.x || euler.y || euler.z)) b.quaternion.multiply(quatFromEuler(euler));
  }

  // 把单条上臂（左/右）自然垂落到身体一侧：模型无关。
  // 原理：读出该骨骼"指向"（局部 +Y）的世界朝向，与"垂直向下"做最短弧旋转，
  // 再把该世界旋转表达到父骨骼局部坐标系后左乘到局部四元数 —— net 效果即上臂世界朝向变为垂直向下。
  // 这样无论模型自带的是 T pose（手臂水平）还是 A pose（手臂外偏 ~45°），载入后都会垂到身侧，
  // 得到"正常人类站立"的中性姿态，而不是手臂外偏的别扭站姿。
  const _armDown = new THREE.Vector3(0, -1, 0);
  const _armTarget = new THREE.Vector3();
  const _armDir = new THREE.Vector3();
  const _armQW = new THREE.Quaternion();
  const _armPQW = new THREE.Quaternion();
  const _armCorr = new THREE.Quaternion();
  const _armPInv = new THREE.Quaternion();
  const _vArm = new THREE.Vector3();
  const _vChild = new THREE.Vector3();

  // 用子骨骼（肘/腕）的世界位置差来检测真实臂方向，不依赖「局部+Y沿臂」的假设。
  // 很多 MMD 模型（尤其 Genshin Impact）的臂骨局部轴向约定不同，假设 (0,1,0) 沿臂方向会完全失效。
  function dropArmToSide(name) {
    const arm = bone(name);
    if (!arm || !arm.parent || !skeleton) return;
    // 用真正的肢体末端（跳过共位扭骨 腕捩 等）确定"臂指向"，保证方向正确
    const childBone = findAimRef(arm);
    if (!childBone) return; // 无后代则无法判断方向，跳过

    mesh.updateMatrixWorld(true);
    arm.getWorldPosition(_vArm);
    childBone.getWorldPosition(_vChild);

    // 当前臂方向：从肩/上臂指向肢体末端
    const currentDir = _vChild.clone().sub(_vArm).normalize();
    // 向外方向由骨骼真实世界位置决定（模型无关，MMD 左=+X、右=-X 同样适用）：
    // 取「上臂相对身体中线的水平符号」，让左右臂各自朝外，绝不越过身体中线交叉到对侧。
    const cc = bodyCenter();
    const outSign = (_vArm.x - cc.x) >= 0 ? 1 : -1;
    const targetDir = _armTarget.set(outSign * 0.55, -1.0, 0.20).normalize();

    // 已经基本向下 → 跳过
    if (currentDir.dot(targetDir) > 0.95) return;
    // 臂几乎朝上 → 不强转，避免异常翻转
    if (currentDir.dot(targetDir) < -0.85) return;

    // 世界空间：从当前方向转到自然垂落方向
    _armCorr.setFromUnitVectors(currentDir, targetDir);
    // 把世界旋转转换到父骨骼局部坐标系后左乘
    arm.parent.getWorldQuaternion(_armPQW);
    _armPInv.copy(_armPQW).invert();
    _armCorr.premultiply(_armPInv).multiply(_armPQW);
    arm.quaternion.premultiply(_armCorr);
  }
  function dropArmsToSides() {
    if (!mesh) return;
    mesh.updateMatrixWorld(true);
    dropArmToSide('lArm');
    dropArmToSide('rArm');
  }

  // 检测某骨骼的「自然弯曲轴 + 自然折叠方向」，用于蹲/坐/跳等需要真正折关节的动作。
  // 旧版用 cross(肢干方向, 关节指向)：直肢（休息态）时两段共线，叉积≈0 → 永远退化成硬编码 'x'，
  // 而本模型骨骼局部坐标系是旋转的，绕局部 X 并不能弯折该关节，于是蹲/坐/跳的腿"完全不动"。
  // 新版：用「肢干方向 × 模型前方向(0,0,-1)」得到世界空间的弯折轴（直立人形即左右轴 X，
  // 对直肢也稳定不为零），再转到骨骼局部取主成分轴；最后 ±0.3rad 试探，取「使关节夹角增大
  // （自然折叠）」的符号。结果缓存，避免每帧重算。
  const _bendCache = {};
  function detectBend(boneName) {
    if (_bendCache[boneName]) return _bendCache[boneName];
    const b = bone(boneName);
    if (!b || !b.parent || !skeleton) { const r = { axis: 'x', sign: 1 }; _bendCache[boneName] = r; return r; }
    const child = findAimRef(b); // 取真正肢体末端（跳过共位扭骨），避免弯曲轴误判
    if (!child) { const r = { axis: 'x', sign: 1 }; _bendCache[boneName] = r; return r; }

    mesh.updateMatrixWorld(true);
    const pPos = new THREE.Vector3(), bPos = new THREE.Vector3(), cPos = new THREE.Vector3();
    b.parent.getWorldPosition(pPos); b.getWorldPosition(bPos); child.getWorldPosition(cPos);
    const limbDir = bPos.clone().sub(pPos).normalize();           // 父→本骨（肢干方向）
    const forward = new THREE.Vector3(0, 0, -1);                  // 模型前方向（MMD 惯例 -Z）
    let bendWorld = new THREE.Vector3().crossVectors(limbDir, forward);
    if (bendWorld.lengthSq() < 1e-4) bendWorld.set(1, 0, 0);      // 退路：左右轴
    bendWorld.normalize();

    // 世界弯折轴 → 骨骼局部坐标，取最接近的主轴（x/y/z）
    const invQ = b.quaternion.clone().invert();
    const localAxis = bendWorld.clone().applyQuaternion(invQ);
    const ax = Math.abs(localAxis.x), ay = Math.abs(localAxis.y), az = Math.abs(localAxis.z);
    let axis = 'x'; let maxV = ax;
    if (ay > maxV) { maxV = ay; axis = 'y'; }
    if (az > maxV) { maxV = az; axis = 'z'; }

    // 试探 ±0.3rad，找「使关节夹角增大」的符号（自然折叠方向）
    const axisVec = axis === 'x' ? new THREE.Vector3(1, 0, 0)
                  : axis === 'y' ? new THREE.Vector3(0, 1, 0)
                  : new THREE.Vector3(0, 0, 1);
    const segAngle = () => {
      const bp = new THREE.Vector3(), cp = new THREE.Vector3();
      b.getWorldPosition(bp); child.getWorldPosition(cp);
      const v1 = bp.clone().sub(pPos).normalize();
      const v2 = cp.clone().sub(bp).normalize();
      return Math.acos(Math.max(-1, Math.min(1, v1.dot(v2))));
    };
    const restA = segAngle();
    const origQ = b.quaternion.clone();
    b.quaternion.copy(origQ).multiply(new THREE.Quaternion().setFromAxisAngle(axisVec, 0.3));
    mesh.updateMatrixWorld(true); const aPlus = segAngle();
    b.quaternion.copy(origQ).multiply(new THREE.Quaternion().setFromAxisAngle(axisVec, -0.3));
    mesh.updateMatrixWorld(true); const aMinus = segAngle();
    b.quaternion.copy(origQ); mesh.updateMatrixWorld(true);

    let sign = 1;
    if (aPlus > restA && aPlus >= aMinus) sign = 1;
    else if (aMinus > restA) sign = -1;
    const r = { axis, sign };
    _bendCache[boneName] = r;
    return r;
  }
  // 兼容旧调用：只取弯曲轴
  function detectBendAxis(boneName) { return detectBend(boneName).axis; }

  // ===== 模型无关的"真实折腿"系统（修复"膝盖不弯 / 只整体上下平移"）=====
  // 旧版 squat/jump/sit 用 detectBend 检测到的"局部弯曲轴"去旋转腿骨。但本模型腿骨局部坐标系
  // 是旋转的（PMX 里 leg 骨带 localXVector/localZVector），detectBend 从"父→本骨"方向叉乘前方向
  // 得到的世界折轴是斜的，转到局部后取到的是"绕腿长方向的扭转轴"，于是大腿只是拧了一下、膝根本不折。
  // 改用 poseBoneAim（已在手臂上验证可靠）：直接把每一节"子骨"在世界空间指向一个随折叠量插值的方向，
  // 折关节在世界空间完成，再转回局部，完全不依赖腿骨局部轴向约定 —— 髋前送、膝回折、踝贴地，真实蹲跳。
  const DOWN = new THREE.Vector3(0, -1, 0);
  const _legForward = new THREE.Vector3(0, 0, 1); // 模型前方向（水平，由脚尖方向算出，模型无关）
  const _vFold = new THREE.Vector3();
  const _vFoldFull = new THREE.Vector3();

  // 载入/松弛时算一次模型前方向 = 脚尖相对脚踝的水平方向（站姿即可，脚尖朝前=模型正面）
  function computeLegFrame() {
    const la = bone('lAnkle');
    let f = null;
    if (la && skeleton) {
      let toe = null;
      for (const sb of skeleton.bones) { if (sb.parent === la) { toe = sb; break; } }
      if (toe) {
        const ap = new THREE.Vector3(), tp = new THREE.Vector3();
        la.getWorldPosition(ap); toe.getWorldPosition(tp);
        f = tp.sub(ap); f.y = 0;
        if (f.lengthSq() > 1e-6) f.normalize();
      }
    }
    if (f) _legForward.copy(f); else _legForward.set(0, 0, 1);
  }

  // 折叠一节腿骨：fwdSign=+1 让该节"向前下方"送（髋），fwdSign=-1 让"向后下方"折（膝/胫）。
  // gain 控制前/后送的强度；amt∈[0,1] 从"垂直向下(直腿)"插值到目标方向。世界空间完成，模型无关。
  function foldLeg(name, fwdSign, gain, amt) {
    if (amt <= 0) { poseBoneFromRest(name, null); return; }
    _vFoldFull.copy(DOWN).addScaledVector(_legForward, fwdSign * gain);
    _vFold.lerpVectors(DOWN, _vFoldFull, amt).normalize();
    poseBoneAim(name, _vFold);
  }

  // 踝部补偿：把脚掌在世界空间压到"前平"方向（脚尖朝前、略向下），避免折腿后脚尖扎地/朝天。
  function flatFoot(name, amt) {
    if (amt <= 0.02) { poseBoneFromRest(name, null); return; }
    _vFold.copy(_legForward).multiplyScalar(1.0).addScaledVector(DOWN, 0.22).normalize();
    poseBoneAim(name, _vFold);
  }

  // 旋转动作用的"踏步"：身体偏航的同时，双脚交替抬起/落地、膝盖微屈、重心左右微摆、随步轻微起伏，
  // 让"转圈/转身"不再只是整体漂浮自旋，而是有脚步支撑的真实转身。
  // u∈[0,1] 进度；spinRad 本次旋转总弧度（决定踏步频率，约每半圈一步）；
  // base 为动作起始根变换（含 base.y 站立高度）；h 为模型身高（按身高等比缩放脚步幅度）。
  function applyTurnFootwork(u, spinRad, base, h) {
    if (!skeleton) return;
    const steps = Math.max(1e-3, spinRad) / Math.PI;       // 步数：每转 π（半圈）一步，整圈 2 步
    const ph = u * steps * Math.PI * 2;                    // 踏步相位
    const s = Math.sin(ph);
    const liftL = Math.max(0, s);                          // 左脚抬起量（相位前半）
    const liftR = Math.max(0, -s);                         // 右脚抬起量（相位后半）
    // 抬起的一侧：屈髋上提 + 屈膝回折 + 脚掌压平（脚离地），落地一侧保持伸直支撑
    foldLeg('lLeg', 1, 0.5, liftL * 0.6);
    foldLeg('lKnee', -1, 0.6, liftL * 0.9);
    flatFoot('lAnkle', liftL);
    foldLeg('rLeg', 1, 0.5, liftR * 0.6);
    foldLeg('rKnee', -1, 0.6, liftR * 0.9);
    flatFoot('rAnkle', liftR);
    // 重心移到"支撑脚"一侧（抬起侧卸力）：lowerBody 朝支撑脚轻微侧倾
    poseBoneFromRest('lowerBody', { z: (liftL - liftR) * 0.12 });
    // 随踏步轻微上下起伏（两脚踏实时最低、抬脚时略高）
    mesh.position.y = base.y + (liftL + liftR) * h * 0.012;
  }

  // 自然放松站姿：先复位到绑定姿态，做小幅放松，再把双臂垂落身侧，检测关节弯曲轴，最后烘焙为静止基线。
  // 解决"默认手臂外偏 ~45°（肩偏腿），导致整体偏姿态、无法呈现正常人类站姿，且所有动作都建在偏姿态上"的问题。
  function applyRelax() {
    if (!skeleton) return;
    for (const b of Object.values(bones)) { // 含组合模型部件骨骼
      const r = boneRest[b.name];
      if (r) b.quaternion.copy(r);
    }
    relaxBone('lShoulder', { z: 0.12, x: 0.05 });
    relaxBone('rShoulder', { z: -0.12, x: -0.05 });
    relaxBone('lArm', { x: 0.08 });
    relaxBone('rArm', { x: -0.08 });
    relaxBone('upperBody2', { x: 0.05 });
    dropArmsToSides(); // 模型无关：把双臂对齐到垂直向下（自然站立）
    computeLegFrame(); // 算模型前方向（脚尖→脚踝水平），供折腿动作模型无关地折关节
    // 预检测腿/膝/踝的弯曲轴（供蹲下等弯折关节的动作使用，避免硬编码 X 轴在不同模型上失效）
    for (const k of ['lLeg','rLeg','lKnee','rKnee','lAnkle','rAnkle']) detectBendAxis(k);
    // 记录为新的静止基线（动作结束后回到这里）
    for (const b of Object.values(bones)) { // 含组合模型部件骨骼
      const base = baseQuats[b.name];
      if (base) base.copy(b.quaternion);
    }
    for (const k in aimRefCache) delete aimRefCache[k]; // 换模型清空瞄准参考缓存
  }

  // 取某骨骼的「瞄准参考骨」：用于 poseBoneAim 在世界空间把该骨指向目标方向。
  // 默认取最远的直接子骨；若最远直接子骨是几乎与关节共位的扭骨（腕捩等），
  // 则其真正的肢体段在后代里，回退到「距关节最远的后代骨」作为参考（跳过共位扭骨）。
  function findAimRef(b) {
    if (!b || !skeleton) return null;
    if (aimRefCache[b.name] !== undefined) return aimRefCache[b.name]; // 含 null
    mesh.updateMatrixWorld(true);
    const head = new THREE.Vector3(); b.getWorldPosition(head);
    const direct = (b.children || []).filter((c) => c.isBone);
    let best = null, bestD = -1;
    for (const c of direct) {
      const p = new THREE.Vector3(); c.getWorldPosition(p);
      const d = p.distanceToSquared(head);
      if (d > bestD) { bestD = d; best = c; }
    }
    // 该骨自身长度（到父骨距离）作为尺度参考，判定 direct 子骨是否「共位扭骨」
    let selfLen = 1;
    if (b.parent && b.parent.isBone) {
      const pp = new THREE.Vector3(); b.parent.getWorldPosition(pp);
      selfLen = Math.max(1e-3, pp.distanceTo(head));
    }
    if (best && TWIST_RE.test(best.name) && bestD < selfLen * 0.15) {
      // 回退：在整条后代里找距关节最远的骨（真正的肢体末端，如指尖/脚尖）
      let bd = bestD;
      const stack = [...b.children]; const seen = new Set([b]);
      while (stack.length) {
        const c = stack.pop();
        if (!c.isBone || seen.has(c)) continue;
        seen.add(c);
        const p = new THREE.Vector3(); c.getWorldPosition(p);
        const d = p.distanceToSquared(head);
        if (d > bd) { bd = d; best = c; }
        for (const g of c.children) stack.push(g);
      }
    }
    aimRefCache[b.name] = best;
    return best;
  }

  // 把所有骨骼复位到静止基线（动作结束时调用，避免关节停在动作末态）
  function resetAllBones() {
    if (!skeleton) return;
    for (const b of Object.values(bones)) { // 含组合模型部件骨骼
      const base = baseQuats[b.name];
      if (base) b.quaternion.copy(base);
    }
  }

  // 构建参与呼吸的骨骼集合（取模型实际存在的骨骼名；默认上半身/上半身2）
  function buildBreathBoneSet() {
    breathBoneSet.clear();
    const names = (modelConfig.breath && Array.isArray(modelConfig.breath.bones))
      ? modelConfig.breath.bones
      : ['上半身', '上半身2'];
    for (const n of names) {
      const b = bone(n);
      if (b) breathBoneSet.add(b.name);
    }
  }

  // 模块1：生成 pet_model_config.json 内容（不写文件，由调用方持久化/合并）。
  // 包含：bindpose_check（四肢外展角检测）、rest_correction（运行时已应用的姿态修正量快照）、
  // bone_limit（骨骼约束预设 + 关键词骨骼）、breath（呼吸默认）。
  function generateModelConfig() {
    const cfg = {
      model_name: currentPmxName || 'model',
      bindpose_check: { need_runtime_correction: false },
      rest_correction: {},
      bone_limit: {},
      breath: { enable: true, bones: ['上半身', '上半身2'], amp_deg: BREATH_AMP_DEG, period_sec: BREATH_PERIOD },
      hair_physics: { enable: true, stiffness: 55, damping: 7, max_deg: 14, sensitivity: 22 }
    };
    if (!skeleton) return cfg;
    // rest_correction：每骨 relaxedBase 相对 bind 的欧拉增量（度），即运行时姿态校正已应用的量
    for (const b of Object.values(bones)) { // 含组合模型部件骨骼
      const bindQ = boneRest[b.name], baseQ = baseQuats[b.name];
      if (!bindQ || !baseQ) continue;
      const dq = baseQ.clone().multiply(bindQ.clone().invert());
      const e = new THREE.Euler().setFromQuaternion(dq, 'XYZ');
      const deg = { x: rad2deg(e.x), y: rad2deg(e.y), z: rad2deg(e.z) };
      if (Math.abs(deg.x) > 0.5 || Math.abs(deg.y) > 0.5 || Math.abs(deg.z) > 0.5) {
        cfg.rest_correction[b.name] = { x: _r2(deg.x), y: _r2(deg.y), z: _r2(deg.z) };
      }
    }
    // bindpose_check：四肢外展角（来自 rest_correction 幅度），超阈值标记需校正
    const limbDefs = [
      { ln: 'lArm', thr: 45 }, { ln: 'rArm', thr: 45 },
      { ln: 'lLeg', thr: 50 }, { ln: 'rLeg', thr: 50 },
      { ln: 'lShoulder', thr: 45 }, { ln: 'rShoulder', thr: 45 }
    ];
    for (const d of limbDefs) {
      const b = bone(d.ln); if (!b) continue;
      const rc = cfg.rest_correction[b.name]; if (!rc) continue;
      const ang = Math.max(Math.abs(rc.x), Math.abs(rc.y), Math.abs(rc.z));
      cfg.bindpose_check[d.ln + '_angle'] = _r1(ang);
      if (ang > d.thr) cfg.bindpose_check.need_runtime_correction = true;
    }
    // bone_limit：预设表（存在即加，逻辑名 + 实际名双写）+ 关键词骨骼（尾/触/爪…）
    for (const ln in BONE_LIMIT_PRESET) {
      const b = bone(ln); if (!b) continue;
      const lim = BONE_LIMIT_PRESET[ln];
      cfg.bone_limit[ln] = lim;
      if (b.name !== ln) cfg.bone_limit[b.name] = lim;
    }
    for (const b of Object.values(bones)) { // 含组合模型部件骨骼
      for (const kw of BONE_LIMIT_KEYWORD) {
        if (kw.re.test(b.name) && !cfg.bone_limit[b.name]) cfg.bone_limit[b.name] = kw.lim;
      }
    }
    return cfg;
  }

  function getModelConfig() { return modelConfig; }

  // 模块1 资产配置入口：bone_limit（角度钳制）/ breath（呼吸配置）。未提供时降级为默认。
  function setModelConfig(cfg) {
    modelConfig = (cfg && typeof cfg === 'object') ? cfg : {};
    buildBreathBoneSet();
    applyHairConfig();
    aiWeight = 0;
  }

  // 模块3：把 modelConfig.hair_physics 应用到毛发次级动力学参数（缺省降级默认）。
  function applyHairConfig() {
    const h = modelConfig.hair_physics;
    if (!h || typeof h !== 'object') return;
    if (typeof h.enable === 'boolean') hairEnabled = h.enable;
    if (typeof h.stiffness === 'number') hairStiffness = h.stiffness;
    if (typeof h.damping === 'number') hairDamping = h.damping;
    if (typeof h.max_deg === 'number') hairMaxDeg = h.max_deg;
    if (typeof h.sensitivity === 'number') hairSensitivity = h.sensitivity;
  }

  // 对外 API：运行时覆盖毛发次级动力学参数（模块5 编辑面板实时调参用）。
  function setHairPhysics(h) {
    if (!h || typeof h !== 'object') return;
    if (typeof h.enable === 'boolean') hairEnabled = h.enable;
    if (typeof h.stiffness === 'number') hairStiffness = h.stiffness;
    if (typeof h.damping === 'number') hairDamping = h.damping;
    if (typeof h.max_deg === 'number') hairMaxDeg = h.max_deg;
    if (typeof h.sensitivity === 'number') hairSensitivity = h.sensitivity;
  }

  // ===== 分层动作融合后处理（每帧调用一次）=====
  // 设计：L0 校正 rest（已在 resetAllBones 中落到骨骼）+ L2 AI 动作层（当前帧动作姿态，逐骨 Slerp
  // 平滑趋近，既消除硬切跳变，又实现 Layer2 权重 0→1/1→0 过渡）+ L1 呼吸层（仅呼吸骨骼叠加正弦小旋转，
  // 权重随 AI 动作衰减：AI 大幅动作时呼吸几乎消失）。L3 毛发次级动力学（模块3）在 applyLayerBlend 之后叠加。
  function applyLayerBlend(dt) {
    if (!skeleton) return;
    // AI 动作层权重跟踪（activeAction 或 AI 剪辑存在→1，结束后→0）
    const aiTarget = (activeAction || aiClipActive) ? 1 : 0;
    aiWeight += (aiTarget - aiWeight) * (1 - Math.exp(-dt / AI_TAU));
    // 呼吸配置（可被 modelConfig.breath 覆盖）
    const breathCfg = modelConfig.breath || {};
    const ampDeg = (typeof breathCfg.amp_deg === 'number') ? breathCfg.amp_deg : BREATH_AMP_DEG;
    const period = (typeof breathCfg.period_sec === 'number') ? breathCfg.period_sec : BREATH_PERIOD;
    const breathOn = breathCfg.enable !== false && breathBoneSet.size > 0;
    // L1 呼吸权重 = 待机权重 × (1 - 0.8 × AI 权重)：AI 动作时自动压低呼吸，避免两个动作打架乱抖
    const w1 = BASE_IDLE * (1 - 0.8 * aiWeight);
    const ampRad = THREE.MathUtils.degToRad(ampDeg) * w1;
    const aAction = 1 - Math.exp(-dt / ACTION_TAU); // 动作层平滑系数
    const sinv = Math.sin(elapsed * (2 * Math.PI / period)) * ampRad;
    for (const b of skeleton.bones) {
      const name = b.name;
      let prev = prevPose[name];
      if (!prev) { prev = b.quaternion.clone(); prevPose[name] = prev; }
      // L2：当前帧动作姿态（= resetAllBones 后的 base，或 base+动作 delta）平滑趋近 prev
      const smoothed = prev.clone().slerp(b.quaternion, aAction);
      prevPose[name] = smoothed;
      // L1：仅呼吸骨骼叠加正弦小旋转（不写回 prevPose，避免逐帧累积）
      if (breathOn && breathBoneSet.has(name) && Math.abs(sinv) > 1e-7) {
        _breathQ.setFromAxisAngle(BREATH_AXIS, sinv);
        b.quaternion.copy(smoothed).multiply(_breathQ);
      } else {
        b.quaternion.copy(smoothed);
      }
    }
  }

  // 模块3：毛发/软组织次级动力学（Layer3）。在 applyLayerBlend 已写好的姿态之上叠加「滞后弹簧」摆动，
  // 仅渲染用（不写回 prevPose，避免逐帧累积反馈）。驱动源 = 父骨本帧局部角速度（头/身转动时毛发滞后）。
  // aiWeight 高（AI 大幅动作）时压低灵敏度（AI 动作阻尼），避免甩飞乱抖。
  function applyHairDynamics(dt) {
    if (!hairEnabled || hairBones.length === 0 || dt <= 0) return;
    const maxR = THREE.MathUtils.degToRad(hairMaxDeg);
    const inputScale = 1 - 0.6 * aiWeight;          // AI 动作阻尼
    const sens = hairSensitivity * inputScale;
    for (const h of hairBones) {
      const cur = h.parent ? h.parent.quaternion : _aiIdentQ;
      if (!h.parentPrevQ) h.parentPrevQ = cur.clone();
      // 父骨本帧局部角速度：dq = cur * parentPrevQ^-1 → 欧拉（小角近似）
      _hairTmpQ.copy(cur).multiply(h.parentPrevQ.clone().invert());
      _hairEuler.setFromQuaternion(_hairTmpQ, 'XYZ');
      // 弹簧-阻尼积分（每轴）：a = -k·off - c·vel + sens·(父骨角速度)
      const fx = -hairStiffness * h.off.x - hairDamping * h.vel.x + sens * _hairEuler.x;
      const fy = -hairStiffness * h.off.y - hairDamping * h.vel.y + sens * _hairEuler.y;
      const fz = -hairStiffness * h.off.z - hairDamping * h.vel.z + sens * _hairEuler.z;
      h.vel.x += fx * dt; h.off.x += h.vel.x * dt;
      h.vel.y += fy * dt; h.off.y += h.vel.y * dt;
      h.vel.z += fz * dt; h.off.z += h.vel.z * dt;
      // 钳制单轴最大偏移，防甩飞
      h.off.x = THREE.MathUtils.clamp(h.off.x, -maxR, maxR);
      h.off.y = THREE.MathUtils.clamp(h.off.y, -maxR, maxR);
      h.off.z = THREE.MathUtils.clamp(h.off.z, -maxR, maxR);
      h.parentPrevQ.copy(cur);
      // 应用到骨骼：在已混合姿态上叠加（渲染即时效果）
      if (h.off.x || h.off.y || h.off.z) {
        h.b.quaternion.multiply(quatFromEuler({ x: h.off.x, y: h.off.y, z: h.off.z }));
      }
    }
  }

  // 对外 API：手动摆某个关节（相对于静止基线叠加旋转，单位弧度）。供调试 / AI 微调姿态。
  // 例：mmdPet.poseBone('右腕', { z: 0.5 }) 让右手腕额外绕 Z 轴转 0.5 弧度。
  // 注意：这是"相对静止基线"的叠加，调用一次后会保持该姿态直到 resetBones() 或下一个动作开始。
  // 走钳制（clampIt=true）：AI/调试输出越界角度时按 bone_limit 截断，防穿模。
  function poseBone(name, euler) {
    return poseBoneFromRest(name, euler, true);
  }

  // 对外 API：把所有关节复位到静止基线（自然放松站姿）。
  function resetBones() {
    resetAllBones();
  }

  // 对外 API：列出模型全部骨骼名（用于发现可用关节名，便于精确指定，例如 '右腕'/'左ひじ'）。
  function listBones() {
    if (!skeleton) return [];
    return skeleton.bones.map((b) => b.name);
  }

  // 调试：列出 BONE_KEYS 每个逻辑键在当前模型上实际命中的骨骼名（null=未命中）。
  // 用于确认下半身/左足等键是否解析到正确骨骼（非标准命名模型可能全 null）。
  function listBoneKeys() {
    const out = {};
    if (!skeleton) return out;
    for (const ln in BONE_KEYS) {
      const arr = BONE_KEYS[ln];
      let hit = null;
      if (Array.isArray(arr)) {
        for (const k of arr) {
          if (bones[k]) { hit = k; break; }
        }
      }
      out[ln] = hit;
    }
    return out;
  }

  // 调试：返回本次加载以来累计未命中的骨骼键及次数（key -> count）。
  // 注意：key 可能是逻辑键（如 'lowerBody'）或被直接传入的实际骨名（如 '下半身'）。
  function getMissingBones() {
    const out = {};
    for (const [k, c] of _missedBones) out[k] = c;
    return out;
  }

  // 调试：返回完整骨骼映射 + 未命中统计：keyname -> { bone_name, miss_count }
  // bone_name 为逻辑键解析到的实际骨骼名（null=未命中）；miss_count 为该键或其别名累计未命中次数。
  function getBoneMapDebug() {
    const out = {};
    const keys = listBoneKeys();
    for (const ln in BONE_KEYS) {
      out[ln] = { bone_name: keys[ln], miss_count: 0 };
    }
    for (const [k, c] of _missedBones) {
      if (out[k]) out[k].miss_count = c;              // k 本身就是逻辑键
      else {
        const ln = _logicalOf(k);                    // k 是实际骨名，反查逻辑键
        if (ln && out[ln]) out[ln].miss_count = c;
      }
    }
    return out;
  }

  // ===== 模块4：AI 骨骼偏移关键帧（骨骼 AI 动作层 / Layer2）=====
  // 输入格式（AI 产出，单位：度，相对静止基线 rest 的偏移）：
  // {
  //   duration: 1.2,                              // 秒
  //   keyframes: [
  //     { t: 0.0, bones: { "右腕": {x:10, z:5} } },
  //     { t: 0.6, bones: { "右腕": {x:35, z:20} } },
  //     { t: 1.0, bones: { "右腕": {x:0,  z:0}  } }
  //   ]
  // }
  // t 可为 0~1 归一化，也可为秒（任一 >1 视为秒，按 duration 归一）。骨骼名可用逻辑名（右腕）或实际名。
  // 解析后：每关键帧每骨预计算「偏移四元数」并按 bone_limit 钳制；逐帧对偏移四元数 slerp（四元数插值，无万向锁），
  // 再乘到静止基线 baseQuats 得绝对目标，喂入 Layer2（applyLayerBlend 做 Slerp 平滑 + 权重过渡）。

  // 把单个偏移（度）按 bone_limit 钳制，返回弧度 {x,y,z}；无 limit 则原样转弧度。
  function _clampOffsetRad(actualName, off) {
    const lim = modelConfig.bone_limit && (modelConfig.bone_limit[actualName] || modelConfig.bone_limit[_logicalOf(actualName)]);
    const D = Math.PI / 180;
    let rx = (off.x || 0) * D, ry = (off.y || 0) * D, rz = (off.z || 0) * D;
    if (lim) {
      // 需 min/max 同时有值才钳制，避免单侧缺失 clamp(…, undefined) 变 NaN
      if (typeof lim.x_min === 'number' && typeof lim.x_max === 'number') rx = THREE.MathUtils.clamp(rx, lim.x_min * D, lim.x_max * D);
      if (typeof lim.y_min === 'number' && typeof lim.y_max === 'number') ry = THREE.MathUtils.clamp(ry, lim.y_min * D, lim.y_max * D);
      if (typeof lim.z_min === 'number' && typeof lim.z_max === 'number') rz = THREE.MathUtils.clamp(rz, lim.z_min * D, lim.z_max * D);
    }
    return { x: rx, y: ry, z: rz };
  }

  // 实际骨名 → 逻辑名（用于关键帧里写逻辑名时回查 bone_limit）。遍历 BONE_KEYS 候选。
  function _logicalOf(actualName) {
    for (const ln in BONE_KEYS) {
      const arr = BONE_KEYS[ln];
      if (Array.isArray(arr) && arr.indexOf(actualName) >= 0) return ln;
    }
    return null;
  }

  // 解析 + 归一化 AI 剪辑。raw: 对象或 JSON 字符串。成功返回 clip，失败（含无有效骨骼）返回 null → 调用方走意图兜底。
  function _buildAIPoseClip(raw) {
    let obj = raw;
    if (typeof raw === 'string') {
      try { obj = JSON.parse(raw); } catch (e) { return null; }
    }
    if (!obj || typeof obj !== 'object') return null;
    const kfs = Array.isArray(obj.keyframes) ? obj.keyframes
              : Array.isArray(obj.frames) ? obj.frames
              : null;
    if (!kfs || !kfs.length) return null;

    // 收集所有可解析骨骼（实际名）+ 原始 key 映射 + 判断 t 单位
    const union = new Set();
    const actualToRaw = {};
    let maxRawT = 0;
    for (const kf of kfs) {
      const bs = kf.bones || {};
      for (const bn in bs) {
        const b = bone(bn);
        if (b) { union.add(b.name); actualToRaw[b.name] = bn; }
      }
      const t = (typeof kf.t === 'number') ? kf.t : (typeof kf.time === 'number' ? kf.time : 0);
      if (t > maxRawT) maxRawT = t;
    }
    if (union.size === 0) return null; // 没有任何可解析骨骼 → 交给意图兜底

    const inSeconds = maxRawT > 1.0001;
    let dur = (typeof obj.duration === 'number' && obj.duration > 0) ? obj.duration
            : (typeof obj.dur === 'number' && obj.dur > 0 ? obj.dur : 0);
    const norm = inSeconds ? (dur > 0 ? dur : maxRawT) : 1;
    if (inSeconds && !(dur > 0)) dur = maxRawT; // 未给 duration 时以最大 t 为时长
    if (!(dur > 0)) dur = 1;

    const frames = kfs.map((kf) => {
      const rawT = (typeof kf.t === 'number') ? kf.t : (typeof kf.time === 'number' ? kf.time : 0);
      const t = THREE.MathUtils.clamp(rawT / norm, 0, 1);
      const quats = {};
      const bs = kf.bones || {};
      for (const name of union) {
        const src = bs[name] || (actualToRaw[name] ? bs[actualToRaw[name]] : null);
        if (src && typeof src === 'object') {
          const off = _clampOffsetRad(name, src);
          quats[name] = quatFromEuler(off);
        } else {
          quats[name] = _aiIdentQ.clone(); // 缺失 = 保持 rest
        }
      }
      return { t, quats };
    }).sort((a, b) => a.t - b.t);

    // 去重相同 t（取后者）
    const dedup = [];
    for (const f of frames) {
      const last = dedup[dedup.length - 1];
      if (last && Math.abs(last.t - f.t) < 1e-4) dedup[dedup.length - 1] = f;
      else dedup.push(f);
    }
    return { dur, frames: dedup, bones: union };
  }

  // 播放 AI 剪辑；返回 true=已播放，false=解析失败（调用方应走意图兜底）。
  function playAIPose(raw) {
    if (!mesh) return false;
    const clip = _buildAIPoseClip(raw);
    if (!clip) return false;
    aiClip = clip;
    aiClipStart = elapsed;
    aiClipActive = true;
    aiWeight = 0; // 权重从 0 平滑爬升，避免进入时跳变
    console.log('[MMD][AI] playAIPose 激活：', clip.frames.length, '关键帧 /', clip.bones.size, '骨骼 /', clip.dur.toFixed(2), 's');
    return true;
  }

  // 停止 AI 剪辑（权重随 AI_TAU 平滑回落，回到静止/动作）。
  function stopAIPose() {
    aiClipActive = false;
    aiClip = null;
  }

  // 给定归一化进度 u∈[0,1]，把当前帧每骨「偏移四元数」slerp 出来，乘到静止基线，写入骨骼。
  function applyAIPoseAt(u) {
    if (!aiClip) return;
    const frames = aiClip.frames;
    let i0 = 0, i1 = frames.length - 1;
    if (u <= frames[0].t) { i0 = i1 = 0; }
    else if (u >= frames[frames.length - 1].t) { i0 = i1 = frames.length - 1; }
    else {
      for (let i = 0; i < frames.length - 1; i++) {
        if (u >= frames[i].t && u <= frames[i + 1].t) { i0 = i; i1 = i + 1; break; }
      }
    }
    const a = (i1 === i0) ? 0
      : THREE.MathUtils.clamp((u - frames[i0].t) / Math.max(1e-5, frames[i1].t - frames[i0].t), 0, 1);
    for (const name of aiClip.bones) {
      const b = bones[name];
      if (!b) continue;
      const q0 = frames[i0].quats[name] || _aiIdentQ;
      const q1 = frames[i1].quats[name] || _aiIdentQ;
      _aiTmpQ.copy(q0).slerp(q1, a);           // 四元数插值（无万向锁）
      const base = baseQuats[name] || boneRest[name];
      if (base) b.quaternion.copy(base).multiply(_aiTmpQ);
      else b.quaternion.copy(_aiTmpQ);
    }
  }

  // 对外 API：返回当前「相对静止基线」的逐骨偏移（度），用于给 AI 拼 prompt（让 AI 知道当前姿态，自适应不夸张）。
  // 只返回真实存在且属于可控/常用表达的骨骼，控制 prompt 体积。
  function getCurrentPose() {
    const out = {};
    if (!skeleton) return out;
    const candidates = new Set();
    if (modelConfig.bone_limit) {
      for (const k in modelConfig.bone_limit) {
        const b = bone(k);
        if (b) candidates.add(b.name);
      }
    }
    for (const ln of ['头', '上半身', '上半身2', '左腕', '右腕', '左ひじ', '右ひじ', '左肩', '右肩', 'センター', '腰', '下半身', '左足', '右足']) {
      const b = bone(ln);
      if (b) candidates.add(b.name);
    }
    for (const name of candidates) {
      const base = baseQuats[name] || boneRest[name];
      const b = bones[name];
      if (!b || !base) continue;
      const dq = b.quaternion.clone().multiply(base.clone().invert());
      const e = new THREE.Euler().setFromQuaternion(dq, 'XYZ');
      const x = rad2deg(e.x), y = rad2deg(e.y), z = rad2deg(e.z);
      if (Math.abs(x) > 1 || Math.abs(y) > 1 || Math.abs(z) > 1) {
        out[name] = { x: _r1(x), y: _r1(y), z: _r1(z) };
      }
    }
    return out;
  }

  // 每个动作：dur 秒；run(u, base, h) 中 u∈[0,1]，base 为动作开始时的根变换，h 为模型身高。
  // 关节类动作用 poseBoneFromRest 在静止基线上叠加相对旋转（结束自动回到基线）。
  const ACTIONS = {
    // 整个身体转一圈（脚不动，根节点绕垂直轴偏航）—— 真实"转圈圈"
    // 去掉了原先的上下浮动，避免"边转边飘"的不自然感；旋转轴即模型根(脚底)，原地自转。
    turn: { dur: 1.6, run(u, base, h) {
      mesh.rotation.y = base.yaw + Math.PI * 2 * easeInOut(u);
      applyTurnFootwork(u, Math.PI * 2, base, h); // 转身踏步：双脚交替抬起、膝盖微屈、重心微摆
      // 旋转时双臂略向外张开保持平衡（像人原地转圈），用模型无关 aim
      const ls = outwardDir('lShoulder'), rs = outwardDir('rShoulder');
      const lArm = ls.clone().multiplyScalar(0.55); lArm.y = -0.15; lArm.z = 0.8; lArm.normalize();
      const rArm = rs.clone().multiplyScalar(0.55); rArm.y = -0.15; rArm.z = 0.8; rArm.normalize();
      poseBoneAim('lArm', lArm);
      poseBoneAim('rArm', rArm);
    }},
    // 背过身去再转回来（最多转 180°）
    turn_away: { dur: 1.8, run(u, base, h) {
      const a = u < 0.5 ? easeInOut(u / 0.5) : easeInOut((1 - u) / 0.5);
      mesh.rotation.y = base.yaw + Math.PI * a;
      applyTurnFootwork(u, Math.PI * a, base, h); // 转身同时踏步，避免整体漂浮自旋
    }},
    // 点头：颈 + 头绕 X 轴俯仰
    nod: { dur: 0.7, run(u) {
      const a = Math.sin(u * Math.PI);
      poseBoneFromRest('neck', { x: a * 0.25 });
      poseBoneFromRest('head', { x: a * 0.5 });
    }},
    // 摇头：头+颈绕 Y 轴（垂直轴）左右转头 —— 真正的 3D"摇头/不不"，而非绕 Z 轴的平面侧倾(看起来像2D)。
    shake: { dur: 0.9, run(u) {
      const a = Math.sin(u * Math.PI * 3);
      poseBoneFromRest('head', { y: a * 0.6 });
      poseBoneFromRest('neck', { y: a * 0.25 });
    }},
    // 鞠躬：上半身 + 上半身2 前倾，头跟随
    bow: { dur: 1.4, run(u) {
      let a;
      if (u < 0.25) a = easeOut(u / 0.25);
      else if (u > 0.75) a = easeOut((1 - u) / 0.25);
      else a = 1;
      poseBoneFromRest('upperBody', { x: a * 0.6 });
      poseBoneFromRest('upperBody2', { x: a * 0.35 });
      poseBoneFromRest('head', { x: a * 0.2 });
    }},
    // 招手：抬起右臂并摆动手腕。模型无关：用 poseBoneAim 把大臂/小臂指向自然方向，落点不偏移。
    wave: { dur: 1.2, run(u, base, h) {
      const a = Math.sin(u * Math.PI * 4);
      const side = outwardDir('rShoulder');                  // 右臂所在侧的"向外"方向
      const upOut = side.clone().multiplyScalar(0.85); upOut.y = 0.5; upOut.normalize();
      poseBoneAim('rArm', upOut);                            // 大臂向外上抬（肩外展）
      const fore = side.clone().multiplyScalar(-0.15); fore.y = 0.85; fore.z = 0.35; fore.normalize();
      poseBoneAim('rElbow', fore);                           // 小臂上举到头侧（屈肘）
      poseBoneFromRest('rWrist', { x: a * 0.5, z: a * 0.35 }); // 手腕快速摆动 = 招手
      mesh.position.y = base.y + Math.abs(Math.sin(u * Math.PI * 4)) * h * 0.02;
    }},
    // 跳：整体腾空 + 收腿（真实折膝，修复"跳只是垂直弹一下、腿完全不动"）
    jump: { dur: 0.7, run(u, base, h) {
      const hop = Math.sin(u * Math.PI);
      mesh.position.y = base.y + hop * h * 0.20;        // 整体腾空
      const tuck = hop;                                // 腾空时收腿（膝上提）
      // 髋前送 + 膝回折 + 脚背自然：真正折关节，而非整体平移
      foldLeg('lLeg',  1, 0.9, tuck * 0.85);
      foldLeg('rLeg',  1, 0.9, tuck * 0.85);
      foldLeg('lKnee', -1, 0.9, tuck);
      foldLeg('rKnee', -1, 0.9, tuck);
      flatFoot('lAnkle', tuck);
      flatFoot('rAnkle', tuck);
    }},
    // 跳舞：双臂交替摆动 + 身体摇摆 + 膝盖随拍交替微屈 + 重心左右转移（逐关节，像人一样有脚步）。
    // 旧版只摆肩 + 整体偏航自旋，读起来像"整体漂浮转圈"；现加踏步折膝，脚真正在动。
    dance: { dur: 2.6, run(u, base, h) {
      const s = Math.sin(u * Math.PI * 4);
      const beat = Math.sin(u * Math.PI * 2);                 // 慢一拍的重心/踏步
      mesh.rotation.y = base.yaw + s * 0.4;
      poseBoneFromRest('lShoulder', { z: 1.0 + s * 0.35, x: s * 0.2 });
      poseBoneFromRest('rShoulder', { z: -1.0 - s * 0.35, x: -s * 0.2 });
      poseBoneFromRest('upperBody', { z: s * 0.2 });
      // 踏步：双膝随拍交替屈曲、重心移到支撑脚一侧（复用 foldLeg/flatFoot，世界空间折关节，模型无关）
      const liftL = Math.max(0, beat), liftR = Math.max(0, -beat);
      foldLeg('lLeg', 1, 0.5, liftL * 0.5);   foldLeg('lKnee', -1, 0.6, liftL * 0.85); flatFoot('lAnkle', liftL);
      foldLeg('rLeg', 1, 0.5, liftR * 0.5);   foldLeg('rKnee', -1, 0.6, liftR * 0.85); flatFoot('rAnkle', liftR);
      poseBoneFromRest('lowerBody', { z: (liftL - liftR) * 0.10 }); // 重心随踏步左右移
      mesh.position.y = base.y + Math.abs(beat) * h * 0.04;        // 踏实时最低、抬脚时略高
    }},
    // ===== 人类"自由状态"通用动作（逐关节，像人一样每个关节可控）=====
    // 各骨骼轴/角度为按 MMD 惯例的盲调值；不同模型可能方向/幅度需微调（改这里或调 poseBone）。
    // 蹲下：屈髋(上腿前抬) + 屈膝(小腿回折) + 踝部补偿 + 降身 + 前倾 + 手臂前抬平衡。
    // 真正"折叠"腿部关节，而非只降身高；腿部骨骼名已补充中文/英文别名以提升匹配率。
    // 蹲下：真实折腿（髋前送+膝回折+踝贴地）+ 髋下沉 + 前倾（修复"蹲只是身子往下、腿不动"）。
    // 用 foldLeg/flatFoot 在世界空间折关节，彻底摆脱腿骨局部轴向约定，膝盖真正弯曲、脚大致不抬。
    squat: { dur: 1.4, run(u, base, h) {
      const a = Math.sin(u * Math.PI);
      mesh.position.y = base.y - a * h * 0.13;          // 髋部下沉（与折腿量匹配，脚大致不抬）
      poseBoneFromRest('upperBody', { x: a * 0.14 });   // 躯干前倾保持平衡（收敛，避免"边蹲边鞠躬"）
      poseBoneFromRest('upperBody2', { x: a * 0.08 });

      foldLeg('lLeg',  1, 1.0, a * 0.85);   // 屈髋：大腿向前下送
      foldLeg('rLeg',  1, 1.0, a * 0.85);
      foldLeg('lKnee', -1, 1.0, a * 0.95);  // 屈膝：小腿向后下回折
      foldLeg('rKnee', -1, 1.0, a * 0.95);
      flatFoot('lAnkle', a);               // 踝补偿：脚掌压平
      flatFoot('rAnkle', a);

      // 手臂前抬平衡（模型无关 aim，避免穿模/扭曲）
      const ls = outwardDir('lShoulder'), rs = outwardDir('rShoulder');
      const lArm = ls.clone().multiplyScalar(0.22); lArm.y = -0.1; lArm.z = 0.95; lArm.normalize();
      const rArm = rs.clone().multiplyScalar(0.22); rArm.y = -0.1; rArm.z = 0.95; rArm.normalize();
      poseBoneAim('lArm', lArm);
      poseBoneAim('rArm', rArm);
      const lFore = ls.clone().multiplyScalar(-0.2); lFore.y = 0.12; lFore.z = 0.93; lFore.normalize();
      const rFore = rs.clone().multiplyScalar(-0.2); rFore.y = 0.12; rFore.z = 0.93; rFore.normalize();
      poseBoneAim('lElbow', lFore);
      poseBoneAim('rElbow', rFore);
    }},
    // 坐下：更深的屈膝 + 更低 + 微后仰（同样真实折腿，修复"坐下腿不折"）。
    sit: { dur: 1.5, run(u, base, h) {
      const a = Math.sin(u * Math.PI);
      mesh.position.y = base.y - a * h * 0.18;
      poseBoneFromRest('upperBody', { x: -a * 0.18 });
      poseBoneFromRest('upperBody2', { x: -a * 0.1 });
      foldLeg('lLeg',  1, 1.1, a);         // 更深的屈髋
      foldLeg('rLeg',  1, 1.1, a);
      foldLeg('lKnee', -1, 1.1, a);        // 更深的屈膝
      foldLeg('rKnee', -1, 1.1, a);
      flatFoot('lAnkle', a);
      flatFoot('rAnkle', a);
    }},
    // 站起来：从蹲/坐起身——轻微上顶 + 挺胸伸展
    stand: { dur: 0.9, run(u, base, h) {
      const a = Math.sin(u * Math.PI);
      mesh.position.y = base.y + a * h * 0.06;
      poseBoneFromRest('upperBody', { x: -a * 0.18 });
      poseBoneFromRest('lShoulder', { z: 0.12 + a * 0.1, x: a * 0.08 });
      poseBoneFromRest('rShoulder', { z: -0.12 - a * 0.1, x: a * 0.08 });
    }},
    // 伸懒腰：双臂上举过头顶 + 略向后展 + 躯干微后仰 + 仰头（替代原来把胳膊甩向两侧的 Z 轴旋转）
    stretch: { dur: 1.7, run(u, base, h) {
      const a = Math.sin(u * Math.PI);
      const ls = outwardDir('lShoulder'), rs = outwardDir('rShoulder');
      // 大臂：向上(+Y)、略向外、略向后(-Z) —— 真正"举过头顶"
      const lArm = ls.clone().multiplyScalar(0.26); lArm.y = 0.92; lArm.z = -0.20; lArm.normalize();
      const rArm = rs.clone().multiplyScalar(0.26); rArm.y = 0.92; rArm.z = -0.20; rArm.normalize();
      poseBoneAim('lArm', lArm);
      poseBoneAim('rArm', rArm);
      // 小臂继续向上、略向内，双手在头顶上方汇合，延展感更强
      const lFore = ls.clone().multiplyScalar(-0.18); lFore.y = 0.95; lFore.z = -0.06; lFore.normalize();
      const rFore = rs.clone().multiplyScalar(-0.18); rFore.y = 0.95; rFore.z = -0.06; rFore.normalize();
      poseBoneAim('lElbow', lFore);
      poseBoneAim('rElbow', rFore);
      poseBoneFromRest('upperBody', { x: -a * 0.16 });   // 躯干微后仰展胸
      poseBoneFromRest('upperBody2', { x: -a * 0.09 });
      poseBoneFromRest('head', { x: -a * 0.14 });        // 仰头
    }},
    // 思考：右手托腮 + 微歪头。模型无关 aim（肘抬高、小臂向内上到脸前）。
    think: { dur: 1.5, run(u, base, h) {
      const a = Math.sin(u * Math.PI);
      const rs = outwardDir('rShoulder');
      const rUp = rs.clone().multiplyScalar(0.7); rUp.y = 0.55; rUp.normalize();   // 大臂向外上（肘抬高）
      poseBoneAim('rArm', rUp);
      const rFore = rs.clone().multiplyScalar(-0.35); rFore.y = 0.55; rFore.z = 0.5; rFore.normalize(); // 小臂向内上到脸前
      poseBoneAim('rElbow', rFore);
      poseBoneFromRest('rWrist', { x: a * 0.4, z: a * 0.2 });
      poseBoneFromRest('head', { z: a * 0.12, x: a * 0.1 });
      poseBoneFromRest('neck', { z: a * 0.06 });
    }},
    // 害羞：双手捂脸/抱臂 + 低头。模型无关 aim（双臂上抬、小臂向内前到脸前）。
    shy: { dur: 1.5, run(u, base, h) {
      const a = Math.sin(u * Math.PI);
      const ls = outwardDir('lShoulder'), rs = outwardDir('rShoulder');
      const lUp = ls.clone().multiplyScalar(0.5); lUp.y = 0.7; lUp.normalize();
      const rUp = rs.clone().multiplyScalar(0.5); rUp.y = 0.7; rUp.normalize();
      poseBoneAim('lArm', lUp);
      poseBoneAim('rArm', rUp);
      const lFore = ls.clone().multiplyScalar(-0.2); lFore.y = 0.5; lFore.z = 0.7; lFore.normalize();
      const rFore = rs.clone().multiplyScalar(-0.2); rFore.y = 0.5; rFore.z = 0.7; rFore.normalize();
      poseBoneAim('lElbow', lFore);
      poseBoneAim('rElbow', rFore);
      poseBoneFromRest('lWrist', { x: a * 0.3, z: a * 0.2 });
      poseBoneFromRest('rWrist', { x: a * 0.3, z: -a * 0.2 });
      poseBoneFromRest('head', { x: a * 0.35 });
      poseBoneFromRest('neck', { x: a * 0.2 });
    }},
    // 鼓掌：双手在胸前【同一交点】汇合、掌对掌快速开合（真正"拍掌"而非乱挥）。
    // 关键：先定一个身前胸高处的共同交点 P，双臂大臂前抬把肘带到身前两侧，
    // 再让两条小臂各自「指向 P」，于是左右手腕在同一时刻收敛到 P → 合掌拍击。
    clap: { dur: 1.1, run(u, base, h) {
      const closed = Math.abs(Math.sin(u * Math.PI * 6)); // 1=合掌拍击, 0=张开
      const open = 1 - closed;
      mesh.updateMatrixWorld(true);
      // 共同交点 P：胸口正前方（模型前向 = +Z，朝观察者）；略低于锁骨、约 0.16*身高 身前
      const ref = bone('upperBody2') || bone('upperBody') || bone('neck');
      const cp = new THREE.Vector3();
      if (ref) ref.getWorldPosition(cp); else cp.set(0, h * 0.55, 0);
      const P = cp.clone();
      P.z += 0.16 * h;   // 身前
      P.y -= 0.02 * h;   // 略低于胸口
      // 大臂：向前(+Z)为主、随开合向外展（张开时肘更外、手分离；合拢时肘内收、手靠近中线）
      const ls = outwardDir('lShoulder');   // 左臂向外 ≈ -X
      const rs = outwardDir('rShoulder');   // 右臂向外 ≈ +X
      const lArm = ls.clone().multiplyScalar(0.22 + open * 0.55); lArm.y = -0.05; lArm.z = 0.92; lArm.normalize();
      const rArm = rs.clone().multiplyScalar(0.22 + open * 0.55); rArm.y = -0.05; rArm.z = 0.92; rArm.normalize();
      poseBoneAim('lArm', lArm);
      poseBoneAim('rArm', rArm);
      mesh.updateMatrixWorld(true);
      // 小臂指向共同交点 P（使双手在胸前汇合）；合拢时内收更强（closed 大 → 更指向中线前方）
      const lElbow = bone('lElbow'), rElbow = bone('rElbow');
      if (lElbow && rElbow) {
        const lp = new THREE.Vector3(), rp = new THREE.Vector3();
        lElbow.getWorldPosition(lp); rElbow.getWorldPosition(rp);
        const lFore = P.clone().sub(lp).normalize();
        const rFore = P.clone().sub(rp).normalize();
        poseBoneAim('lElbow', lFore);
        poseBoneAim('rElbow', rFore);
      }
      // 拍击瞬间轻微前倾，增强"鼓掌"节奏感
      poseBoneFromRest('upperBody', { x: closed * 0.04 });
      poseBoneFromRest('head', { x: closed * 0.04 });
    }},
    // 指向：右臂前平举 + 小臂伸直指向正前方（模型无关 aim，落点自然不穿模）
    point: { dur: 1.0, run(u, base, h) {
      const a = Math.sin(u * Math.PI);
      const side = outwardDir('rShoulder');                 // 右臂所在侧的向外方向
      const upOut = side.clone().multiplyScalar(0.2); upOut.y = 0.05; upOut.z = 0.97; upOut.normalize(); // 大臂前平举（朝前略外）
      poseBoneAim('rArm', upOut);
      const fore = side.clone().multiplyScalar(0.05); fore.y = 0.0; fore.z = 0.99; fore.normalize();    // 小臂向前伸直
      poseBoneAim('rElbow', fore);
      poseBoneFromRest('rWrist', { x: a * 0.2, z: a * 0.1 });
      poseBoneFromRest('head', { y: a * 0.2, z: -a * 0.08 }); // 头随指向方向略转
      poseBoneFromRest('neck', { y: a * 0.1 });
    }},
    // 打哈欠：双手托腮 + 仰头
    yawn: { dur: 1.6, run(u, base, h) {
      const a = Math.sin(u * Math.PI);
      poseBoneFromRest('lShoulder', { z: 0.12 + a * 0.7, x: a * 0.3 });
      poseBoneFromRest('rShoulder', { z: -0.12 - a * 0.7, x: a * 0.3 });
      poseBoneFromRest('lElbow', { z: a * 1.2 });
      poseBoneFromRest('rElbow', { z: a * 1.2 });
      poseBoneFromRest('head', { x: -a * 0.2 });
      poseBoneFromRest('neck', { x: -a * 0.1 });
    }},
    // 叉腰：肘外展 + 前臂下指髋部。模型无关 aim，姿势落在人体正常位置（修复"叉腰不符合人体工学"）。
    cross: { dur: 1.3, run(u, base, h) {
      const a = Math.sin(u * Math.PI);
      const ls = outwardDir('lShoulder'), rs = outwardDir('rShoulder');
      // 大臂向外下（肘外展）
      const lUp = ls.clone().multiplyScalar(0.9); lUp.y = -0.42; lUp.normalize();
      const rUp = rs.clone().multiplyScalar(0.9); rUp.y = -0.42; rUp.normalize();
      poseBoneAim('lArm', lUp);
      poseBoneAim('rArm', rUp);
      // 小臂向内下指向腰部（手叉腰）
      const lFore = ls.clone().multiplyScalar(-0.6); lFore.y = -0.8; lFore.normalize();
      const rFore = rs.clone().multiplyScalar(-0.6); rFore.y = -0.8; rFore.normalize();
      poseBoneAim('lElbow', lFore);
      poseBoneAim('rElbow', rFore);
      poseBoneFromRest('lWrist', { z: a * 0.2 });
      poseBoneFromRest('rWrist', { z: -a * 0.2 });
    }}
  };

  // 中文 / 同义词 → 动作键（也是 AI 指令、菜单、runCommand 的归一化表）
  const ACTION_ALIAS = {
    turn: 'turn', spin: 'turn', 转身: 'turn', 转圈: 'turn', 转个圈: 'turn', 转过去: 'turn_away',
    背过去: 'turn_away', 背对: 'turn_away', 转过身: 'turn_away',
    nod: 'nod', 点头: 'nod',
    shake: 'shake', 摇头: 'shake', 摆头: 'shake', 否认: 'shake',
    bow: 'bow', 鞠躬: 'bow', 弯腰: 'bow',
    wave: 'wave', 招手: 'wave', 挥手: 'wave', 嗨: 'wave',
    jump: 'jump', 跳: 'jump', 跳一下: 'jump', 蹦: 'jump', 蹦跳: 'jump',
    dance: 'dance', 跳舞: 'dance', 舞蹈: 'dance',
    squat: 'squat', 蹲下: 'squat', 蹲: 'squat', 下蹲: 'squat', 蹲着: 'squat', 蜷: 'squat',
    sit: 'sit', 坐下: 'sit', 坐下来: 'sit', 落座: 'sit', 跪: 'sit',
    stand: 'stand', 站起来: 'stand', 起身: 'stand', 起立: 'stand', 站起: 'stand',
    stretch: 'stretch', 伸懒腰: 'stretch', 伸展: 'stretch', 拉伸: 'stretch', 懒腰: 'stretch',
    think: 'think', 思考: 'think', 托腮: 'think', 沉思: 'think', 想想: 'think',
    shy: 'shy', 害羞: 'shy', 不好意思: 'shy', 脸红: 'shy', 捂脸: 'shy',
    clap: 'clap', 鼓掌: 'clap', 拍手: 'clap', 呱唧: 'clap', 鼓掌欢迎: 'clap',
    point: 'point', 指向: 'point', 指一指: 'point', 指给你看: 'point',
    yawn: 'yawn', 打哈欠: 'yawn', 哈欠: 'yawn',
    cross: 'cross', 叉腰: 'cross', 双手叉腰: 'cross', 抱臂: 'cross'
  };

  // AI 意图关键词 → 程序化动作（playIntent 据此选择动作，而非仅弹跳）
  const INTENT_TO_ACTION = {
    turn: 'turn', spin: 'turn', around: 'turn', back: 'turn_away', turn_away: 'turn_away',
    nod: 'nod', shake: 'shake', bow: 'bow',
    wave: 'wave', greet: 'wave', hello: 'wave', hi: 'wave',
    jump: 'jump', surprise: 'jump',
    dance: 'dance',
    happy: 'jump', // 开心跳一下
    think: 'think', shy: 'shy',
    squat: 'squat', sit: 'sit', stand: 'stand', stretch: 'stretch',
    clap: 'clap', point: 'point', yawn: 'yawn', cross: 'cross'
  };

  // 收集一个关键帧动作用到的全部骨骼名（用于每帧重置后只重摆这些骨骼）
  function collectBonesUsed(def) {
    const set = new Set();
    for (const kf of (def.keyframes || [])) {
      for (const b in (kf.bones || {})) set.add(b);
    }
    return [...set];
  }

  function resolveRelated(key) {
    const r = actionRelated[key];
    return Array.isArray(r) ? r : [];
  }

  // 相关动作条目规范化：兼容旧格式「字符串键」与新格式「{key,count,interval,loop,t}」
  function normalizeRelatedEntry(e) {
    if (typeof e === 'string') return { key: e, count: 1, interval: 0, loop: false, t: null };
    if (!e || !e.key) return { key: '', count: 1, interval: 0, loop: false, t: null };
    const t = (typeof e.t === 'number' && isFinite(e.t)) ? Math.max(0, Math.min(1, e.t)) : null;
    return {
      key: e.key,
      count: (e.count && e.count > 1) ? e.count : 1,
      interval: (e.interval && e.interval > 0) ? e.interval : 0,
      loop: !!e.loop,
      t
    };
  }

  // 关键帧插值播放：相邻关键帧之间对骨骼旋转 / 根运动 / 表情 做缓动插值
  function playKeyframe(act, u) {
    const kfs = act.def.keyframes;
    if (!kfs || !kfs.length || !mesh) return;
    // 定位 u 所在的两个关键帧
    let k0 = kfs[0], k1 = kfs[kfs.length - 1];
    if (u <= kfs[0].t) { k0 = k1 = kfs[0]; }
    else if (u >= kfs[kfs.length - 1].t) { k0 = k1 = kfs[kfs.length - 1]; }
    else {
      for (let i = 0; i < kfs.length - 1; i++) {
        if (u >= kfs[i].t && u <= kfs[i + 1].t) { k0 = kfs[i]; k1 = kfs[i + 1]; break; }
      }
    }
    const span = (k1.t - k0.t) || 1;
    const lt = span > 0 ? clamp01((u - k0.t) / span) : 1;
    const e = easeInOut(lt);
    resetAllBones();
    for (const bname of act.bonesUsed) {
      const b0 = (k0.bones && k0.bones[bname]) || { x: 0, y: 0, z: 0 };
      const b1 = (k1.bones && k1.bones[bname]) || { x: 0, y: 0, z: 0 };
      poseBoneFromRest(bname, {
        x: (b0.x || 0) + ((b1.x || 0) - (b0.x || 0)) * e,
        y: (b0.y || 0) + ((b1.y || 0) - (b0.y || 0)) * e,
        z: (b0.z || 0) + ((b1.z || 0) - (b0.z || 0)) * e
      });
    }
    // [DEBUG-LB] 宠物播放涉及 lowerBody 时输出（定位“宠物下半身不动”），每动作前若干帧采样
    if (act.bonesUsed && act.bonesUsed.includes('lowerBody')) {
      if (!window.__LBPET_COUNT) window.__LBPET_COUNT = 0;
      if (window.__LBPET_COUNT < 10) {
        window.__LBPET_COUNT++;
        const lb = bone('lowerBody');
        const lb0 = (k0.bones && k0.bones.lowerBody) || { x: 0, y: 0, z: 0 };
        const lb1 = (k1.bones && k1.bones.lowerBody) || { x: 0, y: 0, z: 0 };
        const lbVal = {
          x: +((lb0.x || 0) + ((lb1.x || 0) - (lb0.x || 0)) * e).toFixed(2),
          y: +((lb0.y || 0) + ((lb1.y || 0) - (lb0.y || 0)) * e).toFixed(2),
          z: +((lb0.z || 0) + ((lb1.z || 0) - (lb0.z || 0)) * e).toFixed(2)
        };
        console.log('[Pet][LB] u=' + u.toFixed(3) + ' resolved=' + (lb ? lb.name : 'NULL') +
          ' lbVal(deg)=' + JSON.stringify(lbVal) +
          ' boneQ=' + (lb ? JSON.stringify({ w: +lb.quaternion.w.toFixed(3), x: +lb.quaternion.x.toFixed(3), y: +lb.quaternion.y.toFixed(3), z: +lb.quaternion.z.toFixed(3) }) : 'n/a'));
      }
    }
    // 根运动（y 以模型身高为单位的相对量）
    const r0 = k0.root || {}; const r1 = k1.root || {};
    const ry = (r0.y || 0) + ((r1.y || 0) - (r0.y || 0)) * e;
    mesh.position.y = act.base.y + ry * modelHeight;
    mesh.rotation.y = act.base.yaw + ((r0.rotY || 0) + ((r1.rotY || 0) - (r0.rotY || 0)) * e);
    mesh.rotation.x = act.base.pitch + ((r0.rotX || 0) + ((r1.rotX || 0) - (r0.rotX || 0)) * e);
    mesh.rotation.z = act.base.roll + ((r0.rotZ || 0) + ((r1.rotZ || 0) - (r0.rotZ || 0)) * e);
    // 表情 morph 插值
    const m0 = k0.morphs || {}; const m1 = k1.morphs || {};
    const mkeys = new Set([...Object.keys(m0), ...Object.keys(m1)]);
    for (const emo of mkeys) {
      const w = (m0[emo] || 0) + ((m1[emo] || 0) - (m0[emo] || 0)) * e;
      const list = exprIndex[emo];
      if (list) for (const { idx } of list) morphInf[idx] = w;
    }
  }

  // 直接播放一个关键帧动作定义（自定义动作 / 预览都走这里）
  function playDef(def, opts) {
    if (!mesh || !def) return false;
    window.__LBPET_COUNT = 0; // 每个新动作重置 [Pet][LB] 采样计数
    resetAllBones();
    const relatedNorm = (def.related && Array.isArray(def.related)) ? def.related.map(normalizeRelatedEntry) : [];
    const dur = (opts && opts.dur) || def.duration || 1;
    // 有时间点的相关动作 → 时间轴断点（主动作播放期间按 t 切入）；其余 → 遗留串行队列
    timedEntries = relatedNorm.filter(e => e.t != null).sort((a, b) => a.t - b.t).map(e => ({ e, fireAt: e.t * dur, fired: false }));
    timedClock = 0; suspendedMain = null;
    actionQueue.push(...relatedNorm.filter(e => e.t == null));
    const base = { yaw: mesh.rotation.y, pitch: mesh.rotation.x, roll: mesh.rotation.z, y: mesh.position.y };
    activeAction = {
      key: def.key || '__preview__',
      def,
      t: 0,
      dur,
      speed: (def && typeof def.speed === 'number' && def.speed > 0) ? def.speed : 1,
      base,
      loop: !!(opts && opts.loop) || !!def.loop,
      bonesUsed: collectBonesUsed(def),
      composed: timedEntries.length > 0
    };
    return true;
  }

  // 预览某个动作定义（编辑器"预览"按钮调用）：循环播放便于观察
  function previewAction(def) {
    return playDef(def, { loop: !!(def && def.loop) });
  }

  // 载入每模型的动作配置：自定义关键帧动作 + 相关动作覆盖 + 待机动作
  function setActions(data) {
    customActions = {};
    actionRelated = {};
    deletedBuiltinKeys = Array.isArray(data && data.deletedBuiltins) ? data.deletedBuiltins : [];
    if (!data || !data.actions) return;
    for (const k in data.actions) {
      const a = data.actions[k];
      if (!a) continue;
      if (a.keyframes && Array.isArray(a.keyframes)) {
        customActions[k] = a;                       // 完整自定义关键帧动作
        if (Array.isArray(a.related)) actionRelated[k] = a.related;
      } else if (Array.isArray(a.related)) {
        actionRelated[k] = a.related;              // 仅覆盖内置动作的相关动作
      }
    }
  }

  function startAction(key, opts) {
    const def = customActions[key];
    if (!def && !ACTIONS[key]) return false;
    if (ACTIONS[key] && deletedBuiltinKeys.includes(key)) return false; // 该默认动作已被用户删除，禁止触发
    if (!mesh) return false;
    if (smActive) return false; // 状态机接管身体时忽略离散动作（严格顺序控制）
    resetAllBones(); // 动作前清掉上一动作的关节残留，从静止基线开始
    timedEntries = []; suspendedMain = null; // 单动作触发不启用时间轴切轨，清除可能残留的断点调度
    const related = def ? (def.related || []) : resolveRelated(key);
    actionQueue.push(...(Array.isArray(related) ? related : []).map(normalizeRelatedEntry));
    const base = {
      yaw: mesh.rotation.y,
      pitch: mesh.rotation.x,
      roll: mesh.rotation.z,
      y: mesh.position.y
    };
    if (def) {
      activeAction = { key, def, t: 0, dur: (opts && opts.dur) || def.duration || 1, speed: (def && typeof def.speed === 'number' && def.speed > 0) ? def.speed : 1, base, loop: !!(opts && opts.loop) || !!def.loop, replay: (opts && opts.replay) || null, bonesUsed: collectBonesUsed(def) };
    } else {
      activeAction = { key, def: null, t: 0, dur: (opts && opts.dur) || ACTIONS[key].dur, base, loop: !!(opts && opts.loop), replay: (opts && opts.replay) || null };
    }
    return true;
  }

  // 从队列取出一个相关动作条目并播放（支持 count 重播 / interval 间隔 / loop 循环）
  // 注意：必须真正 startAction，不可把 interval>0 的条目重新塞回 pendingEntry ——
  // 否则会陷入"永远 re-pend、永不播放"的死循环，导致 pendingEntry 非空、待机分支永远不执行。
  // 重复播放的"间隔"由 activeAction.replay 在动作结束时通过设置 pendingEntry（递减 count）来实现。
  function startQueued(entry) {
    const e = normalizeRelatedEntry(entry);
    if (!e.key) return;
    startAction(e.key, { loop: e.loop, replay: { count: e.count, interval: e.interval, loop: e.loop } });
  }

  // 按动作名/中文别名触发一个 3D 动作；返回是否成功触发
  function runAction(name, opts) {
    if (!mesh) return false;
    if (customActions[name]) return playDef(customActions[name], opts);
    const key = ACTIONS[name] ? name : (ACTION_ALIAS[name] || null);
    if (!key) return false;
    return startAction(key, opts);
  }

  // 解析一句自然语言指令并触发对应动作（供 AI / 调试 / 命令输入调用）
  // 例：'转身' '转个圈' 'nod' '跳舞' 'jump' 都能识别
  function runCommand(str) {
    if (!str || !mesh) return false;
    const s = String(str).trim().toLowerCase();
    if (ACTIONS[s]) return startAction(s);
    if (ACTION_ALIAS[s]) return startAction(ACTION_ALIAS[s]);
    for (const k of Object.keys(ACTION_ALIAS)) {
      if (s.includes(k)) return startAction(ACTION_ALIAS[k]);
    }
    return false;
  }

  function listActions() {
    return Object.keys(ACTIONS);
  }

  // 判断某个意图（右键菜单 act:xxx）当前是否可播放：
  // - 无动作映射的纯情绪意图（sleep/idle/confuse/angry/lazy 等）始终可用
  // - 自定义关键帧动作覆盖时可用
  // - 内置动作存在且未被用户删除时可用
  function isIntentAvailable(intent) {
    if (!intent) return false;
    if (intent === 'reset' || intent === 'idle') return true;
    const actionKey = INTENT_TO_ACTION[intent];
    if (!actionKey) return true; // 纯情绪意图，无对应程序化动作
    if (customActions[intent] || customActions[actionKey]) return true;
    if (ACTIONS[actionKey] && !deletedBuiltinKeys.includes(actionKey)) return true;
    return false;
  }

  // 内置动作可读名（供主窗口动作编辑器列出；与 ACTION_ALIAS 的中文含义对应）
  const BUILTIN_LABELS = {
    turn: '转身', turn_away: '背过身', nod: '点头', shake: '摇头', bow: '鞠躬',
    wave: '招手', jump: '跳跃', dance: '跳舞', squat: '蹲下', sit: '坐下',
    stand: '站起来', stretch: '伸懒腰', think: '思考', shy: '害羞', clap: '鼓掌',
    point: '指向', yawn: '打哈欠', cross: '叉腰'
  };

  // 供编辑器获取内置动作清单 [{key,label}]
  function getBuiltinActions() {
    return Object.keys(ACTIONS).map((k) => ({ key: k, label: BUILTIN_LABELS[k] || k }));
  }

  // ============================================================
  // 角色动画状态机（严格顺序控制）
  // 四种状态：浮空 / 侧躺 / 睡眠(躺下入睡) / 唤醒(锁定序列)
  // 说明：
  //   1) 浮空：无地板绑定，晃晃悠悠的悬浮漂移感（手动触发）
  //   2) 侧躺：头枕于弯曲手臂的自然侧躺（手动触发 / 演示）
  //   3) 睡眠：与侧躺同姿态躺下，闭眼 + 缓慢呼吸（由「睡觉」指令 / 睡眠态触发）
  //   4) 唤醒流程（锁定、不可跳步/错乱）：先 伸懒腰 → 打哈欠，再从躺姿 过渡到站立
  // 默认加载为「自然站立待机」（不进入状态机）；状态机仅在用户触发侧躺/浮空/睡眠或睡眠态时接管身体。
  // ============================================================
  const SM_STATE = { FLOATING: 'floating', SIDELYING: 'sideling', SLEEP: 'sleep', WAKE: 'wake' };
  const SM_DEFAULT = SM_STATE.FLOATING; // 约定默认态（加载时不再强制进入，详见 load()）
  let smState = null;        // 当前状态
  let smActive = false;      // 状态机是否接管身体（true 时优先于待机/动作分支）
  let smSeq = null;          // 唤醒锁定序列运行状态 { steps:[{name,dur,fn}], i, t }
  let smSeqLock = false;     // 锁定中：拒绝任何打断（保证唤醒流程不可跳步/错乱）
  let smSideGround = 0;      // 侧躺贴地偏移（进入时按包围盒算一次，模型无关）

  // 侧躺定向：直接绕 Z 轴 -π/2 把站立模型翻成「头朝屏幕右、脸朝屏幕」的侧躺姿态。
  // 数学（right-handed）：roll(-π/2) 使模型局部 +Y(头顶)→世界 +X(屏幕右)、
  // 局部 +Z(正面)→世界 +Z(朝向相机)，且模型仍落在局部 +X 一侧（下侧手臂=右手，
  // 沿用 smPoseSideLyingBones 的右臂托头姿势，无需改骨骼姿态）。
  // 旧版 [先 yaw(π) 再 roll(+π/2)] 会让头落屏幕左、脸背对相机（与需求相反），现修正。
  const _qRoll = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), -Math.PI / 2);
  const smSideQuat = _qRoll;

  // 计算侧躺时让身体最低点≈地面的 y 偏移（模型无关）
  function smComputeSideGround() {
    if (!mesh || !skeleton) return 0;
    mesh.quaternion.identity(); mesh.rotation.set(0, 0, 0); mesh.position.set(0, baseY, 0);
    resetAllBones();
    smPoseSideLyingBones(0);
    mesh.quaternion.copy(smSideQuat);          // 翻到侧躺（带正面朝向）
    mesh.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(mesh);
    return box.isEmpty() ? baseY * 0.18 : Math.max(0, -box.min.y);
  }

  // 按当前 mesh 变换（可能已摆成侧躺等横向姿态）自动取景，保证整只模型都在画面内。
  // 改用包围球半径决定距离：无论模型因侧躺而横向展开、还是竖直站立，球半径对应的最远点
  // 都恰好落在视锥内，彻底解决「侧躺模型展示不全 / 出框」的问题（模型无关）。
  function smFitCameraToBox() {
    if (!mesh || !camera) return;
    mesh.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(mesh);
    if (box.isEmpty()) return;
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const r = sphere.radius || (modelHeight * 0.5);
    const fov = (camera.fov * Math.PI) / 180;
    const aspect = camera.aspect || 1;
    // 取竖直 / 水平方向所需距离的最大值（横向展开时水平方向更需要拉远）
    const distV = r / Math.tan(fov / 2);
    const distH = r / Math.tan(fov / 2) / aspect;
    let dist = Math.max(distV, distH) * 1.18;   // 留边距
    const c = sphere.center;
    camera.position.set(c.x, c.y, c.z + dist);
    camera.lookAt(c.x, c.y, c.z);
    camera.updateProjectionMatrix();
  }

  // 侧躺骨骼姿态（局部空间，mesh 仍直立；调用方负责把 mesh 旋转 90° 翻到侧躺）
  // 头枕于弯曲的手臂（右臂托头）+ 四肢放松微屈，呈现自然侧躺。
  function smPoseSideLyingBones(t) {
    // 头部轻侧（朝角色右侧 = 翻倒后的地面侧），似枕在手臂上
    poseBoneFromRest('head', { z: 0.5, x: -0.06 });
    poseBoneFromRest('neck', { z: 0.22 });
    // 右臂（地面侧）弯曲上抬托住头部：大臂上举、小臂回折到头侧
    const rs = outwardDir('rShoulder');
    const rArm = rs.clone().multiplyScalar(0.12); rArm.y = 0.9; rArm.z = 0.28; rArm.normalize();
    poseBoneAim('rArm', rArm);
    const rFore = rs.clone().multiplyScalar(-0.05); rFore.y = 0.55; rFore.z = 0.92; rFore.normalize();
    poseBoneAim('rElbow', rFore);
    poseBoneFromRest('rWrist', { x: 0.2, z: 0.1 });
    // 左臂（上方）自然搭在身前
    const ls = outwardDir('lShoulder');
    const lArm = ls.clone().multiplyScalar(0.5); lArm.y = 0.25; lArm.z = 0.5; lArm.normalize();
    poseBoneAim('lArm', lArm);
    const lFore = ls.clone().multiplyScalar(0.1); lFore.y = 0.3; lFore.z = 0.85; lFore.normalize();
    poseBoneAim('lElbow', lFore);
    // 双腿放松微屈（侧躺自然姿态）
    foldLeg('lKnee', -1, 0.35, 0.18);
    foldLeg('rKnee', -1, 0.35, 0.12);
    poseBoneFromRest('lowerBody', { z: 0.05 });
  }

  // 进入某静态状态（重置变换 / 设定闭眼标志 / 计算贴地偏移）
  function smEnter(state) {
    smState = state;
    smActive = true;
    smSeq = null;
    smSeqLock = false;
    sleeping = (state === SM_STATE.SLEEP);
    if (state === SM_STATE.SLEEP) { blinkTarget = 1; resetExpr(); } // 闭眼入睡
    else { blinkTarget = 0; blinkPhase = 'idle'; nextBlinkAt = elapsed + rand(2, 5); }
    // 侧躺/睡眠均躺地，需先算贴地偏移（模型无关）
    if (state === SM_STATE.SIDELYING || state === SM_STATE.SLEEP) smSideGround = smComputeSideGround();
    // 复位到该状态的静止变换并自动取景，保证模型完整入画
    mesh.quaternion.identity(); mesh.rotation.set(0, 0, 0); mesh.position.set(0, baseY, 0);
    resetAllBones();
    if (state === SM_STATE.SIDELYING || state === SM_STATE.SLEEP) {
      // 睡眠与侧躺同躺地姿态（睡眠额外闭眼 + 缓慢呼吸，由 sleeping 标志驱动）
      smPoseSideLyingBones(0);
      mesh.quaternion.copy(smSideQuat);
      mesh.position.y = baseY + smSideGround;
    } else if (state === SM_STATE.FLOATING) {
      mesh.position.y = baseY + modelHeight * 0.55;
    }
    smFitCameraToBox();
  }

  // 各状态每帧渲染（在 resetAllBones 之后调用，统一先回到中立变换再摆姿态）
  function smRender(dt) {
    if (!mesh || !skeleton) return;
    resetAllBones();
    mesh.rotation.set(0, 0, 0); mesh.position.set(0, baseY, 0); // 先中立，便于 poseBoneAim 世界计算
    const h = modelHeight;
    const t = elapsed;
    if (smState === SM_STATE.FLOATING) {
      // 浮空：绑定虚拟地面 —— 锚定在落点正上方固定悬浮高度，只做克制的垂直轻浮，
      // 不再横向漂移 / 大幅摇摆（修复"没有虚拟地面、角色来回晃来晃去"的问题）。
      const hover = h * 0.55;                       // 离虚拟地面的固定悬浮高度
      const bob = Math.sin(t * 0.9) * 0.04 * h;     // 仅垂直轻浮（克制）
      mesh.position.set(0, baseY + hover + bob, 0);  // x/z 锚定落点，杜绝漂移
      mesh.rotation.set(
        Math.sin(t * 0.7) * 0.05,                   // 前后轻晃（克制）
        Math.sin(t * 0.33) * 0.18,                  // 缓慢偏航（克制，原 ±0.5 大幅 → ±0.18）
        Math.sin(t * 0.9 + 0.7) * 0.04              // 左右轻晃（克制，原 ±0.18→±0.04）
      );
      dropArmsToSides();
      poseBoneFromRest('lArm', { z: Math.sin(t * 0.8) * 0.05 });
      poseBoneFromRest('rArm', { z: -Math.sin(t * 0.8) * 0.05 });
      const kb = 0.04 * (0.5 + 0.5 * Math.sin(t * 1.1));
      foldLeg('lKnee', -1, 0.4, kb); foldLeg('rKnee', -1, 0.4, kb * 0.8);
    } else if (smState === SM_STATE.SIDELYING) {
      smPoseSideLyingBones(t);
      mesh.quaternion.copy(smSideQuat);        // 侧躺（正面朝向相机）
      mesh.position.set(0, smSideGround + Math.sin(t * 0.8) * 0.01 * h, 0);
    } else if (smState === SM_STATE.SLEEP) {
      // 躺下入睡：与侧躺同姿态（头枕弯臂），由 sleeping 标志驱动闭眼 + 缓慢呼吸
      smPoseSideLyingBones(t);
      mesh.quaternion.copy(smSideQuat);
      mesh.position.set(0, smSideGround + Math.sin(t * 0.7) * 0.008 * h, 0);
    } else if (smState === SM_STATE.WAKE) {
      smAdvanceSeq(dt);                        // 唤醒锁定序列自行推进
    }
  }

  // 唤醒锁定序列：伸懒腰 → 打哈欠 → 从躺姿到站立（严格顺序，不可跳步/错乱）
  function smStartWake() {
    if (smSeqLock) return false;                       // 已在唤醒中：拒绝重复触发
    if (smState !== SM_STATE.SLEEP && smState !== SM_STATE.SIDELYING) return false; // 仅在睡眠/侧躺后唤醒
    smSideGround = smComputeSideGround();              // 确保贴地基准正确
    sleeping = true; blinkTarget = 1;                  // 唤醒初期仍闭眼
    smState = SM_STATE.WAKE;
    smSeq = {
      i: 0, t: 0,
      steps: [
        { name: 'stretch', dur: ACTIONS.stretch.dur, fn: smWakeStretch },
        { name: 'yawn',    dur: ACTIONS.yawn.dur,    fn: smWakeYawn },
        { name: 'rise',    dur: 1.8,                 fn: smWakeRise }
      ]
    };
    smSeqLock = true;                                  // 锁定：拒绝任何打断，直到序列结束
    return true;
  }

  // 唤醒步骤1：伸懒腰（在侧躺姿态上张开双臂过头顶）
  function smWakeStretch(u) {
    mesh.rotation.set(0, 0, 0); mesh.position.set(0, baseY, 0);
    ACTIONS.stretch.run(u, { yaw: 0, y: baseY }, modelHeight);
    mesh.quaternion.copy(smSideQuat);                 // 强制躺姿（覆盖 run 内的站立位移）
    mesh.position.set(0, smSideGround + Math.sin(u * Math.PI) * 0.01 * modelHeight, 0);
  }
  // 唤醒步骤2：打哈欠（在侧躺姿态上托腮仰头）
  function smWakeYawn(u) {
    mesh.rotation.set(0, 0, 0); mesh.position.set(0, baseY, 0);
    ACTIONS.yawn.run(u, { yaw: 0, y: baseY }, modelHeight);
    mesh.quaternion.copy(smSideQuat);
    mesh.position.set(0, smSideGround, 0);
  }
  // 唤醒步骤3：从躺姿到站立（旋转由侧躺四元数→单位，抬升至 baseY，手臂由抱拢渐变为自然下垂）
  function smWakeRise(u) {
    const e = easeInOut(u);
    mesh.quaternion.copy(smSideQuat).slerp(new THREE.Quaternion(), e); // 躺→站：旋转插值回正
    mesh.position.set(0, smSideGround + (baseY - smSideGround) * e + Math.sin(u * Math.PI) * 0.02 * modelHeight, 0);
    dropArmsToSides();
    poseBoneFromRest('upperBody', { x: -0.05 * (1 - e) });
    poseBoneFromRest('head', { x: -0.05 * (1 - e) });
    poseBoneFromRest('lowerBody', { z: 0.03 * (1 - e) });
  }

  // 推进唤醒序列（每帧）。完成后释放控制权，回到正常站立待机。
  function smAdvanceSeq(dt) {
    if (!smSeq) { smSeqLock = false; smActive = false; smState = null; return; }
    const step = smSeq.steps[smSeq.i];
    smSeq.t += dt;
    const u = clamp01(smSeq.t / step.dur);
    step.fn(u, { yaw: 0, y: baseY }, modelHeight);
    if (smSeq.i === 2 && u < 0.08) { sleeping = false; blinkTarget = 0; blinkPhase = 'idle'; nextBlinkAt = elapsed + 1; } // 起身即睁眼
    if (u >= 1) {
      smSeq.i++;
      smSeq.t = 0;
      if (smSeq.i >= smSeq.steps.length) {
        smSeq = null; smSeqLock = false; smActive = false; smState = null; // 完成：释放控制权
        resetAllBones();
        mesh.quaternion.identity(); mesh.rotation.set(0, 0, 0); mesh.position.set(0, baseY, 0);
        if (typeof frameCamera === 'function') frameCamera();   // 起身站立后重新取景
        return;
      }
    }
  }

  // 对外 API：进入指定静态状态（浮空/侧躺/睡眠）。唤醒请用 wake()。
  function smSetState(state) {
    if (smSeqLock) return false;                 // 唤醒锁定中不可打断
    if (!mesh || !skeleton) return false;
    if (state === SM_STATE.WAKE) return smStartWake();
    smEnter(state);
    return true;
  }
  function smWake() {
    if (!mesh || !skeleton) return false;
    return smStartWake();
  }
  function smStop() {
    smSeqLock = false; smSeq = null; smActive = false; smState = null;
    resetAllBones();
    mesh.quaternion.identity(); mesh.rotation.set(0, 0, 0); mesh.position.set(0, baseY, 0);
    if (typeof frameCamera === 'function') frameCamera();   // 回到正常站立取景
  }
  function smGetState() { return smState || (smActive ? 'active' : 'idle'); }

  let loopErrLogged = false;
  function startLoop() {
    running = true;
    clock.start();
    let lastRenderAt = 0; // 帧率封顶用：上次实际渲染的时间戳(ms)
    const loop = () => {
      if (!running) return;
      const dt = Math.min(clock.getDelta(), 0.05);
      // 帧率封顶：未到下一帧间隔则跳过本次渲染，仅续帧（避免高刷新率屏幕空转浪费 GPU）
      const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
      if (now - lastRenderAt < (1000 / TARGET_FPS - 1)) {
        rafId = requestAnimationFrame(loop);
        return;
      }
      lastRenderAt = now;
      try {
        update(dt);
      } catch (e) {
        // 单帧异常绝不让整个循环停掉：一旦停，模型会冻在首帧（看起来像"一张图片"）
        if (!loopErrLogged) {
          console.error('[MMD] 渲染循环单帧异常（已忽略，循环继续）:', e);
          loopErrLogged = true;
        }
      }
      rafId = requestAnimationFrame(loop);
    };
    rafId = requestAnimationFrame(loop);
  }

  let helperErrLogged = false;
  function update(dt) {
    elapsed += dt;
    if (helper && mesh) {
      try { helper.update(dt); }
      catch (e) {
        if (!helperErrLogged) {
          console.error('[MMD] helper.update 出错（已忽略）:', e);
          helperErrLogged = true;
        }
      }
    }

    if (mesh) {
      // 表情 morph 平滑过渡
      for (const idxStr in exprTarget) {
        const idx = +idxStr;
        const tgt = exprTarget[idx];
        const cur = morphInf[idx] || 0;
        morphInf[idx] = cur + (tgt - cur) * Math.min(1, dt * 10);
      }
      // 眨眼状态机
      if (blinkIdx >= 0) {
        if (sleeping) {
          blinkTarget = 1;
        } else if (blinkPhase === 'idle') {
          if (elapsed >= nextBlinkAt) {
            blinkPhase = 'close';
            blinkTimer = 0.09;
          }
        } else if (blinkPhase === 'close') {
          blinkTarget = 1;
          blinkTimer -= dt;
          if (blinkTimer <= 0) {
            blinkPhase = 'open';
            blinkTimer = 0.12;
          }
        } else if (blinkPhase === 'open') {
          blinkTarget = 0;
          blinkTimer -= dt;
          if (blinkTimer <= 0) {
            blinkPhase = 'idle';
            nextBlinkAt = elapsed + rand(2.5, 5.5);
          }
        }
        blinkValue += (blinkTarget - blinkValue) * Math.min(1, dt * 18);
        morphInf[blinkIdx] = blinkValue;
      }

      // ===== 动作优先：状态机 / AI 骨骼关键帧 / 关键帧动作 / 程序化动作 / 待机动作 =====
      // 角色状态机优先：smActive 时由状态机严格接管身体（浮空/侧躺/睡眠/唤醒），其余分支让位。
      // 模块4：AI 剪辑优先于内置动作与待机（Layer2 AI 动作层），结束后再回落到动作/待机。
      if (smActive) {
        smRender(dt);
      } else if (aiClipActive) {
        resetAllBones(); // 每帧从静止基线重算，得到干净的 AI 目标姿态
        const u = (elapsed - aiClipStart) / Math.max(1e-4, aiClip ? aiClip.dur : 1);
        if (!aiClip || u >= 1) {
          aiClipActive = false;
          aiClip = null;
          resetAllBones(); // 回到静止基线；applyLayerBlend 的 aiWeight 会平滑回落
        } else {
          applyAIPoseAt(u);
        }
      } else if (pendingEntry) {
        // 相关动作之间的间隔：延时期保持上一动作结束后的静止姿态
        if (pendingDelay > 0) pendingDelay -= dt;
        else { const e = pendingEntry; pendingEntry = null; startQueued(e); }
      } else if (activeAction) {
        resetAllBones(); // 每层每帧从静止基线重算，得到干净的动作目标姿态（消除未用骨骼的陈旧残留）
        // 时间轴断点：主动作（组合动作）播放期间到达 t 时切入该相关动作（视频剪辑式切轨），播完恢复主动作
        if (timedEntries.length && suspendedMain == null && activeAction.composed) {
          timedClock += dt;
          const due = timedEntries.find(te => !te.fired && timedClock >= te.fireAt);
          if (due) {
            due.fired = true;
            suspendedMain = { t: activeAction.t, dur: activeAction.dur, def: activeAction.def, key: activeAction.key, speed: activeAction.speed, base: activeAction.base, loop: activeAction.loop, bonesUsed: activeAction.bonesUsed, composed: true };
            const e = due.e;
            resetAllBones();
            const cutDef = customActions[e.key];
            if (cutDef) {
              activeAction = { key: e.key, def: cutDef, t: 0, dur: cutDef.duration || 1, base: suspendedMain.base, loop: false, replay: null, bonesUsed: collectBonesUsed(cutDef) };
            } else {
              activeAction = { key: e.key, def: null, t: 0, dur: (ACTIONS[e.key] ? ACTIONS[e.key].dur : 1), base: suspendedMain.base, loop: false, replay: null };
            }
          }
        }
        activeAction.t += dt * (activeAction.speed || 1);
        const u = clamp01(activeAction.t / activeAction.dur);
        if (activeAction.def) {
          playKeyframe(activeAction, u);
        } else {
          try { ACTIONS[activeAction.key].run(u, activeAction.base, modelHeight); }
          catch (e) { /* 单个动作函数异常忽略，避免冻结循环 */ }
        }
        if (u >= 1) {
          if (activeAction.loop) {
            activeAction.t = 0; // 循环重播（如预览/待机）
          } else if (activeAction.replay && activeAction.replay.count > 1) {
            // 相关动作重复播放：递减计数，按间隔延时后再重播
            activeAction.replay.count -= 1;
            if (activeAction.replay.interval > 0) {
              pendingEntry = normalizeRelatedEntry({ key: activeAction.key, count: activeAction.replay.count, interval: activeAction.replay.interval, loop: activeAction.replay.loop });
              pendingDelay = activeAction.replay.interval;
              if (suspendedMain) { activeAction = suspendedMain; suspendedMain = null; } else { activeAction = null; resetAllBones(); }
            } else {
              activeAction.t = 0; // 立即重播（计数已减）
            }
          } else {
            if (suspendedMain) {
              activeAction = suspendedMain; suspendedMain = null; // 恢复被切轨挂起的主动作，从断点处继续
            } else {
              activeAction = null;
              resetAllBones();
              const nxt = actionQueue.shift(); // 播放队列里的"相关动作"
              if (nxt) startQueued(nxt);
            }
          }
        }
      } else {
        resetAllBones(); // 待机也每帧从基线重算，保证呼吸叠加不逐帧累积
        // 默认程序化待机摆动（无定制待机动作时）
        const sway = Math.sin(elapsed * 0.6) * 0.14;        // 偏航 ±约 8°
        const tilt = Math.sin(elapsed * 0.9 + 1.2) * 0.03;  // 轻微侧倾
        mesh.rotation.y = sway;
        mesh.rotation.z = tilt;
        const breath = sleeping ? 0.03 : 0.10;
        let y = baseY + Math.sin(elapsed * (sleeping ? 0.8 : 1.4)) * breath;
        if (emote) {
          emote.t += dt;
          const p = emote.t / emote.dur;
          if (p >= 1) {
            emote = null;
          } else {
            y += Math.sin(p * Math.PI) * emote.amp;
          }
        }
        mesh.position.y = y;
        // === 待机"人类感"微动作：重心在双脚间缓慢左右转移 + 膝盖微屈 + 手臂轻摆（模型无关）===
        // 站立不再是"刚性雕像"——像人一样随呼吸把重心在双脚间缓慢晃动，承重侧膝略直、转移侧膝微屈。
        const ip = elapsed * 0.45;
        const w = Math.sin(ip);                             // -1..1 重心左右
        const kb = 0.09 * (0.5 + 0.5 * w);                 // 微屈膝幅度（克制，脚基本不离地）
        if (w >= 0) { foldLeg('lKnee', -1, 0.5, kb * w); foldLeg('rKnee', -1, 0.5, kb * 0.1); }
        else       { foldLeg('rKnee', -1, 0.5, kb * (-w)); foldLeg('lKnee', -1, 0.5, kb * 0.1); }
        poseBoneFromRest('lowerBody', { z: w * 0.03 });    // 髋随重心微侧倾（不是整体歪）
        const armSwing = w * 0.03;
        poseBoneFromRest('lArm', { z: -armSwing });
        poseBoneFromRest('rArm', { z: armSwing });
      }
      // 分层融合后处理：逐骨 Slerp 平滑（消除硬切 + Layer2 权重过渡）+ 正弦呼吸叠加（L1）
      applyLayerBlend(dt);
      // 模块3：毛发/软组织次级动力学（Layer3）叠加在已融合姿态之上（渲染用，不写回 prevPose）
      applyHairDynamics(dt);
      // 刚性/柔性碰撞物理：在动作引擎写好主骨架姿态后，让发/裙/布/胸等动态刚体在重力/约束下摆动，
      // 产生自然「肉体变形」与碰撞。仅作用于次级动态刚体，绝不改写主骨架 → 与动作引擎无冲突。
      if (physics) {
        try { physics.update(dt); }
        catch (e) { console.error('[MMD] physics.update 异常，禁用物理:', e); physics = null; physicsEnabled = false; hairEnabled = true; }
      }
    }

    if (exprHoldTimer > 0) {
      exprHoldTimer -= dt;
      if (exprHoldTimer <= 0 && !sleeping) resetExpr();
    }

    // 始终渲染：即便上面逻辑异常，也保证画面不冻结（仍显示当前姿态/摆动）
    if (renderer && scene && camera) {
      try { renderer.render(scene, camera); }
      catch (e) { /* 单帧渲染失败忽略，下一帧重试 */ }
    }
  }

  // 初始化 MMD 刚性/柔性碰撞物理。仅当模型确实带有可用动态刚体时才加载 Ammo（避免无谓开销），
  // 并把「动态(type1/2)且非主骨架」的刚体/约束交给 MMDPhysics；主骨架刚体(type0)与任何动态臂/腿骨
  // 一律排除，确保物理永不改写动作引擎驱动的骨骼。任何异常都置 physics=null 优雅降级。
  async function setupPhysics() {
    physics = null;
    physicsEnabled = false;
    hairEnabled = true; // 默认启用手写毛发弹簧；仅当物理成功启用时才关闭（见下文）
    const mmd = (mesh && mesh.geometry && mesh.geometry.userData && mesh.geometry.userData.MMD) || null;
    const allRB = (mmd && mmd.rigidBodies) || [];
    const allC = (mmd && mmd.constraints) || [];
    // 模型完全没有刚体 → 无需物理
    if (!allRB.length) {
      console.log('[MMD] 模型无刚体定义，跳过物理');
      return;
    }
    // 筛选：仅保留 动态(type1/2) 且 非主骨架 的刚体（发/裙/布/胸/臀 等软组织）
    const keep = [];
    // 动作引擎/编辑器直接驱动的 FK 骨骼（绝对不能被物理覆盖，否则下半身/四肢"编辑不了"、动作异常）。
    // 用 BONE_KEYS 的实际命中骨名做显式排除，作为正则的兜底——即使某模型用奇怪的腿骨命名，
    // 只要动作引擎在驱动它，物理就绝不碰它。
    const drivenNames = new Set();
    for (const k in BONE_KEYS) {
      const cands = BONE_KEYS[k];
      if (!cands) continue;
      for (const cn of cands) if (bones[cn]) drivenNames.add(cn);
    }
    let excludedByDriven = 0;
    for (let i = 0; i < allRB.length; i++) {
      const rb = allRB[i];
      if (rb.type === 0) continue;                 // 运动学主骨架刚体排除
      const b = (rb.boneIndex != null && rb.boneIndex >= 0) ? skeleton.bones[rb.boneIndex] : null;
      const bn = b ? b.name : '';
      if (MAIN_BONE_RE.test(bn)) continue;          // 动态臂/腿/躯干排除（防乱甩）
      if (drivenNames.has(bn)) { excludedByDriven++; continue; } // 动作引擎驱动的 FK 骨骼排除（保证下半身等可编辑）
      keep.push(i);
    }
    if (excludedByDriven) console.log('[MMD] 物理排除动作引擎驱动骨骼', excludedByDriven, '个（保证下半身/四肢可编辑）');
    if (!keep.length) {
      console.log('[MMD] 无可用次级动态刚体，跳过物理');
      return;
    }
    // 扩展刚体集合：把与已保留动态刚体相连的运动学(type0)锚点刚体也纳入（头/颈等）。
    // 原因：头发/裙子等动态刚体通常通过约束锚定在头/颈/躯干等运动学刚体上；
    // 若只保留动态刚体、过滤掉锚点刚体，则约束因"两端不全在集合内"被丢弃，头发失去锚点在重力下掉落。
    // 运动学刚体(type0)由骨骼驱动、物理不会改写它，纳入后仅作为约束锚点，安全无冲突。
    const keepSet = new Set(keep);
    const anchorSet = new Set();
    for (const c of allC) {
      const i1 = c.rigidBodyIndex1, i2 = c.rigidBodyIndex2;
      const k1 = keepSet.has(i1), k2 = keepSet.has(i2);
      if (k1 && !k2 && allRB[i2] && allRB[i2].type === 0) anchorSet.add(i2);
      if (k2 && !k1 && allRB[i1] && allRB[i1].type === 0) anchorSet.add(i1);
    }
    const fullKeepSet = new Set([...keepSet, ...anchorSet]);
    // 约束：至少一端是已保留动态刚体即纳入（另一端可以是运动学锚点），保证头发/裙子约束不丢失
    const cFiltered = allC.filter((c) => keepSet.has(c.rigidBodyIndex1) || keepSet.has(c.rigidBodyIndex2));
    const rbFiltered = [...fullKeepSet].map((i) => allRB[i]);
    const ok = await ensureAmmo();
    if (!ok) { console.warn('[MMD] Ammo 未就绪，物理降级'); return; }
    try {
      const p = new MMDPhysics(mesh, rbFiltered, cFiltered, { maxStepNum: 3, unitStep: 1 / 65 });
      p.reset();
      physics = p;
      physicsEnabled = true;
      hairEnabled = false; // 物理已驱动发/裙等次级部位，关闭手写弹簧避免双重摆动
      console.log('[MMD] 物理已启用：动态刚体', keepSet.size, '个，运动学锚点', anchorSet.size, '个，约束', cFiltered.length, '条');
    } catch (e) {
      console.error('[MMD] 创建 MMDPhysics 失败，物理降级:', e);
      physics = null;
      physicsEnabled = false;
    }
  }

  async function load(pmxUrl) {
    if (!initRenderer()) {
      console.error('[MMD] 初始化渲染器失败，放弃加载 3D 模型');
      return false;
    }
    // 自定义 LoadingManager：把 PMX/贴图里的 Windows 反斜杠路径规范成正斜杠，
    // 否则 MMDLoader 拼出的 file:///.../tex\发.png 会加载失败（中文贴图名也会受影响）。
    const manager = new THREE.LoadingManager();
    const origResolve = manager.resolveURL ? manager.resolveURL.bind(manager) : (u) => u;
    manager.resolveURL = (url) => origResolve(url.replace(/\\/g, '/'));

    const loader = new MMDLoader(manager);
    return new Promise((resolve) => {
      loader.load(
        pmxUrl,
        async (m) => {
          mesh = m;
          currentPmxName = (pmxUrl.split(/[\\/]/).pop().split('?')[0]) || 'model';
          mesh.traverse((o) => {
            if (o.isMesh) {
              o.frustumCulled = false;
              if (o.material) {
                // 双面渲染，避免 MMD 某些面被背面剔除导致破洞
                if (Array.isArray(o.material)) o.material.forEach((mm) => (mm.side = THREE.DoubleSide));
                else o.material.side = THREE.DoubleSide;
                // 修复"灰蒙蒙"：把颜色贴图标记为 sRGB，否则被线性采样导致整体发灰发白。
                const mats = Array.isArray(o.material) ? o.material : [o.material];
                for (const mm of mats) {
                  if (mm.map && mm.map.colorSpace !== THREE.SRGBColorSpace) {
                    mm.map.colorSpace = THREE.SRGBColorSpace;
                    mm.map.needsUpdate = true;
                  }
                  if (mm.emissiveMap && mm.emissiveMap.colorSpace !== THREE.SRGBColorSpace) {
                    mm.emissiveMap.colorSpace = THREE.SRGBColorSpace;
                    mm.emissiveMap.needsUpdate = true;
                  }
                  // MMD toon 渐变贴图(ramp/toon)也是颜色数据，标 sRGB 避免发灰
                  if (mm.gradientMap && mm.gradientMap.colorSpace !== THREE.SRGBColorSpace) {
                    mm.gradientMap.colorSpace = THREE.SRGBColorSpace;
                    mm.gradientMap.needsUpdate = true;
                  }
                }
              }
            }
          });
          scene.add(mesh);
          // 物理由下方 setupPhysics() 经 MMDPhysics(Ammo) 单独启用，并【仅】作用于发/裙/布/胸等
          // 次级动态刚体；主骨架(臂/腿/躯干)永远是运动学(type0)透传，程序化动作引擎照常驱动，二者不冲突。
          // 若以后要播放真实 VMD 动作，再 helper.add(mesh, {physics:true}) 并在播放时让出控制权。
          helper = null;
          discoverMorphs();
          buildBones();
          applyRelax(); // 让手臂/姿态呈现自然放松站姿（解决"手放不下/姿势僵硬"）
          await setupPhysics(); // 初始化刚性/柔性碰撞物理（Ammo/MMDPhysics，含优雅降级）
          frameCamera();
          nextBlinkAt = elapsed + rand(1, 3);
          startLoop();
          // 加载后进入「自然站立待机」（smActive=false）：呼吸/眨眼/重心微移/膝微屈，
          // 不再强制侧躺（修复「初始为侧躺」）。侧躺/睡眠仍可由状态机按钮或「睡觉」指令触发。
          resolve(true);
        },
        undefined,
        (err) => {
          console.error('[MMD] 模型加载失败:', err);
          resolve(false);
        }
      );
    });
  }

  // 组合模型包：加载附加部件（如武器 .pmx）到同一场景，仅做显示（不参与骨骼动作引擎）。
  // opts: { position:[x,y,z], rotation:[x,y,z](弧度), scale:number, comboIndex:number }
  // 附加模型会被挂到主模型 mesh 之下（mesh.attach），从而自动跟随主模型的空闲摇摆/跳动变换，
  // 武器不会在动画时脱离人物。变换仅在提供了数值时才覆盖，默认保留模型原始位姿。
  // 返回 Promise<boolean>。附加模型与主模型共享相机/光照/渲染循环。
  function addModel(pmxUrl, opts) {
    opts = opts || {};
    const manager = new THREE.LoadingManager();
    const origResolve = manager.resolveURL ? manager.resolveURL.bind(manager) : (u) => u;
    manager.resolveURL = (url) => origResolve(url.replace(/\\/g, '/'));
    const loader = new MMDLoader(manager);
    return new Promise((resolve) => {
      loader.load(
        pmxUrl,
        (m) => {
          m.traverse((o) => {
            if (o.isMesh) {
              o.frustumCulled = false;
              if (o.material) {
                if (Array.isArray(o.material)) o.material.forEach((mm) => (mm.side = THREE.DoubleSide));
                else o.material.side = THREE.DoubleSide;
                const mats = Array.isArray(o.material) ? o.material : [o.material];
                for (const mm of mats) {
                  if (mm.map && mm.map.colorSpace !== THREE.SRGBColorSpace) {
                    mm.map.colorSpace = THREE.SRGBColorSpace;
                    mm.map.needsUpdate = true;
                  }
                  if (mm.emissiveMap && mm.emissiveMap.colorSpace !== THREE.SRGBColorSpace) {
                    mm.emissiveMap.colorSpace = THREE.SRGBColorSpace;
                    mm.emissiveMap.needsUpdate = true;
                  }
                  if (mm.gradientMap && mm.gradientMap.colorSpace !== THREE.SRGBColorSpace) {
                    mm.gradientMap.colorSpace = THREE.SRGBColorSpace;
                    mm.gradientMap.needsUpdate = true;
                  }
                }
              }
            }
          });
          // 挂到主模型之下：先刷新世界矩阵，attach 会保留当前世界位姿并改为相对父级，
          // 之后主模型的每帧变换（摇摆/跳动）会自动带动此部件。
          m.updateMatrixWorld(true);
          if (mesh && mesh.parent) {
            mesh.attach(m);
          } else {
            scene.add(m);
          }
          // 应用部件相对变换（微调位姿，用于把武器精确放到手上）
          if (opts.position) m.position.set(opts.position[0], opts.position[1], opts.position[2]);
          if (opts.rotation) m.rotation.set(opts.rotation[0], opts.rotation[1], opts.rotation[2]);
          if (typeof opts.scale === 'number' && opts.scale > 0) m.scale.setScalar(opts.scale);
          m.userData.partTransform = opts;
          m.userData.comboIndex = (typeof opts.comboIndex === 'number') ? opts.comboIndex : -1;
          extraMeshes.push(m);
          // 把附加部件的骨骼补进全局注册表，使其细节关节（手掌/手指等）也能被动作引擎操作
          collectBones();
          buildBreathBoneSet();
          buildHairSet();
          resolve(true);
        },
        undefined,
        (err) => {
          console.error('[MMD] 附加模型加载失败:', err);
          resolve(false);
        }
      );
    });
  }

  // 返回当前附加部件网格数组（供前端微调位姿用）
  function getExtraMeshes() {
    return extraMeshes.slice();
  }

  function resize(w, h) {
    if (!renderer) return;
    lastWidth = w;
    lastHeight = h;
    renderer.setSize(w, h, false);
    if (camera) {
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    }
  }

  // ★ 动态设置渲染倍率（0.5~2.0），实时调节 3D 模型清晰度
  function setRenderScale(scale) {
    if (!renderer || typeof scale !== 'number' || !isFinite(scale) || scale <= 0) return;
    currentRenderScale = scale;
    const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    renderer.setPixelRatio(dpr * scale);
    // 重新应用尺寸，使新的像素比生效
    renderer.setSize(lastWidth, lastHeight, false);
    console.log('[MMD] setRenderScale:', scale, 'pixelRatio:', (dpr * scale).toFixed(2));
  }

  function destroy() {
    running = false;
    activeAction = null;
    if (rafId) cancelAnimationFrame(rafId);
    if (helper && mesh) {
      try {
        helper.remove(mesh);
      } catch (e) {
        /* ignore */
      }
    }
    if (mesh) {
      mesh.traverse((o) => {
        if (o.isMesh) {
          o.geometry && o.geometry.dispose && o.geometry.dispose();
          if (Array.isArray(o.material)) o.material.forEach((mm) => mm.dispose && mm.dispose());
          else o.material && o.material.dispose && o.material.dispose();
        }
      });
      if (scene) scene.remove(mesh);
    }
    for (const em of extraMeshes) {
      try {
        em.traverse((o) => {
          if (o.isMesh) {
            o.geometry && o.geometry.dispose && o.geometry.dispose();
            if (Array.isArray(o.material)) o.material.forEach((mm) => mm.dispose && mm.dispose());
            else o.material && o.material.dispose && o.material.dispose();
          }
        });
        if (scene) scene.remove(em);
      } catch (e) { /* ignore */ }
    }
    extraMeshes = [];
    if (renderer) {
      renderer.dispose();
      if (renderer.forceContextLoss) renderer.forceContextLoss();
    }
    mesh = null;
    renderer = null;
    scene = null;
    camera = null;
    helper = null;
  }

  return {
    load,
    addModel,
    getExtraMeshes, // () => 返回当前附加部件网格数组（组合模型微调用）
    playIntent,
    playCombo,
    stopCombo,
    hitTest,
    runAction,
    runCommand,
    listActions,
    isIntentAvailable, // (intent) 判断右键菜单 act:xxx 是否可播放（已删除内置动作返回 false）
    setActions,      // (data) 载入每模型动作配置（自定义关键帧动作 + 相关动作 + 待机）
    setModelConfig,  // (cfg) 注入模块1 资产配置（bone_limit 角度钳制 / breath 呼吸；缺省降级默认）
    generateModelConfig, // () => 生成 pet_model_config.json 内容（bindpose_check/rest_correction/bone_limit/breath）
    getModelConfig,  // () => 返回当前生效的 modelConfig
    setHairPhysics,  // (cfg) 模块3：运行时覆盖毛发次级动力学参数（enable/stiffness/damping/max_deg/sensitivity）
    previewAction,   // (def) 预览某个关键帧动作定义（循环播放）
    getBuiltinActions, // () => [{key,label}] 内置动作清单（供编辑器列出）
    // 逐关节控制（供 AI / 调试 / 命令输入摆 pose）
    poseBone,        // (name, {x,y,z}) 在静止基线上叠加相对旋转（弧度）
    resetBones,      // 把所有关节复位到静止基线
    listBones,       // 返回模型全部骨骼名（用于发现可用关节名）
    listBoneKeys,    // 返回 BONE_KEYS 逻辑键 → 实际命中骨骼名（null 表示未命中），便于调试下半身等键是否生效
    getMissingBones, // 返回本次加载以来累计未命中的骨骼键及次数
    getBoneMapDebug, // 调试用：返回完整骨骼映射 + 未命中统计 (keyname -> {bone_name, hit_count})
    // 模块4：AI 骨骼偏移关键帧
    playAIPose,      // (raw) 播 AI 剪辑（{duration,keyframes}，度，相对 rest 偏移）；返回 true=已播 / false=解析失败（走意图兜底）
    stopAIPose,      // () 停止正在播放的 AI 剪辑（权重平滑回落）
    getCurrentPose,  // () => 当前相对静止基线的逐骨偏移（度），供拼 AI prompt
    setExpression,
    setSleeping,
    setMood,
    // 角色状态机（严格顺序控制：浮空 / 侧躺 / 睡眠 / 唤醒）
    enterState: smSetState,      // (state) => 进入静态状态 'floating'|'sideling'|'sleep'（唤醒请用 wake）
    wake: smWake,                // () => 触发锁定唤醒序列（伸懒腰→打哈欠→躺→站），不可跳步/错乱
    stopStateMachine: smStop,    // () => 释放状态机，回到正常站立待机交互
    getState: smGetState,        // () => 当前状态名
    resize,
    setRenderScale, // ★ 动态设置渲染倍率（0.5~2.0），实时调节 3D 模型清晰度
    destroy,
    get ready() {
      return !!mesh;
    }
  };
}
