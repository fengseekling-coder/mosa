// 任务 18 回归：分组导出（mosa-group-<名称>.json）不得携带本机绝对路径、目录
// 路径或只有本机服务能解析的 /library/... 链接。清洗规则在 web/app/utils.mjs 的
// sanitizeAssetForExport：只按字段名删除（*_path、*_url、*_dir、path、
// prompt_file），递归处理嵌套对象与数组；用户写的内容（提示词、标签、业务字段
// 文字）与 asset（库内文件名）必须原样保留。web/app 与 desktop/app 双树各有一份
// 拷贝，逐字节一致是仓库级约定（diff -rq 只允许 build-identity.json 与
// styles.css）。
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import { sanitizeAssetForExport } from "../web/app/utils.mjs";

const root = resolve(import.meta.dirname, "..");

// 覆盖接口返回的全部路径/链接字段形态：顶层文件路径、顶层运行时 URL、
// 遗留 prompt_file，以及嵌套在 source、references、business_fields 里的同类字段。
function fullyLoadedAsset() {
  return {
    id: "asset-1",
    project_id: "default",
    asset: "asset-1.png",
    image_path: "/Users/someone/Library/Application Support/MOSA Library/assets/default/images/asset-1.png",
    preview_path: "/Users/someone/Library/Application Support/MOSA Library/assets/default/previews/asset-1.webp",
    medium_path: "/Users/someone/Library/Application Support/MOSA Library/assets/default/mediums/asset-1.webp",
    thumbnail_path: "/Users/someone/Library/Application Support/MOSA Library/assets/default/thumbnails/asset-1.webp",
    prompt_path: null,
    prompt_file: null,
    image_url: "/library/default/images/asset-1.png",
    preview_url: "/library/default/previews/asset-1.webp",
    medium_url: "/library/default/mediums/asset-1.webp",
    thumbnail_url: "/library/default/thumbnails/asset-1.webp",
    preview_ready: true,
    medium_ready: false,
    thumbnail_ready: true,
    prompt: "/绝对路径开头的提示词也必须原样保留 C:\\windows\\style 不受影响",
    user_prompt: "",
    negative_prompt: "",
    skill: "",
    style: "水墨",
    ratio: "1:1",
    theme: "",
    tags: ["标签A", "ref"],
    favorite: true,
    archived: false,
    deleted_at: null,
    group: "导出组",
    category: "分类X",
    rating: 4,
    parent_asset_id: null,
    version_change: "",
    child_asset_ids: ["asset-2"],
    created_at: "2026-09-30T00:00:00.000Z",
    updated_at: "2026-09-30T01:00:00.000Z",
    business_fields: {
      provider: "openai",
      media_kind: "image",
      note: "业务文字保留",
      nested: { model_hint: "gpt", leaked_path: "/Users/someone/secret.png", leaked_url: "/library/default/images/asset-1.png" },
    },
    source: {
      type: "codex-generated",
      path: "/Users/someone/.codex/generated_images/task/generated.png",
      copied_at: "2026-09-30T00:00:00.000Z",
      generation_tool: "imagegen",
      model: "gpt-test",
      content_sha256: "03738e21",
      storage_mode: "hard-link",
    },
    references: [
      {
        asset_id: "asset-0",
        reference_id: "asset-0",
        sha256: "deadbeef",
        attachment_url: "/library/default/attachments/asset-0.bin",
        mime_type: "image/png",
        role: "reference",
        scope: ["generation"],
        applied: true,
        allowed_uses: [],
        forbidden_uses: [],
        rights: { source: "user-upload" },
      },
    ],
  };
}

test("group export sanitize removes every path and url field by name, recursively", () => {
  const clean = sanitizeAssetForExport(fullyLoadedAsset());

  for (const key of [
    "image_path", "preview_path", "medium_path", "thumbnail_path", "prompt_path", "prompt_file",
    "image_url", "preview_url", "medium_url", "thumbnail_url",
  ]) {
    assert.equal(Object.hasOwn(clean, key), false, `top-level ${key} must be removed`);
  }
  assert.equal(Object.hasOwn(clean.source, "path"), false, "source.path must be removed");
  assert.equal(Object.hasOwn(clean.business_fields.nested, "leaked_path"), false, "nested *_path must be removed");
  assert.equal(Object.hasOwn(clean.business_fields.nested, "leaked_url"), false, "nested *_url must be removed");
  assert.equal(Object.hasOwn(clean.references[0], "attachment_url"), false, "references[].attachment_url must be removed");
  // 整棵树上不再有任何以 _path / _url 结尾的键名，也没有裸 path。
  const collectKeys = (value, out = []) => {
    if (Array.isArray(value)) { value.forEach((item) => collectKeys(item, out)); return out; }
    if (value && typeof value === "object") {
      for (const [key, item] of Object.entries(value)) { out.push(key); collectKeys(item, out); }
    }
    return out;
  };
  const keys = collectKeys(clean);
  assert.equal(keys.filter((key) => /(_path|_url|_dir)$/.test(key) || key === "path" || key === "prompt_file").length, 0,
    `no path/url-ish key may survive: ${JSON.stringify(keys)}`);
  // 整个导出对象序列化后不再出现任何本机路径片段。
  assert.equal(JSON.stringify(clean).includes("/Users/someone"), false, "no absolute user path may survive");
});

