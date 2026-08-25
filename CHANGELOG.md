# Changelog

This file records user-visible changes. Internal deployment notes, local paths, and development handoffs are intentionally not tracked in the public repository.

## 0.2.0 — Unreleased / 待发布

> **Local visual memory for AI creation.**
> 把 Codex、ChatGPT、Grok 与 Cowart 中的创作结果，连同可用的 Prompt、来源和版本，留在自己的 Mac 上。

### New / 新增

- **More creation sources, one local library.** Add optional Web Capture for ChatGPT, Gemini, Flow, and Google AI Studio; local Grok Build CLI image and video archiving; and safer project-local Cowart canvas discovery alongside Codex image collection.
- **A library built for reuse.** Add verified JSON-to-SQLite migration, FTS5 search, stable pagination, WebP previews and thumbnails, tags, favorites, and provenance while preserving originals.
- **Version history that keeps the why.** Add asset-based recipe version trees, REST and MCP version APIs, and bilingual UI flows for browsing versions and creating the next one.
- **Return work to the canvas.** Add controlled insertion from MOSA into approved Cowart canvases, with provenance and deduplication to avoid re-importing the same asset.

### Web image capture

- Added an optional Chrome extension that captures ChatGPT-generated images with message-scoped Prompt and provenance data.
- Added a loopback-only ingest endpoint and bridge status endpoint. Web capture is disabled until `MOSA_WEB_CAPTURE_TOKEN` is explicitly configured.
- Added image-byte, MIME, size, pixel-count, origin, and request-envelope validation for browser-extension ingestion.
- Stores the extension address, Token, and auto-capture preference in Chrome local storage rather than synchronized storage.
- Hardened extension reload handling so startup context loss is reported reliably and temporary settings failures cannot re-enable auto-capture or overwrite the saved preference.
- Added Gemini, Flow, and Google AI Studio page support to the optional Chrome extension. These sites capture only user-visible generated images and page provenance; they do not inspect session APIs, credentials, or hidden prompts.

### Reliability and privacy / 可靠性与隐私

- Web Capture is loopback-only and disabled by default. It requires an explicit ingest Token and approved extension origin, then validates image bytes, MIME type, size, pixel count, and request shape.
- Migration verifies records, original-image hashes, and library structure before SQLite becomes authoritative; JSON remains a backup rather than a second live store.
- Grok and Cowart imports preserve their source boundaries, report health and errors, and deduplicate without widening the permitted local paths.
- Add Node 22 baseline, source checks, dependency audit scripts, and GitHub Actions CI for the public source.

### macOS desktop

- Added an Apple Silicon Electron shell that opens the existing MOSA Web UI without adding an AI model, cloud service, or frontend rewrite.
- Added verified attach, owned-runtime, and conflict modes for the local MOSA service, preserving external services and stopping only runtimes owned by the desktop app.
- Added Electron Forge packaging with ASAR and unpacked native dependencies for `better-sqlite3` and `sharp`.

### Licensing / 许可

- Version 0.2.0 and later are source-available under the PolyForm Noncommercial License 1.0.0. Noncommercial personal, educational, research, hobby, modification, and distribution uses remain permitted; commercial use requires separate written authorization.
- [v0.1.0](https://github.com/fengseekling-coder/mosa/releases/tag/v0.1.0) remains the final MIT-licensed public source snapshot. Existing MIT copies retain their original rights.

### Known limits / 已知限制

- **Not a packaged desktop release.** MOSA currently starts from source on macOS with Node.js 22 or newer; no desktop installer is published for 0.2.0.
- **No cloud by default.** MOSA provides no remote sync, embedded AI model, semantic search, or automatic library upload.
- **Capture is deliberately conservative.** Web Capture needs a locally loaded extension; when MOSA cannot confidently match generation context, it records the Prompt as unavailable instead of guessing.

## 0.1.0 - Final MIT-licensed source snapshot

- Added a local-first visual library that preserves prompts, image metadata, source paths, and provenance alongside each asset.
- Added automatic Codex image reconciliation and provenance capture from local image-generation records.
- Added Cowart canvas synchronization, source-aware reuse, and deduplication for images returned to the canvas.
- Added a browser UI with search, filters, metadata editing, English and Chinese interfaces, and a local MCP server.
- Added a reproducible judging path using tracked sample records and the `npm test` suite.

## 2026-07-19 - UI polish

- Fixed blank space below gallery cards and normalized vertical spacing.
- Truncated long collection names in the sidebar while preserving their full value in the hover title.
- Kept the complete README interface screenshot and removed two redundant detail screenshots.
