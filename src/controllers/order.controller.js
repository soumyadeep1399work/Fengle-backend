const crypto = require("crypto");
const db = require("../config/db");
const routing = require("../services/routing.service");
const commission = require("../services/commission.service");
const payment = require("../services/payment.service");
const wallet = require("../services/wallet.service");
const { computeTax } = require("../services/tax.service");
const invoice = require("../services/invoice.service");
const { haversineDistanceKm } = require("../utils/geo");
const { notifyLater } = require("../services/push.service");
const orderPush = require("../services/orderNotifications.service");

const MIN_ORDER_VALUE = 50;
// How long after placing an order a customer can still cancel it for free —
// see CLAUDE.md's cancellation policy note (2026-09-18: this buffer rule
// replaces the earlier "blocked only after Start Preparing" rule; the 60s
// value was confirmed by the user on 2026-09-21).
const CANCEL_BUFFER_SECONDS = Number(process.env.ORDER_CANCEL_BUFFER_SECONDS) || 60;

/**
 * When the customer's cancel window closes (ISO), so the app can drive its
 * countdown from the server. null once the order can no longer be cancelled
 * (restaurant accepted, cancelled, delivered...) — matches cancelOrder's
 * rule of "still `placed` AND within the buffer". A timestamp in the past
 * for a still-`placed` order just means the window has lapsed.
 */
function cancellableUntil(order) {
  if (order.status !== "placed") return null;
  return new Date(new Date(order.created_at).getTime() + CANCEL_BUFFER_SECONDS * 1000).toISOString();
}

const withCancelInfo = (order) => ({ ...order, cancellable_until: cancellableUntil(order) });

// 4-digit code shown to the customer and read aloud to the rider at drop-off —
// see the "delivery_otp" column/migration and markDelivered below.
function generateDeliveryOtp() {
  return String(crypto.randomInt(0, 10000)).padStart(4, "0");
}

/**
 * The delivery code is how the customer proves to the rider it's really
 * their order — it must never reach a restaurant, rider, or admin view of the
 * same order (they're the ones who have to ask the customer for it).
 */
function scrubDeliveryOtp(orderFields, requesterType) {
  if (requesterType === "customer") return orderFields;
  const { delivery_otp, ...rest } = orderFields;
  return rest;
}

/**
 * Server-side enforcement of the "resolve your last kitchen rating before
 * ordering again" gate — the client-side prompt is just UX, this is the
 * real check. A delivered order with no restaurant_rating AND not skipped
 * blocks every new POST /orders (and reorder) until rate-restaurant or
 * skip-restaurant-rating is called for it.
 */
async function findPendingRatingGateOrderId(customerId) {
  const blocking = await db("orders")
    .where({ customer_id: customerId, status: "delivered" })
    .whereNull("restaurant_rating")
    .andWhere("restaurant_rating_skipped", false)
    .orderBy("delivered_at", "asc")
    .first();
  return blocking ? blocking.id : null;
}

// ---------------------------------------------------------------------------
// Placement
// ---------------------------------------------------------------------------

/**
 * POST /orders
 * body: { items: [{item_id, quantity}], delivery_lat, delivery_lng, delivery_address, payment_method }
 *
 * Handles single-category orders, clubbed orders (2 categories, same
 * restaurant), and the clubbed-cart fallback split (Section 4, point 5) when
 * no single restaurant can fulfil both categories together.
 */
