"""Copy the site's Google Fonts (latin subset, woff2) into fonts/ and write fonts/fonts.css, so pages load no font from Google
(visitors' IP addresses then never reach Google). Run once, or again if the font choice changes. Standard library only.
All three families are under the SIL Open Font License, which allows this."""
import re, urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
URL = ('https://fonts.googleapis.com/css2?family=Newsreader:ital,opsz,wght@0,6..72,400;0,6..72,500;1,6..72,400'
       '&family=Public+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap')
UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'   # asks for woff2

css = urllib.request.urlopen(urllib.request.Request(URL, headers={'User-Agent': UA})).read().decode()
out_dir = ROOT / 'fonts'; out_dir.mkdir(exist_ok=True)
blocks, n = [], 0
for comment, block in re.findall(r'/\* ([\w-]+) \*/\s*(@font-face \{.*?\})', css, re.S):
    if comment != 'latin':
        continue                                     # the page is English only
    fam = re.search(r"font-family: '([^']+)'", block).group(1)
    style = re.search(r'font-style: (\w+)', block).group(1)
    weight = re.search(r'font-weight: ([\d ]+);', block).group(1).replace(' ', '-')
    url = re.search(r'url\((https://[^)]+\.woff2)\)', block).group(1)
    name = f"{fam.replace(' ', '')}-{style}-{weight}.woff2"
    (out_dir / name).write_bytes(urllib.request.urlopen(url).read())
    blocks.append(block.replace(url, name)); n += 1
(out_dir / 'fonts.css').write_text('/* self-hosted copies of the Google Fonts (tools/fetch_fonts.py) */\n' + '\n'.join(blocks) + '\n')
print(n, 'faces,', sum(f.stat().st_size for f in out_dir.glob('*.woff2')) // 1024, 'KB')
