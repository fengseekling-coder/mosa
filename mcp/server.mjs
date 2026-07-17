import readline from "node:readline";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createAssetStore } from "../lib/asset-store.mjs";

const managerDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const projectRoot = resolve(process.env.ASSET_MANAGER_PROJECT_DIR || process.cwd());
const store = createAssetStore({ projectRoot, managerDir });

const TOOL_ASSET_CREATE = "asset_create";
const TOOL_ASSET_LIST = "asset_list";
const TOOL_ASSET_GET = "asset_get";
const TOOL_ASSET_UPDATE_METADATA = "asset_update_metadata";
const TOOL_ASSET_ATTACH_PROMPT = "asset_attach_prompt";

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
      description: "Copy a generated image into the GPT Asset Manager library and save prompt recipe metadata. Codex's default ~/.codex/generated_images task folders are supported and recorded as the source.",
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
      description: "List saved GPT Asset Manager assets for a project, optionally filtered by search text.",
      inputSchema: {
        type: "object",
        properties: { projectId: { type: "string" }, query: { type: "string" } },
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
    const assets = await store.listAssets({ projectId: args.projectId || "default", query: args.query || "" });
    sendResult(id, { content: [{ type: "text", text: `${assets.length} assets` }], structuredContent: { assets } });
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
  sendError(id, -32602, `Unknown tool: ${params?.name || ""}`);
}

async function handleRequest(message) {
  const { id, method, params } = message;
  if (method === "initialize") {
    sendResult(id, {
      protocolVersion: params?.protocolVersion || "2025-11-25",
      capabilities: { tools: {} },
      serverInfo: { name: "GPT Asset Manager MCP", version: "0.1.0" },
      instructions: "Save generated images with full prompts and recipe metadata. Images from Codex's default ~/.codex/generated_images task folders are accepted and their source path is recorded. List and retrieve saved assets for reuse."
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
      sendError(id, -32603, error.message);
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
