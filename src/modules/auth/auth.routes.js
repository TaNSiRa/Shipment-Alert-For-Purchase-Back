const bcrypt = require("bcryptjs");
const express = require("express");
const rateLimit = require("express-rate-limit");
const { z } = require("zod");
const { env } = require("../../config/env");
const { query } = require("../../db/pool");
const { asyncHandler } = require("../../middleware/asyncHandler");
const { requireAuth, signToken } = require("../../middleware/auth");
const { writeAudit } = require("../../middleware/audit");
const { clearSession, regenerateSession, setLoggedInSession } = require("../../services/securityService");
const { bumpTokenVersion, setMustChangePassword } = require("../../services/accountState");
const { rejectWeakPassword } = require("../../services/passwordPolicy");
const { getUserSections, requireAdmin } = require("../../services/sectionService");
const { POLICY_VERSION, hasCurrentConsent } = require("../../services/pdpa");
const { MAX_FAILURES, LOCK_MINUTES, lockedUntil, recordFailure, recordSuccess } = require("../../services/loginLockout");
const {
  listBlockedIps, listLockedAccounts, noteBlocked, noteIfExhausted, registerLimiter,
  releaseAccount, releaseEverything, releaseIpAndAccounts
} = require("../../services/loginIpBlocks");
const { sendMail } = require("../../services/mailService");
const { buildAccountLockedEmail } = require("../../services/emailTemplates");
const { thaiWallNow } = require("../../services/thaiTime");
const microsoft = require("../../services/microsoftAuth");
const { wallTime } = require("../../services/serialize");

const router = express.Router();

// 5 FAILED attempts / 15 min / IP. Successes are not counted, so a person who
// signs in normally is never throttled.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: env.loginRateLimitMax,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: { message: "Too many login attempts. Please wait a few minutes and try again." },
  handler: (req, res, next, options) => {
    noteBlocked(req);
    res.status(options.statusCode).json(options.message);
  }
});
registerLimiter(loginLimiter);

const loginSchema = z.object({ email: z.string().min(1).max(255), password: z.string().min(1).max(256) });

const USER_SELECT = `SELECT TOP 1 u.*, r.code AS role_code, r.name AS role_name
  FROM users u JOIN roles r ON r.id = u.role_id`;

async function findActiveUserByIdentifier(identifier) {
  const value = `${identifier || ""}`.trim();
  return (await query(
    `${USER_SELECT}
     WHERE (LOWER(u.email) = LOWER(@value) OR LTRIM(RTRIM(u.employee_no)) = @value) AND u.is_active = 1
     ORDER BY CASE WHEN LOWER(u.email) = LOWER(@value) THEN 0 ELSE 1 END, u.id`,
    { value }
  )).recordset[0] || null;
}

async function findActiveUserById(id) {
  return (await query(`${USER_SELECT} WHERE u.id = @id AND u.is_active = 1`, { id })).recordset[0] || null;
}

function sanitizeUser(user) {
  return {
    id: user.id,
    employeeNo: user.employee_no,
    email: user.email,
    displayName: user.display_name,
    fullName: user.full_name,
    namePrefix: user.name_prefix,
    department: user.department,
    position: user.position,
    phone: user.phone,
    avatar: user.avatar ?? null,
    roleCode: user.role_code,
    roleName: user.role_name,
    receiveDailyMail: user.receive_daily_mail === true || user.receive_daily_mail === 1,
    lastLoginAt: wallTime(user.last_login_at),
    createdAt: wallTime(user.created_at),
    pdpaConsentAccepted: hasCurrentConsent(user),
    pdpaConsentAt: wallTime(user.pdpa_consent_at),
    mustChangePassword: user.must_change_password === true || user.must_change_password === 1
  };
}

async function withSections(user) {
  user.sections = await getUserSections(user);
  return user;
}

async function completeLogin(req, user) {
  await query("UPDATE users SET last_login_at = DATEADD(HOUR, 7, SYSUTCDATETIME()) WHERE id = @id", { id: user.id });
  // New session id for the new sign-in (no session fixation).
  await regenerateSession(req);
  const csrfToken = setLoggedInSession(req, user);
  return { token: signToken(user), csrfToken, user: await withSections(sanitizeUser(user)) };
}

