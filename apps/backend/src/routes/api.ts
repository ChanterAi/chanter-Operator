import { Router } from "express";
import { productLanes } from "../types.js";
import { actionTypes, type ActionType } from "../types.js";
import { OperatorError, OperatorService } from "../services/operatorService.js";
import type { AutoPosterMissionService } from "../runtimeMissions/autoPosterMissionService.js";
import type { AgentRunLedgerService } from "../agentRunLedger/agentRunLedgerService.js";
import type { GenericMissionService } from "../missions/genericMissionService.js";
import type { MissionGraphService } from "../missions/missionGraphService.js";
import type { AutoPosterGraphIntakeService } from "../missions/autoPosterGraphIntake.js";
import type { AutoPosterMissionEvidenceService } from "../missions/autoPosterMissionEvidenceService.js";
import type { AutoPosterResultProjectionService } from "../missions/autoPosterResultProjectionService.js";
import type { AutoPosterObservationService } from "../missions/autoPosterObservationService.js";
import type { SafeCommitCloseoutService } from "../safeCommit/safeCommitCloseoutService.js";
import { resolveRegisteredMissionAction } from "../missions/missionActionRegistry.js";
import {
  capabilityTokenIsDistinct,
  createCapabilityTokenMiddleware,
} from "../middleware/capabilityToken.js";
import { config } from "../config.js";
import { validateMissionEnvelope } from "chanter-agent-runtime";

function normalizeActionType(value: unknown): ActionType {
  return typeof value === "string" && actionTypes.includes(value as ActionType)
    ? (value as ActionType)
    : "unknown";
}

