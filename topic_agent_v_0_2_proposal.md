# Topic Agent v0.2 Proposal

Date: 2026-03-13

## Why v0.2

Topic Agent v0.1 proved that the pipeline can reliably populate topic articles, but it still behaved too much like a templated writer:

- prompt constrained the article structure too tightly
- source context was shallow and compressed
- the model had limited room to reason about what was actually worth writing
- output quality could drift toward generic market commentary

v0.2 shifts the system from template-first writing to goal-driven market topic generation.

## Product Goals

The topic agent should optimize for these outcomes:

1. Surface hot topics that crypto, meme, or traditional finance users would care about now.
2. Produce high-quality content that can attract clicks, sustain reading, and improve investment conversion.
3. Write with internal logic and evidence, not empty jargon, filler, or obvious ad copy.

## Non-Goals

- No user personalization in topic selection or writing
- No sponsored tone
- No forced article template when the topic does not need it
- No direct buy/sell commands

## Design Direction

The v0.2 principle is:

Give the model a stronger research packet and a clearer mission. Constrain the output contract, not the thinking path.

That means:

- richer context
- more explicit editorial goals
- less rigid article outline
- stronger anti-filler / anti-promo constraints

## What v0.2 Implements

### 1. Research Packet Instead of Thin Source Refs

The model now receives a larger evidence bundle built from:

- headline and social tape
- detailed news signals
- ranked social signals
- spot market snapshot
- perp market snapshot
- prediction market snapshot
- already-covered topics for the day

For article writing, the packet is narrowed to topic-relevant signals rather than dumping all available context.

### 2. Goal-Driven Topic Selection

Draft generation no longer asks for generic investable topics with a rigid framing. It now asks for topics that:

- matter to crypto, meme, or TradFi audiences
- are strong enough to win a click and justify a full read
- are investment-useful
- avoid empty macro filler
- may be crypto-only, meme-only, or TradFi-only when that is the clearest framing
- avoid duplication of topics already covered today

### 3. Goal-Driven Article Writing

Article writing no longer forces a fixed section structure like:

- Why this matters now
- cross-market transmission
- Scenario watch
- Action checklist

Instead, the model is told to:

- write a high-quality topic article
- build a real argument from evidence
- choose its own structure
- keep a clear trigger -> evidence -> implication -> what to watch logic
- avoid sponsored or shill-like language
- allow crypto-only, meme-only, or TradFi-only framing when that is strongest

The only hard structural requirement retained is:

- final `## Related Assets` section

This preserves UI compatibility while letting the article read more naturally.

## Implementation Notes

Current implementation keeps the existing two-stage pipeline:

1. draft generation
2. article generation

This is intentional because it preserves:

- slot-level dedupe
- storage shape
- fallback safety
- operational simplicity

The major change is inside the prompt and context assembly, not the queueing architecture.

## Current v0.2 Prompt Philosophy

### Draft Prompt

Focus:

- identify the most decision-useful topics
- maximize reader interest without clickbait
- require evidence-backed angles
- avoid repeated topics

Output still returns:

- `topic`
- `summary`
- `related_assets`
- `source_refs`

### Article Prompt

Focus:

- high-quality market topic article
- compelling but not promotional
- useful for investing decisions
- logically structured by the model itself

The model is explicitly told:

- not to use generic filler
- not to sound sponsored
- not to fabricate stats
- not to default to a canned template

## Architecture Choice

### Why not tool-calling yet

The long-term direction can absolutely include true tool-calling through Responses API. That would let the agent decide which data sources to inspect dynamically.

But v0.2 intentionally stops one step earlier:

- it packages tool-like outputs into a research packet
- it improves quality immediately
- it avoids turning the content pipeline into a multi-step agent loop yet

This keeps the implementation small, predictable, and easy to debug while moving in the right direction.

## Future v0.3 Direction

If v0.2 quality is materially better, v0.3 can introduce true Responses API tool-calling for:

- recent news lookup
- social signal lookup
- market snapshot lookup
- perps lookup
- prediction lookup
- existing-topic lookup

That version would let the model determine its own research path instead of consuming a precompiled packet.

## Success Criteria

v0.2 should be considered successful if:

- generated titles feel more topical and less generic
- new articles read less like a canned template
- the article body makes a clearer argument from evidence
- users are more likely to click and keep reading
- output avoids shill / promo tone even on bullish topics

## Summary

v0.2 is not a personalization release and not yet a full autonomous research agent. It is a deliberate upgrade from prompt-template writing to mission-driven topic generation with a richer evidence packet.

That should raise quality quickly without sacrificing the reliability that made v0.1 workable.
