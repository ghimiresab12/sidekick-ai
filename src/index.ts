/** Public entry point for the Sidekick session engine. */
export * from './contracts/types.js';
export { LIMITS, parseIsoTime } from './contracts/validate.js';
export { DEFAULT_ENGINE_CONFIG, SidekickEngine } from './engine.js';
export type { EngineOptions } from './engine.js';
export { SidekickCoordinator } from './coordinator/coordinator.js';
export type { CoordinatorOptions } from './coordinator/coordinator.js';
export {
  DEFAULT_SELECTION_LIMITS,
  REASONING_MAX_OBSERVATIONS,
  findSupersedingScreen,
  framesEquivalent,
  selectObservations,
  validateSelectionLimits,
} from './coordinator/select-observations.js';
export type { Selection, SelectionLimits } from './coordinator/select-observations.js';
export type * from './coordinator/ports.js';
