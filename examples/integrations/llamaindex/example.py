"""Thingery MCP + LlamaIndex quickstart.

Verified 2026-10-24 against https://thingery.dev/mcp (llama-index-tools-mcp 0.6.0).

    pip install llama-index-tools-mcp
    python example.py

Calls the public read tools anonymously; no API key or model needed.
"""

import asyncio

from llama_index.tools.mcp import BasicMCPClient, McpToolSpec


async def main() -> None:
    client = BasicMCPClient("https://thingery.dev/mcp")
    spec = McpToolSpec(client=client)
    tools = await spec.to_tool_list_async()
    print("tools:", ", ".join(t.metadata.name for t in tools))

    search = next(t for t in tools if t.metadata.name == "search_items")
    result = await search.acall(q="")
    print("search_items ->", str(result)[:300], "...")


asyncio.run(main())

# For write tools (create_listing, orders, payouts), authenticate with a
# thg_... API key from https://thingery.dev/login.html:
#
#     client = BasicMCPClient(
#         "https://thingery.dev/mcp",
#         headers={"Authorization": f"Bearer {os.environ['THINGERY_API_KEY']}"},
#     )
