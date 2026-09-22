import { describe, expect, it } from 'vitest';
import { Engine } from './sim/engine.ts';
import { STARTER_NAME, STARTER_RPS, STARTER_TOPOLOGY } from './starter.ts';
import { actionsFor, incidentFor, observe } from './operator/contracts.ts';
import { matchRecordedRepair } from './operator/recordings.ts';

function advance(engine: Engine, seconds: number) {
  for (let tick = 0; tick < seconds * 60; tick++) engine.advance(1000 / 60);
}

describe('cached web app starter', () => {
  it.each([7, 87, 2026])(
    'serves baseline traffic through all three APIs at seed %s',
    (seed) => {
      const topology = structuredClone(STARTER_TOPOLOGY);
      const engine = new Engine(topology, seed);
      advance(engine, 7);
      expect(incidentFor(observe(topology, engine.snapshot()))).toBeNull();
      const before = engine.snapshot();
      const arrived = before.system.totalRequests;
      const completed = before.nodes.client!.totalCompleted;
      const failed = before.system.totalFailed;
      advance(engine, 30);
      const after = engine.snapshot();
      expect(after.system.totalFailed - failed).toBe(0);
      expect(
        (after.nodes.client!.totalCompleted - completed) /
          (after.system.totalRequests - arrived),
      ).toBeGreaterThan(0.97);
      for (const id of ['api1', 'api2', 'api3', 'cache', 'db']) {
        expect(after.nodes[id]!.totalCompleted).toBeGreaterThan(0);
      }
      expect(topology.nodes[0]!.config.rps).toBe(STARTER_RPS);
      expect(topology.nodes).toHaveLength(7);
      expect(STARTER_NAME).toBe('Cached web app');
    },
  );

  it('makes the shared database the bottleneck when demand doubles', () => {
    const topology = structuredClone(STARTER_TOPOLOGY);
    const engine = new Engine(topology, 87);
    advance(engine, 4);
    topology.nodes[0]!.config.rps *= 2;
    engine.updateNodeConfig('client', { rps: topology.nodes[0]!.config.rps });
    advance(engine, 3);
    const observation = observe(topology, engine.snapshot());
    expect(incidentFor(observation)).toMatchObject({
      kind: 'overload',
      nodeIds: ['db'],
    });
    expect(observation.nodes.find((node) => node.id === 'db')!.queued).toBeGreaterThan(
      6,
    );
    // Both actual capture attempts selected unsupported. Never create a fake
    // scaling recording merely because the simulation exposes legal options.
    expect(
      matchRecordedRepair(observation, actionsFor(observation, 'operator'), topology),
    ).toBeNull();
  });

  it.each(
    STARTER_TOPOLOGY.nodes
      .filter((node) => node.kind !== 'client')
      .flatMap((node) =>
        (['crash', 'slow'] as const).map((kind) => [node.id, kind] as const),
      ),
  )('replays a real %s %s repair', (nodeId, kind) => {
    const topology = structuredClone(STARTER_TOPOLOGY);
    const engine = new Engine(topology, 2026);
    advance(engine, 5);
    engine.injectFailure(nodeId, kind, kind === 'slow' ? { factor: 5 } : {});
    advance(engine, 3);
    const observation = observe(topology, engine.snapshot());
    const match = matchRecordedRepair(
      observation,
      actionsFor(observation, 'operator'),
      topology,
    );
    expect(match?.action).toMatchObject({ kind: 'repair', nodeId });
    engine.clearFailure(nodeId);
    advance(engine, 6);
    expect(engine.activeFailures()).toEqual([]);
    expect(engine.snapshot().system.errorRate).toBe(0);
    expect(incidentFor(observe(topology, engine.snapshot()))).toBeNull();
  });

  it('refuses a recording after the visitor edits a connection or node setting', () => {
    const topology = structuredClone(STARTER_TOPOLOGY);
    const engine = new Engine(topology, 87);
    engine.injectFailure('db', 'crash');
    advance(engine, 3);
    const observation = observe(topology, engine.snapshot());
    const choices = actionsFor(observation, 'operator');
    expect(matchRecordedRepair(observation, choices, topology)).not.toBeNull();
    topology.nodes.find((node) => node.id === 'cache')!.config.hitRate = 0.8;
    expect(matchRecordedRepair(observation, choices, topology)).toBeNull();
    topology.nodes.find((node) => node.id === 'cache')!.config.hitRate = 0.25;
    topology.edges.pop();
    expect(matchRecordedRepair(observation, choices, topology)).toBeNull();
  });
});
