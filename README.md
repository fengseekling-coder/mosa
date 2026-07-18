# Codex Asset Manager

本地优先的 Codex 图片素材库：把可复用的图片、完整 Prompt、生成上下文和来源信息保存在同一个项目中，并提供 Web 搜索、编辑与复用入口。

> Codex images enter through MCP; Cowart canvas images enter through a project-scoped bridge. Both are stored locally and remain traceable.

## 它如何归档图片

| 来源 | 归档方式 | 保存的信息 | 需要的前提 |
| --- | --- | --- | --- |
| Codex 生图 | Codex 调用 MCP `asset_create`，把实际图片路径复制入库 | 完整 Prompt、模型、任务 ID、原始路径、配方字段 | 注册 Asset Manager MCP，并让生成任务调用该工具 |
| Cowart 画布 | 素材管理器服务读取已保存的 Cowart 画布快照，自动同步新页面图片 | 图片、画布描述、尺寸、画布对象与页面资产来源 | 服务保持运行；Cowart 使用本项目配置的画布目录 |

这不是“安装 Codex 后全局扫描所有图片或所有画布”。Codex 路径是 MCP 工具驱动的；Cowart 路径只监听当前项目配置的画布目录。这样的边界能避免误收其他项目或个人文件。

## 快速开始

前提：已安装 Node.js 与 npm。若要使用生成归档，还需要 Codex Desktop；Cowart 归档则额外需要已安装 Cowart 插件。

```bash
cd /absolute/path/to/asset-manager
npm ci
npm start
```

打开 <http://127.0.0.1:43517>。

服务运行期间，Cowart 桥接器也会同时启动。请保持这个终端或将服务交给你自己的进程管理方式；停止 `npm start` 后，Cowart 自动归档也会停止。

基础验证：

```bash
npm test
curl -sS http://127.0.0.1:43517/api/cowart-bridge
```

状态接口中 `enabled`、`watching` 和 `polling` 都为 `true`，表示 Cowart 自动归档已启用。`polling` 是文件系统没有传递变更事件时的 2 秒兜底同步。

## 一次性连接 Codex MCP

在终端注册 MCP。将路径替换成自己的绝对路径：

```bash
codex mcp add asset-manager \
  --env ASSET_MANAGER_PROJECT_DIR=/absolute/path/to/your/workspace \
  -- node /absolute/path/to/asset-manager/mcp/server.mjs
```

注册后新开一个 Codex 任务，使 MCP 工具加载完成。图片生成后，任务应调用 `asset_create` 并传入图像工具返回的实际 `imagePath`；同一次调用还可以传入完整 `prompt`、`generation_tool`、`model` 与 `codex_session_id`。

`asset_create` 会将文件复制到素材库，并保存：

- 原始图片路径和 Codex 任务目录 ID；
- 完整 Prompt 与配方字段；
- `generation_tool`、`model`、`codex_session_id` 等可用的生成上下文；
- 库内副本，避免 Codex 临时运行目录变化后素材丢失。

Codex 默认允许的来源目录是：

```text
~/.codex/generated_images/<task-id>/<image>.png
```

当前版本不会扫描这整个目录来猜测 Prompt；只有通过 `asset_create` 提交的图片才会以 Codex 来源归档。这样完整 Prompt 的来源是可验证的。

## Cowart 自动归档

启动素材管理器后，内置桥接器会监听以下项目级目录：

```text
~/.codex/cowart-data/asset-manager/pages/
```

Cowart 在这个目录保存画布后，新生成的图片、AI 图片框替换结果和批注编辑结果都会自动入库。桥接器以 Cowart 画布快照中的页面资产路径去重；从素材管理器插回画布的图片会携带来源 ID，桥接器会跳过它，避免重复归档。

Cowart 快照仅提供画布描述（alt text），不保存完整生图 Prompt。因此 Cowart 自动归档的素材会明确标记为 `canvas-alt-text-only`；需要完整 Prompt 时，可在详情页后补或从原生成任务补录。

常用的 Codex 工作流：

- **“启动素材管理”**：运行本地素材库并打开 Web App。
- **“启动画布”**：打开 Cowart 的原生 Codex 画布。
- **“把当前素材插入画布”**：先通过 `asset_get` 读取素材，再插入 Cowart，并携带 Asset Manager 来源 ID 防重。

