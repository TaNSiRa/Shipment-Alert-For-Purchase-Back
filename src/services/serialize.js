const { toIso } = require("./dates");

// DATETIME2 columns hold Thai wall-clock time and mssql reads them back as a
// Date whose UTC fields ARE that wall clock. Sent as an ISO string WITHOUT a
// zone, the client shows it as-is — no browser timezone can shift it.
function wallTime(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 19);
}

function num(value) {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function bool(value) {
  return value === true || value === 1;
}

module.exports = { bool, num, toIso, wallTime };
