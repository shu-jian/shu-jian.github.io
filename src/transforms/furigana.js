/* ============================================================
 * src/transforms/furigana.js · 日语注音（Book IR → Book IR）
 *
 * 契约：docs/harness/BOOK-IR.md §6（transforms 通用契约）。
 *   1. 结构不变：chapters.length / 每章 level / nav 树形状 / resources 键集合，
 *      进出完全一致——本文件只改 chapter.html 与 notes[*].html 里的文本节点，
 *      不碰 chapter.title / nav.title / meta.title（它们是纯文本字段，IR §2
 *      没有把它们纳入"受限 HTML 子集"，塞 <ruby> 进去会破坏 schema）。
 *   2. 可交换：只标注"当前文本长什么样"，不关心这段文本是不是被 opencc 改写过的
 *      字形——本文件对字形差异没有记忆，天然满足"顺序无关"里"本 transform 不做
 *      特殊处理"这一半。另一半（opencc 不转换 <rt>）由 opencc.js 负责。
 *      但有个已知的不可交换场景：这条约定在"日语书 + 非 none 的繁简方案"组合下
 *      无法总是成立，原因不在本文件——见交付时的 ResultReport（opencc 会把一部分
 *      日语汉字的字形改写成分词词典不认识的中文简体/繁体形，导致其中一个顺序下
 *      该字丢失读音）。产品层面的建议是不要对日语书提供繁简方案，而不是让本文件
 *      去猜测"这个字是不是被动过"。
 *   3. 幂等：已在 <ruby> 内的文本（含 <rt>/<rp>）原样跳过，不二次包裹。
 *   4. 纯函数：不修改入参 book，返回新对象。
 *
 * 分词引擎不进本模块。调用方必须已经准备好一个能用的 tokenizer 并注入：
 *   - 优先：opts.tokenizer —— 任何具备 `.tokenize(text): Token[]` 方法的对象
 *     （kuromoji 的 Tokenizer 实例天然满足；测试里直接传等价对象即可）。
 *   - 兜底：globalThis.kuromoji，且它本身要有 `.tokenize()` 方法（即调用方已经
 *     完成 kuromoji.builder({...}).build() 并把结果挂到这个全局名字上）。
 *     注意这不是 kuromoji 模块本身（模块只有 .builder()，没有 .tokenize()）。
 *   两者都没有时抛出人话错误（不是 undefined 方法调用的原始异常）——由 UI 层
 *   捕获后提示"请先勾选注音并等待词典下载完成"（具体文案由 ux-writer 定）。
 *
 * Token 的最低字段要求（对齐 kuromoji 的 IPADIC Token）：
 *   surface_form: string           词面文本
 *   reading:      string|undefined 片假名读音；未登录词/生僻字常缺失
 *
 * 环境中立：不碰 DOM，标签/文本切分复用 opencc.js 同款"正则切分 + 深度计数"
 *   思路（同目录先例），前提同样是 html 已过 sanitizeHtml，标签结构规整。
 * ============================================================ */

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/* ---------- 汉字判定 / 假名转换 ---------- */

// CJK 统一表意文字 + 扩展 A + 兼容表意文字 + 扩展 B-F（辅助平面）+ 々〇
// （々 是汉字叠字符号，如"人々"；〇 是汉字化的零，两者按汉字处理才不会把
//  "時々""三〇年" 这类词错误地当成"含假名的混排词"处理）
const KANJI_TEST_RE = /[㐀-鿿豈-﫿々〇\u{20000}-\u{2FFFF}]/u;

function isKanjiCp(cp) {
  return (cp >= 0x4E00 && cp <= 0x9FFF)
    || (cp >= 0x3400 && cp <= 0x4DBF)
    || (cp >= 0xF900 && cp <= 0xFAFF)
    || (cp >= 0x20000 && cp <= 0x2FFFF)
    || cp === 0x3005
    || cp === 0x3007;
}

function hasKanji(text) {
  return KANJI_TEST_RE.test(text);
}

// 片假名（U+30A1-U+30F6，含小字/ヴ/ヵヶ）→ 平假名。日语注音惯例用平假名，
// 且与既有样本（test/golden/ja/sample.xhtml）里手工核定的 <rt> 一致。
// 长音符 ー（U+30FC）没有平假名对应，原样保留。
function kataToHira(s) {
  return s.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
}

