// Legacy links: /index.html#item-<uuid> → /item/<uuid>
const m = location.hash.match(/^#item-([0-9a-f-]{36})$/i);
if (m) location.replace("/item/" + m[1]);
