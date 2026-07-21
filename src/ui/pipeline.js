/* ============================================================
 * src/ui/pipeline.js · 转换管线编排
 *
 * 从 app.js 拆出（2026-07-22）：DOM 交互留在 app.js，格式读写与整条
 * read → furigana(可选) → opencc → write → 落地 的编排放在这里。
 *
 * 依赖 reader/writer/transform（原生 ESM import），文案取自 copy.js；
 * 与页面交互的部分（建卡片、落地下载、按需加载引擎）经 app.js 反向 import
 * 注入——app.js 是入口模块，先完成求值；本模块顶层只定义闭包、不在求值期
 * 调用这些 app.js 函数，故双向 import 无 TDZ 风险（真正调用都发生在用户
 * 手势触发的运行时）。
 * ============================================================ */

import { read as readTxt } from '../readers/txt.js';
import { read as readMd } from '../readers/md.js';
import { read as readEpub } from '../readers/epub.js';
import { read as readDocx } from '../readers/docx.js';
import { read as readPdf } from '../readers/pdf.js';
import { read as readMobi } from '../readers/mobi.js';
import { read as readAzw3 } from '../readers/azw3.js';
import { readAll as readZipAll } from '../readers/zip.js';
import { write as writeEpub } from '../writers/epub.js';
import { write as writeTxt } from '../writers/txt.js';
import { write as writeKepub } from '../writers/kepub.js';
import { write as writeMobi } from '../writers/mobi.js';
import { write as writePdf } from '../writers/pdf.js';
import { opencc } from '../transforms/opencc.js';
import { furigana } from '../transforms/furigana.js';
import { COPY } from './copy.js';
import { makeCard, presentOutput, fmtSize, ensureMammoth, ensurePdf, ensureFurigana } from './app.js';

const tick = () => new Promise((r) => setTimeout(r, 0));

/* ---------- 格式分发表 ---------- */

/* integration_ui_03：mobi/azw3/azw 读入已接线，CONVERTIBLE_UNSUPPORTED 目前
 * 没有已知格式要落在这个分支——留着这个机制（而不是删掉）是为了给以后真正
 * 出现的"认识但暂不支持"格式一个专门的提示位，不与"完全不认识的文件"共用
 * COPY.unsupportedType。 */
const CONVERTIBLE_UNSUPPORTED = new Set([]);

/**
 * .azw 扩展名历史上含糊：老 Mobipocket 书与新版 KF8 书都可能用它。策略（本轮
 * 集成自行拍板，见 ResultReport）：先试 azw3 reader——它会明确检测并拒绝
 * "这其实是 MOBI6"（KF7）的文件，命中这种情况时纯粹是信号，不是真失败；
 * 于是再退回 mobi reader 试一次，这一步通常会成功。只有两个 reader 都失败
 * （文件确实损坏，或用了两者都不支持的排版）才把两边的人话错误一起报出来，
 * 不猜测哪个更"像"真正原因——两条都给用户，比丢掉一条更诚实（I4）。
 *
 * integration_ui_04：返回值从裸 book 改成 {book, via}，via 标记哪个 reader
 * 实际成功（'azw3'|'mobi'）——runPipeline 用它判断要不要追加
 * COPY.azwOutputSuggestion（只在源确实是 AZW3 时追加，老式 MOBI6 内容伪装
 * 成 .azw 时不适用这条"输出选 EPUB 就好"的建议）。
 */
async function readAzwAmbiguous(buf, opts) {
  try {
    const book = await readAzw3(buf, opts);
    return { book, via: 'azw3' };
  } catch (azw3Err) {
    try {
      const book = await readMobi(buf, opts);
      return { book, via: 'mobi' };
    } catch (mobiErr) {
      const azw3Msg = (azw3Err && azw3Err.message) || String(azw3Err);
      const mobiMsg = (mobiErr && mobiErr.message) || String(mobiErr);
      throw new Error(COPY.azwAmbiguousFailed(azw3Msg, mobiMsg));
    }
  }
}

/* READERS 里除 'azw' 外都直接返回裸 book；'azw' 返回 {book, via}——见
 * runPipeline 里按 ext === 'azw' 特殊解包的那几行，以及上面 readAzwAmbiguous
 * 的注释。docx/pdf 两项的第三个参数 ui 可选：传了就把加载阶段提示写进
 * 对应卡片的状态行（ensureMammoth/ensurePdf 的 onStatus），不传（比如以后
 * 有别的调用方不需要 UI 反馈）也不会报错。 */
