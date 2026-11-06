const ExcelJS = require("exceljs");
const { query } = require("../db/pool");
const { addDays, diffDays, endOfMonth, monthRange, todayIso } = require("./dates");
const { STEP_COUNT, arrivalStepNo } = require("./workflowService");
const { PO_COLUMNS, PO_FROM, serializePo } = require("./poService");
const { num, toIso } = require("./serialize");

function monthStart(iso) {
  return `${iso.slice(0, 7)}-01`;
}

function shiftMonth(month, delta) {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return d.toISOString().slice(0, 7);
}

async function activePos(sectionId, ctx) {
  const rows = (await query(
    `SELECT ${PO_COLUMNS} ${PO_FROM} WHERE p.section_id = @sectionId AND p.status = 'ACTIVE'
     ORDER BY p.next_due_date, p.po_no`,
    { sectionId }
  )).recordset;
  const today = todayIso();
  return rows.map(r => serializePo(r, ctx.steps, today, ctx.settings["alert.dueSoonDays"]));
}

// A shipment is one Acknowledgment No. (the POs that travel together). A PO
// still waiting for its ACK has none yet, so it counts as a shipment of its own.
function shipmentKey(p) {
  return p.ackNo ? `A:${p.ackNo}` : `P:${p.id}`;
}

function yearParam(value) {
  const y = Number(value);
  return Number.isInteger(y) && y >= 2000 && y <= 2100 ? y : Number(todayIso().slice(0, 4));
}

// Planned vs arrived, month by month through one calendar year: the POs whose
// arrival was PLANNED for the month and how that same set landed (on time,
// late, not yet), plus POs issued and arrivals per month.
async function trendForYear(sectionId, ctx, year) {
  const arrival = arrivalStepNo(ctx.steps);
  const from = `${year}-01-01`;
  const to = `${year + 1}-01-01`;
  const trendRows = (await query(
    `SELECT FORMAT(document_date, 'yyyy-MM') AS m, COUNT(1) AS n FROM purchase_orders
     WHERE section_id = @sectionId AND status <> 'CANCELLED' AND document_date >= @from AND document_date < @to
     GROUP BY FORMAT(document_date, 'yyyy-MM');
     SELECT FORMAT(ps.actual_date, 'yyyy-MM') AS m, COUNT(1) AS n,
            SUM(CASE WHEN ps.actual_date <= ps.planned_date THEN 1 ELSE 0 END) AS on_time
     FROM po_steps ps JOIN purchase_orders p ON p.id = ps.po_id
     WHERE p.section_id = @sectionId AND p.status <> 'CANCELLED' AND ps.step_no = @arrival
       AND ps.actual_date >= @from AND ps.actual_date < @to
     GROUP BY FORMAT(ps.actual_date, 'yyyy-MM');
     SELECT FORMAT(ps.planned_date, 'yyyy-MM') AS m, COUNT(1) AS n,
            SUM(CASE WHEN ps.actual_date IS NOT NULL AND ps.actual_date <= ps.planned_date THEN 1 ELSE 0 END) AS on_time,
            SUM(CASE WHEN ps.actual_date > ps.planned_date THEN 1 ELSE 0 END) AS late
     FROM po_steps ps JOIN purchase_orders p ON p.id = ps.po_id
     WHERE p.section_id = @sectionId AND p.status <> 'CANCELLED' AND ps.step_no = @arrival
       AND ps.planned_date >= @from AND ps.planned_date < @to
     GROUP BY FORMAT(ps.planned_date, 'yyyy-MM')`,
    { sectionId, from, to, arrival }
  )).recordsets;
  const issued = new Map(trendRows[0].map(r => [r.m, r.n]));
  const arrived = new Map(trendRows[1].map(r => [r.m, r]));
  const planned = new Map(trendRows[2].map(r => [r.m, r]));
  const trend = [];
  for (let i = 1; i <= 12; i += 1) {
    const m = `${year}-${`${i}`.padStart(2, "0")}`;
    const a = arrived.get(m);
    const p = planned.get(m);
    trend.push({
      month: m,
      issued: issued.get(m) || 0,
      arrived: a?.n || 0,
      onTime: a?.on_time || 0,
      planned: p?.n || 0,
      plannedOnTime: p?.on_time || 0,
      plannedLate: p?.late || 0
    });
  }
  return { year, trend };
}

