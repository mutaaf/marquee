// Marquee: the ad server for the mutaafaziz.com collection.
//   public   GET  /ads/api/config?app=&slots=   slot decisions + eligible direct campaigns
//            POST /ads/api/beacon               aggregate counts {app, counts:{"slot|campaign|source":{i,c,v}}}
//            GET  /ads/cr/<key>                 creative bytes (KV), Range-aware for video
//            GET  /ads/c/<campaign>?a=&s=       click counter → advertiser URL
//            GET  /ads.txt                      generated from the AdSense publisher id
//   operator /ads/api/admin/*                   cookie session (ADMIN_PASSWORD)
//   static   /ads/v1/ads.js (loader), /ads/admin/ (console), /ads/privacy/
import { buildConfig, parseDeclared, adsTxt, KINDS, CONTEXTS, SOURCES } from './lib/select.js';
import { ensureSchema, getSettings, setSetting } from './db.js';
import { isOperator, role, sessionCookie, clearCookie, timingSafeEqual } from './auth.js';
import { report } from './report.js';
import { authUrl, exchangeCode, pullEarnings } from './google.js';

const json = (data, init = {}) => new Response(JSON.stringify(data), {
  ...init, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...(init.headers || {}) },
});
const today = () => new Date().toISOString().slice(0, 10);
const SECRET_KEYS = ['google_client_secret', 'google_refresh_token'];
const SETTING_KEYS = ['adsense_client', 'adsense_display_unit', 'adsense_test', 'h5_enabled', 'ads_txt_extra',
  'google_client_id', 'google_client_secret', 'contact_email'];
const cleanId = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const p = url.pathname;
    try {
      if (p === '/ads.txt') {
        await ensureSchema(env.DB);
        return new Response(adsTxt(await getSettings(env.DB)), { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=300' } });
      }
      if (p.startsWith('/ads/cr/')) return creative(env, p.slice(8), req);
      await ensureSchema(env.DB);
      if (p === '/ads/api/config') return config(env, url, ctx);
      if (p === '/ads/api/beacon' && req.method === 'POST') return beacon(env, req);
      if (p.startsWith('/ads/c/')) return click(env, p.slice(7), url);
      if (p === '/ads/api/google/callback') return googleCallback(env, req, url);
      if (p.startsWith('/ads/api/admin/')) return admin(env, req, url, p.slice('/ads/api/admin/'.length));
      if (p === '/ads' || p === '/ads/') return Response.redirect(`${url.origin}/ads/admin/`, 302);
      return env.ASSETS.fetch(req);
    } catch (e) {
      console.error(e);
      return json({ error: 'server error' }, { status: 500 });
    }
  },

  async scheduled(_evt, env) {
    await ensureSchema(env.DB);
    try { await pullEarnings(env.DB); } catch (e) { await setSetting(env.DB, 'google_last_error', String(e.message || e)); }
  },
};

// ---------- public ----------

async function config(env, url, ctx) {
  const appId = cleanId(url.searchParams.get('app'));
  const declared = parseDeclared(url.searchParams.get('slots'));
  const db = env.DB;
  const app = await db.prepare('SELECT * FROM apps WHERE id = ?').bind(appId).first();
  if (!app) return json({ v: 1, enabled: false, slots: {}, campaigns: [] }, { headers: cors() });
  // Apps declare their slots; new ones register themselves (source auto) so the console lists them.
  if (declared.length) {
    ctx.waitUntil(db.batch(declared.map((s) => db.prepare(
      `INSERT INTO slots (app_id, id, kind, context, seen_at) VALUES (?,?,?,?,?)
       ON CONFLICT(app_id, id) DO UPDATE SET seen_at = excluded.seen_at`).bind(appId, s.id, s.kind, s.context, today()))));
  }
  const { results: stored } = await db.prepare('SELECT * FROM slots WHERE app_id = ?').bind(appId).all();
  const byId = new Map(stored.map((s) => [s.id, s]));
  for (const d of declared) if (!byId.has(d.id)) byId.set(d.id, { ...d, source: 'auto' });
  const { results: campaigns } = await db.prepare("SELECT * FROM campaigns WHERE status = 'active'").all();
  const settings = await getSettings(db);
  const body = buildConfig({ app, slots: [...byId.values()], settings, campaigns, day: today() });
  return json(body, { headers: { ...cors(), 'cache-control': 'public, max-age=60' } });
}

function cors() {
  return { 'access-control-allow-origin': '*' };
}

