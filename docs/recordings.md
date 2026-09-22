# Recorded repairs

Recorded mode runs the real Breakscale simulation locally and reuses a small
library of actual JEV choices. It makes no model requests and needs no API key.
The simulation keeps responding to traffic, faults, edits, pause and Undo. Its
current metrics and recovery measurements are never played back from a recording.

The initial library was captured on 2026-09-21 using `jev-1.13.0`. Nine model
requests yielded eight mutable decisions across six playable scenarios: a crashed
database, a slowed database, an API service-time edit to 500ms, database error
probability at 50%, 200 requests per second, and two crashes during that traffic
surge. The last scenario takes three choices. Each public entry includes the
original observation, full topology settings, selected action, provider
distribution, timestamp and SHA-256 hashes of the provider request and response.
Raw capture receipts remain outside the public source tree.

One additional 400-request-per-second case returned `unsupported`, with 0.29
probability on that option. That result is retained in the private capture, but
there is no mutable recording for it. These examples are an integration demo,
not a success-rate benchmark or evidence that recorded mode can repair arbitrary
architectures.

## Matching and limits

A recording can run only when all simulation settings and connections match its
captured topology, the fault pattern matches, the current engine detects an
incident, and the same repair is currently legal. Node names, IDs and canvas
positions may change without changing the matched system. Unrecorded demand,
write mix, timeout, queue, edge, or component changes do not receive a guessed
repair. Active database write contention also refuses a match. Changes to the
system while a choice is pending still cancel its application.

The API accepts the full topology because an operator observation omits settings
such as database write mix and link latency. Checking just the visible fault or
node kind would incorrectly treat unrelated systems as recorded examples.

The original probability belongs to the original model call. It is not confidence
in the current outcome. Current simulated traffic must settle and be measured
after each applied action before the interface can report a recovery.

## Capture workflow

The opt-in script reuses the production JEV adapter, including pinned model and
closed-choice validation. It permits at most fourteen attempts, has no automatic
retries, and writes every response and unsuccessful attempt into a private output
directory. It exports a sanitized `recordings.json` alongside the raw receipt for
review before copying it into `src/operator/recordings.json`.

```sh
npx tsx scripts/record-repairs.ts --live --output /private/directory/outside-this-repo
npx vitest run src/operator/recordings.test.ts
```

The tests re-run recorded decisions against the unchanged upstream engine at
multiple random seeds, check complete distributions and legal actions, and reject
unrecorded topology, traffic, configuration and contention cases. Public browser
tests check actual interactions with model endpoints unavailable.
