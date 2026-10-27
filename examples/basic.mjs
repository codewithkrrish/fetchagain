// Usage: node examples/basic.mjs
// A deterministic demo: a pretend API that returns 503 twice, then 200.
// No network needed — swap the `fetch` option for the real one to hit a
// live endpoint.
import { fetchAgain } from "../src/index.js";

let calls = 0;
async function flakyFetch() {
  calls += 1;
  if (calls < 3) return new Response("try again", { status: 503 });
  return new Response(JSON.stringify({ ok: true }), { status: 200 });
}

const res = await fetchAgain("https://api.example.com/data", {
  fetch: flakyFetch,
  retries: 3,
  onRetry: ({ attempt, response, delayMs }) =>
    console.log(`attempt ${attempt} got ${response.status}, waiting ${Math.round(delayMs)}ms`),
});
console.log("final status:", res.status, "after", calls, "calls");
console.log("body:", await res.text());
