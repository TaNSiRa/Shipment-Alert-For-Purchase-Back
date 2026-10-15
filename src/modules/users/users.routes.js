const bcrypt = require("bcryptjs");
const express = require("express");
const { z } = require("zod");
const { env } = require("../../config/env");
const { query, withTransaction } = require("../../db/pool");
const { asyncHandler } = require("../../middleware/asyncHandler");
const { writeAudit } = require("../../middleware/audit");
const { bumpTokenVersion, forgetAccount, setMustChangePassword } = require("../../services/accountState");
const { currentLocks } = require("../../services/loginLockout");
const { releaseAccount } = require("../../services/loginIpBlocks");
const { rejectWeakPassword } = require("../../services/passwordPolicy");
const {
  ROLE_CODES, canManageTargetRole, isAdmin, requireSectionAdmin, resolveSection
} = require("../../services/sectionService");
const { emitSection } = require("../../services/realtimeService");
const { wallTime } = require("../../services/serialize");

const router = express.Router();
router.use(resolveSection, requireSectionAdmin);

const optionalText = max => z.string().trim().max(max).optional().nullable().transform(v => (v ? v : null));

// Edit: an absent key must stay undefined (= leave the column alone); only
// an explicit empty string or null clears it.
const editText = max => z.union([z.string().trim().max(max), z.null()]).optional();

const createSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(255),
  displayName: z.string().trim().min(1).max(150),
  fullName: optionalText(200),
  namePrefix: optionalText(20),
  employeeNo: optionalText(50),
  department: optionalText(100),
  position: optionalText(100),
  phone: optionalText(50),
  roleCode: z.enum(ROLE_CODES),
  password: z.string().min(1).max(256),
  canEdit: z.boolean().default(true),
  isSectionAdmin: z.boolean().default(false)
});

const editSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(255).optional(),
  displayName: z.string().trim().min(1).max(150).optional(),
  fullName: editText(200),
  namePrefix: editText(20),
  employeeNo: editText(50),
  department: editText(100),
  position: editText(100),
  phone: editText(50),
  roleCode: z.enum(ROLE_CODES).optional(),
  isActive: z.boolean().optional()
});

function audit(req, action, entityId, afterValue) {
  return writeAudit({
    actorId: req.user.id, sectionId: req.section.id, action, entityType: "USER", entityId,
    afterValue, ip: req.ip, userAgent: req.headers["user-agent"]
  });
}

function rowOut(r, locks) {
  return {
    id: r.id,
    email: r.email,
    displayName: r.display_name,
    fullName: r.full_name,
    namePrefix: r.name_prefix,
    employeeNo: r.employee_no,
    department: r.department,
    position: r.position,
    phone: r.phone,
    avatar: r.avatar || null,
    roleCode: r.role_code,
    roleName: r.role_name,
    isActive: r.is_active === true || r.is_active === 1,
    mustChangePassword: r.must_change_password === true || r.must_change_password === 1,
    receiveDailyMail: r.receive_daily_mail === true || r.receive_daily_mail === 1,
    lastLoginAt: wallTime(r.last_login_at),
    createdAt: wallTime(r.created_at),
    lockedUntil: locks.has(Number(r.id)) ? wallTime(locks.get(Number(r.id))) : null,
    membership: r.membership_id
      ? {
        canEdit: r.can_edit === true || r.can_edit === 1,
        isSectionAdmin: r.is_section_admin === true || r.is_section_admin === 1,
        isActive: r.membership_active === true || r.membership_active === 1
      }
      : null
  };
}

const LIST_SQL = `SELECT u.*, r.code AS role_code, r.name AS role_name,
    m.id AS membership_id, m.can_edit, m.is_section_admin, m.is_active AS membership_active
  FROM users u
  JOIN roles r ON r.id = u.role_id
  LEFT JOIN user_section_memberships m ON m.user_id = u.id AND m.section_id = @sectionId`;

