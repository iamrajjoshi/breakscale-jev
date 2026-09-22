import { expect, test, type Locator, type Page } from '@playwright/test';

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
  await expect(page.locator('.cv-node')).toHaveCount(3);
  await expect(dock(page)).toHaveAttribute('data-source', 'recorded');
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
      page.getByRole('button', { name: 'Try a full outage', exact: true }),
      page.getByTestId('operator-source'),
      page.getByTestId('operator-stop'),
      page.getByTestId('operator-break'),
      page.getByRole('button', { name: 'Pause', exact: true }),
    ])
      await expectReachable(control);
    await expectGraphVisible(page);
    if (viewport.width <= 720) {
      const nodeHeights = await page
        .locator('.cv-node-body')
        .evaluateAll((nodes) =>
          nodes.map((node) => node.getBoundingClientRect().height),
        );
      expect(nodeHeights.every((height) => height >= 44)).toBe(true);
    }
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

test('the first action runs a real outage, three recorded repairs, and fresh recovery measurements', async ({
  page,
}, info) => {
  await open(page);
  await page.getByRole('button', { name: 'Try a full outage', exact: true }).click();
  await expect(page.locator('.cv-node.is-faulted')).toHaveCount(2);
  await expect(activity(page)).toHaveCount(3, { timeout: 20_000 });
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
  await expect.poll(() => metric(page, 'Goodput')).toBeGreaterThan(170);
  await expect.poll(() => metric(page, 'Errors')).toBeLessThan(1);
  await expect
    .poll(() =>
      page.evaluate(
        () => JSON.parse(localStorage.getItem('breakscale.session.v1') ?? '{}').rps,
      ),
    )
    .toBe(200);
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
      page.getByTestId('operator-source'),
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
  await expect(page.locator('.cv-node')).toHaveCount(4);
  const cache = page.locator('.cv-node[data-kind="cache"]');
  await cache.click();
  const name = page.getByRole('textbox', { name: 'Node name', exact: true });
  await expectReachable(name);
  await name.fill('Hot objects');
  await name.press('Enter');
  await expect(cache).toHaveAttribute('aria-label', /Hot objects/);
  await expectReachable(page.getByTestId('operator-toggle'));
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(cache).not.toHaveAttribute('aria-label', /Hot objects/);
  await expect(page.locator('.cv-node')).toHaveCount(4);
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
      page.getByRole('button', { name: 'Try a full outage', exact: true }),
      page.getByTestId('operator-source'),
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

  test('44px controls and the vertical graph respond to actual taps', async ({
    page,
  }, info) => {
    await open(page);
    expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(
      true,
    );
    for (const control of [
      page.getByTestId('operator-source'),
      page.getByTestId('operator-stop'),
      page.getByRole('button', { name: 'Try a full outage', exact: true }),
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
    const database = page.locator('.cv-node[data-id="db"]');
    const box = await database.locator('.cv-node-body').boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(44);
    await page.screenshot({ path: info.outputPath('touch-first-view-320.png') });
    await database.tap();
    await expect(database).toHaveAttribute('aria-pressed', 'true');
    await expectReachable(
      page.getByRole('textbox', { name: 'Node name', exact: true }),
    );
    await expectReachable(page.getByTestId('operator-stop'));
    await page.getByRole('button', { name: 'Inspect', exact: true }).tap();
    await expectGraphVisible(page);
    const explore = page.getByTestId('operator-explore-toggle');
    await explore.tap();
    await expect(explore).toHaveAttribute('aria-expanded', 'true');
    await explore.tap();
    await expect(explore).toHaveAttribute('aria-expanded', 'false');
    await expectGraphVisible(page);
  });
});
