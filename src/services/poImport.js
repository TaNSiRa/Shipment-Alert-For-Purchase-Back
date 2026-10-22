const { query, withTransaction } = require("../db/pool");
const { toIso, todayIso } = require("./dates");
const { arrivalStepNo, computeSchedule } = require("./workflowService");
const { addHistory, createPo, httpError, insertItem, lockPo, recomputePo, resolveLeadTime } = require("./poService");
const {
  buildSheet, cellValue, decodeUpload, loadWorkbook, mapHeaders, normHeader, normalizeMaterialCode, toDate, toNumber, toText
} = require("./excelKit");

// Column names accepted for each field, compared after lower-casing and
// stripping everything but letters and digits. The first list entry is the
// SAP export's own header ("DATA BY SAP.xlsx" — ME2N-style list), so that file
// uploads unchanged; the rest are what someone typing a sheet by hand writes.
const ALIASES = {
  poNo: ["purchasingdocument", "pono", "po", "ponumber", "purchaseorder", "purchaseorderno", "pono."],
  supplier: ["nameofsupplier", "supplier", "suppliername", "vendor", "vendorname"],
  supplierCode: ["suppliercode", "supplierid", "vendorcode", "vendorid", "vendorno", "supplierno"],
  itemNo: ["item", "itemno", "poitem", "line", "lineno"],
  docType: ["purchasingdoctype", "doctype"],
  plant: ["plant"],
  documentDate: ["documentdate", "podate", "issuepodate", "issuedate", "date", "orderdate"],
  materialCode: ["material", "materialcode", "materialno", "matno", "sapmaterial", "sapmaterialno"],
  shortText: ["shorttext", "materialdescription", "description"],
  vendorMaterial: ["vendormaterial"],
  orderQty: ["orderquantity", "quantity", "qty", "orderqty"],
  orderUnit: ["orderunit", "unit", "uom"],
  netPrice: ["netprice", "price", "unitprice"],
  currency: ["currency", "curr"],
  qtySku: ["quantityinsku"],
  skuUnit: ["stockkeepingunit", "skuunit"],
  materialGroup: ["materialgroup", "matlgroup"],
  deletion: ["deletionindicator"],
  shipMode: ["mode", "shipmode", "shipmentmode", "shipmenttype", "transportmode"],
  remark: ["remark", "remarks", "note", "notes"],
  // Kept for the future (not used by the app today).
  poHistory: ["pohistoryreleasedocumentation"],
  docCategory: ["purchdoccategory", "purchasingdoccategory"],
  orderPriceUnit: ["orderpriceunit"],
  priceUnit: ["priceunit"],
  stillQty: ["stilltobeinvoicedqty"],
  stillVal: ["stilltobeinvoicedval"],
  itemCategory: ["itemcategory"],
  acctAssignment: ["acctassignmentcat", "accountassignmentcategory"]
};

const REQUIRED = ["poNo", "documentDate"];
const MAX_ROWS = 5000;

function detectShipMode(explicit, shortText) {
  const pick = `${explicit || ""} ${shortText || ""}`.toUpperCase();
  if (/\bAIR\b/.test(pick)) return "AIR";
  if (/\bSEA\b/.test(pick)) return "SEA";
  if (/TRUCK|LAND|ROAD/.test(pick)) return "TRUCK";
  if (/COURIER|DHL|FEDEX|EXPRESS/.test(pick)) return "COURIER";
  return null;
}

// "12200003   NIHON PARKERIZING CO.,LT" -> { code: "12200003", name: "NIHON PARKERIZING CO.,LT" }
function splitSupplier(raw, codeColumn) {
  const text = toText(raw, 255);
  const explicitCode = toText(codeColumn, 30);
  if (!text) return { code: explicitCode, name: null };
  const m = text.match(/^(\d{5,})\s+(.+)$/);
  if (m) return { code: explicitCode || m[1], name: m[2].trim() };
  return { code: explicitCode, name: text };
}

