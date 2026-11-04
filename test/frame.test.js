import { describe, it, expect } from 'vitest';
import { frameAllowed, framePage, FRAME_HEADERS, KIDS_APPS } from '../src/lib/frame.js';
import worker from '../src/worker.js';

const coldgas = { id: 'coldgas', audience: 'general', enabled: 1 };
const title = { app_id: 'coldgas', id: 'title', kind: 'banner', context: 'menu' };

describe('frameAllowed', () => {
  it('serves a general app’s menu banner', () => {
    expect(frameAllowed('coldgas', 'title', coldgas, title)).toBe(true);
  });
  it('never serves a kids app, even one the database calls general', () => {
    for (const id of KIDS_APPS) {
      expect(frameAllowed(id, 'title', { id, audience: 'general', enabled: 1 }, { ...title, app_id: id })).toBe(false);
      expect(frameAllowed(id, 'title', { id, audience: 'kids', enabled: 1 }, { ...title, app_id: id })).toBe(false);
    }
    expect(frameAllowed('newkid', 'title', { id: 'newkid', audience: 'kids', enabled: 1 }, { ...title, app_id: 'newkid' })).toBe(false);
  });
  it('refuses unknown apps and slots, breaks, gameplay slots and disabled apps', () => {
    expect(frameAllowed('coldgas', 'title', null, title)).toBe(false);
    expect(frameAllowed('coldgas', 'nope', coldgas, null)).toBe(false);
    expect(frameAllowed('coldgas', 'postrun', coldgas, { ...title, id: 'postrun', kind: 'interstitial' })).toBe(false);
    expect(frameAllowed('coldgas', 'title', coldgas, { ...title, context: 'gameplay' })).toBe(false);
    expect(frameAllowed('coldgas', 'title', { ...coldgas, enabled: 0 }, title)).toBe(false);
    expect(frameAllowed('coldgas', 'title', coldgas, { ...title, app_id: 'chalktalk' })).toBe(false);
  });
  it('refuses ids that are not ids', () => {
    expect(frameAllowed('cold"gas', 'title', coldgas, title)).toBe(false);
    expect(frameAllowed('coldgas', '<b>', coldgas, title)).toBe(false);
    expect(frameAllowed('', '', coldgas, title)).toBe(false);
  });
});

describe('framePage', () => {
  it('holds the loader and one slot, transparent, no chrome', () => {
    const html = framePage('coldgas', 'title');
    expect(html).toContain('<div data-marquee="title" data-marquee-context="menu"></div>');
    expect(html).toContain('<script async src="/ads/v1/ads.js" data-app="coldgas" data-slots="title:banner:menu"></script>');
    expect(html).toContain('background:transparent');
    expect(html).toContain('<meta name="color-scheme" content="light dark">');
    expect(html.match(/data-marquee=/g)).toHaveLength(1);
    expect(html).toContain('marqueeFrame');
  });
  it('escapes whatever it is given', () => {
    const html = framePage('a"><script>x</script>', "s'</script><b>");
    expect(html).not.toContain('<script>x</script>');
    expect(html).not.toContain('<b>');
    expect(html).toContain('&quot;&gt;&lt;script&gt;');
  });
  it('may be framed only by our own pages', () => {
    expect(FRAME_HEADERS['content-security-policy']).toBe("frame-ancestors 'self'");
  });
});

// The route, against a stand-in D1.
function env(apps, slots) {
  const stmt = (sql) => ({
    bind: (...a) => ({
      first: async () => (/FROM apps/.test(sql) ? apps.find((x) => x.id === a[0]) : slots.find((x) => x.app_id === a[0] && x.id === a[1])) || null,
    }),
  });
  return { DB: { prepare: stmt, batch: async () => [] }, ASSETS: { fetch: async () => new Response('asset', { status: 200 }) } };
}
const E = env(
  [coldgas, { id: 'kin', audience: 'kids', enabled: 1 }, { id: 'outatime', audience: 'kids', enabled: 1 }],
  [title, { ...title, app_id: 'kin' }, { ...title, app_id: 'outatime' }, { ...title, id: 'postrun', kind: 'interstitial' }],
);
const get = (q) => worker.fetch(new Request(`https://mutaafaziz.com/ads/v1/frame.html${q}`), E, { waitUntil() {} });

describe('GET /ads/v1/frame.html', () => {
  it('serves the frame for coldgas/title with frame-ancestors self', async () => {
    const r = await get('?app=coldgas&slot=title');
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toMatch(/^text\/html/);
    expect(r.headers.get('content-security-policy')).toBe("frame-ancestors 'self'");
    expect(await r.text()).toContain('data-marquee="title"');
  });
  it('404s kids apps, unknown apps and slots, breaks and junk', async () => {
    for (const q of ['?app=kin&slot=title', '?app=outatime&slot=title', '?app=openaero&slot=title', '?app=nope&slot=title',
      '?app=coldgas&slot=nope', '?app=coldgas&slot=postrun', '?app=coldgas', '', '?app=%22%3E&slot=title']) {
      const r = await get(q);
      expect(r.status, q).toBe(404);
      expect(await r.text()).toBe('Not found');
    }
  });
});
