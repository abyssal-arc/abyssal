/**
 * Abyssal frontend, zero-framework Canvas 2D renderer.
 *
 * Smoothness model (standard netcode):
 *  - Polls the combined /snapshot endpoint every 400ms into a buffer of the
 *    last ~6 world snapshots.
 *  - Rendering runs at a fixed RENDER_DELAY behind the newest snapshot, so
 *    it always interpolates between two snapshots already in hand; network
 *    jitter is absorbed by the buffer instead of producing stop-and-go.
 *  - If the buffer starves (packet loss), positions are extrapolated from
 *    the last known velocity (dead reckoning) for at most 1s, then hold.
 *  - Every creature's rendered position is additionally eased toward its
 *    computed target each frame, so recovery after a stall is a smooth
 *    catch-up slide, never a teleport.
 *  - Heading interpolation takes the shortest arc (handles the -π/π wrap).
 *
 * Performance notes: all glow is baked into pre-rendered sprites (no runtime
 * shadowBlur); the hot loop is one setTransform + drawImage per entity; DPR
 * is capped at 2; per-snapshot preprocessing runs once per poll.
 */
import { t, initI18n } from './i18n.js';
import { mulberry32, hashSeed, mixSeed, unitNoise } from './src/geom.js';
import { hsla, shortAddr, fmtUsd } from './src/format.js';

initI18n();

const worldCanvas = document.getElementById('world');
const wctx = worldCanvas.getContext('2d');
const chartCanvas = document.getElementById('chart');
const cctx = chartCanvas.getContext('2d');
const tempsCanvas = document.getElementById('temps');
const tctx = tempsCanvas.getContext('2d');

const POLL_MS = 400;
const RENDER_DELAY = 700;     // ms behind the newest snapshot
const BUFFER_KEEP = 6;
const DEAD_RECKON_MAX = 1000; // ms of velocity extrapolation before holding
/** Points each chart draws; also the server-side decimation target for /history. */
const CHART_SLOTS = 200;
const HISTORY_WINDOW = 2000;
const DPR_NATIVE = Math.min(window.devicePixelRatio || 1, 2);
let DPR = DPR_NATIVE;

/**
 * The one render clock: wall time, not performance.now(). Every animated phase
 * in the scene (motes, stars, shimmer, effect ages, snapshot interpolation) is
 * derived from it, so two browsers, or the same browser before and after a
 * refresh, draw the same frame at the same real-world instant instead of
 * restarting their animation from zero on load.
 */
const clock = () => Date.now();

/** Buffered snapshot: raw payload + per-creature derived data in byId. */
const snapBuffer = [];
let latestSnap = null;        // foods, tints, dimensions come from here
let state = null;
let targeting = null;         // 'feed' | 'poison' | null
let aimPos = null;            // cursor in world coords, for the targeting reticle
let selectedId = null;
let lastStats = null;
let lastCulls = null;
let cssW = 0;
let cssH = 0;
let lastEventSeq = 0;
/** Explorer base URL from the server config (state payload). */
let explorerTxUrl = 'https://explorer.arc.io/tx/';
/** Meteor impact sites kept clickable for a while: {x, y, hash, until}. */
const impacts = [];
/** Meteor hashes already animated (avoid re-animating on every poll). */
const seenMeteors = new Set();
/** Screen shake state (toggleable, persisted). */
let shakeEnabled = localStorage.getItem('abyssal-shake') !== 'off';
let shakeUntil = 0;

document.getElementById('shake-toggle').addEventListener('click', (ev) => {
  shakeEnabled = !shakeEnabled;
  localStorage.setItem('abyssal-shake', shakeEnabled ? 'on' : 'off');
  ev.currentTarget.classList.toggle('active', shakeEnabled);
});
document.getElementById('shake-toggle').classList.toggle('active', shakeEnabled);

/* ---------- dual view: OBSERVE (Arc observatory) / WORLD (the tank) ---------- */

const flowCanvas = document.getElementById('flowmap');
const fctx = flowCanvas.getContext('2d');
const pulseCanvas = document.getElementById('pulse');
const pctx = pulseCanvas.getContext('2d');
/** 'world' | 'observe' */
let view = 'world';
/** Latest /observe payload (null when the server runs without the Arc feed). */
let obsData = null;
let observeAvailable = false;
let chainCopyApplied = false;

function setView(v) {
  view = v;
  document.body.classList.toggle('view-observe', v === 'observe');
  document.body.classList.toggle('view-world', v !== 'observe');
  document.querySelectorAll('.viewtabs button').forEach((b) => {
    b.classList.toggle('active', b.dataset.view === v);
  });
  document.getElementById('observe-view').hidden = v !== 'observe';
  document.getElementById('ticker').hidden = v !== 'observe' || !observeAvailable;
  document.getElementById('world-legend').hidden = v !== 'world';
  addrCardAddr = null;
  document.getElementById('addr-card').hidden = true;
  if (v === 'observe') {
    pollObserve();
    resizeObserve();
  }
}
document.querySelectorAll('.viewtabs button').forEach((b) => {
  b.addEventListener('click', () => setView(b.dataset.view));
});

/** Per-creature eased render positions (id -> {x, y}), the anti-teleport layer. */
const renderPos = new Map();
let lastFrameAt = clock();

/* ---------- sprite pre-rendering ---------- */

const SPRITE = 128;         // sprite canvas size (glow included)
const SPRITE_BODY = 30;     // body radius inside the sprite, in sprite px
const TAU = Math.PI * 2;
const HUE_BUCKETS = 24;
// Visual-only magnification: the sim's collision radius stays small, but on
// screen each creature is drawn large enough that its jewel-body art reads.
// Kept small on purpose. Big sprites just read as blobs.
const CREATURE_VISUAL_SCALE = 1.3;
const spriteCache = new Map();

/* ---------- procedural creature sprites (v7 "field guide") ---------- */
/**
 * v7 "field guide" creature painters. Bodies fill their footprint, real anatomy,
 * dark back / light belly, one rim light and one accent organ, so a silhouette
 * still reads at 18px. Facing +x, centred on (64,64) in a 128px sprite.
 */
const hsl = hsla;

function lg(g, x0, y0, x1, y1, stops) {
  const gr = g.createLinearGradient(x0, y0, x1, y1);
  for (const [o, c] of stops) gr.addColorStop(o, c);
  return gr;
}

/** Stroke a path again as a top-edge rim light. */
function rim(g, hue, width = 1.6, alpha = 0.55) {
  g.save();
  g.clip();
  g.strokeStyle = hsl(hue, 95, 84, alpha);
  g.lineWidth = width * 2;
  g.translate(0, -width);
  g.stroke();
  g.restore();
}

/* ---------------- WHALE: sperm-whale body, flukes, one fin ---------------- */
function drawWhale(g, hue, ph) {
  const beat = Math.sin(ph * TAU);
  g.save();
  g.translate(64, 64);

  // Caudal peduncle and flukes, beating around the tail root.
  g.save();
  g.translate(-30, 0);
  g.rotate(beat * 0.22);
  g.beginPath();
  g.moveTo(2, -5);
  g.quadraticCurveTo(-9, -7, -16, -18);
  g.quadraticCurveTo(-10, -6, -13, 0);
  g.quadraticCurveTo(-10, 6, -16, 16);
  g.quadraticCurveTo(-9, 7, 2, 5);
  g.closePath();
  g.fillStyle = lg(g, 0, -16, 0, 16, [[0, hsl(hue, 55, 34)], [1, hsl(hue, 45, 22)]]);
  g.fill();
  g.restore();

  // Body mass: blunt head, deep middle, narrow peduncle.
  g.beginPath();
  g.moveTo(39, -12);
  g.bezierCurveTo(30, -18, 10, -20, -6, -17);
  g.bezierCurveTo(-18, -14, -26, -8, -31, -4);
  g.lineTo(-31, 4);
  g.bezierCurveTo(-24, 10, -12, 16, 2, 17);
  g.bezierCurveTo(16, 18, 32, 15, 38, 9);
  g.quadraticCurveTo(41, 0, 39, -12);
  g.closePath();
  const body = lg(g, 0, -20, 0, 18, [
    [0, hsl(hue, 62, 40)],
    [0.45, hsl(hue, 58, 30)],
    [0.75, hsl(hue, 40, 46)],
    [1, hsl(hue, 32, 62)],
  ]);
  g.fillStyle = body;
  g.fill();

  // Dorsal ridge.
  g.beginPath();
  g.moveTo(-4, -16);
  g.quadraticCurveTo(2, -22, 8, -15);
  g.quadraticCurveTo(2, -17, -4, -16);
  g.closePath();
  g.fillStyle = hsl(hue, 60, 36);
  g.fill();

  // Pectoral fin, swept back, flexing with the beat.
  g.save();
  g.translate(12, 9);
  g.rotate(0.55 + beat * 0.14);
  g.beginPath();
  g.moveTo(2, -2);
  g.quadraticCurveTo(-2, 12, -18, 19);
  g.quadraticCurveTo(-8, 9, -6, -1);
  g.closePath();
  g.fillStyle = hsl(hue, 52, 22, 0.98);
  g.fill();
  g.strokeStyle = hsl(hue, 70, 60, 0.5);
  g.lineWidth = 1;
  g.stroke();
  g.restore();
  // Mouth line.
  g.beginPath();
  g.moveTo(38, 4);
  g.quadraticCurveTo(32, 7, 26, 6);
  g.strokeStyle = hsl(hue, 40, 12, 0.7);
  g.lineWidth = 1.4;
  g.stroke();

  // Ventral grooves.
  g.strokeStyle = hsl(hue, 30, 70, 0.25);
  g.lineWidth = 1;
  for (let i = 0; i < 3; i++) {
    g.beginPath();
    g.moveTo(30 - i * 4, 12 - i * 2.5);
    g.quadraticCurveTo(10, 15 - i * 2.5, -14, 8 - i * 2);
    g.stroke();
  }

  // Eye.
  g.beginPath();
  g.arc(29, -3, 2.7, 0, TAU);
  g.fillStyle = hsl(hue, 20, 8);
  g.fill();
  g.beginPath();
  g.arc(29.9, -3.9, 1, 0, TAU);
  g.fillStyle = hsl(hue, 90, 88, 0.9);
  g.fill();

  // Rim light along the back.
  g.beginPath();
  g.moveTo(38, -10);
  g.bezierCurveTo(30, -17, 10, -19, -6, -16);
  g.bezierCurveTo(-18, -13, -26, -8, -31, -4);
  g.strokeStyle = hsl(hue, 95, 82, 0.5);
  g.lineWidth = 1.6;
  g.stroke();
  g.restore();
}

/* ------------- ALGO: machine cuttlefish, faceted core, jointed arms ------------- */
function drawAlgo(g, hue, ph) {
  const beat = Math.sin(ph * TAU);
  g.save();
  g.translate(64, 64);

  // Mantle cone with fin ribs.
  g.beginPath();
  g.moveTo(8, -12);
  g.lineTo(-30, -3);
  g.quadraticCurveTo(-36, 0, -30, 3);
  g.lineTo(8, 12);
  g.closePath();
  g.fillStyle = lg(g, 0, -12, 0, 12, [[0, hsl(hue, 55, 42)], [1, hsl(hue, 50, 20)]]);
  g.fill();
  for (let i = 0; i < 3; i++) {
    const x = 0 - i * 11;
    const w = 5 + Math.sin(ph * TAU + i * 1.3) * 1.6;
    g.beginPath();
    g.moveTo(x + 5, -11 + i * 2.5);
    g.quadraticCurveTo(x - 2, -13 - w + i * 2.5, x - 8, -10 + i * 2.5);
    g.quadraticCurveTo(x - 3, -9 + i * 2.5, x + 5, -11 + i * 2.5);
    g.closePath();
    g.fillStyle = hsl(hue, 62, 52, 0.85);
    g.fill();
    g.beginPath();
    g.moveTo(x + 5, 11 - i * 2.5);
    g.quadraticCurveTo(x - 2, 13 + w - i * 2.5, x - 8, 10 - i * 2.5);
    g.quadraticCurveTo(x - 3, 9 - i * 2.5, x + 5, 11 - i * 2.5);
    g.closePath();
    g.fillStyle = hsl(hue, 62, 34, 0.85);
    g.fill();
  }

  // Faceted core head.
  g.beginPath();
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * TAU + Math.PI / 6;
    const x = 19 + Math.cos(a) * 16;
    const y = Math.sin(a) * 14;
    if (i === 0) g.moveTo(x, y);
    else g.lineTo(x, y);
  }
  g.closePath();
  g.fillStyle = lg(g, 10, -14, 26, 14, [
    [0, hsl(hue, 70, 62)],
    [0.5, hsl(hue, 65, 40)],
    [1, hsl(hue, 60, 24)],
  ]);
  g.fill();
  // Facet seams.
  g.strokeStyle = hsl(hue, 80, 78, 0.35);
  g.lineWidth = 1;
  g.beginPath();
  g.moveTo(8, -8);
  g.lineTo(20, 0);
  g.lineTo(8, 9);
  g.moveTo(20, 0);
  g.lineTo(31, -4);
  g.stroke();

  // Visor slit, the one bright organ.
  g.beginPath();
  if (g.roundRect) g.roundRect(15, -4.5, 15, 5, 2.5);
  else g.rect(15, -4.5, 15, 5);
  g.fillStyle = hsl(hue, 100, 80, 0.98);
  g.fill();
  g.beginPath();
  g.arc(24, -2, 6, 0, TAU);
  g.fillStyle = hsl(hue, 100, 70, 0.28);
  g.fill();

  // Jointed arms, two segments each.
  for (let i = 0; i < 3; i++) {
    const y0 = -7 + i * 7;
    const flex = beat * 0.3 + i * 0.3;
    const a1 = -0.45 + i * 0.45 + flex * 0.3;
    const x1 = 31 + Math.cos(a1) * 11;
    const y1 = y0 + Math.sin(a1) * 11;
    const a2 = a1 + 0.8 + flex;
    const x2 = x1 + Math.cos(a2) * 10;
    const y2 = y1 + Math.sin(a2) * 10;
    g.strokeStyle = hsl(hue, 58, 52, 0.95);
    g.lineWidth = 4;
    g.lineCap = 'round';
    g.beginPath();
    g.moveTo(29, y0);
    g.lineTo(x1, y1);
    g.lineTo(x2, y2);
    g.stroke();
    g.beginPath();
    g.arc(x1, y1, 2.2, 0, TAU);
    g.fillStyle = hsl(hue, 90, 78, 0.95);
    g.fill();
  }
  g.restore();
}

/* ---------------- APE: segmented isopod, plates, legs, antennae ---------------- */
function drawApe(g, hue, ph) {
  const step = Math.sin(ph * TAU);
  g.save();
  g.translate(64, 64);

  // Legs under the body, cycling.
  g.strokeStyle = hsl(hue, 50, 40, 0.95);
  g.lineWidth = 2.4;
  g.lineCap = 'round';
  for (let i = 0; i < 4; i++) {
    const x = 14 - i * 11;
    const sw = Math.sin(ph * TAU + i * 1.7) * 3;
    for (const s of [-1, 1]) {
      g.beginPath();
      g.moveTo(x, 8 * s * 0.4 + 6);
      g.lineTo(x - 3 + sw, 16);
      g.lineTo(x - 7 + sw, 21);
      g.stroke();
    }
  }

  // Tail plate.
  g.beginPath();
  g.ellipse(-28, 0, 8, 9, 0, 0, TAU);
  g.fillStyle = hsl(hue, 50, 26);
  g.fill();

  // Carapace plates, back to front so each overlaps the next.
  for (let i = 0; i < 5; i++) {
    const x = -22 + i * 9.5;
    const ry = 15 - i * 1.6;
    g.beginPath();
    g.ellipse(x, 0, 11, ry, 0, 0, TAU);
    g.fillStyle = lg(g, x, -ry, x, ry, [
      [0, hsl(hue, 55, 46)],
      [0.5, hsl(hue, 52, 32)],
      [1, hsl(hue, 45, 20)],
    ]);
    g.fill();
    // Seam shadow on the rear edge of each plate.
    g.beginPath();
    g.ellipse(x - 3, 0, 10, ry - 1, 0, Math.PI * 0.5, Math.PI * 1.5);
    g.strokeStyle = hsl(hue, 45, 10, 0.65);
    g.lineWidth = 1.8;
    g.stroke();
  }

  // Dorsal ridge highlight.
  g.beginPath();
  g.moveTo(-26, -8);
  g.quadraticCurveTo(0, -16, 20, -9);
  g.strokeStyle = hsl(hue, 90, 80, 0.45);
  g.lineWidth = 1.6;
  g.stroke();

  // Head plate, antennae, eyes.
  g.beginPath();
  g.ellipse(22, 0, 9, 10, 0, 0, TAU);
  g.fillStyle = lg(g, 22, -10, 22, 10, [[0, hsl(hue, 58, 50)], [1, hsl(hue, 48, 26)]]);
  g.fill();
  g.strokeStyle = hsl(hue, 50, 40, 0.95);
  g.lineWidth = 1.6;
  g.lineCap = 'round';
  g.beginPath();
  g.moveTo(28, -4);
  g.quadraticCurveTo(38, -9, 46, -8 + step);
  g.moveTo(28, 3);
  g.quadraticCurveTo(38, 6, 46, 8 - step);
  g.stroke();
  for (const y of [-4, 3]) {
    g.beginPath();
    g.arc(25, y, 2, 0, TAU);
    g.fillStyle = hsl(hue, 20, 8);
    g.fill();
    g.beginPath();
    g.arc(25.7, y - 0.7, 0.8, 0, TAU);
    g.fillStyle = hsl(hue, 90, 88, 0.9);
    g.fill();
  }
  g.restore();
}

/* -------------- INSIDER: ribbon eel with a head, eye and real girth -------------- */
function drawInsider(g, hue, ph) {
  g.save();
  g.translate(64, 64);
  const N = 26;
  const xs = [];
  const ys = [];
  const ws = [];
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const x = 32 - t * 74;
    const amp = 9 * (1 - t * 0.55);
    const y = Math.sin(t * 4.4 + ph * TAU) * amp * (0.35 + t * 0.9);
    xs.push(x);
    ys.push(y);
    ws.push((14 - t * 11.5) * 0.5);
  }
  // Ribbon body: offset the centreline perpendicular.
  g.beginPath();
  for (let i = 0; i <= N; i++) {
    const dx = xs[Math.min(N, i + 1)] - xs[Math.max(0, i - 1)];
    const dy = ys[Math.min(N, i + 1)] - ys[Math.max(0, i - 1)];
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len;
    const ny = dx / len;
    const px = xs[i] + nx * ws[i];
    const py = ys[i] + ny * ws[i];
    if (i === 0) g.moveTo(px, py);
    else g.lineTo(px, py);
  }
  for (let i = N; i >= 0; i--) {
    const dx = xs[Math.min(N, i + 1)] - xs[Math.max(0, i - 1)];
    const dy = ys[Math.min(N, i + 1)] - ys[Math.max(0, i - 1)];
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len;
    const ny = dx / len;
    g.lineTo(xs[i] - nx * ws[i], ys[i] - ny * ws[i]);
  }
  g.closePath();
  g.fillStyle = lg(g, 0, -14, 0, 14, [
    [0, hsl(hue, 65, 58)],
    [0.5, hsl(hue, 60, 38)],
    [1, hsl(hue, 50, 22)],
  ]);
  g.fill();

  // Dorsal fringe.
  g.fillStyle = hsl(hue, 70, 66, 0.75);
  for (let i = 2; i < N - 2; i += 2) {
    const dx = xs[i + 1] - xs[i - 1];
    const dy = ys[i + 1] - ys[i - 1];
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len;
    const ny = dx / len;
    g.beginPath();
    g.moveTo(xs[i] + nx * ws[i], ys[i] + ny * ws[i]);
    g.lineTo(xs[i] + nx * (ws[i] + 4.6), ys[i] + ny * (ws[i] + 4.6));
    g.lineTo(xs[i + 1] + nx * ws[i + 1], ys[i + 1] + ny * ws[i + 1]);
    g.closePath();
    g.fill();
  }

  // Head wedge with a jaw and an eye.
  g.beginPath();
  g.moveTo(30, ys[0] - 7);
  g.quadraticCurveTo(42, ys[0] - 4, 43, ys[0] + 0.5);
  g.quadraticCurveTo(40, ys[0] + 2, 37, ys[0] + 2.5);
  g.quadraticCurveTo(40, ys[0] + 5, 33, ys[0] + 7);
  g.quadraticCurveTo(29, ys[0] + 4, 30, ys[0] - 7);
  g.closePath();
  g.fillStyle = hsl(hue, 64, 50);
  g.fill();
  g.beginPath();
  g.moveTo(43, ys[0] + 0.5);
  g.quadraticCurveTo(38, ys[0] + 2, 34, ys[0] + 2);
  g.strokeStyle = hsl(hue, 40, 12, 0.7);
  g.lineWidth = 1.3;
  g.stroke();
  g.beginPath();
  g.arc(35, ys[0] - 2.5, 2.3, 0, TAU);
  g.fillStyle = hsl(hue, 20, 8);
  g.fill();
  g.beginPath();
  g.arc(35.8, ys[0] - 3.3, 0.9, 0, TAU);
  g.fillStyle = hsl(hue, 90, 88, 0.9);
  g.fill();

  // Dorsal rim light.
  g.beginPath();
  for (let i = 0; i <= N; i++) {
    const dx = xs[Math.min(N, i + 1)] - xs[Math.max(0, i - 1)];
    const dy = ys[Math.min(N, i + 1)] - ys[Math.max(0, i - 1)];
    const len = Math.hypot(dx, dy) || 1;
    const px = xs[i] + (-dy / len) * ws[i];
    const py = ys[i] + (dx / len) * ws[i];
    if (i === 0) g.moveTo(px, py);
    else g.lineTo(px, py);
  }
  g.strokeStyle = hsl(hue, 95, 82, 0.5);
  g.lineWidth = 1.4;
  g.stroke();
  g.restore();
}

