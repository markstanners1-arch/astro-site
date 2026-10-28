// Gosforth Skies upload service: a Cloudflare Worker in front of the R2 bucket "gosforth-uploads".
// The site's "Send your frames" box talks to it; tools/fetch_uploads.py on the desktop collects the sets.
//
//   POST /start              {name, email, target, scope, location, files:[{name,size}]}  -> {set}
//   PUT  /put?set=&name=     body = one file (under MAX_FILE)                               -> {ok}
//   GET  /have?set=          names already stored, so an interrupted upload skips them      -> {names}
//   POST /mpu/start?set=&name=            a file over 90 MB goes in parts instead           -> {uploadId}
//   PUT  /mpu/part?set=&name=&uploadId=&n= body = one part (50 MB)                        -> {partNumber, etag}
//   POST /mpu/done?set=&name=&uploadId=   {parts}                                          -> {ok}
//   POST /finish?set=        marks the set complete and emails a note                       -> {ok}
//   POST /request            {name, email, object, size, note}: a print request, no invite needed -> {ok}
// Writes need header X-Invite = one of the invite codes in _config/codes.json in the bucket ({"code": "who it's for"}), so a
// code can be given to one person and withdrawn on its own without a redeploy. Admin calls need Authorization: Bearer ADMIN_KEY:
//   GET /admin/sets   GET /admin/file?key=   DELETE /admin/set?set=   GET|PUT /admin/codes
// Total storage is held under QUOTA so the bucket stays inside R2's free 10 GB.
//
// OUTBOX (finished pictures going back to a client), driven by tools in D:\NINA\deliver.py:
//   POST /admin/outbox/job {client, email, title, set}  -> {job, link}     creates _outbox/<job>/_job.json
//   POST /admin/outbox/start?job=&name=                 -> {uploadId}      multipart upload, so a 300 MB TIFF fits
//   PUT  /admin/outbox/part?job=&name=&uploadId=&n=     body = one part    -> {partNumber, etag}
//   POST /admin/outbox/done?job=&name=&uploadId=        {parts}            -> {ok}
//   GET  /admin/outbox                                  every job and its state
//   DELETE /admin/outbox/job?job=                       clear a job's files now
//   GET  /d/<job>  and  /d/<job>/<file>                 the client's download page and files (the job id is the secret)
// The first download is recorded and emailed to Mark. A daily run (scheduled below) clears a job's files 7 days after
// its first download, nudges Mark at 7 days if nothing has been downloaded, and clears anything 30 days old.
// Cloudflare only sends mail to verified addresses, so mail to clients goes out from Mark's Gmail, never from here.
import { EmailMessage } from 'cloudflare:email';

const QUOTA = 50e9;                          // raised from 20 GB on 24 Oct 2026 (three overnight sets filled it). R2 bills average storage (10 GB-months free); sets are collected within hours, so spikes cost ~nothing. Worst case full all month: about 50p
const MAX_FILE = 95e6;                       // a Worker request body can be up to 100 MB on the free plan: bigger files use /mpu
const MAX_BIG = 2e9;                         // largest single frame accepted in parts (61 MP cameras are about 120 MB)
const OK_EXT = /\.(fit|fits|fts|xisf|cr2|cr3|nef|arw|txt)$/i;   // FITS, DSLR / mirrorless raws (28 Oct, Orion spec), and a session's notes.txt
const MAX_TXT = 1e6;                         // a notes file is a few lines: cap .txt so it can't carry anything big
// the site moved to gosforthskies.co.uk on 23 Oct 2026; the old address stays allowed while it redirects
const SITES = ['https://gosforthskies.co.uk', 'https://www.gosforthskies.co.uk', 'https://astro.oneoffx.uk', 'https://together.oneoffx.co.uk'];  // the community project site 'One sky, together' (25 Oct)

