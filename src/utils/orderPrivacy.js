// What Fengle pays a kitchen, and what each dish costs it, is internal: customers, kitchens and riders
// never see vendor costs or the payable. Admin controllers return their own shapes; every order row
// or order line that can reach a customer/kitchen/rider app goes through these.
const INTERNAL_ORDER_FIELDS = ["restaurant_payable", "payable_estimated", "delivery_fee_breakdown"];

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
