import { defaultConfig } from './sim/presets.ts';
import type { NodeConfig, NodeKind, SimNode, Topology } from './sim/types.ts';

export const STARTER_RPS = 150;
export const STARTER_NAME = 'Cached web app';

function node(
  id: string,
  kind: NodeKind,
  label: string,
  x: number,
  y: number,
  settings: Partial<NodeConfig> = {},
): SimNode {
  return { id, kind, label, x, y, config: { ...defaultConfig(kind), ...settings } };
}

/** A shared cache and database make downstream bottlenecks visible despite three APIs. */
export const STARTER_TOPOLOGY: Topology = {
  nodes: [
    node('client', 'client', 'Visitors', 40, 164, {
      rps: STARTER_RPS,
      timeoutMs: 2000,
    }),
    node('lb', 'lb', 'Load balancer', 264, 164),
    node('api1', 'service', 'API 1', 488, 40),
    node('api2', 'service', 'API 2', 488, 164),
    node('api3', 'service', 'API 3', 488, 288),
    node('cache', 'cache', 'Shared cache', 712, 164, { hitRate: 0.25 }),
    node('db', 'db', 'Database', 936, 164, { queueLimit: 64 }),
  ],
  edges: [
    ['client', 'lb'],
    ['lb', 'api1'],
    ['lb', 'api2'],
    ['lb', 'api3'],
    ['api1', 'cache'],
    ['api2', 'cache'],
    ['api3', 'cache'],
    ['cache', 'db'],
  ].map(([from, to]) => ({ id: `${from}-${to}`, from: from!, to: to!, weight: 1 })),
};
