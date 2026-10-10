// 任务 110：中间省略拆分（web/app/middle-ellipsis.mjs）。文件名与素材路径共用
// 「头 + 尾」两段方案：头段由 CSS 收缩显示省略号，尾段不收缩；两段拼接必须等于
// 原文（textContent 与复制行为不变）。逐条断言 head + tail === 原文。Node 标准库，零网络。
import assert from "node:assert/strict";
import test from "node:test";

import { fileNameEllipsisSegments, pathEllipsisSegments, splitMiddleEllipsis } from "../web/app/middle-ellipsis.mjs";

const joined = (segments) => segments.head + segments.tail;

test("splitMiddleEllipsis: tail of the last N characters, whole text goes to tail when short", () => {
  assert.deepEqual(splitMiddleEllipsis("abcdefghij", 4), { head: "abcdef", tail: "ghij" });
  assert.deepEqual(splitMiddleEllipsis("abc", 8), { head: "", tail: "abc" });
  assert.deepEqual(splitMiddleEllipsis("exactly8!", 8), { head: "e", tail: "xactly8!" });
  assert.deepEqual(splitMiddleEllipsis("abc", 0), { head: "", tail: "abc" }, "a zero tail keeps the text whole");
  assert.deepEqual(splitMiddleEllipsis("", 4), { head: "", tail: "" });
  assert.equal(joined(splitMiddleEllipsis("abcdefghij", 4)), "abcdefghij");
});

test("fileNameEllipsisSegments: normal name keeps the last 4 stem characters plus the extension", () => {
  const segments = fileNameEllipsisSegments("report-2026-final.png");
  assert.deepEqual(segments, { head: "report-2026-f", tail: "inal.png" });
  assert.equal(joined(segments), "report-2026-final.png");
});

test("fileNameEllipsisSegments: no extension takes the last 8 characters", () => {
  const segments = fileNameEllipsisSegments("archive-2026-backup");
  assert.deepEqual(segments, { head: "archive-202", tail: "6-backup" });
  assert.equal(joined(segments), "archive-2026-backup");
});

test("fileNameEllipsisSegments: short names put everything in the tail", () => {
  assert.deepEqual(fileNameEllipsisSegments("a.png"), { head: "", tail: "a.png" });
  assert.deepEqual(fileNameEllipsisSegments("ab.png"), { head: "", tail: "ab.png" });
  assert.deepEqual(fileNameEllipsisSegments("cat.png"), { head: "", tail: "cat.png" });
  assert.deepEqual(fileNameEllipsisSegments("小猫.png"), { head: "", tail: "小猫.png" });
  assert.deepEqual(fileNameEllipsisSegments("note"), { head: "", tail: "note" });
});

test("fileNameEllipsisSegments: CJK names count characters, not bytes", () => {
  const segments = fileNameEllipsisSegments("界面截图-最终版.png");
  assert.deepEqual(segments, { head: "界面截图", tail: "-最终版.png" });
  assert.equal(joined(segments), "界面截图-最终版.png");
});

test("fileNameEllipsisSegments: a leading dot is not an extension", () => {
  const segments = fileNameEllipsisSegments(".hidden-file-in-library");
  assert.deepEqual(segments, { head: ".hidden-file-in", tail: "-library" });
  assert.equal(joined(segments), ".hidden-file-in-library");
});

test("pathEllipsisSegments: the last path segment (with its separator) is the tail", () => {
  const segments = pathEllipsisSegments("/Users/azhuilab/Library/Application Support/mosa/library");
  assert.deepEqual(segments, { head: "/Users/azhuilab/Library/Application Support/mosa", tail: "/library" });
  assert.equal(joined(segments), "/Users/azhuilab/Library/Application Support/mosa/library");
});

test("pathEllipsisSegments: backslash paths keep the Windows separator in the tail", () => {
  const segments = pathEllipsisSegments("C:\\Users\\azhuilab\\GravityPort Library");
  assert.deepEqual(segments, { head: "C:\\Users\\azhuilab", tail: "\\GravityPort Library" });
  assert.equal(joined(segments), "C:\\Users\\azhuilab\\GravityPort Library");
});

test("pathEllipsisSegments: a final segment longer than 24 characters is clipped to 24", () => {
  const path = "/srv/data/a-really-long-folder-name-over-24-chars";
  const segments = pathEllipsisSegments(path);
  assert.equal(segments.tail.length, 24);
  assert.deepEqual(segments, { head: "/srv/data/a-really-long-f", tail: "older-name-over-24-chars" });
  assert.equal(joined(segments), path);
});

test("pathEllipsisSegments: no separator or short paths go whole into the tail", () => {
  assert.deepEqual(pathEllipsisSegments("library-folder"), { head: "", tail: "library-folder" });
  assert.deepEqual(pathEllipsisSegments("/library"), { head: "", tail: "/library" });
  const longName = "a-standalone-name-longer-than-twenty-four-characters";
  const segments = pathEllipsisSegments(longName);
  assert.equal(segments.tail.length, 24);
  assert.equal(joined(segments), longName);
});

test("fileNameEllipsisSegments: text after a dot only counts as an extension when it is 1-8 letters or digits", () => {
  // 标题不一定是文件名：点后面是一长串文字时，不能整段塞进不收缩的尾段。
  const title = "图1. 一个很长很长的标题描述文字说明";
  const segments = fileNameEllipsisSegments(title);
  assert.equal(segments.tail, "标题描述文字说明", "falls back to the last 8 characters");
  assert.equal(joined(segments), title);
  assert.deepEqual(fileNameEllipsisSegments("archive-2026.tar.gz"), { head: "archive-2026", tail: ".tar.gz" });
  assert.deepEqual(fileNameEllipsisSegments("notes v1.5 final draft"), { head: "notes v1.5 fin", tail: "al draft" });
});

test("splitMiddleEllipsis: never cuts through the middle of an emoji", () => {
  const segments = splitMiddleEllipsis("abc\u{1F600}def", 4);
  assert.deepEqual(segments, { head: "abc", tail: "\u{1F600}def" }, "the cut moves in front of the surrogate pair");
  const name = "可爱的猫咪\u{1F600}\u{1F600}\u{1F600}.png";
  const named = fileNameEllipsisSegments(name);
  assert.equal(joined(named), name);
  assert.ok(!/^[\udc00-\udfff]/.test(named.tail), "the tail does not start with a lone low surrogate");
});

test("pathEllipsisSegments: a narrower slot can ask for a shorter tail", () => {
  const path = "/Users/me/GravityPort Library/assets/default/original/sample-40-mv2hz112-7d7d83ad.png";
  const segments = pathEllipsisSegments(path, 12);
  assert.equal(segments.tail, "7d7d83ad.png");
  assert.equal(joined(segments), path);
  assert.deepEqual(pathEllipsisSegments("/library", 12), { head: "", tail: "/library" });
});
