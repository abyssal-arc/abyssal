import { Rng } from './prng.js';

export const INPUT_SIZE = 9;
export const HIDDEN_SIZE = 6;
export const OUTPUT_SIZE = 4;

/**
 * A genome is the parameter set of a tiny feed-forward neural network
 * (9 inputs -> 6 hidden -> 4 outputs, tanh activations) plus three
 * appearance genes (hue / saturation / lightness in 0..1).
 *
 * Inputs (in order):
 *   0-1: direction to nearest food (toroidal, scaled to [-1,1])
 *   2:   food intensity near the creature (0..1)
 *   3-4: relative vector to nearest conspecific (scaled to [-1,1])
 *   5:   own energy ratio (0..1)
 *   6:   chain congestion temperature (0..1)
 *   7:   chain temperature delta since last tick (-1..1)
 *   8:   stock-market volatility temperature (0..1)
 *
 * Outputs: move angle, move strength, eat urge, reproduce urge.
 */
export interface Genome {
  w1: number[]; // HIDDEN_SIZE * INPUT_SIZE
  b1: number[]; // HIDDEN_SIZE
  w2: number[]; // OUTPUT_SIZE * HIDDEN_SIZE
  b2: number[]; // OUTPUT_SIZE
  color: [number, number, number];
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function clamp01(v: number): number {
  return clamp(v, 0, 1);
}

export function randomGenome(rng: Rng): Genome {
  const w = (n: number): number[] => Array.from({ length: n }, () => rng.range(-1, 1));
  return {
    w1: w(HIDDEN_SIZE * INPUT_SIZE),
    b1: w(HIDDEN_SIZE),
    w2: w(OUTPUT_SIZE * HIDDEN_SIZE),
    b2: w(OUTPUT_SIZE),
    color: [rng.next(), rng.range(0.5, 1), rng.range(0.4, 0.7)],
  };
}

export function cloneGenome(g: Genome): Genome {
  return {
    w1: g.w1.slice(),
    b1: g.b1.slice(),
    w2: g.w2.slice(),
    b2: g.b2.slice(),
    color: [g.color[0], g.color[1], g.color[2]],
  };
}

/** Point mutations: each weight has `rate` chance of being nudged by up to +/-scale. */
export function mutateGenome(g: Genome, rng: Rng, rate: number, scale: number): Genome {
  const mut = (arr: number[]): number[] =>
    arr.map((v) => (rng.next() < rate ? clamp(v + rng.range(-scale, scale), -2, 2) : v));
  const child = cloneGenome(g);
  child.w1 = mut(child.w1);
  child.b1 = mut(child.b1);
  child.w2 = mut(child.w2);
  child.b2 = mut(child.b2);
  const hueJitter = rng.next() < rate ? rng.range(-0.05, 0.05) : 0;
  const satJitter = rng.next() < rate ? rng.range(-0.05, 0.05) : 0;
  const lightJitter = rng.next() < rate ? rng.range(-0.05, 0.05) : 0;
  child.color = [
    (((child.color[0] + hueJitter) % 1) + 1) % 1,
    clamp01(child.color[1] + satJitter),
    clamp01(child.color[2] + lightJitter),
  ];
  return child;
}

export interface BrainOutput {
  /** Heading in radians, -PI..PI. */
  angle: number;
  /** 0..1 fraction of max speed. */
  strength: number;
  /** 0..1 desire to eat. */
  eat: number;
  /** 0..1 desire to reproduce. */
  reproduce: number;
}

export function forward(g: Genome, input: number[]): BrainOutput {
  const hidden = new Array<number>(HIDDEN_SIZE);
  for (let h = 0; h < HIDDEN_SIZE; h++) {
    let sum = g.b1[h];
    for (let i = 0; i < INPUT_SIZE; i++) sum += g.w1[h * INPUT_SIZE + i] * input[i];
    hidden[h] = Math.tanh(sum);
  }
  const out = new Array<number>(OUTPUT_SIZE);
  for (let o = 0; o < OUTPUT_SIZE; o++) {
    let sum = g.b2[o];
    for (let h = 0; h < HIDDEN_SIZE; h++) sum += g.w2[o * HIDDEN_SIZE + h] * hidden[h];
    out[o] = Math.tanh(sum);
  }
  return {
    angle: out[0] * Math.PI,
    strength: (out[1] + 1) / 2,
    eat: (out[2] + 1) / 2,
    reproduce: (out[3] + 1) / 2,
  };
}

/* ---------- species archetypes ---------- */

export type Archetype = 'APE' | 'WHALE' | 'ALGO' | 'INSIDER';

export interface ArchetypeTraits {
  /** Body radius multiplier (rendering + predation). */
  radiusMult: number;
  /** Basal metabolism multiplier. */
  basalMult: number;
  /** Max-speed multiplier. */
  speedMult: number;
}

/**
 * APE: low metabolism, breeds easily. WHALE: huge body, expensive to run.
 * ALGO: fast and lean. INSIDER: balanced across the board.
 */
export const ARCHETYPES: Record<Archetype, ArchetypeTraits> = {
  APE: { radiusMult: 1.0, basalMult: 0.6, speedMult: 0.9 },
  WHALE: { radiusMult: 2.2, basalMult: 2.0, speedMult: 0.8 },
  ALGO: { radiusMult: 0.8, basalMult: 0.9, speedMult: 1.6 },
  INSIDER: { radiusMult: 1.0, basalMult: 1.0, speedMult: 1.0 },
};

/**
 * Map a genome to an archetype from its output-layer biases: strong
 * reproduce bias -> APE, strong eat bias -> WHALE, strong move bias ->
 * ALGO, and no dominant bias -> INSIDER. Fully deterministic.
 * INSIDER_MARGIN is how flat the drives must be to read as INSIDER; without
 * it the INSIDER score (-max|bias|) can never beat the bias it negates, so
 * the niche would be unreachable.
 */
const INSIDER_MARGIN = 0.2;

export function archetypeOf(g: Genome): Archetype {
  const bias = (o: number): number => {
    let s = g.b2[o];
    for (let h = 0; h < HIDDEN_SIZE; h++) s += g.w2[o * HIDDEN_SIZE + h];
    return s / (HIDDEN_SIZE + 1);
  };
  const move = bias(1);
  const eat = bias(2);
  const reproduce = bias(3);
  const scores: [Archetype, number][] = [
    ['APE', reproduce],
    ['WHALE', eat],
    ['ALGO', move],
    ['INSIDER', INSIDER_MARGIN - Math.max(Math.abs(move), Math.abs(eat), Math.abs(reproduce))],
  ];
  let best: Archetype = 'INSIDER';
  let bestScore = -Infinity;
  for (const [archetype, score] of scores) {
    if (score > bestScore) {
      bestScore = score;
      best = archetype;
    }
  }
  return best;
}

export const ARCHETYPE_LIST: Archetype[] = ['APE', 'WHALE', 'ALGO', 'INSIDER'];

/**
 * Rewrite a genome's output biases so it reads as `target`, leaving its hidden
 * wiring (and therefore its behaviour within the niche) untouched: only the
 * bias term moves, the row's weights keep modulating around the new mean.
 */
export function steerArchetype(g: Genome, target: Archetype, strength = 0.6): void {
  const set = (out: number, v: number): void => {
    let s = 0;
    for (let h = 0; h < HIDDEN_SIZE; h++) s += g.w2[out * HIDDEN_SIZE + h];
    g.b2[out] = v * (HIDDEN_SIZE + 1) - s;
  };
  set(1, target === 'ALGO' ? strength : -strength);
  set(2, target === 'WHALE' ? strength : -strength);
  set(3, target === 'APE' ? strength : -strength);
}

/** Short fingerprint of a genome for UI display (first hidden-row weights). */
export function genomeFingerprint(g: Genome): number[] {
  return g.w1.slice(0, 4).map((v) => Math.round(v * 100) / 100);
}

/* ---------- creature naming ---------- */

/**
 * Per-archetype codename wordlists. Names stay in English across all UI
 * languages by design.
 */
const NAME_WORDS: Record<Archetype, string[]> = {
  WHALE: ['MOBY', 'KRAKEN', 'LEVIATHAN', 'ABYSS', 'TSUNAMI'],
  ALGO: ['DART', 'FLASH', 'QUANT', 'TURBO', 'VECTOR'],
  APE: ['HODL', 'BANANA', 'FREN', 'MOON', 'DEGEN'],
  INSIDER: ['WHISPER', 'SIGNAL', 'LEDGER', 'ORACLE', 'VAULT'],
};

/** Deterministic creature name derived from archetype + id, e.g. MOBY-042. */
export function creatureName(archetype: Archetype, id: number): string {
  const words = NAME_WORDS[archetype];
  const word = words[id % words.length];
  return `${word}-${String(id).padStart(3, '0')}`;
}
