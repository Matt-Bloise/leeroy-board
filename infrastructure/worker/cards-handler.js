// Discord interactions for the sign-up card (flag CARDS_ENABLED): buttons, the write-in modal and the select modal.
// Pure-ish: every dependency on index.js (intents, cache purge, room broadcast, tally recompute) is passed in, so tests need no Worker.
// Returns an interaction response body (an object) or null when the interaction is not ours.
//   Clicks count only from allowed channels (channels of the stored cards, plus cards.allowedChannels).
//   Replies are ephemeral: one of six rotating confirmation lines. The card itself is redrawn in place by cards.js (coalesced).

import { readModalValues } from "./build-modal.js";
import {
  RSVP_STATES, RSVP_LABEL, cardsEnabled, loadCards, loadSignups, channelAllowed, resolveChoice, sanitiseWriteIn, applySignupChange,
  confirmationLine, describeChange, requestCardEdit, whenOptions, DEFAULT_MEET, WRITE_IN_MAX,
} from "./cards.js";
import { noteSignupChange } from "./board-lines.js";
import { updateKvJson, KvConflictError } from "./kv-cas.js";

const eph = (content) => ({ type: 4, data: { content, flags: 64 } });
export const WRITE_IN_MODAL_ID = "signup:modal:meet";
export const FORM_MODAL_ID = "signup:modal:form";

export function writeInModal() {
  return {
    type: 9,
    data: {
      custom_id: WRITE_IN_MODAL_ID,
      title: "Where are you meeting?",
      components: [{ type: 18, label: `Meeting point (up to ${WRITE_IN_MAX} characters)`, component: { type: 4, custom_id: "place", style: 1, required: true, min_length: 1, max_length: WRITE_IN_MAX, placeholder: "Plain words, no links" } }],
    },
  };
}

const select = (custom_id, label, options, current) => ({
  type: 18,
  label,
  component: { type: 3, custom_id, placeholder: label, required: false, min_values: 0, max_values: 1, options: options.map((o) => ({ label: o.label.slice(0, 100), value: o.value, ...(current === o.value ? { default: true } : {}) })) },
});

// `/signup` with no options: one modal with four selects (Discord allows 5 top-level modal components).
export function signupSelectModal(doc, entry) {
  const e = entry || {};
  const meet = (Array.isArray(doc && doc.options && doc.options.meet) && doc.options.meet.length ? doc.options.meet : DEFAULT_MEET).slice(0, 5);
  const when = whenOptions(doc && doc.options);
  const meetValue = (m, i) => (m === "Valley of Strength" ? "vos" : m === "The Crossroads" ? "xroads" : `m${i}`);
  return {
    type: 9,
    data: {
      custom_id: FORM_MODAL_ID,
      title: "Your launch-night sign-up",
      components: [
        select("rsvp", "Are you in?", RSVP_STATES.map((s) => ({ label: RSVP_LABEL[s], value: s })), e.rsvp),
        select("pack", "Pre-order pack", [{ label: "Yes", value: "yes" }, { label: "No", value: "no" }], e.pack),
        select("meet", "Meeting point", meet.map((m, i) => ({ label: m, value: meetValue(m, i) })), meet.map((m, i) => (m === e.meet ? meetValue(m, i) : null)).find(Boolean)),
        select("when", "When will you arrive?", when.map((w) => ({ label: w, value: w })), e.when),
      ],
    },
  };
}

// Run follow-up work after the reply has gone out (Discord wants an answer within 3 s). With a Workers ctx it runs under waitUntil;
// without one (tests, scripts) it is awaited. A failure here never fails the sign-up, which is already saved.
async function defer(ctx, task) {
  const p = Promise.resolve().then(task).catch(() => {});
  if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(p);
  else await p;
}

// After any sign-up document change (slash command, button, modal, web form): queue a board line, then redraw the card. All deferred.
export function afterSignupChange(env, ctx, before, after, now = Date.now()) {
  if (!cardsEnabled(env)) return Promise.resolve();
  return defer(ctx, async () => {
    await noteSignupChange(env, before, after, now);
    await requestCardEdit(env);
  });
}

