function notFound(req, res) {
  res.status(404).json({ message: "Route not found" });
}

// Errors the app raises on purpose carry err.status (403 "Only the assigned
// incharge…", 404 "Request not found", 409 "EMAIL_TAKEN", …) and the frontend
// shows that text to the user, so those messages must pass through unchanged.
// Anything WITHOUT a deliberate 4xx status is an unexpected failure — a mssql
// driver error, a null dereference — whose message can leak table and column
// names, file paths, or connection details. Those get a generic message; the
// real one stays in the server log.
function errorHandler(err, req, res, next) {
  console.error(err);
  if (err.name === "ZodError") {
    // Name the field in plain words so the person knows what to fix.
    const first = err.issues?.[0];
    const field = first?.path?.length ? `${first.path.join(" › ")}: ` : "";
    return res.status(400).json({ message: first ? `${field}${first.message}` : "Validation error", issues: err.issues });
  }
  const status = Number(err.status) || 500;
  // "Deliberate" means WE set the status, not merely that something arrived
  // with a 4xx on it. Third-party middleware sets its own — body-parser marks a
  // malformed payload `{ status: 400, expose: true }` and its message is the
  // raw parser text ("Expected property name or '}' in JSON at position 1"),
  // which is noise to the user and detail we would rather not echo. Those carry
  // `expose`; ours never do, so that flag is what separates the two.
  //
  // A 5xx we raise on purpose ("PDF export isn't available on this server",
  // "OT is not set up on this server yet") marks itself `publicMessage`: its
  // text is written for the user and says what to do, so it passes too.
  const isIntentional = (status >= 400 && status < 500 && err.expose !== true) || err.publicMessage === true;
  res.status(status).json({
    message: isIntentional && err.message ? err.message : messageFor(status)
  });
}

// Generic, stable text for anything we did not raise on purpose.
function messageFor(status) {
  if (status === 400) return "Invalid request";
  if (status === 413) return "Payload too large";
  if (status === 415) return "Unsupported content type";
  return "Internal server error";
}

module.exports = { notFound, errorHandler };
