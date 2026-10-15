const nodemailer = require("nodemailer");
const { env } = require("../config/env");
const { query } = require("../db/pool");

function isMailConfigured() {
  return Boolean(env.smtp.host && env.smtp.from);
}

// One pooled transporter for the process, so a burst of mails reuses one
// authenticated connection instead of paying TCP + STARTTLS + AUTH each time.
let transporter = null;
function getTransporter() {
  if (transporter) return transporter;
  if (!isMailConfigured()) return null;
  transporter = nodemailer.createTransport({
    pool: true,
    maxConnections: 2,
    host: env.smtp.host,
    port: env.smtp.port || 587,
    secure: env.smtp.secure === true,
    requireTLS: env.smtp.secure !== true,
    auth: env.smtp.user ? { user: env.smtp.user, pass: env.smtp.password } : undefined,
    connectionTimeout: 12000,
    greetingTimeout: 12000,
    socketTimeout: 20000
  });
  return transporter;
}

async function verifyMail() {
  if (!isMailConfigured()) return { ok: false, reason: "SMTP is not configured (SMTP_HOST / SMTP_FROM in backend/.env)" };
  try {
    await getTransporter().verify();
    return { ok: true };
  } catch (err) {
    console.error(`[mail] verify failed: ${err.message}`);
    return { ok: false, reason: "Could not connect / sign in to the SMTP server — see the API log" };
  }
}

// Records the message in the outbox (always — it is the audit trail), then
// delivers it. status: sent | failed | pending_config (SMTP blank) | disabled.
async function sendMail({ to, cc, subject, html, text, sectionId = null, type, enabled = true }) {
  const toList = [].concat(to || []).filter(Boolean);
  const ccList = [].concat(cc || []).filter(Boolean);
  const recorded = [toList.join(", "), ccList.length ? `cc: ${ccList.join(", ")}` : ""].filter(Boolean).join(" | ").slice(0, 1000);
  const configured = isMailConfigured();
  const status = !enabled ? "disabled" : !toList.length ? "no_recipients" : configured ? "queued" : "pending_config";
  const outboxId = (await query(
    `INSERT INTO email_outbox (section_id, mail_type, to_email, subject, body_html, status)
     OUTPUT INSERTED.id VALUES (@sectionId, @type, @to, @subject, @html, @status)`,
    { sectionId, type, to: recorded, subject: `${subject}`.slice(0, 255), html, status }
  )).recordset[0].id;
  if (status !== "queued") return { sent: false, status, outboxId };
  try {
    const info = await getTransporter().sendMail({
      from: env.smtp.from,
      to: toList,
      cc: ccList.length ? ccList : undefined,
      subject,
      html,
      text: text || undefined
    });
    await query(
      "UPDATE email_outbox SET status = 'sent', sent_at = DATEADD(HOUR, 7, SYSUTCDATETIME()), error_message = NULL WHERE id = @id",
      { id: outboxId }
    );
    return { sent: true, status: "sent", outboxId, messageId: info.messageId };
  } catch (err) {
    await query("UPDATE email_outbox SET status = 'failed', error_message = @error WHERE id = @id", {
      id: outboxId,
      error: `${err.message}`.slice(0, 3000)
    });
    console.error(`[mail] send failed: ${err.message}`);
    // The outbox row keeps the real reason; the caller gets a stable code.
    return { sent: false, status: "failed", outboxId, reason: "MAIL_SEND_FAILED" };
  }
}

module.exports = { isMailConfigured, sendMail, verifyMail };
