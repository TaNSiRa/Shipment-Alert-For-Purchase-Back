const { query, withTransaction } = require("../db/pool");
const { diffDays, isIsoDate, todayIso } = require("./dates");
const { DONE_STEP, FIRST_OPEN_STEP, STEP_COUNT, arrivalStepNo, computeSchedule, getWorkflow } = require("./workflowService");
const { getHolidaySet, getSectionSettings, scheduleSettings } = require("./settingsService");
const { bool, num, toIso, wallTime } = require("./serialize");

function httpError(status, message, extra = {}) {
  return Object.assign(new Error(message), { status, ...extra });
}

// Everything the schedule maths needs for one section, loaded once per action.
async function loadContext(sectionId) {
  const [steps, settings, holidays] = await Promise.all([
    getWorkflow(sectionId),
    getSectionSettings(sectionId),
    getHolidaySet()
  ]);
  return { steps, settings, sched: scheduleSettings(settings), holidays };
}

// A PO's lead time is its slowest line — the shipment cannot arrive before
// its last item does. Falls back to the section's default.
function resolveLeadTime(items, sched) {
  const fromItems = items.map(i => Number(i.leadTimeDays)).filter(n => Number.isFinite(n) && n > 0);
  if (fromItems.length) return { days: Math.max(...fromItems), source: "MATERIAL" };
  return { days: sched.defaultLeadTimeDays, source: "DEFAULT" };
}

async function addHistory(runner, poId, action, { stepNo = null, detail = null, actorId = null } = {}) {
  await runner.query(
    `INSERT INTO po_history (po_id, action, step_no, detail, actor_user_id)
     VALUES (@poId, @action, @stepNo, @detail, @actorId)`,
    { poId, action, stepNo, detail: detail ? JSON.stringify(detail) : null, actorId }
  );
}

