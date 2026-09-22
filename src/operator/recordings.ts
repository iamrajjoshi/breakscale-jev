import type { Topology } from '../sim/types.ts';
import {
  actionsFor,
  hasWriteContention,
  incidentFor,
  MODEL,
  type Action,
  type Observation,
} from './contracts.ts';
import corpus from './recordings.json';

export interface RecordedScenario {
  id: string;
  title: string;
  description: string;
  topology: Topology;
  rps: number;
  failures?: { nodeId: string; kind: 'crash' | 'slow' }[];
}

export interface RecordedRepair {
  id: string;
  scenarioId: string;
  title: string;
  recordedAt: string;
  model: string;
  originalTopology: Topology;
  originalObservation: Observation;
  originalAction: Action;
  confidence: number;
  probabilities: Record<string, number>;
  after: Observation;
  evidence: { requestSha256: string; responseSha256: string };
}

/** These are captured choices, not a model running in the browser. */
export const REPAIR_RECORDINGS = corpus.recordings as unknown as RecordedRepair[];
export const RECORDED_SCENARIOS = corpus.scenarios as RecordedScenario[];

function stable(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
      : item,
  );
}

/** Ignore presentation only. Every simulation config and edge property matters. */
function shape(topology: Topology): string {
  const indices = new Map(topology.nodes.map((node, index) => [node.id, index]));
  return stable({
    nodes: topology.nodes.map(({ kind, config }) => ({ kind, config })),
    edges: topology.edges.map(({ id: _id, from, to, ...settings }) => ({
      from: indices.get(from),
      to: indices.get(to),
      ...settings,
    })),
  });
}

function sameAction(a: Action, b: Action): boolean {
  return (
    a.kind === b.kind &&
    ('nodeId' in a ? a.nodeId : undefined) === ('nodeId' in b ? b.nodeId : undefined) &&
    ('value' in a ? a.value : undefined) === ('value' in b ? b.value : undefined)
  );
}

/**
 * Reuse a choice only for its recorded system and damage. Runtime metric values
 * are deliberately not replayed: the current engine must detect the incident,
 * offer the same repair, apply it, and measure its own outcome.
 */
export function matchRecordedRepair(
  observation: Observation,
  choices: Action[],
  topology: Topology,
): { action: Action; recording: RecordedRepair } | null {
  if (
    !incidentFor(observation) ||
    observation.nodes.some(hasWriteContention) ||
    observation.nodes.length !== topology.nodes.length ||
    observation.nodes.some((node, index) => node.id !== topology.nodes[index]?.id)
  )
    return null;
  // Caller-supplied candidates cannot bypass the current closed repair menu.
  const legal = actionsFor(observation, 'operator');
  const currentShape = shape(topology);
  for (const recording of REPAIR_RECORDINGS) {
    if (recording.model !== MODEL || currentShape !== shape(recording.originalTopology))
      continue;
    const original = recording.originalObservation;
    if (
      original.nodes.some((node, index) => {
        const current = observation.nodes[index];
        return (
          !current ||
          [
            'kind',
            'instances',
            'retries',
            'rps',
            'capacity',
            'serviceMs',
            'configuredErrorRate',
            'lockMs',
            'fault',
          ].some(
            (key) =>
              node[key as keyof typeof node] !== current[key as keyof typeof node],
          )
        );
      })
    )
      continue;
    const selected = recording.originalAction;
    if (!('nodeId' in selected)) continue;
    const index = original.nodes.findIndex((node) => node.id === selected.nodeId);
    if (index < 0) continue;
    const mapped = { ...selected, nodeId: observation.nodes[index]!.id };
    const action = choices.find((candidate) => sameAction(candidate, mapped));
    if (
      action &&
      legal.some(
        (candidate) => candidate.id === action.id && sameAction(candidate, action),
      )
    )
      return { action, recording };
  }
  return null;
}
