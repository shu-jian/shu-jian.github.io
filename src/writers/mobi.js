/* ============================================================
 * src/writers/mobi.js · Book IR → MOBI (KF7)
 *
 * 容器：PalmDB (.pdb) + PalmDOC 头 + MOBI 头 + EXTH。
 * 文本记录用 compression=1（无压缩）——合法格式值，省去 LZ77 压缩器实现；
 *   工作量记录见 ResultReport，KF7 老格式受众收缩中，此为 C 档合理取舍。
 *
 * KF7 没有多文件概念：所有章节被拼成单一 HTML 流，
 *   每章前插入 <mbp:pagebreak/> 作分页/分章提示，并在章首放置
 *   <a id="<ChapterId>">，使 IR 里已经改写好的 "#<ChapterId>" /
 *   "#<anchor>" 交叉引用无需再变形即可在合流后的单文档里继续生效。
 *
 * 按 docs/harness/BOOK-IR.md §5（mobi 行）声明的丢弃：
 *   - notes：不再是独立的 IR 结构，降级为书末"注释"区块，
 *     原 <a class="noteref" href="#<NoteId>"> 直接跳到该区块对应 id。
 *   - ruby 注音：KF7 渲染不可靠，剥离 <rt>/<rp>，只保留 <ruby> 的基础文本。
 *   这两项都需要提示用户（表格第三列 = 是），提示文案由 Orchestrator/ux-writer 决定，
 *   本文件只在 ResultReport 里回报建议措辞。
 *
 * 目录：nav 不写进正文流。
 *   round 1 曾把 nav 压平成书末一页可见 TOC（<ul><li><a href="#...">），但本项目的
 *   mobi reader 直接把整段解压文本当纯内容流按 <mbp:pagebreak>/标题切章解析，
 *   那页 TOC 会被原样读回成一个多余的"目录"章节，正文末尾凭空多出一段目录文字，
 *   破坏 read→write→read 的显示层字节一致（0 容差硬门）。
 *   而 mobi reader 本就会在回读时按各章标题重建平铺 nav（见 readers/mobi.js），
 *   nav 无需靠正文里的 TOC 页承载——写进去只会污染正文、无任何可回收信息。
 *   KF7 惯例的 <head><guide><reference filepos="..."/></guide></head> 同样不可用：
 *   reader 不识别 <html>/<head>/<body> 包裹，塞进去会被判"结构异常"。
 *   故本 writer 不产出任何 TOC 页，也不接设备原生"跳至目录"菜单（KF7 受众收缩中，
 *   此为 C 档合理取舍）；注释页仍作为书末普通分页内容块保留（见 renderNotes）。
 *
 * 图片：进图片记录区（跟在文本记录后面），正文里的 <img src="..."> 改写成
 *   <img recindex="00001">（1-based，相对于图片记录区起点的序号，
 *   不是 PalmDB 绝对记录号）；封面固定排在图片区第一位，
 *   EXTH 201/202（Cover/Thumb Offset）取值固定为 0。
 *
 * 零依赖：只用 TypedArray / DataView / TextEncoder（环境中立的标准 JS）。
 * ============================================================ */

import { plainText } from '../ir.js';

const PALM_EPOCH_OFFSET = 2082844800; // 1904-01-01 00:00:00 UTC → 1970 epoch 的秒数差
const RECORD_SIZE = 4096;
const PDB_HEADER_LEN = 78;
const PALMDOC_HEADER_LEN = 16;
const MOBI_HEADER_LEN = 232; // 0xE8。数值取自 test/golden/mobi/ 两份黄金样本的实测头部布局

async function tick() {
  await new Promise((r) => setTimeout(r, 0));
}

/* ---------- 字节写入器：只做定长/大端数值与原始字节的拼接 ---------- */

