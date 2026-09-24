/**
 * The rules about what a link may say, checked without a browser.
 *
 * Each test is one of the decisions listed at the top of `src/deeplink.js`; the
 * comments name the mistake each one is guarding, because the mistake is the
 * point. Run by `npm test -w @abyssal/web`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DRAWERS, VIEWS, focusUrl, parseFocus, serializeFocus } from '../src/deeplink.js';

const ADDR = '0x1234aBcd567890123456789012345678901234Ab';

test('a link that names everything comes back as everything named', () => {
  const f = parseFocus('?view=observe&creature=42&addr=0x1234abcd567890123456789012345678901234ab&day=7&drawer=analytics');
  assert.deepEqual(f, { view: 'observe', creature: 42, addr: '0x1234abcd567890123456789012345678901234ab', day: 7, drawer: 'analytics' });
  // The value types are the interface's: `day` is a number, not a string, or
  // every comparison against a row's day silently fails on `'7' !== 7`.
  assert.equal(typeof f.creature, 'number');
  assert.equal(typeof f.day, 'number');
});

test('a bad word in one key does not throw the other keys away', () => {
  assert.deepEqual(parseFocus('?view=tank&creature=-3&addr=zz&day=1.5&drawer=bogus'), {}, 'none of these is a state');
  assert.deepEqual(
    parseFocus('?view=tank&creature=42&day=x'),
    { creature: 42 },
    'the typo is dropped and what it did not touch survives',
  );
  assert.deepEqual(parseFocus(''), {}, 'an empty bar is a focus with nothing in it');
  assert.deepEqual(parseFocus('#frag'), {}, 'a fragment is not a focus');
});

test('an address is 40 hex, and its case is not part of its identity', () => {
  assert.equal(parseFocus(`?addr=${ADDR}`).addr, ADDR.toLowerCase(), 'what comes out is lowercase, like what goes in');
  // Each of these is a real string someone pastes. Accepted sloppily, one of them
  // becomes a card for an address nobody typed.
  for (const bad of [ADDR.slice(0, -1), `${ADDR}0`, ADDR.slice(2), ADDR.toUpperCase(), '0x'.concat('g'.repeat(40)), '']) {
    assert.deepEqual(parseFocus(`?addr=${bad}`), {}, `not an address: ${JSON.stringify(bad)}`);
  }
});

test('numbers are non-negative integers, and only those', () => {
  assert.equal(parseFocus('?day=0').day, 0, 'day zero is a day');
  assert.deepEqual(parseFocus('?creature=0').creature, 0, 'id zero is a number, and the tank decides if it exists');
  for (const bad of ['-1', '1.5', '1e3', '007', ' 7', '7 ', 'NaN', '9007199254740993']) {
    assert.deepEqual(parseFocus(`?day=${bad}`), {}, `not a day: ${JSON.stringify(bad)}`);
    assert.deepEqual(parseFocus(`?creature=${bad}`), {}, `not an id: ${JSON.stringify(bad)}`);
  }
});

test('only the views and drawers that exist can be opened', () => {
  for (const v of VIEWS) assert.equal(parseFocus(`?view=${v}`).view, v);
  for (const d of DRAWERS) assert.equal(parseFocus(`?drawer=${d}`).drawer, d);
  // The two vocabularies do not overlap, and neither accepts the other's words:
  // `?view=mem` is a person who got the key wrong, not a request to look at the
  // tank through the memorials drawer.
  assert.deepEqual(parseFocus('?view=mem'), {}, 'a drawer name is not a view');
  assert.deepEqual(parseFocus('?drawer=observe'), {}, 'a view name is not a drawer');
  assert.deepEqual(parseFocus('?view='), {}, 'a key with nothing after it is not a value');
});

test('the written link is in one order, whoever wrote it', () => {
  const full = { day: 7, drawer: 'you', addr: ADDR, view: 'observe', creature: 42 };
  assert.equal(
    serializeFocus(full),
    '?view=observe&creature=42&addr=0x1234abcd567890123456789012345678901234ab&day=7&drawer=you',
  );
  // Two tabs holding the same state must produce the same bytes, or "copy the bar"
  // and "click copy link" disagree in front of the user.
  assert.equal(serializeFocus({ ...full }), serializeFocus(full));
  assert.equal(serializeFocus({}), '');
  assert.equal(serializeFocus(null), '', 'a focus nobody built is an empty query, not a crash');
});

test('what is written is what is read, for every key', () => {
  const cases = [
    { view: 'world' },
    { view: 'world', creature: 42 },
    { view: 'observe', addr: ADDR.toLowerCase() },
    { view: 'observe', day: 0, drawer: 'mem' },
    { view: 'world', day: 399, drawer: 'analytics', creature: 7, addr: ADDR.toLowerCase() },
  ];
  for (const f of cases) assert.deepEqual(parseFocus(serializeFocus(f)), f, `round trip of ${JSON.stringify(f)}`);
});

test('the tank is named in the link, not left to the site to guess', () => {
  // The whole reason `view` is never treated as a default: a bare URL lets the
  // boot probe land a returning visitor on OBSERVE, so a link copied while looking
  // at the tank and written as `?` would open something else.
  assert.equal(serializeFocus({ view: 'world' }), '?view=world');
  assert.equal(parseFocus(serializeFocus({ view: 'world' })).view, 'world');
});

test('the copied link and the address bar are the same string', () => {
  const base = 'https://www.abyssal-arc.com/index.html?utm_source=x#frag';
  const f = { view: 'observe', addr: ADDR.toLowerCase() };
  assert.equal(focusUrl(base, f), `https://www.abyssal-arc.com/index.html${serializeFocus(f)}`);
  assert.ok(!focusUrl(base, f).includes('frag'), 'the fragment goes');
  assert.ok(!focusUrl(base, f).includes('utm_source'), 'and so does whatever else was in the bar');
  assert.deepEqual(parseFocus(new URL(focusUrl(base, f)).search), f, 'opening the link gives back the state');
});
