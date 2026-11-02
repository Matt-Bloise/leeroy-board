# Runbook: personal data breach

Last checked: 2026-11-02. **DRAFT; clocks marked "unverified" must be confirmed by counsel (Q42) before being relied on.** Not legal advice. Pairs with `incident.md` (general incidents), `secrets.md` (rotation) and `backup-restore.md`. Contact details are not kept in this repository; use the owner's private notes.

## What counts

A breach of security leading to accidental or unlawful destruction, loss, alteration, unauthorised disclosure of, or access to, personal data (GDPR Art. 4(12)). Examples here: a leaked `BOARD_ADMIN_TOKEN` or database export, member keys exposed, D1 rows readable by the wrong tenant, an AI vendor sent data it should not have, an account takeover. If in doubt, treat it as a breach and decide later.

## The clocks

| Clock | Starts | Deadline | Who is told | Status |
| :--- | :--- | :--- | :--- | :--- |
| GDPR Art. 33(1) | Controller becomes **aware** | **72 hours**, to the supervisory authority, unless unlikely to risk people's rights; reasons for delay must be given | Supervisory authority [which one depends on the entity's and the guild's location; unknown] | Statute; applies to the controller |
| GDPR Art. 33(2) | Processor becomes aware | **Without undue delay**, to the controller | The guild admin (Customer) | Statute. The DPA template proposes 24 h (`docs/legal/dpa-template.md` 1.7) |
| GDPR Art. 34 | High risk to individuals | Without undue delay, to the people affected | Members | Statute |
| Blizzard | Blizzard-sourced data exposed | 24 hours, per the roadmap queue note (Q40) | Blizzard | **Unverified.** The product makes no Blizzard API calls (`docs/compliance/blizzard-checklist.md`), so this should be moot today. No verified Blizzard contact exists; do not email anyone claiming to speak for Blizzard. |
| Discord | Discord data or tokens exposed | [Unknown; read the Discord developer policy and Premium Apps terms] | Discord via its developer support route [unverified] | Unverified |
| Other laws (US state, UK GDPR, etc.) | | [counsel] | | Unknown |

"Aware" is when there is reasonable certainty a breach happened, not when the investigation ends. Write the awareness time (UTC) first.

## 1. Detect

Sources: Cloudflare 5xx or error spikes, `wrangler tail`, GitHub secret scanning alerts, a member report, a vendor notice, an odd Discord webhook post. Note who found it, when, what. Open a private notes file (not the repo, not a PR); no secrets or personal data in it.

## 2. Contain (first hour)

1. Classify as SEV1 per `incident.md`. Assign one person to drive.
2. Stop the leak: rotate the exposed secret per `secrets.md`; revoke member keys or sessions if affected; disable the deploy workflow if a bad commit is live (`incident.md`, Pause merges); roll back per `rollback.md`.
3. Preserve evidence: copy logs and timestamps before they roll off (`wrangler tail` keeps nothing).
4. Do not delete affected rows or history until the scope is known; restore points are in `backup-restore.md`.
5. If a secret was committed to git, rotate first; removing it from history does not make it safe.

## 3. Assess (aim: within 24 hours of awareness)

Record: what data, which tables (`docs/data-inventory.md`), how many people, which guilds, whether data was only exposed or actually accessed, whether it was encrypted or hashed, likely harm, and whether it is contained. Label each fact confirmed, likely or speculative. Decide: notify the authority? notify people?

## 4. Who tells whom

| Step | From | To | When | How |
| :--- | :--- | :--- | :--- | :--- |
| 1 | Finder | Owner (driver) | Immediately | Private channel |
| 2 | Owner | Back-end architect and any contributor with access | Immediately | Private channel |
| 3 | Owner (as Provider) | Each affected guild admin (Customer) | Within the DPA window (proposed 24 h) and always before the Customer's 72 h elapse | Email from the owner's account; plain facts, no speculation |
| 4 | Customer (controller) | Supervisory authority | Within 72 h of the Customer's awareness | Customer's duty; the owner offers a draft |
| 5 | Controller | Affected members | If high risk, without undue delay | Plain language, what happened, what to do, contact |
| 6 | Owner | Counsel | As soon as the scope is known; before step 4 where possible | Phone or email |
| 7 | Owner | Discord / Blizzard | Only if the row above applies | Per the table [unverified] |

While the sole operator is also the only controller (the friends' private tenant, no stranger data), steps 3 to 5 collapse into one person; still write the timeline.

## 5. Notice content (Art. 33(3))
Nature of the breach with categories and approximate numbers; contact point; likely consequences; measures taken or proposed. Partial notice is allowed in phases.

## 6. Record and learn
Keep a breach register even for breaches not notified (Art. 33(5)): date, facts, effects, action, reasoning. Write the postmortem from `incident.md` within 3 working days; no secrets, no member names. Update the data inventory and this runbook.

## Open items
1. Name the supervisory authority and the Provider's lead contact once the entity exists.
2. Confirm the Blizzard 24 h and Discord clocks with sources.
3. A tabletop exercise: walk a leaked-admin-token scenario once and time steps 1 to 3.
