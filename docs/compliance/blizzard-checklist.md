# Blizzard compliance checklist

Blizzard's terms are the rule. This product makes no Blizzard API calls. Each rule below says where it is enforced and what is still a manual check. Status: **Enforced** (a test fails), **Manual** (a reviewer checks it), **Pending** (no mechanism yet; do not ship the related feature until there is one).

Sources to read before changing anything here: the Blizzard Developer API Terms of Use, the Blizzard trademark and fan-content guidelines, and `docs/product/blizzard-independent-monetization.md`. `terms-watch.yml` opens an issue titled "Blizzard terms changed" when the first two pages change; `docs/compliance/terms-hashes.json` holds the last reviewed hashes.

| # | Rule | Status | Where enforced |
|---|------|--------|----------------|
| 1 | **API ToU 2(b): no premiums for API use.** We charge nothing for Blizzard API access because we make no Blizzard API calls. Anything sold must work with no Blizzard data. | Enforced | `tests/unit/blizzard-compliance.test.mjs` fails on any reference to `api.blizzard.com`, `*.api.blizzard.com`, `oauth.battle.net` or `battle.net/oauth` in `infrastructure/`, `js/`, `scenes/`, `tools/`, unless the file is listed in `docs/compliance/blizzard-api-allowlist.txt` (empty today). Adding an entry needs owner sign-off. |
| 2 | **30-day retention of Blizzard API data.** Moot while rule 1 holds. If an API call is ever allowlisted, the same PR must add a purge job and a test showing no Blizzard-sourced row older than 30 days. | Pending (n/a today) | The allowlist is the gate: an entry without a retention job is not merged. |
| 3 | **Attribution / non-affiliation.** The site states it is not affiliated with or endorsed by Blizzard Entertainment. | Manual | Reviewer checks the site footer wording. The test allows exactly that sentence and nothing else containing a Blizzard mark. |
| 4 | **Naming.** Product, site, bot and app names do not contain WoW, Warcraft or Blizzard. Descriptive use in body copy ("heading into World of Warcraft: Forever") stays factual and never implies endorsement. | Enforced for names | The same test checks `index.html` `<title>`, `og:title`, `og:site_name`, `application-name`, apple web-app title, any web manifest `name`/`short_name`, `infrastructure/wrangler.toml` name, `infrastructure/package.json` name, and bot/app name assignments in `infrastructure/worker/`. Body copy is a Manual review. |
| 5 | **Art.** No Blizzard-owned art, logos, icons, sounds or extracted game assets in `img/`, `fonts/`, `atlas/`, `room/` or `vendor/`. Only art we made or hold a licence for. | Manual | Reviewer checks new binary assets in each PR; the PR states the origin of every new image. |
| 6 | **CC BY-SA library attribution.** Any library content under CC BY-SA keeps its attribution and licence notice, and derived material stays under the same licence. | Manual | Reviewer checks that any imported text carries its source and licence. Pending: a data-file field for source and licence plus a test that every library entry has one. |

## Changing this file

- A new rule or a status change goes in with the mechanism that enforces it.
- Never loosen a test to get green: change the rule here first, with the owner's approval.
- No contact at Blizzard for commercial questions has been verified. Do not email anyone claiming to speak for Blizzard on our behalf.
