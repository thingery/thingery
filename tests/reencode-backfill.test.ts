// THI-165 (spec THI-156 rev 2, F9): backfill script tests — re-encodes dirty
// pre-existing uploads in place via the ingest pipeline, moves originals to a
// backup dir OUTSIDE the served tree, skips already-clean files (idempotent),
// leaves failures untouched, and hard-fails when the backup path would land
// inside the uploads tree. Fixtures are generated at test time (same approach
// as tests/image-reencode.test.ts); no DB needed.

import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runBackfill } from "../scripts/reencode-existing-uploads.js";
import { reencodeImage } from "../src/images.js";

// --- fixture builders (copied minimally from tests/image-reencode.test.ts) --

/** JPEG with GPS lat/long + Make/Model EXIF. (sharp's Exif typing omits the
 * GPS IFD, so the object is built as a variable — runtime accepts it; same
 * fixture approach as tests/image-reencode.test.ts.) */
const gpsExif = {
  IFD0: { Make: "ProbeCam", Model: "ProbeModel X100" },
  GPS: {
    GPSLatitudeRef: "N",
    GPSLatitude: "46/1 30/1 0/1",
    GPSLongitudeRef: "E",
    GPSLongitude: "7/1 58/1 0/1",
  },
} as { IFD0: Record<string, string>; GPS: Record<string, string> };

async function gpsJpeg(): Promise<Buffer> {
  return sharp({ create: { width: 400, height: 300, channels: 3, background: "#778899" } })
    .withExif(gpsExif)
    .jpeg()
    .toBuffer();
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
  return Buffer.concat([base.subarray(0, trailer - 4), text, lenField, base.subarray(trailer)]);
}

/** Two-frame animated GIF with a spliced-in comment extension (0x21 0xFE). */
async function animatedGifWithComment(): Promise<Buffer> {
  const frame = (color: string) =>
    sharp({ create: { width: 32, height: 32, channels: 3, background: color } }).gif().toBuffer();
  const [g1, g2] = await Promise.all([frame("#ff0000"), frame("#0000ff")]);
  const packed = g2[10];
  const gctSize = 3 * (1 << ((packed & 0x07) + 1));
  const imageBlock = 13 + gctSize;
  const comment = Buffer.concat([
    Buffer.from([0x21, 0xfe, 11]),
    Buffer.from("GIFCOMMENT!", "latin1"),
    Buffer.from([0x00]),
  ]);
  return Buffer.concat([
    g1.subarray(0, g1.length - 1),
    comment,
    g2.subarray(imageBlock),
    Buffer.from([0x3b]),
  ]);
}

async function jpegMagicJunk(): Promise<Buffer> {
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from("junk-not-a-jpeg-stream", "latin1")]);
}

// --- backfill tests ----------------------------------------------------------