// Reads the workbook into raw line objects. Throws a 400 when the sheet does
// not look like a PO list at all.
async function readLines(buffer) {
  const workbook = await loadWorkbook(buffer);
  let found = null;
  let sheet = null;
  for (const ws of workbook.worksheets) {
    found = mapHeaders(ws, ALIASES, REQUIRED);
    if (found) {
      sheet = ws;
      break;
    }
  }
  if (!found) {
    const err = new Error(
      "Could not find the PO columns. The sheet needs at least \"Purchasing Document\" (PO No.) and \"Document Date\" " +
      "headers — upload the SAP export as-is, or download the template."
    );
    err.status = 400;
    throw err;
  }
  const { headerRow, columns } = found;
  // Every header in the sheet, so each line can be kept whole (raw_data).
  const headers = [];
  sheet.getRow(headerRow).eachCell({ includeEmpty: false }, (cell, col) => {
    const name = toText(cellValue(cell), 100);
    if (name) headers.push({ col, name });
  });
  const lines = [];
  const get = (row, field) => (columns[field] ? cellValue(row.getCell(columns[field])) : null);
  for (let r = headerRow + 1; r <= sheet.rowCount; r += 1) {
    const row = sheet.getRow(r);
    const poNo = toText(get(row, "poNo"), 30);
    const rawDate = get(row, "documentDate");
    const materialCode = normalizeMaterialCode(get(row, "materialCode"));
    if (!poNo && !rawDate && !materialCode) continue; // blank line
    if (lines.length >= MAX_ROWS) {
      const err = new Error(`The file has more than ${MAX_ROWS} lines — split it into smaller files`);
      err.status = 400;
      throw err;
    }
    const raw = {};
    for (const h of headers) {
      const v = cellValue(row.getCell(h.col));
      if (v === null || v === undefined) continue;
      raw[h.name] = v instanceof Date ? toDate(v) : v;
    }
    const supplier = splitSupplier(get(row, "supplier"), get(row, "supplierCode"));
    const shortText = toText(get(row, "shortText"), 255);
    lines.push({
      rowNo: r,
      poNo: poNo ? poNo.replace(/\s+/g, "") : null,
      supplierCode: supplier.code,
      supplierName: supplier.name,
      itemNo: toText(get(row, "itemNo"), 10),
      docType: toText(get(row, "docType"), 20),
      plant: toText(get(row, "plant"), 20),
      documentDate: toDate(rawDate),
      rawDate: rawDate === null ? null : `${rawDate instanceof Date ? rawDate.toISOString().slice(0, 10) : rawDate}`,
      materialCode,
      shortText,
      vendorMaterial: toText(get(row, "vendorMaterial"), 255),
      orderQty: toNumber(get(row, "orderQty")),
      orderUnit: toText(get(row, "orderUnit"), 20),
      netPrice: toNumber(get(row, "netPrice")),
      currency: toText(get(row, "currency"), 10),
      qtySku: toNumber(get(row, "qtySku")),
      skuUnit: toText(get(row, "skuUnit"), 20),
      materialGroup: toText(get(row, "materialGroup"), 40),
      deletionIndicator: toText(get(row, "deletion"), 5),
      deleted: Boolean(toText(get(row, "deletion"), 5)),
      poHistory: toText(get(row, "poHistory"), 100),
      docCategory: toText(get(row, "docCategory"), 10),
      orderPriceUnit: toText(get(row, "orderPriceUnit"), 20),
      priceUnit: toNumber(get(row, "priceUnit")),
      stillQty: toNumber(get(row, "stillQty")),
      stillVal: toNumber(get(row, "stillVal")),
      itemCategory: toText(get(row, "itemCategory"), 10),
      acctAssignment: toText(get(row, "acctAssignment"), 10),
      raw,
      shipMode: detectShipMode(toText(get(row, "shipMode"), 20), shortText),
      remark: toText(get(row, "remark"), 500)
    });
  }
  return { lines, sheetName: sheet.name, headerRow, headers: headers.map(h => h.name), fields: Object.keys(columns) };
}

async function loadMasters(sectionId, poNos) {
  const [suppliers, materials, existing] = await Promise.all([
    query("SELECT id, supplier_code, name, short_name FROM suppliers WHERE section_id = @sectionId", { sectionId }),
    query(
      `SELECT id, supplier_id, material_code, material_type, vendor_material, description, lead_time_days
       FROM materials WHERE section_id = @sectionId AND is_active = 1 AND material_code IS NOT NULL`,
      { sectionId }
    ),
    query("SELECT id, po_no FROM purchase_orders WHERE section_id = @sectionId", { sectionId })
  ]);
  const supplierByCode = new Map(suppliers.recordset.map(s => [`${s.supplier_code}`.trim(), s]));
  const materialsByCode = new Map();
  for (const m of materials.recordset) {
    const key = `${m.material_code}`.trim().toUpperCase();
    if (!materialsByCode.has(key)) materialsByCode.set(key, []);
    materialsByCode.get(key).push(m);
  }
  // POs of the file that are already in the system, with their lines and the
  // acknowledgement date — what a re-import is compared against.
  const inFile = new Set(poNos);
  const ids = existing.recordset.filter(p => inFile.has(p.po_no)).map(p => p.id);
  const existingPos = new Map();
  if (ids.length) {
    const params = { ids: ids.join(",") };
    const [heads, items, acks] = await Promise.all([
      query(
        `SELECT id, po_no, status, supplier_id, supplier_code, supplier_name, document_date, doc_type, plant,
                ship_mode, currency, remark, lead_time_days, lead_time_source
         FROM purchase_orders WHERE id IN (SELECT value FROM STRING_SPLIT(@ids, ','))`,
        params
      ),
      query("SELECT * FROM po_items WHERE po_id IN (SELECT value FROM STRING_SPLIT(@ids, ',')) ORDER BY id", params),
      query(
        "SELECT po_id, actual_date FROM po_steps WHERE step_no = 2 AND po_id IN (SELECT value FROM STRING_SPLIT(@ids, ','))",
        params
      )
    ]);
    for (const p of heads.recordset) {
      existingPos.set(p.po_no, {
        ...p,
        items: items.recordset.filter(i => i.po_id === p.id),
        ackDate: toIso(acks.recordset.find(a => a.po_id === p.id)?.actual_date)
      });
    }
  }
  return { supplierByCode, materialsByCode, existingPos };
}

// Same-supplier master row first; otherwise any supplier's row with that code
// (taking the longest lead time, the safe side for an ETA).
function matchMaterial(materialsByCode, code, supplierId) {
  if (!code) return { match: null, how: "NONE" };
  const rows = materialsByCode.get(code.toUpperCase()) || [];
  if (!rows.length) return { match: null, how: "NONE" };
  const own = rows.filter(r => supplierId && r.supplier_id === supplierId);
  if (own.length) return { match: own.sort((a, b) => b.lead_time_days - a.lead_time_days)[0], how: "EXACT" };
  return { match: [...rows].sort((a, b) => b.lead_time_days - a.lead_time_days)[0], how: "CODE_ONLY" };
}