const CREATURE_PAINTERS = { WHALE: drawWhale, ALGO: drawAlgo, APE: drawApe, INSIDER: drawInsider };

/**
 * v7 "field guide": four animals with real anatomy and volume, painted dark
 * back to light belly with one rim light and one bright organ each, so a
 * silhouette still reads at the 18px the tank draws most bodies at. Bodies
 * fill their sprite; the halo is a whisper because the tank adds its own.
 */
function bakeCreature(archetype, hue, phase) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = SPRITE;
  const g = canvas.getContext('2d');
  const halo = g.createRadialGradient(SPRITE / 2, SPRITE / 2, 6, SPRITE / 2, SPRITE / 2, SPRITE * 0.47);
  halo.addColorStop(0, hsla(hue, 90, 60, 0.12));
  halo.addColorStop(1, hsla(hue, 90, 60, 0));
  g.fillStyle = halo;
  g.fillRect(0, 0, SPRITE, SPRITE);
  CREATURE_PAINTERS[archetype](g, hue, phase);
  return canvas;
}


/** Animation frames for an archetype + hue bucket (4-frame sine sway). */
// Curated jewel palette instead of a full 360° rainbow: cool bioluminescent
// teals→violets→magentas with a few warm gold accents. Genetic hue still
// varies, but the tank reads as one designed ecosystem, not confetti.
const PALETTE_HUES = [
  178, 186, 192, 198, 204, 210, 216, 224, 232, 242, 252, 264,
  276, 288, 300, 314, 328, 340, 352, 16, 34, 46, 168, 172,
];
function creatureFrames(archetype, hueBucket) {
  const key = `${archetype}:${hueBucket}`;
  let frames = spriteCache.get(key);
  if (frames) return frames;
  const hue = PALETTE_HUES[hueBucket % PALETTE_HUES.length];
  frames = [0, 0.25, 0.5, 0.75].map((p) => bakeCreature(archetype, hue, p));
  spriteCache.set(key, frames);
  return frames;
}

/** Additive bioluminescent halo per hue bucket, drawn under each creature. */
const glowCache = new Map();
function creatureGlow(hueBucket) {
  let s = glowCache.get(hueBucket);
  if (s) return s;
  const hue = PALETTE_HUES[hueBucket % PALETTE_HUES.length];
  const c = document.createElement('canvas');
  c.width = c.height = 96;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(48, 48, 0, 48, 48, 48);
  grad.addColorStop(0, hsla(hue, 100, 72, 0.5));
  grad.addColorStop(0.4, hsla(hue, 100, 60, 0.16));
  grad.addColorStop(1, hsla(hue, 100, 60, 0));
  g.fillStyle = grad;
  g.fillRect(0, 0, 96, 96);
  glowCache.set(hueBucket, c);
  return c;
}

/* ---------- food sprites (3 refined plankton/spore variants) ---------- */

const foodSpriteCache = [];

function foodSprite(variant) {
  let sprite = foodSpriteCache[variant];
  if (sprite) return sprite;
  const c = document.createElement('canvas');
  c.width = c.height = 40;
  const g = c.getContext('2d');
  const cx = 20;
  const cy = 20;
  // Cool bioluminescent motes (cyan/white), no spiky cilia: food should read
  // as drifting light, not green germs, so it never fights the creatures.
  const orb = (x, y, r, coreA = 0.95) => {
    const halo = g.createRadialGradient(x, y, 0, x, y, r * 3);
    halo.addColorStop(0, `rgba(150, 235, 240, ${0.28 * coreA})`);
    halo.addColorStop(1, 'rgba(150, 235, 240, 0)');
    g.fillStyle = halo;
    g.beginPath();
    g.arc(x, y, r * 3, 0, Math.PI * 2);
    g.fill();
    const core = g.createRadialGradient(x - r * 0.3, y - r * 0.3, 0, x, y, r);
    core.addColorStop(0, `rgba(245, 255, 255, ${coreA})`);
    core.addColorStop(0.5, `rgba(150, 235, 240, ${0.7 * coreA})`);
    core.addColorStop(1, 'rgba(120, 215, 230, 0)');
    g.fillStyle = core;
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
  };
  const ring = (x, y, r, a) => {
    g.strokeStyle = `rgba(170, 240, 245, ${a})`;
    g.lineWidth = 1;
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.stroke();
  };
  if (variant === 0) {
    orb(cx, cy, 4.2);
    ring(cx, cy, 7.5, 0.4);
  } else if (variant === 1) {
    orb(cx, cy, 3.4);
    ring(cx, cy, 6.5, 0.5);
    ring(cx, cy, 9.5, 0.22);
  } else {
    orb(cx - 4, cy + 2, 3.2);
    orb(cx + 4, cy - 3, 2.6, 0.8);
  }
  foodSpriteCache[variant] = c;
  return c;
}

/* ---------- static nebula background ---------- */

const nebula = (() => {
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  const g = c.getContext('2d');
  g.fillStyle = '#05080f';
  g.fillRect(0, 0, 512, 512);
  const blobs = [
    [130, 150, 180, 'rgba(40, 60, 140, 0.20)'],
    [380, 120, 150, 'rgba(90, 40, 140, 0.16)'],
    [300, 380, 200, 'rgba(20, 90, 110, 0.18)'],
    [110, 400, 130, 'rgba(120, 60, 60, 0.10)'],
    [430, 330, 120, 'rgba(40, 80, 160, 0.14)'],
  ];
  for (const [x, y, r, color] of blobs) {
    const grad = g.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, color);
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 512, 512);
  }
  // Sparse star dust.
  let s = 1337;
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  g.fillStyle = 'rgba(200, 220, 255, 0.35)';
  for (let i = 0; i < 120; i++) {
    g.fillRect(rnd() * 512, rnd() * 512, 1, 1);
  }
  return c;
})();

/* ---------- event effects (pre-rendered particles, no shadowBlur) ---------- */

/** Small soft dot sprite in a fixed color, used for all particle bursts. */
function makeDotSprite(cssColor) {
  const c = document.createElement('canvas');
  c.width = c.height = 16;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(8, 8, 0, 8, 8, 8);
  grad.addColorStop(0, cssColor);
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 16, 16);
  return c;
}

const DOTS = {
  red: makeDotSprite('rgba(255, 90, 90, 0.9)'),
  white: makeDotSprite('rgba(255, 255, 255, 0.95)'),
  green: makeDotSprite('rgba(120, 230, 150, 0.9)'),
  purple: makeDotSprite('rgba(170, 100, 255, 0.85)'),
  gray: makeDotSprite('rgba(120, 130, 160, 0.7)'),
};

/** Soft cloud sprite for the persistent poison overlay. */
const CLOUD_PURPLE = makeCloud('150, 80, 230');
/** Soft green glow for active feast zones. */
const CLOUD_GREEN = makeCloud('110, 220, 140');

function makeCloud(rgb) {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(64, 64, 4, 64, 64, 64);
  grad.addColorStop(0, `rgba(${rgb}, 0.35)`);
  grad.addColorStop(0.7, `rgba(${rgb}, 0.15)`);
  grad.addColorStop(1, `rgba(${rgb}, 0)`);
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  return c;
}

/** Glowing meteor teardrop pointing down (+y is the fall direction). */
const METEOR_SPRITE = (() => {
  const c = document.createElement('canvas');
  c.width = 32;
  c.height = 48;
  const g = c.getContext('2d');
  const tail = g.createLinearGradient(16, 0, 16, 34);
  tail.addColorStop(0, 'rgba(255, 160, 60, 0)');
  tail.addColorStop(1, 'rgba(255, 160, 60, 0.55)');
  g.fillStyle = tail;
  g.beginPath();
  g.moveTo(16, 32);
  g.lineTo(10, 2);
  g.lineTo(22, 2);
  g.closePath();
  g.fill();
  const head = g.createRadialGradient(16, 34, 1, 16, 34, 12);
  head.addColorStop(0, 'rgba(255, 240, 200, 0.95)');
  head.addColorStop(0.4, 'rgba(255, 170, 70, 0.7)');
  head.addColorStop(1, 'rgba(255, 140, 50, 0)');
  g.fillStyle = head;
  g.beginPath();
  g.arc(16, 34, 12, 0, Math.PI * 2);
  g.fill();
  return c;
})();

/** Skull marker for creatures inside a poison zone (glow-backed). */
const SKULL_SPRITE = (() => {
  const c = document.createElement('canvas');
  c.width = c.height = 28;
  const g = c.getContext('2d');
  const glow = g.createRadialGradient(14, 14, 1, 14, 14, 14);
  glow.addColorStop(0, 'rgba(200, 120, 255, 0.45)');
  glow.addColorStop(1, 'rgba(200, 120, 255, 0)');
  g.fillStyle = glow;
  g.fillRect(0, 0, 28, 28);
  g.font = '14px sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('☠', 14, 15);
  return c;
})();

/** Crown marker for the current top predator (golden glow-backed). */
const CROWN_SPRITE = (() => {
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const g = c.getContext('2d');
  const glow = g.createRadialGradient(16, 16, 1, 16, 16, 16);
  glow.addColorStop(0, 'rgba(255, 200, 80, 0.5)');
  glow.addColorStop(1, 'rgba(255, 200, 80, 0)');
  g.fillStyle = glow;
  g.fillRect(0, 0, 32, 32);
  g.font = '17px sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('👑', 16, 17);
  return c;
})();

/** Soft double ring used to mark the selected creature. */
const RING_SPRITE = (() => {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  g.strokeStyle = 'rgba(255, 255, 255, 0.85)';
  g.lineWidth = 1.6;
  g.beginPath();
  g.arc(32, 32, 24, 0, Math.PI * 2);
  g.stroke();
  g.strokeStyle = 'rgba(120, 220, 255, 0.4)';
  g.lineWidth = 3.5;
  g.beginPath();
  g.arc(32, 32, 28, 0, Math.PI * 2);
  g.stroke();
  return c;
})();

/**
 * Active visual effects. Hard cap: oldest are dropped beyond the limit so a
 * busy tick can never flood the frame loop.
 *
 * Determinism: particle shapes come from a seeded RNG keyed to the event seq
 * or the tx hash, never from Math.random(), so the same on-chain/sim moment
 * looks identical on every screen and after every refresh.
 */
const effects = [];
const MAX_EFFECTS = 300;
/** While true, event handling updates state/ticker but spawns no visuals. */
let suppressFx = false;

function pushEffect(e) {
  if (suppressFx) return;
  e.born = clock();
  effects.push(e);
  if (effects.length > MAX_EFFECTS) effects.splice(0, effects.length - MAX_EFFECTS);
}

function spawnBurst(x, y, sprites, count, dur, speed, seed = mixSeed(x, y, count)) {
  const rnd = mulberry32(seed);
  const parts = [];
  for (let i = 0; i < count; i++) {
    const a = rnd() * Math.PI * 2;
    const v = (0.3 + rnd() * 0.7) * speed;
    parts.push({
      vx: Math.cos(a) * v, vy: Math.sin(a) * v,
      size: 0.5 + rnd() * 0.8,
      sprite: sprites[i % sprites.length],
    });
  }
  pushEffect({ kind: 'burst', x, y, dur, parts });
}

function spawnRing(x, y, radius, color, dur) {
  pushEffect({ kind: 'ring', x, y, radius, color, dur });
}

function spawnEdgePulse(color, dur) {
  pushEffect({ kind: 'edge', color, dur });
}

/** Food particles that drop from above with a small bounce. */
function spawnDrop(x, y, count, seed = mixSeed(x, y, count)) {
  const rnd = mulberry32(seed);
  const parts = [];
  for (let i = 0; i < count; i++) {
    parts.push({
      ox: (rnd() - 0.5) * 120,
      delay: rnd() * 250,
      size: 0.5 + rnd() * 0.6,
    });
  }
  pushEffect({ kind: 'drop', x, y, dur: 1000, parts });
}

function bounceOut(p) {
  const n1 = 7.5625;
  const d1 = 2.75;
  if (p < 1 / d1) return n1 * p * p;
  if (p < 2 / d1) return n1 * (p -= 1.5 / d1) * p + 0.75;
  if (p < 2.5 / d1) return n1 * (p -= 2.25 / d1) * p + 0.9375;
  return n1 * (p -= 2.625 / d1) * p + 0.984375;
}

/** Floating "+N" combat text above a predator after a kill. */
function spawnFloatText(x, y, text, color) {
  pushEffect({ kind: 'float', x, y, text, color, dur: 900 });
}

/** Energy beam: particles stream from the prey to the predator. */
function spawnBeam(fx, fy, predatorId) {
  pushEffect({ kind: 'beam', fx, fy, predatorId, dur: 500 });
}

/* ---------- layout ---------- */

function resize() {
  cssW = window.innerWidth;
  cssH = window.innerHeight;
  worldCanvas.width = Math.round(cssW * DPR);
  worldCanvas.height = Math.round(cssH * DPR);
  for (const c of [chartCanvas, tempsCanvas]) {
    const cr = c.getBoundingClientRect();
    if (cr.width === 0) continue; // analytics drawer is closed
    c.width = Math.round(cr.width * DPR);
    c.height = Math.round(cr.height * DPR);
  }
  if (lastStats) drawCharts();
}
window.addEventListener('resize', resize);
resize();

/* ---------- snapshot intake ---------- */

async function getJSON(path) {
  const res = await fetch(path);
  return res.json();
}

function torusDelta(a, b, size) {
  let d = b - a;
  if (d > size / 2) d -= size;
  else if (d < -size / 2) d += size;
  return d;
}

/**
 * Per-snapshot preprocessing: heading + velocity from the previous buffered
 * snapshot, neighbor counts from a coarse grid (drives the APE pulse), and
 * the sprite cache key. Runs once per poll, never per frame.
 *
 * `recv` is the arrival time on the local clock; when the server stamps its
 * payload the buffer timeline is anchored to that stamp instead, so snapshot
 * spacing reflects the sim, not this client's poll jitter.
 */
function processSnapshot(snap, recv) {
  const prev = snapBuffer[snapBuffer.length - 1];
  // Polls can overlap, so a response may land after a newer one. Feeding it in
  // would invert the buffer timeline and collapse dtMs to 1ms, which turns every
  // derived velocity into a teleport. Drop anything that is not strictly newer.
  if (prev && snap.tick <= prev.tick) return;
  let at = typeof snap.t === 'number' && clockOffset !== null ? snap.t + clockOffset : recv;
  // Belt and braces for the same inversion: the anchor is min-tracked, but the
  // local clock can still step.
  if (prev && at <= prev.at) at = prev.at + 1;
  if (Array.isArray(snap.whales)) {
    chainWhales = snap.whales;
  }
  if (snap.eaters) worldEaters = snap.eaters;
  // Followed creatures: a disappearance is a death, a new child is a birth.
  const alive = new Map(snap.creatures.map((c) => [c.id, c]));
  for (const id of watched) {
    const was = prevAlive.get(id);
    if (was && !alive.has(id)) toast(t('watchedDied', { name: was.name }), true);
  }
  for (const [id, c] of alive) {
    const was = prevAlive.get(id);
    if (watched.has(id) && was && (c.offspring ?? 0) > was.offspring) {
      toast(t('watchedBorn', { name: c.name ?? `#${id}` }));
    }
  }
  prevAlive = new Map(
    [...alive].map(([id, c]) => [id, { name: c.name ?? `#${id}`, offspring: c.offspring ?? 0 }]),
  );
  const dtMs = prev ? at - prev.at : POLL_MS;
  const cell = 60;
  const grid = new Map();
  for (const c of snap.creatures) {
    const key = `${Math.floor(c.x / cell)}:${Math.floor(c.y / cell)}`;
    const bucket = grid.get(key);
    if (bucket) bucket.push(c);
    else grid.set(key, [c]);
  }
  const byId = new Map();
  for (const c of snap.creatures) {
    const p = prev?.byId.get(c.id);
    let heading = p?.heading ?? 0;
    let vx = 0;
    let vy = 0;
    if (p) {
      const dx = torusDelta(p.x, c.x, snap.width);
      const dy = torusDelta(p.y, c.y, snap.height);
      if (Math.hypot(dx, dy) > 0.3) heading = Math.atan2(dy, dx);
      vx = dx / dtMs;
      vy = dy / dtMs;
    }
    const gx = Math.floor(c.x / cell);
    const gy = Math.floor(c.y / cell);
    let neighbors = 0;
    for (let ix = gx - 1; ix <= gx + 1; ix++) {
      for (let iy = gy - 1; iy <= gy + 1; iy++) {
        const bucket = grid.get(`${ix}:${iy}`);
        if (bucket) neighbors += bucket.length;
      }
    }
    byId.set(c.id, {
      ...c,
      heading, vx, vy,
      neighbors: neighbors - 1,
      spriteKey: Math.round(c.hue * (HUE_BUCKETS - 1)),
      phase: (c.id * 0.77) % (Math.PI * 2),
    });
  }
  snapBuffer.push({
    at,
    tick: snap.tick,
    width: snap.width,
    height: snap.height,
    chainTemp: snap.chainTemp,
    marketTemp: snap.marketTemp,
    foods: snap.foods,
    byId,
  });
  if (snapBuffer.length > BUFFER_KEEP) snapBuffer.shift();
  latestSnap = snapBuffer[snapBuffer.length - 1];
  const chip = document.getElementById('tax-chip');
  if (chip) {
    const tax = snap.tax;
    if (tax) {
      chip.hidden = false;
      chip.textContent = t('taxActive', {
        species: tax.archetype,
        pct: Math.round(tax.share * 100),
      });
    } else {
      chip.hidden = true;
    }
  }
}

/* ---------- chain whales: the tank's food source, embodied ---------- */

// The observation window's top USDC addresses, straight from the server
// snapshot. Each one is a resident leviathan, and when it moves money its own
// transfer rains plankton at its flank, the ecosystem then converges on it.
// Lane/phase come from the server (`w.lane`), never re-derived here, so the
// animal on screen is exactly where the server dropped its food.
let chainWhales = [];
/** tx hash to creature ids that ate its plankton, from the snapshot. */
let worldEaters = {};
/** Creatures the visitor follows; death and birth raise a toast. */
let watched = new Set(JSON.parse(localStorage.getItem('abyssal-watch') ?? '[]'));
/** id -> { name, offspring } from the previous snapshot, to see what changed. */
let prevAlive = new Map();
/** address -> { t, amount } of its last transfer: the feed pulse + label. */
const whaleFeed = new Map();
/** Screen-space hit targets refreshed every frame by drawWhales. */
let whaleHits = [];
/** Screen-space hit targets for the sim creatures, refreshed every frame. */
/** Paid zones, refreshed every frame, so weather can be clicked back to its burn. */
let effectHits = [];
const creatureHits = [];
/** Silence after which a whale has faded to a ghost of itself. */
const WHALE_QUIET_MS = 180000;
/** How long the "just fed" ring and amount label stay up. */
const WHALE_FEED_MS = 1600;
/**
 * Which whale transfers the viewer reacts to is decided by the server (`tx.boom`),
 * from the sim's own threshold: the flash must land on exactly the transfers the
 * ecosystem responds to. Only bigger money also earns a line in the global event
 * feed, a live Arc whale booms about once every 14s, and narrating each one
 * would bury every other happening in the tank. ~$1.8k leaves roughly one line
 * a minute on a busy chain and none at all on a quiet one, which is the point:
 * the feed is a highlight reel, not a firehose.
 */
const WHALE_NEWS_SIZE = 0.65;
/** At most one whale line per this long, however chatty the chain is. */
const WHALE_LINE_COOLDOWN_MS = 20000;
/** Local-clock time of the last whale line. */
let whaleLineAt = 0;

