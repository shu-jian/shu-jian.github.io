/* ============================================================
 * EPUB → Book IR
 *
 * 解析链：META-INF/container.xml → OPF（metadata/manifest/spine）
 *   → 目录（EPUB3 nav 文档，回退 NCX）→ 逐个 spine 内容文档转 chapters。
 *
 * 环境中立：不依赖 DOMParser（Node 测试环境没有），自带一个极简 XML/XHTML
 *   tokenizer，专为 EPUB 里出现的（半）规范标记服务，不是通用 XML 解析器。
 *
 * 只假定 globalThis.JSZip 存在，不加载任何外部脚本、不发任何网络请求。
 * ============================================================ */

import { newBook, warn, sanitizeHtml } from '../ir.js';

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/* ---------- 友好错误 ---------- */

function fail(message) {
  throw new Error(message);
}

/* ============================================================
 * 极简 XML tokenizer（container.xml / OPF / NCX / nav 文档 / 内容文档共用）
 * ============================================================ */

const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeXmlEntities(s) {
  return String(s).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return XML_ENTITIES[body.toLowerCase()] ?? m;
  });
}

function escapeAttrLocal(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

/** 去掉标签名的命名空间前缀（dc:title → title），用于宽松匹配 */
function localName(tag) {
  const i = tag.indexOf(':');
  return i === -1 ? tag : tag.slice(i + 1);
}

function parseAttrsGeneric(s) {
  const attrs = {};
  const re = /([a-zA-Z_:][a-zA-Z0-9_:.-]*)(?:\s*=\s*("([^"]*)"|'([^']*)'))?/g;
  let m;
  while ((m = re.exec(s))) {
    if (!m[1]) continue;
    const name = m[1].toLowerCase();
    const value = m[3] ?? m[4] ?? '';
    attrs[name] = decodeXmlEntities(value);
  }
  return attrs;
}

/**
 * 把 XML/XHTML 串切成 token 流：{type:'text',value}
 *   | {type:'open',tag,attrs,selfClose} | {type:'close',tag}
 * 注释 / CDATA / doctype / PI 处理为文本或直接吞掉。
 */
function tokenizeXml(str) {
  const tokens = [];
  const s = String(str || '');
  const n = s.length;
  let i = 0;
  while (i < n) {
    const lt = s.indexOf('<', i);
    if (lt === -1) { if (i < n) tokens.push({ type: 'text', value: s.slice(i) }); break; }
    if (lt > i) tokens.push({ type: 'text', value: s.slice(i, lt) });

    if (s.startsWith('<!--', lt)) {
      const end = s.indexOf('-->', lt + 4);
      i = end === -1 ? n : end + 3;
      continue;
    }
    if (s.startsWith('<![CDATA[', lt)) {
      const end = s.indexOf(']]>', lt + 9);
      tokens.push({ type: 'text', value: s.slice(lt + 9, end === -1 ? n : end) });
      i = end === -1 ? n : end + 3;
      continue;
    }
    if (s[lt + 1] === '!' || s[lt + 1] === '?') {
      const end = s.indexOf('>', lt + 1);
      i = end === -1 ? n : end + 1;
      continue;
    }

    const gt = s.indexOf('>', lt);
    if (gt === -1) { tokens.push({ type: 'text', value: s.slice(lt) }); break; }

    let raw = s.slice(lt + 1, gt).trim();
    i = gt + 1;
    if (!raw) continue;

    if (raw[0] === '/') {
      tokens.push({ type: 'close', tag: raw.slice(1).trim().toLowerCase() });
      continue;
    }

    let selfClose = false;
    if (raw.endsWith('/')) { selfClose = true; raw = raw.slice(0, -1).trim(); }

    const mName = raw.match(/^([a-zA-Z_][a-zA-Z0-9_:.-]*)/);
    if (!mName) continue;
    const tag = mName[1].toLowerCase();
    const attrs = parseAttrsGeneric(raw.slice(mName[1].length));
    tokens.push({ type: 'open', tag, attrs, selfClose });
  }
  return tokens;
}

/**
 * 在一段 token 数组里找所有满足 predicate(tag, attrs) 的元素（含自闭合），
 * 返回 {tag, attrs, startIdx, endIdx}（endIdx 为闭合标签之后一位，exclusive）。
 * 命中后跳过其整个范围，不深入其内部找同类嵌套匹配（够用：本文件的目标
 * 结构都不会把同名元素直接嵌套自身，除 footnote 极端情况，可接受）。
 */
function findElements(tokens, predicate) {
  const results = [];
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    if (t.type === 'open' && predicate(t.tag, t.attrs)) {
      if (t.selfClose) {
        results.push({ tag: t.tag, attrs: t.attrs, startIdx: i, endIdx: i + 1 });
        i += 1;
        continue;
      }
      let depth = 1, j = i + 1;
      while (j < tokens.length && depth > 0) {
        const tj = tokens[j];
        if (tj.type === 'open' && tj.tag === t.tag && !tj.selfClose) depth += 1;
        else if (tj.type === 'close' && tj.tag === t.tag) depth -= 1;
        j += 1;
      }
      results.push({ tag: t.tag, attrs: t.attrs, startIdx: i, endIdx: j });
      i = j;
      continue;
    }
    i += 1;
  }
  return results;
}

