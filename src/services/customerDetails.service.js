const { shortArea } = require("./orderNotifications.service");

/**
 * The customer's delivery details beyond the map address, and who may see them when.
 *
 *   delivery_building      flat / house no., building, floor        (<= 120)
 *   delivery_landmark      a landmark to find the place             (<= 120)
 *   delivery_instructions  "ring twice", "leave with the guard"     (<= 250)
 *
 * They are the customer's own data (they see them on their orders) and admin sees everything. A KITCHEN never gets them (it keeps seeing
 * exactly what it saw before: the delivery_address text), and a RIDER only gets the customer's details once the order is picked up:
 * until then the rider sees the area only, with the coordinates rounded to about a kilometre, and the details are hidden again once the
 * order is delivered or cancelled (support works by order number). Server-side, so an old rider app can't show what it was never sent.
 */

const FIELDS = ["delivery_building", "delivery_landmark", "delivery_instructions"];
const LIMITS = { delivery_building: 120, delivery_landmark: 120, delivery_instructions: 250 };
const LABELS = { delivery_building: "Flat / building / floor", delivery_landmark: "Landmark", delivery_instructions: "Delivery instructions" };
const RIDER_VISIBLE_STATUSES = ["picked_up", "on_the_way"];

/** Validates the optional fields of a new order. Blank or absent = null; not text or too long = 400. Returns { error } or { value }. */
function validateInput(body) {
  const b = body || {};
  const value = {};
  for (const f of FIELDS) {
    const v = b[f];
    if (v === undefined || v === null) { value[f] = null; continue; }
    if (typeof v !== "string") return { error: `${LABELS[f]} must be text` };
    const t = v.trim();
    if (t.length > LIMITS[f]) return { error: `${LABELS[f]} can be at most ${LIMITS[f]} characters` };
    value[f] = t === "" ? null : t;
  }
  return { value };
}

const round2 = (n) => (n === null || n === undefined || n === "" || !Number.isFinite(Number(n)) ? null : Number(Number(n).toFixed(2)));

/** The customer's own three fields, from the stored order row. */
function forCustomer(order) {
  return Object.fromEntries(FIELDS.map((f) => [f, order[f] ?? null]));
}

/**
 * What a rider's order read carries about the drop-off. `order` is the stored row (real coordinates); `customer` is { name, phone } of the
 * customer. Returns fields to overlay on the order object. Before pickup (and again after delivery / cancellation) the rider gets the area only.
 */
function forRider(order, customer) {
  const area = shortArea(order.delivery_address) || null;
  if (RIDER_VISIBLE_STATUSES.includes(order.status)) {
    return {
      delivery_address: order.delivery_address, delivery_lat: order.delivery_lat, delivery_lng: order.delivery_lng, delivery_area: area,
      customer_name: customer && customer.name ? customer.name : null, customer_phone: customer ? customer.phone : null,
      ...forCustomer(order), customer_details_visible: true,
    };
  }
  return {
    delivery_address: area, delivery_lat: round2(order.delivery_lat), delivery_lng: round2(order.delivery_lng), delivery_area: area,
    customer_name: null, customer_phone: null, ...Object.fromEntries(FIELDS.map((f) => [f, null])), customer_details_visible: false,
  };
}

module.exports = { FIELDS, LIMITS, validateInput, forCustomer, forRider, RIDER_VISIBLE_STATUSES };
