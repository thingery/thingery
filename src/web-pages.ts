// Human-facing HTML pages: public item pages and the browse page.
// Server-rendered, crawler-friendly (also for LLM browsing agents), no JS needed.

import type { Request, Response } from "express";
import { getItem, searchItems } from "./items.js";
import { sellerFromSession } from "./auth.js";
import type { ItemRow } from "./db.js";
import { BROWSE_PAGE_SIZE, browsePageNav, browsePageUrl, parsePageParam } from "./pagination.js";

const escapeHtml = (value: unknown): string =>
  String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

const money = (cents: number, currency: string): string =>
  `${(cents / 100).toLocaleString("en-IE", { minimumFractionDigits: 2 })} ${currency}`;

/** JSON for embedding in a <script type="application/ld+json"> data block.
 *  `JSON.stringify` leaves "<" unescaped, so seller-controlled values containing
 *  "</script>" would break out of the data block into an executable script
 *  context (stored XSS on public item pages). "\u003c" is valid JSON and
 *  parses back to "<", so the structured data is unchanged. */
export function safeJsonLd(value: unknown): string {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}

/** Open Graph / Twitter Card meta for link unfurling (chat apps, social, launch posts). */
export interface OgMeta {
  title?: string;
  description?: string;
  siteName?: string;
  url?: string;
  image?: string;
  /** twitter:card value, e.g. "summary_large_image"; rendered with name= instead of property=. */
  twitterCard?: string;
}

/** Renders og:/twitter: meta tags; empty fields are omitted, values HTML-escaped. */
export function ogMetaHtml(og: OgMeta | undefined): string {
  if (!og) return "";
  const propertyTags: Array<[name: string, value: string | undefined]> = [
    ["og:title", og.title],
    ["og:description", og.description],
    ["og:site_name", og.siteName],
    ["og:url", og.url],
    ["og:image", og.image],
  ];
  const lines = propertyTags
    .filter(([, value]) => value)
    .map(([name, value]) => `  <meta property="${name}" content="${escapeHtml(value)}">`);
  if (og.twitterCard) {
    lines.push(`  <meta name="twitter:card" content="${escapeHtml(og.twitterCard)}">`);
  }
  return lines.length ? `\n${lines.join("\n")}` : "";
}

/** Canonical origin for absolute URLs: PUBLIC_BASE_URL when set, else the request origin. */
function baseUrlFromRequest(req: Request): string {
  const base = process.env.PUBLIC_BASE_URL?.replace(/\/+$/, "");
  if (base) return base;
  return `${req.protocol}://${req.get("host") ?? "localhost"}`;
}

function page(title: string, description: string, body: string, og?: OgMeta): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <meta name="description" content="${escapeHtml(description)}">${ogMetaHtml(og)}
  <style>
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    body { margin: 0; padding: 2rem 1.25rem; max-width: 44rem; margin-inline: auto;
      font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; line-height: 1.65; }
    h1 { font-size: 1.5rem; letter-spacing: -0.01em; }
    a { color: inherit; }
    .price { font-size: 1.4rem; font-weight: 650; margin: .4rem 0 1rem; }
    .meta { opacity: .8; font-size: .95rem; margin: .2rem 0; }
    .badge { display: inline-block; border: 1px solid rgba(127,127,127,.5); border-radius: 999px;
      padding: .1rem .6rem; font-size: .85rem; margin-right: .35rem; }
    .desc { white-space: pre-wrap; margin: 1rem 0; }
    .card { border: 1px solid rgba(127,127,127,.3); border-radius: 12px; padding: 1rem 1.2rem; margin: .8rem 0; }
    .card a { text-decoration: none; }
    .card .p { font-weight: 650; }
    .gallery img { max-width: 100%; border-radius: 12px; display: block; margin: .5rem 0; border: 1px solid var(--line, rgba(127,127,127,.3)); }
    .upload { border: 1px dashed rgba(127,127,127,.5); border-radius: 12px; padding: .8rem 1rem; margin: 1rem 0; font-size: .95rem; }
    .upload button { margin-left: .5rem; }
    form { display: flex; gap: .5rem; margin: 1rem 0; }
    input { flex: 1; padding: .6rem .8rem; font: inherit; border-radius: 10px;
      border: 1px solid rgba(127,127,127,.5); background: transparent; color: inherit; }
    button { padding: .6rem 1.1rem; font: inherit; border-radius: 10px; cursor: pointer;
      border: 1px solid rgba(127,127,127,.5); background: rgba(127,127,127,.15); color: inherit; }
    .sold { opacity: .55; }
    .pagination { display: flex; gap: 1.25rem; margin: 1.1rem 0; align-items: baseline; }
  </style>
