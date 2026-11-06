"use strict";
// Deletes every PO (items, steps, history), import batch and PO alert mail from
// the database in backend/.env, so testing can start from an empty PO list.
// Users, sections, settings, workflow steps, holidays and the supplier and
// material masters are kept. Suppliers that a PO import added on its own are
// removed too, unless a material still points at them.
//   node scripts/clear-po-data.js          -> counts only
//   node scripts/clear-po-data.js --yes    -> deletes
const { env } = require("../src/config/env");
const { query, withTransaction, closePool } = require("../src/db/pool");

const AUTO_SUPPLIER = "Added automatically from a PO import";

async function counts() {
  const r = await query(`SELECT
    (SELECT COUNT(*) FROM purchase_orders) AS pos,
    (SELECT COUNT(*) FROM po_items) AS items,
    (SELECT COUNT(*) FROM po_steps) AS steps,
    (SELECT COUNT(*) FROM po_history) AS history,
    (SELECT COUNT(*) FROM import_batches) AS batches,
    (SELECT COUNT(*) FROM email_outbox) AS mails,
    (SELECT COUNT(*) FROM mail_runs) AS mailRuns,
    (SELECT COUNT(*) FROM suppliers) AS suppliers,
    (SELECT COUNT(*) FROM suppliers s WHERE s.remark = @auto
       AND NOT EXISTS (SELECT 1 FROM materials m WHERE m.supplier_id = s.id)) AS autoSuppliers,
    (SELECT COUNT(*) FROM materials) AS materials`, { auto: AUTO_SUPPLIER });
  return r.recordset[0];
}

(async () => {
  console.log(`Database: ${env.sql?.database || process.env.SQL_DATABASE}`);
  console.log("Before:", await counts());
  if (!process.argv.includes("--yes")) return;
  await withTransaction(async (tx) => {
    await tx.query("DELETE FROM po_history");
    await tx.query("DELETE FROM po_steps");
    await tx.query("DELETE FROM po_items");
    await tx.query("UPDATE purchase_orders SET split_from_id = NULL");
    await tx.query("DELETE FROM purchase_orders");
    await tx.query("DELETE FROM import_batches");
    await tx.query("DELETE FROM email_outbox");
    await tx.query("DELETE FROM mail_runs");
    await tx.query(
      `DELETE s FROM suppliers s WHERE s.remark = @auto
         AND NOT EXISTS (SELECT 1 FROM materials m WHERE m.supplier_id = s.id)`,
      { auto: AUTO_SUPPLIER }
    );
  });
  console.log("After:", await counts());
})()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => closePool());
