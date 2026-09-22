import { expect, test, type Page } from '@playwright/test';
import { MODEL } from '../../src/operator/contracts';
import { seedSimpleSystem } from './simple-system';

const pageErrors = new WeakMap<Page, string[]>();
let modelCalls = 0;
test.beforeEach(async ({ page }) => {
  modelCalls = 0;
  pageErrors.set(page, []);
  page.on('pageerror', (error) => pageErrors.get(page)?.push(error.message));
  await page.route(/\/api\/(decide|design-step)$/, async (route) => {
    modelCalls++;
    await route.abort();
  });
});
test.afterEach(async ({ page }) => {
  expect(modelCalls).toBe(0);
  expect(pageErrors.get(page)).toEqual([]);
});

async function openDemo(page: Page): Promise<void> {
  await seedSimpleSystem(page);
  await page.route('**/api/health', (route) =>
    route.fulfill({ json: { configured: false, model: MODEL, callLimit: 18 } }),
  );
  await page.route('https://api.github.com/**', (route) =>
    route.fulfill({ json: { stargazers_count: 0 } }),
  );
  await page.goto('/');
  await page.getByTestId('operator-stop').click();
  await expect(page.locator('.cv-node').first()).toBeVisible();
  await expect(page.getByTestId('operator-status')).toBeVisible();
}
const database = (page: Page) => page.locator('.cv-node[data-id="db"]');

test('canvas selection, pointer movement, rename and pause change the real application', async ({
  page,
}, testInfo) => {
  await openDemo(page);
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
  const time = await page.locator('.cv-ledger-time').innerText();
  await page.getByRole('button', { name: 'Step one tick', exact: true }).click();
  await expect(page.locator('.cv-ledger-time')).not.toHaveText(time);
  const node = database(page);
  const before = await node.getAttribute('transform');
  const box = await node.boundingBox();
  if (!box) throw new Error('Database node is not laid out');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 50, box.y + box.height / 2 + 35, {
    steps: 8,
  });
  await page.mouse.up();
  await expect(node).not.toHaveAttribute('transform', before ?? '');
  await expect(node).toHaveAttribute('aria-pressed', 'true');
  await page
    .getByRole('textbox', { name: 'Node name', exact: true })
    .fill('Primary database');
  await page.getByRole('textbox', { name: 'Node name', exact: true }).press('Enter');
  await expect(node).toHaveAttribute('aria-label', /Primary database/);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          JSON.parse(
            localStorage.getItem('breakscale.session.v1') ?? '{}',
          ).topology?.nodes.find((item: { id: string }) => item.id === 'db')?.label,
      ),
    )
    .toBe('Primary database');
  await page.screenshot({ path: testInfo.outputPath('canvas-controls.png') });
});

for (const viewport of [
  { width: 1440, height: 1000 },
  { width: 390, height: 844 },
  { width: 320, height: 740 },
]) {
  test(`About contains focus and automatic-repair controls fit at ${viewport.width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize(viewport);
    await openDemo(page);
    await expect(page.locator('.cv-node')).toHaveCount(3);
    await expect
      .poll(() =>
        page.locator('.cv-node').evaluateAll((nodes) =>
          nodes.flatMap((node) => {
            const body = node.querySelector('.cv-node-body');
            if (!body) return ['missing node body'];
            const rect = body.getBoundingClientRect();
            const id = node.getAttribute('data-id');
            if (
              rect.left < 0 ||
              rect.top < 0 ||
              rect.right > innerWidth ||
              rect.bottom > innerHeight
            )
              return [`${id} outside the viewport`];
            const inset = Math.min(6, rect.width / 4, rect.height / 4);
            const points = [
              [rect.left + inset, rect.top + inset],
              [rect.right - inset, rect.top + inset],
              [rect.left + inset, rect.bottom - inset],
              [rect.right - inset, rect.bottom - inset],
            ];
            return points.some(
              ([x, y]) =>
                document.elementFromPoint(x!, y!)?.closest('.cv-node') !== node,
            )
              ? [`${id} is covered`]
              : [];
          }),
        ),
      )
      .toEqual([]);
    const opener = page.getByRole('button', { name: 'About', exact: true });
    await opener.click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('h2')).toBeVisible();
    await expect(dialog).toContainText('Breakscale');
    await expect(dialog).toContainText('JEV');
    const focusInside = () =>
      page.evaluate(() =>
        document.querySelector('dialog[open]')?.contains(document.activeElement),
      );
    expect(await focusInside()).toBe(true);
    for (let i = 0; i < 8; i++) {
      await page.keyboard.press('Tab');
      expect(await focusInside()).toBe(true);
    }
    for (let i = 0; i < 8; i++) {
      await page.keyboard.press('Shift+Tab');
      expect(await focusInside()).toBe(true);
    }
    await page.screenshot({ path: testInfo.outputPath(`about-${viewport.width}.png`) });
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
    await expect(opener).toBeFocused();
    const bounds = await page.locator('.operator-dock').boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
      viewport.width,
    );
    await page.screenshot({ path: testInfo.outputPath(`demo-${viewport.width}.png`) });
  });
}

test('a focused canvas node can be nudged and undone with the keyboard', async ({
  page,
}) => {
  await openDemo(page);
  const readX = () =>
    page.evaluate(
      () =>
        JSON.parse(
          localStorage.getItem('breakscale.session.v1') ?? '{}',
        ).topology?.nodes.find((node: { id: string }) => node.id === 'db')?.x,
    );
  await expect.poll(readX).toEqual(expect.any(Number));
  const before = await readX();
  await database(page).focus();
  await database(page).press('ArrowRight');
  await expect.poll(readX).toBe(before + 8);
  await page.keyboard.press('Control+z');
  await expect.poll(readX).toBe(before);
});

test('the wide components rail resizes, persists and restores its width', async ({
  page,
}) => {
  await openDemo(page);
  const showComponents = page.getByRole('button', {
    name: 'Show components',
    exact: true,
  });
  if (await showComponents.isVisible()) await showComponents.click();
  const rail = page.locator('.app-slot-left');
  const handle = page.getByRole('separator', { name: 'Resize the components rail' });
  await handle.hover();
  const initial = await rail.boundingBox();
  const grip = await handle.boundingBox();
  if (!initial || !grip) throw new Error('The components rail has no resize geometry');
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(grip.x + grip.width / 2 + 64, grip.y + grip.height / 2, {
    steps: 8,
  });
  await page.mouse.up();
  await expect
    .poll(async () => (await rail.boundingBox())?.width)
    .toBe(initial.width + 64);
  await expect
    .poll(() =>
      page.evaluate(
        () => JSON.parse(localStorage.getItem('breakscale.layout.v1') ?? '{}').railW,
      ),
    )
    .toBe(initial.width + 64);
  await handle.dblclick();
  await expect.poll(async () => (await rail.boundingBox())?.width).toBe(224);
});
