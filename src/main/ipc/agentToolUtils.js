/**
 * Agent 工具调用相关的纯函数（无 electron 依赖，便于单测）
 * 主要解决小模型"想调用工具但没输出结构化 tool_calls"的各类退化输出。
 */

/**
 * 从模型"把 tool_calls 当成普通文本输出"的正文里恢复工具调用。
 * 典型场景：提示词强制要求输出 tool_calls 时，qwen 系模型会把
 * {"name":"web_search","arguments":{"query":"..."}} 原样写进 content。
 *
 * @param {string} text 模型输出的正文
 * @param {string[]} validNames 已注册的工具名清单
 * @returns {{name:string, arguments:object}|null}
 */
function extractToolCallFromText(text, validNames) {
  if (!text || typeof text !== 'string') return null;
  const valid = Array.isArray(validNames) ? validNames : [];
  if (valid.length === 0) return null;

  const candidates = [];
  // 去掉 markdown 代码围栏（保留围栏内的内容）
  const cleaned = text
    .replace(/```(?:json|tool|tool_calls)?/gi, '```')
    .replace(/```([\s\S]*?)```/g, (m, inner) => inner);

  // 1) <tool_call>...</tool_call> 形式
  const xmlMatch = cleaned.match(/<(?:tool_call|function_call|tool|function)>([\s\S]*?)<\/(?:tool_call|function_call|tool|function)>/i);
  if (xmlMatch) candidates.push(xmlMatch[1].trim());

  // 2) 整段就是 JSON
  const trimmed = cleaned.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) candidates.push(trimmed);

  // 3) 扫描所有花括号配对的片段
  for (let start = 0; start < cleaned.length; start++) {
    if (cleaned[start] !== '{') continue;
    let depth = 0, end = -1, inStr = false, esc = false;
    for (let i = start; i < cleaned.length; i++) {
      const ch = cleaned[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') { inStr = true; continue; }
      if (ch === '{') depth++;
      else if (ch === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    if (end > start) candidates.push(cleaned.substring(start, end + 1));
  }

  for (const cand of candidates) {
    let obj = null;
    try { obj = JSON.parse(cand); } catch (e) { continue; }
    const list = Array.isArray(obj) ? obj : [obj];
    for (const item of list) {
      if (!item || typeof item !== 'object') continue;
      // OpenAI 风格 {name, arguments}
      let name = item.name || item.tool || item.function_name || item.tool_name;
      let args = item.arguments || item.parameters || item.args;
      // 嵌套风格 {function:{name, arguments}}
      if (!name && item.function && typeof item.function === 'object') {
        name = item.function.name;
        if (item.function.arguments !== undefined) args = item.function.arguments;
      }
      // 扁平风格 {web_search:{query:"..."}}
      if (!name) {
        const keys = Object.keys(item);
        if (keys.length === 1 && item[keys[0]] && typeof item[keys[0]] === 'object') {
          name = keys[0];
          args = item[keys[0]];
        }
      }
      if (typeof name !== 'string') continue;
      name = name.trim();
      if (!valid.includes(name)) continue;
      if (args === undefined || args === null) args = {};
      if (typeof args === 'string') {
        try { args = JSON.parse(args); } catch (e) { args = {}; }
      }
      if (typeof args !== 'object' || Array.isArray(args)) args = {};
      return { name, arguments: args };
    }
  }
  return null;
}

/**
 * 取最后一条真实的用户消息。
 * 注意：调用点往往已经 push 了 assistant 消息，不能简单取数组末尾。
 */
function getLastUserMessage(messages) {
  if (!Array.isArray(messages)) return '';
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === 'user') {
      if (typeof m.content === 'string') return m.content;
      if (Array.isArray(m.content)) {
        return m.content.map(p => (typeof p === 'string' ? p : (p && p.text) || '')).join('\n');
      }
    }
  }
  return '';
}

/**
 * 归一化对话历史：
 * - 前端历史里 role 可能是 'ai'，但各家 API 只认 'assistant'
 * - 剔除多余字段（time / aiContent / attachments）和空消息
 */
function normalizeAgentMessages(messages) {
  if (!Array.isArray(messages)) return [];
  const out = [];
  for (const raw of messages) {
    if (!raw) continue;
    let role = raw.role;
    if (role === 'ai' || role === 'model' || role === 'bot') role = 'assistant';
    if (!['system', 'user', 'assistant', 'tool'].includes(role)) continue;
    let content = typeof raw.content === 'string'
      ? raw.content
      : (Array.isArray(raw.content)
        ? raw.content.map(p => (typeof p === 'string' ? p : (p && p.text) || '')).join('\n')
        : '');
    const msg = { role, content };
    if (role === 'assistant' && Array.isArray(raw.tool_calls) && raw.tool_calls.length) {
      msg.tool_calls = raw.tool_calls;
    }
    if (role === 'tool') {
      msg.tool_call_id = raw.tool_call_id;
      if (raw.name) msg.name = raw.name;
    }
    if (role === 'assistant' && !content && !msg.tool_calls) continue; // 丢弃空助手消息
    if (role !== 'assistant' && role !== 'tool' && !content) continue;
    out.push(msg);
  }
  return out;
}

/**
 * content 内联思考拆分流式分割器。
 *
 * 背景：有些本地服务（llama.cpp 用 --reasoning-format none 启动时）会把思考用
 * ` thinking…` 包着混在 content 里一起流式吐出来。当正文显示会糊成一团，必须拆出来。
 *
 * 两个坑：
 * 1) 标签可能被流式切断（"<thi" + "nk>…"）→ 必须保留"可能是标签前缀"的尾巴等下一块；
 * 2) 各家的闭合标签不统一（Qwen3 用全角 ｜，部分模板用 ASCII）→ 多个候选标签取最早命中；
 * 3) 尾巴长度为 0 时必须显式清空缓冲 —— `buf.slice(-0)` 等价于 `buf.slice(0)`，
 *    会把整个缓冲原样留下，导致已发出的正文被反复重发（曾造成整段回复雪崩式重复）。
 *
 * @param {{opens?: string[], closes?: string[]}} tags
 * @returns {{ push: (chunk:string)=>{reasoning:string,content:string}, flush: ()=>{reasoning:string,content:string}, inThink: ()=>boolean }}
 */
function createInlineThinkSplitter(tags = {}) {
  const OPENS = Array.isArray(tags.opens) && tags.opens.length ? tags.opens : ['<' + 'think>'];
  const CLOSES = Array.isArray(tags.closes) && tags.closes.length
    ? tags.closes
    : ['<' + '/think>', '<' + '\uFF5Cend\u2581of\u2581thinking\uFF5C>'];
  const ALL = OPENS.concat(CLOSES).filter(t => t && t.length);

  let buf = '';
  let inThink = false;

  // 末尾"可能是某个标签前缀"的最长长度：只保留这些，避免无谓地延迟正文
  function tailKeep(s) {
    let keep = 0;
    for (const tag of ALL) {
      const max = Math.min(tag.length - 1, s.length);
      for (let k = max; k > keep; k--) {
        if (s.endsWith(tag.slice(0, k))) { keep = k; break; }
      }
    }
    return keep;
  }
  function earliest(s, list) {
    let best = null;
    for (const t of list) {
      if (!t) continue;
      const i = s.indexOf(t);
      if (i >= 0 && (!best || i < best.index)) best = { index: i, tag: t };
    }
    return best;
  }
  function takeKeep(s, keep) {
    return keep > 0 ? s.slice(-keep) : '';
  }
  function run() {
    let reasoning = '', content = '';
    let guard = 0;
    while (buf.length && guard++ < 500) {
      if (inThink) {
        const hit = earliest(buf, CLOSES);
        if (!hit) {
          const keep = tailKeep(buf);
          if (buf.length > keep) { reasoning += buf.slice(0, buf.length - keep); buf = takeKeep(buf, keep); }
          break;
        }
        reasoning += buf.slice(0, hit.index);
        buf = buf.slice(hit.index + hit.tag.length);
        inThink = false;
      } else {
        const hit = earliest(buf, OPENS);
        if (!hit) {
          const keep = tailKeep(buf);
          if (buf.length > keep) { content += buf.slice(0, buf.length - keep); buf = takeKeep(buf, keep); }
          break;
        }
        content += buf.slice(0, hit.index);
        buf = buf.slice(hit.index + hit.tag.length);
        inThink = true;
      }
    }
    return { reasoning, content };
  }

  return {
    push(chunk) {
      buf += String(chunk == null ? '' : chunk);
      return run();
    },
    /** 流结束时冲刷尾巴（不能丢字） */
    flush() {
      if (!buf) return { reasoning: '', content: '' };
      const out = inThink ? { reasoning: buf, content: '' } : { reasoning: '', content: buf };
      buf = '';
      return out;
    },
    inThink: () => inThink
  };
}

module.exports = {
  extractToolCallFromText,
  getLastUserMessage,
  normalizeAgentMessages,
  createInlineThinkSplitter
};
