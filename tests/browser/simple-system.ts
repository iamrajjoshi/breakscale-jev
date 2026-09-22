import type { Page } from '@playwright/test';
import { layoutDemo } from '../../src/demoLayout';
import { PRESETS } from '../../src/sim/presets';

/** Keep established repair and editor regressions on their original fixture.
 * Explicit per-test sessions and persisted edits always take precedence.
 */
export async function seedSimpleSystem(page: Page): Promise<void> {
  const preset = PRESETS[0]!;
  const topology = layoutDemo(
    preset.topology,
    (page.viewportSize()?.width ?? 1440) <= 720,
  );
  await page.addInitScript(
    (session) => {
      const key = 'breakscale.session.v1';
      if (localStorage.getItem(key) === null)
        localStorage.setItem(key, JSON.stringify(session));
    },
    {
      topology,
      rps: topology.nodes
        .filter((node) => node.kind === 'client')
        .reduce((sum, node) => sum + node.config.rps, 0),
      presetId: preset.id,
    },
  );
}
