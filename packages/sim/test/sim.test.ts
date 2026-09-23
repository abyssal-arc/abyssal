import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createWorld,
  tick,
  applyIntervention,
  effectiveSpawnRate,
  idsInZone,
  txLanding,
  creatureName,
  toJSON,
  fromJSON,
  STATS_LOG_CAP,
  STATS_LOG_TRIM,
  DEFAULT_CONFIG,
  ARCHETYPES,
  archetypeOf,
  dominantTax,
  isHungry,
  steerArchetype,
  personaOf,
  randomGenome,
  mutateTrait,
  GENE_TRAITS,
  displayName,
  isLegendary,
  findCreature,
  WISH_METEOR_SIZE,
  WISH_PELLETS,
  LEGENDARY_GENERATION,
  LEGENDARY_KILLS,
  type Senses,
  type WorldConfig,
  type Archetype,
  type Creature,
  type CullRecord,
  type Genome,
} from '../src/index.js';
import { Rng } from '../src/prng.js';

/** Deterministic pseudo-varying chain temperature, no RNG involved. */
function sensesAt(i: number, market = 0.5): Senses {
  return { chain: 0.5 + 0.4 * Math.sin(i / 7), market };
}

function runTicks(world: ReturnType<typeof createWorld>, n: number, market = 0.5): void {
  for (let i = 0; i < n; i++) tick(world, sensesAt(i, market));
}

const NO_FOOD: Partial<WorldConfig> = { initialFood: 0, baseSpawnRate: 0 };

/**
 * Isolated-pair scenarios must not spawn newborns that get eaten mid-test, and
 * must not recolonize: a sliced-down tank sits below the population floor, and
 * the floor seeds immigrants from the emptiest niche.
 */
const NO_FOOD_NO_BIRTH: WorldConfig = {
  ...DEFAULT_CONFIG,
  ...NO_FOOD,
  reproduceUrgeThreshold: 2,
  populationFloor: 0,
};

test('determinism: same seed + same inputs => identical state', () => {
  const a = createWorld(42);
  const b = createWorld(42);
  runTicks(a, 120);
  runTicks(b, 120);
  assert.equal(toJSON(a), toJSON(b));
});

test('determinism: different seeds diverge', () => {
  const a = createWorld(1);
  const b = createWorld(2);
  runTicks(a, 50);
  runTicks(b, 50);
  assert.notEqual(toJSON(a), toJSON(b));
});

test('serialization round-trip preserves future evolution', () => {
  const a = createWorld(7);
  runTicks(a, 60);
  const b = fromJSON(toJSON(a));
  runTicks(a, 60);
  runTicks(b, 60);
  assert.equal(toJSON(a), toJSON(b));
});

test('judgment day culls the weakest 10% (min 1) and records type=judgment', () => {
  const config: WorldConfig = {
    ...DEFAULT_CONFIG,
    initialPopulation: 20,
    populationFloor: 5,
    judgmentInterval: 10,
    judgmentCullRatio: 0.1,
  };
  const world = createWorld(99, config);
  runTicks(world, 10);
  assert.equal(world.culls.length, 1);
  const record = world.culls[0];
  assert.equal(record.type, 'judgment');
  assert.equal(record.culled.length, Math.max(1, Math.floor(record.populationBefore * 0.1)));
  assert.equal(record.populationAfter, record.populationBefore - record.culled.length);
  // Culled creatures must be the lowest-energy ones, ascending.
  for (let i = 1; i < record.culled.length; i++) {
    assert.ok(record.culled[i - 1].energy <= record.culled[i].energy);
  }
  const minSurvivor = Math.min(...world.creatures.map((c) => c.energy));
  const maxCulled = Math.max(...record.culled.map((c) => c.energy));
  assert.ok(maxCulled <= minSurvivor);
  // Obituary fields: archetype and age are recorded for every victim.
  for (const victim of record.culled) {
    assert.ok(['APE', 'WHALE', 'ALGO', 'INSIDER'].includes(victim.archetype));
    assert.ok(victim.age >= 0);
  }
});

test('hourly harvest culls 2% (rounded down, may be zero) and records type=harvest', () => {
  const config: WorldConfig = {
    ...DEFAULT_CONFIG,
    initialPopulation: 100,
    populationFloor: 5,
    harvestInterval: 10,
    harvestCullRatio: 0.02,
    judgmentInterval: 10_000, // keep judgment out of the way
  };
  const world = createWorld(1234, config);
  runTicks(world, 10);
  assert.equal(world.culls.length, 1);
  const record = world.culls[0];
  assert.equal(record.type, 'harvest');
  assert.equal(record.culled.length, Math.floor(record.populationBefore * 0.02));
  assert.ok(record.culled.length >= 1);
  assert.equal(record.populationAfter, record.populationBefore - record.culled.length);

  // A small population rounds the 2% down to zero -> no cull at all.
  const small = createWorld(1234, { ...config, initialPopulation: 20 });
  runTicks(small, 10);
  assert.equal(small.culls.length, 0);
});

test('culls are skipped at or below the population floor', () => {
  const config: WorldConfig = {
    ...DEFAULT_CONFIG,
    initialPopulation: 20,
    populationFloor: 20,
    judgmentInterval: 10,
    harvestInterval: 5,
    reproduceUrgeThreshold: 2, // disable births so population can never exceed the floor
  };
  const world = createWorld(5, config);
  runTicks(world, 30);
  assert.equal(world.culls.length, 0);
});

test('market temperature excites creatures: faster movement, higher metabolism', () => {
  const calm = createWorld(55, { ...DEFAULT_CONFIG, ...NO_FOOD });
  const wild = createWorld(55, { ...DEFAULT_CONFIG, ...NO_FOOD });
  for (let i = 0; i < 50; i++) {
    tick(calm, { chain: 0.5, market: 0 });
    tick(wild, { chain: 0.5, market: 1 });
  }
  // Same seed and same chain temp, but the market channel must change behavior.
  assert.notEqual(
    calm.creatures.map((c) => `${c.x},${c.y}`).join('|'),
    wild.creatures.map((c) => `${c.x},${c.y}`).join('|'),
  );
  // No food exists, so the hotter market strictly burns more energy. Compare
  // the tank's total, not its mean: predation and starvation cull a different
  // handful on each side, and that survivorship skew dwarfs the burn gap.
  const total = (w: typeof calm): number => w.creatures.reduce((s, c) => s + c.energy, 0);
  assert.ok(
    total(wild) < total(calm),
    `market=1 total energy ${total(wild)} should be < market=0 ${total(calm)}`,
  );
});

test('predation: a WHALE eats a much smaller non-WHALE on contact and takes 50% energy', () => {
  const world = createWorld(77, NO_FOOD_NO_BIRTH);
  // Isolate the pair so no third creature can interfere.
  world.creatures = world.creatures.slice(0, 2);
  const whale = world.creatures[0];
  const prey = world.creatures[1];
  whale.archetype = 'WHALE';
  whale.radius = 8.8;
  whale.energy = 100;
  prey.archetype = 'INSIDER';
  prey.radius = 4;
  prey.energy = 60;
  whale.x = 500; whale.y = 500;
  prey.x = 505; prey.y = 500; // within contact reach 8.8 + 4
  const stats = tick(world, { chain: 0, market: 0 });
  assert.ok(!world.creatures.some((c) => c.id === prey.id), 'prey should be eaten');
  const survivor = world.creatures.find((c) => c.id === whale.id);
  assert.ok(survivor, 'whale should survive');
  assert.ok(
    survivor.energy > 100 - 1, // own metabolism is tiny compared to the 30-energy meal
    `whale energy ${survivor.energy} should reflect the +30 predation gain`,
  );
  assert.ok(stats.events.some((e) => e.startsWith('predation:')));
  assert.equal(world.totalPredations, 1);
});

test('predation: non-WHALE creatures cannot eat each other', () => {
  const world = createWorld(78, NO_FOOD_NO_BIRTH);
  world.creatures = world.creatures.slice(0, 2);
  const a = world.creatures[0];
  const b = world.creatures[1];
  a.archetype = 'ALGO';
  a.radius = 3.2;
  a.energy = 120;
  b.archetype = 'INSIDER';
  b.radius = 4;
  b.energy = 120;
  a.x = 500; a.y = 500;
  b.x = 501; b.y = 500;
  tick(world, { chain: 0, market: 0 });
  assert.ok(world.creatures.some((c) => c.id === a.id));
  assert.ok(world.creatures.some((c) => c.id === b.id));
  assert.equal(world.totalPredations, 0);
});

