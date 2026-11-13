import assert from "node:assert/strict";
import { test } from "node:test";
import { ReplayError } from "../src/replay/errors.ts";
import type { ErrorCode } from "../src/replay/errors.ts";
import { requestSubq } from "../src/subq/transport.ts";

const key = "test-provider-key";
const request = { model: "subq-snap-1.2" };

function expectCode(code: ErrorCode) {
  return (error: unknown) => {
    assert.ok(error instanceof ReplayError);
    assert.equal(error.code, code);
    assert.doesNotMatch(error.message, /test-provider-key|provider-private-message/);
    return true;
  };
}

test("SubQ transport posts bearer credentials only to the pinned endpoint", async () => {
  let reservations = 0;
  const result = await requestSubq(request, key, {
    reserveAttempt: () => { reservations += 1; },
    fetcher: async (url, init) => {
      assert.equal(url, "https://api.subq.ai/v1/systemone");
      assert.equal(init?.method, "POST");
      assert.equal(init?.redirect, "manual");
      assert.equal(new Headers(init?.headers).get("Authorization"), `Bearer ${key}`);
      assert.equal(new Headers(init?.headers).get("Content-Type"), "application/json");
      assert.deepEqual(JSON.parse(String(init?.body)), request);
      return Response.json({ ok: true });
    },
  });
  assert.equal(reservations, 1);
  assert.equal(result.attempts, 1);
  assert.ok(result.elapsedMs >= 0);
  assert.deepEqual(result.body, { ok: true });
});

test("SubQ errors and redirects surface safe messages without retrying", async () => {
  const statuses = [
    [400, "input"], [401, "unauthorized"], [402, "credits"], [403, "model_access"],
    [422, "input"], [307, "upstream"], [501, "upstream"],
  ] as const;
  for (const [status, code] of statuses) {
    let calls = 0;
    await assert.rejects(requestSubq(request, key, {
      fetcher: async () => {
        calls += 1;
        return new Response(`${key} provider-private-message`, {
          status,
          headers: { Location: "https://example.invalid/leak" },
        });
      },
    }), expectCode(code));
    assert.equal(calls, 1);
  }
});

test("explicit transient responses allow only one retry and reserve it before sending", async () => {
  let reservations = 0;
  let calls = 0;
  const retryable = () => new Response(null, { status: 503, headers: { "Retry-After": "0" } });
  const result = await requestSubq(request, key, {
    random: () => 0,
    reserveAttempt: () => { reservations += 1; },
    fetcher: async () => {
      calls += 1;
      assert.equal(reservations, calls);
      return calls === 1 ? retryable() : Response.json({ ok: true });
    },
  });
  assert.equal(result.attempts, 2);

  calls = 0;
  await assert.rejects(requestSubq(request, key, {
    random: () => 0,
    fetcher: async () => {
      calls += 1;
      return retryable();
    },
  }), expectCode("upstream"));
  assert.equal(calls, 2);

  calls = 0;
  await assert.rejects(requestSubq(request, key, {
    random: () => 0,
    reserveAttempt: () => {
      if (calls > 0) throw new ReplayError("budget", "Budget exhausted.");
    },
    fetcher: async () => {
      calls += 1;
      return retryable();
    },
  }), expectCode("budget"));
  assert.equal(calls, 1);
});

test("Retry-After beyond the remaining deadline is not shortened", async () => {
  for (const header of ["60", new Date(Date.now() + 60_000).toUTCString()]) {
    let calls = 0;
    await assert.rejects(requestSubq(request, key, {
      deadlineMs: 1000,
      fetcher: async () => {
        calls += 1;
        return new Response(null, { status: 429, headers: { "Retry-After": header } });
      },
    }), expectCode("rate_limit"));
    assert.equal(calls, 1);
  }
});

test("network loss and timeout are ambiguous and are sent only once", async () => {
  let calls = 0;
  await assert.rejects(requestSubq(request, key, {
    fetcher: async () => {
      calls += 1;
      throw new Error(`provider-private-message ${key}`);
    },
  }), expectCode("network"));
  assert.equal(calls, 1);

  calls = 0;
  await assert.rejects(requestSubq(request, key, {
    timeoutMs: 1000,
    deadlineMs: 20,
    fetcher: async (_url, init) => {
      calls += 1;
      return new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true }));
    },
  }), expectCode("timeout"));
  assert.equal(calls, 1);
});

test("the attempt deadline includes the response body and cancels stalled reads", async () => {
  let bodyCancelled = false;
  await assert.rejects(requestSubq(request, key, {
    timeoutMs: 20,
    fetcher: async () => new Response(new ReadableStream({ cancel() { bodyCancelled = true; } })),
  }), expectCode("timeout"));
  assert.equal(bodyCancelled, true);
});

test("cancellation stops active work and skips attempts after backoff", async () => {
  const inFlight = new AbortController();
  await assert.rejects(requestSubq(request, key, {
    signal: inFlight.signal,
    fetcher: async () => {
      inFlight.abort(`provider-private-message ${key}`);
      return Response.json({ ok: true });
    },
  }), expectCode("cancelled"));

  const backoff = new AbortController();
  let calls = 0;
  await assert.rejects(requestSubq(request, key, {
    signal: backoff.signal,
    fetcher: async () => {
      calls += 1;
      setImmediate(() => backoff.abort());
      return new Response(null, { status: 429, headers: { "Retry-After": "1" } });
    },
  }), expectCode("cancelled"));
  assert.equal(calls, 1);

  let reservations = 0;
  await assert.rejects(requestSubq(request, key, {
    signal: AbortSignal.abort(),
    reserveAttempt: () => { reservations += 1; },
  }), expectCode("cancelled"));
  assert.equal(reservations, 0);
});

test("transport rejects oversized outbound payloads and invalid keys before reserving attempts", async () => {
  let reservations = 0;
  const reserveAttempt = () => { reservations += 1; };
  await assert.rejects(requestSubq({ data: "€".repeat(400_000) }, key, { reserveAttempt }), expectCode("budget"));
  await assert.rejects(requestSubq(request, `${key}\ninjected: value`, { reserveAttempt }), expectCode("configuration"));
  assert.equal(reservations, 0);
});

test("transport bounds response bytes without trusting Content-Length and sanitizes malformed bodies", async () => {
  const makeResponse = [
    () => new Response("{ provider-private-message"),
    () => new Response(new Uint8Array([0xc3, 0x28])),
    () => new Response(null),
    () => new Response("{}", { headers: { "content-length": "524289" } }),
    () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(300_000));
        controller.enqueue(new Uint8Array(300_000));
        controller.close();
      },
    }), { headers: { "content-length": "1" } }),
  ];
  for (const response of makeResponse) {
    await assert.rejects(requestSubq(request, key, { fetcher: async () => response() }), expectCode("invalid_response"));
  }
});
