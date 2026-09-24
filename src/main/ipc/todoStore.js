/**
 * 待办事项（Todo）存储
 * ------------------------------------------------------------
 * 目的：把「用户那句模糊需求」变成一份**可确认、可追踪**的清单 ——
 *   每条待办都必须写清"做到什么算完成"（done_when），做完立刻标记，
 *   这样 AI 不会跑偏、用户随时能看到实现过程与目标。
 *
 * 存储：<userData>/todos.json
 *   { version: 1, lists: { "<conversationId>": { items: [...], updatedAt } } }
 *   按会话隔离：换一个会话就是另一件事，互不污染。
 *
 * 设计要点：
 * - 整表替换语义（todo_write）：模型一次给出完整清单，避免增量更新出现"幽灵条目"。
 * - 单条更新（todo_update）：日常推进进度只改一条，省 token。
 * - **同一时刻只允许一条 in_progress**：模型很容易同时标好几条"进行中"，那等于没重点 → 自动纠正并告知。
 * - 条目数上限 12：超过说明这件事该拆成多个会话/多轮，不要让清单变成噪音。
 */
const fs = require('fs');
const path = require('path');

const MAX_ITEMS = 12;
const MAX_TEXT = 200;
const MAX_NOTE = 200;
const MAX_DONE_WHEN = 120;
const STATUSES = ['pending', 'in_progress', 'completed'];
const STATUS_LABEL = { pending: '待办', in_progress: '进行中', completed: '已完成' };

let storePath = null;
let cache = null;

function init(filePath) {
  storePath = filePath;
  cache = null;
  load();
  return true;
}

function load() {
  if (cache) return cache;
  cache = { version: 1, lists: {} };
  if (!storePath) return cache;
  try {
    if (fs.existsSync(storePath)) {
      const raw = JSON.parse(fs.readFileSync(storePath, 'utf-8'));
      cache.lists = (raw && typeof raw.lists === 'object' && raw.lists) || {};
    }
  } catch (e) {
    console.warn('[Todo] 读取待办失败，按空处理:', e.message);
    cache = { version: 1, lists: {} };
  }
  return cache;
}

function save() {
  if (!storePath) return false;
  try {
    const dir = path.dirname(storePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmp = storePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(cache, null, 2), 'utf-8');
    fs.renameSync(tmp, storePath);
    return true;
  } catch (e) {
    console.warn('[Todo] 写入待办失败:', e.message);
    return false;
  }
}

function keyOf(conversationId) {
  return String(conversationId || 'default');
}

