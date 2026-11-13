# Bring your own incident evidence

Use a private incident library to replay an outage from evidence your team already has. Import a bounded time window of logs and at least one independent signal, such as an alert or deployment status. If the export contains the eventual root cause or a retrospective, leave it out of the initial evidence.

## Choose evidence sources

| Evidence | Connect it today | Why it matters |
| --- | --- | --- |
| Service logs | Export a Grafana Loki `query_range` result for the affected service and time window. Pass it as `--loki`. | Compare the first errors, downstream symptoms, and logs that arrived late. |
| Changes and rollouts | Export the GitHub deployment **statuses** for the deployment you want to compare. Pass the JSON array as `--github`. | Distinguish a successful rollout from a deployment request or an in-progress rollout. |
| Alerts, traces, metrics, and runbooks | Export selected records from your existing tools into the generic JSON format and pass it as `--events`. Include observed time when available. | Give the reviewer enough context to narrow a hypothesis or choose the next diagnostic. |

Loki query-range streams and GitHub deployment status lists are read-only inputs. No provider credentials are required by the importer. Use your existing read access to generate each export. A private GitHub repo requires deployment read permission for the statuses endpoint. [Loki HTTP API](https://grafana.com/docs/loki/latest/reference/loki-http-api/#query-logs-within-a-range-of-time) · [GitHub deployment statuses](https://docs.github.com/en/rest/deployments/statuses#list-deployment-statuses)

## Import and review locally

1. Prepare one or more files. The generic `--events` file is a JSON array. Use RFC 3339 timestamps with a timezone. Set `availableAt` when you know when the event reached your telemetry or on-call system. If it is absent, the importer uses the event timestamp as its best available estimate. Loki and GitHub status exports use their source timestamps for both when a separate observation time is unavailable. OpenTelemetry exports can use `Timestamp` for occurrence and `ObservedTimestamp` for availability. [OpenTelemetry Logs Data Model](https://opentelemetry.io/docs/specs/otel/logs/data-model/)
2. Import. Paths refer to local files on the host.

   ```sh
   npm run import:incident -- --title "Checkout errors on Friday" \
     --events ./alerts.json --loki ./checkout-loki.json --github ./deployment-statuses.json
   ```

3. Add the directory to your server’s `.env.local` and restart.

   ```dotenv
   INCIDENT_REPLAY_IMPORT_DIR=private-incidents
   INCIDENT_REPLAY_ALLOW_IMPORTED_SUBQ=false
   ```

4. Open the incident library and select the imported case. The app creates up to eight checkpoints from the observed timeline, including the first and last available event times. It shows what could have been seen at each checkpoint. Local review works in demo mode. Add new evidence by importing a new case, then restart the server.

Try the [bundled checkout export](../examples/checkout-events.json) or use this minimal `alerts.json` example:

```json
[
  {
    "occurredAt": "2026-11-13T14:02:00Z",
    "availableAt": "2026-11-13T14:08:00Z",
    "source": "checkout-alerts",
    "kind": "alert",
    "text": "Checkout completion failures reached 7.8% over five minutes."
  },
  {
    "occurredAt": "2026-11-13T14:06:00Z",
    "availableAt": "2026-11-13T14:10:00Z",
    "source": "checkout-worker",
    "kind": "log",
    "text": "A sample request timed out while acquiring a database connection."
  }
]
```

The default private directory is excluded from Git and Docker builds. Keep original exports outside the repository or in an ignored directory too. The importer masks common credential patterns and email addresses. Review the resulting JSON for sensitive fields your organization cannot share. Pattern matching cannot identify every kind of secret or personal information. Availability is rounded up and occurrence rounded down when a source supplies subsecond timestamps, so evidence does not become visible early. An instance reads at most 50 cases and 16 MiB of normalized JSON. The import command lists its per-file limits.

## Enable SubQ for approved evidence

Enable live mode with your server’s key, then set `INCIDENT_REPLAY_ALLOW_IMPORTED_SUBQ=true` only on a private instance. Each evaluation also requires an explicit acknowledgement in the replay. SubQ receives the bounded visible context for that checkpoint. The app links its recommendation to one submitted event or recommends what evidence to gather next. Standard Decisions retention is up to 60 days, with documented exceptions and organization-level zero data retention options. [SubQ data retention](https://docs.subq.ai/using-the-api/data-retention/)

Anyone with access to the instance can see its imported library. Keep the instance on loopback or put it behind an authenticated TLS proxy and block direct access to its port. Public deployments should leave the import directory unset. In Docker, mount the cases read-only and set `INCIDENT_REPLAY_IMPORT_DIR` to the mount path inside the container.

## Next integrations

Start with a read-only Loki connector for teams that run Grafana. Restrict it to a configured host and service allowlist, query a bounded window, preview normalized events, then save an auditable snapshot for replay. Use the same import validation before any model request. Follow with read-only GitHub deployment and status ingestion. For teams with a different stack, keep the generic event format and add an adapter for their alerting source only when there is a real fixture to test against.

**Next step** — Import a sanitized alert and a small log export for the same incident. Check the timeline and availability times before enabling live evaluation for private evidence.
