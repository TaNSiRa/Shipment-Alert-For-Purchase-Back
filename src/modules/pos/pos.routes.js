const express = require("express");
const { z } = require("zod");
const { query, withTransaction } = require("../../db/pool");
const { getHolidayDates } = require("../../db/holidayPool");
const { asyncHandler } = require("../../middleware/asyncHandler");
const { writeAudit } = require("../../middleware/audit");
const { requireEditor, requireSectionAdmin, resolveSection } = require("../../services/sectionService");
const {
  PO_COLUMNS, PO_FROM, advancePo, cancelPo, createPo, deletePo, getPoDetail, listPos, loadContext,
  reopenPo, serializePo, undoLastStep, updatePo
} = require("../../services/poService");
const poImport = require("../../services/poImport");
const { poListBuffer } = require("../../services/reportService");
const { emitSection } = require("../../services/realtimeService");
const { endOfMonth, isIsoDate, todayIso } = require("../../services/dates");
const { normalizeMaterialCode } = require("../../services/excelKit");
const { STEP_COUNT } = require("../../services/workflowService");

const router = express.Router();
router.use(resolveSection);

const isoDate = z.string().refine(isIsoDate, "Must be a date (YYYY-MM-DD)");

function audit(req, action, entityId, afterValue) {
  return writeAudit({
    actorId: req.user.id, sectionId: req.section.id, action, entityType: "PO", entityId: entityId ? `${entityId}` : null,
    afterValue, ip: req.ip, userAgent: req.headers["user-agent"]
  });
}

function changed(req, ids = []) {
  emitSection(req.section.code, "po.updated", { ids });
}

function sendXlsx(res, buffer, fileName) {
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
  res.send(Buffer.from(buffer));
}

router.get("/", asyncHandler(async (req, res) => {
  const ctx = await loadContext(req.section.id);
  res.json(await listPos(req.section.id, req.query, ctx));
}));

router.get("/export", asyncHandler(async (req, res) => {
  const ctx = await loadContext(req.section.id);
  const { data } = await listPos(req.section.id, { ...req.query, page: 1, pageSize: 500 }, ctx);
  sendXlsx(res, await poListBuffer(data, req.section.name), `purchase-shipments-${todayIso()}.xlsx`);
}));

router.get("/import/template", asyncHandler(async (req, res) => {
  sendXlsx(res, await poImport.templateBuffer(), "po-import-template.xlsx");
}));

// Every Excel upload, newest first. The file itself is kept and downloadable.
router.get("/import/batches", asyncHandler(async (req, res) => {
  const pageSize = Math.min(Math.max(Number(req.query.pageSize) || 50, 1), 200);
  const page = Math.max(Number(req.query.page) || 1, 1);
  const params = { sectionId: req.section.id, offset: (page - 1) * pageSize, pageSize };
  const total = (await query("SELECT COUNT(1) AS n FROM import_batches WHERE section_id = @sectionId", params)).recordset[0].n;
  const rows = (await query(
    `SELECT b.id, b.file_name, b.sheet_name, b.total_rows, b.po_created, b.po_updated, b.po_skipped, b.items_created,
            b.created_at, u.display_name, CAST(CASE WHEN b.file_data IS NULL THEN 0 ELSE 1 END AS BIT) AS has_file,
            DATALENGTH(b.file_data) AS file_size
     FROM import_batches b LEFT JOIN users u ON u.id = b.uploaded_by
     WHERE b.section_id = @sectionId ORDER BY b.id DESC OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY`,
    params
  )).recordset;
  res.json({ total, page, pageSize, data: rows.map(r => ({
    id: r.id, fileName: r.file_name, sheetName: r.sheet_name, totalRows: r.total_rows, created: r.po_created,
    updated: r.po_updated || 0, skipped: r.po_skipped, items: r.items_created, uploadedBy: r.display_name,
    createdAt: r.created_at ? new Date(r.created_at).toISOString().slice(0, 19) : null,
    hasFile: r.has_file === true || r.has_file === 1, fileSize: r.file_size
  })) });
}));

router.get("/import/batches/:id(\\d+)/file", asyncHandler(async (req, res) => {
  const row = (await query(
    "SELECT file_name, file_data FROM import_batches WHERE id = @id AND section_id = @sectionId",
    { id: Number(req.params.id), sectionId: req.section.id }
  )).recordset[0];
  if (!row || !row.file_data) return res.status(404).json({ message: "File not found" });
  const safeName = `${row.file_name || "import.xlsx"}`.replace(/[^\w.\- ]+/g, "_");
  sendXlsx(res, row.file_data, safeName);
}));

