/**
 * fetchagain — fetch with retries that only kick in when retrying makes sense.
 *
 * No dependencies. Works anywhere global fetch exists: modern browsers and
 * Node 18+. For tests and for older runtimes you can pass your own fetch
 * implementation via the `fetch` option.
 */

export const DEFAULT_RETRIES = 3;
export const DEFAULT_RETRY_DELAY_MS = 500;
export const DEFAULT_MAX_DELAY_MS = 30_000;
export const DEFAULT_TIMEOUT_MS = 10_000;

/** HTTP statuses worth one more try. Everything else in the 4xx range is a
 *  client mistake — retrying it just burns time and rate limit. */
const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

/**
 * True when an HTTP status is worth retrying.
 *
 * @param {number} status - the response status code
 * @returns {boolean}
 */
export function isRetryableStatus(status) {
  return RETRYABLE_STATUSES.has(status);
}

/**
 * True when a thrown error looks transient (a dropped connection, a DNS
 * hiccup) rather than a programming mistake. Abort errors are not retryable:
 * if the caller cancelled, we stay cancelled.
 *
 * @param {unknown} error - whatever fetch threw
 * @returns {boolean}
 */
export function isRetryableError(error) {
  if (error instanceof Error && error.name === "AbortError") return false;
  // Undici / browsers surface network failures as TypeError. It is a wide
  // net, but a bad URL is the only common false positive and that fails
  // fast on every attempt anyway.
  return error instanceof TypeError;
}

/**
 * Delay before attempt `attempt` (1-based, so the first retry is attempt 1).
 * Pure function, so the backoff math is easy to test without waiting.
 *
 * @param {number} attempt
 * @param {number} baseMs
 * @param {number} maxMs
 * @param {"exponential" | "linear" | "fixed"} backoff
 * @param {boolean} jitter - when true, randomise between 0 and the computed delay
 * @returns {number} milliseconds, capped at maxMs
 */
export function computeDelay(attempt, baseMs, maxMs, backoff, jitter) {
  let delay;
  if (backoff === "linear") {
    delay = baseMs * attempt;
  } else if (backoff === "fixed") {
    delay = baseMs;
  } else {
    delay = baseMs * 2 ** (attempt - 1);
  }
  if (jitter) delay = Math.random() * delay;
  return Math.min(delay, maxMs);
}

/**
 * Parse a Retry-After header into milliseconds, or null when it is absent
 * or unusable. Handles both delta-seconds and HTTP-date forms.
 *
 * @param {string | null} value
 * @returns {number | null}
 */
export function parseRetryAfter(value) {
  if (value == null) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const dateMs = Date.parse(value);
  if (Number.isNaN(dateMs)) return null;
  return Math.max(0, dateMs - Date.now());
}

/**
 * Thrown when every attempt is used up. Carries the last response (when the
 * failure was an HTTP status) so callers can still read the body if they
 * want to.
 */
