// Demo data for trying the system locally:
//   * imports every "DATA*SAP*.xlsx" found under ../ข้อมูล (the real SAP samples)
//     through the same code as the Import button,
//   * moves those POs along realistic steps,
//   * adds a few recent DEMO- POs so "due soon" / "overdue" have something,
//   * creates one demo account per role.
//
//   npm run db:seed-demo            (safe to run twice — existing POs are skipped)
//
// Remove the demo POs later with: DELETE FROM purchase_orders WHERE po_no LIKE 'DEMO-%'
const fs = require("fs");
const path = require("path");
const bcrypt = require("bcryptjs");
const { env } = require("../src/config/env");
const { query, withTransaction, closePool } = require("../src/db/pool");
const { POLICY_VERSION } = require("../src/services/pdpa");
const { addDays, todayIso, diffDays } = require("../src/services/dates");
const { advancePo, createPo, loadContext } = require("../src/services/poService");
const poImport = require("../src/services/poImport");

const DATA_DIR = path.resolve(__dirname, "../../ข้อมูล");
const DEMO_PASSWORD = "Purchase@2026";

function findSapFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...findSapFiles(full));
    else if (/^DATA.*SAP.*\.xlsx$/i.test(entry.name) && !entry.name.startsWith("~$")) out.push(full);
  }
  return out;
}

// Small deterministic "random" so every run gives the same demo.
function rand(seed) {
  let h = 0;
  for (const ch of `${seed}`) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return (h % 1000) / 1000;
}

async function ensureUser(email, name, role, sectionId, { sa = false, canEdit = true } = {}) {
  const existing = (await query("SELECT id FROM users WHERE email = @email", { email })).recordset[0];
  if (existing) return existing.id;
  const hash = await bcrypt.hash(DEMO_PASSWORD, env.bcryptRounds);
  const id = (await query(
    `INSERT INTO users (email, display_name, full_name, password_hash, role_id, department, position, pdpa_consent_accepted, pdpa_policy_version)
     OUTPUT INSERTED.id
     VALUES (@email, @name, @name, @hash, (SELECT id FROM roles WHERE code = @role), N'Purchase', @position, 1, @version)`,
    { email, name, hash, role, position: role === "SECTION_ADMIN" ? "Purchase Supervisor" : "Purchasing Officer", version: POLICY_VERSION }
  )).recordset[0].id;
  await query(
    "INSERT INTO user_section_memberships (user_id, section_id, can_edit, is_section_admin) VALUES (@id, @sectionId, @canEdit, @sa)",
    { id, sectionId, canEdit: canEdit ? 1 : 0, sa: sa ? 1 : 0 }
  );
  return id;
}

