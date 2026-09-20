import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest, type Server } from 'node:http';
import {
  actionsFor,
  CALL_LIMIT,
  CALL_WINDOW_MS,
  MODEL,
  type DecisionRequest,
} from '../src/operator/contracts.ts';
import { componentCatalog } from '../src/designer/catalog.ts';
import type { DesignRequest } from '../src/designer/contracts.ts';
import { defaultConfig } from '../src/sim/presets.ts';
import { createApp } from './app.ts';
import { parseDecision } from './jev.ts';
import { SESSION_IDLE_MS, SESSION_LIMIT, Sessions } from './sessions.ts';

const servers: Server[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        }),
    ),
  );
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});
function request(): DecisionRequest {
  return {
    sessionId: randomUUID(),
    prompt: 'Repair Orders database',
    mode: 'command',
    observation: {
      nodes: [
        {
          id: 'orders',
          label: 'Orders database',
          kind: 'db',
          instances: 1,
          retries: 0,
          rps: 0,
          capacity: 10,
          serviceMs: 5,
          utilization: 0,
          queued: 0,
          p99: 0,
          errorRate: 1,
          fault: 'crash',
        },
      ],
      edges: [],
      system: { timeMs: 1000, offeredRps: 20, goodputRps: 0, errorRate: 1, p99: 20 },
    },
  };
}
async function listen(options: Parameters<typeof createApp>[0] = {}) {
  const server = createApp(options);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing local port');
  return `http://127.0.0.1:${address.port}`;
}
function answer(ids: string[], choice = ids[0]) {
  return {
    model: MODEL,
    answers: {
      action: {
        type: 'choice',
        choice,
        confidence: 1,
        probabilities: Object.fromEntries(ids.map((id) => [id, id === choice ? 1 : 0])),
      },
    },
    usage: { input_tokens: 100, output_tokens: 10 },
  };
}
const goodFetch: typeof fetch = async (_url, init) => {
  const input = JSON.parse(String(init?.body));
  return Response.json(
    answer(Object.keys(input.questions.action.criteria), 'repair_0'),
  );
};
function post(
  base: string,
  payload: unknown = request(),
  signal?: AbortSignal,
  headers: Record<string, string> = {},
  path = '/api/decide',
) {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(payload),
    signal,
  });
}

function rawStatus(base: string, headers: Record<string, string>) {
  return new Promise<number>((resolve, reject) => {
    const req = httpRequest(
      `${base}/api/decide`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
      },
      (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      },
    );
    req.on('error', reject);
    req.end(JSON.stringify(request()));
  });
}

