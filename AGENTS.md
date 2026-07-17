# Asset Manager Project Instructions

## Project boundary

- This repository is the user's only Build Week project. Keep all product code, assets, tests, and Git commits inside this directory.
- Cowart is an externally installed Codex plugin at `/Users/azhuilab/plugins/cowart`; never vendor, clone, or copy its code into this repository.
- Cowart runtime data belongs outside this repository at `/Users/azhuilab/.codex/cowart-data/asset-manager`.

## Natural-language launch commands

- When the user says **“启动素材管理”**, start or reuse the local Asset Manager on `http://127.0.0.1:43517/`. Open it in Codex's in-app browser by default; open it in the system browser when the user explicitly asks for a local browser.
- When the user says **“启动画布”**, use Cowart's `render_cowart_canvas_widget` MCP tool in a fresh Codex task with:

  ```json
  {
    "projectDir": "/Users/azhuilab/codex_aigc/asset-manager",
    "canvasDir": "/Users/azhuilab/.codex/cowart-data/asset-manager"
  }
  ```

  Cowart opens as a native Codex widget. If the plugin MCP is not available in the current task, ask the user to open a new Codex task after the plugin installation.
- When the user explicitly says **“在浏览器打开画布”**, use Cowart's local-development fallback with the same external data directory, then open its local URL in the requested browser.

## Asset-to-canvas integration

- When the user asks to put a saved Asset Manager image on the Cowart canvas, first retrieve the asset through `asset_get`.
- Then call Cowart's `insert_cowart_image` with the asset's `image_path`, the same `projectDir`, and the external `canvasDir` above.
- Do not create a `canvas/` folder inside this repository. It is ignored as a safety net.
