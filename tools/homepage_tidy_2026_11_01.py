# One-off (1 Nov 2026), from the Astro Wizard comparison report: move the Prints section below the FAQ in site.html,
# use the 400 weight for the "Gosforth Skies" name on the other pages, add the tab icon to the legal pages,
# and drop the Newsreader 500 font file that only the name used.
import re
from pathlib import Path
R = Path(r"D:\Astro_Website")
ICON = ('<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 32 32\'%3E'
        '%3Ccircle cx=\'16\' cy=\'16\' r=\'15\' fill=\'%230b1019\' stroke=\'%23243046\' stroke-width=\'2\'/%3E'
        '%3Ccircle cx=\'16\' cy=\'16\' r=\'6\' fill=\'%23e0664d\'/%3E%3C/svg%3E">')
s = (R / "site.html").read_text(encoding="utf8")
m = re.search(r'<section id="prints">.*?</section>\n*', s, flags=re.S)
if m and s.index('<section id="faq">') < m.start():
    print("prints already below the FAQ")
elif m:
    block = m.group(0); s = s[:m.start()] + s[m.end():]
    faq_end = re.search(r'<section id="faq">.*?</section>\n*', s, flags=re.S).end()
    s = s[:faq_end] + block.rstrip("\n") + "\n\n" + s[faq_end:]
    (R / "site.html").write_text(s, encoding="utf8"); print("moved Prints below the FAQ")
for name in ("customers_site.html", "privacy.html", "terms.html"):
    p = R / name; t = p.read_text(encoding="utf8")
    t2 = t.replace(".brand { font: 500 1.25rem/1 var(--font-display);", ".brand { font: 400 1.25rem/1 var(--font-display);")
    if name != "customers_site.html" and 'rel="icon"' not in t2:          # customers.html gets the icon from build_index.py's head
        t2 = re.sub(r'(<meta name="viewport"[^>]*>)', lambda mm: mm.group(1) + "\n" + ICON, t2, count=1)
    if t2 != t: p.write_text(t2, encoding="utf8"); print("updated", name)
css = R / "fonts" / "fonts.css"; c = css.read_text(encoding="utf8")
c2 = re.sub(r"@font-face\s*\{[^}]*Newsreader[^}]*font-weight:\s*500;[^}]*\}\s*", "", c)
if c2 != c: css.write_text(c2, encoding="utf8"); print("removed the Newsreader 500 face from fonts.css")