// A section admin sees the people in their section (never the global admins,
// whom they have no authority over); a system admin also sees every admin.
router.get("/", asyncHandler(async (req, res) => {
  const full = isAdmin(req.user) ? 1 : 0;
  const rows = (await query(
    `${LIST_SQL}
     WHERE (m.id IS NOT NULL AND m.is_active = 1 AND (@full = 1 OR r.code <> 'ADMIN'))
        OR (@full = 1 AND r.code = 'ADMIN')
     ORDER BY CASE r.code WHEN 'ADMIN' THEN 0 WHEN 'SECTION_ADMIN' THEN 1 WHEN 'USER' THEN 2 ELSE 3 END, u.display_name`,
    { sectionId: req.section.id, full }
  )).recordset;
  const locks = await currentLocks();
  res.json({ data: rows.map(r => rowOut(r, locks)) });
}));

router.get("/roles", asyncHandler(async (req, res) => {
  const rows = (await query("SELECT code, name, description FROM roles ORDER BY id")).recordset;
  res.json({ data: rows.filter(r => canManageTargetRole(req.user, r.code)) });
}));

// Existing accounts that are not in this section yet — to add someone who
// already uses the system elsewhere instead of creating a duplicate.
router.get("/lookup", asyncHandler(async (req, res) => {
  const q = `${req.query.q || ""}`.trim();
  if (q.length < 2) return res.json({ data: [] });
  const like = `%${q.replace(/[%_[]/g, ch => `[${ch}]`)}%`;
  const rows = (await query(
    `SELECT TOP 20 u.id, u.email, u.display_name, u.department, r.code AS role_code
     FROM users u JOIN roles r ON r.id = u.role_id
     WHERE u.is_active = 1 AND (u.email LIKE @like OR u.display_name LIKE @like OR u.employee_no LIKE @like)
       AND NOT EXISTS (SELECT 1 FROM user_section_memberships m WHERE m.user_id = u.id AND m.section_id = @sectionId AND m.is_active = 1)
     ORDER BY u.display_name`,
    { like, sectionId: req.section.id }
  )).recordset;
  res.json({ data: rows.filter(r => canManageTargetRole(req.user, r.role_code)).map(r => ({
    id: r.id, email: r.email, displayName: r.display_name, department: r.department, roleCode: r.role_code
  })) });
}));

async function loadTarget(req, id) {
  const row = (await query(`${LIST_SQL} WHERE u.id = @id`, { id, sectionId: req.section.id })).recordset[0];
  if (!row) throw Object.assign(new Error("User not found"), { status: 404 });
  // A section admin only reaches people who are in their section.
  if (!isAdmin(req.user) && !(row.membership_id && (row.membership_active === true || row.membership_active === 1))) {
    throw Object.assign(new Error("This user is not in your section"), { status: 403 });
  }
  if (!canManageTargetRole(req.user, row.role_code)) {
    throw Object.assign(new Error("You cannot manage this account"), { status: 403 });
  }
  return row;
}

router.post("/", asyncHandler(async (req, res) => {
  const input = createSchema.parse(req.body);
  if (!canManageTargetRole(req.user, input.roleCode)) return res.status(403).json({ message: "You cannot create this kind of account" });
  if (rejectWeakPassword(res, input.password)) return;
  const exists = (await query("SELECT id FROM users WHERE LOWER(email) = @email", { email: input.email })).recordset[0];
  if (exists) return res.status(409).json({ message: "This email is already used — use “Add existing user” instead" });
  const isSectionAdmin = isAdmin(req.user) && input.roleCode === "SECTION_ADMIN" ? input.isSectionAdmin : false;
  const hash = await bcrypt.hash(input.password, env.bcryptRounds);
  const id = await withTransaction(async tx => {
    const role = (await tx.query("SELECT id FROM roles WHERE code = @code", { code: input.roleCode })).recordset[0];
    const user = (await tx.query(
      `INSERT INTO users (email, display_name, full_name, name_prefix, employee_no, department, position, phone,
         password_hash, role_id, must_change_password)
       OUTPUT INSERTED.id
       VALUES (@email, @displayName, @fullName, @namePrefix, @employeeNo, @department, @position, @phone, @hash, @roleId, 1)`,
      { ...input, hash, roleId: role.id }
    )).recordset[0];
    await tx.query(
      `INSERT INTO user_section_memberships (user_id, section_id, can_edit, is_section_admin)
       VALUES (@userId, @sectionId, @canEdit, @isSectionAdmin)`,
      { userId: user.id, sectionId: req.section.id, canEdit: input.roleCode === "VIEWER" ? 0 : input.canEdit ? 1 : 0, isSectionAdmin: isSectionAdmin ? 1 : 0 }
    );
    return user.id;
  });
  await audit(req, "CREATE_USER", id, { ...input, password: undefined });
  emitSection(req.section.code, "users.updated");
  res.status(201).json({ id });
}));

