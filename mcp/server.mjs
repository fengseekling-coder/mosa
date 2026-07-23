import readline from "node:readline";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createAssetStore } from "../lib/asset-store.mjs";

const managerDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const projectRoot = resolve(process.env.MOSA_PROJECT_DIR || process.cwd());
const libraryDir = resolve(process.env.MOSA_LIBRARY_DIR || join(homedir(), "MOSA Library"));
const store = createAssetStore({ projectRoot, managerDir, libraryDir });

const TOOL_ASSET_CREATE = "asset_create";
const TOOL_ASSET_LIST = "asset_list";
const TOOL_ASSET_GET = "asset_get";
const TOOL_ASSET_UPDATE_METADATA = "asset_update_metadata";
const TOOL_ASSET_ATTACH_PROMPT = "asset_attach_prompt";
const TOOL_ASSET_ARCHIVE = "asset_archive";
const TOOL_ASSET_DUPLICATE = "asset_duplicate";
const TOOL_ASSET_VERSION_CREATE = "asset_version_create";
const TOOL_ASSET_VERSION_HISTORY = "asset_version_history";

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function sendResult(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function sendError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function toolDefinitions() {
  return [
    {
      name: TOOL_ASSET_CREATE,
      description: "Copy a generated image into the MOSA library and save prompt recipe metadata. Codex's default ~/.codex/generated_images task folders are supported and recorded as the source.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          imagePath: { type: "string" },
          prompt: { type: "string" },
          skill: { type: "string" },
          style: { type: "string" },
          ratio: { type: "string" },
          theme: { type: "string" },
          business_fields: { type: "object" },
          parent_asset_id: { type: "string" },
          version_change: { type: "string" },
          sourceType: { type: "string", description: "Optional source type. Defaults to codex-generated for images under ~/.codex/generated_images." },
          source: {
            type: "object",
            description: "Optional generation provenance, such as generation_tool, model, codex_session_id, or codex_thread_id. The original image path and Codex task ID are detected automatically.",
            additionalProperties: true
          }
        },
        required: ["imagePath"],
        additionalProperties: true
      }
    },
    {
      name: TOOL_ASSET_LIST,
      description: "List saved MOSA assets for a project, optionally filtered by search text.",
      inputSchema: {
        type: "object",
        properties: { projectId: { type: "string" }, query: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 250 }, cursor: { type: "string" } },
        additionalProperties: false
      }
    },
    {
      name: TOOL_ASSET_GET,
      description: "Get one saved asset and its full prompt recipe.",
      inputSchema: {
        type: "object",
        properties: { projectId: { type: "string" }, assetId: { type: "string" } },
        required: ["assetId"],
        additionalProperties: false
      }
    },
    {
      name: TOOL_ASSET_ARCHIVE,
      description: "Soft-delete an asset from active MOSA results while preserving its provenance and original file.",
      inputSchema: {
        type: "object",
        properties: { projectId: { type: "string" }, assetId: { type: "string" } },
        required: ["assetId"],
        additionalProperties: false
      }
    },
    {
      name: TOOL_ASSET_DUPLICATE,
      description: "Create an independent editable copy that starts a new version root while retaining duplicate provenance.",
      inputSchema: {
        type: "object",
        properties: { projectId: { type: "string" }, assetId: { type: "string" }, assetIdNew: { type: "string" } },
        required: ["assetId"],
        additionalProperties: false
      }
    },
    {
      name: TOOL_ASSET_VERSION_CREATE,
      description: "Save a new recipe version as a child of an existing asset without overwriting the parent.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          assetId: { type: "string", description: "Existing parent asset ID." },
          assetIdNew: { type: "string", description: "Optional ID for the new version." },
          imagePath: { type: "string", description: "Optional new image path. When omitted, the parent image is copied for a recipe-only version." },
          version_change: { type: "string", minLength: 1, description: "Required summary of what changed from the parent." },
          prompt: { type: "string" },
          skill: { type: "string" },
          style: { type: "string" },
          ratio: { type: "string" },
          theme: { type: "string" },
          business_fields: { type: "object" },
          tags: { type: "array", items: { type: "string" } },
          favorite: { type: "boolean" },
          group: { type: "string" },
          category: { type: "string" },
          rating: { type: "integer", minimum: 0, maximum: 5 },
          sourceType: { type: "string" },
          source: {
            type: "object",
            description: "Optional provenance for a replacement image, such as generation_tool, model, or codex_session_id.",
            additionalProperties: true
          }
        },
        required: ["assetId", "version_change"],
        additionalProperties: false
      }
    },
    {
      name: TOOL_ASSET_VERSION_HISTORY,
      description: "Read the complete root-to-descendant recipe version tree for an asset, including archived versions.",
      inputSchema: {
        type: "object",
        properties: { projectId: { type: "string" }, assetId: { type: "string" } },
        required: ["assetId"],
        additionalProperties: false
      }
    },
    {
      name: TOOL_ASSET_UPDATE_METADATA,
      description: "Update metadata fields for a saved asset.",
      inputSchema: {
        type: "object",
        properties: { projectId: { type: "string" }, assetId: { type: "string" } },
        required: ["assetId"],
        additionalProperties: true
      }
    },
    {
      name: TOOL_ASSET_ATTACH_PROMPT,
      description: "Attach or replace the full prompt recipe for a saved asset.",
      inputSchema: {
        type: "object",
        properties: { projectId: { type: "string" }, assetId: { type: "string" }, prompt: { type: "string" } },
        required: ["assetId", "prompt"],
        additionalProperties: false
      }
    },
  ];
}

