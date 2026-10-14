// THI-156 rev 2 (spec): sharp re-encode pipeline in addItemImage — EXIF/GPS
// strip, orientation bake-in, decode-bomb guard, GIF first-frame stills,
// output validation, and the fast-fail semaphore. All fixtures are generated
// at test time with sharp (or hand-assembled containers); no binary fixtures
// live in the repo. DB-backed parts follow the image-upload-route test
// pattern; pure-semaphore tests run without a database.

import { readFileSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import sharp from "sharp";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  addItemImage,
  reencodeImage,
  reencodeSemaphore,
  FastFailSemaphore,
  MAX_IMAGE_BYTES,
} from "../src/images.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schemaPath = path.resolve(__dirname, "..", "db", "schema.sql");
const connectionString =
  process.env.DATABASE_URL ?? "postgres://thingery:thingery@localhost:5432/thingery";

async function dbAvailable(): Promise<boolean> {
  const client = new pg.Client({ connectionString, connectionTimeoutMillis: 1500 });
  try {
    await client.connect();
    await client.end();
    return true;
  } catch {
    await client.end().catch(() => {});
    return false;
  }
}
const available = await dbAvailable();

// --- fixture builders (test-time generation, no binary files in repo) -------

/** JPEG with GPS lat/long + Make/Model EXIF (sharp writes GPS as rationals). */
async function gpsJpeg(): Promise<Buffer> {
  return sharp({ create: { width: 400, height: 300, channels: 3, background: "#778899" } })
    .withExif({
      IFD0: { Make: "ProbeCam", Model: "ProbeModel X100" },
      GPS: {
        GPSLatitudeRef: "N",
        GPSLatitude: "46/1 30/1 0/1",
        GPSLongitudeRef: "E",
        GPSLongitude: "7/1 58/1 0/1",
      },
    })
    .jpeg()
    .toBuffer();
}

/** Patches the IFD0 Orientation tag (0x0112): sharp's withExif normalizes it
 *  back to 1, so the SHORT value is written directly into the APP1 segment. */
function patchExifOrientation(buf: Buffer, orientation: number): Buffer {
  const out = Buffer.from(buf);
  let i = 2;
  while (i + 4 < out.length) {
    if (out[i] !== 0xff) break;
    const marker = out[i + 1];
    const segLen = out.readUInt16BE(i + 2);
    if (marker === 0xe1 && out.toString("latin1", i + 4, i + 10) === "Exif\0\0") {
      const tiff = i + 10;
      const le = out.toString("latin1", tiff, tiff + 2) === "II";
      const ifd = tiff + (le ? out.readUInt32LE(tiff + 4) : out.readUInt32BE(tiff + 4));
      const count = le ? out.readUInt16LE(ifd) : out.readUInt16BE(ifd);
      for (let e = 0; e < count; e++) {
        const entry = ifd + 2 + e * 12;
        const tag = le ? out.readUInt16LE(entry) : out.readUInt16BE(entry);
        if (tag === 0x0112) {
          if (le) out.writeUInt16LE(orientation, entry + 8);
          else out.writeUInt16BE(orientation, entry + 8);
          return out;
        }
      }
      throw new Error("fixture: no Orientation entry to patch");
    }
    i += 2 + segLen;
  }
  throw new Error("fixture: no Exif APP1 segment");
}

function crc32(buf: Buffer): number {
  let c, crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = (crc ^ buf[i]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, "latin1"), data])));
  return Buffer.concat([len, Buffer.from(type, "latin1"), data, crc]);
}

/** PNG with a tEXt chunk carrying a secret marker (container-level metadata). */
async function pngWithTextChunk(): Promise<Buffer> {
  const base = await sharp({ create: { width: 120, height: 90, channels: 3, background: "#669933" } })
    .png()
    .toBuffer();
  const trailer = base.lastIndexOf(Buffer.from("IEND", "latin1"));
  const lenField = base.subarray(trailer - 4, trailer);
  const text = pngChunk("tEXt", Buffer.from("Comment\0PNGTEXT-SECRET", "latin1"));
  return Buffer.concat([
    base.subarray(0, trailer - 4),
    text,
    lenField,
    base.subarray(trailer),
  ]);
}

