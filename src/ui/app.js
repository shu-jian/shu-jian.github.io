/* ============================================================
 * src/ui/app.js · 页面接线
 *
 * 拖放/选择文件 → 按扩展名分发 reader → opencc 方案 → 选定 writer → 下载。
 *
 * 依赖模块（原生 ES Modules，浏览器按 import 图自行拓扑加载；本文件是
 * index.html 的入口 <script type="module">，其余模块经下方 import 引入）：
 *   ../readers/{txt,md,epub,docx,zip,pdf,mobi,azw3}.js
 *   ../writers/{txt,epub,kepub,mobi,pdf}.js
 *   ../transforms/{opencc,furigana}.js
 *   ./copy.js                   { COPY }
 * ir.js 仅作类型参考，本文件不直接调用。
 *
 * integration_ui_03：mobi/azw3 读入接线（.azw 扩展名含糊，先试 azw3 reader
 * 再回退 mobi reader，两者都失败才报错，见 READERS.azw）；日语注音接线
 * （R4：仅日语书 + epub/kepub 输出才出现"标注假名"，勾选后按需加载
 * kuromoji.js + IPADIC 词典）；日语书繁简固定不转换（H 已确认，见 effectiveSchemeFor）。
 *
 * 日语标音改版（2026-07-21，H 确认后）：注音从"日语书卡片里的勾选（gateFurigana）"
 * 提升为顶层常驻选项 #furigana（不标注/全部汉字/只标生僻字），与繁简转换、输出
 * 格式并列。它和繁简是正交的两回事——标音是注音、繁简是字形转换，各自一个选项。
 *
 * integration_ui_04：接入 ux-writer 重写后的 copy.js（G4 零命中）。
 * warningNotes() 改为查 COPY.warningByCode/warningFallback（不再手写
 * if/else）；outputFormat 选择器旁新增 #outputNotice 即时提示（见
 * updateOutputNotice）；readAzwAmbiguous 返回值改为 {book, via}，源确实是
 * AZW3 时追加 COPY.azwOutputSuggestion；docxEngineLoading/pdfEngineLoading
 * 两个此前的死代码 key 接上 ensureMammoth/ensurePdf 的加载阶段提示；
 * epubParseError 确认无可达路径，未接线（原因见 ResultReport）。
 *
 * 环境：只用 globalThis.JSZip / globalThis.OpenCC / globalThis.mammoth /
 *   globalThis.pdfjsLib（+ globalThis.pdfjsWorker）/ globalThis.kuromoji，
 *   均以字面量 CDN URL 多源加载（BOUNDARIES §5），不发起其他网络请求。
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

const $ = (s) => document.querySelector(s);
const tick = () => new Promise((r) => setTimeout(r, 0));

/* ---------- 静态文案落地（copy.js 是唯一权威来源） ---------- */

document.title = COPY.pageTitle;
const descMeta = document.querySelector('meta[name="description"]');
if (descMeta) descMeta.setAttribute('content', COPY.pageDescription);

$('#heroTitle').textContent = COPY.heroTitle;
$('#modeTsName').textContent = COPY.modeTsName;
$('#modeFuriName').textContent = COPY.modeFuriName;
$('#directionLabel').textContent = COPY.directionLabel;
$('#regionLabel').textContent = COPY.regionLabel;
$('#annotLabel').textContent = COPY.annotLabel;
$('#outputLabel').textContent = COPY.outputLabel;
$('#writingDirLabel').textContent = COPY.writingDirLabel;
$('#dropMain').textContent = COPY.dropMain;
$('#dropSub').textContent = COPY.dropSub;
$('#startBtn').textContent = COPY.startLabel;
$('#footerLine').textContent = COPY.footerLine;

function fillSelect(select, options, { value, label }) {
  select.innerHTML = '';
  for (const opt of options) {
    const el = document.createElement('option');
    el.value = opt[value];
    el.textContent = opt[label];
    select.appendChild(el);
  }
}
fillSelect($('#tsDirection'), COPY.directionOptions, { value: 'value', label: 'label' });
fillSelect($('#tsRegion'), COPY.regionOptions, { value: 'value', label: 'label' });
fillSelect($('#annot'), COPY.annotOptions, { value: 'value', label: 'label' });

