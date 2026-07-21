/* ============================================================
 * src/writers/kepub.js · Book IR → .kepub.epub（Kobo 专用格式）
 *
 * 实现路径（WorkPacket writer_kepub_01 指定）：
 *   1. 黑盒调用 src/writers/epub.js 的 write() 得到标准 EPUB 字节
 *      （不复制/不重写 epub writer 的内部逻辑）
 *   2. 用 JSZip 解包该 EPUB
 *   3. 通过 META-INF/container.xml → OPF manifest/spine 找出正文
 *      xhtml 内容文档（排除 properties="nav" 的导航文档），逐句注入
 *      <span class="koboSpan" id="kobo.{para}.{seg}">
 *   4. 重打包：mimetype 仍是首条目、STORE 不压缩
 *
 * 环境假设：仅依赖 globalThis.JSZip（由调用方/测试注入），零网络请求。
 *
 * Kobo span 规则（BOOK-IR §5 / WorkPacket contract）：
 *   - 段落计数（para）：每个块级元素（h1-h6/p/div/li/blockquote/pre/
 *     dt/dd/td/th/figcaption）各自起一个新 para，编号在全章（单个
 *     xhtml 文档）范围内单调递增、从 1 起
 *   - 句子计数（seg）：每个 para 内部从 1 起，按中日文断句符
 *     （。！？；）与西文断句符（.!? + 空白/结尾）切分
 *   - 只在纯文本 token 上包 span，绝不跨越已有标签边界——因此不会
 *     拆断 ruby/rt、a、img 等任何标签
 *   - 空白/纯空白文本片段不包 span（避免无意义的空 span）
 * ============================================================ */

import { write as writeEpub } from './epub.js';

/** 让出主线程，避免大书处理时页面假死 */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** 会在其中直接产出句子 span 的块级元素（BOOK-IR §3 白名单的文本承载子集） */
const BLOCK_TAGS = new Set([
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'p', 'div', 'li', 'blockquote', 'pre',
  'dt', 'dd', 'td', 'th', 'figcaption',
]);

/* ---------- 断句 ---------- */

const CJK_ENDERS = '。！？；';
// 断句符之后若紧跟这些收尾标点/引号，一并归入上一句（常见于「……。」「……」这类结尾）
const CLOSERS = '”’」』）)】》〉";\'';

/**
 * 把一段原始文本（未解码实体、逐字符保留）切成句子数组，
 * 数组按顺序拼接严格等于输入（不丢字符、不加字符）。
 */
function splitSentences(text) {
  const result = [];
  let start = 0;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (CJK_ENDERS.includes(ch)) {
      i += 1;
      while (i < n && CLOSERS.includes(text[i])) i += 1;
      result.push(text.slice(start, i));
      start = i;
      continue;
    }
    if (ch === '.' || ch === '!' || ch === '?') {
      const next = text[i + 1];
      if (next === undefined || /\s/.test(next)) {
        i += 1;
        while (i < n && /\s/.test(text[i])) i += 1;
        result.push(text.slice(start, i));
        start = i;
        continue;
      }
    }
    i += 1;
  }
  if (start < n) result.push(text.slice(start));
  return result;
}

/* ---------- 极简 XHTML tokenizer（只为定位标签边界，不解析属性语义） ---------- */

/**
 * 把 XHTML 串切成 token 流，标签原样保留（不重建，避免任何属性/写法被改写）。
 * token: {type:'text',value} | {type:'open',tag,selfClose,raw}
 *       | {type:'close',tag,raw} | {type:'raw',value}（注释/doctype/PI，原样透传）
 */
