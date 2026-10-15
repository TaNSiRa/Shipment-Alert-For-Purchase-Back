const { thaiWallNow } = require("./thaiTime");

// Business dates travel as 'YYYY-MM-DD' strings everywhere in the app — in
// the API, in the scheduler and in the client. A string has no timezone, so a
// due date can never drift a day between the server, SQL Server and a browser.
// All arithmetic below works on UTC fields of a Date built from that string.

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86400000;

function isIsoDate(value) {
  if (typeof value !== "string" || !ISO_RE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

// From a mssql DATE (a Date at UTC midnight), a Date, or an ISO string.
function toIso(value) {
  if (value === null || value === undefined || value === "") return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return value.toISOString().slice(0, 10);
  }
  const text = `${value}`.trim();
  if (isIsoDate(text.slice(0, 10))) return text.slice(0, 10);
  return null;
}

function parse(iso) {
  return new Date(`${iso}T00:00:00Z`);
}

function todayIso(now = Date.now()) {
  return thaiWallNow(now).toISOString().slice(0, 10);
}

function addDays(iso, days) {
  return new Date(parse(iso).getTime() + days * DAY_MS).toISOString().slice(0, 10);
}

// Whole days from a to b (positive when b is later).
function diffDays(a, b) {
  return Math.round((parse(b).getTime() - parse(a).getTime()) / DAY_MS);
}

function weekday(iso) {
  return parse(iso).getUTCDay(); // 0 = Sunday
}

function isWorkingDay(iso, holidays) {
  const d = weekday(iso);
  if (d === 0 || d === 6) return false;
  return !(holidays && holidays.has(iso));
}

// n working days after iso (Saturdays, Sundays and holidays skipped). The
// start day itself never counts, so +1 from Friday is Monday.
function addWorkingDays(iso, days, holidays) {
  let current = iso;
  let left = days;
  // Guard against a holiday table that blocks out years: a step can never be
  // more than a few hundred working days away.
  let guard = 0;
  while (left > 0 && guard < 5000) {
    current = addDays(current, 1);
    if (isWorkingDay(current, holidays)) left -= 1;
    guard += 1;
  }
  return current;
}

function endOfMonth(iso) {
  const d = parse(iso);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
}

function monthKey(iso) {
  return iso.slice(0, 7);
}

function monthRange(month) {
  // month = 'YYYY-MM'
  const start = `${month}-01`;
  return { start, end: endOfMonth(start) };
}

function lastWorkingDayOfMonth(iso, holidays) {
  let current = endOfMonth(iso);
  let guard = 0;
  while (!isWorkingDay(current, holidays) && guard < 31) {
    current = addDays(current, -1);
    guard += 1;
  }
  return current;
}

// Shift by `days` in the section's day mode.
function shift(iso, days, mode, holidays) {
  if (mode === "WORKING") return addWorkingDays(iso, days, holidays);
  return addDays(iso, days);
}

module.exports = {
  addDays,
  addWorkingDays,
  diffDays,
  endOfMonth,
  isIsoDate,
  isWorkingDay,
  lastWorkingDayOfMonth,
  monthKey,
  monthRange,
  shift,
  toIso,
  todayIso,
  weekday
};
