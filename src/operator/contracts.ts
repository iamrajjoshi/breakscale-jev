import { NODE_KINDS } from '../clipboard.ts';
import { FIELDS_BY_KIND } from '../designer/config.ts';
import { behaviourFor } from '../sim/behaviour.ts';
import { defaultConfig } from '../sim/presets.ts';
import type { NodeKind, SimSnapshot, Topology } from '../sim/types.ts';

export const MODEL = 'jev-1.13.0';
export const CALL_LIMIT = 18;
export const CALL_WINDOW_MS = 60000;
export const MAX_REPAIR_INSTANCES = 128;
export const MAX_REPAIR_CAPACITY = 512;
export type Mode = 'command' | 'operator';
export interface Observation {
  nodes: {
    id: string;
    label: string;
    kind: string;
    instances: number;
    retries: number;
    rps: number;
    capacity: number;
    serviceMs: number;
    utilization: number;
    queued: number;
    p99: number;
    errorRate: number;
    /** Authored failure probability, separate from the measured outcome rate. */
    configuredErrorRate?: number;
    /** Database settings and measured write contention; absent for other kinds. */
    lockMs?: number;
    lockWaitMs?: number;
    writeRate?: number;
    fault: string | null;
  }[];
  edges: { from: string; to: string }[];
  system: {
    timeMs: number;
    offeredRps: number;
    goodputRps: number;
    errorRate: number;
    p99: number;
  };
}
export type Action =
  | { id: string; kind: 'repair'; nodeId: string; label: string }
  | { id: string; kind: 'crash'; nodeId: string; label: string }
  | { id: string; kind: 'slow'; nodeId: string; label: string }
  | { id: string; kind: 'scale'; nodeId: string; value: number; label: string }
  | { id: string; kind: 'capacity'; nodeId: string; value: number; label: string }
  | { id: string; kind: 'service-time'; nodeId: string; value: number; label: string }
  | { id: string; kind: 'error-rate'; nodeId: string; value: number; label: string }
  | { id: string; kind: 'retries'; nodeId: string; value: number; label: string }
  | { id: string; kind: 'traffic'; value: number; label: string }
  | { id: string; kind: 'wait'; label: string }
  | { id: string; kind: 'unsupported'; label: string };
