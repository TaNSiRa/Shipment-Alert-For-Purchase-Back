const { query } = require("../db/pool");
const { isWorkingDay, lastWorkingDayOfMonth, todayIso } = require("./dates");
const { thaiWallNow } = require("./thaiTime");
const { getHolidaySet, getSectionSettings, splitEmails } = require("./settingsService");
const { loadContext } = require("./poService");
const { dailyDigest, monthlyReport } = require("./reportService");
const { buildDailyDigestEmail, buildMonthlyReportEmail } = require("./emailTemplates");
const { sendMail } = require("./mailService");

// Who gets a section's mail: its active members who kept "receive daily mail"
// on in their profile, plus the extra addresses set on the Settings page.
async function recipientsFor(sectionId, settings) {
  const rows = (await query(
    `SELECT DISTINCT u.email FROM users u
     JOIN user_section_memberships m ON m.user_id = u.id AND m.section_id = @sectionId AND m.is_active = 1
     WHERE u.is_active = 1 AND u.receive_daily_mail = 1 AND u.email LIKE '%@%'`,
    { sectionId }
  )).recordset.map(r => `${r.email}`.trim().toLowerCase());
  const extra = splitEmails(settings["mail.extraRecipients"]).map(e => e.toLowerCase());
  return [...new Set([...rows, ...extra])];
}

async function sendDailyDigest(section, { to = null, force = false } = {}) {
  const ctx = await loadContext(section.id);
  const digest = await dailyDigest(section.id, ctx);
  const mail = buildDailyDigestEmail({ sectionName: section.name, digest });
  const recipients = to ? [].concat(to) : await recipientsFor(section.id, ctx.settings);
  const result = await sendMail({
    to: recipients,
    subject: mail.subject,
    html: mail.html,
    sectionId: section.id,
    type: mail.type,
    enabled: force || ctx.settings["mail.enabled"]
  });
  return { ...result, recipients: recipients.length, openPos: digest.total };
}

async function sendMonthlyReport(section, month, { to = null, force = false } = {}) {
  const ctx = await loadContext(section.id);
  const report = await monthlyReport(section.id, month, ctx);
  const mail = buildMonthlyReportEmail({ sectionName: section.name, report });
  const recipients = to ? [].concat(to) : await recipientsFor(section.id, ctx.settings);
  const result = await sendMail({
    to: recipients,
    subject: mail.subject,
    html: mail.html,
    sectionId: section.id,
    type: mail.type,
    enabled: force || ctx.settings["mail.enabled"]
  });
  return { ...result, recipients: recipients.length };
}

// Claims (section, kind, day). False when someone already did — the unique key
// on mail_runs makes this safe across restarts and multiple processes.
async function claimRun(sectionId, runType, runDate) {
  try {
    await query(
      "INSERT INTO mail_runs (section_id, run_type, run_date) VALUES (@sectionId, @runType, @runDate)",
      { sectionId, runType, runDate }
    );
    return true;
  } catch (err) {
    if (/UNIQUE|duplicate/i.test(err.message)) return false;
    throw err;
  }
}

async function finishRun(sectionId, runType, runDate, status, detail) {
  await query(
    "UPDATE mail_runs SET status = @status, detail = @detail WHERE section_id = @sectionId AND run_type = @runType AND run_date = @runDate",
    { sectionId, runType, runDate, status, detail: `${detail || ""}`.slice(0, 1000) }
  );
}

async function tick(now = Date.now()) {
  const today = todayIso(now);
  const hhmm = thaiWallNow(now).toISOString().slice(11, 16);
  const holidays = await getHolidaySet();
  if (!isWorkingDay(today, holidays)) return;
  const sections = (await query("SELECT id, code, name FROM sections WHERE is_active = 1")).recordset;
  for (const section of sections) {
    try {
      const settings = await getSectionSettings(section.id);
      if (!settings["mail.enabled"] || hhmm < settings["mail.dailyTime"]) continue;
      if (await claimRun(section.id, "DAILY", today)) {
        const r = await sendDailyDigest(section);
        await finishRun(section.id, "DAILY", today, r.status, `${r.recipients} recipient(s), ${r.openPos} open PO(s)`);
        console.log(`[mail] daily digest ${section.code}: ${r.status} to ${r.recipients}`);
      }
      if (settings["mail.monthlyEnabled"] && today === lastWorkingDayOfMonth(today, holidays) &&
        (await claimRun(section.id, "MONTHLY", today))) {
        const r = await sendMonthlyReport(section, today.slice(0, 7));
        await finishRun(section.id, "MONTHLY", today, r.status, `${r.recipients} recipient(s)`);
        console.log(`[mail] monthly report ${section.code}: ${r.status}`);
      }
    } catch (err) {
      console.error(`[mail] scheduler failed for ${section.code}: ${err.message}`);
    }
  }
}

let timer = null;
function startMailScheduler() {
  if (timer) return;
  const run = () => tick().catch(err => console.error(`[mail] tick failed: ${err.message}`));
  timer = setInterval(run, 60 * 1000);
  timer.unref?.();
  setTimeout(run, 5000).unref?.();
  console.log("Mail scheduler started (daily digest on working days, month-end report)");
}

module.exports = { recipientsFor, sendDailyDigest, sendMonthlyReport, startMailScheduler, tick };
