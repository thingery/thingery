// Backfill for the re-encode pipeline (spec THI-156 rev 2, ADR 0004): migrate
// pre-existing item uploads that predate ingest re-encoding. Every file under
// UPLOADS_DIR/items goes through the SAME pipeline as new uploads — the
// reencodeImage import below is the ingest code path, never a fork.
//
// Before each overwrite the original is preserved in a dated sibling backup
// dir OUTSIDE the uploads tree via a verified copy (fsync + size check), and
// the sanitized file is swapped in with a same-directory atomic rename
// (THI-169: no cross-device rename — the backup dir is a different mount
// under the documented container invocation). Nothing is ever deleted —
// purge is DevOps' step. Idempotent (F9): files that are already clean
// (≤ 2000 px, no metadata — including JPEG COM segments, THI-169 bug 1) are
// skipped, so re-runs only churn what still needs work, and a crash mid-run
// leaves at worst an unmigrated original plus its backup copy to re-run over.

import { mkdir, open, readdir, readFile, rename, stat, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import sharp from "sharp";
import { detectImageMediaType, MAX_DIMENSION, MAX_INPUT_PIXELS, reencodeImage, uploadsDir } from "../src/images.js";

export interface BackfillSummary {
  processed: number;
  skipped: number;
  failed: number;
  failures: { file: string; message: string }[];
  backupDir: string | null;
}

/** Temp-file prefix for the atomic swap. Leftovers from a crashed run are
 * ignored by later runs (filtered out below) rather than treated as items. */
const TEMP_PREFIX = ".backfill-tmp-";

/** True when a JPEG carries a COM (0xFFFE) segment before SOS — the classic
 * hiding spot for tool/origin strings (eBay/ImageMagick markers and the like;
 * found live in prod, THI-169 bug 1). sharp's metadata() never surfaces COM
 * segments, so this is a raw marker walk: SOI, then marker/length pairs.
 * Standalone markers (RSTn/TEM/SOI) carry no length; fill bytes are skipped.
 * Desync or a truncated walk reads as "no COM" — sharp still parses the file,
 * so genuinely corrupt input fails closed through the decode path. */
function jpegHasComSegment(data: Buffer): boolean {
  if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) return false;
  let off = 2;
  while (off + 2 <= data.length) {
    if (data[off] !== 0xff) return false; // desynchronized from the marker stream
    const marker = data[off + 1];
    if (marker === 0xff) {
      off++; // fill byte — the marker follows the run of 0xFFs
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      off += 2; // standalone marker, no length field
      continue;
    }
    if (off + 4 > data.length) return false;
    if (marker === 0xfe) return true; // COM
    if (marker === 0xda) return false; // SOS — entropy-coded data follows; stop
    off += 2 + data.readUInt16BE(off + 2);
  }
  return false;
}

/** True when a PNG carries chunks outside the structural allowlist — tEXt,
 * iTXt, zTXt, eXIf and friends are exactly the metadata the pipeline strips,
 * and sharp's metadata() does not surface plain text chunks. pHYs is sharp's
 * own default density chunk (no user data), so it counts as clean. */
function pngHasMetadataChunks(data: Buffer): boolean {
  let off = 8; // skip the PNG signature
  while (off + 12 <= data.length) {
    const len = data.readUInt32BE(off);
    const type = data.toString("latin1", off + 4, off + 8);
    if (!["IHDR", "PLTE", "tRNS", "pHYs", "IDAT", "IEND"].includes(type)) return true;
    off += 12 + len;
  }
  return false;
}

/** Already clean = what the pipeline itself would produce: dimensions inside
 * the budget, no EXIF/XMP/IPTC/ICC, single-frame, and no container-level
 * metadata (JPEG COM segments, PNG text chunks, GIF comment extensions —
 * none of which sharp's metadata() reports as fields). Undecodable → false,
 * so the pipeline runs and records a classified failure instead. */
async function isAlreadyClean(data: Buffer, mediaType: string): Promise<boolean> {
  if (mediaType === "image/png" && pngHasMetadataChunks(data)) return false;
  if (mediaType === "image/jpeg" && jpegHasComSegment(data)) return false;
  if (mediaType === "image/gif" && data.includes(Buffer.from([0x21, 0xfe]))) return false; // comment extension
  try {
    const meta = await sharp(data, { limitInputPixels: MAX_INPUT_PIXELS }).metadata();
    return (
      (meta.width ?? Infinity) <= MAX_DIMENSION &&
      (meta.height ?? Infinity) <= MAX_DIMENSION &&
      !meta.exif &&
      !meta.xmp &&
      !meta.iptc &&
      !meta.icc &&
      !meta.hasProfile &&
      (meta.orientation ?? 1) <= 1 &&
      (mediaType !== "image/gif" || (meta.pages ?? 1) <= 1)
    );
  } catch {
    return false;
  }
}