function drawWhales(now, sx, sy, shX, shY, ct) {
  whaleHits = [];
  const snap = latestSnap;
  if (!snap || !chainWhales.length) return;
  const W = snap.width;
  const H = snap.height;
  // Server clock, not local: a skewed client clock would drift the animal away
  // from the plankton the server just dropped in its name.
  const t = now - (clockOffset ?? 0);
  for (const w of chainWhales) {
    const lane = w.lane;
    if (!lane) continue;
    const u = ((lane.phaseU + t / lane.period) % 1.2) - 0.1;
    // Fade at the seams so the wrap-around crossing never pops.
    const edge = Math.max(0, Math.min(1, Math.min(u + 0.1, 1.1 - u) / 0.12));
    if (edge <= 0.01) continue;
    const x = u * W;
    const y = lane.lane * H + Math.sin(t / 23000 + lane.phaseY) * H * 0.05;
    const dydt = (Math.cos(t / 23000 + lane.phaseY) * H * 0.05) / 23000;
    const angle = Math.atan2(dydt, W / lane.period) + 0.05 * Math.sin(t / 5000 + lane.phaseW);
    // Presence is earned by live flow: a whale that has gone quiet shrinks and
    // dims, so the tank shows who is moving money now, not who did an hour ago.
    const quiet = Math.max(0, Math.min(1, (t - (w.lastT || 0)) / WHALE_QUIET_MS));
    const size = (68 + Math.min(54, Math.log10(w.volume + 1) * 26)) *
      (1 - (w.rank - 1) * 0.05) * (1 - 0.2 * quiet) * (1 + 0.05 * Math.sin(t / 900 + lane.phaseW));
    const bucket = lane.seed % HUE_BUCKETS;
    const frames = creatureFrames('WHALE', bucket);
    const frame = frames[Math.floor(t / 220 + (lane.seed % 4)) % frames.length];
    const px = vx(x * sx) + shX;
    const py = vy(y * sy) + shY;
    const scale = (size * sx * cam.z) / SPRITE;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    wctx.setTransform(
      DPR * cos * scale, DPR * sin * scale,
      -DPR * sin * scale, DPR * cos * scale,
      px * DPR, py * DPR,
    );
    wctx.globalCompositeOperation = 'lighter';
    wctx.globalAlpha = (0.34 - 0.16 * quiet) * (0.5 + 0.5 * ct) * edge;
    wctx.drawImage(creatureGlow(bucket), -SPRITE * 0.85, -SPRITE * 0.85, SPRITE * 1.7, SPRITE * 1.7);
    wctx.globalCompositeOperation = 'source-over';
    wctx.globalAlpha = (0.95 - 0.4 * quiet) * edge;
    wctx.drawImage(frame, -SPRITE / 2, -SPRITE / 2);
    wctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    const fed = whaleFeed.get(w.address);
    if (fed !== undefined) {
      const age = now - fed.t;
      if (age > WHALE_FEED_MS) whaleFeed.delete(w.address);
      else {
        const k = age / WHALE_FEED_MS;
        wctx.strokeStyle = hsla(PALETTE_HUES[bucket], 100, 80, (1 - k) * 0.55 * edge);
        wctx.lineWidth = 1.6;
        wctx.beginPath();
        wctx.arc(px, py, size * sx * cam.z * (0.45 + k * 0.5), 0, TAU);
        wctx.stroke();
        // The only moment a whale carries a label: while its money is landing.
        wctx.globalAlpha = (1 - k) * 0.85 * edge;
        wctx.fillStyle = 'rgba(190, 215, 255, 0.95)';
        wctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
        wctx.textAlign = 'center';
        wctx.fillText(
          `#${w.rank} ${shortAddr(w.address)} · ${fmtUsd(fed.amount)}`,
          px, py + size * sx * cam.z * 0.5 + 14,
        );
      }
    }
    wctx.globalAlpha = 1;
    whaleHits.push({
      addr: w.address, rank: w.rank, volume: w.volume, count: w.count,
      x: px, y: py, r: size * sx * cam.z * 0.45,
    });
  }
  wctx.textAlign = 'left';
}

function whaleHitAt(ev) {
  const r = worldCanvas.getBoundingClientRect();
  const mx = ev.clientX - r.left;
  const my = ev.clientY - r.top;
  for (let i = whaleHits.length - 1; i >= 0; i--) {
    const h = whaleHits[i];
    if (Math.hypot(h.x - mx, h.y - my) < h.r) return h;
  }
  return null;
}

/**
 * The creature under the cursor, judged against what this frame actually
 * painted, null for open water. Nearest centre wins, so overlapping bodies
 * resolve to the one the cursor is really on.
 */
function creatureHitAt(ev) {
  const r = worldCanvas.getBoundingClientRect();
  const mx = ev.clientX - r.left;
  const my = ev.clientY - r.top;
  let best = null;
  let bestD = Infinity;
  for (const h of creatureHits) {
    const d = Math.hypot(h.x - mx, h.y - my);
    if (d < h.r && d < bestD) { bestD = d; best = h; }
  }
  return best;
}
/* ---------- camera: causal lens and follow shots ---------- */

/** Focus in normalized world coords plus zoom; identity until something asks. */
const cam = { fx: 0.5, fy: 0.5, z: 1 };
window.__cam = cam;
/** { kind, id|addr|x|y, until, z } for leaderboard/whale/address follow shots. */
let follow = null;
/** Scripted first-visit sequence: money lands, food lands, somebody eats it. */
let causal = null;

function vx(bx) { return (bx - cam.fx * cssW) * cam.z + cssW / 2; }
function vy(by) { return (by - cam.fy * cssH) * cam.z + cssH / 2; }
function baseXFromView(v) { return (v - cssW / 2) / cam.z + cam.fx * cssW; }
function baseYFromView(v) { return (v - cssH / 2) / cam.z + cam.fy * cssH; }

/** Closed-form whale position, mirroring drawWhales, for camera targeting. */
function whaleWorldAt(w, t, W, H) {
  const lane = w.lane;
  if (!lane) return null;
  const u = ((lane.phaseU + t / lane.period) % 1.2) - 0.1;
  return { x: u * W, y: lane.lane * H + Math.sin(t / 23000 + lane.phaseY) * H * 0.05 };
}

function followCreature(id, ms) { follow = { kind: 'creature', id, until: clock() + ms, z: 2.4 }; }
function followWhale(addr, ms) { follow = { kind: 'whale', addr, until: clock() + ms, z: 2.2 }; }
function focusPoint(x, y, ms, z = 2.2) { follow = { kind: 'point', x, y, until: clock() + ms, z }; }

function setCausalCard(key, params) {
  const el = document.getElementById('causal-card');
  if (!el) return;
  if (!key) { el.hidden = true; return; }
  el.hidden = false;
  el.textContent = t(key, params);
}

function camGoal(now, snap) {
  if (causal) {
    const el = now - causal.t0;
    if (el < 3500) {
      setCausalCard('causalPay', causal.meta);
      return { fx: causal.x / snap.width, fy: causal.y / snap.height, z: 2.4 };
    }
    if (el < 7500 && causal.creatureId != null) {
      const c = snap.byId.get(causal.creatureId);
      if (c) {
        setCausalCard('causalEat', { name: c.name ?? `#${c.id}` });
        return { fx: c.x / snap.width, fy: c.y / snap.height, z: 2.0 };
      }
    }
    if (el < 9500) { setCausalCard(null); return { fx: 0.5, fy: 0.5, z: 1 }; }
    causal = null;
    setCausalCard(null);
  }
  if (follow) {
    if (now >= follow.until) follow = null;
    else if (follow.kind === 'creature') {
      const c = snap.byId.get(follow.id);
      if (c) return { fx: c.x / snap.width, fy: c.y / snap.height, z: follow.z };
    } else if (follow.kind === 'whale') {
      const w = chainWhales.find((x) => x.address === follow.addr);
      const at = w ? whaleWorldAt(w, now - (clockOffset ?? 0), snap.width, snap.height) : null;
      if (at) return { fx: at.x / snap.width, fy: at.y / snap.height, z: follow.z };
    } else {
      return { fx: follow.x / snap.width, fy: follow.y / snap.height, z: follow.z };
    }
  }
  return { fx: 0.5, fy: 0.5, z: 1 };
}

/** First visit: ride one real transfer from chain to plankton to predator. */
function startCausal() {
  const snap = latestSnap;
  if (!snap) return;
  const real = impacts.filter((i) => i.meta).slice(-1)[0];
  if (!real) return;
  let best = null;
  let bd = Infinity;
  for (const c of snap.byId.values()) {
    const d = (c.x - real.x) ** 2 + (c.y - real.y) ** 2;
    if (d < bd) { bd = d; best = c; }
  }
  causal = { t0: clock(), x: real.x, y: real.y, meta: real.meta, creatureId: best?.id ?? null };
}

/** Local clock minus server clock (ms); null until first estimate. */
let clockOffset = null;
/** How far the offset may creep back up per poll, to follow real clock drift. */
const CLOCK_DRIFT_MS = 25;
/** Cursor for incremental meteor delivery: hash of the newest tx we hold. */
let lastTxHash = '';
/**
 * True while the next poll must be handled as a cold start, at boot, and again
 * after any stretch where we stopped polling. Without it a returning viewer is
 * handed every event that piled up while the tab was hidden, and replaying
 * minutes of history as effects is a strobe, not an ecosystem.
 */
let stale = true;

/**
 * Drop the interpolation timeline and re-anchor it. Buffered snapshots from
 * before a gap must not be paired with one from after it: the velocity derived
 * from that pair is spread over the whole gap, so every creature would slide
 * across the tank in a single step.
 */
function resetTimeline() {
  snapBuffer.length = 0;
  latestSnap = null;
  clockOffset = null;
}

async function poll() {
  const bootstrap = stale;
  try {
    const q = `since=${lastEventSeq}&tx=${encodeURIComponent(lastTxHash)}`;
    const snap = await getJSON(`/snapshot?${q}${bootstrap ? '&tail=6' : ''}`);
    const recv = clock();
    stale = false;
    if (bootstrap) resetTimeline();
    if (typeof snap.world.t === 'number') {
      // est is a one-way-delay sample, so it can only be inflated by a busy
      // event loop, never deflated. The true offset is the floor of the
      // samples: track the minimum and creep back up slowly for real drift,
      // otherwise one 2s hiccup anchors the render timeline seconds ahead.
      const est = recv - snap.world.t;
      if (clockOffset === null) clockOffset = est;
      else clockOffset = est < clockOffset ? est : Math.min(est, clockOffset + CLOCK_DRIFT_MS);
    }
    processSnapshot(snap.world, recv);
    state = snap.state;
    explorerTxUrl = snap.state.explorerTxUrl ?? explorerTxUrl;
    if (!chainCopyApplied) applyChainStrings();
    updateTopbar();
    updateBoard();
    renderFollowing();
    renderProps(snap.world.propositions);
    renderBurners(snap.world.burners);
    renderFactions(snap.world.cheers);
    renderDaily(snap.world.daily);
    renderMemorials(snap.world.obituaries);
    if (snap.events.length > 0) {
      for (const e of snap.events) lastEventSeq = Math.max(lastEventSeq, e.seq);
      if (bootstrap) {
        // Cold start: the server already capped this to the last few entries
        // (`tail=6`). They only feed the ticker and spawn no effects, so a
        // freshly loaded page opens as calm as one that has been watching.
        suppressFx = true;
        try {
          handleEvents(snap.events, true);
        } finally {
          suppressFx = false;
        }
      } else {
        handleEvents(snap.events);
      }
    }
    if (snap.txRain) {
      const rain = snap.txRain;
      if (rain.length > 0) lastTxHash = rain[rain.length - 1].hash;
      handleTxRain(rain);
    }
  } catch (err) {
    // Poll failures just delay the next snapshot; the render loop keeps
    // interpolating inside the buffer regardless. `stale` stays as it was, so a
    // failed resume attempt still gets the cold-start treatment next time.
    console.warn('poll failed', err);
  }
}
poll();
// A hidden tab has no rAF, so nothing would draw whatever we fetched. Skipping
// the poll entirely is the whole saving; the visibilitychange handler below
// refills immediately on return.
setInterval(() => { if (!document.hidden) poll(); }, POLL_MS);

async function pollAux() {
  try {
    // Names follow the payload they carry: a positional swap here once fed the
    // battle reports into the extinction lists and silently emptied them.
    const [hist, culls, rep] = await Promise.all([
      // The charts decimate to CHART_SLOTS points anyway, so asking the server
      // for the undecimated window meant transferring ~10x more JSON than any
      // pixel could show, 456 KB every 10s, larger than the snapshot stream.
      getJSON(`/history?window=${HISTORY_WINDOW}&slots=${CHART_SLOTS}`),
      getJSON('/judgments'),
      getJSON('/reports'),
    ]);
    lastStats = hist.stats;
    lastCulls = culls.judgments;
    renderReports(rep?.reports);
    // Badges and rank move slower than the tank: refresh on the aux cadence.
    if (myAddr && Date.now() - meFetchedAt > 30_000) fetchMe();
    drawCharts();
    renderObituaries(lastCulls);
  } catch { /* keep stale aux data */ }
}
pollAux();
setInterval(() => { if (!document.hidden) pollAux(); }, 10000);

/* ---------- OBSERVE: Arc USDC flow observatory ---------- */


/** Deterministic address -> angle on the flow-map ring (FNV-1a). */
function addrAngle(a) {
  let h = 2166136261;
  for (let i = 0; i < a.length; i++) {
    h ^= a.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (((h >>> 0) % 36000) / 36000) * Math.PI * 2;
}

function resizeObserve() {
  for (const c of [flowCanvas, pulseCanvas]) {
    const r = c.getBoundingClientRect();
    if (r.width === 0) continue;
    c.width = Math.round(r.width * DPR);
    c.height = Math.round(r.height * DPR);
  }
  drawFlowmap();
  drawPulse();
}
window.addEventListener('resize', () => {
  if (view === 'observe') resizeObserve();
});

async function pollObserve() {
  try {
    const d = await getJSON('/observe');
    observeAvailable = !!d.available;
    const empty = document.getElementById('observe-empty');
    if (!observeAvailable) {
      obsData = null;
      empty.hidden = false;
      document.getElementById('ticker').hidden = true;
      return;
    }
    empty.hidden = true;
    obsData = d;
    renderObsStats();
    renderObsEndpoints();
    if (addrCardAddr && !document.getElementById('addr-card').hidden) openAddrCard(addrCardAddr);
    drawPulse();
    document.getElementById('ticker').hidden = view !== 'observe';
    buildTicker();
  } catch { /* keep stale observatory data */ }
}
setInterval(() => {
  if (view === 'observe' && !document.hidden) pollObserve();
}, 3000);

/**
 * Returning to a tab that has been hidden is a soft cold start: every poller
 * was paused, so the timeline, the clock anchor and the event cursor are all
 * out of date. Refill immediately instead of waiting up to a full interval, and
 * let poll() treat the batch as a bootstrap so the backlog does not detonate.
 */
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  stale = true;
  poll();
  pollAux();
  if (view === 'observe' && observeAvailable) pollObserve();
});
// Probe once at boot: when the Arc feed is live, land on OBSERVE.
pollObserve().then(() => {
  if (observeAvailable) setView('observe');
});

function renderObsStats() {
  const s = obsData.stats;
  const stats = [
    [t('obsTransfers'), s.transfers.toLocaleString(), ''],
    [t('obsVolume'), fmtUsd(s.volume), ''],
    [t('obsX402Share'), `${(s.x402Share * 100).toFixed(1)}%`, 'gold'],
    [t('obsBlock'), `#${obsData.lastBlock.toLocaleString()}`, 'sm'],
  ];
  document.getElementById('obs-stats').innerHTML = stats
    .map(([k, v, cls]) => `<div class="obs-stat"><span class="label">${k}</span><span class="value ${cls}">${v}</span></div>`)
    .join('');
  document.getElementById('obs-window').textContent = t('obsWindow', { n: Math.round(obsData.windowSeconds / 60) });
  document.getElementById('pulse-sub').textContent = t('pulseHint');
}

function renderObsEndpoints() {
  const el = document.getElementById('endpoints');
  const max = Math.max(...obsData.endpoints.map((e) => e.volume), 1);
  el.innerHTML = '';
  obsData.endpoints.forEach((e, i) => {
    const row = document.createElement('div');
    row.className = i < 3 ? 'ep top' : 'ep';
    row.innerHTML =
      `<span class="rank">${i + 1}</span>` +
      `<span class="mid"><span class="addr">${shortAddr(e.address)}</span>` +
      `<span class="volbar" style="width:${Math.round((e.volume / max) * 100)}%"></span></span>` +
      `<span class="right"><span class="amt">${fmtUsd(e.volume)}</span>` +
      (e.x402 > 0 ? `<span class="x4tag">x402 ×${e.x402}</span>` : '') +
      `</span>`;
    row.addEventListener('click', () => openAddrCard(e.address));
    el.appendChild(row);
  });
}

/* ---------- address detail drawer (observatory) ---------- */
let addrCardAddr = null;

async function openAddrCard(address) {
  addrCardAddr = address;
  const card = document.getElementById('addr-card');
  const addr = address.toLowerCase();
  // The shared /observe snapshot only carries the last 160 flows, so a hot
  // endpoint ranked over the 5-min window would look empty here. Ask the
  // server for this address's own window-scoped history instead.
  let mine = [];
  let stats = null;
  try {
    const res = await fetch(`/observe?addr=${encodeURIComponent(address)}`);
    const data = await res.json();
    if (data.available && Array.isArray(data.flows)) {
      mine = data.flows;
      stats = data.stats;
    }
  } catch { /* offline poll: fall back to the cached snapshot below */ }
  if (addrCardAddr !== address) return;
  if (!stats) {
    mine = (obsData?.flows ?? []).filter((f) => f.from.toLowerCase() === addr || f.to.toLowerCase() === addr);
  }
  let inV = 0; let outV = 0; let x4 = 0;
  for (const f of mine) {
    if (f.to.toLowerCase() === addr) inV += f.amount;
    if (f.from.toLowerCase() === addr) outV += f.amount;
    if (f.x402) x4++;
  }
  if (stats) { inV = stats.inVolume; outV = stats.outVolume; x4 = stats.x402; }
  const count = stats ? stats.count : mine.length;
  card.querySelector('.addr-h').textContent = shortAddr(address);
  card.querySelector('.addr-h').title = address;
  const statRows = [
    [t('addrIn'), fmtUsd(inV), ''],
    [t('addrOut'), fmtUsd(outV), ''],
    [t('addrTxns'), count.toLocaleString(), ''],
    [t('addrX402'), count ? `${((x4 / count) * 100).toFixed(0)}%` : '–', 'gold'],
  ];
  document.getElementById('addr-stats').innerHTML = statRows
    .map(([k, v, cls]) => `<div class="tx-row"><span class="k">${k}</span><span class="v ${cls}">${v}</span></div>`)
    .join('');
  document.getElementById('addr-flows').innerHTML = mine.length
    ? mine.slice(-24).reverse().map((f) => {
        const isIn = f.to.toLowerCase() === addr;
        const other = isIn ? f.from : f.to;
        return `<div class="af ${isIn ? 'in' : 'out'}${f.x402 ? ' x402' : ''}">` +
          `<span class="dir">${isIn ? '↓' : '↑'}</span>` +
          `<span class="who" title="${other}">${shortAddr(other)}</span>` +
          `<span class="amt">${f.amount >= 1000 ? fmtUsd(f.amount) : `${f.amount.toFixed(2)} USDC`}</span>` +
          `<span class="when">${new Date(f.t).toTimeString().slice(0, 8)}</span></div>`;
      }).join('')
    : `<div class="addr-empty">${t('addrEmpty')}</div>`;
  // Resolve at open time: the server-provided explorer URL may not have
  // arrived yet on the very first render.
  card.querySelector('a.explore').href = explorerTxUrl.replace(/\/tx\/?$/, '/address/') + address;
  // Jump back into the tank: follow this address's whale if the window ranks
  // it, otherwise the button stays hidden (no whale, nothing to follow).
  const jump = document.getElementById('addr-world');
  jump.hidden = !chainWhales.some((w) => w.address.toLowerCase() === addr);
  renderAddrTank(address);
  card.hidden = false;
}

/**
 * The tank half of an address: what it burned, what it earned, and how its
 * interventions turned out. Hidden for an address the tank has never seen, so
 * a plain chain whale does not get an empty standing block.
 */
async function renderAddrTank(address) {
  const wrap = document.getElementById('addr-tank');
  const body = document.getElementById('addr-tank-body');
  wrap.hidden = true;
  try {
    const res = await fetch(`/who?addr=${encodeURIComponent(address)}`);
    if (!res.ok) return;
    const w = await res.json();
    if (addrCardAddr !== address.toLowerCase()) return;
    if (!w.known && !w.pass?.active && !w.cheer) return;
    const line = (k, v) => `<div class="prop"><span>${t(k)}</span><b>${v}</b></div>`;
    body.innerHTML =
      line('burnedTotal', `${w.burned.toLocaleString()} ABYS`) +
      line('burnCount', w.burns) +
      (w.rank ? line('boardRank', `#${w.rank}`) : '') +
      (w.pass?.active ? line('passLabel', `D${Math.floor(w.pass.until / 19200)}`) : '') +
      (w.cheer ? line('rallyingFor', w.cheer) : '') +
      (w.badges?.length ? `<div class="chips">${badgeChips(w.badges)}</div>` : '') +
      (w.reports?.length
        ? `<div class="addr-sub">${t('reportsTitle')}</div>` +
          w.reports
            .map((r) => `<div class="prop"><span>${r.type} · ${r.affected}</span>` +
              `<b>${r.score === undefined ? '…' : `${r.score} ${r.score > 0 ? t('scoreWorth') : t('scoreWaste')}`}</b></div>`)
            .join('')
        : '');
    wrap.hidden = false;
  } catch { /* the chain half is enough on its own */ }
}

document.getElementById('addr-world').addEventListener('click', () => {
  if (!addrCardAddr) return;
  setView('world');
  followWhale(addrCardAddr, 8000);
});
document.querySelector('#addr-card .tx-close').addEventListener('click', () => {
  addrCardAddr = null;
  document.getElementById('addr-card').hidden = true;
});

