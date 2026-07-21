/* ============================================================
 * AZW3 (KF8) reader · AZW3 文件 -> Book IR
 *
 * 范围（B 档，尽力做到，失败则降级，见 docs/harness/BOUNDARIES.md §4）：
 *   - 纯 KF8 文件（version >= 8）：PalmDB 容器 -> MOBI/EXTH 头 -> FDST 定位主文本流
 *     -> skeleton/fragment INDX 重组各 part 的 XHTML -> 按 part 切章
 *   - 图片：资源记录进 resources；kindle:embed:XXXX / recindex=N 引用改写为 IR img src
 *   - 目录：优先解析 NCX INDX 建 nav 树；解析不到则按 part 顺序平铺 + warning
 *   - combo 文件（KF7+KF8 双格式）：通过 EXTH 121 (KF8 Boundary Offset) 定位并只取 KF8 部分
 *   - 不支持：DRM（人话报错拒绝）、HUFF/CDIC 压缩（人话报错，KF8 极少用到）
 *
 * 零依赖，只用 DataView / TypedArray / TextDecoder（环境中立标准 API，Node 与浏览器均可用）。
 *
 * 字段偏移来源：PalmDB/MOBI 头部字段偏移经交叉验证（社区文档 + 主流开源解包工具的头部字段表，
 *   均为公开的格式知识，非受版权保护的代码表达）；本文件是独立实现，未复制任何第三方源码。
 * ============================================================ */

import { newBook, warn, sanitizeHtml, plainText, validate } from '../ir.js';

/* ---------- 顶层入口 ---------- */

class FriendlyError extends Error {}
function fail(msg) { throw new FriendlyError(msg); }

export async function read(buf, opts = {}) {
  try {
    return await readImpl(buf, opts || {});
  } catch (e) {
    if (e instanceof FriendlyError) throw e;
    throw new Error('这个 AZW3 文件的内部结构无法解析，可能已损坏，或使用了本工具暂不支持的排版方式。');
  }
}

function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/* ---------- 字节 / 编码工具 ---------- */

function asciiStr(bytes, offset = 0, len = bytes.length - offset) {
  let s = '';
  for (let i = 0; i < len; i++) s += String.fromCharCode(bytes[offset + i]);
  return s;
}

function concatBytes(...arrs) {
  let total = 0;
  for (const a of arrs) total += a.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}

const decoderCache = new Map();
function decodeText(bytes, textEncoding) {
  const label = textEncoding === 65001 ? 'utf-8' : 'windows-1252';
  let dec = decoderCache.get(label);
  if (!dec) {
    try { dec = new TextDecoder(label); } catch { dec = new TextDecoder('utf-8'); }
    decoderCache.set(label, dec);
  }
  try { return dec.decode(bytes); } catch { return asciiStr(bytes); }
}

function extFor(mime) {
  return { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/bmp': 'bmp' }[mime] || 'bin';
}

function detectImageMime(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'image/gif';
  if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) return 'image/bmp';
  return null;
}

/* ---------- PalmDOC LZ77 解压（compression type 2） ---------- */

function palmDocDecompress(bytes) {
  const out = [];
  let p = 0;
  const n = bytes.length;
  while (p < n) {
    const c = bytes[p++];
    if (c >= 1 && c <= 8) {
      for (let k = 0; k < c && p < n; k++) out.push(bytes[p++]);
    } else if (c < 128) {
      out.push(c);
    } else if (c >= 192) {
      out.push(32, c ^ 128);
    } else if (p < n) {
      const c2 = bytes[p++];
      const combined = (c << 8) | c2;
      const m = (combined >> 3) & 0x07ff;
      const len = (combined & 7) + 3;
      for (let k = 0; k < len; k++) {
        const idx = out.length - m;
        out.push(idx >= 0 ? out[idx] : 0);
      }
    }
  }
  return Uint8Array.from(out);
}

/* ---------- 每条文本记录末尾的附加数据（多字节续接 / TBS 等），解压前需剥离 ---------- */

