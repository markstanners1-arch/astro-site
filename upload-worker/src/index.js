// Gosforth Skies upload service: a Cloudflare Worker in front of the R2 bucket "gosforth-uploads".
// The site's "Send your frames" box talks to it; tools/fetch_uploads.py on the desktop collects the sets.
//
//   POST /start              {name, email, target, scope, location, files:[{name,size}]}  -> {set}
//   PUT  /put?set=&name=     body = one file (under MAX_FILE)                               -> {ok}
//   GET  /have?set=          names already stored, so an interrupted upload skips them      -> {names}
//   POST /finish?set=        marks the set complete and emails a note                       -> {ok}
// Writes need header X-Invite = INVITE_CODE (a Worker secret). Admin calls need Authorization: Bearer ADMIN_KEY:
//   GET /admin/sets   GET /admin/file?key=   DELETE /admin/set?set=
// Total storage is held under QUOTA so the bucket stays inside R2's free 10 GB.
import { EmailMessage } from 'cloudflare:email';

const QUOTA = 9e9;
const MAX_FILE = 95e6;                       // a Worker request body can be up to 100 MB on the free plan
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
async function meta(env, set) {
  const m = await env.BUCKET.get(`${set}/_meta.json`);
  return m ? m.json() : null;
}

async function notify(env, m, count, bytes) {
  const body = [`New frames uploaded to Gosforth Skies.`, ``,
    `From: ${m.name} <${m.email}>`, `Target: ${m.target}`, `Scope: ${m.scope}`, `Where: ${m.location}`,
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
          (sets[set] ??= { set, files: [], bytes: 0, done: false });
          if (o.key.endsWith('/_done')) sets[set].done = true;
          else if (!o.key.endsWith('/_meta.json')) { sets[set].files.push({ key: o.key, size: o.size }); sets[set].bytes += o.size; }
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
      return json(req, { error: 'unknown' }, 404);
    }

    if (req.headers.get('X-Invite') !== env.INVITE_CODE) return json(req, { error: 'That invite code is not right.' }, 403);

    if (p === '/start' && req.method === 'POST') {
      const b = await req.json().catch(() => null);
      if (!b || !Array.isArray(b.files) || !b.files.length) return json(req, { error: 'No frames chosen.' }, 400);
      const m = { name: clean(b.name), email: clean(b.email, 120), target: clean(b.target), scope: clean(b.scope), location: clean(b.location) };
      if (!m.name || !m.email || !m.target) return json(req, { error: 'Please fill in your name, email and target.' }, 400);
      const want = b.files.reduce((t, f) => t + (Number(f.size) || 0), 0);
      if (b.files.some((f) => Number(f.size) > MAX_FILE)) return json(req, { error: 'One of the files is over 95 MB. Email me and we will sort another way.' }, 400);
      const used = (await listAll(env.BUCKET, '')).reduce((t, o) => t + o.size, 0);
      if (used + want > QUOTA) return json(req, { error: 'The upload store is full just now. Email me and I will make room.' }, 507);
      // an interrupted upload from the same person for the same target carries on in its set
      const day = new Date().toISOString().slice(0, 10);
      const slug = (m.name + '-' + m.target).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50);
      m.set = `${day}-${slug}`;
      m.files = b.files.length; m.bytes = want; m.started = new Date().toISOString();
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
    if (p === '/finish' && req.method === 'POST') {
      const m = await meta(env, set);
      const objs = (await listAll(env.BUCKET, `${set}/`)).filter((o) => !o.key.split('/')[1].startsWith('_'));
      await env.BUCKET.put(`${set}/_done`, new Date().toISOString());
      try { await notify(env, m, objs.length, objs.reduce((t, o) => t + o.size, 0)); } catch (e) { console.log('email failed', e); }
      return json(req, { ok: true, files: objs.length });
    }
    return json(req, { error: 'unknown' }, 404);
  },
};
