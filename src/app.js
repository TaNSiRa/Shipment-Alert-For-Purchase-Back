// The Express app, split from server.js so tests can drive the full API
// in-process (supertest) without opening a port or starting the scheduler.
//
// Request pipeline (same order as RAP):
//   forceHttps -> helmet (strict CSP) -> Permissions-Policy -> CORS allowlist
//   -> compression -> JSON body limits -> rate limit -> /health (no session)
//   -> session -> CSRF -> /auth -> requireAuth -> PDPA consent -> router
//   (-> resolveSection -> role guard -> row check in the handler -> audit)
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

function createApp() {
  const app = express();
  if (env.trustProxyHops > 0) app.set("trust proxy", env.trustProxyHops);
  app.disable("x-powered-by");
  app.use(forceHttps);
  // The API only ever answers JSON or a file download, so its CSP allows
  // nothing at all. (The SPA's own policy lives with the web build.)
  app.use(helmet({
    crossOriginResourcePolicy: false,
    hsts: env.enableHsts,
    contentSecurityPolicy: {
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
    }
  }));
  app.use((req, res, next) => {
    res.setHeader(
      "Permissions-Policy",
      "camera=(), microphone=(), geolocation=(), payment=(), usb=(), magnetometer=(), gyroscope=(), accelerometer=(), midi=(), serial=()"
    );
    next();
  });
  app.use(cors({
    origin(origin, callback) {
      if (!origin || env.frontendOrigins.includes(origin)) return callback(null, true);
      return callback(Object.assign(new Error("Not allowed by CORS"), { status: 403 }));
    },
    credentials: true,
    exposedHeaders: ["Content-Disposition"]
  }));
  app.use(compression());

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
