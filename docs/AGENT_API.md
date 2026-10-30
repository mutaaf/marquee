# Marquee agent API

Base URL: `https://mutaafaziz.com/ads/api/admin/`. Send `Authorization: Bearer $MARQUEE_AGENT_TOKEN` on every call. JSON goes in and comes out.

## Read

| Call | Returns |
|---|---|
| `GET report?days=30` | `revenue_usd` (google, direct_est, total), a `google` status block, `apps[]` (impressions by source, ctr, revenue, `page_rpm_usd`, `trend_7d_pct`, and `slots[]` with what each fills with), `campaigns[]` (delivery and estimated revenue), and `opportunities[]` (impact high/medium/low, title, detail, `action`) |
| `GET state` | Raw rows: apps, slots, campaigns, 30 days of stats, and earnings |

## Act

| Call | Body |
|---|---|
| `POST campaigns` | `{name, advertiser, click_url, weight 1–100, cpm_cents, start, end, apps:[ids], slot_kinds:[banner\|interstitial\|rewarded]}`. Returns `{id}`. The campaign starts **paused**. |
| `PUT creative/<id>?w=&h=` | The raw file as the body, with `content-type` set to its image or video type |
| `PUT campaigns/<id>` | Any field above, plus `status: active\|paused` |
| `DELETE campaigns/<id>` | Removes the campaign and its creative |
| `PUT apps/<id>` | `{enabled, network_enabled, is_game}` |
| `PUT slots/<app>/<slot>` | `{kind, context, source: auto\|network\|direct\|off, ad_unit, frequency_sec}` |

**Operator-only (403 for agents):**
- `settings`, `google/*`
- changing an app's `audience`
- setting `kid_safe: true`

A campaign that needs to run in a kids app has to go to the human for sign-off.

## Suggested loop

1. Run `report`, then handle the `opportunities` with high impact first.
2. Fill empty slots. A house campaign that promotes another app in the collection is free fill.
3. Pause any campaign whose estimated revenue lags and that has no contract behind it.
4. Write a short summary: revenue change, what you changed, and what needs the human.
