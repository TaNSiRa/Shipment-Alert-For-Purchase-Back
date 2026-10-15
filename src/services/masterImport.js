const { query, withTransaction } = require("../db/pool");
const {
  buildSheet, cellValue, decodeUpload, loadWorkbook, mapHeaders, normalizeMaterialCode, toNumber, toText
} = require("./excelKit");

// Two layouts are recognised, both straight from "Power App for Export process
// R1.xlsx":
//   Supplier Master            CUSTOMER ID | CUSTOMER NAME | SEARCH TERM1
//   Master P2026-2025-2024     Customer ID | Customer Name | Customer Short Name |
//                              Material Code | Type | Vendor Material |
//                              Material Description | Leadtime (Days)
// (The sheets say "Customer" because they were copied from the Export master;
// for purchasing these are suppliers. Both words are accepted.)
const SUPPLIER_ALIASES = {
  code: ["customerid", "supplierid", "suppliercode", "vendorid", "vendorcode", "customercode"],
  name: ["customername", "suppliername", "vendorname", "nameofsupplier"],
  shortName: ["searchterm1", "searchterm", "customershortname", "suppliershortname", "shortname"],
  country: ["country"],
  leadTime: ["defaultleadtime", "defaultleadtimedays", "leadtimedays"],
  email: ["email", "contactemail"]
};

const MATERIAL_ALIASES = {
  supplierCode: SUPPLIER_ALIASES.code,
  supplierName: SUPPLIER_ALIASES.name,
  supplierShort: ["customershortname", "suppliershortname", "shortname", "searchterm1"],
  materialCode: ["materialcode", "material", "materialno", "matno"],
  type: ["type", "materialtype", "mattype"],
  vendorMaterial: ["vendormaterial"],
  description: ["materialdescription", "description", "shorttext"],
  leadTime: ["leadtimedays", "leadtime", "leadtimeday", "matleadtime"]
};

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400 });
}

async function readSheets(buffer) {
  const workbook = await loadWorkbook(buffer);
  const suppliers = new Map(); // code -> { code, name, shortName, ... }
  const materials = new Map(); // key -> row
  let materialRows = 0;
  let supplierRows = 0;
  let skipped = 0;
  const notes = [];
  const sheets = [];

  for (const ws of workbook.worksheets) {
    const mat = mapHeaders(ws, MATERIAL_ALIASES, ["supplierCode", "leadTime", "materialCode"]);
    if (mat) {
      sheets.push({ name: ws.name, kind: "MATERIAL" });
      const get = (row, f) => (mat.columns[f] ? cellValue(row.getCell(mat.columns[f])) : null);
      for (let r = mat.headerRow + 1; r <= ws.rowCount; r += 1) {
        const row = ws.getRow(r);
        const code = toText(get(row, "supplierCode"), 30);
        const leadTime = toNumber(get(row, "leadTime"));
        const materialCode = normalizeMaterialCode(get(row, "materialCode"));
        const vendorMaterial = toText(get(row, "vendorMaterial"), 255);
        const description = toText(get(row, "description"), 255);
        if (!code && !materialCode && !vendorMaterial && !description) continue;
        materialRows += 1;
        if (!code || !Number.isFinite(leadTime) || leadTime <= 0 || leadTime > 365) {
          skipped += 1;
          if (notes.length < 20) notes.push(`${ws.name} row ${r}: missing supplier ID or lead time — skipped`);
          continue;
        }
        if (!suppliers.has(code)) {
          suppliers.set(code, {
            code,
            name: toText(get(row, "supplierName"), 200) || code,
            shortName: toText(get(row, "supplierShort"), 80)
          });
        }
        // The source master repeats some supplier+code pairs with different
        // lead times (e.g. PCC-DG UNIT at 60 and 120 days). One row survives,
        // carrying the LONGER lead time — an ETA that is too early is the
        // expensive mistake.
        const key = materialCode ? `${code}|${materialCode}` : `${code}|~|${vendorMaterial || ""}|${description || ""}`;
        const existing = materials.get(key);
        const rowData = {
          supplierCode: code,
          materialCode,
          type: toText(get(row, "type"), 40),
          vendorMaterial,
          description,
          leadTime: Math.round(leadTime)
        };
        if (!existing) materials.set(key, rowData);
        else {
          if (rowData.leadTime > existing.leadTime) existing.leadTime = rowData.leadTime;
          if (!existing.vendorMaterial && rowData.vendorMaterial) existing.vendorMaterial = rowData.vendorMaterial;
          if (!existing.description && rowData.description) existing.description = rowData.description;
          if (notes.length < 20) notes.push(`${ws.name} row ${r}: duplicate of material ${materialCode || vendorMaterial} for ${code} — merged (kept ${existing.leadTime} days)`);
        }
      }
      continue;
    }
    const sup = mapHeaders(ws, SUPPLIER_ALIASES, ["code", "name"]);
    if (sup) {
      sheets.push({ name: ws.name, kind: "SUPPLIER" });
      const get = (row, f) => (sup.columns[f] ? cellValue(row.getCell(sup.columns[f])) : null);
      for (let r = sup.headerRow + 1; r <= ws.rowCount; r += 1) {
        const row = ws.getRow(r);
        const code = toText(get(row, "code"), 30);
        const name = toText(get(row, "name"), 200);
        if (!code && !name) continue;
        supplierRows += 1;
        if (!code || !name) {
          skipped += 1;
          continue;
        }
        const lt = toNumber(get(row, "leadTime"));
        // The supplier sheet is the better source for names, so it wins over
        // names picked up from the material sheet.
        suppliers.set(code, {
          code,
          name,
          shortName: toText(get(row, "shortName"), 80) || suppliers.get(code)?.shortName || null,
          country: toText(get(row, "country"), 80),
          email: toText(get(row, "email"), 255),
          leadTime: Number.isFinite(lt) && lt > 0 && lt <= 365 ? Math.round(lt) : null,
          fromSupplierSheet: true
        });
      }
    }
  }
  if (!sheets.length) {
    throw badRequest(
      "No master sheet found. Expected a supplier sheet (Supplier ID / Supplier Name) or a material sheet " +
      "(Supplier ID / Material Code / Leadtime (Days))."
    );
  }
  return { sheets, suppliers, materials, materialRows, supplierRows, skipped, notes };
}

