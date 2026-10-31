// Bilingual UI (THI-445): English is server-rendered and canonical; Italian
// applies client-side from the dictionary below. One static file, cached
// across pages. CSP is script-src 'self' — no inline scripts anywhere, which
// is why the engine, toggle and dictionary all live in this file.
//
// Mechanism: elements carry data-i18n / data-i18n-html / data-i18n-<attr>
// attributes naming a dictionary key. English originals are snapshotted on
// first apply, so toggling back restores exactly the server-rendered markup.
// Missing keys fall back to the English already in the DOM — a partial
// dictionary can never blank a page.
//
// Security: translations here are authored (trusted) strings assigned to
// textContent / innerHTML of marked elements. User-authored content (listing
// titles, names, …) is never translated and never passes through here.
(function () {
  "use strict";

  var STORAGE_KEY = "thingery-lang";
  var LANGS = ["en", "it"];
  var ATTRS = ["placeholder", "title", "aria-label", "alt"];

  // Fixed vocabularies rendered from data slugs, mapped in place via
  // data-i18n-cond / data-i18n-status (English fallback = slug, underscores
  // to spaces, exactly as the server renders it).
  var COND = {
    new: "nuovo",
    like_new: "come nuovo",
    good: "buone condizioni",
    fair: "condizioni discrete",
    poor: "condizioni scarse",
  };
  var STATUS = {
    active: "attivo",
    reserved: "riservato",
    sold: "venduto",
    deleted: "eliminato",
  };

  // Italian dictionary. Keys mirror data-i18n attributes in the HTML and
  // __thingeryT() calls in page scripts. Values with markup (data-i18n-html)
  // are authored HTML — links/classes must match the English original.
  var IT = {
    // --- shared (nav, footer, legal-page chrome) ---------------------------
    "nav.browse": "Sfoglia",
    "nav.chat": "Chat",
    "nav.account": "Account",
    "back.home": "← Torna a Thingery",
    "foot.home": "Home",
    "foot.privacy": "Privacy",
    "foot.terms": "Termini",
    "foot.apps": "App collegate",
    "common.search": "Cerca",

    // --- homepage (/) -------------------------------------------------------
    "home.title": "Thingery — trova, vendi e scambia oggetti di seconda mano con la tua AI",
    "home.hero.h1": "Trova, vendi e scambia oggetti di seconda mano — <em>basta parlare con la tua AI</em>",
    "home.hero.sub": "Thingery è il database aperto di oggetti usati e il server MCP che permette agli agenti AI di pubblicare, trovare e scambiare articoli di seconda mano.",
    "home.hero.sub2": "Sfoglia il catalogo come in un qualsiasi marketplace, oppure collegalo al tuo assistente e vai a mani libere.",
    "home.cta.find": "Trova un articolo",
    "home.cta.sell": "Vendi un articolo",
    "home.cta.build": "Costruisci con Thingery",
    "home.demo.h2": "Provalo subito",
    "home.demo.label": "Demo dal vivo — per cercare non serve un account",
    "home.demo.chip1": "🔍 Trovami una macchina fotografica analogica usata sotto i 300 €",
    "home.demo.chip2": "🏷️ Vendi la mia penna stilografica Diplomat, marrone, buone condizioni, 120 euro",
    "home.demo.chip2.title": "Apri l'assistente completo",
    "home.demo.placeholder": "Cerca tra gli annunci… es. macchina fotografica sotto i 300 €",
    "home.demo.aria": "Cerca negli annunci",
    "home.demo.submit": "Cerca",
    "home.demo.caption": "La ricerca è gratuita e immediata. Per pubblicare un annuncio crei un account gratuito (email e password) e scatti una foto — serve una foto perché l'annuncio vada online. Vuoi l'esperienza completa a mani libere? <a href=\"/chat.html\">Apri l'assistente completo →</a>",
    "home.build.h2": "Configurazione più rapida",
    "home.build.own.h3": "Usa la tua AI",
    "home.build.own.p": "Incolla <code>https://thingery.dev/mcp</code> nel tuo client MCP — Claude Desktop, i connettori di ChatGPT, VS Code, Inspector — e accedi. Un clic, senza API key.",
    "home.build.self.h3": "Avvia la tua istanza",
    "home.build.self.p": "Open source (Apache-2.0). Un solo comando: <code>npx thingery</code>",
    "home.build.quickstart": "Guida rapida completa su GitHub →",
    "home.paths.h2": "Tre modi per iniziare",
    "home.find.tag": "TROVA UN ARTICOLO",
    "home.find.h3": "Trova un articolo",
    "home.find.p": "Chiediglielo a parole. Il tuo assistente cerca in tutto il catalogo e ti propone la corrispondenza migliore — prezzo, condizioni, specifiche.",
    "home.find.li1": "Ricerca semantica — «macchina fotografica usata sotto i 300 €» funziona e basta",
    "home.find.li2": "Una pagina pubblica e condivisibile per ogni oggetto",
    "home.find.li3": "Chat senza configurazione su <code>/chat</code> — per cercare non serve un account",
    "home.find.cta": "Sfoglia gli annunci",
    "home.sell.tag": "VENDI UN ARTICOLO",
    "home.sell.h3": "Vendi un articolo",
    "home.sell.p": "Una frase al tuo assistente: identifica l'oggetto, scrive l'annuncio, suggerisce il prezzo e lo pubblica con un link condivisibile.",
    "home.sell.li1": "Niente moduli né ricerche di categoria — a scrivere ci pensa il tuo agente",
    "home.sell.li2": "Scatta una foto per pubblicare (non serve altro)",
    "home.sell.li3": "Gratis per i venditori — segna come riservato o venduto quando vuoi",
    "home.sell.cta": "Pubblica il tuo primo annuncio",
    "home.build2.tag": "COSTRUISCI CON THINGERY",
    "home.build2.h3": "Costruisci con Thingery",
    "home.build2.p": "Ogni funzionalità è uno strumento MCP su un database di oggetti aperto. Collega qualsiasi client MCP — oppure ospita tu l'intero marketplace.",
    "home.build2.li1": "MCP Streamable HTTP standard + OAuth in un clic (PKCE)",
    "home.build2.li2": "Superficie dati aperta: <code>llms.txt</code>, <code>agents.json</code>, ricerca pubblica",
    "home.build2.li3": "Apache-2.0 · self-host con un comando: <code>npx thingery</code>",
    "home.build2.cta": "Leggi la guida rapida",
    "home.stats.aria": "Uso della piattaforma",
    "home.stats.items": "annunci pubblicati",
    "home.stats.agents": "agenti collegati",
    "home.stats.users": "utenti",
    "home.why.h2": "Perché un database, e non l'ennesima app di marketplace?",
    "home.why.lead": "I marketplace intrappolano i tuoi oggetti dietro i loro moduli e le loro app. Thingery è infrastruttura: un catalogo aperto in cui <em>qualsiasi</em> agente AI può pubblicare e cercare — quelli di oggi e quelli di domani, dal tuo telefono o self-hosted. Le tue cose diventano raggiungibili con un URL.",
    "home.roadmap.h2": "Sinceri oggi, cresiamo allo scoperto",
    "home.roadmap.lead": "Già attivi: pubblicazione, ricerca, pagine oggetto, account. In roadmap: pagamenti e spedizioni (l'agente prenota il corriere e sblocca il pagamento alla consegna), negoziazione tra agenti e federazione — così chiunque può ospitare un nodo del catalogo. Apache-2.0, sviluppato in pubblico su <a class=\"inline\" href=\"https://github.com/thingery/thingery\">GitHub</a>.",
    "home.foot.tagline": "<strong>Thingery</strong> è il database aperto di oggetti usati e il server MCP che permette agli agenti AI di pubblicare, trovare e scambiare articoli di seconda mano.",
    "home.foot.chinese": "Nome cinese: 物坊 (Wùfāng) — il marketplace aperto per le cose inutilizzate.",

    // --- homepage live demo (home-demo.js) ----------------------------------
    "demo.tooShort": "Digita almeno due caratteri per cercare.",
    "demo.searching": "Ricerca in corso…",
    "demo.empty.pre": "Nessun annuncio corrisponde a «{q}» per ora — nuovi oggetti arrivano man mano che gli agenti li pubblicano. ",
    "demo.empty.link": "Sfoglia tutto →",
    "demo.error.pre": "Piccolo intoppo nella ricerca da parte nostra — ",
    "demo.error.link": "prova la pagina Sfoglia →",

    // --- shared data vocabularies (also used via __thingeryT) --------------
    "cond.new": "nuovo",
    "cond.like_new": "come nuovo",
    "cond.good": "buone condizioni",
    "cond.fair": "condizioni discrete",
    "cond.poor": "condizioni scarse",
    "status.active": "attivo",
    "status.reserved": "riservato",
    "status.sold": "venduto",
    "status.deleted": "eliminato",
  };

  // ---------------------------------------------------------------- state --
  function storedLang() {
    try {
      var v = localStorage.getItem(STORAGE_KEY);
      return LANGS.indexOf(v) >= 0 ? v : "en";
    } catch (e) {
      return "en";
    }
  }
  var lang = storedLang();

  // English originals, snapshotted before the first Italian apply so
  // toggling back restores the exact server-rendered content.
  var EN = new WeakMap();
  function enSlots(el) {
    var m = EN.get(el);
    if (!m) {
      m = {};
      EN.set(el, m);
    }
    return m;
  }

  var listeners = [];
  var switches = [];

  // --------------------------------------------------------------- lookup --
  function t(key, fallback, params) {
    var v = lang === "it" && Object.prototype.hasOwnProperty.call(IT, key) ? IT[key] : fallback;
    if (params) {
      Object.keys(params).forEach(function (k) {
        v = String(v).split("{" + k + "}").join(params[k]);
      });
    }
    return v;
  }

  // ---------------------------------------------------------------- apply --
  function applyLang() {
    var it = lang === "it";
    document.documentElement.lang = lang;
    document.documentElement.setAttribute("data-lang", lang);

    document.querySelectorAll("[data-i18n]").forEach(function (el) {
      var m = enSlots(el);
      if (!("text" in m)) m.text = el.textContent;
      var v = it ? IT[el.getAttribute("data-i18n")] : m.text;
      if (v != null) el.textContent = v;
    });

    document.querySelectorAll("[data-i18n-html]").forEach(function (el) {
      var m = enSlots(el);
      if (!("html" in m)) m.html = el.innerHTML;
      var v = it ? IT[el.getAttribute("data-i18n-html")] : m.html;
      if (v != null) el.innerHTML = v;
    });

    ATTRS.forEach(function (a) {
      document.querySelectorAll("[data-i18n-" + a + "]").forEach(function (el) {
        var m = enSlots(el);
        var slot = "@" + a;
        if (!(slot in m)) m[slot] = el.getAttribute(a);
        var v = it ? IT[el.getAttribute("data-i18n-" + a)] : m[slot];
        if (v != null) el.setAttribute(a, v);
      });
    });

    var vocab = [
      ["data-i18n-cond", COND],
      ["data-i18n-status", STATUS],
    ];
    vocab.forEach(function (pair) {
      document.querySelectorAll("[" + pair[0] + "]").forEach(function (el) {
        var m = enSlots(el);
        if (!("text" in m)) m.text = el.textContent;
        var v = it ? pair[1][el.getAttribute(pair[0])] : m.text;
        if (v != null) el.textContent = v;
      });
    });

    refreshSwitches();
  }

  function setLang(l) {
    if (LANGS.indexOf(l) < 0 || l === lang) return;
    lang = l;
    try {
      localStorage.setItem(STORAGE_KEY, l);
    } catch (e) {
      /* private mode: choice lasts for this page only */
    }
    applyLang();
    listeners.forEach(function (cb) {
      try {
        cb(l);
      } catch (e) {
        /* a broken listener must not break the toggle */
      }
    });
  }

  // --------------------------------------------------------------- toggle --
  // Inline SVG flags: emoji flags render as letter pairs on Windows, so the
  // switch carries real flag SVGs instead. The Union Jack clipPath needs an
  // id — unique per instance so multiple switches never collide.
  var clipSeq = 0;
  function flagGb() {
    var id = "i18n-gb-" + ++clipSeq;
    return (
      '<svg class="lang-flag" viewBox="0 0 60 30" aria-hidden="true" focusable="false">' +
      '<defs><clipPath id="' + id + '"><path d="M30,15 h30 v15 z v15 h-30 z h-30 v-15 z v-15 h30 z"/></clipPath></defs>' +
      '<rect width="60" height="30" fill="#012169"/>' +
      '<path d="M0,0 L60,30 M60,0 L0,30" stroke="#fff" stroke-width="6"/>' +
      '<path d="M0,0 L60,30 M60,0 L0,30" stroke="#C8102E" stroke-width="4" clip-path="url(#' + id + ')"/>' +
      '<path d="M30,0 v30 M0,15 h60" stroke="#fff" stroke-width="10"/>' +
      '<path d="M30,0 v30 M0,15 h60" stroke="#C8102E" stroke-width="6"/>' +
      "</svg>"
    );
  }
  function flagIt() {
    return (
      '<svg class="lang-flag" viewBox="0 0 3 2" aria-hidden="true" focusable="false">' +
      '<rect width="1" height="2" fill="#008C45"/>' +
      '<rect x="1" width="1" height="2" fill="#F4F5F0"/>' +
      '<rect x="2" width="1" height="2" fill="#CD212A"/>' +
      "</svg>"
    );
  }

  function buildSwitch(box) {
    box.setAttribute("role", "group");
    box.setAttribute("aria-label", "Language / Lingua");
    var mk = function (l, label, title, flag) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "lang-btn";
      b.setAttribute("data-set-lang", l);
      b.setAttribute("aria-pressed", lang === l ? "true" : "false");
      b.title = title;
      b.innerHTML = flag + "<span>" + label + "</span>";
      b.addEventListener("click", function () {
        setLang(l);
      });
      return b;
    };
    var enBtn = mk("en", "EN", "English", flagGb());
    var itBtn = mk("it", "IT", "Italiano", flagIt());
    box.replaceChildren(enBtn, itBtn);
    switches.push({ en: enBtn, it: itBtn });
  }
  function refreshSwitches() {
    switches.forEach(function (s) {
      s.en.setAttribute("aria-pressed", lang === "en" ? "true" : "false");
      s.it.setAttribute("aria-pressed", lang === "it" ? "true" : "false");
    });
  }
  document.querySelectorAll("[data-lang-switch]").forEach(buildSwitch);

  // ------------------------------------------------------------ public API --
  // t(key, fallbackEnglish, params?) for JS-rendered strings; onchange(cb)
  // lets page scripts re-render dynamic sections after a toggle.
  window.__thingeryT = t;
  window.__thingeryI18N = {
    lang: function () {
      return lang;
    },
    onchange: function (cb) {
      listeners.push(cb);
    },
  };

  applyLang();
})();
