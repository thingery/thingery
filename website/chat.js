// Chat assistant UI (loaded from /chat.html).
const $ = (id) => document.getElementById(id);
const history = [];

function add(role, text) {
  const div = document.createElement("div");
  div.className = `msg ${role}`;
  div.textContent = text;
  $("log").appendChild(div);
  $("log").scrollTop = $("log").scrollHeight;
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
  $("log").appendChild(card);
  $("log").scrollTop = $("log").scrollHeight;
}

// message: what goes to the server (may carry a confirmation token);
// displayText: what the user sees in the log and what stays in history.
async function send(message, displayText) {
  add("user", displayText);
  $("send").disabled = true;
  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message, history }),
    });
    const data = await res.json();
    // The reply is either a plain string (old shape) or { text, confirm? }.
    let reply;
    if (!res.ok) reply = `⚠️ ${data.error || "Something went wrong."}`;
    else if (typeof data.reply === "string") reply = data.reply;
    else if (data.reply && typeof data.reply.text === "string" && data.reply.text.trim()) reply = data.reply.text;
    else reply = "(no reply)";
    add("bot", reply);
    history.push({ role: "user", content: displayText }, { role: "assistant", content: reply });
    if (res.ok && data.reply && typeof data.reply === "object" && data.reply.confirm) {
      addConfirmCard(data.reply.confirm);
    }
  } catch (err) {
    add("bot", "⚠️ Network error — please try again.");
  } finally {
    $("send").disabled = false;
    $("message").focus();
  }
}

$("chat-form").onsubmit = async (e) => {
  e.preventDefault();
  const text = $("message").value.trim();
  if (!text) return;
  $("message").value = "";
  await send(text, text);
};
