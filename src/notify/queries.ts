// THI-760 plan Phase 2 / THI-780 PR 5: notification inbox read for the MCP
// surface. Recipient is always the authenticated account — the query is
// recipient-scoped by construction, so cross-account reads are impossible
// (there is no id-based fetch to guess at). Payloads are the PII-free JSONB
// the fan-out stores (item title, amount, status — never addresses or
// counterparties), so they are safe to return to the owning agent.

import { pool } from "../db.js";

export interface NotificationRow {
  id: string;
  order_id: string | null;
  event_type: string;
  role: string;
  payload: Record<string, unknown>;
  read_at: Date | null;
  created_at: Date;
}

export interface NotificationList {
  notifications: NotificationRow[];
  unreadCount: number;
}

export async function listNotificationsForAccount(p: {
  accountId: string;
  unreadOnly: boolean;
  limit: number;
  offset: number;
}): Promise<NotificationList> {
  const rows = await pool.query<NotificationRow>(
    `SELECT id, order_id, event_type, role, payload, read_at, created_at
       FROM notifications
      WHERE recipient_id = $1 ${p.unreadOnly ? "AND read_at IS NULL" : ""}
      ORDER BY created_at DESC
      LIMIT $2 OFFSET $3`,
    [p.accountId, p.limit, p.offset],
  );
  const unread = await pool.query<{ c: string }>(
    "SELECT count(*)::text AS c FROM notifications WHERE recipient_id = $1 AND read_at IS NULL",
    [p.accountId],
  );
  return { notifications: rows.rows, unreadCount: Number(unread.rows[0]?.c ?? 0) };
}
