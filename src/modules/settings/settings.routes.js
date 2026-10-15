const express = require("express");
const { z } = require("zod");
const { query } = require("../../db/pool");
const { asyncHandler } = require("../../middleware/asyncHandler");
const { writeAudit } = require("../../middleware/audit");
const { requireSectionAdmin, resolveSection } = require("../../services/sectionService");
const { SECTION_SETTINGS, getSectionSettings, setSectionSettings, settingsUpdateSchema } = require("../../services/settingsService");
const { recomputeSection, loadContext } = require("../../services/poService");
const { isMailConfigured, sendMail } = require("../../services/mailService");
const { recipientsFor, sendDailyDigest, sendMonthlyReport } = require("../../services/mailScheduler");
const { dailyDigest, monthlyReport } = require("../../services/reportService");
const { buildDailyDigestEmail, buildMonthlyReportEmail, buildTestEmail } = require("../../services/emailTemplates");
const { emitSection } = require("../../services/realtimeService");
const { todayIso } = require("../../services/dates");
const { wallTime } = require("../../services/serialize");

const router = express.Router();
router.use(resolveSection);

const SCHEDULE_KEYS = ["workflow.dayMode", "workflow.useMaterialLeadTime", "workflow.defaultLeadTimeDays", "workflow.minFlexDays"];

function audit(req, action, entityType, entityId, afterValue) {
  return writeAudit({
    actorId: req.user.id, sectionId: req.section.id, action, entityType, entityId: entityId ? `${entityId}` : null,
    afterValue, ip: req.ip, userAgent: req.headers["user-agent"]
  });
}

router.get("/", asyncHandler(async (req, res) => {
  const data = await getSectionSettings(req.section.id);
  // Members need the scheduling values; the mailing list is admin business.
  if (!req.sectionAccess.isSectionAdmin) delete data["mail.extraRecipients"];
  res.json({ data, keys: Object.keys(SECTION_SETTINGS) });
}));

router.put("/", requireSectionAdmin, asyncHandler(async (req, res) => {
  const values = settingsUpdateSchema.parse(req.body?.values || {});
  const before = await getSectionSettings(req.section.id);
  const after = await setSectionSettings(req.section.id, values, req.user.id);
  const scheduleChanged = SCHEDULE_KEYS.some(k => before[k] !== after[k]);
  const recalculated = scheduleChanged ? await recomputeSection(req.section.id) : 0;
  await audit(req, "EDIT", "SETTING", Object.keys(values).join(",").slice(0, 120), values);
  emitSection(req.section.code, "settings.updated");
  if (recalculated) emitSection(req.section.code, "po.updated");
  res.json({ data: after, recalculated });
}));

// ---- Mail --------------------------------------------------------------------

router.get("/mail/status", requireSectionAdmin, asyncHandler(async (req, res) => {
  const settings = await getSectionSettings(req.section.id);
  const recipients = await recipientsFor(req.section.id, settings);
  const lastRuns = (await query(
    `SELECT TOP 10 run_type, run_date, status, detail, created_at FROM mail_runs
     WHERE section_id = @sectionId ORDER BY created_at DESC`,
    { sectionId: req.section.id }
  )).recordset;
  res.json({
    configured: isMailConfigured(),
    enabled: settings["mail.enabled"],
    recipients,
    lastRuns: lastRuns.map(r => ({
      runType: r.run_type, runDate: new Date(r.run_date).toISOString().slice(0, 10), status: r.status, detail: r.detail, at: wallTime(r.created_at)
    }))
  });
}));

router.post("/mail/test", requireSectionAdmin, asyncHandler(async (req, res) => {
  const me = (await query("SELECT email, display_name FROM users WHERE id = @id", { id: req.user.id })).recordset[0];
  const mail = buildTestEmail({ name: me.display_name });
  const result = await sendMail({ to: me.email, subject: mail.subject, html: mail.html, sectionId: req.section.id, type: mail.type });
  await audit(req, "TEST", "MAIL", me.email, { status: result.status });
  res.json({ ...result, to: me.email });
}));

