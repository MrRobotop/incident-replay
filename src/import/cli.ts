import { parseArgs } from "node:util";
import { ReplayError } from "../replay/errors.ts";
import { DEFAULT_CASE_DIRECTORY, MAX_BRIEFING_LENGTH, MAX_TITLE_LENGTH } from "./case.ts";
import { readBoundedJson, writePrivateCase } from "./files.ts";
import { createPrivateCase } from "./normalize.ts";
import type { ImportFormat, ImportSource } from "./normalize.ts";

const formats = ["events", "loki", "github"] as const;
const usage = `Usage: npm run import:incident -- --title TITLE [--briefing TEXT] [sources] [--output DIRECTORY]

Sources (repeat flags to combine exports)
  --events FILE    JSON array of {occurredAt, availableAt?, source, kind, text}
  --loki FILE      Grafana Loki query_range JSON with a streams result
  --github FILE    GitHub deployment statuses JSON array

The command reads local files only. It writes a private case to ${DEFAULT_CASE_DIRECTORY}/ by default.
Use up to 20 files, 8 MiB per file, 5,000 events, and 4,000 characters per input event.
Use RFC 3339 timestamps. Occurrence rounds down and availability rounds up to UTC seconds.
When a source has no observed timestamp, the importer uses the occurrence timestamp.
Common credentials and email addresses are masked. Review the case before sending evidence to SubQ.`;

function* readSources(paths: Partial<Record<ImportFormat, string[]>>): Generator<ImportSource> {
  for (const format of formats) {
    for (const path of paths[format] ?? []) yield { format, data: readBoundedJson(path) };
  }
}

function main() {
  const { values } = parseArgs({
    options: {
      title: { type: "string" },
      briefing: { type: "string" },
      events: { type: "string", multiple: true },
      loki: { type: "string", multiple: true },
      github: { type: "string", multiple: true },
      output: { type: "string" },
      help: { type: "boolean" },
    },
  });
  if (values.help) {
    console.log(usage);
    return;
  }

  const title = values.title?.trim();
  if (!title || title.length > MAX_TITLE_LENGTH) throw new ReplayError("input", "Provide --title with 1 to 120 characters.");
  if (values.briefing !== undefined && (!values.briefing.trim() || values.briefing.trim().length > MAX_BRIEFING_LENGTH)) {
    throw new ReplayError("input", "Provide --briefing with 1 to 1,000 characters.");
  }
  if (values.output !== undefined && !values.output.trim()) {
    throw new ReplayError("input", "Provide a directory after --output.");
  }
  const count = formats.reduce((total, format) => total + (values[format]?.length ?? 0), 0);
  if (count < 1 || count > 20) throw new ReplayError("input", "Provide one to 20 source files. Use --help for formats.");
  const { incident, assumedAvailabilityCount, duplicatesRemoved } = createPrivateCase({
    title,
    briefing: values.briefing,
    sources: readSources(values),
  });
  writePrivateCase(values.output ?? DEFAULT_CASE_DIRECTORY, incident);
  console.log(`Saved ${incident.id}.json with ${incident.events.length} events.`);
  if (assumedAvailabilityCount) {
    console.log(`Used the occurrence timestamp for ${assumedAvailabilityCount} events with no observed timestamp.`);
  }
  if (duplicatesRemoved) console.log(`Removed ${duplicatesRemoved} duplicate events.`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof ReplayError ? error.message : "Could not import the incident. Use --help for options.");
  process.exitCode = 2;
}
