import { Router } from "express";
import { productLanes } from "../types.js";
import { actionTypes, type ActionType } from "../types.js";
import { OperatorService } from "../services/operatorService.js";

function normalizeActionType(value: unknown): ActionType {
  return typeof value === "string" && actionTypes.includes(value as ActionType)
    ? (value as ActionType)
    : "unknown";
}

export function createApiRouter(service: OperatorService): Router {
  const router = Router();

  router.get("/health", (_request, response) => {
    const integrity = service.checkIntegrity();
    response.json({
      status: "ok",
      runner: "mock",
      mode: "safe / review-only",
      execution: "contained_simulation",
      real_execution_enabled: false,
      network_execution_enabled: false,
      integrity: {
        healthy: integrity.healthy,
        database: {
          tasks: integrity.database.taskCount,
          steps: integrity.database.stepCount,
          evidence: integrity.database.evidenceCount,
          issues: integrity.database.issues.length,
        },
        audit: {
          totalLines: integrity.audit.totalLines,
          validEvents: integrity.audit.validEvents,
          parseErrors: integrity.audit.parseErrors,
          missingFieldErrors: integrity.audit.missingFieldErrors,
          invalidTypeErrors: integrity.audit.invalidTypeErrors,
          crossRefIssues: integrity.audit.crossRefIssues.length,
        },
        checkedAt: integrity.timestamp,
      },
    });
  });

  router.get("/lanes", (_request, response) => {
    response.json({ lanes: productLanes });
  });

  router.get("/tasks", (_request, response) => {
    response.json({ tasks: service.listTasks() });
  });

  router.post("/tasks", (request, response) => {
    const detail = service.createTask({
      rawInput: typeof request.body?.rawInput === "string" ? request.body.rawInput : "",
      actionType: normalizeActionType(request.body?.actionType),
      priority: request.body?.priority,
      workspaceRelativePath:
        typeof request.body?.workspaceRelativePath === "string"
          ? request.body.workspaceRelativePath
          : undefined,
      productLane:
        typeof request.body?.productLane === "string"
          ? request.body.productLane
          : undefined,
    });
    response.status(201).json(detail);
  });

  router.get("/tasks/:taskId", (request, response) => {
    response.json(service.getTaskDetail(request.params.taskId));
  });

  router.post("/tasks/:taskId/cancel", (request, response) => {
    response.json(service.cancelTask(request.params.taskId));
  });

  router.post("/tasks/:taskId/retry", (request, response) => {
    response.json(service.retryTask(request.params.taskId));
  });

  router.post("/steps/:stepId/approve", (request, response) => {
    response.json(service.approveStep(request.params.stepId));
  });

  router.post("/steps/:stepId/reject", (request, response) => {
    const reason = typeof request.body?.reason === "string" ? request.body.reason : undefined;
    response.json(service.rejectStep(request.params.stepId, reason));
  });



  router.post("/tasks/:taskId/runner-policy-previews", (request, response) => {
    const proposedCommand = typeof request.body?.proposedCommand === "string" ? request.body.proposedCommand : "";
    const proposedPurpose = typeof request.body?.proposedPurpose === "string" ? request.body.proposedPurpose : "";
    response.status(201).json(
      service.previewRunnerPolicy(request.params.taskId, { proposedCommand, proposedPurpose }),
    );
  });
  router.get("/tasks/:taskId/evidence-bundle", (request, response) => {
    response.status(200).json(service.buildEvidenceBundle(request.params.taskId));
  });

  router.post("/tasks/:taskId/commit-reviews", (request, response) => {
    const summaryText = typeof request.body?.summaryText === "string" ? request.body.summaryText : "";
    const changedFilesText = typeof request.body?.changedFilesText === "string" ? request.body.changedFilesText : "";
    const validationText = typeof request.body?.validationText === "string" ? request.body.validationText : "";
    const riskNotesText = typeof request.body?.riskNotesText === "string" ? request.body.riskNotesText : "";
    response.status(201).json(
      service.addCommitReview(request.params.taskId, summaryText, changedFilesText, validationText, riskNotesText),
    );
  });
  router.post("/tasks/:taskId/validations", (request, response) => {
    const commandLabel = typeof request.body?.commandLabel === "string" ? request.body.commandLabel : "";
    const status = typeof request.body?.status === "string" ? request.body.status : "";
    const output = typeof request.body?.output === "string" ? request.body.output : "";
    response.status(201).json(
      service.addValidationEvidence(request.params.taskId, commandLabel, status, output),
    );
  });

  router.get("/audit", (request, response) => {
    const parsedLimit = Number(request.query.limit ?? 50);
    const limit = Number.isFinite(parsedLimit) ? parsedLimit : 50;
    response.json({ events: service.listAuditEvents(limit) });
  });

  return router;
}
