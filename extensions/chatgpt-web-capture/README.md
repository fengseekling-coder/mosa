# MOSA Web Capture（0.14）

把 **ChatGPT、Gemini、Flow 和 Google AI Studio 网页**中用户可见的生成图片归档到本机 MOSA。ChatGPT 支持提示词关联；Gemini、Flow 与 Google AI Studio 只会保存和图片局部关联的页面可见 Prompt（明确标为未验证）。

> 本扩展随 MOSA 一同采用 [PolyForm Noncommercial License 1.0.0](../../LICENSE)：允许非商业使用、修改和传播；商业用途须另行取得书面授权。

## 首次配置

1. Chrome 打开 `chrome://extensions` 并开启**开发者模式**。
2. 选择**加载已解压的扩展程序**，加载本目录。
3. 打开 MOSA Desktop App。
4. 扩展会自动在本机固定 discovery 端口中查找 MOSA，验证产品身份后完成本地配对，并把地址与 Token 只保存在 `chrome.storage.local`。
5. 刷新要使用的网页。

Desktop App 默认不需要手填地址、Token 或扩展 ID。MOSA 会为官方扩展使用固定 ID，并在首次启动时生成设备级随机 Token，保存在 Electron `userData` 中；如果首选端口被占用，Desktop 会自动使用备用 discovery 端口，扩展也会自动重新发现。

只有从源码用 `npm start` 启动独立 Web Runtime 时，才需要开发者手工配置：

```bash
MOSA_WEB_CAPTURE_TOKEN='replace-with-a-random-secret' \
MOSA_WEB_CAPTURE_ORIGINS='chrome-extension://replace-with-extension-id' \
npm start
```

未配置 Token 时 Web Capture 保持禁用；扩展来源不在白名单中时请求会被拒绝。不要在共享环境、Issue、日志或截图中公开 Token。

## 加载 / 更新扩展

更新扩展代码后，在 `chrome://extensions` 点扩展卡片上的**刷新**，然后硬刷新要使用的网页。官方包通过 manifest public key 固定扩展 ID，因此相同扩展包在不同机器和目录中保持同一身份。

## 使用

打开 chatgpt.com 出图后：

1. **自动**：发现大图会自动 POST 到 MOSA（toast 提示）
2. **手动**：右下角悬浮 **MOSA** 面板
   - **保存当前图**：页面上最大的那张
   - **保存全部大图**：本页最多 12 张

Prompt 优先级：同一会话消息中的生成 metadata（如 `revised_prompt`）→ 同一图片的资源键（`cid + id`）→ 对应用户消息 → `not-available`（图仍入库）。
不会把整页最后一条用户消息误配给历史图片。

ChatGPT 网页捕获现在会把“媒体”和“生成事件”分开记录。同一张去重后的图片可以对应多次独立生成；MOSA 自己构造的 `capture_context_id` 只用于关联一次网页捕获，不会冒充 OpenAI 的 generation-call ID。若页面运行时数据明确包含 tool-call、generation-call、response 或 provider asset ID，会分别保存为 provider 字段，但其证据等级仍是 `observed`，不是 OpenAI 公共 API 的 `provider_verified`。延迟补抓时优先沿用生成事件自身携带的 conversation ID，不只依赖当前页面 URL。网页捕获不会仅凭会话顺序自动建立父子版本关系。

MOSA 会在本地为同一 ChatGPT conversation 的 Generation Event 计算“关系候选”，但不会自动写成正式父子边。明确复用先前生成图的 provider asset ID 是强证据；“再改一下 / 把背景换黑 / 保持其他不变”等修改型用户指令、相邻生成和时间距离只能作为辅助信号。候选必须由用户确认后才进入正式生成树；只因为两张图前后出现，不会自动建立版本关系。

ChatGPT 中能够明确识别为本轮上传输入的参考图，会作为该轮生成记录的私有附件保存：按内容 hash 去重，绑定到随后生成图片的 recipe snapshot，但不会作为独立素材出现在瀑布流、搜索、最近添加或素材总数中。旧版已作为普通素材入库的参考图不会被自动迁移或删除。Google 站点只有在页面结构和会话标识都能可靠确认时才会采用同一机制；当前不会仅凭“图片出现在生成图之前”猜测参考关系。

