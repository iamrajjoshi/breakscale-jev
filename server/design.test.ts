import { describe, expect, it } from 'vitest';
import { componentCatalog, configFieldsFor } from '../src/designer/catalog.ts';
import type { DesignRequest } from '../src/designer/contracts.ts';
import { MODEL } from '../src/operator/contracts.ts';
import { defaultConfig } from '../src/sim/presets.ts';
import type { NodeKind, SimNode } from '../src/sim/types.ts';
import {
  chooseDesignStep,
  extractNumbers,
  normalizedValue,
  parseDesignDecision,
} from './design.ts';

const node = (id: string, kind: NodeKind): SimNode => ({
  id,
  kind,
  label: id,
  x: 0,
  y: 0,
  config: defaultConfig(kind),
});
function request(prompt = 'Put a cache before Database'): DesignRequest {
  return {
    sessionId: 'bd6f3200-3295-4873-9bc8-71f6a5d83c00',
    prompt,
    completed: [],
    selectedNodeId: null,
    topology: {
      nodes: [node('API', 'service'), node('Database', 'db')],
      edges: [{ id: 'traffic', from: 'API', to: 'Database', weight: 1 }],
    },
  };
}
type Payload = {
  model: string;
  state: Record<string, unknown>;
  questions: Record<string, { criteria: Record<string, string> }>;
};
function response(payload: Payload, choices: Record<string, string>) {
  return {
    model: MODEL,
    usage: { input_tokens: 321, output_tokens: 87 },
    answers: Object.fromEntries(
      Object.entries(payload.questions).map(([name, question]) => {
        const choice = choices[name] ?? 'none';
        return [
          name,
          {
            type: 'choice',
            choice,
            confidence: 1,
            probabilities: Object.fromEntries(
              Object.keys(question.criteria).map((key) => [
                key,
                key === choice ? 1 : 0,
              ]),
            ),
          },
        ];
      }),
    ),
  };
}
async function decide(input: DesignRequest, choices: Record<string, string>) {
  let payload!: Payload;
  let answer!: ReturnType<typeof response>;
  const decision = await chooseDesignStep(
    'mock-secret',
    input,
    new AbortController().signal,
    17,
    async (url, init) => {
      expect(url).toBe('https://api.typesafe.ai/v1/systemone');
      payload = JSON.parse(String(init?.body));
      answer = response(payload, choices);
      return Response.json(answer);
    },
  );
  return { decision, payload, answer };
}

describe('grounded numeric configuration', () => {
  it('extracts exact spans and units without matching digits inside names or scientific notation', () => {
    const prompt =
      'Set DB2 to 12 instances, a 40ms service time, 2s timeout, 25% errors; DB_7 and 1e3 are not plain values.';
    const values = extractNumbers(prompt);
    expect(values.map(({ value, unit }) => [value, unit])).toEqual([
      [12, 'plain'],
      [40, 'ms'],
      [2, 'seconds'],
      [25, 'percent'],
    ]);
    for (const value of values)
      expect(prompt.slice(value.start, value.end)).toBe(value.text);
    expect(
      extractNumbers('1,200 requests and .5 seconds then -2 retries').map(
        ({ value }) => value,
      ),
    ).toEqual([1200, 0.5, -2]);
    expect(() =>
      extractNumbers(Array.from({ length: 33 }, (_, i) => String(i)).join(' ')),
    ).toThrow('Too many');
  });
  it('normalizes explicit vector counts into the index-size field’s stored thousands', async () => {
    const input = request('Set index size to 100000 vectors');
    input.topology.nodes[1] = node('Vectors', 'vectordb');
    input.topology.edges[0].to = 'Vectors';
    const field = configFieldsFor('vectordb').find(
      (item) => item.field === 'indexSizeK',
    )!;
    for (const text of [
      '100000 vectors',
      '100 thousand vectors',
      '100K vectors',
      '.1 million vectors',
    ]) {
      expect(normalizedValue(extractNumbers(text)[0], field)).toBe(100);
    }
    expect(
      (
        await decide(input, {
          operation: 'configure',
          target: 'node_1',
          field: 'field_indexSizeK',
          value: 'value_0',
        })
      ).decision.edit,
    ).toEqual({ op: 'configure', nodeId: 'Vectors', field: 'indexSizeK', value: 100 });
    const instances = configFieldsFor('service').find(
      (item) => item.field === 'instances',
    )!;
    expect(() =>
      normalizedValue(extractNumbers('12000 vectors')[0], instances),
    ).toThrow('vector count');
  });
  it('normalizes only units that match the selected setting, leaving plain values explicit', () => {
    const timeout = configFieldsFor('service').find(
      (field) => field.field === 'timeoutMs',
    )!;
    const errors = configFieldsFor('service').find(
      (field) => field.field === 'errorRate',
    )!;
    const instances = configFieldsFor('service').find(
      (field) => field.field === 'instances',
    )!;
    expect(normalizedValue(extractNumbers('2s')[0], timeout)).toBe(2000);
    expect(normalizedValue(extractNumbers('40ms')[0], timeout)).toBe(40);
    expect(normalizedValue(extractNumbers('25%')[0], errors)).toBe(0.25);
    expect(normalizedValue(extractNumbers('.5')[0], errors)).toBe(0.5);
    expect(normalizedValue(extractNumbers('12')[0], instances)).toBe(12);
    for (const [kind, field, text, expected] of [
      ['lambda', 'coldStartMs', '2s', 2000],
      ['vectordb', 'recallTarget', '90%', 0.9],
      ['autoscaler', 'scaleStepPct', '50%', 0.5],
    ] as const) {
      expect(
        normalizedValue(
          extractNumbers(text)[0],
          configFieldsFor(kind).find((item) => item.field === field)!,
        ),
      ).toBe(expected);
    }
    expect(() => normalizedValue(extractNumbers('25')[0], errors)).toThrow('range');
    expect(() => normalizedValue(extractNumbers('2s')[0], instances)).toThrow(
      'time unit',
    );
    expect(() => normalizedValue(extractNumbers('25%')[0], instances)).toThrow(
      'percentage',
    );
    expect(() => normalizedValue(extractNumbers('-2')[0], instances)).toThrow('range');
  });
});