/** Rotating single-line ticker of the newest real flows. */
let tickerIdx = 0;
function buildTicker() {
  renderTickerItem();
}
function renderTickerItem() {
  const flows = obsData?.flows;
  const el = document.getElementById('ticker');
  if (!flows || flows.length === 0) {
    el.hidden = true;
    return;
  }
  const f = flows[flows.length - 1 - (tickerIdx % flows.length)];
  tickerIdx++;
  el.innerHTML =
    `<span class="tick ${f.x402 === true ? 'x402' : ''}">` +
    `<i class="dot"></i>${shortAddr(f.from)} <span class="arrow">→</span> ${shortAddr(f.to)}` +
    ` <span class="amt">${f.amount >= 1000 ? fmtUsd(f.amount) : `${f.amount.toFixed(2)} USDC`}</span>` +
    (f.x402 === true ? ' <span class="arrow">x402</span>' : '') +
    `</span>`;
  el.onclick = () => showTxCard(f);
}
setInterval(() => {
  if (view === 'observe' && observeAvailable) renderTickerItem();
}, 2600);

function drawFlowmap(now = clock()) {
  if (!obsData || flowCanvas.width === 0) return;
  const w = flowCanvas.width / DPR;
  const h = flowCanvas.height / DPR;
  fctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  fctx.clearRect(0, 0, w, h);
  const cx = w / 2;
  const cy = h / 2;
  const R = Math.min(w, h) * 0.42;

  // Deep-space vignette + faint guide rings.
  const vig = fctx.createRadialGradient(cx, cy, 0, cx, cy, R * 1.25);
  vig.addColorStop(0, 'rgba(77, 208, 225, 0.055)');
  vig.addColorStop(0.65, 'rgba(77, 208, 225, 0.015)');
  vig.addColorStop(1, 'rgba(0, 0, 0, 0)');
  fctx.fillStyle = vig;
  fctx.fillRect(0, 0, w, h);
  fctx.strokeStyle = 'rgba(120, 160, 220, 0.07)';
  fctx.lineWidth = 1;
  for (const rr of [0.55, 0.8]) {
    fctx.beginPath();
    fctx.arc(cx, cy, R * rr, 0, Math.PI * 2);
    fctx.stroke();
  }
  fctx.strokeStyle = 'rgba(120, 160, 220, 0.14)';
  fctx.beginPath();
  fctx.arc(cx, cy, R, 0, Math.PI * 2);
  fctx.stroke();

  const flows = obsData.flows;
  const pt = (a) => {
    const ang = addrAngle(a);
    return [cx + Math.cos(ang) * R, cy + Math.sin(ang) * R];
  };

  // Chords: newer flows brighter; x402 gold, plain cyan. Two passes per
  // chord (wide soft halo + bright core) give the glow without shadowBlur.
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < flows.length; i++) {
      const f = flows[i];
      const [x1, y1] = pt(f.from);
      const [x2, y2] = pt(f.to);
      const mx = cx + ((x1 + x2) / 2 - cx) * 0.22;
      const my = cy + ((y1 + y2) / 2 - cy) * 0.22;
      const rec = (i + 1) / flows.length;
      const core = Math.min(3.2, 0.4 + Math.log10(f.amount + 1) * 0.85);
      if (pass === 0) {
        fctx.globalAlpha = (0.04 + 0.42 * rec * rec) * 0.22;
        fctx.lineWidth = core * 3.2;
      } else {
        fctx.globalAlpha = 0.05 + 0.5 * rec * rec;
        fctx.lineWidth = core;
      }
      fctx.strokeStyle = f.x402 === true ? '#ffd166' : '#4dd0e1';
      fctx.beginPath();
      fctx.moveTo(x1, y1);
      fctx.quadraticCurveTo(mx, my, x2, y2);
      fctx.stroke();
    }
  }
  // Travelling packets with a short trail on the newest arcs.
  for (let i = Math.max(0, flows.length - 16); i < flows.length; i++) {
    const f = flows[i];
    const [x1, y1] = pt(f.from);
    const [x2, y2] = pt(f.to);
    const mx = cx + ((x1 + x2) / 2 - cx) * 0.22;
    const my = cy + ((y1 + y2) / 2 - cy) * 0.22;
    const p0 = ((now / 1500) + (flows.length - i) * 0.11) % 1;
    for (let s = 0; s < 3; s++) {
      const p = p0 - s * 0.035;
      if (p < 0 || p > 1) continue;
      const bx = (1 - p) * (1 - p) * x1 + 2 * (1 - p) * p * mx + p * p * x2;
      const by = (1 - p) * (1 - p) * y1 + 2 * (1 - p) * p * my + p * p * y2;
      fctx.globalAlpha = (0.9 - s * 0.3);
      fctx.fillStyle = f.x402 === true ? '#ffe9b0' : '#bff2fa';
      fctx.beginPath();
      fctx.arc(bx, by, 1.8 - s * 0.45, 0, Math.PI * 2);
      fctx.fill();
    }
  }
  fctx.globalAlpha = 1;

  // Address nodes on the ring, sized by participation; hot ones get a halo.
  const counts = new Map();
  for (const f of flows) {
    counts.set(f.from, (counts.get(f.from) ?? 0) + 1);
    counts.set(f.to, (counts.get(f.to) ?? 0) + 1);
  }
  for (const [a, n] of counts) {
    const [x, y] = pt(a);
    const r = Math.min(5, 1.4 + Math.sqrt(n) * 0.7);
    if (n >= 6) {
      fctx.strokeStyle = 'rgba(255, 209, 102, 0.28)';
      fctx.lineWidth = 2;
      fctx.beginPath();
      fctx.arc(x, y, r + 3.5, 0, Math.PI * 2);
      fctx.stroke();
    }
    fctx.fillStyle = n >= 6 ? 'rgba(255, 209, 102, 0.95)' : 'rgba(160, 200, 240, 0.75)';
    fctx.beginPath();
    fctx.arc(x, y, r, 0, Math.PI * 2);
    fctx.fill();
  }

  // Labels for the top endpoints.
  fctx.font = '9px monospace';
  fctx.fillStyle = 'rgba(201, 214, 232, 0.55)';
  for (const e of (obsData.endpoints ?? []).slice(0, w < 620 ? 4 : 6)) {
    const ang = addrAngle(e.address);
    const x = cx + Math.cos(ang) * R;
    const y = cy + Math.sin(ang) * R;
    fctx.textAlign = Math.cos(ang) > 0 ? 'left' : 'right';
    fctx.textBaseline = Math.sin(ang) > 0 ? 'top' : 'bottom';
    fctx.fillText(shortAddr(e.address), x + Math.cos(ang) * 9, y + Math.sin(ang) * 9);
  }
}

let pulseHover = -1;
/** Display columns: raw 15s buckets merged so the chart stays around 96 bars. */
let pulseBars = [];

function computePulseBars(pts) {
  const group = Math.max(1, Math.ceil(pts.length / 96));
  const bars = [];
  for (let i = 0; i < pts.length; i += group) {
    const slice = pts.slice(i, i + group);
    bars.push({
      t: slice[0].t,
      span: slice.length * 15,
      volume: slice.reduce((s, p) => s + p.volume, 0),
      count: slice.reduce((s, p) => s + p.count, 0),
      x402: slice.reduce((s, p) => s + p.x402, 0),
    });
  }
  return bars;
}

/** Rounded-top column; radius clamped so hairline bars stay crisp, not bulbous. */
function capBar(ctx, x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, w / 2, h));
  ctx.beginPath();
  ctx.moveTo(x, y + h);
  ctx.lineTo(x, y + rr);
  ctx.arcTo(x, y, x + rr, y, rr);
  ctx.lineTo(x + w - rr, y);
  ctx.arcTo(x + w, y, x + w, y + rr, rr);
  ctx.lineTo(x + w, y + h);
  ctx.closePath();
  ctx.fill();
}

function drawPulse() {
  if (!obsData?.pulse?.length || pulseCanvas.width === 0) return;
  const w = pulseCanvas.width / DPR;
  const h = pulseCanvas.height / DPR;
  pctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  pctx.clearRect(0, 0, w, h);
  const bars = (pulseBars = computePulseBars(obsData.pulse));
  if (replayOn && clock() - replayStart > REPLAY_MS) {
    replayOn = false;
    const btn = document.getElementById('pulse-play');
    if (btn) btn.textContent = '\u25B6';
  }
  const max = Math.max(...bars.map((p) => p.volume), 0.001);
  const top = 10;
  const plotH = h - top - 15;
  const base = top + plotH;
  const bw = w / bars.length;
  // Centered columns with a consistent breathing gap: never a solid wall,
  // never hairlines, whatever the bucket count or canvas width.
  const barW = Math.max(2, Math.min(bw * 0.62, 12));

  // Faint dotted grid at quarter steps, brighter axis line at the floor.
  pctx.save();
  pctx.strokeStyle = 'rgba(96, 132, 184, 0.22)';
  pctx.lineWidth = 1;
  pctx.setLineDash([2, 4]);
  for (const f of [0.25, 0.5, 0.75]) {
    const y = Math.round(base - f * plotH) + 0.5;
    pctx.beginPath();
    pctx.moveTo(0, y);
    pctx.lineTo(w, y);
    pctx.stroke();
  }
  pctx.restore();
  pctx.strokeStyle = 'rgba(96, 132, 184, 0.4)';
  pctx.lineWidth = 1;
  pctx.beginPath();
  pctx.moveTo(0, base + 0.5);
  pctx.lineTo(w, base + 0.5);
  pctx.stroke();

  const grad = pctx.createLinearGradient(0, top, 0, base);
  grad.addColorStop(0, 'rgba(126, 224, 240, 0.95)');
  grad.addColorStop(0.55, 'rgba(77, 190, 225, 0.45)');
  grad.addColorStop(1, 'rgba(77, 190, 225, 0.06)');
  const gold = pctx.createLinearGradient(0, top, 0, base);
  gold.addColorStop(0, 'rgba(255, 224, 140, 1)');
  gold.addColorStop(1, 'rgba(255, 190, 90, 0.6)');
  if (pulseHover >= 0 && pulseHover < bars.length) {
    pctx.fillStyle = 'rgba(140, 190, 255, 0.09)';
    pctx.fillRect(pulseHover * bw, top, bw, plotH);
  }
  for (let i = 0; i < bars.length; i++) {
    const p = bars[i];
    if (p.volume <= 0) continue;
    const bh = Math.max(1.5, Math.pow(p.volume / max, 0.72) * plotH);
    const x = i * bw + (bw - barW) / 2;
    const y = base - bh;
    pctx.fillStyle = grad;
    capBar(pctx, x, y, barW, bh, barW / 2);
    if (p.x402 > 0 && p.count > 0) {
      // Gold segment proportional to the x402 share of the column.
      const xh = Math.max(1.5, bh * (p.x402 / p.count));
      pctx.fillStyle = gold;
      capBar(pctx, x, y, barW, xh, barW / 2);
    }
    // Bright cap dot, additive so busy columns read as a glowing skyline.
    pctx.globalCompositeOperation = 'lighter';
    pctx.fillStyle = p.x402 > 0 && p.count > 0
      ? 'rgba(255, 236, 180, 0.7)'
      : 'rgba(190, 246, 255, 0.5)';
    pctx.beginPath();
    pctx.arc(x + barW / 2, y, Math.max(0.9, barW / 2), 0, Math.PI * 2);
    pctx.fill();
    pctx.globalCompositeOperation = 'source-over';
  }

  if (replayOn && bars.length) {
    const playhead = clock() - REPLAY_MS + (clock() - replayStart);
    let idx = 0;
    for (let i = 0; i < bars.length; i++) if ((bars[i].t ?? 0) <= playhead) idx = i;
    const x = idx * bw + bw / 2;
    pctx.strokeStyle = 'rgba(255, 236, 180, 0.8)';
    pctx.lineWidth = 1;
    pctx.beginPath();
    pctx.moveTo(x, top);
    pctx.lineTo(x, base);
    pctx.stroke();
    const b = bars[idx];
    pctx.fillStyle = 'rgba(255, 236, 180, 0.9)';
    pctx.fillText(`${fmtUsd(b.volume)} · ${Math.round((b.x402 / Math.max(1, b.count)) * 100)}% x402`, x + 4, 0);
  }

  pctx.fillStyle = 'rgba(201, 214, 232, 0.45)';
  pctx.font = '9px monospace';
  pctx.textBaseline = 'top';
  pctx.textAlign = 'left';
  pctx.fillText(`peak ${fmtUsd(max)}`, 3, 0);
  // Window ends as clock time.
  const clock = (t) => new Date(t).toTimeString().slice(0, 8);
  pctx.fillStyle = 'rgba(201, 214, 232, 0.32)';
  pctx.textBaseline = 'bottom';
  pctx.fillText(clock(bars[0].t), 3, h - 2);
  pctx.textAlign = 'right';
  pctx.fillText(clock(bars[bars.length - 1].t + bars[bars.length - 1].span * 1000), w - 3, h - 2);
}

// Column inspector: the pulse chart reads as noise until you can probe a bar.
pulseCanvas.addEventListener('mousemove', (ev) => {
  const bars = pulseBars;
  if (bars.length === 0) return;
  const r = pulseCanvas.getBoundingClientRect();
  const i = Math.min(bars.length - 1, Math.max(0, Math.floor(((ev.clientX - r.left) / r.width) * bars.length)));
  if (i !== pulseHover) { pulseHover = i; drawPulse(); }
  const p = bars[i];
  const clock = (t) => new Date(t).toTimeString().slice(0, 8);
  const when = p.span > 15 ? `${clock(p.t)}–${clock(p.t + p.span * 1000)}` : clock(p.t);
  tipEl.hidden = false;
  tipEl.innerHTML = `<b>${when}</b> · ${fmtUsd(p.volume)}<br>` +
    `${t('obsTransfers')} ${p.count} · x402 ${p.x402}`;
  tipEl.style.left = `${Math.min(ev.clientX + 14, window.innerWidth - tipEl.offsetWidth - 8)}px`;
  tipEl.style.top = `${Math.min(ev.clientY + 14, window.innerHeight - tipEl.offsetHeight - 8)}px`;
});
pulseCanvas.addEventListener('mouseleave', () => { tipEl.hidden = true; pulseHover = -1; drawPulse(); });

/* ---------- tx provenance card (shared by both views) ---------- */