// Groups lines into POs and checks each one. Nothing is written.
async function analyze(sectionId, buffer, ctx) {
  const { lines, sheetName, headers, fields } = await readLines(buffer);
  const headersCount = headers.length;
  const today = todayIso();
  const groups = new Map();
  const orphanRows = [];
  for (const line of lines) {
    if (!line.poNo) {
      orphanRows.push(line.rowNo);
      continue;
    }
    if (!groups.has(line.poNo)) groups.set(line.poNo, []);
    groups.get(line.poNo).push(line);
  }
  const masters = await loadMasters(sectionId, [...groups.keys()]);

  const pos = [];
  for (const [poNo, rows] of groups) {
    const errors = [];
    const warnings = [];
    const live = rows.filter(r => !r.deleted);
    const deletedCount = rows.length - live.length;
    if (deletedCount) warnings.push(`${deletedCount} line(s) are marked deleted in SAP — kept for the record but not counted`);
    if (!live.length) errors.push("Every line of this PO is marked deleted");

    const dates = [...new Set(live.map(r => r.documentDate).filter(Boolean))].sort();
    const badDates = live.filter(r => !r.documentDate);
    if (badDates.length) errors.push(`Row ${badDates[0].rowNo}: PO date "${badDates[0].rawDate ?? ""}" is not a date`);
    if (dates.length > 1) warnings.push(`Lines have different PO dates — using the earliest (${dates[0]})`);
    const documentDate = dates[0] || null;
    if (documentDate && documentDate > today) errors.push(`PO date ${documentDate} is in the future`);

    const codes = [...new Set(live.map(r => r.supplierCode).filter(Boolean))];
    if (codes.length > 1) warnings.push(`More than one supplier on this PO — using ${codes[0]}`);
    const supplierCode = codes[0] || null;
    const supplierName = live.find(r => r.supplierCode === supplierCode)?.supplierName || live.find(r => r.supplierName)?.supplierName || null;
    const supplier = supplierCode ? masters.supplierByCode.get(supplierCode) : null;
    let supplierStatus = "MATCHED";
    if (!supplierCode) {
      supplierStatus = "MISSING";
      warnings.push("No supplier code on this PO");
    } else if (!supplier) {
      supplierStatus = "NEW";
      warnings.push(`Supplier ${supplierCode} is not in the Supplier Master — it will be added`);
    }

    const items = rows.map(r => {
      const { match, how } = matchMaterial(masters.materialsByCode, r.materialCode, supplier?.id);
      return {
        rowNo: r.rowNo,
        itemNo: r.itemNo,
        materialId: match?.id || null,
        materialCode: r.materialCode,
        shortText: r.shortText || match?.description || null,
        vendorMaterial: r.vendorMaterial || match?.vendor_material || null,
        materialType: match?.material_type || null,
        materialGroup: r.materialGroup,
        orderQty: r.orderQty,
        orderUnit: r.orderUnit,
        netPrice: r.netPrice,
        currency: r.currency,
        qtySku: r.qtySku,
        skuUnit: r.skuUnit,
        leadTimeDays: match?.lead_time_days || null,
        match: how,
        deletionIndicator: r.deletionIndicator,
        poHistory: r.poHistory,
        docCategory: r.docCategory,
        orderPriceUnit: r.orderPriceUnit,
        priceUnit: r.priceUnit,
        stillQty: r.stillQty,
        stillVal: r.stillVal,
        itemCategory: r.itemCategory,
        acctAssignment: r.acctAssignment,
        sourceRow: r.rowNo,
        raw: r.raw
      };
    });
    const liveItems = items.filter(i => !i.deletionIndicator);
    const unmatched = liveItems.filter(i => i.match === "NONE");
    if (unmatched.length) {
      warnings.push(`${unmatched.length} material(s) not in the Material Master (${unmatched.slice(0, 3).map(i => i.materialCode || "no code").join(", ")}${unmatched.length > 3 ? "…" : ""}) — lead time falls back`);
    }

    const existing = masters.existingPos.get(poNo);
    // A lead time set by hand on a PO already in the system is kept by a re-import.
    const lead = existing?.lead_time_source === "MANUAL"
      ? { days: existing.lead_time_days, source: "MANUAL" }
      : resolveLeadTime(liveItems, ctx.sched);
    let etaDate = null;
    let nextDueDate = null;
    if (documentDate) {
      const due = computeSchedule({
        steps: ctx.steps, documentDate, leadTimeDays: lead.days, actuals: { 1: documentDate },
        settings: ctx.sched, holidays: ctx.holidays
      });
      etaDate = due[arrivalStepNo(ctx.steps)];
      nextDueDate = due[2];
    }
    const header = {
      supplierCode,
      supplierName: supplier?.name || supplierName,
      documentDate,
      docType: live[0]?.docType || null,
      plant: live[0]?.plant || null,
      shipMode: live.map(r => r.shipMode).find(Boolean) || null,
      currency: live.map(r => r.currency).find(Boolean) || null,
      remark: live.map(r => r.remark).find(Boolean) || null
    };

    // Already in the system: unchanged -> EXISTS (nothing to do); different
    // -> CHANGED, which the user may choose to apply.
    let changes = null;
    let status;
    if (!existing) {
      status = errors.length ? "ERROR" : "NEW";
    } else {
      changes = diffExisting(existing, header, items, headers);
      const state = existing.status.toLowerCase();
      if (!changes.count) {
        errors.push(`PO ${poNo} is already in the system (${state}) — nothing in the file is different`);
        status = "EXISTS";
      } else if (existing.status === "CANCELLED") {
        errors.push(`PO ${poNo} is cancelled — the changes in the file are not applied (reopen it first)`);
        status = "EXISTS";
      } else {
        const dateChange = changes.po.find(c => c.field === "documentDate");
        if (dateChange && existing.ackDate && dateChange.to > existing.ackDate) {
          errors.push(`PO date ${dateChange.to} is after the acknowledgement date (${existing.ackDate})`);
        }
        for (const l of changes.lines.filter(x => x.kind === "MISSING")) {
          warnings.push(`Line ${l.itemNo ?? "-"} (${l.materialCode || "no code"}) is in the system but not in the file — it is kept`);
        }
        status = errors.length ? "ERROR" : "CHANGED";
      }
    }
    pos.push({
      poNo,
      status,
      existingId: existing?.id || null,
      existingStatus: existing?.status || null,
      changes,
      ...header,
      supplierShort: supplier?.short_name || null,
      supplierStatus,
      leadTimeDays: lead.days,
      leadTimeSource: lead.source,
      nextDueDate,
      etaDate,
      itemCount: liveItems.length,
      deletedCount,
      totalValue: liveItems.reduce((s, i) => s + (Number(i.orderQty) || 0) * (Number(i.netPrice) || 0), 0) || null,
      errors,
      warnings,
      items,
      firstRow: rows[0].rowNo
    });
  }
  pos.sort((a, b) => a.firstRow - b.firstRow);
  const summary = {
    sheetName,
    lines: lines.length,
    pos: pos.length,
    ready: pos.filter(p => p.status === "NEW").length,
    existing: pos.filter(p => p.status === "EXISTS").length,
    changed: pos.filter(p => p.status === "CHANGED").length,
    errors: pos.filter(p => p.status === "ERROR").length,
    withWarnings: pos.filter(p => p.status === "NEW" && p.warnings.length).length,
    newSuppliers: [...new Set(pos.filter(p => p.supplierStatus === "NEW").map(p => p.supplierCode))].length,
    unmatchedMaterials: [...new Set(pos.flatMap(p => p.items.filter(i => i.match === "NONE" && !i.deletionIndicator).map(i => i.materialCode || "-")))].length,
    columns: headersCount,
    orphanRows
  };
  return { summary, pos, fields, headers };
}

