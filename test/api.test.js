const { MASTER_FILE, PASSWORD, SAP_FILE, app, client, closePool, fileBase64, login, query, setupDatabase } = require("../testkit/setup");
const test = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const { addDays, todayIso } = require("../src/services/dates");
const { tick } = require("../src/services/mailScheduler");

let ctx;
const tokens = {};
const api = {};

test.before(async () => {
  ctx = await setupDatabase();
  for (const key of ["admin", "secadmin", "buyer", "buyer2", "viewer", "qa"]) {
    tokens[key] = (await login(`${key}@test.local`)).token;
    api[key] = client(tokens[key], key === "qa" ? "QA" : "PUR");
  }
});

test.after(async () => {
  await closePool();
});

async function makePo(poNo, documentDate = addDays(todayIso(), -20), who = "buyer") {
  const sup = (await api[who].get("/masters/lookup")).body.suppliers.find(s => s.supplierCode === "12200003");
  const lookup = (await api[who].get(`/masters/lookup?supplierId=${sup.id}`)).body.materials;
  const res = await api[who].post("/pos", {
    poNo, supplierId: sup.id, documentDate, shipMode: "SEA",
    items: [{ materialId: lookup[0].id, orderQty: 2, orderUnit: "CAN", netPrice: 100 }]
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.id;
}

test("master import is idempotent and merges duplicates", async () => {
  const n = (await query("SELECT COUNT(1) AS n FROM materials")).recordset[0].n;
  assert.equal(n, 385);
  const preview = await api.secadmin.post("/masters/import/preview", { data: fileBase64(MASTER_FILE) });
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  assert.equal(preview.body.materialsNew, 0);
  assert.equal(preview.body.suppliersNew, 0);
});

test("SAP export preview groups lines into POs and matches the masters", async () => {
  const res = await api.buyer.post("/pos/import/preview", { data: fileBase64(SAP_FILE) });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const { summary, pos } = res.body;
  assert.ok(summary.pos >= 5, `expected several POs, got ${summary.pos}`);
  const first = pos.find(p => p.poNo === "1910000451");
  assert.ok(first);
  assert.equal(first.supplierCode, "12200003");
  assert.equal(first.supplierStatus, "MATCHED");
  assert.equal(first.documentDate, "2026-02-18");
  assert.equal(first.shipMode, "SEA");
  assert.equal(first.itemCount, 10);
  const po453 = pos.find(p => p.poNo === "1910000453");
  assert.ok(po453.items.some(i => i.match === "EXACT"), "raw materials should match the master");
  assert.equal(po453.leadTimeSource, "MATERIAL");
});

test("viewer cannot import; import commit creates POs once", async () => {
  const data = fileBase64(SAP_FILE);
  assert.equal((await api.viewer.post("/pos/import/commit", { data })).status, 403);
  const res = await api.buyer.post("/pos/import/commit", { data, fileName: "DATA BY SAP.xlsx", poNos: ["1910000451", "1910000453"] });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.created.length, 2);
  const again = await api.buyer.post("/pos/import/preview", { data });
  assert.equal(again.body.pos.find(p => p.poNo === "1910000451").status, "EXISTS");
  // Every column of the SAP row is kept, and the uploaded file too.
  const id453 = res.body.created.find(c => c.poNo === "1910000453").id;
  const detail = (await api.viewer.get(`/pos/${id453}`)).body.data;
  const raw = detail.items[0].raw;
  assert.equal(raw["Purchasing Document"], "1910000453");
  assert.ok("Acct Assignment Cat." in raw || "Still to be invoiced (qty)" in raw);
  assert.equal(detail.items[0].stillToInvoiceQty !== undefined, true);
  const batches = (await api.viewer.get("/pos/import/batches")).body.data;
  assert.ok(batches[0].hasFile);
  const file = await api.viewer.get(`/pos/import/batches/${batches[0].id}/file`).buffer(true)
    .parse((r, cb) => { const chunks = []; r.on("data", c => chunks.push(c)); r.on("end", () => cb(null, Buffer.concat(chunks))); });
  assert.equal(file.status, 200);
  assert.equal(file.body.length, require("fs").readFileSync(SAP_FILE).length);
  const list = await api.viewer.get("/pos?q=19100004");
  assert.equal(list.status, 200);
  assert.equal(list.body.total, 2);
  const po = list.body.data.find(p => p.poNo === "1910000453");
  assert.equal(po.currentStep, 2);
  assert.equal(po.etaDate, addDays("2026-02-20", po.leadTimeDays));
});

test("advance: validation, optimistic step check, re-plan from actual dates", async () => {
  const id = await makePo("T-ADV-1", addDays(todayIso(), -30));
  const before = (await api.buyer.get(`/pos/${id}`)).body.data;
  assert.equal(before.steps.length, 9);
  assert.equal(before.steps[0].state, "done");
  assert.equal(before.steps[1].state, "current");

  assert.equal((await api.buyer.post(`/pos/${id}/advance`, { expectedStep: 2, actualDate: addDays(todayIso(), 1) })).status, 400);
  assert.equal((await api.buyer.post(`/pos/${id}/advance`, { expectedStep: 2, actualDate: addDays(todayIso(), -31) })).status, 400);
  assert.equal((await api.buyer.post(`/pos/${id}/advance`, { expectedStep: 3 })).status, 409);
  assert.equal((await api.viewer.post(`/pos/${id}/advance`, { expectedStep: 2 })).status, 403);

  const lateAck = addDays(todayIso(), -2); // plan said -15
  const ok = await api.buyer.post(`/pos/${id}/advance`, { expectedStep: 2, actualDate: lateAck, referenceNo: "141-02-W059" });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const after = (await api.buyer.get(`/pos/${id}`)).body.data;
  assert.equal(after.currentStep, 3);
  assert.equal(after.steps[1].actualDate, lateAck);
  assert.equal(after.steps[1].referenceNo, "141-02-W059");
  assert.equal(after.steps[1].lateDays, 13);
  assert.equal(after.steps[2].dueDate, lateAck); // OCR ACK counts from the real ACK date
  assert.ok(after.etaDate > before.etaDate, "a late ACK must push the ETA");
  assert.ok(after.history.some(h => h.action === "STEP_DONE" && h.stepNo === 2));
  // Double click on the same step is refused, not applied twice.
  assert.equal((await api.buyer.post(`/pos/${id}/advance`, { expectedStep: 2 })).status, 409);
});

test("undo: only the person who did it, or a section admin", async () => {
  const id = await makePo("T-UNDO-1");
  await api.buyer.post(`/pos/${id}/advance`, { expectedStep: 2 });
  assert.equal((await api.buyer2.post(`/pos/${id}/undo`)).status, 403);
  assert.equal((await api.buyer.post(`/pos/${id}/undo`)).status, 200);
  await api.buyer.post(`/pos/${id}/advance`, { expectedStep: 2 });
  assert.equal((await api.secadmin.post(`/pos/${id}/undo`)).status, 200);
  const po = (await api.buyer.get(`/pos/${id}`)).body.data;
  assert.equal(po.currentStep, 2);
  assert.equal(po.steps[1].actualDate, null);
});

test("bulk advance closes the same step on several POs and reports stale ones", async () => {
  const a = await makePo("T-BULK-A");
  const b = await makePo("T-BULK-B");
  const c = await makePo("T-BULK-C");
  await api.buyer.post(`/pos/${c}/advance`, { expectedStep: 2 });
  const res = await api.buyer.post("/pos/bulk-advance", { ids: [a, b, c], expectedStep: 2, referenceNo: "ACK-9" });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.done, 2);
  assert.equal(res.body.failed, 1);
});

