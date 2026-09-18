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

## Profile (`/profile`) — customer

| Method | Path | Body | Notes |
|---|---|---|---|
| GET | `/profile/me` | — | → `{ profile: { id, name, phone, email, photo_url, veg_only, wallet_balance, notification_prefs } }`. |
| PATCH | `/profile/me` | any of `{ name, email, photo_url }` | Phone isn't editable (it's the login identity). |
| PATCH | `/profile/preferences` | `{ veg_only }` | Cross-device veg-only sync. |
| PATCH | `/profile/default-address` | `{ address_id }` | Sets the default; returns the full address list. Equivalent to `PATCH /addresses/:id {is_default:true}`. |

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
| GET | `/categories` | public | → `{ categories: [{ id, name, blurb, image_url, prepTimeMinMinutes, prepTimeMaxMinutes, minOrder, clubPartnerIds }] }`. `clubPartnerIds` = other categories sharing ≥1 active restaurant platform-wide — a discovery **hint** only; the real location-aware club decision is `POST /cart/quote`. |
| POST | `/categories` | admin | `{ name, description?, image_url?, prep_time_min_minutes?, prep_time_max_minutes?, min_order_override? }`. |
| GET | `/categories/:id?lat=&lng=` | public | Category header + `sections: [{ title: "Popular", items }, { title: "More", items }]`. Popular = top 3 by rating count then average. lat/lng required (location-filtered, 7 km). |
| GET | `/categories/:categoryId/items?lat=&lng=` | public | Older flat-list shape of the same items. |
| GET | `/items/search?q=&veg=&lat=&lng=` | public | Name/description match across all categories, same location filter. `veg=true` → veg items only. |
| POST | `/items` | admin/restaurant | `{ category_id, name, description?, price, image_url?, is_veg? }`. Restaurants only for categories they're approved for. |
| PATCH | `/restaurants/:restaurantId/items/:itemId/availability` | restaurant (self) | `{ is_available }` — the stock toggle. |

Every item payload includes `avgRating` (1 decimal, or `null` if unrated) and `ratingCount`. There's no per-item rating submission — an item's rating is the average `restaurant_rating` over delivered orders containing it (how customers rated the kitchen that cooked it).

## Cart (`/cart`) — customer

| Method | Path | Body | Notes |
|---|---|---|---|
| POST | `/cart/quote` | `{ items: [{item_id, quantity}], delivery_lat, delivery_lng }` | Server-computed pricing **and the club/lock check** for the Lock/Club kitchen sheets — call it with the *proposed* cart (including "what if I add this item from another category"). Never persists, never reveals restaurant identity. Response: `{ valid, minOrderOk, categoryIds, clubbable, isClubbed, itemTotal, deliveryFee, cgstAmount, sgstAmount, grandTotal, reason }`. `clubbable:false` (no single kitchen nearby can serve the whole cart) → show the Lock sheet; that response has no price fields. 400 only for malformed input / >2 categories. |

## Payments (`/payments`) — customer