async function preview(sectionId, base64, ctx) {
  const buffer = decodeUpload(base64);
  const { summary, pos } = await analyze(sectionId, buffer, ctx);
  // The line pairing is only needed by commit.
  for (const p of pos) if (p.changes) delete p.changes.pairs;
  return { summary, pos };
}

// ---------------------------------------------------------------------------
// Re-import: comparing a PO in the file with the same PO already stored
// ---------------------------------------------------------------------------

// PO-level values a re-import may change. A blank in the file never clears
// what the system has (Mode and Remark are often set in the app, not in SAP).
const PO_FIELDS = [
  ["documentDate", "PO date", "document_date"],
  ["supplierCode", "Supplier", "supplier_code"],
  ["docType", "Doc type", "doc_type"],
  ["plant", "Plant", "plant"],
  ["shipMode", "Mode", "ship_mode"],
  ["currency", "Currency", "currency"],
  ["remark", "Remark", "remark"]
];

// Cell values as stored and as read can differ in form only: 8 vs "8",
// 22260 vs 22260.00 from a DECIMAL column, "0013000543" vs "13000543".
function sameValue(a, b) {
  if (`${a ?? ""}` === `${b ?? ""}`) return true;
  const na = toNumber(a);
  const nb = toNumber(b);
  return na !== null && nb !== null && Math.abs(na - nb) < 0.005;
}

// SAP writes "00010" in some exports and "10" in others.
function itemKey(itemNo) {
  const text = `${itemNo ?? ""}`.trim();
  return text ? text.replace(/^0+(?=\d)/, "") : "";
}

// One stored line against the same line in the file, by the file's column
// headers. A line imported from Excel is compared cell by cell (raw_data); one
// typed by hand has only the typed columns. A column the file does not have is
// not a change.
function lineChanges(stored, item, headers) {
  const raw = stored.raw_data ? parseRaw(stored.raw_data) : null;
  const out = [];
  for (const header of headers) {
    const field = fieldOfHeader(header);
    if (PO_LEVEL.has(field)) continue;
    let from;
    if (raw) {
      from = raw[header] ?? null;
    } else {
      const spec = field && ITEM_COLUMNS[field];
      if (!spec) continue;
      from = stored[spec[0]] ?? null;
    }
    const to = item.raw[header] ?? null;
    if (!sameValue(from, to)) out.push({ header, from, to });
  }
  return out;
}

