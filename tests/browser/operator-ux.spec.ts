import { expect, test, type Page, type Route } from '@playwright/test';
import { PRESETS } from '../../src/sim/presets';
import {
  actionsFor,
  CALL_LIMIT,
  MODEL,
  type Action,
  type Decision,
  type DecisionRequest,
} from '../../src/operator/contracts';

const errors = new WeakMap<Page, string[]>();
test.beforeEach(async ({ page }) => {
  errors.set(page, []);
  page.on('pageerror', (error) => errors.get(page)?.push(error.message));
  await page.route('**/api/health', (route) =>
    route.fulfill({ json: { model: MODEL, configured: true, callLimit: CALL_LIMIT } }),
  );
  await page.route('https://api.github.com/**', (route) =>
    route.fulfill({ json: { stargazers_count: 0 } }),
  );
  for (const endpoint of ['decide', 'design-step']) {
    await page.route(`**/api/${endpoint}`, async (route) => {
      errors.get(page)?.push(`Unexpected ${endpoint} call`);
      await route.abort();
    });
  }
});
test.afterEach(async ({ page }) => {
  expect(errors.get(page)).toEqual([]);
});

const dock = (page: Page) => page.locator('.operator-dock');
const node = (page: Page, id: string) => page.locator(`.cv-node[data-id="${id}"]`);
const status = (page: Page) => page.getByTestId('operator-status');
const activity = (page: Page, state?: string) =>
  page.locator(
    `[data-testid="operator-activity-entry"]${state ? `[data-status="${state}"]` : ''}`,
  );
async function openActivity(page: Page) {
  await openExplore(page);
  if (
    !(await page
      .getByTestId('operator-activity')
      .evaluate((el) => el.hasAttribute('open')))
  )
    await page.getByTestId('operator-activity-toggle').click();
}
async function openExplore(page: Page) {
  const toggle = page.getByTestId('operator-explore-toggle');
  if (
    (await toggle.isVisible()) &&
    (await toggle.getAttribute('aria-expanded')) !== 'true'
  )
    await toggle.click();
}
async function open(page: Page) {
  await page.goto('/');
  await expect(page.locator('.cv-node')).toHaveCount(3);
  await page.getByTestId('operator-source').selectOption('live');
  await expect(dock(page)).toHaveAttribute('data-armed', 'true');
  await expect(status(page)).toBeVisible();
}
async function crash(page: Page, id = 'db') {
  await node(page, id).click();
  await page.getByTestId('operator-break').click();
  await expect(node(page, id)).toHaveClass(/is-faulted/);
}
function response(request: DecisionRequest, action: Action, count: number): Decision {
  const choices = actionsFor(request.observation, request.mode);
  expect(choices.some((candidate) => candidate.id === action.id)).toBe(true);
  return {
    choice: action.id,
    confidence: 0.99,
    probabilities: Object.fromEntries(
      choices.map((candidate) => [
        candidate.id,
        candidate.id === action.id ? 0.99 : 0.01 / Math.max(1, choices.length - 1),
      ]),
    ),
    model: MODEL,
    usage: { input_tokens: 180, output_tokens: 30 },
    durationMs: 42,
    callsRemaining: CALL_LIMIT - count,
  };
}
function repair(request: DecisionRequest): Action {
  const choices = actionsFor(request.observation, request.mode);
  const fault = choices.find((action) => action.kind === 'repair');
  if (fault) return fault;
  const configuredErrors = choices.find((action) => action.kind === 'error-rate');
  if (configuredErrors) return configuredErrors;
  const pressure = [...request.observation.nodes].sort(
    (a, b) => b.queued - a.queued || b.utilization - a.utilization,
  );
  for (const target of pressure) {
    const scale = choices.find(
      (action) => action.kind === 'scale' && action.nodeId === target.id,
    );
    if (scale) return scale;
  }
  return choices.find((action) => action.kind === 'wait')!;
}
async function mockRepairs(page: Page) {
  const requests: DecisionRequest[] = [];
  await page.route('**/api/decide', async (route) => {
    const request = route.request().postDataJSON() as DecisionRequest;
    requests.push(request);
    await route.fulfill({ json: response(request, repair(request), requests.length) });
  });
  return requests;
}
async function heldRepair(page: Page) {
  const requests: DecisionRequest[] = [];
  let pending: Route | undefined;
  await page.route('**/api/decide', async (route) => {
    const request = route.request().postDataJSON() as DecisionRequest;
    requests.push(request);
    if (requests.length === 1) pending = route;
    else
      await route.fulfill({
        json: response(request, repair(request), requests.length),
      });
  });
  return {
    requests,
    async release() {
      if (!pending || !requests[0]) throw new Error('No pending automatic repair');
      await pending
        .fulfill({ json: response(requests[0], repair(requests[0]), 1) })
        .catch(() => {});
    },
  };
}
const metric = async (page: Page, label: string) =>
  Number.parseFloat(
    await page
      .locator('.traffic-metric')
      .filter({ hasText: label })
      .locator('.num')
      .innerText(),
  );
const saved = (page: Page) =>
  page.evaluate(() =>
    JSON.parse(localStorage.getItem('breakscale.session.v1') ?? '{}'),
  );

