// Persistent assistant chat history per signed-in account.
// One continuous conversation per seller, bounded to MAX_STORED_CHAT_MESSAGES
// rows so storage stays compact. Confirmation tokens are never stored.

import { pool } from "./db.js";

export const MAX_STORED_CHAT_MESSAGES = 80;
export const MAX_STORED_CONTENT_LENGTH = 8000;

export interface StoredChatMessage {
  id: number;
  role: "user" | "assistant";
  content: string;
  tools: string[];
  suggestions: string[];
  created_at: string;
}

interface ChatMessageRow {
  id: string;
  role: "user" | "assistant";
  content: string;
  tools: string[] | null;
  suggestions: string[] | null;
  created_at: Date;
}

/** Strips signed confirmation tokens before persisting user messages. */
export function normalizeStoredUserMessage(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith("chat-confirm ")) return "(confirmed the pending change)";
  if (trimmed.startsWith("chat-decline ")) return "(cancelled the pending change)";
  return trimmed.slice(0, MAX_STORED_CONTENT_LENGTH);
}

/** Normalizes assistant reply text to fit the stored column bounds. */
export function normalizeStoredAssistantMessage(raw: string): string {
  return raw.trim().slice(0, MAX_STORED_CONTENT_LENGTH);
}

export async function loadChatHistory(
  sellerId: string,
  limit = MAX_STORED_CHAT_MESSAGES,
): Promise<StoredChatMessage[]> {
  const bounded = Math.min(Math.max(1, Math.trunc(limit)), MAX_STORED_CHAT_MESSAGES);
  const { rows } = await pool.query<ChatMessageRow>(
    `SELECT id::text AS id, role, content, tools, suggestions, created_at
       FROM chat_messages
      WHERE seller_id = $1
      ORDER BY id DESC
      LIMIT $2`,
    [sellerId, bounded],
  );
  return rows.reverse().map((row) => ({
    id: Number(row.id),
    role: row.role,
    content: row.content,
    tools: row.tools ?? [],
    suggestions: row.suggestions ?? [],
    created_at: row.created_at.toISOString(),
  }));
}

export async function appendChatTurn(
  sellerId: string,
  turn: {
    userContent: string;
    assistantContent: string;
    tools?: readonly string[];
    suggestions?: readonly string[];
  },
): Promise<void> {
  const userContent = normalizeStoredUserMessage(turn.userContent);
  const assistantContent = normalizeStoredAssistantMessage(turn.assistantContent);
  if (!userContent || !assistantContent) return;

  const tools = (turn.tools ?? []).filter((t) => typeof t === "string" && t.length > 0).slice(0, 12);
  const suggestions = (turn.suggestions ?? [])
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .slice(0, 3);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO chat_messages (seller_id, role, content)
       VALUES ($1, 'user', $2)`,
      [sellerId, userContent],
    );
    await client.query(
      `INSERT INTO chat_messages (seller_id, role, content, tools, suggestions)
       VALUES ($1, 'assistant', $2, $3::text[], $4::text[])`,
      [sellerId, assistantContent, tools, suggestions],
    );
    await client.query(
      `DELETE FROM chat_messages
        WHERE seller_id = $1
          AND id NOT IN (
            SELECT id FROM chat_messages
             WHERE seller_id = $1
             ORDER BY id DESC
             LIMIT $2
          )`,
      [sellerId, MAX_STORED_CHAT_MESSAGES],
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export async function clearChatHistory(sellerId: string): Promise<number> {
  const result = await pool.query("DELETE FROM chat_messages WHERE seller_id = $1", [sellerId]);
  return result.rowCount ?? 0;
}