function showTxCard(flow) {
  const el = document.getElementById('tx-card');
  el.hidden = false;
  const x402 = flow.x402 === true;
  el.innerHTML =
    `<span class="tx-close">×</span>` +
    `<div class="tx-h">${flow.tx}</div>` +
    `<div class="tx-row"><span class="k">${t('txFrom')}</span><span class="v">${shortAddr(flow.from)}</span></div>` +
    `<div class="tx-row"><span class="k">${t('txTo')}</span><span class="v">${shortAddr(flow.to)}</span></div>` +
    `<div class="tx-row"><span class="k">${t('txAmount')}</span><span class="v">${flow.amount >= 1000 ? fmtUsd(flow.amount) : `${flow.amount.toFixed(2)} USDC`}</span></div>` +
    (flow.block ? `<div class="tx-row"><span class="k">${t('txBlock')}</span><span class="v">#${flow.block.toLocaleString()}</span></div>` : '') +
    ((worldEaters[flow.tx] ?? []).length
      ? `<div class="tx-row"><span class="k">${t('eatenBy')}</span><span class="v">${(worldEaters[flow.tx] ?? [])
          .map((id) => latestSnap?.byId.get(id)?.name ?? `#${id}`)
          .join(', ')}</span></div>`
      : '') +
    `<div>${x402 ? `<span class="x402-badge">x402</span> ${t('txX402Note')}` : t('txPlainNote')}</div>` +
    `<a class="explore" href="${explorerTxUrl}${flow.tx}" target="_blank" rel="noopener">${t('txVerify')}</a>`;
  el.querySelector('.tx-close').addEventListener('click', () => { el.hidden = true; });
}

/**
 * Payment-mode copy: dual USDC/ABYS prices on the intervention buttons, plus
 * the settlement badge and the dock's token line. Re-runs on language change
 * (applyStaticI18n restores the generic keys first).
 */
function applyChainStrings() {
  document.querySelectorAll('button.iv').forEach((btn) => {
    const type = btn.dataset.type;
    const abys = state.prices?.[type];
    const priceEl = btn.querySelector('.price');
    if (priceEl && abys) priceEl.textContent = `${abys} ABYS · ${t('burnLabel')}`;
  });
  const pay = state.payment;
  const badge = document.getElementById('pay-badge');
  if (badge && pay) {
    badge.hidden = false;
    badge.dataset.mode = pay.mode;
    badge.textContent = pay.mode === 'burn' ? t('payBadgeBurn') : t('payBadgeUnconfigured');
  }
  const dockToken = document.getElementById('dock-token');
  if (dockToken) {
    dockToken.textContent = pay?.mode === 'burn' ? t('dockTokenBurn') : t('dockTokenUnconfigured');
  }
  chainCopyApplied = true;
}

/* ---------- top bar + FPS ---------- */

let fpsFrames = 0;
let fpsLast = clock();
let fpsEma = 60;
let dprAdjustAt = clock();

// Adaptive resolution: shed device pixels when the frame budget slips,
// climb back once there is headroom again.
function adaptDpr(fps, now) {
  fpsEma = fpsEma * 0.7 + fps * 0.3;
  if (now - dprAdjustAt < 3000) return;
  if (fpsEma < 45 && DPR > 1) {
    DPR = Math.max(1, DPR - 0.5);
  } else if (fpsEma > 55 && DPR < DPR_NATIVE) {
    DPR = Math.min(DPR_NATIVE, DPR + 0.5);
  } else {
    return;
  }
  dprAdjustAt = now;
  resize();
  if (view === 'observe') resizeObserve();
}

function fpsTick() {
  fpsFrames++;
  const now = clock();
  if (now - fpsLast >= 500) {
    const fps = Math.round((fpsFrames * 1000) / (now - fpsLast));
    document.getElementById('fps').textContent = fps;
    adaptDpr(fps, now);
    fpsFrames = 0;
    fpsLast = now;
  }
}

function fmtCountdown(ticksRemaining, ticksPerHour) {
  const hours = ticksRemaining / ticksPerHour;
  if (hours < 1) return t('inMinutes', { n: Math.max(1, Math.round(hours * 60)) });
  return t('inHours', { n: Math.ceil(hours) });
}

function updateTopbar() {
  if (!state) return;
  const ticksPerHour = state.ticksPerDay / 24;
  document.getElementById('day').textContent = state.day;
  document.getElementById('pop').textContent = state.population;

  // LIVE / SIM / DEGRADED indicator from the chain feed status.
  const liveDot = document.getElementById('live-dot');
  const liveLabel = document.getElementById('live-label');
  const status = state.feedStatus ?? 'synthetic';
  liveDot.className = `livedot ${status === 'live' ? 'live' : status === 'degraded' ? 'degraded' : ''}`;
  liveLabel.textContent = status === 'live'
    ? t('liveBlock', { n: state.blockNumber ?? '–' })
    : status === 'degraded' ? t('degradedLabel') : t('simLabel');
  document.getElementById('rain-status').textContent =
    status === 'live' ? '· LIVE' : status === 'degraded' ? `· ${t('degradedLabel')}` : '· SIM';

  const ct = state.chainTemp;
  const chainVal = document.getElementById('chain-val');
  const regime = regimeOf(ct);
  chainVal.textContent = regime === 2 ? t('feast') : regime === 1 ? t('normal') : t('famine');
  chainVal.style.color = regime === 2 ? '#4ade80' : regime === 1 ? 'var(--fg-1)' : '#8fa8d8';
  const chainDot = document.getElementById('chain-dot');
  chainDot.style.background = `hsl(${200 - ct * 180}, 85%, 60%)`;
  chainDot.style.color = chainDot.style.background;

  // Regime change banner (human words, no numbers).
  if (lastRegime !== -1 && regime !== lastRegime) {
    if (regime === 2) showTextBanner(t('regimeHot'), '#4ade80');
    else if (regime === 0) showTextBanner(t('regimeCold'), '#8fa8d8');
  }
  lastRegime = regime;

  const m = state.marketTemp ?? 0;
  const marketVal = document.getElementById('market-val');
  marketVal.textContent = m > 0.5 ? t('wild') : t('calm');
  const marketDot = document.getElementById('market-dot');
  marketDot.style.background = `hsl(${140 - m * 140}, 80%, 55%)`;
  marketDot.style.color = marketDot.style.background;

  document.getElementById('harvest-val').textContent =
    fmtCountdown(state.harvest.ticksRemaining, ticksPerHour);
  document.getElementById('judgment-val').textContent =
    fmtCountdown(state.judgment.ticksRemaining, ticksPerHour);

  if (state.dayAnchor) {
    document.getElementById('day-digest').textContent =
      `D${state.dayAnchor.day} · ${state.dayAnchor.digest}`;
  }
}

/* ---------- world rendering ---------- */

function torusLerp(a, b, size, k) {
  return (((a + torusDelta(a, b, size) * k) % size) + size) % size;
}

/** Shortest-arc angle interpolation (handles the -π/π wrap). */
function lerpAngle(a, b, k) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * k;
}

/**
 * v7 tank: stratified deep-sea cross-section. Lit surface, drifting particulate,
 * depth fog, rock strata walls, sediment floor. Money still falls as gold.
 */

/* ---------- the water: a stratified deep-sea cross-section ---------- */

/** Deterministic 0..1 from an integer, so every viewer draws the same water. */
function strataNoise(i) {
  let x = (i ^ 0x9e3779b9) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
}

function drawDepthFrame(now, chainTemp) {
  const g = wctx;
  const W = cssW;
  const H = cssH;
  const t = now / 1000;

  // Water column: lit teal at the surface down to near-black at the floor.
  const water = g.createLinearGradient(0, 0, 0, H);
  water.addColorStop(0, '#0a2a33');
  water.addColorStop(0.14, '#07202a');
  water.addColorStop(0.5, '#04141c');
  water.addColorStop(1, '#01060a');
  g.fillStyle = water;
  g.fillRect(0, 0, W, H);

  // Surface: a bright band with two slow caustic waves.
  const surf = g.createLinearGradient(0, 0, 0, H * 0.1);
  const surfA = 0.22 + 0.4 * dayLight();
  surf.addColorStop(0, hsl(186, 60, 46, surfA));
  surf.addColorStop(1, hsl(186, 60, 46, 0));
  g.fillStyle = surf;
  g.fillRect(0, 0, W, H * 0.1);
  g.strokeStyle = hsl(186, 80, 78, 0.14 + 0.26 * dayLight());
  g.lineWidth = 1.2;
  for (let k = 0; k < 2; k++) {
    g.beginPath();
    for (let x = 0; x <= W; x += 8) {
      const y = 6 + k * 7 + Math.sin(x / 90 + t * (0.5 + k * 0.2)) * 2.4;
      if (x === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    g.stroke();
  }

  // Depth strata: three fog bands that breathe very slowly.
  for (let i = 0; i < 3; i++) {
    const y = H * (0.32 + i * 0.22) + Math.sin(t * 0.07 + i * 2) * 6;
    const band = g.createLinearGradient(0, y - 26, 0, y + 26);
    band.addColorStop(0, hsl(200, 40, 60, 0));
    band.addColorStop(0.5, hsl(200, 40, 62, 0.06));
    band.addColorStop(1, hsl(200, 40, 60, 0));
    g.fillStyle = band;
    g.fillRect(0, y - 26, W, 52);
  }

  // Rock strata walls: layered cut-away bands on both edges.
  for (const side of [0, 1]) {
    const w = W * 0.075;
    for (let i = 0; i < 9; i++) {
      const y0 = (H / 9) * i + strataNoise(i * 7 + side * 31) * 14;
      const h = H / 9 + 6;
      const l = 8 + strataNoise(i * 13 + side * 17) * 7;
      g.fillStyle = hsl(205, 22, l, 0.9);
      g.beginPath();
      if (side === 0) {
        g.moveTo(0, y0);
        g.quadraticCurveTo(w * (0.42 + strataNoise(i + side) * 0.3), y0 + h * 0.5, 0, y0 + h);
      } else {
        g.moveTo(W, y0);
        g.quadraticCurveTo(W - w * (0.42 + strataNoise(i + side) * 0.3), y0 + h * 0.5, W, y0 + h);
      }
      g.closePath();
      g.fill();
      // A faint lighter seam between strata.
      g.strokeStyle = hsl(190, 35, 46, 0.2);
      g.lineWidth = 1;
      g.beginPath();
      if (side === 0) g.moveTo(0, y0 + 1);
      else g.moveTo(W, y0 + 1);
      if (side === 0) g.lineTo(w * 0.5, y0 + h * 0.5);
      else g.lineTo(W - w * 0.5, y0 + h * 0.5);
      g.stroke();
    }
  }

  // Sediment floor with two rock silhouettes.
  const floor = g.createLinearGradient(0, H * 0.9, 0, H);
  floor.addColorStop(0, hsl(210, 25, 10, 0));
  floor.addColorStop(1, hsl(210, 25, 8, 0.95));
  g.fillStyle = floor;
  g.fillRect(0, H * 0.9, W, H * 0.1);
  g.fillStyle = hsl(210, 20, 7, 0.9);
  for (const [fx, fr] of [[0.22, 46], [0.78, 62]]) {
    g.beginPath();
    g.ellipse(W * fx, H + fr * 0.35, fr, fr * 0.55, 0, Math.PI, TAU);
    g.fill();
  }

  // Marine snow: density follows chain activity, fall is slow and seeded.
  const motes = Math.round(40 + chainTemp * 90);
  g.fillStyle = hsl(190, 40, 80, 0.16);
  for (let i = 0; i < motes; i++) {
    const seed = strataNoise(i);
    const x = (seed * W + Math.sin(t * 0.3 + i) * 12) % W;
    const y = (strataNoise(i + 500) * H + t * (6 + seed * 10)) % H;
    const r = 0.6 + strataNoise(i + 900) * 1.1;
    g.globalAlpha = 0.08 + strataNoise(i + 40) * 0.14;
    g.beginPath();
    g.arc(x, y, r, 0, TAU);
    g.fill();
  }
  g.globalAlpha = 1;

  // Money falls as gold light shafts from the surface. Three nested trapezoids
  // fake a soft edge; a real blur or an erase pass would cost the whole frame.
  const shafts = 5;
  for (let i = 0; i < shafts; i++) {
    const x = W * (0.15 + 0.7 * strataNoise(i + 77)) + Math.sin(t * 0.2 + i) * 20;
    const w = 12 + strataNoise(i + 3) * 24;
    const a = (0.028 + 0.02 * Math.sin(t * 0.6 + i * 2)) * (0.6 + chainTemp * 0.6);
    for (let k = 0; k < 3; k++) {
      const ww = w * (1 - k * 0.3);
      const shaft = g.createLinearGradient(0, 0, 0, H * 0.85);
      shaft.addColorStop(0, hsl(42, 90, 64, Math.max(0, a * (0.5 + k * 0.35))));
      shaft.addColorStop(0.7, hsl(42, 90, 64, Math.max(0, a * 0.25 * (0.5 + k * 0.35))));
      shaft.addColorStop(1, hsl(42, 90, 64, 0));
      g.fillStyle = shaft;
      g.beginPath();
      g.moveTo(x - ww * 0.22, 0);
      g.lineTo(x + ww * 0.22, 0);
      g.lineTo(x + ww, H * 0.85);
      g.lineTo(x - ww, H * 0.85);
      g.closePath();
      g.fill();
    }
  }

  // Depth vignette so the middle of the tank stays the brightest read.
  const vig = g.createRadialGradient(W / 2, H * 0.42, H * 0.2, W / 2, H * 0.5, H * 0.95);
  vig.addColorStop(0, 'rgba(0,0,0,0)');
  vig.addColorStop(1, 'rgba(0,0,0,0.55)');
  g.fillStyle = vig;
  g.fillRect(0, 0, W, H);
}

/* ---------- day/night cycle: slow solar drift bent by chain heat ---------- */
// One tank "day" every 5 minutes; a hot chain nudges the phase toward noon.
const DAY_MS = 5 * 60 * 1000;
function dayLight() {
  const phase = ((Date.now() % DAY_MS) / DAY_MS + (latestSnap?.chainTemp ?? 0.5) * 0.1) % 1;
  return 0.5 - 0.5 * Math.cos(phase * Math.PI * 2);
}

function render() {
  requestAnimationFrame(render);
  fpsTick();
  if (view === 'observe') {
    // The tank keeps simulating in the background; only the flow map animates.
    drawFlowmap(clock());
    return;
  }
  if (!latestSnap || cssW === 0) return;
  const now = clock();
  // Frame-rate independent easing: relax by the same amount per millisecond,
  // so a 60Hz viewer and a 144Hz viewer trace the same positions (≈0.35 per
  // 16.7ms frame, which is what the old per-frame constant amounted to).
  const frameDt = Math.min(100, Math.max(1, now - lastFrameAt));
  lastFrameAt = now;
  const easeK = 1 - Math.exp(-frameDt / 38);
  const tax = latestSnap.tax ?? null;
  const sx = cssW / latestSnap.width;
  const sy = cssH / latestSnap.height;
  // Ease the camera toward whatever the causal lens or a follow shot wants;
  // identity focus keeps every other frame pixel-identical to before.
  const goal = camGoal(now, latestSnap);
  const ck = 1 - Math.exp(-frameDt / 260);
  cam.fx += (goal.fx - cam.fx) * ck;
  cam.fy += (goal.fy - cam.fy) * ck;
  cam.z += (goal.z - cam.z) * ck;

  // Screen shake (kill cam): small decaying offset, toggleable. The jitter is
  // keyed to wall-clock time instead of Math.random() so the same instant
  // shakes identically on every screen.
  let shX = 0;
  let shY = 0;
  if (shakeEnabled && now < shakeUntil) {
    const amp = 4 * ((shakeUntil - now) / 200);
    const sk = Math.floor(now / 16);
    shX = (unitNoise(sk) - 0.5) * amp * 2;
    shY = (unitNoise(sk ^ 0x5bf03635) - 0.5) * amp * 2;
  }

  const ct = latestSnap.chainTemp ?? 0.5;

  // 1) Water: one stratified deep-sea cross-section, painted opaque every
  //    frame. The depth frame owns the whole background (surface light, strata
  //    fog, rock walls, sediment, marine snow, money shafts), so creature
  //    motion leaves no trails and every viewer sees the same water.
  wctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  wctx.globalAlpha = 1;


  drawDepthFrame(now, ct);

  // 3) Market volatility shimmer (kept faint on purpose).
  const m = latestSnap.marketTemp ?? 0;
  if (m > 0.5) {
    const shimmer = (m - 0.5) * 2 * (0.5 + 0.5 * Math.sin(now / 110));
    wctx.fillStyle = `rgba(216, 200, 50, ${0.025 * shimmer})`;
    wctx.fillRect(0, 0, cssW, cssH);
  }

  // 4) Food: small drifting lights.
  const foodVib = 0.5 + 0.35 * ct;
  wctx.globalAlpha = foodVib;
  for (const f of latestSnap.foods) {
    const sprite = foodSprite(Math.abs(f.x * 7 + f.y * 13) % 3);
    wctx.setTransform(DPR, 0, 0, DPR, (vx(f.x * sx) + shX) * DPR, (vy(f.y * sy) + shY) * DPR);
    wctx.drawImage(sprite, -15, -15, 30, 30);
  }
  wctx.globalAlpha = 1;

  // 4b) Chain whales: resident leviathans behind the sim creatures.
  drawWhales(now, sx, sy, shX, shY, ct);

  // 5) Creatures from the snapshot buffer.
  //    Render time sits RENDER_DELAY behind the newest snapshot, so we always
  //    interpolate between two snapshots we already hold. On buffer starvation
  //    we extrapolate by velocity (dead reckoning, capped), then hold.
  //    If the buffered timeline runs ahead of the local clock (a late poll
  //    inflating the anchor, see poll()) then every entry is newer than
  //    renderAt and the search below would silently fall back to the OLDEST
  //    snapshot we hold: a tank frozen seconds behind its own panels and behind
  //    the cursor. Clamp to the newest instead.
  const wanted = now - RENDER_DELAY;
  const renderAt = wanted < snapBuffer[0].at ? snapBuffer[snapBuffer.length - 1].at : wanted;
  let s1 = snapBuffer[0];
  let s2 = null;
  for (let i = 0; i < snapBuffer.length; i++) {
    if (snapBuffer[i].at <= renderAt) s1 = snapBuffer[i];
    else { s2 = snapBuffer[i]; break; }
  }
  if (!s2) s2 = snapBuffer[snapBuffer.length - 1];
  let alpha = 0;
  let deadReckonMs = 0;
  if (s1 && s2 && s1 !== s2) {
    alpha = Math.max(0, Math.min(1, (renderAt - s1.at) / Math.max(1, s2.at - s1.at)));
  } else if (s2) {
    // renderAt is past the newest snapshot: extrapolate from the last pair.
    deadReckonMs = Math.max(0, Math.min(renderAt - s2.at, DEAD_RECKON_MAX));
  }

  if (s2 && renderPos.size > s2.byId.size) {
    // Forget creatures the server no longer has. Ids are never reused, so those
    // entries are pure leak, and a stale one would slide a fresh creature in
    // from wherever that id last lived.
    for (const id of renderPos.keys()) {
      if (!s2.byId.has(id)) renderPos.delete(id);
    }
  }
  creatureHits.length = 0;
  if (s2) {
    for (const c of s2.byId.values()) {
      const p = s1 && s1 !== s2 ? s1.byId.get(c.id) : undefined;
      let x;
      let y;
      let heading = c.heading;
      if (p) {
        x = torusLerp(p.x, c.x, s2.width, alpha);
        y = torusLerp(p.y, c.y, s2.height, alpha);
        heading = lerpAngle(p.heading, c.heading, alpha);
      } else {
        x = c.x + c.vx * deadReckonMs;
        y = c.y + c.vy * deadReckonMs;
      }
      // Ease the rendered position toward the target: this is what turns
      // post-stall recovery into a smooth slide instead of a teleport.
      let rp = renderPos.get(c.id);
      if (!rp) {
        rp = { x, y };
        renderPos.set(c.id, rp);
      } else {
        rp.x += torusDelta(rp.x, x, s2.width) * easeK;
        rp.y += torusDelta(rp.y, y, s2.height) * easeK;
        // The eased position lives on the torus too. torusDelta always takes the
        // short way round, so a creature that crosses a seam ends up chasing the
        // copy of its target one world-width away: without this wrap it slides
        // off-canvas and never comes back, and the tank empties within a couple
        // of minutes (measured: 113 of 122 creatures off-world after 110s).
        rp.x = ((rp.x % s2.width) + s2.width) % s2.width;
        rp.y = ((rp.y % s2.height) + s2.height) % s2.height;
      }
      const px = vx(rp.x * sx) + shX;
      const py = vy(rp.y * sy) + shY;

      // Creatures dim and hunch slightly when the chain goes cold.
      const vib = 0.55 + 0.45 * ct;
      const frames = creatureFrames(c.archetype, c.spriteKey);
      const frame = frames.length > 1
        ? frames[Math.floor(now / 160 + c.phase * 10) % frames.length]
        : frames[0];
      const base = (c.radius * 0.9 + Math.min(2, c.energy / 60)) * sx * cam.z / SPRITE_BODY * (0.82 + 0.18 * ct) * CREATURE_VISUAL_SCALE;
      let angle = heading;
      let scaleX = base;
      let scaleY = base;
      switch (c.archetype) {
        case 'WHALE': {
          // Slow breathing + gentle tail-wander around the heading.
          const breathe = 1 + 0.08 * Math.sin(now / 700 + c.phase);
          scaleX = base * breathe;
          scaleY = base * breathe;
          angle += 0.08 * Math.sin(now / 500 + c.phase);
          break;
        }
        case 'ALGO': {
          // Motion stretch along the movement direction.
          const speed = Math.hypot(c.vx, c.vy) * POLL_MS;
          const stretch = 1 + Math.min(1, speed / 8) * 0.8;
          scaleX = base * stretch;
          scaleY = base / Math.sqrt(stretch);
          break;
        }
        case 'APE': {
          // Subtle pulse that grows with local crowding.
          const crowd = Math.min(1, c.neighbors / 4);
          const pulse = 1 + 0.12 * crowd * Math.sin(now / 300 + c.phase);
          scaleX = base * pulse;
          scaleY = base * pulse;
          break;
        }
        case 'INSIDER':
          // Steady spin, ignores heading.
          angle = now / 900 + c.phase;
          break;
      }
      // Hit target for the cursor: screen space, from the position we are
      // actually painting. The snapshot coordinate leads the drawn one by
      // RENDER_DELAY plus the easing lag, so testing against that picks
      // creatures the viewer cannot see under the cursor.
      creatureHits.push({ id: c.id, x: px, y: py, r: SPRITE_BODY * Math.max(scaleX, scaleY) * 0.8 });
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      wctx.setTransform(
        DPR * cos * scaleX, DPR * sin * scaleX,
        -DPR * sin * scaleY, DPR * cos * scaleY,
        px * DPR, py * DPR,
      );
      // A hungry body runs on instinct: no halo and a dimmer body read as
      // "running on fumes". A per-sprite canvas filter would cost a frame per
      // creature and made the whole tank stutter, so hunger stays cheap.
      if (!c.hungry) {
        wctx.globalCompositeOperation = 'lighter';
        wctx.globalAlpha = 0.16 * vib;
        wctx.drawImage(creatureGlow(c.spriteKey), -48, -48, 96, 96);
        wctx.globalCompositeOperation = 'source-over';
      }
      wctx.globalAlpha = vib * (c.hungry ? 0.55 : 1);
      wctx.drawImage(frame, -SPRITE / 2, -SPRITE / 2);
      wctx.globalAlpha = 1;
      if (c.hungry && (cam.z > 1.4 || c.id === selectedId)) {
        // Flatline over the head, but only while the viewer is inspecting
        // (zoomed in or selected): at tank scale it read as stray noise.
        wctx.setTransform(DPR, 0, 0, DPR, 0, 0);
        const gy = py - SPRITE_BODY * base * cam.z - 8;
        wctx.strokeStyle = 'rgba(147, 163, 189, 0.85)';
        wctx.lineWidth = 1;
        wctx.beginPath();
        wctx.moveTo(px - 6, gy);
        wctx.lineTo(px + 6, gy);
        wctx.stroke();
      }
      if (tax && c.archetype === tax.archetype) {
        // Monopoly fog: the taxed species wears a dim red rim so the tax
        // reads on the tank, not only in the chip.
        wctx.setTransform(DPR, 0, 0, DPR, 0, 0);
        wctx.strokeStyle = 'rgba(255, 77, 109, 0.35)';
        wctx.lineWidth = 2;
        wctx.beginPath();
        wctx.arc(px, py, SPRITE_BODY * base * cam.z * 0.75, 0, TAU);
        wctx.stroke();
      }
      if (watched.size > 0 && watched.has(c.id)) {
        // A followed creature stays findable in a tank of a hundred. Wider than
        // the tax rim so a taxed species you follow shows both.
        wctx.setTransform(DPR, 0, 0, DPR, 0, 0);
        wctx.strokeStyle = 'rgba(111, 214, 255, 0.5)';
        wctx.lineWidth = 1.5;
        wctx.beginPath();
        wctx.arc(px, py, SPRITE_BODY * base * cam.z * 0.95, 0, TAU);
        wctx.stroke();
      }
      if (myCheer && c.archetype === myCheer) {
        // Your faction wears a dot in its own colour, so a rally is something
        // you can see in the water and not only in a drawer.
        wctx.setTransform(DPR, 0, 0, DPR, px * DPR, (py - SPRITE_BODY * base * sy / sx - 20) * DPR);
        wctx.globalAlpha = 0.85;
        wctx.fillStyle = ARCHETYPE_COLORS[c.archetype];
        wctx.beginPath();
        wctx.arc(0, 0, 2.5, 0, TAU);
        wctx.fill();
        wctx.globalAlpha = 1;
      }
      if (c.id === selectedId) {
        // Soft double ring, drawn in sprite space so it tracks rotation/scale.
        const r = SPRITE_BODY + 14;
        wctx.drawImage(RING_SPRITE, -r - 4, -r - 4, (r + 4) * 2, (r + 4) * 2);
      }
      // Blinking skull over creatures standing inside a poison zone.
      if (state) {
        for (const ef of state.activeEffects) {
          if (ef.kind !== 'poison') continue;
          const ddx = torusDelta(ef.x, rp.x, latestSnap.width);
          const ddy = torusDelta(ef.y, rp.y, latestSnap.height);
          if (ddx * ddx + ddy * ddy <= ef.radius * ef.radius) {
            wctx.setTransform(DPR, 0, 0, DPR, px * DPR, (py - SPRITE_BODY * base * sy / sx - 14) * DPR);
            wctx.globalAlpha = 0.5 + 0.5 * Math.sin(now / 150);
            wctx.drawImage(SKULL_SPRITE, -14, -14);
            wctx.globalAlpha = 1;
            break;
          }
        }
      }
      // Crown over the current top predator.
      if (c.id === crownId) {
        wctx.setTransform(DPR, 0, 0, DPR, px * DPR, (py - SPRITE_BODY * base * sy / sx - 26) * DPR);
        wctx.globalAlpha = 0.95;
        wctx.drawImage(CROWN_SPRITE, -16, -16);
        wctx.globalAlpha = 1;
      }
    }
  }

  // 6) Persistent zone overlays (poison cloud, feast glow).
  effectHits = [];
  if (state) {
    for (const e of state.activeEffects) {
      const sprite = e.kind === 'poison' ? CLOUD_PURPLE : e.kind === 'feast' ? CLOUD_GREEN : null;
      if (!sprite) continue;
      const px = vx(e.x * sx) + shX;
      const py = vy(e.y * sy) + shY;
      const pr = e.radius * sx * cam.z * 2;
      const pulse = 0.8 + 0.2 * Math.sin(now / 400);
      wctx.setTransform(DPR, 0, 0, DPR, 0, 0);
      wctx.globalAlpha = 0.5 * pulse;
      wctx.drawImage(sprite, px - pr / 2, py - pr / 2, pr, pr);
      wctx.globalAlpha = 1;
      // Weather is a traceable vote: how long it lasts, how many it touched,
      // and a signature ring that fades as the burn spends down.
      if (e.life) {
        const left = Math.max(0, Math.min(1, e.ticksRemaining / e.life));
        wctx.fillStyle = 'rgba(140, 190, 255, 0.35)';
        wctx.fillRect(px - pr / 2, py + pr / 2 + 4, pr * left, 2);
      }
      if (typeof e.affected === 'number') {
        wctx.font = '9px ui-monospace, SFMono-Regular, Menlo, monospace';
        wctx.fillStyle = 'rgba(147, 163, 189, 0.8)';
        wctx.textAlign = 'center';
        wctx.fillText(`${e.affected} ${t('affectedLabel')}`, px, py + pr / 2 + 14);
        wctx.textAlign = 'left';
      }
      if (e.payer) {
        const left = e.life ? Math.max(0, Math.min(1, e.ticksRemaining / e.life)) : 1;
        wctx.strokeStyle = `rgba(255, 204, 111, ${0.5 * left})`;
        wctx.lineWidth = 1.5;
        wctx.beginPath();
        wctx.arc(px, py, pr / 2 + 6, 0, TAU);
        wctx.stroke();
        // Paid interventions are signed on the water: who burned, how much.
        wctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
        wctx.fillStyle = 'rgba(230, 237, 247, 0.75)';
        wctx.textAlign = 'center';
        wctx.fillText(`${shortAddr(e.payer)} · ${e.paid ?? ''}`, px, py - pr / 2 - 6);
        wctx.textAlign = 'left';
        effectHits.push({ x: px, y: py, r: pr / 2, tx: e.tx });
      }
    }
  }

  // 7) Event effects: bursts, rings, edge pulses. Swap-remove expired ones.
  wctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  for (let i = effects.length - 1; i >= 0; i--) {
    const e = effects[i];
    const age = now - e.born;
    if (age > e.dur) {
      effects[i] = effects[effects.length - 1];
      effects.pop();
      continue;
    }
    const k = age / e.dur;
    if (e.kind === 'burst') {
      for (const part of e.parts) {
        const px = vx((e.x + part.vx * age / 16) * sx) + shX;
        const py = vy((e.y + part.vy * age / 16) * sy) + shY;
        const s = part.size * (1 - k * 0.6);
        wctx.globalAlpha = 1 - k;
        wctx.drawImage(part.sprite, px - 8 * s, py - 8 * s, 16 * s, 16 * s);
      }
    } else if (e.kind === 'drop') {
      // Food particles falling in with a bounce.
      for (const part of e.parts) {
        const p = Math.max(0, Math.min(1, (age - part.delay) / 500));
        if (p <= 0) continue;
        const px = vx((e.x + part.ox) * sx) + shX;
        const py = vy(e.y * sy) - (1 - bounceOut(p)) * 80 * cam.z + shY;
        const s = part.size;
        wctx.globalAlpha = 1 - Math.max(0, k - 0.8) * 5;
        wctx.drawImage(DOTS.green, px - 8 * s, py - 8 * s, 16 * s, 16 * s);
      }
    } else if (e.kind === 'meteor') {
      // Glowing meteor on a long fall onto its hash-derived landing site;
      // whale-sized txs come down as fireballs with a shockwave ring.
      const fall = (1 - k) * (1 - k);
      const px = vx(e.x * sx) + shX;
      const py = vy((e.y - 420 * fall) * sy) + shY;
      const s = 0.9 + e.size * 1.8;
      wctx.globalAlpha = 1;
      wctx.setTransform(DPR * s, 0, 0, DPR * s, px * DPR, py * DPR);
      wctx.drawImage(METEOR_SPRITE, -16, -46);
      wctx.setTransform(DPR, 0, 0, DPR, 0, 0);
      if (k > 0.92 && !e.impacted) {
        e.impacted = true;
        const sd = e.seed;
        spawnBurst(e.x, e.y, [DOTS.white, DOTS.green], Math.round(6 + e.size * 10), 500, 2 + e.size * 2, sd);
        if (e.hue != null) {
          // A resident whale's own transfer: the shockwave wears the
          // leviathan's colour and opens wider, so the bloom reads as *its*
          // money feeding this patch of the tank.
          spawnRing(e.x, e.y, 120, hsla(e.hue, 100, 74, 0.9), 900);
          spawnBurst(e.x, e.y, [DOTS.white, DOTS.green], 14, 620, 4, sd + 1);
        } else if (e.size > 0.55) {
          spawnRing(e.x, e.y, 90, 'rgba(255, 170, 70, 0.9)', 800);
          spawnBurst(e.x, e.y, [DOTS.red, DOTS.white], 12, 600, 4, sd + 1);
        } else {
          spawnRing(e.x, e.y, 40, 'rgba(120, 230, 150, 0.7)', 500);
        }
      }
    } else if (e.kind === 'float') {
      // "+N" kill counter floating above the predator.
      wctx.globalAlpha = 1 - k;
      wctx.fillStyle = e.color;
      wctx.font = `bold ${12}px monospace`;
      wctx.textAlign = 'center';
      wctx.fillText(e.text, vx(e.x * sx) + shX, vy((e.y - k * 25) * sy) + shY);
    } else if (e.kind === 'beam') {
      // Energy transfer: particles stream from the prey to the predator.
      const pred = latestSnap.byId.get(e.predatorId);
      const rp2 = pred ? renderPos.get(pred.id) : undefined;
      const tx2 = rp2?.x ?? pred?.x ?? e.fx;
      const ty2 = rp2?.y ?? pred?.y ?? e.fy;
      for (let i = 0; i < 10; i++) {
        const p = (age - i * 35) / 400;
        if (p < 0 || p > 1) continue;
        const bx = vx((e.fx + torusDelta(e.fx, latestSnap.width) * p) * sx) + shX;
        const by = vy((e.fy + torusDelta(e.fy, latestSnap.height) * p) * sy) + shY;
        wctx.globalAlpha = 0.9 * (1 - p * 0.7) * (1 - k);
        wctx.drawImage(DOTS.white, bx - 5, by - 5, 10, 10);
      }
    } else if (e.kind === 'ring') {
      wctx.globalAlpha = 0.8 * (1 - k);
      wctx.strokeStyle = e.color;
      wctx.lineWidth = 2;
      wctx.beginPath();
      wctx.arc(vx(e.x * sx) + shX, vy(e.y * sy) + shY, Math.max(1, e.radius * sx * cam.z * (0.15 + 0.85 * k)), 0, Math.PI * 2);
      wctx.stroke();
    } else if (e.kind === 'edge') {
      wctx.globalAlpha = 0.35 * (1 - k);
      wctx.strokeStyle = e.color;
      wctx.lineWidth = 10;
      wctx.strokeRect(5, 5, cssW - 10, cssH - 10);
    }
  }
  wctx.globalAlpha = 1;
  // Targeting reticle: live preview of the intervention blast radius so the
  // player always sees exactly what a click will affect.
  if (targeting && aimPos) {
    wctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    const ax = vx(aimPos.x * sx) + shX;
    const ay = vy(aimPos.y * sy) + shY;
    const ar = 80 * sx * cam.z;
    const col = targeting === 'poison' ? '255, 90, 120' : '120, 230, 180';
    wctx.globalAlpha = 0.12;
    wctx.fillStyle = `rgba(${col}, 1)`;
    wctx.beginPath();
    wctx.arc(ax, ay, ar, 0, Math.PI * 2);
    wctx.fill();
    wctx.globalAlpha = 0.9;
    wctx.strokeStyle = `rgba(${col}, 0.9)`;
    wctx.lineWidth = 1.5;
    wctx.setLineDash([6, 5]);
    wctx.beginPath();
    wctx.arc(ax, ay, ar, 0, Math.PI * 2);
    wctx.stroke();
    wctx.setLineDash([]);
  }
  wctx.globalAlpha = 1;
  wctx.setTransform(1, 0, 0, 1, 0, 0);
}
render();

/* ---------- history charts (population + temperatures) ---------- */

const ARCHETYPES = ['APE', 'WHALE', 'ALGO', 'INSIDER'];
const ARCHETYPE_COLORS = {
  APE: '#7ee2a8',
  WHALE: '#6db3ff',
  ALGO: '#ffd166',
  INSIDER: '#c792ea',
};
const CHAIN_COLOR = '#4dd0e1';
const MARKET_COLOR = '#ffd166';
let chartPoints = [];   // downsampled stats shared by both charts
let chartHover = -1;    // hovered point index, -1 = none (shared crosshair)

function gameTimeLabel(tick) {
  const ticksPerDay = state?.ticksPerDay ?? 19200;
  const ticksPerHour = ticksPerDay / 24;
  return t('chartTime', {
    day: Math.floor(tick / ticksPerDay),
    hour: Math.floor(tick / ticksPerHour) % 24,
  });
}

function computePoints(stats) {
  chartPoints = [];
  if (!stats || stats.length === 0) return;
  const step = Math.max(1, Math.ceil(stats.length / CHART_SLOTS));
  for (let i = 0; i < stats.length; i += step) chartPoints.push(stats[i]);
}

/** Chart geometry shared by both canvases. */
function chartGeom(canvas) {
  const W = canvas.width;
  const H = canvas.height;
  const padL = 30 * DPR;
  const padB = 14 * DPR;
  const padT = 4 * DPR;
  const plotW = W - padL - 4 * DPR;
  const plotH = H - padT - padB;
  const n = chartPoints.length;
  const slotW = plotW / (CHART_SLOTS - 1);
  // Right-anchored window: with little data the line starts short at the
  // right edge and grows leftwards as history accumulates.
  const xAt = (i) => padL + plotW - (n - 1 - i) * slotW;
  return { W, H, padL, padB, padT, plotW, plotH, n, slotW, xAt };
}

function drawAxes(ctx, g, yMax, fixed01) {
  ctx.fillStyle = 'rgba(201, 214, 232, 0.45)';
  ctx.font = `${9 * DPR}px monospace`;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (let i = 0; i <= 3; i++) {
    const v = (yMax * i) / 3;
    const y = g.padT + g.plotH - (v / yMax) * g.plotH;
    ctx.fillText(fixed01 ? v.toFixed(1) : String(Math.round(v)), g.padL - 4 * DPR, y);
    ctx.strokeStyle = 'rgba(30, 45, 75, 0.5)';
    ctx.lineWidth = DPR * 0.5;
    ctx.beginPath();
    ctx.moveTo(g.padL, y);
    ctx.lineTo(g.padL + g.plotW, y);
    ctx.stroke();
  }
  // X axis: game-time labels at both ends of the data window.
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText(gameTimeLabel(chartPoints[0].tick), g.padL, g.padT + g.plotH + 3 * DPR);
  ctx.textAlign = 'right';
  ctx.fillText(gameTimeLabel(chartPoints[g.n - 1].tick), g.padL + g.plotW, g.padT + g.plotH + 3 * DPR);
}

function drawCullMarkers(ctx, g) {
  if (!lastCulls || g.n < 2) return;
  const t0 = chartPoints[0].tick;
  const t1 = chartPoints[g.n - 1].tick;
  for (const cull of lastCulls) {
    if (cull.tick < t0 || cull.tick > t1) continue;
    const x = g.padL + g.plotW - ((t1 - cull.tick) / Math.max(1, t1 - t0)) * (g.n - 1) * g.slotW;
    ctx.strokeStyle = cull.type === 'harvest' ? 'rgba(224, 163, 77, 0.55)' : 'rgba(255, 77, 109, 0.7)';
    ctx.lineWidth = DPR;
    ctx.beginPath();
    ctx.moveTo(x, g.padT);
    ctx.lineTo(x, g.padT + g.plotH);
    ctx.stroke();
  }
}

function drawTooltip(ctx, g, canvas, lines) {
  const s = chartPoints[chartHover];
  const x = g.xAt(chartHover);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
  ctx.lineWidth = DPR * 0.75;
  ctx.beginPath();
  ctx.moveTo(x, g.padT);
  ctx.lineTo(x, g.padT + g.plotH);
  ctx.stroke();
  ctx.font = `${9 * DPR}px monospace`;
  const tw = Math.max(...lines.map((l) => ctx.measureText(l.text).width)) + 10 * DPR;
  const th = lines.length * 11 * DPR + 6 * DPR;
  const tx = Math.min(x + 6 * DPR, canvas.width - tw - 2 * DPR);
  const ty = g.padT + 2 * DPR;
  ctx.fillStyle = 'rgba(7, 12, 22, 0.92)';
  ctx.fillRect(tx, ty, tw, th);
  ctx.strokeStyle = 'rgba(60, 80, 120, 0.8)';
  ctx.strokeRect(tx, ty, tw, th);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  lines.forEach((l, i) => {
    ctx.fillStyle = l.color;
    ctx.fillText(l.text, tx + 5 * DPR, ty + 4 * DPR + i * 11 * DPR);
  });
}

function drawPopChart() {
  const g = chartGeom(chartCanvas);
  cctx.setTransform(1, 0, 0, 1, 0, 0);
  cctx.clearRect(0, 0, g.W, g.H);
  if (g.n === 0) return;
  const max = Math.max(...chartPoints.map((s) => s.population), 1);
  const yAt = (v) => g.padT + g.plotH - (v / max) * g.plotH;

  drawAxes(cctx, g, max, false);
  drawCullMarkers(cctx, g);

  // Per-archetype thin lines.
  for (const a of ARCHETYPES) {
    cctx.strokeStyle = ARCHETYPE_COLORS[a];
    cctx.lineWidth = DPR;
    cctx.globalAlpha = 0.75;
    cctx.beginPath();
    chartPoints.forEach((s, i) => {
      const v = s.populationByArchetype?.[a] ?? 0;
      if (i === 0) cctx.moveTo(g.xAt(i), yAt(v));
      else cctx.lineTo(g.xAt(i), yAt(v));
    });
    cctx.stroke();
  }
  cctx.globalAlpha = 1;

  // Bold white total line.
  cctx.strokeStyle = 'rgba(240, 246, 255, 0.95)';
  cctx.lineWidth = 2 * DPR;
  cctx.beginPath();
  chartPoints.forEach((s, i) => {
    if (i === 0) cctx.moveTo(g.xAt(i), yAt(s.population));
    else cctx.lineTo(g.xAt(i), yAt(s.population));
  });
  cctx.stroke();

  if (chartHover >= 0 && chartHover < g.n) {
    const s = chartPoints[chartHover];
    drawTooltip(cctx, g, chartCanvas, [
      { text: `${gameTimeLabel(s.tick)} · ${s.population}`, color: '#f0f6ff' },
      ...ARCHETYPES.map((a) => ({
        text: `${a} ${s.populationByArchetype?.[a] ?? 0}`,
        color: ARCHETYPE_COLORS[a],
      })),
    ]);
  }
}

function drawTempChart() {
  const g = chartGeom(tempsCanvas);
  tctx.setTransform(1, 0, 0, 1, 0, 0);
  tctx.clearRect(0, 0, g.W, g.H);
  if (g.n === 0) return;
  const yAt = (v) => g.padT + g.plotH - v * g.plotH; // fixed 0..1

  drawAxes(tctx, g, 1, true);

  // Dashed threshold references at 0.33 / 0.66.
  tctx.strokeStyle = 'rgba(90, 110, 150, 0.5)';
  tctx.lineWidth = DPR * 0.75;
  tctx.setLineDash([4 * DPR, 4 * DPR]);
  for (const ref of [0.33, 0.66]) {
    tctx.beginPath();
    tctx.moveTo(g.padL, yAt(ref));
    tctx.lineTo(g.padL + g.plotW, yAt(ref));
    tctx.stroke();
  }
  tctx.setLineDash([]);

  for (const [key, color] of [['chainTemp', CHAIN_COLOR], ['marketTemp', MARKET_COLOR]]) {
    tctx.strokeStyle = color;
    tctx.lineWidth = 1.5 * DPR;
    tctx.beginPath();
    chartPoints.forEach((s, i) => {
      const v = s[key] ?? 0;
      if (i === 0) tctx.moveTo(g.xAt(i), yAt(v));
      else tctx.lineTo(g.xAt(i), yAt(v));
    });
    tctx.stroke();
  }

  if (chartHover >= 0 && chartHover < g.n) {
    const s = chartPoints[chartHover];
    drawTooltip(tctx, g, tempsCanvas, [
      { text: gameTimeLabel(s.tick), color: '#f0f6ff' },
      { text: `${t('chain')} ${(s.chainTemp ?? 0).toFixed(2)}`, color: CHAIN_COLOR },
      { text: `${t('market')} ${(s.marketTemp ?? 0).toFixed(2)}`, color: MARKET_COLOR },
    ]);
  }
}

function drawCharts() {
  computePoints(lastStats);
  drawPopChart();
  drawTempChart();
}

function chartHoverHandler(canvas) {
  return (ev) => {
    if (chartPoints.length === 0) return;
    const g = chartGeom(canvas);
    const r = canvas.getBoundingClientRect();
    const px = (ev.clientX - r.left) * DPR;
    const idx = Math.round(g.n - 1 - (g.padL + g.plotW - px) / g.slotW);
    const clamped = Math.max(0, Math.min(g.n - 1, idx));
    if (clamped !== chartHover) {
      chartHover = clamped;
      drawPopChart();
      drawTempChart();
    }
  };
}
chartCanvas.addEventListener('mousemove', chartHoverHandler(chartCanvas));
tempsCanvas.addEventListener('mousemove', chartHoverHandler(tempsCanvas));
for (const c of [chartCanvas, tempsCanvas]) {
  c.addEventListener('mouseleave', () => {
    chartHover = -1;
    drawPopChart();
    drawTempChart();
  });
}

/* ---------- obituaries (cull records grouped by event) ---------- */

function renderObituaries(culls) {
  const el = document.getElementById('judgments');
  const statsEl = document.getElementById('death-stats');
  if (!culls || culls.length === 0) {
    el.textContent = t('noCulls');
    statsEl.textContent = '';
    return;
  }
  const totals = { APE: 0, WHALE: 0, ALGO: 0, INSIDER: 0 };
  for (const j of culls) {
    for (const v of j.culled) totals[v.archetype ?? 'INSIDER']++;
  }
  statsEl.textContent = t('deathStats', totals);

  const ticksPerDay = state?.ticksPerDay ?? 19200;
  const ticksPerHour = ticksPerDay / 24;
  el.innerHTML = culls
    .slice(-8)
    .reverse()
    .map((j) => {
      const title = j.type === 'judgment'
        ? t('obitJudgmentTitle', { day: j.day, count: j.culled.length })
        : t('obitHarvestTitle', { hour: Math.floor(j.tick / ticksPerHour), count: j.culled.length });
      const rows = j.culled
        .map((v) => {
          const days = ((v.age ?? 0) / ticksPerDay).toFixed(1);
          const color = ARCHETYPE_COLORS[v.archetype] ?? '#888';
          const label = v.name ?? `#${v.id}`;
          return `<div class="obit"><i class="odot" style="background:${color}"></i>${label} <span class="obit-sub">${t('obitLived', { gen: v.generation, days })}</span></div>`;
        })
        .join('');
      const note = j.type === 'judgment'
        ? `<div class="obit-note">${t('obitJudgmentNote')}</div>`
        : '';
      return `<div class="obit-group ${j.type}"><div class="obit-title">${title}</div>${note}${rows}</div>`;
    })
    .join('');
}

