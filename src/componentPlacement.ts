import { layoutNoteOf, type Rect } from './components/annotationLayout';
import type { Topology } from './sim/types';

/** Find a clear slot near the visible center; the caller fits the resulting view. */
export function findComponentPlacement(
  topology: Topology,
  center: { x: number; y: number },
  { width, height, grid }: { width: number; height: number; grid: number },
): { x: number; y: number } {
  const obstacles: Rect[] = topology.nodes.map((node) => ({
    x: node.x,
    y: node.y,
    w: width,
    h: height,
  }));
  for (const annotation of topology.annotations ?? []) {
    // Sections sit behind components and intentionally contain them. Notes have
    // foreground hit areas, measured exactly as Canvas measures their text.
    if (annotation.kind !== 'note') continue;
    const layout = layoutNoteOf(annotation, annotation.text);
    obstacles.push({
      x: annotation.x,
      y: annotation.y,
      w: layout.width,
      h: layout.height,
    });
  }
  const cx = Math.round((center.x - width / 2) / grid) * grid;
  const cy = Math.round((center.y - height / 2) / grid) * grid;
  // The existing two-grid gap also clears the note's 6px/4px hit-area padding.
  const gap = grid * 2;
  const occupied = (x: number, y: number) =>
    obstacles.some(
      (box) =>
        x < box.x + box.w + gap &&
        x + width + gap > box.x &&
        y < box.y + box.h + gap &&
        y + height + gap > box.y,
    );
  const stepX = Math.ceil((width + grid * 4) / grid) * grid;
  const stepY = Math.ceil((height + grid * 4) / grid) * grid;
  // Bound work even for imported notes covering thousands of world pixels.
  for (let radius = 0; radius <= Math.min(obstacles.length + 1, 12); radius++) {
    for (let y = -radius; y <= radius; y++) {
      for (let x = -radius; x <= radius; x++) {
        if (Math.max(Math.abs(x), Math.abs(y)) !== radius) continue;
        const point = { x: cx + x * stepX, y: cy + y * stepY };
        if (!occupied(point.x, point.y)) return point;
      }
    }
  }
  // There is always room beyond the rightmost obstacle. Never silently fail to
  // add a component or place it beneath a large note when nearby slots are full.
  const right = obstacles.reduce((edge, box) => Math.max(edge, box.x + box.w), cx);
  return { x: Math.ceil((right + gap) / grid) * grid, y: cy };
}
