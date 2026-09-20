/**
 * Deterministic primitives shared by the renderer: seeded RNG, string hashing
 * and the trench geometry. Pure on purpose, so node can test them without a
 * DOM and every viewer derives the same ambient layout from the same seed.
 */

export function mulberry32(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), 1 | t);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a over a string → 32-bit seed (tx hashes, event keys). */
export function hashSeed(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Fallback seed from world coordinates when no id/hash is at hand. */
export function mixSeed(x, y, extra = 0) {
  return hashSeed(`${Math.round(x)}:${Math.round(y)}:${extra}`);
}

/** Deterministic 0..1 noise from an integer key (shared screen-shake jitter). */
export function unitNoise(key) {
  let t = (key ^ 0x9e3779b9) >>> 0;
  t = Math.imul(t ^ (t >>> 16), 0x21f0aaad);
  t = Math.imul(t ^ (t >>> 15), 0x735a2d97);
  return ((t ^ (t >>> 15)) >>> 0) / 4294967296;
}

/**
 * The trench the tank sits in: canyon wall profiles (normalized widths per
 * row), gold rain columns, constellation nodes and jellyfish bells. Built once
 * per seed; the renderer only animates these, never re-rolls them.
 */
export function buildFrameGeometry(seed) {
  const rnd = mulberry32(seed);
  const canyonL = [];
  const canyonR = [];
  for (let i = 0; i <= 14; i++) {
    canyonL.push(0.035 + 0.05 * Math.sin(i * 1.7) ** 2 + rnd() * 0.03);
    canyonR.push(0.035 + 0.05 * Math.cos(i * 1.3) ** 2 + rnd() * 0.03);
  }
  const rainCols = [];
  for (let i = 0; i < 9; i++) {
    rainCols.push({
      fx: 0.42 + rnd() * 0.3,
      speed: 0.00006 + rnd() * 0.00008,
      phase: rnd() * 10,
      w: 1 + rnd() * 2,
    });
  }
  const nodes = [];
  for (let i = 0; i < 16; i++) {
    nodes.push({ fx: 0.72 + rnd() * 0.26, fy: 0.25 + rnd() * 0.65, r: 1.5 + rnd() * 3, phase: rnd() * 10 });
  }
  const jellies = [];
  for (let i = 0; i < 7; i++) {
    jellies.push({
      fx: 0.15 + rnd() * 0.7, fy: 0.3 + rnd() * 0.6,
      s: 6 + rnd() * 10, phase: rnd() * 10, speed: 0.00002 + rnd() * 0.00003,
    });
  }
  return { canyonL, canyonR, rainCols, nodes, jellies };
}