// Creates one PO with its lines and its ten step rows. `runner` is a
// transaction from withTransaction (imports create many POs in one).
//   po: { poNo, supplierId, supplierCode, supplierName, documentDate, docType,
//         plant, shipMode, currency, remark, leadTimeDays?, leadTimeSource? }
//   items: [{ itemNo, materialId, materialCode, shortText, vendorMaterial,
//            materialType, materialGroup, orderQty, orderUnit, netPrice,
//            currency, qtySku, skuUnit, leadTimeDays }]
async function createPo(runner, { sectionId, po, items, userId, source, batchId = null }, ctx) {
  // Lines SAP marks deleted are stored for the record but count for nothing.
  const live = items.filter(i => !i.deletionIndicator);
  const totalValue = live.reduce((sum, i) => {
    const qty = Number(i.orderQty);
    const price = Number(i.netPrice);
    return Number.isFinite(qty) && Number.isFinite(price) ? sum + qty * price : sum;
  }, 0);
  const lead = po.leadTimeDays
    ? { days: po.leadTimeDays, source: po.leadTimeSource || "MANUAL" }
    : resolveLeadTime(live, ctx.sched);
  const due = computeSchedule({
    steps: ctx.steps,
    documentDate: po.documentDate,
    leadTimeDays: lead.days,
    actuals: { 1: po.documentDate },
    settings: ctx.sched,
    holidays: ctx.holidays
  });
  const arrival = arrivalStepNo(ctx.steps);

  const inserted = (await runner.query(
    `INSERT INTO purchase_orders (section_id, po_no, supplier_id, supplier_code, supplier_name, document_date,
       doc_type, plant, ship_mode, currency, total_value, lead_time_days, lead_time_source, current_step, status,
       next_due_date, eta_date, remark, source, import_batch_id, created_by)
     OUTPUT INSERTED.id
     VALUES (@sectionId, @poNo, @supplierId, @supplierCode, @supplierName, @documentDate,
       @docType, @plant, @shipMode, @currency, @totalValue, @leadDays, @leadSource, @currentStep, 'ACTIVE',
       @nextDue, @eta, @remark, @source, @batchId, @userId)`,
    {
      sectionId,
      poNo: po.poNo,
      supplierId: po.supplierId || null,
      supplierCode: po.supplierCode || null,
      supplierName: po.supplierName || null,
      documentDate: po.documentDate,
      docType: po.docType || null,
      plant: po.plant || null,
      shipMode: po.shipMode || null,
      currency: po.currency || items.find(i => i.currency)?.currency || null,
      totalValue: totalValue || null,
      leadDays: lead.days,
      leadSource: lead.source,
      currentStep: FIRST_OPEN_STEP,
      nextDue: due[FIRST_OPEN_STEP],
      eta: due[arrival],
      remark: po.remark || null,
      source,
      batchId,
      userId
    }
  )).recordset[0];
  const poId = inserted.id;

  for (const item of items) {
    await runner.query(
      `INSERT INTO po_items (po_id, item_no, material_id, material_code, short_text, vendor_material, material_type,
         material_group, order_qty, order_unit, net_price, currency, qty_sku, sku_unit, lead_time_days,
         po_history_release, doc_category, order_price_unit, price_unit, still_to_invoice_qty, still_to_invoice_val,
         deletion_indicator, item_category, acct_assignment_cat, source_row, raw_data)
       VALUES (@poId, @itemNo, @materialId, @materialCode, @shortText, @vendorMaterial, @materialType,
         @materialGroup, @orderQty, @orderUnit, @netPrice, @currency, @qtySku, @skuUnit, @leadTimeDays,
         @poHistory, @docCategory, @orderPriceUnit, @priceUnit, @stillQty, @stillVal,
         @deletionIndicator, @itemCategory, @acctAssignment, @sourceRow, @raw)`,
      {
        poId,
        itemNo: item.itemNo || null,
        materialId: item.materialId || null,
        materialCode: item.materialCode || null,
        shortText: item.shortText || null,
        vendorMaterial: item.vendorMaterial || null,
        materialType: item.materialType || null,
        materialGroup: item.materialGroup || null,
        orderQty: num(item.orderQty),
        orderUnit: item.orderUnit || null,
        netPrice: num(item.netPrice),
        currency: item.currency || null,
        qtySku: num(item.qtySku),
        skuUnit: item.skuUnit || null,
        leadTimeDays: num(item.leadTimeDays),
        poHistory: item.poHistory || null,
        docCategory: item.docCategory || null,
        orderPriceUnit: item.orderPriceUnit || null,
        priceUnit: num(item.priceUnit),
        stillQty: num(item.stillQty),
        stillVal: num(item.stillVal),
        deletionIndicator: item.deletionIndicator || null,
        itemCategory: item.itemCategory || null,
        acctAssignment: item.acctAssignment || null,
        sourceRow: num(item.sourceRow),
        raw: item.raw ? JSON.stringify(item.raw) : null
      }
    );
  }

  for (let n = 1; n <= STEP_COUNT; n += 1) {
    await runner.query(
      `INSERT INTO po_steps (po_id, step_no, planned_date, due_date, actual_date, done_by, done_at)
       VALUES (@poId, @n, @due, @due, @actual, @doneBy,
         CASE WHEN @n = 1 THEN DATEADD(HOUR, 7, SYSUTCDATETIME()) ELSE NULL END)`,
      {
        poId,
        n,
        due: due[n],
        actual: n === 1 ? po.documentDate : null,
        doneBy: n === 1 ? userId : null
      }
    );
  }
  await addHistory(runner, poId, "CREATED", {
    stepNo: 1,
    actorId: userId,
    detail: { source, items: live.length, leadTimeDays: lead.days, leadTimeSource: lead.source, documentDate: po.documentDate }
  });
  return poId;
}

