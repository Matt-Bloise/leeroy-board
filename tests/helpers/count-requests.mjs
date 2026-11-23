// A per-process counter of the requests a test sends to the preview Worker, loaded with `node --import ./helpers/count-requests.mjs` (NODE_OPTIONS in the preview test jobs).
// It wraps global fetch, counts the calls whose URL starts with the origin in PREVIEW_API, and when the process exits appends one line "<script> <count>" to the file named by
// WORKER_REQUEST_LOG. tools/request-summary.mjs adds the lines up into the job summary, so the estimate of Worker requests per full run (about 250) becomes a measurement.
// It sends nothing, changes no request and does nothing unless both variables are set. A browser's own requests are not counted here (those suites answer from fixtures and send none).
// The host is never printed: the preview Worker's address is masked in CI.
import { appendFileSync } from "node:fs";
import path from "node:path";

const log = process.env.WORKER_REQUEST_LOG;
let base = null;
try { base = process.env.PREVIEW_API ? new URL(process.env.PREVIEW_API).origin : null; } catch { base = null; }

if (log && base && typeof globalThis.fetch === "function" && !globalThis.__workerRequestCounter) {
  let n = 0;
  const original = globalThis.fetch.bind(globalThis);
  globalThis.__workerRequestCounter = () => n;
  globalThis.fetch = (input, init) => {
    try {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input && input.url ? input.url : String(input);
      if (url.startsWith(base)) n++;
    } catch { /* counting never breaks a request */ }
    return original(input, init);
  };
  process.on("exit", () => {
    try { appendFileSync(log, `${path.basename(process.argv[1] || "node")} ${n}\n`); } catch { /* best effort */ }
  });
}
