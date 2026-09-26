/**
 * The jsdom stage both render tests stand on.
 *
 * `app.js` is a module with side effects: it reads the address bar, the watch
 * list and every endpoint once, at import time. That is exactly what a deep link
 * needs tested — *what does opening this URL do?* — and it cannot be asked of a
 * single boot, because the answer depends on the URL the page was created with.
 * So the stage is a function rather than a file header, and each test file boots
 * the one page its assertions are about. `node --test` gives every file its own
 * process, so the `globalThis` plumbing below does not leak between them.
 *
 * The canvas bridge is the other half of the stage. Without it every `draw` call
 * is a no-op on a 300x150 element and a blank tank looks identical to a painted
 * one; with `@napi-rs/canvas` behind it, pixels are evidence.
 */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

let jsdomMod;
let canvasMod;
try {
  jsdomMod = await import('jsdom');
  canvasMod = await import('@napi-rs/canvas');
} catch {
  jsdomMod = null;
}

export const RENDER_DEPS_MISSING = !jsdomMod;

const { JSDOM, VirtualConsole } = jsdomMod ?? {};
const { createCanvas } = canvasMod ?? {};

export const root = fileURLToPath(new URL('..', import.meta.url));

export const CREATURES = [0, 1, 2, 3, 4, 5].map((i) => ({
  id: 100 + i,
  name: `MOBY-${100 + i}`,
  x: 200 + i * 90,
  y: 180 + (i % 3) * 160,
  energy: 60 + i * 12,
  hue: (i * 0.13) % 1,
  sat: 0.7,
  light: 0.55,
  archetype: ['WHALE', 'ALGO', 'APE', 'INSIDER'][i % 4],
  radius: 6 + (i % 3) * 3,
  kills: i,
  devouredTotal: i * 30,
  generation: 3,
  bornTick: 10,
  genes: [0.4, 0.8, 0.2, 0.6],
  hungry: i % 2 === 0,
  offspring: 1,
  maxMeal: 30,
  persona: 21,
  parentId: null,
}));

export const snapshot = {
  world: {
    tick: 4000,
    t: Date.now(),
    width: 1000,
    height: 1000,
    whales: [],
    eaters: {},
    obituaries: [],
    tax: null,
    propositions: [],
    daily: null,
    burners: [],
    cheers: {},
    chainTemp: 0.6,
    marketTemp: 0.4,
    creatures: CREATURES,
    foods: [{ x: 300, y: 300 }, { x: 620, y: 520 }],
  },
  state: {
    tick: 4000,
    day: 4,
    population: 6,
    ticksPerDay: 19200,
    // Deliberately not the value `app.js` initialises with. A fixture that
    // repeats the default cannot tell whether the page used the server's base or
    // its own, and "every link in the tank points where the API said to" is a
    // rule that has to be checkable from the outside.
    explorerTxUrl: 'https://arc-exp.test/tx/',
    activeEffects: [],
    leaderboards: { predators: [], richest: [], elders: [] },
  },
  events: [],
  txRain: [],
};

/**
 * The day book as `/history/census` publishes it. Three details are load-bearing:
 * day 3 is absent, which the chart must leave blank rather than bridge; day 4
 * counts a species the browser's archetype list has never heard of, which is what
 * the grey band exists for; and only some rows carry a `txHash`, because the
 * difference between "this day was confirmed on chain" and "this day was not" is
 * the one thing the pinned-day sentence has to get right. `changes` is what the
 * server derives from these rows; the numbers below are that derivation, written
 * out rather than recomputed here so a mistake in the fixture cannot agree with a
 * mistake in the code under test.
 */
export const censusRow = (day, byArchetype, txHash) => ({
  day,
  tick: day * 19200,
  population: Object.values(byArchetype).reduce((s, n) => s + n, 0),
  totalEnergy: 300 + day * 10,
  born: 100 + day * 7,
  died: 40 + day * 5,
  predations: 12 + day * 3,
  topPredator: 'APE:7',
  // The rule this row's hash was made under, written as `1` and not looked up
  // from anywhere: the browser never reads it, so the only thing it can be here
  // is a faithful copy of what the server puts on the wire.
  v: 1,
  byArchetype,
  hash: 'ab'.repeat(32),
  ts: 1700000000000 + day * 86400000,
  // Distinct per day on purpose: a link built from the wrong row's hash still
  // looks like a link.
  ...(txHash ? { txHash } : {}),
});

