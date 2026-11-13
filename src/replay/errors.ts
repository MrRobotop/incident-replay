export type ErrorCode = "input" | "not_found" | "configuration" | "origin" | "budget" |
  "busy" | "unauthorized" | "credits" | "model_access" | "rate_limit" | "upstream" |
  "invalid_response" | "timeout" | "network" | "cancelled";

export class ReplayError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = "ReplayError";
    this.code = code;
  }
}