// Works out what an import would do, without writing.
async function plan(sectionId, parsed, runner = { query }) {
  const [sRows, mRows] = await Promise.all([
    runner.query("SELECT id, supplier_code, name, short_name FROM suppliers WHERE section_id = @sectionId", { sectionId }),
    query(
      `SELECT m.id, s.supplier_code, m.material_code, m.material_type, m.vendor_material, m.description, m.lead_time_days
       FROM materials m LEFT JOIN suppliers s ON s.id = m.supplier_id WHERE m.section_id = @sectionId`,
      { sectionId }
    )
  ]);
  const supplierByCode = new Map(sRows.recordset.map(s => [`${s.supplier_code}`, s]));
  const materialByKey = new Map();
  for (const m of mRows.recordset) {
    const key = m.material_code
      ? `${m.supplier_code}|${m.material_code}`
      : `${m.supplier_code}|~|${m.vendor_material || ""}|${m.description || ""}`;
    materialByKey.set(key, m);
  }
  const counts = { suppliersNew: 0, suppliersUpdated: 0, materialsNew: 0, materialsUpdated: 0, materialsUnchanged: 0 };
  for (const s of parsed.suppliers.values()) {
    const cur = supplierByCode.get(s.code);
    if (!cur) counts.suppliersNew += 1;
    else if (s.fromSupplierSheet && (cur.name !== s.name || (s.shortName && cur.short_name !== s.shortName))) counts.suppliersUpdated += 1;
  }
  for (const [key, m] of parsed.materials) {
    const cur = materialByKey.get(key);
    if (!cur) counts.materialsNew += 1;
    else if (cur.lead_time_days !== m.leadTime || (m.type && cur.material_type !== m.type) ||
      (m.vendorMaterial && cur.vendor_material !== m.vendorMaterial) || (m.description && cur.description !== m.description)) {
      counts.materialsUpdated += 1;
    } else counts.materialsUnchanged += 1;
  }
  return { counts, materialByKey };
}

async function previewMaster(sectionId, base64) {
  const parsed = await readSheets(decodeUpload(base64));
  const { counts } = await plan(sectionId, parsed);
  return {
    sheets: parsed.sheets,
    supplierRows: parsed.supplierRows,
    materialRows: parsed.materialRows,
    skipped: parsed.skipped,
    notes: parsed.notes,
    ...counts
  };
}

