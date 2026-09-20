import { NODE_KINDS } from '../clipboard.ts';
import { behaviourFor } from '../sim/behaviour.ts';
import { defaultConfig } from '../sim/presets.ts';
import type { NodeKind, SimEdge, SimNode, Topology } from '../sim/types.ts';
import { componentCatalog, configFieldsFor } from './catalog.ts';
import type { Field } from './config.ts';
import type { CompiledEdit, DesignEdit } from './contracts.ts';
import { object, onlyKeys, validateDesignTopology } from './validation.ts';

const WIDTH = 184,
  HEIGHT = 88,
  GRID = 8;
const snap = (value: number) => Math.round(value / GRID) * GRID;
function freshId(prefix: string, taken: ReadonlySet<string>): string {
  let id = prefix,
    suffix = 1;
  while (taken.has(id)) id = `${prefix}-${suffix++}`;
  return id;
}
function requireNode(topology: Topology, id: string | undefined): SimNode {
  const node = topology.nodes.find((node) => node.id === id);
  if (!node) throw new Error('That component is no longer in the design.');
  return node;
}
function requireEdge(topology: Topology, id: string): SimEdge {
  const edge = topology.edges.find((edge) => edge.id === id);
  if (!edge) throw new Error('That connection is no longer in the design.');
  return edge;
}
function controlEdge(topology: Topology, edge: SimEdge): boolean {
  return (
    edge.control === true || requireNode(topology, edge.from).kind === 'autoscaler'
  );
}
function connection(
  topology: Topology,
  from: string,
  to: string,
  source?: SimEdge,
): SimEdge {
  const fromNode = requireNode(topology, from),
    toNode = requireNode(topology, to);
  if (from === to) throw new Error('A component cannot connect to itself.');
  if (topology.edges.some((edge) => edge.from === from && edge.to === to))
    throw new Error('Those components are already connected.');
  const control = fromNode.kind === 'autoscaler';
  if (toNode.kind === 'autoscaler')
    throw new Error('An autoscaler supervises a component; it cannot receive traffic.');
  if (
    control &&
    (!behaviourFor(toNode.kind).scaleField ||
      topology.edges.some((edge) => edge.from === from))
  )
    throw new Error('An autoscaler can supervise one scalable component.');
  if (!control && source?.control === true)
    throw new Error('Only an autoscaler can create a supervisory connection.');
  return {
    ...(source ?? {}),
    id: freshId(`${from}->${to}`, new Set(topology.edges.map((edge) => edge.id))),
    from,
    to,
    weight: source?.weight ?? 1,
    ...(control ? { control: true } : {}),
  };
}
function position(
  topology: Topology,
  preferred: { x: number; y: number },
): { x: number; y: number } {
  const origin = { x: snap(preferred.x), y: snap(preferred.y) };
  const free = (point: { x: number; y: number }) =>
    topology.nodes.every(
      (node) =>
        Math.abs(node.x - point.x) >= WIDTH + 16 ||
        Math.abs(node.y - point.y) >= HEIGHT + 16,
    );
  if (free(origin)) return origin;
  // At most 60 nodes exist: these deterministic rings always have spare positions.
  for (let ring = 1; ring <= 60; ring++) {
    for (let row = -ring; row <= ring; row++)
      for (let col = -ring; col <= ring; col++) {
        if (Math.abs(row) !== ring && Math.abs(col) !== ring) continue;
        const point = {
          x: origin.x + col * (WIDTH + 48),
          y: origin.y + row * (HEIGHT + 40),
        };
        if (free(point)) return point;
      }
  }
  throw new Error('Could not find space for another component.');
}
function addNode(
  topology: Topology,
  kind: NodeKind,
  preferred: { x: number; y: number },
): SimNode {
  if (!NODE_KINDS.includes(kind)) throw new Error('Unknown component kind.');
  const node: SimNode = {
    id: freshId(`${kind}-1`, new Set(topology.nodes.map((node) => node.id))),
    kind,
    label: componentCatalog.find((component) => component.kind === kind)!.label,
    ...position(topology, preferred),
    config: defaultConfig(kind),
  };
  topology.nodes.push(node);
  return node;
}
function assertEdit(value: unknown): asserts value is DesignEdit {
  if (!object(value) || typeof value.op !== 'string')
    throw new Error('Expected one architecture edit.');
  const keys: Record<string, string[]> = {
    add: ['op', 'kind', 'placement', 'targetId'],
    insert: ['op', 'kind', 'edgeId'],
    connect: ['op', 'from', 'to'],
    disconnect: ['op', 'edgeId'],
    remove: ['op', 'nodeId'],
    configure: ['op', 'nodeId', 'field', 'value'],
  };
  if (!Object.hasOwn(keys, value.op) || !onlyKeys(value, keys[value.op]))
    throw new Error('Unknown architecture edit or unexpected fields.');
  if (
    (value.op === 'add' || value.op === 'insert') &&
    !NODE_KINDS.includes(value.kind as NodeKind)
  )
    throw new Error('Unknown component kind.');
  if (value.op === 'add') {
    if (
      !['unconnected', 'before', 'after', 'alongside'].includes(
        String(value.placement),
      ) ||
      (value.targetId !== undefined && typeof value.targetId !== 'string') ||
      (value.placement !== 'unconnected' && typeof value.targetId !== 'string') ||
      (value.placement === 'unconnected' && value.targetId !== undefined)
    )
      throw new Error('Choose a placement and its target component.');
  }
  const required: Record<string, string[]> = {
    insert: ['edgeId'],
    connect: ['from', 'to'],
    disconnect: ['edgeId'],
    remove: ['nodeId'],
    configure: ['nodeId', 'field'],
  };
  if (
    (required[value.op] ?? []).some(
      (key) => typeof value[key] !== 'string' || !(value[key] as string).length,
    )
  )
    throw new Error('An edit is missing its component, connection or field.');
  if (
    value.op === 'configure' &&
    (typeof value.value !== 'number' || !Number.isFinite(value.value))
  )
    throw new Error('Configuration must be a finite number.');
}

