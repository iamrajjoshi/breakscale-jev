import { describe, expect, it } from 'vitest';
import { layoutDemo } from './demoLayout';
import { PRESETS } from './sim/presets';
import { RECORDED_SCENARIOS } from './operator/recordings';

describe('phone demo layout', () => {
  for (const scenario of RECORDED_SCENARIOS) {
    it(`preserves the simulated system for ${scenario.id}`, () => {
      const before = structuredClone(scenario.topology);
      const mobile = layoutDemo(scenario.topology, true);
      expect(mobile.nodes.map(({ x: _x, y: _y, ...node }) => node)).toEqual(
        before.nodes.map(({ x: _x, y: _y, ...node }) => node),
      );
      expect(mobile.edges).toEqual(before.edges);
      expect(new Set(mobile.nodes.map((node) => node.x)).size).toBe(1);
      expect(mobile.nodes.map((node) => node.y)).toEqual([40, 152, 264]);
      expect(mobile.annotations).toBeUndefined();
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
