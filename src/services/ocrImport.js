const { query, withTransaction } = require("../db/pool");
const { diffDays, isIsoDate, toIso, todayIso } = require("./dates");
const { stepNoOf } = require("./workflowService");
const { addHistory, createPo, httpError, lockPo, recomputePo } = require("./poService");
const { cellValue, decodeUpload, loadWorkbook, mapHeaders, normalizeMaterialCode, toDate, toNumber, toText } = require("./excelKit");

// The two OCR files SAP produces (Input 2 and Input 3 of the 7-step process).
// Both have the same columns:
//   Category | Acknowledgment No. / Shipping Instruction No. | SAP PO No. |
//   SAP PO Item | Ack/Ship Item | SAP Material No. | Description |
//   ETD (Descriptive) | ETA Date (Descriptive) | Ack or Ship. Quantity |
//   Order Unit in PO
// Category says which file it is: "Acknowledgement" (OCR ACK — closes step 2
// and groups POs into a shipment by Acknowledgment No.) or "Shipping
// Instructions" (OCR SI — closes step 3 and brings ETD / ETA).
const OCR_ALIASES = {
  category: ["category"],
  docNo: [
    "acknowledgmentnoshippinginstructionno", "acknowledgementnoshippinginstructionno", "acknowledgmentno",
    "acknowledgementno", "ackno", "shippinginstructionno", "sino"
  ],
  poNo: ["sappono", "pono", "purchasingdocument"],
  poItem: ["sappoitem", "poitem"],
  ackItem: ["ackshipitem", "ackitem", "shipitem"],
  materialCode: ["sapmaterialno", "materialno", "material"],
  description: ["description", "shorttext"],
  etd: ["etddescriptive", "etd", "etddate"],
  eta: ["etadatedescriptive", "etadate", "eta"],
  qty: ["ackorshipquantity", "ackquantity", "shipquantity", "quantity", "qty"],
  unit: ["orderunitinpo", "orderunit", "unit"]
};
const OCR_REQUIRED = ["docNo", "poNo"];
const MAX_ROWS = 5000;

const KIND_LABEL = { ACK: "OCR ACK", SI: "OCR SI" };

// SAP writes "00010" in some files and "10" in others.
function itemKey(itemNo) {
  const text = `${itemNo ?? ""}`.trim();
  return text ? text.replace(/^0+(?=\d)/, "") : "";
}

function sameQty(a, b) {
  return a !== null && b !== null && Math.abs(Number(a) - Number(b)) < 0.0005;
}

function fmtQty(n) {
  if (n === null || n === undefined) return "-";
  return Number.isInteger(Number(n)) ? `${Number(n)}` : `${+Number(n).toFixed(3)}`;
}

// Reads an OCR workbook. Returns null when the file is not an OCR file (the
// caller then treats it as a DATA EXPORT).
async function readOcr(buffer) {
  const workbook = await loadWorkbook(buffer);
  for (const ws of workbook.worksheets) {
    const found = mapHeaders(ws, OCR_ALIASES, OCR_REQUIRED);
    if (!found) continue;
    const { headerRow, columns } = found;
    const get = (row, field) => (columns[field] ? cellValue(row.getCell(columns[field])) : null);
    const lines = [];
    const categories = new Set();
    const orphanRows = [];
    for (let r = headerRow + 1; r <= ws.rowCount; r += 1) {
      const row = ws.getRow(r);
      const docNo = toText(get(row, "docNo"), 80);
      const poNo = toText(get(row, "poNo"), 30);
      const materialCode = normalizeMaterialCode(get(row, "materialCode"));
      if (!docNo && !poNo && !materialCode) continue;
      if (!docNo || !poNo) {
        orphanRows.push(r);
        continue;
      }
      if (lines.length >= MAX_ROWS) throw httpError(400, `The file has more than ${MAX_ROWS} lines — split it into smaller files`);
      const category = toText(get(row, "category"), 60);
      if (category) categories.add(category.toLowerCase());
      const etdRaw = get(row, "etd");
      const etaRaw = get(row, "eta");
      lines.push({
        rowNo: r,
        docNo: docNo.replace(/\s+/g, ""),
        poNo: poNo.replace(/\s+/g, ""),
        poItem: toText(get(row, "poItem"), 10),
        ackItem: toText(get(row, "ackItem"), 10),
        materialCode,
        description: toText(get(row, "description"), 255),
        etdText: toText(etdRaw, 100),
        etaText: toText(etaRaw, 100),
        etd: toDate(etdRaw),
        eta: toDate(etaRaw),
        qty: toNumber(get(row, "qty")),
        unit: toText(get(row, "unit"), 20)
      });
    }
    const cats = [...categories].join(" ");
    let kind = null;
    if (/acknowledg/.test(cats)) kind = "ACK";
    if (/shipping|instruction/.test(cats)) kind = kind ? "MIXED" : "SI";
    if (!kind) kind = lines.some(l => l.etd || l.eta) ? "SI" : "ACK";
    return { kind, lines, orphanRows, sheetName: ws.name };
  }
  return null;
}