function getTrailingEntrySize(data) {
  let num = 0;
  const start = Math.max(0, data.length - 4);
  for (let i = start; i < data.length; i++) {
    const v = data[i];
    if (v & 0x80) num = 0;
    num = num * 128 + (v & 0x7f);
  }
  return num;
}

function trimTrailingEntries(data, trailers, multibyte) {
  for (let i = 0; i < trailers; i++) {
    const num = getTrailingEntrySize(data);
    if (num > 0 && num <= data.length) data = data.subarray(0, data.length - num);
  }
  if (multibyte && data.length > 0) {
    const num = (data[data.length - 1] & 3) + 1;
    if (num <= data.length) data = data.subarray(0, data.length - num);
  }
  return data;
}

function countTrailers(flags) {
  const multibyte = flags & 1;
  let trailers = 0;
  let f = flags;
  while (f > 1) {
    if (f & 2) trailers++;
    f >>= 1;
  }
  return { trailers, multibyte };
}

/* ---------- PDB 容器 ---------- */

function parsePDB(bytes, view) {
  if (bytes.length < 78) fail('这似乎不是有效的 AZW3 文件（文件太小）。');
  const creator = asciiStr(bytes, 64, 4);
  if (creator !== 'MOBI') fail('这似乎不是有效的 AZW3/MOBI 文件。');
  const numRecords = view.getUint16(76);
  if (numRecords < 1) fail('这似乎不是有效的 AZW3 文件（没有数据记录）。');
  const offsets = [];
  for (let i = 0; i < numRecords; i++) offsets.push(view.getUint32(78 + i * 8));
  const sections = [];
  for (let i = 0; i < numRecords; i++) {
    const start = offsets[i];
    const end = i + 1 < numRecords ? offsets[i + 1] : bytes.length;
    sections.push(bytes.subarray(start, Math.max(start, end)));
  }
  let name = asciiStr(bytes, 0, 32);
  const nul = name.indexOf('\u0000');
  if (nul >= 0) name = name.slice(0, nul);
  return { sections, name };
}

/* ---------- MOBI / EXTH 头 ---------- */

function parseEXTH(rec, view, offset) {
  const tags = {};
  let length = 0;
  if (offset + 12 <= rec.length && asciiStr(rec, offset, 4) === 'EXTH') {
    const headerLength = view.getUint32(offset + 4);
    const numItems = view.getUint32(offset + 8);
    let pos = offset + 12;
    for (let i = 0; i < numItems && pos + 8 <= rec.length; i++) {
      const id = view.getUint32(pos);
      const size = view.getUint32(pos + 4);
      if (size < 8 || pos + size > rec.length) break;
      const content = rec.subarray(pos + 8, pos + size);
      (tags[id] || (tags[id] = [])).push(content);
      pos += size;
    }
    length = (headerLength + 3) & ~3;
  }
  return { tags, length };
}

