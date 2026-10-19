// The Express app, split from Purchase-Alert.js so tests can drive the full API
// in-process (supertest) without opening a port or starting the scheduler.
//
// Request pipeline (same order as RAP):
//   forceHttps -> helmet -> CSP (API: none at all / web build: see webCsp)
//   -> Permissions-Policy -> CORS allowlist
//   -> compression -> JSON body limits -> rate limit -> /health (no session)
//   -> session -> CSRF -> /auth -> requireAuth -> PDPA consent -> router
//   (-> resolveSection -> role guard -> row check in the handler -> audit)
const path = require("path");
const compression = require("compression");
const cors = require("cors");
const express = require("express");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const { env } = require("./config/env");
const { notFound, errorHandler } = require("./middleware/errorHandler");
const { requireAuth } = require("./middleware/auth");
const { csrfProtection, forceHttps, sessionMiddleware } = require("./services/securityService");
const { requirePdpaConsent } = require("./services/pdpa");

const healthRoutes = require("./modules/health/health.routes");
const authRoutes = require("./modules/auth/auth.routes");
const profileRoutes = require("./modules/profile/profile.routes");
const userRoutes = require("./modules/users/users.routes");
const masterRoutes = require("./modules/masters/masters.routes");
const poRoutes = require("./modules/pos/pos.routes");
const workflowRoutes = require("./modules/workflow/workflow.routes");
const reportRoutes = require("./modules/reports/reports.routes");
const settingsRoutes = require("./modules/settings/settings.routes");
const adminRoutes = require("./modules/admin/admin.routes");

// The API only ever answers JSON or a file download, so its CSP allows
// nothing at all.
const apiCsp = helmet.contentSecurityPolicy({
  useDefaults: false,
  directives: {
    defaultSrc: ["'none'"],
    baseUri: ["'self'"],
    formAction: ["'self'"],
    frameAncestors: ["'none'"],
    objectSrc: ["'none'"],
    scriptSrc: ["'none'"],
    styleSrc: ["'none'"],
    imgSrc: ["'none'"],
    fontSrc: ["'none'"],
    connectSrc: ["'self'"]
  }
});

// The Flutter web app (release build made with `flutter build web --csp
// --no-web-resources-cdn`, see the README). What each exception is for:
//   script 'wasm-unsafe-eval'  CanvasKit / skwasm are WebAssembly
//   style  'unsafe-inline'     the engine writes <style> and style="" itself
//   img/font data: blob:       avatars (data: URLs), decoded images, fonts
//   worker blob:               the engine's helper workers
//   connect ws(s)://host       Socket.IO (/ws) on this same host
// No CDN anywhere: CanvasKit and every font ship inside the build, which is
// also what lets the factory PCs run it offline.
const webCsp = helmet.contentSecurityPolicy({
  useDefaults: false,
  directives: {
    defaultSrc: ["'self'"],
    baseUri: ["'self'"],
    formAction: ["'self'"],
    frameAncestors: ["'none'"],
    objectSrc: ["'none'"],
    scriptSrc: ["'self'", "'wasm-unsafe-eval'"],
    styleSrc: ["'self'", "'unsafe-inline'"],
    imgSrc: ["'self'", "data:", "blob:"],
    fontSrc: ["'self'", "data:"],
    workerSrc: ["'self'", "blob:"],
    connectSrc: ["'self'", req => `ws://${req.get("host")}`, req => `wss://${req.get("host")}`],
    manifestSrc: ["'self'"]
  }
});

function isWebRequest(req) {
  if (!env.webRoot) return false;
  const p = req.path.toLowerCase();
  return !(p === "/api" || p.startsWith("/api/") || p === "/ws" || p.startsWith("/ws/"));
}

// Static files of the web build, plus index.html for any other GET that is not
// an API call. index.html is never cached, so a new build is picked up on the
// next reload; the hashed/versioned files around it may be.
function webApp() {
  const indexFile = path.join(env.webRoot, "index.html");
  const files = express.static(env.webRoot, {
    index: "index.html",
    setHeaders(res, filePath) {
      if (path.basename(filePath) === "index.html") res.setHeader("Cache-Control", "no-cache");
    }
  });
  return (req, res, next) => {
    if (!isWebRequest(req) || !["GET", "HEAD"].includes(req.method)) return next();
    files(req, res, () => {
      res.setHeader("Cache-Control", "no-cache");
      res.sendFile(indexFile, err => (err ? next() : undefined));
    });
  };
}

function createApp() {
  const app = express();
  if (env.trustProxyHops > 0) app.set("trust proxy", env.trustProxyHops);
  app.disable("x-powered-by");
  app.use(forceHttps);
  // Every helmet header except the CSP, which differs between the API and the
  // web app (when this process serves the web build too — WEB_ROOT).
  app.use(helmet({ crossOriginResourcePolicy: false, hsts: env.enableHsts, contentSecurityPolicy: false }));
  app.use((req, res, next) => (isWebRequest(req) ? webCsp : apiCsp)(req, res, next));
  app.use((req, res, next) => {
    res.setHeader(
      "Permissions-Policy",
      "camera=(), microphone=(), geolocation=(), payment=(), usb=(), magnetometer=(), gyroscope=(), accelerometer=(), midi=(), serial=()"
    );
    next();
  });
  // Cross-origin callers must be on the allowlist. A page served by this very
  // API (WEB_ROOT) is same-origin — browsers still send an Origin header on
  // its POSTs, and refusing those would lock the app out of its own API.
  app.use(cors((req, callback) => {
    const origin = req.headers.origin;
    let allowed = !origin || env.frontendOrigins.includes(origin);
    if (!allowed) {
      try {
        allowed = new URL(origin).host === req.get("host");
      } catch {
        allowed = false;
      }
    }
    if (!allowed) return callback(Object.assign(new Error("Not allowed by CORS"), { status: 403 }));
    callback(null, { origin: true, credentials: true, exposedHeaders: ["Content-Disposition"] });
  }));
  app.use(compression());
  // Ahead of the rate limit and the session: loading the app's own files is
  // neither an API call nor activity that should keep a session alive.
  if (env.webRoot) app.use(webApp());

  // The wider parsers FIRST: body-parser consumes the stream, so the general
  // 2 MB parser below would otherwise reject an Excel upload before the
  // larger limit ever ran.
  const uploadJson = express.json({ limit: `${env.uploadBodyLimitMb}mb` });
  app.use("/api/pos/import", uploadJson);
  app.use("/api/masters/import", uploadJson);
  app.use("/api/profile/avatar", express.json({ limit: "1mb" }));
  app.use(express.json({ limit: `${env.bodyLimitMb}mb` }));
  app.use(rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 3000,
    standardHeaders: true,
    legacyHeaders: false,
    message: { message: "Too many requests, please slow down and try again shortly." }
  }));

  app.use("/api/health", healthRoutes);
  app.use(sessionMiddleware());
  app.use(csrfProtection);
  app.use("/api/auth", authRoutes);

  const guarded = [
    ["/api/profile", profileRoutes],
    ["/api/users", userRoutes],
    ["/api/masters", masterRoutes],
    ["/api/pos", poRoutes],
    ["/api/workflow", workflowRoutes],
    ["/api/reports", reportRoutes],
    ["/api/settings", settingsRoutes],
    ["/api/admin", adminRoutes]
  ];
  for (const [path, router] of guarded) app.use(path, requireAuth, requirePdpaConsent, router);

  app.use(notFound);
  app.use(errorHandler);
  return app;
}

module.exports = { createApp };
