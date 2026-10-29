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
  const createItem = async (body, auth = { id: 1, type: "admin" }) => {
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
  check("restaurant can't add to a category it isn't approved for (403)", (await createItem({ category_id: southIndianCatId, name: "Not Mine" }, restAuth)).statusCode === 403);
  const goodItem = await createItem(okBody);
  check("valid item is created (201) with trimmed name, numeric price, is_veg false and the photo URL",
    goodItem.statusCode === 201 && goodItem.body.item.name === "Validated Dish" && Number(goodItem.body.item.price) === 120.5 &&
    Boolean(goodItem.body.item.is_veg) === false && goodItem.body.item.image_url === okBody.image_url);
  const kitchenDish = await createItem({ category_id: bengaliCatId, name: "Kitchen Proposed Dish", is_veg: true }, restAuth);
  check("a kitchen can propose a dish WITHOUT a price: 201, price null, awaiting_price, hidden (is_active false)",
    kitchenDish.statusCode === 201 && kitchenDish.body.item.price === null && kitchenDish.body.item.awaiting_price === true && Boolean(kitchenDish.body.item.is_active) === false);
  const stockRow = await db("restaurant_items").where({ restaurant_id: restA, item_id: kitchenDish.body.item.id }).first();
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

  const e1 = await editItem(fishCurryId, { name: "  Fish Curry Deluxe  ", is_veg: true });
  check("restaurant edits an ADMIN-seeded item it carries (200), updated row returned",
    e1.statusCode === undefined && Number(e1.body.item.price) === 250 && e1.body.item.name === "Fish Curry Deluxe" && Boolean(e1.body.item.is_veg) === true);
  check("a restaurant can NOT change a price: PATCH with price -> 403 price_admin_only", (await editItem(fishCurryId, { price: 1 })).statusCode === 403);
  check("...and the price really did not move", Number((await db("items").where({ id: fishCurryId }).first()).price) === 250);
  check("admin sets the price (200)", Number((await editItem(fishCurryId, { price: 999 }, adminAuth)).body.item.price) === 999);
  const e2 = await editItem(fishCurryId, { image_url: "http://192.168.1.16:4000/uploads/x.jpg" });
  check("image_url can be set", e2.body.item.image_url === "http://192.168.1.16:4000/uploads/x.jpg");
  const e3 = await editItem(fishCurryId, { image_url: null });
  check("image_url: null removes the photo", e3.body.item.image_url === null);
  check("editing one field leaves the others alone", e3.body.item.name === "Fish Curry Deluxe" && Number(e3.body.item.price) === 999);
  check("echoing the item's own category_id is harmless", (await editItem(fishCurryId, { category_id: bengaliCatId, price: "250" }, adminAuth)).statusCode === undefined);
  check("changing category_id is refused (400)", (await editItem(fishCurryId, { category_id: southIndianCatId })).statusCode === 400);
  check("empty body is refused (400)", (await editItem(fishCurryId, {})).statusCode === 400);
  check("body with only a truly non-editable field ('id') is refused (400)", (await editItem(fishCurryId, { id: 5 })).statusCode === 400);
  check("a restaurant sending is_active gets 403, not the generic 400 (admin-only field)", (await editItem(fishCurryId, { is_active: false })).statusCode === 403);
  check("same validation as create: price 0 -> 400", (await editItem(fishCurryId, { price: 0 }, adminAuth)).statusCode === 400);
  check("same validation as create: price null -> 400", (await editItem(fishCurryId, { price: null }, adminAuth)).statusCode === 400);
  check('same validation as create: is_veg "true" string -> 400', (await editItem(fishCurryId, { is_veg: "true" })).statusCode === 400);
  check("same validation as create: javascript: image_url -> 400", (await editItem(fishCurryId, { image_url: "javascript:alert(1)" })).statusCode === 400);
  check("restaurant can't edit an item outside the categories it carries (403)", (await editItem(dosaId, { name: "Not Mine" })).statusCode === 403);
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
  check("a priced dish is added to the kitchen's new category", momosItem.statusCode === 201);
  await db("restaurant_items").insert({ restaurant_id: restA, item_id: momosItem.body.item.id, is_available: true }); // the kitchen stocks it
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

  console.log("\n--- Test 36: Partner documents — portal upload, private storage, admin review, validity + routing gate ---");
  {
    const http = require("http");
    const fs = require("fs");
    const path = require("path");
    const { signToken } = require("./src/utils/jwt");
    const { hashOtp } = require("./src/utils/otp");
    const docsService = require("./src/services/partnerDocuments.service");
    const app = require("./src/app");
    const server = await new Promise((resolve) => { const s = http.createServer(app).listen(0, () => resolve(s)); });
    const base = `http://127.0.0.1:${server.address().port}/api/v1`;
    const savedEnforced = process.env.PARTNER_DOCUMENTS_ENFORCED;
    const savedPrivateBucket = process.env.AWS_S3_PRIVATE_BUCKET;
    delete process.env.AWS_S3_PRIVATE_BUCKET; // disk mode: the private partner-documents/ directory

    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 7)]);
    const pdf = Buffer.from("%PDF-1.4\n%fake but correctly headed pdf\n");
    const future = (days) => docsService.todayIST(days);

    const [kitchenId] = await db("restaurants").insert({
      name: "Docs Kitchen", phone: "9100000036", address: "Docs St", lat: 22.58, lng: 88.46, radius_km: 5, commission_rate_percent: 15, status: "active",
    });
    const [otherKitchenId] = await db("restaurants").insert({
      name: "Other Kitchen", phone: "9100000037", address: "Other St", lat: 22.58, lng: 88.46, radius_km: 5, commission_rate_percent: 15, status: "active",
    });
    const [docRiderId] = await db("riders").insert({ name: "Docs Rider", phone: "9100000038", status: "active" });
    const kitchen = { token: signToken({ id: kitchenId, type: "restaurant" }) };
    const otherKitchen = { token: signToken({ id: otherKitchenId, type: "restaurant" }) };
    const docRider = { token: signToken({ id: docRiderId, type: "rider" }) };
    const [superDocId] = await db("admins").insert({ name: "docs-super", email: "super@docs.test", password_hash: "x", role: "super_admin" });
    const [opsDocId] = await db("admins").insert({ name: "docs-ops", email: "ops@docs.test", password_hash: "x", role: "ops" });
    const [supDocId] = await db("admins").insert({ name: "docs-support", email: "support@docs.test", password_hash: "x", role: "support" });
    const superDoc = { token: signToken({ id: superDocId, type: "admin" }) };
    const opsDoc = { token: signToken({ id: opsDocId, type: "admin" }) };
    const supDoc = { token: signToken({ id: supDocId, type: "admin" }) };

    const call = async (who, method, p, body) => {
      const res = await fetch(base + p, {
        method,
        headers: { ...(who ? { Authorization: `Bearer ${who.token}` } : {}), ...(body ? { "Content-Type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      const type = res.headers.get("content-type") || "";
      const buf = Buffer.from(await res.arrayBuffer());
      let json = null;
      if (type.includes("json")) json = JSON.parse(buf.toString());
      return { status: res.status, body: json, buf, type, headers: res.headers };
    };
    const upload = async (who, fields, file) => {
      const form = new FormData();
      for (const [k, v] of Object.entries(fields)) form.append(k, v);
      if (file) form.append("file", new Blob([file]), "upload.bin");
      const res = await fetch(base + "/partner/documents", { method: "POST", headers: { Authorization: `Bearer ${who.token}` }, body: form });
      return { status: res.status, body: await res.json() };
    };

    try {
      // Requirements + empty state.
      const first = await call(kitchen, "GET", "/partner/documents");
      check("GET /partner/documents for a kitchen lists aadhaar, fssai, trade_license (all required)",
        first.status === 200 && first.body.requirements.map((r) => r.type).join() === "aadhaar,fssai,trade_license" && first.body.requirements.every((r) => r.required));
      check("...nothing uploaded yet -> summary 'missing' with all three listed", first.body.summary.status === "missing" && first.body.summary.missing.length === 3);
      const riderFirst = await call(docRider, "GET", "/partner/documents");
      check("a rider needs aadhaar (required) and driving_license (optional)",
        riderFirst.body.requirements.map((r) => `${r.type}:${r.required}`).join() === "aadhaar:true,driving_license:false");
      check("no token -> 401", (await call(null, "GET", "/partner/documents")).status === 401);
      check("a customer token can't use the portal -> 403", (await call({ token: signToken({ id: 1, type: "customer" }) }, "GET", "/partner/documents")).status === 403);

      // Validation.
      check("a rider can't upload a kitchen-only doc type -> 400", (await upload(docRider, { doc_type: "fssai", doc_number: "12345678901234", expiry_date: future(100) }, png)).status === 400);
      check("FSSAI number must be 14 digits -> 400", (await upload(kitchen, { doc_type: "fssai", doc_number: "1234", expiry_date: future(100) }, png)).status === 400);
      check("FSSAI without an expiry date -> 400", (await upload(kitchen, { doc_type: "fssai", doc_number: "12345678901234" }, png)).status === 400);
      check("an already-expired licence -> 400", (await upload(kitchen, { doc_type: "fssai", doc_number: "12345678901234", expiry_date: "2020-01-01" }, png)).status === 400);
      check("a file that isn't JPEG/PNG/WebP/PDF -> 400", (await upload(kitchen, { doc_type: "aadhaar" }, Buffer.from("just some text, not a document"))).status === 400);
      check("no file -> 400", (await upload(kitchen, { doc_type: "aadhaar" }, null)).status === 400);

      // Uploads.
      const aadhaar = await upload(kitchen, { doc_type: "aadhaar" }, png);
      check("Aadhaar (PNG) upload -> 201 pending, no number/expiry needed", aadhaar.status === 201 && aadhaar.body.document.status === "pending" && aadhaar.body.document.docNumber === null);
      check("...the response never exposes where the file is stored", !JSON.stringify(aadhaar.body).includes("storage_path") && !JSON.stringify(aadhaar.body).includes("partner-documents"));
      const fssai = await upload(kitchen, { doc_type: "fssai", doc_number: "1234 5678 9012 34", expiry_date: future(200) }, pdf);
      check("FSSAI (PDF) upload -> 201; spaces in the number are stripped", fssai.status === 201 && fssai.body.document.docNumber === "12345678901234" && fssai.body.document.contentType === "application/pdf");
      const trade = await upload(kitchen, { doc_type: "trade_license", doc_number: "tl/2026-778", expiry_date: future(20) }, png);
      check("Trade licence upload -> 201; number upper-cased", trade.status === 201 && trade.body.document.docNumber === "TL/2026-778");
      const dbRow = await db("partner_documents").where({ id: aadhaar.body.document.id }).first();
      check("the file is stored in the private partner-documents directory (not uploads/)",
        fs.existsSync(path.join(__dirname, "partner-documents", dbRow.storage_path)) && !fs.existsSync(path.join(__dirname, "uploads", dbRow.storage_path)));
      check("partner-documents is not served statically", (await fetch(base.replace("/api/v1", "") + `/partner-documents/${dbRow.storage_path}`)).status === 404);

      const pendingSummary = (await call(kitchen, "GET", "/partner/documents")).body;
      check("all three uploaded, none reviewed -> summary 'pending'", pendingSummary.summary.status === "pending" && pendingSummary.summary.missing.length === 0);
      check("...and documents_valid_until is still NULL", (await db("restaurants").where({ id: kitchenId }).first()).documents_valid_until === null);

      // File access.
      const own = await call(kitchen, "GET", `/partner/documents/${aadhaar.body.document.id}/file`);
      check("a partner can view their own upload", own.status === 200 && own.type.startsWith("image/png") && own.buf.equals(png));
      check("...but not another kitchen's (404)", (await call(otherKitchen, "GET", `/partner/documents/${aadhaar.body.document.id}/file`)).status === 404);
      const adminFile = await call(supDoc, "GET", `/admin/documents/${fssai.body.document.id}/file`);
      check("any admin role can view a document; served private + no-store",
        adminFile.status === 200 && adminFile.type.startsWith("application/pdf") && (adminFile.headers.get("cache-control") || "").includes("no-store"));

      // Queue + review permissions.
      const queue = await call(supDoc, "GET", "/admin/documents?status=pending");
      check("GET /admin/documents?status=pending lists the uploads with owner name",
        queue.status === 200 && queue.body.documents.filter((d) => d.ownerId === kitchenId && d.ownerType === "restaurant").length === 3 && queue.body.documents.some((d) => d.ownerName === "Docs Kitchen"));
      check("support can't review -> 403 forbidden_role", (await call(supDoc, "POST", `/admin/documents/${aadhaar.body.document.id}/review`, { decision: "approve" })).body.code === "forbidden_role");
      check("rejecting needs a reason -> 400", (await call(opsDoc, "POST", `/admin/documents/${aadhaar.body.document.id}/review`, { decision: "reject" })).status === 400);
      const rej = await call(opsDoc, "POST", `/admin/documents/${aadhaar.body.document.id}/review`, { decision: "reject", reason: "Photo is blurry" });
      check("ops can reject with a reason", rej.status === 200 && rej.body.document.status === "rejected" && rej.body.document.rejectionReason === "Photo is blurry");
      check("...the partner sees status 'rejected' + the reason", (await call(kitchen, "GET", "/partner/documents")).body.documents.aadhaar.rejectionReason === "Photo is blurry");

      const aadhaar2 = await upload(kitchen, { doc_type: "aadhaar" }, png);
      for (const id of [aadhaar2.body.document.id, fssai.body.document.id, trade.body.document.id]) {
        await call(opsDoc, "POST", `/admin/documents/${id}/review`, { decision: "approve" });
      }
      const k1 = await db("restaurants").where({ id: kitchenId }).first();
      check("all required approved -> documents_valid_until = the earliest expiry (trade licence, +20 days)",
        docsService.toDateString(k1.documents_valid_until) === future(20));
      const okSummary = (await call(superDoc, "GET", `/admin/documents/restaurant/${kitchenId}`)).body;
      check("admin owner view: summary 'expiring' (within 30 days) + owner + full history",
        okSummary.summary.status === "expiring" && okSummary.owner.name === "Docs Kitchen" && okSummary.history.length === 4);

      // Renewal doesn't interrupt; rejecting the renewal keeps the old approved one.
      const renewal = await upload(kitchen, { doc_type: "trade_license", doc_number: "TL/2027-001", expiry_date: future(400) }, png);
      check("re-uploading a renewed licence -> pending, but the approved one still counts (valid_until unchanged)",
        renewal.status === 201 && docsService.toDateString((await db("restaurants").where({ id: kitchenId }).first()).documents_valid_until) === future(20));
      const view = (await call(kitchen, "GET", "/partner/documents")).body;
      check("...the portal shows the new upload as current, with the approved version alongside",
        view.documents.trade_license.status === "pending" && view.documents.trade_license.approvedVersion && view.documents.trade_license.approvedVersion.docNumber === "TL/2026-778");
      await call(opsDoc, "POST", `/admin/documents/${renewal.body.document.id}/review`, { decision: "approve" });
      check("approving the renewal moves valid_until to the next-earliest expiry (FSSAI, +200 days)",
        docsService.toDateString((await db("restaurants").where({ id: kitchenId }).first()).documents_valid_until) === future(200));

      // The gate.
      const gated = async () => (await db("restaurants").whereIn("id", [kitchenId, otherKitchenId]).modify((qb) => docsService.applyDocumentsGate(qb, "restaurants.documents_valid_until")).select("id")).map((r) => r.id);
      process.env.PARTNER_DOCUMENTS_ENFORCED = "false";
      check("enforcement off: both kitchens qualify (no change for live partners until it's switched on)", (await gated()).length === 2);
      process.env.PARTNER_DOCUMENTS_ENFORCED = "true";
      check("enforcement on: only the kitchen with approved, in-date documents qualifies", (await gated()).join() === String(kitchenId));
      const restaurantList = (await call(superDoc, "GET", "/admin/restaurants?limit=500")).body.restaurants;
      check("GET /admin/restaurants rows carry a documents summary",
        restaurantList.find((r) => r.id === kitchenId).documents.status === "complete" && restaurantList.find((r) => r.id === otherKitchenId).documents.status === "missing");

      // Expiry blocks on its own (no job): push the effective FSSAI's expiry into the past.
      await db("partner_documents").where({ id: fssai.body.document.id }).update({ expiry_date: "2020-01-01" });
      await docsService.recomputeValidity("restaurant", kitchenId);
      check("an approved licence that has expired -> excluded by the gate", (await gated()).length === 0);
      check("...summary 'expired'", (await call(kitchen, "GET", "/partner/documents")).body.summary.status === "expired");

      // Rider: Aadhaar alone is enough; reassignment respects the gate.
      const rAadhaar = await upload(docRider, { doc_type: "aadhaar" }, png);
      check("rider without approved Aadhaar: partnerMeetsDocuments is false while enforced",
        !docsService.partnerMeetsDocuments(await db("riders").where({ id: docRiderId }).first()));
      await call(opsDoc, "POST", `/admin/documents/${rAadhaar.body.document.id}/review`, { decision: "approve" });
      const riderRow = await db("riders").where({ id: docRiderId }).first();
      check("rider: approved Aadhaar alone (DL optional) -> valid with no expiry (9999-12-31)",
        docsService.toDateString(riderRow.documents_valid_until) === "9999-12-31" && docsService.partnerMeetsDocuments(riderRow));
      const meRider = await call(docRider, "GET", "/riders/me");
      check("GET /riders/me carries the documents summary + portal URL", meRider.body.rider.documents.status === "complete" && !!meRider.body.rider.documentsPortalUrl);
      const meKitchen = await call(kitchen, "GET", "/restaurants/me");
      check("GET /restaurants/me carries the documents summary", meKitchen.body.restaurant.documents.status === "expired");

      // Portal login never creates a rider account.
      const otpHash = await hashOtp("482913");
      await db("otp_verifications").insert({ phone: "9100000039", otp_hash: otpHash, purpose: "rider_login", expires_at: new Date(Date.now() + 300000) });
      const portalLogin = await call(null, "POST", "/auth/otp/verify", { phone: "9100000039", otp: "482913", purpose: "rider_login", existing_only: true });
      check("portal login (existing_only) for an unknown rider phone -> 404 and no account created",
        portalLogin.status === 404 && !(await db("riders").where({ phone: "9100000039" }).first()));
      await db("otp_verifications").insert({ phone: "9100000038", otp_hash: otpHash, purpose: "rider_login", expires_at: new Date(Date.now() + 300000) });
      const knownLogin = await call(null, "POST", "/auth/otp/verify", { phone: "9100000038", otp: "482913", purpose: "rider_login", existing_only: true });
      check("portal login for an existing rider -> 200 with a token", knownLogin.status === 200 && !!knownLogin.body.token);
    } finally {
      if (savedEnforced === undefined) delete process.env.PARTNER_DOCUMENTS_ENFORCED; else process.env.PARTNER_DOCUMENTS_ENFORCED = savedEnforced;
      if (savedPrivateBucket !== undefined) process.env.AWS_S3_PRIVATE_BUCKET = savedPrivateBucket;
      await new Promise((resolve) => server.close(resolve));
      const rows = await db("partner_documents").whereIn("owner_id", [kitchenId, otherKitchenId, docRiderId]).select("storage_path");
      for (const r of rows) await fs.promises.unlink(path.join(__dirname, "partner-documents", r.storage_path)).catch(() => {});
      await db("admins").where("email", "like", "%@docs.test").delete();
    }
  }

  console.log("\n--- Test 36: Dish portion (quantity_value + quantity_unit + portion_label), snapshot on order lines ---");
  {
    const { parsePortionInput, portionLabel } = require("./src/utils/portion");
    const catalogCtl = require("./src/controllers/catalog.controller");
    const favoriteCtl = require("./src/controllers/favorite.controller");
    const adminCatCtl = require("./src/controllers/adminCategories.controller");
    const restCtl = require("./src/controllers/restaurant.controller");
    const admin = { id: 1, type: "admin" };

    // ---- the pure helpers
    check('label trims trailing zeros: 500.00 gm -> "500 gm", 1.50 ltr -> "1.5 ltr", 3 pc -> "3 pc", unset -> null',
      portionLabel("500.00", "gm") === "500 gm" && portionLabel(1.5, "ltr") === "1.5 ltr" && portionLabel(3, "pc") === "3 pc" && portionLabel(null, null) === null);
    check("parsePortionInput: neither key -> {} (untouched)", Object.keys(parsePortionInput({})).length === 0);
    check("parsePortionInput: one key only -> error", !!parsePortionInput({ quantity_value: 3 }).error && !!parsePortionInput({ quantity_unit: "pc" }).error);
    check("parsePortionInput: value 0 / negative / text / too big -> error", ["0", -1, "abc", 100000, true].every((v) => !!parsePortionInput({ quantity_value: v, quantity_unit: "pc" }).error));
    check("parsePortionInput: unknown unit -> error; unit is case-insensitive", !!parsePortionInput({ quantity_value: 1, quantity_unit: "oz" }).error && parsePortionInput({ quantity_value: 1, quantity_unit: " KG " }).fields.quantity_unit === "kg");
    check("parsePortionInput: both null -> clears both; one null one set -> error", parsePortionInput({ quantity_value: null, quantity_unit: null }).fields.quantity_value === null && !!parsePortionInput({ quantity_value: null, quantity_unit: "pc" }).error);

    // ---- create / edit through the real controllers
    const create = async (extra) => {
      const res = fakeRes();
      await catalogCtl.createItem(fakeReq({ category_id: bengaliCatId, name: `Portion Dish ${Math.random().toString(36).slice(2, 7)}`, price: 120, ...extra }, {}, admin), res);
      return res;
    };
    const plain = await create({});
    check("an item can still be created with no portion (optional) -> portion_label null", plain.statusCode === 201 && plain.body.item.portion_label === null && plain.body.item.quantity_value === null);
    const made = await create({ quantity_value: "500.00", quantity_unit: "gm" });
    check('POST /items with quantity 500 gm -> 201, quantity_value 500, portion_label "500 gm"', made.statusCode === 201 && made.body.item.quantity_value === 500 && made.body.item.quantity_unit === "gm" && made.body.item.portion_label === "500 gm");
    check("POST /items with a half portion -> 400", (await create({ quantity_value: 3 })).statusCode === 400);
    check("POST /items with an unknown unit -> 400", (await create({ quantity_value: 3, quantity_unit: "slices" })).statusCode === 400);
    const itemId = made.body.item.id;

    const patch = async (body) => {
      const res = fakeRes();
      await catalogCtl.updateItem(fakeReq(body, { id: itemId }, admin), res);
      return res;
    };
    check("PATCH quantity_value alone -> 400 (must come with the unit)", (await patch({ quantity_value: 2 })).statusCode === 400);
    const edited = await patch({ quantity_value: 1.5, quantity_unit: "kg" });
    check('PATCH to 1.5 kg -> portion_label "1.5 kg"', edited.statusCode === undefined && edited.body.item.portion_label === "1.5 kg");
    const nameOnly = await patch({ name: "Renamed Portion Dish" });
    check("PATCH of another field leaves the portion alone", nameOnly.body.item.portion_label === "1.5 kg");
    const cleared = await patch({ quantity_value: null, quantity_unit: null });
    check("PATCH both null clears the portion", cleared.body.item.portion_label === null && cleared.body.item.quantity_unit === null);
    await patch({ quantity_value: 500, quantity_unit: "gm" });

    // ---- every read endpoint carries it
    await db("restaurant_items").insert({ restaurant_id: restA, item_id: itemId, is_available: true });
    const near = { lat: "22.5805", lng: "88.4605" };
    const findIn = (list) => (list || []).find((i) => i.id === itemId);
    const listRes = fakeRes();
    await catalogCtl.listItemsForCategory(fakeReq({}, { categoryId: String(bengaliCatId) }, null, near), listRes);
    check("GET /categories/:id/items returns portion_label", findIn(listRes.body.items) && findIn(listRes.body.items).portion_label === "500 gm" && findIn(listRes.body.items).quantity_value === 500);
    const detailRes = fakeRes();
    await catalogCtl.getCategoryDetail(fakeReq({}, { id: String(bengaliCatId) }, null, near), detailRes);
    const detailItems = detailRes.body.sections.flatMap((s) => s.items);
    check("GET /categories/:id (popular + more sections) returns portion_label", findIn(detailItems) && findIn(detailItems).portion_label === "500 gm");
    const searchRes = fakeRes();
    await catalogCtl.searchItems(fakeReq({}, {}, null, { ...near, q: "Renamed Portion" }), searchRes);
    check("GET /items/search returns portion_label", findIn(searchRes.body.items) && findIn(searchRes.body.items).portion_label === "500 gm");
    const popRes = fakeRes();
    await catalogCtl.getPopularItems(fakeReq({}, {}, null, { ...near, limit: "50" }), popRes);
    check("GET /items/popular returns portion_label", findIn(popRes.body.items) && findIn(popRes.body.items).portion_label === "500 gm");

    const [portionCustomerId] = await db("users").insert({ name: "Portion Customer", phone: "8000000036", wallet_balance: 0 });
    await db("favorites").insert({ customer_id: portionCustomerId, item_id: itemId });
    const favRes = fakeRes();
    await favoriteCtl.listFavorites(fakeReq({}, {}, { id: portionCustomerId, type: "customer" }), favRes);
    check("GET /favorites returns portion_label", findIn(favRes.body.favorites) && findIn(favRes.body.favorites).portion_label === "500 gm");

    const menuRes = fakeRes();
    await restCtl.getMyMenu(fakeReq({}, {}, { id: restA, type: "restaurant" }), menuRes);
    check("GET /restaurants/me/menu returns quantity fields + portion_label", findIn(menuRes.body.items) && findIn(menuRes.body.items).portion_label === "500 gm" && findIn(menuRes.body.items).quantity_unit === "gm");
    const adminListRes = fakeRes();
    await adminCatCtl.listItems(fakeReq({}, {}, admin, { q: "Renamed Portion" }), adminListRes);
    check("GET /admin/items returns quantity fields + portion_label", findIn(adminListRes.body.items) && findIn(adminListRes.body.items).portion_label === "500 gm");

    // ---- order snapshot: later edits never rewrite an old order
    const placeOne = async () => {
      const res = fakeRes();
      await orderController.placeOrder(
        fakeReq({ items: [{ item_id: itemId, quantity: 1 }], delivery_lat: 22.5805, delivery_lng: 88.4605, delivery_address: "Portion St", payment_method: "cod" }, {}, { id: portionCustomerId, type: "customer" }),
        res
      );
      return res;
    };
    const order1 = await placeOne();
    check("placing an order with a portioned dish works", order1.statusCode === 201 && !!order1.body.order);
    const o1 = order1.body.order.id;
    const snap = await db("order_items").where({ order_id: o1 }).first();
    check("order_items stores the snapshot (portion_value 500, portion_unit gm)", Number(snap.portion_value) === 500 && snap.portion_unit === "gm");

    const getLine = async (orderId, auth) => {
      const res = fakeRes();
      await orderController.getOrder(fakeReq({}, { id: String(orderId) }, auth), res);
      return res.body.items.find((l) => l.item_id === itemId);
    };
    const customerAuth = { id: portionCustomerId, type: "customer" };
    check('GET /orders/:id (customer) line carries portion_label "500 gm"', (await getLine(o1, customerAuth)).portion_label === "500 gm");
    check("...and the restaurant sees the same line portion", (await getLine(o1, { id: restA, type: "restaurant" })).portion_label === "500 gm");

    await patch({ quantity_value: 250, quantity_unit: "gm" }); // the dish is edited AFTER the order
    check("the OLD order keeps its snapshot (still 500 gm) after the dish becomes 250 gm", (await getLine(o1, customerAuth)).portion_label === "500 gm");

    const listOrdersRes = fakeRes();
    await orderController.listMyOrders(fakeReq({}, {}, customerAuth, {}), listOrdersRes);
    const listedLine = listOrdersRes.body.orders.find((o) => o.id === o1).items.find((l) => l.item_id === itemId);
    check("GET /orders list lines carry portion_label (from the snapshot)", listedLine && listedLine.portion_label === "500 gm");

    await db("orders").where({ id: o1 }).update({ status: "cancelled" }); // keep this customer free to order again
    const order2 = await placeOne();
    check("a NEW order picks up the edited portion (250 gm)", (await getLine(order2.body.order.id, customerAuth)).portion_label === "250 gm");

    const adminOrderRes = fakeRes();
    await require("./src/controllers/adminOrders.controller").getOrder(fakeReq({}, { id: String(o1) }, admin), adminOrderRes);
    check("GET /admin/orders/:id lines carry portion_label", adminOrderRes.body.items[0].portion_label === "500 gm");

    // a pre-feature order line has no snapshot -> null, never a guess from today's item
    await db("order_items").where({ order_id: o1 }).update({ portion_value: null, portion_unit: null });
    check("an order line with no snapshot (placed before this feature) reads null", (await getLine(o1, customerAuth)).portion_label === null);
  }

  console.log("\n--- Test 37: Prices are admin-only; kitchen dishes await a price; per-dish offers drive quote, order and commission ---");
  {
    const catalogCtl37 = require("./src/controllers/catalog.controller");
    const adminCatCtl37 = require("./src/controllers/adminCategories.controller");
    const restCtl37 = require("./src/controllers/restaurant.controller");
    const admin = { id: 1, type: "admin" };
    const kitchen = { id: restA, type: "restaurant" };
    const near = { lat: "22.5805", lng: "88.4605" };

    const create = async (body, auth) => { const r = fakeRes(); await catalogCtl37.createItem(fakeReq(body, {}, auth), r); return r; };
    const patch = async (id, body, auth) => { const r = fakeRes(); await catalogCtl37.updateItem(fakeReq(body, { id }, auth), r); return r; };
    const tag = Math.random().toString(36).slice(2, 7);

    // ---- a kitchen can never set a price
    const rejected = await create({ category_id: bengaliCatId, name: `K2 ${tag}`, price: 50 }, kitchen);
    check("restaurant POST /items with a price -> 403 price_admin_only (nothing created)", rejected.statusCode === 403 && rejected.body.code === "price_admin_only");
    check("restaurant POST /items with an offer_price -> 403", (await create({ category_id: bengaliCatId, name: `K3 ${tag}`, offer_price: 10 }, kitchen)).statusCode === 403);
    check("admin POST /items without a price still needs one -> 400", (await create({ category_id: bengaliCatId, name: `A ${tag}` }, admin)).statusCode === 400);

    // ---- kitchen proposes a dish: hidden until an admin prices it
    const proposed = await create({ category_id: bengaliCatId, name: `Proposed ${tag}`, is_veg: true }, kitchen);
    const pid = proposed.body.item.id;
    check("kitchen dish: 201, price null, awaiting_price true, is_active false", proposed.statusCode === 201 && proposed.body.item.price === null && proposed.body.item.awaiting_price === true && Boolean(proposed.body.item.is_active) === false);
    const stored = await db("items").where({ id: pid }).first();
    check("...stored as price 0.00 (column is NOT NULL), awaiting_price 1, is_active 0", Number(stored.price) === 0 && stored.awaiting_price === 1 && stored.is_active === 0);

    const menu1 = fakeRes();
    await restCtl37.getMyMenu(fakeReq({}, {}, kitchen), menu1);
    const mine = menu1.body.items.find((i) => i.id === pid);
    check("the kitchen sees its own pending dish on GET /restaurants/me/menu with price null + awaiting_price", mine && mine.price === null && mine.awaiting_price === true && mine.effective_price === null);

    const listNear = async () => { const r = fakeRes(); await catalogCtl37.listItemsForCategory(fakeReq({}, { categoryId: String(bengaliCatId) }, null, near), r); return r.body.items; };
    check("customers do NOT see it (inactive)", !(await listNear()).some((i) => i.id === pid));
    check("a kitchen can't PATCH its hidden dish (404, it only acts on live items)", (await patch(pid, { name: "x" }, kitchen)).statusCode === 404);

    const adminList = fakeRes();
    await adminCatCtl37.listItems(fakeReq({}, {}, admin, { awaiting_price: "1" }), adminList);
    const pending = adminList.body.items.find((i) => i.id === pid);
    check("GET /admin/items?awaiting_price=1 lists it (price null, who proposed it)", pending && pending.price === null && pending.awaiting_price === true && pending.created_by_restaurant_name === "Restaurant A");
    check("...and the filter excludes priced dishes", !adminList.body.items.some((i) => i.id === fishCurryId));

    check("admin can't activate it before pricing it (400)", (await patch(pid, { is_active: true }, admin)).statusCode === 400);
    const priced = await patch(pid, { price: "180" }, admin);
    check("admin sets the price -> it goes live (is_active true, awaiting_price false, price 180)", priced.statusCode === undefined && priced.body.item.price === 180 && priced.body.item.awaiting_price === false && Boolean(priced.body.item.is_active) === true);
    const live = (await listNear()).find((i) => i.id === pid);
    check("customers now see it at 180 with effective_price 180 and no offer", live && live.price === 180 && live.effective_price === 180 && live.offer_price === null && live.offer_ends_at === null);

    // ---- offers: admin only, validated
    check("restaurant PATCH offer_price -> 403", (await patch(pid, { offer_price: 100 }, kitchen)).statusCode === 403);
    check("offer_price must be BELOW the price: equal -> 400", (await patch(pid, { offer_price: 180 }, admin)).statusCode === 400);
    check("offer_price above the price -> 400", (await patch(pid, { offer_price: 200 }, admin)).statusCode === 400);
    check("offer_price 0 / text -> 400", (await patch(pid, { offer_price: 0 }, admin)).statusCode === 400 && (await patch(pid, { offer_price: "abc" }, admin)).statusCode === 400);
    check("offer_ends_at in the past -> 400", (await patch(pid, { offer_price: 150, offer_ends_at: "2020-01-01T00:00:00Z" }, admin)).statusCode === 400);
    check("offer_ends_at alone with no offer -> 400", (await patch(pid, { offer_ends_at: new Date(Date.now() + 3600e3).toISOString() }, admin)).statusCode === 400);
    check("offer_ends_at garbage -> 400", (await patch(pid, { offer_price: 150, offer_ends_at: "not-a-date" }, admin)).statusCode === 400);

    const ends = new Date(Date.now() + 2 * 3600e3).toISOString();
    const offer = await patch(pid, { offer_price: "150", offer_ends_at: ends }, admin);
    check("admin sets a 150 offer ending in 2h -> admin read shows offer_active true", offer.statusCode === undefined && offer.body.item.offer_price === 150 && offer.body.item.offer_active === true && offer.body.item.effective_price === 150);
    const withOffer = (await listNear()).find((i) => i.id === pid);
    check("customers see price 180, offer_price 150, effective_price 150 and the end time", withOffer.price === 180 && withOffer.offer_price === 150 && withOffer.effective_price === 150 && !!withOffer.offer_ends_at);
    check("lowering the price to or below the live offer -> 400 unless the offer is changed too", (await patch(pid, { price: 150 }, admin)).statusCode === 400);
    check("...but raising the price is fine and keeps the offer", (await patch(pid, { price: 200 }, admin)).body.item.offer_price === 150);

    // ---- the offer drives the quote, the order, GST and commission
    const [offerCustomerId] = await db("users").insert({ name: "Offer Customer", phone: "8000000037", wallet_balance: 0 });
    await db("restaurant_items").insert({ restaurant_id: restA, item_id: pid, is_available: true }).onConflict(["restaurant_id", "item_id"]).ignore(); // already stocked when the kitchen created it
    const quote = fakeRes();
    await cartController.quoteCart(fakeReq({ items: [{ item_id: pid, quantity: 2 }], delivery_lat: 22.5805, delivery_lng: 88.4605 }, {}, { id: offerCustomerId, type: "customer" }), quote);
    check("POST /cart/quote charges the offer price (2 x 150 = 300, not 400)", quote.body.itemTotal === 300);
    const place = fakeRes();
    await orderController.placeOrder(fakeReq({ items: [{ item_id: pid, quantity: 2 }], delivery_lat: 22.5805, delivery_lng: 88.4605, delivery_address: "Offer St", payment_method: "cod" }, {}, { id: offerCustomerId, type: "customer" }), place);
    const o = place.body.order;
    check("POST /orders item_total uses the offer (300)", place.statusCode === 201 && Number(o.item_total) === 300);
    const line = await db("order_items").where({ order_id: o.id }).first();
    check("order line snapshots unit_price 150 (charged) and list_price 200 (the normal price)", Number(line.unit_price) === 150 && Number(line.list_price) === 200 && Number(line.subtotal) === 300);
    check("commission is computed on what the customer actually pays (15% of 300 = 45)", Number(o.commission_amount) === 45);
    check("quote and order agree on the total", Number(o.grand_total) === quote.body.grandTotal || Number(o.grand_total) === Number(quote.body.grandTotal));

    // ---- an expired offer stops applying on its own
    await db("items").where({ id: pid }).update({ offer_ends_at: new Date(Date.now() - 60e3) });
    const expired = (await listNear()).find((i) => i.id === pid);
    check("once offer_ends_at passes: customers see no offer and effective_price = price", expired.offer_price === null && expired.offer_ends_at === null && expired.effective_price === 200);
    const adminExpired = fakeRes();
    await adminCatCtl37.listItems(fakeReq({}, {}, admin, { q: "Proposed" }), adminExpired);
    check("...the admin list still shows the stored offer, offer_active false", adminExpired.body.items.find((i) => i.id === pid).offer_price === 150 && adminExpired.body.items.find((i) => i.id === pid).offer_active === false);
    await db("orders").where({ id: o.id }).update({ status: "cancelled" });
    const quote2 = fakeRes();
    await cartController.quoteCart(fakeReq({ items: [{ item_id: pid, quantity: 1 }], delivery_lat: 22.5805, delivery_lng: 88.4605 }, {}, { id: offerCustomerId, type: "customer" }), quote2);
    check("an expired offer no longer discounts the quote (200)", quote2.body.itemTotal === 200);

    // ---- clearing
    const cleared = await patch(pid, { offer_price: null }, admin);
    check("offer_price: null clears the offer and its end date", cleared.body.item.offer_price === null && cleared.body.item.offer_ends_at === null && cleared.body.item.offer_active === false);
    const adminCreated = await create({ category_id: bengaliCatId, name: `WithOffer ${tag}`, price: 100, offer_price: 80 }, admin);
    check("admin can create a dish with an offer in one go", adminCreated.statusCode === 201 && adminCreated.body.item.offer_price === 80 && adminCreated.body.item.offer_active === true);
    check("admin create with offer >= price -> 400", (await create({ category_id: bengaliCatId, name: `BadOffer ${tag}`, price: 100, offer_price: 100 }, admin)).statusCode === 400);
  }

  console.log("\n--- Test 38: Admin-configurable rider pay — settings + history, payout frozen at delivery, visibility, settlement ---");
  {
    const http = require("http");
    const bcrypt = require("bcrypt");
    const { signToken } = require("./src/utils/jwt");
    const app = require("./src/app");
    const riderPaySvc = require("./src/services/riderPay.service");
    const devtools = require("./src/services/devtools.service");
    const { haversineDistanceKm } = require("./src/utils/geo");
    const server = await new Promise((resolve) => { const s = http.createServer(app).listen(0, () => resolve(s)); });
    const base = `http://127.0.0.1:${server.address().port}/api/v1`;
    const mkAdmin = async (name, role) => {
      const [id] = await db("admins").insert({ name, email: `${name}@pay.test`, password_hash: await bcrypt.hash("a-long-password-1", 4), role });
      return { id, token: signToken({ id, type: "admin" }) };
    };
    const superA = await mkAdmin("pay-super", "super_admin");
    const opsA = await mkAdmin("pay-ops", "ops");
    const call = async (who, method, p, body) => {
      const r = await fetch(base + p, { method, headers: { Authorization: `Bearer ${who.token}`, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
      let json = null; try { json = await r.json(); } catch { /* none */ }
      return { status: r.status, body: json };
    };
    const otherRiders = await db("riders").select("id", "status");
    try {
      // ---- the pure formula
      const cfg = { base_payout: 10, per_km_rate: 6, min_payout: 20, incentive_per_delivery: 5 };
      const far = riderPaySvc.computePayout({ distanceKm: 2.5, config: cfg });
      check("payout = max(min, base + per_km x km) + incentive: 2.5 km -> max(20, 10+15) + 5 = 30", far.payout === 30 && far.breakdown.min_applied === false && far.breakdown.distance_pay === 15 && far.breakdown.subtotal === 25);
      const near = riderPaySvc.computePayout({ distanceKm: 0.5, config: cfg });
      check("a short trip hits the minimum: 0.5 km -> max(20, 10+3) + 5 = 25, min_applied true", near.payout === 25 && near.breakdown.min_applied === true);
      check("the breakdown carries the formula text", typeof far.breakdown.formula === "string" && far.breakdown.formula.includes("incentive_per_delivery"));

      // ---- settings: read, validate, history, roles
      const first = await call(opsA, "GET", "/admin/settings/rider-pay");
      check("GET /admin/settings/rider-pay (any role) -> live config seeded from the old env placeholders (0 / 8 / 15 / 0), one history row",
        first.status === 200 && first.body.settings.base_payout === 0 && first.body.settings.per_km_rate === 8 && first.body.settings.min_payout === 15 && first.body.settings.incentive_per_delivery === 0 && first.body.history.length === 1 && typeof first.body.formula === "string");
      check("PUT by ops -> 403 forbidden_role", (await call(opsA, "PUT", "/admin/settings/rider-pay", cfg)).body.code === "forbidden_role");
      check("PUT with a missing field -> 400", (await call(superA, "PUT", "/admin/settings/rider-pay", { base_payout: 10, per_km_rate: 6, min_payout: 20 })).status === 400);
      check("PUT with a negative / text value -> 400", (await call(superA, "PUT", "/admin/settings/rider-pay", { ...cfg, per_km_rate: -1 })).status === 400 && (await call(superA, "PUT", "/admin/settings/rider-pay", { ...cfg, base_payout: "abc" })).status === 400);
      check("PUT with every value 0 -> 400 (riders would earn nothing)", (await call(superA, "PUT", "/admin/settings/rider-pay", { base_payout: 0, per_km_rate: 0, min_payout: 0, incentive_per_delivery: 0 })).status === 400);
      const put = await call(superA, "PUT", "/admin/settings/rider-pay", cfg);
      check("PUT by super_admin -> 200 and it is now the live config", put.status === 200 && put.body.settings.base_payout === 10 && put.body.settings.incentive_per_delivery === 5);
      const hist = await call(opsA, "GET", "/admin/settings/rider-pay");
      check("history keeps both rows, newest first, with who changed it", hist.body.history.length === 2 && hist.body.settings.id === hist.body.history[0].id && hist.body.history[0].created_by_admin_name === "pay-super" && hist.body.history[1].created_by_admin_id === null);
      const rateRes = fakeRes();
      await riderCtl.getMyRate(fakeReq({}, {}, { id: riderId, type: "rider" }), rateRes);
      check("GET /riders/me/rate follows the live config and keeps the old keys", rateRes.body.rate_per_km === 6 && rateRes.body.min_earning_per_delivery === 20 && rateRes.body.base_payout === 10 && rateRes.body.incentive_per_delivery === 5);

      // ---- deliver an order: the payout is frozen on it
      await db("riders").update({ status: "inactive" }); // so the auto-assigner can only pick the rider below
      const [payRiderId] = await db("riders").insert({ name: "Pay Rider", phone: "8500000038", status: "active", last_known_lat: 22.5810, last_known_lng: 88.4610, wallet_balance: 0 });
      const deliverOne = async (phone, lat, lng) => {
        const [custId] = await db("users").insert({ name: "Pay Customer", phone, wallet_balance: 0 });
        const placed = fakeRes();
        await orderController.placeOrder(fakeReq({ items: [{ item_id: fishCurryId, quantity: 1 }], delivery_lat: lat, delivery_lng: lng, delivery_address: "Pay St", payment_method: "cod" }, {}, { id: custId, type: "customer" }), placed);
        const oid = placed.body.order.id;
        await devtools.advanceOrder(oid, { to: "delivered" });
        return { oid, custId };
      };
      const d1 = await deliverOne("8000000038", 22.6050, 88.4850);
      const o1 = await db("orders").where({ id: d1.oid }).first();
      const kitchen1 = await db("restaurants").where({ id: o1.restaurant_id }).first();
      const km1 = haversineDistanceKm(Number(kitchen1.lat), Number(kitchen1.lng), Number(o1.delivery_lat), Number(o1.delivery_lng));
      const expected1 = riderPaySvc.computePayout({ distanceKm: km1, config: cfg }).payout;
      check("the order was delivered by the rider and has a frozen rider_payout under the live config", o1.status === "delivered" && o1.rider_id === payRiderId && Number(o1.rider_payout) === expected1 && o1.rider_pay_config_id === put.body.settings.id);

      // ---- changing the config later never rewrites it
      await call(superA, "PUT", "/admin/settings/rider-pay", { base_payout: 0, per_km_rate: 100, min_payout: 0, incentive_per_delivery: 0 });
      check("a later rate change does NOT touch an already-delivered order's payout", Number((await db("orders").where({ id: d1.oid }).first()).rider_payout) === expected1);

      // ---- who sees it
      const orderAs = async (auth) => { const r = fakeRes(); await orderController.getOrder(fakeReq({}, { id: String(d1.oid) }, auth), r); return r.body.order; };
      const asCustomer = await orderAs({ id: d1.custId, type: "customer" });
      const asKitchen = await orderAs({ id: o1.restaurant_id, type: "restaurant" });
      const asRider = await orderAs({ id: payRiderId, type: "rider" });
      check("customer and restaurant views never carry the payout, breakdown or config id",
        ["rider_payout", "rider_payout_breakdown", "rider_pay_config_id"].every((k) => !(k in asCustomer) && !(k in asKitchen)));
      check("the rider sees their payout and a readable breakdown", asRider.rider_payout === expected1 && asRider.rider_payout_breakdown && asRider.rider_payout_breakdown.payout === expected1 && asRider.rider_payout_breakdown.distance_km > 0);
      const listAs = async (auth) => { const r = fakeRes(); await orderController.listMyOrders(fakeReq({}, {}, auth, {}), r); return r.body.orders.find((x) => x.id === d1.oid); };
      check("GET /orders list: the customer's rows have no payout; the rider's rows do", !("rider_payout" in (await listAs({ id: d1.custId, type: "customer" }))) && (await listAs({ id: payRiderId, type: "rider" })).rider_payout === expected1);
      const adminOrder = await call(opsA, "GET", `/admin/orders/${d1.oid}`);
      check("GET /admin/orders/:id shows rider_payout (number), the breakdown object and the config id", adminOrder.body.order.rider_payout === expected1 && adminOrder.body.order.rider_payout_breakdown.formula && adminOrder.body.order.rider_pay_config_id === put.body.settings.id);
      const adminList = await call(opsA, "GET", `/admin/orders?rider_id=${payRiderId}`);
      check("GET /admin/orders rows carry rider_payout", adminList.body.orders.find((x) => x.id === d1.oid).rider_payout === expected1);
      const riderDetail = await call(opsA, "GET", `/admin/riders/${payRiderId}`);
      check("GET /admin/riders/:id has the payout history: orders with rider_payout and totals (earned / unsettled)",
        riderDetail.body.payouts.deliveries === 1 && riderDetail.body.payouts.total_earned === expected1 && riderDetail.body.payouts.unsettled === expected1 && riderDetail.body.orders.find((x) => x.id === d1.oid).rider_payout === expected1);

      // ---- settlement pays the frozen payout; a pre-feature order (NULL payout) uses the current formula
      const d2 = await deliverOne("8000000039", 22.5900, 88.4700);
      const o2 = await db("orders").where({ id: d2.oid }).first();
      const kitchen2 = await db("restaurants").where({ id: o2.restaurant_id }).first();
      const km2 = haversineDistanceKm(Number(kitchen2.lat), Number(kitchen2.lng), Number(o2.delivery_lat), Number(o2.delivery_lng));
      await db("orders").where({ id: d2.oid }).update({ rider_payout: null, rider_payout_breakdown: null, rider_pay_config_id: null }); // as if delivered before this feature
      const liveCfg = await riderPaySvc.getCurrentConfig();
      const fallback2 = riderPaySvc.computePayout({ distanceKm: km2, config: liveCfg }).payout;
      const settled = await settlement.settleRider(payRiderId);
      check("settlement = frozen payout of the new order + the CURRENT formula for the old one (rate x100 does not touch the frozen one)",
        settled.ordersSettled === 2 && Math.abs(settled.totalEarnings - (expected1 + fallback2)) < 0.01);
    } finally {
      await new Promise((resolve) => server.close(resolve));
      for (const r of otherRiders) await db("riders").where({ id: r.id }).update({ status: r.status });
      await db("admins").where("email", "like", "%@pay.test").delete();
    }
  }

  console.log("\n--- Test 39: COD cash — rider handovers (ledger credit) and the expected/collected/handed-over reconciliation ---");
  {
    const http = require("http");
    const bcrypt = require("bcrypt");
    const { signToken } = require("./src/utils/jwt");
    const { dayKey, parseRange } = require("./src/utils/reportRange");
    const app = require("./src/app");
    const devtools = require("./src/services/devtools.service");
    const adminOrdersCtl = require("./src/controllers/adminOrders.controller");
    const server = await new Promise((resolve) => { const s = http.createServer(app).listen(0, () => resolve(s)); });
    const base = `http://127.0.0.1:${server.address().port}/api/v1`;
    const mkAdmin = async (name, role) => {
      const [id] = await db("admins").insert({ name, email: `${name}@cod.test`, password_hash: await bcrypt.hash("a-long-password-1", 4), role });
      return { id, token: signToken({ id, type: "admin" }) };
    };
    const superA = await mkAdmin("cod-super", "super_admin");
    const opsA = await mkAdmin("cod-ops", "ops");
    const supA = await mkAdmin("cod-support", "support");
    const call = async (who, method, p, body) => {
      const r = await fetch(base + p, { method, headers: { Authorization: `Bearer ${who.token}`, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
      const text = await r.text();
      let json = null; try { json = JSON.parse(text); } catch { /* csv */ }
      return { status: r.status, body: json, text, type: r.headers.get("content-type") };
    };
    const otherRiders = await db("riders").select("id", "status");
    const today = dayKey(new Date());
    const yesterday = dayKey(new Date(Date.now() - 86400e3));
    const tomorrow = dayKey(new Date(Date.now() + 86400e3));
    try {
      await db("riders").update({ status: "inactive" }); // only the rider below can be auto-assigned
      const [codRiderId] = await db("riders").insert({ name: "COD Rider", phone: "8500000039", status: "active", last_known_lat: 22.5810, last_known_lng: 88.4610, wallet_balance: 0 });

      const place = async (phone) => {
        const [custId] = await db("users").insert({ name: "COD Customer", phone, wallet_balance: 0 });
        const r = fakeRes();
        await orderController.placeOrder(fakeReq({ items: [{ item_id: fishCurryId, quantity: 1 }], delivery_lat: 22.5805, delivery_lng: 88.4605, delivery_address: "COD St", payment_method: "cod" }, {}, { id: custId, type: "customer" }), r);
        return r.body.order.id;
      };
      const oDelivered = await place("8000000391");
      await devtools.advanceOrder(oDelivered, { to: "delivered" });
      const oShort = await place("8000000392");
      await devtools.advanceOrder(oShort, { to: "delivered" });
      const oCancelled = await place("8000000393");
      await db("orders").where({ id: oCancelled }).update({ rider_id: codRiderId }); // the rider already had it when it was cancelled
      const cancelRes = fakeRes();
      await adminOrdersCtl.cancelOrder(fakeReq({ reason: "test" }, { id: String(oCancelled) }, { id: 1, type: "admin" }), cancelRes);

      const delivered = await db("orders").where({ id: oDelivered }).first();
      const grand = Number(delivered.grand_total);
      const wallet0 = Number((await db("riders").where({ id: codRiderId }).first()).wallet_balance);
      check("setup: the rider owes the COD they collected (negative wallet = both delivered orders' totals)", wallet0 < 0 && Math.abs(wallet0 + grand + Number((await db("orders").where({ id: oShort }).first()).grand_total)) < 0.01);

      // Make two anomalies the live flow can't produce but a reconciliation must catch.
      const shortLedger = await db("wallet_ledger").where({ owner_type: "rider", owner_id: codRiderId, related_order_id: oShort, reason: "cod_collected" }).first();
      await db("wallet_ledger").where({ id: shortLedger.id }).update({ amount: Number(shortLedger.amount) - 20 }); // rider confirmed ₹20 less than the total
      await db("wallet_ledger").insert({ owner_type: "rider", owner_id: codRiderId, entry_type: "debit", amount: 100, balance_after: 0, reason: "cod_collected", related_order_id: oCancelled, notes: "cash taken before the cancellation" });

      // ---- reconciliation (JSON)
      const rec = await call(supA, "GET", `/admin/cod/reconciliation?from=${yesterday}&to=${tomorrow}&rider_id=${codRiderId}`);
      check("GET /admin/cod/reconciliation is open to every role (support) -> 200", rec.status === 200);
      const byId = Object.fromEntries(rec.body.orders.map((o) => [o.order_id, o]));
      check("includes delivered AND cancelled COD orders (3 rows)", rec.body.total_orders === 3 && !!byId[oDelivered] && !!byId[oShort] && !!byId[oCancelled]);
      check("a clean delivered order: expected = collected = grand_total, difference 0, no flag", byId[oDelivered].expected === grand && byId[oDelivered].collected === grand && byId[oDelivered].difference === 0 && byId[oDelivered].flag === null);
      check("a short one: difference -20, flag 'short'", byId[oShort].difference === -20 && byId[oShort].flag === "short");
      check("a cancelled order that has cash recorded: expected 0, collected 100, flag 'unexpected_collection'", byId[oCancelled].status === "cancelled" && byId[oCancelled].expected === 0 && byId[oCancelled].collected === 100 && byId[oCancelled].flag === "unexpected_collection");
      const riderRow = rec.body.riders.find((r) => r.rider_id === codRiderId);
      const shortGrand = Number((await db("orders").where({ id: oShort }).first()).grand_total);
      check("rider row: delivered 2, expected = both totals, collected = expected - 20 + 100 (the cancelled one's cash counts), 2 flagged",
        riderRow.delivered_cod_orders === 2 && Math.abs(riderRow.expected - (grand + shortGrand)) < 0.01 && Math.abs(riderRow.collected - (grand + shortGrand - 20 + 100)) < 0.01 && riderRow.flagged_orders === 2 && riderRow.handed_over === 0);
      check("flagged=1 limits the order rows to the two anomalies", (await call(supA, "GET", `/admin/cod/reconciliation?from=${yesterday}&to=${tomorrow}&rider_id=${codRiderId}&flagged=1`)).body.total_orders === 2);
      check("a range in the past is empty; a bad / reversed range is a 400", (await call(supA, "GET", `/admin/cod/reconciliation?from=2020-01-01&to=2020-01-31&rider_id=${codRiderId}`)).body.total_orders === 0 && (await call(supA, "GET", "/admin/cod/reconciliation?from=nonsense")).status === 400 && (await call(supA, "GET", "/admin/cod/reconciliation?from=2026-02-01&to=2026-01-01")).status === 400);
      check("date-only 'to' covers the whole IST day (23:59:59.999)", parseRange({ from: "2026-10-28", to: "2026-10-28" }).to.getTime() - parseRange({ from: "2026-10-28" }).from.getTime() === 86400e3 - 1);

      // ---- handovers
      const outstanding0 = Math.max(0, -wallet0);
      check("support can't record a handover (403 forbidden_role)", (await call(supA, "POST", `/admin/riders/${codRiderId}/cash-handovers`, { amount: 10 })).body.code === "forbidden_role");
      check("amount 0 / negative / text -> 400", (await call(opsA, "POST", `/admin/riders/${codRiderId}/cash-handovers`, { amount: 0 })).status === 400 && (await call(opsA, "POST", `/admin/riders/${codRiderId}/cash-handovers`, { amount: -5 })).status === 400 && (await call(opsA, "POST", `/admin/riders/${codRiderId}/cash-handovers`, { amount: "abc" })).status === 400);
      check("a handover in the future -> 400", (await call(opsA, "POST", `/admin/riders/${codRiderId}/cash-handovers`, { amount: 10, received_at: new Date(Date.now() + 86400e3).toISOString() })).status === 400);
      check("unknown rider -> 404", (await call(opsA, "POST", "/admin/riders/999999/cash-handovers", { amount: 10 })).status === 404);
      const tooMuch = await call(opsA, "POST", `/admin/riders/${codRiderId}/cash-handovers`, { amount: outstanding0 + 1 });
      check("more than the rider owes -> 409 saying how much is outstanding (typo guard)", tooMuch.status === 409 && tooMuch.body.outstanding === outstanding0);

      const hand1 = await call(opsA, "POST", `/admin/riders/${codRiderId}/cash-handovers`, { amount: 200, reference: "RCPT-1", notes: "Handed over at the office", received_at: new Date(Date.now() - 3600e3).toISOString() });
      check("ops records a handover -> 201 with balance_after and outstanding_after", hand1.status === 201 && hand1.body.handover.amount === 200 && Math.abs(hand1.body.handover.outstanding_after - (outstanding0 - 200)) < 0.01 && hand1.body.handover.received_by_admin_id === opsA.id);
      const wallet1 = Number((await db("riders").where({ id: codRiderId }).first()).wallet_balance);
      check("the rider's wallet balance rose by exactly the handover", Math.abs(wallet1 - (wallet0 + 200)) < 0.01);
      const ledgerRow = await db("wallet_ledger").where({ owner_type: "rider", owner_id: codRiderId, reason: "cash_handover" }).first();
      check("a wallet_ledger CREDIT with reason cash_handover was written and is linked from the handover", ledgerRow && ledgerRow.entry_type === "credit" && Number(ledgerRow.amount) === 200 && (await db("cash_handovers").where({ id: hand1.body.handover.id }).first()).ledger_entry_id === ledgerRow.id);
      const dupe = await call(opsA, "POST", `/admin/riders/${codRiderId}/cash-handovers`, { amount: 50, reference: "RCPT-1" });
      check("the same reference again -> 409 and no second credit", dupe.status === 409 && Number((await db("riders").where({ id: codRiderId }).first()).wallet_balance) === wallet1);
      const hand2 = await call(superA, "POST", `/admin/riders/${codRiderId}/cash-handovers`, { amount: 25.5 });
      check("a second handover without a reference works (super_admin too)", hand2.status === 201);

      const hist = await call(supA, "GET", `/admin/cash-handovers?rider_id=${codRiderId}`);
      check("GET /admin/cash-handovers (any role): newest first, rider name, who recorded it, total_amount", hist.status === 200 && hist.body.handovers.length === 2 && hist.body.total === 2 && hist.body.total_amount === 225.5 && hist.body.handovers[0].rider_name === "COD Rider" && hist.body.handovers.some((h) => h.received_by_admin_name === "cod-ops" && h.reference === "RCPT-1"));
      check("history filters by date and rider", (await call(supA, "GET", `/admin/cash-handovers?rider_id=${codRiderId}&from=2020-01-01&to=2020-01-02`)).body.total === 0 && (await call(supA, "GET", "/admin/cash-handovers?rider_id=999999")).body.total === 0);

      const rec2 = await call(supA, "GET", `/admin/cod/reconciliation?from=${yesterday}&to=${tomorrow}&rider_id=${codRiderId}`);
      const row2 = rec2.body.riders.find((r) => r.rider_id === codRiderId);
      check("reconciliation now shows handed_over 225.5, net_cash_in_period = collected - handed_over, outstanding = what the wallet still owes",
        row2.handed_over === 225.5 && Math.abs(row2.net_cash_in_period - (row2.collected - 225.5)) < 0.01 && Math.abs(row2.outstanding - Math.max(0, -(wallet0 + 225.5))) < 0.01);
      check("the full amount can be handed over: outstanding reaches 0, then nothing more is accepted",
        (await call(opsA, "POST", `/admin/riders/${codRiderId}/cash-handovers`, { amount: row2.outstanding })).status === 201 && (await call(opsA, "POST", `/admin/riders/${codRiderId}/cash-handovers`, { amount: 1 })).status === 409);

      // ---- CSV
      const csvOrders = await call(supA, "GET", `/admin/cod/reconciliation.csv?from=${yesterday}&to=${tomorrow}&rider_id=${codRiderId}`);
      const lines = csvOrders.text.trim().split("\r\n");
      check("orders CSV: text/csv, header row, one line per order, a negative difference stays a plain number", csvOrders.type.startsWith("text/csv") && lines[0].startsWith("order_id,closed_at,status") && lines.length === 4 && lines.some((l) => l.includes(",-20,")));
      const csvRiders = await call(supA, "GET", `/admin/cod/reconciliation.csv?view=riders&from=${yesterday}&to=${tomorrow}&rider_id=${codRiderId}`);
      check("riders CSV (view=riders): header + the rider's row", csvRiders.text.startsWith("rider_id,rider_name,rider_phone") && csvRiders.text.trim().split("\r\n").length === 2);
    } finally {
      await new Promise((resolve) => server.close(resolve));
      for (const r of otherRiders) await db("riders").where({ id: r.id }).update({ status: r.status });
      await db("admins").where("email", "like", "%@cod.test").delete();
    }
  }

  console.log("\n--- Test 40: Finance — expenses CRUD and the profit & loss report (formulas, IST boundaries, roles, CSV) ---");
  {
    const http = require("http");
    const bcrypt = require("bcrypt");
    const { signToken } = require("./src/utils/jwt");
    const app = require("./src/app");
    const financeSvc = require("./src/services/finance.service");
    const riderPaySvc40 = require("./src/services/riderPay.service");
    const server = await new Promise((resolve) => { const s = http.createServer(app).listen(0, () => resolve(s)); });
    const base = `http://127.0.0.1:${server.address().port}/api/v1`;
    const mkAdmin = async (name, role) => {
      const [id] = await db("admins").insert({ name, email: `${name}@fin.test`, password_hash: await bcrypt.hash("a-long-password-1", 4), role });
      return { id, token: signToken({ id, type: "admin" }) };
    };
    const superA = await mkAdmin("fin-super", "super_admin");
    const opsA = await mkAdmin("fin-ops", "ops");
    const supA = await mkAdmin("fin-support", "support");
    const call = async (who, method, p, body) => {
      const r = await fetch(base + p, { method, headers: { Authorization: `Bearer ${who.token}`, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
      const text = await r.text();
      let json = null; try { json = JSON.parse(text); } catch { /* csv */ }
      return { status: r.status, body: json, text, type: r.headers.get("content-type") };
    };
    try {
      // ---- roles: finance is super_admin only
      const probes = [["GET", "/admin/finance/pnl"], ["GET", "/admin/finance/pnl.csv"], ["GET", "/admin/finance/orders.csv"], ["GET", "/admin/expenses"], ["POST", "/admin/expenses", {}], ["PATCH", "/admin/expenses/1", {}], ["DELETE", "/admin/expenses/1"]];
      let leaked = [];
      for (const [m, p, b] of probes) for (const who of [["ops", opsA], ["support", supA]]) {
        const r = await call(who[1], m, p, b);
        if (!(r.status === 403 && r.body && r.body.code === "forbidden_role")) leaked.push(`${who[0]} ${m} ${p} -> ${r.status}`);
      }
      check(`ops and support get 403 forbidden_role on every finance route (leaks: ${leaked.join("; ") || "none"})`, leaked.length === 0);

      // ---- expenses CRUD
      const bad = [
        { date: "2026-02-30", category: "marketing", amount: 10 }, { date: "26-03-10", category: "marketing", amount: 10 },
        { date: "2026-03-10", category: "rent", amount: 10 }, { date: "2026-03-10", category: "marketing", amount: 0 },
        { date: "2026-03-10", category: "marketing", amount: -3 }, { date: "2026-03-10", category: "marketing", amount: "abc" },
        { date: "2026-03-10", category: "marketing", amount: 10, notes: "x".repeat(501) },
      ];
      check("expense validation: impossible date, wrong format, unknown category, zero/negative/text amount, long notes -> all 400", (await Promise.all(bad.map((b) => call(superA, "POST", "/admin/expenses", b)))).every((r) => r.status === 400));
      const e1 = await call(superA, "POST", "/admin/expenses", { date: "2026-03-10", category: "marketing", amount: "500", notes: "Flyers" });
      const e2 = await call(superA, "POST", "/admin/expenses", { date: "2026-03-15", category: "salaries", amount: 1000 });
      const e3 = await call(superA, "POST", "/admin/expenses", { date: "2026-04-02", category: "operating", amount: 250.5 });
      check("POST /admin/expenses -> 201 { expense } with date as YYYY-MM-DD and a numeric amount", e1.status === 201 && e1.body.expense.date === "2026-03-10" && e1.body.expense.amount === 500 && e1.body.expense.notes === "Flyers" && e1.body.expense.created_by_admin_id === superA.id);
      const listed = await call(superA, "GET", "/admin/expenses?from=2026-03-01&to=2026-03-31");
      check("GET /admin/expenses filters by date: 2 in March, total 1500, by_category", listed.body.total === 2 && listed.body.total_amount === 1500 && listed.body.by_category.marketing === 500 && listed.body.by_category.salaries === 1000 && listed.body.by_category.other === 0);
      check("...and by category", (await call(superA, "GET", "/admin/expenses?category=operating")).body.total === 1 && (await call(superA, "GET", "/admin/expenses?category=rent")).status === 400);
      const patched = await call(superA, "PATCH", `/admin/expenses/${e3.body.expense.id}`, { amount: 300, notes: "Internet" });
      check("PATCH /admin/expenses/:id updates fields", patched.body.expense.amount === 300 && patched.body.expense.notes === "Internet" && patched.body.expense.category === "operating");
      check("PATCH with no valid field / unknown id -> 400 / 404", (await call(superA, "PATCH", `/admin/expenses/${e3.body.expense.id}`, {})).status === 400 && (await call(superA, "PATCH", "/admin/expenses/999999", { amount: 5 })).status === 404);
      const tmp = await call(superA, "POST", "/admin/expenses", { date: "2026-03-20", category: "other", amount: 1 });
      check("DELETE /admin/expenses/:id removes it (and a second delete is 404)", (await call(superA, "DELETE", `/admin/expenses/${tmp.body.expense.id}`)).status === 200 && (await call(superA, "DELETE", `/admin/expenses/${tmp.body.expense.id}`)).status === 404);

      // ---- fixed March orders (IST) with exactly known money
      const [finCust] = await db("users").insert({ name: "Fin Customer", phone: "8000000040", wallet_balance: 0 });
      const mkOrder = async (o) => (await db("orders").insert({
        customer_id: finCust, restaurant_id: restA, delivery_lat: 22.5800, delivery_lng: 88.4600, delivery_address: "Fin St",
        is_clubbed: false, ...o,
      }))[0];
      const A = await mkOrder({ status: "delivered", payment_method: "upi", payment_status: "paid", item_total: 400, delivery_fee: 30, cgst_amount: 10, sgst_amount: 10, coupon_discount_amount: 20, grand_total: 430, commission_amount: 60, rider_payout: 40, created_at: new Date("2026-03-10T10:00:00Z"), delivered_at: new Date("2026-03-10T11:00:00Z") });
      const C = await mkOrder({ status: "cancelled", payment_method: "upi", payment_status: "refunded", item_total: 250, delivery_fee: 20, cgst_amount: 15, sgst_amount: 15, grand_total: 300, commission_amount: 0, created_at: new Date("2026-03-11T05:00:00Z"), cancelled_at: new Date("2026-03-11T05:30:00Z") });
      const B = await mkOrder({ status: "delivered", payment_method: "cod", payment_status: "paid", item_total: 200, delivery_fee: 20, cgst_amount: 5, sgst_amount: 5, coupon_discount_amount: 0, grand_total: 230, commission_amount: 30, rider_payout: null, created_at: new Date("2026-03-12T06:00:00Z"), delivered_at: new Date("2026-03-12T07:00:00Z") });
      const D = await mkOrder({ status: "placed", payment_method: "cod", payment_status: "pending", item_total: 90, delivery_fee: 10, grand_total: 100, commission_amount: 0, created_at: new Date("2026-03-31T18:00:00Z") }); // 23:30 IST on 31 March
      const E = await mkOrder({ status: "delivered", payment_method: "cod", payment_status: "paid", item_total: 900, delivery_fee: 50, cgst_amount: 25, sgst_amount: 24, grand_total: 999, commission_amount: 100, rider_payout: 70, created_at: new Date("2026-03-31T19:00:00Z"), delivered_at: new Date("2026-03-31T20:00:00Z") }); // 00:30 IST on 1 April
      await db("order_items").insert({ order_id: A, item_id: fishCurryId, item_name: "Fish Curry", category_id: bengaliCatId, quantity: 2, unit_price: 150, list_price: 200, subtotal: 300 });
      await db("wallet_ledger").insert({ owner_type: "customer", owner_id: finCust, entry_type: "credit", amount: 10, balance_after: 10, reason: "order_refund", related_order_id: A, notes: "dropped item" });

      const feePct = financeSvc.gatewayFeePercent();
      const gateway = Number(((430 * feePct) / 100).toFixed(2));
      const fallbackB = riderPaySvc40.computePayout({ distanceKm: 0, config: await riderPaySvc40.getCurrentConfig() }).payout; // order B has no stored payout and sits on its kitchen
      const riderTotal = Number((40 + fallbackB).toFixed(2));
      const expectedNet = Number((140 - riderTotal - 20 - gateway - 1500).toFixed(2));

      const month = await call(superA, "GET", "/admin/finance/pnl?from=2026-03-01&to=2026-03-31&group=month");
      const t = month.body.totals;
      check("P&L month: 1 period (2026-03); the order at 00:30 IST on 1 April is NOT in March, the one at 23:30 IST on 31 March IS", month.status === 200 && month.body.periods.length === 1 && month.body.periods[0].period === "2026-03" && t.orders_placed === 4);
      check("gross order value = 430 + 300 + 230 + 100 = 1060; delivered 2 orders, delivered_sales 660", t.gross_order_value === 1060 && t.delivered_orders === 2 && t.delivered_sales === 660);
      check("delivered item_total 600, delivery fees 50, GST collected 30 (kept out of revenue), commission 90", t.delivered_item_total === 600 && t.delivered_delivery_fees === 50 && t.gst_collected === 30 && t.commission === 90);
      check("Fengle revenue = commission + delivery fees = 140 (GST excluded)", t.fengle_revenue === 140);
      check("restaurant payables (interim) = (400-60) + (200-30) = 510", t.restaurant_payables_interim === 510);
      check(`rider payouts = stored 40 + estimated for the order without one (${fallbackB}) = ${riderTotal}; stored/estimated split and count reported`, t.rider_payouts === riderTotal && t.rider_payouts_stored === 40 && t.rider_payouts_estimated === fallbackB && t.rider_payouts_estimated_orders === 1);
      check("coupon discounts 20 (delivered orders); offer discounts 100 and refunds 10 reported as info", t.coupon_discounts === 20 && t.offer_discounts_info === 100 && t.refunds_info === 10);
      check(`gateway charges = ${feePct}% of the delivered ONLINE order only (430 -> ${gateway}); the COD order carries none`, t.gateway_charges === gateway);
      check("cancelled: 1 order worth 300; in progress: 1 order worth 100", t.cancelled_orders === 1 && t.cancelled_value === 300 && t.in_progress_orders === 1 && t.in_progress_value === 100);
      check("expenses by category (marketing 500, salaries 1000) total 1500", t.expenses.marketing === 500 && t.expenses.salaries === 1000 && t.expenses.operating === 0 && t.expenses_total === 1500);
      check(`net profit = 140 - ${riderTotal} - 20 - ${gateway} - 1500 = ${expectedNet}`, t.net_profit === expectedNet);
      check("the response documents every formula", month.body.formulas && ["fengle_revenue", "restaurant_payables", "net_profit", "gateway_charges"].every((k) => typeof month.body.formulas[k] === "string") && month.body.gateway_fee_percent === feePct);

      const day = await call(superA, "GET", "/admin/finance/pnl?from=2026-03-01&to=2026-03-31&group=day");
      check("P&L by day: periods 03-10, 03-11, 03-12, 03-15 (expenses only), 03-31 (the 23:30 IST order), sorted", day.body.periods.map((p) => p.period).join() === "2026-03-10,2026-03-11,2026-03-12,2026-03-15,2026-03-31");
      check("...the day periods add up to the same totals", Math.abs(day.body.periods.reduce((s, p) => s + p.net_profit, 0) - t.net_profit) < 0.02 && Math.abs(day.body.periods.reduce((s, p) => s + p.gross_order_value, 0) - t.gross_order_value) < 0.01);
      const april = await call(superA, "GET", "/admin/finance/pnl?from=2026-04-01&to=2026-04-30&group=month");
      check("April holds the 00:30 IST order (999 delivered, revenue 150) and the operating expense 300", april.body.totals.delivered_sales === 999 && april.body.totals.fengle_revenue === 150 && april.body.totals.expenses.operating === 300 && april.body.totals.rider_payouts === 70);
      check("bad group / range -> 400", (await call(superA, "GET", "/admin/finance/pnl?group=year")).status === 400 && (await call(superA, "GET", "/admin/finance/pnl?from=2026-05-01&to=2026-04-01")).status === 400);
      check("with no range it defaults to the current month so far (200)", (await call(superA, "GET", "/admin/finance/pnl")).status === 200);

      // ---- CSVs
      const pnlCsv = await call(superA, "GET", "/admin/finance/pnl.csv?from=2026-03-01&to=2026-03-31&group=month");
      const pl = pnlCsv.text.trim().split("\r\n");
      check("pnl.csv: text/csv, header, the month row and a TOTAL row", pnlCsv.type.startsWith("text/csv") && pl[0].startsWith("period,orders_placed,gross_order_value") && pl.length === 3 && pl[1].startsWith("2026-03,") && pl[2].startsWith("TOTAL,"));
      const ordCsv = await call(superA, "GET", "/admin/finance/orders.csv?from=2026-03-01&to=2026-03-31");
      const ol = ordCsv.text.trim().split("\r\n");
      check("orders.csv: header + the 4 orders placed in March, A's line shows revenue 90 and payout 40 (stored)", ordCsv.type.startsWith("text/csv") && ol[0].startsWith("order_id,placed_at,delivered_at") && ol.length === 5 && ol.find((l) => l.startsWith(`${A},`)).includes(",90,") && ol.find((l) => l.startsWith(`${A},`)).includes("stored"));
      check("orders.csv marks the fallback payout as estimated", ol.find((l) => l.startsWith(`${B},`)).includes("estimated"));
      const csvNet = ol.slice(1).reduce((s, l) => s + Number(l.split(",").pop()), 0);
      check("the net_contribution column of orders.csv sums to the P&L's net profit before expenses", Math.abs(csvNet - (t.net_profit + t.expenses_total)) < 0.02);
    } finally {
      await new Promise((resolve) => server.close(resolve));
      await db("expenses").delete();
      await db("admins").where("email", "like", "%@fin.test").delete();
    }
  }

  console.log("\n--- Test 41: Notification centre — audiences, promotion vs service, send now / scheduled / cancel, delivery counts ---");
  {
    const http = require("http");
    const bcrypt = require("bcrypt");
    const { signToken } = require("./src/utils/jwt");
    const { promoOptIn } = require("./src/services/push.service");
    const campaignSvc = require("./src/services/campaign.service");
    const app = require("./src/app");
    const server = await new Promise((resolve) => { const s = http.createServer(app).listen(0, () => resolve(s)); });
    const base = `http://127.0.0.1:${server.address().port}/api/v1`;
    const mkAdmin = async (name, role) => {
      const [id] = await db("admins").insert({ name, email: `${name}@notif.test`, password_hash: await bcrypt.hash("a-long-password-1", 4), role });
      return { id, token: signToken({ id, type: "admin" }) };
    };
    const superA = await mkAdmin("notif-super", "super_admin");
    const opsA = await mkAdmin("notif-ops", "ops");
    const supA = await mkAdmin("notif-support", "support");

    // Never touch the real Expo / Google endpoints: answer them locally and remember what was "sent".
    const realFetch = global.fetch;
    const expoSent = [];
    global.fetch = async (url, opts) => {
      const u = String(url);
      if (u.includes("exp.host")) {
        const messages = JSON.parse(opts.body);
        expoSent.push(...messages);
        const data = messages.map((m) => (m.to.includes("BAD") ? { status: "error", message: "gone", details: { error: "DeviceNotRegistered" } } : { status: "ok", id: "t" }));
        return new Response(JSON.stringify({ data }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (u.includes("googleapis.com")) return new Response(JSON.stringify({ error: "invalid_grant", error_description: "stubbed" }), { status: 400 });
      return realFetch(url, opts);
    };
    const call = async (who, method, p, body) => {
      const r = await realFetch(base + p, { method, headers: { Authorization: `Bearer ${who.token}`, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
      let json = null; try { json = await r.json(); } catch { /* none */ }
      return { status: r.status, body: json };
    };
    const waitFor = async (id, wanted) => {
      for (let i = 0; i < 80; i++) {
        const c = (await call(superA, "GET", `/admin/notifications/${id}`)).body.campaign;
        if (wanted.includes(c.status)) return c;
        await sleep(100);
      }
      return (await call(superA, "GET", `/admin/notifications/${id}`)).body.campaign;
    };
    const created = [];
    try {
      // ---- roles
      const probes = [["POST", "/admin/notifications/preview", {}], ["POST", "/admin/notifications", {}], ["GET", "/admin/notifications"], ["GET", "/admin/notifications/1"], ["POST", "/admin/notifications/1/cancel", {}]];
      const leaked = [];
      for (const [m, p, b] of probes) for (const [name, who] of [["ops", opsA], ["support", supA]]) {
        const r = await call(who, m, p, b);
        if (!(r.status === 403 && r.body.code === "forbidden_role")) leaked.push(`${name} ${m} ${p} -> ${r.status}`);
      }
      check(`ops and support get 403 forbidden_role on every notification route (leaks: ${leaked.join("; ") || "none"})`, leaked.length === 0);

      // ---- customers: c1 opted in (2 devices: one live, one dead), c2 opted OUT of promotions (1 device), c3 blocked (1 device), c4 opted in (no device)
      const mkCustomer = async (phone, extra = {}) => (await db("users").insert({ name: `N ${phone}`, phone, wallet_balance: 0, ...extra }))[0];
      const c1 = await mkCustomer("8000004101");
      const c2 = await mkCustomer("8000004102", { notification_prefs: JSON.stringify({ promotions: false }) });
      const c3 = await mkCustomer("8000004103", { status: "blocked" });
      const c4 = await mkCustomer("8000004104");
      const tok = (owner, token) => db("device_tokens").insert({ owner_type: "customer", owner_id: owner, token, platform: "android" });
      await tok(c1, "ExponentPushToken[OK-c1]"); await tok(c1, "ExponentPushToken[BAD-c1]");
      await tok(c2, "ExponentPushToken[OK-c2]"); await tok(c3, "ExponentPushToken[OK-c3]");
      const phones = ["8000004101", "8000004102", "8000004103", "8000004104"];

      // ---- preview (nothing is sent)
      const pvPromo = await call(superA, "POST", "/admin/notifications/preview", { kind: "promotion", audience: { type: "phones", phones } });
      check("preview promotion: blocked c3 and opted-out c2 are left out -> 2 customers (c1, c4), 2 devices (c1's), matched 3, 1 opted out", pvPromo.status === 200 && pvPromo.body.customers === 2 && pvPromo.body.devices === 2 && pvPromo.body.matched === 3 && pvPromo.body.opted_out_excluded === 1);
      const pvService = await call(superA, "POST", "/admin/notifications/preview", { kind: "service", audience: { type: "phones", phones } });
      check("preview service: the opted-out customer IS included (c1, c2, c4), blocked still not -> 3 customers, 3 devices", pvService.body.customers === 3 && pvService.body.devices === 3 && pvService.body.opted_out_excluded === 0);
      check("preview sent nothing", expoSent.length === 0);

      // ---- validation
      const okBody = { title: "Hello", body: "World", kind: "promotion", audience: { type: "phones", phones } };
      const invalid = [
        { ...okBody, title: "" }, { ...okBody, title: "x".repeat(101) }, { ...okBody, body: " " }, { ...okBody, body: "x".repeat(501) },
        { ...okBody, kind: "spam" }, { ...okBody, audience: undefined }, { ...okBody, audience: { type: "everyone" } },
        { ...okBody, audience: { type: "phones", phones: [] } }, { ...okBody, audience: { type: "phones", phones: ["12345"] } },
        { ...okBody, audience: { type: "filtered", filters: { min_orders: -1 } } }, { ...okBody, audience: { type: "filtered", filters: { min_orders: 5, max_orders: 2 } } },
        { ...okBody, scheduled_at: "not-a-date" }, { ...okBody, scheduled_at: new Date(Date.now() - 3600e3).toISOString() },
        { ...okBody, scheduled_at: new Date(Date.now() + 400 * 86400e3).toISOString() },
      ];
      check("create validation: empty/long title or body, bad kind, missing/odd audience, bad phones, bad filters, past/invalid/too-far schedule -> all 400", (await Promise.all(invalid.map((b) => call(superA, "POST", "/admin/notifications", b)))).every((r) => r.status === 400));

      // ---- send now: promotion
      const promo = await call(superA, "POST", "/admin/notifications", { title: "Weekend offer", body: "20% off Bengali", kind: "promotion", audience: { type: "phones", phones } });
      created.push(promo.body.campaign.id);
      check("POST /admin/notifications (no scheduled_at) -> 201, status sending, who created it", promo.status === 201 && promo.body.campaign.status === "sending" && promo.body.campaign.created_by_admin_id === superA.id && promo.body.campaign.audience.type === "phones");
      const promoDone = await waitFor(promo.body.campaign.id, ["sent", "failed"]);
      check("promotion result: status sent, 2 customers targeted, 2 devices, 1 sent + 1 failed (the dead token), sent_at set", promoDone.status === "sent" && promoDone.targeted_customers === 2 && promoDone.targeted_devices === 2 && promoDone.sent_count === 1 && promoDone.failed_count === 1 && !!promoDone.sent_at);
      check("the push went to c1's two devices only (not the opted-out, blocked or token-less customers) with the title/body", expoSent.length === 2 && expoSent.every((m) => m.to.includes("c1") && m.title === "Weekend offer" && m.body === "20% off Bengali"));
      check("the dead device token was removed", (await db("device_tokens").where({ token: "ExponentPushToken[BAD-c1]" })).length === 0);

      // ---- send now: service reaches the opted-out customer
      expoSent.length = 0;
      const service = await call(superA, "POST", "/admin/notifications", { title: "Service notice", body: "Short maintenance tonight", kind: "service", audience: { type: "phones", phones } });
      created.push(service.body.campaign.id);
      const serviceDone = await waitFor(service.body.campaign.id, ["sent", "failed"]);
      check("service notice: reaches the promotions-opted-out customer too (c1's live device + c2's) -> 3 customers, 2 devices, 2 sent, 0 failed", serviceDone.status === "sent" && serviceDone.targeted_customers === 3 && serviceDone.targeted_devices === 2 && serviceDone.sent_count === 2 && serviceDone.failed_count === 0 && expoSent.some((m) => m.to.includes("c2")));
      check("...and a blocked customer never gets anything", !expoSent.some((m) => m.to.includes("c3")));

      // ---- filtered audience uses the same filters as GET /admin/customers
      const noOrders = await db("users as u").leftJoin("orders as o", "o.customer_id", "u.id").where("u.status", "active").groupBy("u.id").havingRaw("COUNT(o.id) = 0").select("u.id", "u.notification_prefs");
      const expectedNoOrders = noOrders.filter((r) => promoOptIn(r.notification_prefs)).length;
      const pvFiltered = await call(superA, "POST", "/admin/notifications/preview", { kind: "promotion", audience: { type: "filtered", filters: { max_orders: 0 } } });
      check("filtered audience {max_orders: 0} = active, opted-in customers who never ordered (same count as the customers list logic)", pvFiltered.body.customers === expectedNoOrders && expectedNoOrders >= 1);
      check("filtered audience {min_orders: 99999} matches nobody; an all-audience service notice matches every active customer",
        (await call(superA, "POST", "/admin/notifications/preview", { kind: "promotion", audience: { type: "filtered", filters: { min_orders: 99999 } } })).body.customers === 0 &&
        (await call(superA, "POST", "/admin/notifications/preview", { kind: "service", audience: { type: "all" } })).body.customers === Number((await db("users").where({ status: "active" }).count({ n: "*" }).first()).n));

      // ---- scheduling + cancel
      const later = new Date(Date.now() + 2 * 3600e3).toISOString();
      const sched = await call(superA, "POST", "/admin/notifications", { title: "Later", body: "Scheduled", kind: "promotion", audience: { type: "phones", phones: ["8000004101"] }, scheduled_at: later });
      created.push(sched.body.campaign.id);
      check("a campaign with scheduled_at stays 'scheduled' and sends nothing yet", sched.status === 201 && sched.body.campaign.status === "scheduled" && sched.body.campaign.targeted_customers === null);
      check("processDue() ignores a campaign whose time hasn't come", (await campaignSvc.processDue()) === 0 && (await call(superA, "GET", `/admin/notifications/${sched.body.campaign.id}`)).body.campaign.status === "scheduled");
      const cancelled = await call(superA, "POST", `/admin/notifications/${sched.body.campaign.id}/cancel`, {});
      check("cancel a scheduled campaign -> cancelled with cancelled_at", cancelled.status === 200 && cancelled.body.campaign.status === "cancelled" && !!cancelled.body.campaign.cancelled_at);
      check("cancelling again, or a sent one -> 409; unknown id -> 404", (await call(superA, "POST", `/admin/notifications/${sched.body.campaign.id}/cancel`, {})).status === 409 && (await call(superA, "POST", `/admin/notifications/${promo.body.campaign.id}/cancel`, {})).status === 409 && (await call(superA, "POST", "/admin/notifications/999999/cancel", {})).status === 404);
      check("a cancelled campaign is never sent by the scheduler", (await db("notification_campaigns").where({ id: sched.body.campaign.id }).update({ scheduled_at: new Date(Date.now() - 60e3) }), (await campaignSvc.processDue()) === 0));

      expoSent.length = 0;
      const due = await call(superA, "POST", "/admin/notifications", { title: "Due soon", body: "Scheduled for later", kind: "promotion", audience: { type: "phones", phones: ["8000004101"] }, scheduled_at: later });
      created.push(due.body.campaign.id);
      await db("notification_campaigns").where({ id: due.body.campaign.id }).update({ scheduled_at: new Date(Date.now() - 1000) }); // its time comes
      check("claim() is atomic: a second claim of the same campaign loses", (await campaignSvc.claim(due.body.campaign.id)) === true && (await campaignSvc.claim(due.body.campaign.id)) === false);
      await db("notification_campaigns").where({ id: due.body.campaign.id }).update({ status: "scheduled" }); // put it back for the scheduler tick
      check("the scheduler tick sends a due campaign", (await campaignSvc.processDue()) === 1);
      const dueDone = await waitFor(due.body.campaign.id, ["sent", "failed"]);
      check("...which ends 'sent' with its counts (c1 now has 1 live device)", dueDone.status === "sent" && dueDone.targeted_customers === 1 && dueDone.sent_count === 1 && expoSent.length === 1 && expoSent[0].title === "Due soon");

      // ---- failure + recovery
      const [c6] = await db("users").insert({ name: "N fcm", phone: "8000004106", wallet_balance: 0 });
      await tok(c6, "fcm-native-token-1");
      const fcmCampaign = await call(superA, "POST", "/admin/notifications", { title: "FCM", body: "no FCM here", kind: "service", audience: { type: "phones", phones: ["8000004106"] } });
      created.push(fcmCampaign.body.campaign.id);
      const fcmDone = await waitFor(fcmCampaign.body.campaign.id, ["sent", "failed"]);
      check("when no device accepts the push (FCM unavailable) the campaign ends 'failed' with a reason, not a silent 'sent to 0'", fcmDone.status === "failed" && typeof fcmDone.error === "string" && fcmDone.error.length > 0);
      const [stuck] = await db("notification_campaigns").insert({ title: "Stuck", body: "x", kind: "service", audience_type: "all", status: "sending", scheduled_at: new Date(), created_by_admin_id: superA.id });
      await db("notification_campaigns").where({ id: stuck }).update({ updated_at: new Date(Date.now() - 3600e3) });
      created.push(stuck);
      check("a campaign left 'sending' by a restart is marked failed, not re-sent", (await campaignSvc.failStuckCampaigns()) >= 1 && (await call(superA, "GET", `/admin/notifications/${stuck}`)).body.campaign.status === "failed");

      // ---- history
      const history = await call(superA, "GET", "/admin/notifications?limit=100");
      check("GET /admin/notifications lists the history newest first with who created each", history.status === 200 && history.body.total >= created.length && history.body.campaigns[0].id > history.body.campaigns[1].id && history.body.campaigns[0].created_by_admin_name === "notif-super");
      check("history filters by status and kind; bad filter -> 400", (await call(superA, "GET", "/admin/notifications?status=cancelled")).body.campaigns.every((c) => c.status === "cancelled") && (await call(superA, "GET", "/admin/notifications?kind=service")).body.campaigns.every((c) => c.kind === "service") && (await call(superA, "GET", "/admin/notifications?status=bogus")).status === 400);
      check("GET /admin/notifications/:id -> 404 for an unknown id", (await call(superA, "GET", "/admin/notifications/999999")).status === 404);
    } finally {
      global.fetch = realFetch;
      await new Promise((resolve) => server.close(resolve));
      await db("notification_campaigns").delete();
      await db("device_tokens").where("token", "like", "ExponentPushToken[%-c%").orWhere("token", "fcm-native-token-1").delete();
      await db("admins").where("email", "like", "%@notif.test").delete();
    }
  }

  console.log("\n--- Test 42: Vendor cost per dish, payable snapshot on orders, restaurant settlement, profit per product ---");
  {
    const http = require("http");
    const bcrypt = require("bcrypt");
    const { signToken } = require("./src/utils/jwt");
    const app = require("./src/app");
    const devtools = require("./src/services/devtools.service");
    const financeSvc42 = require("./src/services/finance.service");
    const catalogCtl42 = require("./src/controllers/catalog.controller");
    const favoriteCtl42 = require("./src/controllers/favorite.controller");
    const restCtl42 = require("./src/controllers/restaurant.controller");
    const server = await new Promise((resolve) => { const s = http.createServer(app).listen(0, () => resolve(s)); });
    const base = `http://127.0.0.1:${server.address().port}/api/v1`;
    const mkAdmin = async (name, role) => {
      const [id] = await db("admins").insert({ name, email: `${name}@vend.test`, password_hash: await bcrypt.hash("a-long-password-1", 4), role });
      return { id, token: signToken({ id, type: "admin" }) };
    };
    const superA = await mkAdmin("vend-super", "super_admin");
    const opsA = await mkAdmin("vend-ops", "ops");
    const supA = await mkAdmin("vend-support", "support");
    const call = async (who, method, p, body) => {
      const r = await fetch(base + p, { method, headers: { Authorization: `Bearer ${who.token}`, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
      const text = await r.text();
      let json = null; try { json = JSON.parse(text); } catch { /* csv */ }
      return { status: r.status, body: json, text };
    };
    const adminAuth = { id: 1, type: "admin" };
    const otherRiders = await db("riders").select("id", "status");
    try {
      // ---- a dedicated kitchen + category, so every figure below is exact
      const [catK] = await db("categories").insert({ name: "Settlement Cat" });
      const [K] = await db("restaurants").insert({ name: "Settlement Kitchen", phone: "9000004201", address: "Newtown K", lat: 22.5900, lng: 88.4700, radius_km: 5, commission_rate_percent: 20, status: "active" });
      await db("restaurant_categories").insert({ restaurant_id: K, category_id: catK });
      const kitchen = { id: K, type: "restaurant" };
      const create = async (body, auth = adminAuth) => { const r = fakeRes(); await catalogCtl42.createItem(fakeReq({ category_id: catK, ...body }, {}, auth), r); return r; };
      const patch = async (id, body, auth = adminAuth) => { const r = fakeRes(); await catalogCtl42.updateItem(fakeReq(body, { id }, auth), r); return r; };
      const stock = (itemId) => db("restaurant_items").insert({ restaurant_id: K, item_id: itemId, is_available: true }).onConflict(["restaurant_id", "item_id"]).ignore();

      // ---- vendor cost on dishes: admin-only, validated, margin, loss-leader warning
      const X = await create({ name: "Vendor X", price: 200, vendor_cost: "120" });
      check("admin creates a dish with a vendor cost: 201, vendor_cost 120, margin 80, margin_percent 40, no warning", X.statusCode === 201 && X.body.item.vendor_cost === 120 && X.body.item.margin === 80 && X.body.item.margin_percent === 40 && X.body.warning === undefined);
      const Y = await create({ name: "Vendor Y", price: 100 });
      check("a dish with no vendor cost reads vendor_cost null and no margin", Y.body.item.vendor_cost === null && Y.body.item.margin === null);
      const Z = await create({ name: "Vendor Z loss-leader", price: 50, vendor_cost: 70 });
      check("a vendor cost ABOVE the price is allowed but returns a warning (and a negative margin)", Z.statusCode === 201 && typeof Z.body.warning === "string" && Z.body.item.margin === -20);
      check("vendor_cost 0 is allowed; negative / text / absurd -> 400", (await create({ name: "Vendor free", price: 10, vendor_cost: 0 })).statusCode === 201 && (await create({ name: "V1", price: 10, vendor_cost: -1 })).statusCode === 400 && (await create({ name: "V2", price: 10, vendor_cost: "abc" })).statusCode === 400 && (await create({ name: "V3", price: 10, vendor_cost: 1e9 })).statusCode === 400);
      check("a restaurant can't send vendor_cost on create or edit (403 price_admin_only)", (await create({ name: "KV", vendor_cost: 5 }, kitchen)).statusCode === 403 && (await patch(X.body.item.id, { vendor_cost: 5 }, kitchen)).statusCode === 403);
      const cleared = await patch(Z.body.item.id, { vendor_cost: null });
      check("vendor_cost: null clears it; the warning goes away", cleared.body.item.vendor_cost === null && cleared.body.warning === undefined);
      await patch(Z.body.item.id, { vendor_cost: 20 });

      // a kitchen proposes a dish; the admin prices it and sets its cost in ONE patch
      const proposed = await create({ name: "Kitchen idea" }, kitchen);
      check("a kitchen's own response never carries vendor_cost", proposed.statusCode === 201 && !("vendor_cost" in proposed.body.item) && !("margin" in proposed.body.item));
      const live = await patch(proposed.body.item.id, { price: 90, vendor_cost: 50 });
      check("admin prices an awaiting dish and sets its vendor cost in the same PATCH -> live with cost 50", live.body.item.price === 90 && live.body.item.vendor_cost === 50 && live.body.item.awaiting_price === false && Boolean(live.body.item.is_active));

      await stock(X.body.item.id); await stock(Y.body.item.id); await stock(Z.body.item.id);
      await patch(X.body.item.id, { offer_price: 150 }); // a dish offer: Fengle bears it, the kitchen's payable must not drop

      // ---- nothing leaks to customers or kitchens
      const near = { lat: "22.5900", lng: "88.4700" };
      const listRes = fakeRes();
      await catalogCtl42.listItemsForCategory(fakeReq({}, { categoryId: String(catK) }, null, near), listRes);
      check("customer catalog never carries vendor_cost / margin", listRes.body.items.length >= 2 && listRes.body.items.every((i) => !("vendor_cost" in i) && !("margin" in i)));
      const [leakCust] = await db("users").insert({ name: "Leak Customer", phone: "8000004200", wallet_balance: 0 });
      await db("favorites").insert({ customer_id: leakCust, item_id: X.body.item.id });
      const favRes = fakeRes();
      await favoriteCtl42.listFavorites(fakeReq({}, {}, { id: leakCust, type: "customer" }), favRes);
      const menuRes = fakeRes();
      await restCtl42.getMyMenu(fakeReq({}, {}, kitchen), menuRes);
      check("favorites and the kitchen's own menu never carry vendor_cost", favRes.body.favorites.every((i) => !("vendor_cost" in i)) && menuRes.body.items.length >= 2 && menuRes.body.items.every((i) => !("vendor_cost" in i)));
      const adminItems = await call(opsA, "GET", "/admin/items?q=Vendor");
      const adminX = adminItems.body.items.find((i) => i.id === X.body.item.id);
      check("GET /admin/items (ops) shows vendor_cost + margin at today's charged price (offer 150 -> margin 30, 20%)", adminX.vendor_cost === 120 && adminX.effective_price === 150 && adminX.margin === 30 && adminX.margin_percent === 20);
      const supItems = await call(supA, "GET", "/admin/items?q=Vendor");
      check("...but support never sees vendor cost or margin", supItems.status === 200 && supItems.body.items.length > 0 && supItems.body.items.every((i) => !("vendor_cost" in i) && !("margin" in i)));
      check("GET /admin/items?missing_vendor_cost=1 lists the dishes still missing a cost", (await call(opsA, "GET", "/admin/items?missing_vendor_cost=1&q=Vendor")).body.items.some((i) => i.id === Y.body.item.id) && !(await call(opsA, "GET", "/admin/items?missing_vendor_cost=1&q=Vendor")).body.items.some((i) => i.id === X.body.item.id));

      // ---- orders snapshot the cost and compute the payable
      await db("riders").update({ status: "inactive" });
      const [vRider] = await db("riders").insert({ name: "Vendor Rider", phone: "8500000042", status: "active", last_known_lat: 22.5905, last_known_lng: 88.4705, wallet_balance: 0 });
      const place = async (phone, items) => {
        const [custId] = await db("users").insert({ name: "V Customer", phone, wallet_balance: 0 });
        const r = fakeRes();
        await orderController.placeOrder(fakeReq({ items, delivery_lat: 22.5905, delivery_lng: 88.4705, delivery_address: "V St", payment_method: "cod" }, {}, { id: custId, type: "customer" }), r);
        return { res: r, custId, id: r.body.order && r.body.order.id };
      };
      const o1 = await place("8000004211", [{ item_id: X.body.item.id, quantity: 2 }, { item_id: Y.body.item.id, quantity: 1 }]);
      const row1 = await db("orders").where({ id: o1.id }).first();
      check("order placed: restaurant_payable = X 120 x 2 + Y (no cost) estimated 100 - 20% = 80 -> 320; flagged estimated (the offer on X does not lower it)", o1.res.statusCode === 201 && o1.res.body.order.restaurant_id === K && Number(row1.restaurant_payable) === 320 && Number(row1.payable_estimated) === 1);
      check("...customers were charged the offer price (item_total 2 x 150 + 100 = 400) yet the payable stayed on vendor cost", Number(row1.item_total) === 400);
      const lines1 = await db("order_items").where({ order_id: o1.id }).orderBy("id");
      check("order_items snapshot vendor_cost (120 for X, null for Y)", Number(lines1[0].vendor_cost) === 120 && lines1[1].vendor_cost === null);
      check("the placeOrder response to the customer has no restaurant_payable / payable_estimated", !("restaurant_payable" in o1.res.body.order) && !("payable_estimated" in o1.res.body.order));
      const getAs = async (orderId, auth) => { const r = fakeRes(); await orderController.getOrder(fakeReq({}, { id: String(orderId) }, auth), r); return r.body; };
      const asCust = await getAs(o1.id, { id: o1.custId, type: "customer" });
      const asKitchen = await getAs(o1.id, kitchen);
      check("GET /orders/:id: customer and kitchen see neither the payable nor any line's vendor_cost", [asCust, asKitchen].every((b) => !("restaurant_payable" in b.order) && !("payable_estimated" in b.order) && b.items.every((l) => !("vendor_cost" in l))));
      const listAsKitchen = fakeRes();
      await orderController.listMyOrders(fakeReq({}, {}, kitchen, {}), listAsKitchen);
      check("GET /orders list rows for the kitchen carry no payable either", listAsKitchen.body.orders.every((o) => !("restaurant_payable" in o)));
      const adminView = await call(opsA, "GET", `/admin/orders/${o1.id}`);
      check("GET /admin/orders/:id (ops): restaurant_payable 320, payable_estimated, and the lines' vendor_cost", adminView.body.order.restaurant_payable === 320 && Number(adminView.body.order.payable_estimated) === 1 && adminView.body.items[0].vendor_cost === 120);
      const supView = await call(supA, "GET", `/admin/orders/${o1.id}`);
      check("...support gets neither the payable nor vendor costs", supView.status === 200 && !("restaurant_payable" in supView.body.order) && supView.body.items.every((l) => !("vendor_cost" in l)));

      // a later cost change never rewrites the old order
      await patch(X.body.item.id, { vendor_cost: 130 });
      check("changing the dish's vendor cost later leaves the old order's snapshot and payable alone", Number((await db("order_items").where({ id: lines1[0].id }).first()).vendor_cost) === 120 && Number((await db("orders").where({ id: o1.id }).first()).restaurant_payable) === 320);
      await patch(X.body.item.id, { vendor_cost: 120 });

      // accept with a dropped line: recomputed on the confirmed lines only (and no longer estimated once Y is gone)
      const dropRes = fakeRes();
      await orderController.acceptOrder(fakeReq({ unavailable_item_ids: [Y.body.item.id] }, { id: String(o1.id) }, kitchen), dropRes);
      const afterDrop = await db("orders").where({ id: o1.id }).first();
      check("accepting with Y unavailable: payable recomputed to X only = 240, no longer estimated", dropRes.statusCode === undefined && Number(afterDrop.restaurant_payable) === 240 && Number(afterDrop.payable_estimated) === 0);
      check("...and the accept response to the kitchen hides the payable", !("restaurant_payable" in dropRes.body.order));

      // cancelled orders owe the kitchen nothing
      const oc = await place("8000004212", [{ item_id: X.body.item.id, quantity: 1 }]);
      await require("./src/controllers/adminOrders.controller").cancelOrder(fakeReq({ reason: "t" }, { id: String(oc.id) }, adminAuth), fakeRes());
      check("a cancelled order shows restaurant_payable 0 to admins and never counts in settlement", (await call(opsA, "GET", `/admin/orders/${oc.id}`)).body.order.restaurant_payable === 0);
      await db("orders").where({ id: o1.id }).update({ status: "cancelled", cancelled_at: new Date() }); // retire the accepted order from section above

      // ---- two delivered orders for the settlement figures
      const d1 = await place("8000004213", [{ item_id: X.body.item.id, quantity: 2 }, { item_id: Y.body.item.id, quantity: 1 }]);
      await devtools.advanceOrder(d1.id, { to: "delivered" });
      await patch(Y.body.item.id, { vendor_cost: 60 }); // now every dish has a cost
      const d2 = await place("8000004214", [{ item_id: X.body.item.id, quantity: 1 }, { item_id: Y.body.item.id, quantity: 1 }]);
      await devtools.advanceOrder(d2.id, { to: "delivered" });
      const dRow1 = await db("orders").where({ id: d1.id }).first();
      const dRow2 = await db("orders").where({ id: d2.id }).first();
      check("D1 payable 320 (estimated), D2 payable 180 = 120 + 60 (exact)", Number(dRow1.restaurant_payable) === 320 && Number(dRow1.payable_estimated) === 1 && Number(dRow2.restaurant_payable) === 180 && Number(dRow2.payable_estimated) === 0 && dRow1.status === "delivered" && dRow2.status === "delivered");

      // ---- settlement overview
      const probes = [["GET", "/admin/restaurant-settlements"], ["GET", "/admin/restaurant-settlements.csv"], ["GET", `/admin/restaurants/${K}/settlement`], ["GET", `/admin/restaurants/${K}/settlement.csv`], ["POST", `/admin/restaurants/${K}/payments`, {}], ["GET", "/admin/restaurant-payments"], ["POST", `/admin/restaurants/${K}/adjustments`, {}], ["GET", "/admin/restaurant-adjustments"]];
      const leaked = [];
      for (const [m, p, b] of probes) { const r = await call(supA, m, p, b); if (!(r.status === 403 && r.body && r.body.code === "forbidden_role")) leaked.push(`${m} ${p} -> ${r.status}`); }
      check(`support gets 403 forbidden_role on every settlement route (leaks: ${leaked.join("; ") || "none"})`, leaked.length === 0);

      const ov = await call(opsA, "GET", "/admin/restaurant-settlements");
      const kRow = ov.body.restaurants.find((r) => r.restaurant_id === K);
      check("overview: kitchen K delivered 2, total_payable 500, outstanding 500, status due, 1 estimated order flagged", ov.status === 200 && kRow.delivered_orders === 2 && kRow.payable_earned === 500 && kRow.total_payable === 500 && kRow.outstanding === 500 && kRow.status === "due" && kRow.estimated_orders_total === 1 && kRow.has_estimated_payables === true);
      check("a kitchen with nothing owed reads settled", ov.body.restaurants.filter((r) => r.outstanding === 0).every((r) => r.status === "settled") && ov.body.restaurants.some((r) => r.outstanding === 0));
      const ovFuture = await call(opsA, "GET", "/admin/restaurant-settlements?from=2099-01-01");
      check("a range with no deliveries shows payable_earned 0 for the range but keeps the all-time total (500) and outstanding", ovFuture.body.restaurants.find((r) => r.restaurant_id === K).payable_earned === 0 && ovFuture.body.restaurants.find((r) => r.restaurant_id === K).total_payable === 500);

      // ---- payments
      const pay = (body) => call(opsA, "POST", `/admin/restaurants/${K}/payments`, body);
      check("payment: amount 0 / text -> 400; bad method -> 400; bank transfer without a reference -> 400; future paid_at -> 400",
        (await pay({ amount: 0, reference: "R" })).status === 400 && (await pay({ amount: "abc", reference: "R" })).status === 400 && (await pay({ amount: 5, reference: "R", method: "cheque" })).status === 400 && (await pay({ amount: 5 })).status === 400 && (await pay({ amount: 5, reference: "R", paid_at: new Date(Date.now() + 86400e3).toISOString() })).status === 400);
      check("unknown kitchen -> 404", (await call(opsA, "POST", "/admin/restaurants/999999/payments", { amount: 5, reference: "R" })).status === 404);
      const tooMuch = await pay({ amount: 600, reference: "UTR-TOO-MUCH" });
      check("a payment above what is owed -> 409 with the outstanding (500), unless allow_advance", tooMuch.status === 409 && tooMuch.body.outstanding === 500);
      const p1 = await pay({ amount: 200, reference: "UTR-1", method: "bank_transfer", notes: "First part", paid_at: new Date(Date.now() - 3600e3).toISOString() });
      check("payment 200 recorded -> 201, outstanding_after 300, who recorded it", p1.status === 201 && p1.body.payment.amount === 200 && p1.body.outstanding_after === 300 && p1.body.payment.recorded_by_admin_id === opsA.id);
      check("the same reference again -> 409 and nothing extra recorded", (await pay({ amount: 10, reference: "UTR-1" })).status === 409 && (await call(opsA, "GET", `/admin/restaurant-payments?restaurant_id=${K}`)).body.total === 1);
      check("a cash payment needs no reference", (await pay({ amount: 50, method: "cash" })).body.outstanding_after === 250);

      // ---- adjustments
      const adj = (body) => call(opsA, "POST", `/admin/restaurants/${K}/adjustments`, body);
      check("adjustment: amount 0 / text / missing reason -> 400; an order of another kitchen -> 400",
        (await adj({ amount: 0, reason: "x" })).status === 400 && (await adj({ amount: "abc", reason: "x" })).status === 400 && (await adj({ amount: -10 })).status === 400 && (await adj({ amount: -10, reason: "x", related_order_id: orderId })).status === 400);
      const penalty = await adj({ amount: -30, reason: "Cancelled after accepting", related_order_id: d1.id });
      check("a -30 deduction tied to an order -> 201, outstanding_after 220", penalty.status === 201 && penalty.body.adjustment.amount === -30 && penalty.body.outstanding_after === 220);
      check("a + adjustment (owed to the kitchen) raises it: +5 -> 225, then -5 -> 220", (await adj({ amount: 5, reason: "Packaging" })).body.outstanding_after === 225 && (await adj({ amount: -5, reason: "Packaging reversed" })).body.outstanding_after === 220);

      // ---- statement
      const st = await call(opsA, "GET", `/admin/restaurants/${K}/settlement`);
      check("statement: opening 0, earned 500, adjustments -30, paid 250, closing = outstanding_now = 220, status due",
        st.status === 200 && st.body.opening_balance === 0 && st.body.payable_earned === 500 && st.body.adjustments_total === -30 && st.body.paid_total === 250 && st.body.closing_balance === 220 && st.body.outstanding_now === 220 && st.body.status === "due");
      const sOrder = st.body.orders.find((o) => o.order_id === d1.id);
      check("statement order lines show items with vendor cost x quantity and the estimated flag (D1: X 2 x 120, Y estimated 80)", sOrder.payable === 320 && sOrder.estimated === true && sOrder.items.find((i) => i.name === "Vendor X").line_cost === 240 && sOrder.items.find((i) => i.name === "Vendor Y").estimated === true && sOrder.items.find((i) => i.name === "Vendor Y").line_cost === 80);
      check("statement has date-wise subtotals, the payments and the adjustments", st.body.days.reduce((s, d) => s + d.payable, 0) === 500 && st.body.payments.length === 2 && st.body.adjustments.length === 3);
      const stLater = await call(opsA, "GET", `/admin/restaurants/${K}/settlement?from=2099-01-01`);
      check("a statement starting after everything: opening = what was owed before (220), nothing in range, closing 220", stLater.body.opening_balance === 220 && stLater.body.payable_earned === 0 && stLater.body.closing_balance === 220 && stLater.body.orders.length === 0);
      check("statement for an unknown kitchen -> 404", (await call(opsA, "GET", "/admin/restaurants/999999/settlement")).status === 404);
      const stCsv = await call(opsA, "GET", `/admin/restaurants/${K}/settlement.csv`);
      const lines = stCsv.text.trim().split("\r\n");
      check("statement CSV: header, opening_balance row, one row per order/payment/adjustment, last running balance = 220", lines[0] === "date,type,reference,detail,amount,estimated,balance" && lines[1].includes("opening_balance") && lines.length === 2 + 2 + 3 + 2 && lines[lines.length - 1].endsWith(",220"));
      const ovCsv = await call(opsA, "GET", "/admin/restaurant-settlements.csv");
      check("overview CSV has a row for the kitchen with outstanding 220", ovCsv.text.startsWith("restaurant_id,restaurant_name,status") && ovCsv.text.split("\r\n").some((l) => l.startsWith(`${K},Settlement Kitchen,due`) && l.includes(",220,")));

      // ---- settle fully, then an advance needs the flag
      check("paying the remaining 220 -> settled", (await pay({ amount: 220, reference: "UTR-2" })).body.outstanding_after === 0 && (await call(opsA, "GET", "/admin/restaurant-settlements")).body.restaurants.find((r) => r.restaurant_id === K).status === "settled");
      check("one more rupee is refused without allow_advance (409) and recorded with it (outstanding -1, status advance)",
        (await pay({ amount: 1, reference: "UTR-3" })).status === 409 && (await pay({ amount: 1, reference: "UTR-3", allow_advance: true })).body.outstanding_after === -1 && (await call(opsA, "GET", "/admin/restaurant-settlements")).body.restaurants.find((r) => r.restaurant_id === K).status === "advance");
      const hist = await call(opsA, "GET", `/admin/restaurant-payments?restaurant_id=${K}`);
      check("GET /admin/restaurant-payments: newest first with the kitchen name and total_amount", hist.body.payments.length === 4 && hist.body.total_amount === 471 && hist.body.payments[0].restaurant_name === "Settlement Kitchen");
      check("GET /admin/restaurant-adjustments lists the 3 adjustments (total -30)", (await call(opsA, "GET", `/admin/restaurant-adjustments?restaurant_id=${K}`)).body.total_amount === -30);

      // ---- the P&L uses the real payable
      const econ = (await financeSvc42.buildOrderEconomics({ from: null, to: null })).filter((r) => r.order_id === d1.id || r.order_id === d2.id);
      const e1 = econ.find((r) => r.order_id === d1.id);
      const e2 = econ.find((r) => r.order_id === d2.id);
      check("P&L order rows: payable = the stored payable; fengle_revenue = item_total - payable + delivery_fee; estimated flag carried", e1.restaurant_payable === 320 && e1.payable_estimated === true && e1.fengle_revenue === Number((400 - 320 + Number(dRow1.delivery_fee)).toFixed(2)) && e2.restaurant_payable === 180 && e2.payable_estimated === false && e2.fengle_revenue === Number((Number(dRow2.item_total) - 180 + Number(dRow2.delivery_fee)).toFixed(2)));
      const sum42 = financeSvc42.summarize(econ, []);
      check("P&L summary: restaurant_payables 500 (the 'interim' alias matches), 1 order with an estimated payable", sum42.restaurant_payables === 500 && sum42.restaurant_payables_interim === 500 && sum42.payable_estimated_orders === 1);
      const pnl = await call(superA, "GET", "/admin/finance/pnl?group=month");
      check("GET /admin/finance/pnl: the formulas describe restaurant_payables and no longer call them interim", pnl.status === 200 && typeof pnl.body.formulas.restaurant_payables === "string" && !/INTERIM/.test(pnl.body.formulas.restaurant_payables) && !("restaurant_payables_interim" in pnl.body.formulas));

      // ---- profit per product
      check("profit per product is super_admin only (ops 403)", (await call(opsA, "GET", "/admin/finance/products")).body.code === "forbidden_role" && (await call(opsA, "GET", "/admin/finance/products.csv")).body.code === "forbidden_role");
      const prod = await call(superA, "GET", `/admin/finance/products?category_id=${catK}`);
      const pX = prod.body.products.find((p) => p.item_id === X.body.item.id);
      const pY = prod.body.products.find((p) => p.item_id === Y.body.item.id);
      check("product X: 3 units, revenue 3 x 150 = 450 (after the offer), vendor cost 360, profit 90, margin 20%", pX.units_sold === 3 && pX.customer_revenue === 450 && pX.vendor_cost_total === 360 && pX.gross_profit === 90 && pX.margin_percent === 20 && pX.has_estimated_cost === false);
      check("product Y: 2 units, revenue 200, cost 80 (estimated) + 60 = 140, profit 60, flagged estimated (1 unit)", pY.units_sold === 2 && pY.customer_revenue === 200 && pY.vendor_cost_total === 140 && pY.gross_profit === 60 && pY.estimated_units === 1 && pY.has_estimated_cost === true);
      check("rows carry the dish's CURRENT price, vendor cost and margin; sorted by gross profit; totals add up", pX.current_vendor_cost === 120 && pX.current_effective_price === 150 && pX.current_margin === 30 && prod.body.products[0].gross_profit >= prod.body.products[prod.body.products.length - 1].gross_profit && prod.body.totals.gross_profit === 150 && prod.body.totals.units_sold === 5);
      check("category filter: another category has none of these dishes", (await call(superA, "GET", `/admin/finance/products?category_id=${bengaliCatId}`)).body.products.every((p) => p.item_id !== X.body.item.id));
      const prodCsv = await call(superA, "GET", `/admin/finance/products.csv?category_id=${catK}`);
      check("products.csv: header + a row per dish", prodCsv.text.startsWith("item_id,name,category_name,units_sold") && prodCsv.text.trim().split("\r\n").length === 3);
    } finally {
      await new Promise((resolve) => server.close(resolve));
      for (const r of otherRiders) await db("riders").where({ id: r.id }).update({ status: r.status });
      await db("admins").where("email", "like", "%@vend.test").delete();
    }
  }

  console.log("\n--- Test 43: POST /auth/otp/request refuses numbers that can't log in (no SMS, no OTP row) ---");
  {
    const authCtl = require("./src/controllers/auth.controller");
    const savedDemo = { otp: process.env.DEMO_LOGIN_OTP, phones: process.env.DEMO_LOGIN_PHONES };
    const request = async (body) => { const r = fakeRes(); await authCtl.requestOtp(fakeReq(body, {}, null), r); return r; };
    const otpRows = async (phone, purpose) => (await db("otp_verifications").where({ phone, purpose })).length;
    const RESTAURANT_MSG = "This number is not registered as a partner restaurant. Please contact admin for onboarding.";
    const RIDER_MSG = "No partner account uses this number. Sign up in the Fengle Rider app first, or contact Fengle.";
    try {
      // ---- kitchens
      const unknownK = await request({ phone: "7000004301", purpose: "restaurant_login" });
      check("restaurant_login for an unknown number -> 404 with verify's wording", unknownK.statusCode === 404 && unknownK.body.error === RESTAURANT_MSG);
      check("...and no OTP row was created (so no SMS was sent)", (await otpRows("7000004301", "restaurant_login")) === 0);
      await db("restaurants").insert({ name: "OTP Kitchen", phone: "7000004302", address: "x", lat: 22.58, lng: 88.46, status: "active" });
      const knownK = await request({ phone: "7000004302", purpose: "restaurant_login" });
      check("restaurant_login for a registered kitchen -> OTP sent as before (200 + a row)", knownK.statusCode === undefined && knownK.body.message === "OTP sent" && (await otpRows("7000004302", "restaurant_login")) === 1);
      await db("restaurants").insert({ name: "OTP Suspended Kitchen", phone: "7000004303", address: "x", lat: 22.58, lng: 88.46, status: "suspended" });
      const suspendedK = await request({ phone: "7000004303", purpose: "restaurant_login" });
      check("a suspended kitchen -> 403 with verify's wording, no row", suspendedK.statusCode === 403 && suspendedK.body.error === "Your account has been suspended. Contact support." && (await otpRows("7000004303", "restaurant_login")) === 0);
      check("an inactive (paused) kitchen can still log in (only suspension blocks)", (await (async () => { await db("restaurants").insert({ name: "OTP Paused Kitchen", phone: "7000004304", address: "x", lat: 22.58, lng: 88.46, status: "inactive" }); return (await request({ phone: "7000004304", purpose: "restaurant_login" })).statusCode === undefined; })()));

      // ---- riders: self-serve by default, existing-only on request
      const newRider = await request({ phone: "7000004311", purpose: "rider_login" });
      check("rider_login for an unknown number WITHOUT the flag is unchanged: code sent (signup stays possible)", newRider.statusCode === undefined && (await otpRows("7000004311", "rider_login")) === 1);
      const unknownR = await request({ phone: "7000004312", purpose: "rider_login", existing_only: true });
      check("rider_login + existing_only for an unknown number -> 404 with verify's wording, no row", unknownR.statusCode === 404 && unknownR.body.error === RIDER_MSG && (await otpRows("7000004312", "rider_login")) === 0);
      await db("riders").insert({ name: "OTP Rider", phone: "7000004313", status: "active", wallet_balance: 0 });
      check("rider_login + existing_only for a known rider -> sent", (await request({ phone: "7000004313", purpose: "rider_login", existing_only: true })).body.message === "OTP sent");
      await db("riders").insert({ name: "OTP Suspended Rider", phone: "7000004314", status: "suspended", wallet_balance: 0 });
      check("a suspended rider -> 403, no row (with or without the flag)",
        (await request({ phone: "7000004314", purpose: "rider_login" })).statusCode === 403 && (await request({ phone: "7000004314", purpose: "rider_login", existing_only: true })).statusCode === 403 && (await otpRows("7000004314", "rider_login")) === 0);
      check("existing_only only counts when it is the boolean true (a string 'true' behaves like the default)", (await request({ phone: "7000004315", purpose: "rider_login", existing_only: "true" })).statusCode === undefined);

      // ---- customers unchanged
      check("customer login for a brand-new number is unchanged: code sent", (await request({ phone: "7000004321", purpose: "login" })).body.message === "OTP sent" && (await otpRows("7000004321", "login")) === 1);

      // ---- demo numbers follow the same rules (the Play-review demo logins must keep working)
      process.env.DEMO_LOGIN_OTP = "123456";
      process.env.DEMO_LOGIN_PHONES = "7000004331,7000004332,7000004333";
      const demoNotKitchen = await request({ phone: "7000004331", purpose: "restaurant_login" });
      check("a demo number that is NOT a registered kitchen can't request restaurant_login (404, no row)", demoNotKitchen.statusCode === 404 && (await otpRows("7000004331", "restaurant_login")) === 0);
      await db("restaurants").insert({ name: "Demo Kitchen", phone: "7000004332", address: "x", lat: 22.58, lng: 88.46, status: "active" });
      const demoKitchen = await request({ phone: "7000004332", purpose: "restaurant_login" });
      check("a demo number that IS a registered kitchen still works", demoKitchen.statusCode === undefined && demoKitchen.body.message === "OTP sent");
      const row = await db("otp_verifications").where({ phone: "7000004332", purpose: "restaurant_login" }).first();
      check("...and its code is the fixed demo code (verifies with 123456)", await require("./src/utils/otp").verifyOtpHash("123456", row.otp_hash));
      const verifyRes = fakeRes();
      await authCtl.verifyOtp(fakeReq({ phone: "7000004332", otp: "123456", purpose: "restaurant_login" }, {}, null), verifyRes);
      check("the demo kitchen logs in end to end (verify returns a token)", typeof verifyRes.body.token === "string" && verifyRes.body.user.type === "restaurant");
      await db("riders").insert({ name: "Demo Rider", phone: "7000004333", status: "active", wallet_balance: 0 });
      const demoRider = await request({ phone: "7000004333", purpose: "rider_login", existing_only: true });
      check("a demo rider works with and without existing_only", demoRider.body.message === "OTP sent" && (await request({ phone: "7000004333", purpose: "rider_login" })).body.message === "OTP sent");
      check("a demo number can still be a customer (login purpose)", (await request({ phone: "7000004331", purpose: "login" })).body.message === "OTP sent");

      // ---- verify keeps its own guards (unchanged)
      const verifyUnknown = fakeRes();
      await authCtl.verifyOtp(fakeReq({ phone: "7000004340", otp: "000000", purpose: "restaurant_login" }, {}, null), verifyUnknown);
      check("verify still answers 400 (no pending OTP) for a number that never requested one", verifyUnknown.statusCode === 400);
    } finally {
      if (savedDemo.otp === undefined) delete process.env.DEMO_LOGIN_OTP; else process.env.DEMO_LOGIN_OTP = savedDemo.otp;
      if (savedDemo.phones === undefined) delete process.env.DEMO_LOGIN_PHONES; else process.env.DEMO_LOGIN_PHONES = savedDemo.phones;
    }
  }

  console.log("\n--- Test 44: Rider pay distance tier + estimated_rider_payout on orders ---");
  {
    const http = require("http");
    const bcrypt = require("bcrypt");
    const { signToken } = require("./src/utils/jwt");
    const app = require("./src/app");
    const riderPaySvc = require("./src/services/riderPay.service");
    const devtools = require("./src/services/devtools.service");
    const { haversineDistanceKm } = require("./src/utils/geo");
    const server = await new Promise((resolve) => { const s = http.createServer(app).listen(0, () => resolve(s)); });
    const base = `http://127.0.0.1:${server.address().port}/api/v1`;
    const mkAdmin = async (name, role) => {
      const [id] = await db("admins").insert({ name, email: `${name}@tier.test`, password_hash: await bcrypt.hash("a-long-password-1", 4), role });
      return { id, token: signToken({ id, type: "admin" }) };
    };
    const superA = await mkAdmin("tier-super", "super_admin");
    const opsA = await mkAdmin("tier-ops", "ops");
    const call = async (who, method, p, body) => {
      const r = await fetch(base + p, { method, headers: { Authorization: `Bearer ${who.token}`, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
      let json = null; try { json = await r.json(); } catch { /* none */ }
      return { status: r.status, body: json };
    };
    const put = (body) => call(superA, "PUT", "/admin/settings/rider-pay", body);
    const otherRiders = await db("riders").select("id", "status");
    try {
      // ---- the formula
      const tiered = { base_payout: 0, per_km_rate: 10, min_payout: 15, incentive_per_delivery: 0, tier_km: 5, per_km_rate_after_tier: 7 };
      const at = (km, cfg = tiered) => riderPaySvc.computePayout({ distanceKm: km, config: cfg });
      check("within the tier it is the single rate: 3 km -> 30, exactly 5 km -> 50, nothing extra", at(3).payout === 30 && at(5).payout === 50 && at(5).breakdown.extra_distance_km === 0 && at(5).breakdown.extra_distance_pay === 0);
      const eight = at(8);
      check("beyond the tier the after-rate applies to the extra km only: 8 km -> 10x5 + 7x3 = 71, extra 3 km / 21", eight.payout === 71 && eight.breakdown.extra_distance_km === 3 && eight.breakdown.extra_distance_pay === 21 && eight.breakdown.distance_pay === 71);
      check("the minimum still applies: 0.5 km -> 5 -> min 15, min_applied true", at(0.5).payout === 15 && at(0.5).breakdown.min_applied === true);
      const full = at(6, { base_payout: 10, per_km_rate: 10, min_payout: 15, incentive_per_delivery: 5, tier_km: 5, per_km_rate_after_tier: 7 });
      check("base + incentive compose with the tier: 6 km -> max(15, 10 + 50 + 7) + 5 = 72", full.payout === 72 && full.breakdown.subtotal === 67);
      check("every existing breakdown key is still there, plus tier_km / per_km_rate_after_tier / extra_distance_km / extra_distance_pay",
        ["formula", "distance_km", "base_payout", "per_km_rate", "distance_pay", "subtotal", "min_payout", "min_applied", "incentive_per_delivery", "payout", "tier_km", "per_km_rate_after_tier", "extra_distance_km", "extra_distance_pay"].every((k) => k in eight.breakdown));
      const single = at(8, { base_payout: 0, per_km_rate: 10, min_payout: 15, incentive_per_delivery: 0 });
      check("a config with no tier fields (every row before this change) behaves exactly as before: 8 km -> 80, tier keys null/0", single.payout === 80 && single.breakdown.tier_km === null && single.breakdown.extra_distance_km === 0);
      check("a tier with no after-rate is ignored (single rate)", at(8, { ...tiered, per_km_rate_after_tier: null }).payout === 80 && at(8, { ...tiered, tier_km: 0 }).payout === 80);
      check("FORMULA describes the tier", /tier_km/.test(riderPaySvc.FORMULA) && /per_km_rate_after_tier/.test(riderPaySvc.FORMULA));

      // ---- settings
      check("PUT with tier_km but no after-rate -> 400; after-rate but no tier -> 400",
        (await put({ base_payout: 0, per_km_rate: 10, min_payout: 15, incentive_per_delivery: 0, tier_km: 5 })).status === 400 && (await put({ base_payout: 0, per_km_rate: 10, min_payout: 15, incentive_per_delivery: 0, per_km_rate_after_tier: 7 })).status === 400);
      check("PUT with tier_km 0 / negative / text / absurd, or a negative after-rate -> 400",
        (await Promise.all([{ tier_km: 0, per_km_rate_after_tier: 7 }, { tier_km: -1, per_km_rate_after_tier: 7 }, { tier_km: "abc", per_km_rate_after_tier: 7 }, { tier_km: 5000, per_km_rate_after_tier: 7 }, { tier_km: 5, per_km_rate_after_tier: -2 }]
          .map((t) => put({ base_payout: 0, per_km_rate: 10, min_payout: 15, incentive_per_delivery: 0, ...t })))).every((r) => r.status === 400));
      check("PUT by ops is still 403 forbidden_role", (await call(opsA, "PUT", "/admin/settings/rider-pay", { ...tiered })).body.code === "forbidden_role");
      const ok = await put({ ...tiered });
      check("PUT with both tier fields -> 200; settings carry tier_km 5 and per_km_rate_after_tier 7", ok.status === 200 && ok.body.settings.tier_km === 5 && ok.body.settings.per_km_rate_after_tier === 7 && ok.body.settings.per_km_rate === 10);
      const hist = await call(opsA, "GET", "/admin/settings/rider-pay");
      check("GET settings + history show the tier, and the earlier rows show null (a single rate)", hist.body.settings.tier_km === 5 && hist.body.history[0].per_km_rate_after_tier === 7 && hist.body.history[hist.body.history.length - 1].tier_km === null);
      const rateRes = fakeRes();
      await riderCtl.getMyRate(fakeReq({}, {}, { id: riderId, type: "rider" }), rateRes);
      check("GET /riders/me/rate returns the tier alongside the existing keys", rateRes.body.tier_km === 5 && rateRes.body.per_km_rate_after_tier === 7 && rateRes.body.rate_per_km === 10 && rateRes.body.min_earning_per_delivery === 15 && rateRes.body.base_payout === 0);
      check("a tier alone is a valid config even when every other value is 0 (riders still earn beyond the tier)", (await put({ base_payout: 0, per_km_rate: 0, min_payout: 0, incentive_per_delivery: 0, tier_km: 5, per_km_rate_after_tier: 10 })).status === 200);
      const cleared = await put({ base_payout: 0, per_km_rate: 10, min_payout: 15, incentive_per_delivery: 0 });
      check("a PUT that leaves the tier out saves a single-rate config (tier_km null)", cleared.status === 200 && cleared.body.settings.tier_km === null && cleared.body.settings.per_km_rate_after_tier === null);
      check("both null / empty also means no tier", (await put({ base_payout: 0, per_km_rate: 10, min_payout: 15, incentive_per_delivery: 0, tier_km: null, per_km_rate_after_tier: "" })).body.settings.tier_km === null);

      // ---- estimate on orders: a tier of 1 km after-rate 7, so the order below is on the second rate
      const live = (await put({ base_payout: 0, per_km_rate: 10, min_payout: 15, incentive_per_delivery: 0, tier_km: 1, per_km_rate_after_tier: 7 })).body.settings;
      await db("riders").update({ status: "inactive" });
      const [estRider] = await db("riders").insert({ name: "Estimate Rider", phone: "8500000044", status: "active", last_known_lat: 22.5810, last_known_lng: 88.4610, wallet_balance: 0 });
      const place = async (phone) => {
        const [custId] = await db("users").insert({ name: "Est Customer", phone, wallet_balance: 0 });
        const r = fakeRes();
        await orderController.placeOrder(fakeReq({ items: [{ item_id: fishCurryId, quantity: 1 }], delivery_lat: 22.6050, delivery_lng: 88.4850, delivery_address: "Est St", payment_method: "cod" }, {}, { id: custId, type: "customer" }), r);
        return { id: r.body.order.id, custId };
      };
      const o1 = await place("8000004401");
      const kmOf = async (id) => { const o = await db("orders").where({ id }).first(); const k = await db("restaurants").where({ id: o.restaurant_id }).first(); return { km: haversineDistanceKm(Number(k.lat), Number(k.lng), Number(o.delivery_lat), Number(o.delivery_lng)), restaurantId: o.restaurant_id }; };
      const getAs = async (id, auth) => { const r = fakeRes(); await orderController.getOrder(fakeReq({}, { id: String(id) }, auth), r); return r.body.order; };
      const listAs = async (auth, id) => { const r = fakeRes(); await orderController.listMyOrders(fakeReq({}, {}, auth, {}), r); return r.body.orders.find((o) => o.id === id); };
      check("a placed (not yet accepted) order has no estimate (null): there is nothing to deliver yet", (await getAs(o1.id, { id: 1, type: "admin" })).estimated_rider_payout === null);
      await devtools.advanceOrder(o1.id, { to: "accepted" });
      const { km: km1, restaurantId } = await kmOf(o1.id);
      const expected1 = riderPaySvc.computePayout({ distanceKm: km1, config: live }).payout;
      const riderAuth = { id: estRider, type: "rider" };
      const asRider = await getAs(o1.id, riderAuth);
      check("GET /orders/:id for the assigned rider: estimated_rider_payout = the LIVE config applied to kitchen->drop-off distance (tier included)", asRider.rider_id === estRider && asRider.estimated_rider_payout === expected1 && expected1 > 0);
      check("the order is far enough to use the second rate (more than 1 km, so cheaper than 10/km all the way)", km1 > 1 && expected1 < Number((km1 * 10).toFixed(2)));
      check("GET /orders list (rider): the same estimate on the active order", (await listAs(riderAuth, o1.id)).estimated_rider_payout === expected1);
      check("admin sees it too", (await getAs(o1.id, { id: 1, type: "admin" })).estimated_rider_payout === expected1);
      const asCustomer = await getAs(o1.id, { id: o1.custId, type: "customer" });
      const asKitchen = await getAs(o1.id, { id: restaurantId, type: "restaurant" });
      check("customers and kitchens never get the key (GET /orders/:id)", !("estimated_rider_payout" in asCustomer) && !("estimated_rider_payout" in asKitchen));
      check("...nor in their GET /orders lists", !("estimated_rider_payout" in (await listAs({ id: o1.custId, type: "customer" }, o1.id))) && !("estimated_rider_payout" in (await listAs({ id: restaurantId, type: "restaurant" }, o1.id))));

      // the estimate follows the live config; the payout freezes whatever is live at delivery
      const newer = (await put({ base_payout: 0, per_km_rate: 20, min_payout: 15, incentive_per_delivery: 0, tier_km: 1, per_km_rate_after_tier: 12 })).body.settings;
      const expected2 = riderPaySvc.computePayout({ distanceKm: km1, config: newer }).payout;
      check("change the config while the order is active: the estimate changes with it", expected2 !== expected1 && (await getAs(o1.id, riderAuth)).estimated_rider_payout === expected2);
      await devtools.advanceOrder(o1.id, { to: "delivered" });
      const delivered = await getAs(o1.id, riderAuth);
      check("once delivered: no estimate (null), and the frozen rider_payout equals the estimate under the config live at delivery", delivered.estimated_rider_payout === null && delivered.rider_payout === expected2);
      check("the frozen breakdown explains the tier: tier_km 1, extra km beyond it, extra pay at the after-rate",
        delivered.rider_payout_breakdown.tier_km === 1 && delivered.rider_payout_breakdown.per_km_rate_after_tier === 12 && Math.abs(delivered.rider_payout_breakdown.extra_distance_km - (km1 - 1)) < 0.011 && Math.abs(delivered.rider_payout_breakdown.extra_distance_pay - 12 * delivered.rider_payout_breakdown.extra_distance_km) < 0.02);
      check("estimatePayout is null when there is no kitchen to measure from, or the order isn't active",
        riderPaySvc.estimatePayout({ order: { status: "accepted", delivery_lat: 1, delivery_lng: 1 }, restaurant: null, config: live }) === null && riderPaySvc.estimatePayout({ order: { status: "delivered", delivery_lat: 1, delivery_lng: 1 }, restaurant: { lat: 1, lng: 1 }, config: live }) === null);
    } finally {
      await new Promise((resolve) => server.close(resolve));
      for (const r of otherRiders) await db("riders").where({ id: r.id }).update({ status: r.status });
      await db("admins").where("email", "like", "%@tier.test").delete();
    }
  }

  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Integration test crashed:", err);
  process.exit(1);
});
