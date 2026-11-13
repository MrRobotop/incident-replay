import { setTimeout as delay } from "node:timers/promises";
import { ReplayError } from "../replay/errors.ts";

const DECISIONS_URL = "https://api.subq.ai/v1/systemone";
const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 512 * 1024;
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

type TransportOptions = {
  signal?: AbortSignal;
  reserveAttempt?: () => void;
  fetcher?: typeof fetch;
  timeoutMs?: number;
  deadlineMs?: number;
  random?: () => number;
};

function statusError(status: number): ReplayError {
  switch (status) {
    case 400:
    case 422:
      return new ReplayError("input", "SubQ rejected the request. Check the request format and context budget.");
    case 401:
      return new ReplayError("unauthorized", "SubQ rejected the key. Check SUBQ_API_KEY in the local environment.");
    case 402:
      return new ReplayError("credits", "Check the available credits in the SubQ Console.");
    case 403:
      return new ReplayError("model_access", "Check that your SubQ account can access subq-snap-1.2.");
    case 429:
      return new ReplayError("rate_limit", "SubQ is rate limiting requests. Wait before trying again.");
    default:
      return new ReplayError("upstream", "SubQ could not evaluate this checkpoint. Try again later.");
  }
}

function cancellationError(): ReplayError {
  return new ReplayError("cancelled", "Evaluation canceled. Select a checkpoint to evaluate again.");
}

function timeoutError(): ReplayError {
  return new ReplayError("timeout", "SubQ did not respond within the time limit. Try again when ready.");
}

function retryDelay(retryAfter: string | null, random: () => number): number {
  const jitter = Math.floor(random() * 250);
  if (retryAfter === null) return 250 + jitter;
  if (/^\d+$/.test(retryAfter)) return Number(retryAfter) * 1000 + jitter;
  const date = /GMT$/i.test(retryAfter) ? Date.parse(retryAfter) : NaN;
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) + jitter : 250 + jitter;
}

function discardBody(response: Response): void {
  void response.body?.cancel().catch(() => {});
}

async function readJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const length = Number(response.headers.get("content-length"));
  if (!response.body || length > MAX_RESPONSE_BYTES) {
    discardBody(response);
    throw new ReplayError("invalid_response", "SubQ returned an empty or oversized response. Try again later.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const chunks: string[] = [];
  let bytes = 0;
  const abortRead = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", abortRead, { once: true });
  try {
    signal.throwIfAborted();
    while (true) {
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        throw new ReplayError("invalid_response", "SubQ returned an oversized response. Try again later.");
      }
      try {
        chunks.push(decoder.decode(value, { stream: true }));
      } catch {
        throw new ReplayError("invalid_response", "SubQ returned malformed UTF-8. Try again later.");
      }
    }
    try {
      chunks.push(decoder.decode());
      return JSON.parse(chunks.join(""));
    } catch {
      throw new ReplayError("invalid_response", "SubQ returned malformed JSON. Try again later.");
    }
  } catch (error) {
    abortRead();
    throw error;
  } finally {
    signal.removeEventListener("abort", abortRead);
    reader.releaseLock();
  }
}

export async function requestSubq(
  body: object,
  key: string,
  options: TransportOptions = {},
): Promise<{ body: unknown; attempts: number; elapsedMs: number }> {
  const { signal, reserveAttempt, fetcher = fetch, timeoutMs = 10_000, deadlineMs = 25_000, random = Math.random } = options;
  if (!/^[\x21-\x7e]+$/.test(key)) {
    throw new ReplayError("configuration", "Set a valid SUBQ_API_KEY in the local environment.");
  }
  const serialized = JSON.stringify(body);
  if (Buffer.byteLength(serialized, "utf8") > MAX_REQUEST_BYTES) {
    throw new ReplayError("budget", "The SubQ request exceeds the 1 MiB request limit.");
  }
  const started = performance.now();
  const deadline = started + deadlineMs;

  for (let attempts = 1; attempts <= 2; attempts += 1) {
    if (signal?.aborted) throw cancellationError();
    const remaining = deadline - performance.now();
    if (remaining <= 0) throw timeoutError();
    reserveAttempt?.();
    const controller = new AbortController();
    const attemptSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const timeout = setTimeout(() => controller.abort(), Math.min(timeoutMs, remaining));

    let retry: { waitMs: number; error: ReplayError };
    try {
      const response = await fetcher(DECISIONS_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", Accept: "application/json" },
        redirect: "manual",
        body: serialized,
        signal: attemptSignal,
      });
      if (response.redirected || (response.status >= 300 && response.status < 400)) {
        discardBody(response);
        throw new ReplayError("upstream", "SubQ returned an unexpected redirect. Try again later.");
      }
      if (response.ok) {
        return { body: await readJson(response, attemptSignal), attempts, elapsedMs: Math.round(performance.now() - started) };
      }
      discardBody(response);
      const error = statusError(response.status);
      if (attempts === 2 || !RETRYABLE_STATUSES.has(response.status)) throw error;
      retry = { waitMs: retryDelay(response.headers.get("Retry-After"), random), error };
    } catch (error) {
      if (signal?.aborted) throw cancellationError();
      if (controller.signal.aborted) throw timeoutError();
      if (error instanceof ReplayError) throw error;
      throw new ReplayError("network", "The connection to SubQ failed. Try again when ready.");
    } finally {
      clearTimeout(timeout);
    }

    if (retry.waitMs >= deadline - performance.now()) throw retry.error;
    try {
      await delay(retry.waitMs, undefined, { signal });
    } catch {
      throw cancellationError();
    }
  }
  throw new ReplayError("upstream", "SubQ could not evaluate this checkpoint. Try again later.");
}