// Every non-cancelled record (the PO and its split copies) of the file's POs,
// with lines and the actual date of every step done.
async function loadRecords(sectionId, poNos) {
  if (!poNos.length) return new Map();
  const params = { sectionId, poNos: poNos.join(",") };
  const heads = (await query(
    `SELECT p.id, p.po_no, p.split_no, p.status, p.current_step, p.ack_no, p.shipment_ref, p.document_date,
            p.supplier_code, p.supplier_name, s.short_name AS supplier_short
     FROM purchase_orders p LEFT JOIN suppliers s ON s.id = p.supplier_id
     WHERE p.section_id = @sectionId AND p.status <> 'CANCELLED'
       AND p.po_no IN (SELECT value FROM STRING_SPLIT(@poNos, ','))`,
    params
  )).recordset;
  const byPo = new Map();
  if (!heads.length) return byPo;
  const ids = { ids: heads.map(h => h.id).join(",") };
  const [items, steps] = await Promise.all([
    query(
      `SELECT id, po_id, item_no, material_code, short_text, order_qty, order_unit, ack_qty, si_qty
       FROM po_items WHERE deletion_indicator IS NULL AND po_id IN (SELECT value FROM STRING_SPLIT(@ids, ','))
       ORDER BY id`,
      ids
    ),
    query(
      `SELECT po_id, step_no, actual_date FROM po_steps
       WHERE actual_date IS NOT NULL AND po_id IN (SELECT value FROM STRING_SPLIT(@ids, ','))`,
      ids
    )
  ]);
  for (const h of heads) {
    const rec = {
      id: h.id,
      poNo: h.po_no,
      splitNo: h.split_no || 0,
      status: h.status,
      currentStep: h.current_step,
      ackNo: h.ack_no || null,
      shipmentRef: h.shipment_ref || null,
      documentDate: toIso(h.document_date),
      supplierCode: h.supplier_code,
      supplierName: h.supplier_short || h.supplier_name,
      actuals: {},
      items: items.recordset.filter(i => i.po_id === h.id).map(i => ({
        id: i.id,
        itemNo: i.item_no,
        key: itemKey(i.item_no),
        materialCode: i.material_code,
        shortText: i.short_text,
        orderQty: i.order_qty === null ? null : Number(i.order_qty),
        unit: i.order_unit,
        ackQty: i.ack_qty === null ? null : Number(i.ack_qty),
        siQty: i.si_qty === null ? null : Number(i.si_qty)
      }))
    };
    for (const s of steps.recordset.filter(x => x.po_id === h.id)) rec.actuals[s.step_no] = toIso(s.actual_date);
    if (!byPo.has(rec.poNo)) byPo.set(rec.poNo, []);
    byPo.get(rec.poNo).push(rec);
  }
  for (const list of byPo.values()) list.sort((a, b) => a.splitNo - b.splitNo);
  return byPo;
}

// File lines grouped by (document No., PO No.), in file order.
function groupLines(lines) {
  const groups = new Map();
  for (const l of lines) {
    const key = `${l.docNo}|${l.poNo}`;
    if (!groups.has(key)) groups.set(key, { docNo: l.docNo, poNo: l.poNo, lines: [] });
    groups.get(key).lines.push(l);
  }
  return [...groups.values()];
}

// The record's line a file line is about: same PO item first, then the same
// material. Each record line is used once.
function findItem(items, line, used) {
  const key = itemKey(line.poItem);
  return items.find(i => !used.has(i) && key && i.key === key)
    || items.find(i => !used.has(i) && line.materialCode && i.materialCode === line.materialCode)
    || null;
}

// Quantity of a PO line already acknowledged on the PO's other records. A
// record that has an Acknowledgment No. but no ACK quantity on the line (ACK
// marked done by hand) is taken to cover the line in full.
function ackedElsewhere(recs, self, item) {
  let sum = 0;
  for (const r of recs) {
    if (r === self || !r.ackNo) continue;
    for (const i of r.items) {
      if (!((item.key && i.key === item.key) || (!item.key && i.materialCode === item.materialCode))) continue;
      sum += i.ackQty ?? i.orderQty ?? 0;
    }
  }
  return sum;
}

function prevActual(rec, stepNo) {
  for (let n = stepNo - 1; n >= 1; n -= 1) if (rec.actuals[n]) return rec.actuals[n];
  return rec.documentDate;
}

function selectable(row) {
  return ["READY", "LINK", "SPLIT"].includes(row.status);
}

// ---------------------------------------------------------------------------
// OCR ACK
// ---------------------------------------------------------------------------

