// PDPA consent, enforced by the server rather than only drawn by the client.
//
// The consent page has always been in the Flutter app, and the evidence has
// always been recorded (who, when, from which IP and user agent, against which
// policy version). What was missing is the half that does not depend on the
// client behaving: a token issued before the person accepted still opened every
// endpoint, so "the app processes nobody's data before they agree" rested on
// the UI never calling anything — true of our client, not true of a REST client.

// The version people are being asked to agree to right now. Raising this asks
// everyone for consent again, which is the point of R10.5: consent is given to
// a specific text, so a new text needs a new answer.
const POLICY_VERSION = "psa-privacy-policy-2026";

// Endpoints that must stay open to a signed-in account that has NOT consented
// yet — otherwise there is no way to reach the consent page or to leave.
//   /auth/*            the whole router: who am I, refresh, accept, log out,
//                      and the forced first-password change that runs in the
//                      same pre-section stage as consent
//   /health            unauthenticated anyway
const EXEMPT_PREFIXES = ["/api/auth", "/api/health"];

// Consent counts only when it was given to the CURRENT policy text. Accepts
// either a users row (pdpa_consent_accepted / pdpa_policy_version) or an
// already-issued token payload (pdpaConsentAccepted / pdpaVersion), because
// both shapes reach this from setLoggedInSession and signToken.
function hasCurrentConsent(user) {
  if (!user) return false;
  const accepted = user.pdpa_consent_accepted === true ||
    user.pdpa_consent_accepted === 1 ||
    user.pdpaConsentAccepted === true;
  if (!accepted) return false;
  const version = user.pdpa_policy_version ?? user.pdpaVersion ?? null;
  // A row that predates version stamping cannot show WHICH text was agreed to,
  // so it is not evidence of consent to this one.
  return `${version ?? ""}` === POLICY_VERSION;
}

function isExempt(req) {
  const path = `${req.baseUrl || ""}${req.path || ""}`;
  return EXEMPT_PREFIXES.some(prefix => path === prefix || path.startsWith(`${prefix}/`));
}

// Mount AFTER requireAuth (it reads req.user). Anonymous callers are not this
// middleware's business — they were already refused with a 401.
function requirePdpaConsent(req, res, next) {
  if (!req.user || isExempt(req)) return next();
  if (hasCurrentConsent(req.user)) return next();
  return res.status(403).json({ message: "PDPA_CONSENT_REQUIRED" });
}

module.exports = { POLICY_VERSION, hasCurrentConsent, requirePdpaConsent };