test('predation: a WHALE ignores prey that is not small enough', () => {
  const world = createWorld(79, NO_FOOD_NO_BIRTH);
  world.creatures = world.creatures.slice(0, 2);
  const whale = world.creatures[0];
  const big = world.creatures[1];
  whale.archetype = 'WHALE';
  whale.radius = 8.8;
  whale.energy = 120;
  // 6 > 8.8 * 0.6 = 5.28, so this creature is too large to be prey.
  big.archetype = 'INSIDER';
  big.radius = 6;
  big.energy = 120;
  whale.x = 500; whale.y = 500;
  big.x = 505; big.y = 500;
  tick(world, { chain: 0, market: 0 });
  assert.ok(world.creatures.some((c) => c.id === big.id));
  assert.equal(world.totalPredations, 0);
});

test('predation grows the whale 4% per kill (capped at 1.5x base) and tracks devoured energy', () => {
  // huntCooldown off: this test feeds the same whale twice in a row on purpose.
  const world = createWorld(88, { ...NO_FOOD_NO_BIRTH, huntCooldown: 0 });
  world.creatures = world.creatures.slice(0, 2);
  const whale = world.creatures[0];
  const prey = world.creatures[1];
  whale.archetype = 'WHALE';
  whale.radius = 8.8;
  whale.energy = 100;
  prey.archetype = 'INSIDER';
  prey.radius = 4;
  prey.energy = 60;
  whale.x = 500; whale.y = 500;
  prey.x = 505; prey.y = 500;
  const baseRadius = 8.8;
  tick(world, { chain: 0, market: 0 });
  const grown = world.creatures.find((c) => c.id === whale.id);
  assert.ok(grown);
  assert.ok(
    Math.abs(grown.radius - baseRadius * 1.04) < 1e-9,
    `radius should grow 4%: ${grown.radius}`,
  );
  assert.equal(grown.kills, 1);
  // The prey pays one tick of metabolism before being eaten, hence the epsilon.
  assert.ok(Math.abs(grown.devouredTotal - 30) < 0.5, `devouredTotal=${grown.devouredTotal}`);

  // Cap: a whale already at 1.5x base cannot grow further.
  grown.radius = baseRadius * 1.5;
  grown.energy = 150;
  const prey2 = { ...prey, id: 9999, energy: 60, x: grown.x + 5, y: grown.y };
  world.creatures.push(prey2);
  tick(world, { chain: 0, market: 0 });
  assert.equal(grown.radius, baseRadius * 1.5, 'radius cap holds');
  // prey2 paid one tick of metabolism before being eaten, hence the epsilon.
  assert.ok(Math.abs(grown.devouredTotal - 60) < 0.5, `devouredTotal=${grown.devouredTotal}`);
});

test('feed intervention drops food inside the target area and creates a feast attractor', () => {
  const world = createWorld(11);
  const before = world.foods.length;
  const receipt = applyIntervention(world, { type: 'feed', x: 500, y: 500, radius: 80, amount: 25 });
  assert.match(receipt.message, /^feed:/);
  assert.equal(receipt.amount, 25);
  assert.ok(receipt.affected >= 0);
  assert.equal(world.foods.length, before + 25);
  assert.ok(world.effects.some((e) => e.kind === 'feast'), 'feed should leave a feast attractor');
  for (const f of world.foods.slice(before)) {
    // Toroidal placement: raw offsets must lie within the radius.
    assert.ok(Math.abs(f.x - 500) <= 80 + 1e-9);
    assert.ok(Math.abs(f.y - 500) <= 80 + 1e-9);
  }
});

test('poison drains energy of creatures inside the radius', () => {
  const a = createWorld(21);
  const b = fromJSON(toJSON(a));
  // Freeze one creature at a known spot in both copies.
  a.creatures[0].x = 100; a.creatures[0].y = 100; a.creatures[0].energy = 120;
  b.creatures[0].x = 100; b.creatures[0].y = 100; b.creatures[0].energy = 120;
  applyIntervention(b, { type: 'poison', x: 100, y: 100, radius: 60, durationTicks: 50 });
  tick(a, { chain: 0, market: 0 });
  tick(b, { chain: 0, market: 0 });
  assert.ok(
    b.creatures[0].energy < a.creatures[0].energy,
    `poisoned ${b.creatures[0].energy} should be < control ${a.creatures[0].energy}`,
  );
});

test('drought stops food spawning, bloom doubles it', () => {
  const mk = () => {
    const w = createWorld(31, { ...DEFAULT_CONFIG, initialFood: 0 });
    w.foods.length = 0;
    return w;
  };
  const control = mk();
  const drought = mk();
  const bloom = mk();
  applyIntervention(drought, { type: 'drought', durationTicks: 100 });
  applyIntervention(bloom, { type: 'bloom', durationTicks: 100 });
  assert.equal(effectiveSpawnRate(drought, 1), 0);
  for (let i = 0; i < 10; i++) {
    tick(control, { chain: 1, market: 0.5 });
    tick(drought, { chain: 1, market: 0.5 });
    tick(bloom, { chain: 1, market: 0.5 });
  }
  assert.equal(drought.foods.length, 0);
  assert.ok(control.foods.length > 0, 'control should accumulate food at chain=1');
  assert.ok(
    bloom.foods.length > control.foods.length,
    `bloom ${bloom.foods.length} should exceed control ${control.foods.length}`,
  );
});

test('energy conservation: creature energy never exceeds initial + food energy input', () => {
  const world = createWorld(77);
  const initialCreatureEnergy = world.creatures.reduce((s, c) => s + c.energy, 0);
  runTicks(world, 300);
  const creatureEnergy = world.creatures.reduce((s, c) => s + c.energy, 0);
  const energyBudget = initialCreatureEnergy + world.totalFoodSpawned * world.config.foodEnergy;
  assert.ok(
    creatureEnergy <= energyBudget + 1e-6,
    `creature energy ${creatureEnergy} exceeds budget ${energyBudget}`,
  );
  // Every creature is individually capped.
  for (const c of world.creatures) {
    assert.ok(c.energy <= world.config.maxEnergy + 1e-9);
  }
});

test('population stays within configured bounds and world keeps ticking', () => {
  const world = createWorld(3);
  runTicks(world, 500);
  assert.ok(world.creatures.length <= world.config.maxPopulation);
  assert.ok(world.creatures.length > 0, 'population should survive with abundant food');
  assert.equal(world.statsLog.at(-1)?.tick, 500);
});

test('tx meteors: landing site is hash-derived and deterministic, food appears there', () => {
  const hash = '0xabcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789';
  const a = createWorld(101, { ...DEFAULT_CONFIG, ...NO_FOOD });
  const b = createWorld(202, { ...DEFAULT_CONFIG, ...NO_FOOD });
  tick(a, { chain: 0.5, market: 0 }, [{ hash, size: 0.8 }]);
  tick(b, { chain: 0.5, market: 0 }, [{ hash, size: 0.8 }]);
  // Different seeds, same hash => same landing coordinates.
  const la = txLanding(hash, 1000, 1000);
  const torusDist = (ax: number, ay: number, bx: number, by: number) => {
    const dx = Math.min(Math.abs(ax - bx), 1000 - Math.abs(ax - bx));
    const dy = Math.min(Math.abs(ay - by), 1000 - Math.abs(ay - by));
    return Math.hypot(dx, dy);
  };
  for (const w of [a, b]) {
    assert.ok(w.foods.length > 0, 'meteor should drop food');
    for (const f of w.foods) {
      assert.ok(
        torusDist(f.x, f.y, la.x, la.y) <= 36,
        `food at (${f.x.toFixed(0)},${f.y.toFixed(0)}) should land near (${la.x},${la.y})`,
      );
    }
    const ev = w.eventLog.find((e) => e.type === 'tx_meteor');
    assert.equal(ev?.hash, hash);
    assert.equal(ev?.x, la.x);
    assert.equal(ev?.y, la.y);
  }
});

test('tx meteors: an explicit landing site overrides the hash-derived one', () => {
  const hash = '0xabcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789';
  const w = createWorld(303, { ...DEFAULT_CONFIG, ...NO_FOOD });
  // A chain whale's own transfer is told where to fall: at the whale.
  tick(w, { chain: 0.5, market: 0 }, [{ hash, size: 0.8, at: { x: 200, y: 700 } }]);
  const la = txLanding(hash, 1000, 1000);
  assert.notDeepEqual({ x: 200, y: 700 }, la, 'test needs a site the hash would not pick');
  const ev = w.eventLog.find((e) => e.type === 'tx_meteor');
  assert.equal(ev?.x, 200);
  assert.equal(ev?.y, 700);
  assert.ok(w.foods.length > 0, 'meteor should drop food');
  for (const f of w.foods) {
    assert.ok(
      Math.hypot(f.x - 200, f.y - 700) <= 36,
      `food at (${f.x.toFixed(0)},${f.y.toFixed(0)}) should land at the whale, not at the hash site`,
    );
  }
});

