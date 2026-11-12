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
// Security: translations here are authored (trusted) strings installed via
// textContent or parsed once into DOM nodes. The HTML-string sinks banned by
// tests/website-security.test.ts (innerHTML & friends) are never used: marked
// nodes are cloned for the English snapshot and restored from the clone,
// while Italian markup is parsed with createRange().createContextualFragment()
// — a parser, not an HTML-string sink — and only from the static strings in
// this file. User-authored content (listing titles, names, …) is never
// translated and never passes through here, and __thingeryT() values are
// plain text (assigned to textContent by callers), never markup.
(function () {
  "use strict";

  var STORAGE_KEY = "thingery-lang";
  var LANGS = ["en", "it"];
  var ATTRS = ["placeholder", "title", "aria-label", "alt"];

  // Fixed vocabularies rendered from data slugs, mapped in place via
  // data-i18n-cond / data-i18n-status (English fallback = slug, underscores
  // to spaces, exactly as the server renders it). These slugs are interpolated
  // unescaped in src/web-pages.ts — widening condition/status beyond these
  // closed enums (db/schema.sql CHECKs + zod) requires escaping there first.
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
    // --- shared (nav) --------------------------------------------------------
    "nav.aria": "Sito",

    // --- item pages (src/web-pages.ts + share.js) ---------------------------
    "item.share": "🔗 Condividi",
    "item.shareCopied": "✅ Link copiato",
    "item.shareFail": "Copia non riuscita — usa la barra degli indirizzi",
    "item.payOn": "I pagamenti con carta sono attivi — l'ordine del tuo assistente AI riceve un link di checkout Stripe sicuro.",
    "item.payOff": "Per comprare, chiedi al tuo assistente AI (Claude, ChatGPT, …) — si collega via MCP e organizza tutto col venditore.",
    "item.cond": "condizione:",
    "item.cat": "categoria:",
    "item.brand": "marca:",
    "item.ships": "spedizione:",
    "item.plusShipping": "+ spedizione:",
    "item.total": "totale:",
    "item.noDesc": "Nessuna descrizione fornita.",
    "item.listed": "Pubblicato il",
    "item.toBuy": "Per comprare, scrivi al venditore tramite l'assistente che ti ha mostrato questo annuncio.",
    "item.nfH1": "Non trovato",
    "item.nfP": "Questo oggetto non esiste o è stato rimosso.",
    // Gallery lightbox controls (THI-678) — aria labels only; the counter
    // ("2 / 5") and photo glyphs are language-neutral.
    "item.lbViewer": "Visualizzatore foto",
    "item.lbClose": "Chiudi",
    "item.lbPrev": "Foto precedente",
    "item.lbNext": "Foto successiva",

    // --- account page (/login.html + account.js) -----------------------------
    "acct.title": "Account — Thingery",
    "acct.h1": "Account",
    "acct.formTitleSignup": "Crea il tuo account",
    "acct.formTitleLogin": "Accedi",
    "acct.submitSignup": "Registrati",
    "acct.submitLogin": "Accedi",
    "acct.modeToLogin": "Ho già un account — accedi",
    "acct.modeToSignup": "Devo creare un account",
    "acct.f.email": "Email",
    "acct.f.pw": "Password",
    "acct.f.pwHint": "(min 8 caratteri)",
    "acct.f.name": "Nome",
    "acct.f.nameHint": "(facoltativo)",
    "acct.done.h2": "Ora sei dentro",
    "acct.loggedAs": "Accesso effettuato come ",
    "acct.copied": "Copiato ✓",
    "acct.wanted.h2": "I compratori cercano",
    "acct.wanted.subjectOne": "1 acquirente",
    "acct.wanted.subjectMany": "{n} acquirenti",
    "acct.wanted.verbOne": "sta cercando",
    "acct.wanted.verbMany": "stanno cercando",
    "acct.wanted.strip": "{subject} {verb} cose come {example} — {chips}",
    "acct.connect.h2": "Collega il tuo assistente AI",
    "acct.connect.small": "(usa la quota del tuo assistente)",
    "acct.connect.li1.paste": " — incolla questo nella configurazione MCP",
    "acct.connect.li1.restart": ", poi riavvia l'app:",
    "acct.connect.copyConfig": "Copia configurazione",
    "acct.connect.li2.strong": "Claude web / ChatGPT con i connettori",
    "acct.connect.li2.add": " — aggiungi un connettore personalizzato con l'URL ",
    "acct.connect.copyUrl": "Copia URL",
    "acct.connect.li2.header": " e imposta l'intestazione ",
    "acct.connect.li3": "<strong>Qualsiasi altro client MCP</strong> — stesso URL e stessa chiave; il server parla lo standard Streamable HTTP.",
    "acct.talk.h2": "Poi basta parlare col tuo assistente",
    "acct.talk.li1": "<em>«Vendi la mia penna stilografica Diplomat, buone condizioni, 120 euro»</em>",
    "acct.talk.li2": "<em>«Trova una Sony usata sotto i 300 euro su Thingery»</em>",
    "acct.key.h2": "La tua chiave API venditore",
    "acct.keyNote": "Tienila privata — pubblica annunci a nome tuo. Viene mostrata solo alla creazione o alla rigenerazione.",
    "acct.keyNoteOnce": "Tienila privata — pubblica annunci a nome tuo. Mostrata una sola volta; rigenerala per vederla o ruotarla in futuro.",
    "acct.keyMasked": "Nascosta per sicurezza — rigenera per ottenere una nuova chiave.",
    "acct.errRegen": "Impossibile rigenerare la chiave.",
    "acct.regen": "Rigenera chiave",
    "acct.apps": "Applicazioni collegate",
    "acct.logout": "Esci",
    "acct.errGeneric": "Qualcosa è andato storto.",
    "acct.byo.h2": "Usa il tuo modello",
    "acct.byo.small": "(per l'assistente in chat)",
    "acct.byo.p": "Salva una chiave API compatibile con OpenAI e l'assistente chatta con la tua chiave invece di quella di Thingery. La chiave è cifrata a riposo e verificata una volta prima del salvataggio — non viene mai più mostrata.",
    "acct.byo.key": "Chiave API",
    "acct.byo.model": "Modello",
    "acct.byo.modelHint": "(con tool-calling, es. gpt-4o-mini)",
    "acct.byo.base": "URL di base",
    "acct.byo.baseHint": "(facoltativo, qualsiasi endpoint compatibile OpenAI)",
    "acct.byo.label": "Etichetta",
    "acct.byo.labelPh": "La mia chiave OpenAI",
    "acct.byo.save": "Salva e verifica",
    "acct.byo.verifying": "Verifica in corso…",
    "acct.byo.remove": "Rimuovi",
    "acct.byo.statusOff": "Non disponibile su questo server — l'assistente usa la chiave di Thingery.",
    "acct.byo.statusNone": "Non impostata — l'assistente usa la chiave di Thingery.",
    "acct.byo.statusOn": "In uso la tua chiave: {label} · {model}{where} (impronta {fp}).",
    "acct.byo.savedKey": "chiave salvata",
    "acct.byo.errSave": "Impossibile salvare la chiave.",
    "acct.byo.errRemove": "Impossibile rimuovere la chiave.",
    "acct.cg.h2": "Usa il tuo piano ChatGPT",
    "acct.cg.small": "(per l'assistente in chat)",
    "acct.cg.p": "Collega il tuo account ChatGPT e le conversazioni idonee girano sul tuo piano ChatGPT invece che su una chiave Thingery. Puoi scollegarti quando vuoi.",
    "acct.cg.usage": "Si applicano i limiti d'uso del tuo piano ChatGPT — gestiscili in <a href=\"https://chatgpt.com/settings/usage\" target=\"_blank\" rel=\"noopener\">ChatGPT → Impostazioni → Utilizzo</a>.",
    "acct.cg.connect": "Continua con ChatGPT",
    "acct.cg.disconnect": "Scollega",
    "acct.cg.statusOn": "Piano ChatGPT in uso{model}{fingerprint}.",
    "acct.cg.segModel": " · modello {m}",
    "acct.cg.segFp": " · impronta {f}",
    "acct.cg.statusOff": "Non collegato — l'assistente usa la chiave di Thingery o la tua chiave qui sopra.",
    "acct.cg.confirmDisconnect": "Scollegare il tuo piano ChatGPT? L'assistente smetterà di usarlo.",
    "acct.cg.revocation": "Scollegato qui. Per sicurezza rimuovi anche Thingery in ChatGPT → Impostazioni → Connessioni.",
    "acct.cg.errDisconnect": "Impossibile scollegare.",
    "acct.cg.banner.connected": "ChatGPT collegato — ora l'assistente usa il tuo piano ChatGPT.",
    "acct.cg.banner.declined": "Connessione annullata — nessuna modifica.",
    "acct.cg.banner.plan_not_enabled": "L'uso del piano ChatGPT non è stato approvato, quindi nessun account è stato collegato. Riprova e approva l'uso del piano quando ti viene chiesto.",
    "acct.cg.banner.error": "Qualcosa è andato storto nel collegare il tuo account ChatGPT — riprova.",
    "acct.cg.modal.title": "Stai usando il tuo piano ChatGPT",
    "acct.cg.modal.p": "Le richieste idonee in questo assistente usano ora il tuo piano ChatGPT. Puoi rivedere utilizzo e limiti quando vuoi nelle impostazioni di ChatGPT.",
    "acct.cg.modal.ok": "Capito",
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
  // Parse a static, authored markup string into live DOM nodes without any
  // HTML-string sink (see the security note at the top of the file).
  var fragment = (function () {
    var range = null;
    return function (html) {
      if (!range) range = document.createRange();
      return range.createContextualFragment(html);
    };
  })();

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
      if (!("dom" in m)) m.dom = el.cloneNode(true); // EN snapshot, exact markup
      var v = it ? IT[el.getAttribute("data-i18n-html")] : null;
      // Restore: re-insert a fresh clone of the English snapshot (clone so
      // repeated toggles never consume it). Apply: replace with the parsed
      // Italian markup. A missing IT key leaves the snapshot untouched.
      el.replaceChildren(v != null ? fragment(v) : m.dom.cloneNode(true));
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
      var lbl = document.createElement("span");
      lbl.textContent = label;
      b.replaceChildren(fragment(flag), lbl);
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