// Shipments per month of one year by shipping mode — one stacked bar a month.
// The month is the shipment's arrival month (step 7: done date, else its
// Delivery date). Cancelled POs are left out.
async function modesForYear(sectionId, year) {
  const rows = (await query(
    `SELECT p.id, p.ack_no, p.ship_mode, FORMAT(p.eta_date, 'yyyy-MM') AS m
     FROM purchase_orders p
     WHERE p.section_id = @sectionId AND p.status <> 'CANCELLED'
       AND p.eta_date >= @from AND p.eta_date < @to`,
    { sectionId, from: `${year}-01-01`, to: `${year + 1}-01-01` }
  )).recordset;
  const modes = ["SEA", "AIR", "COURIER", "TRUCK", "UNKNOWN"];
  const months = [];
  for (let i = 1; i <= 12; i += 1) {
    const m = `${year}-${`${i}`.padStart(2, "0")}`;
    const counts = Object.fromEntries(modes.map(x => [x, new Set()]));
    for (const r of rows.filter(x => x.m === m)) {
      const mode = modes.includes(r.ship_mode) ? r.ship_mode : "UNKNOWN";
      counts[mode].add(shipmentKey({ id: r.id, ackNo: r.ack_no }));
    }
    months.push({ month: m, ...Object.fromEntries(modes.map(x => [x, counts[x].size])) });
  }
  return { year, months };
}

// POs and material lines per supplier for a year ("2026") or a month
// ("2026-03") of PO date. A split PO (one PO shipped under two
// Acknowledgment Nos.) counts once, and so does each of its lines.
async function suppliersForPeriod(sectionId, period) {
  const p = /^\d{4}(-(0[1-9]|1[0-2]))?$/.test(`${period || ""}`) ? `${period}` : todayIso().slice(0, 4);
  let from;
  let to;
  if (p.length === 4) {
    from = `${p}-01-01`;
    to = `${Number(p) + 1}-01-01`;
  } else {
    from = `${p}-01`;
    to = addDays(monthRange(p).end, 1);
  }
  const today = todayIso();
  const rows = (await query(
    `SELECT p.id, p.po_no, p.supplier_code, p.supplier_name, s.short_name, p.status, p.next_due_date
     FROM purchase_orders p LEFT JOIN suppliers s ON s.id = p.supplier_id
     WHERE p.section_id = @sectionId AND p.status <> 'CANCELLED'
       AND p.document_date >= @from AND p.document_date < @to;
     SELECT i.po_id, COALESCE(i.item_no, CAST(i.id AS NVARCHAR(20))) AS item
     FROM po_items i JOIN purchase_orders p ON p.id = i.po_id
     WHERE p.section_id = @sectionId AND p.status <> 'CANCELLED' AND i.deletion_indicator IS NULL
       AND p.document_date >= @from AND p.document_date < @to`,
    { sectionId, from, to }
  )).recordsets;
  const itemsByPo = new Map();
  for (const i of rows[1]) {
    if (!itemsByPo.has(i.po_id)) itemsByPo.set(i.po_id, []);
    itemsByPo.get(i.po_id).push(i.item);
  }
  const map = new Map();
  for (const r of rows[0]) {
    const key = r.supplier_code || r.supplier_name || "-";
    if (!map.has(key)) {
      map.set(key, { supplierCode: r.supplier_code, name: r.short_name || r.supplier_name || key, pos: new Set(), lines: new Set(), overdue: new Set() });
    }
    const s = map.get(key);
    s.pos.add(r.po_no);
    for (const item of itemsByPo.get(r.id) || []) s.lines.add(`${r.po_no}|${item}`);
    if (r.status === "ACTIVE" && r.next_due_date && toIso(r.next_due_date) < today) s.overdue.add(r.po_no);
  }
  const suppliers = [...map.values()]
    .map(s => ({ supplierCode: s.supplierCode, name: s.name, count: s.pos.size, materials: s.lines.size, overdue: s.overdue.size }))
    .sort((a, b) => b.count - a.count || b.materials - a.materials);
  return { period: p, suppliers };
}

