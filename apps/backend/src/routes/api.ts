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
    response.json({
      status: "ok",
      runner: "mock",
      mode: "safe / review-only",
      execution: "contained_simulation",
      real_execution_enabled: false,
      network_execution_enabled: false,
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

  router.post("/steps/:stepId/approve", (request, response) => {
    response.json(service.approveStep(request.params.stepId));
  });

  router.post("/steps/:stepId/reject", (request, response) => {
    const reason = typeof request.body?.reason === "string" ? request.body.reason : undefined;
    response.json(service.rejectStep(request.params.stepId, reason));
  });

  router.get("/audit", (request, response) => {
    const parsedLimit = Number(request.query.limit ?? 50);
    const limit = Number.isFinite(parsedLimit) ? parsedLimit : 50;
    response.json({ events: service.listAuditEvents(limit) });
  });

  return router;
}
