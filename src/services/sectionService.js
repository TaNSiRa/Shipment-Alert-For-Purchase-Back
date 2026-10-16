const { query } = require("../db/pool");

// Roles stack with section memberships, like RAP:
//   ADMIN          — everything, every section, system settings.
//   SECTION_ADMIN  — with is_section_admin on a membership: manages that
//                    section's users (anyone but a global ADMIN), masters,
//                    workflow and settings. Everywhere else it is a plain member.
//   USER           — imports POs and moves them through the workflow, in the
//                    sections where the membership has can_edit.
//   VIEWER         — read-only, in the sections it is a member of.
// Permissions are recomputed from the database on every request, never read
// from a token claim, so revoking access takes effect immediately.

const ROLE_CODES = ["ADMIN", "SECTION_ADMIN", "USER", "VIEWER"];

function normalizeSectionCode(value) {
  return `${value || ""}`.trim().toUpperCase();
}

function isAdmin(user) {
  return user?.roleCode === "ADMIN";
}

function isViewer(user) {
  return user?.roleCode === "VIEWER";
}

// Privilege-escalation guard: a global admin manages anyone; a section admin
// manages section admins, users and viewers — never a global admin.
function canManageTargetRole(actor, targetRoleCode) {
  if (isAdmin(actor)) return true;
  return targetRoleCode === "SECTION_ADMIN" || targetRoleCode === "USER" || targetRoleCode === "VIEWER";
}

function bit(value) {
  return value === true || value === 1;
}

function accessFor(user, row) {
  const admin = isAdmin(user);
  const viewer = isViewer(user);
  const sectionAdmin = admin || (user?.roleCode === "SECTION_ADMIN" && bit(row.is_section_admin));
  return {
    isAdmin: admin,
    isSectionAdmin: sectionAdmin,
    isViewer: viewer,
    // A viewer never writes, whatever its membership says.
    canEdit: !viewer && (admin || sectionAdmin || bit(row.can_edit))
  };
}

async function getUserSections(user) {
  if (!user?.id) return [];
  const result = await query(
    `SELECT s.id, s.code, s.name, s.description, m.can_edit, m.is_section_admin,
            (SELECT COUNT(1) FROM purchase_orders p WHERE p.section_id = s.id AND p.status = 'ACTIVE') AS active_pos,
            (SELECT COUNT(1) FROM purchase_orders p WHERE p.section_id = s.id AND p.status = 'ACTIVE'
               AND p.next_due_date < CAST(DATEADD(HOUR, 7, SYSUTCDATETIME()) AS DATE)) AS overdue_pos
     FROM sections s
     LEFT JOIN user_section_memberships m
       ON m.section_id = s.id AND m.user_id = @userId AND m.is_active = 1
     WHERE s.is_active = 1 AND (@isAdmin = 1 OR m.id IS NOT NULL)
     ORDER BY s.name`,
    { userId: user.id, isAdmin: isAdmin(user) ? 1 : 0 }
  );
  return result.recordset.map(row => ({
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description,
    activePos: row.active_pos || 0,
    overduePos: row.overdue_pos || 0,
    ...accessFor(user, row)
  }));
}

// Reads X-Section-Code, confirms an active membership, builds req.section and
// req.sectionAccess. Mount after requireAuth on every section-scoped router.
async function resolveSection(req, res, next) {
  try {
    const code = normalizeSectionCode(req.headers["x-section-code"] || req.query.sectionCode);
    if (!code) return res.status(400).json({ message: "Section is required" });
    const row = (await query(
      `SELECT TOP 1 s.id, s.code, s.name, m.id AS membership_id, m.can_edit, m.is_section_admin
       FROM sections s
       LEFT JOIN user_section_memberships m
         ON m.section_id = s.id AND m.user_id = @userId AND m.is_active = 1
       WHERE s.code = @code AND s.is_active = 1`,
      { code, userId: req.user.id }
    )).recordset[0];
    if (!row) return res.status(404).json({ message: "Section not found" });
    if (!isAdmin(req.user) && !row.membership_id) {
      return res.status(403).json({ message: "You do not have access to this section" });
    }
    req.section = { id: row.id, code: row.code, name: row.name };
    req.sectionAccess = accessFor(req.user, row);
    next();
  } catch (err) {
    next(err);
  }
}

function requireAdmin(req, res, next) {
  if (isAdmin(req.user)) return next();
  return res.status(403).json({ message: "Only a system admin can do this" });
}

// After resolveSection.
function requireSectionAdmin(req, res, next) {
  if (req.sectionAccess?.isSectionAdmin) return next();
  return res.status(403).json({ message: "Only a section admin can do this" });
}

// After resolveSection: any write to POs.
function requireEditor(req, res, next) {
  if (req.sectionAccess?.canEdit) return next();
  return res.status(403).json({ message: "Your account is read-only in this section" });
}

module.exports = {
  ROLE_CODES,
  canManageTargetRole,
  getUserSections,
  isAdmin,
  isViewer,
  normalizeSectionCode,
  requireAdmin,
  requireEditor,
  requireSectionAdmin,
  resolveSection
};
