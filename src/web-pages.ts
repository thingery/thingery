// Human-facing HTML pages a self-hosted server still renders itself: public
// item and wanted pages (MCP tools link to /item/<id> and /wanted/<id>) and
// the Stripe order/payout return pages. Server-rendered, crawler-friendly (also for LLM browsing
// agents), no JS needed. The public website lives in the private web app.

import type { NextFunction, Request, Response } from "express";
import { buyerShippingCents, getItem } from "./items.js";
import { MAX_IMAGES_PER_ITEM } from "./images.js";
import { sellerFromSession } from "./auth.js";
import { pool } from "./db.js";
import { budgetRange, getWanted, wantedFreshness } from "./wanted-feed.js";
import { orderFlowConfig } from "./config.js";
import { classifyVisitOrigin, logPageView } from "./analytics.js";

/** Contextual HTML escaping for every interpolated value (text + attribute
 *  contexts). Exported since THI-569: the admin pages (src/routes.ts §admin
 *  UI) render through the same discipline — B2 in the THI-566 review makes
 *  output encoding a named requirement for server-rendered admin HTML. */
export const escapeHtml = (value: unknown): string =>
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

/** Open Graph / Twitter Card meta for link unfurling (chat apps, social, launch posts).
 *  `canonical` also renders a <link rel="canonical"> tag — the absolute URL
 *  crawlers and scrapers should treat as the one true address of the page
 *  (query strings stripped, e.g. utm_* share-tracking params, so tracking
 *  links never split the index or the unfurl identity — THI-396). */
export interface OgMeta {
  title?: string;
  description?: string;
  siteName?: string;
  url?: string;
  image?: string;
  /** Alt text for og:image / twitter:image (also an a11y hint for scrapers). */
  imageAlt?: string;
  /** twitter:card value, e.g. "summary_large_image"; rendered with name= instead of property=. */
  twitterCard?: string;
  /** Absolute canonical URL; renders <link rel="canonical"> alongside the og: tags. */
  canonical?: string;
}

/** Renders og:/twitter: meta tags (plus the canonical link when set);
 *  empty fields are omitted, values HTML-escaped. */
export function ogMetaHtml(og: OgMeta | undefined): string {
  if (!og) return "";
  const propertyTags: Array<[name: string, value: string | undefined]> = [
    ["og:title", og.title],
    ["og:description", og.description],
    ["og:site_name", og.siteName],
    ["og:url", og.url],
    ["og:image", og.image],
    ["og:image:alt", og.imageAlt],
  ];
  const lines = propertyTags
    .filter(([, value]) => value)
    .map(([name, value]) => `  <meta property="${name}" content="${escapeHtml(value)}">`);
  if (og.twitterCard) {
    lines.push(`  <meta name="twitter:card" content="${escapeHtml(og.twitterCard)}">`);
  }
  if (og.canonical) {
    lines.push(`  <link rel="canonical" href="${escapeHtml(og.canonical)}">`);
  }
  return lines.length ? `\n${lines.join("\n")}` : "";
}

/** Canonical origin for absolute URLs: PUBLIC_BASE_URL when set, else the request origin. */
function baseUrlFromRequest(req: Request): string {
  const base = process.env.PUBLIC_BASE_URL?.replace(/\/+$/, "");
  if (base) return base;
  return `${req.protocol}://${req.get("host") ?? "localhost"}`;
}

/** Minimal server-rendered page shell shared by every website page (and, since
 *  THI-569, the admin dispute pages — spec docs/specs/admin-dispute-ui.md
 *  PR-B: the admin pages reuse this helper; no client framework). */
