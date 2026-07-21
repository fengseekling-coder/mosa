# Changelog

## Unreleased

- Added opt-in monitoring for multiple project-local Cowart canvases while preserving the MOSA dedicated canvas.
- Added persisted project registration, per-canvas bridge status, and Cowart project provenance on archived assets.

## 0.1.0 — OpenAI Build Week release

- Added a local-first visual library that preserves prompts, image metadata, source paths, and provenance alongside each asset.
- Added automatic Codex image reconciliation and provenance capture from local image-generation records.
- Added Cowart canvas synchronization, source-aware reuse, and deduplication for images returned to the canvas.
- Added a browser UI with search, filters, metadata editing, English and Chinese interfaces, and a local MCP server.
- Added a reproducible judging path using tracked sample records and the `npm test` suite.

## 2026-07-19 — UI polish

- Fixed blank space below gallery cards and normalized vertical spacing.
- Truncated long collection names in the sidebar while preserving their full value in the hover title.
- Added layout and visual-QA documentation.
- Kept the complete README interface screenshot and removed two redundant detail screenshots.
