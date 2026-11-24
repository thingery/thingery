// Shipping provider registry — hands out the ONE provider instance per
// deployment. Spec docs/specs/shipping-provider-layer.md, THI-1246.
//
// Design (recorded, THI-1245): selection happens once at boot via
// SHIPPING_PROVIDER (validated in src/config.ts against
// AVAILABLE_SHIPPING_PROVIDERS; unrecognized values fail-closed with shipping
// disabled — this module only ever sees a valid id). Shipment/rate/tracker
// ids are provider-scoped, so label purchase and tracking always hit the
// same provider a deployment booted with; there is no runtime mixing.

import type { OrderFlowConfig } from "../config.js";
import type { ShippingProvider, ShippingProviderId } from "./provider.js";
import { EasyPostShippingProvider } from "./easypost-adapter.js";
import { ShippoShippingProvider } from "./shippo-adapter.js";

/** Adding a provider: implement ShippingProvider in src/shipping/, add the
 *  factory here, extend AVAILABLE_SHIPPING_PROVIDERS (src/config.ts), and add
 *  the provider's API key + webhook secret to the env allowlist. Nothing else
 *  changes — the order flow, ingest route, and tools are provider-agnostic. */
export function getShippingProvider(cfg: OrderFlowConfig): ShippingProvider {
  switch (cfg.shippingProvider) {
    case "easypost":
      return new EasyPostShippingProvider({
        webhookSecret: cfg.carrierWebhookSecret,
        webhookSecretPrevious: cfg.carrierWebhookSecretPrevious,
      });
    case "shippo":
      return new ShippoShippingProvider({
        webhookSecret: cfg.carrierWebhookSecret,
        webhookSecretPrevious: cfg.carrierWebhookSecretPrevious,
      });
  }
}

export type { ShippingProviderId };
