// Ties the recorded API fixtures (tests/fixtures/api-snapshot/snapshot.json, which every browser suite is answered from) to the API contract
// (docs/openapi.yaml, the shapes tests/api/contract.test.mjs checks on the live Worker). When a response shape changes in the spec or the
// Worker and the snapshot is not re-recorded, this fails: tools/local-browser.sh record-fixtures. Offline, no Worker request, no env.
// Needs `yaml` (npm ci in tests/), through tests/helpers/openapi-validate.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { validate, spec, resolve } from "../helpers/openapi-validate.mjs";
import { loadSnapshot, repoDoc, SNAPSHOT_PATH } from "../helpers/api-stub.mjs";

const snap = loadSnapshot(SNAPSHOT_PATH);
const schemaFor = (route, status) => {
  const op = spec.paths[`/api${route}`] && spec.paths[`/api${route}`].get;
  assert.ok(op, `snapshot route ${route} is not a documented GET in docs/openapi.yaml`);
  const resp = op.responses[String(status)];
  assert.ok(resp, `GET /api${route}: status ${status} is not documented`);
  return resolve(resp).content["application/json"].schema;
};

test("snapshot: only documented GET routes, each answering a documented status as JSON", () => {
  assert.ok(Object.keys(snap.routes).length >= 3, "bootstrap, state and votes are recorded");
  for (const [route, hit] of Object.entries(snap.routes)) {
    schemaFor(route, hit.status);
    assert.match(hit.type, /^application\/json/, `${route}: content type`);
    assert.doesNotThrow(() => JSON.parse(hit.body), `${route}: body is JSON`);
  }
});

for (const route of ["/bootstrap", "/state", "/votes"]) {
  test(`snapshot ${route} matches the contract (same schema the live API test uses)`, () => {
    const hit = snap.routes[route];
    assert.ok(hit, `${route} is missing from the snapshot: the browser suites would stub-miss it`);
    assert.equal(hit.status, 200);
    const errs = validate(JSON.parse(hit.body), schemaFor(route, hit.status));
    assert.deepEqual(errs, [], `${route} drifted from docs/openapi.yaml; re-record with tools/local-browser.sh record-fixtures:\n${errs.join("\n")}`);
  });
}

test("snapshot /votes exposes no ballots or hashes (same guard as the live API test)", () => {
  assert.ok(!/ballots|voter|hash/i.test(snap.routes["/votes"].body));
});

test("the repo documents the stub serves from data/ match the Document schema", () => {
  const doc = resolve(spec.paths["/api/data/{name}"].get.responses["200"]).content["application/json"].schema;
  for (const key of ["/data/party.json", "/data/timeline.json", "/atlas/marks.json"]) {
    const hit = repoDoc(key);
    if (!hit) continue; // only documents that exist in data/ are served; a missing one is a stub miss in the browser suites, not a contract question
    assert.deepEqual(validate(JSON.parse(hit.body), doc), [], `${key} does not match the Document schema`);
  }
});

test("the check bites: a snapshot with a required field removed, or a field of the wrong type, fails validation", () => {
  const schema = schemaFor("/bootstrap", 200);
  const good = JSON.parse(snap.routes["/bootstrap"].body);
  assert.deepEqual(validate(good, schema), []);
  const required = resolve(schema).required || [];
  assert.ok(required.length, "the Bootstrap schema names required fields");
  const broken = { ...good }; delete broken[required[0]];
  assert.ok(validate(broken, schema).length, `removing ${required[0]} must fail`);
  assert.ok(validate("not an object", schema).length, "a string instead of an object must fail");
});
