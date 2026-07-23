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
npm start
```

Choose a port that is not already used by another MOSA or legacy service. Bind only to `127.0.0.1`; MOSA is not designed for public exposure.

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
```

Expected conditions:

- `storage` is `sqlite` only after a completed migration.
- Codex, Grok, and Cowart report `enabled: true`; watcher/polling availability depends on the local source directories.
- `grok.sessionsDir` points at the configured Grok sessions root (default `~/.grok/sessions`).
- `lastError` is empty or `null`.
- `cowartDiscovery` is enabled when the service can read local Codex session records.
- `cowartInsert.available` is true only when the Cowart plugin endpoint is available.

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
- Do not widen Codex source roots, Grok sessions roots, Cowart discovery roots, or Cowart insertion targets to solve an import failure.
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
