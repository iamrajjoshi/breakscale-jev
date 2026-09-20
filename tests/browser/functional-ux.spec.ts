import { expect, test, type Page } from '@playwright/test';

const pageErrors = new WeakMap<Page, string[]>();
const modelCalls = new WeakMap<Page, number>();
test.beforeEach(async ({ page }) => {
  pageErrors.set(page, []);
  modelCalls.set(page, 0);
  page.on('pageerror', (error) => pageErrors.get(page)?.push(error.message));
  await page.route(/\/api\/(?:decide|design-step)$/, (route) => {
    modelCalls.set(page, (modelCalls.get(page) ?? 0) + 1);
    return route.abort();
  });
  await page.route('**/api/health', (route) =>
    route.fulfill({ json: { configured: false, model: 'jev-1.13.0', callLimit: 18 } }),
  );
  await page.goto('/');
  await expect(page.locator('.cv-node')).toHaveCount(3);
});
test.afterEach(async ({ page }) => {
  expect(pageErrors.get(page)).toEqual([]);
  expect(modelCalls.get(page)).toBe(0);
});
const nodeCount = (page: Page) => page.locator('.cv-node');
const savedEdges = (page: Page) =>
  page.evaluate(
    () =>
      JSON.parse(localStorage.getItem('breakscale.session.v1') ?? '{}').topology?.edges
        .length,
  );

async function menu(page: Page, name: string) {
  await page.getByRole('button', { name: 'Menu', exact: true }).click();
  await page.getByRole('menuitem', { name, exact: true }).click();
}

test('palette search and click add a visible component without hiding an existing one', async ({
  page,
}, testInfo) => {
  const search = page.getByRole('searchbox', { name: 'Search components' });
  await search.fill('cache');
  await expect(page.locator('.pal-row[data-kind]')).toHaveCount(2);
  await page.locator('.pal-row[data-kind="cache"]').click();
  await expect(nodeCount(page)).toHaveCount(4);
  await expect
    .poll(() =>
      page.locator('.cv-node').evaluateAll((nodes) => {
        const boxes = nodes.map((node) => node.getBoundingClientRect());
        return boxes.some((a, i) =>
          boxes
            .slice(i + 1)
            .some(
              (b) =>
                Math.min(a.right, b.right) > Math.max(a.left, b.left) &&
                Math.min(a.bottom, b.bottom) > Math.max(a.top, b.top),
            ),
        );
      }),
    )
    .toBe(false);
  const added = page.locator('.cv-node[data-kind="cache"]');
  await expect(added).toHaveClass(/is-ok/);
  await expect(added).toContainText('idle');
  await search.press('Escape');
  await expect(search).toHaveValue('');
  await expect(page.locator('.pal-row[data-kind]')).toHaveCount(33);
  await page.screenshot({ path: testInfo.outputPath('palette-visible.png') });
});

test('Space activates a focused palette button once without pausing the simulation', async ({
  page,
}) => {
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
  await page.locator('.pal-row[data-kind="cache"]').focus();
  await page.keyboard.press('Space');
  await expect(nodeCount(page)).toHaveCount(4);
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
});

