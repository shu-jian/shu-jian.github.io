/* ============================================================
 * src/writers/txt.js · Book IR → 纯文本 TXT
 *
 * 契约：docs/harness/BOOK-IR.md §5「txt」一行。
 *   用到字段：chapters.title + html 的纯文本
 *   丢弃字段：resources（图片）/ notes（脚注）/ nav（目录）/ ruby（注音）
 *     —— TXT 格式的固有限制，不是实现缺陷，BOOK-IR.md §5 已登记。
 *   丢弃需提示用户（文案由 ux-writer 定稿，本文件不写）：
 *     「纯文本不能保留图片和注释」
 *
 * 输出：UTF-8 with BOM（REQUIREMENTS.md R3）。
 * 环境中立：只用标准 JS 全局（TextEncoder，Node ≥ 18 与浏览器均有），
 *   不碰 DOM，不做网络请求。
 *
 * IR 只读：本模块不修改传入的 book，也不深拷贝后修改——从头到尾只读取。
 *
 * 返回值类型说明（与 test/roundtrip.mjs 的实测约定对齐，未自创接口）：
 *   返回 Uint8Array（原始字节，含 BOM），不是 Blob。
 *   实测 `new Uint8Array(blob)` 在 Node/浏览器均不解出字节（得到空数组），
 *   test/roundtrip.mjs 正是用 `new Uint8Array(outBytes)` 回读产物，
 *   若返回 Blob 会导致"文件是空的"这类误报（已用真实 txt reader 验证）。
 *   调用方（UI 下载逻辑）可用一行代码转成 Blob：
 *     new Blob([bytes], { type: 'text/plain;charset=utf-8' })
 * ============================================================ */

import { plainText } from '../ir.js';

/** 主线程让出一次 tick，避免大部头转换时页面假死 */
function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * 把单章渲染成一段纯文本：
 *   标题（若非 null）独立一行，空一行，再接正文。
 *   正文段落之间以单个换行分隔——章节内部的空行不承载任何结构信息，
 *   纯文本 reader 按"非空行即一个段落"解析，空行只是排版留白。
 * HTML 标签与内联样式全部丢弃，HTML 实体经 plainText() 反解码为明文
 *   （decode 由 src/ir.js 的 plainText 统一实现，避免各 writer 各写一遍）。
 */
function renderChapter(chapter) {
  const body = plainText(chapter && chapter.html);
  const rawTitle = chapter && chapter.title;
  const title = typeof rawTitle === 'string' ? rawTitle.trim() : null;
  if (title) return body ? `${title}\n\n${body}` : title;
  return body;
}

/**
 * @param {import('../ir.js').Book} book    只读，不修改
 * @param {object} [opts]                   预留（当前无可配置项）
 * @param {(p:number)=>void} [onProgress]   进度回调，取值 0..1
 * @returns {Promise<Uint8Array>}           原始字节（含 UTF-8 BOM），见文件头说明
 */
export async function write(book, opts = {}, onProgress = () => {}) {
  onProgress(0);

  const chapters = Array.isArray(book && book.chapters) ? book.chapters : [];
  const total = Math.max(chapters.length, 1);
  const blocks = [];

  for (let i = 0; i < chapters.length; i++) {
    const rendered = renderChapter(chapters[i]);
    if (rendered) blocks.push(rendered);

    onProgress(Math.min(0.9, ((i + 1) / total) * 0.9));

    // 每 20 章让出一次主线程：大部头书（几千章）转换时不让页面假死
    if (i > 0 && i % 20 === 0) await tick();
  }

  const text = blocks.join('\n\n');

  // UTF-8 with BOM（EF BB BF）
  const BOM = new Uint8Array([0xef, 0xbb, 0xbf]);
  const encoded = new TextEncoder().encode(text);
  const out = new Uint8Array(BOM.length + encoded.length);
  out.set(BOM, 0);
  out.set(encoded, BOM.length);

  onProgress(1);
  return out;
}
