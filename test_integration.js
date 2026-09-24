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
  check("body with only non-editable fields is refused (400)", (await editItem(fishCurryId, { is_active: false, id: 5 })).statusCode === 400);
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

  const asCustomer = fakeRes();
  await orderController.getOrder(fakeReq({}, { id: contactOrderId }, { id: customerId, type: "customer" }), asCustomer);
  check("customer's GET /orders/:id has NO restaurant name/address/coords", asCustomer.body.order.restaurant_name === undefined && asCustomer.body.order.restaurant_address === undefined && asCustomer.body.order.restaurant_lat === undefined);

  const asRestaurant = fakeRes();
  await orderController.getOrder(fakeReq({}, { id: contactOrderId }, { id: contactOrder.restaurant_id, type: "restaurant" }), asRestaurant);
  check("restaurant's own GET /orders/:id also has it (never restricted for them)", asRestaurant.body.order.restaurant_name === restaurantRow.name);

  const asAdmin = fakeRes();
  await orderController.getOrder(fakeReq({}, { id: contactOrderId }, { id: 1, type: "admin" }), asAdmin);
  check("admin's GET /orders/:id also has it", asAdmin.body.order.restaurant_name === restaurantRow.name);

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

  const listRider = fakeRes();
  await orderController.listMyOrders(fakeReq({}, {}, { id: riderForContact, type: "rider" }), listRider);
  check("rider's GET /orders list HAS the restaurant contact fields", listRider.body.orders.find((o) => o.id === contactOrderId).restaurant_name === restaurantRow.name);

  const riderCtl = require("./src/controllers/rider.controller");
  const assignedRes = fakeRes();
  await riderCtl.getMyAssignedOrders(fakeReq({}, {}, { id: riderForContact, type: "rider" }), assignedRes);
  check("GET /riders/me/orders also carries the restaurant's name/address", assignedRes.body.orders.find((o) => o.id === contactOrderId).restaurant_name === restaurantRow.name);

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

  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Integration test crashed:", err);
  process.exit(1);
});