Cowart 是外部 Codex 插件，运行数据刻意保存在仓库外，不会被复制或提交进本项目。首次安装或升级 Cowart 后，请新开一个 Codex 任务以加载其 MCP 工具。

### 使用其他 Cowart 画布目录

默认桥接目录名为 `asset-manager`。若你的 Cowart 画布使用其他外部目录，请在启动服务时显式指定同一个目录：

```bash
COWART_ASSET_MANAGER_CANVAS_DIR=/absolute/path/to/cowart-data/my-project npm start
```

素材管理器只会监听这个指定目录，不会自动监听机器上的其他 Cowart 项目。

## 最短端到端验证

1. 运行 `npm start`，打开 Web App。
2. 确认 Codex MCP 已注册后，新开一个 Codex 任务。
3. 生成一张图片，并由任务调用 `asset_create`；在 Web 中搜索新 Asset ID，确认完整 Prompt、模型和原始路径。
4. 打开同一项目的 Cowart 画布，生成、替换或批注编辑一张图片并保存画布。
5. 等待最多 2 秒，回到 Web 查看带有 **Cowart** 来源标记的新素材；也可访问 `/api/cowart-bridge` 查看同步状态。
6. 将一张库内素材插回画布，确认素材总数没有因同一文件再次增加。

## 可配置项

| 环境变量 | 默认值 | 用途 |
| --- | --- | --- |
| `ASSET_MANAGER_PROJECT_DIR` | 素材管理器目录的父目录 | 工作区根目录，用于确定项目上下文 |
| `ASSET_MANAGER_PORT` | `43517` | Web 服务本地端口 |
| `CODEX_GENERATED_IMAGES_DIR` | `~/.codex/generated_images` | 允许 `asset_create` 读取的 Codex 图片来源根目录 |
| `COWART_ASSET_MANAGER_CANVAS_DIR` | `~/.codex/cowart-data/asset-manager` | Cowart 项目画布数据目录，也是自动归档的唯一监听范围 |

## 本地数据结构

```text
asset-manager/
├── assets/
│   └── default/
│       ├── images/       # 素材库图片副本
│       ├── prompts/      # 可编辑的 Prompt 文本
│       └── metadata/     # JSON 元数据与来源信息
├── app/                  # 本地 Web UI
├── lib/                  # 素材存储与 Cowart 桥接器
└── mcp/                  # Codex MCP 服务
```

Cowart 运行数据不在仓库中：

```text
~/.codex/cowart-data/asset-manager/
```

### Git 与本地素材

素材库的运行期图片、Prompt 与元数据保存在本地 `assets/<project>/` 下，但新的归档记录默认被 `.gitignore` 忽略，避免每次 Codex 或 Cowart 生成图片都弄脏工作区。仓库中已经跟踪的素材仅作为演示样例；如果要把某个新素材作为正式样例提交，请确认不含敏感内容后显式执行：

```bash
git add -f assets/default/images/<asset>.png \
  assets/default/prompts/<asset>.md \
  assets/default/metadata/<asset>.json
```

本地 HTTP 服务只接受同源浏览器请求，不应通过远程网页、反向代理或公网端口暴露。

## MCP 工具

- `asset_create`
- `asset_list`
- `asset_get`
- `asset_update_metadata`
- `asset_attach_prompt`

可以直接在仓库父目录运行 MCP 服务进行本地调试：

```bash
cd /absolute/path/to/your/workspace
node asset-manager/mcp/server.mjs
```

## 当前边界

- 数据以本地文件保存，第一版不使用数据库或云同步。
- Codex 图片归档依赖 MCP `asset_create`，不是桌面级图片监控。
- Cowart 自动归档依赖素材管理器服务运行，并且只覆盖配置的一个画布目录。
- Cowart 自动归档保留画布描述，不具备完整 Prompt；原始 Prompt 需要从生成任务补录。
- “同配方再生成”当前复制 Codex 指令，不直接调用图像模型。

## Build Week 演示清单

1. 展示 Codex 生成图片并调用 `asset_create`，证明完整 Prompt 与来源入库。
2. 展示 Cowart 中生成或编辑图片后，无需额外入库指令即出现在素材库。
3. 在 Web 中搜索素材，打开详情页展示 Prompt、配方和来源。
4. 将库内素材插入 Cowart，展示去重保护与可复用性。
5. 提交前记录主构建任务的 `/feedback` Session ID，并在项目描述中说明 Codex 与 GPT-5.6 如何完成闭环。
