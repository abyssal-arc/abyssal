import { Rng } from './prng.js';
import {
  ARCHETYPES,
  ARCHETYPE_LIST,
  archetypeOf,
  creatureName,
  forward,
  mutateGenome,
  mutateTrait,
  randomGenome,
  steerArchetype,
  type Archetype,
  type GeneTrait,
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
  /** Whole USDC of the transfer, when the feed knows it. */
  usd?: number;
  /**
   * Explicit landing site, overriding the hash-derived one. Used when the
   * transfer belongs to an address the world embodies (a chain whale): its
   * money must fall where the leviathan is swimming, not at a hash coordinate,
   * or the causal link between the two is invisible.
   */
  at?: { x: number; y: number };
  /**
   * A paid wishing meteor carries its message into the water: the tank renders
   * the words next to the fall, so the burn leaves something readable behind
   * instead of only plankton.
   */
  wish?: { message: string; addr: string };
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
  /** Who spawned this creature, for the fate line; null for colonists. */
  parentId: number | null;
  /** How many children this creature produced. */
  offspring: number;
  /** Largest single meal, in energy. */
  maxMeal: number;
  /** Tx hash of that largest meal, null when it was prey or plankton. */
  maxMealTx: string | null;
  /** Whole USDC of the transfer that meal fell from, 0 when unknown. */
  maxMealUsd: number;
  /** True once the creature stood inside a whale boom. */
  boomTouched: boolean;
  /**
   * A name a visitor paid for. It replaces the generated codename everywhere the
   * tank speaks — the card, the leaderboards, the kill banners, the obituaries
   * and the lineage — which is the whole point of buying one. The codename is
   * not thrown away: `name` keeps it as the birth record, and the payload hands
   * it down beside the paid one as `baseName`.
   */
  customName?: string;
  /**
   * An ark ticket: harvests and judgment days pass this creature over. Paid,
   * permanent for the life of the creature, and never inherited — a child is
   * born mortal whatever its parent carried.
   */
  arkProtected?: boolean;
  /** Who bought the ticket, so the card can name its guarantor. */
  arkBy?: string;
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

export interface Obituary {
  id: number;
  name: string;
  archetype: Archetype;
  generation: number;
  bornTick: number;
  diedTick: number;
  /** starvation | poison | predation | harvest | judgment */
  cause: string;
  kills: number;
  offspring: number;
  maxMeal: number;
  titles: string[];
}

export interface Food {
  /** Tx hash whose landing spawned this pellet, for the meteor-to-eater trail. */
  src?: string;
  /** Whole USDC of that transfer, so a meal can be priced in its story. */
  srcUsd?: number;
  id: number;
  x: number;
  y: number;
  energy: number;
}

export type Intervention =
  | { type: 'feed'; x: number; y: number; radius: number; amount?: number }
  | { type: 'poison'; x: number; y: number; radius: number; durationTicks?: number }
  | { type: 'bloom'; durationTicks?: number }
  | { type: 'drought'; durationTicks?: number }
  | { type: 'name'; creatureId: number; name: string }
  | { type: 'wish'; message: string; x?: number; y?: number }
  | { type: 'mutate'; creatureId: number; trait: GeneTrait; direction: 'boost' | 'suppress' }
  | { type: 'ark'; creatureId: number };

/** A life this old, or this bloody, costs ten times the price to rename. */
export const LEGENDARY_GENERATION = 5;
export const LEGENDARY_KILLS = 5;

/** Whether naming this creature is a legendary (tenfold) purchase. */
export function isLegendary(c: Creature): boolean {
  return c.generation >= LEGENDARY_GENERATION || c.kills >= LEGENDARY_KILLS;
}

/** Size of a paid wishing meteor: a streak and a handful of plankton, not a boom. */
export const WISH_METEOR_SIZE = 0.4;

/**
 * What that streak breaks into, as a pellet count of its own.
 *
 * Deliberately not the chain rain's `3 * size * size`: at this size that formula
 * yields 0.48 pellets, so three wishes in four land in empty water and the buyer
 * gets nothing but a line of text. A bought wish always lands a visible handful.
 *
 * Six keeps it a keepsake rather than a grocery run. A wish costs a quarter of a
 * feed, and a feed dropped from the route carries no amount and so scatters the
 * default 40: this is 15% of that bounty for 25% of the price, i.e. about 1.7x
 * the ABYS per pellet, with no feast attractor calling the tank to it besides.
 * Food bought this way is always food bought badly.
 */
export const WISH_PELLETS = 6;

/** How wide that handful scatters, in world units. */
const WISH_SPREAD = 34;

/**
 * The name the tank answers to. A paid name overwrites the generated codename
 * everywhere the creature is spoken about — kill cams, obituaries, cull lists,
 * leaderboards — because the point of buying one is that the tank starts using
 * it. `creature.name` keeps the birth codename for lineage and records.
 */
export function displayName(c: Creature): string {
  return c.customName ?? c.name;
}

export interface TimedEffect {
  /** `boom` = a whale's own transfer landed plankton here and pulls locally. */
  kind: 'poison' | 'bloom' | 'drought' | 'feast' | 'boom';
  x: number;
  y: number;
  radius: number;
  expiresTick: number;
  /** Poison only: energy drained per tick inside the radius. */
  damagePerTick: number;
  /** Who paid for this intervention, so the tank can name its author. */
  payer?: string;
  /** What they paid, as displayed (e.g. "50000 ABYS"). */
  paid?: string;
  /** Poison only: kills attributed so far, for the backlash rule. */
  kills?: number;
  backlashed?: boolean;
  /** Full lifetime in ticks, so the client can draw a time bar. */
  life?: number;
  /** Creatures inside the zone when it was paid for. */
  affected?: number;
  /** The burn transaction that paid for this, so weather stays traceable. */
  tx?: string;
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
  /**
   * Ark-protected creatures that sat inside the cull's reach and walked away:
   * the ticket is only worth its price if the tank can show it working.
   */
  saved: { id: number; name: string; x: number; y: number }[];
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
  type:
    | 'predation' | 'harvest' | 'judgment' | 'intervention' | 'tx_meteor'
    | 'poison_kill' | 'reseed' | 'memorial'
    | 'naming' | 'wish' | 'mutation' | 'ark';
  /** World coordinates, when the event is localized. */
  x?: number;
  y?: number;
  radius?: number;
  /** Intervention attribution: payer address and what they paid. */
  payer?: string;
  paid?: string;
  affected?: number;
  /** Predation metadata. */
  predatorId?: number;
  preyId?: number;
  predatorArchetype?: Archetype;
  preyArchetype?: Archetype;
  predatorName?: string;
  preyName?: string;
  /** Reseeded species, for `reseed` events. */
  species?: Archetype;
  /** Meteor metadata. */
  hash?: string;
  size?: number;
  /** Poison-kill metadata. */
  name?: string;
  archetype?: Archetype;
  /** Cull metadata: count plus each victim's last position. */
  count?: number;
  positions?: { id: number; x: number; y: number }[];
  /** Ark saves during a cull, so the viewer can flash the survivors. */
  saved?: { id: number; name: string; x: number; y: number }[];
  /** Paid-identity metadata: which creature, and what was done to it. */
  creatureId?: number;
  message?: string;
  trait?: GeneTrait;
  direction?: 'boost' | 'suppress';
  /** Intervention metadata. */
  kind?: Intervention['type'] | 'backlash';
}

export interface World {
  seed: number;
  tick: number;
  config: WorldConfig;
  rng: Rng;
  creatures: Creature[];
  foods: Food[];
  effects: TimedEffect[];
  /** Recent paid feeds, so the same spot cannot be fed into a permanent feast. */
  feedFatigue: { x: number; y: number; until: number }[];
  /** Tx hash to the creatures that ate its plankton, for the meteor trail. */
  eaters: Record<string, number[]>;
  /** Memorial ring: legendary deaths, newest first. */
  obituaries: Obituary[];
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

/**
 * The whole world is serialized into *one* Durable Object storage value, and a
 * value cannot exceed 2 MB: past it `storage.put` throws `SQLITE_TOOBIG`. That
 * is not a degraded mode, it is a total loss — the put is awaited on the request
 * path, so every save attempt turned into an HTTP 500, and once the world grew
 * past the limit nothing was ever stored again. From then on an eviction could
 * only ever be survived as whatever the last successful save happened to hold,
 * however long ago that was. So every collection below is capped against what
 * its readers actually ask for, and the caps are the reason the snapshot fits
 * rather than an expectation that it will.
 */
/**
 * The platform ceiling itself, named rather than left in prose: every cap in
 * this block is sized against it, the budget below is a fraction of it, and the
 * worker warns against it when a world gets close. Two copies of a limit in two
 * packages is two limits, and only the one that gets read will ever be honoured.
 */
export const DO_VALUE_LIMIT = 2 * 1024 * 1024;

/**
 * What the snapshot is aimed to stay under — three quarters of the ceiling.
 *
 * The quarter held back is not slack for its own sake. It is headroom for the
 * part of a world whose bytes outnumber its characters: creature names are
 * bought by users and the sanitizer caps them by length, not by ASCII, so a
 * single name can cost twice as many bytes as it has characters. Everything the
 * size budgets below count is entries and fields, which is the right unit to
 * budget in — but the thing that trips `SQLITE_TOOBIG` is bytes, and this is
 * where the two are reconciled.
 *
 * Exported, and asserted by the size-budget test, because until now this number
 * lived only inside that test: production was being held to a target it could
 * not read, which is how a world grew past the limit it was written to respect.
 */
export const SNAPSHOT_BUDGET = Math.floor(DO_VALUE_LIMIT * 0.75);

/**
 * How many ticks of history to keep, and how many to drop once that is
 * exceeded. The trim is a hysteresis so the log is not spliced on every single
 * tick, which means the length sawtooths between `CAP - TRIM` and `CAP` — and
 * the *bottom* of that sawtooth is the real guarantee, because it is the
 * shortest the log ever gets while still claiming to serve history. It has to
 * stay at or above the deepest window the server will hand out
 * (`HISTORY_WINDOW_MAX`), or `/history` quietly returns a short chart. Both
 * constants are exported so that relationship is asserted by a test instead of
 * being a number two packages apart that happens to line up.
 */
export const STATS_LOG_CAP = 3200;
export const STATS_LOG_TRIM = 1000;
const EVENT_LOG_CAP = 200;
/**
 * How many transaction hashes' worth of eaters the world remembers. The only
 * reader is the meteor trail, which renders the twelve newest meteors and asks
 * for exactly those hashes — so twelve keys are reachable and every older one
 * is garbage that still has to be stored, serialized, and parsed on each boot.
 * A local world running this same code against the same chain accumulated
 * 156,158 of them: 11.98 MiB of a 13.63 MiB snapshot, or 88% of the world spent
 * on one map whose reader asks for twelve keys, one entry per transaction that
 * had ever rained food since the tank started. The cap sits well above twelve
 * because a hash stays reachable while its plankton is still on the floor
 * waiting to be eaten, which can outlast the meteor's own slot in the rain; 64
 * covers that without being a round number that pretends to be derived.
 */
const EATERS_CAP = 64;
/**
 * Cull records kept. Unlike the two above, no reader bounds this — `/judgments`
 * serves the whole array — so the cap is a judgement call about how much
 * history a list is worth, taken so the snapshot keeps headroom: at ~300 bytes
 * a record, 500 is roughly three weeks of hourly harvests and daily judgments
 * and about 150 KB.
 */
const CULLS_CAP = 500;
/** Below this fraction of max energy a creature hunts plankton by instinct. */
const HUNGER_LINE = 0.55;

/** Keep the last `cap` entries; the ones dropped are the oldest, which is the
 * end of every one of these lists that no reader asks about. */
function keepNewest<T>(list: T[], cap: number): void {
  if (list.length > cap) list.splice(0, list.length - cap);
}

/**
 * Drop the oldest transaction hashes once the map outgrows `EATERS_CAP`.
 * Non-integer string keys keep insertion order in a JS object, so `Object.keys`
 * is already oldest-first and the newest hashes — the only ones a meteor trail
 * can still ask about — are the ones that survive.
 */
function pruneEaters(world: { eaters: Record<string, number[]> }): void {
  const keys = Object.keys(world.eaters);
  if (keys.length <= EATERS_CAP) return;
  for (const k of keys.slice(0, keys.length - EATERS_CAP)) delete world.eaters[k];
}

/**
 * The two trims a loaded snapshot needs, so an oversized one shrinks on the way
 * in. The tick log lands at the bottom of its sawtooth rather than at the cap:
 * a stored log that long is already past the point where the push-side trim
 * would have fired, and bringing it back to the cap one row at a time is the
 * behaviour the hysteresis exists to avoid.
 */
function trimHistory(world: { culls: unknown[]; statsLog: unknown[] }): void {
  keepNewest(world.culls, CULLS_CAP);
  if (world.statsLog.length > STATS_LOG_CAP) keepNewest(world.statsLog, STATS_LOG_CAP - STATS_LOG_TRIM);
}

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

/** Ids of creatures inside a radius, for intervention reports. */
export function idsInZone(world: World, x: number, y: number, radius: number): number[] {
  const out: number[] = [];
  for (const c of world.creatures) {
    const dx = torusDelta(x, c.x, world.config.width);
    const dy = torusDelta(y, c.y, world.config.height);
    if (dx * dx + dy * dy <= radius * radius) out.push(c.id);
  }
  return out;
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
  parentId: number | null = null,
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
    parentId,
    offspring: 0,
    maxMeal: 0,
    maxMealTx: null,
    maxMealUsd: 0,
    boomTouched: false,
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
    const x = world.rng.range(0, cfg.width);
    const y = world.rng.range(0, cfg.height);
    world.creatures.push(makeCreature(world, genome, x, y, world.rng.range(50, 80), 1));
    // Positioned so the tank can show life drifting back into an empty niche
    // instead of creatures simply appearing with no story.
    pushEvent(world, { type: 'reseed', x, y, species: target });
  }
  world.totalBorn += seeded;
  return seeded;
}

/** Below this fraction of max energy the instinct override takes the wheel. */
export function isHungry(world: World, c: Creature): boolean {
  return c.energy < world.config.maxEnergy * HUNGER_LINE;
}

/**
 * The species paying the dominance tax right now, with its share of the tank,
 * or null while no single species crowds past `dominanceShare`. The renderer
 * uses it to fog the monopoly instead of letting the tax run invisibly.
 */
export function dominantTax(world: World): { archetype: Archetype; share: number } | null {
  const cfg = world.config;
  if (cfg.populationFloor <= 0 || world.creatures.length < cfg.populationFloor) return null;
  const counts = archetypeTally(world.creatures);
  const ex = exhaustedNiche(counts, world.creatures.length, cfg.dominanceShare);
  if (!ex) return null;
  return { archetype: ex.archetype, share: counts[ex.archetype] / world.creatures.length };
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
    feedFatigue: [],
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
    eaters: {},
    obituaries: [],
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

function spawnFood(world: World, x: number, y: number, energy?: number, src?: string, srcUsd?: number): void {
  if (world.foods.length >= world.config.maxFood) return;
  world.foods.push({
    id: world.nextFoodId++,
    src,
    x: wrap(x, world.config.width),
    y: wrap(y, world.config.height),
    energy: energy ?? world.config.foodEnergy,
    srcUsd,
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

/**
 * Titles earned by a life, computed at its end: the tank names its dead by
 * what they actually did, not by a rarity table.
 */
function titlesFor(c: Creature, cause: string): string[] {
  const t: string[] = [];
  if (c.kills >= 8) t.push('apex');
  if (cause === 'poison') t.push('poisonGhost');
  if (c.boomTouched && cause === 'starvation') t.push('whalefallSurvivor');
  if (c.offspring >= 4) t.push('lineageBearer');
  return t;
}

function memorialize(world: World, c: Creature, cause: string): void {
  world.obituaries.unshift({
    id: c.id,
    name: displayName(c),
    archetype: c.archetype,
    generation: c.generation,
    bornTick: c.bornTick,
    diedTick: world.tick,
    cause,
    kills: c.kills,
    offspring: c.offspring,
    // Rounded here rather than in every viewer: an obituary is a record to
    // read, and a raw meal energy prints as 26.64610953522815.
    maxMeal: Math.round(c.maxMeal * 10) / 10,
    titles: titlesFor(c, cause),
  });
  if (world.obituaries.length > 24) world.obituaries.length = 24;
  pushEvent(world, {
    type: 'memorial',
    x: Math.round(c.x),
    y: Math.round(c.y),
    name: displayName(c),
    species: c.archetype,
  });
}

/**
 * Shared cull logic for hourly harvests and daily judgment days.
 *
 * An ark ticket is honoured here and nowhere else: the scythe counts the
 * weakest in order and steps over every protected body, taking its quota from
 * the next one down instead. Starvation, poison and predation still kill a
 * ticket holder — the ark only buys immunity from the tank's own two culls,
 * which is what makes it a lifeboat and not immortality.
 */
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
  const doomed = sorted.filter((c) => c.arkProtected !== true).slice(0, cullCount);
  if (doomed.length === 0) return null;
  // Whoever the scythe reached for and could not take: the protected bodies
  // inside the naive window, reported so the tank can flash them surviving.
  const saved = sorted
    .slice(0, cullCount)
    .filter((c) => c.arkProtected === true)
    .map((c) => ({
      id: c.id,
      name: displayName(c),
      x: Math.round(c.x * 10) / 10,
      y: Math.round(c.y * 10) / 10,
    }));
  const doomedIds = new Set(doomed.map((c) => c.id));
  for (const c of doomed) memorialize(world, c, type);
  world.creatures = world.creatures.filter((c) => !doomedIds.has(c.id));
  world.totalDied += doomed.length;
  const record: CullRecord = {
    type,
    tick: world.tick,
    day: Math.floor(world.tick / cfg.ticksPerDay),
    culled: doomed.map((c) => ({
      id: c.id,
      name: displayName(c),
      generation: c.generation,
      energy: Math.round(c.energy * 100) / 100,
      archetype: c.archetype,
      age: world.tick - c.bornTick,
    })),
    saved,
    populationBefore: pop,
    populationAfter: world.creatures.length,
  };
  world.culls.push(record);
  keepNewest(world.culls, CULLS_CAP);
  pushEvent(world, {
    type,
    count: doomed.length,
    positions: doomed.map((c) => ({
      id: c.id,
      x: Math.round(c.x * 10) / 10,
      y: Math.round(c.y * 10) / 10,
    })),
    saved,
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
      spawnFood(world, x + Math.cos(a) * d, y + Math.sin(a) * d, energy, tx.hash, tx.usd);
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
      if (e.kind === 'boom') c.boomTouched = true;
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
      if (nearestFood.energy > c.maxMeal) {
        c.maxMeal = nearestFood.energy;
        c.maxMealTx = nearestFood.src ?? null;
        c.maxMealUsd = nearestFood.srcUsd ?? 0;
      }
      const src = nearestFood.src;
      if (src) {
        // A hash nobody has eaten from yet is the only thing that can grow the
        // map, so that is the only moment worth checking the cap against.
        if (world.eaters[src] === undefined) {
          world.eaters[src] = [];
          pruneEaters(world);
        }
        const list = world.eaters[src];
        if (list.length < 8 && !list.includes(c.id)) list.push(c.id);
      }
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
      c.offspring++;
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
          c.id,
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
        if (gain > c.maxMeal) {
          c.maxMeal = gain;
          c.maxMealTx = null;
          c.maxMealUsd = 0;
        }
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
          predatorName: displayName(c),
          preyName: displayName(p),
        });
        break; // one meal, then it digests
      }
    }
  }
  if (eaten.size > 0) {
    for (const c of world.creatures) if (eaten.has(c.id)) memorialize(world, c, 'predation');
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
          name: displayName(c),
          archetype: c.archetype,
        });
        e.kills = (e.kills ?? 0) + 1;
        if (!e.backlashed && e.kills >= POISON_BACKLASH_KILLS) {
          // A poison that kills its whole neighbourhood answers with a short
          // famine, so a massacre cannot double as a quiet respawn farm.
          e.backlashed = true;
          world.effects.push({
            kind: 'drought', x: 0, y: 0, radius: 0,
            expiresTick: world.tick + 600, damagePerTick: 0,
            payer: e.payer, paid: e.paid,
          });
          pushEvent(world, {
            type: 'intervention', kind: 'backlash',
            x: e.x, y: e.y, radius: e.radius, payer: e.payer, paid: e.paid,
          });
        }
        break;
      }
    }
  }
  for (const c of world.creatures) {
    if (c.energy > 0) continue;
    const inPoison = poisonZones.some((z) => {
      const dx = torusDelta(z.x, c.x, cfg.width);
      const dy = torusDelta(z.y, c.y, cfg.height);
      return dx * dx + dy * dy <= z.radius * z.radius;
    });
    memorialize(world, c, inPoison ? 'poison' : 'starvation');
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
  if (world.statsLog.length > STATS_LOG_CAP) world.statsLog.splice(0, STATS_LOG_TRIM);
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
  /** Wish only: where the meteor came down, so the viewer can rain it in too. */
  at?: { x: number; y: number };
  /** Wish only: the hash the meteor fell under (the burn tx when there is one). */
  hash?: string;
}