// The years each dashboard card has data for, newest first, so its picker
// offers nothing empty:
//   trend     — an arrival PLANNED or DONE in the year (step 7)
//   modes     — a shipment arriving in the year (eta_date = step 7 date)
//   suppliers — a PO dated in the year
async function dashboardYears(sectionId, ctx) {
  const r = (await query(
    `SELECT DISTINCT y FROM (
       SELECT YEAR(ps.planned_date) AS y FROM po_steps ps JOIN purchase_orders p ON p.id = ps.po_id
       WHERE p.section_id = @sectionId AND p.status <> 'CANCELLED' AND ps.step_no = @arrival AND ps.planned_date IS NOT NULL
       UNION
       SELECT YEAR(ps.actual_date) FROM po_steps ps JOIN purchase_orders p ON p.id = ps.po_id
       WHERE p.section_id = @sectionId AND p.status <> 'CANCELLED' AND ps.step_no = @arrival AND ps.actual_date IS NOT NULL
     ) t ORDER BY y DESC;
     SELECT DISTINCT YEAR(eta_date) AS y FROM purchase_orders
     WHERE section_id = @sectionId AND status <> 'CANCELLED' AND eta_date IS NOT NULL ORDER BY y DESC;
     SELECT DISTINCT YEAR(document_date) AS y FROM purchase_orders
     WHERE section_id = @sectionId AND status <> 'CANCELLED' ORDER BY y DESC;`,
    { sectionId, arrival: arrivalStepNo(ctx.steps) }
  )).recordsets;
  const list = rows => rows.map(x => x.y).filter(Boolean);
  return { trend: list(r[0]), modes: list(r[1]), suppliers: list(r[2]) };
}

// This year when the card has data for it; otherwise the latest past year
// with data, else the earliest one (only future data).
function defaultYear(years) {
  const now = Number(todayIso().slice(0, 4));
  if (!years.length || years.includes(now)) return now;
  return years.find(y => y < now) ?? years[years.length - 1];
}

// Everything the Dashboard page draws, in one call.
async function dashboardSummary(sectionId, ctx) {
  const today = todayIso();
  const thisMonth = today.slice(0, 7);
  const { start, end } = monthRange(thisMonth);
  const arrival = arrivalStepNo(ctx.steps);
  const pos = await activePos(sectionId, ctx);

  const counts = {
    // POs, not records: a PO shipped under two Acknowledgment Nos. is one PO.
    active: new Set(pos.map(p => p.poNo)).size,
    activeShipments: new Set(pos.map(shipmentKey)).size,
    overdue: pos.filter(p => p.dueState === "overdue").length,
    dueToday: pos.filter(p => p.dueState === "today").length,
    dueSoon: pos.filter(p => p.dueState === "soon").length,
    arrivingThisMonth: pos.filter(p => p.etaDate && p.etaDate >= start && p.etaDate <= end && p.currentStep <= arrival).length,
    arrivingNext7: pos.filter(p => p.etaDate && p.etaDate >= today && p.etaDate <= addDays(today, 7) && p.currentStep <= arrival).length
  };
  const monthCounts = (await query(
    `SELECT
       (SELECT COUNT(1) FROM purchase_orders WHERE section_id = @sectionId AND status <> 'CANCELLED'
          AND document_date BETWEEN @start AND @end) AS issued,
       (SELECT COUNT(1) FROM po_steps ps JOIN purchase_orders p ON p.id = ps.po_id
          WHERE p.section_id = @sectionId AND p.status <> 'CANCELLED' AND ps.step_no = @arrival
            AND ps.actual_date BETWEEN @start AND @end) AS arrived,
       (SELECT COUNT(1) FROM po_steps ps JOIN purchase_orders p ON p.id = ps.po_id
          WHERE p.section_id = @sectionId AND p.status <> 'CANCELLED' AND ps.step_no = @arrival
            AND ps.actual_date BETWEEN @start AND @end AND ps.actual_date <= ps.planned_date) AS arrived_on_time,
       (SELECT COUNT(1) FROM purchase_orders WHERE section_id = @sectionId AND status = 'COMPLETED'
          AND CAST(completed_at AS DATE) BETWEEN @start AND @end) AS completed`,
    { sectionId, start, end, arrival }
  )).recordset[0];
  counts.issuedThisMonth = monthCounts.issued;
  counts.arrivedThisMonth = monthCounts.arrived;
  counts.arrivedOnTimeThisMonth = monthCounts.arrived_on_time;
  counts.completedThisMonth = monthCounts.completed;

  // Shipments waiting at each step (a shipment is overdue when any of its POs is).
  const byStep = ctx.steps.filter(s => s.stepNo >= 2).map(s => {
    const at = pos.filter(p => p.currentStep === s.stepNo);
    const keys = list => new Set(list.map(shipmentKey)).size;
    return {
      stepNo: s.stepNo,
      name: s.name,
      shortName: s.shortName,
      icon: s.icon,
      count: keys(at),
      poCount: at.length,
      overdue: keys(at.filter(p => p.dueState === "overdue")),
      dueSoon: keys(at.filter(p => p.dueState === "today" || p.dueState === "soon"))
    };
  });


  const years = await dashboardYears(sectionId, ctx);
  const [trend, modes, suppliers] = await Promise.all([
    trendForYear(sectionId, ctx, defaultYear(years.trend)),
    modesForYear(sectionId, defaultYear(years.modes)),
    suppliersForPeriod(sectionId, `${defaultYear(years.suppliers)}`)
  ]);

  const arrivals = pos
    .filter(p => p.etaDate && p.etaDate >= today && p.currentStep <= arrival)
    .sort((a, b) => a.etaDate.localeCompare(b.etaDate))
    .slice(0, 5);
  const overdueList = pos
    .filter(p => p.dueState === "overdue")
    .sort((a, b) => b.overdueDays - a.overdueDays)
    .slice(0, 5);
  const dueSoonList = pos
    .filter(p => p.dueState === "today" || p.dueState === "soon")
    .sort((a, b) => a.nextDueDate.localeCompare(b.nextDueDate))
    .slice(0, 5);
  return {
    today, years, counts, byStep, arrivals, overdueList, dueSoonList,
    trendYear: trend.year, trend: trend.trend, modesYear: modes.year, modesByMonth: modes.months,
    supplierPeriod: suppliers.period, bySupplier: suppliers.suppliers
  };
}

