import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { NodeConfig, SimSnapshot, Topology } from '../sim/types';
import {
  actionsFor,
  CALL_LIMIT,
  CALL_WINDOW_MS,
  decisionFingerprint,
  incidentFor,
  hasWriteContention,
  MODEL,
  observe,
  type Action,
  type Decision,
  type DecisionRequest,
  type Observation,
} from './contracts';
import { Activity } from './Activity';
import { ACTIVITY_LIMIT, type ActivityEntry } from './activity-record';
import { madeRecoveryProgress, MAX_STALLED_WAITS } from './wait-policy';
import './Operator.css';

interface OperatorProps {
  topology: Topology;
  snapshot: SimSnapshot | null;
  selectedNodeId: string | null;
  running: boolean;
  challengeActive: boolean;
  resetEpoch: number;
  onFailure: (nodeId: string, kind: 'crash' | 'slow' | null) => void;
  onConfigChange: (nodeId: string, patch: Partial<NodeConfig>) => boolean;
  onTrafficChange: (rps: number) => void;
}

const RECOVERY_GOAL =
  'Restore useful throughput and reduce failures at the current offered traffic. Repair the observed cause, then let the system settle. Never lower demand or introduce a failure.';
const SETTLE_MS = 2400;
type Attempt = { id: number; at: number };
type Repair = {
  entryId: number;
  label: string;
  errorBefore: number;
  appliedAtMs: number;
  measured: boolean;
};