// Re-derives every OPEN step's due date from the actual dates recorded so far
// and refreshes the PO's denormalised next-due / ETA. Done steps keep the due
// date they had when they were closed — that is what "late by N days" is
// measured against. rebaseline also rewrites the frozen plan (used when the
// PO date or lead time itself is edited).
async function recomputePo(runner, poId, ctx, { rebaseline = false } = {}) {
  const po = (await runner.query(
    "SELECT id, document_date, lead_time_days, current_step, status FROM purchase_orders WHERE id = @poId",
    { poId }
  )).recordset[0];
  if (!po) return;
  const stepRows = (await runner.query(
    "SELECT step_no, actual_date FROM po_steps WHERE po_id = @poId",
    { poId }
  )).recordset;
  const actuals = {};
  for (const r of stepRows) if (r.actual_date) actuals[r.step_no] = toIso(r.actual_date);
  const documentDate = toIso(po.document_date);
  const due = computeSchedule({
    steps: ctx.steps,
    documentDate,
    leadTimeDays: po.lead_time_days,
    actuals,
    settings: ctx.sched,
    holidays: ctx.holidays
  });
  const plan = rebaseline
    ? computeSchedule({
      steps: ctx.steps,
      documentDate,
      leadTimeDays: po.lead_time_days,
      actuals: { 1: documentDate },
      settings: ctx.sched,
      holidays: ctx.holidays
    })
    : null;
  for (const r of stepRows) {
    const open = !r.actual_date;
    if (!open && !rebaseline) continue;
    if (rebaseline) {
      await runner.query(
        `UPDATE po_steps SET planned_date = @planned ${open ? ", due_date = @due" : ""}
         WHERE po_id = @poId AND step_no = @n`,
        { poId, n: r.step_no, planned: plan[r.step_no], due: due[r.step_no] }
      );
    } else {
      await runner.query("UPDATE po_steps SET due_date = @due WHERE po_id = @poId AND step_no = @n", {
        poId, n: r.step_no, due: due[r.step_no]
      });
    }
  }
  const arrival = arrivalStepNo(ctx.steps);
  const nextDue = po.current_step <= STEP_COUNT && po.status === "ACTIVE" ? due[po.current_step] : null;
  await runner.query(
    "UPDATE purchase_orders SET next_due_date = @nextDue, eta_date = @eta WHERE id = @poId",
    { poId, nextDue, eta: actuals[arrival] || due[arrival] }
  );
}

async function lockPo(runner, poId, sectionId) {
  const po = (await runner.query(
    `SELECT * FROM purchase_orders WITH (UPDLOCK, ROWLOCK)
     WHERE id = @poId AND section_id = @sectionId`,
    { poId, sectionId }
  )).recordset[0];
  if (!po) throw httpError(404, "PO not found");
  return po;
}

function cleanText(value, max) {
  const text = `${value ?? ""}`.trim();
  return text ? text.slice(0, max) : null;
}

// Marks the PO's current step done. expectedStep makes a double click, two
// people on the same PO, or a stale bulk selection fail loudly (409) instead
// of silently closing the NEXT step.
async function advancePo(poId, sectionId, input, user, ctx) {
  const actualDate = input.actualDate || todayIso();
  if (!isIsoDate(actualDate)) throw httpError(400, "Actual date must be a valid date");
  if (actualDate > todayIso()) throw httpError(400, "The actual date cannot be in the future");

  return withTransaction(async tx => {
    const po = await lockPo(tx, poId, sectionId);
    if (po.status === "CANCELLED") throw httpError(400, `PO ${po.po_no} is cancelled`);
    if (po.status === "COMPLETED" || po.current_step > STEP_COUNT) throw httpError(400, `PO ${po.po_no} is already complete`);
    if (input.expectedStep && Number(input.expectedStep) !== po.current_step) {
      throw httpError(409, `PO ${po.po_no} has already moved on (it is now at step ${po.current_step}). Refresh and try again.`);
    }
    const stepNo = po.current_step;
    const prev = (await tx.query(
      "SELECT actual_date FROM po_steps WHERE po_id = @poId AND step_no = @n",
      { poId, n: stepNo - 1 }
    )).recordset[0];
    const prevActual = toIso(prev?.actual_date);
    if (prevActual && actualDate < prevActual) {
      throw httpError(400, `The actual date cannot be before the previous step (${prevActual})`);
    }
    const stepRow = (await tx.query(
      "SELECT due_date FROM po_steps WHERE po_id = @poId AND step_no = @n",
      { poId, n: stepNo }
    )).recordset[0];
    const dueDate = toIso(stepRow?.due_date);
    const referenceNo = cleanText(input.referenceNo, 80);
    const remark = cleanText(input.remark, 500);

    await tx.query(
      `UPDATE po_steps SET actual_date = @actualDate, done_by = @userId,
         done_at = DATEADD(HOUR, 7, SYSUTCDATETIME()), reference_no = @referenceNo, remark = @remark
       WHERE po_id = @poId AND step_no = @n`,
      { poId, n: stepNo, actualDate, userId: user.id, referenceNo, remark }
    );
    const next = stepNo + 1;
    const step = ctx.steps.find(s => s.stepNo === stepNo);
    const setShipmentRef = step?.code === "SI" && referenceNo;
    await tx.query(
      `UPDATE purchase_orders SET current_step = @next,
         status = CASE WHEN @next > @stepCount THEN 'COMPLETED' ELSE status END,
         completed_at = CASE WHEN @next > @stepCount THEN DATEADD(HOUR, 7, SYSUTCDATETIME()) ELSE completed_at END,
         shipment_ref = CASE WHEN @setRef = 1 THEN @referenceNo ELSE shipment_ref END,
         updated_by = @userId, updated_at = DATEADD(HOUR, 7, SYSUTCDATETIME())
       WHERE id = @poId`,
      { poId, next, stepCount: STEP_COUNT, setRef: setShipmentRef ? 1 : 0, referenceNo, userId: user.id }
    );
    await recomputePo(tx, poId, ctx);
    const lateDays = dueDate ? diffDays(dueDate, actualDate) : null;
    await addHistory(tx, poId, "STEP_DONE", {
      stepNo,
      actorId: user.id,
      detail: { stepName: step?.name, actualDate, dueDate, lateDays, referenceNo, remark }
    });
    return { id: poId, poNo: po.po_no, stepNo, nextStep: next, completed: next > STEP_COUNT };
  });
}

