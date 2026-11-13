# Evaluation and scenario design

Incident Replay recommends the next diagnostic action an on-call engineer could take using the evidence available at a selected checkpoint. The evaluation tests action selection, supporting evidence, and abstention. A correct next action can narrow the diagnosis before the underlying cause is known.

## Authoring scenarios

- Start with checked-in synthetic incidents and version each scenario. Write the causal timeline and intended diagnostic progression first. Create logs, alerts, deploy events, and runbook excerpts that an operator would actually see. Mix realistic distractors with evidence that changes the best next step.
- Give events stable, neutral IDs. Store `occurredAt` and `availableAt` separately in UTC. A log emitted at 10:04 and received at 10:13 becomes visible at 10:13. Resolve `cutoffAt` by checkpoint ID on the server, select `availableAt <= cutoffAt`, and sort by `(availableAt, id)` before applying deterministic size limits. Version or timestamp runbook updates too.
- Label each checkpoint with one canonical next action, any equally defensible alternatives, and the acceptable supporting event IDs for each accepted action. Use `insufficient_evidence` when no listed diagnostic action is justified by the visible evidence, and use `no_evidence` for its evidence choice. Store evaluation labels separately from investigator UI data. Keep label rationale, later outcomes, and display debriefs out of the provider request. The next-action rubric should favor evidence that distinguishes plausible hypotheses over activity that merely follows a recent alert.
- Review labels against the exact context the operator sees. Have a second reviewer label checkpoints independently where possible, before either reviewer sees model outputs. Resolve disagreements before scoring. Keep genuinely ambiguous cases as abstention checkpoints or record defensible alternatives. Reserve development cases for rubric and prompt changes. Freeze release cases before tuning and keep variants of a scenario in the same split. Treat a publicly committed release set as a reproducible regression set once it is visible.
- Aim for at least 12 authored incidents with at least 36 labeled checkpoints for the first published benchmark. Reserve at least eight incidents for release evaluation, including at least eight insufficient-evidence checkpoints. Cover pool exhaustion, upstream failure, deploy-related changes, and missing or late telemetry. Report counts per family and label. Keep scaling cases with added distractors in a separate slice so they cannot inflate the number of independent incidents.

## Flagship fixture

In `checkout-pool-pressure`, checkout errors start near a frontend deploy. Worker pool pressure started before the deploy, but its log becomes available after the first triage checkpoint. A later trace confirms the failure mode, and the final debrief reveals the deploy was unrelated. These are proposed labels for fixture authoring.

| Checkpoint | Visible evidence | Expected decision |
| --- | --- | --- |
| `initial-alert` | Generic checkout failure alert. Deploy and worker telemetry have yet to arrive in the replay. | `insufficient_evidence` with `no_evidence` |
| `deploy-visible` | Deploy timestamp and checkout failure alert. Comparing the release timing is the best available diagnostic. | `compare_deploy_timeline` with the visible deploy event |
| `worker-telemetry` | A late worker event shows pool waits began before the deploy. | `inspect_pool_metrics` with the late worker event |

Keep `inspect_upstream_status` available as a plausible alternative action throughout this case. Use the same action list at all three checkpoints. Test that the late event appears exactly at its availability time and never in earlier `state` or evidence choices. Keep the final trace and debrief hidden until their respective reveal points. Add a counterexample in which a deployment really does change the best next step after additional telemetry arrives.

## Evaluation runs