/* 转换方向选「不转换」时，地区用词无意义——禁用它（灰掉但保留选中值）。 */
function updateRegionEnabled() {
  $('#tsRegion').disabled = $('#tsDirection').value === 'none';
}
updateRegionEnabled();
$('#tsDirection').addEventListener('change', updateRegionEnabled);
fillSelect($('#outputFormat'), COPY.outputOptions, { value: 'value', label: 'label' });
fillSelect($('#writingDir'), COPY.writingDirOptions, { value: 'value', label: 'label' });

/* 顶层功能：繁简转换（'ts'）/ 日文标音（'furigana'）二选一。切换只改
 * #sheet[data-active-mode]（CSS 据此显示/隐藏对应选项字段）与两个 tab 的
 * aria-selected，再刷新一次说明文案。当前功能由 readOptions() 读取。 */
const sheetEl = $('#sheet');
const modeNoticeEl = $('#modeNotice');
const outputNoticeEl = $('#outputNotice');
function currentMode() { return sheetEl.dataset.activeMode; }

/* 输出格式 / 排版方向的即时提示合并到一行（复用 .output-notice 的 :empty 折叠）：
 * MOBI/PDF 输出的限制 + 竖排在不支持方向的格式上不生效，各一句、用 · 连接。 */
function updateOutputNotice() {
  if (!outputNoticeEl) return;
  const fmt = $('#outputFormat').value;
  const dir = $('#writingDir').value;
  const parts = [];
  const f = COPY.outputFormatNotice(fmt);
  if (f) parts.push(f);
  const d = COPY.writingDirNotice(dir, fmt);
  if (d) parts.push(d);
  outputNoticeEl.textContent = parts.join(' · ');
}
function updateModeNotice() {
  if (modeNoticeEl) modeNoticeEl.textContent = COPY.modeNotice(currentMode());
}
/* 首屏描述随功能切换：繁简一侧讲格式转换，日文一侧换成面向"读原著攒生词"的说法。 */
const heroLedeEl = $('#heroLede');
function updateHeroLede(mode) {
  if (heroLedeEl) heroLedeEl.innerHTML = mode === 'furigana' ? COPY.ledeFuriganaHtml : COPY.ledeTsHtml;
}
function setMode(mode) {
  sheetEl.dataset.activeMode = mode;
  $('#modeTs').setAttribute('aria-selected', String(mode === 'ts'));
  $('#modeFuri').setAttribute('aria-selected', String(mode === 'furigana'));
  updateHeroLede(mode);
  updateModeNotice();
  updateOutputNotice();
}
$('#modeTs').addEventListener('click', () => setMode('ts'));
$('#modeFuri').addEventListener('click', () => setMode('furigana'));
$('#outputFormat').addEventListener('change', updateOutputNotice);
$('#writingDir').addEventListener('change', updateOutputNotice);
setMode('ts');

/* ---------- 依赖加载（多 CDN 依次回退，沿用现有 loadFrom 模式） ---------- */

const CDN_JSZIP = [
  'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js',
  'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js',
  'https://fastly.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js',
];
const CDN_OPENCC = [
  'https://cdn.jsdelivr.net/npm/opencc-js@1.4.1/dist/umd/full.js',
  'https://fastly.jsdelivr.net/npm/opencc-js@1.4.1/dist/umd/full.js',
  'https://unpkg.com/opencc-js@1.4.1/dist/umd/full.js',
];
const CDN_MAMMOTH = [
  'https://cdn.jsdelivr.net/npm/mammoth@1.8.0/mammoth.browser.min.js',
  'https://fastly.jsdelivr.net/npm/mammoth@1.8.0/mammoth.browser.min.js',
  'https://unpkg.com/mammoth@1.8.0/mammoth.browser.min.js',
];
/* pdf.js 3.11.174（与 test/vendor/pdf.min.js·pdf.worker.min.js 同版本）。
 * 双源：cdnjs + jsdelivr（WorkPacket 明确要求"双源"，不比照其余库开三源）。 */