/** 解析一条记录作为「record0 风格」的 MOBI 头。recIndex = 该记录在 PDB 中的下标（combo 文件的 K8 头非 0）。 */
function parseMobiHeader(rec, recIndex) {
  if (rec.length < 20 || asciiStr(rec, 16, 4) !== 'MOBI') return null;
  const view = new DataView(rec.buffer, rec.byteOffset, rec.byteLength);
  const g32 = (off, dflt = 0xffffffff) => (off + 4 <= rec.length ? view.getUint32(off) : dflt);
  const g16 = (off, dflt = 0) => (off + 2 <= rec.length ? view.getUint16(off) : dflt);

  const compressionType = g16(0, 1);
  const encryptionType = g16(12, 0);
  const textRecordCount = g16(8, 0);
  const headerLength = g32(20, 0);
  const textEncoding = g32(28, 65001);
  const version = g32(36, 0);
  const fullNameOffset = g32(84, 0);
  const fullNameLength = g32(88, 0);
  const locale = g32(92, 0);
  let firstResource = g32(108, 0xffffffff);
  const exthFlags = g32(128, 0);
  const drmOffset = g32(168, 0xffffffff);
  const drmCount = g32(172, 0xffffffff);
  const traildataFlags = g16(0xf2, 0);
  let ncxidx = g32(0xf4, 0xffffffff);

  let skelidx = 0xffffffff, fragidx = 0xffffffff, guideidx = 0xffffffff;
  let fdst = 0xffffffff, fdstFlowCount = 0;
  const isK8 = recIndex !== 0 || version === 8;
  if (isK8) {
    fdst = g32(0xc0, 0xffffffff);
    fdstFlowCount = g32(0xc4, 0);
    if (fdstFlowCount <= 1) fdst = 0xffffffff;
    fragidx = g32(0xf8, 0xffffffff);
    skelidx = g32(0xfc, 0xffffffff);
    guideidx = g32(0x104, 0xffffffff);
    if (skelidx !== 0xffffffff) skelidx += recIndex;
    if (fragidx !== 0xffffffff) fragidx += recIndex;
    if (guideidx !== 0xffffffff) guideidx += recIndex;
    if (fdst !== 0xffffffff) fdst += recIndex;
  }
  if (firstResource !== 0xffffffff) firstResource += recIndex;
  if (ncxidx !== 0xffffffff) ncxidx += recIndex;

  const hasExth = (exthFlags & 0x40) !== 0;
  const exth = hasExth ? parseEXTH(rec, view, headerLength + 16) : { tags: {}, length: 0 };

  let title = null;
  if (fullNameLength > 0 && fullNameOffset + fullNameLength <= rec.length) {
    title = decodeText(rec.subarray(fullNameOffset, fullNameOffset + fullNameLength), textEncoding);
  }

  return {
    recIndex, isK8, version, compressionType, encryptionType, textRecordCount,
    headerLength, textEncoding, locale, firstResource, drmOffset, drmCount,
    traildataFlags, ncxidx, skelidx, fragidx, guideidx, fdst, fdstFlowCount,
    exth, title,
  };
}

/* ---------- FDST：主文本流分段 ---------- */

function parseFDST(sections, idx, rawSize) {
  if (idx === 0xffffffff || !sections[idx] || asciiStr(sections[idx], 0, 4) !== 'FDST') return [0, rawSize];
  const data = sections[idx];
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const numSections = view.getUint32(8);
  const starts = [];
  for (let j = 0; j < numSections && 12 + j * 8 + 4 <= data.length; j++) starts.push(view.getUint32(12 + j * 8));
  if (!starts.length) return [0, rawSize];
  starts.push(rawSize);
  return starts;
}

/* ---------- INDX / TAGX 通用索引解析 ---------- */

function parseINDXHeader(data, view) {
  if (data.length < 56 || asciiStr(data, 0, 4) !== 'INDX') return null;
  const words = ['len', 'nul1', 'type', 'gen', 'start', 'count', 'code', 'lng', 'total', 'ordt', 'ligt', 'nligt', 'nctoc'];
  const header = {};
  words.forEach((w, i) => { header[w] = view.getUint32(4 + i * 4); });
  return header;
}

function readTagSection(data, view, start) {
  let controlByteCount = 0;
  const tags = [];
  if (start + 12 <= data.length && asciiStr(data, start, 4) === 'TAGX') {
    const firstEntryOffset = view.getUint32(start + 4);
    controlByteCount = view.getUint32(start + 8);
    for (let i = 12; i < firstEntryOffset && start + i + 4 <= data.length; i += 4) {
      const p = start + i;
      tags.push([data[p], data[p + 1], data[p + 2], data[p + 3]]);
    }
  }
  return { controlByteCount, tags };
}

function countSetBits(v) {
  let c = 0;
  for (let i = 0; i < 8; i++) { if (v & 1) c++; v >>= 1; }
  return c;
}

