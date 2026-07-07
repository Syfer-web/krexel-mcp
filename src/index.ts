#!/usr/bin/env node
/**
 * Krexel MCP server — stdio transport.
 *
 * Tools exposed:
 *   ship_site, list_deploys, get_logs, rollback, set_env, get_status
 *
 * State lives in $KREXEL_HOME (default ~/.krexel). See state.ts.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { ZodError } from "zod";

import {
  ShipSiteInputSchema,
  ListDeploysInputSchema,
  GetLogsInputSchema,
  RollbackInputSchema,
  SetEnvInputSchema,
  GetStatusInputSchema,
  ListFilesInputSchema,
  ReadFileInputSchema,
  EditFileInputSchema,
  type DeployRecord,
  type StatusReport,
} from "./schemas.js";
import {
  appendDeploy,
  decryptEnvFile,
  krexelHome,
  encryptEnvValue,
  findDeploy,
  listDeploys as listDeploysState,
  MissingMasterKeyError,
  readState,
  updateDeploy,
  uploadDirFor,
} from "./state.js";
import { shipSite, verifyFolder } from "./ship.js";
import {
  defaultKrexelApiClient,
  type KrexelApiClient,
  type PatchOpWire,
} from "./api-client.js";

const SERVER_NAME = "krexel-mcp";
const SERVER_VERSION = "0.1.0";

const server = new Server(
  { name: SERVER_NAME, version: SERVER_VERSION },
  { capabilities: { tools: {} } },
);

// -----------------------------------------------------------------------------
// Tool registry
// -----------------------------------------------------------------------------

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "ship_site",
      description:
        "Upload a built site folder to Krexel. Zips the folder, stages it locally, " +
        "and POSTs to the Krexel orchestrator API. Returns a deploy_id (always) and " +
        "preview_url. If the orchestrator is unreachable the response carries an " +
        "`api_ok: false` flag with the upstream error — never fakes success.",
      inputSchema: {
        type: "object",
        properties: {
          folder: {
            type: "string",
            description: "Absolute or ~-relative path to the built site directory.",
          },
          domain: {
            type: "string",
            description: "Custom domain to attach (e.g. shop.example.com).",
          },
          framework: {
            type: "string",
            enum: ["auto", "nextjs", "astro", "vite", "static"],
            description: "Build framework hint. Default 'auto' detects from package.json.",
          },
        },
        required: ["folder", "domain"],
      },
    },
    {
      name: "list_deploys",
      description:
        "List recent deploys from the local Krexel state file. Optionally filter by domain.",
      inputSchema: {
        type: "object",
        properties: {
          domain: { type: "string" },
          limit: { type: "number", minimum: 1, maximum: 100 },
        },
      },
    },
    {
      name: "get_logs",
      description:
        "Get build logs for a deploy. In Phase 1 these are mocked from the local " +
        "manifest; Phase 2 will stream from the orchestrator.",
      inputSchema: {
        type: "object",
        properties: {
          deploy_id: { type: "string", pattern: "^dep_" },
        },
        required: ["deploy_id"],
      },
    },
    {
      name: "rollback",
      description:
        "Mark a previous deploy as the current 'last_good' for a domain. Phase 2 will " +
        "actually push the rollback; Phase 1 just records intent.",
      inputSchema: {
        type: "object",
        properties: {
          domain: { type: "string" },
          to: { type: "string", description: "deploy_id to roll back to" },
        },
        required: ["domain", "to"],
      },
    },
    {
      name: "set_env",
      description:
        "Encrypt and persist an environment variable for a domain. Stored at " +
        "$KREXEL_HOME/env/<domain>.enc with AES-256-GCM using KREXEL_MASTER_KEY.",
      inputSchema: {
        type: "object",
        properties: {
          domain: { type: "string" },
          key: { type: "string" },
          value: { type: "string" },
        },
        required: ["domain", "key", "value"],
      },
    },
    {
      name: "get_status",
      description:
        "Return current account, deploy count, platform, and state directory.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "list_files",
      description:
        "List the files in a deployed site (paths, sizes, sha256). Returns metadata only — use read_file to fetch content.",
      inputSchema: {
        type: "object",
        properties: {
          deploy_id: {
            type: "string",
            pattern: "^dep_[a-z0-9_]+$",
            description:
              "The deploy_id returned from ship_site (or any patch deploy).",
          },
        },
        required: ["deploy_id"],
      },
    },
    {
      name: "read_file",
      description:
        "Read a single file's contents from a deployed site. Path is relative to the site root (e.g. 'index.html', 'assets/logo.svg').",
      inputSchema: {
        type: "object",
        properties: {
          deploy_id: {
            type: "string",
            pattern: "^dep_[a-z0-9_]+$",
            description: "The deploy_id that contains the file.",
          },
          path: {
            type: "string",
            pattern: "^[a-zA-Z0-9._/-]+$",
            description:
              "Path inside the deploy. No leading slash, no '..'. Examples: 'index.html', 'css/main.css'.",
          },
        },
        required: ["deploy_id", "path"],
      },
    },
    {
      name: "edit_file",
      description:
        "Patch a file on a live deployed site and ship a new patch deploy. The AI decides what to change; the MCP ships the patch. Returns the new deploy_id + preview_url.",
      inputSchema: {
        type: "object",
        properties: {
          deploy_id: {
            type: "string",
            pattern: "^dep_[a-z0-9_]+$",
            description:
              "The BASE deploy to patch on top of. The new patch deploy will have this as its parent_deploy_id.",
          },
          op: {
            type: "string",
            enum: ["create", "replace", "replace_all", "delete"],
            description:
              "create = new file (requires value/content); replace = first match (requires find + value); replace_all = every match (requires find + value); delete = remove file.",
          },
          file: {
            type: "string",
            pattern: "^[a-zA-Z0-9._/-]+$",
            description: "Path of the file to create/replace/delete.",
          },
          find: {
            type: "string",
            description:
              "For replace/replace_all: the exact substring to find inside the file's current content.",
          },
          value: {
            type: "string",
            description: "For create/replace/replace_all: the new text.",
          },
          content: {
            type: "string",
            description:
              "Alias for value (kept for ergonomics on create). If both given, value wins.",
          },
          message: {
            type: "string",
            maxLength: 500,
            description: "Optional human-readable note stored with the patch deploy.",
          },
        },
        required: ["deploy_id", "op", "file"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    switch (name) {
      case "ship_site": {
        const input = ShipSiteInputSchema.parse(args ?? {});
        const uploadDir = uploadDirFor(`${input.domain}-${Date.now()}`);
        // Note: shipSite internally generates the real deploy_id.
        const result = await shipSite({
          folder: input.folder,
          domain: input.domain,
          framework: input.framework,
          uploadDir,
        });
        const record: DeployRecord = {
          deploy_id: result.deploy_id,
          domain: input.domain,
          framework: result.framework,
          folder: verifyFolder(input.folder),
          status: result.api_ok ? "queued" : "error",
          preview_url: result.preview_url,
          created_at: new Date().toISOString(),
          ...(result.api_error ? { error: result.api_error } : {}),
        };
        await appendDeploy(record);
        return toolResult({
          ...result,
          record,
          note: result.api_ok
            ? "Deploy accepted by orchestrator."
            : "Local stage succeeded but orchestrator API was unreachable or returned an error. " +
              "The deploy is queued for retry; check `get_status` and `get_logs` for status.",
        });
      }

      case "list_deploys": {
        const input = ListDeploysInputSchema.parse(args ?? {});
        const rows = await listDeploysState(input.domain, input.limit);
        return toolResult({ deploys: rows, count: rows.length });
      }

      case "get_logs": {
        const input = GetLogsInputSchema.parse(args ?? {});
        const deploy = await findDeploy(input.deploy_id);
        if (!deploy) {
          throw new Error(`No deploy found with id ${input.deploy_id}`);
        }
        // Phase 1: mocked logs from local manifest. Real logs come from
        // the orchestrator in Phase 2.
        const lines: string[] = [
          `[mock] Phase 1 logs — orchestrator streaming not yet wired.`,
          `deploy_id: ${deploy.deploy_id}`,
          `domain: ${deploy.domain}`,
          `framework: ${deploy.framework}`,
          `status: ${deploy.status}`,
          `created_at: ${deploy.created_at}`,
        ];
        if (deploy.error) lines.push(`error: ${deploy.error}`);
        return toolResult({
          deploy_id: deploy.deploy_id,
          status: deploy.status,
          logs: lines.join("\n"),
          source: "local-mock",
          note:
            "Phase 2: this will return real build logs from the Krexel orchestrator.",
        });
      }

      case "rollback": {
        const input = RollbackInputSchema.parse(args ?? {});
        const target = await findDeploy(input.to);
        if (!target) {
          throw new Error(`Cannot rollback: no deploy with id ${input.to}`);
        }
        if (target.domain !== input.domain) {
          throw new Error(
            `Cannot rollback: deploy ${input.to} belongs to ${target.domain}, not ${input.domain}`,
          );
        }
        const state = await readState();
        state.last_good[input.domain] = input.to;
        await updateDeploy(input.to, { status: "ready" });
        return toolResult({
          domain: input.domain,
          to: input.to,
          ok: true,
          note: "Phase 1 records the rollback intent; Phase 2 will repoint the alias.",
        });
      }

      case "set_env": {
        const input = SetEnvInputSchema.parse(args ?? {});
        try {
          await encryptEnvValue(input.domain, input.key, input.value);
        } catch (err) {
          if (err instanceof MissingMasterKeyError) throw err;
          throw new Error(
            `Failed to encrypt env var: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        return toolResult({
          ok: true,
          domain: input.domain,
          key: input.key,
          note: "Encrypted at $KREXEL_HOME/env/" + input.domain + ".enc",
        });
      }

      case "get_status": {
        const state = await readState();
        const report: StatusReport = {
          account: state.account,
          deploy_count: state.deploys.length,
          platform: process.platform,
          api_url: process.env.KREXEL_API_URL ?? "http://localhost:8787",
          state_dir: krexelHome(),
        };
        // Bug #2 fix: round-trip /me so the user can see "key valid for
        // user@email.com, plan: builder" rather than just the local state.
        // Without this, the only way to know if your key works is to try
        // ship_site and read the 401.
        const client = getApiClient();
        const me = await client.getMe();
        return toolResult({
          ...report,
          account: me.ok
            ? {
                email: me.data.email,
                plan: me.data.plan,
                cloudflare_connected: me.data.cloudflare_connected,
                ...(me.data.cloudflare_account_id
                  ? { cloudflare_account_id: me.data.cloudflare_account_id }
                  : {}),
                source: "worker",
              }
            : {
                source: "local-only",
                note:
                  "KREXEL_API_KEY is not set or the worker rejected it. " +
                  "Run `krexel login` to link a key, then restart your AI client.",
                worker_error: me.ok ? null : { status: me.status, error: me.error, message: me.message },
              },
        });
      }

      case "list_files": {
        const input = ListFilesInputSchema.parse(args ?? {});
        const client = getApiClient();
        const res = await client.listFiles(input.deploy_id);
        if (!res.ok) {
          return toolError({
            ok: false,
            error: res.error,
            message: res.message,
            http_status: res.status,
          });
        }
        return toolResult({
          ok: true,
          deploy_id: res.data.deploy_id,
          domain: res.data.domain,
          files: res.data.files.map((f) => ({
            path: f.path,
            size: f.size,
            sha256: f.sha256,
          })),
          count: res.data.files.length,
        });
      }

      case "read_file": {
        const input = ReadFileInputSchema.parse(args ?? {});
        const client = getApiClient();
        const res = await client.readFile(input.deploy_id, input.path);
        if (!res.ok) {
          return toolError({
            ok: false,
            error: res.error,
            message: res.message,
            http_status: res.status,
          });
        }
        return toolResult({ ok: true, ...res.data });
      }

      case "edit_file": {
        const input = EditFileInputSchema.parse(args ?? {});
        const client = getApiClient();

        // The worker needs `domain` in the body, but the AI may only know the
        // deploy_id. Resolve it via a GET to /deploys/:id, then POST the patch.
        // This is one extra round-trip; we batch it because the alternative
        // (requiring domain on every edit_file call) breaks the natural flow
        // of conversational edits ("change my about page").
        const base = await client.getDeploy(input.deploy_id);
        if (!base.ok) {
          return toolError({
            ok: false,
            error: base.error,
            message: `could not look up base deploy ${input.deploy_id}: ${base.message}`,
            http_status: base.status,
          });
        }
        const domain = String(base.data.domain);
        const newContent = input.value ?? input.content;

        // Build the wire-format patch op.
        let patch: PatchOpWire;
        switch (input.op) {
          case "create":
            patch = { op: "create", file: input.file, content: newContent ?? "" };
            break;
          case "replace":
            patch = {
              op: "replace",
              file: input.file,
              find: input.find ?? "",
              value: newContent ?? "",
            };
            break;
          case "replace_all":
            patch = {
              op: "replace_all",
              file: input.file,
              find: input.find ?? "",
              value: newContent ?? "",
            };
            break;
          case "delete":
            patch = { op: "delete", file: input.file };
            break;
        }

        const patchRes = await client.patchDeploy({
          domain,
          base_deploy_id: input.deploy_id,
          patches: [patch],
          ...(input.message ? { message: input.message } : {}),
        });
        if (!patchRes.ok) {
          return toolError({
            ok: false,
            error: patchRes.error,
            message: patchRes.message,
            http_status: patchRes.status,
          });
        }
        const r = patchRes.data;
        return toolResult({
          ok: true,
          deploy_id: r.deploy_id,
          parent_deploy_id: r.parent_deploy_id,
          domain: r.domain,
          preview_url: r.preview_url,
          files_changed: r.files_changed,
          bytes_changed: r.bytes_changed,
          quota_used: r.quota_used,
          message:
            r.message ??
            `Patched ${input.file} (1 file, ${r.bytes_changed >= 0 ? "+" : ""}${r.bytes_changed} bytes)`,
        });
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (err) {
    if (err instanceof ZodError) {
      return toolError(`Invalid arguments: ${err.issues.map((i) => i.message).join("; ")}`);
    }
    if (err instanceof MissingMasterKeyError) {
      return toolError(err.message);
    }
    const msg = err instanceof Error ? err.message : String(err);
    return toolError(msg);
  }
});

function toolResult(payload: unknown): { content: Array<{ type: "text"; text: string }> } {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
  };
}

type ToolErrorPayload = string | Record<string, unknown>;
function toolError(payload: ToolErrorPayload): {
  isError: true;
  content: Array<{ type: "text"; text: string }>;
} {
  const text = typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
  return { isError: true, content: [{ type: "text", text }] };
}

/**
 * Lazily build (and cache) a KrexelApiClient. We re-read env on each call so
 * tests can mutate KREXEL_API_URL / KREXEL_API_KEY without rebuilding the
 * server. The cache only matters within a single tool call.
 */
let _apiClient: KrexelApiClient | null = null;
function getApiClient(): KrexelApiClient {
  _apiClient = null;
  const c = defaultKrexelApiClient();
  _apiClient = c;
  return c;
}

// -----------------------------------------------------------------------------
// Boot
// -----------------------------------------------------------------------------

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Logs must go to stderr — stdout is the JSON-RPC channel.
  process.stderr.write(`[krexel-mcp] ${SERVER_NAME} v${SERVER_VERSION} ready (state: ${krexelHome()})\n`);
}

main().catch((err) => {
  process.stderr.write(`[krexel-mcp] fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});