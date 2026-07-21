/* ============================================================
 * Book IR · 中间格式契约（全系统枢纽）
 *
 * 契约文档：docs/harness/BOOK-IR.md —— 本文件是它的可执行落地。
 * 冻结原则：schema 一旦定稿，任何改动必须经人类确认（H1）。
 *   reader 只产出 IR，writer 只消费 IR，两者不得互相引用。
 *
 * 环境中立：本模块只用标准 JS，不碰任何 DOM / Node 专有全局，
 *   因此在浏览器（被 build.mjs 内联）与 Node（跑测试）里行为一致。
 *   HTML 的解析与清洗走本文件自带的 tokenizer，不依赖 DOMParser。
 * ============================================================ */

/**
 * @typedef {string} ResourceId  全书唯一的资源键
 * @typedef {string} ChapterId   全书唯一的章节键
 * @typedef {string} NoteId      全书唯一的注释键
 */

/**
 * @typedef {Object} Meta
 * @property {string}      title        必填。缺失时用文件名
 * @property {string|null} author
 * @property {string}      language     BCP 47，如 "zh-Hans" "zh-Hant" "ja"
 * @property {string}      identifier   缺失时生成 UUID
 * @property {string|null} publisher
 * @property {string|null} date         ISO 8601
 * @property {string|null} description
 * @property {'horizontal-tb'|'vertical-rl'} writingMode  阅读方向（H1 决议加入）
 */

/**
 * @typedef {Object} Resource
 * @property {string}     href  IR 内部路径，如 "images/001.jpg"
 * @property {string}     mime
 * @property {Uint8Array} data
 */

/**
 * @typedef {Object} Chapter
 * @property {ChapterId}   id
 * @property {string|null} title  null = 无标题章节（扉页、插图页）
 * @property {1|2|3}       level  目录层级
 * @property {string}      html   受限 HTML 子集，见 BOOK-IR §3
 */

/**
 * @typedef {Object} Nav
 * @property {string}      title
 * @property {ChapterId}   target
 * @property {string|null} anchor    章节内锚点 id
 * @property {number}      level
 * @property {Nav[]}       children
 */

/**
 * @typedef {Object} Warning
 * @property {string} code    "pdf.no-structure" | "epub.encrypted" | ...
 * @property {string} detail
 */

/**
 * @typedef {Object} Book
 * @property {Meta}                      meta
 * @property {ResourceId|null}           cover
 * @property {Map<ResourceId,Resource>}  resources
 * @property {Chapter[]}                 chapters   线性阅读顺序，"书"的本体
 * @property {Nav[]}                     nav        目录树
 * @property {Map<NoteId,{html:string}>} notes
 * @property {Warning[]}                 warnings
 */

/* ---------- 受限 HTML 白名单（BOOK-IR §3，冻结） ---------- */

export const WHITELIST_TAGS = new Set([
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'p', 'div', 'span',
  'em', 'strong', 'i', 'b', 'u', 's',
  'ruby', 'rt', 'rp',
  'img', 'figure', 'figcaption',
  'blockquote', 'pre', 'code',
  'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'table', 'thead', 'tbody', 'tr', 'th', 'td',
  'a', 'br', 'hr', 'sup', 'sub',
]);

/** 这些标签连同内部文本一并删除（脚本/样式/外链资源） */
export const DROP_WITH_CONTENT = new Set([
  'script', 'style', 'link', 'meta', 'iframe', 'object', 'embed',
  'head', 'title',
]);

/** 空元素（无闭合标签） */
export const VOID_TAGS = new Set(['img', 'br', 'hr']);

/** 全局允许属性 */
const GLOBAL_ATTRS = new Set(['id', 'class', 'lang', 'dir']);

/** 按标签允许的额外属性 */
const TAG_ATTRS = {
  a: new Set(['href']),
  img: new Set(['src', 'alt', 'width', 'height']),
  td: new Set(['colspan', 'rowspan']),
  th: new Set(['colspan', 'rowspan']),
};

function attrAllowed(tag, name) {
  if (name.startsWith('on')) return false;          // 事件处理器一律剥离
  if (name === 'style') return false;               // 内联样式一律剥离
  if (GLOBAL_ATTRS.has(name)) return true;
  const extra = TAG_ATTRS[tag];
  return extra ? extra.has(name) : false;
}