async function placeOrder(req, res) {
  const customerId = req.auth.id;
  const { items, delivery_lat, delivery_lng, delivery_address, payment_method } = req.body;

  // Admin-blocked customers can still be holding a valid (not-yet-expired)
  // token, so the login gate alone isn't enough — check again at the point
  // that actually costs the platform money.
  const customer = await db("users").where({ id: customerId }).first();
  if (!customer || customer.status === "blocked") {
    return res.status(403).json({ error: "Your account has been suspended. Contact support." });
  }

  const pendingRatingOrderId = await findPendingRatingGateOrderId(customerId);
  if (pendingRatingOrderId) {
    return res.status(403).json({
      error: "Please rate or skip rating your last kitchen before placing a new order",
      blocking_order_id: pendingRatingOrderId,
    });
  }

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: "items array is required" });
  }
  if (delivery_lat == null || delivery_lng == null || !delivery_address) {
    return res.status(400).json({ error: "delivery_lat, delivery_lng and delivery_address are required" });
  }
  if (!["upi", "card", "netbanking", "cod", "wallet"].includes(payment_method)) {
    return res.status(400).json({ error: "Invalid payment_method" });
  }

  // Resolve items -> category + price (never trust client-supplied prices)
  const itemIds = items.map((i) => i.item_id);
  const itemRows = await db("items").whereIn("id", itemIds).andWhere({ is_active: true });
  if (itemRows.length !== itemIds.length) {
    return res.status(400).json({ error: "One or more items are invalid or inactive" });
  }
  const itemById = Object.fromEntries(itemRows.map((r) => [r.id, r]));

  const cartItems = items.map((i) => ({
    itemId: i.item_id,
    categoryId: itemById[i.item_id].category_id,
    name: itemById[i.item_id].name, // snapshotted onto order_items so later renames don't rewrite history
    quantity: i.quantity,
    unitPrice: Number(itemById[i.item_id].price),
  }));

  const categoryIds = [...new Set(cartItems.map((i) => i.categoryId))];
  if (categoryIds.length > 2) {
    return res.status(400).json({ error: "An order can include at most 2 categories (clubbed orders only)" });
  }

  const itemTotal = cartItems.reduce((sum, i) => sum + i.unitPrice * i.quantity, 0);
  if (itemTotal < MIN_ORDER_VALUE) {
    return res.status(400).json({ error: `Minimum order value is ₹${MIN_ORDER_VALUE}` });
  }

  const routingInput = {
    items: cartItems.map((i) => ({ itemId: i.itemId, categoryId: i.categoryId })),
    customerLat: Number(delivery_lat),
    customerLng: Number(delivery_lng),
  };

  const { match, cascadeAttempts } = await routing.findRestaurantForCart(routingInput);

  if (match) {
    const order = await createOrderForRestaurant({
      customerId, restaurant: match.restaurant, distanceKm: match.distanceKm,
      cartItems, deliveryLat: delivery_lat, deliveryLng: delivery_lng,
      deliveryAddress: delivery_address, paymentMethod: payment_method,
      isClubbed: categoryIds.length === 2, cascadeAttempts,
    });
    const result = await withPaymentOrder(order, payment_method);
    if (result.error) return res.status(result.status).json({ error: result.error });
    notifyRestaurantIfVisible(result.order);
    return res.status(201).json({ ...result, order: withCancelInfo(result.order) });
  }

  // No single restaurant could fulfil the full (possibly clubbed) cart.
  if (categoryIds.length === 2) {
    const orders = await attemptClubbedFallbackSplit({
      customerId, cartItems, categoryIds, routingInput,
      deliveryLat: delivery_lat, deliveryLng: delivery_lng, deliveryAddress: delivery_address, paymentMethod: payment_method,
    });
    if (orders) {
      const results = [];
      for (const o of orders) {
        const result = await withPaymentOrder(o, payment_method);
        if (result.error) {
          // Don't leave the customer charged for only one half of the pair.
          await Promise.all(results.map((r) => reverseWalletPaymentIfAny(r, payment_method)));
          return res.status(result.status).json({ error: result.error });
        }
        results.push(result);
      }
      results.forEach((r) => notifyRestaurantIfVisible(r.order));
      return res.status(201).json({
        message: "These items are being sent as two separate orders since no single kitchen could prepare both.",
        orders: results.map((r) => ({ ...r, order: withCancelInfo(r.order) })),
      });
    }
  }

  return res.status(409).json({ error: "No restaurant is currently able to fulfil this order. Please try again shortly." });
}

/**
 * Section 4, point 5: if no single restaurant can serve a clubbed cart, fall
 * back to two separate single-category orders, each independently routed.
 * Returns null (not partial results) if either half can't be fulfilled —
 * caller treats that as a full failure rather than silently dropping items.
 */
async function attemptClubbedFallbackSplit({ customerId, cartItems, categoryIds, routingInput, deliveryLat, deliveryLng, deliveryAddress, paymentMethod }) {
  const [catA, catB] = categoryIds;
  const itemsA = cartItems.filter((i) => i.categoryId === catA);
  const itemsB = cartItems.filter((i) => i.categoryId === catB);

  const [resultA, resultB] = await Promise.all([
    routing.findRestaurantForCart({ items: itemsA.map((i) => ({ itemId: i.itemId, categoryId: i.categoryId })), customerLat: routingInput.customerLat, customerLng: routingInput.customerLng }),
    routing.findRestaurantForCart({ items: itemsB.map((i) => ({ itemId: i.itemId, categoryId: i.categoryId })), customerLat: routingInput.customerLat, customerLng: routingInput.customerLng }),
  ]);

  if (!resultA.match || !resultB.match) return null;

  const orderA = await createOrderForRestaurant({
    customerId, restaurant: resultA.match.restaurant, distanceKm: resultA.match.distanceKm,
    cartItems: itemsA, deliveryLat, deliveryLng, deliveryAddress, paymentMethod,
    isClubbed: false, cascadeAttempts: resultA.cascadeAttempts,
  });
  const orderB = await createOrderForRestaurant({
    customerId, restaurant: resultB.match.restaurant, distanceKm: resultB.match.distanceKm,
    cartItems: itemsB, deliveryLat, deliveryLng, deliveryAddress, paymentMethod,
    isClubbed: false, cascadeAttempts: resultB.cascadeAttempts,
  });

  return [orderA, orderB];
}

/**
 * Creates one order + its order_items rows for a matched restaurant, inside a transaction.
 */
async function createOrderForRestaurant({ customerId, restaurant, distanceKm, cartItems, deliveryLat, deliveryLng, deliveryAddress, paymentMethod, isClubbed, cascadeAttempts }) {
  return db.transaction(async (trx) => {
    const itemTotal = cartItems.reduce((sum, i) => sum + i.unitPrice * i.quantity, 0);
    const deliveryFee = routing.computeDeliveryFee(distanceKm, restaurant);
    const commissionAmount = commission.computeCommission(itemTotal, restaurant);
    const { cgstAmount, sgstAmount } = computeTax(itemTotal);
    const grandTotal = Number((itemTotal + deliveryFee + cgstAmount + sgstAmount).toFixed(2));

    const [orderId] = await trx("orders").insert({
      customer_id: customerId,
      restaurant_id: restaurant.id,
      status: "placed",
      is_clubbed: isClubbed,
      cascade_attempts: cascadeAttempts || 1,
      delivery_lat: deliveryLat,
      delivery_lng: deliveryLng,
      delivery_address: deliveryAddress,
      item_total: itemTotal,
      delivery_fee: deliveryFee,
      commission_amount: commissionAmount,
      cgst_amount: cgstAmount,
      sgst_amount: sgstAmount,
      grand_total: grandTotal,
      payment_method: paymentMethod,
      payment_status: "pending",
      delivery_otp: generateDeliveryOtp(),
    });

    await trx("order_items").insert(
      cartItems.map((i) => ({
        order_id: orderId,
        item_id: i.itemId,
        item_name: i.name,
        category_id: i.categoryId,
        quantity: i.quantity,
        unit_price: i.unitPrice,
        subtotal: Number((i.unitPrice * i.quantity).toFixed(2)),
      }))
    );

    return trx("orders").where({ id: orderId }).first();
  });
}

