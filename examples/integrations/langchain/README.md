# Thingery + LangChain

LangChain's MCP support (JS: `@langchain/mcp-adapters` ≥ 2, Python:
`langchain-mcp-adapters` ≥ 0.3) connects to any streamable-HTTP MCP server by
URL — no Thingery-specific package needed.

## JavaScript / TypeScript

```bash
npm install @langchain/mcp-adapters
node example.mjs
```

`example.mjs` lists our tools and calls `search_items` directly (no model
required):

```mjs
import { MCPAdapter } from "@langchain/mcp-adapters";

const adapter = new MCPAdapter({
  servers: { thingery: { url: "https://thingery.dev/mcp" } },
});
const tools = await adapter.listTools();
// tools are prefixed with the server name, e.g. thingery_search_items
const search = tools.find((t) => t.name.endsWith("search_items"));
console.log(await search.invoke({ q: "" }));
await adapter.close();
```

Verified 2026-10-24 against https://thingery.dev/mcp: 16 tools listed,
`search_items` returned 8 results.

### Wire into an agent

Tools returned by `listTools()` are plain LangChain tools — hand them to
`createAgent` from `langchain` (any model) as in the
[upstream quickstart](https://www.npmjs.com/package/@langchain/mcp-adapters).
To call write tools (listing, orders), add a header or OAuth provider to the
server config:

```ts
const adapter = new MCPAdapter({
  servers: {
    thingery: {
      url: "https://thingery.dev/mcp",
      headers: { Authorization: `Bearer ${process.env.THINGERY_API_KEY}` }, // thg_...
    },
  },
});
```

## Python

```bash
pip install langchain-mcp-adapters
python example.py
```

```python
import asyncio
from langchain_mcp_adapters.client import MultiServerMCPClient


async def main() -> None:
    client = MultiServerMCPClient(
        {"thingery": {"url": "https://thingery.dev/mcp", "transport": "streamable_http"}}
    )
    tools = await client.get_tools()
    search = next(t for t in tools if t.name == "search_items")
    print(await search.ainvoke({"q": ""}))


asyncio.run(main())
```

Verified 2026-10-24 against https://thingery.dev/mcp (langchain-mcp-adapters
0.3.2). For write tools, pass `headers={"Authorization": "Bearer thg_..."}` in
the server config.