export interface DecisionRequest {
  sessionId: string;
  prompt: string;
  mode: Mode;
  observation: Observation;
  recovery?: {
    consecutiveWaits: number;
    previousWait?: Observation['system'];
  };
}
export interface Decision {
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
  model: string;
  usage: { input_tokens: number; output_tokens: number };
  durationMs: number;
  callsRemaining: number;
}
export function observe(topology: Topology, snapshot: SimSnapshot): Observation {
  return {
    nodes: topology.nodes.map((node) => {
      const stats = snapshot.nodes[node.id];
      return {
        id: node.id,
        label: node.label,
        kind: node.kind,
        instances:
          behaviourFor(node.kind).scaleField === 'instances'
            ? (stats?.instances ?? node.config.instances ?? 1)
            : (node.config.instances ?? 1),
        retries: node.config.retries,
        rps: node.config.rps,
        capacity: node.config.capacity,
        serviceMs: node.config.serviceMs,
        utilization: stats?.utilization ?? 0,
        queued: stats?.queued ?? 0,
        p99: stats?.p99 ?? 0,
        errorRate: stats?.errorRate ?? 0,
        configuredErrorRate: node.config.errorRate,
        ...(node.kind === 'db'
          ? {
              lockMs: node.config.lockMs ?? 0,
              lockWaitMs: stats?.lockWaitMs ?? 0,
              writeRate: stats?.writeRate ?? 0,
            }
          : {}),
        fault: snapshot.activeFailures.find((f) => f.nodeId === node.id)?.kind ?? null,
      };
    }),
    edges: topology.edges.map((edge) => ({ from: edge.from, to: edge.to })),
    system: {
      timeMs: snapshot.system.timeMs,
      offeredRps: snapshot.system.offeredRps,
      goodputRps: snapshot.system.goodputRps,
      errorRate: snapshot.system.errorRate,
      p99: snapshot.system.p99,
    },
  };
}
const kinds = new Set<string>(NODE_KINDS);
const scalable = new Set<string>(
  NODE_KINDS.filter((kind) => behaviourFor(kind).scaleField === 'instances'),
);
// CDN and replica pools read capacity, but do not expose an instance fleet.
const capacityKinds = new Set([...scalable, 'cdn', 'replica', 'coldstorage']);
const errorRateKinds = new Set<string>(
  NODE_KINDS.filter((kind) => FIELDS_BY_KIND[kind].includes('errorRate')),
);
type ObservedNode = Observation['nodes'][number];
/** A shared data lock is not additional request-slot capacity. */
export function hasWriteContention(node: ObservedNode): boolean {
  return (
    node.kind === 'db' &&
    (node.lockWaitMs ?? 0) > node.serviceMs &&
    (node.writeRate ?? 0) > 0
  );
}
function queuedUnderPressure(node: ObservedNode): boolean {
  return node.queued > Math.max(4, node.capacity * node.instances);
}
function nodeUnderPressure(node: ObservedNode): boolean {
  return node.utilization >= 0.9 || queuedUnderPressure(node) || node.errorRate >= 0.03;
}
export interface Incident {
  kind: 'fault' | 'overload' | 'errors';
  nodeIds: string[];
  summary: string;
}
/** A call gate, not an action policy: JEV still chooses every repair. */
export function incidentFor(state: Observation): Incident | null {
  const faults = state.nodes.filter((node) => node.fault !== null);
  if (faults.length)
    return {
      kind: 'fault',
      nodeIds: faults.map((node) => node.id),
      summary: `${faults.map((node) => node.label).join(', ')} ${faults.length === 1 ? 'has an active fault' : 'have active faults'}`,
    };
  // Let the simulation start serving before interpreting incomplete metrics.
  if (state.system.timeMs < 2000) return null;
  const throughputGap =
    state.system.timeMs >= 3000 &&
    state.system.offeredRps > 0 &&
    state.system.goodputRps < state.system.offeredRps * 0.85;
  const overloaded = state.nodes.filter(
    (node) =>
      node.kind !== 'client' &&
      (queuedUnderPressure(node) ||
        (node.utilization >= 0.9 && (node.queued >= 2 || throughputGap))),
  );
  if (overloaded.length)
    return {
      kind: 'overload',
      nodeIds: overloaded.map((node) => node.id),
      summary: `Requests are backing up at ${overloaded.map((node) => node.label).join(', ')}`,
    };
  const failing = state.nodes.filter(
    (node) => node.kind !== 'client' && node.errorRate >= 0.03,
  );
  if (state.system.errorRate >= 0.03 || failing.length)
    return {
      kind: 'errors',
      nodeIds: failing.map((node) => node.id),
      summary: failing.length
        ? `Requests are failing at ${failing.map((node) => node.label).join(', ')}`
        : 'Requests are failing in the system',
    };
  return null;
}
export function actionsFor(state: Observation, mode: Mode): Action[] {
  const actions: Action[] = [
    { id: 'wait', kind: 'wait', label: 'Observe without changing the system' },
  ];
  actions.push({
    id: 'unsupported',
    kind: 'unsupported',
    label:
      mode === 'command'
        ? 'The request cannot be performed with the available controls'
        : 'None of the available changes can address the observed problem; intervention outside this repair menu is needed',
  });
  for (const [index, node] of state.nodes.entries()) {
    if (node.fault)
      actions.push({
        id: `repair_${index}`,
        kind: 'repair',
        nodeId: node.id,
        label: `Repair ${node.label}: clear its ${node.fault} fault`,
      });
    const pressure = mode === 'command' || nodeUnderPressure(node);
    const capacityCanHelp = mode === 'command' || !hasWriteContention(node);
    if (
      pressure &&
      errorRateKinds.has(node.kind) &&
      node.configuredErrorRate !== undefined
    ) {
      const baseline = defaultConfig(node.kind as NodeKind).errorRate;
      if (node.configuredErrorRate > baseline)
        actions.push({
          id: `errors_${index}`,
          kind: 'error-rate',
          nodeId: node.id,
          value: baseline,
          label: `Restore ${node.label} configured error probability from ${node.configuredErrorRate * 100}% to the component default ${baseline * 100}%`,
        });
    }
    const nextInstances = Math.min(MAX_REPAIR_INSTANCES, node.instances * 2);
    if (
      pressure &&
      capacityCanHelp &&
      scalable.has(node.kind) &&
      nextInstances > node.instances
    )
      actions.push({
        id: `scale_${index}`,
        kind: 'scale',
        nodeId: node.id,
        value: nextInstances,
        label: `Scale ${node.label} from ${node.instances} to ${nextInstances} instances`,
      });
    if (pressure && capacityKinds.has(node.kind)) {
      const defaults = defaultConfig(node.kind as NodeKind);
      const nextCapacity = Math.min(
        MAX_REPAIR_CAPACITY,
        Math.max(defaults.capacity, Math.ceil(node.capacity * 2)),
      );
      if (capacityCanHelp && nextCapacity > node.capacity)
        actions.push({
          id: `capacity_${index}`,
          kind: 'capacity',
          nodeId: node.id,
          value: nextCapacity,
          label: `Increase ${node.label} capacity from ${node.capacity} to ${nextCapacity} concurrent slots per instance`,
        });
      if (node.serviceMs > defaults.serviceMs * 2 && defaults.serviceMs > 0)
        actions.push({
          id: `latency_${index}`,
          kind: 'service-time',
          nodeId: node.id,
          value: defaults.serviceMs,
          label: `Restore ${node.label} service-time setting from ${node.serviceMs}ms to the component default ${defaults.serviceMs}ms`,
        });
    }
    if (node.retries > 0 && node.kind !== 'client')
      actions.push({
        id: `retries_${index}`,
        kind: 'retries',
        nodeId: node.id,
        value: 0,
        label: `Disable retries on ${node.label}`,
      });
    if (mode === 'command' && node.kind !== 'client') {
      actions.push({
        id: `crash_${index}`,
        kind: 'crash',
        nodeId: node.id,
        label: `Crash ${node.label}`,
      });
      actions.push({
        id: `slow_${index}`,
        kind: 'slow',
        nodeId: node.id,
        label: `Make ${node.label} five times slower`,
      });
    }
  }
  const offered = state.nodes
    .filter((node) => node.kind === 'client')
    .reduce((sum, node) => sum + node.rps, 0);
  if (mode === 'command' && offered > 0 && offered < 10000) {
    actions.push({
      id: 'traffic_up',
      kind: 'traffic',
      value: Math.min(10000, offered * 2),
      label: `Double traffic (${Math.min(10000, offered * 2)} requests/second)`,
    });
  }
  if (mode === 'command' && offered > 1) {
    actions.push({
      id: 'traffic_down',
      kind: 'traffic',
      value: Math.max(1, offered / 2),
      label: `Halve traffic (${Math.max(1, offered / 2)} requests/second)`,
    });
  }
  return actions;
}
/** Metrics keep changing during inference; structural edits and failures invalidate a decision. */
export function decisionFingerprint(topology: Topology, snapshot: SimSnapshot): string {
  return JSON.stringify({
    nodes: topology.nodes.map((node) => ({
      id: node.id,
      label: node.label,
      kind: node.kind,
      config: node.config,
    })),
    edges: topology.edges,
    faults: snapshot.activeFailures,
  });
}
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function finite(value: unknown, max = 1e12): value is number {
  return (
    typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max
  );
}
function validSystem(value: unknown): boolean {
  return (
    object(value) &&
    ['timeMs', 'offeredRps', 'goodputRps', 'errorRate', 'p99'].every((key) =>
      finite(value[key]),
    ) &&
    (value.errorRate as number) <= 1
  );
}
export function validRequest(value: unknown): value is DecisionRequest {
  if (
    !object(value) ||
    typeof value.sessionId !== 'string' ||
    !/^[a-zA-Z0-9-]{16,80}$/.test(value.sessionId) ||
    typeof value.prompt !== 'string' ||
    !value.prompt.trim() ||
    value.prompt.length > 600 ||
    !['command', 'operator'].includes(String(value.mode))
  )
    return false;
  if (
    value.recovery !== undefined &&
    (!object(value.recovery) ||
      !finite(value.recovery.consecutiveWaits, 3) ||
      !Number.isInteger(value.recovery.consecutiveWaits) ||
      (value.recovery.previousWait !== undefined &&
        !validSystem(value.recovery.previousWait)))
  )
    return false;
  const state = value.observation;
  if (
    !object(state) ||
    !Array.isArray(state.nodes) ||
    state.nodes.length < 1 ||
    state.nodes.length > 60 ||
    !Array.isArray(state.edges) ||
    state.edges.length > 180 ||
    !object(state.system)
  )
    return false;
  const ids = new Set<string>();
  for (const node of state.nodes) {
    if (
      !object(node) ||
      typeof node.id !== 'string' ||
      !node.id.length ||
      node.id.length > 100 ||
      ids.has(node.id) ||
      typeof node.label !== 'string' ||
      node.label.length > 160 ||
      typeof node.kind !== 'string' ||
      !kinds.has(node.kind)
    )
      return false;
    if (
      ![
        'instances',
        'retries',
        'rps',
        'capacity',
        'serviceMs',
        'utilization',
        'queued',
        'p99',
        'errorRate',
      ].every((key) => finite(node[key]))
    )
      return false;
    if (node.configuredErrorRate !== undefined && !finite(node.configuredErrorRate, 1))
      return false;
    if (
      ['lockMs', 'lockWaitMs', 'writeRate'].some(
        (key) => node[key] !== undefined && !finite(node[key]),
      )
    )
      return false;
    if (
      !Number.isInteger(node.instances) ||
      !Number.isInteger(node.retries) ||
      (node.instances as number) < 1 ||
      (node.errorRate as number) > 1
    )
      return false;
    if (
      node.fault !== null &&
      !['crash', 'slow', 'errors', 'partition'].includes(String(node.fault))
    )
      return false;
    ids.add(node.id);
  }
  return (
    state.edges.every(
      (edge: unknown) =>
        object(edge) &&
        typeof edge.from === 'string' &&
        typeof edge.to === 'string' &&
        ids.has(edge.from) &&
        ids.has(edge.to),
    ) && validSystem(state.system)
  );
}