// Month calendar: every open step due, and every step done, inside the month.
router.get("/calendar", asyncHandler(async (req, res) => {
  const month = /^\d{4}-\d{2}$/.test(`${req.query.month || ""}`) ? req.query.month : todayIso().slice(0, 7);
  const start = `${month}-01`;
  const end = endOfMonth(start);
  const ctx = await loadContext(req.section.id);
  const rows = (await query(
    `SELECT ps.step_no, ps.due_date, ps.actual_date, p.id, p.po_no, p.status, p.current_step,
            p.supplier_name, s.short_name AS supplier_short, p.eta_date
     FROM po_steps ps
     JOIN purchase_orders p ON p.id = ps.po_id
     LEFT JOIN suppliers s ON s.id = p.supplier_id
     WHERE p.section_id = @sectionId AND p.status <> 'CANCELLED' AND ps.step_no >= 2
       AND ((ps.actual_date IS NULL AND p.status = 'ACTIVE' AND ps.step_no = p.current_step AND ps.due_date BETWEEN @start AND @end)
         OR (ps.actual_date BETWEEN @start AND @end))`,
    { sectionId: req.section.id, start, end }
  )).recordset;
  const arrival = ctx.steps.find(s => s.isArrival)?.stepNo ?? 9;
  const etaRows = (await query(
    `SELECT p.id, p.po_no, p.eta_date, p.current_step, p.supplier_name, s.short_name AS supplier_short
     FROM purchase_orders p LEFT JOIN suppliers s ON s.id = p.supplier_id
     WHERE p.section_id = @sectionId AND p.status = 'ACTIVE' AND p.current_step <= @arrival
       AND p.eta_date BETWEEN @start AND @end`,
    { sectionId: req.section.id, start, end, arrival }
  )).recordset;
  const today = todayIso();
  const toIso = d => (d ? new Date(d).toISOString().slice(0, 10) : null);
  const events = rows.map(r => {
    const step = ctx.steps.find(s => s.stepNo === r.step_no);
    const done = Boolean(r.actual_date);
    const date = toIso(done ? r.actual_date : r.due_date);
    return {
      date,
      kind: done ? "done" : date < today ? "overdue" : "due",
      poId: r.id,
      poNo: r.po_no,
      supplier: r.supplier_short || r.supplier_name,
      stepNo: r.step_no,
      stepName: step?.name,
      stepShort: step?.shortName
    };
  });
  for (const r of etaRows) {
    events.push({
      date: toIso(r.eta_date), kind: "eta", poId: r.id, poNo: r.po_no, supplier: r.supplier_short || r.supplier_name,
      stepNo: arrival, stepName: "Expected at factory", stepShort: "ETA"
    });
  }
  events.sort((a, b) => a.date.localeCompare(b.date) || a.poNo.localeCompare(b.poNo));
  // Company holidays (external holiday DB + Settings › Holidays), so the
  // calendar greys them out like weekends. The external DB has dates only.
  const named = new Map((await query(
    "SELECT holiday_date, name FROM holidays WHERE holiday_date BETWEEN @start AND @end",
    { start, end }
  )).recordset.map(r => [toIso(r.holiday_date), r.name]));
  const external = await getHolidayDates(start, end);
  const holidays = [...new Set([...named.keys(), ...external.dates])].sort()
    .map(date => ({ date, name: named.get(date) || null }));
  res.json({ month, start, end, events, holidays });
}));

