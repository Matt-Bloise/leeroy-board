// Offline: does the strict guard still block truncated forms of every 7+ letter roster name (display and alias)? Friend-typed text, the full rule.
// Forms per name: first 5 letters, first 6, minus the last 1 letter, minus the last 2, and the name reversed minus its last letter.
// Roster source: privacy/roster-config.js researchRoster(). Run: node tools/guard-truncations.mjs
// Output is a table by member INDEX, name kind and form: yes/no. It never prints a name or a piece of one.
import { pathToFileURL } from "node:url";
import { scanUserText } from "../infrastructure/worker/privacy/outbound-guard.js";
import { researchRoster, genericAliases } from "../infrastructure/worker/privacy/roster-config.js";
import { skeleton } from "../infrastructure/worker/privacy/skeleton.js";

export const TRUNCATION_FORMS = ["first5", "first6", "minusLast1", "minusLast2", "reversedMinusLast1"];
const formsOf = (key) => ({
  first5: key.slice(0, 5),
  first6: key.slice(0, 6),
  minusLast1: key.slice(0, -1),
  minusLast2: key.slice(0, -2),
  reversedMinusLast1: [...key].reverse().join("").slice(0, -1),
});

export function truncationTable(members, opts = {}) {
  const roster = { members, genericAliases };
  const rows = [];
  members.forEach((m, mi) => {
    for (const [kind, names] of [["display", [m.display]], ["alias", m.aliases || []], ["first", m.firstNames || []], ["character", m.characterNames || []]]) {
      for (const name of names) {
        const key = skeleton(String(name || ""));
        if (key.length < 7 || (kind === "alias" && genericAliases.includes(String(name).toLowerCase()))) continue;
        const forms = {};
        for (const [f, t] of Object.entries(formsOf(key))) forms[f] = scanUserText([`ask ${t} later`], roster, opts).length > 0;
        rows.push({ member: mi, kind, len: key.length, forms });
      }
    }
  });
  return { rows };
}

export function tableReport({ rows }) {
  const lines = [`member kind len ${TRUNCATION_FORMS.join(" ")}   (blocked: yes/no)`];
  for (const r of rows) lines.push(`${r.member} ${r.kind} ${r.len} ${TRUNCATION_FORMS.map((f) => (r.forms[f] ? "yes" : "NO")).join(" ")}`);
  const total = rows.length * TRUNCATION_FORMS.length;
  const passed = rows.reduce((n, r) => n + TRUNCATION_FORMS.filter((f) => !r.forms[f]).length, 0);
  lines.push(`names: ${rows.length}; forms: ${total}; not blocked: ${passed}`);
  return lines.join("\n");
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) console.log(tableReport(truncationTable(researchRoster().members)));
