// THI-389 homepage inline demo: real search from the homepage, no signup.
// Progressive enhancement — the form's no-JS fallback is a normal GET to
// /browse (same ?q= parameter), so search works even with scripts off.
// Results come from /search.json (read-only feed view, src/home-search.ts).
// Security: like every website/ script (THI gh#8 rule), rendering uses DOM
// text nodes only — no HTML-string sinks — because item titles are
// user-authored text.
(function () {
  var form = document.getElementById("demo-search");
  var input = document.getElementById("demo-q");
  var results = document.getElementById("demo-results");
  if (!form || !input || !results) return;

  function el(tag, cls) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    return node;
  }
  function link(href, text, cls) {
    var a = el("a", cls);
    a.href = href;
    a.textContent = text;
    return a;
  }
  // results := <p class="empty">…parts (strings or nodes)…</p>
  function note(parts) {
    var p = el("p", "empty");
    parts.forEach(function (part) {
      if (typeof part === "string") p.appendChild(document.createTextNode(part));
      else p.appendChild(part);
    });
    results.replaceChildren(p);
  }

  function money(cents, currency) {
    return (cents / 100).toLocaleString("en-IE", { minimumFractionDigits: 2 }) + " " + currency;
  }

  function render(list, q) {
    if (!list.length) {
      note([
        "No listings match “" + q + "” yet — new items arrive as agents list them. ",
        link("/browse", "Browse everything →", "inline"),
      ]);
      return;
    }
    var frag = document.createDocumentFragment();
    list.forEach(function (item) {
      var a = el("a", "result");
      a.href = item.url;
      if (item.image) {
        var img = el("img");
        img.src = item.image;
        img.alt = "";
        img.loading = "lazy";
        a.appendChild(img);
      } else {
        var ph = el("span", "ph");
        ph.setAttribute("aria-hidden", "true");
        ph.textContent = "📦";
        a.appendChild(ph);
      }
      var body = el("span");
      var title = el("strong");
      title.textContent = item.title;
      var meta = el("span", "meta");
      meta.textContent = [money(item.price_cents, item.currency), String(item.condition).replace(/_/g, " "), item.category]
        .filter(Boolean)
        .join(" · ");
      body.appendChild(title);
      body.appendChild(meta);
      a.appendChild(body);
      frag.appendChild(a);
    });
    results.replaceChildren(frag);
  }

  function search() {
    var q = input.value.trim();
    if (q.length < 2) {
      note(["Type at least two characters to search."]);
      return;
    }
    note(["Searching…"]);
    fetch("/search.json?limit=3&q=" + encodeURIComponent(q))
      .then(function (res) {
        if (!res.ok) throw new Error("search " + res.status);
        return res.json();
      })
      .then(function (data) {
        render(data.results, q);
      })
      .catch(function () {
        note([
          "Search hiccup on our side — ",
          link("/browse?q=" + encodeURIComponent(q), "try the browse page →", "inline"),
        ]);
      });
  }

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    search();
  });

  // One-tap example prompt: fills the box and runs the search. (The sell
  // chip is a plain link to /chat.html — a sell intent needs the assistant,
  // not the search box.)
  var chips = document.querySelectorAll(".chip[data-q]");
  for (var i = 0; i < chips.length; i++) {
    chips[i].addEventListener("click", function () {
      input.value = this.getAttribute("data-q");
      search();
    });
  }
})();
