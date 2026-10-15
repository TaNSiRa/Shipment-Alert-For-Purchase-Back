// Test bootstrap. MUST be required before anything from src/: it pins the
// environment the app reads at load time.
//
// Safety: tests run against their own database (Purchase_Alert_Test) on a
// LOCAL SQL Server only, with SMTP blanked so no mail can leave the machine.
// dotenv never overrides variables that are already set, so these win over
// backend/.env.
const path = require("path");
const fs = require("fs");

process.env.SQL_DATABASE = "Purchase_Alert_Test";
process.env.MAIL_SCHEDULER_ENABLED = "false";
process.env.SMTP_HOST = "";
process.env.SMTP_FROM = "";
process.env.LOGIN_RATE_LIMIT_MAX = "1000";
process.env.BCRYPT_ROUNDS = "4";
process.env.NODE_ENV = "test";

require("dotenv").config({ path: path.resolve(__dirname, "../.env") });
if (!["127.0.0.1", "localhost", "(local)", "."].includes(`${process.env.SQL_SERVER}`.toLowerCase())) {
  throw new Error(`Refusing to run tests against non-local SQL_SERVER=${process.env.SQL_SERVER}`);
}

const bcrypt = require("bcryptjs");
const request = require("supertest");
const { initDatabase } = require("../src/db/initDb");
const { query, closePool } = require("../src/db/pool");
const { POLICY_VERSION } = require("../src/services/pdpa");
const { applyMasterBuffer } = require("../src/services/masterImport");
const { resetAccountStateCache } = require("../src/services/accountState");
const { createApp } = require("../src/app");

const DATA_DIR = path.resolve(__dirname, "../../ข้อมูล");
const MASTER_FILE = path.join(DATA_DIR, "Power App for Export process R1 - backup.xlsx");
const SAP_FILE = path.join(DATA_DIR, "Shipment EX-26-W87", "DATA BY SAP.xlsx");
const PASSWORD = "Passw0rd!test";

const WIPE = [
  "po_history", "po_steps", "po_items", "purchase_orders", "import_batches", "materials", "suppliers",
  "email_outbox", "mail_runs", "audit_logs", "holidays", "app_settings", "user_section_memberships", "users"
];

async function setupDatabase() {
  const { pool } = await initDatabase({ log: () => {} });
  await pool.close();
  for (const table of WIPE) await query(`DELETE FROM ${table}`);
  await query("DELETE FROM workflow_steps WHERE section_id IN (SELECT id FROM sections WHERE code <> 'PUR')");
  await query("DELETE FROM sections WHERE code <> 'PUR'");
  await query("DELETE FROM workflow_steps");
  await query("IF NOT EXISTS (SELECT 1 FROM sections WHERE code = 'QA') INSERT INTO sections (code, name) VALUES ('QA', 'QA Purchase')");
  const { pool: p2 } = await initDatabase({ log: () => {} });
  await p2.close();
  resetAccountStateCache();

  const sections = Object.fromEntries((await query("SELECT id, code FROM sections")).recordset.map(s => [s.code, s.id]));
  const roles = Object.fromEntries((await query("SELECT id, code FROM roles")).recordset.map(r => [r.code, r.id]));
  const hash = await bcrypt.hash(PASSWORD, 4);
  const users = {};
  const make = async (key, role, memberships) => {
    const id = (await query(
      `INSERT INTO users (email, display_name, password_hash, role_id, pdpa_consent_accepted, pdpa_policy_version)
       OUTPUT INSERTED.id VALUES (@email, @name, @hash, @roleId, 1, @version)`,
      { email: `${key}@test.local`, name: key, hash, roleId: roles[role], version: POLICY_VERSION }
    )).recordset[0].id;
    for (const [code, flags] of Object.entries(memberships)) {
      await query(
        "INSERT INTO user_section_memberships (user_id, section_id, can_edit, is_section_admin) VALUES (@id, @sid, @canEdit, @isSa)",
        { id, sid: sections[code], canEdit: flags.canEdit ? 1 : 0, isSa: flags.sa ? 1 : 0 }
      );
    }
    users[key] = { id, email: `${key}@test.local` };
  };
  await make("admin", "ADMIN", { PUR: { canEdit: true, sa: true } });
  await make("secadmin", "SECTION_ADMIN", { PUR: { canEdit: true, sa: true } });
  await make("buyer", "USER", { PUR: { canEdit: true } });
  await make("buyer2", "USER", { PUR: { canEdit: true } });
  await make("viewer", "VIEWER", { PUR: { canEdit: false } });
  await make("qa", "USER", { QA: { canEdit: true } });

  await applyMasterBuffer(sections.PUR, fs.readFileSync(MASTER_FILE));
  return { sections, users };
}

const app = createApp();

async function login(email, password = PASSWORD) {
  const agent = request.agent(app);
  const res = await agent.post("/api/auth/login").send({ email, password });
  if (res.status !== 200) throw new Error(`login ${email} failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { agent, token: res.body.token, csrf: res.body.csrfToken, user: res.body.user };
}

// Bearer-token client for one user and one section.
function client(token, section = "PUR") {
  const wrap = method => (url, body) => {
    let r = request(app)[method](`/api${url}`).set("Authorization", `Bearer ${token}`);
    if (section) r = r.set("X-Section-Code", section);
    return body !== undefined ? r.send(body) : r;
  };
  return { get: wrap("get"), post: wrap("post"), patch: wrap("patch"), put: wrap("put"), delete: wrap("delete") };
}

function fileBase64(file) {
  return fs.readFileSync(file).toString("base64");
}

module.exports = { MASTER_FILE, PASSWORD, SAP_FILE, app, client, closePool, fileBase64, login, query, setupDatabase };
