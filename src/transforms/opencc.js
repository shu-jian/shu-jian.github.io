/* ============================================================
 * src/transforms/opencc.js · 繁简转换（Book IR → Book IR）
 *
 * 契约：docs/harness/BOOK-IR.md §6（transforms 通用契约）。
 *   1. 结构不变：chapters.length / 每章 level / nav 树形状 / resources 键集合，
 *      进出完全一致——本文件只改文本内容，不碰形状。
 *   2. 可交换：不转换 <rt> 内的文本（假名注音），为的是与 furigana transform
 *      的执行顺序无关（先繁简后注音、先注音后繁简，结果一致）。
 *   3. 幂等对本 transform 不适用（反复转换同一方案是安全的无害操作，
 *      OpenCC 的字典本身是幂等的：cn 字已经是 cn，再转一次还是 cn）。
 *   4. 纯函数：不修改入参 book，返回新对象。
 *
 * 词级转换完全交给 opencc-js（globalThis.OpenCC，由 vendor / CDN 注入）。
 * 本文件不自建任何字符映射表（CLAUDE.md §7：繁简转换是词级的，不是字级的）。
 *
 * 环境中立：不碰 DOM。HTML 文本节点的定位靠简单的“标签 vs 文本”交替切分，
 *   而不是完整 tokenizer——这依赖一个前提：chapter.html / note.html 在进入
 *   IR 时已经过 sanitizeHtml（BOOK-IR §3 白名单子集），标签结构是规整的
 *   （不会有未闭合标签、注释、CDATA 等花活）。这个前提由 reader 保证。
 * ============================================================ */

/**
 * 六种繁简转换方案，命名与现有 index.html 的 <select> 对齐
 * （from/to 是 opencc-js 自己的地区代码：t/cn/hk/tw/twp）。
 * 「不转换」不在这张表里——它是恒等变换，用 scheme=null/'none' 表达。
 */
export const SCHEMES = Object.freeze({
  t2cn: Object.freeze({ from: 't', to: 'cn' }), // 繁体 → 简体（通用）
  tw2cn: Object.freeze({ from: 'tw', to: 'cn' }), // 台湾正体 → 简体（仅字形）
  twp2cn: Object.freeze({ from: 'twp', to: 'cn' }), // 台湾正体 → 简体（含用词转换，如 滑鼠→鼠标）
  hk2cn: Object.freeze({ from: 'hk', to: 'cn' }), // 香港繁体 → 简体
  cn2t: Object.freeze({ from: 'cn', to: 't' }), // 简体 → 繁体（通用）
  cn2tw: Object.freeze({ from: 'cn', to: 'tw' }), // 简体 → 台湾正体（仅字形）
  cn2twp: Object.freeze({ from: 'cn', to: 'twp' }), // 简体 → 台湾正体（含用词转换，如 鼠标→滑鼠）
  cn2hk: Object.freeze({ from: 'cn', to: 'hk' }), // 简体 → 香港繁体
});

/** 合法的 scheme 取值（含 'none'），供调用方/UI 校验用户输入。 */
export const SCHEME_KEYS = Object.freeze(['none', ...Object.keys(SCHEMES)]);

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/* Converter 按 from|to 缓存：opencc-js 构建 Trie 有成本（词库以 MB 计），
 * 同一 scheme 在一次批量转换（多本书）里应当只建一次。 */
const converterCache = new Map();

function getConverter(from, to) {
  const key = `${from}|${to}`;
  const cached = converterCache.get(key);
  if (cached) return cached;
  const OC = globalThis.OpenCC;
  if (!OC || typeof OC.Converter !== 'function') {
    throw new Error('OpenCC 转换引擎未就绪：globalThis.OpenCC 不存在（vendor 未注入）');
  }
  const convert = OC.Converter({ from, to });
  converterCache.set(key, convert);
  return convert;
}

/* ---------- HTML 感知的文本转换 ---------- */

// 交替切分：捕获组保留分隔符本身，结果形如 [text, tag, text, tag, ..., text]
const TAG_SPLIT_RE = /(<[^>]*>)/g;
const TAG_NAME_RE = /^<\/?\s*([a-zA-Z][a-zA-Z0-9]*)/;

