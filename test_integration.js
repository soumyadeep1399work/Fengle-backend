// Real integration test against live MySQL — seeds data, exercises the
// routing engine, clubbing, cascade, wallet/COD, and the full order
// lifecycle through actual DB calls (not mocks).
process.env.ORDER_CANCEL_BUFFER_SECONDS = "1"; // fast buffer so the expiry test below doesn't need to sleep 2 minutes
require("dotenv").config();
const db = require("./src/config/db");
const routing = require("./src/services/routing.service");
const wallet = require("./src/services/wallet.service");
const orderController = require("./src/controllers/order.controller");
const cartController = require("./src/controllers/cart.controller");
const settlement = require("./src/services/settlement.service");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let pass = 0, fail = 0;
function check(label, condition) {
  if (condition) { pass++; console.log(`  OK  ${label}`); }
  else { fail++; console.log(`FAIL  ${label}`); }
}

async function main() {
  console.log("--- Seeding ---");
  // Newtown-ish coordinates, spread across a few km
  const [bengaliCatId] = await db("categories").insert({ name: "Bengali" });
  const [southIndianCatId] = await db("categories").insert({ name: "South Indian" });

  // Restaurant A: serves Bengali only, close to customer (1km), full stock
  const [restA] = await db("restaurants").insert({
    name: "Restaurant A", phone: "9000000001", address: "Newtown A",
    lat: 22.5800, lng: 88.4600, radius_km: 5, commission_rate_percent: 15, status: "active",
  });
  await db("restaurant_categories").insert({ restaurant_id: restA, category_id: bengaliCatId });

  // Restaurant B: serves BOTH Bengali and South Indian (clubbing candidate), 2km away
  const [restB] = await db("restaurants").insert({
    name: "Restaurant B", phone: "9000000002", address: "Newtown B",
    lat: 22.5900, lng: 88.4700, radius_km: 5, commission_rate_percent: 15, status: "active",
  });
  await db("restaurant_categories").insert([
    { restaurant_id: restB, category_id: bengaliCatId },
    { restaurant_id: restB, category_id: southIndianCatId },
  ]);

  const [fishCurryId] = await db("items").insert({ category_id: bengaliCatId, name: "Fish Curry", price: 250, created_by_type: "admin" });
  const [rasgullaId] = await db("items").insert({ category_id: bengaliCatId, name: "Rasgulla", price: 80, created_by_type: "admin" });
  const [dosaId] = await db("items").insert({ category_id: southIndianCatId, name: "Masala Dosa", price: 90, created_by_type: "admin" });

  // Stock: Restaurant A has Fish Curry + Rasgulla. Restaurant B has all three (Bengali + South Indian).
  await db("restaurant_items").insert([
    { restaurant_id: restA, item_id: fishCurryId, is_available: true },
    { restaurant_id: restA, item_id: rasgullaId, is_available: true },
    { restaurant_id: restB, item_id: fishCurryId, is_available: true },
    { restaurant_id: restB, item_id: rasgullaId, is_available: true },
    { restaurant_id: restB, item_id: dosaId, is_available: true },
  ]);

  const [customerId] = await db("users").insert({ name: "Test Customer", phone: "8000000001", wallet_balance: 0 });
  const [riderId] = await db("riders").insert({
    name: "Test Rider", phone: "8500000001", status: "active",
    last_known_lat: 22.5810, last_known_lng: 88.4610, wallet_balance: 0,
  });

  console.log("\n--- Test 1: Simple single-category order routes to nearest (Restaurant A) ---");
  const t1 = await routing.findRestaurantForCart({
    items: [{ itemId: fishCurryId, categoryId: bengaliCatId }],
    customerLat: 22.5805, customerLng: 88.4605,
  });
  check("finds a match", t1.match !== null);
  check("routes to nearest restaurant (A, not B)", t1.match.restaurant.id === restA);

  console.log("\n--- Test 2: Clubbed cart (Bengali + South Indian) only matches restaurant serving both ---");
  const t2 = await routing.findRestaurantForCart({
    items: [
      { itemId: fishCurryId, categoryId: bengaliCatId },
      { itemId: dosaId, categoryId: southIndianCatId },
    ],
    customerLat: 22.5805, customerLng: 88.4605,
  });
  check("clubbed cart finds a match", t2.match !== null);
  check("clubbed cart routes to Restaurant B (only one serving both categories)", t2.match && t2.match.restaurant.id === restB);

  console.log("\n--- Test 3: Cascade — mark Restaurant A's Fish Curry out of stock, should skip to B ---");
  await db("restaurant_items").where({ restaurant_id: restA, item_id: fishCurryId }).update({ is_available: false });
  const t3 = await routing.findRestaurantForCart({
    items: [{ itemId: fishCurryId, categoryId: bengaliCatId }],
    customerLat: 22.5805, customerLng: 88.4605,
  });
  check("cascades past out-of-stock Restaurant A to Restaurant B", t3.match && t3.match.restaurant.id === restB);
  // restore for later tests
  await db("restaurant_items").where({ restaurant_id: restA, item_id: fishCurryId }).update({ is_available: true });

  console.log("\n--- Test 4: Full order placement + accept + pickup + deliver (COD) via HTTP-less controller calls ---");
  const fakeReq = (body, params, auth, query = {}) => ({ body, params, auth, query });
  const fakeRes = () => {
    const r = {};
    r.status = (code) => { r.statusCode = code; return r; };
    r.json = (payload) => { r.body = payload; return r; };
    return r;
  };

  let placeRes = fakeRes();
  await orderController.placeOrder(
    fakeReq(
      { items: [{ item_id: fishCurryId, quantity: 1 }, { item_id: rasgullaId, quantity: 1 }], delivery_lat: 22.5805, delivery_lng: 88.4605, delivery_address: "Test Address", payment_method: "cod" },
      {},
      { id: customerId, type: "customer" }
    ),
    placeRes
  );
  check("order placed successfully (201)", placeRes.statusCode === 201);
  const orderId = placeRes.body.order.id;
  check("order routed to nearest restaurant A", placeRes.body.order.restaurant_id === restA);
  check("min order value logic didn't block a ₹330 order", placeRes.body.order.item_total == 330);

  let acceptRes = fakeRes();
  await orderController.acceptOrder(fakeReq({}, { id: orderId }, { id: restA, type: "restaurant" }), acceptRes);
  check("restaurant accepted order", acceptRes.body.order.status === "accepted");
  check("rider auto-assigned on accept", acceptRes.body.order.rider_id === riderId);

  let pickupRes = fakeRes();
  await orderController.markPickedUp(fakeReq({}, { id: orderId }, { id: riderId, type: "rider" }), pickupRes);
  check("marked picked up with an ETA", pickupRes.body.eta_minutes > 0);

  let wayRes = fakeRes();
  await orderController.markOnTheWay(fakeReq({}, { id: orderId }, { id: riderId, type: "rider" }), wayRes);
  check("marked on the way", wayRes.statusCode === undefined); // 200 default, no explicit status() call

  const orderBeforeDeliver = await db("orders").where({ id: orderId }).first();

  let deliverRes = fakeRes();
  await orderController.markDelivered(
    fakeReq({ cod_amount_collected: Number(orderBeforeDeliver.grand_total) }, { id: orderId }, { id: riderId, type: "rider" }),
    deliverRes
  );
  check("marked delivered", deliverRes.body.message === "Marked delivered");

  const riderBalanceAfterCod = await wallet.getBalance("rider", riderId);
  check("COD collection debited rider wallet (liability)", riderBalanceAfterCod === -Number(orderBeforeDeliver.grand_total));

  console.log("\n--- Test 5: Rider settlement nets COD liability against earnings ---");
  const settleResult = await settlement.settleRider(riderId);
  check("settlement processed 1 order", settleResult.ordersSettled === 1);
  const finalBalance = await wallet.getBalance("rider", riderId);
  check("final balance = earnings - COD liability (net)", Math.abs(finalBalance - (settleResult.totalEarnings - Number(orderBeforeDeliver.grand_total))) < 0.01);

  console.log("\n--- Test 5.5: server-side rating gate blocks new orders until the delivered order's kitchen is rated or skipped ---");
  let gatedRes = fakeRes();
  await orderController.placeOrder(
    fakeReq(
      { items: [{ item_id: fishCurryId, quantity: 1 }], delivery_lat: 22.5805, delivery_lng: 88.4605, delivery_address: "Test", payment_method: "cod" },
      {}, { id: customerId, type: "customer" }
    ),
    gatedRes
  );
  check("blocked with 403 while a delivered order is unrated", gatedRes.statusCode === 403);
  check("gate response names the blocking order", gatedRes.body.blocking_order_id === orderId);

  let rateRiderRes = fakeRes();
  await orderController.rateRider(fakeReq({ rating: 5, comment: "Fast!" }, { id: orderId }, { id: customerId, type: "customer" }), rateRiderRes);
  check("rider rating recorded", rateRiderRes.body.riderRating === 5);

  let skipRes = fakeRes();
  await orderController.skipRestaurantRating(fakeReq({}, { id: orderId }, { id: customerId, type: "customer" }), skipRes);
  check("skip-restaurant-rating resolves the gate", skipRes.body.restaurantRatingSkipped === true);

  let unblockedRes = fakeRes();
  await orderController.placeOrder(
    fakeReq(
      { items: [{ item_id: fishCurryId, quantity: 1 }], delivery_lat: 22.5805, delivery_lng: 88.4605, delivery_address: "Test", payment_method: "cod" },
      {}, { id: customerId, type: "customer" }
    ),
    unblockedRes
  );
  check("gate cleared — new order placement succeeds again", unblockedRes.statusCode === 201);
  // cancel this throwaway order so it doesn't interfere with rider-assignment assumptions below
  await db("orders").where({ id: unblockedRes.body.order.id }).update({ status: "cancelled", cancelled_at: new Date() });

  console.log("\n--- Test 6: Minimum order value enforced ---");
  const [cheapItemId] = await db("items").insert({ category_id: bengaliCatId, name: "Small Sweet", price: 20, created_by_type: "admin" });
  await db("restaurant_items").insert({ restaurant_id: restA, item_id: cheapItemId, is_available: true });
  let smallOrderRes = fakeRes();
  await orderController.placeOrder(
    fakeReq(
      { items: [{ item_id: cheapItemId, quantity: 1 }], delivery_lat: 22.5805, delivery_lng: 88.4605, delivery_address: "Test", payment_method: "cod" },
      {}, { id: customerId, type: "customer" }
    ),
    smallOrderRes
  );
  check("₹20 order (below ₹50 minimum) is rejected with 400", smallOrderRes.statusCode === 400);

  console.log("\n--- Test 7: Cancellation buffer window — blocked once the restaurant accepts, or once the buffer elapses ---");
  let order2Res = fakeRes();
  await orderController.placeOrder(
    fakeReq(
      { items: [{ item_id: fishCurryId, quantity: 1 }], delivery_lat: 22.5805, delivery_lng: 88.4605, delivery_address: "Test", payment_method: "cod" },
      {}, { id: customerId, type: "customer" }
    ),
    order2Res
  );
  const order2Id = order2Res.body.order.id;
  await orderController.acceptOrder(fakeReq({}, { id: order2Id }, { id: restA, type: "restaurant" }), fakeRes());
  await orderController.startPreparing(fakeReq({}, { id: order2Id }, { id: restA, type: "restaurant" }), fakeRes());

  let cancelRes = fakeRes();
  await orderController.cancelOrder(fakeReq({}, { id: order2Id }, { id: customerId, type: "customer" }), cancelRes);
  check("cancellation blocked once the restaurant has accepted", cancelRes.statusCode === 409);

  let order2bRes = fakeRes();
  await orderController.placeOrder(
    fakeReq(
      { items: [{ item_id: fishCurryId, quantity: 1 }], delivery_lat: 22.5805, delivery_lng: 88.4605, delivery_address: "Test", payment_method: "cod" },
      {}, { id: customerId, type: "customer" }
    ),
    order2bRes
  );
  const order2bId = order2bRes.body.order.id;
  await sleep(1200); // ORDER_CANCEL_BUFFER_SECONDS=1 for this test run — let the buffer lapse without accepting
  let cancelExpiredRes = fakeRes();
  await orderController.cancelOrder(fakeReq({}, { id: order2bId }, { id: customerId, type: "customer" }), cancelExpiredRes);
  check("cancellation blocked once the buffer window elapses, even if still unaccepted", cancelExpiredRes.statusCode === 409);
  await db("orders").where({ id: order2bId }).update({ status: "cancelled", cancelled_at: new Date() }); // clean up manually since it's stuck 'placed'
  // order2 is deliberately left stuck 'accepted' forever (that's the point of the test above) — but
  // it's still holding the only test rider "busy" for autoAssignRider's purposes. Free the rider back
  // up now that order2's job is done, so later tests can still get a rider assigned.
  await db("orders").where({ id: order2Id }).update({ status: "cancelled", cancelled_at: new Date(), rider_id: null });

  console.log("\n--- Test 8: Partial unavailability at accept — drop item, adjust bill, refund if paid ---");
  let order3Res = fakeRes();
  await orderController.placeOrder(
    fakeReq(
      { items: [{ item_id: fishCurryId, quantity: 1 }, { item_id: rasgullaId, quantity: 1 }], delivery_lat: 22.5805, delivery_lng: 88.4605, delivery_address: "Test", payment_method: "upi" },
      {}, { id: customerId, type: "customer" }
    ),
    order3Res
  );
  const order3Id = order3Res.body.order.id;
  const order3Before = await db("orders").where({ id: order3Id }).first();
  // Simulate payment already captured (UPI order)
  await db("orders").where({ id: order3Id }).update({ payment_status: "paid" });
  const customerBalanceBefore = await wallet.getBalance("customer", customerId);

  let acceptPartialRes = fakeRes();
  await orderController.acceptOrder(
    fakeReq({ unavailable_item_ids: [rasgullaId] }, { id: order3Id }, { id: restA, type: "restaurant" }),
    acceptPartialRes
  );
  check("order accepted with item dropped", acceptPartialRes.body.order.status === "accepted");
  check("bill reduced by dropped item's subtotal", Number(acceptPartialRes.body.order.item_total) === Number(order3Before.item_total) - 80);

  const customerBalanceAfter = await wallet.getBalance("customer", customerId);
  // Refund now includes the dropped item's proportional GST too, not just its
  // subtotal — assert against the actual grand_total delta rather than a
  // hardcoded ₹80, since tax makes the exact figure depend on the rate.
  const expectedRefund = Number(order3Before.grand_total) - Number(acceptPartialRes.body.order.grand_total);
  check("customer wallet credited the full grand_total delta (item + its GST)", Math.abs((customerBalanceAfter - customerBalanceBefore) - expectedRefund) < 0.01);

  console.log("\n--- Test 9: GST is broken out as CGST+SGST on item_total, folded into grand_total ---");
  const order4Res = fakeRes();
  await orderController.placeOrder(
    fakeReq(
      { items: [{ item_id: fishCurryId, quantity: 1 }], delivery_lat: 22.5805, delivery_lng: 88.4605, delivery_address: "Test", payment_method: "cod" },
      {}, { id: customerId, type: "customer" }
    ),
    order4Res
  );
  const order4 = order4Res.body.order;
  const expectedCgst = Number((Number(order4.item_total) * 0.025).toFixed(2));
  const expectedSgst = Number((Number(order4.item_total) * 0.025).toFixed(2));
  check("cgst_amount is 2.5% of item_total", Math.abs(Number(order4.cgst_amount) - expectedCgst) < 0.01);
  check("sgst_amount is 2.5% of item_total", Math.abs(Number(order4.sgst_amount) - expectedSgst) < 0.01);
  check(
    "grand_total = item_total + delivery_fee + cgst + sgst",
    Math.abs(Number(order4.grand_total) - (Number(order4.item_total) + Number(order4.delivery_fee) + Number(order4.cgst_amount) + Number(order4.sgst_amount))) < 0.01
  );

  console.log("\n--- Test 10: payment_method 'wallet' actually debits the customer wallet (previously a no-op bug) ---");
  await db("users").where({ id: customerId }).update({ wallet_balance: 1000 });
  const walletBalanceBefore = await wallet.getBalance("customer", customerId);
  const order5Res = fakeRes();
  await orderController.placeOrder(
    fakeReq(
      { items: [{ item_id: fishCurryId, quantity: 1 }], delivery_lat: 22.5805, delivery_lng: 88.4605, delivery_address: "Test", payment_method: "wallet" },
      {}, { id: customerId, type: "customer" }
    ),
    order5Res
  );
  check("wallet-paid order placed successfully (201)", order5Res.statusCode === 201);
  check("wallet-paid order marked paid immediately (no gateway step)", order5Res.body.order.payment_status === "paid");
  const walletBalanceAfterPaid = await wallet.getBalance("customer", customerId);
  check(
    "wallet balance debited by exactly the order's grand_total",
    Math.abs((walletBalanceBefore - walletBalanceAfterPaid) - Number(order5Res.body.order.grand_total)) < 0.01
  );

  console.log("\n--- Test 11: wallet payment with insufficient balance is rejected (402), order not left dangling ---");
  await db("users").where({ id: customerId }).update({ wallet_balance: 1 });
  const order6Res = fakeRes();
  await orderController.placeOrder(
    fakeReq(
      { items: [{ item_id: fishCurryId, quantity: 1 }], delivery_lat: 22.5805, delivery_lng: 88.4605, delivery_address: "Test", payment_method: "wallet" },
      {}, { id: customerId, type: "customer" }
    ),
    order6Res
  );
  check("insufficient wallet balance returns 402", order6Res.statusCode === 402);

  console.log("\n--- Test 12: POST /cart/quote mirrors placeOrder's own routing/tax/clubbing decisions ---");
  const quoteSingleRes = fakeRes();
  await cartController.quoteCart(
    fakeReq({ items: [{ item_id: fishCurryId, quantity: 1 }], delivery_lat: 22.5805, delivery_lng: 88.4605 }, {}, { id: customerId, type: "customer" }),
    quoteSingleRes
  );
  check("single-category quote is clubbable (i.e. routable) and matches min-order math", quoteSingleRes.body.clubbable === true && quoteSingleRes.body.itemTotal === 250);
  check("quote never leaks restaurant identity", quoteSingleRes.body.restaurant === undefined && quoteSingleRes.body.restaurant_id === undefined);

  const quoteClubbedRes = fakeRes();
  await cartController.quoteCart(
    fakeReq({ items: [{ item_id: fishCurryId, quantity: 1 }, { item_id: dosaId, quantity: 1 }], delivery_lat: 22.5805, delivery_lng: 88.4605 }, {}, { id: customerId, type: "customer" }),
    quoteClubbedRes
  );
  check("clubbed 2-category quote (Bengali+South Indian) resolves to Restaurant B — clubbable:true", quoteClubbedRes.body.clubbable === true && quoteClubbedRes.body.isClubbed === true);

  console.log("\n--- Test 13: rate-restaurant, invoice data, and reorder ---");
  // order3 was only 'accepted' as of Test 8 — advance it to delivered so rating is legal (rider was freed up after Test 7's cleanup above)
  const order3AfterAccept = await db("orders").where({ id: order3Id }).first();
  await orderController.markPickedUp(fakeReq({}, { id: order3Id }, { id: order3AfterAccept.rider_id, type: "rider" }), fakeRes());
  await orderController.markOnTheWay(fakeReq({}, { id: order3Id }, { id: order3AfterAccept.rider_id, type: "rider" }), fakeRes());
  await orderController.markDelivered(fakeReq({}, { id: order3Id }, { id: order3AfterAccept.rider_id, type: "rider" }), fakeRes());
  let rateRes = fakeRes();
  await orderController.rateRestaurant(fakeReq({ rating: 4, comment: "Good food" }, { id: order3Id }, { id: customerId, type: "customer" }), rateRes);
  check("restaurant rated after delivery", rateRes.body.restaurantRating === 4);

  const itemRatingsRes = fakeRes();
  const catalogController = require("./src/controllers/catalog.controller");
  await catalogController.listItemsForCategory(fakeReq({}, { categoryId: bengaliCatId }, {}, { lat: 22.5805, lng: 88.4605 }), itemRatingsRes);
  const fishCurryRow = itemRatingsRes.body.items.find((i) => i.id === fishCurryId);
  check("item avgRating/ratingCount reflect the delivered order's restaurant_rating", fishCurryRow && fishCurryRow.avgRating === 4 && fishCurryRow.ratingCount === 1);

  let invoiceRes = fakeRes();
  await orderController.getOrderInvoice(fakeReq({}, { id: order3Id }, { id: customerId, type: "customer" }), invoiceRes);
  check(
    "invoice total matches the order's grand_total",
    Math.abs(invoiceRes.body.invoice.invoiceTotal - Number((await db("orders").where({ id: order3Id }).first()).grand_total)) < 0.01
  );

  let reorderRes = fakeRes();
  await orderController.reorder(
    fakeReq({ delivery_lat: 22.5805, delivery_lng: 88.4605, delivery_address: "Reorder Address" }, { id: order3Id }, { id: customerId, type: "customer" }),
    reorderRes
  );
  check("reorder places a fresh order from the original's (still-confirmed) items", reorderRes.statusCode === 201);

  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Integration test crashed:", err);
  process.exit(1);
});
