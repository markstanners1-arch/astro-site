# 1 Nov 2026: rebuild only the "after" gallery images from the sky-neutralised finals, with the same crops, orientation,
# size and JPEG settings as make_pairs.py. The "before" images (plain stretches of the stacks) are unchanged by the fix.
import numpy as np
from PIL import Image
OUT = 'D:/Astro_Website/img/'
W = 1600
def load(p): return np.asarray(Image.open(p).convert('RGB'))
def save(img, name, rot=False):
    if rot: img = np.rot90(img, -1)                        # 90 deg clockwise (landscape), never flipped
    im = Image.fromarray(np.ascontiguousarray(img)); h = round(im.height * W / im.width)
    im.resize((W, h), Image.LANCZOS).save(OUT + name, quality=86, optimize=True, progressive=True); print('  saved', name, (W, h))
B = 'D:/Brampton_Oct7-8_work/'
aft = load(B + 'M31_hybrid/M31_hybrid_Ha.jpg'); y0, y1, x0, x1 = 300, 3500, 150, 2030
save(aft[y0:y1, x0:x1], 'm31_after.jpg', rot=True)
aft = load(B + 'M45_hybrid_prism/processing/M45_hybrid_prism.jpg'); y0, y1, x0, x1 = 1000, 3200, 150, 1950
save(aft[y0:y1, x0:x1], 'm45_after.jpg')
aft = load(B + 'M33_hybrid/processing/M33_hybrid.jpg'); y0, y1, x0, x1 = 1076, 2676, 455, 1655
save(aft[y0:y1, x0:x1], 'm33_after.jpg')
save(load(B + 'IC1396_vespera_all_hybrid/IC1396_vespera_3h.jpg'), 'elephants_trunk.jpg')   # whole 3 h final, 70 px trimmed
