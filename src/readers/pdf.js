/* ============================================================
 * src/readers/pdf.js · PDF（文本版）→ Book IR
 *
 * 分级：C —— 仅承诺"正确顺序的文字流 + 合并被换行切断的段落 +
 * 按明显空行/大间距（退而按固定页数）断章"。不承诺章节标题、不承诺
 * 目录层级、不承诺图片/脚注。分栏、表格、图注混排出错是格式固有损失。
 *
 * 依赖：pdf.js（UMD）。本模块不自己加载脚本，只消费已经存在的
 * pdfjsLib —— 优先 opts.pdfjsLib 注入，否则用 globalThis.pdfjsLib。
 * 产品集成层负责从 CDN 加载 pdf.min.js / pdf.worker.min.js 并配置
 * GlobalWorkerOptions；Node 测试环境下把两个 vendor 文件都 eval 进
 * globalThis 即可（pdf.worker.min.js 会设置 globalThis.pdfjsWorker，
 * pdf.js 检测到它就直接走"假 worker"主线程路径，不需要配置
 * workerSrc）。
 *
 * 核心流程：
 *   1. getDocument() 打开文档，捕获加密 / 非法 PDF。
 *   2. 逐页 getTextContent()，按 y 坐标聚类成"行"、按 x 坐标排序
 *      拼接行内文字（大间隙补一个空格）。
 *   3. 把全书所有行按页序拼接，用两级间距阈值判断"正常换行"
 *      "空一行的段落间隔""大间距的疑似章节分隔"，加上"下一行是否
 *      缩进"来决定段落边界；换行合并时中文直接相连、西文补空格。
 *   4. 全书没有任何"大间距分隔"信号时，退化为固定页数分块。
 *   5. 全文可提取字符数低于阈值 → 判定为扫描版，人话报错并中止。
 *
 * 已知限制（写入 ResultReport，不在此重复展开）：
 *   - 不抽取图片/资源（BOOK-IR 允许 pdf reader 缺 resources）。
 *   - 不做标题识别，chapter.title 恒为 null（C 档允许）。
 *   - 段落断行只用"首行缩进"作为断段信号，不用行尾标点单独断段——
 *     否则会把多句一段的正常段落拆成逐句一段，比不拆更糟。
 * ============================================================ */

import { newBook, warn } from '../ir.js';

/* ---------- 经验常数（未在大规模真实 PDF 语料上标定，见 limits） ---------- */

const MIN_DOC_CHARS = 20;         // 全书可提取字符数低于此判定为扫描版
const LINE_HEIGHT_FACTOR = 1.3;   // 正常单倍行距 ≈ 1.3 × 字号
const PARA_GAP_FACTOR = 1.8;      // 行距 ≥ 1.8×(单倍行距) 视为空了一行：断段
const CHAPTER_GAP_FACTOR = 3.2;   // 行距 ≥ 3.2×(单倍行距) 视为大间距：断章
const SPACE_GAP_FACTOR = 0.25;    // 同行内两个文字片段水平间隙 > 0.25×字号 补空格
const INDENT_FACTOR = 1.2;        // 行首 x 比本页最左边界多出 1.2×字号 视为缩进
const PAGES_PER_CHAPTER = 20;     // 全书无大间距信号时，兜底按此页数切章
const YIELD_EVERY_PAGES = 5;      // 每处理 N 页让出一次主线程

const CJK_RE = /[㐀-鿿豈-﫿぀-ヿㇰ-ㇿ가-힯]/;

function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** 中文直接相连、西文之间补一个空格；已有空白就不重复加 */
function joinText(a, b) {
  if (!a) return b;
  if (!b) return a;
  const lastChar = a[a.length - 1];
  const firstChar = b[0];
  if (/\s/.test(lastChar) || /\s/.test(firstChar)) return a + b;
  if (CJK_RE.test(lastChar) || CJK_RE.test(firstChar)) return a + b;
  return `${a} ${b}`;
}