// Reopens the most recently closed step. Allowed for a section admin, or for
// the person who closed it.
async function undoLastStep(poId, sectionId, user, access, ctx) {
  return withTransaction(async tx => {
    const po = await lockPo(tx, poId, sectionId);
    if (po.status === "CANCELLED") throw httpError(400, `PO ${po.po_no} is cancelled — reopen it first`);
    const last = po.current_step - 1;
    if (last < FIRST_OPEN_STEP) throw httpError(400, "There is no completed step to undo");
    const row = (await tx.query(
      "SELECT actual_date, done_by, reference_no FROM po_steps WHERE po_id = @poId AND step_no = @n",
      { poId, n: last }
    )).recordset[0];
    if (!access.isSectionAdmin && Number(row?.done_by) !== Number(user.id)) {
      throw httpError(403, "Only the person who completed this step, or a section admin, can undo it");
    }
    await tx.query(
      `UPDATE po_steps SET actual_date = NULL, done_by = NULL, done_at = NULL, reference_no = NULL, remark = NULL
       WHERE po_id = @poId AND step_no = @n`,
      { poId, n: last }
    );
    await tx.query(
      `UPDATE purchase_orders SET current_step = @last, status = 'ACTIVE', completed_at = NULL,
         updated_by = @userId, updated_at = DATEADD(HOUR, 7, SYSUTCDATETIME())
       WHERE id = @poId`,
      { poId, last, userId: user.id }
    );
    await recomputePo(tx, poId, ctx);
    const step = ctx.steps.find(s => s.stepNo === last);
    await addHistory(tx, poId, "STEP_UNDONE", {
      stepNo: last,
      actorId: user.id,
      detail: { stepName: step?.name, actualDate: toIso(row?.actual_date), referenceNo: row?.reference_no }
    });
    return { id: poId, poNo: po.po_no, stepNo: last };
  });
}

async function cancelPo(poId, sectionId, reason, user) {
  return withTransaction(async tx => {
    const po = await lockPo(tx, poId, sectionId);
    if (po.status === "CANCELLED") throw httpError(400, "PO is already cancelled");
    await tx.query(
      `UPDATE purchase_orders SET status = 'CANCELLED', cancelled_at = DATEADD(HOUR, 7, SYSUTCDATETIME()),
         cancelled_by = @userId, cancel_reason = @reason, next_due_date = NULL,
         updated_by = @userId, updated_at = DATEADD(HOUR, 7, SYSUTCDATETIME())
       WHERE id = @poId`,
      { poId, userId: user.id, reason }
    );
    await addHistory(tx, poId, "CANCELLED", { actorId: user.id, detail: { reason } });
    return { id: poId, poNo: po.po_no };
  });
}

