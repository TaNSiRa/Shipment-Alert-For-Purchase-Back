// Brings the database up to date and says plainly what is still wrong.
//
//   npm run db:check
//
// 1. Applies database/schema.sql (the same idempotent run the API does at
//    start-up) and prints every batch the server refused, with the reason.
// 2. Checks every table and column schema.sql guards with OBJECT_ID / COL_LENGTH
//    really exists — read from schema.sql itself, so it never goes stale.
// 3. Prints who the API connects as and whether that login may change tables.
//
// Exit code 0 = nothing missing, 1 = something is. Changes nothing but what
// schema.sql would add anyway.
const fs = require("fs");
const path = require("path");
const sql = require("mssql");
const { env } = require("../src/config/env");
const { applySchema } = require("../src/db/initDb");

function expectedObjects() {
  const text = fs.readFileSync(path.resolve(__dirname, "../../database/schema.sql"), "utf8");
  const tables = new Set();
  const columns = new Map(); // "table.column" -> [table, column]
  for (const m of text.matchAll(/OBJECT_ID\('dbo\.(\w+)',\s*'U'\)\s+IS\s+NULL/gi)) tables.add(m[1]);
  for (const m of text.matchAll(/COL_LENGTH\('dbo\.(\w+)',\s*'(\w+)'\)\s+IS\s+NULL/gi)) {
    columns.set(`${m[1]}.${m[2]}`, [m[1], m[2]]);
  }
  return { tables: [...tables], columns: [...columns.values()] };
}

async function main() {
  const pool = await new sql.ConnectionPool({
    server: env.sql.server,
    port: env.sql.port,
    database: env.sql.database,
    user: env.sql.user,
    password: env.sql.password,
    options: env.sql.options
  }).connect();
  let problems = 0;
  try {
    const who = (await pool.request().query(
      `SELECT SUSER_SNAME() AS login, DB_NAME() AS db,
              IS_ROLEMEMBER('db_owner') AS isOwner, IS_ROLEMEMBER('db_ddladmin') AS isDdlAdmin,
              HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'ALTER') AS canAlterDb,
              HAS_PERMS_BY_NAME('dbo.purchase_orders', 'OBJECT', 'ALTER') AS canAlterPo`
    )).recordset[0];
    console.log(`Database ${who.db} as ${who.login}`);
    console.log(`  db_owner: ${who.isOwner ? "yes" : "no"} · db_ddladmin: ${who.isDdlAdmin ? "yes" : "no"} · ` +
      `ALTER purchase_orders: ${who.canAlterPo ? "yes" : "NO"}`);

    console.log("\nApplying database/schema.sql …");
    const { batches, failures } = await applySchema(text => pool.request().query(text));
    if (!failures.length) {
      console.log(`  OK — ${batches} batches`);
    } else {
      problems += failures.length;
      console.log(`  ${failures.length} of ${batches} batches FAILED:`);
      for (const f of failures) console.log(`  - batch ${f.batch}: ${f.message}\n      at: ${f.statement}`);
    }

    console.log("\nChecking tables and columns …");
    const { tables, columns } = expectedObjects();
    const missing = [];
    for (const t of tables) {
      const r = (await pool.request().input("t", `dbo.${t}`).query("SELECT OBJECT_ID(@t, 'U') AS id")).recordset[0];
      if (r.id == null) missing.push(`table ${t}`);
    }
    for (const [t, c] of columns) {
      const r = (await pool.request().input("t", `dbo.${t}`).input("c", c)
        .query("SELECT COL_LENGTH(@t, @c) AS len")).recordset[0];
      if (r.len == null) missing.push(`column ${t}.${c}`);
    }
    if (!missing.length) {
      console.log(`  OK — ${tables.length} tables, ${columns.length} added columns all present`);
    } else {
      problems += missing.length;
      console.log(`  MISSING (${missing.length}):`);
      for (const m of missing) console.log(`  - ${m}`);
    }

    // The checks above trust schema.sql. If the server has a NEWER backend
    // but an OLDER database/schema.sql (only backend/ was copied), schema.sql
    // does not know the new columns and both checks pass — so also run the
    // very SELECT the Dashboard, Shipments and Road Map pages run.
    console.log("\nRunning the PO list query the pages use …");
    const { PO_COLUMNS, PO_FROM } = require("../src/services/poService");
    try {
      await pool.request().query(`SELECT TOP 0 ${PO_COLUMNS} ${PO_FROM}`);
      console.log("  OK");
    } catch (err) {
      problems += 1;
      console.log(`  FAILED: ${err.message}`);
      console.log("  The code needs a column this database does not have. Copy database/schema.sql");
      console.log("  from the same version as backend/ to the server, then run this again.");
    }
    const schemaFile = path.resolve(__dirname, "../../database/schema.sql");
    console.log(`\nschema.sql used: ${schemaFile} (modified ${fs.statSync(schemaFile).mtime.toISOString()})`);
  } finally {
    await pool.close();
  }
  console.log(problems ? "\nNot up to date — see above." : "\nDatabase is up to date.");
  process.exit(problems ? 1 : 0);
}

main().catch(err => {
  console.error(`Could not check the database: ${err.message}`);
  process.exit(1);
});