const cors = (req) => ({
  'Access-Control-Allow-Origin': SITES.includes(req?.headers.get('Origin')) ? req.headers.get('Origin') : SITES[0],
  'Vary': 'Origin',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Invite, Authorization',
  'Access-Control-Max-Age': '86400',
});
const json = (req, body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...cors(req) } });
const clean = (s, n = 80) => String(s || '').replace(/[^\w .,()'@+-]/g, '').trim().slice(0, n);
const safeName = (s) => String(s || '').replace(/[\\/]/g, '_').replace(/[^\w .()+-]/g, '').slice(0, 120);

async function listAll(bucket, prefix) {
  const out = [];
  let cursor;
  do {
    const page = await bucket.list({ prefix, cursor, limit: 1000 });
    out.push(...page.objects);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return out;
}
async function codes(env) {
  const c = await env.BUCKET.get('_config/codes.json');
  return c ? c.json() : {};
}
async function meta(env, set) {
  const m = await env.BUCKET.get(`${set}/_meta.json`);
  return m ? m.json() : null;
}

const DAY = 864e5, KEEP_AFTER_DOWNLOAD = 7 * DAY, NUDGE_AFTER = 7 * DAY, CLEAR_AFTER = 30 * DAY;
async function tellMark(env, subject, lines) {
  const raw = [`From: Gosforth Skies <${env.MAIL_FROM}>`, `To: ${env.MAIL_TO}`, `Subject: ${subject}`,
    `Message-ID: <${crypto.randomUUID()}@oneoffx.uk>`, `Date: ${new Date().toUTCString()}`, `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset=utf-8`, ``, ...lines].join('\r\n');
  try { await env.MAILER.send(new EmailMessage(env.MAIL_FROM, env.MAIL_TO, raw)); } catch (e) { console.log('email failed', e); }
}
async function job(env, id) {
  const j = await env.BUCKET.get(`_outbox/${id}/_job.json`);
  return j ? j.json() : null;
}
const putJob = (env, j) => env.BUCKET.put(`_outbox/${j.job}/_job.json`, JSON.stringify(j), { httpMetadata: { contentType: 'application/json' } });
async function jobFiles(env, id) {
  return (await listAll(env.BUCKET, `_outbox/${id}/`)).filter((o) => !o.key.endsWith('/_job.json'))
    .map((o) => ({ name: o.key.split('/').pop(), size: o.size }));
}
async function clearJob(env, j, why) {
  const keys = (await listAll(env.BUCKET, `_outbox/${j.job}/`)).map((o) => o.key).filter((k) => !k.endsWith('/_job.json'));
  if (keys.length) await env.BUCKET.delete(keys);
  j.cleared = new Date().toISOString(); j.cleared_why = why;
  await putJob(env, j);
}
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// a review job (j.review = [{file, label}], optional j.before) shows the versions to choose between, with a form whose
// choice and comment go to Mark; viewing them (?view=1) doesn't count as a download, so the 7-day clock doesn't start
function reviewBlock(j) {
  if (!j.review || !j.review.length) return '';
  const pic = (file, label) => `<figure><a href="/d/${j.job}/${encodeURIComponent(file)}?view=1" target="_blank" rel="noopener">` +
    `<img src="/d/${j.job}/${encodeURIComponent(file)}?view=1" alt="${esc(label)}" loading="lazy"></a><figcaption>${esc(label)}</figcaption></figure>`;
  // fine-tune sliders (any picture) and a blend between two versions: previewed live with CSS, sent with the choice so
  // Mark can repeat them at full size (D:\NINA\apply_tune.py)
  const tunable = (file, label) => `<div class="tv" data-label="${esc(label)}">${pic(file, label)}<details><summary>Fine-tune</summary>` +
    ['b|Brightness|darker|brighter', 'k|Colour|muted|vivid', 'c|Contrast|softer|punchier'].map((s) => { const [k, n, lo, hi] = s.split('|');
      return `<label class="sl"><span>${n}</span><small>${lo}</small><input type="range" min="60" max="140" value="100" data-k="${k}"><small>${hi}</small></label>`; }).join('') +
    `<button type="button" class="rs">Reset</button></details></div>`;
  const blend = j.review.length > 1 ? `<h2>Or blend two versions</h2><p class="n">Pick two and slide between them.</p>
<div class="bl"><select id="ba">${j.review.map((r, i) => `<option value="${i}"${i === 0 ? ' selected' : ''}>${esc(r.label)}</option>`).join('')}</select>
<select id="bb">${j.review.map((r, i) => `<option value="${i}"${i === 1 ? ' selected' : ''}>${esc(r.label)}</option>`).join('')}</select>
<div class="stack"><img id="ia" alt=""><img id="ib" alt=""></div>
<label class="sl"><small>first</small><input type="range" id="bm" min="0" max="100" value="50"><small>second</small></label>
<label class="opt"><input type="checkbox" id="buse"> I'd like this blend as a full-size file too</label></div>` : '';
  const before = j.before ? `<p class="n">Before: your telescope app's own picture.</p><div class="g one">${pic(j.before, 'As stacked by the app')}</div>` : '';
  const opts = j.review.map((r) => `<label class="opt"><input type="checkbox" name="choice" value="${esc(r.label)}"> ${esc(r.label)}</label>`).join('')
    + `<label class="opt all"><input type="checkbox" id="all"> All of them</label>`;
  const done = j.feedback ? `<p class="ok">Thanks: you picked <b>${esc([...[].concat(j.feedback.choice), ...(j.feedback.blend ? ['a blend'] : [])].join(', '))}</b>. Mark has your note and will send the full-size files.</p>` : '';
  const files = JSON.stringify(j.review.map((r) => `/d/${j.job}/${encodeURIComponent(r.file)}?view=1`)).replace(/</g, '\\u003c');
  return `${before}<h2>Pick your favourites</h2><p class="n">Click a picture to see it larger. Open <b>Fine-tune</b> under any picture to adjust it; your settings are sent with your choice.</p><div class="g">${j.review.map((r) => tunable(r.file, r.label)).join('')}</div>
${blend}${done}<form id="pick"${j.feedback ? ' hidden' : ''}><fieldset><legend>Tick the ones you'd like as full-size files (as many as you like)</legend>${opts}</fieldset>
<label class="c">Anything you'd change? (brighter, less red, crop tighter…)<textarea name="comment" rows="3"></textarea></label>
<button>Send my choices</button><p class="n" id="msg"></p></form>
<script>const FILES=${files};
function css(t){return 'brightness('+t.b/100+') contrast('+t.c/100+') saturate('+(t.k/100)**1.6+')'}
function val(box){const t={b:100,c:100,k:100};box.querySelectorAll('input[type=range]').forEach(i=>t[i.dataset.k]=+i.value);return t}
document.querySelectorAll('.tv').forEach(box=>{const img=box.querySelector('img'),up=()=>{img.style.filter=css(val(box))};
box.querySelectorAll('input[type=range]').forEach(i=>i.addEventListener('input',up));
box.querySelector('.rs').addEventListener('click',()=>{box.querySelectorAll('input[type=range]').forEach(i=>i.value=100);up()})});
function tunes(){const o={};document.querySelectorAll('.tv').forEach(box=>{const t=val(box);if(t.b!=100||t.c!=100||t.k!=100)o[box.dataset.label]=t});return o}
const ba=document.getElementById('ba'),bb=document.getElementById('bb'),bm=document.getElementById('bm'),ia=document.getElementById('ia'),ib=document.getElementById('ib');
function bl(){if(!ba)return;ia.src=FILES[ba.value];ib.src=FILES[bb.value];ib.style.opacity=bm.value/100}
[ba,bb,bm].forEach(x=>x?.addEventListener('input',bl));bl();
function blendPick(){const u=document.getElementById('buse');if(!u||!u.checked)return null;return{a:ba.options[ba.selectedIndex].text,b:bb.options[bb.selectedIndex].text,second:+bm.value}}
const A=document.getElementById('all');A?.addEventListener('change',()=>document.querySelectorAll('input[name=choice]').forEach(x=>x.checked=A.checked));
document.getElementById('pick')?.addEventListener('submit',async e=>{e.preventDefault();const f=new FormData(e.target),m=document.getElementById('msg');if(!f.getAll('choice').length&&!blendPick()){m.textContent='Tick at least one.';return}
m.textContent='Sending…';try{const r=await fetch(location.pathname.replace(/\\/$/,'')+'/choose',{method:'POST',headers:{'Content-Type':'application/json'},
body:JSON.stringify({choice:f.getAll('choice'),comment:f.get('comment'),tune:tunes(),blend:blendPick()})});if(!r.ok)throw 0;e.target.hidden=true;m.textContent='';
e.target.insertAdjacentHTML('afterend','<p class="ok">Thanks: Mark has your choices and will send the full-size files.</p>')}catch{m.textContent='That didn\\'t send. Please try again.'}})</script>`;
}
function downloadPage(j, files) {
  const mb = (n) => (n / 1e6).toFixed(n > 1e8 ? 0 : 1) + ' MB';
  const listed = files.filter((f) => !(j.review || []).some((r) => r.file === f.name) && f.name !== j.before);
  const rows = listed.map((f) => `<li><a href="/d/${j.job}/${encodeURIComponent(f.name)}">${esc(f.name)}</a><span>${mb(f.size)}</span></li>`).join('');
  const body = j.cleared && j.moved && /^https:\/\/upload\.(gosforthskies\.co\.uk|oneoffx\.uk)\/d\/[\w-]+$/.test(j.moved)
    ? `<p>This page has been updated. Your pictures are now here:</p><p><a href="${j.moved}">${esc(j.moved)}</a></p>`
    : j.cleared
    ? `<p>These files have been cleared. If you still need them, reply to Mark's email and he'll send them again.</p>`
    : reviewBlock(j) + (rows ? `<h2>Downloads</h2><ul>${rows}</ul><p class="n">The TIFF is the full-size file for printing; the JPEG is for sharing. The link stays open for 7 days after your first download.</p>` : '');
  return `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(j.title)} · Gosforth Skies</title><style>
body{margin:0;background:#0b1019;color:#e6e9ef;font:16px/1.6 system-ui,sans-serif}main{max-width:640px;margin:0 auto;padding:40px 16px}
h1{font:400 1.9rem/1.2 Georgia,serif;margin:0 0 6px}.e{font:500 .75rem ui-monospace,monospace;letter-spacing:.12em;text-transform:uppercase;color:#e0664d}
ul{list-style:none;padding:0;margin:24px 0;display:grid;gap:10px}li{display:flex;justify-content:space-between;gap:12px;background:#121a27;border:1px solid #243046;border-radius:8px;padding:14px 16px}
a{color:#e6e9ef;font-weight:600;text-decoration-color:#e0664d;overflow-wrap:anywhere}span,.n{color:#95a0b4;font-size:.9rem}
main{max-width:960px}h2{font:400 1.4rem Georgia,serif;margin:32px 0 8px}.g{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,280px),1fr));gap:16px;margin:12px 0}
.g.one{grid-template-columns:minmax(0,420px)}details{margin-top:6px;background:#121a27;border:1px solid #243046;border-radius:8px;padding:6px 10px}
summary{cursor:pointer;color:#95a0b4;font-size:.9rem}.sl{display:grid;grid-template-columns:5.5em auto 1fr auto;align-items:center;gap:6px;margin:8px 0;font-size:.9rem}
.sl small{color:#95a0b4;font-size:.75rem}.sl input{width:100%;accent-color:#e0664d}.bl .sl{grid-template-columns:auto 1fr auto}
.rs{background:none;border:1px solid #243046;color:#95a0b4;border-radius:6px;padding:2px 10px;cursor:pointer}
.bl select{background:#121a27;color:#e6e9ef;border:1px solid #243046;border-radius:6px;padding:6px;margin:0 8px 8px 0;max-width:100%}
.stack{position:relative;max-width:640px}.stack img{width:100%;display:block;border-radius:6px}.stack #ib{position:absolute;inset:0}
figure{margin:0}figure img{width:100%;border-radius:6px;display:block;background:#000}figcaption{color:#95a0b4;font-size:.9rem;margin-top:6px}
form{background:#121a27;border:1px solid #e0664d;border-radius:8px;padding:18px;display:grid;gap:12px;margin-top:16px}fieldset{border:0;padding:0;margin:0;display:grid;gap:6px}
legend{font-weight:600;margin-bottom:6px}.opt{display:flex;gap:8px;align-items:center}.c{display:grid;gap:6px;color:#95a0b4;font-size:.9rem}
textarea{font:inherit;color:#e6e9ef;background:#0b1019;border:1px solid #243046;border-radius:6px;padding:8px}button{justify-self:start;padding:11px 20px;border:0;border-radius:999px;background:#e0664d;color:#fff;font:600 .95rem system-ui,sans-serif;cursor:pointer}
.ok{color:#5fb7b0;font-weight:600}</style></head>
<body><main><p class="e">Gosforth Skies</p><h1>${esc(j.title)}</h1><p>Processed for ${esc(j.client)} by Mark Stanners.</p>${body}</main></body></html>`;
}

async function notify(env, m, count, bytes) {
  const body = [`New frames uploaded to Gosforth Skies.`, ``,
    `From: ${m.name} <${m.email}>`, `Invite code: ${m.invite || '?'}`, `Target: ${m.target}`, `Scope: ${m.scope}`, `Where: ${m.location}`,
    `Files: ${count} (${(bytes / 1e9).toFixed(2)} GB)`, `Set: ${m.set}`, ``,
    `Collect with: python tools/fetch_uploads.py`].join('\r\n');
  const raw = [`From: Gosforth Skies uploads <${env.MAIL_FROM}>`, `To: ${env.MAIL_TO}`,
    `Subject: Frames from ${m.name}: ${m.target}`, `Message-ID: <${crypto.randomUUID()}@oneoffx.uk>`,
    `Date: ${new Date().toUTCString()}`, `MIME-Version: 1.0`, `Content-Type: text/plain; charset=utf-8`, ``, body].join('\r\n');
  await env.MAILER.send(new EmailMessage(env.MAIL_FROM, env.MAIL_TO, raw));
}

// Hourly: an incoming set with no _done marker and no new file for STALL_HOURS (default 12) gets one email to Mark.
// (Alistair's first uploads stalled more than once; a browser left running while someone is at work can pause for hours.)
// _stalled holds the last-file time already reported, so a set that resumes and stalls again is reported again.
async function stalledUploads(env) {
  const limit = (env.STALL_HOURS !== undefined ? Number(env.STALL_HOURS) : 12) * 36e5, now = Date.now(), sets = {};
  for (const o of await listAll(env.BUCKET, '')) {
    const [set, name] = o.key.split('/');
    if (set.startsWith('_') || !name) continue;
    const s = (sets[set] ??= { files: 0, bytes: 0, last: 0, done: false, noted: null });
    const t = o.uploaded.getTime();
    if (name === '_done') s.done = true;
    else if (name === '_stalled') s.noted = o;
    else if (name === '_meta.json') s.last = Math.max(s.last, t);
    else { s.files++; s.bytes += o.size; s.last = Math.max(s.last, t); }
  }
  for (const [set, s] of Object.entries(sets)) {
    if (s.done || !s.last || now - s.last < limit) continue;
    const lastIso = new Date(s.last).toISOString();
    if (s.noted && (await (await env.BUCKET.get(`${set}/_stalled`)).text()) === lastIso) continue;
    const m = (await meta(env, set)) || {};
    const hrs = Math.round((now - s.last) / 36e5);
    await tellMark(env, `Upload stalled: ${m.name || set}, ${m.target || ''}`.trim(), [
      `${m.name || '?'} <${m.email || '?'}> started sending ${m.target || 'frames'} (${m.scope || '?'}) on ${m.started || '?'}, but nothing new has arrived for ${hrs} hours.`, ``,
      `Arrived so far: ${s.files} of ${m.files ?? '?'} files, ${(s.bytes / 1e9).toFixed(2)} of ${m.bytes ? (m.bytes / 1e9).toFixed(2) : '?'} GB.`,
      `Last file: ${new Date(s.last).toUTCString()}`, `Set: ${set}`, ``,
      `To carry on, they just open the upload page again, use the same name and target, and pick the same files:`,
      `the ones already here are skipped. The desktop collects the set once it's finished.`]);
    await env.BUCKET.put(`${set}/_stalled`, lastIso);
  }
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url), p = url.pathname, q = url.searchParams;
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors(req) });

    if (p.startsWith('/admin/')) {
      if (req.headers.get('Authorization') !== `Bearer ${env.ADMIN_KEY}`) return json(req, { error: 'not allowed' }, 401);
      if (p === '/admin/sets') {
        const objs = await listAll(env.BUCKET, ''), sets = {};
        for (const o of objs) {
          const set = o.key.split('/')[0];
          if (set.startsWith('_')) continue;          // _config, _requests
          (sets[set] ??= { set, files: [], bytes: 0, done: false });
          if (o.key.endsWith('/_done')) sets[set].done = true;
          else if (!o.key.split('/')[1].startsWith('_')) { /* skips _meta.json, _stalled */ sets[set].files.push({ key: o.key, size: o.size, uploaded: o.uploaded }); sets[set].bytes += o.size; }
        }
        for (const s of Object.values(sets)) s.meta = await meta(env, s.set);
        return json(req, Object.values(sets));
      }
      if (p === '/admin/file') {
        const o = await env.BUCKET.get(q.get('key') || '');
        return o ? new Response(o.body, { headers: { 'Content-Length': o.size } }) : json(req, { error: 'missing' }, 404);
      }
      if (p === '/admin/set' && req.method === 'DELETE') {
        const set = q.get('set') || '';
        if (!/^[\w-]+$/.test(set)) return json(req, { error: 'bad set' }, 400);
        const keys = (await listAll(env.BUCKET, `${set}/`)).map((o) => o.key);
        for (let i = 0; i < keys.length; i += 1000) await env.BUCKET.delete(keys.slice(i, i + 1000));
        return json(req, { deleted: keys.length });
      }
      if (p === '/admin/outbox' && req.method === 'GET') {
        const ids = [...new Set((await listAll(env.BUCKET, '_outbox/')).map((o) => o.key.split('/')[1]))];
        const out = [];
        for (const id of ids) { const j = await job(env, id); if (j) out.push({ ...j, files: await jobFiles(env, id) }); }
        return json(req, out);
      }
      if (p === '/admin/outbox/job' && req.method === 'POST') {
        const b = await req.json().catch(() => null);
        if (!b || !b.client || !b.title) return json(req, { error: 'need client and title' }, 400);
        const slug = (b.client + '-' + b.title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
        const rnd = [...crypto.getRandomValues(new Uint8Array(10))].map((x) => x.toString(16).padStart(2, '0')).join('');
        const j = { job: `${slug}-${rnd}`, client: clean(b.client), email: clean(b.email, 120), title: clean(b.title, 120), set: clean(b.set, 120),
          created: new Date().toISOString(), first_download: null, nudged: false, cleared: null };
        if (Array.isArray(b.review)) j.review = b.review.slice(0, 8).map((r) => ({ file: safeName(r.file), label: clean(r.label, 80) }));
        if (b.before) j.before = safeName(b.before);
        await putJob(env, j);
        return json(req, { job: j.job, link: `${url.origin}/d/${j.job}` });
      }
      if (p === '/admin/outbox/job' && req.method === 'DELETE') {          // clear a job by hand (keeps its record)
        const j = await job(env, q.get('job') || '');
        if (!j) return json(req, { error: 'unknown job' }, 404);
        if (q.get('moved')) j.moved = q.get('moved').slice(0, 300);          // a replaced review page points to its new address
        await clearJob(env, j, 'cleared by hand');
        return json(req, { ok: true });
      }
      if (p.startsWith('/admin/outbox/')) {
        const id = q.get('job') || '', name = safeName(q.get('name'));
        const j = await job(env, id);
        if (!j || !name) return json(req, { error: 'unknown job or name' }, 400);
        const key = `_outbox/${id}/${name}`;
        if (p === '/admin/outbox/start' && req.method === 'POST') return json(req, { uploadId: (await env.BUCKET.createMultipartUpload(key)).uploadId });
        const mpu = env.BUCKET.resumeMultipartUpload(key, q.get('uploadId') || '');
        if (p === '/admin/outbox/part' && req.method === 'PUT') return json(req, await mpu.uploadPart(Number(q.get('n')), req.body));
        if (p === '/admin/outbox/done' && req.method === 'POST') { await mpu.complete((await req.json()).parts); return json(req, { ok: true }); }
        return json(req, { error: 'unknown' }, 404);
      }
      if (p === '/admin/codes' && req.method === 'GET') return json(req, await codes(env));
      if (p === '/admin/codes' && req.method === 'PUT') {
        const c = await req.json().catch(() => null);
        if (!c || typeof c !== 'object' || Array.isArray(c)) return json(req, { error: 'expected {"code": "who" or {"who", "email"}}' }, 400);
        const clean_ = Object.fromEntries(Object.entries(c).map(([k, v]) => [k.trim().toLowerCase(),
          v && typeof v === 'object' ? { who: clean(v.who), email: clean(v.email, 120).toLowerCase() } : clean(v)]));
        await env.BUCKET.put('_config/codes.json', JSON.stringify(clean_), { httpMetadata: { contentType: 'application/json' } });
        return json(req, clean_);
      }
      return json(req, { error: 'unknown' }, 404);
    }

    if (p.startsWith('/d/') && p.endsWith('/choose') && req.method === 'POST') {
      const id = p.split('/')[2], j = /^[\w-]+$/.test(id || '') ? await job(env, id) : null;
      if (!j || !j.review) return json(req, { error: 'unknown' }, 404);
      const b = await req.json().catch(() => null);
      // any number of versions can be chosen; each comes back as a full-size file
      const choice = [].concat(b?.choice || []).map((x) => clean(x, 80)).filter((x) => j.review.some((r) => r.label === x));
      const comment = String(b?.comment || '').slice(0, 1500);
      // slider settings: percentages 60-140 per chosen picture, and an optional blend of two versions
      const pct = (v) => Math.min(140, Math.max(60, Math.round(Number(v) || 100)));
      const tune = {};
      for (const [label, t] of Object.entries(b?.tune || {}).slice(0, 8))
        if (j.review.some((r) => r.label === label)) tune[label] = { b: pct(t?.b), c: pct(t?.c), k: pct(t?.k) };
      let blend = null;
      if (b?.blend && j.review.some((r) => r.label === b.blend.a) && j.review.some((r) => r.label === b.blend.b))
        blend = { a: clean(b.blend.a, 80), b: clean(b.blend.b, 80), second: Math.min(100, Math.max(0, Math.round(Number(b.blend.second) || 0))) };
      if (!choice.length && !blend) return json(req, { error: 'pick at least one' }, 400);
      j.feedback = { choice, comment, tune, blend, at: new Date().toISOString() };
      await putJob(env, j);
      const tl = Object.entries(tune).map(([l, t]) => `  ${l}: brightness ${t.b}%, colour ${t.k}%, contrast ${t.c}%`);
      const picked = [...choice, ...(blend ? [`a blend (${100 - blend.second}% ${blend.a} + ${blend.second}% ${blend.b})`] : [])];
      await tellMark(env, `${j.client} picked ${choice.length === j.review.length && !blend ? 'all of them' : picked.join(', ')} (${j.title})`, [`${j.client} chose: ${picked.join(', ')} for ${j.title}.`, ``,
        ...(tl.length ? ['Fine-tune settings:', ...tl, ''] : []), comment ? `Their note: ${comment}` : '(no note)', ``,
        `Their page: https://upload.gosforthskies.co.uk/d/${j.job}`]);
      return json(req, { ok: true });
    }
    if (p.startsWith('/d/') && req.method === 'GET') {
      const [, , id, file] = p.split('/');
      const j = /^[\w-]+$/.test(id || '') ? await job(env, id) : null;
      if (!j) return new Response('This link is not valid. Please check it against the email from Mark.', { status: 404 });
      if (!file) return new Response(downloadPage(j, j.cleared ? [] : await jobFiles(env, id)), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      const name = safeName(decodeURIComponent(file));
      const o = j.cleared ? null : await env.BUCKET.get(`_outbox/${id}/${name}`);
      if (!o) return new Response('That file has gone. Reply to Mark and he will send it again.', { status: 404 });
      if (q.get('view')) return new Response(o.body, { headers: { 'Content-Type': o.httpMetadata?.contentType || 'image/jpeg', 'Content-Length': o.size, 'Cache-Control': 'private, max-age=3600' } });
      if (!j.first_download) {
        j.first_download = new Date().toISOString();
        await putJob(env, j);
        await tellMark(env, `${j.client} downloaded ${j.title}`, [`${j.client} first downloaded ${name} at ${j.first_download}.`, ``,
          `The files and their raw frames will be cleared in 7 days (${new Date(Date.now() + KEEP_AFTER_DOWNLOAD).toDateString()}).`]);
      }
      return new Response(o.body, { headers: { 'Content-Type': o.httpMetadata?.contentType || 'application/octet-stream',
        'Content-Length': o.size, 'Content-Disposition': `attachment; filename="${name}"` } });
    }

    if (p === '/request' && req.method === 'POST') {
      const b = await req.json().catch(() => null);
      if (!b || b.website) return json(req, { ok: true });          // honeypot field filled: a bot, quietly ignored
      const r = { name: clean(b.name), email: clean(b.email, 120), object: clean(b.object, 120), size: clean(b.size, 20), note: clean(b.note, 600), at: new Date().toISOString() };
      if (!r.name || !r.email || !r.object) return json(req, { error: 'Please fill in your name, email and what you would like.' }, 400);
      await env.BUCKET.put(`_requests/${r.at.replace(/[:.]/g, '-')}.json`, JSON.stringify(r), { httpMetadata: { contentType: 'application/json' } });
      const raw = [`From: Gosforth Skies requests <${env.MAIL_FROM}>`, `To: ${env.MAIL_TO}`, `Reply-To: ${r.email}`,
        `Subject: Print request: ${r.object}`, `Message-ID: <${crypto.randomUUID()}@oneoffx.uk>`, `Date: ${new Date().toUTCString()}`,
        `MIME-Version: 1.0`, `Content-Type: text/plain; charset=utf-8`, ``,
        `${r.name} <${r.email}> would like: ${r.object}`, `Size: ${r.size || 'not given'}`, ``, r.note || '(no note)'].join('\r\n');
      try { await env.MAILER.send(new EmailMessage(env.MAIL_FROM, env.MAIL_TO, raw)); } catch (e) { console.log('email failed', e); }
      return json(req, { ok: true });
    }

    // a code is either "who it's for" or {who, email}: a personal code only opens uploads for that person's email
    // (Mark, 26 Oct: orion42 = Gordon, acomb55 = Alistair). Any mismatch just says "Incorrect code!" (no hints).
    const invite = (req.headers.get('X-Invite') || '').trim().toLowerCase(), entry = (await codes(env))[invite];
    const who = typeof entry === 'string' ? entry : entry?.who, lockEmail = typeof entry === 'object' ? (entry.email || '').toLowerCase() : '';
    if (!invite || !who) return json(req, { error: 'Incorrect code!' }, 403);

    if (p === '/start' && req.method === 'POST') {
      const b = await req.json().catch(() => null);
      if (!b || !Array.isArray(b.files) || !b.files.length) return json(req, { error: 'No frames chosen.' }, 400);
      const m = { name: clean(b.name), email: clean(b.email, 120), target: clean(b.target), scope: clean(b.scope), location: clean(b.location) };
      if (!m.name || !m.email || !m.target) return json(req, { error: 'Please fill in your name, email and target.' }, 400);
      if (lockEmail && m.email.toLowerCase() !== lockEmail) return json(req, { error: 'Incorrect code!' }, 403);
      const want = b.files.reduce((t, f) => t + (Number(f.size) || 0), 0);
      if (b.files.some((f) => Number(f.size) > MAX_BIG)) return json(req, { error: 'One of the files is over 2 GB. Email me and we will sort another way.' }, 400);
      const used = (await listAll(env.BUCKET, '')).reduce((t, o) => t + o.size, 0);
      if (used + want > QUOTA) return json(req, { error: 'The upload store is full just now. Email me and I will make room.' }, 507);
      // an interrupted upload from the same person for the same target carries on in its set, even on a later day
      // (Alistair's NGC 6888 stalled overnight on 19-20 Oct): reuse an unfinished set with the same name and target
      // from the last 7 days, otherwise start a new dated one
      const day = new Date().toISOString().slice(0, 10);
      const slug = (m.name + '-' + m.target).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50);
      m.set = `${day}-${slug}`;
      for (let back = 1; back <= 7; back++) {
        const earlier = `${new Date(Date.now() - back * DAY).toISOString().slice(0, 10)}-${slug}`;
        const em = await meta(env, earlier);
        if (em && !(await env.BUCKET.head(`${earlier}/_done`))) { m.set = earlier; m.started = em.started; break; }
      }
      m.files = b.files.length; m.bytes = want; m.started ??= new Date().toISOString(); m.invite = who;
      await env.BUCKET.put(`${m.set}/_meta.json`, JSON.stringify(m), { httpMetadata: { contentType: 'application/json' } });
      return json(req, { set: m.set });
    }

    const set = q.get('set') || '';
    if (!/^[\w-]+$/.test(set) || !(await meta(env, set))) return json(req, { error: 'Unknown upload. Please start again.' }, 400);

    if (p === '/have' && req.method === 'GET') {
      const names = (await listAll(env.BUCKET, `${set}/`)).map((o) => o.key.slice(set.length + 1)).filter((n) => !n.startsWith('_'));
      return json(req, { names });
    }
    if (p === '/put' && req.method === 'PUT') {
      const name = safeName(q.get('name'));
      const size = Number(req.headers.get('Content-Length') || 0);
      if (!OK_EXT.test(name)) return json(req, { error: `${name} is not a FITS or camera raw frame.` }, 400);
      if (!size || size > (/\.txt$/i.test(name) ? MAX_TXT : MAX_FILE)) return json(req, { error: `${name} is too big.` }, 400);
      await env.BUCKET.put(`${set}/${name}`, req.body);
      return json(req, { ok: true });
    }
    if (p.startsWith('/mpu/')) {
      const name = safeName(q.get('name'));
      if (!OK_EXT.test(name) || /\.txt$/i.test(name)) return json(req, { error: `${name} is not a FITS or camera raw frame.` }, 400);
      const key = `${set}/${name}`;
      if (p === '/mpu/start' && req.method === 'POST') return json(req, { uploadId: (await env.BUCKET.createMultipartUpload(key)).uploadId });
      const mpu = env.BUCKET.resumeMultipartUpload(key, q.get('uploadId') || '');
      if (p === '/mpu/part' && req.method === 'PUT') {
        const size = Number(req.headers.get('Content-Length') || 0), n = Number(q.get('n'));
        if (!size || size > MAX_FILE || !(n >= 1 && n <= 100)) return json(req, { error: 'bad part' }, 400);
        return json(req, await mpu.uploadPart(n, req.body));
      }
      if (p === '/mpu/done' && req.method === 'POST') {
        const b = await req.json().catch(() => null);
        if (!b || !Array.isArray(b.parts) || !b.parts.length) return json(req, { error: 'no parts' }, 400);
        await mpu.complete(b.parts);
        return json(req, { ok: true });
      }
      return json(req, { error: 'unknown' }, 404);
    }
    if (p === '/finish' && req.method === 'POST') {
      const m = await meta(env, set);
      const objs = (await listAll(env.BUCKET, `${set}/`)).filter((o) => !o.key.split('/')[1].startsWith('_'));
      await env.BUCKET.put(`${set}/_done`, new Date().toISOString());
      try { await notify(env, m, objs.length, objs.reduce((t, o) => t + o.size, 0)); } catch (e) { console.log('email failed', e); }
      return json(req, { ok: true, files: objs.length });
    }
    return json(req, { error: 'unknown' }, 404);
  },

  // see [triggers] in wrangler.toml: hourly = stalled-upload check, daily 06:00 = the outbox clean-up rules described at the top
  async scheduled(event, env) {
    if (event.cron !== '0 6 * * *') return stalledUploads(env);
    const now = Date.now();
    const ids = [...new Set((await listAll(env.BUCKET, '_outbox/')).map((o) => o.key.split('/')[1]))];
    for (const id of ids) {
      const j = await job(env, id);
      if (!j || j.cleared) continue;
      const age = now - Date.parse(j.created);
      if (j.first_download && now - Date.parse(j.first_download) > KEEP_AFTER_DOWNLOAD) {
        await clearJob(env, j, '7 days after first download');
        await tellMark(env, `Cleared: ${j.title} for ${j.client}`, [`Downloaded ${j.first_download}; the outbox files are now cleared.`,
          `The desktop clean-up removes the raw frames for ${j.set || 'this job'} on its next run.`]);
      } else if (!j.first_download && age > CLEAR_AFTER) {
        await clearJob(env, j, '30 days, never downloaded');
        await tellMark(env, `Cleared unopened: ${j.title} for ${j.client}`, [`Nobody downloaded this in 30 days, so the outbox files are cleared.`,
          `Raw frames for ${j.set || 'this job'} go on the next desktop clean-up; the finished files stay in Clients\\.`]);
      } else if (!j.first_download && age > NUDGE_AFTER && !j.nudged) {
        j.nudged = true; await putJob(env, j);
        await tellMark(env, `Not downloaded yet: ${j.title} for ${j.client}`, [`${j.client} <${j.email}> hasn't opened their link after 7 days.`,
          `Link: https://upload.gosforthskies.co.uk/d/${j.job}`, ``, `It clears itself at 30 days (${new Date(Date.parse(j.created) + CLEAR_AFTER).toDateString()}). A nudge from you might help.`]);
      }
    }
  },
};