describe('local decision HTTP boundary', () => {
  it('reports configuration without exposing credentials and returns a real validated provider shape', async () => {
    let sent: Record<string, unknown> | undefined;
    const fetcher: typeof fetch = async (url, init) => {
      expect(url).toBe('https://api.typesafe.ai/v1/systemone');
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      sent = JSON.parse(String(init?.body));
      return goodFetch(url, init);
    };
    const base = await listen({ key: 'test-only-secret', fetcher });
    expect(await (await fetch(`${base}/api/health`)).json()).toEqual({
      configured: true,
      model: MODEL,
      callLimit: 18,
      callWindowMs: CALL_WINDOW_MS,
    });
    const payload = request();
    const response = await post(base, payload);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      model: MODEL,
      choice: 'repair_0',
      callsRemaining: 17,
      usage: { input_tokens: 100, output_tokens: 10 },
    });
    expect(sent?.model).toBe(MODEL);
    expect(JSON.stringify(sent)).not.toContain(payload.sessionId);
    expect(JSON.stringify(body)).not.toContain('test-only-secret');
  });

  it('rejects foreign origin, host, cross-site requests, invalid UUID/state, oversized body and wrong content type before inference', async () => {
    let calls = 0;
    const base = await listen({
      key: 'test',
      fetcher: async (...args) => {
        calls++;
        return goodFetch(...args);
      },
    });
    expect(
      (await post(base, request(), undefined, { Origin: 'https://foreign.example' }))
        .status,
    ).toBe(403);
    expect(await rawStatus(base, { Host: 'foreign.example' })).toBe(403);
    expect(await rawStatus(base, { 'Sec-Fetch-Site': 'cross-site' })).toBe(403);
    expect((await post(base, { ...request(), sessionId: 'a'.repeat(36) })).status).toBe(
      400,
    );
    const bad = request();
    bad.observation.nodes[0].instances = -1;
    expect((await post(base, bad)).status).toBe(400);
    expect((await post(base, { text: 'x'.repeat(64 * 1024) })).status).toBe(413);
    expect(
      (await post(base, request(), undefined, { 'Content-Type': 'text/plain' })).status,
    ).toBe(415);
    expect(calls).toBe(0);
    expect((await post(base)).status).toBe(200);
    expect(calls).toBe(1);
  });

  it('does not make a model request when the server has no configured key', async () => {
    let calls = 0;
    const base = await listen({
      fetcher: async (...args) => {
        calls++;
        return goodFetch(...args);
      },
    });
    expect(await (await fetch(`${base}/api/health`)).json()).toMatchObject({
      configured: false,
    });
    expect((await post(base)).status).toBe(503);
    expect(calls).toBe(0);
  });

  it('counts provider failures toward the 18-attempt budget without retrying', async () => {
    let calls = 0;
    const base = await listen({
      key: 'test',
      fetcher: async () => {
        calls++;
        return new Response('provider details must stay private', { status: 500 });
      },
    });
    const payload = request();
    for (let i = 0; i < CALL_LIMIT; i++) {
      const response = await post(base, payload);
      expect(response.status).toBe(502);
      expect(await response.text()).not.toContain('provider details');
    }
    expect((await post(base, payload)).status).toBe(429);
    expect(calls).toBe(CALL_LIMIT);
  });

  it('allows only one in-flight call and propagates client cancellation without refunding the attempt', async () => {
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    let aborted!: () => void;
    const cancelled = new Promise<void>((resolve) => {
      aborted = resolve;
    });
    let calls = 0;
    const fetcher: typeof fetch = async (url, init) => {
      if (++calls > 1) return goodFetch(url, init);
      started();
      return new Promise<Response>((_resolve, reject) =>
        init?.signal?.addEventListener(
          'abort',
          () => {
            aborted();
            reject(new DOMException('cancelled', 'AbortError'));
          },
          { once: true },
        ),
      );
    };
    const base = await listen({ key: 'test', fetcher });
    const controller = new AbortController();
    const payload = request();
    const pending = post(base, payload, controller.signal).catch(() => null);
    await entered;
    expect((await post(base)).status).toBe(429);
    controller.abort();
    await cancelled;
    await pending;
    const next = await post(base, payload);
    expect(next.status).toBe(200);
    expect((await next.json()).callsRemaining).toBe(16);
    expect(calls).toBe(2);
  });

  it('aborts a timed-out provider and releases the gate for a subsequent decision', async () => {
    let calls = 0;
    let wasAborted = false;
    const fetcher: typeof fetch = async (url, init) => {
      if (++calls > 1) return goodFetch(url, init);
      return new Promise<Response>((_resolve, reject) =>
        init?.signal?.addEventListener(
          'abort',
          () => {
            wasAborted = true;
            reject(new DOMException('timeout', 'AbortError'));
          },
          { once: true },
        ),
      );
    };
    const base = await listen({ key: 'test', fetcher, timeoutMs: 30 });
    const payload = request();
    expect((await post(base, payload)).status).toBe(504);
    expect(wasAborted).toBe(true);
    expect((await (await post(base, payload)).json()).callsRemaining).toBe(16);
  });

  it('rejects an invalid provider response rather than fabricating an action', async () => {
    const base = await listen({
      key: 'test',
      fetcher: async () =>
        Response.json({
          model: MODEL,
          answers: { action: { choice: 'repair_0', confidence: 1 } },
        }),
    });
    const response = await post(base);
    expect(response.status).toBe(502);
    expect(await response.json()).not.toHaveProperty('choice');
  });

  it('serves the app but refuses encoded traversal and symlinks outside dist', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tiny-server-test-'));
    dirs.push(dir);
    const dist = join(dir, 'dist');
    await mkdir(dist);
    await writeFile(join(dist, 'index.html'), '<h1>Local canvas</h1>');
    await writeFile(join(dir, 'private.txt'), 'must not be served');
    await symlink(join(dir, 'private.txt'), join(dist, 'outside.txt'));
    const base = await listen({ dist });
    expect(await (await fetch(base)).text()).toContain('Local canvas');
    expect((await fetch(`${base}/outside.txt`)).status).toBe(403);
    expect((await fetch(`${base}/%2e%2e%2fprivate.txt`)).status).toBe(403);
    expect((await fetch(`${base}/%zz`)).status).toBe(400);
  });
});

