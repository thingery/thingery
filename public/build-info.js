// Build badge (THI-68): fills the footer's #build-info span with the site
// version + deployed commit, read from /healthz. External file because CSP is
// script-src 'self' (no inline script). Silent no-op if the fetch fails.
(function () {
  fetch('/healthz')
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (h) {
      if (!h || !h.version) return;
      var el = document.getElementById('build-info');
      if (!el) return;
      var txt = 'v' + h.version;
      if (h.commit && h.commit !== 'unknown') {
        var a = document.createElement('a');
        a.href = 'https://github.com/thingery/thingery/commit/' + encodeURIComponent(h.commit);
        a.textContent = h.commit.slice(0, 7);
        el.append(txt + ' · ');
        el.appendChild(a);
      } else {
        el.textContent = txt + ' · commit unknown';
      }
    })
    .catch(function () {});
})();
