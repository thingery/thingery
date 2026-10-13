import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools, type ToolContext } from "./tools.js";
import { VERSION } from "./version.js";

export function buildServer(ctx: ToolContext): McpServer {
  const server = new McpServer(
    { name: "thingery", version: VERSION },
    {
      instructions:
        "Thingery is the open item database for second-hand goods. " +
        "Sellers authenticate with a Bearer API key (thg_...) or OAuth access token (thgo_...) to create and update listings; " +
        "search_items and get_item are public. Prices are integer cents.",
    },
  );
  registerTools(server, ctx);
  return server;
}
