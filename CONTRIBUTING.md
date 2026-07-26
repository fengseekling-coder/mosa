# Contributing to MOSA

MOSA welcomes focused bug fixes, tests, documentation improvements, and narrowly scoped feature proposals.

MOSA is source-available under the [PolyForm Noncommercial License 1.0.0](LICENSE), not an OSI-approved open-source project. By submitting a contribution, you confirm that you have the right to provide it and agree that it may be distributed under the repository license. A contribution does not grant commercial-use rights.

## Before You Start

- Read [README.md](README.md), [PRIVACY.md](PRIVACY.md), [SECURITY.md](SECURITY.md), and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
- Use a GitHub Discussion for an early design question or feature proposal.
- Use an Issue for a reproducible bug.
- Report vulnerabilities privately according to `SECURITY.md`.

Do not post real Prompts, user assets, Tokens, cookies, credentials, local absolute paths, session records, or private screenshots.

## Local Setup

Requirements are macOS, Node.js 22 or newer, and npm.

```bash
npm ci
npm test
npm start
```

The default service is local-only at `http://127.0.0.1:43517`. Use sample data or a separate test library. Never point development tests at another user's library or a production library.

## Change Guidelines

- Keep changes focused and preserve existing public APIs unless the change explicitly documents a migration.
- Add regression tests for behavior changes and bug fixes.
- Preserve filesystem, source-root, canvas-target, Token, origin, MIME, and request-size boundaries.
- Keep public documentation portable and free of maintainer-specific paths or operational secrets.
- Update README, the Chinese guide, operations guide, privacy/security policies, and changelog when their contracts change.
- Keep dependency licenses unchanged. Project license metadata belongs only to the root package entry and project files.

## Verification

Run the checks relevant to the change:

```bash
npm test
npm run test:performance
npm run lint
npm run check
npm run audit
git diff --check
```

The performance test is opt-in and may take longer than the regular suite.

Continuous integration runs `npm run lint`, `npm run check`, `npm test`, and `npm run audit` on Linux. macOS remains the supported runtime, so verify macOS-specific behavior locally before proposing a change.

## Pull Requests

- Create a topic branch from the current `main`.
- Keep commits and the PR description specific to one coherent change.
- Explain the user impact, root cause for fixes, privacy/security implications, and verification performed.
- Link related Issues or Discussions.
- Do not include generated media, private test fixtures, user libraries, session logs, deployment snapshots, or local handoff files.

Pull requests are reviewed against product scope, regression risk, privacy boundaries, test coverage, and license compatibility.