function getVariableWidthValue(data, offset) {
  let value = 0, consumed = 0, finished = false;
  while (!finished && offset + consumed < data.length) {
    const v = data[offset + consumed];
    consumed++;
    if (v & 0x80) finished = true;
    value = value * 128 + (v & 0x7f);
  }
  return [Math.max(consumed, 1), value];
}

function getTagMap(controlByteCount, tagTable, data, startPos, endPos) {
  const prelim = [];
  let controlByteIndex = 0;
  let dataStart = startPos + controlByteCount;
  for (const [tag, valuesPerEntry, mask, endFlag] of tagTable) {
    if (endFlag === 1) { controlByteIndex++; continue; }
    const cbyte = data[startPos + controlByteIndex] || 0;
    const value = cbyte & mask;
    if (value !== 0) {
      if (value === mask) {
        if (countSetBits(mask) > 1) {
          const [consumed, v] = getVariableWidthValue(data, dataStart);
          dataStart += consumed;
          prelim.push([tag, null, v, valuesPerEntry]);
        } else {
          prelim.push([tag, 1, null, valuesPerEntry]);
        }
      } else {
        let m = mask, val = value;
        while ((m & 1) === 0 && m !== 0) { m >>= 1; val >>= 1; }
        prelim.push([tag, val, null, valuesPerEntry]);
      }
    }
  }
  const tagMap = {};
  for (const [tag, valueCount, valueBytes, valuesPerEntry] of prelim) {
    const values = [];
    if (valueCount !== null) {
      for (let i = 0; i < valueCount * valuesPerEntry; i++) {
        const [consumed, v] = getVariableWidthValue(data, dataStart);
        dataStart += consumed; values.push(v);
      }
    } else {
      let totalConsumed = 0;
      while (totalConsumed < valueBytes && dataStart < endPos + 8) {
        const [consumed, v] = getVariableWidthValue(data, dataStart);
        dataStart += consumed; totalConsumed += consumed; values.push(v);
      }
    }
    tagMap[tag] = values;
  }
  return tagMap;
}

function readCTOC(data) {
  const result = {};
  let offset = 0;
  while (offset < data.length && data[offset] !== 0) {
    const idxOffs = offset;
    const [consumed, len] = getVariableWidthValue(data, offset);
    offset += consumed;
    result[idxOffs] = data.subarray(offset, offset + len);
    offset += len;
  }
  return result;
}

function getIndexData(sections, idx) {
  const outtbl = [];
  const ctocText = {};
  if (idx === 0xffffffff || !sections[idx]) return { outtbl, ctocText };
  const data = sections[idx];
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const hdr = parseINDXHeader(data, view);
  if (!hdr) return { outtbl, ctocText };
  const indexCount = hdr.count;
  let recOff = 0;
  const ctocStart = idx + indexCount + 1;
  for (let j = 0; j < hdr.nctoc && sections[ctocStart + j]; j++) {
    const ctoc = readCTOC(sections[ctocStart + j]);
    for (const k in ctoc) ctocText[Number(k) + recOff] = ctoc[k];
    recOff += 0x10000;
  }
  const { controlByteCount, tags: tagTable } = readTagSection(data, view, hdr.len);
  for (let i = idx + 1; i <= idx + indexCount; i++) {
    const edata = sections[i];
    if (!edata) continue;
    const edv = new DataView(edata.buffer, edata.byteOffset, edata.byteLength);
    const ehdr = parseINDXHeader(edata, edv);
    if (!ehdr) continue;
    const idxtPos = ehdr.start;
    const entryCount = ehdr.count;
    const idxPositions = [];
    for (let j = 0; j < entryCount && idxtPos + 4 + 2 * j + 2 <= edata.length; j++) {
      idxPositions.push(edv.getUint16(idxtPos + 4 + 2 * j));
    }
    idxPositions.push(idxtPos);
    for (let j = 0; j < idxPositions.length - 1; j++) {
      const startPos = idxPositions[j], endPos = idxPositions[j + 1];
      if (startPos >= edata.length) continue;
      const textLength = edata[startPos];
      const text = edata.subarray(startPos + 1, startPos + 1 + textLength);
      const tagMap = getTagMap(controlByteCount, tagTable, edata, startPos + 1 + textLength, endPos);
      outtbl.push([text, tagMap]);
    }
  }
  return { outtbl, ctocText };
}

