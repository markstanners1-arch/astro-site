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

const QUOTA = 20e9;                          // R2 bills average storage (10 GB-months free); sets are collected every 30 min, so spikes cost ~nothing. Worst case full all month: about 12p
const MAX_FILE = 95e6;                       // a Worker request body can be up to 100 MB on the free plan: bigger files use /mpu
const MAX_BIG = 2e9;                         // largest single frame accepted in parts (61 MP cameras are about 120 MB)
const OK_EXT = /\.(fit|fits|fts|xisf)$/i;
const SITE = 'https://astro.oneoffx.uk';

const cors = () => ({
  'Access-Control-Allow-Origin': SITE,
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
function downloadPage(j, files) {
  const mb = (n) => (n / 1e6).toFixed(n > 1e8 ? 0 : 1) + ' MB';
  const rows = files.map((f) => `<li><a href="/d/${j.job}/${encodeURIComponent(f.name)}">${esc(f.name)}</a><span>${mb(f.size)}</span></li>`).join('');
  const body = j.cleared
    ? `<p>These files have been cleared. If you still need them, reply to Mark's email and he'll send them again.</p>`
    : `<ul>${rows}</ul><p class="n">The TIFF is the full-size file for printing; the JPEG is for sharing. The link stays open for 7 days after your first download.</p>`;
  return `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(j.title)} · Gosforth Skies</title><style>
body{margin:0;background:#0b1019;color:#e6e9ef;font:16px/1.6 system-ui,sans-serif}main{max-width:640px;margin:0 auto;padding:40px 16px}
h1{font:400 1.9rem/1.2 Georgia,serif;margin:0 0 6px}.e{font:500 .75rem ui-monospace,monospace;letter-spacing:.12em;text-transform:uppercase;color:#e0664d}
ul{list-style:none;padding:0;margin:24px 0;display:grid;gap:10px}li{display:flex;justify-content:space-between;gap:12px;background:#121a27;border:1px solid #243046;border-radius:8px;padding:14px 16px}
a{color:#e6e9ef;font-weight:600;text-decoration-color:#e0664d;overflow-wrap:anywhere}span,.n{color:#95a0b4;font-size:.9rem}</style></head>
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
          else if (!o.key.endsWith('/_meta.json')) { sets[set].files.push({ key: o.key, size: o.size, uploaded: o.uploaded }); sets[set].bytes += o.size; }
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
        await putJob(env, j);
        return json(req, { job: j.job, link: `${url.origin}/d/${j.job}` });
      }
      if (p === '/admin/outbox/job' && req.method === 'DELETE') {          // clear a job by hand (keeps its record)
        const j = await job(env, q.get('job') || '');
        if (!j) return json(req, { error: 'unknown job' }, 404);
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
        if (!c || typeof c !== 'object' || Array.isArray(c)) return json(req, { error: 'expected {"code": "who"}' }, 400);
        const clean_ = Object.fromEntries(Object.entries(c).map(([k, v]) => [k.trim().toLowerCase(), clean(v)]));
        await env.BUCKET.put('_config/codes.json', JSON.stringify(clean_), { httpMetadata: { contentType: 'application/json' } });
        return json(req, clean_);
      }
      return json(req, { error: 'unknown' }, 404);
    }

    if (p.startsWith('/d/') && req.method === 'GET') {
      const [, , id, file] = p.split('/');
      const j = /^[\w-]+$/.test(id || '') ? await job(env, id) : null;
      if (!j) return new Response('This link is not valid. Please check it against the email from Mark.', { status: 404 });
      if (!file) return new Response(downloadPage(j, j.cleared ? [] : await jobFiles(env, id)), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      const name = safeName(decodeURIComponent(file));
      const o = j.cleared ? null : await env.BUCKET.get(`_outbox/${id}/${name}`);
      if (!o) return new Response('That file has gone. Reply to Mark and he will send it again.', { status: 404 });
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

    const invite = (req.headers.get('X-Invite') || '').trim().toLowerCase(), who = (await codes(env))[invite];
    if (!invite || !who) return json(req, { error: 'That invite code is not right.' }, 403);

    if (p === '/start' && req.method === 'POST') {
      const b = await req.json().catch(() => null);
      if (!b || !Array.isArray(b.files) || !b.files.length) return json(req, { error: 'No frames chosen.' }, 400);
      const m = { name: clean(b.name), email: clean(b.email, 120), target: clean(b.target), scope: clean(b.scope), location: clean(b.location) };
      if (!m.name || !m.email || !m.target) return json(req, { error: 'Please fill in your name, email and target.' }, 400);
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
      if (!OK_EXT.test(name)) return json(req, { error: `${name} is not a FITS frame.` }, 400);
      if (!size || size > MAX_FILE) return json(req, { error: `${name} is too big.` }, 400);
      await env.BUCKET.put(`${set}/${name}`, req.body);
      return json(req, { ok: true });
    }
    if (p.startsWith('/mpu/')) {
      const name = safeName(q.get('name'));
      if (!OK_EXT.test(name)) return json(req, { error: `${name} is not a FITS frame.` }, 400);
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

  // daily (see [triggers] in wrangler.toml): the outbox clean-up rules described at the top
  async scheduled(event, env) {
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
          `Link: https://upload.oneoffx.uk/d/${j.job}`, ``, `It clears itself at 30 days (${new Date(Date.parse(j.created) + CLEAR_AFTER).toDateString()}). A nudge from you might help.`]);
      }
    }
  },
};
