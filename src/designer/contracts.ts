import type { NodeKind, Topology } from '../sim/types.ts';

export const MAX_DESIGN_EDITS = 4;
export const MAX_DESIGN_NODES = 60;
export const MAX_DESIGN_EDGES = 180;
export type DesignEdit =
  | {
      op: 'add';
      kind: NodeKind;
      placement: 'unconnected' | 'before' | 'after' | 'alongside';
      targetId?: string;
    }
  | { op: 'insert'; kind: NodeKind; edgeId: string }
  | { op: 'connect'; from: string; to: string }
  | { op: 'disconnect'; edgeId: string }
  | { op: 'remove'; nodeId: string }
  | { op: 'configure'; nodeId: string; field: string; value: number };
export interface DesignRequest {
  sessionId: string;
  prompt: string;
  topology: Topology;
  completed: string[];
  selectedNodeId: string | null;
}
export interface DesignDecision {
  outcome: 'edit' | 'finish' | 'unsupported';
  edit?: DesignEdit;
  model: string;
  usage: { input_tokens: number; output_tokens: number };
  durationMs: number;
  callsRemaining: number;
}
export interface CompiledEdit {
  topology: Topology;
  selectedIds: string[];
  summary: string;
}
