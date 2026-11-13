// The removable frame for one banner slot: /ads/v1/frame.html?app=<id>&slot=<slot>.
// A game puts this same-origin page in an <iframe> and removes the iframe when the slot's moment ends
// (COLD GAS's title on Jump, cold-gas 0122). Removing a frame tears down its document, so every request,
// timer and script the loader or Google started in it stops with it. The page is the plain loader plus one
// [data-marquee] slot: transparent, no chrome. It reports its height to the parent so the parent can size
// the frame exactly as the in-document slot would have been sized.

// Kids apps never go through a frame, whatever the database says (AGENTS.md policy 1): a frame is a
// general-audience menu banner only. The audience check below is the real rule; this list is the backstop.
export const KIDS_APPS = ['outatime', 'openaero', 'kin', 'moonclub'];
const ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** May this app + slot be served as a frame? `app` and `slot` are the stored rows (or null). */
export function frameAllowed(appId, slotId, app, slot) {
  if (!ID.test(appId || '') || !ID.test(slotId || '')) return false;
  if (KIDS_APPS.includes(appId)) return false;
  if (!app || app.id !== appId || app.audience !== 'general' || !app.enabled) return false;
  if (!slot || slot.app_id !== appId || slot.id !== slotId) return false;
  return slot.kind === 'banner' && slot.context === 'menu';
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** The frame document. Only ever called with ids frameAllowed() accepted; escaped regardless. */
export function framePage(appId, slotId) {
  const app = esc(appId), slot = esc(slotId);
  // The height report runs before the loader, so a slot that never fills reports 0 at once.
  const report = `(()=>{const s=${JSON.stringify(String(slotId))};let last=-1;const send=()=>{const h=Math.ceil(document.body.getBoundingClientRect().height);if(h!==last){last=h;try{parent.postMessage({marqueeFrame:s,h},location.origin)}catch(e){}}};new ResizeObserver(send).observe(document.body);addEventListener('load',send)})();`
    .replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="robots" content="noindex">
<meta name="color-scheme" content="light dark">
<title>Ad</title>
<style>html,body{margin:0;padding:0;background:transparent;overflow:hidden}body{display:flow-root}[data-marquee]{width:100%}</style>
</head>
<body>
<div data-marquee="${slot}" data-marquee-context="menu"></div>
<script>${report}</script>
<script async src="/ads/v1/ads.js" data-app="${app}" data-slots="${slot}:banner:menu"></script>
</body>
</html>
`;
}

export const FRAME_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'public, max-age=60',
  // Only our own pages may frame it: a frame on someone else's site would be ad framing, and AdSense forbids that.
  'content-security-policy': "frame-ancestors 'self'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
};
