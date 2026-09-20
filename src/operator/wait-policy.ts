import type { Observation } from './contracts.ts';

export const MAX_STALLED_WAITS = 3;

/** A wait earns another observation only when recovery beats ordinary metric noise. */
export function madeRecoveryProgress(
  previous: Observation['system'],
  current: Observation['system'],
): boolean {
  const demandTolerance = Number.EPSILON * previous.offeredRps;
  if (current.offeredRps + demandTolerance < previous.offeredRps * 0.9) return false;
  // Rates are fractions; tolerate only floating-point subtraction at exactly 1pp.
  const errorsImproved =
    previous.errorRate - current.errorRate >= 0.01 - Number.EPSILON;
  const goodputImproved =
    current.goodputRps >= previous.goodputRps + Math.max(1, current.offeredRps * 0.05);
  return errorsImproved || goodputImproved;
}
