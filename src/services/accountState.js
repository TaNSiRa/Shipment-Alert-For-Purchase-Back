const { query } = require("../db/pool");

// Per-account state every authenticated request re-checks:
//   tokenVersion — bumped to revoke tokens already handed out (logout,
//                  password change/reset, deactivation).
//   isActive     — so deactivating someone cuts off their live session too,
//                  not only their next login.
//
// requireAuth runs on every call, so this is cached in-process for a few
// seconds. Every mutation goes through bumpTokenVersion / forgetAccount, which
// drop the entry immediately — revocation is instant on a single process; the
// TTL only bounds how long a change made straight in the database takes.
const CACHE_TTL_MS = 15000;
const cache = new Map();

async function loadAccountState(userId) {
  const id = Number(userId);
  if (!Number.isInteger(id) || id <= 0) return { tokenVersion: -1, isActive: false };

  const cached = cache.get(id);
  if (cached && cached.expiresAt > Date.now()) return cached.state;

  const row = (await query("SELECT token_version, is_active FROM users WHERE id = @id", { id })).recordset[0];
  const state = row
    ? { tokenVersion: Number(row.token_version) || 0, isActive: row.is_active === true || row.is_active === 1 }
    // No row: the account was deleted outright. Treat as revoked.
    : { tokenVersion: -1, isActive: false };
  cache.set(id, { state, expiresAt: Date.now() + CACHE_TTL_MS });
  return state;
}

// Invalidate every token and session already issued for this user.
async function bumpTokenVersion(userId) {
  const id = Number(userId);
  if (!Number.isInteger(id) || id <= 0) return;
  cache.delete(id);
  await query("UPDATE users SET token_version = token_version + 1 WHERE id = @id", { id });
}

function forgetAccount(userId) {
  cache.delete(Number(userId));
}

async function setMustChangePassword(userId, value) {
  await query("UPDATE users SET must_change_password = @value WHERE id = @id", { id: Number(userId), value: value ? 1 : 0 });
}

// The `tv` claim for a new token / session, from a users row or a token payload.
function tokenVersionOf(user) {
  return Number(user?.token_version ?? user?.tokenVersion ?? user?.tv ?? 0) || 0;
}

function resetAccountStateCache() {
  cache.clear();
}

module.exports = {
  bumpTokenVersion,
  forgetAccount,
  loadAccountState,
  resetAccountStateCache,
  setMustChangePassword,
  tokenVersionOf
};
