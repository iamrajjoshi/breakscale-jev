import { describe, expect, it } from 'vitest';
import { NODE_KINDS } from '../clipboard.ts';
import { Engine } from '../sim/engine.ts';
import { defaultConfig, PRESETS } from '../sim/presets.ts';
import type { NodeKind, SimNode, Topology } from '../sim/types.ts';
import { componentCatalog, configFieldsFor } from './catalog.ts';
import { compileEdit } from './compiler.ts';
import type { DesignEdit, DesignRequest } from './contracts.ts';
import {
  designTopology,
  validDesignRequest,
  validateDesignTopology,
} from './validation.ts';

const node = (kind: NodeKind, id: string, x = 0, y = 0): SimNode => ({
  id,
  kind,
  label: id,
  x,
  y,
  config: defaultConfig(kind),
});
const blank: Topology = { nodes: [], edges: [] };
const chain = (): Topology => ({
  nodes: [
    node('client', 'client', 0),
    node('service', 'api', 300),
    node('db', 'db', 600),
  ],
  edges: [
    { id: 'client-api', from: 'client', to: 'api', weight: 1 },
    { id: 'api-db', from: 'api', to: 'db', weight: 1 },
  ],
});
function run(topology: Topology, seconds = 5) {
  const engine = new Engine(topology, 7);
  for (let frame = 0; frame < seconds * 60; frame++) engine.advance(1000 / 60);
  return engine.snapshot();
}
function request(topology: Topology = chain()): DesignRequest {
  return {
    sessionId: '12345678-1234-1234-1234-123456789012',
    prompt: 'Add a cache before the database',
    topology: designTopology(topology),
    completed: [],
    selectedNodeId: null,
  };
}

