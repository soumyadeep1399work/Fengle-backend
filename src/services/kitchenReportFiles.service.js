const path = require("path");
const PDFDocument = require("pdfkit");
const { toCsv } = require("../utils/csv");
const reports = require("./kitchenReports.service");

// pdfkit's built-in fonts have no ₹ glyph; Noto Sans (bundled, OFL) does — same as the invoice.
const FONT_REGULAR = path.join(__dirname, "../../assets/fonts/NotoSans-Regular.ttf");
const FONT_BOLD = path.join(__dirname, "../../assets/fonts/NotoSans-Bold.ttf");

const rupees = (n) => `₹${Number(n || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const dateText = (iso) => {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });
};

/**
 * A simple clean statement: Fengle + kitchen name, title, period lines, a key-figures block, then tables. Returns a Buffer.
 * sections: [{ heading, columns: [{ key, label, width, align, money }], rows, totalRow? }]; widths add up to about 495 pt.
 */
function renderPdf({ title, kitchenName, lines = [], figures = [], sections = [] }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 50 });
    doc.registerFont("Regular", FONT_REGULAR);
    doc.registerFont("Bold", FONT_BOLD);
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    doc.font("Bold").fontSize(18).fillColor("#4B18A6").text("Fengle");
    doc.font("Regular").fontSize(10).fillColor("#555").text(title);
    doc.moveDown(0.6);
    doc.fillColor("#000").font("Bold").fontSize(13).text(kitchenName);
    doc.font("Regular").fontSize(10).fillColor("#333");
    for (const l of lines) doc.text(l);
    doc.moveDown(0.8);

    if (figures.length) {
      for (const [label, value, bold] of figures) {
        const y = doc.y;
        doc.font(bold ? "Bold" : "Regular").fontSize(10).fillColor("#000");
        doc.text(label, 50, y, { width: 330 });
        doc.text(value, 380, y, { width: 165, align: "right" });
      }
      doc.moveDown(0.8);
    }

    const ensureRoom = (needed) => { if (doc.y + needed > 780) doc.addPage(); };
    for (const section of sections) {
      ensureRoom(60);
      if (section.heading) { doc.font("Bold").fontSize(11).fillColor("#4B18A6").text(section.heading, 50, doc.y); doc.moveDown(0.3); }
      const cols = section.columns;
      let x;
      const drawRow = (cells, { bold = false, shade = false } = {}) => {
        ensureRoom(18);
        const y = doc.y;
        if (shade) doc.rect(50, y - 2, 495, 15).fill("#F2EEFB");
        doc.fillColor("#000").font(bold ? "Bold" : "Regular").fontSize(8.5);
        x = 50;
        cols.forEach((c, i) => { doc.text(String(cells[i] ?? ""), x + 2, y, { width: c.width - 4, align: c.align || "left", lineBreak: false, ellipsis: true }); x += c.width; });
        doc.y = y + 15;
      };
      drawRow(cols.map((c) => c.label), { bold: true, shade: true });
      for (const r of section.rows) drawRow(cols.map((c) => (c.money ? rupees(r[c.key]) : r[c.key])));
      if (section.totalRow) {
        doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor("#ccc").stroke();
        drawRow(cols.map((c) => (c.money ? rupees(section.totalRow[c.key]) : section.totalRow[c.key] ?? "")), { bold: true });
      }
      doc.moveDown(0.8);
    }
    doc.font("Regular").fontSize(8).fillColor("#777").text(`Generated ${dateText(new Date())} · Fengle`, 50, doc.y);
    doc.end();
  });
}

const SALES_COLUMNS = [
  { key: "date", label: "Date", width: 62 }, { key: "orders_received", label: "Recv", width: 34, align: "right" }, { key: "orders_completed", label: "Done", width: 34, align: "right" },
  { key: "orders_cancelled", label: "Canc", width: 34, align: "right" }, { key: "gross_sales", label: "Gross sales", width: 62, align: "right", money: true },
  { key: "cancelled_value", label: "Cancelled", width: 56, align: "right", money: true }, { key: "refunded_value", label: "Refunds", width: 52, align: "right", money: true },
  { key: "earnings", label: "Earnings", width: 56, align: "right", money: true }, { key: "adjustments", label: "Adjust.", width: 50, align: "right", money: true },
  { key: "net_payable", label: "Net payable", width: 55, align: "right", money: true },
];
const CSV_SALES = ["date", "orders_received", "orders_completed", "orders_cancelled", "gross_sales", "cancelled_value", "refunded_value", "earnings", "adjustments", "net_payable"];

const LEDGER_COLUMNS = [
  { key: "date", label: "Date", width: 70 }, { key: "description", label: "Details", width: 215 },
  { key: "credit", label: "Earned / added", width: 70, align: "right", money: true }, { key: "debit", label: "Paid / deducted", width: 70, align: "right", money: true },
  { key: "balance", label: "Balance", width: 70, align: "right", money: true },
];
const CSV_LEDGER = ["date", "type", "description", "credit", "debit", "balance"];

/** Builds one downloadable file. `params` are the validated request parameters. Returns { buffer, contentType, filename } or null (settlement not theirs). */
async function build({ restaurantId, kind, format, params }) {
  const name = await reports.kitchenName(restaurantId);
  const isPdf = format === "pdf";

  if (kind === "sales") {
    const r = await reports.salesReport(restaurantId, params.period, params.date);
    const filename = `fengle-sales-${r.period}-${r.range.from}${r.range.to !== r.range.from ? `-to-${r.range.to}` : ""}.${format}`;
    if (!isPdf) {
      const rows = [...r.days, { date: "TOTAL", ...r.summary }, { date: `PREVIOUS ${r.previous_range.from} to ${r.previous_range.to}`, ...r.previous }];
      return { buffer: Buffer.from(toCsv(rows, CSV_SALES), "utf8"), contentType: "text/csv; charset=utf-8", filename };
    }
    const s = r.summary, p = r.previous;
    const buffer = await renderPdf({
      title: `Sales report (${r.period})`, kitchenName: name,
      lines: [`Period: ${dateText(r.range.from)}${r.range.to !== r.range.from ? ` to ${dateText(r.range.to)}` : ""}`, `Compared with: ${dateText(r.previous_range.from)}${r.previous_range.to !== r.previous_range.from ? ` to ${dateText(r.previous_range.to)}` : ""}`],
      figures: [
        ["Orders received / completed / cancelled", `${s.orders_received} / ${s.orders_completed} / ${s.orders_cancelled}   (previous ${p.orders_received} / ${p.orders_completed} / ${p.orders_cancelled})`],
        ["Gross sales", `${rupees(s.gross_sales)}   (previous ${rupees(p.gross_sales)})`], ["Cancelled value", rupees(s.cancelled_value)], ["Refunded to customers (unavailable items)", rupees(s.refunded_value)],
        ["Earnings", rupees(s.earnings)], ["Adjustments", rupees(s.adjustments)], ["Net payable", `${rupees(s.net_payable)}   (previous ${rupees(p.net_payable)})`, true],
      ],
      sections: [{ heading: "Day by day", columns: SALES_COLUMNS, rows: r.days.map((d) => ({ ...d, date: dateText(d.date) })), totalRow: { ...s, date: "Total" } }],
    });
    return { buffer, contentType: "application/pdf", filename };
  }

  if (kind === "ledger" || kind === "settlement") {
    let l; let title; let lines; let filename;
    if (kind === "ledger") {
      l = await reports.ledgerReport(restaurantId, params.from, params.to);
      title = "Account ledger"; lines = [`Period: ${dateText(l.from)} to ${dateText(l.to)}`];
      filename = `fengle-ledger-${l.from}-to-${l.to}.${format}`;
    } else {
      l = await reports.settlementStatement(restaurantId, params.payment_id);
      if (!l) return null;
      title = "Settlement statement";
      lines = [
        `Payment: ${rupees(l.payment.amount)} on ${dateText(l.payment.paid_at)}${l.payment.reference ? ` · Reference ${l.payment.reference}` : ""}${l.payment.method ? ` · ${String(l.payment.method).replace("_", " ")}` : ""}`,
        l.previous_payment_at ? `Covers everything since the previous payment on ${dateText(l.previous_payment_at)}` : "Covers everything since the beginning",
      ];
      filename = `fengle-settlement-${String(l.payment.reference || l.payment.id).replace(/[^\w.-]/g, "_")}.${format}`;
    }
    const rows = [{ date: "", type: "opening", description: "Opening balance", credit: 0, debit: 0, balance: l.opening_balance }, ...l.rows, { date: "", type: "closing", description: "Closing balance", credit: 0, debit: 0, balance: l.closing_balance }];
    if (!isPdf) return { buffer: Buffer.from(toCsv(rows, CSV_LEDGER), "utf8"), contentType: "text/csv; charset=utf-8", filename };
    const buffer = await renderPdf({
      title, kitchenName: name, lines,
      figures: [["Opening balance", rupees(l.opening_balance)], ["Earned from delivered orders", rupees(l.earned)], ["Adjustments (+ added / − deducted)", rupees(l.adjustments)], ["Paid", rupees(l.paid)], ["Closing balance (still to be paid; negative = paid in advance)", rupees(l.closing_balance), true]],
      sections: [{ heading: "Entries", columns: LEDGER_COLUMNS, rows: l.rows.map((r) => ({ ...r, date: dateText(r.date) })) }],
    });
    return { buffer, contentType: "application/pdf", filename };
  }
  return null;
}

module.exports = { build };
