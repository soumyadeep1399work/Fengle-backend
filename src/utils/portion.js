// A dish's portion size: a number plus a unit ("3 pc", "500 gm", "1.5 ltr").
// One place for the allowed units, the label format and the input validation,
// so catalog reads, order snapshots and the admin/restaurant forms can't drift.
const PORTION_UNITS = ["pc", "gm", "kg", "ml", "ltr"];
const MAX_PORTION_VALUE = 99999.99; // the column is DECIMAL(8,2)

/** 500.00 -> "500", 1.50 -> "1.5", 0.25 -> "0.25" */
function formatPortionValue(value) {
  return String(Number(Number(value).toFixed(2)));
}

/** "3 pc" / "500 gm" — or null when the portion isn't set. */
function portionLabel(value, unit) {
  if (value == null || !unit) return null;
  return `${formatPortionValue(value)} ${unit}`;
}

/**
 * Validates the portion fields of a request body.
 *   - neither key present            -> {}            (leave the stored value alone)
 *   - both null / "" (clear)         -> { fields: { quantity_value: null, quantity_unit: null } }
 *   - both valid                     -> { fields: { quantity_value, quantity_unit } }
 *   - only one sent, one null/set, a bad number or an unknown unit -> { error }
 * Both are set together or both are null — never half a portion.
 */
function parsePortionInput(body) {
  const hasValue = body.quantity_value !== undefined;
  const hasUnit = body.quantity_unit !== undefined;
  if (!hasValue && !hasUnit) return {};
  if (hasValue !== hasUnit) return { error: "quantity_value and quantity_unit must be sent together" };

  const blank = (v) => v === null || v === "";
  if (blank(body.quantity_value) && blank(body.quantity_unit)) {
    return { fields: { quantity_value: null, quantity_unit: null } };
  }
  if (blank(body.quantity_value) || blank(body.quantity_unit)) {
    return { error: "quantity_value and quantity_unit must both be set or both be empty" };
  }

  const { quantity_value } = body;
  const value = typeof quantity_value === "string" && quantity_value.trim() !== "" ? Number(quantity_value) : quantity_value;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > MAX_PORTION_VALUE) {
    return { error: `quantity_value must be a positive number (up to ${MAX_PORTION_VALUE})` };
  }
  const rounded = Number(value.toFixed(2));
  if (rounded <= 0) return { error: "quantity_value must be a positive number" };

  const unit = typeof body.quantity_unit === "string" ? body.quantity_unit.trim().toLowerCase() : "";
  if (!PORTION_UNITS.includes(unit)) {
    return { error: `quantity_unit must be one of: ${PORTION_UNITS.join(", ")}` };
  }
  return { fields: { quantity_value: rounded, quantity_unit: unit } };
}

/** Adds the read-side portion fields to an items row: numeric value, unit, and the display label. */
function presentPortion(row) {
  return {
    ...row,
    quantity_value: row.quantity_value == null ? null : Number(row.quantity_value),
    quantity_unit: row.quantity_unit || null,
    portion_label: portionLabel(row.quantity_value, row.quantity_unit),
  };
}

/** Same for an order_items row, which stores the snapshot as portion_value/portion_unit. */
function presentLinePortion(row) {
  return {
    ...row,
    portion_value: row.portion_value == null ? null : Number(row.portion_value),
    portion_unit: row.portion_unit || null,
    portion_label: portionLabel(row.portion_value, row.portion_unit),
  };
}

module.exports = { PORTION_UNITS, portionLabel, formatPortionValue, parsePortionInput, presentPortion, presentLinePortion };
