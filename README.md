# MOSA

> **Local visual memory for AI creation.**
> 把 AI 生成的每一张图，连同 Prompt、来源和版本，留在自己的电脑上。

MOSA is a local-first library for AI-generated images, videos, Prompts, provenance, and version history. It keeps creative output from Codex, Grok Build CLI, Cowart, and an optional Web Capture extension for ChatGPT, Gemini, Flow, and Google AI Studio in one library on your own computer.

**Local-first · Prompt & provenance · Version history · No MOSA cloud account**

[Quick start](#quick-start) · [Downloads](#downloads) · [中文使用指南](docs/guide.zh-CN.md) · [Privacy](PRIVACY.md) · [Documentation](#documentation)

## Downloads

Download the current MOSA packages from the [official download page](https://mosa.azhuilab.com/#download). The page and its [release manifest](https://mosa.azhuilab.com/releases/latest.json) are the source of truth for newer versions, package sizes, and SHA-256 values. These links intentionally stay version-neutral so publishing a new package does not require another README edit.

| Package | Platform | Download | Update source |
| --- | --- | --- | --- |
| MOSA Desktop | macOS arm64 | [Download latest package](https://mosa.azhuilab.com/#download) | Official page resolves the current package from the release manifest |
| MOSA Desktop | Windows x64 | [Download latest package](https://mosa.azhuilab.com/#download) | Official page resolves the current package from the release manifest |
| MOSA Web Capture | Chrome / Chromium | [Download latest package](https://mosa.azhuilab.com/#download) · [Install guide](https://mosa.azhuilab.com/guide/) | Official page maintains the current developer-mode ZIP; not a signed CRX |

Desktop ZIPs are hosted outside Git history because of their size. The official page is the canonical download entry for all packages; versioned filenames and package metadata may change there without requiring a source repository commit.

## Why MOSA

An image alone rarely tells you how to use it again. The Prompt may be in another conversation, the source tool may be forgotten, and the version you actually want may be buried among near-duplicates.

MOSA reconnects each asset with the context that makes it reusable: its available Prompt, generation source, provenance, and version history. The library remains under your control on your machine.

## What you can do

### Keep the context with the asset

Archive generated images and videos together with their available Prompt, source, model or tool context, timestamps, and provenance. MOSA records when a Prompt is unavailable instead of inventing one.

### Find the work you want

Search and browse one local library with thumbnails, previews, tags, favorites, and provenance. Originals stay intact; previews and thumbnails are generated for the library experience.

### Continue without starting over

Save a recipe, create a new version, inspect the version tree. Your next iteration starts from context, not from a mystery image.

## Fits into your workflow

| You create in | MOSA keeps |
| --- | --- |
| **Codex Desktop** | Generated images and the matching local generation context when available |
| **ChatGPT, Gemini, Flow, or Google AI Studio in Chrome** | Optional visible web-generated images and conservative page-scoped context through the local extension |
| **Grok Build CLI** | Images and videos from local sessions, with matched tool context when available |
| **Cowart** | Approved canvas snapshots archived from Cowart into the library |

MOSA does not generate media or replace any of these tools. It is the place where their visual output becomes a reusable body of work.

## Quick start

MOSA currently starts from source as a local service on `127.0.0.1:43517`.

```bash
git clone https://github.com/fengseekling-coder/mosa.git
cd mosa
npm ci
npm test
npm start
```

Open <http://127.0.0.1:43517>.

Requirements for source use: Node.js 22 or newer and npm. Desktop development is currently exercised on macOS arm64 and Windows 10/11 x64. Codex Desktop and the Cowart plugin are optional integrations; use the [Chinese guide](docs/guide.zh-CN.md) for their setup and the complete source-by-source behavior.

## Desktop app

The Electron desktop shell uses the same MOSA Web UI and local runtime on both supported desktop targets:

```bash
npm ci
npm run desktop:start

# macOS arm64
npm run desktop:make

# Windows 10/11 x64 package directory
npm run desktop:package:windows
```

Desktop packaging is pinned to Node.js 22.x because the current Electron Forge/Packager toolchain is not reliable under Node.js 24. The repository includes `.nvmrc` and `.node-version` for Node `22.23.1`; packaging commands fail fast with a clear message on any other Node major. Local development and the MOSA runtime still support Node.js 22 or newer.

Current desktop status:

| Target | Status | Verified in the current development cycle |
| --- | --- | --- |
| macOS arm64 | Development target | Electron shell, local runtime, packaged smoke path, native dependencies |
| Windows 10/11 x64 | **Preview / testing** | `MOSA.exe` startup, SQLite, Sharp, library UI, Inspector, and automatic Codex collection on a real Windows machine |

The Windows target keeps the shared renderer and runtime code, uses Windows-native `better-sqlite3` and Sharp binaries, and hides Electron's native application menu bar while retaining menu accelerators. Grok and Cowart source discovery on Windows, a signed installer, code signing, and automatic updates are still release work.

When the configured port already serves the same MOSA library, the desktop app attaches to it and leaves it running on Quit. Otherwise, it starts and owns a local runtime, which stops cleanly when the app quits. MOSA never terminates an unverified listener or a service for a different library.

> **Project status:** this repository does not yet publish a signed desktop installer. Windows testing currently uses an unsigned preview/portable build, and macOS release signing/notarization is separate release work. Do not treat a development checkout or a locally built app as a released app.

## Local by design

- MOSA is a local Web UI bound to loopback; it is not a cloud service and must not be exposed through a public port or reverse proxy.
- It reads only its configured Codex, Grok, and approved Cowart locations. It does not scan Downloads, Desktop, or arbitrary image folders.
- Web Capture is optional and remains disabled until you configure both a local ingest Token and an approved extension origin. It sends captured image bytes and page provenance only to the configured local MOSA address. ChatGPT retains message-scoped context when available; Gemini, Flow, and Google AI Studio retain only narrowly associated visible user Prompt text when it can be safely matched and mark it unverified.
- Eligible reference images are stored as private, content-hash-deduplicated generation-record attachments, not ordinary gallery assets.
- MOSA adds no AI model, remote sync, embedding search, or automatic upload of your library.
- Desktop builds send minimal anonymous install/activity metadata with the existing daily update check. This contains only a random installation ID, version, platform, architecture, and first-launch/daily-active event. It is not exposed as an in-app preference and never includes assets, Prompts, or local paths. See [PRIVACY.md](PRIVACY.md).

See [PRIVACY.md](PRIVACY.md) for the full data boundary and [SECURITY.md](SECURITY.md) for private vulnerability reporting.

## Documentation

- [中文使用指南](docs/guide.zh-CN.md): setup, sources, local library, search, versions, MCP, and maintenance.
- [Operations guide](docs/operations.md): migration, verification, bridge health, recovery, and managed local service boundaries.
- [Architecture](ARCHITECTURE.md): current runtime, storage, and integration layout.
- [Context menu](docs/context-menu.md): sidebar, card, and empty-grid actions.
- [Web Capture extension guide](extensions/chatgpt-web-capture/README.md): local setup, permissions, capture behavior, and limitations.
- [Privacy policy](PRIVACY.md): data sources, local storage, extension permissions, and network boundaries.
- [Security policy](SECURITY.md): supported versions and private vulnerability reporting.
- [Contributing guide](CONTRIBUTING.md): development workflow, checks, and privacy requirements.
- [Support guide](SUPPORT.md): questions, bug reports, and feature requests.
- [Changelog](CHANGELOG.md): user-visible changes and release status.

## License

MOSA is source-available under the [PolyForm Noncommercial License 1.0.0](LICENSE).

- Noncommercial personal, educational, research, hobby, modification, and distribution uses are permitted under the license terms.
- Commercial use, paid services, client delivery, commercial platform integration, or other anticipated commercial applications require a separate written license from the copyright holder. See [COMMERCIAL-LICENSE.md](COMMERCIAL-LICENSE.md).
- Redistributions must preserve the license terms and required copyright notice.

MOSA is source-available software, not OSI-approved open-source software.
