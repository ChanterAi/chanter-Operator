import { Router } from "express";
import { productLanes } from "../types.js";
import { actionTypes, type ActionType } from "../types.js";
import { OperatorError, OperatorService } from "../services/operatorService.js";
import type { AutoPosterMissionService } from "../runtimeMissions/autoPosterMissionService.js";
import type { AgentRunLedgerService } from "../agentRunLedger/agentRunLedgerService.js";
import type { GenericMissionService } from "../missions/genericMissionService.js";
import { resolveRegisteredMissionAction } from "../missions/missionActionRegistry.js";
import {
  capabilityTokenIsDistinct,
  createCapabilityTokenMiddleware,
} from "../middleware/capabilityToken.js";
import { config } from "../config.js";
import {
  envelopeToRuntimeMissionRequest,
  validateMissionEnvelope,
} from "chanter-agent-runtime";

const AUTOPOSTER_SCHEDULE_INPUT_KEYS = new Set([
  "accountId",
  "provider",
  "mediaUrl",
  "caption",
  "hashtags",
  "title",
  "description",
  "scheduledAt",
]);

function normalizeActionType(value: unknown): ActionType {
  return typeof value === "string" && actionTypes.includes(value as ActionType)
    ? (value as ActionType)
    : "unknown";
}

function scheduleInputFromEnvelope(value: unknown): Record<string, unknown> {
  const validation = validateMissionEnvelope(value);
  if (!validation.ok) {
    const first = validation.errors[0];
    throw new OperatorError(
      first?.message ?? "Mission envelope validation failed.",
      400,
      first?.code ?? "OPERATOR_MISSION_ENVELOPE_INVALID",
    );
  }
  const request = envelopeToRuntimeMissionRequest(validation.value);
  if (request.product !== "auto_poster" || request.action !== "autoposter.post.schedule") {
    throw new OperatorError(
      "The mission target is not registered with the Operator gateway.",
      409,
      "OPERATOR_MISSION_TARGET_MISMATCH",
    );
  }
  if (!request.tenant.accountId) {
    throw new OperatorError(
      "tenant.accountId is required for an AutoPoster schedule mission.",
      400,
      "OPERATOR_MISSION_SCOPE_INVALID",
    );
  }
  if (Object.keys(request.input).some((key) => !AUTOPOSTER_SCHEDULE_INPUT_KEYS.has(key))) {
    throw new OperatorError(
      "The mission input contains a field that is not registered for this action.",
      400,
      "OPERATOR_MISSION_INPUT_UNSUPPORTED_FIELD",
    );
  }
  if (
    request.input.accountId !== undefined
    && request.input.accountId !== request.tenant.accountId
  ) {
    throw new OperatorError(
      "The mission input account does not match the exact tenant account scope.",
      409,
      "OPERATOR_MISSION_SCOPE_MISMATCH",
    );
  }
  return {
    missionId: request.missionId,
    traceId: request.traceId,
    idempotencyKey: request.idempotencyKey,
    requestedBy: request.actor.id,
    tenantUserId: request.tenant.userId,
    workspaceId: request.tenant.workspaceId,
    accountId: request.tenant.accountId,
    product: request.product,
    action: request.action,
    provider: request.input.provider,
    mediaUrl: request.input.mediaUrl,
    caption: request.input.caption,
    hashtags: request.input.hashtags,
    title: request.input.title,
    description: request.input.description,
    scheduledAt: request.input.scheduledAt,
  };
}

