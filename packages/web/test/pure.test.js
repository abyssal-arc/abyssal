import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
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

test('every observe card in the markup has a desktop flex rule of its own', () => {
  // The rails card shipped without one. In a flex column a card with no rule
  // falls back to `flex: 0 1 auto`, sizes itself to its content — twelve rows
  // plus a chip per rail — and leaves nothing for the `flex: 1 1 0` sibling below
  // it, whose `min-height: 0` then lets it collapse to zero. Top endpoints did
  // not look short, it looked deleted. Nothing else could have caught it: jsdom
  // does no layout, so every clientHeight in the render smoke test is 0, and the
  // payload was fine — the rows were in the response, just drawn nowhere.
  const html = readFileSync(fileURLToPath(new URL('../index.html', import.meta.url)), 'utf8');
  const css = readFileSync(fileURLToPath(new URL('../style.css', import.meta.url)), 'utf8');
  const used = [...new Set([...html.matchAll(/obs-card\s+(obs-[a-z-]+-card)/g)].map((m) => m[1]))];
  assert.equal(used.length, 5, `the markup names five observe cards, read ${used.join(', ')}`);

  // Only the desktop section counts. The phone media query resets all of them to
  // `flex: 0 0 auto`, so reading the whole file would let an override satisfy a
  // test about the rule it overrides.
  const from = css.indexOf('/* ---------- observe view layout ---------- */');
  assert.ok(from >= 0, 'the observe layout section is where these rules live');
  const desktop = css.slice(from, css.indexOf('@media', from));
  const missing = used.filter((c) => !new RegExp(`\\.${c}\\s*\\{[^}]*flex:`).test(desktop));
  assert.deepEqual(missing, [], 'a card with no flex rule sizes to its content and starves its siblings');

  // And the panel a viewer would notice going missing holds a floor rather than
  // only a share, because a share can still be outvoted by the card above it
  // growing.
  assert.match(
    desktop,
    /\.obs-endpoints-card\s*\{[^}]*min-height:\s*calc/,
    'top endpoints keeps a minimum height so a taller neighbour cannot squeeze it out',
  );
});

test('a pulse bar names the time it covers, not the number of buckets in it', () => {
  // Lifted out of app.js and evaluated on its own: app.js touches `document` at
  // module scope, and this is a pure function of an array, so the honest way to
  // test it is to cut it out rather than to boot a DOM for it.
  const src = readFileSync(fileURLToPath(new URL('../app.js', import.meta.url)), 'utf8');
  const at = src.indexOf('function computePulseBars');
  assert.ok(at >= 0, 'the grouping function is where this test expects it');
  const body = src.slice(at, src.indexOf('\n}', at) + 2);
  const computePulseBars = new Function(`${body}; return computePulseBars;`)();

  // 192 buckets a minute apart: the shape a feed only its cron is polling
  // produces, one bucket per fire, keyed to a 15s boundary but 60s from its
  // neighbour. Grouped two to a bar, a bar covers 75 seconds — the minute
  // between the two buckets plus the last one's own width.
  const pts = Array.from({ length: 192 }, (_, i) => ({
    t: i * 60_000, volume: 1, count: 1, x402: 0, resolved: 1,
  }));
  const bars = computePulseBars(pts);
  assert.equal(bars.length, 96, 'grouped down to the display resolution');
  assert.equal(
    bars[0].span,
    75,
    'counting slots would have said 30, and the right-hand axis label — which is `t + span` — is the one place that number is ever read out loud',
  );
  const last = bars[bars.length - 1];
  assert.equal(
    last.t + last.span * 1000,
    pts[pts.length - 1].t + 15_000,
    'the window the chart claims to end at is where the last bucket actually ends',
  );
});

