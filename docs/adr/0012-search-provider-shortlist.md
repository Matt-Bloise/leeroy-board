# ADR 0012: Search provider shortlist

Status: DRAFT for review by the owner. Nothing here is implemented. No account, key, purchase or signup was made.
Date: 2026-11-15 (all pages accessed on this date)
Scope: which web search API the Phase 1b research engine (brief v2 section 4.2, step 2 "the web, in two steps Leeroy controls") should call, judged on terms and price. Number 0012 is the number the work item names; the worktree holds only ADR 0001, so check for a collision when the other ADR branches land.

Evidence labels used below: **[fetched]** = read through the WebFetch tool, which summarises a page with a small model, so every quote marked this way is "paraphrased by the fetch tool, re-read at source" until a human re-reads it; **[raw]** = the fetch returned the page text itself (Anthropic docs, Microsoft Learn) or I extracted the text of the file locally (Exa terms PDF); **[search-summary]** = a web search result summary, weakest.

## Context

The v2 brief replaces the bundled grounded answer with search-then-fetch: a search call returns links, then Leeroy fetches the best pages itself (brief 4.2). Why: Gemini grounding's terms limit display to the submitting user and forbid caching (brief 4.2, already judged unfit; not re-read here).

Constraints the provider must fit:

1. A result may be shown to a group in a shared Discord channel.
2. Answers are cached for freshness windows (brief 5.4). What we store about a source is only URL, title, a quote under 15 words and a date. We never store page bodies.
3. Queries are de-identified (data class A, brief 5.5); no friend text or names reach the provider.
4. Spend target: free tier or a few dollars a month. The 225-question test set is the larger spender; the rule is record once and replay (brief 5.4).
5. Called from a Cloudflare Worker, free plan: 10 ms CPU, 50 subrequests (brief 5.4). Search is one subrequest; the page fetches are ours.

Design note that affects every "no persistent copy" clause below: the record we keep can be built from **our own fetch of the page** (URL we fetched, the title in that page, a quote taken from that page, the page date), not from the provider's result object. If that holds, the provider's result is used transiently and our stored row derives from the third-party page. This is a legal argument, not a tested one; the owner should have it confirmed in writing by the provider where the clause is strict (Brave, Kagi).

## Comparison

Load assumed for cost: 30 questions/day x 2 searches = 60 searches/day = 1,800 searches per 30-day month. This is a ceiling; the brief records friends asking about 3 times a week.

| Provider | Free tier / price | Storage allowed | Group display allowed | LLM use | Query logging | Verdict |
|---|---|---|---|---|---|---|
| Brave Search API | $5 per 1,000; $5 free credit a month (page also says "up to $20"; unreconciled) | Not on the Search plan: only "transient storage". Separate storage-rights plan, $26-$45 per 1,000 [search-summary] | Not addressed; redistribution of results barred | Allowed for answering (page sells it for "chatbots & agents"); training/evaluating on results barred | "Queries never shared or trained on" (marketing line); retention period not stated | SHORTLIST (1), conditional on storage confirmation |
| Exa | $10 free credit a month (up to 2,500 Lite searches); Lite/Instant $4 per 1,000; Auto/Fast $7 per 1,000 | Website-style terms bar copying "information obtained from or through" the Services; no API-specific clause read | Same clause bars display/distribution; unclear for an API use | Not addressed in the terms read; Exa takes a licence over our input/output "to develop and improve" its services | Queries are used by Exa; ZDR only on a $12,000/yr Enterprise plan | SHORTLIST (2), conditional on written confirmation of API terms |
| Kagi API | $12 per 1,000; no free tier | "May not create a persistent copy"; transient caching only | Not addressed | Explicitly allowed to answer users' queries; barred for training a search index | "logged temporarily, separated from your account" | Best terms fit, over budget ($21.60/mo). Reserve |
| Tavily | 1,000 credits/month free; $0.008 per credit after; 1 credit per basic search | No explicit caching clause found | No explicit clause found | Terms mention AI-model training and sharing input with third-party AI providers; context unclear | Queries are "Customer Input", shareable with vendors, perpetual licence | Not shortlisted: terms unclear on training and input sharing |
| Anthropic web search tool (Messages API) | $10 per 1,000 searches plus token cost of results | Not addressed on the pages read | Citations must be shown when displaying outputs to end users | Built for LLM use; no training on customer content (commercial terms) | ZDR-eligible (basic version) | Fallback only: fuses search and compose, bills $18/mo before tokens, results are encrypted blobs |
| Google Custom Search JSON API | 100/day free, $5 per 1,000 | n/a | n/a | n/a | n/a | Eliminated: closed to new customers, ends 2027-01-01 |
| Bing Web Search API | n/a | n/a | n/a | n/a | n/a | Eliminated: retired 2025-08-11 |
| Gemini grounding | $14 per 1,000 after allowance (brief) | No caching | Submitting user only | Analysis barred | Free tier used to improve products | Eliminated (brief 4.2; not re-read) |
| SerpApi-type scrapers | Not priced here | Terms silent on customer storage of results | Terms silent | Not addressed | Search data kept 31 days; ZeroTrace option | Eliminated: legal risk, see below |
| DuckDuckGo | n/a | n/a | n/a | n/a | n/a | Eliminated: no official search API found |