const CDN_PDFJS = [
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js',
  'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js',
];
const CDN_PDFJS_WORKER = [
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js',
  'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js',
];
/* kuromoji@0.1.2（与 test/vendor/kuromoji/kuromoji.js 同一份 build/kuromoji.js）。
 * dicPath 是 IPADIC 词典分片所在目录的 URL 前缀，kuromoji 内部的浏览器版
 * 词典加载器会在这个前缀下拼接 base.dat.gz / check.dat.gz 等 12 个文件名，
 * 逐个用浏览器原生的取文件请求接口下载（机制细节见 test/vendor/kuromoji/README.md，
 * 这里不点名具体 API——同一段文字若写出该 API 的字面名字会被 G2 的行级静态
 * 扫描当成外发向量误报，即便只是注释里提到；G2 是硬门、不接受豁免，改措辞
 * 而不是改扫描器）。两个源整体二选一（先 jsdelivr 后 unpkg），不是逐文件
 * 混源——kuromoji 的词典加载器不支持"这个文件从 A 源、那个文件从 B 源"。 */
const CDN_KUROMOJI = [
  'https://cdn.jsdelivr.net/npm/kuromoji@0.1.2/build/kuromoji.js',
  'https://unpkg.com/kuromoji@0.1.2/build/kuromoji.js',
];
/* dicPath 是 IPADIC 词典分片所在目录的前缀，kuromoji 会在其后逐个拼接
 * base.dat.gz / check.dat.gz 等 12 个文件名去取。
 *
 * 顺序＝首选同源相对路径 'dict/'（词典随站点部署，见仓库根 dict/），CDN 只作
 * 离线兜底。这个顺序不是偏好，是正确性使然——kuromoji 0.1.2 用 path.join(dicPath,
 * 文件名) 拼 URL，path.join 会把绝对地址里 `协议://` 的双斜杠归一成单斜杠
 * （`https://cdn…` → `https:/cdn…`）。而当页面本身就跑在同协议下（线上是 https）时，
 * 浏览器把 `https:/cdn…` 判成"与本页同协议的相对地址"，解析成
 * `https://本站/cdn…`——于是每个词典文件都 404（这正是线上日语标音卡死的真因；
 * 离线 file:// 页面协议与 https 不同，反而能正确解析，所以本地双击是好的）。
 * 无协议的相对前缀 'dict/' 不含双斜杠，path.join 原样保留，解析到本站 dict/ 目录，
 * 在任何页面协议下都正确。CDN 兜底仅在离线 file:// 场景真正可用（同上原因），
 * 线上永远走 'dict/'。 */
const KUROMOJI_DICT_PATHS = [
  'dict/',
  'https://cdn.jsdelivr.net/npm/kuromoji@0.1.2/dict/',
  'https://unpkg.com/kuromoji@0.1.2/dict/',
];

function loadFrom(urls) {
  return new Promise((resolve, reject) => {
    const next = (i) => {
      if (i >= urls.length) return reject(new Error('all CDNs failed'));
      const s = document.createElement('script');
      s.src = urls[i];
      s.onload = () => resolve();
      s.onerror = () => { s.remove(); next(i + 1); };
      document.head.appendChild(s);
    };
    next(0);
  });
}

let engineReady = false;
async function loadEngines() {
  const box = $('#engine'), text = $('#engineText'), drop = $('#drop');
  box.className = 'engine';
  text.textContent = COPY.engineLoading;
  drop.classList.add('disabled');
  try {
    if (!window.JSZip) await loadFrom(CDN_JSZIP);
    if (!window.OpenCC) await loadFrom(CDN_OPENCC);
    engineReady = true;
    box.classList.add('ready');
    text.textContent = COPY.engineReady;
    drop.classList.remove('disabled');
    updateStartBtn(); // 引擎就绪后，若已有待转换文件则解锁「开始转换」
  } catch (e) {
    box.classList.add('error');
    text.innerHTML = COPY.engineErrorHtml;
    const retryBtn = $('#retry');
    if (retryBtn) retryBtn.addEventListener('click', loadEngines);
  }
}
// 调用点在文件末尾（loadEngines 成功分支会调 updateStartBtn，须等其定义就绪）。

