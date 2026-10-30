/*! Marquee ad loader v1 · mutaafaziz.com/ads · policy: mutaafaziz.com/ads/privacy/
 *
 *   <script async src="https://mutaafaziz.com/ads/v1/ads.js" data-app="chalktalk"
 *           data-slots="gameover:interstitial:menu,continue:rewarded:menu"></script>
 *   <div data-marquee="footer"></div>                         banner (data-marquee-context="gameplay" in-game)
 *
 *   const m = window.marquee || (window.marquee = { q: [] });  queue-safe before load
 *   await marquee.interstitial('gameover', { beforeAd: pause, afterAd: resume })   → void
 *   const earned = await marquee.rewarded('continue', { beforeAd, afterAd })       → boolean
 *
 * Never throws, never blocks: every call resolves, and with no ad it resolves at once.
 */
(() => {
  if (window.marquee && window.marquee.v) return;
  const script = document.currentScript || document.querySelector('script[src*="/ads/v1/ads.js"]');
  const ORIGIN = script ? new URL(script.src, location.href).origin : location.origin;
  const APP = (script && script.dataset.app) || '';
  const DEBUG = /[?&]marquee=debug/.test(location.search);
  const log = (...a) => DEBUG && console.info('[marquee]', ...a);
  const declared = new Map();
  const counts = {};
  let cfg = null, cfgPromise = null, refetch = null, gReady = null, busy = false;

  for (const part of ((script && script.dataset.slots) || '').split(',').filter(Boolean)) {
    const [id, kind = 'banner', context = 'menu'] = part.trim().split(':');
    declared.set(id, { id, kind, context });
  }

  // ---------- config ----------
  function load() {
    const slots = [...declared.values()].map((s) => `${s.id}:${s.kind}:${s.context}`).join(',');
    return fetch(`${ORIGIN}/ads/api/config?app=${encodeURIComponent(APP)}&slots=${encodeURIComponent(slots)}`, { credentials: 'omit' })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null)
      .then((c) => { cfg = c || { enabled: false, slots: {}, campaigns: [] }; log('config', cfg); return cfg; });
  }
  function ready() { return cfgPromise || (cfgPromise = load()); }
  async function slotCfg(id, kind, context) {
    if (!declared.has(id)) {
      declared.set(id, { id, kind, context });
      if (cfg) { refetch = refetch || new Promise((r) => setTimeout(r, 50)).then(load).finally(() => { refetch = null; }); await refetch; }
    }
    const c = await ready();
    return c.enabled ? c.slots[id] : null;
  }

  // ---------- counting (aggregate only: slot|campaign|source → n) ----------
  function count(slot, campaign, source, what) {
    const k = `${slot}|${campaign || '-'}|${source}`;
    const e = counts[k] || (counts[k] = { i: 0, c: 0, v: 0 });
    e[what]++;
  }
  function flush() {
    if (!Object.keys(counts).length || !APP) return;
    const body = JSON.stringify({ app: APP, counts });
    for (const k in counts) delete counts[k];
    try { navigator.sendBeacon(`${ORIGIN}/ads/api/beacon`, new Blob([body], { type: 'text/plain' })); } catch { /* ignore */ }
  }
  setInterval(flush, 30000);
  addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && flush());
  addEventListener('pagehide', flush);

  /** Count once when ≥50% visible for 1 continuous second. */
  function viewable(el, onView) {
    if (!('IntersectionObserver' in window)) return onView();
    let t = 0;
    const io = new IntersectionObserver(([e]) => {
      clearTimeout(t);
      if (e.isIntersecting && e.intersectionRatio >= 0.5) t = setTimeout(() => { io.disconnect(); onView(); }, 1000);
    }, { threshold: [0, 0.5, 1] });
    io.observe(el);
  }

  // ---------- direct creatives ----------
  function pick(kind) {
    const list = (cfg && cfg.campaigns || []).filter((c) => c.kinds.includes(kind));
    let r = Math.random() * list.reduce((t, c) => t + c.weight, 0);
    for (const c of list) if ((r -= c.weight) < 0) return c;
    return null;
  }
  function media(c, opts = {}) {
    const m = c.media === 'video' ? document.createElement('video') : document.createElement('img');
    m.src = c.src;
    if (c.media === 'video') Object.assign(m, { muted: !opts.sound, autoplay: true, playsInline: true, preload: 'auto' });
    else Object.assign(m, { alt: c.label ? `Sponsored by ${c.label}` : 'Sponsored', decoding: 'async' });
    m.style.cssText = 'display:block;max-width:100%;max-height:100%;width:100%;height:100%;object-fit:contain';
    return m;
  }
  function wrapClick(c, slot, inner) {
    if (!c.click) return inner;
    const a = document.createElement('a');
    a.href = `${c.click}&s=${encodeURIComponent(slot)}`;
    Object.assign(a, { target: '_blank', rel: 'noopener sponsored' });
    a.style.cssText = 'display:block;width:100%;height:100%';
    a.appendChild(inner);
    return a;
  }
  function badge(text) {
    const b = document.createElement('a');
    b.textContent = text;
    b.href = `${ORIGIN}/ads/privacy/`;
    Object.assign(b, { target: '_blank', rel: 'noopener' });
    b.style.cssText = 'position:absolute;top:4px;left:4px;z-index:2;font:600 10px/1 system-ui,sans-serif;letter-spacing:.06em;' +
      'text-transform:uppercase;color:#fff;background:rgba(0,0,0,.55);padding:3px 5px;border-radius:3px;text-decoration:none';
    return b;
  }

  // ---------- Google (AdSense display + H5 Games Ads) ----------
  function google() {
    if (gReady) return gReady;
    const a = cfg.adsense;
    gReady = new Promise((resolve) => {
      window.adsbygoogle = window.adsbygoogle || [];
      window.adBreak = window.adConfig = function (o) { window.adsbygoogle.push(o); };
      const s = document.createElement('script');
      s.async = true;
      s.crossOrigin = 'anonymous';
      s.src = `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${a.client}`;
      s.dataset.adClient = a.client;
      if (a.childDirected) s.setAttribute('data-tag-for-child-directed-treatment', '1');
      if (a.test && a.h5) s.dataset.adbreakTest = 'on';
      if (a.h5) s.dataset.adFrequencyHint = '60s';
      s.onload = () => { if (a.h5) window.adConfig({ preloadAdBreaks: 'on', sound: 'on' }); resolve(true); };
      s.onerror = () => resolve(false); // blocked: fall back to direct
      document.head.appendChild(s);
      setTimeout(() => resolve(false), 6000);
    });
    return gReady;
  }

  // ---------- banners ----------
  const filled = new WeakSet();
  async function banner(el, id) {
    if (!el || filled.has(el)) return;
    filled.add(el);
    id = id || el.dataset.marquee;
    if (!id || el.classList.contains('adsbygoogle')) return;
    const s = await slotCfg(id, 'banner', el.dataset.marqueeContext || 'menu');
    if (!s || s.source === 'none') { el.hidden = true; return; }
    if (getComputedStyle(el).position === 'static') el.style.position = 'relative';
    if (s.source === 'network' && (await google())) {
      const ins = document.createElement('ins');
      ins.className = 'adsbygoogle';
      ins.style.cssText = 'display:block;width:100%';
      Object.assign(ins.dataset, { adClient: cfg.adsense.client, adSlot: s.adUnit, adFormat: 'auto', fullWidthResponsive: 'true' });
      if (cfg.adsense.test) ins.dataset.adtest = 'on';
      el.appendChild(ins);
      try { window.adsbygoogle.push({}); } catch { /* ignore */ }
      // Google marks the unit filled/unfilled; unfilled falls back to a direct sponsor.
      const mo = new MutationObserver(() => settle(ins.getAttribute('data-ad-status')));
      let settled = false;
      const settle = (st) => {
        if (!st || settled) return;
        settled = true; mo.disconnect();
        if (st === 'filled') viewable(ins, () => count(id, '', 'network', 'i'));
        else { ins.remove(); directBanner(el, id); }
      };
      mo.observe(ins, { attributes: true, attributeFilter: ['data-ad-status'] });
      // Google silent (blocked, bad unit): after 6 s treat an empty unit as unfilled.
      setTimeout(() => settle(ins.getAttribute('data-ad-status') || (ins.offsetHeight > 10 ? 'filled' : 'unfilled')), 6000);
      return;
    }
    directBanner(el, id);
  }
  function directBanner(el, id) {
    const c = pick('banner');
    if (!c) { el.hidden = true; return; }
    el.hidden = false;
    el.appendChild(badge('Sponsored'));
    el.appendChild(wrapClick(c, id, media(c)));
    viewable(el, () => count(id, c.id, 'direct', 'i'));
  }

  // ---------- full-screen breaks ----------
  function lastShown(id, set) {
    try { if (set) sessionStorage.setItem(`marquee:${id}`, String(Date.now())); return +sessionStorage.getItem(`marquee:${id}`) || 0; } catch { return 0; }
  }
  async function brk(id, kind, hooks = {}) {
    const s = await slotCfg(id, kind, hooks.context || 'menu');
    if (!s || s.source === 'none' || busy) return false;
    if (kind === 'interstitial' && s.every && Date.now() - lastShown(id) < s.every * 1000) return false;
    busy = true;
    try {
      let r = null;
      if (s.source === 'network' && (await google())) r = await networkBreak(id, kind, hooks);
      if (r === null) r = await directBreak(id, kind, hooks);
      if (r !== null) lastShown(id, true);
      return !!r;
    } finally { busy = false; }
  }
  /** H5 Games Ads. Resolves true/false when shown, null when Google had nothing (→ direct). */
  function networkBreak(id, kind, hooks) {
    return new Promise((resolve) => {
      let shown = false, earned = false, done = false;
      const finish = (v) => { if (!done) { done = true; resolve(v); } };
      const guard = setTimeout(() => !shown && finish(null), 10000);
      window.adBreak({
        type: kind === 'rewarded' ? 'reward' : 'next',
        name: id,
        beforeAd() { shown = true; count(id, '', 'network', 'i'); call(hooks.beforeAd); },
        afterAd() { call(hooks.afterAd); },
        beforeReward(showAdFn) { showAdFn(); },
        adDismissed() { earned = false; },
        adViewed() { earned = true; count(id, '', 'network', 'v'); },
        adBreakDone(info) {
          clearTimeout(guard);
          log('adBreakDone', info);
          finish(shown ? (kind === 'rewarded' ? earned : true) : null);
        },
      });
    });
  }
  /** First-party video/image break in a full-screen overlay. null when no campaign fits. */
  function directBreak(id, kind, hooks) {
    const c = pick(kind);
    if (!c) return Promise.resolve(null);
    return new Promise((resolve) => {
      call(hooks.beforeAd);
      count(id, c.id, 'direct', 'i');
      const rewarded = kind === 'rewarded';
      const ov = document.createElement('div');
      ov.setAttribute('role', 'dialog');
      ov.setAttribute('aria-label', 'Advertisement');
      ov.style.cssText = 'position:fixed;inset:0;z-index:2147483646;background:rgba(6,6,8,.94);display:flex;align-items:center;' +
        'justify-content:center;padding:clamp(12px,4vw,48px);box-sizing:border-box';
      const box = document.createElement('div');
      box.style.cssText = 'position:relative;width:min(100%,960px);aspect-ratio:' + (c.w && c.h ? `${c.w}/${c.h}` : '16/9') + ';max-height:100%';
      const m = media(c, { sound: true });
      box.appendChild(badge(rewarded ? 'Ad · reward' : 'Ad'));
      box.appendChild(wrapClick(c, id, m));
      const btn = document.createElement('button');
      btn.style.cssText = 'position:absolute;top:-6px;right:-6px;transform:translateY(-100%);font:600 13px/1 system-ui,sans-serif;' +
        'color:#fff;background:rgba(255,255,255,.12);border:1px solid rgba(255,255,255,.3);border-radius:999px;padding:9px 14px;cursor:pointer';
      box.appendChild(btn);
      ov.appendChild(box);
      document.body.appendChild(ov);
      let earned = false, left = rewarded ? 15 : 5;
      const isVideo = c.media === 'video';
      const close = () => { clearInterval(tick); ov.remove(); call(hooks.afterAd); resolve(rewarded ? earned : true); };
      const complete = () => { if (!earned) { earned = true; count(id, c.id, 'direct', 'v'); } render(); };
      const render = () => {
        if (rewarded && !earned) { btn.textContent = `Reward in ${left}s · skip`; btn.title = 'Closing now forfeits the reward'; }
        else if (!rewarded && left > 0) { btn.textContent = `Skip in ${left}s`; btn.disabled = true; }
        else { btn.textContent = rewarded ? 'Reward earned ✓ Close' : 'Close ✕'; btn.disabled = false; }
      };
      btn.onclick = () => (!rewarded && left > 0 ? null : close());
      if (isVideo) {
        m.addEventListener('ended', complete);
        m.addEventListener('error', () => { earned = rewarded; close(); });
        m.play && m.play().catch(() => { m.muted = true; m.play().catch(() => {}); });
      }
      const tick = setInterval(() => {
        left = Math.max(0, left - 1);
        if (left === 0 && !isVideo) complete();
        render();
      }, 1000);
      render();
    });
  }
  function call(f) { try { f && f(); } catch (e) { log('hook error', e); } }

  // ---------- public API + auto-scan ----------
  const api = {
    v: 1,
    ready,
    banner,
    interstitial: (id, hooks) => brk(id, 'interstitial', hooks).then(() => undefined),
    rewarded: (id, hooks) => brk(id, 'rewarded', hooks),
    flush,
  };
  const queued = (window.marquee && window.marquee.q) || [];
  window.marquee = api;
  for (const fn of queued) call(() => fn(api));

  function scan(root) {
    // Own attribute: Google's <ins> uses data-ad-slot, so sharing it would recurse.
    const els = root.querySelectorAll ? root.querySelectorAll('[data-marquee]') : [];
    for (const el of els) {
      if (!declared.has(el.dataset.marquee)) declared.set(el.dataset.marquee, { id: el.dataset.marquee, kind: 'banner', context: el.dataset.marqueeContext || 'menu' });
    }
    return els;
  }
  function start() {
    const els = scan(document);
    ready().then(() => els.forEach((el) => banner(el)));
    new MutationObserver((muts) => {
      for (const m of muts) for (const n of m.addedNodes) if (n.nodeType === 1) {
        if (n.matches && n.matches('[data-marquee]')) banner(n);
        scan(n).forEach((el) => banner(el));
      }
    }).observe(document.documentElement, { childList: true, subtree: true });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
