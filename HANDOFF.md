# MOSA 2.0 Core 交接文档

运行态快照：2026-07-23

文档整理：2026-07-23

> 本文档面向维护者，记录环境相关的部署快照、验证证据和恢复边界。公开使用、迁移和故障处理请优先阅读 `README.md` 与 `docs/operations.md`；不要将本文中的个人路径、端口或动态资产数当作通用安装说明。

## 交接结论

- 配方版本树已通过 PR [#7](https://github.com/fengseekling-coder/mosa/pull/7) 合并至 `main`，合并提交为 `db2c090`；PR head 为 `25b9aee`。
- JSON/SQLite、REST/MCP、Web 时间线、迁移、Cowart 外部画布 `pages` 导入，以及 Grok Build CLI 媒体自动归档均已部署到 `43519`。
- Grok 发布快照 `e7b03db` 的预部署验证：`npm test` 为 81 passed、1 skipped；lint、源码检查、依赖审计和 `git diff --check` 均通过。生产 SQLite 只读校验为 `integrity_check=ok`、schema v2、迁移完成、306 个资产、3 个 Grok 资产。
- 当前产品是本地 Web UI，不是 Tauri 或可安装的 macOS 桌面应用；本次没有引入桌面壳、`.app` 或 `.dmg`。
- 后续只在获准的维护窗口内操作 `43519` 或真实素材库。`43517` 的旧 JSON 服务不属于本 job 的管理范围；2026-07-23 验收时没有对应 user launchctl job 或监听器，本次没有对它执行启动、停止或配置变更。
- Grok Build CLI 媒体自动归档已部署：`lib/grok-media-bridge.mjs` 通过 `GET /api/grok-bridge` 与 `GET /api/bridges` 的 `grok` 字段暴露状态，仅读取 `GROK_SESSIONS_DIR=/Users/azhuilab/.grok/sessions`。这是本地文件系统集成，不调用 Grok API。

## 当前状态

- 工作目录：`/Users/azhuilab/codex_aigc/mosa`
- Phase 0-2 已通过 PR #3 合并至 `main`（`b09b657`）；迁移交接记录通过 PR #4 合并（`6d71a6f`），Cowart 自动发现通过 PR #5 合并（`38be7f4`）。
- 配方版本树 PR #7 已合并。`43519` 当前运行本地提交 `e7b03db` 的干净发布快照 `/Users/azhuilab/codex_aigc/mosa-releases/e7b03db`，并使用已迁移的 SQLite 素材库；当前用户级 launchctl submitted job 为 `com.azhuilab.mosa.43519`。该提交尚未推送到远程。
- 真实素材库 `/Users/azhuilab/MOSA Library` 已于 2026-07-22 完成 SQLite 迁移：导入 270 个旧资产与 1 个空分组，并在迁移期间校验了全部 270 个原图哈希。
- 旧 JSON 与 Prompt 备份位于 `/Users/azhuilab/MOSA Library/legacy-json-backup/2026-07-22T12-26-53-909Z`；不要删除 JSON 源目录、该备份或 `mosa.db`，也不要手工修改迁移状态。
- `mosa verify` 在迁移后通过（270 个资产）；SQLite 服务启动后 Codex 归档桥接继续正常归档。2026-07-22 部署 PR #7 后最终验收通过（284 个资产、0 个失败）。2026-07-23 Grok 发布后，通过只读 SQLite 检查确认 `integrity_check=ok`、schema v2、迁移完成、306 个资产与 3 个 Grok 资产。资产数是动态快照，应以完整性检查和空 `failures` 判断完整性。
- `mosa thumbnails rebuild` 已完成 270 个派生图任务。SQLite 服务目前运行在 `http://127.0.0.1:43519`，`cowartDiscovery` 启用，识别 2 个候选项目并监听 MOSA 专用画布与 2 个项目画布；`shen` 画布此前的外部路径导入错误已清除并归档 1 个合规资产。Grok bridge 已启用、正在监听并已导入 3 个会话媒体；Cowart 插入仍可用。

## 本次实现范围

### Phase 0：工程护栏

- Node 22 基线（`.nvmrc`）、ESLint、源码语法检查、依赖审计和 GitHub Actions CI。
- CI 覆盖 PR、`develop` 与 `main`，执行 lint、check、test 和 audit。
- 新增 SQLite、迁移、派生图和 50,000 资产性能的契约测试。

### Phase 1：SQLite 运行期主库

- `AssetRepository` 由 `createAssetStore()` 选择 JSON 或 SQLite 后端，上层 HTTP、MCP、Codex 和 Cowart bridge 不直接依赖存储实现。
- SQLite 使用 `better-sqlite3`、FTS5 和游标分页；数据库维护项目、资产、标签、版本、派生任务及迁移状态。
- `mosa migrate` 先清点并校验旧 JSON 与原图哈希，迁移时保留 JSON/Prompt 备份；失败或未完成时不会激活 SQLite。
- REST `GET /api/assets` 和 MCP `asset_list` 支持 `limit`（默认 100，最大 250）与 `cursor`，响应保留原有资产字段并增加 `page.total`、`page.nextCursor`。
- 支持软归档；`asset_duplicate` 创建独立版本根，并通过 `duplicated_from` 保留复制来源。
- 运行期后端只由迁移完成状态选择，环境变量不能绕过验证或让已迁移素材库回退双写。

### Phase 2：派生图和图库性能

- `sharp` 后台队列生成 WebP：缩略图最长边 400px，预览图最长边 1600px；原图不修改。
- 任务持久化在 SQLite，最多并发 2 个；失败可重试，派生图缺失时客户端回退原图。
- 图库列表使用缩略图，详情使用预览图，原图路由 `/library/<project>/images/<file>` 保持兼容。
- JSON 兼容后端与 SQLite 使用同一套稳定游标顺序；后台刷新不会折叠用户已经加载的后续页面。
- 支持 `mosa thumbnails rebuild` 进行可断点续跑的补全和修复；EXIF 方向、透明 PNG、SVG 与无法解码的文件都有明确任务状态。

### 后续集成：Cowart 项目画布自动发现

- MOSA 从 `CODEX_SESSIONS_DIR` 下的本地 Codex JSONL 会话中识别真实的 `render_cowart_canvas_widget` 或 `start-canvas.sh` 启动调用；不扫描任意项目目录。
- 发现前会规范化项目路径，并要求 `<projectDir>/canvas` 具备 Cowart 自有标记文件；通过的项目仍登记在服务端允许列表中并只监听该画布。
- 本地启动调用只选择一个项目：`projectDir` 优先于 `workdir`，后者优先于 `cwd`。搜索、注释或 `echo` 中提到 `start-canvas.sh` 不会触发监听。
- 设置页只展示自动发现的画布；保留现有画布 API 以兼容已有客户端。`GET /api/bridges` 在新服务进程中包含 `cowartDiscovery` 状态。

### 后续集成：配方版本树

- 每个版本是独立 asset，拥有自己的图片、Prompt、配方和来源；新图可通过 `imagePath` 直接保存为子版本，不传新图时复制父图形成配方快照。
- `POST /api/assets/:project/:asset/versions` 与 MCP `asset_version_create` 从当前节点分支并强制填写 `version_change`；GET 路由与 `asset_version_history` 返回包含归档节点的完整稳定 DFS 历史。
- 普通 PATCH 禁止修改 `parent_asset_id`、`parentAssetId` 与 `child_asset_ids`；children 由父边动态派生。缺失父、跨项目、自环/循环及重复 ID 返回稳定错误。
- SQLite schema v2 增加父边索引和一次性迁移记录，保留现有 `migration_state`；旧 JSON 迁移会先做父序、重复 ID、跨项目和循环校验。
- Web 详情页提供双语时间线、“保存当前配方”和“另存为新版本”；异步历史响应只更新 timeline，不覆盖编辑表单。
- 已登记的外部 Cowart 画布仅在单次桥接导入中信任其 `<canvasDir>/pages` 根，普通素材导入白名单不变。

## 关键文件

| 领域 | 文件 |
| --- | --- |
| SQLite 存储 | `lib/sqlite-asset-store.mjs` |
| JSON 存储 | `lib/asset-store.mjs` |
| 版本树共享契约 | `lib/asset-version-history.mjs` |
| JSON 到 SQLite 迁移与验证 | `lib/library-migration.mjs` |
| WebP 派生图任务 worker | `lib/derivative-worker.mjs` |
| CLI | `bin/mosa.mjs` |
| HTTP 服务和路由 | `server.mjs` |
| Grok 媒体自动归档 | `lib/grok-media-bridge.mjs` |
| Cowart 画布自动发现 | `lib/cowart-canvas-discovery.mjs` |
| MCP v1 兼容层 | `mcp/server.mjs` |
| 版本时间线 UI | `app/app.js`、`app/styles.css` |
| CI 与本地检查 | `.github/workflows/ci.yml`、`scripts/check-source.mjs` |
| Core 存储测试 | `test/sqlite-store.test.mjs`、`test/library-migration.test.mjs`、`test/performance.test.mjs` |
| Grok 桥接回归测试 | `test/grok-media-bridge.test.mjs` |
| Cowart 发现回归测试 | `test/cowart-canvas-discovery.test.mjs`、`test/server-routes.test.mjs` |
| 版本树回归测试 | `test/asset-version-history.test.mjs`、`test/mcp-version-history.test.mjs` |

## 数据与兼容边界

- 默认素材库路径：`~/MOSA Library`，其中保存 `mosa.db`、`assets/<project>/original`、`previews`、`thumbnails` 和 `legacy-json-backup`。
- 迁移完成后，SQLite 是唯一运行期权威；JSON 仅作可验证备份，不做长期双写。
- JSON 损坏、缺失原图或哈希不符会报告具体路径并以非零状态退出，不允许静默跳过。
- 保持现有 Codex 来源目录白名单、Cowart 的事件式自动发现与服务端允许列表、回插目标允许列表和原图 URL 行为；不扫描任意 Cowart 项目目录。
- 本次不包含 Tauri、AI 元数据/Embedding 或 MCP 2.0。

## 已完成验证

实现、迁移和运行态的验证记录：

```bash
npm ci
# Phase 0-2 Core 基线
npm test                       # 41 passed, 1 skipped（性能测试默认跳过）
npm run test:performance       # 50,000 资产：启动 < 3s，FTS P95 < 100ms
npm run lint
npm run check
npm run audit
git diff --check

# 迁移前只读预检
npm exec mosa -- migrate --dry-run --library /private/tmp/mosa-handoff-library
# discovered: 270; discoveredGroups: 1; issues: 0

# 已在真实素材库执行并通过
npm exec mosa -- migrate --library /Users/azhuilab/MOSA\ Library
# imported: 270 assets; importedGroups: 1; verified: 270
npm exec mosa -- verify --library /Users/azhuilab/MOSA\ Library
# assets: 270; failures: 0
npm exec mosa -- thumbnails rebuild --library /Users/azhuilab/MOSA\ Library
# succeeded: 270

# SQLite 服务运行后最终复核
npm exec mosa -- verify --library /Users/azhuilab/MOSA\ Library
# assets: 271; failures: 0; migration_state: completed
curl -sS http://127.0.0.1:43519/api/library-path
# storage: sqlite; libraryDir: /Users/azhuilab/MOSA Library

# PR #5 自动发现回归验证
node --test test/cowart-canvas-discovery.test.mjs
# 8 passed
npm test
# 49 passed, 1 skipped
npm run lint
npm run check
npm run audit
# clean; syntax checked; 0 vulnerabilities

# PR #5 运行态加载后的最终验收
curl -sS http://127.0.0.1:43519/api/bridges
# cowartDiscovery: enabled=true; candidateCount=2; lastError=null
# cowart: monitoredCount=3; registeredCount=2
curl -sS http://127.0.0.1:43519/api/cowart-canvases
# MOSA 专用画布、new-chat、shen
npm exec mosa -- verify --library /Users/azhuilab/MOSA\ Library
# assets: 283; failures: 0; ok: true; migration_state: completed

# agent/recipe-history 分支验证（未触碰生产端口或真实素材库）
npm test
# 64 passed, 1 skipped（性能测试默认跳过；包含 2 个 HTTP 路由测试）
node --test test/asset-version-history.test.mjs test/sqlite-store.test.mjs
# 9 passed
node --test test/library-migration.test.mjs
# 8 passed
node --test test/mcp-version-history.test.mjs test/accessibility-contract.test.mjs
# 7 passed
node --test test/asset-store.test.mjs test/codex-image-bridge.test.mjs test/cowart-bridge-manager.test.mjs test/cowart-bridge.test.mjs test/cowart-canvas-discovery.test.mjs
# 29 passed
npm run lint
npm run check
git diff --check
# passed; syntax checked 36 JavaScript files

# PR #7 合并后的生产部署验收
npm run test:performance
# 50,000 资产：通过启动 < 3s、FTS P95 < 100ms 契约
curl -sS http://127.0.0.1:43519/api/library-path
# storage: sqlite; libraryDir: /Users/azhuilab/MOSA Library
curl -sS http://127.0.0.1:43519/api/bridges
# cowartDiscovery: enabled=true; candidateCount=2; lastError=null
# cowart: monitoredCount=3; registeredCount=2; lastError=null
npm exec mosa -- verify --library /Users/azhuilab/MOSA\ Library
# assets: 284; failures: 0; ok: true; migration_state: completed

# Grok Build CLI 媒体桥生产发布（2026-07-23，本地提交 e7b03db）
# 在干净发布快照 /Users/azhuilab/codex_aigc/mosa-releases/e7b03db 中执行
npm test
# 81 passed, 1 skipped
npm run lint
npm run check
npm run audit
git diff --check e7b03db^ e7b03db
# clean; syntax checked 40 JavaScript files; 0 vulnerabilities
curl -sS http://127.0.0.1:43519/api/grok-bridge
# bridge.enabled=true; watching=true; GROK_SESSIONS_DIR=/Users/azhuilab/.grok/sessions
curl -sS 'http://127.0.0.1:43519/api/assets?project=default&source=grok-generated&limit=10'
# page.total=3; generation-tool-prompt; image_gen; grok-4.5-build
sqlite3 'file:/Users/azhuilab/MOSA%20Library/mosa.db?mode=ro' \
  'PRAGMA integrity_check; SELECT value FROM library_meta WHERE key IN ("migration_state", "schema_version") ORDER BY key; SELECT COUNT(*) FROM assets; SELECT COUNT(*) FROM assets WHERE source_type = "grok-generated";'
# ok; completed; 2; 306; 3
```

## 后续维护

1. `43519` 当前运行 `e7b03db` 发布快照，包含 PR #7 配方版本树与 Grok 媒体桥。以后仅在获准的维护窗口内重启。新进程必须使用已迁移素材库、明确的 `GROK_SESSIONS_DIR`，并执行干净的已提交快照；不要从脏工作树直接启动生产：

```bash
MOSA_LIBRARY_DIR='/Users/azhuilab/MOSA Library' \
MOSA_PORT=43519 \
GROK_SESSIONS_DIR='/Users/azhuilab/.grok/sessions' \
/Users/azhuilab/.hermes/node/bin/node \
  /Users/azhuilab/codex_aigc/mosa-releases/<commit>/server.mjs
```

2. `GET /api/bridges` 应持续返回启用的 `cowartDiscovery`；仅在本地 Codex 会话出现真实 Cowart 启动记录且目标具有画布标记时，才会增加项目画布监听。
3. `GET /api/bridges` 应包含 `grok.enabled=true` 与 `grok.sessionsDir`；当前根为 `~/.grok/sessions`，可用 `GROK_SESSIONS_DIR` 覆盖。不要扫描该根之外的路径；媒体会在服务运行时自动入库。
4. 例行维护可运行 `npm exec mosa -- verify --library /Users/azhuilab/MOSA\ Library`；仅在需补全或修复派生图时运行 `npm exec mosa -- thumbnails rebuild --library /Users/azhuilab/MOSA\ Library`。
5. 迁移、校验或派生图任务失败时，不要删除 JSON 目录、备份或 SQLite 数据库，也不要手工激活/回退迁移状态；先保留现场并依据命令输出中的具体路径修复。
6. 视频资产没有 WebP 缩略图是预期行为；不要引入 ffmpeg 或把视频送入 sharp。
