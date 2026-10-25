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
#   alt_image (optional): a second colour version of the same picture; two buttons under it let visitors swap.
#   alt_labels (optional): the two button names, "first|second" (default "Red & teal|Gold & blue").
#
# Stripe buy buttons (each size becomes a link to its Stripe Payment Link) and the "how payment works" notes appear only
# when payment links exist: data/stripe_links_live.json (made by D:\NINA\stripe_pay.py prints with the live key) turns
# them on for the real site. Test-mode links (data/stripe_links_test.json) are used only by a preview build:
#   python tools/build_index.py --payments-preview   -> payments_preview.html (git-ignored, site.html untouched)
import csv, html, json, re
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

PAY_PRINTS = ('    <p class="note pay"><b>Buying a print.</b> Tap a size to pay securely through Stripe by card, Apple Pay or Google Pay; '
              'your card details go to Stripe, never to me. There\'s a box at checkout for the optional legend wording. '
              'I print each one to order and email you when it\'s posted. UK delivery for now; for anywhere else, '
              'a size not listed, or acrylic and metal, email me.</p>\n')
PAY_FAQ = ('      <details id="paying"><summary>How do I pay?</summary><p>Nothing up front. When your picture is ready, the delivery '
           'email has the download link and a secure Stripe payment link for the agreed price (card, Apple Pay or Google Pay; '
           'your card details go to Stripe, never to me). The download works straight away, so you see the result before you pay. '
           'Prints are paid at checkout from the Prints section. Pilot datasets stay free.</p></details>\n')

def load_links(preview=False):
    """{'Title|A3': url} from the live links file, or the test one for a preview build; {} means no buttons"""
    f = ROOT / 'data' / ('stripe_links_test.json' if preview else 'stripe_links_live.json')
    if not f.exists(): return {}
    return {k: v['url'] for k, v in json.loads(f.read_text(encoding='utf8'))['links'].items()}

def card(r, links=None):
    links = links or {}
    e = html.escape
    prices = PRICES.get(r['tier'].strip() or 'standard', PRICES['standard'])
    offered, on_request = [], []
    for s in SIZES:
        dpi = float(r[f'{s} dpi'] or 0)
        if dpi >= OFFER_DPI and s in prices:
            url = links.get(f"{r['title']}|{s}")
            offered.append(f'<a class="buy" href="{e(url)}" rel="noopener">{s} £{prices[s]}</a>' if url else f'{s} £{prices[s]}')
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
    alt = (r.get('alt_image') or '').strip()
    if img and alt:   # a second colour version: buttons under the picture swap it (script at the end of site.html)
        a, b = ((r.get('alt_labels') or '').strip() or 'Red & teal|Gold & blue').split('|')
        pic += ('\n        <div class="vers" role="group" aria-label="Colour version">'
                f'<button type="button" aria-pressed="true" data-src="img/{e(img)}">{e(a)}</button>'
                f'<button type="button" aria-pressed="false" data-src="img/{e(alt)}">{e(b)}</button></div>')
    sizes = []
    if offered: sizes.append('<span class="sizes">' + (' ' if links else ' · ').join(offered) + '</span>')
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

def section(rows, links=None):
    return ('<section id="prints">\n  <div class="wrap">\n    <p class="eyebrow">Prints</p>\n'
            '    <h2>Pictures for the <em>wall</em></h2>\n'
            f'    <p class="lede" style="margin-top:14px">{html.escape(INTRO)}</p>\n'
            '    <p class="eyebrow" style="margin-top:28px">'
            + ('Prices · unframed fine-art giclée' if links else 'Indicative prices during the pilot · unframed fine-art giclée')
            + '</p>\n'
            '    <div class="prints">\n' + '\n'.join(card(r, links) for r in rows) + '\n    </div>\n'
            + ('    <p class="note">Prices include UK postage.</p>\n' if links else
               '    <p class="note">P&amp;P: £6 for A4 and A3 (sent flat), £9 for A2 and A1 (rolled in a tube).</p>\n') +
            '    <p class="note">Free on request: a small legend in the corner with the object\'s name and a line about it, and a '
            'signature. Nice for a gift; say if you\'d like your own wording or a name added.</p>\n'
            + media_block(rows) + '\n'
            + (PAY_PRINTS if links else
               '    <p class="note">To order, email me with the picture, size and finish, and whether you\'d like the legend.</p>\n')
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

BUY_CSS = ('.buy { color: inherit; text-decoration: none; border: 1px solid currentColor; border-radius: 4px; '
           'padding: 1px 7px; margin: 2px 4px 2px 0; display: inline-block; }\n'
           '.buy:hover, .buy:focus-visible { background: rgba(255,255,255,0.1); }\n')

def render(preview=False):
    """site.html text with the Prints section rebuilt (plus buy buttons and payment notes when payment links exist)"""
    rows = [r for r in csv.DictReader(open(ROOT / 'data' / 'print_sizes.csv', encoding='utf8'))
            if (r.get('show') or 'yes').strip().lower() != 'no']
    links = load_links(preview)
    page = (ROOT / 'site.html').read_text(encoding='utf8')
    new, n = re.subn(r'<section id="prints">.*?</section>', lambda m: section(rows, links), page, count=1, flags=re.S)
    if n != 1: raise SystemExit('prints section not found in site.html')
    new = re.sub(r'\n *<details id="paying">.*?</details>', '', new, flags=re.S)       # rebuilt fresh below
    new = new.replace(BUY_CSS, '')
    if links:
        new = new.replace('<div class="faq">\n', '<div class="faq">\n' + PAY_FAQ, 1)
        new = new.replace('.onreq {', BUY_CSS + '.onreq {', 1)
    return new, rows

def build():
    new, rows = render()
    (ROOT / 'site.html').write_text(new, encoding='utf8')
    return rows

if __name__ == '__main__':
    print('prints section built from', len(build()), 'rows')