/**
 * Returns either { order, payment } on success or { error, status } on
 * failure — callers check `.error` rather than relying on a throw, matching
 * every other controller's style (Express 4 here doesn't auto-catch async
 * rejections into the error middleware).
 */
async function withPaymentOrder(order, paymentMethod) {
  if (paymentMethod === "cod") {
    // No upfront payment gateway step for COD — restaurant sees it immediately.
    return { order, payment: null };
  }

  if (paymentMethod === "wallet") {
    // Platter credits: paid in full from the customer's wallet balance at
    // placement, no gateway involved (mirrors COD's "no gateway" shape, but
    // debits immediately since credits are our own liability, not cash).
    const balance = await wallet.getBalance("customer", order.customer_id);
    if (balance < Number(order.grand_total)) {
      await db("orders").where({ id: order.id }).update({ status: "cancelled", cancelled_at: new Date() });
      return {
        error: `Insufficient Platter credits (₹${balance.toFixed(2)} available, ₹${order.grand_total} required) for this order`,
        status: 402,
      };
    }

    await wallet.recordEntry({
      ownerType: "customer",
      ownerId: order.customer_id,
      entryType: "debit",
      amount: Number(order.grand_total),
      reason: "order_payment",
      relatedOrderId: order.id,
      notes: `Paid via Platter credits for order #${order.id}`,
    });
    await db("orders").where({ id: order.id }).update({ payment_status: "paid" });
    const updated = await db("orders").where({ id: order.id }).first();
    return { order: updated, payment: null };
  }

  const paymentOrder = await payment.createPaymentOrder(order.grand_total, order.id);
  await db("orders").where({ id: order.id }).update({ razorpay_order_id: paymentOrder.id });
  return { order, payment: paymentOrder };
}

// A kitchen only sees paid or COD orders, so an online-payment order is
// announced to it later, from confirmPayment.
function notifyRestaurantIfVisible(order) {
  if (orderPush.isVisibleToRestaurant(order)) notifyLater(() => orderPush.newOrderForRestaurant(order.id));
}

/**
 * Undoes a successful wallet debit for one order in a clubbed-fallback split
 * when its sibling order's payment fails — keeps the pair atomic from the
 * customer's point of view (never charged for only half a clubbed cart).
 */
async function reverseWalletPaymentIfAny(result, paymentMethod) {
  if (paymentMethod !== "wallet" || result.error) return;
  await wallet.recordEntry({
    ownerType: "customer",
    ownerId: result.order.customer_id,
    entryType: "credit",
    amount: Number(result.order.grand_total),
    reason: "manual_adjustment",
    relatedOrderId: result.order.id,
    notes: `Reversed: paired clubbed-split order failed payment (order #${result.order.id})`,
  });
  await db("orders").where({ id: result.order.id }).update({ status: "cancelled", cancelled_at: new Date(), payment_status: "refunded" });
}

/**
 * POST /orders/:id/confirm-payment
 * body: { razorpay_payment_id, razorpay_signature }
 */
async function confirmPayment(req, res) {
  const { id } = req.params;
  const { razorpay_payment_id, razorpay_signature } = req.body;

  const order = await db("orders").where({ id }).first();
  if (!order) return res.status(404).json({ error: "Order not found" });
  if (Number(order.customer_id) !== Number(req.auth.id)) return res.status(403).json({ error: "Not your order" });

  const valid = payment.verifyPaymentSignature({
    razorpayOrderId: order.razorpay_order_id,
    razorpayPaymentId: razorpay_payment_id,
    razorpaySignature: razorpay_signature,
  });
  if (!valid) return res.status(400).json({ error: "Payment verification failed" });

  await db("orders").where({ id }).update({
    payment_status: "paid",
    razorpay_payment_id,
  });

  // Paid now, so the kitchen can see it. Skip if it was already paid (a retry).
  if (order.payment_status !== "paid" && order.status === "placed") {
    notifyLater(() => orderPush.newOrderForRestaurant(order.id));
  }
  res.json({ message: "Payment confirmed" });
}

// ---------------------------------------------------------------------------
// Restaurant actions
// ---------------------------------------------------------------------------

/**
 * POST /orders/:id/accept
 * body: { unavailable_item_ids?: number[] }
 *
 * Supports partial unavailability at accept-time (Section 4): restaurant can
 * accept while flagging specific items it can no longer fulfil. Those items
 * are dropped, the bill is adjusted, and the difference is refunded to the
 * customer's wallet — rather than cascading part of a clubbed order elsewhere.
 */
