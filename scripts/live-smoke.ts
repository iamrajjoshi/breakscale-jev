// Explicit paid integration: at most two real model requests, never part of npm test.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { Engine } from '../src/sim/engine.ts';
import { makeNode } from '../src/sim/presets.ts';
import type { Topology } from '../src/sim/types.ts';
import {
  actionsFor,
  MODEL,
  observe,
  type Decision,
  type DecisionRequest,
} from '../src/operator/contracts.ts';

const base = `http://127.0.0.1:${Number(process.env.PORT ?? 4176)}`;
const health = await (await fetch(`${base}/api/health`)).json();
assert.equal(health.model, MODEL);
assert.equal(health.configured, true);
const client = { ...makeNode('client', 0, 0), id: 'client', label: 'Visitors' };
client.config.rps = 30;
const db = { ...makeNode('db', 300, 0), id: 'orders-db', label: 'Orders database' };
db.config.capacity = 10;
db.config.serviceMs = 5;
db.config.errorRate = 0;
const topology: Topology = {
  nodes: [client, db],
  edges: [{ id: 'client-db', from: client.id, to: db.id, weight: 1 }],
};
const engine = new Engine(topology, 73);
function advance() {
  for (let i = 0; i < 120; i++) engine.advance(1000 / 60);
}
const sessionId = randomUUID();
const receipts: unknown[] = [];
let passed = false;
try {
  for (const mode of ['command', 'operator'] as const) {
    engine.injectFailure(db.id, 'crash');
    advance();
    const observation = observe(topology, engine.snapshot());
    assert.equal(observation.nodes.find((node) => node.id === db.id)?.fault, 'crash');
    const payload: DecisionRequest = {
      sessionId,
      mode,
      prompt:
        mode === 'command'
          ? 'Repair the crashed Orders database.'
          : 'Restore useful throughput by repairing the failed service.',
      observation,
    };
    const response = await fetch(`${base}/api/decide`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: base },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(18000),
    });
    const decision = (await response.json()) as Decision;
    const action = actionsFor(observation, mode).find(
      (candidate) => candidate.id === decision.choice,
    );
    const receipt = {
      mode,
      status: response.status,
      model: decision.model,
      choice: decision.choice,
      action,
      confidence: decision.confidence,
      probabilities: decision.probabilities,
      usage: decision.usage,
      durationMs: decision.durationMs,
      callsRemaining: decision.callsRemaining,
      before: observation.system,
      after: null as unknown,
      repaired: false,
    };
    receipts.push(receipt);
    assert.equal(response.status, 200);
    assert.equal(decision.model, MODEL);
    assert.equal(action?.kind, 'repair');
    assert.ok(action && 'nodeId' in action);
    assert.equal(action.nodeId, db.id);
    engine.clearFailure(action.nodeId);
    advance();
    const after = observe(topology, engine.snapshot());
    receipt.after = after.system;
    receipt.repaired = after.nodes.find((node) => node.id === db.id)?.fault === null;
    assert.equal(receipt.repaired, true);
    assert.ok(after.system.goodputRps > 0);
  }
  passed = true;
  console.log(
    'Live Jev command and operator both repaired a crashed engine database (2 calls).',
  );
} finally {
  await mkdir('docs/qa', { recursive: true });
  await writeFile(
    'docs/qa/breakscale-live-smoke.json',
    JSON.stringify(
      {
        recordedAt: new Date().toISOString(),
        model: MODEL,
        passed,
        note: 'Two synthetic-engine scenarios with real model HTTP calls; this is not a benchmark of model superiority.',
        receipts,
      },
      null,
      2,
    ),
  );
}
