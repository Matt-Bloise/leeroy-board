# Five-second test script

This page is the script for the five-second test: how to show a screen to a stranger, what to ask, how to score it, and where to record the result. It runs on every slice that changes what a person sees. Friends test tasks; strangers test comprehension, because a friend already knows what the board is.

## Who

Five people per slice who have never seen the board and are not in the guild. They do not need to play WoW. Do not coach, explain or react. One person at a time, on a phone (the named phone once chosen; until then any recent phone), at full brightness, on the live preview link.

## The task

1. Hand over the phone with the page already loaded and the screen locked to the first screen. Say only: "I will show you a screen for five seconds. Then I will ask two questions."
2. Unlock and start a timer. After five seconds, lock the screen or cover it.
3. Ask, in this order, and write the answer word for word:
   - **Q1 purpose:** "What is this for?"
   - **Q2 next action:** "What would you do next?"
4. Optional third question, for the notes only: "What did you look at first?"
5. Do not say whether an answer was right.

Run it on the two starting screens: the first visit (Next steps, nobody signed in) and the home board (the table).

## Scoring

Score each answer 1 or 0 before reading the next person's.

| Question | Scores 1 when the answer says | Scores 0 when |
|---|---|---|
| Q1 purpose | a group or guild companion for a game, or a place to see who is coming and what is next | it names only the look ("a fantasy thing"), or says it does not know |
| Q2 next action | the real next step for that screen: on first visit, sign in or look around; on the table, open a tile, check who is coming, or search | it names something that is not on screen, or says it does not know |

A person passes when both answers score 1. The slice passes the test when **4 of 5 people pass**. Fewer than 4 means the screen is revised and the test re-run with five new strangers; the five used before are not reused.

A vision model may rehearse the test to catch obvious failures before strangers are recruited. Its answers never count toward the 4 of 5.

## Record

Append one row per person to `docs/cinematic/stranger-results.md` (create it on the first run) in this form, and attach no names:

```text
| date (UTC) | slice | screen | device | Q1 answer | Q1 | Q2 answer | Q2 | first-look note |
```

Add a summary line per run: slice, screen, passes out of 5, and the commit it ran against. The pull request that changes the screen links the summary line in its body.

## Rules

- Same five seconds for everyone, timed, not estimated.
- Same wording for the questions; do not rephrase.
- A person who guesses the product from a friend's description is replaced, not scored.
- Keep the plain baseline screen available beside the changed one; when the changed screen scores lower, the change is revised, not the test.
