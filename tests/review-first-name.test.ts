// F1 masking of the order-review first-name snapshot (THI-979, finding SR-5
// on PR #319): signup defaults display_name to the email local-part, so an
// unmasked snapshot can publish an email-derived handle on the public review
// list. Pure-function regression suite — the exact-match semantics here must
// stay identical to the seller-surface guard (tests/seller-summary.test.ts);
// the DB-backed write/read arms live in tests/order-reviews*.test.ts.

import { describe, expect, it } from "vitest";
import {
  emailLocalPart,
  maskEmailDerivedHandle,
  MASKED_BUYER_FIRST_NAME,
  MASKED_DISPLAY_NAME,
} from "../src/display-names.js";
import {
  buyerFirstName,
  buyerFirstNameSnapshot,
  MAX_BUYER_FIRST_NAME_CHARS,
} from "../src/reviews.js";

describe("emailLocalPart", () => {
  it("derives the exact string /signup stores as display_name when the name field is skipped", () => {
    expect(emailLocalPart("alice@example.test")).toBe("alice");
    expect(emailLocalPart("alice.smith+tag@mail.example.co.uk")).toBe("alice.smith+tag");
  });

  it("is undefined for a missing email (no handle, nothing to match)", () => {
    expect(emailLocalPart(null)).toBeUndefined();
    expect(emailLocalPart(undefined)).toBeUndefined();
  });
});

describe("maskEmailDerivedHandle (shared F1 rule, src/display-names.ts)", () => {
  it("substitutes the surface constant on an exact match", () => {
    expect(maskEmailDerivedHandle("alice", "alice", MASKED_DISPLAY_NAME)).toBe(MASKED_DISPLAY_NAME);
    expect(maskEmailDerivedHandle("alice", "alice", MASKED_BUYER_FIRST_NAME)).toBe(MASKED_BUYER_FIRST_NAME);
  });

  it("keeps the name when the email is missing or the handle is undefined", () => {
    expect(maskEmailDerivedHandle("alice", undefined, MASKED_DISPLAY_NAME)).toBe("alice");
  });

  it("matches exactly: case differences and partial matches are NOT masked (same as the seller guard)", () => {
    expect(maskEmailDerivedHandle("Alice", "alice", MASKED_DISPLAY_NAME)).toBe("Alice");
    expect(maskEmailDerivedHandle("alice2", "alice", MASKED_DISPLAY_NAME)).toBe("alice2");
    expect(maskEmailDerivedHandle("alice smith", "alice", MASKED_DISPLAY_NAME)).toBe("alice smith");
  });
});

describe("buyerFirstNameSnapshot (order-review write path, THI-979)", () => {
  it("masks a signup-default display_name (email local-part) to the buyer-shaped constant", () => {
    // Exactly what /signup derives: display_name = email.split("@")[0].
    expect(buyerFirstNameSnapshot("alice", "alice@example.test")).toBe(MASKED_BUYER_FIRST_NAME);
  });

  it("masks when the FIRST WORD is the handle, not only the whole display_name", () => {
    expect(buyerFirstNameSnapshot("alice smith", "alice@example.test")).toBe(MASKED_BUYER_FIRST_NAME);
    expect(buyerFirstNameSnapshot("  alice\tsmith  ", "alice@example.test")).toBe(MASKED_BUYER_FIRST_NAME);
  });

  it("masks a handle longer than the 40-char column cap (decided pre-cap, no prefix published)", () => {
    const longHandle = "very.long.email.local.part.that.exceeds.forty.chars";
    expect(longHandle.length).toBeGreaterThan(MAX_BUYER_FIRST_NAME_CHARS);
    expect(buyerFirstNameSnapshot(longHandle, `${longHandle}@example.test`)).toBe(MASKED_BUYER_FIRST_NAME);
  });

  it("keeps chosen names: case differences, partial matches and different names pass through", () => {
    expect(buyerFirstNameSnapshot("Alice", "alice@example.test")).toBe("Alice");
    expect(buyerFirstNameSnapshot("alice2", "alice@example.test")).toBe("alice2");
    expect(buyerFirstNameSnapshot("Alice Smith", "alice@example.test")).toBe("Alice");
    expect(buyerFirstNameSnapshot("Bruno Beta", "bruno-beta@example.test")).toBe("Bruno");
  });

  it("keeps the name when the email is null (nothing to match)", () => {
    expect(buyerFirstNameSnapshot("alice", null)).toBe("alice");
  });

  it("keeps the existing F6 projection for unmasked inputs (first token, 40-char cap, Buyer fallback)", () => {
    expect(buyerFirstNameSnapshot("Luca Bianchi", "luca@example.test")).toBe("Luca");
    expect(buyerFirstNameSnapshot("  ", "alice@example.test")).toBe("Buyer");
    const longFirstWord = "A".repeat(50);
    expect(buyerFirstNameSnapshot(`${longFirstWord} Bianchi`, "short@example.test")).toBe("A".repeat(40));
    expect(buyerFirstNameSnapshot("Luca", null)).toBe(buyerFirstName("Luca"));
  });
});