class ByteWriter {
  constructor() {
    this.chunks = [];
    this.length = 0;
  }
  bytes(arr) {
    this.chunks.push(arr);
    this.length += arr.length;
    return this;
  }
  u8(v) {
    return this.bytes(Uint8Array.of(v & 0xff));
  }
  u16(v) {
    const b = new Uint8Array(2);
    new DataView(b.buffer).setUint16(0, v >>> 0, false);
    return this.bytes(b);
  }
  u32(v) {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, v >>> 0, false);
    return this.bytes(b);
  }
  /** 固定宽度、UTF-8 编码、截断或零填充到 len 字节 */
  str(s, len) {
    const enc = new TextEncoder().encode(String(s));
    const out = new Uint8Array(len);
    out.set(enc.subarray(0, len));
    return this.bytes(out);
  }
  /** 原样写入一个 ASCII 字面量（如 "MOBI" "BOOK"），不做长度约束 */
  raw(s) {
    return this.bytes(new TextEncoder().encode(s));
  }
  toBytes() {
    const out = new Uint8Array(this.length);
    let o = 0;
    for (const c of this.chunks) {
      out.set(c, o);
      o += c.length;
    }
    return out;
  }
}

/* ---------- 小工具 ---------- */

function escText(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escAttr(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

/** 极简、非加密强度的字符串哈希，只用来给 MOBI 头的 "unique id" 数值字段填一个稳定值 */
function hash32(s) {
  let h = 0x811c9dc5;
  const str = String(s ?? '');
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** BCP47 语言标签 → MOBI/LCID 风格语言码。只认常见标签，未知一律 0（neutral） */
function langCode(bcp47) {
  const s = String(bcp47 || '').toLowerCase();
  if (s.startsWith('zh-hans') || s === 'zh-cn') return 0x0804;
  if (s.startsWith('zh-hant') || s === 'zh-tw') return 0x0404;
  if (s.startsWith('zh')) return 0x0004;
  if (s.startsWith('ja')) return 0x0411;
  if (s.startsWith('ko')) return 0x0412;
  if (s.startsWith('en')) return 0x0409;
  if (s.startsWith('fr')) return 0x040c;
  if (s.startsWith('de')) return 0x0407;
  if (s.startsWith('es')) return 0x040a;
  return 0;
}

/** 剥离 <rt>/<rp>（注音），只保留 <ruby> 里的基础文本；BOOK-IR §5 声明的丢弃项 */
function stripRuby(html) {
  return String(html || '')
    .replace(/<rp\b[^>]*>[\s\S]*?<\/rp>/gi, '')
    .replace(/<rt\b[^>]*>[\s\S]*?<\/rt>/gi, '')
    .replace(/<\/?ruby\b[^>]*>/gi, '');
}

/** 把 <img src="..."> 改写成 <img recindex="NNNNN">（1-based，找不到就整个丢弃该图） */
function rewriteImages(html, hrefToRecindex, missing) {
  return String(html || '').replace(/<img\b([^>]*?)\/?>/gi, (m, attrs) => {
    const srcM = attrs.match(/\bsrc\s*=\s*"([^"]*)"/i) || attrs.match(/\bsrc\s*=\s*'([^']*)'/i);
    const src = srcM ? srcM[1] : '';
    const altM = attrs.match(/\balt\s*=\s*"([^"]*)"/i) || attrs.match(/\balt\s*=\s*'([^']*)'/i);
    const alt = altM ? altM[1] : '';
    const idx = hrefToRecindex.get(src);
    if (idx == null) {
      missing.push(src);
      return '';
    }
    const rec = String(idx).padStart(5, '0');
    return `<img recindex="${rec}"${alt ? ` alt="${escAttr(alt)}"` : ''} />`;
  });
}

/**
 * notes 在 KF7 里降级为书末可见正文（见 renderNotes），noteref 锚点本身
 * 变成了一个普通的内部跳转链接，不再是"指向 IR notes 结构"的语义标记。
 * 剥掉 class 里的 noteref 记号，避免回读产物里出现"有 noteref 类但
 * book.notes 是空 Map"的悬空引用（mobi reader 允许不产出 notes，见
 * BOOK-IR §4），否则会在往返校验时被判定为结构损坏。
 */
function stripNoterefClass(html) {
  return String(html || '').replace(/(<a\b[^>]*)\bclass\s*=\s*"([^"]*)"/gi, (m, pre, cls) => {
    const rest = cls.split(/\s+/).filter((c) => c && c !== 'noteref').join(' ');
    return rest ? `${pre}class="${rest}"` : pre;
  });
}

