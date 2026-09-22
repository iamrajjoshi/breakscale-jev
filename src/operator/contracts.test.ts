import { describe, expect, it } from 'vitest';
import { Engine } from '../sim/engine.ts';
import { defaultConfig, makeNode, PRESETS } from '../sim/presets.ts';
import type { NodeConfig, Topology } from '../sim/types.ts';
import {
  actionsFor,
  decisionFingerprint,
  hasWriteContention,
  incidentFor,
  MAX_REPAIR_CAPACITY,
  MAX_REPAIR_INSTANCES,
  observe,
  validRequest,
  type Action,
} from './contracts.ts';
const topology = PRESETS[0]!.topology;
function world() {
  const engine = new Engine(topology);
  return { engine, state: observe(topology, engine.snapshot()) };
}
describe('bounded JEV controls', () => {
  it('produces a valid observation from the real engine', () => {
    const { state } = world();
    expect(
      validRequest({
        sessionId: '00000000-0000-4000-8000-000000000000',
        prompt: 'Fix the database',
        mode: 'command',
        observation: state,
      }),
    ).toBe(true);
  });
  it.each(PRESETS)('can observe the $id example without widening the API', (preset) => {
    const engine = new Engine(preset.topology);
    engine.advance(1000);
    expect(
      validRequest({
        sessionId: '00000000-0000-4000-8000-000000000000',
        prompt: 'Keep it healthy',
        mode: 'operator',
        observation: observe(preset.topology, engine.snapshot()),
      }),
    ).toBe(true);
  });
  it('never lets the automatic operator inject faults or reduce demand', () => {
    const { state } = world();
    state.nodes.forEach((node) => (node.utilization = 1));
    const actions = actionsFor(state, 'operator');
    expect(actions.length).toBeGreaterThan(1);
    expect(actions.some((a) => ['crash', 'slow', 'traffic'].includes(a.kind))).toBe(
      false,
    );
    expect(actions.filter((a) => a.kind === 'scale').every((a) => a.value === 2)).toBe(
      true,
    );
  });
  it('offers actual fault repair and restores throughput through the unchanged engine', () => {
    const { engine } = world();
    const db = topology.nodes.find((node) => node.kind === 'db')!;
    engine.injectFailure(db.id, 'crash');
    engine.advance(10000);
    const broken = engine.snapshot();
    const actions = actionsFor(observe(topology, broken), 'operator');
    expect(
      actions.find((a) => a.kind === 'repair' && a.nodeId === db.id),
    ).toBeDefined();
    engine.clearFailure(db.id);
    engine.advance(20000);
    expect(engine.snapshot().activeFailures).toHaveLength(0);
    expect(engine.snapshot().system.goodputRps).toBeGreaterThan(
      broken.system.goodputRps,
    );
  });
  it('bounds capacity, calculates traffic in code, and omits unavailable repairs', () => {
    const { state } = world();
    state.nodes.forEach((node) => (node.instances = MAX_REPAIR_INSTANCES));
    const actions = actionsFor(state, 'command');
    expect(actions.some((a) => a.kind === 'scale' || a.kind === 'repair')).toBe(false);
    expect(actions.find((a) => a.id === 'traffic_up')).toMatchObject({ value: 100 });
    expect(new Set(actions.map((a) => a.id)).size).toBe(actions.length);
  });
  it('observes live engine scaling instead of the earlier authored fleet', () => {
    const { engine } = world();
    const target = topology.nodes.find((node) => node.kind === 'service')!;
    engine.setScale(target.id, 16);
    const state = observe(topology, engine.snapshot());
    const observed = state.nodes.find((node) => node.id === target.id)!;
    observed.utilization = 1;
    expect(observed.instances).toBe(16);
    expect(
      actionsFor(state, 'operator').find(
        (action) => action.kind === 'scale' && action.nodeId === target.id,
      ),
    ).toMatchObject({ value: 32 });
  });
  it('does not resize idle nodes, exceed bounds, or invent fleets for buffers', () => {
    const { state } = world();
    state.nodes.forEach((node) => {
      node.instances = MAX_REPAIR_INSTANCES;
      node.capacity = MAX_REPAIR_CAPACITY;
      node.utilization = 1;
    });
    expect(
      actionsFor(state, 'operator').some((action) =>
        ['scale', 'capacity'].includes(action.kind),
      ),
    ).toBe(false);
    const idle = world().state;
    expect(actionsFor(idle, 'operator').map((action) => action.kind)).toEqual([
      'wait',
      'unsupported',
    ]);
    idle.nodes[1]!.kind = 'queue';
    idle.nodes[1]!.queued = 500;
    expect(
      actionsFor(idle, 'operator').some((action) =>
        ['scale', 'capacity'].includes(action.kind),
      ),
    ).toBe(false);
  });
  it.each([
    [0, undefined, undefined],
    [0.5, 1, undefined],
    [1, 2, undefined],
    [2, 4, 1],
    [6000, 10000, 3000],
    [10000, undefined, 5000],
    [20000, undefined, 10000],
  ] as const)(
    'offers only traffic commands that move demand in the named direction at %s rps',
    (rps, up, down) => {
      const { state } = world();
      const clients = state.nodes.filter((node) => node.kind === 'client');
      clients.forEach((node) => (node.rps = rps / clients.length));
      const actions = actionsFor(state, 'command').filter(
        (action) => action.kind === 'traffic',
      );
      expect(actions.find((action) => action.id === 'traffic_up')?.value).toBe(up);
      expect(actions.find((action) => action.id === 'traffic_down')?.value).toBe(down);
    },
  );
  it('invalidates edits and injected faults, while allowing metrics to advance', () => {
    const { engine } = world();
    const first = decisionFingerprint(topology, engine.snapshot());
    engine.advance(1000);
    expect(decisionFingerprint(topology, engine.snapshot())).toBe(first);
    engine.injectFailure(topology.nodes.at(-1)!.id, 'slow');
    expect(decisionFingerprint(topology, engine.snapshot())).not.toBe(first);
    engine.reset();
    const changed = structuredClone(topology);
    changed.nodes[0]!.config.rps *= 2;
    expect(decisionFingerprint(changed, engine.snapshot())).not.toBe(first);
  });
  it('rejects malformed, oversized and non-finite observations', () => {
    const { state } = world();
    const input = {
      sessionId: '00000000-0000-4000-8000-000000000000',
      prompt: 'repair',
      mode: 'command',
      observation: state,
    };
    expect(validRequest({ ...input, prompt: ' '.repeat(3) })).toBe(false);
    expect(validRequest({ ...input, prompt: 'x'.repeat(601) })).toBe(false);
    expect(validRequest({ ...input, mode: 'execute' })).toBe(false);
    const duplicate = structuredClone(input);
    duplicate.observation.nodes.push(duplicate.observation.nodes[0]!);
    expect(validRequest(duplicate)).toBe(false);
    state.nodes[0]!.p99 = Number.NaN;
    expect(validRequest(input)).toBe(false);
    state.nodes[0]!.p99 = 0;
    state.edges.push({ from: 'missing', to: state.nodes[0]!.id });
    expect(validRequest(input)).toBe(false);
  });
  it('distinguishes authored error probability from measured errors and old observations', () => {
    const { state } = world();
    const target = state.nodes.find((node) => node.kind === 'service')!;
    expect(target.configuredErrorRate).toBe(0);
    target.errorRate = 0.5;
    expect(actionsFor(state, 'operator').some((a) => a.kind === 'error-rate')).toBe(
      false,
    );
    delete target.configuredErrorRate;
    const request = {
      sessionId: '00000000-0000-4000-8000-000000000000',
      prompt: 'Keep it healthy',
      mode: 'operator',
      observation: state,
    };
    expect(validRequest(request)).toBe(true);
    expect(actionsFor(state, 'operator').some((a) => a.kind === 'error-rate')).toBe(
      false,
    );
    for (const rate of [-0.1, 1.01, Number.NaN, Number.POSITIVE_INFINITY]) {
      target.configuredErrorRate = rate;
      expect(validRequest(request)).toBe(false);
    }
    target.configuredErrorRate = 0.5;
    expect(validRequest(request)).toBe(true);
    expect(
      actionsFor(state, 'operator').find((a) => a.kind === 'error-rate'),
    ).toMatchObject({
      nodeId: target.id,
      value: 0,
    });
    target.errorRate = 0;
    expect(actionsFor(state, 'operator').some((a) => a.kind === 'error-rate')).toBe(
      false,
    );
    target.errorRate = 0.5;
    target.kind = 'queue';
    expect(actionsFor(state, 'operator').some((a) => a.kind === 'error-rate')).toBe(
      false,
    );
  });
});