async function reopenPo(poId, sectionId, user, ctx) {
  return withTransaction(async tx => {
    const po = await lockPo(tx, poId, sectionId);
    if (po.status !== "CANCELLED") throw httpError(400, "Only a cancelled PO can be reopened");
    await tx.query(
      `UPDATE purchase_orders SET status = CASE WHEN current_step > @stepCount THEN 'COMPLETED' ELSE 'ACTIVE' END,
         cancelled_at = NULL, cancelled_by = NULL, cancel_reason = NULL,
         updated_by = @userId, updated_at = DATEADD(HOUR, 7, SYSUTCDATETIME())
       WHERE id = @poId`,
      { poId, userId: user.id, stepCount: STEP_COUNT }
    );
    await recomputePo(tx, poId, ctx);
    await addHistory(tx, poId, "REOPENED", { actorId: user.id });
    return { id: poId, poNo: po.po_no };
  });
}

// Header edits. documentDate / leadTimeDays change the plan, so they rebaseline.
async function updatePo(poId, sectionId, input, user, ctx) {
  return withTransaction(async tx => {
    const po = await lockPo(tx, poId, sectionId);
    const changes = {};
    const sets = [];
    const params = { poId, userId: user.id };
    const text = (key, column, max) => {
      if (input[key] === undefined) return;
      const value = cleanText(input[key], max);
      if ((po[column] || null) === value) return;
      changes[key] = { from: po[column] || null, to: value };
      sets.push(`${column} = @${key}`);
      params[key] = value;
    };
    text("remark", "remark", 1000);
    text("shipMode", "ship_mode", 20);
    text("shipmentRef", "shipment_ref", 80);

    let replan = false;
    if (input.documentDate !== undefined) {
      if (!isIsoDate(input.documentDate)) throw httpError(400, "PO date must be a valid date");
      if (input.documentDate > todayIso()) throw httpError(400, "PO date cannot be in the future");
      const current = toIso(po.document_date);
      if (current !== input.documentDate) {
        const step2 = (await tx.query(
          "SELECT actual_date FROM po_steps WHERE po_id = @poId AND step_no = 2", { poId }
        )).recordset[0];
        const step2Actual = toIso(step2?.actual_date);
        if (step2Actual && input.documentDate > step2Actual) {
          throw httpError(400, `PO date cannot be after the acknowledgement date (${step2Actual})`);
        }
        changes.documentDate = { from: current, to: input.documentDate };
        sets.push("document_date = @documentDate");
        params.documentDate = input.documentDate;
        replan = true;
      }
    }
    if (input.leadTimeDays !== undefined && input.leadTimeDays !== null) {
      const days = Number(input.leadTimeDays);
      if (!Number.isInteger(days) || days < 1 || days > 365) throw httpError(400, "Lead time must be 1–365 days");
      if (days !== po.lead_time_days) {
        changes.leadTimeDays = { from: po.lead_time_days, to: days };
        sets.push("lead_time_days = @leadTimeDays", "lead_time_source = 'MANUAL'");
        params.leadTimeDays = days;
        replan = true;
      }
    }
    if (!sets.length) return { id: poId, poNo: po.po_no, changed: false };
    await tx.query(
      `UPDATE purchase_orders SET ${sets.join(", ")}, updated_by = @userId,
         updated_at = DATEADD(HOUR, 7, SYSUTCDATETIME()) WHERE id = @poId`,
      params
    );
    if (params.documentDate) {
      await tx.query("UPDATE po_steps SET actual_date = @documentDate WHERE po_id = @poId AND step_no = 1", params);
    }
    if (replan) await recomputePo(tx, poId, ctx, { rebaseline: true });
    await addHistory(tx, poId, "EDITED", { actorId: user.id, detail: changes });
    return { id: poId, poNo: po.po_no, changed: true };
  });
}

