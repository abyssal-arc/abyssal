import { Rng } from './prng.js';
import {
  ARCHETYPES,
  ARCHETYPE_LIST,
  archetypeOf,
  creatureName,
  forward,
  mutateGenome,
  randomGenome,
  steerArchetype,
  type Archetype,
  type Genome,
} from './genome.js';
import { DEFAULT_CONFIG, type WorldConfig } from './types.js';

/** External sensory inputs for one tick, both normalized to 0..1. */
export interface Senses {
  /** Chain congestion temperature: drives the food spawn rate. */
  chain: number;
  /** Stock-market volatility temperature: drives excitation (speed + metabolism). */
  market: number;
}

/** One on-chain transaction falling into the world as a food meteor. */
export interface TxMeteor {
  hash: string;
  /** 0..1, normalized transaction magnitude. */
  size: number;
  /**
   * Explicit landing site, overriding the hash-derived one. Used when the
   * transfer belongs to an address the world embodies (a chain whale): its
   * money must fall where the leviathan is swimming, not at a hash coordinate,
   * or the causal link between the two is invisible.
   */
  at?: { x: number; y: number };
}

/**
 * Deterministic landing point for a transaction, derived from its hash so
 * every client renders the same impact site.
 */
export function txLanding(hash: string, width: number, height: number): { x: number; y: number } {
  const h = hash.replace(/^0x/, '');
  const a = parseInt(h.slice(0, 8), 16) >>> 0;
  const b = parseInt(h.slice(8, 16), 16) >>> 0;
  return { x: a % width, y: b % height };
}

export interface Creature {
  id: number;
  /** Deterministic codename, e.g. MOBY-042. */
  name: string;
  x: number;
  y: number;
  energy: number;
  genome: Genome;
  archetype: Archetype;
  /** Body radius in world units (derived from the archetype). */
  radius: number;
  /** Lifetime predation count. */
  kills: number;
  /** Lifetime energy taken from prey (the transferred 50%). */
  devouredTotal: number;
  /** Tick from which this predator may kill again; 0 until its first meal. */
  huntReadyAt: number;
  generation: number;
  bornTick: number;
}

export interface Food {
  id: number;
  x: number;
  y: number;
  energy: number;
}

export type Intervention =
  | { type: 'feed'; x: number; y: number; radius: number; amount?: number }
  | { type: 'poison'; x: number; y: number; radius: number; durationTicks?: number }
  | { type: 'bloom'; durationTicks?: number }
  | { type: 'drought'; durationTicks?: number };

export interface TimedEffect {
  /** `boom` = a whale's own transfer landed plankton here and pulls locally. */
  kind: 'poison' | 'bloom' | 'drought' | 'feast' | 'boom';
  x: number;
  y: number;
  radius: number;
  expiresTick: number;
  /** Poison only: energy drained per tick inside the radius. */
  damagePerTick: number;
}

export type CullType = 'harvest' | 'judgment';

export interface CullRecord {
  type: CullType;
  tick: number;
  day: number;
  culled: {
    id: number;
    name: string;
    generation: number;
    energy: number;
    archetype: Archetype;
    /** Ticks lived (cull tick minus bornTick). */
    age: number;
  }[];
  populationBefore: number;
  populationAfter: number;
}

export interface TickStats {
  tick: number;
  day: number;
  population: number;
  /** Headcount per species archetype, for the per-archetype history chart. */
  populationByArchetype: Record<Archetype, number>;
  totalEnergy: number;
  diversity: number;
  chainTemp: number;
  marketTemp: number;
  events: string[];
}

/**
 * Structured event with position metadata, kept in a ring buffer so the
 * frontend can visualize what just happened (predation flashes, cull
 * dissolves, intervention markers). `seq` is monotonic for ?since= polling.
 */
export interface SimEvent {
  seq: number;
  tick: number;
  type: 'predation' | 'harvest' | 'judgment' | 'intervention' | 'tx_meteor' | 'poison_kill';
  /** World coordinates, when the event is localized. */
  x?: number;
  y?: number;
  radius?: number;
  /** Predation metadata. */
  predatorId?: number;
  preyId?: number;
  predatorArchetype?: Archetype;
  preyArchetype?: Archetype;
  predatorName?: string;
  preyName?: string;
  /** Meteor metadata. */
  hash?: string;
  size?: number;
  /** Poison-kill metadata. */
  name?: string;
  archetype?: Archetype;
  /** Cull metadata: count plus each victim's last position. */
  count?: number;
  positions?: { id: number; x: number; y: number }[];
  /** Intervention metadata. */
  kind?: Intervention['type'];
}