test('pulse columns keep their rhythm on a short series and never become slabs', () => {
  // The width formula sits inside drawPulse, which needs a canvas, so it is read
  // out of the source and evaluated on its own two inputs rather than booted up.
  const src = readFileSync(fileURLToPath(new URL('../app.js', import.meta.url)), 'utf8');
  const m = src.match(/const barW = ([^\n]+);/);
  assert.ok(m, 'the bar width is computed once, on a line of its own');
  const barW = new Function('bw', 'w', `return ${m[1]};`);

  // The bug this guards is that a ceiling in absolute pixels cannot express a
  // rhythm that is proportional. A flat 12px binds whenever a column gets more
  // than about 12 / 0.62 = 19px of slot, so the fill it leaves depends on the
  // canvas as much as on the series: eight columns is a 16% fill on a 600px
  // canvas and a 6% one on a 1600px canvas, where the same bars are still 12px
  // and only the gaps grew. Asserted at both widths, because a single width
  // would pass a ceiling that merely happened to be tuned for it.
  for (const W of [600, 1600]) {
    const fill = (n) => barW(W / n, W) / (W / n);
    assert.ok(
      fill(8) > 0.55,
      `eight columns in a ${W}px canvas must still fill their slots; got ${(fill(8) * 100).toFixed(0)}%`,
    );
    // The ceiling earns its place at the counts where 62% would be absurd.
    assert.ok(
      barW(W, W) < W * 0.2,
      `a single bucket in a ${W}px canvas is a column, not the whole canvas`,
    );
    // Hairline floor: a day of 15s slots downsamples to hundreds of columns, and
    // a sub-pixel bar disappears against the grid rather than reading as quiet.
    for (const n of [1, 8, 96, 420]) {
      assert.ok(barW(W / n, W) >= 2, `${n} columns in a ${W}px canvas still draw something visible`);
    }
  }
});

test('the asset filter hides the development files and nothing the client loads', () => {
  // wrangler.toml points `[assets] directory` at this package root, so every file
  // here is downloadable from the live site — including `test/` and the workspace
  // manifest. `.assetsignore` is what drops them at upload time. The failure this
  // guards is the expensive direction: a pattern that also matches a file the
  // browser needs turns the site into a blank page with a JSON 404 behind it,
  // which no other test here can see, because the render smoke test imports the
  // modules from disk and never asks the asset router about them.
  const root = new URL('../', import.meta.url);
  const patterns = readFileSync(fileURLToPath(new URL('.assetsignore', root)), 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));

  // Gitignore semantics, reduced to the three shapes this file is allowed to use.
  const ignored = (rel) => {
    const p = `/${rel}`;
    return patterns.some((pat) => (
      pat.endsWith('/') ? p.startsWith(pat)
        : pat.startsWith('/') ? p === pat
          : p === `/${pat}` || p.endsWith(`/${pat}`)
    ));
  };

  // Everything the entry point reaches: markup attributes first, then the ES
  // module graph, transitively, so a file that only app.js imports is covered.
  const local = (href) => href && !/^(https?:|data:|#|\/\/)/.test(href) ? href.replace(/^\//, '') : null;
  const seen = new Set();
  const queue = ['index.html'];
  while (queue.length) {
    const rel = queue.pop();
    if (seen.has(rel)) continue;
    seen.add(rel);
    const src = readFileSync(fileURLToPath(new URL(rel, root)), 'utf8');
    const refs = rel.endsWith('.html')
      ? [...src.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1])
      : [...src.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
    for (const ref of refs) {
      const path = local(ref);
      if (path === null) continue;
      const resolved = path.startsWith('./') ? path.slice(2) : path;
      queue.push(resolved);
    }
  }

  const reached = [...seen].filter((r) => r !== 'index.html');
  assert.ok(
    reached.includes('src/geom.js') && reached.includes('src/format.js') && reached.includes('app.js'),
    `the walk found the modules app.js imports, read ${reached.join(', ')}`,
  );
  const dropped = reached.filter(ignored);
  assert.deepEqual(dropped, [], `${dropped.join(', ')} is loaded by the client but excluded from the upload`);

  // And the filter has to actually be doing something: an emptied file passes
  // every assertion above by ignoring nothing.
  for (const dev of ['test/pure.test.js', 'test/render.test.js', 'test/harness.js', 'package.json']) {
    assert.ok(ignored(dev), `${dev} is development-only and should not be served`);
  }
});

