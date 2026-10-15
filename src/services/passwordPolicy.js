// Minimum password strength, enforced on every path that SETS a password:
// admin creates a user, admin resets a password, a user changes their own.
// Deliberately NOT enforced at login — existing accounts whose password predates
// this rule keep working until the next time it is changed.
const MIN_LENGTH = 8;
const MAX_LENGTH = 128;

// A short list of passwords that pass the mechanical rules but are the first
// thing anyone tries. Compared case-insensitively.
const BANNED = new Set([
  "password", "password1", "password123", "passw0rd",
  "12345678", "123456789", "1234567890",
  "qwerty123", "abc12345", "admin123", "welcome1", "letmein1", "iloveyou1"
]);

// Returns null when the password is acceptable, otherwise a human-readable
// reason the caller can hand straight to the user.
function passwordPolicyProblem(password) {
  const value = `${password ?? ""}`;
  if (value.length < MIN_LENGTH) {
    return `Password must be at least ${MIN_LENGTH} characters long`;
  }
  if (value.length > MAX_LENGTH) {
    return `Password must be at most ${MAX_LENGTH} characters long`;
  }
  if (value.trim() !== value) {
    return "Password must not start or end with a space";
  }
  if (!/[A-Za-z]/.test(value)) {
    return "Password must contain at least one letter";
  }
  if (!/[0-9]/.test(value)) {
    return "Password must contain at least one number";
  }
  if (BANNED.has(value.toLowerCase())) {
    return "This password is too common — please choose another one";
  }
  return null;
}

// Express-friendly wrapper: responds 400 and returns true when the password is
// rejected, so a route can `if (rejectWeakPassword(res, pw)) return;`.
function rejectWeakPassword(res, password) {
  const problem = passwordPolicyProblem(password);
  if (!problem) return false;
  res.status(400).json({ message: problem });
  return true;
}

module.exports = { MIN_LENGTH, MAX_LENGTH, passwordPolicyProblem, rejectWeakPassword };
