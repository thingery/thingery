// Backfill for the re-encode pipeline (spec THI-156 rev 2, ADR 0004): migrate
// pre-existing item uploads that predate ingest re-encoding. Every file under
// UPLOADS_DIR/items goes through the SAME pipeline as new uploads — the
// reencodeImage import below is the ingest code path, never a fork.
//
// Before each overwrite the original is moved to a dated sibling backup dir
// OUTSIDE the uploads tree (nothing is ever deleted — purge is DevOps' step).
// Idempotent (F9): files that are already clean (≤ 2000 px, no metadata) are
// skipped, so re-runs only churn what still needs work, and a crash mid-run
// leaves at worst an unmigrated original plus its backup copy to re-run over.

import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
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
 * metadata (PNG text chunks, GIF comment extensions). Undecodable → false,
 * so the pipeline runs and records a classified failure instead. */
async function isAlreadyClean(data: Buffer, mediaType: string): Promise<boolean> {
  if (mediaType === "image/png" && pngHasMetadataChunks(data)) return false;
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
    names = (await readdir(itemsDir, { withFileTypes: true })).filter((e) => e.isFile()).map((e) => e.name);
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
    // Original leaves the served tree first, then the sanitized copy takes
    // its name. A crash between the two leaves the original safe in backup.
    await mkdir(backupDir, { recursive: true });
    summary.backupDir = backupDir;
    await rename(file, path.join(backupDir, name));
    await writeFile(file, out.data);
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
