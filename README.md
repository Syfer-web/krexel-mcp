# krexel-mcp

> Ship websites from any AI assistant that speaks the
> [Model Context Protocol](https://modelcontextprotocol.io/).

`krexel-mcp` is the official MCP server for
[Krexel](https://www.npmjs.com/package/krexel) — a "deploy a website" API for
AI agents. Point any MCP-compatible client (Claude Desktop, Cursor, etc.) at
this server and you can build, deploy, list, rollback, and inspect sites by
talking to your assistant.

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
        "KREXEL_MASTER_KEY": "<your-32-byte-hex-key>"
      }
    }
  }
}
```

Restart your client. The assistant now sees six Krexel tools.

## Tools

| Tool           | What it does                                                       |
|----------------|--------------------------------------------------------------------|
| `ship_site`    | Upload a built site folder. Returns a `deploy_id` and preview URL.  |
| `list_deploys` | List recent deploys from local state. Optional domain filter.       |
| `get_logs`     | Fetch build logs for a deploy.                                     |
| `rollback`     | Mark a previous deploy as the current good version.                |
| `set_env`      | Encrypt and persist an env var for a domain (AES-256-GCM).         |
| `get_status`   | Return account, deploy count, and state directory.                 |

All tools take plain JSON arguments and return JSON. Tool schemas are
discoverable via the standard MCP `tools/list` request.

## Configuration

| Env var               | Required | Default              | Notes                                    |
|-----------------------|----------|----------------------|------------------------------------------|
| `KREXEL_API_URL`      | no       | `http://localhost:8787` | Base URL of the Krexel orchestrator API. |
| `KREXEL_MASTER_KEY`   | yes*     | —                    | 32-byte hex string for env-var encryption. *Required for `set_env`. |

State files are written under `$KREXEL_HOME` (default `~/.krexel/`).

## License

MIT © [Syfer](https://krexel.com)