const crypto = require("crypto");
const session = require("express-session");
const { env } = require("../config/env");
const { tokenVersionOf } = require("./accountState");
const { hasCurrentConsent } = require("./pdpa");

function createCsrfToken() {
  return crypto.randomBytes(32).toString("base64url");
}

function sameSiteValue() {
  const value = env.session.cookieSameSite;
  if (!["strict", "lax", "none"].includes(value)) {
    throw new Error("SESSION_COOKIE_SAME_SITE must be strict, lax, or none");
  }
  return value;
}

// MemoryStore drops an expired session only when something reads it
// (`getSession` in express-session/session/memory.js). Nobody ever reads the
// session of a person who closed their browser, so those sit in the heap until
// the process restarts. `store.all()` walks every entry THROUGH that same read
// path, so calling it on a timer is a sweep — no expiry logic of our own, no
// extra dependency.
//
// This does not make MemoryStore a shared store: sessions still live in one
// process, which is only correct while the API runs as a single instance.
// Moving to SQL Server (`connect-mssql-v2`) is the change to make before ever
// running more than one.
const sessionStore = new session.MemoryStore();

const SWEEP_MINUTES = 5;
setInterval(() => {
  sessionStore.all(error => {
    // eslint-disable-next-line no-console
    if (error) console.error(`[session] sweep failed: ${error.message}`);
  });
}, SWEEP_MINUTES * 60 * 1000).unref();

function sessionMiddleware() {
  return session({
    name: env.session.cookieName,
    secret: env.session.secret,
    store: sessionStore,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      secure: env.session.cookieSecure,
      sameSite: sameSiteValue(),
      maxAge: env.session.idleTimeoutMinutes * 60 * 1000
    }
  });
}

function buildSessionUser(user) {
  return {
    id: user.id,
    email: user.email,
    displayName: user.display_name || user.displayName,
    roleCode: user.role_code || user.roleCode,
    // Same revocation counter the JWT carries, so a session cookie is cut off by
    // a password reset or deactivation exactly like a bearer token.
    tv: tokenVersionOf(user),
    // Same rule as the bearer token: consent is per policy version.
    pdpaConsentAccepted: hasCurrentConsent(user),
    pdpaVersion: user.pdpa_policy_version ?? user.pdpaVersion ?? null
  };
}

function setLoggedInSession(req, user) {
  req.session.user = buildSessionUser(user);
  req.session.csrfToken = createCsrfToken();
  return req.session.csrfToken;
}

// Login has to be allowed to throw away whatever session the browser turns up
// with — otherwise a stale one is INHERITED by the person who just signed in
// (session fixation), and the CSRF exemption below would be the hole that lets
// it happen. Callback API wrapped so the login routes can just await it.
function regenerateSession(req) {
  return new Promise((resolve, reject) => {
    if (typeof req.session?.regenerate !== "function") {
      resolve();
      return;
    }
    req.session.regenerate(error => (error ? reject(error) : resolve()));
  });
}

function clearSession(req, res, callback) {
  if (!req.session) {
    callback();
    return;
  }
  req.session.destroy(() => {
    res.clearCookie(env.session.cookieName);
    callback();
  });
}

// The two endpoints that CREATE a session. They cannot be asked for a CSRF
// token — the login page has never been given one — and they do not need to be:
// both demand a credential (password / one-time Microsoft ticket) that an
// attacker's page cannot produce from the victim's browser.
//
// Without this exemption a session cookie that outlives its own login (revoked
// by a logout elsewhere, a password change, a deactivation — requireAuth rejects
// those but the session object survives) turns into a lockout: the session still
// carries `.user`, the freshly-loaded login page has no token, so signing in
// again answers 403 CSRF_REQUIRED. And it does not heal on its own, because the
// login page polls /health every 10s and `rolling: true` re-ups the cookie on
// every one of those.
const SESSION_ENTRY_PATHS = new Set(["/api/auth/login", "/api/auth/microsoft/exchange"]);

// Express routes case-insensitively and ignores a trailing slash, so the set
// above is compared against a path normalised the same way it matches.
function entryPath(req) {
  const path = `${req.path}`.toLowerCase();
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

// CSRF is only exploitable against credentials the BROWSER attaches on its own —
// i.e. the session cookie. A Bearer token has to be set by same-origin JS, which
// an attacker's page cannot do, so a caller presenting only `Authorization` and
// no session cookie needs no CSRF token (and could never have obtained one).
// Gate strictly on "is there a logged-in session cookie".
function csrfProtection(req, res, next) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) {
    next();
    return;
  }

  if (SESSION_ENTRY_PATHS.has(entryPath(req))) {
    next();
    return;
  }

  if (!req.session?.user) {
    next();
    return;
  }

  const expectedToken = req.session.csrfToken;
  const actualToken = req.get("x-csrf-token");
  if (!expectedToken || !actualToken || !safeEquals(actualToken, expectedToken)) {
    res.status(403).json({ message: "CSRF_REQUIRED" });
    return;
  }
  next();
}

// Constant-time compare so the token can't be recovered a character at a time
// by timing the 403s.
function safeEquals(a, b) {
  const left = Buffer.from(`${a}`, "utf8");
  const right = Buffer.from(`${b}`, "utf8");
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function forceHttps(req, res, next) {
  if (!env.forceHttps || req.secure || req.headers["x-forwarded-proto"] === "https") {
    next();
    return;
  }
  res.redirect(301, `https://${req.headers.host}${req.originalUrl}`);
}

module.exports = {
  clearSession,
  createCsrfToken,
  csrfProtection,
  forceHttps,
  regenerateSession,
  sessionMiddleware,
  setLoggedInSession
};
