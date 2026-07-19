# krexel-mcp

> Ship AND edit static sites from any AI assistant that speaks the
> [Model Context Protocol](https://modelcontextprotocol.io/).

`krexel-mcp` is the official MCP server for
[Krexel](https://krexel.com) — a "your AI ships and edits your live site"
API. Point any MCP-compatible client (Claude Desktop, Cursor, Windsurf,
VS Code) at this server and your assistant can deploy, list, edit,
rollback, and inspect sites just by talking.

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
        "KREXEL_API_KEY": "krx_live_••••••••••••••••",
        "KREXEL_MASTER_KEY": "<your-32-byte-hex-key>"
      }
    }
  }
}
```

Restart your client. The assistant now sees nine Krexel tools.

## Tools

| Tool           | What it does                                                                 |
| -------------- | ---------------------------------------------------------------------------- |
| `ship_site`    | Upload a built site folder. Returns a `deploy_id` and preview URL.           |
| `edit_file`    | Patch a deployed site (create / replace / replace_all / delete). 0.1 deploy. |
| `list_files`   | List the files in a deployed site (path + size + sha256).                    |
| `read_file`    | Read one file's content from a deployed site.                                |
| `list_deploys` | List recent deploys from local state. Optional domain filter.                |
| `get_logs`     | Fetch build logs for a deploy.                                               |
| `rollback`     | Mark a previous deploy as the current good version.                          |
| `set_env`      | Encrypt and persist an env var for a domain (AES-256-GCM).                   |
| `get_status`   | Return account, deploy count, plan, and state directory.                     |

### The conversational-edit flow

1. AI calls `list_files(deploy_id)` to see what files exist on the site.
2. AI calls `read_file(deploy_id, path)` to read the file it wants to change.
3. AI generates the new content itself, then calls
   `edit_file(deploy_id, op: "replace", file, find, value, message)`.
4. Krexel ships the patch as a new deploy — live in ~8 seconds, 0.1 deploy
   against the customer's quota. The new `deploy_id` and `parent_deploy_id`
   are returned so the AI can chain further edits on top.

The AI is the brain. Krexel is the hands.

All tools take plain JSON arguments and return JSON. Tool schemas are
discoverable via the standard MCP `tools/list` request.

## Configuration

| Env var             | Required | Default                  | Notes                                                                                                     |
| ------------------- | -------- | ------------------------ | --------------------------------------------------------------------------------------------------------- |
| `KREXEL_API_URL`    | no       | `https://api.krexel.com` | Base URL of the Krexel orchestrator API.                                                                  |
| `KREXEL_API_KEY`    | no*      | `~/.krexel/auth.json`    | Account API key. Forwarded as `Authorization: Bearer ***` to every API call. *Required unless saved by `krexel login`. |
| `KREXEL_MASTER_KEY` | yes*     | —                        | 32-byte hex string for env-var encryption. *Required for `set_env`.                                       |

State files are written under `$KREXEL_HOME` (default `~/.krexel/`).

## License

MIT © [Syfer](https://krexel.com)
