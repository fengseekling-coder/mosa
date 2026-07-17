# GPT Asset Manager

本地优先的 GPT/Codex 生成素材管理器。第一版目标是跑通最小闭环：

- 把 Codex/Cowart 生成图片复制进素材库。
- 为每张图片保存 full prompt、skill、style、比例、业务字段和版本关系。
- 在 Web UI 中搜索、查看、复制 prompt。
- 把素材重新插入现有 Cowart 画布。
- 通过 MCP 工具让 Codex 后续直接调用 `asset_create`、`asset_list`、`asset_get` 和 `canvas_insert_asset`。

## 运行

```bash
cd /Users/azhuilab/codex_aigc
node asset-manager/server.mjs
```

打开：

```text
http://127.0.0.1:43517
```

## 当前 MVP 使用流

1. 打开 Web App。
2. 点“同步 Cowart 图片”，把现有 Cowart 画布图片复制进素材库。
3. 点任意图片，在右侧补写或修改 prompt、skill、style、ratio、theme 和 business fields。
4. 点“复制 prompt”去 GPT/Codex 复现。
5. 点“放到画布”把素材重新插入 Cowart。
6. 点“同配方再生成”复制一段可直接发给 Codex 的再生成指令。

Codex 生成新图后，可以通过 Web UI 的“导入本地图片”保存，也可以通过 MCP 的 `asset_create` 写入。

## Codex 默认生图来源

素材管理器默认允许从 Codex Desktop 的生图目录读取图片：

```text
~/.codex/generated_images/<task-id>/<image>.png
```

导入时会把图片复制进本项目的素材库，并在 `source` 元数据中保留 Codex 原始路径、任务 ID 和相对路径；库内图片、Prompt 与 JSON 元数据仍保存在本项目中，避免 Codex 运行目录变化导致素材丢失。

如需覆盖默认来源目录，可在启动前设置：

```bash
CODEX_GENERATED_IMAGES_DIR=/custom/codex/generated_images node asset-manager/server.mjs
```

## 数据结构

```text
asset-manager/
├── assets/
│   └── default/
│       ├── images/
│       ├── prompts/
│       └── metadata/
├── app/
├── lib/
└── mcp/
```

每张素材会保存：

```text
images/<asset-id>.png
metadata/<asset-id>.json
prompts/<asset-id>.md
```

## MCP

```bash
cd /Users/azhuilab/codex_aigc
node asset-manager/mcp/server.mjs
```

当前工具：

- `asset_create`
- `asset_list`
- `asset_get`
- `asset_update_metadata`
- `asset_attach_prompt`
- `canvas_insert_asset`

## API 例子

```bash
curl -sS http://127.0.0.1:43517/api/assets?project=default
```

```bash
curl -sS -X POST http://127.0.0.1:43517/api/assets/create \
  -H 'content-type: application/json' \
  -d '{
    "projectId": "default",
    "imagePath": "/Users/azhuilab/.codex/generated_images/<task-id>/<image>.png",
    "prompt": "full prompt here",
    "skill": "punk-cover",
    "style": "black-white-gray-avant-geometry",
    "ratio": "9:16",
    "theme": "orbital-luxury-vault",
    "source": {
      "generation_tool": "imagegen",
      "model": "gpt-5.6",
      "codex_session_id": "optional-session-id"
    },
    "business_fields": {
      "product": "Hennessy V.S.O.P / Martell Noblige",
      "price": "¥10,880"
    }
  }'
```

## 当前边界

- 第一版只用本地文件，不使用数据库。
- “自动截获网页版 GPT 真实 prompt”还没有做，需要后续浏览器扩展或 GPT 侧导出能力。
- “用同配方再生成”现在先复制 Codex 指令，不直接调用图像模型。
- “放到画布”会优先走正在运行的 Cowart API；Cowart 没运行时会直接写入画布 JSON，刷新 Cowart 后可见。