test('tx meteors: dust makes a streak but no food, big money is a feast', () => {
  const dust = createWorld(404, { ...DEFAULT_CONFIG, ...NO_FOOD });
  for (let i = 0; i < 40; i++) {
    tick(dust, { chain: 0.5, market: 0 }, [{ hash: `0x${i}000`, size: 0.01 }]);
  }
  assert.equal(dust.foods.length, 0, 'a $0.0001 transfer must not feed the tank');
  assert.equal(
    dust.eventLog.filter((e) => e.type === 'tx_meteor').length,
    40,
    'every real transfer is still visible as a meteor',
  );

  const whale = createWorld(404, { ...DEFAULT_CONFIG, ...NO_FOOD });
  tick(whale, { chain: 0.5, market: 0 }, [{ hash: '0xbeef0000', size: 1 }]);
  assert.ok(whale.foods.length >= 3, 'a $100k transfer should be a feast');
  assert.ok(whale.foods.every((f) => f.energy > 30), 'whale money is richer than baseline plankton');
});

test('poison zone repels creatures visibly and marks deaths as poison_kill', () => {
  const world = createWorld(103, NO_FOOD_NO_BIRTH);
  world.creatures = world.creatures.slice(0, 1);
  const c = world.creatures[0];
  c.x = 500; c.y = 500;
  c.energy = 8; // dies within a few ticks at poison drain
  applyIntervention(world, { type: 'poison', x: 500, y: 500, radius: 100, durationTicks: 100 });
  for (let i = 0; i < 8 && world.creatures.length > 0; i++) {
    tick(world, { chain: 0, market: 0 });
  }
  assert.equal(world.creatures.length, 0, 'creature should die quickly inside the zone');
  assert.ok(
    world.eventLog.some((e) => e.type === 'poison_kill'),
    'death inside the poison zone should be a poison_kill event',
  );
  // Repulsion: an identical high-energy creature flees outward.
  const fled = createWorld(103, NO_FOOD_NO_BIRTH);
  fled.creatures = fled.creatures.slice(0, 1);
  fled.creatures[0].x = 500; fled.creatures[0].y = 500;
  fled.creatures[0].energy = 200;
  applyIntervention(fled, { type: 'poison', x: 500, y: 500, radius: 100, durationTicks: 100 });
  for (let i = 0; i < 5; i++) tick(fled, { chain: 0, market: 0 });
  const surv = fled.creatures[0];
  const dist = Math.hypot(surv.x - 500, surv.y - 500);
  assert.ok(dist > 10, `creature should have fled outward, dist=${dist.toFixed(1)}`);
});

test('feast attractor pulls distant creatures toward the drop zone', () => {
  const world = createWorld(104, NO_FOOD_NO_BIRTH);
  world.creatures = world.creatures.slice(0, 1);
  const c = world.creatures[0];
  c.x = 200; c.y = 200;
  c.energy = 150;
  world.effects.push({
    kind: 'feast', x: 700, y: 700, radius: 250, expiresTick: 400, damagePerTick: 0,
  });
  const before = Math.hypot(700 - c.x, 700 - c.y);
  for (let i = 0; i < 10; i++) tick(world, { chain: 0, market: 0 });
  const after = Math.hypot(700 - c.x, 700 - c.y);
  assert.ok(after < before, `creature should be pulled closer (${before} -> ${after})`);
});

test('whale boom: pulls in creatures that could see it land, and nobody else', () => {
  const WHALE_TX = [{ hash: '0xwhale0000', size: 0.9, at: { x: 200, y: 700 } }];

  // Inside the radius: even a well-fed creature stops wandering and marches to
  // the money, which is the visible half of "the whale moved, the tank reacted".
  const near = createWorld(505, NO_FOOD_NO_BIRTH);
  near.creatures = near.creatures.slice(0, 1);
  const n = near.creatures[0];
  n.x = 300; n.y = 700; n.energy = 150;
  tick(near, { chain: 0, market: 0 }, WHALE_TX);
  const boom = near.effects.find((e) => e.kind === 'boom');
  assert.ok(boom, 'a whale transfer that fed the tank should leave a boom behind');
  assert.equal(boom!.x, 200);
  assert.equal(boom!.y, 700);
  const before = Math.abs(n.x - 200);
  for (let i = 0; i < 30; i++) tick(near, { chain: 0, market: 0 });
  const after = Math.hypot(n.x - 200, n.y - 700);
  assert.ok(after < 12, `the creature should arrive at the whale's money (${before.toFixed(0)} -> ${after.toFixed(1)})`);

  // A hungry creature that gets there actually eats: hunger outranks the pull
  // toward the exact impact point, so the money it swarmed to goes into it.
  const pod = createWorld(505, NO_FOOD_NO_BIRTH);
  pod.creatures = pod.creatures.slice(0, 1);
  const h = pod.creatures[0];
  h.x = 260; h.y = 700; h.energy = 90; // below the hunger line (0.55 * 200)
  tick(pod, { chain: 0, market: 0 }, WHALE_TX);
  const dropped = pod.foods.length;
  assert.ok(dropped > 0, 'the whale transfer should have dropped plankton');
  for (let i = 0; i < 60; i++) tick(pod, { chain: 0, market: 0 });
  assert.ok(pod.foods.length < dropped, 'the swarm should consume the boom it was pulled to');

  // Outside the radius: bit-identical to the same world with no boom at all, so
  // a chain that sees a whale transfer every few seconds never yanks the whole
  // tank around. The whole-map swarm stays the paid feed's signature.
  const far = createWorld(505, NO_FOOD_NO_BIRTH);
  const quiet = createWorld(505, NO_FOOD_NO_BIRTH);
  for (const w of [far, quiet]) {
    w.creatures = w.creatures.slice(0, 1);
    const c = w.creatures[0];
    c.x = 900; c.y = 100; c.energy = 150;
  }
  tick(far, { chain: 0, market: 0 }, WHALE_TX);
  tick(quiet, { chain: 0, market: 0 }, WHALE_TX);
  quiet.effects = quiet.effects.filter((e) => e.kind !== 'boom');
  for (let i = 0; i < 20; i++) {
    tick(far, { chain: 0, market: 0 });
    tick(quiet, { chain: 0, market: 0 });
  }
  assert.equal(far.creatures[0].x, quiet.creatures[0].x, 'a distant creature must not feel the boom');
  assert.equal(far.creatures[0].y, quiet.creatures[0].y);

  // Dust from the same address is still just a streak: no plankton, no boom.
  const dust = createWorld(505, NO_FOOD_NO_BIRTH);
  tick(dust, { chain: 0, market: 0 }, [{ hash: '0xdust0000', size: 0.01, at: { x: 200, y: 700 } }]);
  assert.equal(dust.effects.filter((e) => e.kind === 'boom').length, 0);
  assert.equal(dust.foods.length, 0);

  // Small change feeds the water without becoming an event: the boom is gated
  // on a size that guarantees a pellet, not on the pellet roll, so a chain that
  // streams $50 transfers from one whale does not yank the tank twice a second.
  const small = createWorld(505, NO_FOOD_NO_BIRTH);
  for (let i = 0; i < 12; i++) {
    tick(small, { chain: 0, market: 0 }, [{ hash: `0xsmall${i}`, size: 0.5, at: { x: 200, y: 700 } }]);
  }
  assert.equal(small.effects.filter((e) => e.kind === 'boom').length, 0, 'sub-threshold money must not boom');
  assert.ok(small.foods.length > 0, 'but it still feeds the patch it landed on');
});

test('creature names are deterministic codenames from archetype + id', () => {
  assert.equal(creatureName('WHALE', 42), 'LEVIATHAN-042'); // 42 % 5 = 2
  assert.equal(creatureName('WHALE', 42), creatureName('WHALE', 42));
  assert.notEqual(creatureName('ALGO', 42), creatureName('WHALE', 42));
  const a = createWorld(105);
  const b = createWorld(105);
  assert.deepEqual(
    a.creatures.map((c) => c.name),
    b.creatures.map((c) => c.name),
  );
  for (const c of a.creatures) assert.match(c.name, /^[A-Z]+-\d{3}$/);
});

test('archetype: flat drives read as INSIDER, each dominant drive as its niche', () => {
  const rng = new Rng(7);
  for (const target of ['APE', 'WHALE', 'ALGO', 'INSIDER'] as Archetype[]) {
    const g = randomGenome(rng);
    steerArchetype(g, target);
    assert.equal(archetypeOf(g), target, `steered genome must read as ${target}`);
  }
  const flat = randomGenome(rng);
  flat.w2 = flat.w2.map(() => 0);
  flat.b2 = flat.b2.map(() => 0);
  assert.equal(archetypeOf(flat), 'INSIDER', 'a drive-less genome is an INSIDER');
});