function tokenizeXhtml(s) {
  const tokens = [];
  let i = 0;
  const n = s.length;
  while (i < n) {
    const lt = s.indexOf('<', i);
    if (lt === -1) { tokens.push({ type: 'text', value: s.slice(i) }); break; }
    if (lt > i) tokens.push({ type: 'text', value: s.slice(i, lt) });

    if (s.startsWith('<!--', lt)) {
      const end = s.indexOf('-->', lt + 4);
      const stop = end === -1 ? n : end + 3;
      tokens.push({ type: 'raw', value: s.slice(lt, stop) });
      i = stop;
      continue;
    }
    if (s[lt + 1] === '!' || s[lt + 1] === '?') {
      const end = s.indexOf('>', lt + 1);
      const stop = end === -1 ? n : end + 1;
      tokens.push({ type: 'raw', value: s.slice(lt, stop) });
      i = stop;
      continue;
    }

    const gt = s.indexOf('>', lt);
    if (gt === -1) { tokens.push({ type: 'text', value: s.slice(lt) }); break; }
    const raw = s.slice(lt, gt + 1);
    i = gt + 1;

    const inner = raw.slice(1, -1).trim();
    if (!inner) { tokens.push({ type: 'text', value: raw }); continue; }

    if (inner[0] === '/') {
      const tag = inner.slice(1).trim().split(/[\s/]/)[0].toLowerCase();
      tokens.push({ type: 'close', tag, raw });
      continue;
    }

    let body = inner;
    let selfClose = false;
    if (body.endsWith('/')) { selfClose = true; body = body.slice(0, -1).trim(); }
    const m = body.match(/^([a-zA-Z][a-zA-Z0-9:_-]*)/);
    if (!m) { tokens.push({ type: 'text', value: raw }); continue; }
    tokens.push({ type: 'open', tag: m[1].toLowerCase(), selfClose, raw });
  }
  return tokens;
}

/**
 * 对一段 body 内部 HTML 注入 koboSpan。
 * 保证：
 *  - 不修改任何标签（只原样透传 open/close/raw token）
 *  - 只在文本 token 内部插入 <span>，不跨 token 边界
 *  - 剥掉所有注入的 span 后，文本内容与输入逐字符一致
 */
function injectSpansIntoBody(bodyInner) {
  const tokens = tokenizeXhtml(bodyInner);
  let globalPara = 0;
  const stack = []; // 当前打开的块级元素对应的 frame 栈
  let rootFrame = null; // 不在任何块级元素内的顶层文本使用的 frame（惰性分配）
  const out = [];

  const currentFrame = () => (stack.length ? stack[stack.length - 1] : rootFrame);

  for (const t of tokens) {
    if (t.type === 'raw') { out.push(t.value); continue; }

    if (t.type === 'open') {
      out.push(t.raw);
      if (BLOCK_TAGS.has(t.tag) && !t.selfClose) {
        globalPara += 1;
        stack.push({ tag: t.tag, paraId: globalPara, seg: 0 });
      }
      rootFrame = null; // 离开顶层文本上下文；下次顶层文本重新分配 para
      continue;
    }

    if (t.type === 'close') {
      if (BLOCK_TAGS.has(t.tag) && stack.length && stack[stack.length - 1].tag === t.tag) {
        stack.pop();
      }
      out.push(t.raw);
      rootFrame = null;
      continue;
    }

    // text
    const text = t.value;
    if (!text || !text.trim()) { out.push(text); continue; }

    let frame = currentFrame();
    if (!frame) {
      globalPara += 1;
      rootFrame = { tag: null, paraId: globalPara, seg: 0 };
      frame = rootFrame;
    }

    const pieces = splitSentences(text);
    for (const piece of pieces) {
      if (!piece.trim()) { out.push(piece); continue; }
      frame.seg += 1;
      out.push(`<span class="koboSpan" id="kobo.${frame.paraId}.${frame.seg}">${piece}</span>`);
    }
  }

  return out.join('');
}

/** 只处理 <body>...</body> 内部，<head> 原样保留 */
function injectSpansIntoDocument(xhtml) {
  const bodyOpenMatch = xhtml.match(/<body\b[^>]*>/i);
  if (!bodyOpenMatch) return xhtml; // 找不到 body，原样返回（不应发生，但保守处理）
  const bodyOpenEnd = bodyOpenMatch.index + bodyOpenMatch[0].length;
  const bodyCloseIdx = xhtml.lastIndexOf('</body>');
  if (bodyCloseIdx === -1 || bodyCloseIdx < bodyOpenEnd) return xhtml;

  const prefix = xhtml.slice(0, bodyOpenEnd);
  const inner = xhtml.slice(bodyOpenEnd, bodyCloseIdx);
  const suffix = xhtml.slice(bodyCloseIdx);

  return prefix + injectSpansIntoBody(inner) + suffix;
}

/* ---------- OPF / spine 解析（通用 EPUB 结构解析，不依赖 epub writer 内部实现） ---------- */