// Apply patches ({ field, value }) for one person, persist, and fire the follow-ups. Returns the saved document.
async function applyAndSave({ env, ctx, member, byName, patches, deps, now }) {
  // Compare-and-set (kv-cas.js), 5 tries (about 10 D1 calls, well under 3 seconds): the interaction must be answered within 3 seconds. The patches are applied to the fresh document each try.
  let before = null, entry = null;
  const saved = await updateKvJson(env, "signups", async (cur) => {
    before = cur || { entries: [] };
    let doc = structuredClone(before);
    for (const p of patches) {
      const r = applySignupChange(doc, { name: byName, slug: member.slug, field: p.field, value: p.value, now });
      if (!r.ok) continue;
      doc = r.doc;
    }
    await deps.recompute(doc);
    entry = doc.entries.find((e) => String(e.name || "").toLowerCase() === byName.toLowerCase());
    return { doc };
  }, { tries: 5, now: () => new Date(now).toISOString() });
  const doc = saved.doc;
  await defer(ctx, async () => {
    await deps.insertIntent(env, { slug: member.slug, kind: "signup", body: { patch: Object.fromEntries(patches.map((p) => [p.field, p.value])), entry }, ver: 1, at: new Date(now).toISOString() });
    await deps.purgeWorkerCache(deps.origin, ["/api/bootstrap", "/api/data/signups.json", "/api/signups"]);
    await deps.broadcastToRoom(env, { type: "data", key: "signups", data: doc });
  });
  await afterSignupChange(env, ctx, before, doc, now);
  return doc;
}

export async function handleCardInteraction(args) {
  try {
    return await handleCardInteractionInner(args);
  } catch (e) {
    if (e instanceof KvConflictError) return eph("The sign-ups card is busy. Try again in a moment.");
    throw e;
  }
}

async function handleCardInteractionInner({ interaction, env, ctx, member, byName, deps, now = Date.now() }) {
  if (!cardsEnabled(env) || !interaction || !interaction.data) return null;
  const id = String(interaction.data.custom_id || "");
  if (!id.startsWith("signup:")) return null;
  const [, a, b] = id.split(":");
  if (!member) return eph("I can't tell which party member you are, so I can't change your sign-up.");

  const cards = await loadCards(env.DB);
  if (!channelAllowed(cards, interaction.channel_id)) return eph("Sign-ups only count from the sign-ups channel.");
  const seed = Number(String(interaction.id || "").slice(-6)) || 0;
  const doc0 = interaction.type === 3 || interaction.type === 5 ? await loadSignups(env.DB) : { entries: [] };

  if (interaction.type === 3) {
    if (a === "meet" && b === "other") return writeInModal();
    const value = resolveChoice(a, b, doc0.options);
    if (value === null) return eph("That button is not valid any more.");
    await applyAndSave({ env, ctx, member, byName, patches: [{ field: a, value }], deps, now });
    return eph(confirmationLine(seed, describeChange(a, value)));
  }

  if (interaction.type === 5) {
    const values = readModalValues(interaction.data.components);
    if (id === WRITE_IN_MODAL_ID) {
      const place = sanitiseWriteIn(values.place);
      if (!place) return eph(`That did not look like a place. Use plain words, up to ${WRITE_IN_MAX} characters.`);
      await applyAndSave({ env, ctx, member, byName, patches: [{ field: "meet", value: place }], deps, now });
      return eph(confirmationLine(seed, describeChange("meet", place)));
    }
    if (id === FORM_MODAL_ID) {
      const patches = [];
      for (const field of ["rsvp", "pack", "meet", "when"]) {
        if (values[field] === undefined) continue;
        const value = resolveChoice(field, values[field], doc0.options);
        if (value !== null) patches.push({ field, value });
      }
      if (!patches.length) return eph("Nothing changed.");
      await applyAndSave({ env, ctx, member, byName, patches, deps, now });
      return eph(confirmationLine(seed, patches.map((p) => describeChange(p.field, p.value)).join(", ")));
    }
  }
  return eph("That control is not valid any more.");
}
