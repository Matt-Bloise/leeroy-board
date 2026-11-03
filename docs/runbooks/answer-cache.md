# Answer cache key and gateway log labels

Where: `infrastructure/worker/ai-models.js` (`buildAnswerCacheKey`, `gatewayMetadata`). Applies to the AI Gateway cache (6 hour TTL) used by `answerWithAi`.

## Key format

```
ask:<libraryStamp>:<provider>:<fast|deep>:<journey>[+coach]:<variant>:<tier>:<persona>:<asker>:<qHash>
```

| Part | Meaning |
|---|---|
| `libraryStamp` | Library epoch; a library change misses. |
| `provider`, `fast/deep` | Chosen provider and depth. |
| `journey` (`+coach`) | Prompt journey; `+coach` for a private guided ask (coach prompt). |
| `variant` | Prompt variant (`production` on the live path). |
| `tier` | `member` or `guest`. |
| `persona` | `<id>.v<version>.<8 hex>` of the persona pack, or `none`. The hex is a hash of the whole pack, so an edit that forgot to bump `version` still misses. |
| `asker` | `m<12 hex>` = salted hash of a member slug; `anon` for guests. |
| `qHash` | First 16 hex of SHA-256 of the question. |

Raw names, slugs and ids never appear in the key.

## Why sharing is safe

- Members: the prompt addresses a member by display name, so the answer is asker-specific and gets a per-member scope. Two members never share an entry.
- Guests: the prompt tells the model to address only party members by name, so a guest answer carries no name. All guests share the single `anon` scope, and a guest never shares with a member.
- Personas: a new pack (id, version or content) changes the key, so a persona deploy never serves the previous voice for up to 6 hours. Old rows simply miss once and expire.
- Workers AI: its gateway cache keys on the request body (prompt text, which already holds the asker name and persona), not on this key.

## Gateway log labels (`cf-aig-metadata`)

`{ app, service, variant, tier, journey }`. `tier` is `member` or `guest`; `journey` is `guided`, `curious`, `everything` or `other`. Fixed vocabulary only: never a name, slug, id or question text. In the AI Gateway logs, filter on these fields to split traffic.

## Rollback

Revert the PR. Cached rows under the old key shape are never read again and expire on their own; the first ask after the revert misses once.
