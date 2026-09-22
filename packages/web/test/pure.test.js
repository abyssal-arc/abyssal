import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  mulberry32, hashSeed, mixSeed, unitNoise,
} from '../src/geom.js';
import { fmtUsd, shortAddr, hsla } from '../src/format.js';

test('mulberry32 is deterministic and stays in [0,1)', () => {
  const a = mulberry32(7);
  const b = mulberry32(7);
  for (let i = 0; i < 50; i++) {
    const x = a();
    assert.equal(x, b());
    assert.ok(x >= 0 && x < 1);
  }
});

test('hash seeds are stable and discriminating', () => {
  assert.equal(hashSeed('0xabc'), hashSeed('0xabc'));
  assert.notEqual(hashSeed('0xabc'), hashSeed('0xabd'));
  assert.equal(mixSeed(1.4, 2.6), mixSeed(1.4, 2.6));
  const n = unitNoise(42);
  assert.ok(n >= 0 && n <= 1);
  assert.equal(n, unitNoise(42));
});

test('format helpers', () => {
  assert.equal(fmtUsd(0.05), '$0.05');
  assert.equal(fmtUsd(1500), '$1.5k');
  assert.equal(fmtUsd(2_500_000), '$2.50M');
  assert.equal(fmtUsd(3_000_000_000), '$3.00B');
  assert.equal(shortAddr('0x1234567890abcdef'), '0x1234…cdef');
  assert.equal(hsla(180, 50, 50, 0.5), 'hsla(180, 50%, 50%, 0.5)');
});

test('pollAux keeps its three payloads in the order it destructures them', () => {
  // A positional swap here once handed the battle reports to the extinction
  // lists, which read `.judgments` off them and quietly showed "no culls yet".
  const src = readFileSync(fileURLToPath(new URL('../app.js', import.meta.url)), 'utf8');
  const body = src.slice(src.indexOf('async function pollAux'), src.indexOf('async function pollObserve'));
  const asked = [...body.matchAll(/getJSON\(`?'?([^'`)]+)/g)].map((m) => m[1].split('?')[0]);
  assert.deepEqual(asked.slice(0, 3), ['/history', '/judgments', '/reports']);
  const [names] = body.match(/const \[([^\]]+)\] = await Promise\.all/).slice(1);
  assert.deepEqual(names.split(',').map((s) => s.trim()), ['hist', 'culls', 'rep']);
  assert.match(body, /lastCulls = culls\.judgments/);
  assert.match(body, /renderReports\(rep\?\.reports\)/);
});

/**
 * Read the dictionary straight out of the source: i18n.js touches localStorage
 * and document at module scope, so importing it would need a DOM for what is
 * really a text-consistency question.
 */
function readDict() {
  const src = readFileSync(fileURLToPath(new URL('../i18n.js', import.meta.url)), 'utf8');
  const body = src.slice(src.indexOf('const dict = {'), src.indexOf('export const LANGS'));
  const heads = [...body.matchAll(/^  (\w\w): \{$/gm)];
  return heads.map((h, i) => {
    const end = i + 1 < heads.length ? heads[i + 1].index : body.length;
    const keys = new Map();
    // Whitespace before the comma is tolerated on purpose: it is harmless to JS,
    // and a reader that choked on it would report a key as missing when it is
    // only untidy — sending the hunt after the dictionary instead of the typo.
    for (const m of body.slice(h.index, end).matchAll(/^    (\w+): (['"])((?:\\.|(?!\2).)*)\2\s*,$/gm)) {
      keys.set(m[1], m[3]);
    }
    return { code: h[1], keys };
  });
}

test('every language carries every key, and interpolates the same values', () => {
  const langs = readDict();
  assert.equal(langs.length, 6, 'the language menu and the dictionary must stay in step');
  const en = langs.find((l) => l.code === 'en');
  assert.ok(en, 'English is the fallback dictionary, so it has to be there');
  assert.ok(en.keys.size > 200, `expected a full dictionary, read ${en.keys.size} keys`);
  const holes = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
  for (const l of langs) {
    if (l.code === 'en') continue;
    const missing = [...en.keys.keys()].filter((k) => !l.keys.has(k));
    const extra = [...l.keys.keys()].filter((k) => !en.keys.has(k));
    assert.deepEqual(missing, [], `${l.code} is missing ${missing.length} keys: ${missing.slice(0, 6).join(', ')}`);
    assert.deepEqual(extra, [], `${l.code} carries keys English does not: ${extra.slice(0, 6).join(', ')}`);
    for (const [k, v] of en.keys) {
      const want = holes(v);
      if (want.length === 0) continue;
      // A translation that drops a placeholder renders "named " with no name,
      // and nothing else in the stack would ever notice.
      assert.deepEqual(holes(l.keys.get(k)), want, `${l.code}.${k} must interpolate what English does`);
    }
  }
});

test('the paid-intervention copy is present in all six languages', () => {
  const langs = readDict();
  // The four paid actions on one creature ship as one block; a language that
  // got the buttons but not the words shows raw keys in the dialog.
  const wanted = [
    'ivGroupOne', 'pickHint', 'ivCancel', 'ivConfirm', 'ivNeedTarget', 'ivTargetGone',
    'ivName', 'ivNamePrompt', 'ivNameNote', 'ivNameLegendary', 'evtNaming',
    'ivWish', 'ivWishPrompt', 'ivWishNote', 'evtWish',
    'ivMutate', 'ivMutatePrompt', 'ivMutateNote', 'evtMutation', 'evtMutateBecame',
    'ivArk', 'ivArkPrompt', 'ivArkNote', 'ivArkHeld', 'evtArkSaveHarvest', 'evtArkSaveJudgment',
    'trait_speed', 'trait_size', 'trait_aggression', 'trait_fertility', 'trait_perception',
  ];
  for (const l of langs) {
    const gaps = wanted.filter((k) => !l.keys.has(k));
    assert.deepEqual(gaps, [], `${l.code} is missing the paid-action copy: ${gaps.join(', ')}`);
  }
});

test('the prices in the markup are the prices the server charges', () => {
  // The buttons are re-priced from /state on the first poll, but the markup is
  // what shows before that poll lands — so a stale number here is a price the
  // site states out loud and then does not honour.
  const html = readFileSync(fileURLToPath(new URL('../index.html', import.meta.url)), 'utf8');
  const payments = readFileSync(
    fileURLToPath(new URL('../../server/src/payments.ts', import.meta.url)),
    'utf8',
  );
  const at = payments.indexOf('export const ABYS_PRICES');
  const block = payments.slice(at, payments.indexOf('};', at));
  const prices = new Map([...block.matchAll(/(\w+): '(\d+)'/g)].map((m) => [m[1], m[2]]));
  assert.ok(prices.size >= 9, `expected the whole price list, read ${prices.size} entries`);
  const shown = [...html.matchAll(/<button class="iv" data-type="(\w+)">.*?class="price">(\d+) ABYS</g)];
  assert.equal(shown.length, prices.size, 'every priced action has a button, and no button is unpriced');
  for (const [, type, amount] of shown) {
    assert.equal(amount, prices.get(type), `the ${type} button advertises ${amount} ABYS but the server charges ${prices.get(type)}`);
  }
});
