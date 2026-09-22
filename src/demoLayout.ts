import type { Topology } from './sim/types';

/** Only for newly loaded starter/recorded demos, never a saved design.
 * On phones, turn the wider web app into a vertical flow, retaining its parallel
 * API branch. Simple chains stack. Neither path changes the simulated system.
 */
export function layoutDemo(topology: Topology, phone: boolean): Topology {
  const copy = structuredClone(topology);
  if (!phone) return copy;
  if (copy.nodes.length <= 3) {
    copy.nodes.forEach((node, index) => {
      node.x = 40;
      node.y = 40 + index * 112;
    });
  } else {
    const columns = [...new Set(copy.nodes.map((node) => node.x))].sort(
      (a, b) => a - b,
    );
    const rows = [...new Set(copy.nodes.map((node) => node.y))].sort((a, b) => a - b);
    copy.nodes.forEach((node) => {
      const column = columns.indexOf(node.x);
      const row = rows.indexOf(node.y);
      node.x = 40 + row * 208;
      node.y = 40 + column * 120;
    });
  }
  delete copy.annotations;
  return copy;
}
