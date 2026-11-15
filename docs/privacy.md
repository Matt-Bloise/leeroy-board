# Privacy

leeroy.party is a board for a small group of friends who play WoW Forever. Matt Bloise runs it. Uncle Jimmy built the back end. It is a fan project and has nothing to do with Blizzard. A lawyer has not yet reviewed this page. It describes what the board does today and is not legal advice.

## What we keep

- Your game character details: name, race, class, role, and the sheet fields you or the group fill in.
- Your sign-up answers for raids and events.
- Your Discord name and your Discord user number, so the board knows who you are.
- Your settings on the board, saved when you sign in.
- The questions you ask Leeroy, the answers, and which AI model answered.
- A private fingerprint (a salted hash) of who asked each question, so a question can be found and removed later.
- Your votes on board polls, stored under a fingerprint of your Discord number.
- A daily count of how many AI questions you used.
- If you ask on the web as a guest with no key: a fingerprint of your internet address and the time, to limit guests to a few questions an hour. We do not store the address itself.

We do not store your email, a password, or your Discord picture. The board does not read your picture. A party card posted in Discord in October 2026 used profile pictures.

## Why we keep it

To sign you in, to show the group's board, to answer your questions, and to stop abuse. We do not use your data for advertising or profiling.

## Who can see it

- Anyone with the link can read the public board pages. The party list, sign-ups and timeline are open to anyone who asks the server. They have no sign-in. If your character or sign-up is on the board, a stranger could read it. Every line of your sheet has a hide switch (race, class, spec path, spec at 40, professions, plan zone, level, launch night and goals). A line you hide is removed from the sheet list and the party list, together with the lines that come from it (hide your class and your spec, colour and build line go too). Your name and role always stay shown, and so do your sign-up answers, the meeting place, and the times your sheet and your launch row last changed. The size and roles of the party stay visible. While any member hides anything, the shared planning pages (decide, buffs, the atlas guide, tonight's suggestions) go blank and show one line: Part of this is hidden because a member keeps their build private. A change is in force on the very next read of the server: the party, the shared planning pages and the sheet list are never held in a cache. A page you already have open shows it when it next loads or refreshes. A copy of the board that is served without the API reads the files directly, so it does not follow hide switches.
- The first members' builds are also in the board's public code and in files on the site, and in older commits; hiding a field does not remove them there.
- A scan of those open pages on 8 November 2026 found no emails, tokens or secrets.
- Matt and the group admins can see names, roles, builds and sign-ups.
- Answers marked shared are visible to the group.
- The admin pages, your own settings and your own sheet refuse anyone who is not signed in.

## Other companies that handle it

- Cloudflare hosts the board and the database. It also keeps its own request logs, which include your internet address. We do not control those logs. Cloudflare also adds a visit-counting script to leeroy.party. We have not yet checked what it records.
- Discord handles the bot commands, and the web sign-in when that is switched on (it is off today). As of 9 November 2026 the bot receives your slash commands, button presses, direct messages to it, and messages that mention it. Discord does not send it the text of ordinary channel messages. Only the owner can add the bot to a server.
- When you ask Leeroy a question, we send your name, your question, and the party's names and builds to an AI company so it can answer (while any member hides anything, one line stands in for the other members' builds), and, when you ask privately, your own hidden sheet fields. Several AI companies can be used. They may keep a copy under their own rules.

**When Leeroy's research mode is on** (it is off today; this says what changes when it is switched on), a member's question goes to one AI company only: Anthropic, through its paid API. It goes to no free-tier model and to no other company, and nothing is sent to a second provider if Anthropic cannot be reached.

