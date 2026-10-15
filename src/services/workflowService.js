const { query } = require("../db/pool");
const { endOfMonth, shift } = require("./dates");

// The purchase process from the "PUR Process" sheet. Ten steps, one input:
// step 1 (Issue PO = N1) is the only date a person types (or the SAP export
// supplies); every later step is just "done" with the day it happened.
//
//   No. Step                                   Lead time (Excel)
//   1   Issue PO = N1                          N1
//   2   Acknowledgement (from supplier) = N2   N1+15
//   3   OCR Acknowledgement to SAP             (with step 2)
//   4   Shipping Instruction = N3              N2+40   <- flex, see below
//   5   OCR Shipping Instruction to SAP        (with step 4)
//   6   Supplier sends shipping docs = N4      N3+10
//   7   Clearing & delivery to TP = N5         N4+7
//   8   Input Declaration                      N5+1
//   9   Factory goods received                 N5+2    <- arrival
//   10  Monthly report                         every month end
//
// "Flex" step: the S/I wait is mostly the supplier's production time, which is
// what the material master's lead time measures. When the section has
// workflow.useMaterialLeadTime on, the flex step's offset is stretched so the
// arrival step lands on PO date + lead time (the longest of the PO's lines);
// with it off, the fixed +40 is used. The default 15+40+10+7+2 = 74 days
// matches the sheet's own 75-day total.
const DEFAULT_STEPS = [
  { stepNo: 1, code: "ISSUE_PO", name: "Issue PO", shortName: "Issue PO", milestone: "N1",
    anchorStepNo: null, offsetDays: 0, offsetMode: "DAYS", isFlex: false, isArrival: false,
    referenceLabel: null, icon: "receipt_long",
    description: "Purchase order issued to the supplier. Its date (SAP Document Date) is N1, the start of the plan." },
  { stepNo: 2, code: "ACK", name: "Acknowledgement (from supplier)", shortName: "ACK", milestone: "N2",
    anchorStepNo: 1, offsetDays: 15, offsetMode: "DAYS", isFlex: false, isArrival: false,
    referenceLabel: "ACK No.", icon: "mark_email_read",
    description: "Supplier confirms the order and gives the expected shipping date." },
  { stepNo: 3, code: "OCR_ACK", name: "OCR Acknowledgement to SAP", shortName: "OCR ACK", milestone: null,
    anchorStepNo: 2, offsetDays: 0, offsetMode: "DAYS", isFlex: false, isArrival: false,
    referenceLabel: null, icon: "document_scanner",
    description: "Key the supplier acknowledgement into SAP." },
  { stepNo: 4, code: "SI", name: "Shipping Instruction (from supplier)", shortName: "S/I", milestone: "N3",
    anchorStepNo: 2, offsetDays: 40, offsetMode: "DAYS", isFlex: true, isArrival: false,
    referenceLabel: "S/I / Shipment No.", icon: "directions_boat",
    description: "Supplier finishes production and sends the shipping instruction (ETD / ETA)." },
  { stepNo: 5, code: "OCR_SI", name: "OCR Shipping Instruction to SAP", shortName: "OCR S/I", milestone: null,
    anchorStepNo: 4, offsetDays: 0, offsetMode: "DAYS", isFlex: false, isArrival: false,
    referenceLabel: null, icon: "document_scanner",
    description: "Key the shipping instruction into SAP." },
  { stepNo: 6, code: "SHIP_DOC", name: "Shipping documents from supplier (Invoice + P/L + B/L)", shortName: "Ship Docs",
    milestone: "N4", anchorStepNo: 4, offsetDays: 10, offsetMode: "DAYS", isFlex: false, isArrival: false,
    referenceLabel: "Invoice No.", icon: "description",
    description: "Supplier sends invoice, packing list and bill of lading." },
  { stepNo: 7, code: "CLEARING", name: "Customs clearing & delivery to TP", shortName: "Clearing", milestone: "N5",
    anchorStepNo: 6, offsetDays: 7, offsetMode: "DAYS", isFlex: false, isArrival: false,
    referenceLabel: null, icon: "local_shipping",
    description: "Shipping agent clears customs and delivers to the factory." },
  { stepNo: 8, code: "DECLARATION", name: "Input Declaration", shortName: "Declaration", milestone: null,
    anchorStepNo: 7, offsetDays: 1, offsetMode: "DAYS", isFlex: false, isArrival: false,
    referenceLabel: "Declaration No.", icon: "assignment",
    description: "Key the import declaration." },
  { stepNo: 9, code: "GOODS_RECEIVED", name: "Factory goods received", shortName: "Received", milestone: null,
    anchorStepNo: 7, offsetDays: 2, offsetMode: "DAYS", isFlex: false, isArrival: true,
    referenceLabel: null, icon: "warehouse",
    description: "Goods arrive at the factory — this is the shipment's ETA." },
  { stepNo: 10, code: "MONTHLY_REPORT", name: "Monthly report", shortName: "Report", milestone: null,
    anchorStepNo: 9, offsetDays: 0, offsetMode: "END_OF_MONTH", isFlex: false, isArrival: false,
    referenceLabel: null, icon: "summarize",
    description: "Included in the month-end report (due on the last day of the month the goods arrived)." }
];

