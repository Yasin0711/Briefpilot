"""Erzeugt Testbilder und ein Testvideo (y4m) für den Scanner: Brief schräg fotografiert auf dunklem Tisch."""
import sys, random, pathlib
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageFilter

out = pathlib.Path(sys.argv[1])
out.mkdir(parents=True, exist_ok=True)
FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'
BOLD = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'

def letter_page(variant=0):
    w, h = 1240, 1754  # A4 bei 150 dpi
    page = Image.new('RGB', (w, h), (250, 250, 247))
    d = ImageDraw.Draw(page)
    f = ImageFont.truetype(FONT, 26)
    fb = ImageFont.truetype(BOLD, 30)
    fs = ImageFont.truetype(FONT, 18)
    d.text((110, 120), 'Stadtwerke Musterstadt GmbH · Hafenstraße 4 · 66111 Saarbrücken', font=fs, fill=(60, 60, 60))
    d.text((110, 210), 'Frau Lena Beispiel', font=f, fill=(20, 20, 20))
    d.text((110, 250), 'Lindenweg 12', font=f, fill=(20, 20, 20))
    d.text((110, 290), '66123 Saarbrücken', font=f, fill=(20, 20, 20))
    d.text((820, 420), '12.10.2026', font=f, fill=(20, 20, 20))
    subject = ['Ihre Jahresabrechnung Strom 2025', 'Abschlagsplan 2026 – Vertragskonto 7788 1122'][variant % 2]
    d.text((110, 520), subject, font=fb, fill=(10, 10, 10))
    d.text((110, 580), 'Vertragskonto: 7788 1122   Zählernummer: 1ESY1160523456', font=f, fill=(20, 20, 20))
    rng = random.Random(variant)
    y = 660
    for para in range(5):
        for line in range(rng.randint(3, 5)):
            words = []
            x = 110
            while x < 1050:
                wl = rng.randint(3, 11)
                words.append('x' * wl)
                x += wl * 15 + 14
            d.text((110, y), ' '.join('Lorem'[:min(5, len(w))] + 'ipsum'[:max(0, len(w) - 5)] for w in words), font=f, fill=(25, 25, 25))
            y += 38
        y += 30
    d.text((110, y + 20), 'Mit freundlichen Grüßen', font=f, fill=(20, 20, 20))
    d.text((110, h - 120), 'Seite 1 von 1', font=fs, fill=(90, 90, 90))
    return page

def homography(src, dst):
    A = []
    for (x, y), (u, v) in zip(src, dst):
        A.append([x, y, 1, 0, 0, 0, -u * x, -u * y])
        A.append([0, 0, 0, x, y, 1, -v * x, -v * y])
    b = [c for p in dst for c in p]
    return np.linalg.solve(np.array(A, float), np.array(b, float))

def scene(width, height, quad, variant=0, seed=1):
    rng = np.random.default_rng(seed)
    # dunkler Holztisch mit Maserung und Rauschen
    yy, xx = np.mgrid[0:height, 0:width]
    grain = 0.5 + 0.5 * np.sin(xx / 23.0 + 3 * np.sin(yy / 97.0))
    base = np.stack([70 + 25 * grain, 48 + 18 * grain, 32 + 12 * grain], axis=-1)
    base += rng.normal(0, 6, base.shape)
    bg = Image.fromarray(np.clip(base, 0, 255).astype('uint8'))
    page = letter_page(variant)
    pw, ph = page.size
    # PIL.transform erwartet die Abbildung Ziel → Quelle
    coeffs = homography(quad, [(0, 0), (pw, 0), (pw, ph), (0, ph)])
    warped = page.transform((width, height), Image.PERSPECTIVE, tuple(coeffs), Image.BICUBIC)
    mask = Image.new('L', (pw, ph), 255).transform((width, height), Image.PERSPECTIVE, tuple(coeffs), Image.BICUBIC)
    # weicher Schatten unter dem Blatt
    shadow = mask.filter(ImageFilter.GaussianBlur(18))
    bg_arr = np.asarray(bg).astype(float) * (1 - 0.45 * (np.asarray(shadow, float) / 255.0))[..., None]
    img = Image.composite(warped, Image.fromarray(np.clip(bg_arr, 0, 255).astype('uint8')), mask)
    # Licht von links oben: rechts unten etwas dunkler (Schatten der Hand)
    arr = np.asarray(img).astype(float)
    light = 1.0 - 0.28 * (xx / width) * (yy / height)
    arr *= light[..., None]
    arr += rng.normal(0, 3, arr.shape)
    return Image.fromarray(np.clip(arr, 0, 255).astype('uint8'))

# Einzelfoto (wie aus der Kamera-App)
W, H = 2000, 1500
quad = [(560, 170), (1480, 230), (1560, 1380), (470, 1310)]
scene(W, H, quad, 0, seed=2).save(out / 'brief-foto.jpg', quality=90)
# Zweite Seite mit anderem Inhalt
quad2 = [(600, 140), (1440, 160), (1500, 1400), (520, 1360)]
scene(W, H, quad2, 1, seed=3).save(out / 'brief-foto-2.jpg', quality=90)
# Screenshot-artiges PNG (ohne Hintergrund, gerade)
letter_page(1).resize((620, 877)).save(out / 'screenshot.png')

# Testvideo für die Kamera (Hochformat-Handyhaltung simuliert durch Querformat 1280×720)
VW, VH = 1280, 720
frames = []
for i in range(24):
    j = (i % 6) * 0.6  # leichtes Zittern
    q = [(420 + j, 60 + j), (880 + j, 80), (930, 680 - j), (380, 650 + j)]
    frames.append(scene(VW, VH, q, 0, seed=10 + (i % 3)))
with open(out / 'kamera.y4m', 'wb') as fh:
    fh.write(f'YUV4MPEG2 W{VW} H{VH} F15:1 Ip A1:1 C420jpeg\n'.encode())
    for fr in frames:
        ycbcr = fr.convert('YCbCr')
        y, cb, cr = ycbcr.split()
        fh.write(b'FRAME\n')
        fh.write(y.tobytes())
        fh.write(cb.resize((VW // 2, VH // 2), Image.BILINEAR).tobytes())
        fh.write(cr.resize((VW // 2, VH // 2), Image.BILINEAR).tobytes())
print('ok', sorted(p.name for p in out.iterdir()))

# Weitere Varianten für die Fingerabdruck-Kalibrierung
scene(W, H, [(540, 200), (1500, 190), (1530, 1400), (500, 1330)], 2, seed=4).save(out / 'brief-foto-3.jpg', quality=88)
scene(W, H, [(600, 220), (1450, 260), (1520, 1350), (520, 1300)], 0, seed=5).save(out / 'brief-foto-0b.jpg', quality=85)
