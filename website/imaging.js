// website/imaging.js — client-side photo compression (THI-308 PR 3).
// Pure helpers (dimensions, quality ladder, size budget, GIF pass-through)
// are exported for unit tests; compressImage() drives the browser pipeline.
// Bandwidth optimization only — the server pipeline stays the security and
// quality enforcer (THI-314 F8: no new attack surface). No inline handlers,
// no HTML string sinks; CSP stays script-src 'self'.
(function (global) {
  "use strict";

  var MAX_LONG_EDGE = 1600;
  var SIZE_BUDGET_BYTES = 500 * 1024; // ~500 KB per photo target
  var QUALITY_LADDER = [0.8, 0.6, 0.45];

  /** GIFs pass through untouched: the server stores animated GIFs as stills
   *  regardless, so re-encoding them client-side only wastes battery. */
  function shouldPassThrough(file) {
    return file.type === "image/gif" || /\.gif$/i.test(file.name || "");
  }

  /** Downscale so the long edge is <= MAX_LONG_EDGE; aspect preserved;
   *  never upscales. Returns null for invalid dimensions. */
  function targetDimensions(width, height) {
    if (!isFinite(width) || !isFinite(height) || width <= 0 || height <= 0) return null;
    var longEdge = Math.max(width, height);
    if (longEdge <= MAX_LONG_EDGE) return { width: Math.round(width), height: Math.round(height) };
    var scale = MAX_LONG_EDGE / longEdge;
    return { width: Math.round(width * scale), height: Math.round(height * scale) };
  }

  /** True when an encoded blob is over the per-photo budget. */
  function isOverBudget(blob) {
    return blob.size > SIZE_BUDGET_BYTES;
  }

  function initialQuality() {
    return QUALITY_LADDER[0];
  }

  /** Next JPEG quality after `quality`, or null at the ladder floor. */
  function nextQuality(quality) {
    var i = QUALITY_LADDER.indexOf(quality);
    return i === -1 || i + 1 >= QUALITY_LADDER.length ? null : QUALITY_LADDER[i + 1];
  }

  function toJpeg(canvas, quality) {
    return new Promise(function (resolve) {
      canvas.toBlob(resolve, "image/jpeg", quality);
    });
  }

  /** Full browser pipeline. EXIF orientation is baked client-side via
   *  createImageBitmap(imageOrientation: "from-image") — defense in depth;
   *  the server re-orients regardless. Returns the ORIGINAL file for
   *  pass-through types and for decode/encode failures (the server still
   *  validates and re-encodes everything it accepts). */
  async function compressImage(file) {
    if (shouldPassThrough(file)) return file;
    var bitmap = null;
    try {
      bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    } catch (e) {
      try {
        bitmap = await createImageBitmap(file); // older browsers
      } catch (e2) {
        return file;
      }
    }
    var dims = targetDimensions(bitmap.width, bitmap.height);
    if (!dims) {
      bitmap.close();
      return file;
    }
    var canvas = document.createElement("canvas");
    canvas.width = dims.width;
    canvas.height = dims.height;
    canvas.getContext("2d").drawImage(bitmap, 0, 0, dims.width, dims.height);
    bitmap.close();
    var quality = initialQuality();
    var blob = await toJpeg(canvas, quality);
    while (blob && isOverBudget(blob) && nextQuality(quality) !== null) {
      quality = nextQuality(quality);
      blob = await toJpeg(canvas, quality);
    }
    return blob || file;
  }

  var api = {
    MAX_LONG_EDGE: MAX_LONG_EDGE,
    SIZE_BUDGET_BYTES: SIZE_BUDGET_BYTES,
    QUALITY_LADDER: QUALITY_LADDER,
    shouldPassThrough: shouldPassThrough,
    targetDimensions: targetDimensions,
    isOverBudget: isOverBudget,
    initialQuality: initialQuality,
    nextQuality: nextQuality,
    compressImage: compressImage,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api; // unit tests (Node)
  global.ThingeryImaging = api; // browser + vitest global shim
})(typeof window !== "undefined" ? window : globalThis);