/* ---------- ID / 工具 ---------- */

/** 环境中立的 UUID（Node ≥ 15 与现代浏览器都有 crypto.randomUUID） */
export function uuid() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  // 极端回退：非加密强度，仅用于生成占位 identifier
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

/** 建一本空书，填好必填默认值 */
export function newBook(meta = {}) {
  return {
    meta: {
      title: meta.title || '未命名',
      author: meta.author ?? null,
      language: meta.language || 'zh-Hans',
      identifier: meta.identifier || `urn:uuid:${uuid()}`,
      publisher: meta.publisher ?? null,
      date: meta.date ?? null,
      description: meta.description ?? null,
      // 阅读方向：横排（默认）/ 竖排（CJK 直书）。写作方向是 spine 级属性，非纯视觉，
      // 故进 IR（H1 决议）。epub/kepub writer 据此设 page-progression-direction；txt/pdf 忽略。
      writingMode: meta.writingMode === 'vertical-rl' ? 'vertical-rl' : 'horizontal-tb',
    },
    cover: null,
    resources: new Map(),
    chapters: [],
    nav: [],
    notes: new Map(),
    warnings: [],
  };
}

/** 追加一条 warning（去重：同 code+detail 只留一条） */
export function warn(book, code, detail = '') {
  if (!book.warnings.some((w) => w.code === code && w.detail === detail)) {
    book.warnings.push({ code, detail });
  }
}

/** 深度遍历 nav 树 */
export function walkNav(nav, fn) {
  for (const n of nav || []) {
    fn(n);
    if (n.children && n.children.length) walkNav(n.children, fn);
  }
}

/* ---------- HTML tokenizer（sanitize / plainText 共用） ---------- */

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
};

function decodeEntities(s) {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? m;
  });
}

function escapeText(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escapeAttr(s) {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

/**
 * 把 HTML 串切成 token 流。
 * 每个 token 形如 {type:'text',value} | {type:'open',tag,attrs,selfClose}
 *   | {type:'close',tag}。注释 / doctype / PI 直接吞掉。
 * @returns {Array}
 */
function tokenize(html) {
  const tokens = [];
  let i = 0;
  const n = html.length;
  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt === -1) { tokens.push({ type: 'text', value: html.slice(i) }); break; }
    if (lt > i) tokens.push({ type: 'text', value: html.slice(i, lt) });

    // 注释 / CDATA / doctype / 声明
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      i = end === -1 ? n : end + 3;
      continue;
    }
    if (html[lt + 1] === '!' || html[lt + 1] === '?') {
      const end = html.indexOf('>', lt + 1);
      i = end === -1 ? n : end + 1;
      continue;
    }

    const gt = html.indexOf('>', lt);
    if (gt === -1) { tokens.push({ type: 'text', value: html.slice(lt) }); break; }

    let raw = html.slice(lt + 1, gt).trim();
    i = gt + 1;
    if (!raw) { tokens.push({ type: 'text', value: '<>' }); continue; }

    if (raw[0] === '/') {
      const tag = raw.slice(1).trim().toLowerCase();
      tokens.push({ type: 'close', tag });
      continue;
    }

    let selfClose = false;
    if (raw.endsWith('/')) { selfClose = true; raw = raw.slice(0, -1).trim(); }

    const mName = raw.match(/^([a-zA-Z][a-zA-Z0-9:-]*)/);
    if (!mName) { tokens.push({ type: 'text', value: `<${raw}>` }); continue; }
    const tag = mName[1].toLowerCase();
    const attrs = parseAttrs(raw.slice(mName[1].length));
    tokens.push({ type: 'open', tag, attrs, selfClose });
  }
  return tokens;
}

