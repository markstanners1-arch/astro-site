# Wraps site.html (the page body, also used for the private Claude preview) into a standalone index.html for
# GitHub Pages: adds the document skeleton, charset/viewport and the small reset the preview viewer supplies.
# Run after every edit to site.html:  python tools/build_index.py
from pathlib import Path
import build_prints                              # regenerate the PRINTS section from data/print_sizes.csv first
build_prints.build()
root = Path(__file__).resolve().parent.parent
body = (root / 'site.html').read_text(encoding='utf8')
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
# the page's own <title>, metas, font links and <style> come first in site.html and belong in <head>
split = body.index('<div class="wrap">')
html = head + body[:split] + '</head>\n<body>\n' + body[split:] + '\n</body>\n</html>\n'
(root / 'index.html').write_text(html, encoding='utf8')
print('wrote', root / 'index.html', len(html), 'bytes')