async function acceptOrder(req, res) {
  const { id } = req.params;
  const { unavailable_item_ids = [] } = req.body;
  const restaurantId = req.auth.id;

  const order = await db("orders").where({ id }).first();
  if (!order) return res.status(404).json({ error: "Order not found" });
  if (Number(order.restaurant_id) !== Number(restaurantId)) return res.status(403).json({ error: "Not your order" });
  if (order.status !== "placed") return res.status(409).json({ error: `Cannot accept an order in status '${order.status}'` });

  let refundAmount = 0;
  await db.transaction(async (trx) => {

    if (unavailable_item_ids.length > 0) {
      const orderItems = await trx("order_items").where({ order_id: id }).whereIn("item_id", unavailable_item_ids);
      const droppedSubtotal = orderItems.reduce((sum, oi) => sum + Number(oi.subtotal), 0);

      await trx("order_items").where({ order_id: id }).whereIn("item_id", unavailable_item_ids)
        .update({ status: "dropped_unavailable" });

      // Recompute tax from the new item_total rather than subtracting a
      // proportional slice — keeps CGST/SGST always consistent with the
      // taxable value actually left on the bill.
      const newItemTotal = Number(order.item_total) - droppedSubtotal;
      const { cgstAmount, sgstAmount } = computeTax(newItemTotal);
      const newGrandTotal = Number((newItemTotal + Number(order.delivery_fee) + cgstAmount + sgstAmount).toFixed(2));
      refundAmount = Number((Number(order.grand_total) - newGrandTotal).toFixed(2));

      await trx("orders").where({ id }).update({
        item_total: newItemTotal,
        cgst_amount: cgstAmount,
        sgst_amount: sgstAmount,
        grand_total: newGrandTotal,
        status: "accepted",
      });
    } else {
      await trx("orders").where({ id }).update({ status: "accepted" });
    }

    if (refundAmount > 0 && order.payment_status === "paid") {
      await wallet.recordCustomerRefund(order.customer_id, order.id, refundAmount, "Item(s) unavailable at accept time", trx);
    }
  });

  await autoAssignRider(id);
  notifyLater(() => orderPush.orderAccepted(id, order.payment_status === "paid" ? refundAmount : 0));

  const updated = await db("orders").where({ id }).first();
  res.json({ order: updated });
}

/**
 * POST /orders/:id/start-preparing — explicit trigger that closes the
 * cancellation window (CLAUDE.md: "not a timer guess").
 */
async function startPreparing(req, res) {
  const { id } = req.params;
  const order = await db("orders").where({ id }).first();
  if (!order) return res.status(404).json({ error: "Order not found" });
  if (Number(order.restaurant_id) !== Number(req.auth.id)) return res.status(403).json({ error: "Not your order" });
  if (order.status !== "accepted") return res.status(409).json({ error: "Order must be accepted before preparation can start" });

  await db("orders").where({ id }).update({ preparation_started_at: new Date() });
  res.json({ message: "Preparation started" });
}

/**
 * POST /orders/:id/mark-ready — the restaurant's "Mark ready" button: food is
 * ready for the rider to collect. A signal only (sets ready_at) — it doesn't
 * change `status` and rider pickup isn't blocked on it. Idempotent: calling it
 * again keeps the original timestamp.
 */
async function markReady(req, res) {
  const { id } = req.params;
  const order = await db("orders").where({ id }).first();
  if (!order) return res.status(404).json({ error: "Order not found" });
  if (Number(order.restaurant_id) !== Number(req.auth.id)) return res.status(403).json({ error: "Not your order" });
  if (order.status !== "accepted") return res.status(409).json({ error: "Order must be accepted (and not yet picked up) to be marked ready" });

  if (!order.ready_at) await db("orders").where({ id }).update({ ready_at: new Date() });
  // Re-read so the response is exactly what's stored (TIMESTAMP columns keep
  // whole seconds) — otherwise the first call and every later one would differ.
  const { ready_at } = await db("orders").where({ id }).select("ready_at").first();
  res.json({ message: "Marked ready", ready_at: new Date(ready_at).toISOString() });
}

/**
 * POST /orders/:id/reject — auto-cascades to the next candidate restaurant.
 * If none remain within range, the order is cancelled and (if paid) refunded.
 */
async function rejectOrder(req, res) {
  const { id } = req.params;
  const restaurantId = req.auth.id;

  const order = await db("orders").where({ id }).first();
  if (!order) return res.status(404).json({ error: "Order not found" });
  if (Number(order.restaurant_id) !== Number(restaurantId)) return res.status(403).json({ error: "Not your order" });
  if (order.status !== "placed") return res.status(409).json({ error: `Cannot reject an order in status '${order.status}'` });

  const orderItems = await db("order_items").where({ order_id: id });
  const routingInput = {
    items: orderItems.map((oi) => ({ itemId: oi.item_id, categoryId: oi.category_id })),
    customerLat: Number(order.delivery_lat),
    customerLng: Number(order.delivery_lng),
  };

  const { allCandidates } = await routing.findRestaurantForCart(routingInput);
  const nextCandidate = allCandidates.find((c) => c.missingItemIds.length === 0 && c.restaurant.id !== Number(restaurantId));

  if (nextCandidate) {
    const commissionAmount = commission.computeCommission(Number(order.item_total), nextCandidate.restaurant);
    const deliveryFee = routing.computeDeliveryFee(nextCandidate.distanceKm, nextCandidate.restaurant);
    await db("orders").where({ id }).update({
      restaurant_id: nextCandidate.restaurant.id,
      commission_amount: commissionAmount,
      delivery_fee: deliveryFee,
      grand_total: Number((Number(order.item_total) + deliveryFee + Number(order.cgst_amount) + Number(order.sgst_amount)).toFixed(2)),
      cascade_attempts: (order.cascade_attempts || 1) + 1,
      status: "placed", // re-enters the queue for the new restaurant
    });
    notifyRestaurantIfVisible(order);
    return res.json({ message: "Order reassigned to next available restaurant", reassigned: true });
  }

  // Nobody else can take it — cancel and refund if paid.
  await db.transaction(async (trx) => {
    await trx("orders").where({ id }).update({ status: "cancelled", cancelled_at: new Date() });
    if (order.payment_status === "paid") {
      await wallet.recordCustomerRefund(order.customer_id, order.id, Number(order.grand_total), "No restaurant available to fulfil order", trx);
      await trx("orders").where({ id }).update({ payment_status: "refunded" });
    }
  });
  notifyLater(() => orderPush.orderCancelledBySystem(id));
  res.json({ message: "No further restaurants available — order cancelled and refunded if paid", reassigned: false });
}

