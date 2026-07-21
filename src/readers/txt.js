/* ============================================================
 * src/readers/txt.js · TXT → Book IR
 *
 * 契约：docs/harness/BOOK-IR.md §4（txt 行）
 *   必须产出 chapters + meta.title；nav/resources/notes 允许省略。
 *   切不出章节标题时整书按单章处理，并记 warning "txt.no-chapters"。
 *
 * 编码嗅探：BOM 优先；否则按 UTF-8 严格解码，失败则在 Big5 / GB18030
 *   间用"乱码字符占比"启发式取更可读者（繁体书大概率 Big5）。
 *
 * 章节切分：整行匹配"第X章/回/卷/篇/部/集"等标题正则即开新章，
 *   该整行文本即为标题（不重复出现在正文 <p> 里）；非空行各自成一个
 *   <p>，空行仅作分隔符不进入输出。首个标题之前的正文归入一个
 *   title:null 的无标题章。
 * ============================================================ */

import { newBook, warn } from '../ir.js';

/* ---------- 章节标题正则 ----------
 * 覆盖简体/繁体常见回目写法："第X章/回/节/節/卷/篇/部/集"，
 * 以及"序章/楔子/引子/尾声/尾聲/后记/後記/番外/终章/終章"等独立标题。
 * X 支持中文数字（含〇零两兩萬万）与阿拉伯数字。
 */
const HEADING_RE = /^\s*(?:第[〇零一二三四五六七八九十百千萬万两兩0-9]+[章回節节卷篇部集]|序章|楔子|引子|尾聲|尾声|後記|后记|番外|终章|終章)(?:\s|$)/;

/* ---------- HTML 转义（正文里可能出现的 & < > 必须转义） ---------- */
function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/* ---------- 主线程让步（大文件分块处理用） ---------- */
function tick() {
  return new Promise((resolve) => {
    if (typeof setTimeout === 'function') setTimeout(resolve, 0);
    else if (typeof queueMicrotask === 'function') queueMicrotask(resolve);
    else resolve();
  });
}

/* ---------- 编码嗅探的"乱码度"启发式 ----------
 * 解码错误的 Big5/GB18030 互猜通常会产生注音符号、制表符/方块字符、
 * 私用区或控制字符——正常中文散文几乎不会出现这些。用占比高低择优。
 */
const BAD_RANGES = [
  [0x00, 0x08], [0x0b, 0x0c], [0x0e, 0x1f], // 控制字符（保留 \t\n\r）
  [0x2500, 0x25ff],  // 制表符 / 方块 / 几何图形
  [0x3100, 0x312f],  // 注音符号
  [0x31a0, 0x31bf],  // 注音符号扩展
  [0xe000, 0xf8ff],  // 私用区
  [0xfffd, 0xfffd],  // 替换字符
];
function isBadCodepoint(cp) {
  for (const [lo, hi] of BAD_RANGES) if (cp >= lo && cp <= hi) return true;
  return false;
}
function badScore(s) {
  let bad = 0, total = 0;
  for (const ch of s) { total++; if (isBadCodepoint(ch.codePointAt(0))) bad++; }
  return total ? bad / total : 1;
}

/**
 * 把字节流解码为文本，返回 {text, encoding, warnings}。
 * warnings 是 [{code, detail}] 数组，供调用方合并进 book.warnings。
 */
function decodeText(bytes) {
  const warnings = [];

  // BOM 优先
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { text: new TextDecoder('utf-8').decode(bytes.subarray(3)), encoding: 'utf-8', warnings };
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { text: new TextDecoder('utf-16le').decode(bytes.subarray(2)), encoding: 'utf-16le', warnings };
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return { text: new TextDecoder('utf-16be').decode(bytes.subarray(2)), encoding: 'utf-16be', warnings };
  }

  // 严格 UTF-8
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return { text, encoding: 'utf-8', warnings };
  } catch { /* 不是合法 UTF-8，继续尝试中文遗留编码 */ }

  // 严格 GB18030 / Big5：字节序列本身不合法时会抛错
  let gbText = null, big5Text = null;
  try { gbText = new TextDecoder('gb18030', { fatal: true }).decode(bytes); } catch { /* 忽略 */ }
  try { big5Text = new TextDecoder('big5', { fatal: true }).decode(bytes); } catch { /* 忽略 */ }

  if (gbText !== null && big5Text === null) return { text: gbText, encoding: 'gb18030', warnings };
  if (big5Text !== null && gbText === null) return { text: big5Text, encoding: 'big5', warnings };
  if (gbText !== null && big5Text !== null) {
    // 两种编码都能无错解码同一段字节——用乱码占比择优
    if (badScore(gbText) <= badScore(big5Text)) {
      return { text: gbText, encoding: 'gb18030', warnings };
    }
    return { text: big5Text, encoding: 'big5', warnings };
  }

  // 三种编码都解不干净：尽力用 GB18030 非严格模式兜底，明确告知用户
  const text = new TextDecoder('gb18030').decode(bytes);
  warnings.push({ code: 'txt.encoding-fallback', detail: '未能确定文本编码，已尽力解码，部分字符可能显示异常' });
  return { text, encoding: 'gb18030', warnings };
}

function stripExt(name) {
  const base = String(name).split(/[\\/]/).pop() || '';
  const idx = base.lastIndexOf('.');
  return idx > 0 ? base.slice(0, idx) : base;
}

/**
 * 把纯文本切成章节数组。非空行各自成一个 <p>；命中标题正则的整行
 * 开一个新章并把整行文本存为该章 title；首个标题前的内容归入
 * title:null 的无标题章。大文件分块处理，定期让出主线程。
 */
async function buildChapters(text) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const chapters = [];
  let cur = null, ci = 0, sawHeading = false;
  const paras = [];

  const flush = () => {
    if (cur && paras.length) cur.html += paras.map((p) => `<p>${escapeHtml(p)}</p>`).join('');
    paras.length = 0;
  };
  const open = (title) => {
    cur = { id: `c${++ci}`, title, level: 1, html: '' };
    chapters.push(cur);
  };

  const CHUNK = 4000;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (HEADING_RE.test(line)) {
      flush();
      sawHeading = true;
      open(line);
    } else if (line) {
      if (!cur) open(null);
      paras.push(line);
    }
    if (i % CHUNK === CHUNK - 1) await tick();
  }
  flush();
  if (chapters.length === 0) open(null);

  return { chapters, sawHeading };
}

/**
 * TXT（ArrayBuffer|Uint8Array）→ Book IR。
 * @param {ArrayBuffer|Uint8Array} buf
 * @param {{filename?: string}} [opts]  filename 可选，用于回退书名
 * @returns {Promise<import('../ir.js').Book>}
 */
export async function read(buf, opts = {}) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (!bytes.length) throw new Error('这个文件是空的，没有内容可以读取。');

  const { text, encoding, warnings: encWarnings } = decodeText(bytes);

  const title = opts && opts.filename ? stripExt(opts.filename) : undefined;
  const book = newBook({
    title,
    language: encoding === 'big5' ? 'zh-Hant' : 'zh-Hans',
  });

  for (const w of encWarnings) warn(book, w.code, w.detail);

  const { chapters, sawHeading } = await buildChapters(text);
  book.chapters = chapters;
  if (!sawHeading) warn(book, 'txt.no-chapters', '未识别到章节标题，已作为单章处理');

  return book;
}