提示词来源有三条通道，互为兜底：

1. **实时流**：ChatGPT 对多数账号用 WebSocket 推流，扩展会解析其中带图片资产的帧（`fetch`/`XHR` 看不到这些）。
2. **会话元数据**：打开或切换会话时页面自己拉取的会话 JSON。
3. **主动重读**：入库后 2.8 秒、7.2 秒各重试一次，复用页面自身的登录请求头去读当前会话；拿到更好的提示词会通过 hash 去重自动升级已入库的图。

第 3 条失败时右下角面板会显示原因，不再静默丢失。

打开 Gemini（`gemini.google.com`）、Flow（`labs.google`）或 Google AI Studio（`aistudio.google.com`）出图后，扩展只对视口中已加载且达到最小尺寸的用户可见图片自动入库。Gemini 只读取生成图所属 `model-response` 前、同一局部消息结构中的最近可见 `user-query`；Flow 仅在图片组有唯一、相邻的「Reuse Prompt」卡片时保存该卡片的可见 Prompt；AI Studio 只读取图片所在 `ms-chat-session` 内、图片 Model 回合之前最近的页面可见用户 Prompt 回合。三者均标记为「未验证为实际生图提示词」，不会读取输入框、编辑器、隐藏内容、模型思考、其他会话或登录信息；若图片先于 Prompt 完成渲染，只会对同一图片的局部关联信息进行有界重试。

在这三个 Google 站点上，也可右键生成图片后选择「保存图片到 MOSA」；Gemini、Flow 与 AI Studio 手动保存时也只会按上述局部规则匹配 Prompt，未匹配则不保存文字。

## 数据与权限

- 扩展只在清单声明的 ChatGPT、Gemini、Flow 和 Google AI Studio 域名中运行，并只把数据发送到选项中配置的本机 MOSA 地址。
- ChatGPT 入库数据包括图片字节、匹配到的 Prompt/用户消息、页面 URL、会话/消息 ID、模型信息、采集时间和扩展版本；页面运行时明确暴露时，还会保存彼此独立的 tool-call、generation-call、response 和 provider asset 标识。Gemini、Flow 与 AI Studio 只有在上述局部匹配成功时才额外包括该页面可见 Prompt。
- MOSA 地址、Token 和自动采集开关保存在 Chrome 本地存储，不使用同步存储。
- 图片下载需要清单中列出的 OpenAI/Google 静态资源域名权限；本机通信只允许 `127.0.0.1` 或 `localhost`。
- MOSA 不会因此获得任何受支持站点的账号密码或 API Key。完整说明见 [PRIVACY.md](../../PRIVACY.md)。

## 限制

- Google 站点使用稳定性较低的可见 `<img>` 识别；全屏看图器或站点更新可能需要刷新页面后重试
- 全屏看图器 DOM 多变；若自动没命中，用悬浮「保存当前图」
- GPT 网页未暴露生成 metadata 时，扩展只保留对应用户消息，不会伪造模型实际执行的提示词
- 启发式判断“像生图 Prompt”的文本只作为恢复线索，不会被升级为 `generation-tool-prompt`
- 无标记的 caption 只在**图片工具消息**内被接受；助手的普通回复即使提到风格词也不会被当成提示词
- 重读会话会复用页面自身的登录请求头。这些值只留在页面世界，不写入存储、不进后台、不发给 MOSA（见 [PRIVACY.md](../../PRIVACY.md)）
- 相同内容 hash 去重
- 参考图附件不进入素材库；当前可靠自动识别以 ChatGPT 上传输入为准，Flow/Gemini 不按页面顺序猜测参考图
- 改扩展代码后要在 `chrome://extensions` 点刷新，并硬刷新网页

## 许可

本扩展是 MOSA 的组成部分，受仓库根目录 [LICENSE](../../LICENSE) 约束。重新分发时必须保留许可证条款和 Required Notice。
