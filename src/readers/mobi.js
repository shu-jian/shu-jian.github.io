/* ============================================================
 * src/readers/mobi.js · MOBI（KF7）→ Book IR
 *
 * 解析链：PalmDB 容器 → record0 的 PalmDOC/MOBI 头 → 文本记录解压
 *   （无压缩 type1、PalmDOC LZ77 type2）→ KF7 HTML 抽取 → 按
 *   <mbp:pagebreak> / 标题切章 → sanitizeHtml 落地为 IR。
 *
 * 明确不做（合法降级，见 docs/harness/BOUNDARIES.md §4）：
 *   - HUFF/CDIC 压缩（compression==17480）：抛人话错误，不解
 *   - 加密（PalmDOC EncryptionType != 0）：抛人话错误，不尝试绕过
 *   - 旧式 <a filepos="N"> 内部跳转：无法在不引入大量复杂度的前提下
 *     精确解析，降级为纯文本（sanitizeHtml 会自动丢弃非白名单的
 *     filepos 属性，只保留可见文字），并记 warning
 *
 * 零依赖：只用标准 DataView / TypedArray / TextDecoder，不引入任何库。
 * 环境中立：不碰 Buffer / Node 专有全局，浏览器与 Node 行为一致。
 * ============================================================ */

import { newBook, warn, sanitizeHtml, plainText, validate } from '../ir.js';

/* ---------- 环境中立的分块让步（大文件不卡主线程） ---------- */

function tick() {
  return new Promise((resolve) => {
    if (typeof setTimeout === 'function') setTimeout(resolve, 0);
    else resolve();
  });
}

/* ---------- 字节级工具 ---------- */

function asciiSlice(bytes, start, len) {
  let s = '';
  for (let i = 0; i < len && start + i < bytes.length; i++) {
    const b = bytes[start + i];
    if (b === 0) break;
    s += String.fromCharCode(b);
  }
  return s;
}

function stripExt(name) {
  return String(name).replace(/\.[^./\\]+$/, '');
}

/* ---------- PalmDOC (LZ77) 解压 ----------
 * 标准 PalmDOC 压缩字节含义（见 test/golden/README.md 与 skills 沉淀）：
 *   0x00       字面 0 字节
 *   0x01-0x08  接下来 N 个原始字节直接拷贝
 *   0x09-0x7f  单字节字面量（原样输出）
 *   0x80-0xbf  两字节的"距离/长度"回溯拷贝
 *   0xc0-0xff  展开为 [空格, 该字节异或 0x80]
 * ------------------------------------------ */
function decompressPalmDoc(bytes) {
  const out = [];
  let i = 0;
  const n = bytes.length;
  while (i < n) {
    const c = bytes[i++];
    if (c === 0) {
      out.push(0);
    } else if (c <= 8) {
      for (let j = 0; j < c && i < n; j++) out.push(bytes[i++]);
    } else if (c <= 0x7f) {
      out.push(c);
    } else if (c <= 0xbf) {
      if (i >= n) break;
      const c2 = bytes[i++];
      const combined = ((c & 0x3f) << 8) | c2;
      const distance = combined >> 3;
      const length = (combined & 0x7) + 3;
      const start = Math.max(0, out.length - distance);
      for (let k = 0; k < length; k++) out.push(out[start + k] ?? 0x20);
    } else {
      out.push(0x20, c ^ 0x80);
    }
  }
  return Uint8Array.from(out);
}

/* ---------- 记录尾部附加数据（extra flags）剥离 ----------
 * 部分 MOBI（header length >= 228 且 extraFlags != 0）会在每条文本记录
 * 末尾追加与正文无关的辅助数据（索引项 / 多字节字符截断标记），解压前
 * 必须先剥掉，否则会被压缩解码器误当成操作码，产出乱码。
 * 算法来自 MOBI 生态里广泛复用的 getSizeOfTrailingDataEntries。
 * 本 reader 自造的黄金样本 extraFlags 恒为 0，此路径未被样本覆盖，
 * 是文档化的已知限制（真实旧书若命中此字段，行为未经验证）。
 * ------------------------------------------------------------ */
function sizeOfBackwardVarint(buf, end) {
  let bitpos = 0;
  let result = 0;
  let pos = end;
  while (pos > 0) {
    pos -= 1;
    const v = buf[pos];
    result |= (v & 0x7f) << bitpos;
    bitpos += 7;
    if ((v & 0x80) !== 0 || bitpos >= 28) break;
  }
  return result;
}

function trailingEntriesSize(buf, size, flags) {
  let num = 0;
  let testFlags = flags >> 1;
  while (testFlags) {
    if (testFlags & 1) num += sizeOfBackwardVarint(buf, size - num);
    testFlags >>= 1;
  }
  if (flags & 1) num += (buf[size - num - 1] & 0x3) + 1;
  return num;
}

