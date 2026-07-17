# GPT Asset Manager

本地优先的 GPT/Codex 生成素材管理器。第一版目标是跑通最小闭环：

> An offline-first asset manager for Codex-generated images: preserve the image, prompt recipe, provenance, and reuse path in one local library.

- 把 Codex/Cowart 生成图片复制进素材库。
- 为每张图片保存 full prompt、skill、style、比例、业务字段和版本关系。
- 在 Web UI 中搜索、查看、复制 prompt。
- 把素材重新插入现有 Cowart 画布。
- 通过 MCP 工具让 Codex 后续直接调用 `asset_create`、`asset_list`、`asset_get` 和 `canvas_insert_asset`。

## 快速开始

```bash
cd asset-manager
npm ci
npm start
```

打开：

```text
http://127.0.0.1:43517
```

运行自动化验证：

```bash
npm test
```

## 当前 MVP 使用流

1. 打开 Web App。
2. 点“同步 Cowart 图片”，把现有 Cowart 画布图片复制进素材库。
3. 点任意图片，在右侧补写或修改 prompt、skill、style、ratio、theme 和 business fields。
4. 点“复制 prompt”去 GPT/Codex 复现。
5. 点“放到画布”把素材重新插入 Cowart。
6. 点“同配方再生成”复制一段可直接发给 Codex 的再生成指令。

Codex 生成新图后，可以通过 Web UI 的“导入本地图片”保存，也可以通过 MCP 的 `asset_create` 写入。

## Codex + MCP 闭环

本项目的核心演示流程是：

```text
Codex 生成图片 → asset_create → 本地图片/Prompt/JSON 入库 → Web 搜索与复用
```

在 Codex 中注册 MCP（将两个绝对路径替换为你的本机路径）：

```bash
codex mcp add asset-manager \
  --env ASSET_MANAGER_PROJECT_DIR=/absolute/path/to/your/workspace \
  -- node /absolute/path/to/asset-manager/mcp/server.mjs
```

注册后新开一个 Codex 任务。生成图片后，要求 Codex 调用 `asset_create`，并传入图像工具返回的实际 `imagePath`、完整 Prompt、配方字段与可用的生成上下文，例如 `generation_tool`、`model`、`codex_session_id`。

`asset_create` 会自动识别 Codex 默认生图目录，并将以下来源信息写入元数据：

- `source.type: "codex-generated"`
- Codex 原始图片路径与任务目录 ID
- `generation_tool`、`model`、`codex_session_id`（若调用方提供）

它不会通过网页抓取 Prompt；完整 Prompt 必须由生成该图片的 Codex 任务传入，避免不可验证的猜测。

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

## Build Week 演示清单

1. 在新 Codex 任务中生成一张图。
2. 展示 Codex 调用 `asset_create`，而不是网页手动导入。
3. 在 Web 中搜索新 Asset ID，打开详情页展示完整 Prompt、配方和 Source。
4. 复制 Prompt 或使用“同配方再生成”展示可复用性。
5. 在提交前记录主构建任务的 `/feedback` Session ID，并在项目说明中说明 Codex 与 GPT-5.6 如何完成这条闭环。