// Road map: every active PO with all ten step dates, for the progress board.
router.get("/roadmap", asyncHandler(async (req, res) => {
  const ctx = await loadContext(req.section.id);
  const status = ["ACTIVE", "COMPLETED"].includes(`${req.query.status}`.toUpperCase()) ? `${req.query.status}`.toUpperCase() : "ACTIVE";
  const params = { sectionId: req.section.id, status };
  let extra = "";
  if (req.query.q) {
    params.q = `%${`${req.query.q}`.trim().replace(/[%_[]/g, ch => `[${ch}]`)}%`;
    extra = " AND (p.po_no LIKE @q OR p.supplier_name LIKE @q OR s.short_name LIKE @q OR p.shipment_ref LIKE @q)";
  }
  if (status === "COMPLETED") extra += " AND p.completed_at >= DATEADD(DAY, -90, DATEADD(HOUR, 7, SYSUTCDATETIME()))";
  const rows = (await query(
    `SELECT TOP 400 ${PO_COLUMNS} ${PO_FROM} WHERE p.section_id = @sectionId AND p.status = @status ${extra}
     ORDER BY p.eta_date, p.po_no`,
    params
  )).recordset;
  const ids = rows.map(r => r.id);
  const steps = ids.length
    ? (await query(
      `SELECT po_id, step_no, planned_date, due_date, actual_date FROM po_steps
       WHERE po_id IN (SELECT value FROM STRING_SPLIT(@ids, ','))`,
      { ids: ids.join(",") }
    )).recordset
    : [];
  const byPo = new Map();
  const toIso = d => (d ? new Date(d).toISOString().slice(0, 10) : null);
  for (const s of steps) {
    if (!byPo.has(s.po_id)) byPo.set(s.po_id, []);
    byPo.get(s.po_id).push({ stepNo: s.step_no, planned: toIso(s.planned_date), due: toIso(s.due_date), actual: toIso(s.actual_date) });
  }
  const today = todayIso();
  res.json({
    steps: ctx.steps,
    data: rows.map(r => ({
      ...serializePo(r, ctx.steps, today, ctx.settings["alert.dueSoonDays"]),
      steps: (byPo.get(r.id) || []).sort((a, b) => a.stepNo - b.stepNo)
    }))
  });
}));

router.get("/:id(\\d+)", asyncHandler(async (req, res) => {
  const ctx = await loadContext(req.section.id);
  const po = await getPoDetail(Number(req.params.id), req.section.id, ctx);
  // Which SAP columns of each line are PO-wide (read-only in the line editor).
  for (const item of po.items) item.rawLocked = poImport.lockedHeaders(item.raw);
  res.json({ data: po });
}));

// ---- Writes ----------------------------------------------------------------

const itemSchema = z.object({
  itemNo: z.string().trim().max(10).optional().nullable(),
  materialId: z.number().int().positive().optional().nullable(),
  materialCode: z.string().trim().max(40).optional().nullable(),
  shortText: z.string().trim().max(255).optional().nullable(),
  orderQty: z.number().nonnegative().optional().nullable(),
  orderUnit: z.string().trim().max(20).optional().nullable(),
  netPrice: z.number().nonnegative().optional().nullable(),
  currency: z.string().trim().max(10).optional().nullable()
});

const createSchema = z.object({
  poNo: z.string().trim().min(1).max(30).regex(/^[A-Za-z0-9._/-]+$/, "PO No. may only contain letters, digits and . _ / -"),
  supplierId: z.number().int().positive(),
  documentDate: isoDate,
  shipMode: z.enum(["SEA", "AIR", "TRUCK", "COURIER"]).optional().nullable(),
  remark: z.string().trim().max(1000).optional().nullable(),
  leadTimeDays: z.number().int().min(1).max(365).optional().nullable(),
  items: z.array(itemSchema).min(1, "Add at least one material line").max(200)
});

