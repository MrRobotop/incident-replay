# GitHub release checklist

Use this checklist for the first public release candidate. Local verification is recorded below. Live SubQ and public GitHub checks remain open. The intended distribution is a public GitHub repository with a documented local workflow and an optional self-hosted container.

## Repository and quickstart

- [x] Include the Apache-2.0 license, contribution guide, and security reporting instructions. All bundled incidents are synthetic.
- [ ] Confirm the GitHub owner and repository slug. Enable and verify the repository’s private vulnerability reporting channel.
- [x] Pin the runtime and dependencies, include the npm lockfile, keep `.env.example` keyless, and exclude secret files from Git and the Docker build context.
- [x] Run the README quickstart from a clean local clone. Verify `npm ci`, the demo CLI, and a keyless decision from the development server.
- [ ] Use a newly configured operator key from `.env.local` to run one live browser evaluation and one live CLI evaluation. Verify the explicit mode label, valid supporting evidence, usage, and next-step guidance. Repeat once with an invalid key and once with mock rate limits. Document the difference between insufficient evidence and a provider error.
- [ ] Verify the clone URL, commands, and filenames from the published tag. Include a short visual walkthrough of the checkout replay and a link to the evaluation report.

## Private incident imports

- [x] Verify bounded multi-source imports, masking, evidence availability, and the host and browser gates for live evaluation using synthetic exports.
- [ ] Validate the import workflow with a sanitized incident from a pilot deployment.

## CI and deployment

- [ ] Run type checks, lint, fixture validation, unit and mocked integration tests, browser smoke, and production build on pull requests. Pin third-party workflow actions to reviewed commit SHAs and use minimum required workflow permissions. Keep pull-request jobs independent of secrets. If a live CI job is added, make it manually triggered from trusted code with a restricted secret and a hard request budget. [GitHub Actions secrets](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets) · [GitHub Actions security](https://docs.github.com/en/actions/reference/security/secure-use)
- [x] Build the production container and verify the health endpoint and a keyless demo decision as a non-root user. Document the loopback-first run command.
- [ ] Run one live container smoke check if distributing a container image. Publish an image after verifying its registry artifact.
- [ ] Verify the app at its documented local port. For a shared live instance, test authenticated proxy access, TLS, origin checks, rate limits, and blocked direct access to the app port. Confirm that all successful and failed live attempts respect the process budget and that restart behavior is documented.
- [ ] Inspect browser bundles, HTTP responses, CI artifacts, logs, and image metadata with a fake test key. Confirm no key or raw provider payload is exposed. Search the release history for accidentally committed credentials and rotate any exposed key before publishing.
- [x] Verify provider error recovery, keyless health, budget enforcement, cancellation, and stale response handling with automated tests.

## Support notes to ship

| Symptom | First action |
| --- | --- |
| Demo is shown after adding a key | Set `INCIDENT_REPLAY_MODE=live`, restart the server, and choose **Evaluate with SubQ**. For the CLI, include `--mode live`. |
| The server refuses to start in live mode | Verify that `SUBQ_API_KEY` is available in the host environment or in `.env.local`. Restart the process after changes. |
| SubQ returns `401`, `402`, or `403` | Check the key for `401`, available credits for `402`, and model access for `403`. Use the console to rotate a key if needed. |
| The rate limit or local budget is reached | Follow the retry timing in the message. The local web budget resets at the next UTC day or on process restart. Use a demo instance for continued training during an outage. |
| A key is suspected to be exposed | Revoke and replace it in the SubQ Console, update the host secret, and restart the service. Check logs and release artifacts for the exposure. |

Link the [SubQ integration contract](subq-integration.md) and explain that live mode transmits synthetic or explicitly approved imported incident context to SubQ under the provider’s data policy. [SubQ Console](https://console.subq.ai/) · [SubQ data retention](https://docs.subq.ai/using-the-api/data-retention/)

## Evaluation and publication

- [x] Pass lint, type checking, 36 unit and integration tests, seven Chromium tests, and the production build. Run all 36 demo checkpoints with zero provider requests.

- [ ] Run the held-out live evaluation and check the release targets in [the evaluation plan](evaluation.md). Publish measured accuracy, abstention, evidence quality, latency, inference cost, and test-set limitations. Include comparison results when the added context fails to help.
- [ ] Review the final README as a first-time user. Check the offline demo, bring-your-own-key steps, and deployment instructions from the release candidate. Review the GitHub visibility and the list of artifacts before publication.
- [ ] Tag the first release and publish the notes with the supported workflow, scope, benchmark, and known limits. Verify the public clone and source archive from the published tag.

**Next step** — Configure a local SubQ key and record the first live CLI and browser decisions before running the release benchmark.