describe('observed database write contention', () => {
  it('exposes real engine contention and removes ineffective automatic fleet and slot growth', () => {
    const design = structuredClone(topology);
    design.nodes.find((node) => node.kind === 'client')!.config.rps = 1000;
    design.nodes.find((node) => node.kind === 'service')!.config.instances = 16;
    const database = design.nodes.find((node) => node.kind === 'db')!;
    Object.assign(database.config, { instances: 8, capacity: 32, readFraction: 0.5 });
    const engine = new Engine(design, 87);
    for (let tick = 0; tick < 200; tick++) engine.advance(100);
    const snapshot = engine.snapshot();
    const observation = observe(design, snapshot);
    const databaseObservation = observation.nodes.find(
      (node) => node.id === database.id,
    )!;
    expect(databaseObservation.lockMs).toBe(database.config.lockMs);
    expect(databaseObservation.lockWaitMs).toBe(
      snapshot.nodes[database.id]!.lockWaitMs,
    );
    expect(databaseObservation.writeRate).toBeGreaterThan(0);
    expect(databaseObservation.lockWaitMs).toBeGreaterThan(
      databaseObservation.serviceMs,
    );
    expect(hasWriteContention(databaseObservation)).toBe(true);
    expect(
      observation.nodes.find((node) => node.kind === 'service')!.lockMs,
    ).toBeUndefined();
    const affectsDbCapacity = (action: Action) =>
      (action.kind === 'scale' || action.kind === 'capacity') &&
      action.nodeId === database.id;
    expect(actionsFor(observation, 'operator').filter(affectsDbCapacity)).toHaveLength(
      0,
    );
    expect(actionsFor(observation, 'command').filter(affectsDbCapacity)).toHaveLength(
      2,
    );
    expect(
      actionsFor(observation, 'operator').find(
        (action) => action.kind === 'unsupported',
      ),
    ).toBeDefined();
    expect(database.config.lockMs).toBe(15);
    expect(database.config.readFraction).toBe(0.5);
    expect(design.nodes.find((node) => node.kind === 'client')!.config.rps).toBe(1000);
  });

  it('requires positive measured writes and lock delay above ordinary service cost', () => {
    const database = world().state.nodes.find((node) => node.kind === 'db')!;
    delete database.lockWaitMs;
    delete database.writeRate;
    expect(hasWriteContention(database)).toBe(false);
    database.lockWaitMs = database.serviceMs;
    database.writeRate = 100;
    expect(hasWriteContention(database)).toBe(false);
    database.lockWaitMs += 1;
    expect(hasWriteContention(database)).toBe(true);
    database.writeRate = 0;
    expect(hasWriteContention(database)).toBe(false);
    database.writeRate = 100;
    database.kind = 'service';
    expect(hasWriteContention(database)).toBe(false);
  });

  it('validates optional contention evidence and bounded prior-wait context', () => {
    const { state } = world();
    const request = {
      sessionId: '00000000-0000-4000-8000-000000000000',
      mode: 'operator',
      prompt: 'Restore useful throughput',
      observation: state,
    };
    expect(validRequest(request)).toBe(true);
    for (const consecutiveWaits of [0, 1, 2, 3])
      expect(
        validRequest({
          ...request,
          recovery: { consecutiveWaits, previousWait: state.system },
        }),
      ).toBe(true);
    for (const consecutiveWaits of [
      -1,
      4,
      0.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      '1',
      null,
    ])
      expect(validRequest({ ...request, recovery: { consecutiveWaits } })).toBe(false);
    expect(validRequest({ ...request, recovery: null })).toBe(false);
    expect(
      validRequest({ ...request, recovery: { consecutiveWaits: 1, previousWait: {} } }),
    ).toBe(false);
    for (const badMetric of [
      { errorRate: 1.01 },
      { goodputRps: -1 },
      { p99: Number.NaN },
    ])
      expect(
        validRequest({
          ...request,
          recovery: {
            consecutiveWaits: 1,
            previousWait: { ...state.system, ...badMetric },
          },
        }),
      ).toBe(false);
    const database = state.nodes.find((node) => node.kind === 'db')!;
    for (const field of ['lockMs', 'lockWaitMs', 'writeRate'] as const) {
      delete database[field];
      expect(validRequest(request)).toBe(true);
      for (const value of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
        database[field] = value;
        expect(validRequest(request)).toBe(false);
      }
      database[field] = 0;
      expect(validRequest(request)).toBe(true);
    }
  });
});

