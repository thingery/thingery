// Pure view helpers for the account page (THI-114). Kept free of DOM access
// so they unit-test DOM-less (same pattern as website/next-filter.js).

/** Placeholder shown wherever the live key belongs once it is no longer
 * sent by /api/me — the key is show-once (signup/login/regenerate only). */
export const MASKED_KEY_HINT = "Hidden for safety — regenerate to get a new key.";

/** MCP config block text. `apiKey` is the live `thg_…` key at show-once
 * moments, or the "<your key>" placeholder when the key is not at hand. */
export function mcpConfigText(mcpUrl, apiKey) {
  return JSON.stringify(
    {
      mcpServers: {
        thingery: { type: "http", url: mcpUrl, headers: { Authorization: `Bearer ${apiKey}` } },
      },
    },
    null,
    2,
  );
}

/** The placeholder key used in the config block when the live key is hidden. */
export const MASKED_KEY_PLACEHOLDER = "<your key>";