export interface World {
  seed: number;
  tick: number;
  config: WorldConfig;
  rng: Rng;
  creatures: Creature[];
  foods: Food[];
  effects: TimedEffect[];
  /** Cull history: hourly harvests and daily judgment days. */
  culls: CullRecord[];
  /** Ring buffer of recent positioned events for visualization. */
  eventLog: SimEvent[];
  nextEventSeq: number;
  statsLog: TickStats[];
  lastEvents: string[];
  nextCreatureId: number;
  nextFoodId: number;
  spawnAccumulator: number;
  lastChainTemp: number;
  totalBorn: number;
  totalDied: number;
  totalFoodSpawned: number;
  totalPredations: number;
}

const STATS_LOG_CAP = 5000;
const EVENT_LOG_CAP = 200;
/** Below this fraction of max energy a creature hunts plankton by instinct. */
const HUNGER_LINE = 0.55;
/**
 * A whale transfer only becomes a *boom* (a pull that turns nearby heads)
 * from this size up, where the 3 * size^2 yield guarantees at least one pellet
 * actually landed (~$770 in USDC terms). Gating on the pellet roll instead
 * would fire it on $50 transfers too: on a live chain that is ~2 booms a
 * second, permanently yanking the whole tank and making real money invisible.
 * At this bar a live Arc feed booms about once every 9 seconds.
 * Exported so the server can flag the same transfers for the viewer.
 */
export const WHALE_BOOM_SIZE = 1 / Math.sqrt(3);
/**
 * Reach and lifetime of a whale boom's pull. 64 ticks at ~2.3 units/tick is
 * about 150 units of travel, so a creature anywhere inside the radius can
 * actually reach the plankton that fell, a wider zone would only turn heads
 * that never arrive, and the rush is the whole point of the mechanic.
 */
const WHALE_BOOM_RADIUS = 150;
const WHALE_BOOM_TICKS = 64;

/** Append a positioned event to the ring buffer. */
function pushEvent(world: World, e: Omit<SimEvent, 'seq' | 'tick'>): void {
  world.eventLog.push({ ...e, seq: world.nextEventSeq++, tick: world.tick });
  if (world.eventLog.length > EVENT_LOG_CAP) {
    world.eventLog.splice(0, world.eventLog.length - EVENT_LOG_CAP);
  }
}

/** Shortest signed distance from a to b on a ring of the given size. */
function torusDelta(a: number, b: number, size: number): number {
  let d = b - a;
  if (d > size / 2) d -= size;
  else if (d < -size / 2) d += size;
  return d;
}

