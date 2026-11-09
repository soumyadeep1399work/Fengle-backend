// What Fengle pays a kitchen, and what each dish costs it, is internal: customers, kitchens and riders
// never see vendor costs or the payable. Admin controllers return their own shapes; every order row
// or order line that can reach a customer/kitchen/rider app goes through these.
// kitchen_* / rider_* = how fast a kitchen / rider reacted to the new-order alert (ops-only; admin controllers return the raw columns themselves).
const INTERNAL_ORDER_FIELDS = [
  "restaurant_payable", "payable_estimated", "delivery_fee_breakdown",
  "kitchen_notified_at", "kitchen_acknowledged_at", "kitchen_acknowledged_by", "kitchen_reminders_sent", "kitchen_last_reminder_at",
  "rider_notified_at", "rider_acknowledged_at", "rider_reminders_sent", "rider_last_reminder_at",
  // The customer's delivery details: the customer and admin see them, a rider only after pickup, a kitchen never (services/customerDetails.service.js).
  "delivery_building", "delivery_landmark", "delivery_instructions",
  // Arrival detail: admin-only. Riders get the two times and kitchens `rider_arrived_at` through riderArrival.visibleTo on the reads.
  ...["reached_restaurant", "reached_customer"].flatMap((p) => ["at", "lat", "lng", "accuracy_m", "distance_m", "manual"].map((c) => `${p}_${c}`)),
];

/** An order row without the internal settlement fields. */
function stripInternalOrderFields(order) {
  if (!order) return order;
  const copy = { ...order };
  for (const key of INTERNAL_ORDER_FIELDS) delete copy[key];
  return copy;
}

/** An order line without its vendor-cost snapshot. */
function stripInternalLineFields(line) {
  if (!line) return line;
  const { vendor_cost, ...rest } = line;
  return rest;
}

module.exports = { stripInternalOrderFields, stripInternalLineFields, INTERNAL_ORDER_FIELDS };