/** 拼接所有章节为单一 KF7 正文流：章首锚点 + 补标题 + 分页提示 */
function renderChapters(chapters, hrefToRecindex, missing) {
  const parts = [];
  chapters.forEach((ch) => {
    parts.push('<mbp:pagebreak/>');
    parts.push(`<a name="${escAttr(ch.id)}" id="${escAttr(ch.id)}"></a>`);
    let html = stripRuby(ch.html);
    html = stripNoterefClass(html);
    html = rewriteImages(html, hrefToRecindex, missing);
    if (ch.title) {
      const headMatch = html.match(/^\s*<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/i);
      const already = headMatch && plainText(headMatch[2]).trim() === String(ch.title).trim();
      if (!already) {
        const lvl = ch.level >= 1 && ch.level <= 6 ? ch.level : 1;
        html = `<h${lvl}>${escText(ch.title)}</h${lvl}>` + html;
      }
    }
    parts.push(html);
  });
  return parts.join('\n');
}

/** notes 降级为书末"注释"区块，id 直接用 NoteId，使原 noteref 锚点无需改写即可跳达 */
function renderNotes(notes) {
  if (!(notes instanceof Map) || notes.size === 0) return '';
  const parts = ['<mbp:pagebreak/>', '<h2>注释</h2>'];
  for (const [id, note] of notes) {
    parts.push(`<div name="${escAttr(id)}" id="${escAttr(id)}">${note.html || ''}</div>`);
  }
  return parts.join('\n');
}

/* nav 不序列化进正文流：reader 会把书末 TOC 页读回成多余章节，破坏往返显示层一致；
 * 且 reader 本就按章标题重建平铺 nav，TOC 页无可回收信息。理由详见文件头注释。 */

/* ---------- EXTH ---------- */

function exthStr(id, str) {
  return { id, data: new TextEncoder().encode(String(str)) };
}
function exthU32(id, val) {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, val >>> 0, false);
  return { id, data: b };
}

function buildExth(records) {
  const sorted = [...records].sort((a, b) => a.id - b.id);
  let bodyLen = 12; // "EXTH" + length(4) + count(4)
  for (const r of sorted) bodyLen += 8 + r.data.length;
  const padded = Math.ceil(bodyLen / 4) * 4;

  const w = new ByteWriter();
  w.raw('EXTH');
  w.u32(padded);
  w.u32(sorted.length);
  for (const r of sorted) {
    w.u32(r.id);
    w.u32(8 + r.data.length);
    w.bytes(r.data);
  }
  const pad = padded - bodyLen;
  if (pad > 0) w.bytes(new Uint8Array(pad));
  return w.toBytes();
}

/* ---------- 主流程 ---------- */