/** Find a live creature by id, or null once the tank has moved on without it. */
export function findCreature(world: World, id: number): Creature | null {
  return world.creatures.find((c) => c.id === id) ?? null;
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
/** Overlapping feeds inside this window decay, so paying is not a GM button. */
const FEED_FATIGUE_TICKS = 2400;
const FEED_FATIGUE_RADIUS = 200;
/** Kills inside one poison zone before the tank answers with a short famine. */
const POISON_BACKLASH_KILLS = 10;

export interface InterventionMeta {
  payer?: string;
  paid?: string;
  tx?: string;
}

export function applyIntervention(
  world: World,
  intervention: Intervention,
  meta?: InterventionMeta,
): InterventionResult {
  const cfg = world.config;
  switch (intervention.type) {
    case 'feed': {
      // Same water, second helping: repeated feeds on one spot decay, so a
      // wallet cannot farm a single corner into a permanent feast.
      const fatigue = (world.feedFatigue ??= []).filter((f) => f.until > world.tick);
      world.feedFatigue = fatigue;
      const overlap = fatigue.filter(
        (f) => (f.x - intervention.x) ** 2 + (f.y - intervention.y) ** 2 < FEED_FATIGUE_RADIUS ** 2,
      ).length;
      const amount = Math.max(4, Math.floor((intervention.amount ?? 40) * Math.pow(0.6, overlap)));
      fatigue.push({ x: intervention.x, y: intervention.y, until: world.tick + FEED_FATIGUE_TICKS });
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
        payer: meta?.payer,
        paid: meta?.paid,
      });
      world.lastEvents.push(`intervention:feed@${Math.round(intervention.x)},${Math.round(intervention.y)}`);
      const affected = countInZone(world, intervention.x, intervention.y, 250);
      pushEvent(world, {
        type: 'intervention', kind: 'feed',
        x: intervention.x, y: intervention.y, radius: intervention.radius,
        payer: meta?.payer, paid: meta?.paid, affected,
      });
      return {
        message: `feed: dropped ${amount} food around (${Math.round(intervention.x)}, ${Math.round(intervention.y)})`,
        affected,
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
        payer: meta?.payer,
        paid: meta?.paid,
        kills: 0,
      });
      world.lastEvents.push(`intervention:poison@${Math.round(intervention.x)},${Math.round(intervention.y)}`);
      pushEvent(world, {
        type: 'intervention', kind: 'poison',
        x: intervention.x, y: intervention.y, radius: intervention.radius,
        payer: meta?.payer, paid: meta?.paid,
        affected: countInZone(world, intervention.x, intervention.y, intervention.radius),
      });
      return {
        message: `poison: radius ${intervention.radius} at (${Math.round(intervention.x)}, ${Math.round(intervention.y)}) for ${duration} ticks`,
        affected: countInZone(world, intervention.x, intervention.y, intervention.radius),
      };
    }
    case 'bloom': {
      const duration = intervention.durationTicks ?? 2400;
      // Bloom and drought are opposite weathers: buying one ends the other.
      world.effects = world.effects.filter((e) => e.kind !== 'drought');
      world.effects.push({
        kind: 'bloom', x: 0, y: 0, radius: 0, expiresTick: world.tick + duration,
        damagePerTick: 0, payer: meta?.payer, paid: meta?.paid,
      });
      world.lastEvents.push('intervention:bloom');
      pushEvent(world, { type: 'intervention', kind: 'bloom' });
      return {
        message: `bloom: food spawn x2 for ${duration} ticks`,
        affected: world.creatures.length,
      };
    }
    case 'drought': {
      const duration = intervention.durationTicks ?? 2400;
      world.effects = world.effects.filter((e) => e.kind !== 'bloom');
      world.effects.push({
        kind: 'drought', x: 0, y: 0, radius: 0, expiresTick: world.tick + duration,
        damagePerTick: 0, payer: meta?.payer, paid: meta?.paid,
      });
      world.lastEvents.push('intervention:drought');
      pushEvent(world, { type: 'intervention', kind: 'drought' });
      return {
        message: `drought: food spawn halted for ${duration} ticks`,
        affected: world.creatures.length,
      };
    }
    case 'name': {
      const c = findCreature(world, intervention.creatureId);
      // The handler re-checks the target after the payment clears, so this is
      // a guard, not a path a buyer can be charged for.
      if (!c) return { message: `name: creature #${intervention.creatureId} is gone`, affected: 0 };
      const before = displayName(c);
      c.customName = intervention.name;
      world.lastEvents.push(`intervention:name:${c.id}`);
      pushEvent(world, {
        type: 'naming',
        x: Math.round(c.x * 10) / 10,
        y: Math.round(c.y * 10) / 10,
        creatureId: c.id,
        name: before,
        message: intervention.name,
        payer: meta?.payer,
        paid: meta?.paid,
      });
      return { message: `Named ${before} → “${intervention.name}”`, affected: 1 };
    }
    case 'wish': {
      // A wish is a small meteor with words on it: it falls where the payer
      // aimed (or somewhere the tank picks), and always leaves a handful of
      // plankton under the message, so it feeds the water around it instead of
      // only decorating it. The pellet energy still tracks the meteor's size —
      // a wish is a light fall, not a whale-sized one.
      const size = WISH_METEOR_SIZE;
      const aimed =
        intervention.x !== undefined && intervention.y !== undefined
          ? { x: intervention.x, y: intervention.y }
          : { x: world.rng.range(0, cfg.width), y: world.rng.range(0, cfg.height) };
      const x = wrap(aimed.x, cfg.width);
      const y = wrap(aimed.y, cfg.height);
      // Deterministic fallback: a tick+seq key replays identically on every
      // instance, where a wall-clock one would not.
      const hash = meta?.tx ?? `wish-${world.tick}-${world.nextEventSeq}`;
      const count = WISH_PELLETS;
      const energy = cfg.foodEnergy * (0.25 + size);
      for (let i = 0; i < count; i++) {
        const a = world.rng.range(0, Math.PI * 2);
        const d = Math.sqrt(world.rng.next()) * WISH_SPREAD;
        spawnFood(world, x + Math.cos(a) * d, y + Math.sin(a) * d, energy, hash);
      }
      world.lastEvents.push(`intervention:wish@${Math.round(x)},${Math.round(y)}`);
      pushEvent(world, {
        type: 'wish',
        x: Math.round(x * 10) / 10,
        y: Math.round(y * 10) / 10,
        size,
        hash,
        message: intervention.message,
        payer: meta?.payer,
        paid: meta?.paid,
      });
      const affected = countInZone(world, x, y, 60);
      return {
        message: `wish: “${intervention.message}” fell at (${Math.round(x)}, ${Math.round(y)})`,
        affected,
        at: { x, y },
        hash,
      };
    }
    case 'mutate': {
      const c = findCreature(world, intervention.creatureId);
      if (!c) return { message: `mutate: creature #${intervention.creatureId} is gone`, affected: 0 };
      mutateTrait(c.genome, intervention.trait, intervention.direction);
      // The species is read off the output drives, and four of the five edits
      // move one of them: aggression and fertility push the eat and reproduce
      // biases harder than size does, and speed pushes the move bias. So the
      // body follows the gene after *any* edit, not just the size one —
      // otherwise the card, the metabolism and the creature's own children
      // (who are born off the genome, not off the parent's label) would each
      // hold a different answer to what this animal is. Kill growth carries
      // across as a ratio, and a creature with no paid name takes the codename
      // of the species it became.
      const was = c.archetype;
      const next = archetypeOf(c.genome);
      if (next !== was) {
        const grown = c.radius / (cfg.creatureRadius * ARCHETYPES[was].radiusMult);
        c.archetype = next;
        c.radius = cfg.creatureRadius * ARCHETYPES[next].radiusMult * grown;
        if (!c.customName) c.name = creatureName(next, c.id);
      }
      world.lastEvents.push(`intervention:mutate:${c.id}:${intervention.trait}`);
      pushEvent(world, {
        type: 'mutation',
        x: Math.round(c.x * 10) / 10,
        y: Math.round(c.y * 10) / 10,
        creatureId: c.id,
        name: displayName(c),
        trait: intervention.trait,
        direction: intervention.direction,
        // Set only when the edit actually rewrote the species, so the tank can
        // say so out loud instead of leaving the viewer to notice a body that
        // quietly changed shape. Sparse: most edits leave the species alone.
        ...(next !== was ? { archetype: next } : {}),
        payer: meta?.payer,
        paid: meta?.paid,
      });
      return {
        message: `Modified ${displayName(c)}: ${intervention.trait} ${intervention.direction}`,
        affected: 1,
      };
    }
    case 'ark': {
      const c = findCreature(world, intervention.creatureId);
      if (!c) return { message: `ark: creature #${intervention.creatureId} is gone`, affected: 0 };
      if (c.arkProtected === true) {
        return { message: `ark: ${displayName(c)} already holds a ticket`, affected: 0 };
      }
      c.arkProtected = true;
      c.arkBy = meta?.payer;
      world.lastEvents.push(`intervention:ark:${c.id}`);
      pushEvent(world, {
        type: 'ark',
        x: Math.round(c.x * 10) / 10,
        y: Math.round(c.y * 10) / 10,
        creatureId: c.id,
        name: displayName(c),
        payer: meta?.payer,
        paid: meta?.paid,
      });
      return { message: `Ark granted to ${displayName(c)}`, affected: 1 };
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
  rest.eaters ??= {};
  rest.obituaries ??= [];
  rest.culls ??= [];
  rest.statsLog ??= [];
  // Snapshots written before these were capped arrive oversized, and the value
  // they came out of is the value that has to go back in — so trim on load
  // instead of leaving the next save to fail on a size this boot could have
  // fixed. The maps and arrays are already normalized above, which is what
  // makes the two trims safe to call unconditionally.
  pruneEaters(rest);
  trimHistory(rest);
  for (const c of rest.creatures ?? []) {
    c.offspring ??= 0;
    c.maxMeal ??= 0;
    c.maxMealTx ??= null;
    c.maxMealUsd ??= 0;
    c.boomTouched ??= false;
    c.kills ??= 0;
    c.devouredTotal ??= 0;
    // Snapshots written before digestion existed carry no cooldown; resuming
    // them hungry lets every predator take a free kill on the same tick, which
    // wipes the prey layer each restart. Load them as freshly fed instead.
    c.huntReadyAt ??= rest.tick + (rest.config?.huntCooldown ?? DEFAULT_CONFIG.huntCooldown);
    c.name ??= creatureName(c.archetype, c.id);
    c.parentId ??= null;
    // Paid identity: absent means unnamed and mortal. Normalized to undefined
    // rather than false so an old snapshot does not start carrying a field per
    // creature forever, and a stray null cannot read as a bought ticket.
    if (typeof c.customName !== 'string' || c.customName.length === 0) c.customName = undefined;
    if (c.arkProtected !== true) {
      c.arkProtected = undefined;
      c.arkBy = undefined;
    }
  }
  for (const cull of rest.culls ?? []) {
    cull.saved ??= [];
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