// ---------------------------------------------------------------------------
// Customer actions
// ---------------------------------------------------------------------------

/**
 * POST /orders/:id/cancel
 * Cancellable only within a short buffer window after placing, AND only
 * before the restaurant has accepted — the client-side countdown shown to
 * the customer is just UX, this is the actual source of truth. (Policy
 * updated 2026-09-18 — see CANCEL_BUFFER_SECONDS above and CLAUDE.md.)
 */
async function cancelOrder(req, res) {
  const { id } = req.params;
  const order = await db("orders").where({ id }).first();
  if (!order) return res.status(404).json({ error: "Order not found" });
  if (Number(order.customer_id) !== Number(req.auth.id)) return res.status(403).json({ error: "Not your order" });

  const secondsSincePlaced = (Date.now() - new Date(order.created_at).getTime()) / 1000;
  if (order.status !== "placed") {
    return res.status(409).json({ error: "This order can no longer be cancelled — the restaurant has already accepted it" });
  }
  if (secondsSincePlaced > CANCEL_BUFFER_SECONDS) {
    return res.status(409).json({ error: `The ${CANCEL_BUFFER_SECONDS}-second cancellation window has passed` });
  }

  await db.transaction(async (trx) => {
    await trx("orders").where({ id }).update({ status: "cancelled", cancelled_at: new Date() });
    if (order.payment_status === "paid") {
      await wallet.recordCustomerRefund(order.customer_id, order.id, Number(order.grand_total), "Customer cancellation", trx);
      await trx("orders").where({ id }).update({ payment_status: "refunded" });
    }
  });

  res.json({ message: "Order cancelled" });
}

// ---------------------------------------------------------------------------
// Rider actions
// ---------------------------------------------------------------------------

/**
 * Called automatically right after a restaurant accepts (nearest available
 * rider), per the "Rider Auto-Assignment" rule. Exported so it's testable
 * and callable from acceptOrder or an admin override.
 */
async function autoAssignRider(orderId) {
  const order = await db("orders").where({ id: orderId }).first();
  if (!order) return null;

  const restaurant = await db("restaurants").where({ id: order.restaurant_id }).first();

  const busyRiderIds = (
    await db("orders").whereIn("status", ["accepted", "picked_up", "on_the_way"]).whereNotNull("rider_id").select("rider_id")
  ).map((r) => r.rider_id);

  const candidates = await db("riders")
    .where({ status: "active" })
    .whereNotNull("last_known_lat")
    .whereNotNull("last_known_lng")
    .modify((qb) => {
      if (busyRiderIds.length) qb.whereNotIn("id", busyRiderIds);
    });

  if (candidates.length === 0) return null;

  const nearest = candidates
    .map((r) => ({ rider: r, distanceKm: haversineDistanceKm(Number(restaurant.lat), Number(restaurant.lng), Number(r.last_known_lat), Number(r.last_known_lng)) }))
    .sort((a, b) => a.distanceKm - b.distanceKm)[0];

  await db("orders").where({ id: orderId }).update({ rider_id: nearest.rider.id });
  notifyLater(() => orderPush.riderAssigned(orderId));
  return nearest.rider.id;
}

async function markPickedUp(req, res) {
  const { id } = req.params;
  const order = await db("orders").where({ id }).first();
  if (!order) return res.status(404).json({ error: "Order not found" });
  if (Number(order.rider_id) !== Number(req.auth.id)) return res.status(403).json({ error: "Not your assigned delivery" });
  if (order.status !== "accepted") return res.status(409).json({ error: "Order must be accepted before pickup" });

  // One-time ETA estimate at pickup — does NOT continuously update (Section 5 / CLAUDE.md).
  const restaurant = await db("restaurants").where({ id: order.restaurant_id }).first();
  const distanceKm = haversineDistanceKm(Number(restaurant.lat), Number(restaurant.lng), Number(order.delivery_lat), Number(order.delivery_lng));
  const AVG_SPEED_KMPH = 20; // rough urban delivery average — tune later with real data
  const etaMinutes = Math.max(5, Math.round((distanceKm / AVG_SPEED_KMPH) * 60));

  await db("orders").where({ id }).update({ status: "picked_up", picked_up_at: new Date(), eta_minutes: etaMinutes });
  notifyLater(() => orderPush.orderPickedUp(id));
  res.json({ message: "Marked picked up", eta_minutes: etaMinutes });
}

async function markOnTheWay(req, res) {
  const { id } = req.params;
  const order = await db("orders").where({ id }).first();
  if (!order) return res.status(404).json({ error: "Order not found" });
  if (Number(order.rider_id) !== Number(req.auth.id)) return res.status(403).json({ error: "Not your assigned delivery" });
  if (order.status !== "picked_up") return res.status(409).json({ error: "Order must be picked up first" });

  await db("orders").where({ id }).update({ status: "on_the_way" });
  notifyLater(() => orderPush.orderOnTheWay(id));
  res.json({ message: "Marked on the way" });
}

