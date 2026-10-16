const express = require("express");
const { z } = require("zod");
const { query } = require("../../db/pool");
const { asyncHandler } = require("../../middleware/asyncHandler");
const { writeAudit } = require("../../middleware/audit");
const { requireSectionAdmin, resolveSection } = require("../../services/sectionService");
const { commitMaster, exportMasterBuffer, previewMaster } = require("../../services/masterImport");
const { emitSection } = require("../../services/realtimeService");
const { wallTime } = require("../../services/serialize");

const router = express.Router();
router.use(resolveSection);

const text = max => z.union([z.string().trim().max(max), z.null()]).optional().transform(v => (v === "" ? null : v));

const supplierSchema = z.object({
  supplierCode: z.string().trim().min(1).max(30),
  name: z.string().trim().min(1).max(200),
  shortName: text(80),
  country: text(80),
  contactEmail: z.union([z.string().trim().email().max(255), z.literal(""), z.null()]).optional().transform(v => (v === "" ? null : v)),
  remark: text(500),
  isActive: z.boolean().optional()
});

const materialSchema = z.object({
  supplierId: z.number().int().positive().nullable(),
  materialCode: text(40),
  materialType: text(40),
  vendorMaterial: text(255),
  description: text(255),
  leadTimeDays: z.number().int().min(1).max(365),
  isActive: z.boolean().optional()
});

// Every optional column bound even when the client left it out (an unbound
// @name is a SQL error, and "left out" means empty on a full-form save).
const SUPPLIER_DEFAULTS = { shortName: null, country: null, contactEmail: null, remark: null };
const MATERIAL_DEFAULTS = { materialCode: null, materialType: null, vendorMaterial: null, description: null };

function like(q) {
  return `%${`${q}`.trim().replace(/[%_[]/g, ch => `[${ch}]`)}%`;
}

function audit(req, action, entityType, entityId, afterValue) {
  return writeAudit({
    actorId: req.user.id, sectionId: req.section.id, action, entityType, entityId: entityId ? `${entityId}` : null,
    afterValue, ip: req.ip, userAgent: req.headers["user-agent"]
  });
}

function changed(req) {
  emitSection(req.section.code, "masters.updated");
}

function supplierOut(r) {
  return {
    id: r.id,
    supplierCode: r.supplier_code,
    name: r.name,
    shortName: r.short_name,
    country: r.country,
    contactEmail: r.contact_email,
    remark: r.remark,
    isActive: r.is_active === true || r.is_active === 1,
    materialCount: r.material_count ?? 0,
    activePoCount: r.active_po_count ?? 0,
    updatedAt: wallTime(r.updated_at || r.created_at)
  };
}

function materialOut(r) {
  return {
    id: r.id,
    supplierId: r.supplier_id,
    supplierCode: r.supplier_code,
    supplierName: r.supplier_name,
    supplierShort: r.supplier_short,
    materialCode: r.material_code,
    materialType: r.material_type,
    vendorMaterial: r.vendor_material,
    description: r.description,
    leadTimeDays: r.lead_time_days,
    isActive: r.is_active === true || r.is_active === 1,
    updatedAt: wallTime(r.updated_at || r.created_at)
  };
}

// ---- Suppliers -------------------------------------------------------------

router.get("/suppliers", asyncHandler(async (req, res) => {
  const params = { sectionId: req.section.id };
  const where = ["s.section_id = @sectionId"];
  if (req.query.q) {
    params.q = like(req.query.q);
    where.push("(s.supplier_code LIKE @q OR s.name LIKE @q OR s.short_name LIKE @q OR s.country LIKE @q)");
  }
  if (req.query.active === "true") where.push("s.is_active = 1");
  const rows = (await query(
    `SELECT s.*,
       (SELECT COUNT(1) FROM materials m WHERE m.supplier_id = s.id AND m.is_active = 1) AS material_count,
       (SELECT COUNT(1) FROM purchase_orders p WHERE p.supplier_id = s.id AND p.status = 'ACTIVE') AS active_po_count
     FROM suppliers s WHERE ${where.join(" AND ")} ORDER BY s.is_active DESC, s.name`,
    params
  )).recordset;
  res.json({ data: rows.map(supplierOut) });
}));