/** 拼出一段 token 区间里的纯文本（忽略标签，折叠空白） */
function tokensToText(tokens) {
  let s = '';
  for (const t of tokens) if (t.type === 'text') s += t.value;
  return decodeXmlEntities(s).replace(/\s+/g, ' ').trim();
}

/** 把 token 数组重新序列化为字符串（供再交给 sanitizeHtml 清洗） */
function serializeTokens(tokens) {
  let out = '';
  for (const t of tokens) {
    if (t.type === 'text') { out += t.value; continue; }
    if (t.type === 'open') {
      const attrStr = Object.entries(t.attrs)
        .map(([k, v]) => ` ${k}="${escapeAttrLocal(v)}"`)
        .join('');
      out += `<${t.tag}${attrStr}${t.selfClose ? ' /' : ''}>`;
      continue;
    }
    if (t.type === 'close') out += `</${t.tag}>`;
  }
  return out;
}

/* ============================================================
 * 路径工具（POSIX，环境中立，不用 node:path——产物要在浏览器里跑）
 * ============================================================ */

function dirnamePosix(p) {
  const i = p.lastIndexOf('/');
  return i === -1 ? '' : p.slice(0, i);
}

function joinPosix(dir, rel) {
  const stack = dir ? dir.split('/').filter(Boolean) : [];
  for (const part of rel.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') { if (stack.length) stack.pop(); }
    else stack.push(part);
  }
  return stack.join('/');
}

function decodePathSafe(p) {
  try { return decodeURIComponent(p); } catch { return p; }
}

/** 解析 OPF manifest 里的 href（相对 OPF 所在目录） */
function resolveManifestHref(opfDir, href) {
  const path = href.split('#')[0];
  return joinPosix(opfDir, decodePathSafe(path));
}

/** 解析某内容文档内部的 href（相对该文档所在目录），返回 {zipPath, frag} */
function resolveDocHref(docPath, href) {
  if (!href) return { zipPath: null, frag: null };
  const hashIdx = href.indexOf('#');
  const pathPart = hashIdx === -1 ? href : href.slice(0, hashIdx);
  const frag = hashIdx === -1 ? null : decodePathSafe(href.slice(hashIdx + 1)) || null;
  if (!pathPart) return { zipPath: docPath, frag };
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(pathPart)) return { zipPath: null, frag }; // 外部协议链接
  const zipPath = joinPosix(dirnamePosix(docPath), decodePathSafe(pathPart));
  return { zipPath, frag };
}

/* ============================================================
 * zip 存取
 * ============================================================ */

