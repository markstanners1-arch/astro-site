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
# M31: since 1 Nov 2026 the Affinity masked-NoiseX version (sky-only NoiseX, Mark's pick), which is the landscape frame.
# The portrait crop rows 300:3500, cols 150:2030 turned 90 degrees clockwise is landscape rows 150:2030, cols 339:3539.
import tifffile
m = tifffile.imread(B + 'M31_hybrid/M31_masked_noisex.tiff'); m = m[..., :3]
m = (m / 257 + 0.5).astype(np.uint8) if m.dtype == np.uint16 else m
save(m[150:2030, 339:3539], 'm31_after.jpg')
aft = load(B + 'M45_hybrid_prism/processing/M45_hybrid_prism.jpg'); y0, y1, x0, x1 = 1000, 3200, 150, 1950
save(aft[y0:y1, x0:x1], 'm45_after.jpg')
aft = load(B + 'M33_hybrid/processing/M33_hybrid.jpg'); y0, y1, x0, x1 = 1076, 2676, 455, 1655
save(aft[y0:y1, x0:x1], 'm33_after.jpg')
save(load(B + 'IC1396_vespera_all_hybrid/IC1396_vespera_3h.jpg'), 'elephants_trunk.jpg')   # whole 3 h final, 70 px trimmed
