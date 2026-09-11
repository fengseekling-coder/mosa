# Third-party notices

This file records upstream projects that materially informed MOSA's design or implementation. It is separate from MOSA's own license terms.

## APSAL Open

MOSA's recipe snapshot model was informed by the immutable, reproducible creative-record concepts in **APSAL Open**.

- Project: `henyjone/apsal-open`
- Reference release: `v0.14.0`
- Reference commit: `823f1cbc5557310fa092620391181c1d13485b15`
- Upstream code license: Apache License 2.0
- Upstream author: HenyJone / APSAL Open
- Source: <https://github.com/henyjone/apsal-open/tree/v0.14.0>

The influence is at the design level. In MOSA, the resulting recipe snapshot system records a frozen generation recipe with content-derived identity, Prompt and recipe digests, normalized reference declarations, provenance, and change lineage. The current MOSA implementation lives in `lib/recipe-snapshot.ts` and the corresponding storage/API layers.

MOSA does not vendor, bundle, execute, or depend on APSAL Open source code. No APSAL source files are distributed as part of MOSA. MOSA's own source remains licensed under the repository's [PolyForm Noncommercial License 1.0.0](LICENSE); this notice does not relicense MOSA under Apache-2.0.

APSAL contains substantially broader authoring, protocol, registry, packaging, and Studio functionality. This notice should not be read as claiming those systems are part of MOSA.

The upstream Apache License 2.0 text is available in APSAL Open's tagged source at <https://github.com/henyjone/apsal-open/blob/v0.14.0/LICENSE>.