const STEP_COUNT = DEFAULT_STEPS.length;
const FIRST_OPEN_STEP = 2;
const DONE_STEP = STEP_COUNT + 1;

function fromRow(row) {
  return {
    stepNo: row.step_no,
    code: row.code,
    name: row.name,
    shortName: row.short_name,
    description: row.description,
    milestone: row.milestone,
    anchorStepNo: row.anchor_step_no,
    offsetDays: row.offset_days,
    offsetMode: row.offset_mode,
    isFlex: row.is_flex === true || row.is_flex === 1,
    isArrival: row.is_arrival === true || row.is_arrival === 1,
    referenceLabel: row.reference_label,
    icon: row.icon
  };
}

async function insertDefaultSteps(runner, sectionId) {
  for (const s of DEFAULT_STEPS) {
    await runner.query(
      `IF NOT EXISTS (SELECT 1 FROM workflow_steps WHERE section_id = @sectionId AND step_no = @stepNo)
       INSERT INTO workflow_steps (section_id, step_no, code, name, short_name, description, milestone,
         anchor_step_no, offset_days, offset_mode, is_flex, is_arrival, reference_label, icon)
       VALUES (@sectionId, @stepNo, @code, @name, @shortName, @description, @milestone,
         @anchorStepNo, @offsetDays, @offsetMode, @isFlex, @isArrival, @referenceLabel, @icon)`,
      { sectionId, ...s, isFlex: s.isFlex ? 1 : 0, isArrival: s.isArrival ? 1 : 0 }
    );
  }
}

async function getWorkflow(sectionId) {
  let rows = (await query("SELECT * FROM workflow_steps WHERE section_id = @sectionId ORDER BY step_no", { sectionId })).recordset;
  if (rows.length < STEP_COUNT) {
    // A section created after install, or a partial row set: fill the gaps
    // with the defaults so the process always has its ten steps.
    await insertDefaultSteps({ query }, sectionId);
    rows = (await query("SELECT * FROM workflow_steps WHERE section_id = @sectionId ORDER BY step_no", { sectionId })).recordset;
  }
  return rows.map(fromRow);
}