- What is sent to Anthropic: your name as the board knows it, the party's real names, the sheet lines that are shown (class, race, level, professions, plan, goals and the other lines nobody has hidden), builds, sign-ups and tonight's plan, your own last few questions and Leeroy's answers to you from the past day (at most three), and the question itself. When you ask privately, your own hidden sheet fields are included as before.
- The members of the group have agreed to this. Anthropic's terms for its paid API say it does not train its models on what is sent through the API, and it may keep a copy under its own rules.
- What is screened before sending, on a best effort basis: the Worker looks for named patterns (its own keys and secrets, API keys and tokens for Anthropic, Discord, GitHub, Google, AWS and Slack, Bearer and Basic authorisation headers, web tokens, long hexadecimal strings, webhook links) and for long Discord numbers. A secret in the text you type stops the question from being sent. A secret found in a sheet line or a sign-up is blanked out and the question still goes. A long Discord number is replaced by a marker. This is a pattern screen, not a promise: a typed password in free text is not reliably caught, and neither is a short token. Do not put secrets in a question or on your sheet. Mention pings (everyone, here, a person, a role) are broken before sending and in the reply, and your text is marked as data so a pasted instruction cannot change how Leeroy behaves.
- If Anthropic cannot be reached, Leeroy says so in its own voice, may show the library's own facts, and the record marks that answer as degraded.
- Where it is kept: the question, the answer and the model label are stored in our database at Cloudflare only, under the same rules as every other question on this page (until you ask us to delete them). Your earlier questions are read back from that database for the next prompt only for 24 hours. None of this is written to the public code.
- A setting called research names can switch the real names back to stand-in tokens before anything is sent.
- Visitors who are not members never go to Anthropic. Their questions are answered by Cloudflare's own AI service, with names replaced by stand-ins. If the names cannot be replaced for a question, it is not sent to any AI: the visitor gets the library's own facts instead.
- AI Gateway: the Claude request can pass through Cloudflare's AI Gateway. If request logging is switched on in the Cloudflare dashboard for that gateway, the gateway would hold the prompts, real names included, until they are deleted there. We have not set a per-request setting to stop that.
- Nothing goes to Blizzard.

So do not type anything private into a question. Two message actions work on someone else's message: "Ask Leeroy" stores that message as the question and sends it to the AI company, and "Fix this fact" stores the first 200 characters. Do not use them on a message that holds private information.

## The device check

The device check page (`/#probe`) shows you what your browser reports before anything is sent. It is sent only if you press Send, together with your member key. It holds yes/no answers and small numbers about your screen, touch, motion and browser. It has no name, no Discord number and no free text. The board acknowledges it and does not store it.

## How long we keep it

- Web sign-in sessions last 30 days. Web sign-in is off today.
- Guest address fingerprints become eligible for deletion after 2 hours. They are cleared when another guest asks a question, so they can stay longer when no guest asks.
- Most other things (characters, sign-ups, questions and answers, votes, counters) stay until you ask us to delete them. Nothing deletes them on a timer.
- Backups and Cloudflare or AI company copies can last longer, on their schedule.

## What your browser keeps

Your member key is saved in your browser, as plain text, so you stay signed in. Treat a link that ends in `#k=` like a password. The "Forget me on this browser" button removes it.

## No cookies, no ads, no selling

We set no cookies today. We show no ads. We do not sell your data or share it for ads.

## How to ask us to delete your data

Message Matt on Discord, or email the contact address below. Say what you want removed. Matt will run the delete for you. The self-serve delete button is built but turned off for now, so a person does it by hand.

What a delete removes: your account and what hangs off it (characters, builds, sign-ups, settings, web sign-in sessions), your poll votes, your daily AI counters, and the questions and answers we can tie to you. It leaves one record that says a delete happened and when, with nothing that links it to you.

What it does not remove:

- Your card and name on the shared party list and sign-up list. An admin edits those by hand.
- Your entry in the Discord member list the bot uses. It stays until an admin edits it, so the bot still treats you as a member.
- Some questions. Which ones we can find depends on how you asked. A question you asked on Discord without being on the member list is stored under your Discord nickname, and older ones carry no fingerprint, so a person has to find them by hand. Questions asked on the web as a guest are not linked to anyone and cannot be found. Sheet edits and similar rows filed under your handle are found only when the request is made with your member key.
- Copies held by Cloudflare, Discord, the AI companies, and old backups.

Because of those exceptions, Matt checks them by hand before he tells you the delete is complete.

Contact: [privacy@leeroy.party](mailto:privacy@leeroy.party)

## Kids

Do not use the board if you are under 13. Discord does not allow it either.

## Changes

We will change the date on this page when the rules change. Last changed: 15 November 2026.
