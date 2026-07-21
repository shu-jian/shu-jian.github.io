/* ============================================================
 * src/writers/pdf.js · Book IR → 可打印自足 HTML（"PDF 输出"的降级路径）
 *
 * 契约：docs/harness/BOOK-IR.md §5「pdf（打印路径）」一行。
 *   用到字段：全部（meta / cover / resources / chapters / nav / notes）。
 *   丢弃字段：无。
 *   需要提示用户：是——「调起打印对话框、在对话框里选'存储为 PDF'」这句提示
 *     由调用方（src/ui/app.js）负责在触发打印前展示，文案由 ux-writer 定稿。
 *     本文件不写任何面向用户的界面文案，只产出书本内容本身。
 *
 * 设计决定（REQUIREMENTS.md R3「PDF 输出的降级方案」+ BOUNDARIES.md B2/B3）：
 *   不引入任何 PDF 生成库、不嵌入任何字体文件（含 CJK 字体子集）。
 *   产出一份排版良好、@page/@media print 控制分页与页边距的单文件 HTML，
 *   用户在浏览器里打开后用系统打印功能"打印 → 存储为 PDF"。
 *   调起打印对话框（window.print()）不在本模块——那是 UI 层的职责，
 *   本模块只负责把 Book IR 变成这份 HTML 的字节。
 *
 * 结构决定（与 epub/kepub 的多文件方案不同，此处只出一个 HTML 文档）：
 *   全书只有一个文档，因此 BOOK-IR §2.1 约定的"正文内交叉引用改写为
 *   #<ChapterId> 或 #<anchor>"、以及 notes 的 "#<NoteId>" noteref，
 *   全部可以直接沿用原始锚点字符串，不需要像 epub 那样重写成
 *   "文件名#锚点"——章节容器直接用 `id="<ChapterId>"`，注释容器直接用
 *   `id="<NoteId>"`，章内锚点本来就在 html 里原样保留。零重写，零出错面。
 *
 * 图片：resources 里的二进制原样转成 data:URI 内联进 <img src>。
 *   零外部资源引用，满足"自足单文件"与 I2（不发任何请求）。
 *
 * 环境中立：只用标准 JS（TextEncoder、Uint8Array），不碰 DOM，不做网络请求。
 *   大图片的 base64 编码分块处理并 await 让出主线程，大部头书的章节渲染
 *   同理分块，避免页面假死。
 *
 * IR 只读：本模块不修改传入的 book，不做深拷贝也不需要——从头到尾只读取。
 *
 * 返回值：Uint8Array（UTF-8 字节），不是 Blob——与其它 writer 的既定契约一致
 *   （见 docs/harness/AGENTS.md「契约仲裁」与 .claude/agents/format-writer.md）。
 *
 * 已知限制（如实记录，不隐藏）：
 *   - `@page` 的页眉页脚（margin box：@top-center / @bottom-center）是
 *     CSS Paged Media 的一部分，浏览器打印引擎支持程度不一，样式已写but
 *     实际显示效果依浏览器而异（本环境无 GUI 浏览器，未做真机验证）。
 *   - `writing-mode: vertical-rl` 在打印分页下的可靠性同样依赖浏览器
 *     打印引擎，未做真机验证，如实标注，不夸大承诺。
 *   - 章节标题的"缺才补、已有则跳过"判断只识别 html 最前面的一个
 *     h1-h6 标签，不做更深的结构分析（章节标题不在最前面的罕见排版
 *     会被判定为"缺"从而补一次，导致标题出现两次）。
 * ============================================================ */

import { plainText } from '../ir.js';

/** 主线程让出一次 tick，避免大部头书转换时页面假死 */
function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/* ---------- 文本 / 属性 / CSS 转义（ir.js 未导出对应函数，本地复刻同规则） ---------- */

function escapeHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escapeAttr(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
/** 把任意字符串变成可以安全放进 CSS 双引号字符串字面量、且外层还要再套一层
 *  XML 文本转义（因为 <style> 的内容对本文档而言仍是一个 XML 文本节点）。 */
function cssContentString(s) {
  const csc = String(s ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r?\n/g, ' ');
  return escapeHtml(csc);
}

/* ---------- base64（不依赖 btoa/Buffer，环境中立；分块 + 让出主线程） ---------- */

const B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const BASE64_CHUNK_BYTES = 240000; // 3 的倍数，约 240KB 原始数据一批，避免大图片单次编码卡主线程

function base64Chunk(bytes, start, end) {
  const out = [];
  let i = start;
  for (; i + 2 < end; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out.push(B64_CHARS[(n >> 18) & 63], B64_CHARS[(n >> 12) & 63], B64_CHARS[(n >> 6) & 63], B64_CHARS[n & 63]);
  }
  const rem = end - i;
  if (rem === 1) {
    const n = bytes[i] << 16;
    out.push(B64_CHARS[(n >> 18) & 63], B64_CHARS[(n >> 12) & 63], '=', '=');
  } else if (rem === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out.push(B64_CHARS[(n >> 18) & 63], B64_CHARS[(n >> 12) & 63], B64_CHARS[(n >> 6) & 63], '=');
  }
  return out.join('');
}

async function toBase64(bytes) {
  if (bytes.length <= BASE64_CHUNK_BYTES) return base64Chunk(bytes, 0, bytes.length);
  const parts = [];
  for (let start = 0; start < bytes.length; start += BASE64_CHUNK_BYTES) {
    parts.push(base64Chunk(bytes, start, Math.min(start + BASE64_CHUNK_BYTES, bytes.length)));
    await tick();
  }
  return parts.join('');
}

async function toDataUri(mime, bytes) {
  return `data:${mime || 'application/octet-stream'};base64,${await toBase64(bytes)}`;
}

/* ---------- 图片内联：把 <img src="resources 里的 href"> 换成 data:URI ---------- */

/** BOOK-IR §3：img[src] 必须精确等于 resources 里的 href（不是外链、不是 data URI，
 *  也不是 percent-encoded 的变体），所以这里做的是精确字符串查表替换。 */
function inlineImages(html, hrefToDataUri) {
  if (!html) return '';
  return String(html).replace(/<img\b([^>]*?)\/?>/gi, (whole, attrs) => {
    const m = /\bsrc\s*=\s*"([^"]*)"/.exec(attrs) || /\bsrc\s*=\s*'([^']*)'/.exec(attrs);
    if (!m) return whole;
    const uri = hrefToDataUri.get(m[1]);
    if (!uri) return whole; // 不应发生：validate() 已保证 img src 均可在 resources 中找到
    const rest = attrs.slice(0, m.index) + attrs.slice(m.index + m[0].length);
    return `<img src="${uri}"${rest}/>`;
  });
}

/* ---------- 章节标题：缺才补，已有则跳过（避免重复渲染标题） ---------- */

function extractLeadingHeadingText(html) {
  const m = /^\s*<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>/i.exec(String(html || ''));
  return m ? plainText(m[1]).trim() : null;
}

function headingTag(level) {
  return level === 2 ? 'h2' : level === 3 ? 'h3' : 'h1';
}

function renderChapterBody(ch, hrefToDataUri) {
  const withImages = inlineImages(ch.html, hrefToDataUri);
  const title = typeof ch.title === 'string' ? ch.title.trim() : '';
  if (!title) return withImages;
  if (extractLeadingHeadingText(ch.html) === title) return withImages;
  const tag = headingTag(ch.level);
  return `<${tag}>${escapeHtml(title)}</${tag}>${withImages}`;
}

function renderChapterSection(ch, hrefToDataUri) {
  const level = [1, 2, 3].includes(ch.level) ? ch.level : 1;
  const body = renderChapterBody(ch, hrefToDataUri);
  // id 直接用 ChapterId：全书唯一（BOOK-IR §2 typedef），单文档内直接可作跳转目标，
  // 无需像 epub 那样重写成"文件名#锚点"。
  return `<section class="chapter" id="${escapeAttr(ch.id)}" data-level="${level}">${body}</section>`;
}

/* ---------- 目录（书前 TOC）：与 nav 树形状一一对应，递归渲染 ---------- */

function renderNavList(list) {
  const items = (list || []).map((n) => {
    // BOOK-IR §2.1：正文交叉引用改写为 #<ChapterId>（章首）或 #<anchor>（章内锚点）。
    // 单文档内二者都是本文档内的合法 fragment，直接用，不重写。
    const href = n.anchor ? `#${n.anchor}` : `#${n.target}`;
    const kids = n.children && n.children.length ? renderNavList(n.children) : '';
    return `<li><a href="${escapeAttr(href)}">${escapeHtml(n.title || '')}</a>${kids}</li>`;
  });
  return `<ol>${items.join('')}</ol>`;
}