function findZipFile(zip, path) {
  const norm = path.replace(/^\/+/, '');
  let f = zip.file(norm);
  if (f) return f;
  const lower = norm.toLowerCase();
  for (const key of Object.keys(zip.files)) {
    if (key.toLowerCase() === lower) return zip.file(key);
  }
  return null;
}

async function readZipText(zip, path) {
  const f = findZipFile(zip, path);
  if (!f) return null;
  return f.async('string');
}

/* ============================================================
 * OPF 解析
 * ============================================================ */

function parseOpf(opfText) {
  const tokens = tokenizeXml(opfText);

  const metadataEls = findElements(tokens, (t) => localName(t) === 'metadata');
  const metaInner = metadataEls.length
    ? tokens.slice(metadataEls[0].startIdx + 1, metadataEls[0].endIdx - 1)
    : [];

  const pickAll = (name) => findElements(metaInner, (t) => localName(t) === name)
    .map((e) => tokensToText(metaInner.slice(e.startIdx + 1, e.endIdx - 1)))
    .filter(Boolean);
  const pickFirst = (name) => { const all = pickAll(name); return all.length ? all[0] : null; };

  const title = pickFirst('title');
  const creators = pickAll('creator');
  const creator = creators.length ? creators.join('、') : null;
  const language = pickFirst('language');
  const publisher = pickFirst('publisher');
  const date = pickFirst('date');
  const description = pickFirst('description');
  const identifier = pickFirst('identifier');

  let coverId = null;
  for (const m of findElements(metaInner, (t) => t === 'meta')) {
    if ((m.attrs.name || '').toLowerCase() === 'cover' && m.attrs.content) { coverId = m.attrs.content; break; }
  }

  const manifest = new Map();
  const manifestEls = findElements(tokens, (t) => localName(t) === 'manifest');
  if (manifestEls.length) {
    const inner = tokens.slice(manifestEls[0].startIdx + 1, manifestEls[0].endIdx - 1);
    for (const it of findElements(inner, (t) => t === 'item')) {
      const a = it.attrs;
      if (!a.id || !a.href) continue;
      manifest.set(a.id, {
        href: a.href,
        mediaType: (a['media-type'] || '').toLowerCase(),
        properties: (a.properties || '').split(/\s+/).filter(Boolean),
      });
    }
  }

  let spine = { ppd: null, items: [], tocId: null };
  const spineEls = findElements(tokens, (t) => localName(t) === 'spine');
  if (spineEls.length) {
    const se = spineEls[0];
    const inner = tokens.slice(se.startIdx + 1, se.endIdx - 1);
    const items = [];
    for (const ir of findElements(inner, (t) => t === 'itemref')) {
      if (!ir.attrs.idref) continue;
      items.push({ idref: ir.attrs.idref, linear: (ir.attrs.linear || 'yes').toLowerCase() !== 'no' });
    }
    spine = {
      ppd: (se.attrs['page-progression-direction'] || '').toLowerCase() || null,
      items,
      tocId: se.attrs.toc || null,
    };
  }

  return { title, creator, language, publisher, date, description, identifier, coverId, manifest, spine };
}

function findOpfPath(containerXml) {
  const tokens = tokenizeXml(containerXml);
  for (const r of findElements(tokens, (t) => localName(t) === 'rootfile')) {
    if (r.attrs['full-path']) return r.attrs['full-path'];
  }
  return null;
}

/* ============================================================
 * 加密检测：只有当被加密的资源是正文文档或图片时才判定为真正的 DRM
 * 并中止。常见的字体混淆（IDPF / Adobe 两种字体混淆算法，本产品本就不
 * 保留字体，读入不受影响）不中止，但也不再完全静默——返回一个标记，
 * 交由调用方在 book 建好后挂一条软 warning，让用户知情。
 * ============================================================ */

