# breakscale-jev agent guide

breakscale-jev is a fork of Breakscale by xevrion and contributors, with a bounded JEV repair watcher. Read PROJECT.md and UPSTREAM.md first. Credit the upstream canvas, simulator, examples and tests separately from this fork's additions.

## Map and commands

`src/sim` contains the upstream engine; preserve all 30 files byte-for-byte. `src/App.tsx` and `src/components` own the manual canvas. `src/operator/contracts.ts` builds observations and legal candidates; `Operator.tsx` owns watch, requests, cancellation and status. `src/designer` retains typed-edit internals and Inspector metadata. `server` owns credentials, session limits and TypeSafe transport.

Use Node 24+ and npm with the checked-in lockfile. `.node-version` records the development version.

```sh
npm ci --ignore-scripts
npm run dev
npm run check
npm run format:check
npm run test:browser
```

The app uses port 4176 and browser tests use 4186. `npm start` serves the built app. Default tests mock transport; set `JEV_OFFLINE=1` for credential-free checks. `npm run test:live:recovery` is a separate opt-in real-model check capped at fourteen attempts. Use Prettier and Oxlint; format only touched files.

## Invariants

- Keep credentials server-side. Never print, commit or place `TYPESAFE_API_KEY` in browser code. Preserve offline mode's early return before credential loading.
- Pin `jev-1.13.0`, validate finite distributions and offered choices, and add no hidden retries or fallback model. JEV selects; TypeScript executes; Breakscale measures.
- Healthy watch consumes no model calls. Manual edits cancel stale answers without disarming watch. Pause, hidden tabs and challenges suspend decisions; Stop disarms watch.
- Preserve one in-flight call, eighteen attempts per rolling sixty-second window, bounded retained sessions and provider timeout. Reset and Retry JEV must not refill the budget.
- Require at least 2,400 milliseconds of actual simulated time after a repair before another repair or a recovery claim. Keep each configuration repair as a separate Undo entry.
- Respect the finite repair catalog. Do not lower demand, erase modeled lock costs, fabricate results or claim to repair missing topology. Preserve the three-stalled-wait guard and explicit intervention outcomes.
- Preserve upstream licenses, manual editing and challenge restrictions. Add no database, cloud backend, arbitrary tool execution or model-written simulation code.

Database write-lock contention is shared across instances. The existing contention guard prunes ineffective database growth after an incident is detected; it does not detect every severe lock incident. Keep the pending detection gap in PROJECT.md explicit until a regression reproduces it and a fix passes.

Keep the canvas primary and the repair bar visible. Verify engine state changes, repeated damage, cancellation, Undo, keyboard focus and narrow layouts. An Activity entry must distinguish chosen, applied and measured states. Do not treat model confidence as measured recovery, or a live smoke as a controller benchmark.

Commit messages use `:emoji: verb[area]: brief description` with a `Generated-by: Codex` trailer for Codex-assisted commits. Keep local drafts, model receipts, budget logs and machine-specific QA artifacts outside the source repository. Publishing code, a deployment or an article requires the applicable task authorization; this guide grants none.
