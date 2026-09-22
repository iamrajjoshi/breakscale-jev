import { expect, test, type Locator, type Page } from '@playwright/test';
import { seedSimpleSystem } from './simple-system';

const viewports = [
  { width: 1440, height: 900 },
  { width: 1280, height: 720 },
  { width: 1024, height: 768 },
  { width: 900, height: 700 },
  { width: 768, height: 800 },
  { width: 390, height: 844 },
  { width: 320, height: 740 },
];

async function expectReachable(control: Locator): Promise<void> {
  await expect(control).toBeVisible();
  await expect
    .poll(() =>
      control.evaluate((element) => {
        const r = element.getBoundingClientRect();
        const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        return (
          r.x >= 0 &&
          r.y >= 0 &&
          r.right <= innerWidth + 1 &&
          r.bottom <= innerHeight + 1 &&
          !!hit &&
          (hit === element || element.contains(hit))
        );
      }),
    )
    .toBe(true);
}

async function openDemo(page: Page, empty = false): Promise<void> {
  await seedSimpleSystem(page);
  await page.route('**/api/health', (route) =>
    route.fulfill({ json: { configured: false, model: 'jev-1.13.0', callLimit: 18 } }),
  );
  if (empty) {
    await page.addInitScript(() => {
      localStorage.setItem(
        'breakscale.session.v1',
        JSON.stringify({ topology: { nodes: [], edges: [] }, rps: 0, presetId: null }),
      );
    });
  }
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Menu', exact: true })).toBeVisible();
  await expect(page.locator('.cv-node')).toHaveCount(empty ? 0 : 3);
}

async function openBuild(page: Page, width: number): Promise<void> {
  if (width <= 720) {
    const build = page.getByRole('button', { name: 'Build', exact: true });
    if ((await build.getAttribute('aria-expanded')) !== 'true') await build.click();
  } else {
    const show = page.getByRole('button', { name: 'Show components', exact: true });
    if (await show.isVisible()) await show.click();
  }
  await expectReachable(
    page.getByRole('searchbox', { name: 'Search components', exact: true }),
  );
}

async function expectGraphVisible(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page.locator('.cv-node').evaluateAll((nodes) =>
        nodes.flatMap((node) => {
          const body = node.querySelector('.cv-node-body');
          if (!body) return ['Missing node body'];
          const r = body.getBoundingClientRect();
          // Hit the painted body, including its edges, rather than the empty
          // corners outside a rounded SVG rectangle at higher zoom levels.
          const inset = Math.min(r.width, r.height) * 0.1;
          const points = [
            [r.left + inset, r.top + inset],
            [r.right - inset, r.top + inset],
            [r.left + inset, r.bottom - inset],
            [r.right - inset, r.bottom - inset],
            [r.left + r.width / 2, r.top + 1],
            [r.left + r.width / 2, r.bottom - 1],
            [r.left + 1, r.top + r.height / 2],
            [r.right - 1, r.top + r.height / 2],
            [r.left + r.width / 2, r.top + r.height / 2],
          ];
          return points.some(
            ([x, y]) => document.elementFromPoint(x!, y!)?.closest('.cv-node') !== node,
          )
            ? [node.getAttribute('data-id')]
            : [];
        }),
      ),
    )
    .toEqual([]);
}