const READERS = {
  txt: (buf, opts) => readTxt(buf, opts),
  md: (buf, opts) => readMd(buf, opts),
  epub: (buf, opts) => readEpub(buf, opts),
  docx: async (buf, opts, ui) => {
    await ensureMammoth(ui && ((msg) => { ui.msg.textContent = msg; }));
    return readDocx(buf, opts);
  },
  pdf: async (buf, opts, ui) => {
    await ensurePdf(ui && ((msg) => { ui.msg.textContent = msg; }));
    return readPdf(buf, opts);
  },
  mobi: (buf, opts) => readMobi(buf, opts),
  azw3: (buf, opts) => readAzw3(buf, opts),
  azw: (buf, opts) => readAzwAmbiguous(buf, opts),
};

const WRITERS = {
  epub: (book, opts, onProgress) => writeEpub(book, opts, onProgress),
  txt: (book, opts, onProgress) => writeTxt(book, opts, onProgress),
  kepub: (book, opts, onProgress) => writeKepub(book, opts, onProgress),
  mobi: (book, opts, onProgress) => writeMobi(book, opts, onProgress),
  pdf: (book, opts, onProgress) => writePdf(book, opts, onProgress),
};

function schemeTag(schemeValue) {
  return COPY.schemeTags[schemeValue] || '';
}

/**
 * integration_ui_04：从手写的 if/else（只覆盖 epub.encrypted / pdf.* /
 * mobi.* 三组共 7 个 code）改成查 ux-writer 交付的 COPY.warningByCode 表
 * （覆盖 src/readers/** 目前登记的全部 code，见 copy.js 该表头部注释）。
 * 查不到的 code 落 COPY.warningFallback，不会把裸的 code 字符串露给用户。
 *
 * 按"文案内容"去重，不是按 code 去重：多个 code 可能共享同一句话（如
 * mobi.no-chapters/mobi.flat-nav/mobi.filepos-unresolved 三个 code 在
 * warningByCode 里都指向同一句 MOBI_READ_LIMITED），去重的是用户会看到的
 * 句子，否则同一句话会在完成提示里重复堆好几遍。
 */
function warningNotes(book) {
  const seen = new Set();
  const notes = [];
  for (const w of book.warnings || []) {
    const text = COPY.warningByCode[w.code] || COPY.warningFallback;
    if (!seen.has(text)) { seen.add(text); notes.push(text); }
  }
  return notes;
}

/** meta.language 以 'ja' 开头（大小写不敏感）即判定为日语书（R4 验收条款原文）。 */
function isJaBook(book) {
  return typeof book?.meta?.language === 'string' && book.meta.language.toLowerCase().startsWith('ja');
}

/**
 * 日语书的繁简方案（docs/harness/BOUNDARIES.md §3「日语书的繁简转换」）：
 * 人类已确认（H，2026-07-21）为正式产品规则——日语书一律不做繁简转换。
 * 原因：opencc 是中文词典，会把约 490/2136 个常用日语汉字改写成分词词典不
 * 认识的字形，且与标音不总可交换。单点过滤：日语书一律按 'none' 处理，忽略
 * 全局 scheme 选择器的实际取值。注意这和「日语标音」是两回事——标音是给汉字
 * 注假名、走 applyFurigana；繁简是字形转换、走这里，两条正交、各自成一个选项。
 */
function effectiveSchemeFor(book, scheme) {
  return isJaBook(book) ? 'none' : scheme;
}

/**
 * 用户选定的排版方向（#writingDir）覆盖到 meta.writingMode。
 * 'keep' → 保持原书方向（不动）；其余值（'horizontal-tb'/'vertical-rl'）写入
 * meta.writingMode——ir.js 只认这两个值，epub/kepub/pdf writer 据此产出横排或
 * 竖排；txt/mobi 不带方向，写了也无副作用（writer 直接忽略 meta.writingMode）。
 * 纯函数：只浅拷 meta，不改动入参 book 的其它字段。
 */
function applyWritingMode(book, dir) {
  if (!dir || dir === 'keep') return book;
  return { ...book, meta: { ...book.meta, writingMode: dir } };
}

/** mobi 输出的两项已知能力降级（src/writers/mobi.js 头部注释："这两项都需要
 *  提示用户"）：ruby 注音剥离成纯文字、notes 降级为书末普通区块。这里做检测，
 *  文案落在 copy.js 的 mobiRubyDropped / mobiNotesAtEnd。 */
