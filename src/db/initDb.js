const fs = require("fs");
const path = require("path");
const sql = require("mssql");
const { env } = require("../config/env");

// Errors that mean "no database to talk to", as opposed to "this one statement
// was refused". Only these stop the run: every later batch would fail the same
// way, and /health already reports the database as down.
const CONNECTION_ERRORS = new Set(["ESOCKET", "ETIMEOUT", "ELOGIN", "ENOTOPEN", "ECONNCLOSED", "EINSTLOOKUP"]);

// The first line of a batch that is not a comment — enough to find it in
// schema.sql from a log line.
function firstStatement(batch) {
  const line = batch.split(/\r?\n/).map(l => l.trim()).find(l => l && !l.startsWith("--")) || "";
  return line.length > 140 ? `${line.slice(0, 140)}…` : line;
}

// Runs database/schema.sql batch by batch through runQuery(text). Every batch
// is guarded (IF ... IS NULL), so it is safe on a database already up to date.
//
// A batch that fails does NOT stop the ones after it. It used to: one refused
// statement early in the file (a unique index the existing data breaks, a
// permission the server's SQL login lacks) silently left every later column
// uncreated, and the pages reading those columns answered 500 with nothing but
// "[migrations] …" in the log to say why. Now each failure is collected and
// returned, and everything that can be applied is.
//
// Returns { batches, failures: [{ batch, statement, message }] }.
async function applySchema(runQuery) {
  const schema = fs.readFileSync(path.resolve(__dirname, "../../../database/schema.sql"), "utf8").replace(/^﻿/, "");
  const batches = schema.split(/^\s*GO\s*$/im).map(b => b.trim()).filter(Boolean);
  const failures = [];
  for (const [i, batch] of batches.entries()) {
    try {
      await runQuery(batch);
    } catch (err) {
      if (CONNECTION_ERRORS.has(err.code) || err.name === "ConnectionError") throw err;
      failures.push({ batch: i + 1, statement: firstStatement(batch), message: err.message });
    }
  }
  return { batches: batches.length, failures };
}

// One line per failed batch, prefixed so it stands out in `pm2 logs`.
function logSchemaFailures(failures, log = console.error) {
  for (const f of failures) {
    log(`[schema] batch ${f.batch} failed: ${f.message}\n[schema]   at: ${f.statement}`);
  }
}

// Creates the database when missing and applies database/schema.sql (which is
// idempotent), then makes sure every section has its workflow steps.
async function initDatabase({ log = console.log } = {}) {
  const base = {
    server: env.sql.server,
    port: env.sql.port,
    user: env.sql.user,
    password: env.sql.password,
    options: env.sql.options
  };
  const dbName = env.sql.database;
  if (!/^[A-Za-z0-9_]+$/.test(dbName)) throw new Error(`Unsafe database name: ${dbName}`);

  const master = await new sql.ConnectionPool({ ...base, database: "master" }).connect();
  await master.request().query(`IF DB_ID(N'${dbName}') IS NULL CREATE DATABASE [${dbName}]`);
  await master.close();
  log(`Database ${dbName} ready`);

  const pool = await new sql.ConnectionPool({ ...base, database: dbName }).connect();
  try {
    const { batches, failures } = await applySchema(text => pool.request().query(text));
    log(`Schema applied (${batches} batches${failures.length ? `, ${failures.length} FAILED` : ""})`);
    logSchemaFailures(failures);

    const { insertDefaultSteps } = require("../services/workflowService");
    const runner = {
      query: (text, params = {}) => {
        const req = pool.request();
        for (const [k, v] of Object.entries(params)) req.input(k, v === undefined ? null : v);
        return req.query(text);
      }
    };
    const { runMigrations } = require("./migrations");
    await runMigrations(runner, log);
    const sections = (await pool.request().query("SELECT id FROM sections")).recordset;
    for (const s of sections) await insertDefaultSteps(runner, s.id);
    log(`Workflow steps ensured for ${sections.length} section(s)`);
    return { runner, pool, sections };
  } catch (err) {
    await pool.close();
    throw err;
  }
}

module.exports = { applySchema, initDatabase, logSchemaFailures };
