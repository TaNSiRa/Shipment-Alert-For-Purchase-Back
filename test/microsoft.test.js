// Microsoft 365 sign-in and the production CSP — no database, no network.
// The id_token checks run against a key pair made here instead of
// Microsoft's JWKS.
const fs = require("fs");
const os = require("os");
const path = require("path");

const TENANT = "11111111-2222-3333-4444-555555555555";
const CLIENT = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const WEB_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "psa-web-"));
fs.writeFileSync(path.join(WEB_ROOT, "index.html"), "<!doctype html><title>PSA</title>");
fs.writeFileSync(path.join(WEB_ROOT, "main.dart.js"), "console.log('psa')");

process.env.SQL_DATABASE = "Purchase_Alert_Test";
process.env.MAIL_SCHEDULER_ENABLED = "false";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret-for-microsoft-tests";
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret-for-microsoft-tests";
process.env.FRONTEND_ORIGINS = "http://127.0.0.1:5340";
process.env.APP_PUBLIC_URL = "http://127.0.0.1:5340";
process.env.MS_TENANT_ID = TENANT;
process.env.MS_CLIENT_ID = CLIENT;
process.env.MS_CLIENT_SECRET = "client-secret";
process.env.MS_REDIRECT_URI = "http://127.0.0.1:4340/api/auth/microsoft/callback";
process.env.WEB_ROOT = WEB_ROOT;

const crypto = require("crypto");
const test = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("jsonwebtoken");
const request = require("supertest");
const ms = require("../src/services/microsoftAuth");
const { createApp } = require("../src/app");

test.after(() => fs.rmSync(WEB_ROOT, { recursive: true, force: true }));

const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "test-key", kty: "RSA" };
const getJwks = async () => [jwk];

function idToken(claims = {}, { key = privateKey, kid = "test-key" } = {}) {
  return jwt.sign(
    { tid: TENANT, nonce: "n-1", preferred_username: "Buyer@Company.com", ...claims },
    key,
    { algorithm: "RS256", keyid: kid, audience: CLIENT, issuer: `https://login.microsoftonline.com/${TENANT}/v2.0`, expiresIn: "5m" }
  );
}

async function rejects(token, nonce = "n-1") {
  await assert.rejects(ms.verifyIdToken(token, { nonce }, { getJwks }), err => err.code === "BAD_ID_TOKEN");
}

test("a genuine id_token is accepted and names the person", async () => {
  const claims = await ms.verifyIdToken(idToken(), { nonce: "n-1" }, { getJwks });
  assert.equal(ms.emailFromClaims(claims), "buyer@company.com");
  assert.equal(ms.emailFromClaims({ email: "a@b.co", preferred_username: "x@y.z" }), "a@b.co");
  assert.equal(ms.emailFromClaims({ preferred_username: "not-an-email" }), null);
});

test("id_tokens that must be refused", async () => {
  const other = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
  await rejects(idToken({}, { key: other }));                       // forged signature
  await rejects(idToken({}, { kid: "unknown" }));                   // key not in the JWKS
  await rejects(idToken({ tid: "99999999-2222-3333-4444-555555555555" })); // another tenant
  await rejects(idToken(), "different-nonce");                      // replayed / mixed-up flow
  await rejects(idToken({ nonce: undefined }));                     // no nonce at all
  await rejects(jwt.sign({ tid: TENANT, nonce: "n-1" }, privateKey,
    { algorithm: "RS256", keyid: "test-key", audience: "someone-else", issuer: ms.expectedIssuer() })); // other app
  await rejects(jwt.sign({ tid: TENANT, nonce: "n-1" }, privateKey,
    { algorithm: "RS256", keyid: "test-key", audience: CLIENT, issuer: "https://evil.example/v2.0" })); // other issuer
  await rejects(jwt.sign({ tid: TENANT, nonce: "n-1", exp: Math.floor(Date.now() / 1000) - 3600 }, privateKey,
    { algorithm: "RS256", keyid: "test-key", audience: CLIENT, issuer: ms.expectedIssuer() })); // expired
});

test("the pending-sign-in cookie cannot be forged or kept past its time", () => {
  const sealed = ms.sealPending({ state: "s", exp: Date.now() + 60000 });
  assert.equal(ms.openPending(sealed).state, "s");
  const [body, mac] = sealed.split(".");
  const evil = Buffer.from(JSON.stringify({ state: "x", exp: Date.now() + 60000 })).toString("base64url");
  assert.equal(ms.openPending(`${evil}.${mac}`), null);
  assert.equal(ms.openPending(`${body}.AAAA`), null);
  assert.equal(ms.openPending(ms.sealPending({ state: "s", exp: Date.now() - 1 })), null);
  assert.equal(ms.openPending("garbage"), null);
});

