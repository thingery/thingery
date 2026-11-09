// What the two wanted write surfaces share — /api/wanted* (src/routes.ts) and
// the MCP account tools (src/tools.ts): input shapes, the hourly write bucket
// and the create + alert sequence. Caps, quotas, contact scrub and ownership
// stay in src/wanted.ts. This is a separate module because it imports
// intents.ts, and wanted.ts must stay a leaf (items.ts imports it).

import { z } from "zod";
import { CONDITIONS } from "./db.js";
import { saveIntent, IntentLimitError } from "./intents.js";
import { RateLimiter } from "./rate-limit.js";
import { createWanted, type WantedRow } from "./wanted.js";

/** One bucket across both surfaces, so a buyer cannot double the allowance by
 *  mixing browser and MCP writes. It is also the only limit on expire and
 *  renew, which consume no daily quota. */
export const wantedWriteLimiter = new RateLimiter(20, 60 * 60_000); // 20 wanted writes per seller per hour (THI-439 §6.3)

const title = z.string().min(3).max(200).describe("What the buyer is looking for, e.g. 'Nintendo Switch OLED'");
const notes = z.string().max(2000).optional().describe("Details for sellers. No contact details: they are rejected");
const budgetCents = z.number().int().min(0).nullable().optional().describe("Integer cents; null means no bound");

export const wantedCreateShape = {
  title,
  notes,
  category: z.string().min(2).max(40).optional().describe("Lowercase slug; call describe_category for the list"),
  condition: z.enum(CONDITIONS).optional(),
  budget_min_cents: budgetCents,
  budget_max_cents: budgetCents,
  currency: z.string().length(3).optional().describe("ISO 4217 code, default EUR"),
  reference_images: z.array(z.string().url().max(2048).refine(
    (v) => /^https?:\/\//i.test(v),
    "reference image URLs must be http(s)",
  )).max(3).optional().describe("Up to 3 image URLs (http/https only, max 2048 chars each)"),
  // Dual-save (THI-437 §4 step 3): a wanted also saves a buyer alert intent
  // unless the buyer opts out. Default on.
  alert_me: z.boolean().optional().describe("Also save a buyer alert for this search (default true)"),
};

export const wantedEditShape = {
  title: title.optional(),
  notes,
  budget_min_cents: budgetCents,
  budget_max_cents: budgetCents,
};

export const wantedCreateSchema = z.object(wantedCreateShape);
export type WantedCreateRequest = z.infer<typeof wantedCreateSchema>;

/** Creates the wanted, then dual-saves its alert intent unless opted out.
 *  ANY intent failure never fails the wanted (B6 R3, THI-459): the row
 *  already exists, so rethrowing would report failure after the create and a
 *  client retry would burn another daily-create slot. The buyer keeps the
 *  listing and alertSaved says the alert could not be saved. Unexpected
 *  errors are logged (quota rejections are not: saveIntent logs its own
 *  rejected events). */
export async function createWantedWithAlert(
  buyerId: string,
  { alert_me: alertMe, ...request }: WantedCreateRequest,
): Promise<{ wanted: WantedRow; alertSaved: boolean }> {
  const wanted = await createWanted(buyerId, {
    ...request,
    budget_min_cents: request.budget_min_cents ?? null,
    budget_max_cents: request.budget_max_cents ?? null,
  });
  if (alertMe === false) return { wanted, alertSaved: false };
  try {
    await saveIntent(buyerId, {
      q: request.title,
      category: request.category,
      condition: request.condition ?? undefined,
      min_price_cents: request.budget_min_cents ?? undefined,
      max_price_cents: request.budget_max_cents ?? undefined,
      currency: request.currency,
    });
    return { wanted, alertSaved: true };
  } catch (e) {
    if (!(e instanceof IntentLimitError)) {
      console.error("dual-save saveIntent failed (wanted unaffected)", e);
    }
    return { wanted, alertSaved: false };
  }
}
