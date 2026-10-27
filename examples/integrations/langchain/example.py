"""Thingery MCP + LangChain (Python) quickstart.

Verified 2026-10-24 against https://thingery.dev/mcp (langchain-mcp-adapters 0.3.2).

    pip install langchain-mcp-adapters
    python example.py

Calls the public read tools anonymously; no API key or model needed.
"""

import asyncio

from langchain_mcp_adapters.client import MultiServerMCPClient


async def main() -> None:
    client = MultiServerMCPClient(
        {
            "thingery": {
                "url": "https://thingery.dev/mcp",
                "transport": "streamable_http",
            }
        }
    )
    tools = await client.get_tools()
    print("tools:", ", ".join(t.name for t in tools))

    search = next(t for t in tools if t.name == "search_items")
    result = await search.ainvoke({"q": ""})
    print("search_items ->", str(result)[:300], "...")


asyncio.run(main())

# For write tools (create_listing, orders, payouts), authenticate with a
# thg_... API key from https://thingery.dev/login.html:
#
#     "thingery": {
#         "url": "https://thingery.dev/mcp",
#         "transport": "streamable_http",
#         "headers": {"Authorization": f"Bearer {os.environ['THINGERY_API_KEY']}"},
#     },
