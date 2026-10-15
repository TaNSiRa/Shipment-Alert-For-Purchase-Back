const ExcelJS = require("exceljs");
const { env } = require("../config/env");
const { isIsoDate } = require("./dates");

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

// Turns an uploaded base64 payload into a Buffer and checks it really is an
// .xlsx (a zip) of a sane size before anything parses it.
function decodeUpload(base64) {
  const text = `${base64 || ""}`;
  const payload = text.includes(",") && text.startsWith("data:") ? text.slice(text.indexOf(",") + 1) : text;
  if (!payload) throw httpError(400, "No file was received");
  if (!/^[A-Za-z0-9+/=\s]+$/.test(payload)) throw httpError(400, "The file could not be read");
  const buffer = Buffer.from(payload, "base64");
  if (buffer.length > env.maxUploadMb * 1024 * 1024) {
    throw httpError(400, `The file is larger than ${env.maxUploadMb} MB`);
  }
  // .xlsx is a zip archive: "PK\x03\x04". The old binary .xls is not.
  if (buffer.length < 4 || buffer[0] !== 0x50 || buffer[1] !== 0x4b) {
    if (buffer[0] === 0xd0 && buffer[1] === 0xcf) {
      throw httpError(400, "This is an old .xls file — open it in Excel and Save As .xlsx, then upload again");
    }
    throw httpError(400, "Please upload an Excel .xlsx file");
  }
  return buffer;
}

async function loadWorkbook(buffer) {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer);
  } catch {
    throw httpError(400, "The Excel file is damaged or password protected");
  }
  return workbook;
}

// Plain value of an exceljs cell (rich text, formulas, hyperlinks unwrapped).
function cellValue(cell) {
  let v = cell?.value;
  if (v === null || v === undefined) return null;
  if (typeof v === "object" && !(v instanceof Date)) {
    if (Array.isArray(v.richText)) v = v.richText.map(r => r.text).join("");
    else if ("result" in v) v = v.result;
    else if ("text" in v) v = v.text;
    else if ("error" in v) v = null;
  }
  if (typeof v === "string") {
    const t = v.trim();
    return t === "" ? null : t;
  }
  return v;
}

function normHeader(value) {
  return `${value ?? ""}`.toLowerCase().replace(/[^a-z0-9]/g, "");
}

// Finds the header row (within the first 15 rows) that contains every one of
// `required` aliases groups, and maps field -> column number.
function mapHeaders(worksheet, aliases, required) {
  const maxRow = Math.min(worksheet.rowCount, 15);
  for (let r = 1; r <= maxRow; r += 1) {
    const row = worksheet.getRow(r);
    const columns = {};
    row.eachCell({ includeEmpty: false }, (cell, col) => {
      const key = normHeader(cellValue(cell));
      for (const [field, names] of Object.entries(aliases)) {
        if (columns[field] === undefined && names.includes(key)) columns[field] = col;
      }
    });
    if (required.every(f => columns[f] !== undefined)) return { headerRow: r, columns };
  }
  return null;
}

function pad(n) {
  return `${n}`.padStart(2, "0");
}

// Accepts a real date cell, an Excel serial number, or text in the shapes
// purchase people actually type: 18.02.2026, 18/02/2026, 18-02-2026,
// 2026-02-18 (day first — this is Thailand, not the US).
function toDate(value) {
  if (value === null || value === undefined || value === "") return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return `${value.getUTCFullYear()}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())}`;
  }
  if (typeof value === "number") {
    if (value < 20000 || value > 80000) return null;
    const d = new Date(Date.UTC(1899, 11, 30) + Math.round(value) * 86400000);
    return d.toISOString().slice(0, 10);
  }
  const text = `${value}`.trim();
  let m = text.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (m) {
    const iso = `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
    return isIsoDate(iso) ? iso : null;
  }
  m = text.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/);
  if (m) {
    let year = Number(m[3]);
    if (year < 100) year += 2000;
    // Buddhist-era years (2569) -> Gregorian.
    if (year > 2400) year -= 543;
    const iso = `${year}-${pad(m[2])}-${pad(m[1])}`;
    return isIsoDate(iso) ? iso : null;
  }
  return null;
}

function toNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const n = Number(`${value}`.replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : null;
}

function toText(value, max = 255) {
  if (value === null || value === undefined) return null;
  let text;
  if (value instanceof Date) text = toDate(value);
  else if (typeof value === "number") text = Number.isInteger(value) ? `${value}` : `${value}`;
  else text = `${value}`.trim();
  if (!text) return null;
  return text.slice(0, max);
}

// SAP pads material numbers to 18 digits in some exports
// ("000000000013000465") — the master keeps the short form.
function normalizeMaterialCode(value) {
  const text = toText(value, 40);
  if (!text) return null;
  return /^\d+$/.test(text) ? text.replace(/^0+(?=\d)/, "") : text.toUpperCase();
}

// Builds a styled single-sheet workbook and returns its Buffer.
//   columns: [{ header, key, width, type: 'date'|'number'|'text' }]
async function buildSheet({ sheetName, title, subtitle, columns, rows }) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Purchase Shipment Alert";
  const ws = workbook.addWorksheet(sheetName || "Sheet1", { views: [{ state: "frozen", ySplit: title ? 3 : 1 }] });
  let headerRowNo = 1;
  if (title) {
    ws.getCell(1, 1).value = title;
    ws.getCell(1, 1).font = { bold: true, size: 14, color: { argb: "FF14161F" } };
    if (subtitle) {
      ws.getCell(2, 1).value = subtitle;
      ws.getCell(2, 1).font = { size: 10, color: { argb: "FF575D70" } };
    }
    headerRowNo = 3;
  }
  const header = ws.getRow(headerRowNo);
  columns.forEach((c, i) => {
    const cell = header.getCell(i + 1);
    cell.value = c.header;
    cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF5B53E0" } };
    cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
    ws.getColumn(i + 1).width = c.width || 16;
  });
  header.height = 22;
  rows.forEach((row, r) => {
    const excelRow = ws.getRow(headerRowNo + 1 + r);
    columns.forEach((c, i) => {
      const cell = excelRow.getCell(i + 1);
      let v = row[c.key];
      if (c.type === "date" && typeof v === "string" && isIsoDate(v)) {
        v = new Date(`${v}T00:00:00Z`);
        cell.numFmt = "dd/mm/yyyy";
      }
      if (c.type === "number" && v !== null && v !== undefined) cell.numFmt = c.numFmt || "#,##0.##";
      cell.value = v === undefined ? null : v;
      if (r % 2 === 1) cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF4F2FC" } };
    });
  });
  ws.autoFilter = { from: { row: headerRowNo, column: 1 }, to: { row: headerRowNo, column: columns.length } };
  return workbook.xlsx.writeBuffer();
}

module.exports = {
  buildSheet,
  cellValue,
  decodeUpload,
  loadWorkbook,
  mapHeaders,
  normHeader,
  normalizeMaterialCode,
  toDate,
  toNumber,
  toText
};