async function beacon(env, req) {
  const text = await req.text();
  if (text.length > 16_000) return new Response(null, { status: 413 });
  let b;
  try { b = JSON.parse(text); } catch { return new Response(null, { status: 400 }); }
  const app = cleanId(b.app);
  const known = await env.DB.prepare('SELECT 1 FROM apps WHERE id = ?').bind(app).first();
  if (!known) return new Response(null, { status: 204, headers: cors() });
  const day = today();
  const stmts = [];
  for (const [k, v] of Object.entries(b.counts || {}).slice(0, 60)) {
    const [slot, campaign, source] = k.split('|').map(cleanId);
    if (!slot || !['network', 'direct'].includes(source)) continue;
    const n = (x) => Math.max(0, Math.min(200, Number(x) | 0));
    stmts.push(env.DB.prepare(`INSERT INTO stats (day, app_id, slot_id, campaign_id, source, impressions, clicks, completions)
      VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(day, app_id, slot_id, campaign_id, source) DO UPDATE SET
      impressions = impressions + excluded.impressions, clicks = clicks + excluded.clicks, completions = completions + excluded.completions`)
      .bind(day, app, slot, campaign || '-', source, n(v.i), n(v.c), n(v.v)));
  }
  if (stmts.length) await env.DB.batch(stmts);
  return new Response(null, { status: 204, headers: cors() });
}

