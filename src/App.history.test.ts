import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FailureKind, FailureOpts, Topology } from './sim/types';
import { Engine } from './sim/engine';
import { makeNode } from './sim/presets';
import { makeNote } from './sim/annotations';
import { compileEdit } from './designer/compiler';
import {
  HISTORY_LIMIT,
  isRunReplacement,
  restoreRunFailures,
  SessionHistory,
  syncEngine,
} from './history';
import type { HistoryEntry, HistorySnapshot } from './history';

/*
 * Undo/redo semantics, tested against the same SessionHistory instance the
 * shell drives. Each test simulates the exact call sequence App makes for a
 * gesture, so what is pinned here is the ENTRY GRANULARITY the feature
 * promises: one drag is one entry, one settled knob value is one entry, a
 * selection click is no entry at all.
 */

function makeTopology(): Topology {
  const client = makeNode('client', 0, 0);
  const svc = makeNode('service', 200, 0);
  return {
    nodes: [client, svc],
    edges: [{ id: `${client.id}->${svc.id}`, from: client.id, to: svc.id, weight: 1 }],
  };
}

function snap(
  topology: Topology,
  selected: readonly string[] = [],
  rps = 100,
): HistorySnapshot {
  return {
    topology: structuredClone(topology),
    selectedIds: new Set(selected),
    rps,
    presetId: null,
  };
}

/** The topology with one node shifted, as a drag or nudge would leave it. */
function moved(t: Topology, id: string, dx: number, dy: number): Topology {
  return {
    ...t,
    nodes: t.nodes.map((n) => (n.id === id ? { ...n, x: n.x + dx, y: n.y + dy } : n)),
  };
}

