# Privacy

MOSA is a local-first creative asset library. It does not operate a MOSA cloud service, telemetry service, advertising system, or remote user account.

## Data MOSA Reads

Depending on the features you enable, MOSA may read:

- generated media under the configured Codex generated-image root;
- matching local Codex session records used to recover Prompt and provenance;
- media and matching `chat_history.jsonl` records under the configured Grok sessions root;
- the dedicated MOSA Cowart canvas and explicitly approved project canvases;
- ChatGPT web images and message-scoped context sent by the optional Chrome extension;
- user-visible generated images from Gemini, Flow, and Google AI Studio sent by the same extension; Gemini may additionally send the nearest preceding visible `user-query` within the generated image's local message structure, Flow may send one uniquely anchored visible Prompt card, and AI Studio may send the nearest preceding visible user Prompt turn in the same chat session. Each is marked as unverified.

MOSA does not intentionally scan Downloads, Desktop, unrelated project folders, arbitrary browser pages, or source roots outside the documented allowlists.

## Data MOSA Stores

The selected local MOSA library can contain:

- original image or video bytes;
- WebP previews and thumbnails;
- Prompt and user-message text;
- hashes, dimensions, timestamps, source paths, source type, model/tool information, and provenance;
- version relationships, tags, archive state, and collection metadata;
- for web capture, provider/page URL, capture time, capture mode, extension version, and bounded source-occurrence history; ChatGPT additionally records conversation/message identifiers when available.

Reference images identified by Web Capture are stored as private generation-record attachments under the selected MOSA library. They are content-hash deduplicated and may be linked into the subsequent generated asset's recipe snapshot, but they are not ordinary assets and therefore do not appear in the gallery, search, recent items, or asset totals. MOSA does not infer the purpose or rights of a reference from its pixels.

A recipe may also record rights declarations for the reference images it used: copyright state, portrait-consent state, redistribution state, an attribution string, and the purposes the reference may or may not serve. These are entered by the user, not detected. They can concern identifiable third parties, so an attribution name is personal data and the library should be treated accordingly. MOSA never infers consent: every field starts at `unknown`, and silence is never recorded as permission.

The library is stored on the user's machine. MOSA does not upload it to a MOSA-operated service.

## Web Capture Chrome Extension

The optional extension:

- runs only on the ChatGPT, Gemini, Flow, and Google AI Studio domains declared in its manifest;
- observes ChatGPT page and generation-response data to associate an image with the correct message-scoped Prompt and, when an image-generation result follows a user turn containing uploaded images, may archive those uploads as private reference attachments before the generated asset;
- may fetch generated image bytes from the OpenAI- and Google-hosted asset domains declared in its manifest;
- sends captured data only to the configured loopback MOSA address;
- stores the MOSA address, Web Capture Token, and auto-capture preference in `chrome.storage.local`, not synchronized storage.

When updating from an earlier prerelease extension, existing settings may be read once from Chrome synchronized storage, copied to local storage, and removed from synchronized storage. The known prerelease development Token is discarded rather than migrated.

The extension does not request or store an OpenAI API Key or ChatGPT password. It operates inside the user's existing browser session, so each provider and its asset hosts remain governed by their own privacy terms.

On Gemini (`gemini.google.com`), it may additionally capture only the nearest preceding rendered `user-query` associated with a visible image inside a `model-response`. It skips inputs, editors, hidden content, unrelated page regions, credentials, cookies, and API keys. This text is marked `provider-visible-prompt` and is not verified as the prompt actually executed for generation.

On Google AI Studio (`aistudio.google.com`), it may additionally capture only the nearest preceding rendered user Prompt turn within the same `ms-chat-session` as a visible generated image. It skips controls, inputs, editors, hidden content, model thoughts, other sessions, cookies, credentials, and API keys. This text is marked `provider-visible-prompt` and is not verified as the prompt actually executed for generation.

On Flow (`labs.google`), it also may capture the one visible Prompt card structurally associated with a visible generated-image group, but only when the card has a unique nearby `Reuse Prompt` control. This text is marked `provider-visible-prompt`, is not verified as the prompt actually used for generation, and is never collected from an input, editor, hidden content, cookies, credentials, or the page as a whole.

## Network Boundary

The MOSA service binds to `127.0.0.1` and is not designed for public exposure. MOSA does not add a remote synchronization or analytics connection.

Codex, ChatGPT, Grok, Cowart, Chrome, and any AI or image-generation provider used before an asset reaches MOSA are separate products. Their own network behavior and privacy policies still apply.

## User Control

- Choose the library location with `MOSA_LIBRARY_DIR`.
- Disable web capture by leaving `MOSA_WEB_CAPTURE_TOKEN` unset and disabling or removing the extension.
- Disable a source bridge by not configuring or running the corresponding source tool.
- Back up the library before migration, repair, or manual removal.
- Do not commit the library, Tokens, Prompts, session records, or generated media to the source repository.

MOSA archive actions are organizational and do not promise secure erasure. Filesystem backups, browser data, source-tool histories, and copied media must be managed separately.

## Security and Questions

Report vulnerabilities through [SECURITY.md](SECURITY.md). For privacy questions that are not security reports, use the contact routes in [SUPPORT.md](SUPPORT.md) without including private user data.