for (const viewport of viewports) {
  test.describe(`${viewport.width}×${viewport.height}`, () => {
    test.use({ viewport });
    let errors: string[];
    let unexpectedCalls: string[];
    test.beforeEach(async ({ page }) => {
      errors = [];
      unexpectedCalls = [];
      page.on('pageerror', (error) => errors.push(error.message));
      for (const endpoint of ['decide', 'design-step']) {
        await page.route(`**/api/${endpoint}`, (route) => {
          unexpectedCalls.push(endpoint);
          return route.abort();
        });
      }
    });
    test.afterEach(() => {
      expect(errors).toEqual([]);
      expect(unexpectedCalls).toEqual([]);
    });

    test('transport and About remain reachable with traffic and on an empty canvas', async ({
      page,
    }, testInfo) => {
      await openDemo(page);
      await expectGraphVisible(page);
      if (viewport.width <= 720) {
        const node = page.locator('.cv-node-body').first();
        const before = await node.evaluate(
          (element) => element.getBoundingClientRect().width,
        );
        const zoomIn = page.getByRole('button', { name: 'Zoom in', exact: true });
        await expectReachable(zoomIn);
        await zoomIn.click();
        await expect
          .poll(() => node.evaluate((element) => element.getBoundingClientRect().width))
          .toBeGreaterThan(before);
        const fit = page.getByRole('button', {
          name: 'Fit the diagram on screen',
          exact: true,
        });
        await expectReachable(fit);
        await fit.click();
        await expectGraphVisible(page);
      }
      for (const name of ['Pause', 'Step one tick', 'Reset simulation', 'About']) {
        await expectReachable(page.getByRole('button', { name, exact: true }));
      }
      await page.getByRole('button', { name: 'Pause', exact: true }).click();
      const time = await page.locator('.cv-ledger-time').innerText();
      await page.getByRole('button', { name: 'Step one tick', exact: true }).click();
      await expect(page.locator('.cv-ledger-time')).not.toHaveText(time);
      await page.screenshot({ path: testInfo.outputPath('initial.png') });
      // Seed the next document before the app mounts. Writing to the current
      // document races its pending 400ms session autosave during navigation.
      await page.addInitScript(() => {
        localStorage.setItem(
          'breakscale.session.v1',
          JSON.stringify({
            topology: { nodes: [], edges: [] },
            rps: 0,
            presetId: null,
          }),
        );
      });
      await page.reload();
      await expect(page.locator('.cv-node')).toHaveCount(0);
      for (const name of ['Pause', 'Step one tick', 'Reset simulation', 'About']) {
        await expectReachable(page.getByRole('button', { name, exact: true }));
      }
      await expectReachable(page.getByTestId('operator-status'));
      await expect(page.getByTestId('operator-prompt')).toHaveCount(0);
      await page.screenshot({ path: testInfo.outputPath('empty-canvas.png') });
    });

    test('Build and Inspect expose usable controls without competing side panels', async ({
      page,
    }, testInfo) => {
      await openDemo(page);
      await page.locator('.cv-node[data-id="db"]').click();
      const name = page.getByRole('textbox', { name: 'Node name', exact: true });
      await expectReachable(name);
      await name.fill('Primary database');
      await name.press('Enter');
      await expect(page.locator('.cv-node[data-id="db"]')).toHaveAttribute(
        'aria-label',
        /Primary database/,
      );
      if (viewport.width <= 1100) {
        await expect(page.locator('.app-slot-left:not(.is-closing)')).toHaveCount(0);
      }
      await page.screenshot({ path: testInfo.outputPath('selected.png') });
      await openBuild(page, viewport.width);
      if (viewport.width <= 1100) {
        await expect(page.locator('.app-slot-right:not(.is-closing)')).toHaveCount(0);
      }
      await page
        .getByRole('searchbox', { name: 'Search components', exact: true })
        .fill('Cache');
      const cache = page.getByRole('button', { name: 'Cache', exact: true });
      await expectReachable(cache);
      await cache.click();
      await expect(page.locator('.cv-node')).toHaveCount(4);
      await page.screenshot({ path: testInfo.outputPath('palette-add.png') });
    });

    test('automatic repair keeps Stop reachable while a panel is open', async ({
      page,
    }, testInfo) => {
      let received = 0;
      await page.route('**/api/decide', () => {
        received++;
      });
      await openDemo(page);
      await page.route('**/api/health', (route) =>
        route.fulfill({
          json: { configured: true, model: 'jev-1.13.0', callLimit: 18 },
        }),
      );
      await page.getByRole('radio', { name: 'Live', exact: true }).check();
      await expectReachable(page.getByTestId('operator-break'));
      await page.getByTestId('operator-break').click();
      await expect.poll(() => received).toBe(1);
      await expectReachable(page.getByTestId('operator-stop'));
      await openBuild(page, viewport.width);
      await expectReachable(page.getByTestId('operator-stop'));
      await page.screenshot({ path: testInfo.outputPath('pending-panel.png') });
      await page.getByTestId('operator-stop').click();
      await expect(page.locator('.operator-dock')).toHaveAttribute(
        'data-armed',
        'false',
      );
      await expectReachable(page.getByTestId('operator-toggle'));
      await expect(page.locator('.cv-node')).toHaveCount(3);
      expect(received).toBe(1);
    });

    test('Charts has its own reachable surface and leaves a usable canvas', async ({
      page,
    }, testInfo) => {
      await openDemo(page);
      await page.locator('.cv-node[data-id="db"]').click();
      const charts = page.getByRole('button', {
        name: viewport.width <= 720 ? 'Charts' : 'Show charts',
        exact: true,
      });
      await expectReachable(charts);
      await charts.click();
      await expectReachable(page.locator('.app-slot-bottom'));
      if (viewport.width <= 1100) {
        await expect(page.locator('.app-slot-left:not(.is-closing)')).toHaveCount(0);
        await expect(page.locator('.app-slot-right:not(.is-closing)')).toHaveCount(0);
      }
      await expectReachable(page.getByTestId('operator-status'));
      await expectReachable(page.getByTestId('operator-break'));
      if (viewport.width > 720) {
        const fit = page.getByRole('button', {
          name: 'Fit the diagram on screen',
          exact: true,
        });
        await expectReachable(fit);
        await fit.click();
        await expectGraphVisible(page);
      }
      await page.screenshot({ path: testInfo.outputPath('charts.png') });
      await page
        .getByRole('button', {
          name: viewport.width <= 720 ? 'Charts' : 'Hide charts',
          exact: true,
        })
        .click();
      await expect(page.locator('.app-slot-bottom:not(.is-closing)')).toHaveCount(0);
    });
  });
}

