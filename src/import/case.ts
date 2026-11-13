import { z } from "zod";
import { idSchema, NO_EVIDENCE } from "../replay/scenario.ts";
import { ReplayError } from "../replay/errors.ts";

export const DEFAULT_CASE_DIRECTORY = "private-incidents";
export const MAX_CASE_BYTES = 8 * 1024 * 1024;
export const MAX_CASE_EVENTS = 5_000;
export const MAX_TEXT_LENGTH = 4_000;
export const MAX_TITLE_LENGTH = 120;
export const MAX_BRIEFING_LENGTH = 1_000;
export const MAX_SOURCE_LENGTH = 120;
export const MAX_KIND_LENGTH = 40;

const secretAssignment = /(\b(?:[a-z0-9]+[_-])*(?:authorization|password|passwd|pwd|api[_ -]?key|(?:access|refresh|auth)[_ -]?token|secret[_ -]?key|client[_ -]?secret|token)\b["']?[ \t]*[:=][ \t]*)(?:"(?:[^"\\\r\n]|\\.)*"|'(?:[^'\\\r\n]|\\.)*'|(?:Basic|Bearer)[ \t]+[^\s,;}&\]]+|\[redacted\]|[^\s,;}&\]]+)/gi;

export function maskSensitiveText(value: string): string {
  return value
    // Terminal escape sequences and control bytes should not survive in stored logs.
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
    .replace(secretAssignment, "$1[redacted]")
    .replace(/\bBearer[ \t]+[\w.+/=-]+/gi, "Bearer [redacted]")
    .replace(/\b(?:gh[pousr]_[a-z0-9]{16,}|github_pat_[a-z0-9_]{16,}|sk-(?:[a-z0-9_-]{16,})|(?:AKIA|ASIA)[A-Z0-9]{16})\b/gi, "[redacted]")
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[redacted]@")
    .replace(/[\w.!#$%&'*+/=?^`{|}~-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+/gi, "[redacted]")
    .trim();
}

function text(max: number) {
  return z.string().trim().min(1).max(max).transform(maskSensitiveText).pipe(z.string().min(1).max(max));
}

const utc = z.iso.datetime({ precision: 0 });
const privateEventSchema = z.strictObject({
  id: idSchema.refine((id) => id !== NO_EVIDENCE),
  occurredAt: utc,
  availableAt: utc,
  source: text(MAX_SOURCE_LENGTH),
  kind: text(MAX_KIND_LENGTH),
  text: text(MAX_TEXT_LENGTH),
});

export const privateCaseSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: z.string().regex(/^case-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/),
  title: text(MAX_TITLE_LENGTH),
  briefing: text(MAX_BRIEFING_LENGTH),
  version: z.literal(1),
  events: z.array(privateEventSchema).min(1).max(MAX_CASE_EVENTS),
}).refine(({ events }) => {
  const ids = new Set(events.map((event) => event.id));
  return ids.size === events.length && events.every((event) => event.occurredAt <= event.availableAt);
});

export type PrivateCase = z.infer<typeof privateCaseSchema>;

export function parsePrivateCase(input: unknown): PrivateCase {
  const parsed = privateCaseSchema.safeParse(input);
  if (!parsed.success) {
    throw new ReplayError("input", "Invalid private incident. Check the schema, event IDs, timestamp order and size limits.");
  }
  return parsed.data;
}
