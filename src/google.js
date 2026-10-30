// AdSense Management API v2: OAuth connect + daily earnings pull, attributed to apps by URL channel.
import { getSettings, setSetting } from './db.js';

const SCOPE = 'https://www.googleapis.com/auth/adsense.readonly';
const API = 'https://adsense.googleapis.com/v2';

export function redirectUri(origin) {
  return `${origin}/ads/api/google/callback`;
}

export function authUrl(settings, origin, state) {
  const q = new URLSearchParams({
    client_id: settings.google_client_id, redirect_uri: redirectUri(origin), response_type: 'code',
    scope: SCOPE, access_type: 'offline', prompt: 'consent', state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
}

export async function exchangeCode(db, settings, origin, code) {
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code, client_id: settings.google_client_id, client_secret: settings.google_client_secret,
      redirect_uri: redirectUri(origin), grant_type: 'authorization_code',
    }),
  });
  const j = await r.json();
  if (!j.refresh_token) throw new Error(j.error_description || j.error || 'no refresh token');
  await setSetting(db, 'google_refresh_token', j.refresh_token);
}

async function accessToken(settings) {
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: settings.google_client_id, client_secret: settings.google_client_secret,
      refresh_token: settings.google_refresh_token, grant_type: 'refresh_token',
    }),
  });
  const j = await r.json();
  if (!j.access_token) throw new Error(j.error_description || j.error || 'token refresh failed');
  return j.access_token;
}

/** Map a URL channel like "mutaafaziz.com/outatime" to an app id; anything else is the site. */
export function appForChannel(name, apps) {
  const n = String(name || '').toLowerCase();
  if (n.includes('18-0.co')) return '18-0';
  for (const a of apps) {
    const path = new URL(a.url).pathname.replace(/\/$/, '');
    if (path && path !== '/' && n.includes(path.split('/')[1])) return a.id;
  }
  return 'site';
}

export async function pullEarnings(db) {
  const s = await getSettings(db);
  if (!s.google_refresh_token) return { skipped: 'not connected' };
  const token = await accessToken(s);
  const h = { authorization: `Bearer ${token}` };
  const acc = await (await fetch(`${API}/accounts`, { headers: h })).json();
  const account = acc.accounts?.[0]?.name;
  if (!account) throw new Error('no AdSense account visible to this login');
  const q = new URLSearchParams({ dateRange: 'LAST_30_DAYS', currencyCode: 'USD' });
  for (const d of ['DATE', 'URL_CHANNEL_NAME']) q.append('dimensions', d);
  for (const m of ['ESTIMATED_EARNINGS', 'IMPRESSIONS', 'CLICKS', 'PAGE_VIEWS']) q.append('metrics', m);
  const rep = await (await fetch(`${API}/${account}/reports:generate?${q}`, { headers: h })).json();
  if (rep.error) throw new Error(rep.error.message);
  const { results: apps } = await db.prepare('SELECT id, url FROM apps').all();
  const agg = new Map();
  for (const row of rep.rows || []) {
    const [day, channel, earn, imp, clk, pv] = row.cells.map((c) => c.value);
    const k = `${day}|${appForChannel(channel, apps)}`;
    const a = agg.get(k) || [0, 0, 0, 0];
    agg.set(k, [a[0] + Math.round(Number(earn || 0) * 1e6), a[1] + (+imp || 0), a[2] + (+clk || 0), a[3] + (+pv || 0)]);
  }
  const stmts = [...agg].map(([k, v]) => {
    const [day, app] = k.split('|');
    return db.prepare(`INSERT INTO earnings (day, app_id, earnings_micros, impressions, clicks, page_views) VALUES (?,?,?,?,?,?)
      ON CONFLICT(day, app_id) DO UPDATE SET earnings_micros=excluded.earnings_micros, impressions=excluded.impressions,
      clicks=excluded.clicks, page_views=excluded.page_views`).bind(day, app, ...v);
  });
  if (stmts.length) await db.batch(stmts);
  await setSetting(db, 'google_last_sync', new Date().toISOString());
  await setSetting(db, 'google_account', account);
  return { rows: stmts.length };
}