/**
 * 把 pdf.js 一页的 getTextContent().items 重排成"行"：
 * 按 y 坐标聚类（容差与字号相关），聚类内按 x 坐标排序后拼接文字。
 * @returns {Array<{text:string, x0:number, y:number, fontSize:number}>}
 */
function buildLines(items) {
  const enriched = [];
  for (const it of items) {
    if (!it.str || !it.str.trim()) continue;
    const fontSize = Math.abs(it.transform[3]) || it.height || 10;
    enriched.push({ str: it.str, x: it.transform[4], y: it.transform[5], width: it.width || 0, fontSize });
  }
  if (!enriched.length) return [];

  // 先按 y 降序（PDF 坐标系 y 向上增长，越大越靠页面顶部），x 升序打底
  enriched.sort((a, b) => (b.y - a.y) || (a.x - b.x));

  const rows = [];
  for (const it of enriched) {
    const last = rows[rows.length - 1];
    const eps = Math.max(2, 0.5 * it.fontSize);
    if (last && Math.abs(last.y - it.y) <= eps) last.items.push(it);
    else rows.push({ y: it.y, items: [it] });
  }

  const lines = [];
  for (const row of rows) {
    row.items.sort((a, b) => a.x - b.x);
    let text = '';
    let prevRight = null;
    let maxFont = 0;
    for (const it of row.items) {
      maxFont = Math.max(maxFont, it.fontSize);
      if (prevRight != null && it.x - prevRight > SPACE_GAP_FACTOR * it.fontSize) {
        text = joinText(text, it.str);
      } else {
        text += it.str;
      }
      prevRight = it.x + it.width;
    }
    text = text.trim();
    if (text) lines.push({ text, x0: row.items[0].x, y: row.y, fontSize: maxFont });
  }
  return lines;
}

/** 是否判定为"这本 PDF 没有可用文字层"（扫描版等） */
function scannedError() {
  const err = new Error('这本 PDF 是扫描图片，里面没有可提取的文字');
  err.code = 'pdf.scanned';
  return err;
}

