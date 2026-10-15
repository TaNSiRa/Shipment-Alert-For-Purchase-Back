const fs = require("fs");
const path = require("path");
const sql = require("mssql");
const { env } = require("../config/env");

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
    const schema = fs.readFileSync(path.resolve(__dirname, "../../../database/schema.sql"), "utf8").replace(/^﻿/, "");
    const batches = schema.split(/^\s*GO\s*$/im).map(b => b.trim()).filter(Boolean);
    for (const batch of batches) await pool.request().query(batch);
    log(`Schema applied (${batches.length} batches)`);

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

module.exports = { initDatabase };