async function checkEncryption(zip, manifestByHref) {
  const encXml = await readZipText(zip, 'META-INF/encryption.xml');
  if (!encXml) return { softEncrypted: false };
  const tokens = tokenizeXml(encXml);
  let softEncrypted = false;
  for (const e of findElements(tokens, (t) => localName(t) === 'encrypteddata')) {
    const inner = tokens.slice(e.startIdx + 1, e.endIdx - 1);
    for (const r of findElements(inner, (t) => localName(t) === 'cipherreference')) {
      const uri = r.attrs.uri;
      if (!uri) continue;
      const path = decodePathSafe(uri).replace(/^\/+/, '');
      const info = manifestByHref.get(path);
      const mt = info ? info.mediaType : '';
      const looksBlocking = /^(application\/x?html\+xml|image\/)/i.test(mt)
        || /\.(x?html?|jpe?g|png|gif|svg|webp|bmp)$/i.test(path);
      if (looksBlocking) {
        fail('这本 EPUB 加了数字版权保护（DRM），无法读取内容。');
      }
      // 走到这里说明这条加密引用不指向正文/图片（典型如字体混淆），不阻断读入。
      softEncrypted = true;
    }
  }
  return { softEncrypted };
}

/* ============================================================
 * 图片资源登记
 * ============================================================ */

const MIME_BY_EXT = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
  svg: 'image/svg+xml', webp: 'image/webp', bmp: 'image/bmp',
};

function guessMimeFromExt(path) {
  const m = path.match(/\.([a-z0-9]+)$/i);
  return m ? (MIME_BY_EXT[m[1].toLowerCase()] || 'application/octet-stream') : 'application/octet-stream';
}

async function registerImage(zip, resources, cache, zipPath, mediaTypeHint) {
  if (cache.has(zipPath)) return cache.get(zipPath);
  const f = findZipFile(zip, zipPath);
  if (!f) { cache.set(zipPath, null); return null; }
  const data = new Uint8Array(await f.async('uint8array'));
  const mime = mediaTypeHint || guessMimeFromExt(zipPath);
  resources.set(zipPath, { href: zipPath, mime, data });
  cache.set(zipPath, zipPath);
  return zipPath;
}

/* ============================================================
 * 内容文档处理：svg 封面展开 / 脚注抽取 / 图片解析 / 章内链接改写
 * ============================================================ */

/** 常见的「svg 包一张图」封面写法：把 <svg><image xlink:href=".."/></svg> 展开成 <img> */
function unwrapSvgImages(tokens) {
  const matches = findElements(tokens, (tag) => tag === 'svg');
  for (let k = matches.length - 1; k >= 0; k--) {
    const m = matches[k];
    const inner = tokens.slice(m.startIdx + 1, m.endIdx - 1);
    const imgs = findElements(inner, (tag) => tag === 'image');
    let replacement = [];
    if (imgs.length) {
      const im = imgs[0];
      const href = im.attrs['xlink:href'] || im.attrs.href || '';
      if (href) replacement = [{ type: 'open', tag: 'img', attrs: { src: href, alt: '' }, selfClose: true }];
    }
    tokens.splice(m.startIdx, m.endIdx - m.startIdx, ...replacement);
  }
}

const NOTE_TYPES = new Set(['footnote', 'endnote', 'rearnote', 'note']);

/** 抽取 EPUB3 脚注块（epub:type 精确匹配，不误伤 "footnotes" 容器） */
function extractFootnotesFromTokens(tokens) {
  const isNoteEl = (tag, attrs) => {
    if (tag !== 'aside' && tag !== 'div' && tag !== 'section') return false;
    const types = (attrs['epub:type'] || '').toLowerCase().split(/\s+/);
    return types.some((t) => NOTE_TYPES.has(t));
  };
  const matches = findElements(tokens, isNoteEl);
  const extracted = [];
  for (let k = matches.length - 1; k >= 0; k--) {
    const m = matches[k];
    const id = m.attrs.id || null;
    if (!id) continue; // 没 id 就没法被引用，留在正文里当普通内容
    const inner = tokens.slice(m.startIdx + 1, m.endIdx - 1);
    extracted.push({ id, tokens: inner });
    tokens.splice(m.startIdx, m.endIdx - m.startIdx);
  }
  extracted.reverse();
  return extracted;
}

