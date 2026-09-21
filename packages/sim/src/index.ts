export { Rng } from './prng.js';
export {
  INPUT_SIZE,
  HIDDEN_SIZE,
  OUTPUT_SIZE,
  ARCHETYPES,
  ARCHETYPE_LIST,
  archetypeOf,
  creatureName,
  randomGenome,
  cloneGenome,
  mutateGenome,
  forward,
  genomeFingerprint,
  steerArchetype,
} from './genome.js';
export type { Genome, BrainOutput, Archetype, ArchetypeTraits } from './genome.js';
export { DEFAULT_CONFIG } from './types.js';
export type { WorldConfig } from './types.js';
export {
  createWorld,
  tick,
  applyIntervention,
  idsInZone,
  effectiveSpawnRate,
  txLanding,
  toJSON,
  fromJSON,
  WHALE_BOOM_SIZE,
  isHungry,
  dominantTax,
} from './world.js';
export type {
  Creature,
  Food,
  Intervention,
  InterventionResult,
  Obituary,
  TimedEffect,
  CullType,
  CullRecord,
  SimEvent,
  Senses,
  TickStats,
  TxMeteor,
  World,
} from './world.js';
