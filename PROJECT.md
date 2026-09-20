# breakscale-jev

breakscale-jev adds a JEV repair watcher to [Breakscale](https://github.com/xevrion/breakscale), created by xevrion and contributors. Breakscale supplies the manual editor, component catalog, examples, challenges, discrete-event simulation and engine tests. This fork adds incident shortcuts, bounded model decisions, repair measurements and visible action history.

## Product contract

The canvas is the main experience. Change traffic, crash or slow a component, or edit its settings while requests move through the system. JEV watches automatically when connected; Stop disarms it. Manual edits cancel stale answers but keep watch armed. Pausing, hiding the tab and entering challenges suspend decisions.

The watcher detects supported faults or congestion before asking for one finite repair. Healthy idling consumes no calls. After an applied repair it observes at least 2,400 milliseconds of actual simulated time before another repair or a recovery claim. Activity keeps the latest 50 attempts in page memory, separating diagnosis, selection, application and measured outcomes. Model confidence never substitutes for measured recovery.

Supported repairs clear injected faults, disable retries, add instances up to 128, increase eligible capacity up to 512, and restore supported service-time or error-probability settings to defaults. They cannot lower demand, rebuild topology or erase modeled database lock costs. Each configuration repair has a separate Undo entry.

The controller exposes intervention when no mutable repair is available, when JEV chooses the unsupported outcome, or after three waits without meaningful progress. Meaningful progress means at least a one-percentage-point error reduction or a goodput increase of at least one request per second or 5% of offered traffic, whichever is larger, without a demand decline above 10%. Retry JEV and reset retain the call budget.

## Pending recovery gap

Severe database write-lock delay can currently escape incident detection. A reproduced state had 40.9 seconds of lock delay, 2.25% errors, no queued requests and 4.23% database utilization, yet `incidentFor` classified it as healthy because the existing queue, error and utilization gates did not trip. A direct severe-lock incident guard is not implemented.

The existing `hasWriteContention` guard prevents adding database instances or slots when active shared write-lock delay exceeds service time, but it only prunes candidates after an incident has been detected. It does not fix this detection gap or make the underlying workload recoverable. Pending work is a real-engine regression, explicit severe-lock detection and truthful intervention when the finite repair menu cannot help. Do not mark this incident fixed or imply automatic recovery.

## Technical boundaries

Preserve all 30 `src/sim` files byte-for-byte against the upstream revision in UPSTREAM.md. Use React, TypeScript, Vite and the local Node server. The server pins `jev-1.13.0`, validates closed-set choices and finite probability distributions, and keeps credentials out of the browser. No hidden fallback model, arbitrary execution, model-written simulation code, database or cloud backend is part of this scope.

One request may be in flight, with eighteen attempted calls per rolling sixty-second window, bounded sessions and provider timeouts. The watcher resumes when the window permits it. These are local-demo controls, not public-service authentication. Retained typed-design modules support internal code and regression tests; there is no model architecture composer in the UI.

## Verification

Run `npm run check`, `npm run format:check` and `npm run test:browser`. Verify real engine effects as well as responsive layout, keyboard interaction, stale-answer cancellation, Activity and Undo. Browser inference is explicitly mocked. Opt-in live checks are separate and bounded; their results establish only the measured scenarios, not model superiority or recovery of arbitrary architectures.

The source is published as a GitHub fork of Breakscale. No hosted deployment is implied. Local drafts and historical QA receipts are not part of the fork's source distribution.
