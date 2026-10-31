// Account page (login/signup, API key display) — loaded from /login.html.
// ES module: imports the OAuth login-hop next filter (spec THI-11 §2.5(4)).
// THI-114: the API key is show-once — revealed only right after
// signup/login/regeneration; /api/me no longer carries it.
import { safeNextTarget } from "./next-filter.js";
import { MASKED_KEY_HINT, MASKED_KEY_PLACEHOLDER, mcpConfigText } from "./account-view.js";
import {
  chatgptBanner,
  chatgptModalDismissed,
  chatgptSlotVisible,
  chatgptStatusText,
  rememberChatgptModal,
} from "./chatgpt-view.js";

let mode = "signup";
const $ = (id) => document.getElementById(id);
const nextParam = () => new URLSearchParams(location.search).get("next");
const resumeNext = () => {
  // OAuth login hop (spec THI-11 §2.5(4)): honor ?next= only when the
  // normalize-then-origin filter passes — never navigate off-site.
  const target = safeNextTarget(nextParam(), location.origin);
  if (target) { location.assign(target); return true; }
  return false;
};

// THI-441 (B3, spec THI-439 §6.4): seller demand strip. One read-only
// fetch of /wanted/demand.json (active wanteds per category); hidden while
// empty — including while the wanted backend (THI-440) has not landed, so
// the account page never shows stale or synthetic demand. Growth uses this
// line for seller outreach ("3 buyers want a Nintendo Switch …").
async function loadWantedDemand() {
  try {
    const res = await fetch("/wanted/demand.json");
    if (!res.ok) return;
    const data = await res.json();
    if (!data || !data.total || !Array.isArray(data.demand) || !data.demand.length) return;
    const chips = data.demand.map((row) => `${row.category}: ${row.count}`).join(" · ");
    const top = data.demand[0];
    $("wanted-demand").textContent =
      `${data.total} buyer${data.total === 1 ? "" : "s"} currently ${data.total === 1 ? "wants" : "want"} ` +
      `things like ${top.example_title} — ${chips}`;
    $("wanted-strip").hidden = false;
  } catch {
    /* strip stays hidden — demand is a bonus, never a blocker */
  }
}

async function checkSession() {
  const res = await fetch("/api/me");
  const data = await res.json();
  if (data.seller) {
    if (resumeNext()) return; // already logged in: straight back to the authorization request
    showDone(data.seller);
  }
}

function showDone(seller) {
  $("auth").hidden = true;
  $("done").hidden = false;
  $("welcome").textContent = `Logged in as ${seller.name}`;
  loadByo();
  loadChatgpt();
  loadWantedDemand();

  const mcpUrl = `${location.origin}/mcp`;
  $("mcp-url").textContent = mcpUrl;
  // Signup just handed us the key (show-once): reveal it and the ready
  // MCP config. THI-158: login no longer returns the key, so a plain
  // login or /api/me session gets the masked hint + regenerate path.
  if (seller.api_key) revealKey(seller.api_key, mcpUrl);
  else maskKey(mcpUrl);

  $("copy-config").onclick = () => {
    navigator.clipboard.writeText($("mcp-config").textContent);
    $("copy-config").textContent = "Copied ✓";
  };
  $("copy-url").onclick = () => {
    navigator.clipboard.writeText(mcpUrl);
    $("copy-url").textContent = "Copied ✓";
  };
}

function revealKey(apiKey, mcpUrl) {
  $("apikey").textContent = apiKey;
  $("mcp-config").textContent = mcpConfigText(mcpUrl, apiKey);
  $("key-note").textContent =
    "Keep it private — it publishes listings as you. Shown only once; regenerate to view or rotate it later.";
}

function maskKey(mcpUrl) {
  $("apikey").textContent = MASKED_KEY_HINT;
  $("mcp-config").textContent = mcpConfigText(mcpUrl, MASKED_KEY_PLACEHOLDER);
  $("key-note").textContent =
    "Keep it private — it publishes listings as you. It is shown only when created or regenerated.";
}