function parseAttrs(s) {
  const attrs = [];
  const re = /([a-zA-Z_:][a-zA-Z0-9_:.-]*)(?:\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let m;
  while ((m = re.exec(s))) {
    if (!m[1]) break;
    const name = m[1].toLowerCase();
    const value = m[3] ?? m[4] ?? m[5] ?? '';
    attrs.push([name, value]);
  }
  return attrs;
}

/**
 * 把 HTML 清洗为受限白名单子集（BOOK-IR §3）。
 *  - 非白名单标签：剥掉标签本身，保留其文本内容
 *  - DROP_WITH_CONTENT 标签：连内容一起删除
 *  - 非白名单属性 / style / on*：剥离
 * 纯函数，环境中立。
 */
export function sanitizeHtml(html) {
  if (!html) return '';
  const tokens = tokenize(String(html));
  const out = [];
  let dropDepth = 0;        // 处于 DROP_WITH_CONTENT 元素内部的嵌套深度
  let dropTag = null;
  for (const t of tokens) {
    if (dropDepth > 0) {
      if (t.type === 'open' && !t.selfClose && t.tag === dropTag) dropDepth++;
      else if (t.type === 'close' && t.tag === dropTag) dropDepth--;
      continue;
    }
    if (t.type === 'text') { out.push(escapeText(decodeEntities(t.value))); continue; }
    if (t.type === 'open') {
      if (DROP_WITH_CONTENT.has(t.tag)) {
        if (!t.selfClose && !VOID_TAGS.has(t.tag)) { dropDepth = 1; dropTag = t.tag; }
        continue;
      }
      if (!WHITELIST_TAGS.has(t.tag)) continue;      // 剥标签、留内容
      const kept = t.attrs.filter(([name]) => attrAllowed(t.tag, name));
      const attrStr = kept.map(([k, v]) => ` ${k}="${escapeAttr(decodeEntities(v))}"`).join('');
      const isVoid = VOID_TAGS.has(t.tag);
      out.push(`<${t.tag}${attrStr}${isVoid ? ' /' : ''}>`);
      continue;
    }
    if (t.type === 'close') {
      if (DROP_WITH_CONTENT.has(t.tag)) continue;
      if (!WHITELIST_TAGS.has(t.tag)) continue;
      if (VOID_TAGS.has(t.tag)) continue;
      out.push(`</${t.tag}>`);
    }
  }
  return out.join('');
}

/** 抽出纯文本（去标签、解实体、折叠空白）。供 txt writer 与字数统计使用 */
export function plainText(html) {
  if (!html) return '';
  const tokens = tokenize(String(html));
  const parts = [];
  let dropDepth = 0, dropTag = null;
  for (const t of tokens) {
    if (dropDepth > 0) {
      if (t.type === 'open' && !t.selfClose && t.tag === dropTag) dropDepth++;
      else if (t.type === 'close' && t.tag === dropTag) dropDepth--;
      continue;
    }
    if (t.type === 'text') { parts.push(decodeEntities(t.value)); continue; }
    if (t.type === 'open') {
      if (DROP_WITH_CONTENT.has(t.tag)) {
        if (!t.selfClose && !VOID_TAGS.has(t.tag)) { dropDepth = 1; dropTag = t.tag; }
        continue;
      }
      if (t.tag === 'br') parts.push('\n');
    }
    if (t.type === 'close' && /^(p|div|li|h[1-6]|blockquote|tr|figcaption|dd|dt)$/.test(t.tag)) {
      parts.push('\n');
    }
  }
  return parts.join('').replace(/[ \t ]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

/** 全书正文字数（非空白字符数）。G3 的 ±0.5% 容差基准 */
export function countChars(book) {
  let total = 0;
  for (const ch of book.chapters) {
    total += plainText(ch.html).replace(/\s+/g, '').length;
  }
  return total;
}

/* ---------- 校验器（BOOK-IR §7） ---------- */

/** 扫描 html 中出现的所有标签名 */
function tagsIn(html) {
  const found = new Set();
  for (const t of tokenize(String(html || ''))) {
    if (t.type === 'open' || t.type === 'close') found.add(t.tag);
  }
  return found;
}

/**
 * 校验一本 IR 是否合法。
 * @param {Book} book
 * @returns {{ok: boolean, errors: string[]}}
 */
export function validate(book) {
  const errors = [];
  const E = (m) => errors.push(m);

  if (!book || typeof book !== 'object') return { ok: false, errors: ['book 不是对象'] };

  // meta
  const meta = book.meta;
  if (!meta || typeof meta !== 'object') E('meta 缺失');
  else {
    if (!meta.title || typeof meta.title !== 'string') E('meta.title 必填且为非空字符串');
    if (!meta.language || typeof meta.language !== 'string') E('meta.language 必填');
    if (!meta.identifier || typeof meta.identifier !== 'string') E('meta.identifier 必填');
    if (meta.writingMode && !['horizontal-tb', 'vertical-rl'].includes(meta.writingMode))
      E(`meta.writingMode 取值非法: ${meta.writingMode}`);
  }

  // resources
  if (!(book.resources instanceof Map)) E('resources 必须是 Map');
  const hrefs = new Set();
  if (book.resources instanceof Map) {
    for (const [rid, res] of book.resources) {
      if (!res || typeof res.href !== 'string') { E(`resource[${rid}] 缺 href`); continue; }
      if (typeof res.mime !== 'string') E(`resource[${rid}] 缺 mime`);
      if (!(res.data instanceof Uint8Array)) E(`resource[${rid}].data 必须是 Uint8Array`);
      hrefs.add(res.href);
    }
  }

  // cover
  if (book.cover != null && !(book.resources instanceof Map && book.resources.has(book.cover))) {
    E(`cover 指向不存在的资源: ${book.cover}`);
  }

  // notes
  if (!(book.notes instanceof Map)) E('notes 必须是 Map');
  const noteIds = book.notes instanceof Map ? new Set(book.notes.keys()) : new Set();

  // chapters
  if (!Array.isArray(book.chapters)) E('chapters 必须是数组');
  const chapterIds = new Set();
  if (Array.isArray(book.chapters)) {
    if (book.chapters.length === 0) E('chapters 为空——一本书至少要有一章');
    for (const ch of book.chapters) {
      if (!ch || typeof ch.id !== 'string') { E('章节缺 id'); continue; }
      if (chapterIds.has(ch.id)) E(`章节 id 重复: ${ch.id}`);
      chapterIds.add(ch.id);
      if (![1, 2, 3].includes(ch.level)) E(`章节 ${ch.id} 的 level 必须是 1/2/3`);
      if (typeof ch.html !== 'string') { E(`章节 ${ch.id} 的 html 必须是字符串`); continue; }

      // 黑名单标签 / 非白名单标签
      for (const tag of tagsIn(ch.html)) {
        if (DROP_WITH_CONTENT.has(tag)) E(`章节 ${ch.id} 含黑名单标签 <${tag}>`);
        else if (!WHITELIST_TAGS.has(tag)) E(`章节 ${ch.id} 含非白名单标签 <${tag}>（须先 sanitizeHtml）`);
      }

      // img[src] 必须解析到 resources，且不得外链 / data URI
      for (const m of ch.html.matchAll(/<img\b[^>]*\bsrc\s*=\s*("([^"]*)"|'([^']*)')/gi)) {
        const src = m[2] ?? m[3] ?? '';
        if (/^(https?:)?\/\//i.test(src) || /^data:/i.test(src)) {
          E(`章节 ${ch.id} 的 img src 是外链/data URI: ${src}`);
        } else if (!hrefs.has(src)) {
          E(`章节 ${ch.id} 的 img src 未在 resources 中: ${src}`);
        }
      }

      // noteref 必须指向存在的 NoteId
      for (const m of ch.html.matchAll(/<a\b[^>]*class\s*=\s*("[^"]*\bnoteref\b[^"]*"|'[^']*\bnoteref\b[^']*')[^>]*href\s*=\s*("#([^"]*)"|'#([^']*)')/gi)) {
        const nid = m[3] ?? m[4] ?? '';
        if (!noteIds.has(nid)) E(`章节 ${ch.id} 的 noteref 指向不存在的注释: ${nid}`);
      }
    }
  }

  // nav.target 必须指向存在的章节
  const checkNav = (list, depth) => {
    if (!Array.isArray(list)) return;
    for (const nv of list) {
      if (!nv || typeof nv !== 'object') { E('nav 条目不是对象'); continue; }
      if (!chapterIds.has(nv.target)) E(`nav "${nv.title}" 指向不存在的章节: ${nv.target}`);
      if (nv.children) checkNav(nv.children, depth + 1);
    }
  };
  checkNav(book.nav, 0);

  if (!Array.isArray(book.warnings)) E('warnings 必须是数组');

  return { ok: errors.length === 0, errors };
}