// Returns a list of problems (empty = valid) for an edited workflow.
function validateWorkflow(steps) {
  const problems = [];
  if (steps.length !== STEP_COUNT) problems.push(`The workflow must have exactly ${STEP_COUNT} steps`);
  const byNo = new Map(steps.map(s => [s.stepNo, s]));
  for (let n = 1; n <= STEP_COUNT; n += 1) if (!byNo.has(n)) problems.push(`Step ${n} is missing`);
  for (const s of steps) {
    if (!`${s.name || ""}`.trim()) problems.push(`Step ${s.stepNo} needs a name`);
    if (s.stepNo === 1) continue;
    if (!Number.isInteger(s.anchorStepNo) || s.anchorStepNo < 1 || s.anchorStepNo >= s.stepNo) {
      problems.push(`Step ${s.stepNo} must count from an earlier step`);
    }
    if (!Number.isInteger(s.offsetDays) || s.offsetDays < 0 || s.offsetDays > 365) {
      problems.push(`Step ${s.stepNo}: days must be between 0 and 365`);
    }
    if (!["DAYS", "END_OF_MONTH"].includes(s.offsetMode)) problems.push(`Step ${s.stepNo}: unknown offset mode`);
  }
  if (steps.filter(s => s.isFlex).length > 1) problems.push("Only one step can absorb the material lead time");
  if (steps.filter(s => s.isArrival).length !== 1) problems.push("Exactly one step must be the arrival (ETA) step");
  if (steps.some(s => s.isFlex && (s.stepNo === 1 || s.offsetMode !== "DAYS"))) {
    problems.push("The lead-time step must be a later step counted in days");
  }
  return problems;
}

// Offsets on the anchor chain from the arrival step back to step 1, used to
// decide how long the flex step has to be.
function arrivalChain(steps) {
  const byNo = new Map(steps.map(s => [s.stepNo, s]));
  const arrival = steps.find(s => s.isArrival);
  const chain = [];
  let current = arrival;
  let guard = 0;
  while (current && current.stepNo !== 1 && guard < STEP_COUNT + 1) {
    chain.push(current);
    current = byNo.get(current.anchorStepNo);
    guard += 1;
  }
  return chain;
}

// The flex step's day count for a PO with this lead time, or its configured
// offset when lead-time stretching is off / not applicable.
function flexOffsetFor(steps, leadTimeDays, settings) {
  const flex = steps.find(s => s.isFlex);
  if (!flex) return null;
  if (!settings.useMaterialLeadTime || !Number.isFinite(leadTimeDays) || leadTimeDays <= 0) return flex.offsetDays;
  const chain = arrivalChain(steps);
  if (!chain.some(s => s.stepNo === flex.stepNo)) return flex.offsetDays;
  const others = chain
    .filter(s => s.stepNo !== flex.stepNo)
    .reduce((sum, s) => sum + (s.offsetMode === "DAYS" ? s.offsetDays : 0), 0);
  return Math.max(settings.minFlexDays ?? 0, leadTimeDays - others);
}

// Due date of every step.
//   documentDate — N1
//   actuals      — Map/obj stepNo -> actual ISO date of the steps already done
// A step's due date counts from its anchor's ACTUAL date once the anchor is
// done (so a late acknowledgement pushes the rest of the plan), or from the
// anchor's due date while it is still open.
function computeSchedule({ steps, documentDate, leadTimeDays, actuals = {}, settings, holidays }) {
  const actualOf = n => (actuals instanceof Map ? actuals.get(n) : actuals[n]) || null;
  const flexDays = flexOffsetFor(steps, leadTimeDays, settings);
  const due = {};
  for (const s of [...steps].sort((a, b) => a.stepNo - b.stepNo)) {
    if (s.stepNo === 1) {
      due[1] = documentDate;
      continue;
    }
    const base = actualOf(s.anchorStepNo) || due[s.anchorStepNo] || documentDate;
    if (s.offsetMode === "END_OF_MONTH") {
      due[s.stepNo] = endOfMonth(base);
    } else {
      const days = s.isFlex && flexDays !== null ? flexDays : s.offsetDays;
      due[s.stepNo] = shift(base, days, settings.dayMode, holidays);
    }
  }
  return due;
}

function arrivalStepNo(steps) {
  return (steps.find(s => s.isArrival) || steps[steps.length - 2] || { stepNo: 9 }).stepNo;
}

module.exports = {
  DEFAULT_STEPS,
  DONE_STEP,
  FIRST_OPEN_STEP,
  STEP_COUNT,
  arrivalStepNo,
  computeSchedule,
  flexOffsetFor,
  getWorkflow,
  insertDefaultSteps,
  validateWorkflow
};