test('Share traps focus, keeps shortcuts inside the dialog, and restores its opener', async ({
  page,
}, testInfo) => {
  await page.locator('.pal-row[data-kind="cache"]').click();
  await expect(nodeCount(page)).toHaveCount(4);
  const opener = page.getByRole('button', { name: 'Share', exact: true });
  await opener.click();
  const dialog = page.getByRole('dialog', { name: 'Share this design' });
  const close = dialog.getByRole('button', { name: 'Close', exact: true });
  await expect(close).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(dialog.getByRole('button', { name: 'Save to a file' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(close).toBeFocused();
  const generate = dialog.getByRole('button', { name: 'Generate link' });
  await generate.focus();
  await page.keyboard.press('Control+z');
  await expect(nodeCount(page)).toHaveCount(4);
  await page.keyboard.press('Space');
  await expect(
    dialog.getByRole('textbox', { name: 'Link to this design' }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Copy link' }).focus();
  await page.keyboard.press('Tab');
  await expect(close).toBeFocused();
  await page.screenshot({ path: testInfo.outputPath('share-focus.png') });
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await expect(opener).toBeFocused();
});

test('Examples search, focus wrap, Escape, load and Undo work together', async ({
  page,
}, testInfo) => {
  await menu(page, 'Examples');
  const dialog = page.getByRole('dialog', { name: 'Examples', exact: true });
  const search = dialog.getByRole('textbox', { name: 'Search examples' });
  await expect(search).toBeFocused();
  await search.fill('queue');
  await page.locator('.ex-item').last().focus();
  await page.keyboard.press('Tab');
  await expect(
    dialog.getByRole('button', { name: 'Close', exact: true }),
  ).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(page.locator('.ex-item').last()).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'Menu', exact: true })).toBeFocused();
  await menu(page, 'Examples');
  await search.fill('Rate limited API');
  await expect(page.locator('.ex-item')).toHaveCount(1);
  await page.locator('.ex-item').press('Enter');
  await expect(dialog).not.toBeVisible();
  await expect(nodeCount(page)).toHaveCount(4);
  await page.screenshot({ path: testInfo.outputPath('example-loaded.png') });
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(nodeCount(page)).toHaveCount(3);
});

for (const kind of ['cache', 'cdn']) {
  test(`an unused ${kind} shows idle without a false danger meter`, async ({
    page,
  }) => {
    await page.locator(`.pal-row[data-kind="${kind}"]`).click();
    const component = page.locator(`.cv-node[data-kind="${kind}"]`);
    await expect(component).toContainText('idle');
    await expect(component).toHaveClass(/is-ok/);
    await expect(component.locator('.cv-meter-fill')).toHaveCount(0);
    const id = await component.getAttribute('data-id');
    await page.locator('.cv-port-hit[data-hit="port-out"][data-id="client"]').click();
    await page.locator(`.cv-port-hit[data-hit="port-in"][data-id="${id}"]`).click();
    await expect(component).not.toContainText('idle');
    await expect(component).toContainText('hit');
  });
}

test('manual connections survive Undo and Redo', async ({ page }) => {
  await page.locator('.cv-port-hit[data-hit="port-out"][data-id="client"]').click();
  await page.locator('.cv-port-hit[data-hit="port-in"][data-id="db"]').click();
  await expect.poll(() => savedEdges(page)).toBe(3);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect.poll(() => savedEdges(page)).toBe(2);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect.poll(() => savedEdges(page)).toBe(3);
});

test('a named design can be reopened and survives reload', async ({ page }) => {
  await menu(page, 'Your designs');
  await page
    .getByRole('textbox', { name: 'Design name', exact: true })
    .fill('Original design');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('.dz-open')).toHaveCount(1);
  await page.getByRole('button', { name: 'Close your designs' }).click();
  await page.locator('.pal-row[data-kind="cache"]').click();
  await expect(nodeCount(page)).toHaveCount(4);
  await menu(page, 'Your designs');
  await page.locator('.dz-open').click();
  await expect(nodeCount(page)).toHaveCount(3);
  await page.reload();
  await expect(nodeCount(page)).toHaveCount(3);
});

for (const width of [320, 390]) {
  test(`Share remains keyboard usable and fits at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 844 });
    await page.getByRole('button', { name: 'Share', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Share this design' });
    await expect(
      dialog.getByRole('button', { name: 'Close', exact: true }),
    ).toBeFocused();
    const box = await dialog.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(width);
    await page.keyboard.press('Shift+Tab');
    await expect(dialog.getByRole('button', { name: 'Save to a file' })).toBeFocused();
    await page.screenshot({ path: testInfo.outputPath(`share-${width}.png`) });
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
  });
}