function hasRubyMarkup(book) {
  return Array.isArray(book.chapters) && book.chapters.some((c) => /<ruby[\s>]/i.test(c.html || ''));
}
function mobiOutputNotes(book) {
  const notes = [];
  if (book.notes instanceof Map && book.notes.size > 0) notes.push(COPY.mobiNotesAtEnd);
  if (hasRubyMarkup(book)) notes.push(COPY.mobiRubyDropped);
  return notes;
}

/**
 * 日语标音（顶层功能「日文标音」，与「繁简转换」并列二选一——BOUNDARIES §3）。
 * mode 由 readOptions() 给出：功能=日文标音 时取 #annot（'all' 全部汉字 /
 * 'rare' 只标生僻字），功能=繁简转换 时恒为 'off'。
 * 只在三者同时成立时才真正标注，缺一即原样返回：
 *   (a) mode 非 'off'（即当前功能是日文标音）；
 *   (b) 书是日语（isJaBook）；
 *   (c) 输出格式能承载 ruby（epub/kepub）——TXT 载不了、MOBI 会剥掉、PDF 走
 *       打印路径不额外保证，这三种即便选了标音也跳过，并留一句 note 说明。
 * 词典按需加载（~17MB，ensureFurigana 里做多源回退与阶段提示）；加载失败不
 * 阻断本书转换（R4 边界原文："词典加载失败给人话错误，不阻塞其他功能"）——
 * 吞掉错误变成一条 note 随完成状态展示，照常往下走 opencc → write，不 throw。
 * @param {string} mode 标注范围：'off'（不标） | 'all' | 'rare'
 * @returns {Promise<{book: object, notes: string[]}>}
 */
async function applyFurigana(ui, book, outputFormat, mode) {
  const notes = [];
  if (!mode || mode === 'off' || !isJaBook(book)) return { book, notes };
  if (outputFormat !== 'epub' && outputFormat !== 'kepub') {
    notes.push(COPY.furiganaFormatSkipped);
    return { book, notes };
  }
  try {
    const tokenizer = await ensureFurigana((msg) => { ui.msg.textContent = msg; });
    book = await furigana(book, { tokenizer, onlyRareKanji: mode === 'rare' });
  } catch (e) {
    notes.push((e && e.message) ? e.message : COPY.furiganaEngineError);
  }
  return { book, notes };
}

/* ---------- 编排：单本 / ZIP 多本 / 队列 ---------- */

/** 跑完 read → furigana(可选) → opencc → write → 下载链接，全流程不抛出
 *  （内部兜底为 ui.fail）。 */
async function runPipeline(ui, { ext, buf, filename, scheme, outputFormat, furiganaMode, writingDir, autoDownload }) {
  try {
    ui.msg.textContent = COPY.reading;
    const reader = READERS[ext];
    const rawResult = await reader(buf, { filename }, ui);
    // 'azw' 走 readAzwAmbiguous()，返回 {book, via}；其余扩展名的 reader
    // 直接返回裸 book。sourceVia 记录"这本书实际是从哪个格式读出来的"，
    // 用来判断要不要追加 azwOutputSuggestion（见下面 extraNotes 那段）。
    let book, sourceVia;
    if (ext === 'azw') {
      book = rawResult.book;
      sourceVia = rawResult.via;
    } else {
      book = rawResult;
      sourceVia = ext;
    }

    const furiganaResult = await applyFurigana(ui, book, outputFormat, furiganaMode);
    book = furiganaResult.book;

    const effectiveScheme = effectiveSchemeFor(book, scheme);
    book = await opencc(book, { scheme: effectiveScheme });
    book = applyWritingMode(book, writingDir);

    const onProgress = (p) => {
      ui.bar.style.width = Math.min(100, p * 100).toFixed(1) + '%';
      ui.msg.textContent = COPY.converting(Math.min(100, Math.round(p * 100)));
    };
    const writer = WRITERS[outputFormat];
    const outBytes = await writer(book, {}, onProgress);

    const extraNotes = warningNotes(book);
    extraNotes.push(...furiganaResult.notes);
    if (isJaBook(book) && scheme !== 'none') extraNotes.push(COPY.jaSchemeForced);
    // 源格式确实是 AZW3（.azw3 直接读，或 .azw 被 readAzwAmbiguous 嗅探判定
    // 为 azw3）时提示"输出选 EPUB 就好"——AZW3 输出本身没做（成本错配，见
    // REQUIREMENTS.md R3），选项里也不出现，这条建议是唯一的替代告知方式。
    if (sourceVia === 'azw3') extraNotes.push(COPY.azwOutputSuggestion);
    if (outputFormat === 'txt' && (book.resources.size > 0 || book.notes.size > 0)) {
      extraNotes.push(COPY.txtDropsMedia);
    }
    if (outputFormat === 'mobi') extraNotes.push(...mobiOutputNotes(book));

    const base = filename.replace(/\.[^.]+$/, '');
    const tag = schemeTag(effectiveScheme);
    const a = presentOutput(ui, { outBytes, outputFormat, baseName: base, tag, extraNotes });
    if (autoDownload && a) a.click();
  } catch (e) {
    ui.fail((e && e.message) ? e.message : COPY.convertFailed);
  }
}

