// Opt-in real JEV integration, at most 14 requests total. Never part of npm test.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { Engine } from '../src/sim/engine.ts';
import { PRESETS } from '../src/sim/presets.ts';
import type { NodeConfig, Topology } from '../src/sim/types.ts';
import {
  actionsFor,
  incidentFor,
  MODEL,
  observe,
  type Action,
  type Decision,
  type DecisionRequest,
  type Observation,
} from '../src/operator/contracts.ts';

const replayPath = process.argv[2] === '--replay' ? process.argv[3] : undefined;
assert.ok(process.argv.length === 2 || replayPath, 'Usage: [--replay receipt.json]');
const sourceText = replayPath ? await readFile(replayPath, 'utf8') : undefined;
type RecordedStep = {
  request: DecisionRequest;
  decision: Decision;
  action: Action;
  after: Observation;
};
type RecordedScenario = {
  name: string;
  before: Observation;
  after: Observation;
  decisions: RecordedStep[];
};
const source = sourceText
  ? (JSON.parse(sourceText) as { results: RecordedScenario[] })
  : undefined;
const base = `http://127.0.0.1:${Number(process.env.PORT ?? 4176)}`;
if (!source) {
  const health = await (await fetch(`${base}/api/health`)).json();
  assert.equal(health.configured, true);
  assert.equal(health.model, MODEL);
}
const sessionId = randomUUID();
const results: {
  name: string;
  before?: unknown;
  after?: unknown;
  decisions: unknown[];
  measurement?: ReturnType<typeof measure>;
  omittedLastRepairControl?: ReturnType<typeof measure>;
  passed: boolean;
  error?: string;
}[] = [];
let calls = 0;
let passed = false;
const scenarios = [
  {
    name: 'crash every service and raise traffic to 400/s',
    limit: 8,
    damage(engine: Engine, topology: Topology) {
      for (const node of topology.nodes) {
        if (node.kind === 'client') {
          node.config.rps = 400;
          engine.updateNodeConfig(node.id, { rps: 400 });
        } else engine.injectFailure(node.id, 'crash');
      }
    },
  },
  {
    name: 'throttle database capacity and slow its service time',
    limit: 4,
    damage(engine: Engine, topology: Topology) {
      const database = topology.nodes.find((node) => node.kind === 'db')!;
      Object.assign(database.config, { capacity: 1, serviceMs: 500 });
      engine.updateNodeConfig(database.id, { capacity: 1, serviceMs: 500 });
    },
  },
  {
    name: 'set database error probability to 50%',
    limit: 2,
    damage(engine: Engine, topology: Topology) {
      const database = topology.nodes.find((node) => node.kind === 'db')!;
      database.config.errorRate = 0.5;
      engine.updateNodeConfig(database.id, { errorRate: 0.5 });
    },
  },
];
const advance = (engine: Engine, seconds: number) => {
  for (let tick = 0; tick < seconds * 60; tick++) engine.advance(1000 / 60);
};
function counters(engine: Engine, topology: Topology) {
  const snapshot = engine.snapshot();
  // These scenarios have client roots only. Client completions are credited
  // once in Engine.resolve; summing intermediate node completions would double
  // count the same request. Copy numbers because node snapshots are reused.
  const succeeded = topology.nodes
    .filter((node) => node.kind === 'client')
    .reduce((sum, node) => sum + snapshot.nodes[node.id]!.totalCompleted, 0);
  return {
    timeMs: snapshot.system.timeMs,
    offered: snapshot.system.totalRequests,
    succeeded,
    failed: snapshot.system.totalFailed,
    outstanding:
      snapshot.system.totalRequests - succeeded - snapshot.system.totalFailed,
  };
}
function measure(engine: Engine, topology: Topology) {
  const start = counters(engine, topology);
  const samples: Observation['system'][] = [];
  let faultObserved = engine.snapshot().activeFailures.length > 0;
  for (let second = 0; second < 30; second++) {
    advance(engine, 1);
    const snapshot = engine.snapshot();
    samples.push(observe(topology, snapshot).system);
    faultObserved ||= snapshot.activeFailures.length > 0;
  }
  const end = counters(engine, topology);
  const durationSeconds = (end.timeMs - start.timeMs) / 1000;
  const offered = end.offered - start.offered;
  const succeeded = end.succeeded - start.succeeded;
  const failed = end.failed - start.failed;
  const completed = succeeded + failed;
  const errorRate = completed > 0 ? failed / completed : 1;
  const successPerArrival = offered > 0 ? succeeded / offered : 0;
  const outstandingGrowth = end.outstanding - start.outstanding;
  const allowedOutstandingGrowth = Math.max(3, offered * 0.01);
  const violations: string[] = [];
  if (durationSeconds < 29.999)
    violations.push('Observation window shorter than 30 seconds');
  if (offered === 0 || completed === 0) violations.push('No observed traffic');
  if (faultObserved) violations.push('An injected fault remains');
  if (errorRate >= 0.03)
    violations.push(`Aggregate error rate ${errorRate} is not below 3%`);
  if (successPerArrival < 0.85)
    violations.push(`Goodput is only ${successPerArrival} of actual arrivals`);
  if (outstandingGrowth > allowedOutstandingGrowth)
    violations.push(`Outstanding work grew by ${outstandingGrowth} requests`);
  return {
    start,
    end,
    durationSeconds,
    offered,
    succeeded,
    failed,
    offeredRps: offered / durationSeconds,
    goodputRps: succeeded / durationSeconds,
    errorRate,
    successPerArrival,
    outstandingGrowth,
    allowedOutstandingGrowth,
    violations,
    passed: violations.length === 0,
    samples,
  };
}
function apply(engine: Engine, topology: Topology, action: Action) {
  if (action.kind === 'wait') return;
  assert.ok('nodeId' in action, 'Recovery cannot change traffic');
  if (action.kind === 'repair') {
    engine.clearFailure(action.nodeId);
    return;
  }
  const patch: Partial<NodeConfig> | null =
    action.kind === 'scale'
      ? { instances: action.value }
      : action.kind === 'capacity'
        ? { capacity: action.value }
        : action.kind === 'service-time'
          ? { serviceMs: action.value }
          : action.kind === 'error-rate'
            ? { errorRate: action.value }
            : action.kind === 'retries'
              ? { retries: action.value }
              : null;
  assert.ok(patch, 'Only recovery actions may run');
  Object.assign(
    topology.nodes.find((node) => node.id === action.nodeId)!.config,
    patch,
  );
  engine.updateNodeConfig(action.nodeId, patch);
}
try {
  for (const scenario of scenarios) {
    const recorded = source?.results.find((result) => result.name === scenario.name);
    if (source && !recorded) continue; // Never invent a missing model decision.
    const topology = structuredClone(PRESETS[0]!.topology);
    const engine = new Engine(topology, 87);
    advance(engine, 4);
    scenario.damage(engine, topology);
    advance(engine, 3);
    const offered = topology.nodes
      .filter((node) => node.kind === 'client')
      .reduce((sum, node) => sum + node.config.rps, 0);
    const receipt: (typeof results)[number] = {
      name: scenario.name,
      before: observe(topology, engine.snapshot()),
      decisions: [],
      passed: false,
    };
    results.push(receipt);
    try {
      if (recorded)
        assert.deepEqual(
          receipt.before,
          recorded.before,
          'Replay initial state drifted',
        );
      for (
        let step = 0;
        step < (recorded?.decisions.length ?? scenario.limit);
        step++
      ) {
        const observation = observe(topology, engine.snapshot());
        if (!recorded && !incidentFor(observation)) break;
        const request: DecisionRequest = {
          sessionId,
          mode: 'operator',
          prompt:
            'Restore useful throughput and reduce failures without reducing offered demand. Repair the observed cause.',
          observation,
        };
        let decision: Decision;
        let status: number;
        if (recorded) {
          assert.deepEqual(
            observation,
            recorded.decisions[step]!.request.observation,
            'Replay decision state drifted',
          );
          decision = recorded.decisions[step]!.decision;
          status = 200;
        } else {
          assert.ok(calls < 14, 'Live request cap reached');
          calls++;
          const response = await fetch(`${base}/api/decide`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Origin: base },
            body: JSON.stringify(request),
            signal: AbortSignal.timeout(18000),
          });
          decision = (await response.json()) as Decision;
          status = response.status;
        }
        const action = actionsFor(observation, 'operator').find(
          (item) => item.id === decision.choice,
        );
        const stepReceipt = {
          request,
          status,
          decision,
          action,
          after: null as unknown,
        };
        receipt.decisions.push(stepReceipt);
        assert.equal(status, 200, JSON.stringify(decision));
        assert.equal(decision.model, MODEL);
        assert.ok(action, 'Decision must name an offered action');
        if (recorded)
          assert.deepEqual(
            action,
            recorded.decisions[step]!.action,
            'Recorded repair changed',
          );
        apply(engine, topology, action);
        advance(engine, 6);
        stepReceipt.after = observe(topology, engine.snapshot());
        if (recorded)
          assert.deepEqual(
            stepReceipt.after,
            recorded.decisions[step]!.after,
            'Replay repair outcome drifted',
          );
      }
      const after = observe(topology, engine.snapshot());
      receipt.after = after;
      if (recorded)
        assert.deepEqual(after, recorded.after, 'Replay final state drifted');
      // Each repair has already had six simulated seconds to settle. Rates in
      // SystemStats cover roughly one second and arrivals are stochastic, so a
      // single instantaneous rate cannot be compared with the configured mean.
      // Validate exact event-counter deltas, preserving the original 3% error
      // and 85% throughput criteria while also rejecting sustained backlog growth.
      receipt.measurement = measure(engine, topology);
      assert.equal(
        receipt.measurement.passed,
        true,
        receipt.measurement.violations.join('; '),
      );
      assert.equal(
        topology.nodes
          .filter((node) => node.kind === 'client')
          .reduce((sum, node) => sum + node.config.rps, 0),
        offered,
      );
      if (recorded?.decisions.length) {
        const controlTopology = structuredClone(PRESETS[0]!.topology);
        const control = new Engine(controlTopology, 87);
        advance(control, 4);
        scenario.damage(control, controlTopology);
        advance(control, 3);
        for (const decision of recorded.decisions.slice(0, -1)) {
          apply(control, controlTopology, decision.action);
          advance(control, 6);
        }
        advance(control, 6); // Same elapsed time, omit only the last repair.
        receipt.omittedLastRepairControl = measure(control, controlTopology);
        assert.equal(
          receipt.omittedLastRepairControl.passed,
          false,
          'Measurement must reject the incompletely repaired control',
        );
      }
      receipt.passed = true;
    } catch (error) {
      receipt.error = error instanceof Error ? error.message : String(error);
    }
  }
  assert.ok(results.length > 0, 'No matching scenarios in the source receipt');
  passed = results.every((result) => result.passed);
  if (!passed) process.exitCode = 1;
} finally {
  await mkdir('docs/qa/autopilot', { recursive: true });
  const output = `docs/qa/autopilot/${source ? 'replay' : 'live'}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  await writeFile(
    output,
    JSON.stringify(
      {
        recordedAt: new Date().toISOString(),
        model: MODEL,
        passed,
        calls,
        ...(sourceText
          ? {
              source: replayPath,
              sourceSha256: createHash('sha256').update(sourceText).digest('hex'),
              replayedDecisions: results.reduce(
                (sum, result) => sum + result.decisions.length,
                0,
              ),
              unrecordedScenarios: scenarios
                .filter(
                  (scenario) =>
                    !source!.results.some((result) => result.name === scenario.name),
                )
                .map((scenario) => scenario.name),
            }
          : {}),
        measurement:
          'Exact cumulative engine arrival, root-success and root-failure counter deltas over 30 simulated seconds after six seconds of settlement. Error fraction below 3%; successes at least 85% of actual arrivals; outstanding-work growth no more than 1% of arrivals (minimum tolerance three requests). Configured demand is unchanged. Window counts are not matched arrival cohorts; outstanding-work boundary changes are reported explicitly.',
        note: source
          ? 'Offline deterministic replay of retained real JEV choices, seed 87; zero API calls. Every pre/post-action observation is asserted equal to the original receipt. Omitted-last-repair controls must fail. Missing recorded scenarios remain untested; no model-quality benchmark claim.'
          : 'Real JEV choices applied to seeded upstream engines. Integration checks, not a comparative benchmark. Every attempted call, failed scenario and sustained observation window is retained.',
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
      scenarios: results.map(({ name, passed, error }) => ({ name, passed, error })),
    }),
  );
}
