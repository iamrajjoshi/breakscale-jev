# Contributing to Switchyard

Switchyard is a fork of [Breakscale](https://github.com/xevrion/breakscale) by xevrion and contributors. The canvas, simulator and teaching material come from that project. This fork adds a bounded JEV repair watcher and its local Node backend.

Send Switchyard bugs and pull requests to [iamrajjoshi/switchyard](https://github.com/iamrajjoshi/switchyard). Changes intended for the original simulator belong in [upstream Breakscale](https://github.com/xevrion/breakscale), following its contribution guide. An issue in one repository does not notify or assign work to the other project's maintainers.

Read [PROJECT.md](PROJECT.md), [AGENTS.md](AGENTS.md) and [UPSTREAM.md](UPSTREAM.md) before changing behavior. Small fixes can go directly to a pull request. Discuss larger changes first. This fork currently keeps the upstream simulation files unchanged; changing the engine requires a separate scope decision.

## Getting set up

Use Node 24 or newer and npm; `.node-version` records the development version. Fork Switchyard on GitHub, then clone your fork:

```sh
git clone https://github.com/YOUR-USERNAME/switchyard.git
cd switchyard
npm ci --ignore-scripts
npm run dev
```

The app runs at http://127.0.0.1:4176. The local server serves both the app and model API. Manual simulation works without a model credential; use `JEV_OFFLINE=1` for checks that must not load one. See README.md for opt-in JEV setup.

Use a feature branch based on this fork's default branch. The default is `raj--switchyard--jev-recovery`; CI also supports `main`. When contributing from a personal fork, keep a separate remote for Switchyard:

```sh
git remote add switchyard https://github.com/iamrajjoshi/switchyard.git
git fetch switchyard
git switch -c raj--switchyard--your-change switchyard/raj--switchyard--jev-recovery
```

Useful commands:

| Command                | What it does                                   |
| ---------------------- | ---------------------------------------------- |
| `npm run dev`          | Start the app and local API                    |
| `npm run check`        | Typecheck, lint, test and build                |
| `npm run format:check` | Check formatting without rewriting files       |
| `npm run test:browser` | Run Chromium interaction tests with mocked JEV |
| `npm test`             | Run unit and integration tests                 |

Format only files you changed, for example `npm exec -- prettier --write src/operator/About.tsx`.

## Local and CI checks

Run `npm run check`, `npm run format:check` and `npm run test:browser` before submitting. Default tests use mocked inference; real-model smoke checks are separate opt-in commands.

`npm ci --ignore-scripts` does not install Git hooks. The checked-in `.husky` scripts are optional and must not be assumed active. CI checks typechecking, lint and formatting on Linux, and tests and builds on Linux and Windows. Browser checks currently run separately from that workflow. A successful local run does not establish that every operating system or browser behaves identically.

## How the project is laid out

```
src/sim/         the simulation engine. No React, no DOM, no I/O
src/components/  canvas, inspector, metrics, palette
src/content/     glossary text
src/share/       share links: the wire format, encryption, the store client
src/operator/    JEV watcher, legal repairs and action history
server/          local API, model transport and credential loading
src/App.tsx      shell: layout, the animation loop, persistence
worker/          the Cloudflare Worker behind short share links
```

The important boundary is that `src/sim` knows nothing about the UI. It is a pure discrete-event
simulator you can drive from a script, which is what makes it testable.

### Sharing

This local fork uses fragment-based share links and does not enable upstream hosted sharing. The original `worker/` implementation remains in the repository as upstream source; it is not part of `npm run dev`, and no Cloudflare account is needed for local setup. Share tests use stubs rather than the hosted service.

## The one rule that matters most

**The numbers have to be true.**

This is a simulator people learn from. If a student watches p99 climb as utilisation passes 80
percent, that has to be because the simulation actually queued requests and measured their
latency, not because something approximated a curve that looks about right.

In practice that means:

- Latency percentiles come from measured request latencies, never from a mean times a constant.
- A component that has no meaningful value for a metric shows something else, or nothing. It does
  not show a plausible looking number.
- If you cannot verify a behaviour with a script that prints real output, it is not finished.

There is a lot of scaffolding in the repo for this. Look at how existing components are verified
before adding one.

## Adding a component

The following inherited notes describe Breakscale extension points. This fork keeps `src/sim` pinned; propose engine additions upstream or agree on a separate integration scope before applying these steps here.

Components live in a registry, so the event loop has no per-kind branching. Adding one means:

1. Add the kind to `NodeKind` in `src/sim/types.ts`.
2. Add any config fields it genuinely needs, each with a doc comment stating meaning and units.
3. Write a behaviour object in the matching `src/sim/behaviour-*.ts` file.
4. Add a `defaultConfig` entry and a label.
5. Give it a readout in `readoutFor` in `src/components/Canvas.tsx`. Show what an engineer would
   actually watch for that component. Never show a field that is structurally always zero for it.
6. Add a glossary entry in `src/content/glossary.ts` explaining what it is and why it matters.
7. Write a test that proves it behaves differently from everything else.

That last point is the real bar. A component that is just an existing one with different default
numbers should not be added; it makes the palette longer without teaching anything new.

## Adding a preset

Presets are the main teaching surface, so they get held to a standard:

- It must isolate **one** lesson, and the description should say what to watch.
- It must be stable at its default load, with an error rate under about two percent.
- It must visibly degrade at two to four times that load, and the bottleneck should be the one the
  lesson is about.
- No overlapping nodes. Check the current `NODE_W` and `NODE_H` and space accordingly.

Do the arithmetic before tuning by feel: a node's ceiling is
`capacity * instances * (1000 / serviceMs)` requests per second.

## Adding a vendor size

Vendor mode (`src/content/vendors/`) turns a published instance size, like `db.r6g.large`, into
simulator config. Two kinds of file are involved, and they are kept strictly apart:

- `aws.ts`, `gcp.ts`, `azure.ts` hold **published spec only**: vCPU, memory, network, price, each
  with the URL it came from and, for prices, the date it was read. Every field here must be a fact
  you can point at, not a guess.
- `derive.ts` holds the **one model** that turns a spec into engine knobs (`capacity` and
  `serviceMs`). It is the only place that mapping happens, and it makes one decision worth knowing
  before you touch it: it derives `capacity` from vCPU, and it refuses to touch `serviceMs` at all.
  A bigger machine does not make a query faster, it makes more queries run at once, so changing
  `serviceMs` when someone picks a larger instance would teach the opposite of what this simulator
  is for. `derive.test.ts` has the tests that pin that refusal down.

What this means for adding a new vendor size:

- Only add fields you can cite. If the vendor does not publish a number in readable text, leave the
  field out rather than estimate it, the same way the existing files leave `vcpu` off an Azure
  Managed Redis SKU that only states it inside an image. `derive.ts` already treats a missing vCPU
  as "nothing honest to say" and skips the size rather than inventing a slot count.
- A published `maxConnections` figure is a real ceiling, so where the vendor states one, `derive.ts`
  takes the smaller of it and the vCPU-based estimate (`Math.min`). It does not replace the vCPU
  estimate, it only caps it: if vCPU already implies fewer slots than `maxConnections`, vCPU still
  wins. Where the vendor does not state one, only `vcpu` feeds the estimate.
- Do not add a mapping from size to `serviceMs`. There isn't one, on purpose; see above.
- Follow the citation style already in `aws.ts`, `gcp.ts` and `azure.ts`: a `source` URL on every
  size, and a `pricedOn` date on every price.

## Writing for students

The audience is a first-year CS student who has not taken a queueing theory course.

- Plain language. "Requests waiting in line" beats `queueLimit`.
- Sentence case for labels.
- No abbreviations a beginner would not know, unless the glossary explains them.
- Explain why something matters, not only what it is. A metric someone cannot act on is trivia.
- No em dashes. Use a comma, a semicolon, or a second sentence.

## Design constraints

The interface follows a few rules that exist because breaking them made earlier versions look
generated rather than designed:

- No emoji in the interface.
- No glassmorphism, gradient text, or glowing shadows.
- Colour carries meaning. Component colours identify a kind; the status colours mean a metric is in
  trouble. Neither is decoration.
- Every number renders in the mono stack with tabular figures.
- Interactive transitions only, 120 to 200 milliseconds. No entrance animations on content.
- All colour comes from tokens in `src/index.css`. No hardcoded hex anywhere else.
- Text must meet WCAG AA contrast. Compute the ratio rather than eyeballing it.

## Pull requests

Keep each pull request to one logical change. Explain the problem and resulting behavior, include relevant verification, and add screenshots for visible changes. Measured simulator output should support claims about behavior; model confidence is not evidence of recovery.

Titles follow this fork's commit convention:

```text
:bug: fix[operator]: preserve watch after a manual edit
```

Use `:emoji: verb[area]: brief description`. The supported pairs are `:sparkles: feat`, `:bug: fix`, `:books: docs`, `:recycle: ref`, `:wrench: chore`, `:mag: nit`, `:test_tube: test`, `:zap: perf` and `:art: style`. The PR-title workflow checks this shape. Codex-assisted commits include a `Generated-by: Codex` trailer; do not invent coauthor identities.

Check results and review availability depend on this fork's GitHub settings. CI, CodeQL and the title workflow are configured in `.github/workflows`; this document does not promise a review time or a preview deployment. When fixing an in-progress commit, amend it in accordance with the repository's Git instructions, coordinating any history changes with collaborators.

## Reporting bugs

Include what you did, what you expected, and what happened. If it involves the simulation, the
preset name and the load you were running at are usually enough to reproduce it.

One thing worth knowing before reporting that the simulation has frozen: browsers suspend
animation frames in background tabs, so an unfocused tab genuinely stops simulating and every
number reads zero. Check the tab is focused first.

## Code of conduct

By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).
