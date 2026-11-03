# Answer cache key and gateway log labels

Where: `infrastructure/worker/ai-models.js` (`buildAnswerCacheKey`, `answerModelLabel`, `gatewayMetadata`). Applies to the AI Gateway cache (6 hour TTL) used by `answerWithAi` for every provider except Workers AI.

## Key format

```
ask:<provider>:<model>:<fast|deep>:<variant>:<tier>:<promptHash>
```

`promptHash` is the first 32 hex of SHA-256 over `JSON.stringify([modelId, max_tokens, temperature, systemPrompt, userPrompt])`: an unambiguous encoding (no separator can be forged by prompt text), with the exact model id and the output-affecting params included. Everything that shapes the answer is in those two prompts: the asker's display name, member or visitor status, journey, coach mode, party state, retrieved library facts, library epoch, and the persona pack text. So anything that changes the prompt changes the key, and a persona deploy never serves the old voice for 6 hours.

`provider`, `model`, depth, `variant` (`production` on the live path) and `tier` (`member` or `guest`) are repeated in readable form so gateway logs are easy to scan. `model` in the readable part is a 40 character label from `answerModelLabel`, which mirrors the model defaults in the provider calls (change both together); the full id is inside the hash. The Gemini 429/503 retry on the lighter model sends no cache key, so the first model's key is never reused for another model.

Raw names, slugs, ids and question text never appear in the key, only the digest.

## Why sharing is safe

Two asks share a cached answer only when their prompts are identical byte for byte: same asker name and status, same journey, same persona text, same facts. The cost is a lower hit rate (two different askers of the same question no longer share), which is intended.

## Workers AI

Workers AI does not send this key. Its gateway cache keys on the request body, which is the same prompts. PR previews force Workers AI, so a preview or API-suite run can never exercise this key. The proof is `tests/unit/answer-cache-key.test.mjs`, which runs the real `answerWithAi` path with a stubbed fetch and reads the `cf-aig-cache-key` header.

## Gateway log labels (`cf-aig-metadata`)

`{ app, service, variant, tier, journey }` (5 keys, the gateway limit). `variant` is one of `production`, `plain`, `examples-6`, `format-reminder`, else `other`. `tier` is `member` or `guest`; `journey` is `guided`, `curious`, `everything` or `other`. Fixed vocabulary only: never a name, slug, id or question text. Filter on these fields in the AI Gateway logs to split traffic.

## Rollback

Revert the PR. Cached rows under the other key shape are never read again and expire on their own; the first ask after deploy or revert misses once.