// For the 08:30 mail: every active PO, grouped the way the mail draws it.
async function dailyDigest(sectionId, ctx) {
  const today = todayIso();
  const pos = await activePos(sectionId, ctx);
  const arrival = arrivalStepNo(ctx.steps);
  const groups = ctx.steps
    .filter(s => s.stepNo >= 2)
    .map(s => ({ step: s, pos: pos.filter(p => p.currentStep === s.stepNo) }))
    .filter(g => g.pos.length);
  const { start, end } = monthRange(today.slice(0, 7));
  return {
    today,
    total: pos.length,
    overdue: pos.filter(p => p.dueState === "overdue"),
    dueToday: pos.filter(p => p.dueState === "today"),
    dueSoon: pos.filter(p => p.dueState === "soon"),
    arrivingThisMonth: pos.filter(p => p.etaDate && p.etaDate >= start && p.etaDate <= end && p.currentStep <= arrival),
    arrivingNext7: pos
      .filter(p => p.etaDate && p.etaDate >= today && p.etaDate <= addDays(today, 7) && p.currentStep <= arrival)
      .sort((a, b) => a.etaDate.localeCompare(b.etaDate)),
    groups,
    dueSoonDays: ctx.settings["alert.dueSoonDays"]
  };
}

// The month-end summary (the Monthly Report page and the month-end email).
async function monthlyReport(sectionId, month, ctx) {
  const { start, end } = monthRange(month);
  const arrival = arrivalStepNo(ctx.steps);
  const today = todayIso();
  const [issuedRows, stepRows, openRows] = await Promise.all([
    query(
      `SELECT p.currency, COUNT(1) AS n, SUM(ISNULL(p.total_value, 0)) AS value, SUM(CASE WHEN p.status = 'CANCELLED' THEN 1 ELSE 0 END) AS cancelled
       FROM purchase_orders p WHERE p.section_id = @sectionId AND p.document_date BETWEEN @start AND @end
       GROUP BY p.currency`,
      { sectionId, start, end }
    ),
    query(
      `SELECT ps.step_no, ps.actual_date, ps.due_date, ps.planned_date, ps.reference_no,
              p.id AS po_id, p.po_no, p.supplier_code, p.supplier_name, s.short_name AS supplier_short,
              p.document_date, p.lead_time_days, p.ship_mode, p.shipment_ref,
              (SELECT COUNT(1) FROM po_items i WHERE i.po_id = p.id) AS item_count
       FROM po_steps ps
       JOIN purchase_orders p ON p.id = ps.po_id
       LEFT JOIN suppliers s ON s.id = p.supplier_id
       WHERE p.section_id = @sectionId AND p.status <> 'CANCELLED' AND ps.step_no >= 2
         AND ps.actual_date BETWEEN @start AND @end`,
      { sectionId, start, end }
    ),
    query(
      `SELECT ${PO_COLUMNS} ${PO_FROM}
       WHERE p.section_id = @sectionId AND p.status = 'ACTIVE' AND p.document_date <= @end
       ORDER BY p.next_due_date`,
      { sectionId, end }
    )
  ]);

  const issued = {
    count: issuedRows.recordset.reduce((s, r) => s + r.n, 0),
    cancelled: issuedRows.recordset.reduce((s, r) => s + r.cancelled, 0),
    valueByCurrency: issuedRows.recordset.filter(r => r.currency).map(r => ({ currency: r.currency, value: num(r.value) }))
  };

  const steps = stepRows.recordset.map(r => ({
    stepNo: r.step_no,
    actual: toIso(r.actual_date),
    due: toIso(r.due_date),
    planned: toIso(r.planned_date),
    poId: r.po_id,
    poNo: r.po_no,
    supplierCode: r.supplier_code,
    supplierName: r.supplier_short || r.supplier_name,
    documentDate: toIso(r.document_date),
    leadTimeDays: r.lead_time_days,
    shipMode: r.ship_mode,
    shipmentRef: r.shipment_ref,
    itemCount: r.item_count,
    referenceNo: r.reference_no
  }));

  const stepPerformance = ctx.steps.filter(s => s.stepNo >= 2).map(s => {
    const done = steps.filter(x => x.stepNo === s.stepNo);
    const late = done.filter(x => x.due && x.actual > x.due);
    return {
      stepNo: s.stepNo,
      name: s.name,
      shortName: s.shortName,
      done: done.length,
      onTime: done.length - late.length,
      late: late.length,
      avgLateDays: late.length ? +(late.reduce((t, x) => t + diffDays(x.due, x.actual), 0) / late.length).toFixed(1) : 0
    };
  });

  const arrivals = steps
    .filter(x => x.stepNo === arrival)
    .map(x => ({
      poId: x.poId,
      poNo: x.poNo,
      supplierCode: x.supplierCode,
      supplierName: x.supplierName,
      documentDate: x.documentDate,
      plannedArrival: x.planned,
      actualArrival: x.actual,
      delayDays: x.planned ? diffDays(x.planned, x.actual) : null,
      actualLeadTime: x.documentDate ? diffDays(x.documentDate, x.actual) : null,
      masterLeadTime: x.leadTimeDays,
      shipMode: x.shipMode,
      shipmentRef: x.shipmentRef,
      itemCount: x.itemCount
    }))
    .sort((a, b) => a.actualArrival.localeCompare(b.actualArrival));

  const onTime = arrivals.filter(a => a.delayDays !== null && a.delayDays <= 0).length;
  const supplierMap = new Map();
  for (const a of arrivals) {
    const key = a.supplierCode || a.supplierName || "-";
    if (!supplierMap.has(key)) supplierMap.set(key, { supplierCode: a.supplierCode, name: a.supplierName, arrived: 0, onTime: 0, delaySum: 0, leadSum: 0, masterSum: 0 });
    const s = supplierMap.get(key);
    s.arrived += 1;
    if (a.delayDays !== null && a.delayDays <= 0) s.onTime += 1;
    s.delaySum += Math.max(0, a.delayDays || 0);
    s.leadSum += a.actualLeadTime || 0;
    s.masterSum += a.masterLeadTime || 0;
  }
  const supplierPerformance = [...supplierMap.values()].map(s => ({
    supplierCode: s.supplierCode,
    name: s.name,
    arrived: s.arrived,
    onTime: s.onTime,
    onTimeRate: s.arrived ? Math.round((s.onTime / s.arrived) * 100) : null,
    avgDelayDays: s.arrived ? +(s.delaySum / s.arrived).toFixed(1) : 0,
    avgActualLeadTime: s.arrived ? Math.round(s.leadSum / s.arrived) : null,
    avgMasterLeadTime: s.arrived ? Math.round(s.masterSum / s.arrived) : null
  })).sort((a, b) => b.arrived - a.arrived);

  const open = openRows.recordset.map(r => serializePo(r, ctx.steps, today, ctx.settings["alert.dueSoonDays"]));
  const asOf = end < today ? end : today;
  const openOverdue = open.filter(p => p.nextDueDate && p.nextDueDate < asOf);

  return {
    month,
    start,
    end,
    issued,
    arrived: {
      count: arrivals.length,
      onTime,
      late: arrivals.length - onTime,
      onTimeRate: arrivals.length ? Math.round((onTime / arrivals.length) * 100) : null,
      avgDelayDays: arrivals.length ? +(arrivals.reduce((t, a) => t + Math.max(0, a.delayDays || 0), 0) / arrivals.length).toFixed(1) : 0,
      avgActualLeadTime: arrivals.length ? Math.round(arrivals.reduce((t, a) => t + (a.actualLeadTime || 0), 0) / arrivals.length) : null
    },
    completed: steps.filter(x => x.stepNo === STEP_COUNT).length,
    stepsDone: steps.length,
    stepPerformance,
    supplierPerformance,
    arrivals,
    openCount: open.length,
    openOverdueCount: openOverdue.length,
    openOverdue: openOverdue.slice(0, 200)
  };
}

