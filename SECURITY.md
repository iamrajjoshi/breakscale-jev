# Security

Switchyard is a fork of Breakscale with an added local Node server and JEV integration. The simulator runs in the browser, but the application is not entirely browser-only and model use sends data outside the machine.

## Data and service boundaries

The Node server binds to loopback by default. It loads the TypeSafe credential server-side from `TYPESAFE_API_KEY` or the configured local credential file. When JEV is enabled, requests to `https://api.typesafe.ai/v1/systemone` include simulated component state, topology, settings, measurements and candidate actions. The retained design API can also send supplied instructions when invoked. Component labels or other supplied content may therefore reach the provider; do not assume a design stays on the device while using JEV.

Manual simulation works without a model key. `JEV_OFFLINE=1` returns before credential loading and disables model access. Credentials must not enter browser bundles, `VITE_` variables, committed files or public reports.

Saved designs live in browser storage or exported files. This local fork uses fragment-based share links and does not enable upstream hosted sharing or analytics. The upstream share-worker source is retained, but is not run by the local development command.

Request validation, origin checks, bounded model calls and server-side credentials reduce specific risks; they do not make this an authenticated public service. Public hosting needs its own security review. Untrusted imports, shared designs, UI content, dependency behavior and the local API remain relevant attack surfaces.

## Reporting an issue

Report Switchyard-specific vulnerabilities to this fork's maintainer, @iamrajjoshi. Use the private reporting option in [this repository's Security tab](https://github.com/iamrajjoshi/switchyard/security) if it is enabled. If no private channel is listed, ask the maintainer for one without posting exploit details, credentials or sensitive data in a public issue. No response time is guaranteed.

For a problem affecting unmodified Breakscale, follow [upstream's security policy](https://github.com/xevrion/breakscale/security/policy). Include the affected revision, a reproducible description, expected and actual behavior, and the impact. Redact model credentials and personal data, and verify automated scanner findings before reporting them.
