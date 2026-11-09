# Privacy

leeroy.party is a private board for a small group of friends who play WoW Forever. Matt Bloise runs it. Uncle Jimmy built the back end. It is a fan project and has nothing to do with Blizzard. A lawyer has not yet reviewed this page. It describes what the board does today and is not legal advice.

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

We do not store your email, a password, or your Discord picture.

## Why we keep it

To sign you in, to show the group's board, to answer your questions, and to stop abuse. We do not use your data for advertising or profiling.

## Who can see it

- Anyone with the link can read the public board pages. The party list, sign-ups and timeline are open to anyone who asks the server. They have no sign-in. If your character or sign-up is on the board, a stranger could read it.
- A scan of those open pages on 8 November 2026 found no emails, tokens or secrets.
- Matt and the group admins can see names, roles, builds and sign-ups.
- Answers marked shared are visible to the group.
- The admin pages, your own settings and your own sheet refuse anyone who is not signed in.

## Other companies that handle it

- Cloudflare hosts the board and the database. It also keeps its own request logs, which include your internet address. We do not control those logs. Cloudflare also adds a visit-counting script to leeroy.party. We have not yet checked what it records.
- Discord handles the bot commands, and the web sign-in when that is switched on (it is off today). As of 9 November 2026 the bot receives your slash commands, button presses, direct messages to it, and messages that mention it. Discord does not send it the text of ordinary channel messages. Only Matt can add the bot to a server.
- When you ask Leeroy a question, we send your name, your question, and the party's names and builds to an AI company so it can answer. Several AI companies can be used. They may keep a copy under their own rules.
- Nothing goes to Blizzard.

So do not type anything private into a question. Two message actions work on someone else's message: "Ask Leeroy" stores that message as the question and sends it to the AI company, and "Fix this fact" stores the first 200 characters. Do not use them on a message that holds private information.

## The device check

The device check page (`/probe`) shows you what your browser reports before anything is sent. It is sent only if you press Send, together with your member key. It holds yes/no answers and small numbers about your screen, touch, motion and browser. It has no name, no Discord number and no free text. The board acknowledges it and does not store it.

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

We will change the date on this page when the rules change. Last changed: 9 November 2026.
