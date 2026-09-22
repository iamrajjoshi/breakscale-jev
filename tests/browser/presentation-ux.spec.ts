import { expect, test, type Locator, type Page } from '@playwright/test';

const errors = new WeakMap<Page, string[]>();
const modelCalls = new WeakMap<Page, string[]>();
const healthCalls = new WeakMap<Page, number>();

test.beforeEach(async ({ page }) => {
  errors.set(page, []);
  modelCalls.set(page, []);
  healthCalls.set(page, 0);
  page.on('pageerror', (error) => errors.get(page)?.push(error.message));
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/health') {
      healthCalls.set(page, (healthCalls.get(page) ?? 0) + 1);
      await route.fulfill({
        json: { configured: true, model: 'jev-1.13.0', callLimit: 18 },
      });
    } else if (url.pathname.startsWith('/api/') || url.hostname.includes('typesafe')) {
      modelCalls.get(page)?.push(url.href);
      await route.abort();
    } else await route.fallback();
  });
  await page.route('https://api.github.com/**', (route) =>
    route.fulfill({ json: { stargazers_count: 0 } }),
  );
});

test.afterEach(async ({ page }) => {
  expect(errors.get(page)).toEqual([]);
  expect(modelCalls.get(page)).toEqual([]);
});

async function open(page: Page) {
  await page.goto('/');
  await expect(page.locator('.cv-node')).toHaveCount(7);
  await expect(
    page.getByRole('radio', { name: 'Recorded', exact: true }),
  ).toBeChecked();
}

async function reachable(control: Locator) {
  await expect(control).toBeVisible();
  await expect
    .poll(() =>
      control.evaluate((element) => {
        const target =
          element instanceof HTMLInputElement && element.type === 'radio'
            ? (element.labels?.[0] ?? element)
            : element;
        const box = target.getBoundingClientRect();
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
          (hit === target || target.contains(hit))
        );
      }),
    )
    .toBe(true);
}

for (const viewport of [
  { width: 1183, height: 1204 },
  { width: 390, height: 844 },
  { width: 320, height: 740 },
]) {
  test.describe(`presentation at ${viewport.width}px`, () => {
    test.use({
      viewport,
      hasTouch: viewport.width <= 720,
      isMobile: viewport.width <= 720,
    });

    test('the identity, recovery controls, and menu remain readable and reachable', async ({
      page,
    }, info) => {
      await open(page);
      const brand = page.getByTestId('playground-brand');
      await expect(brand).toBeVisible();
      await expect(brand).toContainText('breakscale-jev');
      const mark = brand.locator('svg');
      await expect(mark).toBeVisible();
      const box = await mark.boundingBox();
      const minimumMarkSize = viewport.width <= 720 ? 20 : 24;
      expect(box!.width).toBeGreaterThanOrEqual(minimumMarkSize);
      expect(box!.height).toBeGreaterThanOrEqual(minimumMarkSize);
      await expect(
        page.getByText('A system you can break.', { exact: true }),
      ).toHaveCount(0);
      await expect(page.getByTestId('operator-budget')).toHaveText('No API key needed');
      for (const control of [
        page.getByRole('radio', { name: 'Recorded', exact: true }),
        page.getByRole('radio', { name: 'Live', exact: true }),
        page.getByTestId('operator-stop'),
        page.getByRole('button', { name: 'Load outage demo', exact: true }),
        page.getByTestId('load-starter'),
        page.getByRole('button', { name: 'Zoom in', exact: true }),
      ])
        await reachable(control);
      const menu = page.getByRole('button', { name: 'Menu', exact: true });
      await menu.click();
      await expect(page.getByRole('menu')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.getByRole('menu')).not.toBeVisible();
      await expect(menu).toBeFocused();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
        viewport.width,
      );
      expect(healthCalls.get(page)).toBe(0);
      await page.screenshot({
        path: info.outputPath(`identity-controls-${viewport.width}.png`),
      });
    });

    test('native radio keyboard controls switch sources without starting a decision', async ({
      page,
    }, info) => {
      await open(page);
      const recorded = page.getByRole('radio', { name: 'Recorded', exact: true });
      const live = page.getByRole('radio', { name: 'Live', exact: true });
      await recorded.focus();
      await page.keyboard.press('ArrowRight');
      await expect(live).toBeChecked();
      await expect(live).toBeFocused();
      await expect(recorded).not.toBeChecked();
      await expect(page.locator('.operator-dock')).toHaveAttribute(
        'data-source',
        'live',
      );
      await expect.poll(() => healthCalls.get(page)).toBeGreaterThan(0);
      await expect(page.getByTestId('operator-budget')).toContainText(
        '0/18 this minute',
      );
      await reachable(page.getByTestId('operator-stop'));
      await page.keyboard.press('ArrowLeft');
      await expect(recorded).toBeChecked();
      await expect(recorded).toBeFocused();
      await expect(page.locator('.operator-dock')).toHaveAttribute(
        'data-source',
        'recorded',
      );
      await live.focus();
      await page.keyboard.press('Space');
      await expect(live).toBeChecked();
      await expect(
        page.getByRole('button', { name: 'Pause', exact: true }),
      ).toBeVisible();
      await page.getByTestId('operator-stop').click();
      await expect(page.locator('.operator-dock')).toHaveAttribute(
        'data-armed',
        'false',
      );
      await reachable(page.getByTestId('operator-toggle'));
      await page.screenshot({
        path: info.outputPath(`live-source-stopped-${viewport.width}.png`),
      });
    });
  });
}