function renderTocSection(nav) {
  return `<nav class="toc"><h2>目录</h2>${renderNavList(nav || [])}</nav>`;
}

/* ---------- 书末注释：notes 是全部字段之一，pdf 路径不丢弃 ---------- */

function renderNotesSection(notes, hrefToDataUri) {
  if (!notes || notes.size === 0) return '';
  const items = [];
  for (const [id, note] of notes) {
    const body = inlineImages(note && note.html, hrefToDataUri);
    // id 直接用 NoteId：正文里的 <a class="noteref" href="#<NoteId>"> 已经是这个字符串
    // （BOOK-IR §2「notes」一行的既定格式），单文档内直接可点击跳转，无需重写。
    items.push(`<li id="${escapeAttr(id)}">${body}</li>`);
  }
  return `<section class="notes"><h2>注释</h2><ol>${items.join('')}</ol></section>`;
}

/* ---------- 书名页 ---------- */

function renderTitlePage(meta, coverUri) {
  const parts = ['<section class="titlepage">'];
  if (coverUri) parts.push(`<img class="cover" src="${coverUri}" alt="${escapeAttr(meta.title || '')}"/>`);
  parts.push(`<h1 class="book-title">${escapeHtml(meta.title || '')}</h1>`);
  if (meta.author) parts.push(`<p class="book-author">${escapeHtml(meta.author)}</p>`);
  const bits = [meta.publisher, meta.date].filter(Boolean).map(escapeHtml);
  if (bits.length) parts.push(`<p class="book-meta">${bits.join(' · ')}</p>`);
  if (meta.description) parts.push(`<p class="book-description">${escapeHtml(meta.description)}</p>`);
  parts.push('</section>');
  return parts.join('');
}

/* ---------- CSS：@page 页边距/页眉页脚、@media print 分页、@media screen 预览 ---------- */

const FONT_STACK =
  'Georgia, "Times New Roman", "Noto Serif CJK SC", "Source Han Serif SC", ' +
  '"Songti SC", "STSong", "SimSun", "PMingLiU", "Hiragino Mincho ProN", serif';

function renderCss(meta) {
  const vertical = meta.writingMode === 'vertical-rl';
  const headerTitle = cssContentString(meta.title || '');

  return `
:root { --serif: ${FONT_STACK}; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body { font-family: var(--serif); line-height: 1.75; color: #1a1a1a; }

@page {
  size: A4;
  margin: 2.2cm 1.8cm 2.4cm 1.8cm;
  @top-center { content: "${headerTitle}"; font-family: var(--serif); font-size: 9pt; color: #666; }
  @bottom-center { content: counter(page); font-family: var(--serif); font-size: 9pt; color: #666; }
}
@page :first {
  @top-center { content: none; }
  @bottom-center { content: none; }
}

.chapter { break-before: page; page-break-before: always; }
.titlepage, .toc { break-after: page; page-break-after: always; }
.notes { break-before: page; page-break-before: always; }
h1, h2, h3, h4, h5, h6 {
  break-after: avoid-page; page-break-after: avoid;
  break-inside: avoid; page-break-inside: avoid;
}
img, figure, table { break-inside: avoid; page-break-inside: avoid; }

@media print {
  a { color: inherit; text-decoration: none; }
}

@media screen {
  body { max-width: 42em; margin: 0 auto; padding: 2.5rem 1.5rem 6rem; background: #fff; }
  .chapter { border-top: 1px solid #eee; margin-top: 3rem; padding-top: 1.5rem; }
  .chapter:first-of-type { border-top: none; margin-top: 0; }
  .titlepage { text-align: center; margin-bottom: 3rem; }
  .toc { margin-bottom: 3rem; }
  .cover { max-height: 60vh; }
}

figure { margin: 1.2em 0; text-align: center; }
img { max-width: 100%; height: auto; }
figcaption { font-size: 0.9em; color: #555; margin-top: 0.4em; }
blockquote { margin: 1em 1.6em; color: #333; border-left: 2px solid #ccc; padding-left: 0.8em; }
table { border-collapse: collapse; width: 100%; margin: 1em 0; }
th, td { border: 1px solid #ccc; padding: 0.4em 0.6em; }
.book-title { font-size: 1.8em; text-align: center; margin: 1em 0 0.4em; }
.book-author, .book-meta { text-align: center; color: #444; margin: 0.2em 0; }
.book-description { color: #555; margin-top: 1em; }
.toc h2, .notes h2 { font-size: 1.3em; margin-bottom: 0.6em; }
.toc ol, .notes ol { list-style: none; padding-left: 0; }
.toc li { margin: 0.5em 0; }
.toc ol ol { padding-left: 1.4em; margin-top: 0.3em; }
.toc a { color: inherit; text-decoration: none; }
.notes li { margin: 0.7em 0; font-size: 0.95em; color: #333; }
ruby rt { font-size: 0.55em; }
${vertical ? `
[data-writing-mode="vertical-rl"] body,
[data-writing-mode="vertical-rl"] .chapter,
[data-writing-mode="vertical-rl"] .titlepage,
[data-writing-mode="vertical-rl"] .toc,
[data-writing-mode="vertical-rl"] .notes {
  writing-mode: vertical-rl;
  -webkit-writing-mode: vertical-rl;
  text-orientation: mixed;
}
` : ''}`;
}

