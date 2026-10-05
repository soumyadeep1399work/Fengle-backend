// Real integration test against live MySQL — seeds data, exercises the
// routing engine, clubbing, cascade, wallet/COD, and the full order
// lifecycle through actual DB calls (not mocks).
process.env.ORDER_CANCEL_BUFFER_SECONDS = "1"; // fast buffer so the expiry test below doesn't need to sleep 2 minutes
require("dotenv").config();
const db = require("./src/config/db");
const routing = require("./src/services/routing.service");
const { reviewPartner } = require("./src/services/partnerVerification.service");
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
    fakeReq({ cod_amount_collected: Number(orderBeforeDeliver.grand_total), delivery_otp: orderBeforeDeliver.delivery_otp }, { id: orderId }, { id: riderId, type: "rider" }),
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
  const cu = unblockedRes.body.order.cancellable_until;
  check("POST /orders returns cancellable_until = created_at + the buffer (1s in this run)", cu && new Date(cu) - new Date(unblockedRes.body.order.created_at) === 1000);
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
  await orderController.markDelivered(fakeReq({ delivery_otp: order3AfterAccept.delivery_otp }, { id: order3Id }, { id: order3AfterAccept.rider_id, type: "rider" }), fakeRes());
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

  const detailRes = fakeRes();
  await orderController.getOrder(fakeReq({}, { id: order3Id }, { id: customerId, type: "customer" }), detailRes);
  const detailFish = detailRes.body.items.find((i) => i.item_id === fishCurryId);
  check("GET /orders/:id items carry item name + category name", detailFish && detailFish.name === "Fish Curry" && detailFish.category_name === "Bengali");
  check("cancellable_until is null once the order is past 'placed' (order3 was accepted)", detailRes.body.order.cancellable_until === null);
  check("GET /orders/:id has order-level category_name + categories", detailRes.body.order.category_name === "Bengali" && detailRes.body.order.categories.length === 1);

  const listRes = fakeRes();
  await orderController.listMyOrders(fakeReq({}, {}, { id: customerId, type: "customer" }), listRes);
  const listed = listRes.body.orders.find((o) => o.id === order3Id);
  check("GET /orders rows carry item_id/category per item and category_name", listed.items[0].item_id === fishCurryId && listed.items[0].category_name === "Bengali" && listed.category_name === "Bengali");

  let reorderRes = fakeRes();
  await orderController.reorder(
    fakeReq({ delivery_lat: 22.5805, delivery_lng: 88.4605, delivery_address: "Reorder Address" }, { id: order3Id }, { id: customerId, type: "customer" }),
    reorderRes
  );
  check("reorder places a fresh order from the original's (still-confirmed) items", reorderRes.statusCode === 201);

  console.log("\n--- Test 14: Restaurant app — /restaurants/me, /restaurants/me/menu, mark-ready ---");
  const restaurantController = require("./src/controllers/restaurant.controller");
  const restAuth = { id: restA, type: "restaurant" };

  const meRes = fakeRes();
  await restaurantController.getMyRestaurant(fakeReq({}, {}, restAuth), meRes);
  check("GET /restaurants/me returns own profile with categories, no password_hash",
    meRes.body.restaurant.name === "Restaurant A" && meRes.body.restaurant.categories.length === 1 &&
    meRes.body.restaurant.categories[0].name === "Bengali" && meRes.body.restaurant.password_hash === undefined);

  await db("restaurant_items").where({ restaurant_id: restA, item_id: rasgullaId }).update({ is_available: false });
  const [noRowItemId] = await db("items").insert({ category_id: bengaliCatId, name: "No Stock Row Sweet", price: 60, created_by_type: "admin" });
  const menuRes = fakeRes();
  await restaurantController.getMyMenu(fakeReq({}, {}, restAuth), menuRes);
  const byId = Object.fromEntries(menuRes.body.items.map((i) => [i.id, i]));
  check("menu lists an item that was switched OFF (so it can be switched back on)", byId[rasgullaId] && byId[rasgullaId].is_available === false);
  check("menu lists an in-stock item as available", byId[fishCurryId] && byId[fishCurryId].is_available === true);
  check("item with no restaurant_items row shows as unavailable (matches routing)", byId[noRowItemId] && byId[noRowItemId].is_available === false);
  check("menu excludes categories the restaurant isn't approved for (South Indian)", byId[dosaId] === undefined);
  check("menu items carry category_name and a numeric price", byId[fishCurryId].category_name === "Bengali" && byId[fishCurryId].price === 250);

  const readyOrderId = reorderRes.body.order.id;
  const readyOrderRestId = reorderRes.body.order.restaurant_id;
  const early = fakeRes();
  await orderController.markReady(fakeReq({}, { id: readyOrderId }, { id: readyOrderRestId, type: "restaurant" }), early);
  check("mark-ready before accept is rejected (409)", early.statusCode === 409);
  await orderController.acceptOrder(fakeReq({}, { id: readyOrderId }, { id: readyOrderRestId, type: "restaurant" }), fakeRes());
  const ready1 = fakeRes();
  await orderController.markReady(fakeReq({}, { id: readyOrderId }, { id: readyOrderRestId, type: "restaurant" }), ready1);
  check("mark-ready on an accepted order sets ready_at (status unchanged)",
    ready1.body.message === "Marked ready" && (await db("orders").where({ id: readyOrderId }).first()).status === "accepted");
  await sleep(1100);
  const ready2 = fakeRes();
  await orderController.markReady(fakeReq({}, { id: readyOrderId }, { id: readyOrderRestId, type: "restaurant" }), ready2);
  check("mark-ready is idempotent (keeps the first timestamp)", ready2.body.ready_at === ready1.body.ready_at);
  const wrongRest = fakeRes();
  await orderController.markReady(fakeReq({}, { id: readyOrderId }, { id: readyOrderRestId === restA ? restB : restA, type: "restaurant" }), wrongRest);
  check("another restaurant can't mark it ready (403)", wrongRest.statusCode === 403);
  // readyOrderId is left stuck 'accepted' (its job here is done) — with only
  // one real rider fixture in this whole file, that would permanently starve
  // every later autoAssignRider call. Free it now (same fix as Tests 7 and 18).
  await db("orders").where({ id: readyOrderId }).update({ status: "cancelled", cancelled_at: new Date(), rider_id: null });

  console.log("\n--- Test 15: POST /items validation (restaurant adds a menu item with a photo URL) ---");
  const catalogCtl = require("./src/controllers/catalog.controller");
  const createItem = async (body, auth = restAuth) => {
    const r = fakeRes();
    await catalogCtl.createItem(fakeReq(body, {}, auth), r);
    return r;
  };
  const okBody = { category_id: bengaliCatId, name: "  Validated Dish  ", price: "120.50", is_veg: false, image_url: "http://192.168.1.16:4000/uploads/abc.jpg", description: "d" };
  for (const [label, bad] of [
    ["price 0", { price: 0 }], ["negative price", { price: -5 }], ["non-numeric price", { price: "abc" }],
    ["boolean price", { price: true }], ["empty-string price", { price: "" }], ["absurd price", { price: 1e9 }],
  ]) {
    check(`rejects ${label} (400)`, (await createItem({ ...okBody, ...bad })).statusCode === 400);
  }
  check('rejects is_veg "false" string instead of silently making it veg (400)', (await createItem({ ...okBody, is_veg: "false" })).statusCode === 400);
  check("rejects a javascript: image_url (400)", (await createItem({ ...okBody, image_url: "javascript:alert(1)" })).statusCode === 400);
  check("rejects an unknown category with 404 instead of crashing on the FK", (await createItem({ ...okBody, category_id: 999999 })).statusCode === 404);
  check("restaurant can't add to a category it isn't approved for (403)", (await createItem({ ...okBody, category_id: southIndianCatId })).statusCode === 403);
  const goodItem = await createItem(okBody);
  check("valid item is created (201) with trimmed name, numeric price, is_veg false and the photo URL",
    goodItem.statusCode === 201 && goodItem.body.item.name === "Validated Dish" && Number(goodItem.body.item.price) === 120.5 &&
    Boolean(goodItem.body.item.is_veg) === false && goodItem.body.item.image_url === okBody.image_url);
  const stockRow = await db("restaurant_items").where({ restaurant_id: restA, item_id: goodItem.body.item.id }).first();
  check("a restaurant-created item is in stock at that restaurant", stockRow && Boolean(stockRow.is_available));
  const vegItem = await createItem({ ...okBody, name: "Veg Dish", is_veg: true }, { id: 1, type: "admin" });
  check("admin can create a veg item; is_veg true is kept", vegItem.statusCode === 201 && Boolean(vegItem.body.item.is_veg) === true);

  console.log("\n--- Test 16: PATCH /items/:id (restaurants edit items they carry, incl. admin-seeded) ---");
  const editItem = async (itemId, body, auth = restAuth) => {
    const r = fakeRes();
    await catalogCtl.updateItem(fakeReq(body, { id: itemId }, auth), r);
    return r;
  };
  const adminAuth = { id: 1, type: "admin" };

  // Snapshot an already-placed order that contains Fish Curry, BEFORE we edit it.
  const snapOrder = await db("orders").where({ id: orderId }).first();
  const snapLine = await db("order_items").where({ order_id: orderId, item_id: fishCurryId }).first();

  const e1 = await editItem(fishCurryId, { price: 999, name: "  Fish Curry Deluxe  ", is_veg: true });
  check("restaurant edits an ADMIN-seeded item it carries (200), updated row returned",
    e1.statusCode === undefined && Number(e1.body.item.price) === 999 && e1.body.item.name === "Fish Curry Deluxe" && Boolean(e1.body.item.is_veg) === true);
  const e2 = await editItem(fishCurryId, { image_url: "http://192.168.1.16:4000/uploads/x.jpg" });
  check("image_url can be set", e2.body.item.image_url === "http://192.168.1.16:4000/uploads/x.jpg");
  const e3 = await editItem(fishCurryId, { image_url: null });
  check("image_url: null removes the photo", e3.body.item.image_url === null);
  check("editing one field leaves the others alone", e3.body.item.name === "Fish Curry Deluxe" && Number(e3.body.item.price) === 999);
  check("echoing the item's own category_id is harmless", (await editItem(fishCurryId, { category_id: bengaliCatId, price: "250" })).statusCode === undefined);
  check("changing category_id is refused (400)", (await editItem(fishCurryId, { category_id: southIndianCatId })).statusCode === 400);
  check("empty body is refused (400)", (await editItem(fishCurryId, {})).statusCode === 400);
  check("body with only a truly non-editable field ('id') is refused (400)", (await editItem(fishCurryId, { id: 5 })).statusCode === 400);
  check("a restaurant sending is_active gets 403, not the generic 400 (admin-only field)", (await editItem(fishCurryId, { is_active: false })).statusCode === 403);
  check("same validation as create: price 0 -> 400", (await editItem(fishCurryId, { price: 0 })).statusCode === 400);
  check("same validation as create: price null -> 400", (await editItem(fishCurryId, { price: null })).statusCode === 400);
  check('same validation as create: is_veg "true" string -> 400', (await editItem(fishCurryId, { is_veg: "true" })).statusCode === 400);
  check("same validation as create: javascript: image_url -> 400", (await editItem(fishCurryId, { image_url: "javascript:alert(1)" })).statusCode === 400);
  check("restaurant can't edit an item outside the categories it carries (403)", (await editItem(dosaId, { price: 1 })).statusCode === 403);
  check("unknown item -> 404", (await editItem(999999, { price: 10 })).statusCode === 404);
  await db("items").where({ id: noRowItemId }).update({ is_active: false });
  check("inactive item -> 404", (await editItem(noRowItemId, { price: 10 })).statusCode === 404);
  check("admin can edit any item, even outside a restaurant's categories", (await editItem(dosaId, { price: 95 }, adminAuth)).statusCode === undefined);

  const afterOrder = await db("orders").where({ id: orderId }).first();
  const afterLine = await db("order_items").where({ order_id: orderId, item_id: fishCurryId }).first();
  check("EXISTING order money is unchanged: order_items unit_price + subtotal snapshot",
    Number(afterLine.unit_price) === Number(snapLine.unit_price) && Number(afterLine.subtotal) === Number(snapLine.subtotal));
  check("EXISTING order money is unchanged: item_total, GST and grand_total",
    ["item_total", "cgst_amount", "sgst_amount", "delivery_fee", "grand_total"].every((k) => Number(afterOrder[k]) === Number(snapOrder[k])));
  const invAfter = fakeRes();
  await orderController.getOrderInvoice(fakeReq({}, { id: orderId }, { id: customerId, type: "customer" }), invAfter);
  check("EXISTING order's invoice total is unchanged", Number(invAfter.body.invoice.invoiceTotal) === Number(snapOrder.grand_total));
  const histAfter = fakeRes();
  await orderController.getOrder(fakeReq({}, { id: orderId }, { id: customerId, type: "customer" }), histAfter);
  const histLine = histAfter.body.items.find((i) => i.item_id === fishCurryId);
  check("past-order lines KEEP the name the item had when ordered (rename doesn't rewrite history), with the snapshot price",
    histLine.name === "Fish Curry" && Number(histLine.unit_price) === Number(snapLine.unit_price));
  const histListRes = fakeRes();
  await orderController.listMyOrders(fakeReq({}, {}, { id: customerId, type: "customer" }), histListRes);
  check("GET /orders list also shows the snapshot name for the old order",
    histListRes.body.orders.find((o) => o.id === orderId).items.some((i) => i.name === "Fish Curry"));
  const afterRenameOrder = fakeRes();
  await orderController.placeOrder(
    fakeReq({ items: [{ item_id: fishCurryId, quantity: 1 }], delivery_lat: 22.5805, delivery_lng: 88.4605, delivery_address: "Test", payment_method: "cod" }, {}, { id: customerId, type: "customer" }),
    afterRenameOrder
  );
  const newLine = await db("order_items").where({ order_id: afterRenameOrder.body.order.id }).first();
  check("a NEW order snapshots the item's current (edited) name", newLine.item_name === "Fish Curry Deluxe");
  const quoteAfter = fakeRes();
  await cartController.quoteCart(fakeReq({ items: [{ item_id: fishCurryId, quantity: 1 }], delivery_lat: 22.5805, delivery_lng: 88.4605 }, {}, { id: customerId, type: "customer" }), quoteAfter);
  check("NEW orders/quotes use the edited price", quoteAfter.body.itemTotal === 250);

  console.log("\n--- Test 17: kitchens create categories with no approval — duplicate prevention ---");
  // Note: Bengali / South Indian were raw-inserted above WITHOUT a name_normalized key,
  // so these also prove detection doesn't depend on the stored column.
  const optionsFor = async (q, auth = restAuth) => {
    const r = fakeRes();
    await restaurantController.getCategoryOptions({ body: {}, params: {}, auth, query: q === undefined ? {} : { q } }, r);
    return r.body;
  };
  const addCat = async (body, auth = restAuth) => {
    const r = fakeRes();
    await restaurantController.addMyCategory(fakeReq(body, {}, auth), r);
    return r;
  };
  const idOf = async (name) => (await db("categories").where({ name }).first()).id;

  // -- picker --
  const o0 = await optionsFor();
  check("category-options with no q lists every active category with joined flags, exact null, similar []",
    o0.categories.find((c) => c.name === "Bengali").joined === true && o0.categories.find((c) => c.name === "South Indian").joined === false &&
    o0.exact === null && o0.similar.length === 0);
  const oInd = await optionsFor("indian");
  check("q filters the list to names containing it", oInd.categories.length === 1 && oInd.categories[0].name === "South Indian");
  const oPlural = await optionsFor("Bengalis");
  check("q 'Bengalis' finds the exact match 'Bengali' (plural) with joined:true", oPlural.exact && oPlural.exact.name === "Bengali" && oPlural.exact.joined === true);
  const oClose = await optionsFor("Bengal");
  check("q 'Bengal' has no exact match but lists Bengali as similar", oClose.exact === null && oClose.similar.some((c) => c.name === "Bengali"));

  // -- exact duplicates of a pre-existing (unkeyed) category --
  for (const dupe of ["bengali", "  BENGALIS  ", "Bengali Food", "Bengali Special", "Bengali Cuisine"]) {
    const r = await addCat({ name: dupe });
    check(`"${dupe}" is refused as a duplicate of Bengali (409 category_exists)`, r.statusCode === 409 && r.body.code === "category_exists" && r.body.category.name === "Bengali");
  }
  check("exact-duplicate response says whether this kitchen already joined it", (await addCat({ name: "Bengalis" })).body.category.joined === true);

  // -- create, then plural / spelling variants of the NEW category are duplicates --
  const momos = await addCat({ name: "Momos" });
  check("creating 'Momos' works (201) and returns { category: { id, name } }", momos.statusCode === 201 && momos.body.category.name === "Momos" && momos.body.category.id > 0);
  const momoRow = await db("categories").where({ id: momos.body.category.id }).first();
  check("kitchen-created category defaults: no blurb/photo/prep/min-order, active, keyed, creator recorded",
    momoRow.description === null && momoRow.image_url === null && momoRow.prep_time_min_minutes === null && momoRow.prep_time_max_minutes === null &&
    momoRow.min_order_override === null && Boolean(momoRow.is_active) && momoRow.name_normalized === "momo" && momoRow.created_by_restaurant_id === restA);
  check("...and the kitchen is joined to it",
    Boolean(await db("restaurant_categories").where({ restaurant_id: restA, category_id: momos.body.category.id }).first()));
  for (const dupe of ["Momo", "momos", "MOMO", "Momos Special"]) {
    const r = await addCat({ name: dupe }, { id: restB, type: "restaurant" });
    check(`another kitchen typing "${dupe}" gets 'exists' (never a 2nd Momo)`, r.statusCode === 409 && r.body.code === "category_exists" && r.body.category.name === "Momos" && r.body.category.joined === false);
  }
  const momoCount = await db("categories").whereRaw("LOWER(name) LIKE 'momo%'").count({ n: "*" }).first();
  check("still exactly one Momo(s) category in the database", Number(momoCount.n) === 1);

  const spelling = [["Biriyani", ["Biryani", "Briyani", "Biryanis"]], ["Chow Mein", ["Chowmein", "Chaumin"]], ["Panir Tikka", ["Paneer Tikka"]], ["Tandoori", ["Tandori"]]];
  for (const [first, variants] of spelling) {
    check(`creates "${first}"`, (await addCat({ name: first })).statusCode === 201);
    for (const v of variants) {
      const r = await addCat({ name: v }, { id: restB, type: "restaurant" });
      check(`spelling variant "${v}" is refused as a duplicate of "${first}"`, r.statusCode === 409 && r.body.code === "category_exists" && r.body.category.name === first);
    }
  }

  // -- close-but-not-identical: warn, then allow with confirm_not_duplicate --
  const sim1 = await addCat({ name: "Mome" });
  check("'Mome' (1 typo from Momo) is refused with the similar list (409 similar_categories)", sim1.statusCode === 409 && sim1.body.code === "similar_categories" && sim1.body.similar.some((c) => c.name === "Momos"));
  const sim2 = await addCat({ name: "Bengali Rolls" });
  check("'Bengali Rolls' (contains 'Bengali') is refused as similar", sim2.statusCode === 409 && sim2.body.code === "similar_categories" && sim2.body.similar.some((c) => c.name === "Bengali"));
  const sim3 = await addCat({ name: "Indian" });
  check("'Indian' (contained in 'South Indian') is refused as similar", sim3.statusCode === 409 && sim3.body.code === "similar_categories" && sim3.body.similar.some((c) => c.name === "South Indian"));
  check("similar list is capped at 5 and never includes the exact match", sim3.body.similar.length <= 5);
  check("confirm_not_duplicate: 'false' string does NOT count as confirmation", (await addCat({ name: "Indian", confirm_not_duplicate: "true" })).statusCode === 409);
  const confirmed = await addCat({ name: "Indian", confirm_not_duplicate: true });
  check("with confirm_not_duplicate: true the similar category is created (201)", confirmed.statusCode === 201 && confirmed.body.category.name === "Indian");
  check("confirming does NOT bypass an exact duplicate", (await addCat({ name: "Momo", confirm_not_duplicate: true })).statusCode === 409);

  // -- validation --
  for (const [label, bad] of [["1 char", "A"], ["41 chars", "x".repeat(41)], ["exclamation mark", "Momo!"], ["html", "<b>Hi</b>"], ["digits only", "1234"], ["only filler words", "Food"], ["filler words", "Food Corner"]]) {
    const r = await addCat({ name: bad });
    check(`invalid name (${label}) -> 400 invalid_name`, r.statusCode === 400 && r.body.code === "invalid_name");
  }
  check("non-string name -> 400", (await addCat({ name: 42 })).statusCode === 400);
  check("both category_id and name -> 400", (await addCat({ category_id: 1, name: "X Y" })).statusCode === 400);
  check("neither category_id nor name -> 400", (await addCat({})).statusCode === 400);
  const titled = await addCat({ name: "  hakka   noodles " });
  check("all-lowercase input is tidied and title-cased ('Hakka Noodles')", titled.statusCode === 201 && titled.body.category.name === "Hakka Noodles");
  const bengaliScript = await addCat({ name: "মিষ্টি" });
  check("Bengali-script names are accepted", bengaliScript.statusCode === 201);

  // -- join an existing category --
  const joinSouth = await addCat({ category_id: southIndianCatId });
  check("join an existing category by id (201)", joinSouth.statusCode === 201 && joinSouth.body.category.name === "South Indian");
  check("joining twice -> 409 already_joined", (await addCat({ category_id: southIndianCatId })).body.code === "already_joined");
  check("unknown category_id -> 404", (await addCat({ category_id: 999999 })).statusCode === 404);
  check("non-numeric category_id -> 400", (await addCat({ category_id: "abc" })).statusCode === 400);
  const [inactiveCatId] = await db("categories").insert({ name: "Old Cat", name_normalized: "oldcat", is_active: false });
  check("inactive category can't be joined (404)", (await addCat({ category_id: inactiveCatId })).statusCode === 404);
  check("typing an inactive category's name -> 409 category_unavailable", (await addCat({ name: "Old Cat" })).body.code === "category_unavailable");

  // -- abuse cap + DB backstop --
  process.env.MAX_CATEGORIES_PER_RESTAURANT = "1";
  const restBAuth = { id: restB, type: "restaurant" };
  const cap1 = await addCat({ name: "Zebra Snacks" }, restBAuth);
  const cap2 = await addCat({ name: "Quokka Bites" }, restBAuth);
  delete process.env.MAX_CATEGORIES_PER_RESTAURANT;
  check("a kitchen can only create a limited number of categories (403 category_limit)", cap1.statusCode === 201 && cap2.statusCode === 403 && cap2.body.code === "category_limit");
  let dupCode = null;
  try { await db("categories").insert({ name: "Totally Different Name", name_normalized: "momo" }); } catch (e) { dupCode = e.code; }
  check("DB unique index on name_normalized backstops a race (ER_DUP_ENTRY)", dupCode === "ER_DUP_ENTRY");
  check("picker still lists everything, incl. categories with no stock", (await optionsFor("biriyani")).exact && (await optionsFor("biriyani")).exact.name === "Biriyani");

  // -- admin path holds the same line --
  const adminCat = async (body) => { const r = fakeRes(); await catalogCtl.createCategory(fakeReq(body, {}, adminAuth), r); return r; };
  const adminDup = await adminCat({ name: "Momo" });
  check("admin can't create an exact duplicate either (409 category_exists)", adminDup.statusCode === 409 && adminDup.body.code === "category_exists");
  const adminOk = await adminCat({ name: "Thali / Combos" });
  check("admin names aren't held to the kitchens' character rule ('/' ok) and get a key", adminOk.statusCode === 201 && (await db("categories").where({ id: adminOk.body.category.id }).first()).name_normalized === "thalicombo");

  // -- customer-facing GET /categories: defaults, photo fallback, location filter --
  const listCats = async (query) => { const r = fakeRes(); await catalogCtl.listCategories({ query, params: {}, body: {} }, r); return r; };
  const allCats = (await listCats({})).body.categories;
  const momosRow = allCats.find((c) => c.name === "Momos");
  check("kitchen-created category has usable defaults: prep 30-40, min order 50, no photo yet (null)",
    momosRow.prepTimeMinMinutes === 30 && momosRow.prepTimeMaxMinutes === 40 && momosRow.minOrder === 50 && momosRow.image_url === null && momosRow.blurb === null);
  check("without lat/lng every active category is returned (unchanged behaviour), empty ones included", allCats.some((c) => c.name === "Biriyani") && allCats.some((c) => c.name === "Momos"));
  const momosItem = await createItem({ category_id: momos.body.category.id, name: "Steamed Momo", price: 90, image_url: "http://192.168.1.16:4000/uploads/momo.jpg" });
  check("kitchen adds a dish to its new category", momosItem.statusCode === 201);
  check("category with no photo borrows the first dish photo", (await listCats({})).body.categories.find((c) => c.name === "Momos").image_url === "http://192.168.1.16:4000/uploads/momo.jpg");
  const detailMomos = fakeRes();
  await catalogCtl.getCategoryDetail({ params: { id: momos.body.category.id }, query: { lat: "22.5805", lng: "88.4605" }, body: {} }, detailMomos);
  check("category detail header has the same defaults + photo fallback", detailMomos.body.category.prepTimeMinMinutes === 30 && detailMomos.body.category.image_url === "http://192.168.1.16:4000/uploads/momo.jpg");
  const near = (await listCats({ lat: "22.5805", lng: "88.4605" })).body.categories.map((c) => c.name);
  check("with lat/lng only categories with stock nearby are returned", near.includes("Bengali") && near.includes("South Indian") && near.includes("Momos"));
  check("...and empty kitchen-created categories are hidden", !near.includes("Biriyani") && !near.includes("Chow Mein") && !near.includes("Indian"));
  check("a location with no kitchens in range returns no categories", (await listCats({ lat: "25.0", lng: "80.0" })).body.categories.length === 0);
  check("only one of lat/lng -> 400", (await listCats({ lat: "22.58" })).statusCode === 400);
  check("non-numeric lat/lng -> 400", (await listCats({ lat: "abc", lng: "88" })).statusCode === 400);
  const biriyaniId = await idOf("Biriyani");
  const bengaliUnfiltered = allCats.find((c) => c.name === "Bengali");
  const bengaliNear = (await listCats({ lat: "22.5805", lng: "88.4605" })).body.categories.find((c) => c.name === "Bengali");
  check("clubPartnerIds: unfiltered lists hidden categories, location-filtered list drops them",
    bengaliUnfiltered.clubPartnerIds.includes(biriyaniId) && !bengaliNear.clubPartnerIds.includes(biriyaniId) && bengaliNear.clubPartnerIds.includes(momos.body.category.id));

  console.log("\n--- Test 18: rider (and restaurant/admin) can see the pickup restaurant's name/address; customer never can ---");
  const contactOrderId = afterRenameOrder.body.order.id; // fresh order on restA, still 'placed'
  const contactOrder = await db("orders").where({ id: contactOrderId }).first();
  const restaurantRow = await db("restaurants").where({ id: contactOrder.restaurant_id }).first();
  const contactCustomerRow = await db("users").where({ id: contactOrder.customer_id }).first();

  const asCustomer = fakeRes();
  await orderController.getOrder(fakeReq({}, { id: contactOrderId }, { id: customerId, type: "customer" }), asCustomer);
  check("customer's GET /orders/:id has NO restaurant name/address/coords", asCustomer.body.order.restaurant_name === undefined && asCustomer.body.order.restaurant_address === undefined && asCustomer.body.order.restaurant_lat === undefined);

  const asRestaurant = fakeRes();
  await orderController.getOrder(fakeReq({}, { id: contactOrderId }, { id: contactOrder.restaurant_id, type: "restaurant" }), asRestaurant);
  check("restaurant's own GET /orders/:id also has it (never restricted for them)", asRestaurant.body.order.restaurant_name === restaurantRow.name);
  check("...but a restaurant still gets NO customer phone (existing, deliberate gap — not changed by adding rider->customer calling)", asRestaurant.body.order.customer_phone === undefined);

  const asAdmin = fakeRes();
  await orderController.getOrder(fakeReq({}, { id: contactOrderId }, { id: 1, type: "admin" }), asAdmin);
  check("admin's GET /orders/:id also has it", asAdmin.body.order.restaurant_name === restaurantRow.name);
  check("admin's GET /orders/:id also has the customer's phone", asAdmin.body.order.customer_phone === contactCustomerRow.phone);

  const listCustomer = fakeRes();
  await orderController.listMyOrders(fakeReq({}, {}, { id: customerId, type: "customer" }), listCustomer);
  check("customer's GET /orders list has NO restaurant contact fields on any row", listCustomer.body.orders.every((o) => o.restaurant_name === undefined));

  // Accept it so a rider is actually assigned, then check the rider's own view.
  await orderController.acceptOrder(fakeReq({}, { id: contactOrderId }, { id: contactOrder.restaurant_id, type: "restaurant" }), fakeRes());
  const riderForContact = (await db("orders").where({ id: contactOrderId }).first()).rider_id;

  const asRider = fakeRes();
  await orderController.getOrder(fakeReq({}, { id: contactOrderId }, { id: riderForContact, type: "rider" }), asRider);
  check("rider's GET /orders/:id HAS the restaurant's name, address and coordinates",
    asRider.body.order.restaurant_name === restaurantRow.name && asRider.body.order.restaurant_address === restaurantRow.address &&
    Number(asRider.body.order.restaurant_lat) === Number(restaurantRow.lat) && Number(asRider.body.order.restaurant_lng) === Number(restaurantRow.lng));
  check("rider's GET /orders/:id ALSO now has the customer's phone (rider->customer calling)", asRider.body.order.customer_phone === contactCustomerRow.phone);

  const listRider = fakeRes();
  await orderController.listMyOrders(fakeReq({}, {}, { id: riderForContact, type: "rider" }), listRider);
  check("rider's GET /orders list HAS the restaurant contact fields", listRider.body.orders.find((o) => o.id === contactOrderId).restaurant_name === restaurantRow.name);
  check("rider's GET /orders list ALSO has the customer's phone on the row", listRider.body.orders.find((o) => o.id === contactOrderId).customer_phone === contactCustomerRow.phone);

  const riderCtl = require("./src/controllers/rider.controller");
  const assignedRes = fakeRes();
  await riderCtl.getMyAssignedOrders(fakeReq({}, {}, { id: riderForContact, type: "rider" }), assignedRes);
  check("GET /riders/me/orders also carries the restaurant's name/address", assignedRes.body.orders.find((o) => o.id === contactOrderId).restaurant_name === restaurantRow.name);
  // This order is left stuck 'accepted' on purpose above (its job was just to
  // prove the contact-field checks) — but that keeps riderForContact "busy"
  // forever for autoAssignRider's purposes, and there's only one rider with
  // known coordinates in this fixture set. Free it now, same fix as Test 7.
  await db("orders").where({ id: contactOrderId }).update({ status: "cancelled", cancelled_at: new Date(), rider_id: null });

  console.log("\n--- Test 19: rider self-service — GET/PATCH /riders/me (name/vehicle collected after OTP signup) ---");
  const getRiderProfile = async (auth = { id: riderId, type: "rider" }) => { const r = fakeRes(); await riderCtl.getMyProfile(fakeReq({}, {}, auth), r); return r; };
  const patchRiderProfile = async (body, auth = { id: riderId, type: "rider" }) => { const r = fakeRes(); await riderCtl.updateMyProfile(fakeReq(body, {}, auth), r); return r; };

  const initial = await getRiderProfile();
  check("GET /riders/me returns phone, name, status and wallet_balance as a number",
    initial.body.rider.phone === "8500000001" && initial.body.rider.name === "Test Rider" && initial.body.rider.status === "active" && typeof initial.body.rider.wallet_balance === "number");

  const [freshRiderId] = await db("riders").insert({ phone: "8500000099", status: "active" }); // simulates a just-signed-up rider: name never set
  check("a freshly signed-up rider (no name yet) reads back name: null", (await getRiderProfile({ id: freshRiderId, type: "rider" })).body.rider.name === null);

  const onboarded = await patchRiderProfile({ name: "  Rahul Kumar  ", vehicle_type: "bike", vehicle_number: "wb02ab1234" });
  check("PATCH /riders/me sets name (trimmed) + vehicle in one call and returns the updated profile",
    onboarded.body.rider.name === "Rahul Kumar" && onboarded.body.rider.vehicle_type === "bike" && onboarded.body.rider.vehicle_number === "wb02ab1234");
  check("the update actually persisted (fresh GET agrees)", (await getRiderProfile()).body.rider.name === "Rahul Kumar");

  check("empty body -> 400", (await patchRiderProfile({})).statusCode === 400);
  check("blank name -> 400", (await patchRiderProfile({ name: "   " })).statusCode === 400);
  check("name over 120 chars -> 400", (await patchRiderProfile({ name: "x".repeat(121) })).statusCode === 400);
  check("unknown vehicle_type -> 400", (await patchRiderProfile({ vehicle_type: "helicopter" })).statusCode === 400);
  check("vehicle_number over 30 chars -> 400", (await patchRiderProfile({ vehicle_number: "x".repeat(31) })).statusCode === 400);
  check("partial update (name only) leaves vehicle fields untouched", (await patchRiderProfile({ name: "Rahul K." })).body.rider.vehicle_type === "bike");
  check("vehicle_number: null clears it", (await patchRiderProfile({ vehicle_number: null })).body.rider.vehicle_number === null);
  check("phone is not editable (silently ignored, not an error)", (await patchRiderProfile({ name: "Rahul K.", phone: "0000000000" })).body.rider.phone === "8500000001");

  const availRes = fakeRes();
  await riderCtl.setAvailability(fakeReq({ status: "inactive" }, {}, { id: riderId, type: "rider" }), availRes);
  check("/me/availability and /me/orders still route correctly (not swallowed by /me)", availRes.body.message === "Rider marked inactive" && (await getRiderProfile()).body.rider.status === "inactive");
  await riderCtl.setAvailability(fakeReq({ status: "active" }, {}, { id: riderId, type: "rider" }), fakeRes()); // restore for any later test relying on an active rider
  const ordersStillWork = fakeRes();
  await riderCtl.getMyAssignedOrders(fakeReq({}, {}, { id: riderId, type: "rider" }), ordersStillWork);
  check("GET /riders/me/orders unaffected", Array.isArray(ordersStillWork.body.orders));

  console.log("\n--- Test 20: GET /riders/me/rate exposes the live settlement rate (so client estimates can't drift) ---");
  const settlementSvc = require("./src/services/settlement.service");
  const riderRateRes = fakeRes();
  await riderCtl.getMyRate(fakeReq({}, {}, { id: riderId, type: "rider" }), riderRateRes);
  check("rate matches what settleRider() actually uses",
    riderRateRes.body.rate_per_km === settlementSvc.RIDER_RATE_PER_KM && riderRateRes.body.min_earning_per_delivery === settlementSvc.MIN_EARNING_PER_DELIVERY);

  console.log("\n--- Test 21: delivery_otp is required and checked on markDelivered ---");
  const otpOrderRes = fakeRes();
  await orderController.placeOrder(fakeReq({ items: [{ item_id: fishCurryId, quantity: 1 }], delivery_lat: 22.5805, delivery_lng: 88.4605, delivery_address: "Test", payment_method: "cod" }, {}, { id: customerId, type: "customer" }), otpOrderRes);
  const otpOrder = otpOrderRes.body.order;
  check("a freshly placed order has a 4-digit delivery_otp", /^\d{4}$/.test(otpOrder.delivery_otp || ""));
  await orderController.acceptOrder(fakeReq({}, { id: otpOrder.id }, { id: restA, type: "restaurant" }), fakeRes());
  const otpOrderAfterAccept = await db("orders").where({ id: otpOrder.id }).first();
  await orderController.markPickedUp(fakeReq({}, { id: otpOrder.id }, { id: otpOrderAfterAccept.rider_id, type: "rider" }), fakeRes());
  await orderController.markOnTheWay(fakeReq({}, { id: otpOrder.id }, { id: otpOrderAfterAccept.rider_id, type: "rider" }), fakeRes());
  const wrongOtpRes = fakeRes();
  await orderController.markDelivered(fakeReq({ cod_amount_collected: Number(otpOrderAfterAccept.grand_total), delivery_otp: "0000" }, { id: otpOrder.id }, { id: otpOrderAfterAccept.rider_id, type: "rider" }), wrongOtpRes);
  check("wrong delivery_otp is rejected (400), order stays on_the_way", wrongOtpRes.statusCode === 400 && (await db("orders").where({ id: otpOrder.id }).first()).status === "on_the_way");
  const rightOtpRes = fakeRes();
  await orderController.markDelivered(fakeReq({ cod_amount_collected: Number(otpOrderAfterAccept.grand_total), delivery_otp: otpOrderAfterAccept.delivery_otp }, { id: otpOrder.id }, { id: otpOrderAfterAccept.rider_id, type: "rider" }), rightOtpRes);
  check("correct delivery_otp delivers the order", rightOtpRes.statusCode === undefined && (await db("orders").where({ id: otpOrder.id }).first()).status === "delivered");
  await orderController.skipRestaurantRating(fakeReq({}, { id: otpOrder.id }, { id: customerId, type: "customer" }), fakeRes());

  console.log("\n--- Test 22: admin-imposed suspension blocks login and (for a customer) ordering ---");
  const adminController = require("./src/controllers/admin.controller");
  const adminCustomersCtl = require("./src/controllers/adminCustomers.controller");
  const adminCategoriesCtl = require("./src/controllers/adminCategories.controller");
  const authController = require("./src/controllers/auth.controller");
  const otpUtils = require("./src/utils/otp");

  const [blockableCustomerId] = await db("users").insert({ name: "Blockable", phone: "8100000001", status: "active" });
  const blockRes = fakeRes();
  await adminCustomersCtl.updateCustomerStatus(fakeReq({ status: "blocked" }, { id: blockableCustomerId }, adminAuth), blockRes);
  check("PATCH /admin/customers/:id blocks a customer", blockRes.body.customer.status === "blocked");

  // Real OTP hash (not a stub) so verifyOtp actually reaches the status check
  // rather than failing on OTP verification first — this is the login-block path itself, not a proxy for it.
  const realCustomerOtp = "1234";
  await db("otp_verifications").insert({ phone: "8100000001", otp_hash: await otpUtils.hashOtp(realCustomerOtp), purpose: "login", expires_at: new Date(Date.now() + 60000), verified: false, attempt_count: 0 });
  const blockedLoginRes = fakeRes();
  await authController.verifyOtp(fakeReq({ phone: "8100000001", otp: realCustomerOtp, purpose: "login" }, {}, {}), blockedLoginRes);
  check("a blocked customer with the CORRECT OTP still can't log in (403)", blockedLoginRes.statusCode === 403);

  const blockedOrderRes = fakeRes();
  await orderController.placeOrder(fakeReq({ items: [{ item_id: fishCurryId, quantity: 1 }], delivery_lat: 22.5805, delivery_lng: 88.4605, delivery_address: "Test", payment_method: "cod" }, {}, { id: blockableCustomerId, type: "customer" }), blockedOrderRes);
  check("a blocked customer's own already-issued token still can't place an order (403)", blockedOrderRes.statusCode === 403);

  const [suspendableRiderId] = await db("riders").insert({ name: "Suspendable", phone: "8500000097", status: "active" });
  const suspendRes = fakeRes();
  await adminController.updateRiderStatus(fakeReq({ status: "suspended" }, { id: suspendableRiderId }, adminAuth), suspendRes);
  check("PATCH /admin/riders/:id suspends a rider, and the response never includes password_hash", suspendRes.body.rider.status === "suspended" && suspendRes.body.rider.password_hash === undefined);
  const getRiderNoHashRes = fakeRes();
  await adminController.getRider(fakeReq({}, { id: suspendableRiderId }, adminAuth), getRiderNoHashRes);
  check("GET /admin/riders/:id also never includes password_hash", getRiderNoHashRes.body.rider.password_hash === undefined);

  const realRiderOtp = "5678";
  await db("otp_verifications").insert({ phone: "8500000097", otp_hash: await otpUtils.hashOtp(realRiderOtp), purpose: "rider_login", expires_at: new Date(Date.now() + 60000), verified: false, attempt_count: 0 });
  const suspendedRiderLoginRes = fakeRes();
  await authController.verifyOtp(fakeReq({ phone: "8500000097", otp: realRiderOtp, purpose: "rider_login" }, {}, {}), suspendedRiderLoginRes);
  check("a suspended rider with the CORRECT OTP still can't log in (403)", suspendedRiderLoginRes.statusCode === 403);

  console.log("\n--- Test 23: Admin Panel — orders (list/detail/cancel/reassign), never leaking delivery_otp ---");
  const adminOrdersCtl = require("./src/controllers/adminOrders.controller");
  const listAdminOrders = async (query) => { const r = fakeRes(); await adminOrdersCtl.listOrders({ query, auth: adminAuth }, r); return r; };
  const getAdminOrder = async (id) => { const r = fakeRes(); await adminOrdersCtl.getOrder(fakeReq({}, { id }, adminAuth), r); return r; };

  const l1 = await listAdminOrders({ restaurant_id: String(restA) });
  check("GET /admin/orders?restaurant_id= filters correctly and has total/pagination", l1.body.orders.every((o) => o.restaurant_id === restA) && typeof l1.body.total === "number" && l1.body.page === 1);
  check("list rows carry customer_name/phone, category_names, item_count", l1.body.orders.length > 0 && l1.body.orders[0].customer_name && Array.isArray(l1.body.orders[0].category_names) && l1.body.orders[0].item_count > 0);
  const lq = await listAdminOrders({ q: String(orderId) });
  check("q= matches by numeric order id", lq.body.orders.some((o) => o.id === orderId));
  check("bad status filter -> 400", (await listAdminOrders({ status: "bogus" })).statusCode === 400);

  const d1 = await getAdminOrder(orderId);
  check("GET /admin/orders/:id nests customer+restaurant+rider+items+wallet_ledger as siblings of order, and never leaks delivery_otp", d1.body.order.delivery_otp === undefined && d1.body.customer.phone && d1.body.restaurant.name && Array.isArray(d1.body.items) && Array.isArray(d1.body.wallet_ledger));

  const newOrderForCancel = fakeRes();
  await orderController.placeOrder(fakeReq({ items: [{ item_id: fishCurryId, quantity: 1 }], delivery_lat: 22.5805, delivery_lng: 88.4605, delivery_address: "Test", payment_method: "upi" }, {}, { id: customerId, type: "customer" }), newOrderForCancel);
  const cancelTargetId = newOrderForCancel.body.order.id;
  await db("orders").where({ id: cancelTargetId }).update({ payment_status: "paid" });
  const custBalBeforeAdminCancel = await wallet.getBalance("customer", customerId);
  const adminCancelRes = fakeRes();
  await adminOrdersCtl.cancelOrder(fakeReq({ reason: "Duplicate order" }, { id: cancelTargetId }, adminAuth), adminCancelRes);
  check("admin cancel works even outside the customer's own buffer window, refunds if paid, and doesn't leak delivery_otp",
    adminCancelRes.body.order.status === "cancelled" && adminCancelRes.body.order.payment_status === "refunded" &&
    adminCancelRes.body.order.cancel_reason === "Duplicate order" && adminCancelRes.body.order.cancelled_by === "admin" &&
    adminCancelRes.body.order.delivery_otp === undefined);
  check("the refund actually landed in the wallet", (await wallet.getBalance("customer", customerId)) - custBalBeforeAdminCancel > 0);
  check("cancelling an already-cancelled order -> 409", (await adminOrdersCtl.cancelOrder(fakeReq({}, { id: cancelTargetId }, adminAuth), fakeRes())).statusCode === 409);

  const reassignOrderRes = fakeRes();
  await orderController.placeOrder(fakeReq({ items: [{ item_id: fishCurryId, quantity: 1 }], delivery_lat: 22.5805, delivery_lng: 88.4605, delivery_address: "Test", payment_method: "cod" }, {}, { id: customerId, type: "customer" }), reassignOrderRes);
  const reassignOrderId = reassignOrderRes.body.order.id;
  await orderController.acceptOrder(fakeReq({}, { id: reassignOrderId }, { id: restA, type: "restaurant" }), fakeRes());
  const [secondRiderId] = await db("riders").insert({ name: "Second Rider", phone: "8500000098", status: "active", last_known_lat: 22.58, last_known_lng: 88.47 });
  const reassignRes = fakeRes();
  await adminOrdersCtl.reassignRider(fakeReq({ rider_id: secondRiderId }, { id: reassignOrderId }, adminAuth), reassignRes);
  check("admin reassign-rider updates rider_id and doesn't leak delivery_otp", reassignRes.body.order.rider_id === secondRiderId && reassignRes.body.order.delivery_otp === undefined);
  check("reassigning to an inactive rider is refused (400)", (await adminOrdersCtl.reassignRider(fakeReq({ rider_id: suspendableRiderId }, { id: reassignOrderId }, adminAuth), fakeRes())).statusCode === 400);

  console.log("\n--- Test 24: Admin Panel — riders, restaurants, categories, items lists ---");
  const listAdminRiders = async (query) => { const r = fakeRes(); await adminController.listRiders({ query, auth: adminAuth }, r); return r; };
  const ridersActive = await listAdminRiders({ status: "active", limit: "200" });
  check("GET /admin/riders?status=active&limit=200 (the reassign picker's own call shape) works and excludes the suspended rider", ridersActive.body.riders.every((r) => r.id !== suspendableRiderId) && ridersActive.body.limit === 200);
  check("rider rows carry cod_liability_outstanding / unsettled_delivery_count, never password_hash", ridersActive.body.riders.every((r) => r.password_hash === undefined) && typeof ridersActive.body.riders[0].cod_liability_outstanding === "number");

  const listRestaurantsRes = fakeRes();
  await restaurantController.listRestaurants({ query: {} }, listRestaurantsRes);
  check("GET /admin/restaurants never leaks password_hash and has order_count/total", listRestaurantsRes.body.restaurants.every((r) => r.password_hash === undefined) && typeof listRestaurantsRes.body.restaurants[0].order_count === "number" && typeof listRestaurantsRes.body.total === "number");
  const restDetailRes = fakeRes();
  await restaurantController.getRestaurantDetail(fakeReq({}, { id: restA }, adminAuth), restDetailRes);
  check("GET /admin/restaurants/:id has categories/order_count/rating/commission_config_history and no password_hash", restDetailRes.body.restaurant.password_hash === undefined && Array.isArray(restDetailRes.body.categories) && typeof restDetailRes.body.order_count === "number" && Array.isArray(restDetailRes.body.commission_config_history));

  const rmCatRes = fakeRes();
  await restaurantController.removeRestaurantCategory(fakeReq({}, { id: restB, categoryId: southIndianCatId }, adminAuth), rmCatRes);
  check("DELETE /admin/restaurants/:id/categories/:categoryId removes it", rmCatRes.statusCode === undefined || rmCatRes.body.message === "Category removed");
  check("...and it's actually gone", !(await db("restaurant_categories").where({ restaurant_id: restB, category_id: southIndianCatId }).first()));
  check("removing it again -> 404", (await (async () => { const r = fakeRes(); await restaurantController.removeRestaurantCategory(fakeReq({}, { id: restB, categoryId: southIndianCatId }, adminAuth), r); return r; })()).statusCode === 404);
  await db("restaurant_categories").insert({ restaurant_id: restB, category_id: southIndianCatId }); // restore — later tests route clubbed carts through Restaurant B

  const listAdminCategories = fakeRes();
  await adminCategoriesCtl.listCategories({ query: {}, auth: adminAuth }, listAdminCategories);
  check("GET /admin/categories has item_count/restaurant_count and pagination total", listAdminCategories.body.categories.find((c) => c.name === "Bengali").item_count > 0 && typeof listAdminCategories.body.total === "number");

  const listAdminItems = fakeRes();
  await adminCategoriesCtl.listItems({ query: { limit: "1" } }, listAdminItems);
  check("GET /admin/items respects limit= (was previously ignored)", listAdminItems.body.items.length === 1 && listAdminItems.body.limit === 1);

  console.log("\n--- Test 25: Admin Panel — category rename dedupe + merge ---");
  const [dupCatId] = await db("categories").insert({ name: "Bengali Delicacies", name_normalized: require("./src/utils/categoryName").normalizeCategoryName("Bengali Delicacies") });
  const renameClashRes = fakeRes();
  await adminCategoriesCtl.updateCategory(fakeReq({ name: "Bengalis" }, { id: dupCatId }, adminAuth), renameClashRes); // normalizes to the exact same key as "Bengali" (plural)
  check("admin rename into an existing category's key is refused (409 category_exists)", renameClashRes.statusCode === 409 && renameClashRes.body.code === "category_exists");
  const renameOkRes = fakeRes();
  await adminCategoriesCtl.updateCategory(fakeReq({ name: "Bengali Sweets Corner" }, { id: dupCatId }, adminAuth), renameOkRes);
  check("a genuinely distinct rename succeeds", renameOkRes.statusCode === undefined || renameOkRes.body.category);

  const [mergeSourceId] = await db("categories").insert({ name: "Momos Test", name_normalized: "momotest" });
  const [mergeItemId] = await db("items").insert({ category_id: mergeSourceId, name: "Steamed Momo Test", price: 90, created_by_type: "admin" });
  await db("restaurant_categories").insert({ restaurant_id: restA, category_id: mergeSourceId }); // restA already has Bengali — the merge target
  const mergeRes = fakeRes();
  await adminCategoriesCtl.mergeCategories(fakeReq({ into_category_id: bengaliCatId }, { id: mergeSourceId }, adminAuth), mergeRes);
  check("merge moves the item to the target category", (await db("items").where({ id: mergeItemId }).first()).category_id === bengaliCatId);
  check("merge dedupes restaurant_categories (restA already had Bengali) instead of creating a duplicate row", Number((await db("restaurant_categories").where({ restaurant_id: restA, category_id: bengaliCatId }).count({ n: "*" }).first()).n) === 1);
  check("the source category is deactivated, not deleted", (await db("categories").where({ id: mergeSourceId }).first()).is_active === 0);
  const postMergeDup = await addCat({ name: "Momos Test" }, restAuth); // reusing the addCat() helper from Test 17 — same merged-away name
  check("creating a category with the now-merged-away name is refused, not silently allowed (409 category_unavailable)", postMergeDup.statusCode === 409 && postMergeDup.body.code === "category_unavailable");

  console.log("\n--- Test 26: Admin Panel — customers list/detail/status/wallet-credit/export ---");
  const listCust = async (query) => { const r = fakeRes(); await adminCustomersCtl.listCustomers({ query, auth: adminAuth }, r); return r; };
  const custList = await listCust({});
  check("GET /admin/customers has order_count/total_spent/promo_opt_in per row", custList.body.customers.some((c) => c.id === customerId && c.order_count > 0 && typeof c.promo_opt_in === "boolean"));

  const custDetailRes = fakeRes();
  await adminCustomersCtl.getCustomer(fakeReq({}, { id: customerId }, adminAuth), custDetailRes);
  check("GET /admin/customers/:id has orders + wallet_ledger, and order rows never leak delivery_otp", Array.isArray(custDetailRes.body.orders) && custDetailRes.body.orders.length > 0 && custDetailRes.body.orders.every((o) => o.delivery_otp === undefined) && Array.isArray(custDetailRes.body.wallet_ledger));

  const custBalBeforeCredit = await wallet.getBalance("customer", customerId);
  const creditRes = fakeRes();
  await adminCustomersCtl.creditCustomerWallet(fakeReq({ amount: 75, notes: "Goodwill" }, { id: customerId }, adminAuth), creditRes);
  check("wallet-credit adds exactly the given amount via manual_adjustment", Math.abs((await wallet.getBalance("customer", customerId)) - custBalBeforeCredit - 75) < 0.01);
  check("wallet-credit rejects a non-positive amount (400)", (await (async () => { const r = fakeRes(); await adminCustomersCtl.creditCustomerWallet(fakeReq({ amount: -5 }, { id: customerId }, adminAuth), r); return r; })()).statusCode === 400);

  // CSV export: injection safety + campaign filters + blocked-customer exclusion.
  const [csvCustomerId] = await db("users").insert({
    name: '=cmd|"/c calc"!A1', phone: "8100000002", email: "csv@test.com", status: "active",
    notification_prefs: JSON.stringify({ promotions: true }),
  });
  await db("orders").insert({
    customer_id: csvCustomerId, restaurant_id: restA, status: "delivered", delivery_lat: 22.58, delivery_lng: 88.46,
    delivery_address: "x", item_total: 100, grand_total: 100, payment_method: "cod", payment_status: "paid", delivered_at: new Date(),
  });
  const csvRes1 = { headers: {}, setHeader(k, v) { this.headers[k] = v; }, send(body) { this.body = body; } };
  await adminCustomersCtl.exportCustomersCsv({ query: {} }, csvRes1);
  const csvLines = csvRes1.body.split("\r\n");
  check("CSV has a header row and the malicious name is neutralized against formula injection", csvLines[0] === "name,phone,email,order_count,total_spent,last_order_at,created_at" && csvLines.some((l) => l.startsWith('"\'=cmd')));
  check("the blocked customer is never in the export even without any status filter passed", !csvRes1.body.includes("Blockable"));
  const csvRes2 = { headers: {}, setHeader(k, v) { this.headers[k] = v; }, send(body) { this.body = body; } };
  await adminCustomersCtl.exportCustomersCsv({ query: { status: "blocked" } }, csvRes2); // even an explicit attempt is ignored
  check("passing status=blocked to export.csv does NOT surface blocked customers", !csvRes2.body.includes("Blockable"));
  const csvRes3 = { headers: {}, setHeader(k, v) { this.headers[k] = v; }, send(body) { this.body = body; } };
  await adminCustomersCtl.exportCustomersCsv({ query: { min_orders: "1" } }, csvRes3);
  check("min_orders filter works on the export", csvRes3.body.includes("csv@test.com"));
  const csvRes4 = { headers: {}, setHeader(k, v) { this.headers[k] = v; }, send(body) { this.body = body; } };
  await adminCustomersCtl.exportCustomersCsv({ query: { max_orders: "0" } }, csvRes4);
  check("max_orders=0 (never ordered) excludes the customer who just ordered", !csvRes4.body.includes("csv@test.com"));
  check("CSV response headers are set correctly", csvRes1.headers["Content-Type"].includes("text/csv") && csvRes1.headers["Content-Disposition"].includes("attachment"));

  console.log("\n--- Test 27: Admin Panel — dashboard + settlements ---");
  const dashRes = fakeRes();
  await adminController.dashboardSummary({}, dashRes);
  check("dashboard keeps the original fields and adds today/last7Days/statusCounts", typeof dashRes.body.totalOrders === "number" && typeof dashRes.body.today.orders === "number" && Array.isArray(dashRes.body.last7Days) && dashRes.body.last7Days.length === 7 && typeof dashRes.body.statusCounts.delivered === "number");

  await settlement.settleRider(secondRiderId).catch(() => {}); // may be 0 orders, that's fine — just exercising the settlements list below
  const settlementsRes = fakeRes();
  await adminController.listSettlements({ query: {} }, settlementsRes);
  check("GET /admin/settlements returns a paginated ledger-backed list", Array.isArray(settlementsRes.body.settlements) && typeof settlementsRes.body.total === "number");

  console.log("\n--- Test 28: In-app agreement + owner/rider selfie verification ---");
  // restA/restB/riderId were all INSERTed by this script's own Seeding step,
  // i.e. after the agreement-fields migration already ran on an empty table
  // — so unlike a real pre-existing account, they're never backfilled and
  // start gated exactly like a brand-new onboarding would.
  const TEST_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]); // detectImageType needs >= 12 bytes
  const fakeStreamRes = () => {
    const r = { headers: {} };
    r.set = (k, v) => { r.headers[k] = v; return r; };
    r.status = (code) => { r.statusCode = code; return r; };
    r.json = (payload) => { r.body = payload; return r; };
    r.send = (payload) => { r.body = payload; return r; };
    return r;
  };

  const freshRestMe = fakeRes();
  await restaurantController.getMyRestaurant(fakeReq({}, {}, restAuth), freshRestMe);
  check("a restaurant onboarded after the migration starts gated (agreementRequired: true)", freshRestMe.body.restaurant.agreementRequired === true);

  const noFileRes = fakeRes();
  await restaurantController.acceptRestaurantAgreement(fakeReq({ agreement_version: "1" }, {}, restAuth), noFileRes);
  check("accept-agreement without a file -> 400", noFileRes.statusCode === 400);

  const wrongVersionRes = fakeRes();
  await restaurantController.acceptRestaurantAgreement({ ...fakeReq({ agreement_version: "99" }, {}, restAuth), file: { buffer: TEST_JPEG } }, wrongVersionRes);
  check("accept-agreement with the wrong version -> 409 (stale app build can't accept an outdated version)", wrongVersionRes.statusCode === 409);

  const badImageRes = fakeRes();
  await restaurantController.acceptRestaurantAgreement({ ...fakeReq({ agreement_version: "1" }, {}, restAuth), file: { buffer: Buffer.from("not an image") } }, badImageRes);
  check("accept-agreement with non-image bytes -> 400", badImageRes.statusCode === 400);

  const agreementAcceptRes = fakeRes();
  await restaurantController.acceptRestaurantAgreement({ ...fakeReq({ agreement_version: "1" }, {}, restAuth), file: { buffer: TEST_JPEG } }, agreementAcceptRes);
  check("accept-agreement succeeds and returns agreementAcceptedAt (server clock, not client-supplied)", agreementAcceptRes.statusCode === undefined && typeof agreementAcceptRes.body.agreementAcceptedAt === "string");

  const restMeAfter = fakeRes();
  await restaurantController.getMyRestaurant(fakeReq({}, {}, restAuth), restMeAfter);
  check("GET /restaurants/me flips to agreementRequired: false after accepting", restMeAfter.body.restaurant.agreementRequired === false);

  const adminRestList = fakeRes();
  await restaurantController.listRestaurants({ query: {} }, adminRestList);
  const restARow = adminRestList.body.restaurants.find((r) => r.id === restA);
  check("GET /admin/restaurants exposes agreementAcceptedAt/agreementVersion", restARow.agreementAcceptedAt != null && restARow.agreementVersion === 1);
  const restBRow = adminRestList.body.restaurants.find((r) => r.id === restB);
  check("GET /admin/restaurants hasAgreementSelfie: true once uploaded, false otherwise (never the storage path)", restARow.hasAgreementSelfie === true && restBRow.hasAgreementSelfie === false && !("agreement_selfie_path" in restARow));

  const adminRestDetail = fakeRes();
  await restaurantController.getRestaurantDetail(fakeReq({}, { id: restA }, adminAuth), adminRestDetail);
  check("GET /admin/restaurants/:id exposes agreementAcceptedAt/agreementVersion", adminRestDetail.body.restaurant.agreementVersion === 1);
  check("GET /admin/restaurants/:id exposes hasAgreementSelfie: true", adminRestDetail.body.restaurant.hasAgreementSelfie === true);

  const selfieRes = fakeStreamRes();
  await restaurantController.getRestaurantAgreementSelfie(fakeReq({}, { id: restA }, adminAuth), selfieRes);
  check("GET /admin/restaurants/:id/agreement-selfie streams the exact stored bytes with an image content-type", Buffer.isBuffer(selfieRes.body) && selfieRes.body.equals(TEST_JPEG) && selfieRes.headers["Content-Type"] === "image/jpeg");

  const noSelfieRes = fakeStreamRes();
  await restaurantController.getRestaurantAgreementSelfie(fakeReq({}, { id: restB }, adminAuth), noSelfieRes);
  check("GET /admin/restaurants/:id/agreement-selfie 404s for a restaurant that never accepted", noSelfieRes.statusCode === 404);

  // Same contract, rider side.
  const freshRiderMe = fakeRes();
  await riderCtl.getMyProfile(fakeReq({}, {}, { id: riderId, type: "rider" }), freshRiderMe);
  check("a rider onboarded after the migration starts gated (agreementRequired: true)", freshRiderMe.body.rider.agreementRequired === true);

  const riderWrongVersionRes = fakeRes();
  await riderCtl.acceptRiderAgreement({ ...fakeReq({ agreement_version: "2" }, {}, { id: riderId, type: "rider" }), file: { buffer: TEST_JPEG } }, riderWrongVersionRes);
  check("rider accept-agreement with the wrong version -> 409", riderWrongVersionRes.statusCode === 409);

  const riderAcceptRes = fakeRes();
  await riderCtl.acceptRiderAgreement({ ...fakeReq({ agreement_version: "1" }, {}, { id: riderId, type: "rider" }), file: { buffer: TEST_JPEG } }, riderAcceptRes);
  check("rider accept-agreement succeeds and returns agreementAcceptedAt", riderAcceptRes.statusCode === undefined && typeof riderAcceptRes.body.agreementAcceptedAt === "string");

  const riderMeAfter = fakeRes();
  await riderCtl.getMyProfile(fakeReq({}, {}, { id: riderId, type: "rider" }), riderMeAfter);
  check("GET /riders/me flips to agreementRequired: false after accepting", riderMeAfter.body.rider.agreementRequired === false);

  const listAdminRidersAgreement = await listAdminRiders({});
  const riderRow = listAdminRidersAgreement.body.riders.find((r) => r.id === riderId);
  check("GET /admin/riders exposes agreementAcceptedAt/agreementVersion", riderRow.agreementAcceptedAt != null && riderRow.agreementVersion === 1);
  const riderNoRow = listAdminRidersAgreement.body.riders.find((r) => r.id === secondRiderId);
  check("GET /admin/riders hasAgreementSelfie: true once uploaded, false otherwise", riderRow.hasAgreementSelfie === true && (!riderNoRow || riderNoRow.hasAgreementSelfie === false));

  const adminRiderDetail = fakeRes();
  await adminController.getRider(fakeReq({}, { id: riderId }, adminAuth), adminRiderDetail);
  check("GET /admin/riders/:id exposes agreementAcceptedAt/agreementVersion", adminRiderDetail.body.rider.agreementVersion === 1);
  check("GET /admin/riders/:id exposes hasAgreementSelfie: true and never the storage path", adminRiderDetail.body.rider.hasAgreementSelfie === true && !("agreement_selfie_path" in adminRiderDetail.body.rider));

  const riderSelfieRes = fakeStreamRes();
  await adminController.getRiderAgreementSelfie(fakeReq({}, { id: riderId }, adminAuth), riderSelfieRes);
  check("GET /admin/riders/:id/agreement-selfie streams the exact stored bytes", Buffer.isBuffer(riderSelfieRes.body) && riderSelfieRes.body.equals(TEST_JPEG));

  const riderNoSelfieRes = fakeStreamRes();
  await adminController.getRiderAgreementSelfie(fakeReq({}, { id: secondRiderId }, adminAuth), riderNoSelfieRes);
  check("GET /admin/riders/:id/agreement-selfie 404s for a rider that never accepted", riderNoSelfieRes.statusCode === 404);

  console.log("\n--- Test 29: Customer app T&C popup — GET /profile/me + POST /profile/accept-agreement ---");
  // Deliberately no selfie, no admin review — a lightweight checkbox
  // acceptance, and a SEPARATE version lever from the restaurant/rider
  // agreement (CUSTOMER_TERMS_VERSION, not CURRENT_AGREEMENT_VERSION).
  const profileCtl = require("./src/controllers/profile.controller");
  const customerTermsUtil = require("./src/utils/customerTerms");

  // Real pre-existing customers (ids 1-3 on the dev DB, backfilled the moment
  // this migration ran) were confirmed exempt via a direct DB check outside
  // this suite — same as the restaurant/rider backfill above, this can't be
  // exercised here since every row this script inserts is inserted AFTER the
  // migration already ran on an empty table, so it's never backfilled.
  const [freshCustomerId] = await db("users").insert({ name: "Fresh Customer", phone: "8000000099", wallet_balance: 0 });
  const freshCustomerProfileRes = fakeRes();
  await profileCtl.getMyProfile(fakeReq({}, {}, { id: freshCustomerId, type: "customer" }), freshCustomerProfileRes);
  check("a customer created after the migration starts gated (agreementRequired: true)", freshCustomerProfileRes.body.profile.agreementRequired === true);

  const missingVersionRes = fakeRes();
  await profileCtl.acceptAgreement(fakeReq({}, {}, { id: freshCustomerId, type: "customer" }), missingVersionRes);
  check("accept-agreement without agreement_version -> 400", missingVersionRes.statusCode === 400);

  const staleVersionRes = fakeRes();
  await profileCtl.acceptAgreement(fakeReq({ agreement_version: 99 }, {}, { id: freshCustomerId, type: "customer" }), staleVersionRes);
  check("accept-agreement with a stale version -> 409", staleVersionRes.statusCode === 409);

  const acceptCustomerAgreementRes = fakeRes();
  await profileCtl.acceptAgreement(fakeReq({ agreement_version: customerTermsUtil.CUSTOMER_TERMS_VERSION }, {}, { id: freshCustomerId, type: "customer" }), acceptCustomerAgreementRes);
  check("accept-agreement succeeds and returns agreementAcceptedAt (server clock)", acceptCustomerAgreementRes.statusCode === undefined && typeof acceptCustomerAgreementRes.body.agreementAcceptedAt === "string");

  const profileAfterAcceptRes = fakeRes();
  await profileCtl.getMyProfile(fakeReq({}, {}, { id: freshCustomerId, type: "customer" }), profileAfterAcceptRes);
  check("GET /profile/me flips to agreementRequired: false after accepting", profileAfterAcceptRes.body.profile.agreementRequired === false);

  check("customer T&C uses its OWN version lever, independent of the restaurant/rider CURRENT_AGREEMENT_VERSION", customerTermsUtil.CUSTOMER_TERMS_VERSION !== undefined && require("./src/utils/agreement").CURRENT_AGREEMENT_VERSION !== undefined);

  console.log("\n--- Test 30: Coupon system — targeting, redemption, limits, and the two grand_total recompute fixes ---");
  const adminCouponsCtl = require("./src/controllers/adminCoupons.controller");
  const couponCtl = require("./src/controllers/coupon.controller");
  const couponSvc = require("./src/services/coupon.service");

  const createCoupon = async (body) => { const r = fakeRes(); await adminCouponsCtl.createCoupon(fakeReq(body, {}, adminAuth), r); return r; };
  const listAdminCoupons = async (query = {}) => { const r = fakeRes(); await adminCouponsCtl.listCoupons({ query, auth: adminAuth }, r); return r; };
  const patchCoupon = async (id, body) => { const r = fakeRes(); await adminCouponsCtl.updateCoupon(fakeReq(body, { id }, adminAuth), r); return r; };
  const myCoupons = async (custId) => { const r = fakeRes(); await couponCtl.listMyCoupons(fakeReq({}, {}, { id: custId, type: "customer" }), r); return r; };

  console.log("  (admin CRUD + validation)");
  check("missing code -> 400", (await createCoupon({ title: "x", discount_type: "flat", discount_value: 10 })).statusCode === 400);
  check("missing title -> 400", (await createCoupon({ code: "X", discount_type: "flat", discount_value: 10 })).statusCode === 400);
  check("bad discount_type -> 400", (await createCoupon({ code: "X", title: "x", discount_type: "bogus", discount_value: 10 })).statusCode === 400);
  check("bad target_type -> 400", (await createCoupon({ code: "X", title: "x", discount_type: "flat", discount_value: 10, target_type: "bogus" })).statusCode === 400);
  check("selected_users without target_meta.phones -> 400", (await createCoupon({ code: "X", title: "x", discount_type: "flat", discount_value: 10, target_type: "selected_users" })).statusCode === 400);

  const [newUserId] = await db("users").insert({ name: "New Customer", phone: "8000000090", wallet_balance: 0 });
  const [selectedUserId] = await db("users").insert({ name: "Selected Customer", phone: "8000000091", wallet_balance: 0 });

  const welcomeRes = await createCoupon({
    code: "welcome50", title: "Welcome offer", description: "50 off your first order", discount_type: "flat", discount_value: 50,
    min_order_value: 100, target_type: "new_users", usage_limit_per_user: 1,
  });
  check("create succeeds (201) and lower-cases input code is stored upper-cased", welcomeRes.statusCode === 201 && welcomeRes.body.coupon.code === "WELCOME50");
  const welcomeCouponId = welcomeRes.body.coupon.id;
  check("creating the same code again -> 409", (await createCoupon({ code: "WELCOME50", title: "dup", discount_type: "flat", discount_value: 10 })).statusCode === 409);

  const pctRes = await createCoupon({ code: "SAVE10PCT", title: "10% off", discount_type: "percent", discount_value: 10, max_discount_amount: 30, target_type: "all" });
  const pctCouponId = pctRes.body.coupon.id;

  const vipRes = await createCoupon({ code: "VIP20", title: "VIP only", discount_type: "flat", discount_value: 20, target_type: "selected_users", target_meta: { phones: ["8000000091"] } });
  check("selected_users coupon created", vipRes.statusCode === 201 && vipRes.body.coupon.target_type === "selected_users");

  const expiredRes = await createCoupon({ code: "EXPIRED10", title: "Expired", discount_type: "flat", discount_value: 10, valid_until: "2020-01-01" });
  check("an already-expired coupon can still be created (e.g. imported/backfilled), just never usable", expiredRes.statusCode === 201);

  const adminListRes = await listAdminCoupons({ limit: "50" });
  check("GET /admin/coupons lists them with redemption_count starting at 0", adminListRes.body.coupons.find((c) => c.code === "WELCOME50").redemption_count === 0 && typeof adminListRes.body.total === "number");

  check("PATCH /admin/coupons/:id can toggle is_active", (await patchCoupon(pctCouponId, { is_active: false })).body.coupon.is_active === false);
  await patchCoupon(pctCouponId, { is_active: true }); // restore for the tests below
  check("PATCH into an existing code -> 409", (await patchCoupon(pctCouponId, { code: "WELCOME50" })).statusCode === 409);
  check("PATCH empty body -> 400", (await patchCoupon(pctCouponId, {})).statusCode === 400);
  check("PATCH unknown id -> 404", (await patchCoupon(999999, { title: "x" })).statusCode === 404);

  console.log("  (GET /coupons/mine — targeting eligibility)");
  const newUserCoupons = (await myCoupons(newUserId)).body.coupons.map((c) => c.code);
  check("a zero-order customer sees the new_users coupon", newUserCoupons.includes("WELCOME50"));
  check("...and the 'all' coupon", newUserCoupons.includes("SAVE10PCT"));
  check("...but NOT the selected_users coupon (wrong phone)", !newUserCoupons.includes("VIP20"));
  check("...and NOT the expired one", !newUserCoupons.includes("EXPIRED10"));

  const selectedUserCoupons = (await myCoupons(selectedUserId)).body.coupons.map((c) => c.code);
  check("the listed phone sees the selected_users coupon", selectedUserCoupons.includes("VIP20"));

  const existingCustomerCoupons = (await myCoupons(customerId)).body.coupons.map((c) => c.code);
  check("a customer with existing orders does NOT see the new_users coupon", !existingCustomerCoupons.includes("WELCOME50"));
  check("...but still sees the 'all' coupon", existingCustomerCoupons.includes("SAVE10PCT"));

  console.log("  (POST /cart/quote — preview, no persistence)");
  const quoteWithCoupon = fakeRes();
  await cartController.quoteCart(fakeReq({ items: [{ item_id: fishCurryId, quantity: 1 }, { item_id: rasgullaId, quantity: 1 }], delivery_lat: 22.5805, delivery_lng: 88.4605, coupon_code: "welcome50" }, {}, { id: newUserId, type: "customer" }), quoteWithCoupon);
  check("quote nets a valid coupon's discount into grandTotal", quoteWithCoupon.body.couponDiscount === 50 && quoteWithCoupon.body.couponError === null && quoteWithCoupon.body.grandTotal === Number((quoteWithCoupon.body.itemTotal + quoteWithCoupon.body.deliveryFee + quoteWithCoupon.body.cgstAmount + quoteWithCoupon.body.sgstAmount - 50).toFixed(2)));

  const quoteBadCode = fakeRes();
  await cartController.quoteCart(fakeReq({ items: [{ item_id: fishCurryId, quantity: 1 }, { item_id: rasgullaId, quantity: 1 }], delivery_lat: 22.5805, delivery_lng: 88.4605, coupon_code: "NOPE" }, {}, { id: newUserId, type: "customer" }), quoteBadCode);
  check("quote with an invalid code: 0 discount + an error string, price unaffected", quoteBadCode.body.couponDiscount === 0 && quoteBadCode.body.couponError === "Invalid coupon code");

  const quoteBelowMin = fakeRes();
  await cartController.quoteCart(fakeReq({ items: [{ item_id: rasgullaId, quantity: 1 }], delivery_lat: 22.5805, delivery_lng: 88.4605, coupon_code: "welcome50" }, {}, { id: newUserId, type: "customer" }), quoteBelowMin);
  check("quote below the coupon's own min_order_value is rejected with a clear reason", quoteBelowMin.body.couponError && quoteBelowMin.body.couponError.includes("Minimum order value"));

  console.log("  (POST /orders — real redemption, usage limits, GST/commission untouched by the discount)");
  const couponOrderRes = fakeRes();
  await orderController.placeOrder(fakeReq({ items: [{ item_id: fishCurryId, quantity: 1 }, { item_id: rasgullaId, quantity: 1 }], delivery_lat: 22.5805, delivery_lng: 88.4605, delivery_address: "Test", payment_method: "cod", coupon_code: "welcome50" }, {}, { id: newUserId, type: "customer" }), couponOrderRes);
  const couponOrder = couponOrderRes.body.order;
  check("order applies the coupon: coupon_code/discount stored, grand_total nets it", couponOrder.coupon_code === "WELCOME50" && Number(couponOrder.coupon_discount_amount) === 50 && Number(couponOrder.grand_total) === Number((Number(couponOrder.item_total) + Number(couponOrder.delivery_fee) + Number(couponOrder.cgst_amount) + Number(couponOrder.sgst_amount) - 50).toFixed(2)));
  check("GST is computed on the full pre-discount item_total, unaffected by the coupon", Math.abs(Number(couponOrder.cgst_amount) - Number(couponOrder.item_total) * 0.025) < 0.01);
  check("a coupon_redemptions row was written", Number((await db("coupon_redemptions").where({ coupon_id: welcomeCouponId, user_id: newUserId }).count({ n: "*" }).first()).n) === 1);

  const secondUseRes = fakeRes();
  await orderController.placeOrder(fakeReq({ items: [{ item_id: fishCurryId, quantity: 1 }], delivery_lat: 22.5805, delivery_lng: 88.4605, delivery_address: "Test", payment_method: "cod", coupon_code: "welcome50" }, {}, { id: newUserId, type: "customer" }), secondUseRes);
  check("re-using a usage_limit_per_user:1 coupon: order still succeeds, but with NO discount and a couponError", secondUseRes.statusCode === 201 && Number(secondUseRes.body.order.coupon_discount_amount) === 0 && secondUseRes.body.order.couponError === "You've already used this coupon the maximum number of times");

  const invalidCodeOrderRes = fakeRes();
  await orderController.placeOrder(fakeReq({ items: [{ item_id: fishCurryId, quantity: 1 }], delivery_lat: 22.5805, delivery_lng: 88.4605, delivery_address: "Test", payment_method: "cod", coupon_code: "TOTALLY-FAKE" }, {}, { id: customerId, type: "customer" }), invalidCodeOrderRes);
  check("placing an order with an invalid code still succeeds, uncoupled, full price", invalidCodeOrderRes.statusCode === 201 && invalidCodeOrderRes.body.order.couponError === "Invalid coupon code" && Number(invalidCodeOrderRes.body.order.coupon_discount_amount) === 0);

  console.log("  (total_usage_limit — global cap across all customers)");
  const limitedRes = await createCoupon({ code: "LIMITED1", title: "One redemption ever", discount_type: "flat", discount_value: 15, total_usage_limit: 1 });
  const [limitedUseA] = await db("users").insert({ name: "Limited A", phone: "8000000092", wallet_balance: 0 });
  const [limitedUseB] = await db("users").insert({ name: "Limited B", phone: "8000000093", wallet_balance: 0 });
  const limitedOrderA = fakeRes();
  await orderController.placeOrder(fakeReq({ items: [{ item_id: fishCurryId, quantity: 1 }], delivery_lat: 22.5805, delivery_lng: 88.4605, delivery_address: "Test", payment_method: "cod", coupon_code: "LIMITED1" }, {}, { id: limitedUseA, type: "customer" }), limitedOrderA);
  check("first customer redeems the globally-limited coupon", Number(limitedOrderA.body.order.coupon_discount_amount) === 15);
  const limitedOrderB = fakeRes();
  await orderController.placeOrder(fakeReq({ items: [{ item_id: fishCurryId, quantity: 1 }], delivery_lat: 22.5805, delivery_lng: 88.4605, delivery_address: "Test", payment_method: "cod", coupon_code: "LIMITED1" }, {}, { id: limitedUseB, type: "customer" }), limitedOrderB);
  check("a second, different customer is blocked once total_usage_limit is hit", Number(limitedOrderB.body.order.coupon_discount_amount) === 0 && limitedOrderB.body.order.couponError === "This coupon has reached its usage limit");

  console.log("  (cancelling an order frees the redemption back up)");
  const cancelCouponOrderRes = fakeRes();
  await orderController.placeOrder(fakeReq({ items: [{ item_id: fishCurryId, quantity: 1 }], delivery_lat: 22.5805, delivery_lng: 88.4605, delivery_address: "Test", payment_method: "cod", coupon_code: "SAVE10PCT" }, {}, { id: customerId, type: "customer" }), cancelCouponOrderRes);
  const cancelCouponOrderId = cancelCouponOrderRes.body.order.id;
  check("redemption exists right after placing", Number((await db("coupon_redemptions").where({ order_id: cancelCouponOrderId }).count({ n: "*" }).first()).n) === 1);
  await orderController.cancelOrder(fakeReq({}, { id: cancelCouponOrderId }, { id: customerId, type: "customer" }), fakeRes());
  check("cancelling voids the redemption (coupon freed up again)", Number((await db("coupon_redemptions").where({ order_id: cancelCouponOrderId }).count({ n: "*" }).first()).n) === 0);

  console.log("  (the two grand_total recompute paths — must not silently drop the coupon discount)");
  const acceptCouponOrderRes = fakeRes();
  await orderController.placeOrder(fakeReq({ items: [{ item_id: fishCurryId, quantity: 1 }, { item_id: rasgullaId, quantity: 1 }], delivery_lat: 22.5805, delivery_lng: 88.4605, delivery_address: "Test", payment_method: "cod", coupon_code: "SAVE10PCT" }, {}, { id: customerId, type: "customer" }), acceptCouponOrderRes);
  const acceptCouponOrderId = acceptCouponOrderRes.body.order.id;
  const acceptCouponOrderBefore = await db("orders").where({ id: acceptCouponOrderId }).first();
  check("this order actually has a coupon discount to lose", Number(acceptCouponOrderBefore.coupon_discount_amount) > 0);
  await orderController.acceptOrder(fakeReq({ unavailable_item_ids: [rasgullaId] }, { id: acceptCouponOrderId }, { id: acceptCouponOrderBefore.restaurant_id, type: "restaurant" }), fakeRes());
  const acceptCouponOrderAfter = await db("orders").where({ id: acceptCouponOrderId }).first();
  const expectedAcceptGrandTotal = Number((Number(acceptCouponOrderAfter.item_total) + Number(acceptCouponOrderAfter.delivery_fee) + Number(acceptCouponOrderAfter.cgst_amount) + Number(acceptCouponOrderAfter.sgst_amount) - Number(acceptCouponOrderAfter.coupon_discount_amount)).toFixed(2));
  check("accept-with-dropped-item recompute STILL subtracts the coupon discount from the new grand_total", Number(acceptCouponOrderAfter.grand_total) === expectedAcceptGrandTotal);
  // Free the rider (same cleanup pattern as Test 7/14/18) AND void the
  // redemption exactly like the real cancel endpoints do — otherwise this
  // manual DB-level "cancel" would silently burn customerId's one-time
  // SAVE10PCT use before the reject-cascade test below gets to it.
  await db("orders").where({ id: acceptCouponOrderId }).update({ status: "cancelled", cancelled_at: new Date(), rider_id: null });
  await db("coupon_redemptions").where({ order_id: acceptCouponOrderId }).delete();

  const rejectCouponOrderRes = fakeRes();
  await orderController.placeOrder(fakeReq({ items: [{ item_id: fishCurryId, quantity: 1 }], delivery_lat: 22.5805, delivery_lng: 88.4605, delivery_address: "Test", payment_method: "cod", coupon_code: "SAVE10PCT" }, {}, { id: customerId, type: "customer" }), rejectCouponOrderRes);
  const rejectCouponOrderId = rejectCouponOrderRes.body.order.id;
  const rejectCouponOrderBefore = await db("orders").where({ id: rejectCouponOrderId }).first();
  check("this order (on restA) actually has a coupon discount to lose on cascade", Number(rejectCouponOrderBefore.coupon_discount_amount) > 0 && rejectCouponOrderBefore.restaurant_id === restA);
  await orderController.rejectOrder(fakeReq({}, { id: rejectCouponOrderId }, { id: restA, type: "restaurant" }), fakeRes());
  const rejectCouponOrderAfter = await db("orders").where({ id: rejectCouponOrderId }).first();
  check("reject-cascade reassigns to restB and STILL subtracts the coupon discount from the recomputed grand_total",
    rejectCouponOrderAfter.restaurant_id === restB &&
    Number(rejectCouponOrderAfter.grand_total) === Number((Number(rejectCouponOrderAfter.item_total) + Number(rejectCouponOrderAfter.delivery_fee) + Number(rejectCouponOrderAfter.cgst_amount) + Number(rejectCouponOrderAfter.sgst_amount) - Number(rejectCouponOrderAfter.coupon_discount_amount)).toFixed(2)));
  await db("orders").where({ id: rejectCouponOrderId }).update({ status: "cancelled", cancelled_at: new Date(), rider_id: null });

  console.log("  (invoice line item)");
  const invoiceSvc = require("./src/services/invoice.service");
  const invoiceOrder = await db("orders").where({ id: couponOrder.id }).first();
  const invoiceCustomer = await db("users").where({ id: newUserId }).first();
  const invoiceData = invoiceSvc.buildInvoiceData(invoiceOrder, invoiceCustomer);
  check("invoice gets a negative 'Coupon discount' line naming the code, and invoiceTotal already nets it", invoiceData.lines.some((l) => l.description.includes("Coupon discount") && l.description.includes("WELCOME50") && l.amount === -50) && invoiceData.invoiceTotal === Number(invoiceOrder.grand_total));

  console.log("  (bulk eligibility used for the creation push — must agree with the per-customer check)");
  const allEligible = await couponSvc.getEligibleCustomerIds(await db("coupons").where({ id: pctCouponId }).first());
  check("getEligibleCustomerIds('all') includes an ordinary active customer", allEligible.includes(customerId) && allEligible.includes(newUserId));
  const vipEligible = await couponSvc.getEligibleCustomerIds(await db("coupons").where({ id: vipRes.body.coupon.id }).first());
  check("getEligibleCustomerIds('selected_users') is exactly the listed phone's account, not everyone", vipEligible.includes(selectedUserId) && !vipEligible.includes(customerId) && !vipEligible.includes(newUserId));

  console.log("\n--- Test 31: Real Razorpay integration — dev-stub vs configured-mode branching ---");
  const paymentSvc = require("./src/services/payment.service");
  const paymentCtl = require("./src/controllers/payment.controller");

  check("isConfigured() is false with no keys in env (this test run's baseline)", paymentSvc.isConfigured() === false);
  check("getPublicKeyId() is null when unconfigured", paymentSvc.getPublicKeyId() === null);

  const methodsRes = fakeRes();
  await paymentCtl.getPaymentMethods(fakeReq({}, {}, { id: customerId, type: "customer" }), methodsRes);
  check("GET /payments/methods exposes razorpay_key_id: null when unconfigured", methodsRes.body.razorpay_key_id === null);

  const devStubOrder = await paymentSvc.createPaymentOrder(199, 12345);
  check("createPaymentOrder's dev-stub path is clearly marked dev_stub: true", devStubOrder.dev_stub === true && devStubOrder.id.startsWith("dev_order_"));

  // Simulate configured mode WITHOUT calling the real Razorpay API (no real
  // test-mode keys available in this suite) — verifyPaymentSignature and
  // getPublicKeyId don't touch the network, so they're safe to exercise with
  // fake credentials; createPaymentOrder's real branch is NOT called here.
  const originalKeyId = process.env.RAZORPAY_KEY_ID;
  const originalKeySecret = process.env.RAZORPAY_KEY_SECRET;
  process.env.RAZORPAY_KEY_ID = "rzp_test_fake123";
  process.env.RAZORPAY_KEY_SECRET = "fake_secret_for_hmac_test";
  try {
    check("isConfigured() flips true once both env vars are set", paymentSvc.isConfigured() === true);
    check("getPublicKeyId() returns the key_id (safe to expose) once configured", paymentSvc.getPublicKeyId() === "rzp_test_fake123");

    const methodsResConfigured = fakeRes();
    await paymentCtl.getPaymentMethods(fakeReq({}, {}, { id: customerId, type: "customer" }), methodsResConfigured);
    check("GET /payments/methods exposes the real key_id once configured", methodsResConfigured.body.razorpay_key_id === "rzp_test_fake123");

    const crypto = require("crypto");
    const realOrderId = "order_realtest1";
    const realPaymentId = "pay_realtest1";
    const validSignature = crypto.createHmac("sha256", "fake_secret_for_hmac_test").update(`${realOrderId}|${realPaymentId}`).digest("hex");
    check("verifyPaymentSignature accepts a correctly-computed HMAC", paymentSvc.verifyPaymentSignature({ razorpayOrderId: realOrderId, razorpayPaymentId: realPaymentId, razorpaySignature: validSignature }) === true);
    check("verifyPaymentSignature rejects a tampered signature", paymentSvc.verifyPaymentSignature({ razorpayOrderId: realOrderId, razorpayPaymentId: realPaymentId, razorpaySignature: "0000000000000000000000000000000000000000000000000000000000000000" }) === false);
    check("verifyPaymentSignature rejects a signature computed for a DIFFERENT order id (can't replay across orders)", paymentSvc.verifyPaymentSignature({ razorpayOrderId: "order_other", razorpayPaymentId: realPaymentId, razorpaySignature: validSignature }) === false);
  } finally {
    // Restore immediately — later tests (and re-runs within the same process)
    // must not see fake Razorpay credentials as "configured".
    if (originalKeyId === undefined) delete process.env.RAZORPAY_KEY_ID; else process.env.RAZORPAY_KEY_ID = originalKeyId;
    if (originalKeySecret === undefined) delete process.env.RAZORPAY_KEY_SECRET; else process.env.RAZORPAY_KEY_SECRET = originalKeySecret;
  }
  check("env vars restored — isConfigured() is false again", paymentSvc.isConfigured() === false);

  console.log("\n--- Test 32: Razorpay webhook — signature check, idempotency, cancelled-order refund, and the confirmPayment race fix ---");
  const webhookCtl = require("./src/controllers/razorpayWebhook.controller");
  const crypto = require("crypto");
  const originalWebhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
  process.env.RAZORPAY_WEBHOOK_SECRET = "test_webhook_secret";

  const fakeWebhookReq = (payload, signature) => {
    const rawBody = Buffer.from(JSON.stringify(payload));
    return { rawBody, body: payload, get: (h) => (h.toLowerCase() === "x-razorpay-signature" ? signature : undefined) };
  };
  const signWebhook = (payload) => crypto.createHmac("sha256", "test_webhook_secret").update(Buffer.from(JSON.stringify(payload))).digest("hex");
  const capturedEvent = (orderId, paymentId) => ({ event: "payment.captured", payload: { payment: { entity: { id: paymentId, order_id: orderId } } } });

  try {
    const noSecretRes = fakeRes();
    delete process.env.RAZORPAY_WEBHOOK_SECRET;
    await webhookCtl.handleWebhook(fakeWebhookReq(capturedEvent("order_x", "pay_x"), "whatever"), noSecretRes);
    check("webhook with no RAZORPAY_WEBHOOK_SECRET configured -> 503", noSecretRes.statusCode === 503);
    process.env.RAZORPAY_WEBHOOK_SECRET = "test_webhook_secret";

    const missingSigRes = fakeRes();
    await webhookCtl.handleWebhook(fakeWebhookReq(capturedEvent("order_x", "pay_x"), undefined), missingSigRes);
    check("webhook with no signature header -> 400", missingSigRes.statusCode === 400);

    const wrongSigRes = fakeRes();
    await webhookCtl.handleWebhook(fakeWebhookReq(capturedEvent("order_x", "pay_x"), "0000000000000000000000000000000000000000000000000000000000000000"), wrongSigRes);
    check("webhook with a wrong signature -> 400", wrongSigRes.statusCode === 400);

    const unknownOrderPayload = capturedEvent("order_does_not_exist", "pay_x");
    const unknownOrderRes = fakeRes();
    await webhookCtl.handleWebhook(fakeWebhookReq(unknownOrderPayload, signWebhook(unknownOrderPayload)), unknownOrderRes);
    check("correctly-signed event for an unknown razorpay_order_id -> 200, handled, result unknown_order", unknownOrderRes.body.handled === true && unknownOrderRes.body.result === "unknown_order");

    const ignoredEventPayload = { event: "payment.failed", payload: { payment: { entity: { id: "pay_x", order_id: "order_x" } } } };
    const ignoredEventRes = fakeRes();
    await webhookCtl.handleWebhook(fakeWebhookReq(ignoredEventPayload, signWebhook(ignoredEventPayload)), ignoredEventRes);
    check("payment.failed is ignored (handled: false), not an error", ignoredEventRes.body.handled === false);

    // A real order with a dev-stub razorpay_order_id to mark paid via webhook.
    const webhookOrderRes = fakeRes();
    await orderController.placeOrder(fakeReq({ items: [{ item_id: fishCurryId, quantity: 1 }], delivery_lat: 22.5805, delivery_lng: 88.4605, delivery_address: "Test", payment_method: "upi" }, {}, { id: customerId, type: "customer" }), webhookOrderRes);
    const webhookOrderId = webhookOrderRes.body.order.id;
    const webhookRazorpayOrderId = webhookOrderRes.body.payment.id;
    check("a upi order gets a (dev-stub) razorpay_order_id to key the webhook off", typeof webhookRazorpayOrderId === "string" && webhookRazorpayOrderId.length > 0);

    const captureEventPayload = capturedEvent(webhookRazorpayOrderId, "pay_webhook_test_1");
    const captureRes = fakeRes();
    await webhookCtl.handleWebhook(fakeWebhookReq(captureEventPayload, signWebhook(captureEventPayload)), captureRes);
    check("payment.captured for a real unpaid order -> marked_paid", captureRes.body.result === "marked_paid");
    check("the order is actually paid now, with the webhook's payment id stored", (await db("orders").where({ id: webhookOrderId }).first()).payment_status === "paid" && (await db("orders").where({ id: webhookOrderId }).first()).razorpay_payment_id === "pay_webhook_test_1");

    const duplicateCaptureRes = fakeRes();
    await webhookCtl.handleWebhook(fakeWebhookReq(captureEventPayload, signWebhook(captureEventPayload)), duplicateCaptureRes);
    check("the SAME captured event delivered again -> already_settled, not double-processed", duplicateCaptureRes.body.result === "already_settled");

    // confirmPayment racing a webhook that already marked it paid: must be a
    // harmless no-op, not an error, and must not re-notify the restaurant.
    const confirmAfterWebhookRes = fakeRes();
    await orderController.confirmPayment(fakeReq({ razorpay_payment_id: "pay_webhook_test_1", razorpay_signature: "irrelevant-in-dev-stub-mode" }, { id: webhookOrderId }, { id: customerId, type: "customer" }), confirmAfterWebhookRes);
    check("confirmPayment called AFTER the webhook already paid it is a harmless no-op, payment_status stays paid", confirmAfterWebhookRes.body.payment_status === "paid");

    // Cancelled-order refund path: place, cancel (still unpaid), then the
    // money arrives late via webhook -> wallet refund, not a reopened order.
    const lateOrderRes = fakeRes();
    await orderController.placeOrder(fakeReq({ items: [{ item_id: fishCurryId, quantity: 1 }], delivery_lat: 22.5805, delivery_lng: 88.4605, delivery_address: "Test", payment_method: "upi" }, {}, { id: customerId, type: "customer" }), lateOrderRes);
    const lateOrderId = lateOrderRes.body.order.id;
    const lateRazorpayOrderId = lateOrderRes.body.payment.id;
    await orderController.cancelOrder(fakeReq({}, { id: lateOrderId }, { id: customerId, type: "customer" }), fakeRes());
    check("the order is cancelled, still unpaid", (await db("orders").where({ id: lateOrderId }).first()).status === "cancelled" && (await db("orders").where({ id: lateOrderId }).first()).payment_status === "pending");

    const balanceBeforeLateCapture = await wallet.getBalance("customer", customerId);
    const lateCapturePayload = capturedEvent(lateRazorpayOrderId, "pay_late_capture_1");
    const lateCaptureRes = fakeRes();
    await webhookCtl.handleWebhook(fakeWebhookReq(lateCapturePayload, signWebhook(lateCapturePayload)), lateCaptureRes);
    check("payment.captured arriving after cancellation -> refunded_cancelled_order", lateCaptureRes.body.result === "refunded_cancelled_order");
    const lateOrderAfter = await db("orders").where({ id: lateOrderId }).first();
    check("the order's payment_status is refunded (not paid, not left pending)", lateOrderAfter.payment_status === "refunded");
    check("the customer's wallet was actually credited the grand_total", Math.abs((await wallet.getBalance("customer", customerId)) - balanceBeforeLateCapture - Number(lateOrderAfter.grand_total)) < 0.01);

    const duplicateLateCaptureRes = fakeRes();
    await webhookCtl.handleWebhook(fakeWebhookReq(lateCapturePayload, signWebhook(lateCapturePayload)), duplicateLateCaptureRes);
    check("re-delivering that same late-capture event -> already_settled, no double refund", duplicateLateCaptureRes.body.result === "already_settled");
    check("...and the wallet balance didn't move again", Math.abs((await wallet.getBalance("customer", customerId)) - balanceBeforeLateCapture - Number(lateOrderAfter.grand_total)) < 0.01);

    // confirmPayment racing a webhook that already refunded a cancelled order
    // MUST NOT flip payment_status back to "paid" — this is the real bug
    // the unconditional update had before the fix.
    const confirmAfterRefundRes = fakeRes();
    await orderController.confirmPayment(fakeReq({ razorpay_payment_id: "pay_late_capture_1", razorpay_signature: "irrelevant-in-dev-stub-mode" }, { id: lateOrderId }, { id: customerId, type: "customer" }), confirmAfterRefundRes);
    check("confirmPayment called AFTER the webhook refunded a cancelled order does NOT overwrite refunded back to paid", confirmAfterRefundRes.body.payment_status === "refunded");
    check("...confirmed again directly against the DB row, not just the response", (await db("orders").where({ id: lateOrderId }).first()).payment_status === "refunded");
  } finally {
    if (originalWebhookSecret === undefined) delete process.env.RAZORPAY_WEBHOOK_SECRET; else process.env.RAZORPAY_WEBHOOK_SECRET = originalWebhookSecret;
  }

  console.log("\n--- Test 33: Admin approve/deny of the agreement selfie gates partners server-side ---");
  {
    const { requireAuth } = require("./src/middleware/auth.middleware");
    const { signToken } = require("./src/utils/jwt");
    const bearer = (auth) => ({ headers: { authorization: `Bearer ${signToken(auth)}` } });
    // Runs the real middleware; resolves once it either answers or calls next().
    const runGate = (mw, req) =>
      new Promise((resolve) => {
        const res = fakeRes();
        res.json = (payload) => { res.body = payload; resolve({ res, passed: false }); return res; };
        mw(req, res, (err) => resolve({ res, passed: !err, err }));
      });

    // A brand-new rider, as rider self-signup creates it: pending.
    const [pendingRiderId] = await db("riders").insert({ name: "Pending Rider", phone: "8500000031", status: "active", wallet_balance: 0, verification_status: "pending" });
    const riderTok = bearer({ id: pendingRiderId, type: "rider" });
    const gated = requireAuth(["rider"]);
    const open = requireAuth(["rider"], { allowUnverified: true });

    const g1 = await runGate(gated, riderTok);
    check("pending rider: a normal route answers 403 verification_required", g1.res.statusCode === 403 && g1.res.body.code === "verification_required" && g1.res.body.verificationStatus === "pending");
    check("pending rider: an allowUnverified route (profile/accept-agreement) still passes", (await runGate(open, riderTok)).passed === true);

    check("approve with no selfie on file -> 409", (await reviewPartner("riders", pendingRiderId, 1, "approve")).status === 409);
    check("unknown decision -> 400", (await reviewPartner("riders", pendingRiderId, 1, "maybe")).status === 400);

    const accept = fakeRes();
    await riderCtl.acceptRiderAgreement({ ...fakeReq({ agreement_version: "1" }, {}, { id: pendingRiderId, type: "rider" }), file: { buffer: TEST_JPEG } }, accept);
    check("accept-agreement leaves a new rider 'pending' (in the review queue)", accept.body.verificationStatus === "pending");

    check("deny without a reason -> 400", (await reviewPartner("riders", pendingRiderId, 1, "deny", "  ")).status === 400);
    const denied = await reviewPartner("riders", pendingRiderId, 1, "deny", "Face not visible");
    check("deny with a reason -> 200, status denied", denied.status === 200 && denied.body.verificationStatus === "denied");
    const meDenied = fakeRes();
    await riderCtl.getMyProfile(fakeReq({}, {}, { id: pendingRiderId, type: "rider" }), meDenied);
    check("GET /riders/me shows denied + reason and re-opens the selfie step (agreementRequired)", meDenied.body.rider.verificationStatus === "denied" && meDenied.body.rider.verificationDeniedReason === "Face not visible" && meDenied.body.rider.agreementRequired === true);
    check("denied rider is still blocked from normal routes", (await runGate(gated, riderTok)).res.body.verificationStatus === "denied");

    const retake = fakeRes();
    await riderCtl.acceptRiderAgreement({ ...fakeReq({ agreement_version: "1" }, {}, { id: pendingRiderId, type: "rider" }), file: { buffer: TEST_JPEG } }, retake);
    const meRetaken = fakeRes();
    await riderCtl.getMyProfile(fakeReq({}, {}, { id: pendingRiderId, type: "rider" }), meRetaken);
    check("retaking the selfie after a denial goes back to pending with the reason cleared", retake.body.verificationStatus === "pending" && meRetaken.body.rider.verificationDeniedReason === null && meRetaken.body.rider.agreementRequired === false);
    const approved = await reviewPartner("riders", pendingRiderId, 1, "approve");
    check("approve -> 200, status approved", approved.status === 200 && approved.body.verificationStatus === "approved");
    check("approved rider passes the normal gate", (await runGate(gated, riderTok)).passed === true);

    // Auto-assignment only considers approved riders.
    await db("riders").where({ id: pendingRiderId }).update({ last_known_lat: 22.5801, last_known_lng: 88.4601 });
    await db("riders").whereNot({ id: pendingRiderId }).update({ verification_status: "pending" });
    const [assignOrderId] = await db("orders").insert({
      customer_id: customerId, restaurant_id: restA, status: "accepted", payment_method: "cod", payment_status: "pending",
      item_total: 100, delivery_fee: 30, grand_total: 130, delivery_address: "x", delivery_lat: 22.58, delivery_lng: 88.46,
    });
    check("autoAssignRider only considers approved riders", (await orderController.autoAssignRider(assignOrderId)) === pendingRiderId);
    await db("orders").where({ id: assignOrderId }).update({ rider_id: null });
    await db("riders").where({ id: pendingRiderId }).update({ verification_status: "pending" });
    check("...and assigns nobody when no rider is approved", (await orderController.autoAssignRider(assignOrderId)) === null);
    await db("riders").update({ verification_status: "approved" });
    await db("orders").where({ id: assignOrderId }).update({ status: "cancelled", rider_id: null });

    // Routing only considers approved kitchens.
    await db("restaurants").where({ id: restA }).update({ verification_status: "pending" });
    const pendingRouting = await routing.findRestaurantForCart({ items: [{ itemId: fishCurryId, categoryId: bengaliCatId }], customerLat: 22.5805, customerLng: 88.4605 });
    check("a pending restaurant is never matched for an order (falls to the next kitchen)", pendingRouting.match && pendingRouting.match.restaurant.id !== restA);
    await db("restaurants").where({ id: restA }).update({ verification_status: "approved" });

    // Restaurant side of the gate.
    const restTok = bearer({ id: restB, type: "restaurant" });
    await db("restaurants").where({ id: restB }).update({ verification_status: "denied", verification_denied_reason: "Blurry" });
    const rg = await runGate(requireAuth(["restaurant"]), restTok);
    check("denied restaurant: normal route -> 403 with the reason", rg.res.statusCode === 403 && rg.res.body.verificationDeniedReason === "Blurry");
    check("denied restaurant: allowUnverified route (GET /restaurants/me) passes", (await runGate(requireAuth(["restaurant"], { allowUnverified: true }), restTok)).passed === true);
    await db("restaurants").where({ id: restB }).update({ verification_status: "approved", verification_denied_reason: null });
    check("customers are never held to the partner gate", (await runGate(requireAuth(["customer"]), bearer({ id: customerId, type: "customer" }))).passed === true);
  }

  console.log("\n--- Test 34: Catalog photo uploads are re-encoded as small WebP on the server ---");
  {
    const sharp = require("sharp");
    const fs = require("fs");
    const path = require("path");
    const uploadController = require("./src/controllers/upload.controller");
    const storageService = require("./src/services/storage.service");
    const savedBucket = process.env.AWS_S3_BUCKET;
    delete process.env.AWS_S3_BUCKET; // keep this test off the real S3 bucket: it writes to local disk instead
    const written = [];
    try {
      const upload = async (buffer) => {
        const res = fakeRes();
        await uploadController.uploadImage({ file: buffer ? { buffer } : undefined, protocol: "http", get: () => "localhost:4000" }, res);
        if (res.body && res.body.url) written.push(path.join(__dirname, "uploads", path.basename(res.body.url)));
        return res;
      };
      // A large noisy JPEG with an EXIF orientation tag, as a phone would send.
      const noise = Buffer.alloc(3000 * 2000 * 3);
      for (let i = 0; i < noise.length; i++) noise[i] = (i * 7919) & 0xff;
      const bigJpeg = await sharp(noise, { raw: { width: 3000, height: 2000, channels: 3 } }).jpeg({ quality: 95 }).withMetadata({ orientation: 6 }).toBuffer();
      const jpegRes = await upload(bigJpeg);
      check("a JPEG upload -> 201 with a .webp URL", jpegRes.statusCode === 201 && /\.webp$/.test(jpegRes.body.url));
      const stored = await fs.promises.readFile(written[0]);
      check("the stored bytes really are WebP (magic bytes), not the original JPEG", storageService.detectImageType(stored) === "webp");
      const meta = await sharp(stored).metadata();
      check("resized so the longest side is <= 1000px (EXIF rotation applied: 3000x2000 portrait -> 667x1000)", Math.max(meta.width, meta.height) === 1000 && meta.height > meta.width);
      check("...and far smaller than the original", stored.length < bigJpeg.length / 3);
      check("EXIF metadata is stripped", !meta.exif);

      const pngBuf = await sharp({ create: { width: 200, height: 100, channels: 3, background: "#4B18A6" } }).png().toBuffer();
      const pngRes = await upload(pngBuf);
      const smallMeta = await sharp(await fs.promises.readFile(written[1])).metadata();
      check("a PNG upload is converted too, and a small image is not enlarged", pngRes.statusCode === 201 && /\.webp$/.test(pngRes.body.url) && smallMeta.width === 200 && smallMeta.height === 100);

      const corrupt = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40, 7)]);
      const corruptRes = await upload(corrupt);
      check("right magic bytes but undecodable -> 400, nothing stored", corruptRes.statusCode === 400 && written.length === 2);
      check("not an image at all -> 400", (await upload(Buffer.from("this is definitely not an image file"))).statusCode === 400);
      check("no file -> 400", (await upload(null)).statusCode === 400);
    } finally {
      if (savedBucket !== undefined) process.env.AWS_S3_BUCKET = savedBucket;
      for (const f of written) await fs.promises.unlink(f).catch(() => {});
    }
  }

  console.log("\n--- Test 35: Admin roles (super_admin / ops / support), admin management, per-request disable ---");
  {
    const http = require("http");
    const bcrypt = require("bcrypt");
    const { signToken } = require("./src/utils/jwt");
    const app = require("./src/app");
    const server = await new Promise((resolve) => { const s = http.createServer(app).listen(0, () => resolve(s)); });
    const base = `http://127.0.0.1:${server.address().port}/api/v1`;
    const hash = await bcrypt.hash("a-long-password-1", 4);
    const mk = async (name, role) => {
      const [id] = await db("admins").insert({ name, email: `${name}@rbac.test`, password_hash: hash, role });
      return { id, token: signToken({ id, type: "admin" }) };
    };
    const superA = await mk("rbac-super", "super_admin");
    const opsA = await mk("rbac-ops", "ops");
    const supA = await mk("rbac-support", "support");
    const call = async (who, method, p, body) => {
      const res = await fetch(base + p, {
        method,
        headers: { Authorization: `Bearer ${who.token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* csv etc. */ }
      return { status: res.status, body: json };
    };
    const forbidden = (r) => r.status === 403 && r.body && r.body.code === "forbidden_role";

    try {
      // [method, path, body, allowed roles]. Allowed calls use ids/bodies that can't match anything, so
      // they stop at validation/404 inside the handler and change nothing.
      const ALL = ["super_admin", "ops", "support"], STAFF = ["super_admin", "ops"], SUPER = ["super_admin"];
      const matrix = [
        ["GET", "/admin/dashboard", null, ALL],
        ["GET", "/admin/orders", null, ALL],
        ["GET", "/admin/riders", null, ALL],
        ["GET", "/admin/restaurants", null, ALL],
        ["GET", "/admin/customers", null, ALL],
        ["GET", "/admin/coupons", null, ALL],
        ["GET", "/admin/settlements", null, ALL],
        ["GET", "/admin/customers/export.csv", null, SUPER],
        ["GET", "/admin/admins", null, SUPER],
        ["POST", "/admin/admins", {}, SUPER],
        ["PATCH", "/admin/admins/999999", { name: "x" }, SUPER],
        ["POST", "/admin/orders/999999/cancel", {}, ALL],
        ["POST", "/admin/orders/999999/reassign-rider", {}, STAFF],
        ["POST", "/admin/restaurants", {}, STAFF],
        ["PATCH", "/admin/restaurants/999999", {}, STAFF],
        ["POST", "/admin/restaurants/999999/categories", {}, STAFF],
        ["DELETE", "/admin/restaurants/999999/categories/1", null, STAFF],
        ["POST", "/admin/restaurants/999999/verification", {}, STAFF],
        ["PATCH", "/admin/riders/999999", {}, STAFF],
        ["POST", "/admin/riders/999999/verification", {}, STAFF],
        ["POST", "/admin/riders/999999/settle", {}, SUPER],
        ["PATCH", "/admin/categories/999999", {}, STAFF],
        ["POST", "/admin/categories/999999/merge", {}, STAFF],
        ["POST", "/categories", {}, STAFF],
        ["POST", "/items", {}, STAFF],
        ["PATCH", "/items/999999", {}, STAFF],
        ["POST", "/uploads/image", null, STAFF],
        ["PATCH", "/admin/customers/999999", {}, STAFF],
        ["POST", "/admin/customers/999999/wallet-credit", {}, SUPER],
        ["POST", "/admin/coupons", {}, SUPER],
        ["PATCH", "/admin/coupons/999999", {}, SUPER],
      ];
      const who = { super_admin: superA, ops: opsA, support: supA };
      let wrong = [];
      for (const [method, p, body, allowed] of matrix) {
        for (const role of ALL) {
          const r = await call(who[role], method, p, body);
          const shouldPass = allowed.includes(role);
          if (shouldPass === forbidden(r)) wrong.push(`${role} ${method} ${p} -> ${r.status}${forbidden(r) ? " forbidden_role" : ""}`);
        }
      }
      const crashProbe = await call(superA, "POST", "/admin/restaurants/999999/categories", {}); // handler throws on the missing category_id
      check("a controller that throws answers 500 JSON instead of crashing the process (express-async-errors)", crashProbe.status === 500 && crashProbe.body && typeof crashProbe.body.error === "string");
      check(`permission matrix holds for all ${matrix.length * 3} role x route combinations (wrong: ${wrong.join("; ") || "none"})`, wrong.length === 0);

      // Admin management.
      const created = await call(superA, "POST", "/admin/admins", { name: "New Support", email: "new.support@rbac.test", password: "temp-password-123", role: "support" });
      check("POST /admin/admins -> 201 with the admin and no password_hash", created.status === 201 && created.body.admin.role === "support" && created.body.admin.is_active === true && !("password_hash" in created.body.admin));
      check("duplicate email (any case) -> 409", (await call(superA, "POST", "/admin/admins", { name: "Dup", email: "NEW.SUPPORT@rbac.test", password: "temp-password-123", role: "ops" })).status === 409);
      check("password under 10 chars -> 400", (await call(superA, "POST", "/admin/admins", { name: "Short", email: "short@rbac.test", password: "123456789", role: "ops" })).status === 400);
      check("unknown role -> 400", (await call(superA, "POST", "/admin/admins", { name: "Bad", email: "badrole@rbac.test", password: "temp-password-123", role: "owner" })).status === 400);
      const list = await call(superA, "GET", "/admin/admins");
      check("GET /admin/admins lists admins with last_login_at and never password_hash", list.status === 200 && list.body.admins.length >= 4 && list.body.admins.every((a) => !("password_hash" in a) && "last_login_at" in a && typeof a.is_active === "boolean"));

      // Login: new account works with its password, stamps last_login_at, returns the role.
      const loginRes = await fetch(base.replace("/api/v1", "") + "/api/v1/auth/admin/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "new.support@rbac.test", password: "temp-password-123" }) });
      const loginBody = await loginRes.json();
      check("the new admin can log in; the response carries role", loginRes.status === 200 && loginBody.user.role === "support");
      check("...and last_login_at is stamped", (await db("admins").where({ id: created.body.admin.id }).first()).last_login_at != null);

      // Guards.
      check("an admin can't change their own role -> 400", (await call(superA, "PATCH", `/admin/admins/${superA.id}`, { role: "ops" })).status === 400);
      check("an admin can't disable themselves -> 400", (await call(superA, "PATCH", `/admin/admins/${superA.id}`, { is_active: false })).status === 400);
      const noop = await call(superA, "PATCH", `/admin/admins/${superA.id}`, { name: "rbac-super", role: "super_admin" });
      check("re-sending your own current role is not a change -> 200", noop.status === 200);
      const second = await mk("rbac-super2", "super_admin");
      check("a super admin can demote another super admin while another active one remains", (await call(superA, "PATCH", `/admin/admins/${second.id}`, { role: "ops" })).status === 200);
      // superA is now the only active super_admin. The guard needs a *different* acting admin, so call the handler directly.
      const adminAdminsCtl = require("./src/controllers/adminAdmins.controller");
      const lastGuard = fakeRes();
      await adminAdminsCtl.updateAdmin({ params: { id: String(superA.id) }, body: { is_active: false }, auth: { id: second.id, type: "admin", role: "super_admin" } }, lastGuard);
      check("the last active super admin can't be disabled by someone else -> 409", lastGuard.statusCode === 409);
      const lastDemote = fakeRes();
      await adminAdminsCtl.updateAdmin({ params: { id: String(superA.id) }, body: { role: "ops" }, auth: { id: second.id, type: "admin", role: "super_admin" } }, lastDemote);
      check("...nor demoted -> 409", lastDemote.statusCode === 409);
      check("...and nothing changed", (await db("admins").where({ id: superA.id }).first()).role === "super_admin" && !!(await db("admins").where({ id: superA.id }).first()).is_active);

      // Per-request disable: an already-issued token stops working at once.
      const victim = created.body.admin.id;
      const victimTok = { token: signToken({ id: victim, type: "admin" }) };
      check("before disabling, the new admin's token works", (await call(victimTok, "GET", "/admin/dashboard")).status === 200);
      const off = await call(superA, "PATCH", `/admin/admins/${victim}`, { is_active: false });
      check("PATCH is_active:false -> 200", off.status === 200 && off.body.admin.is_active === false);
      const afterOff = await call(victimTok, "GET", "/admin/dashboard");
      check("...and that SAME already-issued token is refused immediately (401 account_disabled)", afterOff.status === 401 && afterOff.body.code === "account_disabled");
      const loginOff = await fetch(base + "/auth/admin/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "new.support@rbac.test", password: "temp-password-123" }) });
      check("a disabled admin can't log in (403)", loginOff.status === 403);
      await call(superA, "PATCH", `/admin/admins/${victim}`, { is_active: true, role: "ops" });
      check("re-enabled + role change applies to the old token on the next request (ops now can reassign)", !forbidden(await call(victimTok, "POST", "/admin/orders/999999/reassign-rider", {})));

      // Password reset by super admin + self-service change.
      await call(superA, "PATCH", `/admin/admins/${victim}`, { password: "reset-password-456" });
      const reLogin = await fetch(base + "/auth/admin/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "new.support@rbac.test", password: "reset-password-456" }) });
      check("a super-admin password reset takes effect (old password no longer needed)", reLogin.status === 200);
      check("POST /admin/me/password with the wrong current password -> 400 (not 401, which would log the panel out)", (await call(victimTok, "POST", "/admin/me/password", { current_password: "nope-nope-nope", new_password: "another-pass-789" })).status === 400);
      check("new password under 10 chars -> 400", (await call(victimTok, "POST", "/admin/me/password", { current_password: "reset-password-456", new_password: "short" })).status === 400);
      check("changing it with the right current password -> 200", (await call(victimTok, "POST", "/admin/me/password", { current_password: "reset-password-456", new_password: "another-pass-789" })).status === 200);
      const finalLogin = await fetch(base + "/auth/admin/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "new.support@rbac.test", password: "another-pass-789" }) });
      check("...and the new password is the one that logs in", finalLogin.status === 200);
      check("every role may change its own password (support included)", (await call(supA, "POST", "/admin/me/password", { current_password: "a-long-password-1", new_password: "support-new-pass-1" })).status === 200);
      check("/auth/session returns the live role", (await (await fetch(base + "/auth/session", { headers: { Authorization: `Bearer ${victimTok.token}` } })).json()).user.role === "ops");
    } finally {
      await new Promise((resolve) => server.close(resolve));
      await db("admins").where("email", "like", "%@rbac.test").delete();
    }
  }

  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Integration test crashed:", err);
  process.exit(1);
});
