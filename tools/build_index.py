# Wraps site.html (the home page body, also used for the private Claude preview) into a standalone index.html for
# GitHub Pages: adds the document skeleton, charset/viewport and the small reset the preview viewer supplies.
# Does the same for the Customer work page: customers_site.html (built from data/client_work.csv) -> customers.html.
# Run after every edit to site.html or the CSVs:  python tools/build_index.py
from pathlib import Path
import build_prints, build_clients, build_orion               # regenerate PRINTS in site.html, then the customer work page body
build_prints.build()
build_clients.build()
build_orion.build()
root = Path(__file__).resolve().parent.parent
head = '''<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex">
<style>
:root { padding-top: env(safe-area-inset-top, 0px); padding-bottom: env(safe-area-inset-bottom, 0px); }
body { margin: 0; font-size: 14px; font-family: system-ui, sans-serif; }
img { max-width: 100%; }
[hidden] { display: none !important; }
</style>
'''
for src, out in (('site.html', 'index.html'), ('customers_site.html', 'customers.html'), ('orion_site.html', 'orion.html')):
    body = (root / src).read_text(encoding='utf8')
    # the page's own <title>, metas, font links and <style> come first and belong in <head>
    split = body.index('<div class="wrap">')
    html = head + body[:split] + '</head>\n<body>\n' + body[split:] + '\n</body>\n</html>\n'
    (root / out).write_text(html, encoding='utf8')
    print('wrote', root / out, len(html), 'bytes')
