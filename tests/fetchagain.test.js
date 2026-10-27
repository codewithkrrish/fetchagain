import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  fetchAgain,
  createFetchAgain,
  FetchAgainError,
  isRetryableStatus,
  computeDelay,
  parseRetryAfter,
} from "../src/index.js";

// Small stand-in for a Response: only status + headers are read by the code.
function fakeResponse(status, headers = {}) {
  return {
    status,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
  };
}

// Returns a fetch stub that plays back the given responses/errors in order.
function sequenceFetch(script) {
  let calls = 0;
  const fetch = async () => {
    const next = script[Math.min(calls, script.length - 1)];
    calls += 1;
    if (next instanceof Error) throw next;
    return next;
  };
  fetch.calls = () => calls;
  return fetch;
}

// A fetch stub that never resolves unless its signal fires, then rejects
// with the abort reason — the same contract real fetch gives us.
function hangingFetch() {
  return (_input, { signal } = {}) =>
    new Promise((_resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
}

const noRetryOpts = { retryDelay: 1, jitter: false, timeout: 0 };

describe("fetchAgain", () => {
  it("returns the first response when it succeeds", async () => {
    const fetch = sequenceFetch([fakeResponse(200)]);
    const res = await fetchAgain("https://example.com", { fetch, ...noRetryOpts });
    assert.equal(res.status, 200);
    assert.equal(fetch.calls(), 1);
  });

  it("retries 500s and returns the eventual success", async () => {
    const seen = [];
    const fetch = sequenceFetch([fakeResponse(500), fakeResponse(500), fakeResponse(200)]);
    const res = await fetchAgain("https://example.com", {
      fetch,
      ...noRetryOpts,
      onRetry: (info) => seen.push(info.attempt),
    });
    assert.equal(res.status, 200);
    assert.equal(fetch.calls(), 3);
    assert.deepEqual(seen, [1, 2]);
  });

  it("does not retry a 404 or a 401 — those come back as-is, like fetch", async () => {
    for (const status of [404, 401, 400]) {
      const fetch = sequenceFetch([fakeResponse(status)]);
      const res = await fetchAgain("https://example.com", { fetch, ...noRetryOpts });
      assert.equal(res.status, status);
      assert.equal(fetch.calls(), 1);
    }
  });

  it("retries network errors but not aborts", async () => {
    const fetch = sequenceFetch([new TypeError("fetch failed"), fakeResponse(200)]);
    const res = await fetchAgain("https://example.com", { fetch, ...noRetryOpts });
    assert.equal(res.status, 200);
    assert.equal(fetch.calls(), 2);
  });

  it("throws FetchAgainError with the last status after retries run out", async () => {
    const fetch = sequenceFetch([fakeResponse(503)]);
    await assert.rejects(
      fetchAgain("https://example.com", { fetch, retries: 3, ...noRetryOpts }),
      (err) => {
        assert.ok(err instanceof FetchAgainError);
        assert.equal(err.attempts, 4);
        assert.equal(err.status, 503);
        assert.equal(err.response.status, 503);
        return true;
      },
    );
    assert.equal(fetch.calls(), 4);
  });

  it("honours Retry-After over the backoff delay", async () => {
    const fetch = sequenceFetch([fakeResponse(429, { "retry-after": "1" }), fakeResponse(200)]);
    const started = Date.now();
    const res = await fetchAgain("https://example.com", { fetch, retryDelay: 1, jitter: false, timeout: 0 });
    assert.equal(res.status, 200);
    assert.ok(Date.now() - started >= 900, "should have waited about a second");
  });

  it("times out a hanging request instead of waiting forever", async () => {
    await assert.rejects(fetchAgain("https://example.com", { fetch: hangingFetch(), timeout: 30, retries: 2 }));
  });

  it("does not retry when the caller's signal aborts", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetch = hangingFetch();
    await assert.rejects(fetchAgain("https://example.com", { fetch, signal: controller.signal, timeout: 0 }));
  });

  it("rejects bad options before calling fetch", async () => {
    const fetch = sequenceFetch([fakeResponse(200)]);
    await assert.rejects(fetchAgain("https://example.com", { fetch, retries: -1 }), RangeError);
    assert.equal(fetch.calls(), 0);
  });

  it("lets retryOn override the default decision both ways", async () => {
    const never = sequenceFetch([fakeResponse(500)]);
    const res = await fetchAgain("https://example.com", { fetch: never, retryOn: () => false, ...noRetryOpts });
    assert.equal(res.status, 500);
    assert.equal(never.calls(), 1);

    const always = sequenceFetch([fakeResponse(404)]);
    await assert.rejects(
      fetchAgain("https://example.com", { fetch: always, retries: 1, retryOn: () => true, ...noRetryOpts }),
      (err) => err instanceof FetchAgainError && err.status === 404,
    );
    assert.equal(always.calls(), 2);
  });
});

describe("createFetchAgain", () => {
  it("bakes in defaults that per-call options can still override", async () => {
    const fetch = sequenceFetch([fakeResponse(503)]);
    const strict = createFetchAgain({ fetch, retries: 0, retryDelay: 1, jitter: false, timeout: 0 });
    await assert.rejects(strict("https://example.com"), (err) => err.attempts === 1);
    assert.equal(fetch.calls(), 1);
  });
});

describe("helpers", () => {
  it("isRetryableStatus covers 408, 429 and 5xx only", () => {
    assert.equal(isRetryableStatus(429), true);
    assert.equal(isRetryableStatus(503), true);
    assert.equal(isRetryableStatus(408), true);
    assert.equal(isRetryableStatus(404), false);
    assert.equal(isRetryableStatus(200), false);
  });

  it("computeDelay follows the chosen backoff and caps at maxDelay", () => {
    assert.equal(computeDelay(1, 500, 30_000, "exponential", false), 500);
    assert.equal(computeDelay(3, 500, 30_000, "exponential", false), 2000);
    assert.equal(computeDelay(3, 500, 30_000, "linear", false), 1500);
    assert.equal(computeDelay(5, 500, 30_000, "fixed", false), 500);
    assert.equal(computeDelay(10, 500, 1200, "exponential", false), 1200);
  });

  it("parseRetryAfter handles seconds, dates and garbage", () => {
    assert.equal(parseRetryAfter("2"), 2000);
    assert.equal(parseRetryAfter(null), null);
    assert.equal(parseRetryAfter("not-a-date"), null);
    const soon = new Date(Date.now() + 5000).toUTCString();
    const parsed = parseRetryAfter(soon);
    assert.ok(parsed > 3000 && parsed <= 5000);
  });
});
