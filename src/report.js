// Performance + opportunity report: the one read an agent (Hermes) or the console needs to decide
// what to change next. Pure aggregation over D1; every opportunity names the API call that acts on it.
import { getSettings } from './db.js';
import { resolveSlot, campaignFits } from './lib/select.js';

const iso = (d) => d.toISOString().slice(0, 10);

export async function report(db, days = 30) {
  const now = new Date();
  const today = iso(now);
  const since = iso(new Date(now - days * 864e5));
  const wk = iso(new Date(now - 7 * 864e5));
  const prevWk = iso(new Date(now - 14 * 864e5));
  const [settings, apps, slots, campaigns, stats, earnings] = await Promise.all([
    getSettings(db),
    db.prepare('SELECT * FROM apps ORDER BY sort').all().then((r) => r.results),
    db.prepare('SELECT * FROM slots').all().then((r) => r.results),
    db.prepare('SELECT * FROM campaigns').all().then((r) => r.results),
    db.prepare('SELECT * FROM stats WHERE day >= ?').bind(since).all().then((r) => r.results),
    db.prepare('SELECT * FROM earnings WHERE day >= ?').bind(since).all().then((r) => r.results),
  ]);
  const cpm = Object.fromEntries(campaigns.map((c) => [c.id, c.cpm_cents || 0]));
  const directUsd = (rows) => rows.filter((r) => r.source === 'direct').reduce((t, r) => t + (r.impressions * (cpm[r.campaign_id] || 0)) / 1e5, 0);
  const sum = (rows, k) => rows.reduce((t, r) => t + (r[k] || 0), 0);
  const round = (n) => Math.round(n * 100) / 100;

  const appRows = apps.map((a) => {
    const st = stats.filter((r) => r.app_id === a.id);
    const er = earnings.filter((r) => r.app_id === a.id);
    const google = sum(er, 'earnings_micros') / 1e6;
    const direct = directUsd(st);
    const imps = sum(st, 'impressions');
    const thisWk = sum(st.filter((r) => r.day > wk), 'impressions');
    const lastWk = sum(st.filter((r) => r.day > prevWk && r.day <= wk), 'impressions');
    const pv = sum(er, 'page_views');
    return {
      id: a.id, name: a.name, audience: a.audience, enabled: !!a.enabled, google_enabled: !!a.network_enabled,
      impressions: { google: sum(st.filter((r) => r.source === 'network'), 'impressions'), direct: sum(st.filter((r) => r.source === 'direct'), 'impressions') },
      clicks: sum(st, 'clicks'), completions: sum(st, 'completions'),
      ctr: imps ? round((sum(st, 'clicks') / imps) * 100) : 0,
      revenue_usd: { google: round(google), direct_est: round(direct), total: round(google + direct) },
      page_rpm_usd: pv ? round((google / pv) * 1000) : null,
      trend_7d_pct: lastWk ? Math.round(((thisWk - lastWk) / lastWk) * 100) : null,
      slots: slots.filter((s) => s.app_id === a.id).map((s) => {
        const ss = st.filter((r) => r.slot_id === s.id);
        return { id: s.id, kind: s.kind, context: s.context, source_setting: s.source,
          fills_with: resolveSlot(s, a, settings, campaigns, today), last_seen: s.seen_at,
          impressions: sum(ss, 'impressions'), clicks: sum(ss, 'clicks') };
      }),
    };
  });

  const opp = [];
  const add = (impact, title, detail, action) => opp.push({ impact, title, detail, action });
  if (!settings.adsense_client) add('high', 'Google demand is off', 'No AdSense publisher id: every slot is direct-only.', 'operator: /ads/admin → Setup');
  else if (!settings.adsense_display_unit) add('high', 'No display ad unit', 'Banners cannot request Google ads.', 'operator: Setup → Display ad unit');
  if (settings.adsense_client && !settings.h5_enabled) add('medium', 'Games have no Google video', 'Interstitial/rewarded slots in games only show direct video until H5 Games Ads is approved.', 'operator: apply for H5 Games Ads, then flip it on');
  if (settings.adsense_test) add('high', 'Test mode is on', 'Google serves test ads that earn nothing.', 'operator: Setup → Test mode off');
  for (const a of appRows) {
    if (!a.enabled) add('low', `${a.name}: ads off`, 'App is switched off.', `PUT /ads/api/admin/apps/${a.id} {"enabled":true}`);
    if (a.enabled && !a.slots.length) add('medium', `${a.name}: no slots`, 'The app has not loaded the Marquee script yet.', 'integrate /ads/v1/ads.js in the app repo');
    for (const s of a.slots) {
      if (s.fills_with === 'none' && s.source_setting !== 'off') {
        add(s.kind === 'banner' ? 'medium' : 'high', `${a.name}/${s.id}: empty ${s.kind}`,
          a.audience === 'kids' && s.context === 'gameplay' ? 'Kids gameplay is direct-only: needs a kid-safe sponsor (operator sign-off).' : `No ${s.kind === 'banner' ? 'image' : 'video or image'} sponsor fits and Google cannot fill it.`,
          'POST /ads/api/admin/campaigns + PUT /ads/api/admin/creative/<id>');
      }
      if (s.last_seen && s.last_seen < wk) add('low', `${a.name}/${s.id}: stale slot`, `Not requested since ${s.last_seen}; the app may have dropped it.`, `DELETE /ads/api/admin/slots/${a.id}/${s.id}`);
    }
    if (a.trend_7d_pct !== null && a.trend_7d_pct <= -25) add('medium', `${a.name}: impressions down ${-a.trend_7d_pct}% week over week`, 'Traffic or fill dropped.', 'check the app and its slots');
  }
  for (const c of campaigns) {
    const cs = stats.filter((r) => r.campaign_id === c.id);
    if (c.status === 'active' && c.end && c.end >= today && c.end <= iso(new Date(+now + 7 * 864e5))) add('medium', `Sponsor "${c.name}" ends ${c.end}`, 'Renewal conversation or replacement creative.', `PUT /ads/api/admin/campaigns/${c.id} {"end":"YYYY-MM-DD"}`);
    if (c.status === 'active' && !sum(cs, 'impressions') && apps.every((a) => !['banner', 'interstitial', 'rewarded'].some((k) => campaignFits(c, a, k, today)))) add('medium', `Sponsor "${c.name}" can't run anywhere`, 'Its targeting, dates, media or kid-safety exclude every slot.', `PUT /ads/api/admin/campaigns/${c.id}`);
  }
  const rank = { high: 0, medium: 1, low: 2 };
  opp.sort((x, y) => rank[x.impact] - rank[y.impact]);

  const totals = appRows.reduce((t, a) => ({ google: t.google + a.revenue_usd.google, direct: t.direct + a.revenue_usd.direct_est }), { google: 0, direct: 0 });
  return {
    window: { from: since, to: today, days },
    revenue_usd: { google: round(totals.google), direct_est: round(totals.direct), total: round(totals.google + totals.direct) },
    google: { publisher: settings.adsense_client || null, h5_games: !!settings.h5_enabled, test_mode: !!settings.adsense_test, reporting: !!settings.google_refresh_token, last_sync: settings.google_last_sync || null },
    apps: appRows.sort((x, y) => y.revenue_usd.total - x.revenue_usd.total),
    campaigns: campaigns.map((c) => {
      const cs = stats.filter((r) => r.campaign_id === c.id);
      return { id: c.id, name: c.name, status: c.status, media: c.media, kid_safe: !!c.kid_safe, start: c.start, end: c.end,
        impressions: sum(cs, 'impressions'), clicks: sum(cs, 'clicks'), completions: sum(cs, 'completions'), revenue_est_usd: round(directUsd(cs)) };
    }),
    opportunities: opp,
  };
}
