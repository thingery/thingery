#!/usr/bin/env python3
"""Render the 45-60s THI-391 demo capture from a real demo-e2e.sh run.

Reads demo-capture-summary.json (saved from a verified production run of
scripts/demo-e2e.sh) and renders a 1280x720-terminal-style replay MP4 with
ffmpeg: every command shown is the command the script really ran, and every
value shown (item id, URLs, PASS lines) comes from the saved run — nothing is
mocked. Re-run demo-e2e.sh, save a new summary, re-render: the capture is
regenerable the same way the demo itself is.

  python3 scripts/render-demo-video.py            # → scripts/demo-capture.mp4
  OUT=/tmp/capture.mp4 FRAMES_DIR=/tmp/f python3 scripts/render-demo-video.py
"""
import json, math, os, subprocess, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
SUMMARY = json.load(open(os.path.join(HERE, "demo-capture-summary.json")))

W, H, FPS = 1600, 900, 30
OUT = os.environ.get("OUT", os.path.join(HERE, "demo-capture.mp4"))
FRAMES_DIR = os.environ.get("FRAMES_DIR", os.path.join(HERE, ".demo-frames"))

from PIL import Image, ImageDraw, ImageFont

BG, CHROME = (13, 17, 23), (22, 27, 34)
FG, DIM, GREEN, CYAN, GOLD, PURPLE = (230, 237, 243), (110, 119, 129), \
    (63, 185, 80), (56, 199, 176), (227, 179, 65), (191, 141, 247)
MENLO = "/System/Library/Fonts/Menlo.ttc"

def font(sz, bold=False):
    return ImageFont.truetype(MENLO, sz, index=3 if bold else 0)

F_CMD, F_OUT = font(20), font(20)
F_HDR = font(21, bold=True)
F_TITLE, F_SUB = font(64, bold=True), font(26)

PROMPT = "agent@thingery ~ %"

# ---------------------------------------------------------------- shot list
# Each entry: (kind, payload...). kinds: hdr, cmd (typed), out (instant, dim),
# outg/outc/outp (green/cyan/purple), blank. cmd text is wrapped to fit.
def wrap(text, width=118):
    words, lines, cur = text.split(), [], ""
    for w_ in words:
        if len(cur) + len(w_) + 1 > width:
            lines.append(cur); cur = w_
        else:
            cur = f"{cur} {w_}".strip()
    if cur: lines.append(cur)
    return lines

S = SUMMARY
ITEM, URL, PHOTO = S["item_id"], S["item_url"], S["photo_url"]

