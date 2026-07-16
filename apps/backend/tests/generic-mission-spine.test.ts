/**
 * Phase 2C generic mission spine tests.
 *
 * Every execution in this file goes through the REAL chanter-agent-runtime
 * executeMission + Loop Governor mission adapter (requirement: the Agent
 * Runtime adapter boundary is exercised, not mocked); only the process port
 * is replaced by an in-memory fake so unit runs are deterministic. The real
 * python transport is covered by the Phase 2C cross-repository integration
 * test and the agent-runtime/Loop Governor suites.
 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  LoopGovernorManualLoopCreateParams,
  LoopGovernorManualLoopLookupParams,
  LoopGovernorMissionPort,
} from "chanter-agent-runtime";
import { createApp } from "../src/app.js";
import { AgentRunLedgerService } from "../src/agentRunLedger/agentRunLedgerService.js";
import { AuditLogger } from "../src/audit/auditLogger.js";
import { createDatabase } from "../src/db/database.js";
import {
  GenericMissionService,
  type GenericMissionFailureBoundary,
} from "../src/missions/genericMissionService.js";
import { createLoopGovernorMissionExecutor } from "../src/missions/loopGovernorRuntime.js";
import { MockRunner } from "../src/runners/mockRunner.js";
import { AutoPosterMissionService } from "../src/runtimeMissions/autoPosterMissionService.js";
import { createAutoPosterRuntimeMissionExecutor } from "../src/runtimeMissions/autoPosterRuntime.js";
import { OperatorService } from "../src/services/operatorService.js";
import { ensureWorkspace } from "../src/workspace/pathGuard.js";

const MISSION_SUBMIT_TOKEN = "test-mission-submit-token";
const MISSION_CONTROL_TOKEN = "test-operator-control-token";
const LEDGER_INGEST_TOKEN = "test-ledger-ingest-token";
const PROTECTED_TOKENS = [MISSION_SUBMIT_TOKEN, MISSION_CONTROL_TOKEN, LEDGER_INGEST_TOKEN];

function withSubmitAuth(req: ReturnType<typeof request>) {
  return req.set("Authorization", `Bearer ${MISSION_SUBMIT_TOKEN}`);
}

function withControlAuth(req: ReturnType<typeof request>) {
  return req.set("Authorization", `Bearer ${MISSION_CONTROL_TOKEN}`);
}

interface FakeLoopPort {
  port: LoopGovernorMissionPort;
  createCalls: LoopGovernorManualLoopCreateParams[];
  lookupCalls: LoopGovernorManualLoopLookupParams[];
}

function makeLoopPort(overrides: Partial<LoopGovernorMissionPort> = {}): FakeLoopPort {
  const createCalls: LoopGovernorManualLoopCreateParams[] = [];
  const lookupCalls: LoopGovernorManualLoopLookupParams[] = [];
  const bindings = new Map<string, { payloadHash: string; taskId: string; loopId: string }>();
  const port: LoopGovernorMissionPort = {
    async createManualLoop(params) {
      createCalls.push(params);
      const existing = bindings.get(params.missionId);
      if (existing) {
        if (existing.payloadHash !== params.payloadHash) {
          return {
            ok: false,
            code: "conflict",
            message: "bound to a different payload hash",
            downstreamCode: "MISSION_INTAKE_PAYLOAD_CONFLICT",
          };
        }
        return {
          ok: true,
          created: false,
          taskId: existing.taskId,
          loopId: existing.loopId,
          realAgentExecution: false,
        };
      }
      const binding = {
        payloadHash: params.payloadHash,
        taskId: `task-${bindings.size + 1}`,
        loopId: `loop-${bindings.size + 1}`,
      };
      bindings.set(params.missionId, binding);
      return {
        ok: true,
        created: true,
        taskId: binding.taskId,
        loopId: binding.loopId,
        realAgentExecution: false,
      };
    },
    async lookupManualLoop(params) {
      lookupCalls.push(params);
      const existing = bindings.get(params.missionId);
      if (!existing) return { ok: true, outcome: "not_found", binding: null };
      if (existing.payloadHash !== params.payloadHash) {
        return { ok: true, outcome: "payload_mismatch", binding: null };
      }
      return {
        ok: true,
        outcome: "unique",
        binding: { taskId: existing.taskId, loopId: existing.loopId, boundAt: "2026-07-16T00:00:00.000Z" },
      };
    },
    ...overrides,
  };
  return { port, createCalls, lookupCalls };
}

interface Harness {
  database: DatabaseSync;
  ledger: AgentRunLedgerService;
  genericService: GenericMissionService;
  app: ReturnType<typeof createApp>;
  rawApp: ReturnType<typeof createApp>;
}

function createHarness(
  temporaryRoot: string,
  loopPort: LoopGovernorMissionPort,
  options: {
    failureInjector?: (boundary: GenericMissionFailureBoundary, missionId: string) => void;
    databasePath?: string;
  } = {},
): Harness {
  const database = createDatabase(
    options.databasePath ?? path.join(temporaryRoot, "data", "operator.sqlite"),
  );
  const operatorService = new OperatorService(
    database,
    new AuditLogger(path.join(temporaryRoot, "data", "audit.jsonl")),
    new MockRunner(),
    ensureWorkspace(path.join(temporaryRoot, "workspace")),
  );
  const agentRunLedgerService = new AgentRunLedgerService(database, PROTECTED_TOKENS);
  const autoPosterService = new AutoPosterMissionService(
    database,
    createAutoPosterRuntimeMissionExecutor({
      baseUrl: "",
      serviceToken: "",
      userId: "",
      timeoutValid: true,
    }),
    { agentRunLedgerService, protectedValues: PROTECTED_TOKENS },
  );
  const loopExecutor = createLoopGovernorMissionExecutor(
    {
      pythonExecutable: "",
      governorRoot: "",
      dataDir: "",
      timeoutValid: true,
    },
    { port: loopPort },
  );
  const genericService = new GenericMissionService(database, loopExecutor, {
    agentRunLedgerService,
    protectedValues: PROTECTED_TOKENS,
    failureInjector: options.failureInjector,
  });
  const rawApp = createApp(operatorService, autoPosterService, agentRunLedgerService, genericService);
  const testApp = express();
  testApp.use(rawApp);
  return { database, ledger: agentRunLedgerService, genericService, app: testApp, rawApp };
}

function loopEnvelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: "chanter.mission.v1",
    missionId: "phase2c-mission-0001",
    traceId: "phase2c-trace-0001",
    idempotencyKey: "phase2c-key-0001",
    source: { system: "mission_compiler", requestedBy: "founder-cli" },
    objective: "Create one governed manual loop for the Operator review workflow.",
    target: { product: "loop_governor", action: "loop_governor.manual_loop.create" },
    tenant: { userId: "founder" },
    input: {
      appName: "chanter-operator",
      taskType: "review",
      goal: "Review the Phase 2C generic mission spine.",
      scope: "operator backend missions only",
    },
    constraints: ["No real agent execution"],
    acceptanceCriteria: ["One manual relay loop exists"],
    requestedAt: "2026-07-16T10:00:00.000Z",
    ...overrides,
  };
}

describe("Phase 2C generic mission spine", () => {
  let temporaryRoot: string;
  let database: DatabaseSync | undefined;

  beforeEach(() => {
    temporaryRoot = mkdtempSync(path.join(os.tmpdir(), "chanter-phase2c-spine-"));
  });

  afterEach(() => {
    database?.close();
    database = undefined;
    rmSync(temporaryRoot, { recursive: true, force: true });
  });

  it("rejects unregistered targets deterministically and persists nothing", async () => {
    const { port } = makeLoopPort();
    const harness = createHarness(temporaryRoot, port);
    database = harness.database;
    const response = await withSubmitAuth(request(harness.app).post("/api/runtime-missions"))
      .send(loopEnvelope({ target: { product: "clean_engine", action: "clean_engine.image.clean" } }));
    expect(response.status).toBe(409);
    expect(response.body.code).toBe("OPERATOR_MISSION_TARGET_MISMATCH");
    expect(harness.database.prepare("SELECT COUNT(*) AS count FROM operator_missions").get())
      .toEqual({ count: 0 });
  });

  it("accepts the registered manual-loop action, persists it durably, and requires approval", async () => {
    const { port, createCalls } = makeLoopPort();
    const harness = createHarness(temporaryRoot, port);
    database = harness.database;

    const created = await withSubmitAuth(request(harness.app).post("/api/runtime-missions"))
      .send(loopEnvelope());
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      replayed: false,
      missionId: "phase2c-mission-0001",
      traceId: "phase2c-trace-0001",
      product: "loop_governor",
      action: "loop_governor.manual_loop.create",
      status: "approval_required",
      approvalRequired: true,
      approvedBy: null,
    });
    expect(createCalls).toHaveLength(0);

    const journal = harness.database
      .prepare("SELECT new_state FROM operator_mission_journal WHERE mission_id = ? ORDER BY sequence")
      .all("phase2c-mission-0001") as Array<{ new_state: string }>;
    expect(journal.map((row) => row.new_state)).toEqual(["approval_required"]);

    const ledgerRun = harness.ledger.getRun("phase2c-mission-0001");
    expect(ledgerRun.entry.status).toBe("approval_required");
    expect(ledgerRun.entry.product_id).toBe("loop_governor");
    expect(ledgerRun.entry.production_impact).toBe(false);
  });

  it("replays an exact duplicate submission and rejects conflicting duplicates with typed 409s", async () => {
    const { port } = makeLoopPort();
    const harness = createHarness(temporaryRoot, port);
    database = harness.database;

    const first = await withSubmitAuth(request(harness.app).post("/api/runtime-missions"))
      .send(loopEnvelope());
    expect(first.status).toBe(201);

    const replay = await withSubmitAuth(request(harness.app).post("/api/runtime-missions"))
      .send(loopEnvelope());
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ replayed: true, missionId: "phase2c-mission-0001" });
    expect(harness.database.prepare("SELECT COUNT(*) AS count FROM operator_missions").get())
      .toEqual({ count: 1 });

    const changedPayload = await withSubmitAuth(request(harness.app).post("/api/runtime-missions"))
      .send(loopEnvelope({
        input: {
          appName: "chanter-operator",
          taskType: "review",
          goal: "A different goal that must not silently replace the original.",
        },
      }));
    expect(changedPayload.status).toBe(409);
    expect(changedPayload.body.code).toBe("OPERATOR_MISSION_PAYLOAD_MISMATCH");

    const changedTrace = await withSubmitAuth(request(harness.app).post("/api/runtime-missions"))
      .send(loopEnvelope({ traceId: "phase2c-trace-other" }));
    expect(changedTrace.status).toBe(409);
    expect(changedTrace.body.code).toBe("OPERATOR_TRACE_MISMATCH");

    const stolenKey = await withSubmitAuth(request(harness.app).post("/api/runtime-missions"))
      .send(loopEnvelope({ missionId: "phase2c-mission-0002", traceId: "phase2c-trace-0002" }));
    expect(stolenKey.status).toBe(409);
    expect(stolenKey.body.code).toBe("OPERATOR_IDEMPOTENCY_MISMATCH");
  });

  it("rejects unregistered input fields at submission before anything persists", async () => {
    const { port } = makeLoopPort();
    const harness = createHarness(temporaryRoot, port);
    database = harness.database;
    const response = await withSubmitAuth(request(harness.app).post("/api/runtime-missions"))
      .send(loopEnvelope({
        input: {
          appName: "chanter-operator",
          taskType: "review",
          goal: "goal",
          shellCommand: "echo pwned",
        },
      }));
    expect(response.status).toBe(400);
    expect(response.body.code).toBe("LOOP_GOVERNOR_INPUT_UNSUPPORTED_FIELD");
    expect(harness.database.prepare("SELECT COUNT(*) AS count FROM operator_missions").get())
      .toEqual({ count: 0 });
  });

  it("refuses mission input carrying protected configuration data", async () => {
    const { port } = makeLoopPort();
    const harness = createHarness(temporaryRoot, port);
    database = harness.database;
    const response = await withSubmitAuth(request(harness.app).post("/api/runtime-missions"))
      .send(loopEnvelope({
        input: {
          appName: "chanter-operator",
          taskType: "review",
          goal: `goal with ${MISSION_CONTROL_TOKEN} embedded`,
        },
      }));
    expect(response.status).toBe(400);
    expect(harness.database.prepare("SELECT COUNT(*) AS count FROM operator_missions").get())
      .toEqual({ count: 0 });
  });

  it("keeps approval Operator-controlled: submit token cannot approve, control token cannot submit", async () => {
    const { port, createCalls } = makeLoopPort();
    const harness = createHarness(temporaryRoot, port);
    database = harness.database;

    const created = await withSubmitAuth(request(harness.app).post("/api/runtime-missions"))
      .send(loopEnvelope());
    expect(created.status).toBe(201);

    const submitCannotApprove = await request(harness.rawApp)
      .post("/api/runtime-missions/phase2c-mission-0001/approve")
      .set("Authorization", `Bearer ${MISSION_SUBMIT_TOKEN}`)
      .send({ approvedBy: "founder" });
    expect(submitCannotApprove.status).toBe(401);

    const ledgerCannotApprove = await request(harness.rawApp)
      .post("/api/runtime-missions/phase2c-mission-0001/approve")
      .set("Authorization", `Bearer ${LEDGER_INGEST_TOKEN}`)
      .send({ approvedBy: "founder" });
    expect(ledgerCannotApprove.status).toBe(401);

    const controlCannotSubmit = await request(harness.rawApp)
      .post("/api/runtime-missions")
      .set("Authorization", `Bearer ${MISSION_CONTROL_TOKEN}`)
      .send(loopEnvelope({ missionId: "phase2c-mission-0002" }));
    expect(controlCannotSubmit.status).toBe(401);

    expect(createCalls).toHaveLength(0);
    const mission = harness.genericService.getMission("phase2c-mission-0001");
    expect(mission.status).toBe("approval_required");
    expect(mission.approvedBy).toBeNull();
  });

  it("executes an approved mission through the real runtime adapter with full journal and ledger lineage", async () => {
    const { port, createCalls } = makeLoopPort();
    const harness = createHarness(temporaryRoot, port);
    database = harness.database;

    await withSubmitAuth(request(harness.app).post("/api/runtime-missions")).send(loopEnvelope());
    const approved = await withControlAuth(
      request(harness.app).post("/api/runtime-missions/phase2c-mission-0001/approve"),
    ).send({ approvedBy: "founder" });

    expect(approved.status).toBe(200);
    expect(approved.body).toMatchObject({
      status: "succeeded",
      approvedBy: "founder",
      execution: {
        state: "completed",
        downstreamOperationType: "loop_governor.task.create_manual_loop",
        authoritativeLoopId: "loop-1",
        downstreamIds: { loopId: "loop-1", taskId: "task-1", created: true },
      },
    });
    expect(approved.body.runtimeResult.status).toBe("succeeded");
    expect(approved.body.runtimeResult.output.realAgentExecution).toBe(false);

    // The real adapter received the exact typed payload through executeMission.
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0]).toMatchObject({
      missionId: "phase2c-mission-0001",
      task: {
        appName: "chanter-operator",
        taskType: "review",
        goal: "Review the Phase 2C generic mission spine.",
      },
    });
    expect(createCalls[0]!.payloadHash).toMatch(/^[0-9a-f]{64}$/);
    expect(createCalls[0]!.payloadHash).toBe(approved.body.execution.missionPayloadHash);

    const journal = harness.database
      .prepare("SELECT new_state FROM operator_mission_journal WHERE mission_id = ? ORDER BY sequence")
      .all("phase2c-mission-0001") as Array<{ new_state: string }>;
    expect(journal.map((row) => row.new_state)).toEqual([
      "approval_required",
      "approved",
      "execution_started",
      "downstream_request_prepared",
      "downstream_result_observed",
      "result_persisted",
      "completed",
    ]);

    const ledgerRun = harness.ledger.getRun("phase2c-mission-0001");
    expect(ledgerRun.entry.status).toBe("completed");
    expect(ledgerRun.entry.outcome).toBe("success");
    expect(ledgerRun.entry.trace_id).toBe("phase2c-trace-0001");
    expect(ledgerRun.entry.approval_actor).toBe("founder");
    expect(ledgerRun.transitions.map((entry) => entry.status)).toEqual([
      "created", "approval_required", "approved", "running", "validating", "completed",
    ]);
  });

  it("replays a completed mission on re-approval without a second downstream execution", async () => {
    const { port, createCalls } = makeLoopPort();
    const harness = createHarness(temporaryRoot, port);
    database = harness.database;

    await withSubmitAuth(request(harness.app).post("/api/runtime-missions")).send(loopEnvelope());
    await withControlAuth(
      request(harness.app).post("/api/runtime-missions/phase2c-mission-0001/approve"),
    ).send({ approvedBy: "founder" });
    const replay = await withControlAuth(
      request(harness.app).post("/api/runtime-missions/phase2c-mission-0001/approve"),
    ).send({ approvedBy: "founder" });

    expect(replay.status).toBe(200);
    expect(replay.body.status).toBe("succeeded");
    expect(replay.body.execution.state).toBe("completed");
    expect(createCalls).toHaveLength(1);

    const wrongActor = await withControlAuth(
      request(harness.app).post("/api/runtime-missions/phase2c-mission-0001/approve"),
    ).send({ approvedBy: "someone-else" });
    expect(wrongActor.status).toBe(409);
    expect(wrongActor.body.code).toBe("OPERATOR_APPROVAL_BINDING_MISMATCH");
  });

  it("routes AutoPoster envelopes to the unchanged legacy service", async () => {
    const { port } = makeLoopPort();
    const harness = createHarness(temporaryRoot, port);
    database = harness.database;
    const response = await withSubmitAuth(request(harness.app).post("/api/runtime-missions"))
      .send(loopEnvelope({
        target: { product: "auto_poster", action: "autoposter.post.schedule" },
        tenant: { userId: "owner", accountId: "account-a" },
        input: {
          accountId: "account-a",
          provider: "tiktok",
          mediaUrl: "https://cdn.example.com/video.mp4",
          caption: "clip",
          hashtags: "#chanter",
          scheduledAt: new Date(Date.now() + 3_600_000).toISOString(),
        },
      }));
    // The legacy AutoPoster service rejects the tenant scope against its own
    // (unconfigured) runtime tenant — a typed refusal that only exists on the
    // legacy lane, proving the envelope was routed there and not to the
    // generic spine.
    expect(response.status).toBe(409);
    expect(response.body.code).toBe("OPERATOR_MISSION_SCOPE_MISMATCH");
    expect(harness.database.prepare("SELECT COUNT(*) AS count FROM operator_missions").get())
      .toEqual({ count: 0 });
  });

  it("survives a full restart between submission and approval", async () => {
    const databasePath = path.join(temporaryRoot, "data", "operator.sqlite");
    const firstPort = makeLoopPort();
    const first = createHarness(temporaryRoot, firstPort.port, { databasePath });
    await withSubmitAuth(request(first.app).post("/api/runtime-missions")).send(loopEnvelope());
    const beforeRestart = first.genericService.getMission("phase2c-mission-0001");
    first.database.close();

    const secondPort = makeLoopPort();
    const second = createHarness(temporaryRoot, secondPort.port, { databasePath });
    database = second.database;
    const afterRestart = second.genericService.getMission("phase2c-mission-0001");
    expect(afterRestart).toEqual(beforeRestart);

    const approved = await withControlAuth(
      request(second.app).post("/api/runtime-missions/phase2c-mission-0001/approve"),
    ).send({ approvedBy: "founder" });
    expect(approved.status).toBe(200);
    expect(approved.body.status).toBe("succeeded");
    expect(secondPort.createCalls).toHaveLength(1);
  });

  it("recovers a crash after downstream execution without creating a second loop", async () => {
    const databasePath = path.join(temporaryRoot, "data", "operator.sqlite");
    const shared = makeLoopPort();
    const boundaries: string[] = [];
    const crashing = createHarness(temporaryRoot, shared.port, {
      databasePath,
      failureInjector: (boundary) => {
        boundaries.push(boundary);
        if (boundary === "after_operator_observes_runtime_result_before_persistence") {
          throw new Error("simulated process crash");
        }
      },
    });

    await withSubmitAuth(request(crashing.app).post("/api/runtime-missions")).send(loopEnvelope());
    const crashed = await withControlAuth(
      request(crashing.app).post("/api/runtime-missions/phase2c-mission-0001/approve"),
    ).send({ approvedBy: "founder" });
    expect(crashed.status).toBe(500);
    expect(shared.createCalls).toHaveLength(1);
    crashing.database.close();

    // Restart: the downstream side effect exists; the observed result is durable.
    const recovered = createHarness(temporaryRoot, shared.port, { databasePath });
    database = recovered.database;
    const stuck = recovered.genericService.getMission("phase2c-mission-0001");
    expect(stuck.execution?.state).toBe("downstream_result_observed");
    expect(stuck.execution?.nextPermittedActions).toEqual(["Resume safely"]);

    const resumed = await withControlAuth(
      request(recovered.app).post("/api/runtime-missions/phase2c-mission-0001/resume"),
    ).send({});
    expect(resumed.status).toBe(200);
    expect(resumed.body.status).toBe("succeeded");
    expect(resumed.body.execution.state).toBe("completed");
    expect(resumed.body.execution.downstreamIds).toEqual({
      loopId: "loop-1",
      taskId: "task-1",
      created: true,
    });
    // No second downstream execution happened during recovery.
    expect(shared.createCalls).toHaveLength(1);
    expect(shared.lookupCalls).toHaveLength(0);
  });

  it("handles an unavailable downstream with reconcile -> bounded safe retry -> completion", async () => {
    let failNext = true;
    const inner = makeLoopPort();
    const flaky = makeLoopPort({
      async createManualLoop(params) {
        if (failNext) {
          failNext = false;
          return { ok: false, code: "unavailable", message: "intake offline" };
        }
        return inner.port.createManualLoop(params);
      },
      async lookupManualLoop(params) {
        return inner.port.lookupManualLoop(params);
      },
    });
    const harness = createHarness(temporaryRoot, flaky.port);
    database = harness.database;

    await withSubmitAuth(request(harness.app).post("/api/runtime-missions")).send(loopEnvelope());
    const failed = await withControlAuth(
      request(harness.app).post("/api/runtime-missions/phase2c-mission-0001/approve"),
    ).send({ approvedBy: "founder" });
    expect(failed.status).toBe(200);
    expect(failed.body.status).toBe("unavailable");
    expect(failed.body.execution.state).toBe("failed_recoverable");

    const reconciled = await withControlAuth(
      request(harness.app).post("/api/runtime-missions/phase2c-mission-0001/reconcile"),
    ).send({});
    expect(reconciled.status).toBe(200);
    expect(reconciled.body.execution.reconciliationOutcome).toBe("not_found");
    expect(reconciled.body.execution.recoveryClassification).toBe("SAFE_RETRY_AVAILABLE");
    expect(reconciled.body.execution.nextPermittedActions).toContain("Resume safely");

    const resumed = await withControlAuth(
      request(harness.app).post("/api/runtime-missions/phase2c-mission-0001/resume"),
    ).send({});
    expect(resumed.status).toBe(200);
    expect(resumed.body.status).toBe("succeeded");
    expect(resumed.body.execution.state).toBe("completed");
    expect(resumed.body.execution.retryCount).toBe(1);

    const journal = harness.genericService.getMission("phase2c-mission-0001").executionJournal;
    expect(journal.map((transition) => transition.newState)).toEqual([
      "approval_required",
      "approved",
      "execution_started",
      "downstream_request_prepared",
      "failed_recoverable",
      "recovery_in_progress",
      "failed_recoverable",
      "recovery_in_progress",
      "downstream_request_prepared",
      "downstream_result_observed",
      "result_persisted",
      "completed",
    ]);
  });

  it("exhausts the single retry into a deterministic terminal state", async () => {
    const alwaysDown = makeLoopPort({
      async createManualLoop() {
        return { ok: false, code: "unavailable", message: "intake offline" };
      },
      async lookupManualLoop() {
        return { ok: true, outcome: "not_found", binding: null };
      },
    });
    const harness = createHarness(temporaryRoot, alwaysDown.port);
    database = harness.database;

    await withSubmitAuth(request(harness.app).post("/api/runtime-missions")).send(loopEnvelope());
    await withControlAuth(
      request(harness.app).post("/api/runtime-missions/phase2c-mission-0001/approve"),
    ).send({ approvedBy: "founder" });
    await withControlAuth(
      request(harness.app).post("/api/runtime-missions/phase2c-mission-0001/reconcile"),
    ).send({});
    const retried = await withControlAuth(
      request(harness.app).post("/api/runtime-missions/phase2c-mission-0001/resume"),
    ).send({});
    expect(retried.body.execution.state).toBe("failed_recoverable");
    expect(retried.body.execution.retryCount).toBe(1);

    // Retry budget is spent: resume is refused, stop terminalizes.
    const refused = await withControlAuth(
      request(harness.app).post("/api/runtime-missions/phase2c-mission-0001/resume"),
    ).send({});
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("RECOVERY_ACTION_NOT_PERMITTED");

    const stopped = await withControlAuth(
      request(harness.app).post("/api/runtime-missions/phase2c-mission-0001/stop"),
    ).send({});
    expect(stopped.status).toBe(200);
    expect(stopped.body.status).toBe("failed");
    expect(stopped.body.execution.state).toBe("failed_terminal");
    expect(stopped.body.execution.typedError.code).toBe("RECOVERY_STOPPED_FOR_ESCALATION");

    const afterTerminal = await withControlAuth(
      request(harness.app).post("/api/runtime-missions/phase2c-mission-0001/resume"),
    ).send({});
    expect(afterTerminal.status).toBe(409);
  });

  it("terminalizes a downstream payload conflict via reconcile", async () => {
    const conflicted = makeLoopPort({
      async createManualLoop() {
        return {
          ok: false,
          code: "conflict",
          message: "bound to a different payload",
          downstreamCode: "MISSION_INTAKE_PAYLOAD_CONFLICT",
        };
      },
      async lookupManualLoop() {
        return { ok: true, outcome: "payload_mismatch", binding: null };
      },
    });
    const harness = createHarness(temporaryRoot, conflicted.port);
    database = harness.database;

    await withSubmitAuth(request(harness.app).post("/api/runtime-missions")).send(loopEnvelope());
    const failed = await withControlAuth(
      request(harness.app).post("/api/runtime-missions/phase2c-mission-0001/approve"),
    ).send({ approvedBy: "founder" });
    expect(failed.body.execution.state).toBe("failed_recoverable");

    const reconciled = await withControlAuth(
      request(harness.app).post("/api/runtime-missions/phase2c-mission-0001/reconcile"),
    ).send({});
    expect(reconciled.status).toBe(200);
    expect(reconciled.body.execution.state).toBe("failed_terminal");
    expect(reconciled.body.execution.reconciliationOutcome).toBe("payload_mismatch");
    expect(reconciled.body.execution.typedError.code).toBe("RECOVERY_PAYLOAD_MISMATCH");
  });
});
