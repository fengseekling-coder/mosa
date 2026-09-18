# Changelog

This file records user-visible changes. Internal deployment notes, local paths, and development handoffs are intentionally not tracked in the public repository.

## Unreleased

### Search & Stack reliability / 搜索与堆叠稳定性

- Custom Stack names are now searchable from the collapsed gallery while raw asset and Stack-interior searches keep their existing member-level semantics.
- Whole-Stack Trash operations now preserve and reconcile confirmed progress when a later batch request is interrupted; outcomes without a response are reported as unresolved instead of being mislabeled as failures or retried blindly.
- Local context-menu refresh events are scoped to the project that was mutated so a long-running operation cannot reconcile its result into a different project after navigation.

### Performance / 性能

- Added an indexed short-Unicode candidate table for one- and two-character non-ASCII search terms, with schema backfill and write-path synchronization, avoiding full-library `LIKE` scans for common short CJK queries.
- Collapsed gallery paging now uses a dedicated no-filter fast path and Stack annotations aggregate only the Stacks relevant to returned rows instead of scanning every active Stack member.
- The 50k performance gate now separately covers cold search, short CJK search, and a mixed library with 2,000 five-member Stacks.

### Web Capture activity / 网页收录状态

- Settings now shows the browser extension's bounded pending/retrying queue summary together with recent Runtime ingest outcomes and Prompt-availability status.
- The extension reports only redacted queue diagnostics to the authenticated loopback Runtime; raw Prompt text, page/media URLs, and media bytes are excluded from this status channel.
- A Settings retry action requests the extension to drain its existing durable queue; MOSA does not create a second delivery queue or blindly duplicate failed captures.

## 0.2.1-rc.14 — 2026-09-16 / Release Candidate

### Drag & drop import / 拖放导入

- Dropping files and whole folders onto the gallery or the import card now imports every supported image/video in one batched queue, with progress in the gallery status line and per-batch failure isolation instead of "first file only".
- Unsupported files inside dropped folders are skipped and reported as an informational count; a folder full of non-media files no longer exhausts the import budget.
- The file picker accepts multi-selection; single files keep opening the familiar import flow.
- Holding a card drag and leaving the MOSA window hands the selected assets to the OS as a native file drag (Electron desktop), so assets can be dropped into Finder, browsers, and other apps.

### Security & privacy / 安全与隐私

- Web Capture pairing now requires an explicit native confirmation dialog in front of the user; headless CLI runtimes deny pairing by default (`MOSA_WEB_CAPTURE_PAIR=auto` opts in for automation).
- The CLI server no longer prints the management token into redirected output logs; interactive terminals keep the URL handoff.
- Anonymous usage telemetry can be disabled locally with `MOSA_DISABLE_TELEMETRY=1`.
- Web capture upload sessions are bounded (8 concurrent) to cap temp disk usage.

### Reliability / 稳定性

- The JSON fallback store now serializes every per-asset metadata/lifecycle write through one lock, closing a race where a metadata edit could resurrect an asset that was just moved to the Trash.
- Group hard-delete and asset creation now stage file removals/copies so interrupted operations roll back or clean up instead of leaving half-deleted or half-written files.
- Windows update apply keeps the previous installation parked for recovery until the updated app's next boot sweeps it, and the rollback deletion is explicitly scoped to the replacement payload.
- `npm run check` now also syntax-checks `.cjs` sources (the desktop preload was previously outside its coverage).

## 0.2.1-rc.13 — 2026-09-13 / Release Candidate

### Codex default source alignment / Codex 默认来源对齐

- MOSA now treats Codex's own `CODEX_HOME` as the single default root for Codex-owned local data. When `CODEX_HOME` is unset, the default remains `$HOME/.codex` on macOS/Linux and `%USERPROFILE%\.codex` on Windows.
- Automatic Codex image archive reads `generated_images` under that root, while Prompt/model/provenance matching reads `sessions` under the same root. Cowart's MOSA canvas and registry defaults are rebased from that same Codex root as well.
- Codex automatic archive now treats `generated_images` and `sessions` as two coordinated sources: standard generated files remain primary, while inline `image_generation_call` / `image_generation_end` results can recover an image when Codex did not persist the advertised generated file.
- Session JSONL processing was redesigned as an incremental byte-indexed reader. After the initial scan, an active runtime reads only newly appended complete records instead of reparsing whole session files on every bridge reconciliation.
- Inline session images are size-limited, base64-validated, binary-signature checked, staged only inside MOSA's private recovery directory, copied into the library, and then removed. Session `saved_path` values do not widen MOSA's filesystem trust boundary.
- Removed the MOSA-invented Windows `Documents\\codex` default and project-directory image scanning path. Custom source variables remain explicit overrides, but they no longer redefine Codex's defaults implicitly.
- Runtime startup resolves the Codex/Cowart source locations once and passes the same paths to every integration, preventing image, session, and Cowart components from drifting onto different roots.
- Codex automatic archive now reconciles two native sources: files under `<CODEX_HOME>/generated_images` and image-generation events appended to `<CODEX_HOME>/sessions`, so result-only generations can still be recovered when Codex does not persist the image file.
- Session JSONL processing is incremental by byte offset, merges duplicate call/end surfaces by generation identity, carries incomplete records across scans, and bounds inline-result recovery without rescanning whole sessions on every poll.
- Recovered session results are validated into a MOSA-private temporary area, copied into the library, then removed; they are never treated as external trusted roots or later hard-linked back to Codex session data.

## 0.2.1-rc.12 — 2026-09-12 / Release Candidate