export const census = {
  // Mirrors the server's derived cap (128 KiB over a measured row width of 345
  // bytes for a stamped row). Written out rather than imported because the browser
  // has no access to the module that computes it, and nothing on this side reads it.
  cap: 379,
  book: 4,
  coverage: { first: 0, last: 4, days: 4 },
  hashed: ['v', 'day', 'tick', 'population', 'totalEnergy', 'born', 'died', 'predations', 'topPredator'],
  // Every rule the server can check, keyed by the `v` a row names — the same table
  // the route publishes, so a fixture that drifts from the wire is a test that
  // stops meaning anything.
  rules: { 1: ['v', 'day', 'tick', 'population', 'totalEnergy', 'born', 'died', 'predations', 'topPredator'] },
  rows: [
    censusRow(0, { APE: 2, WHALE: 1, ALGO: 1, INSIDER: 1 }, `0x${'cc'.repeat(32)}`),
    censusRow(1, { APE: 3, WHALE: 1, ALGO: 1, INSIDER: 1 }),
    censusRow(2, { APE: 3, WHALE: 2, ALGO: 1 }),
    censusRow(4, { APE: 2, WHALE: 2, ALGO: 1, CRAB: 1 }, `0x${'dd'.repeat(32)}`),
  ],
  changes: [
    { day: 1, tick: 19200, population: 6, populationDelta: 1, born: 7, died: 5, predations: 3, lost: [], gained: [] },
    { day: 2, tick: 38400, population: 6, populationDelta: 0, born: 7, died: 5, predations: 3, lost: ['INSIDER'], gained: [] },
    { day: 4, tick: 76800, population: 6, populationDelta: 0, born: 14, died: 10, predations: 6, lost: [], gained: ['CRAB'] },
  ],
  // The live reading, shaped the way the route shapes it. Measured off
  // `https://www.abyssal-arc.com/history/census` on 2026-09-24: `today` carries the
  // eight hashed stats, the headcount and `committed`, and nothing that belongs to a
  // commitment — no `hash`, no `ts`, no `v`, because nothing was committed and a row
  // cannot name a rule for a number it never made. `censusRow` builds a *stored* row,
  // so the three fields the route withholds are taken back out here instead of being
  // left on the fixture for the client to invent a meaning for.
  today: (() => {
    const { hash: _hash, ts: _ts, v: _v, ...reading } = censusRow(4, { APE: 2, WHALE: 2, ALGO: 1, CRAB: 1 });
    return { ...reading, committed: false };
  })(),
};

/**
 * `/observe` with the Arc feed live, shaped like the real endpoint: the same keys
 * in the same order of richness, with round synthetic numbers of our own rather
 * than someone's window off the wire. Two of them are read by name: `available`,
 * which is what makes the boot probe *able* to move the visitor (the thing the
 * `urlNamedView` guard exists to prevent), and the `stats.transfers` /
 * `venueCoverage` pair, which is what the rails panel's coverage sentences are
 * checked against in `test/observe-boot.test.js`.
 */
export const FLOW_ADDR = '0x' + 'f6'.repeat(20);

