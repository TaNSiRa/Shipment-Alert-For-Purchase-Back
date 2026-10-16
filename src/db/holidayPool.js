const sql = require("mssql");
const { env } = require("../config/env");
const { query } = require("./pool");

// Dedicated connection to the read-only external "holidays" database (the SAR
// system's Master_Holiday table) — the same source RAP reads. It is kept fully
// separate from the app's own pool: a private ConnectionPool (never
// sql.connect, which sets the global pool). host/database/table can be
// overridden from Settings; the rest (credentials/port/options) come from env.

const SETTING_KEYS = ["holiday.host", "holiday.database", "holiday.table", "holiday.enabled"];

let currentPool = null;
let currentSignature = "";
let warnedOnce = false;

// The schedule maths asks for holidays on every PO request; the external DB
// changes a few times a year. Keep each range for a few minutes.
const CACHE_MS = 10 * 60 * 1000;
const cache = new Map();

// Table/column identifiers can't be parameterized — allow only safe names.
const IDENT = /^[A-Za-z0-9_]+$/;

async function readOverrides() {
  try {
    const rows = (await query(
      `SELECT setting_key, setting_value FROM app_settings
       WHERE section_id IS NULL AND setting_key IN ('holiday.host','holiday.database','holiday.table','holiday.enabled')`
    )).recordset;
    const map = {};
    for (const r of rows) map[r.setting_key] = `${r.setting_value ?? ""}`.trim();
    return map;
  } catch {
    return {};
  }
}

async function effectiveConfig() {
  const o = await readOverrides();
  return {
    enabled: `${o["holiday.enabled"] ?? "true"}`.toLowerCase() !== "false",
    server: o["holiday.host"] || env.holiday.server,
    database: o["holiday.database"] || env.holiday.database,
    table: o["holiday.table"] || env.holiday.table,
    dateColumn: env.holiday.dateColumn,
    port: env.holiday.port,
    user: env.holiday.user,
    password: env.holiday.password,
    options: env.holiday.options
  };
}

function isConfigured(cfg) {
  return Boolean(cfg.enabled && cfg.server && cfg.database && cfg.table);
}

async function getPoolFor(cfg) {
  const signature = JSON.stringify({
    server: cfg.server, port: cfg.port, database: cfg.database, user: cfg.user, options: cfg.options
  });
  if (currentPool && signature === currentSignature) return currentPool;
  // Config changed — drop the old pool.
  if (currentPool) {
    try { await currentPool.close(); } catch { /* ignore */ }
    currentPool = null;
  }
  const pool = new sql.ConnectionPool({
    server: cfg.server,
    port: cfg.port,
    database: cfg.database,
    user: cfg.user,
    password: cfg.password,
    options: cfg.options,
    connectionTimeout: 5000,
    requestTimeout: 10000,
    pool: { max: 4, min: 0, idleTimeoutMillis: 30000 }
  });
  await pool.connect();
  currentPool = pool;
  currentSignature = signature;
  warnedOnce = false;
  return pool;
}

/**
 * Holiday dates (YYYY-MM-DD) within [from, to] inclusive.
 * Returns { configured, dates }. Never throws — a missing config or an
 * unreachable DB yields configured:false / [] so the app keeps working.
 */
async function getHolidayDates(from, to) {
  const key = `${from}|${to}`;
  const hit = cache.get(key);
  if (hit && hit.at > Date.now() - CACHE_MS) return hit.value;
  const value = await readHolidayDates(from, to);
  cache.set(key, { at: Date.now(), value });
  return value;
}

async function readHolidayDates(from, to) {
  const cfg = await effectiveConfig();
  if (!isConfigured(cfg)) return { configured: false, dates: [] };
  if (!IDENT.test(cfg.table) || !IDENT.test(cfg.dateColumn)) {
    return { configured: false, dates: [] };
  }
  try {
    const pool = await getPoolFor(cfg);
    const request = pool.request();
    request.input("from", from);
    request.input("to", to);
    const result = await request.query(
      `SELECT DISTINCT [${cfg.dateColumn}] AS d FROM [${cfg.table}]
       WHERE [${cfg.dateColumn}] BETWEEN @from AND @to`
    );
    const dates = result.recordset
      .map(r => toYmd(r.d))
      .filter(Boolean);
    return { configured: true, dates };
  } catch (err) {
    if (!warnedOnce) {
      warnedOnce = true;
      // eslint-disable-next-line no-console
      console.warn(`[holiday] cannot read holidays: ${err.message}`);
    }
    return { configured: false, dates: [] };
  }
}