/* ---------- tx meteor rain ---------- */

/** False until the first txRain batch has been registered (cold start). */
let rainBootstrapped = false;

function handleTxRain(txRain) {
  const now = clock();
  let meteorsThisBatch = 0;
  // Cold start: the server hands over its whole 12-tx window, which is history
  // the viewer never watched. Register those (seen-set + clickable impact sites)
  // but don't re-animate them, so a freshly loaded page opens as calm as a tab
  // that has been watching. Steady-state polls only carry txs newer than our
  // cursor and do animate.
  const animate = rainBootstrapped;
  rainBootstrapped = true;
  for (const tx of txRain) {
    if (seenMeteors.has(tx.hash)) continue;
    seenMeteors.add(tx.hash);
    if (seenMeteors.size > 200) seenMeteors.delete(seenMeteors.values().next().value);
    // Whose money is this? If the server matched it to a resident whale it also
    // landed the plankton at that whale's flank, so the impact wears its colour
    //, but only when the transfer was big enough for the tank to react to it.
    const owner = tx.whale ? chainWhales.find((w) => w.address === tx.whale.address) : null;
    const fed = owner !== null && tx.boom === true;
    // Visual cap: a bursty drain must never become a one-frame meteor storm
    // (each impact also spawns a burst + ring). The sim still eats every tx.
    if (animate && meteorsThisBatch < 3 && effects.length < 220) {
      const seed = hashSeed(tx.hash);
      pushEffect({
        kind: 'meteor', x: tx.x, y: tx.y, size: tx.size, dur: 700, impacted: false, seed,
        hue: fed ? PALETTE_HUES[owner.lane.seed % HUE_BUCKETS] : null,
      });
      meteorsThisBatch++;
    }
    // Clickable for a few seconds past the visible flash. Longer than that and
    // the tank fills with invisible click targets that swallow picks on open water.
    impacts.push({ x: tx.x, y: tx.y, hash: tx.hash, meta: tx.meta, until: now + 8000 });
    if (fed && animate) {
      whaleFeed.set(tx.whale.address, { t: now, amount: tx.meta?.amount ?? 0 });
      if (tx.size >= WHALE_NEWS_SIZE && now - whaleLineAt > WHALE_LINE_COOLDOWN_MS) {
        whaleLineAt = now;
        pushEventLine('whale', t('whaleFed', {
          rank: tx.whale.rank,
          addr: shortAddr(tx.whale.address),
          amount: fmtUsd(tx.meta?.amount ?? 0),
        }));
      }
    }
  }
  while (impacts.length > 0 && impacts[0].until < now) impacts.shift();
  renderRainList(txRain);
}

