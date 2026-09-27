import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boot, RENDER_DEPS_MISSING } from './harness.js';

// The player, driven end to end: a file is dropped on the input, `loadReplayFile`
// reads it with the browser's FileReader, `applyReplay` parses it, and the summary,
// scrubber and cursor the wiring paints are what a visitor actually sees. What the
// pure `replay.test.js` cannot check: that `buildReplay`'s timeline reaches the DOM
// with the file name, a grouped event count and a human span, that the scrubber's
// range is the real frame count, and that scrubbing moves the readout.
const skip = RENDER_DEPS_MISSING ? { skip: 'jsdom not installed' } : {};

// Three events across five seconds: two pulse buckets and one flow between them, so
// the merged timeline is 250000 / 252000 / 255000 and the span is 5s.
const PAYLOAD = {
  pulse: [
    { t: 1790144250000, count: 120, volume: 9000, x402: 3, resolved: 120 },
    { t: 1790144255000, count: 90, volume: 7000, x402: 2, resolved: 90 },
  ],
  flows: [
    { t: 1790144252000, block: 22404771, tx: '0x' + '76'.repeat(32), from: '0x' + 'e5'.repeat(20), to: '0x' + 'f6'.repeat(20), amount: 12, venue: 'swap', x402: false },
  ],
};

async function drop(page, content, name = 'abyssal-replay.json') {
  const input = page.document.getElementById('replay-file');
  const file = new page.window.File([content], name, { type: 'application/json' });
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  input.dispatchEvent(new page.window.Event('change'));
  await page.sleep(250);
}

test('a downloaded replay file loads and paints its timeline', skip, async (t) => {
  if (RENDER_DEPS_MISSING) return;
  const page = await boot({ focusSearch: '?view=observe', observeLive: true });
  t.after(() => page.close());
  const { document } = page;

  const box = document.getElementById('replay-player');
  assert.ok(box, 'the pulse card has an offline player');
  assert.equal(box.hidden, true, 'and it starts hidden — nothing has been loaded yet');

  await drop(page, JSON.stringify(PAYLOAD));

  assert.equal(box.hidden, false, 'a chosen file reveals the player');
  assert.ok(!box.classList.contains('rp-bad') && !box.classList.contains('rp-empty'), 'a good file is neither');
  const summary = document.getElementById('replay-summary').textContent;
  assert.match(summary, /abyssal-replay\.json/, 'the file names itself');
  assert.match(summary, /3 events/, 'three merged events are counted');
  assert.match(summary, /5s/, 'the span is said in seconds, not five thousand of them');

  const scrub = document.getElementById('replay-scrub');
  assert.equal(scrub.max, '2', 'the scrubber spans the real last frame index');
  assert.equal(scrub.disabled, false, 'a playable file enables it');

  const cursor = document.getElementById('replay-cursor').textContent;
  assert.match(cursor, /event 1 of 3/, 'the playhead starts on the first event');
  assert.match(cursor, /\d\d:\d\d:\d\d/, 'and shows that event\'s wall-clock time');

  scrub.value = '2';
  scrub.dispatchEvent(new page.window.Event('input'));
  assert.match(document.getElementById('replay-cursor').textContent, /event 3 of 3/, 'scrubbing moves the readout');

  // The play button flips its own label so the sweep is visible as a state, and
  // flipping it back stops the timer — leaving it running would hold a stray interval
  // past the assertions.
  const play = document.getElementById('replay-btn');
  assert.equal(play.textContent, 'Play', 'the loaded file offers Play');
  play.dispatchEvent(new page.window.Event('click'));
  assert.equal(play.textContent, 'Pause', 'clicking starts the sweep');
  play.dispatchEvent(new page.window.Event('click'));
  assert.equal(play.textContent, 'Play', 'clicking again stops it');
});