describe('automatic incident detection', () => {
  it('detects severe shared write locks even when reads keep errors and slot usage low', () => {
    const design = structuredClone(topology);
    design.nodes.find((node) => node.kind === 'client')!.config.rps = 1000;
    Object.assign(design.nodes.find((node) => node.kind === 'service')!.config, {
      instances: 128,
      capacity: 512,
    });
    const database = design.nodes.find((node) => node.kind === 'db')!;
    Object.assign(database.config, {
      instances: 128,
      capacity: 512,
      readFraction: 0.98,
      lockMs: 100,
    });
    const engine = new Engine(design, 87);
    for (let tick = 0; tick < 600; tick++) engine.advance(100);
    const state = observe(design, engine.snapshot());
    const observedDatabase = state.nodes.find((node) => node.id === database.id)!;
    expect(observedDatabase.lockWaitMs).toBeGreaterThan(40000);
    expect(observedDatabase.writeRate).toBeGreaterThan(0);
    expect(state.system.errorRate).toBeLessThan(0.03);
    for (const node of state.nodes) {
      expect(node.errorRate).toBeLessThan(0.03);
      expect(node.queued).toBe(0);
      expect(node.utilization).toBeLessThan(0.9);
    }
    expect(incidentFor(state)).toEqual({
      kind: 'overload',
      nodeIds: [database.id],
      summary: 'Writes are waiting on shared locks at Database',
    });
    expect(actionsFor(state, 'operator').map((action) => action.kind)).toEqual([
      'wait',
      'unsupported',
    ]);
    expect(database.config.lockMs).toBe(100);
    expect(design.nodes.find((node) => node.kind === 'client')!.config.rps).toBe(1000);
  });

  it('requires at least one second of active write contention above service time after warmup', () => {
    const { state } = world();
    const database = state.nodes.find((node) => node.kind === 'db')!;
    state.system.timeMs = 2000;
    database.writeRate = 10;
    database.lockWaitMs = 999;
    expect(incidentFor(state)).toBeNull();
    database.lockWaitMs = 1000;
    expect(incidentFor(state)).toMatchObject({ kind: 'overload' });
    database.writeRate = 0;
    expect(incidentFor(state)).toBeNull();
    database.writeRate = 10;
    database.serviceMs = 1000;
    expect(incidentFor(state)).toBeNull();
    database.serviceMs = 30;
    database.kind = 'service';
    expect(incidentFor(state)).toBeNull();
    database.kind = 'db';
    state.system.timeMs = 1999;
    expect(incidentFor(state)).toBeNull();
  });

  it('does not call healthy systems or interpret normal latency as damage', () => {
    const { engine } = world();
    engine.advance(20000);
    const state = observe(topology, engine.snapshot());
    expect(incidentFor(state)).toBeNull();
    state.system.p99 = 30000;
    state.nodes.forEach((node) => (node.p99 = 30000));
    expect(incidentFor(state)).toBeNull();
  });
  it('waits for warmup except for explicit faults, and prioritizes fault evidence', () => {
    const { state } = world();
    state.system.errorRate = 1;
    state.nodes[1]!.queued = 1000;
    expect(incidentFor(state)).toBeNull();
    state.nodes[1]!.fault = 'slow';
    expect(incidentFor(state)).toMatchObject({ kind: 'fault' });
    state.nodes[1]!.fault = null;
    state.system.timeMs = 2000;
    expect(incidentFor(state)).toMatchObject({ kind: 'overload' });
    state.nodes[1]!.queued = 0;
    expect(incidentFor(state)).toMatchObject({ kind: 'errors' });
  });
  it('does not treat high utilization alone as an incident', () => {
    const { state } = world();
    state.system = {
      timeMs: 30000,
      offeredRps: 100,
      goodputRps: 100,
      errorRate: 0,
      p99: 50,
    };
    state.nodes[1]!.utilization = 0.95;
    expect(incidentFor(state)).toBeNull();
    state.system.goodputRps = 30;
    expect(incidentFor(state)).toMatchObject({ kind: 'overload' });
  });
});

