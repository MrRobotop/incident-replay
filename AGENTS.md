# Incident Replay build instructions

Act like a senior AI Engineer and AI researcher and follow these instructions.

## Before working

- Read [the implementation plan](docs/implementation-plan.md), [architecture](docs/architecture.md), [SubQ integration contract](docs/subq-integration.md), [evaluation plan](docs/evaluation.md), and [GitHub release checklist](docs/release.md). Keep shared contracts aligned when a design changes.
- Treat [the README](README.md) as the project entry point. Turn the proposed quickstart into tested copy-and-paste commands when the implementation exists. Use the current [Subquadratic API docs](https://docs.subq.ai/) to check the provider contract and record any discrepancies in the integration notes.
- Always recommend the next step in progress summaries and final handoffs. Base it on the current evidence, state the concrete action, and call out a prerequisite when one exists.

## During implementation

- Make each successful decision recommend one specific diagnostic action from the scenario catalog. When the evidence is insufficient, display that result and recommend the scenario’s safe evidence-gathering step. Keep this guidance advisory and render it from reviewed scenario data. Treat a failed API call as an operational error with recovery guidance.
- Share the same cutoff, validation, request construction, decision mapping, and evidence checks across the web app, CLI, and evaluation harness. Keep future events and evaluation labels out of inference requests and trainee-facing data.
- Keep `SUBQ_API_KEY` in the operator’s server or CLI environment. Use synthetic, public-safe fixtures. Demo mode must run offline with labeled fixture decisions. Live mode requires explicit configuration and an explicit evaluation action.
- Keep real incident exports out of the repository and build context. Preserve offline import and review, and require both host configuration and checkpoint acknowledgement before sending imported evidence to SubQ. Use synthetic exports for import tests.
- Start with a minimal vertical slice and run it through the normal CLI and web entry points. Cover cutoff boundaries, response validation, ambiguous and unavailable decisions, provider errors, budget enforcement, and credential isolation with reproducible tests. Keep automated pull-request checks keyless.
- Separate design targets, measured results, and vendor-reported claims. Record the model, fixture version, decision policy, and run settings with evaluation outputs. Update the release checklist with verification results before handing off a release candidate.
