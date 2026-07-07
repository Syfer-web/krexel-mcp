#!/usr/bin/env node
/**
 * Krexel MCP server — stdio transport.
 *
 * Tools exposed:
 *   ship_site, update_site, get_current_site, list_file_versions,
 *   list_deploys, get_logs, rollback, set_env, get_status
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
  GetCurrentSiteInputSchema,
  UpdateSiteInputSchema,
  ListFileVersionsInputSchema,
  ListDeploysInputSchema,
  GetLogsInputSchema,
  RollbackInputSchema,
  SetEnvInputSchema,
  GetStatusInputSchema,
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
  buildPatchManifest,
  fetchCurrentSite,
  fetchFileVersions,
  fetchLogs,
  PATCH_QUOTA_COST,
  postPatch,
  postRollback,
} from "./update.js";
import { buildFileVersionsResponse } from "./version.js";

const SERVER_NAME = "krexel-mcp";
const SERVER_VERSION = "0.2.0";

const server = new Server(
  { name: SERVER_NAME, version: SERVER_VERSION },
  { capabilities: { tools: {} } },
);

function apiUrl(): string {
  return process.env.KREXEL_API_URL ?? "http://localhost:8787";
}

// -----------------------------------------------------------------------------
// Tool registry
// -----------------------------------------------------------------------------

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "ship_site",
      description:
        "Upload a built site folder to Krexel. Counts as 1.0 against your monthly quota. " +
        "For editing an existing deployed site, use update_site instead — it's faster and " +
        "uses 0.1 quota. Zips the folder, stages it locally, and POSTs to the Krexel " +
        "orchestrator API. Returns a deploy_id (always) and preview_url. If the orchestrator " +
        "is unreachable the response carries an `api_ok: false` flag with the upstream " +
        "error — never fakes success.",
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
      name: "get_current_site",
      description:
        "Read the live deployed file tree for a domain — last good deploy's files, sizes, " +
        "and sha256 hashes (and contents unless include_content=false). " +
        "BEFORE calling update_site, you MUST call get_current_site to read the exact current " +
        "contents of the file you want to edit — the patch 'replace' / 'replace_all' ops " +
        "require an exact substring match against the live file, otherwise the deploy fails. " +
        "Workflow: get_current_site → identify file → construct find/value from its current " +
        "content → update_site.",
      inputSchema: {
        type: "object",
        properties: {
          domain: {
            type: "string",
            description: "Domain to inspect (e.g. 'shop.example.com').",
          },
          include_content: {
            type: "boolean",
            default: true,
            description:
              "Set false to fetch only the file tree + hashes (smaller payload). Default true.",
          },
        },
        required: ["domain"],
      },
    },
    {
      name: "update_site",
      description:
        "For editing an existing deployed site. Counts as 0.1 against your monthly quota " +
        "(vs 1.0 for ship_site). Use get_current_site first to read the file — patch " +
        "ops need an exact substring match. Each call becomes a real versioned deploy " +
        "(parent_deploy_id recorded) so rollback works the same as for full deploys. " +
        "Pass dry_run=true to validate without deploying.",
      inputSchema: {
        type: "object",
        properties: {
          domain: {
            type: "string",
            description: "Domain whose deployed site you want to edit.",
          },
          patches: {
            type: "array",
            description: "Patch operations applied in order (max 50).",
            items: {
              type: "object",
              properties: {
                op: {
                  type: "string",
                  enum: ["create", "replace", "replace_all", "delete"],
                },
                file: { type: "string" },
              },
              required: ["op", "file"],
            },
          },
          message: {
            type: "string",
            description: "Optional audit-log note (max 500 chars).",
          },
          dry_run: {
            type: "boolean",
            default: false,
            description: "If true, validate patches without deploying.",
          },
        },
        required: ["domain", "patches"],
      },
    },
    {
      name: "list_file_versions",
      description:
        "Show version history for a single file on a domain — when it changed and the unified " +
        "diff between consecutive versions. Useful for 'what did my last edit actually change?'",
      inputSchema: {
        type: "object",
        properties: {
          domain: { type: "string" },
          file: {
            type: "string",
            description: "Path within the site, e.g. 'about.html'.",
          },
          limit: {
            type: "number",
            default: 10,
            description: "Maximum number of versions to return (default 10).",
          },
        },
        required: ["domain", "file"],
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
        "Fetch build logs for a deploy. Now streams from the Krexel orchestrator when " +
        "reachable; falls back to the local manifest summary if the API is down.",
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
        "Roll back a domain to a previous deploy. The orchestrator repoints the production " +
        "alias to the target deploy (Cloudflare Pages typical propagation: ~8 seconds). " +
        "Returns the propagation estimate so you can tell the user how long until live.",
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
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    switch (name) {
      case "ship_site": {
        const input = ShipSiteInputSchema.parse(args ?? {});
        const uploadDir = uploadDirFor(`${input.domain}-${Date.now()}`);
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
            ? "Deploy accepted by orchestrator. For follow-up edits use update_site (0.1 quota)."
            : "Local stage succeeded but orchestrator API was unreachable or returned an error. " +
              "The deploy is queued for retry; check `get_status` and `get_logs` for status.",
        });
      }

      case "get_current_site": {
        const input = GetCurrentSiteInputSchema.parse(args ?? {});
        const res = await fetchCurrentSite({
          apiUrl: apiUrl(),
          domain: input.domain,
          includeContent: input.include_content,
        });
        if (!res.ok || !res.body) {
          return toolError(
            `get_current_site failed (status ${res.status}, source=${res.source}): ${res.raw}`,
          );
        }
        // If include_content was true, ensure content field is present on every file.
        const files =
          input.include_content === false
            ? res.body.files.map((f) => ({ path: f.path, size: f.size, sha256: f.sha256 }))
            : res.body.files;
        return toolResult({
          domain: res.body.domain,
          deploy_id: res.body.deploy_id,
          created_at: res.body.created_at,
          files,
          source: res.source,
          note:
            "Next: construct an update_site patch using an exact substring of `content` " +
            "for the file you want to edit. The patch's `find` must appear verbatim " +
            "in the live file or the deploy will be rejected.",
        });
      }

      case "update_site": {
        const input = UpdateSiteInputSchema.parse(args ?? {});
        // Build the manifest client-side (validates paths, dedupes targets).
        const manifest = buildPatchManifest({
          domain: input.domain,
          patches: input.patches,
          ...(input.message !== undefined ? { message: input.message } : {}),
          ...(input.dry_run !== undefined ? { dry_run: input.dry_run } : {}),
        });
        const res = await postPatch({
          apiUrl: apiUrl(),
          manifest,
          ...(process.env.KREXEL_API_KEY ? { apiKey: process.env.KREXEL_API_KEY } : {}),
        });
        if (!res.ok || !res.body) {
          return toolError(
            `update_site failed (status ${res.status}): ${res.raw}`,
          );
        }
        const body = res.body;
        // Persist the patch deploy locally for audit + rollback.
        const record: DeployRecord = {
          deploy_id: body.deploy_id,
          domain: body.domain,
          framework: "patch",
          folder: "(patch)",
          status: body.status,
          preview_url: body.preview_url,
          created_at: new Date().toISOString(),
          parent_deploy_id: body.parent_deploy_id,
          ...(body.message ? { message: body.message } : {}),
        };
        await appendDeploy(record);
        return toolResult({
          ...body,
          // Always surface the quota constant so the LLM can tell the user
          // their running total without doing math itself.
          quota_used: body.quota_used ?? PATCH_QUOTA_COST,
          record,
          note: input.dry_run
            ? "dry_run=true — no deploy was created."
            : `Patch deploy created. Counts as ${PATCH_QUOTA_COST} against your monthly quota.`,
        });
      }

      case "list_file_versions": {
        const input = ListFileVersionsInputSchema.parse(args ?? {});
        // Try the worker's dedicated endpoint first.
        const res = await fetchFileVersions({
          apiUrl: apiUrl(),
          domain: input.domain,
          file: input.file,
          limit: input.limit,
          ...(process.env.KREXEL_API_KEY ? { apiKey: process.env.KREXEL_API_KEY } : {}),
        });
        if (res.ok && res.body) {
          return toolResult(res.body);
        }
        // TODO(worker-v2): when /api/v1/file-versions lands, the dedicated
        // endpoint returns {deploy_id, parent_deploy_id, content, ...} and the
        // client synthesizes unified diffs. Until then, fall back to whatever
        // the worker /deploys endpoint returns for this domain and filter
        // client-side — not file-aware yet but at least bounded.
        const fallback = await listDeploysState(input.domain, input.limit);
        const versions = fallback.map((d) => ({
          deploy_id: d.deploy_id,
          parent_deploy_id: (d as DeployRecord & { parent_deploy_id?: string | null })
            .parent_deploy_id ?? null,
          created_at: d.created_at,
          ...(d.message ? { message: d.message } : {}),
          content: null as string | null,
        }));
        return toolResult(
          buildFileVersionsResponse({
            domain: input.domain,
            file: input.file,
            versions,
          }),
          {
            _meta: {
              fallback: true,
              worker_status: res.status,
              worker_error: res.raw,
              note: "file-specific worker endpoint not yet available; showing recent " +
                "deploys for domain without diffs. TODO: replace when worker lands.",
            },
          },
        );
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
        const apiRes = await fetchLogs({
          apiUrl: apiUrl(),
          deployId: input.deploy_id,
          ...(process.env.KREXEL_API_KEY ? { apiKey: process.env.KREXEL_API_KEY } : {}),
        });
        if (apiRes.ok) {
          // If the body is a plain string, ship it as text; if JSON, ship as-is.
          if (typeof apiRes.body === "string") {
            return toolResult({
              deploy_id: input.deploy_id,
              status: deploy.status,
              logs: apiRes.body,
              source: "orchestrator",
            });
          }
          return toolResult({
            deploy_id: input.deploy_id,
            status: deploy.status,
            logs: apiRes.body,
            source: "orchestrator",
          });
        }
        // Fallback: orchestrator unreachable. Return local manifest summary
        // and mark clearly so the LLM knows the data isn't live.
        const lines: string[] = [
          `[fallback] Orchestrator unreachable (status ${apiRes.status}); showing local manifest summary.`,
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
          source: "local-fallback",
          note: `Orchestrator logs endpoint returned status ${apiRes.status}. ` +
            "Live streaming is preferred — retry, or check KREXEL_API_URL/auth.",
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
        const fromDeployId = state.last_good[input.domain] ?? null;
        // Call the worker (real alias switch). The worker is responsible for
        // pointing the production alias at the target deploy.
        const apiRes = await postRollback({
          apiUrl: apiUrl(),
          domain: input.domain,
          to: input.to,
          ...(process.env.KREXEL_API_KEY ? { apiKey: process.env.KREXEL_API_KEY } : {}),
        });
        if (!apiRes.ok) {
          return toolError(
            `Rollback request failed (status ${apiRes.status}): ${apiRes.raw}`,
          );
        }
        // Update local state regardless — the worker either succeeded or
        // returned a meaningful error (which we already surfaced).
        state.last_good[input.domain] = input.to;
        await updateDeploy(input.to, { status: "ready" });
        // The worker response shape per spec:
        //   { domain, from_deploy_id, to_deploy_id, status, estimated_propagation_seconds }
        const workerBody = apiRes.body as
          | {
              estimated_propagation_seconds?: number;
              from_deploy_id?: string;
              to_deploy_id?: string;
              status?: string;
            }
          | string
          | null;
        const propagation =
          typeof workerBody === "object" && workerBody !== null
            ? (workerBody.estimated_propagation_seconds ?? 8)
            : 8;
        const fromReported =
          typeof workerBody === "object" && workerBody !== null && workerBody.from_deploy_id
            ? workerBody.from_deploy_id
            : fromDeployId;
        return toolResult({
          domain: input.domain,
          from_deploy_id: fromReported,
          to_deploy_id: input.to,
          status: typeof workerBody === "object" && workerBody?.status ? workerBody.status : "rolled_back",
          estimated_propagation_seconds: propagation,
          worker_response: workerBody,
          note: `Live in ~${propagation}s.`,
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
          api_url: apiUrl(),
          state_dir: krexelHome(),
        };
        return toolResult(report);
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

function toolResult(
  payload: unknown,
  extras?: Record<string, unknown>,
): { content: Array<{ type: "text"; text: string }> } {
  const merged = extras ? { ...(payload as object), ...extras } : payload;
  return {
    content: [{ type: "text", text: JSON.stringify(merged, null, 2) }],
  };
}

function toolError(msg: string): { isError: true; content: Array<{ type: "text"; text: string }> } {
  return {
    isError: true,
    content: [{ type: "text", text: msg }],
  };
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