// 只用来转义"本文件新合成的文本"（目前只有 rt 里的假名读音）。
// 绝不能拿它处理"从原始 html 里原样复制出来的片段"（surface 文本、非汉字游程、
// ruby base）——那些片段已经是 sanitizeHtml 转义过的合法 HTML 文本，
// 可能已经含有 "&amp;" 这样的实体；再转义一次会把它变成 "&amp;amp;"，
// 是货真价实的破坏输出。这条与 opencc.js 里"不做实体解码/转义"的理由一致，
// 只是这里既有需要转义的新内容（rt），也有必须原样直通的旧内容（surface）。
function escapeText(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/* ---------- 常用汉字表（"只标生僻字"开关用，见文件末尾说明） ---------- */

// 日本 2010 年常用汉字表（常用漢字表），2136 字。来源：npm 包 joyo-kanji@0.2.1
// （MIT，数据整理自 http://x0213.org/joyo-kanji-code/index.en.html）。随源码内嵌，
// 不是"词典"——6.4KB 的静态字符表，跟 ir.js 里内嵌 WHITELIST_TAGS 是同一量级，
// 不违反"词典按需加载"（那条约束针对的是 kuromoji 的 MB 级分词词典）。
const JOYO_KANJI_STR = '亜哀挨愛曖悪握圧扱宛嵐安案暗以衣位囲医依委威為畏胃尉異移萎偉椅彙意違維慰遺緯域育一壱逸茨芋引印因咽姻員院淫陰飲隠韻右宇羽雨唄鬱畝浦運雲永泳英映栄営詠影鋭衛易疫益液駅悦越謁閲円延沿炎怨宴媛援園煙猿遠鉛塩演縁艶汚王凹央応往押旺欧殴桜翁奥横岡屋億憶臆虞乙俺卸音恩温穏下化火加可仮何花佳価果河苛科架夏家荷華菓貨渦過嫁暇禍靴寡歌箇稼課蚊牙瓦我画芽賀雅餓介回灰会快戒改怪拐悔海界皆械絵開階塊楷解潰壊懐諧貝外劾害崖涯街慨蓋該概骸垣柿各角拡革格核殻郭覚較隔閣確獲嚇穫学岳楽額顎掛潟括活喝渇割葛滑褐轄且株釜鎌刈干刊甘汗缶完肝官冠巻看陥乾勘患貫寒喚堪換敢棺款間閑勧寛幹感漢慣管関歓監緩憾還館環簡観韓艦鑑丸含岸岩玩眼頑顔願企伎危机気岐希忌汽奇祈季紀軌既記起飢鬼帰基寄規亀喜幾揮期棋貴棄毀旗器畿輝機騎技宜偽欺義疑儀戯擬犠議菊吉喫詰却客脚逆虐九久及弓丘旧休吸朽臼求究泣急級糾宮救球給嗅窮牛去巨居拒拠挙虚許距魚御漁凶共叫狂京享供協況峡挟狭恐恭胸脅強教郷境橋矯鏡競響驚仰暁業凝曲局極玉巾斤均近金菌勤琴筋僅禁緊錦謹襟吟銀区句苦駆具惧愚空偶遇隅串屈掘窟熊繰君訓勲薫軍郡群兄刑形系径茎係型契計恵啓掲渓経蛍敬景軽傾携継詣慶憬稽憩警鶏芸迎鯨隙劇撃激桁欠穴血決結傑潔月犬件見券肩建研県倹兼剣拳軒健険圏堅検嫌献絹遣権憲賢謙鍵繭顕験懸元幻玄言弦限原現舷減源厳己戸古呼固股虎孤弧故枯個庫湖雇誇鼓錮顧五互午呉後娯悟碁語誤護口工公勾孔功巧広甲交光向后好江考行坑孝抗攻更効幸拘肯侯厚恒洪皇紅荒郊香候校耕航貢降高康控梗黄喉慌港硬絞項溝鉱構綱酵稿興衡鋼講購乞号合拷剛傲豪克告谷刻国黒穀酷獄骨駒込頃今困昆恨根婚混痕紺魂墾懇左佐沙査砂唆差詐鎖座挫才再災妻采砕宰栽彩採済祭斎細菜最裁債催塞歳載際埼在材剤財罪崎作削昨柵索策酢搾錯咲冊札刷刹拶殺察撮擦雑皿三山参桟蚕惨産傘散算酸賛残斬暫士子支止氏仕史司四市矢旨死糸至伺志私使刺始姉枝祉肢姿思指施師恣紙脂視紫詞歯嗣試詩資飼誌雌摯賜諮示字寺次耳自似児事侍治持時滋慈辞磁餌璽鹿式識軸七𠮟失室疾執湿嫉漆質実芝写社車舎者射捨赦斜煮遮謝邪蛇尺借酌釈爵若弱寂手主守朱取狩首殊珠酒腫種趣寿受呪授需儒樹収囚州舟秀周宗拾秋臭修袖終羞習週就衆集愁酬醜蹴襲十汁充住柔重従渋銃獣縦叔祝宿淑粛縮塾熟出述術俊春瞬旬巡盾准殉純循順準潤遵処初所書庶暑署緒諸女如助序叙徐除小升少召匠床抄肖尚招承昇松沼昭宵将消症祥称笑唱商渉章紹訟勝掌晶焼焦硝粧詔証象傷奨照詳彰障憧衝賞償礁鐘上丈冗条状乗城浄剰常情場畳蒸縄壌嬢錠譲醸色拭食植殖飾触嘱織職辱尻心申伸臣芯身辛侵信津神唇娠振浸真針深紳進森診寝慎新審震薪親人刃仁尽迅甚陣尋腎須図水吹垂炊帥粋衰推酔遂睡穂随髄枢崇数据杉裾寸瀬是井世正生成西声制姓征性青斉政星牲省凄逝清盛婿晴勢聖誠精製誓静請整醒税夕斥石赤昔析席脊隻惜戚責跡積績籍切折拙窃接設雪摂節説舌絶千川仙占先宣専泉浅洗染扇栓旋船戦煎羨腺詮践箋銭潜線遷選薦繊鮮全前善然禅漸膳繕狙阻祖租素措粗組疎訴塑遡礎双壮早争走奏相荘草送倉捜挿桑巣掃曹曽爽窓創喪痩葬装僧想層総遭槽踪操燥霜騒藻造像増憎蔵贈臓即束足促則息捉速側測俗族属賊続卒率存村孫尊損遜他多汰打妥唾堕惰駄太対体耐待怠胎退帯泰堆袋逮替貸隊滞態戴大代台第題滝宅択沢卓拓託濯諾濁但達脱奪棚誰丹旦担単炭胆探淡短嘆端綻誕鍛団男段断弾暖談壇地池知値恥致遅痴稚置緻竹畜逐蓄築秩窒茶着嫡中仲虫沖宙忠抽注昼柱衷酎鋳駐著貯丁弔庁兆町長挑帳張彫眺釣頂鳥朝貼超腸跳徴嘲潮澄調聴懲直勅捗沈珍朕陳賃鎮追椎墜通痛塚漬坪爪鶴低呈廷弟定底抵邸亭貞帝訂庭逓停偵堤提程艇締諦泥的笛摘滴適敵溺迭哲鉄徹撤天典店点展添転塡田伝殿電斗吐妬徒途都渡塗賭土奴努度怒刀冬灯当投豆東到逃倒凍唐島桃討透党悼盗陶塔搭棟湯痘登答等筒統稲踏糖頭謄藤闘騰同洞胴動堂童道働銅導瞳峠匿特得督徳篤毒独読栃凸突届屯豚頓貪鈍曇丼那奈内梨謎鍋南軟難二尼弐匂肉虹日入乳尿任妊忍認寧熱年念捻粘燃悩納能脳農濃把波派破覇馬婆罵拝杯背肺俳配排敗廃輩売倍梅培陪媒買賠白伯拍泊迫剝舶博薄麦漠縛爆箱箸畑肌八鉢発髪伐抜罰閥反半氾犯帆汎伴判坂阪板版班畔般販斑飯搬煩頒範繁藩晩番蛮盤比皮妃否批彼披肥非卑飛疲秘被悲扉費碑罷避尾眉美備微鼻膝肘匹必泌筆姫百氷表俵票評漂標苗秒病描猫品浜貧賓頻敏瓶不夫父付布扶府怖阜附訃負赴浮婦符富普腐敷膚賦譜侮武部舞封風伏服副幅復福腹複覆払沸仏物粉紛雰噴墳憤奮分文聞丙平兵併並柄陛閉塀幣弊蔽餅米壁璧癖別蔑片辺返変偏遍編弁便勉歩保哺捕補舗母募墓慕暮簿方包芳邦奉宝抱放法泡胞俸倣峰砲崩訪報蜂豊飽褒縫亡乏忙坊妨忘防房肪某冒剖紡望傍帽棒貿貌暴膨謀頰北木朴牧睦僕墨撲没勃堀本奔翻凡盆麻摩磨魔毎妹枚昧埋幕膜枕又末抹万満慢漫未味魅岬密蜜脈妙民眠矛務無夢霧娘名命明迷冥盟銘鳴滅免面綿麺茂模毛妄盲耗猛網目黙門紋問冶夜野弥厄役約訳薬躍闇由油喩愉諭輸癒唯友有勇幽悠郵湧猶裕遊雄誘憂融優与予余誉預幼用羊妖洋要容庸揚揺葉陽溶腰様瘍踊窯養擁謡曜抑沃浴欲翌翼拉裸羅来雷頼絡落酪辣乱卵覧濫藍欄吏利里理痢裏履璃離陸立律慄略柳流留竜粒隆硫侶旅虜慮了両良料涼猟陵量僚領寮療瞭糧力緑林厘倫輪隣臨瑠涙累塁類令礼冷励戻例鈴零霊隷齢麗暦歴列劣烈裂恋連廉練錬呂炉賂路露老労弄郎朗浪廊楼漏籠六録麓論和話賄脇惑枠湾腕';
const JOYO_KANJI = new Set(Array.from(JOYO_KANJI_STR));

/* ---------- 逐字符游程切分：汉字游程 / 非汉字游程交替 ---------- */

function splitRuns(text) {
  const runs = [];
  let cur = '';
  let curKanji = null;
  for (const ch of text) { // for...of 按码点迭代，辅助平面汉字不会被代理对拆散
    const k = isKanjiCp(ch.codePointAt(0));
    if (curKanji === null) { cur = ch; curKanji = k; }
    else if (k === curKanji) { cur += ch; }
    else { runs.push({ text: cur, kanji: curKanji }); cur = ch; curKanji = k; }
  }
  if (cur) runs.push({ text: cur, kanji: curKanji });
  return runs;
}

// base 原样直通（原始 html 片段，已经是合法转义过的文本，见 escapeText 上面的
// 说明）；rt 是本文件新合成的读音，转义一下不会错，也几乎从不会真的有内容要转
// （假名不含 & < >），纯防御性。
function rubyTag(base, rt) {
  return `<ruby>${base}<rp>(</rp><rt>${escapeText(rt)}</rt><rp>)</rp></ruby>`;
}

/**
 * 按"只标生僻字"开关决定是否真的包 ruby。
 * 粒度是汉字游程整体，不是单字：游程里只要有一个字不在常用汉字表，就整体标注；
 * 全部是常用字则整体跳过。不做字符级的读音拆分——一个游程的读音是分词器给的
 * 一整段音，拆到字符级需要额外的字音对齐假设，超出"不做消歧"的范围。
 */
function maybeWrapRun(text, reading, opts) {
  if (opts && opts.onlyRareKanji) {
    let allCommon = true;
    for (const ch of text) {
      if (isKanjiCp(ch.codePointAt(0)) && !JOYO_KANJI.has(ch)) { allCommon = false; break; }
    }
    if (allCommon) return text; // 原样直通，text 是原始片段，不是新合成内容
  }
  return rubyTag(text, reading);
}

/**
 * 给一个分词器 token 生成标注后的片段。
 * 核心问题：一个词的 surface（如"生まれ"）常常是"汉字+送假名"混排，只应该给
 * 汉字部分套 ruby，送假名（"まれ"）保持原样——不然假名会在正文里重复出现一次
 * （一次是原文，一次在 rt 里），既吵又不符合日语排版惯例。
 *
 * 做法：分词器给的 reading 是整个 surface 的完整读音（片假名）。把 surface 切成
 * 汉字游程/假名游程交替的序列，假名游程的文本转成平假名后应当能在 reading 里
 * 按顺序原样找到（这是"送假名"的定义——怎么写就怎么读）。用假名游程在 reading
 * 里的位置做锚点，两个锚点之间（或锚点到首尾）剩下的 reading 片段就是夹在中间
 * 的汉字游程的读音。
 *
 * 找不到锚点（活用形的音变导致假名游程在 reading 里对不上，实测里没遇到，但
 * 保留兜底）时，整个 surface 一起套一个 ruby，读音用分词器给的完整 reading——
 * 比完全不标注更有用，代价是 rt 里会把送假名的音也重复一遍。
 */
function annotateToken(surface, readingKatakana, opts) {
  if (!hasKanji(surface)) return surface; // 原样直通，surface 是原始片段

  const readingHira = readingKatakana ? kataToHira(readingKatakana) : '';
  if (!readingHira) {
    // 分词器没给读音：多是未登录词/生僻字（word_type UNKNOWN）。不猜，原样输出。
    return surface;
  }

  const runs = splitRuns(surface);

  if (runs.length === 1) {
    // 纯汉字游程（如"見当""所"），整体套 ruby。
    return maybeWrapRun(runs[0].text, readingHira, opts);
  }

  // 多游程：假名游程做锚点，在 reading 里顺序查找。
  let cursor = 0;
  const anchors = [];
  let ok = true;
  for (const run of runs) {
    if (run.kanji) { anchors.push(null); continue; }
    const hiraRun = kataToHira(run.text);
    const idx = readingHira.indexOf(hiraRun, cursor);
    if (idx === -1) { ok = false; break; }
    anchors.push({ start: idx, end: idx + hiraRun.length });
    cursor = idx + hiraRun.length;
  }

  if (!ok) {
    // 兜底：锚点对不齐，整词一起标注。
    return rubyTag(surface, readingHira);
  }

  let out = '';
  let prevEnd = 0;
  for (let i = 0; i < runs.length; i++) {
    const run = runs[i];
    if (!run.kanji) {
      out += run.text; // 原样直通
      prevEnd = anchors[i].end;
      continue;
    }
    let nextStart = readingHira.length;
    for (let j = i + 1; j < runs.length; j++) {
      if (anchors[j]) { nextStart = anchors[j].start; break; }
    }
    const seg = readingHira.slice(prevEnd, nextStart);
    out += seg ? maybeWrapRun(run.text, seg, opts) : run.text;
    prevEnd = nextStart;
  }
  return out;
}

/* ---------- HTML 感知的文本转换（同目录 opencc.js 的切分/深度计数模式） ---------- */

const TAG_SPLIT_RE = /(<[^>]*>)/g;
const TAG_NAME_RE = /^<\/?\s*([a-zA-Z][a-zA-Z0-9]*)/;

// 章内分块阈值：每处理满这么多字符（跨多个文本节点累计）就 await tick() 一次，
// 把主线程让出去。取值来自 verifier 实测反馈（D4，见 ResultReport）：单章 30 万字
// 的日语书连续同步处理会阻塞主线程 ~400ms；按段落（<p> 之间天然的文本节点边界）
// 累计计数、不拆分单个文本节点本身来分块，保证"分块只影响调度时机，不影响
// tokenizer 看到的输入"——语义（输出字节）与不分块时完全一致，只是把一次性的
// 长同步任务切成多段、段间让出主线程。
const CHUNK_CHAR_BUDGET_DEFAULT = 15000;

// opts.__chunkCharBudget：仅供 test/furigana.mjs 用来在同一份输入上强制"几乎从不
// 分块"（传一个很大的数）与"几乎每个节点都分块"（传一个很小的数）两种极端跑一遍，
// 断言两者输出字节级相同——直接证明"分块粒度不改变输出"，而不是依赖计时结果
// （计时本身易抖动，不适合当正确性证据）。不是公开契约的一部分，不出现在本文件
// 头部的 opts 说明里；调用方（app.js）不应该、也不需要传这个字段。
function chunkBudget(opts) {
  const v = opts && opts.__chunkCharBudget;
  return Number.isFinite(v) && v > 0 ? v : CHUNK_CHAR_BUDGET_DEFAULT;
}

/**
 * 标注一段受限 HTML 子集里的文本节点，标签原样保留。
 * 深度计数覆盖 <ruby>...</ruby> 整体（不只是 <rt>）：已有 ruby 的 base 文本和
 * rt/rp 文本都原样跳过——这同时满足"幂等"（不二次包裹）和"不碰 <rt> 里的假名"
 * （<rt> 本来就嵌在 <ruby> 里，被 ruby 深度计数覆盖，不需要单独再判断一次）。
 *
 * 异步且章内分块：每个文本节点仍然整体喂给 tokenizer.tokenize()（不拆分单个
 * 节点，分词结果不受分块影响），只在节点与节点之间、累计字符数超过预算
 * （默认 CHUNK_CHAR_BUDGET_DEFAULT，见 chunkBudget()）时插入一次 await tick()。
 * 大章节（很多 <p>）能被切成多段执行；单个节点本身异常巨大（现实的书不会这样
 * 排版）时，那一次 tokenize() 调用仍是一整块同步耗时，是已知的残余限制，见
 * ResultReport。
 */
async function annotateHtmlText(html, tokenizer, opts) {
  if (!html) return html;
  const parts = html.split(TAG_SPLIT_RE);
  const budgetLimit = chunkBudget(opts);
  let rubyDepth = 0;
  let budget = 0;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (!part) continue;
    if (part.charCodeAt(0) === 60 /* '<' */) {
      const m = TAG_NAME_RE.exec(part);
      const tag = m ? m[1].toLowerCase() : '';
      if (tag === 'ruby') {
        if (part[1] === '/') rubyDepth = Math.max(0, rubyDepth - 1);
        else rubyDepth += 1;
      }
      continue;
    }
    if (rubyDepth > 0) continue; // 已标注区域，原样保留
    if (!hasKanji(part)) continue; // 快速跳过纯假名/拉丁/数字/标点的文本节点
    const tokens = tokenizer.tokenize(part);
    let out = '';
    for (const t of tokens) out += annotateToken(t.surface_form, t.reading, opts);
    parts[i] = out;

    budget += part.length;
    if (budget >= budgetLimit) {
      await tick();
      budget = 0;
    }
  }
  return parts.join('');
}

