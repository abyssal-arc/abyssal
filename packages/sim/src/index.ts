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
  effectiveSpawnRate,
  txLanding,
  toJSON,
  fromJSON,
  WHALE_BOOM_SIZE,
} from './world.js';
export type {
  Creature,
  Food,
  Intervention,
  InterventionResult,
  TimedEffect,
  CullType,
  CullRecord,
  SimEvent,
  Senses,
  TickStats,
  TxMeteor,
  World,
} from './world.js';
