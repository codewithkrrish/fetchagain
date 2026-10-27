# fetchagain

A small fetch wrapper that retries only when retrying might actually help.

```js
import { fetchAgain } from "fetchagain";

const res = await fetchAgain("https://api.example.com/data", {
  retries: 3,
  onRetry: ({ attempt, response, delayMs }) =>
    console.log(`attempt ${attempt} got ${response.status}, retrying in ${delayMs}ms`),
});
```

## Why I built it

Every side project I start ends up with the same hand-rolled retry loop, and every one of them has the same bug: it retries 404s and 401s as if a fourth attempt will change the answer. I wanted one tiny helper I could drop in anywhere — browser or Node — that retries the failures worth retrying and leaves the rest alone.

## Install

This package is not on npm. Install it straight from GitHub:

```bash
npm install github:codewithkrrish/fetchagain
```

Or copy `src/fetchagain.js` into your project — it has zero dependencies and no build step, so that genuinely works.

Requires a global `fetch` (all modern browsers, Node 18+). On older Node versions, pass your own implementation via the `fetch` option.

## What it retries

| Failure | Retried? |
| --- | --- |
| Network error (dropped connection, DNS failure) | Yes |
| 408, 429, 500, 502, 503, 504 | Yes |
| Any other 4xx (404, 401, 400, ...) | No — returned as-is, exactly like plain `fetch` |
| Timeout or caller abort | No — aborts are final |

A `Retry-After` header on a 429 or 503 overrides the backoff delay (capped by `maxDelay`), because the server just told you how long to wait.

## Options

```js
await fetchAgain(url, {
  retries: 3,              // retries after the first attempt (default 3)
  retryDelay: 500,         // base delay between attempts, in ms (default 500)
  maxDelay: 30000,         // ceiling for any single delay (default 30000)
  timeout: 10000,          // per-attempt timeout in ms, 0 disables it (default 10000)
  backoff: "exponential", // "exponential" | "linear" | "fixed" (default "exponential")
  jitter: true,            // randomise delays so many clients don't retry in lockstep
  retryOn: (res) => ...,   // override the retry decision for responses
  onRetry: (info) => ...,  // called before each retry: { attempt, error?, response?, delayMs }
  fetch: customFetch,      // custom fetch implementation
  signal: abortSignal,     // your own abort signal, combined with the timeout
});
```

When retries run out on an HTTP failure, it throws `FetchAgainError` with `.attempts`, `.status` and `.response` (so you can still read the error body). Timeouts and caller aborts reject with the abort error, not a wrapped one.

A shared client with baked-in defaults:

```js
import { createFetchAgain } from "fetchagain";

const api = createFetchAgain({ retries: 5, timeout: 5000 });
const res = await api("https://api.example.com/data");
```

## Run the tests

```bash
npm test
```

Tests use Node's built-in runner and stubbed fetch calls — no network, no extra packages.

## Limitations, honestly

- No caching, no deduplication, no circuit breaker. If you need those, this is the wrong tool — it does one job.
- Backoff delays are per call, not shared across tabs or processes, so a fleet of clients can still pile onto a struggling server. Jitter helps; it does not fix that.
- The `Retry-After` date form uses the client's clock, so a badly skewed clock gives a wrong wait.
- Timeout support depends on the fetch implementation honouring the abort signal. Undici and browsers do; some minimal polyfills do not.

## Project structure

```
src/
  fetchagain.js   # the whole wrapper: retry logic, backoff, timeout handling
  index.js        # public exports
tests/
  fetchagain.test.js
examples/
  basic.mjs       # a flaky-API demo you can run with `node examples/basic.mjs`
```

## License

MIT — see [LICENSE](LICENSE).

## Author

Krrish — [github.com/codewithkrrish](https://github.com/codewithkrrish)
