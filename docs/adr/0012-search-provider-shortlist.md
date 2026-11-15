# ADR 0012: Search provider shortlist

Status: DRAFT for review by the owner. Nothing here is implemented. No account, key or purchase was made.
Date: 2026-11-15 (revised after a hand-read of the terms in a browser)
Scope: which web search API the Phase 1b research engine (brief v2 section 4.2) should call, judged on terms and price. The number 0012 is the one the work item names; only ADR 0001 exists in this worktree, so check for a collision when other ADR branches land.

Evidence labels: **RS** = read at source (Chrome reader, 2026-11-14/15, note `ADR-0012-terms-hand-read-2026-11-15.md`); **SF** = summarising fetch (a small model summarised the page; re-read at source); **NR** = not read. Where RS and SF disagree, RS wins.

## Context

Leeroy answers in a private Discord of five friends. Results are shown in chat, answers are cached for about a day, and we keep only URL, title, a quote under 15 words and a date. Queries are de-identified (brief 5.5, class A). Target spend is free tier or a few dollars a month. The call comes from a Cloudflare Worker (free plan: 10 ms CPU, 50 subrequests); page fetches are ours.

## Comparison

Load: 30 questions/day x 2 searches x 30 days = 1,800 searches a month. This is a ceiling.

| Provider | Price / free tier | Cache / store results | Display in chat | Provider trains on our data | Verdict |
|---|---|---|---|---|---|
| Tavily | 1,000 free credits a month, then $0.008 per credit; basic search 1 credit (RS) | No cache rule found in the Platform Terms: zero hits for "cach" on the whole page (RS). Absence is not permission. | Integration in Customer Applications allowed; end users bound by the Acceptable Use Policy (RS, AUP NR) | Yes for AI Functionality input and output; broad licence over Customer Input to improve its services. Whether plain `/search` counts as AI Functionality is unconfirmed (RS) | Leading candidate, caveat open |
| Brave Search API | $5 per 1,000; $5 free credit a month (RS) | Barred: "store, cache, or create a database of Search Results", also derivative works (RS) | Licensed "with the Customer Applications"; end users need a written agreement (RS) | Query licence limited to use with the API; no training grant found (RS); Privacy Notice NR | Second, only with no caching of results |
| Exa | From $4 per 1,000; $10 free credit a month (RS) | Barred: copy, reproduce and "display" of obtained information except temporary browser files (RS) | Same bar, unless Exa agrees in writing (RS) | Perpetual licence over input and output; ZDR only on Enterprise at $12,000 a year (RS) | Eliminated |
| Google Custom Search | $5 per 1,000 after 100 a day free (RS) | Terms NR | Terms NR | NR | Eliminated: closed to new customers; ends 2027-01-01 (RS) |
| Kagi, Anthropic web search | $12 and $10 per 1,000 (SF) | Kagi: no "persistent copy" (SF). Anthropic: not addressed (RS) | Anthropic: citations required (RS) | Anthropic commercial terms: no training on customer content (SF) | Not shortlisted: over budget at $21.60 and $18 plus tokens |
| Bing, Gemini grounding, scrapers, DuckDuckGo | n/a | n/a | n/a | n/a | Eliminated: Bing retired 2025-08-11 (RS); grounding limits display to the asking user and bars caching (brief 4.2, not re-read); scrapers carry legal risk; no official DuckDuckGo API found (SF) |

## Terms table (hand-read, 2026-11-14)

Source for every row: note `ADR-0012-terms-hand-read-2026-11-15.md` (another session's text; read in the owner's Chrome, read-only, nothing signed in, no account or key created). Evidence class **hand-read** = read at source on the page named. **memory** = not used for any row here. **not read** = the page was not read; no term is stated. Intended use for all rows: five friends, results shown in chat, answers cached about a day.

