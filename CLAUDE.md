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
  **Prices are admin-only** (client decision 2026-10-28): a restaurant can
  never set or change a price (`price_admin_only` 403). A kitchen proposes a
  dish with no price; it stays hidden (`awaiting_price`) until an admin sets
  one. Admins can also put a per-dish offer (`offer_price` + optional
  `offer_ends_at`) on a dish — customers are charged `effective_price` (see
  `src/utils/pricing.js`), so item total, GST and commission follow what they
  actually pay.
- **Restaurant onboarding is manual, via Admin Panel only.** There is no
  restaurant self-registration flow anywhere in the product. (Riders ARE
  self-serve — this asymmetry is intentional, don't "fix" it.)
- **Rider can see restaurant name/location. Customer never can.** This
  permission reversal is intentional.
- **Calling works both ways once a rider is assigned** (customer→rider
  shipped earlier; rider→customer added 2026-09-30): `GET /orders/:id` and
  `GET /orders` expose `customer_phone` to `rider`/`admin` only, mirroring
  `restaurantContactFields()`'s pattern (`customerContactFields()` in
  `order.controller.js`). **Restaurants still get neither** — they only ever
  see `delivery_address` text, never customer name/phone; that gap is
  deliberate and unrelated to this change, don't "fix" it into symmetry.
  Real phone number, no masking/telephony-proxy vendor on either side — a
  known gap noted in `docs/API.md`, not something either calling direction
  changes.
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
  Issuer GSTIN/name/address in `invoice.service.js` are env-configurable
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
- **Notification centre is super_admin only** (2026-10-29): campaigns to
  customers, sent now or scheduled (`services/campaign.service.js`, a
  once-a-minute in-process timer started from `server.js` — single PM2
  instance). `promotion` respects the "Offers & news" opt-out, `service` goes to
  everyone targeted; blocked customers never get either. The campaign row is
  the audit trail (who, what, targeted/sent/failed counts).
