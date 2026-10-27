# Thingery + LlamaIndex

LlamaIndex's MCP integration (`llama-index-tools-mcp` ≥ 0.6) connects to any
MCP server by URL and auto-detects streamable HTTP — no Thingery-specific
package needed.

```bash
pip install llama-index-tools-mcp
python example.py
```

`BasicMCPClient` wraps the connection; `McpToolSpec` turns our tools into
LlamaIndex `FunctionTool`s. The example lists tools and calls `search_items`
directly (no model required):

```python
import asyncio
from llama_index.tools.mcp import BasicMCPClient, McpToolSpec


async def main() -> None:
    client = BasicMCPClient("https://thingery.dev/mcp")
    spec = McpToolSpec(client=client)
    tools = await spec.to_tool_list_async()
    search = next(t for t in tools if t.metadata.name == "search_items")
    print(await search.acall(q=""))


asyncio.run(main())
```

Verified 2026-10-24 against https://thingery.dev/mcp (llama-index-tools-mcp
0.6.0): 16 tools listed, `search_items` returned 8 results.

## Wire into an agent

The tool list plugs straight into any LlamaIndex agent:

```python
from llama_index.core.agent.workflow import FunctionAgent

agent = FunctionAgent(tools=tools, llm=llm, system_prompt="...")
```

For write tools (listing, orders), pass headers to the client:

```python
import os

client = BasicMCPClient(
    "https://thingery.dev/mcp",
    headers={"Authorization": f"Bearer {os.environ['THINGERY_API_KEY']}"},  # thg_...
)
```