async function click(env, id, url) {
  const c = await env.DB.prepare('SELECT id, click_url FROM campaigns WHERE id = ?').bind(cleanId(id)).first();
  if (!c || !/^https:\/\//.test(c.click_url || '')) return new Response('Not found', { status: 404 });
  await env.DB.prepare(`INSERT INTO stats (day, app_id, slot_id, campaign_id, source, clicks) VALUES (?,?,?,?, 'direct', 1)
    ON CONFLICT(day, app_id, slot_id, campaign_id, source) DO UPDATE SET clicks = clicks + 1`)
    .bind(today(), cleanId(url.searchParams.get('a')) || '-', cleanId(url.searchParams.get('s')) || '-', c.id).run();
  return new Response(null, { status: 302, headers: { location: c.click_url, 'referrer-policy': 'no-referrer' } });
}

async function creative(env, key, req) {
  if (!/^[a-z0-9-]+\/[a-z0-9]+$/.test(key)) return new Response('Not found', { status: 404 });
  const { value, metadata } = await env.CREATIVES.getWithMetadata(key, { type: 'arrayBuffer', cacheTtl: 3600 });
  if (!value) return new Response('Not found', { status: 404 });
  const h = {
    'content-type': metadata?.mime || 'application/octet-stream', 'cache-control': 'public, max-age=31536000, immutable',
    'accept-ranges': 'bytes', 'x-content-type-options': 'nosniff', 'access-control-allow-origin': '*',
  };
  const m = /bytes=(\d*)-(\d*)/.exec(req.headers.get('range') || '');
  if (m) {
    const size = value.byteLength;
    const start = m[1] ? +m[1] : Math.max(0, size - +m[2]);
    const end = m[1] && m[2] ? Math.min(+m[2], size - 1) : size - 1;
    if (start >= size || start > end) return new Response(null, { status: 416, headers: { 'content-range': `bytes */${size}` } });
    return new Response(value.slice(start, end + 1), { status: 206, headers: { ...h, 'content-range': `bytes ${start}-${end}/${size}` } });
  }
  return new Response(value, { headers: h });
}

async function googleCallback(env, req, url) {
  if (!(await isOperator(req, env))) return new Response('Sign in to /ads/admin first.', { status: 401 });
  const s = await getSettings(env.DB);
  if (url.searchParams.get('state') !== s.google_oauth_state) return new Response('State mismatch, try Connect again.', { status: 400 });
  try {
    await exchangeCode(env.DB, s, url.origin, url.searchParams.get('code'));
    await pullEarnings(env.DB).catch((e) => setSetting(env.DB, 'google_last_error', String(e.message || e)));
    return Response.redirect(`${url.origin}/ads/admin/#money`, 302);
  } catch (e) {
    return new Response(`Google connect failed: ${e.message}`, { status: 400 });
  }
}

// ---------- operator ----------

async function admin(env, req, url, route) {
  const db = env.DB;
  if (route === 'login' && req.method === 'POST') {
    const { password } = await req.json().catch(() => ({}));
    if (!env.ADMIN_PASSWORD || !timingSafeEqual(password || '', env.ADMIN_PASSWORD)) {
      await new Promise((r) => setTimeout(r, 600));
      return json({ error: 'wrong password' }, { status: 401 });
    }
    return json({ ok: true }, { headers: { 'set-cookie': await sessionCookie(env.ADMIN_PASSWORD) } });
  }
  if (route === 'logout') return json({ ok: true }, { headers: { 'set-cookie': clearCookie } });
  const who = await role(req, env);
  if (!who) return json({ error: 'sign in' }, { status: 401 });
  // State-changing calls must be same-origin (cookie is SameSite=Strict too; belt and braces).
  if (req.method !== 'GET' && req.headers.get('origin') && req.headers.get('origin') !== url.origin) return json({ error: 'origin' }, { status: 403 });

  const [head, a, b] = route.split('/');
  const body = req.method === 'PUT' || req.method === 'POST' ? await req.clone().json().catch(() => ({})) : {};

  // Agents (Hermes etc.) run campaigns and slots; account keys and kid-safety settings stay human-only.
  if (who === 'agent') {
    if (head === 'settings' || head === 'google') return json({ error: 'operator only' }, { status: 403 });
    if (head === 'apps' && 'audience' in body) return json({ error: 'audience is operator only' }, { status: 403 });
    if (head === 'campaigns' && body.kid_safe) return json({ error: 'kid_safe sign-off is operator only' }, { status: 403 });
  }

  if (head === 'report' && req.method === 'GET') {
    return json(await report(db, Math.min(90, Math.max(1, +url.searchParams.get('days') || 30))));
  }

  if (head === 'state' && req.method === 'GET') {
    const s = await getSettings(db);
    const settings = {};
    for (const k of SETTING_KEYS) settings[k] = SECRET_KEYS.includes(k) ? (s[k] ? '••••••' : '') : s[k] ?? '';
    settings.google_connected = !!s.google_refresh_token;
    for (const k of ['google_last_sync', 'google_last_error', 'google_account']) settings[k] = s[k] || '';
    const since = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
    const [apps, slots, campaigns, stats, earnings] = await Promise.all([
      db.prepare('SELECT * FROM apps ORDER BY sort').all(),
      db.prepare('SELECT * FROM slots ORDER BY app_id, id').all(),
      db.prepare('SELECT * FROM campaigns ORDER BY created_at DESC').all(),
      db.prepare(`SELECT day, app_id, slot_id, campaign_id, source, impressions, clicks, completions FROM stats WHERE day >= ?`).bind(since).all(),
      db.prepare('SELECT * FROM earnings WHERE day >= ? ORDER BY day').bind(since).all(),
    ]);
    return json({ settings, apps: apps.results, slots: slots.results, campaigns: campaigns.results, stats: stats.results, earnings: earnings.results, origin: url.origin, today: today() });
  }

  if (head === 'settings' && req.method === 'PUT') {
    for (const [k, v] of Object.entries(body)) {
      if (!SETTING_KEYS.includes(k) || v === '••••••') continue;
      let val = typeof v === 'boolean' ? (v ? '1' : '') : String(v ?? '').trim();
      if (k === 'adsense_client' && val) {
        const m = val.match(/pub-\d{10,20}/);
        if (!m) return json({ error: 'Publisher id looks like pub-1234567890123456' }, { status: 400 });
        val = `ca-${m[0]}`;
      }
      await setSetting(db, k, val);
    }
    return json({ ok: true });
  }

  if (head === 'apps' && a && req.method === 'PUT') {
    const fields = { enabled: 'int', network_enabled: 'int', audience: ['general', 'kids'], is_game: 'int' };
    for (const [k, rule] of Object.entries(fields)) {
      if (!(k in body)) continue;
      const v = rule === 'int' ? (body[k] ? 1 : 0) : rule.includes(body[k]) ? body[k] : null;
      if (v !== null) await db.prepare(`UPDATE apps SET ${k} = ? WHERE id = ?`).bind(v, a).run();
    }
    return json({ ok: true });
  }

  if (head === 'slots' && a && b) {
    if (req.method === 'DELETE') { await db.prepare('DELETE FROM slots WHERE app_id = ? AND id = ?').bind(a, b).run(); return json({ ok: true }); }
    if (req.method === 'PUT') {
      const id = cleanId(b);
      const kind = KINDS.includes(body.kind) ? body.kind : 'banner';
      const context = CONTEXTS.includes(body.context) ? body.context : 'menu';
      const source = SOURCES.includes(body.source) ? body.source : 'auto';
      const freq = body.frequency_sec === '' || body.frequency_sec == null ? null : Math.max(0, +body.frequency_sec | 0);
      await db.prepare(`INSERT INTO slots (app_id, id, kind, context, source, ad_unit, frequency_sec) VALUES (?,?,?,?,?,?,?)
        ON CONFLICT(app_id, id) DO UPDATE SET kind=excluded.kind, context=excluded.context, source=excluded.source,
        ad_unit=excluded.ad_unit, frequency_sec=excluded.frequency_sec`)
        .bind(a, id, kind, context, source, String(body.ad_unit || '').replace(/\D/g, '') || null, freq).run();
      return json({ ok: true });
    }
  }

  if (head === 'campaigns') {
    if (req.method === 'POST' && !a) {
      const id = `${cleanId(body.name || 'campaign').slice(0, 30)}-${Date.now().toString(36).slice(-5)}`;
      await db.prepare('INSERT INTO campaigns (id, name, status, created_at) VALUES (?,?,?,?)').bind(id, body.name || id, 'paused', new Date().toISOString()).run();
      await updateCampaign(db, id, body);
      return json({ ok: true, id });
    }
    if (a && req.method === 'PUT') { await updateCampaign(db, a, body); return json({ ok: true }); }
    if (a && req.method === 'DELETE') {
      const c = await db.prepare('SELECT creative_key FROM campaigns WHERE id = ?').bind(a).first();
      if (c?.creative_key) await env.CREATIVES.delete(c.creative_key);
      await db.prepare('DELETE FROM campaigns WHERE id = ?').bind(a).run();
      return json({ ok: true });
    }
  }

  // Raw upload: PUT /ads/api/admin/creative/<campaign>?w=&h= with the file as the body.
  if (head === 'creative' && a && req.method === 'PUT') {
    const mime = (req.headers.get('content-type') || '').split(';')[0];
    const media = /^image\/(png|jpeg|webp|gif)$/.test(mime) ? 'image' : /^video\/(mp4|webm)$/.test(mime) ? 'video' : null;
    if (!media) return json({ error: 'Use PNG, JPEG, WebP, GIF, MP4 or WebM (no SVG/HTML: they can carry scripts).' }, { status: 415 });
    const buf = await req.arrayBuffer();
    if (buf.byteLength > 24 * 1024 * 1024) return json({ error: 'Max 24 MB per creative.' }, { status: 413 });
    const old = await db.prepare('SELECT creative_key FROM campaigns WHERE id = ?').bind(a).first();
    if (!old) return json({ error: 'no such campaign' }, { status: 404 });
    const key = `${a}/${Date.now().toString(36)}`;
    await env.CREATIVES.put(key, buf, { metadata: { mime } });
    if (old.creative_key) await env.CREATIVES.delete(old.creative_key);
    await db.prepare('UPDATE campaigns SET creative_key = ?, mime = ?, media = ?, width = ?, height = ? WHERE id = ?')
      .bind(key, mime, media, +url.searchParams.get('w') | 0, +url.searchParams.get('h') | 0, a).run();
    return json({ ok: true, key, media });
  }

  if (head === 'google') {
    const s = await getSettings(db);
    if (a === 'connect') {
      if (!s.google_client_id || !s.google_client_secret) return json({ error: 'Paste the OAuth client id and secret first.' }, { status: 400 });
      const state = crypto.randomUUID();
      await setSetting(db, 'google_oauth_state', state);
      return json({ url: authUrl(s, url.origin, state), redirect: `${url.origin}/ads/api/google/callback` });
    }
    if (a === 'sync' && req.method === 'POST') {
      try { return json(await pullEarnings(db)); } catch (e) {
        await setSetting(db, 'google_last_error', String(e.message || e));
        return json({ error: String(e.message || e) }, { status: 502 });
      }
    }
    if (a === 'disconnect' && req.method === 'POST') { await setSetting(db, 'google_refresh_token', ''); return json({ ok: true }); }
  }

  return json({ error: 'not found' }, { status: 404 });
}

async function updateCampaign(db, id, b) {
  const set = [], vals = [];
  const put = (k, v) => { set.push(`${k} = ?`); vals.push(v); };
  if ('name' in b) put('name', String(b.name).slice(0, 80));
  if ('advertiser' in b) put('advertiser', String(b.advertiser || '').slice(0, 60));
  if ('click_url' in b) put('click_url', /^https:\/\/\S+$/.test(b.click_url || '') ? b.click_url : '');
  if ('kid_safe' in b) put('kid_safe', b.kid_safe ? 1 : 0);
  if ('weight' in b) put('weight', Math.max(1, Math.min(100, +b.weight | 0)));
  if ('cpm_cents' in b) put('cpm_cents', Math.max(0, Math.round(+b.cpm_cents || 0)));
  for (const k of ['start', 'end']) if (k in b) put(k, /^\d{4}-\d{2}-\d{2}$/.test(b[k] || '') ? b[k] : null);
  if ('apps' in b) put('apps', JSON.stringify((b.apps || []).map(cleanId)));
  if ('slot_kinds' in b) put('slot_kinds', JSON.stringify((b.slot_kinds || []).filter((k) => KINDS.includes(k))));
  if ('status' in b) put('status', b.status === 'active' ? 'active' : 'paused');
  if (set.length) await db.prepare(`UPDATE campaigns SET ${set.join(', ')} WHERE id = ?`).bind(...vals, id).run();
}