/* ---------- 分词器解析（不做加载，只做"有没有可用的"判断） ---------- */

function resolveTokenizer(opts) {
  if (opts && opts.tokenizer && typeof opts.tokenizer.tokenize === 'function') {
    return opts.tokenizer;
  }
  const g = typeof globalThis !== 'undefined' ? globalThis.kuromoji : undefined;
  if (g && typeof g.tokenize === 'function') return g;
  throw new Error(
    '日语分词器尚未就绪：请先加载 kuromoji 词典（通过 opts.tokenizer 注入，'
    + '或让 globalThis.kuromoji 指向已 build 完成、带 tokenize() 方法的实例）。'
    + '这是集成侧（勾选注音时按需下载词典）的职责，本函数不负责加载。'
  );
}

/* ---------- 纯函数式深拷贝（与 opencc.js 相同的拷贝粒度） ---------- */

function cloneNav(list) {
  return (list || []).map((n) => ({ ...n, children: cloneNav(n.children) }));
}

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
 * Book IR → Book IR 的日语注音。纯函数，不修改入参。
 *
 * 只处理 chapter.html 与 notes[*].html 的文本节点；meta.title / chapter.title /
 * nav[].title 是纯文本字段（IR §2），不承载受限 HTML 子集，不会被标注。
 *
 * @param {import('../ir.js').Book} book
 * @param {{tokenizer?: {tokenize(text:string):Array}, onlyRareKanji?: boolean}} [opts]
 * @returns {Promise<import('../ir.js').Book>}
 */
export async function furigana(book, opts = {}) {
  const tokenizer = resolveTokenizer(opts);
  const out = cloneBook(book);

  for (const ch of out.chapters) {
    // annotateHtmlText 自己按字符预算章内分块让路（见函数注释）；这里再补一次
    // tick()，覆盖"章节很小、内部从没触发过分块阈值"的情况，保持章与章之间
    // 始终至少让路一次的既有节奏（与 opencc.js 的每章一次 tick 对齐）。
    ch.html = await annotateHtmlText(ch.html, tokenizer, opts);
    await tick();
  }

  let noteCount = 0;
  for (const [id, note] of out.notes) {
    out.notes.set(id, { ...note, html: await annotateHtmlText(note.html, tokenizer, opts) });
    noteCount += 1;
    if (noteCount % 20 === 0) await tick();
  }

  return out;
}
