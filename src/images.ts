// Item image storage: files on disk (uploads/items/…), URLs in the items.images array.
// Self-hosted and dependency-free; swap for object storage at federation scale.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { pool } from "./db.js";
import { logSecurityEvent, type SecurityEventReason } from "./security-events.js";

// --- startup hardening (spec THI-156 rev 2, Security review THI-159 F2/F4) ---
//
// F4 loader allowlist: block every VipsForeignLoad subclass, then re-enable
// only the *buffer* loaders for the four formats the upload path accepts.
// SVG/HEIF/PDF/Magick loaders stay blocked process-wide, so even a bug in the
// magic-byte allowlist upstream cannot hand an untrusted format to libvips.
// GIF is decoded by libnsgif on the libvips sharp bundles (verified at
// runtime); VipsForeignLoadGifBuffer is re-enabled too for giflib builds.
sharp.block({ operation: ["VipsForeignLoad"] });
sharp.unblock({
  operation: [
    "VipsForeignLoadJpegBuffer",
    "VipsForeignLoadPngBuffer",
    "VipsForeignLoadWebpBuffer",
    "VipsForeignLoadNsgifBuffer",
    "VipsForeignLoadGifBuffer",
  ],
});
// Bound decode worker threads and disable the libvips cache: re-encodes are
// one-shot, so caching only pins decoded pixels in memory (F2).
sharp.concurrency(2);
sharp.cache(false);

const EXTENSION_BY_MEDIA_TYPE: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MB per image

// --- re-encode pipeline constants (spec THI-156 rev 2) ---
export const MAX_INPUT_PIXELS = 50_000_000; // decode bomb guard: 50 MP
export const MAX_DIMENSION = 2000; // stored images fit inside 2000×2000

/**
 * Fast-fail semaphore (THI-156, ~20 lines, no new dependency): at most 2
 * concurrent re-encodes per process. Saturated → the caller rejects fast
 * (429-style "try again") instead of queueing — a waiting queue of decoded
 * images is exactly the peak-memory cost the cap exists to bound.
 */
export class FastFailSemaphore {
  private inFlight = 0;
  constructor(readonly max: number) {}
  tryAcquire(): boolean {
    if (this.inFlight >= this.max) return false;
    this.inFlight += 1;
    return true;
  }
  release(): void {
    this.inFlight = Math.max(0, this.inFlight - 1);
  }
  get size(): number {
    return this.inFlight;
  }
}
export const reencodeSemaphore = new FastFailSemaphore(2);

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

/** Same-family re-encode settings; `.withMetadata()` is never called — the
 * whole point of the pipeline is that nothing (EXIF/GPS/XMP) survives. */
function applyReencode(pipeline: ReturnType<typeof sharp>, mediaType: string): ReturnType<typeof sharp> {
  switch (mediaType) {
    case "image/jpeg":
      return pipeline.jpeg({ quality: 82, mozjpeg: true });
    case "image/png":
      return pipeline.png({ compressionLevel: 6 });
    case "image/webp":
      return pipeline.webp({ quality: 82 });
    default:
      // GIF: `animated: false` (set in the constructor) reads only the first
      // frame, so the re-encode writes a single-frame still.
      return pipeline.gif();
  }
}

/**
 * Re-encodes an already-validated upload through sharp (spec THI-156 rev 2):
 * auto-orient, downscale to ≤ 2000 px, same-family re-encode with all
 * metadata stripped. Originals are never persisted — only this buffer is.
 * Rejects with a fixed `reason` slug (logged as a security event, no payload)
 * and a client-safe message; buffer contents are never echoed back.
 */
export async function reencodeImage(
  data: Buffer,
  mediaType: string,
): Promise<{ data: Buffer } | { reason: SecurityEventReason | null; message: string }> {
  if (!reencodeSemaphore.tryAcquire()) {
    // Load-shed, not an integrity failure and not client error — no security
    // event slug for it; the quota spent on this attempt fails closed.
    return { reason: null, message: "image server is busy — try again shortly" };
  }
  try {
    const pipeline = sharp(data, {
      limitInputPixels: MAX_INPUT_PIXELS,
      failOn: "warning",
      sequentialRead: true,
      animated: false, // GIF first frame only — the constructor default, explicit
    });
    let output: Buffer;
    try {
      output = await applyReencode(
        pipeline
          .autoOrient() // bake EXIF orientation in before metadata is stripped
          .resize({
            width: MAX_DIMENSION,
            height: MAX_DIMENSION,
            fit: "inside",
            withoutEnlargement: true,
          }),
        mediaType,
      ).toBuffer();
    } catch (err) {
      return classifyDecodeError(err);
    }
    if (output.length > MAX_IMAGE_BYTES) {
      return { reason: "output_too_large", message: "re-encoded image exceeds the 5 MB limit — try a smaller image" };
    }
    if (detectImageMediaType(output) !== mediaType) {
      return { reason: "reencode_failed", message: "image could not be re-encoded — try a standard jpeg, png, webp or gif" };
    }
    return { data: output };
  } finally {
    reencodeSemaphore.release();
  }
}

