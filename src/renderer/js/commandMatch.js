/*
 * commandMatch.js — 通用指令匹配模块
 * 按《Live2D通用桌面宠物-智能指令交互系统-开发文档》实现。
 *
 * 设计要点（与文档一致）：
 *   1. 十大固定语义分类（CATEGORIES）—— 全局永久通用，禁止新增。
 *   2. 全局通用话术库（GROUP_WORDS）—— 固定不变，换模型无需修改。
 *   3. 核心匹配函数 get_match_motion —— 永久固定，禁止修改。
 *   4. 唯一可修改区域：模型动作映射表（MODEL_ACTION_MAP）。
 *
 * 与文档的差异说明（适配本项目动态动作解析）：
 *   文档的 get_match_motion 返回「motion 文件名」，本项目桌宠引擎（PetBrain）
 *   采用「分类 → 模型真实动作组」动态解析（见 INTENT_PATTERNS / resolveMotionGroup），
 *   因此本模块的 get_match_motion 直接返回「语义分类 key」（它同时就是桌宠动作名），
 *   模型动作映射由 PetBrain 内部完成。MODEL_ACTION_MAP 保留为唯一可修改区域，
 *   默认是分类→自身 的恒等映射；若某模型缺少某分类动作，可在此显式配置降级/替代分类。
 *
 * 该模块同时支持浏览器（window.CommandMatch）与 Node（module.exports）环境。
 */