router.post("/suppliers", requireSectionAdmin, asyncHandler(async (req, res) => {
  const input = supplierSchema.parse(req.body);
  const dup = (await query("SELECT id FROM suppliers WHERE section_id = @sectionId AND supplier_code = @code", { sectionId: req.section.id, code: input.supplierCode })).recordset[0];
  if (dup) return res.status(409).json({ message: `Supplier ID ${input.supplierCode} already exists` });
  const row = (await query(
    `INSERT INTO suppliers (section_id, supplier_code, name, short_name, country, contact_email, remark, is_active)
     OUTPUT INSERTED.id
     VALUES (@sectionId, @supplierCode, @name, @shortName, @country, @contactEmail, @remark, @isActive)`,
    { sectionId: req.section.id, ...SUPPLIER_DEFAULTS, ...input, isActive: input.isActive === false ? 0 : 1 }
  )).recordset[0];
  await audit(req, "CREATE", "SUPPLIER", row.id, input);
  changed(req);
  res.status(201).json({ id: row.id });
}));

router.patch("/suppliers/:id(\\d+)", requireSectionAdmin, asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const input = supplierSchema.parse(req.body);
  const dup = (await query(
    "SELECT id FROM suppliers WHERE section_id = @sectionId AND supplier_code = @code AND id <> @id",
    { sectionId: req.section.id, code: input.supplierCode, id }
  )).recordset[0];
  if (dup) return res.status(409).json({ message: `Supplier ID ${input.supplierCode} already exists` });
  const r = await query(
    `UPDATE suppliers SET supplier_code = @supplierCode, name = @name, short_name = @shortName, country = @country,
       contact_email = @contactEmail, remark = @remark,
       is_active = @isActive, updated_at = DATEADD(HOUR, 7, SYSUTCDATETIME())
     WHERE id = @id AND section_id = @sectionId`,
    { id, sectionId: req.section.id, ...SUPPLIER_DEFAULTS, ...input, isActive: input.isActive === false ? 0 : 1 }
  );
  if (!r.rowsAffected[0]) return res.status(404).json({ message: "Supplier not found" });
  // POs keep a copy of the supplier name; refresh it on the ones still open.
  await query(
    "UPDATE purchase_orders SET supplier_name = @name, supplier_code = @supplierCode WHERE supplier_id = @id AND status = 'ACTIVE'",
    { id, name: input.name, supplierCode: input.supplierCode }
  );
  await audit(req, "EDIT", "SUPPLIER", id, input);
  changed(req);
  res.json({ ok: true });
}));

router.delete("/suppliers/:id(\\d+)", requireSectionAdmin, asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const refs = (await query(
    `SELECT (SELECT COUNT(1) FROM purchase_orders WHERE supplier_id = @id) AS pos,
            (SELECT COUNT(1) FROM materials WHERE supplier_id = @id) AS mats`,
    { id }
  )).recordset[0];
  if (refs.pos || refs.mats) {
    return res.status(409).json({
      message: `This supplier is used by ${refs.pos} PO(s) and ${refs.mats} material(s). Set it inactive instead of deleting.`
    });
  }
  const r = await query("DELETE FROM suppliers WHERE id = @id AND section_id = @sectionId", { id, sectionId: req.section.id });
  if (!r.rowsAffected[0]) return res.status(404).json({ message: "Supplier not found" });
  await audit(req, "DELETE", "SUPPLIER", id);
  changed(req);
  res.json({ ok: true });
}));

// ---- Materials -------------------------------------------------------------

