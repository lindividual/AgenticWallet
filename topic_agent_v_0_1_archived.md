# Topic Agent v0.1 Archived

Snapshot date: 2026-03-13

This document captures the current topic-special generation pipeline as implemented in `apps/api/src/services/topicSpecials.ts` and related routing / durable object code. It is intended as an archived baseline before the next round of prompt and context upgrades.

## Goal

The current Topic Agent v0.1 generates market-wide topic articles for the wallet home feed. It is not personalized per user. The output is a short, actionable markdown article that connects traditional finance signals with crypto market implications.

## Runtime Entry Points

- Manual trigger:
  - `POST /v1/admin/topic-specials/run`
  - Requires bearer session auth and `x-topic-special-admin-token`
- Scheduled trigger:
  - Cron `5 */4 * * *`
- Coordinator:
  - `apps/api/src/services/topicSpecialCoordinator.ts`
- Job runner:
  - `apps/api/src/durableObjects/topicSpecialDO.ts`

## High-Level Flow

1. A job is queued into `TopicSpecialDO`.
2. The DO calls `generateTopicSpecialBatch(...)`.
3. The batch loader fetches cross-market source inputs:
   - OpenNews crypto news
   - OpenTwitter crypto tweets
   - RSS headlines
   - top market-cap assets
   - trade browse data including perps and predictions
4. The system compresses those sources into:
   - `sourceRefs`
   - `defaultAssets`
5. The model first generates topic drafts.
6. Drafts are filtered against existing slot content.
7. For each selected draft, the model writes a markdown article.
8. Markdown is stored in R2 and metadata is stored in D1 table `topic_special_articles`.

## Slotting and Capacity Rules

- Slot size: 4 hours
- Slot key format: `YYYY-MM-DDTHH`
- Max articles per slot: 5
- Max topic-special articles per day: 10
- Forced runs still respect slot/day capacity, but ensure at least one attempt when capacity remains

## Current Context Sources

The article pipeline currently pulls these raw inputs:

- News items from OpenNews, filtered by:
  - `bitcoin`
  - `ethereum`
  - `crypto`
  - `stablecoin`
  - `etf`
  - `fed`
  - `interest rate`
  - `treasury`
  - `nasdaq`
  - `s&p 500`
- Tweets from OpenTwitter, filtered by:
  - `bitcoin`
  - `ethereum`
  - `crypto`
  - `fed`
  - `rates`
  - `risk-on`
  - `risk-off`
  - `nasdaq`
  - `etf`
  - `stablecoin`
- RSS headlines from the user-agent RSS helper
- Top market-cap assets from market data
- Trade browse data:
  - top movers
  - trending assets
  - perps
  - prediction markets

## Current Context Compression

The model does not receive the raw API payloads directly. The pipeline compresses them into a much smaller prompt context.

### `sourceRefs`

Built from:

- news titles plus optional source name
- RSS headlines
- tweet text with optional handle

Normalization rules:

- trim whitespace
- cut each line to 180 chars
- dedupe
- keep at most 18 lines for draft generation
- keep at most 8 lines for article generation

### `defaultAssets`

Built from:

- top market-cap asset symbols
- symbols inferred from news items

Normalization rules:

- uppercase symbol cleanup
- dedupe
- prefer at least 3 candidates
- fallback to `BTC, ETH, SOL, USDC, USDT` if the pool is too thin

### `relatedAssetRefs`

Used for article metadata and UI hydration, not as full prompt context. These refs are built from:

- spot assets
- relevant perp markets
- relevant prediction markets

Selection is based on:

- symbol matching
- asset name matching
- simple keyword scoring against topic and summary
- volume-based sorting for perps and predictions

## Two-Stage Prompt Design

### Stage 1: Topic Draft Generation

System prompt:

```text
You are a market strategist writing topic plans for a fintech wallet app.
Generate 3 to 5 investable topics that connect traditional finance and crypto markets.
Topics must be grounded in provided news and Twitter signals.
Output strict JSON array only.
```

User prompt shape:

