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
| POST | `/auth/otp/request` | — | `{ phone, purpose }` | `purpose`: `login`\|`signup`\|`restaurant_login`\|`rider_login`. 10-digit phone. Response `{ message, expires_in_minutes }`. Dev: OTP prints to server console as `[dev-sms] OTP for <phone>: <code>`. |
| POST | `/auth/otp/verify` | — | `{ phone, otp, purpose, name? }` | → `{ token, user: { id, phone, name, type } }`. First verify auto-creates customer/rider accounts. `restaurant_login` for an un-onboarded phone → **404** (restaurants are admin-onboarded only). 5 attempts max (429), 5-min expiry. |
| POST | `/auth/admin/login` | — | `{ email, password }` | → `{ token, user: { id, name, email, role, type } }`. 401 on bad credentials. |
| GET | `/auth/session` | any | — | Validates a persisted token on app boot → `{ user }`. 401 if the token is missing/expired or the account no longer exists. |
| POST | `/auth/logout` | any | `{ device_token? }` | JWTs are stateless — logout is the client discarding its token. This only deregisters the push `device_token` if one is sent. |

### Dev-only: read the last OTP

`GET /dev/last-otp?phone=<10-digit>` → `{ phone, otp, requestedAt }` (404 if no OTP was requested for that phone since the server started). Lets testers and other tooling fetch the dev OTP without the server console. In-memory only, and the router is **not mounted at all** when `NODE_ENV=production`.

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
| GET | `/payments/methods` | — | `{ methods: [{ id, label, enabled, balance? }], razorpay_key_id }` — `wallet` includes the Platter-credits balance. `razorpay_key_id` is the **public** key_id (safe to ship to the client — never the secret), `null` until `RAZORPAY_KEY_ID`/`RAZORPAY_KEY_SECRET` are both set in `.env`. No saved cards/UPI handles yet (gap). |
| POST | `/payments/upi/initiate` | `{ order_id }` | Idempotent — returns the order's existing `razorpay_order_id` payment object if `POST /orders` already created one, now including `dev_stub`. |
| POST | `/payments/card/charge` | `{ order_id }` | Dev-stub mode (no Razorpay keys): auto-succeeds and marks the order paid. With real keys: **501** — use Razorpay Checkout + `POST /orders/:id/confirm-payment` instead (direct server-side card charging isn't built). |

**Real Razorpay flow** (once `RAZORPAY_KEY_ID`/`RAZORPAY_KEY_SECRET` are set): `POST /orders` (for `upi`/`card`/`netbanking`) creates a **real** Razorpay Order via the Orders API and returns `payment: { id, amount, currency, status, dev_stub: false, ... }` — `id` is the real `razorpay_order_id` to open Checkout with. `POST /orders/:id/confirm-payment` then verifies the signature server-side: `HMAC_SHA256(order.razorpay_order_id + "|" + razorpay_payment_id, RAZORPAY_KEY_SECRET)` must equal `razorpay_signature`, else 400. **`razorpay_order_id` always comes from the order row the server itself created and stored at placement — never trusted from the request body** — even if the client sends one (harmless either way), only the server's own stored value is used, so a client can't point verification at a different order's payment. Toggling `RAZORPAY_KEY_ID`/`RAZORPAY_KEY_SECRET` unset↔set is the only thing that switches dev-stub↔real mode anywhere in the payment flow — no code changes. No webhook yet (known gap, below) — this client-confirmed signature check is the only verification path.

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
| POST | `/uploads/image` | `multipart/form-data` with exactly **one file field named `image`**. Accepts **JPEG, PNG or WebP**, identified by the file's actual bytes (the client's Content-Type and file name are ignored, so a renamed text file or an SVG is rejected). Max **2 MB**. → **201** `{ url }` — an **absolute** URL like `http://192.168.1.16:4000/uploads/<uuid>.jpg`, ready to send as `image_url` to `POST /items`. |

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
| GET | `/admin/riders/:id/agreement-selfie` | Streams the raw selfie bytes (`Content-Type` set from the stored image, no wrapper JSON). 404 `{ error }` if this rider never accepted in-app (exempt seed/dev row, or hasn't onboarded since the feature shipped). See "In-app agreement + selfie verification" below. |
| PATCH | `/admin/riders/:id` | body `{ status: 'active'\|'inactive'\|'suspended' }`. Suspended is already blocked from new auto-assignment (`autoAssignRider` only considers `active`) and from logging back in (see below). |
| POST | `/admin/riders/:riderId/settle` | Unchanged — manual settlement trigger (no cron yet). |
| GET | `/admin/settlements?rider_id=` | Settlement history straight from `wallet_ledger` (`settlement_payout`/`settlement_deduction` rows), joined with rider name/phone. |

### Restaurants

| Method | Path | Notes |
|---|---|---|
| GET | `/admin/restaurants` | Now paginated; each row adds `order_count`, `agreementAcceptedAt`, `agreementVersion`. |
| GET | `/admin/restaurants/:id` | `{ restaurant, categories: [{id,name}], order_count, rating: {avg, count}, commission_config_history }`. `restaurant` includes `agreementAcceptedAt`/`agreementVersion`. `rating` is the average `restaurant_rating` over this restaurant's delivered orders (same source as item ratings). |
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

### Login/ordering enforcement (not an endpoint — a cross-cutting rule)

A **blocked customer** or a **suspended rider/restaurant** cannot get a new session (`POST /auth/otp/verify` returns 403 even with the correct OTP) and, for a customer specifically, cannot place an order even on an already-issued token (`POST /orders` re-checks `users.status`). A suspended rider was already excluded from new auto-assignment (routing only considers `status: 'active'` riders); this closes the login-side gap that let a suspended/blocked account keep using a token issued before the change.

## In-app agreement + selfie verification (added 2026-09-29)

On top of the physical signed agreement, restaurants and riders must accept an in-app agreement with a live selfie proving it was the actual owner/rider who accepted it. **Applies to accounts onboarded from the migration onward only** — every pre-existing `restaurants`/`riders` row was backfilled (`agreement_accepted_at = created_at`, `agreement_version = CURRENT_AGREEMENT_VERSION`) in the same migration that added the columns, so seeded/dev accounts are permanently exempt without a separate flag. No paid face-match/liveness API (out of scope before Oct 2) — camera-only capture (client-enforced, not server-checked) plus this server-recorded timestamp is the evidentiary trail; an admin reviews the selfie by eye via the streaming endpoints above.

- **Signal each app needs**: `GET /restaurants/me` / `GET /riders/me` → `agreementRequired: boolean`, true when `agreement_accepted_at IS NULL` or `agreement_version < CURRENT_AGREEMENT_VERSION`. Bumping the `CURRENT_AGREEMENT_VERSION` env var re-gates every account whose stored version is behind, with no data migration needed.
- **Accepting**: `POST /restaurants/me/accept-agreement` / `POST /riders/me/accept-agreement` — multipart field `selfie` (jpeg/png/webp by magic bytes, 2MB cap) + field `agreement_version` (the version the app is currently showing). **409** if that doesn't match `CURRENT_AGREEMENT_VERSION` (blocks a stale app build from accepting an outdated version). 400 if the file or version field is missing/malformed. On success: 200 `{ agreementAcceptedAt }` (ISO string) — the timestamp is always the **server's own clock**, never anything the client sends.
- **Storage**: the selfie is saved to `agreement_selfie_path` — an **internal path, never a public URL**. Disk mode: a dedicated `agreement-selfies/` directory that (unlike `uploads/`) is never mounted by `express.static`. S3 mode: key-prefixed `agreement-selfies/` in the same bucket as catalog photos — **note this bucket's policy grants public `s3:GetObject` on every key**, so this is "never linked anywhere" rather than cryptographically private; revisit with a second, non-public bucket if that needs to be airtight.
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

## Known gaps / placeholders

**Needs a real value from the client before go-live**
- Rider earning rate (₹8/km, ₹15/delivery) — `RIDER_RATE_PER_KM` / `RIDER_MIN_EARNING_PER_DELIVERY`.
- Invoice issuer legal name / GSTIN / FSSAI / address — `INVOICE_ISSUER_*` env vars (currently obvious placeholders).
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
- No Razorpay webhook; no rate-limiting or body-size limits; no scheduled rider-settlement job; admin analytics beyond dashboard counts.
- `GET /categories`'s `clubPartnerIds` is platform-wide, not location-aware (use `/cart/quote` for the real answer).