export const observe = {
  available: true,
  network: 'arc',
  chainId: 5042,
  usdc: '0x3600000000000000000000000000000000000000',
  lastBlock: 22404881,
  windowSeconds: 300,
  stats: { transfers: 900, volume: 54000, x402Count: 45, resolved: 900, x402Share: 0.05 },
  endpoints: [
    { address: '0x' + 'a1'.repeat(20), volume: 1200, count: 12, x402: 0 },
    { address: '0x' + 'b2'.repeat(20), volume: 640, count: 6, x402: 3 },
  ],
  venues: [
    { kind: 'x402', count: 20, volume: 20 },
    { kind: 'swap', count: 80, volume: 3000 },
  ],
  venueRows: [
    { kind: 'swap', label: '0x' + 'c3'.repeat(20), address: '0x' + 'c3'.repeat(20), count: 80, volume: 2000 },
    { kind: 'x402', label: '0x' + 'd4'.repeat(20), address: '0x' + 'd4'.repeat(20), count: 20, volume: 20 },
  ],
  /**
   * Both shortfalls at once, and arithmetically closed: the ring held 150 of the
   * window's 900 transfers (`unseen` 750) and read no destination for 50 of those
   * (`attributed` 100, which is what the rails above add up to). One boot can show
   * one payload, so this one shows both sentences — otherwise the wiring test
   * passes with either of them deleted.
   */
  venueCoverage: { windowFlows: 150, attributed: 100, unattributed: 50, windowTransfers: 900, unseen: 750 },
  pulse: [
    { t: 1790144250000, count: 120, volume: 9000, x402: 3, resolved: 120 },
    { t: 1790144550000, count: 90, volume: 7000, x402: 2, resolved: 90 },
  ],
  flows: [
    {
      t: 1790195675316,
      block: 22404771,
      tx: '0x' + '76'.repeat(32),
      from: '0x' + 'e5'.repeat(20),
      to: FLOW_ADDR,
      amount: 12,
      venue: 'swap',
      x402: false,
    },
  ],
};

/**
 * The address a test "connects" a wallet with, and the `/who` answer the fixture
 * server gives for it. Written out rather than produced by `standingSeed`: a
 * baseline built by the code under test would agree with that code no matter how
 * both were wrong.
 */
export const ME_ADDR = '0x' + '11'.repeat(20);

export const whoFixture = (over = {}) => ({
  address: ME_ADDR,
  known: true,
  burned: 100,
  burns: 4,
  byType: { poison: 4 },
  maxAffected: 3,
  pass: { active: true, until: 38400 },
  badges: ['firstBurn'],
  cheer: null,
  adoptions: [{ id: 7, name: 'MOBY-7', archetype: 'APE', alive: true }],
  rank: 3,
  reports: [{ tx: '0xaa', type: 'poison', atTick: 900, affected: 3, score: 12 }],
  ...over,
});

/**
 * `/observe?addr=` answers with a different shape than `/observe`: one address's
 * own window — `stats.inVolume`/`outVolume`/`count`/`x402` — instead of the
 * network's totals. A fixture that served the window payload for both would be a
 * fixture that lies: `openAddrCard` reads those fields without a guard, so the
 * card throws half-built, `applyFocus` never reaches its final repaint, and under
 * `node --test` the rejection takes the process with it. Which is what happened
 * the first time this file served an address request.
 */
const addressPayload = (addr) => {
  const a = addr.toLowerCase();
  const flows = observe.flows.filter((f) => f.from === a || f.to === a);
  let inVolume = 0;
  let outVolume = 0;
  let x402 = 0;
  for (const f of flows) {
    if (f.to === a) inVolume += f.amount;
    if (f.from === a) outVolume += f.amount;
    if (f.x402) x402++;
  }
  return { available: true, address: a, windowSeconds: 300, stats: { count: flows.length, inVolume, outVolume, x402 }, flows };
};

/**
 * Boot one page against one in-process server.
 *
 * @param {object} [opts]
 * @param {string} [opts.focusSearch] the query string the page is opened with, e.g. `?view=world&day=2`
 * @param {boolean} [opts.observeLive] whether `/observe` reports the Arc feed as live
 * @param {object} [opts.who] the `/who` answer to serve, or null for "nobody known"
 * @param {string} [opts.wallet] an address a connected wallet reports as its own
 * @param {object} [opts.standing] a previous `/who` row already in this browser's memory
 * @param {object|null} [opts.digestChain] the anchor record to put in `/snapshot`'s state;
 *   absent leaves the fixture as the other tests expect it, `null` is "no record"
 * @returns the page, its canvases, what it asked the server for, what the visitor
 *   copied, and a `close()` that has to be called or the process never exits
 */
