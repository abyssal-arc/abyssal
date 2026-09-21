/**
 * Render smoke test: boots the real app.js in jsdom with a node-canvas bridge,
 * feeds it a fixture snapshot from an in-process server, pumps a few animation
 * frames and fails if the render loop throws or paints an empty tank.
 *
 * This is the guard for the class of bug a hidden tab cannot show: a missing
 * constant or a bad draw call blanks the whole tank while every endpoint stays
 * healthy. Skips itself when the optional render deps are not installed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

let jsdomMod;
let canvasMod;
try {
  jsdomMod = await import('jsdom');
  canvasMod = await import('@napi-rs/canvas');
} catch {
  test('render smoke', { skip: 'jsdom / @napi-rs/canvas not installed' }, () => {});
  process.exit(0);
}
const { JSDOM, VirtualConsole } = jsdomMod;
const { createCanvas } = canvasMod;

const CREATURES = [0, 1, 2, 3, 4, 5].map((i) => ({
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

const snapshot = {
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
    ticksPerDay: 19200,
    explorerTxUrl: 'https://explorer.arc.io/tx/',
    activeEffects: [],
    leaderboards: { predators: [], richest: [], elders: [] },
  },
  events: [],
  txRain: [],
};

const server = createServer((req, res) => {
  const path = req.url?.split('?')[0] ?? '/';
  res.setHeader('content-type', 'application/json');
  if (path === '/snapshot') res.end(JSON.stringify(snapshot));
  else if (path === '/history') res.end(JSON.stringify({ stats: [] }));
  else if (path === '/judgments') res.end(JSON.stringify({ judgments: [] }));
  else if (path === '/reports') res.end(JSON.stringify({ reports: [] }));
  else if (path === '/observe') res.end(JSON.stringify({ available: false }));
  else res.end(JSON.stringify({}));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/`;

const root = fileURLToPath(new URL('..', import.meta.url));
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
globalThis.fetch = window.fetch;
globalThis.requestAnimationFrame = window.requestAnimationFrame;
globalThis.cancelAnimationFrame = window.cancelAnimationFrame;
globalThis.CustomEvent = window.CustomEvent;
globalThis.Event = window.Event;
Object.defineProperty(window, 'innerWidth', { value: 1200, configurable: true });
Object.defineProperty(window, 'innerHeight', { value: 700, configurable: true });

const renderThrows = [];
window.addEventListener('error', (e) => renderThrows.push(String(e.error?.stack ?? e.message)));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await import(root + 'app.js');
await sleep(1200);

test('the render loop paints a living tank without throwing', () => {
  let frames = 0;
  let t = 1000;
  for (let i = 0; i < 8; i++) {
    const cbs = rafQ.splice(0, rafQ.length);
    if (!cbs.length) break;
    t += 16;
    for (const cb of cbs) {
      try {
        cb(t);
        frames++;
      } catch (err) {
        renderThrows.push(String(err.stack ?? err));
      }
    }
  }
  assert.ok(frames >= 4, `expected several frames, got ${frames}`);
  assert.deepEqual(renderThrows.slice(0, 1), [], 'the render loop threw');
  assert.deepEqual(pageErrors.slice(0, 1), [], 'the page reported an error');

  const world = window.document.getElementById('world');
  const px = canvasFor(world).getContext('2d').getImageData(0, 0, 1200, 700).data;
  let lit = 0;
  for (let p = 0; p < px.length; p += 4) {
    if (px[p + 3] > 8 && px[p] + px[p + 1] + px[p + 2] > 60) lit++;
  }
  // Water alone lights most of the frame; a blank canvas lights none.
  assert.ok(lit > 100_000, `the tank painted almost nothing (${lit} lit pixels)`);

  for (const id of timerIds) {
    clearInterval(id);
    clearTimeout(id);
  }
});

server.close();
server.closeAllConnections?.();