/** Durable, cross-filesystem-safe write: open → write → fsync → close, then
 * verify the on-disk size. Used for both the backup copy (the backup dir may
 * be a host bind mount while uploads live on the docker volume) and the swap
 * temp file. A short/failed write throws instead of leaving a silent fake. */
async function writeVerified(dest: string, data: Buffer): Promise<void> {
  const fh = await open(dest, "w");
  try {
    await fh.writeFile(data);
    await fh.sync();
  } finally {
    await fh.close();
  }
  const { size } = await stat(dest);
  if (size !== data.length) {
    throw new Error(`size verify failed for ${dest}: ${size} bytes on disk, ${data.length} expected`);
  }
}

export async function runBackfill(uploadsPath: string, backupPath: string): Promise<BackfillSummary> {
  const uploads = path.resolve(uploadsPath);
  const backupDir = path.resolve(backupPath);
  // F9 assert: the backup dir must live OUTSIDE the uploads tree — guards a
  // future UPLOADS_DIR env change that would make the "sibling" a child.
  const rel = path.relative(uploads, backupDir);
  if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) {
    throw new Error(`refusing to run: backup dir ${backupDir} is inside the uploads tree ${uploads}`);
  }
  const summary: BackfillSummary = { processed: 0, skipped: 0, failed: 0, failures: [], backupDir: null };
  const itemsDir = path.join(uploads, "items");
  let names: string[];
  try {
    names = (await readdir(itemsDir, { withFileTypes: true }))
      .filter((e) => e.isFile() && !e.name.startsWith(TEMP_PREFIX)) // ignore crashed-run temp leftovers
      .map((e) => e.name);
  } catch {
    return summary; // no items dir → nothing to backfill
  }
  for (const name of names) {
    const file = path.join(itemsDir, name);
    let data: Buffer;
    try {
      data = await readFile(file);
    } catch (err) {
      summary.failed++, summary.failures.push({ file: name, message: `unreadable: ${String(err)}` });
      continue;
    }
    const mediaType = detectImageMediaType(data);
    if (!mediaType) {
      summary.failed++, summary.failures.push({ file: name, message: "unrecognized image data (bad magic)" });
      continue;
    }
    if (await isAlreadyClean(data, mediaType)) {
      summary.skipped++;
      continue;
    }
    const out = await reencodeImage(data, mediaType);
    if ("reason" in out) {
      summary.failed++, summary.failures.push({ file: name, message: out.message });
      continue;
    }
    // The original is preserved first via a verified copy (the backup dir may
    // be on a different filesystem, which is fine for a copy), then the
    // sanitized buffer replaces the file through a temp file created NEXT TO
    // the final path — same filesystem, so the swap is an atomic rename with
    // no EXDEV (THI-169 bug 2: uploads volume vs backup bind mount). A crash
    // at any point leaves the served tree holding either the full original or
    // the full cleaned file — never a hole, never a truncated file.
    await mkdir(backupDir, { recursive: true });
    summary.backupDir = backupDir;
    try {
      await writeVerified(path.join(backupDir, name), data);
      const tmp = path.join(itemsDir, `${TEMP_PREFIX}${name}-${process.pid}-${randomUUID()}`);
      try {
        await writeVerified(tmp, out.data);
        await rename(tmp, file);
        try {
          const dir = await open(itemsDir, "r"); // best-effort dir fsync so the rename is durable
          await dir.sync();
          await dir.close();
        } catch {
          /* not all platforms/filesystems support directory fsync */
        }
      } catch (err) {
        await unlink(tmp).catch(() => {}); // best-effort temp cleanup; the original is untouched
        throw err;
      }
    } catch (err) {
      summary.failed++, summary.failures.push({ file: name, message: `swap failed: ${String(err)}` });
      continue;
    }
    summary.processed++;
  }
  return summary;
}

// --- CLI entry (npm run backfill:reencode) ----------------------------------

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const uploads = uploadsDir();
  const backup = path.join(path.dirname(uploads), `uploads-backup-${new Date().toISOString().slice(0, 10)}`);
  const summary = await runBackfill(uploads, backup);
  console.log(`backfill: ${summary.processed} processed, ${summary.skipped} skipped, ${summary.failed} failed`);
  if (summary.backupDir) console.log(`originals preserved in ${summary.backupDir} (purge is a separate DevOps step)`);
  for (const f of summary.failures) console.log(`  failed: ${f.file} — ${f.message}`);
  const { pool } = await import("../src/db.js"); // images.ts imports it transitively
  await pool.end();
  process.exitCode = summary.failed > 0 ? 1 : 0;
}
