// ===== 中间省略（middle ellipsis）：把一段文字拆成「头 + 尾」两段 =====
// 纯 CSS 做不到中间省略（只有 text-overflow: ellipsis 的末尾省略），这里把文字
// 拆成两个相邻 <span> 的文本：头一段由 CSS 收缩并在末尾显示省略号（.me-head），
// 尾一段不收缩（.me-tail）。两段拼接恒等于原文，所以容器的 textContent、复制
// 行为都和单段文本一致；窗口够宽时 CSS 不画省略号，看不出拆过分段。
// 纯函数不碰 DOM，方便单测；markup 侧只负责 escapeHtml 后把两段并排输出。

/**
 * 通用拆分：尾段取原文最后 tailLength 个字符；原文不比尾段长时头段为空、
 * 整段放进尾段（不显示省略号，省略号只在 CSS 溢出时出现）。
 */
export function splitMiddleEllipsis(text, tailLength) {
  const source = String(text ?? "");
  const length = Number.isFinite(tailLength) ? Math.max(0, Math.floor(tailLength)) : 0;
  if (length <= 0 || source.length <= length) return { head: "", tail: source };
  let cut = source.length - length;
  // 不从一个表情符号（UTF-16 代理对）的中间切开：切点落在低位代理上时往前挪一位。
  if (isLowSurrogate(source.charCodeAt(cut)) && isHighSurrogate(source.charCodeAt(cut - 1))) cut -= 1;
  return { head: source.slice(0, cut), tail: source.slice(cut) };
}

const isHighSurrogate = (code) => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code) => code >= 0xdc00 && code <= 0xdfff;

// 扩展名：最后一个点之后 1–8 个字母或数字。标题不一定是文件名（比如「图1. 很长的一句
// 说明」），点后面是一长串文字时不能当扩展名整段塞进不收缩的尾段。
const FILE_EXTENSION = /\.[A-Za-z0-9]{1,8}$/;

/**
 * 文件名：尾段 = 主文件名的最后 4 个字符 + 扩展名（含点，如 `…ame.png`）；
 * 没有扩展名（最后一个点在开头或不存在，`.hidden` 不算扩展名）时取最后 8 个字符。
 */
export function fileNameEllipsisSegments(name) {
  const source = String(name ?? "");
  const extension = FILE_EXTENSION.exec(source)?.[0] || "";
  const dot = source.length - extension.length;
  if (extension && dot > 0) {
    const stemTail = source.slice(Math.max(0, dot - 4), dot);
    return splitMiddleEllipsis(source, stemTail.length + extension.length);
  }
  return splitMiddleEllipsis(source, 8);
}

/**
 * 路径：尾段 = 最后一个路径分隔符（/ 或 \，含分隔符本身）起到结尾，也就是
 * 文件名或文件夹名本身；这一段超过 maxTail 个字符时只取最后 maxTail 个。
 * maxTail 默认 24（设置里的素材库路径框够宽）；位置窄的地方传小一点的值。
 */
export function pathEllipsisSegments(path, maxTail = 24) {
  const source = String(path ?? "");
  const separator = Math.max(source.lastIndexOf("/"), source.lastIndexOf("\\"));
  const tailLength = Math.min(source.length - Math.max(separator, 0), maxTail);
  return splitMiddleEllipsis(source, tailLength);
}
