const { env } = require("../config/env");

// Every value that came from data goes through esc(). The layout is tables and
// inline styles only — Outlook ignores <style> blocks, flexbox and grid.
function esc(value) {
  return `${value ?? ""}`
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function fmtDate(iso) {
  if (!iso) return "-";
  const [y, m, d] = iso.split("-").map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

function fmtMonth(month) {
  const [y, m] = month.split("-").map(Number);
  return `${MONTHS_LONG[m - 1]} ${y}`;
}

const C = {
  brand: "#5b53e0",
  brandDeep: "#3a3390",
  bg: "#f4f2fb",
  card: "#ffffff",
  heading: "#14161f",
  text: "#2b3040",
  muted: "#575d70",
  line: "#e6e4f0",
  red: "#c33f33",
  redBg: "#fbeae7",
  amber: "#a9720c",
  amberBg: "#fdf4d8",
  green: "#17845a",
  greenBg: "#e4f3ec",
  blue: "#2f6bed",
  blueBg: "#e8f0fe"
};

const FONT = "font-family:'Segoe UI',Tahoma,Arial,sans-serif;";

function shell({ title, subtitle, body, footerNote }) {
  const link = env.appPublicUrl
    ? `<a href="${esc(env.appPublicUrl)}" style="color:${C.brand};font-weight:600;text-decoration:none;">Open Purchase Shipment Alert &rarr;</a>`
    : "";
  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${esc(title)}</title></head>
<body style="margin:0;padding:0;background:${C.bg};${FONT}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.bg};padding:24px 12px;">
<tr><td align="center">
<table role="presentation" width="760" cellpadding="0" cellspacing="0" style="max-width:760px;width:100%;">
  <tr><td style="background:${C.brand};background-image:linear-gradient(135deg,#6f66ee,${C.brand});border-radius:14px 14px 0 0;padding:26px 30px;">
    <div style="${FONT}font-size:12px;letter-spacing:1.4px;color:#dcd9ff;font-weight:700;text-transform:uppercase;">Purchase Shipment Alert</div>
    <div style="${FONT}font-size:22px;color:#ffffff;font-weight:700;margin-top:6px;">${esc(title)}</div>
    ${subtitle ? `<div style="${FONT}font-size:13px;color:#e9e7ff;margin-top:4px;">${esc(subtitle)}</div>` : ""}
  </td></tr>
  <tr><td style="background:${C.card};padding:24px 30px;border-radius:0 0 14px 14px;">
    ${body}
    <div style="border-top:1px solid ${C.line};margin-top:26px;padding-top:16px;${FONT}font-size:12px;color:${C.muted};line-height:1.6;">
      ${footerNote ? `${esc(footerNote)}<br>` : ""}
      This is an automated message from the Purchase Shipment Alert system. ${link}
    </div>
  </td></tr>
</table>
</td></tr></table>
</body></html>`;
}

function statTile(label, value, color, bg) {
  return `<td width="25%" style="padding:6px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${bg};border-radius:10px;">
      <tr><td style="padding:14px 12px;text-align:center;">
        <div style="${FONT}font-size:26px;font-weight:700;color:${color};">${esc(value)}</div>
        <div style="${FONT}font-size:11.5px;font-weight:600;color:${C.muted};margin-top:2px;">${esc(label)}</div>
      </td></tr>
    </table>
  </td>`;
}

function sectionTitle(text, color = C.heading, count = null) {
  return `<div style="${FONT}font-size:15px;font-weight:700;color:${color};margin:24px 0 10px;">${esc(text)}${count !== null ? ` <span style="font-size:12px;font-weight:600;color:${C.muted};">(${esc(count)})</span>` : ""}</div>`;
}

function dueBadge(po) {
  if (po.dueState === "overdue") return `<span style="background:${C.redBg};color:${C.red};border-radius:10px;padding:2px 8px;font-weight:700;font-size:11.5px;">${esc(po.overdueDays)} day${po.overdueDays === 1 ? "" : "s"} late</span>`;
  if (po.dueState === "today") return `<span style="background:${C.amberBg};color:${C.amber};border-radius:10px;padding:2px 8px;font-weight:700;font-size:11.5px;">Due today</span>`;
  if (po.dueState === "soon") return `<span style="background:${C.amberBg};color:${C.amber};border-radius:10px;padding:2px 8px;font-weight:700;font-size:11.5px;">In ${esc(po.daysLeft)} day${po.daysLeft === 1 ? "" : "s"}</span>`;
  return `<span style="background:${C.greenBg};color:${C.green};border-radius:10px;padding:2px 8px;font-weight:600;font-size:11.5px;">On track</span>`;
}

function poTable(pos, { showStep = true } = {}) {
  const th = t => `<th align="left" style="${FONT}font-size:11px;color:${C.muted};font-weight:700;text-transform:uppercase;letter-spacing:.4px;padding:8px 8px;border-bottom:2px solid ${C.line};">${t}</th>`;
  const td = (v, extra = "") => `<td style="${FONT}font-size:12.5px;color:${C.text};padding:8px 8px;border-bottom:1px solid ${C.line};${extra}">${v}</td>`;
  const rows = pos.map(p => `<tr>
    ${td(`<b style="color:${C.heading};">${esc(p.poNo)}</b>${p.shipmentRef ? `<br><span style="color:${C.muted};font-size:11px;">${esc(p.shipmentRef)}</span>` : ""}`)}
    ${td(esc(p.supplierShort || p.supplierName || "-"))}
    ${showStep ? td(esc(p.currentStepName || "-")) : ""}
    ${td(esc(fmtDate(p.nextDueDate)), "white-space:nowrap;")}
    ${td(dueBadge(p), "white-space:nowrap;")}
    ${td(`<b>${esc(fmtDate(p.etaDate))}</b>`, "white-space:nowrap;")}
  </tr>`).join("");
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
    <tr>${th("PO No.")}${th("Supplier")}${showStep ? th("Waiting for") : ""}${th("Due")}${th("Status")}${th("ETA factory")}</tr>
    ${rows}
  </table>`;
}

// The 08:30 digest.
function buildDailyDigestEmail({ sectionName, digest }) {
  const d = digest;
  const late = d.overdue.length;
  const subject = `Purchase shipments ${fmtDate(d.today)} — ${d.total} open${late ? `, ${late} overdue` : ""}`;
  let body = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
    ${statTile("Open shipments", d.total, C.brand, "#efedfe")}
    ${statTile("Overdue", late, late ? C.red : C.green, late ? C.redBg : C.greenBg)}
    ${statTile(`Due within ${d.dueSoonDays} days`, d.dueToday.length + d.dueSoon.length, C.amber, C.amberBg)}
    ${statTile("Arriving this month", d.arrivingThisMonth.length, C.blue, C.blueBg)}
  </tr></table>`;

  if (late) body += sectionTitle("Overdue — please follow up", C.red, late) + poTable(d.overdue);
  const soon = [...d.dueToday, ...d.dueSoon];
  if (soon.length) body += sectionTitle("Due soon", C.amber, soon.length) + poTable(soon);
  if (d.arrivingNext7.length) {
    body += sectionTitle("Arriving at the factory in the next 7 days", C.blue, d.arrivingNext7.length) + poTable(d.arrivingNext7);
  }
  body += sectionTitle("All open shipments by step");
  for (const g of d.groups) {
    body += `<div style="${FONT}font-size:13px;font-weight:700;color:${C.brandDeep};background:#efedfe;border-radius:8px;padding:8px 12px;margin:14px 0 6px;">
      Step ${esc(g.step.stepNo)} · ${esc(g.step.name)} <span style="color:${C.muted};font-weight:600;">— ${esc(g.pos.length)} PO${g.pos.length === 1 ? "" : "s"}</span></div>`;
    body += poTable(g.pos, { showStep: false });
  }
  if (!d.groups.length) {
    body += `<div style="${FONT}font-size:13px;color:${C.muted};padding:12px 0;">There are no open shipments right now.</div>`;
  }
  return {
    subject,
    html: shell({
      title: `Daily shipment report — ${fmtDate(d.today)}`,
      subtitle: sectionName,
      body,
      footerNote: "Sent every working day at the time set in Settings."
    }),
    type: "DAILY_DIGEST"
  };
}

function buildMonthlyReportEmail({ sectionName, report }) {
  const r = report;
  const subject = `Monthly shipment report — ${fmtMonth(r.month)} — ${sectionName}`;
  let body = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
    ${statTile("POs issued", r.issued.count, C.brand, "#efedfe")}
    ${statTile("Arrived", r.arrived.count, C.blue, C.blueBg)}
    ${statTile("On-time rate", r.arrived.onTimeRate === null ? "-" : `${r.arrived.onTimeRate}%`, C.green, C.greenBg)}
    ${statTile("Open overdue", r.openOverdueCount, r.openOverdueCount ? C.red : C.green, r.openOverdueCount ? C.redBg : C.greenBg)}
  </tr></table>`;
  const th = t => `<th align="left" style="${FONT}font-size:11px;color:${C.muted};font-weight:700;text-transform:uppercase;padding:8px;border-bottom:2px solid ${C.line};">${t}</th>`;
  const td = v => `<td style="${FONT}font-size:12.5px;color:${C.text};padding:8px;border-bottom:1px solid ${C.line};">${v}</td>`;
  body += sectionTitle("Step performance");
  body += `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
    <tr>${th("Step")}${th("Done")}${th("On time")}${th("Late")}${th("Avg late days")}</tr>
    ${r.stepPerformance.map(s => `<tr>${td(`${esc(s.stepNo)}. ${esc(s.name)}`)}${td(esc(s.done))}${td(esc(s.onTime))}${td(esc(s.late))}${td(esc(s.avgLateDays))}</tr>`).join("")}
  </table>`;
  if (r.supplierPerformance.length) {
    body += sectionTitle("Supplier performance (arrivals)");
    body += `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
      <tr>${th("Supplier")}${th("Arrived")}${th("On time")}${th("Avg delay")}${th("Lead time actual / master")}</tr>
      ${r.supplierPerformance.map(s => `<tr>${td(esc(s.name || s.supplierCode))}${td(esc(s.arrived))}${td(`${esc(s.onTime)} (${esc(s.onTimeRate ?? "-")}%)`)}${td(`${esc(s.avgDelayDays)} d`)}${td(`${esc(s.avgActualLeadTime ?? "-")} / ${esc(s.avgMasterLeadTime ?? "-")} d`)}</tr>`).join("")}
    </table>`;
  }
  if (r.openOverdue.length) {
    body += sectionTitle("Still open and overdue", C.red, r.openOverdueCount);
    body += poTable(r.openOverdue.slice(0, 40));
  }
  return {
    subject,
    html: shell({ title: `Monthly report — ${fmtMonth(r.month)}`, subtitle: sectionName, body, footerNote: "The full report (Excel) is on the Monthly Report page." }),
    type: "MONTHLY_REPORT"
  };
}

function buildAccountLockedEmail({ greetingName, lockedUntil, lockMinutes, failures, ip }) {
  const until = lockedUntil instanceof Date ? lockedUntil.toISOString().slice(0, 16).replace("T", " ") : `${lockedUntil || ""}`;
  const body = `<div style="${FONT}font-size:14px;color:${C.text};line-height:1.7;">
    Hello ${esc(greetingName)},<br><br>
    Your Purchase Shipment Alert account was locked after <b>${esc(failures)}</b> wrong passwords in a row.
    It opens again automatically after <b>${esc(lockMinutes)} minutes</b> (at ${esc(until)}), or an admin can unlock it.<br><br>
    The last attempt came from IP <b>${esc(ip || "-")}</b>. If this was not you, tell your system admin.
  </div>`;
  return { subject: "Security alert — your account was locked", html: shell({ title: "Account locked", body }), type: "ACCOUNT_LOCKED" };
}

function buildTestEmail({ name }) {
  const body = `<div style="${FONT}font-size:14px;color:${C.text};line-height:1.7;">Hello ${esc(name)},<br><br>
    This is a test email. If you can read it, mail delivery from Purchase Shipment Alert is working.</div>`;
  return { subject: "Test email — Purchase Shipment Alert", html: shell({ title: "Test email", body }), type: "TEST" };
}

module.exports = { buildAccountLockedEmail, buildDailyDigestEmail, buildMonthlyReportEmail, buildTestEmail, esc, fmtDate, fmtMonth };