function repairWorld(config: Partial<NodeConfig>, rps: number) {
  const client = { ...makeNode('client', 0, 0), id: 'client' };
  client.config.rps = rps;
  client.config.timeoutMs = 1000;
  const service = { ...makeNode('service', 200, 0), id: 'service' };
  service.config = { ...service.config, ...config, serviceCv: 0 };
  const design: Topology = {
    nodes: [client, service],
    edges: [{ id: 'request', from: 'client', to: 'service', weight: 1 }],
  };
  const engine = new Engine(design, 42);
  const advance = (seconds = 20) => {
    for (let tick = 0; tick < seconds * 10; tick++) engine.advance(100);
  };
  const apply = (action: Action) => {
    if (!('nodeId' in action)) throw new Error('Expected a node repair');
    if (action.kind === 'repair') engine.clearFailure(action.nodeId);
    else {
      const patch =
        action.kind === 'scale'
          ? { instances: action.value }
          : action.kind === 'capacity'
            ? { capacity: action.value }
            : action.kind === 'service-time'
              ? { serviceMs: action.value }
              : action.kind === 'error-rate'
                ? { errorRate: action.value }
                : null;
      if (!patch) throw new Error('Expected a capacity or latency repair');
      engine.updateNodeConfig(action.nodeId, patch);
      Object.assign(service.config, patch);
    }
    advance();
  };
  const observation = () => observe(design, engine.snapshot());
  return { engine, client, service, advance, apply, observation };
}

