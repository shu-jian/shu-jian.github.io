# 书简 · shū jiǎn

一个纯前端的电子书处理网页。把书拖进来，得到一本处理好的书——**文件不出本机，全部在浏览器里完成**。

线上：<https://shu-jian.github.io>

- **读入**：EPUB / MOBI / AZW3 / TXT / Markdown / PDF（文字版）/ DOCX / ZIP（打包多本）
- **导出**：EPUB / KEPUB / MOBI / TXT / PDF（可打印 HTML）
- **变换**：繁简互转（OpenCC，词级）、日语注音（振假名）、横竖排切换
- 只搬章节结构与文字，字体字号交给阅读器；扫描成图片的 PDF 读不了，会明说。

## 部署形态：原生 ES Modules，无构建

产物是**原生 ES Modules 多文件**，浏览器按 `<script type="module">` 的 import 图自行加载。`git push` 到 GitHub 后，GitHub Pages / Cloudflare Pages 镜像**直接可用，没有打包步骤**。

```
index.html              # 部署入口壳：DOM 结构 + <link styles/main.css> + <script type="module" src="./src/ui/app.js">
styles/
  main.css              # 页面全部样式
src/
  ir.js                 # Book IR：中间表示的类型约定与校验器（全系统枢纽）
  readers/              # <格式> → Book IR
    txt.js  md.js  zip.js  epub.js  docx.js  mobi.js  azw3.js  pdf.js
  writers/              # Book IR → <格式>
    txt.js  epub.js  kepub.js  mobi.js  pdf.js
  transforms/           # Book IR → Book IR（正交，可叠加、可交换）
    opencc.js           # 繁简互转
    furigana.js         # 日语注音
  ui/
    app.js              # 入口模块：页面接线（DOM、文案落地、引擎按需加载、待转队列、下载落地）
    pipeline.js         # 转换编排（格式分发、runPipeline / processFile、注音+繁简+排版流程）
    copy.js             # 全部用户可见文案，集中一处
dict/                   # kuromoji 日语分词词典（12 个 .dat.gz，~17MB），随站点部署、同源加载
LICENSE  README.md
```

## 架构：一切经由 Book IR

reader 只产出 IR，writer 只消费 IR，两者不互相引用——N 种输入 × M 种输出的组合坍缩成 N+M 个模块。transform 是 `IR → IR` 的纯函数，可叠加、可交换。

```mermaid
graph LR
  subgraph readers
    R1[txt/md/zip]
    R2[epub/docx]
    R3[mobi/azw3/pdf]
  end
  subgraph transforms
    T1[opencc 繁简]
    T2[furigana 注音]
  end
  subgraph writers
    W1[txt/epub/kepub]
    W2[mobi/pdf]
  end
  R1 & R2 & R3 --> IR[(Book IR<br/>ir.js)]
  IR --> T1 --> T2 --> IR2[(Book IR)]
  IR2 --> W1 & W2
  ir.js -. 各模块 import '../ir.js' .-> IR
```

模块依赖是无环 DAG：`readers/* 与 writers/epub → ir`；`readers/zip → readers/{txt,md,epub}`；`writers/kepub → writers/epub`；`transforms/*` 自足。

UI 层两文件**双向 import**：`pipeline.js` 从 `app.js` 取页面能力（建卡片 `makeCard`、落地下载 `presentOutput`、按需加载引擎 `ensureMammoth/ensurePdf/ensureFurigana`），`app.js` 从 `pipeline.js` 取入队函数 `enqueue`。`app.js` 是入口先求值，`pipeline.js` 顶层只定义闭包、不在求值期调用 `app.js` 的函数，故循环 import 无 TDZ 风险。

第三方库（JSZip / OpenCC / mammoth / pdf.js / kuromoji）**运行时从 CDN 多源回退加载**（`app.js` 的 `loadFrom`），不打进产物、不进仓库。

## 本地开发

原生 ESM 不能用 `file://` 双击打开（浏览器 CORS 会拦截 module 加载），用任意静态 http server：

```sh
python3 -m http.server 8000   # 然后访问 http://127.0.0.1:8000/index.html
```

改代码即改文件、刷新即生效，无需构建。要新增/修改某个格式的读写，只动对应的 `src/readers/*.js` 或 `src/writers/*.js`，产出/消费 Book IR 即可，不必碰其它格式。

## 隐私

用户文件的内容与文件名**从不发往网络**——没有任何上传、后端或 API 调用。唯一的外部请求是从 CDN 加载上述公共库（以及日语词典的 CDN 兜底源，线上默认走同源 `dict/`）。

---

> 项目的工程文档（开发规范、验收门禁、调度体系）与测试套件不在本仓库的部署面内，保留在工作目录并单独备份。