const MATERIAL_SELECT = `SELECT m.*, s.supplier_code, s.name AS supplier_name, s.short_name AS supplier_short
  FROM materials m LEFT JOIN suppliers s ON s.id = m.supplier_id`;

router.get("/materials", asyncHandler(async (req, res) => {
  const params = { sectionId: req.section.id };
  const where = ["m.section_id = @sectionId"];
  if (req.query.q) {
    params.q = like(req.query.q);
    where.push(`(m.material_code LIKE @q OR m.vendor_material LIKE @q OR m.description LIKE @q
      OR s.name LIKE @q OR s.short_name LIKE @q OR s.supplier_code LIKE @q)`);
  }
  if (req.query.supplierId) {
    params.supplierId = Number(req.query.supplierId);
    where.push("m.supplier_id = @supplierId");
  }
  if (req.query.type) {
    params.type = `${req.query.type}`;
    where.push("m.material_type = @type");
  }
  if (req.query.active === "true") where.push("m.is_active = 1");
  if (req.query.missingCode === "true") where.push("m.material_code IS NULL");
  const pageSize = Math.min(Math.max(Number(req.query.pageSize) || 50, 1), 1000);
  const page = Math.max(Number(req.query.page) || 1, 1);
  const total = (await query(`SELECT COUNT(1) AS n FROM materials m LEFT JOIN suppliers s ON s.id = m.supplier_id WHERE ${where.join(" AND ")}`, params)).recordset[0].n;
  const rows = (await query(
    `${MATERIAL_SELECT} WHERE ${where.join(" AND ")}
     ORDER BY m.is_active DESC, s.name, m.material_code OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY`,
    { ...params, offset: (page - 1) * pageSize, pageSize }
  )).recordset;
  res.json({ data: rows.map(materialOut), total, page, pageSize });
}));

router.get("/material-types", asyncHandler(async (req, res) => {
  const rows = (await query(
    "SELECT material_type AS t, COUNT(1) AS n FROM materials WHERE section_id = @sectionId AND material_type IS NOT NULL GROUP BY material_type ORDER BY material_type",
    { sectionId: req.section.id }
  )).recordset;
  res.json({ data: rows.map(r => ({ type: r.t, count: r.n })) });
}));

async function assertSupplierInSection(req, supplierId) {
  if (!supplierId) return;
  const s = (await query("SELECT id FROM suppliers WHERE id = @id AND section_id = @sectionId", { id: supplierId, sectionId: req.section.id })).recordset[0];
  if (!s) throw Object.assign(new Error("Supplier not found in this section"), { status: 400 });
}

async function assertNoDuplicateMaterial(req, input, exceptId = 0) {
  if (!input.materialCode) return;
  const dup = (await query(
    `SELECT id FROM materials WHERE section_id = @sectionId AND material_code = @code
       AND ((supplier_id IS NULL AND @supplierId IS NULL) OR supplier_id = @supplierId) AND id <> @exceptId`,
    { sectionId: req.section.id, code: input.materialCode, supplierId: input.supplierId, exceptId }
  )).recordset[0];
  if (dup) throw Object.assign(new Error(`Material ${input.materialCode} already exists for this supplier`), { status: 409 });
}

router.post("/materials", requireSectionAdmin, asyncHandler(async (req, res) => {
  const input = materialSchema.parse(req.body);
  if (input.materialCode) input.materialCode = /^\d+$/.test(input.materialCode) ? input.materialCode.replace(/^0+(?=\d)/, "") : input.materialCode.toUpperCase();
  await assertSupplierInSection(req, input.supplierId);
  await assertNoDuplicateMaterial(req, input);
  const row = (await query(
    `INSERT INTO materials (section_id, supplier_id, material_code, material_type, vendor_material, description, lead_time_days, is_active)
     OUTPUT INSERTED.id
     VALUES (@sectionId, @supplierId, @materialCode, @materialType, @vendorMaterial, @description, @leadTimeDays, @isActive)`,
    { sectionId: req.section.id, ...MATERIAL_DEFAULTS, ...input, isActive: input.isActive === false ? 0 : 1 }
  )).recordset[0];
  await audit(req, "CREATE", "MATERIAL", row.id, input);
  changed(req);
  res.status(201).json({ id: row.id });
}));

