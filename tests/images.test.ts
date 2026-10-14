import { describe, expect, it } from "vitest";
import {
  detectImageMediaType,
  extensionForMediaType,
  stripDataUrl,
  MAX_IMAGE_BYTES,
  MAX_IMAGES_PER_ITEM,
  MAX_UPLOADS_PER_SELLER_PER_DAY,
  MAX_UPLOAD_BYTES_PER_SELLER_PER_DAY,
} from "../src/images.js";

describe("extensionForMediaType", () => {
  it("maps supported image types", () => {
    expect(extensionForMediaType("image/jpeg")).toBe("jpg");
    expect(extensionForMediaType("image/png")).toBe("png");
    expect(extensionForMediaType("image/webp")).toBe("webp");
    expect(extensionForMediaType("image/gif")).toBe("gif");
  });

  it("rejects unsupported and hostile types", () => {
    expect(extensionForMediaType("application/pdf")).toBeNull();
    expect(extensionForMediaType("text/html")).toBeNull();
    expect(extensionForMediaType("")).toBeNull();
  });

  it("is case-insensitive", () => {
    expect(extensionForMediaType("Image/PNG")).toBe("png");
  });
});

describe("stripDataUrl", () => {
  it("strips data-URL prefixes", () => {
    expect(stripDataUrl("data:image/png;base64,AAAA")).toBe("AAAA");
  });

  it("leaves plain base64 untouched", () => {
    expect(stripDataUrl("AAAA")).toBe("AAAA");
  });

  it("only strips at data: start (commas inside base64 are safe)", () => {
    expect(stripDataUrl("AA/AA+BB==")).toBe("AA/AA+BB==");
  });
});

describe("MAX_IMAGE_BYTES", () => {
  it("caps at 5 MB", () => {
    expect(MAX_IMAGE_BYTES).toBe(5 * 1024 * 1024);
  });
});

describe("detectImageMediaType (THI-110 magic-byte validation)", () => {
  it("recognizes real JPEG, PNG, WebP and GIF signatures", () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
    expect(detectImageMediaType(jpeg)).toBe("image/jpeg");

    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
    expect(detectImageMediaType(png)).toBe("image/png");

    const webp = Buffer.concat([Buffer.from("RIFF", "latin1"), Buffer.alloc(4), Buffer.from("WEBP", "latin1"), Buffer.alloc(4)]);
    expect(detectImageMediaType(webp)).toBe("image/webp");

    expect(detectImageMediaType(Buffer.from("GIF89a\u0000\u0000\u0000", "latin1"))).toBe("image/gif");
    expect(detectImageMediaType(Buffer.from("GIF87a\u0000\u0000\u0000", "latin1"))).toBe("image/gif");
  });

  it("rejects garbage, text and RIFF containers that are not WebP", () => {
    expect(detectImageMediaType(Buffer.from("hello world!"))).toBeNull();
    expect(detectImageMediaType(Buffer.from("<?php echo 1; ?>"))).toBeNull();
    expect(detectImageMediaType(Buffer.from("%PDF-1.7 fake jpg"))).toBeNull();
    // RIFF container with a non-WEBP form (e.g. WAV) must not pass as an image.
    const wave = Buffer.concat([Buffer.from("RIFF", "latin1"), Buffer.alloc(4), Buffer.from("WAVE", "latin1"), Buffer.alloc(4)]);
    expect(detectImageMediaType(wave)).toBeNull();
  });

  it("rejects truncated/empty buffers", () => {
    expect(detectImageMediaType(Buffer.alloc(0))).toBeNull();
    expect(detectImageMediaType(Buffer.from([0xff, 0xd8]))).toBeNull();
    expect(detectImageMediaType(Buffer.from([0x89, 0x50]))).toBeNull();
    // RIFF without the WEBP tag at offset 8 is too short / not WebP.
    expect(detectImageMediaType(Buffer.from("RIFF\u0000\u0000\u0000\u0000", "latin1"))).toBeNull();
  });
});

describe("upload abuse-control constants (THI-110)", () => {
  it("caps items at 12 images, sellers at 100 uploads / 200 MB per day", () => {
    expect(MAX_IMAGES_PER_ITEM).toBe(12);
    expect(MAX_UPLOADS_PER_SELLER_PER_DAY).toBe(100);
    expect(MAX_UPLOAD_BYTES_PER_SELLER_PER_DAY).toBe(200 * 1024 * 1024);
  });
});
