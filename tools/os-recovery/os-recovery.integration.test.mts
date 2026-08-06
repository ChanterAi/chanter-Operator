/**
 * CHANTER OS — unified recovery and reconciliation proof.
 *
 * `npm run os:unified` proves both lanes' happy paths, replay, and typed
 * conflict. It never drives a *genuinely interrupted* execution, so the OS
 * state mapping for the recovery states — `downstream_request_prepared`,
 * `downstream_result_observed`, `failed_recoverable`, `stopped` — was verified
 * only as a pure function over synthetic inputs.
 *
 * This proof closes exactly that gap. Every scenario below interrupts a real
 * execution at a real durable boundary using the mission spine's existing
 * injectable failure seam, then drives the whole recovery *through the unified
 * plane* (`/api/os/missions/:osMissionId/{reconcile,resume,stop}`) over real
 * HTTP, asserting both the projected OS state and the downstream side-effect
 * count at every step.
 *
 * What it deliberately does not do: re-prove lane recovery. The AutoPoster
 * recovery suite and the generic mission spine suite already own that. The
 * claim here is narrower and additive — that the unified projection tells the
 * truth about interrupted missions, that OS control actions delegate
 * correctly, and that no OS-driven recovery produces a duplicate downstream
 * artifact.
 *
 * It runs fully in process against disposable state: no server process, no
 * Loop Governor subprocess, no network. That is why it sits early in the
 * canonical gate — it is seconds of the cheapest, most diagnostic evidence
 * about recovery, ahead of the multi-minute cross-repository proofs.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";
import express from "express";
import type {
  LoopGovernorManualLoopCreateParams,
  LoopGovernorManualLoopLookupParams,
  LoopGovernorMissionPort,
} from "chanter-agent-runtime";

const SUBMIT_TOKEN = "os-recovery-submit-capability";
const CONTROL_TOKEN = "os-recovery-control-capability";
const LEDGER_TOKEN = "os-recovery-ledger-capability";
const APPROVER = "founder";

const originalEnvironment = {
  submitToken: process.env.OPERATOR_MISSION_SUBMIT_TOKEN,
  controlToken: process.env.OPERATOR_CONTROL_TOKEN,
  ledgerToken: process.env.OPERATOR_LEDGER_INGEST_TOKEN,
};
process.env.OPERATOR_MISSION_SUBMIT_TOKEN = SUBMIT_TOKEN;
process.env.OPERATOR_CONTROL_TOKEN = CONTROL_TOKEN;
process.env.OPERATOR_LEDGER_INGEST_TOKEN = LEDGER_TOKEN;

const [
  { createApp },
  { AuditLogger },
  { AgentRunLedgerService },
  { createDatabase },
  { GenericMissionService },
  { MissionGraphChildDispatcher },
  { MissionGraphService },
  { createLoopGovernorMissionExecutor },
  { PlatformAutoPosterCommandService },
  { MockRunner },
  { AutoPosterMissionService },
  { createAutoPosterRuntimeMissionExecutor },
  { OperatorService },
  { ensureWorkspace },
  { OsMissionControlService },
  { approvalAuthorityFixtureFor, cleanupApprovalAuthorityFixtures },
] = await Promise.all([
  import("../../apps/backend/src/app.js"),
  import("../../apps/backend/src/audit/auditLogger.js"),
  import("../../apps/backend/src/agentRunLedger/agentRunLedgerService.js"),
  import("../../apps/backend/src/db/database.js"),
  import("../../apps/backend/src/missions/genericMissionService.js"),
  import("../../apps/backend/src/missions/missionGraphChildDispatcher.js"),
  import("../../apps/backend/src/missions/missionGraphService.js"),
  import("../../apps/backend/src/missions/loopGovernorRuntime.js"),
  import("../../apps/backend/src/platform/platformAutoPosterCommandService.js"),
  import("../../apps/backend/src/runners/mockRunner.js"),
  import("../../apps/backend/src/runtimeMissions/autoPosterMissionService.js"),
  import("../../apps/backend/src/runtimeMissions/autoPosterRuntime.js"),
  import("../../apps/backend/src/services/operatorService.js"),
  import("../../apps/backend/src/workspace/pathGuard.js"),
  import("../../apps/backend/src/os/osMissionControlService.js"),
  import("../../apps/backend/tests/helpers/approvalAuthorityFixture.js"),
]);

type GenericFailureBoundary =
  import("../../apps/backend/src/missions/genericMissionService.js").GenericMissionFailureBoundary;

// ---------------------------------------------------------------------------
// Loop Governor port that counts every downstream create
// ---------------------------------------------------------------------------

interface LoopBinding {
  taskId: string;
  loopId: string;
  payloadHash: string;
}

interface CountingLoopPort {
  port: LoopGovernorMissionPort;
  /** Every call that reached the downstream create, duplicates included. */
  createCalls: LoopGovernorManualLoopCreateParams[];
  lookupCalls: LoopGovernorManualLoopLookupParams[];
  /** Distinct durable loops that actually exist downstream. */
  bindings: Map<string, LoopBinding>;
  /** When false, a create records the call but persists no binding. */
  createSucceeds: boolean;
}

