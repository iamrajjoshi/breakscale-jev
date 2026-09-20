import { describe, expect, it } from 'vitest';
import type { Observation } from './contracts.ts';
import { madeRecoveryProgress } from './wait-policy.ts';

type System = Observation['system'];
const previous: System = {
  timeMs: 5000,
  offeredRps: 400,
  goodputRps: 100,
  errorRate: 0.29,
  p99: 500,
};
const later = (patch: Partial<System>): System => ({
  ...previous,
  timeMs: 10000,
  ...patch,
});

describe('progress while JEV waits', () => {
  it('does not mistake more elapsed time for recovery of a stationary fault', () => {
    const crashed = { ...previous, errorRate: 1, goodputRps: 0 };
    expect(madeRecoveryProgress(crashed, { ...crashed, timeMs: 20000 })).toBe(false);
  });

  it('rejects worsening errors and throughput', () => {
    expect(
      madeRecoveryProgress(previous, later({ errorRate: 0.5, goodputRps: 50 })),
    ).toBe(false);
  });

  it('accepts exactly one percentage point less error, including decimal roundoff', () => {
    expect(madeRecoveryProgress(previous, later({ errorRate: 0.28 }))).toBe(true);
  });

  it('rejects an error improvement just below one percentage point', () => {
    expect(madeRecoveryProgress(previous, later({ errorRate: 0.2800001 }))).toBe(false);
  });

  it('accepts throughput growth exactly equal to five percent of current demand', () => {
    expect(madeRecoveryProgress(previous, later({ goodputRps: 120 }))).toBe(true);
    expect(
      madeRecoveryProgress(
        { ...previous, goodputRps: 123.7 },
        later({ goodputRps: 143.7 }),
      ),
    ).toBe(true);
  });

  it('rejects throughput growth just below five percent of current demand', () => {
    expect(madeRecoveryProgress(previous, later({ goodputRps: 119.999 }))).toBe(false);
  });

  it('uses current demand rather than the earlier, smaller offered load', () => {
    expect(
      madeRecoveryProgress(previous, later({ offeredRps: 500, goodputRps: 124.9 })),
    ).toBe(false);
    expect(
      madeRecoveryProgress(previous, later({ offeredRps: 500, goodputRps: 125 })),
    ).toBe(true);
  });

  it('requires at least one additional successful request per second at low load', () => {
    const lowLoad = { ...previous, offeredRps: 10, goodputRps: 5 };
    expect(madeRecoveryProgress(lowLoad, { ...lowLoad, goodputRps: 5.99 })).toBe(false);
    expect(madeRecoveryProgress(lowLoad, { ...lowLoad, goodputRps: 6 })).toBe(true);
  });

  it('rejects improvement when offered traffic dropped by more than ten percent', () => {
    expect(
      madeRecoveryProgress(
        previous,
        later({ offeredRps: 359.99, errorRate: 0.01, goodputRps: 300 }),
      ),
    ).toBe(false);
  });

  it('allows meaningful recovery at exactly ten percent less offered traffic', () => {
    expect(
      madeRecoveryProgress(previous, later({ offeredRps: 360, errorRate: 0.2 })),
    ).toBe(true);
    expect(
      madeRecoveryProgress(
        { ...previous, offeredRps: 0.1 },
        later({ offeredRps: 0.09, errorRate: 0.2 }),
      ),
    ).toBe(true);
  });

  it('ignores small metric fluctuations and a lower latency alone', () => {
    expect(
      madeRecoveryProgress(
        previous,
        later({ errorRate: 0.288, goodputRps: 101.8, p99: 100 }),
      ),
    ).toBe(false);
  });

  it('accepts either meaningful signal independently', () => {
    expect(
      madeRecoveryProgress(previous, later({ errorRate: 0.2, goodputRps: 90 })),
    ).toBe(true);
    expect(
      madeRecoveryProgress(previous, later({ errorRate: 0.3, goodputRps: 125 })),
    ).toBe(true);
  });
});