async function processZip(file, { scheme, outputFormat, furiganaMode, writingDir }, autoDownload) {
  const ui = makeCard(file.name);
  ui.sizeEl.textContent = fmtSize(file.size);
  try {
    ui.msg.textContent = COPY.reading;
    const buf = new Uint8Array(await file.arrayBuffer());
    const results = await readZipAll(buf, { filename: file.name });
    if (!results.length) { ui.fail(COPY.zipEmpty); return; }

    if (results.length > 1) ui.msg.textContent = COPY.zipMultiple(results.length);
    await tick();

    for (const { name, book: rawBook } of results) {
      const subUi = results.length > 1 ? makeCard(`${file.name} › ${name}`) : ui;
      try {
        const furiganaResult = await applyFurigana(subUi, rawBook, outputFormat, furiganaMode);
        const book = furiganaResult.book;

        const effectiveScheme = effectiveSchemeFor(book, scheme);
        let converted = await opencc(book, { scheme: effectiveScheme });
        converted = applyWritingMode(converted, writingDir);

        const onProgress = (p) => {
          subUi.bar.style.width = Math.min(100, p * 100).toFixed(1) + '%';
          subUi.msg.textContent = COPY.converting(Math.min(100, Math.round(p * 100)));
        };
        const writer = WRITERS[outputFormat];
        const outBytes = await writer(converted, {}, onProgress);

        const extraNotes = warningNotes(converted);
        extraNotes.push(...furiganaResult.notes);
        if (isJaBook(converted) && scheme !== 'none') extraNotes.push(COPY.jaSchemeForced);
        if (outputFormat === 'txt' && (converted.resources.size > 0 || converted.notes.size > 0)) {
          extraNotes.push(COPY.txtDropsMedia);
        }
        if (outputFormat === 'mobi') extraNotes.push(...mobiOutputNotes(converted));

        const base = name.replace(/\.[^.]+$/, '');
        const tag = schemeTag(effectiveScheme);
        const a = presentOutput(subUi, { outBytes, outputFormat, baseName: base, tag, extraNotes });
        if (autoDownload && results.length === 1 && a) a.click();
      } catch (e) {
        subUi.fail((e && e.message) ? e.message : COPY.convertFailed);
      }
      await tick();
    }
  } catch (e) {
    ui.fail((e && e.message) ? e.message : COPY.readFailed);
  }
}

let queue = Promise.resolve();

async function processFile(file, opts, autoDownload) {
  const ext = (file.name.match(/\.([^.]+)$/) || [, ''])[1].toLowerCase();

  if (ext === 'zip') {
    await processZip(file, opts, autoDownload);
    return;
  }

  const ui = makeCard(file.name);
  ui.sizeEl.textContent = fmtSize(file.size);

  if (!READERS[ext]) {
    ui.fail(CONVERTIBLE_UNSUPPORTED.has(ext) ? COPY.unsupportedConvertible(ext) : COPY.unsupportedType);
    return;
  }

  const buf = new Uint8Array(await file.arrayBuffer());
  await runPipeline(ui, { ext, buf, filename: file.name, ...opts, autoDownload });
}

/** 把一个文件排进串行队列（原 startBtn 处理器里的 queue.then 逻辑，收敛到此，
 *  让 queue 与 processFile 都留在 pipeline 内；app.js 只按下按钮时逐个入队）。 */
export function enqueue(file, opts, autoDownload) {
  queue = queue.then(() => processFile(file, opts, autoDownload));
  return queue;
}
