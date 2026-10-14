// THI-54 regression tests: handler bugs on the website surface must yield a
// logged generic 500, never a hung response or a killed process, and the
// process-level unhandledRejection net must log stray rejections without
// dying. Mirrors the THI-42/THI-58 harnesses (tests/oauth-error-handling
// .test.ts, tests/api-error-handling.test.ts). No database required: the
// one DB-touching case fault-injects pool.query via vi.spyOn.

import { afterEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";
import { asyncHandler } from "../src/oauth.js";
import { browsePage, websiteErrorMiddleware } from "../src/web-pages.js";
import { installProcessSafetyNet, logUnhandledRejection } from "../src/process-safety.js";
import { pool } from "../src/db.js";

// The THI-54 failure mode: a bug that throws AFTER an await. Express 4 does
// not route this to any error handler on its own — without asyncHandler it
// is an unhandled rejection (hung response + process death on Node >= 15).
const buggyPage = async (_req: express.Request, res: express.Response): Promise<void> => {
  await Promise.resolve();
  throw new TypeError("simulated handler bug: secret internal detail");
};

// Mount-order-equivalent to src/index.ts: page routes wrapped in
// asyncHandler, terminal error middleware mounted after them.
function buildApp(): Server {
  const app = express();
  app.use(express.json({ limit: "256kb" }));
  app.get("/item/:id", asyncHandler(buggyPage));
  app.get("/browse", asyncHandler(browsePage));
  app.use(websiteErrorMiddleware);
  return app.listen(0);
}

async function withServer(fn: (base: () => string) => Promise<void>): Promise<void> {
  const server = buildApp();
  try {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    await fn(() => `http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/** Turns the Node >= 15 unhandled-rejection kill into an assertion value. */
async function captureUnhandled(fn: () => Promise<void>): Promise<unknown> {
  let unhandled: unknown = null;
  const listener = (e: unknown) => {
    unhandled = e;
  };
  process.on("unhandledRejection", listener);
  try {
    await fn();
  } finally {
    process.off("unhandledRejection", listener);
  }
  return unhandled;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("website surface fails as a logged generic 500 on handler bugs (THI-54)", () => {
  it("T1 async handler bug after an await: 500 generic HTML, logged, no unhandled rejection, server keeps serving", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await withServer(async (base) => {
      const unhandled = await captureUnhandled(async () => {
        const res = await fetch(`${base()}/item/06e5cc2a-1c56-4d7e-8dc7-4f0e0e51b3db`);
        expect(res.status).toBe(500);
        expect(res.headers.get("content-type")).toContain("text/html");
        expect(res.headers.get("cache-control")).toBe("no-store");
        const body = await res.text();
        expect(body).toContain("Something went wrong");
        // No error detail or stack in the response body (F5 discipline).
        expect(body).not.toContain("simulated handler bug");
        expect(body).not.toContain("secret internal detail");
      });
      expect(unhandled).toBeNull();
      // Fault logged server-side with method + path.
      expect(errSpy).toHaveBeenCalledWith(
        "website error:",
        "GET",
        "/item/06e5cc2a-1c56-4d7e-8dc7-4f0e0e51b3db",
        "->",
        500,
      );
      // The process survived: the very next request still gets a response.
      const res2 = await fetch(`${base()}/item/00000000-0000-0000-0000-000000000001`);
      expect(res2.status).toBe(500);
    });
  });

  it("T2 genuine body-parser fault on a page path keeps its 4xx (F4), not a 500", async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base()}/browse`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not json",
      });
      expect(res.status).toBe(400);
      const body = await res.text();
      expect(body).toContain("Request could not be read");
    });
  });

  it("T3 existing page degrade behavior unchanged: DB fault on /browse still renders the empty-results page", async () => {
    vi.spyOn(pool, "query").mockRejectedValue(new Error("simulated connection reset"));
    await withServer(async (base) => {
      const res = await fetch(`${base()}/browse`);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("No listings match");
    });
  });
});

describe("process-level unhandledRejection safety net (THI-54)", () => {
  it("T4 installs exactly one listener, idempotently, and logs stray rejections without throwing", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const before = process.listeners("unhandledRejection").length;
    installProcessSafetyNet();
    installProcessSafetyNet();
    expect(process.listeners("unhandledRejection").length).toBe(before + 1);
    expect(() => logUnhandledRejection(new Error("simulated stray rejection"))).not.toThrow();
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining("unhandledRejection"),
      expect.objectContaining({ message: "simulated stray rejection" }),
    );
  });
});
