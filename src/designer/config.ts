// Shared Inspector metadata: numeric model edits use exactly the visible controls.
import type { NodeKind } from '../sim/types.ts';
import { formatMs, formatPct, formatRate } from '../components/format.ts';

/* ------------------------------------------------------------------ *
 * Which knobs actually apply to which kind.
 *
 * This is the whole point of the panel: a cache shows hitRate, a db does
 * not; a client shows the load it offers and how long it waits; a queue
 * shows only how deep it may get. Thirty knobs on every node would make
 * the app look configurable and feel meaningless.
 *
 * FIELDS_BY_KIND is the single source of truth for that filtering, and
 * the assertion below it is what keeps the promise honest: every field
 * that exists must be claimed by at least one kind, so a knob can never
 * be added to the type and silently reach every panel.
 * ------------------------------------------------------------------ */

export type Field =
  | 'rps'
  | 'instances'
  | 'capacity'
  | 'serviceMs'
  | 'serviceCv'
  | 'queueLimit'
  | 'hitRate'
  | 'errorRate'
  | 'timeoutMs'
  | 'retries'
  | 'replicaCount'
  | 'replicationLagMs'
  | 'readFraction'
  | 'shardCount'
  | 'shardCapacity'
  | 'hotKeyFraction'
  | 'targetUtil'
  | 'minCapacity'
  | 'maxCapacity'
  | 'cooldownMs'
  | 'scaleStepPct'
  | 'warmupMs'
  | 'regions'
  | 'activeRegion'
  | 'failoverMs'
  | 'rateLimitRps'
  | 'burst'
  | 'errorThreshold'
  | 'windowMs'
  | 'openMs'
  | 'halfOpenProbes'
  | 'indexMs'
  | 'indexLagMs'
  | 'rangeQueryFraction'
  | 'rangeQueryMs'
  | 'traversalDepth'
  | 'indexSizeK'
  | 'recallTarget'
  | 'partitions'
  | 'connectionMs'
  | 'authFailRate'
  | 'outlierAfter'
  | 'coldStartMs'
  | 'keepWarmMs'
  | 'maxConcurrency'
  | 'intervalMs'
  | 'batchSize'
  | 'bulkheadMax'
  | 'flushDelayMs'
  | 'edgeShare'
  | 'lowPriorityShare'
  | 'priorityReserve'
  | 'lockMs'
  | 'prefixRps'
  | 'renditions'
  | 'cpuMsCap';

