const express = require("express");
const { z } = require("zod");
const { withTransaction } = require("../../db/pool");
const { asyncHandler } = require("../../middleware/asyncHandler");
const { writeAudit } = require("../../middleware/audit");
const { requireSectionAdmin, resolveSection } = require("../../services/sectionService");
const { DEFAULT_STEPS, flexOffsetFor, getWorkflow, validateWorkflow } = require("../../services/workflowService");
const { getSectionSettings, scheduleSettings } = require("../../services/settingsService");
const { recomputeSection } = require("../../services/poService");
const { emitSection } = require("../../services/realtimeService");

const router = express.Router();
router.use(resolveSection);

router.get("/", asyncHandler(async (req, res) => {
  const [steps, settings] = await Promise.all([getWorkflow(req.section.id), getSectionSettings(req.section.id)]);
  const sched = scheduleSettings(settings);
  // A worked example for the page: what the flex step becomes at a few
  // typical lead times from the material master.
  const examples = [30, 60, 76, 120, 150].map(days => ({ leadTimeDays: days, flexDays: flexOffsetFor(steps, days, sched) }));
  res.json({ steps, settings: sched, examples, defaults: DEFAULT_STEPS });
}));

const stepSchema = z.object({
  stepNo: z.number().int().min(1).max(10),
  name: z.string().trim().min(1).max(150),
  shortName: z.string().trim().min(1).max(40),
  description: z.string().trim().max(500).optional().nullable(),
  anchorStepNo: z.number().int().min(1).max(9).nullable(),
  offsetDays: z.number().int().min(0).max(365),
  offsetMode: z.enum(["DAYS", "END_OF_MONTH"]),
  isFlex: z.boolean(),
  isArrival: z.boolean(),
  referenceLabel: z.string().trim().max(80).optional().nullable()
});

router.put("/", requireSectionAdmin, asyncHandler(async (req, res) => {
  const { steps, recalculate } = z.object({ steps: z.array(stepSchema).length(10), recalculate: z.boolean().default(true) }).parse(req.body);
  const normalized = steps.map(s => (s.stepNo === 1 ? { ...s, anchorStepNo: null, offsetDays: 0, offsetMode: "DAYS", isFlex: false } : s));
  const problems = validateWorkflow(normalized);
  if (problems.length) return res.status(400).json({ message: problems[0], problems });
  await withTransaction(async tx => {
    for (const s of normalized) {
      await tx.query(
        `UPDATE workflow_steps SET name = @name, short_name = @shortName, description = @description,
           anchor_step_no = @anchorStepNo, offset_days = @offsetDays, offset_mode = @offsetMode,
           is_flex = @isFlex, is_arrival = @isArrival, reference_label = @referenceLabel,
           updated_at = DATEADD(HOUR, 7, SYSUTCDATETIME())
         WHERE section_id = @sectionId AND step_no = @stepNo`,
        {
          sectionId: req.section.id, ...s, description: s.description || null, referenceLabel: s.referenceLabel || null,
          isFlex: s.isFlex ? 1 : 0, isArrival: s.isArrival ? 1 : 0
        }
      );
    }
  });
  const recalculated = recalculate ? await recomputeSection(req.section.id) : 0;
  await writeAudit({
    actorId: req.user.id, sectionId: req.section.id, action: "EDIT", entityType: "WORKFLOW", entityId: req.section.code,
    afterValue: { steps: normalized, recalculated }, ip: req.ip, userAgent: req.headers["user-agent"]
  });
  emitSection(req.section.code, "workflow.updated");
  emitSection(req.section.code, "po.updated");
  res.json({ ok: true, recalculated });
}));

router.post("/recalculate", requireSectionAdmin, asyncHandler(async (req, res) => {
  const recalculated = await recomputeSection(req.section.id);
  await writeAudit({
    actorId: req.user.id, sectionId: req.section.id, action: "RECALCULATE", entityType: "WORKFLOW", entityId: req.section.code,
    afterValue: { recalculated }, ip: req.ip, userAgent: req.headers["user-agent"]
  });
  emitSection(req.section.code, "po.updated");
  res.json({ ok: true, recalculated });
}));

module.exports = router;
