const bcrypt = require("bcryptjs");
const express = require("express");
const { z } = require("zod");
const { env } = require("../../config/env");
const { query } = require("../../db/pool");
const { asyncHandler } = require("../../middleware/asyncHandler");
const { writeAudit } = require("../../middleware/audit");
const { signToken } = require("../../middleware/auth");
const { bumpTokenVersion, setMustChangePassword } = require("../../services/accountState");
const { rejectWeakPassword } = require("../../services/passwordPolicy");
const { setLoggedInSession } = require("../../services/securityService");
const { getUserSections } = require("../../services/sectionService");
const { wallTime } = require("../../services/serialize");
const { findActiveUserById, sanitizeUser } = require("../auth/auth.routes");

const router = express.Router();

const editText = max => z.union([z.string().trim().max(max), z.null()]).optional();

const profileSchema = z.object({
  displayName: z.string().trim().min(1).max(150).optional(),
  fullName: editText(200),
  namePrefix: editText(20),
  department: editText(100),
  position: editText(100),
  phone: editText(50),
  receiveDailyMail: z.boolean().optional()
});

function audit(req, action, afterValue) {
  return writeAudit({ actorId: req.user.id, action, entityType: "USER", entityId: req.user.id, afterValue, ip: req.ip, userAgent: req.headers["user-agent"] });
}

async function freshUser(id) {
  const row = await findActiveUserById(id);
  const user = sanitizeUser(row);
  user.sections = await getUserSections(user);
  return user;
}

router.patch("/", asyncHandler(async (req, res) => {
  const input = profileSchema.parse(req.body);
  const columns = {
    displayName: "display_name", fullName: "full_name", namePrefix: "name_prefix",
    department: "department", position: "position", phone: "phone"
  };
  const sets = [];
  const params = { id: req.user.id };
  for (const [key, column] of Object.entries(columns)) {
    if (input[key] === undefined) continue;
    sets.push(`${column} = @${key}`);
    params[key] = input[key] === "" ? null : input[key];
  }
  if (input.receiveDailyMail !== undefined) {
    sets.push("receive_daily_mail = @receiveDailyMail");
    params.receiveDailyMail = input.receiveDailyMail ? 1 : 0;
  }
  if (sets.length) {
    await query(`UPDATE users SET ${sets.join(", ")}, updated_at = DATEADD(HOUR, 7, SYSUTCDATETIME()) WHERE id = @id`, params);
    await audit(req, "EDIT_PROFILE", input);
  }
  res.json({ user: await freshUser(req.user.id) });
}));

// Profile picture: a small square image the client has already cropped and
// downscaled. Checked here for type (by its first bytes, not its name) and size.
router.put("/avatar", asyncHandler(async (req, res) => {
  const avatar = req.body?.avatar;
  if (avatar === null || avatar === "") {
    await query("UPDATE users SET avatar = NULL, updated_at = DATEADD(HOUR, 7, SYSUTCDATETIME()) WHERE id = @id", { id: req.user.id });
    await audit(req, "REMOVE_AVATAR");
    return res.json({ user: await freshUser(req.user.id) });
  }
  const m = `${avatar || ""}`.match(/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/);
  if (!m) return res.status(400).json({ message: "The picture must be a PNG, JPEG or WebP image" });
  const bytes = Buffer.from(m[2], "base64");
  if (bytes.length > 400 * 1024) return res.status(400).json({ message: "The picture is too large (max 400 KB)" });
  const magic = {
    png: b => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
    jpeg: b => b[0] === 0xff && b[1] === 0xd8,
    webp: b => b.slice(0, 4).toString("ascii") === "RIFF" && b.slice(8, 12).toString("ascii") === "WEBP"
  };
  if (!magic[m[1]](bytes)) return res.status(400).json({ message: "The file is not really an image" });
  await query("UPDATE users SET avatar = @avatar, updated_at = DATEADD(HOUR, 7, SYSUTCDATETIME()) WHERE id = @id", { id: req.user.id, avatar });
  await audit(req, "EDIT_AVATAR");
  res.json({ user: await freshUser(req.user.id) });
}));

router.patch("/password", asyncHandler(async (req, res) => {
  const input = z.object({ currentPassword: z.string().min(1).max(256), newPassword: z.string().min(1).max(256) }).parse(req.body);
  const row = (await query("SELECT password_hash FROM users WHERE id = @id AND is_active = 1", { id: req.user.id })).recordset[0];
  if (!row || !(await bcrypt.compare(input.currentPassword, row.password_hash || ""))) {
    return res.status(400).json({ message: "Current password is incorrect" });
  }
  if (rejectWeakPassword(res, input.newPassword)) return;
  if (input.newPassword === input.currentPassword) return res.status(400).json({ message: "The new password must be different" });
  const hash = await bcrypt.hash(input.newPassword, env.bcryptRounds);
  await query("UPDATE users SET password_hash = @hash, updated_at = DATEADD(HOUR, 7, SYSUTCDATETIME()) WHERE id = @id", { id: req.user.id, hash });
  await setMustChangePassword(req.user.id, false);
  await audit(req, "CHANGE_PASSWORD");
  // Other devices are signed out; this tab gets a fresh token.
  await bumpTokenVersion(req.user.id);
  const fresh = await findActiveUserById(req.user.id);
  const csrfToken = req.session ? setLoggedInSession(req, fresh) : null;
  res.json({ ok: true, token: signToken(fresh), csrfToken });
}));

// The account's own recent security events (sign-ins, password changes).
router.get("/activity", asyncHandler(async (req, res) => {
  const rows = (await query(
    `SELECT TOP 30 action, entity_type, ip_address, user_agent, created_at FROM audit_logs
     WHERE actor_user_id = @id AND action IN ('LOGIN','MICROSOFT_LOGIN','LOGOUT','LOGIN_FAILED','LOGIN_BLOCKED','ACCOUNT_LOCKED','CHANGE_PASSWORD','EDIT_PROFILE','EDIT_AVATAR','PDPA_ACCEPT')
     ORDER BY created_at DESC`,
    { id: req.user.id }
  )).recordset;
  res.json({ data: rows.map(r => ({ action: r.action, ip: r.ip_address, userAgent: r.user_agent, at: wallTime(r.created_at) })) });
}));

// Small stats card on the profile page.
router.get("/stats", asyncHandler(async (req, res) => {
  const row = (await query(
    `SELECT
       (SELECT COUNT(1) FROM purchase_orders WHERE created_by = @id) AS pos_created,
       (SELECT COUNT(1) FROM po_steps WHERE done_by = @id AND step_no > 1) AS steps_done,
       (SELECT COUNT(1) FROM po_steps WHERE done_by = @id AND step_no > 1
          AND done_at >= DATEADD(DAY, -30, DATEADD(HOUR, 7, SYSUTCDATETIME()))) AS steps_30d`,
    { id: req.user.id }
  )).recordset[0];
  res.json({ posCreated: row.pos_created, stepsDone: row.steps_done, steps30d: row.steps_30d });
}));

module.exports = router;
