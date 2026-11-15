# Hotfix index design: "what changed this week" and the expiry hook

This page designs two things that read the hotfix index from `docs/adr/0011-research-sources-and-hotfix-index.md`: a public "what changed this week" surface and an internal hook that expires stale answers. It holds game facts only. No friend, asker or question data appears in either. Nothing here is built.

## Public surface

A page, and the same data as a Discord command, listing the last 7 days of entries from `hotfix_entries` where `status = 'live'`, newest first.

Each row shows: the post title as a link to the source, the date the source gave (or "seen {date}" when it gave none), the host name, up to three of our own-words bullets, and the topic tags as plain labels. The row may show the stored quote, under 15 words, in quotation marks with the link. It never shows more of the post than that **[docs/compliance/blizzard-checklist.md, link-only rule; ADR 0011 decision 3]**.

Rules:

- The page carries the non-affiliation sentence the site footer already carries, and the label "Summary in our words, not Blizzard's. Open the link for the post." Wording is for the owner to approve.
- Group by day, then by topic when there are more than ten entries in a day. Filter chips by class and by activity (dungeon, profession, PvP) come from the topic tags.
- An entry whose `status` is `retracted` or `superseded` is hidden from the list and shown on its own link with a one-line note.
- Empty week: say "No new posts seen since {last successful check time}". When the watcher has failed for more than 24 hours, say so and give the time of the last good check. Never imply nothing changed when the watcher could not look.
- Served as a cached JSON route plus a static-looking page. The JSON route is read from D1 with one query and cached for the watcher interval. No cookie, no sign-in, no per-person content, so it is safe to cache publicly **[inferred]**.
- A short "this week" digest in a channel is a later option and needs a follow-up decision about posting; it is not part of this design.

Query shape (sketch):

```sql
SELECT url, title, posted_at, seen_at, source_host, quote, bullets_json, topics
FROM hotfix_entries
WHERE status = 'live' AND COALESCE(posted_at, seen_at) >= ?1
ORDER BY COALESCE(posted_at, seen_at) DESC
LIMIT 100;
```

## Internal expiry hook

A function `expireForEntry(env, entry)` called by the watcher after it writes a new or changed entry, in the same D1 `batch` where possible.

Inputs: the entry id and its topic tags. Nothing else.

Steps:

1. Cached answers: select cache rows whose topic tags intersect the entry's and whose volatility rule says they expire (ADR 0011, freshness table). Delete them or set `expires_at` to now. Record each in `answer_expiry` with kind `cache`.
2. Golden references: mark intersecting references `stale` and exclude them from the gate pass rate until a person re-confirms. Record kind `golden`. No automatic rewrite.
3. Open questions: queue an immediate re-check for intersecting rows. Record kind `open_question`.
4. Return counts only: `{cache, golden, open_question}`.

Properties to test when built:

- Idempotent: running twice on the same entry changes nothing the second time.
- Topic match is exact on normalised tags; an entry with no tags expires nothing and is flagged for a person.
- Bounded: at most N rows per call (for example 200), with the remainder carried to the next run, to stay inside the 10 ms CPU and 50 subrequest limits.
- A retracted entry re-runs expiry once.
- No text from any question, answer or person is read or logged by the hook.

## Open items

- Topic vocabulary: who writes it and how an unknown topic is handled. Without tags the hook can expire nothing.
- Cache and golden rows need a `topics` column; neither has one today **[inferred, not checked]**.
- The watcher's real cost, which the source probe measures first.
