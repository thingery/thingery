// Pure view helpers for the ChatGPT-plan settings slot (THI-193 PR-4).
// Kept free of DOM access so they unit-test DOM-less (same pattern as
// website/account-view.js). All copy here is fixed-string only: the OAuth
// callback's ?chatgpt= slug is mapped to known text — provider error text
// and token material never reach the browser (spec §3.2/§3.6).

/** First-connect modal dismissal is remembered locally (spec §3.6): the
 * welcome confirmation shows once per browser, not on every page view. */
export const CHATGPT_MODAL_DISMISSED_KEY = "chatgpt_plan_confirmed";

/** Slot visibility (spec §3.1/§3.6): the section renders only when the
 * status endpoint says `enabled: true`. A 404 (flag off) or any other
 * shape hides the slot entirely — flag off means zero UI footprint. */
export function chatgptSlotVisible(data) {
  return !!data && data.enabled === true;
}

/** Connected status line: the "Using ChatGPT plan" state plus the
 * connection's model and account fingerprint (metadata only — the status
 * endpoint never returns tokens or scopes). */
export function chatgptStatusText(data) {
  const model = data.model ? ` · model ${data.model}` : "";
  const fingerprint = data.fingerprint ? ` · fingerprint ${data.fingerprint}` : "";
  return `Using ChatGPT plan${model}${fingerprint}.`;
}

/** Fixed copy for each `?chatgpt=` callback banner slug. Unknown slugs
 * render nothing (no reflection of arbitrary query text); known slugs map
 * to friendly copy only. */
export function chatgptBanner(slug) {
  switch (slug) {
    case "connected":
      return { tone: "ok", text: "ChatGPT connected — the assistant now uses your ChatGPT plan." };
    case "declined":
      return { tone: "error", text: "Connection cancelled — nothing was changed." };
    case "plan_not_enabled":
      return {
        tone: "error",
        text: "ChatGPT plan usage wasn't approved, so no account was connected. Try again and approve plan usage when asked.",
      };
    case "error":
      return { tone: "error", text: "Something went wrong connecting your ChatGPT account — please try again." };
    default:
      return null;
  }
}

/** Has the first-connect welcome modal already been dismissed here?
 * localStorage can throw in private-browsing modes — unreadable means
 * "not dismissed yet" (the modal may repeat, which is the safe side). */
export function chatgptModalDismissed(storage) {
  try {
    return storage.getItem(CHATGPT_MODAL_DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

/** Remember the dismissal locally so the modal shows only once. */
export function rememberChatgptModal(storage) {
  try {
    storage.setItem(CHATGPT_MODAL_DISMISSED_KEY, "1");
  } catch {
    /* unreadable storage: the modal may show again — acceptable */
  }
}
