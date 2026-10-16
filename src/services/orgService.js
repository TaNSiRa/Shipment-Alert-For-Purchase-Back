const { query } = require("../db/pool");

// Organization lookup lists for the Manage Users / Profile dropdowns, same as
// RAP: branches, departments and sections are CSV values in global
// app_settings (org.*), positions are the `positions` master table.
const ORG_KEYS = { branches: "org.branches", departments: "org.departments", sections: "org.sections" };

function splitCsv(value) {
  return `${value ?? ""}`.split(",").map(v => v.trim()).filter(Boolean);
}

const byName = (a, b) => a.localeCompare(b, undefined, { sensitivity: "base" });

async function getOrgOptions() {
  const rows = (await query(
    `SELECT setting_key, setting_value FROM app_settings
     WHERE section_id IS NULL AND setting_key IN ('org.branches', 'org.departments', 'org.sections')`
  )).recordset;
  const map = Object.fromEntries(rows.map(r => [r.setting_key, r.setting_value]));
  const positions = (await query(
    "SELECT id, name, abbreviation FROM positions WHERE is_active = 1 ORDER BY sort_order, name"
  )).recordset;
  return {
    // Branches keep their stored order (RAP's too); the other two read A-Z.
    branches: splitCsv(map[ORG_KEYS.branches]),
    departments: splitCsv(map[ORG_KEYS.departments]).sort(byName),
    sections: splitCsv(map[ORG_KEYS.sections]).sort(byName),
    positions: positions.map(p => ({ id: p.id, name: p.name, abbreviation: p.abbreviation }))
  };
}

// "Full name (ABBR)", as RAP shows a position.
function positionLabel(name, abbreviation) {
  const full = `${name ?? ""}`.trim();
  const abbr = `${abbreviation ?? ""}`.trim();
  if (!full) return abbr || null;
  return abbr ? `${full} (${abbr})` : full;
}

async function assertPositionExists(positionId) {
  if (positionId == null) return;
  const row = (await query("SELECT id FROM positions WHERE id = @id", { id: positionId })).recordset[0];
  if (!row) throw Object.assign(new Error("Unknown position"), { status: 400 });
}

module.exports = { getOrgOptions, positionLabel, assertPositionExists };
