# PROMPT_PREFIX_ORDER (off by default)

Flag in `[vars]` (`infrastructure/wrangler.toml`), read with `legacyOn` (only the word `on`). Unset or `off`: the system prompt and the Anthropic request are byte-identical to before.

**What it does (on).** For a production prompt on the legacy Claude path (not research, not an evaluation variant), the system prompt is built from the same parts in a new order: a STABLE block first (persona text, the "Never do" list, the fixed PLATFORM RULES lines, PERSONALISE_RULE, VOICE_RULE, FENCE_RULE), then the VARIABLE parts (journey depth, running bits, examples, the Library-Epoch line, the coach prompt, the group-memory rule). `callAnthropicClaude` sends the stable block as its own system block with `cache_control`, and the variable rest as a second, uncached block. If the prompt does not start with the named prefix, one cached block is sent as before.

**What changes for readers.** Only the order the model reads the same lines in, and the Library-Epoch line moves out of the PLATFORM RULES block into the variable part. That can change wording slightly, so it stays off until Matt agrees.

**Proof it is the same parts.** `tests/unit/prompt-prefix-order.test.mjs`: for every question, journey and coach setting the sorted lines of the old and new prompt are equal, and the stable block is one string for all of them. Offline over the 240 truth questions x 3 journeys with a fixture persona: 720 of 720 same set of lines, 720 reordered, 1 distinct stable block. The real persona lives in D1 and was not read.

**Measure before turning on.** PR "Record cache token counts" puts `cache_creation_input_tokens` and `cache_read_input_tokens` in the shadow row meta. Compare the cache read share with the flag off and on before any decision.

**Rollback.** Set the var to `off` (or remove it) and deploy.