async function deletePo(poId, sectionId) {
  const po = (await query("SELECT id, po_no FROM purchase_orders WHERE id = @poId AND section_id = @sectionId", { poId, sectionId })).recordset[0];
  if (!po) throw httpError(404, "PO not found");
  await query("DELETE FROM purchase_orders WHERE id = @poId", { poId });
  return { id: poId, poNo: po.po_no };
}

// Re-run the schedule for every active PO of a section (after the workflow or
// a scheduling setting changes). Plans are rebaselined too, so on-time
// reporting is measured against the new rules from here on.
async function recomputeSection(sectionId) {
  const ctx = await loadContext(sectionId);
  const ids = (await query(
    "SELECT id FROM purchase_orders WHERE section_id = @sectionId AND status = 'ACTIVE'",
    { sectionId }
  )).recordset.map(r => r.id);
  for (const id of ids) {
    await withTransaction(tx => recomputePo(tx, id, ctx, { rebaseline: true }));
  }
  return ids.length;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

const PO_COLUMNS = `p.id, p.po_no, p.supplier_id, p.supplier_code, p.supplier_name, s.short_name AS supplier_short,
  p.document_date, p.doc_type, p.plant, p.ship_mode, p.currency, p.total_value, p.lead_time_days, p.lead_time_source,
  p.current_step, p.status, p.shipment_ref, p.next_due_date, p.eta_date, p.remark, p.source,
  p.created_at, p.updated_at, p.completed_at, p.cancelled_at, p.cancel_reason,
  cu.display_name AS created_by_name, uu.display_name AS updated_by_name,
  (SELECT COUNT(1) FROM po_items i WHERE i.po_id = p.id AND i.deletion_indicator IS NULL) AS item_count,
  (SELECT TOP 1 ps.planned_date FROM po_steps ps WHERE ps.po_id = p.id AND ps.step_no = p.current_step) AS current_planned`;

const PO_FROM = `FROM purchase_orders p
  LEFT JOIN suppliers s ON s.id = p.supplier_id
  LEFT JOIN users cu ON cu.id = p.created_by
  LEFT JOIN users uu ON uu.id = p.updated_by`;

function serializePo(row, steps, today = todayIso(), dueSoonDays = 3) {
  const nextDue = toIso(row.next_due_date);
  const step = steps.find(s => s.stepNo === row.current_step);
  const overdueDays = row.status === "ACTIVE" && nextDue && nextDue < today ? diffDays(nextDue, today) : 0;
  const daysLeft = row.status === "ACTIVE" && nextDue ? diffDays(today, nextDue) : null;
  return {
    id: row.id,
    poNo: row.po_no,
    supplierId: row.supplier_id,
    supplierCode: row.supplier_code,
    supplierName: row.supplier_name,
    supplierShort: row.supplier_short || null,
    documentDate: toIso(row.document_date),
    docType: row.doc_type,
    plant: row.plant,
    shipMode: row.ship_mode,
    currency: row.currency,
    totalValue: num(row.total_value),
    leadTimeDays: row.lead_time_days,
    leadTimeSource: row.lead_time_source,
    currentStep: row.current_step,
    currentStepName: step ? step.name : row.current_step > STEP_COUNT ? "Completed" : null,
    currentStepShort: step ? step.shortName : row.current_step > STEP_COUNT ? "Done" : null,
    status: row.status,
    shipmentRef: row.shipment_ref,
    nextDueDate: nextDue,
    currentPlannedDate: toIso(row.current_planned),
    etaDate: toIso(row.eta_date),
    overdueDays,
    daysLeft,
    dueState: row.status !== "ACTIVE" ? row.status.toLowerCase()
      : overdueDays > 0 ? "overdue"
      : daysLeft === 0 ? "today"
      : daysLeft !== null && daysLeft <= dueSoonDays ? "soon"
      : "ontrack",
    remark: row.remark,
    source: row.source,
    itemCount: row.item_count || 0,
    progress: Math.min(1, Math.max(0, (row.current_step - 1) / STEP_COUNT)),
    createdByName: row.created_by_name || null,
    updatedByName: row.updated_by_name || null,
    createdAt: wallTime(row.created_at),
    updatedAt: wallTime(row.updated_at),
    completedAt: wallTime(row.completed_at),
    cancelledAt: wallTime(row.cancelled_at),
    cancelReason: row.cancel_reason
  };
}

// Filters for the PO table. Every value is a bound parameter.
function buildFilters(sectionId, f) {
  const where = ["p.section_id = @sectionId"];
  const params = { sectionId, today: todayIso() };
  const status = `${f.status || "ACTIVE"}`.toUpperCase();
  if (["ACTIVE", "COMPLETED", "CANCELLED"].includes(status)) {
    where.push("p.status = @status");
    params.status = status;
  }
  if (f.q) {
    params.q = `%${`${f.q}`.trim().replace(/[%_[]/g, ch => `[${ch}]`)}%`;
    where.push(`(p.po_no LIKE @q OR p.supplier_name LIKE @q OR p.supplier_code LIKE @q OR s.short_name LIKE @q
      OR p.shipment_ref LIKE @q OR p.remark LIKE @q
      OR EXISTS (SELECT 1 FROM po_items i WHERE i.po_id = p.id AND (i.material_code LIKE @q OR i.short_text LIKE @q OR i.vendor_material LIKE @q)))`);
  }
  if (f.step) {
    params.step = Number(f.step);
    where.push("p.current_step = @step");
  }
  if (f.supplierId) {
    params.supplierId = Number(f.supplierId);
    where.push("p.supplier_id = @supplierId");
  }
  if (f.shipMode) {
    params.shipMode = `${f.shipMode}`;
    where.push("p.ship_mode = @shipMode");
  }
  const due = `${f.due || ""}`.toUpperCase();
  if (due === "OVERDUE") where.push("p.status = 'ACTIVE' AND p.next_due_date < @today");
  if (due === "TODAY") where.push("p.status = 'ACTIVE' AND p.next_due_date = @today");
  if (due === "SOON") {
    params.soon = Number(f.dueSoonDays || 3);
    where.push("p.status = 'ACTIVE' AND p.next_due_date >= @today AND p.next_due_date <= DATEADD(DAY, @soon, CAST(@today AS DATE))");
  }
  if (f.etaFrom && isIsoDate(f.etaFrom)) { params.etaFrom = f.etaFrom; where.push("p.eta_date >= @etaFrom"); }
  if (f.etaTo && isIsoDate(f.etaTo)) { params.etaTo = f.etaTo; where.push("p.eta_date <= @etaTo"); }
  if (f.docFrom && isIsoDate(f.docFrom)) { params.docFrom = f.docFrom; where.push("p.document_date >= @docFrom"); }
  if (f.docTo && isIsoDate(f.docTo)) { params.docTo = f.docTo; where.push("p.document_date <= @docTo"); }
  return { where: where.join(" AND "), params };
}

const SORTS = {
  due: "CASE WHEN p.next_due_date IS NULL THEN 1 ELSE 0 END, p.next_due_date, p.po_no",
  eta: "CASE WHEN p.eta_date IS NULL THEN 1 ELSE 0 END, p.eta_date, p.po_no",
  po: "p.po_no",
  poDesc: "p.po_no DESC",
  docDate: "p.document_date DESC, p.po_no",
  supplier: "p.supplier_name, p.po_no",
  step: "p.current_step, p.next_due_date",
  updated: "COALESCE(p.updated_at, p.created_at) DESC"
};

async function listPos(sectionId, filters = {}, ctx) {
  const { where, params } = buildFilters(sectionId, { ...filters, dueSoonDays: ctx.settings["alert.dueSoonDays"] });
  const pageSize = Math.min(Math.max(Number(filters.pageSize) || 50, 1), 500);
  const page = Math.max(Number(filters.page) || 1, 1);
  const order = SORTS[filters.sort] || SORTS.due;
  const total = (await query(`SELECT COUNT(1) AS n ${PO_FROM} WHERE ${where}`, params)).recordset[0].n;
  const rows = (await query(
    `SELECT ${PO_COLUMNS} ${PO_FROM} WHERE ${where}
     ORDER BY ${order} OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY`,
    { ...params, offset: (page - 1) * pageSize, pageSize }
  )).recordset;
  const today = todayIso();
  return {
    data: rows.map(r => serializePo(r, ctx.steps, today, ctx.settings["alert.dueSoonDays"])),
    total,
    page,
    pageSize
  };
}

async function getPoDetail(poId, sectionId, ctx) {
  const row = (await query(`SELECT ${PO_COLUMNS} ${PO_FROM} WHERE p.id = @poId AND p.section_id = @sectionId`, { poId, sectionId })).recordset[0];
  if (!row) throw httpError(404, "PO not found");
  const [items, steps, history] = await Promise.all([
    query("SELECT * FROM po_items WHERE po_id = @poId ORDER BY TRY_CAST(item_no AS INT), item_no, id", { poId }),
    query(
      `SELECT ps.*, u.display_name AS done_by_name FROM po_steps ps
       LEFT JOIN users u ON u.id = ps.done_by WHERE ps.po_id = @poId ORDER BY ps.step_no`,
      { poId }
    ),
    query(
      `SELECT h.*, u.display_name AS actor_name FROM po_history h
       LEFT JOIN users u ON u.id = h.actor_user_id WHERE h.po_id = @poId ORDER BY h.created_at DESC, h.id DESC`,
      { poId }
    )
  ]);
  const today = todayIso();
  const po = serializePo(row, ctx.steps, today, ctx.settings["alert.dueSoonDays"]);
  po.items = items.recordset.map(i => ({
    id: i.id,
    itemNo: i.item_no,
    materialId: i.material_id,
    materialCode: i.material_code,
    shortText: i.short_text,
    vendorMaterial: i.vendor_material,
    materialType: i.material_type,
    materialGroup: i.material_group,
    orderQty: num(i.order_qty),
    orderUnit: i.order_unit,
    netPrice: num(i.net_price),
    currency: i.currency,
    qtySku: num(i.qty_sku),
    skuUnit: i.sku_unit,
    leadTimeDays: i.lead_time_days,
    deleted: Boolean(i.deletion_indicator),
    stillToInvoiceQty: num(i.still_to_invoice_qty),
    stillToInvoiceValue: num(i.still_to_invoice_val),
    sourceRow: i.source_row,
    // Every column of the original SAP row (header -> value).
    raw: i.raw_data ? safeJson(i.raw_data) : null
  }));
  po.steps = steps.recordset.map(s => {
    const def = ctx.steps.find(d => d.stepNo === s.step_no) || {};
    const due = toIso(s.due_date);
    const actual = toIso(s.actual_date);
    return {
      stepNo: s.step_no,
      code: def.code,
      name: def.name,
      shortName: def.shortName,
      milestone: def.milestone,
      icon: def.icon,
      referenceLabel: def.referenceLabel,
      isArrival: def.isArrival || false,
      plannedDate: toIso(s.planned_date),
      dueDate: due,
      actualDate: actual,
      lateDays: actual && due ? diffDays(due, actual) : (!actual && due && due < today && row.status === "ACTIVE" ? diffDays(due, today) : null),
      doneByName: s.done_by_name || null,
      doneBy: s.done_by,
      doneAt: wallTime(s.done_at),
      referenceNo: s.reference_no,
      remark: s.remark,
      state: actual ? "done" : s.step_no === row.current_step && row.status === "ACTIVE" ? "current" : "pending"
    };
  });
  po.history = history.recordset.map(h => ({
    id: h.id,
    action: h.action,
    stepNo: h.step_no,
    detail: h.detail ? safeJson(h.detail) : null,
    actorName: h.actor_name || null,
    createdAt: wallTime(h.created_at)
  }));
  return po;
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

module.exports = {
  PO_COLUMNS,
  PO_FROM,
  advancePo,
  buildFilters,
  cancelPo,
  createPo,
  deletePo,
  getPoDetail,
  httpError,
  listPos,
  loadContext,
  recomputePo,
  recomputeSection,
  reopenPo,
  resolveLeadTime,
  serializePo,
  undoLastStep,
  updatePo,
  DONE_STEP
};
