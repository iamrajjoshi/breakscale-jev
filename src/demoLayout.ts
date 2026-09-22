import type { Topology } from './sim/types';

/** Only for newly loaded starter/recorded demos, never a saved design.
 * On phones and portrait desktop canvases, turn the web app into a vertical flow,
 * retaining its parallel API branch. Neither path changes the simulated system.
 */
export function layoutDemo(
  topology: Topology,
  phone: boolean,
  portrait = false,
): Topology {
  const copy = structuredClone(topology);
  if (!phone && !portrait) return copy;
  if (copy.nodes.length <= 3) {
    copy.nodes.forEach((node, index) => {
      node.x = 40;
      node.y = 40 + index * (phone ? 112 : 120);
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
      // Keep a visible wire between 88px cards after the router's arrow inset.
      node.y = 40 + column * 120;
    });
  }
  delete copy.annotations;
  return copy;
}
