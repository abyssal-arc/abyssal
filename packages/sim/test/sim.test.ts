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
  DEFAULT_CONFIG,
  archetypeOf,
  dominantTax,
  isHungry,
  steerArchetype,
  randomGenome,
  type Senses,
  type WorldConfig,
  type Archetype,
  type Creature,
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

test('money is weather: payments and tx rain never rewrite a living genome', () => {
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

  // Survivors keep exactly the genome they were born with: money may move
  // food around and cull the weak, but it must never edit an individual.
  // Creatures born inside the window are skipped, mutation at birth is the
  // only place a genome is allowed to change.
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
    tick(world, { chain: 0.5, market: 0 }, i === 0 ? [{ hash, size: 1, at: { x: 200, y: 700 } }] : []);
  }
  assert.ok(world.eaters[hash]?.includes(c.id), 'the meteor trail must name its eater');
  assert.equal(world.eaters[hash].length, 1, 'one bite is logged once');
  const survivor = world.creatures.find((x) => x.id === c.id);
  assert.ok(survivor && survivor.maxMeal > 0, 'the biggest meal is remembered');
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
