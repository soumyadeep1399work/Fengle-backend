# Fengle Backend — API Reference

All endpoints are mounted under `/api/v1` (base: `http://localhost:4000/api/v1` in dev), except `/health` at the server root. Auth is Bearer JWT (`Authorization: Bearer <token>`) obtained via OTP (customer/rider/restaurant) or email+password (admin). `requireAuth([...types])` attaches `req.auth = { id, type }`; `type` ∈ `customer` | `restaurant` | `rider` | `admin`.

Companion Postman collection: `postman/Fengle-Backend.postman_collection.json` (test scripts auto-capture tokens/IDs into collection variables).

**Response naming:** bodies are snake_case (matching DB columns) **except** where the Customer App contract specified camelCase — those fields are camelCase and called out below (`riderRating`, `restaurantRating…`, category `prepTime…`/`minOrder`/`clubPartnerIds`, item `avgRating`/`ratingCount`).

> **Admin accounts are bootstrapped via CLI, not an API endpoint** (same manual-only posture as restaurant onboarding):
> `node scripts/create-admin.js "Name" "email@example.com" "password" super_admin`

---

## Auth (`/auth`)

| Method | Path | Auth | Body | Notes |
|---|---|---|---|---|
| POST | `/auth/otp/request` | — | `{ phone, purpose, existing_only? }` | `purpose`: `login`\|`signup`\|`restaurant_login`\|`rider_login`. 10-digit phone. Response `{ message, expires_in_minutes }`. **A number that can't log in gets no SMS and no OTP row** (saves the cost and a wait for a code that never works), with the same wording `verify` uses: `restaurant_login` for a phone with no kitchen → **404** "This number is not registered as a partner restaurant. Please contact admin for onboarding."; `rider_login` with `existing_only: true` (boolean) for an unknown phone → **404** "No partner account uses this number. Sign up in the Fengle Rider app first, or contact Fengle." (without the flag an unknown rider number still gets a code, because the first OTP creates the account); a **suspended** kitchen or rider → **403** "Your account has been suspended. Contact support." (a paused/inactive kitchen can still log in). Customer `login`/`signup` is unchanged. Trade-off the user accepted: this reveals whether a number is a registered kitchen. Demo numbers (`DEMO_LOGIN_PHONES`) follow the same rules, so a demo number must also exist as a kitchen/rider to request that purpose. Sent by SMS through Fast2SMS when the `FAST2SMS_*` keys are set; a provider failure returns 502 `{ error }` (the app should offer a retry). With no keys set the OTP is only logged on the server as `[otp] no SMS provider configured — OTP for <phone>: <code>`. **Demo logins**: a phone listed in `DEMO_LOGIN_PHONES` always gets the fixed `DEMO_LOGIN_OTP` and no SMS is sent (for Play Store review and demos; off unless both env vars are set). |
| POST | `/auth/otp/verify` | — | `{ phone, otp, purpose, name? }` | → `{ token, user: { id, phone, name, type } }`. First verify auto-creates customer/rider accounts. `restaurant_login` for an un-onboarded phone → **404** (restaurants are admin-onboarded only). 5 attempts max (429), 5-min expiry. |
| POST | `/auth/admin/login` | — | `{ email, password }` | → `{ token, user: { id, name, email, role, type } }`. 401 on bad credentials. |
| GET | `/auth/session` | any | — | Validates a persisted token on app boot → `{ user }`. 401 if the token is missing/expired or the account no longer exists. |
| POST | `/auth/logout` | any | `{ device_token? }` | JWTs are stateless — logout is the client discarding its token. It deregisters the push `device_token` if one is sent, and **a rider who logs out is set `inactive` (offline) on the server** (only an `active` rider is touched; a suspended one stays suspended, and orders already assigned to them are unaffected). A **new rider** (self-signup) is created `inactive` — riders go online themselves via `PATCH /riders/me/availability`. |

### Dev-only: read the last OTP

`GET /dev/last-otp?phone=<10-digit>` → `{ phone, otp, requestedAt }` (404 if no OTP was requested for that phone since the server started, or if an SMS provider is configured — then the code only goes out by SMS). In-memory only, and the router is **not mounted at all** when `NODE_ENV=production` (it was briefly open on production on 2026-10-01 to 2026-10-05 for pre-launch testing and is closed again).

### Dev tools: advance an order / add wallet credit

No Restaurant/Rider panel exists yet, so a placed order stays `placed` forever. These dev-only helpers drive the **real** order handlers (acting as the order's restaurant and assigned rider — ETA, COD collection and state checks all behave as in production). None of them exist in production: the scripts refuse to run and the `/dev` router is not mounted.

```bash
node scripts/advance-order.js <orderId>                 # ONE step (placed→accepted→picked_up→on_the_way→delivered)
node scripts/advance-order.js <orderId> --to=delivered  # up to a step (or --all)
node scripts/add-credit.js <10-digit phone> <amount>    # e.g. 6558899886 500 — the customer must have logged in once
```

Same thing over HTTP (no auth): `POST /dev/orders/:id/advance` with optional `{ to }` → `{ orderId, status, steps, notes, eta_minutes, rider_id, payment_status }`; `POST /dev/wallet/credit` with `{ phone, amount }` → `{ phone, added, balance }`. Errors: 409 for advance (unknown/cancelled order), 400 for credit. If no rider is free the dev rider (9000000201) is assigned directly. A **delivered order still needs its kitchen rated or skipped** before the customer can place another order (the rating gate applies to dev orders too).

### Dev seed data

`npm run seed` (idempotent; never resets an existing stock toggle) loads the 11 Customer App categories with their 49 items, **7 active dev restaurants** around Newtown, Kolkata (centre 22.58, 88.47 — override with `SEED_CENTER_LAT`/`SEED_CENTER_LNG`), and one active dev rider. Restaurants are deliberately split into pairs so club/lock can be exercised: Bengali↔Chinese, Bengali↔Sweets, North Indian↔Mughlai, Mughlai↔Biryani, South Indian↔Chaat, South Indian↔Tiffin, Thali↔Continental. Any other combination (e.g. Bengali + North Indian) has no shared kitchen and quotes `clubbable:false` (Lock). Dev restaurant login phones are 9000000101–9000000107; dev rider 9000000201.

## Profile (`/profile`) — customer

| Method | Path | Body | Notes |
|---|---|---|---|
| GET | `/profile/me` | — | → `{ profile: { id, name, phone, email, photo_url, veg_only, wallet_balance, notification_prefs, agreementRequired } }`. |
| PATCH | `/profile/me` | any of `{ name, email, photo_url }` | Phone isn't editable (it's the login identity). |
| PATCH | `/profile/preferences` | `{ veg_only }` | Cross-device veg-only sync. |
| PATCH | `/profile/default-address` | `{ address_id }` | Sets the default; returns the full address list. Equivalent to `PATCH /addresses/:id {is_default:true}`. |
| POST | `/profile/accept-agreement` | `{ agreement_version }` | The Customer app's one-time T&C popup — see "Customer app T&C popup" below. **Not** the restaurant/rider agreement feature; no file upload here. |

## Addresses (`/addresses`) — customer

| Method | Path | Body | Notes |
|---|---|---|---|
| GET | `/addresses` | — | Default first. |
| POST | `/addresses` | `{ label, address_line, lat, lng, is_default? }` | The first address saved is always the default. 201 with the full list. |
| PATCH | `/addresses/:id` | any of `{ label, address_line, lat, lng, is_default }` | `is_default:true` un-defaults the others. |
| DELETE | `/addresses/:id` | — | Deleting the default promotes the most-recently-added remaining one. |

Orders never FK to this table — `POST /orders` snapshots `delivery_lat/lng/address` onto the order, so deleting an address never touches order history.