/** 把指向已抽取脚注 id 的 <a href="#id"> 改写为 <a class="noteref" href="#noteId"> */
function rewriteNoterefs(tokens, idToNoteId) {
  for (const t of tokens) {
    if (t.type !== 'open' || t.tag !== 'a') continue;
    const href = t.attrs.href || '';
    if (!href.startsWith('#')) continue;
    const localId = href.slice(1);
    if (!idToNoteId.has(localId)) continue;
    // class 必须排在 href 前面：validate() 的 noteref 正则要求这个顺序
    const rebuilt = { class: `${(t.attrs.class || '').trim()} noteref`.trim() };
    for (const [k, v] of Object.entries(t.attrs)) {
      if (k === 'class' || k === 'epub:type') continue;
      rebuilt[k] = k === 'href' ? `#${idToNoteId.get(localId)}` : v;
    }
    t.attrs = rebuilt;
  }
}

/** 解析并登记正文里的 <img src>，把 src 改写为 resources 里的键 */
async function resolveImagesInTokens(tokens, docPath, zip, resources, imgCache, manifestByHref, missing) {
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    if (t.type === 'open' && t.tag === 'img') {
      const src = t.attrs.src;
      let rid = null;
      if (src) {
        const { zipPath } = resolveDocHref(docPath, src);
        if (zipPath) {
          const info = manifestByHref.get(zipPath);
          rid = await registerImage(zip, resources, imgCache, zipPath, info && info.mediaType);
        }
      }
      if (rid) {
        t.attrs = { ...t.attrs, src: rid };
        i += 1;
        continue;
      }
      missing.push(src || '(空 src)');
      tokens.splice(i, 1);
      if (tokens[i] && tokens[i].type === 'close' && tokens[i].tag === 'img') tokens.splice(i, 1);
      continue;
    }
    i += 1;
  }
}

/** 章内 <a href> 交叉引用改写（BOOK-IR §2.1 约定） */
function classifyLink(href, docPath, hrefToChapterId) {
  if (!href) return { kind: 'drop' };
  if (href.startsWith('#')) {
    const frag = href.slice(1);
    return frag ? { kind: 'same', frag } : { kind: 'drop' };
  }
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(href)) return { kind: 'drop' }; // http(s): mailto: 等外部协议
  const { zipPath, frag } = resolveDocHref(docPath, href);
  if (!zipPath) return { kind: 'drop' };
  if (zipPath === docPath) return frag ? { kind: 'same', frag } : { kind: 'drop' };
  const chapterId = hrefToChapterId.get(zipPath);
  if (chapterId) return { kind: 'cross', chapterId };
  return { kind: 'drop' };
}

function unwrapElement(tokens, startIdx) {
  const tag = tokens[startIdx].tag;
  let depth = 1, j = startIdx + 1;
  while (j < tokens.length && depth > 0) {
    const tj = tokens[j];
    if (tj.type === 'open' && tj.tag === tag && !tj.selfClose) depth += 1;
    else if (tj.type === 'close' && tj.tag === tag) depth -= 1;
    j += 1;
  }
  if (depth !== 0) return false;
  tokens.splice(j - 1, 1);
  tokens.splice(startIdx, 1);
  return true;
}

function rewriteAnchors(tokens, docPath, hrefToChapterId) {
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    if (t.type === 'open' && t.tag === 'a' && t.attrs && t.attrs.href) {
      const decision = classifyLink(t.attrs.href, docPath, hrefToChapterId);
      if (decision.kind === 'same') { t.attrs.href = `#${decision.frag}`; i += 1; continue; }
      if (decision.kind === 'cross') { t.attrs.href = `#${decision.chapterId}`; i += 1; continue; }
      if (t.selfClose) { tokens.splice(i, 1); continue; }
      const ok = unwrapElement(tokens, i);
      if (!ok) i += 1;
      continue;
    }
    i += 1;
  }
}

