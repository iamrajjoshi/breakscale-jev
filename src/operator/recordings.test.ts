import { describe, expect, it } from 'vitest';
import { Engine } from '../sim/engine.ts';
import { PRESETS } from '../sim/presets.ts';
import type { NodeConfig, Topology } from '../sim/types.ts';
import {
  actionsFor,
  incidentFor,
  MODEL,
  observe,
  type Action,
  type Observation,
} from './contracts.ts';
import {
  matchRecordedRepair,
  RECORDED_SCENARIOS,
  REPAIR_RECORDINGS,
} from './recordings.ts';

function advance(engine: Engine, seconds: number) {
  for (let tick = 0; tick < seconds * 60; tick++) engine.advance(1000 / 60);
}
function apply(engine: Engine, topology: Topology, action: Action) {
  if (!('nodeId' in action)) throw new Error('A recording must change a component');
  if (action.kind === 'repair') return engine.clearFailure(action.nodeId);
  const patch: Partial<NodeConfig> | null =
    action.kind === 'capacity'
      ? { capacity: action.value }
      : action.kind === 'scale'
        ? { instances: action.value }
        : action.kind === 'service-time'
          ? { serviceMs: action.value }
          : action.kind === 'error-rate'
            ? { errorRate: action.value }
            : action.kind === 'retries'
              ? { retries: action.value }
              : null;
  if (!patch) throw new Error('A recording must be a finite repair');
  Object.assign(
    topology.nodes.find((node) => node.id === action.nodeId)!.config,
    patch,
  );
  engine.updateNodeConfig(action.nodeId, patch);
}
const crash = () =>
  structuredClone(
    REPAIR_RECORDINGS.find((recording) => recording.scenarioId === 'database-crash')!,
  );
const match = (state: Observation, topology: Topology) =>
  matchRecordedRepair(state, actionsFor(state, 'operator'), topology);

