import { NODE_KINDS } from '../clipboard.ts';
import { defaultConfig, PRESETS } from '../sim/presets.ts';
import {
  TRAFFIC_PATTERNS,
  type NodeConfig,
  type NodeKind,
  type Topology,
} from '../sim/types.ts';
import { FIELD_SPECS, type Field } from './config.ts';
import {
  MAX_DESIGN_EDGES,
  MAX_DESIGN_EDITS,
  MAX_DESIGN_NODES,
  type DesignRequest,
} from './contracts.ts';

export function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function onlyKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}
function finite(value: unknown, min = 0, max = 1e9): value is number {
  return (
    typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
  );
}
function identifier(value: unknown, max = 100): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= max &&
    [...value].every((character) => character.charCodeAt(0) >= 32)
  );
}
const requiredConfig = [
  'capacity',
  'serviceMs',
  'serviceCv',
  'queueLimit',
  'hitRate',
  'errorRate',
  'timeoutMs',
  'retries',
  'rps',
];
const configKeys = [...Object.keys(FIELD_SPECS), 'traffic', 'trafficPeriodS'];
// Existing examples occasionally exceed a slider's range (e.g. cold-storage latency).
// Accept those authored defaults, while new configure edits use the exact Inspector range.
const configMaximum = Object.fromEntries(
  Object.entries(FIELD_SPECS).map(([field, spec]) => [
    field,
    Math.max(
      spec.max,
      ...NODE_KINDS.map((kind) => Number(defaultConfig(kind)[field as Field] ?? 0)),
      ...PRESETS.flatMap((preset) =>
        preset.topology.nodes.map((node) => Number(node.config[field as Field] ?? 0)),
      ),
      field === 'rps' ? 10000 : 0,
    ),
  ]),
);
function validConfig(value: unknown): value is NodeConfig {
  if (
    !object(value) ||
    !onlyKeys(value, configKeys) ||
    !requiredConfig.every((field) => finite(value[field]))
  )
    return false;
  for (const [field, number] of Object.entries(value)) {
    if (field === 'traffic') {
      if (!TRAFFIC_PATTERNS.includes(number as never)) return false;
    } else if (field === 'trafficPeriodS') {
      if (!finite(number, 1, 86400)) return false;
    } else {
      const spec = FIELD_SPECS[field as Field];
      if (!spec || !finite(number, 0, configMaximum[field])) return false;
      if (spec.control === 'number' && !Number.isInteger(number)) return false;
    }
  }
  return true;
}