async function handleToolCall(id, params) {
  const args = params?.arguments || {};
  if (params?.name === TOOL_ASSET_CREATE) {
    const asset = await store.createAsset(args);
    sendResult(id, { content: [{ type: "text", text: `Saved asset ${asset.id} at ${asset.image_path}` }], structuredContent: { asset } });
    return;
  }
  if (params?.name === TOOL_ASSET_LIST) {
    const result = typeof store.listAssetPage === "function"
      ? await store.listAssetPage({ projectId: args.projectId || "default", query: args.query || "", limit: args.limit, cursor: args.cursor })
      : { assets: await store.listAssets({ projectId: args.projectId || "default", query: args.query || "" }), page: { nextCursor: null } };
    sendResult(id, { content: [{ type: "text", text: `${result.assets.length} assets` }], structuredContent: result });
    return;
  }
  if (params?.name === TOOL_ASSET_GET) {
    const asset = await store.getAsset(args.projectId || "default", args.assetId);
    sendResult(id, { content: [{ type: "text", text: asset.prompt || `Asset ${asset.id}` }], structuredContent: { asset } });
    return;
  }
  if (params?.name === TOOL_ASSET_UPDATE_METADATA) {
    const { projectId = "default", assetId, ...patch } = args;
    const asset = await store.updateMetadata(projectId, assetId, patch);
    sendResult(id, { content: [{ type: "text", text: `Updated asset ${asset.id}` }], structuredContent: { asset } });
    return;
  }
  if (params?.name === TOOL_ASSET_ATTACH_PROMPT) {
    const asset = await store.updateMetadata(args.projectId || "default", args.assetId, { prompt: args.prompt });
    sendResult(id, { content: [{ type: "text", text: `Attached prompt to ${asset.id}` }], structuredContent: { asset } });
    return;
  }
  if (params?.name === TOOL_ASSET_ARCHIVE) {
    const asset = await store.archiveAsset(args.projectId || "default", args.assetId);
    sendResult(id, { content: [{ type: "text", text: `Archived asset ${asset.id}` }], structuredContent: { asset } });
    return;
  }
  if (params?.name === TOOL_ASSET_DUPLICATE) {
    const asset = await store.duplicateAsset(args.projectId || "default", args.assetId, { assetId: args.assetIdNew });
    sendResult(id, { content: [{ type: "text", text: `Duplicated asset ${asset.id}` }], structuredContent: { asset } });
    return;
  }
  if (params?.name === TOOL_ASSET_VERSION_CREATE) {
    const { projectId = "default", assetId, assetIdNew, ...input } = args;
    const asset = await store.createAssetVersion(projectId, assetId, { ...input, assetId: assetIdNew });
    sendResult(id, { content: [{ type: "text", text: `Created version ${asset.id} from ${assetId}` }], structuredContent: { asset } });
    return;
  }
  if (params?.name === TOOL_ASSET_VERSION_HISTORY) {
    const history = await store.getAssetVersionHistory(args.projectId || "default", args.assetId);
    sendResult(id, { content: [{ type: "text", text: `${history.versions.length} versions rooted at ${history.root_asset_id}` }], structuredContent: { history } });
    return;
  }
  sendError(id, -32602, `Unknown tool: ${params?.name || ""}`);
}

async function handleRequest(message) {
  const { id, method, params } = message;
  if (method === "initialize") {
    sendResult(id, {
      protocolVersion: params?.protocolVersion || "2025-11-25",
      capabilities: { tools: {} },
      serverInfo: { name: "MOSA MCP", version: "0.1.0" },
      instructions: "Save generated images with full prompts and recipe metadata. Use asset_version_create with the generated imagePath and a version_change summary when creating a child recipe version. Images from Codex's default ~/.codex/generated_images task folders are accepted and their source path is recorded."
    });
    return;
  }
  if (method === "ping") {
    sendResult(id, {});
    return;
  }
  if (method === "tools/list") {
    sendResult(id, { tools: toolDefinitions() });
    return;
  }
  if (method === "tools/call") {
    try {
      await handleToolCall(id, params);
    } catch (error) {
      if (error?.statusCode && error?.code) {
        sendResult(id, {
          content: [{ type: "text", text: error.message }],
          isError: true,
          structuredContent: { error: { code: error.code, message: error.message } },
        });
      } else sendError(id, -32603, error.message);
    }
    return;
  }
  sendError(id, -32601, `Method not found: ${method}`);
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", async (line) => {
  if (!line.trim()) return;
  try {
    await handleRequest(JSON.parse(line));
  } catch (error) {
    sendError(null, -32700, error.message);
  }
});