describe('recorded JEV provenance and closed choices', () => {
  it('contains genuine dated decisions, legal actions and complete distributions', () => {
    expect(REPAIR_RECORDINGS.length).toBeGreaterThanOrEqual(8);
    expect(new Set(REPAIR_RECORDINGS.map((recording) => recording.id)).size).toBe(
      REPAIR_RECORDINGS.length,
    );
    for (const recording of REPAIR_RECORDINGS) {
      expect(recording.model).toBe(MODEL);
      expect(Number.isFinite(Date.parse(recording.recordedAt))).toBe(true);
      const choices = actionsFor(recording.originalObservation, 'operator');
      expect(choices).toContainEqual(recording.originalAction);
      expect(Object.keys(recording.probabilities).sort()).toEqual(
        choices.map((action) => action.id).sort(),
      );
      expect(recording.confidence).toBeGreaterThanOrEqual(0);
      expect(recording.confidence).toBeLessThanOrEqual(1);
      let sum = 0;
      for (const probability of Object.values(recording.probabilities)) {
        expect(probability).toBeGreaterThanOrEqual(0);
        expect(probability).toBeLessThanOrEqual(
          recording.probabilities[recording.originalAction.id]!,
        );
        sum += probability;
      }
      expect(Math.abs(sum - 1)).toBeLessThanOrEqual(0.010000001);
      expect(recording.evidence.requestSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(recording.evidence.responseSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(
        RECORDED_SCENARIOS.some((scene) => scene.id === recording.scenarioId),
      ).toBe(true);
      expect(
        match(recording.originalObservation, recording.originalTopology)?.action,
      ).toEqual(recording.originalAction);
    }
  });

  it('matches the real starter and tolerates visual edits and current metrics', () => {
    const { originalObservation: state } = crash();
    const topology = structuredClone(PRESETS[0]!.topology);
    topology.nodes[2]!.label = 'My database';
    topology.nodes[2]!.x += 400;
    state.nodes[2]!.label = 'My database';
    state.nodes[2]!.errorRate = 0;
    state.nodes[2]!.p99 = 0;
    state.system.timeMs = 20;
    const result = match(state, topology);
    expect(result?.action.kind).toBe('repair');
    expect(result?.action.label).toContain('My database');
    expect(result?.recording.id).toBe('database-crash-1');
  });

  it('remaps node IDs by structure while preserving legal action identity', () => {
    const { originalTopology: topology, originalObservation: state } = crash();
    topology.nodes.forEach((node) => {
      node.id = `copy-${node.id}`;
    });
    topology.edges.forEach((edge) => {
      edge.id = `copy-${edge.id}`;
      edge.from = `copy-${edge.from}`;
      edge.to = `copy-${edge.to}`;
    });
    state.nodes.forEach((node) => {
      node.id = `copy-${node.id}`;
    });
    state.edges.forEach((edge) => {
      edge.from = `copy-${edge.from}`;
      edge.to = `copy-${edge.to}`;
    });
    expect(match(state, topology)?.action).toMatchObject({
      kind: 'repair',
      nodeId: 'copy-db',
    });
  });

  it('does not mutate inputs or invent a missing legal candidate', () => {
    const { originalTopology: topology, originalObservation: state } = crash();
    const saved = structuredClone({ topology, state });
    expect(matchRecordedRepair(state, [], topology)).toBeNull();
    const wrong: Action = {
      id: 'repair_2',
      kind: 'scale',
      nodeId: 'db',
      value: 256,
      label: 'Scale',
    };
    expect(matchRecordedRepair(state, [wrong], topology)).toBeNull();
    const bogus: Action = {
      id: 'unoffered',
      kind: 'repair',
      nodeId: 'db',
      label: 'Repair',
    };
    expect(matchRecordedRepair(state, [bogus], topology)).toBeNull();
    expect({ topology, state }).toEqual(saved);
  });
});

describe('unrecorded or changed systems', () => {
  it.each([
    [
      'client traffic',
      (topology: Topology) => {
        topology.nodes[0]!.config.rps = 333;
      },
    ],
    [
      'database write mix',
      (topology: Topology) => {
        topology.nodes[2]!.config.readFraction = 0.2;
      },
    ],
    [
      'request timeout',
      (topology: Topology) => {
        topology.nodes[0]!.config.timeoutMs = 20;
      },
    ],
    [
      'queue limit',
      (topology: Topology) => {
        topology.nodes[2]!.config.queueLimit = 1;
      },
    ],
    [
      'edge delay',
      (topology: Topology) => {
        topology.edges[0]!.latencyMs = 600;
      },
    ],
    [
      'edge weight',
      (topology: Topology) => {
        topology.edges[0]!.weight = 2;
      },
    ],
    [
      'extra component',
      (topology: Topology) => {
        topology.nodes.push({ ...structuredClone(topology.nodes[2]!), id: 'extra' });
      },
    ],
    [
      'missing connection',
      (topology: Topology) => {
        topology.edges.pop();
      },
    ],
  ])('rejects %s changes even when an old repair is offered', (_name, change) => {
    const { originalTopology: topology, originalObservation: state } = crash();
    change(topology);
    expect(match(state, topology)).toBeNull();
  });

  it('rejects fault changes and DB contention rather than replaying an unrelated fix', () => {
    const { originalTopology: topology, originalObservation: state } = crash();
    state.nodes[1]!.fault = 'slow';
    expect(match(state, topology)).toBeNull();
    state.nodes[1]!.fault = null;
    state.nodes[2]!.lockWaitMs = 40000;
    state.nodes[2]!.writeRate = 100;
    expect(match(state, topology)).toBeNull();
  });

  it('does not act when the current engine is healthy or target pressure disappeared', () => {
    const recording = structuredClone(
      REPAIR_RECORDINGS.find((item) => item.scenarioId === 'traffic-200')!,
    );
    const state = recording.originalObservation;
    for (const node of state.nodes) {
      node.queued = 0;
      node.utilization = 0.3;
      node.errorRate = 0;
    }
    state.system.errorRate = 0;
    state.system.goodputRps = state.system.offeredRps;
    expect(match(state, recording.originalTopology)).toBeNull();
    state.nodes[1]!.errorRate = 0.4;
    expect(incidentFor(state)).not.toBeNull();
    expect(match(state, recording.originalTopology)).toBeNull();
  });
});

describe('fresh upstream-engine replay', () => {
  for (const scene of RECORDED_SCENARIOS) {
    it.each([7, 87, 2026])(
      `${scene.title} settles at seed %s without changing demand`,
      (seed) => {
        const topology = structuredClone(scene.topology);
        const engine = new Engine(topology, seed);
        for (const failure of scene.failures ?? [])
          engine.injectFailure(failure.nodeId, failure.kind);
        advance(engine, 7);
        let applied = 0;
        for (let cycle = 0; cycle < 12; cycle++) {
          const state = observe(topology, engine.snapshot());
          const result = match(state, topology);
          if (result) {
            apply(engine, topology, result.action);
            applied++;
          }
          advance(engine, 3);
        }
        expect(applied).toBeGreaterThan(0);
        expect(engine.snapshot().activeFailures).toHaveLength(0);
        const start = engine.snapshot();
        const arrivedBefore = start.system.totalRequests;
        const failedBefore = start.system.totalFailed;
        const completedBefore = start.nodes.client!.totalCompleted;
        advance(engine, 30);
        const end = engine.snapshot();
        const arrivals = end.system.totalRequests - arrivedBefore;
        const failed = end.system.totalFailed - failedBefore;
        const completed = end.nodes.client!.totalCompleted - completedBefore;
        expect(failed / Math.max(1, failed + completed)).toBeLessThan(0.03);
        expect(completed / arrivals).toBeGreaterThan(0.85);
        expect(topology.nodes[0]!.config.rps).toBe(scene.rps);
      },
    );
  }
});
