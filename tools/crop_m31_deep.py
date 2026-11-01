# SUPERSEDED 1 Nov 2026: img/m31_tl_seestar.jpg is now the Telescope Live filter-by-filter Andromeda (TL_M31_lrgb\m31_merge2.py). Don't rerun this.
# One-off (1 Nov 2026): remove the grey crescent reflection ghost from Andromeda deep (Seestar + Telescope Live) by
# trimming the top 532 px (the ghost reaches about y = 480 in the full-size file; the corner haze goes with it).
# Writes the cropped 16-bit TIFF beside the original, rebuilds img/m31_tl_seestar.jpg and updates print_sizes.csv.
import csv, numpy as np, tifffile
from PIL import Image
SRC = r"D:\Claudes Andromeda Folder\M31_combined\star_reduction\M31_matched_16bit.tif"
DST = r"D:\Claudes Andromeda Folder\M31_combined\star_reduction\M31_matched_cropped_16bit.tif"
a = tifffile.imread(SRC)[532:]
tifffile.imwrite(DST, a, photometric="rgb")
h, w = a.shape[:2]; print("cropped", w, "x", h)
im = Image.fromarray((a / 257 + 0.5).astype(np.uint8))
im.resize((1600, round(h * 1600 / w)), Image.LANCZOS).save(r"D:\Astro_Website\img\m31_tl_seestar.jpg", quality=86, optimize=True, progressive=True)
paper = {"A4": (297, 210), "A3": (420, 297), "A2": (594, 420), "A1": (841, 594)}      # mm, long x short
dpi = {k: round(max(max(w, h) / (L / 25.4), min(w, h) / (S / 25.4))) for k, (L, S) in paper.items()}
print("dpi", dpi)
P = r"D:\Astro_Website\data\print_sizes.csv"
rows = list(csv.DictReader(open(P, encoding="utf8"))); fields = list(rows[0].keys())
for r in rows:
    if r["image"] == "Andromeda M31, TL + Seestar":
        r["pixels"] = f"{w}x{h}"
        for k in paper: r[f"{k} dpi"] = str(dpi[k])
        r["sizes at 180 dpi or better"] = " · ".join(k for k in paper if dpi[k] >= 180)
        r["status"] = "finished; top 532 px cropped to remove a reflection ghost (1 Nov 2026)"
        print("updated", r["image"], r["pixels"], r["sizes at 180 dpi or better"])
with open(P, "w", encoding="utf8", newline="") as f:
    wr = csv.DictWriter(f, fieldnames=fields); wr.writeheader(); wr.writerows(rows)
