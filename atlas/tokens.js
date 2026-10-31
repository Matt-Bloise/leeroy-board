const ID = "[a-z0-9][a-z0-9-]{0,59}";
const RES = {
  home: /^atlas$/,
  view: /^atlas\.v\.(\d{1,5})\.(\d{1,5})\.(\d{1,2})$/,
  zone: new RegExp(`^atlas\.z\.(${ID})$`),
  plan: new RegExp(`^atlas\.plan\.(${ID})(?:~([a-z]{3,12}))?$`),
  place: new RegExp(`^atlas\.(${ID})$`),
};
const RESERVED = new Set(["z", "v", "plan"]);
export const SAFE = /^[A-Za-z0-9._~-]*$/;

export function parse(token) {
  if (typeof token !== "string") return null;
  const t = token.replace(/^#/, "");
  if (!SAFE.test(t) || t.length > 140) return null;
  let m;
  if (RES.home.test(t)) return { kind: "home" };
  if ((m = RES.view.exec(t))) {
    const zoom = Number(m[3]) / 10;
    return zoom <= 5 ? { kind: "view", au: Number(m[1]), av: Number(m[2]), zoom } : null;
  }
  if ((m = RES.zone.exec(t))) return { kind: "zone", id: m[1] };
  if ((m = RES.plan.exec(t))) return m[2] ? { kind: "plan", meet: m[1], who: m[2] } : { kind: "plan", meet: m[1] };
  if ((m = RES.place.exec(t)) && !RESERVED.has(m[1])) return { kind: "place", id: m[1] };
  return null;
}

export function make(state) {
  if (!state || typeof state !== "object") return null;
  let t = null;
  switch (state.kind) {
    case "home": t = "atlas"; break;
    case "place": t = `atlas.${state.id}`; break;
    case "zone": t = `atlas.z.${state.id}`; break;
    case "plan": t = `atlas.plan.${state.meet}${state.who ? `~${state.who}` : ""}`; break;
    case "view": {
      const z = Math.max(0, Math.min(50, Math.round(state.zoom * 10)));
      t = `atlas.v.${Math.max(0, Math.min(99999, Math.round(state.au)))}.${Math.max(0, Math.min(99999, Math.round(state.av)))}.${z}`;
      break;
    }
    default: return null;
  }
  return parse(t) ? t : null;
}

export const isToken = (t) => parse(t) !== null;