- **Kitchens are paid by VENDOR COST, not commission** (client decision
  2026-10-29, replaces the commission model): every dish has a customer price
  (`items.price`, plus any offer) and an internal `items.vendor_cost` — what
  Fengle pays the kitchen per unit, one cost per dish for every kitchen (the
  seam for a per-kitchen override is `services/restaurantPayable.service.js`).
  It is **admin-only** (`price_admin_only` 403 for a kitchen) and **never in any
  customer, kitchen or rider response** — order rows/lines go through
  `utils/orderPrivacy.js`; `support` admins don't see it either. The cost is
  snapshotted on `order_items.vendor_cost` at placement and
  `orders.restaurant_payable` = Σ vendor_cost × quantity over the confirmed
  lines (recomputed when lines are dropped at accept and on a reject-cascade).
  A line with no vendor cost falls back to the OLD formula (subtotal minus the
  kitchen's commission %) and marks the order `payable_estimated`.
  **Fengle bears ALL discounts** — coupons and dish offers never reduce a
  kitchen's payable. `commission_amount` is still computed but drives nothing.
  Kitchens are paid **whenever an admin pays**: no cycle; an admin (`ops`/
  `super_admin`) records payments (`reference` unique per kitchen, no more than
  outstanding without `allow_advance`) and signed adjustments; outstanding =
  Σ payables + adjustments − payments (`settled`/`due`/`advance`). Settlement
  reads are super_admin + ops only. Profit per dish is super_admin only
  (`/admin/finance/products`). Any new code that edits an order's confirmed
  lines or kitchen must call `restaurantPayable.recomputeForOrder`.
- **Profit & loss is super_admin only** (2026-10-29): `GET /admin/finance/pnl`
  and the expenses CRUD. Every order figure is keyed to the order's **placement
  date in IST** so the P&L and `orders.csv` tie out. Fengle revenue is
  `item_total − restaurant payable + delivery fees` (GST is a pass-through,
  never revenue); net profit is revenue − rider payouts − coupon discounts −
  gateway fees (`RAZORPAY_FEE_PERCENT`, default 2%) − expenses.
  Every formula is written out in `docs/API.md` — keep them in sync with
  `services/finance.service.js`.
- **COD cash handovers** (2026-10-28): outstanding COD is the rider's negative
  wallet balance. An admin (`ops`/`super_admin`) records cash a rider hands
  over via `POST /admin/riders/:id/cash-handovers`, which writes a
  `cash_handover` ledger credit (can't exceed what the rider owes; `reference`
  is unique per rider). `GET /admin/cod/reconciliation` compares expected vs
  collected vs handed over per rider and per order (cancelled/refunded COD
  orders included) and flags mismatches. Report dates are IST days.
- **Shipping charges are admin-managed rules** (2026-10-29, client decision;
  supersedes the single rider-pay config and the hard-coded delivery fee): zones
  (circles; no pincode exists yet) + rules (`base` bands / `add` / `min` / `max` /
  `free`) with conditions (distance, order value, IST time window, zone), for two
  kinds — `customer_fee` (what the customer pays) and `rider_pay` (what a rider
  earns). `services/shippingRules.service.js` is the single source of truth:
  the cart quote, order placement and the reject-cascade all call it, so a quote
  and an order can't disagree. Order of evaluation: base → adds → min/max → free
  (free is customer-fee only). The customer fee uses the order's **placement
  time**; rider pay uses **delivery time**, is **frozen on the order at delivery**
  (`orders.rider_payout` + breakdown) so a later rule edit never rewrites
  earnings, and `estimated_rider_payout` shows riders the live-rules estimate for
  active orders. Per kind there must always be an active, undated, unconditional
  everywhere base rule (409 `last_everywhere_base`); with no rule at all the old
  behaviour answers. Reads: any admin; writes: super_admin; every change is in
  `shipping_history`. `PUT /admin/settings/rider-pay` is retired (410). Customers,
  kitchens and riders never see `delivery_fee_breakdown`. Any new place that
  prices a delivery must call the engine, not recompute.
- **Rider payout accounts are secrets** (2026-10-29): a rider saves bank
  account + IFSC (+ optional UPI) via `PUT /riders/me/bank-account`; the number is
  AES-256-GCM encrypted at rest (`BANK_DATA_KEY`, no plaintext fallback — 503
  without it) and the rider's own responses only ever carry the **last 4 digits**.
  super_admin and ops see the full number on `GET /admin/riders/:id`, support only
  the masked form; every change lands in `rider_bank_account_history` (last-4s,
  never the full number) and pushes the rider. Never log or return the full number
  elsewhere (`services/riderBank.service.js` is the only place that decrypts).
  Kitchens have the same thing (2026-10-30): `PUT /restaurants/me/bank-account`,
  `restaurant_bank_accounts` + history, `GET /admin/restaurants/:id` — all via
  `services/restaurantBank.service.js`, which reuses the rider module's crypto.
- **Rider online state is the server's** (2026-10-30): `riders.status` is what
  auto-assignment uses, so it must match what the rider sees. A new rider starts
  `inactive` (offline); `POST /auth/logout` sets an `active` rider `inactive`;
  the only other thing that changes it is the in-app toggle
  (`PATCH /riders/me/availability`) and admin suspension. There is deliberately
  no location-staleness filter in auto-assignment (pings are foreground-only, so
  a rider with a locked phone would silently stop getting orders).
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
  reviewed by eye by an admin via
  `GET /admin/{restaurants,riders}/:id/agreement-selfie`, stored at an
  internal path that's never a public URL like catalog photos.
  **Admin approval gate (added 2026-10-05):** a submitted selfie is `pending`
  until an admin approves it (`POST /admin/{restaurants,riders}/:id/verification`,
  deny needs a reason and sends the partner back to retake it). Until
  `verification_status = 'approved'`, `requireAuth` 403s (`code:
  verification_required`) every restaurant/rider route except the onboarding
  ones that opt out with `{ allowUnverified: true }`, and routing/catalog/rider
  auto-assignment skip non-approved partners. **Rows that existed before the
  migration are `approved`** (column default); only admin-onboarded kitchens and
  self-signed-up riders start `pending`. Any NEW restaurant/rider route is gated
  automatically — don't add an `allowUnverified` opt-out without a reason.
- **Admin roles are enforced server-side** (added 2026-10-05): `super_admin`
  (everything), `ops` (orders/restaurants/riders/catalog/customer-block writes;
  NOT settlement, wallet credit, coupons, customer CSV export or admin
  management) and `support` (read everything, plus cancel orders). A route
  guards itself with `requireRole(...)` after `requireAuth`; the role and
  `is_active` are re-read from the DB on every admin request, so disabling an
  admin or changing their role is instant despite the 30-day JWT. Any NEW admin
  write route needs an explicit `requireRole` — without one every role,
  `support` included, can call it. Full table in `docs/API.md`.
- **Partner documents** (added 2026-10-28, client request): restaurants upload
  the owner's **masked** Aadhaar, FSSAI licence and trade licence; riders upload
  masked Aadhaar and, optionally, a driving licence — through the partner web
  portal (partner.fengle.in, OTP login with `existing_only: true`, so the portal
  never creates a rider account). An admin (`ops`/`super_admin`) approves or
  rejects each upload. Files are identity documents: they live in
  `AWS_S3_PRIVATE_BUCKET` or the private `partner-documents/` directory, **never**
  the public `AWS_S3_BUCKET`, and no response ever carries their storage path.
  Blocking (client's choice) is a **routing/assignment gate**, not an API gate:
  with `PARTNER_DOCUMENTS_ENFORCED=true`, routing, the catalog, rider
  auto-assignment and admin reassignment skip partners whose
  `documents_valid_until` is NULL or past (recomputed on every upload/review;
  expiry blocks on its own). A partner's latest *approved* upload is what counts,
  so a renewal awaiting review never interrupts them. `services/partnerDocuments.service.js`
  is the single place these rules live — any new place that picks a kitchen or a
  rider must apply `applyDocumentsGate`.
- **Customer app T&C popup** (added 2026-09-30, unrelated to the bullet
  above): a lightweight, one-time terms-acceptance checkbox for customers
  only — no selfie, no admin review. `agreementRequired` on `GET /profile/me`,
  accepted via `POST /profile/accept-agreement` (body `{ agreement_version }`,
  409 on a stale version). Backfilled the same way (pre-existing customers
  exempt). Uses its **own** version lever, `CUSTOMER_TERMS_VERSION` —
  deliberately separate from `CURRENT_AGREEMENT_VERSION` above, since customer
  terms and the restaurant/rider partner agreement are different documents
  that shouldn't re-gate each other's audience when one is bumped.
- **Targeted coupon system** (added 2026-09-30, client request): coupons are
  never "for everyone" by default — an admin picks a `target_type` (`all`,
  `new_users` — zero orders ever, `inactive_users` — no order in
  `target_meta.days` days, or `selected_users` — an explicit phone list in
  `target_meta.phones`) when creating one (`POST /admin/coupons`), and
  creation fans a push out to every eligible, opted-in
  (`notification_prefs.promotions`) customer. Applied at `POST /cart/quote`
  and `POST /orders` via `coupon_code`; `src/services/coupon.service.js` is
  the single place eligibility/limits/discount math lives, shared by both so
  a quote preview and the real order can never disagree. Some documented,
  not-client-confirmed design defaults: percent discounts apply to
  `item_total` (capped by `max_discount_amount`, never exceeding
  `item_total` either way); GST is computed on the full **pre-discount**
  `item_total` (the discount is a platform-funded promo, not a menu-price
  cut, so it also never reduces a restaurant's commission); an invalid/
  expired/limit-exceeded code never blocks the order, it just doesn't
  discount it (`couponError` surfaced on the response); a coupon is
  deliberately **not** applied to a clubbed cart that falls back to two
  separate orders (see `attemptClubbedFallbackSplit` in
  `order.controller.js`) — no single obvious order to attach one discount
  to, and that path is already a rare edge case. Cancelling a redeemed
  order (customer, admin, or the reject-cascade "nobody else can take it"
  path) voids its `coupon_redemptions` row so the coupon is freed up again —
  **any future code path that force-cancels an order must do the same**,
  or it silently burns a customer's use for nothing. Similarly, both
  `grand_total` recompute paths that already existed before this feature
  (`acceptOrder`'s dropped-unavailable-item recompute, `rejectOrder`'s
  cascade-reassignment recompute) now subtract `coupon_discount_amount` —
  don't let a future edit to either recompute drop that term again.

## Tech stack (do not deviate without updating this file)

- **Backend**: Node.js + Express + MySQL (via Knex query builder, not an ORM)
- **Customer App**: React Native (Expo), Android first, iOS in Phase 1.5
  (same codebase — iOS is a build/QA/App-Store-review task, not a rewrite)
- **Restaurant + Rider Panels**: React Native (Expo + react-native-web) —
  shared web app, wrapped in a light native shell per platform ONLY for
  Firebase Cloud Messaging push notifications. Not full native builds.
- **Admin Panel**: React JS (SPA)
- **Business Website**: React JS (standalone, separate from the above)
- **Auth**: OTP + JWT. Demo logins (added 2026-10-01): phones in
  `DEMO_LOGIN_PHONES` get the fixed `DEMO_LOGIN_OTP` with no SMS — for Play
  Store review and demos only (`demoOtpFor` in `utils/otp.js`); list only
  numbers created for that purpose, never a real person's
- **Payments**: Razorpay. **Test-mode keys live on production since 2026-10-01**
  (`RAZORPAY_KEY_ID`/`RAZORPAY_KEY_SECRET` set, real Orders API + signature
  verification confirmed working — see `docs/API.md`'s Payments section).
  A webhook (`POST /payments/razorpay/webhook`, added 2026-10-01, needs
  `RAZORPAY_WEBHOOK_SECRET`) records `payment.captured` when the app's own
  confirm-payment never arrives; a capture for an already-cancelled order is
  refunded to the customer's wallet.
  Still pending: live (non-test) keys, and Route for split settlement
  (subject to RBI eligibility — a separate, still-pending external
  dependency from the base payment integration above).
- **Maps**: Google Maps API for geocoding/distance calc only (NOT live
  tracking — see above)
- **Push**: Firebase Cloud Messaging
- **SMS/OTP**: Fast2SMS, DLT route (chosen 2026-10-01; `utils/sms.js`). With no
  `FAST2SMS_*` keys set it logs the OTP instead of sending
- **Email**: AWS SES
- **Storage**: AWS S3
- **Hosting**: AWS EC2 + MySQL (self-hosted on same instance, or RDS
  db.t3.micro if managed backups are wanted)

## Repo structure

```
fengle-backend/
  src/
    config/db.js
    migrations/     — 32 Knex migrations (run `npx knex migrate:latest`)
    controllers/    — auth, profile, catalog, cart, address, payment, order,
                      wallet, favorite, notification, coupon (customer-facing);
                      restaurant, rider, admin + adminOrders/adminCustomers/
                      adminCategories/adminCoupons (portal-facing)
    routes/         — one router per controller, mounted in routes/index.js
    services/       — routing (nearest-match/cascade/clubbing), commission,
                      tax (GST), payment (Razorpay + dev stub), wallet
                      (ledger), settlement (rider), invoice (data + PDF),
                      storage (uploads + agreement selfies, disk/S3),
                      coupon (eligibility/limits/discount math, shared by
                      cart quote + order placement + the admin push fan-out)
    middleware/     — auth, selfieUpload (multer for accept-agreement)
    utils/          — jwt, otp, sms, geo, agreement (CURRENT_AGREEMENT_VERSION,
                      restaurant/rider), customerTerms (CUSTOMER_TERMS_VERSION,
                      customer T&C — a separate lever, see business rules)
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
`commission_config_history`, `otp_verifications`, `admins`, `coupons`,
`coupon_redemptions`, `partner_documents`.

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
