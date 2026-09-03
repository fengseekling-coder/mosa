# Changelog

This file records user-visible changes. Internal deployment notes, local paths, and development handoffs are intentionally not tracked in the public repository.

## 0.2.1-rc.4 — 2026-09-02 / Release Candidate

### Library organization and desktop branding / 素材整理与桌面品牌

- Added an **Unorganized / 未整理** library view. It shows assets that are neither in a manual group nor part of a Stack, so the items that still need curation have a dedicated place.
- Refined sidebar navigation so selecting a primary view, source, or manual group establishes one clear library context while other filters can still refine it.
- macOS and Windows desktop packages now use the MOSA app icon instead of Electron’s default icon.
- Build identity is generated only inside each package, preventing an outdated tracked identity file from being included in a new build.

## 0.2.1-rc.3 — 2026-09-02 / Release Candidate

### Desktop upgrade reliability / 桌面升级可靠性

- A packaged desktop upgrade now waits for a KeepAlive-managed local MOSA service to finish restarting and report the exact new build identity, then opens directly instead of requiring a second manual launch.
- The handoff continues to fail closed if a different, same-version, newer, unverified, QA, development, or explicit-port runtime is encountered.

## 0.2.1-rc.2 — 2026-09-02 / Release Candidate

### Desktop upgrade reliability / 桌面升级可靠性

- A newer packaged MOSA build can now take over a verified, strictly older local runtime for the same library, then reconnect only after the replacement reports the new build identity.
- Development, QA, explicit-port, same-version, newer-version, and unverified local runtimes remain fail-closed and are never stopped automatically.
- Startup errors no longer expose internal build fingerprints or Git identifiers to users.

## 0.2.1-rc.1 — 2026-09-02 / Release Candidate

### Reliability and privacy / 可靠性与隐私

- Packaged desktop builds now report the same minimal anonymous install/activity UUID regardless of whether the app package came from the MOSA website, GitHub, or a directly shared copy.
- Anonymous usage reporting is independent from update-manifest parsing, retries with the same installation UUID after transient failures, and persists the local UUID/profile atomically.
- Development and QA launches remain excluded from production usage metrics.

## 0.2.0 — 2026-08-28

> **Local visual memory for AI creation.**
> 把 Codex、ChatGPT、Grok 与 Cowart 中的创作结果，连同可用的 Prompt、来源和版本，留在自己的电脑上。

### New / 新增

- **More creation sources, one local library.** Add optional Web Capture for ChatGPT, Gemini, Flow, and Google AI Studio; local Grok Build CLI image and video archiving; and safer project-local Cowart canvas discovery alongside Codex image collection.
- **A library built for reuse.** Add verified JSON-to-SQLite migration, FTS5 search, stable pagination, WebP previews and thumbnails, tags, favorites, and provenance while preserving originals.
- **Version history that keeps the why.** Add asset-based recipe version trees, REST and MCP version APIs, and bilingual UI flows for browsing versions and creating the next one.

### Removed / 移除

- Removed controlled insertion from MOSA into Cowart canvases to focus this release on asset collection, archiving, and version management. Cowart canvas archiving (collecting snapshots into the library) is unchanged.

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

### Windows desktop preview

- Added a shared Electron platform boundary so the renderer, local runtime, storage, Web Capture pairing, and most desktop behavior remain one implementation across macOS and Windows.
- Added the `win32-x64` Forge target with Windows-native `better-sqlite3` and Sharp runtime selection, ASAR native unpacking, Windows executable/path resolution, and Windows packaged-smoke support.
- Added Windows path safety for drive-letter paths, UNC paths, and cross-drive containment; source defaults now flow through a centralized source-location resolver instead of scattered platform assumptions.
- Added a Windows CI lane for x64 packaging, platform/path contracts, Electron E2E, and packaged smoke.
- Verified on a real Windows machine that MOSA starts successfully, renders the shared library and Inspector, and automatically collects Codex assets. The Windows shell keeps the native title bar while hiding Electron's visible application-menu row and retaining keyboard accelerators.

### Licensing / 许可

- Version 0.2.0 and later are source-available under the PolyForm Noncommercial License 1.0.0. Noncommercial personal, educational, research, hobby, modification, and distribution uses remain permitted; commercial use requires separate written authorization.
- [v0.1.0](https://github.com/fengseekling-coder/mosa/releases/tag/v0.1.0) remains the final MIT-licensed public source snapshot. Existing MIT copies retain their original rights.

### Known limits / 已知限制

- **Desktop builds are not a signed release.** macOS arm64 and Windows 10/11 x64 development/package targets exist, but no signed public desktop installer is published for 0.2.0. Windows is currently Preview/Testing; installer/signing/automatic-update work is still pending.
- **Windows source coverage is not complete yet.** Codex automatic collection has been verified on a real Windows machine; Grok and Cowart Windows source discovery remain unverified until their actual local layouts are confirmed.
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