router.patch("/:id(\\d+)", asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const input = editSchema.parse(req.body);
  const target = await loadTarget(req, id);
  if (input.roleCode && !canManageTargetRole(req.user, input.roleCode)) {
    return res.status(403).json({ message: "You cannot give this role" });
  }
  if (id === req.user.id && (input.isActive === false || (input.roleCode && input.roleCode !== target.role_code))) {
    return res.status(400).json({ message: "You cannot deactivate yourself or change your own role" });
  }
  if (input.email && input.email !== `${target.email}`.toLowerCase()) {
    const taken = (await query("SELECT id FROM users WHERE LOWER(email) = @email AND id <> @id", { email: input.email, id })).recordset[0];
    if (taken) return res.status(409).json({ message: "This email is already used by another account" });
  }
  const fields = {
    email: "email", displayName: "display_name", fullName: "full_name", namePrefix: "name_prefix", employeeNo: "employee_no",
    department: "department", position: "position", phone: "phone"
  };
  const sets = [];
  const params = { id };
  for (const [key, column] of Object.entries(fields)) {
    if (input[key] === undefined) continue;
    sets.push(`${column} = @${key}`);
    params[key] = input[key] === "" ? null : input[key];
  }
  if (input.roleCode) {
    sets.push("role_id = (SELECT id FROM roles WHERE code = @roleCode)");
    params.roleCode = input.roleCode;
  }
  if (input.isActive !== undefined) {
    sets.push("is_active = @isActive");
    params.isActive = input.isActive ? 1 : 0;
  }
  if (!sets.length) return res.json({ ok: true });
  await query(`UPDATE users SET ${sets.join(", ")}, updated_at = DATEADD(HOUR, 7, SYSUTCDATETIME()) WHERE id = @id`, params);
  // A role change or deactivation must cut off live sessions right away.
  if ((input.roleCode && input.roleCode !== target.role_code) || input.isActive === false) await bumpTokenVersion(id);
  if (input.roleCode === "VIEWER") {
    await query("UPDATE user_section_memberships SET can_edit = 0, is_section_admin = 0 WHERE user_id = @id", { id });
  }
  forgetAccount(id);
  await audit(req, "EDIT_USER", id, input);
  emitSection(req.section.code, "users.updated");
  res.json({ ok: true });
}));