describe('SessionHistory', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('records one entry for a whole drag, not one per frame', () => {
    const h = new SessionHistory();
    const t0 = makeTopology();
    const id = t0.nodes[1]!.id;

    // App's sequence: baseline at promotion, then per-frame moves that
    // bypass history (inGesture), then one endGesture at pointerup.
    h.beginGesture('move', snap(t0));
    let t = t0;
    for (let frame = 1; frame <= 60; frame++) {
      t = moved(t0, id, frame, 0);
      // handleMoveNode's guard: inside a gesture, no touch().
      expect(h.inGesture).toBe(true);
    }
    h.endGesture(snap(t, [id]));

    expect(h.undoDepth).toBe(1);
    const entry = h.undo(snap(t, [id]));
    expect(entry).not.toBeNull();
    // Undo lands on the pre-drag position and the pre-drag selection.
    expect(entry!.topology.nodes[1]!.x).toBe(t0.nodes[1]!.x);
    expect(entry!.selectedIds.size).toBe(0);
  });

  it('records no entry for a drag that returns to its origin', () => {
    const h = new SessionHistory();
    const t0 = makeTopology();
    const id = t0.nodes[1]!.id;

    h.beginGesture('move', snap(t0));
    // Out and back; only the endpoints matter to history. The promotion
    // selected the node, but a selection-only difference is not an entry.
    h.endGesture(snap(t0, [id]));

    expect(h.undoDepth).toBe(0);
    expect(h.canUndo).toBe(false);
  });

  it('coalesces a streamed config edit into one entry per settled value', () => {
    const h = new SessionHistory();
    const t0 = makeTopology();
    const id = t0.nodes[1]!.id;

    // Sixty slider frames, then the stream goes quiet.
    let t = t0;
    for (let v = 1; v <= 60; v++) {
      t = {
        ...t,
        nodes: t.nodes.map((n) =>
          n.id === id ? { ...n, config: { ...n.config, capacity: v } } : n,
        ),
      };
      h.touch('setting change', snap(t));
    }
    expect(h.undoDepth).toBe(0); // still pending, not yet an entry
    expect(h.canUndo).toBe(true); // but already undoable
    vi.runAllTimers();
    expect(h.undoDepth).toBe(1);

    // A second, separate adjustment after settling is a second entry.
    h.touch('setting change', snap(t));
    vi.runAllTimers();
    expect(h.undoDepth).toBe(2);
  });

  it('keeps the redo stack across a selection-only change', () => {
    const h = new SessionHistory();
    const t0 = makeTopology();
    const t1 = moved(t0, t0.nodes[1]!.id, 100, 0);

    h.beginGesture('move', snap(t0));
    h.endGesture(snap(t1));
    const back = h.undo(snap(t1));
    expect(back).not.toBeNull();
    expect(h.canRedo).toBe(true);

    // The student clicks a node: App updates selection state and calls
    // NOTHING on history. Redo must still work, and from the changed
    // selection.
    const selectedElsewhere = snap(t0, [t0.nodes[0]!.id]);
    const fwd = h.redo(selectedElsewhere);
    expect(fwd).not.toBeNull();
    expect(fwd!.topology.nodes[1]!.x).toBe(t1.nodes[1]!.x);
  });

  it('clears the redo stack on a real edit', () => {
    const h = new SessionHistory();
    const t0 = makeTopology();
    const t1 = moved(t0, t0.nodes[1]!.id, 100, 0);

    h.commit('add', snap(t0));
    h.undo(snap(t1));
    expect(h.canRedo).toBe(true);

    h.commit('delete', snap(t0));
    expect(h.canRedo).toBe(false);
  });

  it('clears the redo stack as soon as a streamed edit begins', () => {
    const h = new SessionHistory();
    const t0 = makeTopology();
    const t1 = moved(t0, t0.nodes[1]!.id, 100, 0);

    h.commit('add', snap(t0));
    h.undo(snap(t1));
    expect(h.canRedo).toBe(true);

    // First slider frame: state has already diverged, so redo dies NOW,
    // not 500ms later when the value settles.
    h.touch('setting change', snap(t0));
    expect(h.canRedo).toBe(false);
  });

  it('holds the stack bound and drops the oldest entry first', () => {
    const h = new SessionHistory();
    const t0 = makeTopology();

    h.commit('example load', snap(t0)); // the entry that must fall off
    for (let i = 0; i < HISTORY_LIMIT; i++) {
      h.commit('add', snap(moved(t0, t0.nodes[1]!.id, i, 0)));
    }

    expect(h.undoDepth).toBe(HISTORY_LIMIT);
    expect(h.oldestLabel).toBe('add');
  });

  it('skips no-op entries instead of burning an undo press', () => {
    const h = new SessionHistory();
    const t0 = makeTopology();
    const t1 = moved(t0, t0.nodes[1]!.id, 100, 0);

    h.commit('add', snap(t0)); // the real difference
    h.commit('add', snap(t1)); // identical to the current state below

    const entry = h.undo(snap(t1));
    // One press: the no-op entry was popped and discarded, and the press
    // landed on the state that actually differs.
    expect(entry).not.toBeNull();
    expect(entry!.topology.nodes[1]!.x).toBe(t0.nodes[1]!.x);
    expect(h.undoDepth).toBe(0);
  });

  it('flushes a pending streamed edit when undo arrives mid-settle', () => {
    const h = new SessionHistory();
    const t0 = makeTopology();
    const t1 = moved(t0, t0.nodes[1]!.id, 100, 0);

    h.touch('move', snap(t0));
    // Undo before the 500ms settle: the pending entry must land first so
    // this press reverts the nudge, not whatever came before it.
    const entry = h.undo(snap(t1));
    expect(entry).not.toBeNull();
    expect(entry!.topology.nodes[1]!.x).toBe(t0.nodes[1]!.x);
  });

  it('is immune to later mutation of what it captured', () => {
    const h = new SessionHistory();
    const t0 = makeTopology();
    const live = snap(t0);

    h.commit('add', live);
    // The caller mutates its own copy afterwards; the entry must not follow.
    (live.topology.nodes[1]! as { x: number }).x = 9999;

    const entry = h.undo(snap(moved(t0, t0.nodes[1]!.id, 50, 0)));
    expect(entry!.topology.nodes[1]!.x).toBe(t0.nodes[1]!.x);
  });
});