router.patch("/materials/:id(\\d+)", requireSectionAdmin, asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const input = materialSchema.parse(req.body);
  if (input.materialCode) input.materialCode = /^\d+$/.test(input.materialCode) ? input.materialCode.replace(/^0+(?=\d)/, "") : input.materialCode.toUpperCase();
  await assertSupplierInSection(req, input.supplierId);
  await assertNoDuplicateMaterial(req, input, id);
  const r = await query(
    `UPDATE materials SET supplier_id = @supplierId, material_code = @materialCode, material_type = @materialType,
       vendor_material = @vendorMaterial, description = @description, lead_time_days = @leadTimeDays,
       is_active = @isActive, updated_at = DATEADD(HOUR, 7, SYSUTCDATETIME())
     WHERE id = @id AND section_id = @sectionId`,
    { id, sectionId: req.section.id, ...MATERIAL_DEFAULTS, ...input, isActive: input.isActive === false ? 0 : 1 }
  );
  if (!r.rowsAffected[0]) return res.status(404).json({ message: "Material not found" });
  await audit(req, "EDIT", "MATERIAL", id, input);
  changed(req);
  res.json({ ok: true });
}));

router.delete("/materials/:id(\\d+)", requireSectionAdmin, asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const used = (await query("SELECT COUNT(1) AS n FROM po_items WHERE material_id = @id", { id })).recordset[0].n;
  if (used) return res.status(409).json({ message: `This material is on ${used} PO line(s). Set it inactive instead of deleting.` });
  const r = await query("DELETE FROM materials WHERE id = @id AND section_id = @sectionId", { id, sectionId: req.section.id });
  if (!r.rowsAffected[0]) return res.status(404).json({ message: "Material not found" });
  await audit(req, "DELETE", "MATERIAL", id);
  changed(req);
  res.json({ ok: true });
}));

// For the manual "New PO" form: active suppliers and, for one supplier, its
// active materials.
router.get("/lookup", asyncHandler(async (req, res) => {
  const suppliers = (await query(
    "SELECT id, supplier_code, name, short_name FROM suppliers WHERE section_id = @sectionId AND is_active = 1 ORDER BY name",
    { sectionId: req.section.id }
  )).recordset;
  let materials = [];
  if (req.query.supplierId) {
    materials = (await query(
      `${MATERIAL_SELECT} WHERE m.section_id = @sectionId AND m.is_active = 1 AND m.supplier_id = @supplierId ORDER BY m.material_code`,
      { sectionId: req.section.id, supplierId: Number(req.query.supplierId) }
    )).recordset.map(materialOut);
  }
  res.json({
    suppliers: suppliers.map(s => ({
      id: s.id, supplierCode: s.supplier_code, name: s.name, shortName: s.short_name
    })),
    materials
  });
}));

// ---- Import / export ---------------------------------------------------------

router.post("/import/preview", requireSectionAdmin, asyncHandler(async (req, res) => {
  res.json(await previewMaster(req.section.id, req.body?.data));
}));

router.post("/import/commit", requireSectionAdmin, asyncHandler(async (req, res) => {
  const result = await commitMaster(req.section.id, req.body?.data);
  await audit(req, "IMPORT", "MASTER", req.body?.fileName ? `${req.body.fileName}`.slice(0, 120) : null, result);
  changed(req);
  res.json(result);
}));

router.get("/export", asyncHandler(async (req, res) => {
  const buffer = await exportMasterBuffer(req.section.id);
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="material-master-${req.section.code}.xlsx"`);
  res.send(Buffer.from(buffer));
}));

module.exports = router;
