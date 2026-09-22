// Explicit opt-in captures. Never imported by the browser or the test command.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { chooseAction, loadKey } from '../server/jev.ts';
import { Engine } from '../src/sim/engine.ts';
import { PRESETS } from '../src/sim/presets.ts';
import { STARTER_RPS, STARTER_TOPOLOGY } from '../src/starter.ts';
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
const warmLoadOnly = args[0] === '--starter-load';
const componentFaultsOnly = args[0] === '--starter-components';
const richStarter = args[0] === '--starter' || warmLoadOnly || componentFaultsOnly;
if (richStarter) args.shift();
const maxCalls = warmLoadOnly ? 1 : componentFaultsOnly ? 7 : richStarter ? 12 : 14;
assert.ok(
  args.length === 3 && args[0] === '--live' && args[1] === '--output' && args[2],
  'Usage: npx tsx scripts/record-repairs.ts [--starter|--starter-load|--starter-components] --live --output /private/outside-repo/directory',
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
const simpleScenarios: (RecordedScenario & { limit: number })[] = [
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
function starterScenario(
  id: string,
  title: string,
  description: string,
  rps: number,
  failures: RecordedScenario['failures'],
  limit: number,
): RecordedScenario & { limit: number } {
  const topology = structuredClone(STARTER_TOPOLOGY);
  topology.nodes[0]!.config.rps = rps;
  return { id, title, description, topology, rps, failures, limit };
}
const starterScenarios = [
  starterScenario(
    'starter-database-crash',
    'Shared database down',
    'The cache can answer hits, but every miss reaches the crashed database.',
    STARTER_RPS,
    [{ nodeId: 'db', kind: 'crash' }],
    1,
  ),
  starterScenario(
    'starter-database-slow',
    'Slow shared database',
    'Three APIs feed one database whose injected slowdown affects every cache miss.',
    STARTER_RPS,
    [{ nodeId: 'db', kind: 'slow' }],
    1,
  ),
  starterScenario(
    'starter-api-crash',
    'One API goes down',
    'The load balancer still sends part of the traffic to the crashed API.',
    STARTER_RPS,
    [{ nodeId: 'api1', kind: 'crash' }],
    1,
  ),
  starterScenario(
    'starter-api-slow',
    'One slow API',
    'One branch runs five times slower while the other two keep serving.',
    STARTER_RPS,
    [{ nodeId: 'api1', kind: 'slow' }],
    1,
  ),
  starterScenario(
    'starter-traffic',
    'Shared database bottleneck',
    'Double traffic to 300 requests per second. Three APIs still depend on the same database.',
    STARTER_RPS * 2,
    undefined,
    2,
  ),
  starterScenario(
    'starter-outage',
    'Full web app outage',
    'Crash the balancer, all three APIs, the cache and the database. Watch each fault clear in turn.',
    STARTER_RPS,
    STARTER_TOPOLOGY.nodes
      .filter((node) => node.kind !== 'client')
      .map((node) => ({ nodeId: node.id, kind: 'crash' as const })),
    6,
  ),
];
const componentScenarios = (
  [
    ['lb', 'crash', 'Load balancer down'],
    ['lb', 'slow', 'Slow load balancer'],
    ['api2', 'crash', 'API 2 goes down'],
    ['api2', 'slow', 'API 2 slows down'],
    ['api3', 'slow', 'API 3 slows down'],
    ['cache', 'crash', 'Shared cache down'],
    ['cache', 'slow', 'Slow shared cache'],
  ] as const
).map(([nodeId, kind, title]) =>
  starterScenario(
    `starter-${nodeId}-${kind}`,
    title,
    `${title} in the seven-component web app at ${STARTER_RPS} requests per second.`,
    STARTER_RPS,
    [{ nodeId, kind }],
    1,
  ),
);
const scenarios = componentFaultsOnly
  ? componentScenarios
  : warmLoadOnly
    ? starterScenarios.filter((scene) => scene.id === 'starter-traffic')
    : richStarter
      ? starterScenarios
      : simpleScenarios;
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
  const engine = new Engine(
    warmLoadOnly ? structuredClone(STARTER_TOPOLOGY) : topology,
    87,
  );
  if (warmLoadOnly) {
    advance(engine, 4);
    engine.updateNodeConfig('client', { rps: scene.rps });
  }
  // Single-component captures reproduce a visitor breaking an already-running app.
  if (componentFaultsOnly) advance(engine, 7);
  for (const failure of scene.failures ?? [])
    engine.injectFailure(
      failure.nodeId,
      failure.kind,
      componentFaultsOnly && failure.kind === 'slow' ? { factor: 5 } : {},
    );
  advance(engine, warmLoadOnly || componentFaultsOnly ? 3 : 7);
  for (let step = 0; step < scene.limit && calls < maxCalls; step++) {
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
        maxCalls - calls,
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
    JSON.stringify(
      { recordedAt, model: MODEL, maxCalls, calls, attempts, outcomes },
      null,
      2,
    ),
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