router.patch("/:id(\\d+)/membership", asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const input = z.object({ canEdit: z.boolean().optional(), isSectionAdmin: z.boolean().optional() }).parse(req.body);
  const target = await loadTarget(req, id);
  if (input.isSectionAdmin !== undefined && !isAdmin(req.user)) {
    return res.status(403).json({ message: "Only a system admin can grant section admin" });
  }
  if (input.isSectionAdmin && target.role_code !== "SECTION_ADMIN") {
    return res.status(400).json({ message: "Change the role to Section Admin first" });
  }
  if (input.canEdit && target.role_code === "VIEWER") {
    return res.status(400).json({ message: "A viewer is always read-only — change the role to User to allow editing" });
  }
  await query(
    `MERGE user_section_memberships AS t
     USING (SELECT @id AS user_id, @sectionId AS section_id) AS s ON t.user_id = s.user_id AND t.section_id = s.section_id
     WHEN MATCHED THEN UPDATE SET can_edit = COALESCE(@canEdit, t.can_edit),
       is_section_admin = COALESCE(@isSectionAdmin, t.is_section_admin), is_active = 1
     WHEN NOT MATCHED THEN INSERT (user_id, section_id, can_edit, is_section_admin)
       VALUES (@id, @sectionId, COALESCE(@canEdit, 1), COALESCE(@isSectionAdmin, 0));`,
    {
      id, sectionId: req.section.id,
      canEdit: input.canEdit === undefined ? null : input.canEdit ? 1 : 0,
      isSectionAdmin: input.isSectionAdmin === undefined ? null : input.isSectionAdmin ? 1 : 0
    }
  );
  await audit(req, "EDIT_MEMBERSHIP", id, input);
  emitSection(req.section.code, "users.updated");
  res.json({ ok: true });
}));

router.post("/:id(\\d+)/join", asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const row = (await query(
    "SELECT u.id, r.code AS role_code FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = @id AND u.is_active = 1",
    { id }
  )).recordset[0];
  if (!row) return res.status(404).json({ message: "User not found" });
  if (!canManageTargetRole(req.user, row.role_code)) return res.status(403).json({ message: "You cannot add this account" });
  const canEdit = req.body?.canEdit === false || row.role_code === "VIEWER" ? 0 : 1;
  await query(
    `MERGE user_section_memberships AS t
     USING (SELECT @id AS user_id, @sectionId AS section_id) AS s ON t.user_id = s.user_id AND t.section_id = s.section_id
     WHEN MATCHED THEN UPDATE SET is_active = 1, can_edit = @canEdit
     WHEN NOT MATCHED THEN INSERT (user_id, section_id, can_edit) VALUES (@id, @sectionId, @canEdit);`,
    { id, sectionId: req.section.id, canEdit }
  );
  await audit(req, "ADD_TO_SECTION", id, { canEdit: Boolean(canEdit) });
  emitSection(req.section.code, "users.updated");
  res.json({ ok: true });
}));

router.delete("/:id(\\d+)/membership", asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) return res.status(400).json({ message: "You cannot remove yourself from the section" });
  await loadTarget(req, id);
  await query(
    "UPDATE user_section_memberships SET is_active = 0, is_section_admin = 0 WHERE user_id = @id AND section_id = @sectionId",
    { id, sectionId: req.section.id }
  );
  await audit(req, "REMOVE_FROM_SECTION", id);
  emitSection(req.section.code, "users.updated");
  res.json({ ok: true });
}));

router.post("/:id(\\d+)/reset-password", asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const input = z.object({ newPassword: z.string().min(1).max(256) }).parse(req.body);
  await loadTarget(req, id);
  if (rejectWeakPassword(res, input.newPassword)) return;
  const hash = await bcrypt.hash(input.newPassword, env.bcryptRounds);
  await query(
    `UPDATE users SET password_hash = @hash, failed_login_count = 0, login_locked_until = NULL,
       updated_at = DATEADD(HOUR, 7, SYSUTCDATETIME()) WHERE id = @id`,
    { id, hash }
  );
  // The person must pick their own password at the next sign-in, and every
  // session they have open is signed out now.
  if (id !== req.user.id) await setMustChangePassword(id, true);
  await bumpTokenVersion(id);
  await audit(req, "RESET_PASSWORD", id);
  res.json({ ok: true });
}));

router.post("/:id(\\d+)/unlock", asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  await loadTarget(req, id);
  const ips = await releaseAccount(id);
  await audit(req, "UNLOCK_ACCOUNT", id, { releasedIps: ips });
  res.json({ ok: true });
}));

module.exports = router;
