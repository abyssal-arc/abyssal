export interface WorldConfig {
  width: number;
  height: number;
  initialPopulation: number;
  maxPopulation: number;
  /**
   * Harvests and judgment days are skipped at or below this floor, and the
   * tank reseeds from its emptiest niche when it falls under it. Zero switches
   * that life support off entirely, for scenarios that isolate a few creatures.
   */
  populationFloor: number;
  /** Share of the tank one archetype may hold before its niche counts as exhausted. */
  dominanceShare: number;
  /** Extra energy per tick paid by an exhausted niche at total monopoly. */
  dominanceCost: number;
  /** Cap on creatures seeded per tick, so regrowth drifts in instead of popping. */
  colonistsPerTick: number;
  initialFood: number;
  maxFood: number;
  /** Food points spawned per tick before chain-temperature modulation. */
  baseSpawnRate: number;
  foodEnergy: number;
  /** Energy cost per tick at full move strength (quadratic in strength). */
  moveCost: number;
  /** Flat metabolic cost per tick. */
  basalCost: number;
  maxSpeed: number;
  maxEnergy: number;
  eatRadius: number;
  eatUrgeThreshold: number;
  /** Ticks a predator must digest before it can kill again (0 = every tick). */
  huntCooldown: number;
  reproduceThreshold: number;
  reproduceCost: number;
  reproduceUrgeThreshold: number;
  mutationRate: number;
  mutationScale: number;
  /** Game-time ticks per in-game day (19200 = 24 game hours). */
  ticksPerDay: number;
  /** Ticks between judgment days (default 19200 = daily). */
  judgmentInterval: number;
  /** Fraction of the population culled on judgment day. */
  judgmentCullRatio: number;
  /** Ticks between harvests (default 800 = 1 game hour). */
  harvestInterval: number;
  /** Fraction of the population culled on harvest (may round to zero). */
  harvestCullRatio: number;
  creatureRadius: number;
}

export const DEFAULT_CONFIG: WorldConfig = {
  width: 1000,
  height: 1000,
  initialPopulation: 44,
  maxPopulation: 150,
  populationFloor: 15,
  dominanceShare: 0.8,
  dominanceCost: 0.05,
  colonistsPerTick: 3,
  initialFood: 140,
  maxFood: 260,
  baseSpawnRate: 0.22,
  foodEnergy: 30,
  moveCost: 0.05,
  basalCost: 0.02,
  maxSpeed: 4,
  maxEnergy: 200,
  eatRadius: 10,
  eatUrgeThreshold: 0.3,
  huntCooldown: 200,
  reproduceThreshold: 80,
  reproduceCost: 45,
  reproduceUrgeThreshold: 0.5,
  mutationRate: 0.08,
  mutationScale: 0.15,
  ticksPerDay: 19200,
  judgmentInterval: 19200,
  judgmentCullRatio: 0.1,
  harvestInterval: 800,
  harvestCullRatio: 0.02,
  creatureRadius: 4,
};
