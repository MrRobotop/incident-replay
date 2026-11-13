# Security policy

Use GitHub’s **Report a vulnerability** form in the repository’s Security tab when private vulnerability reporting is enabled. Include a minimal reproduction and the affected version. Keep real keys and incident data out of the report. Repository maintainers should enable and verify private vulnerability reporting before announcing the project.

Incident Replay keeps the operator’s SubQ key in the CLI or server environment. The browser demo uses synthetic fixtures. Imported incidents are visible to users who can access the configured private instance. Enable SubQ for imported evidence only after reviewing and approving the data. See the [import guide](docs/importing-incidents.md). For shared live instances, follow the authenticated proxy and network configuration in the [architecture](docs/architecture.md).

If a SubQ key is exposed, revoke it in the SubQ Console, replace the server secret, and restart the process. Review logs and release artifacts for affected copies. [SubQ Console](https://console.subq.ai/)