/** WebP carrying an EXIF chunk (withExif) with Make/Model. */
async function webpWithExif(): Promise<Buffer> {
  return sharp({ create: { width: 120, height: 90, channels: 3, background: "#669933" } })
    .withExif({ IFD0: { Make: "ProbeCam", Model: "ProbeModel X100" } })
    .webp()
    .toBuffer();
}

/** Two-frame animated GIF with a spliced-in comment extension (0x21 0xFE). */
async function animatedGifWithComment(): Promise<Buffer> {
  const frame = (color: string) =>
    sharp({ create: { width: 32, height: 32, channels: 3, background: color } }).gif().toBuffer();
  const [g1, g2] = await Promise.all([frame("#ff0000"), frame("#0000ff")]);
  // Offset of the first image block: header(6) + LSD(7) + global color table.
  const packed = g2[10];
  const gctSize = 3 * (1 << ((packed & 0x07) + 1));
  const imageBlock = 13 + gctSize;
  const comment = Buffer.concat([
    Buffer.from([0x21, 0xfe, 11]),
    Buffer.from("GIFCOMMENT!", "latin1"),
    Buffer.from([0x00]),
  ]);
  return Buffer.concat([
    g1.subarray(0, g1.length - 1), // frame 1 without the trailer
    comment,
    g2.subarray(imageBlock), // frame 2's image descriptor + data
    Buffer.from([0x3b]),
  ]);
}

/** PNG bomb: IHDR claims 60000×60000 (3.6 GP) over a ~20-byte body. */
function pngBomb(): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(60000, 0);
  ihdr.writeUInt32BE(60000, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolor
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", Buffer.from([0x78, 0x9c, 0x03, 0x00, 0x00, 0x00, 0x00, 0x01])),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/** JPEG bomb: a real small JPEG with the SOF0 dimensions patched to 60000². */
async function jpegBomb(): Promise<Buffer> {
  const base = await sharp({ create: { width: 64, height: 64, channels: 3, background: "#808080" } })
    .jpeg()
    .toBuffer();
  const sof = base.indexOf(Buffer.from([0xff, 0xc0]));
  const bomb = Buffer.from(base);
  bomb.writeUInt16BE(60000, sof + 5); // height
  bomb.writeUInt16BE(60000, sof + 7); // width
  return bomb;
}

// --- shared test helpers -----------------------------------------------------

/** Captures logSecurityEvent lines (console.log JSON) during a callback. */
let events: Array<{ type: string; outcome?: string; reason?: string }>;
let consoleSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  events = [];
  consoleSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    for (const a of args) {
      if (typeof a === "string" && a.startsWith("{")) {
        try {
          const parsed = JSON.parse(a) as { type?: string };
          if (parsed.type) events.push(parsed as typeof events[number]);
        } catch {
          /* not a security event line */
        }
      }
    }
  });
});
afterEach(() => consoleSpy.mockRestore());

// --- pure semaphore unit tests (no DB) ---------------------------------------

describe("FastFailSemaphore (THI-156 load-shed)", () => {
  it("never queues: the (max+1)-th acquire fails until a slot is released", () => {
    const sem = new FastFailSemaphore(2);
    expect(sem.tryAcquire()).toBe(true);
    expect(sem.tryAcquire()).toBe(true);
    expect(sem.tryAcquire()).toBe(false);
    expect(sem.size).toBe(2);
    sem.release();
    expect(sem.tryAcquire()).toBe(true);
    sem.release();
    sem.release();
    sem.release(); // over-release clamps at zero
    expect(sem.size).toBe(0);
  });

  it("reencodeImage rejects fast (busy) when both process slots are held", async () => {
    expect(reencodeSemaphore.tryAcquire()).toBe(true);
    expect(reencodeSemaphore.tryAcquire()).toBe(true);
    const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#808080" } })
      .png()
      .toBuffer();
    const busy = await reencodeImage(png, "image/png");
    expect("reason" in busy && busy.message).toMatch(/busy — try again shortly/);
    reencodeSemaphore.release();
    reencodeSemaphore.release();
    const ok = await reencodeImage(png, "image/png");
    expect("data" in ok).toBe(true);
  });
});

// --- pipeline tests (DB-backed, addItemImage end to end) ---------------------

