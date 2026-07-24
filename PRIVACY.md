# Privacy

MOSA is a local-first creative asset library. It does not operate a MOSA cloud service, telemetry service, advertising system, or remote user account.

## Data MOSA Reads

Depending on the features you enable, MOSA may read:

- generated media under the configured Codex generated-image root;
- matching local Codex session records used to recover Prompt and provenance;
- media and matching `chat_history.jsonl` records under the configured Grok sessions root;
- the dedicated MOSA Cowart canvas and explicitly approved project canvases;
- ChatGPT web images and message-scoped context sent by the optional Chrome extension.

MOSA does not intentionally scan Downloads, Desktop, unrelated project folders, arbitrary browser pages, or source roots outside the documented allowlists.

## Data MOSA Stores

The selected local MOSA library can contain:

- original image or video bytes;
- WebP previews and thumbnails;
- Prompt and user-message text;
- hashes, dimensions, timestamps, source paths, source type, model/tool information, and provenance;
- version relationships, tags, archive state, and collection metadata;
- for ChatGPT capture, page URL, conversation/message identifiers, capture time, and extension version when available.

The library is stored on the user's machine. MOSA does not upload it to a MOSA-operated service.

## ChatGPT Chrome Extension

The optional extension:

- runs only on the ChatGPT domains declared in its manifest;
- observes page and generation-response data to associate an image with the correct message-scoped Prompt;
- may fetch generated image bytes from the OpenAI-hosted asset domains declared in its manifest;
- sends captured data only to the configured loopback MOSA address;
- stores the MOSA address, Web Capture Token, and auto-capture preference in `chrome.storage.local`, not synchronized storage.

When updating from an earlier prerelease extension, existing settings may be read once from Chrome synchronized storage, copied to local storage, and removed from synchronized storage. The known prerelease development Token is discarded rather than migrated.

The extension does not request or store an OpenAI API Key or ChatGPT password. It operates inside the user's existing browser session, so ChatGPT and its asset hosts remain governed by their own privacy terms.

## Network Boundary

The MOSA service binds to `127.0.0.1` and is not designed for public exposure. MOSA does not add a remote synchronization or analytics connection.

Codex, ChatGPT, Grok, Cowart, Chrome, and any AI or image-generation provider used before an asset reaches MOSA are separate products. Their own network behavior and privacy policies still apply.

## User Control

- Choose the library location with `MOSA_LIBRARY_DIR`.
- Disable ChatGPT web capture by leaving `MOSA_WEB_CAPTURE_TOKEN` unset and disabling or removing the extension.
- Disable a source bridge by not configuring or running the corresponding source tool.
- Back up the library before migration, repair, or manual removal.
- Do not commit the library, Tokens, Prompts, session records, or generated media to the source repository.

MOSA archive actions are organizational and do not promise secure erasure. Filesystem backups, browser data, source-tool histories, and copied media must be managed separately.

## Security and Questions

Report vulnerabilities through [SECURITY.md](SECURITY.md). For privacy questions that are not security reports, use the contact routes in [SUPPORT.md](SUPPORT.md) without including private user data.
