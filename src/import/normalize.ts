import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { ReplayError } from "../replay/errors.ts";
import { MAX_CASE_EVENTS, MAX_KIND_LENGTH, MAX_SOURCE_LENGTH, MAX_TEXT_LENGTH, maskSensitiveText, parsePrivateCase } from "./case.ts";

const NANOS_PER_SECOND = 1_000_000_000n;
const timestamp = z.iso.datetime({ offset: true });
const timestampParts = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,9}))?(Z|[+-]\d\d:\d\d)$/;
const field = (max: number) => z.string().trim().min(1).max(max);
const genericExport = z.array(z.strictObject({
  occurredAt: timestamp,
  availableAt: timestamp.optional(),
  source: field(MAX_SOURCE_LENGTH),
  kind: field(MAX_KIND_LENGTH),
  text: field(MAX_TEXT_LENGTH),
})).max(MAX_CASE_EVENTS);

const lokiExport = z.object({
  status: z.literal("success"),
  data: z.object({
    resultType: z.literal("streams"),
    result: z.array(z.object({
      stream: z.record(z.string(), z.string()),
      values: z.array(z.tuple([z.string().regex(/^\d{1,20}$/), field(MAX_TEXT_LENGTH)], z.unknown())).max(MAX_CASE_EVENTS),
    })).max(MAX_CASE_EVENTS),
  }),
});

const githubExport = z.array(z.object({
  id: z.number().int().positive().optional(),
  state: z.enum(["error", "failure", "inactive", "in_progress", "queued", "pending", "success"]),
  created_at: timestamp,
  environment: z.string().trim().max(MAX_SOURCE_LENGTH).nullable().optional(),
  description: z.string().trim().max(MAX_TEXT_LENGTH).nullable().optional(),
})).max(MAX_CASE_EVENTS);

export type ImportFormat = "events" | "loki" | "github";
export type ImportSource = { format: ImportFormat; data: unknown };

type SourceEvent = {
  occurred: bigint;
  observed?: bigint;
  source: string;
  kind: string;
  text: string;
  providerId?: string;
};

function malformed(format: ImportFormat): ReplayError {
  const formats = {
    events: "an event array with occurredAt, optional availableAt, source, kind, and text",
    loki: "a successful Loki query_range response with streams",
    github: "a GitHub deployment status array with state and created_at",
  };
  return new ReplayError("input", `Invalid --${format} export. Provide ${formats[format]} within the size limits.`);
}

function nanos(value: string, format: ImportFormat): bigint {
  const parts = timestampParts.exec(value);
  if (!parts) throw malformed(format);
  const [, second, fraction = "", zone] = parts;
  const ms = Date.parse(second + zone);
  if (!Number.isFinite(ms)) throw malformed(format);
  return BigInt(ms) * 1_000_000n + BigInt(fraction.padEnd(9, "0"));
}

function utcSeconds(value: bigint, round: "down" | "up"): string {
  let seconds = value / NANOS_PER_SECOND;
  const fraction = value % NANOS_PER_SECOND;
  if (fraction < 0n && round === "down") seconds--;
  if (fraction > 0n && round === "up") seconds++;
  const result = new Date(Number(seconds * 1_000n)).toISOString().replace(".000Z", "Z");
  if (!/^\d{4}-/.test(result)) throw new ReplayError("input", "An event timestamp is outside the supported UTC date range.");
  return result;
}

function* sourceEvents(input: ImportSource): Generator<SourceEvent> {
  switch (input.format) {
    case "events": {
      const result = genericExport.safeParse(input.data);
      if (!result.success) throw malformed(input.format);
      for (const event of result.data) {
        yield {
          occurred: nanos(event.occurredAt, input.format),
          observed: event.availableAt === undefined ? undefined : nanos(event.availableAt, input.format),
          source: event.source,
          kind: event.kind,
          text: event.text,
        };
      }
      break;
    }
    case "loki": {
      const result = lokiExport.safeParse(input.data);
      if (!result.success) throw malformed(input.format);
      for (const { stream, values } of result.data.data.result) {
        const service = [stream.service_name, stream.service, stream.app, stream.job]
          .find((candidate) => candidate && candidate.trim());
        const source = service ? `Loki / ${maskSensitiveText(service)}`.slice(0, MAX_SOURCE_LENGTH) : "Loki";
        for (const [when, line] of values) yield { occurred: BigInt(when), source, kind: "log", text: line };
      }
      break;
    }
    case "github": {
      const result = githubExport.safeParse(input.data);
      if (!result.success) throw malformed(input.format);
      for (const status of result.data) {
        const environment = status.environment ? ` in ${status.environment}` : "";
        const description = status.description ? ` ${status.description}` : "";
        yield {
          occurred: nanos(status.created_at, input.format),
          source: "GitHub Deployments",
          kind: "deploy",
          text: `Deployment status: ${status.state.replaceAll("_", " ")}${environment}.${description}`,
          providerId: status.id?.toString(),
        };
      }
      break;
    }
  }
}

export function createPrivateCase(input: { title: string; briefing?: string; sources: Iterable<ImportSource> }) {
  const records = new Map<string, {
    id: string;
    occurredAt: string;
    availableAt: string;
    source: string;
    kind: string;
    text: string;
    assumedAvailability: boolean;
  }>();
  let readEvents = 0;

  for (const source of input.sources) {
    for (const event of sourceEvents(source)) {
      if (++readEvents > MAX_CASE_EVENTS) {
        throw new ReplayError("input", "Import at most 5,000 input events at a time. Use a smaller time range.");
      }
      const observed = event.observed ?? event.occurred;
      if (observed < event.occurred) throw new ReplayError("input", "An availableAt timestamp is earlier than occurredAt.");
      const normalized = {
        occurredAt: utcSeconds(event.occurred, "down"),
        availableAt: utcSeconds(observed, "up"),
        source: maskSensitiveText(event.source),
        kind: maskSensitiveText(event.kind),
        text: maskSensitiveText(event.text).slice(0, MAX_TEXT_LENGTH),
      };
      // Retain distinct records that happen within the same displayed second.
      const identity = JSON.stringify([event.occurred.toString(), observed.toString(), event.providerId, normalized]);
      const id = `evt-${createHash("sha256").update(identity).digest("hex").slice(0, 32)}`;
      const previous = records.get(id);
      if (previous && event.observed === undefined) continue;
      records.set(id, { ...normalized, id, assumedAvailability: event.observed === undefined });
    }
  }

  if (!records.size) throw new ReplayError("input", "The supplied exports contained no events.");
  const ordered = [...records.values()].sort((a, b) => a.availableAt.localeCompare(b.availableAt) || a.id.localeCompare(b.id));
  const incident = parsePrivateCase({
    schemaVersion: 1,
    id: `case-${randomUUID()}`,
    title: input.title,
    briefing: input.briefing ?? "Review the imported evidence and choose the next diagnostic step.",
    version: 1,
    events: ordered.map(({ assumedAvailability, ...event }) => {
      void assumedAvailability;
      return event;
    }),
  });
  return {
    incident,
    assumedAvailabilityCount: ordered.filter((entry) => entry.assumedAvailability).length,
    duplicatesRemoved: readEvents - ordered.length,
  };
}
