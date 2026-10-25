# Builds the Privacy policy (privacy.html) and Terms (terms.html) pages from data/privacy_body.html and
# data/terms_body.html. Header, footer and styles are copied from the home page (site.html), as for the Customer work
# and Orion pages, and the result is wrapped into a standalone page the same way build_index.py does.
#     python tools/build_legal.py
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
UPDATED = '25 October 2026'
PAGES = {
    'privacy.html': ('privacy_body.html', 'Privacy policy', 'How Gosforth Skies handles your data: what is collected, why, for how long, and your rights.'),
    'terms.html': ('terms_body.html', 'Terms', 'Terms for the Gosforth Skies image processing service and print sales.'),
}
WRAP = '''<!doctype html>
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
CSS = '''/* legal pages */
.legal h2 { font-size: clamp(1.4rem, 3vw, 1.9rem); margin-top: clamp(32px, 5vw, 48px); }
.legal h3 { font-size: 1.15rem; margin-top: 24px; }
.legal p, .legal .log, .legal ul.plain { max-width: 760px; margin-top: 12px; }
.legal .log { font-size: 0.86rem; }
ul.plain { margin: 12px 0 0; padding-left: 20px; display: grid; gap: 8px; max-width: 760px; color: var(--ink); }
</style>'''

def build():
    site = (ROOT / 'site.html').read_text(encoding='utf8')
    split = site.index('<div class="wrap">')
    header = re.search(r'  <header class="top">.*?</header>', site, re.S).group(0)
    header = header.replace('href="#', 'href="index.html#').replace('<div class="brand">', '<a class="brand" href="index.html">', 1)
    header = re.sub(r'(<a class="brand"[^>]*>.*?)</div>', r'\1</a>', header, count=1, flags=re.S)
    footer = re.search(r'<div class="wrap">\s*<footer>.*?</footer>\s*</div>', site, re.S).group(0)
    footer = footer.replace('href="#privacy"', 'href="privacy.html"').replace('</footer>',
        '  <p><a href="privacy.html">Privacy policy</a> · <a href="terms.html">Terms</a></p>\n  </footer>', 1)
    for out, (src, title, desc) in PAGES.items():
        head = re.sub(r'<title>.*?</title>', f'<title>{title} · Gosforth Skies</title>', site[:split], count=1)
        head = re.sub(r'<meta name="description"[^>]*>', f'<meta name="description" content="{desc}">', head, count=1)
        head = head.replace('</style>', CSS, 1)
        body = (ROOT / 'data' / src).read_text(encoding='utf8').replace('{{updated}}', UPDATED)
        page = f'<div class="wrap">\n{header}\n</div>\n\n{body}\n{footer}\n'
        html = WRAP + head + '</head>\n<body>\n' + page + '\n</body>\n</html>\n'
        (ROOT / out).write_text(html, encoding='utf8')
        print('wrote', out, len(html), 'bytes')

if __name__ == '__main__':
    build()
