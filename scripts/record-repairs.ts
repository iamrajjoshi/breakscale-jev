// Explicit opt-in captures. Never imported by the browser or the test command.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { chooseAction, loadKey } from '../server/jev.ts';
import { Engine } from '../src/sim/engine.ts';
import { PRESETS } from '../src/sim/presets.ts';
import type { NodeConfig, Topology } from '../src/sim/types.ts';
import {
  actionsFor,
  incidentFor,
  MODEL,
  observe,
  type Action,
  type DecisionRequest,
} from '../src/operator/contracts.ts';
import type { RecordedRepair, RecordedScenario } from '../src/operator/recordings.ts';

const args = process.argv.slice(2);
assert.ok(
  args.length === 3 && args[0] === '--live' && args[1] === '--output' && args[2],
  'Usage: npx tsx scripts/record-repairs.ts --live --output /private/outside-repo/directory',
);
const output = resolve(args[2]!);
const relativeOutput = relative(process.cwd(), output);
assert.ok(
  relativeOutput.startsWith('..') || isAbsolute(relativeOutput),
  'Raw receipts must be outside the source repository',
);
await mkdir(output, { recursive: true });
const key = await loadKey();
assert.ok(key, 'TypeSafe credentials are required for recording');
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const advance = (engine: Engine, seconds: number) => {
  for (let tick = 0; tick < seconds * 60; tick++) engine.advance(1000 / 60);
};
function scenario(
  id: string,
  title: string,
  description: string,
  changes: { rps?: number; api?: Partial<NodeConfig>; db?: Partial<NodeConfig> } = {},
  failures?: RecordedScenario['failures'],
): RecordedScenario {
  const topology = structuredClone(PRESETS[0]!.topology);
  delete topology.annotations;
  if (changes.rps) topology.nodes[0]!.config.rps = changes.rps;
  Object.assign(topology.nodes[1]!.config, changes.api);
  Object.assign(topology.nodes[2]!.config, changes.db);
  return { id, title, description, topology, rps: changes.rps ?? 50, failures };
}
const scenarios: (RecordedScenario & { limit: number })[] = [
  {
    ...scenario(
      'database-crash',
      'Database down',
      'Crash the database, then watch requests recover.',
      {},
      [{ nodeId: 'db', kind: 'crash' }],
    ),
    limit: 1,
  },
  {
    ...scenario(
      'database-slow',
      'Slow database',
      'Make the database five times slower while traffic keeps moving.',
      {},
      [{ nodeId: 'db', kind: 'slow' }],
    ),
    limit: 1,
  },
  {
    ...scenario(
      'slow-service',
      'Slow deployment',
      'An API setting has jumped from 25ms to 500ms per request.',
      { api: { serviceMs: 500 } },
    ),
    limit: 1,
  },
  {
    ...scenario(
      'database-errors',
      'Bad database deploy',
      'Half of database requests fail because of an edited error setting.',
      { db: { errorRate: 0.5 } },
    ),
    limit: 1,
  },
  {
    ...scenario(
      'traffic-200',
      'Traffic surge',
      'Four times the original traffic exposes the database bottleneck.',
      { rps: 200 },
    ),
    limit: 3,
  },
  {
    ...scenario(
      'traffic-400',
      'Crowded system',
      'Eight times the original traffic needs several measured repairs.',
      { rps: 400 },
    ),
    limit: 3,
  },
  {
    ...scenario(
      'wreck-it',
      'Everything breaks',
      'Both services crash just as demand quadruples.',
      { rps: 200 },
      [
        { nodeId: 'api', kind: 'crash' },
        { nodeId: 'db', kind: 'crash' },
      ],
    ),
    limit: 4,
  },
];
const recordings: RecordedRepair[] = [];
const attempts: unknown[] = [];
const outcomes: unknown[] = [];
let calls = 0;
const recordedAt = new Date().toISOString();
function apply(engine: Engine, topology: Topology, action: Action) {
  assert.ok('nodeId' in action, 'Only recorded mutable repairs are exported');
  if (action.kind === 'repair') return engine.clearFailure(action.nodeId);
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
  assert.ok(patch, 'Only recovery changes can run');
  Object.assign(
    topology.nodes.find((node) => node.id === action.nodeId)!.config,
    patch,
  );
  engine.updateNodeConfig(action.nodeId, patch);
}
for (const scene of scenarios) {
  const topology = structuredClone(scene.topology);
  const engine = new Engine(topology, 87);
  for (const failure of scene.failures ?? [])
    engine.injectFailure(failure.nodeId, failure.kind);
  advance(engine, 7);
  for (let step = 0; step < scene.limit && calls < 14; step++) {
    const observation = observe(topology, engine.snapshot());
    if (!incidentFor(observation)) break;
    const request: DecisionRequest = {
      sessionId: randomUUID(),
      mode: 'operator',
      prompt:
        'Restore useful throughput and reduce failures at the current offered traffic. Repair the observed cause, then let the system settle. Never lower demand or introduce a failure.',
      observation,
    };
    const originalTopology = structuredClone(topology);
    const http: { body?: string; response?: string; status?: number } = {};
    const fetcher: typeof fetch = async (input, init) => {
      http.body = typeof init?.body === 'string' ? init.body : undefined;
      const response = await fetch(input, init);
      http.response = await response.clone().text();
      http.status = response.status;
      return response;
    };
    calls++;
    try {
      const decision = await chooseAction(
        key,
        request,
        AbortSignal.timeout(18000),
        14 - calls,
        fetcher,
      );
      const action = actionsFor(observation, 'operator').find(
        (candidate) => candidate.id === decision.choice,
      );
      assert.ok(action);
      attempts.push({ scenarioId: scene.id, step, request, http, decision, action });
      if (action.kind === 'wait' || action.kind === 'unsupported') break;
      apply(engine, topology, action);
      advance(engine, 6);
      recordings.push({
        id: `${scene.id}-${step + 1}`,
        scenarioId: scene.id,
        title: scene.title,
        recordedAt: new Date().toISOString(),
        model: decision.model,
        originalTopology,
        originalObservation: observation,
        originalAction: action,
        confidence: decision.confidence,
        probabilities: decision.probabilities,
        after: observe(topology, engine.snapshot()),
        evidence: {
          requestSha256: sha256(http.body!),
          responseSha256: sha256(http.response!),
        },
      });
    } catch (error) {
      attempts.push({
        scenarioId: scene.id,
        step,
        request,
        http,
        error: error instanceof Error ? error.message : String(error),
      });
      break;
    }
  }
  // Independent current-engine measurements are shown at replay time. This
  // private capture keeps a settled integration result, not a benchmark claim.
  advance(engine, 10);
  outcomes.push({ scenarioId: scene.id, after: observe(topology, engine.snapshot()) });
  await writeFile(
    `${output}/capture.json`,
    JSON.stringify({ recordedAt, model: MODEL, calls, attempts, outcomes }, null, 2),
  );
  console.log(
    JSON.stringify({
      scenario: scene.id,
      calls,
      captured: recordings.filter((recording) => recording.scenarioId === scene.id)
        .length,
    }),
  );
}
const supported = scenarios
  .filter((scene) => recordings.some((recording) => recording.scenarioId === scene.id))
  .map(({ limit: _limit, ...scene }) => scene);
await writeFile(
  `${output}/recordings.json`,
  JSON.stringify({ version: 1, scenarios: supported, recordings }, null, 2),
);
console.log(
  JSON.stringify({
    calls,
    records: recordings.length,
    scenarios: supported.length,
    output,
  }),
);
