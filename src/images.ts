// Item image storage: files on disk (uploads/items/…), URLs in the items.images array.
// Self-hosted and dependency-free; swap for object storage at federation scale.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pool } from "./db.js";

const EXTENSION_BY_MEDIA_TYPE: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MB per image

// THI-110 (docs/security.md §6 H3): upload abuse controls. Constants live in
// code, deliberately not env-configurable — same posture as src/items.ts.
export const MAX_IMAGES_PER_ITEM = 12; // matches create_listing's z.array().max(12) in src/tools.ts
export const MAX_UPLOADS_PER_SELLER_PER_DAY = 100;
export const MAX_UPLOAD_BYTES_PER_SELLER_PER_DAY = 200 * 1024 * 1024; // 200 MB

/**
 * Detects the actual image format from magic bytes (H3 content validation).
 * Returns the canonical media type, or null when the bytes are not a real
 * JPEG (FF D8 FF), PNG (89 50 4E 47), WebP (RIFF…WEBP), or GIF (GIF8) image.
 */
export function detectImageMediaType(
  data: Buffer,
): "image/jpeg" | "image/png" | "image/webp" | "image/gif" | null {
  if (data.length >= 12) {
    const riff = data.subarray(0, 4).toString("latin1");
    const fmt = data.subarray(8, 12).toString("latin1");
    if (riff === "RIFF" && fmt === "WEBP") return "image/webp";
  }
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
  if (data.length >= 4 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) {
    return "image/png";
  }
  if (data.length >= 4 && data.subarray(0, 4).toString("latin1") === "GIF8") return "image/gif";
  return null;
}

export function extensionForMediaType(mediaType: string): string | null {
  return EXTENSION_BY_MEDIA_TYPE[mediaType.toLowerCase()] ?? null;
}

export function uploadsDir(): string {
  return process.env.UPLOADS_DIR ?? path.resolve(process.cwd(), "uploads");
}

/** Strips an optional data-URL prefix ("data:image/png;base64,….") from base64 input. */
export function stripDataUrl(base64: string): string {
  return base64.startsWith("data:") ? base64.slice(base64.indexOf(",") + 1) : base64;
}

/** Validates, stores one image for an item (owner-checked), appends the URL to images[]. */
export async function addItemImage(
  sellerId: string,
  itemId: string,
  data: Buffer,
  mediaType: string,
): Promise<{ url: string } | { error: string }> {
  const declared = mediaType.trim().toLowerCase();
  const ext = extensionForMediaType(declared);
  if (!ext) return { error: `unsupported media type '${mediaType}' (use jpeg, png, webp or gif)` };
  if (data.length === 0) return { error: "empty image" };
  if (data.length > MAX_IMAGE_BYTES) return { error: "image too large (max 5 MB)" };

  // H3: the declared type is client-controlled; the bytes are not. Reject
  // anything whose magic bytes are not a real image, or don't match the claim.
  const detected = detectImageMediaType(data);
  if (!detected) {
    return { error: "unrecognized image data — expected real jpeg, png, webp or gif bytes" };
  }
  if (detected !== declared) {
    return { error: `content-type '${declared}' does not match the actual image format (${detected})` };
  }

  // Ownership + per-item cap in one read (images is TEXT[]: empty arrays give
  // NULL from array_length, hence the coalesce). The check-then-append race is
  // acceptable at this scale (single instance, THI-110 design note).
  const owned = await pool.query(
    `SELECT coalesce(array_length(images, 1), 0) AS image_count FROM items WHERE id = $1 AND seller_id = $2`,
    [itemId, sellerId],
  );
  if (!owned.rows[0]) return { error: "item not found or not owned by this seller" };
  if ((owned.rows[0].image_count ?? 0) >= MAX_IMAGES_PER_ITEM) {
    return { error: `image limit reached for this item (max ${MAX_IMAGES_PER_ITEM})` };
  }

  // H3: per-seller daily quota (count + bytes) as one atomic conditional
  // upsert: the increment applies only while both caps hold, so concurrent
  // uploads serialize on the row lock and cannot overshoot. Zero rows back =
  // over quota. The quota is consumed before the file write — on a write
  // failure the seller has spent quota without a stored image, which fails
  // closed (over-counting, never under-counting) and is the safe direction.
  const quota = await pool.query(
    `INSERT INTO seller_upload_quota (seller_id, day, uploads, bytes)
     VALUES ($1, CURRENT_DATE, 1, $2)
     ON CONFLICT (seller_id, day) DO UPDATE
       SET uploads = seller_upload_quota.uploads + 1,
           bytes   = seller_upload_quota.bytes + EXCLUDED.bytes
     WHERE seller_upload_quota.uploads < $3
       AND seller_upload_quota.bytes + EXCLUDED.bytes <= $4
     RETURNING uploads`,
    [sellerId, data.length, MAX_UPLOADS_PER_SELLER_PER_DAY, MAX_UPLOAD_BYTES_PER_SELLER_PER_DAY],
  );
  if (quota.rows.length === 0) {
    return {
      error: `daily upload quota exceeded (max ${MAX_UPLOADS_PER_SELLER_PER_DAY} uploads or ${
        MAX_UPLOAD_BYTES_PER_SELLER_PER_DAY / (1024 * 1024)
      } MB per day) — try again tomorrow`,
    };
  }

  const dir = path.join(uploadsDir(), "items");
  await mkdir(dir, { recursive: true });
  const name = `${itemId}-${Date.now().toString(36)}.${ext}`;
  await writeFile(path.join(dir, name), data);

  const url = `/img/items/${name}`;
  await pool.query(`UPDATE items SET images = images || $2 WHERE id = $1`, [itemId, [url]]);
  return { url };
}

/** Decodes base64 input (with optional data-URL prefix) and stores it. */
export async function addItemImageBase64(
  sellerId: string,
  itemId: string,
  base64: string,
  mediaType: string,
): Promise<{ url: string } | { error: string }> {
  let data: Buffer;
  try {
    data = Buffer.from(stripDataUrl(base64), "base64");
  } catch {
    return { error: "invalid base64 image data" };
  }
  return addItemImage(sellerId, itemId, data, mediaType);
}
