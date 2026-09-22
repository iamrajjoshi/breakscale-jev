# breakscale-jev

breakscale-jev adds automatic JEV repair to [Breakscale](https://github.com/xevrion/breakscale), the system-design simulator by xevrion and contributors. Breakscale provides the editable canvas, 33 component types, examples, challenges and discrete-event engine. Its original history, authorship and MIT license are preserved in this fork.

Turn up traffic, crash a service, slow a database or change its settings. **Recorded JEV is the default:** play with real saved model choices without an API key or a backend. Code reuses a choice only for matching settings, applies it to the current system, and measures fresh traffic. Choose **Live JEV** to request new decisions through the local server.

## Run locally

Use Node 24 or newer (the development version is recorded in `.node-version`) and npm:

```sh
npm ci --ignore-scripts
npm run dev
```

Open http://127.0.0.1:4176. `PORT` selects another local port. For production assets, run `npm run build` then `npm start`. The same Node process serves the app and model API, bound to loopback.

For Live JEV, set `TYPESAFE_API_KEY` in the server environment or `~/.config/jev-research/credentials.env`, then select Live JEV in the repair bar. Keep the key out of browser code and `VITE_` variables. `JEV_OFFLINE=1` disables credential loading and model access for local checks.

## Play

Start with **Crash** or **Slowdown**, or open **Recorded runs** to load a captured incident. The six setups cover a database crash, injected slowdown, a slow API configuration, database errors, 200 requests/second, and a combined crash/load incident. Loading a setup is undoable. You can move and rename components, apply damage again, change settings, pause, and inspect the results.

Recordings are a finite library, not a local model. The current topology, component settings, load, faults and legal action must match a capture. Different settings can show “No recorded repair matches”; the canvas remains editable. Activity labels every reused choice as **Recorded JEV**, with its capture date, and shows measurements from your current simulation. It never substitutes historical metrics for a current result. An 800ms presentation step lets you interrupt the replay; it is not inference latency. See [recording provenance](docs/recordings.md).

Recorded mode makes no health, decision or TypeSafe requests and does not consume the live call budget. A built `dist/` can be served by any static host for this mode. Live JEV requires the API server and is selected explicitly; provider failures do not silently switch sources. Stop or resume either mode from the repair bar. Healthy idling makes no model calls.

Each decision selects one typed action. After applying it, the watcher observes at least 2,400 milliseconds of actual simulated time before another repair or a recovery claim. Open Activity to inspect the chosen action, whether it was applied, and the measured result. The latest 50 attempts stay in memory until the page reloads.

Manual edits invalidate pending answers while keeping watch armed. Pausing the simulation, hiding the tab or entering a challenge suspends decisions. Configuration repairs have separate Undo entries. Resetting the simulation does not refill the call budget.

## Repair boundaries

The finite repair menu can clear injected faults, disable retries, add instances up to 128, increase eligible capacity up to 512, and restore supported service-time or error-probability settings to their component defaults. Service-time restoration requires a value above twice the default. Error-probability restoration follows the Inspector fields for services, databases, workers, object stores, serverless functions and transcoders.

JEV cannot lower incoming demand, rebuild missing topology or repair every architecture. A selected action is not proof of recovery. Breakscale computes the requests, queues, errors, latency and throughput; TypeScript owns the arithmetic and state changes. Active shared database write-lock delays above service time and at least one second are detected even when queues, utilization and error rate stay low. If the finite controls cannot help, the watcher reports intervention instead of claiming recovery. It does not erase the lock cost or change the workload.

The server pins `jev-1.13.0` through TypeSafe's Choice endpoint and validates both the returned choice and probability distribution. It permits one request in flight and eighteen attempted calls per rolling sixty-second window, with bounded sessions and provider timeouts. The watcher can resume after throttling. These limits support a local demo; they do not provide an authenticated public hosting service.

## Verify

```sh
npm run check
npm run format:check
npm run test:browser
npm run test:recordings
```

`check` runs typechecking, lint, unit/integration tests and a production build. Browser tests use an isolated server on port 4186, the checked-in recorded corpus, and explicitly mocked live JEV responses to check real simulation interactions, cancellation, Undo, responsive layouts and keyboard controls. The inherited engine tests remain intact. `test:recordings` builds the app and runs the no-key browser suite against a static server with no model backend.

`npm run record:repairs` is a separate opt-in capture command, capped at fourteen real calls; it writes private full receipts outside the repository and a sanitized corpus for the app. It never runs in CI.

`npm run test:live:recovery` is a separate opt-in check requiring a running server and real credential. It attempts at most fourteen calls, applying real choices to seeded engines for crash/load, capacity/service-time and error-probability scenarios. It does not drive the browser. `npm run test:live` retains a smaller direct-action smoke check. Neither runs in the default suite or establishes superiority over another controller.

## Source map

- `src/sim/`: unchanged upstream simulation and tests.
- `src/App.tsx`, `src/components/`: manual editor, canvas and app integration.
- `src/operator/`: observations, finite repairs, watcher, Activity and incident controls.
- `src/designer/`: typed-edit internals and Inspector metadata; no model design-command UI.
- `server/`: local HTTP boundary, credential loading and bounded inference.
- `tests/browser/`: Chromium interaction tests with mocked inference.

See [PROJECT.md](PROJECT.md) for scope and pending work, [UPSTREAM.md](UPSTREAM.md) for attribution, and [AGENTS.md](AGENTS.md) for contributor checks. Breakscale's MIT copyright notice and Caveat's separate font license remain included.
