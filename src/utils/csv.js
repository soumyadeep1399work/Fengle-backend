// CSV for admin exports. Strings are quoted when they hold a comma/quote/newline and get a leading
// apostrophe if they start with = + - @ (a spreadsheet would otherwise run them as a formula).
// Real numbers are written as they are, so a negative amount stays a number instead of '-5.
function csvCell(value) {
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  let s = value == null ? "" : String(value);
  if (/^[=+\-@]/.test(s)) s = "'" + s;
  if (/[",\n\r]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function toCsv(rows, columns) {
  const lines = [columns.join(",")];
  for (const row of rows) lines.push(columns.map((c) => csvCell(row[c])).join(","));
  return lines.join("\r\n") + "\r\n";
}

/** Sends a CSV download. */
function sendCsv(res, filename, rows, columns) {
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.send(toCsv(rows, columns));
}

module.exports = { csvCell, toCsv, sendCsv };
