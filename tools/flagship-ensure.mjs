// Ensure the Cloudflare Flagship app and the flags of infrastructure/flags.json exist. Node 22, no dependencies.
//
//   node tools/flagship-ensure.mjs [--dry-run] [--manifest <file>]
//
// Needs CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID in the environment (not needed for --dry-run).
// stdout: the app_id and nothing else. Everything else goes to stderr. No token value is ever printed.
// Idempotent: the app is found by name or created; a flag is created ONLY when it is missing. An existing flag is never
// modified (PUT/DELETE are not used), so a switch flipped in the dashboard survives every deploy.
// Exit codes: 0 ok, 2 the token is rejected (401/403, names the permission), 1 any other failure (transient API error, bad manifest).
// The deploy workflow runs this step with continue-on-error: a Flagship outage must never block a code deploy.
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const API = "https://api.cloudflare.com/client/v4";

export class PermissionError extends Error {}

// Request bodies, the ONLY place they are defined.
// Flag body: follows the Cloudflare Flagship docs as read by the account owner (flag = key 1-64 chars, description optional max 512, enabled,
// default_variation (must be a key of variations), variations (map of name to value, all one type, each at most 10KB), rules (array of
// {conditions, priority >= 1, serve_variation, rollout?})). A boolean flag: {key, description, enabled: false, variations: {off: false, on: true},
// default_variation: "off", rules: []}.
// UNVERIFIED (not documented in anything the owner could read): the create-app body ({name}) and the list-response envelope
// (assumed Cloudflare's usual {success, result}, with result an array or {items}; app id read from id or app_id; pagination not handled).
export const appBody = (name) => ({ name });
export const flagBody = (flag) => ({
  key: flag.key,
  description: String(flag.description || "").slice(0, 512),
  enabled: false,
  variations: { off: false, on: true },
  default_variation: "off",
  rules: [],
});

export function loadManifest(file) {
  const m = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!m || typeof m.app !== "string" || !m.app || !Array.isArray(m.flags)) throw new Error("manifest: need app (string) and flags (array)");
  const seen = new Set();
  for (const f of m.flags) {
    if (!f || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(f.key || "")) throw new Error(`manifest: bad flag key ${JSON.stringify(f && f.key)}`);
    if (seen.has(f.key)) throw new Error(`manifest: duplicate flag key ${f.key}`);
    if (f.default !== "off") throw new Error(`manifest: flag ${f.key} must default to "off"`);
    seen.add(f.key);
  }
  return m;
}

export async function ensure({ fetch: f = fetch, accountId, token, manifest, dryRun = false, log = () => {} }) {
  const base = `${API}/accounts/${accountId}/flagship/apps`;
  const planned = [];
  const call = async (method, url, body) => {
    if (dryRun) {
      // Nothing is sent, not even a GET. The plan lists every request a first run could make; a real run skips what already exists.
      planned.push({ method, url, body });
      return { planned: true, result: [] };
    }
    const res = await f(url, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    if (res.status === 401 || res.status === 403) {
      throw new PermissionError(`Cloudflare answered ${res.status} for ${method} ${url.replace(base, "…/flagship/apps")}. The CLOUDFLARE_API_TOKEN needs the Flagship Write (Flagship App Write) and Flagship Read permissions on this account.`);
    }
    let json = null;
    try { json = JSON.parse(text); } catch { /* handled below */ }
    if (!res.ok || !json || json.success === false) throw new Error(`Cloudflare ${method} ${url.replace(base, "…/flagship/apps")} failed: HTTP ${res.status}`);
    return json;
  };
  const items = (j) => (Array.isArray(j.result) ? j.result : Array.isArray(j.result && j.result.items) ? j.result.items : []);

  const apps = await call("GET", base);
  let app = items(apps).find((a) => a && a.name === manifest.app);
  let appId = app && (app.id || app.app_id);
  let created = { app: false, flags: [] };
  if (!appId) {
    log(`app ${manifest.app}: missing, creating`);
    const r = await call("POST", base, appBody(manifest.app));
    created.app = true;
    appId = r.planned ? "<new-app-id>" : r.result && (r.result.id || r.result.app_id);
    if (!appId) throw new Error("created the app but the response carried no id");
  }
  const existing = created.app ? [] : items(await call("GET", `${base}/${appId}/flags`)).map((x) => x.key);
  if (dryRun) log("dry run: nothing was sent; a real run skips every request whose app or flag already exists");
  for (const flag of manifest.flags) {
    if (existing.includes(flag.key)) { log(`flag ${flag.key}: exists, left untouched`); continue; }
    log(`flag ${flag.key}: missing, creating (disabled)`);
    await call("POST", `${base}/${appId}/flags`, flagBody(flag));
    created.flags.push(flag.key);
  }
  return { appId: dryRun && created.app ? null : appId, created, planned };
}

async function main(argv, env) {
  const dryRun = argv.includes("--dry-run");
  const mi = argv.indexOf("--manifest");
  const file = mi >= 0 ? argv[mi + 1] : fileURLToPath(new URL("../infrastructure/flags.json", import.meta.url));
  const err = (s) => process.stderr.write(s + "\n");
  try {
    const manifest = loadManifest(file);
    const accountId = String(env.CLOUDFLARE_ACCOUNT_ID || "").trim();
    const token = String(env.CLOUDFLARE_API_TOKEN || "").trim();
    if (!dryRun && (!accountId || !token)) throw new Error("CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required");
    const r = await ensure({ accountId: accountId || "<account_id>", token: token || "<token>", manifest, dryRun, log: err });
    if (dryRun) {
      // Planned requests only. No token appears anywhere in this output.
      for (const p of r.planned) process.stdout.write(`${p.method} ${p.url}${p.body ? " " + JSON.stringify(p.body) : ""}\n`);
      return 0;
    }
    process.stdout.write(`${r.appId}\n`);
    return 0;
  } catch (e) {
    err(`flagship-ensure: ${e.message}`);
    return e instanceof PermissionError ? 2 : 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exitCode = await main(process.argv.slice(2), process.env);