function countingLoopPort(): CountingLoopPort {
  const state: CountingLoopPort = {
    createCalls: [],
    lookupCalls: [],
    bindings: new Map<string, LoopBinding>(),
    createSucceeds: true,
    port: {
      async createManualLoop(params) {
        state.createCalls.push(params);
        if (!state.createSucceeds) {
          return { ok: false, code: "unavailable", message: "Loop Governor is unavailable." };
        }
        const existing = state.bindings.get(params.missionId);
        if (existing) {
          // The downstream create is idempotent: a repeat for the same exact
          // scope returns the original binding and creates nothing new.
          return {
            ok: true,
            created: false,
            taskId: existing.taskId,
            loopId: existing.loopId,
            realAgentExecution: false,
          };
        }
        const binding: LoopBinding = {
          taskId: `task-${state.bindings.size + 1}`,
          loopId: `loop-${state.bindings.size + 1}`,
          payloadHash: params.payloadHash,
        };
        state.bindings.set(params.missionId, binding);
        return {
          ok: true,
          created: true,
          taskId: binding.taskId,
          loopId: binding.loopId,
          realAgentExecution: false,
        };
      },
      async lookupManualLoop(params) {
        state.lookupCalls.push(params);
        const existing = state.bindings.get(params.missionId);
        if (!existing) return { ok: true, outcome: "not_found", binding: null };
        if (existing.payloadHash !== params.payloadHash) {
          return { ok: true, outcome: "payload_mismatch", binding: null };
        }
        return {
          ok: true,
          outcome: "unique",
          binding: {
            taskId: existing.taskId,
            loopId: existing.loopId,
            boundAt: "2026-08-06T00:00:00.000Z",
          },
        };
      },
    },
  };
  return state;
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface Harness {
  baseUrl: string;
  database: DatabaseSync;
  stop(): Promise<void>;
}

async function startHarness(
  root: string,
  loopPort: LoopGovernorMissionPort,
  failureInjector?: (boundary: GenericFailureBoundary, missionId: string) => void,
): Promise<Harness> {
  const databasePath = path.join(root, "operator.sqlite");
  const database = createDatabase(databasePath);
  const approvalAuthority = approvalAuthorityFixtureFor(databasePath);
  const protectedValues = [SUBMIT_TOKEN, CONTROL_TOKEN, LEDGER_TOKEN];

  const operatorService = new OperatorService(
    database,
    new AuditLogger(path.join(root, "audit.jsonl")),
    new MockRunner(),
    ensureWorkspace(path.join(root, "workspace")),
  );
  const ledger = new AgentRunLedgerService(database, protectedValues);
  const autoPosterExecutor = createAutoPosterRuntimeMissionExecutor({
    baseUrl: "",
    serviceToken: "",
    userId: "",
    timeoutValid: true,
    approvalAuthority,
  });
  const autoPosterMissions = new AutoPosterMissionService(database, autoPosterExecutor, {
    agentRunLedgerService: ledger,
    protectedValues,
  });
  const loopExecutor = createLoopGovernorMissionExecutor(
    {
      pythonExecutable: "",
      governorRoot: "",
      dataDir: "",
      timeoutValid: true,
      approvalAuthority,
    },
    { port: loopPort },
  );
  const genericMissions = new GenericMissionService(database, loopExecutor, {
    agentRunLedgerService: ledger,
    protectedValues,
    ...(failureInjector ? { failureInjector } : {}),
  });
  const graphs = new MissionGraphService(
    database,
    new MissionGraphChildDispatcher(genericMissions, autoPosterMissions),
    { protectedValues },
  );
  const platformCommands = new PlatformAutoPosterCommandService(
    database,
    graphs,
    autoPosterMissions,
    autoPosterExecutor,
    // Evidence generation is never reached in these scenarios; the platform
    // lane here only needs its durable command/graph authority.
    { generateEvidenceBundle: async () => ({ path: "" }) } as never,
    { protectedValues },
  );
  const osMissions = new OsMissionControlService({
    genericMissions,
    autoPosterMissions,
    platformCommands,
    missionGraphs: graphs,
    loopGovernorExecutor: loopExecutor,
    autoPosterExecutor,
  });

  const app = createApp(
    operatorService,
    autoPosterMissions,
    ledger,
    genericMissions,
    graphs,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    platformCommands,
    osMissions,
  );
  const server = await new Promise<Server>((resolve, reject) => {
    const listening: Server = app.listen(0, "127.0.0.1", () => resolve(listening));
    listening.once("error", reject);
  });
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    database,
    async stop() {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      database.close();
    },
  };
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

interface HttpResult {
  status: number;
  body: Record<string, unknown>;
}

async function call(
  baseUrl: string,
  method: "GET" | "POST",
  pathname: string,
  token: string | null,
  body?: unknown,
): Promise<HttpResult> {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

function record(value: unknown): Record<string, unknown> {
  assert.ok(
    value !== null && typeof value === "object" && !Array.isArray(value),
    "Expected an object.",
  );
  return value as Record<string, unknown>;
}

/** The projected OS status plus the advisory actions, in one read. */
async function osState(
  baseUrl: string,
  osMissionId: string,
): Promise<{ status: string; actions: string[]; evidenceStatus: string; lastConfirmedBoundary: unknown }> {
  const read = await call(baseUrl, "GET", `/api/os/missions/${osMissionId}`, null);
  assert.equal(read.status, 200);
  const outcome = record(read.body.outcome);
  return {
    status: String(read.body.status),
    actions: outcome.nextPermittedActions as string[],
    evidenceStatus: String(outcome.evidenceStatus),
    lastConfirmedBoundary: outcome.lastConfirmedBoundary,
  };
}

const MISSION_ID = "os-recovery-mission-0001";
const OS_MISSION_ID = `os:generic_governed_task:${MISSION_ID}`;

function envelope(): Record<string, unknown> {
  return {
    schemaVersion: "chanter.mission.v1",
    missionId: MISSION_ID,
    traceId: "os-recovery-trace-0001",
    idempotencyKey: "os-recovery-key-0001",
    source: { system: "mission_compiler", requestedBy: "founder-cli" },
    objective: "Prove unified recovery through the CHANTER OS control plane.",
    target: { product: "loop_governor", action: "loop_governor.manual_loop.create" },
    tenant: { userId: "founder" },
    input: {
      appName: "chanter-operator",
      taskType: "review",
      goal: "Prove unified recovery and reconciliation.",
      scope: "recovery proof only",
    },
    constraints: ["No real agent execution"],
    acceptanceCriteria: ["Exactly one manual relay loop exists"],
    requestedAt: "2026-08-06T10:00:00.000Z",
  };
}

/**
 * Submits and approves, expecting the approval to be interrupted at the given
 * durable boundary. The thrown failure is the *point*: it leaves real durable
 * state mid-flight, which is what every assertion afterwards reads.
 */
async function submitAndInterrupt(baseUrl: string): Promise<void> {
  const created = await call(baseUrl, "POST", "/api/os/missions", SUBMIT_TOKEN, envelope());
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.status, "approval_required");

  const approved = await call(
    baseUrl, "POST", `/api/os/missions/${OS_MISSION_ID}/approve`, CONTROL_TOKEN, { approvedBy: APPROVER });
  assert.equal(approved.status, 500, "The injected boundary failure must surface, not be swallowed.");
}

const temporaryRoots: string[] = [];

function disposableRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "chanter-os-recovery-"));
  temporaryRoots.push(root);
  return root;
}