## Clause quotes

Format: clause, quote, source URL, accessed 2026-11-15, evidence class. Quotes are under 15 words. Where a bullet says paraphrased, it is not a quote.

### Brave Search API

Terms: https://api-dashboard.search.brave.com/terms-of-service **[fetched]**
- Storing/caching (section 3(b)(i)): "store, cache, or create a database of Search Results" is barred, with an exception for "transient storage required for operation of Customer Applications".
- Redistribution (3(b)(xii)): "redistribute, resell, or sublicense the Search Results". No clause was found on displaying to several people; paraphrased by the fetch tool, re-read at source.
- AI use (3(b)(xiii)): "use the Search Results to create, evaluate, train, re-train, fine-tune". The word "evaluate" matters: it may cover our eval harness and golden set. Re-read at source before any live eval run.
- Attribution (4(d)): attribution is optional ("may provide"); if given it is "POWERED BY BRAVE" with a logo. Paraphrased by the fetch tool, re-read at source.
- Query data (7(b), 9(b)): paraphrased by the fetch tool: safeguards for Search Query Data, no retention period, defers to the Privacy Notice, which was not read.

Pricing and plans: https://brave.com/search/api/ **[fetched]**
- Search plan: "$5 per 1,000 requests", 50 queries per second, "$5 in free credits each month". Top of the page says "Up to $20 in free calls every month". The two figures are not reconciled; budget on $5.
- Storage FAQ: "Yes, with a custom plan." to storing results (paraphrased by the fetch tool).
- Query handling: "Queries never shared or trained on." This is a page line under Enterprise-ready, not a contract clause; the fetch tool said it refers to queries, not results.
- Storage-rights prices ($26 and $45 per 1,000, 20 and 50 queries per second) came from a web-search summary of Brave's pricing page, not from a fetch of the page. **[search-summary]** The pricing doc URL https://api-dashboard.search.brave.com/documentation/pricing returned only headings, and the rate-limiting doc path returned 404 or an example only.

### Exa

Terms: https://exa.ai/terms-of-service (PDF) **[raw, text extracted locally]**. These are the website/Search Engine/API terms; no separate API agreement was found or read.
- Copying and display (4.2(a)): barred to "distribute, transmit, display" any information "obtained from or through" the Services except "temporary files that are automatically cached by your web browser". Whether this binds API results shown in a channel is unresolved.
- Resale (4.2(e)): "resell, lease or sublicense the Services to any third party".
- Scraping (4.2(j)): bars automated means that "mines, scrapes, extracts" from the Services; calling the documented API is presumably outside it (inference, not confirmed).
- Licence over our data (1(c)): Exa takes a perpetual licence to "access, use, host, cache, store" our input and output "to provide, develop and improve" its services. Our input is the de-identified query, class A.
- Output (section 6): Exa disclaims responsibility; no attribution requirement was seen.

Pricing: https://exa.ai/pricing **[fetched]**
- Free: "$10 in credits (up to 2,500 Lite searches)", resets monthly, no payment method on sign-up.
- Search: Lite and Instant $4 per 1,000; Auto and Fast "$7 / 1k requests"; Deep $12 to $15 per 1,000. Each result beyond 10 adds $1 per 1,000.
- ZDR: an Enterprise feature; the annual plan is "$12,000" upfront. Standard-plan rate limits not stated.

### Kagi Search API