async function main() {
  const section = (await query("SELECT id FROM sections WHERE code = 'PUR'")).recordset[0];
  if (!section) throw new Error("Run npm run db:init first");
  const sectionId = section.id;

  const buyerId = await ensureUser("buyer@local.test", "Demo Buyer", "USER", sectionId);
  await ensureUser("supervisor@local.test", "Demo Supervisor", "SECTION_ADMIN", sectionId, { sa: true });
  await ensureUser("viewer@local.test", "Demo Viewer", "VIEWER", sectionId, { canEdit: false });
  const buyer = { id: buyerId };

  const ctx = await loadContext(sectionId);
  const files = findSapFiles(DATA_DIR);
  for (const file of files) {
    const data = fs.readFileSync(file).toString("base64");
    try {
      const r = await poImport.commit(sectionId, { fileName: path.basename(file), data }, buyer, ctx);
      console.log(`Imported ${r.created.length} PO(s) from ${path.relative(DATA_DIR, file)}`);
    } catch (err) {
      console.log(`${path.relative(DATA_DIR, file)}: ${err.message}`);
    }
  }

  // Walk each imported PO along its plan with a little slip, stopping at a
  // step that depends on how old it is — older POs are further along.
  const today = todayIso();
  const pos = (await query(
    "SELECT id, po_no, document_date, current_step FROM purchase_orders WHERE section_id = @sectionId AND status = 'ACTIVE' AND current_step = 2 AND po_no NOT LIKE 'DEMO-%'",
    { sectionId }
  )).recordset;
  for (const po of pos) {
    const age = diffDays(new Date(po.document_date).toISOString().slice(0, 10), today);
    const r = rand(po.po_no);
    const stopAt = age > 150 ? (r < 0.55 ? 10 : r < 0.8 ? 9 : 8) : age > 60 ? 5 + Math.floor(r * 4) : 2 + Math.floor(r * 3);
    for (let step = 2; step < stopAt; step += 1) {
      const detail = (await query("SELECT due_date FROM po_steps WHERE po_id = @id AND step_no = @step", { id: po.id, step })).recordset[0];
      const due = new Date(detail.due_date).toISOString().slice(0, 10);
      let actual = addDays(due, Math.round((rand(`${po.po_no}${step}`) - 0.4) * 8));
      if (actual > today) actual = today;
      const prev = (await query("SELECT actual_date FROM po_steps WHERE po_id = @id AND step_no = @step", { id: po.id, step: step - 1 })).recordset[0];
      const prevIso = new Date(prev.actual_date).toISOString().slice(0, 10);
      if (actual < prevIso) actual = prevIso;
      await advancePo(po.id, sectionId, {
        actualDate: actual,
        referenceNo: step === 2 ? "141-02-W059" : step === 4 ? "EX-26-W87" : step === 6 ? `INV-${po.po_no.slice(-4)}` : null
      }, buyer, ctx);
    }
  }
  console.log(`Advanced ${pos.length} imported PO(s)`);

  // Recent POs so the dashboard has due-soon and overdue rows.
  const materials = (await query(
    `SELECT TOP 40 m.id, m.material_code, m.description, m.vendor_material, m.material_type, m.lead_time_days, m.supplier_id,
            s.supplier_code, s.name
     FROM materials m JOIN suppliers s ON s.id = m.supplier_id
     WHERE m.section_id = @sectionId AND m.material_code IS NOT NULL ORDER BY m.id`,
    { sectionId }
  )).recordset;
  const recent = [3, 9, 14, 16, 21, 30, 44, 58];
  let made = 0;
  for (let i = 0; i < recent.length; i += 1) {
    const poNo = `DEMO-${String(i + 1).padStart(3, "0")}`;
    const exists = (await query("SELECT id FROM purchase_orders WHERE section_id = @sectionId AND po_no = @poNo", { sectionId, poNo })).recordset[0];
    if (exists) continue;
    const m = materials[(i * 5) % materials.length];
    const documentDate = addDays(today, -recent[i]);
    const supplier = (await query("SELECT * FROM suppliers WHERE id = @id", { id: m.supplier_id })).recordset[0];
    const id = await withTransaction(tx => createPo(tx, {
      sectionId,
      userId: buyerId,
      source: "MANUAL",
      po: {
        poNo, supplierId: supplier.id, supplier, supplierCode: supplier.supplier_code, supplierName: supplier.name,
        documentDate, shipMode: i % 3 === 0 ? "AIR" : "SEA", currency: "JPY", remark: "Demo PO — safe to delete"
      },
      items: [{
        itemNo: "10", materialId: m.id, materialCode: m.material_code, shortText: m.description, vendorMaterial: m.vendor_material,
        materialType: m.material_type, orderQty: 4 + i, orderUnit: "CAN", netPrice: 12000 + i * 900, currency: "JPY", leadTimeDays: m.lead_time_days
      }]
    }, ctx));
    if (recent[i] >= 21) {
      await advancePo(id, sectionId, { actualDate: addDays(documentDate, 13 + (i % 4)), referenceNo: "141-03-W019" }, buyer, ctx);
      await advancePo(id, sectionId, { actualDate: addDays(documentDate, 15 + (i % 4)) }, buyer, ctx);
    }
    made += 1;
  }
  console.log(`Created ${made} recent DEMO- PO(s)`);
  console.log(`Demo accounts (password ${DEMO_PASSWORD}): buyer@local.test, supervisor@local.test, viewer@local.test`);
}

main()
  .catch(err => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => closePool());