for (const viewport of [
  { width: 390, height: 844 },
  { width: 320, height: 740 },
]) {
  test.describe(`touch ${viewport.width}×${viewport.height}`, () => {
    test.use({ viewport, hasTouch: true, isMobile: true });
    test('44px touch targets fit the toolbar and zoom changes the canvas', async ({
      page,
    }, testInfo) => {
      const errors: string[] = [];
      let calls = 0;
      page.on('pageerror', (error) => errors.push(error.message));
      await page.route(/\/api\/(decide|design-step)$/, (route) => {
        calls++;
        return route.abort();
      });
      await openDemo(page);
      expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(
        true,
      );
      for (const name of [
        'Undo',
        'Redo',
        'Pause',
        'Step one tick',
        'Reset simulation',
        'Share',
        'Menu',
        'Zoom in',
        'Zoom out',
        'Fit the diagram on screen',
      ]) {
        await expectReachable(page.getByRole('button', { name, exact: true }));
      }
      const about = page.getByRole('button', { name: 'About', exact: true });
      const menu = page.getByRole('button', { name: 'Menu', exact: true });
      if (viewport.width <= 360) {
        await expect(about).not.toBeVisible();
        await menu.click();
        await page
          .getByRole('menuitem', { name: 'About breakscale-jev', exact: true })
          .click();
      } else {
        await expectReachable(about);
        await about.click();
      }
      await expect(page.getByRole('dialog')).toBeVisible();
      await page.getByRole('button', { name: 'Close About', exact: true }).click();
      await expect(page.getByRole('dialog')).not.toBeVisible();
      await expect(viewport.width <= 360 ? menu : about).toBeFocused();
      const body = page.locator('.cv-node-body').first();
      const before = await body.evaluate(
        (element) => element.getBoundingClientRect().width,
      );
      await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
      await expect
        .poll(() => body.evaluate((element) => element.getBoundingClientRect().width))
        .toBeGreaterThan(before);
      await page
        .getByRole('button', { name: 'Fit the diagram on screen', exact: true })
        .click();
      await expectGraphVisible(page);
      await page.screenshot({ path: testInfo.outputPath('touch-initial.png') });
      expect(errors).toEqual([]);
      expect(calls).toBe(0);
    });
  });
}

