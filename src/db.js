// D1 schema + seed. The Worker creates its own tables on first request (idempotent).

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`,
  `CREATE TABLE IF NOT EXISTS apps (
    id TEXT PRIMARY KEY, name TEXT, url TEXT, audience TEXT DEFAULT 'general',
    is_game INTEGER DEFAULT 0, enabled INTEGER DEFAULT 1, network_enabled INTEGER DEFAULT 1, sort INTEGER DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS slots (
    app_id TEXT, id TEXT, kind TEXT, context TEXT, source TEXT DEFAULT 'auto',
    ad_unit TEXT, frequency_sec INTEGER, seen_at TEXT, PRIMARY KEY (app_id, id))`,
  `CREATE TABLE IF NOT EXISTS campaigns (
    id TEXT PRIMARY KEY, name TEXT, advertiser TEXT, media TEXT, creative_key TEXT, mime TEXT,
    width INTEGER, height INTEGER, click_url TEXT, kid_safe INTEGER DEFAULT 0, weight INTEGER DEFAULT 1,
    start TEXT, end TEXT, apps TEXT DEFAULT '[]', slot_kinds TEXT DEFAULT '[]', status TEXT DEFAULT 'active',
    cpm_cents INTEGER DEFAULT 0, created_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS stats (
    day TEXT, app_id TEXT, slot_id TEXT, campaign_id TEXT, source TEXT,
    impressions INTEGER DEFAULT 0, clicks INTEGER DEFAULT 0, completions INTEGER DEFAULT 0,
    PRIMARY KEY (day, app_id, slot_id, campaign_id, source))`,
  `CREATE TABLE IF NOT EXISTS earnings (
    day TEXT, app_id TEXT, earnings_micros INTEGER DEFAULT 0, impressions INTEGER DEFAULT 0,
    clicks INTEGER DEFAULT 0, page_views INTEGER DEFAULT 0, PRIMARY KEY (day, app_id))`,
];

// The mutaafaziz.com collection. audience=kids → child-directed Google tags, Google only outside
// gameplay, kid-safe direct creatives only, no click-outs.
export const SEED_APPS = [
  ['site', 'mutaafaziz.com', 'https://mutaafaziz.com/', 'general', 0],
  ['outatime', 'OUTATIME 88', 'https://mutaafaziz.com/outatime/', 'kids', 1],
  ['openaero', 'OpenAero DFW', 'https://mutaafaziz.com/openaero/', 'kids', 1],
  ['coldgas', 'COLD GAS', 'https://mutaafaziz.com/coldgas/', 'general', 1],
  ['kin', 'KIN', 'https://mutaafaziz.com/kin/', 'kids', 1],
  // Native iOS app: reads /ads/api/config for direct kid-safe sponsors only (its slot is declared gameplay).
  ['moonclub', 'Moon Club (iOS)', 'https://mutaafaziz.com/metaphases/kids/', 'kids', 1],
  ['chalktalk', 'Chalk Talk', 'https://mutaafaziz.com/chalktalk/', 'general', 0],
  ['hearth', 'Hearth (demo)', 'https://mutaafaziz.com/hearth/demo/', 'general', 0],
  ['library', 'Library', 'https://mutaafaziz.com/library/', 'general', 0],
  ['18-0', '18-0', 'https://18-0.co/', 'general', 1],
  ['demo', 'Demo page', 'https://mutaafaziz.com/ads/demo/', 'general', 1],
];

let ready = false;
export async function ensureSchema(db) {
  if (ready) return;
  await db.batch(SCHEMA.map((s) => db.prepare(s)));
  await db.batch(SEED_APPS.map(([id, name, url, audience, game], i) =>
    db.prepare('INSERT OR IGNORE INTO apps (id, name, url, audience, is_game, sort) VALUES (?,?,?,?,?,?)').bind(id, name, url, audience, game, i)));
  ready = true;
}

export async function getSettings(db) {
  const { results } = await db.prepare('SELECT key, value FROM settings').all();
  const s = {};
  for (const r of results) s[r.key] = r.value;
  for (const k of ['h5_enabled', 'adsense_test']) s[k] = s[k] === '1';
  return s;
}

export async function setSetting(db, key, value) {
  if (value === null || value === '') return db.prepare('DELETE FROM settings WHERE key = ?').bind(key).run();
  return db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(key, String(value)).run();
}
