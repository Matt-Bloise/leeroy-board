// k6 soak script for a PREVIEW environment. Not run in CI, not run against production.
//   k6 run -e API=https://<preview-worker>/api -e BOARD_KEY=<member key> tests/load/soak.js
//   k6 run -e API=... -e BOARD_KEY=... -e PROFILE=large tests/load/soak.js
// Env: API (required, origin plus /api), BOARD_KEY (a member key for the preview; never commit one),
//      PROFILE small (5 VUs, default) | large (500 VUs), WS_URL (default: API with ws scheme and /live),
//      ASK (set to "1" to include the member ask; off by default, see the runbook: asks call an AI model).
// Targets below are SPECULATIVE starting points, not measured results. See docs/runbooks/load-test.md.
import http from "k6/http";
import ws from "k6/ws";
import { check, sleep } from "k6";
import { Trend, Rate } from "k6/metrics";

const API = (__ENV.API || "").replace(/\/$/, "");
const KEY = __ENV.BOARD_KEY || "";
const PROFILE = __ENV.PROFILE === "large" ? "large" : "small";
const WS_URL = __ENV.WS_URL || API.replace(/^http/, "ws") + "/live";
const DO_ASK = __ENV.ASK === "1";
if (!API) throw new Error("set -e API=https://<preview worker origin>/api");
if (/leeroy\.party/.test(API)) throw new Error("refusing to load-test production");

const askMs = new Trend("ask_duration", true);
const wsOk = new Rate("ws_handshake_ok");

const VUS = PROFILE === "large" ? 500 : 5;
const scenarios = {
  bootstrap: { executor: "ramping-vus", exec: "bootstrap", startVUs: 0,
    stages: [{ duration: "1m", target: VUS }, { duration: "8m", target: VUS }, { duration: "1m", target: 0 }] },
  room: { executor: "ramping-vus", exec: "room", startVUs: 0,
    stages: [{ duration: "1m", target: Math.ceil(VUS / 2) }, { duration: "8m", target: Math.ceil(VUS / 2) }, { duration: "1m", target: 0 }] },
};
if (DO_ASK) scenarios.ask = { executor: "constant-arrival-rate", exec: "ask", rate: 6, timeUnit: "1m", duration: "10m", preAllocatedVUs: 2, maxVUs: 5 };

export const options = {
  scenarios,
  thresholds: {
    // SPECULATIVE targets. Edit with evidence, not hope.
    "http_req_duration{endpoint:bootstrap}": ["p(95)<800"],
    "http_req_failed{endpoint:bootstrap}": ["rate<0.01"],
    ask_duration: ["p(95)<8000"],
    ws_handshake_ok: ["rate>0.98"],
  },
};

export function bootstrap() {
  const r = http.get(`${API}/bootstrap`, { tags: { endpoint: "bootstrap" } });
  check(r, { "bootstrap 200": (x) => x.status === 200, "bootstrap json": (x) => (x.headers["Content-Type"] || "").includes("json") });
  sleep(1 + Math.random() * 4);
}

export function ask() {
  if (!KEY) return;
  const body = JSON.stringify({ kind: "ask", patch: { text: "What is the next step for tonight?", share: false } });
  const r = http.post(`${API}/intent`, body, {
    headers: { "Content-Type": "application/json", Authorization: `Board ${KEY}` },
    tags: { endpoint: "ask" },
  });
  askMs.add(r.timings.duration);
  check(r, { "ask accepted (2xx)": (x) => x.status >= 200 && x.status < 300 });
}

export function room() {
  const res = ws.connect(WS_URL, {}, (socket) => {
    socket.on("open", () => socket.setTimeout(() => socket.close(), 30000 + Math.random() * 30000));
    socket.on("error", () => {});
  });
  const ok = !!res && res.status === 101;
  wsOk.add(ok);
  check(res, { "ws upgraded (101)": () => ok });
  sleep(1);
}
