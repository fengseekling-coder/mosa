# MOSA 架构整理计划（修订版）

**日期：** 2026-08-12  
**目标：** 提升代码质量和可维护性  
**原则：** 聚焦高价值改进，避免纯形式主义

---

## Day 1 ✅ 已完成（2026-08-12）

**任务：** 删除编译辅助文件

**执行：**
- 删除 36 个文件（18 .d.ts + 18 .js.map）
- 这些文件从未被 git 跟踪（在 .gitignore 中）
- 验证测试通过：918/921

**结果：**
- lib/ 文件数：86 → 50（减少 36 个）
- 测试：✅ 918/921（不变）
- Lint：✅ 0 errors
- 语法：✅ 133 files

**提交：** `chore: remove TypeScript compilation artifacts`

---

## 放弃的事项

### ❌ .ts/.js → .mjs 统一迁移

**为什么放弃：**
1. **技术价值为零**：.mjs 和 .js 在 Node.js ESM 中功能完全相同
2. **高风险低收益**：需要改动 30+ 文件的 import，容易引入 bug
3. **纯机械工作**：3 天时间做文件重命名，没有质量提升

**当前状态：**
- lib/ 下混合 .mjs（14 个）和 .js（18 个）
- 运行正常，测试通过
- 接受现状，不强求统一

---

## Day 2-6：质量提升计划

### Day 2：ESLint 规则扩展（第一批）

**目标：** 从 6 条规则扩展到 16 条

**新增规则：**
```javascript
// 变量规则
'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
'no-shadow': 'error',
'no-use-before-define': ['error', { functions: false }],
'prefer-const': 'error',
'no-var': 'error',

// 代码质量
'eqeqeq': ['error', 'always'],
'curly': ['error', 'all'],
'no-eval': 'error',
'no-implied-eval': 'error',
'no-new-func': 'error'
```

**验证：**
- 运行 `npm run lint`
- 记录新发现的问题（不修复，只记录）
- 测试仍然 918/921

---

### Day 3：ESLint 规则扩展（第二批）+ TypeScript strict

**ESLint 目标：** 从 16 条扩展到 26 条

**新增规则：**
```javascript
// Import 规则
'import/no-cycle': 'error',
'import/no-unused-modules': 'warn',
'import/no-duplicates': 'error',
'import/first': 'error',
'import/newline-after-import': 'warn',

// 异步规则
'no-async-promise-executor': 'error',
'no-await-in-loop': 'warn',
'require-atomic-updates': 'error',

// 其他
'no-console': 'warn',
'no-debugger': 'error'
```

**TypeScript 增强：**
```json
{
  "compilerOptions": {
    "noEmitOnError": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noImplicitReturns": true
  }
}
```

---

### Day 4：循环依赖检测 + ESLint 完善

**循环依赖检测：**
```bash
npm install --save-dev madge
npx madge --circular --extensions mjs,js lib/
```

**ESLint 目标：** 达到 30+ 条规则

**新增规则：**
```javascript
// 性能
'no-constant-condition': 'error',
'no-unreachable': 'error',
'no-useless-return': 'error',

// 最佳实践
'default-case': 'warn',
'no-fallthrough': 'error',
'no-return-await': 'error'
```

**产出：**
- 循环依赖报告（如果有）
- ESLint 规则清单（30+ 条）

---

### Day 5：拆分 mosa-runtime.mjs（第一阶段）

**当前状态：**
- mosa-runtime.mjs：468 行
- 职责混杂：HTTP 服务器、桥接管理、配置解析、错误处理

**拆分目标：**
- 提取 `lib/runtime-bridges.mjs`（桥接生命周期，~80 行）
- 提取 `lib/runtime-config.mjs`（配置解析，~60 行）
- mosa-runtime.mjs：~328 行

**步骤：**
1. 创建新模块，复制对应代码
2. 修改 mosa-runtime.mjs 的 import
3. 验证测试通过
4. 删除 mosa-runtime.mjs 中的旧代码

---

### Day 6：拆分 mosa-runtime.mjs（第二阶段）+ 最终验收

**拆分目标：**
- 提取 `lib/runtime-worker.mjs`（Worker 协调，~70 行）
- 提取 `lib/runtime-errors.mjs`（错误聚合，~50 行）
- mosa-runtime.mjs：~208 行（减少 55%）

**最终验收：**

| 指标 | Day 1 前 | Day 6 后 | 变化 |
|---|---|---|---|
| 测试通过 | 918/921 | ≥918/921 | - |
| lib/ 文件数 | 86 | ~54 | -37% |
| 最大文件行数 | 468 | <250 | -47% |
| ESLint 规则 | 6 | 30+ | +400% |
| 循环依赖 | 未知 | 0 | ✅ |
| .d.ts/.js.map | 36 | 0 | -100% |

**产出文档：**
- `docs/refactor-report.md`（Day 0 vs Day 6 对比）
- `docs/eslint-rules.md`（所有规则说明）
- `docs/architecture.md`（模块职责说明）

---

## 关键决策记录

### 决策 1：不迁移 .ts/.js → .mjs

**原因：**
- 技术价值为零（扩展名不影响功能）
- 高风险（需要改 30+ 文件）
- 时间成本高（3 天机械工作）

**结果：**
- lib/ 保持混合状态（.mjs + .js）
- 节省 3 天，专注质量提升

### 决策 2：不创建 _archive 保险柜

**原因：**
- .d.ts 和 .js.map 从未被 git 跟踪
- 可以随时从 TypeScript 源码重新编译
- 不需要"保险"

**结果：**
- 直接删除 36 个文件
- lib/ 更清洁

### 决策 3：不推送到 git 仓库

**原因：**
- 这是本地开发分支
- 不需要考虑远程冲突
- 可以更激进地重构

**结果：**
- 可以自由 commit 本地
- 不用担心影响团队

---

## 风险与应对

### 风险 1：ESLint 新规则暴露大量既有问题

**应对：**
- 只添加规则，不立刻修复
- 记录所有发现的问题到 Day 6 报告
- 不让 lint 失败阻塞提交

### 风险 2：拆分 mosa-runtime 引入新 bug

**应对：**
- 每拆一个模块立刻跑测试
- 保持 918/921 不变
- 如果测试失败，立刻回滚

### 风险 3：循环依赖检测发现架构问题

**应对：**
- 记录到报告，不立刻修复
- 评估修复成本 vs 收益
- 可能需要延长到 Day 7-8

---

## 时间估算

| Day | 任务 | 时间 |
|---|---|---|
| 1 | 删除 .d.ts/.js.map | ✅ 0.5h |
| 2 | ESLint 第一批 | 2h |
| 3 | ESLint 第二批 + TS strict | 3h |
| 4 | 循环依赖 + ESLint 完善 | 3h |
| 5 | 拆分第一阶段 | 4h |
| 6 | 拆分第二阶段 + 验收 | 4h |

**总计：16.5 小时（约 2-3 个工作日）**
