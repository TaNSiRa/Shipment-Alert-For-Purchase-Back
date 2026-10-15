const { query, withTransaction } = require("../db/pool");
const { todayIso } = require("./dates");
const { arrivalStepNo, computeSchedule } = require("./workflowService");
const { createPo, resolveLeadTime } = require("./poService");
const {
  buildSheet, cellValue, decodeUpload, loadWorkbook, mapHeaders, normalizeMaterialCode, toDate, toNumber, toText
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
  return { lines, sheetName: sheet.name, headerRow, headers: headers.map(h => h.name) };
}

async function loadMasters(sectionId) {
  const [suppliers, materials, existing] = await Promise.all([
    query("SELECT id, supplier_code, name, short_name, default_lead_time_days FROM suppliers WHERE section_id = @sectionId", { sectionId }),
    query(
      `SELECT id, supplier_id, material_code, material_type, vendor_material, description, lead_time_days
       FROM materials WHERE section_id = @sectionId AND is_active = 1 AND material_code IS NOT NULL`,
      { sectionId }
    ),
    query("SELECT po_no, status FROM purchase_orders WHERE section_id = @sectionId", { sectionId })
  ]);
  const supplierByCode = new Map(suppliers.recordset.map(s => [`${s.supplier_code}`.trim(), s]));
  const materialsByCode = new Map();
  for (const m of materials.recordset) {
    const key = `${m.material_code}`.trim().toUpperCase();
    if (!materialsByCode.has(key)) materialsByCode.set(key, []);
    materialsByCode.get(key).push(m);
  }
  const existingPos = new Map(existing.recordset.map(p => [p.po_no, p.status]));
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
  const { lines, sheetName, headers } = await readLines(buffer);
  const headersCount = headers.length;
  const masters = await loadMasters(sectionId);
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

    const lead = resolveLeadTime(liveItems, supplier, ctx.sched);
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
    const existsStatus = masters.existingPos.get(poNo);
    if (existsStatus) errors.push(`PO ${poNo} is already in the system (${existsStatus.toLowerCase()})`);
    const status = existsStatus ? "EXISTS" : errors.length ? "ERROR" : "NEW";
    pos.push({
      poNo,
      status,
      supplierCode,
      supplierName: supplier?.name || supplierName,
      supplierShort: supplier?.short_name || null,
      supplierStatus,
      documentDate,
      docType: live[0]?.docType || null,
      plant: live[0]?.plant || null,
      shipMode: live.map(r => r.shipMode).find(Boolean) || null,
      currency: live.map(r => r.currency).find(Boolean) || null,
      remark: live.map(r => r.remark).find(Boolean) || null,
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
    errors: pos.filter(p => p.status === "ERROR").length,
    withWarnings: pos.filter(p => p.status === "NEW" && p.warnings.length).length,
    newSuppliers: [...new Set(pos.filter(p => p.supplierStatus === "NEW").map(p => p.supplierCode))].length,
    unmatchedMaterials: [...new Set(pos.flatMap(p => p.items.filter(i => i.match === "NONE" && !i.deletionIndicator).map(i => i.materialCode || "-")))].length,
    columns: headersCount,
    orphanRows
  };
  return { summary, pos };
}

async function preview(sectionId, base64, ctx) {
  const buffer = decodeUpload(base64);
  return analyze(sectionId, buffer, ctx);
}

// Re-reads the same file (the client sends it again — nothing is cached
// between preview and commit) and creates the chosen POs in one transaction:
// all of them or none.
async function commit(sectionId, { fileName, data, poNos }, user, ctx) {
  const buffer = decodeUpload(data);
  const { summary, pos } = await analyze(sectionId, buffer, ctx);
  const wanted = new Set((poNos || []).map(p => `${p}`));
  const chosen = pos.filter(p => p.status === "NEW" && (!wanted.size || wanted.has(p.poNo)));
  if (!chosen.length) {
    const err = new Error("Nothing to import — every selected PO already exists or has errors");
    err.status = 400;
    throw err;
  }
  const result = await withTransaction(async tx => {
    // Suppliers the master does not know yet are added from the file, so the
    // POs are linked from day one. Flagged in the remark so an admin can tidy.
    const supplierIds = new Map();
    const existing = (await tx.query(
      "SELECT id, supplier_code, default_lead_time_days FROM suppliers WHERE section_id = @sectionId", { sectionId }
    )).recordset;
    for (const s of existing) supplierIds.set(`${s.supplier_code}`, s);
    let suppliersAdded = 0;
    for (const p of chosen) {
      if (!p.supplierCode || supplierIds.has(p.supplierCode)) continue;
      const row = (await tx.query(
        `INSERT INTO suppliers (section_id, supplier_code, name, remark)
         OUTPUT INSERTED.id, INSERTED.supplier_code, INSERTED.default_lead_time_days
         VALUES (@sectionId, @code, @name, N'Added automatically from a PO import')`,
        { sectionId, code: p.supplierCode, name: p.supplierName || p.supplierCode }
      )).recordset[0];
      supplierIds.set(p.supplierCode, row);
      suppliersAdded += 1;
    }
    const batch = (await tx.query(
      `INSERT INTO import_batches (section_id, file_name, uploaded_by, total_rows, po_created, po_skipped, items_created, file_data, sheet_name)
       OUTPUT INSERTED.id
       VALUES (@sectionId, @fileName, @userId, @totalRows, @created, @skipped, @items, @fileData, @sheetName)`,
      {
        sectionId,
        fileName: `${fileName || "upload.xlsx"}`.slice(0, 255),
        userId: user.id,
        totalRows: summary.lines,
        created: chosen.length,
        skipped: pos.length - chosen.length,
        items: chosen.reduce((s, p) => s + p.items.length, 0),
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
    return { batchId: batch.id, created, suppliersAdded };
  });
  return { ...result, skipped: pos.length - chosen.length };
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

module.exports = { ALIASES, analyze, commit, detectShipMode, preview, readLines, splitSupplier, templateBuffer };
