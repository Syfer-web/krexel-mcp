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
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
import { resolveApiUrl } from "./auth.js";

const SERVER_NAME = "krexel-mcp";
// Read from package.json so banner + Server init match the published version.
// dist/index.js → ../package.json (production)
// src/index.ts → ../../package.json (dev — tsx)
function readServerVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const p of [
    resolve(here, "../package.json"),
    resolve(here, "../../package.json"),
  ]) {
    try {
      const json = JSON.parse(readFileSync(p, "utf8")) as { version?: string };
      if (json.version) return json.version;
    } catch {
      // ignore — try next
    }
  }
  return "0.0.0";
}
const SERVER_VERSION = readServerVersion();

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
            description:
              "Absolute or ~-relative path to the built site directory.",
          },
          domain: {
            type: "string",
            description: "Custom domain to attach (e.g. shop.example.com).",
          },
          framework: {
            type: "string",
            enum: ["auto", "nextjs", "astro", "vite", "static"],
            description:
              "Build framework hint. Default 'auto' detects from package.json.",
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
        "Get build logs for a deploy. As of 2026-07-19 this tool returns a " +
        "structured 'no logs available' response from the local stdio MCP " +
        "(the worker holds the authoritative logs; full impl lands in Release B).",
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
        "Mark a previous deploy as the current 'last_good' for a domain. As of " +
        "2026-07-19 this tool refuses the call: rollback in production requires the " +
        "Krexel dashboard (wired in Release B).",
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
            description:
              "Optional human-readable note stored with the patch deploy.",
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
        // 2026-07-19 Release A: the previous copy on api_ok=false
        // was "The deploy is queued for retry; check get_status".
        // There is no retry queue — the audit caught this as
        // "fake queued-for-retry claim". Surface the orchestrator
        // error verbatim and don't promise a retry that doesn't
        // exist.
        return toolResult({
          ...result,
          record,
          note: result.api_ok
            ? "Deploy accepted by orchestrator. Verify with list_deploys against the Krexel dashboard or REST API; the local state file is a staging-only artifact until Release C."
            : result.api_error
              ? `Orchestrator call failed: ${result.api_error}`
              : "Orchestrator call failed with no error detail. No retry queue exists; this surface does not store a queued-for-retry promise.",
        });
      }

      case "list_deploys": {
        const input = ListDeploysInputSchema.parse(args ?? {});
        // 2026-07-19 Release A: the previous implementation
        // returned rows from a local state file. The audit caught
        // this as fake production-history. Until the unified
        // application service (Release C) ships, surface a
        // banner pointing the caller at the dashboard API.
        const rows = await listDeploysState(input.domain, input.limit);
        return toolResult({
          deploys: rows,
          count: rows.length,
          source: "staging-state-only",
          note:
            "These rows come from a local staging manifest (Phase 1). Authoritative deployment history lives at the Krexel REST API and dashboard. Use `krexel deploys` or GET /api/v1/deploys against api.krexel.com for production history.",
        });
      }

      case "get_logs": {
        const input = GetLogsInputSchema.parse(args ?? {});
        const deploy = await findDeploy(input.deploy_id);
        if (!deploy) {
          throw new Error(`No deploy found with id ${input.deploy_id}`);
        }
        // 2026-07-19 Release A: don't return mocked log lines.
        // The audit caught this as fake data. Real logs live at
        // the worker (GET /api/v1/deploys/:id/logs once Release B
        // lands). Until then, return a structured "no logs yet"
        // payload with no fabricated `[mock]` text.
        return toolResult({
          deploy_id: deploy.deploy_id,
          status: deploy.status,
          logs: "",
          available: false,
          source: "staging-state-only",
          note:
            "Build logs are not available from the local stdio MCP today. The Krexel Worker holds the authoritative logs; this endpoint will be wired to it in Release B/C.",
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
        // 2026-07-19 Release A: don't pretend to roll back. The
        // previous path wrote `state.last_good[domain] = to` and
        // marked the deploy ready in the local state file. The
        // audit caught this as "Phase 1 records intent only".
        // Until the unified application service can repoint the
        // live alias, refuse the call with a structured error
        // pointing the user at the dashboard rollback button.
        return toolResult({
          domain: input.domain,
          to: input.to,
          ok: false,
          available: false,
          note:
            "Rollback is not implemented in the local stdio MCP today. Use the Krexel dashboard Site Deploys tab to roll back; that action is wired to the Worker in Release B.",
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
          api_url: resolveApiUrl(),
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
                source: "worker",
              }
            : {
                source: "local-only",
                note:
                  "KREXEL_API_KEY is not set or the worker rejected it. " +
                  "Run `krexel login` to link a key, then restart your AI client.",
                worker_error: me.ok
                  ? null
                  : { status: me.status, error: me.error, message: me.message },
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
            patch = {
              op: "create",
              file: input.file,
              content: newContent ?? "",
            };
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
      return toolError(
        `Invalid arguments: ${err.issues.map((i) => i.message).join("; ")}`,
      );
    }
    if (err instanceof MissingMasterKeyError) {
      return toolError(err.message);
    }
    const msg = err instanceof Error ? err.message : String(err);
    return toolError(msg);
  }
});

function toolResult(payload: unknown): {
  content: Array<{ type: "text"; text: string }>;
} {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
  };
}

type ToolErrorPayload = string | Record<string, unknown>;
function toolError(payload: ToolErrorPayload): {
  isError: true;
  content: Array<{ type: "text"; text: string }>;
} {
  const text =
    typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
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
  process.stderr.write(
    `[krexel-mcp] ${SERVER_NAME} v${SERVER_VERSION} ready (state: ${krexelHome()})\n`,
  );
}

main().catch((err) => {
  process.stderr.write(
    `[krexel-mcp] fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
  process.exit(1);
});