/**
 * POST /orders/:id/delivered
 * body: { delivery_otp, cod_amount_collected? }
 * delivery_otp is REQUIRED and must match the code the customer was shown —
 * the rider only ever gets it by asking the customer in person (never from
 * any API response). cod_amount_collected is REQUIRED for COD orders
 * (CLAUDE.md: this confirmation is the trigger that creates the wallet_ledger
 * entry). Orders placed before the delivery_otp column existed have none
 * stored, so the code check is skipped for those rather than blocking them.
 */
async function markDelivered(req, res) {
  const { id } = req.params;
  const { cod_amount_collected, delivery_otp } = req.body;
  const order = await db("orders").where({ id }).first();
  if (!order) return res.status(404).json({ error: "Order not found" });
  if (Number(order.rider_id) !== Number(req.auth.id)) return res.status(403).json({ error: "Not your assigned delivery" });
  if (order.status !== "on_the_way") return res.status(409).json({ error: "Order must be on the way first" });

  if (order.delivery_otp && String(delivery_otp ?? "").trim() !== String(order.delivery_otp)) {
    return res.status(400).json({ error: "Incorrect delivery code. Please confirm the code with the customer before marking this delivered." });
  }

  if (order.payment_method === "cod") {
    if (cod_amount_collected == null) {
      return res.status(400).json({ error: "cod_amount_collected is required to mark a COD order delivered" });
    }
    if (Number(cod_amount_collected) !== Number(order.grand_total)) {
      return res.status(400).json({
        error: `Collected amount (₹${cod_amount_collected}) does not match order total (₹${order.grand_total}). Please verify with the customer before confirming.`,
      });
    }
  }

  await db.transaction(async (trx) => {
    await trx("orders").where({ id }).update({
      status: "delivered",
      delivered_at: new Date(),
      payment_status: order.payment_method === "cod" ? "paid" : order.payment_status,
    });

    if (order.payment_method === "cod") {
      await wallet.recordCodCollection(order.rider_id, order.id, Number(cod_amount_collected), trx);
    }
  });

  notifyLater(() => orderPush.orderDelivered(id));
  res.json({ message: "Marked delivered" });
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * Pickup-kitchen name/address/coords for the requester's order view — the
 * business rule ("rider can see restaurant name/location, customer never
 * can") is enforced right here, not left to callers to remember. Restaurants
 * and admins get it too (never restricted for them); customers get {}.
 */
function restaurantContactFields(requesterType, restaurant) {
  if (requesterType === "customer" || !restaurant) return {};
  return {
    restaurant_name: restaurant.name,
    restaurant_address: restaurant.address,
    restaurant_lat: restaurant.lat,
    restaurant_lng: restaurant.lng,
  };
}

/**
 * Customer's phone for the requester's order view — mirrors
 * restaurantContactFields' asymmetric-visibility idea, just the other
 * direction: a rider already gets delivery_address text, this adds a callable
 * number so rider->customer calling works the same way customer->rider
 * calling already does (via the `rider` object below). Restaurants
 * deliberately do NOT get this (they never see customer name/phone, only
 * delivery_address — an existing, intentional gap, not something this
 * changes). Real number, no masking/proxy vendor — same caveat that already
 * applies to the rider's own phone shown to the customer.
 */
function customerContactFields(requesterType, customer) {
  if ((requesterType !== "rider" && requesterType !== "admin") || !customer) return {};
  return { customer_phone: customer.phone };
}

async function getOrder(req, res) {
  const { id } = req.params;
  const order = await db("orders").where({ id }).first();
  if (!order) return res.status(404).json({ error: "Order not found" });

  const { id: actorId, type } = req.auth;
  const isParty =
    (type === "customer" && Number(order.customer_id) === Number(actorId)) ||
    (type === "restaurant" && Number(order.restaurant_id) === Number(actorId)) ||
    (type === "rider" && Number(order.rider_id) === Number(actorId)) ||
    type === "admin";
  if (!isParty) return res.status(403).json({ error: "Not authorized to view this order" });

  const items = await db("order_items")
    .join("items", "items.id", "order_items.item_id")
    .join("categories", "categories.id", "order_items.category_id")
    .where("order_items.order_id", id)
    .orderBy("order_items.id")
    .select("order_items.*", db.raw("COALESCE(order_items.item_name, items.name) as name"), "categories.name as category_name");
  const categories = distinctCategories(items);
  const rider = order.rider_id ? await db("riders").where({ id: order.rider_id }).select("name", "phone").first() : null;
  const restaurant = await db("restaurants").where({ id: order.restaurant_id }).select("name", "address", "lat", "lng").first();
  const customer = type === "rider" || type === "admin" ? await db("users").where({ id: order.customer_id }).select("phone").first() : null;

  res.json({
    order: scrubDeliveryOtp(
      {
        ...withCancelInfo(order),
        categories,
        category_name: categories.map((c) => c.name).join(" + "),
        cancelled: order.status === "cancelled",
        riderRating: order.rider_rating,
        riderRatingComment: order.rider_rating_comment,
        restaurantRating: order.restaurant_rating,
        restaurantRatingComment: order.restaurant_rating_comment,
        restaurantRatingSkipped: Boolean(order.restaurant_rating_skipped),
        rider: rider ? { name: rider.name, phone: rider.phone } : null,
        ...restaurantContactFields(type, restaurant),
        ...customerContactFields(type, customer),
      },
      type
    ),
    items,
  });
}

/**
 * GET /orders/:id/status
 * Lightweight poll target — replaces the frontend's demo "advance to next
 * step" stub. Small payload on purpose since apps will hit this frequently
 * while an order is active; use GET /orders/:id for the full detail.
 */
async function getOrderStatus(req, res) {
  const { id } = req.params;
  const order = await db("orders").where({ id }).first();
  if (!order) return res.status(404).json({ error: "Order not found" });

  const { id: actorId, type } = req.auth;
  const isParty =
    (type === "customer" && Number(order.customer_id) === Number(actorId)) ||
    (type === "restaurant" && Number(order.restaurant_id) === Number(actorId)) ||
    (type === "rider" && Number(order.rider_id) === Number(actorId)) ||
    type === "admin";
  if (!isParty) return res.status(403).json({ error: "Not authorized to view this order" });

  res.json({
    status: order.status,
    cancelled: order.status === "cancelled",
    cancellable_until: cancellableUntil(order),
    eta_minutes: order.eta_minutes,
    picked_up_at: order.picked_up_at,
    delivered_at: order.delivered_at,
    cancelled_at: order.cancelled_at,
    rider_assigned: order.rider_id != null,
  });
}

/**
 * GET /orders/:id/rider
 * No telephony-masking vendor (Exotel/Knowlarity etc.) is integrated yet —
 * this returns the rider's real phone number for now. Flagged gap: swap
 * this for a proxy/masked number before real riders are handling real
 * customer phone numbers.
 */
async function getOrderRider(req, res) {
  const { id } = req.params;
  const order = await db("orders").where({ id }).first();
  if (!order) return res.status(404).json({ error: "Order not found" });
  if (Number(order.customer_id) !== Number(req.auth.id)) return res.status(403).json({ error: "Not your order" });
  if (!order.rider_id) return res.status(404).json({ error: "No rider assigned to this order yet" });

  const rider = await db("riders").where({ id: order.rider_id }).select("name", "phone").first();
  res.json({ rider });
}

// ---------------------------------------------------------------------------
// Ratings
// ---------------------------------------------------------------------------

/**
 * POST /orders/:id/rate-rider
 * body: { rating: 1-5, comment? }
 * A low comment isn't enforced server-side — the "prompt for a comment when
 * rating <= 2" behavior is UX only, per the spec.
 */
async function rateRider(req, res) {
  const { id } = req.params;
  const { rating, comment } = req.body;

  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return res.status(400).json({ error: "rating must be an integer from 1 to 5" });
  }

  const order = await db("orders").where({ id }).first();
  if (!order) return res.status(404).json({ error: "Order not found" });
  if (Number(order.customer_id) !== Number(req.auth.id)) return res.status(403).json({ error: "Not your order" });
  if (order.status !== "delivered") return res.status(409).json({ error: "Can only rate the rider after delivery" });

  await db("orders").where({ id }).update({ rider_rating: rating, rider_rating_comment: comment || null });
  res.json({ message: "Rider rated", riderRating: rating, riderRatingComment: comment || null });
}

/**
 * POST /orders/:id/rate-restaurant
 * body: { rating: 1-5, comment? }
 * This is what satisfies the server-side rating gate on POST /orders (see
 * findPendingRatingGateOrderId above) — rating here or skipping via
 * POST /orders/:id/skip-restaurant-rating are the only two ways to clear it.
 */
async function rateRestaurant(req, res) {
  const { id } = req.params;
  const { rating, comment } = req.body;

  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return res.status(400).json({ error: "rating must be an integer from 1 to 5" });
  }

  const order = await db("orders").where({ id }).first();
  if (!order) return res.status(404).json({ error: "Order not found" });
  if (Number(order.customer_id) !== Number(req.auth.id)) return res.status(403).json({ error: "Not your order" });
  if (order.status !== "delivered") return res.status(409).json({ error: "Can only rate the kitchen after delivery" });

  await db("orders").where({ id }).update({ restaurant_rating: rating, restaurant_rating_comment: comment || null });
  res.json({ message: "Kitchen rated", restaurantRating: rating, restaurantRatingComment: comment || null });
}