export const FIELDS_BY_KIND: Record<NodeKind, Field[]> = {
  // The client generates load and decides how long to wait for an answer.
  // It serves nothing, so it has no capacity, service time, or queue.
  client: ['rps', 'timeoutMs', 'retries'],
  // A load balancer forwards; its own service time is near-zero but its
  // connection pool and backlog are real and can saturate.
  lb: ['instances', 'capacity', 'serviceMs', 'queueLimit'],
  // The general workhorse: everything except cache hits and offered load.
  service: [
    'instances',
    'capacity',
    'serviceMs',
    'serviceCv',
    'queueLimit',
    'errorRate',
    'timeoutMs',
    'retries',
  ],
  // Only the cache has a hit rate. That single knob is the interesting one.
  cache: ['hitRate', 'instances', 'capacity', 'serviceMs', 'serviceCv', 'queueLimit'],
  // A database is slots, service time, and the write lock: the read/write
  // mix and the per-writer lock wait are what make it more than a service.
  db: [
    'readFraction',
    'lockMs',
    'instances',
    'capacity',
    'serviceMs',
    'serviceCv',
    'queueLimit',
    'errorRate',
  ],
  // A queue is a buffer. Depth is the only thing that matters about it.
  queue: ['queueLimit', 'serviceMs'],
  // Workers drain a queue. No inbound queue limit of their own.
  worker: ['instances', 'capacity', 'serviceMs', 'serviceCv', 'errorRate'],
  // The three knobs that trade read scale against staleness, plus the
  // per-replica service cost.
  replica: [
    'replicaCount',
    'replicationLagMs',
    'readFraction',
    'capacity',
    'serviceMs',
    'serviceCv',
    'queueLimit',
  ],
  // Partition count and per-shard slots set the ceiling; hotKeyFraction
  // is the knob that destroys it.
  shard: [
    'shardCount',
    'shardCapacity',
    'hotKeyFraction',
    'serviceMs',
    'serviceCv',
    'queueLimit',
  ],
  // A controller has no request-path knobs at all: every field it exposes is
  // about the control loop it runs on the node it watches.
  autoscaler: [
    'targetUtil',
    'minCapacity',
    'maxCapacity',
    'cooldownMs',
    'scaleStepPct',
    'warmupMs',
  ],
  // Which region serves, how many there are, and what an outage costs.
  region: ['regions', 'activeRegion', 'failoverMs'],
  // A CDN is a cache whose whole story is the hit rate: how much load never
  // reaches you. Capacity and service time are shown because a saturated
  // edge is still a real failure mode.
  cdn: ['hitRate', 'instances', 'capacity', 'serviceMs', 'queueLimit'],
  // A limiter has exactly two knobs, and the pair is the lesson: sustained
  // rate, and how much burst you forgive on top of it.
  ratelimiter: ['rateLimitRps', 'burst'],
  // The four knobs of a breaker are the four questions it answers: how bad,
  // measured over how long, shut for how long, and reopened on what evidence.
  breaker: ['errorThreshold', 'windowMs', 'openMs', 'halfOpenProbes'],
  // Blob storage: a high flat latency, a wide pool, and the per-prefix rate
  // ceiling that is the real limit long before the pool is.
  objectstore: [
    'prefixRps',
    'capacity',
    'serviceMs',
    'serviceCv',
    'queueLimit',
    'errorRate',
  ],
  // The search trade: cheap queries, surcharged writes, and the refresh lag
  // that decides how stale a search can be.
  searchindex: [
    'readFraction',
    'indexMs',
    'indexLagMs',
    'instances',
    'capacity',
    'serviceMs',
    'serviceCv',
    'queueLimit',
  ],
  // Appends are the base cost; the two range-query knobs are what turn a
  // metrics firehose into a melted store.
  timeseriesdb: [
    'rangeQueryFraction',
    'rangeQueryMs',
    'instances',
    'capacity',
    'serviceMs',
    'serviceCv',
    'queueLimit',
  ],
  // One knob carries the lesson: every extra hop of depth multiplies cost.
  graphdb: [
    'traversalDepth',
    'instances',
    'capacity',
    'serviceMs',
    'serviceCv',
    'queueLimit',
  ],
  // The archive tier is deliberately knob-poor: seconds per request and few
  // slots ARE the component.
  coldstorage: ['capacity', 'serviceMs', 'serviceCv', 'queueLimit'],
  // Corpus size and recall target move query cost independently; the server
  // knobs underneath decide how much of that cost the pool can absorb.
  vectordb: [
    'indexSizeK',
    'recallTarget',
    'instances',
    'capacity',
    'serviceMs',
    'serviceCv',
    'queueLimit',
  ],
  // Partition count is the parallelism ceiling of every consumer group;
  // queueLimit is the log's retention in messages.
  streambroker: ['partitions', 'queueLimit', 'serviceMs'],
  // A topic has no knobs of its own: amplification comes from the wiring,
  // and the ack cost is the only thing to tune.
  pubsub: ['serviceMs'],
  // Capacity here is CONNECTIONS HELD per instance; connectionMs is how
  // long each one is held. serviceMs is only the handshake.
  websocket: ['connectionMs', 'instances', 'capacity', 'serviceMs', 'serviceCv'],
  // The front door: its own processing cost, a token bucket, and the auth
  // check, in one panel.
  apigateway: [
    'rateLimitRps',
    'burst',
    'authFailRate',
    'instances',
    'capacity',
    'serviceMs',
    'queueLimit',
  ],
  // The tax (serviceMs), and what it buys: retries with a per-attempt
  // deadline, and outlier ejection.
  sidecar: [
    'outlierAfter',
    'openMs',
    'retries',
    'timeoutMs',
    'instances',
    'capacity',
    'serviceMs',
    'queueLimit',
  ],
  // No fleet knobs at all: the platform scales it. What you tune is the
  // cold-start economics and the concurrency ceiling.
  lambda: [
    'coldStartMs',
    'keepWarmMs',
    'maxConcurrency',
    'serviceMs',
    'serviceCv',
    'errorRate',
  ],
  // A schedule and a payload size. Everything else about a cron job is
  // what it does to the nodes downstream of it.
  cron: ['intervalMs', 'batchSize'],
  // One knob, and it IS the component: how many calls may be outstanding
  // to the dependency behind it. errorRate and retries are deliberately
  // not offered here; both would make the pool count drift.
  bulkhead: ['bulkheadMax'],
  // Delivery concurrency, dispatch cost, buffer depth, and the redrive
  // policy: attempts and the per-attempt deadline.
  retryqueue: [
    'retries',
    'timeoutMs',
    'instances',
    'capacity',
    'serviceMs',
    'queueLimit',
  ],
  // The encode farm: boxes, jobs per box, seconds per job, and the quality
  // ladder each finished job hands downstream.
  transcoder: [
    'renditions',
    'instances',
    'capacity',
    'serviceMs',
    'serviceCv',
    'errorRate',
    'queueLimit',
  ],
  // The share it can answer locally, and the CPU budget that decides how
  // much of that share it actually gets to keep.
  edgecompute: [
    'edgeShare',
    'cpuMsCap',
    'instances',
    'capacity',
    'serviceMs',
    'queueLimit',
  ],
  // How long writes sit dirty, and how many may sit at once. `capacity`
  // here is the buffer (memory), not threads.
  writebehind: ['flushDelayMs', 'capacity', 'serviceMs', 'queueLimit'],
  // The limiter's bucket plus the two priority knobs that turn it from
  // fair refusal into deliberate triage.
  loadshedder: ['rateLimitRps', 'burst', 'lowPriorityShare', 'priorityReserve'],
};

