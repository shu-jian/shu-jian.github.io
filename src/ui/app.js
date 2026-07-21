/* ============================================================
 * src/ui/app.js · 页面接线
 *
 * 拖放/选择文件 → 按扩展名分发 reader → opencc 方案 → 选定 writer → 下载。
 *
 * 本文件是 index.html 的入口 <script type="module">，只管页面接线（DOM、文案
 * 落地、模式切换、引擎按需加载、卡片/队列渲染、下载落地）。格式读写与整条转换
 * 编排已拆到 ./pipeline.js。
 * 依赖：./copy.js（{COPY} 文案）、./pipeline.js（{enqueue} 入队转换）。
 * pipeline.js 反向 import 本文件导出的 makeCard/presentOutput/fmtSize/
 * ensureMammoth/ensurePdf/ensureFurigana——双向 import，见文件末尾 export。
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

import { COPY } from './copy.js';
import { enqueue } from './pipeline.js';

const $ = (s) => document.querySelector(s);

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

/* ---------- 输出落地辅助（供 presentOutput 用） ---------- */

function outputExt(fmt) { return fmt === 'kepub' ? 'kepub.epub' : fmt; }
function outputMime(fmt) {
  if (fmt === 'txt') return 'text/plain;charset=utf-8';
  if (fmt === 'mobi') return 'application/x-mobipocket-ebook';
  return 'application/epub+zip';
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
    enqueue(f, opts, autoDownload);
  }
});

const drop = $('#drop');
$('#picker').addEventListener('change', (e) => { addPending(e.target.files); e.target.value = ''; });
['dragenter', 'dragover'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('drag'); }));
['dragleave', 'drop'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove('drag'); }));
drop.addEventListener('drop', (e) => addPending(e.dataTransfer.files));

// 全部选项/待转换队列的绑定就绪后，再启动核心转换能力的加载。
loadEngines();

/* ---------- 供 pipeline.js 反向 import 的页面能力 ----------
 * 建卡片、落地下载产物、格式化体积、按需加载三个可选引擎。这些都触碰 DOM 或
 * 管理引擎加载状态，属页面层，留在 app.js；pipeline.js 在运行时（用户手势后）
 * 才调用它们，故双向 import 安全（见文件头注释）。 */
export { makeCard, presentOutput, fmtSize, ensureMammoth, ensurePdf, ensureFurigana };
