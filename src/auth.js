// Operator auth: one password (Worker secret ADMIN_PASSWORD) → HMAC-signed session cookie.

const COOKIE = 'marquee_session';
const DAYS = 30;
const enc = new TextEncoder();

async function key(secret) {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

export async function sign(secret, payload) {
  const sig = await crypto.subtle.sign('HMAC', await key(secret), enc.encode(payload));
  return `${payload}.${b64(sig)}`;
}

export async function verify(secret, token) {
  if (!secret || !token) return false;
  const i = token.lastIndexOf('.');
  if (i < 0) return false;
  const payload = token.slice(0, i);
  if ((await sign(secret, payload)) !== token) return false;
  return Number(payload.split(':')[1]) > Date.now();
}

export function timingSafeEqual(a, b) {
  const x = enc.encode(String(a)), y = enc.encode(String(b));
  let d = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) d |= (x[i] || 0) ^ (y[i] || 0);
  return d === 0;
}

export async function sessionCookie(secret) {
  const token = await sign(secret, `op:${Date.now() + DAYS * 864e5}`);
  return `${COOKIE}=${token}; Path=/ads; HttpOnly; Secure; SameSite=Strict; Max-Age=${DAYS * 86400}`;
}

export const clearCookie = `${COOKIE}=; Path=/ads; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;

/** 'operator' (console cookie), 'agent' (Bearer AGENT_TOKEN, e.g. Hermes), or null. */
export async function role(req, env) {
  const bearer = (req.headers.get('authorization') || '').match(/^Bearer (.+)$/);
  if (bearer && env.AGENT_TOKEN && timingSafeEqual(bearer[1], env.AGENT_TOKEN)) return 'agent';
  const m = (req.headers.get('cookie') || '').match(new RegExp(`${COOKIE}=([^;]+)`));
  return (await verify(env.ADMIN_PASSWORD, m && m[1])) ? 'operator' : null;
}

export async function isOperator(req, env) {
  return (await role(req, env)) === 'operator';
}
