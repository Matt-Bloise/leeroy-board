/* Cinematic motion tokens (slice 0): the JS twin of css/motion-tokens.css. Not loaded by any page yet; slice 1 wires it in.
   Eight verbs plus hover and the ambient loop period, one ease. Values in milliseconds. */
export const CIN_EASE = "cubic-bezier(.22, 1, .36, 1)";
export const CIN_DURATION = Object.freeze({
  acknowledge: 100,
  hover: 120,
  commit: 240,
  refuse: 200,
  open: 360,
  close: 300,
  arrive: 400,
  milestone: 600,
  ambient: 6000
});
export const CIN_VERBS = Object.freeze(Object.keys(CIN_DURATION));
