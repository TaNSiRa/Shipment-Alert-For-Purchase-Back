// Loads supplier + material master data from an Excel workbook into a section.
// Uses exactly the same code as the in-app "Import master" button.
//
//   npm run db:seed-master -- "../ข้อมูล/Power App for Export process R1.xlsx" [SECTION_CODE]
const fs = require("fs");
const path = require("path");
const { query, closePool } = require("../src/db/pool");
const { applyMasterBuffer } = require("../src/services/masterImport");

async function main() {
  const file = process.argv[2];
  const sectionCode = (process.argv[3] || "PUR").toUpperCase();
  if (!file) throw new Error("Usage: npm run db:seed-master -- <file.xlsx> [SECTION_CODE]");
  const buffer = fs.readFileSync(path.resolve(process.cwd(), file));
  const section = (await query("SELECT id FROM sections WHERE code = @code", { code: sectionCode })).recordset[0];
  if (!section) throw new Error(`Section ${sectionCode} not found`);
  const result = await applyMasterBuffer(section.id, buffer);
  console.log(JSON.stringify(result, null, 2));
}

main()
  .catch(err => {
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(() => closePool());