test("full run to completion, then dashboard and monthly report", async () => {
  const start = addDays(todayIso(), -60);
  const id = await makePo("T-FULL-1", start);
  for (let step = 2; step <= 9; step += 1) {
    const r = await api.buyer.post(`/pos/${id}/advance`, { expectedStep: step, actualDate: addDays(start, step * 5) });
    assert.equal(r.status, 200, `step ${step}: ${JSON.stringify(r.body)}`);
  }
  const po = (await api.buyer.get(`/pos/${id}`)).body.data;
  assert.equal(po.status, "COMPLETED");
  assert.equal(po.currentStep, 10);
  assert.equal((await api.buyer.post(`/pos/${id}/advance`, {})).status, 400);

  const dash = await api.viewer.get("/reports/dashboard");
  assert.equal(dash.status, 200);
  assert.ok(dash.body.counts.active >= 1);
  assert.equal(dash.body.byStep.length, 8);
  assert.equal(dash.body.trend.length, 6);
  for (const t of dash.body.trend) {
    // Arrived on time / late are a part of what was planned for the month.
    assert.ok(t.plannedOnTime + t.plannedLate <= t.planned, JSON.stringify(t));
  }

  const month = addDays(start, 45).slice(0, 7);
  const rep = await api.viewer.get(`/reports/monthly?month=${month}`);
  assert.equal(rep.status, 200);
  assert.ok(rep.body.arrivals.some(a => a.poNo === "T-FULL-1"));
  const xlsx = await api.viewer.get(`/reports/monthly/export?month=${month}`).buffer(true);
  assert.equal(xlsx.status, 200);
  assert.match(xlsx.headers["content-type"], /spreadsheetml/);
});

