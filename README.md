# Fengle Backend

Node.js + Express + MySQL backend for the Fengle food delivery platform.
Read `CLAUDE.md` first — it has the business rules and architecture context
this API is built against.

## Setup

```bash
cp .env.example .env    # fill in DB credentials at minimum
npm install
npm run migrate         # runs all 24 migrations
npm run dev              # starts on PORT (default 4000)
```

Requires a running MySQL/MariaDB instance. Without Razorpay/MSG91 keys set,
payments and OTP both fall back to dev-safe stubs (see `services/payment.service.js`
and `utils/sms.js`) — OTPs print to the console, payments auto-succeed. This
means you can build and test the full order flow without waiting on Razorpay
Route approval or DLT registration.

## Verifying it works

`test_integration.js` is a real integration test against a live MySQL DB (not
mocks) — seeds data, places orders, exercises the routing/cascade/clubbing
engine, wallet/COD flow, and settlement. Run it after migrating:

```bash
node test_integration.js
```

Should print `41 passed, 0 failed` (as of this commit — update this number if
you add more). The script is not idempotent (fixed phone numbers, no teardown), so
run it against a fresh/rolled-back DB: `npx knex migrate:rollback --all && npx knex migrate:latest`.

## API surface

See **[docs/API.md](docs/API.md)** for the full endpoint reference (all four clients share one API under `/api/v1`) and **[postman/Fengle-Backend.postman_collection.json](postman/Fengle-Backend.postman_collection.json)** for an importable collection. Known gaps and placeholders are listed at the bottom of docs/API.md.
