# ADR 0012: Search provider shortlist

Status: DRAFT for review by the owner. Nothing here is implemented. No account, key or purchase was made.
Date: 2026-11-15 (revised after a hand-read of the terms in a browser)
Scope: which web search API the Phase 1b research engine (brief v2 section 4.2) should call, judged on terms and price. The number 0012 is the one the work item names; only ADR 0001 exists in this worktree, so check for a collision when other ADR branches land.

Evidence labels: **RS** = read at source (Chrome reader, 2026-11-14/15, note `ADR-0012-terms-hand-read-2026-11-15.md`); **SF** = summarising fetch (a small model summarised the page; re-read at source); **NR** = not read. Where RS and SF disagree, RS wins.

## Decision memo (read-only, 2026-11-15; the choice and the key stay with the owner)

Recommendation, one line: Tavily is the only shortlisted provider whose terms do not bar caching or display outright, so choose it only after Tavily confirms in writing that API queries are not retained or trained on and that its plain search is outside the AI Functionality clauses; until then ship Phase 1b with no provider (library plus Claude's own knowledge, labelled), and never cache raw results.

Fit against the two requirements (no caching or training of friend text; display allowed):

| Provider | No cache of results | Display in chat | No training on our queries | Fit |
|---|---|---|---|---|
| Tavily | No cache clause found in Terms or AUP (SF, absence only) | Contemplated for downstream users (Terms 1.2, 3.5, 3.8; SF) | Not met on paper: Privacy Policy lets Tavily use query data to improve responses; Terms 6.5/6.7 train on AI Functionality input (SF); plain /search probably outside 6.x (likely) | Best, conditional on written confirmation |
| Brave | Barred: no storing or caching except transient storage, no derivative works (ToS 3(b)(i),(ii); SF) | Not explicit; "POWERED BY BRAVE" optional (SF) | Query logs 90 days; broad licence to Search Query Data (ToS 9(b)); no training named in the Privacy Notice (SF); using results to improve AI barred (3(b)(xiii)) | Poor unless a storage-rights plan is bought |
| Exa | Barred: copy, store, display, derivative works of obtained information (ToS 4.2(a); read from the PDF text) | Same bar, unless Exa agrees in writing | Not met: perpetual licence to input and output for improvement; privacy policy says training; zero retention is Enterprise only, $12,000 a year | Poor |

None of the three explicitly permits storing a composed answer. Rule for any provider: composed answers are cached for at most a day only after written confirmation; until then do not cache composed answers that quote results.

## Primary-page read, 2026-11-15 (closing the "not read" cells)

Method: three read-only subagents fetched the primary legal pages with WebFetch (a small model summarises each page, so every claim below is **SF**, not **RS**; re-read at source before signing anything). Exa's Terms and MSA were fetched as PDFs and read locally as extracted text, so those claims are closer to source. No account or key was created; no page text was acted on. Quotes are kept under 15 words.

### Tavily (Terms last updated 2026-05-04; AUP 2026-10-21; Privacy Policy 2025-11-24)

- Caching or storing results or composed answers: no clause addresses it in Terms 3.2, the Output clauses or the AUP; no duration stated (SF).
- Output (Terms 1.6, 1.7) is defined apart from "Services", so the copy and resale bans in 3.2(i),(ii) may not reach Output (inference by the summariser; likely, not confirmed).
- Display: Terms 1.2, 3.5 contemplate customer applications serving third parties; 3.8 and AUP section 4 make you flow the AUP down to downstream users and monitor them (SF). No attribution requirement found.
- Retention and training: the Privacy Policy keeps query data as long as necessary, with no period, and may use it to improve future responses; it does not name the API, so whether it covers API traffic is unclear (SF). Terms 9.1/9.2: perpetual licence to Input; 6.5/6.7: Tavily and its AI providers may train on Input and Output of AI Functionality (SF).
- Plain /search versus AI Functionality: Terms 1.7 lists the search APIs as Services, apart from AI Functionality (6.1); likely outside it, not stated outright. Classification of `include_answer` and `include_raw_content`: not stated.
- Possible bar: use is for "internal business purposes"; a hobby bot for friends may fall outside (likely gap, not confirmed).
- Not read: Help Center articles "AI Processing and Training Data", "GDPR, DPA and Security Documentation" and "Allow Use of Query Data"; the DPA; the sub-processor list; any zero-data-retention policy; the trust center.

### Exa (ToS PDF; MSA v2.2026-09-17; Privacy Policy 2026-06-29)

- Caching and display: ToS 4.2(a) bars download, copy, distribute, display, reproduce, publish or derivative works of information obtained through the Services, except temporary browser cache or written permission (read from PDF text). No duration anywhere.
- Which document governs a self-serve key (ToS or MSA) is unclear; MSA 4.1 says you own Output but not Output Exa generates for others for similar inputs.
- Training: ToS 1.2(c) grants a perpetual licence to input and output "to develop and improve"; the Privacy Policy says queries are used to improve products including training (SF). Opt-out: zero data retention, Enterprise only, $12,000 a year upfront (pricing page, SF). No retention period stated.
- No explicit AI/LLM product ban; competitive-product bans in ToS 4.2(f) and MSA 3.4(c); the "bots" language in ToS 4.2(d) is ambiguous.
- Not read: the trust center; the DPA (the ToS link was a placeholder); Search API docs on result usage. The Privacy Policy and MSA pages contained text telling AI agents to fetch a file; treated as data.

### Brave (ToS 2026-09-01; Privacy Notice 2026-11-03)

- Section numbers differ from the 2026-11-14 hand-read above (that read cited sections 2(b) and 3(c)); this fetch cites 3(b)(i),(ii),(xiii) and 4(c),(d). Version drift or summariser error: re-read the ToS at source.
- Caching: bars storing, caching or building a database of Search Results except transient storage needed to run the application, and bars derivative works (ToS 3(b)(i),(ii)); storage rights need a custom plan (pricing page FAQ). Whether a short TTL counts as transient is undefined.
- AI: bars using results to train, evaluate or improve AI models (3(b)(xiii)); passing results to an LLM at query time only to answer is likely outside it, but the wording is broad.
- Logging: query records kept per account for 90 days; zero data retention is Enterprise only; the Privacy Notice lists no AI training purpose, but ToS 9(b) grants Brave a broad licence to Search Query Data (SF).
- Display: attribution optional ("POWERED BY BRAVE"); end users must be bound by a written agreement (4(c)).
- Not read: the DPA (both PDF links returned HTTP 403); the Service Credit Terms.

### Written confirmations to request (consolidated)

- Tavily: a private friends' bot counts as permitted use; API query retention, logging and training exclusion; caching and display rights; DPA and sub-processors; whether queries are forwarded to Google or other index providers; rate limits; `include_answer` classification.
- Brave: a short-TTL cache is "transient"; composed-answer cache; storage-rights plan price; LLM at query time versus 3(b)(xiii); no training on query data; DPA scope for query data; end-user terms for five friends; attribution.
- Exa: not pursued; only if the owner wants zero retention at the Enterprise price.

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

Open. The owner chooses a provider and creates the key; no key exists, no account exists, and nothing was purchased. The shortlist stands as proposed below: Tavily leading with written confirmation outstanding, Brave second with no result caching, Exa out, Google unavailable. The provider-swappable interface in the Design section is unchanged and is the decision that does not depend on that choice.

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
4. **Queries go through the guard.** Every query passes the tokeniser and privacy guard before any provider call. `scrubSearchQuery(q, roster, opts)` in `infrastructure/worker/privacy/outbound-guard.js` is that check: it returns the whitespace-normalised query, or `null` when a placeholder token, roster name or partial, id, mention or invite is found (the caller must then refuse to send). The `privacy/` directory exists on master (`outbound-guard.js`, `roster-config.js`, `skeleton.js`, `tokenise.js`). This ADR's wording of "must assert" is satisfied only if the search caller treats `null` as a refusal, which is a build requirement for the provider adapter, not something verified here.
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

Superseded in part by "Primary-page read, 2026-11-15" above. Still open after that read: Tavily help articles, DPA, sub-processors, ZDR policy; Exa DPA and trust center; Brave DPA (HTTP 403); Service Credit Terms. Earlier entries follow.

- Tavily Acceptable Use Policy, privacy policy, and the terms sections named above (3.2 items (xiv) onward, 3.4 remainder, 3.5, 9.1, the Output-use clause that was cut off).
- Google Custom Search terms: not read; moot because the API is closed to new customers.
- Exa terms pages 4-11, its privacy policy and Master Subscription Agreement.
- Every privacy policy; the Brave Privacy Notice and DPA.
- Google terms (moot).
- Anthropic web search storage and display terms beyond the docs page; Kagi terms beyond a summary.
- Grounding with Bing, Perplexity, Linkup, Serper and similar: not evaluated.
- No legal advice was taken.