test("group export sanitize keeps user content, metadata, and the asset file name", () => {
  const asset = fullyLoadedAsset();
  const clean = sanitizeAssetForExport(asset);

  assert.equal(clean.asset, "asset-1.png", "asset (managed file name) is kept for cross-reference");
  assert.equal(clean.prompt, asset.prompt, "prompts keep leading slashes and Windows-style text verbatim");
  assert.deepEqual(clean.tags, ["标签A", "ref"]);
  assert.deepEqual(clean.business_fields.provider, "openai");
  assert.equal(clean.business_fields.note, "业务文字保留");
  assert.equal(clean.business_fields.nested.model_hint, "gpt");
  assert.equal(clean.source.type, "codex-generated");
  assert.equal(clean.source.generation_tool, "imagegen");
  assert.equal(clean.source.storage_mode, "hard-link");
  assert.equal(clean.references[0].role, "reference");
  assert.deepEqual(clean.references[0].rights, { source: "user-upload" });
  assert.equal(clean.group, "导出组");
  assert.equal(clean.category, "分类X");
  assert.equal(clean.rating, 4);
  assert.equal(clean.created_at, asset.created_at);
  assert.equal(clean.updated_at, asset.updated_at);
  assert.deepEqual(clean.child_asset_ids, ["asset-2"]);
});

test("cowart-bridge source fields: _dir/_path/_url removed, id and tool kept", () => {
  // lib/cowart-bridge.ts 归档 Cowart 画布时写入 source 的完整字段形态：
  // cowart_project_dir / cowart_canvas_dir 是本机绝对路径（键名 _dir 结尾），
  // cowart_page_asset_path / cowart_page_asset_url 是页面素材的路径与链接。
  const clean = sanitizeAssetForExport({
    id: "cowart-1",
    asset: "cowart-1.png",
    prompt: "canvas alt text",
    source: {
      type: "cowart-generated",
      generation_tool: "cowart",
      path: "/Users/someone/Cowart/pages/page.html",
      cowart_source_id: "src-1",
      cowart_project_dir: "/Users/someone/Cowart/projects/demo",
      cowart_canvas_dir: "/Users/someone/Cowart/projects/demo/canvas",
      cowart_page_id: "page-42",
      cowart_page_asset_path: "/Users/someone/Cowart/projects/demo/assets/cover.png",
      cowart_page_asset_url: "https://cowart.example/assets/cover.png",
      cowart_asset_id: "asset-9",
      content_sha256: "03738e21",
    },
  });

  for (const key of ["path", "cowart_project_dir", "cowart_canvas_dir", "cowart_page_asset_path", "cowart_page_asset_url"]) {
    assert.equal(Object.hasOwn(clean.source, key), false, `source.${key} must be removed`);
  }
  assert.equal(clean.source.generation_tool, "cowart");
  assert.equal(clean.source.cowart_page_id, "page-42");
  assert.equal(clean.source.cowart_source_id, "src-1");
  assert.equal(clean.source.cowart_asset_id, "asset-9");
  assert.equal(clean.source.content_sha256, "03738e21");
  assert.equal(clean.prompt, "canvas alt text");
  assert.equal(JSON.stringify(clean).includes("/Users/someone"), false, "no absolute user path may survive");
});

test("group export sanitize does not mutate its input", () => {
  const asset = fullyLoadedAsset();
  sanitizeAssetForExport(asset);
  assert.equal(asset.image_path.startsWith("/Users/someone"), true, "the in-memory API object stays untouched");
});

test("both twin-tree copies of sanitizeAssetForExport are byte-identical", async () => {
  const marker = "export function sanitizeAssetForExport";
  const extract = async (relativePath) => {
    const source = await readFile(resolve(root, relativePath), "utf8");
    const from = source.indexOf(marker);
    assert.ok(from >= 0, `${relativePath} must define sanitizeAssetForExport`);
    return source.slice(from);
  };
  assert.equal(await extract("web/app/utils.mjs"), await extract("desktop/app/utils.mjs"));
});
