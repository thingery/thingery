// Shared F1 display-name masking (spec docs/specs/order-reads-and-party-names.md
// rev 2 §Display names, SR-1) — the one home for the exact-match rule that
// keeps email-derived handles off public surfaces.
//
// Signup names a new account after the email local-part (src/routes.ts
// /signup → email.split("@")[0]), so a raw display_name can be an
// email-derived handle. Any surface that publishes an account name masks
// through maskEmailDerivedHandle: one rule, one comparison, no per-surface
// drift. Extracted from sellerToPublic (src/sellers.ts) for THI-979, whose
// order-review snapshot needed the same rule with a buyer-shaped constant.
//
// This module imports nothing from the app on purpose: src/orders.ts
// imports src/reviews.ts and src/sellers.ts imports src/orders.ts, so a
// helper parked on either side of that chain would sit on an import cycle.

/** Seller-surface constant (THI-923): what a signup-default display_name
 *  renders as on seller profiles and the item-page seller card. */
export const MASKED_DISPLAY_NAME = "Thingery seller";

/** Order-review constant (THI-979): what a signup-default first-name
 *  snapshot renders as on the public review meta line —
 *  "A Thingery buyer · ★★★★☆ · Film camera". Within the order_reviews
 *  buyer_first_name 1–40 CHECK. */
export const MASKED_BUYER_FIRST_NAME = "A Thingery buyer";

/** The email-derived handle: the exact string /signup stores as display_name
 *  when the name field is skipped. Mask input only — callers must never
 *  serialize it. */
export function emailLocalPart(email: string | null | undefined): string | undefined {
  return email == null ? undefined : email.split("@")[0];
}

/** F1 exact-match mask, shared by every surface that publishes an account
 *  name. Returns `masked` when `name` exactly equals `handle` —
 *  case-sensitive, the comparison sellerToPublic has always applied;
 *  deliberately-chosen names that happen to equal the handle are masked too
 *  (accepted over-blocking for a public surface). `masked` is per-surface:
 *  MASKED_DISPLAY_NAME on profiles, MASKED_BUYER_FIRST_NAME on reviews. */
export function maskEmailDerivedHandle(
  name: string,
  handle: string | undefined,
  masked: string,
): string {
  return handle !== undefined && name === handle ? masked : name;
}