test('niche saturation: offspring of an over-crowded species radiate into the emptiest niche', () => {
  const cfg: WorldConfig = {
    ...DEFAULT_CONFIG,
    initialPopulation: 40,
    initialFood: 500,
    maxFood: 900,
    reproduceThreshold: 10,
    reproduceUrgeThreshold: -1,
  };
  const world = createWorld(909, cfg);
  // A tank that evolution already collapsed into a single species.
  for (const c of world.creatures) {
    c.archetype = 'WHALE';
    steerArchetype(c.genome, 'APE'); // fertile: births actually happen
    c.energy = cfg.maxEnergy;
  }
  const before = world.creatures.length;
  for (let i = 0; i < 5; i++) tick(world, { chain: 0.9, market: 0.5 });
  const newborns = world.creatures.filter((c) => c.bornTick > 0);
  assert.ok(newborns.length > 0, 'fertile saturated population must breed');
  assert.ok(
    newborns.every((c) => c.archetype !== 'WHALE'),
    'no newborn may clone the saturated species',
  );
  assert.ok(world.creatures.length > before);
});

test('biodiversity: a long run keeps several species on the board', () => {
  const world = createWorld(4242);
  for (let i = 0; i < 1500; i++) tick(world, sensesAt(i));
  const present = new Set(world.creatures.map((c) => c.archetype));
  assert.ok(present.size >= 3, `expected a mixed reserve, got ${[...present].join(',')}`);
  assert.ok(world.creatures.length >= 20, 'population must stay alive');
});

test('population floor: a famine that wipes out the stock reseeds instead of going extinct', () => {
  const cfg: WorldConfig = {
    ...DEFAULT_CONFIG,
    initialPopulation: 40,
    populationFloor: 12,
    reproduceUrgeThreshold: 2, // no births: only the floor can bring life back
    ...NO_FOOD,
  };
  const world = createWorld(31337, cfg);
  for (let i = 0; i < 400; i++) tick(world, { chain: 0.2, market: 0.5 });
  assert.ok(world.totalDied > 0, 'the famine must have killed the original stock');
  assert.ok(world.creatures.length > 0, 'the tank must never stay an empty glass box');
  const present = new Set(world.creatures.map((c) => c.archetype));
  assert.ok(present.size >= 2, `reseeded life arrives in the emptiest niches, got ${[...present]}`);
});

test('monopoly: a single-species tank pays for its exhausted niche and regrows the missing ones', () => {
  const cfg: WorldConfig = {
    ...DEFAULT_CONFIG,
    initialPopulation: 60,
    reproduceUrgeThreshold: 2, // no births: only recolonization can diversify
  };
  const world = createWorld(777, cfg);
  for (const c of world.creatures) {
    c.archetype = 'WHALE';
    steerArchetype(c.genome, 'WHALE');
  }
  const tally = (): Record<string, number> =>
    world.creatures.reduce<Record<string, number>>(
      (m, c) => ((m[c.archetype] = (m[c.archetype] ?? 0) + 1), m),
      {},
    );
  assert.equal(Object.keys(tally()).length, 1, 'the tank starts as a pure monoculture');
  for (let i = 0; i < 40; i++) tick(world, { chain: 0.5, market: 0.5 });
  const after = tally();
  assert.ok(
    Object.keys(after).length >= 2,
    `a monopoly must not stay total, got ${JSON.stringify(after)}`,
  );
  assert.ok(
    after.WHALE / world.creatures.length < 1,
    'the exhausted niche loses its grip on the tank',
  );
});

test('predation: a whale takes one meal per hunt cooldown, not one per tick', () => {
  const pod = (cooldown: number): ReturnType<typeof createWorld> => {
    const world = createWorld(808, { ...NO_FOOD_NO_BIRTH, huntCooldown: cooldown });
    world.creatures = world.creatures.slice(0, 6);
    const [whale, ...prey] = world.creatures;
    whale.archetype = 'WHALE';
    whale.radius = 10;
    whale.energy = 150;
    for (const p of prey) {
      p.archetype = 'INSIDER';
      p.radius = 3;
      p.energy = 150;
    }
    for (let i = 0; i < 10; i++) {
      // Hold the pod together: predation is a contact rule.
      for (const c of world.creatures) { c.x = 500; c.y = 500; }
      tick(world, { chain: 0.5, market: 0 });
    }
    return world;
  };
  assert.equal(pod(0).totalPredations, 5, 'no cooldown: the whale clears the pod');
  assert.equal(
    pod(DEFAULT_CONFIG.huntCooldown).totalPredations,
    1,
    'a digesting whale leaves the rest of the pod alone',
  );
});

test('money is weather: environmental payments and tx rain never rewrite a living genome', () => {
  const w = createWorld(5);
  for (let i = 0; i < 40; i++) tick(w, { chain: 0.6, market: 0.5 }, []);
  const before = new Map(w.creatures.map((c) => [c.id, JSON.stringify(c.genome)]));
  assert.ok(before.size > 0);

  applyIntervention(w, { type: 'feed', x: 500, y: 500, radius: 200 });
  const rain = [
    { hash: '0x' + 'ab'.repeat(32), size: 0.95 },
    { hash: '0x' + 'cd'.repeat(32), size: 0.2 },
  ];
  for (let i = 0; i < 30; i++) tick(w, { chain: 0.9, market: 0.9 }, i === 0 ? rain : []);

  // Survivors keep exactly the genome they were born with: weather money may
  // move food around and cull the weak, but it never edits an individual. The
  // paid `mutate` action does edit one, on purpose, and is pinned by its own
  // tests below — this rule is drawn around that exception, not across it.
  // Creatures born inside the window are skipped: a birth rolls the blind
  // `mutateGenome`, which is the sim's own business and nobody's purchase.
  for (const c of w.creatures) {
    const b = before.get(c.id);
    if (b === undefined) continue;
    assert.equal(JSON.stringify(c.genome), b, `creature ${c.id} had its genome rewritten by money`);
  }
});

test('the hidden rules are readable: hunger flag, dominance tax, positioned reseed', () => {
  const w = createWorld(3);
  for (let i = 0; i < 30; i++) tick(w, { chain: 0.6, market: 0.5 }, []);
  assert.ok(w.creatures.length > 0);

  // Hunger is a plain threshold on energy, exposed for the renderer.
  const c = w.creatures[0];
  c.energy = w.config.maxEnergy * 0.9;
  assert.equal(isHungry(w, c), false);
  c.energy = w.config.maxEnergy * 0.2;
  assert.equal(isHungry(w, c), true);

  // Force a monopoly: one species filling the glass crowds the rest out.
  for (const cr of w.creatures) cr.archetype = 'WHALE';
  const before = w.eventLog.length;
  tick(w, { chain: 0.6, market: 0.5 }, []);
  const tax = dominantTax(w);
  assert.ok(tax, 'a one-species tank must report the dominance tax');
  assert.equal(tax.archetype, 'WHALE');
  assert.ok(tax.share > 0.5);
  const reseeds = w.eventLog.slice(before).filter((e) => e.type === 'reseed');
  assert.ok(reseeds.length > 0, 'recolonization must leave positioned events');
  for (const e of reseeds) {
    assert.ok(Number.isFinite(e.x) && Number.isFinite(e.y), 'reseed events carry a landing site');
    assert.ok(e.species && e.species !== 'WHALE', 'the reserve refills the crowded-out niches');
  }
});

test('counters: repeated feeds decay, bloom and drought cancel, poison overreach backlashes', () => {
  const w = createWorld(11);
  for (let i = 0; i < 20; i++) tick(w, { chain: 0.5, market: 0.5 }, []);

  // Same water, second helping: the drop shrinks instead of stacking.
  const first = applyIntervention(w, { type: 'feed', x: 500, y: 500, radius: 80 });
  const second = applyIntervention(w, { type: 'feed', x: 510, y: 505, radius: 80 });
  assert.ok((second.amount ?? 0) < (first.amount ?? 0), 'an overlapping feed must decay');
  const far = applyIntervention(w, { type: 'feed', x: 100, y: 100, radius: 80 });
  assert.equal(far.amount, first.amount, 'a far-away feed is unaffected');

  // Opposite weathers cancel each other.
  applyIntervention(w, { type: 'bloom' });
  assert.ok(w.effects.some((e) => e.kind === 'bloom'));
  applyIntervention(w, { type: 'drought' });
  assert.ok(w.effects.some((e) => e.kind === 'drought'));
  assert.ok(!w.effects.some((e) => e.kind === 'bloom'), 'drought must end a bloom');
  applyIntervention(w, { type: 'bloom' });
  assert.ok(!w.effects.some((e) => e.kind === 'drought'), 'bloom must end a drought');

  // A poison that kills its neighbourhood answers with a short famine.
  const w2 = createWorld(12);
  for (let i = 0; i < 20; i++) tick(w2, { chain: 0.5, market: 0.5 }, []);
  applyIntervention(w2, { type: 'poison', x: 500, y: 500, radius: 120 });
  let placed = 0;
  for (const c of w2.creatures) {
    if (placed >= 12) break;
    c.x = 500 + (placed % 4) * 10;
    c.y = 500 + Math.floor(placed / 4) * 10;
    c.energy = 1;
    placed++;
  }
  tick(w2, { chain: 0.5, market: 0.5 }, []);
  const backlash = w2.eventLog.filter((e) => e.type === 'intervention' && e.kind === 'backlash');
  assert.ok(backlash.length > 0, 'a massacre must trigger the famine backlash');
  assert.ok(w2.effects.some((e) => e.kind === 'drought'), 'the backlash halts spawning briefly');
});

