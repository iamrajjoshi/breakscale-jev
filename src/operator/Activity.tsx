import { useState } from 'react';
import {
  ACTIVITY_LIMIT,
  type ActivityEntry,
  type ActivityStatus,
} from './activity-record';
import './Activity.css';

const statusLabels: Record<ActivityStatus, string> = {
  diagnosing: 'Diagnosing',
  measuring: 'Applied · awaiting measurement',
  healthy: 'Healthy',
  unresolved: 'Trouble remains',
  waiting: 'Waiting',
  cancelled: 'Not applied',
  failed: 'Failed',
  deferred: 'Deferred',
  interrupted: 'Measurement interrupted',
  blocked: 'Needs intervention',
};

const rateFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });
const percentFormat = new Intl.NumberFormat('en-US', {
  style: 'percent',
  maximumFractionDigits: 2,
});

function percent(value: number): string {
  return value > 0 && value < 0.0001 ? '<0.01%' : percentFormat.format(value);
}

function Timestamp({ value }: { value: number }) {
  const date = new Date(value);
  return (
    <time dateTime={date.toISOString()} title={date.toLocaleString()}>
      {date.toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
      })}
    </time>
  );
}

function ActivityRow({ entry }: { entry: ActivityEntry }) {
  const stages = [
    { label: 'Started', at: entry.startedAt },
    ...(entry.chosenAt === undefined
      ? []
      : [
          { label: entry.recording ? 'Recorded choice' : 'Chosen', at: entry.chosenAt },
        ]),
    ...(entry.appliedAt === undefined
      ? []
      : [{ label: 'Applied', at: entry.appliedAt }]),
    ...(entry.after && entry.completedAt !== undefined
      ? [{ label: 'Measured', at: entry.completedAt }]
      : []),
  ];
  const metrics = [
    {
      label: 'Errors',
      before: percent(entry.before.errorRate),
      after: entry.after ? percent(entry.after.errorRate) : undefined,
    },
    {
      label: 'Goodput',
      before: `${rateFormat.format(entry.before.goodputRps)} req/s`,
      after: entry.after
        ? `${rateFormat.format(entry.after.goodputRps)} req/s`
        : undefined,
    },
    {
      label: 'Offered traffic',
      before: `${rateFormat.format(entry.before.offeredRps)} req/s`,
      after: entry.after
        ? `${rateFormat.format(entry.after.offeredRps)} req/s`
        : undefined,
    },
  ];

  return (
    <li
      className="activity-entry"
      data-testid="operator-activity-entry"
      data-status={entry.status}
      data-source={entry.source ?? 'live'}
      data-applied={entry.appliedAt !== undefined}
    >
      <details className="activity-evidence">
        <summary className="activity-entry-summary">
          <span className="activity-timeline-mark" aria-hidden="true" />
          <span className="activity-entry-label">
            <span className="activity-action">{entry.action ?? entry.incident}</span>
            <span className="activity-status">
              {entry.recording ? 'Recorded JEV · ' : 'Live JEV · '}
              {entry.recording && entry.status === 'diagnosing'
                ? 'Replaying'
                : statusLabels[entry.status]}
            </span>
            <span className="activity-time">
              <Timestamp value={entry.startedAt} />
            </span>
          </span>
          <span className="activity-chevron" aria-hidden="true">
            ›
          </span>
        </summary>
        <div className="activity-evidence-body">
          {entry.recording && (
            <p className="activity-provenance">
              Saved choice: {entry.recording.title}. Recorded{' '}
              {entry.recording.recordedAt.slice(0, 10)} with {entry.recording.model}.
              Reused for matching settings; no live JEV call. Measurements below come
              from this simulation.
            </p>
          )}
          {entry.detail && <p className="activity-detail">{entry.detail}</p>}
          <ol className="activity-stages" aria-label="Recorded stages">
            {stages.map((stage) => (
              <li key={stage.label}>
                <span>{stage.label}</span>
                <Timestamp value={stage.at} />
              </li>
            ))}
          </ol>
          <p className="activity-sample-label">
            {entry.appliedAt !== undefined
              ? entry.after
                ? 'Before change → later observation'
                : 'Before change'
              : 'At decision start'}
          </p>
          <dl className="activity-metrics">
            {metrics.map((metric) => (
              <div key={metric.label}>
                <dt>{metric.label}</dt>
                <dd>
                  {metric.before}
                  {metric.after !== undefined && <> → {metric.after}</>}
                </dd>
              </div>
            ))}
          </dl>
          <p className="activity-sample-interval">
            Simulation samples: {rateFormat.format(entry.before.timeMs / 1000)}s
            {entry.after && (
              <>
                {' '}
                → {rateFormat.format(entry.after.timeMs / 1000)}s (
                {rateFormat.format((entry.after.timeMs - entry.before.timeMs) / 1000)}s)
              </>
            )}
          </p>
        </div>
      </details>
    </li>
  );
}

export function Activity({
  entries,
  source,
}: {
  entries: ActivityEntry[];
  source: 'recorded' | 'live';
}) {
  const [open, setOpen] = useState(true);

  return (
    <details
      className="operator-activity"
      data-testid="operator-activity"
      open={open}
      onToggle={(event) => {
        if (event.target === event.currentTarget) setOpen(event.currentTarget.open);
      }}
    >
      <summary
        className="activity-toggle"
        data-testid="operator-activity-toggle"
        aria-expanded={open}
      >
        <span>
          Activity <span className="activity-count">({entries.length})</span>
        </span>
        <span className="activity-chevron" aria-hidden="true">
          ›
        </span>
      </summary>
      <div
        className="activity-scroll"
        role="region"
        aria-label="JEV action history"
        tabIndex={0}
      >
        {entries.length === 0 ? (
          <p className="activity-empty">
            {source === 'recorded'
              ? 'No repairs yet. Load a demo or inject a fault.'
              : 'No repairs yet. Decisions will appear here.'}
          </p>
        ) : (
          <ol className="activity-list">
            {entries.map((entry) => (
              <ActivityRow key={entry.id} entry={entry} />
            ))}
          </ol>
        )}
        {entries.length > 0 && (
          <p className="activity-retention">
            Latest {ACTIVITY_LIMIT} attempts in this session.
          </p>
        )}
      </div>
    </details>
  );
}