/**
 * 转换一段受限 HTML 子集里的文本节点，标签（名字、属性）原样保留。
 * <rt>…</rt> 内部（假名注音）跳过，不转换——这是与 furigana 保持可交换的关键。
 * 不做实体解码/转义：sanitizeHtml 只把 & < > 转义为实体，真实的中日文字符
 * 始终是字面 Unicode 字符，OpenCC 的字典只匹配 CJK 字符序列，不会误碰
 * "&amp;" 这类 ASCII 实体串，所以直接对已转义文本调用 convert() 是安全的，
 * 也天然满足"不破坏实体"的要求（无需额外解码/重新转义这一步）。
 */
function convertHtmlText(html, convert) {
  if (!html) return html;
  const parts = html.split(TAG_SPLIT_RE);
  let rtDepth = 0;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (!part) continue;
    if (part.charCodeAt(0) === 60 /* '<' */) {
      const m = TAG_NAME_RE.exec(part);
      const tag = m ? m[1].toLowerCase() : '';
      if (tag === 'rt') {
        if (part[1] === '/') rtDepth = Math.max(0, rtDepth - 1);
        else rtDepth += 1;
      }
      continue;
    }
    if (rtDepth > 0) continue;
    parts[i] = convert(part);
  }
  return parts.join('');
}

/* ---------- 纯函数式深拷贝（只拷贝会被改写的层级） ---------- */

function cloneNav(list) {
  return (list || []).map((n) => ({ ...n, children: cloneNav(n.children) }));
}

/**
 * 拷贝一本 Book：新建会被本 transform 改写的容器（meta / chapters / nav /
 * notes / warnings），resources 里的二进制数据不转换、不改动，Map 做浅拷贝、
 * 复用同一批 Resource 对象——大书往往带很多图片，没必要为一次文本转换
 * 把图片字节再复制一遍。
 */
function cloneBook(book) {
  return {
    meta: { ...book.meta },
    cover: book.cover,
    resources: new Map(book.resources),
    chapters: book.chapters.map((ch) => ({ ...ch })),
    nav: cloneNav(book.nav),
    notes: new Map(Array.from(book.notes, ([id, n]) => [id, { ...n }])),
    warnings: book.warnings.map((w) => ({ ...w })),
  };
}

/**
 * Book IR → Book IR 的繁简转换。纯函数，不修改入参。
 *
 * @param {import('../ir.js').Book} book
 * @param {{scheme?: string|null}} [opts]  scheme 取值见 SCHEME_KEYS；
 *   缺省 / null / 'none' 均视为「不转换」（合法的恒等变换）。
 * @returns {Promise<import('../ir.js').Book>}
 */
export async function opencc(book, opts = {}) {
  const schemeKey = opts && opts.scheme;

  if (!schemeKey || schemeKey === 'none') {
    // 恒等变换：仍然返回新对象，保持"纯函数"契约，但不做任何文本改写。
    return cloneBook(book);
  }

  const def = SCHEMES[schemeKey];
  if (!def) throw new Error(`未知的繁简转换方案: ${schemeKey}`);
  const convert = getConverter(def.from, def.to);

  const out = cloneBook(book);

  // meta：仅改写面向读者的文本内容（书名/作者/出版方/简介）。
  // meta.language / identifier / date / writingMode 是结构性字段，不属于
  // "文本层"，本 transform 不改写；理由与已知限制见 ResultReport.learned。
  if (out.meta.title != null) out.meta.title = convert(out.meta.title);
  if (out.meta.author != null) out.meta.author = convert(out.meta.author);
  if (out.meta.publisher != null) out.meta.publisher = convert(out.meta.publisher);
  if (out.meta.description != null) out.meta.description = convert(out.meta.description);

  // 章节：标题 + html 文本节点。大书分块——每章处理完让出主线程一次。
  for (const ch of out.chapters) {
    if (ch.title != null) ch.title = convert(ch.title);
    ch.html = convertHtmlText(ch.html, convert);
    await tick();
  }

  // 目录树标题
  const convertNavTitles = (list) => {
    for (const n of list) {
      if (n.title != null) n.title = convert(n.title);
      if (n.children && n.children.length) convertNavTitles(n.children);
    }
  };
  convertNavTitles(out.nav);

  // 脚注/尾注：与章节同为 HTML 片段，同样只动文本节点。
  let noteCount = 0;
  for (const [id, note] of out.notes) {
    out.notes.set(id, { ...note, html: convertHtmlText(note.html, convert) });
    noteCount += 1;
    if (noteCount % 20 === 0) await tick();
  }

  return out;
}
