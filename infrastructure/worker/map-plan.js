// /map plan: which meeting points a route plan can be charted to.
// The Atlas charts a plan for any place id that routes from at least one class start (atlas/atlas.js showPlan: makePlan(...).who is not empty).
// MAP_PLAN_PLACES is that set, copied out of data/atlas (the Worker does not bundle the atlas data);
// tests/unit/discord-components.test.mjs recomputes it from data/atlas/*.json with atlas/routes.js and fails on drift.
export const MAP_PLAN_PLACES = [
  { value: "orgrimmar", name: "Orgrimmar" },
  { value: "undercity", name: "Undercity" },
  { value: "deathknell", name: "Deathknell" },
  { value: "red-cloud-mesa", name: "Red Cloud Mesa" },
  { value: "valley-of-trials", name: "Valley of Trials" },
  { value: "valley-of-strength", name: "Valley of Strength" },
  { value: "bloodhoof-village", name: "Bloodhoof Village" },
  { value: "brill", name: "Brill" },
  { value: "razor-hill", name: "Razor Hill" },
  { value: "the-crossroads", name: "The Crossroads" },
  { value: "zeppelin-tower-gromgol", name: "Zeppelin Tower, Grom'gol" },
  { value: "zeppelin-tower-orgrimmar", name: "Zeppelin Tower, Orgrimmar" },
  { value: "zeppelin-tower-undercity", name: "Zeppelin Tower, Undercity" },
];
// Short names the board and old copy used.
export const MAP_PLAN_ALIASES = { vos: "valley-of-strength", crossroads: "the-crossroads", xroads: "the-crossroads" };
const DEFAULT_MEET = ["Valley of Strength", "The Crossroads"];
// Same slug as the board's MEM.slug (js/board.js).
export const slugOf = (n) => String(n).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

// The choices on offer: every routable place, then each sign-up meeting point the admin configured (signups.options.meet) that is not already listed.
export function mapPlanChoices(signups) {
  const out = MAP_PLAN_PLACES.map((p) => ({ ...p }));
  const configured = Array.isArray(signups && signups.options && signups.options.meet) && signups.options.meet.length ? signups.options.meet : DEFAULT_MEET;
  for (const raw of configured) {
    if (typeof raw !== "string") continue;
    const value = slugOf(raw).slice(0, 40);
    if (value && !out.some((c) => c.value === value)) out.push({ value, name: raw.trim().slice(0, 100) });
  }
  return out;
}
// Resolve what the user typed to a choice, or null. `plan` is already lowercased and reduced to [a-z0-9_-].
export function resolveMapPlan(plan, signups) {
  const key = MAP_PLAN_ALIASES[plan] || plan;
  return mapPlanChoices(signups).find((c) => c.value === key) || null;
}