describe('deterministic architecture compilation', () => {
  it.each(NODE_KINDS)(
    'creates %s with upstream defaults and advances the real engine',
    (kind) => {
      const result = compileEdit(blank, { op: 'add', kind, placement: 'unconnected' });
      expect(result.topology.nodes).toHaveLength(1);
      expect(result.topology.nodes[0].config).toEqual(defaultConfig(kind));
      expect(result).toEqual(
        compileEdit(blank, { op: 'add', kind, placement: 'unconnected' }),
      );
      const snapshot = run(result.topology, 0.2);
      expect(snapshot.system.timeMs).toBeCloseTo(200);
      expect(snapshot.nodes[result.selectedIds[0]]).toBeDefined();
      expect(blank).toEqual({ nodes: [], edges: [] });
    },
  );
  it('exposes every kind and the Inspector numeric controls', () => {
    expect(componentCatalog.map((item) => item.kind)).toEqual(NODE_KINDS);
    expect(componentCatalog.every((item) => item.label && item.description)).toBe(true);
    for (const kind of NODE_KINDS)
      expect(configFieldsFor(kind).length).toBeGreaterThan(0);
    expect(configFieldsFor('cache').some((field) => field.field === 'hitRate')).toBe(
      true,
    );
    expect(configFieldsFor('db').some((field) => field.field === 'hitRate')).toBe(
      false,
    );
  });
  it('avoids restored ID and rectangle collisions without moving existing nodes', () => {
    const first = compileEdit(blank, {
      op: 'add',
      kind: 'service',
      placement: 'unconnected',
    }).topology;
    const next = compileEdit(first, {
      op: 'add',
      kind: 'service',
      placement: 'unconnected',
    }).topology;
    expect(next.nodes[0]).toEqual(first.nodes[0]);
    expect(next.nodes[1].id).not.toBe(first.nodes[0].id);
    expect(
      Math.abs(next.nodes[0].x - next.nodes[1].x) >= 200 ||
        Math.abs(next.nodes[0].y - next.nodes[1].y) >= 104,
    ).toBe(true);
  });
  it('inserts into one region branch without changing branch order, weight or link flags', () => {
    const topology: Topology = {
      nodes: [
        node('region', 'region'),
        node('service', 'one', 400),
        node('service', 'two', 400, 150),
      ],
      edges: [
        {
          id: 'one',
          from: 'region',
          to: 'one',
          weight: 7,
          control: false,
          latencyMs: 12,
          bandwidthRps: 30,
          lossRate: 0.1,
        },
        { id: 'two', from: 'region', to: 'two', weight: 2 },
      ],
    };
    const next = compileEdit(topology, { op: 'insert', kind: 'cache', edgeId: 'one' });
    expect(
      next.topology.edges
        .filter((edge) => edge.from === 'region')
        .map((edge) => edge.to),
    ).toEqual([next.selectedIds[0], 'two']);
    expect(next.topology.edges[0]).toMatchObject({
      from: 'region',
      to: next.selectedIds[0],
      weight: 7,
      control: false,
      latencyMs: 12,
      bandwidthRps: 30,
      lossRate: 0.1,
    });
    expect(next.topology.edges[1]).toMatchObject({
      from: next.selectedIds[0],
      to: 'one',
      weight: 1,
    });
    expect(next.topology.edges[1].latencyMs).toBeUndefined();
    expect(topology.edges).toHaveLength(2);
  });
  it('runs requests through an inserted cache and reduces actual downstream arrivals', () => {
    const original = chain();
    const edited = compileEdit(original, {
      op: 'insert',
      kind: 'cache',
      edgeId: 'api-db',
    });
    const baseline = run(original),
      after = run(edited.topology);
    expect(after.nodes[edited.selectedIds[0]].totalCompleted).toBeGreaterThan(0);
    expect(after.nodes.db.arrivalRate).toBeLessThan(baseline.nodes.db.arrivalRate);
  });
  it('reroutes before/after traffic while retaining unrelated supervisory links', () => {
    const topology = chain();
    topology.nodes.push(node('autoscaler', 'controller'));
    topology.edges.push({
      id: 'control',
      from: 'controller',
      to: 'api',
      weight: 1,
      control: true,
    });
    const before = compileEdit(topology, {
      op: 'add',
      kind: 'breaker',
      placement: 'before',
      targetId: 'api',
    });
    expect(before.topology.edges.find((edge) => edge.id === 'client-api')?.to).toBe(
      before.selectedIds[0],
    );
    expect(before.topology.edges.find((edge) => edge.id === 'control')).toEqual(
      topology.edges[2],
    );
    const after = compileEdit(topology, {
      op: 'add',
      kind: 'cache',
      placement: 'after',
      targetId: 'api',
    });
    expect(after.topology.edges.find((edge) => edge.id === 'api-db')?.from).toBe(
      after.selectedIds[0],
    );
    expect(
      after.topology.edges.some(
        (edge) => edge.from === 'api' && edge.to === after.selectedIds[0],
      ),
    ).toBe(true);
  });
  it('creates a parallel sibling with matching traffic branches', () => {
    const result = compileEdit(chain(), {
      op: 'add',
      kind: 'service',
      placement: 'alongside',
      targetId: 'api',
    });
    const id = result.selectedIds[0];
    expect(result.topology.edges.map((edge) => [edge.from, edge.to])).toEqual([
      ['client', 'api'],
      ['api', 'db'],
      ['client', id],
      [id, 'db'],
    ]);
  });
  it('wires autoscalers only as one supervisory link to a scalable target', () => {
    const result = compileEdit(chain(), {
      op: 'add',
      kind: 'autoscaler',
      placement: 'alongside',
      targetId: 'api',
    });
    const id = result.selectedIds[0];
    expect(result.topology.edges.at(-1)).toMatchObject({
      from: id,
      to: 'api',
      control: true,
    });
    expect(run(result.topology).nodes[id].arrivalRate).toBe(0);
    expect(() =>
      compileEdit(result.topology, { op: 'connect', from: id, to: 'db' }),
    ).toThrow(/one scalable/);
    expect(() =>
      compileEdit(chain(), { op: 'insert', kind: 'autoscaler', edgeId: 'api-db' }),
    ).toThrow(/autoscalers alongside/);
    expect(() =>
      compileEdit(result.topology, {
        op: 'insert',
        kind: 'service',
        edgeId: result.topology.edges.at(-1)!.id,
      }),
    ).toThrow(/traffic connection/);
    expect(() =>
      compileEdit(result.topology, { op: 'connect', from: 'client', to: id }),
    ).toThrow(/cannot receive traffic/);
    expect(() =>
      compileEdit(chain(), {
        op: 'add',
        kind: 'autoscaler',
        placement: 'alongside',
        targetId: 'client',
      }),
    ).toThrow(/one scalable/);
  });
  it('connects a queue to a worker that drains actual buffered work', () => {
    let topology: Topology = {
      nodes: [
        node('client', 'client'),
        node('queue', 'queue', 300),
        node('worker', 'worker', 600),
      ],
      edges: [{ id: 'ingress', from: 'client', to: 'queue', weight: 1 }],
    };
    topology = compileEdit(topology, {
      op: 'connect',
      from: 'queue',
      to: 'worker',
    }).topology;
    expect(run(topology).nodes.worker.totalCompleted).toBeGreaterThan(0);
  });
  it('removes incident connections and preserves unrelated canvas notes', () => {
    const topology = chain();
    topology.annotations = [
      {
        id: 'note',
        kind: 'note',
        text: 'Private architecture note',
        x: 0,
        y: 0,
        width: 220,
        size: 'md',
      },
    ];
    const disconnected = compileEdit(topology, {
      op: 'disconnect',
      edgeId: 'api-db',
    }).topology;
    expect(disconnected.nodes).toHaveLength(3);
    expect(disconnected.edges).toHaveLength(1);
    const removed = compileEdit(topology, { op: 'remove', nodeId: 'api' }).topology;
    expect(removed.nodes.map((node) => node.id)).toEqual(['client', 'db']);
    expect(removed.edges).toEqual([]);
    expect(removed.annotations).toEqual(topology.annotations);
  });
  it('validates configuration bounds, kinds, steps and cross-field relationships', () => {
    const topology = chain();
    const edited = compileEdit(topology, {
      op: 'configure',
      nodeId: 'api',
      field: 'instances',
      value: 3,
    });
    expect(edited.topology.nodes[1].config.instances).toBe(3);
    expect(topology.nodes[1].config.instances).toBe(1);
    for (const edit of [
      { op: 'configure', nodeId: 'api', field: 'instances', value: 1.5 },
      { op: 'configure', nodeId: 'api', field: 'instances', value: 513 },
      { op: 'configure', nodeId: 'db', field: 'hitRate', value: 0.5 },
      { op: 'configure', nodeId: 'api', field: 'serviceMs', value: NaN },
      { op: 'configure', nodeId: 'api', field: 'instances', value: 1 },
    ] satisfies DesignEdit[])
      expect(() => compileEdit(topology, edit)).toThrow();
    const region: Topology = { nodes: [node('region', 'region')], edges: [] };
    expect(() =>
      compileEdit(region, {
        op: 'configure',
        nodeId: 'region',
        field: 'activeRegion',
        value: 7,
      }),
    ).toThrow(/region count/);
    const auto: Topology = { nodes: [node('autoscaler', 'auto')], edges: [] };
    expect(() =>
      compileEdit(auto, {
        op: 'configure',
        nodeId: 'auto',
        field: 'minCapacity',
        value: 512,
      }),
    ).toThrow(/Minimum instances/);
  });
  it('rejects invalid edits without mutating the input', () => {
    const topology = chain(),
      saved = structuredClone(topology);
    for (const edit of [
      { op: 'connect', from: 'api', to: 'api' },
      { op: 'connect', from: 'api', to: 'db' },
      { op: 'connect', from: 'missing', to: 'db' },
      { op: 'remove', nodeId: 'missing' },
      { op: 'insert', kind: 'cache', edgeId: 'missing' },
      { op: 'add', kind: 'unknown', placement: 'unconnected' },
      { op: 'add', kind: 'cache', placement: 'before' },
      { op: 'remove', nodeId: 'api', code: 'arbitrary code' },
    ]) {
      expect(() => compileEdit(topology, edit as DesignEdit)).toThrow();
      expect(topology).toEqual(saved);
    }
  });
  it('enforces 60 nodes and 180 edges on the resulting graph', () => {
    const full: Topology = {
      nodes: Array.from({ length: 60 }, (_, i) => node('service', `n${i}`, i * 232)),
      edges: [],
    };
    expect(() =>
      compileEdit(full, { op: 'add', kind: 'db', placement: 'unconnected' }),
    ).toThrow(/60 components/);
    const dense: Topology = {
      nodes: Array.from({ length: 15 }, (_, i) => node('service', `n${i}`)),
      edges: [],
    };
    for (const from of dense.nodes)
      for (const to of dense.nodes)
        if (from !== to && dense.edges.length < 180)
          dense.edges.push({
            id: `${from.id}-${to.id}`,
            from: from.id,
            to: to.id,
            weight: 1,
          });
    expect(() => compileEdit(dense, { op: 'connect', from: 'n14', to: 'n0' })).toThrow(
      /180 connections/,
    );
    expect(full.nodes).toHaveLength(60);
    expect(dense.edges).toHaveLength(180);
  });
});

