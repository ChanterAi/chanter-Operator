/**
 * Phase 2C cross-repository integration proof.
 *
 * Real components end to end — no mocks anywhere in the execution path:
 *
 *   chanter.mission.v1 envelope
 *   -> real Operator Express app (submit capability token)
 *   -> durable operator_missions spine (201 approval_required)
 *   -> independent control-token approval
 *   -> real chanter-agent-runtime executeMission + Loop Governor adapter
 *   -> real no-shell JSON-stdin python process (governor.mission_intake)
 *   -> real Loop Governor task + manual relay loop in an isolated data dir
 *   -> journal + Agent Run Ledger lineage, replay/restart/crash-boundary
 *      safety, and token non-persistence evidence.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

const originalEnvironment = {
  missionSubmitToken: process.env.OPERATOR_MISSION_SUBMIT_TOKEN,
  missionControlToken: process.env.OPERATOR_CONTROL_TOKEN,
  ledgerToken: process.env.OPERATOR_LEDGER_INGEST_TOKEN,
};

const missionSubmitToken = `phase2c-submit-${randomUUID()}`;
const missionControlToken = `phase2c-control-${randomUUID()}`;
const ledgerToken = `phase2c-ledger-${randomUUID()}`;
process.env.OPERATOR_MISSION_SUBMIT_TOKEN = missionSubmitToken;
process.env.OPERATOR_CONTROL_TOKEN = missionControlToken;
process.env.OPERATOR_LEDGER_INGEST_TOKEN = ledgerToken;

const [
  { createApp },
  { AuditLogger },
  { AgentRunLedgerService },
  { createDatabase },
  { GenericMissionService },
  { createLoopGovernorMissionExecutor },
  { MockRunner },
  { AutoPosterMissionService },
  { createAutoPosterRuntimeMissionExecutor },
  { OperatorService },
  { ensureWorkspace },
] = await Promise.all([
  import("../../apps/backend/src/app.js"),
  import("../../apps/backend/src/audit/auditLogger.js"),
  import("../../apps/backend/src/agentRunLedger/agentRunLedgerService.js"),
  import("../../apps/backend/src/db/database.js"),
  import("../../apps/backend/src/missions/genericMissionService.js"),
  import("../../apps/backend/src/missions/loopGovernorRuntime.js"),
  import("../../apps/backend/src/runners/mockRunner.js"),
  import("../../apps/backend/src/runtimeMissions/autoPosterMissionService.js"),
  import("../../apps/backend/src/runtimeMissions/autoPosterRuntime.js"),
  import("../../apps/backend/src/services/operatorService.js"),
  import("../../apps/backend/src/workspace/pathGuard.js"),
]);

const operatorRoot = path.resolve(import.meta.dirname, "../..");
const governorRoot = path.resolve(operatorRoot, "../chanter-loop.governor");
const approvalActor = "founder-phase2c-harness";

function resolvePythonExecutable(): string {
  const command = process.platform === "win32" ? "where" : "which";
  const probe = spawnSync(command, ["python"], { encoding: "utf-8" });
  const candidate = probe.stdout?.split(/\r?\n/).find((line) => line.trim());
  assert.ok(
    probe.status === 0 && candidate && path.isAbsolute(candidate.trim()),
    "an absolute python executable is required for the Phase 2C integration proof",
  );
  return candidate!.trim();
}

const pythonExecutable = resolvePythonExecutable();

interface RunningOperator {
  appBaseUrl: string;
  database: DatabaseSync;
  databasePath: string;
  ledger: InstanceType<typeof AgentRunLedgerService>;
  generic: InstanceType<typeof GenericMissionService>;
  server: Server;
}

function startOperator(
  root: string,
  databasePath: string,
  governorDataDir: string,
  failureInjector?: (boundary: string, missionId: string) => void,
): Promise<RunningOperator> {
  const database = createDatabase(databasePath);
  const operatorService = new OperatorService(
    database,
    new AuditLogger(path.join(root, "operator-audit.jsonl")),
    new MockRunner(),
    ensureWorkspace(path.join(root, "workspace")),
  );
  const protectedValues = [missionSubmitToken, missionControlToken, ledgerToken];
  const ledger = new AgentRunLedgerService(database, protectedValues);
  // Production wiring always constructs the legacy AutoPoster service; the
  // unconfigured executor keeps this harness offline while preserving the
  // exact legacy route behavior (409 target mismatch for unknown actions).
  const autoPoster = new AutoPosterMissionService(
    database,
    createAutoPosterRuntimeMissionExecutor({
      baseUrl: "",
      serviceToken: "",
      userId: "",
      timeoutValid: true,
    }),
    { agentRunLedgerService: ledger, protectedValues },
  );
  const executor = createLoopGovernorMissionExecutor({
    pythonExecutable,
    governorRoot,
    dataDir: governorDataDir,
    timeoutMs: 60_000,
    timeoutValid: true,
  });
  const generic = new GenericMissionService(database, executor, {
    agentRunLedgerService: ledger,
    protectedValues,
    failureInjector: failureInjector as never,
  });
  const app = createApp(operatorService, autoPoster, ledger, generic);
  return new Promise<RunningOperator>((resolve, reject) => {
    const server: Server = app.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      resolve({
        appBaseUrl: `http://127.0.0.1:${address.port}`,
        database,
        databasePath,
        ledger,
        generic,
        server,
      });
    });
    server.once("error", reject);
  });
}

async function stopOperator(running: RunningOperator): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    running.server.close((error) => (error ? reject(error) : resolve()));
  });
  running.database.close();
}

function restoreEnvironment(): void {
  const restore = (name: string, value: string | undefined) => {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };
  restore("OPERATOR_MISSION_SUBMIT_TOKEN", originalEnvironment.missionSubmitToken);
  restore("OPERATOR_CONTROL_TOKEN", originalEnvironment.missionControlToken);
  restore("OPERATOR_LEDGER_INGEST_TOKEN", originalEnvironment.ledgerToken);
}

test.after(() => {
  restoreEnvironment();
});

async function postJson(
  baseUrl: string,
  route: string,
  token: string | null,
  body: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}${route}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function getJson(
  baseUrl: string,
  route: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}${route}`);
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

function loopEnvelope(missionId: string, overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: "chanter.mission.v1",
    missionId,
    traceId: `${missionId}-trace`,
    idempotencyKey: `${missionId}-key`,
    source: { system: "mission_compiler", requestedBy: "founder-cli" },
    objective: "Create one governed manual loop through the full Phase 2C spine.",
    target: { product: "loop_governor", action: "loop_governor.manual_loop.create" },
    tenant: { userId: "founder" },
    input: {
      appName: "chanter-operator",
      taskType: "review",
      goal: `Review the Phase 2C cross-repository proof for ${missionId}.`,
      scope: "phase2c integration harness only",
    },
    constraints: ["No real agent execution"],
    acceptanceCriteria: ["One manual relay loop exists"],
    requestedAt: new Date().toISOString(),
    ...overrides,
  };
}

function governorTaskCount(governorDataDir: string): number {
  const tasksDir = path.join(governorDataDir, "tasks");
  if (!existsSync(tasksDir)) return 0;
  return readdirSync(tasksDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).length;
}

function governorLoopCount(governorDataDir: string): number {
  const loopsFile = path.join(governorDataDir, "loops.json");
  if (!existsSync(loopsFile)) return 0;
  const parsed = JSON.parse(readFileSync(loopsFile, "utf-8")) as unknown;
  if (Array.isArray(parsed)) return parsed.length;
  if (parsed && typeof parsed === "object") return Object.keys(parsed).length;
  return 0;
}

function assertNoSecretBytes(databasePath: string, canaries: string[]): void {
  for (const candidate of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
    if (existsSync(candidate)) {
      const bytes = readFileSync(candidate);
      for (const canary of canaries) {
        assert.equal(
          bytes.includes(Buffer.from(canary, "utf8")),
          false,
          `capability token found in ${candidate}`,
        );
      }
    }
  }
}

function assertNoSecretInTree(root: string, canaries: string[]): void {
  for (const entry of readdirSync(root, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const filePath = path.join(entry.parentPath ?? (entry as { path?: string }).path ?? root, entry.name);
    const bytes = readFileSync(filePath);
    for (const canary of canaries) {
      assert.equal(
        bytes.includes(Buffer.from(canary, "utf8")),
        false,
        `capability token found in ${filePath}`,
      );
    }
  }
}

test("Phase 2C full spine: envelope -> approval -> runtime adapter -> real manual loop, with replay and restart safety", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "phase2c-spine-"));
  const governorDataDir = mkdtempSync(path.join(os.tmpdir(), "phase2c-governor-"));
  const databasePath = path.join(root, "operator.sqlite");
  const missionId = `phase2c-${randomUUID().slice(0, 8)}`;
  let running = await startOperator(root, databasePath, governorDataDir);
  try {
    // Unregistered targets are rejected deterministically, nothing persists.
    const unknown = await postJson(running.appBaseUrl, "/api/runtime-missions", missionSubmitToken,
      loopEnvelope(missionId, { target: { product: "clean_engine", action: "clean_engine.image.clean" } }));
    assert.equal(unknown.status, 409);
    assert.equal(unknown.body.code, "OPERATOR_MISSION_TARGET_MISMATCH");

    // Durable submission requires the submit capability and yields approval_required.
    const missing = await postJson(running.appBaseUrl, "/api/runtime-missions", null, loopEnvelope(missionId));
    assert.equal(missing.status, 401);
    const wrongCapability = await postJson(
      running.appBaseUrl, "/api/runtime-missions", missionControlToken, loopEnvelope(missionId));
    assert.equal(wrongCapability.status, 401);

    const created = await postJson(
      running.appBaseUrl, "/api/runtime-missions", missionSubmitToken, loopEnvelope(missionId));
    assert.equal(created.status, 201);
    assert.equal(created.body.status, "approval_required");
    assert.equal(created.body.replayed, false);
    assert.equal(governorTaskCount(governorDataDir), 0, "submission must not execute");

    // Submission capability cannot approve; ledger capability cannot approve.
    const submitCannotApprove = await postJson(
      running.appBaseUrl, `/api/runtime-missions/${missionId}/approve`, missionSubmitToken,
      { approvedBy: approvalActor });
    assert.equal(submitCannotApprove.status, 401);
    const ledgerCannotApprove = await postJson(
      running.appBaseUrl, `/api/runtime-missions/${missionId}/approve`, ledgerToken,
      { approvedBy: approvalActor });
    assert.equal(ledgerCannotApprove.status, 401);

    // Independent control approval executes through the real python intake.
    const approved = await postJson(
      running.appBaseUrl, `/api/runtime-missions/${missionId}/approve`, missionControlToken,
      { approvedBy: approvalActor });
    assert.equal(approved.status, 200);
    assert.equal(approved.body.status, "succeeded");
    const execution = approved.body.execution as Record<string, unknown>;
    assert.equal(execution.state, "completed");
    const downstream = execution.downstreamIds as Record<string, unknown>;
    assert.ok(String(downstream.loopId).startsWith("loop") || String(downstream.loopId).length > 0);
    assert.equal(downstream.created, true);

    // The loop and task genuinely exist in the isolated Loop Governor state.
    assert.equal(governorTaskCount(governorDataDir), 1);
    assert.equal(governorLoopCount(governorDataDir), 1);
    const taskDirs = readdirSync(path.join(governorDataDir, "tasks"));
    assert.equal(taskDirs[0], downstream.taskId);
    const taskJson = JSON.parse(readFileSync(
      path.join(governorDataDir, "tasks", String(downstream.taskId), "task.json"), "utf-8"));
    assert.ok(String(taskJson.scope).includes(`[chanter-mission:${missionId}]`));
    assert.equal(taskJson.loop_id, downstream.loopId);

    // Journal and ledger lineage are complete and mission-bound.
    const journal = (await getJson(running.appBaseUrl, `/api/runtime-missions/${missionId}`))
      .body.executionJournal as Array<{ newState: string }>;
    assert.deepEqual(journal.map((transition) => transition.newState), [
      "approval_required", "approved", "execution_started", "downstream_request_prepared",
      "downstream_result_observed", "result_persisted", "completed",
    ]);
    const ledgerRun = await getJson(running.appBaseUrl, `/api/agent-run-ledger/runs/${missionId}`);
    assert.equal(ledgerRun.status, 200);
    const runEntry = (ledgerRun.body as { entry: Record<string, unknown> }).entry;
    assert.equal(runEntry.status, "completed");
    assert.equal(runEntry.product_id, "loop_governor");
    assert.equal(runEntry.trace_id, `${missionId}-trace`);
    assert.equal(runEntry.production_impact, false);

    // Exact replay: same envelope, no second loop, no second task.
    const replay = await postJson(
      running.appBaseUrl, "/api/runtime-missions", missionSubmitToken, loopEnvelope(missionId));
    assert.equal(replay.status, 200);
    assert.equal(replay.body.replayed, true);
    const changed = await postJson(
      running.appBaseUrl, "/api/runtime-missions", missionSubmitToken,
      loopEnvelope(missionId, {
        input: {
          appName: "chanter-operator",
          taskType: "review",
          goal: "A different goal that must be refused.",
        },
      }));
    assert.equal(changed.status, 409);
    assert.equal(changed.body.code, "OPERATOR_MISSION_PAYLOAD_MISMATCH");
    assert.equal(governorTaskCount(governorDataDir), 1);

    // Operator restart: durable truth survives; approval replay stays exact.
    const beforeRestart = (await getJson(running.appBaseUrl, `/api/runtime-missions/${missionId}`)).body;
    await stopOperator(running);
    running = await startOperator(root, databasePath, governorDataDir);
    const afterRestart = (await getJson(running.appBaseUrl, `/api/runtime-missions/${missionId}`)).body;
    assert.deepEqual(afterRestart, beforeRestart);
    const replayApproval = await postJson(
      running.appBaseUrl, `/api/runtime-missions/${missionId}/approve`, missionControlToken,
      { approvedBy: approvalActor });
    assert.equal(replayApproval.status, 200);
    assert.equal((replayApproval.body.execution as Record<string, unknown>).state, "completed");
    assert.equal(governorTaskCount(governorDataDir), 1);
    assert.equal(governorLoopCount(governorDataDir), 1);

    // Capability tokens never persist in the database or Loop Governor state.
    assertNoSecretBytes(databasePath, [missionSubmitToken, missionControlToken, ledgerToken]);
    assertNoSecretInTree(governorDataDir, [missionSubmitToken, missionControlToken, ledgerToken]);
  } finally {
    await stopOperator(running);
    rmSync(root, { recursive: true, force: true });
    rmSync(governorDataDir, { recursive: true, force: true });
  }
});

test("Phase 2C crash boundary: a crash after the downstream loop exists never creates a second loop", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "phase2c-crash-"));
  const governorDataDir = mkdtempSync(path.join(os.tmpdir(), "phase2c-crash-governor-"));
  const databasePath = path.join(root, "operator.sqlite");
  const missionId = `phase2c-crash-${randomUUID().slice(0, 8)}`;
  let running = await startOperator(root, databasePath, governorDataDir, (boundary) => {
    if (boundary === "after_operator_observes_runtime_result_before_persistence") {
      throw new Error("simulated Operator crash after the downstream side effect");
    }
  });
  try {
    const created = await postJson(
      running.appBaseUrl, "/api/runtime-missions", missionSubmitToken, loopEnvelope(missionId));
    assert.equal(created.status, 201);
    const crashed = await postJson(
      running.appBaseUrl, `/api/runtime-missions/${missionId}/approve`, missionControlToken,
      { approvedBy: approvalActor });
    assert.equal(crashed.status, 500);
    assert.equal(governorTaskCount(governorDataDir), 1, "the downstream side effect exists");

    // Restart without the failure injector; the observed result is durable.
    await stopOperator(running);
    running = await startOperator(root, databasePath, governorDataDir);
    const stuck = (await getJson(running.appBaseUrl, `/api/runtime-missions/${missionId}`)).body;
    assert.equal((stuck.execution as Record<string, unknown>).state, "downstream_result_observed");

    const resumed = await postJson(
      running.appBaseUrl, `/api/runtime-missions/${missionId}/resume`, missionControlToken, {});
    assert.equal(resumed.status, 200);
    assert.equal(resumed.body.status, "succeeded");
    assert.equal((resumed.body.execution as Record<string, unknown>).state, "completed");
    assert.equal(governorTaskCount(governorDataDir), 1, "recovery must not create a second task");
    assert.equal(governorLoopCount(governorDataDir), 1, "recovery must not create a second loop");

    // A second recovery-era approve is an exact replay of the completed truth.
    const replay = await postJson(
      running.appBaseUrl, `/api/runtime-missions/${missionId}/approve`, missionControlToken,
      { approvedBy: approvalActor });
    assert.equal(replay.status, 200);
    assert.equal(governorTaskCount(governorDataDir), 1);
  } finally {
    await stopOperator(running);
    rmSync(root, { recursive: true, force: true });
    rmSync(governorDataDir, { recursive: true, force: true });
  }
});

test("Phase 2C concurrency: distinct missions execute concurrently with zero cross-talk", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "phase2c-concurrent-"));
  const governorDataDir = mkdtempSync(path.join(os.tmpdir(), "phase2c-concurrent-governor-"));
  const databasePath = path.join(root, "operator.sqlite");
  const missionA = `phase2c-conc-a-${randomUUID().slice(0, 8)}`;
  const missionB = `phase2c-conc-b-${randomUUID().slice(0, 8)}`;
  const running = await startOperator(root, databasePath, governorDataDir);
  try {
    const [createdA, createdB] = await Promise.all([
      postJson(running.appBaseUrl, "/api/runtime-missions", missionSubmitToken, loopEnvelope(missionA)),
      postJson(running.appBaseUrl, "/api/runtime-missions", missionSubmitToken, loopEnvelope(missionB)),
    ]);
    assert.equal(createdA.status, 201);
    assert.equal(createdB.status, 201);

    const [approvedA, approvedB] = await Promise.all([
      postJson(running.appBaseUrl, `/api/runtime-missions/${missionA}/approve`, missionControlToken,
        { approvedBy: approvalActor }),
      postJson(running.appBaseUrl, `/api/runtime-missions/${missionB}/approve`, missionControlToken,
        { approvedBy: approvalActor }),
    ]);
    assert.equal(approvedA.status, 200);
    assert.equal(approvedB.status, 200);
    assert.equal(approvedA.body.status, "succeeded");
    assert.equal(approvedB.body.status, "succeeded");

    const loopA = (approvedA.body.execution as { downstreamIds: { loopId: string; taskId: string } }).downstreamIds;
    const loopB = (approvedB.body.execution as { downstreamIds: { loopId: string; taskId: string } }).downstreamIds;
    assert.notEqual(loopA.loopId, loopB.loopId);
    assert.notEqual(loopA.taskId, loopB.taskId);
    assert.equal(governorTaskCount(governorDataDir), 2);
    assert.equal(governorLoopCount(governorDataDir), 2);

    // Each mission's ledger lineage stays bound to its own trace.
    const runA = (await getJson(running.appBaseUrl, `/api/agent-run-ledger/runs/${missionA}`)).body as {
      entry: Record<string, unknown>;
    };
    const runB = (await getJson(running.appBaseUrl, `/api/agent-run-ledger/runs/${missionB}`)).body as {
      entry: Record<string, unknown>;
    };
    assert.equal(runA.entry.trace_id, `${missionA}-trace`);
    assert.equal(runB.entry.trace_id, `${missionB}-trace`);
  } finally {
    await stopOperator(running);
    rmSync(root, { recursive: true, force: true });
    rmSync(governorDataDir, { recursive: true, force: true });
  }
});