1. **Offline verification.** Use fixture mode and a mock provider in pull-request CI. Assert byte-level request equality when future events, debriefs, and labels are perturbed, with the same visible inputs and deterministic serialization. Test delayed and out-of-order events, exact cutoff boundaries, two or more events at the same time, no visible evidence, unknown or future evidence IDs, mismatched action and evidence, provider failures, and the documented payload limits. Test that demo replay works without a key and performs zero provider requests.
2. **Paired context comparison.** Use `subq-snap-1.2` and the same `next_step` question, fixed action IDs, option order, and descriptions for each checkpoint. Compare the latest visible signal alone with all eligible events available by that checkpoint. Keep the same static runbook context and cutoff metadata in both arms. Select the latest signal by the same deterministic rule for every case, use an explicit empty state when none exists, and strip source fields that would reveal removed events. Ask only the action question in this comparison so evidence option changes cannot affect the result. Score both arms against the same operator-view reference labels and report short-context abstention separately.
3. **Product evaluation.** Exercise the real request builder and decision adapter, with `next_step` and `supporting_event` in the same request when evidence candidates exist. Apply the production limits of 128 evidence event IDs plus `no_evidence`, an estimated 200K input tokens, and a 1 MiB request body. Offer only eligible event IDs actually serialized in the request. Test the deterministic no-evidence path when the candidate list is empty. Track whether an acceptable supporting event survives context selection separately from whether the model picks it. See [Architecture](architecture.md) and [SubQ integration](subq-integration.md).
4. **Robustness slices.** Use a seeded shuffle to reorder action and evidence options independently while preserving the state, compare selected IDs and probability changes, and report the flip rate. Add synthetic distractors at several sizes up to the application budget and record performance by input length and placement of decisive evidence. Subquadratic reports improved option-order stability on its benchmarks. Incident Replay should measure stability on its own fixtures. [Snap 1.2 release](https://subq.ai/subq-snap-1-2)

## What to measure

| Measure | How to report it |
| --- | --- |
| Next-action accuracy | Report canonical top-choice accuracy, then score accepted alternatives separately. Publish the paired full-history minus latest-signal difference with a scenario-level bootstrap interval and counts by incident family. Treat errors and missing responses as failures in the end-to-end rate. |
| Abstention | Report precision and recall for `insufficient_evidence`, the number of unsupported action recommendations, and action accuracy among non-abstained responses. Report model abstentions separately from provider errors. |
| Supporting evidence | Report evidence-candidate coverage, accepted evidence selection conditional on an accepted action, and joint action-and-evidence accuracy across all checkpoints. Include the rate of malformed or out-of-cutoff references. |
| Calibration | Use the probability assigned to the selected option for reliability plots and report a multiclass Brier score against unambiguous canonical labels. Show sample counts per bin. Report a coverage versus error curve before considering a top-probability or top-two margin threshold. Tune any threshold on development cases, evaluate it once on the frozen set, and report how often it defers the model decision to review. Keep returned model probabilities distinct from empirical reliability. |
| Runtime and cost | Report p50 and p95 end-to-end latency per arm with sample counts, completed request rate, retry count, and total input tokens from provider `usage`. Estimate inference cost using the dated published input rate. Count every metered attempt and identify attempts with unknown usage after a timeout. Document concurrency, region, and cache behavior. At $0.04 per million input tokens, a request with 100,000 billed input tokens costs $0.004. [Decisions API](https://docs.subq.ai/endpoints/decisions-api/) · [Models and pricing](https://docs.subq.ai/using-the-api/models/) |

Save a reproducibility manifest with the Git commit, scenario and label versions, request and policy versions, model ID, random seed, run date, and aggregate results. Store normalized results keyed by scenario and checkpoint, with scores, candidate counts, timing, and usage. Keep keys, authorization headers, and raw request bodies out of artifacts. Label output as **Demo fixture**, **Live SubQ**, or **Offline mock** in reports and logs. Keep demo and mock results out of live metrics.

## Run the harness

Use `npm run --silent eval -- --mode demo --split all` to validate fixture decisions and emit JSON on stdout without provider calls. For a live run, configure your key using the [README](../README.md#2-enable-live-evaluation) and use `npm run --silent eval -- --mode live --split release --max-attempts 120 --max-cost-usd 0.10`. Add `--output path.json` to write a new report file. Limits include retries. Estimates and metered usage are reported separately.

The checked-in harness runs the paired context and product evaluations. Option-order and context-length robustness sweeps are follow-up experiments. The demo matched all 36 labeled checkpoints on its recorded decisions. Live accuracy and any long-context improvement still need measurement.

## Release gates

- Pass all offline invariants, including zero future-event or label leakage, zero displayed invalid evidence IDs, bounded request sizes, no model call on replay scrub, and zero external network calls in demo mode. Preserve the timeline and a clear status on provider failure.
- Complete a manual live benchmark using an operator's key on the frozen synthetic set before claiming measured accuracy. For the initial release, target at least 80% accepted action accuracy, 75% abstention recall, 75% joint action-and-evidence accuracy, and 95% valid completed decisions. Run the flagship decision progression live and verify each cited event opens the exact visible record. Treat these values as release targets and publish observed results with denominators. Revisit targets in a documented decision if the initial development set shows they are poorly matched to the labeled task.
- Publish the paired comparison including inconclusive or negative results. Claim a long-context benefit only when the data support it. Record p95 latency, error rate, and cost under the benchmark conditions. Small synthetic samples can reveal regressions and establish repeatable comparisons, with limited evidence about real on-call incidents.

**Next step** — After a successful live smoke check, run the release split and record the results before making accuracy claims.