function renderRainList(txRain) {
  const el = document.getElementById('rain');
  el.innerHTML = '';
  for (const tx of txRain.slice(-5).reverse()) {
    const div = document.createElement('div');
    div.className = 'tx';
    const meta = tx.meta;
    div.innerHTML = `<span>${tx.hash.slice(0, 8)}…${tx.hash.slice(-4)}</span>` +
      (meta ? `<span class="amt">${meta.amount >= 1000 ? fmtUsd(meta.amount) : `${meta.amount.toFixed(2)}$`}</span>` : '') +
      `<span class="sizebar" style="width:${4 + Math.round(tx.size * 30)}px"></span>` +
      (meta?.x402 ? '<span class="x4">x402</span>' : '') +
      (tx.simulated ? '<span class="sim">sim</span>' : '');
    if (meta) {
      // Payment-flow provenance: show who paid whom, with an explorer link.
      div.addEventListener('click', () => showTxCard({ ...meta, tx: tx.hash }));
    } else if (!tx.simulated) {
      // Only real on-chain txs link out to the explorer.
      div.addEventListener('click', () => window.open(explorerTxUrl + tx.hash, '_blank', 'noopener'));
    }
    el.appendChild(div);
  }
}

/* ---------- leaderboards ---------- */

const boardCache = new Map();

function updateBoard() {
  if (!state?.leaderboards) return;
  for (const [key, elId] of [['predators', 'lb-predators'], ['richest', 'lb-richest'], ['elders', 'lb-elders']]) {
    const el = document.getElementById(elId);
    const rows = state.leaderboards[key];
    let cache = boardCache.get(elId);
    if (!cache) {
      cache = new Map();
      boardCache.set(elId, cache);
    }
    if (rows.length === 0) {
      if (cache.size > 0 || !el.firstElementChild?.classList.contains('empty')) {
        el.innerHTML = '<div class="empty">–</div>';
      }
      cache.clear();
      continue;
    }
    el.querySelector('.empty')?.remove();
    // Reconcile: reuse row nodes so nothing re-animates; only newcomers animate.
    const seen = new Set();
    rows.forEach((r, i) => {
      let entry = cache.get(r.id);
      if (!entry) {
        const row = document.createElement('div');
        row.className = 'row ev-new';
        row.innerHTML = '<i class="odot"></i><span class="nm"></span><span class="val"></span>';
        entry = { el: row, value: null };
        cache.set(r.id, entry);
      } else {
        entry.el.classList.remove('ev-new');
      }
      seen.add(r.id);
      if (!entry.wired) {
        entry.wired = true;
        entry.el.addEventListener('click', () => {
          selectedId = r.id;
          followCreature(r.id, 6000);
        });
      }
      entry.el.children[0].style.background = ARCHETYPE_COLORS[r.archetype] ?? '#888';
      entry.el.children[1].textContent = r.name;
      if (entry.value !== r.value) {
        entry.el.children[2].textContent = r.value;
        entry.value = r.value;
      }
      if (el.children[i] !== entry.el) el.insertBefore(entry.el, el.children[i] ?? null);
    });
    for (const [id, entry] of cache) {
      if (!seen.has(id)) {
        entry.el.remove();
        cache.delete(id);
      }
    }
  }
  // Crown succession announcement.
  const topKiller = state.leaderboards.predators[0];
  const newCrownId = topKiller ? topKiller.id : null;
  if (newCrownId !== crownId) {
    if (newCrownId != null && crownId != null) {
      pushEventLine('predation', t('crownTaken', { name: topKiller.name }));
    }
    crownId = newCrownId;
  }
}

/* ---------- kill banner ---------- */

let bannerTimer = 0;

function showBanner(predName, predColor, preyName, preyColor) {
  if (suppressFx) return;
  const el = document.getElementById('banner');
  el.innerHTML = t('evtPredation', {
    predator: `<span class="pred" style="color:${predColor}">${predName}</span>`,
    prey: `<span class="prey" style="color:${preyColor}">${preyName}</span>`,
  });
  el.hidden = false;
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => { el.hidden = true; }, 1500);
}

/* ---------- chain regime (the sky tells the story) ---------- */

function regimeOf(temp) {
  return temp > 0.66 ? 2 : temp > 0.33 ? 1 : 0;
}
let lastRegime = -1;

let textBannerTimer = 0;

/** Full-width human-words banner (regime changes). */
function showTextBanner(text, color) {
  const el = document.getElementById('banner');
  el.innerHTML = `<span style="color:${color}">${text}</span>`;
  el.hidden = false;
  clearTimeout(textBannerTimer);
  textBannerTimer = setTimeout(() => { el.hidden = true; }, 2500);
}

/* ---------- event dispatch: visuals + ticker ---------- */

const eventsEl = document.getElementById('events');
let evHover = false;
const evBuffer = [];
eventsEl.addEventListener('mouseenter', () => { evHover = true; });
eventsEl.addEventListener('mouseleave', () => {
  evHover = false;
  flushEventLines();
});

function pushEventLine(cls, text) {
  evBuffer.push({ cls, text });
  if (!evHover) flushEventLines();
}

function flushEventLines() {
  while (evBuffer.length > 0) {
    const { cls, text } = evBuffer.shift();
    const div = document.createElement('div');
    div.className = `ev ${cls}`;
    div.textContent = text;
    eventsEl.prepend(div);
  }
  while (eventsEl.children.length > 30) eventsEl.lastChild.remove();
}

/** Per-predator kill timestamps for rampage detection and streak floats. */
const killHistory = new Map(); // predatorId -> number[] (ms timestamps)
/** Current crown holder (top of the predator leaderboard). */
let crownId = null;

/**
 * Turn sim events into visuals + ticker lines. `bootstrap` marks the cold-start
 * replay of the server's event log: state (ticker, kill history) is skipped or
 * trimmed, and suppressFx keeps 200 historical events from exploding into 200
 * bursts of fireworks on every page load.
 */
function handleEvents(events, bootstrap = false) {
  for (const e of events) {
    const sd = hashSeed(`ev:${e.seq}:${e.type}`);
    switch (e.type) {
      case 'reseed': {
        spawnRing(e.x, e.y, 26, 'rgba(126, 226, 168, 0.8)', 900);
        pushEventLine('reseed', t('evtReseed', {
          species: e.species ?? '?', x: Math.round(e.x), y: Math.round(e.y),
        }));
        break;
      }
      case 'predation': {
        // Kill cam: flash, small screen shake, banner with both names.
        spawnBurst(e.x, e.y, [DOTS.red, DOTS.white], 8, 400, 3, sd);
        spawnRing(e.x, e.y, 30, 'rgba(255, 255, 255, 0.95)', 450);
        if (shakeEnabled && !suppressFx) shakeUntil = clock() + 200;
        spawnBeam(e.x, e.y, e.predatorId);
        const predColor = ARCHETYPE_COLORS[e.predatorArchetype] ?? '#fff';
        const preyColor = ARCHETYPE_COLORS[e.preyArchetype] ?? '#888';
        const predName = e.predatorName ?? `#${e.predatorId}`;
        const preyName = e.preyName ?? `#${e.preyId}`;
        showBanner(predName, predColor, preyName, preyColor);
        pushEventLine('predation', t('evtPredation', { predator: predName, prey: preyName }));
        if (bootstrap) break;

        // Streak float (+1, +2, ... within a 2s chain) and rampage calls.
        const nowMs = clock();
        const hist = (killHistory.get(e.predatorId) ?? []).filter((ts) => nowMs - ts < 30000);
        hist.push(nowMs);
        killHistory.set(e.predatorId, hist);
        const recent = hist.filter((ts) => nowMs - ts < 2000).length;
        spawnFloatText(e.x, e.y - 14, `+${recent}`, '#ff8fa3');
        if (hist.length === 3) {
          pushEventLine('predation', t('rampage', { name: predName, count: 3 }));
        } else if (hist.length === 5) {
          pushEventLine('predation', t('merciless', { name: predName, count: 5 }));
        }
        break;
      }
      case 'poison_kill':
        spawnBurst(e.x, e.y, [DOTS.purple, DOTS.gray], 6, 700, 1.5, sd);
        pushEventLine('intervention', t('evtPoisonKill', { name: e.name ?? '?' }));
        break;
      case 'tx_meteor':
        break; // rendered via the txRain channel instead
      case 'harvest':
      case 'judgment': {
        // Dark dissolve at each victim's last position (capped for sanity).
        const positions = (e.positions ?? []).slice(0, 12);
        positions.forEach((p, i) => {
          spawnBurst(p.x, p.y, [DOTS.gray, DOTS.purple], 5, 800, 1.2, sd + i);
        });
        pushEventLine(e.type, t(e.type === 'harvest' ? 'evtHarvest' : 'evtJudgment', { count: e.count }));
        break;
      }
      case 'intervention':
        if (e.kind === 'feed') {
          spawnRing(e.x, e.y, e.radius ?? 80, 'rgba(120, 230, 150, 0.9)', 700);
          spawnDrop(e.x, e.y, 12, sd);
          pushEventLine('intervention', t('evtFeed', { x: Math.round(e.x), y: Math.round(e.y) }));
        } else if (e.kind === 'poison') {
          spawnRing(e.x, e.y, e.radius ?? 80, 'rgba(170, 100, 255, 0.9)', 700);
          pushEventLine('intervention', t('evtPoison', { x: Math.round(e.x), y: Math.round(e.y) }));
        } else if (e.kind === 'bloom') {
          spawnEdgePulse('rgba(255, 190, 80, 1)', 900);
          pushEventLine('intervention', t('evtBloom'));
        } else if (e.kind === 'drought') {
          spawnEdgePulse('rgba(110, 130, 180, 1)', 900);
          pushEventLine('intervention', t('evtDrought'));
        } else if (e.kind === 'backlash') {
          spawnRing(e.x, e.y, e.radius ?? 80, 'rgba(110, 130, 180, 0.9)', 900);
          pushEventLine('intervention', t('evtBacklash', { x: Math.round(e.x), y: Math.round(e.y) }));
        }
        if (e.payer) {
          pushEventLine('intervention', t('evtInterventionBy', {
            who: shortAddr(e.payer), amount: e.paid ?? '',
          }));
        }
        break;
    }
  }
}

/* ---------- interventions ---------- */

function toast(msg, isError = false) {
  const el = document.getElementById('toast');
  el.hidden = false;
  el.textContent = msg;
  el.classList.toggle('error', isError);
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.hidden = true; }, 5000);
}

/* ---------- burn-to-pay: the visitor burns ABYS, the receipt pays ---------- */

// POST /intervene is paid by calling burn(amount) on the ABYS token: the
// wallet sends the transaction, the receipt is the payment proof, and nobody
// custodies anything. Until the operator exports ABYS_TOKEN_ADDRESS the
// endpoint answers 503 and the panel says so; there is no unpaid path.

const ARC_CHAINS = {
  5042: {
    name: 'Arc',
    rpc: 'https://rpc.mainnet.arc.io',
    explorer: 'https://explorer.arc.io',
  },
  5042002: {
    name: 'Arc Testnet',
    rpc: 'https://rpc.testnet.arc.io',
    explorer: 'https://testnet.explorer.arc.io',
  },
};

/**
 * Ask the visitor's wallet to burn the asked ABYS. The burn transaction IS the
 * payment: its receipt carries the Transfer-to-zero event the server verifies,
 * so there is no seller key and nothing to custody anywhere.
 */
async function payBurn(offer) {
  const eth = window.ethereum;
  if (!eth) return { error: 'no-wallet' };
  const approved = await eth.request({ method: 'eth_requestAccounts' });
  const want = `0x${offer.chainId.toString(16)}`;
  const have = await eth.request({ method: 'eth_chainId' });
  if (have !== want) {
    const info = ARC_CHAINS[offer.chainId];
    try {
      await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: want }] });
    } catch (err) {
      if (err?.code !== 4902 || !info) throw err;
      await eth.request({
        method: 'wallet_addEthereumChain',
        params: [{
          chainId: want,
          chainName: info.name,
          nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 6 },
          rpcUrls: [info.rpc],
          blockExplorerUrls: [info.explorer],
        }],
      });
    }
  }
  const accounts = approved?.length ? approved : await eth.request({ method: 'eth_accounts' });
  const from = accounts[0];
  // Two burn conventions exist and tokens differ on which they allow: some
  // implement burn(), others forbid transfers to the blackhole. Preflight both
  // with eth_call and send whichever the contract itself says will succeed, so
  // the wallet never shows a generic "third-party contract failed" revert.
  const amount = BigInt(offer.amount).toString(16).padStart(64, '0');
  const dead = '000000000000000000000000000000000000000000000000000000000000dead';
  const candidates = [`0x42966c68${amount}`, `0xa9059cbb${dead}${amount}`];
  let data = null;
  for (const d of candidates) {
    try {
      await eth.request({ method: 'eth_call', params: [{ from, to: offer.asset, data: d }, 'latest'] });
      data = d;
      break;
    } catch { /* this convention reverts for this token */ }
  }
  if (!data) return { error: 'preflight-failed' };
  const tx = await eth.request({
    method: 'eth_sendTransaction',
    params: [{ from, to: offer.asset, data }],
  });
  return { tx };
}

/** Settlement verdicts we can turn into something the visitor can act on. */
const PAY_REASON_KEYS = {
  'receipt already used': 'payReceiptUsed',
  'transaction reverted': 'payTxReverted',
  'no burn of the asked amount in this transaction': 'payBurnMissing',
  'receipt not found': 'payBurnMissing',
  'bad tx hash': 'payBurnMissing',
  'receipt lookup failed': 'payBurnMissing',
};

function payReasonText(reason) {
  if (!reason) return t('paymentRequired', { amount: '' });
  const key = PAY_REASON_KEYS[reason];
  return key ? t(key) : reason;
}