// One row per (Acknowledgment No., PO). keys (commit) = the rows the user
// ticked; the others are left out of the run, so what is simulated is exactly
// what will be written.
function analyzeAck(groups, byPo, ctx, { actualDate, keys = null }) {
  const ackStep = stepNoOf(ctx.steps, "ACK", 2);
  const rows = [];
  // What each PO line has acknowledged in the system before this file, taken
  // before the rows below change the records.
  const ackedAtStart = new Map();
  for (const poNo of new Set(groups.map(g => g.poNo))) {
    const recs = byPo.get(poNo) || [];
    for (const r of recs) {
      for (const i of r.items) {
        const id = itemId(poNo, i);
        if (!ackedAtStart.has(id)) ackedAtStart.set(id, ackedElsewhere(recs, null, i));
      }
    }
  }
  for (const g of groups) {
    const key = `${g.docNo}|${g.poNo}`;
    if (keys && !keys.has(key)) continue;
    const recs = byPo.get(g.poNo) || [];
    const row = {
      key, docNo: g.docNo, poNo: g.poNo, status: "READY", action: null, targetId: null, sourceId: null,
      splitNo: null, supplierName: recs[0]?.supplierName || null, currentStep: null,
      etdText: g.lines.map(l => l.etdText).find(Boolean) || null,
      errors: [], warnings: [], lines: [], firstRow: g.lines[0].rowNo
    };
    rows.push(row);
    if (!recs.length) {
      row.status = "NOT_FOUND";
      row.errors.push(`PO ${g.poNo} is not in the system — import it with the DATA EXPORT BY SAP first`);
      row.lines = g.lines.map(l => lineView(l, null, null));
      continue;
    }
    if (recs.some(r => r.ackNo === g.docNo)) {
      row.status = "ALREADY";
      row.errors.push(`Acknowledgment No. ${g.docNo} is already recorded on PO ${g.poNo}`);
      row.lines = g.lines.map(l => lineView(l, null, null));
      row.targetId = recs.find(r => r.ackNo === g.docNo).id;
      continue;
    }
    const open = recs.filter(r => r.status === "ACTIVE" && r.currentStep === ackStep && !r.ackNo);
    const unlinked = recs.filter(r => !r.ackNo && r.currentStep > ackStep);
    let target;
    if (open.length) {
      target = open[0];
      row.action = "ADVANCE";
    } else if (unlinked.length) {
      target = unlinked[0];
      row.action = "LINK";
      row.status = "LINK";
      row.warnings.push(`The ACK step of this PO was already marked done by hand — Acknowledgment No. ${g.docNo} is linked to it, no step moves`);
    } else {
      // Every record of the PO already has its own Acknowledgment No.: this
      // one is another part of the PO shipped separately -> a copy of the PO
      // holding only this acknowledgement's lines.
      target = recs.find(r => r.splitNo === 0) || recs[0];
      row.action = "SPLIT";
      row.status = "SPLIT";
      row.sourceId = target.id;
      row.splitNo = Math.max(...recs.map(r => r.splitNo)) + 1;
    }
    row.targetId = row.action === "SPLIT" ? null : target.id;
    row.currentStep = target.currentStep;

    // Quantities: each file line against the PO line, counting what other
    // acknowledgements of the same PO already cover.
    const used = new Set();
    const matched = [];
    for (const l of g.lines) {
      const item = findItem(target.items, l, used);
      if (!item) {
        row.warnings.push(`Item ${l.poItem ?? "-"} (${l.materialCode || "no material"}) is not on PO ${g.poNo} in the system`);
        row.lines.push(lineView(l, null, "NOT_ON_PO"));
        continue;
      }
      used.add(item);
      const before = ackedElsewhere(recs, row.action === "SPLIT" ? null : target, item);
      const open = item.orderQty === null ? null : item.orderQty - before;
      let state = "OK";
      if (l.qty === null) {
        state = "NO_QTY";
        row.warnings.push(`Item ${item.itemNo ?? "-"} (${item.materialCode || "-"}): no quantity in the file`);
      } else if (open !== null && l.qty > open + 0.0005) {
        state = "OVER";
        row.warnings.push(`Item ${item.itemNo ?? "-"} (${item.materialCode || "-"}): ACK ${fmtQty(l.qty)} is more than the ${before ? "open " : ""}order quantity ${fmtQty(open)} ${item.unit || ""}`.trim());
      } else if (open !== null && l.qty < open - 0.0005) {
        state = "PARTIAL";
        row.warnings.push(`Item ${item.itemNo ?? "-"} (${item.materialCode || "-"}): ACK ${fmtQty(l.qty)} of ${fmtQty(open)} ${item.unit || ""} — the other ${fmtQty(open - l.qty)} must come on another Acknowledgment No.`.replace(/ +/g, " "));
      }
      row.lines.push(lineView(l, { ...item, ackedBefore: before }, state));
      matched.push({ item, line: l, state });
    }
    if (row.action !== "SPLIT") {
      const notOnAck = target.items.filter(i => !used.has(i));
      if (notOnAck.length) {
        row.warnings.push(`${notOnAck.length} line(s) of the PO are not on this ACK (${notOnAck.slice(0, 4).map(i => i.itemNo || i.materialCode).join(", ")}${notOnAck.length > 4 ? "…" : ""}) — they stay on the PO; a later ACK for them becomes a separate shipment`);
      }
    }
    if (row.action === "SPLIT") {
      if (!matched.length) {
        row.errors.push(`None of the file's lines match a line of PO ${g.poNo} — nothing to copy`);
      } else if (row.lines.every(l => l.state === "OVER" || l.state === "NOT_ON_PO")) {
        const others = [...new Set(recs.map(r => r.ackNo).filter(Boolean))].join(", ");
        row.errors.push(`PO ${g.poNo} is already acknowledged in full (Acknowledgment No. ${others}) — nothing is left for ${g.docNo}. If the ACK No. on the PO is wrong, correct it with Edit PO.`);
      }
    }
    const minDate = row.action === "SPLIT" ? target.documentDate : prevActual(target, ackStep);
    if (row.action !== "LINK" && actualDate && minDate && actualDate < minDate) {
      row.errors.push(`The ACK date ${actualDate} is before the previous step (${minDate})`);
    }
    if (row.errors.length) {
      row.status = "ERROR";
      continue;
    }
    row.matched = matched;
    // What this row does to the PO, so a later row of the same file (another
    // Acknowledgment No. of the same PO) sees it.
    const ackLines = matched.map(m => ({ ...m.item, ackQty: m.line.qty }));
    if (row.action === "SPLIT") {
      recs.push({
        id: null, poNo: g.poNo, splitNo: row.splitNo, status: "ACTIVE", currentStep: ackStep + 1, ackNo: g.docNo,
        documentDate: target.documentDate, actuals: {}, items: ackLines, supplierName: target.supplierName
      });
    } else {
      target.ackNo = g.docNo;
      if (row.action === "ADVANCE") target.currentStep = ackStep + 1;
      for (const m of matched) m.item.ackQty = m.line.qty;
    }
  }
  blockUnbalancedPos(rows, ackedAtStart);
  return rows;
}

