# Fengle — Multi-Vendor, Category-First Food Delivery Platform

This file is read automatically by Claude Code at the start of every session.
Keep it current — it is the single source of truth for business rules and
architecture decisions so both developers (and both Claude Code sessions)
build consistent, compatible code without re-explaining context each time.

## What this platform is

Customers order by **food category** ("Bengali", "South Indian", "North
Indian", etc.), not by restaurant. Each category behaves like one virtual
kitchen to the customer — **restaurant identity is never shown to the
customer**, anywhere, at any stage. Behind the scenes, each category is
fulfilled by one of several partnered restaurants, matched by customer
location with automatic fallback.

Brand name: **Fengle**. Palette: deep violet (#4B18A6-ish) + turmeric gold
(#D99A1F) — see the Claude Design flatboards for exact tokens per screen.

## Non-negotiable business rules

- **Category lock**: a customer can order multiple items within ONE category
  per order. Ordering a second category normally requires a separate order —
  **except** when the same restaurant serves both categories, in which case
  the order can be "clubbed" into one bill, one pickup, one delivery.
- **Clubbed order partial-unavailability**: if some items in a clubbed order
  become unavailable, drop those items, adjust the bill, refund the
  difference to the customer's wallet. Do NOT cascade part of a clubbed
  order to a different restaurant (that implies two pickups for one
  delivery — out of scope).
- **Restaurant matching**: nearest restaurant serving the category within a
  5km radius (admin-configurable per restaurant). If unavailable, cascade to
  next-nearest, up to a 7km ceiling.
- **Catalog visibility is location-dependent**: a customer only sees items
  actually available from an in-range restaurant, not a flat global catalog.
- **Categories are kitchen-creatable, with no admin approval** (decision
  2026-09-21 — supersedes "categories are admin-only"). Safeguard: duplicate
  prevention, enforced server-side — the customer must never see "Momo" and
  "Momos". Names are compared by a normalized key (plural, case, filler words,
  Indian spelling variants — see `src/utils/categoryName.js`); an exact
  duplicate is always refused, a close match needs an explicit confirm, and a
  kitchen can create at most `MAX_CATEGORIES_PER_RESTAURANT` (default 10).
  Admin rename/merge/deactivate is a later Admin Panel job.
  A restaurant may also edit any item in a category it carries (shared item —
  see PATCH /items/:id); order lines snapshot the item name at placement so
  renames never rewrite order history.
- **Item creation**: both Admin and Restaurant can add items. No
  restaurant-exclusive items — the catalog is shared per category.
- **Restaurant onboarding is manual, via Admin Panel only.** There is no
  restaurant self-registration flow anywhere in the product. (Riders ARE
  self-serve — this asymmetry is intentional, don't "fix" it.)
- **Rider can see restaurant name/location. Customer never can.** This
  permission reversal is intentional.
- **No live GPS map tracking in Phase 1.** Delivery status is shown via
  discrete steps only: Order Placed → Accepted → Picked Up → On the Way →
  Delivered, pushed as notifications. A one-time ETA estimate is set at
  pickup and does NOT continuously update. Live GPS tracking is Phase 2.
- **Rider navigation uses a "Navigate" button that deep-links to Google
  Maps** — there is no in-app map/turn-by-turn built into the rider panel.
- **Minimum order value**: ₹50. No maximum.
- **Cancellation** (policy changed 2026-09-18 — supersedes the earlier
  "blocked only after Start Preparing" rule): a customer can cancel only
  within a short buffer window after placing (`ORDER_CANCEL_BUFFER_SECONDS`,
  default 60s — confirmed by the user 2026-09-21) AND only
  while the order is still `placed` (restaurant hasn't accepted). The
  client-side countdown is UX only; `POST /orders/:id/cancel` enforces both
  conditions server-side and triggers a refund if already paid.
- **Rating gate**: a customer with a delivered order that has no
  `restaurant_rating` and `restaurant_rating_skipped = false` is blocked
  from `POST /orders` (and reorder) until they call `rate-restaurant` or
  `skip-restaurant-rating` for it. Enforced server-side, not just in the app.
- **Invoices are issued by the platform, never by the fulfilling
  restaurant** (customer never learns which kitchen cooked the order).
  Issuer GSTIN/FSSAI/name in `invoice.service.js` are env-configurable
  placeholders — the client must supply real values before go-live.
- **Delivery confirmation OTP** (added 2026-09-27): every order gets a 4-digit
  `delivery_otp` generated at placement, shown to the customer only (never to
  the restaurant, rider, or admin via any read endpoint — a rider gets it only
  by asking the customer in person at drop-off). `POST /orders/:id/delivered`
  requires it and rejects a mismatch with 400; orders placed before this
  feature shipped have no stored code and skip the check. A reorder is a new
  order with its own fresh code.
- **COD reconciliation**: rider collects cash → logged as a rider liability
  in `wallet_ledger` → netted against rider's commission earnings at
  settlement (daily/weekly) → running balance shown in rider wallet. The
  rider must explicitly confirm the exact amount collected at the
  "Mark Delivered" step for a COD order — this is the trigger that creates
  the ledger entry. Do not skip this confirmation step in the UI.
- **Wallet** is shared infrastructure for both customer refunds/credits and
  rider COD reconciliation — see `wallet_ledger` table (owner_type/owner_id
  polymorphic pattern).
- **Account suspension** (added 2026-09-27, Admin Panel): a **blocked**
  customer (`users.status`) or a **suspended** rider/restaurant
  (`riders`/`restaurants.status`) cannot get a new session — `POST
  /auth/otp/verify` returns 403 even with the correct OTP. A blocked
  customer additionally can't place an order even on an already-issued
  token (`POST /orders` re-checks `users.status`, not just login).
- **Category merge/rename cleanup is an Admin Panel job**
  (`POST /admin/categories/:id/merge`, `PATCH /admin/categories/:id`) — the
  actual tool referenced by the "kitchen-creatable categories" bullet above.
  A merge moves items and restaurant-serving relationships to the target and
  deactivates the source; it deliberately does **not** rewrite
  `order_items.category_id` on past orders (same "never rewrite history"
  principle as the item-name snapshot).
- **In-app agreement + selfie verification** (added 2026-09-29, client
  request): on top of the physical signed agreement, a restaurant/rider must
  accept an in-app agreement with a live selfie before their app unlocks its
  main screens (`agreementRequired` on `GET /restaurants/me`/`GET /riders/me`;
  accepted via `POST .../me/accept-agreement`). Applies **only to accounts
  onboarded from the migration onward** — every pre-existing row was
  backfilled as already-accepted in the same migration, so seeded/dev
  accounts and everyone onboarded before 2026-09-29 are permanently exempt.
  No paid face-match/liveness API (out of scope for Oct 2) — the selfie is
  just an evidentiary trail an admin reviews by eye via
  `GET /admin/{restaurants,riders}/:id/agreement-selfie`, stored at an
  internal path that's never a public URL like catalog photos. This is a
  client-side/app gate plus an admin audit trail, **not** a server-side block
  on order-accept or rider-assignment — see `docs/API.md` if that needs
  tightening later.

## Tech stack (do not deviate without updating this file)

- **Backend**: Node.js + Express + MySQL (via Knex query builder, not an ORM)
- **Customer App**: React Native (Expo), Android first, iOS in Phase 1.5
  (same codebase — iOS is a build/QA/App-Store-review task, not a rewrite)
- **Restaurant + Rider Panels**: React Native (Expo + react-native-web) —
  shared web app, wrapped in a light native shell per platform ONLY for
  Firebase Cloud Messaging push notifications. Not full native builds.
- **Admin Panel**: React JS (SPA)
- **Business Website**: React JS (standalone, separate from the above)
- **Auth**: OTP + JWT
- **Payments**: Razorpay, incl. Route for split settlement (subject to RBI
  eligibility — treat as a pending external dependency, not yet live)
- **Maps**: Google Maps API for geocoding/distance calc only (NOT live
  tracking — see above)
- **Push**: Firebase Cloud Messaging
- **SMS/OTP**: MSG91 or Fast2SMS (Twilio is ~3x cost, avoid unless needed)
- **Email**: AWS SES
- **Storage**: AWS S3
- **Hosting**: AWS EC2 + MySQL (self-hosted on same instance, or RDS
  db.t3.micro if managed backups are wanted)

## Repo structure

```
fengle-backend/
  src/
    config/db.js
    migrations/     — 30 Knex migrations (run `npx knex migrate:latest`)
    controllers/    — auth, profile, catalog, cart, address, payment, order,
                      wallet, favorite, notification (customer-facing);
                      restaurant, rider, admin + adminOrders/adminCustomers/
                      adminCategories (portal-facing)
    routes/         — one router per controller, mounted in routes/index.js
    services/       — routing (nearest-match/cascade/clubbing), commission,
                      tax (GST), payment (Razorpay + dev stub), wallet
                      (ledger), settlement (rider), invoice (data + PDF),
                      storage (uploads + agreement selfies, disk/S3)
    middleware/     — auth, selfieUpload (multer for accept-agreement)
    utils/          — jwt, otp, sms, geo, agreement (CURRENT_AGREEMENT_VERSION)
  scripts/create-admin.js   — the only way an admin account is created
  scripts/seed.js           — dev catalog, 7 dev restaurants, dev rider (npm run seed)
  scripts/advance-order.js  — dev-only: push an order through its status steps
  scripts/add-credit.js     — dev-only: add wallet credit to a test customer
  assets/fonts/             — Noto Sans (invoice PDF; includes the ₹ glyph)
  uploads/                  — dev image uploads (gitignored; S3 in production)
  docs/API.md               — full endpoint reference (start here)
  postman/                  — importable collection
  test_integration.js       — real-MySQL integration suite (run on a DEDICATED empty DB,
                              never the seeded dev DB — see README)
```

### MySQL schema (all migrated)

`users` (customers; also holds profile photo, `veg_only`, notification
prefs), `addresses`, `restaurants`, `categories` (prep-time + optional
min-order override), `restaurant_categories`, `items` (`is_veg`),
`restaurant_items`, `riders`, `orders` (status machine, GST split
`cgst_amount`/`sgst_amount`, rider + restaurant rating columns),
`order_items`, `wallet_ledger`, `favorites`, `device_tokens`,
`commission_config_history`, `otp_verifications`, `admins`.

Read the migration files before adding new tables — most of what you need
has a home in this schema already.

## Phase 1 scope boundary (target: Oct 2, 2026, Newtown, Android only)

**In scope**: Customer App (Android), Restaurant Panel, Rider Panel, Admin
Panel, backend order/routing/clubbing engine, Razorpay integration
(UPI/card/COD), basic wallet, GST invoicing, status-based delivery updates.

**Explicitly OUT of Phase 1** — do not build these now even if they seem
easy: iOS app, live GPS map tracking, live chat/ticketing, AI intro-video
clip, rider bonus engine, 2FA, advanced analytics dashboards, full
marketing website.

(Stale note removed 2026-09-27: this used to say restaurant item-creation
was Admin-only for Phase 1. It isn't — restaurants have always been able to
create AND edit items, per the "Item creation" and "Categories are
kitchen-creatable" bullets above; that line contradicted the actual
confirmed rule and the shipped code.)

If asked to build something on this excluded list, flag it rather than
just building it — scope creep here directly threatens the Oct 2 date.

## Design reference

Three Claude Design flatboards exist (Customer App, Restaurant Portal,
Rider Portal) — screens include the "lock kitchen" and "club kitchens"
bottom sheets that implement the category-lock UX, the status-based order
tracking screen, and the full-screen "new order"/"new delivery" takeover
alerts. Match these screens' layout, copy tone, and component patterns
when building the real UI — don't redesign from scratch.

## Working conventions

- API routes live under `/api/v1/...` (see `src/routes/index.js`)
- Auth: Bearer JWT, `requireAuth([...types])` middleware restricts by user
  type (`customer` | `restaurant` | `rider` | `admin`)
- Money fields are `decimal(10,2)` / `decimal(12,2)` — never use floats for
  currency anywhere in the stack
- Restaurants CANNOT self-create via the OTP endpoint — `auth.controller.js`
  already enforces this; keep that behavior if touching auth code
