import { describe, expect, it } from 'vitest';
import { findComponentPlacement } from './componentPlacement';
import { layoutNoteOf, type Rect } from './components/annotationLayout';
import { makeNote, makeSection } from './sim/annotations';
import { makeNode, PRESETS } from './sim/presets';
import type { Topology } from './sim/types';

const footprint = { width: 184, height: 88, grid: 8 };
const nodeRect = (point: { x: number; y: number }): Rect => ({
  ...point,
  w: footprint.width,
  h: footprint.height,
});
const overlaps = (a: Rect, b: Rect) =>
  a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
const noteHitRects = (topology: Topology): Rect[] =>
  (topology.annotations ?? []).flatMap((annotation) => {
    if (annotation.kind !== 'note') return [];
    const layout = layoutNoteOf(annotation, annotation.text);
    return [
      {
        x: annotation.x - 6,
        y: annotation.y - 4,
        w: layout.width + 12,
        h: layout.height + 8,
      },
    ];
  });

describe('palette component placement', () => {
  it('keeps the starter note from intercepting the newly added Cache', () => {
    const topology = PRESETS[0]!.topology;
    const center = { x: 316, y: 388 };
    const note = noteHitRects(topology)[0]!;
    // The old node-only search chose this free node slot underneath ss-note-db.
    const oldPlacement = nodeRect({ x: 224, y: 344 });
    expect(topology.nodes.some((node) => overlaps(oldPlacement, nodeRect(node)))).toBe(
      false,
    );
    expect(overlaps(oldPlacement, note)).toBe(true);
    const placed = nodeRect(findComponentPlacement(topology, center, footprint));
    expect(overlaps(placed, note)).toBe(false);
    expect(topology.nodes.some((node) => overlaps(placed, nodeRect(node)))).toBe(false);
  });

  it('uses measured auto-sized note bounds instead of their ignored stored width', () => {
    const note = {
      ...makeNote(0, 0, 'A long unwrapped annotation '.repeat(8)),
      width: 80,
      scale: 3,
      bold: true,
      italic: true,
    };
    const topology: Topology = { nodes: [], edges: [], annotations: [note] };
    const layout = layoutNoteOf(note, note.text);
    expect(layout.width).toBeGreaterThan(note.width * 4);
    const center = { x: 500, y: layout.height / 2 };
    const placed = nodeRect(findComponentPlacement(topology, center, footprint));
    expect(overlaps(placed, noteHitRects(topology)[0]!)).toBe(false);
  });

  it('allows placing inside sections because they are containers, not foreground obstacles', () => {
    const topology: Topology = {
      nodes: [],
      edges: [],
      annotations: [makeSection(-1000, -1000, 2000, 2000)],
    };
    expect(findComponentPlacement(topology, { x: 92, y: 44 }, footprint)).toEqual({
      x: 0,
      y: 0,
    });
  });

  it('keeps repeated additions separate from both nodes and note hit areas', () => {
    const topology = structuredClone(PRESETS[0]!.topology);
    for (let addition = 0; addition < 20; addition++) {
      const point = findComponentPlacement(topology, { x: 316, y: 388 }, footprint);
      const rect = nodeRect(point);
      expect(
        [...topology.nodes.map(nodeRect), ...noteHitRects(topology)].some((obstacle) =>
          overlaps(rect, obstacle),
        ),
      ).toBe(false);
      expect(Math.abs(point.x % footprint.grid)).toBe(0);
      expect(Math.abs(point.y % footprint.grid)).toBe(0);
      topology.nodes.push(makeNode('cache', point.x, point.y));
    }
  });

  it('returns a clear fallback beyond a note covering all nearby slots', () => {
    const note = {
      ...makeNote(-4000, -4000, 'line\n'.repeat(200)),
      autoResize: false,
      width: 8000,
      size: 'lg' as const,
      scale: 4,
    };
    const topology: Topology = { nodes: [], edges: [], annotations: [note] };
    const point = findComponentPlacement(topology, { x: 92, y: 44 }, footprint);
    expect(point.x).toBeGreaterThan(note.x + note.width);
    expect(overlaps(nodeRect(point), noteHitRects(topology)[0]!)).toBe(false);
  });
});