export function page(title: string, description: string, body: string, og?: OgMeta, noindex = false): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="icon" type="image/svg+xml" href="/assets/favicon.svg">
  <link rel="icon" type="image/png" sizes="32x32" href="/assets/favicon-32x32.png">
  <link rel="icon" type="image/png" sizes="16x16" href="/assets/favicon-16x16.png">
  <link rel="icon" href="/assets/favicon.ico" sizes="48x48">
  <link rel="apple-touch-icon" href="/assets/apple-touch-icon.png">
  <title>${escapeHtml(title)}</title>
  <meta name="description" content="${escapeHtml(description)}">${noindex ? '\n  <meta name="robots" content="noindex">' : ""}${ogMetaHtml(og)}
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
    .upload input[type="file"] { display: none; }
    .upload .pick { display: inline-block; padding: .6rem 1.1rem; margin: .35rem .5rem .35rem 0; font: inherit; border-radius: 10px;
      cursor: pointer; border: 1px solid #019686; background: rgba(1,150,134,.12); color: inherit; }
    .upload .pick.primary { background: #019686; color: #fff; }
    .upload.drag { outline: 2px dashed #019686; outline-offset: 4px; }
    .upload.at-cap .pick { opacity: .5; cursor: not-allowed; }
    .banner-warn { border: 1px solid #b45309; background: rgba(180,83,9,.12); border-radius: 12px; padding: .6rem 1rem; margin: 1rem 0; }
    .thumb { position: relative; display: inline-block; margin: .35rem .4rem 0 0; }
    .thumb img { width: 64px; height: 64px; object-fit: cover; border-radius: 8px;
      border: 1px solid rgba(127,127,127,.3); display: block; }
    .thumb .thumb-del { position: absolute; right: -7px; top: -7px; width: 22px; height: 22px; padding: 0;
      line-height: 1; border-radius: 50%; font-size: .9rem; background: rgba(0,0,0,.75); color: #fff; }
    .thumb.dragging img { outline: 2px dashed #019686; outline-offset: 2px; }
    .thumb img { cursor: grab; }
    .cover-badge { position: absolute; left: 4px; top: 4px; font-size: .65rem;
      background: rgba(0,0,0,.65); color: #fff; border-radius: 6px; padding: 0 .3rem; }
    .photo-row { font-size: .9rem; opacity: .9; margin: .25rem 0; }
    .photo-state { margin-left: .5rem; }
    form { display: flex; gap: .5rem; margin: 1rem 0; }
    input { flex: 1; padding: .6rem .8rem; font: inherit; border-radius: 10px;
      border: 1px solid rgba(127,127,127,.5); background: transparent; color: inherit; }
    button { padding: .6rem 1.1rem; font: inherit; border-radius: 10px; cursor: pointer;
      border: 1px solid rgba(127,127,127,.5); background: rgba(127,127,127,.15); color: inherit; }
    .sold { opacity: .55; }
    /* Wanted listings UX (THI-441, spec THI-439 §6) — WANTED visual language:
       chip + budget as a RANGE, freshness line, never a single price badge. */
    .wanted-chip { display: inline-block; border: 1px solid #019686; background: rgba(1,150,134,.14);
      color: inherit; border-radius: 6px; padding: .05rem .5rem; font-size: .8rem; font-weight: 700;
      letter-spacing: .06em; margin-right: .45rem; }
    .wanted-budget { font-weight: 650; }
    .fresh { opacity: .75; font-size: .85rem; margin: .15rem 0 0; }
    .fresh.expiring { opacity: 1; color: #b45309; }
    .funnel { border: 1px solid #019686; background: rgba(1,150,134,.08); border-radius: 12px;
      padding: 1rem 1.2rem; margin: 1.1rem 0; }
    /* THI-445: EN/IT toggle shared by the server-rendered pages. */
    .lang-bar { display: flex; justify-content: flex-end; margin: 0 0 .25rem; }
    .lang-switch { display: inline-flex; border: 1px solid rgba(127,127,127,.4); border-radius: 999px; overflow: hidden; flex: none; }
    .lang-btn { display: inline-flex; align-items: center; gap: .35rem; font: inherit; font-size: .78rem;
      font-weight: 650; letter-spacing: .02em; padding: .32rem .62rem; border: none; background: transparent;
      color: inherit; opacity: .75; cursor: pointer; }
    .lang-btn:hover { opacity: 1; }
    .lang-btn .lang-flag { width: 1.15em; height: auto; border-radius: 2px; display: block; }
    .lang-btn[aria-pressed="true"] { background: rgba(127,127,127,.18); opacity: 1; }
  </style>
</head>
<body>
<div class="lang-bar"><div class="lang-switch" data-lang-switch></div></div>
${body}
<script src="/i18n.js"></script>
</body>
</html>`;
}

/** GET / — the landing page moved to the private web app, so a self-hosted
 *  server sends visitors (and every "Thingery" home link on these pages) to
 *  the account page instead of a 404. */
export function rootRedirect(_req: Request, res: Response): void {
  res.redirect(302, "/login.html");
}

export async function itemPage(req: Request, res: Response): Promise<void> {
  const item = await getItem(req.params.id).catch(() => null);
  if (!item || item.status === "deleted") {
    res.status(404).send(page("Not found — Thingery", "Item not found", `<h1 data-i18n="item.nfH1">Not found</h1><p data-i18n="item.nfP">This item does not exist or was removed.</p><p><a href="/">Thingery</a></p>`));
    return;
  }

  const viewer = await sellerFromSession(req).catch(() => null);
  const isOwner = Boolean(viewer && viewer.id === item.seller_id);

  const sold = item.status !== "active";
  // THI-396: base URL is needed before the body (CTA + share button carry
  // absolute URLs); PUBLIC_BASE_URL wins so prod pages are deterministic.
  const baseUrl = baseUrlFromRequest(req);
  const canonicalUrl = `${baseUrl}/item/${item.id}`;
  // Payments are "on" for a listing only when the deployment has Stripe
  // configured AND this seller finished payout onboarding (§11.2) — the
  // same predicate order-flow uses to allow a stripe-mode order.
  const paymentsOn = orderFlowConfig().stripePaymentsEnabled && item.seller_payout_ready === true;
  // THI-396: obvious next action + one-tap share. Sold listings keep their
  // stable URL/OG card (no churn after a sale) but drop the action block.
  const ctaHtml = sold
    ? ""
    : `<div class="cta" id="next-step">
      <div class="cta-row">
        <button class="share-btn" id="share-btn" type="button" data-share-url="${escapeHtml(canonicalUrl)}" data-share-title="${escapeHtml(item.title)}" data-i18n="item.share">🔗 Share</button>
      </div>
      <p class="meta">${
        paymentsOn
          ? `<span data-i18n="item.payOn">Card payments are on — your AI assistant's order gets a secure Stripe checkout link.</span>`
          : `<span data-i18n="item.payOff">To buy, ask your AI assistant (Claude, ChatGPT, …) — it connects via MCP and arranges everything with the seller.</span>`
      }</p>
    </div>
    <script src="/share.js" defer></script>`;
  // THI-308 PR 3: derived pending state — same pure predicate as the feed
  // gate (src/items.ts FEED_VISIBLE minus the status term; non-active items
  // are already out of every feed). Zero-photo pending listings render for
  // direct visitors but get the placeholder + a crawler-visible noindex.
  const pending = item.photo_required && item.images.length === 0;
  const attributesHtml = Object.keys(item.attributes ?? {}).length
    ? `<p class="meta">${Object.entries(item.attributes)
        .map(([k, v]) => `<span class="badge">${escapeHtml(k.replaceAll("_", " "))}: ${escapeHtml(v)}</span>`)
        .join(" ")}</p>`
    : "";

  const imagesHtml = item.images.length
    ? `<div class="gallery" id="item-gallery">${item.images
        // THI-130 (THI-128 review follow-up): never send the viewer's referrer to
        // arbitrary https image hosts — partial mitigation for the accepted H3
        // residual risk (tracking pixels still learn the viewer's IP).
        .map((src) => `<img src="${escapeHtml(src)}" alt="${escapeHtml(item.title)}" loading="lazy" referrerpolicy="no-referrer">`)
        .join("\n")}</div>`
    : `<div class="gallery" id="item-gallery"><img id="item-placeholder" src="/assets/placeholder-item.svg" alt="No photos yet" width="640" height="480" loading="lazy" referrerpolicy="no-referrer"></div>`;

  // THI-308 PR 3: owner-only capture panel at the top of the owner area,
  // replacing the old single-file form. "Take photo" (capture="environment")
  // opens the camera in one tap; the snap auto-uploads — <= 2 taps to the
  // first photo. photos.js (static file, CSP-safe) adds drag-drop, paste,
  // per-file progress + retry, and disables the inputs at the 12-photo cap.
  const thumb = (src: string, i: number) =>
    `<span class="thumb">${i === 0 ? `<span class="cover-badge">cover</span>` : ""}<img src="${escapeHtml(src)}" alt="" loading="lazy" referrerpolicy="no-referrer"></span>`;
  const uploadHtml = isOwner
    ? `${pending ? `<p class="banner-warn" id="pending-banner" role="status">This listing is hidden from search until you add a photo.</p>` : ""}
      <div class="upload" id="photo-zone" data-item-id="${escapeHtml(item.id)}" data-image-count="${item.images.length}" data-max-images="${MAX_IMAGES_PER_ITEM}" data-images="${escapeHtml(JSON.stringify(item.images))}">
        <label class="pick primary">📷 Take photo<input type="file" id="photo-take" accept="image/*" capture="environment"></label>
        <label class="pick">🖼️ Choose photos<input type="file" id="photo-choose" accept="image/jpeg,image/png,image/webp,image/gif" multiple></label>
        <span class="meta">or drop / paste here · <span id="photo-count">${item.images.length}/${MAX_IMAGES_PER_ITEM}</span> · drag thumbnails to reorder</span>
        <p class="meta">Listings with photos get far more views. First photo publishes the listing. jpg/png/webp/gif up to 5 MB each —
        compressed in your browser, re-encoded and metadata-stripped server-side.</p>
        <div id="photo-strip">${item.images.map(thumb).join("")}</div>
        <div id="photo-status" aria-live="polite"></div>
      </div>
      <script src="/imaging.js" defer></script>
      <script src="/photos.js" defer></script>`
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

  const shippingCents = buyerShippingCents(item);

  // SECURITY invariant (THI-445 review): data-i18n-cond / data-i18n-status
  // attribute values below are interpolated WITHOUT escapeHtml. That is safe
  // only while item.condition and item.status stay closed enums — CHECK
  // constrained in db/schema.sql and mirrored in the zod schemas. If either is
  // ever widened to free text, escape it at these interpolation sites or you
  // open an attribute-injection hole.
  const body = `
  <p class="meta"><a href="/">Thingery</a></p>
  <h1>${escapeHtml(item.title)}</h1>
  <p class="price ${sold ? "sold" : ""}">${escapeHtml(money(item.price_cents, item.currency))}${sold ? ` · <span data-i18n-status="${item.status}">${escapeHtml(item.status)}</span>` : ""}</p>
  ${shippingCents > 0 ? `<p class="meta"><span data-i18n="item.plusShipping">+ shipping:</span> ${escapeHtml(money(shippingCents, item.currency))} · <span data-i18n="item.total">total:</span> ${escapeHtml(money(item.price_cents + shippingCents, item.currency))}</p>` : ""}
  ${ctaHtml}
  ${imagesHtml}
  ${uploadHtml}
  <p class="meta">
    <span class="badge"><span data-i18n="item.cond">condition:</span> <span data-i18n-cond="${item.condition}">${escapeHtml(item.condition.replaceAll("_", " "))}</span></span>
    <span class="badge"><span data-i18n="item.cat">category:</span> ${escapeHtml(item.category)}</span>
    ${item.brand ? `<span class="badge"><span data-i18n="item.brand">brand:</span> ${escapeHtml(item.brand)}</span>` : ""}
    ${item.shipping_tier !== "unknown" ? `<span class="badge"><span data-i18n="item.ships">ships:</span> ${escapeHtml(item.shipping_tier)}</span>` : ""}
    ${item.location ? `<span class="badge">📍 ${escapeHtml(item.location)}</span>` : ""}
  </p>
  ${attributesHtml}
  <div class="desc">${escapeHtml(item.description) || `<em data-i18n="item.noDesc">No description provided.</em>`}</div>
  <p class="meta"><span data-i18n="item.listed">Listed</span> ${new Date(item.created_at).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })} ·
  <span data-i18n="item.toBuy">To buy, message the seller through the assistant that showed you this listing.</span></p>
  <script type="application/ld+json">${safeJsonLd(jsonLd)}</script>`;

  const firstImage = item.images[0];
  // Photo listings unfurl with their cover photo; photo-less ones fall back
  // to the branded 1200×630 og-image so every shared link still renders a
  // large card (THI-396). Item photos are absolute or root-relative — the
  // branded fallback is always root-relative, so absolutize both.
  const ogImage = firstImage
    ? firstImage.startsWith("/")
      ? `${baseUrl}${firstImage}`
      : firstImage
    : `${baseUrl}/assets/og-image.png`;
  const og: OgMeta = {
    title: item.title,
    description: `${money(item.price_cents, item.currency)} — used, ${item.condition.replaceAll("_", " ")}${item.location ? ` · ${item.location}` : ""}`,
    siteName: "Thingery",
    url: canonicalUrl,
    canonical: canonicalUrl,
    image: ogImage,
    imageAlt: item.title,
    twitterCard: "summary_large_image",
  };

  // THI-396: capture visit origin at request time. Canonical URLs are
  // query-string-free (PR #166), so referrer/utm context exists only here —
  // it cannot be reconstructed from the URL later. One `page_view` line per
  // successful render; 404s and analytics failures emit nothing.
  logPageView({ itemId: item.id, owner: isOwner, ...classifyVisitOrigin(req) });

  res.send(page(item.title, `${money(item.price_cents, item.currency)} — used, ${item.condition}`, body, og, pending));
}

/** GET /wanted/:id — public detail page. Unknown ids render the 404 shape
 *  (no existence oracle); expired wanteds keep their URL but get noindex
 *  (spec §6.1). Kept for self-hosters: MCP wanted tools return
 *  <PUBLIC_BASE_URL>/wanted/<id> links. Response lane: sellers respond via
 *  their AI agent calling respond_to_wanted. */
export async function wantedDetailPage(req: Request, res: Response): Promise<void> {
  const id = String(req.params.id ?? "");
  const w = UUID_RE.test(id) ? await getWanted(id).catch(() => null) : null;
  if (!w) {
    res.status(404).send(page("Not found — Thingery", "Wanted listing not found", `<h1>Not found</h1><p>This wanted listing does not exist or has ended.</p><p><a href="/">Thingery</a></p>`));
    return;
  }
  const fresh = wantedFreshness(w.created_at, w.expires_at);
  const expired = fresh.expired || w.status !== "active";
  const baseUrl = baseUrlFromRequest(req);
  const respondCta = expired
    ? `<p class="meta">This wanted listing has ended — the buyer is no longer accepting responses.</p>`
    : `<div class="funnel">
      <strong>Have this?</strong>
      <p class="meta">Respond with a real listing — the buyer is notified when it goes live. Ask your AI agent:
      <em>“call respond_to_wanted with wanted_id ${escapeHtml(w.id)}”</em>.</p>
    </div>`;
  const body = `
  <p class="meta"><a href="/">Thingery</a></p>
  <h1>${escapeHtml(w.title)}</h1>
  <p><span class="wanted-chip">WANTED</span><span class="wanted-budget">${escapeHtml(budgetRange(w.budget_min_cents, w.budget_max_cents, w.currency))}</span></p>
  <p class="fresh ${fresh.expiringSoon ? "expiring" : ""}">${escapeHtml(fresh.text)}</p>
  ${respondCta}
  ${w.reference_images.length ? `<div class="gallery">${w.reference_images.map((src) => `<img src="${escapeHtml(src)}" alt="" loading="lazy" referrerpolicy="no-referrer">`).join("")}</div>` : ""}
  <p class="meta">
    <span class="badge">category: ${escapeHtml(w.category)}</span>
    ${w.condition ? `<span class="badge">condition wanted: ${escapeHtml(w.condition.replaceAll("_", " "))}</span>` : `<span class="badge">any condition</span>`}
    <span class="badge">currency: ${escapeHtml(w.currency)}</span>
  </p>
  <div class="desc">${escapeHtml(w.notes) || "<em>No further details provided.</em>"}</div>
  <p class="meta">Wanted listings carry no contact details — sellers respond with listings, never messages.</p>`;
  const title = `${w.title} — Wanted — Thingery`;
  const description = `Buyer wants ${w.title} — budget ${budgetRange(w.budget_min_cents, w.budget_max_cents, w.currency)}${w.category ? `, ${w.category}` : ""}.`;
  res.send(page(title, description, body, { title, description, url: `${baseUrl}/wanted/${w.id}`, canonical: `${baseUrl}/wanted/${w.id}` }, expired));
}

/** Order payment-return page (spec THI-3 §4.3, finding F15).
 *
 * Serves as the Stripe Checkout `success_url` and the manual order-status
 * landing page. It is a capability URL: anyone holding the order UUID may
 * learn the order's *status* and nothing else — no item title, price, party
 * names, or addresses. Without an authenticated party session that is the
 * entire surface (richer order pages are a follow-up). Hardened per F15:
 * `Cache-Control: no-store`, `Referrer-Policy: same-origin` (the UUID must
 * not leak via outbound referrers), and unknown/malformed ids render the
 * identical page shape so the page is not an order-existence oracle. */
const ORDER_STATUS_LABELS: Record<string, string> = {
  pending: "Awaiting payment",
  sold: "Paid — awaiting shipment",
  label_issued: "Label issued — awaiting carrier pickup",
  in_transit: "In transit",
  delivered: "Delivered — dispute window open",
  disputed: "Delivered — under dispute review",
  payout_pending: "Delivered — seller payout scheduled",
  paid_out: "Complete — seller paid",
  cancelled: "Cancelled",
  refunded: "Refunded",
};

function orderReturnBody(status: string | null): string {
  const label = status ? (ORDER_STATUS_LABELS[status] ?? status) : "Order not found";
  const hint = status
    ? `<p class="meta">Your assistant can track this order, record tracking, confirm receipt,
    open a dispute, or release the seller's payout — ask it to check the order status.</p>`
    : `<p class="meta">This link is not a valid order. If you just paid, return to your assistant
    and ask it to check the order status.</p>`;
  return `
  <p class="meta"><a href="/">Thingery</a> — the open item database for AI agents</p>
  <h1>Order status</h1>
  <p class="price">${escapeHtml(label)}</p>
  ${hint}
  <p class="meta">Thingery is the open item database and MCP server for AI agents to list,
  find, and trade second-hand goods.</p>`;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function orderReturnPage(req: Request, res: Response): Promise<void> {
  // F15: capability URL — never cached, never leaked via referrer.
  res.set("Cache-Control", "no-store");
  res.set("Referrer-Policy", "same-origin");

  const id = String(req.params.id ?? "");
  let status: string | null = null;
  if (UUID_RE.test(id)) {
    const { rows } = await pool
      .query<{ status: string }>("SELECT status FROM orders WHERE id = $1", [id])
      .catch(() => ({ rows: [] as Array<{ status: string }> }));
    status = rows[0]?.status ?? null;
  }
  // Same template and 200 for known and unknown ids alike — no existence oracle.
  res.send(page("Order status — Thingery", "Order status", orderReturnBody(status)));
}

/** Seller return page from Stripe Express payout onboarding (the Checkout
 *  account-link `return_url`). Static content only — no order data, no DB. */
export async function payoutSetupReturnPage(_req: Request, res: Response): Promise<void> {
  res.set("Cache-Control", "no-store");
  const body = `
  <p class="meta"><a href="/">Thingery</a> — the open item database for AI agents</p>
  <h1>Payout setup</h1>
  <p class="price">Back from payout onboarding</p>
  <p class="meta">If you finished the steps, your account is being verified — payouts unlock a few
  minutes later. Ask your assistant to check your payout setup status; it can hand you a fresh
  onboarding link if anything is still missing.</p>
  <p class="meta">Thingery is the open item database and MCP server for AI agents to list,
  find, and trade second-hand goods.</p>`;
  res.send(page("Payout setup — Thingery", "Payout setup", body));
}

/** Terminal error middleware for the website surface (THI-54).
 *
 * Mounted last in src/index.ts, after the page routes and the static
 * mounts. asyncHandler-wrapped page handlers forward rejections here —
 * Express 4 never routes async rejections to error middleware on its own,
 * so before THI-54 a handler bug throwing after an await was an unhandled
 * rejection: a hung response and, on Node >= 15, a dead process. Mirrors
 * the /api middleware (THI-58): genuine body-parser faults keep their 4xx
 * status (F4); everything else — including a handler error carrying a
 * forged or real .status — fails closed to a generic 500 (N1); no error
 * detail reaches the body (F5); faults are logged server-side; and
 * in-flight (headers-sent) responses are destroyed, nothing appended. */
export function websiteErrorMiddleware(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  const parserErr = err as { type?: unknown; status?: unknown };
  let status = 500;
  let heading = "Something went wrong";
  let message = "This page could not be loaded. Please try again.";
  if (
    typeof parserErr.type === "string" &&
    parserErr.type.startsWith("entity.") &&
    typeof parserErr.status === "number" &&
    parserErr.status >= 400 &&
    parserErr.status < 500
  ) {
    status = parserErr.status;
    heading = status === 413 ? "Request too large" : "Request could not be read";
    message = status === 413 ? "The request body was too large." : "The request body could not be read.";
  }
  console.error("website error:", req.method, req.path, "->", status);
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.set("Cache-Control", "no-store");
  res
    .status(status)
    .type("html")
    .send(
      page(
        `${heading} — Thingery`,
        heading,
        `<h1>${heading}</h1><p>${message}</p><p><a href="/">Thingery</a></p>`,
      ),
    );
}