test('JEV starts armed, exposes chaos controls, and spends no calls on a healthy system', async ({
  page,
}) => {
  await open(page);
  for (const id of [
    'design-mode',
    'operator-mode',
    'operator-prompt',
    'operator-send',
    'operator-disclosure',
  ])
    await expect(page.getByTestId(id)).toHaveCount(0);
  for (const id of [
    'operator-break',
    'operator-slow',
    'operator-traffic',
    'operator-chaos',
    'operator-stop',
  ])
    await expect(page.getByTestId(id)).toBeVisible();
  await page.waitForTimeout(3500);
  await expect(dock(page)).toHaveAttribute('data-armed', 'true');
  await expect(page.getByTestId('operator-budget')).toContainText('0/18');
  await expect(page.locator('.cv-node.is-faulted')).toHaveCount(0);
  await expect(activity(page)).toHaveCount(0);
  await page.getByTestId('operator-activity-toggle').click();
  await expect(page.getByTestId('operator-activity')).not.toHaveAttribute('open', '');
  await page.getByTestId('operator-activity-toggle').click();
  await expect(page.getByTestId('operator-activity')).toHaveAttribute('open', '');
  await expect(activity(page)).toHaveCount(0);
});

test('a real crash automatically requests a repair and recovers throughput', async ({
  page,
}, info) => {
  const pending = await heldRepair(page);
  await open(page);
  await crash(page);
  await expect.poll(() => pending.requests.length).toBe(1);
  await expect(activity(page)).toHaveCount(1);
  await expect(activity(page)).toHaveAttribute('data-status', 'diagnosing');
  await expect(activity(page)).toHaveAttribute('data-applied', 'false');
  await expect.poll(() => metric(page, 'Errors')).toBeGreaterThan(50);
  await page.screenshot({ path: info.outputPath('fault-observed.png') });
  expect(pending.requests[0]!.mode).toBe('operator');
  expect(
    pending.requests[0]!.observation.nodes.find((item) => item.id === 'db')?.fault,
  ).toBe('crash');
  await pending.release();
  await expect(node(page, 'db')).not.toHaveClass(/is-faulted/);
  await expect(activity(page)).toHaveAttribute('data-status', 'measuring');
  await expect(activity(page)).toHaveAttribute('data-applied', 'true');
  await expect(activity(page)).toContainText(repair(pending.requests[0]!).label);
  await expect.poll(() => metric(page, 'Errors'), { timeout: 8000 }).toBeLessThan(1);
  await expect
    .poll(() => metric(page, 'Goodput'), { timeout: 8000 })
    .toBeGreaterThan(35);
  await expect(dock(page)).toHaveAttribute('data-armed', 'true');
  await expect(activity(page)).toHaveAttribute('data-status', 'healthy', {
    timeout: 8000,
  });
  await expect(activity(page)).toContainText('Measured');
  const errorSample = activity(page)
    .locator('.activity-metrics > div')
    .filter({ hasText: 'Errors' })
    .locator('dd');
  const errorValues = (await errorSample.textContent())!.match(/[\d.]+/g)!.map(Number);
  expect(errorValues).toHaveLength(2);
  expect(errorValues[0]).toBeGreaterThan(50);
  expect(errorValues[1]).toBeLessThan(1);
  await openActivity(page);
  await activity(page).locator('summary').click();
  await page.screenshot({ path: info.outputPath('fault-recovered.png') });
  await page.waitForTimeout(2500);
  expect(pending.requests).toHaveLength(1);
});

test('sustained 400 rps pressure scales the real engine without reducing demand', async ({
  page,
}, info) => {
  test.setTimeout(40_000);
  const pending = await heldRepair(page);
  await open(page);
  for (let i = 0; i < 3; i++) await page.getByTestId('operator-traffic').click();
  await expect.poll(async () => (await saved(page)).rps).toBe(400);
  await expect.poll(() => pending.requests.length, { timeout: 10_000 }).toBe(1);
  await expect
    .poll(() => metric(page, 'Errors'), { timeout: 8000 })
    .toBeGreaterThan(10);
  const beforeError = await metric(page, 'Errors');
  await page.screenshot({ path: info.outputPath('load-overloaded.png') });
  await pending.release();
  await expect
    .poll(
      async () => {
        const state = await saved(page);
        return state.topology?.nodes.filter(
          (item: { kind: string; config: { instances?: number } }) =>
            item.kind !== 'client' && (item.config.instances ?? 1) > 1,
        ).length;
      },
      { timeout: 15_000 },
    )
    .toBeGreaterThanOrEqual(2);
  await expect.poll(() => metric(page, 'Errors'), { timeout: 15_000 }).toBeLessThan(1);
  await expect(status(page)).toHaveAttribute('data-state', 'watching', {
    timeout: 10_000,
  });
  await expect
    .poll(() => metric(page, 'Goodput'), { timeout: 15_000 })
    .toBeGreaterThan(350);
  expect(await metric(page, 'Errors')).toBeLessThan(beforeError);
  expect((await saved(page)).rps).toBe(400);
  expect(pending.requests.length).toBeGreaterThanOrEqual(2);
  expect(pending.requests.length).toBeLessThanOrEqual(6);
  expect(pending.requests.every((request) => request.mode === 'operator')).toBe(true);
  await expect(activity(page)).toHaveCount(pending.requests.length);
  await expect(activity(page, 'healthy')).toHaveCount(1);
  await expect(activity(page, 'unresolved')).toHaveCount(pending.requests.length - 1);
  for (const request of pending.requests) {
    const row = activity(page).filter({ hasText: repair(request).label });
    await expect(row).toHaveCount(1);
    await expect(row).toHaveAttribute('data-applied', 'true');
    await expect(row).toContainText('Measured');
    await expect(row.locator('.activity-metrics')).toContainText('→');
  }
  await openActivity(page);
  await page.screenshot({ path: info.outputPath('load-recovered.png') });
  await page.getByTestId('operator-stop').click();
  const lastRequest = pending.requests.at(-1)!;
  const lastAction = repair(lastRequest);
  expect(lastAction.kind).toBe('scale');
  if (lastAction.kind !== 'scale') throw new Error('Expected a final scale repair');
  const priorInstances = lastRequest.observation.nodes.find(
    (item) => item.id === lastAction.nodeId,
  )!.instances;
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect
    .poll(
      async () =>
        (await saved(page)).topology.nodes.find(
          (item: { id: string }) => item.id === lastAction.nodeId,
        ).config.instances ?? 1,
    )
    .toBe(priorInstances);
  expect((await saved(page)).rps).toBe(400);
});

