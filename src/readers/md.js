/* ============================================================
 * src/readers/md.js · Markdown → Book IR
 *
 * 极简手写解析（REQUIREMENTS R1：不引入 markdown 库）。
 *
 * 覆盖：
 *   - ATX 标题 `#`~`######`（层级映射到 IR 的 1|2|3，4~6 级夹到 3）
 *     → 每个标题起一个新章节；标题文本不重复进 html，只进 `chapter.title`
 *   - 标题层级 → `nav` 树（浅层标题挂载深层标题，见 buildNav）
 *   - 段落、无序/有序列表、引用块、围栏代码块、水平线
 *   - 行内：加粗（星号双写或下划线双写包裹）、斜体（单个星号或下划线包裹）、
 *     行内代码（反引号包裹）、链接 [text](url)、图片 ![alt](src)
 *
 * 图片的取舍（见 ResultReport.learned）：
 *   reader 默认只拿到内存里的这一份 .md 文本，取不到外部图片文件（零网络）。
 *   两条例外路径能把图片真正落进 resources：
 *     1. data: URI 形式的内嵌图片，原地解码成 `resources`（不违反
 *        "img[src] 不得是 data URI"——解码后 src 已指向内部资源）。
 *     2. 相对路径图片引用，若调用方（如 zip reader 解包同目录文件后）
 *        通过 `opts.siblingAssets`（Map<文件名, Uint8Array>）把兄弟文件
 *        一并传入，按文件名匹配后同样落进 resources。
 *   两条路径都不命中时（如 http(s) 外链、没有提供 siblingAssets 的孤立
 *   .md 文件引用相对路径图片），降级为纯文字 alt，并记 `md.image-unresolved`。
 *
 * 已知不覆盖（极简解析的已知代价，见 ResultReport.capability.limits）：
 *   - 表格、嵌套列表、Setext 标题（文字 + 下一行 === / ---）
 *   - 段落内某一行字面以 # 开头时会被误判为新标题
 *   - 链接/图片 alt 文本内的嵌套行内标记不再二次解析
 * ============================================================ */

import { newBook, warn, sanitizeHtml } from '../ir.js';

/* ---------- 转义 ---------- */