/* ---------- skeleton / fragment / ncx 表 ---------- */

function parseSkeletonIndex(sections, idx) {
  const { outtbl } = getIndexData(sections, idx);
  return outtbl.map(([nameBytes, tagMap]) => ({
    name: asciiStr(nameBytes),
    fragcnt: tagMap[1] ? tagMap[1][0] : 0,
    start: tagMap[6] ? tagMap[6][0] : 0,
    length: tagMap[6] ? tagMap[6][1] : 0,
  }));
}

/* ---------- 组装 part（skeleton + fragment 拼接） ---------- */

function buildParts(flow0, skeltbl, fragtbl) {
  const parts = [];
  const partinfo = [];
  let fragptr = 0;
  for (let skelnum = 0; skelnum < skeltbl.length; skelnum++) {
    const sk = skeltbl[skelnum];
    let baseptr = sk.start + sk.length;
    let skeleton = flow0.subarray(sk.start, Math.min(baseptr, flow0.length));
    for (let i = 0; i < sk.fragcnt && fragptr < fragtbl.length; i++) {
      const frag = fragtbl[fragptr];
      const sliceEnd = Math.min(baseptr + frag.length, flow0.length);
      const slice = flow0.subarray(Math.min(baseptr, flow0.length), sliceEnd);
      let insertpos = frag.insertpos - sk.start;
      if (insertpos < 0) insertpos = 0;
      if (insertpos > skeleton.length) insertpos = skeleton.length;
      const head = skeleton.subarray(0, insertpos);
      const tail = skeleton.subarray(insertpos);
      skeleton = concatBytes(head, slice, tail);
      baseptr += frag.length;
      fragptr++;
    }
    parts.push(skeleton);
    partinfo.push({ skelnum, start: sk.start, end: baseptr });
  }
  return { parts, partinfo };
}

function findPartForPos(partinfo, pos) {
  for (const pi of partinfo) {
    if (pos >= pi.start && pos < pi.end) return pi.skelnum;
  }
  return null;
}

/* ---------- 资源（图片） ---------- */

function extractImages(sections, firstResource) {
  const images = [];
  if (firstResource === 0xffffffff) return images;
  let i = firstResource;
  while (i < sections.length) {
    const rec = sections[i];
    if (!rec || rec.length === 0) break;
    const mime = detectImageMime(rec);
    if (!mime) break;
    images.push({ index: images.length + 1, mime, data: rec });
    i++;
  }
  return images;
}

/* ---------- HTML 后处理：图片引用 / aid / 站内链接 ---------- */

function rewriteImages(html, images, onUnresolved) {
  return html.replace(/<img\b[^>]*>/gi, (tag) => {
    let idx = null;
    let m = tag.match(/\bsrc\s*=\s*["']kindle:embed:([0-9A-Za-z]+)[^"']*["']/i);
    if (m) idx = parseInt(m[1], 32);
    else {
      m = tag.match(/\brecindex\s*=\s*["']?0*(\d+)["']?/i);
      if (m) idx = parseInt(m[1], 10);
    }
    if (idx == null || Number.isNaN(idx)) { onUnresolved(); return ''; }
    const img = images[idx - 1];
    if (!img) { onUnresolved(); return ''; }
    let altM = tag.match(/\balt\s*=\s*("([^"]*)"|'([^']*)')/i);
    const alt = altM ? (altM[2] ?? altM[3] ?? '') : '';
    return `<img src="${img.href}" alt="${alt.replace(/"/g, '&quot;')}" />`;
  });
}

function rewriteAid(html) {
  return html.replace(/\said\s*=\s*("([^"]*)"|'([^']*)')/gi, (m, _q, d, s) => {
    const val = d ?? s ?? '';
    return ` id="aid-${val}"`;
  });
}