export async function write(book, opts = {}, onProgress = () => {}) {
  const notify = (p) => {
    try {
      onProgress(Math.max(0, Math.min(1, p)));
    } catch {
      /* onProgress 抛错不应打断转换 */
    }
  };
  notify(0);

  const resources = book.resources instanceof Map ? book.resources : new Map();

  // ---- 1. href → ResourceId → recindex（封面固定第一位）----
  const hrefToRid = new Map();
  for (const [rid, res] of resources) {
    if (res && typeof res.href === 'string') hrefToRid.set(res.href, rid);
  }

  const usedRids = [];
  const seenRid = new Set();
  const pushRid = (rid) => {
    if (rid && !seenRid.has(rid) && resources.has(rid)) {
      seenRid.add(rid);
      usedRids.push(rid);
    }
  };
  if (book.cover) pushRid(book.cover);
  for (const ch of book.chapters) {
    const html = String(ch.html || '');
    for (const m of html.matchAll(/<img\b[^>]*\bsrc\s*=\s*"([^"]*)"/gi)) pushRid(hrefToRid.get(m[1]));
    for (const m of html.matchAll(/<img\b[^>]*\bsrc\s*=\s*'([^']*)'/gi)) pushRid(hrefToRid.get(m[1]));
  }

  const ridToRecindex = new Map();
  usedRids.forEach((rid, i) => ridToRecindex.set(rid, i + 1));
  const hrefToRecindex = new Map();
  for (const rid of usedRids) {
    const res = resources.get(rid);
    if (res) hrefToRecindex.set(res.href, ridToRecindex.get(rid));
  }

  notify(0.1);
  await tick();

  // ---- 2. 拼正文 / 注释 / 目录 ----
  const missingImgs = [];
  const bodyChapters = renderChapters(book.chapters, hrefToRecindex, missingImgs);
  await tick();
  notify(0.25);

  const notesHtml = renderNotes(book.notes);
  notify(0.35);

  // ---- 3. 组装整篇正文：不加 <html>/<head>/<body> 包裹（原因见文件头注释），
  //         就是一段以 <mbp:pagebreak/> 分隔章节的纯内容流。
  //         不写 nav/TOC 页（会被 reader 读回成多余章节，破坏往返；理由见文件头注释）----
  const title = book.meta?.title || '未命名';
  const fullHtml = [bodyChapters, notesHtml].filter(Boolean).join('\n');

  notify(0.4);
  await tick();

  // ---- 4. 文本记录（compression = 1，无压缩，按 4096 字节切块）----
  const textBytes = new TextEncoder().encode(fullHtml);
  const textRecords = [];
  for (let off = 0; off < textBytes.length; off += RECORD_SIZE) {
    textRecords.push(textBytes.subarray(off, off + RECORD_SIZE));
    if (textRecords.length % 64 === 0) await tick();
  }
  if (textRecords.length === 0) textRecords.push(new Uint8Array(0));
  notify(0.6);

  // ---- 5. 图片记录 ----
  const imageRecords = [];
  for (const rid of usedRids) {
    const res = resources.get(rid);
    imageRecords.push(res && res.data instanceof Uint8Array ? res.data : new Uint8Array(0));
    await tick();
  }
  notify(0.75);

  const numTextRecords = textRecords.length;
  const firstImageIndex = imageRecords.length > 0 ? numTextRecords + 1 : 0xffffffff;
  const allRecords = [null /* record0 占位，稍后填 */, ...textRecords, ...imageRecords];
  const numRecordsTotal = allRecords.length;

  // ---- 6. EXTH ----
  const exthList = [];
  if (book.meta?.author) exthList.push(exthStr(100, book.meta.author));
  if (book.meta?.publisher) exthList.push(exthStr(101, book.meta.publisher));
  if (book.meta?.description) exthList.push(exthStr(103, book.meta.description));
  if (book.meta?.date) exthList.push(exthStr(106, book.meta.date));
  exthList.push(exthStr(503, title)); // Updated Title
  exthList.push(exthStr(524, book.meta?.language || 'zh')); // Language
  if (book.cover && ridToRecindex.has(book.cover)) {
    const coverOffset = ridToRecindex.get(book.cover) - 1; // 固定 0（封面永远排第一）
    exthList.push(exthU32(201, coverOffset));
    exthList.push(exthU32(202, coverOffset));
  }
  const exthBytes = buildExth(exthList);

  // ---- 7. record0 = PalmDOC 头 + MOBI 头 + EXTH + full name ----
  const fullNameBytes = new TextEncoder().encode(title);
  const fullNameOffset = PALMDOC_HEADER_LEN + MOBI_HEADER_LEN + exthBytes.length;
  const fullNamePadded = Math.ceil(fullNameBytes.length / 4) * 4;

  const r0 = new ByteWriter();
  // PalmDOC 头（16 字节）
  r0.u16(1); // compression = none
  r0.u16(0); // unused
  r0.u32(textBytes.length); // 未压缩全文字节数
  r0.u16(numTextRecords);
  r0.u16(RECORD_SIZE);
  r0.u16(0); // encryption = none
  r0.u16(0); // unused

  // MOBI 头（232 字节，见 MOBI_HEADER_LEN 处注释：数值来自黄金样本实测）
  r0.raw('MOBI');
  r0.u32(MOBI_HEADER_LEN);
  r0.u32(2); // mobi type = book
  r0.u32(65001); // utf-8
  r0.u32(hash32(book.meta?.identifier || title));
  r0.u32(6); // file version
  for (let i = 0; i < 10; i++) r0.u32(0); // 10 个保留索引字段（本书不用索引，黄金样本里全 0）
  r0.u32(0); // first non-book index（黄金样本里为 0）
  r0.u32(fullNameOffset);
  r0.u32(fullNameBytes.length);
  r0.u32(langCode(book.meta?.language));
  r0.u32(0); // input language
  r0.u32(0); // output language
  r0.u32(0); // min version（黄金样本里为 0）
  r0.u32(firstImageIndex);
  r0.u32(0); // huffman record offset
  r0.u32(0); // huffman record count
  r0.u32(0); // huffman table offset
  r0.u32(0); // huffman table length
  r0.u32(0x40); // EXTH flags：bit6 = 有 EXTH
  // 0x74–0xE8：DRM / FDST / FCIS / FLIS / extra-data-flags 等字段本书全部不用，
  // 黄金样本里这一整段就是连续 0，直接补齐到 header 长度即可
  r0.bytes(new Uint8Array(MOBI_HEADER_LEN - 0x74));

  r0.bytes(exthBytes);
  r0.bytes(fullNameBytes);
  const namePad = fullNamePadded - fullNameBytes.length;
  if (namePad > 0) r0.bytes(new Uint8Array(namePad));

  allRecords[0] = r0.toBytes();
  notify(0.85);
  await tick();

  // ---- 8. PalmDB 容器：文件头 + 记录目录 + 记录数据 ----
  const recordListLen = 8 * numRecordsTotal;
  let cursor = PDB_HEADER_LEN + recordListLen + 2; // +2：记录目录后固定的 2 字节间隙
  const offsets = [];
  for (const r of allRecords) {
    offsets.push(cursor);
    cursor += r.length;
  }

  const now = Math.floor(Date.now() / 1000) + PALM_EPOCH_OFFSET;
  const asciiName = (title.replace(/[^\x20-\x7e]/g, '_').trim() || 'book').slice(0, 31);

  const pdb = new ByteWriter();
  pdb.str(asciiName, 32);
  pdb.u16(0); // attributes
  pdb.u16(0); // version
  pdb.u32(now); // creation date
  pdb.u32(now); // modification date
  pdb.u32(0); // last backup date
  pdb.u32(0); // modification number
  pdb.u32(0); // appInfoID
  pdb.u32(0); // sortInfoID
  pdb.raw('BOOK');
  pdb.raw('MOBI');
  pdb.u32(numRecordsTotal); // uniqueIDseed
  pdb.u32(0); // nextRecordListID
  pdb.u16(numRecordsTotal);

  for (let i = 0; i < numRecordsTotal; i++) {
    pdb.u32(offsets[i]);
    pdb.u8(0); // record attributes
    pdb.u8((i >> 16) & 0xff);
    pdb.u16(i & 0xffff); // 3 字节 uniqueID（高字节+u16）
    if (i % 200 === 0) await tick();
  }
  pdb.bytes(new Uint8Array(2)); // 记录目录后的固定间隙

  for (const r of allRecords) pdb.bytes(r);

  notify(1);
  return pdb.toBytes();
}
