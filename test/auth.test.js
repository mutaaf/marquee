// Operator auth lives in the shared stagehand package now. These pin what the console relies on: the same
// cookie name and path, cookies issued by the old src/auth.js still verify, and the agent token still works.
import { describe, it, expect } from 'vitest';
import worker from '../src/worker.js';

const enc = new TextEncoder();
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
// The signing code from the deleted src/auth.js.
async function oldSign(secret, payload) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
  return `${payload}.${b64(await crypto.subtle.sign('HMAC', key, enc.encode(payload)))}`;
}

const q = { bind: () => q, first: async () => null, all: async () => ({ results: [] }), run: async () => ({}) };
const env = { ADMIN_PASSWORD: 'pw', AGENT_TOKEN: 'agent-token', DB: { prepare: () => q, batch: async () => [] } };
const call = (path, init = {}) => worker.fetch(new Request(`https://mutaafaziz.com${path}`, init), env, { waitUntil() {} });
const later = () => `op:${Date.now() + 864e5}`;

describe('operator auth (stagehand)', () => {
  it('login sets marquee_session on /ads', async () => {
    const r = await call('/ads/api/admin/login', { method: 'POST', body: JSON.stringify({ password: 'pw' }) });
    expect(r.status).toBe(200);
    expect(r.headers.get('set-cookie')).toMatch(/^marquee_session=op:\d+\.[\w-]+; Path=\/ads; HttpOnly; Secure; SameSite=Strict; Max-Age=2592000$/);
    expect((await call('/ads/api/admin/logout', { method: 'POST' })).headers.get('set-cookie')).toBe('marquee_session=; Path=/ads; HttpOnly; Secure; SameSite=Strict; Max-Age=0');
  });

  it('refuses the operator API without credentials', async () => {
    expect((await call('/ads/api/admin/settings')).status).toBe(401);
    expect((await call('/ads/api/admin/settings', { headers: { authorization: 'Bearer nope' } })).status).toBe(401);
    expect((await call('/ads/api/admin/settings', { headers: { cookie: `marquee_session=${await oldSign('other', later())}` } })).status).toBe(401);
    expect((await call('/ads/api/admin/settings', { headers: { cookie: `marquee_session=${await oldSign('pw', `op:${Date.now() - 1}`)}` } })).status).toBe(401);
  });

  it('accepts a cookie issued by the old auth.js', async () => {
    const r = await call('/ads/api/admin/settings', { headers: { cookie: `marquee_session=${await oldSign('pw', later())}` } });
    expect(r.status).not.toBe(401);
  });

  it('the agent token is an agent: kept out of operator-only settings', async () => {
    expect((await call('/ads/api/admin/settings', { headers: { authorization: 'Bearer agent-token' } })).status).toBe(403);
  });
});