/**
 * POST /orders/:id/skip-restaurant-rating
 * Resolves the gate without a rating — still rateable later (calling
 * rate-restaurant afterward still works; this just isn't itself undoable
 * back to "unresolved").
 */
async function skipRestaurantRating(req, res) {
  const { id } = req.params;
  const order = await db("orders").where({ id }).first();
  if (!order) return res.status(404).json({ error: "Order not found" });
  if (Number(order.customer_id) !== Number(req.auth.id)) return res.status(403).json({ error: "Not your order" });
  if (order.status !== "delivered") return res.status(409).json({ error: "Can only skip rating after delivery" });

  if (order.restaurant_rating == null) {
    await db("orders").where({ id }).update({ restaurant_rating_skipped: true });
  }
  res.json({ message: "Rating skipped", restaurantRatingSkipped: true });
}

// ---------------------------------------------------------------------------
// Invoice
// ---------------------------------------------------------------------------

async function loadOwnOrderWithCustomer(req, res) {
  const { id } = req.params;
  const order = await db("orders").where({ id }).first();
  if (!order) {
    res.status(404).json({ error: "Order not found" });
    return null;
  }
  if (Number(order.customer_id) !== Number(req.auth.id)) {
    res.status(403).json({ error: "Not your order" });
    return null;
  }
  const customer = await db("users").where({ id: order.customer_id }).first();
  return { order, customer };
}

async function getOrderInvoice(req, res) {
  const loaded = await loadOwnOrderWithCustomer(req, res);
  if (!loaded) return;
  res.json({ invoice: invoice.buildInvoiceData(loaded.order, loaded.customer) });
}

async function getOrderInvoicePdf(req, res) {
  const loaded = await loadOwnOrderWithCustomer(req, res);
  if (!loaded) return;
  invoice.renderInvoicePdf(res, invoice.buildInvoiceData(loaded.order, loaded.customer));
}