after(() => {
  const restore = (name: string, value: string | undefined) => {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };
  restore("OPERATOR_MISSION_SUBMIT_TOKEN", originalEnvironment.submitToken);
  restore("OPERATOR_CONTROL_TOKEN", originalEnvironment.controlToken);
  restore("OPERATOR_LEDGER_INGEST_TOKEN", originalEnvironment.ledgerToken);
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
  cleanupApprovalAuthorityFixtures();
});

// ---------------------------------------------------------------------------
// R1 — interrupted after the Runtime result was observed, before it persisted
// ---------------------------------------------------------------------------

test(
  "projects an observed-but-unpersisted result truthfully and resumes it through the OS plane",
  { timeout: 60_000 },
  async (context) => {
    const loop = countingLoopPort();
    const harness = await startHarness(
      disposableRoot(),
      loop.port,
      (boundary) => {
        if (boundary === "after_operator_observes_runtime_result_before_persistence") {
          throw new Error("injected interruption before Operator persisted the result");
        }
      },
    );
    context.after(() => harness.stop().catch(() => undefined));

    await submitAndInterrupt(harness.baseUrl);

    // The downstream loop genuinely exists; Operator just has not recorded it
    // as its own authoritative result yet.
    assert.equal(loop.createCalls.length, 1, "the downstream create ran exactly once");
    assert.equal(loop.bindings.size, 1);

    const interrupted = await osState(harness.baseUrl, OS_MISSION_ID);
    assert.equal(
      interrupted.status,
      "downstream_result_observed",
      "a persisted-but-unjournaled result must never project as completed",
    );
    assert.equal(interrupted.evidenceStatus, "pending", "evidence is not authoritative yet");
    assert.deepEqual(interrupted.actions, ["resume"]);

    const resumed = await call(
      harness.baseUrl, "POST", `/api/os/missions/${OS_MISSION_ID}/resume`, CONTROL_TOKEN, {});
    assert.equal(resumed.status, 200, JSON.stringify(resumed.body));
    assert.equal(resumed.body.status, "completed");

    const outcome = record(resumed.body.outcome);
    assert.equal(outcome.evidenceStatus, "authoritative");
    const downstream = record(outcome.downstreamIdentity);
    assert.equal(downstream.kind, "loop_governor_manual_loop");
    assert.equal(downstream.loopId, "loop-1", "recovery returns the same downstream loop");
    assert.equal(downstream.taskId, "task-1");

    // The whole recovery produced no second downstream artifact, and needed no
    // further downstream create at all: the observed result was replayed from
    // Operator's own durable journal.
    assert.equal(loop.createCalls.length, 1, "resume must not re-dispatch a completed downstream create");
    assert.equal(loop.bindings.size, 1, "exactly one downstream loop exists");
  },
);