/**
 * The external DB's holidays within [from, to] with their names (when the
 * table has a Name column), for the Settings list. Never throws.
 */
async function listExternalHolidays(from, to) {
  const cfg = await effectiveConfig();
  if (!isConfigured(cfg) || !IDENT.test(cfg.table) || !IDENT.test(cfg.dateColumn)) {
    return { configured: false, rows: [] };
  }
  try {
    const pool = await getPoolFor(cfg);
    const request = pool.request();
    request.input("from", from);
    request.input("to", to);
    const result = await request.query(
      `SELECT * FROM [${cfg.table}] WHERE [${cfg.dateColumn}] BETWEEN @from AND @to ORDER BY [${cfg.dateColumn}]`
    );
    const seen = new Set();
    const rows = [];
    for (const r of result.recordset) {
      const date = toYmd(r[cfg.dateColumn]);
      if (!date || seen.has(date)) continue;
      seen.add(date);
      rows.push({ date, name: `${r.Name ?? r.name ?? ""}`.trim() || null });
    }
    return { configured: true, rows };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[holiday] cannot list holidays: ${err.message}`);
    return { configured: false, rows: [] };
  }
}

/** Test the holiday DB connection for the Settings page. */
async function verifyHoliday() {
  const cfg = await effectiveConfig();
  if (!isConfigured(cfg)) {
    return { configured: false, ok: false, message: "Holiday DB host/database/table is not set" };
  }
  if (!IDENT.test(cfg.table) || !IDENT.test(cfg.dateColumn)) {
    return { configured: false, ok: false, message: "Table/column name must be alphanumeric/underscore only" };
  }
  try {
    const pool = await getPoolFor(cfg);
    await pool.request().query(`SELECT TOP 1 [${cfg.dateColumn}] FROM [${cfg.table}]`);
    return { configured: true, ok: true, message: `Connected to ${cfg.database} · ${cfg.table}` };
  } catch (err) {
    // The driver's own text names the host, database, and the reason a login
    // failed — useful in the server log, not something to hand back over HTTP
    // even to an admin.
    // eslint-disable-next-line no-console
    console.error(`[holiday] verify failed: ${err.message}`);
    return { configured: true, ok: false, message: "Cannot connect to the holiday database" };
  }
}

/** The Settings card's values: the overrides, with the .env defaults beside them. */
async function holidayDbSettings() {
  const o = await readOverrides();
  return {
    host: o["holiday.host"] || "",
    database: o["holiday.database"] || "",
    table: o["holiday.table"] || "",
    enabled: `${o["holiday.enabled"] ?? "true"}`.toLowerCase() !== "false",
    defaults: { host: env.holiday.server, database: env.holiday.database, table: env.holiday.table },
    credentialsSet: Boolean(env.holiday.user)
  };
}

async function saveHolidayDbSettings(values, userId) {
  const map = {
    "holiday.host": values.host,
    "holiday.database": values.database,
    "holiday.table": values.table,
    "holiday.enabled": values.enabled ? "true" : "false"
  };
  for (const key of SETTING_KEYS) {
    await query(
      `MERGE app_settings AS t
       USING (SELECT @key AS setting_key) AS s ON t.section_id IS NULL AND t.setting_key = s.setting_key
       WHEN MATCHED THEN UPDATE SET setting_value = @value, updated_by = @userId,
         updated_at = DATEADD(HOUR, 7, SYSUTCDATETIME())
       WHEN NOT MATCHED THEN INSERT (section_id, setting_key, setting_value, updated_by, updated_at)
         VALUES (NULL, @key, @value, @userId, DATEADD(HOUR, 7, SYSUTCDATETIME()));`,
      { key, value: map[key] ?? "", userId: userId || null }
    );
  }
  cache.clear();
}

function toYmd(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getUTCFullYear();
  const m = `${d.getUTCMonth() + 1}`.padStart(2, "0");
  const day = `${d.getUTCDate()}`.padStart(2, "0");
  return `${y}-${m}-${day}`;
}

module.exports = { getHolidayDates, holidayDbSettings, listExternalHolidays, saveHolidayDbSettings, verifyHoliday };