test('the preview card the tags promise is the file on disk', () => {
  // Crawlers do not run JavaScript, so `og:image` is the only thing a visitor who
  // has not opened the site ever sees. Two independent failures hide here: the tags
  // can name a file that is not there, and the file can stop being what the tags
  // describe — a resized export, a placeholder, or a PNG whose declared dimensions
  // were left at the old numbers. Nothing else in the suite looks at a byte of it,
  // because no test asks the asset router what `/` is serving.
  const root = new URL('../', import.meta.url);
  const html = readFileSync(fileURLToPath(new URL('index.html', root)), 'utf8');
  const tag = (prop) => html.match(new RegExp(`<meta (?:property|name)="${prop}" content="([^"]*)"`))?.[1];

  const image = tag('og:image');
  assert.ok(image, 'index.html declares no og:image');
  // Absolute, because a relative one is silently dropped by some crawlers — and
  // pinned to the canonical host, since a link-local URL would be a preview card
  // that only works on the machine that rendered it.
  const url = new URL(image);
  assert.equal(url.origin, 'https://www.abyssal-arc.com', `og:image points at ${url.origin}`);
  assert.equal(url.pathname, '/assets/og.png');
  assert.equal(tag('og:url'), 'https://www.abyssal-arc.com/');
  assert.equal(tag('twitter:card'), 'summary_large_image');

  const png = readFileSync(fileURLToPath(new URL(`.${url.pathname}`, root)));
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'og.png is not a PNG');
  // IHDR is the first chunk: 4 length, 4 type, then width and height as big-endian.
  assert.equal(png.subarray(12, 16).toString(), 'IHDR', 'the PNG does not open with its header');
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  assert.equal(tag('og:image:width'), String(width), 'the tag declares a width the file does not have');
  assert.equal(tag('og:image:height'), String(height), 'the tag declares a height the file does not have');
  // `summary_large_image` wants roughly 1.91:1; the canonical 1200x630 is 1.905.
  assert.ok(Math.abs(width / height - 1.91) < 0.02, `${width}x${height} is not a large-card ratio`);
  assert.ok(png.length > 20_000, `og.png is ${png.length} bytes, which is a placeholder, not a card`);
});

test('every test file on disk is in the list the runner is told to run', () => {
  // `npm test -w @abyssal/web` names its files instead of globbing, because a bare
  // `node --test` treats everything under `test/` as a case — including
  // `harness.js`, which is the stage the render tests stand on and not a test of
  // its own. That is the right trade, and it has exactly one cost: a file that is
  // never named is never run, and nothing in the build says so. A test written and
  // never executed is worse than no test, because it reads like coverage.
  const root = new URL('..', import.meta.url);
  const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('package.json', root)), 'utf8'));
  const named = new Set(String(pkg.scripts.test).split(/\s+/).filter((a) => a.endsWith('.test.js')));
  const onDisk = readdirSync(fileURLToPath(new URL('test', root))).filter((f) => f.endsWith('.test.js'));
  assert.ok(onDisk.length > 5, `${onDisk.length} test files found, which says the scan is looking in the wrong place`);
  for (const file of onDisk) assert.ok(named.has(`test/${file}`), `${file} exists and is never run`);
  for (const entry of named) {
    assert.ok(onDisk.includes(entry.replace('test/', '')), `${entry} is in the run list and not on disk`);
  }
});

test('every client source file is in the syntax gate CI runs', () => {
  // The same failure in the other direction, one directory over. CI parses each
  // client file as ESM by name, and a name nobody wrote down is a file that can
  // carry a syntax error to a browser: `npm test` boots the page index.html loads,
  // so a module the page does not import yet is never parsed by anything at all.
  const root = new URL('..', import.meta.url);
  const ci = readFileSync(fileURLToPath(new URL('../../.github/workflows/ci.yml', root)), 'utf8');
  const gated = new Set([...ci.matchAll(/node --input-type=module --check < (\S+)/g)].map((m) => m[1]));
  assert.ok(gated.size > 5, `${gated.size} files in the gate, which says the scan is looking in the wrong place`);
  const onDisk = [
    'packages/web/app.js',
    'packages/web/i18n.js',
    ...readdirSync(fileURLToPath(new URL('src', root))).map((f) => `packages/web/src/${f}`),
  ].filter((f) => f.endsWith('.js'));
  for (const file of onDisk) assert.ok(gated.has(file), `${file} is shipped to the browser and never parsed by CI`);
  for (const file of gated) assert.ok(onDisk.includes(file), `${file} is in the gate and not on disk`);
});
