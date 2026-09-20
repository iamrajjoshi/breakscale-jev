import { describe, expect, it } from 'vitest';
import { Engine } from '../src/sim/engine.ts';
import { PRESETS } from '../src/sim/presets.ts';
import { actionsFor, MODEL, observe } from '../src/operator/contracts.ts';
import { chooseAction } from './jev.ts';

describe('automatic recovery model boundary', () => {
  it('sends shared-lock evidence and prior waits, and accepts an explicit unsupported outcome', async () => {
    const topology = structuredClone(PRESETS[0]!.topology);
    const engine = new Engine(topology);
    const observation = observe(topology, engine.snapshot());
    observation.system = {
      timeMs: 30000,
      offeredRps: 10000,
      goodputRps: 6000,
      errorRate: 0.4,
      p99: 740000,
    };
    const database = observation.nodes.find((node) => node.kind === 'db')!;
    Object.assign(database, {
      instances: 128,
      utilization: 1,
      queued: 48,
      lockMs: 15,
      lockWaitMs: 983000,
      writeRate: 60,
    });
    const recovery = {
      consecutiveWaits: 3,
      previousWait: { ...observation.system, timeMs: 25000 },
    };
    const actions = actionsFor(observation, 'operator');
    let sent: Record<string, unknown> | undefined;
    const fetcher: typeof fetch = async (_url, init) => {
      sent = JSON.parse(String(init?.body));
      return Response.json({
        model: MODEL,
        answers: {
          action: {
            type: 'choice',
            choice: 'unsupported',
            confidence: 1,
            probabilities: Object.fromEntries(
              actions.map((action) => [action.id, action.id === 'unsupported' ? 1 : 0]),
            ),
          },
        },
        usage: { input_tokens: 100, output_tokens: 20 },
      });
    };
    const decision = await chooseAction(
      'test-only-key',
      {
        sessionId: '00000000-0000-4000-8000-000000000000',
        prompt: 'Restore useful throughput',
        mode: 'operator',
        observation,
        recovery,
      },
      new AbortController().signal,
      17,
      fetcher,
    );
    expect(decision.choice).toBe('unsupported');
    expect(sent).toMatchObject({
      state: {
        recovery,
        nodes: expect.arrayContaining([
          expect.objectContaining({
            id: database.id,
            lockMs: 15,
            lockWaitMs: 983000,
            writeRate: 60,
          }),
        ]),
      },
    });
    expect(
      actions.some(
        (action) =>
          (action.kind === 'scale' || action.kind === 'capacity') &&
          action.nodeId === database.id,
      ),
    ).toBe(false);
    expect(JSON.stringify(sent)).not.toContain('test-only-key');
  });
  it('sends observed damage and a finite repair menu, accepting only an offered repair', async () => {
    const topology = structuredClone(PRESETS[0]!.topology);
    const target = topology.nodes.find((node) => node.kind === 'service')!;
    target.config.capacity = 1;
    target.config.serviceMs = 500;
    target.config.errorRate = 0.5;
    const engine = new Engine(topology, 7);
    for (let tick = 0; tick < 200; tick++) engine.advance(100);
    const observation = observe(topology, engine.snapshot());
    const actions = actionsFor(observation, 'operator');
    const repair = actions.find(
      (action) => action.kind === 'service-time' && action.nodeId === target.id,
    )!;
    expect(repair).toBeDefined();
    let sent: Record<string, unknown> | undefined;
    const fetcher: typeof fetch = async (url, init) => {
      expect(url).toBe('https://api.typesafe.ai/v1/systemone');
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      sent = JSON.parse(String(init?.body));
      return Response.json({
        model: MODEL,
        answers: {
          action: {
            type: 'choice',
            choice: repair.id,
            confidence: 1,
            probabilities: Object.fromEntries(
              actions.map((action) => [action.id, action.id === repair.id ? 1 : 0]),
            ),
          },
        },
        usage: { input_tokens: 300, output_tokens: 30 },
      });
    };
    const decision = await chooseAction(
      'test-only-key',
      {
        sessionId: '00000000-0000-4000-8000-000000000000',
        prompt: 'Repair the system while preserving offered traffic.',
        mode: 'operator',
        observation,
      },
      new AbortController().signal,
      17,
      fetcher,
    );
    expect(decision.choice).toBe(repair.id);
    expect(sent).toMatchObject({
      model: MODEL,
      state: {
        mode: 'operator',
        incident: { kind: 'overload' },
        nodes: expect.arrayContaining([
          expect.objectContaining({
            id: target.id,
            capacity: 1,
            serviceMs: 500,
            configuredErrorRate: 0.5,
          }),
        ]),
      },
      questions: {
        action: {
          type: 'choice',
          criteria: Object.fromEntries(
            actions.map((action) => [action.id, action.label]),
          ),
        },
      },
    });
    const serialized = JSON.stringify(sent);
    expect(serialized).not.toContain('traffic_down');
    expect(serialized).not.toContain('crash_');
    expect(serialized).not.toContain('sessionId');
    expect(serialized).not.toContain('test-only-key');
  });
});
