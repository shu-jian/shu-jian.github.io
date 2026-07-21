/* ============================================================
 * src/writers/epub.js · Book IR → EPUB 3
 *
 * 契约：docs/harness/BOOK-IR.md §5 —— epub writer 消费 IR 的全部字段，
 *   不丢弃任何东西（对照表格该行是"全部 / — / 否"）。
 *
 * 产物结构（第 2 轮修复后：不再自造 "OEBPS/" 前缀，见下方"第 2 轮"说明）：
 *   mimetype                    STORE，zip 首个条目
 *   META-INF/container.xml      指向 content.opf（zip 根目录，非 OEBPS/ 子目录）
 *   content.opf                 EPUB3 package document
 *   nav.xhtml                   EPUB3 导航文档（含 <nav epub:type="toc">）
 *   toc.ncx                     EPUB2 兼容目录
 *   style.css
 *   <章节文件>.xhtml            与 resources 同级，img[src] 相对路径无需改写
 *   <resource.href>             资源路径原样落盘（href 本身可能已带自己的目录前缀）
 *
 * 已知坑（CLAUDE.md §7 / WorkPacket）都在这里处理：
 *   - mimetype 首条目 + STORE，见 write() 开头
 *   - 非 ASCII 文件名：zip 条目名用字面 UTF-8（可读），但 OPF/NAV/NCX/正文里
 *     引用它的 href 一律做 percent-encoding（encodeHrefPath），两者一一对应
 *   - meta.writingMode === 'vertical-rl'：spine 加 page-progression-direction="rtl"，
 *     并在 style.css 里给 body.vertical-rl 设 writing-mode
 *
 * 第 2 轮修复（epub reader 落地后，真实 read→write→read 暴露的 3 处缺陷）：
 *   1. 章节正文里的 <hN>{title}</hN> 改为"缺才补"，不再无条件注入。
 *      根因排查：epub reader 认标题的唯一途径是扫正文开头的 <h1>-<h6>（试过 <title>
 *      标签、nav.xhtml 链接文本都不认，黑盒实测确认），且它是逐字保留 html 的——
 *      读到什么就是什么，不会把标题摘出 html。所以：
 *        - epub 源书：html 里本来就带着与 title 相同的标题标签，旧实现无条件再注入
 *          一次 → 标题出现两次，回读字数被算重复、标题也不再是"当前实现唯一还原"。
 *        - md/txt 源书：它们的 reader 约定"标题不进 html"，回读时若完全不注入标题，
 *          epub reader 会因为正文里找不到标题标签而把 title 读成 null——这会让章节
 *          标题序列这项硬性（0 容差）比对失败，比字数超出 ±0.5% 容差更严重。
 *      两害相权：`bodyHasMatchingTitleHeading()` 检测正文里第一个 <hN> 是否已是与
 *      title 文字相同的标题标签，有就不重复注入（消除 epub 源书的重复），没有就照旧补一个（保证
 *      md/txt 源书回读标题不丢）。副作用：md/sample.md 这类"标题本不进 html"的源书，
 *      回读字数会比它自己 reader 的原生统计多出标题的字数，超出该样本 expected.json
 *      按"标题不算正文"口径定的 ±0.5% —— 这不是本文件能单方面解决的，已在
 *      ResultReport 里作为 needs_human 提给 Orchestrator（建议重新核定该样本的
 *      chars 基准，把标题计入，与 epub 源书样本的口径一致）。
 *   2. 不再把资源/自身文档统一挂在写死的 "OEBPS/" 目录下。
 *      根因：resources[].href 是 reader 给的、已经"扁平化"过的 zip 内绝对路径
 *      （例如某些源书内部就是 "OEBPS/images/x.png"），旧实现又在外面套一层
 *      "OEBPS/" 前缀，拼出 "OEBPS/OEBPS/images/x.png"，实际存入 zip 的路径和
 *      章节 html 里 <img src="OEBPS/images/x.png"> 引用的路径对不上。
 *      修法：写手自己产出的文档（章节/opf/nav/ncx/css）与 resources 一起放在
 *      zip 根目录，resources 的 zip 路径就是 res.href 本身，不再叠加前缀——
 *      这样 img[src] 沿用 IR 里的原始 href 字面值就能直接解析到正确条目。
 *   3. notes 不再打包成书末独立 "章节"（且挂进 spine）。
 *      根因：真实源书里脚注是内嵌在引用它的那一章文档内的
 *      <aside epub:type="footnote" id="…">，引用处是 <a epub:type="noteref"
 *      href="#…">（reader 读进 IR 时才转写成 IR 的 class="noteref" 形式）。
 *      旧实现把所有 notes 攒成单独一个 notes.xhtml 并塞进 spine，epub reader
 *      于是把它当成第 4 "章"，跨文件的 noteref 链接被当成普通章节间引用改写，
 *      不再指向任何真实 NoteId，回读 validate() 报 noteref 悬空。
 *      修法：每条 note 内嵌进"第一个引用它的章节"文档末尾（孤儿 note 挂到最后一章），
 *      引用处的 <a> 同时带 class="noteref" 与 epub:type="noteref"，不再生成独立文档。
 *
 * 第 3 轮修复（D1，verifier 实测）：
 *   bodyHasMatchingTitleHeading()（当时名为 startsWithMatchingHeading）剥标签比对标题文字时，没有先剔除 <rt>/<rp> 的*内容*
 *   （只剥了标签本身），导致日语书经 furigana 注音后（标题变成
 *   <h1><ruby>第<rt>だい</rt></ruby>…</h1>）被读成"第だい一いち章しょう"，
 *   永远匹配不上纯文本 title「第一章」，于是在已注音的标题前又误注入一个未注音的
 *   重复 <h1>。修法：比对前先剥 <rt>…</rt> / <rp>…</rp>（连内容一起），再剥其余标签
 *   取纯文字。kepub writer 黑盒借道本文件的 write()，随此修复一并修好。
 *
 * 导出契约（Orchestrator 仲裁，2026-07-20）：
 *   write(book, opts, onProgress) -> Uint8Array（不是 Blob）。
 *   原因：Node 环境下 `new Uint8Array(blob)` 会静默解出空数组，
 *   下载用的 Blob 由 UI 集成层按需包一层 `new Blob([bytes], {type:...})`。
 *
 * IR 是只读的：本模块只读 book 的字段，不对其做任何原地修改；
 *   所有变形（sanitize、id 改写、href 改写、note 归并）都在本地新字符串/新
 *   Map 上进行。
 * ============================================================ */

