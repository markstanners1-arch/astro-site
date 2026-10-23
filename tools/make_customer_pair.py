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

def crop_match(bef, aft):
    """Fallback when star matching fails (nebula-filled frames): the finished picture is usually a crop of the same
    stack as the plain stretch, at the same scale, maybe turned by a quarter-turn. Find it by matching fine detail."""
    hp = lambda im: (lambda g: g - cv2.GaussianBlur(g, (0, 0), 3))(cv2.cvtColor(im, cv2.COLOR_RGB2GRAY).astype(np.float32))
    s = 0.5 if max(bef.shape) > 3000 else 1.0                # half size keeps it quick on big stacks
    small = lambda im: cv2.resize(im, None, fx=s, fy=s, interpolation=cv2.INTER_AREA)
    B = hp(small(bef)); best = (-1, 0, None)
    for k in range(4):                                       # quarter-turns of the finished picture
        A = hp(small(np.ascontiguousarray(np.rot90(aft, k))))
        if A.shape[0] > B.shape[0] or A.shape[1] > B.shape[1]: continue
        r = cv2.matchTemplate(B, A, cv2.TM_CCOEFF_NORMED); _, v, _, loc = cv2.minMaxLoc(r)
        if v > best[0]: best = (v, k, loc)
    v, k, (x, y) = best
    if v < 0.3: return None
    h, w = np.rot90(aft, k).shape[:2]; x, y = round(x / s), round(y / s)
    print(f'  matched as a crop of the stack (score {v:.2f}, quarter-turns {k})')
    return np.rot90(bef[y:y + h, x:x + w], -k)              # undo the turn so it lines up with the finished picture

T = None
for sigma, pts in ((5, 60), (3, 100), (8, 40), (2, 150)):     # the app's stack and the finished picture differ a lot,
    try:                                                     # so try a few star-detection levels
        T, (src, dst) = aa.find_transform(bef.mean(2).astype(np.float32), aft.mean(2).astype(np.float32),
                                          max_control_points=pts, detection_sigma=sigma)
        break
    except (aa.MaxIterError, TypeError, Exception) as err:    # TypeError: too much nebula for the star finder
        print('  no star match at detection level', sigma)
size = (aft.shape[1], aft.shape[0])
if T is not None:
    print('  stars matched', len(src), 'rotation %.2f deg, scale %.4f' % (np.degrees(T.rotation), T.scale))
    bef = cv2.warpAffine(bef, T.params[:2], size)
else:
    bef = crop_match(bef, aft)
    if bef is None:
        raise SystemExit('Could not line the pictures up: check both show the same field.')
    if not a.crop: a.crop = f'0,{size[1]},0,{size[0]}'   # an exact crop of the stack: use the whole finished picture
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
