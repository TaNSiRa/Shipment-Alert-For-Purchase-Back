const path = require("path");

require("dotenv").config({ path: path.resolve(__dirname, "../../.env") });

function boolEnv(name, defaultValue = false) {
  const value = process.env[name];
  if (value === undefined || value === "") return defaultValue;
  return String(value).toLowerCase() === "true";
}

function numberEnv(name, defaultValue) {
  const value = process.env[name];
  if (value === undefined || value === "") return defaultValue;
  const parsed = Number(value);
  if (Number.isNaN(parsed)) throw new Error(`Invalid number environment variable: ${name}`);
  return parsed;
}

function listEnv(name) {
  return `${process.env[name] || ""}`
    .split(",")
    .map(value => value.trim())
    .filter(Boolean);
}

// A secret with no value must stop the process, not quietly borrow another one
// (a blank SESSION_SECRET falling back to JWT_SECRET would mean one leak costs
// both). Failing at startup is the only version of this anybody notices.
function requiredEnv(name) {
  const value = process.env[name];
  if (value === undefined || `${value}`.trim() === "") {
    throw new Error(`Refusing to start: ${name} is required (see .env.example)`);
  }
  return value;
}

const jwtSecret = requiredEnv("JWT_SECRET");
const sessionSecret = requiredEnv("SESSION_SECRET");
if (jwtSecret === sessionSecret) {
  throw new Error("Refusing to start: JWT_SECRET and SESSION_SECRET must be different values");
}

const sameSite = `${process.env.SESSION_COOKIE_SAME_SITE || "strict"}`.toLowerCase();
if (!["strict", "lax", "none"].includes(sameSite)) {
  throw new Error("SESSION_COOKIE_SAME_SITE must be strict, lax, or none");
}

const env = {
  nodeEnv: process.env.NODE_ENV || "development",
  apiHost: process.env.API_HOST || "127.0.0.1",
  apiPort: numberEnv("API_PORT", 4340),
  frontendOrigins: listEnv("FRONTEND_ORIGINS"),
  appPublicUrl: process.env.APP_PUBLIC_URL || "",
  jwtSecret,
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || "12h",
  bcryptRounds: numberEnv("BCRYPT_ROUNDS", 12),
  loginRateLimitMax: numberEnv("LOGIN_RATE_LIMIT_MAX", 5),
  // JSON body ceilings in MB. Excel uploads travel as base64 in the body, so
  // only the two import routes get the larger one.
  bodyLimitMb: numberEnv("JSON_BODY_LIMIT_MB", 2),
  uploadBodyLimitMb: numberEnv("UPLOAD_BODY_LIMIT_MB", 12),
  maxUploadMb: numberEnv("MAX_UPLOAD_MB", 8),
  forceHttps: boolEnv("FORCE_HTTPS"),
  enableHsts: boolEnv("ENABLE_HSTS"),
  trustProxyHops: numberEnv("TRUST_PROXY_HOPS", 0),
  mailSchedulerEnabled: boolEnv("MAIL_SCHEDULER_ENABLED", true),
  session: {
    secret: sessionSecret,
    cookieName: process.env.SESSION_COOKIE_NAME || "psa_session",
    cookieSecure: boolEnv("SESSION_COOKIE_SECURE"),
    cookieSameSite: sameSite,
    idleTimeoutMinutes: numberEnv("SESSION_IDLE_TIMEOUT_MINUTES", 30)
  },
  sql: {
    server: process.env.SQL_SERVER || "127.0.0.1",
    port: numberEnv("SQL_PORT", 1433),
    database: process.env.SQL_DATABASE || "Purchase_Alert",
    user: process.env.SQL_USER,
    password: process.env.SQL_PASSWORD,
    options: {
      encrypt: boolEnv("SQL_ENCRYPT"),
      trustServerCertificate: boolEnv("SQL_TRUST_SERVER_CERTIFICATE", true)
    }
  },
  smtp: {
    host: process.env.SMTP_HOST || "",
    port: numberEnv("SMTP_PORT", 587),
    secure: boolEnv("SMTP_SECURE"),
    user: process.env.SMTP_USER || "",
    password: process.env.SMTP_PASSWORD || "",
    from: process.env.SMTP_FROM || ""
  }
};

module.exports = { env };