```text
Create 3 to 5 topic objects in JSON array format.
Each object must include:
- "topic": concise title
- "summary": one sentence (< 180 chars)
- "related_assets": array with 2 to 5 uppercase symbols
- "source_refs": array with 1 to 3 short references copied from input lines

Hard requirements:
- Blend traditional finance and crypto perspectives.
- Prioritize actionable investment monitoring angles.
- Do not output markdown.
- Do not output keys other than topic, summary, related_assets, source_refs.

Candidate assets: {asset list}

Input source lines:
- {source ref 1}
- {source ref 2}
- ...
```

Current generation settings:

- temperature: `0.35`
- max tokens: `1600`
- retries: `3`

### Stage 2: Article Writing

System prompt:

```text
You are a cross-market analyst writing actionable topic briefs for wallet users.
Every article must connect traditional finance and crypto market transmission.
Output markdown only.
Include a final "## Related Assets" section with bullet symbols.
```

User prompt shape:

```text
Slot: {slotKey}
Topic: {topic}
Summary anchor: {summary}
Related assets: {asset1}, {asset2}, ...

Source references:
- {ref1}
- {ref2}
- ...

Output structure:
- # Title
- ## Why this matters now
- ## TradFi x Crypto transmission
- ## Scenario watch
- ## Action checklist
- ## Related Assets

Rules:
- 280 to 450 words.
- No fabricated prices or percentages.
- Keep language direct and practical for investors.
- Mention both opportunities and risks.
```

Current generation settings:

- temperature: `0.45`
- max tokens: `1400`
- retries: `3`

## Current Output Contract

Each article is expected to include:

- title
- why-it-matters framing
- TradFi to crypto transmission explanation
- scenario watch
- action checklist
- related assets section

Storage layout:

- R2 markdown:
  - `special-topics/{slotKey}/{topicSlug}-{articleId}.md`
- D1 metadata:
  - `topic_special_articles`

## Current Fallback Behavior

If LLM draft generation fails:

- the system logs `topic_special_draft_llm_failed`
- it falls back to fixed theme templates

Fallback themes currently include:

- `Bitcoin Liquidity and ETF Flow Watch`
- `Ethereum Positioning and Yield Rotation`
- `Stablecoin Policy and Payment Rails`
- `Macro Risk Appetite and Crypto Beta`
- `Cross-Market Liquidity Rotation`

If LLM article generation fails:

- the system logs `topic_special_article_llm_failed`
- it writes a template markdown article instead of failing the whole job

As a result, a job may finish with status `succeeded` even when some or all content was generated via fallback.

## Current AI Gateway Status

As of this archive:

- `Cloudflare AI Gateway compat/chat/completions` works
- `Cloudflare AI Gateway compat/responses` does not work for this project path
- `Cloudflare AI Gateway openai/responses` works

The project was updated to keep using OpenAI Responses API through the AI Gateway OpenAI provider path instead of the compat path.

Current local configuration target:

```text
LLM_BASE_URL=https://gateway.ai.cloudflare.com/v1/{account}/{gateway}/openai
LLM_MODEL=gpt-4.1-nano
```

## What v0.1 Does Well

- Keeps prompt context compact and cheap
- Produces stable article structure
- Connects macro and crypto instead of writing isolated token news
- Has robust fallback behavior, so the feed can still populate when LLM fails
- Associates related spot/perp/prediction entities for downstream UI use

## Main Limitations

- Not personalized to user holdings, watchlist, reading history, or trading behavior
- Source context is shallow and mostly title-line based
- No explicit market snapshot metrics are passed into the prompt
- No recency weighting or source-confidence weighting in prompt content
- Fallback content is not explicitly marked in the saved article metadata
- Article quality depends heavily on compressed source lines rather than structured evidence
- The current prompt can still drift into generic market commentary

## Archived Conclusion

Topic Agent v0.1 is a useful resilient baseline for market-wide topic content. It is good enough to keep a home feed alive, but it should be treated as a first-pass drafting system rather than a high-signal research agent. The next version should improve evidence quality, controllability, and personalization while preserving the current operational resilience.
