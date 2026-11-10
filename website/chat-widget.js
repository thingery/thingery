// Floating assistant: a bubble bottom-right on every page except /chat.html.
// Clicking it opens a small panel over the page (the page stays usable).
// Only the panel's "open in full chat" button navigates to /chat.html, and
// the conversation goes with it through chat-store.js.
// Design: "Proposal: chat bubble on every page" on the brand canvas.
//
// Security: every node is built with createElement/textContent — no HTML
// strings (tests/website-security.test.ts). Assistant replies and listing
// titles are untrusted text and only ever land in textContent.
(function () {
  "use strict";

  var MAX_LABEL = 120;
  var ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

  // ------------------------------------------------------- pure helpers --
  // What the visitor is looking at, so the first question can be about
  // "this" without retyping it. Item and wanted pages mark their heading
  // with data-chat-subject (src/web-pages.ts); browse uses its ?q= query.
  // Returns null when the page has no subject.
  function pageContext(pathname, search, subject) {
    if (subject && ID_PATTERN.test(subject.id) && subject.title) {
      var title = subject.title.trim().slice(0, MAX_LABEL);
      if (subject.kind === "item") {
        return {
          key: "item:" + subject.id,
          label: title,
          prompt: 'The user is looking at the Thingery listing "' + title + '" (id ' + subject.id + ").",
        };
      }
      if (subject.kind === "wanted") {
        return {
          key: "wanted:" + subject.id,
          label: title,
          prompt: 'The user is looking at the Thingery wanted post "' + title + '" (wanted_id ' + subject.id + ").",
        };
      }
    }
    if (pathname === "/browse" && typeof URLSearchParams === "function") {
      var q = (new URLSearchParams(search).get("q") || "").trim().slice(0, MAX_LABEL);
      if (q) {
        return {
          key: "browse:" + q,
          label: '"' + q + '"',
          prompt: 'The user is browsing Thingery listings for "' + q + '".',
        };
      }
    }
    return null;
  }

  // The page context rides along once per subject: on the first message
  // about it, not on every turn (it stays in history after that).
  function outgoingMessage(text, context, lastContextKey) {
    if (!context || context.key === lastContextKey) return text;
    return "[Context: " + context.prompt + "]\n" + text;
  }

  function isChatPage(pathname) {
    return /^\/chat(\.html)?\/?$/.test(pathname);
  }

  globalThis.ThingeryChatWidget = {
    pageContext: pageContext,
    outgoingMessage: outgoingMessage,
    isChatPage: isChatPage,
  };

  if (typeof document === "undefined" || typeof location === "undefined") return;
  var store = globalThis.ThingeryChatStore;
  if (!store || isChatPage(location.pathname)) return;

  var t = globalThis.__thingeryT || function (key, fallback) { return fallback; };
  var i18n = globalThis.__thingeryI18N;

  // ------------------------------------------------------------ DOM bits --
  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  var SVG_NS = "http://www.w3.org/2000/svg";
  function icon(paths) {
    var svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    svg.setAttribute("class", "tcw-svg");
    paths.forEach(function (d) {
      var p = document.createElementNS(SVG_NS, "path");
      p.setAttribute("d", d);
      svg.appendChild(p);
    });
    return svg;
  }
  var ICON_CHAT = ["M4 5h16v11H9l-5 4Z"];
  var ICON_CLOSE = ["M6 6l12 12", "M18 6 6 18"];
  var ICON_EXPAND = ["M14 4h6v6", "M10 20H4v-6", "M20 4l-7 7", "M4 20l7-7"];

  function readSubject() {
    var h = document.querySelector("[data-chat-subject]");
    if (!h) return null;
    return {
      kind: h.getAttribute("data-chat-subject"),
      id: h.getAttribute("data-chat-id") || "",
      title: h.textContent || "",
    };
  }

  // --------------------------------------------------------------- state --
  var state = store.load();
  var context = pageContext(location.pathname, location.search, readSubject());
  var busy = false;

  var stylesheet = document.createElement("link");
  stylesheet.rel = "stylesheet";
  stylesheet.href = "/chat-widget.css";
  document.head.appendChild(stylesheet);

  var root = el("div", "tcw");
  var scrim = el("div", "tcw-scrim");
  scrim.hidden = true;

  var bubble = el("button", "tcw-bubble");
  bubble.type = "button";
  bubble.setAttribute("aria-controls", "tcw-panel");
  bubble.setAttribute("aria-expanded", "false");
  var bubbleIcon = el("span", "tcw-bubble-icon");
  var bubbleLabel = el("span", "tcw-bubble-label");
  bubble.append(bubbleIcon, bubbleLabel);

  var panel = el("section", "tcw-panel");
  panel.id = "tcw-panel";
  panel.hidden = true;

  var head = el("div", "tcw-head");
  var title = el("span", "tcw-title");
  var expand = el("a", "tcw-icon-btn");
  expand.href = "/chat.html";
  expand.appendChild(icon(ICON_EXPAND));
  var close = el("button", "tcw-icon-btn");
  close.type = "button";
  close.appendChild(icon(ICON_CLOSE));
  head.append(title, expand, close);

  var logBox = el("div", "tcw-log");
  logBox.setAttribute("aria-live", "polite");

  var chip = null;
  var chipLead = null;
  if (context) {
    chip = el("div", "tcw-chip");
    chipLead = el("span", "tcw-chip-lead");
    chip.append(chipLead, document.createTextNode(" · " + context.label));
  }

  var form = el("form", "tcw-form");
  var inputLabel = el("label", "tcw-sr-only");
  inputLabel.htmlFor = "tcw-message";
  var input = el("input", "tcw-input");
  input.id = "tcw-message";
  input.autocomplete = "off";
  input.maxLength = 3500; // leaves room for the context line under the 4000 cap
  var sendBtn = el("button", "tcw-send");
  sendBtn.type = "submit";
  form.append(inputLabel, input, sendBtn);

  panel.append(head, logBox, form);
  root.append(scrim, panel, bubble);
  document.body.appendChild(root);

  // ------------------------------------------------------------- strings --
  function applyStrings() {
    var open = !panel.hidden;
    bubbleIcon.replaceChildren(icon(open ? ICON_CLOSE : ICON_CHAT));
    bubbleLabel.textContent = context
      ? t("widget.askThis", "Ask about this")
      : t("widget.ask", "Ask the assistant");
    bubble.setAttribute("aria-label", open ? t("widget.close", "Close assistant") : bubbleLabel.textContent);
    panel.setAttribute("aria-label", t("widget.title", "Thingery assistant"));
    title.textContent = t("widget.title", "Thingery assistant");
    expand.setAttribute("aria-label", t("widget.expand", "Open in full chat"));
    expand.title = t("widget.expand", "Open in full chat");
    close.setAttribute("aria-label", t("widget.close", "Close assistant"));
    close.title = t("widget.close", "Close assistant");
    if (chipLead) chipLead.textContent = t("widget.lookingAt", "Looking at");
    inputLabel.textContent = t("widget.message", "Message");
    input.placeholder = context
      ? t("widget.placeholderThis", "Ask about this")
      : t("widget.placeholder", "Find or sell something");
    sendBtn.textContent = t("chat.send", "Send");
  }

  // ------------------------------------------------------------- the log --
  function scrollToEnd() {
    logBox.scrollTop = logBox.scrollHeight;
  }

  function addMessage(role, text) {
    logBox.appendChild(el("div", "tcw-msg tcw-" + role, text));
    scrollToEnd();
  }

  function renderLog() {
    var nodes = [];
    if (chip) nodes.push(chip);
    if (!state.log.length) {
      nodes.push(
        el(
          "div",
          "tcw-msg tcw-bot",
          context
            ? t("widget.welcomeThis", "Ask me anything about this — price, condition, how to buy it.")
            : t("widget.welcome", "Ask me to find something used, or tell me what you'd like to sell."),
        ),
      );
    }
    state.log.forEach(function (entry) {
      nodes.push(el("div", "tcw-msg tcw-" + entry.role, entry.text));
    });
    logBox.replaceChildren.apply(logBox, nodes);
    scrollToEnd();
  }

  // Same signed pending-op confirmation as the full chat (THI-108): the
  // server executes only the exact op the token signs.
  function addConfirmCard(confirm) {
    var card = el("div", "tcw-msg tcw-confirm");
    var q = el(
      "div",
      "tcw-confirm-q",
      (confirm.summary || t("chat.confirmFallback", "Apply this change")) +
        t("chat.confirmSuffix", " — are you sure?"),
    );
    var actions = el("div", "tcw-confirm-actions");
    var yes = el("button", "", t("chat.confirmYes", "Yes, do it"));
    yes.type = "button";
    var no = el("button", "", t("chat.confirmNo", "No, cancel"));
    no.type = "button";
    var settle = function () {
      yes.disabled = true;
      no.disabled = true;
    };
    yes.addEventListener("click", function () {
      settle();
      send("chat-confirm " + confirm.token, t("chat.confirmedNote", "(confirmed the pending change)"));
    });
    no.addEventListener("click", function () {
      settle();
      send("chat-decline " + confirm.token, t("chat.declinedNote", "(cancelled the pending change)"));
    });
    actions.append(yes, no);
    card.append(q, actions);
    logBox.appendChild(card);
    scrollToEnd();
  }

  // message: what the server gets; displayText: what the visitor sees.
  function send(message, displayText) {
    if (busy) return;
    busy = true;
    sendBtn.disabled = true;
    addMessage("user", displayText);
    var typing = el("div", "tcw-msg tcw-bot tcw-typing", "···");
    typing.setAttribute("role", "status");
    typing.setAttribute("aria-label", t("chat.thinking", "Assistant is thinking"));
    logBox.appendChild(typing);
    scrollToEnd();

    var ok = false;
    fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: message, history: state.history.slice(-store.MAX_HISTORY) }),
    })
      .then(function (res) {
        ok = res.ok;
        return res.json();
      })
      .then(function (data) {
        var reply;
        if (!ok) reply = "⚠️ " + (data.error || t("chat.errGeneric", "Something went wrong."));
        else if (typeof data.reply === "string" && data.reply) reply = data.reply;
        else if (data.reply && typeof data.reply.text === "string" && data.reply.text.trim()) reply = data.reply.text;
        else reply = t("chat.noReply", "(no reply)");
        typing.remove();
        addMessage("bot", reply);
        if (ok) {
          // History keeps what the server saw (context line included), the
          // log keeps what the visitor saw.
          state.history.push({ role: "user", content: message }, { role: "assistant", content: reply });
          if (context) state.contextKey = context.key;
        }
        state.log.push({ role: "user", text: displayText }, { role: "bot", text: reply });
        store.save(state);
        if (ok && data.reply && typeof data.reply === "object" && data.reply.confirm) {
          addConfirmCard(data.reply.confirm);
        }
      })
      .catch(function () {
        typing.remove();
        addMessage("bot", t("chat.errNetwork", "⚠️ Network error — please try again."));
      })
      .then(function () {
        busy = false;
        sendBtn.disabled = false;
        input.focus();
      });
  }

  // --------------------------------------------------------- open/close --
  function setOpen(open) {
    panel.hidden = !open;
    scrim.hidden = !open;
    root.classList.toggle("tcw-open", open);
    bubble.setAttribute("aria-expanded", open ? "true" : "false");
    applyStrings();
    if (open) {
      // Another tab of the same session may have moved the conversation on.
      state = store.load();
      renderLog();
      input.focus();
    } else {
      bubble.focus();
    }
  }

  bubble.addEventListener("click", function () {
    setOpen(panel.hidden);
  });
  close.addEventListener("click", function () {
    setOpen(false);
  });
  scrim.addEventListener("click", function () {
    setOpen(false);
  });
  panel.addEventListener("keydown", function (e) {
    if (e.key === "Escape") setOpen(false);
  });

  // A half-typed question goes along to the full chat as its prefill
  // (chat.js reads ?q=); the conversation itself is already in the store.
  expand.addEventListener("click", function () {
    var draft = input.value.trim();
    expand.href = draft ? "/chat.html?q=" + encodeURIComponent(draft.slice(0, 500)) : "/chat.html";
  });

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    var text = input.value.trim();
    if (!text || busy) return;
    input.value = "";
    send(outgoingMessage(text, context, state.contextKey), text);
  });

  if (i18n && typeof i18n.onchange === "function") {
    i18n.onchange(function () {
      applyStrings();
      if (!panel.hidden) renderLog();
    });
  }

  applyStrings();
})();