export function createApiRouter(
  service: OperatorService,
  runtimeMissionService?: AutoPosterMissionService,
  agentRunLedgerService?: AgentRunLedgerService,
  genericMissionService?: GenericMissionService,
): Router {
  const router = Router();

  // Capability-token middleware for write endpoints (fail-closed).
  const missionSubmitTokenMiddleware = createCapabilityTokenMiddleware({
    tokenEnvVar: "OPERATOR_MISSION_SUBMIT_TOKEN",
    tokenValue: config.missionSubmit.token,
    endpointLabel: "Mission submission",
    forbiddenTokenValues: [
      config.missionControl.token,
      config.autoPosterRuntime.serviceToken,
      config.ledgerIngest.token,
    ],
  });
  const missionControlTokenMiddleware = createCapabilityTokenMiddleware({
    tokenEnvVar: "OPERATOR_CONTROL_TOKEN",
    tokenValue: config.missionControl.token,
    endpointLabel: "Operator mission control",
    forbiddenTokenValues: [
      config.missionSubmit.token,
      config.autoPosterRuntime.serviceToken,
      config.ledgerIngest.token,
    ],
  });
  const ledgerIngestTokenMiddleware = createCapabilityTokenMiddleware({
    tokenEnvVar: "OPERATOR_LEDGER_INGEST_TOKEN",
    tokenValue: config.ledgerIngest.token,
    endpointLabel: "Agent Run Ledger ingest",
    forbiddenTokenValues: [
      config.missionSubmit.token,
      config.missionControl.token,
      config.autoPosterRuntime.serviceToken,
    ],
  });

  const requireRuntimeMissionService = (): AutoPosterMissionService => {
    if (!runtimeMissionService) {
      throw new OperatorError("AutoPoster runtime missions are unavailable.", 503);
    }
    return runtimeMissionService;
  };

  const requireAgentRunLedgerService = (): AgentRunLedgerService => {
    if (!agentRunLedgerService) {
      throw new OperatorError("Agent Run Ledger is unavailable.", 503, "AGENT_RUN_LEDGER_UNAVAILABLE");
    }
    return agentRunLedgerService;
  };

  const requireGenericMissionService = (): GenericMissionService => {
    if (!genericMissionService) {
      throw new OperatorError("Generic runtime missions are unavailable.", 503);
    }
    return genericMissionService;
  };

  // Phase 2C: true only when the mission id belongs to the generic durable
  // spine; every other id (including unknown ids) keeps the exact legacy path.
  const isGenericMission = (missionId: string): boolean =>
    Boolean(genericMissionService?.hasMission(missionId));

  const missionSubmitReady = capabilityTokenIsDistinct(
    config.missionSubmit.token,
    [
      config.missionControl.token,
      config.autoPosterRuntime.serviceToken,
      config.ledgerIngest.token,
    ],
  );
  const missionControlReady = capabilityTokenIsDistinct(
    config.missionControl.token,
    [
      config.missionSubmit.token,
      config.autoPosterRuntime.serviceToken,
      config.ledgerIngest.token,
    ],
  );
  const ledgerIngestReady = capabilityTokenIsDistinct(
    config.ledgerIngest.token,
    [
      config.missionSubmit.token,
      config.missionControl.token,
      config.autoPosterRuntime.serviceToken,
    ],
  );

  router.get("/health", (_request, response) => {
    const integrity = service.checkIntegrity();
    response.json({
      status: "ok",
      runner: "mock",
      mode: "safe / review-only",
      execution: "contained_simulation",
      real_execution_enabled: false,
      network_execution_enabled: false,
      missionSubmit: {
        configured: Boolean(config.missionSubmit.token),
        isolated: missionSubmitReady,
        ready: missionSubmitReady,
        endpoints: [
          "/api/runtime-missions",
          "/api/runtime-missions/autoposter/schedule",
        ],
      },
      missionControl: {
        configured: Boolean(config.missionControl.token),
        isolated: missionControlReady,
        ready: missionControlReady,
        endpoints: [
          "/api/runtime-missions/:missionId/approve",
          "/api/runtime-missions/:missionId/reconcile",
          "/api/runtime-missions/:missionId/resume",
          "/api/runtime-missions/:missionId/stop",
        ],
      },
      ledgerIngest: {
        configured: Boolean(config.ledgerIngest.token),
        isolated: ledgerIngestReady,
        ready: ledgerIngestReady,
        endpoints: ["/api/agent-run-ledger/entries"],
      },
      runtimeMissions: {
        autoposter: runtimeMissionService?.getReadiness() ?? {
          configured: false,
          executionScope: "schedule_unapproved_draft_only",
          actions: ["autoposter.post.schedule"],
          publishingEnabled: false,
        },
      },
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

  router.post("/agent-run-ledger/entries", ledgerIngestTokenMiddleware, (request, response) => {
    const result = requireAgentRunLedgerService().ingestEntry(request.body);
    if (result.kind === "applied") {
      response.status(result.replayed ? 200 : 201).json({ replayed: result.replayed, run: result.run });
      return;
    }
    response.status(202).json({
      accepted: true,
      applied: false,
      gap_state: result.gap_state,
      run_id: result.run_id,
      event_id: result.event_id,
      sequence: result.sequence,
      payload_hash: result.payload_hash,
      last_applied_sequence: result.last_applied_sequence,
      last_received_sequence: result.last_received_sequence,
    });
  });

  router.get("/agent-run-ledger/runs", (request, response) => {
    response.json(requireAgentRunLedgerService().listRuns({
      product: request.query.product,
      workflow: request.query.workflow,
      provider: request.query.provider,
      model: request.query.model,
      status: request.query.status,
      approvalStatus: request.query.approvalStatus,
      validationResult: request.query.validationResult,
      outcome: request.query.outcome,
      from: request.query.from,
      to: request.query.to,
      limit: request.query.limit,
    }));
  });

  router.get("/agent-run-ledger/runs/:runId", (request, response) => {
    response.json(requireAgentRunLedgerService().getRun(request.params.runId));
  });

  router.get("/agent-run-ledger/runs/:runId/ingest-status", (request, response) => {
    response.json(requireAgentRunLedgerService().getIngestProjection(request.params.runId));
  });

  router.get("/runtime-missions", (request, response) => {
    const parsedLimit = Number(request.query.limit ?? 50);
    response.json({ missions: requireRuntimeMissionService().listMissions(parsedLimit) });
  });

  router.post("/runtime-missions", missionSubmitTokenMiddleware, (request, response, next) => {
    // Phase 2C dispatch: only envelopes whose exact (product, action) pair is
    // registered on the generic lane take the new spine. Everything else —
    // AutoPoster envelopes, invalid envelopes, unknown targets — follows the
    // accepted Phase 2A path with identical ordering and identical errors.
    try {
      const validation = validateMissionEnvelope(request.body);
      const registered = validation.ok
        ? resolveRegisteredMissionAction(
            validation.value.target.product,
            validation.value.target.action,
          )
        : null;
      if (validation.ok && registered?.lane === "generic") {
        requireGenericMissionService()
          .createMissionFromEnvelope(validation.value)
          .then((mission) => response.status(mission.replayed ? 200 : 201).json(mission))
          .catch(next);
        return;
      }
      const missions = requireRuntimeMissionService();
      const input = scheduleInputFromEnvelope(request.body);
      missions
        .createScheduleMission(input)
        .then((mission) => response.status(mission.replayed ? 200 : 201).json(mission))
        .catch(next);
    } catch (error) {
      next(error);
    }
  });

  router.get("/runtime-missions/:missionId", (request, response) => {
    const missionId = String(request.params.missionId);
    if (isGenericMission(missionId)) {
      response.json(requireGenericMissionService().getMission(missionId));
      return;
    }
    response.json(requireRuntimeMissionService().getMission(missionId));
  });

  router.get("/runtime-missions/autoposter/connected-accounts", (request, response, next) => {
    let missions: AutoPosterMissionService;
    try {
      missions = requireRuntimeMissionService();
    } catch (error) {
      next(error);
      return;
    }
    missions
      .listConnectedAccounts(request.query.workspaceId)
      .then((result) => response.json(result))
      .catch(next);
  });

  router.post("/runtime-missions/autoposter/schedule", missionSubmitTokenMiddleware, (request, response, next) => {
    let missions: AutoPosterMissionService;
    try {
      missions = requireRuntimeMissionService();
    } catch (error) {
      next(error);
      return;
    }
    missions
      .createScheduleMission(request.body)
      .then((mission) => response.status(mission.replayed ? 200 : 201).json(mission))
      .catch(next);
  });

  router.post("/runtime-missions/:missionId/approve", missionControlTokenMiddleware, (request, response, next) => {
    const missionId = String(request.params.missionId);
    if (isGenericMission(missionId)) {
      requireGenericMissionService()
        .approveAndExecute(missionId, request.body?.approvedBy)
        .then((mission) => response.json(mission))
        .catch(next);
      return;
    }
    let missions: AutoPosterMissionService;
    try {
      missions = requireRuntimeMissionService();
    } catch (error) {
      next(error);
      return;
    }
    missions
      .approveAndExecute(missionId, request.body?.approvedBy)
      .then((mission) => response.json(mission))
      .catch(next);
  });

  router.post("/runtime-missions/:missionId/reconcile", missionControlTokenMiddleware, (request, response, next) => {
    const missionId = String(request.params.missionId);
    if (isGenericMission(missionId)) {
      requireGenericMissionService()
        .reconcileMission(missionId)
        .then((mission) => response.json(mission))
        .catch(next);
      return;
    }
    let missions: AutoPosterMissionService;
    try {
      missions = requireRuntimeMissionService();
    } catch (error) {
      next(error);
      return;
    }
    missions.reconcileMission(missionId)
      .then((mission) => response.json(mission))
      .catch(next);
  });

  router.post("/runtime-missions/:missionId/resume", missionControlTokenMiddleware, (request, response, next) => {
    const missionId = String(request.params.missionId);
    if (isGenericMission(missionId)) {
      requireGenericMissionService()
        .resumeSafely(missionId)
        .then((mission) => response.json(mission))
        .catch(next);
      return;
    }
    let missions: AutoPosterMissionService;
    try {
      missions = requireRuntimeMissionService();
    } catch (error) {
      next(error);
      return;
    }
    missions.resumeSafely(missionId)
      .then((mission) => response.json(mission))
      .catch(next);
  });

  router.post("/runtime-missions/:missionId/stop", missionControlTokenMiddleware, (request, response, next) => {
    try {
      const missionId = String(request.params.missionId);
      if (isGenericMission(missionId)) {
        response.json(requireGenericMissionService().stopAndEscalate(missionId));
        return;
      }
      response.json(requireRuntimeMissionService().stopAndEscalate(missionId));
    } catch (error) {
      next(error);
    }
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

  // P1.0: Read-only command runner endpoints
  router.post("/commands/run", async (request, response) => {
    try {
      const command = typeof request.body?.command === "string" ? request.body.command : "";
      const result = await service.runReadonlyCommand(command);
      response.status(201).json(result);
    } catch (error) {
      if (error instanceof Error && "statusCode" in error) {
        const opErr = error as Error & { statusCode: number };
        response.status(opErr.statusCode).json({ error: opErr.message });
        return;
      }
      throw error;
    }
  });

  router.get("/commands/results", (request, response) => {
    const parsedLimit = Number(request.query.limit ?? 50);
    const limit = Number.isFinite(parsedLimit) ? parsedLimit : 50;
    response.json({ results: service.listReadonlyCommandResults(limit) });
  });

  return router;
}
