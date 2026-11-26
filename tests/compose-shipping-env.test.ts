// The production compose file passes env to the app one variable at a time, so
// a variable missing there never reaches the container even when it is set.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SHIPPING_PROVIDER_IDS } from "../src/shipping/provider.js";

const compose = readFileSync(new URL("../docker-compose.prod.yml", import.meta.url), "utf8");

const shippingEnvNames = [
  "SHIPPING_PROVIDER",
  ...SHIPPING_PROVIDER_IDS.flatMap((id) => {
    const prefix = id.toUpperCase();
    return [`${prefix}_API_KEY`, `${prefix}_WEBHOOK_SECRET`, `${prefix}_WEBHOOK_SECRET_PREVIOUS`];
  }),
];

describe("docker-compose.prod.yml shipping env", () => {
  it.each(shippingEnvNames)("passes %s through to the app, empty by default", (name) => {
    expect(compose).toContain(`      ${name}: \${${name}:-}\n`);
  });
});