// { po: [{ field, label, from, to }], lines: [{ kind, itemNo, ... }], pairs, count }
//   kind: ADDED (new in the file), CHANGED, MISSING (stored, not in the file —
//   kept: an export filtered to open items must not delete lines).
function diffExisting(existing, header, items, headers) {
  const po = [];
  for (const [field, label, column] of PO_FIELDS) {
    const to = header[field];
    if (to === null || to === undefined) continue;
    const from = field === "documentDate" ? toIso(existing[column]) : existing[column] ?? null;
    if (`${from ?? ""}` !== `${to}`) po.push({ field, label, from, to });
  }
  const byKey = new Map();
  for (const s of existing.items) {
    const key = itemKey(s.item_no);
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(s);
  }
  const lines = [];
  const pairs = [];
  items.forEach((item, index) => {
    const stored = byKey.get(itemKey(item.itemNo))?.shift();
    if (!stored) {
      lines.push({ kind: "ADDED", itemNo: item.itemNo, materialCode: item.materialCode, itemIndex: index, columns: [] });
      return;
    }
    pairs.push({ itemId: stored.id, itemIndex: index });
    const columns = lineChanges(stored, item, headers);
    if (columns.length) {
      lines.push({ kind: "CHANGED", itemNo: item.itemNo, materialCode: item.materialCode, itemId: stored.id, itemIndex: index, columns });
    }
  });
  for (const rest of byKey.values()) {
    for (const s of rest) lines.push({ kind: "MISSING", itemNo: s.item_no, materialCode: s.material_code, itemId: s.id, columns: [] });
  }
  const count = po.length + lines.filter(l => l.kind !== "MISSING").length;
  return { po, lines, pairs, count };
}

// Typed po_items columns a changed line gets from the file — only the fields
// the file has a column for, so a sheet without "Net Price" keeps the price.
function itemUpdate(item, fields) {
  const has = new Set(fields);
  const sets = [];
  const params = {};
  const put = (column, key, value) => {
    sets.push(`${column} = @${key}`);
    params[key] = value ?? null;
  };
  const textFields = {
    itemNo: "item_no", shortText: "short_text", vendorMaterial: "vendor_material", orderUnit: "order_unit",
    currency: "currency", skuUnit: "sku_unit", materialGroup: "material_group", poHistory: "po_history_release",
    docCategory: "doc_category", orderPriceUnit: "order_price_unit", itemCategory: "item_category",
    acctAssignment: "acct_assignment_cat"
  };
  const numberFields = {
    orderQty: "order_qty", netPrice: "net_price", qtySku: "qty_sku", priceUnit: "price_unit",
    stillQty: "still_to_invoice_qty", stillVal: "still_to_invoice_val"
  };
  for (const [field, column] of Object.entries(textFields)) if (has.has(field)) put(column, field, item[field]);
  for (const [field, column] of Object.entries(numberFields)) if (has.has(field)) put(column, field, toNumber(item[field]));
  if (has.has("deletion")) put("deletion_indicator", "deletionIndicator", item.deletionIndicator);
  // A material code brings its master row again: id, type, lead time and
  // (when the file has no Vendor Material column) the vendor's own code.
  if (has.has("materialCode")) {
    put("material_code", "materialCode", item.materialCode);
    put("material_id", "materialId", item.materialId);
    put("material_type", "materialType", item.materialType);
    put("lead_time_days", "leadTimeDays", item.leadTimeDays);
    if (!has.has("vendorMaterial")) put("vendor_material", "vendorMaterial", item.vendorMaterial);
    if (!has.has("shortText") && item.shortText) put("short_text", "shortText", item.shortText);
  }
  return { sets, params };
}

// The stored SAP row takes the file's cells; a cell blank in the file is
// cleared, a column the file does not have is kept.
function mergeRaw(storedText, fileRaw, headers) {
  const merged = { ...parseRaw(storedText) };
  for (const h of headers) {
    if (fileRaw[h] === null || fileRaw[h] === undefined) delete merged[h];
    else merged[h] = fileRaw[h];
  }
  return merged;
}