test.describe('the user’s 897×1204 dark window', () => {
  test.use({ viewport: { width: 897, height: 1204 }, colorScheme: 'dark' });
  test('transport, panels and chaos controls stay reachable during real manual damage', async ({
    page,
  }, info) => {
    await openDemo(page);
    for (const name of ['Pause', 'Step one tick', 'Reset simulation', 'About'])
      await expectReachable(page.getByRole('button', { name, exact: true }));
    for (const id of [
      'operator-break',
      'operator-slow',
      'operator-traffic',
      'operator-chaos',
      'operator-stop',
    ])
      await expectReachable(page.getByTestId(id));
    await openBuild(page, 897);
    await page.getByRole('button', { name: 'Hide components', exact: true }).click();
    await expect(page.locator('.app-slot-left:not(.is-closing)')).toHaveCount(0);
    await page.getByRole('button', { name: 'Show components', exact: true }).click();
    await expectReachable(
      page.getByRole('searchbox', { name: 'Search components', exact: true }),
    );
    await page.locator('.cv-node[data-id="db"]').click();
    await expectReachable(
      page.getByRole('textbox', { name: 'Node name', exact: true }),
    );
    await expectReachable(page.getByTestId('operator-chaos'));
    await page.screenshot({ path: info.outputPath('dark-user-window.png') });
    await page.getByTestId('operator-chaos').click();
    await expect(page.locator('.cv-node.is-faulted')).toHaveCount(2);
    await expectReachable(page.getByTestId('operator-stop'));
    await page.screenshot({ path: info.outputPath('dark-user-window-wrecked.png') });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(897);
  });
});

test('a queued workspace fit cannot undo an intentional zoom, and explicit Fit still works', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.clock.install({ time: new Date('2026-09-19T11:59:00Z') });
  await openDemo(page);
  await page.clock.pauseAt(new Date('2026-09-19T12:00:00Z'));
  await page.clock.runFor(1000);
  const build = page.getByRole('button', { name: 'Build', exact: true });
  const activate = async (control: Locator) => {
    // Native pointer hit-testing is covered above. Dispatch the same input
    // sequence here because this test deliberately pauses animation frames.
    await control.dispatchEvent('pointerdown', { button: 0, pointerType: 'mouse' });
    await control.dispatchEvent('pointerup', { button: 0, pointerType: 'mouse' });
    await control.dispatchEvent('click');
  };
  await activate(build);
  await expect(build).toHaveAttribute('aria-expanded', 'true');
  await page.clock.runFor(500);
  await activate(build);
  await expect(build).toHaveAttribute('aria-expanded', 'false');
  await page.clock.runFor(32);
  const body = page.locator('.cv-node-body').first();
  const width = () => body.evaluate((element) => element.getBoundingClientRect().width);
  const before = await width();
  await activate(page.getByRole('button', { name: 'Zoom in', exact: true }));
  await expect.poll(width).toBeGreaterThan(before);
  const zoomed = await width();
  await page.clock.runFor(500);
  expect(await width()).toBeCloseTo(zoomed, 3);
  await activate(
    page.getByRole('button', { name: 'Fit the diagram on screen', exact: true }),
  );
  await expect.poll(width).toBeLessThan(zoomed);
});

test('a chaos control preserves the queued panel fit so the damaged node stays visible', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.clock.install({ time: new Date('2026-09-19T11:59:00Z') });
  await openDemo(page);
  await page.clock.pauseAt(new Date('2026-09-19T12:00:00Z'));
  await page.clock.runFor(1000);
  const database = page.locator('.cv-node[data-id="db"]');
  // The clock is paused to keep the Inspector's workspace fit queued. Force
  // skips animation-frame stability checks but still emits native input.
  await database.click({ force: true });
  await expect(
    page.getByRole('textbox', { name: 'Node name', exact: true }),
  ).toBeVisible();
  await page.getByTestId('operator-break').click({ force: true });
  await expect(database).toHaveClass(/is-faulted/);
  await page.clock.runFor(500);
  await expectGraphVisible(page);
  await expectReachable(page.getByTestId('operator-stop'));
});
