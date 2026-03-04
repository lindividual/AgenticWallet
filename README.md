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
  - real Smart Account creation via `@biconomy/abstractjs` (Ethereum/Base/BNB)
- Supported chains API: Ethereum, Base, BNB Chain
- Agent recommendation API stub

## Project Structure
- `apps/api`: Worker API (also serves built frontend assets in production)
- `apps/web`: React app

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
```
- Update `apps/api/.dev.vars` RPC values:
  - `SIM_API_KEY`
  - `BGW_API_KEY` / `BGW_API_SECRET` (optional, defaults to Bitget Wallet public demo credentials)
  - `COINGECKO_API_KEY` (optional, public free tier works without key)
  - `COINGECKO_API_BASE_URL` (optional, use `https://pro-api.coingecko.com/api/v3` for pro key)
  - `COINGECKO_USER_AGENT` (recommended, e.g. `AgenticWallet-MVP/0.1 (...)`)
  - `ETHEREUM_RPC_URL`
  - `BASE_RPC_URL`
  - `BNB_RPC_URL`
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

## Single-Worker Deployment (API + Static Assets)
1. Build frontend assets
```bash
npm run build:web
```

2. Deploy Worker (Hono API + `apps/web/dist` assets)
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
- Wallet creation currently uses backend-generated EOA and keeps a placeholder for Biconomy Abstract integration.

## Market Shelves (Phase 1)
- `GET /v1/market/top-assets` supports `name` (`topGainers|topLosers|topVolume|marketCap|trending`), `source` (`auto|coingecko|bitget`), and optional `category`.
- `POST /v1/market/coingecko/platforms/sync` syncs CoinGecko `coins/list?include_platform=true` into local D1 (incremental write: changed rows only).
- `GET /v1/market/coingecko/platforms/sync-status` returns last sync metadata.
- Strategy:
  - Top assets: CoinGecko first, Bitget fallback (only for list types Bitget supports).
  - Token detail and kline: Bitget.
