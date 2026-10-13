// EasyPost Tracker registration (spec THI-3 rev 2 §5.2/§5.4; PR-5).
//
// record_tracking registers the carrier+code pair as an EasyPost tracker so
// status updates arrive as signed carrier webhooks (PR-7). The tracker id is
// stored on the order and is the PRIMARY webhook resolution key (F4:
// tracking codes collide — legitimately and maliciously — tracker ids don't).
//
// Degraded mode (§5.4): EASYPOST_API_KEY unset → createEasyPostTracker
// returns null and record_tracking still stores carrier + tracking_code.
// The state machine is complete without the carrier; the carrier only
// automates. Failures to register are non-fatal (event-logged; the seller
// can retry via a tracking correction, §2.3 #23).

import { envValue } from "./config.js";

export interface TrackerRef {
  id: string; // EasyPost tracker id ("trk_…"), unique per registration
}

export interface EasyPostOptions {
  apiKey?: string; // default: EASYPOST_API_KEY (empty = unset, F1)
  baseUrl?: string;
  fetchImpl?: typeof fetch; // test seam
}

/**
 * Registers a tracker; returns null in degraded mode (key unset).
 * Throws on a non-2xx response — callers treat registration as best-effort.
 */
export async function createEasyPostTracker(
  carrier: string,
  trackingCode: string,
  opts: EasyPostOptions = {},
): Promise<TrackerRef | null> {
  const apiKey = opts.apiKey ?? envValue("EASYPOST_API_KEY");
  if (apiKey === undefined) return null;

  const url = `${opts.baseUrl ?? "https://api.easypost.com"}/v2/trackers`;
  const res = await (opts.fetchImpl ?? fetch)(url, {
    method: "POST",
    headers: {
      // EasyPost HTTP basic auth: the API key is the username.
      Authorization: `Basic ${Buffer.from(`${apiKey}:`).toString("base64")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ tracker: { tracking_code: trackingCode, carrier } }),
  });
  if (!res.ok) {
    throw new Error(`easypost tracker registration failed: HTTP ${res.status}`);
  }
  const tracker = (await res.json()) as { id?: string };
  if (!tracker?.id) throw new Error("easypost tracker registration failed: no tracker id");
  return { id: tracker.id };
}
