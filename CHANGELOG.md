# Changelog

## Unreleased

- Added Node 22 baseline, ESLint, source checks, dependency audit scripts, and GitHub Actions CI for `main` and `develop`.
- Added verified JSON-to-SQLite migration with FTS5 search, stable cursor pagination, empty-group preservation, JSON backup, corruption reporting, and resumable verification.
- Added durable WebP preview/thumbnail jobs and gallery pagination while keeping original image URLs compatible.
- Added automatic monitoring for project-local Cowart canvases opened from Codex while preserving the MOSA dedicated canvas.
- Added event-based canvas discovery, persisted project registration, per-canvas bridge status, and Cowart project provenance on archived assets.
- Added asset-based recipe version trees with stable branching history, archived-node visibility, and independent images and provenance per version.
- Added REST, MCP, and bilingual Web UI surfaces for creating and browsing versions, with required change summaries and typed relationship errors.
- Added SQLite schema v2 migration tracking, indexed version traversal, duplicate-ID migration validation, and conflict-safe concurrent creates.
- Changed `asset_duplicate` to start an independent version root while retaining `duplicated_from` provenance.
- Fixed registered external Cowart canvases so imports trust only that canvas's `pages` root without widening normal import permissions.

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
