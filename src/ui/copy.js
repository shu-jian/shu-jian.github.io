/* ============================================================
 * src/ui/copy.js · 全部用户可见文案（集中管理，便于 G4 扫描）
 *
 * 阶段 4（ux_copy_01）定稿：按 verifier 实测能力矩阵重写全部文案。
 * 对应关系见 docs/harness/REQUIREMENTS.md 各格式分级表——凡是这里出现的
 * 承诺，都能在那张表里找到对应的实测等级；矩阵之外的能力，这里不承诺。
 *
 * 结构：
 *   1. 品牌 / 首屏
 *   2. 转换方案 / 输出格式选择器
 *   3. 拖放区
 *   4. 核心能力准备（首屏必需）与按需能力（docx / pdf / 假名标注）
 *   5. 队列与单本书的状态文案
 *   6. 各格式已知的效果限制提醒（选中或读到时触发一句话，不是道歉）
 *   7. warning code → 人话的兜底映射（覆盖 src/readers 里目前登记的全部
 *      code；新增 reader/writer 产出新 code 时，把它加进 warningByCode，
 *      没顾上加的兜底走 warningFallback，不会让用户看到裸的 code 字符串）
 *   8. 页脚 / 关于
 *
 * 关于「关于」区的一个技术性发现（写给下一个碰这份文件的人，也写进了
 * ResultReport）：G4（test/g4-copy.mjs）对 src/ui/copy.js 的扫描是无条件
 * 的——不像它对生成后 index.html 的扫描那样，会把 `<details class="about">`
 * 折叠区豁免掉。也就是说，任何第三方开源项目的**具体名字**只要出现在这个
 * 文件里的任意字符串中，不管最终落在页面哪个角落、是否折叠，都会被判定为
 * 失败。所以这份文件里的「关于」文案只写得到"这是一份开源的静态页面，
 * 用到的开源工具信息在代码仓库里"这种不点名的表述；如果要在页面上展示
 * 具体的项目名和许可证，那段文字必须是写死在 shell.html 的 `<details
 * class="about">` 静态标记里，不能经过这个文件——那样它才享受得到 G4
 * 对 index.html 的豁免。见 ResultReport.needs_wiring 里的说明。
 * ============================================================ */

/* ---------- 共享片段：同一句话会被多个 warning code 复用，写一处改一处 ---------- */

const MOBI_READ_LIMITED =
  'MOBI 这本书的章节和目录可能不完整，一些老式的内部链接也变成了纯文字。';
const PDF_READ_LIMITED =
  'PDF 里只记了文字的位置，没有章节信息，转出来的结构可能要你手动调一下；图片和排版不会保留，扫描版 PDF 处理不了。';
const EPUB_SOFT_ENCRYPTED =
  '检测到与版权保护相关的加密信息，转换出来的内容可能没法正常打开。';