test('interventions carry their payer through to effects and events', () => {
  const w = createWorld(13);
  for (let i = 0; i < 10; i++) tick(w, { chain: 0.5, market: 0.5 }, []);
  const meta = { payer: '0x' + '77'.repeat(20), paid: '50000 ABYS' };
  applyIntervention(w, { type: 'feed', x: 400, y: 400, radius: 80 }, meta);
  const feast = w.effects.find((e) => e.kind === 'feast');
  assert.equal(feast?.payer, meta.payer);
  assert.equal(feast?.paid, meta.paid);
  const ev = w.eventLog.filter((e) => e.type === 'intervention').slice(-1)[0];
  assert.equal(ev.payer, meta.payer);
  assert.equal(ev.paid, meta.paid);
  assert.ok(typeof ev.affected === 'number');
});

test('obituaries: a starvation death is written up with the life it lived', () => {
  const world = createWorld(160, NO_FOOD_NO_BIRTH);
  world.creatures = world.creatures.slice(0, 1);
  const c = world.creatures[0];
  c.kills = 9;
  c.offspring = 5;
  c.maxMeal = 26.64610953522815;
  c.boomTouched = true;
  c.energy = 0.05;
  for (let i = 0; i < 5 && world.creatures.length > 0; i++) tick(world, { chain: 0, market: 0 });
  assert.equal(world.creatures.length, 0);
  const o = world.obituaries[0];
  assert.equal(o.id, c.id);
  assert.equal(o.name, c.name);
  assert.equal(o.archetype, c.archetype);
  assert.equal(o.cause, 'starvation');
  assert.equal(o.diedTick, world.tick);
  assert.equal(o.kills, 9);
  assert.equal(o.offspring, 5);
  assert.equal(o.maxMeal, 26.6, 'a meal is recorded to one decimal, not to the last bit');
  assert.deepEqual(o.titles.sort(), ['apex', 'lineageBearer', 'whalefallSurvivor']);
  const ev = world.eventLog.find((e) => e.type === 'memorial');
  assert.equal(ev?.name, c.name);
  assert.equal(ev?.species, c.archetype);
});

test('obituaries: the prey of a hunt is memorialized, not just counted', () => {
  const world = createWorld(161, NO_FOOD_NO_BIRTH);
  world.creatures = world.creatures.slice(0, 2);
  const whale = world.creatures[0];
  const prey = world.creatures[1];
  whale.archetype = 'WHALE';
  whale.radius = 8.8;
  whale.energy = 100;
  prey.archetype = 'INSIDER';
  prey.radius = 4;
  prey.energy = 60;
  whale.x = 500; whale.y = 500;
  prey.x = 505; prey.y = 500;
  tick(world, { chain: 0, market: 0 });
  const o = world.obituaries[0];
  assert.equal(o.id, prey.id);
  assert.equal(o.cause, 'predation');
  assert.deepEqual(o.titles, [], 'a short life earns no titles');
  const survivor = world.creatures.find((c) => c.id === whale.id);
  assert.equal(survivor?.kills, 1);
  assert.equal(survivor?.maxMealTx, null, 'a meal of prey has no meteor behind it');
  // Half of what the prey had left, minus the prey's own metabolism this tick.
  assert.ok(survivor!.maxMeal > 29 && survivor!.maxMeal <= 30, 'a hunted prey counts as a meal');
});

test('obituaries: a poison death is filed as poison and titled poisonGhost', () => {
  const world = createWorld(162, NO_FOOD_NO_BIRTH);
  world.creatures = world.creatures.slice(0, 1);
  const c = world.creatures[0];
  c.x = 500; c.y = 500;
  c.energy = 8;
  applyIntervention(world, { type: 'poison', x: 500, y: 500, radius: 100, durationTicks: 100 });
  for (let i = 0; i < 8 && world.creatures.length > 0; i++) {
    tick(world, { chain: 0, market: 0 });
  }
  const o = world.obituaries[0];
  assert.equal(o.cause, 'poison', 'a death inside the zone is not plain starvation');
  assert.ok(o.titles.includes('poisonGhost'));
});

test('the memorial ring keeps the 24 newest deaths and survives a save', () => {
  const world = createWorld(163, { ...NO_FOOD_NO_BIRTH, initialPopulation: 30 });
  for (const c of world.creatures) c.energy = 0.02;
  for (let i = 0; i < 10 && world.creatures.length > 0; i++) tick(world, { chain: 0, market: 0 });
  assert.equal(world.creatures.length, 0);
  assert.equal(world.obituaries.length, 24, 'the ring is bounded');
  assert.ok(world.obituaries.every((o) => o.cause === 'starvation'));
  assert.ok(world.totalDied >= 30, 'every death is counted even once the ring is full');
  const revived = fromJSON(toJSON(world));
  assert.equal(revived.obituaries.length, 24);
  assert.deepEqual(revived.obituaries[0], world.obituaries[0]);
});

test('a save written before the story layer loads with empty ledgers', () => {
  const world = createWorld(164, NO_FOOD_NO_BIRTH);
  const legacy = JSON.parse(toJSON(world)) as Record<string, unknown> & {
    creatures: Record<string, unknown>[];
  };
  delete legacy.eaters;
  delete legacy.obituaries;
  for (const c of legacy.creatures) {
    delete c.offspring;
    delete c.maxMeal;
    delete c.boomTouched;
    delete c.parentId;
  }
  const revived = fromJSON(JSON.stringify(legacy));
  assert.deepEqual(revived.eaters, {});
  assert.deepEqual(revived.obituaries, []);
  assert.ok(
    revived.creatures.every(
      (c) => c.offspring === 0 && c.maxMeal === 0 && c.boomTouched === false && c.parentId === null,
    ),
  );
  runTicks(revived, 30);
});

test('eaters: a tx pellet is traceable to the creature that ate it', () => {
  const hash = '0x' + 'e1'.repeat(32);
  const world = createWorld(165, { ...DEFAULT_CONFIG, ...NO_FOOD, populationFloor: 0 });
  world.creatures = world.creatures.slice(0, 1);
  const c = world.creatures[0];
  c.x = 200; c.y = 700;
  c.energy = 60; // hungry, so it swims for the fall instead of ignoring it
  for (let i = 0; i < 40 && !(world.eaters[hash]?.length > 0); i++) {
    tick(world, { chain: 0.5, market: 0 }, i === 0 ? [{ hash, size: 1, usd: 812, at: { x: 200, y: 700 } }] : []);
  }
  assert.ok(world.eaters[hash]?.includes(c.id), 'the meteor trail must name its eater');
  assert.equal(c.maxMealTx, hash, 'a record meal names the transfer it fell from');
  assert.equal(c.maxMealUsd, 812);
  assert.equal(world.eaters[hash].length, 1, 'one bite is logged once');
  const survivor = world.creatures.find((x) => x.id === c.id);
  assert.ok(survivor && survivor.maxMeal > 0, 'the biggest meal is remembered');
});

/* ---------- the snapshot has to fit the one storage value it lives in ---------- */

/**
 * The whole tank is serialized into a single Durable Object value, and a value
 * over 2 MB is refused outright. Measured worst case — every capped collection
 * at its cap, each entry copied from a real one — comes to about 1.1 MiB, so
 * this sits above that with room for the world to grow and well under the limit
 * that breaks it. Written as a literal rather than derived from the caps: a
 * budget computed from the same numbers the code uses can only ever agree with
 * itself.
 */
const SNAPSHOT_BUDGET = 1.5 * 1024 * 1024;

/** A 32-byte hex hash that is distinct per index, the shape `eaters` is keyed by. */
function fakeHash(i: number): string {
  return '0x' + i.toString(16).padStart(4, '0').repeat(16);
}

/**
 * A cull record at the size production actually carries — about 300 bytes, two
 * victims. Culls accrue on an hourly and a daily cadence, so a test cannot tick
 * its way to the cap and still finish; the shape has to be built instead.
 */