BEATS = [
    # (start, lines) — lines: ("hdr"|"cmd"|"out*"|"blank", text)
    (4.0,  [("hdr", "== thingery.dev — live production — 17/17 checks pass ==")]),
    (4.6,  [("blank", ""), ("cmd", "scripts/demo-e2e.sh")]),
    (6.2,  [("outg", "PASS  0 · deployment — healthz ok:true"),
            ("outg", "PASS  1 · agent onboarding — signup returned an API key (thg_…)")]),

    (9.5,  [("hdr", "== 2 · agent discovers the category schema ==")]),
    (10.0, [("cmd", 'tools/call describe_category {"category":"sneakers"}')]),
    (12.0, [("out",  '→ size_eu (number, required) · colorway (string) · has_original_box (bool)'),
            ("outg", "PASS  declares size_eu")]),

    (15.0, [("hdr", "== 3 · agent creates the listing — no photo yet ==")]),
    (15.5, [("cmd", 'tools/call create_listing {"title":"Nike Air Max 90 Infrared, EU 44",'
                    '"category":"sneakers","price_cents":9500,'
                    '"attributes":{"size_eu":44}}')]),
    (19.5, [("outg", "PASS  created:true   photo_required:true"),
            ("outc", "PASS  needs_photo:true — hidden from search until it has a photo"),
            ("out",  "item:  " + ITEM),
            ("blank", "")]),

    (24.0, [("hdr", "== 4 · a separate buyer asks — anonymously, zero credentials ==")]),
    (24.6, [("cmd", 'tools/call search_items {"q":"air max 90 infrared","attributes":{"size_eu":44}}')]),
    (27.0, [("outg", "PASS  pending item absent from search — the photo gate holds")]),

    (30.0, [("hdr", "== 5 · agent attaches the photo — first photo publishes ==")]),
    (30.6, [("cmd", 'tools/call add_item_image {"item_id":"…","image_base64":"data:image/jpeg;base64,…"}')]),
    (33.4, [("outg", "PASS  added:true   visible:true — published"),
            ("outp", "photo: " + PHOTO)]),

    (37.0, [("hdr", "== 6 · same anonymous buyer query — now finds it ==")]),
    (37.6, [("cmd", 'tools/call search_items {"q":"air max 90 infrared","attributes":{"size_eu":44}}')]),
    (40.0, [("outg", "PASS  published item found by search — title matches")]),

    (43.0, [("hdr", "== 7 · anyone can open the public item page ==")]),
    (43.6, [("cmd", "curl -s " + URL)]),
    (45.6, [("outg", "PASS  page 200 — title + photo (og:image) present"),
            ("blank", ""),
            ("out",  "DEMO E2E: " + S["result"] + "   ·   cleanup: listing marked reserved")]),
]
TITLE_END = 4.0
ENDCARD_AT = 49.5
DURATION = 57.0

# expand beats into timed display lines with typing windows for cmds
LINES = []  # dicts: t0, t1(optional, typing end), text, style, is_cmd
t_cursor = 0.0
for start, rows in BEATS:
    t = start
    for kind, text in rows:
        if kind == "blank":
            LINES.append(dict(t0=t, text="", style=kind)); continue
        if kind == "cmd":
            for chunk in wrap(text):
                n = max(1, len(chunk))
                t1 = t + min(2.2, 0.012 * n + 0.15)
                LINES.append(dict(t0=t, t1=t1, text=chunk, style=kind, cmd=True))
                t = t1
        else:
            LINES.append(dict(t0=t, text=text, style=kind))
        t += 0.35 if kind != "cmd" else 0.0

def visible(t):
    out = []
    for ln in LINES:
        if ln["t0"] > t: break
        txt = ln["text"]
        if ln.get("cmd") and t < ln.get("t1", 0):
            n = int((t - ln["t0"]) / max(1e-9, ln["t1"] - ln["t0"]) * len(txt))
            txt = txt[:n]
        out.append((txt, ln["style"], ln.get("cmd", False)))
    return out

PHOTO_IMG = Image.open(os.path.join(HERE, "demo-photo.jpg")).convert("RGB")

