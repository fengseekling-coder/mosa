# MOSA Operations Guide

This guide covers local operation of an existing MOSA installation. It does not replace the product overview in `README.md`, and it uses placeholders instead of a maintainer's personal paths or ports.

## Operating Modes

### Development service

For a checkout and its sample data, start the default local service:

```bash
npm ci
npm start
```

The default address is `http://127.0.0.1:43517`. This process starts the Codex bridge, Grok media bridge, Cowart bridge, Cowart discovery, and derivative worker. New media is collected only while the service is running.

### Managed local service

For a persistent local installation, use the operating system's process manager and configure a dedicated local port and library explicitly:

```bash
MOSA_LIBRARY_DIR=/absolute/path/to/library \
MOSA_PORT=PORT \
MOSA_PROJECT_DIR=/absolute/path/to/mosa \
MOSA_WEB_CAPTURE_TOKEN='replace-with-a-random-secret' \
MOSA_WEB_CAPTURE_ORIGINS='chrome-extension://replace-with-extension-id' \
npm start
```

Choose a port that is not already used by another MOSA or legacy service. Bind only to `127.0.0.1`; MOSA is not designed for public exposure.

For a standalone runtime started with `npm start`, `MOSA_WEB_CAPTURE_TOKEN` and `MOSA_WEB_CAPTURE_ORIGINS` remain required when the web-capture extension is used. The origins value is a comma-separated list of exact `chrome-extension://<id>` or `moz-extension://<id>` origins. When the Token is unset, web capture must remain disabled; when the origin is absent, extension requests must be rejected. Never put the Token in a tracked file, command transcript, issue, or log.

The packaged/Desktop runtime supplies these values automatically: it persists one random Web Capture Token inside Electron `userData`, authorizes only MOSA's two exact Chrome extension origins (the unpacked development ID and the Chrome Web Store ID), prefers port `43517`, and falls back through the reserved local discovery ports when another listener owns the preferred port. The extension verifies `/api/health`, pairs only from one of those approved `chrome-extension://` origins, and caches the resolved local address and Token in `chrome.storage.local`.

### Desktop shell

Run the desktop shell from a checkout or build one of the currently approved desktop targets:

```bash
npm run desktop:start

# macOS arm64
npm run desktop:make

# Windows 10/11 x64
npm run desktop:package:windows
npm run desktop:make:windows
```

The desktop packaging commands for both macOS and Windows require Node.js 22.x. The repository pins `22.23.1` in `.nvmrc` and `.node-version`; use the version-manager file supported by your environment before packaging. The pre-scripts deliberately fail before Forge runs when another Node major is active, avoiding incomplete packages that can occur with the current Forge/Packager chain on Node.js 24. On Windows, use the same pinned Node 22.x for the initial `npm ci` as well: the clean `windows-2022` CI lane installs successfully with that runtime, while Node 24 can resolve npm's implicit native rebuild through Electron's node-gyp toolchain and require an otherwise-unnecessary ClangCL setup. General non-desktop runtime development can still use the broader root `engines.node` range.

For reproducible native packaging, build macOS on macOS and Windows on Windows (the Windows CI job is the canonical clean builder). Sharp installs its native runtime through OS-specific optional packages, so a clean macOS `npm ci` does not install `@img/sharp-win32-x64`. macOS-to-Windows cross-packaging is therefore a developer-only path unless that target package is provisioned explicitly; the Forge prune hook fails closed with an actionable error instead of producing a package with a missing native runtime.

The desktop shell defaults to `~/MOSA Library` on `127.0.0.1:43517`, the same local service used by browser capture. A user can move an owned desktop library from **Settings → Storage & data → Change location**; the selected empty directory is persisted in the desktop user-data area and becomes the library root after MOSA copies the existing library and restarts. Override the port with `MOSA_DESKTOP_PORT` only when a separate runtime is intentional, and the library with `MOSA_LIBRARY_DIR`. An explicit `MOSA_LIBRARY_DIR` always takes precedence over the saved desktop location and disables in-app relocation.

At startup, the desktop shell verifies the service identity and library path. If they match, it attaches without taking ownership; quitting the app leaves that external service running. If no service is listening, the app starts an owned runtime. On macOS, closing the last window keeps the runtime available so the app can be reopened from the Dock; an explicit application quit stops an owned runtime and releases its library lock. On Windows, closing the last window quits the app because MOSA does not expose a tray re-entry point; an owned runtime is stopped through the same graceful shutdown path. A foreign listener or a MOSA service using another library is reported as a conflict and is never terminated.