import { sanitizeHtml } from '../ir.js';

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/* ---------- XML / URI 小工具 ---------- */

function escText(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escAttr(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
/** zip 条目名保留字面 UTF-8；引用它的 href 按段 percent-encode（RFC 3986） */
function encodeHrefPath(path) {
  return String(path).split('/').map(encodeURIComponent).join('/');
}

/** 生成 XML NCName 安全、全书唯一、可复现（同一 raw 值永远映射到同一结果）的 id */
function makeIdSanitizer() {
  const cache = new Map();
  const used = new Set();
  return function safeId(raw) {
    const key = String(raw);
    if (cache.has(key)) return cache.get(key);
    let s = key.normalize ? key.normalize('NFC') : key;
    // NCName 允许的字符集（含 CJK）；其余一律替换为连字符
    s = s.replace(/[^\p{L}\p{N}_.-]/gu, '-').replace(/-{2,}/g, '-').replace(/^[-.]+|[-.]+$/g, '');
    if (!s) s = 'id';
    if (/^[0-9]/.test(s)) s = 'id-' + s; // NCName 不能以数字开头
    let candidate = s, n = 2;
    while (used.has(candidate)) candidate = `${s}-${n++}`;
    used.add(candidate);
    cache.set(key, candidate);
    return candidate;
  };
}

/** 章节标题 → 文件名基底，剥掉文件系统/zip 路径不安全字符 */
function slugifyFileBase(title, fallback) {
  let s = String(title || '').trim();
  s = s.replace(/[\\/:*?"<>|\x00-\x1F]/g, '');
  s = s.replace(/\s+/g, '-').replace(/-{2,}/g, '-');
  s = s.slice(0, 60).replace(/^-+|-+$/g, '');
  return s || fallback;
}

function tocLabelFor(lang) {
  const zh = /^zh/i.test(lang || '');
  const ja = /^ja/i.test(lang || '');
  return zh ? '目录' : ja ? '目次' : 'Contents';
}

function navDepth(nav) {
  let max = 0;
  const walk = (list, d) => { for (const n of list || []) { max = Math.max(max, d); walk(n.children, d + 1); } };
  walk(nav, 1);
  return max || 1;
}

/** 正文里 epub reader 会当成章节标题的那个标题（正文中*第一个* <hN>）是否与 title
 * 文字相同——相同就说明标题已在正文内，writer 无需再补注入（否则回读会重复）。
 *
 * 必须与 src/readers/epub.js 的 extractFirstHeading 对称：reader 认的是正文里
 * *第一个* <h1>-<h6>（出现在任意位置，不要求在开头），并不在意它前面还裹着什么。
 *
 * 第 4 轮修复（writer_epub_04，真实源书 read→write→read 暴露）：本函数原先只认
 * "开头"（`^\s*<hN>`）的标题标签，漏判了"标题前面还裹着封面图 <div> / 外层 <div>"
 * 这类正文——reader 仍从内部的 <hN> 取到 title，writer 却因不在开头判成"标题缺失"
 * 又注入一个 <hN>，回读时正文里就有了两个相同标题（displayText 变长）。
 *   实测：testBook/出發 (韓寒).epub 纯 read→write→read，displayText 120443→121633，
 *   根因即首章 `<div><div class=cover>…</div><h1>出發</h1>…`、目次章 `<div><h3>目次</h3>`
 *   的标题都不在开头，被重复注入。改为"匹配正文中第一个 <hN>"即与 reader 对称。
 *
 * 第 3 轮修复（D1）：比对前先剥掉 <rt>/<rp>（连同内部内容）再剥其余标签。
 * 根因：furigana transform 会把标题标签标注成
 *   <h1><ruby>第<rt>だい</rt></ruby><ruby>一<rt>いち</rt></ruby>章<ruby>...<rt>...</rt></ruby></h1>
 * 这类形态——旧实现只剥"标签本身"（`<[^>]+>` 只吃掉尖括号定界的标签，吃不掉
 * <rt>…</rt> 里的读音*内容*，那是普通文本节点），于是拿"第だい一いち章しょう"
 * 去跟纯文本 title「第一章」比较，永远判不相等，导致已注音的标题前又被注入一个
 * 未注音的重复 <hN>。<rt>/<rp> 在 sanitizeHtml 之后保证良构、不自嵌套，
 * 用非贪婪正则整段剥除（连内容一起）是安全的；多个 <ruby> 并列（逐字/逐词标注）
 * 时正则会依次剥掉每一段，不受影响。 */
function bodyHasMatchingTitleHeading(html, title) {
  if (title == null) return false;
  const m = /<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>/i.exec(html || '');
  if (!m) return false;
  const withoutReadings = m[1]
    .replace(/<rt\b[^>]*>[\s\S]*?<\/rt>/gi, '')
    .replace(/<rp\b[^>]*>[\s\S]*?<\/rp>/gi, '');
  const text = withoutReadings.replace(/<[^>]+>/g, '').trim().replace(/\s+/g, ' ');
  const norm = String(title).trim().replace(/\s+/g, ' ');
  return text === norm;
}

/** 章节正文（已 sanitize）里所有 class 含 noteref 的 <a href="#X">，返回引用到的原始 id 列表 */
function findNoterefIds(html) {
  const ids = [];
  const tagRe = /<a\b([^>]*)>/gi;
  let m;
  while ((m = tagRe.exec(html))) {
    const attrs = m[1];
    if (!/\bclass="[^"]*\bnoteref\b[^"]*"/.test(attrs)) continue;
    const hrefM = attrs.match(/\bhref="#([^"]*)"/);
    if (hrefM) ids.push(hrefM[1]);
  }
  return ids;
}

const CONTAINER_XML =
`<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="content.opf" media-type="application/oebps-package+xml" />
  </rootfiles>
</container>
`;

const STYLE_CSS =
`html, body { margin: 0; padding: 0; }
body { line-height: 1.7; }
body.vertical-rl {
  writing-mode: vertical-rl;
  -epub-writing-mode: vertical-rl;
  -webkit-writing-mode: vertical-rl;
  text-orientation: mixed;
}
img { max-width: 100%; }
section.chapter { }
ruby rt { font-size: 0.6em; }
aside[epub|type~="footnote"] { font-size: 0.92em; }
nav[epub|type~="toc"] ol { list-style: none; padding-left: 1em; }
`;

/**
 * Book IR → EPUB 3 二进制。
 * @param {import('../ir.js').Book} book  只读，不会被修改
 * @param {object} [opts]
 * @param {(p:number)=>void} [onProgress]
 * @returns {Promise<Uint8Array>}
 */
export async function write(book, opts = {}, onProgress = () => {}) {
  if (typeof globalThis.JSZip === 'undefined') {
    throw new Error('JSZip 未加载，无法生成 EPUB');
  }
  const chapters = Array.isArray(book.chapters) ? book.chapters : [];
  if (!chapters.length) throw new Error('book.chapters 为空，无法生成 EPUB');

  const meta = book.meta || {};
  const language = meta.language || 'zh-Hans';
  const vertical = meta.writingMode === 'vertical-rl';
  const resources = book.resources instanceof Map ? book.resources : new Map();
  const notes = book.notes instanceof Map ? book.notes : new Map();

  onProgress(0);

  const safeId = makeIdSanitizer();

  /* ---------- 1. 章节文件名分配（标题 slug，非 ASCII 也可，唯一化） ---------- */
  const reserved = new Set(['content.opf', 'nav.xhtml', 'toc.ncx', 'style.css']);
  const chapterFile = new Map(); // ChapterId -> 文件名
  chapters.forEach((ch, i) => {
    const fallback = `chapter-${String(i + 1).padStart(4, '0')}`;
    const base = slugifyFileBase(ch.title, fallback);
    let name = `${base}.xhtml`, n = 2;
    while (reserved.has(name.toLowerCase())) { name = `${base}-${n++}.xhtml`; }
    reserved.add(name.toLowerCase());
    chapterFile.set(ch.id, name);
  });

  /* ---------- 2. 章节起始锚点 + 交叉引用目标索引 ---------- */
  const chapterFrag = new Map(); // ChapterId -> 安全 fragment id（同时是该章 <section id>）
  chapters.forEach((ch) => chapterFrag.set(ch.id, safeId(ch.id)));

  const targetIndex = new Map(); // 原始 id 字符串（ChapterId 或章内 id）-> {file, frag}
  chapters.forEach((ch) => {
    targetIndex.set(ch.id, { file: chapterFile.get(ch.id), frag: chapterFrag.get(ch.id) });
  });

  const sanitized = new Map(); // ChapterId -> sanitizeHtml 后的正文（改写前）
  chapters.forEach((ch) => sanitized.set(ch.id, sanitizeHtml(ch.html || '')));

  chapters.forEach((ch) => {
    const html = sanitized.get(ch.id);
    const re = /\bid="([^"]*)"/g;
    let m;
    while ((m = re.exec(html))) {
      const raw = m[1];
      if (!targetIndex.has(raw)) {
        targetIndex.set(raw, { file: chapterFile.get(ch.id), frag: safeId(raw) });
      }
    }
  });

  /* ---------- 2b. notes 归并：每条 note 挂到"第一个引用它的章节"，孤儿挂最后一章 ---------- */
  const noteFrag = new Map(); // NoteId -> 安全 fragment id
  for (const nid of notes.keys()) noteFrag.set(nid, safeId(nid));

  const noteOwnerFile = new Map(); // NoteId -> 该 note 内嵌所在的章节文件名
  chapters.forEach((ch) => {
    const html = sanitized.get(ch.id);
    for (const nid of findNoterefIds(html)) {
      if (noteFrag.has(nid) && !noteOwnerFile.has(nid)) {
        noteOwnerFile.set(nid, chapterFile.get(ch.id));
      }
    }
  });
  if (noteFrag.size) {
    const lastFile = chapterFile.get(chapters[chapters.length - 1].id);
    for (const nid of noteFrag.keys()) {
      if (!noteOwnerFile.has(nid)) noteOwnerFile.set(nid, lastFile); // 孤儿 note（无人引用）
    }
  }

  /**
   * 解析正文里的内部 #href：优先当作 note 引用（落到 note 所在章节文档），
   * 否则按章节/章内锚点解析。返回 null 表示无法解析（按 IR 约定不应发生）。
   */
  function resolveFragment(rawId, fromFile) {
    if (noteFrag.has(rawId)) {
      const ownerFile = noteOwnerFile.get(rawId);
      const frag = noteFrag.get(rawId);
      const href = ownerFile === fromFile ? `#${frag}` : `${encodeHrefPath(ownerFile)}#${frag}`;
      return { href, isNote: true };
    }
    const t = targetIndex.get(rawId);
    if (t) {
      const href = t.file === fromFile ? `#${t.frag}` : `${encodeHrefPath(t.file)}#${t.frag}`;
      return { href, isNote: false };
    }
    return null;
  }

  /** 改写一段已 sanitize 的正文：id 归一化 + img[src] 编码 + 内部 #href 解析（含 noteref 标注） */
  function rewriteBody(html, fromFile) {
    let out = html.replace(/\bid="([^"]*)"/g, (m0, raw) => `id="${escAttr(safeId(raw))}"`);
    out = out.replace(/(<img\b[^>]*\ssrc=")([^"]*)(")/gi, (m0, pre, src, post) => {
      if (/^([a-z][a-z0-9+.-]*:)?\/\//i.test(src) || /^data:/i.test(src)) return m0; // 不该出现，防御性跳过
      return pre + encodeHrefPath(src) + post;
    });
    out = out.replace(/(<a\b)([^>]*\shref=")#([^"]*)(")/gi, (m0, open, mid, raw, post) => {
      const resolved = resolveFragment(raw, fromFile);
      if (!resolved) return m0;
      const openTag = resolved.isNote && !/\sepub:type=/.test(mid) ? `${open} epub:type="noteref"` : open;
      return `${openTag}${mid}${escAttr(resolved.href)}${post}`;
    });
    return out;
  }

  /* ---------- 2c. 每章要内嵌的 note asides（EPUB3 popup footnote 惯例） ---------- */
  const noteAsidesByFile = new Map(); // 文件名 -> aside html[]
  for (const [nid, note] of notes) {
    const ownerFile = noteOwnerFile.get(nid);
    const frag = noteFrag.get(nid);
    const body = rewriteBody(sanitizeHtml(note.html || ''), ownerFile);
    const aside = `<aside epub:type="footnote" id="${escAttr(frag)}">\n${body}\n</aside>`;
    if (!noteAsidesByFile.has(ownerFile)) noteAsidesByFile.set(ownerFile, []);
    noteAsidesByFile.get(ownerFile).push(aside);
  }

  /* ---------- 3. 目录树：如实使用 book.nav，不代它凭空生成 ----------
   * 第 2 轮修复前这里在 book.nav 为空时会按章节标题自动补一份平铺目录，
   * 本意是提升"裸转"场景的可用性，但黑盒回读证明这是结构保真的反向违规——
   * G3 比对的是"目录树形状"跟原 IR 一致，IR 里没有的 nav 不该被写手凭空造出来
   * （zip/*.zip 黄金样本的 book.nav 本就是 []，回读后被判"目录树形状不一致"）。
   * 老实反映 IR：book.nav 是空的，nav.xhtml 就只有一个空 <ol>。 */
  const effectiveNav = Array.isArray(book.nav) ? book.nav : [];

  function resolveNavTarget(nv) {
    const file = chapterFile.get(nv.target);
    const frag = nv.anchor ? safeId(nv.anchor) : chapterFrag.get(nv.target);
    return { file, frag };
  }

  function buildNavList(list) {
    if (!list || !list.length) return '';
    const items = list.map((nv) => {
      const { file, frag } = resolveNavTarget(nv);
      const href = file ? `${encodeHrefPath(file)}#${frag}` : '#';
      const children = buildNavList(nv.children);
      return `<li><a href="${escAttr(href)}">${escText(nv.title || '')}</a>${children}</li>`;
    }).join('\n');
    return `<ol>\n${items}\n</ol>`;
  }

  let playOrder = 0;
  function buildNcxPoints(list) {
    return (list || []).map((nv) => {
      playOrder += 1;
      const id = `navpoint-${playOrder}`;
      const { file, frag } = resolveNavTarget(nv);
      const src = file ? `${encodeHrefPath(file)}#${frag}` : '#';
      const children = buildNcxPoints(nv.children);
      return `<navPoint id="${id}" playOrder="${playOrder}">
<navLabel><text>${escText(nv.title || '')}</text></navLabel>
<content src="${escAttr(src)}" />
${children}
</navPoint>`;
    }).join('\n');
  }

  const tocLabel = tocLabelFor(language);
  const navListHtml = buildNavList(effectiveNav) || '<ol></ol>';
  const navDoc =