test("cancel: creator or section admin; reopen: section admin", async () => {
  const id = await makePo("T-CANCEL-1");
  assert.equal((await api.buyer2.post(`/pos/${id}/cancel`, { reason: "duplicate order" })).status, 403);
  assert.equal((await api.buyer.post(`/pos/${id}/cancel`, { reason: "no" })).status, 400);
  assert.equal((await api.buyer.post(`/pos/${id}/cancel`, { reason: "duplicate order" })).status, 200);
  assert.equal((await api.buyer.post(`/pos/${id}/advance`, { expectedStep: 2 })).status, 400);
  assert.equal((await api.buyer.post(`/pos/${id}/reopen`)).status, 403);
  assert.equal((await api.secadmin.post(`/pos/${id}/reopen`)).status, 200);
  assert.equal((await api.buyer.get(`/pos/${id}`)).body.data.status, "ACTIVE");
});

test("editing the PO date re-plans; only section admins may", async () => {
  const id = await makePo("T-EDIT-1", addDays(todayIso(), -10));
  assert.equal((await api.buyer.patch(`/pos/${id}`, { documentDate: addDays(todayIso(), -12) })).status, 403);
  assert.equal((await api.buyer.patch(`/pos/${id}`, { remark: "urgent", shipMode: "AIR" })).status, 200);
  const r = await api.secadmin.patch(`/pos/${id}`, { documentDate: addDays(todayIso(), -12), leadTimeDays: 90 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const po = (await api.buyer.get(`/pos/${id}`)).body.data;
  assert.equal(po.documentDate, addDays(todayIso(), -12));
  assert.equal(po.leadTimeSource, "MANUAL");
  assert.equal(po.etaDate, addDays(po.documentDate, 90));
  assert.equal(po.remark, "urgent");
  assert.equal(po.shipMode, "AIR");
});

test("sections are isolated", async () => {
  const id = await makePo("T-ISO-1");
  assert.equal((await client(tokens.qa, "PUR").get("/pos")).status, 403);
  assert.equal((await api.qa.get(`/pos/${id}`)).status, 404);
  assert.equal((await api.qa.get("/pos")).body.total, 0);
  assert.equal((await client(tokens.buyer, "QA").get("/pos")).status, 403);
  assert.equal((await client(tokens.admin, "QA").get("/pos")).status, 200);
});

test("duplicate and invalid manual POs are refused", async () => {
  await makePo("T-DUP-1");
  const sup = (await api.buyer.get("/masters/lookup")).body.suppliers[0];
  assert.equal((await api.buyer.post("/pos", { poNo: "T-DUP-1", supplierId: sup.id, documentDate: todayIso(), items: [{ materialCode: "X" }] })).status, 409);
  assert.equal((await api.buyer.post("/pos", { poNo: "T DUP; DROP", supplierId: sup.id, documentDate: todayIso(), items: [{ materialCode: "X" }] })).status, 400);
  assert.equal((await api.buyer.post("/pos", { poNo: "T-FUT", supplierId: sup.id, documentDate: addDays(todayIso(), 3), items: [{ materialCode: "X" }] })).status, 400);
  assert.equal((await api.buyer.post("/pos", { poNo: "T-NOITEM", supplierId: sup.id, documentDate: todayIso(), items: [] })).status, 400);
});

test("masters: section admin edits, user cannot, referenced rows cannot be deleted", async () => {
  const s = await api.buyer.post("/masters/suppliers", { supplierCode: "99999999", name: "TEST SUPPLIER" });
  assert.equal(s.status, 403);
  const created = await api.secadmin.post("/masters/suppliers", { supplierCode: "99999999", name: "TEST SUPPLIER", defaultLeadTimeDays: 45 });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal((await api.secadmin.post("/masters/suppliers", { supplierCode: "99999999", name: "X" })).status, 409);
  const m = await api.secadmin.post("/masters/materials", {
    supplierId: created.body.id, materialCode: "00012345", materialType: "RM-CHE", vendorMaterial: "TEST CHEM", leadTimeDays: 33
  });
  assert.equal(m.status, 201, JSON.stringify(m.body));
  const list = await api.viewer.get(`/masters/materials?supplierId=${created.body.id}`);
  assert.equal(list.body.data[0].materialCode, "12345");
  assert.equal((await api.secadmin.delete(`/masters/suppliers/${created.body.id}`)).status, 409);
  assert.equal((await api.secadmin.delete(`/masters/materials/${m.body.id}`)).status, 200);
  assert.equal((await api.secadmin.delete(`/masters/suppliers/${created.body.id}`)).status, 200);
  const nihon = (await api.viewer.get("/masters/suppliers?q=12200003")).body.data.find(x => x.supplierCode === "12200003");
  assert.equal((await api.secadmin.delete(`/masters/suppliers/${nihon.id}`)).status, 409);
});

test("workflow edits are validated and re-plan open POs", async () => {
  const wf = (await api.viewer.get("/workflow")).body;
  assert.equal(wf.steps.length, 9);
  const bad = wf.steps.map(s => (s.stepNo === 4 ? { ...s, anchorStepNo: 6 } : s));
  assert.equal((await api.secadmin.put("/workflow", { steps: bad })).status, 400);
  assert.equal((await api.buyer.put("/workflow", { steps: wf.steps })).status, 403);
  const id = await makePo("T-WF-1", addDays(todayIso(), -5));
  const before = (await api.buyer.get(`/pos/${id}`)).body.data;
  const longerAck = wf.steps.map(s => (s.stepNo === 2 ? { ...s, offsetDays: 20 } : s));
  const r = await api.secadmin.put("/workflow", { steps: longerAck });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.recalculated >= 1);
  const after = (await api.buyer.get(`/pos/${id}`)).body.data;
  assert.equal(after.steps[1].dueDate, addDays(before.steps[1].dueDate, 5));
  await api.secadmin.put("/workflow", { steps: wf.steps });
});

test("settings are validated", async () => {
  assert.equal((await api.secadmin.put("/settings", { values: { "mail.extraRecipients": "not-an-email" } })).status, 400);
  assert.equal((await api.secadmin.put("/settings", { values: { "workflow.defaultLeadTimeDays": 999 } })).status, 400);
  assert.equal((await api.secadmin.put("/settings", { values: { "nope.key": true } })).status, 400);
  assert.equal((await api.buyer.put("/settings", { values: { "mail.enabled": true } })).status, 403);
  const ok = await api.secadmin.put("/settings", { values: { "mail.extraRecipients": "a@x.com; b@y.com", "alert.dueSoonDays": 5 } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.data["mail.extraRecipients"], "a@x.com, b@y.com");
  assert.equal(ok.body.data["alert.dueSoonDays"], 5);
});

test("mail: preview escapes data, send-now records the outbox, scheduler fires once a day", async () => {
  // The API refuses markup in a PO number, so plant it straight in the table
  // to prove the template escapes whatever the data holds.
  const id = await makePo("T-MAIL-1");
  await query(
    "UPDATE purchase_orders SET po_no = N'T-MAIL-<b>', remark = N'<script>x</script>', supplier_name = N'<img src=x>', supplier_id = NULL WHERE id = @id",
    { id }
  );
  const prev = await api.secadmin.get("/settings/mail/preview");
  assert.equal(prev.status, 200);
  assert.ok(!prev.body.html.includes("<img src=x>"));
  assert.ok(prev.body.html.includes("T-MAIL-&lt;b&gt;"));
  const sent = await api.secadmin.post("/settings/mail/send-now", { kind: "daily", toSelf: true });
  assert.equal(sent.status, 200);
  assert.equal(sent.body.status, "pending_config"); // SMTP is blank in tests

  await api.secadmin.put("/settings", { values: { "mail.enabled": true, "mail.dailyTime": "00:00" } });
  // Pick a weekday noon so the run is due regardless of when the test runs.
  let day = todayIso();
  while ([0, 6].includes(new Date(`${day}T00:00:00Z`).getUTCDay())) day = addDays(day, 1);
  const at = new Date(`${day}T05:00:00Z`).getTime(); // 12:00 Thai
  await tick(at);
  await tick(at);
  const runs = (await query("SELECT COUNT(1) AS n FROM mail_runs WHERE run_type = 'DAILY' AND run_date = @day", { day })).recordset[0].n;
  assert.equal(runs, 1);
});

test("users: section admin cannot create admins; new user must change password", async () => {
  const bad = await api.secadmin.post("/users", { email: "boss@test.local", displayName: "Boss", roleCode: "ADMIN", password: PASSWORD });
  assert.equal(bad.status, 403);
  assert.equal((await api.buyer.get("/users")).status, 403);
  const weak = await api.secadmin.post("/users", { email: "new1@test.local", displayName: "New", roleCode: "USER", password: "abc" });
  assert.equal(weak.status, 400);
  const ok = await api.secadmin.post("/users", { email: "new1@test.local", displayName: "New One", roleCode: "USER", password: PASSWORD });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  await query("UPDATE users SET pdpa_consent_accepted = 1, pdpa_policy_version = (SELECT TOP 1 pdpa_policy_version FROM users WHERE email = 'buyer@test.local') WHERE id = @id", { id: ok.body.id });
  const s = await login("new1@test.local");
  assert.equal(s.user.mustChangePassword, true);
  const same = await request(app).post("/api/auth/first-password").set("Authorization", `Bearer ${s.token}`).send({ newPassword: PASSWORD });
  assert.equal(same.status, 400);
  const changed = await request(app).post("/api/auth/first-password").set("Authorization", `Bearer ${s.token}`).send({ newPassword: "N3w-password-xyz" });
  assert.equal(changed.status, 200, JSON.stringify(changed.body));
  // The old token is revoked by the password change.
  assert.equal((await client(s.token).get("/pos")).status, 401);
  assert.equal((await client(changed.body.token).get("/pos")).status, 200);
  // Section admin edits the user, then deactivation cuts the live token off.
  assert.equal((await api.secadmin.patch(`/users/${ok.body.id}`, { phone: "1234" })).status, 200);
  const row = (await query("SELECT phone, display_name FROM users WHERE id = @id", { id: ok.body.id })).recordset[0];
  assert.equal(row.phone, "1234");
  assert.equal(row.display_name, "New One"); // untouched fields stay
  assert.equal((await api.secadmin.patch(`/users/${ok.body.id}`, { isActive: false })).status, 200);
  assert.equal((await client(changed.body.token).get("/pos")).status, 401);
});

test("account lockout after 5 wrong passwords, admin unlock", async () => {
  for (let i = 0; i < 5; i += 1) {
    const r = await request(app).post("/api/auth/login").send({ email: "buyer2@test.local", password: "wrong-password" });
    assert.equal(r.status, 401);
  }
  const locked = await request(app).post("/api/auth/login").send({ email: "buyer2@test.local", password: PASSWORD });
  assert.equal(locked.status, 401);
  assert.match(locked.body.message, /locked/);
  const users = (await api.secadmin.get("/users")).body.data;
  const b2 = users.find(u => u.email === "buyer2@test.local");
  assert.ok(b2.lockedUntil);
  assert.equal((await api.secadmin.post(`/users/${b2.id}/unlock`)).status, 200);
  assert.equal((await request(app).post("/api/auth/login").send({ email: "buyer2@test.local", password: PASSWORD })).status, 200);
});

test("CSRF: a cookie session must send the CSRF token on writes", async () => {
  const s = await login("buyer@test.local");
  const noToken = await s.agent.post("/api/pos/import/preview").set("X-Section-Code", "PUR").send({ data: "x" });
  assert.equal(noToken.status, 403);
  assert.equal(noToken.body.message, "CSRF_REQUIRED");
  const withToken = await s.agent.get("/api/pos").set("X-Section-Code", "PUR");
  assert.equal(withToken.status, 200);
});

test("PDPA: no consent, no data", async () => {
  await query("UPDATE users SET pdpa_consent_accepted = 0 WHERE email = 'viewer@test.local'");
  const s = await login("viewer@test.local");
  assert.equal((await client(s.token).get("/pos")).status, 403);
  const accepted = await request(app).post("/api/auth/pdpa-consent").set("Authorization", `Bearer ${s.token}`);
  assert.equal(accepted.status, 200);
  assert.equal((await client(accepted.body.token).get("/pos")).status, 200);
});

test("upload checks reject junk and old .xls files", async () => {
  const junk = await api.buyer.post("/pos/import/preview", { data: Buffer.from("hello world").toString("base64") });
  assert.equal(junk.status, 400);
  const xls = Buffer.alloc(16);
  xls[0] = 0xd0; xls[1] = 0xcf;
  const old = await api.buyer.post("/pos/import/preview", { data: xls.toString("base64") });
  assert.equal(old.status, 400);
  assert.match(old.body.message, /xlsx/);
  const tpl = await api.buyer.get("/pos/import/template").buffer(true);
  assert.equal(tpl.status, 200);
});

test("calendar, roadmap and list filters", async () => {
  const cal = await api.viewer.get(`/pos/calendar?month=${todayIso().slice(0, 7)}`);
  assert.equal(cal.status, 200);
  assert.ok(Array.isArray(cal.body.events));
  const rm = await api.viewer.get("/pos/roadmap");
  assert.equal(rm.status, 200);
  assert.ok(rm.body.data.every(p => p.steps.length === 9));
  const overdue = await api.viewer.get("/pos?due=OVERDUE&pageSize=500");
  assert.ok(overdue.body.data.every(p => p.dueState === "overdue"));
  const done = await api.viewer.get("/pos?status=COMPLETED");
  assert.ok(done.body.data.every(p => p.status === "COMPLETED"));
  const exp = await api.viewer.get("/pos/export?status=ACTIVE").buffer(true);
  assert.equal(exp.status, 200);
});

// --- Security parity with RAP (token-revocation, session-relogin,
// security-hardening tests over there). buyer2 is not used after this point.

test("logout revokes the account's tokens on every device", async () => {
  const a = await login("buyer2@test.local");
  const b = await login("buyer2@test.local");
  assert.equal((await client(b.token).get("/pos")).status, 200);
  const out = await a.agent.post("/api/auth/logout").set("Authorization", `Bearer ${a.token}`).set("X-CSRF-Token", a.csrf);
  assert.equal(out.status, 200);
  const other = await client(b.token).get("/pos");
  assert.equal(other.status, 401);
  assert.equal(other.body.message, "SESSION_REVOKED");
});

test("a revoked session cookie does not block the next sign-in", async () => {
  const s = await login("buyer2@test.local");
  // Revoked from elsewhere (password reset, logout on another device).
  await query("UPDATE users SET token_version = token_version + 1 WHERE email = 'buyer2@test.local'");
  require("../src/services/accountState").resetAccountStateCache();
  assert.equal((await s.agent.get("/api/auth/session")).status, 401);
  // Same browser, no CSRF token: login must still work (no CSRF_REQUIRED lockout).
  const again = await s.agent.post("/api/auth/login").send({ email: "buyer2@test.local", password: PASSWORD });
  assert.equal(again.status, 200, JSON.stringify(again.body));
});

test("tokens: alg none and a foreign secret are refused", async () => {
  const jwt = require("jsonwebtoken");
  const s = await login("buyer2@test.local");
  const claims = jwt.decode(s.token);
  delete claims.iat;
  delete claims.exp;
  const none = jwt.sign(claims, null, { algorithm: "none" });
  assert.equal((await client(none).get("/pos")).status, 401);
  const forged = jwt.sign(claims, "not-the-server-secret", { algorithm: "HS256" });
  assert.equal((await client(forged).get("/pos")).status, 401);
});

test("failed sign-ins are audited with IP and user agent, never the password", async () => {
  await request(app).post("/api/auth/login").set("User-Agent", "audit-probe").send({ email: "nobody@test.local", password: "S3cret-guess" });
  const row = (await query(
    "SELECT TOP 1 * FROM audit_logs WHERE action = 'LOGIN_FAILED' AND entity_id = 'nobody@test.local' ORDER BY id DESC"
  )).recordset[0];
  assert.ok(row);
  assert.ok(row.ip_address);
  assert.equal(row.user_agent, "audit-probe");
  assert.doesNotMatch(JSON.stringify(row), /S3cret-guess/);
});

test("security headers on API responses", async () => {
  const res = await request(app).get("/api/health");
  assert.equal(res.headers["x-powered-by"], undefined);
  assert.match(res.headers["content-security-policy"], /default-src 'none'/);
  assert.match(res.headers["content-security-policy"], /frame-ancestors 'none'/);
  assert.match(res.headers["permissions-policy"], /camera=\(\)/);
  assert.equal(res.headers["x-content-type-options"], "nosniff");
  const cors = await request(app).get("/api/health").set("Origin", "http://evil.example");
  assert.equal(cors.headers["access-control-allow-origin"], undefined);
});
