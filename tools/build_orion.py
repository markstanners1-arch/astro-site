# Builds the "Orion, together" community project page (orion_site.html, wrapped into orion.html by build_index.py).
# The words live in data/orion_body.html; the progress figures and project upload code in data/orion_progress.json
# ({{contributors}}, {{hours}}, {{code}} in the words are filled from it). Header, footer, styles and scripts are copied
# from the home page, as for the Customer work page.
import json, re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

def build():
    site = (ROOT / 'site.html').read_text(encoding='utf8')
    split = site.index('<div class="wrap">')
    head = re.sub(r'<title>.*?</title>', '<title>Orion, together · Gosforth Skies</title>', site[:split], count=1)
    head = re.sub(r'<meta name="description"[^>]*>', '<meta name="description" content="A community astrophotography '
                  'project: many small telescopes combined into one deep picture of the Orion Nebula, winter 2026-27.">', head, count=1)
    head = head.replace('</style>', '''/* Orion page */
.tally { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; margin-top: 28px; max-width: 640px; }
.tally div { background: var(--deep); border: 1px solid var(--rule); border-radius: 8px; padding: 14px 16px; display: grid; gap: 2px; }
.tally b { font: 400 1.9rem/1 var(--font-display); color: var(--ha); font-variant-numeric: tabular-nums; }
.tally span { font: 400 0.78rem var(--font-data); color: var(--dim); letter-spacing: 0.04em; }
@media (max-width: 480px) { .tally { gap: 8px; } .tally div { padding: 10px; } .tally b { font-size: 1.35rem; white-space: nowrap; } .tally span { font-size: 0.68rem; } }
ul.plain { margin: 20px 0 0; padding-left: 20px; display: grid; gap: 8px; max-width: 720px; color: var(--ink); }
</style>''', 1)
    header = re.search(r'  <header class="top">.*?</header>', site, re.S).group(0)
    header = header.replace('href="#', 'href="index.html#').replace('<div class="brand">', '<a class="brand" href="index.html">', 1)
    header = re.sub(r'(<a class="brand"[^>]*>.*?)</div>', r'\1</a>', header, count=1, flags=re.S)
    footer = re.search(r'<div class="wrap">\s*<footer>.*?</footer>\s*</div>', site, re.S).group(0)
    footer = footer.replace('href="#privacy"', 'href="index.html#privacy"')
    scripts = re.search(r'<script>\s*document\.querySelectorAll\(\'\.ba\'\).*?</script>', site, re.S).group(0)
    data = json.loads((ROOT / 'data' / 'orion_progress.json').read_text(encoding='utf8'))
    body = (ROOT / 'data' / 'orion_body.html').read_text(encoding='utf8')
    hours = data['hours']
    for k, v in (('contributors', data['contributors']), ('hours', f'{hours:g}'), ('code', data['code'])):
        body = body.replace('{{' + k + '}}', str(v))
    (ROOT / 'orion_site.html').write_text(f'{head}<div class="wrap">\n{header}\n</div>\n\n{body}\n{footer}\n\n{scripts}\n', encoding='utf8')
    return data

if __name__ == '__main__':
    print('orion page built:', build())