`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="${escAttr(language)}" xml:lang="${escAttr(language)}">
<head>
<meta charset="UTF-8" />
<title>${escText(tocLabel)}</title>
<link rel="stylesheet" type="text/css" href="style.css" />
</head>
<body>
<nav epub:type="toc" id="toc">
<h1>${escText(tocLabel)}</h1>
${navListHtml}
</nav>
</body>
</html>
`;

  const ncxBody = buildNcxPoints(effectiveNav);
  const ncxDoc =
`<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1" xml:lang="${escAttr(language)}">
<head>
<meta name="dtb:uid" content="${escAttr(meta.identifier || '')}" />
<meta name="dtb:depth" content="${navDepth(effectiveNav)}" />
<meta name="dtb:totalPageCount" content="0" />
<meta name="dtb:maxPageNumber" content="0" />
</head>
<docTitle><text>${escText(meta.title || '')}</text></docTitle>
<navMap>
${ncxBody}
</navMap>
</ncx>
`;

  onProgress(0.04);

  /* ---------- 4. 打包（章节/资源/自身文档全部落在 zip 根目录，见文件头"第 2 轮修复"说明） ---------- */
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' }); // 必须是首个条目且不压缩
  zip.file('META-INF/container.xml', CONTAINER_XML);
  zip.file('style.css', STYLE_CSS);

  const totalUnits = chapters.length + resources.size || 1;
  let doneUnits = 0;

  // 资源原样落盘：zip 路径 = res.href 字面值（reader 给的已是可直接寻址的内部路径，
  // 不再叠加任何前缀）；引用它的地方另做 percent-encoding。
  let ri = 0;
  const resItemId = new Map();
  let coverItemId = null;
  for (const [rid, res] of resources) {
    ri += 1;
    const id = `res-${ri}`;
    resItemId.set(rid, id);
    if (book.cover != null && rid === book.cover) coverItemId = id;
    zip.file(res.href, res.data);
    doneUnits += 1;
    onProgress(0.04 + 0.6 * (doneUnits / totalUnits));
    if (ri % 8 === 0) await tick();
  }

  // 章节文档：标题只在"正文里还没有"时才补一个 <hN>（epub reader 只认正文里的标题标签，
  // 见文件头"第 2 轮修复"1 —— 无标题可注入时不重复，本来就没有标题标签时才补）
  const manifestItems = [];
  const spineItems = [];
  let ci = 0;
  for (const ch of chapters) {
    ci += 1;
    const file = chapterFile.get(ch.id);
    const rawHtml = sanitized.get(ch.id);
    const bodyInner = rewriteBody(rawHtml, file);
    const asides = noteAsidesByFile.get(file);
    const asidesHtml = asides && asides.length ? `\n${asides.join('\n')}` : '';
    const level = Math.min(Math.max(ch.level || 1, 1), 6);
    const heading = ch.title != null && !bodyHasMatchingTitleHeading(rawHtml, ch.title)
      ? `<h${level}>${escText(ch.title)}</h${level}>\n`
      : '';
    const bodyClass = vertical ? ' class="vertical-rl"' : '';
    const doc =
`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="${escAttr(language)}" xml:lang="${escAttr(language)}">
<head>
<meta charset="UTF-8" />
<title>${escText(ch.title || meta.title || '')}</title>
<link rel="stylesheet" type="text/css" href="style.css" />
</head>
<body${bodyClass}>
<section id="${escAttr(chapterFrag.get(ch.id))}" class="chapter">
${heading}${bodyInner}${asidesHtml}
</section>
</body>
</html>
`;
    zip.file(file, doc);
    const itemId = `chap-${ci}`;
    manifestItems.push(`<item id="${itemId}" href="${escAttr(encodeHrefPath(file))}" media-type="application/xhtml+xml" />`);
    spineItems.push(`<itemref idref="${itemId}" />`);

    doneUnits += 1;
    onProgress(0.04 + 0.6 * (doneUnits / totalUnits));
    if (ci % 15 === 0) await tick();
  }

  onProgress(0.66);
  await tick();

  // resources 的 manifest 项（放在章节之后写，避免打断上面的进度计数逻辑）
  for (const [rid, res] of resources) {
    const id = resItemId.get(rid);
    const props = coverItemId === id ? ' properties="cover-image"' : '';
    manifestItems.push(
      `<item id="${id}" href="${escAttr(encodeHrefPath(res.href))}" media-type="${escAttr(res.mime || 'application/octet-stream')}"${props} />`
    );
  }
  manifestItems.push('<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav" />');
  manifestItems.push('<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx-xml" />');
  manifestItems.push('<item id="css" href="style.css" media-type="text/css" />');

  zip.file('nav.xhtml', navDoc);
  zip.file('toc.ncx', ncxDoc);

  const dcCreator = meta.author ? `<dc:creator>${escText(meta.author)}</dc:creator>` : '';
  const dcPublisher = meta.publisher ? `<dc:publisher>${escText(meta.publisher)}</dc:publisher>` : '';
  const dcDate = meta.date ? `<dc:date>${escText(meta.date)}</dc:date>` : '';
  const dcDesc = meta.description ? `<dc:description>${escText(meta.description)}</dc:description>` : '';
  const metaCover = coverItemId ? `<meta name="cover" content="${escAttr(coverItemId)}" />` : '';
  const modified = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

  const opfDoc =
`<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id" xml:lang="${escAttr(language)}">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:identifier id="pub-id">${escText(meta.identifier || '')}</dc:identifier>
<dc:title>${escText(meta.title || '')}</dc:title>
<dc:language>${escText(language)}</dc:language>
${dcCreator}
${dcPublisher}
${dcDate}
${dcDesc}
<meta property="dcterms:modified">${modified}</meta>
${metaCover}
</metadata>
<manifest>
${manifestItems.join('\n')}
</manifest>
<spine toc="ncx"${vertical ? ' page-progression-direction="rtl"' : ''}>
${spineItems.join('\n')}
</spine>
</package>
`;
  zip.file('content.opf', opfDoc);

  onProgress(0.7);

  const bytes = await zip.generateAsync(
    { type: 'uint8array', compression: 'DEFLATE' },
    (m) => onProgress(0.7 + 0.3 * (m.percent / 100))
  );
  onProgress(1);
  return bytes;
}
