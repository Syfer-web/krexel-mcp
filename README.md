# krexel-mcp

> Ship and edit websites from any AI assistant that speaks the
> [Model Context Protocol](https://modelcontextprotocol.io/).

`krexel-mcp` is the official MCP server for
[Krexel](https://www.npmjs.com/package/krexel) — a "deploy a website" API for
AI agents. Point any MCP-compatible client (Claude Desktop, Cursor, etc.) at
this server and you can build, deploy, edit, list, rollback, and inspect sites
by talking to your assistant.

## Quickstart

Add `krexel-mcp` to your MCP client configuration:

```json
{
  "mcpServers": {
    "krexel": {
      "command": "npx",
      "args": ["-y", "krexel-mcp"],
      "env": {
        "KREXEL_API_URL": "https://api.krexel.com",
        "KREXEL_API_KEY": "krx_live_…",
        "KREXEL_MASTER_KEY": "<your-32-byte-hex-key>"
      }
    }
  }
}
```

Restart your client. The assistant now sees nine Krexel tools.

## Tools

| Tool                  | What it does                                                                  |
|-----------------------|-------------------------------------------------------------------------------|
| `ship_site`           | Upload a built site folder (1.0 quota). Returns a `deploy_id` and preview URL. |
| `update_site`         | Edit a deployed site in place (0.1 quota). Applies a patch manifest.          |
| `get_current_site`    | Read the live file tree + contents for a domain.                              |
| `list_file_versions`  | Show version history + unified diffs for a single file on a domain.           |
| `list_deploys`        | List recent deploys from local state. Optional domain filter.                 |
| `get_logs`            | Fetch build logs for a deploy (streams from the orchestrator).                |
| `rollback`            | Roll back a domain to a previous deploy (real alias switch).                  |
| `set_env`             | Encrypt and persist an env var for a domain (AES-256-GCM).                    |
| `get_status`          | Return account, deploy count, and state directory.                            |

### Conversational edit-and-deploy workflow

The new `update_site` tool lets your assistant edit a deployed site
conversationally. Each edit counts as **0.1 deploy** against the monthly quota
(vs. **1.0** for a full `ship_site`), so a free-tier user can do up to
**100 AI edits per month**.

The recommended flow:

1. **Read** the live file via `get_current_site(domain="alex.dev")`. This
   returns the file tree, sha256 hashes, and (by default) full contents.
2. **Patch** the file via `update_site(domain, patches=[…])`. The patch's
   `find` must appear verbatim in the live file — read first, then edit.
3. **Verify** with `list_file_versions(domain, file="about.html")` to see
   the diff your last edit produced.

Example patch op shapes:

```jsonc
{ "op": "create",       "file": "new.html", "content": "<h1>x</h1>" }
{ "op": "replace",       "file": "about.html", "find": "About", "value": "About Us" }
{ "op": "replace_all",   "file": "style.css",  "find": "red",   "value": "blue" }
{ "op": "delete",        "file": "old.html" }
```

Every patch becomes a real versioned deploy — `rollback` works the same as
for full deploys, and the audit trail records `parent_deploy_id` for each
edit.

All tools take plain JSON arguments and return JSON. Tool schemas are
discoverable via the standard MCP `tools/list` request.

## Configuration

| Env var               | Required | Default              | Notes                                    |
|-----------------------|----------|----------------------|------------------------------------------|
| `KREXEL_API_URL`      | no       | `http://localhost:8787` | Base URL of the Krexel orchestrator API. |
| `KREXEL_API_KEY`      | no       | —                    | Bearer token (`krx_live_…`) for API auth. |
| `KREXEL_MASTER_KEY`   | yes*     | —                    | 32-byte hex string for env-var encryption. *Required for `set_env`. |

State files are written under `$KREXEL_HOME` (default `~/.krexel/`).

## License

MIT © [Syfer](https://krexel.com)