function escText(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
/** 把「已经过 escText 的片段」安全地塞进带引号的属性值：只需再挡双引号 */
function escQuote(s) {
  return String(s).replace(/"/g, '&quot;');
}

/** 从标题原文里剥掉行内 markdown 装饰，得到用作 title 的纯文本 */
function titleText(raw) {
  let t = String(raw).trim();
  t = t.replace(/`([^`]+)`/g, '$1');
  t = t.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/__([^_]+)__/g, '$1');
  t = t.replace(/\*([^*]+)\*/g, '$1');
  t = t.replace(/(^|[^\w])_([^_]+)_(?!\w)/g, '$1$2');
  t = t.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
  t = t.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
  return t.trim();
}

/** 粗略 slug（用于文内 `#锚点` 链接指回标题所在章节），非严格规范实现 */
function slugify(s) {
  return String(s)
    .trim()
    .toLowerCase()
    .replace(/[`*_[\]()!]/g, '')
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}-]/gu, '');
}

/** 手写 base64 解码（避免依赖浏览器 atob / Node Buffer，保持环境中立） */
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function base64Decode(str) {
  const clean = String(str).replace(/[^A-Za-z0-9+/=]/g, '');
  const bytes = [];
  for (let i = 0; i < clean.length; i += 4) {
    const c0 = B64.indexOf(clean[i]);
    const c1 = B64.indexOf(clean[i + 1]);
    const c2raw = clean[i + 2];
    const c3raw = clean[i + 3];
    const c2 = c2raw === undefined || c2raw === '=' ? -1 : B64.indexOf(c2raw);
    const c3 = c3raw === undefined || c3raw === '=' ? -1 : B64.indexOf(c3raw);
    if (c0 < 0 || c1 < 0) break;
    bytes.push((c0 << 2) | (c1 >> 4));
    if (c2 >= 0) bytes.push(((c1 & 0xf) << 4) | (c2 >> 2));
    if (c3 >= 0) bytes.push(((c2 & 0x3) << 6) | c3);
  }
  return new Uint8Array(bytes);
}

/* ---------- 相对路径图片：查 opts.siblingAssets ---------- */

const MIME_BY_EXT = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp',
};

function extOf(name) {
  const m = String(name).match(/\.([a-zA-Z0-9]+)$/);
  return m ? m[1].toLowerCase() : '';
}

/** 协议开头（http: https: mailto: 等）或协议相对（//host/...）视为绝对引用，不查 siblingAssets */
function isAbsoluteRef(src) {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(src) || src.startsWith('//');
}

function normalizeAssetKey(p) {
  let s = String(p).trim();
  try { s = decodeURIComponent(s); } catch { /* 非法转义序列，保留原样 */ }
  s = s.replace(/^\.\//, '').replace(/^\/+/, '');
  return s;
}

/**
 * 在 siblingAssets 里按文件名找图片二进制。siblingAssets 的 key 约定未知
 * （可能是相对 .md 的路径，也可能只是 basename），依次尝试几种归一化，
 * 尽量宽松匹配；找不到返回 null。
 */
function lookupSibling(siblingAssets, src) {
  if (!siblingAssets || typeof siblingAssets.get !== 'function') return null;
  const norm = normalizeAssetKey(src);
  const rawBase = src.split('/').pop();
  const normBase = norm.split('/').pop();
  const candidates = [src, norm, rawBase, normBase].filter(Boolean);
  for (const key of candidates) {
    if (siblingAssets.has(key)) return { key, data: siblingAssets.get(key) };
  }
  return null;
}

/* ---------- 按 ATX 标题切段 ---------- */

/**
 * @returns {{level:number, rawTitle:string|null, lines:string[]}[]}
 *   level===0 表示首个标题之前的前言段（title:null 章节）
 */
function splitSections(lines) {
  const sections = [];
  let current = { level: 0, rawTitle: null, lines: [] };
  let fenceChar = null; // '`' | '~' | null，围栏代码块内部时非空

  for (const line of lines) {
    const trimmed = line.trim();

    if (fenceChar) {
      current.lines.push(line);
      if (new RegExp(`^${fenceChar}{3,}$`).test(trimmed)) fenceChar = null;
      continue;
    }
    const fenceOpen = trimmed.match(/^(`{3,}|~{3,})/);
    if (fenceOpen) {
      fenceChar = fenceOpen[1][0];
      current.lines.push(line);
      continue;
    }

    const h = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (h) {
      sections.push(current);
      current = { level: Math.min(h[1].length, 3), rawTitle: h[2], lines: [] };
      continue;
    }
    current.lines.push(line);
  }
  sections.push(current);

  // 丢掉纯空白的前言段（除非它是唯一的 section——那样至少要留一章）
  return sections.filter((s, i, arr) => {
    if (s.level > 0) return true;
    const nonBlank = s.lines.some((l) => l.trim() !== '');
    return nonBlank || arr.length === 1;
  });
}

/* ---------- 块级渲染 ---------- */

function isHr(line) {
  const noSpace = line.trim().replace(/\s+/g, '');
  if (noSpace.length < 3) return false;
  return /^-+$/.test(noSpace) || /^\*+$/.test(noSpace) || /^_+$/.test(noSpace);
}

function renderBlock(lines, renderInline) {
  const out = [];
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i];
    if (line.trim() === '') { i++; continue; }

    // 围栏代码块
    const fence = line.trim().match(/^(`{3,}|~{3,})/);
    if (fence) {
      const marker = fence[1][0];
      const code = [];
      i++;
      while (i < n && !new RegExp(`^${marker}{3,}\\s*$`).test(lines[i].trim())) {
        code.push(lines[i]);
        i++;
      }
      if (i < n) i++; // 跳过收尾围栏行
      out.push(`<pre><code>${escText(code.join('\n'))}</code></pre>`);
      continue;
    }

    // 引用块
    if (/^>\s?/.test(line)) {
      const quote = [];
      while (i < n && (/^>\s?/.test(lines[i]) || (lines[i].trim() === '' && i + 1 < n && /^>\s?/.test(lines[i + 1])))) {
        quote.push(lines[i].trim() === '' ? '' : lines[i].replace(/^>\s?/, ''));
        i++;
      }
      out.push(`<blockquote>${renderBlock(quote, renderInline)}</blockquote>`);
      continue;
    }

    // 水平线（须在列表判断之前，否则 "- - -" 会被误判成列表项）
    if (isHr(line)) { out.push('<hr />'); i++; continue; }

    // 无序列表
    if (/^\s*[-*+]\s+/.test(line)) {
      const items = [];
      while (i < n && /^\s*[-*+]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*+]\s+/, '').trim());
        i++;
      }
      out.push(`<ul>${items.map((it) => `<li>${renderInline(it)}</li>`).join('')}</ul>`);
      continue;
    }

    // 有序列表
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items = [];
      while (i < n && /^\s*\d+[.)]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+[.)]\s+/, '').trim());
        i++;
      }
      out.push(`<ol>${items.map((it) => `<li>${renderInline(it)}</li>`).join('')}</ol>`);
      continue;
    }

    // 段落：吃到下一个空行或下一个特殊块为止
    const para = [];
    while (
      i < n && lines[i].trim() !== '' &&
      !/^(`{3,}|~{3,})/.test(lines[i].trim()) &&
      !/^>\s?/.test(lines[i]) &&
      !isHr(lines[i]) &&
      !/^\s*[-*+]\s+/.test(lines[i]) &&
      !/^\s*\d+[.)]\s+/.test(lines[i])
    ) {
      para.push(lines[i].trim());
      i++;
    }
    out.push(`<p>${renderInline(para.join(' '))}</p>`);
  }
  return out.join('');
}

/* ---------- 行内渲染 ---------- */

function renderInline(raw, ctx) {
  let s = escText(raw);

  // 行内代码：先保护内容，避免被加粗/斜体规则二次处理
  const codeStash = [];
  s = s.replace(/`([^`]+)`/g, (_, c) => {
    codeStash.push(c);
    return `\x00C${codeStash.length - 1}\x00`;
  });

  // 图片
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_, alt, src) => ctx.resolveImage(alt, src));

  // 链接
  s = s.replace(/\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_, label, href) => {
    const resolved = escQuote(ctx.resolveHref(href));
    return `<a href="${resolved}">${label}</a>`;
  });

  // 加粗
  s = s.replace(/\*\*([^*]+)\*\*/g, (_, t) => `<strong>${t}</strong>`);
  s = s.replace(/__([^_]+)__/g, (_, t) => `<strong>${t}</strong>`);

  // 斜体
  s = s.replace(/\*([^*]+)\*/g, (_, t) => `<em>${t}</em>`);
  s = s.replace(/(^|[^0-9A-Za-z])_([^_]+)_(?![0-9A-Za-z])/g, (_, pre, t) => `${pre}<em>${t}</em>`);

  // 还原行内代码
  s = s.replace(/\x00C(\d+)\x00/g, (_, idx) => `<code>${escText(codeStash[Number(idx)])}</code>`);

  return s;
}