/* ---------- 整份文档 ---------- */

function renderDocument(meta, bodyHtml) {
  const title = escapeHtml(meta.title || '未命名');
  const lang = escapeAttr(meta.language || 'zh-Hans');
  const vertical = meta.writingMode === 'vertical-rl';
  const css = renderCss(meta);
  return (
    '<!DOCTYPE html>\n' +
    `<html lang="${lang}"${vertical ? ' data-writing-mode="vertical-rl"' : ''}>\n` +
    '<head>\n' +
    '<meta charset="utf-8"/>\n' +
    `<title>${title}</title>\n` +
    `<style>${css}\n</style>\n` +
    '</head>\n' +
    `<body>\n${bodyHtml}\n</body>\n` +
    '</html>\n'
  );
}

/**
 * @param {import('../ir.js').Book} book    只读，不修改
 * @param {object} [opts]                   预留（当前无可配置项）
 * @param {(p:number)=>void} [onProgress]   进度回调，取值 0..1
 * @returns {Promise<Uint8Array>}           UTF-8 编码的完整自足 HTML 文档字节
 */
export async function write(book, opts = {}, onProgress = () => {}) {
  onProgress(0);

  const meta = (book && book.meta) || {};
  const chapters = Array.isArray(book && book.chapters) ? book.chapters : [];
  const nav = Array.isArray(book && book.nav) ? book.nav : [];
  const notes = book && book.notes instanceof Map ? book.notes : new Map();
  const resources = book && book.resources instanceof Map ? book.resources : new Map();

  // 1) 全部资源转 data:URI（href -> data:URI），大图片分块编码 + 让出主线程
  const hrefToDataUri = new Map();
  const resourceEntries = [...resources.entries()];
  const totalRes = Math.max(resourceEntries.length, 1);
  for (let i = 0; i < resourceEntries.length; i++) {
    const [, res] = resourceEntries[i];
    hrefToDataUri.set(res.href, await toDataUri(res.mime, res.data));
    onProgress(Math.min(0.3, ((i + 1) / totalRes) * 0.3));
    if (i > 0 && i % 5 === 0) await tick();
  }

  const coverUri =
    book && book.cover && resources.has(book.cover) ? hrefToDataUri.get(resources.get(book.cover).href) : null;

  onProgress(0.3);

  // 2) 书名页 + 目录页
  const parts = [renderTitlePage(meta, coverUri), renderTocSection(nav)];

  // 3) 章节，按 chapters 顺序线性排布（"书"的本体，BOOK-IR §2）
  const totalCh = Math.max(chapters.length, 1);
  for (let i = 0; i < chapters.length; i++) {
    parts.push(renderChapterSection(chapters[i], hrefToDataUri));
    onProgress(0.3 + Math.min(0.55, ((i + 1) / totalCh) * 0.55));
    if (i > 0 && i % 20 === 0) await tick();
  }

  // 4) 书末注释
  parts.push(renderNotesSection(notes, hrefToDataUri));

  onProgress(0.9);

  const doc = renderDocument(meta, parts.join('\n'));
  const bytes = new TextEncoder().encode(doc);

  onProgress(1);
  return bytes;
}
