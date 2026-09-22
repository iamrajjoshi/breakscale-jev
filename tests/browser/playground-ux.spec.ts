import { expect, test, type Locator, type Page } from '@playwright/test';
import type { Topology } from '../../src/sim/types';

const errors = new WeakMap<Page, string[]>();
const backendCalls = new WeakMap<Page, string[]>();

test.beforeEach(async ({ page }) => {
  errors.set(page, []);
  backendCalls.set(page, []);
  page.on('pageerror', (error) => errors.get(page)?.push(error.message));
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith('/api/') || url.hostname.includes('typesafe')) {
      backendCalls.get(page)?.push(`${route.request().method()} ${url.href}`);
      await route.abort();
    } else await route.fallback();
  });
  await page.route('https://api.github.com/**', (route) =>
    route.fulfill({ json: { stargazers_count: 0 } }),
  );
});

test.afterEach(async ({ page }) => {
  expect(errors.get(page)).toEqual([]);
  expect(backendCalls.get(page)).toEqual([]);
});

const dock = (page: Page) => page.locator('.operator-dock');
const activity = (page: Page, state?: string) =>
  page.locator(
    `[data-testid="operator-activity-entry"]${state ? `[data-status="${state}"]` : ''}`,
  );
const metric = async (page: Page, label: string) =>
  Number.parseFloat(
    await page
      .locator('.traffic-metric')
      .filter({ hasText: label })
      .locator('.num')
      .innerText(),
  );

async function open(page: Page) {
  await page.goto('/');
  await expect(page.locator('.cv-node')).toHaveCount(7);
  await expect(page.locator('.cv-edge-hit')).toHaveCount(8);
  await expect.poll(async () => (await savedSession(page)).rps).toBe(150);
  await expect(dock(page)).toHaveAttribute('data-source', 'recorded');
}

async function savedSession(page: Page): Promise<{ topology: Topology; rps: number }> {
  return page.evaluate(() =>
    JSON.parse(localStorage.getItem('breakscale.session.v1') ?? '{}'),
  );
}

async function stopRepairs(page: Page) {
  const stop = page.getByTestId('operator-stop');
  if (await stop.isVisible()) await stop.click();
  await expect(page.getByTestId('operator-toggle')).toBeVisible();
}

async function edgePoint(page: Page, id: string) {
  return page.locator(`.cv-edge-hit[data-id="${id}"]`).evaluate((element) => {
    const path = element as SVGPathElement;
    const point = path.getPointAtLength(path.getTotalLength() / 2);
    const screen = new DOMPoint(point.x, point.y).matrixTransform(path.getScreenCTM()!);
    return { x: screen.x, y: screen.y };
  });
}

async function expectReachable(control: Locator) {
  await expect(control).toBeVisible();
  await expect
    .poll(() =>
      control.evaluate((element) => {
        const box = element.getBoundingClientRect();
        const hit = document.elementFromPoint(
          box.x + box.width / 2,
          box.y + box.height / 2,
        );
        return (
          box.x >= 0 &&
          box.y >= 0 &&
          box.right <= innerWidth + 1 &&
          box.bottom <= innerHeight + 1 &&
          !!hit &&
          (hit === element || element.contains(hit))
        );
      }),
    )
    .toBe(true);
}

