# Implementation plan

The implementation follows the milestones below. See the [release checklist](release.md) for current verification results.

## Product scope

Incident Replay gives developers and on-call engineers a safe place to practice incident triage. At each checkpoint they can inspect the evidence available at that time, choose what to investigate, and compare their reasoning with SubQ Snap’s next diagnostic recommendation. A maintainer can run the same replay from a CLI and use labeled scenarios to measure decision quality.

The first release includes a local web app, a CLI, bundled synthetic scenarios, offline demo decisions, a live SubQ integration, and a reproducible benchmark. Start with the checkout incident and publish once the release checks pass. This is an investigation trainer. Its action catalog contains read-only steps such as inspecting database pool metrics. Live mode evaluates the bundled evidence with SubQ and presents the recommendation for a person to follow.

### User flow

1. Start the app from a GitHub clone and open the checkout scenario. The first checkpoint shows the alert and its timeline prefix.
2. Advance one checkpoint at a time or select a point directly. Use keyboard controls and filter events by source. Selecting a checkpoint loads local evidence and clears any recommendation from another checkpoint.
3. Choose a diagnostic action to record a prediction, then request the model recommendation. The decision panel shows the recommended next step, the linked supporting event where applicable, and the evaluation mode. When the model abstains, the panel shows which evidence to collect next. When the provider fails, it gives a recovery action.
4. Advance until the final checkpoint and reveal the debrief. Show what confirmed the diagnosis and which early assumptions the evidence could support at each step.

## Build sequence

| Milestone | Work | Acceptance criteria |
| --- | --- | --- |
| 1. Keyless vertical slice | Initialize the TypeScript project, pin Node and dependency versions, author `checkout-pool-pressure` with the display title **Checkout errors rising**, validate the scenario schema, implement the cutoff, and wire the demo CLI. | A fresh install can replay the three flagship checkpoints from the CLI with no key. The worker event is invisible before `availableAt`, then appears at the exact cutoff. The demo labels recorded decisions clearly and makes zero provider requests. |
| 2. SubQ decision service | Implement the typed request builder, provider transport, validation, abstention mapping, and operational errors. Wire the same CLI in live mode. Add mocked contract and failure tests. | The live CLI requires explicit opt-in. The tests cover key isolation, candidate validation, budgets, retries, and invalid responses. An operator runs one smoke test with a locally configured key and records validated response fields and usage. |
| 3. Interactive replay | Add the scenario list, timeline, diagnostic choices, recommendation and evidence panel, and debrief. Wire route handlers to the shared service. | A browser test walks the complete demo, opens the exact cited event, and reveals the debrief. A mocked live run tests explicit evaluation, loading, abstention, and failure recovery. Keyboard navigation, focus, and status announcements work through the flow. |
| 4. Benchmark and operations | Expand the labeled fixtures, freeze the release set, run the paired context evaluation and live product evaluation, and prepare the Docker runtime. | Publish results with denominators, configuration, cost, and limitations. An authenticated deployment test confirms the live route, request limits, health, and configuration behavior. Validate production logging and budget enforcement. |
| 5. GitHub release candidate | Verify the README from a clean clone, add the license and contribution and security guidance, run CI, and assemble the first release notes. | A new user can run the demo with no credentials and switch their own instance to live mode using only the README. Complete the [release checklist](release.md) before publishing. |

## Test priorities

- **Timeline and fixtures.** Cover duplicate IDs, invalid timestamps, stable ordering, late arrivals, exact cutoff boundaries, and unchanged requests when only future content or labels change.
- **Decision contract.** Cover candidate and evidence mapping, bounded context selection, malformed or incomplete answers, valid abstention, no-evidence fallback, provider status mappings, retry deadlines, and safe errors. Test abstention separately from provider failure.
- **Application boundaries.** Check the provider client never enters browser assets, demo stays offline, and a key in a live instance is absent from HTTP responses, logs, Docker layers, and CI artifacts. Verify origin validation and budget exhaustion before egress. Cover browser cancellation and stale response handling.
- **Release flows.** Smoke-test CLI and web in both modes, run production build and container checks, and compare measured evaluation results with the [evaluation gates](evaluation.md). Public CI uses only fixtures and mocks.

## Open decisions for implementation

- Confirm compatible, supported versions of Next.js, the schema validator, and test tooling when bootstrapping, then lock them and record the versions in CI. The design assumes Node.js 24 LTS, npm, and a single-process v1 deployment.
- Use the explicit abstain and evidence rules initially. Choose probability thresholds only if the development and held-out results support them. Record any change to the selection policy and rerun comparisons.
- Confirm the repository owner, public slug, and license at release preparation. The quickstart starts from a clone of the repository. The local project uses Apache-2.0 for code and original synthetic fixtures.

**Next step** — Configure a local SubQ key and record the live CLI and browser smoke checks before publication.