router.get("/mail/preview", requireSectionAdmin, asyncHandler(async (req, res) => {
  const ctx = await loadContext(req.section.id);
  if (req.query.kind === "monthly") {
    const month = /^\d{4}-\d{2}$/.test(`${req.query.month || ""}`) ? req.query.month : todayIso().slice(0, 7);
    const report = await monthlyReport(req.section.id, month, ctx);
    return res.json(buildMonthlyReportEmail({ sectionName: req.section.name, report }));
  }
  const digest = await dailyDigest(req.section.id, ctx);
  res.json(buildDailyDigestEmail({ sectionName: req.section.name, digest }));
}));

// Send now. "Only to me" always goes (useful before switching mail on);
// "everyone" follows the section's mail switch like the scheduler does.
router.post("/mail/send-now", requireSectionAdmin, asyncHandler(async (req, res) => {
  const input = z.object({
    kind: z.enum(["daily", "monthly"]),
    toSelf: z.boolean().default(true),
    month: z.string().regex(/^\d{4}-\d{2}$/).optional()
  }).parse(req.body);
  const me = (await query("SELECT email FROM users WHERE id = @id", { id: req.user.id })).recordset[0];
  const opts = input.toSelf ? { to: me.email, force: true } : {};
  const result = input.kind === "monthly"
    ? await sendMonthlyReport(req.section, input.month || todayIso().slice(0, 7), opts)
    : await sendDailyDigest(req.section, opts);
  await audit(req, "SEND_NOW", "MAIL", input.kind, { ...input, status: result.status, recipients: result.recipients });
  res.json(result);
}));

router.get("/outbox", requireSectionAdmin, asyncHandler(async (req, res) => {
  const rows = (await query(
    `SELECT TOP 100 id, mail_type, to_email, subject, status, error_message, created_at, sent_at
     FROM email_outbox WHERE section_id = @sectionId ORDER BY id DESC`,
    { sectionId: req.section.id }
  )).recordset;
  res.json({ data: rows.map(r => ({
    id: r.id, type: r.mail_type, to: r.to_email, subject: r.subject, status: r.status,
    error: r.status === "failed" ? `${r.error_message || ""}`.slice(0, 300) : null,
    createdAt: wallTime(r.created_at), sentAt: wallTime(r.sent_at)
  })) });
}));

router.get("/outbox/:id(\\d+)", requireSectionAdmin, asyncHandler(async (req, res) => {
  const row = (await query(
    "SELECT subject, body_html FROM email_outbox WHERE id = @id AND section_id = @sectionId",
    { id: Number(req.params.id), sectionId: req.section.id }
  )).recordset[0];
  if (!row) return res.status(404).json({ message: "Not found" });
  res.json({ subject: row.subject, html: row.body_html });
}));

// ---- Activity log ------------------------------------------------------------

router.get("/audit", requireSectionAdmin, asyncHandler(async (req, res) => {
  const pageSize = Math.min(Math.max(Number(req.query.pageSize) || 50, 1), 200);
  const page = Math.max(Number(req.query.page) || 1, 1);
  const params = { sectionId: req.section.id, offset: (page - 1) * pageSize, pageSize };
  const where = ["a.section_id = @sectionId"];
  if (req.query.q) {
    params.q = `%${`${req.query.q}`.trim().replace(/[%_[]/g, ch => `[${ch}]`)}%`;
    where.push("(a.action LIKE @q OR a.entity_type LIKE @q OR a.entity_id LIKE @q OR u.display_name LIKE @q)");
  }
  const total = (await query(`SELECT COUNT(1) AS n FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_user_id WHERE ${where.join(" AND ")}`, params)).recordset[0].n;
  const rows = (await query(
    `SELECT a.id, a.action, a.entity_type, a.entity_id, a.after_json, a.ip_address, a.created_at, u.display_name
     FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_user_id
     WHERE ${where.join(" AND ")} ORDER BY a.id DESC OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY`,
    params
  )).recordset;
  res.json({
    total, page, pageSize,
    data: rows.map(r => ({
      id: r.id, action: r.action, entityType: r.entity_type, entityId: r.entity_id, actorName: r.display_name,
      detail: r.after_json ? `${r.after_json}`.slice(0, 600) : null, ip: r.ip_address, at: wallTime(r.created_at)
    }))
  });
}));

module.exports = router;
