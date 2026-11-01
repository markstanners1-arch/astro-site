# Adds or refreshes the legend_image column in data/print_sizes.csv (framed-with-legend versions from make_legends.py).
import csv
P = r"D:\Astro_Website\data\print_sizes.csv"
L = {"Andromeda M31": "m31_after_legend.jpg", "Pleiades M45": "m45_after_legend.jpg",
     "Heart and Soul mosaic": "heart_soul_mosaic_legend.jpg", "Elephant's Trunk IC 1396": "elephants_trunk_legend.jpg",
     "Fighting Dragons NGC 6188 (SHO)": "tl_ngc6188_legend.jpg"}
rows = list(csv.DictReader(open(P, encoding="utf8"))); fields = list(rows[0].keys())
if "legend_image" not in fields: fields.append("legend_image")
for r in rows:
    r["legend_image"] = L.get(r["image"], r.get("legend_image") or "")
    if r["legend_image"]: print("legend:", r["image"], "->", r["legend_image"])
with open(P, "w", encoding="utf8", newline="") as f:
    w = csv.DictWriter(f, fieldnames=fields); w.writeheader(); w.writerows(rows)
