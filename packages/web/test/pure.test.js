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
