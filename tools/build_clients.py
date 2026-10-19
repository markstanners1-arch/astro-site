# Builds the CLIENT WORK section of site.html from data/client_work.csv (standard library only); run by build_index.py.
# Pictures processed from other people's data, shown only with their permission and never sold as prints.
# CSV columns: client, title, web_image, scope, integration, show (blank or yes = shown).
# With no rows to show, the section is left as an empty hidden placeholder.
import csv, html, re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

def card(r):
    e = html.escape
    bits = ' · '.join(b for b in (r['scope'].strip(), r['integration'].strip()) if b)
    return ('      <figure class="print">\n'
            f'        <img src="img/{e(r["web_image"].strip())}" alt="{e(r["title"])}" loading="lazy">\n'
            f'        <figcaption><b>{e(r["title"])}</b>' + (f'<span>{e(bits)}</span>' if bits else '')
            + f'<span class="credit">Data by {e(r["client"].strip())}, processed by Mark Stanners</span></figcaption>\n      </figure>')

def section(rows):
    if not rows:
        return '<section id="clients" hidden></section>'
    return ('<section id="clients">\n  <div class="wrap">\n    <p class="eyebrow">Client work</p>\n'
            '    <h2>Other people\'s <em>skies</em></h2>\n'
            '    <p class="lede" style="margin-top:14px">Frames sent in by friends and pilot users, processed here and shown with their permission. '
            'Not for sale: each picture belongs to the person who captured the data.</p>\n'
            '    <div class="prints">\n' + '\n'.join(card(r) for r in rows) + '\n    </div>\n  </div>\n</section>')

def build():
    path = ROOT / 'data' / 'client_work.csv'
    rows = [r for r in csv.DictReader(open(path, encoding='utf8'))
            if (r.get('show') or 'yes').strip().lower() != 'no' and r.get('web_image', '').strip()] if path.exists() else []
    page = (ROOT / 'site.html').read_text(encoding='utf8')
    new, n = re.subn(r'<section id="clients"[^>]*>.*?</section>', lambda m: section(rows), page, count=1, flags=re.S)
    if n != 1:                                   # first run: place it between the gallery and the prints
        new = page.replace('<section id="prints">', section(rows) + '\n\n<section id="prints">', 1)
    (ROOT / 'site.html').write_text(new, encoding='utf8')
    return rows

if __name__ == '__main__':
    print('client work section built from', len(build()), 'rows')