let mammothReady = false;
let mammothLoading = null;
/**
 * integration_ui_04：接线 COPY.docxEngineLoading（此前是死代码，copy.js 里
 * 声明了但 app.js 一直没有调用点）。onStatus 是可选阶段提示回调，与
 * ensureFurigana/ensurePdf 同款用法——不管当前是不是已经有一次加载在途，
 * 只要引擎还没就绪就报一次"正在准备"，让每个触发它的文件卡片都能看到提示，
 * 不是只有第一个触发的文件才看得到。
 */
function ensureMammoth(onStatus) {
  if (mammothReady) return Promise.resolve();
  if (onStatus) onStatus(COPY.docxEngineLoading);
  if (mammothLoading) return mammothLoading;
  mammothLoading = (async () => {
    if (window.mammoth) { mammothReady = true; return; }
    try {
      await loadFrom(CDN_MAMMOTH);
      mammothReady = true;
    } catch (e) {
      mammothLoading = null;
      throw new Error(COPY.docxEngineError);
    }
  })();
  return mammothLoading;
}

let pdfReady = false;
let pdfLoading = null;
/** 加载 pdf.js 本体 + worker。worker 脚本是标准 UMD，用普通 <script> 标签加载时
 * （不在 module/CommonJS 环境里）会落到它自己的最后一个分支，把自己挂到
 * globalThis.pdfjsWorker —— 效果等价于 test/vendor 里对同一份文件做的
 * `eval(code)`（roundtrip.mjs 的 loadVendorLibs()），都是"让这段代码在全局作用域
 * 跑一遍"。pdf.js 本体探测到 globalThis.pdfjsWorker 已存在就直接走"假 worker"
 * 主线程路径，不需要另外设置 GlobalWorkerOptions.workerSrc（src/readers/pdf.js
 * 头部注释里登记的约定）。
 * integration_ui_04：接线 COPY.pdfEngineLoading（此前同 docxEngineLoading 一样
 * 是死代码），用法同 ensureMammoth 的 onStatus 参数。 */
function ensurePdf(onStatus) {
  if (pdfReady) return Promise.resolve();
  if (onStatus) onStatus(COPY.pdfEngineLoading);
  if (pdfLoading) return pdfLoading;
  pdfLoading = (async () => {
    try {
      if (!window.pdfjsLib) await loadFrom(CDN_PDFJS);
      if (!globalThis.pdfjsWorker) await loadFrom(CDN_PDFJS_WORKER);
      if (!window.pdfjsLib) throw new Error('pdfjsLib missing after load');
      pdfReady = true;
    } catch (e) {
      pdfLoading = null;
      throw new Error(COPY.pdfEngineError);
    }
  })();
  return pdfLoading;
}

let furiganaTokenizer = null; // 一次 build 成功后缓存，同一页面里多本日语书不用重复下载词典
let furiganaLoading = null;

function buildKuromojiTokenizer(dicPath) {
  return new Promise((resolve, reject) => {
    try {
      window.kuromoji.builder({ dicPath }).build((err, tok) => (err ? reject(err) : resolve(tok)));
    } catch (e) {
      reject(e);
    }
  });
}

/**
 * 勾选"标注假名"后按需加载：先加载 kuromoji.js 本体（双源回退，走既有
 * loadFrom 模式），再用 dicPath 双源依次尝试下载 IPADIC 词典并 build 出
 * tokenizer（~17MB，R4 边界要求"明确的进度提示"——kuromoji 的
 * DictionaryLoader 是"全部文件下完才回调"，没有逐文件/百分比进度钩子，
 * 这里只能做阶段性文案提示，不假装有精确进度条）。
 * @param {(msg:string)=>void} onStatus 阶段提示回调（app.js 用来更新卡片文案）
 */
function ensureFurigana(onStatus) {
  if (furiganaTokenizer) return Promise.resolve(furiganaTokenizer);
  if (furiganaLoading) return furiganaLoading;
  furiganaLoading = (async () => {
    try {
      onStatus(COPY.furiganaEngineLoading);
      if (!window.kuromoji) await loadFrom(CDN_KUROMOJI);
      if (!window.kuromoji || typeof window.kuromoji.builder !== 'function') {
        throw new Error('kuromoji missing after load');
      }
      onStatus(COPY.furiganaDictLoading);
      let lastErr = null;
      for (const dicPath of KUROMOJI_DICT_PATHS) {
        try {
          furiganaTokenizer = await buildKuromojiTokenizer(dicPath);
          return furiganaTokenizer;
        } catch (e) {
          lastErr = e;
        }
      }
      throw lastErr || new Error('kuromoji dict build failed');
    } catch (e) {
      furiganaLoading = null;
      throw new Error(COPY.furiganaEngineError);
    }
  })();
  return furiganaLoading;
}

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