describe("reencode-existing-uploads backfill (THI-165 / THI-156 F9)", () => {
  let tmpRoot: string;
  let uploads: string;
  let backup: string;

  beforeAll(async () => {
    tmpRoot = await mkdtemp(path.join(os.tmpdir(), "thi165-backfill-"));
    uploads = path.join(tmpRoot, "uploads");
    backup = path.join(tmpRoot, "uploads-backup-test");
    await mkdir(path.join(uploads, "items"), { recursive: true });
    await mkdir(path.join(uploads, "items", "subdir-ignored"), { recursive: true });

    const clean = await reencodeImage(await gpsJpeg(), "image/jpeg");
    if (!("data" in clean)) throw new Error("fixture: reencodeImage failed for clean jpeg");
    await writeFile(path.join(uploads, "items", "a-dirty-gps.jpg"), await gpsJpeg());
    await writeFile(path.join(uploads, "items", "b-already-clean.jpg"), clean.data);
    await writeFile(
      path.join(uploads, "items", "c-oversize.jpg"),
      await sharp({ create: { width: 2600, height: 1200, channels: 3, background: "#445566" } }).jpeg().toBuffer(),
    );
    await writeFile(path.join(uploads, "items", "d-text-chunk.png"), await pngWithTextChunk());
    await writeFile(path.join(uploads, "items", "e-comment.gif"), await animatedGifWithComment());
    await writeFile(path.join(uploads, "items", "f-corrupt.jpg"), await jpegMagicJunk());
    await writeFile(path.join(uploads, "items", "g-not-an-image.txt"), Buffer.from("hello"));
  });

  afterAll(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it("re-encodes dirty uploads in place, skips clean ones, records failures", async () => {
    const summary = await runBackfill(uploads, backup);
    expect(summary).toMatchObject({ processed: 4, skipped: 1, failed: 2 });
    expect(summary.failures.map((f) => f.file).sort()).toEqual(["f-corrupt.jpg", "g-not-an-image.txt"]);
    expect(summary.backupDir).toBe(path.resolve(backup));

    // Dirty GPS JPEG: sanitized in place (no EXIF, dims kept), original with
    // its EXIF preserved in the backup dir outside the served tree.
    const inPlace = await sharp(await readFile(path.join(uploads, "items", "a-dirty-gps.jpg"))).metadata();
    expect(inPlace.exif).toBeUndefined();
    expect(inPlace.width).toBe(400);
    expect(inPlace.height).toBe(300);
    const original = await sharp(await readFile(path.join(backup, "a-dirty-gps.jpg"))).metadata();
    expect(original.exif).toBeDefined();

    // Oversize: downscaled to the 2000 px long-edge budget.
    const resized = await sharp(await readFile(path.join(uploads, "items", "c-oversize.jpg"))).metadata();
    expect(Math.max(resized.width ?? 0, resized.height ?? 0)).toBeLessThanOrEqual(2000);

    // PNG text chunk stripped at the container level.
    expect((await readFile(path.join(uploads, "items", "d-text-chunk.png"))).includes("PNGTEXT-SECRET")).toBe(false);
    expect((await readFile(path.join(backup, "d-text-chunk.png"))).includes("PNGTEXT-SECRET")).toBe(true);

    // GIF comment stripped, animation flattened to a single-frame still.
    const gif = await readFile(path.join(uploads, "items", "e-comment.gif"));
    expect(gif.includes(Buffer.from("GIFCOMMENT!", "latin1"))).toBe(false);
    expect(gif.includes(Buffer.from([0x21, 0xfe]))).toBe(false);
    expect((await sharp(gif).metadata()).pages ?? 1).toBeLessThanOrEqual(1);
    expect((await readFile(path.join(backup, "e-comment.gif"))).includes(Buffer.from("GIFCOMMENT!", "latin1"))).toBe(
      true,
    );

    // Failures and non-files are left exactly where they were, not backed up.
    expect((await readFile(path.join(uploads, "items", "f-corrupt.jpg"))).includes(Buffer.from("junk-not-a-jpeg"))).toBe(
      true,
    );
    expect((await readFile(path.join(uploads, "items", "g-not-an-image.txt"))).toString()).toBe("hello");
    expect((await readdir(path.join(uploads, "items"))).includes("subdir-ignored")).toBe(true);
    expect((await readdir(backup)).sort()).toEqual([
      "a-dirty-gps.jpg",
      "d-text-chunk.png",
      "e-comment.gif",
      "c-oversize.jpg",
    ].sort());
  });

  it("is idempotent: a re-run skips every now-clean file and adds no backups", async () => {
    const summary = await runBackfill(uploads, backup);
    expect(summary).toMatchObject({ processed: 0, skipped: 5, failed: 2 });
    expect((await readdir(backup)).length).toBe(4);
  });

  it("hard-fails when the backup path resolves inside the uploads tree (F9)", async () => {
    await expect(runBackfill(uploads, path.join(uploads, "uploads-backup-inside"))).rejects.toThrow(/refusing to run/);
    await expect(runBackfill(uploads, path.join(uploads, "items", "..", "back"))).rejects.toThrow(/refusing to run/);
  });

  it("returns an empty summary when the items dir does not exist", async () => {
    const empty = path.join(tmpRoot, "uploads-empty");
    const summary = await runBackfill(empty, path.join(tmpRoot, "uploads-backup-empty"));
    expect(summary).toMatchObject({ processed: 0, skipped: 0, failed: 0, backupDir: null });
  });
});
