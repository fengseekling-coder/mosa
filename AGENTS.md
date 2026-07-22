# MOSA Project Instructions

## Project boundary

- This repository is the user's only Build Week project. Keep all product code, assets, tests, and Git commits inside this directory.
- Cowart is an externally installed Codex plugin at `/Users/azhuilab/plugins/cowart`; never vendor, clone, or copy its code into this repository.
- Cowart runtime data belongs outside this repository. MOSA's dedicated canvas is `/Users/azhuilab/.codex/cowart-data/mosa`; automatically detected Cowart projects keep their own `<projectDir>/canvas` directories.

## Natural-language launch commands

- When the user says **“启动 MOSA”**, start or reuse the local MOSA library on `http://127.0.0.1:43517/`. Open it in Codex's in-app browser by default; open it in the system browser when the user explicitly asks for a local browser.
- When the user says **“启动画布”**, use Cowart's `render_cowart_canvas_widget` MCP tool in a fresh Codex task with:

  ```json
  {
    "projectDir": "/Users/azhuilab/codex_aigc/mosa",
    "canvasDir": "/Users/azhuilab/.codex/cowart-data/mosa"
  }
  ```

  Cowart opens as a native Codex widget. If the plugin MCP is not available in the current task, ask the user to open a new Codex task after the plugin installation.
- When the user explicitly says **“在浏览器打开画布”**, use Cowart's local-development fallback with the same external data directory, then open its local URL in the requested browser.

## Asset-to-canvas integration

- When the user asks to put a saved MOSA image on the Cowart canvas, first retrieve the asset through `asset_get`.
- Then call Cowart's `insert_cowart_image` with the asset's `image_path`, the same `projectDir`, and the external `canvasDir` above. Pass the source MOSA ID in `assetMeta.mosaAssetId` so the Cowart bridge does not archive that same image a second time.
- Do not create a `canvas/` folder inside this repository. It is ignored as a safety net.

## Cowart-to-library automatic registration

- MOSA starts a Cowart bridge manager with the web server. It watches the dedicated canvas plus each project automatically detected from a real Cowart launch call in local Codex task records; a detected project is monitored only at `<projectDir>/canvas/pages/`.
- Detected project roots are persisted outside the repository in `~/.codex/mosa/cowart-projects.json`. Discovery must stay event-based and require Cowart-owned marker files; never scan arbitrary project directories or broad filesystem roots for canvases.
- The bridge is the source of truth for auto-archival. It covers Cowart image generation, AI-holder replacement, and annotation editing without changing the Cowart plugin or requiring the creating task to call `asset_create`.
- It deduplicates by the exact Cowart page-asset path. The bridge skips images whose Cowart asset metadata identifies an existing MOSA asset.
- Cowart snapshots expose an image description but not the full generation prompt. Auto-archived records therefore label their Prompt as canvas alt text; attach the original full prompt later when it is available.
