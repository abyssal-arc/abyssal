import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boot, RENDER_DEPS_MISSING, census } from './harness.js';

// An empty book has no days to sell. The card must not advertise a downloadable day
// book the census cannot fill — the same honesty as the census text refusing to draw
// a chart with no rows. This is the reveal condition's negative half: not hidden
// "until a click", hidden "until there is anything to buy".
const skip = RENDER_DEPS_MISSING ? { skip: 'jsdom not installed' } : {};

test('a book with no closed days does not advertise a download', skip, async (t) => {
  if (RENDER_DEPS_MISSING) return;
  const page = await boot({
    focusSearch: '?view=world&drawer=analytics',
    book: { ...census, rows: [], changes: [] },
  });
  t.after(() => page.close());
  const { document } = page;

  const panel = document.getElementById('census-data');
  assert.ok(panel, 'the card container exists');
  assert.equal(panel.hidden, true, 'with no rows there is nothing to sell, so the card stays hidden');
  assert.equal(panel.innerHTML, '', 'and it is empty, not a disabled button or a stale price');
});