$("regen").onclick = async () => {
  $("key-error").textContent = "";
  $("regen").disabled = true;
  try {
    const res = await fetch("/api/me/api-key", { method: "POST" });
    const data = await res.json();
    if (!res.ok) {
      $("key-error").textContent = data.error || "Could not regenerate the key.";
      return;
    }
    revealKey(data.api_key, `${location.origin}/mcp`); // new show-once moment
  } finally {
    $("regen").disabled = false;
  }
};

$("mode").onclick = (e) => {
  e.preventDefault();
  mode = mode === "signup" ? "login" : "signup";
  $("form-title").textContent = mode === "signup" ? "Create your account" : "Log in";
  $("submit").textContent = mode === "signup" ? "Sign up" : "Log in";
  $("mode").textContent = mode === "signup"
    ? "I already have an account — log in"
    : "I need to create an account";
  $("name").parentElement.style.display = mode === "signup" ? "" : "none";
  $("error").textContent = "";
};

$("form").onsubmit = async (e) => {
  e.preventDefault();
  $("error").textContent = "";
  const body = { email: $("email").value.trim(), password: $("password").value };
  if (mode === "signup" && $("name").value.trim()) body.name = $("name").value.trim();
  const res = await fetch(`/api/${mode}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) { $("error").textContent = data.error || "Something went wrong."; return; }
  if (resumeNext()) return; // signup mode carries next too — new users can sign up mid-flow
  showDone(data.seller);
};

$("logout").onclick = async (e) => {
  e.preventDefault();
  await fetch("/api/logout", { method: "POST" });
  location.reload();
};

// --- bring-your-own LLM key (spec THI-186 Phase 1 / THI-189) ---------------
// GET returns metadata only (label, model, base URL, fingerprint) — the key
// itself never comes back to the browser after the save round-trip.

function byoForm(show) {
  $("byo-form").hidden = !show;
  if (show) $("byo-key").focus();
}

function renderByo(data) {
  if (!data.byo_enabled) {
    $("byo-status").textContent = "Not available on this server — the assistant runs on Thingery's key.";
    byoForm(false);
    return;
  }
  if (data.credential) {
    const c = data.credential;
    const where = c.base_url ? ` · ${c.base_url}` : "";
    $("byo-status").textContent =
      `Using your key: ${c.label || "saved key"} · ${c.model}${where} (fingerprint ${c.key_fingerprint}).`;
    $("byo-remove").hidden = false;
    byoForm(true); // stays open for rotate; key field starts empty
    $("byo-model").value = c.model;
    $("byo-base").value = c.base_url || "";
    $("byo-label").value = c.label || "";
  } else {
    $("byo-status").textContent = "Not set — the assistant runs on Thingery's key.";
    $("byo-remove").hidden = true;
    byoForm(true);
  }
}

async function loadByo() {
  try {
    const res = await fetch("/api/me/llm-credential");
    if (!res.ok) return; // 401 mid-session etc. — leave the section blank
    renderByo(await res.json());
  } catch {
    /* offline: leave blank */
  }
}

$("byo-form").onsubmit = async (e) => {
  e.preventDefault();
  $("byo-error").textContent = "";
  $("byo-save").disabled = true;
  $("byo-save").textContent = "Verifying…";
  try {
    const res = await fetch("/api/me/llm-credential", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        api_key: $("byo-key").value.trim(),
        model: $("byo-model").value.trim(),
        base_url: $("byo-base").value.trim() || undefined,
        label: $("byo-label").value.trim() || undefined,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      $("byo-error").textContent = data.error || "Could not save the key.";
      return;
    }
    $("byo-key").value = ""; // never keep the plaintext in the form
    renderByo({ byo_enabled: true, credential: data.credential });
  } finally {
    $("byo-save").disabled = false;
    $("byo-save").textContent = "Save & verify";
  }
};

$("byo-remove").onclick = async () => {
  $("byo-error").textContent = "";
  $("byo-remove").disabled = true;
  try {
    const res = await fetch("/api/me/llm-credential", { method: "DELETE" });
    if (res.ok) {
      $("byo-key").value = "";
      renderByo({ byo_enabled: true, credential: null });
    } else {
      const data = await res.json().catch(() => ({}));
      $("byo-error").textContent = data.error || "Could not remove the key.";
    }
  } finally {
    $("byo-remove").disabled = false;
  }
};

// --- ChatGPT plan connection (spec THI-193 §3.6, PR-4) ---------------------
// Slot gated by GET /api/me/chatgpt: a 404 (flag off) or enabled:false keeps
// the section hidden — flag off means zero UI footprint on this page. The
// status response is metadata only (fingerprint/model), so nothing here can
// surface token material (it never reaches the browser at all).

function renderChatgpt(data) {
  if (!chatgptSlotVisible(data)) return;
  $("chatgpt").hidden = false;
  const connected = data.connected === true;
  $("chatgpt-connect").hidden = connected;
  $("chatgpt-usage").hidden = !connected;
  $("chatgpt-disconnect").hidden = !connected;
  $("chatgpt-status").textContent = connected
    ? chatgptStatusText(data)
    : "Not connected — the assistant runs on Thingery's key or your own key above.";
}

async function loadChatgpt() {
  try {
    const res = await fetch("/api/me/chatgpt");
    if (!res.ok) return; // 404 flag off / 401 mid-session: slot stays hidden
    const data = await res.json();
    renderChatgpt(data);
    // First-connect welcome modal (OpenAI UX guidelines): shown once per
    // browser while connected — the dismissal is remembered locally.
    if (data.connected === true && !chatgptModalDismissed(localStorage)) {
      $("chatgpt-modal-overlay").hidden = false;
    }
  } catch {
    /* offline: leave hidden */
  }
}

$("chatgpt-modal-ok").onclick = () => {
  rememberChatgptModal(localStorage);
  $("chatgpt-modal-overlay").hidden = true;
};

// Callback banner from ?chatgpt=<slug> (fixed copy from chatgpt-view.js):
// the slug is never reflected as text; unknown values render nothing.
function showChatgptBanner() {
  const params = new URLSearchParams(location.search);
  const banner = chatgptBanner(params.get("chatgpt"));
  if (!banner) return;
  const el = $("chatgpt-banner");
  el.hidden = false;
  el.className = banner.tone === "ok" ? "" : "error";
  el.textContent = banner.text;
  // Drop the slug so a refresh doesn't replay the banner; keep other params.
  params.delete("chatgpt");
  const qs = params.toString();
  history.replaceState(null, "", qs ? `${location.pathname}?${qs}` : location.pathname);
}

$("chatgpt-disconnect").onclick = async () => {
  if (!confirm("Disconnect your ChatGPT plan? The assistant will stop using it.")) return;
  $("chatgpt-error").textContent = "";
  $("chatgpt-disconnect").disabled = true;
  try {
    const res = await fetch("/api/me/chatgpt", { method: "DELETE" });
    if (res.ok) {
      const data = await res.json().catch(() => ({}));
      renderChatgpt({ enabled: true, connected: false, fingerprint: null, model: null });
      // Server-side revocation is best-effort: if it couldn't be confirmed,
      // the seller should also remove the app on the ChatGPT side.
      if (data.revocation_unconfirmed) {
        $("chatgpt-error").textContent =
          "Disconnected here. To be safe, also remove Thingery in ChatGPT → Settings → Connections.";
      }
    } else {
      const data = await res.json().catch(() => ({}));
      $("chatgpt-error").textContent = data.error || "Could not disconnect.";
    }
  } finally {
    $("chatgpt-disconnect").disabled = false;
  }
};

showChatgptBanner();
checkSession();