/** Strict graph boundary; annotations are local-only and never accepted by the HTTP request. */
export function validateDesignTopology(value: unknown): asserts value is Topology {
  const fail = (message: string): never => {
    throw new Error(message);
  };
  if (
    !object(value) ||
    !onlyKeys(value, ['nodes', 'edges', 'annotations']) ||
    !Array.isArray(value.nodes) ||
    !Array.isArray(value.edges)
  )
    fail('Expected a topology with nodes and edges.');
  // Narrow explicitly because the throwing helper is intentionally shared across checks.
  const topology = value as Record<string, unknown> & {
    nodes: unknown[];
    edges: unknown[];
  };
  if (
    topology.nodes.length > MAX_DESIGN_NODES ||
    topology.edges.length > MAX_DESIGN_EDGES
  )
    fail(
      `Keep the design within ${MAX_DESIGN_NODES} components and ${MAX_DESIGN_EDGES} connections.`,
    );
  const ids = new Set<string>();
  for (const value of topology.nodes) {
    if (
      !object(value) ||
      !onlyKeys(value, ['id', 'kind', 'label', 'x', 'y', 'config']) ||
      !identifier(value.id) ||
      ids.has(value.id) ||
      !NODE_KINDS.includes(value.kind as NodeKind) ||
      typeof value.label !== 'string' ||
      value.label.length > 160 ||
      !finite(value.x, -1e7, 1e7) ||
      !finite(value.y, -1e7, 1e7) ||
      !validConfig(value.config)
    )
      fail('A component has an invalid ID, kind, position, label or configuration.');
    ids.add((value as { id: string }).id);
  }
  const edgeIds = new Set<string>();
  const pairs = new Set<string>();
  for (const raw of topology.edges) {
    if (
      !object(raw) ||
      !onlyKeys(raw, [
        'id',
        'from',
        'to',
        'weight',
        'control',
        'latencyMs',
        'bandwidthRps',
        'lossRate',
      ]) ||
      !identifier(raw.id, 240) ||
      edgeIds.has(raw.id) ||
      !identifier(raw.from) ||
      !identifier(raw.to) ||
      !ids.has(raw.from) ||
      !ids.has(raw.to) ||
      raw.from === raw.to ||
      !finite(raw.weight, 0, 1e6) ||
      (raw.control !== undefined && typeof raw.control !== 'boolean') ||
      (raw.latencyMs !== undefined && !finite(raw.latencyMs, 0, 60000)) ||
      (raw.bandwidthRps !== undefined && !finite(raw.bandwidthRps, 0, 1e7)) ||
      (raw.lossRate !== undefined && !finite(raw.lossRate, 0, 1))
    )
      fail('A connection is duplicated, dangling or invalid.');
    const edge = raw as { id: string; from: string; to: string };
    const pair = JSON.stringify([edge.from, edge.to]);
    if (pairs.has(pair)) fail('Two components already have that connection.');
    pairs.add(pair);
    edgeIds.add(edge.id);
  }
  if (topology.annotations !== undefined) {
    // Preserve local notes without sending their text to the model. The editor owns their schema.
    if (
      !Array.isArray(topology.annotations) ||
      topology.annotations.length > 1000 ||
      !topology.annotations.every(
        (a) =>
          object(a) &&
          ['note', 'section'].includes(String(a.kind)) &&
          identifier(a.id) &&
          finite(a.x, -1e7, 1e7) &&
          finite(a.y, -1e7, 1e7),
      )
    )
      fail('Invalid canvas annotations.');
  }
}

/** Allowlisted request projection: canvas annotations and unrelated/private object fields stay local. */
export function designTopology(topology: Topology): Topology {
  const result: Topology = {
    nodes: topology.nodes.map(({ id, kind, label, x, y, config }) => ({
      id,
      kind,
      label,
      x,
      y,
      config: Object.fromEntries(
        configKeys
          .filter(
            (key) =>
              Object.hasOwn(config, key) &&
              config[key as keyof NodeConfig] !== undefined,
          )
          .map((key) => [key, config[key as keyof NodeConfig]]),
      ) as unknown as NodeConfig,
    })),
    edges: topology.edges.map(
      (edge) =>
        Object.fromEntries(
          [
            'id',
            'from',
            'to',
            'weight',
            'control',
            'latencyMs',
            'bandwidthRps',
            'lossRate',
          ]
            .filter(
              (key) =>
                Object.hasOwn(edge, key) &&
                edge[key as keyof typeof edge] !== undefined,
            )
            .map((key) => [key, edge[key as keyof typeof edge]]),
        ) as unknown as Topology['edges'][number],
    ),
  };
  validateDesignTopology(result);
  return result;
}
export function validDesignRequest(value: unknown): value is DesignRequest {
  if (
    !object(value) ||
    !onlyKeys(value, [
      'sessionId',
      'prompt',
      'topology',
      'completed',
      'selectedNodeId',
    ]) ||
    typeof value.sessionId !== 'string' ||
    !/^[a-zA-Z0-9-]{16,80}$/.test(value.sessionId) ||
    typeof value.prompt !== 'string' ||
    !value.prompt.trim() ||
    value.prompt.length > 600 ||
    !Array.isArray(value.completed) ||
    value.completed.length > MAX_DESIGN_EDITS ||
    !value.completed.every(
      (item) => typeof item === 'string' && item.length > 0 && item.length <= 600,
    ) ||
    !object(value.topology) ||
    !onlyKeys(value.topology, ['nodes', 'edges'])
  )
    return false;
  try {
    validateDesignTopology(value.topology);
  } catch {
    return false;
  }
  return (
    value.selectedNodeId === null ||
    (typeof value.selectedNodeId === 'string' &&
      value.topology.nodes.some((node) => node.id === value.selectedNodeId))
  );
}
export const validateDesignRequest = validDesignRequest;
