const { DONE_STEP, STEP_COUNT, insertDefaultSteps } = require("../services/workflowService");

// Data changes that schema.sql (CREATE-if-missing) cannot make on its own.
// Each is idempotent: a no-op once applied. Run by `npm run db:init` and at
// every API start, so pulling the code and restarting is enough.
//
// (Older) Step 10 "Monthly report" was dropped (it is the month-end email, not a step
// of a shipment), so a PO is complete once its goods are received (step 9):
//   - POs that were only waiting for "Monthly report" become COMPLETED, dated
//     the day their goods were received;
//   - "done" moves from current_step 11 to 10;
//   - step 10 rows go from po_steps and workflow_steps;
//   - a section whose arrival flag sat on a removed step gets it on the last one.
async function removeStepsAfterLast(runner) {
  const result = await runner.query(
    `SET XACT_ABORT ON;
     BEGIN TRANSACTION;
     UPDATE p SET status = 'COMPLETED', next_due_date = NULL,
       completed_at = COALESCE(p.completed_at,
         (SELECT TOP 1 CAST(ps.actual_date AS DATETIME2) FROM po_steps ps WHERE ps.po_id = p.id AND ps.step_no = @stepCount),
         DATEADD(HOUR, 7, SYSUTCDATETIME()))
     FROM purchase_orders p
     WHERE p.status = 'ACTIVE' AND p.current_step > @stepCount;
     DECLARE @completed INT = @@ROWCOUNT;
     UPDATE purchase_orders SET current_step = @doneStep WHERE current_step > @doneStep;
     DELETE FROM po_steps WHERE step_no > @stepCount;
     DECLARE @poSteps INT = @@ROWCOUNT;
     DELETE FROM workflow_steps WHERE step_no > @stepCount;
     DECLARE @workflowSteps INT = @@ROWCOUNT;
     UPDATE w SET is_arrival = 1
     FROM workflow_steps w
     WHERE w.step_no = @stepCount AND NOT EXISTS (
       SELECT 1 FROM workflow_steps x WHERE x.section_id = w.section_id AND x.is_arrival = 1 AND x.step_no <= @stepCount);
     COMMIT TRANSACTION;
     SELECT @completed AS completed, @poSteps AS poSteps, @workflowSteps AS workflowSteps;`,
    { stepCount: STEP_COUNT, doneStep: DONE_STEP }
  );
  return result.recordset?.[0] || { completed: 0, poSteps: 0, workflowSteps: 0 };
}

// 9 steps -> 7 (Purchase meeting 2026-11): "OCR Acknowledgement to SAP" (3)
// and "OCR Shipping Instruction to SAP" (5) are gone — the supplier's ACK and
// S/I are now the OCR files themselves. For every PO still on the old layout
// (it has a step-9 row):
//   old step 1 2 4 6 7 8 9  ->  new 1 2 3 4 5 6 7   (3 and 5 dropped)
//   current_step: 2->2, 3/4->3, 5/6->4, 7->5, 8->6, 9->7, done (10+)->8
//   delivery_date <- the old arrival step's due date, so step 7 keeps its date
// and a section whose workflow still has nine steps gets the new defaults.
async function remapNineToSeven(runner) {
  const result = await runner.query(
    `SET XACT_ABORT ON;
     BEGIN TRANSACTION;
     DECLARE @old TABLE (id INT PRIMARY KEY);
     INSERT INTO @old (id)
       SELECT DISTINCT po_id FROM po_steps WHERE step_no = 9;
     DECLARE @pos INT = @@ROWCOUNT;
     UPDATE p SET delivery_date = ps.due_date
     FROM purchase_orders p JOIN po_steps ps ON ps.po_id = p.id AND ps.step_no = 9
     WHERE p.id IN (SELECT id FROM @old) AND p.delivery_date IS NULL;
     DELETE FROM po_steps WHERE po_id IN (SELECT id FROM @old) AND (step_no IN (3, 5) OR step_no > 9);
     UPDATE po_steps SET step_no = CASE step_no WHEN 4 THEN 3 WHEN 6 THEN 4 WHEN 7 THEN 5 WHEN 8 THEN 6 WHEN 9 THEN 7 END
     WHERE po_id IN (SELECT id FROM @old) AND step_no IN (4, 6, 7, 8, 9);
     UPDATE purchase_orders SET current_step = CASE
         WHEN current_step <= 2 THEN current_step
         WHEN current_step IN (3, 4) THEN 3
         WHEN current_step IN (5, 6) THEN 4
         WHEN current_step = 7 THEN 5
         WHEN current_step = 8 THEN 6
         WHEN current_step = 9 THEN 7
         ELSE 8 END
     WHERE id IN (SELECT id FROM @old);
     UPDATE purchase_orders SET ack_no = (SELECT TOP 1 ps.reference_no FROM po_steps ps
         WHERE ps.po_id = purchase_orders.id AND ps.step_no = 2 AND ps.reference_no IS NOT NULL)
     WHERE id IN (SELECT id FROM @old) AND ack_no IS NULL;
     UPDATE po_history SET step_no = CASE step_no WHEN 3 THEN 2 WHEN 4 THEN 3 WHEN 5 THEN 3 WHEN 6 THEN 4
         WHEN 7 THEN 5 WHEN 8 THEN 6 WHEN 9 THEN 7 ELSE step_no END
     WHERE po_id IN (SELECT id FROM @old) AND step_no >= 3;
     DECLARE @sections TABLE (id INT PRIMARY KEY);
     INSERT INTO @sections (id) SELECT DISTINCT section_id FROM workflow_steps WHERE step_no > 7;
     DELETE FROM workflow_steps WHERE section_id IN (SELECT id FROM @sections);
     COMMIT TRANSACTION;
     SELECT @pos AS pos, (SELECT COUNT(1) FROM @sections) AS sections;
     SELECT id FROM @sections;`,
    {}
  );
  const r = result.recordset?.[0] || { pos: 0, sections: 0 };
  const sectionIds = (result.recordsets?.[1] || []).map(x => x.id);
  for (const id of sectionIds) await insertDefaultSteps(runner, id);
  return { ...r, sectionIds };
}

async function runMigrations(runner, log = console.log) {
  const m = await remapNineToSeven(runner);
  if (m.pos || m.sections) {
    log(`Migration: 9 steps -> 7 — ${m.pos} PO(s) remapped, workflow reset in ${m.sections} section(s)`);
    // New offsets: re-plan every open PO of the sections touched.
    const { recomputeSection } = require("../services/poService");
    const sections = (await runner.query("SELECT DISTINCT section_id AS id FROM purchase_orders")).recordset.map(x => x.id);
    for (const id of sections) {
      const n = await recomputeSection(id);
      log(`Migration: re-planned ${n} open PO(s) in section ${id}`);
    }
  }
  const r = await removeStepsAfterLast(runner);
  if (r.completed || r.poSteps || r.workflowSteps) {
    log(`Migration: removed step(s) after ${STEP_COUNT} — ${r.completed} PO(s) completed, ` +
      `${r.poSteps} PO step row(s) and ${r.workflowSteps} workflow step row(s) deleted`);
  }
}

module.exports = { runMigrations };