async function expectGraphVisible(page: Page) {
  await expect
    .poll(() =>
      page.locator('.cv-node').evaluateAll((nodes) =>
        nodes.flatMap((node) => {
          const body = node.querySelector('.cv-node-body');
          if (!body) return ['Missing node body'];
          const box = body.getBoundingClientRect();
          const points = [
            [box.left + 2, box.top + 2],
            [box.right - 2, box.top + 2],
            [box.left + 2, box.bottom - 2],
            [box.right - 2, box.bottom - 2],
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

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 900, height: 800 },
  { width: 390, height: 844 },
  { width: 320, height: 740 },
]) {
  test(`the first view explains the playground and leaves usable canvas at ${viewport.width}px`, async ({
    page,
  }, info) => {
    await page.setViewportSize(viewport);
    await open(page);
    await expect(page.getByTestId('playground-brand')).toBeVisible();
    await expect(
      page.getByRole('searchbox', { name: 'Search components', exact: true }),
    ).not.toBeVisible();
    for (const control of [
      page.getByRole('button', { name: 'Load outage demo', exact: true }),
      page.getByTestId('source-recorded'),
      page.getByTestId('source-live'),
      page.getByTestId('operator-stop'),
      page.getByTestId('operator-break'),
      page.getByRole('button', { name: 'Pause', exact: true }),
    ])
      await expectReachable(control);
    await expectGraphVisible(page);
    await expectReachable(page.getByTestId('load-starter'));
    await expect(page.locator('.stage-edit-tools')).toContainText(
      viewport.width <= 720 ? 'Pinch to zoom.' : 'Drag between ports to connect.',
    );
    const canvas = await page.locator('.stage-safe').boundingBox();
    expect(canvas).not.toBeNull();
    expect(canvas!.width).toBeGreaterThan(viewport.width * 0.6);
    expect(canvas!.height).toBeGreaterThan(viewport.height * 0.3);
    if (viewport.width >= 1100) {
      const rail = await dock(page).boundingBox();
      expect(rail).not.toBeNull();
      expect(rail!.x).toBeGreaterThan(viewport.width * 0.65);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
      viewport.width,
    );
    await page.screenshot({
      path: info.outputPath(`first-view-${viewport.width}.png`),
    });
  });
}

test('the first action runs a seven-component outage, six recorded repairs, and fresh recovery measurements', async ({
  page,
}, info) => {
  test.setTimeout(60_000);
  await open(page);
  await page.getByRole('button', { name: 'Load outage demo', exact: true }).click();
  await expect(page.locator('.cv-node.is-faulted')).toHaveCount(6);
  await expect(activity(page)).toHaveCount(6, { timeout: 40_000 });
  await expect(activity(page).first()).toHaveAttribute('data-status', 'healthy', {
    timeout: 10_000,
  });
  const rows = await activity(page).evaluateAll((entries) =>
    entries.map((entry) => ({
      source: entry.getAttribute('data-source'),
      applied: entry.getAttribute('data-applied'),
      interval: entry.querySelector('.activity-sample-interval')?.textContent ?? '',
    })),
  );
  for (const row of rows) {
    expect(row.source).toBe('recorded');
    expect(row.applied).toBe('true');
    const seconds = row.interval.match(/\(([\d.]+)s\)/);
    expect(seconds, row.interval).not.toBeNull();
    expect(Number(seconds![1])).toBeGreaterThanOrEqual(2.4);
  }
  await expect(page.locator('.cv-node.is-faulted')).toHaveCount(0);
  await expect.poll(() => metric(page, 'Goodput')).toBeGreaterThan(135);
  await expect.poll(() => metric(page, 'Errors')).toBeLessThan(1);
  await expect
    .poll(() =>
      page.evaluate(
        () => JSON.parse(localStorage.getItem('breakscale.session.v1') ?? '{}').rps,
      ),
    )
    .toBe(150);
  await expectGraphVisible(page);
  await page.screenshot({ path: info.outputPath('first-outage-recovered.png') });
});

for (const viewport of [
  { width: 390, height: 844 },
  { width: 320, height: 740 },
]) {
  test(`the mobile exploration drawer opens with the keyboard and closes without losing controls at ${viewport.width}px`, async ({
    page,
  }, info) => {
    await page.setViewportSize(viewport);
    await open(page);
    const toggle = page.getByTestId('operator-explore-toggle');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByTestId('operator-recordings')).not.toBeVisible();
    await toggle.focus();
    await toggle.press('Enter');
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByTestId('operator-recordings')).toBeVisible();
    for (const control of [
      toggle,
      page.getByTestId('source-recorded'),
      page.getByTestId('source-live'),
      page.getByTestId('operator-stop'),
      page.getByTestId('operator-break'),
      page.getByTestId('operator-activity-toggle'),
    ])
      await expectReachable(control);
    await page.screenshot({
      path: info.outputPath(`drawer-open-${viewport.width}.png`),
    });
    await page.getByTestId('operator-activity-toggle').focus();
    await page.keyboard.press('Escape');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(toggle).toBeFocused();
    await expect(page.getByTestId('operator-recordings')).not.toBeVisible();
    await expectGraphVisible(page);
    await expectReachable(page.getByRole('button', { name: 'Pause', exact: true }));
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
      viewport.width,
    );
    await page.screenshot({
      path: info.outputPath(`drawer-closed-${viewport.width}.png`),
    });
    await toggle.press('Enter');
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await toggle.press('Space');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(toggle).toBeFocused();
  });
}

