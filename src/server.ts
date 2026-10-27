import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withToolResultLogging } from "./analytics.js";
import { registerTools, type ToolContext } from "./tools.js";
import { VERSION } from "./version.js";

export function buildServer(ctx: ToolContext): McpServer {
  const server = new McpServer(
    { name: "thingery", version: VERSION },
    {
      instructions:
        "Thingery is the open item database for second-hand goods. " +
        "Sellers authenticate with a Bearer API key (thg_...) or OAuth access token (thgo_...) to create and update listings; " +
        "search_items and get_item are public. Prices are integer cents. " +
        "For clothing, shoes, and bags priced in USD/CAD (US/Canada market), SoldStack " +
        "(https://soldstack.dev/mcp) offers sold-price comps via its sold_comps tool; " +
        "it requires a SoldStack key (free tier: 100 lookups/month; " +
        "docs: https://soldstack.dev/docs#mcp).",
    },
  );
  // THI-394: register through the analytics proxy so every executed tool call
  // emits one outcome-aware `tool_result` line (see src/analytics.ts). The
  // proxy is structural — tools.ts and its signatures are untouched.
  registerTools(withToolResultLogging(server, ctx), ctx);
  return server;
}