describe('provider validation', () => {
  const ids = actionsFor(request().observation, 'command').map((action) => action.id);
  it.each([
    [0.93, 0.04, 0.02],
    [0.95, 0.04, 0.02],
  ])(
    'accepts only the observed one-hundredth rounding drift and preserves raw probabilities',
    (first, second, third) => {
      const offered = ['none', 'ambiguous', 'cache'];
      const value = answer(offered);
      value.answers.action.probabilities = {
        none: first,
        ambiguous: second,
        cache: third,
      };
      value.answers.action.confidence = 0.92;
      const parsed = parseDecision(value, offered, 1, 17);
      expect(parsed.probabilities).toBe(value.answers.action.probabilities);
      expect(parsed.probabilities).toEqual({
        none: first,
        ambiguous: second,
        cache: third,
      });
      expect(parsed.confidence).toBe(0.92);
    },
  );
  it.each([
    [0.96, 0.04, 0.02], // 1.02 is beyond the measured tolerance.
    [0.933, 0.04, 0.02], // .993 is close, but is not hundredth-rounded.
    [0.94, 0.041, 0.02], // 1.001 also needs the original strict precision check.
  ])('rejects larger or non-hundredth distribution drift', (first, second, third) => {
    const offered = ['none', 'ambiguous', 'cache'];
    const value = answer(offered);
    value.answers.action.probabilities = {
      none: first,
      ambiguous: second,
      cache: third,
    };
    expect(() => parseDecision(value, offered, 1, 17)).toThrow('invalid decision');
  });
  it.each([
    [
      'model mismatch',
      (a: ReturnType<typeof answer>) => {
        a.model = 'jev-latest';
      },
    ],
    [
      'missing candidate',
      (a: ReturnType<typeof answer>) => {
        delete a.answers.action.probabilities[ids[1]];
      },
    ],
    [
      'extra candidate',
      (a: ReturnType<typeof answer>) => {
        a.answers.action.probabilities.invented = 0;
      },
    ],
    [
      'non-normalized distribution',
      (a: ReturnType<typeof answer>) => {
        a.answers.action.probabilities[ids[0]] = 0.4;
      },
    ],
    [
      'nonfinite probability',
      (a: ReturnType<typeof answer>) => {
        a.answers.action.probabilities[ids[0]] = NaN;
      },
    ],
    [
      'nonfinite confidence',
      (a: ReturnType<typeof answer>) => {
        a.answers.action.confidence = Infinity;
      },
    ],
    [
      'negative usage',
      (a: ReturnType<typeof answer>) => {
        a.usage.input_tokens = -1;
      },
    ],
    [
      'fractional usage',
      (a: ReturnType<typeof answer>) => {
        a.usage.output_tokens = 0.5;
      },
    ],
    [
      'choice below maximum',
      (a: ReturnType<typeof answer>) => {
        a.answers.action.choice = ids[1];
      },
    ],
  ] as const)('rejects %s', (_name, mutate) => {
    const value = answer(ids);
    mutate(value);
    expect(() => parseDecision(value, ids, 1, 17)).toThrow('invalid decision');
  });
});

describe('bounded session retention', () => {
  it('refuses a 65th live session and recovers only after idle expiry', () => {
    let now = 0;
    const sessions = new Sessions(() => now);
    for (let i = 0; i < SESSION_LIMIT; i++) sessions.begin(String(i)).release();
    expect(() => sessions.begin('new')).toThrow('session limit');
    now += SESSION_IDLE_MS + 1;
    const lease = sessions.begin('new');
    expect(lease.callsRemaining).toBe(17);
    lease.release();
  });
  it('never expires active inference while old attempts leave the rolling window', () => {
    let now = 0;
    const sessions = new Sessions(() => now);
    const first = sessions.begin('active');
    now += SESSION_IDLE_MS + 1;
    expect(() => sessions.begin('other')).toThrow('Another decision');
    first.release();
    const second = sessions.begin('active');
    expect(second.callsRemaining).toBe(17);
    second.release();
  });
  it('resumes the same session as its rolling minute clears without forgetting recent calls', () => {
    let now = 0;
    const sessions = new Sessions(() => now);
    for (let i = 0; i < CALL_LIMIT; i++) {
      sessions.begin('watcher').release();
      now += 100;
    }
    expect(sessions.remaining('watcher')).toBe(0);
    expect(() => sessions.begin('watcher')).toThrow('cooling down');
    expect(sessions.retryAfterMs('watcher')).toBe(CALL_WINDOW_MS - now);
    now = CALL_WINDOW_MS;
    expect(sessions.remaining('watcher')).toBe(1);
    const next = sessions.begin('watcher');
    expect(next.callsRemaining).toBe(0);
    next.release();
    expect(sessions.retryAfterMs('watcher')).toBe(100);
    now += CALL_WINDOW_MS;
    expect(sessions.remaining('watcher')).toBe(CALL_LIMIT);
  });
});