function stripTrailingEntries(record, extraFlags) {
  if (!extraFlags) return record;
  const size = record.length;
  const trim = trailingEntriesSize(record, size, extraFlags);
  if (trim <= 0 || trim >= size) return record; // 越界即放弃，保留原样，宁可不剥也不破坏正文
  return record.subarray(0, size - trim);
}

/* ---------- EXTH 元数据 ---------- */

function parseExth(record0, rdv, offset) {
  if (offset + 12 > record0.length || asciiSlice(record0, offset, 4) !== 'EXTH') return [];
  const count = rdv.getUint32(offset + 8);
  const decoder = new TextDecoder('utf-8', { fatal: false });
  const out = [];
  let p = offset + 12;
  for (let i = 0; i < count; i++) {
    if (p + 8 > record0.length) break;
    const type = rdv.getUint32(p);
    const len = rdv.getUint32(p + 4);
    if (len < 8 || p + len > record0.length) break;
    const dataBytes = record0.subarray(p + 8, p + len);
    out.push({ type, text: decoder.decode(dataBytes).trim(), bytes: dataBytes });
    p += len;
  }
  return out;
}

function firstExth(list, type) {
  const r = list.find((x) => x.type === type);
  return r && r.text ? r.text : null;
}
function allExth(list, type) {
  return list.filter((x) => x.type === type).map((x) => x.text).filter(Boolean);
}

function mapExthLanguage(tag) {
  if (!tag) return null;
  const t = tag.toLowerCase();
  if (t.startsWith('zh')) return /tw|hk|hant|mo/.test(t) ? 'zh-Hant' : 'zh-Hans';
  if (t.startsWith('ja')) return 'ja';
  if (t.startsWith('ko')) return 'ko';
  if (t.startsWith('en')) return 'en';
  if (t.startsWith('fr')) return 'fr';
  if (t.startsWith('de')) return 'de';
  if (t.startsWith('es')) return 'es';
  return tag;
}

/** 旧式 Mobipocket locale 字段：低字节≈主语言 id，是 EXTH 524 缺失时的兜底猜测 */
function mapLocaleLanguage(locale) {
  const low = locale & 0xff;
  if (low === 0x04) return 'zh-Hans';
  if (low === 0x09) return 'en';
  if (low === 0x11) return 'ja';
  if (low === 0x12) return 'ko';
  return null;
}

/* ---------- 章节切分辅助 ---------- */

/** 找出片段里第一个标题标签，抽出标题文本并从 html 里摘掉（不重复进正文，约定同 txt/docx） */
function extractTitleHeading(html) {
  const m = html.match(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/i);
  if (!m) return { title: null, level: 1, html };
  const level = Math.min(3, Math.max(1, parseInt(m[1], 10)));
  const titleText = plainText(m[2]).replace(/\s+/g, ' ').trim();
  const newHtml = html.slice(0, m.index) + html.slice(m.index + m[0].length);
  return { title: titleText || null, level, html: newHtml };
}

/** 无 <mbp:pagebreak> 时的退路：按 h1-h3 起始位置切分（标题仍留在片段开头，交给 extractTitleHeading 摘取） */
function splitByHeadings(html) {
  const re = /<h[1-3]\b[^>]*>/gi;
  const idxs = [];
  let m;
  while ((m = re.exec(html))) idxs.push(m.index);
  if (idxs.length === 0) return [html];
  const segs = [];
  if (idxs[0] > 0) segs.push(html.slice(0, idxs[0]));
  for (let i = 0; i < idxs.length; i++) {
    const start = idxs[i];
    const end = i + 1 < idxs.length ? idxs[i + 1] : html.length;
    segs.push(html.slice(start, end));
  }
  return segs;
}

/* ---------- 图片记录 ---------- */

function detectImageMime(b) {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b.length >= 3 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif';
  if (b.length >= 2 && b[0] === 0x42 && b[1] === 0x4d) return 'image/bmp';
  return null;
}

/* ============================================================ */

