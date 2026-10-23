# Builds the gallery images for the website: each "before" is aligned onto its "after" (star-pattern matching),
# both are cropped to the same region, oriented, and saved as web-size JPEGs in ../img.
import numpy as np, cv2, re, struct, astroalign as aa
from PIL import Image
OUT = 'D:/Astro_Website/img/'
W = 1600                                                     # web width of each image

def load(p): return np.asarray(Image.open(p).convert('RGB'))
def align(before, after):
    # match star patterns (astroalign); SIFT features fail on processed star fields that look different
    T, (src, dst) = aa.find_transform(before.mean(2).astype(np.float32), after.mean(2).astype(np.float32),
                                      max_control_points=60, detection_sigma=5)
    print('  stars matched', len(src), 'rotation %.2f deg, scale %.4f' % (np.degrees(T.rotation), T.scale))
    return cv2.warpAffine(before, T.params[:2], (after.shape[1], after.shape[0]))
def save(img, name, rot=False):
    if rot: img = np.rot90(img, -1)                        # 90 deg clockwise (landscape), never flipped
    im = Image.fromarray(np.ascontiguousarray(img)); h = round(im.height*W/im.width)
    im.resize((W, h), Image.LANCZOS).save(OUT + name, quality=86, optimize=True, progressive=True); print('  saved', name, (W, h))
def rd_xisf(p):
    with open(p,'rb') as f:
        f.read(8); n=struct.unpack('<I',f.read(4))[0]; f.read(4); xml=f.read(n).decode('utf8','ignore')
        m=re.search(r'<Image [^>]*>',xml).group(0); Wd,H,C=map(int,re.search(r'geometry="(\d+):(\d+):(\d+)"',m).groups())
        sf=re.search(r'sampleFormat="(\w+)"',m).group(1); pos,sz=map(int,re.search(r'location="attachment:(\d+):(\d+)"',m).groups())
        f.seek(pos); return np.frombuffer(f.read(sz),{'Float32':'<f4','Float64':'<f8'}[sf]).reshape(C,H,Wd).astype(np.float32)
def quick_stretch(a):                                       # what a plain screen stretch of the stack looks like
    out = []
    for c in a:
        med = np.median(c); mad = 1.4826*np.median(np.abs(c-med)); c0 = med-2.8*mad
        x = np.clip((c-c0)/(1-c0), 0, 1); xm = (med-c0)/(1-c0); m = ((0.25-1)*xm)/((2*0.25-1)*xm-0.25)
        out.append(((m-1)*x)/((2*m-1)*x-m))
    return (np.clip(np.stack(out, -1), 0, 1)*255).astype(np.uint8)

# M 31: plain stretch of the all-nights Seestar stack -> hybrid final of the same stack (plus its Ha layer), cropped
# around the galaxy, landscape. 23 Oct: the before was the app's one-night stack, an unfair comparison. The stack lives
# on the exFAT archive drive (E: when plugged in, see D:\NINA\DRIVES.md).
print('M31'); aft = load('D:/Brampton_Oct7-8_work/M31_hybrid/M31_hybrid_Ha.jpg')
bef = quick_stretch(rd_xisf('E:/Astro archive/M31_seestar_all/processing/02_colour_calibrated_linear.xisf'))
assert bef.shape == aft.shape, (bef.shape, aft.shape)
y0, y1, x0, x1 = 300, 3500, 150, 2030
save(bef[y0:y1, x0:x1], 'm31_before.jpg', rot=True); save(aft[y0:y1, x0:x1], 'm31_after.jpg', rot=True)

# Pleiades: plain stretch of the 58-minute two-night stack -> hybrid of the same stack (23 Oct: the before was the
# app's one-night stack, which made the comparison unfair; now both sides are the same data)
print('M45'); aft = load('D:/Brampton_Oct7-8_work/M45_hybrid/processing/M45_hybrid.jpg')
bef = quick_stretch(rd_xisf('D:/Brampton_Oct7-8_work/M45_combined/processing/02_colour_calibrated_linear.xisf'))
assert bef.shape == aft.shape, (bef.shape, aft.shape)
y0, y1, x0, x1 = 1000, 3200, 150, 1950
save(bef[y0:y1, x0:x1], 'm45_before.jpg'); save(aft[y0:y1, x0:x1], 'm45_after.jpg')

# M33: plain stretch of the stack -> hybrid
print('M33'); aft = load('D:/Brampton_Oct7-8_work/M33_hybrid/processing/M33_hybrid.jpg')
bef = quick_stretch(rd_xisf('D:/Brampton_Oct7-8_work/M33_full/processing/02_colour_calibrated_linear.xisf'))
y0, y1, x0, x1 = 1076, 2676, 455, 1655
save(bef[y0:y1, x0:x1], 'm33_before.jpg'); save(aft[y0:y1, x0:x1], 'm33_after.jpg')

# Draco Heart (Dwarflab sample data): plain stretch of the stack -> orange/blue
print('Draco'); aft = load('D:/Brampton_Oct7-8_work/Draco_Heart_hybrid/Draco_Heart_orange_blue.jpg')
bef = quick_stretch(rd_xisf('D:/Brampton_Oct7-8_work/Draco_Heart/processing/02_colour_calibrated_linear.xisf'))
save(bef, 'heart_before.jpg'); save(aft, 'heart_after.jpg')
save(load('D:/Brampton_Oct7-8_work/Draco_Heart_hybrid/Draco_Heart_HOO.jpg'), 'heart_hoo.jpg')

# Heart and Soul mosaic (Seestar), shown on its own
print('Mosaic'); save(load('D:/IC1805_work/IC1805_F5_lifted.jpg'), 'heart_soul_mosaic.jpg', rot=True)

# Telescope Live data processed by Mark (credit "Data: Telescope Live" on the site)
print('Telescope Live')
save(load('G:/My Drive/Astro hand-off/NGC6188/NGC6188_first_merge_SHO.jpg'), 'tl_ngc6188.jpg')
save(load('G:/My Drive/Astro hand-off/IC2944/IC2944_first_merge_SHO.jpg'), 'tl_ic2944.jpg')
# M57 is being reworked; the Dumbbell stands in for now
m27 = load('G:/My Drive/Astro hand-off/M27/M27_first_merge_SHO.jpg'); h, w = m27.shape[:2]
save(m27[h//2-1000:h//2+1000, w//2-1600:w//2+1600], 'tl_m27.jpg')   # centred crop, 1.6:1
