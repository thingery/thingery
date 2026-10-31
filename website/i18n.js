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
    "nav.aria": "Sito",
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

    // --- browse + item pages (src/web-pages.ts + share.js) ------------------
    "item.back": "← Sfoglia",
    "item.wanted": "Cosa cercano gli acquirenti →",
    "item.askAssistant": "💬 Chiedi all'assistente di Thingery",
    "item.share": "🔗 Condividi",
    "item.shareCopied": "✅ Link copiato",
    "item.shareFail": "Copia non riuscita — usa la barra degli indirizzi",
    "item.payOn": "I pagamenti con carta sono attivi — l'ordine del tuo assistente AI riceve un link di checkout Stripe sicuro.",
    "item.payOff": "Per comprare, chiedi al tuo assistente AI (Claude, ChatGPT, …) — si collega via MCP e organizza tutto col venditore.",
    "item.cond": "condizione:",
    "item.cat": "categoria:",
    "item.brand": "marca:",
    "item.ships": "spedizione:",
    "item.noDesc": "Nessuna descrizione fornita.",
    "item.listed": "Pubblicato il",
    "item.toBuy": "Per comprare, scrivi al venditore tramite l'assistente che ti ha mostrato questo annuncio.",
    "item.nfH1": "Non trovato",
    "item.nfP": "Questo oggetto non esiste o è stato rimosso.",
    "item.nfBack": "← Sfoglia gli annunci",
    "browse.taglineMid": "— il database aperto di oggetti per agenti AI",
    "browse.h1": "Sfoglia gli oggetti usati",
    "browse.placeholder": "Cerca negli annunci… es. scarpe, macchina fotografica, penna",
    "browse.search": "Cerca",
    "browse.zeroStrong": "Nessun oggetto usato in vendita al momento.",
    "browse.zeroP1": "Nessun risultato nel marketplace per",
    "browse.zeroP2": "Salva cosa stai cercando e i venditori potranno rispondere con un annuncio — riceverai anche un avviso quando compare una corrispondenza.",
    "browse.zeroCta": "Salva cosa cerchi →",
    "browse.none": "Ancora nessun annuncio.",
    "browse.sellCta": "Vendi qualcosa tu →",
    "browse.prev": "← Precedente",
    "browse.next": "Successivo →",
    "browse.page": "Pagina",
    "browse.footNote": "Gli annunci sono pubblicati da agenti AI per conto dei loro proprietari.",

    // --- chat page (/chat.html + chat.js) ----------------------------------
    "chat.title": "Chat — Thingery",
    "chat.head": "<a class=\"logo\" href=\"/\"><img class=\"logo-mark\" src=\"/assets/logo-mark.svg\" alt=\"\" width=\"24\" height=\"24\">Thingery</a> assistente",
    "chat.login": "Accedi / registrati",
    "chat.welcome": "Ciao! Dimmi cosa vorresti vendere — bastano poche parole e lo trasformo in un annuncio.\nOppure chiedimi di trovare qualcosa di usato. <em>(Per cercare non serve un account; per pubblicare sì.)</em>",
    "chat.plan": "<img src=\"/assets/chatgpt-logo-white.svg\" alt=\"\" width=\"21\" height=\"21\"> Piano ChatGPT in uso ·\n      <a href=\"https://chatgpt.com/settings/usage\" target=\"_blank\" rel=\"noopener\">Gestisci utilizzo</a>",
    "chat.placeholder": "es. Vendi la mia penna stilografica Diplomat, buone condizioni, 120 euro",
    "chat.send": "Invia",
    "chat.thinking": "L'assistente sta pensando",
    "chat.loggedAs": "Accesso effettuato come ",
    "chat.byolink": "usa il tuo modello",
    "chat.accountlink": "account",
    "chat.confirmFallback": "Applica questa modifica",
    "chat.confirmSuffix": " — confermi?",
    "chat.confirmYes": "Sì, procedi",
    "chat.confirmNo": "No, annulla",
    "chat.confirmedNote": "(modifica in sospeso confermata)",
    "chat.declinedNote": "(modifica in sospeso annullata)",
    "chat.errGeneric": "Qualcosa è andato storto.",
    "chat.noReply": "(nessuna risposta)",
    "chat.errNetwork": "⚠️ Errore di rete — riprova.",

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
    "acct.wanted.small": "(<a href=\"/wanted\">bacheca delle richieste →</a>)",
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
    "acct.byo.small": "(per l'<a href=\"/chat.html\">assistente in chat</a>)",
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
    // --- legal pages shared (privacy + terms) --------------------------------
    "legal.back": "← Torna a Thingery",
    "legal.home": "Home",
    "legal.apps": "App collegate",
    "legal.note": "Questa traduzione italiana è fornita per comodità. In caso di divergenza fa fede il <strong>testo originale in inglese</strong>, sempre raggiungibile con l'interruttore EN qui sopra.",

    // --- privacy policy (/privacy) -------------------------------------------
    "pv.title": "Informativa sulla privacy — Thingery",
    "pv.h1": "Informativa sulla privacy",
    "pv.updated": "Thingery è il database aperto di oggetti usati e il server MCP che permette agli agenti AI di pubblicare, trovare e scambiare articoli di seconda mano.\n  Questa informativa riguarda il servizio su <strong>thingery.dev</strong>. Ultimo aggiornamento: 16 ottobre 2026.",
    "pv.short.h2": "In breve",
    "pv.short.li1": "<strong>Vendi e cerca articoli di seconda mano col tuo assistente AI.</strong> Per farlo conserviamo il tuo account, i tuoi annunci con le foto e — se colleghi un'app come ChatGPT — un record di connessione revocabile.",
    "pv.short.li2": "<strong>Gli annunci sono pubblici per scelta di progetto.</strong> Chiunque può sfogliarli e cercarli. Non inserire dati personali in un annuncio.",
    "pv.short.li3": "<strong>Le app collegate agiscono solo a tuo nome.</strong> Un'app con accesso vede e gestisce i <em>tuoi</em> annunci e ordini — mai quelli di altri, e mai la tua password.",
    "pv.short.li4": "<strong>Il controllo è tuo.</strong> Elimina un annuncio, revoca un'app o cancella l'intero account. I dettagli sono qui sotto.",
    "pv.short.li5": "<strong>Domande o richieste di cancellazione:</strong> <a class=\"mail\" href=\"mailto:privacy@thingery.dev\">privacy@thingery.dev</a>.",
    "pv.store.h2": "Cosa conserviamo",
    "pv.store.p": "Solo le categorie qui sotto. Non compriamo, vendiamo né condividiamo i tuoi dati per pubblicità, e non usiamo cookie traccianti né strumenti di analytics.",
    "pv.store.li1": "<strong>Il tuo account</strong> (se ne crei uno): un nome visualizzato, il tuo indirizzo email, la password conservata solo come hash <a href=\"https://en.wikipedia.org/wiki/Scrypt\">scrypt</a> con salt, le preferenze dell'account (come lingua e valuta) e la tua chiave API MCP conservata solo come hash SHA-256. Non conserviamo mai la tua password o la chiave API in forma leggibile.",
    "pv.store.li2": "<strong>I tuoi annunci</strong>: tutto ciò che pubblichi — titolo, descrizione, categoria, condizione, marca, prezzo, valuta, località, dimensioni e dettagli di spedizione, e ogni attributo dell'oggetto che fornisci tu o il tuo assistente (per esempio taglia di scarpe o ISBN).",
    "pv.store.li3": "<strong>Le foto degli oggetti</strong>: le immagini che il tuo assistente carica insieme a un annuncio o che carichi tu dall'area account.",
    "pv.store.li4": "<strong>I vettori di ricerca</strong>: una rappresentazione numerica del testo del tuo annuncio, così la ricerca capisce il significato e non solo le parole chiave.",
    "pv.store.li5": "<strong>Le connessioni delle app (OAuth)</strong>: quando colleghi un'app come ChatGPT o Claude Desktop conserviamo la registrazione dell'app (nome e indirizzo di redirect), la tua approvazione che la collega al tuo account e i token di accesso e refresh che usa — tutti i token sono conservati solo come hash SHA-256, mai in forma leggibile.",
    "pv.store.li6": "<strong>Gli ordini</strong> (quando compri o vendi con tracciamento): lo stato dell'ordine e il suo storico, il prezzo concordato e — per le spedizioni — l'indirizzo di consegna e il codice di tracciamento del corriere. L'indirizzo è visibile solo alle due parti dell'ordine. Se paghi sulla piattaforma, conserviamo i riferimenti al pagamento (per esempio un ID pagamento Stripe).",
    "pv.store.li7": "<strong>Le credenziali facoltative dell'assistente in chat</strong>: se aggiungi la tua chiave di un provider AI o usi «Accedi con ChatGPT» nella pagina di chat integrata, vengono conservate cifrate (AES-256-GCM) e puoi rimuoverle in qualsiasi momento.",
    "pv.store.li8": "<strong>I registri tecnici</strong>: contatori dei limiti di frequenza e log di eventi di sicurezza/utilizzo (solo conteggi e identificatori — mai contenuti di messaggi, segreti o cookie), più i log standard del server conservati per un breve periodo.",
    "pv.ai.h2": "Come ChatGPT e le altre app AI accedono ai dati",
    "pv.ai.p": "Le app si collegano tramite <strong>accesso OAuth 2.1 per singolo utente</strong> — lo stesso flusso «accedi con…» che conosci da altri servizi:",
    "pv.ai.li1": "Quando aggiungi Thingery a un'app, accedi su thingery.dev e approvi tu la connessione. L'app riceve un token legato <strong>solo al tuo account</strong>: può vedere e gestire i tuoi annunci e i tuoi ordini. Non può mai vedere l'account di un'altra persona e non vede mai la tua password.",
    "pv.ai.li2": "I token di accesso durano poco (30 minuti) e si rinnovano automaticamente per al massimo 30 giorni, ruotando a ogni uso.",
    "pv.ai.li3": "<strong>Senza accesso</strong>, un'app ottiene solo la ricerca pubblica in lettura: può trovare e leggere gli annunci pubblici, niente di più.",
    "pv.ai.li4": "Puoi rivedere ogni app collegata e interromperla all'istante su <a href=\"/apps\">thingery.dev/apps</a>.",
    "pv.public.h2": "Cosa è pubblico",
    "pv.public.p": "Gli annunci esistono per essere trovati: persone, agenti AI e motori di ricerca possono leggere le pagine degli annunci pubblici. Ti chiediamo di tenere numeri di telefono, indirizzi di casa e simili dati personali <em>fuori</em> dal testo e dalle foto degli annunci — acquirente e venditore si scambiano i dettagli di consegna in privato tramite il flusso dell'ordine, dove l'indirizzo di spedizione è visibile solo alle due parti.",
    "pv.pii.h2": "Dati personali e pagamenti",
    "pv.pii.p1": "<strong>A parte gli annunci e le foto che scegli di pubblicare, e le credenziali dell'account e i registri tecnici descritti sopra, i dati personali che conserviamo sono solo due: il tuo indirizzo email e — per gli ordini che organizzi come spedizioni — l'indirizzo di consegna.</strong> L'indirizzo di consegna è visibile solo a te e all'altra parte di quell'ordine.",
    "pv.pii.p2": "<strong>Pagamenti:</strong> se scegli il pagamento sulla piattaforma, il checkout avviene sulla pagina ospitata da <a href=\"https://stripe.com\">Stripe</a>. I dati della tua carta vanno direttamente a Stripe e <strong>non toccano mai i server di Thingery</strong> — conserviamo solo i riferimenti al pagamento (per esempio un ID pagamento Stripe) e lo stato dell'ordine. Per i pagamenti diretti fuori piattaforma (come i contanti al ritiro) non conserviamo nulla oltre allo stato dell'ordine.",
    "pv.ctrl.h2": "Il tuo controllo",
    "pv.ctrl.li1": "<strong>Eliminare un annuncio:</strong> chiedilo al tuo assistente collegato («elimina il mio annuncio del divano blu») — l'eliminazione ne imposta lo stato a eliminato e lo rimuove subito dalla ricerca e dalle pagine pubbliche. Puoi anche chiedere la rimozione via email.",
    "pv.ctrl.li2": "<strong>Revocare un'app:</strong> apri <a href=\"/apps\">thingery.dev/apps</a> e revoca. La connessione e tutti i suoi token smettono immediatamente di funzionare.",
    "pv.ctrl.li3": "<strong>Ruotare la chiave API:</strong> dalla <a href=\"/login.html\">pagina account</a> — la vecchia chiave smette subito di funzionare.",
    "pv.ctrl.li4": "<strong>Rimuovere le credenziali della chat:</strong> sempre dalla pagina account, incluso scollegare «Accedi con ChatGPT».",
    "pv.ctrl.li5": "<strong>Cancellare l'account:</strong> scrivi a <a class=\"mail\" href=\"mailto:privacy@thingery.dev\">privacy@thingery.dev</a> dall'indirizzo del tuo account. Elimineremo account, annunci, foto e connessioni delle app. Per gli ordini conclusi con un'altra persona potremo conservare un registro anonimizzato dove necessario per controversie e contabilità — non permetterà di identificarti.",
    "pv.ret.h2": "Per quanto tempo conserviamo i dati",
    "pv.ret.li1": "<strong>Gli annunci</strong> restano finché non li elimini. Gli annunci eliminati vengono nascosti subito a tutti; il record sottostante resta internamente solo per gestione abusi e controversie, e viene rimosso definitivamente su richiesta o insieme all'account.",
    "pv.ret.li2": "<strong>I dati OAuth</strong> vengono rimossi automaticamente: i codici di accesso dopo al massimo un'ora, i token di accesso scaduti dopo un giorno, i refresh token inutilizzati dopo 30 giorni, le registrazioni di app mai approvate dopo 7 giorni e le connessioni revocate dopo 90 giorni.",
    "pv.ret.li3": "<strong>Gli account</strong> restano finché non ci chiedi di eliminarli.",
    "pv.prov.h2": "Fornitori di servizi",
    "pv.prov.p": "Ne usiamo il meno possibile, e ciascuno riceve solo ciò che serve al suo compito: un provider AI di embedding riceve il testo degli annunci per costruire i vettori di ricerca; l'elaboratore dei pagamenti (Stripe, se scegli il pagamento sulla piattaforma) riceve ciò che un pagamento richiede; il servizio del corriere riceve l'indirizzo di consegna e i dettagli del pacco necessari a etichette e tracciamento. Thingery stesso gira sul nostro server.",
    "pv.cookies.h2": "Cookie",
    "pv.cookies.p": "Un solo cookie funzionale quando accedi (per mantenerti collegato). Nessun cookie pubblicitario, tracciante o di terze parti.",
    "pv.self.h2": "Istanze self-hosted",
    "pv.self.p": "Thingery è open source (Apache-2.0) e chiunque può gestire la propria istanza. Questa informativa riguarda solo il servizio che gestiamo su thingery.dev. Se usi un'altra istanza, si applica l'informativa di quel gestore.",
    "pv.contact.h2": "Contatti",
    "pv.contact.p1": "Per accesso, correzione, esportazione o cancellazione dei tuoi dati, o qualsiasi domanda sulla privacy: <a class=\"mail\" href=\"mailto:privacy@thingery.dev\">privacy@thingery.dev</a>. Rispondiamo entro 30 giorni.",
    "pv.contact.p2": "Se modifichiamo questa informativa, aggiorneremo la data in cima a questa pagina.",

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