function cullRecordAt(i: number): CullRecord {
  return {
    type: 'harvest',
    tick: i,
    day: Math.floor(i / 1000),
    culled: [0, 1].map((k) => ({
      id: i * 2 + k,
      name: creatureName('INSIDER', i * 2 + k),
      generation: 4,
      energy: 12.5 - k,
      archetype: 'INSIDER' as Archetype,
      age: 900 - k * 20,
    })),
    saved: [],
    populationBefore: 120,
    populationAfter: 118,
  };
}

test('the eater map stops at the meteor trail it exists to serve', () => {
  // A local world running this same code against the same chain carried 156,158
  // keys here — one per transaction that had ever rained food since the tank
  // started, and 11.98 MiB of a 13.63 MiB snapshot.
  // The only reader is the meteor trail, which renders the twelve newest falls
  // and asks for exactly those hashes, so every older key was unreachable and
  // still had to be stored, serialized and parsed on each boot.
  const world = createWorld(167, { ...DEFAULT_CONFIG, ...NO_FOOD, populationFloor: 0 });
  world.creatures = world.creatures.slice(0, 1);
  const c = world.creatures[0];
  c.x = 200; c.y = 700;
  // Seeded past the cap the way a long-lived tank would be, oldest first. One
  // real bite is then taken, because pruning runs on the insert of a new hash —
  // the only moment the map can grow — and that is the path worth exercising.
  const stale = Array.from({ length: 200 }, (_, i) => fakeHash(i));
  for (const h of stale) world.eaters[h] = [1];
  const fresh = '0x' + 'ff'.repeat(32);
  for (let i = 0; i < 40 && !(world.eaters[fresh]?.length > 0); i++) {
    c.energy = 60; // kept hungry, so it swims for the fall instead of ignoring it
    tick(world, { chain: 0.5, market: 0 }, i === 0 ? [{ hash: fresh, size: 1, at: { x: 200, y: 700 } }] : []);
  }
  assert.ok(world.eaters[fresh]?.length > 0, 'the test needs the bite to actually happen');
  const keys = Object.keys(world.eaters);
  assert.ok(keys.length <= 64, `the map is capped, got ${keys.length} keys`);
  assert.equal(world.eaters[stale[0]], undefined, 'the oldest hash is what gets dropped');
  assert.ok(world.eaters[stale[199]], 'a hash inside the cap survives');
  assert.ok(world.eaters[fresh], 'and the fall just eaten is still traceable');
});

test('the tick log sawtooths inside its cap instead of growing forever', () => {
  const world = createWorld(169);
  // Past the cap and through one trim, so this covers the splice and not only
  // the approach to it.
  runTicks(world, STATS_LOG_CAP + STATS_LOG_TRIM + 10);
  assert.ok(world.statsLog.length <= STATS_LOG_CAP, `capped, got ${world.statsLog.length}`);
  assert.ok(
    world.statsLog.length >= STATS_LOG_CAP - STATS_LOG_TRIM,
    `the trim takes a bounded bite rather than emptying the log, got ${world.statsLog.length}`,
  );
  assert.equal(
    world.statsLog.at(-1)?.tick,
    STATS_LOG_CAP + STATS_LOG_TRIM + 10,
    'and it is the newest history that is kept',
  );
});

test('a snapshot written before the caps shrinks on load', () => {
  // The stored value is the one that has to go back in, so an oversized
  // snapshot has to be trimmed on the way through rather than on the next tick.
  const world = createWorld(170);
  runTicks(world, 5);
  const raw = JSON.parse(toJSON(world)) as Record<string, unknown> & {
    eaters: Record<string, number[]>;
    culls: CullRecord[];
    statsLog: Record<string, unknown>[];
  };
  for (let i = 0; i < 5000; i++) raw.eaters[fakeHash(i)] = [1, 2];
  raw.culls = Array.from({ length: 2000 }, (_, i) => cullRecordAt(i));
  raw.statsLog = Array.from({ length: 6000 }, (_, i) => ({ ...raw.statsLog[0], tick: i }));
  const revived = fromJSON(JSON.stringify(raw));
  assert.ok(Object.keys(revived.eaters).length <= 64, `eaters trimmed, got ${Object.keys(revived.eaters).length}`);
  assert.ok(revived.culls.length <= 500, `culls trimmed, got ${revived.culls.length}`);
  assert.ok(revived.statsLog.length <= STATS_LOG_CAP, `statsLog trimmed, got ${revived.statsLog.length}`);
  // Trimmed from the old end: these three are what a viewer can still ask about.
  assert.ok(revived.eaters[fakeHash(4999)], 'the newest hash survives');
  assert.equal(revived.culls.at(-1)?.tick, 1999, 'the newest cull survives');
  assert.equal(revived.statsLog.at(-1)?.tick, 5999, 'the newest tick survives');
});

test('the cull history stops growing at the cap', () => {
  const config: WorldConfig = {
    ...DEFAULT_CONFIG,
    initialPopulation: 20,
    populationFloor: 5,
    judgmentInterval: 10,
    judgmentCullRatio: 0.1,
  };
  const world = createWorld(172, config);
  // Stuffed past the cap the way a months-old tank would be, then one real cull
  // is run. The trim lives on the push, which is the only thing that can grow
  // the array — a test that only ever stuffed it would pass with no trim at all,
  // and culls accrue daily, so ticking to the cap is not an option.
  for (let i = 0; i < 900; i++) world.culls.push(cullRecordAt(i));
  runTicks(world, 10);
  assert.ok(world.culls.length <= 500, `capped at 500, got ${world.culls.length}`);
  assert.equal(
    world.culls.at(-1)?.type,
    'judgment',
    'the cull that just ran is the newest record, and the newest is what survives',
  );
});

test('a world at every one of its caps still fits the value it has to live in', () => {
  // This is the assertion that would have caught SQLITE_TOOBIG before it reached
  // production. The put is awaited on the request path, so an oversized snapshot
  // did not degrade the site — it turned every save into an HTTP 500 and the
  // once-a-minute cron into an exception, and once the world passed the limit
  // nothing was ever stored again, so an eviction could only be survived as
  // whatever the last successful save happened to hold.
  const world = createWorld(171);
  runTicks(world, 20);
  const cfg = world.config;
  const stat = world.statsLog[world.statsLog.length - 1];
  const creature = world.creatures[0];
  const food = world.foods[0];
  // Filled to the caps with copies of real entries, so every byte counted here
  // is a byte of the shape the sim actually writes rather than an invented one.
  // The split in how the caps are named is deliberate: 500 and 64 are written
  // out because the two tests above already pin them, whereas the tick log is
  // read from the module so that raising its cap raises this fill with it —
  // which is what makes the budget bite on the one collection big enough to
  // breach the limit on its own.
  world.statsLog = Array.from({ length: STATS_LOG_CAP }, (_, i) => ({ ...stat, tick: i }));
  world.creatures = Array.from({ length: cfg.maxPopulation }, (_, i) => ({ ...creature, id: i + 1 }));
  world.foods = Array.from({ length: cfg.maxFood }, (_, i) => ({ ...food, id: i + 1 }));
  world.culls = Array.from({ length: 500 }, (_, i) => cullRecordAt(i));
  world.eaters = {};
  for (let i = 0; i < 64; i++) world.eaters[fakeHash(i)] = [1, 2, 3, 4, 5, 6, 7, 8];
  const bytes = Buffer.byteLength(toJSON(world), 'utf8');
  assert.ok(
    bytes < SNAPSHOT_BUDGET,
    `snapshot is ${(bytes / 1048576).toFixed(2)} MiB, over the ${(SNAPSHOT_BUDGET / 1048576).toFixed(2)} MiB budget and heading for the 2 MB limit`,
  );
});

test('offspring: a birth credits the parent and the child carries the line', () => {
  const world = createWorld(166, {
    ...DEFAULT_CONFIG,
    ...NO_FOOD,
    populationFloor: 0,
    reproduceUrgeThreshold: 0,
    reproduceThreshold: 10,
  });
  world.creatures = world.creatures.slice(0, 1);
  // A non-WHALE parent, so the child it makes cannot become its next meal.
  world.creatures[0].archetype = 'ALGO';
  const parentId = world.creatures[0].id;
  world.creatures[0].energy = 400; // each birth costs 45
  let child: Creature | null = null;
  for (let i = 0; i < 5 && !child; i++) {
    tick(world, { chain: 0.5, market: 0.5 });
    child = world.creatures.find((c) => c.parentId === parentId) ?? null;
  }
  assert.ok(child, 'a creature above the threshold should reproduce');
  const parent = world.creatures.find((c) => c.id === parentId);
  assert.ok(parent, 'the parent is still alive to be credited');
  assert.ok(parent.offspring >= 1, 'the parent keeps its own count');
  assert.equal(child.generation, parent.generation + 1);
  assert.equal(child.offspring, 0);
});