test("return addresses are limited to the app's own origins", () => {
  const req = { get: () => "127.0.0.1:4340" };
  assert.equal(ms.safeReturnTo("http://127.0.0.1:5340/?x=1#/", req), "http://127.0.0.1:5340/");
  assert.equal(ms.safeReturnTo("http://127.0.0.1:4340/app/", req), "http://127.0.0.1:4340/app/");
  assert.equal(ms.safeReturnTo("https://evil.example/", req), "http://127.0.0.1:5340");
  assert.equal(ms.safeReturnTo("javascript:alert(1)", req), "http://127.0.0.1:5340");
  assert.equal(ms.withParams("http://127.0.0.1:5340/", { ms_error: "LOCKED" }), "http://127.0.0.1:5340/?ms_error=LOCKED");
});

test("tickets work exactly once, and only in the browser they were issued to", () => {
  const issue = () => {
    const cookies = {};
    const res = { cookie: (name, value) => { cookies[name] = value; }, clearCookie() {} };
    return { ticket: ms.issueTicket(res, 42), bind: cookies.psa_ms_bind };
  };
  const reqWith = bind => ({ headers: { cookie: bind ? `psa_ms_bind=${bind}` : "" } });
  const res = { clearCookie() {} };

  const a = issue();
  assert.equal(ms.redeemTicket(reqWith(a.bind), res, a.ticket), 42);
  assert.equal(ms.redeemTicket(reqWith(a.bind), res, a.ticket), null);   // used up
  const b = issue();
  assert.equal(ms.redeemTicket(reqWith(null), res, b.ticket), null);     // link sent to another browser
  const c = issue();
  assert.equal(ms.redeemTicket(reqWith(a.bind), res, c.ticket), null);   // someone else's binding
  assert.equal(ms.redeemTicket(reqWith(c.bind), res, c.ticket), null);   // a failed try burns it
  assert.equal(ms.redeemTicket(reqWith(a.bind), res, "made-up"), null);
});

test("start sends the browser to Microsoft with PKCE and a Lax state cookie", async () => {
  const app = createApp();
  const res = await request(app).get("/api/auth/microsoft/start?returnTo=http%3A%2F%2F127.0.0.1%3A5340%2F");
  assert.equal(res.status, 302);
  const url = new URL(res.headers.location);
  assert.equal(url.origin + url.pathname, `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/authorize`);
  assert.equal(url.searchParams.get("client_id"), CLIENT);
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.ok(url.searchParams.get("state") && url.searchParams.get("nonce"));
  const cookie = res.headers["set-cookie"].find(c => c.startsWith("psa_ms_auth="));
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Path=\/api\/auth\/microsoft/);

  // The callback refuses a state that is not the one in the cookie...
  const cb = await request(app)
    .get("/api/auth/microsoft/callback?code=abc&state=wrong")
    .set("Cookie", cookie.split(";")[0]);
  assert.equal(cb.status, 302);
  assert.equal(cb.headers.location, "http://127.0.0.1:5340/?ms_error=EXPIRED");
  // ...and a Cancel on Microsoft's page comes back as CANCELLED.
  const state = url.searchParams.get("state");
  const cancelled = await request(app)
    .get(`/api/auth/microsoft/callback?error=access_denied&state=${state}`)
    .set("Cookie", cookie.split(";")[0]);
  assert.equal(cancelled.headers.location, "http://127.0.0.1:5340/?ms_error=CANCELLED");
});

test("an unknown ticket is refused without a CSRF token being needed", async () => {
  const res = await request(createApp()).post("/api/auth/microsoft/exchange").send({ ticket: "nope" });
  assert.equal(res.status, 401);
});

test("API answers keep the no-content CSP; the web build gets its own", async () => {
  const app = createApp();
  const api = await request(app).get("/api/does-not-exist");
  assert.match(api.headers["content-security-policy"], /default-src 'none'/);

  const page = await request(app).get("/");
  assert.equal(page.status, 200);
  assert.match(page.text, /<title>PSA<\/title>/);
  const csp = page.headers["content-security-policy"];
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /script-src 'self' 'wasm-unsafe-eval'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /connect-src 'self' ws:\/\/127\.0\.0\.1:\d+ wss:\/\/127\.0\.0\.1:\d+/);
  assert.doesNotMatch(csp, /[ ;]'unsafe-eval'/);
  assert.equal(page.headers["cache-control"], "no-cache");

  const js = await request(app).get("/main.dart.js");
  assert.equal(js.status, 200);
  // Deep links fall back to index.html.
  const deep = await request(app).get("/some/client/route");
  assert.match(deep.text, /<title>PSA<\/title>/);
});

test("same-origin calls from the served web app pass CORS; foreign origins do not", async () => {
  const app = createApp();
  const same = await request(app).post("/api/auth/microsoft/exchange")
    .set("Host", "psa.local:4340").set("Origin", "http://psa.local:4340").send({ ticket: "nope" });
  assert.equal(same.status, 401);
  const foreign = await request(app).post("/api/auth/microsoft/exchange")
    .set("Origin", "https://evil.example").send({ ticket: "nope" });
  assert.equal(foreign.status, 403);
});