// Manual entry — the same single input as the Excel import, typed by hand.
router.post("/", requireEditor, asyncHandler(async (req, res) => {
  const input = createSchema.parse(req.body);
  if (input.documentDate > todayIso()) return res.status(400).json({ message: "PO date cannot be in the future" });
  const ctx = await loadContext(req.section.id);
  const supplier = (await query(
    "SELECT * FROM suppliers WHERE id = @id AND section_id = @sectionId",
    { id: input.supplierId, sectionId: req.section.id }
  )).recordset[0];
  if (!supplier) return res.status(400).json({ message: "Supplier not found" });
  const exists = (await query(
    "SELECT status FROM purchase_orders WHERE section_id = @sectionId AND po_no = @poNo",
    { sectionId: req.section.id, poNo: input.poNo }
  )).recordset[0];
  if (exists) return res.status(409).json({ message: `PO ${input.poNo} already exists` });

  // Only this supplier's materials (plus any not tied to a supplier): the same
  // code can sit under two suppliers with different lead times (13000150 is
  // NIHON H/O at 76 days and NEWFLUO at 60), so another supplier's row would
  // plan the PO on the wrong lead time.
  const materials = (await query(
    `SELECT * FROM materials WHERE section_id = @sectionId AND is_active = 1
       AND (supplier_id = @supplierId OR supplier_id IS NULL)`,
    { sectionId: req.section.id, supplierId: supplier.id }
  )).recordset;
  const wrong = input.items.find(it => it.materialId && !materials.some(x => x.id === it.materialId));
  if (wrong) {
    return res.status(400).json({ message: `Material on item ${wrong.itemNo || "?"} is not in ${supplier.name}'s master` });
  }
  const items = input.items.map((it, i) => {
    const code = normalizeMaterialCode(it.materialCode);
    const m = it.materialId
      ? materials.find(x => x.id === it.materialId)
      : materials.filter(x => x.material_code && code && x.material_code.toUpperCase() === code)
        .sort((a, b) => (a.supplier_id === supplier.id ? -1 : 1) - (b.supplier_id === supplier.id ? -1 : 1))[0];
    return {
      itemNo: it.itemNo || `${(i + 1) * 10}`,
      materialId: m?.id || null,
      materialCode: m?.material_code || code || null,
      shortText: it.shortText || m?.description || null,
      vendorMaterial: m?.vendor_material || null,
      materialType: m?.material_type || null,
      orderQty: it.orderQty ?? null,
      orderUnit: it.orderUnit || null,
      netPrice: it.netPrice ?? null,
      currency: it.currency || null,
      leadTimeDays: m?.lead_time_days || null
    };
  });
  const id = await withTransaction(tx => createPo(tx, {
    sectionId: req.section.id,
    userId: req.user.id,
    source: "MANUAL",
    po: {
      poNo: input.poNo,
      supplierId: supplier.id,
      supplier,
      supplierCode: supplier.supplier_code,
      supplierName: supplier.name,
      documentDate: input.documentDate,
      shipMode: input.shipMode || null,
      remark: input.remark || null,
      leadTimeDays: input.leadTimeDays || null,
      leadTimeSource: input.leadTimeDays ? "MANUAL" : null,
      currency: items.find(i => i.currency)?.currency || null
    },
    items
  }, ctx));
  await audit(req, "CREATE", id, { poNo: input.poNo, items: items.length });
  changed(req, [id]);
  res.status(201).json({ id });
}));

router.post("/import/preview", requireEditor, asyncHandler(async (req, res) => {
  const ctx = await loadContext(req.section.id);
  res.json(await poImport.preview(req.section.id, req.body?.data, ctx));
}));

router.post("/import/commit", requireEditor, asyncHandler(async (req, res) => {
  const input = z.object({
    fileName: z.string().max(255).optional().nullable(),
    data: z.string().min(1),
    poNos: z.array(z.string().max(30)).max(5000).optional()
  }).parse(req.body);
  const ctx = await loadContext(req.section.id);
  const result = await poImport.commit(req.section.id, input, req.user, ctx);
  await audit(req, "IMPORT", result.batchId, {
    fileName: input.fileName, created: result.created.length, updated: result.updated.length,
    skipped: result.skipped, suppliersAdded: result.suppliersAdded
  });
  changed(req, [...result.created, ...result.updated].map(c => c.id));
  res.json(result);
}));

const advanceSchema = z.object({
  expectedStep: z.number().int().min(2).max(STEP_COUNT).optional(),
  actualDate: isoDate.optional(),
  referenceNo: z.string().max(80).optional().nullable(),
  remark: z.string().max(500).optional().nullable()
});

router.post("/:id(\\d+)/advance", requireEditor, asyncHandler(async (req, res) => {
  const input = advanceSchema.parse(req.body);
  const ctx = await loadContext(req.section.id);
  const result = await advancePo(Number(req.params.id), req.section.id, input, req.user, ctx);
  await audit(req, "STEP_DONE", req.params.id, { ...input, stepNo: result.stepNo });
  changed(req, [result.id]);
  res.json(result);
}));

