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
- `apps/api`: Worker API
- `apps/web`: React app

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
  - `ETHEREUM_RPC_URL`
  - `BASE_RPC_URL`
  - `BNB_RPC_URL`
- Set secrets:
```bash
cd apps/api
npx wrangler secret put APP_SECRET
npx wrangler secret put WEBAUTHN_ORIGIN
npx wrangler secret put WEBAUTHN_RP_ID
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

## Important Notes
- This is MVP code and not production-hardening.
- Passkey requires HTTPS in production and correct RP ID / origin pairing.
- Wallet creation currently uses backend-generated EOA and keeps a placeholder for Biconomy Abstract integration.
