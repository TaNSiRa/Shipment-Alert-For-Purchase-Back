const express = require("express");
const { asyncHandler } = require("../../middleware/asyncHandler");
const { resolveSection } = require("../../services/sectionService");
const { loadContext } = require("../../services/poService");
const { dashboardSummary, monthlyReport, monthlyReportBuffer } = require("../../services/reportService");
const { todayIso } = require("../../services/dates");

const router = express.Router();
router.use(resolveSection);

function monthParam(value) {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(`${value || ""}`) ? `${value}` : todayIso().slice(0, 7);
}

router.get("/dashboard", asyncHandler(async (req, res) => {
  const ctx = await loadContext(req.section.id);
  res.json(await dashboardSummary(req.section.id, ctx));
}));

router.get("/monthly", asyncHandler(async (req, res) => {
  const ctx = await loadContext(req.section.id);
  res.json(await monthlyReport(req.section.id, monthParam(req.query.month), ctx));
}));

router.get("/monthly/export", asyncHandler(async (req, res) => {
  const ctx = await loadContext(req.section.id);
  const month = monthParam(req.query.month);
  const report = await monthlyReport(req.section.id, month, ctx);
  const buffer = await monthlyReportBuffer(report, req.section.name);
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="monthly-report-${req.section.code}-${month}.xlsx"`);
  res.send(Buffer.from(buffer));
}));

module.exports = router;
