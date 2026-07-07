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

function toolResult(payload: unknown): { content: Array<{ type: "text"; text: string }> } {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
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