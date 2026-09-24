/**
 * AI 长期记忆存储
 * ------------------------------------------------------------
 * 目的：让 Agent 能把「跨会话仍然成立」的信息记下来（用户偏好、项目约定、踩过的坑），
 *      下次对话自动注入系统提示词，而不是每次重新问用户。
 *
 * 存储：<userData>/memory.json
 *   { version: 1, items: [ { id, text, tags, kind, source, pinned, hits, createdAt, updatedAt } ] }
 *
 * 设计要点：
 * - 双保险限额：条数上限 + 单条长度上限，避免记忆库无限膨胀（注入 prompt 是要花 token 的）。
 * - 写入去重：文本归一化后一致的条目直接合并（更新 tags / updatedAt），不产生重复记忆。
 * - 原子写入：先写临时文件再 rename，避免进程被杀导致 memory.json 变成空文件。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_ITEMS = 200;      // 最多保留多少条
const MAX_TEXT = 500;       // 单条最长字符数
const DEFAULT_BUDGET = 1200; // 注入系统提示词的默认字符预算

// kind 仅用于注入时加个前缀标签，便于模型理解记忆类型
const KINDS = ['fact', 'preference', 'project', 'fix', 'note'];
const KIND_LABEL = {
  fact: '事实',
  preference: '偏好',
  project: '项目',
  fix: '修复经验',
  note: '备注'
};

let storePath = null;
let cache = null;

function init(filePath) {
  storePath = filePath;
  cache = null;
  return load();
}

function load() {
  if (cache) return cache;
  cache = { version: 1, items: [] };
  if (!storePath) return cache;
  try {
    if (fs.existsSync(storePath)) {
      const raw = JSON.parse(fs.readFileSync(storePath, 'utf-8'));
      const items = Array.isArray(raw?.items) ? raw.items : [];
      cache.items = items.map(normalizeItem).filter(it => it && it.text);
    }
  } catch (e) {
    console.warn('[Memory] 读取记忆库失败，按空库处理:', e.message);
    cache = { version: 1, items: [] };
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
    console.warn('[Memory] 写入记忆库失败:', e.message);
    return false;
  }
}

function normalizeText(t) {
  return String(t == null ? '' : t).replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
}

function normalizeTags(tags) {
  const arr = Array.isArray(tags) ? tags : (typeof tags === 'string' ? tags.split(/[,，;；\s]+/) : []);
  const out = [];
  for (const t of arr) {
    const s = String(t == null ? '' : t).replace(/\s+/g, '').slice(0, 24);
    if (s && !out.includes(s) && out.length < 8) out.push(s);
  }
  return out;
}

function normalizeItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const text = normalizeText(raw.text);
  if (!text) return null;
  const kind = KINDS.includes(raw.kind) ? raw.kind : 'note';
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : newId(),
    text,
    tags: normalizeTags(raw.tags),
    kind,
    source: typeof raw.source === 'string' ? raw.source.slice(0, 40) : 'agent',
    pinned: !!raw.pinned,
    hits: Number.isFinite(raw.hits) ? raw.hits : 0,
    createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : Date.now(),
    updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : Date.now()
  };
}

function newId() {
  return 'm_' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
}

/** 新增或更新一条记忆。传 id 或文本与已有条目完全一致时视为更新（upsert）。 */
function add({ text, tags, kind, pinned, source, id } = {}) {
  const s = load();
  const clean = normalizeText(text);
  if (!clean) return { success: false, error: '记忆内容不能为空' };

  let target = id ? s.items.find(it => it.id === id) : null;
  if (!target) target = s.items.find(it => it.text === clean);
  const now = Date.now();

  if (target) {
    target.text = clean;
    if (tags !== undefined) target.tags = normalizeTags(tags);
    if (kind && KINDS.includes(kind)) target.kind = kind;
    if (pinned !== undefined) target.pinned = !!pinned;
    target.updatedAt = now;
    save();
    return { success: true, updated: true, item: target, total: s.items.length };
  }

  const item = normalizeItem({ text: clean, tags, kind, pinned, source, id: id || newId() });
  item.createdAt = now;
  item.updatedAt = now;
  s.items.push(item);

  // 超限时优先淘汰：未置顶 → 最少命中 → 最久未更新
  let evicted = 0;
  while (s.items.length > MAX_ITEMS) {
    const pool = s.items.filter(it => !it.pinned);
    const cand = (pool.length ? pool : s.items)
      .slice()
      .sort((a, b) => (a.hits - b.hits) || (a.updatedAt - b.updatedAt))[0];
    const idx = s.items.indexOf(cand);
    if (idx < 0) break;
    s.items.splice(idx, 1);
    evicted++;
  }
  save();
  return { success: true, updated: false, item, total: s.items.length, evicted };
}

function update(id, patch = {}) {
  const s = load();
  const it = s.items.find(x => x.id === id);
  if (!it) return { success: false, error: '未找到记忆: ' + id };
  if (patch.text !== undefined) {
    const clean = normalizeText(patch.text);
    if (!clean) return { success: false, error: '记忆内容不能为空' };
    it.text = clean;
  }
  if (patch.tags !== undefined) it.tags = normalizeTags(patch.tags);
  if (patch.kind && KINDS.includes(patch.kind)) it.kind = patch.kind;
  if (patch.pinned !== undefined) it.pinned = !!patch.pinned;
  it.updatedAt = Date.now();
  save();
  return { success: true, item: it };
}

