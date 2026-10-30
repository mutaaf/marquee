import { describe, it, expect } from 'vitest';
import { resolveSlot, buildConfig, campaignFits, parseDeclared, pickWeighted, adsTxt } from '../src/lib/select.js';

const day = '2026-11-01';
const general = { id: 'chalktalk', enabled: 1, network_enabled: 1, audience: 'general', is_game: 0 };
const kidsGame = { id: 'outatime', enabled: 1, network_enabled: 1, audience: 'kids', is_game: 1 };
const google = { adsense_client: 'ca-pub-1234567890123456', adsense_display_unit: '999', h5_enabled: true };
const img = { id: 'acme', status: 'active', creative_key: 'acme/1', media: 'image', kid_safe: 0, apps: '[]', slot_kinds: '[]', weight: 2, click_url: 'https://acme.com' };
const kidImg = { ...img, id: 'toys', kid_safe: 1 };
const vid = { ...img, id: 'promo', media: 'video', kid_safe: 1 };

describe('resolveSlot', () => {
  it('prefers Google when configured, falls back to direct, then none', () => {
    const s = { id: 'footer', kind: 'banner', context: 'menu', source: 'auto' };
    expect(resolveSlot(s, general, google, [img], day)).toBe('network');
    expect(resolveSlot(s, general, {}, [img], day)).toBe('direct');
    expect(resolveSlot(s, general, {}, [], day)).toBe('none');
  });

  it('never sends Google into kids gameplay', () => {
    const s = { id: 'board', kind: 'banner', context: 'gameplay', source: 'network' };
    expect(resolveSlot(s, kidsGame, google, [kidImg], day)).toBe('direct');
    expect(resolveSlot(s, kidsGame, google, [], day)).toBe('none');
  });

  it('allows child-directed Google on kids menus', () => {
    expect(resolveSlot({ kind: 'interstitial', context: 'menu', source: 'auto' }, kidsGame, google, [], day)).toBe('network');
  });

  it('video breaks need H5 + a game', () => {
    const s = { kind: 'rewarded', context: 'menu', source: 'auto' };
    expect(resolveSlot(s, general, google, [vid], day)).toBe('direct');
    expect(resolveSlot(s, kidsGame, { ...google, h5_enabled: false }, [vid], day)).toBe('direct');
  });

  it('respects off and disabled apps', () => {
    expect(resolveSlot({ kind: 'banner', context: 'menu', source: 'off' }, general, google, [img], day)).toBe('none');
    expect(resolveSlot({ kind: 'banner', context: 'menu', source: 'auto' }, { ...general, enabled: 0 }, google, [img], day)).toBe('none');
  });
});

describe('campaignFits', () => {
  it('kids apps only take kid-safe creatives', () => {
    expect(campaignFits(img, kidsGame, 'banner', day)).toBe(false);
    expect(campaignFits(kidImg, kidsGame, 'banner', day)).toBe(true);
  });
  it('honours dates, app targeting and media/kind', () => {
    expect(campaignFits({ ...img, end: '2026-10-31' }, general, 'banner', day)).toBe(false);
    expect(campaignFits({ ...img, start: '2026-11-02' }, general, 'banner', day)).toBe(false);
    expect(campaignFits({ ...img, apps: '["kin"]' }, general, 'banner', day)).toBe(false);
    expect(campaignFits(vid, general, 'banner', day)).toBe(false);
    expect(campaignFits(vid, general, 'interstitial', day)).toBe(true);
    expect(campaignFits({ ...img, status: 'paused' }, general, 'banner', day)).toBe(false);
  });
});

describe('buildConfig', () => {
  it('kids: child-directed flag, no click-outs, kid-safe only', () => {
    const c = buildConfig({ app: kidsGame, slots: [{ id: 'board', kind: 'banner', context: 'gameplay', source: 'auto' }], settings: google, campaigns: [img, kidImg], day });
    expect(c.adsense.childDirected).toBe(true);
    expect(c.campaigns.map((x) => x.id)).toEqual(['toys']);
    expect(c.campaigns[0].click).toBe('');
  });
  it('general apps get a counted click URL and no secrets', () => {
    const c = buildConfig({ app: general, slots: [{ id: 'f', kind: 'banner', context: 'menu', source: 'direct' }], settings: { ...google, google_client_secret: 'x' }, campaigns: [img], day });
    expect(c.campaigns[0].click).toBe('/ads/c/acme?a=chalktalk');
    expect(JSON.stringify(c)).not.toContain('google_client_secret');
    expect(c.slots.f.adUnit).toBe('999');
  });
  it('unknown app is disabled', () => {
    expect(buildConfig({ app: null }).enabled).toBe(false);
  });
});

it('parseDeclared rejects junk', () => {
  expect(parseDeclared('footer,gameover:interstitial:menu,bad id:banner,x:video:menu,<s>')).toEqual([
    { id: 'footer', kind: 'banner', context: 'menu' },
    { id: 'gameover', kind: 'interstitial', context: 'menu' },
  ]);
});

it('pickWeighted follows weights', () => {
  const items = [{ id: 'a', weight: 1 }, { id: 'b', weight: 3 }];
  expect(pickWeighted(items, () => 0.1).id).toBe('a');
  expect(pickWeighted(items, () => 0.9).id).toBe('b');
});

it('ads.txt carries the publisher line', () => {
  expect(adsTxt(google)).toContain('google.com, pub-1234567890123456, DIRECT, f08c47fec0942fa0');
  expect(adsTxt({ ads_txt_extra: 'x.com, 1, RESELLER\n' })).toContain('x.com, 1, RESELLER');
});
