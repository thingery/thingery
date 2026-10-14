// DOM-less unit tests for the account-page view helpers (THI-114): the key
// is show-once, so the MCP config block is built from either the live key
// (signup/login/regenerate moments) or the masked placeholder.

import { describe, expect, it } from "vitest";
import { MASKED_KEY_HINT, MASKED_KEY_PLACEHOLDER, mcpConfigText } from "../website/account-view.js";

const URL_ = "https://thingery.dev/mcp";

describe("account view helpers (THI-114)", () => {
  it("builds the MCP config with the live key at show-once moments", () => {
    const parsed = JSON.parse(mcpConfigText(URL_, "thg_livekey"));
    expect(parsed.mcpServers.thingery.url).toBe(URL_);
    expect(parsed.mcpServers.thingery.type).toBe("http");
    expect(parsed.mcpServers.thingery.headers.Authorization).toBe("Bearer thg_livekey");
  });

  it("uses the masked placeholder when the key is hidden", () => {
    const text = mcpConfigText(URL_, MASKED_KEY_PLACEHOLDER);
    expect(text).toContain("Bearer <your key>");
    expect(text).not.toContain("thg_"); // no accidental live-key shape
  });

  it("exposes a masked hint that points at regeneration", () => {
    expect(MASKED_KEY_HINT.toLowerCase()).toContain("regenerate");
    expect(MASKED_KEY_PLACEHOLDER).toBe("<your key>");
  });
});