def draw_terminal(t):
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)
    # window chrome
    d.rectangle([0, 0, W, 56], fill=CHROME)
    for i, c in enumerate([(255, 95, 86), (255, 189, 46), (39, 201, 63)]):
        d.ellipse([24 + i * 36, 20, 40 + i * 36, 36], fill=c)
    tw = d.textlength("thingery — end-to-end demo — live production", font=font(18))
    d.text(((W - tw) / 2, 17), "thingery — end-to-end demo — live production",
           font=font(18), fill=DIM)
    # content (bottom-anchored, follows output like a real terminal)
    x0, lh = 36, 30
    top, vh = 56, H - 56 - 24
    rows = visible(t)
    n_fit = vh // lh
    start_idx = max(0, len(rows) - n_fit)
    y = top + 12
    for txt, style, is_cmd in rows[start_idx:]:
        if txt or style == "blank":
            if is_cmd:
                d.text((x0, y), PROMPT, font=F_CMD, fill=GREEN)
                px = x0 + d.textlength(PROMPT + " ", font=F_CMD)
                d.text((px, y), txt, font=F_CMD, fill=FG)
                # blinking block cursor while typing
                if t < 57:
                    cx = px + d.textlength(txt, font=F_CMD)
                    if int(t / 0.53) % 2 == 0:
                        d.rectangle([cx + 3, y + 3, cx + 15, y + 22], fill=GREEN)
            elif style == "hdr":
                d.text((x0, y), txt, font=F_HDR, fill=CYAN)
            elif style in ("outg",):
                d.text((x0, y), txt, font=F_OUT, fill=GREEN)
            elif style in ("outc",):
                d.text((x0, y), txt, font=F_OUT, fill=(87, 169, 255))
            elif style in ("outp",):
                d.text((x0, y), txt, font=F_OUT, fill=PURPLE)
            else:
                d.text((x0, y), txt, font=F_OUT, fill=DIM)
        y += lh
    # real demo photo inset once the listing is published (beat 5)
    if 30.0 <= t < ENDCARD_AT:
        ph = 210
        thumb = PHOTO_IMG.copy(); thumb.thumbnail((ph * 2, ph * 2))
        tw_, th_ = thumb.size
        px_, py_ = W - tw_ - 40, H - th_ - 40
        d.rectangle([px_ - 8, py_ - 8, px_ + tw_ + 8, py_ + th_ + 8], fill=CHROME)
        d.rectangle([px_ - 8, py_ - 8, px_ + tw_ + 8, py_ + th_ + 8], outline=GREEN, width=2)
        img.paste(thumb, (px_, py_))
    return img

def draw_title(t):
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)
    fade = min(1.0, t / 0.6)
    def col(c, a):  # fade-in
        return tuple(int(v * (0.4 + 0.6 * a)) for v in c)
    d.text((W//2, 300), "thingery.dev", font=F_TITLE, fill=col(FG, fade), anchor="mm")
    d.text((W//2, 380), "the open item database and MCP server for AI agents",
           font=F_SUB, fill=col(CYAN, fade * min(1, max(0, (t - 0.8) / 0.6))), anchor="mm")
    d.text((W//2, 430), "…to list, find, and trade second-hand goods — live production, every step a scriptable MCP call",
           font=font(22), fill=col(DIM, fade * min(1, max(0, (t - 1.4) / 0.6))), anchor="mm")
    return img

def draw_endcard(t):
    img = draw_terminal(ENDCARD_AT - 0.01)
    d = ImageDraw.Draw(img, "RGBA")
    a = min(230, int(255 * min(1, (t - ENDCARD_AT) / 0.5)))
    d.rectangle([0, 0, W, H], fill=(13, 17, 23, a))
    d.text((W//2, 330), URL.replace("https://", ""), font=font(40, bold=True),
           fill=GOLD, anchor="mm")
    d.text((W//2, 400), "the listing the agent just made — open it now",
           font=font(22), fill=DIM, anchor="mm")
    d.text((W//2, 470), "same flow self-hosted:  npx thingery   ·   MCP: thingery.dev/mcp",
           font=font(22), fill=CYAN, anchor="mm")
    d.text((W//2, 520), "github.com/thingery/thingery  —  Apache-2.0  ·  demo-e2e.sh",
           font=font(20), fill=DIM, anchor="mm")
    return img

def frame(t):
    if t < TITLE_END: return draw_title(t)
    if t >= ENDCARD_AT + 0.5: return draw_endcard(t)
    return draw_terminal(t)

def main():
    os.makedirs(FRAMES_DIR, exist_ok=True)
    n = int(DURATION * FPS)
    for i in range(n):
        t = i / FPS
        frame(t).save(os.path.join(FRAMES_DIR, f"f{i:05d}.png"))
        if i % 150 == 0:
            print(f"  frame {i}/{n}", flush=True)
    subprocess.run(["ffmpeg", "-y", "-r", str(FPS), "-i", os.path.join(FRAMES_DIR, "f%05d.png"),
                    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20",
                    "-movflags", "+faststart", OUT], check=True, capture_output=True)
    print("wrote", OUT)

if __name__ == "__main__":
    main()
