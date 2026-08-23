const TAG_RULES = [
  ["人物", /\b(?:person|people|portrait|character|man|woman|girl|boy|face|human)\b|人物|肖像|角色|女孩|男孩|男人|女人/u],
  ["建筑", /\b(?:architecture|building|interior|room|house|city|street|skyscraper)\b|建筑|室内|房间|城市|街道|高楼/u],
  ["自然", /\b(?:nature|landscape|mountain|forest|ocean|sea|lake|flower|garden|sky|cloud)\b|自然|风景|山|森林|海洋|湖|花|花园|天空|云/u],
  ["产品", /\b(?:product|packaging|bottle|shoe|chair|furniture|object)\b|产品|包装|瓶子|鞋|家具/u],
  ["动物", /\b(?:animal|cat|dog|bird|horse|fish|wildlife)\b|动物|猫|狗|鸟|马|鱼/u],
  ["科幻", /\b(?:sci-?fi|cyberpunk|futuristic|robot|space|neon)\b|科幻|赛博朋克|未来|机器人|太空|霓虹/u],
  ["时尚", /\b(?:fashion|editorial|couture|runway|outfit|clothing)\b|时尚|杂志|高级定制|T台|服装/u],
  ["极简", /\b(?:minimal|minimalist|clean|simple)\b|极简|简洁/u],
  ["写实", /\b(?:realistic|photorealistic|photo-realistic|cinematic)\b|写实|照片级|电影感/u],
  ["插画", /\b(?:illustration|illustrated|anime|cartoon|comic|2d)\b|插画|动漫|卡通|漫画/u],
  ["3D", /\b(?:3d|render|rendered|octane|blender)\b|三维|渲染/u],
  ["功能", /\b(?:icon|logo|poster|cover|background|wallpaper|thumbnail|diagram|mockup)\b|图标|标志|海报|封面|背景|壁纸|缩略图|图表|样机/u],
];

function cleanTag(value) {
  return String(value || "").trim().replace(/^[[({\s]+|[\])},.!?;:：，。！？；]+$/gu, "").replace(/\s+/g, " ").slice(0, 32);
}

export function uniqueTags(values) {
  const seen = new Set();
  return (Array.isArray(values) ? values : []).map(cleanTag).filter((value) => {
    const normalized = value.toLocaleLowerCase();
    if (!value || seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
}

export function derivePromptTags(asset = {}) {
  const prompt = [asset.prompt, asset.theme, asset.skill, asset.style, asset.category].filter(Boolean).join(" ");
  const tags = [];
  for (const [tag, pattern] of TAG_RULES) if (pattern.test(prompt)) tags.push(tag);
  return uniqueTags(tags);
}

export function assetTags(asset = {}) {
  return uniqueTags([...(asset.tags || []), ...derivePromptTags(asset)]);
}
