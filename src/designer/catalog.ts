import type { NodeKind } from '../sim/types.ts';
import { NODE_KINDS } from '../clipboard.ts';
import { FIELDS_BY_KIND, specFor, type Field } from './config.ts';

const KIND_NAME: Record<NodeKind, string> = {
  client: 'Client',
  lb: 'Load balancer',
  service: 'Service',
  cache: 'Cache',
  db: 'Database',
  queue: 'Queue',
  worker: 'Worker',
  replica: 'Read replicas',
  shard: 'Sharded store',
  autoscaler: 'Autoscaler',
  region: 'Region',
  cdn: 'CDN',
  ratelimiter: 'Rate limiter',
  breaker: 'Circuit breaker',
  objectstore: 'Object storage',
  searchindex: 'Search index',
  timeseriesdb: 'Time-series store',
  graphdb: 'Graph database',
  coldstorage: 'Cold storage',
  vectordb: 'Vector database',
  streambroker: 'Stream broker',
  pubsub: 'Pub/sub topic',
  websocket: 'WebSocket gateway',
  apigateway: 'API gateway',
  sidecar: 'Sidecar proxy',
  lambda: 'Lambda',
  cron: 'Cron job',
  bulkhead: 'Bulkhead',
  retryqueue: 'Retry queue',
  transcoder: 'Transcoder',
  edgecompute: 'Edge compute',
  writebehind: 'Write-behind cache',
  loadshedder: 'Load shedder',
};

export const KIND_BLURB: Record<NodeKind, string> = {
  client:
    'Offers load and waits for an answer. Its timeout decides when a slow reply becomes a failure.',
  lb: 'Spreads requests across its targets. Its own pool and backlog can saturate before theirs do.',
  service:
    'The workhorse. How many it handles at once, divided by how long each takes, is the ceiling everything else queues behind.',
  cache:
    'Answers hits without touching downstream. Each cache rolls its own hit chance, independently of the others, so stacking them multiplies misses rather than treating later caches as filters on earlier misses.',
  db: 'Slots and service time. It does not retry for you, so its queue is where pressure shows.',
  queue:
    'A buffer. Depth is the whole story: it absorbs bursts up to the limit, then sheds.',
  worker:
    'Drains a queue at its own pace. Too few workers and the backlog never recovers.',
  replica:
    'Reads scale with the replica count, but a read can arrive before the last write has propagated. Watch the stale rate as you raise the lag.',
  shard:
    'Splits data across partitions by key, so capacity adds up, until one key gets hot and a single shard has to carry it alone.',
  autoscaler:
    'Watches one node and adds capacity when it runs hot. New capacity takes warmup time to arrive, so load always leads it.',
  region:
    'Sends traffic to one region at a time. If that region dies, failover costs you a full outage window before the next one takes over.',
  cdn: 'An edge cache in front of everything. At a 0.9 hit rate one CDN leaves a tenth of the traffic for the origin, and that chance is rolled independently of every other cache on the path. It is still the cheapest capacity you will ever add.',
  ratelimiter:
    'A token bucket. Refuses excess traffic instantly instead of queueing it, which is what stops a busy system turning into a dead one.',
  breaker:
    'Watches its downstream and stops calling it once it is failing. Cutting the traffic to zero is what gives a struggling dependency room to recover.',
  objectstore:
    'Blob storage. Every request pays a high flat latency, but the pool is wide enough that saturating it takes deliberate effort. Not a database, and that is the point.',
  searchindex:
    'Searches are cheap; writes pay an indexing surcharge and only become searchable after the refresh lag. The stale-search rate is that lag made visible.',
  timeseriesdb:
    'Built to swallow appends by the thousand. A range query costs hundreds of appends, so a few percent of them dominates the store, which is why metrics do not live in your main database.',
  graphdb:
    'Stores relationships. Every extra hop of traversal depth multiplies the edges visited by three, so a friends-of-friends query costs triple and one more hop triples it again.',
  coldstorage:
    'The archive tier: cheap to keep, seconds to read. Fine for a trickle of restores behind a queue, hopeless for anything a user is waiting on.',
  vectordb:
    'Similarity search over embeddings. Cost grows with the log of the corpus and explodes as recall approaches perfect, so the recall slider is a latency slider read backwards.',
  streambroker:
    'A partitioned, replayable log. Producers are acked instantly; each outgoing edge is an independent consumer group whose lag grows when its consumers are slower than the producers. Partition count, not consumer count, caps how fast a group can drain.',
  pubsub:
    'One publish becomes one delivery per subscriber. A slow subscriber sheds at its own node without delaying the others, but the total load is multiplied by the fan-out, whether you noticed or not.',
  websocket:
    'Holds long-lived connections. Capacity is concurrent connections held, not requests per second: at 30 new connections a second held 8 seconds each, 240 slots are simply occupied. Chat systems run out of sockets long before they run out of CPU.',
  apigateway:
    'The front door: authenticates, rate limits, and routes each request to the backend its weights choose. Three components worth of refusals happen here so the backends only ever see traffic worth serving.',
  sidecar:
    'A proxy beside one service. It charges its service time on every single request, and pays you back with retries, a per-attempt deadline, and ejecting the upstream after repeated failures. Put one at every hop and watch the taxes stack; that is a service mesh.',
  lambda:
    'Scales instantly with load, up to its concurrency cap, and there is no queue past it. The catch is the cold start: a request that finds no warm instance pays a large extra latency, so idle periods and bursts are exactly when it is slowest.',
  cron: 'Fires on a schedule and dumps its whole batch at once. The database that handles the steady daytime load falls over at midnight not because traffic grew, but because this arrived all in the same instant.',
  bulkhead:
    'Caps how many calls may be outstanding to the dependency behind it. When that dependency slows down, the pool fills within one round trip and the excess fails fast here, instead of queueing behind a sick service.',
  retryqueue:
    'Acks the sender instantly, delivers downstream itself, and redelivers failures with backoff. Messages that fail every attempt land on the dead letter shelf: counted, not vanished.',
  transcoder:
    'A batch farm: jobs take seconds, so throughput is boxes times jobs-per-box divided by job time. Feed it from a queue, and size it against arrivals, because a structural deficit grows the backlog forever.',
  edgecompute:
    'A small function running in the PoP. The share of requests it can fully answer never touches your origin; the rest pass through. Unlike a CDN hit rate, that share is a property of your code, not your traffic.',
  writebehind:
    'Acknowledges writes from memory and flushes them to the store later. The caller sees a one-millisecond write; the store sees the same load smoothed. Crash it, and every write still in the buffer is lost after being confirmed.',
  loadshedder:
    'A token bucket that refuses by priority: low-priority traffic must leave a reserve untouched, so under saturation it is dropped first while the traffic that matters keeps being admitted. Degradation as a policy, not an accident.',
};

export const componentCatalog: {
  kind: NodeKind;
  label: string;
  description: string;
}[] = NODE_KINDS.map((kind) => ({
  kind,
  label: KIND_NAME[kind],
  description: KIND_BLURB[kind],
}));
export interface ConfigField {
  field: Field;
  label: string;
  unit: string;
  min: number;
  max: number;
  step: number;
}
export function configFieldsFor(kind: NodeKind): ConfigField[] {
  return FIELDS_BY_KIND[kind].map((field) => {
    const { label, unit, min, max, step } = specFor(kind, field);
    return { field, label, unit, min, max, step };
  });
}