// ---------------------------------------------------------------------------
// R2 — interrupted before dispatch; reconcile proves nothing exists, then one
//      bounded safe retry completes it
// ---------------------------------------------------------------------------

test(
  "requires reconciliation before retry and permits exactly one safe retry through the OS plane",
  { timeout: 60_000 },
  async (context) => {
    const loop = countingLoopPort();
    let interrupt = true;
    const harness = await startHarness(
      disposableRoot(),
      loop.port,
      (boundary) => {
        if (interrupt && boundary === "after_downstream_request_preparation_persistence") {
          throw new Error("injected interruption before the downstream request was dispatched");
        }
      },
    );
    context.after(() => harness.stop().catch(() => undefined));

    await submitAndInterrupt(harness.baseUrl);
    interrupt = false;

    // Nothing was dispatched, so no downstream artifact can exist.
    assert.equal(loop.createCalls.length, 0);

    const interrupted = await osState(harness.baseUrl, OS_MISSION_ID);
    assert.equal(interrupted.status, "downstream_request_prepared");
    assert.deepEqual(
      [...interrupted.actions].sort(),
      ["reconcile", "stop"],
      "an ambiguous downstream outcome must require reconciliation before any retry",
    );
    assert.equal(
      interrupted.actions.includes("resume"),
      false,
      "resume must not be offered before the downstream outcome is known",
    );

    const reconciled = await call(
      harness.baseUrl, "POST", `/api/os/missions/${OS_MISSION_ID}/reconcile`, CONTROL_TOKEN, {});
    assert.equal(reconciled.status, 200, JSON.stringify(reconciled.body));
    assert.equal(reconciled.body.status, "failed_recoverable");
    assert.equal(
      loop.lookupCalls.length,
      1,
      "reconciliation reads exact downstream truth exactly once",
    );
    assert.equal(loop.createCalls.length, 0, "reconciliation must never create anything");

    const afterReconcile = record(reconciled.body.outcome);
    assert.equal(afterReconcile.recoveryClassification, "SAFE_RETRY_AVAILABLE");
    assert.ok(
      (afterReconcile.nextPermittedActions as string[]).includes("resume"),
      "a proven-absent binding unlocks exactly one safe retry",
    );

    const resumed = await call(
      harness.baseUrl, "POST", `/api/os/missions/${OS_MISSION_ID}/resume`, CONTROL_TOKEN, {});
    assert.equal(resumed.status, 200, JSON.stringify(resumed.body));
    assert.equal(resumed.body.status, "completed");
    assert.equal(
      loop.createCalls.length,
      1,
      "the safe retry dispatched exactly once — never speculatively before reconciliation",
    );
    assert.equal(loop.bindings.size, 1, "exactly one downstream loop exists");

    const downstream = record(record(resumed.body.outcome).downstreamIdentity);
    assert.equal(downstream.loopId, "loop-1");
  },
);

