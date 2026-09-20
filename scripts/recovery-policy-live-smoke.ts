// Explicit opt-in integration: exactly one provider request per case, at most two.
// Never imported by the application or run by the default test command.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { chooseAction, loadKey } from '../server/jev.ts';
import { Engine } from '../src/sim/engine.ts';
import { PRESETS } from '../src/sim/presets.ts';
import type { Topology } from '../src/sim/types.ts';
import {
  actionsFor,
  hasWriteContention,
  MODEL,
  observe,
  validRequest,
  type DecisionRequest,
} from '../src/operator/contracts.ts';

const sourceFiles = [
  'scripts/recovery-policy-live-smoke.ts',
  'src/operator/contracts.ts',
  'server/jev.ts',
  'src/sim/engine.ts',
  'src/sim/behaviour-store.ts',
];
async function sourceHashes() {
  return Object.fromEntries(
    await Promise.all(
      sourceFiles.map(async (path) => [
        path,
        createHash('sha256')
          .update(await readFile(path))
          .digest('hex'),
      ]),
    ),
  );
}
const sourcesBefore = await sourceHashes();
const advance = (engine: Engine, seconds: number) => {
  for (let tick = 0; tick < seconds * 60; tick++) engine.advance(1000 / 60);
};
const demand = (topology: Topology) =>
  topology.nodes
    .filter((node) => node.kind === 'client')
    .reduce((sum, node) => sum + node.config.rps, 0);
function counters(engine: Engine, topology: Topology) {
  const snapshot = engine.snapshot();
  return {
    timeMs: snapshot.system.timeMs,
    offered: snapshot.system.totalRequests,
    failed: snapshot.system.totalFailed,
    succeeded: topology.nodes
      .filter((node) => node.kind === 'client')
      .reduce((sum, node) => sum + snapshot.nodes[node.id]!.totalCompleted, 0),
  };
}