export async function read(buf, opts = {}) {
  const pdfjsLib = opts.pdfjsLib || globalThis.pdfjsLib;
  if (!pdfjsLib) {
    throw new Error('PDF 解析组件尚未加载，刷新页面后再试一次');
  }

  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);

  let doc;
  try {
    doc = await pdfjsLib.getDocument({
      data: bytes,
      verbosity: pdfjsLib.VerbosityLevel ? pdfjsLib.VerbosityLevel.ERRORS : 0,
    }).promise;
  } catch (e) {
    if (e && e.name === 'PasswordException') {
      const err = new Error('这本书带有版权保护，无法处理');
      err.code = 'pdf.encrypted';
      throw err;
    }
    throw new Error('这似乎不是有效的 PDF 文件');
  }

  try {
    // ---- 元数据（尽力而为，取不到就用默认值） ----
    let title = null;
    let author = null;
    try {
      const md = await doc.getMetadata();
      if (md && md.info) {
        if (md.info.Title) title = String(md.info.Title).trim() || null;
        if (md.info.Author) author = String(md.info.Author).trim() || null;
      }
    } catch { /* 元数据缺失或损坏不影响正文抽取 */ }
    if (!title && opts.filename) {
      const base = String(opts.filename).replace(/\\/g, '/').split('/').pop() || '';
      title = base.replace(/\.[^.]+$/, '') || null;
    }

    const book = newBook({ title, author });

    // ---- 逐页抽取文字，重排成行 ----
    const numPages = doc.numPages;
    const allLines = [];
    for (let p = 1; p <= numPages; p++) {
      try {
        const page = await doc.getPage(p);
        const tc = await page.getTextContent();
        for (const l of buildLines(tc.items)) allLines.push({ ...l, page: p });
      } catch {
        // 单页解析失败不阻断全书，跳过该页（其余页仍尽量抽取）
      }
      if (p % YIELD_EVERY_PAGES === 0) await tick();
    }

    const totalChars = allLines.reduce((s, l) => s + l.text.replace(/\s+/g, '').length, 0);
    if (totalChars < MIN_DOC_CHARS) throw scannedError();

    // ---- 每页左边界（判断首行缩进用） ----
    const leftMargin = new Map();
    for (const l of allLines) {
      const cur = leftMargin.get(l.page);
      if (cur === undefined || l.x0 < cur) leftMargin.set(l.page, l.x0);
    }
    const isIndented = (l) => l.x0 - (leftMargin.get(l.page) ?? l.x0) > INDENT_FACTOR * l.fontSize;

    // ---- 合并成段落，同时标记"这一段前面是否有大间距（疑似章节分隔）" ----
    const paragraphs = [];
    let curText = '';
    let curPage = allLines.length ? allLines[0].page : 1;
    let curChapterBreak = false;
    let usedGapChapterBreak = false;

    const flush = (nextChapterBreak) => {
      if (curText) paragraphs.push({ text: curText, page: curPage, chapterBreak: curChapterBreak });
      curText = '';
      curChapterBreak = nextChapterBreak;
    };

    for (let i = 0; i < allLines.length; i++) {
      const line = allLines[i];
      if (i === 0) { curText = line.text; curPage = line.page; continue; }
      const prev = allLines[i - 1];

      let breakPara = false;
      let breakChapter = false;
      if (prev.page === line.page) {
        const advance = Math.max(prev.fontSize, line.fontSize) * LINE_HEIGHT_FACTOR;
        const gap = prev.y - line.y;
        if (gap >= advance * CHAPTER_GAP_FACTOR) { breakPara = true; breakChapter = true; }
        else if (gap >= advance * PARA_GAP_FACTOR) { breakPara = true; }
        else { breakPara = isIndented(line); }
      } else {
        // 跨页：没有可比的行距，只用缩进判断是否为新段落
        breakPara = isIndented(line);
      }

      if (breakPara) {
        flush(breakChapter);
        curText = line.text;
        curPage = line.page;
        if (breakChapter) usedGapChapterBreak = true;
      } else {
        curText = joinText(curText, line.text);
      }
    }
    flush(false);

    if (!paragraphs.length) throw scannedError();

    // ---- 分章：优先用检测到的大间距；全书没有信号时按固定页数兜底 ----
    let chapterGroups = [];
    if (usedGapChapterBreak) {
      let cur = null;
      for (const para of paragraphs) {
        if (!cur || para.chapterBreak) { cur = []; chapterGroups.push(cur); }
        cur.push(para);
      }
    } else {
      let cur = null;
      let curBucket = null;
      for (const para of paragraphs) {
        const bucket = Math.floor((para.page - 1) / PAGES_PER_CHAPTER);
        if (!cur || bucket !== curBucket) { cur = []; chapterGroups.push(cur); curBucket = bucket; }
        cur.push(para);
      }
      if (chapterGroups.length > 1) {
        warn(book, 'pdf.paged-chapters', '全书没有检测到明显的分段空白，按固定页数切分章节，可能与原书章节不一致');
      }
    }

    book.chapters = chapterGroups.map((paras, idx) => ({
      id: `pdf-ch-${idx + 1}`,
      title: null,
      level: 1,
      html: paras.map((p) => `<p>${escapeHtml(p.text)}</p>`).join(''),
    }));

    book.nav = book.chapters.map((c, idx) => ({
      title: `第 ${chapterGroups[idx][0].page} 页起`,
      target: c.id,
      anchor: null,
      level: 1,
      children: [],
    }));

    warn(book, 'pdf.no-structure', 'PDF 不含章节标题等结构信息，章节按页面空白或固定页数粗略切分，可能与原书目录不一致');
    warn(book, 'pdf.flat-nav', 'PDF 无法提取真实目录层级，导航按页码位置平铺生成，没有层级');

    return book;
  } finally {
    try { await doc.destroy(); } catch { /* 忽略清理失败 */ }
  }
}