test('the quieter entry keeps component editing and Undo available', async ({
  page,
}, info) => {
  await open(page);
  await page.getByTestId('operator-stop').click();
  await page.getByRole('button', { name: 'Show components', exact: true }).click();
  const search = page.getByRole('searchbox', {
    name: 'Search components',
    exact: true,
  });
  await expectReachable(search);
  await search.fill('Cache');
  await page.locator('.pal-row[data-kind="cache"]').click();
  await expect(page.locator('.cv-node')).toHaveCount(8);
  const cache = page.locator('.cv-node[data-kind="cache"]:not([data-id="cache"])');
  await cache.click();
  const name = page.getByRole('textbox', { name: 'Node name', exact: true });
  await expectReachable(name);
  await name.fill('Hot objects');
  await name.press('Enter');
  await expect(cache).toHaveAttribute('aria-label', /Hot objects/);
  await expectReachable(page.getByTestId('operator-toggle'));
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(cache).not.toHaveAttribute('aria-label', /Hot objects/);
  await expect(page.locator('.cv-node')).toHaveCount(8);
  await page
    .getByRole('button', { name: 'Fit the diagram on screen', exact: true })
    .click();
  await expectGraphVisible(page);
  await page.screenshot({ path: info.outputPath('manual-edit-undo.png') });
});

