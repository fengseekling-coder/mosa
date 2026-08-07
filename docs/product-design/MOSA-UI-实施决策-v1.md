# MOSA UI 实施决策 v1（已批准，冻结）

- 状态：**已批准 / 冻结（frozen）**
- 批准日期：2026-08-01
- 适用分支：`agent/macos-desktop-shell-v2`（mosa-desktop-worktree）
- 上游依据：`docs/product-design/MOSA-产品设计规格-v1.md`、`docs/product-design/MOSA-研发任务与验收-v1.md`、`docs/product-design/assets/mosa-large-view-approved-v1.png`
- 下游消费：`docs/ui-audit/10-prioritized-design-audit.md`（发现定级）、`docs/ui-audit/12-design-system-migration-plan.md`（令牌迁移）、`docs/ui-audit/13-implementation-roadmap.md`（阶段路线）、`docs/ui-audit/14-phase-0-baseline-plan.md`（Gate-0 基线）、`docs/ui-audit/15-phase-1-task-breakdown.md`（Phase 1 任务）
- 变更规则：任何对本文件决策的修改必须走产品规格修订流程；代码不得先于决策变更。

---

## D1 — 主强调色：恢复批准蓝

主强调色恢复批准稿中的**蓝色**。绿色实验方向**废弃**（`#00c853`/`#00e676` 及其自称依据 `design-preview-v2.html` 均不成立）。具体色值在 Phase 1 Design Token 阶段基于批准稿校准，以 HEAD 蓝（`#2424ff` / `#6666ff`）为参照起点，深浅双主题 6 枚 `--accent*` 令牌成对替换，`--accent-contrast` 白字对比度 ≥ 4.5:1 复核。

- 关闭发现：F-02（P2）
- 执行阶段：Phase 1

## D2 — 标签功能：保留，不阻塞大图第一阶段

标签功能**保留**。标签属于右侧素材信息结构（批准稿右栏第 7 项），但**不阻塞**专用大图模式的第一阶段实现。数据模型（字段、存储、API）另行立项；Phase 4 右栏重排时为标签预留位次，功能未落地前以书面位次说明呈现，不伪造数据。

- 关联发现：F-06（P1）
- 执行阶段：Phase 4（右栏位次）；数据模型排期另定

## D3 — 全局搜索：恢复左侧导航顶部

全局搜索恢复到**左侧导航顶部**（品牌区下方，与范围切换同列）。进入大图模式后搜索框仍保留在侧栏，但**不得抢夺主图注意力**（无自动聚焦、无强调态外溢、保持安静视觉权重）。701–1120px 图标栏折叠态下的搜索可达方案在 Phase 2 实施时以代码注释 + 截图证据记录。

- 关闭发现：F-05（P1）
- 执行阶段：Phase 2

## D4 — 素材查看：必须进入专用大图查看模式

点击素材**必须进入专用大图查看模式**（中央 contain 舞台 + 返回/范围名 + 全高右栏 + 左导航保持范围选中）。**不得**继续采用「画廊保持可见 + 右侧检查器旁挂」的结构作为最终方案；现有检视器/黑场预览在 viewer 落地后按 Phase 3 决策整合或退役，禁止双态长期并存。

- 关闭发现：F-01（P0）；联动 F-03/F-04/F-09
- 执行阶段：Phase 3

## D5 — 字体：macOS 与系统 UI 字体栈

继续使用 **macOS 和系统 UI 字体栈**（`-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif`）。**禁止**引入 Fredoka、Nunito、装饰型衬线字体或任何营销展示字体；不随产品分发 Web Font。

- 关闭发现：F-23（P3）
- 执行阶段：Phase 1

## D6 — 空间系统：8px 基础 + 登记例外

采用 **8px 空间基础系统**（4px 为半格步进）。允许以下例外，例外必须登记注释：

- 1px / 2px 边框
- 字号和字距（排版独立标尺）
- 媒体固有比例（`vh`/`vw`/`aspect-ratio`/`clamp()`）
- 动态缩放与定位（JS 运行时几何）
- 合理的响应式断点（480 / 700·701 / 900 / 1120 / 1400）
- 经过说明的光学修正（1–3px 微调，注释 `/* optical */`）

- 执行阶段：Phase 1（令牌）→ 全阶段（守护检查）

## D7 — 扩展 UI：语义共享，不共享代码

浏览器扩展与主应用共享：

- 颜色语义（同名语义令牌与双主题规则）
- 字体层级（系统字体栈与字号标尺）
- 间距原则（8px 基础）
- 控件状态（hover/focus-visible/active/disabled/selected 语义）
- 可访问性规则（焦点可见、状态播报、reduced-motion、颜色不作唯一表达）

但**不要求**共享相同 DOM 组件或运行时代码；扩展保持独立实现，仅对齐语义层。

- 关联发现：F-21（P2）
- 执行阶段：Phase 7

---

## 工程约束（冻结）

- 保持 Vanilla HTML/CSS/JavaScript
- 保持 Electron 与 Web 共用同一前端
- 不迁移框架
- 不一次性重写 `app.js`
- 不引入新的组件框架
- 不改变数据存储和业务接口

## 仍开放的实施决策点（未冻结，按阶段关闭）

以下项不属于本文件冻结范围，按 `docs/ui-audit/13-implementation-roadmap.md` 的决策点清单在对应阶段启动前产出书面结论：

| # | 开放决策 | 关闭时点 |
|---|---|---|
| O1 | 黑场预览模态与 viewer 的关系（并入缩放态 vs 保留全屏次级能力） | Phase 3 启动前 |
| O3 | viewer 上一张/下一张跨越已加载分页边界（到边禁用 vs 触发加载更多） | Phase 3 内 |
| O4 | 桥接状态呈现（顶栏圆点化 vs 侧栏底部；均需保留设置诊断区与 live 播报） | Phase 2 内 |
| O5 | tooltip 策略（接受原生 title vs 自绘共享原语） | Phase 7 内 |

### 已关闭开放项

**O2（关闭于 Phase 2C）701–900px 区间折叠行为**——结论：维持 701 起，不引入 900 起的收窄变体。

- 960×640 是桌面产品最低验收尺寸；
- 960–1120 为紧凑桌面 Shell：Detail 打开时使用紧凑 Sidebar（图标栏）+ 右侧全高检视器，Detail 位于右侧而非下方；
- 900–959 属 Web 回退区，不作为桌面产品验收目标；
- 小于 900 保持现有回退行为，本轮不独立设计移动端；
- 900–1120 禁止 Detail 下沉到画廊下方（守护测试锁定）。

依据：`docs/ui-audit/22-phase-2c-shell-results.md`；实施见 `app/styles.css` 布局骨架与响应式节。

*本文件为决策记录，不含任何生产代码改动。*