// A PO line + its PO, as ackedElsewhere matches lines (item No. first, else
// material).
function itemId(poNo, item) {
  return `${poNo}|${item.key ? `k:${item.key}` : `m:${item.materialCode || ""}`}`;
}

// A quantity difference on an ACK line is allowed only when the other lines of
// the same PO in this file (another Acknowledgment No.) make the line up to
// what is still open in the system. Otherwise every row of that PO is blocked:
// the rows of one PO are written together or not at all, since a later row of
// the PO (a part shipment) was worked out on top of the earlier ones.
function blockUnbalancedPos(rows, ackedAtStart) {
  for (const poNo of new Set(rows.map(r => r.poNo))) {
    const live = rows.filter(r => r.poNo === poNo && selectable(r) && r.matched);
    const lines = new Map();
    for (const r of live) {
      for (const m of r.matched) {
        const id = itemId(poNo, m.item);
        if (!lines.has(id)) lines.set(id, { item: m.item, total: 0, noQty: false, diff: false, rows: new Set() });
        const x = lines.get(id);
        if (m.line.qty === null) x.noQty = true;
        else x.total += m.line.qty;
        if (m.state === "PARTIAL" || m.state === "OVER") x.diff = true;
        x.rows.add(r);
      }
    }
    const problems = [];
    for (const [id, x] of lines) {
      if (!x.diff || x.noQty || x.item.orderQty === null) continue;
      const open = x.item.orderQty - (ackedAtStart.get(id) || 0);
      if (Math.abs(x.total - open) <= 0.0005) continue;
      const unit = x.item.unit || "";
      const gap = x.total < open
        ? `${fmtQty(open - x.total)} ${unit} is missing`
        : `${fmtQty(x.total - open)} ${unit} too many`;
      problems.push(`Item ${x.item.itemNo ?? "-"} (${x.item.materialCode || "-"}): this file acknowledges ${fmtQty(x.total)} of ${fmtQty(open)} ${unit} — ${gap}`.replace(/ +/g, " "));
    }
    if (!problems.length) continue;
    for (const r of live) {
      r.status = "ERROR";
      for (const p of problems) {
        r.errors.push(`${p}. A quantity difference must be made up by another line of PO ${poNo} in the same file (another Acknowledgment No.) so the total equals the PO — PO ${poNo} is not updated.`);
      }
    }
  }
}

function lineView(l, item, state) {
  return {
    rowNo: l.rowNo,
    poItem: l.poItem,
    materialCode: l.materialCode,
    description: l.description,
    qty: l.qty,
    unit: l.unit,
    orderQty: item ? item.orderQty : null,
    expectedQty: item ? item.expectedQty ?? null : null,
    ackedBefore: item ? item.ackedBefore ?? null : null,
    itemNo: item ? item.itemNo : null,
    state
  };
}

// ---------------------------------------------------------------------------
// OCR SI
// ---------------------------------------------------------------------------