test('persona packs three quartiled axes into six bits', () => {
  const a = randomGenome(new Rng(9));
  const b = randomGenome(new Rng(9));
  const pa = personaOf(a);
  assert.equal(pa, personaOf(b), 'the same genome tells the same story');
  assert.ok(pa >= 0 && pa <= 63, 'six bits, three axes');
  let spread = 0;
  for (let i = 0; i < 200; i++) spread |= personaOf(randomGenome(new Rng(i)));
  assert.ok(spread > 7, 'a population should not share one personality');
});

test('idsInZone wraps the torus: an edge zone sees both sides', () => {
  const world = createWorld(167, NO_FOOD_NO_BIRTH);
  world.creatures = world.creatures.slice(0, 3);
  const [west, east, mid] = world.creatures;
  west.x = 995; west.y = 500;
  east.x = 5; east.y = 500;
  mid.x = 500; mid.y = 500;
  const ids = idsInZone(world, 0, 500, 20).sort((a, b) => a - b);
  assert.deepEqual(ids, [west.id, east.id].sort((a, b) => a - b));
  assert.deepEqual(idsInZone(world, 0, 500, 0), []);
});

/* ---------- paid interventions on one creature: name / wish / mutate / ark ---------- */

const PAYER = '0x' + '77'.repeat(20);
const PAID = { payer: PAYER, paid: '100000 ABYS' };
const RECEIPT = '0x' + 'ab'.repeat(32);

/**
 * A genome with every output drive flat, so it reads as INSIDER and any bias an
 * edit moves is a bias the test moved. w1 stays random: the perception edit is
 * a gain on the sensory columns and needs something there to scale.
 */
function flatGenome(): Genome {
  const g = randomGenome(new Rng(4));
  g.w2 = g.w2.map(() => 0);
  g.b2 = g.b2.map(() => 0);
  return g;
}

test('a paid gene edit is deterministic, changes the genome and stays inside the clamp', () => {
  const untouched = flatGenome();
  for (const trait of GENE_TRAITS) {
    for (const direction of ['boost', 'suppress'] as const) {
      const a = flatGenome();
      const b = flatGenome();
      mutateTrait(a, trait, direction);
      mutateTrait(b, trait, direction);
      assert.deepEqual(a, b, `${trait}/${direction} must edit identically on every instance or the world stops replaying`);
      assert.notDeepEqual(a, untouched, `${trait}/${direction} that rewrote nothing was still charged for`);
      // Perception is the one gain on the senses; the rest are drives only.
      if (trait === 'perception') assert.notDeepEqual(a.w1, untouched.w1);
      else assert.deepEqual(a.w1, untouched.w1, `${trait} must leave the sensory layer alone`);
      for (const w of [...a.w1, ...a.b1, ...a.w2, ...a.b2]) {
        assert.ok(Math.abs(w) <= 2, `${trait} pushed a weight past the ceiling`);
      }
    }
  }
  // Buying the same edit over and over saturates rather than running away.
  const greedy = flatGenome();
  for (let i = 0; i < 40; i++) mutateTrait(greedy, 'aggression', 'boost');
  assert.equal(Math.max(...greedy.w2), 2);
  assert.equal(Math.max(...greedy.b2), 2, 'a saturated edit parks on the ceiling');
});

test('the species is read off the drives, so four of the five edits can rewrite it', () => {
  const up = flatGenome();
  for (let i = 0; i < 6; i++) mutateTrait(up, 'size', 'boost');
  assert.equal(archetypeOf(up), 'WHALE', 'a hungry, slow body reads as a whale');
  const down = flatGenome();
  for (let i = 0; i < 6; i++) mutateTrait(down, 'size', 'suppress');
  assert.equal(archetypeOf(down), 'ALGO', 'a lean, fast body reads as an algo');
  // aggression and fertility move those same biases harder than size does, which
  // is exactly why the world resyncs the body after every edit and not only
  // after the size one.
  const brood = flatGenome();
  mutateTrait(brood, 'fertility', 'boost');
  assert.equal(archetypeOf(brood), 'APE', 'a single fertility edit already redrew the species');
  const eyes = flatGenome();
  for (let i = 0; i < 6; i++) mutateTrait(eyes, 'perception', 'boost');
  assert.equal(archetypeOf(eyes), 'INSIDER', 'a gain on the senses leaves the drives alone');
});

test('a paid edit resyncs the body whenever it redrew the species', () => {
  const world = createWorld(21, NO_FOOD_NO_BIRTH);
  const base = world.config.creatureRadius;
  const c = world.creatures[0];
  c.genome = flatGenome();
  c.archetype = 'INSIDER';
  c.radius = base * ARCHETYPES.INSIDER.radiusMult * 1.5; // grown on kills
  c.name = creatureName('INSIDER', c.id);
  // fertility is the edit the old `trait === 'size'` guard let through unsynced.
  applyIntervention(world, { type: 'mutate', creatureId: c.id, trait: 'fertility', direction: 'suppress' }, PAID);
  const next = archetypeOf(c.genome);
  assert.notEqual(next, 'INSIDER', 'the edit redrew the drives the species is read off');
  assert.equal(c.archetype, next, 'the body follows the gene, whichever trait moved it');
  assert.ok(
    Math.abs(c.radius - base * ARCHETYPES[next].radiusMult * 1.5) < 1e-9,
    'the growth it earned carries across the rewrite as a ratio',
  );
  assert.equal(c.name, creatureName(next, c.id), 'an unnamed creature takes the codename of the species it became');
  const ev = world.eventLog.filter((e) => e.type === 'mutation').slice(-1)[0];
  assert.equal(ev.trait, 'fertility');
  assert.equal(ev.archetype, next, 'the event carries the new species so the tank can say it out loud');
  assert.equal(ev.payer, PAYER);
  assert.equal(ev.paid, PAID.paid);
});

test('an edit that leaves the species alone leaves the body and the paid name alone', () => {
  const world = createWorld(24, NO_FOOD_NO_BIRTH);
  const c = world.creatures[0];
  c.genome = flatGenome();
  c.archetype = 'INSIDER';
  c.name = creatureName('INSIDER', c.id);
  const born = c.name;
  const before = c.radius;
  applyIntervention(world, { type: 'name', creatureId: c.id, name: 'Tiny' }, PAID);
  applyIntervention(world, { type: 'mutate', creatureId: c.id, trait: 'perception', direction: 'boost' }, PAID);
  assert.equal(c.archetype, 'INSIDER');
  assert.equal(c.radius, before, 'no respecies, so no rescale');
  assert.equal(c.name, born, 'and no new codename either');
  const quiet = world.eventLog.filter((e) => e.type === 'mutation').slice(-1)[0];
  assert.equal(quiet.archetype, undefined, 'the event only names a species when one actually changed');
  // When the body does change, the name somebody paid for is not overwritten.
  for (let i = 0; i < 6; i++) {
    applyIntervention(world, { type: 'mutate', creatureId: c.id, trait: 'size', direction: 'boost' }, PAID);
  }
  assert.equal(c.archetype, 'WHALE');
  assert.equal(displayName(c), 'Tiny', 'a bought name outranks the species it became');
  assert.equal(c.name, born, 'so the codename underneath stays the one it was born with');
});

test('a paid name replaces the codename everywhere and keeps it on record', () => {
  const world = createWorld(22, NO_FOOD_NO_BIRTH);
  world.creatures = world.creatures.slice(0, 2);
  const c = world.creatures[0];
  const born = c.name;
  const res = applyIntervention(world, { type: 'name', creatureId: c.id, name: 'Moby' }, PAID);
  assert.equal(res.affected, 1);
  assert.equal(c.customName, 'Moby');
  assert.equal(c.name, born, 'the birth codename stays put: lineage and records keep referring to it');
  assert.equal(displayName(c), 'Moby');
  const ev = world.eventLog.filter((e) => e.type === 'naming').slice(-1)[0];
  assert.equal(ev.name, born, 'the event tells the tank what it used to be called');
  assert.equal(ev.message, 'Moby');
  assert.equal(ev.creatureId, c.id);
  assert.equal(ev.payer, PAYER);
  assert.equal(ev.paid, PAID.paid);
  // Starve it out: the memorial is the last place a name is spoken.
  c.energy = 0.05;
  for (let i = 0; i < 8 && world.creatures.length > 0; i++) tick(world, { chain: 0, market: 0 });
  const o = world.obituaries.find((x) => x.id === c.id);
  assert.equal(o?.name, 'Moby', 'an obituary is filed under the name the tank knew');
});

test('naming a legend is a different purchase from naming a fish', () => {
  const world = createWorld(23, NO_FOOD_NO_BIRTH);
  const c = world.creatures[0];
  c.generation = LEGENDARY_GENERATION - 1;
  c.kills = LEGENDARY_KILLS - 1;
  assert.equal(isLegendary(c), false, 'one short on both axes is still a fish');
  c.generation = LEGENDARY_GENERATION;
  assert.equal(isLegendary(c), true, 'old enough to be a character');
  c.generation = 0;
  c.kills = LEGENDARY_KILLS;
  assert.equal(isLegendary(c), true, 'bloody enough to be a character');
});

