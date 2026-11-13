# Architecture

## Deployment model

Use one TypeScript repository on Node.js 24 LTS. Run a Next.js App Router web app and a CLI from the same checkout. Use the Node runtime for provider requests. Keep scenarios, recorded demo decisions, and action descriptions in versioned files. A single server process can run demo or live mode. Ship a Docker image for that same process with runtime configuration. [Node.js releases](https://nodejs.org/en/about/previous-releases) · [Next.js self-hosting](https://nextjs.org/docs/app/guides/self-hosting)

Bind local development and production quickstarts to loopback. Publish Docker’s host port on `127.0.0.1` by default. For shared use, put the instance behind an authenticated TLS reverse proxy and prevent direct access to the app port. Public demos run in demo mode. A live instance uses the operator’s key for every authorized user of that instance. Bundled synthetic scenarios are always available. A private instance can opt into a host-side incident directory and enable imported evidence evaluation separately.

## Request flow

1. The investigator selects a scenario and checkpoint. The client sends scenario and checkpoint IDs to the server, which resolves them against the bundled manifest. The server controls the available replay prefix. The CLI resolves the same IDs locally.
2. The decision service builds state from the current observation and available events, including the action catalog, event labels, and only runbook entries available at that time. It uses a fixture decision in demo mode or calls SubQ on explicit request in live mode.
3. The service validates both selected IDs and the probability distributions against the input snapshot. It maps the action ID to reviewed diagnostic copy and the supporting event ID to the source record. When the policy abstains, it renders a scenario-specific evidence-gathering step. Return an operational error and recovery guidance when a call fails.
4. The UI renders the decision, input coverage, and supporting event with a mode label. The CLI can emit the same result as text or JSON. The evaluation harness can additionally record the raw score distribution and measured usage for analysis.

## Data contracts

| Record | Required fields and behavior |
| --- | --- |
| Scenario | `schemaVersion`, `id`, `version`, title, neutral briefing, action catalog, evidence-gathering fallback, checkpoints and events. Use stable lowercase IDs. Keep title and briefing free of outcome hints. |
| Event | `id`, `occurredAt`, `availableAt`, `source`, `kind`, and `text`. Timestamps are UTC ISO 8601. Require `availableAt >= occurredAt` and unique IDs. Treat log and runbook text as untrusted content. |
| Checkpoint | `id`, `cutoffAt`, and a current observation event ID that must already be available. Server returns only events with `availableAt <= cutoffAt`. Sort by `availableAt`, then by stable event ID. |
| Action | Stable `id`, label, criteria describing when the action applies, and reviewed read-only instructions. Reserve `insufficient_evidence` for abstention and `no_evidence` for supporting evidence. |
| Demo result | Scenario version, checkpoint ID, decision policy version, and recorded decision. Version alongside the scenario. Validate against the same eligible action and evidence IDs at load time. |
| Evaluation labels | Acceptable actions, evidence IDs, and rationale by checkpoint, in a separate file read by evaluation tooling. Training debrief content lives separately and is delivered through an explicit reveal action. |
| App result | `mode`, scenario and checkpoint IDs, scenario version, decision policy version, decision status, action ID, optional evidence event ID, available and submitted event counts, and whether input was reduced. Include model ID, measured duration, usage and estimated cost where available. |

Validate fixtures and external boundaries at runtime with schemas. The browser has no input for cutoff timestamps, arbitrary evidence, remote URLs, file uploads, API keys, provider models, or credentials. Use neutral public scenario metadata and checkpoint labels. Keep future event records, hint-bearing fixture IDs, and debriefs out of earlier checkpoint responses and browser bundles. The offline demo can run without internet access once dependencies are installed. Bundle UI assets locally, disable framework telemetry in the documented workflows, and verify offline behavior with egress blocked. [Next.js telemetry](https://nextjs.org/telemetry)

## Web and CLI interfaces

- `GET /api/scenarios` returns public scenario and checkpoint metadata with neutral labels such as **Checkpoint 1**. If internal fixture IDs reveal the diagnosis, expose a separate neutral lookup ID in the web interface. `GET /api/scenarios/:id/checkpoints/:checkpointId` returns the timeline available through that checkpoint. The user explicitly requests the debrief after finishing.
- `POST /api/decisions` accepts JSON `{ "scenarioId": "checkout-01", "checkpointId": "checkpoint-1" }`. It selects the configured mode on the server. Validate IDs, reject unknown fields, cap body size at 4 KiB before parsing, enforce the exact configured browser origin for this endpoint, and return `Cache-Control: no-store` on responses. Apply live concurrency and budget checks before contacting SubQ. Timeline scrubbing only loads local fixture data.
- `GET /api/health` reports process readiness and whether scenario data loaded. Keep it independent of provider health and omit secrets. Treat invalid startup configuration as a local configuration failure with instructions to fix it.
- `npm run replay -- --scenario checkout-pool-pressure --checkpoint initial-alert --mode demo` exercises the shared path. The CLI defaults to demo and accepts `--json`. A live request requires both `--mode live` and `INCIDENT_REPLAY_MODE=live`. Exit successfully for completed decisions, including abstentions, and use documented nonzero codes for input, configuration, and provider failures.

## Private incident library

The CLI normalizes local exports into versioned case files. The server loads a configured library at startup and uses the same replay engine to calculate checkpoints. Bundled demos stay separate from imported cases. An imported case has no recorded answers or debrief. Live evaluation requires `INCIDENT_REPLAY_ALLOW_IMPORTED_SUBQ=true` on a live host with a configured import directory and a per-request `allowImportedEvidence: true` acknowledgement. Acknowledgement cannot enable live evaluation on its own. The case directory is excluded from builds and Git by default. See the [import guide](importing-incidents.md) for deployment boundaries and supported sources.

## Context construction and abstention

Resolve the cutoff before any context selection. Exclude every event unavailable at that cutoff. Keep the observation and apply a deterministic budget to the remaining events, preferring the most recently available events, then serialize the included events in chronological availability order. The live request includes up to 128 event IDs and `no_evidence`, a conservative estimate of up to 200K total input tokens including questions, and at most 1 MiB of UTF-8 JSON. If the fixed portion cannot fit, report a local request error. Show how many available events were submitted. Version this selection policy so evaluation runs are reproducible. [SubQ Decisions API](https://docs.subq.ai/endpoints/decisions-api/)

Offer `insufficient_evidence` as a first-class action. Require a valid supporting event to surface a concrete recommendation. A low top probability or narrow margin can also trigger abstention when thresholds are supported by development data. Keep threshold selection and quality measurement separate. A support ID proves the source record exists in the submitted prefix. Its relevance remains an evaluation question. See [evaluation.md](evaluation.md).

## Runtime configuration and failure handling

| Variable | Default | Purpose |
| --- | --- | --- |
| `INCIDENT_REPLAY_MODE` | `demo` | `live` enables the server’s live evaluation endpoint and permits explicit CLI live runs. |
| `SUBQ_API_KEY` | Empty | Required in live mode. Read through a shared server and CLI configuration loader. Use `.env.local` locally and runtime secrets in deployments. Shell environment takes precedence. |
| `INCIDENT_REPLAY_ORIGIN` | `http://localhost:3000` | Exact browser origin for the decision endpoint. Set the public HTTPS origin for an authenticated deployment. |
| `INCIDENT_REPLAY_DAILY_ATTEMPTS` | `100` | Provider attempt budget per web process per UTC day, including retries. |
| `INCIDENT_REPLAY_MAX_IN_FLIGHT` | `2` | Maximum simultaneous live browser evaluations per web process. |

Keep the provider URL and model pinned by the integration. Read the key at runtime and keep the provider adapter out of client bundles. Accept runtime secrets only on the host or at container start. Reject unexpected redirects. The proxy must authenticate users, enforce a request rate limit, and control direct access. Local in-memory counters reset at restart and coordinate within one process. Use a shared limit store before running multiple live replicas with a shared budget. CLI runs use the operator’s explicit invocation. The live benchmark additionally enforces a separate run-level request and estimated spend limit. [Next.js environment variables](https://nextjs.org/docs/app/guides/environment-variables) · [SubQ authentication](https://docs.subq.ai/using-the-api/authentication/)

Reserve an attempt before each upstream request. Allow at most one bounded retry on an explicit `429` or transient `5xx`, using `Retry-After` when present and applying jitter within the time budget. Use a 10-second per-attempt deadline and a 25-second total ceiling. An ambiguous timeout or connection loss returns a retryable message for the operator without automatically resending. When the provider is unavailable, the timeline stays usable and the user may explicitly switch to demo by configuring a demo instance. [SubQ integration](subq-integration.md)

Emit structured diagnostics with request ID, fixture and checkpoint IDs, model ID, result code, attempt count, duration, and token usage where present. Keep raw payloads, headers, credentials, raw provider errors, and source text out of logs and traces. The server sends only validated result fields to the client. Keep health checks keyless. Support cancellation, release in-flight slots on every exit path, and prevent a stale response from overwriting a newer checkpoint in the UI.

## Repository layout

```text
src/app/                Replay UI and HTTP routes
src/server/             HTTP validation, runtime configuration and private case loading
src/import/             Offline evidence import and normalization
src/replay/             Fixture validation, timeline and decision policy
src/subq/               Node-only transport and provider schemas
src/cli/                Replay command and formatting
scenarios/              Bundled scenarios, demo decisions and debriefs
eval/                   Labeled checkpoints, baseline inputs and evaluation runner
tests/                  Unit, contract, integration and browser checks
docs/                   Design and release resources
```

**Next step** — Run one live CLI check with a locally configured key before testing a shared deployment.
