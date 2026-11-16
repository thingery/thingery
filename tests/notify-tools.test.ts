// Notification inbox MCP tool (THI-760 plan Phase 2 / THI-780 PR 5):
// contract tests for list_notifications — registration, PROTECTED_TOOLS
// membership + anonymous refusal, recipient-scoping (cross-account reads
// impossible by construction), unread_only, limit/offset, unread_count.
// Handlers are called directly (repo convention).

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PROTECTED_TOOLS, registerTools } from "../src/tools.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schemaPath = path.resolve(__dirname, "..", "db", "schema.sql");
const connectionString =
  process.env.DATABASE_URL ?? "postgres://thingery:thingery@localhost:5432/thingery";

async function dbAvailable(): Promise<boolean> {
  const client = new pg.Client({ connectionString, connectionTimeoutMillis: 1500 });
  try {
    await client.connect();
    await client.end();
    return true;
  } catch {
    await client.end().catch(() => {});
    return false;
  }
}

const available = await dbAvailable();

type Handler = (args: Record<string, unknown>) => Promise<unknown>;
interface ToolResult {
  isError?: boolean;
  content?: { text?: string }[];
}

const parse = (result: unknown) => {
  const r = result as ToolResult;
  return { isError: r.isError === true, body: JSON.parse((r.content?.[0]?.text ?? "null") as string) };
};

describe.skipIf(!available)("list_notifications MCP tool (DB)", () => {
  let db: pg.Client;
  const runTag = crypto.randomBytes(4).toString("hex");
  let aId = "";
  let bId = "";

  const toolsFor = (sellerId: string | null) => {
    const handlers = new Map<string, Handler>();
    registerTools(
      {
        registerTool(name: string, _config: unknown, handler: Handler) {
          handlers.set(name, handler);
        },
      },
      { seller: sellerId ? ({ id: sellerId } as never) : null },
    );
    return handlers;
  };

  beforeAll(async () => {
    db = new pg.Client({ connectionString });
    await db.connect();
    await db.query(readFileSync(schemaPath, "utf8"));

    const a = `thi780t-${runTag}-a@example.test`;
    const b = `thi780t-${runTag}-b@example.test`;
    // Two separate inserts — a multi-row VALUES insert can't RETURN per-row
    // correlated ids portably, and a NULL recipient_id fails NOT NULL anyway.
    const insA = await db.query<{ id: string }>(
      "INSERT INTO sellers (email, password_hash, display_name) VALUES ($1, 'x', 'A') RETURNING id", [a],
    );
    const insB = await db.query<{ id: string }>(
      "INSERT INTO sellers (email, password_hash, display_name) VALUES ($1, 'x', 'B') RETURNING id", [b],
    );
    aId = insA.rows[0].id;
    bId = insB.rows[0].id;

    // Three notifications for A (two unread), one for B.
    const mk = async (recipient: string, type: string, read: boolean) =>
      db.query(
        `INSERT INTO notifications (recipient_id, event_type, role, payload, dedupe_key, read_at)
         VALUES ($1, $2, 'seller', $3::jsonb, $4, $5)`,
        [recipient, type, JSON.stringify({ item_title: "Vintage denim jacket", item_id: crypto.randomUUID() }),
         `thi780t:${crypto.randomUUID()}`, read ? new Date() : null],
      );
    await mk(aId, "seller.item_sold", false);
    await mk(aId, "seller.payouts_enabled", false);
    await mk(aId, "seller.item_taken_down", true);
    await mk(bId, "buyer.order_placed", false);
  });
  afterAll(async () => {
    await db.end().catch(() => {});
  });

  it("registers the tool, in PROTECTED_TOOLS, and refuses anonymous callers", async () => {
    expect(PROTECTED_TOOLS.has("list_notifications")).toBe(true);
    const anon = parse(await toolsFor(null).get("list_notifications")!({}));
    expect(anon.isError).toBe(true);
    expect(anon.body.error).toContain("unauthorized");
  });

  it("returns only the caller's notifications, newest first, with unread_count", async () => {
    const r = parse(await toolsFor(aId).get("list_notifications")!({}));
    expect(r.isError).toBe(false);
    expect(r.body.count).toBe(3);
    expect(r.body.unread_count).toBe(2);
    expect(r.body.notifications.every((n: { id: string }) => typeof n.id === "string")).toBe(true);
    const times = r.body.notifications.map((n: { created_at: string }) => Date.parse(n.created_at));
    expect([...times].sort((x, y) => y - x)).toEqual(times);
    // B's notification is never visible to A.
    expect(r.body.notifications.some((n: { recipient_id?: string }) => n.recipient_id === bId)).toBe(false);
    const b = parse(await toolsFor(bId).get("list_notifications")!({}));
    expect(b.body.count).toBe(1);
  });

  it("unread_only filters; limit/offset page", async () => {
    const unread = parse(await toolsFor(aId).get("list_notifications")!({ unread_only: true }));
    expect(unread.body.count).toBe(2);
    expect(unread.body.notifications.every((n: { read_at: string | null }) => n.read_at === null)).toBe(true);

    const page1 = parse(await toolsFor(aId).get("list_notifications")!({ limit: 2 }));
    expect(page1.body.count).toBe(2);
    const page2 = parse(await toolsFor(aId).get("list_notifications")!({ limit: 2, offset: 2 }));
    expect(page2.body.count).toBe(1);
    expect(page2.body.notifications[0].id).not.toBe(page1.body.notifications[0].id);
  });

  it("payload is the PII-free event facts", async () => {
    const r = parse(await toolsFor(aId).get("list_notifications")!({ unread_only: true }));
    const p = r.body.notifications[0].payload as Record<string, unknown>;
    expect(p.item_title).toBe("Vintage denim jacket");
    expect(JSON.stringify(p)).not.toContain("@");
  });
});