test('both themes retain readable controls and the same playable canvas', async ({
  page,
}, info) => {
  await open(page);
  for (const theme of ['Dark', 'Light'] as const) {
    await page.getByRole('button', { name: 'Menu', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
    const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
    await settings.getByRole('radio', { name: theme, exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute(
      'data-theme',
      theme.toLowerCase(),
    );
    await page.keyboard.press('Escape');
    await expect(settings).not.toBeVisible();
    await expectGraphVisible(page);
    for (const control of [
      page.getByRole('button', { name: 'Load outage demo', exact: true }),
      page.getByTestId('source-recorded'),
      page.getByTestId('source-live'),
      page.getByTestId('operator-stop'),
    ])
      await expectReachable(control);
    await page.screenshot({
      path: info.outputPath(`theme-${theme.toLowerCase()}.png`),
    });
  }
});

test.describe('touch phone', () => {
  test.use({ viewport: { width: 320, height: 740 }, hasTouch: true, isMobile: true });

  test('44px controls and zooming the seven-component graph respond to actual taps', async ({
    page,
  }, info) => {
    await open(page);
    expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(
      true,
    );
    for (const control of [
      page.getByTestId('source-recorded'),
      page.getByTestId('source-live'),
      page.getByTestId('operator-stop'),
      page.getByRole('button', { name: 'Load outage demo', exact: true }),
      page.getByTestId('operator-break'),
      page.getByTestId('operator-slow'),
      page.getByTestId('operator-traffic'),
      page.getByTestId('operator-chaos'),
      page.getByTestId('operator-explore-toggle'),
    ]) {
      await expectReachable(control);
      const box = await control.boundingBox();
      expect(box!.width).toBeGreaterThanOrEqual(44);
      expect(box!.height).toBeGreaterThanOrEqual(44);
    }
    await expectGraphVisible(page);
    await page.screenshot({ path: info.outputPath('touch-first-view-320.png') });
    await page.getByRole('button', { name: 'Zoom in', exact: true }).tap();
    await page.getByRole('button', { name: 'Zoom in', exact: true }).tap();
    await page.getByRole('button', { name: 'Zoom in', exact: true }).tap();
    const api = page.locator('.cv-node[data-id="api2"]');
    const box = await api.locator('.cv-node-body').boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(44);
    await api.tap();
    await expect(api).toHaveAttribute('aria-pressed', 'true');
    await expectReachable(
      page.getByRole('textbox', { name: 'Node name', exact: true }),
    );
    await expectReachable(page.getByTestId('operator-stop'));
    await page.getByRole('button', { name: 'Inspect', exact: true }).tap();
    await page
      .getByRole('button', { name: 'Fit the diagram on screen', exact: true })
      .tap();
    await expectGraphVisible(page);
    const explore = page.getByTestId('operator-explore-toggle');
    await explore.tap();
    await expect(explore).toHaveAttribute('aria-expanded', 'true');
    await explore.tap();
    await expect(explore).toHaveAttribute('aria-expanded', 'false');
    await expectGraphVisible(page);
  });

  test('a touch-selected connection can be deleted in the Inspector and restored with Undo', async ({
    page,
  }, info) => {
    await open(page);
    await stopRepairs(page);
    const point = await edgePoint(page, 'client-lb');
    await page.touchscreen.tap(point.x, point.y);
    const inspector = page.getByRole('complementary', {
      name: 'Inspector',
      exact: true,
    });
    await expect(inspector).toContainText('1 connection selected.');
    const remove = inspector.getByRole('button', {
      name: 'Delete connection',
      exact: true,
    });
    await expectReachable(remove);
    await remove.tap();
    await expect(page.locator('.cv-edge-hit')).toHaveCount(7);
    await expect
      .poll(async () =>
        (await savedSession(page)).topology.edges.some(
          (edge) => edge.id === 'client-lb',
        ),
      )
      .toBe(false);
    await expect(inspector).not.toBeVisible();
    await page.getByRole('button', { name: 'Undo', exact: true }).tap();
    await expect(page.locator('.cv-edge-hit')).toHaveCount(8);
    await expect(page.locator('.cv-edge-hit[data-id="client-lb"]')).toHaveCount(1);
    await expect(inspector).toContainText('1 connection selected.');
    await page.getByRole('button', { name: 'Inspect', exact: true }).tap();
    await expectGraphVisible(page);
    await page.screenshot({ path: info.outputPath('touch-connection-restored.png') });
  });
});

test('the web app supports dragging, port connections, independent settings and saved edits', async ({
  page,
}, info) => {
  await open(page);
  await stopRepairs(page);
  const original = (await savedSession(page)).topology;
  const api = page.locator('.cv-node[data-id="api2"]');
  const body = await api.locator('.cv-node-body').boundingBox();
  await page.mouse.move(body!.x + body!.width / 2, body!.y + body!.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    body!.x + body!.width / 2 + 20,
    body!.y + body!.height / 2 + 15,
    { steps: 8 },
  );
  await page.mouse.up();
  await expect
    .poll(async () => {
      const node = (await savedSession(page)).topology.nodes.find(
        (node) => node.id === 'api2',
      )!;
      const before = original.nodes.find((node) => node.id === 'api2')!;
      return node.x !== before.x && node.y !== before.y;
    })
    .toBe(true);
  await api.click();
  const name = page.getByRole('textbox', { name: 'Node name', exact: true });
  await name.fill('Orders API');
  await name.press('Enter');
  const slots = page.getByRole('spinbutton', {
    name: 'Slots per instance',
    exact: true,
  });
  await slots.fill('3');
  await slots.press('Enter');
  await expect
    .poll(
      async () =>
        (await savedSession(page)).topology.nodes.find((node) => node.id === 'api2')
          ?.config.capacity,
    )
    .toBe(3);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(slots).toHaveValue('8');
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect(slots).toHaveValue('3');
  const edited = (await savedSession(page)).topology;
  expect(edited.nodes.find((node) => node.id === 'api1')).toEqual(
    original.nodes.find((node) => node.id === 'api1'),
  );
  expect(edited.nodes.find((node) => node.id === 'api3')).toEqual(
    original.nodes.find((node) => node.id === 'api3'),
  );
  await page.getByRole('button', { name: 'Hide inspector', exact: true }).click();
  await page
    .getByRole('button', { name: 'Fit the diagram on screen', exact: true })
    .click();
  await expectGraphVisible(page);
  const fromPort = page.locator('.cv-port-hit[data-hit="port-out"][data-id="api2"]');
  const toPort = page.locator('.cv-port-hit[data-hit="port-in"][data-id="db"]');
  await fromPort.dragTo(toPort);
  await expect(page.locator('.cv-edge-hit')).toHaveCount(9);
  // The same visible input-port target still rejects duplicates and self-links.
  await fromPort.dragTo(toPort);
  await expect(page.locator('.cv-edge-hit')).toHaveCount(9);
  await fromPort.dragTo(
    page.locator('.cv-port-hit[data-hit="port-in"][data-id="api2"]'),
  );
  await expect(page.locator('.cv-edge-hit')).toHaveCount(9);
  await expect
    .poll(async () =>
      (await savedSession(page)).topology.edges.some(
        (edge) => edge.from === 'api2' && edge.to === 'db',
      ),
    )
    .toBe(true);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.locator('.cv-edge-hit')).toHaveCount(8);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect(page.locator('.cv-edge-hit')).toHaveCount(9);
  const saved = await savedSession(page);
  await page.reload();
  await expect(page.locator('.cv-edge-hit')).toHaveCount(9);
  expect(await savedSession(page)).toEqual(saved);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(page.locator('.cv-node')).toHaveCount(7);
  expect(await savedSession(page)).toEqual(saved);
  await page.screenshot({
    path: info.outputPath('saved-edits-preserved-on-phone.png'),
  });
});

test('Load web app replaces an edited canvas and Undo restores the design and its active fault', async ({
  page,
}, info) => {
  await open(page);
  await stopRepairs(page);
  const api = page.locator('.cv-node[data-id="api2"]');
  await api.click();
  const name = page.getByRole('textbox', { name: 'Node name', exact: true });
  await name.fill('My damaged API');
  await name.press('Enter');
  await page.getByTestId('operator-break').click();
  await expect(api).toHaveClass(/is-faulted/);
  const damaged = await savedSession(page);
  await page.getByTestId('load-starter').click();
  await expect(page.locator('.cv-node.is-faulted')).toHaveCount(0);
  await expect(page.locator('.cv-node[data-id="api2"]')).toHaveAttribute(
    'aria-label',
    /API 2/,
  );
  await stopRepairs(page);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.locator('.cv-node[data-id="api2"]')).toHaveAttribute(
    'aria-label',
    /My damaged API/,
  );
  await expect(page.locator('.cv-node[data-id="api2"]')).toHaveClass(/is-faulted/);
  expect(await savedSession(page)).toEqual(damaged);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect(page.locator('.cv-node.is-faulted')).toHaveCount(0);
  await expect(page.locator('.cv-node[data-id="api2"]')).toHaveAttribute(
    'aria-label',
    /API 2/,
  );
  await page.screenshot({ path: info.outputPath('starter-restored.png') });
});

test('loading an unchanged web app still gives a fault-aware Undo and Redo entry', async ({
  page,
}) => {
  await open(page);
  await stopRepairs(page);
  await page.locator('.cv-node[data-id="db"]').click();
  await page.getByTestId('operator-break').click();
  await expect(page.locator('.cv-node[data-id="db"]')).toHaveClass(/is-faulted/);
  await page.getByTestId('load-starter').click();
  await expect(page.locator('.cv-node.is-faulted')).toHaveCount(0);
  await stopRepairs(page);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.locator('.cv-node[data-id="db"]')).toHaveClass(/is-faulted/);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect(page.locator('.cv-node.is-faulted')).toHaveCount(0);
});

for (const scenario of [
  { id: 'api2', label: 'API 2', fault: 'crash', control: 'operator-break' },
  { id: 'cache', label: 'Shared cache', fault: 'slow', control: 'operator-slow' },
]) {
  test(`manually applying ${scenario.fault} to ${scenario.label} replays its matching repair and measures recovery`, async ({
    page,
  }, info) => {
    await open(page);
    const before = await savedSession(page);
    const component = page.locator(`.cv-node[data-id="${scenario.id}"]`);
    await component.click();
    await expect(component).toHaveAttribute('aria-pressed', 'true');
    await page.getByTestId(scenario.control).click();
    await expect(component).toHaveAttribute(
      'aria-label',
      new RegExp(`faulted: ${scenario.fault}`),
    );
    await expect(page.locator('.cv-node.is-faulted')).toHaveCount(1);
    await expect(activity(page)).toHaveCount(1, { timeout: 10_000 });
    await expect(activity(page).first()).toHaveAttribute('data-status', 'healthy', {
      timeout: 10_000,
    });
    await expect(activity(page).first()).toHaveAttribute('data-source', 'recorded');
    await expect(activity(page).first()).toHaveAttribute('data-applied', 'true');
    await expect(activity(page).first()).toContainText(scenario.label);
    const interval = await activity(page)
      .first()
      .locator('.activity-sample-interval')
      .textContent();
    const seconds = interval?.match(/\(([\d.]+)s\)/);
    expect(seconds, interval ?? '').not.toBeNull();
    expect(Number(seconds![1])).toBeGreaterThanOrEqual(2.4);
    await expect(page.locator('.cv-node.is-faulted')).toHaveCount(0);
    expect(await savedSession(page)).toEqual(before);
    await expect.poll(() => metric(page, 'Errors')).toBeLessThan(1);
    await page.screenshot({
      path: info.outputPath(`manual-${scenario.id}-${scenario.fault}-repaired.png`),
    });
  });
}
