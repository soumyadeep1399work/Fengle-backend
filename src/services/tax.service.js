// GST on restaurant service (Sec 9(5) CGST Act) — split evenly as CGST+SGST,
// charged on item_total (taxable value). Shared by order placement and the
// cart quote preview so the two never compute a different number.
const CGST_RATE = 0.025;
const SGST_RATE = 0.025;

function computeTax(itemTotal) {
  const cgstAmount = Number((itemTotal * CGST_RATE).toFixed(2));
  const sgstAmount = Number((itemTotal * SGST_RATE).toFixed(2));
  return { cgstAmount, sgstAmount };
}

module.exports = { computeTax, CGST_RATE, SGST_RATE };
