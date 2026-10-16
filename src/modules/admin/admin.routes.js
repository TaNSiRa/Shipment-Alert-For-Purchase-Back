const express = require("express");
const { z } = require("zod");
const { env } = require("../../config/env");
const { query } = require("../../db/pool");
const { holidayDbSettings, listExternalHolidays, saveHolidayDbSettings, verifyHoliday } = require("../../db/holidayPool");
const { asyncHandler } = require("../../middleware/asyncHandler");
const { writeAudit } = require("../../middleware/audit");
const { requireAdmin } = require("../../services/sectionService");
const { insertDefaultSteps } = require("../../services/workflowService");
const { isMailConfigured, verifyMail } = require("../../services/mailService");
const { emitAll } = require("../../services/realtimeService");
const { isIsoDate, toIso, todayIso } = require("../../services/dates");
const { wallTime } = require("../../services/serialize");

// System-admin only: sections, company holidays, system status, global log.
const router = express.Router();
router.use(requireAdmin);

function audit(req, action, entityType, entityId, afterValue) {
  return writeAudit({
    actorId: req.user.id, action, entityType, entityId: entityId ? `${entityId}` : null,
    afterValue, ip: req.ip, userAgent: req.headers["user-agent"]
  });
}

router.get("/system", asyncHandler(async (req, res) => {
  const counts = (await query(
    `SELECT (SELECT COUNT(1) FROM users WHERE is_active = 1) AS users,
            (SELECT COUNT(1) FROM sections WHERE is_active = 1) AS sections,
            (SELECT COUNT(1) FROM purchase_orders) AS pos,
            (SELECT COUNT(1) FROM purchase_orders WHERE status = 'ACTIVE') AS active_pos,
            (SELECT COUNT(1) FROM suppliers) AS suppliers,
            (SELECT COUNT(1) FROM materials) AS materials,
            (SELECT COUNT(1) FROM email_outbox WHERE status = 'failed'
               AND created_at > DATEADD(DAY, -7, DATEADD(HOUR, 7, SYSUTCDATETIME()))) AS failed_mail_7d`
  )).recordset[0];
  res.json({
    database: env.sql.database,
    mailConfigured: isMailConfigured(),
    smtpHost: env.smtp.host || null,
    smtpFrom: env.smtp.from || null,
    schedulerEnabled: env.mailSchedulerEnabled,
    appPublicUrl: env.appPublicUrl || null,
    sessionIdleMinutes: env.session.idleTimeoutMinutes,
    nodeEnv: env.nodeEnv,
    counts
  });
}));

router.get("/mail/verify", asyncHandler(async (req, res) => {
  res.json(await verifyMail());
}));

// ---- Sections ----------------------------------------------------------------

router.get("/sections", asyncHandler(async (req, res) => {
  const rows = (await query(
    `SELECT s.*,
       (SELECT COUNT(1) FROM user_section_memberships m WHERE m.section_id = s.id AND m.is_active = 1) AS members,
       (SELECT COUNT(1) FROM purchase_orders p WHERE p.section_id = s.id AND p.status = 'ACTIVE') AS active_pos
     FROM sections s ORDER BY s.name`
  )).recordset;
  res.json({ data: rows.map(r => ({
    id: r.id, code: r.code, name: r.name, description: r.description, isActive: r.is_active === true || r.is_active === 1,
    members: r.members, activePos: r.active_pos, createdAt: wallTime(r.created_at)
  })) });
}));

const sectionSchema = z.object({
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9_-]{2,30}$/, "Code: 2–30 letters, digits, - or _"),
  name: z.string().trim().min(1).max(120),
  description: z.union([z.string().trim().max(255), z.null()]).optional(),
  isActive: z.boolean().optional()
});

router.post("/sections", asyncHandler(async (req, res) => {
  const input = sectionSchema.parse(req.body);
  const dup = (await query("SELECT id FROM sections WHERE code = @code", { code: input.code })).recordset[0];
  if (dup) return res.status(409).json({ message: `Section ${input.code} already exists` });
  const row = (await query(
    "INSERT INTO sections (code, name, description) OUTPUT INSERTED.id VALUES (@code, @name, @description)",
    { ...input, description: input.description || null }
  )).recordset[0];
  await insertDefaultSteps({ query }, row.id);
  // The admin who made it is in it, so it shows up in their section list.
  await query(
    "INSERT INTO user_section_memberships (user_id, section_id, can_edit, is_section_admin) VALUES (@userId, @sectionId, 1, 1)",
    { userId: req.user.id, sectionId: row.id }
  );
  await audit(req, "CREATE", "SECTION", input.code, input);
  emitAll("sections.updated");
  res.status(201).json({ id: row.id });
}));

router.patch("/sections/:id(\\d+)", asyncHandler(async (req, res) => {
  const input = sectionSchema.omit({ code: true }).parse(req.body);
  const r = await query(
    `UPDATE sections SET name = @name, description = @description, is_active = COALESCE(@isActive, is_active) WHERE id = @id`,
    { id: Number(req.params.id), name: input.name, description: input.description || null, isActive: input.isActive === undefined ? null : input.isActive ? 1 : 0 }
  );
  if (!r.rowsAffected[0]) return res.status(404).json({ message: "Section not found" });
  await audit(req, "EDIT", "SECTION", req.params.id, input);
  emitAll("sections.updated");
  res.json({ ok: true });
}));

// ---- Holidays ----------------------------------------------------------------

