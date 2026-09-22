import { describe, expect, it } from 'vitest';
import { layoutDemo } from './demoLayout';
import { PRESETS } from './sim/presets';
import { RECORDED_SCENARIOS } from './operator/recordings';
import { routeEdge } from './components/edgeRoute';

describe.each([
  { name: 'phone', phone: true, portrait: false, spacing: 120, chainSpacing: 112 },
  {
    name: 'portrait desktop',
    phone: false,
    portrait: true,
    spacing: 120,
    chainSpacing: 120,
  },
])('$name demo layout', ({ phone, portrait, spacing, chainSpacing }) => {
  for (const scenario of RECORDED_SCENARIOS) {
    it(`preserves the simulated system for ${scenario.id}`, () => {
      const before = structuredClone(scenario.topology);
      const arranged = layoutDemo(scenario.topology, phone, portrait);
      expect(arranged.nodes.map(({ x: _x, y: _y, ...node }) => node)).toEqual(
        before.nodes.map(({ x: _x, y: _y, ...node }) => node),
      );
      expect(arranged.edges).toEqual(before.edges);
      for (const edge of arranged.edges) {
        const from = arranged.nodes.find((node) => node.id === edge.from)!;
        const to = arranged.nodes.find((node) => node.id === edge.to)!;
        const route = routeEdge(
          { x: from.x, y: from.y, w: 184, h: 88 },
          { x: to.x, y: to.y, w: 184, h: 88 },
        );
        // A collapsed route has no selectable path: a tap hits the node instead.
        const length = route.points.slice(1).reduce((sum, point, index) => {
          const previous = route.points[index]!;
          return sum + Math.hypot(point.x - previous.x, point.y - previous.y);
        }, 0);
        expect(length, `${edge.id} needs a visible, selectable wire`).toBeGreaterThan(
          0,
        );
      }
      if (arranged.nodes.length === 3) {
        expect(new Set(arranged.nodes.map((node) => node.x)).size).toBe(1);
        expect(arranged.nodes.map((node) => node.y)).toEqual([
          40,
          40 + chainSpacing,
          40 + chainSpacing * 2,
        ]);
      } else {
        expect(
          [...new Set(arranged.nodes.map((node) => node.x))].sort((a, b) => a - b),
        ).toEqual([40, 248, 456]);
        expect([...new Set(arranged.nodes.map((node) => node.y))]).toEqual(
          [0, 1, 2, 3, 4].map((row) => 40 + row * spacing),
        );
        const apis = arranged.nodes.filter((node) => node.kind === 'service');
        expect(new Set(apis.map((node) => node.y)).size).toBe(1);
        expect(new Set(apis.map((node) => node.x)).size).toBe(3);
      }
      expect(arranged.annotations).toBeUndefined();
      expect(scenario.topology).toEqual(before);
    });
  }

  it('keeps the desktop layout and notes in an independent copy', () => {
    const original = PRESETS[0]!.topology;
    const desktop = layoutDemo(original, false);
    expect(desktop).toEqual(original);
    desktop.nodes[0]!.x += 100;
    expect(desktop.nodes[0]!.x).not.toBe(original.nodes[0]!.x);
    expect(original.annotations?.length).toBeGreaterThan(0);
  });
});