| Item | Brave Search API | Tavily | Exa | Google Custom Search JSON API |
|---|---|---|---|---|
| Price | $5.00 per 1,000 requests; $5 free credit monthly. Hand-read: api-dashboard.search.brave.com/documentation/pricing | 1,000 free credits a month; $0.008 per credit pay as you go; basic search 1 credit, advanced 2. Hand-read: docs.tavily.com/documentation/api-credits | From $4 per 1,000; $10 free credits monthly (about 2,500 Lite searches). Hand-read: exa.ai/docs/admin/pricing | 100 queries a day free, $5 per 1,000 after. Hand-read: developers.google.com/custom-search/v1/overview |
| Rate limits | 50 requests per second (Search plan), 2 per second (Answers). Hand-read: Brave pricing page | Free 100 requests per minute; pay as you go 1,000. Hand-read: docs.tavily.com/documentation/rate-limits | 10 QPS on /search, /answer, /chat/completions. Hand-read: exa.ai/docs/admin/billing. The "up to 25 QPS" figure appears only in the note's summary table, not in its per-source quote: not confirmed | 10,000 queries a day maximum. Hand-read: Google overview page |
| Storage policy | Not allowed: no "store, cache, or create a database of Search Results" except transient storage required for operation (section 2(b)); derivative works also barred. Caching our composed answer is a gray area; treated as not allowed. Hand-read: api-dashboard.search.brave.com/terms-of-service (last updated 1 Sep 2026) | No cache or store rule found: a text search for "cach" and "scrap" over the whole loaded terms page returned zero hits (about 68,670 characters). Absence is not permission. Hand-read in part: tavily.com/terms (last updated May 4, 2026); middle of the page was truncated by the reader | Not allowed on the face of section 4.2(a): no "copy", "reproduce", "duplicate" except temporary browser files, unless Exa agrees in writing. Hand-read: exa.ai/assets/Exa_Labs_Terms_of_Service.pdf pages 1-3 of 11 | Not read (terms; moot, closed to new customers) |
| Display in chat | Licensed to use results "with the Customer Applications"; each end user must be bound by a written agreement (section 3(c)); five friends count as end users. Hand-read: Brave terms | Integration with Customer Applications explicitly allowed; end users must comply with the AUP (section 3.8). The AUP itself: not read | Barred by 4.2(a) ("display") unless permitted in writing. Hand-read: Exa terms pp. 1-3 | Closed to new customers. Hand-read: Google overview page |
| AUP and use restrictions | Customer may not use results to "train, re-train, fine-tune, benchmark or otherwise improve" AI models; no redistribution; attribution "POWERED BY BRAVE" optional; Brave may terminate on 10 days' written notice. Hand-read: Brave terms. Privacy Notice and DPA: not read | Use "solely for Customer's internal business purposes, including for integration with Customer Applications" (hand-read). Section 6.6 bars automatic decision-making about people (not our case). Section 3.2 items (xiv) onward, 3.4 remainder, 3.5, 9.1, the AUP and the privacy policy: not read. The clause on Output use was cut off at the read | No resale or sublicensing (4.2(e)); no use of the Services "(including Output) to develop any competitive product or service" (4.2(f)); no robots or scrapers (4.2(j)). Hand-read: Exa terms pp. 1-3. Pages 4-11, privacy policy and Master Subscription Agreement: not read | Not read |
| Provider use of our queries | Query licence is "for purposes of use with the API"; no training grant found. Hand-read: Brave terms. Privacy Notice: not read | Section 6.5: may use Customer Input submitted to the AI Functionality for training AI models; section 9.2 licence to "improve the Services and improve Tavily's other products and services". Whether plain `/search` is "AI Functionality" is not confirmed. Hand-read: Tavily terms | Section 1.2(c): licence to "cache, store, reproduce... display" input and Output to "provide, develop and improve upon our products"; Zero Data Retention only on Enterprise ($12,000 a year per the note). Hand-read: Exa terms pp. 1-3 | Not read |
| To confirm in writing | Brave's written agreement on whether a one-day cache of our composed answer is acceptable (a storage-rights plan is the route); whether test fixtures of results breach the cache and benchmarking clauses | Tavily confirms in writing that plain `/search` is outside "AI Functionality" (section 6.5) and that the AUP and Platform Terms permit a one-day cache of results or of our composed answer; AUP to be read first | Exa written permission to display results in chat and to cache (4.2(a)); not pursued, Exa is out | None; not available |

The landing page https://brave.com/search/api/ claims "Structural ZDR vs contractual". That is marketing, not terms, and is not relied on.

## Decision status

Open. The owner (Matt) chooses a provider and creates the key; no key exists, no account exists, and nothing was purchased. The shortlist stands as proposed below: Tavily leading with written confirmation outstanding, Brave second with no result caching, Exa out, Google unavailable. The provider-swappable interface in the Design section is unchanged and is the decision that does not depend on that choice.

## Clause evidence