describe.skipIf(!available)("image re-encode pipeline (THI-156 rev 2)", () => {
  let db: pg.Client;
  let uploadsTmp: string;
  let n = 0;

  beforeAll(async () => {
    db = new pg.Client({ connectionString });
    await db.connect();
    await db.query(readFileSync(schemaPath, "utf8"));
    await db.query("TRUNCATE items, sellers, seller_upload_quota RESTART IDENTITY CASCADE");
    uploadsTmp = await mkdtemp(path.join(os.tmpdir(), "thi156-uploads-"));
    process.env.UPLOADS_DIR = uploadsTmp;
  });

  afterAll(async () => {
    await db.end();
    delete process.env.UPLOADS_DIR;
    await rm(uploadsTmp, { recursive: true, force: true });
  });

  async function seed(): Promise<{ sellerId: string; itemId: string }> {
    n += 1;
    const tag = `thi156-${n}`;
    const seller = await db.query(
      "INSERT INTO sellers (api_key, display_name, email) VALUES ($1, $2, $3) RETURNING id",
      [`thg_${tag}`, tag, `${tag}@t.dev`],
    );
    const item = await db.query(
      "INSERT INTO items (seller_id, title, price_cents, shipping_price_cents) VALUES ($1, $2, 10000, 500) RETURNING id",
      [seller.rows[0].id, `Re-encode item ${n}`],
    );
    return { sellerId: seller.rows[0].id as string, itemId: item.rows[0].id as string };
  }

  /** Uploads `data`, returns { stored, result } with the on-disk buffer. */
  async function upload(data: Buffer, mediaType: string, itemId?: string) {
    const seedIds = await seed();
    const id = itemId ?? seedIds.itemId;
    const result = await addItemImage(seedIds.sellerId, id, data, mediaType);
    if ("error" in result) return { result, stored: null };
    const name = result.url.split("/").pop() as string;
    const stored = await readFile(path.join(uploadsTmp, "items", name));
    return { result, stored };
  }

  it("strips GPS/EXIF from a JPEG and stores only the re-encode", async () => {
    const input = await gpsJpeg();
    expect(input.includes(Buffer.from("Exif\0\0", "latin1"))).toBe(true); // fixture sanity
    const { result, stored } = await upload(input, "image/jpeg");
    expect("error" in result).toBe(false);
    expect(stored).not.toBeNull();
    expect(stored!.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff])); // JPEG magic
    expect(stored!.includes(Buffer.from("Exif\0\0", "latin1"))).toBe(false);
    expect(stored!.includes("ProbeCam")).toBe(false); // Make
    expect(stored!.includes("ProbeModel")).toBe(false); // Model
    const meta = await sharp(stored!).metadata();
    expect(meta.format).toBe("jpeg");
    expect(meta.exif).toBeUndefined();
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBeLessThanOrEqual(2000);
  });

  it("bakes EXIF orientation 6 in (portrait) and drops the tag", async () => {
    const base = await sharp({ create: { width: 400, height: 300, channels: 3, background: "#778899" } })
      .withExif({ IFD0: { Orientation: "6" } })
      .jpeg()
      .toBuffer();
    const input = patchExifOrientation(base, 6);
    const { result, stored } = await upload(input, "image/jpeg");
    expect("error" in result).toBe(false);
    const meta = await sharp(stored!).metadata();
    expect(meta.orientation).toBeUndefined();
    expect(meta.width).toBe(300); // swapped: renders portrait
    expect(meta.height).toBe(400);
  });

  it("strips PNG tEXt chunks and WebP EXIF chunks", async () => {
    const pngIn = await pngWithTextChunk();
    expect(pngIn.includes("PNGTEXT-SECRET")).toBe(true); // fixture sanity
    const png = await upload(pngIn, "image/png");
    expect("error" in png.result).toBe(false);
    expect(png.stored!.includes("PNGTEXT-SECRET")).toBe(false);
    expect(png.stored!.includes("tEXt")).toBe(false);
    expect(await sharp(png.stored!).metadata()).toMatchObject({ format: "png" });

    const webpIn = await webpWithExif();
    expect(webpIn.includes(Buffer.from("EXIF", "latin1"))).toBe(true); // sanity
    const webp = await upload(webpIn, "image/webp");
    expect("error" in webp.result).toBe(false);
    expect(webp.stored!.includes(Buffer.from("EXIF", "latin1"))).toBe(false);
    expect(webp.stored!.includes("ProbeCam")).toBe(false);
    expect(await sharp(webp.stored!).metadata()).toMatchObject({ format: "webp" });
  });

  it("stores an animated GIF as a first-frame still, comment extensions gone", async () => {
    const input = await animatedGifWithComment();
    const inputMeta = await sharp(input, { animated: true }).metadata();
    expect(inputMeta.pages).toBe(2); // fixture sanity
    expect(input.includes("GIFCOMMENT!")).toBe(true);
    const { result, stored } = await upload(input, "image/gif");
    expect("error" in result).toBe(false);
    const meta = await sharp(stored!, { animated: true }).metadata();
    expect(meta.format).toBe("gif");
    expect(meta.pages).toBe(1);
    expect(stored!.includes("GIFCOMMENT!")).toBe(false);
    expect(stored!.includes(Buffer.from([0x21, 0xfe]))).toBe(false);
  });

  it("rejects corrupt/truncated payloads with decode_failed (no file stored)", async () => {
    const before = (await readdir(path.join(uploadsTmp, "items"))).length;
    const real = await sharp({ create: { width: 200, height: 150, channels: 3, background: "#808080" } })
      .png()
      .toBuffer();
    const truncated = real.subarray(0, Math.floor(real.length / 2));
    const { result } = await upload(truncated, "image/png");
    expect("error" in result && result.error).toMatch(/could not be decoded/i);
    expect(events.find((e) => e.type === "image_upload" && e.reason === "decode_failed")).toBeTruthy();
    // Nothing was stored for the rejected upload.
    expect((await readdir(path.join(uploadsTmp, "items"))).length).toBe(before);
  });

  it("rejects a PNG IHDR bomb (60000×60000, tiny body) fast with pixel_limit", { timeout: 10_000 }, async () => {
    const bomb = pngBomb();
    expect(bomb.length).toBeLessThan(200); // truly tiny
    const { result } = await upload(bomb, "image/png");
    expect("error" in result && result.error).toMatch(/megapixel limit/i);
    expect(events.find((e) => e.reason === "pixel_limit")).toBeTruthy();
  });

  it("rejects a JPEG SOF bomb (60000×60000) fast with pixel_limit", { timeout: 10_000 }, async () => {
    const bomb = await jpegBomb();
    expect(bomb.length).toBeLessThan(500);
    const { result } = await upload(bomb, "image/jpeg");
    expect("error" in result && result.error).toMatch(/megapixel limit/i);
    expect(events.find((e) => e.reason === "pixel_limit")).toBeTruthy();
  });

  it("rejects SVG and HEIF payloads at the magic-byte allowlist (bad_magic)", async () => {
    // The declared type is one of the four allowed ones — only the bytes are
    // hostile — so rejection comes from the magic-byte allowlist (bad_magic),
    // the blocklist + allowlist defense the spec pins (F4).
    const svg = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="red"/></svg>`,
      "utf8",
    );
    const svgRes = await upload(svg, "image/png");
    expect("error" in svgRes.result && svgRes.result.error).toMatch(/unrecognized image data/i);

    const heic = Buffer.concat([
      Buffer.alloc(4),
      Buffer.from("ftypheic", "latin1"),
      Buffer.alloc(16),
    ]);
    const heicRes = await upload(heic, "image/png");
    expect("error" in heicRes.result && heicRes.result.error).toMatch(/unrecognized image data/i);
    expect(events.filter((e) => e.reason === "bad_magic").length).toBeGreaterThanOrEqual(2);
  });

  it("downscales a legal 6000×4000 JPEG to a 2000 px long edge", async () => {
    const input = await sharp({ create: { width: 6000, height: 4000, channels: 3, background: "#808080" } })
      .jpeg()
      .toBuffer();
    const { result, stored } = await upload(input, "image/jpeg");
    expect("error" in result).toBe(false);
    const meta = await sharp(stored!).metadata();
    expect(meta.width).toBe(2000);
    expect(meta.height).toBe(1333);
  });

  it("consumes quota even on decode failure (fail-closed ordering)", async () => {
    const ids = await seed();
    const real = await sharp({ create: { width: 100, height: 100, channels: 3, background: "#808080" } })
      .png()
      .toBuffer();
    const truncated = real.subarray(0, 64);
    const result = await addItemImage(ids.sellerId, ids.itemId, truncated, "image/png");
    expect("error" in result).toBe(true);
    const quota = await db.query(
      "SELECT uploads FROM seller_upload_quota WHERE seller_id = $1 AND day = CURRENT_DATE",
      [ids.sellerId],
    );
    expect(quota.rows[0].uploads).toBe(1);
  });
});