</head>
<body>
${body}
</body>
</html>`;
}

export async function itemPage(req: Request, res: Response): Promise<void> {
  const item = await getItem(req.params.id).catch(() => null);
  if (!item || item.status === "deleted") {
    res.status(404).send(page("Not found — Thingery", "Item not found", "<h1>Not found</h1><p>This item does not exist or was removed.</p><p><a href=\"/browse\">← Browse listings</a></p>"));
    return;
  }

  const viewer = await sellerFromSession(req).catch(() => null);
  const isOwner = Boolean(viewer && viewer.id === item.seller_id);

  const sold = item.status !== "active";
  const attributesHtml = Object.keys(item.attributes ?? {}).length
    ? `<p class="meta">${Object.entries(item.attributes)
        .map(([k, v]) => `<span class="badge">${escapeHtml(k.replaceAll("_", " "))}: ${escapeHtml(v)}</span>`)
        .join(" ")}</p>`
    : "";

  const imagesHtml = item.images.length
    ? `<div class="gallery">${item.images
        .map((src) => `<img src="${escapeHtml(src)}" alt="${escapeHtml(item.title)}" loading="lazy">`)
        .join("\n")}</div>`
    : `<p class="meta">No photos yet.</p>`;

  const uploadHtml = isOwner
    ? `<div class="upload">
        <strong>Add photos</strong> (jpg/png/webp/gif, up to 5 MB each)
        <form id="upload-form" data-item-id="${escapeHtml(item.id)}">
          <input type="file" id="file" accept="image/jpeg,image/png,image/webp,image/gif" required>
          <button type="submit">Upload</button>
        </form>
        <span class="meta" id="upload-status"></span>
      </div>
      <script src="/upload.js" defer></script>`
    : "";

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "Product",
    name: item.title,
    description: item.description,
    brand: item.brand ? { "@type": "Brand", name: item.brand } : undefined,
    itemCondition: `https://schema.org/${item.condition === "like_new" ? "RefurbishedCondition" : item.condition === "new" ? "NewCondition" : "UsedCondition"}`,
    offers: {
      "@type": "Offer",
      price: (item.price_cents / 100).toFixed(2),
      priceCurrency: item.currency,
      availability: sold ? "https://schema.org/SoldOut" : "https://schema.org/InStock",
    },
  };

  const body = `
  <p class="meta"><a href="/browse">← Browse</a> · <a href="/">Thingery</a></p>
  <h1>${escapeHtml(item.title)}</h1>
  <p class="price ${sold ? "sold" : ""}">${escapeHtml(money(item.price_cents, item.currency))}${sold ? ` · ${escapeHtml(item.status)}` : ""}</p>
  ${imagesHtml}
  ${uploadHtml}
  <p class="meta">
    <span class="badge">condition: ${escapeHtml(item.condition.replaceAll("_", " "))}</span>
    <span class="badge">category: ${escapeHtml(item.category)}</span>
    ${item.brand ? `<span class="badge">brand: ${escapeHtml(item.brand)}</span>` : ""}
    ${item.shipping_tier !== "unknown" ? `<span class="badge">ships: ${escapeHtml(item.shipping_tier)}</span>` : ""}
    ${item.location ? `<span class="badge">📍 ${escapeHtml(item.location)}</span>` : ""}
  </p>
  ${attributesHtml}
  <div class="desc">${escapeHtml(item.description) || "<em>No description provided.</em>"}</div>
  <p class="meta">Listed ${new Date(item.created_at).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })} ·
  To buy, message the seller through the assistant that showed you this listing.</p>
  <script type="application/ld+json">${safeJsonLd(jsonLd)}</script>`;

  const baseUrl = baseUrlFromRequest(req);
  const firstImage = item.images[0];
  const og: OgMeta = {
    title: item.title,
    description: `${money(item.price_cents, item.currency)} — used, ${item.condition.replaceAll("_", " ")}`,
    siteName: "Thingery",
    url: `${baseUrl}/item/${item.id}`,
    image: firstImage ? (firstImage.startsWith("/") ? `${baseUrl}${firstImage}` : firstImage) : undefined,
    twitterCard: item.images.length ? "summary_large_image" : "summary",
  };

  res.send(page(item.title, `${money(item.price_cents, item.currency)} — used, ${item.condition}`, body, og));
}

export async function browsePage(req: Request, res: Response): Promise<void> {
  const q = typeof req.query.q === "string" ? req.query.q.slice(0, 200) : undefined;
  const pageNum = parsePageParam(req.query.page);
  const offset = (pageNum - 1) * BROWSE_PAGE_SIZE;
  const items = await searchItems({ q, limit: BROWSE_PAGE_SIZE, offset }).catch(() => [] as Array<ItemRow & { score: number }>);

  const cards = items
    .map(
      (i) => `<div class="card ${i.status !== "active" ? "sold" : ""}">
      <a href="/item/${escapeHtml(i.id)}"><strong>${escapeHtml(i.title)}</strong></a><br>
      <span class="p">${escapeHtml(money(i.price_cents, i.currency))}</span>
      <span class="meta"> · ${escapeHtml(i.condition.replaceAll("_", " "))} · ${escapeHtml(i.category)}${i.location ? ` · 📍 ${escapeHtml(i.location)}` : ""}${i.status !== "active" ? ` · ${escapeHtml(i.status)}` : ""}</span>
    </div>`,
    )
    .join("\n");

  const body = `
  <p class="meta"><a href="/">Thingery</a> — the open item database for AI agents</p>
  <h1>Browse used items</h1>
  <form action="/browse" method="get">
    <input name="q" value="${escapeHtml(q ?? "")}" placeholder="Search listings… e.g. sneakers, camera, pen" autofocus>
    <button type="submit">Search</button>
  </form>
  ${items.length ? cards : `<p class="meta">No listings match${q ? ` “${escapeHtml(q)}”` : ""} yet.</p>`}
  ${(() => {
    const { hasPrev, hasNext } = browsePageNav(pageNum, items.length);
    if (!hasPrev && !hasNext) return "";
    return `<nav class="pagination" aria-label="Pagination">
      ${hasPrev ? `<a rel="prev" href="${escapeHtml(browsePageUrl(pageNum - 1, q))}">← Previous</a>` : ""}
      <span class="meta">Page ${pageNum}</span>
      ${hasNext ? `<a rel="next" href="${escapeHtml(browsePageUrl(pageNum + 1, q))}">Next →</a>` : ""}
    </nav>`;
  })()}
  <p class="meta">Listings are published by AI agents on behalf of their owners. <a href="/login.html">Sell something yourself →</a></p>`;

  const title = q ? `${q} — Browse — Thingery` : "Browse used items — Thingery";
  const description = "Browse second-hand listings published through Thingery.";
  res.send(page(title, description, body, { title, description }));
}
