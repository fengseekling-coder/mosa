# MOSA 2.0 Core 交接文档

更新日期：2026-07-22

## 当前状态

- 工作目录：`/Users/azhuilab/codex_aigc/mosa`
- 当前分支：`develop`
- Phase 0-2 实现已完成并通过交付验证；本交接文档随该实现进入 `develop`。
- 当前默认仍是 JSON 兼容后端。只有独立素材库的 SQLite 迁移完成并验证后，运行期才会自动切换到 SQLite。
- 未对真实用户数据执行迁移；请不要在未明确授权时运行会向 `~/MOSA Library` 写入数据的迁移命令。

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
- 支持软归档和复制，并保留版本/来源关系。
- 运行期后端只由迁移完成状态选择，环境变量不能绕过验证或让已迁移素材库回退双写。

### Phase 2：派生图和图库性能

- `sharp` 后台队列生成 WebP：缩略图最长边 400px，预览图最长边 1600px；原图不修改。
- 任务持久化在 SQLite，最多并发 2 个；失败可重试，派生图缺失时客户端回退原图。
- 图库列表使用缩略图，详情使用预览图，原图路由 `/library/<project>/images/<file>` 保持兼容。
- JSON 兼容后端与 SQLite 使用同一套稳定游标顺序；后台刷新不会折叠用户已经加载的后续页面。
- 支持 `mosa thumbnails rebuild` 进行可断点续跑的补全和修复；EXIF 方向、透明 PNG、SVG 与无法解码的文件都有明确任务状态。

## 关键文件

| 领域 | 文件 |
| --- | --- |
| SQLite 存储 | `lib/sqlite-asset-store.mjs` |
| JSON 到 SQLite 迁移与验证 | `lib/library-migration.mjs` |
| WebP 派生图任务 worker | `lib/derivative-worker.mjs` |
| CLI | `bin/mosa.mjs` |
| HTTP 服务和路由 | `server.mjs` |
| MCP v1 兼容层 | `mcp/server.mjs` |
| CI 与本地检查 | `.github/workflows/ci.yml`、`scripts/check-source.mjs` |
| 新增测试 | `test/sqlite-store.test.mjs`、`test/library-migration.test.mjs`、`test/performance.test.mjs` |

## 数据与兼容边界

- 默认素材库路径：`~/MOSA Library`，其中保存 `mosa.db`、`assets/<project>/original`、`previews`、`thumbnails` 和 `legacy-json-backup`。
- 迁移完成后，SQLite 是唯一运行期权威；JSON 仅作可验证备份，不做长期双写。
- JSON 损坏、缺失原图或哈希不符会报告具体路径并以非零状态退出，不允许静默跳过。
- 保持现有 Codex 来源目录白名单、Cowart 登记式监听、回插目标允许列表和原图 URL 行为；不扫描任意 Cowart 项目目录。
- 本次不包含 Tauri、AI 元数据/Embedding、版本树 UI 或 MCP 2.0。

## 已完成验证

本次实现的最后一次验证记录：

```bash
npm ci
npm test                       # 41 passed, 1 skipped（性能测试默认跳过）
npm run test:performance       # 50,000 资产：启动 < 3s，FTS P95 < 100ms
npm run lint
npm run check
npm run audit
git diff --check

# 只读迁移预检，不写入真实素材库
npm exec mosa -- migrate --dry-run --library /private/tmp/mosa-handoff-library
# discovered: 270; discoveredGroups: 1; issues: 0
```

## 后续操作

1. 通过 PR 审查 `develop` 的 Phase 0-2 实现并合并到 `main`。
2. 仅在获得真实数据迁移授权后执行以下命令，并在每步检查返回码：

```bash
npm exec mosa -- migrate
npm exec mosa -- verify
npm exec mosa -- thumbnails rebuild
```

迁移或校验失败时，不要删除 JSON 目录或手工激活 SQLite；先保留现场并依据命令输出中的具体路径修复。
