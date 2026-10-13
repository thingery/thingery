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
    // Display name is untrusted text — build text nodes only, never HTML strings.
    $("account-link").replaceChildren("Logged in as ", data.seller.name, " · ", account);
  }
});

$("chat-form").onsubmit = async (e) => {
  e.preventDefault();
  const text = $("message").value.trim();
  if (!text) return;
  $("message").value = "";
  add("user", text);
  $("send").disabled = true;
  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: text, history }),
    });
    const data = await res.json();
    const reply = res.ok ? data.reply : `⚠️ ${data.error || "Something went wrong."}`;
    add("bot", reply);
    history.push({ role: "user", content: text }, { role: "assistant", content: reply });
  } catch (err) {
    add("bot", "⚠️ Network error — please try again.");
  } finally {
    $("send").disabled = false;
    $("message").focus();
  }
};
