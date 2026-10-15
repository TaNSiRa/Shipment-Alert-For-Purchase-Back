const { query } = require("../db/pool");
const { recordSuccess } = require("./loginLockout");
const { THAI_OFFSET_MS } = require("./thaiTime");

// The two failed-sign-in guards, released as ONE thing.
//
// Five wrong passwords trip both at once: the per-IP limiter (auth.routes.js)
// and the per-account lock (loginLockout.js). Releasing only one left the
// person still refused by the other — unlock the account and the IP still
// answers 429, release the IP and the account is still locked. So every release
// here takes the other half with it, matched through the LOGIN_FAILED rows the
// login route writes (actor = account, ip_address = the limiter's key, req.ip).

// ip -> { blockedAt, resetTime, hits }. In-memory (per process), same as the
// limiter's own store; an entry is pruned once its window has elapsed.
const blocked = new Map();
let limiter = null;

// How far back a failure still counts as "what caused this block": the limiter
// window and the lock are both 15 minutes, so twice that covers a lock that
// started at the end of a window.
const LINK_WINDOW_MINUTES = 30;
const FAILURE_ACTIONS = "('LOGIN_FAILED','ACCOUNT_LOCKED','LOGIN_BLOCKED')";

function registerLimiter(instance) {
  limiter = instance;
}

function noteBlocked(req) {
  const existing = blocked.get(req.ip);
  blocked.set(req.ip, {
    blockedAt: existing?.blockedAt || new Date().toISOString(),
    resetTime: req.rateLimit?.resetTime ? new Date(req.rateLimit.resetTime).toISOString() : null,
    hits: req.rateLimit?.used ?? existing?.hits ?? null
  });
}

// After a counted failure. The attempt that used the LAST try has already shut
// the IP, so list it now — the limiter's own handler only fires on the attempt
// after that, which nobody may ever make, leaving Settings empty while the
// person behind that IP cannot sign in.
function noteIfExhausted(req) {
  if (req.rateLimit && req.rateLimit.remaining === 0) noteBlocked(req);
}

function listBlockedIps() {
  const now = Date.now();
  for (const [ip, info] of blocked) {
    if (!info.resetTime || new Date(info.resetTime).getTime() <= now) blocked.delete(ip);
  }
  return [...blocked.entries()]
    .map(([ip, info]) => ({ ip, ...info }))
    .sort((a, b) => `${b.blockedAt}`.localeCompare(`${a.blockedAt}`));
}

async function releaseIp(ip) {
  if (limiter) await limiter.resetKey(ip);
  blocked.delete(ip);
}

// Accounts whose lock is still in force, each with the IPs its failures came
// from. lockedUntil goes out as a real UTC instant (the column is Thai wall
// time), so the client's toLocal() shows the right clock.
async function listLockedAccounts() {
  const rows = (await query(
      `SELECT u.id, u.email, u.display_name, u.employee_no, u.login_locked_until,
              (SELECT DISTINCT a.ip_address AS ip
                 FROM audit_logs a
                 WHERE a.actor_user_id = u.id AND a.action IN ${FAILURE_ACTIONS}
                   AND a.ip_address IS NOT NULL
                   AND a.created_at > DATEADD(MINUTE, -@window, DATEADD(HOUR, 7, SYSUTCDATETIME()))
                 FOR JSON PATH) AS ips_json
       FROM users u
       WHERE u.login_locked_until > DATEADD(HOUR, 7, SYSUTCDATETIME())
       ORDER BY u.login_locked_until DESC`,
      { window: LINK_WINDOW_MINUTES }
    )).recordset;
  return rows.map(r => ({
    id: r.id,
    email: r.email,
    displayName: r.display_name,
    employeeNo: r.employee_no,
    lockedUntil: r.login_locked_until
      ? new Date(new Date(r.login_locked_until).getTime() - THAI_OFFSET_MS).toISOString()
      : null,
    ips: r.ips_json ? JSON.parse(r.ips_json).map(x => x.ip) : []
  }));
}

async function failureIpsForAccount(userId) {
  return (await query(
    `SELECT DISTINCT ip_address AS ip FROM audit_logs
     WHERE actor_user_id = @id AND action IN ${FAILURE_ACTIONS} AND ip_address IS NOT NULL
       AND created_at > DATEADD(MINUTE, -@window, DATEADD(HOUR, 7, SYSUTCDATETIME()))`,
    { id: Number(userId), window: LINK_WINDOW_MINUTES }
  )).recordset.map(r => r.ip);
}

// Open the account AND every IP that failed against it. Returns the IPs released.
async function releaseAccount(userId) {
  await recordSuccess(Number(userId));
  const ips = await failureIpsForAccount(userId);
  for (const ip of ips) await releaseIp(ip);
  return ips;
}

// Release the IP AND every account whose failures from it left it locked.
// Returns the ids unlocked.
async function releaseIpAndAccounts(ip) {
  await releaseIp(ip);
  const ids = (await query(
    `SELECT DISTINCT actor_user_id AS id FROM audit_logs
     WHERE ip_address = @ip AND actor_user_id IS NOT NULL AND action IN ${FAILURE_ACTIONS}
       AND created_at > DATEADD(MINUTE, -@window, DATEADD(HOUR, 7, SYSUTCDATETIME()))`,
    { ip, window: LINK_WINDOW_MINUTES }
  )).recordset.map(r => r.id);
  for (const id of ids) await recordSuccess(id);
  return ids;
}

async function releaseEverything() {
  const ips = [...blocked.keys()];
  for (const ip of ips) await releaseIp(ip);
  const accounts = (await query(
      `UPDATE users SET failed_login_count = 0, login_locked_until = NULL
       WHERE login_locked_until IS NOT NULL OR failed_login_count > 0`
  )).rowsAffected?.[0] || 0;
  return { ips: ips.length, accounts };
}

module.exports = {
  listBlockedIps,
  listLockedAccounts,
  noteBlocked,
  noteIfExhausted,
  registerLimiter,
  releaseAccount,
  releaseEverything,
  releaseIp,
  releaseIpAndAccounts
};
