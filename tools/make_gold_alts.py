"""Web copies of the gold-and-blue versions of the five Telescope Live SHO prints, made exactly like the red ones
(the finished picture scaled to 1600 px wide). Checks each gold source has the same size as its red twin and that the
existing red web picture matches the red source, so the two buttons swap like for like."""
import numpy as np
from PIL import Image
Image.MAX_IMAGE_PIXELS = None
B = 'D:/Brampton_Oct7-8_work/'
PAIRS = {   # web name: (red source, gold source)
    'tl_ngc6188': (B + 'TL_NGC6188_drz/processing/sho_red/NGC6188_drz_SHO.jpg', B + 'TL_NGC6188_drz/processing/sho_gold/NGC6188_drz_SHO.jpg'),
    'tl_ic2944': (B + 'TL_IC2944_drz/processing/sho_red/IC2944_drz_SHO_halofix.jpg', B + 'TL_IC2944_drz/processing/sho_gold/IC2944_drz_SHO_halofix.jpg'),
    'tl_ic1848_wide': (B + 'TL_IC1848_drz/processing/sho_red/crops/IC1848_whole_field.jpg', B + 'TL_IC1848_drz/processing/sho_gold/crops/IC1848_whole_field.jpg'),
    'tl_ic1848_heart_soul': (B + 'TL_IC1848_drz/processing/sho_red/crops/IC1848_heart_and_soul.jpg', B + 'TL_IC1848_drz/processing/sho_gold/crops/IC1848_heart_and_soul.jpg'),
    'tl_ic1848_soul': (B + 'TL_IC1848_drz/processing/sho_red/crops/IC1848_soul.jpg', B + 'TL_IC1848_drz/processing/sho_gold/crops/IC1848_soul.jpg'),
}
W = 1600
for name, (red, gold) in PAIRS.items():
    r, g = Image.open(red).convert('RGB'), Image.open(gold).convert('RGB')
    assert r.size == g.size, (name, r.size, g.size)
    web = Image.open(f'D:/Astro_Website/img/{name}.jpg').convert('RGB')
    size = (W, round(W * g.height / g.width))
    rs = np.asarray(r.resize(web.size, Image.LANCZOS), float).mean(2); ws = np.asarray(web, float).mean(2)
    corr = np.corrcoef(rs.ravel(), ws.ravel())[0, 1]
    gw = g.resize(size, Image.LANCZOS)
    gl = np.asarray(gw.resize(web.size), float).mean(2); corr_g = np.corrcoef(gl.ravel(), ws.ravel())[0, 1]
    gw.save(f'D:/Astro_Website/img/{name}_gold.jpg', quality=86, optimize=True, progressive=True)
    print(f'{name}: source {g.size}, web {size}; red web matches red source r={corr:.3f}; gold lines up with red r={corr_g:.3f}')