// Applies one CHANGED PO inside the commit transaction.
async function applyChanges(tx, p, { sectionId, supplier, userId, batchId, fileName, headers, fields }, ctx) {
  const po = await lockPo(tx, p.existingId, sectionId);
  if (po.status === "CANCELLED") throw httpError(409, `PO ${p.poNo} was cancelled meanwhile — preview the file again`);

  const poSets = [];
  const poParams = { poId: po.id, userId };
  let replan = false;
  const historyChanges = {};
  for (const c of p.changes.po) {
    historyChanges[c.label] = { from: c.from, to: c.to };
    if (c.field === "documentDate") {
      poSets.push("document_date = @documentDate");
      poParams.documentDate = c.to;
      replan = true;
    } else if (c.field === "supplierCode") {
      poSets.push("supplier_id = @supplierId", "supplier_code = @supplierCode", "supplier_name = @supplierName");
      Object.assign(poParams, { supplierId: supplier?.id || null, supplierCode: c.to, supplierName: p.supplierName || c.to });
    } else {
      const column = PO_FIELDS.find(f => f[0] === c.field)[2];
      poSets.push(`${column} = @${c.field}`);
      poParams[c.field] = c.to;
    }
  }
  if (poParams.documentDate) {
    await tx.query("UPDATE po_steps SET actual_date = @documentDate WHERE po_id = @poId AND step_no = 1", poParams);
  }

  // Every paired line takes the file's SAP row (PO-level cells such as the
  // Document Date live in it too); changed lines also their typed columns.
  const stored = new Map((await tx.query("SELECT id, raw_data FROM po_items WHERE po_id = @poId", { poId: po.id }))
    .recordset.map(r => [r.id, r.raw_data]));
  const changedIds = new Set(p.changes.lines.filter(l => l.kind === "CHANGED").map(l => l.itemId));
  for (const pair of p.changes.pairs) {
    if (!stored.has(pair.itemId)) continue;
    const item = p.items[pair.itemIndex];
    const { sets, params } = changedIds.has(pair.itemId) ? itemUpdate(item, fields) : { sets: [], params: {} };
    await tx.query(
      `UPDATE po_items SET ${[...sets, "raw_data = @raw", "source_row = @sourceRow"].join(", ")} WHERE id = @itemId`,
      { ...params, itemId: pair.itemId, raw: JSON.stringify(mergeRaw(stored.get(pair.itemId), item.raw, headers)), sourceRow: item.sourceRow }
    );
  }
  let added = 0;
  for (const l of p.changes.lines.filter(x => x.kind === "ADDED")) {
    await insertItem(tx, po.id, p.items[l.itemIndex]);
    added += 1;
  }

  // Value and (unless set by hand) lead time follow the lines.
  const live = (await tx.query(
    "SELECT order_qty, net_price, lead_time_days FROM po_items WHERE po_id = @poId AND deletion_indicator IS NULL",
    { poId: po.id }
  )).recordset;
  poParams.totalValue = live.reduce((sum, i) => {
    const qty = Number(i.order_qty);
    const price = Number(i.net_price);
    return i.order_qty !== null && i.net_price !== null && Number.isFinite(qty * price) ? sum + qty * price : sum;
  }, 0) || null;
  poSets.push("total_value = @totalValue");
  if (po.lead_time_source !== "MANUAL") {
    const lead = resolveLeadTime(live.map(i => ({ leadTimeDays: i.lead_time_days })), ctx.sched);
    if (lead.days !== po.lead_time_days || lead.source !== po.lead_time_source) {
      poSets.push("lead_time_days = @leadDays", "lead_time_source = @leadSource");
      Object.assign(poParams, { leadDays: lead.days, leadSource: lead.source });
      if (lead.days !== po.lead_time_days) {
        historyChanges["Lead time"] = { from: po.lead_time_days, to: lead.days };
        replan = true;
      }
    }
  }
  await tx.query(
    `UPDATE purchase_orders SET ${poSets.join(", ")}, updated_by = @userId,
       updated_at = DATEADD(HOUR, 7, SYSUTCDATETIME()) WHERE id = @poId`,
    poParams
  );
  if (replan) await recomputePo(tx, po.id, ctx, { rebaseline: true });
  await addHistory(tx, po.id, "IMPORT_UPDATED", {
    actorId: userId,
    detail: {
      fileName,
      batchId,
      changes: historyChanges,
      lines: p.changes.lines.filter(l => l.kind !== "MISSING").map(l => ({
        kind: l.kind,
        itemNo: l.itemNo,
        materialCode: l.materialCode,
        changes: Object.fromEntries(l.columns.map(c => [c.header, { from: c.from, to: c.to }]))
      }))
    }
  });
  return { id: po.id, added };
}

// Re-reads the same file (the client sends it again — nothing is cached
// between preview and commit) and, in one transaction (all of them or none),
// creates the chosen new POs and applies the file to the chosen CHANGED ones.
// A CHANGED PO is only touched when it is named in poNos.
async function commit(sectionId, { fileName, data, poNos }, user, ctx) {
  const buffer = decodeUpload(data);
  const { summary, pos, fields, headers } = await analyze(sectionId, buffer, ctx);
  const wanted = new Set((poNos || []).map(p => `${p}`));
  const chosen = pos.filter(p => p.status === "NEW" && (!wanted.size || wanted.has(p.poNo)));
  const toUpdate = pos.filter(p => p.status === "CHANGED" && wanted.has(p.poNo));
  if (!chosen.length && !toUpdate.length) {
    const err = new Error("Nothing to import — every selected PO is already in the system unchanged, or has errors");
    err.status = 400;
    throw err;
  }
  const result = await withTransaction(async tx => {
    // Suppliers the master does not know yet are added from the file, so the
    // POs are linked from day one. Flagged in the remark so an admin can tidy.
    const supplierIds = new Map();
    const existing = (await tx.query(
      "SELECT id, supplier_code FROM suppliers WHERE section_id = @sectionId", { sectionId }
    )).recordset;
    for (const s of existing) supplierIds.set(`${s.supplier_code}`, s);
    let suppliersAdded = 0;
    const supplierMoves = toUpdate.filter(p => p.changes.po.some(c => c.field === "supplierCode"));
    for (const p of [...chosen, ...supplierMoves]) {
      if (!p.supplierCode || supplierIds.has(p.supplierCode)) continue;
      const row = (await tx.query(
        `INSERT INTO suppliers (section_id, supplier_code, name, remark)
         OUTPUT INSERTED.id, INSERTED.supplier_code
         VALUES (@sectionId, @code, @name, N'Added automatically from a PO import')`,
        { sectionId, code: p.supplierCode, name: p.supplierName || p.supplierCode }
      )).recordset[0];
      supplierIds.set(p.supplierCode, row);
      suppliersAdded += 1;
    }
    const batchName = `${fileName || "upload.xlsx"}`.slice(0, 255);
    const batch = (await tx.query(
      `INSERT INTO import_batches (section_id, file_name, uploaded_by, total_rows, po_created, po_updated, po_skipped,
         items_created, file_data, sheet_name)
       OUTPUT INSERTED.id
       VALUES (@sectionId, @fileName, @userId, @totalRows, @created, @updated, @skipped, @items, @fileData, @sheetName)`,
      {
        sectionId,
        fileName: batchName,
        userId: user.id,
        totalRows: summary.lines,
        created: chosen.length,
        updated: toUpdate.length,
        skipped: pos.length - chosen.length - toUpdate.length,
        items: chosen.reduce((s, p) => s + p.items.length, 0)
          + toUpdate.reduce((s, p) => s + p.changes.lines.filter(l => l.kind === "ADDED").length, 0),
        fileData: buffer,
        sheetName: summary.sheetName
      }
    )).recordset[0];
    const created = [];
    for (const p of chosen) {
      const supplier = p.supplierCode ? supplierIds.get(p.supplierCode) : null;
      const id = await createPo(tx, {
        sectionId,
        userId: user.id,
        source: "EXCEL",
        batchId: batch.id,
        po: {
          poNo: p.poNo,
          supplierId: supplier?.id || null,
          supplier,
          supplierCode: p.supplierCode,
          supplierName: p.supplierName,
          documentDate: p.documentDate,
          docType: p.docType,
          plant: p.plant,
          shipMode: p.shipMode,
          currency: p.currency,
          remark: p.remark
        },
        items: p.items
      }, ctx);
      created.push({ id, poNo: p.poNo });
    }
    const updated = [];
    for (const p of toUpdate) {
      const supplier = p.supplierCode ? supplierIds.get(p.supplierCode) : null;
      const { id } = await applyChanges(tx, p, {
        sectionId, supplier, userId: user.id, batchId: batch.id, fileName: batchName, headers, fields
      }, ctx);
      updated.push({ id, poNo: p.poNo });
    }
    return { batchId: batch.id, created, updated, suppliersAdded };
  });
  return { ...result, skipped: pos.length - chosen.length - toUpdate.length };
}