function parseAttr(attrs, name) {
  const m = attrs.match(new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`));
  return m ? m[1] : '';
}

function resolveHref(baseDir, href) {
  const decodedParts = href.split('/').map((p) => {
    try { return decodeURIComponent(p); } catch { return p; }
  });
  const baseParts = baseDir ? baseDir.split('/').filter(Boolean) : [];
  const stack = [...baseParts];
  for (const part of decodedParts) {
    if (!part || part === '.') continue;
    if (part === '..') { stack.pop(); continue; }
    stack.push(part);
  }
  return stack.join('/');
}

/**
 * 从已解包的 zip 里找出正文内容文档（spine 顺序，排除 nav 文档）。
 * @returns {Promise<string[]>} zip 内部路径数组
 */
async function findChapterEntries(zip) {
  const containerXml = await zip.file('META-INF/container.xml').async('string');
  const fullPathMatch = containerXml.match(/full-path\s*=\s*"([^"]*)"/);
  const opfPath = fullPathMatch ? fullPathMatch[1] : 'content.opf';
  const opfDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/')) : '';

  const opfEntry = zip.file(opfPath);
  if (!opfEntry) throw new Error(`kepub: 找不到 OPF 文件 ${opfPath}`);
  const opfXml = await opfEntry.async('string');

  const manifestById = new Map();
  const itemRe = /<item\b([^>]*?)\/?>/g;
  let im;
  while ((im = itemRe.exec(opfXml))) {
    const attrs = im[1];
    const id = parseAttr(attrs, 'id');
    if (!id) continue;
    manifestById.set(id, {
      href: parseAttr(attrs, 'href'),
      mediaType: parseAttr(attrs, 'media-type'),
      properties: parseAttr(attrs, 'properties'),
    });
  }

  const spineMatch = opfXml.match(/<spine\b[^>]*>([\s\S]*?)<\/spine>/);
  const spineBody = spineMatch ? spineMatch[1] : '';
  const idrefRe = /<itemref\b([^>]*?)\/?>/g;
  const idrefs = [];
  let sm;
  while ((sm = idrefRe.exec(spineBody))) {
    const idref = parseAttr(sm[1], 'idref');
    if (idref) idrefs.push(idref);
  }

  const entries = [];
  for (const idref of idrefs) {
    const item = manifestById.get(idref);
    if (!item) continue;
    if (!/html/i.test(item.mediaType)) continue;
    if (/\bnav\b/.test(item.properties || '')) continue; // 跳过 EPUB3 导航文档
    entries.push(resolveHref(opfDir, item.href));
  }
  return entries;
}

/* ---------- 主入口 ---------- */

/**
 * @param {import('../ir.js').Book} book
 * @param {object} [opts]
 * @param {(p:number)=>void} [onProgress]
 * @returns {Promise<Uint8Array>}
 */
export async function write(book, opts, onProgress) {
  const report = typeof onProgress === 'function' ? onProgress : () => {};
  const JSZip = globalThis.JSZip;
  if (!JSZip) throw new Error('kepub writer 需要 globalThis.JSZip');

  // 阶段 1：借道标准 EPUB writer 生成基底字节（不复制其内部逻辑）
  const epubBytes = await writeEpub(book, opts, (p) => report(p * 0.45));
  report(0.45);

  const zip = await JSZip.loadAsync(epubBytes);
  const chapterPaths = await findChapterEntries(zip);
  report(0.5);

  // 阶段 2：定位正文内容文档，逐句注入 koboSpan
  const chapterSet = new Set(chapterPaths);
  const outZip = new JSZip();
  outZip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });

  const names = Object.keys(zip.files).filter((n) => n !== 'mimetype' && !zip.files[n].dir);
  const total = names.length || 1;
  let done = 0;

  for (const name of names) {
    if (chapterSet.has(name)) {
      const xhtml = await zip.file(name).async('string');
      const injected = injectSpansIntoDocument(xhtml);
      outZip.file(name, injected, { compression: 'DEFLATE' });
    } else {
      const bytes = await zip.file(name).async('uint8array');
      outZip.file(name, bytes, { compression: 'DEFLATE' });
    }
    done += 1;
    report(0.5 + 0.4 * (done / total));
    if (done % 5 === 0) await tick();
  }

  // 阶段 3：重打包，mimetype 必须是第一个条目且不压缩
  const bytes = await outZip.generateAsync({ type: 'uint8array', mimeType: 'application/epub+zip' });
  report(1);
  return bytes;
}
