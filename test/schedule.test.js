// Pure date / schedule maths — no database.
process.env.SQL_DATABASE = "Purchase_Alert_Test";
const test = require("node:test");
const assert = require("node:assert/strict");
const dates = require("../src/services/dates");
const { DEFAULT_STEPS, computeSchedule, validateWorkflow } = require("../src/services/workflowService");
const { toDate } = require("../src/services/excelKit");
const { detectShipMode, splitSupplier } = require("../src/services/poImport");

const sched = { dayMode: "CALENDAR", useMaterialLeadTime: true, defaultLeadTimeDays: 75, minFlexDays: 5 };

test("calendar arithmetic", () => {
  assert.equal(dates.addDays("2026-03-05", 15), "2026-03-20");
  assert.equal(dates.addDays("2026-12-25", 10), "2027-01-04");
  assert.equal(dates.diffDays("2026-03-05", "2026-03-20"), 15);
  assert.equal(dates.endOfMonth("2026-02-10"), "2026-02-28");
  assert.equal(dates.endOfMonth("2028-02-10"), "2028-02-29");
});

test("working-day arithmetic skips weekends and holidays", () => {
  // 2026-10-16 is a Friday.
  assert.equal(dates.addWorkingDays("2026-10-16", 1, new Set()), "2026-10-19");
  assert.equal(dates.addWorkingDays("2026-10-16", 1, new Set(["2026-10-19"])), "2026-10-20");
  assert.equal(dates.addWorkingDays("2026-10-16", 0, new Set()), "2026-10-16");
  assert.equal(dates.lastWorkingDayOfMonth("2026-10-01", new Set()), "2026-10-30"); // 31st is Saturday
  assert.equal(dates.isWorkingDay("2026-10-17", new Set()), false);
});

test("the meeting's plan (fixed offsets) reproduces the sheet's dates", () => {
  const due = computeSchedule({
    steps: DEFAULT_STEPS,
    documentDate: "2026-03-05",
    leadTimeDays: null,
    actuals: { 1: "2026-03-05" },
    settings: { ...sched, useMaterialLeadTime: false },
    holidays: new Set()
  });
  assert.equal(DEFAULT_STEPS.length, 7);
  assert.equal(due[2], "2026-03-15"); // N1+10  OCR ACK
  assert.equal(due[3], "2026-04-04"); // N2+20  OCR S/I
  assert.equal(due[4], "2026-04-19"); // N3+15  shipping documents
  assert.equal(due[5], "2026-04-24"); // N4+5   clearing
  assert.equal(due[6], "2026-04-25"); // N5+1   declaration
  assert.equal(due[7], "2026-04-26"); // fallback N5+2 when there is no Delivery date
  assert.equal(due[8], undefined);
});

test("step 7 is due on the Delivery date, whatever the other steps do", () => {
  const base = { steps: DEFAULT_STEPS, documentDate: "2026-03-05", leadTimeDays: 76, settings: sched, holidays: new Set(), deliveryDate: "2026-06-01" };
  assert.equal(computeSchedule({ ...base, actuals: { 1: "2026-03-05" } })[7], "2026-06-01");
  assert.equal(computeSchedule({ ...base, actuals: { 1: "2026-03-05", 2: "2026-04-30" } })[7], "2026-06-01");
});

test("material lead time never changes the plan — only the workflow's lead times do", () => {
  const base = { steps: DEFAULT_STEPS, documentDate: "2026-02-18", actuals: { 1: "2026-02-18" }, settings: sched, holidays: new Set() };
  const short = computeSchedule({ ...base, leadTimeDays: 30 });
  const long = computeSchedule({ ...base, leadTimeDays: 150 });
  assert.deepEqual(short, long);
  // Even a step still flagged "flex" in old data keeps its own offset.
  const flexed = DEFAULT_STEPS.map(s => (s.stepNo === 3 ? { ...s, isFlex: true } : s));
  assert.deepEqual(computeSchedule({ ...base, steps: flexed, leadTimeDays: 150 }), short);
  assert.equal(short[7], dates.addDays("2026-02-18", 10 + 20 + 15 + 5 + 2)); // fallback without a Delivery date
});

test("an actual date re-plans everything after it", () => {
  const base = { steps: DEFAULT_STEPS, documentDate: "2026-03-05", leadTimeDays: 76, settings: sched, holidays: new Set() };
  const plan = computeSchedule({ ...base, actuals: { 1: "2026-03-05" } });
  const late = computeSchedule({ ...base, actuals: { 1: "2026-03-05", 2: "2026-03-25" } }); // ACK 10 days late
  assert.equal(late[3], "2026-04-14");
  assert.equal(dates.diffDays(plan[6], late[6]), 10);
});

test("workflow validation", () => {
  assert.deepEqual(validateWorkflow(DEFAULT_STEPS), []);
  const bad = DEFAULT_STEPS.map(s => (s.stepNo === 5 ? { ...s, anchorStepNo: 6 } : s));
  assert.match(validateWorkflow(bad)[0], /earlier step/);
  const twoArrivals = DEFAULT_STEPS.map(s => (s.stepNo === 6 ? { ...s, isArrival: true } : s));
  assert.ok(validateWorkflow(twoArrivals).some(p => /arrival/.test(p)));
});

test("Excel cell parsing", () => {
  assert.equal(toDate(new Date(Date.UTC(2026, 1, 18))), "2026-02-18");
  assert.equal(toDate("18.02.2026"), "2026-02-18");
  assert.equal(toDate("18/02/2569"), "2026-02-18"); // Buddhist year
  assert.equal(toDate("2026-02-18"), "2026-02-18");
  assert.equal(toDate(46071), "2026-02-18"); // Excel serial
  assert.equal(toDate("31/02/2026"), null);
  assert.deepEqual(splitSupplier("12200003   NIHON PARKERIZING CO.,LT"), { code: "12200003", name: "NIHON PARKERIZING CO.,LT" });
  assert.equal(detectShipMode(null, "NOX-RUST 1028BJ|(BY SEA) 190L"), "SEA");
  assert.equal(detectShipMode(null, "LAB KIT (BY AIR)"), "AIR");
});