test('the 1183px overview keeps aligned statistics and readable nodes at midzoom', async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1183, height: 1204 });
  await open(page);
  await page
    .getByRole('button', { name: 'Fit the diagram on screen', exact: true })
    .click();
  const zoom = async () =>
    Number.parseInt(await page.locator('.cv-zoom-level').innerText(), 10);
  for (let step = 0; step < 8 && (await zoom()) >= 70; step++)
    await page.getByRole('button', { name: 'Zoom out', exact: true }).click();
  for (let step = 0; step < 8 && (await zoom()) < 50; step++)
    await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  expect(await zoom()).toBeGreaterThanOrEqual(50);
  expect(await zoom()).toBeLessThan(70);
  await expect(page.locator('.cv-node-primary')).toHaveCount(7);
  for (const reading of await page.locator('.cv-node-primary').all())
    await expect(reading).toBeVisible();
  await expect(page.locator('.cv-node-sec')).toHaveCount(0);
  await expect(page.locator('.cv-spark')).toHaveCount(0);
  const rows = await page.locator('.traffic-metric').evaluateAll((metrics) =>
    metrics.map((metric) => ({
      label: metric.querySelector('.label')!.getBoundingClientRect().y,
      number: metric.querySelector('.num')!.getBoundingClientRect().y,
    })),
  );
  expect(rows).toHaveLength(4);
  expect(
    Math.max(...rows.map((row) => row.label)) -
      Math.min(...rows.map((row) => row.label)),
  ).toBeLessThanOrEqual(1);
  expect(
    Math.max(...rows.map((row) => row.number)) -
      Math.min(...rows.map((row) => row.number)),
  ).toBeLessThanOrEqual(1);
  await page.getByTestId('operator-stop').click();
  await page.getByTestId('operator-break').click();
  const database = page.locator('.cv-node[data-id="db"]');
  await expect(database).toHaveClass(/is-faulted/);
  const fault = await database.locator('.cv-node-mark.is-fault').boundingBox();
  const primary = await database.locator('.cv-node-primary').boundingBox();
  expect(fault).not.toBeNull();
  expect(fault!.y + fault!.height).toBeLessThan(primary!.y);
  await page.screenshot({ path: info.outputPath('overview-readable-1183.png') });
});

for (const width of [320, 390]) {
  test.describe(`dark touch controls at ${width}px`, () => {
    test.use({
      viewport: { width, height: width === 320 ? 740 : 844 },
      hasTouch: true,
      isMobile: true,
    });

    test('enabled SVG controls retain visible stroke contrast after switching to dark theme', async ({
      page,
    }, info) => {
      await open(page);
      await page.getByRole('button', { name: 'Menu', exact: true }).tap();
      await page.getByRole('menuitem', { name: 'Settings', exact: true }).tap();
      const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
      await settings.getByRole('radio', { name: 'Dark', exact: true }).tap();
      await page.keyboard.press('Escape');
      await expect(settings).not.toBeVisible();
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
      for (const name of [
        'Step one tick',
        'Reset simulation',
        'Menu',
        'Share',
        'Fit the diagram on screen',
        'Build',
        'Charts',
      ]) {
        const control = page.getByRole('button', { name, exact: true });
        await reachable(control);
        await expect
          .poll(
            () =>
              control.evaluate((element) => {
                const path = element.querySelector('svg path')!;
                const stroke = getComputedStyle(path).stroke;
                let parent: Element | null = element;
                let background = 'rgba(0, 0, 0, 0)';
                while (parent) {
                  background = getComputedStyle(parent).backgroundColor;
                  if (background !== 'rgba(0, 0, 0, 0)' && background !== 'transparent')
                    break;
                  parent = parent.parentElement;
                }
                const luminance = (color: string) => {
                  const channels = color
                    .match(/[\d.]+/g)!
                    .slice(0, 3)
                    .map(Number)
                    .map((value) => value / 255)
                    .map((value) =>
                      value <= 0.04045
                        ? value / 12.92
                        : ((value + 0.055) / 1.055) ** 2.4,
                    );
                  return (
                    channels[0]! * 0.2126 +
                    channels[1]! * 0.7152 +
                    channels[2]! * 0.0722
                  );
                };
                const foreground = luminance(stroke);
                const backdrop = luminance(background);
                return (
                  (Math.max(foreground, backdrop) + 0.05) /
                  (Math.min(foreground, backdrop) + 0.05)
                );
              }),
            { message: `${name} stroke must remain visible in dark mode` },
          )
          .toBeGreaterThanOrEqual(3);
      }
      await page.screenshot({ path: info.outputPath('dark-touch-icons-visible.png') });
    });
  });
}
