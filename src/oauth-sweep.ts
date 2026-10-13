// OAuth retention sweeps (spec THI-11 §4.5, F6): six bounded, idempotent
// DELETE rules run at boot and hourly. They mirror the order-sweep wiring
// (THI-10 PR 8 has not landed when this ships — if it lands first, these
// rules move into that harness unchanged).

import { pool } from "./db.js";

/** Rule 1: authorization codes live ≤ 60 s; anything older than 1 h is
 * consumed, expired or abandoned — delete regardless of state. */
const RULES: { name: string; sql: string }[] = [
  {
    name: "codes_retention",
    sql: `DELETE FROM oauth_codes WHERE created_at < now() - interval '1 hour'`,
  },
  {
    name: "access_tokens_retention",
    sql: `DELETE FROM oauth_tokens WHERE kind = 'access' AND expires_at < now() - interval '24 hours'`,
  },
  {
    name: "refresh_tokens_retention",
    sql: `DELETE FROM oauth_tokens WHERE kind = 'refresh' AND greatest(coalesce(revoked_at, expires_at)) < now() - interval '30 days'`,
  },
  {
    name: "unauthorized_clients_retention",
    sql: `DELETE FROM oauth_clients WHERE authorized_at IS NULL AND created_at < now() - interval '7 days'`,
  },
  {
    name: "revoked_grants_retention",
    sql: `DELETE FROM oauth_grants WHERE revoked_at < now() - interval '90 days'
            AND NOT EXISTS (SELECT 1 FROM oauth_tokens t WHERE t.grant_id = oauth_grants.id AND t.revoked_at IS NULL)`,
  },
  {
    name: "orphaned_clients_retention",
    sql: `DELETE FROM oauth_clients WHERE authorized_at < now() - interval '180 days'
            AND NOT EXISTS (SELECT 1 FROM oauth_grants g WHERE g.client_id = oauth_clients.client_id)`,
  },
];

/** Runs every rule once. Bounded, idempotent, safe at boot and to re-run;
 * a failing rule logs and does not stop the others. */
export async function runOauthSweeps(): Promise<void> {
  for (const rule of RULES) {
    try {
      await pool.query(rule.sql);
    } catch (e) {
      console.error(JSON.stringify({ sweep_error: rule.name, message: (e as Error).message }));
    }
  }
}

/** Boot run + hourly interval (unref'd: never keeps the process alive). */
export function startOauthSweepTimer(): void {
  runOauthSweeps().catch(() => {});
  const timer = setInterval(() => {
    runOauthSweeps().catch(() => {});
  }, 60 * 60 * 1000);
  timer.unref();
}
