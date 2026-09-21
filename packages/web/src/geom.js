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