Terms: https://kagi.com/privacy/api **[fetched]**
- Storage: "may not create a persistent copy of" Results; caching allowed only as "transient caching needed to operate your application"; on termination "delete any cached Results".
- Redistribution: "Resell, sublicense, proxy, redistribute, or publish the API" is barred unless agreed in writing. The wording targets the API; display to a group is not addressed.
- AI use: "sending Results to an AI model to answer your users' queries" is permitted; using Results to train a search index is barred.
- Queries: "Queries may be logged temporarily, separated from your account". No retention period stated.
Pricing: https://kagi.com/api/pricing **[fetched]**: "$12 /1k requests"; rate limits not stated. https://help.kagi.com/kagi/api/search.html confirmed a bearer-token API and pointed to the pricing and terms pages.

### Tavily

Terms: https://tavily.com/terms **[fetched]**
- Storage and display: no explicit provision found; the fetch tool found only a limit on "license, sublicense, resell, distribute" the Services.
- AI use (6.5): the phrase "for purposes of training, improving, developing, and enhancing artificial intelligence models" appears; which party it empowers could not be confirmed. Paraphrased by the fetch tool: third-party AI providers may keep rights to Customer Input and Output (6.7).
- Queries (1.3, 7, 9.2): queries are "Customer Input"; "Tavily may share Customer Input with its affiliates and vendors"; a perpetual licence over input.
Pricing: https://tavily.com/pricing **[fetched]**: 1,000 credits a month free, "$0.008 per credit" pay as you go, Project $30 for 4,000 credits. Credit cost: https://docs.tavily.com/documentation/api-credits **[fetched]**: basic search "1 API credit", advanced 2. Rate limits not stated.

### Anthropic web search tool

