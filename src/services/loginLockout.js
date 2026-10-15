const { query } = require("../db/pool");
const { thaiWallNow } = require("./thaiTime");

// Per-ACCOUNT brute-force lockout, behind the per-IP rate limiter rather than
// replacing it. The limiter stops one machine hammering the endpoint; this
// stops one account being guessed slowly from many addresses, and unlike the
// limiter's in-memory counter it survives a restart.
const MAX_FAILURES = 5;
const LOCK_MINUTES = 15;

// The moment the lock lifts, or null when the account is open.
function lockedUntil(userRow) {
  const value = userRow?.login_locked_until;
  if (!value) return null;
  const until = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(until.getTime())) return null;
  // The column holds Thai wall-clock time, so compare against the Thai clock.
  return until.getTime() > thaiWallNow().getTime() ? until : null;
}

// One more wrong password. Returns the state AFTER this failure.
async function recordFailure(userId) {
  if (!userId) return { locked: false, until: null };
  const row = (await query(
    `UPDATE users
     SET failed_login_count = failed_login_count + 1,
         login_locked_until = CASE
           WHEN failed_login_count + 1 >= @maxFailures
             THEN DATEADD(MINUTE, @lockMinutes, DATEADD(HOUR, 7, SYSUTCDATETIME()))
           ELSE login_locked_until
         END
     OUTPUT INSERTED.failed_login_count AS failures, INSERTED.login_locked_until AS until
     WHERE id = @id`,
    { id: userId, maxFailures: MAX_FAILURES, lockMinutes: LOCK_MINUTES }
  )).recordset[0];
  if (!row) return { locked: false, until: null };
  return { locked: Number(row.failures) >= MAX_FAILURES, until: row.until || null };
}

// Right password: the account is open again and the count starts over.
async function recordSuccess(userId) {
  if (!userId) return;
  await query("UPDATE users SET failed_login_count = 0, login_locked_until = NULL WHERE id = @id", { id: userId });
}

// Every account whose lock has not lifted yet, as id -> Date.
async function currentLocks() {
  const locks = new Map();
  const rows = (await query(
    "SELECT id, login_locked_until FROM users WHERE login_locked_until > DATEADD(HOUR, 7, SYSUTCDATETIME())"
  )).recordset;
  for (const row of rows) locks.set(Number(row.id), row.login_locked_until);
  return locks;
}

module.exports = { MAX_FAILURES, LOCK_MINUTES, currentLocks, lockedUntil, recordFailure, recordSuccess };
