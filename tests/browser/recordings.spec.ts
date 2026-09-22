import { expect, test, type Locator, type Page, type Route } from '@playwright/test';
import {
  actionsFor,
  CALL_LIMIT,
  MODEL,
  type Decision,
  type DecisionRequest,
} from '../../src/operator/contracts';
import { PRESETS } from '../../src/sim/presets';

const errors = new WeakMap<Page, string[]>();
const networkCalls = new WeakMap<Page, string[]>();

test.beforeEach(async ({ page }) => {
  errors.set(page, []);
  networkCalls.set(page, []);
  page.on('pageerror', (error) => errors.get(page)?.push(error.message));
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith('/api/') || url.hostname.includes('typesafe')) {
      networkCalls.get(page)?.push(`${route.request().method()} ${url.href}`);
      await route.abort();
    } else await route.fallback();
  });
  await page.route('https://api.github.com/**', (route) =>
    route.fulfill({ json: { stargazers_count: 0 } }),
  );
});

test.afterEach(async ({ page }) => {
  expect(errors.get(page)).toEqual([]);
  expect(networkCalls.get(page)).toEqual([]);
});

const dock = (page: Page) => page.locator('.operator-dock');
const node = (page: Page, id = 'db') => page.locator(`.cv-node[data-id="${id}"]`);
const status = (page: Page) => page.getByTestId('operator-status');
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
  await expect(page.getByTestId('operator-source')).toHaveValue('recorded');
  await expect(dock(page)).toHaveAttribute('data-source', 'recorded');
  await expect(dock(page)).toHaveAttribute('data-armed', 'true');
}

async function crash(page: Page) {
  await page.getByTestId('operator-break').click();
  await expect(node(page)).toHaveClass(/is-faulted/);
}

async function openHistory(page: Page) {
  if (
    !(await page
      .getByTestId('operator-activity')
      .evaluate((element) => element.hasAttribute('open')))
  )
    await page.getByTestId('operator-activity-toggle').click();
}