function extractBody(xhtmlText) {
  const m = xhtmlText.match(/<body\b[^>]*>([\s\S]*)<\/body>/i);
  return m ? m[1] : xhtmlText;
}

function extractFirstHeading(html) {
  const m = html.match(/<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>/i);
  if (!m) return null;
  const text = decodeXmlEntities(m[1].replace(/<[^>]+>/g, '')).trim();
  return text || null;
}

/* ============================================================
 * 目录（nav / ncx）解析
 * ============================================================ */

/** <ol><li><a href>Title</a>[<ol>...</ol>]</li></ol> → 原始树 {title,href,children} */
function parseOlList(tokens) {
  const raw = [];
  for (const li of findElements(tokens, (tag) => tag === 'li')) {
    const inner = tokens.slice(li.startIdx + 1, li.endIdx - 1);
    const labelEls = findElements(inner, (tag) => tag === 'a' || tag === 'span');
    let title = '', href = null;
    if (labelEls.length) {
      const e = labelEls[0];
      title = tokensToText(inner.slice(e.startIdx + 1, e.endIdx - 1));
      href = e.attrs.href || null;
    }
    let children = [];
    const olEls = findElements(inner, (tag) => tag === 'ol');
    if (olEls.length) {
      const olInner = inner.slice(olEls[0].startIdx + 1, olEls[0].endIdx - 1);
      children = parseOlList(olInner);
    }
    raw.push({ title, href, children });
  }
  return raw;
}

/** NCX <navPoint><navLabel><text>Title</text></navLabel><content src=".."/>...</navPoint> */
function parseNavPoints(tokens) {
  const raw = [];
  for (const np of findElements(tokens, (t) => localName(t) === 'navpoint')) {
    const inner = tokens.slice(np.startIdx + 1, np.endIdx - 1);
    let title = '';
    const labelEls = findElements(inner, (t) => localName(t) === 'navlabel');
    if (labelEls.length) {
      const le = labelEls[0];
      const labelInner = inner.slice(le.startIdx + 1, le.endIdx - 1);
      const textEls = findElements(labelInner, (t) => t === 'text');
      if (textEls.length) {
        const te = textEls[0];
        title = tokensToText(labelInner.slice(te.startIdx + 1, te.endIdx - 1));
      }
    }
    let href = null;
    const contentEls = findElements(inner, (t) => t === 'content');
    if (contentEls.length) href = contentEls[0].attrs.src || null;
    const children = parseNavPoints(inner);
    raw.push({ title, href, children });
  }
  return raw;
}

/** 原始 {title,href,children} 树 → IR Nav[]（无法解析的节点被丢弃，子节点提升到上一级） */
function convertNavTree(rawList, navDocPath, hrefToChapterId, level) {
  const out = [];
  for (const raw of rawList) {
    const kids = convertNavTree(raw.children, navDocPath, hrefToChapterId, level + 1);
    if (!raw.href) { out.push(...kids); continue; }
    const { zipPath, frag } = resolveDocHref(navDocPath, raw.href);
    const chapterId = zipPath ? hrefToChapterId.get(zipPath) : null;
    if (!chapterId) { out.push(...kids); continue; }
    out.push({ title: raw.title || '', target: chapterId, anchor: frag || null, level, children: kids });
  }
  return out;
}

function collectChapterLevels(nav, map) {
  for (const n of nav) {
    if (n.anchor == null) {
      const cur = map.get(n.target);
      if (cur == null || n.level < cur) map.set(n.target, n.level);
    }
    if (n.children.length) collectChapterLevels(n.children, map);
  }
}

/* ============================================================
 * 单个 spine 条目的处理（第一遍：抽取 body / 展开封面 / 抽脚注 / 登记图片）
 * ============================================================ */

