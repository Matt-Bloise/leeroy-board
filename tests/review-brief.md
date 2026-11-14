# Adversarial review brief

Shared checklist for the advisor, each builder's self-review and every independent reviewer. Built from the 2026-11-14 reviews; the evidence for each class is in `docs/review-classes.md` (same numbers). Fictional data only: no friend names, Discord content or secrets in a probe, a report or a commit.

## How to use it

1. Read the diff, then the producer of every value it touches (the Worker response, the call site), not only the test.
2. For each class below that the diff can reach, try the "break it" step. Skip a class only by saying why it cannot apply.
3. Run the new tests against the unfixed code. They must fail for the stated reason. Report the command.
4. Report per class: tried, broke, held, not checked. Every finding gets an evidence class (live, hand-read) and a repro file. Rate each finding high, medium or low, and say what is new in this change versus already on master.
5. When a failure appears once in a full run, capture the test name before rerunning (class 15).

## Checklist

1. **Stale or cached document.** Feed the old document after the new one, equal age, no stamp, through every ingress (`/state`, bootstrap, socket, cache). Read with the admin token, write, then read anonymously without purging. Check the purge list names the URL the site fetches.
2. **Event ordering.** Build the sequence from what the Worker returns (the web POST applies the edit and returns `at`), then interleave web edit, card click and snapshot. Two writes committing out of stamp order. A restored edit after reload.
3. **Null or non-object rows.** Every function that reads `entries` or `members`: rows of `null, undefined, 5, "x", true, [], [1]`, and the container as each of those.
4. **Identifier as credential.** Anything that is an id, slug or name: does knowing it unlock a read or a socket frame? Send the id alone, another member's key, a same-name session, a missing hash row. A "no row" must not mean "allow".
5. **Private field on a public path.** Put a marker in every private store. Read every public route with and without a query string (`?full=1&roster=1&admin=1`), and send every broadcast shape plus one with a new or renamed key. Values inside an allowed `data` or `party` payload count. Transforms of a canary (base64, reversed, cut) count.
6. **Regex inverts or deletes.** Feed values whose trailing aside is: date only, source only, date plus caveat, caveat plus source, nested, comma list, semicolon list, a caveat containing a source word. Check every shown clause is a substring of the raw value. Does the filter run on the raw value or the shown one?
7. **Normaliser invents tokens.** NFKC, zero-width, line separator and superscript or fraction characters inside a number. Output digits must be a subset of input digits, or the path refuses.
8. **Wrong audience.** For each member, spec spelling, form, race and role: does text for another one reach them? Jargon, trivia, patch history, build numbers as subjects, "a tester said". Is the same fact shown every week (small pools)?
9. **Flag off.** Unset, `off`, `OFF`, `" on"`, `true`, `1`, `["on"]`, a non-string. Differential against `git archive origin/master`: return value, stored rows, prompts, broadcasts, stats. Does the harness pass an asker, so follow-ups and reused answers run?
10. **Re-stamp.** The same value twice, at two times: stamp, `changed`, tallies, broadcast, Discord edit, "newer" copy on the page. Which fields re-stamp, and which consumers read the stamp?
11. **Timestamps.** ISO Z, offset, no zone, date only, epoch number, epoch string, one hour and one year ahead, empty, junk, wrong type. Does anything compare stamps as strings? Does a printed time say UTC for a local read?
12. **Length limits.** Sweep roster size from 0 past any real size with names at the cap. 2000, 1900 budget, 1024, 6000, 120. Every cut must say so ("and N more") and never leave a heading alone.
13. **Injection.** `@everyone`, `<@&id>`, `<#id>`, masked link, titled link, bare URL, `discord.gg/x`, heading, quote, code, spoiler, direction override, zero-width, newline, in every name, free-text field, fact and source label. Is `allowed_mentions` set at the send site?
14. **Impossible sequence.** For each new test, derive its starting state from the producer and name the call that creates it. If you cannot, the test may encode a state the system never reaches. Run it on the unfixed code.
15. **Flake versus real.** A single red in a full run: name the test, rerun it alone ten times, then the full suite. Unknown cause is reported as unknown, not as a flake. Run from a nested worktree? Check the scan excludes `.claude/worktrees` and `_scratch`; check dependencies are installed.
16. **Guard that cannot fail.** For a new contract or regression test, apply five leak mutations (rename a field, nest it, transform it, add a call site, widen an allow list) and say how many it kills. A regenerate-the-allow-list switch must refuse in CI.
17. **Fail-closed refuses the valid.** Round trip: any one retrieved fact, composed, formatted, verified, must be accepted. Titles and values with each formatter trigger (dash, colon, dot, bold, space before a comma). What does a user see when the provider is down?
18. **Fail-open.** Corrupt, missing and throwing variants of every row a route reads. An empty `catch {}` on a read is a finding.
19. **Loose keys.** Names that collide after decoration, width, combining marks or case; same name with different slugs; slug and name that disagree; a build word matching any slug segment.
20. **Claims and windows.** Inject a failure after each step of claim, post and ledger write. Simulate two years of ticks with the real cron and quiet hours for each lead value. Does a dry run print what the run prints?
21. **Copy truth.** For each sentence template, write the condition that makes it true and build a board that violates it (all tentative, unmatched, none, many). Does a count come from the documents or from a config row?
22. **Object-property words.** `constructor`, `__proto__`, `toString` as a role, class, rsvp, spec, name and key, wherever `table[value]` is read.

## Report shape

Verdict (PASS or FAIL) first. Then findings ranked by severity with where, repro and consequence. Then the checklist tally (tried, broke, held, not checked). Then the suite counts from `node --test "tests/unit/*.test.mjs"` and the state of `git status`. Read-only unless told otherwise: restore anything touched.
