# Builds the PRINTS section of site.html from data/print_sizes.csv (standard library only).
# Edit the CSV, then run  python tools/build_index.py  (which runs this first).
#
# CSV columns used: image, source, status, A4 dpi, A3 dpi, A2 dpi, A1 dpi, title, web_image, note, tier,
# integration, nights.
#   Sizes: 200 dpi or more is offered; 180-199 dpi is "on request"; under 180 dpi is not shown.
#   tier "flagship" uses the flagship price list (no A1 price, so an offered A1 shows "on request").
#   Credit comes from the source column: "own, <scope>", "Telescope Live ...", or "mixed".
#   note replaces the integration/nights line when present.
#   Rows with no web_image get a text-only card. Rows with show = no are left out (blank or yes = shown).
import csv, html, re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SIZES = ['A4', 'A3', 'A2', 'A1']
PRICES = {'flagship': {'A4': 30, 'A3': 50, 'A2': 90},
          'standard': {'A4': 25, 'A3': 45, 'A2': 80, 'A1': 150}}
OFFER_DPI, REQUEST_DPI = 200, 180
INTRO = ("Prints from my own Seestar and Vespera data, captured across Tyneside, Northumberland and Cumbria, "
         "plus professional data from Telescope Live. Printed on fine-art paper.")

def credit(source):
    s = source.strip()
    if s.lower().startswith('own'):
        scope = s.split(',', 1)[1].strip() if ',' in s else ''
        return 'Captured and processed by Mark Stanners' + (', ' + scope if scope else '')
    if s.lower().startswith('telescope live'):
        return 'Processed by Mark Stanners, original data from Telescope Live'
    if s.lower().startswith('mixed'):
        return 'Seestar data by Mark Stanners, combined with Telescope Live data'
    return ''

def card(r):
    e = html.escape
    prices = PRICES.get(r['tier'].strip() or 'standard', PRICES['standard'])
    offered, on_request = [], []
    for s in SIZES:
        dpi = float(r[f'{s} dpi'] or 0)
        if dpi >= OFFER_DPI and s in prices: offered.append(f'{s} £{prices[s]}')
        elif dpi >= REQUEST_DPI: on_request.append(s)
    lines = []
    if r['note'].strip(): lines.append(e(r['note'].strip()))
    else:
        bits = [r['integration'].strip()]
        n = r['nights'].strip()
        if n: bits.append(f"{n} night{'s' if n != '1' else ''}")
        bits = [b for b in bits if b]
        if bits: lines.append(e(' · '.join(bits)))
    img = r['web_image'].strip()
    pic = (f'<img src="img/{e(img)}" alt="{e(r["title"])}" loading="lazy">' if img
           else '<div class="noimg">Image to follow</div>')
    sizes = []
    if offered: sizes.append('<span class="sizes">' + ' · '.join(offered) + '</span>')
    if on_request: sizes.append('<span class="onreq">' + ' · '.join(on_request) + ' on request</span>')
    return ('      <figure class="print">\n        ' + pic + '\n        <figcaption><b>' + e(r['title']) + '</b>'
            + ''.join(f'<span>{l}</span>' for l in lines)
            + f'<span class="credit">{e(credit(r["source"]))}</span>' + ''.join(sizes) + '</figcaption>\n      </figure>')

def media_block(rows):
    names = lambda size: '; '.join(r['title'] for r in rows if float(r[f'{size} dpi'] or 0) >= OFFER_DPI)
    return ('    <div class="media">\n      <h3>Acrylic and metal</h3>\n'
            '      <p>Most images can also be made as a face-mounted acrylic or an aluminium-mounted print: deep blacks, '
            'ready to hang, no frame needed. Priced on request; as a guide, from about £120 at A3 and £220 at A2.</p>\n'
            f'      <p class="note">At A3: {html.escape(names("A3"))}.</p>\n'
            f'      <p class="note">At A2: {html.escape(names("A2"))}.</p>\n    </div>')

def section(rows):
    return ('<section id="prints">\n  <div class="wrap">\n    <p class="eyebrow">Prints</p>\n'
            '    <h2>Pictures for the <em>wall</em></h2>\n'
            f'    <p class="lede" style="margin-top:14px">{html.escape(INTRO)}</p>\n'
            '    <p class="eyebrow" style="margin-top:28px">Indicative prices during the pilot · unframed fine-art giclée</p>\n'
            '    <div class="prints">\n' + '\n'.join(card(r) for r in rows) + '\n    </div>\n'
            '    <p class="note">P&amp;P: £6 for A4 and A3 (sent flat), £9 for A2 and A1 (rolled in a tube).</p>\n'
            + media_block(rows) + '\n'
            '    <p class="note">To order, email me with the picture, size and finish.</p>\n'
            + REQUEST_FORM + '  </div>\n</section>')

# "Not here? Ask for it": posts to the upload Worker's /request route (handled by the script at the end of site.html)
REQUEST_FORM = '''    <form class="send" id="ask" novalidate>
      <h3>Not here? Ask for it</h3>
      <p class="sendmsg">Tell me the object or picture you'd like on your wall. I may be able to shoot it or source the data.</p>
      <div class="fields">
        <label>Your name<input type="text" id="ask-name" name="name" autocomplete="name" required></label>
        <label>Email<input type="email" id="ask-email" name="email" autocomplete="email" required></label>
        <label>What you'd like<input type="text" id="ask-object" name="object" placeholder="e.g. the Orion Nebula" required></label>
        <label>Size<input type="text" id="ask-size" name="size" placeholder="e.g. A3"></label>
      </div>
      <label>Anything else<input type="text" id="ask-note" name="note"></label>
      <label class="trap" aria-hidden="true">Website<input type="text" id="ask-website" name="website" tabindex="-1" autocomplete="off"></label>
      <p class="sendmsg">By sending, you agree to the <a href="#privacy">privacy note</a>.</p>
      <button type="submit">Send request</button>
      <p class="sendmsg" id="ask-status" aria-live="polite"></p>
    </form>
'''

def build():
    rows = [r for r in csv.DictReader(open(ROOT / 'data' / 'print_sizes.csv', encoding='utf8'))
            if (r.get('show') or 'yes').strip().lower() != 'no']
    page = (ROOT / 'site.html').read_text(encoding='utf8')
    new, n = re.subn(r'<section id="prints">.*?</section>', lambda m: section(rows), page, count=1, flags=re.S)
    if n != 1: raise SystemExit('prints section not found in site.html')
    (ROOT / 'site.html').write_text(new, encoding='utf8')
    return rows

if __name__ == '__main__':
    print('prints section built from', len(build()), 'rows')
