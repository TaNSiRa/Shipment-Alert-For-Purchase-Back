const { query } = require("../db/pool");

// Field names whose VALUE must never reach the audit table. Matched
// case-insensitively as a substring, so "password", "newPassword",
// "currentPassword", "idToken", "clientSecret" are all caught.
const SENSITIVE_KEY_PATTERN = /pass|secret|token|credential|otp|pin\b/i;
const REDACTED = "[REDACTED]";

// Depth guard: audit payloads are request bodies, which can nest attachments and
// todo arrays. Anything deeper than this is almost certainly not worth logging.
const MAX_DEPTH = 8;

// Attachment data URLs are megabytes of base64 — pointless in an audit row and
// they bloat the table fast. Keep a short prefix so the entry stays readable.
const MAX_STRING_LENGTH = 2000;

// Strip secrets out of anything on its way into audit_logs. Without this the
// audit trail stores plaintext passwords for RESET_PASSWORD / CHANGE_PASSWORD
// (their request bodies carry the raw password), which would defeat bcrypt for
// every account that ever changed its password.
function redactSensitive(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (depth >= MAX_DEPTH) return "[TRUNCATED]";

  if (typeof value === "string") {
    if (value.length <= MAX_STRING_LENGTH) return value;
    return `${value.slice(0, MAX_STRING_LENGTH)}…[truncated ${value.length - MAX_STRING_LENGTH} chars]`;
  }
  if (typeof value !== "object") return value;
  if (value instanceof Date) return value;
  if (Array.isArray(value)) return value.map(item => redactSensitive(item, depth + 1));

  const out = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = SENSITIVE_KEY_PATTERN.test(key) ? REDACTED : redactSensitive(item, depth + 1);
  }
  return out;
}

function serializeAuditValue(value) {
  if (value === null || value === undefined) return null;
  try {
    return JSON.stringify(redactSensitive(value));
  } catch {
    // Circular or otherwise unserializable payload — never let it break the write.
    return null;
  }
}

async function writeAudit({ actorId, sectionId, action, entityType, entityId, beforeValue, afterValue, ip, userAgent }) {
  await query(
    `INSERT INTO audit_logs (actor_user_id, section_id, action, entity_type, entity_id, before_json, after_json, ip_address, user_agent)
     VALUES (@actorId, @sectionId, @action, @entityType, @entityId, @beforeValue, @afterValue, @ip, @userAgent)`,
    {
      actorId: actorId || null,
      sectionId: sectionId || null,
      action,
      entityType,
      entityId: entityId || null,
      beforeValue: serializeAuditValue(beforeValue),
      afterValue: serializeAuditValue(afterValue),
      ip: ip || null,
      userAgent: userAgent || null
    }
  );
}

function audit(action, entityType, getEntityId = req => req.params.id || null) {
  return async (req, res, next) => {
    res.on("finish", async () => {
      if (res.statusCode >= 200 && res.statusCode < 400) {
        try {
          await writeAudit({
            actorId: req.user?.id,
            sectionId: req.section?.id,
            action,
            entityType,
            entityId: getEntityId(req),
            afterValue: req.body,
            ip: req.ip,
            userAgent: req.headers["user-agent"]
          });
        } catch (err) {
          console.error("audit failed", err.message);
        }
      }
    });
    next();
  };
}

module.exports = { audit, redactSensitive, writeAudit };
