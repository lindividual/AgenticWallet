# AGENTS.md

## Cursor Cloud specific instructions

### Architecture

npm workspaces monorepo with two apps:

- **`apps/api`** — Cloudflare Worker (Hono) serving API at `/v1/*` and static frontend assets. Uses Wrangler for local dev (D1, Durable Objects, R2 all emulated locally).
- **`apps/web`** — React + Vite SPA.

Backend route structure (under `apps/api/src/routes/`):
- `public.ts` — auth register/login, chains, app-config (no auth required)
- `protected.ts` — route registrar + `/v1/me` endpoint
- `wallet.ts` — portfolio routes
- `payment.ts` — payment verification routes
- `agent.ts` — agent events, articles, daily digest, recommendations, jobs
- `market.ts` — token catalog and market data sources

Daily digest content generation lives in `durableObjects/userAgentContentService.ts`. It reads portfolio snapshots from the DO's local SQLite, fetches RSS headlines, and calls the LLM (if configured) with enriched context. Fallback content is locale-aware (zh/en/ar).

Topic special generation uses a two-stage Durable Object pipeline. The lesson from the LLM/AI Gateway investigation is more specific than "Workers are serverless" or "requests cannot share memory". The important finding in this repo was:

- A plain LLM request could succeed.
- The same prompt could also succeed when sent directly from a simple probe route.
- But if the Worker first fanned out to multiple upstream source fetches and then immediately called the LLM in the same invocation, the LLM call could fail with a 429 before the request even appeared in AI Gateway logs.
- If that exact fetched source packet was first staged into durable storage and then consumed by a second execution context, the LLM call succeeded again.

So the architectural takeaway is not "all LLM calls need storage". It is:

- For multi-stage workflows on Cloudflare Workers, do not assume that "fan out to external APIs -> aggregate -> immediately fan in to an LLM" is equivalent to "send the same final prompt directly".
- A durable middle layer is required when you need an execution boundary, not just when you need to share state. In practice the middle layer gives four things at once: state handoff, retry isolation, a fresh execution context for the next stage, and observability on which stage failed.
- When a pipeline mixes many upstream fetches with a downstream AI call, model the workflow as `collect -> persist packet -> generate`, even if the packet is short enough to fit in memory.
- Keep admin preview/probe paths aligned with the production packetized path. A debug endpoint that skips the durable boundary can produce false conclusions because the failure may be tied to invocation shape rather than prompt content.
- Prefer SQLite-backed Durable Objects for new orchestration/stateful workflow code, following current Cloudflare guidance. If a legacy DO class was not created as SQLite-backed, migrate by introducing a new class name and new `new_sqlite_classes` migration instead of trying to convert the old class in place.

What we can say confidently after testing:

- The problem was not simply "LLM requests fail".
- The problem was not simply "prompt too large".
- The problem was not simply "Gemini fallback was missing".
- The problem was not simply "Durable Objects are required for storage".

What we should assume going forward:

- If a Worker pipeline does upstream fetch fan-out followed by an LLM call and starts showing unexplained 429s or provider-side missing logs, first test whether splitting the stages across a durable boundary makes the exact same final prompt succeed.
- If it does, keep the split architecture. Treat the execution-context boundary as part of the fix, not an implementation detail.

### Running dev servers

See `README.md` "Quick Start" for full details. Key commands:

- `npm run dev:api` — starts the API on port 8787
- `npm run dev:web` — starts the Vite dev server on port 5173

**Gotcha:** The API server (wrangler) requires `apps/web/dist` to exist because of the `[assets]` config in `wrangler.toml`. You must run `npm run build:web` before `npm run dev:api` if `apps/web/dist` doesn't exist yet.

### Environment files

Copy the example files before first run:

```
cp apps/api/.dev.vars.example apps/api/.dev.vars
cp apps/web/.env.example apps/web/.env
```

For local dev, set `VITE_API_BASE=http://127.0.0.1:8787` in `apps/web/.env`. Generate a random `APP_SECRET` in `.dev.vars` (e.g. `openssl rand -hex 32`). RPC URLs and LLM keys are optional for basic functionality.

### D1 migrations

Apply local D1 migrations before first API run:

```
cd apps/api && npx wrangler d1 migrations apply agentic_wallet_db --local
```

### TypeScript checks

- API: `npm run build:api` (runs `tsc --noEmit`)
- Web: `cd apps/web && npx tsc -b`

### Testing

- API has an E2E test script: `npm --workspace @agentic-wallet/api run test:agent-local`
- No unit test framework is configured; TypeScript compilation is the primary lint/check.

### Passkey / WebAuthn note

WebAuthn registration and login flows require a browser with passkey support. The API derives `rpId` and `origin` from the incoming request URL, so frontend and API should be on the same host for passkey flows in production. In local dev, `localhost` works for testing the options endpoints but full passkey verification requires a real browser authenticator.
