# Gosforth Skies (working name)

Website for an astrophotography processing pilot: before/after examples from Seestar, Draco and Telescope Live data.

- `site.html` is the page itself; `python tools/build_index.py` turns it into `index.html` for GitHub Pages.
- `tools/make_pairs.py` rebuilds the web images in `img/` from the processed results (aligns before/after pairs by star patterns).
- Served at https://gosforthskies.co.uk (see `CNAME`); gosforthskies.com and astro.oneoffx.uk redirect there. Marked `noindex` while it's a pilot.