test('a wishing meteor falls where the dice land it, and replays identically', () => {
  const fall = (seed: number) => {
    const world = createWorld(seed, NO_FOOD_NO_BIRTH);
    const res = applyIntervention(world, { type: 'wish', message: 'be kind' }, { ...PAID, tx: RECEIPT });
    return { at: res.at, hash: res.hash, pellets: world.foods.length };
  };
  const a = fall(31);
  assert.deepEqual(a, fall(31), 'the same receipt must land the same wish on every instance');
  assert.notDeepEqual(a.at, fall(32).at, 'an unaimed wish is the dice, not a fixed spot');
  assert.equal(a.hash, RECEIPT, 'the fall is traceable to the burn that paid for it');
  // The whole point of decoupling the yield from the streak's size: a bought
  // wish never lands in empty water.
  for (const seed of [31, 32, 33, 7]) {
    assert.equal(fall(seed).pellets, WISH_PELLETS, `seed ${seed} must leave plankton behind`);
  }
  const world = createWorld(31, NO_FOOD_NO_BIRTH);
  applyIntervention(world, { type: 'wish', message: 'be kind' }, { ...PAID, tx: RECEIPT });
  assert.ok(world.foods.every((f) => f.src === RECEIPT), 'every pellet is attributable to the wish');
  assert.ok(
    world.foods.every((f) => Math.abs(f.energy - world.config.foodEnergy * (0.25 + WISH_METEOR_SIZE)) < 1e-9),
    'a light fall, priced as one',
  );
  const ev = world.eventLog.filter((e) => e.type === 'wish').slice(-1)[0];
  assert.equal(ev.message, 'be kind');
  assert.equal(ev.size, WISH_METEOR_SIZE);
  assert.equal(ev.payer, PAYER);
});

test('an aimed wishing meteor lands where it was aimed, wrapped into the torus', () => {
  const world = createWorld(9, NO_FOOD_NO_BIRTH);
  const res = applyIntervention(world, { type: 'wish', message: 'hi', x: 1200, y: -30 }, PAID);
  assert.deepEqual(res.at, { x: 200, y: 970 }, 'an aim outside the tank wraps instead of being dropped');
  assert.equal(world.foods.length, WISH_PELLETS);
  const far = world.foods.filter(
    (f) => Math.hypot(Math.min(Math.abs(f.x - 200), 1000 - Math.abs(f.x - 200)), Math.min(Math.abs(f.y - 970), 1000 - Math.abs(f.y - 970))) > 40,
  );
  assert.equal(far.length, 0, 'the plankton lands around the message, not across the map');
});

test('an ark ticket steps out of both culls, and the cull reports who it saved', () => {
  for (const kind of ['harvest', 'judgment'] as const) {
    const world = createWorld(41, {
      ...NO_FOOD_NO_BIRTH,
      harvestInterval: kind === 'harvest' ? 1 : 100_000,
      harvestCullRatio: 0.5,
      judgmentInterval: kind === 'judgment' ? 1 : 100_000,
      judgmentCullRatio: 0.5,
    });
    world.creatures = world.creatures.slice(0, 6);
    // No WHALE in the tank, so nothing is eaten before the scythe swings.
    for (const c of world.creatures) c.archetype = 'ALGO';
    world.creatures.forEach((c, i) => { c.energy = 100 + i * 10; });
    const holder = world.creatures[0];
    holder.energy = 30; // bottom of the cull window, nowhere near starving
    const bought = applyIntervention(world, { type: 'ark', creatureId: holder.id }, PAID);
    assert.equal(bought.affected, 1);
    assert.equal(holder.arkProtected, true);
    assert.equal(holder.arkBy, PAYER, 'the card can name its guarantor');
    const again = applyIntervention(world, { type: 'ark', creatureId: holder.id }, PAID);
    assert.equal(again.affected, 0, 'a second ticket on one body buys nothing');
    tick(world, { chain: 0.5, market: 0.5 });
    const rec = world.culls.find((r) => r.type === kind);
    assert.ok(rec, `the ${kind} ran`);
    assert.equal(rec.culled.length, 3, 'the quota is taken from the next ones down, not shrunk');
    assert.ok(rec.culled.every((v) => v.id !== holder.id), 'the scythe stepped over the ticket holder');
    assert.deepEqual(rec.saved.map((s) => s.id), [holder.id]);
    assert.equal(rec.saved[0].name, holder.name);
    assert.ok(world.creatures.some((c) => c.id === holder.id), 'and it is still swimming');
    assert.ok(
      world.obituaries.some((o) => o.id === holder.id) === false,
      'a saved creature is not memorialized',
    );
    const ev = world.eventLog.filter((e) => e.type === kind).slice(-1)[0];
    assert.deepEqual(ev.saved?.map((s) => s.id), [holder.id], 'the viewer learns who the ark saved');
  }
});

test('an ark ticket is a lifeboat, not immortality: hunger still kills the holder', () => {
  const world = createWorld(46, NO_FOOD_NO_BIRTH);
  world.creatures = world.creatures.slice(0, 1);
  const c = world.creatures[0];
  applyIntervention(world, { type: 'ark', creatureId: c.id }, PAID);
  c.energy = 0.05;
  for (let i = 0; i < 5 && world.creatures.length > 0; i++) tick(world, { chain: 0, market: 0 });
  assert.equal(world.creatures.length, 0, 'the ark only buys immunity from the tank’s own two culls');
  assert.equal(world.obituaries[0].cause, 'starvation');
});

test('a paid name and an ark ticket are never inherited', () => {
  const world = createWorld(166, {
    ...DEFAULT_CONFIG,
    ...NO_FOOD,
    populationFloor: 0,
    reproduceUrgeThreshold: 0,
    reproduceThreshold: 10,
  });
  world.creatures = world.creatures.slice(0, 1);
  const parent = world.creatures[0];
  parent.archetype = 'ALGO';
  parent.energy = 400;
  applyIntervention(world, { type: 'ark', creatureId: parent.id }, PAID);
  applyIntervention(world, { type: 'name', creatureId: parent.id, name: 'Founder' }, PAID);
  let child: Creature | null = null;
  for (let i = 0; i < 5 && !child; i++) {
    tick(world, { chain: 0.5, market: 0.5 });
    child = world.creatures.find((c) => c.parentId === parent.id) ?? null;
  }
  assert.ok(child, 'the parent reproduced');
  assert.equal(child.arkProtected, undefined, 'a child is born mortal whatever its parent carried');
  assert.equal(child.customName, undefined, 'and unnamed: the name was bought for one body');
  assert.equal(displayName(child), child.name);
});

test('paid identity survives a save, and an older snapshot loads unnamed and mortal', () => {
  const world = createWorld(45, NO_FOOD_NO_BIRTH);
  world.creatures = world.creatures.slice(0, 3);
  const [a, b, plain] = world.creatures;
  applyIntervention(world, { type: 'name', creatureId: a.id, name: 'Moby' }, PAID);
  applyIntervention(world, { type: 'ark', creatureId: b.id }, PAID);
  const json = toJSON(world);
  const restored = fromJSON(json);
  const ra = findCreature(restored, a.id)!;
  const rb = findCreature(restored, b.id)!;
  assert.equal(displayName(ra), 'Moby');
  assert.equal(ra.name, a.name, 'the codename travelled with it');
  assert.equal(rb.arkProtected, true);
  assert.equal(rb.arkBy, PAYER);
  assert.equal(findCreature(restored, plain.id)!.arkProtected, undefined);
  assert.equal(findCreature(restored, 999_999), null, 'an id the tank has moved on past is null, not a ghost');
  assert.equal(toJSON(restored), json, 'a restore is not a rewrite');

  // A snapshot from before the paid layer existed: nothing invented, nothing read
  // as bought. A stray null or an empty string must not become a ticket.
  const legacy = JSON.parse(json) as { creatures: Record<string, unknown>[]; culls?: Record<string, unknown>[] };
  for (const c of legacy.creatures) {
    delete c.customName; delete c.arkProtected; delete c.arkBy;
  }
  legacy.creatures[0].arkProtected = null;
  legacy.creatures[0].customName = '';
  legacy.culls = [{ type: 'judgment', tick: 1, day: 0, culled: [], populationBefore: 2, populationAfter: 1 }];
  const loaded = fromJSON(JSON.stringify(legacy));
  for (const c of loaded.creatures) {
    assert.equal(c.customName, undefined);
    assert.equal(c.arkProtected, undefined);
    assert.equal(c.arkBy, undefined);
    assert.equal(displayName(c), c.name);
  }
  assert.deepEqual(loaded.culls[0].saved, [], 'an old cull record loads with an empty saved list');
});
