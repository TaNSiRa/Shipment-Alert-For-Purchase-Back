const { query } = require("../db/pool");
const { endOfMonth, shift } = require("./dates");

// The purchase process, as agreed with Purchase (meeting 2026-11). Seven
// steps; the dates come from four inputs:
//
//   No. Step                                              Lead time   Input
//   1   Issue PO = N1                                     N1          1  DATA EXPORT BY SAP (+ Delivery date)
//   2   OCR Acknowledgement from SAP = N2                 N1+10       2  OCR ACK file (Acknowledgment No. = shipment)
//   3   OCR Shipping Instruction from SAP = N3            N2+20       3  OCR SI file (ETD / ETA)
//   4   Supplier sends shipping documents = N4            N3+15
//   5   Process clearing and delivery to TP = N5          N4+5
//   6   Input Declaration                                 N5+1
//   7   Factory good received                             Delivery date (Input 1, editable any time)
//
// Steps 2 and 3 are normally closed by uploading the OCR files; the "Mark
// done" button stays for when a file has a problem. The arrival step's due
// date is the PO's Delivery date (typed at import); its anchor/offset is only
// the fallback for a PO that has none. The ETA in the OCR SI file is shown on
// the PO but does not move step 7.
//
// Every due date comes from these lead times alone. The material master's
// lead time no longer stretches any step (removed, Purchase 2026-11): the
// longest material on a PO does not change its plan. workflow_steps.is_flex
// is kept in the table but ignored.
const DEFAULT_STEPS = [
  { stepNo: 1, code: "ISSUE_PO", name: "Issue PO", shortName: "Issue PO", milestone: "N1",
    anchorStepNo: null, offsetDays: 0, offsetMode: "DAYS", isFlex: false, isArrival: false,
    referenceLabel: null, icon: "receipt_long",
    description: "Purchase order issued to the supplier. Its date (SAP Document Date) is N1, the start of the plan." },
  { stepNo: 2, code: "ACK", name: "OCR Acknowledgement from SAP", shortName: "OCR ACK", milestone: "N2",
    anchorStepNo: 1, offsetDays: 10, offsetMode: "DAYS", isFlex: false, isArrival: false,
    referenceLabel: "Acknowledgment No.", icon: "document_scanner",
    description: "Upload the OCR ACK file from SAP. Its Acknowledgment No. groups the POs into one shipment." },
  { stepNo: 3, code: "SI", name: "OCR Shipping Instruction from SAP", shortName: "OCR S/I", milestone: "N3",
    anchorStepNo: 2, offsetDays: 20, offsetMode: "DAYS", isFlex: false, isArrival: false,
    referenceLabel: "S/I No.", icon: "directions_boat",
    description: "Upload the OCR SI file from SAP. It brings the shipment's ETD and ETA." },
  { stepNo: 4, code: "SHIP_DOC", name: "Supplier send shipping document (Invoice + Packing list + BL)", shortName: "Ship Docs",
    milestone: "N4", anchorStepNo: 3, offsetDays: 15, offsetMode: "DAYS", isFlex: false, isArrival: false,
    referenceLabel: "Invoice No.", icon: "description",
    description: "Supplier sends invoice, packing list and bill of lading." },
  { stepNo: 5, code: "CLEARING", name: "Process Clearing and delivery to TP", shortName: "Clearing", milestone: "N5",
    anchorStepNo: 4, offsetDays: 5, offsetMode: "DAYS", isFlex: false, isArrival: false,
    referenceLabel: null, icon: "local_shipping",
    description: "Shipping agent clears customs and delivers to the factory." },
  { stepNo: 6, code: "DECLARATION", name: "Input Declaration", shortName: "Declaration", milestone: null,
    anchorStepNo: 5, offsetDays: 1, offsetMode: "DAYS", isFlex: false, isArrival: false,
    referenceLabel: "Declaration No.", icon: "assignment",
    description: "Key the import declaration." },
  { stepNo: 7, code: "GOODS_RECEIVED", name: "Factory good received", shortName: "Received", milestone: null,
    anchorStepNo: 5, offsetDays: 2, offsetMode: "DAYS", isFlex: false, isArrival: true,
    referenceLabel: null, icon: "warehouse",
    description: "Goods arrive at the factory. Due on the PO's Delivery date (entered at import, editable any time)." }
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
    isFlex: false,
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
  const load = async () => (await query(
    "SELECT * FROM workflow_steps WHERE section_id = @sectionId AND step_no <= @stepCount ORDER BY step_no",
    { sectionId, stepCount: STEP_COUNT }
  )).recordset;
  let rows = await load();
  if (rows.length < STEP_COUNT) {
    // A section created after install, or a partial row set: fill the gaps
    // with the defaults so the process always has all its steps.
    await insertDefaultSteps({ query }, sectionId);
    rows = await load();
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
  if (steps.filter(s => s.isArrival).length !== 1) problems.push("Exactly one step must be the arrival (ETA) step");
  return problems;
}

// Due date of every step.
//   documentDate — N1
//   actuals      — Map/obj stepNo -> actual ISO date of the steps already done
//   deliveryDate — the PO's Delivery date: the arrival step's due date when set
// A step's due date counts from its anchor's ACTUAL date once the anchor is
// done (so a late acknowledgement pushes the rest of the plan), or from the
// anchor's due date while it is still open.
// (leadTimeDays is accepted and ignored: callers may still pass it.)
function computeSchedule({ steps, documentDate, actuals = {}, settings, holidays, deliveryDate = null }) {
  const actualOf = n => (actuals instanceof Map ? actuals.get(n) : actuals[n]) || null;
  const due = {};
  for (const s of [...steps].sort((a, b) => a.stepNo - b.stepNo)) {
    if (s.stepNo === 1) {
      due[1] = documentDate;
      continue;
    }
    if (s.isArrival && deliveryDate) {
      due[s.stepNo] = deliveryDate;
      continue;
    }
    const base = actualOf(s.anchorStepNo) || due[s.anchorStepNo] || documentDate;
    if (s.offsetMode === "END_OF_MONTH") {
      due[s.stepNo] = endOfMonth(base);
    } else {
      due[s.stepNo] = shift(base, s.offsetDays, settings.dayMode, holidays);
    }
  }
  return due;
}

function arrivalStepNo(steps) {
  return (steps.find(s => s.isArrival) || steps[steps.length - 1] || { stepNo: STEP_COUNT }).stepNo;
}

// The step a file upload closes (by code, so a renamed step still works).
function stepNoOf(steps, code, fallback) {
  return steps.find(s => s.code === code)?.stepNo ?? fallback;
}

module.exports = {
  DEFAULT_STEPS,
  DONE_STEP,
  FIRST_OPEN_STEP,
  STEP_COUNT,
  arrivalStepNo,
  computeSchedule,
  getWorkflow,
  insertDefaultSteps,
  stepNoOf,
  validateWorkflow
};