async function intervene(body) {
  try {
    const send = (headers) => fetch('/intervene', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    let res = await send({});
    let data = null;
    if (res.status === 503) {
      toast(t('settlementUnconfigured'), true);
      return;
    }
    if (res.status === 402) {
      const gate = await res.json();
      const offer = gate.accepts?.[0];
      if (!offer || offer.settle !== 'burn') {
        toast(t('paymentRequired', { amount: offer?.amount ?? '?' }), true);
        return;
      }
      toast(t('paySign'));
      const paid = await payBurn(offer);
      if (paid.error === 'no-wallet') {
        toast(t('needWallet'), true);
        return;
      }
      if (paid.error === 'preflight-failed') {
        toast(t('payPreflight', { amount: offer.amount }), true);
        return;
      }
      // The burn needs a block or two before its receipt exists; retry while
      // the server still cannot find it, so a fast wallet does not read as a
      // failed payment.
      let pending = null;
      for (let attempt = 0; attempt < 8; attempt++) {
        res = await send({ 'x-payment-tx': paid.tx });
        pending = await res.json();
        if (res.status !== 402 || !/not found|lookup failed/.test(pending.reason ?? '')) break;
        await new Promise((r) => setTimeout(r, 1500));
      }
      data = pending;
    }
    if (data === null) data = await res.json();
    if (res.status === 402) {
      toast(t('payFailed', { reason: payReasonText(data.reason ?? data.error) }), true);
    } else if (!res.ok) {
      toast(t('failed', { error: data.error ?? res.status }), true);
    } else if (data.settlement?.tx) {
      toast(t('paidApplied', { receipt: data.receipt, tx: `${data.settlement.tx.slice(0, 10)}…` }));
    } else if (body.type === 'feed') {
      toast(t('ivFeedResult', { amount: data.amount ?? '?', count: data.affected ?? 0 }));
    } else if (body.type === 'poison') {
      toast(t('ivPoisonResult', { count: data.affected ?? 0 }));
    } else {
      toast(t('applied', { receipt: data.receipt }));
    }
    // A paid action can mint a badge: refresh the standing right away.
    if (res.ok) resolveMe().then(fetchMe);
  } catch (err) {
    toast(t('requestFailed', { error: err }), true);
  }
}

document.querySelectorAll('button.iv').forEach((btn) => {
  btn.addEventListener('click', () => {
    const type = btn.dataset.type;
    if (type === 'bloom' || type === 'drought') {
      intervene({ type });
      return;
    }
    // feed / poison: arm targeting mode, next canvas click picks the area.
    targeting = targeting === type ? null : type;
    document.body.classList.toggle('targeting', targeting != null);
    document.querySelectorAll('button.iv').forEach((b) => b.classList.remove('armed'));
    if (targeting) btn.classList.add('armed');
    document.getElementById('target-hint').hidden = !targeting;
  });
});

// Esc disarms targeting (the welcome card and hint both advertise it).
window.addEventListener('keydown', (ev) => {
  if (ev.key !== 'Escape' || !targeting) return;
  targeting = null;
  document.body.classList.remove('targeting');
  document.querySelectorAll('button.iv').forEach((b) => b.classList.remove('armed'));
  document.getElementById('target-hint').hidden = true;
});

function canvasToWorld(ev) {
  const r = worldCanvas.getBoundingClientRect();
  return {
    x: (baseXFromView(ev.clientX - r.left) / cssW) * (latestSnap?.width ?? 1000),
    y: (baseYFromView(ev.clientY - r.top) / cssH) * (latestSnap?.height ?? 1000),
  };
}

worldCanvas.addEventListener('click', (ev) => {
  const rect = worldCanvas.getBoundingClientRect();
  const mx = ev.clientX - rect.left;
  const my = ev.clientY - rect.top;
  if (!latestSnap) return;
  const pos = canvasToWorld(ev);
  if (targeting) {
    intervene({ type: targeting, x: Math.round(pos.x), y: Math.round(pos.y), radius: 80 });
    targeting = null;
    document.body.classList.remove('targeting');
    document.querySelectorAll('button.iv').forEach((b) => b.classList.remove('armed'));
    document.getElementById('target-hint').hidden = true;
    return;
  }
  // Picking follows paint order, sim creatures on top of the resident chain
  // whales, whales on top of the water, and is judged in screen space against
  // what this frame actually drew.
  const hit = creatureHitAt(ev);
  const c = hit && latestSnap.byId.get(hit.id);
  if (c) {
    selectedId = c.id;
    renderCard(c);
    return;
  }
  const zone = effectHits.slice().reverse().find((h) => Math.hypot(h.x - mx, h.y - my) < h.r);
  if (zone?.tx) {
    window.open(explorerTxUrl + zone.tx, '_blank', 'noopener');
    return;
  }
  const wh = whaleHitAt(ev);
  if (wh) {
    openAddrCard(wh.addr);
    return;
  }
  // Meteor impact sites are clickable -> provenance card (payment flows)
  // or straight to the explorer (plain txs).
  for (let i = impacts.length - 1; i >= 0; i--) {
    const im = impacts[i];
    if (Math.hypot(im.x - pos.x, im.y - pos.y) < 14) {
      if (im.meta) showTxCard({ ...im.meta, tx: im.hash });
      else window.open(explorerTxUrl + im.hash, '_blank', 'noopener');
      return;
    }
  }
  // Open water: nothing under the cursor, so nothing stays selected.
  selectedId = null;
  renderCard(null);
});

/* ---------- creature hover tooltip ---------- */
const tipEl = document.getElementById('tip');
function hideTip() {
  tipEl.hidden = true;
  worldCanvas.style.cursor = '';
}
function showTip(ev, html) {
  tipEl.hidden = false;
  tipEl.innerHTML = html;
  tipEl.style.left = `${Math.min(ev.clientX + 14, window.innerWidth - tipEl.offsetWidth - 8)}px`;
  tipEl.style.top = `${Math.min(ev.clientY + 14, window.innerHeight - tipEl.offsetHeight - 8)}px`;
  worldCanvas.style.cursor = 'pointer';
}
worldCanvas.addEventListener('mousemove', (ev) => {
  if (!latestSnap || view !== 'world') { hideTip(); aimPos = null; return; }
  aimPos = canvasToWorld(ev);
  if (targeting) { hideTip(); return; }
  const hit = creatureHitAt(ev);
  const c = hit && latestSnap.byId.get(hit.id);
  if (c) {
    showTip(ev, `<b>${c.name ?? `${t('creature')} #${c.id}`}</b> · ${c.archetype}<br>` +
      `${t('energy')} ${c.energy.toFixed(0)} · ${t('generation')} G${c.generation}`);
    return;
  }
  const wh = whaleHitAt(ev);
  if (wh) {
    showTip(ev, `<b>${t('whaleTitle')} #${wh.rank}</b> · ${shortAddr(wh.addr)}<br>` +
      `${fmtUsd(wh.volume)} · ${wh.count} tx<br>` +
      `<i>${t('whaleHint')}</i>`);
    return;
  }
  hideTip();
});
worldCanvas.addEventListener('mouseleave', () => { hideTip(); aimPos = null; });

/* ---------- the creature card: a story first, numbers on request ---------- */

// One sim tick is a quarter second of wall clock (19200 ticks = one game day =
// 80 minutes), which is what turns an age in ticks into minutes a person feels.
const TICK_MS = 250;
const HUNGER_RATIO = 0.55;

function wallAge(ageTicks) {
  const min = (ageTicks * TICK_MS) / 60000;
  if (min < 1) return `${Math.round(min * 60)}s`;
  if (min < 90) return `${min < 10 ? min.toFixed(1) : Math.round(min)}${t('unitMin')}`;
  const h = min / 60;
  return `${h < 10 ? h.toFixed(1) : Math.round(h)}${t('unitHour')}`;
}

function gameAge(ageTicks, ticksPerDay) {
  const hours = (ageTicks / ticksPerDay) * 24;
  if (hours < 1) return `${Math.round(hours * 60)}${t('unitGameMin')}`;
  if (hours < 24) return `${hours.toFixed(1)}${t('unitGameHour')}`;
  return `${(hours / 24).toFixed(1)}${t('unitGameDay')}`;
}

const personaAxis = (bits, prefix) => {
  const lvl = bits === 0 ? 'Low' : bits === 3 ? 'High' : 'Mid';
  return t(`persona${prefix}${lvl}`);
};

function personaWords(persona) {
  return [
    personaAxis((persona >> 2) & 3, 'App'),
    personaAxis((persona >> 4) & 3, 'Rest'),
    personaAxis(persona & 3, 'Fec'),
  ].join(' · ');
}

function killTier(kills) {
  if (kills >= 8) return 'tierApex';
  if (kills >= 4) return 'tierAdept';
  if (kills >= 1) return 'tierNovice';
  return 'tierNone';
}

let cardAdvanced = false;
let cardFor = null;

function renderCard(c) {
  const el = document.getElementById('creature-card');
  if (!c) { el.hidden = true; cardFor = null; return; }
  if (cardFor !== c.id) { cardFor = c.id; cardAdvanced = false; }
  const maxEnergy = 200;
  const ratio = Math.max(0, Math.min(1, c.energy / maxEnergy));
  const cond = ratio < 0.15 ? 'condDying' : ratio < HUNGER_RATIO ? 'condHungry' : 'condHealthy';
  const ageTicks = Math.max(0, (latestSnap?.tick ?? 0) - c.bornTick);
  const ticksPerDay = latestSnap?.ticksPerDay ?? 19200;
  const hue = Math.round(c.hue * 360);
  const parent = c.parentId != null ? latestSnap?.byId.get(c.parentId) : null;
  const kills = c.kills ?? 0;
  const fate = [
    c.parentId == null ? t('fateReseed') : null,
    kills >= 8 ? t('fateApex') : null,
    (c.offspring ?? 0) >= 4 ? t('fateLineage') : null,
  ].filter(Boolean);
  const line = (k, v) => `<div class="prop"><span>${t(k)}</span><b>${v}</b></div>`;
  const meal = c.mealTx
    ? `<a class="who-link" href="${explorerTxUrl}${c.mealTx}" target="_blank" rel="noopener">` +
      `${t('mealMeteor', { usd: c.mealUsd ? fmtUsd(c.mealUsd) : '?' })} · ${shortAddr(c.mealTx)}</a>`
    : c.maxMeal > 0 ? t('mealPlain', { e: c.maxMeal.toFixed(1) }) : t('mealNone');
  el.hidden = false;
  el.innerHTML = `
    <div><span class="dot" style="background:hsl(${hue},${Math.round(c.sat * 100)}%,${Math.round(c.light * 100)}%)"></span>
    <span class="cid">${c.name ?? `${t('creature')} #${c.id}`}</span> · ${c.archetype}</div>
    ${line('storyState', `${t(cond)}${t('condPct', { pct: Math.round(ratio * 100) })}`)}
    ${line('storyPersona', personaWords(c.persona ?? 21))}
    ${line('storyRecord', kills === 0 ? t('tierNone') : `${t(killTier(kills))}${t('killsLine', { n: kills })}`)}
    ${line('storyMeal', meal)}
    ${line('storyAge', t('ageLine', { wall: wallAge(ageTicks), game: gameAge(ageTicks, ticksPerDay) }))}
    ${line('storyGen', `${t('genLine', { g: c.generation })} · ${parent ? t('lineageParent', { name: parent.name ?? `#${parent.id}` }) : t('lineageReseed')}`)}
    ${line('storyFate', fate.length ? fate.join(' · ') : t('fateNone'))}
    <div class="card-actions">
      <button id="watch-btn" class="dock-btn">${watched.has(c.id) ? t('unwatch') : t('watch')}</button>
      <button id="adv-btn" class="dock-btn mini">${cardAdvanced ? t('advancedHide') : t('advanced')}</button>
    </div>
    <div id="card-adv" ${cardAdvanced ? '' : 'hidden'}>
      ${line('energy', `${c.energy.toFixed(1)} / ${maxEnergy}`)}
      ${line('age', `${ageTicks}${t('ticks')}`)}
      ${line('devouredLabel', (c.devouredTotal ?? 0).toFixed(1))}
      ${line('offspring', c.offspring ?? 0)}
      ${line('genomeFingerprint', `[${c.genes.join(', ')}] · hue ${c.hue.toFixed(2)}`)}
    </div>
  `;
  // Bound after the markup exists: rebuilding the card throws the old node away.
  el.querySelector('#watch-btn').onclick = () => {
    setWatched(c.id, !watched.has(c.id));
    renderCard(c);
  };
  el.querySelector('#adv-btn').onclick = () => {
    cardAdvanced = !cardAdvanced;
    renderCard(c);
  };
}

/* ---------- daily propositions, burners, replay, export ---------- */

const PROP_KEYS = { 'algo-top': 'propAlgoTop', mono: 'propMono', pred: 'propPred' };

function renderProps(p) {
  const el = document.getElementById('props');
  if (!el) return;
  if (!p?.standings?.length) { el.hidden = true; return; }
  el.hidden = false;
  const mark = (ok) => (ok ? t('propYes') : t('propNo'));
  el.innerHTML = `<div class="props-h">${t('propsTitle')} · D${p.day}</div>` +
    p.standings
      .map((s) => `<div class="prop"><span>${t(PROP_KEYS[s.id] ?? s.id)}</span>` +
        `<b>${s.value}${s.id === 'mono' ? '%' : ''} ${mark(s.ok)}</b></div>`)
      .join('') +
    (p.yesterday?.length
      ? `<div class="props-y">${t('propYesterday')}: ` +
        p.yesterday.map((y) => `${t(PROP_KEYS[y.id] ?? y.id)} ${mark(y.ok)}`).join(' · ') + '</div>'
      : '');
}

/* ---------- following: a watched life is one click away ---------- */

const WATCH_CAP = 12;

function setWatched(id, on) {
  if (on) {
    watched.add(id);
    // Oldest first out, so the list cannot grow without bound.
    while (watched.size > WATCH_CAP) watched.delete(watched.values().next().value);
  } else {
    watched.delete(id);
  }
  localStorage.setItem('abyssal-watch', JSON.stringify([...watched]));
  renderFollowing();
}

let followingSig = '';
function renderFollowing() {
  const group = document.getElementById('following-group');
  const el = document.getElementById('following');
  if (!group || !el) return;
  if (watched.size === 0) {
    group.hidden = true;
    followingSig = '';
    return;
  }
  group.hidden = false;
  const rows = [...watched].map((id) => {
    const c = latestSnap?.byId.get(id);
    return c
      ? { id, name: c.name ?? `#${id}`, color: ARCHETYPE_COLORS[c.archetype] ?? '#888', alive: true }
      : { id, name: prevAlive.get(id)?.name ?? `#${id}`, color: 'var(--fg-3)', alive: false };
  });
  // Signature guard: the panel reconciles instead of rebuilding, so a followed
  // creature does not blink every 400ms poll while nothing about it changed.
  const sig = rows.map((r) => `${r.id}:${r.name}:${r.alive}`).join('|');
  if (sig === followingSig) return;
  followingSig = sig;
  el.innerHTML = rows
    .map((r) => `<div class="row${r.alive ? '' : ' gone'}" data-follow="${r.id}" title="${r.alive ? t('followingTip') : t('watchedGone')}">` +
      `<i class="odot" style="background:${r.color}"></i>` +
      `<span class="nm">${r.name}</span>` +
      `<span class="val">${r.alive ? '' : `<b data-unwatch="${r.id}">×</b>`}</span></div>`)
    .join('');
}

document.getElementById('following')?.addEventListener('click', (ev) => {
  const off = ev.target.closest('[data-unwatch]');
  if (off) {
    setWatched(Number(off.dataset.unwatch), false);
    return;
  }
  const row = ev.target.closest('[data-follow]');
  if (!row) return;
  const id = Number(row.dataset.follow);
  const c = latestSnap?.byId.get(id);
  if (!c) return;
  selectedId = id;
  renderCard(c);
  followCreature(id, 8000);
});

/* ---------- who you are in the tank ---------- */

// Badge ids in the server's bit order (BADGES in packages/server/src/handler.ts).
const BADGE_IDS = ['firstBurn', 'weathermaker', 'executioner', 'benefactor', 'whalefall', 'patron', 'passHolder'];
const FACTIONS = Object.keys(ARCHETYPE_COLORS);
const badgeKey = (id) => `badge${id[0].toUpperCase()}${id.slice(1)}`;

let myAddr = null;
let myCheer = null;
let myWho = null;
let meFetchedAt = 0;
let factionCounts = {};

/**
 * The connected address, without prompting: eth_accounts only answers once the
 * visitor has approved this site, which the burn flow already asks for.
 */
async function resolveMe() {
  const eth = window.ethereum;
  if (!eth) return;
  try {
    const acc = await eth.request({ method: 'eth_accounts' });
    const next = acc?.[0]?.toLowerCase() ?? null;
    if (next === myAddr) return;
    myAddr = next;
    myWho = null;
    if (next) {
      await fetchMe();
    } else {
      // Wallet gone: drop the standing and stop wearing its colours.
      myCheer = null;
      renderMe();
      renderFactions(null);
    }
  } catch { /* no wallet, or it refused */ }
}

async function fetchMe() {
  if (!myAddr) return;
  try {
    const res = await fetch(`/who?addr=${encodeURIComponent(myAddr)}`);
    if (!res.ok) return;
    myWho = await res.json();
    meFetchedAt = Date.now();
    myCheer = myWho.cheer;
    renderMe();
    renderFactions(factionCounts);
  } catch { /* offline: keep the last card */ }
}

function badgeChips(ids, tiny = false) {
  return (ids ?? [])
    .map((id) => `<span class="chip badge${tiny ? ' tiny' : ''}">${t(badgeKey(id))}</span>`)
    .join('');
}

function renderMe() {
  const el = document.getElementById('me-card');
  const none = document.getElementById('me-none');
  if (!el) return;
  if (!myAddr) {
    el.hidden = true;
    if (none) none.hidden = false;
    return;
  }
  el.hidden = false;
  if (none) none.hidden = true;
  const w = myWho;
  const line = (k, v) => `<div class="prop"><span>${t(k)}</span><b>${v}</b></div>`;
  el.innerHTML =
    line('you', `<a class="who-link" data-addr="${myAddr}">${shortAddr(myAddr)}</a>`) +
    (w ? line('burnedTotal', `${w.burned.toLocaleString()} ABYS`) : '') +
    (w?.burns ? line('burnCount', w.burns) : '') +
    (w?.rank ? line('boardRank', `#${w.rank}`) : '') +
    (w?.pass?.active ? line('passLabel', `D${Math.floor(w.pass.until / (latestSnap?.ticksPerDay ?? 19200))}`) : '') +
    (w?.cheer ? line('rallyingFor', w.cheer) : '') +
    (w?.badges?.length ? `<div class="chips">${badgeChips(w.badges)}</div>` : '');
  el.querySelector('.who-link')?.addEventListener('click', () => openAddrCard(myAddr));
}

function renderFactions(cheers) {
  const el = document.getElementById('factions');
  if (!el) return;
  if (cheers) factionCounts = cheers;
  el.innerHTML = FACTIONS
    .map((s) => `<button class="chip faction${myCheer === s ? ' mine' : ''}" data-faction="${s}" ` +
      `style="--chip:${ARCHETYPE_COLORS[s]}"><i class="cdot"></i>${s} <b>${factionCounts[s] ?? 0}</b></button>`)
    .join('');
}

async function cheerFor(species) {
  if (!myAddr) await resolveMe();
  if (!myAddr) { toast(t('needWallet'), true); return; }
  try {
    const res = await fetch('/cheer', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ addr: myAddr, species }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const key = res.status === 429 ? 'cheerSoon' : res.status === 403 ? 'cheerUnknown' : null;
      toast(key ? t(key) : t('failed', { error: data.error ?? res.status }), true);
      return;
    }
    myCheer = data.cheer;
    renderFactions(data.cheers);
    fetchMe();
    toast(t('cheered', { species }));
  } catch (err) {
    toast(t('requestFailed', { error: err }), true);
  }
}

document.getElementById('factions')?.addEventListener('click', (ev) => {
  const btn = ev.target.closest('[data-faction]');
  if (btn) cheerFor(btn.dataset.faction);
});

document.getElementById('burners')?.addEventListener('click', (ev) => {
  const row = ev.target.closest('[data-addr]');
  if (row) openAddrCard(row.dataset.addr);
});

resolveMe();
window.addEventListener('focus', () => resolveMe());
window.ethereum?.on?.('accountsChanged', () => resolveMe());

function renderBurners(list) {
  const el = document.getElementById('burners');
  if (!el) return;
  if (!list?.length) {
    el.innerHTML = `<div class="addr-empty">${t('burnersEmpty')}</div>`;
    return;
  }
  const bitsToIds = (bits) => BADGE_IDS.filter((_, i) => bits & (1 << i));
  el.innerHTML = list
    .map((b, i) => {
      const mine = myAddr && b.address.toLowerCase() === myAddr;
      return `<div class="af in${mine ? ' me' : ''}" data-addr="${b.address}">` +
        `<span class="who">${i + 1}. ${shortAddr(b.address)}${mine ? ` · ${t('you')}` : ''}</span>` +
        `<span class="amt">${b.total.toLocaleString()} ABYS</span>` +
        (b.cheer ? `<span class="chip tiny" style="--chip:${ARCHETYPE_COLORS[b.cheer] ?? '#888'}">${b.cheer}</span>` : '') +
        `<span class="chips">${badgeChips(bitsToIds(b.badges ?? 0), true)}</span>` +
        `</div>`;
    })
    .join('');
}

// 90s replay over the pulse buckets: a playhead sweeping the last six bars.
let replayOn = false;
let replayStart = 0;
const REPLAY_MS = 90_000;

function downloadCsv(text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = 'abyssal-window.csv';
  a.click();
  URL.revokeObjectURL(url);
}

document.getElementById('pulse-play')?.addEventListener('click', (ev) => {
  replayOn = !replayOn;
  replayStart = clock();
  ev.currentTarget.textContent = replayOn ? '\u23F8' : '\u25B6';
});

document.querySelectorAll('[data-export]').forEach((btn) => btn.addEventListener('click', async () => {
  const kind = btn.dataset.export;
  const eth = window.ethereum;
  let payer = null;
  if (eth) {
    try {
      const acc = await eth.request({ method: 'eth_accounts' });
      payer = acc?.[0]?.toLowerCase() ?? null;
    } catch { /* no wallet connected */ }
  }
  if (!payer) { toast(t('needWallet'), true); return; }
  const grab = async () => {
    const r = await fetch(`/export?pass=${payer}&kind=${kind}`);
    if (!r.ok) throw r.status;
    return r.text();
  };
  try {
    downloadCsv(await grab());
  } catch (status) {
    if (status === 402) {
      await intervene({ type: 'pass' });
      try { downloadCsv(await grab()); } catch { toast(t('exportCsv') + ': 402', true); }
    } else {
      toast(t('failed', { error: status }), true);
    }
  }
}));

const CAUSE_KEYS = {
  starvation: 'causeStarvation',
  poison: 'causePoison',
  predation: 'causePredation',
  harvest: 'causeHarvest',
  judgment: 'causeJudgment',
};
const TITLE_KEYS = {
  apex: 'titleApex',
  poisonGhost: 'titlePoisonGhost',
  whalefallSurvivor: 'titleWhalefallSurvivor',
  lineageBearer: 'titleLineageBearer',
};

function renderDaily(d) {
  const el = document.getElementById('daily-report');
  if (!el) return;
  if (!d) { el.innerHTML = ''; return; }
  const line = (k, v) => `<div class="prop"><span>${t(k)}</span><b>${v}</b></div>`;
  el.innerHTML =
    (d.maxFall ? line('maxFall', `${fmtUsd(d.maxFall.size * 100000)} · ${d.maxFall.hash.slice(0, 10)}…`) : '') +
    (d.winner ? line('winnerSpecies', `${d.winner.species} · ${d.winner.kills}`) : '') +
    (d.biggestIntervention
      ? line('biggestIntervention', `${d.biggestIntervention.type} · ${d.biggestIntervention.affected}`)
      : '') +
    line('deathToll', Object.entries(d.deaths).map(([c, n]) => `${t(CAUSE_KEYS[c] ?? c)} ${n}`).join(' · ') || '0') +
    (d.mvp.strongest ? line('mvpStrongest', `${d.mvp.strongest.name} · ${d.mvp.strongest.kills}`) : '') +
    (d.mvp.burner ? line('mvpBurner', `${shortAddr(d.mvp.burner.address)} · ${d.mvp.burner.total}`) : '') +
    (d.mvp.saddest ? line('mvpSaddest', `${d.mvp.saddest.species} · ${d.mvp.saddest.deaths}`) : '');
}

function renderReports(list) {
  const el = document.getElementById('reports');
  if (!el) return;
  if (!list?.length) { el.innerHTML = `<div class="addr-empty">${t('reportsEmpty')}</div>`; return; }
  el.innerHTML = list
    .map((r) => `<div class="prop"><span>${r.type} · ${r.payer ? shortAddr(r.payer) : '?'} · ${r.paid ?? ''}</span>` +
      `<b>${r.score === undefined ? '…' : `${r.score} ${r.score > 0 ? t('scoreWorth') : t('scoreWaste')}`}</b></div>`)
    .join('');
}

function renderMemorials(list) {
  const el = document.getElementById('memorials');
  if (!el) return;
  if (!list?.length) { el.innerHTML = `<div class="addr-empty">${t('memorialsEmpty')}</div>`; return; }
  el.innerHTML = list
    .map((o) => {
      // Titles are earned, so an ordinary death gets the plain record only.
      const titles = (o.titles ?? []).map((k) => t(TITLE_KEYS[k] ?? k)).join(' · ');
      return `<div class="memorial"><b>${o.name}</b> · ${o.archetype} · ${t(CAUSE_KEYS[o.cause] ?? o.cause)}` +
        (titles ? `<div class="epitaph">${titles}</div>` : '') +
        `<div class="epitaph">G${o.generation} · ${o.diedTick - o.bornTick}${t('ticks')} · ` +
        `${t('offspring')} ${o.offspring} · ${t('killsLabel')} ${o.kills} · ${t('maxMeal')} ${o.maxMeal}</div></div>`;
    })
    .join('');
}

/* ---------- panel collapse, dock drawers, welcome layer ---------- */

// Panel / sub-section collapse toggles.
document.querySelectorAll('[data-collapse]').forEach((head) => {
  head.addEventListener('click', () => {
    const targetId = head.dataset.collapse;
    if (targetId === 'board' || targetId === 'panel') {
      document.getElementById(targetId).classList.toggle('collapsed');
    } else {
      document.getElementById(targetId).classList.toggle('collapsed');
      head.classList.toggle('collapsed');
    }
  });
});

// Bottom dock: memorials / deaths / data / standing drawers (mutually exclusive).
const drawers = { mem: 'drawer-mem', obits: 'drawer-obits', analytics: 'drawer-analytics', you: 'drawer-you' };
function toggleDrawer(which) {
  for (const [key, id] of Object.entries(drawers)) {
    const el = document.getElementById(id);
    const btn = document.getElementById(`dock-${key}`);
    const open = key === which ? el.hidden : false;
    el.hidden = !open;
    btn.classList.toggle('open', open);
  }
  if (which === 'analytics' && !document.getElementById(drawers.analytics).hidden) {
    resize();
  }
}
document.getElementById('dock-mem').addEventListener('click', () => toggleDrawer('mem'));
document.getElementById('dock-obits').addEventListener('click', () => toggleDrawer('obits'));
document.getElementById('dock-analytics').addEventListener('click', () => toggleDrawer('analytics'));
document.getElementById('dock-you').addEventListener('click', () => {
  toggleDrawer('you');
  // Opening the drawer is the moment a visitor expects to see their own row,
  // even if the last background refresh was a while ago.
  if (myAddr) fetchMe();
  else resolveMe();
});

// First-visit welcome layer.
const welcomeEl = document.getElementById('welcome');
if (localStorage.getItem('abyssal-seen') !== '1') {
  welcomeEl.hidden = false;
}
document.getElementById('enter').addEventListener('click', () => {
  const first = localStorage.getItem('abyssal-seen') !== '1';
  localStorage.setItem('abyssal-seen', '1');
  welcomeEl.hidden = true;
  if (first) startCausal();
});
// The "?" in the top bar reopens the how-to-play card at any time.
document.getElementById('help-btn').addEventListener('click', () => {
  welcomeEl.hidden = false;
});

/* ---------- language switching re-renders dynamic content ---------- */

document.addEventListener('langchange', () => {
  updateTopbar();
  applyChainStrings();
  if (obsData && view === 'observe') {
    renderObsStats();
  }
  if (lastStats) drawCharts();
  if (lastCulls) renderObituaries(lastCulls);
  followingSig = '';
  renderFollowing();
  renderMe();
  renderFactions(null);
  if (selectedId != null && latestSnap) {
    const c = latestSnap.byId.get(selectedId);
    renderCard(c ?? null);
  }
});
