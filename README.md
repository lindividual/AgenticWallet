# Agentic Wallet MVP

Passkey-only login/register MVP for an agentic crypto wallet.

## Stack
- Backend: Cloudflare Workers + Hono + D1
- Frontend: React + Vite + TypeScript
- Passkey: `@simplewebauthn/server` + `@simplewebauthn/browser`

## MVP Scope
- Passkey register/login (no Google login)
- Step-up payment verification with passkey (`userVerification=required`)
- Session token issued by Worker
- User wallet bootstrap on first registration:
  - server-generated EOA key, encrypted-at-rest
  - EOA address reused across Ethereum/Base/BNB/Arbitrum/Optimism/Polygon
  - EIP-7702 orchestration via `@biconomy/abstractjs` for gasless-capable flows
- Supported chains API: Ethereum, Base, BNB Chain, Arbitrum, Optimism, Polygon, Tron, Solana, Bitcoin
- Agent recommendation API stub

## Project Structure
- `apps/api`: Worker API (also serves built frontend assets in production)
- `apps/web`: React app
- `apps/webapp`: 独立的 Agent 后台工程，构建后会挂到同域 `/ops/`

## App Config (配置文件)
- Edit `apps/api/src/config/appConfig.ts` to control:
  - `supportedChains`: which chains are supported
  - `defaultReceiveTokens`: which tokens are shown by default in receive flow

## Quick Start
1. Install dependencies
```bash
npm install
```

2. Configure Worker env and D1
- Edit `apps/api/wrangler.toml`:
  - `database_id`
- Create local vars:
```bash
cp apps/api/.dev.vars.example apps/api/.dev.vars
cp apps/web/.env.example apps/web/.env
cp apps/webapp/.env.example apps/webapp/.env
```
- Update `apps/api/.dev.vars`:
  - `SIM_API_KEY`
  - `BGW_API_KEY` / `BGW_API_SECRET` (optional, defaults to Bitget Wallet public demo credentials)
  - `COINGECKO_API_KEY` (optional, public free tier works without key)
  - `COINGECKO_API_BASE_URL` (optional, use `https://pro-api.coingecko.com/api/v3` for pro key)
  - `COINGECKO_USER_AGENT` (recommended, e.g. `AgenticWallet-MVP/0.1 (...)`)
  - `ADMIN_API_TOKEN` (optional, enables `/v1/admin/*` management APIs without passkey/session)
  - `ETHEREUM_RPC_URL`
  - `BASE_RPC_URL`
  - `BNB_RPC_URL`
  - `ARBITRUM_RPC_URL`
  - `OPTIMISM_RPC_URL`
  - `POLYGON_RPC_URL`
  - `BICONOMY_API_KEY` (required for cross-chain stablecoin transfer quote/execute)
  - `BICONOMY_API_BASE_URL` (optional, defaults to `https://api.biconomy.io`)
- Optional LLM settings:
  - Direct Gemini call on Cloudflare AI Gateway:
    - `LLM_PROVIDER=gemini`
    - `LLM_MODEL=gemini-2.5-flash`
    - `LLM_BASE_URL=https://gateway.ai.cloudflare.com/v1/<ACCOUNT_ID>/<GATEWAY_ID>/google-ai-studio`
    - `CF_AIG_TOKEN=<your gateway token>`
  - OpenAI primary with Gemini fallback on the same Cloudflare AI Gateway:
    - `LLM_PROVIDER=openai`
    - `LLM_BASE_URL=https://gateway.ai.cloudflare.com/v1/<ACCOUNT_ID>/<GATEWAY_ID>/openai`
    - `LLM_MODEL=gpt-4.1-nano`
    - `LLM_FALLBACK_PROVIDER=gemini`
    - `LLM_FALLBACK_MODEL=gemini-2.5-flash`
    - `CF_AI_GATEWAY_ACCOUNT_ID=<ACCOUNT_ID>`
    - `CF_AI_GATEWAY_GATEWAY_ID=<GATEWAY_ID>`
    - `CF_AIG_TOKEN=<your gateway token>`
  - Or keep default OpenAI route by leaving `LLM_PROVIDER=openai` and setting `LLM_API_KEY`.
- Set secrets:
```bash
cd apps/api
npx wrangler secret put APP_SECRET
npx wrangler secret put WEBAUTHN_RP_NAME
```

3. Apply local D1 migrations
```bash
cd apps/api
npx wrangler d1 migrations apply agentic_wallet_db --local
```

4. Run backend
```bash
npm run dev:api
```

5. Run frontend (new terminal)
```bash
npm run dev:web
```

6. Build and open the admin console
```bash
npm run build:web
npm run build:webapp
npm run dev:api
```

Then open:
- User app: `http://127.0.0.1:8787/`
- Agent ops console: `http://127.0.0.1:8787/ops/`

Notes:
- `/ops/` now uses admin-token auth instead of passkey auth.
- Set `ADMIN_API_TOKEN` in `apps/api/.dev.vars`, then paste the same token into the `/ops/` login screen.
- The admin console currently has two views:
  - `User Agent`: browse different users and inspect each user's useragent state.
  - `Topic Agent`: inspect global topic-generation pipeline jobs and recent topic articles.
- `/v1/admin/*` routes no longer reuse user session auth; they accept an admin token via `Authorization: Bearer <ADMIN_API_TOKEN>` (or legacy `X-Topic-Special-Admin-Token`).

## Single-Worker Deployment (API + Static Assets)
1. Build frontend assets
```bash
npm run build:web
npm run build:webapp
```

2. Deploy Worker (Hono API + `apps/web/dist` assets, including `/ops/`)
```bash
npm run deploy:worker
```

Notes:
- Worker static assets are configured in `apps/api/wrangler.toml` under `[assets]`.
- API routes stay on `/v1/*`, static routes are served from the same domain.
- In production, keep `VITE_API_BASE` empty so frontend calls same-origin APIs.

## Important Notes
- This is MVP code and not production-hardening.
- Passkey requires HTTPS in production.
- WebAuthn `origin` and `rpId` are derived from each incoming request (`origin` + `hostname`), so frontend and API should be served on the same host for passkey flows.
- Wallet creation now uses backend-generated EOA addresses for EVM chains, with EIP-7702/MEE execution for orchestrated flows.

## Market Shelves (Phase 1)
- `GET /v1/market/top-assets` supports `name` (`topGainers|topLosers|topVolume|marketCap|trending`), `source` (`auto|coingecko|bitget`), and optional `category`.
- `POST /v1/market/coingecko/platforms/sync` syncs CoinGecko `coins/list?include_platform=true` into local D1 (incremental write: changed rows only).
- `GET /v1/market/coingecko/platforms/sync-status` returns last sync metadata.
- Strategy:
  - Top assets: CoinGecko first, Bitget fallback (only for list types Bitget supports).
  - Token detail and kline: Bitget.