function styleHeader(row, color = "FF5B53E0") {
  row.eachCell(cell => {
    cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: color } };
    cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
  });
  row.height = 22;
}

function addTable(ws, startRow, columns, rows) {
  const header = ws.getRow(startRow);
  columns.forEach((c, i) => {
    header.getCell(i + 1).value = c.header;
    if (c.width) ws.getColumn(i + 1).width = Math.max(ws.getColumn(i + 1).width || 0, c.width);
  });
  styleHeader(header);
  rows.forEach((r, idx) => {
    const row = ws.getRow(startRow + 1 + idx);
    columns.forEach((c, i) => {
      let v = typeof c.value === "function" ? c.value(r) : r[c.key];
      const cell = row.getCell(i + 1);
      if (c.type === "date" && typeof v === "string") {
        v = new Date(`${v}T00:00:00Z`);
        cell.numFmt = "dd/mm/yyyy";
      }
      cell.value = v ?? null;
      if (idx % 2 === 1) cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF4F2FC" } };
    });
  });
  return startRow + rows.length + 2;
}

async function monthlyReportBuffer(report, sectionName) {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Purchase Shipment Alert";
  const title = `Monthly shipment report — ${sectionName} — ${report.month}`;

  const summary = wb.addWorksheet("Summary");
  summary.getCell("A1").value = title;
  summary.getCell("A1").font = { bold: true, size: 14 };
  summary.getCell("A2").value = `Period ${report.start} to ${report.end}`;
  summary.getColumn(1).width = 34;
  summary.getColumn(2).width = 16;
  const kv = [
    ["POs issued", report.issued.count],
    ["  of which cancelled", report.issued.cancelled],
    ["Shipments arrived", report.arrived.count],
    ["  on time (vs original plan)", report.arrived.onTime],
    ["  late", report.arrived.late],
    ["On-time rate %", report.arrived.onTimeRate ?? "-"],
    ["Average delay (days)", report.arrived.avgDelayDays],
    ["Average actual lead time (days)", report.arrived.avgActualLeadTime ?? "-"],
    ["POs completed (monthly report step)", report.completed],
    ["Open POs at month end", report.openCount],
    ["  overdue", report.openOverdueCount]
  ];
  kv.forEach(([k, v], i) => {
    summary.getCell(4 + i, 1).value = k;
    summary.getCell(4 + i, 2).value = v;
    if (!k.startsWith("  ")) summary.getCell(4 + i, 1).font = { bold: true };
  });
  let row = 4 + kv.length + 1;
  for (const v of report.issued.valueByCurrency) {
    summary.getCell(row, 1).value = `PO value issued (${v.currency})`;
    summary.getCell(row, 2).value = v.value;
    summary.getCell(row, 2).numFmt = "#,##0.00";
    row += 1;
  }

  const steps = wb.addWorksheet("Step performance");
  addTable(steps, 1, [
    { header: "No.", key: "stepNo", width: 6 },
    { header: "Step", key: "name", width: 46 },
    { header: "Done", key: "done", width: 10 },
    { header: "On time", key: "onTime", width: 10 },
    { header: "Late", key: "late", width: 10 },
    { header: "Avg late days", key: "avgLateDays", width: 14 }
  ], report.stepPerformance);

  const arrivals = wb.addWorksheet("Arrivals");
  addTable(arrivals, 1, [
    { header: "PO No.", key: "poNo", width: 14 },
    { header: "Supplier", key: "supplierName", width: 26 },
    { header: "PO date", key: "documentDate", type: "date", width: 12 },
    { header: "Planned arrival", key: "plannedArrival", type: "date", width: 15 },
    { header: "Actual arrival", key: "actualArrival", type: "date", width: 14 },
    { header: "Delay (days)", key: "delayDays", width: 12 },
    { header: "Actual lead time", key: "actualLeadTime", width: 15 },
    { header: "Master lead time", key: "masterLeadTime", width: 15 },
    { header: "Mode", key: "shipMode", width: 9 },
    { header: "Shipment ref", key: "shipmentRef", width: 16 },
    { header: "Lines", key: "itemCount", width: 8 }
  ], report.arrivals);

  const suppliers = wb.addWorksheet("Supplier performance");
  addTable(suppliers, 1, [
    { header: "Supplier ID", key: "supplierCode", width: 13 },
    { header: "Supplier", key: "name", width: 30 },
    { header: "Arrived", key: "arrived", width: 10 },
    { header: "On time", key: "onTime", width: 10 },
    { header: "On-time %", key: "onTimeRate", width: 11 },
    { header: "Avg delay (days)", key: "avgDelayDays", width: 15 },
    { header: "Avg actual lead time", key: "avgActualLeadTime", width: 18 },
    { header: "Avg master lead time", key: "avgMasterLeadTime", width: 18 }
  ], report.supplierPerformance);

  const open = wb.addWorksheet("Open overdue");
  addTable(open, 1, [
    { header: "PO No.", key: "poNo", width: 14 },
    { header: "Supplier", value: p => p.supplierShort || p.supplierName, width: 26 },
    { header: "PO date", key: "documentDate", type: "date", width: 12 },
    { header: "Current step", key: "currentStepName", width: 36 },
    { header: "Due", key: "nextDueDate", type: "date", width: 12 },
    { header: "Overdue (days)", key: "overdueDays", width: 13 },
    { header: "ETA", key: "etaDate", type: "date", width: 12 }
  ], report.openOverdue);

  for (const ws of wb.worksheets) ws.views = [{ state: "frozen", ySplit: ws.name === "Summary" ? 0 : 1 }];
  return wb.xlsx.writeBuffer();
}

