// The small JSON Schema subset validator for docs/openapi.yaml (the OpenAPI 3.0 keywords the spec uses), shared by
// tests/api/contract.test.mjs (live responses) and tests/unit/api-snapshot-contract.test.mjs (the recorded fixtures). No network, no env.
// The YAML is parsed with `yaml` (devDependency of tests/).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

export const spec = parse(readFileSync(fileURLToPath(new URL("../../docs/openapi.yaml", import.meta.url)), "utf8"));

// ---- validator -------------------------------------------------------------------------------------------------
export const resolve = (s) => {
  let guard = 0;
  while (s && s.$ref) {
    if (++guard > 20) throw new Error("$ref loop");
    s = s.$ref.replace(/^#\//, "").split("/").reduce((o, k) => o[k], spec);
  }
  return s;
};
const typeOf = (v) => (v === null ? "null" : Array.isArray(v) ? "array" : Number.isInteger(v) ? "integer" : typeof v);
export function validate(value, schema, at = "$") {
  const s = resolve(schema);
  const errs = [];
  if (!s || Object.keys(s).length === 0) return errs;
  if (value === null) return s.nullable ? errs : [`${at}: null is not allowed`];
  if (s.type) {
    const t = typeOf(value);
    const ok = s.type === t || (s.type === "number" && t === "integer");
    if (!ok) return [`${at}: expected ${s.type}, got ${t}`];
  }
  if (s.enum && !s.enum.includes(value)) errs.push(`${at}: ${JSON.stringify(value)} not in enum ${JSON.stringify(s.enum)}`);
  if (typeof value === "string") {
    if (s.minLength != null && value.length < s.minLength) errs.push(`${at}: shorter than ${s.minLength}`);
    if (s.pattern && !new RegExp(s.pattern).test(value)) errs.push(`${at}: does not match ${s.pattern}`);
    if (s.format === "date-time" && Number.isNaN(Date.parse(value))) errs.push(`${at}: not a date-time`);
  }
  if (Array.isArray(value) && s.items) value.forEach((v, i) => errs.push(...validate(v, s.items, `${at}[${i}]`)));
  if (typeOf(value) === "object") {
    for (const k of s.required || []) if (!(k in value)) errs.push(`${at}: missing required "${k}"`);
    for (const [k, v] of Object.entries(value)) {
      if (s.properties && k in s.properties) errs.push(...validate(v, s.properties[k], `${at}.${k}`));
      else if (s.additionalProperties && typeof s.additionalProperties === "object") errs.push(...validate(v, s.additionalProperties, `${at}.${k}`));
      else if (s.additionalProperties === false) errs.push(`${at}: unexpected "${k}"`);
    }
  }
  return errs;
}

