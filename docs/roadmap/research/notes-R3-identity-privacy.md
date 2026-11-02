# R3: Identity, privacy, compliance, multi-tenancy for a sold gaming companion product

Access date for every source: 2026-11-02. Labels: confirmed = read on a primary/official page this session; likely = consistent secondary sources or inference from primary; speculative = single weak source or my inference. Paraphrased. Not legal advice. Raw search tools returned summaries, so "confirmed" means the official page text was returned by the fetch tool, not that I read every word.

---

## 0. Headline findings (read first)

1. **Blizzard's Developer API Terms bar charging for features that use the API.** Section 2.2: "Premium" versions with extra for-pay features are not permitted; players may not be charged to download or access an Application or related services when those features use the Blizzard APIs. Also: 30-day max TTL on all API data (2.18), no selling/transferring Data (2.9), no using Data for ads (2.8), 36,000 calls/hour (2.17), terminate-and-delete at Blizzard's discretion (11.1). Page "last updated Oct 1, 2019". Confirmed (https://www.blizzard.com/en-us/legal/a2989b50-5f16-43b1-abec-2ae17cc09dd6/blizzard-developer-api-terms-of-use). This is the biggest constraint on "sold" and shapes the whole design: the Battle.net-powered character read must be free, or isolated from the paid tier, or covered by a written Blizzard agreement. See section 2.5.
2. **Battle.net has no refresh tokens in practice, 24h access tokens, and `/profile/user/wow` is the only account-wide character list.** Classic coverage is community-tested, not documented. WoW Forever's namespace is not documented by Blizzard (as of a 2026-10-29 third-party test). Likely.
3. **Cookies are the wrong default inside a Discord Activity.** Discord's own docs require `SameSite=None; Partitioned` on a `{clientId}.discordsays.com` cookie; real projects report that still failing on iOS WebView. Use an in-memory bearer token minted after the SDK `authorize` -> server code exchange. Confirmed (docs) + likely (iOS failure, one project).
4. **Discord can return an email with `verified:false`.** Never auto-link or trust by email unless `verified === true`; better, do not use email as a link key at all. Confirmed (Discord User docs per search summary; Nhost advisory).
5. **Better Auth (the obvious Workers/D1 library) had a high-severity linking ATO, CVE-2026-53516, fixed in 1.6.11,** and its team joined Vercel on 2026-07-07. Auth.js is on maintenance under the Better Auth team. Lucia is a learning resource, not a library. Confirmed.
6. **D1 allows up to 1,000,000 databases per paid account (first 100,000 included)** and 10 GB each; Durable Objects SQLite is 10 GB per object, 1,000 req/s soft limit per object. Per-guild databases are viable. Confirmed (Cloudflare docs).
7. **Discord's developer rules forbid training ML/AI models on message content obtained via API without Discord's permission.** Relevant to "AI processing of chat-derived content". Likely-confirmed (quoted by a search summary of the Developer Policy; the policy page itself returned 403 to the fetch tool).

---

## 1. Account model and sessions

### 1.1 Identifier and trust rules per provider

| Provider | Stable key | Email trust | Notes | Source / label |
|---|---|---|---|---|
| Discord | `id` (snowflake) from `GET /users/@me` with `identify` scope | `email` needs `email` scope; `verified` boolean must be checked. Discord can return an unverified email. | Access token `expires_in` 604800 (7 days); refresh token exists on the code grant; revoke endpoint revokes all tokens of that authorization. `iss=https://discord.com` is added to redirects; check when supporting multiple providers. | Discord OAuth2 docs (https://docs.discord.com/developers/topics/oauth2) confirmed; unverified-email behavior: https://github.com/nhost/nhost/security/advisories/GHSA-6g38-8j4p-j3pr, https://discord.com/developers/docs/resources/user (confirmed via search summary) |
| Google | `sub` (never reused, survives email change) | `email_verified` claim; `hd` only for Workspace orgs; do not use email domain for org membership | Verify ID token: signature via JWKS, `iss`, `aud`, `exp`, `nonce` | https://developers.google.com/identity/openid-connect/openid-connect confirmed |
| Battle.net | `sub` from token response / `/userinfo` (account id); `battletag` is mutable-ish display value | Battle.net gives no email (Clerk/other issue reports). `openid` scope returns account ID + BattleTag only (official guide, per search summary). | Field names `sub`/`id`/`battletag` come from third parties; verify against a live response. | https://community.developer.battle.net/documentation/guides/using-oauth (SPA, fetch returned shell; text came via search summary) likely; https://github.com/nextauthjs/next-auth/issues/6853 (sub '145232' = providerAccountId) likely |

Design implications (confirmed unless noted):
- Key `identities` on `(provider, provider_subject)`, never on email. Treat email as a contact attribute with its own verified flag and source.
- Discord is the base identity because the target flow is "open the Activity, you are registered". Discord `id` is therefore the primary human key; Google and Battle.net are attached identities.
- A Discord phone-only account may have no email at all (Better Auth issue #9124 shows libraries that hard-require email break on it). Do not require email anywhere in the model. Likely.

### 1.2 Takeaway pitfalls (account takeover)

- **Email auto-linking is the classic ATO.** Better Auth links automatically only when the provider reports verified email, but `trustedProviders` skips that check and the docs say it may raise ATO risk. https://www.better-auth.com/docs/concepts/users-accounts confirmed.
- **CVE-2026-53516 (GHSA-g38m-r43w-p2q7), CVSS 8.3:** attacker pre-registers victim email with a password (unverified local row); victim later signs in via OAuth; library links to the attacker's row. Affected below 1.6.11; fix adds `requireLocalEmailVerified` default true; mitigations `disableImplicitLinking: true`. Note that `requireEmailVerification: true` alone does not stop it. https://github.com/advisories/GHSA-g38m-r43w-p2q7 confirmed. Lesson: if no local passwords exist (Discord-first, no email/password), this class of bug mostly disappears. Do not ship email+password.
- **Discord unverified email squatting:** a Discord account can carry someone else's email unverified; apps that read `email` without `verified` create or link wrong accounts. Nhost advisory above, confirmed. A downstream project issue describes the same Discord unverified-email problem under Better Auth: https://github.com/viclafouch/petit-meme/issues/142 (likely).
- **Explicit linking only:** only link a new provider to a session that is already authenticated, with a fresh CSRF-checked `state`; never link by matching claims. Supabase's manual linking works this way and is off by default / beta. https://supabase.com/docs/guides/auth/auth-identity-linking (via search summary) likely.
- **Last-identity protection:** Better Auth refuses to unlink the only account unless `allowUnlinkingAll`. Copy that rule. Confirmed.
- **Already-linked-elsewhere:** if a Google/Battle.net subject is already linked to another user, fail the link and offer the merge flow below; never silently reassign. Supabase `linkIdentity` also fails in this case. Likely.

### 1.3 Merge flow (one human, two accidental accounts)

Because Discord is the root, a "second account" can only arise when a user signed up via Google or Battle.net without Discord (if you allow that) or with a second Discord account. Recommended (speculative design, mine):
1. Do not allow identity-less signups; every user row must have a Discord identity. Google/Battle.net are attach-only. This eliminates most merges.
2. Genuine multiple-Discord humans (alt Discord accounts): treat as separate users, offer a "linked profile" with proof by being signed into both in the same browser session within 10 minutes (two OAuth completions bound to one `link_session`), then record `human_id` grouping. Keep `user_id` per Discord account and a `human` grouping table; do not physically merge rows.
3. Any merge/link is a step-up action (section 1.6), is logged to the audit table, and sends a Discord DM or in-app notice to both accounts. Make merges reversible for 30 days (soft-merge pointer).

### 1.4 Session design on Workers

Two surfaces, two mechanisms:

**Web (first-party site)**: opaque random session id in an `__Host-` cookie (`Secure; HttpOnly; SameSite=Lax; Path=/`), hash stored in D1 (or DO), short idle timeout with sliding expiry. One guide recommends storing only a hash of tokens in D1 and keeping the pepper in a Worker secret, never in D1 or wrangler config; rotate token after privilege change; destroy pre-auth sessions rather than upgrade. https://flaviocopes.com/native-email-password-authentication-cloudflare-workers/ (via search summary) likely. The Lucia learning material shows the same pattern (hand-rolled session with sliding expiry, invalidate all sessions for user). https://lucia-auth.com/lucia-v3/migrate (via search summary) likely.

**Discord Activity (iframe on `{clientId}.discordsays.com`)**:
- All traffic goes through the Discord Proxy (which runs on Cloudflare Workers); only websockets for realtime, WebRTC unsupported; external hosts need URL mappings in the Developer Portal or `patchUrlMappings`; unmapped calls fail with `blocked:csp`. https://docs.discord.com/developers/activities/development-guides/networking confirmed.
- Cookie rule from Discord: domain must match `{clientId}.discordsays.com` and carry `SameSite=None; Partitioned`. Same page. Confirmed.
- Reported reality: a project (DisCalendar) concluded the web `SameSite=Lax` cookie never reaches the Activity and `SameSite=None; Partitioned` still failed in some environments such as iOS WebView, so it moved to a token bridge: SDK `authorize` -> code to own server -> server issues the app session -> signed session value kept in browser memory and sent as `Authorization: Bearer`. https://github.com/Shirataki2/DisCalendar/issues/350 (comment dated 2026-10-25) likely (one project). A second project (OpenQuester #471) suggests short-lived bearer for REST and Socket.IO. likely.
- Official flow: `commands.authorize` (scope `identify`, optionally `guilds`) returns `code` -> POST to your server (`/.proxy/api/token`, i.e. under the mapped path) -> server exchanges at `https://discord.com/api/oauth2/token` with client secret -> returns `access_token` -> `commands.authenticate({access_token})`. Client secret stays server-side. Sample server does not check exchange success; production must. https://docs.discord.com/developers/activities/building-an-activity and .../how-activities-work.md confirmed.
- Treat everything the Discord client tells the iframe (user, Nitro, channel, guild) as unverified; fetch trusted data from the Discord API server-side with the OAuth token. Sanitize usernames/channel names or render with `.textContent`. Networking page, confirmed.
- Therefore the Activity session design (my recommendation, speculative): the Worker validates the `authorize` code exchange, reads `/users/@me` itself, upserts the Discord identity (this IS the zero-friction registration), mints a short-lived (15-60 min) access token plus rotating refresh token held in JS memory, with the websocket to the tenant Durable Object authenticated by a one-time ticket in the first message, not a URL query. Re-run `authorize` with `prompt: "none"` when expired (no UI after the first consent).
- Consent: first run of `authorize` shows Discord's OAuth modal once per scope set; adding scopes later re-prompts. Confirmed (how-activities-work). So request the minimum at first launch (`identify`, and `guilds`/`guilds.members.read` only when a feature needs it).
- Instance/guild context: the iframe URL carries query params (instance id, guild id, channel id) readable via the SDK; these are client-supplied so verify guild membership server-side before granting tenant access. Likely (docs say params exist; verification is my inference).
- Not found: any documentation on `localStorage` behavior inside Activities (search returned nothing). Treat as unknown; do not rely on it for auth.

**Cross-surface**: web cookie session and Activity bearer are two issuers of the same session record (`sessions.kind = 'web'|'activity'`) so revocation is one table.

### 1.5 CSRF, token storage, refresh

- Cookie sessions need CSRF defense: SameSite plus Origin header check on state-changing requests, and a `trustedOrigins` list (Better Auth config shows this). Bearer sessions are not CSRF-prone but need XSS discipline since the token is in memory. Confirmed pattern (Better Auth Hono page for trustedOrigins) / likely for the rest.
- OAuth `state`: unique per request and bound to the user's session; Discord says highly recommended. Discord docs confirmed. Use PKCE on your own provider flows where the provider supports it: Discord (docs recommend PKCE for production over implicit; parameters not documented on that page), Google yes, Battle.net unconfirmed (see 2.2).
- Provider tokens: store only what you use. Discord access/refresh tokens are needed only if you call Discord later; the Activity guide says treat them like passwords and store encrypted. Battle.net tokens are 24h with no refresh, so store none after the character import (see 2.4 and the TTL rule). For encryption at rest use WebCrypto AES-GCM with a key in a Worker secret (envelope: per-row nonce, `kid` column for rotation). Likely.
- Revoke on unlink: Discord `/oauth2/token/revoke` kills all tokens for that authorization. Confirmed.

### 1.6 Step-up for sensitive actions

Sensitive actions (my list, speculative): delete tenant, transfer tenant ownership, change billing, link/unlink identity, merge accounts, export all data, add a Discord bot admin. Recommended: require a fresh `authorize` re-prompt (Discord `prompt=consent` or `none` with a recent `auth_time` you track) within 5 minutes; no passwords exist so "fresh" means a fresh OAuth round trip. Better Auth's own hard-delete requires fresh session or verification, a similar pattern. https://www.better-auth.com/docs/concepts/users-accounts confirmed.

### 1.7 Library and service survey

| Option | Fit for Workers + D1 | Status / risks | Source |
|---|---|---|---|
| **Better Auth** | Works on Workers with `nodejs_compat` (needs AsyncLocalStorage); D1 via Drizzle or Kysely; Hono integration; KV secondary storage possible. KV min TTL 60 s conflicts with default 10 s rate-limit TTL (issue #7124); KV is eventually consistent so rate limits/sessions revocation are soft; one README claims 1.7 needs atomic consume/increment that KV cannot do (verify). Built-in Discord and Google; Battle.net via generic OAuth plugin (not verified). | Team joined Vercel 2026-07-07, says it stays open source and platform agnostic. CVE-2026-53516 fixed in 1.6.11. | https://www.better-auth.com/docs/integrations/hono confirmed; https://github.com/zpg6/better-auth-cloudflare ; https://github.com/better-auth/better-auth/issues/7124 ; https://better-auth.com/blog/better-auth-joins-vercel confirmed (date, commitments) |
| **Auth.js** | Has a Battle.net provider (issuer per region incl. China `https://www.battlenet.com.cn/oauth`, US/EU/KR/TW `https://{us,eu,kr,tw}.battle.net/oauth`). Needs an adapter for D1. | Handed to Better Auth team 2025-09-22; security patches and urgent fixes only. A returned `refresh_token` needs `offline_access`; maintainer says Battle.net advertises refresh support. | https://authjs.dev/getting-started/providers/battlenet confirmed; https://www.better-auth.com/blog/authjs-joins-better-auth ; https://github.com/nextauthjs/next-auth/issues/6853 |
| **Lucia (v3)** | Deprecated; now a tutorial for hand-rolling sessions. | Use the patterns, not the package. | https://lucia-auth.com/lucia-v3/migrate (summary) likely |
| **Arctic + Oslo (Lucia author's libs)** | Runtime-agnostic, fetch-based; Arctic lists 50+ providers; works on Workers. I could not open the provider pages (404 on the URLs I tried) so I cannot confirm a Battle.net provider exists there. | Small libraries, you own sessions. | https://github.com/lucia-auth/lucia (summary) likely for the descriptions |
| **Clerk** | Hosted. Custom OIDC providers use Authorization Code with PKCE; Battle.net can be added as custom provider if its OIDC config is usable (config at `oauth.battle.net/.well-known/openid-configuration`, China `oauth.battlenet.com.cn`, per a GitHub issue; unconfirmed officially). Email missing from Battle.net is a problem if Clerk requires email. Backend can fetch a user's stored custom-provider OAuth token (prefixed `custom_`). | Per-MAU pricing not researched; does not fit "Discord Activity bearer" without custom work (speculative). | https://clerk.com/docs/authentication/social-connections/custom-provider likely |
| **Supabase Auth** | Manual `linkIdentity` off by default and beta; custom OIDC not verified for Discord/Battle.net here. Runs on Postgres, not D1. | Not a fit with D1; mentioned for patterns only. | https://supabase.com/docs/guides/auth/auth-identity-linking (summary) likely |
| **WorkOS AuthKit** | Not researched in this pass (search budget spent). Note WorkOS wrote a migration post after the Vercel/Better Auth news. | open question | https://workos.com/blog/vercel-acquires-better-auth-migrate-to-workos (title only) |
| **Cloudflare Access** | Designed for protecting internal apps/zero-trust. My search returned nothing on using it for end-user consumer login. Not appropriate for gamer sign-in. | Use only for your own admin panel (speculative). | none; speculative |

Takeaway: for a Discord-first product with three OAuth providers, no passwords, and an unusual Activity bearer path, the least-surprise choice is a small hand-rolled session layer (Lucia pattern) plus a thin OAuth client per provider (fetch-based), with D1 session table, not a big framework. Better Auth is a defensible alternative if you pin >= 1.6.11, disable implicit linking, and accept KV caveats. Speculative.

---

## 2. Battle.net OAuth and Blizzard API

### 2.1 Flow and endpoints
- Authorization Code flow for user data; the code exchange uses HTTP Basic client auth per a third-party PR citing Blizzard docs. Redirect URI must be pre-registered and HTTPS. https://github.com/philf90/HA-WOW/pull/28 likely.
- Regional OAuth hosts: `https://{us,eu,kr,tw}.battle.net/oauth/...` and China `https://www.battlenet.com.cn/oauth` (Auth.js provider page, confirmed). Blizzard's generic host `https://oauth.battle.net` is used for token/userinfo (portal config and search summary). China is separate: `oauth.battlenet.com.cn` returns an OpenID config per a GitHub issue dated 2026-10-30; no official Blizzard doc found. Likely for global hosts, speculative for CN specifics. CN is a separate account/identity space: do not assume one global account id across CN and the rest (speculative; verify).
- `/userinfo` at `https://oauth.battle.net/userinfo` needs an authorization-code token; the `openid` scope returns Account ID and BattleTag. Likely (search summary of the official guide).

### 2.2 Scopes, token lifetime, refresh, PKCE
- Scopes seen: `openid`, `wow.profile` (character access), also sc2/d3 profile scopes. Confirmed for `wow.profile` via official guide summary and the HA PR.
- Access token: 24 hours (official guide; live `expires_in` 86399). Confirmed/likely.
- Refresh token: none observed even with `offline_access` (HA PR author tests); Blizzard forum answer from a user says refresh not available and SSO cookie lasts ~30 days; Auth.js maintainer says a refresh token comes only with `offline_access` and Battle.net advertises support. Conflict. Plan on "no refresh". Likely.
- PKCE: sources conflict (one PR says none, one community post says PKCE worked on a mobile app). Unresolved; Clerk's custom provider path forces PKCE, so test. Open question.
- Practical consequence: Battle.net is a "snapshot at link time" or "re-consent on demand" source, not a background sync source.

### 2.3 Listing a user's WoW characters
- Endpoint: `GET /profile/user/wow` ("Account Profile Summary") with `Battlenet-Namespace: profile-{region}` (retail) or `profile-classic-{region}` per the reference; community libraries use `profile-classic1x-{region}` for Era and `profile-classic-{region}` for progression. Needs `wow.profile` token. https://community.developer.battle.net/documentation/guides/using-oauth (list of user-token endpoints, search summary) likely; https://www.npmjs.com/package/@blizzard-api/classic-wow likely.
- Response fields per character: character link, faction, gender, id, level, name, playable_class, playable_race, protected_character, realm (id, key, name, slug). HA PR, likely.
- Classic: a forum report (about 639 days old) says `/profile/user/wow` returned all characters on both Classic and Classic1x namespaces. A 2026-10-29 test (EU account): across 16 region/version combos only EU Retail and EU Era returned 200; the rest 404 (not 401); Progression and Anniversary untested. WoW Forever namespace is undocumented. A separate project issue says it still needs a spike to verify whether the API returns WoW Forever characters. All likely/speculative. Conclusion: whether Forever characters appear in the account summary is **unknown**; plan a manual-entry and Discord-nickname-based fallback and a live spike with a real Forever account.
- Region logic: a user's characters live in the region where they play. Try all regions the user could have (EU, US, KR, TW), up to 4 regions x N namespaces; HA integration caps at 24 requests per search. Likely.
- Character-level endpoints for Classic had 403/404 oddities (guild endpoints 403 on classic1x; appearance 404; protected character 403) in 600+ day old threads. Treat as flaky. Likely, stale.
- The sale of a "WoW character read" feature is subject to the API terms below.

### 2.4 What the user consents to
Battle.net consent screen for `openid` + `wow.profile` shares account ID, BattleTag, and WoW character data with the app (inference from scope definitions; I did not see the consent screen). Speculative. Tell the user exactly this in the in-app link dialog, and store no more than needed.

### 2.5 Blizzard API terms for a commercial app (all confirmed from the Blizzard legal page, section numbers as returned)
- License free "at this time", Blizzard may charge later (2).
- 2.2: no "Premium" versions with additional for-pay features when those features use the APIs; no charging players to download/access an Application or related services; no donation interstitials; no video ads gating features.
- 2.8: no using the APIs/Data to market products; no ad targeting; no transfer of data (even anonymous, aggregate or derived) to ad networks or brokers. 2.9: no selling, licensing or transferring Data to third parties (so careful: sharing with your sub-processors is not a "sale", but check; and do not export Data to customers as a product).
- 2.13: attribute Blizzard as source; no Blizzard trademarks in app title/URL (so "WoW" in the product name or domain is risky). 
- 2.14: appropriate security; report suspected unauthorized access to Blizzard within 24 hours. 2.15: post a privacy policy consistent with Blizzard's; never collect a player's Blizzard password. 2.5: you must act as a CCPA service provider. 2.17: 36,000 calls/hour, no third-party services making extra requests for you. 2.18: max 30-day TTL for all API data; for WoW character data validate the character id and delete if it no longer exists. 11.1: Blizzard may terminate any time without notice; delete all Data afterward. 11.3: if a user asks you to stop using their Data or de-link, stop and delete.
- How commercial WoW sites cope: Raider.IO sells a Premium plan (ad-free browsing, faster scanning) and describes itself as a Blizzard service provider; I found no public explanation of how that reconciles with 2.2 (no source). Speculative that a separate agreement or an interpretation limited to non-API features applies. https://raider.io/premium , https://raider.io/privacy-policy , forum thread https://us.forums.blizzard.com/en/blizzard/t/terms-of-use-monetization/10595 (a user reading: the rule is about features that use the API). Treat as unsettled; get Blizzard's written answer before charging.
- Design consequences: (a) keep Battle.net-sourced data in a separate table with `fetched_at` and a hard 30-day purge job; (b) the free tier must keep character import free, or the paywall must not gate any feature that uses API data (e.g., charge for raid scheduling/automation that works with user-typed characters); (c) no resale/export; (d) rate-limit your own calls well under 36,000/h across all tenants (central queue in a DO).

---

## 3. Data model for multi-tenant, multi-everything on D1/SQLite

### 3.1 Platform numbers (confirmed, Cloudflare docs)
- D1: 10 GB per DB (paid; 500 MB free); up to 1,000,000 DBs per account on paid (first 100,000 included, then $0.10/month each); 1 TB per account; 1,000 queries per Worker invocation (paid); 6 simultaneous connections per invocation; 100 columns per table; 2 MB max row; 100 bound params; 30 s max query; Time Travel 30 days paid; a batch counts as one query toward the per-invocation limit; query result cap 50 MB from 2026-11-04. https://developers.cloudflare.com/d1/platform/limits/
- D1 throughput: each DB is single-threaded; ~1 ms/query means ~1,000 qps, 100 ms means ~10 qps. https://developers.cloudflare.com/d1/llms-full.txt (via search) likely. One blog claims SQLITE_BUSY above ~200 sustained writes/s (anecdote, speculative).
- D1 read replication exists (Sessions API with bookmarks, sequential consistency); writes always hit the primary. https://developers.cloudflare.com/d1/best-practices/read-replication/ confirmed.
- D1 pricing: rows read counts rows scanned, so unindexed filters bill whole tables; each index on a written column adds rows written. https://orangecloud.report/guides/d1-in-production/ likely.
- D1 jurisdiction (e.g. `eu`) restricts where the DB runs and is stored, fixed at creation; it does not by itself change where a request is first terminated at the edge. https://developers.cloudflare.com/changelog/post/2025-11-05-d1-jurisdiction/ confirmed (changelog); edge-termination point from a developer issue, speculative.
- Durable Objects (SQLite backend): 10 GB per object, unlimited objects, soft 1,000 req/s per object, 30 s CPU default (up to 5 min), 500 classes per account. https://developers.cloudflare.com/durable-objects/platform/limits/ confirmed.
- Rate limiting binding: period 10 or 60 s, counters per Cloudflare location, eventually consistent, burst can exceed. https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/ confirmed.

### 3.2 Topology choice

| Option | Pros | Cons |
|---|---|---|
| One global D1 (all tenants, `tenant_id` column) | Simplest; cross-guild queries (a person in several guilds) are easy; one migration | 10 GB cap; single-threaded writes; noisy neighbour; every query must filter `tenant_id`; erasure/export per tenant is harder |
| D1 per tenant (guild) + one global "directory" D1 | Hard isolation; per-tenant export and delete is trivial; 10 GB each; provisioning at ~1M DBs | Cross-guild reads need fan-out; ~5,000 D1 bindings per Worker so you cannot bind per-tenant statically, you must use the REST API/dynamic routing (speculative: the 5,000-binding limit is the documented "about 5,000 D1 databases per Worker script", so dynamic access needs the HTTP API or a DO); migrations run N times |
| Durable Object per tenant with SQLite | Strong consistency per tenant, co-located compute, websockets/live roster fit; per-object 10 GB; easy `getByName(guildId)` routing | Cross-tenant querying is manual; 1,000 req/s soft cap per object (large raids with 40 users + bots are far below); DO classes limit irrelevant |
| Hybrid (recommended, speculative) | **Global D1** for identity, memberships, directory, billing, audit; **DO-SQLite per guild** for hot live state (rosters, signups, locks, websocket fan-out) with periodic or event-driven write-through summaries into global D1 | Two stores to keep consistent; need an outbox pattern |

Sources for the pattern: Cloudflare-adjacent guides argue DO SQLite is chosen for per-tenant isolation with separate size limits and better aggregate throughput (https://x.com/penberg/status/2025481081898569882 summary) and that hash-sharding D1 needs rebalancing (https://dev.to/araldhafeeri/scaling-your-cloudflare-d1-database-from-the-10-gb-limit-to-tbs-4a16 summary). Likely (opinion pieces, but consistent with the limits above).

Capacity sanity (my estimate, speculative): a roster/signup row is a few hundred bytes; 10 GB holds tens of millions of rows. A single global D1 will hit write throughput (~hundreds/s sustained) before 10 GB. Start global; keep every table keyed by `tenant_id` first in the primary key so a later split is mechanical.

### 3.3 Schema sketch (global D1; SQLite dialect)

```sql
-- identity
users(id TEXT PK, created_at, display_name, locale, deleted_at, status, age_gate TEXT)      -- id = ULID, not Discord id
identities(id PK, user_id FK, provider TEXT CHECK(provider IN('discord','google','battlenet')),
           provider_subject TEXT, handle TEXT, email TEXT, email_verified INTEGER DEFAULT 0,
           region TEXT, linked_at, last_login_at, UNIQUE(provider, provider_subject))
humans(id PK)                         -- optional grouping for same person with several Discord accounts
human_members(human_id, user_id UNIQUE)
sessions(id_hash PK, user_id FK, kind TEXT, created_at, last_seen_at, expires_at, revoked_at, ua_hash, ip_prefix)
provider_tokens(identity_id FK, kid, ciphertext, nonce, expires_at, scope)  -- discord only; none for battlenet

-- tenancy
tenants(id PK, kind TEXT 'guild', discord_guild_id UNIQUE, name, plan, region_pref, created_at, deleted_at)
memberships(tenant_id FK, user_id FK, role TEXT CHECK(role IN('owner','admin','officer','member','guest')),
            source TEXT 'discord_role'|'invite'|'manual', discord_roles_json, joined_at, left_at,
            PRIMARY KEY(tenant_id, user_id))
tenant_settings(tenant_id PK, ...)

-- characters
battlenet_accounts(id PK, identity_id FK UNIQUE, region, fetched_at)    -- 30-day TTL
characters(id PK, tenant_id NULL, owner_user_id FK, bnet_account_id NULL FK,
           game TEXT, region, realm_slug, name, class, race, faction, level, source TEXT 'bnet'|'manual',
           bnet_character_id NULL, verified INTEGER, last_seen_at, expires_at,
           UNIQUE(game, region, realm_slug, lower(name)))
```
Note: a character **belongs to a user** (owner) and may additionally reference its Battle.net account; manual characters have no Battle.net link. Same character appears in many tenants via signups, not via copying. Characters sourced from Blizzard carry `expires_at = fetched_at + 30 days` (API terms 2.18).

```sql
-- parties, raids
groups(id PK, tenant_id FK, kind TEXT 'party'|'raid', name, size_max INTEGER CHECK(size_max BETWEEN 1 AND 40),
       starts_at, tz, recurrence, status, created_by)
slots(group_id FK, slot_no INTEGER, role TEXT, character_id NULL FK, user_id NULL FK, state TEXT, PRIMARY KEY(group_id, slot_no))
signups(group_id FK, user_id FK, character_id FK, intent TEXT 'yes'|'maybe'|'no'|'bench', note, created_at, PRIMARY KEY(group_id, user_id))
audit_log(id, tenant_id NULL, actor_user_id, action, target, ip_prefix, ua_hash, at, details_json)  -- append only
```
Constraints worth enforcing in SQL: one character per signup, one user cannot hold two slots in the same group (`UNIQUE(group_id, user_id)` on slots where user not null), raid size 40 is just `size_max`. Alts: many characters per user; "which alt did you bring tonight" is the signup's `character_id`. "Multiple accounts per human": multiple `bnet_accounts` per user (a user can link more than one Battle.net identity only if you drop `identities UNIQUE(user, provider)`; allow multiple per provider for battlenet). Cross-guild: a user simply has memberships in many tenants.

### 3.4 Isolation pitfalls
- Every query must carry `tenant_id`; enforce in one data-access layer, never in handlers. SQLite has no row-level security. Consider composite primary keys starting with `tenant_id` and a test that greps for un-scoped queries. Speculative best practice.
- IDOR: object ids in URLs must be checked against the caller's membership, not only existence. Tenants in the Activity are derived from the verified guild id plus membership, never from a client-sent tenant id.
- Don't use Discord guild ids as the only key; guilds can be deleted and ids reused? (Snowflakes are unique; no reuse known. Speculative.) Keep your own surrogate.
- Cross-tenant leakage via shared caches: key KV/Cache API entries with tenant id; never cache authenticated responses at the edge.
- D1 pitfalls above: per-invocation 1,000 queries, 6 connections, no interactive transactions across requests (use `batch` for atomicity; DO gives real transactions), replicas lag unless using Sessions bookmarks.
- Large rosters (40) fit trivially. Realtime (drag a player between slots) belongs in the tenant DO; D1 is for durable records.

---

## 4. Privacy and compliance (practical, not legal advice)

### 4.1 Who is who (likely)
You are the **controller** for account data and a **processor** for guild-owned content that guild admins direct you to process? Not settled: for a guild signup tool, the guild admin often decides purposes, which can make you a processor for tenant content and a controller for account/billing/security data. Get counsel to pick; build the DPA for the processor role anyway. Speculative.

### 4.2 GDPR / UK GDPR
- Lawful bases: contract (running the signup service the user asked for), legitimate interests (security, abuse prevention), consent only where needed (optional analytics, optional AI features, marketing). Article 8 applies only when consent is the basis and you offer a service directly to a child. https://complydog.com/blog/gdpr-age-of-consent (secondary) likely.
- Digital consent age: GDPR default 16, member states may set 13-15 (eight at 13, six at 14, four at 15, nine at 16 per one secondary source; country figures conflict across sources; verify per market). UK: 13 under DPA 2018 s.9 (I could not retrieve the statute; my knowledge, unverified). Likely/speculative.
- Discord's own minimum age is 13 "and meet the minimum age required by the laws in your country" (https://discord.com/terms confirmed). So a Discord-verified base identity gives you an age floor of 13 in principle, which sidesteps COPPA's under-13 rule for the data you take from Discord, but it does not prove 13 (Discord relies on self-declaration plus newer age assurance rollouts: country coverage and dates in reports conflict; Discord says UK/Australia use region-specific processes). https://cybernews.com/vpn-news/discord-age-verification-rules-in-uk-2026/ , https://discord.com/blog/getting-global-age-assurance-right-what-we-got-wrong-and-whats-changing likely.
- **Children's design codes**: the UK ICO Children's Code applies to services likely to be accessed by under-18s, games explicitly included; for games the ICO's top tips say identify under-18s, avoid behavioural profiling by default for children, discourage false age declaration. https://mse.dlapiper.com/post/102i83a/new-ico-guidance-on-childrens-code-for-games-companies-identify-under-18s-and-p (secondary summary of ICO); the ICO page itself returned 403 to me. Likely. Practical: default-off profiling/analytics, no dark patterns, high-privacy defaults for any user flagged under 18 (Discord does not hand you age in OAuth; speculative that you cannot know, so apply conservative defaults to everyone).
- Processor contract (Art. 28(3)): written contract, documented instructions, confidentiality, security, sub-processor authorization with flow-down, assistance with data-subject requests, deletion/return at end, audit rights. https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/accountability-and-governance/contracts-and-liabilities-between-controllers-and-processors-multi/what-needs-to-be-included-in-the-contract/ (search listing; page text not fetched) likely.
- Records of processing (Art. 30): the <250 employee exemption is conditional (my knowledge, not verified this session); keep a one-page record anyway. Art. 27 EU/UK representative if you are outside the EU/UK and target their residents (my knowledge, not verified). Speculative; confirm with counsel.
- Data-subject rights (access, rectification, erasure, restriction, portability, objection): build self-serve export and delete, and tenant-admin tools. Blizzard 11.3 and Discord Developer Terms both independently require deletion on request, which aligns. Discord says: promptly update and delete API data on request, when no longer needed for stated functionality, and when you stop operating; encryption at rest was in the 2020 terms and appears carried over (unconfirmed). Fixed "7 days" is only in the superseded 2017 terms. https://support-dev.discord.com/hc/en-us/articles/8562894815383-Discord-Developer-Terms-of-Service (403 for me; content via search summaries) likely.
- Retention: keep sessions 30-90 days, audit logs 12 months (or shorter), Blizzard data <= 30 days, deleted-user tombstone only the hashed Discord id needed to prevent re-association of deletion requests. Speculative policy.
- Transfers: Cloudflare Customer DPA v6.4 (3 April 2026) covers SCCs and UK Addendum; confirm the sub-processor list before listing it. https://cf-assets.www.cloudflare.com/slt3lc6tev37/1TTgT35GoUNlKZYGuKWBFy/4e7dfc8cf402419a9b1cf624291fc69f/cloudflare_customer_dpa-v6.4_april_3_2026.pdf (title in search; not opened) likely. EU-US Data Privacy Framework: upheld by the General Court 2025-09-03 (T-553/23), appeal C-703/25 P pending as of late Oct 2026; no judgment yet; SCC fallback recommended. https://edpl.lexxion.eu/article/EDPL/2026/1/15 and others likely.
- EU data residency for tenants: D1 `jurisdiction: "eu"` at creation limits storage/execution; request ingress still hits the nearest edge. Offer as a per-tenant option only if sold (jurisdiction cannot change later). Confirmed (changelog) / speculative (edge).

### 4.3 CCPA/CPRA
Thresholds (one of three): revenue > $26,625,000 (adjusted Jan 1, 2025; next adjustment expected Jan 1, 2027), buy/sell/share data of >= 100,000 CA consumers/households, or >= 50% revenue from selling/sharing. https://www.complyfine.com/us-privacy-laws/ccpa-revenue-threshold likely. A small team is probably below all three at launch; still, Blizzard 2.5 obliges you to behave as a CCPA service provider regardless, and Discord users will include Californians. Provide "do not sell/share" truthfully (you do neither) in the privacy policy. Service-provider contract terms were not retrieved. Open question.

### 4.4 COPPA
Applies to services directed to children under 13 and to general-audience services with actual knowledge of under-13 users. General audience services need not ask ages; a neutral age screen is allowed; a "teen" site can still be child-directed if children are among its audiences. FTC FAQ confirmed (https://www.ftc.gov/business-guidance/resources/complying-coppa-frequently-asked-questions). Rule amendments finalized 2025-04-22, effective 2025-06-23, compliance deadline 2026-04-22 (passed), new separate consent for third-party disclosures for non-integral purposes, retention limits, broader personal-information definition. https://www.hunton.com/privacy-and-information-security-law/ftc-publishes-final-coppa-rule-amendments and others likely. Actionable: state in terms "13+ (or local minimum)", do not market to children, delete on actual knowledge (e.g., a guild officer reports a 12-year-old), do not show child-attractive branding. Speculative on risk, since WoW is rated and aimed at teens+.

### 4.5 Cookies and analytics consent
- Strictly-necessary session cookies need no consent under ePrivacy; analytics generally does in the UK (ICO), while CNIL (France) has a narrow audience-measurement exemption (first-party, anonymous statistics, no cross-site combining, cookie lifespan <= 13 months, data <= 25 months; GA never qualified; updated guidance July 2025). https://www.cnil.fr/en/sheet-ndeg16-use-analytics-your-websites-and-applications , https://luxgap.com/articles/cookies-analytics-exemption-cnil-cnpd-consentement-ico-2026 likely.
- Practical: inside the Activity there is no cookie banner surface worth using; run first-party, cookieless, aggregate-only product metrics (count events in your own D1/Analytics Engine without persistent ids) and keep third-party analytics off the Activity. On the marketing site, use a banner only if you add non-exempt tracking. Speculative recommendation.

### 4.6 Documents you need and what they must contain
- **Privacy policy** (must exist for Discord's developer policy and Blizzard 2.15): categories of data (Discord id/username/avatar, guild/role membership, optional Google subject/email, Battle.net account id/BattleTag/character list, signups, device/log data), sources, purposes and lawful bases, recipients (Cloudflare, payment processor, AI vendor if any), transfers, retention table, rights and how to exercise them, children statement, contact, "we do not sell or share", Blizzard attribution and data TTL, message-content-intent disclosure if the bot reads message content (third-party guides say Discord expects this; secondary). https://ultrafastutilities.com/privacy-policy-for-discord-bot (secondary) likely.
- **Terms of service**: eligibility (13+/local), acceptable use, tenant admin responsibilities, billing and refund, termination, disclaimers, Blizzard/Discord non-affiliation and trademark notices, liability cap, governing law.
- **DPA** (for tenants who are controllers): subject matter/duration/nature/purpose, data types and subjects, instructions, confidentiality, Art. 32 security summary, sub-processor list and notification mechanism, assistance with DSRs, breach notice timeline (Blizzard wants 24 h; commit to <= 48 h to tenants), deletion/return, audit, international transfer clauses.
- **Sub-processor list**: Cloudflare (Workers, D1, DO, KV, R2), Discord (OAuth/API, as an independent controller more than a sub-processor), Blizzard (API, independent), Google (optional sign-in), payment processor, email/transactional sender, AI vendor if used, error tracker if used. Publish with a change-notice process.
- **Security incident process**: Blizzard 24 h report; Discord requires notifying Discord and affected users of potential unauthorized access to API data; GDPR 72 h to regulator. Secondary summary for Discord; Blizzard confirmed; GDPR from my knowledge. Likely.

### 4.7 AI processing of chat-derived content
- Discord policy text (as quoted by a search summary of the current Developer Policy): do not use message content obtained via the APIs to train ML/AI models, including LLMs, without Discord's express permission; do not mine or scrape data; notify Discord and users of unauthorized access. https://support-dev.discord.com/hc/en-us/articles/8563934450327-Discord-Developer-Policy (403 to my fetch; quote came through search) likely.
- Therefore: sending chat-derived text to a third-party LLM **for inference** (summarize signups, parse "I can do Saturday") is a different question from **training**; but the vendor must be contractually barred from training on it and from retaining beyond the minimum (zero-data-retention terms where offered). The user-expectation test in Discord's older policy ("don't use API data in ways against users' expectations", 2022 version) is the risk. Likely.
- EDPB Opinion 28/2024: legitimate interests is not a default basis for AI; use the three-step test; anonymity of models is case by case; deployment, not just training, is in scope. https://securiti.ai/summary-of-edpb-opinion-282024-concerning-ai-models-processing-of-personal-data/ and others likely (secondary). 
- Practical minimum (speculative): AI features opt-in per tenant, off by default; process only the minimum text, never message history by default; strip ids/usernames before sending; list the AI vendor as a sub-processor; DPA with no-training and short retention; disclose in privacy policy; never fine-tune on guild content; log what was sent (hash) in audit.

### 4.8 Practical minimum before charging money (small team; my prioritized list, speculative)
1. Resolve Blizzard 2.2 in writing (or make Battle.net features free). This is a business-blocker, not a compliance nicety.
2. Public privacy policy, terms, subprocessor list; link in Discord Developer Portal and the Activity.
3. Self-serve data export and delete; tenant offboarding job (delete or return within a stated period); Blizzard data purge cron at <= 30 days.
4. Signed DPA template for tenants; sign Cloudflare's DPA; Stripe or similar processor DPA.
5. Breach response runbook with Blizzard 24 h / Discord / GDPR 72 h clocks.
6. Age statement + conservative defaults for under-18s (no behavioural profiling, no public profiles).
7. Records of processing (one page) and a DPIA-lite for the AI feature if enabled.
8. Counsel review of controller/processor split and EU/UK representative question, once, before launch.

---

## 5. Security baseline

- **OWASP ASVS 5.0** was released May 2025: 17 chapters, about 350 requirements (up from 14 chapters / ~286 in 4.0.3), new chapters including Self-Contained Tokens, OAuth and OIDC, Web Frontend Security; L1 rebalanced to lower the entry bar; L3 grew a lot. Sources are vendor blogs; check asvs.dev. https://softwaremill.com/whats-new-in-asvs-5-0/ , https://owasp2025globalappseceu.sched.com/event/1whCc/introducing-the-50-release-of-the-asvs likely. Recommendation: target **ASVS L1 fully plus the L2 items for authentication, session, OAuth/OIDC and access control** before charging; use the OAuth/OIDC chapter as the checklist for the Discord, Google and Battle.net flows. Speculative recommendation.
- **Secrets on Cloudflare:** `wrangler secret put` creates a new Worker version deployed immediately; for staged rollouts use `wrangler versions secret put` then `wrangler versions deploy` with percentage split; rollback can be blocked if secrets changed since the target version (use `?force=true`). Secrets Store holds account-level shared secrets. Official rotation docs for Secrets Store not found. https://developers.cloudflare.com/workers/configuration/secrets (via search summary) likely. Rotation plan: dual-key support in code (`kid`), add new secret, deploy, re-encrypt/rotate, remove old. The Discord client secret and Battle.net client secret are rotated in their portals then in Worker secrets; Discord secret reset invalidates the old one immediately (speculative; verify).
- **Audit logging:** append-only `audit_log` (section 3.3) for auth, link/unlink, role changes, exports, deletes, billing; ship to R2 with object lock-style retention or Workers Logs; log hashed ip prefix and ua, never tokens. Speculative best practice.
- **Rate limiting on Workers:** the built-in binding is per location, eventually consistent, windows 10 or 60 s only; fine for coarse abuse limits, not for precise per-user quotas. For precise limits (OTP-like flows, link attempts, signup spam) use a Durable Object counter keyed by user or tenant. Better Auth's default in-memory limiter is useless on Workers (per isolate memory); KV-backed limiter needs >= 60 s TTL and is eventually consistent. https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/ confirmed; Better Auth items likely.
- **Abuse and spam:** signups are low-cost for attackers if joining a guild is open. Controls: only members verified via the Discord API (server-side guild membership check) can act in a tenant; per-tenant caps (signups per user per hour); invite links and guest roles expire; report/block flow; tenant admin can kick; honeypot-free design because there is no public form. Turnstile for any public form. Speculative.
- **Web hygiene:** strict CSP (the Activity's CSP is partly set by Discord; your mapped hosts must be explicit), sanitize usernames (Discord docs), no secrets in client, `Origin` checks, `__Host-` cookies on the web side, HSTS, dependency pinning. Confirmed for the Discord-side sanitization advice; rest standard.
- **Blizzard/ Discord incident duties** as in 4.6.

---

## 6. Recommendation: identity design in 10 lines

1. Root identity = Discord `id` via OAuth2 code grant (scope `identify`; add `guilds.members.read` only when a feature needs roles). First Activity launch registers the user automatically from the verified server-side `/users/@me` call.
2. Never trust client-supplied SDK data (user, guild, channel); derive tenant access from a server-side Discord check plus your `memberships` table.
3. Activity auth = SDK `authorize` -> code to your Worker -> exchange -> your own short-lived bearer (in memory) + rotating refresh; no cookies in the iframe; websocket auth by first-message ticket.
4. Web auth = opaque `__Host-` cookie session (hash in D1), same session table, one revoke path.
5. Google and Battle.net are attach-only identities, linked explicitly while signed in, keyed on `sub`, never matched by email, never auto-linked; Discord email used only if `verified` is true and only for contact.
6. Users own characters; characters optionally reference a Battle.net account; signups reference a character; one human may have several users or several Battle.net identities without merging rows.
7. Battle.net is a snapshot import (24 h token, no refresh), data purged at 30 days, no Blizzard data in paid-only features until Blizzard answers in writing.
8. Global D1 for identity/membership/billing/audit; one Durable Object (SQLite) per guild for live rosters and signups; every table keyed with `tenant_id` first; D1-per-tenant is the escape hatch (up to 1M DBs).
9. Step-up = fresh OAuth round trip for link/unlink, merge, tenant delete/transfer, export; everything audit-logged.
10. Compliance floor: privacy policy, terms, DPA, subprocessor list, export/delete, 13+ statement with conservative under-18 defaults, AI features opt-in with no-training contracts.

---

## 7. Open questions I could not settle

1. Does Blizzard's 2.2 "no Premium/for-pay features that use the APIs" apply to a SaaS sold to guilds, and how do Raider.IO and others operate commercially? No source explains it; needs a written answer from Blizzard.
2. Does `/profile/user/wow` return WoW Forever characters, and under which namespace? Undocumented as of 2026-10-29; needs a live spike with a Forever account.
3. Does Battle.net support PKCE and refresh tokens (`offline_access`) today? Sources conflict.
4. Official Battle.net China (CN) OAuth hosts, whether CN accounts share an id space with global accounts, and whether commercial CN access has extra requirements.
5. Whether `localStorage` and `SameSite=None; Partitioned` cookies work reliably inside the Discord Activity on iOS/Android/desktop today (docs say cookies work; one project says iOS fails). Needs device tests.
6. Current Discord Developer Policy exact wording on privacy policy, AI, retention (page returned 403; I rely on search-quoted fragments).
7. Controller vs processor classification for guild content; Art. 27 representative; UK s.9 consent age confirmation; ICO page contents (403).
8. CCPA service-provider contract mandatory terms (not retrieved).
9. WorkOS, Clerk and Supabase pricing/fit with Workers + D1 and an Activity bearer path (not researched in depth); Arctic's actual provider list (docs 404).
10. Whether Better Auth 1.7 secondary-storage atomicity statement is accurate and how it affects KV-based deployments.
11. Cloudflare Customer DPA sub-processor list and whether D1 `eu` jurisdiction covers everything a regulator would ask about (edge ingress).

---

## 8. Surprises versus what a team would assume

1. **You probably cannot charge for anything that uses Blizzard API data** under the published terms (Premium versions, paid access to features that use the APIs), and Blizzard also caps retention at 30 days and forbids transferring data to third parties.
2. **Battle.net sign-in gives you no email and no refresh token;** tokens die in 24 h, so "background character sync" is not available.
3. **Discord can give you someone else's email, flagged unverified;** libraries that treat a returned email as proof have shipped account takeovers (Nhost advisory, Better Auth CVE-2026-53516 on the linking side).
4. **Cookies are not the default in a Discord Activity;** Discord requires `SameSite=None; Partitioned` on a `discordsays.com` host and a real project found it still unreliable on iOS, so a memory-held bearer is safer.
5. **Better Auth, the default Workers pick, is now part of Vercel and had a high-severity linking CVE in 2026; Auth.js is maintenance-only; Lucia is a tutorial.** "Pick the popular library" is less settled than it was.
6. **D1 is not a small-database product:** up to 1,000,000 databases per paid account, so database-per-guild is a supported scale pattern, but the bottleneck is single-threaded per-database throughput (about 1,000 qps at 1 ms), not the 10 GB cap.
7. **Workers' built-in rate limiter only allows 10 or 60 second windows, is per location and eventually consistent;** KV-backed limits have a 60 s minimum TTL. Precise limits need a Durable Object.
8. **Discord's own policy forbids training AI on message content from the API,** so "AI on chat-derived content" is a policy issue even before GDPR.
9. **Discord's 13+ minimum helps with COPPA but not with the UK Children's Code,** which covers under-18s and names games; the Code expects high-privacy defaults and no behavioural profiling by default.
10. **The EU-US Data Privacy Framework is still valid but under appeal (C-703/25 P, pending);** keep SCCs as the fallback.
