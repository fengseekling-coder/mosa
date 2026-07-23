# MOSA 中文使用指南

MOSA 是面向 Codex、Cowart 和本地 Grok Build CLI 的本地创作素材库。它不负责生图，而是在媒体生成或画布编辑后，自动把图片/视频、Prompt、来源、参数、版本和画布上下文归档为可检索、可复用的本地素材。

## 产品边界

- **Codex** 负责 AI 生成、理解和任务执行。
- **Cowart** 负责画布编排与编辑。
- **Grok Build CLI** 可在本地生成图片与视频。
- **MOSA** 负责自动收集、归档、检索、版本管理和回插。

MOSA 当前是本地 Web 应用，不是云服务或 macOS `.app`。它不包含额外 AI 模型、Embedding 搜索或远程同步，也不调用 Grok API，也不应通过公网或反向代理暴露。

## 环境要求

- macOS、Node.js 22 或更高版本、npm。
- 要自动归档 Codex 生图，需要安装 Codex Desktop。
- 要自动归档 Grok 媒体，需要本机已登录并可写入 `~/.grok/sessions` 的 Grok Build CLI。
- Cowart 自动归档和一键回插需要安装 Cowart 插件；不使用 Cowart 时不影响 MOSA 的其他功能。

## 本地启动

以下命令启动开发/本地服务，默认地址为 `http://127.0.0.1:43517`：

```bash
git clone https://github.com/fengseekling-coder/mosa.git
cd mosa
npm ci
npm test
npm start
```

仓库内含演示样本，适合开发和测试。真实个人素材库应使用独立目录，不要把仓库工作目录当作生产素材库。

## SQLite 素材库与迁移

默认运行期素材库为 `~/MOSA Library`。迁移完成后，里面包含 `mosa.db`、原图、预览图、缩略图和 JSON/Prompt 备份：

```text
~/MOSA Library/
├── mosa.db
├── assets/<project>/original/
├── assets/<project>/previews/
├── assets/<project>/thumbnails/
└── legacy-json-backup/
```

迁移前先做只读检查：

```bash
npm exec mosa -- migrate --dry-run --library /absolute/path/to/library
```

确认无问题后再迁移、校验和补全派生图：

```bash
npm exec mosa -- migrate --library /absolute/path/to/library
npm exec mosa -- verify --library /absolute/path/to/library
npm exec mosa -- thumbnails rebuild --library /absolute/path/to/library
```

迁移会校验 JSON、原图、哈希和空分组。未完成或失败时不会激活 SQLite；完成后 SQLite 是唯一运行期权威，JSON 只保留为备份和兼容回退，不做双写。

## 自动归档

### Codex 生图

服务运行时，MOSA 只监听 `~/.codex/generated_images/`。它会匹配对应 Codex 任务的本地会话 JSONL：优先保存生图事件中的 `revised_prompt`，缺失时才回退保存任务最后一条用户指令，并明确记录 Prompt 的来源状态。

MOSA 不扫描 Downloads、桌面或任意本地图片目录。原图在同一文件系统时优先硬链接入库，跨文件系统时才复制。

### Grok Build CLI 媒体

服务运行时，MOSA 只监听 `~/.grok/sessions/`（可用 `GROK_SESSIONS_DIR` 覆盖）。它只发现各会话目录下 `images/` 与 `videos/` 中的媒体，并读取同会话的 `chat_history.jsonl` 提取工具参数中的 Prompt、模型与工具名。

Prompt 优先级：仅在工具调用与 tool_result 能匹配到该媒体路径时使用工具参数 Prompt；匹配成功但工具未带 prompt 时，才对该条结果回退会话用户指令；孤儿媒体或无法匹配时标记为不可用。视频按原始文件归档与提供服务，不经 sharp/ffmpeg 转码；界面使用原生视频播放，并提供“打开原媒体”操作。

### Cowart 画布

MOSA 始终监听自己的专用画布 `~/.codex/cowart-data/mosa/`。其他项目必须先在 Codex 中真实打开 Cowart 画布；MOSA 从本地启动记录识别项目，验证 `<项目>/canvas/` 的画布标记后才加入允许列表并监听。

Cowart 快照可提供画布说明与来源，但不保证具有完整生图 Prompt。MOSA 会保留这种差异，避免把画布描述误写成完整 Prompt。

## 检索、版本与回插

- 图库使用缩略图，详情使用预览图，原图保持可访问。
- **保存当前配方**只更新当前素材，不创建版本。
- **另存为新版本**必须填写 `version_change`；提供新的 `imagePath` 时保存真实新图，不提供时复制父图作为配方快照。
- 版本历史按稳定深度优先顺序展示，包含归档节点与所有分支。
- 素材详情页可选择已批准的 Cowart 画布一键回插。回插图片携带 MOSA 来源 ID，桥接器会去重，避免再次自动归档。

## MCP 与接口

MCP 工具包括：

```text
asset_create
asset_list
asset_get
asset_update_metadata
asset_attach_prompt
asset_archive
asset_duplicate
asset_version_create
asset_version_history
```

`asset_list` 和 `GET /api/assets` 支持 `limit` 与 `cursor` 分页，默认 100 条、最大 250 条。创建子版本时，使用 `asset_version_create` 并传入真实图片路径和非空 `version_change`。

## 健康检查与维护

服务运行后，可查看当前存储、桥接状态、自动发现的画布和回插能力：

```bash
curl -sS http://127.0.0.1:43517/api/library-path
curl -sS http://127.0.0.1:43517/api/bridges
curl -sS http://127.0.0.1:43517/api/cowart-canvases
```

`/api/bridges` 中的 `lastError` 为空或 `null` 表示没有最近桥接错误。服务停止时不会丢失已经归档的素材，但新的 Codex/Cowart 图片不会即时自动收集。

迁移、校验、派生图修复、端口冲突和恢复边界见 [operations.md](operations.md)。

## 数据安全

- 不要手工修改 `mosa.db`、迁移状态、版本关系或派生图任务。
- 不要为强制重试而删除原 JSON、`legacy-json-backup` 或数据库。
- 不要为了抢占端口直接终止未知服务。
- 不要放宽 Codex 来源目录、Cowart 画布发现目录或回插目标允许列表。

更多当前功能与配置请参阅仓库根目录的 [README.md](../README.md)。
