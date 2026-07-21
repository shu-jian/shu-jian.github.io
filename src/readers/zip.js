/* ============================================================
 * src/readers/zip.js · ZIP 压缩包 → Book IR（分发器）
 *
 * ZIP 本身不是一种书籍格式，是容器。这个 reader 不产出书籍内容本身，
 * 而是解包后按内含文件的扩展名分发给对应的兄弟 reader（黑盒调用它们的
 * read()，不复制其解析逻辑），拿到它们产出的 Book。
 *
 * ---- 单本 / 多本契约（IR 只描述"一本书"，没有"多本书"的概念，
 *      这一点由本模块自行决定如何对外暴露，见下）----
 *
 *   export async function read(buf, opts) -> Book
 *     通用单本契约（roundtrip.mjs、以及任何期待"一个文件进来一本书出去"
 *     的调用点用这个）。
 *       - zip 内找到 1 本可识别的书 → 返回它。
 *       - zip 内找到 0 本 → 抛出人话错误。
 *       - zip 内找到 >1 本 → 按内含条目名排序，返回第一本，并在它的
 *         warnings 里记 `zip.multiple-books`、列出被忽略的条目名——
 *         不静默丢书（I4）。多本场景的正确用法是下面的 readAll()。
 *
 *   export async function readAll(buf, opts) -> Array<{ name, book }>
 *     "逐本处理"的真正入口（REQUIREMENTS.md R1 对 zip 的验收口径）。
 *     zip 内每个能识别的书籍文件各自独立解析成一本 Book。UI 层拿到这个
 *     列表后应该把每一本当独立文件走完整处理流程，而不是合并成一本。
 *     read() 只是它在"只要一本"场景下的收窄视图。
 *
 * ---- 支持的内含格式 ----
 *   当前只分发到已经落地的兄弟 reader：.txt / .md / .epub。
 *   .docx / .mobi / .azw3 / .pdf 已规划但兄弟 reader 还没落地，遇到时
 *   记 `zip.unsupported`（与"根本不是书"的文件区分对待，不静默）。
 *   这个映射表将来随对应 reader 落地需要手动补（见文件底部 DISPATCH）。
 *
 * ---- 嵌套 zip：只展开一层（REQUIREMENTS.md R1 zip 行）----
 *   外层 zip 里的 zip 会被当作子容器整体展开、并入候选列表；子 zip 里
 *   如果还有 zip，不再展开，记 `zip.nested-too-deep`。
 *
 * ---- 非书文件 ----
 *   压缩软件/操作系统自动生成的垃圾条目（__MACOSX/、.DS_Store、
 *   Thumbs.db、AppleDouble 的 ._ 前缀文件）彻底静默，不计入任何 warning
 *   ——这些跟"用户塞进来的书"无关。
 *   其余识别不了的文件（图片、样式表等）会被跳过，但为了不用几十条
 *   warning 淹没用户，这里把它们**聚合成一条** `zip.skipped`（BOOK-IR.md
 *   §4 zip 行要求"记录跳过的文件"，聚合仍满足"记录"，但不逐条打扰）。
 *
 * ---- 已知缺口 ----
 *   zip 内 .md 文件引用同目录相对路径图片时，本 reader 会把同目录的
 *   图片文件读出来，通过 opts.siblingAssets（Map<文件名, Uint8Array>）
 *   传给 md reader —— 但 md reader 当前的 opts 契约不消费这个字段
 *   （STATUS.md 已登记的已知缺口），所以图片仍会按 md reader 自己的
 *   降级路径变成 alt 文字 + warning。这里只是把管道先接好，等 md reader
 *   补上消费端就能直接工作，不需要再改 zip.js。
 *
 * 文件名编码：zip 条目名可能来自没打 UTF-8 标记位的旧压缩包（GBK/Big5）。
 *   通过 JSZip 的 decodeFileName 钩子逐条尝试 UTF-8 → GB18030 → Big5，
 *   全部失败时退回宽容 UTF-8 解码（可能出现替换字符），不让整包解析失败。
 *
 * 环境中立：只假定 globalThis.JSZip 存在，不加载任何外部脚本、不发任何
 *   网络请求。大包处理中定期 await 一次 tick，避免占死主线程。
 * ============================================================ */

import { warn } from '../ir.js';
import { read as readTxt } from './txt.js';
import { read as readMd } from './md.js';
import { read as readEpub } from './epub.js';

// 命名刻意加 zip 前缀：build.mjs 把所有模块拼进同一个 <script> 作用域，
// 剥掉 export 后，重名的顶层 const/function 会互相冲突（函数声明静默
// 覆盖、const 直接报重复声明的 SyntaxError）。这里避免再制造新的重名。
const zipTick = () => new Promise((resolve) => setTimeout(resolve, 0));

