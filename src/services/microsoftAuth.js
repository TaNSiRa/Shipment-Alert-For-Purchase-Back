// "Sign in with Microsoft" (Microsoft 365 / Entra ID), OpenID Connect
// authorization-code flow with PKCE, run entirely by the API:
//
//   1. GET  /api/auth/microsoft/start      -> 302 to login.microsoftonline.com
//      (state / nonce / PKCE verifier go into a short-lived signed cookie)
//   2. GET  /api/auth/microsoft/callback   <- Microsoft sends the browser back
//      code -> token endpoint -> id_token, verified here (signature against the
//      tenant's JWKS, issuer, audience, nonce, expiry). The email it names must
//      already be an ACTIVE user — Microsoft proves who someone is, the Users
//      page still decides who gets in. Then 302 back to the app with a
//      one-time ticket (bound to this browser by a cookie).
//   3. POST /api/auth/microsoft/exchange   <- the app trades the ticket for the
//      same { token, csrfToken, user } a password login returns.
//
// The ticket step exists because the session cookie is SameSite=strict: a
// cookie set while the browser is coming back from another site is not one
// to rely on. The app's own POST is same-site, so the session it creates is
// an ordinary one. Tickets live 60 s, work once, and stay in this process —
// the same single-instance rule as the session MemoryStore.
//
// No extra dependencies: Node's fetch, crypto (JWK -> KeyObject) and the
// jsonwebtoken package the API already uses.
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const { env } = require("../config/env");

const PENDING_COOKIE = "psa_ms_auth";
const PENDING_PATH = "/api/auth/microsoft";
const PENDING_MINUTES = 10;
const TICKET_SECONDS = 60;
const JWKS_CACHE_MS = 6 * 60 * 60 * 1000;

function isMicrosoftEnabled() {
  return env.microsoft.enabled;
}

function authority() {
  return `https://login.microsoftonline.com/${env.microsoft.tenantId}`;
}

function expectedIssuer() {
  return `${authority()}/v2.0`;
}

function base64url(buffer) {
  return Buffer.from(buffer).toString("base64url");
}

function hmac(value) {
  // Its own key, derived from the session secret, so this cookie can never be
  // passed off as anything else the API signs.
  return crypto.createHmac("sha256", `${env.session.secret}:microsoft-pending`).update(value).digest("base64url");
}

