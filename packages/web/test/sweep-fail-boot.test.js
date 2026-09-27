import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boot, RENDER_DEPS_MISSING } from './harness.js';

// The honesty half of the wiring, and the reason the success file is not enough on
// its own: when this browser cannot reach `/verify` at all, every stamped day must
// land in `cannotSay`, and the intact count must stay at zero. A sweep that filed
// `client-error` under "verified because we got no red back" is the exact lie the
// four tiers exist to make impossible — so this file boots it deliberately.
const skip = RENDER_DEPS_MISSING ? { skip: 'jsdom not installed' } : {};

test('a sweep the browser could not fetch reports cannotSay, never intact', skip, async (t) => {
  if (RENDER_DEPS_MISSING) return;
  // `verify: 'fail'` destroys the socket before a byte returns, so every request
  // rejects and `runSweep`'s `.catch` files the hash as `client-error`.
  const page = await boot({ focusSearch: '?view=world&drawer=analytics', verify: 'fail' });
  t.after(() => page.close());
  const { document } = page;

  const panel = document.getElementById('census-sweep');
  const btn = panel.querySelector('button[data-sweep]');
  assert.ok(btn, 'the button is offered even though the endpoint is unreachable');
  btn.click();
  await page.sleep(1500);

  assert.equal(page.reqs.verify, 2, 'both stamped days were still asked about on the wire');
  assert.ok(panel.className.includes('sweep-done'), 'the pass still drains to done on failures');

  const num = (sel) => panel.querySelector(sel)?.textContent ?? '';
  assert.match(num('.sw-intact'), /0/, 'a fetch this browser could not make is not evidence of anything intact');
  assert.match(num('.sw-cannotSay'), /2/, 'both days file honestly under cannotSay');
  assert.match(num('.sw-problems'), /0/, 'and they are not problems either — nobody looked');
  assert.match(num('.sw-unchecked'), /0/, 'nothing was left unasked, so the pass is done');
});
