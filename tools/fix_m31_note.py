# One-off (1 Nov 2026): Andromeda's 8.6 h span four nights (three broadband nights plus the 11 Oct hydrogen-alpha night), not three.
import csv
P = r"D:\Astro_Website\data\print_sizes.csv"
rows = list(csv.DictReader(open(P, encoding="utf8"))); fields = list(rows[0].keys())
for r in rows:
    if r["image"] == "Andromeda M31":
        r["note"] = r["note"].replace("three nights", "four nights"); r["nights"] = "4"; print("note:", r["note"])
with open(P, "w", encoding="utf8", newline="") as f:
    w = csv.DictWriter(f, fieldnames=fields); w.writeheader(); w.writerows(rows)