// ---------------------------------------------------------------------------
// R3 — with the downstream outcome already known, reconciliation is refused and
//      recovery lands back on the same existing binding
// ---------------------------------------------------------------------------

test(
  "refuses redundant reconciliation once the downstream outcome is already known",
  { timeout: 60_000 },
  async (context) => {
    const loop = countingLoopPort();
    const harness = await startHarness(
      disposableRoot(),
      loop.port,
      (boundary) => {
        if (boundary === "after_operator_observes_runtime_result_before_persistence") {
          throw new Error("injected interruption before Operator persisted the result");
        }
      },
    );
    context.after(() => harness.stop().catch(() => undefined));

    await submitAndInterrupt(harness.baseUrl);
    assert.equal(loop.bindings.size, 1, "the downstream loop exists but Operator has not recorded it");

    // An operator who does not trust the mid-flight state might reach for
    // reconcile first. It is refused, and the refusal is correct: Operator has
    // already observed the exact downstream result, so re-reading downstream
    // truth could only weaken evidence it already holds.
    const reconciled = await call(
      harness.baseUrl, "POST", `/api/os/missions/${OS_MISSION_ID}/reconcile`, CONTROL_TOKEN, {});
    assert.equal(reconciled.status, 409, "reconcile is not offered from an observed-result state");
    assert.equal(reconciled.body.code, "RECOVERY_ACTION_NOT_PERMITTED");
    assert.equal(loop.lookupCalls.length, 0, "a refused reconcile performs no downstream read");

    // The permitted path is resume, and it must land on the same loop.
    const resumed = await call(
      harness.baseUrl, "POST", `/api/os/missions/${OS_MISSION_ID}/resume`, CONTROL_TOKEN, {});
    assert.equal(resumed.status, 200, JSON.stringify(resumed.body));
    assert.equal(resumed.body.status, "completed");
    assert.equal(
      record(record(resumed.body.outcome).downstreamIdentity).loopId,
      "loop-1",
    );
    assert.equal(loop.bindings.size, 1, "no second downstream loop was ever created");
  },
);

// ---------------------------------------------------------------------------
// R4 — a human stop projects the canonical `stopped` state, not a failure
// ---------------------------------------------------------------------------

