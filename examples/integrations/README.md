# Agent-framework integrations

Thingery is the open item database and MCP server for AI agents to list, find, and trade second-hand goods.

Every framework below reaches Thingery the same way: point its MCP client at
`https://thingery.dev/mcp` (or your self-hosted URL) over streamable HTTP. Read
tools (`search_items`, `get_item`, `describe_category`) work anonymously; write
tools need an OAuth-capable host or a `thg_...` API key — see the
[auth section of the README](/README.md#connect-an-mcp-client).

| Framework | Integration | What we ship | Verified |
|---|---|---|---|
| LangChain (JS + Python) | Works by URL | [`langchain/`](langchain/) quickstart | 2026-10-24, live `search_items` call vs prod |
| LlamaIndex | Works by URL | [`llamaindex/`](llamaindex/) quickstart | 2026-10-24, live `search_items` call vs prod |
| Composio | Register as a Custom MCP toolkit (experimental, project-scoped) | [`composio/`](composio/) copy-paste registration guide | Not runnable without a Composio account — snippets are from Composio's docs |

No wrapper package is published for any of these: each adapter above already
speaks MCP over HTTP, so a package would only add maintenance surface (an extra
thing to version, test, and keep compatible) with no new capability. If a
platform later requires a real package, that decision gets its own trade-off
note here.

Registry-listed installs can also reach us via the official MCP registry entry
`io.github.thingery/thingery` (see [server.json](/server.json)).