function zipFail(message) {
  throw new Error(message);
}

/** 已经落地、可以分发的兄弟 reader */
const DISPATCH = {
  '.txt': readTxt,
  '.md': readMd,
  '.epub': readEpub,
};

/** 已规划但兄弟 reader 还没落地的格式：识别出来但暂不能处理，与"非书文件"区分 */
const PLANNED_NOT_READY = new Set(['.docx', '.mobi', '.azw3', '.pdf']);

/** 视觉上像图片的扩展名，用于给 md 兄弟文件收集同目录图片 */
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.bmp']);

function extOf(name) {
  const m = /\.[^./\\]+$/.exec(name);
  return m ? m[0].toLowerCase() : '';
}

function baseName(name) {
  const parts = String(name).split('/');
  return parts[parts.length - 1];
}

function dirOf(name) {
  const i = String(name).lastIndexOf('/');
  return i === -1 ? '' : name.slice(0, i + 1);
}

/** 压缩软件/操作系统自动生成的垃圾条目：跟用户塞进来的书无关，彻底静默 */
function isJunkEntry(name) {
  if (name.startsWith('__MACOSX/')) return true;
  const b = baseName(name);
  if (b === '.DS_Store' || b === 'Thumbs.db' || b === 'desktop.ini') return true;
  if (b.startsWith('._')) return true; // AppleDouble 资源叉文件
  return false;
}

/* ---------- 条目名编码嗅探 ---------- */

/**
 * JSZip 的 decodeFileName 钩子：不管有没有打 UTF-8 标记位都会调用。
 * 现代 zip 的条目名多数就是合法 UTF-8，严格解码会直接成功；老旧的中文
 * 压缩包用的是 GBK/Big5，严格 UTF-8 解码会先失败，再依次尝试这两种。
 */
function decodeEntryName(bytes) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch { /* 不是合法 UTF-8，往下试中文遗留编码 */ }
  for (const enc of ['gb18030', 'big5']) {
    try {
      return new TextDecoder(enc, { fatal: true }).decode(bytes);
    } catch { /* 试下一种 */ }
  }
  // 全部严格解码失败：宽容解码兜底，允许出现替换字符，但不让整包解析崩掉
  return new TextDecoder('utf-8').decode(bytes);
}

async function loadZip(buf) {
  const JSZip = globalThis.JSZip;
  if (!JSZip) zipFail('压缩包解析组件未加载，请刷新页面重试。');
  try {
    return await JSZip.loadAsync(buf, { decodeFileName: decodeEntryName });
  } catch {
    zipFail('这似乎不是有效的 ZIP 压缩包，或文件已损坏。');
  }
}

/**
 * 展开一层 zip，把内含条目分类。
 * @param {*} zip JSZip 实例
 * @param {number} depth 当前嵌套深度（顶层=0）
 * @returns {Promise<{candidates: Array, unsupported: string[], skipped: string[], tooDeep: string[]}>}
 */
async function classify(zip, depth) {
  const candidates = [];   // {name, ext, entry, zipRef}
  const unsupported = [];  // 已规划但 reader 未落地的格式
  const skipped = [];      // 既不是书也不是已规划格式；或处理失败的条目
  const tooDeep = [];      // 嵌套 zip 超过一层

  const names = Object.keys(zip.files);
  for (let i = 0; i < names.length; i++) {
    if (i % 8 === 0) await zipTick();
    const name = names[i];
    const entry = zip.files[name];
    if (entry.dir) continue;
    if (isJunkEntry(name)) continue;

    const ext = extOf(name);

    if (ext === '.zip') {
      if (depth >= 1) { tooDeep.push(name); continue; }
      try {
        const innerBytes = await entry.async('uint8array');
        const innerZip = await globalThis.JSZip.loadAsync(innerBytes, { decodeFileName: decodeEntryName });
        const inner = await classify(innerZip, depth + 1);
        for (const c of inner.candidates) candidates.push({ ...c, name: `${name}/${c.name}` });
        for (const n of inner.unsupported) unsupported.push(`${name}/${n}`);
        for (const n of inner.skipped) skipped.push(`${name}/${n}`);
        for (const n of inner.tooDeep) tooDeep.push(`${name}/${n}`);
      } catch {
        skipped.push(`${name}（内层压缩包已损坏）`);
      }
      continue;
    }

    if (DISPATCH[ext]) { candidates.push({ name, ext, entry, zipRef: zip }); continue; }
    if (PLANNED_NOT_READY.has(ext)) { unsupported.push(name); continue; }
    skipped.push(name);
  }

  return { candidates, unsupported, skipped, tooDeep };
}

/**
 * 给 md 候选收集同目录下的图片兄弟文件，best-effort，见文件头「已知缺口」。
 * 同时把消耗掉的条目原始名一并返回——调用方要把它们从"跳过"清单里摘掉，
 * 不然明明被用上的图片会被 warning 误报成"已跳过"，违反 warnings 的诚实义务。
 */
