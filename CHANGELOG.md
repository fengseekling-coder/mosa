# Changelog

This file records user-visible changes. Operational deployment state and local paths belong in `HANDOFF.md`, not here.

## 0.2.0 — Unreleased / 待发布

> **Local visual memory for AI creation.**
> 把 Codex、ChatGPT、Grok 与 Cowart 中的创作结果，连同可用的 Prompt、来源和版本，留在自己的 Mac 上。

### New / 新增

- **More creation sources, one local library.** Add optional ChatGPT Web Capture, local Grok Build CLI image and video archiving, and safer project-local Cowart canvas discovery alongside Codex image collection.
- **A library built for reuse.** Add verified JSON-to-SQLite migration, FTS5 search, stable pagination, WebP previews and thumbnails, tags, favorites, and provenance while preserving originals.
- **Version history that keeps the why.** Add asset-based recipe version trees, REST and MCP version APIs, and bilingual UI flows for browsing versions and creating the next one.
- **Return work to the canvas.** Add controlled insertion from MOSA into approved Cowart canvases, with provenance and deduplication to avoid re-importing the same asset.

### Reliability and privacy / 可靠性与隐私

- ChatGPT Web Capture is loopback-only and disabled by default. It requires an explicit ingest Token and approved extension origin, then validates image bytes, MIME type, size, pixel count, and request shape.
- Migration verifies records, original-image hashes, and library structure before SQLite becomes authoritative; JSON remains a backup rather than a second live store.
- Grok and Cowart imports preserve their source boundaries, report health and errors, and deduplicate without widening the permitted local paths.
- Add Node 22 baseline, source checks, dependency audit scripts, and GitHub Actions CI for the public source.

### Licensing / 许可

- Version 0.2.0 and later are source-available under the PolyForm Noncommercial License 1.0.0. Noncommercial personal, educational, research, hobby, modification, and distribution uses remain permitted; commercial use requires separate written authorization.
- [v0.1.0](https://github.com/fengseekling-coder/mosa/releases/tag/v0.1.0) remains the final MIT-licensed public source snapshot. Existing MIT copies retain their original rights.

### Known limits / 已知限制

- **Not a packaged desktop release.** MOSA currently starts from source on macOS with Node.js 22 or newer; no desktop installer is published for 0.2.0.
- **No cloud by default.** MOSA provides no remote sync, embedded AI model, semantic search, or automatic library upload.
- **Capture is deliberately conservative.** ChatGPT capture needs a locally loaded extension; when MOSA cannot confidently match generation context, it records the Prompt as unavailable instead of guessing.

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
