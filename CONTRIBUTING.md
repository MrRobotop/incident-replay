# Contributing

Use Node.js 24 with the version in `.nvmrc`. Run `npm ci`, then follow the [test commands](README.md#development-and-tests). Keep automated tests keyless. Use a local SubQ key for explicit live checks.

For scenario changes, use synthetic data and follow the [authoring and evaluation plan](docs/evaluation.md). Update the scenario version, its demo decisions, and the matching labels together. Add or update tests for behavior changes. Include the commands and results in your pull request.

**Next step** — Run `npm test` after your first change.
