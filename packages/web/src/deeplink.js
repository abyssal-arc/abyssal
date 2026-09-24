/**
 * What the address bar is for: naming the thing a visitor is looking at.
 *
 * Five keys, each one a state the interface can already be in:
 *
 *   view     'world' | 'observe'
 *   creature a tank animal's id — its card is open and the camera is on it
 *   addr     an address, 0x + 40 hex — its flow card is open
 *   day      a day in the book, pinned so the chart names it
 *   drawer   'mem' | 'obits' | 'analytics' | 'you'
 *
 * The rules live here rather than inline in `app.js` because every one of them is
 * a claim a test can check and a browser cannot: whether `?creature=-3` means
 * something, whether a link copied in the tank still says "tank" when it is
 * opened, whether the address that goes into the bar is the address that came
 * out. `app.js` decides *when* to call these; it does not decide *what is valid*.
 *
 * One thing this deliberately cannot express: liveness. A creature id is not a
 * permanent handle — animals die, and a link copied this morning can point at
 * nothing by noon. That is why a stale `creature` opens the tank without a
 * selection rather than an error: the link was true when it was made, and the
 * tank is the same tank.
 */

export const VIEWS = ['world', 'observe'];
export const DRAWERS = ['mem', 'obits', 'analytics', 'you'];

/** Written in this order, always: two tabs must produce byte-identical links. */
const KEY_ORDER = ['view', 'creature', 'addr', 'day', 'drawer'];

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * Read the query string, keeping only what the interface can act on.
 *
 * Junk is dropped per key rather than rejecting the whole link: `?view=tank` is a
 * person who meant something and mistyped one word, and the right answer is to
 * open the tank they asked for, not to throw the `creature` away with the typo.
 */
export function parseFocus(params) {
  const src = typeof params === 'string' ? new URLSearchParams(params.replace(/^[?#]/, '')) : params;
  const out = {};
  const view = src.get('view');
  if (view !== null && VIEWS.includes(view)) out.view = view;

  const creature = whole(src.get('creature'));
  if (creature !== null) out.creature = creature;

  const addr = src.get('addr');
  // Mixed case is accepted because that is how wallets and explorers print
  // addresses — the checksum spelling. It is kept lowercase because the tank
  // keys everything that way, and a link must describe the same endpoint whether
  // or not the copier's wallet had shouted it at them.
  if (addr !== null && ADDRESS.test(addr)) out.addr = addr.toLowerCase();

  const day = whole(src.get('day'));
  if (day !== null) out.day = day;

  const drawer = src.get('drawer');
  if (drawer !== null && DRAWERS.includes(drawer)) out.drawer = drawer;

  return out;
}

/**
 * A non-negative integer in its canonical form, or null.
 *
 * `007` is refused rather than read as 7 on purpose: a link that has to be
 * re-written to mean the same thing is a link where the address bar and the
 * clipboard disagree, and there is no reason to allow the spelling in the first
 * place. `-3`, `1.5`, `1e3` and `9007199254740993` are the other ways a number
 * stops being one.
 */
function whole(raw) {
  if (raw === null || !/^(0|[1-9]\d*)$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : null;
}

/**
 * Write the query string for a focus.
 *
 * `view` is never omitted, even as `world`: a link is a promise about what
 * opening it shows, and "no view in the URL" means "the site decides", which for
 * a returning visitor with the Arc feed live means OBSERVE. Anything else in the
 * link that a viewer can see is written, so copying the bar and sending it cannot
 * lose the thing they were looking at.
 */
export function serializeFocus(focus) {
  const q = new URLSearchParams();
  for (const key of KEY_ORDER) {
    const v = focus?.[key];
    if (v === undefined || v === null) continue;
    q.set(key, String(key === 'addr' ? String(v).toLowerCase() : v));
  }
  const s = q.toString();
  return s ? `?${s}` : '';
}

/**
 * The absolute link for a focus, against the page it was made from.
 *
 * The query is *replaced*, not merged, and by the same function that writes the
 * address bar: the invariant worth having is that the string in the bar and the
 * string on the clipboard are literally the same string, so a link that was
 * copied cannot describe a screen the copier never saw. Whatever else a URL
 * carried — a campaign tag, someone's `&foo=1` — is not part of what is on
 * screen, so it is not part of the link either.
 */
export function focusUrl(base, focus) {
  const url = new URL(base);
  url.search = serializeFocus(focus);
  url.hash = '';
  return url.toString();
}
