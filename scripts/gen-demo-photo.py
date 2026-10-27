#!/usr/bin/env python3
"""Generate the self-contained demo product photo for scripts/demo-e2e.sh (THI-391).

Renders a stylized 'Air Max 90 Infrared, EU 44' studio shot — pure Pillow,
deterministic, ~25 KB JPEG. The demo script embeds the base64 output so it has
zero runtime dependencies.
"""
from PIL import Image, ImageDraw, ImageFont, ImageFilter
import base64, sys

W, H = 900, 675
img = Image.new("RGB", (W, H), "#0f172a")
d = ImageDraw.Draw(img)

# vertical gradient backdrop
top, bot = (30, 41, 59), (10, 15, 26)
for y in range(H):
    t = y / H
    d.line([(0, y), (W, y)], fill=tuple(int(a + (b - a) * t) for a, b in zip(top, bot)))

# soft floor glow
glow = Image.new("RGB", (W, H), "#000000")
gd = ImageDraw.Draw(glow)
gd.ellipse([W//2 - 380, H//2 + 60, W//2 + 380, H//2 + 260], fill=(40, 52, 70))
glow = glow.filter(ImageFilter.GaussianBlur(60))
img = Image.blend(img, glow, 0.35)

d = ImageDraw.Draw(img)

# stylized sneaker silhouette (side view, toe pointing right)
cx, cy = W // 2, H // 2 - 10
s = 1.0
body = [(cx - 260*1, cy + 40), (cx - 250, cy - 55), (cx - 190, cy - 70), (cx - 90, cy - 95),
        (cx + 60, cy - 75), (cx + 190, cy - 35), (cx + 265, cy - 5), (cx + 270, cy + 40)]
d.polygon(body, fill="#e2e8f0")
# upper swoosh band
band = [(cx - 150, cy - 55), (cx + 40, cy - 72), (cx + 130, cy - 45), (cx - 60, cy - 25)]
d.polygon(band, fill="#ef4444")
# midsole
sole = [(cx - 262, cy + 40), (cx + 272, cy + 40), (cx + 272, cy + 78), (cx - 262, cy + 78)]
d.rounded_rectangle([cx - 262, cy + 30, cx + 272, cy + 80], 18, fill="#f8fafc")
# air-bubble window
d.rounded_rectangle([cx + 120, cy + 46, cx + 240, cy + 66], 10, fill="#cbd5e1")
d.ellipse([cx + 140, cy + 46, cx + 168, cy + 66], fill="#94a3b8")
d.ellipse([cx + 185, cy + 46, cx + 213, cy + 66], fill="#94a3b8")
# laces
for i in range(4):
    d.line([(cx - 170 + i * 42, cy - 60 - i * 6), (cx - 130 + i * 42, cy - 40 - i * 6)],
           fill="#94a3b8", width=7)
# shadow under shoe
sh = Image.new("RGBA", (W, H), (0, 0, 0, 0))
sd = ImageDraw.Draw(sh)
sd.ellipse([cx - 280, cy + 78, cx + 290, cy + 130], fill=(0, 0, 0, 120))
sh = sh.filter(ImageFilter.GaussianBlur(18))
img = Image.alpha_composite(img.convert("RGBA"), sh).convert("RGB")
d = ImageDraw.Draw(img)

FB = "/System/Library/Fonts/Supplemental/Arial Bold.ttf"
FR = "/System/Library/Fonts/Supplemental/Arial.ttf"
f_title = ImageFont.truetype(FB, 64)
f_sub = ImageFont.truetype(FR, 38)
f_tag = ImageFont.truetype(FR, 26)

title = "Nike Air Max 90"
sub = "Infrared  ·  EU 44  ·  worn twice"
tag = "thingery.dev — demo photo"

d.text(((W - d.textlength(title, f_title)) / 2, 40), title, font=f_title, fill="#f8fafc")
d.text(((W - d.textlength(sub, f_sub)) / 2, 122), sub, font=f_sub, fill="#fca5a5")
tw = d.textlength(tag, f_tag)
d.text(((W - tw) / 2, H - 70), tag, font=f_tag, fill="#64748b")

img.save("demo-photo.jpg", "JPEG", quality=82, optimize=True)
import os
with open("demo-photo.jpg", "rb") as fh:
    b64 = base64.b64encode(fh.read()).decode()
import os
print("bytes:", os.path.getsize("demo-photo.jpg"), "b64 chars:", len(b64))
with open("demo-photo.b64", "w") as fh:
    fh.write(b64)