### Startup critical-path redesign / 启动关键路径重构

- Shows a lightweight MOSA shell immediately while local runtime ownership and SQLite startup continue in parallel.
- Moves Codex, Grok, Cowart, and Cowart discovery scans off the runtime readiness path and isolates integration startup failures from the core library.
- Probes local runtime discovery ports concurrently while preserving primary-port fail-closed ownership rules.
- Runs independent first-view renderer requests in parallel so the gallery is no longer serialized behind project/version reads.

## 0.2.1-rc.11 — 2026-09-11 / Release Candidate

### Live drag preview / 实时拖拽预览

- Replaced the invisible single-asset drag state with a lightweight thumbnail preview that follows the pointer in real time.
- Added a short lift-in animation and a compact count badge for multi-selection drags without delaying pointer tracking or changing Stack/group drop semantics.

## 0.2.1-rc.10 — 2026-09-11 / Release Candidate

### Drag feedback cleanup / 拖拽反馈清理

- Removed the empty floating drag ghost for single-asset Stack and group drags.
- Reduced multi-selection drag feedback to a compact count badge while keeping drop-target highlighting and Stack/group behavior unchanged.

## 0.2.1-rc.9 — 2026-09-11 / Release Candidate

### Stack drag authentication validation / 堆叠拖拽鉴权验收

- Rebuilt the macOS application from the post-PR #78 `main` baseline so the installed desktop bundle and its local runtime include the authenticated drag-to-stack recovery shipped in `cbd4516`.
- Preserved the browser-session capability and runtime-supervision fixes while giving the corrected build a distinct release-candidate version for reliable rollback and field diagnosis.

## 0.2.1-rc.8 — 2026-09-11 / Release Candidate

### Desktop runtime ownership and drag workflow recovery / 桌面运行时接管与拖拽工作流恢复

- Hardened macOS background-runtime supervision so the desktop app can safely take ownership of the correct local MOSA runtime without leaving stale process state behind.
- Restored authenticated drag-to-stack creation and drag-into-existing-stack workflows while preserving the local runtime capability boundary.
- Added a first-party HttpOnly browser-session capability for direct loopback Web UI launches so state-changing actions no longer fail with `Unauthorized MOSA client.` when the page is opened without a fragment token.
- Fixed drag-to-group target lifetime so dropping assets onto manual groups or Unorganized continues to work after drag visual state is cleared.
- Expanded end-to-end regression coverage to exercise direct drag Stack creation from a bare local URL, Stack reordering, and browser mutation authentication.

## 0.2.1-rc.7 — 2026-09-11 / Release Candidate

### Runtime integrity, group workflows, and release validation / 运行时完整性、分组工作流与发布验证

- Hardened local runtime integrity with authenticated state-changing API requests, PID-reuse-safe runtime ownership, transactional metadata and generation-lineage updates, stricter Trash path boundaries, and isolated derivative processing so native image decoder failures cannot take down the main MOSA runtime.
- Strengthened Web Capture and gallery synchronization under concurrency, including serialized chunk uploads, safer ingest-slot handoff, revision-aware reconciliation, and protection against stale refreshes overwriting newly appended gallery pages.
- Expanded manual group management with drag-to-group, batch move/remove, persistent ordering and colors, group merge, group statistics, normalized case-insensitive naming, and safer version-family moves.
- Aligned source, Electron, E2E, and packaged-app validation with the runtime client-capability model across macOS and Windows, including authenticated packaged smoke coverage.
- Added a durable third-party notice crediting APSAL Open `v0.14.0` as a design influence on MOSA's recipe snapshot model, while explicitly separating that attribution from MOSA's own PolyForm Noncommercial licensing.

## 0.2.1-rc.6 — 2026-09-10 / Release Candidate

### Gallery stability and dependency hardening / 图库稳定性与依赖加固

- Stabilized infinite-scroll pagination so adding the next gallery page no longer temporarily collapses the virtual scroll extent and nudges the viewport.
- Hydrates all currently visible virtual gallery cards in the same paint cycle while keeping background hydration bounded, eliminating the visible placeholder-to-card ripple during fast paging.
- Hardened gallery interaction and navigation race handling, including incremental Masonry corrections that preserve stable per-column placement rather than globally rebalancing loaded cards.
- Updated Sharp to the release carrying the current libheif security fixes used by MOSA's packaged image pipeline.

## 0.2.1-rc.5 — 2026-09-08 / Release Candidate

### Desktop distribution, large-library navigation, and synchronization / 桌面分发、大图库导航与同步

- Added the first-party desktop release manifest and update-check flow. Packaged Windows builds can download the matching portable ZIP in-app, verify its size and SHA-256 digest, replace the application directory through a detached helper, and roll back on replacement failure.
- Added a macOS DMG distribution path with drag-to-Applications replacement behavior while keeping release-grade Developer ID signing and notarization fail-closed behind `desktop:release`.
- Added Stack Inspector behavior, windowed gallery navigation, large-gallery virtualization, and safer selection/navigation handling so loaded pages and scroll state survive common library transitions.
- Reworked library synchronization around revision-aware incremental change reconciliation instead of routinely reloading the entire loaded gallery window after one asset changes.
- Hardened desktop runtime ownership and stale-runtime handoff, Web Capture delivery/retry behavior, capture lookup performance, Windows packaging/runtime paths, file reveal on spaced Windows paths, and Inspector/context-submenu rendering.
- Aligned packaged anonymous install/activity reporting across website, GitHub, and directly shared packages while keeping development and QA launches excluded.

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