function remove(id) {
  const s = load();
  const idx = s.items.findIndex(x => x.id === id);
  if (idx < 0) return { success: false, error: '未找到记忆: ' + id };
  const [gone] = s.items.splice(idx, 1);
  save();
  return { success: true, removed: gone, total: s.items.length };
}

/** 按关键词删除（支持一次删多条），用于「忘掉关于 X 的记忆」。 */
function removeByQuery(query, limit = 10) {
  const s = load();
  const hits = search(query, limit);
  if (!hits.length) return { success: false, error: '没有匹配「' + query + '」的记忆' };
  const ids = new Set(hits.map(h => h.id));
  const removed = s.items.filter(it => ids.has(it.id));
  s.items = s.items.filter(it => !ids.has(it.id));
  save();
  return { success: true, removed, total: s.items.length };
}

function clear() {
  const s = load();
  const n = s.items.length;
  s.items = [];
  save();
  return { success: true, removed: n };
}

function list({ tag, kind, limit = 50 } = {}) {
  const s = load();
  let items = s.items.slice();
  if (tag) items = items.filter(it => it.tags.includes(tag));
  if (kind) items = items.filter(it => it.kind === kind);
  items.sort((a, b) => (b.pinned - a.pinned) || (b.updatedAt - a.updatedAt));
  return items.slice(0, limit);
}

/**
 * 纯匹配分：0 表示「与关键词无关」。
 * ⚠️ 置顶等权重只能加在排序上，不能加在这里 —— 否则置顶条目会命中任意关键词，
 *    被 memory_search 全部返回，甚至被 memory_delete(query) 误删（踩过）。
 */
function matchScore(item, q) {
  if (!q) return 0;
  let score = 0;
  for (const t of item.tags) if (t && q.includes(t.toLowerCase())) score += 4;
  const clean = item.text.replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '').slice(0, 160);
  for (let n = 4; n >= 3; n--) {
    for (let i = 0; i + n <= clean.length; i++) {
      if (q.includes(clean.substr(i, n))) score += (n === 4 ? 2 : 1);
    }
  }
  if (item.text.toLowerCase().includes(q)) score += 6;
  return score;
}

/** 排序分 = 匹配分 + 置顶权重（只用于排序，不用于判断是否命中） */
function relevance(item, q) {
  return matchScore(item, q) + (item.pinned ? 5 : 0);
}

function search(query, limit = 10) {
  const s = load();
  const q = String(query || '').toLowerCase().trim();
  if (!q) return list({ limit });
  const scored = s.items
    .map(it => ({ it, hit: matchScore(it, q) }))
    .filter(x => x.hit > 0)
    .sort((a, b) => (b.hit + (b.it.pinned ? 5 : 0)) - (a.hit + (a.it.pinned ? 5 : 0)));
  // 命中后累计 hits，用于淘汰策略与排序
  const out = scored.slice(0, limit).map(x => {
    x.it.hits = (x.it.hits || 0) + 1;
    return { ...x.it, score: x.hit };
  });
  if (out.length) save();
  return out;
}

/**
 * 生成注入系统提示词的记忆文本块。
 * 选取顺序：与当前问题相关的 → 置顶的 → 最近更新的，直到用满字符预算。
 */
function buildPromptBlock(userMessage, charBudget = DEFAULT_BUDGET) {
  const s = load();
  if (!s.items.length) return '';

  const q = String(userMessage || '').toLowerCase();
  const scored = s.items.map(it => ({
    it,
    rel: relevance(it, q),
    ts: it.pinned ? 9e15 : it.updatedAt
  }));
  scored.sort((a, b) => (b.rel - a.rel) || (b.ts - a.ts));

  const picked = [];
  let used = 0;
  for (const { it } of scored) {
    const line = '- [' + (KIND_LABEL[it.kind] || '备注') + '] ' + it.text +
      (it.tags.length ? '（标签: ' + it.tags.join('/') + '）' : '');
    if (used + line.length + 1 > charBudget) continue;
    picked.push(line);
    used += line.length + 1;
    if (picked.length >= 40) break;
  }
  if (!picked.length) return '';

  return [
    '## 长期记忆（你在以往会话中记录下来的信息，请优先遵守，避免重复询问用户）',
    ...picked,
    '（记忆库共 ' + s.items.length + ' 条，已按当前问题相关度挑选 ' + picked.length + ' 条；' +
    '需要更多可用 memory_search 检索，新增/修正用 memory_save，删除用 memory_delete。）'
  ].join('\n');
}

function stats() {
  const s = load();
  return {
    total: s.items.length,
    pinned: s.items.filter(i => i.pinned).length,
    max: MAX_ITEMS,
    file: storePath || null
  };
}

module.exports = {
  init, stats, list, search, add, update, remove, removeByQuery, clear, buildPromptBlock,
  KINDS, KIND_LABEL, MAX_ITEMS, MAX_TEXT
};
