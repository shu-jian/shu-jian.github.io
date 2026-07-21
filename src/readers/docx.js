/* ============================================================
 * src/readers/docx.js · DOCX → Book IR
 *
 * 分工：globalThis.mammoth（vendor 注入的 UMD，浏览器端由集成层按需从 CDN
 *   加载；本模块自己不发任何网络请求）负责「OOXML → HTML」的转换；本模块
 *   只做「HTML → IR」的整形：
 *     - 按 h1/h2/h3 切章、按标题层级建 nav 树（h4-h6 保留在正文内当子标题，
 *       不参与切章——IR 的 chapter.level 只有 1|2|3，这是 schema 的硬限制，
 *       不是本 reader 的降级）
 *     - <w:drawing> 内嵌图片 → resources（写成真实文件而非 data URI）
 *     - 脚注/尾注 → notes，正文留 <a class="noteref">（BOOK-IR §2.1 约定：
 *       脚注/尾注不作区分，统一进 notes）
 *
 * mammoth 产出的 HTML 已经是干净的白名单子集（h1-h6/p/img/sup/a…），但仍
 * 过一遍 sanitizeHtml() 兜底——不直接信任第三方输出，尤其是 style 属性。
 *
 * 元数据：docProps/core.xml 不在 mammoth 的产出范围内（它只转换正文），
 *   用 globalThis.JSZip（vendor 同源注入）单独读一次。JSZip 缺失时静默跳过
 *   ——书名/作者是锦上添花，缺了不影响正文与结构，不值得因此让整本书读取失败。
 * ============================================================ */

import { newBook, warn, sanitizeHtml, plainText } from '../ir.js';

/** 常见图片 MIME → 扩展名。查不到时退回 mime 子类型本身。 */
const IMG_EXT = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
  'image/tiff': 'tiff',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/x-emf': 'emf',
  'image/x-wmf': 'wmf',
};

/** 环境中立的让出主线程：浏览器/Node 都有 setTimeout。 */
function tick() {
  return new Promise((resolve) => {
    if (typeof setTimeout === 'function') setTimeout(resolve, 0);
    else resolve();
  });
}

/* ---------- base64 → bytes，不依赖 atob/Buffer（浏览器与 Node 都要能跑） ---------- */
const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function base64ToBytes(b64) {
  const s = String(b64 || '').replace(/[^A-Za-z0-9+/=]/g, '');
  const len = s.length;
  if (!len) return new Uint8Array(0);
  let outLen = (len / 4) * 3;
  if (s[len - 1] === '=') outLen--;
  if (s[len - 2] === '=') outLen--;
  const bytes = new Uint8Array(Math.max(0, outLen));
  let p = 0;
  for (let i = 0; i < len; i += 4) {
    const e1 = B64_ALPHABET.indexOf(s[i]);
    const e2 = B64_ALPHABET.indexOf(s[i + 1]);
    const e3 = B64_ALPHABET.indexOf(s[i + 2]);
    const e4 = B64_ALPHABET.indexOf(s[i + 3]);
    const c1 = (e1 << 2) | (e2 >> 4);
    const c2 = ((e2 & 15) << 4) | (e3 >> 2);
    const c3 = ((e3 & 3) << 6) | (e4 & 63);
    if (p < outLen) bytes[p++] = c1;
    if (e3 !== -1 && p < outLen) bytes[p++] = c2;
    if (e4 !== -1 && p < outLen) bytes[p++] = c3;
  }
  return bytes;
}

function toArrayBuffer(buf) {
  if (buf instanceof ArrayBuffer) return buf;
  if (ArrayBuffer.isView(buf)) return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  throw new Error('这似乎不是有效的 DOCX 文件');
}

function looksLikeZip(bytes) {
  // ZIP 本地文件头 PK\x03\x04，空压缩包 PK\x05\x06，分卷 PK\x07\x08
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b &&
    (bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07);
}