Forge writes the macOS application under `out/MOSA-darwin-arm64/` and the Windows package directory under `out/MOSA-win32-x64/` with `MOSA.exe` at its root. `desktop:make` / `desktop:make:windows` produce ZIP development artifacts through the configured maker.

Windows 10/11 x64 is currently a **Preview / testing** target. A real Windows-machine smoke cycle has verified application startup, SQLite, Sharp, the shared library/Inspector UI, and automatic Codex collection. The Windows shell keeps the native title bar but hides Electron's visible application menu row; the underlying menu remains installed so keyboard accelerators continue to work. Grok and Cowart Windows source discovery remain unverified until their real local source layouts are confirmed.

Development builds are unsigned. Windows SmartScreen may warn about an unknown publisher, and macOS local builds are not release-notarized. A Windows installer, Windows code signing, macOS release signing/notarization, automatic updates, and background login launch are separate release work.

## Library Migration

Before a first migration, leave the source JSON directory untouched and use a dry run:

```bash
npm exec mosa -- migrate --dry-run --library /absolute/path/to/library
```

Only run the real migration after the dry run reports no issues:

```bash
npm exec mosa -- migrate --library /absolute/path/to/library
npm exec mosa -- verify --library /absolute/path/to/library
```

Migration checks JSON records, original files, hashes, and empty groups before marking the SQLite library completed. The migration creates a `legacy-json-backup` directory. Do not delete the original JSON source, the backup, or `mosa.db` during migration or recovery.

## Codex Hard-Link Reclaim

Migration re-imports each record from the legacy library file rather than from the Codex path, so a library that was hard-linked before migrating holds a second copy of every Codex asset. Reclaim that space once the migration has been verified:

```bash
MOSA_LIBRARY_DIR=/absolute/path/to/library node scripts/migrate-codex-hardlinks.mjs
```

Set `MOSA_PROJECT_ID` to select a project other than `default`; the pass covers archived assets too. It only swaps a library file for a hard link when the Codex original still exists, sits on the same filesystem, and hashes identically, so it never rewrites image bytes. Every other asset is reported under `skipped` with its reason. New imports are already hard-linked on ingest and need no maintenance.

## Derivative Repair

Previews and thumbnails are persistent SQLite jobs. Rebuild only when repair or backfill is needed:

```bash
npm exec mosa -- thumbnails rebuild --library /absolute/path/to/library
```

The command is resumable. It does not modify original image bytes.

## Health Checks

After starting a service, check the active storage and every bridge in one place:

```bash
curl -sS http://127.0.0.1:PORT/api/library-path
curl -sS http://127.0.0.1:PORT/api/bridges
curl -sS http://127.0.0.1:PORT/api/cowart-canvases
curl -sS http://127.0.0.1:PORT/api/web-capture
```

Expected conditions:

- `storage` is `sqlite` only after a completed migration.
- Codex, Grok, and Cowart report `enabled: true`; watcher/polling availability depends on the local source directories.
- `grok.sessionsDir` points at the configured Grok sessions root (default `~/.grok/sessions`).
- `lastError` is empty or `null`.
- `cowartDiscovery` is enabled when the service can read local Codex session records.
- `webCapture.enabled` is true only when `MOSA_WEB_CAPTURE_TOKEN` and at least one approved extension origin are explicitly configured; its providers list should contain `chatgpt`, `gemini`, `flow`, and `google-ai-studio`.

Run an integrity check whenever a migration, repair, or service incident is resolved:

```bash
npm exec mosa -- verify --library /absolute/path/to/library
```

Treat `ok: true` and an empty `failures` list as the integrity result. The asset count is a snapshot and can increase while bridges archive new images.

## Safe Recovery Boundaries

- Do not manually edit SQLite migration state, version relationships, or derivative job rows.
- Do not delete `mosa.db`, `legacy-json-backup`, or the legacy JSON source to force a retry.
- Preserve the command output and the reported path when migration or verification fails.
- Do not terminate another service only to free a port; choose another port or confirm the service owner first.
- Do not widen Codex source roots, Grok sessions roots, or Cowart discovery roots to solve an import failure.
- Do not bypass Web Capture Token, extension-origin, image-byte, MIME, size, or pixel-count validation to make an ingest request pass.
- Do not pass video assets through sharp or introduce ffmpeg/transcoding to “fix” missing video previews; original media playback is the supported path.

## Before a Code or Deployment Change

Run the repository verification suite:

```bash
npm test
npm run test:performance
npm run lint
npm run check
npm run audit
git diff --check
```

For a change that affects a real library or managed service, also run `mosa verify` against the intended library and record the bridge health output. Keep the deployment process separate from the default development service so a test server does not replace an active local service.