export function Operator(props: OperatorProps) {
  const fingerprint = props.snapshot
    ? decisionFingerprint(props.topology, props.snapshot)
    : '';
  const [armed, setArmed] = useState(true);
  const [pending, setPending] = useState(false);
  const [canRetry, setCanRetry] = useState(false);
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [phase, setPhase] = useState('connecting');
  const [status, setStatus] = useState('Connecting JEV…');
  const [receipt, setReceipt] = useState('');
  const [activity, setActivity] = useState<ActivityEntry[]>([]);
  const [remaining, setRemaining] = useState(CALL_LIMIT);
  const [connectionCheck, setConnectionCheck] = useState(0);
  const [sessionId] = useState(() => crypto.randomUUID());
  const dock = useRef<HTMLElement>(null);
  const latest = useRef(props);
  const enabled = useRef(true);
  const connected = useRef<boolean | null>(null);
  const epoch = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const attempts = useRef<Attempt[]>([]);
  const nextAt = useRef(0);
  const serverCooldown = useRef(0);
  const errorCount = useRef(0);
  const retryMessage = useRef('');
  const lastRepair = useRef<Repair | null>(null);
  const ownChange = useRef(false);
  const activeAttempt = useRef<number | null>(null);
  const waiting = useRef<{ count: number; previous?: Observation['system'] }>({
    count: 0,
  });
  const intervention = useRef<{
    key: string;
    message: string;
    retryable: boolean;
  } | null>(null);
  const previous = useRef({
    fingerprint,
    running: props.running,
    challenge: props.challengeActive,
    reset: props.resetEpoch,
    time: props.snapshot?.system.timeMs ?? 0,
  });

  const recoveryKey = useCallback(
    (observation: Observation, choices: Action[]) =>
      JSON.stringify({
        fingerprint: previous.current.fingerprint,
        choices,
        incident: incidentFor(observation),
      }),
    [],
  );

  const resetWaiting = useCallback(() => {
    waiting.current = { count: 0 };
    intervention.current = null;
    setCanRetry(false);
  }, []);

  const needIntervention = useCallback(
    (
      observation: Observation,
      choices: Action[],
      message: string,
      retryable: boolean,
    ) => {
      intervention.current = {
        key: recoveryKey(observation, choices),
        message,
        retryable,
      };
      setCanRetry(retryable);
      setPhase('needs-help');
      setStatus(message);
    },
    [recoveryKey],
  );

  const updateActivity = useCallback((id: number, patch: Partial<ActivityEntry>) => {
    setActivity((entries) =>
      entries.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry)),
    );
  }, []);

  const interruptMeasurement = useCallback(
    (reason: string) => {
      const repair = lastRepair.current;
      if (repair && !repair.measured)
        updateActivity(repair.entryId, {
          status: 'interrupted',
          detail: reason,
          completedAt: Date.now(),
        });
      lastRepair.current = null;
    },
    [updateActivity],
  );

  // An obsolete decision was not applied. An already-applied repair remains
  // in the log even when a later edit prevents measuring its effect.
  const invalidate = useCallback(
    (
      delay = 500,
      reason = 'The system changed before this decision could be applied.',
    ) => {
      if (activeAttempt.current !== null) {
        updateActivity(activeAttempt.current, {
          status: 'cancelled',
          detail: reason,
          completedAt: Date.now(),
        });
        activeAttempt.current = null;
      }
      epoch.current++;
      controller.current?.abort();
      controller.current = null;
      nextAt.current = Date.now() + delay;
      setPending(false);
    },
    [updateActivity],
  );

  useLayoutEffect(() => {
    latest.current = props;
    const old = previous.current;
    const changed = old.fingerprint !== fingerprint;
    const interrupted =
      old.running !== props.running ||
      old.challenge !== props.challengeActive ||
      old.reset !== props.resetEpoch ||
      (props.snapshot?.system.timeMs ?? 0) < old.time;
    if (interrupted || (changed && !ownChange.current)) {
      const reason =
        old.reset !== props.resetEpoch
          ? 'The simulation was reset.'
          : !props.running
            ? 'The simulation was paused.'
            : props.challengeActive
              ? 'A challenge took control.'
              : 'The system was edited.';
      invalidate(500, `${reason} This decision was not applied.`);
      interruptMeasurement(`${reason} The applied change was not fully measured.`);
      resetWaiting();
      retryMessage.current = '';
      errorCount.current = 0;
      setReceipt('');
    }
    if (changed) ownChange.current = false;
    previous.current = {
      fingerprint,
      running: props.running,
      challenge: props.challengeActive,
      reset: props.resetEpoch,
      time: props.snapshot?.system.timeMs ?? 0,
    };
  }, [props, fingerprint, invalidate, interruptMeasurement, resetWaiting]);

  useLayoutEffect(() => {
    const element = dock.current;
    const owner = element?.closest<HTMLElement>('.app-body');
    if (!element || !owner) return;
    const measure = () =>
      owner.style.setProperty(
        '--operator-height',
        `${element.getBoundingClientRect().height}px`,
      );
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => {
      observer.disconnect();
      owner.style.removeProperty('--operator-height');
    };
  }, []);

  useEffect(() => {
    const health = new AbortController();
    let checking = false;
    const check = async () => {
      if (checking || health.signal.aborted) return;
      checking = true;
      try {
        const response = await fetch('/api/health', { signal: health.signal });
        const result = (await response.json()) as { configured?: boolean };
        if (health.signal.aborted) return;
        connected.current = response.ok && result.configured === true;
        setConfigured(connected.current);
      } catch {
        if (!health.signal.aborted) {
          connected.current = false;
          setConfigured(false);
        }
      } finally {
        checking = false;
      }
    };
    void check();
    const timer = window.setInterval(() => {
      if (!connected.current) void check();
    }, 15000);
    return () => {
      health.abort();
      clearInterval(timer);
    };
  }, [connectionCheck]);

  useEffect(() => {
    const visibility = () =>
      invalidate(500, 'Tab visibility changed. This decision was not applied.');
    document.addEventListener('visibilitychange', visibility);
    return () => {
      document.removeEventListener('visibilitychange', visibility);
      controller.current?.abort();
      // Invalidate responses from this instance, including Strict Mode cleanup.
      // oxlint-disable-next-line react-hooks/exhaustive-deps
      epoch.current++;
    };
  }, [invalidate]);

  const apply = useCallback((action: Action): boolean => {
    const live = latest.current;
    if (action.kind === 'wait' || action.kind === 'unsupported') return false;
    ownChange.current = true;
    if (action.kind === 'repair') {
      live.onFailure(action.nodeId, null);
      return true;
    }
    const patch: Partial<NodeConfig> | null =
      action.kind === 'scale'
        ? { instances: action.value }
        : action.kind === 'capacity'
          ? { capacity: action.value }
          : action.kind === 'service-time'
            ? { serviceMs: action.value }
            : action.kind === 'error-rate'
              ? { errorRate: action.value }
              : action.kind === 'retries'
                ? { retries: action.value }
                : null;
    const applied =
      patch && 'nodeId' in action ? live.onConfigChange(action.nodeId, patch) : false;
    if (!applied) ownChange.current = false;
    return applied;
  }, []);

  const request = useCallback(async () => {
    const current = latest.current;
    if (
      !current.snapshot ||
      !current.running ||
      current.challengeActive ||
      !enabled.current ||
      document.hidden ||
      controller.current
    )
      return;
    const observation = observe(current.topology, current.snapshot);
    const choices = actionsFor(observation, 'operator');
    const before = decisionFingerprint(current.topology, current.snapshot);
    const sequence = ++epoch.current;
    const abort = new AbortController();
    controller.current = abort;
    activeAttempt.current = sequence;
    setActivity((entries) =>
      [
        {
          id: sequence,
          startedAt: Date.now(),
          incident: incidentFor(observation)?.summary ?? 'the system',
          status: 'diagnosing' as const,
          detail: 'JEV is choosing one repair for the current system.',
          before: { ...observation.system },
        },
        ...entries,
      ].slice(0, ACTIVITY_LIMIT),
    );
    attempts.current.push({ id: sequence, at: Date.now() });
    setRemaining(Math.max(0, CALL_LIMIT - attempts.current.length));
    setPending(true);
    setPhase('pending');
    setStatus(
      `JEV is diagnosing ${incidentFor(observation)?.summary ?? 'the system'}.`,
    );
    const deadline = window.setTimeout(() => abort.abort(), 12000);
    let failureStatus: 'failed' | 'deferred' = 'failed';
    try {
      const payload: DecisionRequest = {
        sessionId,
        prompt: RECOVERY_GOAL,
        mode: 'operator',
        observation,
        recovery: {
          consecutiveWaits: waiting.current.count,
          previousWait: waiting.current.previous,
        },
      };
      const response = await fetch('/api/decide', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: abort.signal,
      });
      const body = (await response.json()) as Decision & {
        attempted?: boolean;
        error?: string;
        retryAfterMs?: number;
      };
      if (sequence !== epoch.current) return;
      if (!response.ok) {
        if (response.status === 429) failureStatus = 'deferred';
        if (body.attempted === false)
          attempts.current = attempts.current.filter((item) => item.id !== sequence);
        if (response.status === 429 && body.callsRemaining === 0) {
          updateActivity(sequence, {
            status: 'deferred',
            detail: 'The decision limit was reached. No change was applied.',
            completedAt: Date.now(),
          });
          serverCooldown.current =
            Date.now() +
            Math.max(
              1000,
              Math.min(CALL_WINDOW_MS, body.retryAfterMs ?? CALL_WINDOW_MS),
            );
          return;
        }
        if (response.status === 503) {
          connected.current = false;
          setConfigured(false);
        }
        throw new Error(
          typeof body.error === 'string' && body.error.length <= 240
            ? body.error
            : 'JEV could not respond',
        );
      }
      const live = latest.current;
      if (
        !enabled.current ||
        !live.running ||
        live.challengeActive ||
        !live.snapshot ||
        document.hidden ||
        decisionFingerprint(live.topology, live.snapshot) !== before ||
        live.snapshot.system.timeMs < observation.system.timeMs
      ) {
        updateActivity(sequence, {
          status: 'cancelled',
          detail: 'The system changed before this decision could be applied.',
          completedAt: Date.now(),
        });
        nextAt.current = Date.now() + 500;
        return;
      }
      const action = choices.find((item) => item.id === body.choice);
      const stillAvailable = actionsFor(
        observe(live.topology, live.snapshot),
        'operator',
      ).find((item) => item.id === body.choice);
      if (
        !action ||
        body.model !== MODEL ||
        !Number.isInteger(body.callsRemaining) ||
        body.callsRemaining < 0 ||
        body.callsRemaining > CALL_LIMIT
      )
        throw new Error('JEV returned an invalid repair');
      updateActivity(sequence, { action: action.label, chosenAt: Date.now() });
      // Runtime autoscaling can change a candidate without changing the authored
      // graph. Never apply an old scale-up that would now shrink a healthy fleet.
      if (JSON.stringify(action) !== JSON.stringify(stillAvailable)) {
        updateActivity(sequence, {
          status: 'cancelled',
          detail:
            'This repair was no longer valid for the current system. No change was applied.',
          completedAt: Date.now(),
        });
        nextAt.current = Date.now() + 500;
        return;
      }
      if (body.callsRemaining === 0)
        serverCooldown.current =
          Date.now() +
          Math.max(1000, Math.min(CALL_WINDOW_MS, body.retryAfterMs ?? CALL_WINDOW_MS));
      errorCount.current = 0;
      retryMessage.current = '';
      const beforeApply = observe(live.topology, live.snapshot).system;
      if (apply(action)) {
        resetWaiting();
        updateActivity(sequence, {
          status: 'measuring',
          appliedAt: Date.now(),
          before: { ...beforeApply },
          detail:
            'The change was applied. Waiting for at least 2.4 seconds of simulated traffic before measuring.',
        });
        lastRepair.current = {
          entryId: sequence,
          label: action.label,
          errorBefore: beforeApply.errorRate,
          appliedAtMs: live.snapshot.system.timeMs,
          measured: false,
        };
        setReceipt(action.label);
        setPhase('recovering');
        setStatus('Repair applied. Watching the traffic recover.');
        nextAt.current = Date.now() + SETTLE_MS;
      } else {
        // No new repair is being measured after a wait or refusal.
        lastRepair.current = null;
        const currentObservation = observe(live.topology, live.snapshot);
        if (action.kind === 'wait') {
          const progress =
            waiting.current.previous &&
            madeRecoveryProgress(waiting.current.previous, beforeApply);
          waiting.current = {
            count: progress ? 1 : waiting.current.count + 1,
            previous: { ...beforeApply },
          };
        }
        const blocked =
          action.kind === 'unsupported' ||
          (action.kind === 'wait' && waiting.current.count >= MAX_STALLED_WAITS);
        const detail =
          action.kind === 'unsupported'
            ? 'JEV found no useful repair in the available controls. Change the system or retry JEV.'
            : blocked
              ? `JEV waited ${MAX_STALLED_WAITS} times without meaningful recovery. Change the system or retry JEV.`
              : action.kind === 'wait'
                ? 'JEV chose to wait. No change was applied.'
                : 'The change could not be applied to the current system.';
        updateActivity(sequence, {
          status: blocked
            ? 'blocked'
            : action.kind === 'wait'
              ? 'waiting'
              : 'cancelled',
          detail,
          completedAt: Date.now(),
        });
        nextAt.current = Date.now() + 5000;
        if (blocked) {
          needIntervention(
            currentObservation,
            actionsFor(currentObservation, 'operator'),
            detail,
            true,
          );
        } else {
          setPhase('observing');
          setStatus(
            action.kind === 'wait'
              ? 'JEV chose to wait. Rechecking after traffic has run.'
              : 'The edit changed before it could be applied. Checking again.',
          );
        }
      }
    } catch (error) {
      if (sequence !== epoch.current) return;
      errorCount.current++;
      retryMessage.current = abort.signal.aborted
        ? 'JEV timed out'
        : error instanceof Error
          ? error.message
          : 'JEV could not respond';
      updateActivity(sequence, {
        status: failureStatus,
        detail: `${retryMessage.current}. No change was applied.`,
        completedAt: Date.now(),
      });
      nextAt.current =
        Date.now() + Math.min(30000, 5000 * 2 ** Math.min(3, errorCount.current - 1));
    } finally {
      clearTimeout(deadline);
      if (sequence === epoch.current) {
        activeAttempt.current = null;
        controller.current = null;
        setPending(false);
      }
    }
  }, [apply, sessionId, updateActivity, resetWaiting, needIntervention]);

  useEffect(() => {
    const tick = () => {
      const live = latest.current;
      const now = Date.now();
      attempts.current = attempts.current.filter(
        (item) => now - item.at < CALL_WINDOW_MS,
      );
      const available =
        now < serverCooldown.current
          ? 0
          : Math.max(0, CALL_LIMIT - attempts.current.length);
      setRemaining(available);
      if (!enabled.current) {
        setPhase('stopped');
        setStatus('JEV is stopped. You have the controls.');
        return;
      }
      if (live.challengeActive) {
        setPhase('paused');
        setStatus('JEV waits while you take the challenge.');
        return;
      }
      if (!live.running || document.hidden) {
        setPhase('paused');
        setStatus(
          document.hidden
            ? 'Watching paused while this tab is away.'
            : 'Simulation paused. JEV resumes with it.',
        );
        return;
      }
      if (connected.current !== true) {
        setPhase('offline');
        setStatus(
          connected.current === null
            ? 'Connecting JEV…'
            : 'JEV is offline. You can still break and edit the system.',
        );
        return;
      }
      if (!live.snapshot || !live.topology.nodes.length) {
        setPhase('watching');
        setStatus('Add components and connect them. JEV will watch the traffic.');
        return;
      }
      if (controller.current) return;
      const observation = observe(live.topology, live.snapshot);
      const repair = lastRepair.current;
      // Network budgets use wall time; recovery evidence must come from the
      // simulation. Slow rendering or a hidden tab cannot shorten this window.
      if (
        repair &&
        !repair.measured &&
        observation.system.timeMs - repair.appliedAtMs < SETTLE_MS
      ) {
        setPhase('recovering');
        setStatus('Measuring recovery as traffic passes through…');
        return;
      }
      const incident = incidentFor(observation);
      if (repair && !repair.measured && now >= nextAt.current) {
        repair.measured = true;
        updateActivity(repair.entryId, {
          status: incident ? 'unresolved' : 'healthy',
          after: { ...observation.system },
          completedAt: now,
          detail: incident
            ? `Traffic was measured after the change. ${incident.summary}.`
            : 'No faults or congestion detected in this measurement.',
        });
        if (!incident)
          setReceipt(
            repair.errorBefore >= 0.01
              ? `${repair.label} · errors ${(repair.errorBefore * 100).toFixed(0)}% → ${(observation.system.errorRate * 100).toFixed(0)}%`
              : `${repair.label} · system healthy`,
          );
      }
      if (!incident) {
        resetWaiting();
        setPhase('watching');
        setStatus('Change traffic or edit a component. JEV watches for trouble.');
        return;
      }
      const choices = actionsFor(observation, 'operator');
      if (intervention.current) {
        if (intervention.current.key === recoveryKey(observation, choices)) {
          setPhase('needs-help');
          setStatus(intervention.current.message);
          setCanRetry(intervention.current.retryable);
          return;
        }
        resetWaiting();
      }
      if (
        now >= nextAt.current &&
        !choices.some(
          (action) => action.kind !== 'wait' && action.kind !== 'unsupported',
        )
      ) {
        const locked = observation.nodes
          .filter(hasWriteContention)
          .map((node) => node.label);
        needIntervention(
          observation,
          choices,
          locked.length
            ? `${locked.join(', ')} has write-lock contention. More instances or slots won't fix it. This needs a change outside JEV's repair menu.`
            : 'Trouble remains, but no supported repair is available. Change the components, connections or settings to continue.',
          false,
        );
        return;
      }
      if (available <= 0) {
        const readyAt = Math.max(
          serverCooldown.current,
          attempts.current.length >= CALL_LIMIT
            ? attempts.current[0]!.at + CALL_WINDOW_MS
            : now,
        );
        setPhase('cooldown');
        setStatus(
          `JEV cooling down. Recovery resumes in ${Math.max(1, Math.ceil((readyAt - now) / 1000))}s.`,
        );
        return;
      }
      if (now < nextAt.current) {
        if (retryMessage.current) {
          setPhase('error');
          setStatus(
            `${retryMessage.current}. Retrying in ${Math.max(1, Math.ceil((nextAt.current - now) / 1000))}s.`,
          );
        } else {
          setPhase(lastRepair.current ? 'recovering' : 'observing');
          setStatus(
            lastRepair.current
              ? 'Checking whether the repair helped…'
              : waiting.current.count > 0
                ? `JEV chose to wait (${waiting.current.count}/${MAX_STALLED_WAITS}). Checking for progress…`
                : `Watching ${incident.summary}…`,
          );
        }
        return;
      }
      void request();
    };
    tick();
    const timer = window.setInterval(tick, 250);
    return () => clearInterval(timer);
  }, [request, updateActivity, resetWaiting, recoveryKey, needIntervention]);

  const target =
    props.topology.nodes.find(
      (node) => node.id === props.selectedNodeId && node.kind !== 'client',
    ) ??
    props.topology.nodes.find((node) => node.kind === 'db') ??
    props.topology.nodes.find((node) => node.kind !== 'client');
  const traffic = props.topology.nodes
    .filter((node) => node.kind === 'client')
    .reduce((sum, node) => sum + node.config.rps, 0);
  const disabled = props.challengeActive || !props.snapshot;
  const damage = (kind: 'crash' | 'slow' | 'traffic' | 'wreck') => {
    invalidate(500, 'New damage changed the system. This decision was not applied.');
    ownChange.current = false;
    interruptMeasurement('New damage interrupted measurement of this applied change.');
    resetWaiting();
    retryMessage.current = '';
    setReceipt('');
    if (kind === 'wreck') {
      for (const node of props.topology.nodes)
        if (node.kind !== 'client') props.onFailure(node.id, 'crash');
      if (traffic > 0) props.onTrafficChange(Math.min(10000, traffic * 4));
    } else if (kind === 'traffic') props.onTrafficChange(Math.min(10000, traffic * 2));
    else if (target) props.onFailure(target.id, kind);
  };

  return (
    <section
      ref={dock}
      className="operator-dock"
      aria-label="JEV automatic recovery"
      data-chrome="operator"
      data-armed={armed}
      data-pending={pending}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <div className="operator-heading">
        <span className="operator-watch">
          <i data-state={phase} aria-hidden="true" />
          JEV {armed ? (phase === 'needs-help' ? 'needs help' : 'on watch') : 'stopped'}
        </span>
        <span
          className="operator-budget num"
          data-testid="operator-budget"
          title="At most 18 attempted decisions per rolling minute. Healthy systems make no model calls; cooldown resumes automatically."
        >
          {CALL_LIMIT - remaining}/{CALL_LIMIT}
          <span className="operator-budget-label"> this minute</span>
        </span>
        <button
          type="button"
          className="btn btn-sm operator-toggle"
          data-testid={armed ? 'operator-stop' : 'operator-toggle'}
          onClick={() => {
            enabled.current = !enabled.current;
            setArmed(enabled.current);
            if (enabled.current) resetWaiting();
            invalidate(
              0,
              enabled.current
                ? 'JEV was restarted before this decision could be applied.'
                : 'JEV was stopped before this decision could be applied.',
            );
          }}
        >
          {armed ? 'Stop JEV' : 'Resume JEV'}
        </button>
      </div>
      <div className="operator-chaos-controls" aria-label="Break the system">
        <button
          type="button"
          className="btn btn-sm"
          data-testid="operator-break"
          disabled={disabled || !target}
          title={target ? `Crash ${target.label}` : 'Add a service first'}
          onClick={() => damage('crash')}
        >
          Crash
        </button>
        <button
          type="button"
          className="btn btn-sm"
          data-testid="operator-slow"
          disabled={disabled || !target}
          title={
            target ? `Make ${target.label} five times slower` : 'Add a service first'
          }
          onClick={() => damage('slow')}
        >
          Slowdown
        </button>
        <button
          type="button"
          className="btn btn-sm"
          data-testid="operator-traffic"
          disabled={disabled || traffic <= 0 || traffic >= 10000}
          onClick={() => damage('traffic')}
        >
          Load ×2
        </button>
        <button
          type="button"
          className="btn btn-sm operator-wreck"
          data-testid="operator-chaos"
          disabled={disabled || !target}
          title="Crash every service and quadruple traffic"
          onClick={() => damage('wreck')}
        >
          Wreck it
        </button>
      </div>
      <div className="operator-footer">
        <p
          className="operator-status"
          data-testid="operator-status"
          data-state={phase}
          role="status"
        >
          {status}
        </p>
        {phase === 'needs-help' && canRetry && (
          <button
            type="button"
            className="btn btn-sm"
            data-testid="operator-retry"
            onClick={() => {
              resetWaiting();
              invalidate(0, 'A fresh decision was requested.');
            }}
          >
            Retry JEV
          </button>
        )}
        {configured === false && (
          <button
            type="button"
            className="btn btn-sm"
            data-testid="operator-reconnect"
            onClick={() => {
              setConfigured(null);
              connected.current = null;
              setConnectionCheck((value) => value + 1);
            }}
          >
            Reconnect
          </button>
        )}
      </div>
      {receipt && (
        <p className="operator-receipt" data-testid="operator-receipt">
          {receipt}
        </p>
      )}
      <Activity entries={activity} />
    </section>
  );
}