## Catalog

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/categories` | public | Optional `?lat=&lng=`. → `{ categories: [{ id, name, blurb, image_url, prepTimeMinMinutes, prepTimeMaxMinutes, minOrder, clubPartnerIds }] }`. **Always returns usable values** (kitchen-created categories start with none): `prepTime…` falls back to **30–40** when the category has none, `minOrder` to the global ₹50, and `image_url` to the first dish photo in the category (else `null` — show a placeholder). `blurb` is `null` when there is none. **Without `lat`/`lng`** every active category is returned (unchanged). **With both**, only categories that have at least one available item at an in-range active kitchen are returned (same rule as `GET /categories/:id`), so a brand-new category with nothing in stock never shows as an empty tile; `clubPartnerIds` is then filtered to the categories returned. Passing only one, or a non-number, is a 400. `clubPartnerIds` = other categories sharing ≥1 active restaurant platform-wide — a discovery **hint**; the real location-aware club decision is `POST /cart/quote`. |
| POST | `/categories` | admin | `{ name, description?, image_url?, prep_time_min_minutes?, prep_time_max_minutes?, min_order_override? }` → 201 `{ category }`. Held to the same duplicate rule as kitchens: an exact duplicate of an existing category (normalized — "Momos" when "Momo" exists, "Chowmein" when "Chow Mein" exists) → **409** `{ code: "category_exists", error, category }`. Admins don't get the fuzzy "similar" warning or the kitchens' strict character rule (seeded names like `Thali / Combos` need `/`). |
| GET | `/categories/:id?lat=&lng=` | public | Category header + `sections: [{ title: "Popular", items }, { title: "More", items }]`. Popular = top 3 by rating count then average. lat/lng required (location-filtered, 7 km). |
| GET | `/categories/:categoryId/items?lat=&lng=` | public | Older flat-list shape of the same items. |
| GET | `/items/popular?lat=&lng=&limit=6` | public | Cross-category "Popular picks" for Home (limit 1–50, default 6). Same location filter and item shape as the other catalog reads, ranked by rating count then average; unrated items are tie-broken by position within their category, so a fresh catalog shows a spread of categories. |
| GET | `/items/search?q=&veg=&lat=&lng=` | public | Name/description match across all categories, same location filter. `veg=true` → veg items only. |
| POST | `/items` | admin/restaurant | `{ category_id, name, description?, price, image_url?, is_veg? }`. Restaurants only for categories they're approved for (403 otherwise); a restaurant-created item is automatically in stock at that restaurant. **Validation (400 unless noted):** `name` non-empty string ≤150 chars (trimmed); `price` a positive number up to 100000 (a numeric string like `"120.50"` is accepted; `0`, negatives, `""`, `"abc"`, booleans are not); `is_veg` must be a real boolean when sent (default false — the string `"false"` is rejected, not coerced); `description` ≤255 chars; `image_url` an `http(s)://` URL ≤500 chars (use the URL returned by `POST /uploads/image`); unknown/inactive `category_id` → **404**. |
| PATCH | `/items/:id` | admin/restaurant | Edit any of `{ name, price, is_veg, image_url, description }` → **200** `{ item: <updated row> }` (row shape as `POST /items`; `price` a decimal string). **Same validation as `POST /items`** (shared code): `price` positive ≤100000, `is_veg` strict boolean, `name` 1–150 chars, `image_url` http(s) ≤500 or **`null`/`""` to remove the photo**, `description` ≤255 or `null`; `null` is not allowed for name/price/is_veg. **400** for an empty body / only unknown fields (`is_active`, `id`… are ignored as non-editable). **`category_id` cannot change** — sending a different one is a 400 (sending the item's current one is harmless). **Who:** a restaurant may edit **any** item whose category is in its `restaurant_categories` (same rule as `GET /restaurants/me/menu`), **including admin-seeded items** — otherwise **403**; admin may edit any item. Unknown or inactive item → **404** (checked before the 403). **The item is shared:** the edit shows for every kitchen and every customer. **Existing orders keep their money** — `order_items.unit_price`/`subtotal` and the order's `item_total`/GST/`grand_total` are snapshots taken at placement, and invoices are built from them — and the item's `name` is **snapshotted** onto `order_items.item_name` at placement, so past orders keep the name they were ordered under and a rename never rewrites history (the photo is not snapshotted). New quotes/orders use the new price. Replacing a photo leaves the old uploaded file on disk. |
| PATCH | `/restaurants/:restaurantId/items/:itemId/availability` | restaurant (self) | `{ is_available }` — the stock toggle. |

Every item payload includes `avgRating` (1 decimal, or `null` if unrated) and `ratingCount`. There's no per-item rating submission — an item's rating is the average `restaurant_rating` over delivered orders containing it (how customers rated the kitchen that cooked it).

## Cart (`/cart`) — customer

| Method | Path | Body | Notes |
|---|---|---|---|
| POST | `/cart/quote` | `{ items: [{item_id, quantity}], delivery_lat, delivery_lng, coupon_code? }` | Server-computed pricing **and the club/lock check** for the Lock/Club kitchen sheets — call it with the *proposed* cart (including "what if I add this item from another category"). Never persists, never reveals restaurant identity. Response: `{ valid, minOrderOk, categoryIds, clubbable, isClubbed, itemTotal, deliveryFee, cgstAmount, sgstAmount, couponDiscount, couponError, grandTotal, reason }`. `clubbable:false` (no single kitchen nearby can serve the whole cart) → show the Lock sheet; that response has no price/coupon fields. `couponDiscount` is 0 and `couponError` a reason string whenever `coupon_code` doesn't apply (invalid/expired/ineligible/below its own min order/limit already used) — `grandTotal` already nets a valid discount, the app doesn't recompute. See "Coupons" below. 400 only for malformed input / >2 categories. |

## Payments (`/payments`) — customer

| Method | Path | Body | Notes |
|---|---|---|---|
| GET | `/payments/methods` | — | `{ methods: [{ id, label, enabled, balance? }], razorpay_key_id }` — `wallet` includes the Fengle-credits balance. `razorpay_key_id` is the **public** key_id (safe to ship to the client — never the secret), `null` until `RAZORPAY_KEY_ID`/`RAZORPAY_KEY_SECRET` are both set in `.env`. No saved cards/UPI handles yet (gap). |
| POST | `/payments/upi/initiate` | `{ order_id }` | Idempotent — returns the order's existing `razorpay_order_id` payment object if `POST /orders` already created one, now including `dev_stub`. |
| POST | `/payments/card/charge` | `{ order_id }` | Dev-stub mode (no Razorpay keys): auto-succeeds and marks the order paid. With real keys: **501** — use Razorpay Checkout + `POST /orders/:id/confirm-payment` instead (direct server-side card charging isn't built). |

**Real Razorpay flow — live in test mode on production since 2026-10-01.** `RAZORPAY_KEY_ID`/`RAZORPAY_KEY_SECRET` are set in prod `.env` (test-mode keys, from the client's new Razorpay account). Verified directly against the live server: `POST /orders` with `payment_method: upi` returned a genuine Razorpay order (`order_...`, real `entity`/`amount_due`/`amount_paid` fields, `dev_stub: false`); `POST /orders/:id/confirm-payment` rejected a wrong signature (400) and accepted a correctly-computed one, marking the order paid. **Not yet verified: an actual payment captured through Razorpay's hosted Checkout UI** (the app session's WebView integration) — only the server-side order-creation and signature-verification logic has been confirmed directly; end-to-end with a real Checkout session is still pending that session's own test.

`POST /orders` (for `upi`/`card`/`netbanking`) creates a **real** Razorpay Order via the Orders API and returns `payment: { id, amount, currency, status, dev_stub: false, ... }` — `id` is the real `razorpay_order_id` to open Checkout with. `POST /orders/:id/confirm-payment` then verifies the signature server-side: `HMAC_SHA256(order.razorpay_order_id + "|" + razorpay_payment_id, RAZORPAY_KEY_SECRET)` must equal `razorpay_signature`, else 400. **`razorpay_order_id` always comes from the order row the server itself created and stored at placement — never trusted from the request body** — even if the client sends one (harmless either way), only the server's own stored value is used, so a client can't point verification at a different order's payment. Toggling `RAZORPAY_KEY_ID`/`RAZORPAY_KEY_SECRET` unset↔set is the only thing that switches dev-stub↔real mode anywhere in the payment flow — no code changes.

**Razorpay webhook** (added 2026-10-01): `POST /payments/razorpay/webhook` — called by Razorpay's servers, no JWT. Trusted only if `X-Razorpay-Signature` equals `HMAC_SHA256(raw request body, RAZORPAY_WEBHOOK_SECRET)` (the secret chosen when the webhook is created in the Razorpay dashboard, not the API key secret); 400 otherwise, 503 while the secret is unset. It is the safety net for a payment that succeeds when `confirm-payment` never arrives. Only `payment.captured` is acted on, matched to the order by `razorpay_order_id`:
- order still unpaid → marked `paid` (and announced to the kitchen if `placed`), exactly like `confirm-payment`;
- order already `cancelled` while unpaid → the full `grand_total` is credited to the customer's wallet and `payment_status` becomes `refunded`;
- order already paid/refunded, or no such order → nothing changes.

Every correctly-signed event gets 200 (`{ received, handled, result? }`) so Razorpay stops retrying; duplicates and concurrent deliveries are safe (each write is conditional on the order still being unpaid). `payment.failed` is ignored — the customer can retry on the same Razorpay order.

## Orders (`/orders`)

| Method | Path | Auth | Body | Notes |
|---|---|---|---|---|
| POST | `/orders` | customer | `{ items: [{item_id, quantity}], delivery_lat, delivery_lng, delivery_address, payment_method, coupon_code? }` | `payment_method` ∈ `upi`\|`card`\|`netbanking`\|`cod`\|`wallet`. Max 2 categories, min ₹50. **403 `{ error, blocking_order_id }` if the customer has an unresolved kitchen-rating gate** (see below). Routes to nearest capable restaurant; if no single restaurant serves a 2-category cart it splits into two orders (`{ message, orders: [...] }`) — **a coupon is never applied to a split order** (message says so); 409 if nothing can fulfil it. GST is `cgst_amount`+`sgst_amount` (2.5%+2.5% of `item_total`), included in `grand_total`. An invalid/expired/ineligible/limit-exceeded `coupon_code` never blocks placement — the order object gains `couponError` (a reason string) and simply isn't discounted; a valid one sets `coupon_id`/`coupon_code`/`coupon_discount_amount` and nets the discount into `grand_total`. See "Coupons" below. `wallet` debits the full amount immediately and marks it paid (402 + auto-cancel if balance is short); `cod` skips payment; others return a `payment` object. |
| POST | `/orders/:id/confirm-payment` | customer | `{ razorpay_payment_id, razorpay_signature }` | Signature verification auto-succeeds in dev stub. |
| POST | `/orders/:id/cancel` | customer | — | **Buffer-window rule (policy 2026-09-18):** only while status is `placed` (restaurant hasn't accepted) **and** within `ORDER_CANCEL_BUFFER_SECONDS` (default **60**, confirmed) of placing; else 409. Drive the countdown from `cancellable_until` (see below), not a client clock. Refunds to wallet if already paid. |
| POST | `/orders/:id/rate-rider` | customer | `{ rating: 1–5, comment? }` | Only after delivery. A comment is never required server-side (the "prompt when ≤2" is UX only). |
| POST | `/orders/:id/rate-restaurant` | customer | `{ rating: 1–5, comment? }` | Only after delivery. Clears the rating gate. |
| POST | `/orders/:id/skip-restaurant-rating` | customer | — | Clears the gate without a rating (still rateable later). |
| GET | `/orders/:id/rider` | customer | — | → `{ rider: { name, phone } }` once assigned (404 before). **Real phone number for now** — no telephony-masking vendor integrated (gap). |
| GET | `/orders/:id/invoice` | customer | — | Structured GST invoice: `invoiceNumber` (`INV/<FY>/<order id>`), issuer, `billedTo`, `lines`, `taxableValue`, `cgstAmount`, `sgstAmount`, `deliveryFee`, `invoiceTotal`. Issued by the platform, never the restaurant. |
| GET | `/orders/:id/invoice/pdf` | customer | — | Same data as a one-page PDF (`application/pdf`, inline). |
| POST | `/orders/:id/reorder` | customer | `{ delivery_lat?, delivery_lng?, delivery_address?, payment_method? }` | Re-runs the full `POST /orders` pipeline (routing, tax, min-order, rating gate) with the original's still-confirmed items at **current** prices/stock. Falls back to the default saved address and the original payment method if omitted. |
| POST | `/orders/:id/accept` | restaurant | `{ unavailable_item_ids?: [] }` | Only from `placed`. Dropped items reduce `item_total`, GST is recomputed from the new total, and the full `grand_total` delta is refunded to wallet if paid. Auto-assigns the nearest free active rider. |
| POST | `/orders/:id/reject` | restaurant | — | Cascades to the next candidate restaurant, or cancels + refunds if none remain. |
| POST | `/orders/:id/start-preparing` | restaurant | — | Only from `accepted`. |
| POST | `/orders/:id/mark-ready` | restaurant | — | "Mark ready": the food is ready for the rider to collect. Only from `accepted`, else 409 (403 if it isn't your order). Sets `ready_at` (returned as `{ message, ready_at }`) and is **idempotent** — repeat calls keep the first timestamp. A signal only: it does not change `status` and rider pickup isn't blocked on it. `ready_at` appears on the order object (restaurant/rider/customer reads). |
| POST | `/orders/:id/picked-up` | rider | — | Only from `accepted`. Sets the one-time `eta_minutes`. |
| POST | `/orders/:id/on-the-way` | rider | — | Only from `picked_up`. |
| POST | `/orders/:id/delivered` | rider | `{ delivery_otp, cod_amount_collected? }` | Only from `on_the_way`. **`delivery_otp` is required** (added 2026-09-27) — a 4-digit code shown only to the customer (see `delivery_otp` below); a mismatch is 400 "Incorrect delivery code...". Orders placed before this feature shipped have no stored code, so the check is skipped for those. `cod_amount_collected` is still **required and must exactly equal `grand_total` for COD** — creates the rider's COD wallet liability. |
| GET | `/orders` | customer/restaurant/rider | — | Own orders. Each row adds `items: [{ item_id, name, quantity, category_id, category_name }]` (confirmed items only; `name` is the snapshot taken at placement), `categories: [{ id, name }]` (two for a clubbed order) and `category_name` (categories joined with " + ", e.g. "Bengali + Chinese (Indo)"). **For a rider (and restaurant/admin) requester only**, each row also has `restaurant_name`, `restaurant_address`, `restaurant_lat`, `restaurant_lng` (the pickup kitchen — CLAUDE.md: riders can see this, customers never can; absent entirely for a customer requester, not just null). **For a rider (and admin) requester only — NOT restaurant** (added 2026-09-30), each row also has `customer_phone`, mirroring the customer's existing "call the rider" ability (`GET /orders/:id/rider`) in the other direction; a restaurant requester still gets neither customer name nor phone, only `delivery_address` (existing, unrelated, deliberate gap). Restaurants only see `paid`/`cod` orders. |
| GET | `/orders/:id` | customer/restaurant/rider/admin | — | Full detail. `items` are the order_items rows **plus** `name` (the name the item had **when ordered** — snapshotted, immune to later renames) and `category_name` (includes dropped items — filter on `status === "confirmed"`); the order also has `categories`, `category_name`, `cancelled` (bool), `riderRating`, `riderRatingComment`, `restaurantRating`, `restaurantRatingComment`, `restaurantRatingSkipped`, and `rider: { name, phone }` once assigned. **For a rider (and restaurant/admin) requester only**, also `restaurant_name`, `restaurant_address`, `restaurant_lat`, `restaurant_lng` — the pickup kitchen, for the rider's "Navigate" deep-link; a customer requester never gets these fields at all. **For a rider (and admin) requester only — NOT restaurant** (added 2026-09-30), also `customer_phone` — same asymmetric pattern as the restaurant fields above, just gated differently: `customerContactFields()` in `order.controller.js`, right next to `restaurantContactFields()`. Visible as soon as a rider is assigned (status `accepted` onward), same timing as the customer already seeing the rider's phone. |
| GET | `/orders/:id/status` | customer/restaurant/rider/admin | — | Lightweight poll target: `{ status, cancelled, eta_minutes, picked_up_at, delivered_at, cancelled_at, rider_assigned }`. |

**Rating gate.** A delivered order with no `restaurant_rating` and `restaurant_rating_skipped = false` blocks every new `POST /orders` (and reorder) with a 403 naming `blocking_order_id`, until `rate-restaurant` or `skip-restaurant-rating` is called for it. This is the real enforcement; the app's prompt is only UX.

**`cancellable_until`** (ISO timestamp) is on every order object returned by `POST /orders` (each order in a split), `POST /orders/:id/reorder`, `GET /orders`, `GET /orders/:id` and `GET /orders/:id/status`: the moment the cancel window closes (`created_at` + 60 s). It is `null` as soon as the order is no longer `placed` (restaurant accepted, cancelled, delivered…), and for a still-`placed` order a timestamp in the past means the window has lapsed. The server is the source of truth: compare it against a server-derived now (e.g. the response `Date` header) rather than trusting the device clock, and let `POST /orders/:id/cancel` be the final arbiter.

Order `status` ∈ `placed`\|`accepted`\|`picked_up`\|`on_the_way`\|`delivered`\|`cancelled`. There is no `refunded` status — the history "REFUNDED" badge maps to `payment_status === "refunded"`.

**`delivery_otp`** (added 2026-09-27): a 4-digit code generated once per order at placement (same lifetime as the order — a reorder is a new order with its own fresh code). It appears **only on a customer's own reads** of that order (`POST /orders`, `POST /orders/:id/reorder`, `GET /orders`, `GET /orders/:id` when `req.auth.type === "customer"`) — a restaurant, rider or admin reading the same order never sees this field at all, by design (a real rider gets it only by asking the customer). The customer app should show it once a rider is assigned, and the rider app collects it verbally and submits it with `POST /orders/:id/delivered`. Not exposed on `GET /orders/:id/status` (that endpoint stays intentionally minimal).

## Wallet (`/wallet`) — customer or rider

| Method | Path | Notes |
|---|---|---|
| GET | `/wallet/balance` | `{ balance }`. |
| GET | `/wallet/ledger?limit=&offset=` | `{ ledger: [...] }`, newest first. `reason` ∈ `cod_collected`\|`settlement_payout`\|`settlement_deduction`\|`order_refund`\|`order_payment`\|`manual_adjustment`. |
| GET | `/wallet/me` | Combined `{ balance, history }` (kept for the Rider Portal). |

## Coupons (`/coupons`) — customer

| Method | Path | Notes |
|---|---|---|
| GET | `/coupons/mine` | Every currently active, in-date coupon this customer is eligible for (per its `target_type` — see below), **excluding one that's globally exhausted** (`total_usage_limit` reached by anyone). → `{ coupons: [{ id, code, title, description, discount_type, discount_value, max_discount_amount, min_order_value, valid_until, already_used }] }`. `already_used` means this customer is already at their own `usage_limit_per_user` for that coupon (default 1) — the row is still returned (so the app can show it as spent), not hidden. |

See "Coupons" below (full targeting/discount/limits contract, shared by this, `POST /cart/quote`, and `POST /orders`) and the Admin Panel's own Coupons subsection for `POST`/`GET`/`PATCH /admin/coupons`.

## Favorites (`/favorites`) — customer

| Method | Path | Notes |
|---|---|---|
| GET | `/favorites` | Favorited active items. |
| POST | `/favorites/:itemId` | Idempotent (re-favoriting isn't an error). |
| DELETE | `/favorites/:itemId` | |

## Notifications (`/notifications`)

| Method | Path | Auth | Body | Notes |
|---|---|---|---|---|
| POST | `/notifications/register-device` | customer/restaurant/rider | `{ token, platform: 'android'\|'ios' }` | `token` is the device's **native FCM registration token** (what the apps send). An Expo push token (`ExponentPushToken[…]`) is also accepted and sent via Expo. Upserts for the caller's own account, and first removes the same token from any other account (a phone only gets pushes for whoever is logged in on it). `POST /auth/logout { device_token }` unregisters it. |
| PATCH | `/notifications/settings` | customer | any of `{ order_updates, promotions }` | Merges into existing prefs → `{ notification_prefs }`. `order_updates: false` stops the customer's order pushes. |

**Sending** (`src/services/push.service.js` + `src/services/orderNotifications.service.js`): pushes go **straight to Firebase Cloud Messaging** (HTTP v1 API, Firebase project `fengle-1a2b3`). The server authenticates with the service-account JSON at `FCM_SERVICE_ACCOUNT_FILE` (kept in the gitignored `secrets/` folder) by signing an OAuth JWT with Node's `crypto`, so there's no Firebase SDK and no extra dependency. If the variable is unset, FCM pushes are skipped with a warning. Any Expo-format tokens go through the Expo Push Service instead (optional `EXPO_ACCESS_TOKEN`). Every message uses Android channel `orders` and carries `data: { type, orderId }` (string values). Sending is fire-and-forget after the response (a failure is only logged), and tokens FCM reports as `UNREGISTERED`/invalid (or Expo as `DeviceNotRegistered`) are deleted.

| Event | To | `data.type` | Message |
|---|---|---|---|
| Order becomes visible to the kitchen (COD/wallet at placement, online payment confirmed, or re-routed after a reject) | restaurant | `new_order` | "New order #id": item count, total, COD flag |
| Rider auto-assigned when the kitchen accepts | rider | `new_delivery` | "New delivery #id": pickup kitchen name, cash to collect |
| Accepted | customer | `order_update` | "Order confirmed" (plus a wallet-refund line if items were dropped) |
| Picked up | customer | `order_update` | "Out for delivery" with the one-time ETA |
| On the way | customer | `order_update` | "On the way" |
| Delivered | customer | `order_update` | "Delivered" and a prompt to rate |
| Cancelled because no kitchen could take it | customer | `order_update` | "Order cancelled" (plus a refund line) |

Customer pushes never name the kitchen. A customer's own cancellation sends nothing.

## Image uploads (`/uploads`) — restaurant or admin

| Method | Path | Notes |
|---|---|---|
| POST | `/uploads/image` | `multipart/form-data` with exactly **one file field named `image`**. Accepts **JPEG, PNG or WebP**, identified by the file's actual bytes (the client's Content-Type and file name are ignored, so a renamed text file or an SVG is rejected). Max **5 MB** (413 above that). The server **re-encodes every upload as WebP** (longest side ≤1000 px, quality 78, EXIF/GPS stripped; `sharp`, one conversion at a time), so the stored file is always `.webp` whatever was sent; undecodable/corrupt bytes or >40 megapixels → 400. → **201** `{ url }` — an **absolute** URL like `http://192.168.1.16:4000/uploads/<uuid>.webp`, ready to send as `image_url` to `POST /items`. Agreement selfies are *not* converted. |

Errors: **400** — no file, wrong field name, more than one file, not multipart, empty file, or not a JPEG/PNG/WebP; **413** — larger than 2 MB; **401** — no token; **403** — customer/rider token.

- **Files** are stored on disk under `fengle-backend/uploads/` (gitignored) with a random UUID name — the client's file name is never used — and served publicly (no auth) at `GET /uploads/<name>` with long cache headers, `X-Content-Type-Options: nosniff` and `Cross-Origin-Resource-Policy: cross-origin` (helmet's default `same-origin` would stop Expo web rendering them in an `<img>`). No directory listing.
- **URL base:** `PUBLIC_BASE_URL` if set (trailing slash is fine), otherwise the request's own protocol + Host. The URL is stored verbatim in `items.image_url`, so **in dev set `PUBLIC_BASE_URL` to an address every device can reach** (e.g. `http://192.168.1.16:4000`): a URL built from an emulator-only host such as `10.0.2.2` won't load on a real phone or in the customer app. Set it in production too (behind a proxy the request host is not the public one).
- **Production:** disk storage is dev-only. The response shape (`{ url }`) is the only contract — storage moves to S3 by replacing `saveImage` in `src/services/storage.service.js`.
- Uploaded files are never deleted automatically (replacing an item's photo leaves the old file behind) — cleanup is a later concern.

## Restaurant self-service (`/restaurants/me`) — restaurant

| Method | Path | Notes |
|---|---|---|
| GET | `/restaurants/me` | The logged-in restaurant's profile → `{ restaurant: { id, name, owner_name, phone, email, address, status, categories: [{ id, name }], agreementRequired } }` (categories sorted by name). Never includes `password_hash`; commission rate and radius are admin-managed and not exposed. |
| GET | `/restaurants/me/menu` | Every **active** item in the restaurant's approved categories (`restaurant_categories`), **including items currently switched off** — the customer catalog hides those, so this is the only way to find one to switch back on. → `{ items: [{ id, name, description, price, image_url, is_veg, category_id, category_name, is_available }] }`, ordered by category name then id. Unlike other item payloads `price` is a **number** here. `is_available` is `false` when there is no `restaurant_items` row (matches routing: no row = not in stock). Toggle with the existing `PATCH /restaurants/:restaurantId/items/:itemId/availability` (it creates the row if missing). |
| GET | `/restaurants/me/category-options?q=` | The category picker. → `{ categories: [{ id, name, joined }], exact, similar }`. `categories` = **every active category** (or those whose name contains `q`, also matching the normalized name, so `q=momos` finds `Momo`), ordered by name; `joined` = this kitchen already has it. `exact` / `similar` are computed **only when `q` is non-empty** (else `null` / `[]`): `exact` = the category whose normalized name equals the normalized `q`; `similar` = up to **5** close matches, best first, never including `exact`. Independent of the customer catalog, so it still lists categories that have no stock. |
| POST | `/restaurants/me/categories` | Body **either** `{ category_id }` (join an existing category) **or** `{ name, confirm_not_duplicate? }` (create a new one and join it) — see the subsection below. Both → 201 `{ category: { id, name } }`. |
| POST | `/restaurants/me/accept-agreement` | `multipart/form-data`: file field `selfie` (jpeg/png/webp by magic bytes, 2MB cap — same rules as `POST /uploads/image`) + field `agreement_version` (the version the app is showing). See "In-app agreement + selfie verification" below. |

Both are restaurant-token only (401 without a token, 403 for other user types). `/restaurants/me` is mounted ahead of the catalog routes so "me" is never read as a `:restaurantId`. For orders the Restaurant app uses the shared `GET /orders` (restaurants see only paid/COD orders, with `created_at` = placed time, item names and category names), `GET /orders/:id`, `accept`, `reject`, `start-preparing` and `mark-ready`.

### Categories: kitchens create their own (no admin approval)

Product decision (2026-09-21): a kitchen can add a category itself; nothing is reviewed. The safeguard is **duplicate prevention, enforced on the server** (an app's own checks are only UX): the customer must never see both "Momo" and "Momos". Admin cleanup (rename / merge / deactivate) comes later in the Admin Panel.

`POST /restaurants/me/categories`

- **`{ category_id }`** — join an existing category. 201 `{ category: { id, name } }`; **409** `{ code: "already_joined", error, category }`; **404** unknown or inactive; 400 if not a positive integer.
- **`{ name }`** — create + join. In order:
  1. **Validate** → 400 `{ code: "invalid_name", error }`: trimmed and whitespace-collapsed, **2–40 characters**, only letters (any script, e.g. Bengali), digits, spaces and `& ( ) - '`; must contain a letter; must not be nothing but filler words ("Food", "Food Corner"). All-lowercase input is title-cased (`hakka noodles` → `Hakka Noodles`).
  2. **Exact duplicate** (same normalized name) → **409** `{ code: "category_exists", error, category: { id, name, joined } }`. Never created, and `confirm_not_duplicate` does **not** bypass it — join it with `{ category_id }` instead. If the match is a deactivated category → 409 `{ code: "category_unavailable" }`.
  3. **Close match** and `confirm_not_duplicate !== true` → **409** `{ code: "similar_categories", error, similar: [{ id, name, joined }] }` (≤5, best first). Resend with `confirm_not_duplicate: true` (a real boolean — the string `"true"` doesn't count) once the kitchen has seen the suggestions.
  4. **Abuse cap** → **403** `{ code: "category_limit" }` once a kitchen has created `MAX_CATEGORIES_PER_RESTAURANT` (default **10**) categories — with no approval step, a buggy client mustn't be able to flood the shared catalog.
  5. Otherwise insert and join → **201** `{ category: { id, name } }`. Defaults: no description, photo, prep time or min-order override; active; `created_by_restaurant_id` = the kitchen (for admin cleanup). Two kitchens racing to create the same name: the database's unique indexes let one win; the other gets the same `category_exists` 409.
- Joining a category does **not** stock any items: they appear in `GET /restaurants/me/menu` as `is_available: false` until switched on.

**What counts as "the same"** (`src/utils/categoryName.js` is the single definition; the API never compares raw names). The name is lowercased, accents stripped (Latin script only — Bengali/Hindi vowel signs are kept), `&` → "and"; filler words dropped (`and food foods item items special specials cuisine dish dishes style corner house`); every word singularized (`momos→momo`, `sweets→sweet`, `sandwiches→sandwich`, `candies→candy`, `biryanis→biryani`); Indian spelling variants folded (`biriyani/briyani→biryani`, `chow mein/chaumin→chowmein`, `tandoori→tandori`, `ee→i`, `oo→u`, `ph→f`, `ss→s`, initial `w→v`); punctuation and spaces removed. So `Momo`/`Momos`/`MOMOS Special`, `Paneer Tikka`/`Panir Tikka`, `Chaat & Snacks`/`Chaat Snack` are one category. **"Close"** = normalized edit distance ≤1 when the shorter name is under 8 chars (≤2 otherwise) **or** one normalized name contains the other (≥3 chars) — e.g. `Mome` vs `Momo`, `Bengali Rolls` vs `Bengali`, `Indian` vs `South Indian`. Stored as `categories.name_normalized` (unique index, backfilled for the seeded ones) as a race-safe backstop; detection recomputes from the name, so an unkeyed legacy row can't let a duplicate through.

## Restaurants (`/admin/restaurants`) — admin only

| Method | Path | Body | Notes |
|---|---|---|---|
| POST | `/admin/restaurants` | `{ name, owner_name?, phone, email?, address, lat, lng, radius_km?, commission_rate_percent?, category_ids: [] }` | The only way a restaurant enters the system. |
| GET | `/admin/restaurants` | — | |
| PATCH | `/admin/restaurants/:id` | any of `{ radius_km, commission_rate_percent, status, name, address, lat, lng }` | Commission changes are logged to `commission_config_history`. |
| POST | `/admin/restaurants/:id/categories` | `{ category_id }` | 409 if already served. |

## Riders (`/riders`) — rider

| Method | Path | Body | Notes |
|---|---|---|---|
| GET | `/riders/me` | — | → `{ rider: { id, name, phone, vehicle_type, vehicle_number, status, wallet_balance, agreementRequired } }`. `name`/`vehicle_type`/`vehicle_number` are `null` until set — self-serve OTP signup only ever sets `name`, and only if passed on the first verify; the onboarding flow's vehicle step happens after that, via the next endpoint. |
| PATCH | `/riders/me` | any of `{ name, vehicle_type, vehicle_number }` | Fills in what signup doesn't collect. `name` 1–120 chars (trimmed); `vehicle_type` one of `bike`\|`scooter`\|`bicycle`\|`car` or `null`; `vehicle_number` ≤30 chars or `null` to clear it. `phone` isn't editable (login identity). Empty body → 400. → the updated profile, same shape as `GET /riders/me`. |
| PATCH | `/riders/me/availability` | `{ status: 'active'\|'inactive' }` | |
| PATCH | `/riders/me/location` | `{ lat, lng }` | Foreground-only ping. |
| GET | `/riders/me/orders` | — | Active assigned deliveries, each with `restaurant_name`/`restaurant_address`/`restaurant_lat`/`restaurant_lng` (no items — use `GET /orders/:id` for those). |
| GET | `/riders/me/rate` | — | → `{ rate_per_km, min_earning_per_delivery }` — the live `RIDER_RATE_PER_KM`/`RIDER_MIN_EARNING_PER_DELIVERY` env values `settleRider()` actually pays with. Exists so a client-side earnings estimate never drifts once these placeholders are confirmed with the client and the env vars change. |
| POST | `/riders/me/accept-agreement` | `multipart/form-data`, same contract as `POST /restaurants/me/accept-agreement` above. | See "In-app agreement + selfie verification" below. |

## Admin (`/admin`) — admin only

| Method | Path | Notes |
|---|---|---|
| GET | `/admin/dashboard` | `{ totalOrders, activeRestaurants, activeRiders, pendingOrders }`. |
| GET | `/admin/orders?status=` | Latest 200. |
| GET | `/admin/riders` | |
| POST | `/admin/riders/:riderId/settle` | Manual settlement (no cron yet). |

---

## Admin Panel (`/admin/*`) — admin only

All list endpoints accept `?page=&limit=` (default limit 50, max 200) and return `{ ..., page, limit, total }`. Money fields in list/detail rows are numbers, not decimal strings, unless noted. None of these ever return `password_hash` or `delivery_otp` — every read goes through an explicit column list or the shared `scrubDeliveryOtp`.

### Dashboard

`GET /admin/dashboard` → `{ totalOrders, pendingOrders, activeRestaurants, activeRiders, statusCounts: {placed,accepted,...}, restaurantsByStatus: {active,inactive,suspended}, ridersByStatus: {...}, today: { orders, gmv }, last7Days: [{date:'YYYY-MM-DD', orders, gmv}] }`. `last7Days` is always exactly 7 points, oldest first, zero-filled for quiet days — never a variable-length array. GMV = sum of `grand_total` on **delivered** orders only.

### Orders

| Method | Path | Notes |
|---|---|---|
| GET | `/admin/orders?status=&q=&restaurant_id=&rider_id=&from=&to=&payment_method=` | `q` matches the order id (numeric) or a customer phone substring. `from`/`to` are ISO dates on `created_at`. Rows: `customer_id/name/phone`, `restaurant_id/name`, `rider_id/name`, `category_names` (array), `item_count`. |
| GET | `/admin/orders/:id` | `{ order, customer: {id,name,phone,email,status}, restaurant: {id,name,phone,address,status}\|null, rider: {id,name,phone,status}\|null, items, wallet_ledger }` — siblings of `order`, not nested inside it. `items` = order_items rows + `name`/`category_name`. No `accepted_at`/`on_the_way_at` (known gap — only `picked_up_at`/`delivered_at`/`cancelled_at` exist). |
| POST | `/admin/orders/:id/cancel` | body `{ reason? }`. Works at any pre-delivered/cancelled status, bypassing the customer's own 60s buffer rule. Sets `cancel_reason`, `cancelled_by: "admin"`; refunds to wallet if paid. 409 if already delivered/cancelled. |
| POST | `/admin/orders/:id/reassign-rider` | body `{ rider_id }`. Only while `accepted`\|`picked_up`\|`on_the_way`; new rider must be `active`. |

### Riders

| Method | Path | Notes |
|---|---|---|
| GET | `/admin/riders?q=&status=` | Rows add `cod_liability_outstanding` (positive magnitude of a negative `wallet_balance`, else 0), `unsettled_delivery_count`, `last_active_at` (`riders.updated_at` — a proxy: bumped by the availability toggle and location ping, not literally "last delivery"), `agreementAcceptedAt`, `agreementVersion`. |
| GET | `/admin/riders/:id` | `{ rider: {...+ cod_liability_outstanding, unsettled_delivery_count, agreementAcceptedAt, agreementVersion}, wallet_ledger, orders }`. `orders` is the same row shape as `GET /admin/orders` list rows (via a shared helper), filtered to this rider. |
| POST | `/admin/riders/:id/verification` | `{ decision: 'approve'\|'deny', reason? }` | Approve/deny the rider's selfie; deny needs a reason. See "Approval gate" below. |
| GET | `/admin/riders/:id/agreement-selfie` | Streams the raw selfie bytes (`Content-Type` set from the stored image, no wrapper JSON). 404 `{ error }` if this rider never accepted in-app (exempt seed/dev row, or hasn't onboarded since the feature shipped). See "In-app agreement + selfie verification" below. |
| PATCH | `/admin/riders/:id` | body `{ status: 'active'\|'inactive'\|'suspended' }`. Suspended is already blocked from new auto-assignment (`autoAssignRider` only considers `active`) and from logging back in (see below). |
| POST | `/admin/riders/:riderId/settle` | Unchanged — manual settlement trigger (no cron yet). |
| GET | `/admin/settlements?rider_id=` | Settlement history straight from `wallet_ledger` (`settlement_payout`/`settlement_deduction` rows), joined with rider name/phone. |

### Restaurants

| Method | Path | Notes |
|---|---|---|
| GET | `/admin/restaurants` | Now paginated; each row adds `order_count`, `agreementAcceptedAt`, `agreementVersion`. |
| GET | `/admin/restaurants/:id` | `{ restaurant, categories: [{id,name}], order_count, rating: {avg, count}, commission_config_history }`. `restaurant` includes `agreementAcceptedAt`/`agreementVersion`. `rating` is the average `restaurant_rating` over this restaurant's delivered orders (same source as item ratings). |
| POST | `/admin/restaurants/:id/verification` | `{ decision: 'approve'\|'deny', reason? }` | Approve/deny the kitchen's selfie; deny needs a reason. See "Approval gate" below. |
| GET | `/admin/restaurants/:id/agreement-selfie` | Streams the raw selfie bytes (`Content-Type` set from the stored image, no wrapper JSON). 404 `{ error }` if this restaurant never accepted in-app (exempt seed/dev row, or hasn't onboarded since the feature shipped). See "In-app agreement + selfie verification" below. |
| PATCH | `/admin/restaurants/:id` | Unchanged, now with real `status` validation (`active`\|`inactive`\|`suspended`). A commission-rate change already wrote `commission_config_history`; routing already skips non-`active` restaurants — both confirmed, not new. |
| POST | `/admin/restaurants/:id/categories` | Unchanged — add a served category. |
| DELETE | `/admin/restaurants/:id/categories/:categoryId` | Remove a served category. 404 if it wasn't serving it. |

### Categories & items

| Method | Path | Notes |
|---|---|---|
| GET | `/admin/categories` | Every category incl. inactive, paginated, each with `item_count`, `restaurant_count`, `created_by_restaurant_id`/`_name` (null = admin/seed). |
| PATCH | `/admin/categories/:id` | body: any of `{ name, is_active, description, image_url, prep_time_min_minutes, prep_time_max_minutes, min_order_override }`. A rename goes through the same exact-duplicate check kitchens are held to (409 `category_exists` if it'd collide with another category's normalized name) — no fuzzy/"similar" warning for admin renames, only the hard exact-match block. |
| POST | `/admin/categories/:id/merge` | body `{ into_category_id }`. The "Momo vs Momos" cleanup CLAUDE.md assigns here: moves every item and every restaurant's serving-relationship to the target (de-duplicating `restaurant_categories` rather than violating its unique constraint), then deactivates the source. **Does not rewrite `order_items.category_id`** — past orders keep the category they were placed under, same principle as the item-name snapshot. A category merged away stays blocked from re-creation (409 `category_unavailable`) — the existing dedupe check already covers this, no special-casing needed. |
| GET | `/admin/items?category_id=&q=` | Paginated (previously ignored `limit` — fixed), includes inactive items. |
| PATCH | `/items/:id` | (Existing endpoint, shared with restaurants.) Now also accepts `is_active` **for admin only** — a restaurant sending it gets 403, not silently ignored. Also now allows finding/editing an already-inactive item (needed to un-hide it), which restaurants still can't do. |

### Customers

| Method | Path | Notes |
|---|---|---|
| GET | `/admin/customers?q=&status=&promo_opt_in=&min_orders=&max_orders=&inactive_days=&ordered_category_id=` | Rows: `order_count`, `total_spent` (delivered orders only), `last_order_at`, `promo_opt_in` (boolean; derived from `notification_prefs.promotions`, default true). Accepts the **same campaign filters as the export** (see below) so a preview count matches what exporting would give — `promo_opt_in` here has no default (only filters when passed), unlike the export. |
| GET | `/admin/customers/:id` | `{ customer: {...+stats}, orders, wallet_ledger }`. `orders` uses the same shared row shape as `GET /admin/orders` (never a raw `select *`, so no `delivery_otp` leak). |
| PATCH | `/admin/customers/:id` | body `{ status: 'active'\|'blocked' }`. Blocked = no login (`auth.controller.js`) and no ordering (`POST /orders` re-checks status even against an already-issued token). |
| POST | `/admin/customers/:id/wallet-credit` | body `{ amount, notes? }`. Goodwill credit, ledger reason `manual_adjustment`. |
| GET | `/admin/customers/export.csv` | Same filters, **plus `max_orders`** (new — `max_orders=0` means "never ordered"). `promo_opt_in` **defaults to `"1"`** here (opted-in only) unless explicitly set to `"0"`. **A blocked customer is excluded unconditionally** — even an explicit `status=blocked` on this endpoint is ignored, since this file is meant to be uploaded to a marketing tool. Columns: name, phone, email, order_count, total_spent, last_order_at, created_at. Cells are escaped against CSV/formula injection (a leading `= + - @` gets a neutralizing prefix) since names/emails are user-entered. |

### Coupons

| Method | Path | Body | Notes |
|---|---|---|---|
| POST | `/admin/coupons` | `{ code, title, description?, discount_type, discount_value, max_discount_amount?, min_order_value?, target_type?, target_meta?, usage_limit_per_user?, total_usage_limit?, valid_from?, valid_until?, is_active? }` | `code` is upper-cased on save, must be unique (409 otherwise). `discount_type` ∈ `flat`\|`percent`; `target_type` ∈ `all`(default)\|`new_users`\|`inactive_users`\|`selected_users` — `selected_users` requires `target_meta: { phones: [...] }` (400 without it); `inactive_users` reads `target_meta.days` (default 30). Defaults: `min_order_value` 0, `usage_limit_per_user` 1, `total_usage_limit` unlimited, `is_active` true. **If created active and already in its valid window, fans a push out** to every eligible-by-`target_type` customer who hasn't turned "Offers & news" (`notification_prefs.promotions`) off — title/body from the coupon, `data: { type: "coupon" }` (the apps deep-link a tap straight to the Coupons screen). A later `PATCH` never re-triggers this, even flipping `is_active` false→true. |
| GET | `/admin/coupons?page=&limit=` | — | Every coupon (incl. inactive/expired), paginated, each with `redemption_count` (from `coupon_redemptions`, all customers combined). |
| PATCH | `/admin/coupons/:id` | Any of the creatable fields above | Edit or just toggle `is_active`. Renaming `code` is safe — past orders keep their own `coupon_code` snapshot (see "Coupons" below), so this never rewrites order history. 409 if the new code collides with a different coupon. |

### Admin roles, admin accounts and permissions (added 2026-10-05)

`admins.role` is `super_admin | ops | support` and is **enforced server-side**. Every request with an admin token re-reads the admin row (`requireAuth`), so the role/`is_active` come from the database, not the 30-day JWT: **disabling an admin, or changing their role, takes effect on their very next request.** A disabled admin gets **401** `{ error, code: "account_disabled" }` on any call and **403** `{ code: "account_disabled" }` at `/auth/admin/login`. `/auth/admin/login` also stamps `last_login_at`; `/auth/admin/login` and `/auth/session` return `user.role`.

A role that isn't allowed gets **403** `{ error: "Your role doesn't allow this action", code: "forbidden_role" }` (`requireRole` in `middleware/auth.middleware.js`; restaurant/rider tokens pass it untouched, so it can sit on shared routes).

| | super_admin | ops | support |
|---|---|---|---|
| Every admin `GET` (dashboard, orders, riders, restaurants, customers, coupons, settlements, selfies…) | yes | yes | yes |
| `GET /admin/customers/export.csv`, anything under `/admin/admins` | yes | no | no |
| `POST /admin/orders/:id/cancel` | yes | yes | yes |
| `POST /admin/orders/:id/reassign-rider` | yes | yes | no |
| Restaurants: onboard, `PATCH`, add/remove category, `POST …/verification` | yes | yes | no |
| Riders: `PATCH` status, `POST …/verification` | yes | yes | no |
| Catalog: `PATCH /admin/categories/:id`, `…/merge`, admin `POST /categories`, `POST`/`PATCH /items`, `POST /uploads/image` | yes | yes | no |
| Customers: `PATCH /admin/customers/:id` (block/unblock) | yes | yes | no |
| `POST /admin/riders/:riderId/settle`, `POST /admin/customers/:id/wallet-credit`, `POST`/`PATCH /admin/coupons` | yes | no | no |

| Method | Path | Who | Body | Notes |
|---|---|---|---|---|
| GET | `/admin/admins` | super_admin | — | → `{ admins: [{ id, name, email, role, is_active, last_login_at, created_at }] }`. Never `password_hash`. |
| POST | `/admin/admins` | super_admin | `{ name, email, password, role }` | → **201** `{ admin }`. 400 on a bad field; password must be 10–72 chars; **409** on a duplicate email (case-insensitive). |
| PATCH | `/admin/admins/:id` | super_admin | any of `{ name, role, is_active, password }` | `password` = reset. → `{ admin }`. 400: can't change your own role or disable yourself; **409**: the last active super_admin can't be demoted or disabled. No delete — disable instead. A password reset does not end the target's existing sessions (JWTs are stateless) — disable + re-enable if that's needed. |
| POST | `/admin/me/password` | any admin | `{ current_password, new_password }` | → `{ message }`. A wrong current password is **400**, not 401 (the panel signs out on any 401). |

`node scripts/create-admin.js "Name" "email" "password" [super_admin|ops|support]` still bootstraps the first account; day-to-day accounts are created with `POST /admin/admins`. Pre-existing admins were migrated as active with their old role.

### Login/ordering enforcement (not an endpoint — a cross-cutting rule)

A **blocked customer** or a **suspended rider/restaurant** cannot get a new session (`POST /auth/otp/verify` returns 403 even with the correct OTP) and, for a customer specifically, cannot place an order even on an already-issued token (`POST /orders` re-checks `users.status`). A suspended rider was already excluded from new auto-assignment (routing only considers `status: 'active'` riders); this closes the login-side gap that let a suspended/blocked account keep using a token issued before the change.

## In-app agreement + selfie verification (added 2026-09-29)

On top of the physical signed agreement, restaurants and riders must accept an in-app agreement with a live selfie proving it was the actual owner/rider who accepted it. **Applies to accounts onboarded from the migration onward only** — every pre-existing `restaurants`/`riders` row was backfilled (`agreement_accepted_at = created_at`, `agreement_version = CURRENT_AGREEMENT_VERSION`) in the same migration that added the columns, so seeded/dev accounts are permanently exempt without a separate flag. No paid face-match/liveness API (out of scope before Oct 2) — camera-only capture (client-enforced, not server-checked) plus this server-recorded timestamp is the evidentiary trail; an admin reviews the selfie by eye via the streaming endpoints above.

- **Signal each app needs**: `GET /restaurants/me` / `GET /riders/me` → `agreementRequired: boolean`, true when `agreement_accepted_at IS NULL` or `agreement_version < CURRENT_AGREEMENT_VERSION`. Bumping the `CURRENT_AGREEMENT_VERSION` env var re-gates every account whose stored version is behind, with no data migration needed.
- **Accepting**: `POST /restaurants/me/accept-agreement` / `POST /riders/me/accept-agreement` — multipart field `selfie` (jpeg/png/webp by magic bytes, 2MB cap) + field `agreement_version` (the version the app is currently showing). **409** if that doesn't match `CURRENT_AGREEMENT_VERSION` (blocks a stale app build from accepting an outdated version). 400 if the file or version field is missing/malformed. On success: 200 `{ agreementAcceptedAt }` (ISO string) — the timestamp is always the **server's own clock**, never anything the client sends.
- **Storage**: the selfie is saved to `agreement_selfie_path` — an **internal path, never a public URL**. Disk mode: a dedicated `agreement-selfies/` directory that (unlike `uploads/`) is never mounted by `express.static`. S3 mode: key-prefixed `agreement-selfies/` in the same bucket as catalog photos — **note this bucket's policy grants public `s3:GetObject` on every key**, so this is "never linked anywhere" rather than cryptographically private; revisit with a second, non-public bucket if that needs to be airtight.
- **Approval gate (added 2026-10-05)**: a new selfie is not enough — an admin must approve it. `restaurants`/`riders.verification_status` is `pending` | `approved` | `denied` (+ `verification_denied_reason`, `verification_reviewed_at`, `verification_reviewed_by_admin_id`). **Every row that existed before the migration is `approved`** (column default), so seed/dev/demo/Play-review logins are untouched; only the admin "onboard kitchen" flow and rider self-signup create `pending` rows.
  - **What's blocked**: for a restaurant/rider token whose status isn't `approved`, `requireAuth` answers **403** `{ error, code: "verification_required", verificationStatus, verificationDeniedReason }` on *every* route — secure by default, so a new partner route can't forget the gate. Only these opt out (`{ allowUnverified: true }`): `GET /auth/session`, `POST /auth/logout`, `POST /notifications/register-device`, `GET /restaurants/me`, `POST /restaurants/me/accept-agreement`, `GET`/`PATCH /riders/me`, `POST /riders/me/accept-agreement`. Login itself still works (they need it to submit the selfie).
  - **Also excluded from matching**: a non-approved restaurant is never returned by `findCandidates` (order routing) or counted for catalog visibility, and a non-approved rider is never auto-assigned.
  - **Apps**: `GET /restaurants/me` and `GET /riders/me` return `verificationStatus` + `verificationDeniedReason`. `agreementRequired` is **also true while `denied`** (the partner must retake the selfie). A submitted selfie shows an "Under review" screen while `pending`.
  - **Accepting resets the state**: `accept-agreement` sets `pending` (clears the reason) and returns `{ agreementAcceptedAt, verificationStatus }`. Exception: an already-`approved` partner re-accepting after an agreement version bump stays `approved`.
  - **Reviewing**: `POST /admin/restaurants/:id/verification` / `POST /admin/riders/:id/verification`, body `{ decision: "approve" | "deny", reason? }`. `approve` needs a selfie on file (409 otherwise); `deny` needs a non-empty `reason` ≤255 chars (400) which the partner sees. Either decision is allowed from any state (an approval can be revoked). Response `{ verificationStatus, verificationDeniedReason, verificationReviewedAt }`; the partner also gets a push. Admin list/detail reads include `verificationStatus`, `verificationDeniedReason`, `verificationReviewedAt`, `hasAgreementSelfie`.
- **Reviewing**: `GET /admin/restaurants/:id/agreement-selfie` / `GET /admin/riders/:id/agreement-selfie` (admin-only) stream the image bytes directly (never a redirect to a public URL) — see the Restaurants/Riders tables above. `agreementAcceptedAt`/`agreementVersion` are included on the corresponding list/detail endpoints for a review queue.
- **Not enforced server-side on other endpoints** — this is deliberately an app-level gate (per the client's spec: fully blocks the Restaurant/Rider app's main screens client-side) plus an admin audit trail, not a backend block on order-accept/rider-assignment/etc. A restaurant or rider that hasn't accepted yet can still be routed orders/deliveries by the backend today; flag it if the client wants that tightened later.
- Both apps' in-app agreement **text is a placeholder** — same status as the invoice issuer fields, needs real legal copy from the client before launch.

## Customer app T&C popup (added 2026-09-30)

**Unrelated to the restaurant/rider feature above** — a lightweight, one-time terms-acceptance checkbox for customers only, no selfie, no admin review. Same backfill/exemption pattern: every pre-existing `users` row was backfilled (`agreement_accepted_at = created_at`, `agreement_version = CUSTOMER_TERMS_VERSION`) in the migration that added the columns, so existing customers are permanently exempt.

- `GET /profile/me` → `agreementRequired: boolean`, true when `agreement_accepted_at IS NULL` or `agreement_version < CUSTOMER_TERMS_VERSION`.
- `POST /profile/accept-agreement` — JSON body `{ agreement_version }` (no file). **409** if it doesn't match `CUSTOMER_TERMS_VERSION`, 400 if missing/malformed. 200 `{ agreementAcceptedAt }` (server clock only).
- **`CUSTOMER_TERMS_VERSION` is a separate env var from `CURRENT_AGREEMENT_VERSION`** (the restaurant/rider lever) — customer terms and the restaurant/rider partner agreement are different documents; bumping one must not re-gate the other's audience.
- Not enforced server-side on order placement — same app-level-gate posture as the restaurant/rider feature.
- Terms text is a placeholder, same status as the other placeholder copy noted above.

## Coupons (added 2026-09-30)

Coupons are never "for everyone" by default — every coupon has a `target_type`, set by the admin at creation. `src/services/coupon.service.js` is the single place the eligibility/limit/discount logic lives, shared by `GET /coupons/mine`, `POST /cart/quote`, and `POST /orders` (and, in bulk form, the admin creation-push fan-out) — a code can never be judged valid in one of those and invalid in another.

- **Targeting** (`target_type`): `all` (everyone); `new_users` (zero orders ever, of any status — even a cancelled one counts as "not new" anymore, a documented assumption); `inactive_users` (no order — any status — in `target_meta.days` days, default 30; this also covers a customer with zero orders ever, since "no order in N days" is vacuously true for them too); `selected_users` (`target_meta.phones`, an explicit list the admin pastes in).
- **Discount math**: `flat` is a straight rupee amount; `percent` applies to `item_total` (the food subtotal, not delivery/tax), capped by `max_discount_amount` if set. Either way the discount is capped at `item_total` — a coupon can never zero out delivery fee or tax. **GST is computed on the full, pre-discount `item_total`** — the discount is a platform-funded promo applied after tax, not a menu-price cut, so it also never reduces a restaurant's `commission_amount`. None of this is client-confirmed; it's a documented default.
- **Validation order** (`validateCoupon`): code exists → `is_active` → within `valid_from`/`valid_until` → cart meets the coupon's own `min_order_value` → `total_usage_limit` not exhausted (global) → this customer not at their own `usage_limit_per_user` (default 1) → eligible per `target_type`. Usage limits are checked **before** eligibility on purpose — redeeming a `new_users` coupon gives the customer their first order, which would otherwise flip their own eligibility to false and report the less specific "not eligible" instead of "already used" on a second attempt with the same code.
- **Applying it**: `POST /cart/quote` and `POST /orders` both take an optional `coupon_code`. An invalid/expired/ineligible/limit-exceeded code **never blocks the cart or the order** — it just isn't discounted, with the reason surfaced as `couponError` (quote) or `order.couponError` (placement, order still 201s). A coupon is **not** applied when a clubbed cart falls back to two separate orders (`attemptClubbedFallbackSplit`) — no single obvious order to attach one discount to; the placement response's `message` says so when a code was sent.
- **Persistence**: a successful redemption sets `orders.coupon_id`/`coupon_code`/`coupon_discount_amount` and writes a `coupon_redemptions` row (usage-limit enforcement + audit trail). `coupon_code` is a **snapshot** — same "never rewrite history" principle as the item-name snapshot, so a later coupon rename/edit never changes what an old order shows. `grand_total` already nets the discount at every point it's computed, including the two places that existed **before** this feature and recompute it later: `acceptOrder`'s dropped-unavailable-item recompute, and `rejectOrder`'s cascade-reassignment recompute — both now subtract `coupon_discount_amount` too.
- **Cancelling voids the redemption**: customer cancel, admin cancel, and the reject-cascade "nobody else can take it" cancel path all delete the order's `coupon_redemptions` row, freeing the coupon up again — a cancelled order never actually delivered its discount, so it shouldn't burn one of the customer's uses.
- **Invoice**: a redeemed order's `GET /orders/:id/invoice` (and PDF) gets an extra `"Coupon discount (CODE)"` line with a negative amount; `invoiceTotal` already nets it since `grand_total` was computed that way at placement.
- **Not enforced server-side beyond redemption bookkeeping** — same app-level posture as the two agreement features above: this doesn't add any new order-placement blocking rule beyond what's described here.

## Partner documents (added 2026-10-28)

Restaurants and riders upload KYC/licence documents through the partner web portal
(**partner.fengle.in**, `PARTNER_PORTAL_URL`); an admin approves or rejects each one.

| Partner | Document (`doc_type`) | Required | Number | Expiry |
|---|---|---|---|---|
| restaurant | `aadhaar` (owner's, **masked**) | yes | — | — |
| restaurant | `fssai` | yes | 14 digits | yes |
| restaurant | `trade_license` | yes | yes | yes |
| rider | `aadhaar` (masked) | yes | — | — |
| rider | `driving_license` | **no** | yes | yes |

**Partner portal** (restaurant or rider token; `allowUnverified`, so a partner whose selfie is still pending can upload):

| Method | Path | Notes |
|---|---|---|
| GET | `/partner/documents` | `{ partner, ownerType, enforced, requirements[], documents: { [doc_type]: current or null }, summary }`. `current.approvedVersion` is the older approved upload when a newer one is waiting for review. |
| POST | `/partner/documents` | multipart: `file` (JPEG/PNG/WebP/PDF by magic bytes, 5 MB cap), `doc_type`, `doc_number?`, `expiry_date?` (YYYY-MM-DD, not in the past). 201 `{ document }` (status `pending`). 400 on a bad type/number/date/file, 413 too large. |
| GET | `/partner/documents/:id/file` | Streams the partner's **own** upload (404 for anyone else's). |

Portal login is the normal OTP flow (`purpose: restaurant_login | rider_login`) plus **`existing_only: true`** on `POST /auth/otp/verify`: an unknown rider phone gets 404 instead of a new account (rider self-signup stays in the app).

**Admin** (all roles may view; review is `ops` + `super_admin`):

| Method | Path | Notes |
|---|---|---|
| GET | `/admin/documents?status=&owner_type=&page=&limit=` | Review queue with `ownerName`/`ownerPhone`. `status=pending` is oldest first. |
| GET | `/admin/documents/:ownerType/:ownerId` | `{ owner, requirements, documents, summary, history[] }` (`ownerType` = `restaurant`\|`rider`). |
| GET | `/admin/documents/:id/file` | Streams the file (`Cache-Control: private, no-store`). |
| POST | `/admin/documents/:id/review` | `{ decision: 'approve'\|'reject', reason? }` — reason required to reject; pushes the partner. |

`GET /admin/restaurants` and `GET /admin/riders` rows, and `GET /restaurants/me` / `GET /riders/me`, carry `documents: { status, complete, validUntil, missing[], pendingCount }` (`status` ∈ `complete`, `expiring` (≤30 days), `pending`, `rejected`, `expired`, `missing`); the `/me` endpoints also return `documentsPortalUrl`.

- **Storage is private**: `AWS_S3_PRIVATE_BUCKET` (Block Public Access on, read by the EC2 role; production: `fengle-private-documents`, versioned) when set, otherwise the server's `partner-documents/` directory, which is never statically served. **Never** `AWS_S3_BUCKET` — its policy makes every key public. No response ever contains the storage path. Agreement selfies use the same private bucket (key prefix `agreement-selfies/`); `scripts/move-selfies-to-private-bucket.js` moved the ones saved to the public bucket before it existed, and reads fall back to the public bucket for any not yet moved.
- **Current vs effective**: a partner's latest upload of a type is what's shown; their latest *approved* upload is what counts. A renewed licence awaiting review doesn't interrupt a partner whose previous one is approved and in date.
- **Blocking** (`PARTNER_DOCUMENTS_ENFORCED=true`, off by default): routing, the customer catalog, rider auto-assignment and admin rider reassignment (400 `documents_required`) skip partners whose `documents_valid_until` is NULL or before today (IST). That column is recomputed on every upload/review: the earliest expiry among effective required documents, `9999-12-31` when none expire, NULL when one is missing. An expired licence therefore blocks on its own, with no scheduled job. It's a routing/assignment gate, not an API gate — the apps keep working (no new error code they don't know).

## Dish portion size (added 2026-10-28)

Every dish can show its quantity ("Butter Chicken — 3 pc", "Biryani — 500 gm"). Client requirement; optional per item.

- **Fields**: `items.quantity_value` (DECIMAL(8,2) > 0, up to 99999.99) + `items.quantity_unit` (one of `pc`, `gm`, `kg`, `ml`, `ltr`; accepted case-insensitively, stored lowercase). **Both set or both null** — sending only one is 400. `null`/`""` for both clears it.
- **Writes**: `POST /items` and `PATCH /items/:id` (restaurant or admin) accept `quantity_value` + `quantity_unit`. A `PATCH` that doesn't mention them leaves the portion untouched.
- **Reads**: every endpoint that returns items carries `quantity_value` (a number), `quantity_unit` and a server-built **`portion_label`** — `"3 pc"`, `"500 gm"`, `"1.5 ltr"` (trailing zeros trimmed: 500.00 → `500`), `null` when unset. That covers `GET /categories/:id/items`, `GET /categories/:id` (popular + more), `GET /items/search`, `GET /items/popular`, `GET /favorites`, `GET /restaurants/me/menu`, `GET /admin/items`, and the `item` returned by `POST`/`PATCH /items`.
- **Orders snapshot it**: `order_items.portion_value` / `portion_unit` are copied from the item when the order is placed (same idea as the `item_name` snapshot), so editing a dish later never rewrites an old order. Each line of `GET /orders/:id` (all parties — customer, restaurant, rider, admin), `GET /orders` and `GET /admin/orders/:id` carries `portion_label` (and `portion_value`/`portion_unit` on the detail endpoints). Orders placed before this feature, and lines with no snapshot, read `null` — nothing is guessed from today's item.
- `src/utils/portion.js` is the single place for the unit list, label format and validation.

## Prices and offers — admin only (added 2026-10-28)

Client decision: **only Fengle admins set prices.** A restaurant has no way to set or change one.

- **Restaurants**: `PATCH /items/:id` with `price`, `offer_price` or `offer_ends_at` from a restaurant token → **403** `{ code: "price_admin_only" }` (every other field stays editable). `POST /items` from a restaurant with any of those → 403 too — a kitchen proposes a dish with **no price** (`category_id`, `name`, optional `description`/`is_veg`/`image_url`/`quantity_*`).
- **Awaiting a price**: such a dish is stored with `awaiting_price = true`, `price = 0.00` (the column is NOT NULL) and `is_active = false`, so customers never see it. Every read presents it as `price: null`. The kitchen sees its own pending dishes on `GET /restaurants/me/menu` (`awaiting_price: true`, `price: null`, `effective_price: null`); it still can't edit them until they are live. Admins list them with `GET /admin/items?awaiting_price=1` (rows carry `created_by_restaurant_id` + `created_by_restaurant_name`). `GET /admin/items` also takes `is_active=0|1`.
- **Going live**: an admin `PATCH /items/:id { price }` on an awaiting dish clears `awaiting_price` and activates it (unless the same request says `is_active: false`). `{ is_active: true }` on an awaiting dish without a price → 400. Admin `POST /items` still requires a price.
- **Offers** (admin only): `offer_price` (> 0 and **below the price it applies to**) + optional `offer_ends_at` (a future ISO date-time; omit/`null` = no end). Set on `PATCH /items/:id` or on `POST /items` by an admin. `offer_price: null` (or `""`) clears the offer and its end date. A `PATCH` that only changes `offer_price` keeps a still-running end date (and drops a stale one); `offer_ends_at` alone needs an existing offer. Changing `price` to a value at or below the stored offer → 400 unless the same request lowers/clears the offer. An offer is **in force** while `offer_price` is set, below `price`, and `offer_ends_at` is null or in the future — it stops on its own at the end time.
- **What readers get** (customer catalog, search, popular, favorites, kitchen menu, and the `item` from POST/PATCH for non-admins): `price` (the normal price), `offer_price` and `offer_ends_at` (**null unless the offer is in force**, so apps need no clock logic), and **`effective_price`** — what is charged now. Show a strike-through when `offer_price != null`.
- **What admins get** (`GET /admin/items`, `POST`/`PATCH /items` by an admin): the stored `offer_price`/`offer_ends_at` plus `offer_active` (in force right now), `effective_price` and `awaiting_price`.
- **What is charged**: `POST /cart/quote` and `POST /orders` use `effective_price` per unit, so `item_total`, GST and the restaurant commission all follow what the customer actually pays; coupons then apply on top of that as before. The order line snapshots `unit_price` (charged) and `list_price` (the normal price at that moment) on `order_items`, so a discounted line can show its strike-through later; old lines have `list_price: null`. Orders already placed never change when a price or offer is edited. `src/utils/pricing.js` is the single place the effective price is decided.

## Rider pay — admin-configurable (added 2026-10-28)

> **Superseded 2026-10-29 by [Shipping rules](#shipping-rules-added-2026-10-29).** Rider pay is now a `rider_pay` rule set; `PUT /admin/settings/rider-pay` answers **410** `moved_to_shipping_rules`, and `GET` is a read-only view of the old single-config shape that only shows while the rules really are that simple (`simple: true`). Everything below about *freezing the payout at delivery*, who sees it, settlement and `estimated_rider_payout` still holds; only where the numbers come from changed.

Replaces the `RIDER_RATE_PER_KM` / `RIDER_MIN_EARNING_PER_DELIVERY` env placeholders (they now only seed the first config row, so nothing changed on deploy).

- **Formula** (what every payout is): `payout = max(min_payout, base_payout + distance_pay) + incentive_per_delivery`, where `distance_pay = per_km_rate × min(distance_km, tier_km) + per_km_rate_after_tier × max(0, distance_km − tier_km)` — a **two-rate** distance pay (e.g. ₹10/km for the first 5 km, another rate beyond). With no tier (`tier_km` and `per_km_rate_after_tier` both null, every config saved before 2026-10-29) it is simply `per_km_rate × distance_km`. All rounded to 2 decimals. `distance_km` is the straight-line distance from the kitchen to the drop-off (haversine — the same measure settlement always used).
- **Settings** (`rider_pay_config`, append-only): `GET /admin/settings/rider-pay` (every admin role) → `{ settings, formula, history }`; `settings` is the live row, `history` is every change newest-first (`id`, the four values, `created_at`, `created_by_admin_id`, `created_by_admin_name`; the seed row has no admin). `PUT /admin/settings/rider-pay` (**super_admin**) with all four of `base_payout`, `per_km_rate`, `min_payout`, `incentive_per_delivery` (numbers 0–100000; all four zero is refused unless a tier is set) and optionally the **two-rate tier** `tier_km` (> 0, up to 1000) + `per_km_rate_after_tier` (0–100000): **both or neither** (one without the other is 400; a PUT that leaves them out, or sends both `null`/`""`, saves a single-rate config — each PUT is a complete config). `settings` and every `history` row carry `tier_km` and `per_km_rate_after_tier` (null = single rate) appends a row and makes it live → `{ settings, formula, id }`. It applies to orders **delivered from then on**.
- **Frozen at delivery**: when `POST /orders/:id/delivered` succeeds the payout is computed once and stored on the order: `orders.rider_payout`, `orders.rider_payout_breakdown` (JSON: `formula`, `distance_km`, `base_payout`, `per_km_rate`, `distance_pay` (the total distance pay, first tier plus anything beyond), `tier_km`, `per_km_rate_after_tier`, `extra_distance_km`, `extra_distance_pay` (the part beyond the tier; 0 / null without a tier), `subtotal`, `min_payout`, `min_applied`, `incentive_per_delivery`, `payout`, `config_id`) and `orders.rider_pay_config_id`. A later rate change never rewrites it.
- **Settlement** (`POST /admin/riders/:riderId/settle`) pays each unsettled delivered order its stored `rider_payout`; orders delivered before this feature (NULL payout) fall back to the **current** formula. The ledger note says how many of each.
- **Estimate before delivery**: `GET /orders/:id` and `GET /orders` give the **rider** (their own orders) and **admin** `estimated_rider_payout` (number): what the order would pay under the **live** config and the same kitchen→drop-off distance, for orders still to be delivered (`accepted`, `picked_up`, `on_the_way`); `null` for any other status or when the distance can't be computed. The final payout is still frozen at delivery from whatever config is live then, so show it as an estimate. Customers and kitchens never get the key.
- **Who sees it**: `rider_payout` (number), `rider_payout_breakdown` (object) and `rider_pay_config_id` are on `GET /orders/:id` and `GET /orders` for the **rider** (their own orders) and **admin**; customers and restaurants never get them. Admin: `GET /admin/orders` rows and `GET /admin/riders/:id` order rows carry `rider_payout`; `GET /admin/orders/:id` adds the breakdown object and config id. `GET /admin/riders/:id` also returns `payouts: { deliveries, total_earned, unsettled }` — sums of the **stored** payouts only (older deliveries without one are paid at settlement but not counted here).
- `GET /riders/me/rate` now reads the live config: the original `rate_per_km` (= `per_km_rate`) and `min_earning_per_delivery` (= `min_payout`) plus `base_payout`, `incentive_per_delivery`, `tier_km`, `per_km_rate_after_tier` (null = a single rate) and `formula`. Rider app builds that estimate earnings locally should switch to the order's `rider_payout`.

## COD cash: handovers and reconciliation (added 2026-10-28)

A COD order can only be marked delivered when the rider confirms the exact `grand_total` (`POST /orders/:id/delivered`), which writes a rider ledger **debit** (`cod_collected`) — the rider's *outstanding COD* is their negative wallet balance. When the rider hands the cash to Fengle, an admin records it here.

- **Record a handover** — `POST /admin/riders/:id/cash-handovers` (**ops + super_admin**) `{ amount, received_at?, reference?, notes? }` → **201** `{ handover: { id, rider_id, amount, received_at, reference, notes, received_by_admin_id, balance_after, outstanding_after, created_at } }`. It writes a `wallet_ledger` **credit** with reason `cash_handover` (so it shows in the rider's wallet ledger — apps should render that new reason) and reduces the outstanding COD. Rules: `amount` > 0 (up to 1,000,000); `received_at` defaults to now and can't be in the future; `reference` (≤100 chars) is **unique per rider** — repeating it is **409**, so a double-submit can't credit twice; **409** if `amount` is more than the rider currently owes (`{ error, outstanding }` — a typo guard). 404 unknown rider.
- **History** — `GET /admin/cash-handovers?rider_id=&from=&to=&page=&limit=` (every role) → `{ handovers: [{ …, rider_name, received_by_admin_name, balance_after }], page, limit, total, total_amount }`, newest first, filtered on `received_at`.
- **Reconciliation** — `GET /admin/cod/reconciliation?from=&to=&rider_id=&flagged=&page=&limit=` (every role) → `{ range, totals, riders, orders, page, limit, total_orders }`. `from`/`to` are optional; a date-only value (`2026-10-28`) means that whole **IST** day (`to` runs to 23:59:59.999; `REPORT_TZ_OFFSET_MINUTES`, default 330), a full ISO date-time is used as given. No range = all time.
  - **Which orders**: COD orders with status `delivered` or `cancelled` (so cancelled/refunded ones are included) whose **closing date** `COALESCE(delivered_at, cancelled_at, created_at)` is in the range. Orders still in progress are excluded.
  - **Order row**: `grand_total`; `expected` = `grand_total` for a delivered order, `0` for a cancelled one (no cash should change hands); `collected` = sum of the rider's `cod_collected` ledger debits for that order (what the rider confirmed); `difference` = `collected − expected`; `refunded` = what was credited back to the customer's wallet for it; `flag` = `"short"` / `"excess"` (delivered and `difference` ≠ 0) or `"unexpected_collection"` (cancelled but cash was recorded) or `null`. `flagged=1` returns only flagged rows.
  - **Rider row** (every rider with COD activity or a handover in the range, plus anyone who currently owes cash): `delivered_cod_orders`; `expected` (sum over delivered orders); `collected` (sum over all of that rider's rows, so cash recorded on a cancelled order counts); `difference` = `collected − expected`; `flagged_orders`; `handed_over` = handovers with `received_at` in the range; `net_cash_in_period` = `collected − handed_over`; `outstanding` = what the rider owes **right now** (`max(0, −wallet_balance)`; it nets settlements and handovers and is **not** limited to the range). `totals` sums the rider rows (+ `cod_orders`, `flagged_orders`).
  - **CSV** — `GET /admin/cod/reconciliation.csv` (same filters, every row, no paging): `view=orders` (default; columns `order_id, closed_at, status, payment_status, rider_id, rider_name, grand_total, expected, collected, difference, refunded, flag`) or `view=riders`.

## Finance: expenses and profit & loss (added 2026-10-29) — super_admin only

Every route here is **super_admin only** (ops/support get 403 `forbidden_role`). Dates are **IST days** (`REPORT_TZ_OFFSET_MINUTES`, default 330): `2026-03-31` means that whole IST day, and an order placed at 23:30 IST on 31 March belongs to March whatever the server clock says. With no `from`/`to` the reports default to the current month so far.

**Expenses** — `POST /admin/expenses { date: "YYYY-MM-DD", category: marketing|operating|salaries|other, amount (>0), notes? }` → 201 `{ expense }`; `GET /admin/expenses?from=&to=&category=&page=&limit=` → `{ expenses, page, limit, total, total_amount, by_category }` (newest first); `PATCH /admin/expenses/:id` (any of the fields); `DELETE /admin/expenses/:id`. An expense is `{ id, date, category, amount, notes, created_by_admin_id, created_at, updated_at }`.

**Profit & loss** — `GET /admin/finance/pnl?from=&to=&group=day|month` (default `day`) → `{ range, group, gateway_fee_percent, formulas, periods: [{ period, ...figures }], totals }`. `periods` only contains periods with activity (orders or expenses), oldest first; `totals` is the same figures over the whole range. CSV: `GET /admin/finance/pnl.csv` (same filters; one row per period plus a `TOTAL` row) and `GET /admin/finance/orders.csv` (order-wise transactions: one row per order placed in the range, exactly the rows the P&L sums, so the two always tie out).

**One basis for every order figure: the order's placement date** (`created_at`, IST) — the P&L reports "orders placed in this period, and what became of them", so a late delivery still counts in the day it was placed. Expenses use their own `date`. Money comes from these order columns; only **delivered** orders carry revenue and costs.

| Figure | Formula |
|---|---|
| `orders_placed` / `gross_order_value` | count / sum of `grand_total` of every order placed (any status) |
| `delivered_orders` / `delivered_sales` | count / sum of `grand_total` of delivered orders (includes GST and the delivery fee, after coupons) |
| `delivered_item_total`, `delivered_delivery_fees`, `gst_collected`, `commission` | sums over delivered orders of `item_total`, `delivery_fee`, `cgst_amount + sgst_amount`, `commission_amount` (**`commission` is legacy/informational: it no longer drives revenue or payables**) |
| **`fengle_revenue`** | over delivered orders: `item_total − restaurant_payable + delivery_fee` — `item_total` is what customers paid for the food after dish offers; **GST is a pass-through and is never revenue** |
| **`restaurant_payables`** (`restaurant_payables_interim` is a deprecated alias) | sum of `orders.restaurant_payable` over delivered orders = what Fengle owes kitchens: **vendor cost × quantity** per confirmed line, never reduced by coupons or offers (Fengle bears all discounts). A line whose dish had no vendor cost uses the old estimate (line subtotal − the kitchen's commission %), and its order counts in `payable_estimated_orders` — set the dish costs to make the figure exact |
| **`rider_payouts`** | sum over delivered orders of the payout frozen at delivery (`orders.rider_payout`); a delivered order without one (delivered before rider pay existed) uses the **current** rider-pay formula for that order. Split into `rider_payouts_stored`, `rider_payouts_estimated` and `rider_payouts_estimated_orders` (how many) |
| **`coupon_discounts`** | sum of `coupon_discount_amount` over delivered orders — platform-funded, so a cost to Fengle |
| **`gateway_charges`** | `RAZORPAY_FEE_PERCENT` % (default **2**) of `grand_total` over delivered orders paid by `upi`/`card`/`netbanking`. COD and wallet orders carry no fee. Fees on cancelled-and-refunded online orders are **not** included |
| `expenses` / `expenses_total` | sum of expenses in the period, per category and overall |
| **`net_profit`** | `fengle_revenue − rider_payouts − coupon_discounts − gateway_charges − expenses_total` |
| `cancelled_orders` / `cancelled_value` | count / sum of `grand_total` of orders with status `cancelled` |
| `in_progress_orders` / `in_progress_value` | orders placed in the period that are not yet delivered or cancelled |
| `offer_discounts_info` | **informational, not deducted**: sum over delivered orders' confirmed lines of `(list_price − unit_price) × quantity`. Already inside the lower `item_total`, so deducting it again would double count |
| `refunds_info` | **informational, not deducted**: customer wallet refunds (`order_refund`) for those orders. A delivered order's `grand_total` is already net of dropped items, and a cancelled order is never counted as a sale |

Why `net_profit` leaves out restaurant payables and GST: the customer's money in is `grand_total = item_total + delivery_fee + GST − coupon`; out go the kitchen's payable, the rider payout, the GST to the government and the gateway fee — what remains is `(item_total − payable) + delivery_fee − coupon − rider payout − gateway fee`, i.e. `net_profit` before expenses.

**orders.csv columns**: `order_id, placed_at, delivered_at, cancelled_at, status, payment_method, payment_status, item_total, delivery_fee, gst, coupon_discount, grand_total, fengle_revenue, restaurant_payable, payable_estimated, rider_payout, rider_payout_source (stored|estimated|empty), gateway_charge, offer_discount, refunded, net_contribution` — `net_contribution = fengle_revenue − rider_payout − coupon_discount − gateway_charge` for a delivered order, `0` otherwise; summed over the rows and minus expenses it equals `net_profit`.

## Notification centre (added 2026-10-29) — super_admin only

Compose a push notification to customers, send it now or schedule it, cancel it while it is still scheduled, and read the delivery report. All routes are **super_admin only** (ops/support → 403 `forbidden_role`).

- **Kinds**: `promotion` respects each customer's "Offers & news" switch (`notification_prefs.promotions === false` = opted out, skipped); `service` (outage, policy or safety notices) goes to **every targeted customer regardless**. Blocked customers never receive either.
- **Audience** `{ type, ... }`: `all` (every active customer) · `filtered` with `filters` using the same names as `GET /admin/customers` — `min_orders`, `max_orders` (`0` = never ordered), `inactive_days` (no order in N days, or never), `ordered_category_id` — all whole numbers ≥ 0 · `phones` with a `phones` list (≤ 5000 numbers; 10 digits or `91`-prefixed, de-duplicated).
- `POST /admin/notifications/preview { kind, audience }` → `{ customers, devices, matched, opted_out_excluded }` — how many customers/devices it would reach right now (`matched` = audience size before promotion opt-outs). Sends nothing.
- `POST /admin/notifications { title (≤100), body (≤500), kind, audience, scheduled_at? }` → **201** `{ campaign }`. Leave `scheduled_at` out to **send now** (status starts at `sending`); otherwise it must be at least a minute ahead and at most a year ahead (ISO date-time) and the campaign starts as `scheduled`.
- `GET /admin/notifications?status=&kind=&page=&limit=` → `{ campaigns, page, limit, total }`, newest first (the history). `GET /admin/notifications/:id` → `{ campaign }`.
- `POST /admin/notifications/:id/cancel` — only while `scheduled`; otherwise **409** (`sending`/`sent`/`cancelled`/`failed`), 404 unknown. The cancel is atomic with the scheduler's pick-up, so a campaign can never both send and be cancelled.
- **campaign** = `{ id, title, body, kind, audience: { type, filters, phones }, scheduled_at, status: scheduled|sending|sent|cancelled|failed, targeted_customers, targeted_devices, sent_count, failed_count, error, created_by_admin_id, created_by_admin_name, sent_at, cancelled_at, created_at }`. `targeted_customers`/`targeted_devices` are filled in when the send starts; `sent_count` = device pushes accepted by FCM/Expo, `failed_count` = pushes rejected (including dead tokens, which are also deleted). A send where devices existed but **none** accepted ends `failed` with an `error` (e.g. FCM not configured) rather than a silent "sent to 0".
- **Scheduler**: an in-process timer (`services/campaign.service.js`, started from `server.js`) runs every minute and sends due campaigns, oldest first. The API runs as a single PM2 instance; a second instance would need a different claim (the claim is an atomic `UPDATE … WHERE status='scheduled'`, so even two instances would not double-send). A campaign found still `sending` after 30 minutes on boot (the server was cut off mid-send) is marked `failed` and is **not** re-sent.
- The push carries `data: { type: "campaign", campaign_id, kind }`; the customer app may ignore it.

## Vendor cost, restaurant settlement and profit per product (added 2026-10-29)

Client decision: **kitchens are paid by vendor cost, not commission.** Every dish has two prices — the customer price (`price`, plus any offer) and a **vendor cost**, what Fengle pays the kitchen per unit. One cost per dish, the same for every kitchen (a per-kitchen override can be added later in `services/restaurantPayable.service.js`). **Fengle bears all discounts:** coupons and dish offers never reduce a kitchen's payable.

**Vendor cost on dishes** — `items.vendor_cost` (≥ 0, up to 100000; `null` clears). **Admin-only**: `POST /items` and `PATCH /items/:id` accept it from an admin (an awaiting-price dish can get its price and cost in one PATCH); a restaurant sending it gets **403** `price_admin_only`. It is **never returned to customers, kitchens or riders** (catalog, favorites, the kitchen's menu, order lines and order rows all omit it). A cost above the price is allowed (a deliberate loss-leader) but the response carries `warning`. Admin reads (`GET /admin/items`, and the `item` of an admin's POST/PATCH) add `vendor_cost`, `margin` = `effective_price − vendor_cost` and `margin_percent` (of the effective price); `GET /admin/items?missing_vendor_cost=1` lists dishes still without one. `support` admins never see vendor cost, margin, or an order's payable (super_admin and ops do).

**On orders** — at placement each line snapshots `order_items.vendor_cost`, and `orders.restaurant_payable` = Σ `vendor_cost × quantity` over the confirmed lines. It is recomputed when lines are dropped at accept and when a reject cascades to another kitchen. A line whose dish had **no** vendor cost falls back to the old formula (`subtotal − subtotal × the kitchen's commission %`) and the order is flagged `payable_estimated: true`, so admins can spot dishes still missing a cost. Orders placed before this feature were backfilled with `item_total − commission_amount` and flagged estimated. A cancelled order owes the kitchen nothing (`restaurant_payable` reads 0 on `GET /admin/orders/:id`). `commission_amount` is still computed but drives nothing. Admin order detail returns `restaurant_payable`, `payable_estimated` and each line's `vendor_cost`; no other role does.

**Settlement** (reads **super_admin + ops**, writes **ops + super_admin**; support gets 403). `outstanding = total_payable + total_adjustments − total_paid` (all time; `status` is `settled` at 0, `advance` if negative, else `due`). A payable is earned on the order's **delivery** date. Only **delivered** orders count.
- `GET /admin/restaurant-settlements?from=&to=` → `{ range, totals, restaurants: [{ restaurant_id, restaurant_name, delivered_orders, payable_earned, adjustments, paid (all three for the range), total_payable, total_adjustments, total_paid, outstanding (all time), status, estimated_orders (range), estimated_orders_total, has_estimated_payables, last_payment_at }] }`, biggest outstanding first. CSV: `GET /admin/restaurant-settlements.csv`.
- `GET /admin/restaurants/:id/settlement?from=&to=&page=&limit=` → the statement `{ restaurant, range, opening_balance, payable_earned, adjustments_total, paid_total, closing_balance, outstanding_now, status, estimated_orders, days: [{ date, orders, payable, estimated_orders }], orders (paged): [{ order_id, delivered_at, payable, estimated, customer_paid_items, items: [{ item_id, name, quantity, unit_price, line_subtotal, vendor_cost, line_cost, estimated }] }], page, limit, total_orders, payments, adjustments }`. Opening balance = owed before `from` (0 with no `from`); closing = opening + earned + adjustments − paid. CSV: `GET /admin/restaurants/:id/settlement.csv` — one running ledger (`date, type opening_balance|order|adjustment|payment, reference, detail, amount, estimated, balance`).
- `POST /admin/restaurants/:id/payments { amount, paid_at?, reference, method?: bank_transfer|upi|cash|other (default bank_transfer), notes?, allow_advance? }` → **201** `{ payment, outstanding_after }`. `reference` (UTR / transaction id, ≤100) is **required except for `cash`** and **unique per kitchen** (409 on a repeat, so a double-submit can't pay twice). **409** `{ error, outstanding }` if `amount` is more than is outstanding unless `allow_advance: true`. `paid_at` defaults to now, can't be in the future. List: `GET /admin/restaurant-payments?restaurant_id=&from=&to=&page=&limit=` → `{ payments, page, limit, total, total_amount }`.
- `POST /admin/restaurants/:id/adjustments { amount (+ owed to the kitchen, − deduction; non-zero), reason (≤255), related_order_id? }` (the order must belong to that kitchen) → **201** `{ adjustment, outstanding_after }`. List: `GET /admin/restaurant-adjustments?restaurant_id=&from=&to=&page=&limit=`.

**Profit per product** — `GET /admin/finance/products?from=&to=&category_id=` (**super_admin**; same IST placement-date basis as the P&L, no range = month so far) → `{ range, products, totals }`, one row per dish sold in delivered orders: `units_sold`; `customer_revenue` = Σ `unit_price × quantity` (after offers); `vendor_cost_total` = Σ the line's snapshotted `vendor_cost × quantity` (a line with none uses the commission estimate and counts in `estimated_units`, setting `has_estimated_cost`); `gross_profit = customer_revenue − vendor_cost_total`; `margin_percent = gross_profit / customer_revenue × 100`; plus the dish's **current** `current_price`, `current_effective_price`, `current_vendor_cost`, `current_margin`, `current_margin_percent`. Sorted by gross profit. CSV: `GET /admin/finance/products.csv`.

## Shipping rules (added 2026-10-29)

Client decision: **every delivery fee (what the customer pays) and every rider payout (what a rider earns per delivery) is admin-managed**, WooCommerce-style: *zones* and *rules* with conditions. `src/services/shippingRules.service.js` is the single source of truth. The customer fee is computed by the same engine in the **cart quote, order placement and the reject-cascade reassignment**, so a quote and the order can't disagree; the rider payout is computed by it at delivery (frozen on the order) and for `estimated_rider_payout`.

**Evaluation** (per kind): 1) **zone** = the first active zone (lowest `priority`) whose circle contains the **drop-off** (or whose pincode matches *when a pincode is known* — none is today, so v1 zones are circles only); none = the implicit "everywhere" (`zone_id` null). 2) **base** = the first matching `base` rule by priority in that zone's rules; if the zone has none, in the everywhere rules. `amount = flat + Σ per_km × (km of the trip inside each band)`; `after_kitchen_radius` (customer fee only) counts only the km beyond the kitchen's own `radius_km` (today's "free inside the radius"). 3) every matching **`add`** (flat and/or percent of the *running* amount), 4) every matching **`min`/`max`** clamp, 5) (customer fee only) any matching **`free`**, which zeroes the amount — so a minimum fee never undoes "free over ₹X". Zone rules run before everywhere rules; priority order within. Rounded to 2 dp at each step. If no active rule prices a trip the **old behaviour** answers (customer: free inside the radius then ₹5/km; rider: the legacy `rider_pay_config` formula), so a delivery is never left unpriced.

**Conditions** (all optional, ANDed; unknown keys are 400): `distance_km {min,max}` (the whole kitchen→drop-off trip), `order_value {min,max}` (`item_total` after dish offers, before GST and coupon), `time {days:[0-6], from:"HH:MM", to:"HH:MM"}` in **IST** (`REPORT_TZ_OFFSET_MINUTES`); `from > to` wraps midnight and a day means the day the window **starts**; `days` alone = the whole day. `min` inclusive, `max` exclusive. Rules can also carry `valid_from`/`valid_to`.

**Time basis**: the customer fee is evaluated at the order's **placement time** (quote = now; the reject-cascade reuses `orders.created_at`, so a reassignment can't flip a night surcharge); rider pay at **delivery time** (when the payout freezes); `estimated_rider_payout` at now. (A quote at 21:59:59 and an order at 22:00:01 can differ across a window boundary.)

**Charge by type**: `base {flat?, bands?:[{from_km,to_km|null,per_km}], after_kitchen_radius?}` (needs flat or bands; bands start at 0, are contiguous, don't overlap, only the last has `to_km` null) · `add {flat?, percent?}` (at least one) · `free {}` (customer_fee only) · `min {amount}` · `max {amount}`. Amounts 0–100000, percent 0–1000.

**Always priceable**: per kind there must always be an active, undated, **unconditional, everywhere** (`zone_id` null) base rule. Anything that would remove the last one (deactivate, delete, date it, add a condition, change its type, move it to a zone) is **409** `last_everywhere_base`; the rule list marks it `is_last_everywhere_base`.

**API** (reads and the preview: every admin role; every write: **super_admin**; errors `{ error, code? }`)
- Zones: `GET /admin/shipping/zones` → `{ zones }` by priority; `POST` `{ name, is_active?, match: { pincodes?, circles: [{lat,lng,radius_km}] } }` → 201 `{ zone }`; `PATCH /:id` (any of name/is_active/match); `DELETE /:id` (soft — its rules go with it); `POST /admin/shipping/zones/reorder { ids }` (every active zone, new order). A zone: `{ id, name, is_active, priority, match, created_at, updated_at }`. Circles need lat/lng in range and `radius_km` 0–100; pincodes are 6 digits; at least one of either.
- Rules: `GET /admin/shipping/rules?kind=&zone_id=` (`zone_id=null` for the everywhere rules) → `{ rules }` — **inactive and dated ones included**, deleted ones not; `POST` `{ kind, zone_id?, name, is_active?, type, conditions?, charge, valid_from?, valid_to? }` → 201 `{ rule }`; `PATCH /:id` (any of name/zone_id/is_active/type/conditions/charge/valid_from/valid_to; `kind` can't change); `DELETE /:id` (soft); `POST /admin/shipping/rules/reorder { kind, zone_id (or null), ids }` (every active rule of that kind + zone). A rule: `{ id, kind: customer_fee|rider_pay, zone_id, zone_name, name, is_active, priority, type, conditions, charge, valid_from, valid_to, is_in_effect_now, is_last_everywhere_base, created_by_admin_id, created_at, updated_at }`.
- `GET /admin/shipping/history?entity=rule|zone&kind=&rule_id=&page=&limit=` → `{ history: [{ id, entity, entity_id, kind, action: create|update|delete|reorder, before, after, admin_id, admin_name, created_at }], page, limit, total }` — an append-only audit of every change (zones too).
- `POST /admin/shipping/preview { kind, distance_km, order_value?, at?, zone_id? | dropoff: {lat,lng,pincode?}, restaurant_id? }` → `{ amount, zone, applied: [{ rule_id, name, type, effect: {before, after, delta} }], breakdown: { distance_km, chargeable_km, base_amount, base, steps }, warnings, fallback }` — the exact engine result for a hypothetical delivery. `restaurant_id` supplies the kitchen radius for `after_kitchen_radius` (without it the radius is treated as 0, with a warning).

**Seeded on deploy so nothing changes**: one customer base rule `{ bands: [0→∞ at ₹5/km], after_kitchen_radius: true }` (= the old fee), and the rider rules converted from the live `rider_pay_config` row: a base rule (flat `base_payout` + the per-km band, two bands when a tier was set), a `min` rule from `min_payout`, an `add` rule from `incentive_per_delivery`. One nuance: add rules run **before** min, so a non-zero incentive now counts toward the minimum (the live config has incentive 0, where payouts are identical).

**On orders**: `orders.delivery_fee` as before, plus `orders.delivery_fee_breakdown` (JSON: `source: "rules"|"legacy"`, zone, applied rules with before/after, base detail) — **admin-only** (`GET /admin/orders/:id` returns it parsed; customers, kitchens and riders never get it). A rider payout's frozen `rider_payout_breakdown` keeps every earlier key (filled when the base rule is the simple 1–2 band shape) and adds `source`, `zone` and `applied` (the rules that changed the amount). Later rule edits never touch a stored `delivery_fee` or a frozen payout.

**Retired / compatible**: `PUT /admin/settings/rider-pay` → **410**; `GET /admin/settings/rider-pay` → `{ settings | null, simple, formula, history (legacy rows), managed_at }`; `GET /riders/me/rate` → the simple numbers + `simple: true` while the rider rules are simple, otherwise `{ simple: false, formula }` (use `estimated_rider_payout` on the order).

## Rider payout account (added 2026-10-29)

Riders add their bank account (and optionally a UPI id) in the Rider app so admins can pay the weekly settlement.

- **Store**: `rider_bank_accounts` (one current account per rider) + `rider_bank_account_history` (append-only). The account number is **encrypted at rest** (AES-256-GCM, key `BANK_DATA_KEY`: 32 bytes as 64 hex chars or base64); only its **last 4 digits** are kept in the clear. There is **no plaintext fallback**: with no key set a save is refused. The history stores last-4s and non-secret fields only, never the full number. The full number is never logged and never reaches a rider, customer or kitchen response.
- **Rider** (rider token, **behind the verification gate** — an unapproved rider gets 403 `verification_required`): `PUT /riders/me/bank-account { account_holder_name, account_number, ifsc, bank_name?, upi_id? }` → **200 `{ rider }`** (exactly the `GET /riders/me` shape). `GET /riders/me` (and the `PATCH /riders/me` profile) carries `bank_account: null | { account_holder_name, account_number_last4, ifsc, bank_name, upi_id, updated_at }` — **masked, the app never gets the full number back**. The whole form is sent each time. Validation, 400 `{ error }`: holder 2–100 chars; account number — spaces and hyphens stripped, then 9–18 digits; IFSC trimmed + uppercased then `/^[A-Z]{4}0[A-Z0-9]{6}$/`; `bank_name` ≤ 100 (optional); `upi_id` optional `/^[\w.\-]{2,256}@[A-Za-z]{2,64}$/` (`null`/`""` clears an optional field). **503** `{ code: "bank_details_unavailable" }` when the server has no key (nothing is stored). Resubmitting an identical account is a 200 with no history row. **Changing an existing account** writes a history row and pushes the rider ("Payout account updated") — the account-takeover mitigation; there is deliberately no OTP re-check in v1.
- **Admin**: `GET /admin/riders/:id` gains `bank_account` — for **super_admin and ops** (who pay riders) `{ account_holder_name, account_number (FULL), account_number_last4, ifsc, bank_name, upi_id, updated_at }`; for **support** the masked form (no `account_number` key). If a stored number can't be decrypted (lost/rotated key) it reads `account_number: null` with `account_number_unavailable: true` and the masked fields still work. `bank_account_history: [{ id, action: create|update, changed_by: "rider", before: {account_holder_name, account_number_last4, ifsc, upi_id} | null, after: {...}, created_at }]` (newest first; every admin role, no full numbers). `GET /admin/riders` rows gain `has_bank_account`. Admin reads of the full number are **not** audited in v1.
- **Ops note**: set `BANK_DATA_KEY` in the server `.env` before use (`openssl rand -hex 32`) and **back it up** — without it saved account numbers can't be read back.

### Kitchen payout account (added 2026-10-30)

The kitchen equivalent, so admins can pay the vendor-cost settlement. Same secret handling, validation and messages as the rider account above (shared code: `services/restaurantBank.service.js` reuses `riderBank.service.js`'s crypto/validation).

- **Store**: `restaurant_bank_accounts` (one current account per kitchen) + `restaurant_bank_account_history` (append-only, last-4s only). Same `BANK_DATA_KEY`, no plaintext fallback (503 `bank_details_unavailable`).
- **Kitchen** (restaurant token, **behind the verification gate** — unlike `GET /restaurants/me`, this route is not `allowUnverified`): `PUT /restaurants/me/bank-account { account_holder_name, account_number, ifsc, bank_name?, upi_id? }` → **200 `{ restaurant }`** (exactly the `GET /restaurants/me` shape). `GET /restaurants/me` carries `bank_account: null | { account_holder_name, account_number_last4, ifsc, bank_name, upi_id, updated_at }` — masked, never the full number. Identical resubmit = 200, no history row. **Changing an existing account** writes a history row and pushes the kitchen ("Payout account updated", `data.type: "bank_account_updated"`).
- **Admin**: `GET /admin/restaurants/:id` gains `bank_account` (full `account_number` for **super_admin and ops**, masked for **support**; `account_number_unavailable: true` when it can't be decrypted) and `bank_account_history[]` (newest first: `{ id, action, changed_by, before, after, created_at }`, last-4s only). `GET /admin/restaurants` rows gain `has_bank_account`. Admin reads are not audited.

## Delivery availability: riders online + waiting orders (added 2026-10-30)

**Online rider** = `riders.status = 'active'` AND approved AND documents in order (when enforced) AND a known location (`last_known_lat/lng`). Suspended, unapproved, offline and "active but never sent a location" riders don't count. There is no staleness filter. **Free** = online and not on an `accepted` / `picked_up` / `on_the_way` order. One module decides both: `services/riderDispatch.service.js`.

**The gate (nobody online at all)**
- `POST /cart/quote` — when a kitchen can cook the cart but **no rider is online**: `valid: false`, `delivery_available: false`, `unavailable_reason: "no_riders_online"`, `reason: "No delivery partners are online right now. Please try again in a few minutes."`; the bill is still priced and `clubbable` stays true (so no Lock sheet). When deliverable: `delivery_available: true`, `unavailable_reason: null`. (An app that only reads `valid` + `reason` already blocks correctly.)
- `POST /orders` and `POST /orders/:id/reorder` — **409** `{ code: "no_riders_online", error: "<same message>" }`, checked **before** the order or the Razorpay order is created, so nobody is charged; COD, wallet and online payments alike.
- If every online rider is merely **busy**, ordering is allowed and the order waits for the first rider to free up.

**Waiting orders** (an `accepted` order with `rider_id` null — nobody was free at accept time). `assignWaitingOrders()` gives them, **oldest first**, each to the **nearest free online rider to its kitchen** (a rider handed one earlier in the same pass counts as busy), writing with a conditional `UPDATE … WHERE rider_id IS NULL`, serialised in-process, so two triggers can never double-assign. Orders created more than `WAITING_ORDER_MAX_AGE_HOURS` (default 6) ago are never auto-assigned — a forgotten accepted order must not grab a rider days later; an admin can still reassign it. Each assignment fires the usual "new delivery" push to the rider. Triggers: (1) `PATCH /riders/me/availability` → `active`; (2) `PATCH /riders/me/location` from an `active` rider; (3) right after `POST /orders/:id/delivered`; (4) a 30-second in-process tick (`riderDispatch.startTick()` from `server.js`, single PM2 instance). The rider's own `GET /orders` / `GET /riders/me/orders` include the order as soon as it is assigned.

## Kitchen service hours (added 2026-10-30)

One **daily window** per kitchen (the same every day), in **IST** (`REPORT_TZ_OFFSET_MINUTES`). `restaurants.opens_at` / `closes_at` (TIME); both null = always open (every existing kitchen); `closes_at` earlier than `opens_at` is an overnight window (`18:00`→`02:00`). Per-weekday schedules are a later step. `utils/serviceHours.js` is the only place the rule lives.

- **Admin** (`ops` / `super_admin`): `PATCH /admin/restaurants/:id { opens_at, closes_at }` — `"HH:MM"` (24 h, two digits) or `null`; both set or both cleared (400 otherwise), not equal. `GET /admin/restaurants/:id`, `GET /admin/restaurants` rows and the PATCH response return `opens_at`, `closes_at` (`"HH:MM"` or null) and `is_open_now` (boolean).
- **Routing**: a closed kitchen is skipped when matching a cart, so auto-routing and the reject-cascade move on to the next **open** kitchen (`routing.findCandidates` has `includeClosed`, default false). An order already placed before closing can still be accepted and prepared.
- **Catalog** (customer): a category is **never hidden** for being closed. `GET /categories?lat&lng` entries and `GET /categories/:id` → `category` carry `closed` (true only when it has in-range kitchens and none is open now) and `opens_at` (`"HH:MM"` IST, the earliest next opening among them; null unless closed). `GET /categories/:id/items` returns `{ items, closed, opens_at }` — items are still listed. (Without coordinates: `closed: false`.)
- **Cart quote**: kitchen closed → `valid: false`, `delivery_available: false`, `unavailable_reason: "kitchen_closed"`, `opens_at`, `reason: "This kitchen is closed right now. It opens at 7:00 PM."`; still priced. Closed wins over `no_riders_online` when both apply.
- **Orders**: `POST /orders` and reorder → **409** `{ code: "kitchen_closed", opens_at: "HH:MM", error: "This kitchen is closed right now. It opens at 7:00 PM." }`; nothing is created.

## Known gaps / placeholders

**Needs a real value from the client before go-live**
- Rider earning rate (₹8/km, ₹15/delivery) — `RIDER_RATE_PER_KM` / `RIDER_MIN_EARNING_PER_DELIVERY`.
- Invoice issuer legal name / GSTIN / address — `INVOICE_ISSUER_*` env vars (currently obvious placeholders).
- Restaurant/rider in-app agreement text (both apps have TODO(client) placeholder copy — see "In-app agreement + selfie verification" above).

**Not built**
- Dashboard/order/rider "Admin Panel" reads are all correctness-tested, but the customer campaign filters (`GET /admin/customers`) paginate **in-memory after the promo_opt_in JS filter** (it reads a JSON column that isn't cheaply filterable in SQL) — fine at current scale, would need revisiting if the customer base grows large.
- **Push notifications: sending is live (2026-09-27)**, direct to FCM (see Notifications); **promotional pushes shipped 2026-09-30** with the coupon system (`sendPromoBroadcast` in `push.service.js`, gated on `notification_prefs.promotions` — a different toggle from order-update pushes' `order_updates`). iOS needs an APNs key added in Firebase before iPhones can receive (Phase 1.5). Still missing: tapping an order-update push doesn't open the order in the apps yet, and reading Expo's delivery receipts (only the immediate send tickets are checked).
- **Both calling directions are unmasked real phone numbers** — rider's phone on `GET /orders/:id/rider` (customer→rider), and now customer's phone via `customer_phone` on `GET /orders`/`GET /orders/:id` (rider→customer) — needs a telephony proxy before real numbers are exchanged either way.
- **No saved payment methods** (saved cards / UPI handles) and **no direct server-side card charging** against live Razorpay.
- **No promotional credits** (welcome credit, late-delivery goodwill) — the ledger has no such reasons; only `order_payment` / `order_refund`.
- **No hybrid payment** (credits + UPI/card on one order) — `wallet` is all-or-nothing.
- **`GET /coupons/mine` does one eligibility check per candidate coupon** (a DB round trip or two each) rather than a single batched query — fine while the number of live coupons stays small (this is an admin-curated list, not user-generated), would need revisiting if that assumption stops holding.
- **A coupon is never applied to a clubbed cart's fallback split into two orders** — a deliberate scope cut, not an oversight; see "Coupons" above.
- Coupon discount math (percent applies to `item_total`, GST computed pre-discount, discount capped at `item_total`) is a documented default, **not confirmed by the client** — revisit if it doesn't match their expectation once real coupons go live.
- **JWT logout is client-side only** (no token blocklist).
- No `accepted_at` / `on_the_way_at` timestamps on orders (tracking shows times only for placed/picked-up/delivered/cancelled).
- No rate-limiting or body-size limits; no scheduled rider-settlement job; admin analytics beyond dashboard counts.
- `GET /categories`'s `clubPartnerIds` is platform-wide, not location-aware (use `/cart/quote` for the real answer).