async function notifyAccountLocked(user, until, req) {
  const to = `${user.email || ""}`.trim();
  if (!to) return;
  try {
    const mail = buildAccountLockedEmail({
      greetingName: user.display_name || to,
      lockedUntil: until,
      lockMinutes: LOCK_MINUTES,
      failures: MAX_FAILURES,
      ip: req.ip
    });
    await sendMail({ to, subject: mail.subject, html: mail.html, type: mail.type });
  } catch (err) {
    console.error(`[auth] account-locked mail failed: ${err.message}`);
  }
}

router.post("/login", loginLimiter, asyncHandler(async (req, res) => {
  const input = loginSchema.parse(req.body);
  const user = await findActiveUserByIdentifier(input.email);
  const passwordOk = Boolean(user) && await bcrypt.compare(input.password, user.password_hash || "");
  const meta = { ip: req.ip, userAgent: req.headers["user-agent"] };
  const typed = `${input.email || ""}`.slice(0, 100);

  // A locked account is refused even with the right password. Only the right
  // password learns that it is locked; a guesser always sees the generic line.
  const locked = user ? lockedUntil(user) : null;
  if (locked && passwordOk) {
    const minutes = Math.max(1, Math.ceil((locked.getTime() - thaiWallNow().getTime()) / 60000));
    await writeAudit({ actorId: user.id, action: "LOGIN_BLOCKED", entityType: "AUTH", entityId: typed, ...meta });
    noteIfExhausted(req);
    return res.status(401).json({
      message: `Too many failed sign-ins. This account is locked for another ${minutes} minute${minutes === 1 ? "" : "s"}.`
    });
  }
  if (!passwordOk) {
    await writeAudit({
      actorId: user ? user.id : null, action: "LOGIN_FAILED", entityType: "AUTH", entityId: typed,
      afterValue: { reason: user ? "BAD_PASSWORD" : "NO_SUCH_ACTIVE_USER" }, ...meta
    });
    if (user) {
      const state = await recordFailure(user.id);
      if (state.locked) {
        await writeAudit({ actorId: user.id, action: "ACCOUNT_LOCKED", entityType: "AUTH", entityId: typed, ...meta });
        if (!locked) await notifyAccountLocked(user, state.until, req);
      }
    }
    noteIfExhausted(req);
    return res.status(401).json({ message: "Invalid email / employee no. or password" });
  }
  await recordSuccess(user.id);
  await writeAudit({ actorId: user.id, action: "LOGIN", entityType: "AUTH", ...meta });
  res.json(await completeLogin(req, user));
}));

// --- Sign in with Microsoft 365 (see services/microsoftAuth.js) -------------

function requireMicrosoft(req, res, next) {
  if (!microsoft.isMicrosoftEnabled()) return res.status(404).json({ message: "Microsoft sign-in is not configured" });
  next();
}

router.get("/microsoft/start", requireMicrosoft, (req, res) => {
  const returnTo = microsoft.safeReturnTo(req.query.returnTo, req);
  res.redirect(302, microsoft.beginSignIn(req, res, returnTo));
});