function rewriteInternalLinks(html, fragtbl, partinfo, chapterIds) {
  return html.replace(/href\s*=\s*("kindle:pos:fid:([0-9A-Za-z]+):off:([0-9A-Za-z]+)[^"]*"|'kindle:pos:fid:([0-9A-Za-z]+):off:([0-9A-Za-z]+)[^']*')/gi,
    (m, _whole, dPos, dOff, sPos, sOff) => {
      const posfid = dPos ?? sPos;
      const offset = dOff ?? sOff;
      const row = parseInt(posfid, 32);
      const off = parseInt(offset, 32);
      const frag = fragtbl[row];
      if (!frag) return 'href="#"';
      const pos = frag.insertpos + off;
      const partIdx = findPartForPos(partinfo, pos);
      if (partIdx == null || !chapterIds[partIdx]) return 'href="#"';
      return `href="#${chapterIds[partIdx]}"`;
    });
}

function extractTitle(html) {
  const m = html.match(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/i);
  if (!m) return null;
  const t = plainText(m[1]).trim();
  return t || null;
}

/* ---------- locale -> BCP47 ---------- */

function mapLocale(code) {
  const langId = code & 0xff;
  if (langId === 4) {
    const sub = (code >>> 10) & 0xff;
    return sub === 1 || sub === 3 ? 'zh-Hant' : 'zh-Hans';
  }
  const map = {
    9: 'en', 17: 'ja', 18: 'ko', 25: 'ru', 1: 'ar', 2: 'bg', 3: 'ca', 5: 'cs',
    6: 'da', 7: 'de', 8: 'el', 10: 'es', 11: 'fi', 12: 'fr', 13: 'he', 14: 'hu',
    15: 'is', 16: 'it', 19: 'nl', 20: 'no', 21: 'pl', 22: 'pt', 23: 'rm', 24: 'ro',
    27: 'sk', 28: 'sq', 29: 'sv', 30: 'th', 31: 'tr', 32: 'ur', 33: 'id', 34: 'uk',
    36: 'sl', 37: 'et', 38: 'lv', 39: 'lt', 42: 'vi',
  };
  return map[langId] || 'zh-Hans';
}

/* ---------- 主流程 ---------- */