export class FetchAgainError extends Error {
  /**
   * @param {string} message
   * @param {{ attempts: number, status?: number, response?: Response }} info
   */
  constructor(message, { attempts, status, response }) {
    super(message);
    this.name = "FetchAgainError";
    this.attempts = attempts;
    this.status = status;
    this.response = response;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Combine the caller's signal with our timeout signal into one signal that
 * aborts when either fires. Falls back to manual listeners where
 * AbortSignal.any is unavailable.
 *
 * @param {AbortSignal | undefined} userSignal
 * @param {AbortSignal} timeoutSignal
 * @returns {{ signal: AbortSignal, cleanup: () => void }}
 */
function combineSignals(userSignal, timeoutSignal) {
  if (!userSignal) return { signal: timeoutSignal, cleanup: () => {} };
  if (typeof AbortSignal.any === "function") {
    return { signal: AbortSignal.any([userSignal, timeoutSignal]), cleanup: () => {} };
  }
  const controller = new AbortController();
  const onAbort = () => controller.abort(userSignal.reason);
  const onTimeout = () => controller.abort(timeoutSignal.reason);
  userSignal.addEventListener("abort", onAbort, { once: true });
  timeoutSignal.addEventListener("abort", onTimeout, { once: true });
  return {
    signal: controller.signal,
    cleanup: () => {
      userSignal.removeEventListener("abort", onAbort);
      timeoutSignal.removeEventListener("abort", onTimeout);
    },
  };
}

/**
 * Fetch a URL, retrying only on transient failures.
 *
 * Retries: network errors, 408, 429 and 5xx. It deliberately does NOT retry
 * other 4xx responses — a 404 or a 401 will not turn into a 200 on attempt 4.
 * A 429/503 Retry-After header overrides the backoff delay (capped by
 * maxDelay) because the server just told you how long to wait.
 *
 * @param {string | URL | Request} input
 * @param {object} [options]
 * @param {number} [options.retries=3] - retries after the first attempt
 * @param {number} [options.retryDelay=500] - base delay between attempts, ms
 * @param {number} [options.maxDelay=30000] - ceiling for any single delay, ms
 * @param {number} [options.timeout=10000] - per-attempt timeout, ms (0 = no timeout)
 * @param {"exponential" | "linear" | "fixed"} [options.backoff="exponential"]
 * @param {boolean} [options.jitter=true] - randomise delays so many clients do not retry in lockstep
 * @param {(response: Response) => boolean} [options.retryOn] - override the default retry decision for responses
 * @param {(info: { attempt: number, error?: unknown, response?: Response, delayMs: number }) => void} [options.onRetry] - called before each retry
 * @param {typeof fetch} [options.fetch] - custom fetch implementation (tests, older runtimes)
 * @param {AbortSignal} [options.signal] - caller-owned abort signal
 * @param {RequestInit} [options.init] - anything else passed straight through to fetch
 * @returns {Promise<Response>} the first successful (or non-retryable) response
 * @throws {FetchAgainError} when retries run out
 * @throws {DOMException} AbortError on timeout or caller abort
 */
export async function fetchAgain(input, options = {}) {
  const {
    retries = DEFAULT_RETRIES,
    retryDelay = DEFAULT_RETRY_DELAY_MS,
    maxDelay = DEFAULT_MAX_DELAY_MS,
    timeout = DEFAULT_TIMEOUT_MS,
    backoff = "exponential",
    jitter = true,
    retryOn,
    onRetry,
    fetch: fetchImpl = globalThis.fetch,
    signal: userSignal,
    ...init
  } = options;

  if (!Number.isInteger(retries) || retries < 0) {
    throw new RangeError("fetchAgain: retries must be a non-negative integer");
  }
  if (typeof fetchImpl !== "function") {
    throw new TypeError("fetchAgain: no fetch implementation available");
  }

  let lastError;
  let lastResponse;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timeoutId =
      timeout > 0 ? setTimeout(() => controller.abort(new DOMException("Timed out", "TimeoutError")), timeout) : null;
    const { signal, cleanup } = combineSignals(userSignal, controller.signal);

    try {
      const response = await fetchImpl(input, { ...init, signal });
      lastResponse = response;

      const shouldRetry = retryOn ? retryOn(response) : isRetryableStatus(response.status);
      if (!shouldRetry || attempt === retries) {
        if (!shouldRetry) return response;
        break; // retried everything, fall through to the error below
      }

      const serverWait = parseRetryAfter(response.headers.get("Retry-After"));
      // The server's wait overrides backoff (capped by maxDelay) — taking
      // the min of the two would ignore what the server asked for.
      const delayMs =
        serverWait != null ? Math.min(serverWait, maxDelay) : computeDelay(attempt + 1, retryDelay, maxDelay, backoff, jitter);
      onRetry?.({ attempt: attempt + 1, response, delayMs });
      await sleep(delayMs);
    } catch (error) {
      lastError = error;
      const aborted = error instanceof Error && error.name === "AbortError";
      if (aborted || !isRetryableError(error) || attempt === retries) {
        throw error;
      }
      const delayMs = computeDelay(attempt + 1, retryDelay, maxDelay, backoff, jitter);
      onRetry?.({ attempt: attempt + 1, error, delayMs });
      await sleep(delayMs);
    } finally {
      if (timeoutId !== null) clearTimeout(timeoutId);
      cleanup();
    }
  }

  if (lastResponse) {
    throw new FetchAgainError(`Request failed with status ${lastResponse.status} after ${retries + 1} attempts`, {
      attempts: retries + 1,
      status: lastResponse.status,
      response: lastResponse,
    });
  }
  // Unreachable in practice (the loop always throws or returns first), but
  // kept so a future refactor cannot silently return undefined.
  throw lastError ?? new FetchAgainError("Request failed", { attempts: retries + 1 });
}

/**
 * Create a fetchAgain with baked-in defaults — handy when every call in a
 * project shares the same timeout and retry policy.
 *
 * @param {object} defaults - same options as fetchAgain
 * @returns {typeof fetchAgain}
 */
export function createFetchAgain(defaults) {
  return (input, options) => fetchAgain(input, { ...defaults, ...options });
}