// Every way out of the callback is a redirect back to the app — the person is
// mid-navigation in a full browser tab, not in an API call. Failures carry
// only a code; the details go to the audit log and the server console.
router.get("/microsoft/callback", requireMicrosoft, asyncHandler(async (req, res) => {
  const meta = { ip: req.ip, userAgent: req.headers["user-agent"] };
  const pending = microsoft.takePending(req, res, `${req.query.state || ""}`);
  const back = params => res.redirect(302, microsoft.withParams(
    pending?.returnTo || microsoft.safeReturnTo(null, req), params));

  if (!pending) return back({ ms_error: "EXPIRED" });
  if (req.query.error) {
    // access_denied = the person pressed Cancel / has no consent; nothing to log.
    return back({ ms_error: req.query.error === "access_denied" ? "CANCELLED" : "MICROSOFT_ERROR" });
  }
  if (!req.query.code) return back({ ms_error: "MICROSOFT_ERROR" });

  let email;
  try {
    const idToken = await microsoft.redeemCode(`${req.query.code}`, pending.verifier);
    const claims = await microsoft.verifyIdToken(idToken, { nonce: pending.nonce });
    email = microsoft.emailFromClaims(claims);
  } catch (err) {
    console.error(`[auth] Microsoft sign-in failed: ${err.message}`);
    await writeAudit({ actorId: null, action: "LOGIN_FAILED", entityType: "AUTH", entityId: "microsoft",
      afterValue: { reason: err.code || "MICROSOFT_ERROR", method: "MICROSOFT" }, ...meta });
    return back({ ms_error: "MICROSOFT_ERROR" });
  }

  const user = email ? await findActiveUserByIdentifier(email) : null;
  // Only an exact email match counts — the identifier lookup also accepts an
  // employee number, which a Microsoft account must never be matched by.
  if (!user || `${user.email || ""}`.trim().toLowerCase() !== email) {
    await writeAudit({ actorId: null, action: "LOGIN_FAILED", entityType: "AUTH", entityId: `${email || "?"}`.slice(0, 100),
      afterValue: { reason: "NO_SUCH_ACTIVE_USER", method: "MICROSOFT" }, ...meta });
    return back({ ms_error: "NOT_REGISTERED" });
  }
  if (lockedUntil(user)) {
    await writeAudit({ actorId: user.id, action: "LOGIN_BLOCKED", entityType: "AUTH", entityId: email,
      afterValue: { method: "MICROSOFT" }, ...meta });
    return back({ ms_error: "LOCKED" });
  }
  back({ ms_ticket: microsoft.issueTicket(res, user.id) });
}));

router.post("/microsoft/exchange", loginLimiter, requireMicrosoft, asyncHandler(async (req, res) => {
  const { ticket } = z.object({ ticket: z.string().min(1).max(200) }).parse(req.body);
  const userId = microsoft.redeemTicket(req, res, ticket);
  const user = userId ? await findActiveUserById(userId) : null;
  if (!user || lockedUntil(user)) {
    noteIfExhausted(req);
    return res.status(401).json({ message: "Microsoft sign-in expired. Please try again." });
  }
  await recordSuccess(user.id);
  await writeAudit({ actorId: user.id, action: "LOGIN", entityType: "AUTH", afterValue: { method: "MICROSOFT" },
    ip: req.ip, userAgent: req.headers["user-agent"] });
  res.json(await completeLogin(req, user));
}));

router.post("/logout", requireAuth, asyncHandler(async (req, res) => {
  await writeAudit({ actorId: req.user.id, action: "LOGOUT", entityType: "AUTH", ip: req.ip, userAgent: req.headers["user-agent"] });
  await bumpTokenVersion(req.user.id);
  clearSession(req, res, () => res.json({ ok: true }));
}));

router.get("/me", requireAuth, asyncHandler(async (req, res) => {
  const row = await findActiveUserById(req.user.id);
  if (!row) return res.status(401).json({ message: "Unauthorized" });
  res.json({ user: await withSections(sanitizeUser(row)) });
}));

// Page refresh: the httpOnly session cookie proves who this is and a fresh
// JWT is issued (the JWT itself only ever lives in the app's memory).
router.get("/session", requireAuth, asyncHandler(async (req, res) => {
  const row = await findActiveUserById(req.user.id);
  if (!row) return res.status(401).json({ message: "Unauthorized" });
  if (req.session && !req.session.csrfToken && req.session.user) setLoggedInSession(req, row);
  res.json({ token: signToken(row), user: await withSections(sanitizeUser(row)), csrfToken: req.session?.csrfToken || null });
}));

router.get("/sections", requireAuth, asyncHandler(async (req, res) => {
  res.json({ data: await getUserSections(req.user) });
}));

// Re-issues the rolling session cookie while someone is actively using the
// app without saving anything (reading a long PO, filling a form).
router.get("/keepalive", requireAuth, (req, res) => res.json({ ok: true }));

