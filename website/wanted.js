// Wanted listings UX (THI-441, spec THI-439 §6.2/§6.3) — CSP-safe static
// script for /wanted/new (the zero-result funnel form) and /wanted/mine
// (my-wanted management). Submits to the session-authed /api/wanted routes;
// while the backend sibling (THI-440) has not landed, those endpoints 404
// and the UI degrades honestly to the agent-lane fallback copy
// (create_wanted / my_wanted MCP tools). No inline handlers, no
// HTML-string sinks — DOM built with createElement/textContent only
// (same discipline as share.js / photos.js).
(() => {
  const STATUS = () => document.getElementById("wf-status");

  // --- shared formatting (JS twin of budgetRange in src/wanted-feed.ts) ---
  const SYMBOLS = { EUR: "\u20ac", USD: "$", GBP: "\u00a3" };
  const amount = (cents) => (cents % 100 === 0 ? String(cents / 100) : (cents / 100).toFixed(2));
  const budgetText = (min, max, currency) => {
    const sym = SYMBOLS[(currency || "EUR").toUpperCase()] || `${currency} `;
    if (min != null && max != null) return `${sym}${amount(min)}\u2013${amount(max)}`;
    if (max != null) return `up to ${sym}${amount(max)}`;
    if (min != null) return `${sym}${amount(min)}+`;
    return "budget open";
  };
  const DAY_MS = 24 * 60 * 60 * 1000;
  const daysLeft = (expiresAt) => Math.ceil((new Date(expiresAt).getTime() - Date.now()) / DAY_MS);
  // Final 7 days of an active wanted, or within the 30-day grace after
  // expiry (THI-439 \u00a73.2) — mirrors renewableNow() server-side.
  const renewable = (expiresAt) => {
    const ms = new Date(expiresAt).getTime() - Date.now();
    return ms > 0 ? ms <= 7 * DAY_MS : -ms <= 30 * DAY_MS;
  };

  const el = (tag, props = {}, ...children) => {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (key === "class") node.className = value;
      else if (key === "text") node.textContent = value;
      else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value);
    }
    for (const child of children) if (child != null) node.appendChild(child);
    return node;
  };

  const NOT_LANDED_FORM =
    "This form needs the wanted backend, which is landing shortly (THI-440). " +
    "Meanwhile your AI assistant can do this right now \u2014 ask it to call " +
    "create_wanted with the details you typed here.";
  const NOT_LANDED_MINE =
    "Managing wanted listings in the browser needs the wanted backend, which is " +
    "landing shortly (THI-440). Meanwhile ask your AI assistant to call my_wanted " +
    "\u2014 it lists, edits, expires and renews them for you.";

  const apiErrorText = async (res, notLanded) => {
    if (res.status === 401) return "Please log in first \u2014 your wanted listings live in your account.";
    if (res.status === 404 || res.status === 501) return notLanded;
    if (res.status === 429) return "That's a few too many saves in a short time \u2014 try again a little later.";
    let detail = "";
    try {
      const data = await res.json();
      detail = data.error || data.message || "";
    } catch {
      /* non-JSON body */
    }
    return detail ? `Couldn't save: ${detail}` : `Couldn't save (error ${res.status}). Please try again.`;
  };

  // ------------------------------------------------------------- /wanted/new
  const form = document.querySelector("[data-wanted-form]");
  if (form) {
    const eurosToCents = (raw) => {
      const value = String(raw ?? "").trim();
      if (!value) return null;
      const euros = Number.parseFloat(value);
      if (!Number.isFinite(euros) || euros < 0) return Number.NaN; // invalid
      return Math.round(euros * 100);
    };

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const status = STATUS();
      const title = form.elements.title.value.trim();
      const notes = form.elements.notes.value.trim();
      const category = form.elements.category.value || "other";
      const condition = form.elements.condition.value || null;
      const minCents = eurosToCents(form.elements.budget_min.value);
      const maxCents = eurosToCents(form.elements.budget_max.value);
      const refImage = form.elements.reference_image.value.trim();
      if (title.length < 3 || title.length > 200) {
        status.textContent = "Give it a title of 3\u2013200 characters.";
        return;
      }
      if (Number.isNaN(minCents) || Number.isNaN(maxCents)) {
        status.textContent = "Budget values must be plain numbers, e.g. 150.";
        return;
      }
      if (minCents != null && maxCents != null && minCents > maxCents) {
        status.textContent = "Budget \u201cfrom\u201d can't be higher than \u201cup to\u201d.";
        return;
      }
      if (refImage && !/^https?:\/\//i.test(refImage)) {
        status.textContent = "Reference image must be an http(s) link.";
        return;
      }
      const payload = {
        title,
        category,
        condition,
        budget_min_cents: minCents,
        budget_max_cents: maxCents,
        currency: "EUR",
        alert_me: form.elements.alert_me.checked,
      };
      if (notes) payload.notes = notes;
      if (refImage) payload.reference_images = [refImage];

      const submit = document.getElementById("wf-submit");
      submit.disabled = true;
      status.textContent = "Saving\u2026";
      try {
        const res = await fetch("/api/wanted", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (!res.ok) {
          status.textContent = await apiErrorText(res, NOT_LANDED_FORM);
          return;
        }
        const data = await res.json().catch(() => ({}));
        const wanted = data.wanted || {};
        form.replaceChildren(
          el("p", { class: "status-note", text: "Saved \u2014 sellers browsing the wanted board can see it now." }),
          el("p", {
            class: "meta",
            text: data.alert_saved === false ? "The alert could not be saved right now, but your wanted listing is live." : "We'll alert you when a matching listing appears.",
          }),
          el("p", {}, el("a", { href: "/wanted", text: "See it on the /wanted board \u2192" })),
          el("p", {}, el("a", { href: "/wanted/mine", text: "Manage my wanted listings \u2192" })),
        );
        if (wanted.id && history.replaceState) history.replaceState(null, "", `/wanted/${wanted.id}`);
      } catch {
        status.textContent = "Network hiccup \u2014 please try again.";
      } finally {
        submit.disabled = false;
      }
    });
  }

  // ------------------------------------------------------------ /wanted/mine
  const mineRoot = document.querySelector("[data-wanted-mine]");
  if (mineRoot) {
    const loginPrompt = () =>
      el(
        "p",
        { class: "meta" },
        el("a", { href: `/login.html?next=${encodeURIComponent("/wanted/mine")}`, text: "Log in" }),
        document.createTextNode(" to see and manage your wanted listings."),
      );

    const wantedCard = (w) => {
      const left = daysLeft(w.expires_at);
      const isExpired = w.status !== "active" || left <= 0;
      const freshText = isExpired
        ? `wanted \u00b7 expired${renewable(w.expires_at) ? " \u2014 renewable" : ""}`
        : `wanted \u00b7 expires in ${left} day${left === 1 ? "" : "s"}${left <= 7 ? " \u2014 expiring soon" : ""}`;
      const actions = [el("a", { href: `/wanted/${w.id}`, text: "view \u2192" })];
      if (!isExpired) {
        actions.push(el("button", { type: "button", text: "Edit", onclick: () => startEdit(w) }));
        actions.push(
          el("button", {
            type: "button",
            text: "Expire",
            onclick: async (event) => {
              const btn = event.currentTarget;
              btn.disabled = true;
              const res = await fetch(`/api/wanted/${w.id}/expire`, { method: "POST" }).catch(() => null);
              if (!res || !res.ok) {
                btn.disabled = false;
                note.textContent = res ? await apiErrorText(res, NOT_LANDED_MINE) : "Network hiccup \u2014 try again.";
                return;
              }
              load();
            },
          }),
        );
      }
      if (renewable(w.expires_at)) {
        actions.push(
          el("button", {
            type: "button",
            text: "Renew",
            onclick: async (event) => {
              const btn = event.currentTarget;
              btn.disabled = true;
              const res = await fetch(`/api/wanted/${w.id}/renew`, { method: "POST" }).catch(() => null);
              if (!res || !res.ok) {
                btn.disabled = false;
                note.textContent = res ? await apiErrorText(res, NOT_LANDED_MINE) : "Network hiccup \u2014 try again.";
                return;
              }
              load();
            },
          }),
        );
      }
      const note = el("p", { class: "status-note", role: "status" });
      const card = el(
        "div",
        { class: "card" },
        el("div", {}, el("strong", { text: w.title })),
        el("div", {}, el("span", { class: "wanted-budget", text: budgetText(w.budget_min_cents, w.budget_max_cents, w.currency) })),
        el("p", { class: `fresh${!isExpired && left <= 7 ? " expiring" : ""}`, text: freshText }),
        w.notes ? el("p", { class: "meta", text: w.notes }) : null,
        typeof w.response_count === "number" && w.response_count > 0
          ? el("p", {
              class: "meta",
              text:
                `${w.response_count} seller response${w.response_count === 1 ? "" : "s"}` +
                (w.unread_responses ? ` \u00b7 ${w.unread_responses} new` : ""),
            })
          : null,
        el("p", { class: "meta" }, ...actions),
        note,
      );

      const startEdit = (wanted) => {
        const field = (labelText, name, value, type) =>
          el("label", { text: `${labelText} ` }, el("input", { type: type || "text", name, value: value ?? "" }));
        const editForm = el(
          "form",
          { class: "wform" },
          field("Title", "title", wanted.title),
          el("label", { text: "Details " }, el("textarea", { name: "notes" }, document.createTextNode(wanted.notes || ""))),
          el("label", { text: "Budget from (\u20ac) " }, el("input", { type: "number", name: "budget_min", value: wanted.budget_min_cents != null ? wanted.budget_min_cents / 100 : "" })),
          el("label", { text: "Budget up to (\u20ac) " }, el("input", { type: "number", name: "budget_max", value: wanted.budget_max_cents != null ? wanted.budget_max_cents / 100 : "" })),
          el("button", { type: "submit", text: "Save changes" }),
          el("button", { type: "button", text: "Cancel", onclick: () => editForm.remove() }),
        );
        editForm.addEventListener("submit", async (event) => {
          event.preventDefault();
          const toCents = (raw) => {
            const value = String(raw ?? "").trim();
            if (!value) return null;
            const euros = Number.parseFloat(value);
            return Number.isFinite(euros) && euros >= 0 ? Math.round(euros * 100) : null;
          };
          const body = { title: editForm.elements.title.value.trim(), notes: editForm.elements.notes.value.trim() };
          if (body.title.length < 3 || body.title.length > 200) {
            note.textContent = "Title must be 3\u2013200 characters.";
            return;
          }
          const min = toCents(editForm.elements.budget_min.value);
          const max = toCents(editForm.elements.budget_max.value);
          if (min != null && max != null && min > max) {
            note.textContent = 'Budget "from" can\'t be higher than "up to".';
            return;
          }
          body.budget_min_cents = min;
          body.budget_max_cents = max;
          const res = await fetch(`/api/wanted/${wanted.id}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          }).catch(() => null);
          if (!res || !res.ok) {
            note.textContent = res ? await apiErrorText(res, NOT_LANDED_MINE) : "Network hiccup \u2014 try again.";
            return;
          }
          load();
        });
        card.appendChild(editForm);
      };

      return card;
    };

    const load = async () => {
      mineRoot.replaceChildren(el("p", { class: "meta", text: "Loading\u2026" }));
      const res = await fetch("/api/wanted/mine").catch(() => null);
      if (!res) {
        mineRoot.replaceChildren(el("p", { class: "meta", text: "Network hiccup \u2014 reload to try again." }));
        return;
      }
      if (res.status === 401) {
        mineRoot.replaceChildren(loginPrompt());
        return;
      }
      if (res.status === 404 || res.status === 501) {
        mineRoot.replaceChildren(el("p", { class: "meta", text: NOT_LANDED_MINE }));
        return;
      }
      if (!res.ok) {
        mineRoot.replaceChildren(el("p", { class: "meta", text: `Couldn't load your wanted listings (error ${res.status}).` }));
        return;
      }
      const data = await res.json().catch(() => ({ wanteds: [] }));
      const wanteds = data.wanteds || [];
      if (!wanteds.length) {
        mineRoot.replaceChildren(
          el("p", { class: "meta", text: "Nothing saved yet \u2014 what are you looking for?" }),
          el("p", {}, el("a", { href: "/wanted/new", text: "+ Save what you're looking for \u2192" })),
        );
        return;
      }
      mineRoot.replaceChildren(...wanteds.map(wantedCard));
    };

    load();
  }
})();