async function collectSiblingAssets(zipRef, entryPath) {
  const dir = dirOf(entryPath);
  const map = new Map();
  const consumedRawNames = [];
  for (const name of Object.keys(zipRef.files)) {
    if (name === entryPath) continue;
    const f = zipRef.files[name];
    if (f.dir || isJunkEntry(name)) continue;
    if (!name.startsWith(dir)) continue;
    if (name.slice(dir.length).includes('/')) continue; // 只取同级，不递归子文件夹
    if (!IMAGE_EXT.has(extOf(name))) continue;
    map.set(baseName(name), await f.async('uint8array'));
    consumedRawNames.push(name);
  }
  return { map, consumedRawNames };
}

function truncatedList(list, max = 5) {
  const shown = list.slice(0, max).join('、');
  const more = list.length > max ? ` 等共 ${list.length} 个` : '';
  return `${shown}${more}`;
}

/**
 * 解包并把内含书籍文件逐一分发给兄弟 reader。核心实现，read()/readAll() 都基于它。
 * @param {Uint8Array} buf
 * @param {{filename?: string}} [opts]
 * @returns {Promise<Array<{name: string, book: object}>>}
 */
async function collectBooks(buf, opts = {}) {
  const zip = await loadZip(buf);
  const { candidates, unsupported, skipped, tooDeep } = await classify(zip, 0);

  candidates.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  if (candidates.length === 0) {
    if (unsupported.length) {
      zipFail(`这个压缩包里的书籍格式暂不支持解析（${truncatedList(unsupported, 3)}），试试先转换成 txt / md / epub。`);
    }
    zipFail('这个压缩包里没有找到可识别的书籍文件（支持 .txt / .md / .epub）。');
  }

  const results = [];
  const consumedDisplayNames = new Set(); // 被 siblingAssets 用掉的条目，不该再算"跳过"
  for (let i = 0; i < candidates.length; i++) {
    if (i % 3 === 0) await zipTick();
    const c = candidates[i];
    try {
      const bytes = await c.entry.async('uint8array');
      const readerOpts = { filename: baseName(c.name) };
      if (c.ext === '.md') {
        const { map: siblingAssets, consumedRawNames } = await collectSiblingAssets(c.zipRef, c.entry.name);
        if (siblingAssets.size) {
          readerOpts.siblingAssets = siblingAssets;
          // c.name 相对 c.entry.name 的前缀，就是这层（可能嵌套一层）zip 的展示名前缀
          const prefix = c.name.slice(0, c.name.length - c.entry.name.length);
          for (const raw of consumedRawNames) consumedDisplayNames.add(prefix + raw);
        }
      }
      const book = await DISPATCH[c.ext](bytes, readerOpts);
      results.push({ name: c.name, book });
    } catch (e) {
      skipped.push(`${c.name}（解析失败：${e.message}）`);
    }
  }

  if (results.length === 0) {
    zipFail('这个压缩包里的书籍文件都无法正常解析。');
  }

  const trulySkipped = skipped.filter((s) => !consumedDisplayNames.has(s));

  // 容器级信息追加到每一本产出的书上（BOOK-IR.md §4 zip 行的 warning 义务）
  for (const r of results) {
    if (trulySkipped.length) warn(r.book, 'zip.skipped', `已跳过非书籍文件：${truncatedList(trulySkipped)}`);
    if (unsupported.length) warn(r.book, 'zip.unsupported', `压缩包内以下文件的格式暂不支持解析：${truncatedList(unsupported)}`);
    if (tooDeep.length) warn(r.book, 'zip.nested-too-deep', `压缩包嵌套超过一层，以下内容未展开：${truncatedList(tooDeep)}`);
  }

  return results;
}

/**
 * "逐本处理"的主入口：zip 内每个可识别的书籍文件各自独立解析成一本 Book。
 * @param {Uint8Array} buf
 * @param {{filename?: string}} [opts]
 * @returns {Promise<Array<{name: string, book: object}>>}
 */
export async function readAll(buf, opts = {}) {
  return collectBooks(buf, opts);
}

/**
 * 单本契约：见文件头说明。zip 内多本书时返回排序后的第一本，并记 warning。
 * @param {Uint8Array} buf
 * @param {{filename?: string}} [opts]
 * @returns {Promise<object>} Book
 */
export async function read(buf, opts = {}) {
  const results = await collectBooks(buf, opts);
  const [first, ...rest] = results;
  if (rest.length) {
    const names = rest.map((r) => r.name);
    warn(first.book, 'zip.multiple-books', `压缩包里有多本书，这里只处理了「${first.name}」，另外未处理：${truncatedList(names)}`);
  }
  return first.book;
}