const results: Record<string, unknown>[] = [];
let calls = 0;
let passed = false;
let fatal: string | undefined;
try {
  const key = await loadKey();
  assert.ok(key, 'TypeSafe is not configured. No provider requests were made.');
  for (const scenario of [
    'crash after prior waits',
    'shared database write lock',
  ] as const) {
    const receipt: Record<string, unknown> = { scenario, passed: false };
    results.push(receipt);
    try {
      const topology = structuredClone(PRESETS[0]!.topology);
      const engine = new Engine(topology, 87);
      advance(engine, 4);
      const client = topology.nodes.find((node) => node.kind === 'client')!;
      const api = topology.nodes.find((node) => node.kind === 'service')!;
      const database = topology.nodes.find((node) => node.kind === 'db')!;
      if (scenario === 'crash after prior waits') {
        engine.injectFailure(database.id, 'crash');
      } else {
        Object.assign(client.config, { rps: 1000 });
        Object.assign(api.config, { instances: 3 });
        Object.assign(database.config, {
          instances: 128,
          capacity: 512,
          readFraction: 0.5,
        });
        engine.updateNodeConfig(client.id, { rps: 1000 });
        engine.updateNodeConfig(api.id, { instances: 3 });
        engine.updateNodeConfig(database.id, {
          instances: 128,
          capacity: 512,
          readFraction: 0.5,
        });
      }
      // These are synthetic prior-wait fixtures, not unrecorded model calls.
      // The two observations themselves come from real unchanged engine time.
      advance(engine, 6);
      const previousWait = observe(topology, engine.snapshot()).system;
      advance(engine, 6);
      const observation = observe(topology, engine.snapshot());
      const request: DecisionRequest = {
        sessionId: randomUUID(),
        mode: 'operator',
        prompt:
          'Restore useful throughput and reduce failures without reducing offered traffic. Choose unsupported if the current repair menu cannot address the cause.',
        observation,
        recovery: { consecutiveWaits: 2, previousWait },
      };
      const choices = actionsFor(observation, 'operator');
      Object.assign(receipt, {
        seed: 87,
        configuredDemand: demand(topology),
        request,
        choices,
        priorWaits:
          'Two simulated no-change intervals form the test fixture. Neither interval invoked JEV.',
      });
      assert.equal(
        validRequest(request),
        true,
        'Fixture must satisfy the live contract',
      );
      if (scenario === 'shared database write lock') {
        assert.equal(
          hasWriteContention(
            observation.nodes.find((node) => node.id === database.id)!,
          ),
          true,
        );
        assert.equal(
          choices.some(
            (action) =>
              (action.kind === 'scale' || action.kind === 'capacity') &&
              action.nodeId === database.id,
          ),
          false,
        );
        assert.ok(
          choices.some((action) => action.kind === 'scale' && action.nodeId === api.id),
          'The case must test rejecting caller scaling, not only a two-choice menu',
        );
      }
      assert.ok(calls < 2, 'Provider call cap exceeded');
      calls++;
      const decision = await chooseAction(
        key,
        request,
        AbortSignal.timeout(18000),
        18 - calls,
      );
      receipt.decision = decision;
      const action = choices.find((candidate) => candidate.id === decision.choice);
      receipt.action = action;
      assert.equal(decision.model, MODEL);
      assert.ok(action, 'Decision must name an offered choice');
      if (scenario === 'crash after prior waits') {
        assert.equal(
          action.kind,
          'repair',
          'An active fault must be repaired, not observed again',
        );
        assert.ok('nodeId' in action && action.nodeId === database.id);
        engine.clearFailure(database.id);
        advance(engine, 6);
        const start = counters(engine, topology);
        advance(engine, 30);
        const end = counters(engine, topology);
        const offered = end.offered - start.offered;
        const succeeded = end.succeeded - start.succeeded;
        const failed = end.failed - start.failed;
        const errorRate = failed / (succeeded + failed);
        const successPerArrival = succeeded / offered;
        receipt.measurement = {
          start,
          end,
          offered,
          succeeded,
          failed,
          errorRate,
          successPerArrival,
        };
        assert.ok(offered > 0 && Number.isFinite(errorRate));
        assert.ok(
          errorRate < 0.03,
          'Recovery must hold below 3% failures over 30 simulated seconds',
        );
        assert.ok(successPerArrival >= 0.85, 'Goodput must cover actual arrivals');
        assert.equal(engine.snapshot().activeFailures.length, 0);
      } else {
        assert.equal(
          action.kind,
          'unsupported',
          'Shared write contention must be reported as unsupported, not another wait or caller scale',
        );
        assert.equal(
          database.config.lockMs,
          15,
          'Do not erase the modeled lock constraint',
        );
        assert.equal(
          database.config.readFraction,
          0.5,
          'Do not alter the workload mix',
        );
        receipt.noMutation = true;
      }
      receipt.after = observe(topology, engine.snapshot());
      assert.equal(demand(topology), receipt.configuredDemand);
      receipt.passed = true;
    } catch (error) {
      receipt.error = error instanceof Error ? error.message : String(error);
    }
  }
  assert.equal(
    calls,
    2,
    'Both independent policy cases must attempt their single provider call',
  );
  passed = results.every((result) => result.passed === true);
} catch (error) {
  fatal = error instanceof Error ? error.message : String(error);
} finally {
  const sourcesAfter = await sourceHashes();
  const sourceStable = JSON.stringify(sourcesBefore) === JSON.stringify(sourcesAfter);
  passed &&= sourceStable;
  await mkdir('docs/qa/activity', { recursive: true });
  const output = `docs/qa/activity/live-policy-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  await writeFile(
    output,
    JSON.stringify(
      {
        recordedAt: new Date().toISOString(),
        model: MODEL,
        passed,
        calls,
        fatal,
        sourceStable,
        sourcesBefore,
        sourcesAfter,
        note: 'Exactly one attempted provider request per policy case, no retry or prompt tuning. Synthetic prior-wait history; real seeded simulation observations and real JEV choices. This is an integration check, not a model-quality benchmark.',
        results,
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      passed,
      calls,
      output,
      scenarios: results.map(({ scenario, passed, error }) => ({
        scenario,
        passed,
        error,
      })),
    }),
  );
  if (!passed) process.exitCode = 1;
}
