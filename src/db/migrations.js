const { DONE_STEP, STEP_COUNT } = require("../services/workflowService");

// Data changes that schema.sql (CREATE-if-missing) cannot make on its own.
// Each is idempotent: a no-op once applied. Run by `npm run db:init` and at
// every API start, so pulling the code and restarting is enough.
//
// Step 10 "Monthly report" was dropped (it is the month-end email, not a step
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

async function runMigrations(runner, log = console.log) {
  const r = await removeStepsAfterLast(runner);
  if (r.completed || r.poSteps || r.workflowSteps) {
    log(`Migration: removed step(s) after ${STEP_COUNT} — ${r.completed} PO(s) completed, ` +
      `${r.poSteps} PO step row(s) and ${r.workflowSteps} workflow step row(s) deleted`);
  }
}

module.exports = { runMigrations };