- **Tavily** (https://www.tavily.com/terms, last updated May 4, 2026, RS in part). Use is "solely for Customer's internal business purposes, including for integration with Customer Applications". Section 6.5 lets Tavily use Customer Input "submitted to the AI Functionality" for AI training. Section 9.2 licenses Customer Input to "improve the Services". Section 3.8 requires end users to follow the AUP. Credits: https://docs.tavily.com/documentation/api-credits (RS). Rate limits: free 100 requests per minute, pay as you go 1,000 (RS).
- **Brave** (https://api-dashboard.search.brave.com/terms-of-service, updated 1 Sep 2026, RS). Section 2(b) bars "store, cache, or create a database of Search Results" except "transient storage required for operation". It also bars training or benchmarking AI on results and redistribution. Attribution ("POWERED BY BRAVE") is optional. Brave may end the agreement on 10 days' notice. The reader treats caching our composed answer as a gray area (a derivative), so treat it as not allowed. Pricing: https://api-dashboard.search.brave.com/documentation/pricing (RS). The earlier "up to $20" marketing line and the $26 storage-rights price came from summaries and are dropped; a storage-rights plan is the route to written permission.
- **Exa** (https://exa.ai/assets/Exa_Labs_Terms_of_Service.pdf, pages 1-3 of 11, RS). Section 4.2(a) bars copy, display and reproduce "except for temporary files that are automatically cached by your web browser". Section 1.2(c) takes a licence to "cache, store" and use input and output to "develop and improve" its products.
- **Google** (https://developers.google.com/custom-search/v1/overview, RS): "closed to new customers".

## Decision (proposed)

1. **Tavily is the leading candidate.** It is the only one with display inside an application contemplated and no cache ban found. The open items are its training clause and the AUP. The AUP and the middle of the terms (3.2 items xiv onward, 3.4 remainder, 3.5, 9.1) are NR. Do not cache raw Tavily results until the AUP is read and Tavily confirms in writing that plain `/search` is outside "AI Functionality".
2. **Brave is second, only with no caching of results.** That fits the design below. Ask Brave in writing whether our composed-answer cache is acceptable.
3. **Exa is out.**

## Design: provider-swappable research step

1. **Interface.** The pipeline calls one small interface: `search(query) -> [{url, title, snippet, date}]`. Fetch is ours and does not touch the provider. Swapping providers changes one adapter.
2. **Storage policy flag.** Each provider adapter declares `storagePolicy`: `none`, `composed-only` or `allowed`. Brave is `none`. Tavily is `composed-only` until its AUP is read. Code enforces it: raw results live in memory for one request only and are never written to D1, the Durable Object, KV or logs under `none` or `composed-only`. Unit tests assert that no provider result object reaches storage.
3. **Cache the composed answer, not the results.** What we cache is our own text with each citation as link, title, a quote under 15 words and a date, taken from the page we fetched ourselves where possible. Under `none` (Brave) this is itself a gray area; the owner decides (below).
4. **Queries go through the guard.** Every query passes the tokeniser and privacy guard before any provider call. A function `scrubSearchQuery` must assert that no token, roster name, handle, Discord id, character name or guild name remains, and refuse to send otherwise. Neither `scrubSearchQuery` nor a `privacy/` directory exists in this worktree under `infrastructure/worker/`; the name and location come from the coordinator and are not verified here.
5. **Replay for tests.** Test runs replay recorded results held in the test fixture, which is the existing record-once rule (brief 5.4). Whether recording provider results as test fixtures breaches Brave's cache and benchmarking clauses is open; for Tavily it waits on the AUP.

## Cost estimate

| Provider | Arithmetic | Monthly |
|---|---|---|
| Tavily | 1,800 basic searches = 1,800 credits; 1,000 free; 800 x $0.008 | $6.40 |
| Brave | 1,800 / 1,000 x $5 = $9.00; less $5 free credit | $4.00 |

At the roughly three asks a week the brief records, both fall inside or near free credit. A live 1,000-search test run costs about $5.00 on Brave (a free-credit month absorbs it) and 1,000 Tavily credits ($8.00 if beyond the free allowance).

## Decision needed from the owner

Nothing to buy yet, and nothing was done on any account. Phase 1b is blocked on the owner buying a key. The decision is: authorise the first key for **Tavily** (free plan needs no card per the pricing summary, SF) once the AUP has been read and Tavily has answered in writing on training; or authorise **Brave** on the understanding that no raw results and, arguably, no composed answers derived from them may be cached. Also decide whether training by Tavily on de-identified class A queries is acceptable. Account, billing, keys and any emails to providers are the owner's; the key goes into Worker secrets, never the repo.

## Risks

- Tavily may train on query inputs and outputs. Queries are de-identified, but a friend can type anything.
- The absence of a Tavily cache rule is a finding from one text search, not a grant.
- Brave's no-cache rule may make the one-day answer cache a breach, forcing re-search each time.
- Free-credit figures change; recheck on the day of purchase.
- Search quality for a game launched 2026-11-04 is unmeasured; the Phase 1 probe must test both candidates.
- Worker CPU: page fetch and parse, not the search call, is the likely 10 ms risk.

## Not read

- Tavily Acceptable Use Policy, privacy policy, and the terms sections named above (3.2 items (xiv) onward, 3.4 remainder, 3.5, 9.1, the Output-use clause that was cut off).
- Google Custom Search terms: not read; moot because the API is closed to new customers.
- Exa terms pages 4-11, its privacy policy and Master Subscription Agreement.
- Every privacy policy; the Brave Privacy Notice and DPA.
- Google terms (moot).
- Anthropic web search storage and display terms beyond the docs page; Kagi terms beyond a summary.
- Grounding with Bing, Perplexity, Linkup, Serper and similar: not evaluated.
- No legal advice was taken.