/* ---------- 目录树 ---------- */

function buildNav(sections, chapterIds) {
  const root = [];
  const stack = []; // [{level, node}]
  sections.forEach((s, i) => {
    if (s.level === 0) return; // 前言不进目录
    const node = { title: titleText(s.rawTitle), target: chapterIds[i], anchor: null, level: s.level, children: [] };
    while (stack.length && stack[stack.length - 1].level >= s.level) stack.pop();
    if (stack.length) stack[stack.length - 1].node.children.push(node);
    else root.push(node);
    stack.push({ level: s.level, node });
  });
  return root;
}

/* ---------- 主流程 ---------- */

export async function read(buf, opts = {}) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let text = new TextDecoder('utf-8').decode(bytes);
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // 去 BOM
  text = text.replace(/\r\n?/g, '\n');
  const lines = text.split('\n');

  const sections = splitSections(lines);

  // 书名：若文档最开头就是标题（前言已被过滤掉），拿它当书名；否则退回文件名
  let title;
  if (sections.length && sections[0].level > 0) {
    title = titleText(sections[0].rawTitle);
  } else if (opts.filename) {
    title = String(opts.filename).replace(/^.*[\\/]/, '').replace(/\.[^./\\]+$/, '');
  }

  const book = newBook({ title, language: opts.language, author: opts.author });

  const chapterIds = sections.map((_, i) => `ch${i + 1}`);

  // 标题 slug → chapterId，供文内 `[x](#锚点)` 粗略解析回目标章节
  const slugMap = new Map();
  sections.forEach((s, i) => {
    if (s.level === 0) return;
    const slug = slugify(titleText(s.rawTitle));
    if (slug && !slugMap.has(slug)) slugMap.set(slug, chapterIds[i]);
  });

  const resolveHref = (href) => {
    if (href.startsWith('#')) {
      let frag = href.slice(1);
      try { frag = decodeURIComponent(frag); } catch { /* 保留原样 */ }
      const target = slugMap.get(slugify(frag));
      if (target) return `#${target}`;
    }
    return href;
  };

  let imgCounter = 0;
  const addImageResource = (data, mime, extHint) => {
    imgCounter += 1;
    const ext = (extHint || (mime.split('/')[1] || 'bin')).replace(/[^a-z0-9]/gi, '').toLowerCase() || 'bin';
    const rid = `img${imgCounter}`;
    const href = `images/${rid}.${ext}`;
    book.resources.set(rid, { href, mime, data: data instanceof Uint8Array ? data : new Uint8Array(data) });
    return href;
  };

  const resolveImage = (alt, src) => {
    // 1. data: URI 内嵌图片：原地解码
    const dataUri = src.match(/^data:([^;,]+)(?:;charset=[^;,]+)?;base64,([\s\S]+)$/i);
    if (dataUri) {
      const mime = dataUri[1];
      const data = base64Decode(dataUri[2]);
      if (data.length) {
        const href = addImageResource(data, mime);
        return `<img src="${escQuote(href)}" alt="${escQuote(alt)}" />`;
      }
    }

    // 2. 相对路径图片：调用方（如 zip reader）若一并传入了同目录兄弟文件，按文件名匹配
    if (!isAbsoluteRef(src)) {
      const hit = lookupSibling(opts.siblingAssets, src);
      if (hit && hit.data && hit.data.length) {
        const ext = extOf(hit.key) || extOf(src);
        const mime = MIME_BY_EXT[ext] || 'application/octet-stream';
        const href = addImageResource(hit.data, mime, ext);
        return `<img src="${escQuote(href)}" alt="${escQuote(alt)}" />`;
      }
    }

    // 3. 两条路径都没命中：本地相对路径缺 siblingAssets、或 http(s) 外链——零网络取不到图片数据
    warn(book, 'md.image-unresolved', `图片未随文件提供，已降级为替代文字: ${src.slice(0, 120)}`);
    return alt || '';
  };

  const ctx = { resolveHref, resolveImage };

  sections.forEach((s, i) => {
    book.chapters.push({
      id: chapterIds[i],
      title: s.level > 0 ? titleText(s.rawTitle) : null,
      level: s.level > 0 ? s.level : 1,
      html: sanitizeHtml(renderBlock(s.lines, (raw) => renderInline(raw, ctx))),
    });
  });

  if (!book.chapters.length) {
    book.chapters.push({ id: 'ch1', title: null, level: 1, html: '' });
  }
  if (!sections.some((s) => s.level > 0)) {
    warn(book, 'md.no-chapters', '未识别到任何 # 标题，全文作为单章处理');
  }

  book.nav = buildNav(sections, chapterIds);

  return book;
}