export async function read(buf, opts = {}) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const BAD_FILE = () => new Error('这似乎不是有效的 MOBI 文件');

  if (bytes.length < 78) throw BAD_FILE();
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const pdbType = asciiSlice(bytes, 60, 4);
  const pdbCreator = asciiSlice(bytes, 64, 4);
  if (pdbType !== 'BOOK' || pdbCreator !== 'MOBI') throw BAD_FILE();

  const pdbName = asciiSlice(bytes, 0, 32).trim();
  const numRecords = dv.getUint16(76);
  if (numRecords < 1 || 78 + numRecords * 8 > bytes.length) throw BAD_FILE();

  const recordOffsets = [];
  for (let i = 0; i < numRecords; i++) recordOffsets.push(dv.getUint32(78 + i * 8));
  for (let i = 0; i < numRecords; i++) {
    if (recordOffsets[i] < 0 || recordOffsets[i] > bytes.length) throw BAD_FILE();
    if (i > 0 && recordOffsets[i] < recordOffsets[i - 1]) throw BAD_FILE();
  }

  const records = [];
  for (let i = 0; i < numRecords; i++) {
    const start = recordOffsets[i];
    const end = i + 1 < numRecords ? recordOffsets[i + 1] : bytes.length;
    records.push(bytes.subarray(start, Math.max(start, end)));
  }

  const record0 = records[0];
  if (record0.length < 16) throw BAD_FILE();
  const rdv = new DataView(record0.buffer, record0.byteOffset, record0.byteLength);

  const compression = rdv.getUint16(0);
  const textLength = rdv.getUint32(4);
  const textRecordCount = rdv.getUint16(8);
  const encryptionType = rdv.getUint16(12);

  // DRM：绝不尝试绕过，检测到即拒绝处理（BOUNDARIES §3）
  if (encryptionType !== 0) throw new Error('这本书带有版权保护，无法处理');

  if (record0.length < 20 || asciiSlice(record0, 16, 4) !== 'MOBI') throw BAD_FILE();
  const headerLength = rdv.getUint32(20);
  const textEncodingCode = rdv.getUint32(28);
  const fullNameOffset = rdv.getUint32(84);
  const fullNameLength = rdv.getUint32(88);
  const locale = rdv.getUint32(92);
  const firstImageIndex = rdv.getUint32(108);
  const exthFlags = rdv.getUint32(128);
  let extraFlags = 0;
  if (headerLength >= 228 && record0.length >= 244) extraFlags = rdv.getUint16(242);

  if (compression === 17480) {
    throw new Error('这本 MOBI 使用了旧式的 HUFF/CDIC 压缩，暂时无法解析');
  }
  if (compression !== 1 && compression !== 2) {
    throw new Error('无法识别的 MOBI 压缩格式，可能文件已损坏');
  }

  const textEncoding = textEncodingCode === 65001 ? 'utf-8' : 'windows-1252';
  const decoder = new TextDecoder(textEncoding, { fatal: false });

  /* ---- EXTH ---- */
  let exthRecords = [];
  if (exthFlags & 0x40) {
    exthRecords = parseExth(record0, rdv, 16 + headerLength);
  }

  let fullName = null;
  if (fullNameLength > 0 && fullNameOffset + fullNameLength <= record0.length) {
    fullName = decoder.decode(record0.subarray(fullNameOffset, fullNameOffset + fullNameLength)).trim();
  }

  const title = firstExth(exthRecords, 503) || fullName || pdbName ||
    (opts.filename ? stripExt(opts.filename) : null) || undefined;
  const author = allExth(exthRecords, 100).join('、') || null;
  const publisher = firstExth(exthRecords, 101);
  const description = firstExth(exthRecords, 103);
  const date = firstExth(exthRecords, 106);
  const isbn = firstExth(exthRecords, 104);
  const langTag = firstExth(exthRecords, 524);
  const language = mapExthLanguage(langTag) || mapLocaleLanguage(locale) || undefined;

  const book = newBook({
    title,
    author,
    language,
    identifier: isbn ? `urn:isbn:${isbn}` : undefined,
    publisher,
    date,
    description,
  });

  /* ---- 文本记录解压 + 拼接 ---- */
  const lastTextRec = Math.min(textRecordCount, records.length - 1);
  const chunks = [];
  let totalLen = 0;
  for (let i = 1; i <= lastTextRec; i++) {
    const trimmed = stripTrailingEntries(records[i], extraFlags);
    const dec = compression === 2 ? decompressPalmDoc(trimmed) : trimmed;
    chunks.push(dec);
    totalLen += dec.length;
    if (i % 40 === 0) await tick();
  }
  const fullBytes = new Uint8Array(totalLen);
  { let off = 0; for (const c of chunks) { fullBytes.set(c, off); off += c.length; } }
  const usable = textLength > 0 && textLength <= fullBytes.length ? fullBytes.subarray(0, textLength) : fullBytes;
  const rawHtml = decoder.decode(usable);

  /* ---- 图片记录解析（recindex 1-based，相对 firstImageIndex） ---- */
  const imgByRecNo = new Map();
  let imgCounter = 0;
  function resolveImageAtRecNo(recNo) {
    if (imgByRecNo.has(recNo)) return imgByRecNo.get(recNo);
    if (!Number.isFinite(recNo) || recNo < 0 || recNo >= records.length) return null;
    const raw = records[recNo];
    const mime = detectImageMime(raw);
    if (!mime) return null;
    imgCounter += 1;
    const ext = mime === 'image/png' ? 'png' : mime === 'image/gif' ? 'gif' : mime === 'image/bmp' ? 'bmp' : 'jpg';
    const id = `img${String(imgCounter).padStart(3, '0')}`;
    book.resources.set(id, { href: `images/${id}.${ext}`, mime, data: raw });
    imgByRecNo.set(recNo, id);
    return id;
  }
  function resolveImageResource(recindex) {
    if (firstImageIndex === undefined || firstImageIndex === 0xffffffff) return null;
    return resolveImageAtRecNo(firstImageIndex + recindex - 1);
  }

  // 封面（EXTH 201，最佳努力：约定为相对 firstImageIndex 的 0-based 偏移）
  const coverExth = exthRecords.find((x) => x.type === 201);
  if (coverExth && coverExth.bytes.length >= 4 && firstImageIndex !== 0xffffffff) {
    const cdv = new DataView(coverExth.bytes.buffer, coverExth.bytes.byteOffset, coverExth.bytes.byteLength);
    const coverOffset = cdv.getUint32(0);
    const coverId = resolveImageAtRecNo(firstImageIndex + coverOffset);
    if (coverId) book.cover = coverId;
  }

  /* ---- 切章：优先 <mbp:pagebreak>，退路按 h1-h3 ---- */
  let segments;
  if (/<mbp:pagebreak\b[^>]*\/?>/i.test(rawHtml)) {
    segments = rawHtml.split(/<mbp:pagebreak\b[^>]*\/?>/gi);
  } else {
    segments = splitByHeadings(rawHtml);
  }

  let hadFilepos = false;
  const chapters = [];
  let ci = 0;
  for (let si = 0; si < segments.length; si++) {
    let seg = segments[si];
    if (!seg) continue;
    if (/\bfilepos\s*=/i.test(seg)) hadFilepos = true;

    // <a name="x"> → id="x"（保留内部锚点，name 不在白名单属性内，需先转 id 才能存活过 sanitizeHtml）
    seg = seg.replace(/<a\b([^>]*)\bname\s*=\s*("([^"]*)"|'([^']*)')([^>]*)>/gi, (_m, pre, _q, dq, sq, post) => {
      const val = dq ?? sq ?? '';
      return `<a${pre} id="${val}"${post}>`;
    });

    // <img recindex="N" ...> → <img src="资源href" alt="...">
    seg = seg.replace(/<img\b[^>]*>/gi, (tag) => {
      const rm = tag.match(/\brecindex\s*=\s*"?0*([0-9]+)"?/i);
      if (!rm) return '';
      const resId = resolveImageResource(parseInt(rm[1], 10));
      if (!resId) return '';
      const altM = tag.match(/\balt\s*=\s*("([^"]*)"|'([^']*)')/i);
      const alt = altM ? (altM[2] ?? altM[3] ?? '') : '';
      const href = book.resources.get(resId).href;
      return `<img src="${href}"${alt ? ` alt="${alt}"` : ''}/>`;
    });

    const extracted = extractTitleHeading(seg);
    const cleanHtml = sanitizeHtml(extracted.html);
    const plain = cleanHtml.replace(/<[^>]*>/g, '').trim();

    if (extracted.title === null && !plain && !/<img\b/i.test(cleanHtml)) continue; // 纯空片段，不算一章

    ci += 1;
    chapters.push({ id: `c${ci}`, title: extracted.title, level: extracted.level, html: cleanHtml || '<p></p>' });
    if (ci % 30 === 0) await tick();
  }

  if (chapters.length === 0) {
    chapters.push({ id: 'c1', title: book.meta.title, level: 1, html: sanitizeHtml(rawHtml) || '<p></p>' });
    warn(book, 'mobi.no-chapters', '未能从正文中切分出章节');
  } else if (chapters.length === 1 && chapters[0].title === null) {
    chapters[0].title = book.meta.title;
    warn(book, 'mobi.no-chapters', '未找到分页符或标题标记，整本书作为单章处理');
  }

  book.chapters = chapters;
  book.nav = chapters
    .filter((c) => c.title != null)
    .map((c) => ({ title: c.title, target: c.id, anchor: null, level: c.level, children: [] }));
  if (chapters.length > 1 && book.nav.length === chapters.filter((c) => c.title != null).length) {
    // 没有从 EXTH/guide 恢复出真正的层级目录，按切章顺序生成平铺目录（合法降级，见 BOOK-IR §4）
    warn(book, 'mobi.flat-nav', '未能从书中恢复原始目录结构，已按章节顺序生成平铺目录');
  }
  if (hadFilepos) {
    warn(book, 'mobi.filepos-unresolved', '书中部分内部链接使用了旧式定位方式，无法精确解析，相关链接已降级为纯文本');
  }

  const check = validate(book);
  if (!check.ok) throw new Error('这本 MOBI 解析后结构异常，可能不是一本完整的书');

  return book;
}