/* ---------- docProps/core.xml：可选的书籍元数据补充 ---------- */
function xmlText(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
  if (!m) return null;
  const text = m[1]
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, '&')
    .trim();
  return text || null;
}

async function readCoreProps(bytes) {
  const JSZipLib = globalThis.JSZip;
  if (!JSZipLib) return {};
  try {
    const zip = await JSZipLib.loadAsync(bytes);
    const entry = zip.file('docProps/core.xml');
    if (!entry) return {};
    const xml = await entry.async('string');
    return {
      title: xmlText(xml, 'dc:title'),
      author: xmlText(xml, 'dc:creator'),
      description: xmlText(xml, 'dc:description') || xmlText(xml, 'dc:subject'),
      language: xmlText(xml, 'dc:language'),
      date: xmlText(xml, 'dcterms:created'),
      publisher: xmlText(xml, 'dc:publisher'),
    };
  } catch {
    return {}; // 元数据是锦上添花，读不到就算了，不影响正文
  }
}

/** 构造 mammoth 的 convertImage 回调：把图片写进 resources，返回内部路径。 */
function makeImageConverter(book, counter) {
  return async function convertImage(image) {
    const base64 = await image.read('base64');
    const bytes = base64ToBytes(base64);
    const mime = image.contentType || 'application/octet-stream';
    const ext = IMG_EXT[mime] || (mime.split('/')[1] || 'bin').replace(/[^a-z0-9]/gi, '') || 'bin';
    const idx = ++counter.n;
    const rid = `img-${idx}`;
    const href = `images/${rid}.${ext}`;
    book.resources.set(rid, { href, mime, data: bytes });
    return { src: href }; // mammoth 会自动补 alt（来自 element.altText），这里不必重复设置
  };
}

/**
 * 从 mammoth 产出的 HTML 里摘出脚注/尾注列表。
 *
 * mammoth 把脚注/尾注渲染成 <li id="footnote-N">/<li id="endnote-N">，统一
 * 附加在正文末尾的一个 <ol> 里；但文档正文本身的有序列表也会被渲染成 <ol>，
 * 两者无法靠"最后一个 <ol>"这种位置启发式区分——必须按 id 精确摘取。
 *
 * 摘取后 <li> 所在的 <ol> 若被掏空会自动留下 <ol></ol>，一并清理。
 *
 * @returns {{html: string, notes: Array<[string, string]>}}
 */
function extractNotes(html) {
  const notes = [];
  let out = html.replace(/<li id="((?:footnote|endnote)-[^"]+)">([\s\S]*?)<\/li>/g, (m, id, inner) => {
    notes.push([id, inner]);
    return '';
  });
  out = out.replace(/<ol>\s*<\/ol>/g, '');
  return { html: out, notes };
}

/** 去掉 mammoth 自动追加在脚注末尾的"↑"回链——它是给交互式网页用的，静态书里没有意义。 */
function stripBackLink(noteHtml) {
  return noteHtml
    .replace(/<a href="#(?:footnote|endnote)-ref-[^"]+">[^<]*<\/a>/g, '')
    .replace(/[ \t]+<\/p>/g, '</p>');
}

/** 把正文里的脚注引用 <sup><a href="#footnote-1" id="footnote-ref-1">[1]</a></sup>
 *  改写成 IR 的 noteref 约定：<a class="noteref" href="#footnote-1">1</a>。 */
function rewriteNoteRefs(html) {
  return html.replace(/<sup><a\s+([^>]*)>\s*\[(\d+)\]\s*<\/a><\/sup>/g, (m, attrs, num) => {
    const hrefM = attrs.match(/href="#([^"]+)"/);
    if (!hrefM) return m;
    return `<sup><a class="noteref" href="#${hrefM[1]}">${num}</a></sup>`;
  });
}

/**
 * 按 h1/h2/h3 把整篇 HTML 切成章节，并同步建出 nav 树。
 * 标题不重复进 html（与 txt/md reader 的既有约定一致）。
 * @returns {{sawHeading: boolean}}
 */
