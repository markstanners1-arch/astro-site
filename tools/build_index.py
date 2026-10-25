# Wraps site.html (the home page body, also used for the private Claude preview) into a standalone index.html for
# GitHub Pages: adds the document skeleton, charset/viewport and the small reset the preview viewer supplies.
# Does the same for the Customer work page: customers_site.html (built from data/client_work.csv) -> customers.html.
# Run after every edit to site.html or the CSVs:  python tools/build_index.py
# python tools/build_index.py --payments-preview  writes only payments_preview.html: the home page with the Stripe
# TEST-mode buy buttons and payment notes, for a local look (git-ignored; nothing else is touched).
import sys
from pathlib import Path
import build_prints, build_clients, build_orion               # regenerate PRINTS in site.html, then the customer work page body
root = Path(__file__).resolve().parent.parent
PREVIEW = '--payments-preview' in sys.argv
if not PREVIEW:
    build_prints.build()
    build_clients.build()
    build_orion.build()
head = '''<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<style>
:root { padding-top: env(safe-area-inset-top, 0px); padding-bottom: env(safe-area-inset-bottom, 0px); }
body { margin: 0; font-size: 14px; font-family: system-ui, sans-serif; }
img { max-width: 100%; }
[hidden] { display: none !important; }
</style>
'''
# orion.html is no longer built: the community project moved to its own site (together.oneoffx.co.uk, 25 Oct 2026)
# and orion.html is a static redirect there.
sources = {'index.html': 'site.html', 'customers.html': 'customers_site.html'}
pages = [(build_prints.render(preview=True)[0], 'payments_preview.html')] if PREVIEW else [(None, o) for o in sources]
for body, out in pages:
    body = body or (root / sources[out]).read_text(encoding='utf8')
    # the page's own <title>, metas, font links and <style> come first and belong in <head>
    split = body.index('<div class="wrap">')
    html = head + body[:split] + '</head>\n<body>\n' + body[split:] + '\n</body>\n</html>\n'
    (root / out).write_text(html, encoding='utf8')
    print('wrote', root / out, len(html), 'bytes')
