import type { Observation } from './contracts';

export type ActivityStatus =
  | 'diagnosing'
  | 'measuring'
  | 'healthy'
  | 'unresolved'
  | 'waiting'
  | 'cancelled'
  | 'failed'
  | 'deferred'
  | 'interrupted'
  | 'blocked';

export interface ActivityEntry {
  id: number;
  startedAt: number;
  incident: string;
  status: ActivityStatus;
  detail: string;
  action?: string;
  chosenAt?: number;
  appliedAt?: number;
  completedAt?: number;
  before: Observation['system'];
  after?: Observation['system'];
}

export const ACTIVITY_LIMIT = 50;