// ---------------------------------------------------------------------------
// Editing one stored SAP line (the "all columns" view of a PO item)
// ---------------------------------------------------------------------------

// Columns that describe the whole PO, not the line. They stay read-only here —
// the PO's own Edit (or a re-import, see applyChanges) changes them, so the PO
// and its lines cannot disagree.
const PO_LEVEL = new Set(["poNo", "supplier", "supplierCode", "documentDate", "docType", "plant", "shipMode", "remark"]);

// Line fields -> po_items column and how the cell text is stored.
const ITEM_COLUMNS = {
  itemNo: ["item_no", "text", 10],
  materialCode: ["material_code", "material"],
  shortText: ["short_text", "text", 255],
  vendorMaterial: ["vendor_material", "text", 255],
  orderQty: ["order_qty", "number"],
  orderUnit: ["order_unit", "text", 20],
  netPrice: ["net_price", "number"],
  currency: ["currency", "text", 10],
  qtySku: ["qty_sku", "number"],
  skuUnit: ["sku_unit", "text", 20],
  materialGroup: ["material_group", "text", 40],
  deletion: ["deletion_indicator", "text", 5],
  poHistory: ["po_history_release", "text", 100],
  docCategory: ["doc_category", "text", 10],
  orderPriceUnit: ["order_price_unit", "text", 20],
  priceUnit: ["price_unit", "number"],
  stillQty: ["still_to_invoice_qty", "number"],
  stillVal: ["still_to_invoice_val", "number"],
  itemCategory: ["item_category", "text", 10],
  acctAssignment: ["acct_assignment_cat", "text", 10]
};

function fieldOfHeader(header) {
  const key = normHeader(header);
  return Object.keys(ALIASES).find(f => ALIASES[f].includes(key)) || null;
}

// The headers of a stored line that cannot be edited on the line itself.
function lockedHeaders(raw) {
  return Object.keys(raw || {}).filter(h => PO_LEVEL.has(fieldOfHeader(h)));
}

function parseRaw(text) {
  try {
    return text ? JSON.parse(text) || {} : {};
  } catch {
    return {};
  }
}