// One row per (S/I No., PO record). A PO split over two acknowledgements has
// two records waiting at the S/I step; each file line goes to the record
// whose line and quantity it matches.
function analyzeSi(groups, byPo, ctx, { actualDate, keys = null }) {
  const siStep = stepNoOf(ctx.steps, "SI", 3);
  const rows = [];
  for (const g of groups) {
    const recs = byPo.get(g.poNo) || [];
    const base = {
      docNo: g.docNo, poNo: g.poNo, status: "READY", action: "ADVANCE", targetId: null, splitNo: null,
      ackNo: null, supplierName: recs[0]?.supplierName || null, currentStep: null, etd: null, eta: null,
      errors: [], warnings: [], lines: [], firstRow: g.lines[0].rowNo
    };
    const etds = [...new Set(g.lines.map(l => l.etd).filter(Boolean))].sort();
    const etas = [...new Set(g.lines.map(l => l.eta).filter(Boolean))].sort();
    const dated = { etd: etds[0] || null, eta: etas[etas.length - 1] || null };
    const push = (row, rec) => {
      const key = `${g.docNo}|${g.poNo}|${rec ? rec.id : 0}`;
      if (keys && !keys.has(key)) return null;
      const full = { ...base, ...dated, ...row, key, errors: [...(row.errors || [])], warnings: [...(row.warnings || [])] };
      rows.push(full);
      return full;
    };
    if (!recs.length) {
      push({ status: "NOT_FOUND", errors: [`PO ${g.poNo} is not in the system — import it with the DATA EXPORT BY SAP first`],
        lines: g.lines.map(l => lineView(l, null, null)) }, null);
      continue;
    }
    const cands = recs.filter(r => r.status === "ACTIVE" && r.currentStep === siStep);
    if (!cands.length) {
      const done = recs.find(r => r.shipmentRef === g.docNo);
      const waiting = recs.find(r => r.status === "ACTIVE" && r.currentStep < siStep);
      push({
        status: done ? "ALREADY" : waiting ? "NOT_READY" : "ALREADY",
        targetId: (done || waiting || recs[0]).id,
        ackNo: (done || waiting || recs[0]).ackNo,
        currentStep: (done || waiting || recs[0]).currentStep,
        errors: [done
          ? `S/I ${g.docNo} is already recorded on PO ${g.poNo}`
          : waiting
            ? `PO ${g.poNo} is still waiting for its OCR ACK (step ${waiting.currentStep}) — upload the ACK first, or mark it done by hand`
            : `PO ${g.poNo} is already past the S/I step`],
        lines: g.lines.map(l => lineView(l, null, null))
      }, done || waiting || recs[0]);
      continue;
    }
    // Lines -> records.
    const assigned = new Map(cands.map(c => [c, []]));
    const used = new Map(cands.map(c => [c, new Set()]));
    const orphan = [];
    for (const l of g.lines) {
      const key = itemKey(l.poItem);
      const expected = i => (i.ackQty ?? i.orderQty);
      let pick = null;
      for (const c of cands) {
        const item = c.items.find(i => !used.get(c).has(i) && ((key && i.key === key) || (!key && l.materialCode && i.materialCode === l.materialCode)) && sameQty(expected(i), l.qty));
        if (item) { pick = { c, item }; break; }
      }
      if (!pick) {
        for (const c of cands) {
          const item = findItem(c.items, l, used.get(c));
          if (item) { pick = { c, item }; break; }
        }
      }
      if (!pick) {
        orphan.push(l);
        continue;
      }
      used.get(pick.c).add(pick.item);
      assigned.get(pick.c).push({ line: l, item: pick.item });
    }
    let targets = cands.filter(c => assigned.get(c).length);
    if (!targets.length) targets = [cands[0]];
    for (const c of targets) {
      const matched = assigned.get(c);
      const row = { targetId: c.id, splitNo: c.splitNo, ackNo: c.ackNo, currentStep: c.currentStep, warnings: [], errors: [], lines: [] };
      for (const m of matched) {
        const expected = m.item.ackQty ?? m.item.orderQty;
        let state = "OK";
        if (m.line.qty === null) state = "NO_QTY";
        else if (expected !== null && !sameQty(expected, m.line.qty)) {
          state = m.line.qty > expected ? "OVER" : "PARTIAL";
          row.warnings.push(`Item ${m.item.itemNo ?? "-"} (${m.item.materialCode || "-"}): S/I ${fmtQty(m.line.qty)}, ${m.item.ackQty !== null ? "acknowledged" : "ordered"} ${fmtQty(expected)} ${m.item.unit || ""}`.trim());
        }
        row.lines.push(lineView(m.line, { ...m.item, expectedQty: expected }, state));
      }
      if (targets.length === 1) {
        for (const l of orphan) {
          row.warnings.push(`Item ${l.poItem ?? "-"} (${l.materialCode || "no material"}) is not on PO ${g.poNo} in the system`);
          row.lines.push(lineView(l, null, "NOT_ON_PO"));
        }
        const missing = c.items.filter(i => !used.get(c).has(i) && (i.ackQty === null || i.ackQty > 0));
        if (matched.length && missing.length) {
          row.warnings.push(`${missing.length} line(s) of this shipment are not on the S/I (${missing.slice(0, 4).map(i => i.itemNo || i.materialCode).join(", ")}${missing.length > 4 ? "…" : ""})`);
        }
      }
      if (!dated.etd && !dated.eta) row.warnings.push("No ETD / ETA date in the file for this PO");
      if (etds.length > 1 || etas.length > 1) row.warnings.push(`Lines have different dates — using ETD ${dated.etd || "-"}, ETA ${dated.eta || "-"}`);
      if (dated.etd && dated.eta && dated.eta < dated.etd) row.warnings.push(`ETA ${dated.eta} is before ETD ${dated.etd}`);
      const minDate = prevActual(c, siStep);
      if (actualDate && minDate && actualDate < minDate) row.errors.push(`The S/I date ${actualDate} is before the previous step (${minDate})`);
      if (row.errors.length) row.status = "ERROR";
      const pushed = push(row, c);
      if (pushed) pushed.matched = matched;
    }
    if (targets.length > 1 && orphan.length) {
      const last = rows[rows.length - 1];
      if (last && last.poNo === g.poNo) {
        for (const l of orphan) last.warnings.push(`Item ${l.poItem ?? "-"} (${l.materialCode || "no material"}) matches none of the PO's shipments`);
      }
    }
    const waitingOthers = cands.filter(c => !targets.includes(c));
    if (waitingOthers.length) {
      const last = rows[rows.length - 1];
      if (last && last.poNo === g.poNo) {
        last.warnings.push(`PO ${g.poNo} has ${waitingOthers.length} other shipment(s) waiting for an S/I (ACK ${waitingOthers.map(c => c.ackNo || "-").join(", ")}) — not on this file`);
      }
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Preview / commit
// ---------------------------------------------------------------------------

function checkDate(actualDate) {
  const date = actualDate || todayIso();
  if (!isIsoDate(date)) throw httpError(400, "The date must be a valid date");
  if (date > todayIso()) throw httpError(400, "The date cannot be in the future");
  return date;
}

async function analyze(sectionId, parsed, ctx, { actualDate, keys = null }) {
  if (parsed.kind === "MIXED") {
    throw httpError(400, "This file has both Acknowledgement and Shipping Instructions rows — upload them as separate files");
  }
  const groups = groupLines(parsed.lines);
  const byPo = await loadRecords(sectionId, [...new Set(groups.map(g => g.poNo))]);
  const rows = parsed.kind === "ACK"
    ? analyzeAck(groups, byPo, ctx, { actualDate, keys })
    : analyzeSi(groups, byPo, ctx, { actualDate, keys });
  rows.sort((a, b) => a.firstRow - b.firstRow);
  const shipments = [];
  for (const r of rows) {
    let s = shipments.find(x => x.docNo === r.docNo);
    if (!s) {
      s = { docNo: r.docNo, pos: 0, ready: 0, etdText: r.etdText || null, etd: r.etd || null, eta: r.eta || null };
      shipments.push(s);
    }
    s.pos += 1;
    if (selectable(r)) s.ready += 1;
  }
  const count = st => rows.filter(r => r.status === st).length;
  const summary = {
    kind: parsed.kind,
    kindLabel: KIND_LABEL[parsed.kind],
    sheetName: parsed.sheetName,
    lines: parsed.lines.length,
    shipments: shipments.length,
    pos: new Set(rows.map(r => r.poNo)).size,
    rows: rows.length,
    ready: count("READY"),
    split: count("SPLIT"),
    link: count("LINK"),
    already: count("ALREADY"),
    notFound: count("NOT_FOUND"),
    notReady: count("NOT_READY"),
    errors: count("ERROR"),
    qtyDiffs: rows.filter(r => r.lines.some(l => ["PARTIAL", "OVER", "NOT_ON_PO"].includes(l.state))).length,
    orphanRows: parsed.orphanRows
  };
  return { summary, rows, shipments };
}

function publicRow(r) {
  const { matched, ...rest } = r;
  return { ...rest, lines: sortLines(rest.lines), selectable: selectable(r) };
}

// Lines in PO item order (10, 20, 30 …) whatever order the file lists them in;
// a line without an item No. goes last, in file order.
function sortLines(lines) {
  const no = l => {
    const n = Number(itemKey(l.poItem ?? l.itemNo));
    return itemKey(l.poItem ?? l.itemNo) && Number.isFinite(n) ? n : Infinity;
  };
  return [...lines].sort((a, b) => no(a) - no(b) || a.rowNo - b.rowNo);
}

async function preview(sectionId, parsed, ctx, { actualDate }) {
  const date = checkDate(actualDate);
  const { summary, rows, shipments } = await analyze(sectionId, parsed, ctx, { actualDate: date });
  return { kind: parsed.kind, actualDate: date, summary, shipments, rows: rows.map(publicRow) };
}

// Re-reads the file and writes the ticked rows in one transaction.
async function commit(sectionId, parsed, { fileName, buffer, keys, actualDate }, user, ctx) {
  const date = checkDate(actualDate);
  const wanted = new Set((keys || []).map(k => `${k}`));
  if (!wanted.size) throw httpError(400, "Tick at least one PO");
  const { rows, summary } = await analyze(sectionId, parsed, ctx, { actualDate: date, keys: wanted });
  const chosen = rows.filter(r => selectable(r));
  if (!chosen.length) {
    throw httpError(400, rows[0]?.errors?.[0] || "Nothing to update — the ticked POs are already done or have errors");
  }
  const kind = parsed.kind;
  const stepNo = stepNoOf(ctx.steps, kind === "ACK" ? "ACK" : "SI", kind === "ACK" ? 2 : 3);
  const step = ctx.steps.find(s => s.stepNo === stepNo);
  const label = KIND_LABEL[kind];
  return withTransaction(async tx => {
    const batchName = `${fileName || "upload.xlsx"}`.slice(0, 255);
    const batch = (await tx.query(
      `INSERT INTO import_batches (section_id, file_name, uploaded_by, total_rows, po_created, po_updated, po_skipped,
         items_created, file_data, sheet_name, kind)
       OUTPUT INSERTED.id
       VALUES (@sectionId, @fileName, @userId, @totalRows, @created, @updated, @skipped, 0, @fileData, @sheetName, @kind)`,
      {
        sectionId, fileName: batchName, userId: user.id, totalRows: summary.lines,
        created: chosen.filter(r => r.action === "SPLIT").length,
        updated: chosen.filter(r => r.action !== "SPLIT").length,
        skipped: rows.length - chosen.length,
        fileData: buffer, sheetName: summary.sheetName, kind
      }
    )).recordset[0];
    const moved = [];
    const created = [];
    const linked = [];
    for (const r of chosen) {
      const remark = `${label} file ${batchName}`.slice(0, 500);
      if (r.action === "SPLIT") {
        const id = await createSplit(tx, r, { sectionId, user, batchId: batch.id, date, stepNo, step, remark }, ctx);
        created.push({ id, poNo: r.poNo, docNo: r.docNo });
        continue;
      }
      const po = await lockPo(tx, r.targetId, sectionId);
      if (r.action === "LINK") {
        await tx.query(
          `UPDATE purchase_orders SET ack_no = @docNo, ack_etd_text = COALESCE(@etdText, ack_etd_text),
             updated_by = @userId, updated_at = DATEADD(HOUR, 7, SYSUTCDATETIME()) WHERE id = @poId`,
          { poId: po.id, docNo: r.docNo, etdText: r.etdText || null, userId: user.id }
        );
        await tx.query(
          "UPDATE po_steps SET reference_no = COALESCE(reference_no, @docNo) WHERE po_id = @poId AND step_no = @stepNo",
          { poId: po.id, docNo: r.docNo, stepNo }
        );
        await setQty(tx, r.matched, "ack_qty");
        await addHistory(tx, po.id, "ACK_LINKED", {
          stepNo, actorId: user.id, detail: { referenceNo: r.docNo, fileName: batchName, batchId: batch.id }
        });
        linked.push({ id: po.id, poNo: r.poNo, docNo: r.docNo });
        continue;
      }
      if (po.status !== "ACTIVE" || po.current_step !== stepNo) {
        throw httpError(409, `PO ${r.poNo} has moved on meanwhile (now at step ${po.current_step}) — preview the file again`);
      }
      const due = toIso((await tx.query(
        "SELECT due_date FROM po_steps WHERE po_id = @poId AND step_no = @stepNo", { poId: po.id, stepNo }
      )).recordset[0]?.due_date);
      await tx.query(
        `UPDATE po_steps SET actual_date = @date, done_by = @userId, done_at = DATEADD(HOUR, 7, SYSUTCDATETIME()),
           reference_no = @docNo, remark = @remark
         WHERE po_id = @poId AND step_no = @stepNo`,
        { poId: po.id, stepNo, date, userId: user.id, docNo: r.docNo, remark }
      );
      if (kind === "ACK") {
        await tx.query(
          `UPDATE purchase_orders SET current_step = @next, ack_no = @docNo, ack_etd_text = @etdText,
             updated_by = @userId, updated_at = DATEADD(HOUR, 7, SYSUTCDATETIME()) WHERE id = @poId`,
          { poId: po.id, next: stepNo + 1, docNo: r.docNo, etdText: r.etdText || null, userId: user.id }
        );
        await setQty(tx, r.matched, "ack_qty");
      } else {
        await tx.query(
          `UPDATE purchase_orders SET current_step = @next, shipment_ref = @docNo, etd_date = @etd, si_eta_date = @eta,
             updated_by = @userId, updated_at = DATEADD(HOUR, 7, SYSUTCDATETIME()) WHERE id = @poId`,
          { poId: po.id, next: stepNo + 1, docNo: r.docNo, etd: r.etd || null, eta: r.eta || null, userId: user.id }
        );
        await setQty(tx, r.matched, "si_qty");
      }
      await recomputePo(tx, po.id, ctx);
      await addHistory(tx, po.id, "STEP_DONE", {
        stepNo,
        actorId: user.id,
        detail: {
          stepName: step?.name, actualDate: date, dueDate: due, lateDays: due ? diffDays(due, date) : null,
          referenceNo: r.docNo, remark, source: kind === "ACK" ? "OCR_ACK" : "OCR_SI", fileName: batchName,
          batchId: batch.id, etd: r.etd || null, eta: r.eta || null
        }
      });
      moved.push({ id: po.id, poNo: r.poNo, docNo: r.docNo });
    }
    return { kind, batchId: batch.id, moved, created, linked, skipped: rows.length - chosen.length };
  });
}

// Quantities from the file onto the matched lines (a PO line listed twice in
// one acknowledgement adds up).
async function setQty(tx, matched, column) {
  const sums = new Map();
  for (const m of matched || []) {
    if (!m.item.id || m.line.qty === null) continue;
    sums.set(m.item.id, (sums.get(m.item.id) || 0) + m.line.qty);
  }
  for (const [itemId, qty] of sums) {
    await tx.query(`UPDATE po_items SET ${column} = @qty WHERE id = @itemId`, { itemId, qty });
  }
}

// The second (third…) Acknowledgment No. of a PO: a copy of the PO's record —
// header, plan, Delivery date — holding only the lines of this
// acknowledgement, with their ACK quantity, already past the ACK step.
async function createSplit(tx, r, { sectionId, user, batchId, date, stepNo, step, remark }, ctx) {
  const src = (await tx.query(
    "SELECT * FROM purchase_orders WITH (UPDLOCK) WHERE id = @id AND section_id = @sectionId",
    { id: r.sourceId, sectionId }
  )).recordset[0];
  if (!src) throw httpError(409, `PO ${r.poNo} was removed meanwhile — preview the file again`);
  const taken = (await tx.query(
    "SELECT MAX(split_no) AS n FROM purchase_orders WHERE section_id = @sectionId AND po_no = @poNo",
    { sectionId, poNo: r.poNo }
  )).recordset[0].n;
  const splitNo = (taken ?? 0) + 1;
  const srcItems = (await tx.query("SELECT * FROM po_items WHERE po_id = @id ORDER BY id", { id: src.id })).recordset;
  const items = [];
  for (const m of r.matched) {
    const i = srcItems.find(x => x.id === m.item.id) || {};
    items.push({
      itemNo: i.item_no, materialId: i.material_id, materialCode: i.material_code, shortText: i.short_text,
      vendorMaterial: i.vendor_material, materialType: i.material_type, materialGroup: i.material_group,
      orderQty: i.order_qty, orderUnit: i.order_unit, netPrice: i.net_price, currency: i.currency,
      qtySku: i.qty_sku, skuUnit: i.sku_unit, leadTimeDays: i.lead_time_days, poHistory: i.po_history_release,
      docCategory: i.doc_category, orderPriceUnit: i.order_price_unit, priceUnit: i.price_unit,
      stillQty: i.still_to_invoice_qty, stillVal: i.still_to_invoice_val, itemCategory: i.item_category,
      acctAssignment: i.acct_assignment_cat, sourceRow: i.source_row,
      raw: i.raw_data ? safeJson(i.raw_data) : null, ackQty: m.line.qty
    });
  }
  const id = await createPo(tx, {
    sectionId,
    userId: user.id,
    source: "OCR_ACK",
    batchId,
    po: {
      poNo: src.po_no,
      supplierId: src.supplier_id,
      supplierCode: src.supplier_code,
      supplierName: src.supplier_name,
      documentDate: toIso(src.document_date),
      docType: src.doc_type,
      plant: src.plant,
      shipMode: src.ship_mode,
      currency: src.currency,
      remark: src.remark,
      leadTimeDays: src.lead_time_days,
      leadTimeSource: src.lead_time_source,
      deliveryDate: toIso(src.delivery_date),
      splitNo,
      splitFromId: src.id,
      splitFromPoNo: `${src.po_no}${src.ack_no ? ` (ACK ${src.ack_no})` : ""}`,
      ackNo: r.docNo,
      ackEtdText: r.etdText || null
    },
    items
  }, ctx);
  const due = toIso((await tx.query(
    "SELECT due_date FROM po_steps WHERE po_id = @id AND step_no = @stepNo", { id, stepNo }
  )).recordset[0]?.due_date);
  await tx.query(
    `UPDATE po_steps SET actual_date = @date, done_by = @userId, done_at = DATEADD(HOUR, 7, SYSUTCDATETIME()),
       reference_no = @docNo, remark = @remark
     WHERE po_id = @id AND step_no = @stepNo`,
    { id, stepNo, date, userId: user.id, docNo: r.docNo, remark }
  );
  await tx.query("UPDATE purchase_orders SET current_step = @next WHERE id = @id", { id, next: stepNo + 1 });
  await recomputePo(tx, id, ctx);
  await addHistory(tx, id, "STEP_DONE", {
    stepNo,
    actorId: user.id,
    detail: {
      stepName: step?.name, actualDate: date, dueDate: due, lateDays: due ? diffDays(due, date) : null,
      referenceNo: r.docNo, remark, source: "OCR_ACK", batchId
    }
  });
  await addHistory(tx, src.id, "SPLIT_CREATED", {
    actorId: user.id,
    detail: { ackNo: r.docNo, splitNo, newId: id, lines: items.map(i => `${i.itemNo ?? "-"} × ${fmtQty(i.ackQty)}`) }
  });
  return id;
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

module.exports = { analyzeAck, analyzeSi, commit, groupLines, itemKey, preview, readOcr };