function designRequest(): DesignRequest {
  return {
    sessionId: randomUUID(),
    prompt: 'Add a queue',
    topology: { nodes: [], edges: [] },
    completed: [],
    selectedNodeId: null,
  };
}
const designFetch: typeof fetch = async (url, init) => {
  const input = JSON.parse(String(init?.body));
  if (input.questions.action) return goodFetch(url, init);
  return Response.json({
    model: MODEL,
    usage: { input_tokens: 100, output_tokens: 20 },
    answers: Object.fromEntries(
      Object.entries(
        input.questions as Record<string, { criteria: Record<string, string> }>,
      ).map(([name, question]) => {
        const choice = name === 'operation' ? 'finish' : 'none';
        return [
          name,
          {
            type: 'choice',
            choice,
            confidence: 1,
            probabilities: Object.fromEntries(
              Object.keys(question.criteria).map((id) => [id, id === choice ? 1 : 0]),
            ),
          },
        ];
      }),
    ),
  });
};
const postDesign = (
  base: string,
  payload: unknown = designRequest(),
  signal?: AbortSignal,
  headers: Record<string, string> = {},
) => post(base, payload, signal, headers, '/api/design-step');

describe('architecture design HTTP boundary', () => {
  it('accepts an empty graph and shares the 18-attempt budget with operation requests', async () => {
    let calls = 0;
    const base = await listen({
      key: 'test',
      fetcher: async (...args) => {
        calls++;
        return designFetch(...args);
      },
    });
    const input = designRequest();
    const operation = { ...request(), sessionId: input.sessionId };
    expect((await (await postDesign(base, input)).json()).callsRemaining).toBe(17);
    expect((await (await post(base, operation)).json()).callsRemaining).toBe(16);
    for (let i = 2; i < CALL_LIMIT; i++)
      expect((await postDesign(base, input)).status).toBe(200);
    expect((await post(base, operation)).status).toBe(429);
    expect((await postDesign(base, input)).status).toBe(429);
    expect(calls).toBe(18);
  });
  it('accepts a valid maximum-size diagram beyond 64 KB while enforcing the 256 KB design bound', async () => {
    let calls = 0;
    const base = await listen({
      key: 'test',
      fetcher: async (...args) => {
        calls++;
        return designFetch(...args);
      },
    });
    const input = designRequest();
    input.topology.nodes = Array.from({ length: 60 }, (_, i) => {
      const kind = componentCatalog[i % componentCatalog.length].kind;
      return {
        id: String(i).padEnd(100, 'n'),
        label: String(i).padEnd(160, 'L'),
        kind,
        x: i * 100,
        y: 0,
        config: defaultConfig(kind),
      };
    });
    input.topology.edges = Array.from({ length: 180 }, (_, i) => ({
      id: String(i).padEnd(240, 'e'),
      from: input.topology.nodes[Math.floor(i / 3)].id,
      to: input.topology.nodes[(Math.floor(i / 3) + (i % 3) + 1) % 60].id,
      weight: 1,
    }));
    const size = Buffer.byteLength(JSON.stringify(input));
    expect(size).toBeGreaterThan(64 * 1024);
    expect(size).toBeLessThan(256 * 1024);
    expect((await postDesign(base, input)).status).toBe(200);
    expect((await postDesign(base, { text: 'x'.repeat(256 * 1024) })).status).toBe(413);
    expect((await post(base, input)).status).toBe(413);
    expect(calls).toBe(1);
  });
  it('rejects foreign origins, wrong content, malformed topology and too many spans before charging a call', async () => {
    let calls = 0;
    const base = await listen({
      key: 'test',
      fetcher: async (...args) => {
        calls++;
        return designFetch(...args);
      },
    });
    const input = designRequest();
    expect(
      (await postDesign(base, input, undefined, { Origin: 'https://foreign.example' }))
        .status,
    ).toBe(403);
    expect(
      (await postDesign(base, input, undefined, { 'Sec-Fetch-Site': 'cross-site' }))
        .status,
    ).toBe(403);
    expect(
      (await postDesign(base, input, undefined, { 'Content-Type': 'text/plain' }))
        .status,
    ).toBe(415);
    expect(
      (await postDesign(base, { ...input, sessionId: 'a'.repeat(36) })).status,
    ).toBe(400);
    expect(
      (await postDesign(base, { ...input, completed: ['a', 'b', 'c', 'd', 'e'] }))
        .status,
    ).toBe(400);
    expect(
      (await postDesign(base, { ...input, selectedNodeId: 'missing' })).status,
    ).toBe(400);
    expect(
      (
        await postDesign(base, {
          ...input,
          topology: { ...input.topology, annotations: [] },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await postDesign(base, {
          ...input,
          prompt: Array.from({ length: 33 }, (_, i) => String(i)).join(' '),
        })
      ).status,
    ).toBe(400);
    expect(calls).toBe(0);
    expect((await (await postDesign(base, input)).json()).callsRemaining).toBe(17);
  });
  it('keeps the cross-endpoint gate until cancellation and charges failed design attempts', async () => {
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    let aborted!: () => void;
    const cancelled = new Promise<void>((resolve) => {
      aborted = resolve;
    });
    let calls = 0;
    const base = await listen({
      key: 'test',
      fetcher: async (url, init) => {
        calls++;
        if (calls === 1) {
          started();
          return new Promise<Response>((_resolve, reject) =>
            init?.signal?.addEventListener(
              'abort',
              () => {
                aborted();
                reject(new DOMException('cancelled', 'AbortError'));
              },
              { once: true },
            ),
          );
        }
        if (calls === 2) return Response.json({ model: MODEL, answers: {} });
        return designFetch(url, init);
      },
    });
    const input = designRequest();
    const operation = { ...request(), sessionId: input.sessionId };
    const controller = new AbortController();
    const pending = postDesign(base, input, controller.signal).catch(() => null);
    await entered;
    expect((await post(base, operation)).status).toBe(429);
    expect((await postDesign(base, input)).status).toBe(429);
    controller.abort();
    await cancelled;
    await pending;
    expect((await postDesign(base, input)).status).toBe(502);
    expect((await (await post(base, operation)).json()).callsRemaining).toBe(15);
    expect(calls).toBe(3);
  });
  it('times out design inference, releases its lease and never applies a late response', async () => {
    let aborted = false;
    let calls = 0;
    const base = await listen({
      key: 'test',
      timeoutMs: 30,
      fetcher: async (url, init) => {
        if (++calls !== 1) return designFetch(url, init);
        return new Promise<Response>((_resolve, reject) =>
          init?.signal?.addEventListener(
            'abort',
            () => {
              aborted = true;
              reject(new DOMException('timeout', 'AbortError'));
            },
            { once: true },
          ),
        );
      },
    });
    const input = designRequest();
    expect((await postDesign(base, input)).status).toBe(504);
    expect(aborted).toBe(true);
    expect((await (await postDesign(base, input)).json()).callsRemaining).toBe(16);
  });
});

describe('authoritative failure budgets', () => {
  it('reports unattempted configuration and validation rejections without charging a call', async () => {
    const input = designRequest();
    const offline = await listen();
    expect(await (await postDesign(offline, input)).json()).toMatchObject({
      attempted: false,
      callsRemaining: 18,
    });
    expect(
      await (await postDesign(offline, { ...input, prompt: '' })).json(),
    ).toMatchObject({ attempted: false, callsRemaining: 18 });
  });
  it('reports actual session counts on rejected requests and provider failures', async () => {
    let attempts = 0;
    const base = await listen({
      key: 'test',
      fetcher: async (...args) =>
        ++attempts === 1
          ? designFetch(...args)
          : new Response('failure', { status: 500 }),
    });
    const input = designRequest();
    expect((await (await postDesign(base, input)).json()).callsRemaining).toBe(17);
    expect(
      await (await postDesign(base, { ...input, prompt: '' })).json(),
    ).toMatchObject({ attempted: false, callsRemaining: 17 });
    expect(await (await postDesign(base, input)).json()).toMatchObject({
      attempted: true,
      callsRemaining: 16,
    });
    expect(attempts).toBe(2);
  });
  it('reports a busy gate without charging the rejected request', async () => {
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const base = await listen({
      key: 'test',
      fetcher: async (_url, init) => {
        started();
        return new Promise<Response>((_resolve, reject) =>
          init?.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('cancelled', 'AbortError')),
            { once: true },
          ),
        );
      },
    });
    const input = designRequest();
    const abort = new AbortController();
    const pending = postDesign(base, input, abort.signal).catch(() => null);
    await entered;
    expect(await (await postDesign(base, input)).json()).toMatchObject({
      attempted: false,
      callsRemaining: 17,
    });
    expect(await (await post(base)).json()).toMatchObject({
      attempted: false,
      callsRemaining: 18,
    });
    abort.abort();
    await pending;
  });
});
