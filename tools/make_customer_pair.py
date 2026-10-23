# Makes the two slider images for a Customer work entry: the "before" (scope app stack or plain stretch) is aligned
# onto the finished picture by star-pattern matching, both get the same framing, and both are saved web-size in img/.
#   python tools/make_customer_pair.py BEFORE.jpg AFTER.jpg c_rosette [--crop y0,y1,x0,x1] [--rotate]
# writes img/c_rosette_before.jpg and img/c_rosette_after.jpg; put those names in data/client_work.csv.
# --crop is in the finished picture's pixels; --rotate turns both 90° clockwise (never flipped).
import argparse, numpy as np, cv2, astroalign as aa
from pathlib import Path
from PIL import Image

OUT = Path(__file__).resolve().parent.parent / 'img'
W = 1600                                         # longest side on the web

def load(p): return np.asarray(Image.open(p).convert('RGB'))

def save(a, name):
    im = Image.fromarray(np.ascontiguousarray(a)); s = W / max(im.size)
    if s < 1: im = im.resize((round(im.width * s), round(im.height * s)), Image.LANCZOS)
    im.save(OUT / name, quality=86, optimize=True, progressive=True); print('  saved', name, im.size)

ap = argparse.ArgumentParser()
ap.add_argument('before'); ap.add_argument('after'); ap.add_argument('name')
ap.add_argument('--crop'); ap.add_argument('--rotate', action='store_true')
a = ap.parse_args()
aft = load(a.after); bef = load(a.before)
for sigma, pts in ((5, 60), (3, 100), (8, 40), (2, 150)):     # the app's stack and the finished picture differ a lot,
    try:                                                     # so try a few star-detection levels
        T, (src, dst) = aa.find_transform(bef.mean(2).astype(np.float32), aft.mean(2).astype(np.float32),
                                          max_control_points=pts, detection_sigma=sigma)
        break
    except aa.MaxIterError:
        print('  no match at detection level', sigma)
else:
    raise SystemExit('Could not match the star patterns: check both pictures show the same field.')
print('  stars matched', len(src), 'rotation %.2f deg, scale %.4f' % (np.degrees(T.rotation), T.scale))
size = (aft.shape[1], aft.shape[0])
bef = cv2.warpAffine(bef, T.params[:2], size)
if a.crop:
    y0, y1, x0, x1 = map(int, a.crop.split(','))
else:
    # no crop given: the largest rectangle that the turned "before" covers completely, kept 3% inside its edges
    # so the app's dark border and watermark stay out (field rotation often turns the app stack a long way)
    ok = cv2.warpAffine(np.ones(bef.shape[:2], np.uint8), T.params[:2], size)
    # app stacks carry their own black corners from field rotation: treat pure-black areas as not covered
    sky = cv2.blur(cv2.cvtColor(bef, cv2.COLOR_RGB2GRAY), (31, 31)) > 3
    ok = ok & sky.astype(np.uint8)
    m = 2 * int(0.03 * max(size)) + 1
    ok = cv2.erode(ok, np.ones((m, m), np.uint8))
    ys, xs = np.nonzero(ok); cy, cx = int(ys.mean()), int(xs.mean())
    best = (0, 0, 0, 0, 0)
    for aspect in np.linspace(0.4, 2.5, 43):                 # width / height
        lo, hi = 0.0, float(max(size))
        while hi - lo > 2:
            h = (lo + hi) / 2; w = h * aspect
            y0, y1, x0, x1 = int(cy - h / 2), int(cy + h / 2), int(cx - w / 2), int(cx + w / 2)
            inside = y0 >= 0 and x0 >= 0 and y1 <= size[1] and x1 <= size[0] and ok[y0:y1, x0:x1].all()
            lo, hi = (h, hi) if inside else (lo, h)
        h = lo; w = h * aspect
        if w * h > best[0]: best = (w * h, int(cy - h / 2), int(cy + h / 2), int(cx - w / 2), int(cx + w / 2))
    _, y0, y1, x0, x1 = best
    print(f'  crop {y0},{y1},{x0},{x1} ({x1 - x0} x {y1 - y0} of {size[0]} x {size[1]})')
bef, aft = bef[y0:y1, x0:x1], aft[y0:y1, x0:x1]
if a.rotate: bef, aft = np.rot90(bef, -1), np.rot90(aft, -1)
save(bef, a.name + '_before.jpg'); save(aft, a.name + '_after.jpg')
