// Creates the database (if missing), applies database/schema.sql, seeds the
// default workflow for every section and — only when there are no users at
// all — a first system admin.
//
//   npm run db:init
//   npm run db:init -- --admin-email you@company.com --admin-password 'S0mething-long'
//
// Safe to run again: the schema is idempotent and nothing is overwritten.
const bcrypt = require("bcryptjs");
const { env } = require("../src/config/env");
const { initDatabase } = require("../src/db/initDb");

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function main() {
  const { runner, pool } = await initDatabase();
  try {
    const users = (await runner.query("SELECT COUNT(1) AS n FROM users")).recordset[0].n;
    if (users > 0) {
      console.log(`${users} user(s) already exist — no admin seeded`);
      return;
    }
    const email = arg("admin-email", "admin@local.test");
    const password = arg("admin-password", "Admin@12345");
    const hash = await bcrypt.hash(password, env.bcryptRounds);
    const roleId = (await runner.query("SELECT id FROM roles WHERE code = 'ADMIN'")).recordset[0].id;
    const userId = (await runner.query(
      `INSERT INTO users (email, display_name, full_name, password_hash, role_id, department)
       OUTPUT INSERTED.id VALUES (@email, N'System Admin', N'System Administrator', @hash, @roleId, N'Automation')`,
      { email, hash, roleId }
    )).recordset[0].id;
    const pur = (await runner.query("SELECT id FROM sections WHERE code = 'PUR'")).recordset[0];
    if (pur) {
      await runner.query(
        "INSERT INTO user_section_memberships (user_id, section_id, can_edit, is_section_admin) VALUES (@userId, @sectionId, 1, 1)",
        { userId, sectionId: pur.id }
      );
    }
    console.log(`First admin created: ${email}  (change the password after the first sign-in)`);
  } finally {
    await pool.close();
  }
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