export function createApiRouter(
  service: OperatorService,
  runtimeMissionService?: AutoPosterMissionService,
  agentRunLedgerService?: AgentRunLedgerService,
  genericMissionService?: GenericMissionService,
  missionGraphService?: MissionGraphService,
  autoPosterResultService?: AutoPosterResultProjectionService,
  autoPosterObservationService?: AutoPosterObservationService,
  safeCommitCloseoutService?: SafeCommitCloseoutService,
  // Appended, not inserted: see the matching comment in app.ts.
  autoPosterGraphIntakeService?: AutoPosterGraphIntakeService,
  autoPosterMissionEvidenceService?: AutoPosterMissionEvidenceService,
): Router {
  const router = Router();

  // Capability-token middleware for write endpoints (fail-closed).
  const missionSubmitTokenMiddleware = createCapabilityTokenMiddleware({
    tokenEnvVar: "OPERATOR_MISSION_SUBMIT_TOKEN",
    tokenValue: config.missionSubmit.token,
    endpointLabel: "Mission submission",
    forbiddenTokenValues: [
      config.missionControl.token,
      config.safeCommitExecutor.token,
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
      config.safeCommitExecutor.token,
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
      config.safeCommitExecutor.token,
      config.autoPosterRuntime.serviceToken,
    ],
  });
  const safeCommitExecutorTokenMiddleware = createCapabilityTokenMiddleware({
    tokenEnvVar: "OPERATOR_SAFECOMMIT_EXECUTOR_TOKEN",
    tokenValue: config.safeCommitExecutor.token,
    endpointLabel: "SafeCommit closeout executor",
    forbiddenTokenValues: [
      config.missionSubmit.token,
      config.missionControl.token,
      config.autoPosterRuntime.serviceToken,
      config.ledgerIngest.token,
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

  const requireMissionGraphService = (): MissionGraphService => {
    if (!missionGraphService) {
      throw new OperatorError("Mission graphs are unavailable.", 503);
    }
    return missionGraphService;
  };

  const requireAutoPosterGraphIntakeService = (): AutoPosterGraphIntakeService => {
    if (!autoPosterGraphIntakeService) {
      throw new OperatorError("AutoPoster graph mission intake is unavailable.", 503);
    }
    return autoPosterGraphIntakeService;
  };

  const requireAutoPosterMissionEvidenceService = (): AutoPosterMissionEvidenceService => {
    if (!autoPosterMissionEvidenceService) {
      throw new OperatorError("AutoPoster mission evidence is unavailable.", 503);
    }
    return autoPosterMissionEvidenceService;
  };

  const requireAutoPosterResultService = (): AutoPosterResultProjectionService => {
    if (!autoPosterResultService) {
      throw new OperatorError("AutoPoster result projections are unavailable.", 503);
    }
    return autoPosterResultService;
  };

  const requireAutoPosterObservationService = (): AutoPosterObservationService => {
    if (!autoPosterObservationService) {
      throw new OperatorError("AutoPoster observation loop is unavailable.", 503);
    }
    return autoPosterObservationService;
  };

  const requireSafeCommitCloseoutService = (): SafeCommitCloseoutService => {
    if (!safeCommitCloseoutService) {
      throw new OperatorError(
        "SafeCommit closeout approval authority is unavailable.",
        503,
        "OPERATOR_SAFECOMMIT_UNAVAILABLE",
      );
    }
    return safeCommitCloseoutService;
  };

  // Phase 2C: true only when the mission id belongs to the generic durable
  // spine; every other id (including unknown ids) keeps the exact legacy path.
  const isGenericMission = (missionId: string): boolean =>
    Boolean(genericMissionService?.hasMission(missionId));

  const missionSubmitReady = capabilityTokenIsDistinct(
    config.missionSubmit.token,
    [
      config.missionControl.token,
      config.safeCommitExecutor.token,
      config.autoPosterRuntime.serviceToken,
      config.ledgerIngest.token,
    ],
  );
  const missionControlReady = capabilityTokenIsDistinct(
    config.missionControl.token,
    [
      config.missionSubmit.token,
      config.safeCommitExecutor.token,
      config.autoPosterRuntime.serviceToken,
      config.ledgerIngest.token,
    ],
  );
  const ledgerIngestReady = capabilityTokenIsDistinct(
    config.ledgerIngest.token,
    [
      config.missionSubmit.token,
      config.missionControl.token,
      config.safeCommitExecutor.token,
      config.autoPosterRuntime.serviceToken,
    ],
  );
  const safeCommitExecutorReady = capabilityTokenIsDistinct(
    config.safeCommitExecutor.token,
    [
      config.missionSubmit.token,
      config.missionControl.token,
      config.autoPosterRuntime.serviceToken,
      config.ledgerIngest.token,
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
          "/api/mission-graphs/autoposter-schedule",
          "/api/safecommit-closeouts",
          "/api/safecommit-closeouts/:requestId",
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
          "/api/safecommit-closeouts/:requestId/approve",
          "/api/safecommit-closeouts/:requestId/revoke",
        ],
      },
      safeCommitExecutor: {
        configured: Boolean(config.safeCommitExecutor.token),
        isolated: safeCommitExecutorReady,
        ready: safeCommitExecutorReady,
        endpoints: [
          "/api/safecommit-closeouts/:requestId/claim",
          "/api/safecommit-closeouts/:requestId/invalidate",
          "/api/safecommit-closeouts/:requestId/complete",
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

  router.post("/safecommit-closeouts", missionSubmitTokenMiddleware, (request, response, next) => {
    try {
      const closeout = requireSafeCommitCloseoutService().submit(request.body);
      response.status(closeout.replayed ? 200 : 201).json(closeout);
    } catch (error) {
      next(error);
    }
  });

  router.get(
    "/safecommit-closeouts/:requestId",
    missionSubmitTokenMiddleware,
    (request, response, next) => {
      try {
        response.json(
          requireSafeCommitCloseoutService().get(String(request.params.requestId)),
        );
      } catch (error) {
        next(error);
      }
    },
  );

  router.post(
    "/safecommit-closeouts/:requestId/approve",
    missionControlTokenMiddleware,
    (request, response, next) => {
      try {
        response.json(
          requireSafeCommitCloseoutService().approve(
            String(request.params.requestId),
            request.body ?? {},
          ),
        );
      } catch (error) {
        next(error);
      }
    },
  );

  router.post(
    "/safecommit-closeouts/:requestId/revoke",
    missionControlTokenMiddleware,
    (request, response, next) => {
      try {
        response.json(
          requireSafeCommitCloseoutService().revoke(
            String(request.params.requestId),
            request.body ?? {},
          ),
        );
      } catch (error) {
        next(error);
      }
    },
  );

  router.post(
    "/safecommit-closeouts/:requestId/claim",
    safeCommitExecutorTokenMiddleware,
    (request, response, next) => {
      try {
        response.json(
          requireSafeCommitCloseoutService().claim(
            String(request.params.requestId),
            request.body ?? {},
          ),
        );
      } catch (error) {
        next(error);
      }
    },
  );

  router.post(
    "/safecommit-closeouts/:requestId/invalidate",
    safeCommitExecutorTokenMiddleware,
    (request, response, next) => {
      try {
        response.json(
          requireSafeCommitCloseoutService().invalidate(
            String(request.params.requestId),
            request.body ?? {},
          ),
        );
      } catch (error) {
        next(error);
      }
    },
  );

  router.post(
    "/safecommit-closeouts/:requestId/complete",
    safeCommitExecutorTokenMiddleware,
    (request, response, next) => {
      try {
        response.json(
          requireSafeCommitCloseoutService().complete(
            String(request.params.requestId),
            request.body ?? {},
          ),
        );
      } catch (error) {
        next(error);
      }
    },
  );

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
      requireRuntimeMissionService()
        .createScheduleMissionFromEnvelope(request.body)
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

  // Phase 2D durable mission graph authority. Submission and control stay on
  // the same independent capability tokens as the mission spine: the submit
  // capability can never approve, and approval binds the exact graph hash.
  router.post("/mission-graphs", missionSubmitTokenMiddleware, (request, response, next) => {
    try {
      const graph = requireMissionGraphService().submitGraph(request.body);
      response.status(graph.replayed ? 200 : 201).json(graph);
    } catch (error) {
      next(error);
    }
  });

  // Phase 2F-A unified AutoPoster mission ingress. MCP submits the same flat
  // schedule intent it always has; Operator alone compiles it into the
  // canonical one-node graph and durably persists it — MCP never constructs
  // a graph itself and gains no approval, replay, or result-ingestion
  // authority. Same submit-only capability token as every other submission
  // route; approval still requires the independent control token.
  router.post(
    "/mission-graphs/autoposter-schedule",
    missionSubmitTokenMiddleware,
    (request, response, next) => {
      requireAutoPosterGraphIntakeService()
        .submitScheduleIntent(request.body)
        .then((result) => response.status(result.graph.replayed ? 200 : 201).json(result))
        .catch(next);
    },
  );

  router.get("/mission-graphs", (request, response, next) => {
    try {
      const parsedLimit = Number(request.query.limit ?? 50);
      response.json({ graphs: requireMissionGraphService().listGraphs(parsedLimit) });
    } catch (error) {
      next(error);
    }
  });

  router.get("/mission-graphs/:graphId", (request, response, next) => {
    try {
      response.json(requireMissionGraphService().getGraph(String(request.params.graphId)));
    } catch (error) {
      next(error);
    }
  });

  router.post("/mission-graphs/:graphId/approve", missionControlTokenMiddleware, (request, response, next) => {
    try {
      requireMissionGraphService()
        .approveGraph(String(request.params.graphId), request.body ?? {})
        .then((graph) => response.json(graph))
        .catch(next);
    } catch (error) {
      next(error);
    }
  });

  router.post("/mission-graphs/:graphId/resume", missionControlTokenMiddleware, (request, response, next) => {
    try {
      requireMissionGraphService()
        .resumeGraph(String(request.params.graphId))
        .then((graph) => response.json(graph))
        .catch(next);
    } catch (error) {
      next(error);
    }
  });

  router.post("/mission-graphs/:graphId/cancel", missionControlTokenMiddleware, (request, response, next) => {
    try {
      response.json(
        requireMissionGraphService().cancelGraph(String(request.params.graphId), request.body ?? {}),
      );
    } catch (error) {
      next(error);
    }
  });

  // Phase 2E-B manual AutoPoster result collection. Refresh is an explicit
  // founder/operator control action (same capability token as graph
  // approval; submit/runtime/ledger tokens can never substitute) that reads
  // at most eight exact persisted queue jobs and never writes to AutoPoster,
  // calls a provider, re-executes a child, or mutates graph execution state.
  router.post(
    "/mission-graphs/:graphId/autoposter-results/refresh",
    missionControlTokenMiddleware,
    (request, response, next) => {
      try {
        requireAutoPosterResultService()
          .refreshGraphResults(String(request.params.graphId))
          .then((result) => response.json(result))
          .catch(next);
      } catch (error) {
        next(error);
      }
    },
  );

  // Stored projection read model: never initiates refresh or network work.
  router.get("/mission-graphs/:graphId/autoposter-results", (request, response, next) => {
    try {
      response.json(
        requireAutoPosterResultService().getProjections(String(request.params.graphId)),
      );
    } catch (error) {
      next(error);
    }
  });

  // Persistent AutoPoster product mission — retained evidence bundle. Same
  // control-token sensitivity tier as graph approval/refresh; generates (or
  // regenerates, atomically, in place) the durable JSON manifest for one
  // mission graph from already-persisted state plus one fresh live safety
  // re-check. Never mutates graph, mission, projection, or observation truth.
  router.post(
    "/mission-graphs/:graphId/evidence",
    missionControlTokenMiddleware,
    (request, response, next) => {
      requireAutoPosterMissionEvidenceService()
        .generateEvidenceBundle(String(request.params.graphId), request.body ?? {})
        .then((result) => response.status(201).json(result))
        .catch(next);
    },
  );

  // Phase 2E-C autonomous observation loop. The entire surface — including
  // reads — is an internal Operator control capability: the same control
  // token as graph approval, and never the submit, runtime, or ledger
  // tokens. Running a batch performs at most `batchSize` bounded strict
  // status reads through the Agent Runtime contract; escalation
  // acknowledge/resolve mutate only the durable Operator escalation record.
  router.post(
    "/autoposter-observations/run",
    missionControlTokenMiddleware,
    (request, response, next) => {
      try {
        requireAutoPosterObservationService()
          .runObservationBatch(request.body ?? {})
          .then((result) => response.json(result))
          .catch(next);
      } catch (error) {
        next(error);
      }
    },
  );

  router.get(
    "/autoposter-observations/jobs",
    missionControlTokenMiddleware,
    (request, response, next) => {
      try {
        response.json(requireAutoPosterObservationService().listJobs({
          status: request.query.status,
          graphId: request.query.graphId,
          due: request.query.due,
          limit: request.query.limit,
          offset: request.query.offset,
        }));
      } catch (error) {
        next(error);
      }
    },
  );

  router.get(
    "/autoposter-observations/jobs/:observationJobId",
    missionControlTokenMiddleware,
    (request, response, next) => {
      try {
        response.json(
          requireAutoPosterObservationService()
            .getJobDetail(String(request.params.observationJobId)),
        );
      } catch (error) {
        next(error);
      }
    },
  );

  router.get(
    "/autoposter-observations/escalations",
    missionControlTokenMiddleware,
    (request, response, next) => {
      try {
        response.json(requireAutoPosterObservationService().listEscalations({
          status: request.query.status,
          graphId: request.query.graphId,
          limit: request.query.limit,
          offset: request.query.offset,
        }));
      } catch (error) {
        next(error);
      }
    },
  );

  router.get(
    "/autoposter-observations/escalations/:escalationId",
    missionControlTokenMiddleware,
    (request, response, next) => {
      try {
        response.json(
          requireAutoPosterObservationService()
            .getEscalation(String(request.params.escalationId)),
        );
      } catch (error) {
        next(error);
      }
    },
  );

  router.post(
    "/autoposter-observations/escalations/:escalationId/acknowledge",
    missionControlTokenMiddleware,
    (request, response, next) => {
      try {
        response.json(
          requireAutoPosterObservationService()
            .acknowledgeEscalation(String(request.params.escalationId), request.body ?? {}),
        );
      } catch (error) {
        next(error);
      }
    },
  );

  router.post(
    "/autoposter-observations/escalations/:escalationId/resolve",
    missionControlTokenMiddleware,
    (request, response, next) => {
      try {
        response.json(
          requireAutoPosterObservationService()
            .resolveEscalation(String(request.params.escalationId), request.body ?? {}),
        );
      } catch (error) {
        next(error);
      }
    },
  );

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