async function readImpl(buf, opts) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (bytes.length < 78) fail('这似乎不是有效的 AZW3 文件。');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const { sections, name: pdbName } = parsePDB(bytes, view);
  await tick();

  let header = parseMobiHeader(sections[0], 0);
  if (!header) fail('这个文件的头部结构无法识别，可能不是标准的 AZW3/MOBI 文件。');

  checkDrm(header);

  let isK8 = header.version >= 8;
  const warnings = [];
  if (!isK8) {
    const boundaryTag = header.exth.tags[121];
    if (boundaryTag && boundaryTag[0].length >= 4) {
      const bv = new DataView(boundaryTag[0].buffer, boundaryTag[0].byteOffset, boundaryTag[0].byteLength);
      const boundaryRec = bv.getUint32(0);
      const altRec = boundaryRec + 1;
      if (sections[altRec]) {
        const alt = parseMobiHeader(sections[altRec], altRec);
        if (alt && alt.version >= 8) {
          checkDrm(alt);
          header = alt;
          isK8 = true;
          warnings.push({ code: 'azw3.combo', detail: '检测到新旧双格式合并文件，已只提取新版（KF8）排版内容。' });
        }
      }
    }
  }
  if (!isK8) {
    fail('这个文件是较旧的 MOBI6 电子书，不是 KF8/AZW3 格式，暂不支持；可以用 Calibre 转换成 EPUB 后再试。');
  }

  if (header.compressionType === 0x4448) {
    fail('这本 AZW3 使用了少见的 HUFF/CDIC 压缩方式，暂不支持解析；可以用 Calibre 转换成 EPUB 后再试。');
  }
  if (header.compressionType !== 1 && header.compressionType !== 2) {
    fail('无法识别这本 AZW3 的正文压缩格式。');
  }

  const rawML = buildRawML(sections, header);
  await tick();
  if (!rawML.length) fail('这本 AZW3 没有可提取的正文内容。');

  const fdsttbl = parseFDST(sections, header.fdst, rawML.length);
  const flow0 = rawML.subarray(fdsttbl[0], Math.min(fdsttbl[1], rawML.length));

  const skeltbl = parseSkeletonIndex(sections, header.skelidx);
  const fragtbl = parseFragmentIndexReal(sections, header.fragidx);
  if (!skeltbl.length) fail('无法解析这本 AZW3 的章节结构索引（skeleton index 缺失或损坏）。');

  const { parts, partinfo } = buildParts(flow0, skeltbl, fragtbl);
  await tick();

  const images = extractImages(sections, header.firstResource);

  const meta = buildMeta(header, pdbName, opts);
  const book = newBook(meta);
  for (const w of warnings) warn(book, w.code, w.detail);

  for (const img of images) {
    const rid = `img${String(img.index).padStart(3, '0')}`;
    const href = `images/${rid}.${extFor(img.mime)}`;
    book.resources.set(rid, { href, mime: img.mime, data: img.data.slice() });
    img.href = href;
    img.rid = rid;
  }

  const chapterIds = parts.map((_, i) => `c${i + 1}`);
  let unresolvedImages = false;
  for (let i = 0; i < parts.length; i++) {
    let html = decodeText(parts[i], header.textEncoding);
    html = rewriteImages(html, images, () => { unresolvedImages = true; });
    html = rewriteAid(html);
    html = rewriteInternalLinks(html, fragtbl, partinfo, chapterIds);
    html = sanitizeHtml(html);
    const title = extractTitle(html);
    book.chapters.push({ id: chapterIds[i], title, level: 1, html });
    if (i % 20 === 0) await tick();
  }
  if (unresolvedImages) warn(book, 'azw3.image-unresolved', '部分插图引用未能解析，对应位置已省略。');

  const ncxEntries = parseNCXIndex(sections, header.ncxidx, header.textEncoding);
  if (ncxEntries.length) {
    book.nav = buildNavTree(ncxEntries, fragtbl, partinfo, chapterIds);
  } else {
    warn(book, 'azw3.no-nav', '未找到目录索引，已按章节顺序生成平铺目录。');
    book.nav = chapterIds.map((id, i) => ({
      title: book.chapters[i].title || `第 ${i + 1} 部分`,
      target: id, anchor: null, level: 1, children: [],
    }));
  }

  const coverTag = header.exth.tags[201];
  if (coverTag && coverTag[0].length >= 4 && header.firstResource !== 0xffffffff) {
    const cv = new DataView(coverTag[0].buffer, coverTag[0].byteOffset, coverTag[0].byteLength);
    const off = cv.getUint32(0);
    const img = images[off];
    if (img) book.cover = img.rid;
  }

  const v = validate(book);
  if (!v.ok) fail('这本 AZW3 解析后的结构没有通过内部校验，可能使用了本工具暂不支持的排版方式。');
  return book;
}

function checkDrm(header) {
  const hasDrm = header.encryptionType !== 0 ||
    (header.drmOffset !== 0xffffffff && header.drmCount !== 0xffffffff && header.drmCount > 0);
  if (hasDrm) fail('这本书带有版权保护，无法处理。');
}

function buildRawML(sections, header) {
  const applyTrailers = header.headerLength >= 0xe4 && header.version >= 5;
  const { trailers, multibyte } = applyTrailers ? countTrailers(header.traildataFlags) : { trailers: 0, multibyte: 0 };
  const pieces = [];
  for (let i = 1; i <= header.textRecordCount; i++) {
    let data = sections[header.recIndex + i];
    if (!data) break;
    data = trimTrailingEntries(data, trailers, multibyte);
    pieces.push(header.compressionType === 2 ? palmDocDecompress(data) : Uint8Array.from(data));
  }
  return concatBytes(...pieces);
}

