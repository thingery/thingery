// The production compose file passes env to the app one variable at a time, so
// a variable missing there never reaches the container even when it is set
// (same trap as tests/compose-shipping-env.test.ts). This pins the whole
// Stripe passthrough: THI-1681 shipped STRIPE_EVENT_DESTINATION_SECRET in
// .env.example + src/config.ts but missed the compose line, so the v2 webhook
// endpoint would have stayed a 503 stub on prod (caught in THI-1683).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const compose = readFileSync(new URL("../docker-compose.prod.yml", import.meta.url), "utf8");

const stripeEnvNames = [
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "STRIPE_WEBHOOK_SECRET_PREVIOUS",
  "STRIPE_CONNECT_WEBHOOK_SECRET",
  "STRIPE_CONNECT_WEBHOOK_SECRET_PREVIOUS",
  "STRIPE_EVENT_DESTINATION_SECRET",
  "STRIPE_EVENT_DESTINATION_SECRET_PREVIOUS",
  "ADMIN_API_KEY",
];

describe("docker-compose.prod.yml stripe env", () => {
  it.each(stripeEnvNames)("passes %s through to the app, empty by default", (name) => {
    expect(compose).toContain(`      ${name}: \${${name}:-}\n`);
  });
});