async function processSpineDoc(zip, docPath, resources, imgCache, manifestByHref, book, state) {
  const raw = await readZipText(zip, docPath);
  if (raw == null) return null;

  const tokens = tokenizeXml(extractBody(raw));
  unwrapSvgImages(tokens);

  const footnotes = extractFootnotesFromTokens(tokens);
  const idToNoteId = new Map();
  for (const fn of footnotes) {
    const noteId = `n${++state.noteCounter}`;
    idToNoteId.set(fn.id, noteId);
    await resolveImagesInTokens(fn.tokens, docPath, zip, resources, imgCache, manifestByHref, state.missingImages);
    book.notes.set(noteId, { html: sanitizeHtml(serializeTokens(fn.tokens)) });
  }
  rewriteNoterefs(tokens, idToNoteId);

  await resolveImagesInTokens(tokens, docPath, zip, resources, imgCache, manifestByHref, state.missingImages);

  return { docPath, tokens };
}

/* ============================================================
 * 主入口
 * ============================================================ */

export async function read(buf, opts = {}) {
  const JSZipLib = globalThis.JSZip;
  if (!JSZipLib) fail('暂时无法处理 EPUB 文件，请刷新页面后重试。');

  let zip;
  try {
    zip = await JSZipLib.loadAsync(buf);
  } catch {
    fail('这似乎不是有效的 EPUB 文件。');
  }

  const containerXml = await readZipText(zip, 'META-INF/container.xml');
  if (!containerXml) fail('这似乎不是有效的 EPUB 文件（缺少必要的目录信息）。');
  const opfPath = findOpfPath(containerXml);
  if (!opfPath) fail('这似乎不是有效的 EPUB 文件（找不到书籍清单）。');
  const opfText = await readZipText(zip, opfPath);
  if (!opfText) fail('这似乎不是有效的 EPUB 文件（书籍清单缺失）。');
  const opfDir = dirnamePosix(opfPath);

  const opf = parseOpf(opfText);
  if (!opf.spine.items.length) fail('这本 EPUB 没有可读取的正文内容。');

  const manifestByHref = new Map();
  for (const [id, item] of opf.manifest) {
    manifestByHref.set(resolveManifestHref(opfDir, item.href), { id, mediaType: item.mediaType, properties: item.properties });
  }

  const encryptionInfo = await checkEncryption(zip, manifestByHref);

  const book = newBook({
    title: opf.title || titleFromFilename(opts.filename),
    author: opf.creator,
    language: opf.language || undefined,
    identifier: opf.identifier || undefined,
    publisher: opf.publisher,
    date: opf.date,
    description: opf.description,
    writingMode: opf.spine.ppd === 'rtl' ? 'vertical-rl' : 'horizontal-tb',
  });

  if (encryptionInfo.softEncrypted) {
    warn(book, 'epub.encrypted', '检测到加密信息，但仅涉及字体等非正文资源（如字体混淆），不影响阅读，本产品也不保留字体。');
  }

  const resources = book.resources;
  const imgCache = new Map();

  // 封面
  let coverZipPath = null;
  for (const [, item] of opf.manifest) {
    if (item.properties.includes('cover-image')) { coverZipPath = resolveManifestHref(opfDir, item.href); break; }
  }
  if (!coverZipPath && opf.coverId) {
    const item = opf.manifest.get(opf.coverId);
    if (item && /^image\//.test(item.mediaType)) coverZipPath = resolveManifestHref(opfDir, item.href);
  }
  if (coverZipPath) {
    const info = manifestByHref.get(coverZipPath);
    book.cover = await registerImage(zip, resources, imgCache, coverZipPath, info && info.mediaType);
  }

  // 目录来源：EPUB3 nav 优先，否则回退 NCX
  let navRawTree = null, navDocPath = null;
  for (const [, item] of opf.manifest) {
    if (item.properties.includes('nav')) { navDocPath = resolveManifestHref(opfDir, item.href); break; }
  }
  if (navDocPath) {
    const navText = await readZipText(zip, navDocPath);
    if (navText) {
      const navTokens = tokenizeXml(navText);
      const navEls = findElements(navTokens, (t) => t === 'nav');
      let chosen = navEls.find((e) => /(^|\s)toc(\s|$)/i.test(e.attrs['epub:type'] || ''));
      if (!chosen) chosen = navEls[0];
      if (chosen) {
        const inner = navTokens.slice(chosen.startIdx + 1, chosen.endIdx - 1);
        const olEls = findElements(inner, (t) => t === 'ol');
        if (olEls.length) navRawTree = parseOlList(inner.slice(olEls[0].startIdx + 1, olEls[0].endIdx - 1));
      }
    }
  }
  if (!navRawTree) {
    let ncxDocPath = null;
    if (opf.spine.tocId) {
      const item = opf.manifest.get(opf.spine.tocId);
      if (item) ncxDocPath = resolveManifestHref(opfDir, item.href);
    }
    if (!ncxDocPath) {
      for (const [, item] of opf.manifest) {
        if (item.mediaType === 'application/x-dtbncx+xml') { ncxDocPath = resolveManifestHref(opfDir, item.href); break; }
      }
    }
    if (ncxDocPath) {
      const ncxText = await readZipText(zip, ncxDocPath);
      if (ncxText) {
        const ncxTokens = tokenizeXml(ncxText);
        const navMapEls = findElements(ncxTokens, (t) => localName(t) === 'navmap');
        if (navMapEls.length) {
          navRawTree = parseNavPoints(ncxTokens.slice(navMapEls[0].startIdx + 1, navMapEls[0].endIdx - 1));
          navDocPath = ncxDocPath;
        }
      }
    }
  }

  // spine → chapters（第一遍：抽取/登记，容错内部异常）
  const state = { noteCounter: 0, missingImages: [] };
  const docs = [];
  let idx = 0;
  try {
    for (const spItem of opf.spine.items) {
      idx += 1;
      const item = opf.manifest.get(spItem.idref);
      if (!item) { warn(book, 'epub.broken-spine-item', `spine 引用了不存在的清单项: ${spItem.idref}`); continue; }
      const docPath = resolveManifestHref(opfDir, item.href);
      const processed = await processSpineDoc(zip, docPath, resources, imgCache, manifestByHref, book, state);
      if (!processed) { warn(book, 'epub.broken-spine-item', `找不到内容文档: ${docPath}`); continue; }
      docs.push({ id: `c${docs.length + 1}`, ...processed });
      if (idx % 4 === 0) await tick();
    }
  } catch (e) {
    fail(`解析这本 EPUB 时出了问题，文件可能已损坏或不规范（${e.message}）。`);
  }

  if (!docs.length) fail('这本 EPUB 没有可读取的正文内容。');

  const hrefToChapterId = new Map();
  for (const d of docs) hrefToChapterId.set(d.docPath, d.id);

  book.nav = navRawTree ? convertNavTree(navRawTree, navDocPath, hrefToChapterId, 1) : [];
  if (!book.nav.length && docs.length > 1) warn(book, 'epub.no-toc', '未找到可用目录，已按 spine 顺序生成章节');

  const levelByChapter = new Map();
  collectChapterLevels(book.nav, levelByChapter);

  let di = 0;
  for (const d of docs) {
    di += 1;
    rewriteAnchors(d.tokens, d.docPath, hrefToChapterId);
    const html = sanitizeHtml(serializeTokens(d.tokens));
    const title = extractFirstHeading(html);
    const level = Math.min(3, Math.max(1, levelByChapter.get(d.id) || 1));
    book.chapters.push({ id: d.id, title, level, html });
    if (di % 6 === 0) await tick();
  }

  if (state.missingImages.length) {
    warn(book, 'epub.missing-image', `${state.missingImages.length} 处图片引用未在书内找到，已忽略`);
  }

  return book;
}

function titleFromFilename(name) {
  if (!name) return undefined;
  const base = String(name).split(/[/\\]/).pop().replace(/\.[^.]+$/, '');
  return base || undefined;
}
