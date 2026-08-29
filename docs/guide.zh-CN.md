# MOSA 中文使用指南

MOSA 是面向 Codex、Cowart 和本地 Grok Build CLI 的本地创作素材库。它不负责生图，而是在媒体生成或画布编辑后，自动把图片/视频、Prompt、来源、参数、版本和画布上下文归档为可检索、可复用的本地素材。

## 许可与商用

MOSA 采用 [PolyForm Noncommercial License 1.0.0](../LICENSE)，属于源码可见、非商业许可软件，不是 OSI 认可的开源软件。

- 个人、学习、研究、兴趣项目等非商业用途，以及非商业修改和传播均可免费使用。
- 任何商业用途、收费服务、客户交付或商业平台集成都须另行取得版权所有者的书面授权；申请流程见 [商业授权说明](../COMMERCIAL-LICENSE.md)。
- 重新分发原版或修改版时，必须保留许可证条款和 Required Notice。

## 产品边界

- **Codex** 负责 AI 生成、理解和任务执行。
- **Cowart** 负责画布编排与编辑。
- **Grok Build CLI** 可在本地生成图片与视频。
- **网页生图扩展**可选，用于把 ChatGPT、Gemini、Flow 和 Google AI Studio 的网页成图及其可用上下文发送到本机 MOSA。
- **MOSA** 负责自动收集、归档、检索和版本管理。

MOSA 当前是绑定 `127.0.0.1` 的本地 Web 应用，也提供共享同一套 UI/Runtime 的 Electron 桌面壳。macOS arm64 是现有桌面开发目标，Windows 10/11 x64 已进入 Preview/Testing；仓库尚未发布正式签名安装器。它不是云服务，不包含额外 AI 模型、Embedding 搜索或远程同步，也不调用 Grok API，也不应通过公网或反向代理暴露。

## 环境要求

- 源码模式需要 Node.js 22 或更高版本、npm；桌面开发目前覆盖 macOS arm64 与 Windows 10/11 x64。
- 要自动归档 Codex 生图，需要安装 Codex Desktop。
- 要自动归档 Grok 媒体，需要本机已登录并可写入 `~/.grok/sessions` 的 Grok Build CLI。
- Cowart 自动归档需要安装 Cowart 插件；不使用 Cowart 时不影响 MOSA 的其他功能。
- 网页生图归档需要 Chrome。使用 MOSA Desktop App 时会自动生成本机 Token，并只授权 MOSA 开发版与 Chrome Web Store 正式版这两个固定扩展来源完成本地配对；仅源码 `npm start` 模式需要手工配置 `MOSA_WEB_CAPTURE_TOKEN` 与 `MOSA_WEB_CAPTURE_ORIGINS`。

### Windows 10/11 x64 Preview 状态

当前 Windows 真机已经验证：`MOSA.exe` 启动、本地 SQLite、Sharp 原生图像处理、素材库/资产检视器，以及 Codex 素材自动收录。Windows 使用原生标题栏，但隐藏 Electron 默认菜单栏；菜单 accelerator 仍保留。

Windows 上的 Grok/Cowart 来源目录尚未完成真机验证，暂不把推测路径写成正式默认值。Windows 安装器、代码签名和自动更新也仍属于发布阶段工作，因此当前 Windows 构建应视为测试版，而不是正式发行版。

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

Windows 10/11 x64 真机已经验证 Codex 自动收录链路可工作。来源路径仍通过统一的 source-location resolver 处理；后续若 Codex 官方 Windows 存储布局发生变化，应以真机检测结果为准，而不是在业务代码中散落平台判断。

MOSA 不扫描 Downloads、桌面或任意本地图片目录。原图在同一文件系统时优先硬链接入库，跨文件系统时才复制。

### 网页生图

Web Capture 是可选功能。使用 Desktop App 时，只需加载官方扩展并打开 MOSA；扩展会自动发现 `127.0.0.1` 上的 MOSA discovery 端口并配对。如果首选端口被占用，Desktop 与扩展会自动切换到备用端口。

如果你从源码使用 `npm start` 启动独立 Web Runtime，则仍需手工配置：

```bash
MOSA_WEB_CAPTURE_TOKEN='replace-with-a-random-secret' \
MOSA_WEB_CAPTURE_ORIGINS='chrome-extension://replace-with-extension-id' \
npm start
```

Desktop 模式下扩展选项会自动得到实际 MOSA 地址和 Token，通常无需手填。源码 Web Runtime 中，未配置 Token 时服务端保持禁用；来源不在精确白名单中时，跨来源请求会被拒绝。

扩展只向所配置的 `127.0.0.1` 或 `localhost` MOSA 地址发送图片字节和页面来源信息。ChatGPT 在可用时还会发送匹配到的 Prompt/用户消息、会话/消息 ID 与模型信息；Gemini 仅保存生成图所属 `model-response` 前、同一局部消息结构里的最近可见 `user-query`；Flow 仅在同一可见媒体卡片有唯一「Reuse Prompt」控件时保存其相邻可见 Prompt；Google AI Studio 仅保存图片所在会话内、图片 Model 回合之前最近的页面可见用户 Prompt 回合。三者都明确标为未验证实际生图提示词。扩展不读取 Google 站点的会话接口、登录凭据、隐藏提示词、输入编辑器或模型思考；若图片先于可匹配 Prompt 完成渲染，只会对同一图片的局部关联信息进行有界重试。地址、Token 与自动采集开关保存在 Chrome 本地存储，不使用同步存储。完整边界见 [隐私说明](../PRIVACY.md) 和 [扩展指南](../extensions/chatgpt-web-capture/README.md)。