/* ------------------------------------------------------------------ *
 * Field descriptors: label, unit, control shape, bounds.
 *
 * EVERY field carries a `unit`, including sliders. A slider's unit is
 * folded into its `display` string (`120ms`, `45%`, `12/s`) rather than
 * printed twice; the separate `unit` key is what the multi-edit summary
 * and the aria description use, so it is never absent.
 * ------------------------------------------------------------------ */

/**
 * One line of plain English disambiguating a knob whose NAME alone does not
 * carry its meaning.
 *
 * Reserved for genuine ambiguity, not decoration. The test a field has to
 * fail before it earns a hint: could a student who has never read the source
 * confuse this with the field next to it? `shardCount` and `shardCapacity`
 * fail it (one is a number of things, the other a rate per thing, and both
 * read as "how much shard"). `instances` and `capacity` fail it in exactly
 * the same way. `serviceMs` passes -- its label and unit already say
 * everything -- and gets no hint, because a hint on every field is noise that
 * teaches a student to stop reading them.
 */
type FieldHint = string;

export interface SliderSpec {
  control: 'slider';
  label: string;
  /** Stated for a11y and the multi-select summary; the display folds it in. */
  unit: string;
  hint?: FieldHint;
  /**
   * Glossary id for the label.
   *
   * DISTINCT FROM `hint`, and the two do different jobs. A hint is field
   * mechanics: what THIS control does to THIS component, and it is reserved
   * for genuine ambiguity between neighbouring fields. A term is the concept
   * behind the field, shared with every other surface that mentions it, and
   * it comes from the glossary so a student meets one definition of
   * "utilisation" rather than three.
   *
   * Left off where the label is already plain English describing itself
   * ("Never scale below", "Fires every"). A trigger there would promise an
   * explanation and then restate the label, which teaches a student that the
   * dotted underline is not worth following.
   */
  term?: string;
  min: number;
  max: number;
  step: number;
  /** Renders the live value shown to the right of the track. */
  display: (v: number) => string;
}

