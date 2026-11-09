// Leeroy-voice copy for the member-facing slash replies (AR145). Pure string builders: no I/O, no Discord shape.
// Rules: the speaker is Leeroy; inform, never instruct; no personal callouts; no @mentions; every fact, link and number
// of the original reply survives. Staff surfaces (/intents, /ack, /answer, /setup) and data cards stay plain.
export const SLASH_COPY = {
  sheetUpdated: (name, field, value, url) => `Done. **${name}**'s sheet now reads **${field}** = \`${value}\`. The board has it: ${url}`,
  sheetEmpty: () => "Nothing custom on the sheet yet. Even legends start blank.",
  launchHeader: () => "**Launch Night Status**: who is in the queue, who is in the world, who is done. Leeroy keeps count so nobody has to.",
  mapLine: (label, url) => `**${label}**, charted for you on the Living Board: ${url}`,
  signupLogged: (name, summary, url) => `Logged, **${name}**: ${summary}. The board knows: ${url}`,
  signupStatusHeader: (name) => `**${name}'s sign-up status**, as the board has it:`,
  datesFooter: () => "Blizzard's verified dates, shown in your local time. Certainty ratings are included because hope is not a source.",
  libraryBody: (nPosted, posted, nComing, coming, url) =>
    `Leeroy cannot read what is not shelved yet.\n\n**On the Shelves (${nPosted}):**\n${posted}\n\n**Coming Soon (${nComing}):**\n${coming}\n\nOpen full library on the Living Board: ${url}`,
  didYouKnow: (text, tag, thread, asOf) => `**Did you know?** (Leeroy did.) ${text}\n-# ${tag} (${thread} thread, as of ${asOf})`,
  build: (name, mention, url) => `**${name}'s build**: ${mention}\n-# Class and spec planning lives there; the party sheets are at ${url}`,
  tooltipMissing: (name) => `No tooltip for "${name}". Leeroy checked every shelf he owns. \`/page\` or \`/ask\` may know more.`,
  journey: (choiceUpper, effect) => `Set to **${choiceUpper}**. ${effect}\n-# Change it any time with \`/journey\`; nobody is graded.`,
  voteUsage: () => "`/vote start` takes a title and 2 to 5 choices separated by |. Leeroy only counts; the party decides.",
  voteNotMember: () => "Leeroy cannot tell which party member you are, so starting a vote is a party matter. Pressing the buttons on one is open to anyone.",
  join: () => "You are not on the board yet. It takes a minute: a game handle, your class, race and role, and the party sees you there.",
  quizSpoilerFooter: () => "-# Tap the spoiler bar to reveal. No prizes; the glory is yours and Leeroy takes none of it.",
  pageMissing: (title) => `No library page called "${title}" on any shelf Leeroy knows.`,
  pageMissingTail: () => " `/library` lists them all.",
  tonightRsvp: () => "Your launch-night RSVP is not recorded yet; `/signup rsvp:in` records it.",
  tonightMeet: () => "Meeting point is open: `/signup meet:` takes Valley of Strength or The Crossroads.",
  tonightDone: () => "Your launch-night answers are in. The awesomeness approves; `/sheet` shows the rest.",
  startLines: (siteUrl) => [
    "Tis I, Leeroy Jenkins. This is the party's shared board for WoW: Forever.",
    "Your character sheet, your build and the launch-night plan live in one place, so nobody asks the same question twice.",
    "Everything you post in Discord (forms, threads, votes) lands there too. At least I have chicken.",
    siteUrl,
  ],
};
