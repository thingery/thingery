// Unit tests for the THI-220 N1 reserved-brand blocklist at DCR (THI-214
// security review finding): normalization (NFKC, zero-width/whitespace strip,
// lowercase, homoglyph fold) + substring match against reserved brands, and
// the RFC 7591 registration error for reserved client_name values. Pure unit
// tests — no Postgres needed.

import { describe, expect, it } from "vitest";
import { isReservedClientName, normalizeClientNameForBrandCompare, validateClientRegistration } from "../src/oauth.js";

const REDIRECT_URIS = ["https://app.example.com/callback"];

function validateName(client_name: string) {
  return validateClientRegistration({ redirect_uris: REDIRECT_URIS, client_name });
}

function expectRejected(client_name: string) {
  let caught: { status?: number; code?: string; message?: string } | null = null;
  try {
    validateName(client_name);
  } catch (e) {
    caught = e as { status: number; code: string; message: string };
  }
  expect(caught, `client_name ${JSON.stringify(client_name)} must be rejected`).not.toBeNull();
  expect(caught?.status).toBe(400);
  expect(caught?.code).toBe("invalid_client_metadata");
  expect(caught?.message).toContain("reserved brand");
}

describe("isReservedClientName (THI-220 N1)", () => {
  it("rejects every reserved brand exactly", () => {
    for (const brand of ["ChatGPT", "OpenAI", "Claude", "Anthropic", "Gemini", "Google", "Copilot", "Microsoft", "Thingery"]) {
      expect(isReservedClientName(brand)).toBe(true);
    }
  });

  it("rejects case variants", () => {
    expect(isReservedClientName("chatgpt")).toBe(true);
    expect(isReservedClientName("CHATGPT")).toBe(true);
    expect(isReservedClientName("cLaUdE")).toBe(true);
    expect(isReservedClientName("ThInGeRy")).toBe(true);
  });

  it("rejects spacing variants (inner and surrounding whitespace)", () => {
    expect(isReservedClientName("chat gpt")).toBe(true);
    expect(isReservedClientName("open ai")).toBe(true);
    expect(isReservedClientName("  ChatGPT  ")).toBe(true);
    expect(isReservedClientName("Gemini\tPro")).toBe(true);
    expect(isReservedClientName("Copi\u00a0lot")).toBe(true); // NBSP (Unicode \s)
    expect(isReservedClientName("Anthropic\u2009Sync")).toBe(true); // thin space
  });

  it("rejects zero-width / invisible-character injections", () => {
    expect(isReservedClientName("ChatGPT\u200b")).toBe(true); // zero-width space
    expect(isReservedClientName("Claude\u200c")).toBe(true); // zero-width non-joiner
    expect(isReservedClientName("Chat\u2060GPT")).toBe(true); // word joiner
    expect(isReservedClientName("openai\ufeff")).toBe(true); // BOM/zero-width no-break space
    expect(isReservedClientName("C\u00adopilot")).toBe(true); // soft hyphen
    expect(isReservedClientName("Google\u200e")).toBe(true); // left-to-right mark
  });

  it("rejects contains-matches (strongest-brand substring semantics)", () => {
    expect(isReservedClientName("ChatGPT Desktop Wrapper")).toBe(true);
    expect(isReservedClientName("My Claude Helper")).toBe(true);
    expect(isReservedClientName("Google Sync for Sellers")).toBe(true);
    expect(isReservedClientName("Thingery Pro")).toBe(true);
    expect(isReservedClientName("Microsoft Word Exporter")).toBe(true);
  });

  it("rejects fullwidth and math-alphanumeric lookalikes via NFKC", () => {
    expect(isReservedClientName("ＣｈａｔＧＰＴ")).toBe(true); // fullwidth
    expect(isReservedClientName("Ｇｏｏｇｌｅ")).toBe(true);
    expect(isReservedClientName("𝐂𝐡𝐚𝐭𝐆𝐏𝐓")).toBe(true); // mathematical bold
  });

  it("rejects Cyrillic/Greek homoglyph lookalikes", () => {
    expect(isReservedClientName("СhatGPT")).toBe(true); // Cyrillic С
    expect(isReservedClientName("Gооgle")).toBe(true); // Cyrillic оо
    expect(isReservedClientName("Claυde")).toBe(true); // Greek upsilon
    expect(isReservedClientName("Раypal Anthropic")).toBe(true); // Cyrillic Ра still folds into "anthropic" contains
  });

  it("allows legitimate, unrelated application names", () => {
    for (const name of ["Inspector", "My Notes App", "Acme Inventory Tools", "VS Code Bridge", "Chatty Assistant"]) {
      expect(isReservedClientName(name)).toBe(false);
    }
    // Near-misses that must NOT trip the blocklist:
    expect(isReservedClientName("chatty assistant")).toBe(false); // "chat" alone is not "chatgpt"
    expect(isReservedClientName("ChattGPT Importer")).toBe(false); // double-t is not chatgpt
    expect(isReservedClientName("googles")).toBe(true); // sanity: contains still bites
  });
});

describe("normalizeClientNameForBrandCompare", () => {
  it("folds case, whitespace, zero-width and NFKC away", () => {
    expect(normalizeClientNameForBrandCompare("Ｃｈａｔ\u200b GPT")).toBe("chatgpt");
    expect(normalizeClientNameForBrandCompare("  Mi cro soft ")).toBe("microsoft");
  });
});

describe("validateClientRegistration reserved-name rejection (RFC 7591 error)", () => {
  it("returns invalid_client_metadata 400 for reserved names", () => {
    for (const name of [
      "ChatGPT",
      " chat gpt ",
      "ChatGPT\u200b",
      "ＣｈａｔＧＰＴ",
      "СhatGPT",
      "My Claude Helper",
      "Thingery",
    ]) {
      expectRejected(name);
    }
  });

  it("still registers legitimate names unchanged", () => {
    const reg = validateName("Inspector");
    expect(reg.client_name).toBe("Inspector");
    expect(reg.redirect_uris).toEqual(REDIRECT_URIS);
    expect(reg.client_uri).toBeNull();

    const withUri = validateClientRegistration({
      redirect_uris: REDIRECT_URIS,
      client_name: "Acme Tools",
      client_uri: "https://acme.example.com",
    });
    expect(withUri.client_name).toBe("Acme Tools");
    expect(withUri.client_uri).toBe("https://acme.example.com");
  });

  it("keeps client_name optional (absent still registers as null)", () => {
    const reg = validateClientRegistration({ redirect_uris: REDIRECT_URIS });
    expect(reg.client_name).toBeNull();
  });
});