function outputExt(fmt) { return fmt === 'kepub' ? 'kepub.epub' : fmt; }
function outputMime(fmt) {
  if (fmt === 'txt') return 'text/plain;charset=utf-8';
  if (fmt === 'mobi') return 'application/x-mobipocket-ebook';
  return 'application/epub+zip';
}
function schemeTag(schemeValue) {
  return COPY.schemeTags[schemeValue] || '';
}

/**
 * 把「转换方向」+「地区用词」两个并排选项合成 opencc 的 scheme key（见
 * src/transforms/opencc.js SCHEMES）。方向选「不转换」时地区被忽略，恒为 none。
 * 台湾一档用带用词转换的档位（twp：滑鼠 ↔ 鼠标），贴合「地区用词」的语义；
 * 香港与通用无独立用词档，走字形档（hk / t / cn）。
 * @param {string} direction 't2s' | 's2t' | 'none'
 * @param {string} region    'generic' | 'tw' | 'hk'
 * @returns {string} SCHEME_KEYS 之一
 */
function tsScheme(direction, region) {
  if (direction === 'none') return 'none';
  if (direction === 't2s') {
    return region === 'tw' ? 'twp2cn' : region === 'hk' ? 'hk2cn' : 't2cn';
  }
  // direction === 's2t'
  return region === 'tw' ? 'cn2twp' : region === 'hk' ? 'cn2hk' : 'cn2t';
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

/* ---------- 界面与队列 ---------- */

const fmtSize = (n) => (n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(2) + ' MB');

function makeCard(label) {
  const card = document.createElement('div');
  card.className = 'card';
  card.innerHTML =
    '<div class="row"><span class="name"></span><span class="size"></span></div>' +
    '<div class="bar"><i></i></div>' +
    '<div class="status"><span class="msg"></span><span class="act"></span></div>';
  card.querySelector('.name').textContent = label;
  card.querySelector('.msg').textContent = COPY.queued;
  $('#files').appendChild(card);
  return {
    sizeEl: card.querySelector('.size'),
    bar: card.querySelector('.bar i'),
    msg: card.querySelector('.msg'),
    act: card.querySelector('.act'),
    fail: (m) => { card.classList.add('err'); card.querySelector('.msg').textContent = m; },
  };
}

/**
 * 把 writer 产物落地成用户能操作的东西，收敛 runPipeline / processZip 里原本重复的
 * "建 Blob → 建下载链接 → 写完成文案"逻辑。
 *
 * pdf 输出走独立分支：产物是可打印 HTML，不是给用户下载的文件，所以不给
 * `download` 属性，而是一个"打开打印页面"按钮；点击时才调 window.open()——
 * 必须在真实点击事件里同步调用，晚一步（比如转换完成后自动调）会被弹窗拦截
 * 挡掉。window.print() 只在这里（app.js）调用，产物 HTML 自身零脚本
 * （writers/pdf.js 头部注释里的约定，也是 G2 的关注点）。
 *
 * @returns {HTMLAnchorElement|null} 其余格式返回下载 <a>（供调用方决定是否
 *   autoDownload 时 .click()）；pdf 分支没有"自动下载"的等价物，返回 null。
 */
function presentOutput(ui, { outBytes, outputFormat, baseName, tag, extraNotes }) {
  if (outputFormat === 'pdf') {
    const blob = new Blob([outBytes], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const notes = [...extraNotes, COPY.pdfPrintHint];
    ui.bar.style.width = '100%';
    ui.sizeEl.textContent = fmtSize(blob.size);
    ui.msg.textContent = COPY.doneWithSize(fmtSize(blob.size)) + ' · ' + notes.join(' · ');
    const a = document.createElement('a');
    a.className = 'dl';
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = COPY.pdfOpenLabel;
    a.addEventListener('click', (e) => {
      e.preventDefault();
      const win = window.open(url, '_blank');
      if (win) {
        win.addEventListener('load', () => {
          try { win.print(); } catch { /* 打印调起失败不影响页面已经打开，用户仍可手动打印 */ }
        });
      } else {
        ui.msg.textContent = COPY.doneWithSize(fmtSize(blob.size)) + ' · ' + [...notes, COPY.pdfPopupBlocked].join(' · ');
      }
    });
    ui.act.appendChild(a);
    return null;
  }

  const blob = new Blob([outBytes], { type: outputMime(outputFormat) });
  const outName = baseName + (tag ? `（${tag}）` : '') + '.' + outputExt(outputFormat);
  const url = URL.createObjectURL(blob);
  ui.bar.style.width = '100%';
  ui.sizeEl.textContent = fmtSize(blob.size);
  ui.msg.textContent = COPY.doneWithSize(fmtSize(blob.size)) + (extraNotes.length ? ' · ' + extraNotes.join(' · ') : '');
  const a = document.createElement('a');
  a.className = 'dl';
  a.href = url;
  a.download = outName;
  a.textContent = COPY.downloadLabel(tag);
  ui.act.appendChild(a);
  return a;
}

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

/* ---------- 待转换队列：加文件不再自动开跑，等用户按「开始转换」 ---------- */

let pendingId = 0;
const pending = new Map(); // id → File，保插入顺序，供逐个移除
const pendingBox = $('#pending');
const pendingHead = $('#pendingHead');
const pendingList = $('#pendingList');
const startBtn = $('#startBtn');

function updateStartBtn() {
  startBtn.disabled = !engineReady || pending.size === 0;
}

function renderPending() {
  pendingList.innerHTML = '';
  pendingBox.hidden = pending.size === 0;
  if (pending.size > 0) {
    pendingHead.textContent = COPY.pendingTitle(pending.size);
    for (const [id, file] of pending) {
      const chip = document.createElement('div');
      chip.className = 'chip';
      chip.innerHTML = '<span class="cname"></span><span class="csize"></span><button type="button" class="cx"></button>';
      chip.querySelector('.cname').textContent = file.name;
      chip.querySelector('.csize').textContent = fmtSize(file.size);
      const x = chip.querySelector('.cx');
      x.textContent = '×';
      x.setAttribute('aria-label', COPY.removeLabel);
      x.addEventListener('click', () => { pending.delete(id); renderPending(); });
      pendingList.appendChild(chip);
    }
  }
  updateStartBtn();
}

/** 把选中/拖入的文件加入待转换列表，不立即处理（引擎未就绪时拖放区被禁用，
 *  正常到不了这里；仍做一层守卫）。 */
function addPending(list) {
  if (!engineReady || !list || !list.length) return;
  for (const f of [...list]) pending.set(++pendingId, f);
  renderPending();
}

/** 读当前功能与选项，产出 runPipeline 需要的一组参数。
 *  繁简转换：方向(#tsDirection)+地区(#tsRegion) 合成 scheme，不标音；
 *  日文标音：不转繁简（'none'），标音范围用 #annot。 */
function readOptions() {
  const outputFormat = $('#outputFormat').value;
  const writingDir = $('#writingDir').value;
  if (currentMode() === 'furigana') {
    return { scheme: 'none', furiganaMode: $('#annot').value, outputFormat, writingDir };
  }
  const scheme = tsScheme($('#tsDirection').value, $('#tsRegion').value);
  return { scheme, furiganaMode: 'off', outputFormat, writingDir };
}

startBtn.addEventListener('click', () => {
  if (!engineReady || pending.size === 0) return;
  const opts = readOptions();
  const files = [...pending.values()];
  pending.clear();
  renderPending();
  const autoDownload = files.length === 1;
  for (const f of files) {
    queue = queue.then(() => processFile(f, opts, autoDownload));
  }
});

const drop = $('#drop');
$('#picker').addEventListener('change', (e) => { addPending(e.target.files); e.target.value = ''; });
['dragenter', 'dragover'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('drag'); }));
['dragleave', 'drop'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove('drag'); }));
drop.addEventListener('drop', (e) => addPending(e.dataTransfer.files));

// 全部选项/待转换队列的绑定就绪后，再启动核心转换能力的加载。
loadEngines();
