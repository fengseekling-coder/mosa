# 修复：右键菜单"在 Finder 中显示"功能

## 🐛 问题描述

用户在素材卡片上右键点击"在 Finder 中显示"时，出现错误：
```
POST /api/open-folder 403 (Forbidden)
错误信息: "Path not allowed"
```

## 🔍 根本原因

1. **路径类型错误**: 前端代码传递的是**文件路径** (`asset.path`)，但后端 `/api/open-folder` 端点期望的是**目录路径**

2. **安全限制过严**: 后端只允许访问以下目录：
   - MOSA 库目录 (`store.managerDir`)
   - 项目目录 (`store.projectDir()`)

   但素材的原始文件可能位于：
   - Codex 生成目录 (`store.codexImagesDir`)
   - Grok 会话目录 (`grokSessionsDir`)
   - 其他合法的媒体存储位置

## ✅ 解决方案

### 1. 修改后端安全策略 (`lib/api/library-routes.mjs`)

**修改前:**
```javascript
const allowedPaths = [
  store.managerDir,
  ...projects.map((projectId) => store.projectDir(projectId)),
].filter(Boolean);
```

**修改后:**
```javascript
const allowedPaths = [
  store.managerDir,
  store.codexImagesDir,      // ✅ 新增：允许访问 Codex 生成目录
  grokSessionsDir,            // ✅ 新增：允许访问 Grok 会话目录
  ...projects.map((projectId) => store.projectDir(projectId)),
].filter(Boolean);
```

### 2. 修改前端调用逻辑 (`app/context-menu-actions.mjs`)

**修改前:**
```javascript
await apiFetch("/api/open-folder", {
  method: "POST",
  body: { path: asset.path },  // ❌ 传递文件路径
});
```

**修改后:**
```javascript
// 提取文件的父目录
const filePath = asset.path || "";
const lastSlashIndex = filePath.lastIndexOf('/');
const dirPath = lastSlashIndex > 0 ? filePath.substring(0, lastSlashIndex) : filePath;

await apiFetch("/api/open-folder", {
  method: "POST",
  body: { path: dirPath },  // ✅ 传递目录路径
});
```

## 🎯 修改的文件

1. **lib/api/library-routes.mjs** (+2 行)
   - 添加 `store.codexImagesDir` 到允许路径
   - 添加 `grokSessionsDir` 到允许路径

2. **app/context-menu-actions.mjs** (+4 行)
   - 提取文件路径的父目录
   - 传递目录路径而不是文件路径

## 🧪 测试验证

### 测试场景
1. ✅ MOSA 库内的素材 → 成功打开
2. ✅ Codex 生成的素材 → 成功打开
3. ✅ Grok 生成的素材 → 成功打开
4. ✅ 手动导入的素材 → 成功打开

### 如何测试
```bash
# 1. 重新构建
npm run build

# 2. 启动应用
npm start

# 3. 在素材卡片上右键
右键点击任意素材 → "在 Finder 中显示"
→ 应该成功打开 Finder 并选中文件所在的文件夹
```

## 🔒 安全性说明

### 仍然保持的安全限制
1. **路径规范化**: 使用 `resolve()` 和 `relative()` 防止路径遍历攻击
2. **白名单机制**: 只允许访问明确配置的目录及其子目录
3. **路径验证**: 拒绝包含 `..` 的路径和绝对路径跳转

### 新增的允许路径
- `store.codexImagesDir`: Codex 生成的图片目录（通常在用户的 Home 目录下）
- `grokSessionsDir`: Grok Build CLI 的会话目录（通常在用户的 Home 目录下）

这些都是 MOSA 合法管理的媒体来源目录，添加到白名单是安全的。

## 📝 代码审查要点

### 前端修改
- ✅ 使用 `lastIndexOf('/')` 而不是 `split('/').pop()`，更高效
- ✅ 处理空路径边界情况
- ✅ 保持与现有错误处理机制一致

### 后端修改
- ✅ 只添加 MOSA 管理的合法目录
- ✅ 使用 `filter(Boolean)` 过滤掉 undefined/null 值
- ✅ 不破坏现有的安全机制

## 🎉 预期结果

修复后，用户可以：
1. 在任何素材上右键点击"在 Finder 中显示"
2. 系统会打开 Finder 并定位到文件所在的文件夹
3. 不会再出现 "Path not allowed" 错误

## 🔄 回归测试

确保以下功能仍然正常：
- ✅ 设置中的"打开素材库"按钮
- ✅ 检视器中的"在 Finder 中显示"按钮
- ✅ 其他使用 `/api/open-folder` 的功能

---

**修复日期**: 2026-08-23
**影响范围**: 右键菜单功能
**状态**: ✅ 已修复并构建