test('repeated manual damage discards a stale decision and repairs a fresh observation', async ({
  page,
}) => {
  const requests: DecisionRequest[] = [];
  const pending: Route[] = [];
  await page.route('**/api/decide', async (route) => {
    const request = route.request().postDataJSON() as DecisionRequest;
    requests.push(request);
    if (requests.length <= 2) pending.push(route);
    else
      await route.fulfill({
        json: response(request, repair(request), requests.length),
      });
  });
  await open(page);
  await crash(page, 'db');
  await expect.poll(() => requests.length).toBe(1);
  await crash(page, 'api');
  await expect.poll(() => requests.length).toBe(2);
  await expect(activity(page, 'cancelled')).toHaveCount(1);
  await expect(activity(page, 'cancelled')).toHaveAttribute('data-applied', 'false');
  expect(
    requests[1]!.observation.nodes
      .filter((item) => item.fault)
      .map((item) => item.id)
      .sort(),
  ).toEqual(['api', 'db']);
  await pending[0]!
    .fulfill({ json: response(requests[0]!, repair(requests[0]!), 1) })
    .catch(() => {});
  await page.waitForTimeout(250);
  await expect(node(page, 'db')).toHaveClass(/is-faulted/);
  await expect(node(page, 'api')).toHaveClass(/is-faulted/);
  await expect(activity(page, 'cancelled')).toHaveCount(1);
  await expect(activity(page, 'cancelled')).toHaveAttribute('data-applied', 'false');
  await pending[1]!.fulfill({ json: response(requests[1]!, repair(requests[1]!), 2) });
  await expect(page.locator('.cv-node.is-faulted')).toHaveCount(0);
  await expect(dock(page)).toHaveAttribute('data-armed', 'true');
  expect(requests.length).toBeGreaterThanOrEqual(3);
  expect(requests.length).toBeLessThanOrEqual(4);
  await expect(activity(page)).toHaveCount(requests.length);
  await expect(activity(page, 'cancelled')).toHaveCount(1);
});

test('Stop prevents repairs until Resume, then new damage is still watched', async ({
  page,
}) => {
  const requests = await mockRepairs(page);
  await open(page);
  await page.getByTestId('operator-stop').click();
  await expect(dock(page)).toHaveAttribute('data-armed', 'false');
  await crash(page);
  await page.waitForTimeout(1500);
  expect(requests).toHaveLength(0);
  await page.getByTestId('operator-toggle').click();
  await expect(node(page, 'db')).not.toHaveClass(/is-faulted/);
  await crash(page, 'api');
  await expect(node(page, 'api')).not.toHaveClass(/is-faulted/);
  expect(requests).toHaveLength(2);
  await expect(dock(page)).toHaveAttribute('data-armed', 'true');
});

test('Stop discards an in-flight repair and keeps the fault intact until Resume', async ({
  page,
}) => {
  const pending = await heldRepair(page);
  await open(page);
  await crash(page);
  await expect.poll(() => pending.requests.length).toBe(1);
  await page.getByTestId('operator-stop').click();
  await pending.release();
  await expect(node(page, 'db')).toHaveClass(/is-faulted/);
  await expect(activity(page)).toHaveAttribute('data-status', 'cancelled');
  await expect(activity(page)).toHaveAttribute('data-applied', 'false');
  await expect(dock(page)).toHaveAttribute('data-armed', 'false');
  await page.waitForTimeout(1000);
  expect(pending.requests).toHaveLength(1);
  await page.getByTestId('operator-toggle').click();
  await expect(node(page, 'db')).not.toHaveClass(/is-faulted/);
  expect(pending.requests).toHaveLength(2);
  await expect(activity(page)).toHaveCount(2);
  await expect(activity(page, 'cancelled')).toHaveAttribute('data-applied', 'false');
});

for (const interruption of ['paused', 'hidden'] as const) {
  test(`${interruption} suspends an in-flight repair and returning resumes automatically`, async ({
    page,
  }) => {
    const pending = await heldRepair(page);
    await open(page);
    await crash(page);
    await expect.poll(() => pending.requests.length).toBe(1);
    if (interruption === 'paused')
      await page.getByRole('button', { name: 'Pause', exact: true }).click();
    else
      await page.evaluate(() => {
        Object.defineProperty(document, 'hidden', {
          configurable: true,
          get: () => true,
        });
        document.dispatchEvent(new Event('visibilitychange'));
      });
    await pending.release();
    await page.waitForTimeout(1000);
    await expect(node(page, 'db')).toHaveClass(/is-faulted/);
    await expect(dock(page)).toHaveAttribute('data-armed', 'true');
    expect(pending.requests).toHaveLength(1);
    await expect(activity(page)).toHaveAttribute('data-status', 'cancelled');
    await expect(activity(page)).toHaveAttribute('data-applied', 'false');
    if (interruption === 'paused')
      await page.getByRole('button', { name: 'Play', exact: true }).click();
    else
      await page.evaluate(() => {
        Object.defineProperty(document, 'hidden', {
          configurable: true,
          get: () => false,
        });
        document.dispatchEvent(new Event('visibilitychange'));
      });
    await expect(node(page, 'db')).not.toHaveClass(/is-faulted/);
    expect(pending.requests).toHaveLength(2);
  });
}