Docs: https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool **[raw]**
- Price: "$10 USD per 1,000 searches, plus standard token costs"; results count as input tokens.
- Display: "citations must be included to the original source" when API outputs are shown to end users; if reprocessed, "consultation with your legal team".
- Citation text: "Up to 150 characters of the cited content" per citation.
- Results come with `encrypted_content` that "you must pass back in multi-turn conversations"; the page text is not readable by us, so claim checking against the page still needs our own fetch.
- Domain control: `allowed_domains` or `blocked_domains`, one of them per request; wildcards only in the path.
- Retention: ZDR "Eligible" for the basic version; dynamic filtering versions are not (same page, and https://platform.claude.com/docs/en/manage-claude/api-and-data-retention **[raw]**).
Terms: https://www.anthropic.com/legal/commercial-terms **[fetched]**: "Anthropic may not train models on Customer Content from Services." No clause specific to web search found. Storage and group display of search results: **not addressed on any page read.**

### Eliminated

- Google Custom Search JSON API, https://developers.google.com/custom-search/v1/overview **[fetched]**: "The Custom Search JSON API is closed to new customers." Existing customers have until 2027-01-01. Free 100 a day, $5 per 1,000 beyond.
- Bing Search APIs, https://learn.microsoft.com/en-us/lifecycle/announcements/bing-search-api-retirement **[raw]**: "Bing Search APIs will be retired on August 11, 2025." Microsoft points to Grounding with Bing in Azure AI Agents; its terms were not read (probably the same display limits as other grounding products; unverified).
- DuckDuckGo: the help page fetched (https://duckduckgo.com/duckduckgo-help-pages/results/syntax/) says nothing about an API **[fetched]**. I found no official search-results API. Scraping its pages is not evaluated and not recommended.
- SerpApi, https://serpapi.com/legal **[fetched]**: the service says it "assumes liability for the lawful collection of public search data" and offers a "US Legal Shield" up to $2 million on paid recurring plans, which signals the legality of scraping search engines is contested. It says search data is "retained for 31 days". It does not say whether customers may store or display results. Legal risk and unclear terms; not shortlisted.

## Decision (proposed): shortlist of two

**1. Brave Search API (primary).** Reasons: cheapest per useful search with an explicit AI-use sale ("chatbots & agents"), a page statement that queries are not shared or trained on, free monthly credit covering most of the load, optional attribution, and 50 queries per second so no throttle risk. Blocker: the Search plan bars storing Search Results "in whole or in part" outside transient storage, and "evaluate" appears in the AI clause. Mitigation: build our stored source row from our own fetch of the cited page, keep Brave results transient, and ask Brave in writing whether that is within the Search plan and whether eval runs count as "evaluate". If Brave says no, the storage-rights plan at $26 per 1,000 [search-summary] would cost $46.80 a month at ceiling load: out of budget, so Brave would drop out.

**2. Exa (secondary, conditional).** Reasons: the free $10 credit covers the load on Lite, cheapest at ceiling; neural search tends to suit "find the guide page" queries (unmeasured; the Phase 1 probe decides). Blocker: the terms I could read are generic website terms whose 4.2(a) bars display and distribution of information obtained through the Services. Without an API-specific agreement or written clarification, group display and storing a URL/title/quote row is an unresolved risk.

Reserve, not shortlisted: Kagi (cleanest written AI and cache terms; $21.60 a month exceeds the target). Anthropic web search (consider only if the compose model is Claude and one fused call is acceptable; $18 a month plus tokens).

Both shortlisted providers get the same A/B in the source probe: ten real-shaped queries, record results once, count answerable ones, measure Worker CPU and subrequests. Search quality has not been measured in this ADR.

## Cost estimate

Ceiling load: 30 questions x 2 searches = 60 per day; 60 x 30 = 1,800 per month. Page fetches are ours and cost no search fee.

| Provider | Arithmetic | Monthly |
|---|---|---|
| Brave | 1,800 / 1,000 x $5 = $9.00; less $5 free credit | $4.00 (about $0 if the "up to $20" claim holds) |
| Exa Lite | 1,800 / 1,000 x $4 = $7.20; inside the $10 credit | $0.00 |
| Exa Auto | 1,800 / 1,000 x $7 = $12.60; less $10 credit | $2.60 |
| Kagi | 1,800 / 1,000 x $12 | $21.60 |
| Tavily | 1,800 credits, 1,000 free, 800 x $0.008 | $6.40 |
| Anthropic | 1,800 / 1,000 x $10, plus result tokens (price not fetched) | $18.00 + tokens |

Test-set run: about 1,000 searches [brief 5.4, derived]. Brave 1,000 / 1,000 x $5 = $5.00; Exa Lite = $4.00. Record once and replay; a live run only at the gate.

At the observed rate (about 3 asks a week) the real bill is a small fraction of the ceiling and falls inside free credit for Brave and Exa.

## What each needs from the owner (not done here)

- Brave: create an API account, enable billing on the Search plan (a card is likely needed to hold the $5 credit; unverified), generate a key. Email Brave: (a) is storing URL, title, a quote under 15 words and a date, derived from our own fetch of the page, allowed; (b) does running our evaluation set count as "evaluate"; (c) may results be shown in a shared Discord channel; (d) the Privacy Notice's retention period for query data.
- Exa: create an account, generate a key (no payment method needed for the free credit, per the pricing page). Email Exa for the API terms and written answers on group display, storing a source row, and query retention; ask whether Enterprise ZDR is the only way to opt out of input use.
- Both: the keys go in Worker secrets, never the repo, by the owner.

## Risks

- Store versus transient: the Brave and Kagi clauses bar a "persistent copy" of results; whether a URL/title/short quote row is one is a legal reading, not settled.
- Exa's generic terms may forbid the very display we need.
- Price and free-credit pages change; Brave's page contradicts itself ($5 vs $20) and Brave's pricing detail was not fully readable.
- Search quality for a game launched 2026-11-04 may be poor in any index; the Phase 1 probe must measure it.
- De-identification: queries to any provider must pass the outbound name and canary test (brief 5.5); a friend can type anything.
- Eval harness: any "no evaluation on results" clause constrains the golden-set runs; record-and-replay may itself be storage.
- Worker limits: parsing a search JSON response is cheap; the page fetch and parse step is the likely 10 ms CPU risk (brief 5.4), independent of provider.

## Unknown / not read

- Brave: the Privacy Notice and any query retention period; the full text of sections 4(c) and 14; the plans page rate limits per plan; current storage-rights prices from the page itself (only a search summary).
- Exa: any API-specific terms, usage policy or privacy policy; rate limits for standard plans.
- Kagi: the Privacy Policy retention period; the actual API terms were seen through a fetch summary only; the free trial or credit terms, if any.
- Tavily: the privacy policy; section 6.5 context; rate limits.
- Anthropic: terms for storing or displaying web search results; the underlying search provider; per-token costs and the Haiku price for a search-capable call; the commercial data retention policy page.
- Gemini grounding: not re-read; the brief's reading of aistudio.google.com/docs/terms is relied on.
- Grounding with Bing, Perplexity Sonar, Linkup, Serper, SearXNG-style metasearch: not evaluated.
- DuckDuckGo terms of service; whether a public "instant answer" endpoint exists and what it permits.
- Legal advice: none taken. Nothing here is a legal opinion.
