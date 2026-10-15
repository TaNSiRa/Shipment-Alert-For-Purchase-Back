const jwt = require("jsonwebtoken");
const { env } = require("../config/env");
const { loadAccountState, tokenVersionOf } = require("../services/accountState");
const { POLICY_VERSION, hasCurrentConsent } = require("../services/pdpa");
const { clearSession } = require("../services/securityService");

// A verified token/session is not enough on its own — the account behind it
// must still be active and must not have been revoked since the credential was
// issued. Returns the rejection code, or null when the caller may proceed.
async function revocationProblem(user) {
  const state = await loadAccountState(user?.id);
  if (!state.isActive) return "ACCOUNT_DISABLED";
  if (tokenVersionOf(user) !== state.tokenVersion) return "SESSION_REVOKED";
  return null;
}

async function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;

  let user;
  let fromSession = false;
  if (token) {
    try {
      user = jwt.verify(token, env.jwtSecret, { algorithms: ["HS256"] });
    } catch {
      return res.status(401).json({ message: "Unauthorized" });
    }
  } else if (req.session?.user) {
    user = req.session.user;
    fromSession = true;
  } else {
    return res.status(401).json({ message: "Unauthorized" });
  }

  try {
    const problem = await revocationProblem(user);
    if (problem) {
      // A session cookie that no longer authenticates anyone is in the way of
      // the next sign-in (csrfProtection still sees `.user` on it) — bin it.
      if (fromSession) return clearSession(req, res, () => res.status(401).json({ message: problem }));
      return res.status(401).json({ message: problem });
    }
  } catch (err) {
    return next(err);
  }

  req.user = user;
  next();
}

function signToken(user) {
  return jwt.sign(
    {
      id: user.id,
      email: user.email,
      displayName: user.display_name || user.displayName,
      roleCode: user.role_code || user.roleCode,
      tv: tokenVersionOf(user),
      pdpaConsentAccepted: hasCurrentConsent(user),
      pdpaVersion: user.pdpa_policy_version ?? user.pdpaVersion ?? null,
      policyVersion: POLICY_VERSION
    },
    env.jwtSecret,
    { expiresIn: env.jwtExpiresIn, algorithm: "HS256" }
  );
}

module.exports = { requireAuth, signToken };