// Several POs at the same step closed together (e.g. one shipping instruction
// covering five POs). Each PO is its own transaction: one stale or finished PO
// is reported, it does not roll back the others.
router.post("/bulk-advance", requireEditor, asyncHandler(async (req, res) => {
  const input = advanceSchema.extend({
    ids: z.array(z.number().int().positive()).min(1).max(200),
    expectedStep: z.number().int().min(2).max(STEP_COUNT)
  }).parse(req.body);
  const ctx = await loadContext(req.section.id);
  const results = [];
  for (const id of input.ids) {
    try {
      results.push({ id, ok: true, ...(await advancePo(id, req.section.id, input, req.user, ctx)) });
    } catch (err) {
      if (!err.status || err.status >= 500) throw err;
      results.push({ id, ok: false, message: err.message });
    }
  }
  const okIds = results.filter(r => r.ok).map(r => r.id);
  await audit(req, "BULK_STEP_DONE", okIds.join(",").slice(0, 120), { ...input, done: okIds.length });
  changed(req, okIds);
  res.json({ done: okIds.length, failed: results.filter(r => !r.ok).length, results });
}));

router.post("/:id(\\d+)/undo", requireEditor, asyncHandler(async (req, res) => {
  const ctx = await loadContext(req.section.id);
  const result = await undoLastStep(Number(req.params.id), req.section.id, req.user, req.sectionAccess, ctx);
  await audit(req, "STEP_UNDONE", req.params.id, result);
  changed(req, [result.id]);
  res.json(result);
}));

router.post("/:id(\\d+)/cancel", requireEditor, asyncHandler(async (req, res) => {
  const { reason } = z.object({ reason: z.string().trim().min(3, "Please give a reason").max(500) }).parse(req.body);
  const po = (await query("SELECT created_by FROM purchase_orders WHERE id = @id AND section_id = @sectionId", { id: Number(req.params.id), sectionId: req.section.id })).recordset[0];
  if (!po) return res.status(404).json({ message: "PO not found" });
  if (!req.sectionAccess.isSectionAdmin && Number(po.created_by) !== Number(req.user.id)) {
    return res.status(403).json({ message: "Only the person who added this PO, or a section admin, can cancel it" });
  }
  const result = await cancelPo(Number(req.params.id), req.section.id, reason, req.user);
  await audit(req, "CANCEL", req.params.id, { reason });
  changed(req, [result.id]);
  res.json(result);
}));

router.post("/:id(\\d+)/reopen", requireSectionAdmin, asyncHandler(async (req, res) => {
  const ctx = await loadContext(req.section.id);
  const result = await reopenPo(Number(req.params.id), req.section.id, req.user, ctx);
  await audit(req, "REOPEN", req.params.id);
  changed(req, [result.id]);
  res.json(result);
}));

router.patch("/:id(\\d+)", requireEditor, asyncHandler(async (req, res) => {
  const input = z.object({
    remark: z.string().max(1000).optional().nullable(),
    shipMode: z.enum(["SEA", "AIR", "TRUCK", "COURIER", ""]).optional().nullable(),
    shipmentRef: z.string().max(80).optional().nullable(),
    documentDate: isoDate.optional(),
    leadTimeDays: z.number().int().min(1).max(365).optional().nullable()
  }).parse(req.body);
  // Changing the plan itself (PO date / lead time) is a section-admin call.
  if ((input.documentDate !== undefined || input.leadTimeDays !== undefined) && !req.sectionAccess.isSectionAdmin) {
    return res.status(403).json({ message: "Only a section admin can change the PO date or lead time" });
  }
  const ctx = await loadContext(req.section.id);
  const result = await updatePo(Number(req.params.id), req.section.id, input, req.user, ctx);
  if (result.changed) {
    await audit(req, "EDIT", req.params.id, input);
    changed(req, [result.id]);
  }
  res.json(result);
}));

// One line's SAP columns edited by hand (the "all columns" view).
router.patch("/:id(\\d+)/items/:itemId(\\d+)", requireEditor, asyncHandler(async (req, res) => {
  const { values } = z.object({
    values: z.record(z.string().max(100), z.union([z.string().max(255), z.number()]).nullable())
  }).parse(req.body);
  const ctx = await loadContext(req.section.id);
  const result = await poImport.updateItem(
    Number(req.params.id), Number(req.params.itemId), req.section.id, values, req.user, ctx
  );
  if (result.changed) {
    await audit(req, "EDIT_ITEM", req.params.id, { itemId: result.itemId, values });
    changed(req, [result.id]);
  }
  res.json(result);
}));

router.delete("/:id(\\d+)", requireSectionAdmin, asyncHandler(async (req, res) => {
  const result = await deletePo(Number(req.params.id), req.section.id);
  await audit(req, "DELETE", req.params.id, result);
  changed(req, [result.id]);
  res.json(result);
}));

module.exports = router;
