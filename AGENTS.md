# Marquee: agent + contributor guide

The ad server and console for every app at mutaafaziz.com (and 18-0.co). One Cloudflare Worker on
the routes `mutaafaziz.com/ads*` and `mutaafaziz.com/ads.txt`; D1 `marquee` holds config and stats, and
KV `CREATIVES` holds sponsor images and video.

| Path | What |
|---|---|
| `/ads/admin/` | Operator console: Box office, Apps & slots, Sponsors, Setup |
| `/ads/v1/ads.js` | The loader every app includes |
| `/ads/v1/frame.html?app=&slot=` | One menu banner in a same-origin frame the app removes when its moment ends (COLD GAS title). General apps only: kids apps get a 404. `frame-ancestors 'self'` |
| `/ads/api/config?app=&slots=` | Public slot decisions (cached 60 s) |
| `/ads/api/beacon` | Aggregate impression, click and completion counts |
| `/ads/api/admin/*` | Operator (cookie) or agent (`Authorization: Bearer $AGENT_TOKEN`) |
| `/ads/privacy/`, `/ads/demo/` | Ad privacy policy; a playground with every placement type |

`npm run up` installs and runs `wrangler dev` (`.dev.vars`: `ADMIN_PASSWORD`, `AGENT_TOKEN`).
Operator auth, the agent token and the log line come from the shared [stagehand](https://github.com/mutaaf/stagehand)
package (cookie `marquee_session` on `/ads`; Cloudflare Access takes over once `ACCESS_TEAM`, `ACCESS_AUD` and
`OPERATOR_EMAILS` are set). Every request and cron run logs one JSON line `{service, event, ms, ok}`.
`npm run check` runs the gate. Deploy with `npm run deploy` (wrangler).

## Policy (non-negotiable; enforced in `src/lib/select.js`)

1. **Kids apps** (`audience = kids`: OUTATIME, OpenAero, KIN):
   - Google ad requests are tagged `data-tag-for-child-directed-treatment="1"`.
   - Google never fills a `gameplay` slot.
   - Only `kid_safe` sponsors run, and they never click out.
2. **Only a human operator** may set `kid_safe`, change an app's audience, or edit AdSense or Google settings. The agent API returns 403 for these.
3. **Creatives** are PNG, JPEG, WebP, GIF, MP4 or WebM, at most 24 MB each. SVG and HTML are refused because they can carry scripts.
4. **Counts are aggregates only:** `slot|campaign|source → n`. Never record a visitor id, IP address or device data.
5. **Every ad is labelled** "Ad" or "Sponsored", and the label links to `/ads/privacy/`.

## Integrating an app

```html
<script async src="/ads/v1/ads.js" data-app="<app-id>"
        data-slots="gameover:interstitial:menu,continue:rewarded:menu"></script>
<div data-marquee="footer" style="min-height:90px"></div>   <!-- banner; data-marquee-context="gameplay" in-game -->
```

```js
const m = window.marquee || (window.marquee = { q: [] });          // safe before the script loads
await marquee.interstitial('gameover', { beforeAd: pause, afterAd: resume });
const earned = await marquee.rewarded('continue', { beforeAd: pause, afterAd: resume });
```

- Every call resolves, and resolves immediately when there's no ad. Never gate gameplay on an ad.
- Interstitials are frequency-capped per slot (default 120 s).
- Rewarded ads must be opt-in: the player presses a "watch for X" button first.
- App ids are `site`, `outatime`, `openaero`, `coldgas`, `kin`, `chalktalk`, `hearth`, `library`, `18-0` and `demo`. Slots register themselves the first time an app declares them.
- A slot that must stop cold (a title the player leaves for a run): put `/ads/v1/frame.html?app=<id>&slot=<slot>` in an `<iframe>` and remove the iframe. The frame posts `{marqueeFrame: slot, h}` to the parent whenever its height changes, so the parent can size it exactly as the in-page slot would be. The slot must be a registered `banner` in `menu` context.
- Apps with a no-third-party smoke test: allow-list `pagead2.googlesyndication.com` and Google's ad frames only for the menu context. Keep gameplay requests same-origin.

## Agent API (Hermes or any other agent)

See `docs/AGENT_API.md`. Start every run with `GET /ads/api/admin/report?days=30`, act on the
`opportunities`, and never retry a 403.