describe('bounded design request', () => {
  it('accepts blank graphs and the four-edit finish request', () => {
    const value = request(blank);
    value.completed = ['one', 'two', 'three', 'four'];
    expect(validDesignRequest(value)).toBe(true);
    value.completed.push('five');
    expect(validDesignRequest(value)).toBe(false);
  });
  it('accepts all inherited example graphs after removing canvas-only annotations', () => {
    for (const preset of PRESETS) {
      expect(
        () => validateDesignTopology(designTopology(preset.topology)),
        preset.id,
      ).not.toThrow();
      expect(validDesignRequest(request(preset.topology)), preset.id).toBe(true);
    }
  });
  it('projects only graph fields and rejects private extras at each HTTP level', () => {
    const topology = chain();
    topology.annotations = [
      {
        id: 'note',
        kind: 'note',
        text: 'Do not send this',
        x: 0,
        y: 0,
        width: 220,
        size: 'md',
      },
    ];
    (topology.nodes[0] as unknown as Record<string, unknown>).secret = 'private';
    (topology.nodes[0].config as unknown as Record<string, unknown>).secret = 'private';
    expect(JSON.stringify(designTopology(topology))).not.toMatch(
      /secret|private|Do not send/,
    );
    for (const change of [
      (r: Record<string, unknown>) => {
        r.secret = 'private';
      },
      (r: Record<string, unknown>) => {
        (r.topology as Topology).annotations = topology.annotations;
      },
      (r: Record<string, unknown>) => {
        (
          (r.topology as Topology).nodes[0] as unknown as Record<string, unknown>
        ).secret = 'private';
      },
      (r: Record<string, unknown>) => {
        (
          (r.topology as Topology).nodes[0].config as unknown as Record<string, unknown>
        ).secret = 'private';
      },
      (r: Record<string, unknown>) => {
        r.selectedNodeId = 'missing';
      },
      (r: Record<string, unknown>) => {
        r.prompt = 'a'.repeat(601);
      },
    ]) {
      const value = request();
      change(value as unknown as Record<string, unknown>);
      expect(validDesignRequest(value)).toBe(false);
    }
  });
  it('rejects malformed graph numbers, duplicate edges and unsupported fields', () => {
    for (const change of [
      (t: Topology) => {
        t.nodes[0].x = Infinity;
      },
      (t: Topology) => {
        t.nodes[0].config.rps = -1;
      },
      (t: Topology) => {
        t.nodes[0].config.instances = 1.5;
      },
      (t: Topology) => {
        t.edges.push({ ...t.edges[0], id: 'different-id' });
      },
      (t: Topology) => {
        t.edges[0].control = 'yes' as unknown as boolean;
      },
      (t: Topology) => {
        t.edges[0].lossRate = 2;
      },
    ]) {
      const value = request();
      change(value.topology);
      expect(validDesignRequest(value)).toBe(false);
    }
  });
});
