// Explicit paid integration: three instructions, at most 15 real calls total.
// It never runs as part of the free test suite. The local server must be running.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { compileEdit } from '../src/designer/compiler.ts';
import {
  MAX_DESIGN_EDITS,
  type DesignDecision,
  type DesignRequest,
} from '../src/designer/contracts.ts';
import { designTopology } from '../src/designer/validation.ts';
import { MODEL } from '../src/operator/contracts.ts';
import { defaultConfig } from '../src/sim/presets.ts';
import type { NodeKind, Topology } from '../src/sim/types.ts';
import { Engine } from '../src/sim/engine.ts';

const base = `http://127.0.0.1:${Number(process.env.PORT ?? 4176)}`;
const health = await (await fetch(`${base}/api/health`)).json();
assert.equal(health.model, MODEL);
assert.equal(health.configured, true);
const seed: Topology = {
  nodes: (['client', 'service', 'db'] as NodeKind[]).map((kind, index) => ({
    id: ['client', 'api', 'db'][index]!,
    label: ['Visitors', 'API', 'Database'][index]!,
    kind,
    x: index * 280,
    y: 0,
    config: defaultConfig(kind),
  })),
  edges: [
    { id: 'client-api', from: 'client', to: 'api', weight: 1 },
    { id: 'api-db', from: 'api', to: 'db', weight: 1 },
  ],
};
const scenarios = [
  {
    prompt: 'Put a cache before the database.',
    verify(topology: Topology) {
      assert.equal(topology.nodes.length, 4);
      const cache = topology.nodes.find((node) => node.kind === 'cache')!;
      assert.ok(cache);
      assert.ok(
        topology.edges.some((edge) => edge.from === 'api' && edge.to === cache.id),
      );
      assert.ok(
        topology.edges.some((edge) => edge.from === cache.id && edge.to === 'db'),
      );
      assert.ok(
        !topology.edges.some((edge) => edge.from === 'api' && edge.to === 'db'),
      );
    },
  },
  {
    prompt: 'Add a queue and workers after the API.',
    verify(topology: Topology) {
      assert.equal(topology.nodes.length, 5);
      const queue = topology.nodes.find((node) => node.kind === 'queue')!;
      const worker = topology.nodes.find((node) => node.kind === 'worker')!;
      assert.ok(queue && worker);
      assert.ok(
        topology.edges.some((edge) => edge.from === 'api' && edge.to === queue.id),
      );
      assert.ok(
        topology.edges.some((edge) => edge.from === queue.id && edge.to === worker.id),
      );
    },
  },
  {
    prompt: 'Set the database to 12 connections and 40 ms service time.',
    verify(topology: Topology) {
      const database = topology.nodes.find((node) => node.id === 'db')!;
      assert.equal(database.config.capacity, 12);
      assert.equal(database.config.serviceMs, 40);
      assert.deepEqual(topology.edges, seed.edges);
      assert.equal(topology.nodes.length, 3);
    },
  },
];
const sessionId = randomUUID();
const receipts: {
  prompt: string;
  decisions: unknown[];
  passed: boolean;
  topology?: Topology;
  engineTimeMs?: number;
  error?: string;
}[] = [];
let passed = false;
try {
  for (const scenario of scenarios) {
    const receipt: (typeof receipts)[number] = {
      prompt: scenario.prompt,
      decisions: [],
      passed: false,
    };
    receipts.push(receipt);
    let draft = structuredClone(seed);
    const completed: string[] = [];
    let finished = false;
    try {
      for (let step = 0; step <= MAX_DESIGN_EDITS; step++) {
        const payload: DesignRequest = {
          sessionId,
          prompt: scenario.prompt,
          topology: designTopology(draft),
          completed,
          selectedNodeId: null,
        };
        const response = await fetch(`${base}/api/design-step`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Origin: base },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(18000),
        });
        const decision = (await response.json()) as DesignDecision;
        receipt.decisions.push({ status: response.status, ...decision });
        assert.equal(response.status, 200, JSON.stringify(decision));
        assert.equal(decision.model, MODEL);
        if (decision.outcome === 'finish') {
          finished = true;
          break;
        }
        assert.equal(decision.outcome, 'edit');
        assert.ok(decision.edit);
        assert.ok(
          step < MAX_DESIGN_EDITS,
          'Instruction did not finish within four edits',
        );
        const compiled = compileEdit(draft, decision.edit);
        completed.push(compiled.summary);
        draft = compiled.topology;
      }
      assert.ok(finished);
      scenario.verify(draft);
      const engine = new Engine(draft, 83);
      for (let tick = 0; tick < 120; tick++) engine.advance(1000 / 60);
      assert.ok(Number.isFinite(engine.snapshot().system.goodputRps));
      receipt.engineTimeMs = engine.snapshot().system.timeMs;
      receipt.topology = draft;
      receipt.passed = true;
    } catch (error) {
      receipt.error = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }
  passed = true;
  console.log(
    `Live design smoke passed: ${receipts.length} instructions, ${receipts.reduce((sum, receipt) => sum + receipt.decisions.length, 0)} counted calls.`,
  );
} finally {
  await mkdir('docs/qa', { recursive: true });
  await writeFile(
    'docs/qa/design-live-smoke.json',
    JSON.stringify(
      {
        recordedAt: new Date().toISOString(),
        model: MODEL,
        passed,
        note: 'Three synthetic architecture instructions with real JEV calls. This is integration evidence, not a reliability benchmark or a performance claim.',
        receipts,
      },
      null,
      2,
    ),
  );
}
