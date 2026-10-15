const express = require("express");
const { query } = require("../../db/pool");
const { isMailConfigured } = require("../../services/mailService");

const router = express.Router();

// Public and session-free (mounted above the session middleware): the login
// page polls it, and that must never keep a session alive.
router.get("/", async (req, res) => {
  let database = "ok";
  try {
    await query("SELECT 1 AS ok");
  } catch {
    database = "offline";
  }
  res.json({ api: "ok", database, mail: isMailConfigured() ? "configured" : "not_configured", time: new Date().toISOString() });
});

module.exports = router;
