import type { Topology } from './sim/types';

/** Only for newly loaded, known three-component demos, never a saved design.
 * On a phone the horizontal chain makes every control microscopic. Stack the
 * nodes and omit the preset's long teaching note; the repair panel explains play.
 */
export function layoutDemo(topology: Topology, phone: boolean): Topology {
  const copy = structuredClone(topology);
  if (!phone) return copy;
  copy.nodes.forEach((node, index) => {
    node.x = 40;
    node.y = 40 + index * 112;
  });
  delete copy.annotations;
  return copy;
}