describe('note text edits', () => {
  /*
   * The exact sequence App.handleEditNote drives: the editor holds the
   * draft until it submits, then ONE commit lands the finished text (or
   * removes an emptied note). Undo restores the text as it was before the
   * edit began, however many keystrokes it took; redo brings the edit back.
   */
  function withNote(text: string): Topology {
    return { ...makeTopology(), annotations: [makeNote(0, 0, text)] };
  }
  const noteText = (t: Topology) => {
    const a = t.annotations?.[0];
    return a && a.kind === 'note' ? a.text : null;
  };

  it('one edit is one entry, whatever was typed on the way', () => {
    const h = new SessionHistory();
    const t0 = withNote('before');
    const id = t0.annotations![0]!.id;
    // Keystrokes never reach history: the draft lives in the editor.
    h.commit('note edit', snap(t0, [id]));
    const t1 = {
      ...t0,
      annotations: [{ ...t0.annotations![0]!, text: 'after\nmore' }],
    };

    expect(h.undoDepth).toBe(1);
    const back = h.undo(snap(t1, [id]));
    expect(noteText(back!.topology)).toBe('before');
    expect(back!.label).toBe('note edit');
    const fwd = h.redo(back!);
    expect(noteText(fwd!.topology)).toBe('after\nmore');
  });

  it('an emptied note is a delete entry, and undo brings the note back', () => {
    const h = new SessionHistory();
    const t0 = withNote('before');
    const id = t0.annotations![0]!.id;
    h.commit('delete', snap(t0, [id]));
    const t1 = { ...t0, annotations: [] };

    const back = h.undo(snap(t1));
    expect(noteText(back!.topology)).toBe('before');
    expect(back!.selectedIds.has(id)).toBe(true);
  });

  it('a commit with identical text would be a no-op entry', () => {
    // The canvas never calls it (Canvas.noteEdit.test.tsx pins that); if
    // it ever did, snapshotEqual would still refuse to store the entry.
    const h = new SessionHistory();
    const t0 = withNote('same');
    h.commit('note edit', snap(t0));
    expect(h.undo(snap(t0))).toBeNull();
  });
});

describe.each(['recorded run', 'starter load'])('%s history', (label) => {
  const capture = (topology: Topology, engine: Engine): HistorySnapshot => ({
    ...snap(topology),
    failures: engine.activeFailures(),
  });
  // App.applyEntry restores faults only for a deliberate run replacement.
  const apply = (engine: Engine, from: Topology, entry: HistoryEntry) => {
    syncEngine(engine, from, entry.topology);
    if (isRunReplacement(entry.label) && entry.failures !== undefined)
      restoreRunFailures(engine, entry.failures);
  };
  const settings = (engine: Engine) =>
    engine.activeFailures().map(({ sinceMs: _sinceMs, ...failure }) => failure);

  it.each([
    { kind: 'crash', opts: {} },
    { kind: 'slow', opts: { factor: 7 } },
    { kind: 'errors', opts: { rate: 0.4 } },
    { kind: 'partition', opts: { edgeIds: ['original-cut'] } },
  ] satisfies { kind: FailureKind; opts: FailureOpts }[])(
    'preserves a user $kind fault on Undo and restores the loaded run on Redo',
    ({ kind, opts }) => {
      const topology = makeTopology();
      const target = topology.nodes[1]!.id;
      const engine = new Engine(topology);
      engine.injectFailure(target, kind, opts);
      const before = settings(engine);
      const history = new SessionHistory();
      history.commit(label, capture(topology, engine));
      // Loading the same diagram still resets faults, even without new damage.
      engine.setTopology(topology);
      engine.reset();
      if (label === 'recorded run') engine.injectFailure(target, 'slow', { factor: 5 });
      const recorded = settings(engine);
      engine.advance(1000);
      const time = engine.snapshot().system.timeMs;

      const undo = history.undo(capture(topology, engine))!;
      expect(undo).not.toBeNull();
      apply(engine, topology, undo);
      expect(settings(engine)).toEqual(before);
      expect(engine.snapshot().system.timeMs).toBe(time);

      const redo = history.redo(capture(undo.topology, engine))!;
      expect(redo).not.toBeNull();
      apply(engine, undo.topology, redo);
      expect(settings(engine)).toEqual(recorded);
      expect(engine.snapshot().system.timeMs).toBe(time);
    },
  );

  it('keeps repeated identical scene loads separate and removes their faults on Undo', () => {
    const topology = makeTopology();
    const target = topology.nodes[1]!.id;
    const engine = new Engine(topology);
    const history = new SessionHistory();
    for (let load = 0; load < 2; load++) {
      history.commit(label, capture(topology, engine));
      engine.setTopology(topology);
      engine.reset();
      if (label === 'recorded run') engine.injectFailure(target, 'crash');
    }
    expect(history.undoDepth).toBe(2);
    const first = history.undo(capture(topology, engine))!;
    expect(first).not.toBeNull();
    apply(engine, topology, first);
    const loaded = label === 'recorded run' ? [{ nodeId: target, kind: 'crash' }] : [];
    expect(settings(engine)).toEqual(loaded);
    const second = history.undo(capture(topology, engine))!;
    expect(second).not.toBeNull();
    apply(engine, topology, second);
    expect(engine.activeFailures()).toEqual([]);
    for (let redo = 0; redo < 2; redo++) {
      const entry = history.redo(capture(topology, engine))!;
      expect(entry).not.toBeNull();
      apply(engine, topology, entry);
      expect(settings(engine)).toEqual(loaded);
    }
  });

  it('deep-copies saved fault options instead of retaining mutable arrays', () => {
    const topology = makeTopology();
    const engine = new Engine(topology);
    engine.injectFailure(topology.nodes[1]!.id, 'partition', { edgeIds: ['cut'] });
    const before = capture(topology, engine);
    const history = new SessionHistory();
    history.commit(label, before);
    before.failures![0]!.edgeIds!.push('later-edit');
    const undo = history.undo(capture(topology, engine))!;
    expect(undo.failures![0]!.edgeIds).toEqual(['cut']);
  });

  it('leaves ordinary config Undo and no-op skipping independent of transient faults', () => {
    const topology = makeTopology();
    const target = topology.nodes[1]!.id;
    const engine = new Engine(topology);
    const history = new SessionHistory();
    history.commit('setting change', capture(topology, engine));
    const edited = structuredClone(topology);
    edited.nodes[1]!.config.capacity += 1;
    syncEngine(engine, topology, edited);
    engine.injectFailure(target, 'slow', { factor: 9 });
    const undo = history.undo(capture(edited, engine))!;
    apply(engine, edited, undo);
    expect(settings(engine)).toEqual([{ nodeId: target, kind: 'slow', factor: 9 }]);
    history.commit('setting change', capture(topology, engine));
    engine.clearFailure(target);
    expect(history.undo(capture(topology, engine))).toBeNull();
  });
});