/** fragment index 逐条读取：insertpos（切入位置）+ ctoc 里的 aid 文本 + filenum/seqnum + [start,length] */
function parseFragmentIndexReal(sections, idx) {
  const { outtbl, ctocText } = getIndexData(sections, idx);
  return outtbl.map(([textBytes, tagMap]) => ({
    insertpos: parseInt(asciiStr(textBytes), 10) || 0,
    aid: tagMap[2] && ctocText[tagMap[2][0]] ? asciiStr(ctocText[tagMap[2][0]]) : '',
    filenum: tagMap[3] ? tagMap[3][0] : 0,
    seqnum: tagMap[4] ? tagMap[4][0] : 0,
    start: tagMap[6] ? tagMap[6][0] : 0,
    length: tagMap[6] ? tagMap[6][1] : 0,
  }));
}

function parseNCXIndex(sections, ncxidx, textEncoding) {
  const { outtbl, ctocText } = getIndexData(sections, ncxidx);
  return outtbl.map(([, tagMap]) => {
    const e = { hlvl: 0, text: '', posFidRow: null, posFidOff: 0 };
    if (tagMap[4]) e.hlvl = tagMap[4][0];
    if (tagMap[3] && ctocText[tagMap[3][0]]) e.text = decodeText(ctocText[tagMap[3][0]], textEncoding);
    if (tagMap[6]) { e.posFidRow = tagMap[6][0]; e.posFidOff = tagMap[6][1] ?? 0; }
    return e;
  });
}

function buildNavTree(entries, fragtbl, partinfo, chapterIds) {
  const nodes = entries.map((e) => {
    const level = Math.min(Math.max((e.hlvl || 0) + 1, 1), 3);
    let target = chapterIds[0] || null;
    if (e.posFidRow != null) {
      const frag = fragtbl[e.posFidRow];
      if (frag) {
        const pos = frag.insertpos + e.posFidOff;
        const partIdx = findPartForPos(partinfo, pos);
        if (partIdx != null && chapterIds[partIdx]) target = chapterIds[partIdx];
      }
    }
    return { title: e.text || '', target, anchor: null, level, children: [], _lvl: level };
  }).filter((n) => n.target);

  const root = [];
  const stack = [];
  for (const n of nodes) {
    while (stack.length && stack[stack.length - 1]._lvl >= n._lvl) stack.pop();
    const parentArr = stack.length ? stack[stack.length - 1].children : root;
    parentArr.push(n);
    stack.push(n);
  }
  const strip = (arr) => { for (const n of arr) { delete n._lvl; strip(n.children); } };
  strip(root);
  return root;
}

function buildMeta(header, pdbName, opts) {
  const decodeStr = (bytes) => decodeText(bytes, header.textEncoding);
  const exthStr = (id) => (header.exth.tags[id] ? decodeStr(header.exth.tags[id][0]).replace(/\u0000+$/, '').trim() : null);

  const updatedTitle = exthStr(503);
  const title = updatedTitle || header.title || pdbName || (opts && opts.filename) || undefined;

  const authors = (header.exth.tags[100] || []).map((b) => decodeStr(b).trim()).filter(Boolean);
  const author = authors.length ? authors.join('、') : null;

  const publisher = exthStr(101) || null;
  const descRaw = exthStr(103);
  const description = descRaw ? plainText(sanitizeHtml(descRaw)) || null : null;
  const dateRaw = exthStr(106);
  const date = normalizeDate(dateRaw);
  const asin = exthStr(113);
  const identifier = asin ? `urn:mobi:asin:${asin}` : undefined;
  const language = mapLocale(header.locale);

  return { title, author, language, identifier, publisher, date, description };
}

function normalizeDate(raw) {
  if (!raw) return null;
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  const y = raw.match(/^(\d{4})/);
  if (y) return `${y[1]}-01-01`;
  return null;
}
