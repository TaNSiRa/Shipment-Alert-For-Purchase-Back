// Pure date / schedule maths — no database.
process.env.SQL_DATABASE = "Purchase_Alert_Test";
const test = require("node:test");
const assert = require("node:assert/strict");
const dates = require("../src/services/dates");
const { DEFAULT_STEPS, computeSchedule, flexOffsetFor, validateWorkflow } = require("../src/services/workflowService");
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

test("the Excel example (fixed offsets) reproduces the sheet's dates", () => {
  const due = computeSchedule({
    steps: DEFAULT_STEPS,
    documentDate: "2026-03-05",
    leadTimeDays: null,
    actuals: { 1: "2026-03-05" },
    settings: { ...sched, useMaterialLeadTime: false },
    holidays: new Set()
  });
  assert.equal(due[2], "2026-03-20"); // N1+15
  assert.equal(due[3], "2026-03-20");
  assert.equal(due[4], "2026-04-29"); // N2+40
  assert.equal(due[6], "2026-05-09"); // N3+10
  assert.equal(due[7], "2026-05-16"); // N4+7
  assert.equal(due[8], "2026-05-17"); // N5+1
  assert.equal(due[9], "2026-05-18"); // N5+2 = arrival, the last step
  assert.equal(due[10], undefined);
});

test("material lead time stretches the S/I step so arrival = PO date + lead time", () => {
  assert.equal(flexOffsetFor(DEFAULT_STEPS, 76, sched), 42);
  assert.equal(flexOffsetFor(DEFAULT_STEPS, 150, sched), 116);
  assert.equal(flexOffsetFor(DEFAULT_STEPS, 30, sched), 5); // never below minFlexDays
  const due = computeSchedule({
    steps: DEFAULT_STEPS, documentDate: "2026-02-18", leadTimeDays: 76, actuals: { 1: "2026-02-18" },
    settings: sched, holidays: new Set()
  });
  assert.equal(due[9], dates.addDays("2026-02-18", 76));
});

test("an actual date re-plans everything after it", () => {
  const base = { steps: DEFAULT_STEPS, documentDate: "2026-03-05", leadTimeDays: 76, settings: sched, holidays: new Set() };
  const plan = computeSchedule({ ...base, actuals: { 1: "2026-03-05" } });
  const late = computeSchedule({ ...base, actuals: { 1: "2026-03-05", 2: "2026-03-30" } }); // ACK 10 days late
  assert.equal(late[3], "2026-03-30");
  assert.equal(dates.diffDays(plan[9], late[9]), 10);
});

test("workflow validation", () => {
  assert.deepEqual(validateWorkflow(DEFAULT_STEPS), []);
  const bad = DEFAULT_STEPS.map(s => (s.stepNo === 5 ? { ...s, anchorStepNo: 7 } : s));
  assert.match(validateWorkflow(bad)[0], /earlier step/);
  const twoFlex = DEFAULT_STEPS.map(s => (s.stepNo === 6 ? { ...s, isFlex: true } : s));
  assert.ok(validateWorkflow(twoFlex).some(p => /Only one step/.test(p)));
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