function classifyDecodeError(err: unknown): { reason: SecurityEventReason; message: string } {
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes("pixel limit")) {
    return { reason: "pixel_limit", message: `image dimensions exceed the ${MAX_INPUT_PIXELS / 1_000_000}-megapixel limit` };
  }
  return { reason: "decode_failed", message: "image could not be decoded — the file may be corrupt or truncated" };
}

/** Validates, stores one image for an item (owner-checked), appends the URL to images[]. */
export async function addItemImage(
  sellerId: string,
  itemId: string,
  data: Buffer,
  mediaType: string,
): Promise<{ url: string } | { error: string }> {
  // THI-112 (H4.2): upload accept/reject events. `reason` is a fixed slug,
  // never the raw (attacker-controlled) media type string — the no-payload
  // rule keeps the log free of request content.
  const declared = mediaType.trim().toLowerCase();
  const ext = extensionForMediaType(declared);
  if (!ext) {
    logSecurityEvent({ type: "image_upload", outcome: "rejected", reason: "unsupported_media_type" }, { sellerId });
    return { error: `unsupported media type '${mediaType}' (use jpeg, png, webp or gif)` };
  }
  if (data.length === 0) {
    logSecurityEvent({ type: "image_upload", outcome: "rejected", reason: "empty" }, { sellerId });
    return { error: "empty image" };
  }
  if (data.length > MAX_IMAGE_BYTES) {
    logSecurityEvent({ type: "image_upload", outcome: "rejected", reason: "too_large" }, { sellerId });
    return { error: "image too large (max 5 MB)" };
  }

  // H3: the declared type is client-controlled; the bytes are not. Reject
  // anything whose magic bytes are not a real image, or don't match the claim.
  const detected = detectImageMediaType(data);
  if (!detected) {
    logSecurityEvent({ type: "image_upload", outcome: "rejected", reason: "bad_magic" }, { sellerId });
    return { error: "unrecognized image data — expected real jpeg, png, webp or gif bytes" };
  }
  if (detected !== declared) {
    logSecurityEvent({ type: "image_upload", outcome: "rejected", reason: "media_type_mismatch" }, { sellerId });
    return { error: `content-type '${declared}' does not match the actual image format (${detected})` };
  }

  // Ownership + per-item cap in one read (images is TEXT[]: empty arrays give
  // NULL from array_length, hence the coalesce). The check-then-append race is
  // acceptable at this scale (single instance, THI-110 design note).
  const owned = await pool.query(
    `SELECT coalesce(array_length(images, 1), 0) AS image_count FROM items WHERE id = $1 AND seller_id = $2`,
    [itemId, sellerId],
  );
  if (!owned.rows[0]) {
    logSecurityEvent({ type: "image_upload", outcome: "rejected", reason: "not_owned" }, { sellerId });
    return { error: "item not found or not owned by this seller" };
  }
  if ((owned.rows[0].image_count ?? 0) >= MAX_IMAGES_PER_ITEM) {
    logSecurityEvent({ type: "image_upload", outcome: "rejected", reason: "item_image_limit" }, { sellerId });
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
    logSecurityEvent({ type: "image_upload", outcome: "rejected", reason: "quota_exceeded" }, { sellerId });
    return {
      error: `daily upload quota exceeded (max ${MAX_UPLOADS_PER_SELLER_PER_DAY} uploads or ${
        MAX_UPLOAD_BYTES_PER_SELLER_PER_DAY / (1024 * 1024)
      } MB per day) — try again tomorrow`,
    };
  }

  const dir = path.join(uploadsDir(), "items");
  await mkdir(dir, { recursive: true });
  const name = `${itemId}-${Date.now().toString(36)}.${ext}`;
  // THI-156 re-encode pipeline: only the sanitized buffer is ever written —
  // originals touch neither disk nor object storage. Runs after the quota
  // consume (fail-closed ordering preserved) and before the write.
  const reencoded = await reencodeImage(data, detected);
  if ("reason" in reencoded) {
    if (reencoded.reason !== null) {
      logSecurityEvent({ type: "image_upload", outcome: "rejected", reason: reencoded.reason }, { sellerId });
    }
    return { error: reencoded.message };
  }
  await writeFile(path.join(dir, name), reencoded.data);

  const url = `/img/items/${name}`;
  await pool.query(`UPDATE items SET images = images || $2 WHERE id = $1`, [itemId, [url]]);
  logSecurityEvent({ type: "image_upload", outcome: "success" }, { sellerId });
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
