# Builds customers.html's body (customers_site.html) from data/client_work.csv; run by build_index.py,
# which then wraps it into customers.html. Standard library only.
# Pictures processed from other people's data, shown only with their permission and never sold as prints.
#
# data/client_work.csv, one row per image (edit in Excel or Sheets; keep it saved as CSV, UTF-8):
#   show          yes = on the page; no (or blank) = kept but hidden, e.g. while waiting for the customer's OK
#   title         e.g. Rosette Nebula
#   catalogue     e.g. NGC 2237   (shown as "Rosette Nebula, NGC 2237")
#   customer      name for the credit line "Data: <customer> · Processing: Gosforth Skies"
#   before_image  file in img/, the left side of the slider (plain stretch, or the scope app's own stack)
#   after_image   file in img/, the finished picture (same size and framing: tools/make_customer_pair.py)
#   before_label  slider tag for the left side: "Plain stretch" (default) or e.g. "Seestar app", "Dwarf app"
#   scope, filters, integration, nights    the observing-log lines (any left blank are skipped)
#   notes         two or three sentences on what was done: problems found and fixed
#   quote         optional short customer quote (no quote marks needed)
import csv, html, re, struct
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
e = html.escape

def jpeg_size(path):
    """(width, height) of a JPEG, read from its frame header; None if it can't be read."""
    try:
        with open(path, 'rb') as f:
            if f.read(2) != b'\xff\xd8':
                return None
            while True:
                marker, = struct.unpack('>H', f.read(2))
                length, = struct.unpack('>H', f.read(2))
                if marker in (0xFFC0, 0xFFC1, 0xFFC2):
                    h, w = struct.unpack('>xHH', f.read(5))
                    return w, h
                f.seek(length - 2, 1)
    except (OSError, struct.error):
        return None

def img(name, alt):
    size = jpeg_size(ROOT / 'img' / name)
    wh = f' width="{size[0]}" height="{size[1]}"' if size else ''
    return f'<img src="img/{e(name)}" alt="{e(alt)}"{wh} loading="lazy">'

def entry(r, i):
    get = lambda k: (r.get(k) or '').strip()
    name = ', '.join(b for b in (get('title'), get('catalogue')) if b)
    left = get('before_label') or 'Plain stretch'
    log = ''.join(f'\n            <dt>{k}</dt><dd>{e(get(c))}</dd>' for k, c in
                  (('Scope', 'scope'), ('Filters', 'filters'), ('Integration', 'integration'), ('Nights', 'nights')) if get(c))
    quote = (f'\n          <blockquote class="quote"><p>{e(get("quote"))}</p><cite>{e(get("customer"))}</cite></blockquote>'
             if get('quote') else '')
    return f'''      <div class="pair{' flip' if i % 2 else ''}">
        <div class="ba" style="--pos:50%">
          {img(get('before_image'), name + ', ' + (left.lower() if left == 'Plain stretch' else left))}
          <div class="after">{img(get('after_image'), name + ', processed')}</div>
          <div class="handle"></div>
          <span class="tag l">{e(left)}</span><span class="tag r">Processed</span>
          <input type="range" min="0" max="100" value="50" aria-label="Compare {e(name)} before and after" id="ba-c{i}">
        </div>
        <div class="text">
          <h3>{e(name)}</h3>
          <p class="credit">Data: {e(get('customer'))} · Processing: Gosforth Skies</p>
          <dl class="log">{log}
          </dl>
          <p>{e(get('notes'))}</p>{quote}
        </div>
      </div>'''

def page(rows):
    site = (ROOT / 'site.html').read_text(encoding='utf8')
    split = site.index('<div class="wrap">')
    head = re.sub(r'<title>.*?</title>', '<title>Customer work · Gosforth Skies</title>', site[:split], count=1)
    head = re.sub(r'<meta name="description"[^>]*>', '<meta name="description" content="Astrophotography '
                  'processed from other people\'s data, shown with their permission.">', head, count=1)
    # header and footer copied from the home page, with its #section links pointed back at index.html
    header = re.search(r'  <header class="top">.*?</header>', site, re.S).group(0)
    header = header.replace('href="#', 'href="index.html#').replace('<div class="brand">', '<a class="brand" href="index.html">', 1)
    header = re.sub(r'(<a class="brand"[^>]*>.*?)</div>', r'\1</a>', header, count=1, flags=re.S)
    header = header.replace('<a href="customers.html">', '<a href="customers.html" aria-current="page">')
    footer = re.search(r'<div class="wrap">\s*<footer>.*?</footer>\s*</div>', site, re.S).group(0)
    footer = footer.replace('href="#privacy"', 'href="index.html#privacy"')
    scripts = re.search(r'<script>\s*document\.querySelectorAll\(\'\.ba\'\).*?</script>', site, re.S).group(0)
    body = ('\n'.join(entry(r, i) for i, r in enumerate(rows)) if rows else
            '      <p class="note">The first pictures are on their way: they appear here once their owners have said yes.</p>')
    return f'''{head}<div class="wrap">
{header}
</div>

<section id="customers" style="border-top:0; padding-top:clamp(24px, 5vw, 56px)">
  <div class="wrap">
    <p class="eyebrow">Customer work</p>
    <h1>Other people's <em>skies</em></h1>
    <p class="lede" style="margin-top:14px">Pictures processed from other people's data, shown with their permission.</p>
    <div class="pairs">
{body}
    </div>
    <p style="margin-top:clamp(40px, 6vw, 72px)"><a class="cta" href="index.html#upload">Send your frames</a></p>
  </div>
</section>

{footer}

{scripts}
'''

def build():
    path = ROOT / 'data' / 'client_work.csv'
    rows = [r for r in csv.DictReader(open(path, encoding='utf-8-sig', newline=''))
            if (r.get('show') or '').strip().lower() == 'yes'
            and (r.get('before_image') or '').strip() and (r.get('after_image') or '').strip()] if path.exists() else []
    (ROOT / 'customers_site.html').write_text(page(rows), encoding='utf8')
    return rows

if __name__ == '__main__':
    print('customer work page built from', len(build()), 'rows')