test(
  "projects a human stop as the canonical stopped state against real durable truth",
  { timeout: 60_000 },
  async (context) => {
    const loop = countingLoopPort();
    const harness = await startHarness(
      disposableRoot(),
      loop.port,
      (boundary) => {
        if (boundary === "after_downstream_request_preparation_persistence") {
          throw new Error("injected interruption before the downstream request was dispatched");
        }
      },
    );
    context.after(() => harness.stop().catch(() => undefined));

    await submitAndInterrupt(harness.baseUrl);

    const stopped = await call(
      harness.baseUrl, "POST", `/api/os/missions/${OS_MISSION_ID}/stop`, CONTROL_TOKEN, {});
    assert.equal(stopped.status, 200, JSON.stringify(stopped.body));
    assert.equal(
      stopped.body.status,
      "stopped",
      "a human stop is not a system failure and must not project as failed_terminal",
    );
    assert.equal(stopped.body.laneState, "failed_terminal", "the lane's own state is preserved verbatim");

    const outcome = record(stopped.body.outcome);
    assert.equal(outcome.recoveryClassification, "STOPPED_FOR_ESCALATION");
    assert.equal(outcome.evidenceStatus, "failed");
    assert.deepEqual(outcome.nextPermittedActions, [], "a stopped mission advances no further");
    assert.equal(loop.createCalls.length, 0, "stopping never dispatches anything");

    // The stop is durable: a fresh read projects the same canonical state.
    const reread = await osState(harness.baseUrl, OS_MISSION_ID);
    assert.equal(reread.status, "stopped");
  },
);

// ---------------------------------------------------------------------------
// R5 — a downstream refusal is recoverable, and recovery is still gated
// ---------------------------------------------------------------------------

test(
  "projects a downstream refusal as recoverable and still requires reconciliation first",
  { timeout: 60_000 },
  async (context) => {
    const loop = countingLoopPort();
    loop.createSucceeds = false;
    const harness = await startHarness(disposableRoot(), loop.port);
    context.after(() => harness.stop().catch(() => undefined));

    const created = await call(harness.baseUrl, "POST", "/api/os/missions", SUBMIT_TOKEN, envelope());
    assert.equal(created.status, 201);

    const approved = await call(
      harness.baseUrl, "POST", `/api/os/missions/${OS_MISSION_ID}/approve`, CONTROL_TOKEN, { approvedBy: APPROVER });
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    assert.equal(
      approved.body.status,
      "failed_recoverable",
      "an unproven downstream outcome is recoverable, never terminal",
    );

    const outcome = record(approved.body.outcome);
    assert.equal(outcome.evidenceStatus, "reconciliation_required");
    assert.ok(record(outcome.typedError).code, "a typed error is surfaced");
    assert.deepEqual(
      [...(outcome.nextPermittedActions as string[])].sort(),
      ["reconcile", "stop"],
      "retry stays locked until reconciliation proves the downstream outcome",
    );

    assert.equal(loop.createCalls.length, 1, "exactly one dispatch was attempted");
    assert.equal(loop.bindings.size, 0, "the refusal created nothing downstream");

    // Reconciliation proves nothing exists, which unlocks the single retry.
    const reconciled = await call(
      harness.baseUrl, "POST", `/api/os/missions/${OS_MISSION_ID}/reconcile`, CONTROL_TOKEN, {});
    assert.equal(reconciled.status, 200, JSON.stringify(reconciled.body));
    assert.equal(reconciled.body.status, "failed_recoverable");
    assert.ok(
      (record(reconciled.body.outcome).nextPermittedActions as string[]).includes("resume"),
    );
    assert.equal(loop.bindings.size, 0);

    // Let the downstream succeed, then take the one permitted retry.
    loop.createSucceeds = true;
    const resumed = await call(
      harness.baseUrl, "POST", `/api/os/missions/${OS_MISSION_ID}/resume`, CONTROL_TOKEN, {});
    assert.equal(resumed.status, 200, JSON.stringify(resumed.body));
    assert.equal(resumed.body.status, "completed");
    assert.equal(loop.bindings.size, 1, "exactly one downstream loop exists after the whole recovery");
    assert.equal(loop.createCalls.length, 2, "one refused dispatch plus one permitted retry");
  },
);