// One year's holidays from both sources: the days added here (removable) and
// the holiday database's (read-only — it is shared with RAP).
router.get("/holidays", asyncHandler(async (req, res) => {
  const year = Number(req.query.year) || Number(todayIso().slice(0, 4));
  const rows = (await query(
    "SELECT id, holiday_date, name FROM holidays WHERE YEAR(holiday_date) = @year ORDER BY holiday_date",
    { year }
  )).recordset;
  const local = rows.map(r => ({ id: r.id, date: toIso(r.holiday_date), name: r.name, source: "local" }));
  const external = await listExternalHolidays(`${year}-01-01`, `${year}-12-31`);
  const localDates = new Set(local.map(h => h.date));
  const data = [
    ...local,
    ...external.rows.filter(h => !localDates.has(h.date)).map(h => ({ id: null, ...h, source: "external" }))
  ].sort((a, b) => a.date.localeCompare(b.date));
  res.json({ year, externalConfigured: external.configured, data });
}));

router.post("/holidays", asyncHandler(async (req, res) => {
  const items = z.array(z.object({
    date: z.string().refine(isIsoDate, "Invalid date"),
    name: z.string().trim().max(150).optional().default("")
  })).min(1).max(100).parse(Array.isArray(req.body) ? req.body : [req.body])
    .map(h => ({ ...h, name: h.name || "Company holiday" }));
  let added = 0;
  for (const h of items) {
    const r = await query(
      `IF NOT EXISTS (SELECT 1 FROM holidays WHERE holiday_date = @date)
       INSERT INTO holidays (holiday_date, name) VALUES (@date, @name)`,
      h
    );
    added += r.rowsAffected?.[0] || 0;
  }
  if (!added) return res.status(409).json({ message: items.length === 1 ? `${items[0].date} is already a holiday` : "These days are already holidays" });
  await audit(req, "CREATE", "HOLIDAY", items.map(i => i.date).join(",").slice(0, 120), items);
  emitAll("settings.updated");
  res.json({ ok: true, added });
}));

router.delete("/holidays/:id(\\d+)", asyncHandler(async (req, res) => {
  const r = await query("DELETE FROM holidays WHERE id = @id", { id: Number(req.params.id) });
  if (!r.rowsAffected[0]) return res.status(404).json({ message: "Holiday not found" });
  await audit(req, "DELETE", "HOLIDAY", req.params.id);
  res.json({ ok: true });
}));

// External holiday DB (SAR · Master_Holiday), as in RAP. Credentials stay in
// .env; host/database/table/enabled are edited here.
router.get("/holiday-db", asyncHandler(async (req, res) => {
  res.json(await holidayDbSettings());
}));

router.put("/holiday-db", asyncHandler(async (req, res) => {
  const ident = z.string().trim().max(128).regex(/^[A-Za-z0-9_]*$/, "Letters, digits and _ only");
  const input = z.object({
    host: z.string().trim().max(255).regex(/^[A-Za-z0-9._\\:-]*$/, "Not a valid host"),
    database: ident,
    table: ident,
    enabled: z.boolean()
  }).parse(req.body);
  await saveHolidayDbSettings(input, req.user.id);
  await audit(req, "EDIT", "HOLIDAY_DB", null, input);
  res.json(await holidayDbSettings());
}));

router.get("/holiday-db/verify", asyncHandler(async (req, res) => {
  res.json(await verifyHoliday());
}));

// ---- Whole-system activity log -------------------------------------------------

router.get("/audit", asyncHandler(async (req, res) => {
  const pageSize = Math.min(Math.max(Number(req.query.pageSize) || 50, 1), 200);
  const page = Math.max(Number(req.query.page) || 1, 1);
  const params = { offset: (page - 1) * pageSize, pageSize };
  const where = ["1 = 1"];
  if (req.query.q) {
    params.q = `%${`${req.query.q}`.trim().replace(/[%_[]/g, ch => `[${ch}]`)}%`;
    where.push("(a.action LIKE @q OR a.entity_type LIKE @q OR a.entity_id LIKE @q OR u.display_name LIKE @q OR a.ip_address LIKE @q)");
  }
  if (req.query.security === "true") {
    where.push("a.action IN ('LOGIN','LOGIN_FAILED','MICROSOFT_LOGIN','MICROSOFT_LOGIN_FAILED','ACCOUNT_LOCKED','LOGIN_BLOCKED','LOGOUT','CHANGE_PASSWORD','RESET_PASSWORD','UNLOCK_ACCOUNT','UNBLOCK_LOGIN','UNBLOCK_LOGIN_ALL')");
  }
  const total = (await query(`SELECT COUNT(1) AS n FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_user_id WHERE ${where.join(" AND ")}`, params)).recordset[0].n;
  const rows = (await query(
    `SELECT a.id, a.action, a.entity_type, a.entity_id, a.after_json, a.ip_address, a.created_at, u.display_name, s.code AS section_code
     FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_user_id LEFT JOIN sections s ON s.id = a.section_id
     WHERE ${where.join(" AND ")} ORDER BY a.id DESC OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY`,
    params
  )).recordset;
  res.json({
    total, page, pageSize,
    data: rows.map(r => ({
      id: r.id, action: r.action, entityType: r.entity_type, entityId: r.entity_id, actorName: r.display_name,
      sectionCode: r.section_code, detail: r.after_json ? `${r.after_json}`.slice(0, 600) : null, ip: r.ip_address, at: wallTime(r.created_at)
    }))
  });
}));

module.exports = router;