(function (global) {
  'use strict';

  // ====================== 十大固定语义动作分类（全局永久通用） ======================
  const CATEGORIES = {
    greet:  '打招呼',
    dance:  '舞蹈活泼',
    sleep:  '犯困睡觉',
    confuse: '疑惑好奇',
    happy:  '开心兴奋',
    shy:    '害羞腼腆',
    angry:  '生气烦躁',
    sad:    '委屈难过',
    lazy:   '慵懒放松',
    idle:   '待机静止'
  };

  const CATEGORY_LIST = Object.keys(CATEGORIES);

  // ====================== 全局通用话术库（固定不变，无需迭代） ======================
  // 文档原文（§2.2），覆盖 99% 日常交互场景；换模型无需修改。
  // 仅追加少量英文互补词以支持英文输入，不新增任何分类。
  const GROUP_WORDS = {
    greet: [
      "你好", "嗨", "哈喽", "早安", "早上好", "晚上好", "打个招呼", "挥挥手", "招下手",
      "跟我问好", "来打声招呼", "挥下手看看", "嗨嗨", "早啊", "晚间好",
      "能跟我打个招呼吗", "挥挥手好不好", "来招招手呗", "问好一下",
      "hello", "hi", "hey", "good morning", "good night"
    ],
    dance: [
      "跳舞", "跳个舞", "摇摆", "晃一晃", "转圈", "蹦跶", "动一动", "来段舞蹈",
      "扭一扭", "左右晃", "转个圈圈", "随便跳两下", "活跃一点", "蹦蹦跳跳",
      "跳支舞看看", "可以晃一晃吗", "来段舞蹈好不好", "扭动一下身体",
      "dance", "jump"
    ],
    sleep: [
      "睡觉", "犯困", "困了", "打瞌睡", "休息", "晚安", "眯一会", "打哈欠", "慵懒",
      "好困", "想睡觉", "歇一会", "闭眼休息", "打个哈欠", "蔫蔫的", "昏昏欲睡",
      "眼皮重", "要睡着了", "准备睡觉", "困得不行", "瘫着休息", "闭目养神",
      "困了吗", "要不要休息", "眯一会好不好", "打个哈欠看看", "晚安要睡了",
      "睡吧", "去睡", "睡一觉", "睡个觉", "睡一会", "睡一会儿", "想睡",
      "该睡了", "入睡", "午睡", "午休", "打个盹", "打盹", "小憩", "歇会儿",
      "睡会儿", "困倦", "犯春困", "nap", "go to sleep", "bedtime",
      "sleep", "rest"
    ],
    confuse: [
      "歪头", "疑问", "怎么了", "啥", "看不懂", "好奇", "愣住", "嗯？",
      "啥意思", "没听懂", "歪个头看看", "一脸疑惑", "懵住了", "这是什么",
      "怎么回事呀", "看懂了吗", "有点搞不懂", "好奇一下",
      "confused", "what", "why", "huh"
    ],
    happy: [
      "笑", "开心", "高兴", "耶", "比耶", "大笑", "雀跃", "微笑", "乐一下",
      "超开心", "好耶", "咧嘴笑", "笑嘻嘻", "激动", "欢呼", "开心一点好不好",
      "笑一个呗", "能比个耶吗", "太开心啦", "兴奋起来",
      "happy", "joy", "yeah", "yay"
    ],
    shy: [
      "害羞", "脸红", "不好意思", "扭捏", "低头腼腆", "有点害羞", "脸红一下",
      "别盯着我", "难为情", "羞羞的", "脸颊发红", "腼腆低头", "会害羞吗",
      "腼腆一点好不好", "不好意思啦",
      "shy"
    ],
    angry: [
      "生气", "恼火", "不爽", "皱眉", "闹脾气", "噘嘴", "有点烦", "气鼓鼓",
      "皱眉头", "闹小脾气", "不开心", "恼火起来", "噘个嘴看看", "生气啦",
      "有点恼火是吗", "别惹我生气",
      "angry", "mad", "annoyed"
    ],
    sad: [
      "难过", "委屈", "伤心", "低落", "闷闷不乐", "想哭", "好委屈", "闷闷的",
      "蔫掉了", "有点伤心", "眼眶发红", "瘪嘴难过", "怎么难过了", "委屈一下好不好",
      "sad", "cry"
    ],
    lazy: [
      "放松", "懒懒的", "瘫着", "舒展", "伸懒腰", "放空", "懒洋洋", "伸个懒腰",
      "舒展一下", "软软的", "浑身发软", "舒展身体", "放松一点", "伸个懒腰呗",
      "lazy", "relax", "stretch"
    ],
    idle: [
      "待机", "安静", "别动", "发呆", "原地不动", "正常待着", "安静一会",
      "别乱动", "乖乖待着", "放空", "正常状态", "安静一点好不好", "乖乖站着",
      "idle", "afk"
    ]
  };

  // ====================== 唯一可修改区域：模型动作映射表 ======================
  // 格式："语义分类 key" : "实际动作名"
  // 本项目桌宠引擎已内置十大分类的真实动作解析，默认恒等映射即可。
  // 若某模型缺少某分类动作，可在此显式配置降级/替代分类（例如 confuse 降级为 idle）。
  // 新增动作直接在此追加，禁止修改其他代码（尤其是 get_match_motion）。
  const MODEL_ACTION_MAP = {
    greet:  'greet',
    dance:  'dance',
    sleep:  'sleep',
    confuse: 'confuse',
    happy:  'happy',
    shy:    'shy',
    angry:  'angry',
    sad:    'sad',
    lazy:   'lazy',
    idle:   'idle'
  };

  // ====================== 核心匹配函数 - 禁止修改 ======================
  function get_match_motion(input_text) {
    /**
     * 通用口语指令匹配函数
     * @param {string} input_text 用户输入的口语/文字指令
     * @return {string[]} 匹配到的语义分类 key 列表（支持多动作叠加，无匹配返回 ['idle']）
     */
    const text = (input_text || '').trim().toLowerCase();
    const hit_groups = new Set();

    // 语义关键词匹配
    for (const group_key of CATEGORY_LIST) {
      const word_list = GROUP_WORDS[group_key] || [];
      for (const word of word_list) {
        if (text.includes(String(word).toLowerCase())) {
          hit_groups.add(group_key);
          break;
        }
      }
    }

    // 筛选对应动作（经模型动作映射表）
    const matched = [];
    for (const cat of CATEGORY_LIST) {
      const action = MODEL_ACTION_MAP[cat];
      if (action != null && hit_groups.has(cat)) matched.push(action);
    }

    // 无匹配自动返回待机动作
    if (matched.length === 0) {
      const idleAction = MODEL_ACTION_MAP['idle'];
      return idleAction != null ? [idleAction] : ['idle'];
    }

    return matched;
  }

  // 便捷别名：返回分类 key 数组（与 get_match_motion 等价）
  function matchPetActions(input_text) {
    return get_match_motion(input_text);
  }

  // 仅返回「真实命中」的语义分类（不含 idle 回落），用于判断用户是否真的下达了动作指令。
  // 例如未匹配任何话术时返回 []（而非 ['idle']），避免把普通聊天误判为待机动作。
  function get_hit_categories(input_text) {
    const text = (input_text || '').trim().toLowerCase();
    const hits = [];
    for (const group_key of CATEGORY_LIST) {
      const word_list = GROUP_WORDS[group_key] || [];
      for (const word of word_list) {
        if (text.includes(String(word).toLowerCase())) {
          hits.push(group_key);
          break;
        }
      }
    }
    return hits;
  }

  const CommandMatch = {
    CATEGORIES,
    CATEGORY_LIST,
    GROUP_WORDS,
    MODEL_ACTION_MAP,
    get_match_motion,
    matchPetActions,
    get_hit_categories
  };

  // 浏览器环境
  if (typeof global !== 'undefined') {
    global.CommandMatch = CommandMatch;
  }
  // Node 环境（用于自检）
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = CommandMatch;
  }

  return CommandMatch;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
