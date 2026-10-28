// What a dish costs right now: its price, or its offer price while an offer is in force.
// One place, used by catalog reads, cart quote and order placement, so a quote and the
// real order can never disagree about the price.

/** An offer is in force while offer_price is set, positive, below price, and not past offer_ends_at. */
function offerIsActive(row, now = new Date()) {
  if (row.offer_price == null) return false;
  const offer = Number(row.offer_price);
  if (!(offer > 0) || !(offer < Number(row.price))) return false;
  if (row.offer_ends_at != null && !(new Date(row.offer_ends_at) > now)) return false;
  return true;
}

/** The unit price a customer is charged. */
function effectivePrice(row, now = new Date()) {
  return offerIsActive(row, now) ? Number(row.offer_price) : Number(row.price);
}

function toIso(value) {
  return value == null ? null : new Date(value).toISOString();
}

/**
 * Customer/kitchen-facing price fields: price, offer_price + offer_ends_at (null unless the
 * offer is in force, so apps need no clock logic) and effective_price (what is charged).
 * An item still awaiting its admin-set price reads price: null.
 */
function presentPricing(row, now = new Date()) {
  const active = offerIsActive(row, now);
  return {
    ...row,
    price: row.awaiting_price ? null : Number(row.price),
    offer_price: active ? Number(row.offer_price) : null,
    offer_ends_at: active ? toIso(row.offer_ends_at) : null,
    effective_price: row.awaiting_price ? null : effectivePrice(row, now),
    ...(row.awaiting_price !== undefined ? { awaiting_price: Boolean(row.awaiting_price) } : {}),
  };
}

/** Admin-facing: the raw offer as stored, plus whether it is currently in force. */
function presentAdminPricing(row, now = new Date()) {
  return {
    ...row,
    price: row.awaiting_price ? null : Number(row.price),
    offer_price: row.offer_price == null ? null : Number(row.offer_price),
    offer_ends_at: toIso(row.offer_ends_at),
    offer_active: offerIsActive(row, now),
    effective_price: row.awaiting_price ? null : effectivePrice(row, now),
    awaiting_price: Boolean(row.awaiting_price),
  };
}

module.exports = { offerIsActive, effectivePrice, presentPricing, presentAdminPricing };
