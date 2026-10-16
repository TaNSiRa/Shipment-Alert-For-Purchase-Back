const { z } = require("zod");
const { query } = require("../db/pool");
const { getHolidayDates } = require("../db/holidayPool");
const { toIso } = require("./dates");

// Section settings, stored as strings in app_settings and served typed. The
// schema below is the one place that knows each key's type, default and range —
// the Settings page, the scheduler and the PO logic all read through it.
const SECTION_SETTINGS = {
  "mail.enabled": { type: "bool", default: false },
  "mail.dailyTime": { type: "time", default: "08:30" },
  "mail.extraRecipients": { type: "emails", default: "" },
  "mail.monthlyEnabled": { type: "bool", default: true },
  "workflow.dayMode": { type: "enum", values: ["CALENDAR", "WORKING"], default: "CALENDAR" },
  "workflow.useMaterialLeadTime": { type: "bool", default: true },
  "workflow.defaultLeadTimeDays": { type: "int", min: 1, max: 365, default: 75 },
  "workflow.minFlexDays": { type: "int", min: 0, max: 365, default: 5 },
  "alert.dueSoonDays": { type: "int", min: 0, max: 30, default: 3 }
};

const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;

function parseValue(def, raw) {
  if (raw === null || raw === undefined) return def.default;
  const text = `${raw}`.trim();
  switch (def.type) {
    case "bool":
      return text.toLowerCase() === "true";
    case "int": {
      const n = Number.parseInt(text, 10);
      return Number.isFinite(n) && n >= def.min && n <= def.max ? n : def.default;
    }
    case "enum":
      return def.values.includes(text) ? text : def.default;
    case "time":
      return /^([01]\d|2[0-3]):[0-5]\d$/.test(text) ? text : def.default;
    case "emails":
      return splitEmails(text).join(", ");
    default:
      return text;
  }
}

function splitEmails(text) {
  return `${text || ""}`
    .split(/[,;\s]+/)
    .map(v => v.trim())
    .filter(Boolean);
}

// Validates one incoming value; throws a 400-shaped error when it is wrong.
function validateValue(key, value) {
  const def = SECTION_SETTINGS[key];
  if (!def) throw Object.assign(new Error(`Unknown setting: ${key}`), { status: 400 });
  const bad = message => Object.assign(new Error(message), { status: 400 });
  switch (def.type) {
    case "bool":
      if (typeof value !== "boolean") throw bad(`${key} must be true or false`);
      return value ? "true" : "false";
    case "int": {
      const n = Number(value);
      if (!Number.isInteger(n) || n < def.min || n > def.max) throw bad(`${key} must be a whole number from ${def.min} to ${def.max}`);
      return `${n}`;
    }
    case "enum":
      if (!def.values.includes(value)) throw bad(`${key} must be one of ${def.values.join(", ")}`);
      return value;
    case "time":
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(`${value}`)) throw bad(`${key} must be a time like 08:30`);
      return `${value}`;
    case "emails": {
      const list = splitEmails(value);
      const wrong = list.filter(e => !EMAIL_RE.test(e));
      if (wrong.length) throw bad(`Not a valid email: ${wrong.join(", ")}`);
      if (list.length > 50) throw bad("At most 50 extra recipients");
      return list.join(", ");
    }
    default:
      return `${value}`;
  }
}

async function getSectionSettings(sectionId) {
  const rows = (await query(
    "SELECT setting_key, setting_value FROM app_settings WHERE section_id = @sectionId",
    { sectionId }
  )).recordset;
  const stored = new Map(rows.map(r => [r.setting_key, r.setting_value]));
  const out = {};
  for (const [key, def] of Object.entries(SECTION_SETTINGS)) out[key] = parseValue(def, stored.get(key));
  return out;
}

async function setSectionSettings(sectionId, values, userId) {
  const entries = Object.entries(values || {}).map(([key, value]) => [key, validateValue(key, value)]);
  for (const [key, value] of entries) {
    await query(
      `MERGE app_settings AS t
       USING (SELECT @sectionId AS section_id, @key AS setting_key) AS s
         ON t.section_id = s.section_id AND t.setting_key = s.setting_key
       WHEN MATCHED THEN UPDATE SET setting_value = @value, updated_by = @userId,
         updated_at = DATEADD(HOUR, 7, SYSUTCDATETIME())
       WHEN NOT MATCHED THEN INSERT (section_id, setting_key, setting_value, updated_by, updated_at)
         VALUES (@sectionId, @key, @value, @userId, DATEADD(HOUR, 7, SYSUTCDATETIME()));`,
      { sectionId, key, value, userId: userId || null }
    );
  }
  return getSectionSettings(sectionId);
}

// The bits the schedule maths needs, in its own shape.
function scheduleSettings(settings) {
  return {
    dayMode: settings["workflow.dayMode"],
    useMaterialLeadTime: settings["workflow.useMaterialLeadTime"],
    defaultLeadTimeDays: settings["workflow.defaultLeadTimeDays"],
    minFlexDays: settings["workflow.minFlexDays"]
  };
}

// Company holidays: the external holiday DB (SAR · Master_Holiday, as in RAP)
// plus any extra days entered in Settings › Holidays.
async function getHolidaySet() {
  const year = new Date().getFullYear();
  const [rows, external] = await Promise.all([
    query("SELECT holiday_date FROM holidays"),
    getHolidayDates(`${year - 3}-01-01`, `${year + 3}-12-31`)
  ]);
  return new Set([...rows.recordset.map(r => toIso(r.holiday_date)), ...external.dates]);
}

const settingsUpdateSchema = z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]));

module.exports = {
  SECTION_SETTINGS,
  getHolidaySet,
  getSectionSettings,
  scheduleSettings,
  setSectionSettings,
  settingsUpdateSchema,
  splitEmails,
  EMAIL_RE
};