router.post("/pdpa-consent", requireAuth, asyncHandler(async (req, res) => {
  await query(
    `UPDATE users SET pdpa_consent_accepted = 1, pdpa_consent_at = DATEADD(HOUR, 7, SYSUTCDATETIME()),
       pdpa_consent_ip = @ip, pdpa_consent_user_agent = @userAgent, pdpa_policy_version = @version,
       updated_at = DATEADD(HOUR, 7, SYSUTCDATETIME())
     WHERE id = @id`,
    { id: req.user.id, ip: req.ip, userAgent: `${req.headers["user-agent"] || ""}`.slice(0, 512), version: POLICY_VERSION }
  );
  const row = await findActiveUserById(req.user.id);
  const csrfToken = setLoggedInSession(req, row);
  await writeAudit({
    actorId: req.user.id, action: "PDPA_ACCEPT", entityType: "USER", entityId: req.user.id,
    afterValue: { policyVersion: POLICY_VERSION }, ip: req.ip, userAgent: req.headers["user-agent"]
  });
  res.json({ token: signToken(row), csrfToken, user: await withSections(sanitizeUser(row)) });
}));

// The forced first-sign-in password change (no current password asked).
// Open only while must_change_password is set, and the new password must
// differ from the one the admin handed out.
router.post("/first-password", requireAuth, asyncHandler(async (req, res) => {
  const input = z.object({ newPassword: z.string().min(1).max(256) }).parse(req.body);
  const row = (await query(
    "SELECT password_hash, must_change_password FROM users WHERE id = @id AND is_active = 1",
    { id: req.user.id }
  )).recordset[0];
  if (!row || !(row.must_change_password === true || row.must_change_password === 1)) {
    return res.status(403).json({ message: "Use Profile › Security to change your password" });
  }
  if (rejectWeakPassword(res, input.newPassword)) return;
  if (await bcrypt.compare(input.newPassword, row.password_hash || "")) {
    return res.status(400).json({ message: "Choose a password different from the one you were given" });
  }
  const hash = await bcrypt.hash(input.newPassword, env.bcryptRounds);
  await query("UPDATE users SET password_hash = @hash, updated_at = DATEADD(HOUR, 7, SYSUTCDATETIME()) WHERE id = @id", { id: req.user.id, hash });
  await setMustChangePassword(req.user.id, false);
  await writeAudit({ actorId: req.user.id, action: "CHANGE_PASSWORD", entityType: "USER", entityId: req.user.id, ip: req.ip, userAgent: req.headers["user-agent"] });
  await bumpTokenVersion(req.user.id);
  const fresh = await findActiveUserById(req.user.id);
  const csrfToken = setLoggedInSession(req, fresh);
  res.json({ ok: true, token: signToken(fresh), csrfToken });
}));

// --- Failed sign-in blocks (system admin) ----------------------------------

router.get("/login-blocks", requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  res.json({ data: listBlockedIps(), accounts: await listLockedAccounts() });
}));

router.delete("/login-blocks/:ip", requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const ip = `${req.params.ip || ""}`.trim();
  if (!ip) return res.status(400).json({ message: "IP is required" });
  const ids = await releaseIpAndAccounts(ip);
  await writeAudit({ actorId: req.user.id, action: "UNBLOCK_LOGIN", entityType: "AUTH", entityId: ip, afterValue: { unlockedAccountIds: ids }, ip: req.ip, userAgent: req.headers["user-agent"] });
  res.json({ ok: true, unlockedAccounts: ids.length });
}));

router.post("/login-blocks/accounts/:id(\\d+)/unlock", requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const ips = await releaseAccount(Number(req.params.id));
  await writeAudit({ actorId: req.user.id, action: "UNLOCK_ACCOUNT", entityType: "USER", entityId: req.params.id, afterValue: { releasedIps: ips }, ip: req.ip, userAgent: req.headers["user-agent"] });
  res.json({ ok: true, releasedIps: ips });
}));

router.delete("/login-blocks", requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const cleared = await releaseEverything();
  await writeAudit({ actorId: req.user.id, action: "UNBLOCK_LOGIN_ALL", entityType: "AUTH", entityId: `${cleared.ips} ip(s), ${cleared.accounts} account(s)`, ip: req.ip, userAgent: req.headers["user-agent"] });
  res.json({ ok: true, cleared: cleared.ips, accounts: cleared.accounts });
}));

module.exports = router;
module.exports.sanitizeUser = sanitizeUser;
module.exports.findActiveUserById = findActiveUserById;