// Upserts suppliers then materials, in one transaction. Never deletes: a
// supplier or material missing from the file is left as it is.
async function applyMasterBuffer(sectionId, buffer) {
  const parsed = await readSheets(buffer);
  return withTransaction(async tx => {
    const counts = { suppliersNew: 0, suppliersUpdated: 0, materialsNew: 0, materialsUpdated: 0, materialsUnchanged: 0 };
    const supplierIds = new Map(
      (await tx.query("SELECT id, supplier_code FROM suppliers WHERE section_id = @sectionId", { sectionId }))
        .recordset.map(s => [`${s.supplier_code}`, s.id])
    );
    for (const s of parsed.suppliers.values()) {
      if (supplierIds.has(s.code)) {
        if (!s.fromSupplierSheet) continue;
        const r = await tx.query(
          `UPDATE suppliers SET name = @name, short_name = COALESCE(@shortName, short_name),
             country = COALESCE(@country, country), contact_email = COALESCE(@email, contact_email),
             default_lead_time_days = COALESCE(@leadTime, default_lead_time_days),
             updated_at = DATEADD(HOUR, 7, SYSUTCDATETIME())
           WHERE id = @id AND (name <> @name OR ISNULL(short_name, '') <> ISNULL(COALESCE(@shortName, short_name), '')
             OR @country IS NOT NULL OR @email IS NOT NULL OR @leadTime IS NOT NULL)`,
          { id: supplierIds.get(s.code), name: s.name, shortName: s.shortName || null, country: s.country || null,
            email: s.email || null, leadTime: s.leadTime || null }
        );
        if (r.rowsAffected[0]) counts.suppliersUpdated += 1;
      } else {
        const row = (await tx.query(
          `INSERT INTO suppliers (section_id, supplier_code, name, short_name, country, contact_email, default_lead_time_days)
           OUTPUT INSERTED.id VALUES (@sectionId, @code, @name, @shortName, @country, @email, @leadTime)`,
          { sectionId, code: s.code, name: s.name, shortName: s.shortName || null, country: s.country || null,
            email: s.email || null, leadTime: s.leadTime || null }
        )).recordset[0];
        supplierIds.set(s.code, row.id);
        counts.suppliersNew += 1;
      }
    }
    const { materialByKey } = await plan(sectionId, { suppliers: new Map(), materials: new Map() }, tx);
    for (const [key, m] of parsed.materials) {
      const cur = materialByKey.get(key);
      const params = {
        sectionId,
        supplierId: supplierIds.get(m.supplierCode) || null,
        materialCode: m.materialCode || null,
        type: m.type || null,
        vendorMaterial: m.vendorMaterial || null,
        description: m.description || null,
        leadTime: m.leadTime
      };
      if (!cur) {
        await tx.query(
          `INSERT INTO materials (section_id, supplier_id, material_code, material_type, vendor_material, description, lead_time_days)
           VALUES (@sectionId, @supplierId, @materialCode, @type, @vendorMaterial, @description, @leadTime)`,
          params
        );
        counts.materialsNew += 1;
      } else if (cur.lead_time_days !== m.leadTime || (m.type && cur.material_type !== m.type) ||
        (m.vendorMaterial && cur.vendor_material !== m.vendorMaterial) || (m.description && cur.description !== m.description)) {
        await tx.query(
          `UPDATE materials SET material_type = COALESCE(@type, material_type),
             vendor_material = COALESCE(@vendorMaterial, vendor_material),
             description = COALESCE(@description, description), lead_time_days = @leadTime, is_active = 1,
             updated_at = DATEADD(HOUR, 7, SYSUTCDATETIME())
           WHERE id = @id`,
          { ...params, id: cur.id }
        );
        counts.materialsUpdated += 1;
      } else counts.materialsUnchanged += 1;
    }
    // Each supplier's default lead time follows its own materials when nobody
    // has set one: the longest of them.
    await tx.query(
      `UPDATE s SET default_lead_time_days = x.max_lt
       FROM suppliers s
       JOIN (SELECT supplier_id, MAX(lead_time_days) AS max_lt FROM materials
             WHERE section_id = @sectionId AND is_active = 1 GROUP BY supplier_id) x ON x.supplier_id = s.id
       WHERE s.section_id = @sectionId AND s.default_lead_time_days IS NULL`,
      { sectionId }
    );
    return { ...counts, skipped: parsed.skipped, notes: parsed.notes };
  });
}

async function commitMaster(sectionId, base64) {
  return applyMasterBuffer(sectionId, decodeUpload(base64));
}

async function exportMasterBuffer(sectionId) {
  const rows = (await query(
    `SELECT s.supplier_code, s.name, s.short_name, m.material_code, m.material_type, m.vendor_material,
            m.description, m.lead_time_days
     FROM materials m LEFT JOIN suppliers s ON s.id = m.supplier_id
     WHERE m.section_id = @sectionId AND m.is_active = 1
     ORDER BY s.name, m.material_code`,
    { sectionId }
  )).recordset;
  return buildSheet({
    sheetName: "Material Master",
    columns: [
      { header: "Supplier ID", key: "supplier_code", width: 14 },
      { header: "Supplier Name", key: "name", width: 40 },
      { header: "Supplier Short Name", key: "short_name", width: 18 },
      { header: "Material Code", key: "material_code", width: 16 },
      { header: "Type", key: "material_type", width: 13 },
      { header: "Vendor Material", key: "vendor_material", width: 36 },
      { header: "Material Description", key: "description", width: 26 },
      { header: "Leadtime (Days)", key: "lead_time_days", width: 15, type: "number" }
    ],
    rows
  });
}

module.exports = { applyMasterBuffer, commitMaster, exportMasterBuffer, previewMaster, readSheets };
