// Homepage platform-usage strip (THI-311). Progressive enhancement:
// the strip ships hidden and only appears once real counts arrive from
// /stats.json — if the fetch fails or JS is off, no numbers are shown
// (never fake or hardcoded values). Counts are aggregate only.
(function () {
  var strip = document.getElementById("platform-stats");
  if (!strip) return;
  var cells = {
    items: document.getElementById("stat-items"),
    agents: document.getElementById("stat-agents"),
    users: document.getElementById("stat-users"),
  };
  fetch("/stats.json")
    .then(function (res) {
      if (!res.ok) throw new Error("stats " + res.status);
      return res.json();
    })
    .then(function (stats) {
      ["items", "agents", "users"].forEach(function (key) {
        var n = Number(stats[key]);
        if (!Number.isFinite(n) || n < 0) throw new Error("bad stat: " + key);
        if (cells[key]) cells[key].textContent = n.toLocaleString("en-IE");
      });
      strip.hidden = false;
    })
    .catch(function () {
      /* leave the strip hidden — no fake numbers */
    });
})();
