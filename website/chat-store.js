// One assistant conversation per browser tab, shared by the full chat page
// (chat.js) and the floating widget (chat-widget.js), so "open in full chat"
// carries the conversation over and moving between pages doesn't wipe it.
//
// sessionStorage rather than localStorage: a conversation can hold order or
// shipping details, and it should not outlive the tab on a shared computer.
// Every read is validated — storage is user-writable, and a corrupt or
// hand-edited entry must degrade to an empty conversation, never a crash.
(function () {
  "use strict";

  var KEY = "thingery-chat";
  var MAX_HISTORY = 24; // chatSchema.history.max in src/routes.ts
  var MAX_LOG = 60;
  var MAX_TEXT = 8000; // chatSchema history content max

  function isTurn(x) {
    return (
      x !== null &&
      typeof x === "object" &&
      (x.role === "user" || x.role === "assistant") &&
      typeof x.content === "string" &&
      x.content.length <= MAX_TEXT
    );
  }

  function isLogEntry(x) {
    return (
      x !== null &&
      typeof x === "object" &&
      (x.role === "user" || x.role === "bot") &&
      typeof x.text === "string"
    );
  }

  function empty() {
    return { history: [], log: [], contextKey: null };
  }

  // Parsing is separate from storage access so it can be unit-tested
  // without a browser.
  function parse(raw) {
    if (typeof raw !== "string" || !raw) return empty();
    var data;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      return empty();
    }
    if (data === null || typeof data !== "object") return empty();
    return {
      history: Array.isArray(data.history) ? data.history.filter(isTurn).slice(-MAX_HISTORY) : [],
      log: Array.isArray(data.log) ? data.log.filter(isLogEntry).slice(-MAX_LOG) : [],
      contextKey: typeof data.contextKey === "string" ? data.contextKey : null,
    };
  }

  function load() {
    try {
      return parse(sessionStorage.getItem(KEY));
    } catch (e) {
      return empty(); // storage blocked (privacy settings): in-memory only
    }
  }

  function save(state) {
    try {
      sessionStorage.setItem(
        KEY,
        JSON.stringify({
          history: state.history.slice(-MAX_HISTORY),
          log: state.log.slice(-MAX_LOG),
          contextKey: state.contextKey || null,
        }),
      );
    } catch (e) {
      /* quota or blocked storage: the conversation lasts for this page only */
    }
  }

  globalThis.ThingeryChatStore = {
    load: load,
    save: save,
    parse: parse,
    MAX_HISTORY: MAX_HISTORY,
  };
})();
