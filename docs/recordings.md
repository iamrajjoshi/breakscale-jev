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

The seven-node web app adds ten mutable choices across five scenarios: database
crash/slowdown, API 1 crash/slowdown, and a full outage at 150 requests/second.
The full outage clears six faults in order: balancer, database, cache, then APIs
1, 2 and 3. Twelve new calls produced these ten repairs and two `unsupported`
responses for 300 requests/second (cold-start and warm-load trajectories).
Those two responses are retained privately, and no scaling repair is exported.
Seven further calls captured the remaining individual faults: balancer crash/slowdown, API 2 crash/slowdown, API 3 slowdown, and cache crash/slowdown. All seven chose the corresponding repair. Together with the final API 3 repair from the full outage, every backend component has an individual crash and slowdown match at the original starter settings. The combined library has twenty-five choices across eighteen playable scenarios, from twenty-eight calls including the three unsupported results.

The original additional 400-request-per-second case returned `unsupported`, with 0.29
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

Injected faults match by type, not by a captured slowdown multiplier. The saved
action clears that fault; it does not predict the current delay or recovery time.
The browser applies fivefold slowdowns and measures its own traffic afterward.

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
npx tsx scripts/record-repairs.ts --starter --live --output /private/starter-captures
npx tsx scripts/record-repairs.ts --starter-components --live --output /private/component-captures
npx vitest run src/operator/recordings.test.ts
```

The `--starter` variant is capped at twelve attempts and exports only the new
starter scenarios; merge reviewed captures with the existing corpus rather than
overwriting it. `--starter-load` is a one-attempt warm-load diagnostic and can
produce no mutable recording. `--starter-components` captures the seven additional single-fault cases with a seven-attempt cap. None of these variants runs in CI.

The tests re-run recorded decisions against the unchanged upstream engine at
multiple random seeds, check complete distributions and legal actions, and reject
unrecorded topology, traffic, configuration and contention cases. Public browser
tests check actual interactions with model endpoints unavailable.