describe('recovery actions against the unchanged event engine', () => {
  it('restores a 50% configured failure probability without changing demand or fleet size', () => {
    const world = repairWorld({ errorRate: 0.5 }, 150);
    world.advance();
    const broken = world.observation();
    expect(incidentFor(broken)?.kind).toBe('errors');
    expect(broken.system.errorRate).toBeGreaterThan(0.35);
    expect(
      broken.nodes.find((node) => node.id === 'service')?.configuredErrorRate,
    ).toBe(0.5);
    const repair = actionsFor(broken, 'operator').find(
      (action) => action.kind === 'error-rate',
    );
    expect(repair).toMatchObject({ nodeId: 'service', value: 0 });
    world.apply(repair!);
    const healed = world.observation();
    expect(healed.system.errorRate).toBeLessThan(0.01);
    expect(healed.system.goodputRps).toBeGreaterThan(broken.system.goodputRps * 1.5);
    expect(incidentFor(healed)).toBeNull();
    expect(world.client.config.rps).toBe(150);
    expect(world.service.config.instances).toBe(1);
    expect(world.service.config.errorRate).toBe(defaultConfig('service').errorRate);
  });
  it('recovers a sustained 400rps surge using bounded scale steps without lowering demand', () => {
    const world = repairWorld({ capacity: 2, serviceMs: 40 }, 20);
    world.advance();
    expect(incidentFor(world.observation())).toBeNull();
    world.client.config.rps = 400;
    world.engine.updateNodeConfig('client', { rps: 400 });
    world.advance();
    const broken = world.observation();
    expect(incidentFor(broken)).not.toBeNull();
    expect(broken.system.errorRate).toBeGreaterThan(0.5);
    for (let attempt = 0; attempt < 5 && incidentFor(world.observation()); attempt++) {
      const scale = actionsFor(world.observation(), 'operator').find(
        (action) => action.kind === 'scale' && action.nodeId === 'service',
      );
      expect(scale).toBeDefined();
      world.apply(scale!);
    }
    const healed = world.observation();
    expect(healed.system.goodputRps).toBeGreaterThan(360);
    expect(healed.system.errorRate).toBeLessThan(0.01);
    expect(incidentFor(healed)).toBeNull();
    expect(world.client.config.rps).toBe(400);
    expect(world.service.config.instances).toBeGreaterThan(8);
    expect(world.service.config.instances).toBeLessThanOrEqual(MAX_REPAIR_INSTANCES);
  });
  it.each([
    { name: 'capacity', config: { capacity: 1 }, kind: 'capacity' },
    { name: 'service time', config: { serviceMs: 500 }, kind: 'service-time' },
  ])(
    'repairs destructive $name settings with observable throughput recovery',
    ({ config, kind }) => {
      const world = repairWorld(config, 150);
      world.advance();
      const broken = world.observation();
      expect(incidentFor(broken)).not.toBeNull();
      const repair = actionsFor(broken, 'operator').find(
        (action) =>
          action.kind === kind && 'nodeId' in action && action.nodeId === 'service',
      );
      expect(repair).toBeDefined();
      world.apply(repair!);
      const healed = world.observation();
      expect(healed.system.goodputRps).toBeGreaterThan(broken.system.goodputRps * 2);
      expect(healed.system.errorRate).toBeLessThan(0.01);
      expect(world.client.config.rps).toBe(150);
      if (kind === 'service-time')
        expect(world.service.config.serviceMs).toBe(defaultConfig('service').serviceMs);
    },
  );
  it.each(['crash', 'slow', 'errors', 'partition'] as const)(
    'clears a real %s fault and recovers the same traffic',
    (fault) => {
      const world = repairWorld({ capacity: 4, serviceMs: 30 }, 80);
      world.engine.injectFailure('service', fault);
      world.advance();
      const broken = world.observation();
      expect(incidentFor(broken)?.kind).toBe('fault');
      const repair = actionsFor(broken, 'operator').find(
        (action) => action.kind === 'repair',
      );
      expect(repair).toBeDefined();
      world.apply(repair!);
      expect(world.engine.snapshot().activeFailures).toHaveLength(0);
      expect(world.observation().system.errorRate).toBeLessThan(0.01);
      expect(world.client.config.rps).toBe(80);
    },
  );
});