function safeEquals(a, b) {
  const left = Buffer.from(`${a}`, "utf8");
  const right = Buffer.from(`${b}`, "utf8");
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

// --- Where to send the browser back to --------------------------------------

// Only an app address the API already trusts (FRONTEND_ORIGINS, or the API's
// own origin when it serves the web build) — anything else would make the
// callback an open redirect that hands out login tickets.
function safeReturnTo(raw, req) {
  const fallback = env.appPublicUrl || env.frontendOrigins[0] || "/";
  let url;
  try {
    url = new URL(`${raw || ""}`);
  } catch {
    return fallback;
  }
  if (!["http:", "https:"].includes(url.protocol)) return fallback;
  const sameHost = req && url.host === req.get("host");
  if (!sameHost && !env.frontendOrigins.includes(url.origin)) return fallback;
  return `${url.origin}${url.pathname}`;
}

function withParams(base, params) {
  let url;
  try {
    url = new URL(base);
  } catch {
    url = new URL(base, "http://placeholder.invalid");
  }
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url.host === "placeholder.invalid" ? `${url.pathname}${url.search}` : url.toString();
}

// --- The pending-sign-in cookie ----------------------------------------------

function sealPending(data) {
  const body = base64url(JSON.stringify(data));
  return `${body}.${hmac(body)}`;
}

function openPending(value) {
  const [body, mac] = `${value || ""}`.split(".");
  if (!body || !mac || !safeEquals(mac, hmac(body))) return null;
  try {
    const data = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (!data || typeof data.exp !== "number" || data.exp < Date.now()) return null;
    return data;
  } catch {
    return null;
  }
}

function readCookie(req, name) {
  for (const part of `${req.headers.cookie || ""}`.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) {
      try {
        return decodeURIComponent(part.slice(i + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
}

// Lax, not strict: the cookie has to come back on the top-level GET from
// login.microsoftonline.com, which is exactly what Lax allows and Strict drops.
function pendingCookieOptions() {
  return {
    httpOnly: true,
    secure: env.session.cookieSecure,
    sameSite: "lax",
    path: PENDING_PATH,
    maxAge: PENDING_MINUTES * 60 * 1000
  };
}

function beginSignIn(req, res, returnTo) {
  const state = base64url(crypto.randomBytes(24));
  const nonce = base64url(crypto.randomBytes(24));
  const verifier = base64url(crypto.randomBytes(48));
  const challenge = base64url(crypto.createHash("sha256").update(verifier).digest());
  res.cookie(PENDING_COOKIE, sealPending({
    state, nonce, verifier, returnTo, exp: Date.now() + PENDING_MINUTES * 60 * 1000
  }), pendingCookieOptions());
  const url = new URL(`${authority()}/oauth2/v2.0/authorize`);
  url.search = new URLSearchParams({
    client_id: env.microsoft.clientId,
    response_type: "code",
    redirect_uri: env.microsoft.redirectUri,
    response_mode: "query",
    scope: "openid profile email",
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: "S256",
    prompt: "select_account"
  }).toString();
  return url.toString();
}

// Returns the pending data when `state` matches the cookie, and always clears
// the cookie: one cookie, one attempt.
function takePending(req, res, state) {
  const pending = openPending(readCookie(req, PENDING_COOKIE));
  const { maxAge, ...clear } = pendingCookieOptions();
  res.clearCookie(PENDING_COOKIE, clear);
  if (!pending || !state || !safeEquals(pending.state, state)) return null;
  return pending;
}

// --- Token endpoint + id_token verification -----------------------------------

async function redeemCode(code, verifier) {
  const response = await fetch(`${authority()}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.microsoft.clientId,
      client_secret: env.microsoft.clientSecret,
      grant_type: "authorization_code",
      code,
      redirect_uri: env.microsoft.redirectUri,
      code_verifier: verifier,
      scope: "openid profile email"
    }).toString()
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.id_token) {
    const reason = body.error_description || body.error || `HTTP ${response.status}`;
    throw Object.assign(new Error(`Microsoft token endpoint refused the code: ${reason}`), { code: "TOKEN_EXCHANGE_FAILED" });
  }
  return body.id_token;
}

let jwksCache = { at: 0, keys: [] };

async function fetchJwks() {
  if (Date.now() - jwksCache.at < JWKS_CACHE_MS && jwksCache.keys.length) return jwksCache.keys;
  const response = await fetch(`${authority()}/discovery/v2.0/keys`);
  if (!response.ok) throw new Error(`Cannot load Microsoft signing keys (HTTP ${response.status})`);
  const { keys } = await response.json();
  jwksCache = { at: Date.now(), keys: Array.isArray(keys) ? keys : [] };
  return jwksCache.keys;
}

// Microsoft rolls its signing keys; an unknown `kid` means "fetch again" once.
async function publicKeyFor(kid, getJwks) {
  const find = keys => keys.find(k => k.kid === kid && k.kty === "RSA");
  let jwk = find(await getJwks());
  if (!jwk && getJwks === fetchJwks) {
    jwksCache = { at: 0, keys: [] };
    jwk = find(await getJwks());
  }
  if (!jwk) throw Object.assign(new Error("Unknown signing key"), { code: "BAD_ID_TOKEN" });
  return crypto.createPublicKey({ key: { kty: jwk.kty, n: jwk.n, e: jwk.e }, format: "jwk" });
}

// `getJwks` is swappable so the tests can sign with a key of their own.
async function verifyIdToken(idToken, { nonce }, { getJwks = fetchJwks } = {}) {
  const decoded = jwt.decode(idToken, { complete: true });
  if (!decoded?.header?.kid) throw Object.assign(new Error("Malformed id_token"), { code: "BAD_ID_TOKEN" });
  const key = await publicKeyFor(decoded.header.kid, getJwks);
  let claims;
  try {
    claims = jwt.verify(idToken, key, {
      algorithms: ["RS256"],
      audience: env.microsoft.clientId,
      issuer: expectedIssuer(),
      clockTolerance: 120
    });
  } catch (err) {
    throw Object.assign(new Error(`id_token rejected: ${err.message}`), { code: "BAD_ID_TOKEN" });
  }
  if (`${claims.tid || ""}`.toLowerCase() !== env.microsoft.tenantId.toLowerCase()) {
    throw Object.assign(new Error("id_token is from another tenant"), { code: "BAD_ID_TOKEN" });
  }
  if (!nonce || !claims.nonce || !safeEquals(claims.nonce, nonce)) {
    throw Object.assign(new Error("id_token nonce mismatch"), { code: "BAD_ID_TOKEN" });
  }
  return claims;
}

// The work address to look the person up by. `email` is optional in Entra ID
// tokens; `preferred_username` is the UPN, which in Microsoft 365 is the
// mailbox address for nearly everyone.
function emailFromClaims(claims) {
  for (const value of [claims.email, claims.preferred_username, claims.upn]) {
    const text = `${value || ""}`.trim().toLowerCase();
    if (/^[^@\s]+@[^@\s]+$/.test(text)) return text;
  }
  return null;
}

// --- One-time tickets ------------------------------------------------------------

// A ticket only works in the browser it was issued to: the callback also sets
// a binding cookie, and the exchange needs both. Without that, a ticket from
// someone else's sign-in, sent as a link, would sign the victim in as THEM.
const BIND_COOKIE = "psa_ms_bind";
const tickets = new Map();

function issueTicket(res, userId) {
  const now = Date.now();
  for (const [key, t] of tickets) if (t.exp < now) tickets.delete(key);
  const ticket = base64url(crypto.randomBytes(32));
  const binding = base64url(crypto.randomBytes(32));
  tickets.set(ticket, { userId, binding, exp: now + TICKET_SECONDS * 1000 });
  res.cookie(BIND_COOKIE, binding, { ...pendingCookieOptions(), maxAge: TICKET_SECONDS * 1000 });
  return ticket;
}

function redeemTicket(req, res, ticket) {
  const key = `${ticket || ""}`;
  const entry = tickets.get(key);
  const binding = readCookie(req, BIND_COOKIE);
  const { maxAge, ...clear } = pendingCookieOptions();
  res.clearCookie(BIND_COOKIE, clear);
  tickets.delete(key);
  if (!entry || entry.exp < Date.now() || !binding || !safeEquals(binding, entry.binding)) return null;
  return entry.userId;
}

module.exports = {
  beginSignIn,
  emailFromClaims,
  expectedIssuer,
  isMicrosoftEnabled,
  issueTicket,
  openPending,
  redeemCode,
  redeemTicket,
  safeReturnTo,
  sealPending,
  takePending,
  verifyIdToken,
  withParams
};