// values: { header: text } for the columns being changed. Only headers the
// line already has are accepted. The matching po_items columns follow, then
// the PO's value and (unless set by hand) its lead time are worked out again.
async function updateItem(poId, itemId, sectionId, values, user, ctx) {
  return withTransaction(async tx => {
    const po = await lockPo(tx, poId, sectionId);
    if (po.status === "CANCELLED") throw httpError(400, `PO ${po.po_no} is cancelled`);
    const item = (await tx.query(
      "SELECT * FROM po_items WHERE id = @itemId AND po_id = @poId", { itemId, poId }
    )).recordset[0];
    if (!item) throw httpError(404, "PO line not found");

    const raw = parseRaw(item.raw_data);
    const locked = new Set(lockedHeaders(raw));
    const changes = {};
    for (const [header, input] of Object.entries(values || {})) {
      if (!Object.prototype.hasOwnProperty.call(raw, header)) continue;
      if (locked.has(header)) throw httpError(400, `"${header}" belongs to the whole PO — change it with Edit PO`);
      const before = raw[header];
      const text = `${input ?? ""}`.trim().slice(0, 255);
      const after = !text ? null : typeof before === "number" && toNumber(text) !== null ? toNumber(text) : text;
      if (`${before ?? ""}` === `${after ?? ""}`) continue;
      const field = fieldOfHeader(header);
      if (field && ITEM_COLUMNS[field]?.[1] === "number" && after !== null && toNumber(after) === null) {
        throw httpError(400, `"${header}" must be a number`);
      }
      changes[header] = { from: before ?? null, to: after };
      raw[header] = after;
    }
    if (!Object.keys(changes).length) return { id: poId, itemId, changed: false };

    const sets = ["raw_data = @raw"];
    const params = { itemId, raw: JSON.stringify(raw) };
    const columnValues = {};
    for (const header of Object.keys(changes)) {
      const field = fieldOfHeader(header);
      const spec = field && ITEM_COLUMNS[field];
      if (!spec || columnValues[field] !== undefined) continue;
      const [column, kind, max] = spec;
      const value = kind === "number" ? toNumber(raw[header])
        : kind === "material" ? normalizeMaterialCode(raw[header])
        : toText(raw[header], max);
      columnValues[field] = value;
      sets.push(`${column} = @${field}`);
      params[field] = value;
    }

    // A new material code is looked up in the master again (this supplier's
    // row first), which also brings its lead time.
    if (columnValues.materialCode !== undefined) {
      const code = columnValues.materialCode;
      const rows = code ? (await tx.query(
        `SELECT id, supplier_id, material_type, vendor_material, lead_time_days FROM materials
         WHERE section_id = @sectionId AND is_active = 1 AND UPPER(material_code) = @code`,
        { sectionId, code: code.toUpperCase() }
      )).recordset : [];
      const byCode = new Map(rows.length ? [[code.toUpperCase(), rows]] : []);
      const { match } = matchMaterial(byCode, code, po.supplier_id);
      sets.push("material_id = @materialId", "material_type = @materialType", "lead_time_days = @itemLead");
      Object.assign(params, {
        materialId: match?.id || null, materialType: match?.material_type || null, itemLead: match?.lead_time_days || null
      });
      if (columnValues.vendorMaterial === undefined) {
        sets.push("vendor_material = @vendorMaterial");
        params.vendorMaterial = match?.vendor_material || null;
      }
    }
    await tx.query(`UPDATE po_items SET ${sets.join(", ")} WHERE id = @itemId`, params);

    const live = (await tx.query(
      "SELECT order_qty, net_price, lead_time_days FROM po_items WHERE po_id = @poId AND deletion_indicator IS NULL",
      { poId }
    )).recordset;
    const totalValue = live.reduce((sum, i) => {
      const qty = Number(i.order_qty);
      const price = Number(i.net_price);
      return i.order_qty !== null && i.net_price !== null && Number.isFinite(qty * price) ? sum + qty * price : sum;
    }, 0) || null;
    let replan = false;
    const poSets = ["total_value = @totalValue"];
    const poParams = { poId, totalValue, userId: user.id };
    if (po.lead_time_source !== "MANUAL") {
      const lead = resolveLeadTime(live.map(i => ({ leadTimeDays: i.lead_time_days })), ctx.sched);
      if (lead.days !== po.lead_time_days || lead.source !== po.lead_time_source) {
        poSets.push("lead_time_days = @leadDays", "lead_time_source = @leadSource");
        Object.assign(poParams, { leadDays: lead.days, leadSource: lead.source });
        replan = lead.days !== po.lead_time_days;
      }
    }
    await tx.query(
      `UPDATE purchase_orders SET ${poSets.join(", ")}, updated_by = @userId,
         updated_at = DATEADD(HOUR, 7, SYSUTCDATETIME()) WHERE id = @poId`,
      poParams
    );
    if (replan) await recomputePo(tx, poId, ctx, { rebaseline: true });
    await addHistory(tx, poId, "ITEM_EDITED", {
      actorId: user.id,
      detail: { itemNo: item.item_no, materialCode: item.material_code, changes }
    });
    return { id: poId, poNo: po.po_no, itemId, changed: true, replanned: replan };
  });
}

// The blank sheet offered to people who are not exporting from SAP.
async function templateBuffer() {
  return buildSheet({
    sheetName: "PO Import",
    columns: [
      { header: "Purchasing Document", key: "po", width: 20 },
      { header: "Name of Supplier", key: "supplier", width: 38 },
      { header: "Item", key: "item", width: 8 },
      { header: "Document Date", key: "date", width: 15, type: "date" },
      { header: "Material", key: "material", width: 14 },
      { header: "Short Text", key: "text", width: 36 },
      { header: "Order Quantity", key: "qty", width: 14, type: "number" },
      { header: "Order Unit", key: "unit", width: 11 },
      { header: "Net Price", key: "price", width: 13, type: "number" },
      { header: "Currency", key: "currency", width: 10 },
      { header: "Mode", key: "mode", width: 10 },
      { header: "Remark", key: "remark", width: 30 }
    ],
    rows: [
      {
        po: "1910000451", supplier: "12200003   NIHON PARKERIZING CO.,LTD.", item: "10", date: todayIso(),
        material: "13000543", text: "NPRM-12102C|(BY SEA)", qty: 8, unit: "CAN", price: 22260, currency: "JPY",
        mode: "SEA", remark: "Example row — delete before uploading"
      }
    ]
  });
}

module.exports = {
  ALIASES, analyze, commit, detectShipMode, lockedHeaders, preview, readLines, splitSupplier, templateBuffer, updateItem
};
