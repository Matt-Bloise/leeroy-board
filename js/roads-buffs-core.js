/* Cinematic slice 6: Buffs and roads, the pure parts. No DOM, no clock, so Node imports it and tests/unit/roads-buffs.test.mjs covers it.
   (1) glance: "who buffs whom" as plain rows, one per giver and audience.
   (2) hapticFor: which haptic grammar word a buff-level change earns (a light tick per step, a tap on a mark). */

const LANDS = {
  all: () => ({ everyone: true }),
  mana: () => ({ everyone: true }),
  one: () => ({ pick: true }),
  dead: () => ({ fallen: true }),
  tank: (m) => m.role === "tank",
  healer: (m) => m.role === "healer",
  melee: (m) => m.class_key === "druid" || m.class_key === "paladin",
};

/* One row per giver and audience: { giver, cls, className, to: "everyone" | "Santa and Street Rat" | "one person you pick", buffs: [names] }.
   Buffs with the same audience on one giver share a row, so a glance reads "Bible Boi to everyone: Power Word: Fortitude, Divine Spirit". */
export function glance(list, members, { sixth = false } = {}) {
  const and = (a) => (a.length < 2 ? a.join("") : a.length === 2 ? a.join(" and ") : `${a.slice(0, -1).join(", ")} and ${a[a.length - 1]}`);
  const rows = [];
  for (const m of members) {
    const byTo = new Map();
    for (const b of list.filter((x) => x.class === m.class_key && (!x.sixth || sixth))) {
      const rule = LANDS[b.lands] || LANDS.all, r = rule(m);
      let to;
      if (r && r.everyone) to = "everyone";
      else if (r && r.pick) to = "one person you pick";
      else if (r && r.fallen) to = "a fallen friend";
      else to = and(members.filter((x) => rule(x)).map((x) => x.name)) || "nobody in this party";
      if (!byTo.has(to)) byTo.set(to, []);
      byTo.get(to).push(b.name);
    }
    for (const [to, buffs] of byTo) rows.push({ giver: m.name, cls: m.class_key, className: m.class, to, buffs });
  }
  return rows;
}

/* Level change -> haptic word. A step is a light tick ("boundary", 5 ms); landing on a mark (20, 40, 60) is the "select" tap. Same level: nothing. */
export function hapticFor(prev, next, marks = []) {
  if (!Number.isFinite(next) || next === prev) return null;
  return marks.includes(next) ? "select" : "boundary";
}
