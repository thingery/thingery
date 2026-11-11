// Share button on public item pages (THI-396). CSP-safe static script:
// no inline handlers, no HTML-string sinks — textContent only. Shares the
// clean canonical URL (data-share-url, absolute, no tracking params), so
// shared links never churn; visit attribution happens server-side via
// Referer / utm_* capture (see the THI-396 DevOps note), not baked-in params.
(() => {
  const btn = document.getElementById("share-btn");
  if (!btn) return; // non-item pages / sold listings render no button

  // THI-445: strings run through the i18n dictionary when present, with the
  // English original as inline fallback (static file, CSP-safe).
  const t = globalThis.__thingeryT || ((key, fallback) => fallback);

  const url = (btn.dataset && btn.dataset.shareUrl) || (typeof location !== "undefined" ? location.href : "");
  const title = (btn.dataset && btn.dataset.shareTitle) || document.title || "";
  let resetTimer = null;

  const flash = (text) => {
    btn.textContent = text;
    if (resetTimer) clearTimeout(resetTimer);
    resetTimer = setTimeout(() => {
      btn.textContent = t("item.share", "🔗 Share");
      resetTimer = null;
    }, 2500);
  };

  // Legacy clipboard path for browsers without navigator.clipboard
  // (older Safari, insecure contexts): off-screen textarea + execCommand.
  const legacyCopy = (text) => {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try {
      return document.execCommand("copy");
    } finally {
      ta.remove();
    }
  };

  btn.addEventListener("click", async () => {
    // Web Share API (mobile): the OS sheet handles the copy. A rejection is
    // just the user dismissing the sheet — nothing to surface.
    if (typeof navigator !== "undefined" && navigator.share) {
      try {
        await navigator.share({ title, url });
      } catch {
        /* dismissed */
      }
      return;
    }
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(url);
      } else {
        legacyCopy(url);
      }
      flash(t("item.shareCopied", "✅ Link copied"));
    } catch {
      flash(t("item.shareFail", "Copy failed — use the address bar"));
    }
  });
})();