function wrap(v: number, size: number): number {
  return ((v % size) + size) % size;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function makeCreature(
  world: World,
  genome: Genome,
  x: number,
  y: number,
  energy: number,
  generation: number,
): Creature {
  const archetype = archetypeOf(genome);
  const id = world.nextCreatureId++;
  return {
    id,
    name: creatureName(archetype, id),
    x,
    y,
    energy,
    genome,
    archetype,
    radius: world.config.creatureRadius * ARCHETYPES[archetype].radiusMult,
    kills: 0,
    devouredTotal: 0,
    huntReadyAt: 0,
    generation,
    bornTick: world.tick,
  };
}

/**
 * Niche saturation: once a species holds more than this share of the tank, its
 * offspring radiate into the emptiest niche instead of cloning the crowding.
 * Plain selection cannot keep the reserve mixed, in a chain-fed tank the eat
 * drive is always the winning bias, so evolution settles into a single-species
 * world (measured: 125/125 WHALE) and the biodiversity the tank is meant to
 * show disappears.
 */
const NICHE_SATURATION = 0.4;

function archetypeTally(creatures: readonly Creature[]): Record<Archetype, number> {
  const counts: Record<Archetype, number> = { APE: 0, WHALE: 0, ALGO: 0, INSIDER: 0 };
  for (const c of creatures) counts[c.archetype]++;
  return counts;
}

function rarestArchetype(counts: Record<Archetype, number>): Archetype {
  let rarest = ARCHETYPE_LIST[0];
  for (const a of ARCHETYPE_LIST) if (counts[a] < counts[rarest]) rarest = a;
  return rarest;
}

/**
 * The niche that owns more than `share` of the tank, and how far past that
 * line it is (0..1, 1 = total monopoly). Null while no species dominates.
 */
function exhaustedNiche(
  counts: Record<Archetype, number>,
  pop: number,
  share: number,
): { archetype: Archetype; excess: number } | null {
  let top = ARCHETYPE_LIST[0];
  for (const a of ARCHETYPE_LIST) if (counts[a] > counts[top]) top = a;
  if (pop === 0 || counts[top] / pop <= share) return null;
  return { archetype: top, excess: Math.min(1, (counts[top] / pop - share) / (1 - share)) };
}

function radiateIfSaturated(world: World, genome: Genome, parent: Archetype): void {
  const pop = world.creatures.length;
  if (pop === 0) return;
  const counts = archetypeTally(world.creatures);
  if (counts[parent] / pop <= NICHE_SATURATION) return;
  const rarest = rarestArchetype(counts);
  if (rarest !== parent) steerArchetype(genome, rarest);
}

/**
 * How many creatures the tank is missing: everyone it owes back up to its
 * floor, or, while a monopoly still fills the glass, the species it has
 * crowded out entirely. A monopoly that left every niche occupied is left
 * alone; the exhaustion cost is already pulling it back down. A floor of zero
 * switches the life support off, which is what isolated scenarios want.
 */
function recolonizeGap(world: World): number {
  const cfg = world.config;
  if (cfg.populationFloor <= 0) return 0;
  const pop = world.creatures.length;
  if (pop < cfg.populationFloor) return cfg.populationFloor - pop;
  const counts = archetypeTally(world.creatures);
  if (!exhaustedNiche(counts, pop, cfg.dominanceShare)) return 0;
  return ARCHETYPE_LIST.filter((a) => counts[a] === 0).length;
}

/**
 * Life drifts back into the emptiest niches. Seeded from the world RNG like
 * every other birth, so a replay of the same inputs regrows the same reserve.
 */
function recolonize(world: World, gap: number): number {
  const cfg = world.config;
  const counts = archetypeTally(world.creatures);
  const seeded = Math.min(gap, cfg.colonistsPerTick);
  for (let i = 0; i < seeded; i++) {
    const target = rarestArchetype(counts);
    const genome = randomGenome(world.rng);
    steerArchetype(genome, target);
    counts[target]++;
    world.creatures.push(
      makeCreature(
        world,
        genome,
        world.rng.range(0, cfg.width),
        world.rng.range(0, cfg.height),
        world.rng.range(50, 80),
        1,
      ),
    );
  }
  world.totalBorn += seeded;
  return seeded;
}

export function createWorld(seed: number, config: WorldConfig = DEFAULT_CONFIG): World {
  const rng = new Rng(seed);
  const world: World = {
    seed,
    tick: 0,
    config,
    rng,
    creatures: [],
    foods: [],
    effects: [],
    culls: [],
    eventLog: [],
    nextEventSeq: 1,
    statsLog: [],
    lastEvents: [],
    nextCreatureId: 1,
    nextFoodId: 1,
    spawnAccumulator: 0,
    lastChainTemp: 0.5,
    totalBorn: 0,
    totalDied: 0,
    totalFoodSpawned: 0,
    totalPredations: 0,
  };
  for (let i = 0; i < config.initialPopulation; i++) {
    world.creatures.push(
      makeCreature(
        world,
        randomGenome(rng),
        rng.range(0, config.width),
        rng.range(0, config.height),
        rng.range(50, 80),
        1,
      ),
    );
  }
  world.totalBorn = world.creatures.length;
  for (let i = 0; i < config.initialFood; i++) {
    spawnFood(world, rng.range(0, config.width), rng.range(0, config.height));
  }
  return world;
}

function spawnFood(world: World, x: number, y: number, energy?: number): void {
  if (world.foods.length >= world.config.maxFood) return;
  world.foods.push({
    id: world.nextFoodId++,
    x: wrap(x, world.config.width),
    y: wrap(y, world.config.height),
    energy: energy ?? world.config.foodEnergy,
  });
  world.totalFoodSpawned++;
}

/** Spawn-rate multiplier from active intervention effects (drought beats bloom). */
function spawnMultiplier(world: World): number {
  let mult = 1;
  for (const e of world.effects) {
    if (e.kind === 'drought') return 0;
    if (e.kind === 'bloom') mult *= 2;
  }
  return mult;
}

/** Food spawned per tick: base rate modulated by chain temperature (0.2x .. 1.8x). */
export function effectiveSpawnRate(world: World, chainTemp: number): number {
  return world.config.baseSpawnRate * (0.2 + 1.6 * chainTemp) * spawnMultiplier(world);
}

/** Average genome distance to the population mean over a fixed sample (0..~1). */
function measureDiversity(world: World): number {
  const sample = world.creatures.slice(0, 30);
  if (sample.length < 2) return 0;
  const dims = 9; // first 8 w1 weights + hue
  const mean = new Array<number>(dims).fill(0);
  for (const c of sample) {
    for (let d = 0; d < dims - 1; d++) mean[d] += c.genome.w1[d];
    mean[dims - 1] += c.genome.color[0];
  }
  for (let d = 0; d < dims; d++) mean[d] /= sample.length;
  let sum = 0;
  for (const c of sample) {
    let acc = 0;
    for (let d = 0; d < dims - 1; d++) acc += (c.genome.w1[d] - mean[d]) ** 2;
    acc += (c.genome.color[0] - mean[dims - 1]) ** 2;
    sum += Math.sqrt(acc / dims);
  }
  return sum / sample.length;
}

/** Shared cull logic for hourly harvests and daily judgment days. */
function cullWeakest(
  world: World,
  ratio: number,
  minCull: number,
  type: CullType,
): CullRecord | null {
  const cfg = world.config;
  if (world.creatures.length <= cfg.populationFloor) return null;
  const pop = world.creatures.length;
  const cullCount = Math.max(minCull, Math.floor(pop * ratio));
  if (cullCount <= 0) return null;
  const sorted = [...world.creatures].sort((a, b) => a.energy - b.energy);
  const doomed = sorted.slice(0, cullCount);
  const doomedIds = new Set(doomed.map((c) => c.id));
  world.creatures = world.creatures.filter((c) => !doomedIds.has(c.id));
  world.totalDied += cullCount;
  const record: CullRecord = {
    type,
    tick: world.tick,
    day: Math.floor(world.tick / cfg.ticksPerDay),
    culled: doomed.map((c) => ({
      id: c.id,
      name: c.name,
      generation: c.generation,
      energy: Math.round(c.energy * 100) / 100,
      archetype: c.archetype,
      age: world.tick - c.bornTick,
    })),
    populationBefore: pop,
    populationAfter: world.creatures.length,
  };
  world.culls.push(record);
  pushEvent(world, {
    type,
    count: cullCount,
    positions: doomed.map((c) => ({
      id: c.id,
      x: Math.round(c.x * 10) / 10,
      y: Math.round(c.y * 10) / 10,
    })),
  });
  return record;
}

export function tick(world: World, senses: Senses, txs: TxMeteor[] = []): TickStats {
  const cfg = world.config;
  const rng = world.rng;
  const chainTemp = clamp01(senses.chain);
  const marketTemp = clamp01(senses.market);
  world.tick++;
  const events: string[] = [];
  const chainDelta = chainTemp - world.lastChainTemp;
  world.lastChainTemp = chainTemp;

  // Market volatility excites the ecosystem: faster, messier movement and
  // a higher metabolism while the market is hot.
  const speedFactor = 1 + marketTemp; // 1..2
  const metaFactor = 1 + 0.5 * marketTemp; // 1..1.5

  // Expire timed effects.
  const before = world.effects.length;
  world.effects = world.effects.filter((e) => e.expiresTick > world.tick);
  for (let i = 0; i < before - world.effects.length; i++) events.push('effect-expired');

  // Spawn food (fractional rates accumulate deterministically).
  world.spawnAccumulator += effectiveSpawnRate(world, chainTemp);
  const toSpawn = Math.floor(world.spawnAccumulator);
  world.spawnAccumulator -= toSpawn;
  for (let i = 0; i < toSpawn; i++) {
    spawnFood(world, rng.range(0, cfg.width), rng.range(0, cfg.height));
  }

  // Transaction meteors: each on-chain tx falls at its landing site (explicit
  // `at` when the world knows whose money it is, else hash-derived). Dust, the
  // overwhelming majority of chain traffic, makes a visible streak but no
  // plankton; food yield is steep in dollars, so real money is a local boom and
  // a whale-sized transfer is a feast. Paying every tx a flat pellet instead
  // floods the tank past its food cap on a busy chain, and once nothing is
  // scarce nothing matters: no hunger, no competition, no reason to watch.
  for (const tx of txs) {
    const size = clamp01(tx.size);
    const { x, y } = tx.at ?? txLanding(tx.hash, cfg.width, cfg.height);
    const yieldPellets = 3 * size * size;
    let count = Math.floor(yieldPellets);
    if (rng.next() < yieldPellets - count) count++;
    const energy = cfg.foodEnergy * (0.25 + size);
    for (let i = 0; i < count; i++) {
      const a = rng.range(0, Math.PI * 2);
      const d = Math.sqrt(rng.next()) * (10 + size * 30);
      spawnFood(world, x + Math.cos(a) * d, y + Math.sin(a) * d, energy);
    }
    // An explicit landing site means the money belongs to an address the world
    // embodies, so a big enough fall is a *local* boom: creatures near enough
    // to have seen it land turn toward the patch and race the rest of the tank
    // to it. Bounded on purpose, the whole-map swarm stays the paid feed's
    // signature, and small change from the same address just feeds the water.
    if (tx.at && size >= WHALE_BOOM_SIZE) {
      world.effects.push({
        kind: 'boom',
        x,
        y,
        radius: WHALE_BOOM_RADIUS,
        expiresTick: world.tick + WHALE_BOOM_TICKS,
        damagePerTick: 0,
      });
    }
    if (size > 0.6) {
      const R = 60;
      for (const c of world.creatures) {
        const dx = torusDelta(x, c.x, cfg.width);
        const dy = torusDelta(y, c.y, cfg.height);
        const d2 = dx * dx + dy * dy;
        if (d2 < R * R && d2 > 0.01) {
          const d = Math.sqrt(d2);
          const push = (1 - d / R) * 20 * size;
          c.x = wrap(c.x + (dx / d) * push, cfg.width);
          c.y = wrap(c.y + (dy / d) * push, cfg.height);
        }
      }
    }
    pushEvent(world, { type: 'tx_meteor', x, y, size, hash: tx.hash });
  }

  // Poison damage.
  for (const e of world.effects) {
    if (e.kind !== 'poison') continue;
    for (const c of world.creatures) {
      const dx = torusDelta(e.x, c.x, cfg.width);
      const dy = torusDelta(e.y, c.y, cfg.height);
      if (dx * dx + dy * dy <= e.radius * e.radius) c.energy -= e.damagePerTick;
    }
  }

  const births: Creature[] = [];
  // Niche exhaustion is priced once per tick: a species that owns almost the
  // whole tank is competing with itself for one shape of food. Without it a
  // monoculture is a stable endpoint and the reserve never leaves it.
  const exhaustion =
    cfg.populationFloor > 0 && world.creatures.length >= cfg.populationFloor
      ? exhaustedNiche(
          archetypeTally(world.creatures),
          world.creatures.length,
          cfg.dominanceShare,
        )
      : null;
  for (const c of world.creatures) {
    const traits = ARCHETYPES[c.archetype];
    // --- senses ---
    let nearestFood: Food | null = null;
    let foodDistSq = Infinity;
    for (const f of world.foods) {
      const dx = torusDelta(c.x, f.x, cfg.width);
      const dy = torusDelta(c.y, f.y, cfg.height);
      const d2 = dx * dx + dy * dy;
      if (d2 < foodDistSq) {
        foodDistSq = d2;
        nearestFood = f;
      }
    }
    // Feast attractors (from feed interventions) read as an artificially
    // close food signal, so brains swarm toward the drop zone. The signal is
    // kept separate from the true nearest-food distance: an attractor is a
    // rumour of food, and letting it stand in for a real pellet would let a
    // creature "eat" across the whole tank once the drop zone is picked clean.
    let feastTarget: TimedEffect | null = null;
    let senseDistSq = foodDistSq;
    for (const e of world.effects) {
      if (e.kind !== 'feast') continue;
      const dx = torusDelta(c.x, e.x, cfg.width);
      const dy = torusDelta(c.y, e.y, cfg.height);
      const d2 = (dx * dx + dy * dy) * 0.05;
      if (d2 < senseDistSq) {
        senseDistSq = d2;
        feastTarget = e;
      }
    }
    let nearestPeer: Creature | null = null;
    let peerDistSq = Infinity;
    for (const p of world.creatures) {
      if (p === c) continue;
      const dx = torusDelta(c.x, p.x, cfg.width);
      const dy = torusDelta(c.y, p.y, cfg.height);
      const d2 = dx * dx + dy * dy;
      if (d2 < peerDistSq) {
        peerDistSq = d2;
        nearestPeer = p;
      }
    }
    const foodDx = feastTarget
      ? torusDelta(c.x, feastTarget.x, cfg.width)
      : nearestFood ? torusDelta(c.x, nearestFood.x, cfg.width) : 0;
    const foodDy = feastTarget
      ? torusDelta(c.y, feastTarget.y, cfg.height)
      : nearestFood ? torusDelta(c.y, nearestFood.y, cfg.height) : 0;
    const peerDx = nearestPeer ? torusDelta(c.x, nearestPeer.x, cfg.width) : 0;
    const peerDy = nearestPeer ? torusDelta(c.y, nearestPeer.y, cfg.height) : 0;
    const foodDist = Math.sqrt(foodDistSq);
    const input = [
      Math.max(-1, Math.min(1, foodDx / 200)),
      Math.max(-1, Math.min(1, foodDy / 200)),
      1 / (1 + Math.sqrt(senseDistSq) / 50),
      Math.max(-1, Math.min(1, peerDx / 200)),
      Math.max(-1, Math.min(1, peerDy / 200)),
      Math.min(1, c.energy / cfg.reproduceThreshold),
      chainTemp,
      Math.max(-1, Math.min(1, chainDelta * 10)),
      marketTemp,
    ];

    // --- brain ---
    const out = forward(c.genome, input);

    // --- movement (market jitter makes hot markets messier) ---
    const jitter = (rng.next() - 0.5) * marketTemp * 0.8;
    let angle = out.angle + jitter;
    let speed = out.strength * cfg.maxSpeed * traits.speedMult * speedFactor;
    // Attractors override the heading toward the drop zone. A paid feast pulls
    // the whole map in and outranks even hunger; a whale boom only pulls
    // creatures inside its radius, the ones that could plausibly have seen the
    // money land, so a chain with a whale transfer every few seconds never
    // yanks the entire tank around.
    for (const e of world.effects) {
      if (e.kind !== 'feast' && e.kind !== 'boom') continue;
      const dx = torusDelta(c.x, e.x, cfg.width);
      const dy = torusDelta(c.y, e.y, cfg.height);
      if (e.kind === 'boom' && dx * dx + dy * dy > e.radius * e.radius) continue;
      angle = Math.atan2(dy, dx);
      speed = Math.max(speed, 2.2);
    }
    // Hunger is an instinct, not a learned behaviour: below the hunger line a
    // creature turns toward the nearest plankton whatever its (randomly
    // evolved) brain voted for. Without it the tank never shows scarcity, so a
    // boom where a whale just moved real money would pass unnoticed. It also
    // outranks the boom once the creature has arrived: the pellets scatter up
    // to ~37 units from the impact, and hovering on the exact center would
    // starve a fish with food all around it.
    const hungry = c.energy < cfg.maxEnergy * HUNGER_LINE;
    if (hungry && !feastTarget && nearestFood && foodDist > cfg.eatRadius) {
      angle = Math.atan2(foodDy, foodDx);
      speed = Math.max(speed, cfg.maxSpeed * 0.75 * traits.speedMult * speedFactor);
    }
    c.x = wrap(c.x + Math.cos(angle) * speed, cfg.width);
    c.y = wrap(c.y + Math.sin(angle) * speed, cfg.height);
    c.energy -=
      cfg.basalCost * traits.basalMult * metaFactor +
      cfg.moveCost * out.strength * out.strength * speedFactor +
      (exhaustion && exhaustion.archetype === c.archetype
        ? cfg.dominanceCost * exhaustion.excess
        : 0);

    // --- poison panic: strong visible flight away from the zone center ---
    for (const e of world.effects) {
      if (e.kind !== 'poison') continue;
      const dx = torusDelta(e.x, c.x, cfg.width);
      const dy = torusDelta(e.y, c.y, cfg.height);
      const d2 = dx * dx + dy * dy;
      if (d2 < 0.01 || d2 > e.radius * e.radius) continue;
      const d = Math.sqrt(d2);
      c.x = wrap(c.x + (dx / d) * 3, cfg.width);
      c.y = wrap(c.y + (dy / d) * 3, cfg.height);
    }

    // --- eating: a hungry creature always takes the bite it swam to ---
    if (
      (hungry || out.eat > cfg.eatUrgeThreshold) &&
      nearestFood &&
      foodDistSq <= cfg.eatRadius * cfg.eatRadius
    ) {
      c.energy = Math.min(cfg.maxEnergy, c.energy + nearestFood.energy);
      world.foods.splice(world.foods.indexOf(nearestFood), 1);
    }

    // --- asexual reproduction with mutation ---
    // Carrying capacity breathes with chain activity: a quiet chain starves
    // the tank below its ceiling, a hot chain lets it refill.
    if (
      out.reproduce > cfg.reproduceUrgeThreshold &&
      c.energy > cfg.reproduceThreshold &&
      world.creatures.length + births.length < cfg.maxPopulation * (0.6 + 0.4 * chainTemp)
    ) {
      c.energy -= cfg.reproduceCost;
      const childGenome = mutateGenome(c.genome, rng, cfg.mutationRate, cfg.mutationScale);
      radiateIfSaturated(world, childGenome, c.archetype);
      births.push(
        makeCreature(
          world,
          childGenome,
          wrap(c.x + rng.range(-10, 10), cfg.width),
          wrap(c.y + rng.range(-10, 10), cfg.height),
          cfg.reproduceCost,
          c.generation + 1,
        ),
      );
    }
  }
  if (births.length > 0) {
    world.creatures.push(...births);
    world.totalBorn += births.length;
    events.push(`births:${births.length}`);
  }

  // --- predation: WHALEs devour much smaller non-WHALE creatures on contact ---
  const eaten = new Set<number>();
  for (const c of world.creatures) {
    if (c.archetype !== 'WHALE' || eaten.has(c.id)) continue;
    // Digestion: one meal per cooldown. Without it predation is unlimited and a
    // tank that evolution collapsed into wall-to-wall whales turns every
    // arriving species into free food, so the monopoly never ends.
    if (world.tick < c.huntReadyAt) continue;
    for (const p of world.creatures) {
      if (p === c || p.archetype === 'WHALE' || eaten.has(p.id)) continue;
      if (p.radius >= c.radius * 0.6) continue;
      const dx = torusDelta(c.x, p.x, cfg.width);
      const dy = torusDelta(c.y, p.y, cfg.height);
      const reach = c.radius + p.radius;
      if (dx * dx + dy * dy <= reach * reach) {
        eaten.add(p.id);
        // 50% of the prey's remaining energy transfers, the rest dissipates.
        const gain = Math.max(0, p.energy * 0.5);
        c.energy = Math.min(cfg.maxEnergy, c.energy + gain);
        c.devouredTotal += gain;
        c.kills++;
        c.huntReadyAt = world.tick + cfg.huntCooldown;
        // Kill growth: every kill makes the whale visibly bigger (capped).
        const baseRadius = cfg.creatureRadius * ARCHETYPES[c.archetype].radiusMult;
        c.radius = Math.min(c.radius * 1.04, baseRadius * 1.5);
        events.push(`predation:${c.id}->${p.id}`);
        pushEvent(world, {
          type: 'predation',
          x: Math.round(p.x * 10) / 10,
          y: Math.round(p.y * 10) / 10,
          predatorId: c.id,
          preyId: p.id,
          predatorArchetype: c.archetype,
          preyArchetype: p.archetype,
          predatorName: c.name,
          preyName: p.name,
        });
        break; // one meal, then it digests
      }
    }
  }
  if (eaten.size > 0) {
    world.creatures = world.creatures.filter((c) => !eaten.has(c.id));
    world.totalDied += eaten.size;
    world.totalPredations += eaten.size;
  }

  // --- starvation (deaths inside a poison zone are marked poison_kill) ---
  const poisonZones = world.effects.filter((e) => e.kind === 'poison');
  const aliveBefore = world.creatures.length;
  for (const c of world.creatures) {
    if (c.energy > 0) continue;
    for (const e of poisonZones) {
      const dx = torusDelta(e.x, c.x, cfg.width);
      const dy = torusDelta(e.y, c.y, cfg.height);
      if (dx * dx + dy * dy <= e.radius * e.radius) {
        pushEvent(world, {
          type: 'poison_kill',
          x: Math.round(c.x * 10) / 10,
          y: Math.round(c.y * 10) / 10,
          name: c.name,
          archetype: c.archetype,
        });
        break;
      }
    }
  }
  world.creatures = world.creatures.filter((c) => c.energy > 0);
  const starved = aliveBefore - world.creatures.length;
  if (starved > 0) {
    world.totalDied += starved;
    events.push(`starved:${starved}`);
  }

  // --- hourly harvest (2% weakest) and daily judgment day (10% weakest) ---
  if (world.tick % cfg.harvestInterval === 0) {
    const record = cullWeakest(world, cfg.harvestCullRatio, 0, 'harvest');
    if (record) events.push(`harvest:culled-${record.culled.length}`);
  }
  if (world.tick % cfg.judgmentInterval === 0) {
    const record = cullWeakest(world, cfg.judgmentCullRatio, 1, 'judgment');
    if (record) events.push(`judgment:culled-${record.culled.length}`);
  }

  // --- recolonization: an empty glass box and a one-species tank are both
  // dead ends, so whatever niche is emptiest drifts back in first.
  const gap = recolonizeGap(world);
  if (gap > 0) {
    const seeded = recolonize(world, gap);
    if (seeded > 0) events.push(`recolonize:${seeded}`);
  }

  const byArchetype: Record<Archetype, number> = { APE: 0, WHALE: 0, ALGO: 0, INSIDER: 0 };
  for (const c of world.creatures) byArchetype[c.archetype]++;
  const stats: TickStats = {
    tick: world.tick,
    day: Math.floor(world.tick / cfg.ticksPerDay),
    population: world.creatures.length,
    populationByArchetype: byArchetype,
    totalEnergy: Math.round(world.creatures.reduce((s, c) => s + c.energy, 0) * 100) / 100,
    diversity: Math.round(measureDiversity(world) * 1000) / 1000,
    chainTemp,
    marketTemp,
    events,
  };
  world.statsLog.push(stats);
  if (world.statsLog.length > STATS_LOG_CAP) world.statsLog.splice(0, 1000);
  world.lastEvents = events;
  return stats;
}

export interface InterventionResult {
  /** Human-readable receipt line. */
  message: string;
  /** Creatures inside the affected zone at apply time (population for global ones). */
  affected: number;
  /** Feed only: food points dropped. */
  amount?: number;
}

function countInZone(world: World, x: number, y: number, radius: number): number {
  let n = 0;
  for (const c of world.creatures) {
    const dx = torusDelta(x, c.x, world.config.width);
    const dy = torusDelta(y, c.y, world.config.height);
    if (dx * dx + dy * dy <= radius * radius) n++;
  }
  return n;
}

/** Apply a (already paid for) intervention. */
export function applyIntervention(world: World, intervention: Intervention): InterventionResult {
  const cfg = world.config;
  switch (intervention.type) {
    case 'feed': {
      const amount = Math.floor(intervention.amount ?? 40);
      for (let i = 0; i < amount; i++) {
        const angle = world.rng.range(0, Math.PI * 2);
        const dist = Math.sqrt(world.rng.next()) * intervention.radius;
        spawnFood(
          world,
          intervention.x + Math.cos(angle) * dist,
          intervention.y + Math.sin(angle) * dist,
        );
      }
      // Feast attractor: brains swarm the drop zone for ~400 ticks.
      world.effects.push({
        kind: 'feast',
        x: wrap(intervention.x, cfg.width),
        y: wrap(intervention.y, cfg.height),
        radius: 250,
        expiresTick: world.tick + 400,
        damagePerTick: 0,
      });
      world.lastEvents.push(`intervention:feed@${Math.round(intervention.x)},${Math.round(intervention.y)}`);
      pushEvent(world, {
        type: 'intervention', kind: 'feed',
        x: intervention.x, y: intervention.y, radius: intervention.radius,
      });
      return {
        message: `feed: dropped ${amount} food around (${Math.round(intervention.x)}, ${Math.round(intervention.y)})`,
        affected: countInZone(world, intervention.x, intervention.y, 250),
        amount,
      };
    }
    case 'poison': {
      const duration = intervention.durationTicks ?? 1600;
      world.effects.push({
        kind: 'poison',
        x: wrap(intervention.x, cfg.width),
        y: wrap(intervention.y, cfg.height),
        radius: intervention.radius,
        expiresTick: world.tick + duration,
        damagePerTick: 2.0,
      });
      world.lastEvents.push(`intervention:poison@${Math.round(intervention.x)},${Math.round(intervention.y)}`);
      pushEvent(world, {
        type: 'intervention', kind: 'poison',
        x: intervention.x, y: intervention.y, radius: intervention.radius,
      });
      return {
        message: `poison: radius ${intervention.radius} at (${Math.round(intervention.x)}, ${Math.round(intervention.y)}) for ${duration} ticks`,
        affected: countInZone(world, intervention.x, intervention.y, intervention.radius),
      };
    }
    case 'bloom': {
      const duration = intervention.durationTicks ?? 2400;
      world.effects.push({ kind: 'bloom', x: 0, y: 0, radius: 0, expiresTick: world.tick + duration, damagePerTick: 0 });
      world.lastEvents.push('intervention:bloom');
      pushEvent(world, { type: 'intervention', kind: 'bloom' });
      return {
        message: `bloom: food spawn x2 for ${duration} ticks`,
        affected: world.creatures.length,
      };
    }
    case 'drought': {
      const duration = intervention.durationTicks ?? 2400;
      world.effects.push({ kind: 'drought', x: 0, y: 0, radius: 0, expiresTick: world.tick + duration, damagePerTick: 0 });
      world.lastEvents.push('intervention:drought');
      pushEvent(world, { type: 'intervention', kind: 'drought' });
      return {
        message: `drought: food spawn halted for ${duration} ticks`,
        affected: world.creatures.length,
      };
    }
  }
}

interface WorldJSON extends Omit<World, 'rng'> {
  rngState: number;
}

export function toJSON(world: World): string {
  const { rng, ...rest } = world;
  const payload: WorldJSON = { ...rest, rngState: rng.getState() };
  return JSON.stringify(payload);
}

export function fromJSON(json: string): World {
  const payload = JSON.parse(json) as WorldJSON;
  const { rngState, ...rest } = payload;
  // Backfill fields added after older snapshots were written.
  rest.eventLog ??= [];
  rest.nextEventSeq ??= 1;
  for (const c of rest.creatures ?? []) {
    c.kills ??= 0;
    c.devouredTotal ??= 0;
    // Snapshots written before digestion existed carry no cooldown; resuming
    // them hungry lets every predator take a free kill on the same tick, which
    // wipes the prey layer each restart. Load them as freshly fed instead.
    c.huntReadyAt ??= rest.tick + (rest.config?.huntCooldown ?? DEFAULT_CONFIG.huntCooldown);
    c.name ??= creatureName(c.archetype, c.id);
  }
  for (const cull of rest.culls ?? []) {
    for (const victim of cull.culled) {
      victim.archetype ??= 'INSIDER';
      victim.age ??= 0;
      victim.name ??= creatureName(victim.archetype, victim.id);
    }
  }
  const rng = new Rng(0);
  rng.setState(rngState);
  return { ...rest, rng };
}