export interface NumberSpec {
  control: 'number';
  label: string;
  unit: string;
  hint?: FieldHint;
  /** Glossary id for the label. See SliderSpec.term. */
  term?: string;
  min: number;
  max: number;
  step: number;
}

export type FieldSpec = SliderSpec | NumberSpec;

export const FIELD_SPECS: Record<Field, FieldSpec> = {
  rps: {
    control: 'slider',
    term: 'offered',
    label: 'Offered load',
    unit: 'requests per second',
    min: 1,
    max: 5000,
    step: 1,
    display: (v) => formatRate(v),
  },
  instances: {
    control: 'number',
    term: 'instances',
    label: 'Instances',
    unit: 'machines',
    hint: 'How many copies of this component are running. This is what an autoscaler adds and removes.',
    min: 1,
    max: 512,
    step: 1,
  },
  capacity: {
    control: 'number',
    term: 'capacity',
    label: 'Slots per instance',
    unit: 'at once, on one machine',
    hint: 'How many requests ONE machine handles at a time. Total parallelism is instances x this.',
    min: 1,
    max: 4096,
    step: 1,
  },
  serviceMs: {
    control: 'slider',
    term: 'service-time',
    label: 'Service time',
    unit: 'milliseconds',
    min: 0.1,
    max: 500,
    step: 0.1,
    display: (v) => formatMs(v),
  },
  serviceCv: {
    control: 'slider',
    term: 'service-cv',
    label: 'How uneven the work is',
    unit: 'coefficient of variation',
    min: 0,
    max: 2,
    step: 0.05,
    display: (v) => (v === 0 ? 'every one the same' : v.toFixed(2)),
  },
  queueLimit: {
    control: 'number',
    term: 'queue-limit',
    label: 'Most that can wait in line',
    unit: 'at most',
    min: 0,
    max: 20000,
    step: 1,
  },
  hitRate: {
    control: 'slider',
    term: 'hit-rate',
    label: 'Hit rate you set',
    unit: 'percent',
    hint: 'Each cache or CDN rolls this chance on its own. Two at 80% leave about 4% of traffic for whatever is behind them, because the chances multiply.',
    min: 0,
    max: 1,
    step: 0.01,
    display: (v) => formatPct(v),
  },
  errorRate: {
    control: 'slider',
    term: 'error-rate',
    label: 'Error rate',
    unit: 'percent',
    min: 0,
    max: 1,
    step: 0.005,
    display: (v) => formatPct(v),
  },
  timeoutMs: {
    control: 'slider',
    term: 'timeout',
    label: 'Timeout',
    unit: 'milliseconds',
    min: 0,
    max: 5000,
    step: 10,
    display: (v) => (v === 0 ? 'none' : formatMs(v)),
  },
  retries: {
    control: 'number',
    term: 'retry',
    label: 'Retries',
    unit: 'extra tries',
    min: 0,
    max: 10,
    step: 1,
  },
  replicaCount: {
    control: 'number',
    term: 'read-replica',
    label: 'Read replicas',
    unit: 'copies, besides the primary',
    hint: 'Read-only copies behind the primary. They add READ capacity only; every write still goes through the one primary.',
    min: 1,
    max: 64,
    step: 1,
  },
  replicationLagMs: {
    control: 'slider',
    term: 'replication-lag',
    label: 'Replication lag',
    unit: 'milliseconds',
    min: 0,
    max: 2000,
    step: 5,
    display: (v) => (v === 0 ? 'synchronous' : formatMs(v)),
  },
  readFraction: {
    control: 'slider',
    term: 'read-fraction',
    label: 'Reads, as a share of traffic',
    unit: 'percent of traffic',
    min: 0,
    max: 1,
    step: 0.01,
    display: (v) => formatPct(v),
  },
  shardCount: {
    control: 'number',
    term: 'shard',
    label: 'Shards',
    unit: 'partitions',
    hint: 'How many partitions the data is split across. A key goes to exactly one of them.',
    min: 1,
    max: 64,
    step: 1,
  },
  shardCapacity: {
    control: 'number',
    term: 'capacity',
    label: 'Slots per shard',
    unit: 'at once, on one shard',
    hint: 'How many requests ONE partition handles at a time. A hot key can only ever use its own shard\u2019s slots.',
    min: 1,
    max: 512,
    step: 1,
  },
  hotKeyFraction: {
    control: 'slider',
    term: 'hot-key',
    label: 'Traffic hitting one hot key',
    unit: 'percent onto one shard',
    min: 0,
    max: 1,
    step: 0.01,
    display: (v) => (v === 0 ? 'even' : formatPct(v)),
  },
  targetUtil: {
    control: 'slider',
    term: 'target-util',
    label: 'Keep utilisation near',
    unit: 'percent',
    min: 0.1,
    max: 0.95,
    step: 0.05,
    display: (v) => formatPct(v),
  },
  minCapacity: {
    control: 'number',
    label: 'Never scale below',
    unit: 'at once',
    min: 1,
    max: 512,
    step: 1,
  },
  maxCapacity: {
    control: 'number',
    label: 'Never scale above',
    unit: 'at once',
    min: 1,
    max: 512,
    step: 1,
  },
  cooldownMs: {
    control: 'slider',
    term: 'autoscaler',
    label: 'Wait between changes',
    unit: 'milliseconds',
    min: 0,
    max: 30000,
    step: 250,
    display: (v) => formatMs(v),
  },
  scaleStepPct: {
    control: 'slider',
    label: 'Change capacity by',
    unit: 'percent of capacity',
    min: 0.05,
    max: 1,
    step: 0.05,
    display: (v) => formatPct(v),
  },
  warmupMs: {
    control: 'slider',
    term: 'warmup',
    label: 'New capacity takes',
    unit: 'milliseconds',
    min: 0,
    max: 60000,
    step: 500,
    display: (v) => (v === 0 ? 'instant' : formatMs(v)),
  },
  regions: {
    control: 'number',
    term: 'region',
    label: 'Regions',
    unit: 'regions',
    hint: 'How many regions exist in total. Only one of them serves traffic at a time; which one is a separate number, below.',
    min: 1,
    max: 8,
    step: 1,
  },
  activeRegion: {
    control: 'number',
    term: 'region',
    label: 'Serving from region',
    unit: 'number',
    hint: 'WHICH region is serving right now, not how many exist. Change it to move service to a different region without crashing anything.',
    min: 0,
    max: 7,
    step: 1,
  },
  failoverMs: {
    control: 'slider',
    term: 'region',
    label: 'Failover takes',
    unit: 'milliseconds',
    hint: 'How long every request fails for after the active region goes down and before the next one takes over. Nothing is served in that window, however many healthy regions are left.',
    min: 0,
    max: 60000,
    step: 500,
    display: (v) => (v === 0 ? 'instant' : formatMs(v)),
  },
  rateLimitRps: {
    control: 'slider',
    term: 'rate-limiter',
    label: 'Rate limit',
    unit: 'requests per second',
    min: 0,
    max: 2000,
    step: 5,
    display: (v) => (v === 0 ? 'unlimited' : formatRate(Math.round(v))),
  },
  burst: {
    control: 'number',
    term: 'burst',
    label: 'Burst allowance',
    unit: 'requests',
    min: 1,
    max: 5000,
    step: 1,
  },
  errorThreshold: {
    control: 'slider',
    term: 'breaker',
    label: 'Trip when errors reach',
    unit: 'percent',
    min: 0,
    max: 1,
    step: 0.05,
    display: (v) => formatPct(v),
  },
  windowMs: {
    control: 'slider',
    label: 'Measured over',
    unit: 'milliseconds',
    min: 200,
    max: 30000,
    step: 100,
    display: (v) => formatMs(v),
  },
  openMs: {
    control: 'slider',
    term: 'breaker',
    label: 'Stay open for',
    unit: 'milliseconds',
    min: 100,
    max: 60000,
    step: 100,
    display: (v) => formatMs(v),
  },
  halfOpenProbes: {
    control: 'number',
    term: 'breaker',
    label: 'Test requests before closing',
    unit: 'requests',
    min: 1,
    max: 50,
    step: 1,
  },
  indexMs: {
    control: 'slider',
    label: 'Indexing cost per write',
    unit: 'extra milliseconds per write',
    hint: 'What a write pays ON TOP of the service time, to update the index. Searches never pay it.',
    min: 0,
    max: 500,
    step: 5,
    display: (v) => (v === 0 ? 'free' : `+${formatMs(v)}`),
  },
  indexLagMs: {
    control: 'slider',
    term: 'stale-search',
    label: 'Searchable after',
    unit: 'milliseconds after a write commits',
    hint: 'The refresh interval: how long after a write commits before searches can see it. Searches inside that window read the old index.',
    min: 0,
    max: 10000,
    step: 100,
    display: (v) => (v === 0 ? 'instantly' : formatMs(v)),
  },
  rangeQueryFraction: {
    control: 'slider',
    term: 'range-query',
    label: 'Traffic that is range queries',
    unit: 'percent of traffic',
    min: 0,
    max: 1,
    step: 0.01,
    display: (v) => (v === 0 ? 'appends only' : formatPct(v)),
  },
  rangeQueryMs: {
    control: 'slider',
    term: 'range-query',
    label: 'Range query costs',
    unit: 'extra milliseconds per range query',
    hint: 'What a range query pays ON TOP of the service time, to scan and aggregate. Appends never pay it.',
    min: 0,
    max: 2000,
    step: 10,
    display: (v) => (v === 0 ? 'free' : `+${formatMs(v)}`),
  },
  traversalDepth: {
    control: 'number',
    term: 'traversal-depth',
    label: 'Traversal depth',
    unit: 'hops',
    hint: 'How many hops each query walks. Every extra hop multiplies the work by about 3, so depth 3 costs 9x depth 1.',
    min: 1,
    max: 6,
    step: 1,
  },
  indexSizeK: {
    control: 'slider',
    label: 'Index size',
    unit: 'thousands of vectors',
    min: 1,
    max: 100000,
    step: 1,
    display: (v) =>
      v >= 1000
        ? `${(v / 1000).toFixed(v >= 10000 ? 0 : 1)}M vectors`
        : `${Math.round(v)}K vectors`,
  },
  recallTarget: {
    control: 'slider',
    term: 'recall',
    label: 'Recall target',
    unit: 'fraction of true neighbours found',
    hint: 'How close to perfect the search must be. Cost scales with 1 / (1 - recall): the last percent costs more than everything before it.',
    min: 0.5,
    max: 0.99,
    step: 0.01,
    display: (v) => formatPct(v),
  },
  partitions: {
    control: 'number',
    term: 'partitions',
    label: 'Partitions',
    unit: 'partitions',
    hint: 'A message lands in one partition by key, and a consumer group takes at most one message per partition at a time, so this is the most a group can do in parallel.',
    min: 1,
    max: 64,
    step: 1,
  },
  connectionMs: {
    control: 'slider',
    term: 'connection-slot',
    label: 'Connection lifetime',
    unit: 'milliseconds held',
    hint: 'How long each accepted connection occupies a slot. Held connections settle at rate x lifetime, which is the number that actually saturates.',
    min: 500,
    max: 120000,
    step: 500,
    display: (v) => formatMs(v),
  },
  authFailRate: {
    control: 'slider',
    label: 'Failing auth',
    unit: 'percent of requests',
    min: 0,
    max: 0.5,
    step: 0.005,
    display: (v) => formatPct(v),
  },
  outlierAfter: {
    control: 'number',
    label: 'Eject after',
    unit: 'consecutive failures',
    hint: 'Straight downstream failures before the proxy stops calling it for a while. Simpler than the breaker on purpose; this is how sidecar outlier detection actually works.',
    min: 1,
    max: 50,
    step: 1,
  },
  coldStartMs: {
    control: 'slider',
    term: 'cold-start',
    label: 'Cold start costs',
    unit: 'extra milliseconds',
    min: 0,
    max: 5000,
    step: 25,
    display: (v) => (v === 0 ? 'free' : formatMs(v)),
  },
  keepWarmMs: {
    control: 'slider',
    term: 'cold-start',
    label: 'Instances stay warm',
    unit: 'milliseconds after finishing',
    hint: 'How long a finished instance waits, warm, before the platform reclaims it. Shorter keep-warm means more cold starts on the next burst.',
    min: 0,
    max: 60000,
    step: 500,
    display: (v) => (v === 0 ? 'reclaim at once' : formatMs(v)),
  },
  maxConcurrency: {
    control: 'number',
    term: 'capacity',
    label: 'Concurrency cap',
    unit: 'invocations at once',
    hint: 'The platform limit. Past it requests are throttled immediately; a lambda has no queue to wait in.',
    min: 1,
    max: 1000,
    step: 1,
  },
  intervalMs: {
    control: 'slider',
    label: 'Fires every',
    unit: 'milliseconds',
    min: 1000,
    max: 120000,
    step: 1000,
    display: (v) => formatMs(v),
  },
  batchSize: {
    control: 'number',
    label: 'Requests per firing',
    unit: 'per outgoing edge, at once',
    min: 1,
    max: 2000,
    step: 1,
  },
  bulkheadMax: {
    control: 'number',
    term: 'bulkhead',
    label: 'Calls in flight, at most',
    unit: 'to the dependency behind it',
    hint: 'The pool. Roughly this divided by the dependency\u2019s latency in seconds is the admission ceiling.',
    min: 1,
    max: 512,
    step: 1,
  },
  flushDelayMs: {
    control: 'slider',
    term: 'dirty-write',
    label: 'Writes sit dirty for',
    unit: 'milliseconds',
    hint: 'Time between the ack and the flush landing. Everything inside this window is lost if the node crashes.',
    min: 0,
    max: 10000,
    step: 50,
    display: (v) => (v === 0 ? 'instant flush' : formatMs(v)),
  },
  edgeShare: {
    control: 'slider',
    term: 'edgecompute',
    label: 'Answered at the edge',
    unit: 'percent of requests',
    min: 0,
    max: 1,
    step: 0.01,
    display: (v) => formatPct(v),
  },
  lowPriorityShare: {
    control: 'slider',
    term: 'loadshedder',
    label: 'Low-priority traffic',
    unit: 'percent of traffic',
    hint: 'Derived from the request key, so the same caller is always the same priority.',
    min: 0,
    max: 1,
    step: 0.01,
    display: (v) => formatPct(v),
  },
  priorityReserve: {
    control: 'slider',
    term: 'loadshedder',
    label: 'Reserved for high priority',
    unit: 'percent of the bucket',
    hint: 'Low-priority requests must leave this share of tokens untouched, which is why they are dropped first.',
    min: 0,
    max: 0.9,
    step: 0.05,
    display: (v) => formatPct(v),
  },
  lockMs: {
    control: 'slider',
    term: 'lock-contention',
    label: 'Lock wait per concurrent write',
    unit: 'milliseconds each',
    hint: 'Each write entering service waits this long for every write already in flight. Fleet size does not appear in that sentence, which is the lesson.',
    min: 0,
    max: 100,
    step: 1,
    display: (v) => (v === 0 ? 'no contention' : formatMs(v)),
  },
  prefixRps: {
    control: 'slider',
    term: 'prefix-ceiling',
    label: 'Ceiling per key prefix',
    unit: 'requests per second, each prefix',
    hint: 'Keys map onto 8 prefixes. Evenly spread traffic sustains 8x this; a hot prefix gets exactly 1x and then slowdowns, however idle the pool is.',
    min: 0,
    max: 1000,
    step: 10,
    display: (v) => (v === 0 ? 'no limit' : `${v}/s`),
  },
  renditions: {
    control: 'number',
    term: 'rendition',
    label: 'Renditions per job',
    unit: 'output files, per finished job',
    hint: 'The quality ladder. Storage behind the farm sees this many uploads per job, so its write load is this times the job rate.',
    min: 1,
    max: 12,
    step: 1,
  },
  cpuMsCap: {
    control: 'slider',
    term: 'cpu-budget',
    label: 'CPU budget per request',
    unit: 'milliseconds of execution',
    hint: 'A request that runs past this is killed at the edge and sent to the origin anyway. Heavier edge code blows the budget more often.',
    min: 0,
    max: 50,
    step: 0.5,
    display: (v) => (v === 0 ? 'no budget' : formatMs(v)),
  },
};

