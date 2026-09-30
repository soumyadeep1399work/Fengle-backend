const path = require("path");
const PDFDocument = require("pdfkit");

// pdfkit's built-in fonts (Helvetica etc.) have no ₹ glyph — it silently
// renders as "¹". Noto Sans (OFL-licensed, bundled in assets/fonts so it
// works the same on the Linux deploy target) includes U+20B9.
const FONT_REGULAR = path.join(__dirname, "../../assets/fonts/NotoSans-Regular.ttf");
const FONT_BOLD = path.join(__dirname, "../../assets/fonts/NotoSans-Bold.ttf");

// The invoice is issued by the platform, never by the fulfilling restaurant —
// the customer never learns which kitchen prepared their order (confirmed
// business rule), and this is also how Sec 9(5) CGST Act e-commerce-operator
// invoicing actually works in practice. These are placeholders: real
// GSTIN/FSSAI numbers are legal details only the client can supply — same
// "flag before it's real money/compliance" posture as the rider-rate constant.
const ISSUER = {
  name: process.env.INVOICE_ISSUER_NAME || "Fengle (placeholder legal entity)",
  gstin: process.env.INVOICE_ISSUER_GSTIN || "19XXXXX0000X1ZX (placeholder — needs real GSTIN)",
  fssai: process.env.INVOICE_ISSUER_FSSAI || "1XXXXXXXXXXX (placeholder — needs real FSSAI)",
  address: process.env.INVOICE_ISSUER_ADDRESS || "Sector V, Kolkata 700091 (placeholder)",
};

function fiscalYearLabel(date) {
  const y = date.getFullYear();
  const m = date.getMonth(); // 0-11, April = 3
  const startYear = m >= 3 ? y : y - 1;
  return `${String(startYear % 100).padStart(2, "0")}-${String((startYear + 1) % 100).padStart(2, "0")}`;
}

function buildInvoiceNumber(order) {
  const date = new Date(order.created_at);
  return `INV/${fiscalYearLabel(date)}/${String(order.id).padStart(5, "0")}`;
}

/**
 * Structured invoice data for GET /orders/:id/invoice — the PDF renderer
 * below and the JSON endpoint both build from this so the numbers can never
 * drift between the two.
 */
function buildInvoiceData(order, customer) {
  const lines = [
    { description: "Restaurant service (food items)", amount: Number(order.item_total) },
    { description: "Packaging", amount: 0 },
    { description: "Platform fee", amount: 0 },
  ];
  // GST is charged on the full, pre-discount item_total (see coupon.service.js)
  // — the coupon is a platform-funded promo applied after tax, so it only
  // shows up here as its own line; invoiceTotal below already nets it since
  // grand_total was computed that way at order placement.
  const couponDiscount = Number(order.coupon_discount_amount || 0);
  if (couponDiscount > 0) {
    lines.push({ description: `Coupon discount${order.coupon_code ? ` (${order.coupon_code})` : ""}`, amount: -couponDiscount });
  }

  return {
    invoiceNumber: buildInvoiceNumber(order),
    orderId: order.id,
    date: order.created_at,
    issuer: ISSUER,
    billedTo: { name: customer.name, address: order.delivery_address },
    lines,
    taxableValue: Number(order.item_total),
    cgstAmount: Number(order.cgst_amount),
    sgstAmount: Number(order.sgst_amount),
    deliveryFee: Number(order.delivery_fee),
    invoiceTotal: Number(order.grand_total),
    note: "This is a computer-generated invoice. Tax is charged on restaurant service under Sec 9(5) CGST Act.",
  };
}

/** Streams a one-page PDF of the invoice data straight to an Express response. */
function renderInvoicePdf(res, invoiceData) {
  const doc = new PDFDocument({ size: "A4", margin: 50 });
  doc.registerFont("Regular", FONT_REGULAR);
  doc.registerFont("Bold", FONT_BOLD);
  doc.font("Regular");
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="${invoiceData.invoiceNumber.replace(/\//g, "-")}.pdf"`);
  doc.pipe(res);

  doc.fontSize(18).text("Tax Invoice", { align: "left" });
  doc.moveDown(0.5);
  doc.fontSize(10).fillColor("#555").text(invoiceData.issuer.name);
  doc.text(`GSTIN ${invoiceData.issuer.gstin}  ·  FSSAI ${invoiceData.issuer.fssai}`);
  doc.text(invoiceData.issuer.address);
  doc.moveDown();

  doc.fillColor("#000").fontSize(10);
  doc.text(`Invoice no.: ${invoiceData.invoiceNumber}`);
  doc.text(`Order: #${invoiceData.orderId}`);
  doc.text(`Date: ${new Date(invoiceData.date).toLocaleDateString("en-IN")}`);
  doc.moveDown();
  doc.text(`Billed to: ${invoiceData.billedTo.name || "Customer"}, ${invoiceData.billedTo.address}`);
  doc.moveDown();

  // Label and amount are positioned independently at the same y (rather than
  // chained with `continued`) so the amount column right-aligns to the page
  // margin (x=545) instead of inheriting the label's narrower width.
  const twoColumn = (label, amount, size, font) => {
    const y = doc.y;
    doc.fontSize(size).font(font);
    doc.text(label, 50, y, { width: 350 });
    doc.text(amount, 400, y, { width: 145, align: "right" });
    doc.font("Regular");
  };

  twoColumn("Description", "Amount", 11, "Regular");
  doc.moveDown(0.3);
  doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor("#ccc").stroke();
  doc.moveDown(0.3);

  const row = (label, amount, opts = {}) => {
    twoColumn(label, `₹${amount.toFixed(2)}`, opts.bold ? 11 : 10, opts.bold ? "Bold" : "Regular");
  };

  for (const line of invoiceData.lines) row(line.description, line.amount);
  doc.moveDown(0.3);
  row("Taxable value", invoiceData.taxableValue);
  row("CGST 2.5%", invoiceData.cgstAmount);
  row("SGST 2.5%", invoiceData.sgstAmount);
  row("Delivery fee", invoiceData.deliveryFee);
  doc.moveDown(0.3);
  doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor("#ccc").stroke();
  doc.moveDown(0.3);
  row("Invoice total", invoiceData.invoiceTotal, { bold: true });

  doc.moveDown(1.5);
  doc.fontSize(8).fillColor("#888").text(invoiceData.note, 50, doc.y, { width: 495 });

  doc.end();
}

module.exports = { buildInvoiceData, renderInvoicePdf, buildInvoiceNumber };