/**
 * POST /orders/:id/reorder
 * body: { delivery_lat?, delivery_lng?, delivery_address?, payment_method? }
 * Re-runs the exact same placeOrder pipeline (routing, tax, min-order, the
 * rating gate) with the original order's items and current prices/stock —
 * never reuses stale pricing, since items may have changed since. Falls
 * back to the customer's default saved address / the original order's
 * payment method for anything not passed.
 */
async function reorder(req, res) {
  const { id } = req.params;
  const original = await db("orders").where({ id }).first();
  if (!original) return res.status(404).json({ error: "Order not found" });
  if (Number(original.customer_id) !== Number(req.auth.id)) return res.status(403).json({ error: "Not your order" });

  const originalItems = await db("order_items").where({ order_id: id, status: "confirmed" });
  if (originalItems.length === 0) return res.status(409).json({ error: "This order has no items left to reorder" });

  let { delivery_lat, delivery_lng, delivery_address, payment_method } = req.body || {};
  if (delivery_lat == null || delivery_lng == null || !delivery_address) {
    const defaultAddress = await db("addresses").where({ customer_id: req.auth.id, is_default: true }).first();
    if (!defaultAddress) {
      return res.status(400).json({ error: "No delivery address given and no default saved address on file" });
    }
    delivery_lat = defaultAddress.lat;
    delivery_lng = defaultAddress.lng;
    delivery_address = defaultAddress.address_line;
  }
  if (!payment_method) payment_method = original.payment_method;

  req.body = {
    items: originalItems.map((oi) => ({ item_id: oi.item_id, quantity: oi.quantity })),
    delivery_lat, delivery_lng, delivery_address, payment_method,
  };
  return placeOrder(req, res);
}

async function listMyOrders(req, res) {
  const { id: actorId, type } = req.auth;
  const columnByType = { customer: "customer_id", restaurant: "restaurant_id", rider: "rider_id" };
  const column = columnByType[type];
  if (!column) return res.status(403).json({ error: "Not applicable for this account type" });

  let query = db("orders").where({ [column]: actorId }).orderBy("created_at", "desc");

  // Restaurants should only see paid orders (or COD, which needs no upfront payment).
  if (type === "restaurant") {
    query = query.andWhere((qb) => qb.where("payment_status", "paid").orWhere("payment_method", "cod"));
  }

  const orders = await query;

  // Order history needs "2 x Kosha Mangsho, 1 x Basanti Pulao" per row —
  // fetch every order's confirmed items in one query rather than N+1'ing
  // GET /orders/:id for each list entry.
  const orderIds = orders.map((o) => o.id);
  const orderItemRows = orderIds.length
    ? await db("order_items")
        .join("items", "items.id", "order_items.item_id")
        .whereIn("order_items.order_id", orderIds)
        .join("categories", "categories.id", "order_items.category_id")
        .andWhere("order_items.status", "confirmed")
        .orderBy("order_items.id")
        .select(
          "order_items.order_id", "order_items.item_id", "order_items.quantity", "order_items.category_id",
          db.raw("COALESCE(order_items.item_name, items.name) as name"), "categories.name as category_name"
        )
    : [];
  const itemsByOrderId = {};
  for (const row of orderItemRows) {
    (itemsByOrderId[row.order_id] ||= []).push({
      item_id: row.item_id, name: row.name, quantity: row.quantity,
      category_id: row.category_id, category_name: row.category_name,
    });
  }

  const restaurantIds = [...new Set(orders.map((o) => o.restaurant_id).filter(Boolean))];
  const restaurantById = type === "customer" || restaurantIds.length === 0
    ? {}
    : Object.fromEntries(
        (await db("restaurants").whereIn("id", restaurantIds).select("id", "name", "address", "lat", "lng")).map((r) => [r.id, r])
      );

  // Only riders reach this endpoint needing it (customers already know their
  // own phone; restaurants never get it, see customerContactFields above).
  const customerIds = [...new Set(orders.map((o) => o.customer_id).filter(Boolean))];
  const customerById = type !== "rider" || customerIds.length === 0
    ? {}
    : Object.fromEntries(
        (await db("users").whereIn("id", customerIds).select("id", "phone")).map((c) => [c.id, c])
      );

  res.json({
    orders: orders.map((o) => {
      const items = itemsByOrderId[o.id] || [];
      const categories = distinctCategories(items);
      return scrubDeliveryOtp(
        {
          ...withCancelInfo(o), items, categories, category_name: categories.map((c) => c.name).join(" + "),
          ...restaurantContactFields(type, restaurantById[o.restaurant_id]),
          ...customerContactFields(type, customerById[o.customer_id]),
        },
        type
      );
    }),
  });
}

/** Distinct categories in an order's items, in first-seen order — a clubbed order has two. */
function distinctCategories(items) {
  const seen = new Map();
  for (const i of items) {
    if (!seen.has(i.category_id)) seen.set(i.category_id, { id: i.category_id, name: i.category_name });
  }
  return [...seen.values()];
}

module.exports = {
  placeOrder,
  confirmPayment,
  acceptOrder,
  startPreparing,
  markReady,
  rejectOrder,
  cancelOrder,
  autoAssignRider,
  markPickedUp,
  markOnTheWay,
  markDelivered,
  getOrder,
  getOrderStatus,
  getOrderRider,
  rateRider,
  rateRestaurant,
  skipRestaurantRating,
  getOrderInvoice,
  getOrderInvoicePdf,
  reorder,
  listMyOrders,
  scrubDeliveryOtp,
};
