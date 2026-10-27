// Chat assistant UI (loaded from /chat.html).
const $ = (id) => document.getElementById(id);
const history = [];

// THI-278: assistant replies reveal letter-by-letter (typewriter) unless the
// user prefers reduced motion, in which case the full text lands instantly.
// The probe is guarded so this file still executes under the DOM-shim unit
// test (website-security.test.ts), which has no window/matchMedia.
const reducedMotion = () =>
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// Stick-to-bottom autoscroll: follow the newest message only while the user
// sits near the bottom, so a long reveal never yanks someone who scrolled up
// to re-read — and resumes following once they come back down.
const nearBottom = (el) => el.scrollHeight - el.scrollTop - el.clientHeight <= 48;
const followIfNear = () => {
  const el = $("log");
  if (nearBottom(el)) el.scrollTop = el.scrollHeight;
};

// Messages live inside a centered column (#log is the scroll container);
// appending + pinning to bottom is one helper so every message type behaves
// the same (THI-278 polish).
const appendMsg = (el) => {
  // Fall back to #log itself if a cached pre-THI-278 chat.html (no #col)
  // is still in a user's tab: messages land uncentered but everything works.
  ($("col") || $("log")).appendChild(el);
  $("log").scrollTop = $("log").scrollHeight;
};

function add(role, text) {
  const div = document.createElement("div");
  div.className = `msg ${role}`;
  div.textContent = text;
  appendMsg(div);
}

// Thinking indicator shown while the turn runs (THI-278 polish). Returns the
// element so send() can remove it when the reply lands.
function addTyping() {
  const div = document.createElement("div");
  div.className = "msg bot typing";
  const dots = document.createElement("span");
  dots.className = "dots";
  dots.setAttribute("role", "status");
  dots.setAttribute("aria-label", "Assistant is thinking");
  dots.textContent = "···";
  div.appendChild(dots);
  appendMsg(div);
  return div;
}

// Assistant message with progressive letter-by-letter reveal. The rate is
// scaled to the message length (short replies feel brisk, long ones never
// crawl), the full text rides along visually-hidden for screen readers while
// the visible span catches up, and on completion the bubble collapses to a
// plain text node — so the final text is a single selectable/copyable run.
function addBot(text) {
  const div = document.createElement("div");
  div.className = "msg bot";
  if (reducedMotion() || !text) {
    div.textContent = text;
    appendMsg(div);
    return;
  }
  const sr = document.createElement("span");
  sr.className = "sr-only";
  sr.textContent = text;
  const shown = document.createElement("span");
  shown.className = "reveal";
  shown.setAttribute("aria-hidden", "true");
  div.append(sr, shown);
  div.classList.add("revealing");
  appendMsg(div);

  const duration = Math.min(2400, Math.max(500, text.length * 14)); // ms
  const start = Date.now();
  const step = () => {
    const chars = Math.min(text.length, Math.ceil((text.length * (Date.now() - start)) / duration));
    shown.textContent = text.slice(0, chars);
    followIfNear();
    if (chars < text.length) {
      requestAnimationFrame(step);
      return;
    }
    // Done: replace everything with the plain final text.
    div.classList.remove("revealing");
    div.textContent = text;
    followIfNear();
  };
  requestAnimationFrame(step);
}

fetch("/api/me").then(r => r.json()).then(data => {
  if (data.seller) {
    const account = document.createElement("a");
    account.href = "/login.html";
    account.textContent = "account";
    // THI-186 Phase 1: sellers can run this assistant on their own LLM key.
    const byo = document.createElement("a");
    byo.href = "/login.html";
    byo.textContent = "use your own model";
    // Display name is untrusted text — build text nodes only, never HTML strings.
    $("account-link").replaceChildren("Logged in as ", data.seller.name, " · ", byo, " · ", account);
  }
});

// THI-193 §3.6 (smallest viable version): when the status endpoint reports
// a connected ChatGPT plan, show the static "Using ChatGPT plan" indicator
// near the composer. A 404 (flag off), 401 (anonymous), or any error keeps
// it hidden — per-turn telemetry wiring comes later if ever needed.
fetch("/api/me/chatgpt")
  .then((r) => (r.ok ? r.json() : null))
  .then((data) => {
    if (data && data.enabled === true && data.connected === true) {
      $("plan-indicator").hidden = false;
    }
  })
  .catch(() => {});

// THI-108 (docs/security.md §6 H5.2): the server can attach a signed
// pending-op card to a reply when the assistant proposes a destructive
// update (mark sold/deleted, big price drop). Yes/No send the token back
// through the message field; the server executes only the exact op the
// token signs — never anything the assistant claims was confirmed.
function addConfirmCard(confirm) {
  const card = document.createElement("div");
  card.className = "msg confirm";
  const q = document.createElement("div");
  q.className = "confirm-q";
  q.textContent = `${confirm.summary || "Apply this change"} — are you sure?`;
  const actions = document.createElement("div");
  actions.className = "confirm-actions";
  const yes = document.createElement("button");
  yes.type = "button";
  yes.textContent = "Yes, do it";
  const no = document.createElement("button");
  no.type = "button";
  no.textContent = "No, cancel";
  const settle = () => { yes.disabled = true; no.disabled = true; };
  yes.onclick = () => {
    settle();
    send(`chat-confirm ${confirm.token}`, "(confirmed the pending change)");
  };
  no.onclick = () => {
    settle();
    send(`chat-decline ${confirm.token}`, "(cancelled the pending change)");
  };
  actions.append(yes, no);
  card.append(q, actions);
  appendMsg(card);
}

// message: what goes to the server (may carry a confirmation token);
// displayText: what the user sees in the log and what stays in history.
async function send(message, displayText) {
  add("user", displayText);
  $("send").disabled = true;
  const typing = addTyping();
  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message, history }),
    });
    const data = await res.json();
    // The reply is either a plain string (old shape) or { text, confirm? }.
    // Only real reply text gets the typewriter treatment — errors and
    // fallbacks land instantly so the user is never left waiting on them.
    let reply;
    let streamed = false;
    if (!res.ok) reply = `⚠️ ${data.error || "Something went wrong."}`;
    else if (typeof data.reply === "string" && data.reply) { reply = data.reply; streamed = true; }
    else if (data.reply && typeof data.reply.text === "string" && data.reply.text.trim()) { reply = data.reply.text; streamed = true; }
    else reply = "(no reply)";
    typing.remove();
    if (streamed) addBot(reply);
    else add("bot", reply);
    history.push({ role: "user", content: displayText }, { role: "assistant", content: reply });
    if (res.ok && data.reply && typeof data.reply === "object" && data.reply.confirm) {
      addConfirmCard(data.reply.confirm);
    }
  } catch (err) {
    typing.remove();
    add("bot", "⚠️ Network error — please try again.");
  } finally {
    $("send").disabled = false;
    $("message").focus();
  }
}

// THI-396: ?q= deep link — the item page's "Ask Thingery's assistant"
// button opens /chat.html?q=<prefilled question about the listing>.
// Prefill + focus only (no autosend): a share click must never spend a
// chat turn — the visitor presses Send.
if (typeof location !== "undefined" && typeof URLSearchParams === "function") {
  const prefill = new URLSearchParams(location.search).get("q");
  const input = $("message");
  if (prefill && input) {
    input.value = prefill.slice(0, 500);
    input.focus();
  }
}

$("chat-form").onsubmit = async (e) => {
  e.preventDefault();
  const text = $("message").value.trim();
  if (!text) return;
  $("message").value = "";
  await send(text, text);
};
