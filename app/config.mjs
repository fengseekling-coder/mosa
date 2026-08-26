// 常量与纯配置：app.js 只保留 import 与调用（REFACTORING-PLAN R1 批次 2）。
// 骨架渲染常量在模块作用域 export，天然先于任何调用绑定，不存在 temporal dead zone。
export const SORT_ORDERS = ["newest", "oldest", "name"];
export const SOURCE_FACETS = { codex: "codex-generated", cowart: "cowart-generated", grok: "grok-generated" };
// Sidebar source groups are deterministic provenance buckets, not user-created
// collections. Keep this list limited to automatic AI capture / bridge sources so
// historical local imports do not leak back into the primary navigation.
export const SIDEBAR_SOURCE_TYPES = [
  "web-chatgpt",
  "web-gemini",
  "web-flow",
  "web-google-ai-studio",
  "codex-generated",
  "grok-generated",
  "cowart-generated",
];
export const SCOPES = ["all", "favorite", "recent"];
export const FACET_KEYS = ["source", "group", "category", "style", "conversation", "generationBatch"];
export const SIDEBAR_GROUP_LIMIT = 5;
export const GALLERY_DENSITIES = ["image", "info"];
export const CARD_TITLE_MAX = 52;
export const SKELETON_TILE_COUNT = 12;
export const STATUS_ANNOUNCEMENT_DURATION = 3000;
export const LIVE_REGION_WRITE_DELAY = 32;
export const SOURCE_LABEL_KEYS = {
  "codex-generated": "sourceCodex",
  "cowart-generated": "sourceCowart",
  "grok-generated": "sourceGrok",
  "web-chatgpt": "sourceWebChatgpt",
  "web-gemini": "sourceWebGemini",
  "web-flow": "sourceWebFlow",
  "web-google-ai-studio": "sourceWebGoogleAiStudio",
  "local-file": "sourceManual",
};