| Method | Path | Body | Notes |
|---|---|---|---|
| GET | `/payments/methods` | — | `{ methods: [{ id, label, enabled, balance? }] }` — `wallet` includes the Platter-credits balance. No saved cards/UPI handles yet (gap). |
| POST | `/payments/upi/initiate` | `{ order_id }` | Idempotent — returns the order's existing `razorpay_order_id` payment object if `POST /orders` already created one. |
| POST | `/payments/card/charge` | `{ order_id }` | Dev-stub mode (no Razorpay keys): auto-succeeds and marks the order paid. With real keys: **501** — use Razorpay Checkout + `POST /orders/:id/confirm-payment` instead (direct server-side card charging isn't built). |

## Orders (`/orders`)

| Method | Path | Auth | Body | Notes |
|---|---|---|---|---|
| POST | `/orders` | customer | `{ items: [{item_id, quantity}], delivery_lat, delivery_lng, delivery_address, payment_method }` | `payment_method` ∈ `upi`\|`card`\|`netbanking`\|`cod`\|`wallet`. Max 2 categories, min ₹50. **403 `{ error, blocking_order_id }` if the customer has an unresolved kitchen-rating gate** (see below). Routes to nearest capable restaurant; if no single restaurant serves a 2-category cart it splits into two orders (`{ message, orders: [...] }`); 409 if nothing can fulfil it. GST is `cgst_amount`+`sgst_amount` (2.5%+2.5% of `item_total`), included in `grand_total`. `wallet` debits the full amount immediately and marks it paid (402 + auto-cancel if balance is short); `cod` skips payment; others return a `payment` object. |
| POST | `/orders/:id/confirm-payment` | customer | `{ razorpay_payment_id, razorpay_signature }` | Signature verification auto-succeeds in dev stub. |
| POST | `/orders/:id/cancel` | customer | — | **Buffer-window rule (policy 2026-09-18):** only while status is `placed` (restaurant hasn't accepted) **and** within `ORDER_CANCEL_BUFFER_SECONDS` (default 120) of placing; else 409. Refunds to wallet if already paid. |
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
| POST | `/orders/:id/picked-up` | rider | — | Only from `accepted`. Sets the one-time `eta_minutes`. |
| POST | `/orders/:id/on-the-way` | rider | — | Only from `picked_up`. |
| POST | `/orders/:id/delivered` | rider | `{ cod_amount_collected? }` | Only from `on_the_way`. **Required and must exactly equal `grand_total` for COD** — creates the rider's COD wallet liability. |
| GET | `/orders` | customer/restaurant/rider | — | Own orders, each with `items: [{ name, quantity }]` (confirmed only). Restaurants only see `paid`/`cod` orders. |
| GET | `/orders/:id` | customer/restaurant/rider/admin | — | Full detail. Adds `cancelled` (bool), `riderRating`, `riderRatingComment`, `restaurantRating`, `restaurantRatingComment`, `restaurantRatingSkipped`, and `rider: { name, phone }` once assigned. |
| GET | `/orders/:id/status` | customer/restaurant/rider/admin | — | Lightweight poll target: `{ status, cancelled, eta_minutes, picked_up_at, delivered_at, cancelled_at, rider_assigned }`. |

**Rating gate.** A delivered order with no `restaurant_rating` and `restaurant_rating_skipped = false` blocks every new `POST /orders` (and reorder) with a 403 naming `blocking_order_id`, until `rate-restaurant` or `skip-restaurant-rating` is called for it. This is the real enforcement; the app's prompt is only UX.

Order `status` ∈ `placed`\|`accepted`\|`picked_up`\|`on_the_way`\|`delivered`\|`cancelled`. There is no `refunded` status — the history "REFUNDED" badge maps to `payment_status === "refunded"`.

## Wallet (`/wallet`) — customer or rider

| Method | Path | Notes |
|---|---|---|
| GET | `/wallet/balance` | `{ balance }`. |
| GET | `/wallet/ledger?limit=&offset=` | `{ ledger: [...] }`, newest first. `reason` ∈ `cod_collected`\|`settlement_payout`\|`settlement_deduction`\|`order_refund`\|`order_payment`\|`manual_adjustment`. |
| GET | `/wallet/me` | Combined `{ balance, history }` (kept for the Rider Portal). |

## Favorites (`/favorites`) — customer

| Method | Path | Notes |
|---|---|---|
| GET | `/favorites` | Favorited active items. |
| POST | `/favorites/:itemId` | Idempotent (re-favoriting isn't an error). |
| DELETE | `/favorites/:itemId` | |

## Notifications (`/notifications`) — customer

| Method | Path | Body | Notes |
|---|---|---|---|
| POST | `/notifications/register-device` | `{ token, platform: 'android'\|'ios' }` | Upserts the FCM token. |
| PATCH | `/notifications/settings` | any of `{ order_updates, promotions }` | Merges into existing prefs → `{ notification_prefs }`. Storage only — nothing sends pushes yet (see gaps). |

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
| PATCH | `/riders/me/availability` | `{ status: 'active'\|'inactive' }` | |
| PATCH | `/riders/me/location` | `{ lat, lng }` | Foreground-only ping. |
| GET | `/riders/me/orders` | — | Active assigned deliveries. |

## Admin (`/admin`) — admin only

| Method | Path | Notes |
|---|---|---|
| GET | `/admin/dashboard` | `{ totalOrders, activeRestaurants, activeRiders, pendingOrders }`. |
| GET | `/admin/orders?status=` | Latest 200. |
| GET | `/admin/riders` | |
| POST | `/admin/riders/:riderId/settle` | Manual settlement (no cron yet). |

---

## Known gaps / placeholders

**Needs a real value from the client before go-live**
- Cancellation buffer (120 s) is a placeholder — `ORDER_CANCEL_BUFFER_SECONDS`.
- Rider earning rate (₹8/km, ₹15/delivery) — `RIDER_RATE_PER_KM` / `RIDER_MIN_EARNING_PER_DELIVERY`.
- Invoice issuer legal name / GSTIN / FSSAI / address — `INVOICE_ISSUER_*` env vars (currently obvious placeholders).

**Not built**
- **Push notifications are never actually sent** — device tokens and prefs are stored, but there's no FCM sender, so order-status changes don't notify anyone yet (the design promises "every step arrives as a notification").
- **Rider phone is unmasked** on `GET /orders/:id/rider` — needs a telephony proxy before real riders handle real customer numbers.
- **No saved payment methods** (saved cards / UPI handles) and **no direct server-side card charging** against live Razorpay.
- **No promotional credits** (welcome credit, late-delivery goodwill) — the ledger has no such reasons; only `order_payment` / `order_refund`.
- **No hybrid payment** (credits + UPI/card on one order) — `wallet` is all-or-nothing.
- **JWT logout is client-side only** (no token blocklist).
- No `accepted_at` / `on_the_way_at` timestamps on orders (tracking shows times only for placed/picked-up/delivered/cancelled).
- No Razorpay webhook; no rate-limiting or body-size limits; no scheduled rider-settlement job; admin analytics beyond dashboard counts.
- `GET /categories`'s `clubPartnerIds` is platform-wide, not location-aware (use `/cart/quote` for the real answer).