/** One immutable, validated edit. Nothing is published until the caller commits the result. */
export function compileEdit(
  before: Topology,
  edit: DesignEdit,
  center = { x: 0, y: 0 },
): CompiledEdit {
  assertEdit(edit);
  validateDesignTopology(before);
  if (!Number.isFinite(center.x) || !Number.isFinite(center.y))
    throw new Error('Invalid canvas center.');
  const topology = structuredClone(before);
  let selectedIds: string[] = [];
  let summary: string;
  switch (edit.op) {
    case 'add': {
      const target =
        edit.placement === 'unconnected'
          ? undefined
          : requireNode(topology, edit.targetId);
      if (
        edit.kind === 'autoscaler' &&
        edit.placement !== 'unconnected' &&
        edit.placement !== 'alongside'
      )
        throw new Error('Place an autoscaler alongside the component it supervises.');
      if (target?.kind === 'autoscaler')
        throw new Error('Choose a traffic component as the placement target.');
      const preferred = target
        ? {
            x:
              target.x +
              (edit.placement === 'before'
                ? -WIDTH - 48
                : edit.placement === 'after'
                  ? WIDTH + 48
                  : 0),
            y: target.y + (edit.placement === 'alongside' ? HEIGHT + 40 : 0),
          }
        : { x: center.x - WIDTH / 2, y: center.y - HEIGHT / 2 };
      const node = addNode(topology, edit.kind, preferred);
      selectedIds = [node.id];
      if (target) {
        if (node.kind === 'autoscaler')
          topology.edges.push(connection(topology, node.id, target.id));
        else if (edit.placement === 'before') {
          topology.edges = topology.edges.map((edge) =>
            edge.to === target.id && !controlEdge(topology, edge)
              ? { ...edge, to: node.id }
              : edge,
          );
          topology.edges.push(connection(topology, node.id, target.id));
        } else if (edit.placement === 'after') {
          topology.edges = topology.edges.map((edge) =>
            edge.from === target.id && !controlEdge(topology, edge)
              ? { ...edge, from: node.id }
              : edge,
          );
          topology.edges.push(connection(topology, target.id, node.id));
        } else {
          const original = [...topology.edges];
          for (const edge of original) {
            if (controlEdge(topology, edge)) continue;
            if (edge.to === target.id)
              topology.edges.push(connection(topology, edge.from, node.id, edge));
            if (edge.from === target.id)
              topology.edges.push(connection(topology, node.id, edge.to, edge));
          }
        }
      }
      summary = `Added ${node.label}${target ? ` ${edit.placement} ${target.label}` : ''}.`;
      break;
    }
    case 'insert': {
      const edge = requireEdge(topology, edit.edgeId);
      if (edit.kind === 'autoscaler' || controlEdge(topology, edge))
        throw new Error(
          'Insert a traffic component on a traffic connection; add autoscalers alongside their targets.',
        );
      const from = requireNode(topology, edge.from),
        to = requireNode(topology, edge.to);
      const node = addNode(topology, edit.kind, {
        x: (from.x + to.x) / 2,
        y: (from.y + to.y) / 2,
      });
      const index = topology.edges.indexOf(edge);
      topology.edges.splice(index, 1);
      const first = connection(topology, from.id, node.id, edge);
      topology.edges.splice(index, 0, first);
      const second = connection(topology, node.id, to.id);
      topology.edges.splice(index + 1, 0, second);
      selectedIds = [node.id];
      summary = `Inserted ${node.label} between ${from.label} and ${to.label}.`;
      break;
    }
    case 'connect': {
      const from = requireNode(topology, edit.from),
        to = requireNode(topology, edit.to);
      topology.edges.push(connection(topology, from.id, to.id));
      selectedIds = [from.id, to.id];
      summary = `Connected ${from.label} to ${to.label}.`;
      break;
    }
    case 'disconnect': {
      const edge = requireEdge(topology, edit.edgeId);
      topology.edges = topology.edges.filter((candidate) => candidate.id !== edge.id);
      selectedIds = [edge.from, edge.to];
      summary = `Disconnected ${requireNode(topology, edge.from).label} from ${requireNode(topology, edge.to).label}.`;
      break;
    }
    case 'remove': {
      const node = requireNode(topology, edit.nodeId);
      topology.nodes = topology.nodes.filter((candidate) => candidate.id !== node.id);
      topology.edges = topology.edges.filter(
        (edge) => edge.from !== node.id && edge.to !== node.id,
      );
      summary = `Removed ${node.label} and its connections.`;
      break;
    }
    case 'configure': {
      const node = requireNode(topology, edit.nodeId);
      const field = configFieldsFor(node.kind).find(
        (field) => field.field === edit.field,
      );
      if (!field) throw new Error('That setting does not apply to this component.');
      const steps = (edit.value - field.min) / field.step;
      if (
        edit.value < field.min ||
        edit.value > field.max ||
        Math.abs(steps - Math.round(steps)) > 1e-6
      )
        throw new Error(
          `${field.label} must be ${field.min}–${field.max} ${field.unit}, in steps of ${field.step}.`,
        );
      if (node.config[field.field] === edit.value)
        throw new Error('That setting already has the requested value.');
      node.config[field.field as Field] = edit.value;
      if (
        node.kind === 'autoscaler' &&
        (node.config.minCapacity ?? 1) > (node.config.maxCapacity ?? 512)
      )
        throw new Error('Minimum instances cannot exceed maximum instances.');
      if (
        node.kind === 'region' &&
        (node.config.activeRegion ?? 0) >= (node.config.regions ?? 1)
      )
        throw new Error(
          'The serving region must be within the configured region count.',
        );
      selectedIds = [node.id];
      summary = `Set ${node.label} ${field.label.toLowerCase()} to ${edit.value} ${field.unit}.`;
      break;
    }
  }
  validateDesignTopology(topology);
  return { topology, selectedIds, summary };
}