function clip(s, max) {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

function getList(conversationId) {
  const s = load();
  const key = keyOf(conversationId);
  if (!s.lists[key]) s.lists[key] = { items: [], updatedAt: 0 };
  return s.lists[key];
}

function progressOf(items) {
  const total = items.length;
  const completed = items.filter(i => i.status === 'completed').length;
  const inProgress = items.filter(i => i.status === 'in_progress').length;
  return {
    total,
    completed,
    inProgress,
    pending: total - completed - inProgress,
    percent: total ? Math.round((completed / total) * 100) : 0
  };
}

/** 整表替换（todo_write）。会保留已有 id 以便前端做增量动画/定位。 */
function write(conversationId, rawItems, title) {
  const list = getList(conversationId);
  const prev = Array.isArray(list.items) ? list.items : [];
  const incoming = Array.isArray(rawItems) ? rawItems : [];
  const warnings = [];

  let items = [];
  for (const raw of incoming) {
    if (!raw) continue;
    const text = clip(typeof raw === 'string' ? raw : raw.text, MAX_TEXT);
    if (!text) continue;
    let status = STATUSES.includes(raw.status) ? raw.status : 'pending';
    // 文本一致的旧条目沿用旧 id（前端可据此做"哪条刚变了"的判断）
    const old = prev.find(o => o.text === text) || prev.find(o => raw.id && o.id === raw.id);
    items.push({
      id: (raw.id && String(raw.id)) || (old && old.id) || ('t' + (items.length + 1)),
      text,
      status,
      done_when: clip(raw.done_when || (old && old.done_when) || '', MAX_DONE_WHEN),
      note: clip(raw.note || '', MAX_NOTE),
      updatedAt: Date.now()
    });
  }

  if (incoming.length > MAX_ITEMS) {
    warnings.push('待办最多 ' + MAX_ITEMS + ' 条，已截断后面 ' + (incoming.length - MAX_ITEMS) + ' 条；这件事建议拆成多轮做');
  }
  if (items.length > MAX_ITEMS) items = items.slice(0, MAX_ITEMS);

  // 同一时刻只允许一条"进行中"：保留列表里最靠前的那条，其余退回待办
  const running = items.filter(i => i.status === 'in_progress');
  if (running.length > 1) {
    running.slice(1).forEach(i => { i.status = 'pending'; });
    warnings.push('同时只能有一条"进行中"，已把后面的退回待办（专注当前这条）');
  }

  list.items = items;
  list.title = clip(title, 60) || list.title || '';
  list.updatedAt = Date.now();
  save();
  return { success: true, items, progress: progressOf(items), warnings };
}

/** 单条更新（todo_update）：按 id 或 text 定位；也支持直接追加一条。 */
function update(conversationId, patch = {}) {
  const list = getList(conversationId);
  const items = list.items || [];
  const warnings = [];

  // 没给定位信息 → 视作追加
  if (!patch.id && !patch.text) {
    return write(conversationId, items.concat([{ text: patch.new_text, status: patch.status }]));
  }

  const idx = items.findIndex(i => (patch.id && i.id === patch.id) ||
    (patch.text && i.text === clip(patch.text, MAX_TEXT)));
  if (idx < 0) {
    return {
      success: false,
      error: '没找到这条待办：' + (patch.id || patch.text) + '（可用 todo_read 看当前清单）',
      items,
      progress: progressOf(items)
    };
  }

  const it = items[idx];
  if (patch.status !== undefined) {
    if (!STATUSES.includes(patch.status)) {
      return { success: false, error: 'status 只能是 pending / in_progress / completed', items, progress: progressOf(items) };
    }
    if (patch.status === 'in_progress') {
      // 互斥：把其它 in_progress 退回待办
      items.forEach((o, i) => {
        if (i !== idx && o.status === 'in_progress') {
          o.status = 'pending';
          warnings.push('「' + o.text.slice(0, 16) + '」已从"进行中"退回待办（同时只能一条进行中）');
        }
      });
    }
    it.status = patch.status;
  }
  if (patch.text !== undefined) {
    const t = clip(patch.text, MAX_TEXT);
    if (t) it.text = t;
  }
  if (patch.done_when !== undefined) it.done_when = clip(patch.done_when, MAX_DONE_WHEN);
  if (patch.note !== undefined) it.note = clip(patch.note, MAX_NOTE);
  it.updatedAt = Date.now();
  list.updatedAt = Date.now();
  save();
  return { success: true, item: it, items, progress: progressOf(items), warnings };
}

function read(conversationId) {
  const list = getList(conversationId);
  return { success: true, items: list.items || [], progress: progressOf(list.items || []), title: list.title || '' };
}

function clear(conversationId) {
  const list = getList(conversationId);
  const n = (list.items || []).length;
  list.items = [];
  list.title = '';
  list.updatedAt = Date.now();
  save();
  return { success: true, removed: n };
}

function stats() {
  const s = load();
  const keys = Object.keys(s.lists);
  return { conversations: keys.length, items: keys.reduce((n, k) => n + (s.lists[k].items || []).length, 0), file: storePath || null };
}

/**
 * 生成注入系统提示词的待办块。
 * 让模型每一轮都看得见"整体目标 + 现在做到哪一步"，这是"保留实现过程"的关键。
 */
function buildPromptBlock(conversationId) {
  const { items, progress } = read(conversationId);
  if (!items.length) return '';
  const mark = { pending: '[ ]', in_progress: '[~]', completed: '[x]' };
  const lines = items.map(i => {
    let line = mark[i.status] + ' ' + i.id + ' ' + i.text;
    if (i.done_when) line += '（完成判据：' + i.done_when + '）';
    if (i.note) line += ' → ' + i.note;
    return line;
  });
  return [
    '## 当前待办清单（本次任务的实现过程，进度 ' + progress.completed + '/' + progress.total + '）',
    ...lines,
    '规则：同一时刻只推进一条，完成立刻用 todo_update 标记（note 写清结果）；需求变了用 todo_write 整表替换；' +
    '全部完成后如实汇报哪几条完成、哪条没做及原因。'
  ].join('\n');
}

module.exports = {
  init, read, write, update, clear, stats, buildPromptBlock, progressOf,
  MAX_ITEMS, STATUSES, STATUS_LABEL
};
