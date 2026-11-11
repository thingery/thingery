// THI-441 (spec THI-439 §6): page-render tests for the /wanted/:id detail
// page — the one wanted page a self-hosted server still renders, because MCP
// wanted tools return <PUBLIC_BASE_URL>/wanted/<id> links. In-process only:
// the data seam (src/wanted-feed.ts) is spied, no Postgres needed
// (item-page.test.ts pattern).
//
// The visual language is the contract under test: WANTED chip + budget as a
// RANGE ("€150–200"), never the for-sale single-price badge.

import { describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import * as feed from "../src/wanted-feed.js";
import type { WantedPublicVM } from "../src/wanted-feed.js";
import { wantedDetailPage } from "../src/web-pages.js";

const DAY = 24 * 60 * 60 * 1000;
// Skew timestamps inward (a hair past whole days) so floor/ceil day counts
// are stable against the few ms of clock movement during rendering.
const ago = (days: number) => new Date(Date.now() - days * DAY - 2000).toISOString();
const ahead = (days: number) => new Date(Date.now() + days * DAY - 2000).toISOString();

const wanted = (overrides: Partial<WantedPublicVM> = {}): WantedPublicVM => ({
  id: "22222222-2222-4222-8222-222222222201",
  title: "Nintendo Switch OLED",
  notes: "With dock and both Joy-Cons, small scratches fine.",
  category: "electronics",
  condition: "good",
  budget_min_cents: 15000,
  budget_max_cents: 20000,
  currency: "EUR",
  reference_images: [],
  created_at: ago(5),
  expires_at: ahead(25),
  status: "active",
  ...overrides,
});

function render(
  handler: (req: Request, res: Response) => Promise<void>,
  reqOverrides: Record<string, unknown>,
): Promise<{ html: string; status: number }> {
  return new Promise((resolve, reject) => {
    const captured = { html: "", status: 200 };
    const res = {
      status: vi.fn((code: number) => {
        captured.status = code;
        return res;
      }),
      send: vi.fn((html: string) => {
        captured.html = html;
        resolve(captured);
      }),
      set: vi.fn(() => res),
    } as unknown as Response;
    const req = { params: {}, query: {}, protocol: "https", get: () => "thingery.test", ...reqOverrides } as unknown as Request;
    handler(req, res).catch(reject);
  });
}

describe("wantedDetailPage — /wanted/:id", () => {
  it("renders the wanted item, budget range, and the respond_to_wanted agent CTA", async () => {
    const id = "22222222-2222-4222-8222-222222222201";
    vi.spyOn(feed, "getWanted").mockResolvedValue(wanted());
    const { html, status } = await render(wantedDetailPage, { params: { id } });
    expect(status).toBe(200);
    expect(html).toContain("Nintendo Switch OLED");
    expect(html).toContain("\u20ac150\u2013200");
    expect(html).toContain(`wanted_id ${id}`);
    expect(html).toContain("respond_to_wanted");
    // The legacy public pages are gone; only links that still resolve.
    expect(html).not.toContain("/chat.html");
    expect(html).not.toContain('href="/browse"');
    expect(html).not.toContain('href="/wanted"');
    expect(html).not.toContain("noindex");
  });

  it("noindexes expired wanteds and drops the respond CTA", async () => {
    vi.spyOn(feed, "getWanted").mockResolvedValue(wanted({ status: "expired", expires_at: ago(2), created_at: ago(32) }));
    const { html } = await render(wantedDetailPage, { params: { id: "22222222-2222-4222-8222-222222222201" } });
    expect(html).toContain("noindex");
    expect(html).toContain("ended");
    expect(html).not.toContain("respond_to_wanted");
  });

  it("renders the 404 shape for unknown ids — no existence oracle", async () => {
    vi.spyOn(feed, "getWanted").mockResolvedValue(null);
    const { html, status } = await render(wantedDetailPage, { params: { id: "33333333-3333-4333-8333-333333333301" } });
    expect(status).toBe(404);
    expect(html).toContain("Not found");
  });
});