export const COPY = {
  /* ================ 1. 首屏 ================ */

  pageTitle: '书简 · 电子书繁简转换 · 日语注音',
  pageDescription:
    '把电子书转换成你需要的格式，支持 EPUB、MOBI、PDF 等常见格式，也能转换繁简、给日文标音。全部处理都在你的设备本地完成，文件不会被上传。',

  // 首屏第一句：一句诗，大字细体（见 shell.html h1.poem 样式）。
  heroTitle: '闲坐小窗读周易，\n不知春去几多时。',

  // 首屏描述随当前功能切换（app.js setMode 里改写 #heroLede 的 innerHTML）：
  // 繁简一侧讲格式转换与边界；日文一侧换一套面向"读原著攒生词"的说法，两边不同。
  ledeTsHtml:
    '<b>书简</b>，把 EPUB、MOBI、AZW3、TXT、PDF等格式的繁体竖版书籍<br>转成适合 Kindle、Kobo、Apple Books的简体横版书籍<br>横竖排版，皆自动处理。',
  ledeFuriganaHtml:
    '<b>书简</b>，为想在阅读里攒生词的你而生。把日文汉字逐个注上假名<br>&nbsp;—— 带着假名进 Kindle、Kobo、Apple Books。',

  // 页脚小字（品牌 + 隐私承诺），见 shell.html #footerLine。
  footerLine: '© 2026 书简 · 零服务器存储',

  /* ================ 2. 转换方案 / 输出格式 ================ */

  // 繁简转换拆成两个并排的独立选项：转换方向 + 地区用词。app.js 的 tsScheme()
  // 把这对取值合成 opencc 的 scheme key（见 SCHEMES）。这样"要不要转、往哪个
  // 方向转"和"按哪个地区的用字用词习惯"互不纠缠，各自一个下拉。

  // 转换方向。value 见 app.js tsScheme()：t2s 繁→简 / s2t 简→繁 / none 不转换。
  directionLabel: '转换方向',
  directionOptions: [
    { value: 't2s', label: '繁体 → 简体' },
    { value: 's2t', label: '简体 → 繁体' },
    // 格式互转不该被迫改变字形，"不转换"是和两个方向平级的合法选项
    { value: 'none', label: '不转换' },
  ],

  // 地区用词（按哪个地方的用字与用词习惯）。value 见 app.js tsScheme()。
  // 「不转换」方向下这个选项无意义，app.js 会把它禁用。
  regionLabel: '地区用词',
  regionOptions: [
    // generic＝只转字形、不换措辞（opencc 通用档 t2cn/cn2t）：網際網路 → 网际网路，
    // 词还是那个词。与"台湾用词"（會把它换成 互联网）区分开。
    { value: 'generic', label: '保留原文措辞（網際網路 → 网际网路）' },
    { value: 'tw', label: '台湾用词（滑鼠 → 鼠标）' },
    { value: 'hk', label: '香港' },
  ],

  // scheme key → 下载文件名后缀（如"（简体）"）。空串则文件名不加后缀。
  schemeTags: {
    t2cn: '简体', tw2cn: '简体', twp2cn: '简体', hk2cn: '简体',
    cn2t: '繁體', cn2tw: '繁體', cn2twp: '繁體', cn2hk: '繁體',
    none: '',
  },

  outputLabel: '输出格式',
  // value 对齐 src/ui/app.js 的 WRITERS 表，不能改。
  // AZW3 不出现在这里——见 azwOutputSuggestion 与本文件顶部关于「不做的
  // 不出现，只在用户拖入相关文件时给建议」的落地位置。
  outputOptions: [
    { value: 'epub', label: 'EPUB' },
    { value: 'txt', label: 'TXT（纯文字）' },
    { value: 'kepub', label: 'KEPUB（Kobo 专用）' },
    { value: 'mobi', label: 'MOBI（Kindle 旧格式）' },
    { value: 'pdf', label: 'PDF（打印生成）' },
  ],

  // 排版方向（两个功能都显示）。value 对齐 app.js：'keep' 不改动原书，其余写入
  // meta.writingMode（ir.js 只认 'horizontal-tb' / 'vertical-rl'）。竖排只在
  // EPUB / KEPUB / PDF 里有效，TXT / MOBI 不带方向。
  writingDirLabel: '排版方向',
  writingDirOptions: [
    { value: 'keep', label: '保持原书' },
    { value: 'horizontal-tb', label: '横排' },
    { value: 'vertical-rl', label: '竖排（直排）' },
  ],
  writingDirNotice: (dir, fmt) =>
    dir === 'vertical-rl' && fmt !== 'epub' && fmt !== 'kepub' && fmt !== 'pdf'
      ? '竖排只在 EPUB / KEPUB / PDF 里生效，这个输出格式不带排版方向。'
      : '',

  /* ================ 顶层功能：繁简转换 / 日文标音（横排二选一） ================ */

  // 两个功能是并列的两回事：繁简转换是字形转换（走 opencc），日文标音是给日文
  // 汉字注假名（走 furigana）。用户选其一，界面只显示该功能的选项。tab 只留名字，
  // 各自的说明交给随功能切换的首屏描述（ledeTsHtml / ledeFuriganaHtml）。
  modeTsName: '繁简转换',
  modeFuriName: '日文标音',

  // 日文标音的标注范围（功能=日文标音 时显示）。value 对齐 applyFurigana 的 mode。
  annotLabel: '标注范围',
  annotOptions: [
    { value: 'all', label: '全部汉字' },
    { value: 'rare', label: '只标生僻字' },
  ],

  // 当前功能对应的即时说明（日文标音时说清适用范围、首次要下载词典这两件事）。
  modeNotice: (mode) =>
    mode === 'furigana'
      ? '只对日语书有用。'
      : '',

  /* ================ 开始转换 / 待转换列表 ================ */

  startLabel: '开始转换',
  pendingTitle: (n) => `待转换 · ${n} 个文件`,
  removeLabel: '移除',

  /* ================ 3. 拖放区 ================ */

  dropMain: '把文件拖到这里，或点击选择',
  dropSub: '可以一次选多个文件',

  // 完全认不出的文件类型（扩展名不在 app.js 的 READERS 表里）
  unsupportedType: '这个文件认不出来，试试 .txt / .md / .zip / .epub / .docx / .pdf / .mobi / .azw3 / .azw 里的一种',

  // 认识但目前处理不了的格式（app.js 的 CONVERTIBLE_UNSUPPORTED 现在是空集，
  // 这条暂时没有触发对象；留着给以后真正出现"认识但暂不支持"的格式用）
  unsupportedConvertible: (ext) => `.${ext} 这个格式暂时还处理不了，可以先用 Calibre 转成 EPUB 再试试`,

  /* ================ 4. 核心能力准备 ================ */

  // 首屏必需：核心转换能力就绪前，拖放区是禁用的
  engineLoading: '准备中…',
  // 就绪本来就不需要通知——留空，靠拖放区解除禁用 + 状态点变绿来表达
  engineReady: '',
  engineErrorHtml:
    '暂时没准备好，检查一下网络后 <button id="retry">重试</button>。如果是在受限的预览环境里打开的，把这个网页下载下来后用浏览器直接打开就行。',

  // .docx 按需能力。docxEngineLoading 目前 app.js 未接线调用（只在失败时
  // 用到 docxEngineError），保留是为了将来接一个"正在准备"的提示位
  docxEngineLoading: '正在准备处理这份 Word 文档…',
  docxEngineError: 'Word 文档没能处理，检查一下网络后重试。',

  // .pdf 按需能力，同上，pdfEngineLoading 目前也未接线
  pdfEngineLoading: '正在准备读取这份 PDF…',
  pdfEngineError: 'PDF 没能处理，检查一下网络后重试。',

  /* ================ 5. 队列 / 单本书状态 ================ */

  queued: '排队中…',
  reading: '读取中…',
  converting: (percent) => `转换中 ${percent}%`,
  doneWithSize: (sizeStr) => `完成 · ${sizeStr}`,
  downloadLabel: (tag) => (tag ? `下载 ${tag}版` : '下载'),

  convertFailed: '没能转换成功，再试一次。',
  readFailed: '没能读出这个文件，再试一次。',
  // 目前 app.js 没有走到这条（epub 读入失败的具体原因由 reader 直接抛出人话
  // 错误），保留作为兜底
  epubParseError: '打不开这个文件，它好像不是一份有效的 EPUB。',

  zipMultiple: (n) => `压缩包里认出了 ${n} 本书，会一本一本处理。`,
  zipEmpty: '压缩包里没找到能认出来的书。',

  txtDropsMedia: '纯文本保留不了图片和注释。',

  /* ================ 6. 格式效果限制提醒（能做 但效果有限） ================ */

  // PDF 读入（C 档：仅文字流，无章节结构，扫描版直接拒绝）。PDF 的 reader
  // 对每一本成功读入的 PDF 都会挂 pdf.no-structure / pdf.flat-nav /
  // pdf.paged-chapters 三个 code 中的一个或多个，app.js 合并展示成这一条
  pdfLimitedNotice: PDF_READ_LIMITED,

  // MOBI 读入（B 档：章节目录可能不完整）。同样对应多个 code，合并展示
  mobiReadLimitedNotice: MOBI_READ_LIMITED,

  // MOBI 输出（C 档）的两项已知降级：注音变纯文字、注释挪到书末
  mobiRubyDropped: 'MOBI 里没法带注音，已经转换成普通文字。',
  mobiNotesAtEnd: 'MOBI 里的注释挪到了书的最后，点不了跳转。',

  // PDF 输出（C 档：打印路径，多一步操作）
  pdfOpenLabel: '打开打印页面',
  pdfPrintHint: '在弹出的打印窗口里选"存储为 PDF"，就能保存文件。',
  pdfPopupBlocked: '弹窗被拦截了，允许弹窗后再点一次"打开打印页面"。',

  // [需接线] 目前 outputFormat 的 <select> 变化时没有任何即时提示——MOBI /
  // PDF 输出的效果限制现在只在转换完成后随结果一起展示（mobiOutputNotes /
  // presentOutput 里的 pdfPrintHint）。R5 原文要求"效果有限的…在选中时给
  // 一句提醒"，更贴切的时机是用户刚选中格式、还没等转换跑完的时候。建议
  // 接线：shell.html 在 .controls 区域给 #outputFormat 旁边加一个提示位
  // （如 <p id="outputNotice">），app.js 在 change 事件里
  // `$('#outputNotice').textContent = COPY.outputFormatNotice(select.value)`。
  outputFormatNotice: (fmt) => {
    if (fmt === 'mobi') return 'MOBI 是老格式：注音会变成普通文字，注释会挪到书的最后。';
    if (fmt === 'pdf') return 'PDF 是打印生成的：转换完成后会打开一个打印窗口，手动选"存储为 PDF"保存，比直接下载多一步。';
    return '';
  },

  // [需接线] AZW3 输出没有做（成本错配，见 REQUIREMENTS.md R3），选项里不
  // 出现；按边界文档的要求，用户拖入 AZW3 时应该给一句建议而不是沉默。
  // 目前 app.js 的 runPipeline / processZip 没有在 ext === 'azw3' 时调用
  // 这条文案——建议接线：读入成功后，无论用户选的输出格式是什么，往
  // extraNotes 里追加一条 COPY.azwOutputSuggestion。.azw 走 azw3 分支解析
  // 成功时同样适用，但目前 readAzwAmbiguous() 不回传"具体是哪个 reader
  // 成功的"，需要顺带加这个信息才能触发。
  azwOutputSuggestion:
    '这本书原本是 AZW3（Kindle 格式）。这里认得它，输出选 EPUB 就好——新版 Kindle 固件已经原生支持，不用特意转回 AZW3。',

  // 日语书的繁简方案临时裁定提示（BOUNDARIES.md §3，待 H 确认）。这句话要
  // 在"没有勾选假名标注卡片"（比如输出选了 TXT）时也成立，所以只说繁简
  // 转换认不好日文汉字写法这条普遍成立的原因，不去绑定"和标注假名冲突"
  // 这个只在勾选假名标注时才适用的次要原因
  jaSchemeForced: '这本书是日语，繁简转换认不好日文汉字的写法，这里就先不转换了。',

  /* ================ 日语标音（功能=日文标音，仅日语书 + EPUB/KEPUB 输出时生效） ================ */

  // 选了标音、书也确实是日语，但输出格式带不了假名（TXT / MOBI / PDF）时的说明
  furiganaFormatSkipped: '想标假名的话，输出格式得选 EPUB 或 KEPUB；这次的格式带不了假名，就先没标。',

  // 词典下载没有逐文件/百分比进度，只能做阶段性提示，如实反映这一点
  furiganaEngineLoading: '正在准备标注假名…',
  furiganaDictLoading: '正在下载日语词典（十七兆左右，网络慢的话可能要等一会）…',
  // 失败不阻断其余转换，只是跳过这一步，继续正常输出——不道歉，说清楚接下来会怎样
  furiganaEngineError: '标注假名没能准备好，这次先跳过注音，其余转换照常进行。',

  // .azw 扩展名含糊：两种 reader 都试过仍失败，把两边的人话错误一起报出来
  azwAmbiguousFailed: (azw3Msg, mobiMsg) =>
    `这个 .azw 文件认不出来：按 AZW3 试了一次（${azw3Msg}），按 MOBI 也试了一次（${mobiMsg}），都没有成功。`,

  // 目前实测未见触发（epub.js 的加密判定直接抛人话错误中止，不走这条
  // warning code），保留作为兜底
  epubEncryptedWarning: EPUB_SOFT_ENCRYPTED,

  /* ================ 7. warning code → 人话（兜底映射） ================ */

  // [需接线] app.js 现有的 warningNotes() 是手写的 if/else，只覆盖了
  // epub.encrypted / pdf.* / mobi.* 三组共 7 个 code（对应 pdfLimitedNotice /
  // mobiReadLimitedNotice / epubEncryptedWarning 三个既有字段）。下面这张表
  // 补齐了 grep `src/readers/**` 里 warn()/warnings.push() 目前登记的全部
  // code（2026-07-21 核对共 23 个，其中 22 个收录在下表，剩下 1 个的处理
  // 方式见下方注）。建议接线：把 warningNotes() 改成遍历
  // book.warnings，优先查这张表（重复命中的 code 只展示一次，可用 Set 去重
  // 已经展示过的文案而不是去重 code，因为多个 code 可能共享同一句话），查
  // 不到的 code 落到 warningFallback，不要把裸的 code 字符串露给用户。
  //
  // 注：docx reader 里有一个会透传第三方组件原始提示文字的 warning code，
  // 那段原始文字不一定是人话（也可能是英文）。这个 code 的字面拼写本身会
  // 撞上 G4 黑名单（它的名字里含有被禁的库名），没法把它当成这张表的 key
  // 写在这个文件里——干脆不给它单独映射，让它落进 warningFallback，这恰好
  // 也是它最合适的处理方式：与其转述一句不保真的第三方文字，不如给一句
  // 靠得住的通用提示。docx.no-headings 之外，docx reader 目前还有这一个
  // 已知 code 未被单独收录，原因即此。
  warningByCode: {
    'zip.skipped': '压缩包里有些文件不是电子书，已经跳过。',
    'zip.unsupported': '压缩包里有些文件的格式暂时处理不了，已经跳过。',
    'zip.nested-too-deep': '压缩包套了不止一层，只展开了最外层。',
    'zip.multiple-books': '压缩包里不止一本书，这次只处理了排在前面的一本。',

    'epub.no-toc': '没找到目录，已经按章节顺序生成了一份。',
    'epub.broken-spine-item': '书里有一处内容指向丢失，已经跳过。',
    'epub.missing-image': '有些图片在书里找不到，已经省略。',
    'epub.encrypted': EPUB_SOFT_ENCRYPTED,

    'mobi.no-chapters': MOBI_READ_LIMITED,
    'mobi.flat-nav': MOBI_READ_LIMITED,
    'mobi.filepos-unresolved': MOBI_READ_LIMITED,

    'azw3.no-nav': '没找到目录，已经按章节顺序生成了一份。',
    'azw3.image-unresolved': '有些插图没能解析，已经省略。',
    'azw3.combo': '这个文件里合并了新旧两种格式，已经按新版内容处理。',

    'docx.no-headings': '文档里没识别到标题层级，整篇按一章处理。',

    'txt.no-chapters': '没识别到章节标题，整篇按一章处理。',
    'txt.encoding-fallback': '这本书的文字编码没能确认，这里已经尽量读了出来，个别字符可能显示不正常。',

    'md.no-chapters': '没找到标题，整篇按一章处理。',
    'md.image-unresolved': '文中的图片没能一起带过来，已经用文字说明代替。',

    'pdf.no-structure': PDF_READ_LIMITED,
    'pdf.flat-nav': PDF_READ_LIMITED,
    'pdf.paged-chapters': PDF_READ_LIMITED,
  },
  // 任何不在上表里的 code（新加的 reader/writer 忘了同步这张表时）落到这句，
  // 保证用户永远看到的是一句完整的话，不是一个技术代号
  warningFallback: '转换过程中有一处细节没能完全还原，不影响其余内容。',

  /* ================ 8. 页脚 ================ */
  // 页脚只留一行小字（品牌 + 隐私），见首屏区的 footerLine。
};
