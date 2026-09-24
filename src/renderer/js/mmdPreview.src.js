// mmdPreview.src.js — 主窗口动作编辑器的「嵌入式实时 3D 预览」
// 与 mmdPet 共用同一套骨骼逻辑与关键帧插值，保证编辑器里看到的姿态 == 龙虾里实际播放的姿态。
// 经 .workbuddy/mmdbuild/preview.build.js 用 esbuild 打成 IIFE 全局 MmdPreview，
// 在主窗口(index.html)按需懒加载。WebGL2 + GLSL3（MMD 蒙皮着色器要求）。
import * as THREE from 'three';
import { MMDLoader } from 'three/addons/loaders/MMDLoader.js';

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
const BLINK_NAMES = ['瞬き', 'まばたき', 'ウィンク', '閉じ', 'blink', 'wink'];

function findMorphIndex(dict, keywords) {
  if (!dict) return -1;
  const lower = keywords.map((k) => k.toLowerCase());
  for (const name in dict) {
    const nl = name.toLowerCase();
    for (const k of lower) if (nl === k || nl.includes(k)) return dict[name];
  }
  return -1;
}

export function createMmdPreview(canvas) {
  let renderer = null, scene = null, camera = null, mesh = null;
  let skeleton = null, bones = {}, boneRest = {}, baseQuats = {};
  let morphDict = {}, morphInf = [], exprIndex = {}, blinkIdx = -1;
  let running = false, rafId = 0, clock = null;
  let baseY = 0, modelHeight = 20, modelWidth = 20;
  let basePose = { yaw: 0, pitch: 0, roll: 0, y: 0 };
  let def = null, playing = false, u = 0, onTick = null;
  // 轨道视角（供可视化编辑器：拖拽旋转 / 滚轮缩放）
  let view = { yaw: 0, pitch: 0, zoom: 1 };
  let camTarget = null, camDist = 0, camBaseElev = 0;
  // 预览专用「模型组件调整」：整体/选中的身体部件位移与缩放，仅作用于预览，永不写入关键帧（不影响保存姿态）
  let previewAdjust = { root: { dx: 0, dy: 0, dz: 0, scale: 1, rx: 0, ry: 0, rz: 0 }, part: null };
  let boneRestPos = {}, boneRestScale = {};
  // 玩具式惯性（secondary motion）：拖拽某关节时，相连关节因惯性滞后、回弹，呈现“软玩具”手感。
  // 仅做旋转偏移，绝不位移/缩放 → 骨骼长度/粗细/大小始终恒定。
  let cleanLocal = {};   // 每帧的“干净”局部姿态（动画或静止），作为叠加基准，避免惯性累积
  let sway = {};         // 每个骨骼的惯性偏移角度（弧度，局部）
  let swayVel = {};      // 对应的角速度
  let lastWorldQ = {};   // 上一帧各骨骼世界四元数（求角速度）
  let _lastAdjustT = 0;
  let _lastPartName = null;
  const INERTIA_K = 26;       // 弹簧刚度（拉回刚性跟随）
  const INERTIA_C = 4.5;      // 阻尼（越小越“弹”）
  const INERTIA_G = 0.8;      // 父关节运动对子关节的带动强度（惯性滞后/跟随）
  const INERTIA_G_ANCE = 0.5; // 被拖拽关节向上（祖先链）甩动强度
  const INERTIA_DECAY = 0.5;  // 祖先链逐层衰减
  const SWAY_MAX = 0.8;       // 单轴最大偏移（弧度）
  const SWAY_VEL_MAX = 9;     // 最大角速度（弧度/秒）
  const _q1 = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _q3 = new THREE.Quaternion(), _q4 = new THREE.Quaternion(), _v1 = new THREE.Vector3();

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

  function clamp01(x) { return x < 0 ? 0 : (x > 1 ? 1 : x); }
  function easeInOut(x) { return x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2; }
  function quatFromEuler(e) { return new THREE.Quaternion().setFromEuler(new THREE.Euler(e.x || 0, e.y || 0, e.z || 0, 'ZXY')); }
  // 把单位四元数转成“旋转向量”（轴*角），用于比较两帧世界朝向的变化（角速度近似）
  function rotVecFromQuat(q) {
    let w = q.w; if (w > 1) w = 1; else if (w < -1) w = -1;
    let ang = 2 * Math.acos(w);
    if (ang > Math.PI) ang -= 2 * Math.PI; else if (ang < -Math.PI) ang += 2 * Math.PI;
    const s = Math.sqrt(Math.max(0, 1 - w * w));
    if (s < 1e-7) return _v1.set(0, 0, 0);
    const k = ang / s;
    return _v1.set(q.x * k, q.y * k, q.z * k);
  }
  // 由小角度旋转向量构造四元数（sway 偏移）
  function swayQuatFromVec(out, v) {
    const ang = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
    if (ang < 1e-7) return out.identity();
    const h = ang / 2, s = Math.sin(h) / ang;
    return out.set(v.x * s, v.y * s, v.z * s, Math.cos(h));
  }
  function bone(name) {
    const keys = BONE_KEYS[name];
    if (keys) for (const k of keys) if (bones[k]) return bones[k];
    return bones[name] || null;
  }
  // 调试：累计未命中的逻辑骨骼键，便于发现模型用了 BONE_KEYS 未覆盖的命名
  const _missedBones = new Map(); // name -> count
  function poseBoneFromRest(name, euler) {
    const b = bone(name);
    if (!b) {
      const c = (_missedBones.get(name) || 0) + 1;
      _missedBones.set(name, c);
      if (c === 1) console.warn('[Preview] 逻辑骨骼未匹配到任何模型骨骼:', name, '（次数+' + c + '）', '— 可能此模型用了未在 BONE_KEYS 命中的命名，请在 mmdPreview.src.js 的 BONE_KEYS 加入候选别名');
      if (c === 50 || c === 200) console.warn('[Preview] 同一骨骼键', name, '已累计', c, '次未命中');
      return false;
    }
    const base = baseQuats[b.name] || boneRest[b.name];
    if (base) b.quaternion.copy(base); else b.rotation.set(0, 0, 0);
    if (euler && (euler.x || euler.y || euler.z)) b.quaternion.multiply(quatFromEuler(euler));
    return true;
  }
  function relaxBone(name, euler) {
    const b = bone(name);
    if (!b) return;
    const r = boneRest[b.name];
    if (r) b.quaternion.copy(r); else b.rotation.set(0, 0, 0);
    if (euler && (euler.x || euler.y || euler.z)) b.quaternion.multiply(quatFromEuler(euler));
  }
  // 把单条上臂自然垂落到身体一侧（模型无关，同 mmdPet 的 dropArmToSide）
  const _armDown = new THREE.Vector3(0, -1, 0);
  const _armDir = new THREE.Vector3();
  const _armQW = new THREE.Quaternion();
  const _armPQW = new THREE.Quaternion();
  const _armCorr = new THREE.Quaternion();
  const _armPInv = new THREE.Quaternion();
  function dropArmToSide(name) {
    const arm = bone(name);
    if (!arm || !arm.parent) return;
    arm.getWorldQuaternion(_armQW);
    arm.parent.getWorldQuaternion(_armPQW);
    _armDir.set(0, 1, 0).applyQuaternion(_armQW).normalize();
    if (_armDir.dot(_armDown) > 0.985) return;
    if (_armDir.dot(_armDown) < -0.9) return;
    _armCorr.setFromUnitVectors(_armDir, _armDown);
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
  function applyRelax() {
    if (!skeleton) return;
    for (const b of skeleton.bones) { const r = boneRest[b.name]; if (r) b.quaternion.copy(r); }
    relaxBone('lShoulder', { z: 0.12, x: 0.05 });
    relaxBone('rShoulder', { z: -0.12, x: -0.05 });
    relaxBone('lArm', { x: 0.08 });
    relaxBone('rArm', { x: -0.08 });
    relaxBone('upperBody2', { x: 0.05 });
    dropArmsToSides(); // 模型无关：双臂对齐到垂直向下（自然站立）
    for (const b of skeleton.bones) { const base = baseQuats[b.name]; if (base) base.copy(b.quaternion); }
  }
  function resetAllBones() {
    if (!skeleton) return;
    for (const b of skeleton.bones) { const base = baseQuats[b.name]; if (base) b.quaternion.copy(base); }
  }
  function collectBonesUsed(d) {
    const set = new Set();
    for (const kf of (d.keyframes || [])) for (const b in (kf.bones || {})) set.add(b);
    return [...set];
  }
  function playKeyframe(act, u) {
    const kfs = act.def.keyframes;
    if (!kfs || !kfs.length || !mesh) return;
    let k0 = kfs[0], k1 = kfs[kfs.length - 1];
    if (u <= kfs[0].t) { k0 = k1 = kfs[0]; }
    else if (u >= kfs[kfs.length - 1].t) { k0 = k1 = kfs[kfs.length - 1]; }
    else for (let i = 0; i < kfs.length - 1; i++) {
      if (u >= kfs[i].t && u <= kfs[i + 1].t) { k0 = kfs[i]; k1 = kfs[i + 1]; break; }
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
    const r0 = k0.root || {}, r1 = k1.root || {};
    const ry = (r0.y || 0) + ((r1.y || 0) - (r0.y || 0)) * e;
    mesh.position.y = act.base.y + ry * modelHeight;
    mesh.rotation.y = act.base.yaw + ((r0.rotY || 0) + ((r1.rotY || 0) - (r0.rotY || 0)) * e);
    mesh.rotation.x = act.base.pitch + ((r0.rotX || 0) + ((r1.rotX || 0) - (r0.rotX || 0)) * e);
    mesh.rotation.z = act.base.roll + ((r0.rotZ || 0) + ((r1.rotZ || 0) - (r0.rotZ || 0)) * e);
    const m0 = k0.morphs || {}, m1 = k1.morphs || {};
    const mkeys = new Set([...Object.keys(m0), ...Object.keys(m1)]);
    for (const emo of mkeys) {
      const w = (m0[emo] || 0) + ((m1[emo] || 0) - (m0[emo] || 0)) * e;
      const list = exprIndex[emo];
      if (list) for (const { idx } of list) morphInf[idx] = w;
    }
    // 记录“干净”局部姿态（动画/静止），作为惯性叠加基准；applyAdjust 由渲染循环每帧驱动
    for (const b of skeleton.bones) {
      let c = cleanLocal[b.name];
      if (!c) { c = new THREE.Quaternion(); cleanLocal[b.name] = c; }
      c.copy(b.quaternion);
    }
    // [DEBUG-LB] 无条件全程打 bonesUsed（限速），定位“下半身改不了”
    if (!window.__PLAY_LOG_COUNT) window.__PLAY_LOG_COUNT = 0;
    if (window.__PLAY_LOG_COUNT < 50) {
      window.__PLAY_LOG_COUNT++;
      const lbKey = (k0.bones && k0.bones.lowerBody) || (k1.bones && k1.bones.lowerBody) || null;
      console.log('[Preview][play] u=' + u.toFixed(3) +
        ' bonesUsed=' + JSON.stringify(act.bonesUsed) +
        ' hasLowerBody=' + (!!lbKey) +
        ' lowerBodyVal=' + (lbKey ? JSON.stringify(lbKey) : 'none'));
    }
  }

  // 预览专用：把「模型组件调整」叠加到当前姿态上，并叠加玩具式惯性（secondary motion）。
  // 关键约束：身体部件【以位移方式移动关节】，绝不做缩放——保证骨骼长度、粗细、大小恒定，
  // 其他部件不会被拉伸/扭曲。移动关节时其下游子骨骼刚性跟随（随手势平移），不会产生旋转累积（不会一直转）。
  // 惯性系统（sway）仅对“旋转”输入生效；纯位移不动关节朝向，故不会触发旋转惯性、不会停不下来。
  // 由渲染循环每帧驱动：拖拽某关节 → 被抓关节刚性跟随手（平移），相连关节（子链/祖先链）随层级刚性跟随。
  // 绝不写入 def/keyframes。
  function applyAdjust() {
    if (!mesh || !skeleton) return;
    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    let dt = (now - _lastAdjustT) / 1000; _lastAdjustT = now;
    if (!(dt > 0)) dt = 0.016; if (dt > 0.05) dt = 0.05; if (dt < 0.001) dt = 0.001;

    // 位移/缩放复位到静止姿态（恒定长度/粗细）
    for (const b of skeleton.bones) {
      const rp = boneRestPos[b.name], rs = boneRestScale[b.name];
      if (rp) b.position.copy(rp);
      if (rs) b.scale.copy(rs);
    }
    // 整体模型取景变换
    mesh.position.x = previewAdjust.root.dx;
    mesh.position.z = previewAdjust.root.dz;
    mesh.scale.setScalar(previewAdjust.root.scale > 0 ? previewAdjust.root.scale : 1);
    if (previewAdjust.root.dy) mesh.position.y += previewAdjust.root.dy * modelHeight;
    if (previewAdjust.root.rx || previewAdjust.root.ry || previewAdjust.root.rz) {
      mesh.rotation.x += previewAdjust.root.rx;
      mesh.rotation.y += previewAdjust.root.ry;
      mesh.rotation.z += previewAdjust.root.rz;
    }

    const p = previewAdjust.part;
    const active = !!(p && p.name);
    const pickedB = active ? bone(p.name) : null;

    // 1) 确保“干净”局部基准存在（首帧/静态模型从当前骨骼取），随后把每个骨骼重置回干净姿态
    for (const b of skeleton.bones) {
      let c = cleanLocal[b.name];
      if (!c) { c = new THREE.Quaternion(); cleanLocal[b.name] = c; c.copy(b.quaternion); }
      b.quaternion.copy(c);
    }
    // 1.5) 刷新世界矩阵，供下方把“世界位移增量”转换到父骨骼局部坐标
    mesh.updateMatrixWorld(true);
    // 2) 被抓关节：用户直接控制（刚性跟随手）——以「位移」方式移动关节（非旋转，避免拖拽时一直旋转停不下来）。
    //    dx/dy/dz 为世界空间增量；按其父骨骼世界朝向反变换到父局部坐标后，叠加到基准位置；下游子骨骼随层级刚性跟随。
    if (pickedB) {
      const rp = boneRestPos[pickedB.name];
      if (rp) {
        pickedB.position.copy(rp);
        const parent = pickedB.parent;
        if (parent && parent.isBone) {
          parent.getWorldQuaternion(_q2); _q2.invert();
          _v1.set(p.dx || 0, p.dy || 0, p.dz || 0).applyQuaternion(_q2);
          pickedB.position.add(_v1);
        } else {
          pickedB.position.x += p.dx || 0; pickedB.position.y += p.dy || 0; pickedB.position.z += p.dz || 0;
        }
      }
    }
    // 3) 其他关节：在干净姿态上叠加惯性偏移（sway），每帧从基准重算 → 不累积
    for (const b of skeleton.bones) {
      if (b === pickedB) continue;
      const sv = sway[b.name];
      if (sv && (sv.x || sv.y || sv.z)) {
        swayQuatFromVec(_q1, sv);
        b.quaternion.copy(cleanLocal[b.name]).multiply(_q1);
      }
    }
    // 更新世界矩阵，供惯性积分读取世界朝向
    mesh.updateMatrixWorld(true);

    if (!active) {
      // 未选中部件：清空惯性，回归干净姿态
      for (const b of skeleton.bones) {
        const s = sway[b.name]; if (s) { s.x = 0; s.y = 0; s.z = 0; }
        const v = swayVel[b.name]; if (v) { v.x = 0; v.y = 0; v.z = 0; }
      }
      lastWorldQ = {};
      return;
    }

    // 4) 惯性积分（为下一帧计算偏移）：每个关节 = 阻尼扭转弹簧，父运动带动子滞后
    for (const b of skeleton.bones) {
      if (b === pickedB) continue; // 被抓关节由用户控制，不施惯性
      b.getWorldQuaternion(_q1); // 本帧世界朝向
      const prev = lastWorldQ[b.name];
      if (!prev) { // 首帧：仅记录，不施力
        let q = lastWorldQ[b.name]; if (!q) { q = new THREE.Quaternion(); lastWorldQ[b.name] = q; }
        q.copy(_q1);
        const v = swayVel[b.name] || (swayVel[b.name] = { x: 0, y: 0, z: 0 });
        v.x = v.y = v.z = 0;
        const s = sway[b.name] || (sway[b.name] = { x: 0, y: 0, z: 0 });
        s.x = s.y = s.z = 0;
        continue;
      }
      // 父关节世界变化 → 本关节局部带动（惯性滞后来源）
      let tx = 0, ty = 0, tz = 0;
      const parent = b.parent;
      if (parent && parent.isBone && lastWorldQ[parent.name]) {
        parent.getWorldQuaternion(_q3);
        _q2.copy(lastWorldQ[parent.name]).invert().multiply(_q3); // 父世界角位移
        rotVecFromQuat(_q2); // → _v1（世界空间）
        _q4.copy(_q1).conjugate(); // 本关节世界逆（转到局部）
        _v1.applyQuaternion(_q4);
        tx = _v1.x; ty = _v1.y; tz = _v1.z;
      }
      const sv = swayVel[b.name] || (swayVel[b.name] = { x: 0, y: 0, z: 0 });
      const s = sway[b.name] || (sway[b.name] = { x: 0, y: 0, z: 0 });
      // 玩具惯性：父关节运动给子关节一个“被拖拽”的速度脉冲（与父运动反向 → 滞后跟随）；
      // 再叠加弹簧(拉回刚性跟随)与阻尼，停止拖拽后回弹、摇摆后归位。
      // tx/ty/tz 已是父本帧世界角位移（弧度），直接作为速度脉冲注入（与帧率无关）。
      sv.x += -INERTIA_G * tx;
      sv.y += -INERTIA_G * ty;
      sv.z += -INERTIA_G * tz;
      sv.x += (-INERTIA_K * s.x - INERTIA_C * sv.x) * dt;
      sv.y += (-INERTIA_K * s.y - INERTIA_C * sv.y) * dt;
      sv.z += (-INERTIA_K * s.z - INERTIA_C * sv.z) * dt;
      sv.x = Math.max(-SWAY_VEL_MAX, Math.min(SWAY_VEL_MAX, sv.x));
      sv.y = Math.max(-SWAY_VEL_MAX, Math.min(SWAY_VEL_MAX, sv.y));
      sv.z = Math.max(-SWAY_VEL_MAX, Math.min(SWAY_VEL_MAX, sv.z));
      s.x += sv.x * dt; s.y += sv.y * dt; s.z += sv.z * dt;
      s.x = Math.max(-SWAY_MAX, Math.min(SWAY_MAX, s.x));
      s.y = Math.max(-SWAY_MAX, Math.min(SWAY_MAX, s.y));
      s.z = Math.max(-SWAY_MAX, Math.min(SWAY_MAX, s.z));
      let q = lastWorldQ[b.name]; if (!q) { q = new THREE.Quaternion(); lastWorldQ[b.name] = q; }
      q.copy(_q1);
    }

    // 5) 被拖拽关节向上（祖先链）甩动：让“拉手 → 整条手臂像玩具一样摆动”
    if (pickedB) {
      const pw = lastWorldQ[pickedB.name];
      if (pw) {
        pickedB.getWorldQuaternion(_q3);
        _q2.copy(pw).invert().multiply(_q3); // 被拖关节世界角位移
        rotVecFromQuat(_q2); // → _v1（世界空间）
        const prx = _v1.x, pry = _v1.y, prz = _v1.z;
        let depth = 0, cur = pickedB.parent;
        while (cur && cur.isBone) {
          depth++;
          const decay = Math.pow(INERTIA_DECAY, depth);
          cur.getWorldQuaternion(_q1); _q1.conjugate(); // 祖先世界逆
          _v1.set(prx, pry, prz).applyQuaternion(_q1); // 转到祖先局部
          const sv = swayVel[cur.name] || (swayVel[cur.name] = { x: 0, y: 0, z: 0 });
          // 祖先链被“甩动”：与父带动同号（反向于被拖关节运动 → 滞后跟随），逐层衰减
          sv.x += -INERTIA_G_ANCE * decay * _v1.x;
          sv.y += -INERTIA_G_ANCE * decay * _v1.y;
          sv.z += -INERTIA_G_ANCE * decay * _v1.z;
          cur = cur.parent;
        }
      }
    }
  }

  function initRenderer() {
    const ctxAttrs = { alpha: true, antialias: true, depth: true, stencil: false, premultipliedAlpha: false, preserveDrawingBuffer: false, failIfMajorPerformanceCaveat: false };
    const tryCtx = (name) => { try { return canvas.getContext(name, ctxAttrs); } catch (e) { return null; } };
    const gl = tryCtx('webgl2');
    if (!gl || gl.isContextLost()) { console.error('[Preview] 需要 WebGL2'); return false; }
    renderer = new THREE.WebGLRenderer({ canvas, context: gl, alpha: true, antialias: true, premultipliedAlpha: false });
    renderer.setClearColor(0x000000, 0);
    const w = canvas.clientWidth || 280, h = canvas.clientHeight || 300;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(w, h, false);
    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(35, w / h, 0.1, 3000);
    // 与 mmdPet 一致的「通透」画质：sRGB 输出 + NoToneMapping + 高对比布光 + 轮廓光
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.NoToneMapping;
    // 布光：极低白色环境光 + 低半球光，最大限度保留模型固有色（不再被白光冲淡）；
    // 主光提亮补偿、补光冷色填充暗部、暖轮廓光勾边——高对比度让颜色鲜艳不灰。
    scene.add(new THREE.AmbientLight(0xffffff, 0.14));
    const key = new THREE.DirectionalLight(0xffffff, 3.5); key.position.set(0.5, 1.2, 0.8); scene.add(key);
    const fill = new THREE.DirectionalLight(0xbfd4ff, 0.7); fill.position.set(-0.8, 0.4, -0.5); scene.add(fill);
    const rim = new THREE.DirectionalLight(0xffd9b0, 1.8); rim.position.set(-0.3, 0.8, -1.0); scene.add(rim);
    scene.add(new THREE.HemisphereLight(0xffffff, 0x555566, 0.18));
    return true;
  }
  function frameCamera() {
    mesh.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(mesh);
    if (box.isEmpty()) return;
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    mesh.position.x -= center.x; mesh.position.z -= center.z; mesh.position.y -= box.min.y;
    baseY = mesh.position.y;
    modelHeight = size.y || 20;
    modelWidth = size.x || 20;
    fitCamera();
  }
  // 按当前宽高比把模型「等比适配」到视口：始终居中、完整可见、随画布大小等比缩放（原地不动）
  function fitCamera() {
    if (modelHeight <= 0 || !camera) return;
    const aspect = (camera.aspect && isFinite(camera.aspect) && camera.aspect > 0) ? camera.aspect : 1;
    const fov = (camera.fov * Math.PI) / 180;
    const halfTan = Math.tan(fov / 2);
    const distV = (modelHeight / 2) / halfTan;            // 竖向适配距离
    const distH = (modelWidth / 2) / (halfTan * aspect);  // 横向适配距离（随宽高比变化）
    camDist = Math.max(distV, distH) * 1.15;             // 取较大者留 15% 边距，保证任意比例下都完整可见
    camTarget = new THREE.Vector3(0, modelHeight * 0.5, 0);
    camBaseElev = Math.atan2(modelHeight * 0.02, camDist);
    camera.updateProjectionMatrix();
  }
  // 根据 view（yaw/pitch/zoom）环绕模型重定位相机
  function applyView() {
    if (!renderer || !camera || !camTarget) return;
    const r = camDist / Math.max(0.2, view.zoom);
    const az = view.yaw;
    const elev = camBaseElev + view.pitch;
    const ce = Math.cos(elev);
    camera.position.set(
      camTarget.x + r * Math.sin(az) * ce,
      camTarget.y + r * Math.sin(elev),
      camTarget.z + r * Math.cos(az) * ce
    );
    camera.lookAt(camTarget);
    camera.updateProjectionMatrix();
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
  }
  function buildBones() {
    if (!mesh || !mesh.skeleton) return;
    skeleton = mesh.skeleton; bones = {};
    mesh.traverse((o) => { if (o.isBone && o.name) bones[o.name] = o; });
    boneRest = {}; baseQuats = {}; boneRestPos = {}; boneRestScale = {};
    cleanLocal = {}; sway = {}; swayVel = {}; lastWorldQ = {}; _lastPartName = null;
    for (const b of skeleton.bones) {
      boneRest[b.name] = b.quaternion.clone();
      baseQuats[b.name] = b.quaternion.clone();
      boneRestPos[b.name] = b.position.clone();
      boneRestScale[b.name] = b.scale.clone();
    }
  }

  async function load(pmxUrl) {
    if (!initRenderer()) return false;
    const loader = new MMDLoader();
    try {
      const m = await loader.loadAsync(pmxUrl);
      mesh = m;
      mesh.traverse((o) => {
        if (o.isMesh) {
          o.frustumCulled = false;
          const mats = Array.isArray(o.material) ? o.material : [o.material];
          for (const mm of mats) {
            if (Array.isArray(mm)) continue;
            mm.side = THREE.DoubleSide;
            if (mm.map && mm.map.colorSpace !== THREE.SRGBColorSpace) { mm.map.colorSpace = THREE.SRGBColorSpace; mm.map.needsUpdate = true; }
            if (mm.emissiveMap && mm.emissiveMap.colorSpace !== THREE.SRGBColorSpace) { mm.emissiveMap.colorSpace = THREE.SRGBColorSpace; mm.emissiveMap.needsUpdate = true; }
            if (mm.gradientMap && mm.gradientMap.colorSpace !== THREE.SRGBColorSpace) { mm.gradientMap.colorSpace = THREE.SRGBColorSpace; mm.gradientMap.needsUpdate = true; }
          }
        }
      });
      scene.add(mesh);
      discoverMorphs();
      buildBones();
      // [DEBUG-LB] 加载即打印 BONE_KEYS 解析表，确认运行时模型确实命中关键骨骼（尤其是下半身）
      if (window && !window.__LB_MAP_DONE) {
        window.__LB_MAP_DONE = true;
        const map = {};
        for (const key in BONE_KEYS) map[key] = (bone(key) ? bone(key).name : 'NULL');
        console.log('[Preview][boneMap]', JSON.stringify(map));
        window.__PLAY_LOG_COUNT = 0; // 每次重载模型重置 [play] 日志计数
      }
      applyRelax();
      frameCamera();
      basePose = { yaw: mesh.rotation.y, pitch: mesh.rotation.x, roll: mesh.rotation.z, y: mesh.position.y };
      clock = new THREE.Clock();
      startLoop();
      return true;
    } catch (e) {
      console.error('[Preview] 模型加载失败:', e);
      return false;
    }
  }

  function startLoop() {
    running = true;
    const loop = () => {
      if (!running) return;
      const dt = clock ? Math.min(clock.getDelta(), 0.05) : 0.016;
      if (def && playing) {
        const dur = def.duration || 1;
        u += dt / dur;
        if (u >= 1) u -= 1;
        playKeyframe({ def, bonesUsed: collectBonesUsed(def), base: basePose }, u);
        if (onTick) onTick(u);
      }
      if (renderer && scene && camera) { applyAdjust(); applyView(); renderer.render(scene, camera); }
      rafId = requestAnimationFrame(loop);
    };
    rafId = requestAnimationFrame(loop);
  }

  // 编辑器每改一格关键帧就 push 一次 setDef。播放中下一帧 RAF 自然会用最新 def 重新插值；
  // 暂停/未播放时主动 refresh 一次，让用户拖动旋钮立刻看到动作可正确还原到当前 u 的姿态。
  function setDef(d) { def = d; if (!playing) refresh(); }
  function refresh() { if (def) playKeyframe({ def, bonesUsed: collectBonesUsed(def), base: basePose }, u); }
  function seek(v) { u = clamp01(v); if (!playing) refresh(); }
  function seek(v) { u = clamp01(v); if (!playing) refresh(); }
  function play(cb) { onTick = cb || null; playing = true; }
  function pause() { playing = false; refresh(); }
  function resize(w, h) {
    if (!renderer || !camera) return;
    w = Math.max(1, Math.floor(w)); h = Math.max(1, Math.floor(h));
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    // 重新按当前宽高比适配：模型始终居中、完整可见、随画布等比缩放（而非错位/放大/丢失）
    fitCamera();
  }
  function destroy() {
    running = false;
    if (rafId) cancelAnimationFrame(rafId);
    if (mesh) {
      mesh.traverse((o) => { if (o.isMesh) { o.geometry && o.geometry.dispose && o.geometry.dispose(); const ms = Array.isArray(o.material) ? o.material : [o.material]; ms.forEach((mm) => mm && mm.dispose && mm.dispose()); } });
      if (scene) scene.remove(mesh);
    }
    if (renderer) { renderer.dispose(); if (renderer.forceContextLoss) renderer.forceContextLoss(); }
    mesh = null; renderer = null; scene = null; camera = null;
  }

  return {
    load,
    setDef,
    seek,
    play,
    pause,
    resize,
    destroy,
    // 轨道视角：可视化编辑器拖拽旋转 / 滚轮缩放使用
    setView: (v) => {
      if (v) {
        if (typeof v.yaw === 'number') view.yaw = v.yaw;
        if (typeof v.pitch === 'number') view.pitch = v.pitch;
        if (typeof v.zoom === 'number') view.zoom = Math.max(0.2, v.zoom);
      }
      applyView();
    },
    getView: () => ({ yaw: view.yaw, pitch: view.pitch, zoom: view.zoom }),
    get ready() { return !!mesh; },
    // 预览专用「模型组件调整」：state = { root:{dx,dy,dz,scale}, part:{name,dx,dy,dz,scale}|null }
    // 传入 null 或 {} 即清空全部调整；仅影响预览，不写入 def/keyframes。
    setAdjust: (state) => {
      if (!state) {
        previewAdjust = { root: { dx: 0, dy: 0, dz: 0, scale: 1, rx: 0, ry: 0, rz: 0 }, part: null };
      } else {
        if (state.root) {
          previewAdjust.root = {
            dx: state.root.dx || 0, dy: state.root.dy || 0, dz: state.root.dz || 0,
            scale: (typeof state.root.scale === 'number' && state.root.scale > 0) ? state.root.scale : 1,
            rx: state.root.rx || 0, ry: state.root.ry || 0, rz: state.root.rz || 0
          };
        }
        if (state.part !== undefined) {
          const nextName = state.part ? state.part.name : null;
          // 切换选中部件时清空惯性，避免把上一根关节的甩动带到新关节
          if (nextName !== _lastPartName) {
            sway = {}; swayVel = {}; lastWorldQ = {}; _lastPartName = nextName;
          }
          previewAdjust.part = state.part
            ? {
                name: state.part.name,
                dx: state.part.dx || 0, dy: state.part.dy || 0, dz: state.part.dz || 0,
                scale: (typeof state.part.scale === 'number' && state.part.scale > 0) ? state.part.scale : 1,
                rx: state.part.rx || 0, ry: state.part.ry || 0, rz: state.part.rz || 0
              }
            : null;
        }
      }
      // 惯性由渲染循环每帧驱动；此处仅更新状态（下一帧即生效）
    },
    // 返回可调部件列表（隐藏 root，整体由 root 控制）；label 为中文友好名
    getParts: () => {
      const labels = {
        head: '头部', neck: '颈部', upperBody: '上半身', upperBody2: '胸部', lowerBody: '下半身',
        lShoulder: '左肩', rShoulder: '右肩', lArm: '左臂', rArm: '右臂',
        lElbow: '左肘', rElbow: '右肘', lWrist: '左手', rWrist: '右手',
        lLeg: '左腿', rLeg: '右腿', lKnee: '左膝', rKnee: '右膝', lAnkle: '左脚', rAnkle: '右脚'
      };
      const out = [];
      for (const key in BONE_KEYS) { if (key === 'root') continue; out.push({ key, label: labels[key] || key }); }
      return out;
    },
    // 调试：把所有 BONE_KEYS 逻辑键 → 此模型实际命中的骨骼名 形成一份映射表返回；
    //      unresolved=true 提示该键未命中任何骨骼（说明 BONE_KEYS 候选不全）。
    //      用法：当前预览实例.__aePreview.getBoneMap() 或者 window.__aePreview.getBoneMap()
    getBoneMap: () => {
      const out = {};
      for (const key in BONE_KEYS) {
        const b = bone(key);
        out[key] = b ? b.name : null; // null 表示未命中
      }
      out.__skeleton_bone_count = Object.keys(bones).length;
      out.__missed_keys_so_far = Object.fromEntries(_missedBones);
      return out;
    },
    // 预览交互：从画布像素坐标射线拾取模型表面，返回离命中点最近的「可调部件」骨骼 key（参考 Unity 点击选中物体）
    pickPart: (clientX, clientY) => {
      if (!mesh || !camera || !canvas || !renderer) return null;
      const rect = canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return null;
      const ndc = new THREE.Vector2(
        ((clientX - rect.left) / rect.width) * 2 - 1,
        -((clientY - rect.top) / rect.height) * 2 + 1
      );
      const ray = new THREE.Raycaster();
      ray.setFromCamera(ndc, camera);
      const hits = ray.intersectObject(mesh, true);
      if (!hits.length) return null;
      const hp = hits[0].point; // 世界坐标命中点
      let best = null, bestD = Infinity;
      const wp = new THREE.Vector3();
      for (const key in BONE_KEYS) {
        if (key === 'root') continue;
        const b = bone(key);
        if (!b) continue;
        b.getWorldPosition(wp);
        const d = wp.distanceTo(hp);
        if (d < bestD) { bestD = d; best = key; }
      }
      return best;
    }
  };
}