let stageTaken = false;

export async function boot({ focusSearch = '', observeLive = false, who = null, wallet = null, standing = null, book = null, worldSince = null, digestChain } = {}) {
  // One page per process, and the reason is measured rather than suspected:
  // `app.js` is evaluated once and the ESM cache never evaluates it again, so a
  // second `boot()` hands back a DOM nothing is driving. Checked on this harness —
  // the second stage's server was asked for the day book 0 times while the first
  // was asked once, every element sat in its initial state, and `pageErrors` and
  // `renderThrows` were both empty, so nothing said so. A test built on that stage
  // fails as "the feature is broken"; the throw says what actually happened.
  if (stageTaken) throw new Error('boot() already ran in this process — one page per test file');
  stageTaken = true;
  const served = book ?? census;
  // The anchor chip reads `state.digestChain`, which the shared fixture leaves off
  // because nothing else on the page looks at it. `undefined` means "this test is
  // not about the chip" and must not start serving a `digestChain` key; an
  // explicit `null` means "the server has no record", which is a state worth
  // booting on purpose.
  const servedSnapshot = digestChain === undefined
    ? snapshot
    : { ...snapshot, state: { ...snapshot.state, digestChain } };
  const reqs = { census: 0, observe: 0 };
  const server = createServer((req, res) => {
    const path = req.url?.split('?')[0] ?? '/';
    res.setHeader('content-type', 'application/json');
    if (path === '/snapshot') res.end(JSON.stringify(servedSnapshot));
    else if (path === '/history') res.end(JSON.stringify({ stats: [] }));
    else if (path === '/history/census') { reqs.census++; res.end(JSON.stringify(served)); }
    else if (path === '/judgments') res.end(JSON.stringify({ judgments: [] }));
    else if (path === '/reports') res.end(JSON.stringify({ reports: [] }));
    else if (path === '/who') res.end(JSON.stringify(who ?? {}));
    else if (path === '/observe') {
      reqs.observe++;
      const addr = new URLSearchParams(req.url?.split('?')[1] ?? '').get('addr');
      if (!observeLive) res.end(JSON.stringify({ available: false }));
      else res.end(JSON.stringify(addr ? addressPayload(addr) : observe));
    } else res.end(JSON.stringify({}));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/${focusSearch}`;

  const html = readFileSync(root + 'index.html', 'utf8');
  const vc = new VirtualConsole();
  const pageErrors = [];
  vc.on('jsdomError', (e) => pageErrors.push(String(e.stack ?? e)));
  const dom = new JSDOM(html, { url: base, virtualConsole: vc });
  const { window } = dom;

  const backing = new Map();
  const canvasFor = (el) => {
    let c = backing.get(el);
    if (!c) {
      c = createCanvas(2400, 1600);
      backing.set(el, c);
    }
    return c;
  };
  window.HTMLCanvasElement.prototype.getContext = function () {
    return canvasFor(this).getContext('2d');
  };
  for (const prop of ['width', 'height']) {
    Object.defineProperty(window.HTMLCanvasElement.prototype, prop, {
      get() { return this['__' + prop] ?? 300; },
      set(v) { this['__' + prop] = v; },
      configurable: true,
    });
  }
  const origCreate = window.document.createElement.bind(window.document);
  window.document.createElement = (tag, ...rest) =>
    (tag === 'canvas' ? createCanvas(2, 2) : origCreate(tag, ...rest));

  const rafQ = [];
  window.requestAnimationFrame = (cb) => rafQ.push(cb);
  window.cancelAnimationFrame = () => {};
  const nodeFetch = globalThis.fetch;
  window.fetch = (u, o) => nodeFetch(new URL(u, base), o);

  // The app owns polling intervals on the node loop; remember them so the test
  // process can exit once the assertions are done.
  const timerIds = [];
  const origSetInterval = globalThis.setInterval;
  const origSetTimeout = globalThis.setTimeout;
  globalThis.setInterval = (...a) => {
    const id = origSetInterval(...a);
    timerIds.push(id);
    return id;
  };
  globalThis.setTimeout = (...a) => {
    const id = origSetTimeout(...a);
    timerIds.push(id);
    return id;
  };

  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.localStorage = window.localStorage;
  // One watched animal, so the following list has a row the tests can click: it is
  // the cheapest path into `renderCard` that a visitor also has.
  window.localStorage.setItem('abyssal-watch', '[101]');
  globalThis.fetch = window.fetch;
  globalThis.requestAnimationFrame = window.requestAnimationFrame;
  globalThis.cancelAnimationFrame = window.cancelAnimationFrame;
  globalThis.CustomEvent = window.CustomEvent;
  globalThis.Event = window.Event;
  Object.defineProperty(window, 'innerWidth', { value: 1200, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: 700, configurable: true });

  const renderThrows = [];
  window.addEventListener('error', (e) => renderThrows.push(String(e.error?.stack ?? e.message)));
  // A rejected promise is neither of the two channels above. jsdom's virtual console
  // reports exceptions raised inside scripts it ran, and `window.onerror` reports
  // ErrorEvents — a rejection in a promise chain that started in the window and
  // settled on Node's microtask queue reaches neither. Measured with a page that
  // rejects 150ms into its boot: both arrays empty, `boot()` resolved, and the only
  // witness was the test runner, which aborted the test and left the page open.
  process.on('unhandledRejection', (err) => pageErrors.push(`unhandled rejection: ${String(err?.stack ?? err)}`));

  // The Clipboard API is missing outright in jsdom, and `copyText` treats a
  // missing API as a failure — which is the right product behaviour but would
  // leave the copied string unobservable. Stub the API the way a secure context
  // has it, so a test can read exactly what the button put on the clipboard.
  const copied = [];
  Object.defineProperty(window.navigator, 'clipboard', {
    configurable: true,
    value: { writeText: (text) => { copied.push(text); return Promise.resolve(); } },
  });

  // A wallet that answers `eth_accounts` without prompting is exactly what a
  // visitor who has connected before has; `resolveMe` reads this and nothing else.
  if (wallet) window.ethereum = { request: async ({ method }) => (method === 'eth_accounts' ? [wallet] : []) };
  // Somebody else's browser starts empty; this one may already remember an answer.
  if (standing) window.localStorage.setItem(`abyssal-standing:${standing.address}`, JSON.stringify(standing));
  // The world's memory has no address to key on — one browser, one last look at the
  // book — and a test that seeds it is claiming this device saw an earlier window.
  if (worldSince) window.localStorage.setItem('abyssal-worldsince', JSON.stringify(worldSince));

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  await import(root + 'app.js');
  await sleep(1200);

  // A page that threw while it was coming up is closed here and the error is thrown
  // instead, because a leaked page is not a failed test — it is a hung one. The
  // sequence, measured with a boot that rejects at 150ms: the runner attributes the
  // rejection to the test that is running and aborts it there, which is before
  // `boot()` returns at 1200ms, so the caller never reaches the line after it that
  // registers `t.after(() => page.close())`; the server and its sockets then hold the
  // file's process open until something external kills it (measured: 60s with a
  // per-test bound on it, and 240s until the battery's own child wall clock killed
  // the run and left no verdict, for a failure whose stack had already been printed
  // 1600 times sooner). Closing here releases it: the same mutant went to 1.79s and
  // one red test naming the line that threw.
  const thrown = [...pageErrors, ...renderThrows];
  if (thrown.length) {
    for (const id of timerIds) { clearInterval(id); clearTimeout(id); }
    server.close();
    server.closeAllConnections?.();
    throw new Error(`the page threw while booting:\n${thrown.join('\n')}`);
  }

  return {
    window,
    document: window.document,
    base,
    canvasFor,
    rafQ,
    pageErrors,
    renderThrows,
    reqs,
    copied,
    sleep,
    close() {
      for (const id of timerIds) {
        clearInterval(id);
        clearTimeout(id);
      }
      server.close();
      server.closeAllConnections?.();
    },
  };
}
