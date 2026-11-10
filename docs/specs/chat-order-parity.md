# Spec: website chat order parity (THI-562 work item 5)

Status: proposed (2026-11-10) · Owner: Architect · Review: standard (not a protected path — `src/chat.ts` only); Security eyes on the confirm-op gate extension.

## Problem

The `/chat` website assistant can search, list, and update items, but has
**zero** order tools: a buyer or seller who completes a sale on the website
chat hits a wall the moment money moves. The Phase 1 bar: chat either exposes
the completion flow or plainly states what it doesn't do. We do the former —
exposing is the product; a disclaimer is a placeholder.

## Context

- `src/chat.ts` defines chat-executable functions that call the **same
  service modules** the MCP tools use (`items.ts` etc.), with a write gate:
  mutating ops return `confirmation_required` and land only after the user
  confirms via `CHAT_CONFIRM_OP` (e.g. `sold`, `price=123`).
- Order services already exist and are MCP-agnostic: `listOrdersForAccount`,
  `getOrder` (order-flow), `cancelOrder`, `confirmPayment`, `recordTracking`,
  `confirmReceipt`, `openDispute`, `releaseFunds`, `shareShippingAddress`
  (`src/orders.ts`, `src/order-flow.ts`, `src/fulfillment.ts`).
- The system prompt's selling/buying sections end at listing and search.

## Proposed design

Add order functions to the chat manifest, mirroring the MCP tools' schemas
and validation (one code path per operation — chat wraps, never re-implements):

- Read: `my_orders` (role filter), `get_order` (address release rules apply
  unchanged via `shippingAddressForSeller`), `list_order_messages` (with work
  item 1).
- Buyer writes: `create_order` (returns `payment_url` — the chat shows it as
  a link to pay), `confirm_receipt`, `release_funds`, `open_dispute`,
  `share_shipping_address`, `cancel_order`.
- Seller writes: `confirm_payment` (off-platform), `record_tracking`,
  `buy_shipping_label` (with work item 2), `cancel_order`,
  `send_order_message`.

**Confirm gate.** Every mutating chat op goes through the existing hold-and-
confirm card. `CHAT_CONFIRM_OP` is extended with order verbs
(`receipt`, `release`, `dispute`, `cancel`, `tracking`, `address`,
`label`, `message`). `create_order` reserves an item and starts a payment
clock, so it confirms too (`order`). The card text shows the concrete effect
(e.g. "release €42.50 to the seller"), not just a verb.

**System prompt** grows a "Completing a sale" section: buyer pays via the
link, seller ships after `sold`, tracking arrives automatically, receipt
confirmation, dispute path, and that the assistant never asks for card
details (the payment link collects them).

**Parity statement.** The chat page footer gains one line, kept truthful by
this spec: the chat runs the full order flow for buyers and sellers; payments
happen on the Stripe payment page. When a capability is missing (e.g. label
purchase pre-keys), the assistant says so plainly instead of improvising —
the degraded-mode errors already read that way.

## Data model changes

None.

## API / MCP tool changes

None (chat functions are internal to the website; MCP registry untouched).

## Migration plan

None.

## Test plan

- Manifest parity: each order function's validation errors match the MCP
  tool's for the same input (table test).
- Confirm gate: every write op returns `confirmation_required` first; the
  extended `CHAT_CONFIRM_OP` accepts exactly the new verbs; unknown verbs
  still reject.
- Read paths: `get_order` in chat hides the address exactly when the MCP
  tool would.
- Prompt regression: chat fixture tests assert the new section and the
  no-card-details rule.

## Rollout + rollback

Feature-flagged by nothing — ships as part of the chat page; rollback is a
revert. The MCP path is unaffected at every step.

## Open questions

1. Should chat-initiated `create_order` be limited while Stripe is not live
   (payment mode off_platform only)? Proposal: follow the deployment config
   — `create_order` already fails closed when payments aren't configured;
   the chat relays that error verbatim. Confirm at review.

## Implementation steps (PR-sized)

1. **PR-A:** read tools (`my_orders`, `get_order`) + prompt section + parity
   footer line + tests.
2. **PR-B:** buyer writes (`create_order`, `confirm_receipt`,
   `release_funds`, `open_dispute`, `share_shipping_address`,
   `cancel_order`) behind the confirm gate + tests.
3. **PR-C:** seller writes (`confirm_payment`, `record_tracking`,
   `cancel_order`, `send_order_message`*, `buy_shipping_label`*) + tests.
   (*Lands with work items 1/2 — sequenced after their PRs.)