test('reset invalidates a pending repair and keeps watching the healthy reset system', async ({
  page,
}) => {
  const pending = await heldRepair(page);
  await open(page);
  await crash(page);
  await expect.poll(() => pending.requests.length).toBe(1);
  await page.getByRole('button', { name: 'Reset simulation', exact: true }).click();
  await pending.release();
  await expect(page.locator('.cv-node.is-faulted')).toHaveCount(0);
  await expect(dock(page)).toHaveAttribute('data-armed', 'true');
  await page.waitForTimeout(2500);
  expect(pending.requests).toHaveLength(1);
});

test('offline manual damage stays visible, and reconnect starts automatic repair', async ({
  page,
}) => {
  let available = false;
  await page.route('**/api/health', (route) =>
    route.fulfill({
      json: { model: MODEL, configured: available, callLimit: CALL_LIMIT },
    }),
  );
  const requests = await mockRepairs(page);
  await open(page);
  await expect(status(page)).toContainText(/offline|connect/i);
  await crash(page);
  await page.waitForTimeout(700);
  expect(requests).toHaveLength(0);
  available = true;
  await page.getByTestId('operator-reconnect').click();
  await expect(node(page, 'db')).not.toHaveClass(/is-faulted/);
  await expect(dock(page)).toHaveAttribute('data-armed', 'true');
  expect(requests).toHaveLength(1);
});