被可靠识别为生成输入的参考图会保存为“生成记录附件”，而不是独立素材：文件按内容 hash 去重，只绑定到同会话中随后产生的生成结果及其 recipe snapshot，不进入素材瀑布流、搜索、最近添加或素材总数。当前可靠自动识别以 ChatGPT 的上传输入为准；Flow、Gemini 不会仅凭页面先后顺序猜测参考关系。旧版已经入库的 `is_reference` 素材保持原样，MOSA 不自动迁移或删除现有库内容。

### Grok Build CLI 媒体

服务运行时，MOSA 只监听 `~/.grok/sessions/`（可用 `GROK_SESSIONS_DIR` 覆盖）。它只发现各会话目录下 `images/` 与 `videos/` 中的媒体，并读取同会话的 `chat_history.jsonl` 提取工具参数中的 Prompt、模型与工具名。

Prompt 优先级：仅在工具调用与 tool_result 能匹配到该媒体路径时使用工具参数 Prompt；匹配成功但工具未带 prompt 时，才对该条结果回退会话用户指令；孤儿媒体或无法匹配时标记为不可用。视频按原始文件归档与提供服务，不经 sharp/ffmpeg 转码；界面使用原生视频播放，并提供“打开原媒体”操作。

### Cowart 画布

MOSA 始终监听自己的专用画布 `~/.codex/cowart-data/mosa/`。其他项目必须先在 Codex 中真实打开 Cowart 画布；MOSA 从本地启动记录识别项目，验证 `<项目>/canvas/` 的画布标记后才加入允许列表并监听。

Cowart 快照可提供画布说明与来源，但不保证具有完整生图 Prompt。MOSA 会保留这种差异，避免把画布描述误写成完整 Prompt。

## 检索与版本

- 图库使用缩略图，详情使用预览图，原图保持可访问。
- **保存当前配方**只更新当前素材，不创建版本。
- **另存为新版本**必须填写 `version_change`；提供新的 `imagePath` 时保存真实新图，不提供时复制父图作为配方快照。
- 版本历史按稳定深度优先顺序展示，包含归档节点与所有分支。

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
asset_recipe_history
generation_record
generation_list
generation_relation_record
generation_lineage
```

`asset_list` 和 `GET /api/assets` 支持 `limit` 与 `cursor` 分页，默认 100 条、最大 250 条。创建子版本时，使用 `asset_version_create` 并传入真实图片路径和非空 `version_change`；需要读取某个素材的不可变配方快照历史时，使用 `asset_recipe_history`。

生成历史与素材版本是两套关系。`generation_record` 记录一次独立生成，即使输出图片已经被内容去重；`generation_relation_record` 只在有明确证据时记录 `edited_from`、`variant_of`、`derived_from` 或 `based_on`；`generation_lineage` 读取相连的生成图。普通 MCP 调用方不能把记录标成 `provider_verified`，该等级只保留给 MOSA 直接接入并验证 provider 响应的受信集成。

本地 HTTP 运行时同时提供：

```text
GET  /api/generations
POST /api/generations
POST /api/generation-relations
PATCH /api/generation-relations
DELETE /api/generation-relations
PATCH /api/generation-relation-candidates
GET  /api/generations/:generationId/lineage
```

`GET /api/generations` 可按 `project`、`asset`、`captureContext`、`providerToolCallId`、`providerGenerationCallId` 过滤。`PATCH /api/generation-relations` 可修正用户可管理的关系类型，`DELETE /api/generation-relations` 可解除错误关系；`provider_verified` 关系不能通过这些公共管理接口修改或删除。HTTP API 与 MCP 使用相同的 verification 规则。

资产检视器会把已确认的 Generation Relation 和“可能相关但尚未确认”的生成分开显示。ChatGPT Relation Resolver 会结合 conversation、生成先后、修改型提示词、参考图/provider asset 等信号保存 `relation_candidates` 和置信度，但不会仅凭这些线索自动写入版本树。用户可确认候选、手动选择其他父版本，或标记“无关联”；只有显式确认后才以 `user_confirmed` 关系进入生成谱系。被标记为无关联的候选会保留 dismissed 状态，后续解析不会反复建议同一对关系。生成树节点可打开对应输出素材、查看该 Generation Event 的会话/批次上下文，并管理非 `provider_verified` 的父子关系。

## 健康检查与维护

服务运行后，可查看当前存储、桥接状态和自动发现的画布：

```bash
curl -sS http://127.0.0.1:43517/api/library-path
curl -sS http://127.0.0.1:43517/api/bridges
curl -sS http://127.0.0.1:43517/api/cowart-canvases
curl -sS http://127.0.0.1:43517/api/web-capture
```

`/api/bridges` 中的 `lastError` 为空或 `null` 表示没有最近桥接错误；`webCapture.enabled` 只有在显式配置 Token 和扩展来源后才应为 `true`。服务停止时不会丢失已经归档的素材，但新的 Codex、Grok、网页生图或 Cowart 媒体不会即时自动收集。

迁移、校验、派生图修复、端口冲突和恢复边界见 [operations.md](operations.md)。

## 数据安全

- 不要手工修改 `mosa.db`、迁移状态、版本关系或派生图任务。
- 不要为强制重试而删除原 JSON、`legacy-json-backup` 或数据库。
- 不要为了抢占端口直接终止未知服务。
- 不要放宽 Codex 来源目录或 Cowart 画布发现目录。
- 不要提交或公开 Web Capture Token、真实 Prompt、会话标识、页面 URL 或个人素材路径。

更多当前功能与配置请参阅仓库根目录的 [README.md](../README.md)。