async function loadRecording(page: Page, id: string) {
  const gallery = page.getByTestId('operator-recordings');
  if (!(await gallery.evaluate((element) => element.hasAttribute('open'))))
    await gallery.locator('summary').click();
  await page.getByTestId(`recording-scenario-${id}`).click();
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

async function expectGraphUnobscured(page: Page) {
  await expect
    .poll(() =>
      page.locator('.cv-node').evaluateAll((nodes) =>
        nodes.flatMap((node) => {
          const body = node.querySelector('.cv-node-body');
          if (!body) return ['Missing node body'];
          const box = body.getBoundingClientRect();
          return [
            [box.left + 2, box.top + 2],
            [box.right - 2, box.top + 2],
            [box.left + 2, box.bottom - 2],
            [box.right - 2, box.bottom - 2],
          ].some(
            ([x, y]) => document.elementFromPoint(x!, y!)?.closest('.cv-node') !== node,
          )
            ? [node.getAttribute('data-id')]
            : [];
        }),
      ),
    )
    .toEqual([]);
}

test('the default no-key mode repairs a crash with a recorded choice and fresh measurements', async ({
  page,
}, info) => {
  await open(page);
  await expect(activity(page)).toHaveCount(0);
  await crash(page);
  await expect(activity(page, 'diagnosing')).toHaveCount(1);
  await expect(activity(page)).toHaveAttribute('data-source', 'recorded');
  await expect(activity(page)).toHaveAttribute('data-applied', 'false');
  await expect(node(page)).not.toHaveClass(/is-faulted/);
  await expect(activity(page)).toHaveAttribute('data-status', 'measuring');
  await expect(activity(page)).toHaveAttribute('data-applied', 'true');
  await expect(activity(page)).toContainText('Recorded JEV');
  await expect(activity(page)).not.toContainText('JEV is choosing');
  await expect(activity(page, 'healthy')).toHaveCount(1, { timeout: 10_000 });
  await expect.poll(() => metric(page, 'Errors')).toBeLessThan(1);
  await expect.poll(() => metric(page, 'Goodput')).toBeGreaterThan(35);
  await openHistory(page);
  await activity(page).locator('summary').click();
  await expect(activity(page).locator('.activity-stages')).toContainText(
    'Recorded choice',
  );
  await expect(activity(page).locator('.activity-stages')).toContainText('Measured');
  const interval = await activity(page)
    .locator('.activity-sample-interval')
    .innerText();
  const seconds = interval.match(/\(([\d.]+)s\)/);
  expect(seconds, interval).not.toBeNull();
  expect(Number(seconds![1])).toBeGreaterThanOrEqual(2.4);
  await page.screenshot({ path: info.outputPath('recorded-crash-measured.png') });
});

test('repeated damage cancels a staged recording before matching the new fault', async ({
  page,
}) => {
  await open(page);
  await crash(page);
  await expect(activity(page, 'diagnosing')).toHaveCount(1);
  await page.getByTestId('operator-slow').click();
  const cancelled = activity(page, 'cancelled');
  await expect(cancelled).toHaveCount(1);
  await expect(cancelled).toHaveAttribute('data-applied', 'false');
  await expect(node(page)).toHaveClass(/is-faulted/);
  await expect(activity(page, 'healthy')).toHaveCount(1, { timeout: 10_000 });
  await expect(activity(page, 'healthy')).toContainText('slow');
  await expect(node(page)).not.toHaveClass(/is-faulted/);
  await expect(cancelled).toHaveAttribute('data-applied', 'false');
  await crash(page);
  await expect(activity(page, 'healthy')).toHaveCount(2, { timeout: 10_000 });
  await expect(dock(page)).toHaveAttribute('data-armed', 'true');
});

for (const interruption of ['stop', 'pause'] as const) {
  test(`${interruption} cancels a staged recording and resuming repairs the current system`, async ({
    page,
  }) => {
    await open(page);
    await crash(page);
    await expect(activity(page, 'diagnosing')).toHaveCount(1);
    if (interruption === 'stop') await page.getByTestId('operator-stop').click();
    else await page.getByRole('button', { name: 'Pause', exact: true }).click();
    await expect(activity(page, 'cancelled')).toHaveCount(1);
    await expect(activity(page, 'cancelled')).toHaveAttribute('data-applied', 'false');
    // Outlast the local staging delay; no cancelled recording may apply later.
    await page.waitForTimeout(1200);
    await expect(node(page)).toHaveClass(/is-faulted/);
    await expect(activity(page)).toHaveCount(1);
    if (interruption === 'stop') await page.getByTestId('operator-toggle').click();
    else await page.getByRole('button', { name: 'Play', exact: true }).click();
    await expect(node(page)).not.toHaveClass(/is-faulted/);
    await expect(activity(page, 'healthy')).toHaveCount(1, { timeout: 10_000 });
    await expect(activity(page, 'cancelled')).toHaveAttribute('data-applied', 'false');
  });
}

test('an ordinary Inspector edit uses a matching recording and remains undoable', async ({
  page,
}) => {
  await open(page);
  await node(page, 'api').click();
  const serviceTime = page.getByRole('slider', { name: 'Service time', exact: true });
  await serviceTime.press('End');
  await expect(serviceTime).toHaveValue('500');
  await expect(activity(page, 'measuring')).toHaveCount(1, { timeout: 10_000 });
  await expect(serviceTime).not.toHaveValue('500');
  await expect(activity(page, 'healthy')).toHaveCount(1, { timeout: 10_000 });
  await page.getByTestId('operator-stop').click();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(serviceTime).toHaveValue('500');
  await expect(dock(page)).toHaveAttribute('data-armed', 'false');
});

test('an unmatched edited system stays broken and explains the recording limit', async ({
  page,
}) => {
  const topology = structuredClone(PRESETS[0]!.topology);
  topology.nodes.find((item) => item.id === 'db')!.config.readFraction = 0.2;
  await page.addInitScript((savedTopology) => {
    localStorage.setItem(
      'breakscale.session.v1',
      JSON.stringify({ topology: savedTopology, rps: 50, presetId: null }),
    );
  }, topology);
  await open(page);
  await crash(page);
  await expect(status(page)).toHaveAttribute('data-state', 'needs-help');
  await expect(status(page)).toContainText('No recorded repair matches');
  await page.waitForTimeout(1500);
  await expect(node(page)).toHaveClass(/is-faulted/);
  await expect(
    page.locator('[data-testid="operator-activity-entry"][data-applied="true"]'),
  ).toHaveCount(0);
  await expect(activity(page, 'healthy')).toHaveCount(0);
  await expect(page.getByTestId('operator-source')).toHaveValue('recorded');
  await loadRecording(page, 'database-crash');
  await expect(activity(page, 'healthy')).toHaveCount(1, { timeout: 10_000 });
  await expect(node(page)).not.toHaveClass(/is-faulted/);
});

test('a recorded load incident changes real capacity while preserving offered traffic', async ({
  page,
}, info) => {
  await open(page);
  await loadRecording(page, 'traffic-200');
  await expect(activity(page, 'healthy')).toHaveCount(1, { timeout: 15_000 });
  await expect
    .poll(() =>
      page.evaluate(() => {
        const saved = JSON.parse(localStorage.getItem('breakscale.session.v1') ?? '{}');
        return {
          rps: saved.rps,
          capacity: saved.topology?.nodes.find(
            (item: { id: string }) => item.id === 'db',
          )?.config.capacity,
        };
      }),
    )
    .toEqual({ rps: 200, capacity: 12 });
  await expect.poll(() => metric(page, 'Goodput')).toBeGreaterThan(170);
  await expect.poll(() => metric(page, 'Errors')).toBeLessThan(1);
  await expect(activity(page)).toHaveAttribute('data-source', 'recorded');
  await page.screenshot({ path: info.outputPath('recorded-load-recovered.png') });
});

test('loading a recording resumes stopped, paused play and Undo restores the prior canvas', async ({
  page,
}) => {
  await open(page);
  await page.getByTestId('operator-stop').click();
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await node(page, 'api').click();
  const name = page.getByRole('textbox', { name: 'Node name', exact: true });
  await name.fill('My existing service');
  await name.press('Enter');
  const savedTopology = () =>
    page.evaluate(
      () => JSON.parse(localStorage.getItem('breakscale.session.v1') ?? '{}').topology,
    );
  await expect
    .poll(
      async () =>
        (await savedTopology())?.nodes.find((item: { id: string }) => item.id === 'api')
          ?.label,
    )
    .toBe('My existing service');
  const before = await savedTopology();
  await loadRecording(page, 'database-crash');
  await expect(node(page)).toHaveClass(/is-faulted/);
  await expect(dock(page)).toHaveAttribute('data-armed', 'true');
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
  await expect(node(page, 'api')).not.toHaveAttribute(
    'aria-label',
    /My existing service/,
  );
  await page.getByTestId('operator-stop').click();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect.poll(savedTopology).toEqual(before);
  await expect(node(page, 'api')).toHaveAttribute('aria-label', /My existing service/);
  await expect(node(page)).not.toHaveClass(/is-faulted/);
  await expect(dock(page)).toHaveAttribute('data-armed', 'false');
});

test('the wreck recording applies all three saved choices and measures each change', async ({
  page,
}, info) => {
  await open(page);
  await loadRecording(page, 'wreck-it');
  await expect(page.locator('.cv-node.is-faulted')).toHaveCount(2);
  await expect(activity(page, 'healthy')).toHaveCount(1, { timeout: 20_000 });
  await expect(activity(page)).toHaveCount(3);
  const rows = await activity(page).evaluateAll((entries) =>
    entries.map((entry) => ({
      source: entry.getAttribute('data-source'),
      applied: entry.getAttribute('data-applied'),
      label: entry.querySelector('.activity-action')?.textContent ?? '',
      stages: entry.querySelector('.activity-stages')?.textContent ?? '',
      interval: entry.querySelector('.activity-sample-interval')?.textContent ?? '',
    })),
  );
  expect(rows.map((row) => row.source)).toEqual(['recorded', 'recorded', 'recorded']);
  expect(rows.map((row) => row.applied)).toEqual(['true', 'true', 'true']);
  expect(rows[0]!.label).toMatch(/capacity.*12/i);
  expect(rows[1]!.label).toMatch(/repair.*database/i);
  expect(rows[2]!.label).toMatch(/repair.*api/i);
  for (const row of rows) {
    expect(row.stages).toContain('Recorded choice');
    expect(row.stages).toContain('Measured');
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
  await page.screenshot({ path: info.outputPath('recorded-wreck-three-repairs.png') });
});

test('switching live to recorded to live cancels stale answers and retains the live call budget', async ({
  page,
}) => {
  await page.route('**/api/health', (route) =>
    route.fulfill({ json: { configured: true, model: MODEL, callLimit: CALL_LIMIT } }),
  );
  const requests: DecisionRequest[] = [];
  let held: Route | undefined;
  const response = (request: DecisionRequest, call: number): Decision => {
    const choices = actionsFor(request.observation, request.mode);
    const choice = choices.find((action) => action.kind === 'repair')!;
    return {
      choice: choice.id,
      confidence: 0.99,
      probabilities: Object.fromEntries(
        choices.map((action) => [
          action.id,
          action.id === choice.id ? 0.99 : 0.01 / (choices.length - 1),
        ]),
      ),
      model: MODEL,
      usage: { input_tokens: 100, output_tokens: 20 },
      durationMs: 40,
      callsRemaining: CALL_LIMIT - call,
    };
  };
  await page.route('**/api/decide', async (route) => {
    const request = route.request().postDataJSON() as DecisionRequest;
    requests.push(request);
    if (requests.length === 1) held = route;
    else await route.fulfill({ json: response(request, requests.length) });
  });
  await open(page);
  const source = page.getByTestId('operator-source');
  await source.selectOption('live');
  await crash(page);
  await expect.poll(() => requests.length).toBe(1);
  await source.selectOption('recorded');
  const cancelled = activity(page, 'cancelled');
  await expect(cancelled).toHaveCount(1);
  await expect(cancelled).toHaveAttribute('data-source', 'live');
  await expect(cancelled).toHaveAttribute('data-applied', 'false');
  await expect(activity(page, 'healthy')).toHaveCount(1, { timeout: 10_000 });
  await expect(activity(page, 'healthy')).toHaveAttribute('data-source', 'recorded');
  expect(requests).toHaveLength(1);
  await source.selectOption('live');
  await expect(page.getByTestId('operator-budget')).toContainText('1/18');
  // Return the old answer after re-entering live mode. Its epoch remains stale.
  await held!.fulfill({ json: response(requests[0]!, 1) }).catch(() => {});
  await expect(cancelled).toHaveAttribute('data-applied', 'false');
  await crash(page);
  await expect.poll(() => requests.length).toBe(2);
  await expect(activity(page, 'healthy')).toHaveCount(2, { timeout: 10_000 });
  await expect(page.getByTestId('operator-budget')).toContainText('2/18');
  await expect(cancelled).toHaveAttribute('data-applied', 'false');
  expect(requests[1]!.sessionId).toBe(requests[0]!.sessionId);
});

test('recorded choices wait for actual simulation time before claiming recovery', async ({
  page,
}) => {
  await open(page);
  await crash(page);
  await expect(activity(page, 'diagnosing')).toHaveCount(1);
  await page.evaluate(() => {
    const request = window.requestAnimationFrame;
    const cancel = window.cancelAnimationFrame;
    window.requestAnimationFrame = (callback) =>
      window.setTimeout(() => callback(performance.now()), 1000);
    window.cancelAnimationFrame = (id) => window.clearTimeout(id);
    window.addEventListener(
      'test:restore-frames',
      () => {
        window.requestAnimationFrame = request;
        window.cancelAnimationFrame = cancel;
      },
      { once: true },
    );
  });
  await expect(node(page)).not.toHaveClass(/is-faulted/);
  await expect(activity(page, 'measuring')).toHaveCount(1);
  const startedAt = Number.parseFloat(
    await page.locator('.cv-ledger-time').innerText(),
  );
  await page.waitForTimeout(3100);
  const measuredAt = Number.parseFloat(
    await page.locator('.cv-ledger-time').innerText(),
  );
  expect(measuredAt - startedAt).toBeLessThan(1);
  await expect(activity(page, 'measuring')).toHaveCount(1);
  await expect(activity(page, 'healthy')).toHaveCount(0);
  await page.evaluate(() => window.dispatchEvent(new Event('test:restore-frames')));
  await expect(activity(page, 'healthy')).toHaveCount(1, { timeout: 10_000 });
});

test('recorded controls and expanded evidence remain reachable at 320px', async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 320, height: 740 });
  await open(page);
  await expectReachable(page.getByTestId('operator-source'));
  await expectReachable(page.getByTestId('operator-break'));
  await crash(page);
  await expect(activity(page, 'healthy')).toHaveCount(1, { timeout: 10_000 });
  await openHistory(page);
  const summary = activity(page).locator('summary');
  await summary.focus();
  await summary.press('Enter');
  await expect(activity(page).locator('details')).toHaveAttribute('open', '');
  await expect(activity(page)).toContainText('Recorded JEV');
  for (const control of [
    page.getByTestId('operator-stop'),
    page.getByTestId('operator-source'),
    page.getByTestId('operator-activity-toggle'),
    page.getByRole('button', { name: 'Pause', exact: true }),
  ])
    await expectReachable(control);
  await expectGraphUnobscured(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
  await page.screenshot({ path: info.outputPath('recorded-phone-evidence.png') });
});

for (const disclosure of ['Recorded runs', 'Activity'] as const) {
  test(`an intentional zoom survives opening ${disclosure} before its queued fit`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 740 });
    await page.clock.install({ time: new Date('2026-09-21T11:59:00Z') });
    await open(page);
    await page.clock.pauseAt(new Date('2026-09-21T12:00:00Z'));
    await page.clock.runFor(1000);
    const activate = async (control: Locator) => {
      // Dispatch the ordinary pointer sequence while animation frames are paused.
      // Native hit testing is checked in the responsive test above.
      await control.dispatchEvent('pointerdown', { button: 0, pointerType: 'mouse' });
      await control.dispatchEvent('pointerup', { button: 0, pointerType: 'mouse' });
      await control.dispatchEvent('click');
    };
    const panel = page.getByTestId(
      disclosure === 'Recorded runs' ? 'operator-recordings' : 'operator-activity',
    );
    await activate(panel.locator('summary').first());
    await expect(panel).toHaveAttribute('open', '');
    await page.clock.runFor(32);
    const body = page.locator('.cv-node-body').first();
    const width = () =>
      body.evaluate((element) => element.getBoundingClientRect().width);
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
    await expectGraphUnobscured(page);
  });
}
