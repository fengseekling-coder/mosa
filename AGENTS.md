# MOSA Contributor Instructions

## Repository Boundary

- Keep source code, tests, public documentation, and reproducible configuration in this repository.
- Do not commit user libraries, generated media, prompts, metadata exports, session logs, canvas data, deployment snapshots, screenshots, or local paths.
- Keep third-party plugin code outside this repository. Integrations must use configured paths rather than hard-coded machine-specific locations.

## Local Development

- Use `npm ci`, `npm test`, `npm run lint`, and `npm run check` before proposing a change.
- Start the local service with `npm start`. Configure non-default locations through the documented environment variables.
- The Cowart integration is optional. When it is unavailable, preserve normal library behavior rather than creating plugin-specific files in the checkout.

## Safety

- Keep all public documentation portable: use relative paths, `$HOME`, or explicit placeholders instead of personal absolute paths.
- Treat imported assets and their Prompt/provenance records as private user data by default.
- Do not widen filesystem allowlists, session roots, or canvas targets merely to make an import succeed.
