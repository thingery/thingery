// Thingery MCP + LangChain.js quickstart.
// Verified 2026-10-24 against https://thingery.dev/mcp.
//
//   npm install @langchain/mcp-adapters
//   node example.mjs
//
// Calls the public read tools anonymously; no API key or model needed.
import { MCPAdapter } from "@langchain/mcp-adapters";

const adapter = new MCPAdapter({
  servers: {
    thingery: { url: "https://thingery.dev/mcp" },
  },
});

try {
  const tools = await adapter.listTools();
  console.log("tools:", tools.map((t) => t.name).join(", "));

  // Tools are prefixed with the server name: thingery_search_items.
  const search = tools.find((t) => t.name.endsWith("search_items"));
  const result = await search.invoke({ q: "" });
  console.log("search_items ->", String(result).slice(0, 300), "...");
} finally {
  await adapter.close();
}

// For write tools (create_listing, orders, payouts), authenticate with a
// thg_... API key from https://thingery.dev/login.html:
//
//   const adapter = new MCPAdapter({
//     servers: {
//       thingery: {
//         url: "https://thingery.dev/mcp",
//         headers: { Authorization: `Bearer ${process.env.THINGERY_API_KEY}` },
//       },
//     },
//   });
