# MOSA ChatGPT Web Capture（0.8）

把 **ChatGPT 网页**生成的图片 + 提示词归档到本机 MOSA。支持**自动入库**与右下角悬浮面板手动保存。

> 本扩展随 MOSA 一同采用 [PolyForm Noncommercial License 1.0.0](../../LICENSE)：允许非商业使用、修改和传播；商业用途须另行取得书面授权。

## 首次配置

1. Chrome 打开 `chrome://extensions` 并开启**开发者模式**。
2. 选择**加载已解压的扩展程序**，加载本目录。
3. 复制扩展卡片上显示的 ID。
4. 使用随机 Token 和该扩展的精确来源启动 MOSA。公共默认地址为 `http://127.0.0.1:43517`：

```bash
MOSA_WEB_CAPTURE_TOKEN='replace-with-a-random-secret' \
MOSA_WEB_CAPTURE_ORIGINS='chrome-extension://replace-with-extension-id' \
npm start
```

5. 打开扩展选项，填写实际 MOSA 地址和同一个 Token，开启需要的自动入库设置并测试连接。
6. 刷新 ChatGPT 页面。

未配置 Token 时 Web Capture 保持禁用；扩展来源不在白名单中时请求会被拒绝。不要在共享环境、Issue、日志或截图中公开 Token。

## 加载 / 更新扩展

更新扩展代码后，在 `chrome://extensions` 点扩展卡片上的**刷新**，然后硬刷新 ChatGPT 页面。扩展 ID 发生变化时，也要同步更新 `MOSA_WEB_CAPTURE_ORIGINS` 并重启 MOSA。

## 使用

打开 chatgpt.com 出图后：

1. **自动**：发现大图会自动 POST 到 MOSA（toast 提示）
2. **手动**：右下角悬浮 **MOSA** 面板
   - **保存当前图**：页面上最大的那张
   - **保存全部大图**：本页最多 12 张

Prompt 优先级：同一会话消息中的生成 metadata（如 `revised_prompt`）→ 同一图片的资源键（`cid + id`）→ 对应用户消息 → `not-available`（图仍入库）。
不会把整页最后一条用户消息误配给历史图片。

## 数据与权限

- 扩展只在 `chatgpt.com` 和兼容的旧 ChatGPT 域名中运行，并只把数据发送到选项中配置的本机 MOSA 地址。
- 入库数据包括图片字节、匹配到的 Prompt/用户消息、页面 URL、会话/消息 ID、模型信息、采集时间和扩展版本。
- MOSA 地址、Token 和自动采集开关保存在 Chrome 本地存储，不使用同步存储。
- 图片下载需要清单中列出的 OpenAI 静态资源域名权限；本机通信只允许 `127.0.0.1` 或 `localhost`。
- MOSA 不会因此获得 ChatGPT 账号密码或 OpenAI API Key。完整说明见 [PRIVACY.md](../../PRIVACY.md)。

## 限制

- 仅 ChatGPT 网页
- 全屏看图器 DOM 多变；若自动没命中，用悬浮「保存当前图」
- GPT 网页未暴露生成 metadata 时，扩展只保留对应用户消息，不会伪造模型实际执行的提示词
- 相同内容 hash 去重
- 改扩展代码后要在 `chrome://extensions` 点刷新，并硬刷新网页

## 许可

本扩展是 MOSA 的组成部分，受仓库根目录 [LICENSE](../../LICENSE) 约束。重新分发时必须保留许可证条款和 Required Notice。