async function splitChapters(book, html) {
  const HEAD_RE = /<h([1-3])(?:\s[^>]*)?>([\s\S]*?)<\/h\1>/g;
  const matches = [...html.matchAll(HEAD_RE)];
  let ci = 0;
  const navStack = []; // [{level, node}]

  const pushChapter = (title, level, htmlChunk) => {
    const id = `c${++ci}`;
    book.chapters.push({ id, title, level, html: sanitizeHtml(htmlChunk) });
    return id;
  };
  const attachNav = (title, level, target) => {
    const node = { title, target, anchor: null, level, children: [] };
    while (navStack.length && navStack[navStack.length - 1].level >= level) navStack.pop();
    if (navStack.length) navStack[navStack.length - 1].node.children.push(node);
    else book.nav.push(node);
    navStack.push({ level, node });
  };

  if (matches.length === 0) {
    // 整篇没有任何 h1-h3：单章，标题退回书名（与 txt reader「全文无标题→title=文件名」同一约定）
    if (plainText(html).trim()) pushChapter(book.meta.title, 1, html);
    return { sawHeading: false };
  }

  const first = matches[0];
  if (first.index > 0) {
    const pre = html.slice(0, first.index);
    if (plainText(pre).trim()) pushChapter(null, 1, pre); // 首个标题前的正文 → 无标题章
  }

  for (let i = 0; i < matches.length; i++) {
    const mm = matches[i];
    const level = Number(mm[1]);
    const title = plainText(mm[2]).trim() || null;
    const start = mm.index + mm[0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index : html.length;
    const id = pushChapter(title, level, html.slice(start, end));
    if (title) attachNav(title, level, id);
    if ((i & 15) === 15) await tick(); // 大文档让出主线程
  }
  return { sawHeading: true };
}

/**
 * @param {ArrayBuffer|Uint8Array} buf
 * @param {{filename?: string, language?: string}} [opts]
 * @returns {Promise<import('../ir.js').Book>}
 */
export async function read(buf, opts = {}) {
  const mammoth = globalThis.mammoth;
  if (!mammoth || typeof mammoth.convertToHtml !== 'function') {
    throw new Error('DOCX 解析组件尚未就绪，请刷新页面重试');
  }

  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(toArrayBuffer(buf));
  if (!looksLikeZip(bytes)) throw new Error('这似乎不是有效的 DOCX 文件');

  const arrayBuffer = toArrayBuffer(bytes);
  const core = await readCoreProps(bytes);
  const filename = opts.filename ? String(opts.filename).replace(/\.docx$/i, '') : null;

  const book = newBook({
    title: core.title || filename || undefined,
    author: core.author || undefined,
    language: core.language || opts.language || undefined,
    date: core.date || undefined,
    description: core.description || undefined,
    publisher: core.publisher || undefined,
  });

  const counter = { n: 0 };
  let result;
  try {
    result = await mammoth.convertToHtml(
      { arrayBuffer },
      { convertImage: mammoth.images.imgElement(makeImageConverter(book, counter)) },
    );
  } catch {
    throw new Error('这似乎不是有效的 DOCX 文件，可能已损坏');
  }

  for (const msg of result.messages || []) {
    if (msg && msg.type && msg.type !== 'info') {
      warn(book, 'docx.mammoth-message', msg.message || String(msg));
    }
  }

  let html = result.value || '';

  const { html: withoutNotes, notes } = extractNotes(html);
  html = rewriteNoteRefs(withoutNotes);
  for (const [id, inner] of notes) {
    book.notes.set(id, { html: sanitizeHtml(stripBackLink(inner)) });
  }

  const { sawHeading } = await splitChapters(book, html);
  if (!sawHeading) warn(book, 'docx.no-headings', '文档没有可识别的标题层级，已作为单章处理');

  if (book.chapters.length === 0) {
    // 兜底：整篇没有任何正文（极端空文档）
    book.chapters.push({ id: 'c1', title: null, level: 1, html: '' });
  }

  return book;
}