describe('syncEngine', () => {
  it('applies a config-only undo through updateNodeConfig, without reset', () => {
    const t0 = makeTopology();
    const svcId = t0.nodes[1]!.id;
    const engine = new Engine(t0);
    engine.advance(2000);
    const timeBefore = engine.snapshot().system.timeMs;
    expect(timeBefore).toBeGreaterThan(0);

    const edited = structuredClone(t0);
    edited.nodes[1]!.config.capacity = 99;

    const setTopo = vi.spyOn(engine, 'setTopology');
    const reset = vi.spyOn(engine, 'reset');
    const update = vi.spyOn(engine, 'updateNodeConfig');

    syncEngine(engine, t0, edited);

    // The live in-place path, exactly as a forward knob edit uses.
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith(
      svcId,
      expect.objectContaining({ capacity: 99 }),
    );
    expect(setTopo).not.toHaveBeenCalled();
    expect(reset).not.toHaveBeenCalled();
    // The simulation clock, and with it every metric a student was
    // watching, is untouched.
    expect(engine.snapshot().system.timeMs).toBe(timeBefore);
  });

  it('applies a structural undo through setTopology, still without reset', () => {
    const t0 = makeTopology();
    const engine = new Engine(t0);
    engine.advance(1000);
    const timeBefore = engine.snapshot().system.timeMs;

    const grown = structuredClone(t0);
    const extra = makeNode('cache', 400, 0);
    grown.nodes.push(extra);

    const setTopo = vi.spyOn(engine, 'setTopology');
    const reset = vi.spyOn(engine, 'reset');

    syncEngine(engine, t0, grown);

    expect(setTopo).toHaveBeenCalledTimes(1);
    expect(reset).not.toHaveBeenCalled();
    expect(engine.snapshot().system.timeMs).toBe(timeBefore);
  });

  it('treats a position-only difference as non-structural', () => {
    // Node positions are presentation; undoing a pure move must not push a
    // whole topology into the engine (which would stomp autoscaler-written
    // capacity, among other live state).
    const t0 = makeTopology();
    const engine = new Engine(t0);
    const setTopo = vi.spyOn(engine, 'setTopology');
    const update = vi.spyOn(engine, 'updateNodeConfig');

    syncEngine(engine, t0, moved(t0, t0.nodes[1]!.id, 120, 40));

    expect(setTopo).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it('keeps mixed architecture and scale edits exact through one undo and redo', () => {
    const before = makeTopology();
    const service = before.nodes[1]!;
    service.config.instances = 1;
    const engine = new Engine(before);
    engine.advance(1200);
    const clock = engine.snapshot().system.timeMs;
    const after = structuredClone(before);
    after.nodes[1]!.config.instances = 3;
    after.nodes.push(makeNode('queue', 400, 0));
    const history = new SessionHistory();
    history.commit('JEV design', snap(before));

    syncEngine(engine, before, after);
    expect(engine.snapshot().nodes[service.id]!.instances).toBe(3);
    expect(history.undoDepth).toBe(1);

    const undone = history.undo(snap(after))!;
    syncEngine(engine, after, undone.topology);
    expect(engine.snapshot().nodes[service.id]!.instances).toBe(1);
    expect(Object.keys(engine.snapshot().nodes)).toHaveLength(2);

    const redone = history.redo(undone)!;
    syncEngine(engine, undone.topology, redone.topology);
    expect(engine.snapshot().nodes[service.id]!.instances).toBe(3);
    expect(Object.keys(engine.snapshot().nodes)).toHaveLength(3);
    expect(engine.snapshot().system.timeMs).toBe(clock);
  });

  it.each([false, true])(
    'preserves a live autoscaled fleet through tuning, undo and redo (structural edit: %s)',
    (structural) => {
      const before = makeTopology();
      const client = before.nodes[0]!;
      const service = before.nodes[1]!;
      client.config.rps = 1000;
      Object.assign(service.config, { instances: 1, capacity: 1, serviceMs: 100 });
      const autoscaler = makeNode('autoscaler', 200, 160);
      Object.assign(autoscaler.config, {
        minCapacity: 1,
        maxCapacity: 8,
        targetUtil: 0.3,
        cooldownMs: 0,
        warmupMs: 0,
        scaleStepPct: 1,
      });
      before.nodes.push(autoscaler);
      before.edges.push({
        id: 'supervisor',
        from: autoscaler.id,
        to: service.id,
        weight: 1,
        control: true,
      });
      const engine = new Engine(before, 7);
      for (let frame = 0; frame < 120; frame++) engine.advance(1000 / 60);
      expect(engine.snapshot().nodes[service.id]!.instances).toBe(8);
      expect(before.nodes[1]!.config.instances).toBe(1);
      const clock = engine.snapshot().system.timeMs;
      const completed = engine.snapshot().nodes[service.id]!.totalCompleted;
      let after = compileEdit(before, {
        op: 'configure',
        nodeId: service.id,
        field: 'serviceMs',
        value: 50,
      }).topology;
      if (structural)
        after = compileEdit(after, {
          op: 'add',
          kind: 'queue',
          placement: 'unconnected',
        }).topology;
      const update = vi.spyOn(engine, 'updateNodeConfig');
      const history = new SessionHistory();
      history.commit('JEV design', snap(before));

      syncEngine(engine, before, after);
      expect(update).toHaveBeenLastCalledWith(service.id, { serviceMs: 50 });
      expect(engine.snapshot().nodes[service.id]!.instances).toBe(8);
      expect(history.undoDepth).toBe(1);

      const undone = history.undo(snap(after))!;
      syncEngine(engine, after, undone.topology);
      expect(update).toHaveBeenLastCalledWith(service.id, { serviceMs: 100 });
      expect(engine.snapshot().nodes[service.id]!.instances).toBe(8);

      const redone = history.redo(undone)!;
      syncEngine(engine, undone.topology, redone.topology);
      expect(update).toHaveBeenLastCalledWith(service.id, { serviceMs: 50 });
      expect(engine.snapshot().nodes[service.id]!.instances).toBe(8);
      expect(engine.snapshot().system.timeMs).toBe(clock);
      expect(engine.snapshot().nodes[service.id]!.totalCompleted).toBe(completed);
    },
  );

  it.each([false, true])(
    'restores an omitted legacy instance count through undo, redo and reset (structural edit: %s)',
    (structural) => {
      const before = makeTopology();
      const service = before.nodes[1]!;
      delete service.config.instances;
      const engine = new Engine(before);
      expect(engine.snapshot().nodes[service.id]!.instances).toBe(1);
      let after = compileEdit(before, {
        op: 'configure',
        nodeId: service.id,
        field: 'instances',
        value: 3,
      }).topology;
      if (structural)
        after = compileEdit(after, {
          op: 'add',
          kind: 'queue',
          placement: 'unconnected',
        }).topology;
      const history = new SessionHistory();
      history.commit('JEV design', snap(before));
      syncEngine(engine, before, after);
      expect(engine.snapshot().nodes[service.id]!.instances).toBe(3);

      const undone = history.undo(snap(after))!;
      expect(undone.topology.nodes[1]!.config.instances).toBeUndefined();
      syncEngine(engine, after, undone.topology);
      expect(engine.snapshot().nodes[service.id]!.instances).toBe(1);
      engine.reset();
      expect(engine.snapshot().nodes[service.id]!.instances).toBe(1);

      const redone = history.redo(undone)!;
      syncEngine(engine, undone.topology, redone.topology);
      expect(engine.snapshot().nodes[service.id]!.instances).toBe(3);
      engine.reset();
      expect(engine.snapshot().nodes[service.id]!.instances).toBe(3);
    },
  );
});
