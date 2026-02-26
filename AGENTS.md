# AGENTS.md

## Cursor Cloud specific instructions

### Architecture

npm workspaces monorepo with two apps:

- **`apps/api`** — Cloudflare Worker (Hono) serving API at `/v1/*` and static frontend assets. Uses Wrangler for local dev (D1, Durable Objects, R2 all emulated locally).
- **`apps/web`** — React + Vite SPA.

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