describe('typed design choices', () => {
  it('offers every component and a compact allowlisted observation while compiling a cache insertion', async () => {
    const input = request();
    input.topology.annotations = [
      {
        id: 'note',
        kind: 'note',
        text: 'private annotation',
        x: 0,
        y: 0,
        width: 100,
        size: 'md',
      },
    ];
    const original = structuredClone(input.topology);
    const { decision, payload } = await decide(input, {
      operation: 'add',
      kind: 'cache',
      placement: 'before',
      target: 'node_1',
    });
    expect(decision).toMatchObject({
      outcome: 'edit',
      edit: { op: 'add', kind: 'cache', placement: 'before', targetId: 'Database' },
      model: MODEL,
      callsRemaining: 17,
      usage: { input_tokens: 321, output_tokens: 87 },
    });
    expect(componentCatalog).toHaveLength(33);
    expect(Object.keys(payload.questions.kind.criteria)).toEqual([
      ...componentCatalog.map(({ kind }) => kind),
      'none',
      'ambiguous',
    ]);
    expect(JSON.stringify(payload)).not.toContain(input.sessionId);
    expect(JSON.stringify(payload)).not.toContain('private annotation');
    expect(JSON.stringify(payload.state)).not.toContain('"x"');
    expect(input.topology.nodes).toEqual(original.nodes);
    expect(input.topology.edges).toEqual(original.edges);
  });
  it('observes autoscaler control edges and relevant network settings explicitly', async () => {
    const input = request();
    input.topology.nodes.push(node('Scaler', 'autoscaler'));
    input.topology.edges.push({
      id: 'supervise',
      from: 'Scaler',
      to: 'API',
      weight: 1,
    });
    Object.assign(input.topology.edges[0], {
      latencyMs: 12,
      bandwidthRps: 100,
      lossRate: 0.2,
    });
    const { payload } = await decide(input, { operation: 'finish' });
    expect(payload.questions.edge.criteria.edge_1).toContain('control edge');
    expect(payload.state.edges).toEqual([
      {
        id: 'traffic',
        from: 'API',
        to: 'Database',
        weight: 1,
        control: false,
        latencyMs: 12,
        bandwidthRps: 100,
        lossRate: 0.2,
      },
      {
        id: 'supervise',
        from: 'Scaler',
        to: 'API',
        weight: 1,
        control: true,
        latencyMs: 0,
        bandwidthRps: 0,
        lossRate: 0,
      },
    ]);
  });
  it('can add a component to an empty graph and accepts an honest unsupported or finished answer', async () => {
    const input = { ...request('Add a queue'), topology: { nodes: [], edges: [] } };
    expect(
      (
        await decide(input, {
          operation: 'add',
          kind: 'queue',
          placement: 'unconnected',
        })
      ).decision.edit,
    ).toEqual({ op: 'add', kind: 'queue', placement: 'unconnected' });
    expect((await decide(input, { operation: 'unsupported' })).decision).toMatchObject({
      outcome: 'unsupported',
    });
    // Speculative arguments are independent, so irrelevant valid choices do not
    // turn a finished answer into another edit.
    expect(
      (
        await decide(input, {
          operation: 'finish',
          kind: 'cache',
          placement: 'before',
          target: 'ambiguous',
        })
      ).decision,
    ).not.toHaveProperty('edit');
  });
  it.each([
    [
      { operation: 'insert', kind: 'queue', edge: 'edge_0' },
      { op: 'insert', kind: 'queue', edgeId: 'traffic' },
    ],
    [
      { operation: 'disconnect', edge: 'edge_0' },
      { op: 'disconnect', edgeId: 'traffic' },
    ],
    [
      { operation: 'remove', target: 'node_1' },
      { op: 'remove', nodeId: 'Database' },
    ],
    [
      {
        operation: 'configure',
        target: 'node_0',
        field: 'field_timeoutMs',
        value: 'value_0',
      },
      { op: 'configure', nodeId: 'API', field: 'timeoutMs', value: 2000 },
    ],
  ])('grounds actual IDs and values for %j', async (choices, expected) => {
    const { decision } = await decide(request('Set API timeout to 2s'), choices);
    expect(decision.edit).toEqual(expected);
  });
  it('maps source and destination to real IDs and rejects compiler-invalid edges', async () => {
    const input = request();
    input.topology.edges = [];
    expect(
      (
        await decide(input, {
          operation: 'connect',
          source: 'node_0',
          target: 'node_1',
        })
      ).decision.edit,
    ).toEqual({ op: 'connect', from: 'API', to: 'Database' });
    await expect(
      decide(request(), { operation: 'connect', source: 'node_0', target: 'node_1' }),
    ).rejects.toThrow('already connected');
  });
  it('rejects ambiguous arguments, wrong-kind fields, out-of-range units and non-integer settings', async () => {
    await expect(
      decide(request(), {
        operation: 'add',
        kind: 'cache',
        placement: 'before',
        target: 'ambiguous',
      }),
    ).rejects.toThrow('grounded target');
    const input = request('Set timeout to 2s');
    input.topology.nodes[1] = node('Database', 'cache');
    await expect(
      decide(input, {
        operation: 'configure',
        target: 'node_1',
        field: 'field_timeoutMs',
        value: 'value_0',
      }),
    ).rejects.toThrow('not grounded');
    await expect(
      decide(request('Set instances to 2s'), {
        operation: 'configure',
        target: 'node_0',
        field: 'field_instances',
        value: 'value_0',
      }),
    ).rejects.toThrow('time unit');
    await expect(
      decide(request('Set instances to 2.5'), {
        operation: 'configure',
        target: 'node_0',
        field: 'field_instances',
        value: 'value_0',
      }),
    ).rejects.toThrow('steps');
    await expect(
      decide(request('Make instances larger'), {
        operation: 'configure',
        target: 'node_0',
        field: 'field_instances',
      }),
    ).rejects.toThrow('not grounded');
  });
  it('allows only finish or unsupported after four completed edits', async () => {
    const input = { ...request(), completed: ['one', 'two', 'three', 'four'] };
    expect((await decide(input, { operation: 'finish' })).decision.outcome).toBe(
      'finish',
    );
    await expect(
      decide(input, { operation: 'remove', target: 'node_0' }),
    ).rejects.toThrow('limit');
  });
  it('validates every distribution, including unused branches, model and usage', async () => {
    const input = request();
    const { answer } = await decide(input, { operation: 'finish' });
    const bad: [string, (value: typeof answer) => void][] = [
      [
        'missing branch',
        (value) => {
          delete value.answers.value;
        },
      ],
      [
        'extra branch',
        (value) => {
          value.answers.invented = value.answers.value;
        },
      ],
      [
        'missing candidate',
        (value) => {
          delete value.answers.kind.probabilities.cache;
        },
      ],
      [
        'extra candidate',
        (value) => {
          value.answers.kind.probabilities.invented = 0;
        },
      ],
      [
        'bad sum',
        (value) => {
          value.answers.kind.probabilities.cache = 0.5;
        },
      ],
      [
        'NaN probability',
        (value) => {
          value.answers.kind.probabilities.cache = NaN;
        },
      ],
      [
        'nonfinite confidence',
        (value) => {
          value.answers.value.confidence = Infinity;
        },
      ],
      [
        'wrong winning choice',
        (value) => {
          value.answers.kind.choice = 'cache';
        },
      ],
      [
        'unknown operation',
        (value) => {
          value.answers.operation.choice = 'run_code';
        },
      ],
      [
        'wrong model',
        (value) => {
          value.model = 'jev-latest';
        },
      ],
      [
        'negative usage',
        (value) => {
          value.usage.input_tokens = -1;
        },
      ],
      [
        'fractional usage',
        (value) => {
          value.usage.output_tokens = 0.5;
        },
      ],
    ];
    for (const [name, mutate] of bad) {
      const changed = structuredClone(answer);
      mutate(changed);
      expect(() => parseDesignDecision(changed, input, 1, 17), name).toThrow();
    }
  });
  it('passes cancellation to the provider and rejects answers arriving after abort', async () => {
    const abort = new AbortController();
    await expect(
      chooseDesignStep('mock', request(), abort.signal, 17, async (_url, init) => {
        expect(init?.signal).toBe(abort.signal);
        const payload = JSON.parse(String(init?.body));
        abort.abort();
        return Response.json(response(payload, { operation: 'finish' }));
      }),
    ).rejects.toThrow('abort');
  });
});