/* ------------------------------------------------------------------ *
 * Per-kind overrides of a shared field's wording.
 *
 * A field id is shared machinery; what it MEANS can differ by kind, and the
 * label must say what the engine will actually do with the number. The
 * shared `capacity` spec reads "How many requests ONE machine handles at a
 * time", which is flatly wrong on a websocket gateway (a slot there is a
 * HELD CONNECTION) and on a write-behind cache (the buffer is memory, not
 * threads). Same for the autoscaler's bounds, whose unit is INSTANCES since
 * the instance-model revision, and the broker's queueLimit, which is the
 * log's RETENTION. Only wording is overridden here, never bounds or control
 * shape, so the engine-facing semantics of the field cannot fork.
 * ------------------------------------------------------------------ */

const KIND_FIELD_OVERRIDES: Partial<
  Record<NodeKind, Partial<Record<Field, Partial<FieldSpec>>>>
> = {
  websocket: {
    capacity: {
      // Overrides the shared `capacity` term too: a slot here is a held
      // connection, and pointing this at the generic capacity entry would
      // explain the wrong idea to the one kind that most needs the right one.
      term: 'connection-slot',
      label: 'Connections per instance',
      unit: 'held at once, on one machine',
      hint: 'A slot here is a held connection, not a request in service. Held connections settle at connect rate x lifetime, which is the number that saturates.',
    },
  },
  writebehind: {
    capacity: {
      term: 'dirty-write',
      label: 'Dirty writes held',
      unit: 'buffered at once',
      hint: 'The buffer is memory: how many acknowledged writes may sit dirty at once. It is not a thread count.',
    },
  },
  streambroker: {
    queueLimit: {
      term: 'retention',
      label: 'Retention',
      unit: 'messages kept, per partition',
      hint: 'How far back the log keeps messages. A consumer group that falls further behind than this skips ahead, and the skipped messages are lost to it.',
    },
  },
  autoscaler: {
    minCapacity: { unit: 'instances' },
    maxCapacity: { unit: 'instances' },
    scaleStepPct: { label: 'Change the fleet by', unit: 'percent of instances' },
  },
};

/** The spec actually rendered for `field` on a node of `kind`. */
export function specFor(kind: NodeKind, field: Field): FieldSpec {
  const base = FIELD_SPECS[field];
  const patch = KIND_FIELD_OVERRIDES[kind]?.[field];
  return patch ? ({ ...base, ...patch } as FieldSpec) : base;
}
