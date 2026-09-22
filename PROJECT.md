# breakscale-jev

breakscale-jev adds a JEV repair watcher to [Breakscale](https://github.com/xevrion/breakscale), created by xevrion and contributors. Breakscale supplies the manual editor, component catalog, examples, challenges, discrete-event simulation and engine tests. This fork adds incident shortcuts, bounded model decisions, repair measurements and visible action history.

## Product contract

The canvas is the main experience. Change traffic, crash or slow a component, or edit its settings while requests move through the system. Recorded JEV is the no-key default; Live JEV watches when explicitly selected and connected. Stop disarms either mode. Manual edits cancel stale answers but keep watch armed. Pausing, hiding the tab and entering challenges suspend decisions.

The watcher detects supported faults or congestion before asking for one finite repair. Healthy idling consumes no calls. After an applied repair it observes at least 2,400 milliseconds of actual simulated time before another repair or a recovery claim. Activity keeps the latest 50 attempts in page memory, separating diagnosis, selection, application and measured outcomes. Model confidence never substitutes for measured recovery.

Supported repairs clear injected faults, disable retries, add instances up to 128, increase eligible capacity up to 512, and restore supported service-time or error-probability settings to defaults. They cannot lower demand, rebuild topology or erase modeled database lock costs. Each configuration repair has a separate Undo entry.

The controller exposes intervention when no mutable repair is available, when JEV chooses the unsupported outcome, or after three waits without meaningful progress. Meaningful progress means at least a one-percentage-point error reduction or a goodput increase of at least one request per second or 5% of offered traffic, whichever is larger, without a demand decline above 10%. Retry JEV and reset retain the call budget.

## Recorded play

The no-key mode ships twenty-five real JEV choices across eighteen captured setups. It reuses decisions only for matching topology/configuration, demand, faults and currently legal actions; names and canvas positions can change. No live diagnosis is implied. The running engine supplies every displayed before/after measurement. Unmatched incidents remain editable and show an explicit no-recording outcome. Recorded mode never contacts the model or health API, and never spends/refills the live call budget. A source change, edit, pause or scenario load cancels stale answers. Loading a setup creates one Undo entry.

The playground keeps the live graph prominent, with a separate repair/history rail on wide screens and a compact expandable drawer on smaller screens. The header uses a lowercase route-shaped b mark and the product name, without a slogan. Recovery groups the Recorded/Live source controls, fault actions, status, outage demo and history. Source controls are native radios with visible keyboard focus; API-key and budget information sits below them in regular text. The component catalog starts closed for new visitors; saved desktop layout choices remain respected. Use quiet neutral surfaces, the existing system font and component colors, and support both light and dark preferences. Stop and the source controls remain accessible. Extra scenes and history live together in the drawer on small screens. Activity always shows whether a choice was recorded or live.

New visitors start with a seven-node web app at 150 requests/second: visitors, load balancer, three parallel API servers, shared cache and database. Load outage demo loads its six backend faults through the same cancellable, undoable scenario path. Load web app restores the healthy starter with fault-aware Undo. Manual controls still act on the current canvas. Showing more history must not trigger model calls, alter the simulator or steal a camera position the visitor deliberately chose. Drawer controls support keyboard dismissal and focus return.

Fresh starters and explicitly loaded recorded setups use a vertical layout without teaching notes on phones and tall desktop canvases; the web app retains its three parallel API branches. Wide canvases retain the horizontal layout. Primary node readings stay visible at medium zoom; the overview supports pinch and button zoom before editing. Saved designs retain their positions and annotations. Palette placement avoids existing nodes and note hit areas so new components remain clickable. A visible canvas hint explains manual editing, and the Inspector provides a connection delete button for touch users.

## Shared-lock intervention

Severe database write-lock delay is detected after warmup when writes are occurring, lock wait exceeds service time, and lock wait is at least one second. A real-engine regression covers low errors, no queued requests and low database utilization despite over 50 seconds of lock delay. Existing fault/error/overload detection keeps its priority.

The contention guard prunes ineffective database growth; it does not repair the shared lock. When no mutable action remains, the controller reports intervention. Recorded matching refuses active write contention. Neither mode may claim the underlying workload is recoverable merely because this incident is now detected.

## Technical boundaries

Preserve all 30 `src/sim` files byte-for-byte against the upstream revision in UPSTREAM.md. Use React, TypeScript, Vite and the local Node server. The server pins `jev-1.13.0`, validates closed-set choices and finite probability distributions, and keeps credentials out of the browser. No hidden fallback model, arbitrary execution, model-written simulation code, database or cloud backend is part of this scope. The no-key recorded experience can run from static assets alone.

One request may be in flight, with eighteen attempted calls per rolling sixty-second window, bounded sessions and provider timeouts. The watcher resumes when the window permits it. These are local-demo controls, not public-service authentication. Retained typed-design modules support internal code and regression tests; there is no model architecture composer in the UI.

## Verification

Run `npm run check`, `npm run format:check` and `npm run test:browser`. Verify real engine effects as well as responsive layout, keyboard interaction, stale-answer cancellation, Activity and Undo. Browser inference is explicitly mocked. Opt-in live checks are separate and bounded; their results establish only the measured scenarios, not model superiority or recovery of arbitrary architectures.

The source is published as a GitHub fork of Breakscale. No hosted deployment is implied. Local drafts and historical QA receipts are not part of the fork's source distribution.