// PO list export (whatever filter the table is showing).
async function poListBuffer(rows, sectionName) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("POs");
  ws.getCell("A1").value = `Purchase shipments — ${sectionName} — exported ${todayIso()}`;
  ws.getCell("A1").font = { bold: true, size: 13 };
  addTable(ws, 3, [
    { header: "PO No.", key: "poNo", width: 14 },
    { header: "Supplier ID", key: "supplierCode", width: 12 },
    { header: "Supplier", value: p => p.supplierShort || p.supplierName, width: 28 },
    { header: "PO date", key: "documentDate", type: "date", width: 12 },
    { header: "Lines", key: "itemCount", width: 7 },
    { header: "Mode", key: "shipMode", width: 8 },
    { header: "Lead time", key: "leadTimeDays", width: 10 },
    { header: "Status", key: "status", width: 12 },
    { header: "Current step", key: "currentStepName", width: 34 },
    { header: "Due", key: "nextDueDate", type: "date", width: 12 },
    { header: "Overdue (days)", key: "overdueDays", width: 13 },
    { header: "ETA (factory)", key: "etaDate", type: "date", width: 13 },
    { header: "Shipment ref", key: "shipmentRef", width: 16 },
    { header: "Remark", key: "remark", width: 30 }
  ], rows);
  ws.views = [{ state: "frozen", ySplit: 3 }];
  return wb.xlsx.writeBuffer();
}

module.exports = {
  dailyDigest, dashboardSummary, modesForYear, suppliersForPeriod, trendForYear, yearParam, monthStart, monthlyReport, monthlyReportBuffer, poListBuffer, shiftMonth, endOfMonth };