test('challenge controls suspend automatic repairs and leaving restores them', async ({
  page,
}) => {
  const requests = await mockRepairs(page);
  await open(page);
  await page.getByRole('button', { name: 'Menu', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Challenges', exact: true }).click();
  await page.getByRole('button', { name: /^Hold the line/ }).click();
  await expect(status(page)).toContainText(/challenge/i);
  for (const id of [
    'operator-break',
    'operator-slow',
    'operator-traffic',
    'operator-chaos',
  ])
    await expect(page.getByTestId(id)).toBeDisabled();
  await page.waitForTimeout(800);
  expect(requests).toHaveLength(0);
  await page.getByRole('button', { name: /Leave the challenge|Done/ }).click();
  await expect(page.getByTestId('operator-break')).toBeEnabled();
  await expect(dock(page)).toHaveAttribute('data-armed', 'true');
});

for (const attempted of [false, true]) {
  test(`${attempted ? 'provider attempts stay charged' : 'rejected reservations are returned'} without a rapid retry loop`, async ({
    page,
  }) => {
    let calls = 0;
    await page.route('**/api/decide', (route) => {
      calls++;
      return route.fulfill({
        status: attempted ? 502 : 429,
        json: {
          error: attempted ? 'Provider failed.' : 'Another decision is finishing.',
          attempted,
          callsRemaining: attempted ? 17 : 18,
        },
      });
    });
    await open(page);
    await crash(page);
    await expect.poll(() => calls).toBe(1);
    await expect(page.getByTestId('operator-budget')).toContainText(
      attempted ? '1/18' : '0/18',
    );
    await expect(node(page, 'db')).toHaveClass(/is-faulted/);
    await expect(activity(page)).toHaveAttribute(
      'data-status',
      attempted ? 'failed' : 'deferred',
    );
    await expect(activity(page)).toHaveAttribute('data-applied', 'false');
    await expect(status(page)).toContainText(
      /failed|finishing|retry|trying|unavailable/i,
    );
    await page.waitForTimeout(1000);
    expect(calls).toBe(1);
    await page.getByTestId('operator-stop').click();
  });
}

test('Wreck it damages both real services and raises load before JEV repairs them', async ({
  page,
}, info) => {
  const pending = await heldRepair(page);
  await open(page);
  await page.getByTestId('operator-chaos').click();
  await expect(page.locator('.cv-node.is-faulted')).toHaveCount(2);
  await expect.poll(async () => (await saved(page)).rps).toBe(200);
  await expect.poll(() => pending.requests.length).toBe(1);
  expect(
    pending.requests[0]!.observation.nodes.filter((item) => item.fault),
  ).toHaveLength(2);
  await page.screenshot({ path: info.outputPath('wrecked-system.png') });
  await pending.release();
  await expect(page.locator('.cv-node.is-faulted')).toHaveCount(0);
  await expect.poll(() => metric(page, 'Errors'), { timeout: 8000 }).toBeLessThan(3);
  await expect
    .poll(() => metric(page, 'Goodput'), { timeout: 8000 })
    .toBeGreaterThan(165);
  expect((await saved(page)).rps).toBe(200);
  expect(pending.requests.length).toBeGreaterThanOrEqual(2);
  expect(pending.requests.length).toBeLessThanOrEqual(5);
});

test('Slow service creates a real latency fault that is repaired automatically', async ({
  page,
}) => {
  const pending = await heldRepair(page);
  await open(page);
  await node(page, 'db').click();
  await page.getByTestId('operator-slow').click();
  await expect(node(page, 'db')).toHaveAttribute('aria-label', /faulted: slow/);
  await expect.poll(() => pending.requests.length).toBe(1);
  expect(
    pending.requests[0]!.observation.nodes.find((item) => item.id === 'db')?.fault,
  ).toBe('slow');
  await pending.release();
  await expect(node(page, 'db')).not.toHaveClass(/is-faulted/);
  await expect(dock(page)).toHaveAttribute('data-armed', 'true');
});

test('opening About keeps an in-flight automatic repair armed', async ({ page }) => {
  const pending = await heldRepair(page);
  await open(page);
  await crash(page);
  await expect.poll(() => pending.requests.length).toBe(1);
  await page.getByRole('button', { name: 'About', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await pending.release();
  await expect(node(page, 'db')).not.toHaveClass(/is-faulted/);
  await expect(dock(page)).toHaveAttribute('data-armed', 'true');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'About', exact: true })).toBeFocused();
  expect(pending.requests).toHaveLength(1);
});

test('a server cooldown resumes automatic recovery without pressing Resume or refilling a session', async ({
  page,
}) => {
  const requests: DecisionRequest[] = [];
  await page.route('**/api/decide', async (route) => {
    const request = route.request().postDataJSON() as DecisionRequest;
    requests.push(request);
    if (requests.length === 1) {
      await route.fulfill({
        status: 429,
        json: {
          error: 'The rolling minute is full.',
          attempted: false,
          callsRemaining: 0,
          retryAfterMs: 1000,
        },
      });
    } else await route.fulfill({ json: response(request, repair(request), 1) });
  });
  await open(page);
  await crash(page);
  await expect(status(page)).toHaveAttribute('data-state', 'cooldown');
  await expect(activity(page)).toHaveAttribute('data-status', 'deferred');
  await expect(activity(page)).toHaveAttribute('data-applied', 'false');
  await expect(dock(page)).toHaveAttribute('data-armed', 'true');
  await expect(node(page, 'db')).toHaveClass(/is-faulted/);
  await expect(node(page, 'db')).not.toHaveClass(/is-faulted/);
  expect(requests).toHaveLength(2);
  expect(requests[0]!.sessionId).toBe(requests[1]!.sessionId);
  await expect(activity(page)).toHaveCount(2);
  await expect(activity(page, 'deferred')).toHaveAttribute('data-applied', 'false');
  await expect(page.getByTestId('operator-budget')).toContainText('1/18');
});

test('a manually configured error rate is repaired without confusing it with an injected fault', async ({
  page,
}, info) => {
  const pending = await heldRepair(page);
  await open(page);
  await node(page, 'db').click();
  const errorRate = page.getByRole('slider', { name: 'Error rate', exact: true });
  await errorRate.press('End');
  await expect(errorRate).toHaveValue('1');
  await expect
    .poll(
      async () =>
        (await saved(page)).topology?.nodes.find(
          (item: { id: string }) => item.id === 'db',
        )?.config.errorRate,
    )
    .toBe(1);
  await expect.poll(() => pending.requests.length).toBe(1);
  expect(
    pending.requests[0]!.observation.nodes.find((item) => item.id === 'db')?.fault,
  ).toBeNull();
  await expect.poll(() => metric(page, 'Errors')).toBeGreaterThan(50);
  await page.screenshot({ path: info.outputPath('configured-errors.png') });
  await pending.release();
  await expect(errorRate).toHaveValue('0');
  await expect.poll(() => metric(page, 'Errors'), { timeout: 8000 }).toBeLessThan(1);
  await expect
    .poll(() => metric(page, 'Goodput'), { timeout: 8000 })
    .toBeGreaterThan(35);
  await expect(dock(page)).toHaveAttribute('data-armed', 'true');
  await page.screenshot({ path: info.outputPath('configured-errors-recovered.png') });
  await page.getByTestId('operator-stop').click();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(errorRate).toHaveValue('1');
});

for (const hideAndReturn of [false, true]) {
  test(`recovery evidence waits for simulated traffic with throttled frames${hideAndReturn ? ' even after hiding and returning' : ''}`, async ({
    page,
  }, info) => {
    const pending = await heldRepair(page);
    await open(page);
    await crash(page);
    await expect.poll(() => pending.requests.length).toBe(1);
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
    await pending.release();
    await expect(node(page, 'db')).not.toHaveClass(/is-faulted/);
    const startedAt = Number.parseFloat(
      await page.locator('.cv-ledger-time').innerText(),
    );
    if (hideAndReturn) {
      await page.evaluate(() => {
        Object.defineProperty(document, 'hidden', {
          configurable: true,
          get: () => true,
        });
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await expect(status(page)).toHaveAttribute('data-state', 'paused');
      await page.evaluate(() => {
        Object.defineProperty(document, 'hidden', {
          configurable: true,
          get: () => false,
        });
        document.dispatchEvent(new Event('visibilitychange'));
      });
    }
    await page.waitForTimeout(3100);
    const measuredAt = Number.parseFloat(
      await page.locator('.cv-ledger-time').innerText(),
    );
    expect(measuredAt - startedAt).toBeLessThan(1);
    await expect(status(page)).toContainText('Measuring recovery');
    await expect(activity(page)).toHaveAttribute('data-status', 'measuring');
    await expect(activity(page)).toHaveAttribute('data-applied', 'true');
    await expect(page.locator('.operator-receipt')).not.toContainText(
      /system healthy|errors .*→/,
    );
    expect(pending.requests).toHaveLength(1);
    await page.screenshot({ path: info.outputPath('recovery-still-measuring.png') });
    await page.evaluate(() => window.dispatchEvent(new Event('test:restore-frames')));
    await expect(status(page)).toHaveAttribute('data-state', 'watching', {
      timeout: 8000,
    });
    await expect(activity(page)).toHaveAttribute('data-status', 'healthy');
    await expect(page.locator('.operator-receipt')).toContainText(
      /system healthy|errors .*→/,
    );
    expect(pending.requests).toHaveLength(1);
  });
}

for (const field of ['capacity', 'service-time'] as const) {
  test(`editing ${field} in Inspector triggers recovery through the ordinary manual controls`, async ({
    page,
  }, info) => {
    const requests: DecisionRequest[] = [];
    let pending: Route | undefined;
    const actionFor = (request: DecisionRequest) =>
      actionsFor(request.observation, request.mode).find(
        (action) =>
          action.kind === field && 'nodeId' in action && action.nodeId === 'db',
      ) ?? repair(request);
    await page.route('**/api/decide', async (route) => {
      const request = route.request().postDataJSON() as DecisionRequest;
      requests.push(request);
      if (requests.length === 1) pending = route;
      else
        await route.fulfill({
          json: response(request, actionFor(request), requests.length),
        });
    });
    await open(page);
    await node(page, 'db').click();
    const input =
      field === 'capacity'
        ? page.getByRole('spinbutton', { name: 'Slots per instance', exact: true })
        : page.getByRole('slider', { name: 'Service time', exact: true });
    if (field === 'capacity') {
      await input.fill('1');
      await input.press('Enter');
    } else await input.press('End');
    await expect(input).toHaveValue(field === 'capacity' ? '1' : '500');
    await expect.poll(() => requests.length, { timeout: 8000 }).toBe(1);
    const observed = requests[0]!.observation.nodes.find((item) => item.id === 'db')!;
    expect(observed.fault).toBeNull();
    expect(field === 'capacity' ? observed.capacity : observed.serviceMs).toBe(
      field === 'capacity' ? 1 : 500,
    );
    const choice = actionFor(requests[0]!);
    expect(choice.kind).toBe(field);
    await expect
      .poll(() => metric(page, 'Errors'), { timeout: 8000 })
      .toBeGreaterThan(5);
    await page.screenshot({ path: info.outputPath(`manual-${field}-damaged.png`) });
    await pending!.fulfill({ json: response(requests[0]!, choice, 1) });
    await expect(input).toHaveValue(field === 'capacity' ? '6' : '30');
    await expect.poll(() => metric(page, 'Errors'), { timeout: 8000 }).toBeLessThan(1);
    await expect
      .poll(() => metric(page, 'Goodput'), { timeout: 8000 })
      .toBeGreaterThan(35);
    await expect(status(page)).toHaveAttribute('data-state', 'watching', {
      timeout: 8000,
    });
    expect((await saved(page)).rps).toBe(50);
    expect(requests.length).toBeLessThanOrEqual(2);
    await page.screenshot({ path: info.outputPath(`manual-${field}-recovered.png`) });
    await page.getByTestId('operator-stop').click();
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(input).toHaveValue(field === 'capacity' ? '1' : '500');
  });
}

test('the ordinary header load slider triggers automatic recovery without a chaos button', async ({
  page,
}, info) => {
  test.setTimeout(40_000);
  const pending = await heldRepair(page);
  await open(page);
  const slider = page.getByRole('slider', { name: 'Offered load', exact: true });
  await slider.press('Home');
  for (let step = 0; step < 7; step++) await slider.press('PageUp');
  await expect.poll(async () => (await saved(page)).rps).toBeGreaterThan(300);
  const demand = (await saved(page)).rps as number;
  expect(demand).toBeLessThan(500);
  await expect.poll(() => pending.requests.length, { timeout: 8000 }).toBe(1);
  expect(
    pending.requests[0]!.observation.nodes.filter(
      (item) => item.kind === 'client',
    ).reduce((sum, item) => sum + item.rps, 0),
  ).toBe(demand);
  await expect
    .poll(() => metric(page, 'Errors'), { timeout: 8000 })
    .toBeGreaterThan(10);
  await pending.release();
  await expect.poll(() => metric(page, 'Errors'), { timeout: 15_000 }).toBeLessThan(1);
  await expect
    .poll(() => metric(page, 'Goodput'), { timeout: 15_000 })
    .toBeGreaterThan(demand * 0.85);
  await expect(status(page)).toHaveAttribute('data-state', 'watching', {
    timeout: 10_000,
  });
  expect((await saved(page)).rps).toBe(demand);
  expect(pending.requests.length).toBeLessThanOrEqual(6);
  await page.screenshot({ path: info.outputPath('manual-header-load-recovered.png') });
});

test('a wait decision records no applied change and leaves the real fault intact', async ({
  page,
}) => {
  const requests: DecisionRequest[] = [];
  await page.route('**/api/decide', async (route) => {
    const request = route.request().postDataJSON() as DecisionRequest;
    requests.push(request);
    const wait = actionsFor(request.observation, request.mode).find(
      (action) => action.kind === 'wait',
    )!;
    await route.fulfill({ json: response(request, wait, requests.length) });
  });
  await open(page);
  await crash(page);
  await expect(activity(page)).toHaveAttribute('data-status', 'waiting');
  await expect(activity(page)).toHaveAttribute('data-applied', 'false');
  await expect(activity(page)).toContainText('Observe without changing the system');
  await expect(node(page, 'db')).toHaveClass(/is-faulted/);
  await expect.poll(() => metric(page, 'Errors')).toBeGreaterThan(50);
  await page.getByTestId('operator-stop').click();
  await page.waitForTimeout(1000);
  expect(requests).toHaveLength(1);
  await expect(activity(page)).toHaveAttribute('data-status', 'waiting');
  await expect(activity(page, 'healthy')).toHaveCount(0);
});

for (const resume of ['Retry JEV', 'new manual damage'] as const) {
  test(`three unproductive waits stop automatic calls until ${resume}`, async ({
    page,
  }, info) => {
    test.setTimeout(45_000);
    const requests: DecisionRequest[] = [];
    await page.route('**/api/decide', async (route) => {
      const request = route.request().postDataJSON() as DecisionRequest;
      requests.push(request);
      const action =
        requests.length <= 3
          ? actionsFor(request.observation, request.mode).find(
              (choice) => choice.kind === 'wait',
            )!
          : repair(request);
      await route.fulfill({ json: response(request, action, requests.length) });
    });
    await open(page);
    await crash(page);
    await expect(status(page)).toHaveAttribute('data-state', 'needs-help', {
      timeout: 18_000,
    });
    expect(requests).toHaveLength(3);
    expect(requests[1]!.recovery?.consecutiveWaits).toBe(1);
    expect(requests[2]!.recovery?.consecutiveWaits).toBe(2);
    expect(requests[2]!.recovery?.previousWait?.timeMs).toBeGreaterThan(
      requests[0]!.observation.system.timeMs,
    );
    await expect(activity(page, 'waiting')).toHaveCount(2);
    await expect(activity(page, 'blocked')).toHaveCount(1);
    await expect(activity(page, 'blocked')).toHaveAttribute('data-applied', 'false');
    await expect(dock(page)).toHaveAttribute('data-armed', 'true');
    await expect(page.getByTestId('operator-budget')).toContainText('3/18');
    await expect(node(page, 'db')).toHaveClass(/is-faulted/);
    await expect.poll(() => metric(page, 'Errors')).toBeGreaterThan(50);
    // Longer than the normal five-second wait retry: no fourth automatic call.
    await page.waitForTimeout(5500);
    expect(requests).toHaveLength(3);
    await page.screenshot({ path: info.outputPath('repeated-wait-blocked.png') });
    if (resume === 'Retry JEV')
      await page.getByRole('button', { name: 'Retry JEV', exact: true }).click();
    else await page.getByTestId('operator-slow').click();
    await expect(node(page, 'db')).not.toHaveClass(/is-faulted/);
    await expect(activity(page, 'healthy')).toHaveCount(1, { timeout: 8000 });
    await expect.poll(() => metric(page, 'Errors'), { timeout: 8000 }).toBeLessThan(1);
    expect(requests).toHaveLength(4);
    expect(requests[3]!.sessionId).toBe(requests[0]!.sessionId);
    expect(requests[3]!.recovery?.consecutiveWaits ?? 0).toBe(0);
    await expect(page.getByTestId('operator-budget')).toContainText('4/18');
    await expect(activity(page, 'blocked')).toHaveAttribute('data-applied', 'false');
    expect((await saved(page)).rps).toBe(50);
  });
}

test('an unsupported decision records a blocked outcome without applying a repair', async ({
  page,
}) => {
  const requests: DecisionRequest[] = [];
  await page.route('**/api/decide', async (route) => {
    const request = route.request().postDataJSON() as DecisionRequest;
    requests.push(request);
    const action = actionsFor(request.observation, request.mode).find(
      (choice) => choice.kind === 'unsupported',
    )!;
    await route.fulfill({ json: response(request, action, requests.length) });
  });
  await open(page);
  await crash(page);
  await expect(status(page)).toHaveAttribute('data-state', 'needs-help');
  await expect(activity(page)).toHaveAttribute('data-status', 'blocked');
  await expect(activity(page)).toHaveAttribute('data-applied', 'false');
  await expect(activity(page).locator('.activity-stages')).not.toContainText('Applied');
  await expect(activity(page).locator('.activity-metrics')).not.toContainText('→');
  await expect(node(page, 'db')).toHaveClass(/is-faulted/);
  await expect(
    page.getByRole('button', { name: 'Retry JEV', exact: true }),
  ).toBeVisible();
  await expect(dock(page)).toHaveAttribute('data-armed', 'true');
  await page.waitForTimeout(5500);
  expect(requests).toHaveLength(1);
  await expect(page.getByTestId('operator-budget')).toContainText('1/18');
  await page.getByTestId('operator-stop').click();
});

test('real write contention beyond the repair menu asks for help without model calls', async ({
  page,
}, info) => {
  const topology = structuredClone(PRESETS[0]!.topology);
  topology.nodes.find((item) => item.kind === 'client')!.config.rps = 1000;
  for (const item of topology.nodes)
    if (item.kind !== 'client')
      Object.assign(item.config, { instances: 128, capacity: 512 });
  topology.nodes.find((item) => item.kind === 'db')!.config.readFraction = 0.5;
  await page.addInitScript(
    (session) => {
      localStorage.setItem('breakscale.session.v1', JSON.stringify(session));
    },
    { topology, rps: 1000, presetId: null },
  );
  await open(page);
  await expect(status(page)).toHaveAttribute('data-state', 'needs-help', {
    timeout: 12_000,
  });
  await expect(status(page)).toContainText(/lock|write contention/i);
  await expect
    .poll(() => metric(page, 'Errors'), { timeout: 8000 })
    .toBeGreaterThan(10);
  await expect(activity(page)).toHaveCount(0);
  await expect(page.getByTestId('operator-budget')).toContainText('0/18');
  await expect(dock(page)).toHaveAttribute('data-armed', 'true');
  expect((await saved(page)).rps).toBe(1000);
  await page.screenshot({ path: info.outputPath('write-contention-needs-help.png') });
});

test('new damage preserves an applied repair and marks its unmeasured result interrupted', async ({
  page,
}, info) => {
  const requests: DecisionRequest[] = [];
  let second: Route | undefined;
  await page.route('**/api/decide', async (route) => {
    const request = route.request().postDataJSON() as DecisionRequest;
    requests.push(request);
    if (requests.length === 2) second = route;
    else
      await route.fulfill({
        json: response(request, repair(request), requests.length),
      });
  });
  await open(page);
  await crash(page);
  await expect(node(page, 'db')).not.toHaveClass(/is-faulted/);
  await expect(activity(page)).toHaveAttribute('data-status', 'measuring');
  await page.getByTestId('operator-slow').click();
  await expect.poll(() => requests.length).toBe(2);
  const interrupted = activity(page, 'interrupted');
  await expect(interrupted).toHaveCount(1);
  await expect(interrupted).toHaveAttribute('data-applied', 'true');
  await expect(interrupted).toContainText(repair(requests[0]!).label);
  await expect(interrupted.locator('.activity-stages')).not.toContainText('Measured');
  await expect(interrupted.locator('.activity-metrics')).not.toContainText('→');
  await expect(activity(page, 'diagnosing')).toHaveAttribute('data-applied', 'false');
  await expect(activity(page, 'healthy')).toHaveCount(0);
  await expect(node(page, 'db')).toHaveClass(/is-faulted/);
  await second!.fulfill({ json: response(requests[1]!, repair(requests[1]!), 2) });
  await expect(node(page, 'db')).not.toHaveClass(/is-faulted/);
  await expect(activity(page, 'healthy')).toHaveCount(1, { timeout: 8000 });
  await expect(interrupted).toHaveCount(1);
  await expect(interrupted).toHaveAttribute('data-applied', 'true');
  expect(requests).toHaveLength(2);
  await openActivity(page);
  await page.screenshot({ path: info.outputPath('interrupted-measurement.png') });
});

test('expanded history at 320px scrolls and keeps Stop and keyboard controls usable', async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 320, height: 740 });
  const requests: DecisionRequest[] = [];
  const pending: Route[] = [];
  await page.route('**/api/decide', (route) => {
    requests.push(route.request().postDataJSON() as DecisionRequest);
    pending.push(route);
  });
  await open(page);
  for (let step = 0; step < 4; step++) {
    await page.getByTestId(step % 2 === 0 ? 'operator-break' : 'operator-slow').click();
    await expect.poll(() => requests.length).toBe(step + 1);
  }
  await expect(activity(page, 'cancelled')).toHaveCount(3);
  await openExplore(page);
  const toggle = page.getByTestId('operator-activity-toggle');
  if (
    await page
      .getByTestId('operator-activity')
      .evaluate((element) => element.hasAttribute('open'))
  )
    await toggle.click();
  await toggle.focus();
  await toggle.press('Enter');
  await expect(page.getByTestId('operator-activity')).toHaveAttribute('open', '');
  await expect(activity(page)).toHaveCount(4);
  const history = page.getByRole('region', { name: 'JEV action history' });
  const scroll = dock(page);
  await expect
    .poll(() => scroll.evaluate((el) => el.scrollHeight > el.clientHeight))
    .toBe(true);
  await history.focus();
  await history.press('PageDown');
  await expect.poll(() => scroll.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  for (const control of [
    page.getByTestId('operator-stop'),
    toggle,
    page.getByRole('button', { name: 'Pause', exact: true }),
    page.getByRole('button', { name: 'Fit the diagram on screen', exact: true }),
  ]) {
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
            box.right <= innerWidth &&
            box.bottom <= innerHeight &&
            !!hit &&
            (hit === element || element.contains(hit))
          );
        }),
      )
      .toBe(true);
  }
  await page.getByTestId('operator-stop').click();
  await expect(activity(page, 'cancelled')).toHaveCount(4);
  await pending
    .at(-1)!
    .fulfill({ json: response(requests.at(-1)!, repair(requests.at(-1)!), 4) })
    .catch(() => {});
  await expect(node(page, 'db')).toHaveClass(/is-faulted/);
  await toggle.focus();
  await toggle.press('Space');
  await expect(page.getByTestId('operator-activity')).not.toHaveAttribute('open', '');
  await toggle.press('Enter');
  await expect(page.getByTestId('operator-activity')).toHaveAttribute('open', '');
  const evidence = activity(page).first().locator('details');
  await evidence.locator('summary').focus();
  await evidence.locator('summary').press('Enter');
  await expect(evidence).toHaveAttribute('open', '');
  await expect(page.getByTestId('operator-activity')).toHaveAttribute('open', '');
  expect(requests).toHaveLength(4);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
  await page.screenshot({ path: info.outputPath('phone-320-history.png') });
});
