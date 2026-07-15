import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type {
  AutoPosterScheduleReconciliationSuccess,
  RuntimeMissionRequest,
  RuntimeMissionResult,
} from "chanter-agent-runtime";
import { AgentRunLedgerService } from "../src/agentRunLedger/agentRunLedgerService.js";
import { createDatabase } from "../src/db/database.js";
import {
  AutoPosterMissionService,
  type MissionFailureBoundary,
} from "../src/runtimeMissions/autoPosterMissionService.js";
import type { AutoPosterRuntimeMissionExecutor } from "../src/runtimeMissions/autoPosterRuntime.js";
import { MissionExecutionJournal } from "../src/runtimeMissions/missionExecutionJournal.js";

const activeDatabases = new Set<DatabaseSync>();
const roots: string[] = [];

function connectedAccount(accountId: string, provider: "tiktok" | "youtube") {
  return {
    connectedAccountId: `${provider}:${accountId}`,
    accountId,
    provider,
    providerDisplayName: provider === "tiktok" ? "TikTok" : "YouTube",
    username: "legacy-creator",
    displayName: "Legacy Creator",
    connectionStatus: "connected" as const,
    publishingReady: true,
    readinessBlockers: [],
    lastVerifiedAt: "2026-07-15T08:00:00.000Z",
  };
}

class LegacyExecutor implements AutoPosterRuntimeMissionExecutor {
  readonly configured = true;
  readonly tenantUserId = "owner";
  executeCalls = 0;
  reconciliationCalls = 0;
  recoveredCalls = 0;

  async listConnectedAccounts(workspaceId: string) {
    return {
      ok: true as const,
      workspaceId,
      count: 1,
      accounts: [connectedAccount("account-a", "tiktok")],
    };
  }

  async validateConnectedAccount(input: {
    workspaceId?: string;
    accountId: string;
    provider: "tiktok" | "youtube";
  }) {
    return {
      ok: true as const,
      workspaceId: input.workspaceId ?? "workspace-a-00000001",
      account: connectedAccount(input.accountId, input.provider),
    };
  }

  async execute(_request: RuntimeMissionRequest): Promise<RuntimeMissionResult> {
    this.executeCalls += 1;
    throw new Error("Legacy test executor stops before downstream execution.");
  }

  async reconcileSchedule(_request: RuntimeMissionRequest): Promise<never> {
    this.reconciliationCalls += 1;
    throw new Error("Legacy test reconciliation is not configured.");
  }

  async executeRecovered(
    _request: RuntimeMissionRequest,
    _reconciliation: AutoPosterScheduleReconciliationSuccess,
  ): Promise<RuntimeMissionResult> {
    this.recoveredCalls += 1;
    throw new Error("Legacy test recovered executor stops before downstream execution.");
  }
}

interface Harness {
  database: DatabaseSync;
  ledger: AgentRunLedgerService;
  service: AutoPosterMissionService;
}

function openHarness(
  databasePath: string,
  executor: LegacyExecutor,
  failureBoundary?: MissionFailureBoundary,
): Harness {
  const database = createDatabase(databasePath);
  activeDatabases.add(database);
  const ledger = new AgentRunLedgerService(database);
  let injected = false;
  const service = new AutoPosterMissionService(database, executor, {
    agentRunLedgerService: ledger,
    failureInjector: failureBoundary
      ? (boundary) => {
          if (!injected && boundary === failureBoundary) {
            injected = true;
            throw new Error(`INJECTED_PROCESS_TERMINATION:${boundary}`);
          }
        }
      : undefined,
  });
  return { database, ledger, service };
}

function closeHarness(harness: Harness): void {
  harness.database.close();
  activeDatabases.delete(harness.database);
}

function missionInput(): Record<string, unknown> {
  return {
    workspaceId: "workspace-a-00000001",
    accountId: "account-a",
    provider: "tiktok",
    mediaUrl: "https://cdn.example.com/legacy-ledger.mp4",
    caption: "Legacy ledger compatibility",
    hashtags: "#legacy",
    scheduledAt: new Date(Date.now() + 86_400_000).toISOString(),
  };
}

function deleteLedger(database: DatabaseSync, missionId: string): void {
  database.prepare("DELETE FROM agent_run_ledger_transitions WHERE run_id = ?").run(missionId);
  database.prepare("DELETE FROM agent_run_ledger_runs WHERE run_id = ?").run(missionId);
}

async function createApprovedMission(harness: Harness) {
  const created = await harness.service.createScheduleMission(missionInput());
  await expect(harness.service.approveAndExecute(created.missionId, "founder"))
    .rejects.toThrow("INJECTED_PROCESS_TERMINATION:after_approval_persistence");
  return harness.service.getMission(created.missionId);
}

afterEach(() => {
  for (const database of activeDatabases) {
    try { database.close(); } catch { /* already closed */ }
  }
  activeDatabases.clear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("legacy AutoPoster Agent Run Ledger compatibility", () => {
  it("backfills approval-required lineage before durable approval", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "chanter-legacy-ledger-approval-"));
    roots.push(root);
    const executor = new LegacyExecutor();
    const harness = openHarness(
      path.join(root, "operator.sqlite"),
      executor,
      "after_approval_persistence",
    );
    const created = await harness.service.createScheduleMission(missionInput());
    deleteLedger(harness.database, created.missionId);

    await expect(harness.service.approveAndExecute(created.missionId, "founder"))
      .rejects.toThrow("INJECTED_PROCESS_TERMINATION:after_approval_persistence");

    const mission = harness.service.getMission(created.missionId);
    const approval = mission.executionJournal.find((transition) => transition.newState === "approved")!;
    const detail = harness.ledger.getRun(created.missionId);
    expect(detail.transitions.map((entry) => entry.status)).toEqual([
      "created",
      "approval_required",
      "approved",
    ]);
    expect(detail.transitions.map((entry) => entry.attempt_id)).toEqual([
      mission.executionJournal[0]!.executionAttemptId,
      mission.executionJournal[0]!.executionAttemptId,
      mission.executionJournal[0]!.executionAttemptId,
    ]);
    expect(detail.entry.approval_actor).toBe("founder");
    expect(detail.entry.approval_timestamp).toBe(approval.timestamp);
    expect(executor.executeCalls).toBe(0);
  });

  it("rolls back the whole backfill when the enclosing approval mutation fails", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "chanter-legacy-ledger-rollback-"));
    roots.push(root);
    const harness = openHarness(path.join(root, "operator.sqlite"), new LegacyExecutor());
    const created = await harness.service.createScheduleMission(missionInput());
    deleteLedger(harness.database, created.missionId);
    harness.database.exec(`
      CREATE TRIGGER reject_legacy_approval
      BEFORE UPDATE OF status ON autoposter_runtime_missions
      WHEN OLD.status = 'approval_required' AND NEW.status = 'executing'
      BEGIN
        SELECT RAISE(ABORT, 'INJECTED_LEGACY_APPROVAL_ROLLBACK');
      END;
    `);

    await expect(harness.service.approveAndExecute(created.missionId, "founder"))
      .rejects.toThrow("INJECTED_LEGACY_APPROVAL_ROLLBACK");

    expect(() => harness.ledger.getRun(created.missionId)).toThrow();
    expect(harness.service.getMission(created.missionId)).toMatchObject({
      status: "approval_required",
      approvedBy: null,
      execution: { state: "approval_required" },
    });
  });

  it("restarts from a legacy persisted result with exact stored evidence bytes", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "chanter-legacy-ledger-result-"));
    roots.push(root);
    const databasePath = path.join(root, "operator.sqlite");
    const executor = new LegacyExecutor();
    const first = openHarness(databasePath, executor, "after_approval_persistence");
    const approved = await createApprovedMission(first);
    const approval = approved.executionJournal.find((transition) => transition.newState === "approved")!;
    const journal = new MissionExecutionJournal(first.database);
    const runtimeResult = {
      missionId: approved.missionId,
      traceId: approved.traceId,
      product: approved.product,
      action: approved.action,
      status: "succeeded",
      output: { legacy: true },
      evidence: null,
      warnings: [],
      errors: [],
      policyDecision: null,
      approvalDecision: { required: true, approved: true, approvedBy: "founder" },
      idempotency: { key: approved.idempotencyKey, outcome: "new" },
      startedAt: approval.timestamp,
      completedAt: approval.timestamp,
      durationMs: 0,
    };
    const serializedRuntimeResult = JSON.stringify(runtimeResult, null, 2);
    journal.transition(approved.missionId, "execution_started", {
      actor: "chanter-agent-runtime",
      reason: "Legacy execution started.",
      timestamp: approval.timestamp,
    });
    journal.transition(approved.missionId, "downstream_request_prepared", {
      actor: "chanter-agent-runtime",
      reason: "Legacy downstream request prepared.",
      timestamp: approval.timestamp,
    });
    journal.transition(approved.missionId, "downstream_result_observed", {
      actor: "chanter-agent-runtime",
      reason: "Legacy Runtime result observed.",
      timestamp: approval.timestamp,
      downstreamQueueId: "legacy-queue-result",
      runtimeObservation: runtimeResult,
    });
    journal.transition(approved.missionId, "result_persisted", {
      actor: "chanter-operator",
      reason: "Legacy Runtime result persisted.",
      timestamp: approval.timestamp,
      finalResultStatus: "succeeded",
    });
    first.database.prepare(
      `UPDATE autoposter_runtime_missions
         SET status = 'succeeded', runtime_result_json = ?, updated_at = ?
       WHERE mission_id = ?`,
    ).run(serializedRuntimeResult, approval.timestamp, approved.missionId);
    deleteLedger(first.database, approved.missionId);
    closeHarness(first);

    const restarted = openHarness(databasePath, executor);
    const completed = await restarted.service.resumeSafely(approved.missionId);
    const detail = restarted.ledger.getRun(approved.missionId);
    expect(completed.execution?.state).toBe("completed");
    expect(detail.transitions.map((entry) => entry.status)).toEqual([
      "created",
      "approval_required",
      "approved",
      "running",
      "validating",
      "completed",
    ]);
    expect(detail.entry.evidence_refs[0]?.sha256).toBe(
      createHash("sha256").update(serializedRuntimeResult, "utf8").digest("hex"),
    );
    expect(detail.entry.approval_actor).toBe("founder");
    expect(detail.entry.approval_timestamp).toBe(approval.timestamp);
  });

  it("preserves validating lineage across a unique-result recovery restart", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "chanter-legacy-ledger-unique-"));
    roots.push(root);
    const databasePath = path.join(root, "operator.sqlite");
    const executor = new LegacyExecutor();
    const first = openHarness(databasePath, executor, "after_approval_persistence");
    const approved = await createApprovedMission(first);
    const approval = approved.executionJournal.find((transition) => transition.newState === "approved")!;
    const journal = new MissionExecutionJournal(first.database);
    const reconciliation: AutoPosterScheduleReconciliationSuccess = {
      ok: true,
      outcome: "unique",
      count: 1,
      unique: true,
      safeToReuse: true,
      approvalState: "required",
      publishingState: "blocked_until_human_approval",
      evidenceStatus: "authoritative",
      post: {
        id: "legacy-unique-queue",
        accountId: approved.accountId,
        provider: approved.provider,
        status: "scheduled",
        scheduledAt: approved.scheduledAt,
        approved: false,
      },
    };
    journal.transition(approved.missionId, "execution_started", {
      actor: "chanter-agent-runtime",
      reason: "Legacy execution started.",
      timestamp: approval.timestamp,
    });
    journal.transition(approved.missionId, "downstream_request_prepared", {
      actor: "chanter-agent-runtime",
      reason: "Legacy downstream request prepared.",
      timestamp: approval.timestamp,
    });
    journal.transition(approved.missionId, "failed_recoverable", {
      actor: "chanter-operator",
      reason: "Legacy execution required reconciliation.",
      timestamp: approval.timestamp,
      typedError: { code: "LEGACY_INTERRUPTED", message: "Legacy execution interrupted." },
    });
    journal.transition(approved.missionId, "recovery_in_progress", {
      actor: "chanter-operator",
      reason: "Legacy reconciliation started.",
      timestamp: approval.timestamp,
    });
    journal.transition(approved.missionId, "downstream_result_observed", {
      actor: "chanter-operator",
      reason: "One exact legacy queue result was reconciled.",
      timestamp: approval.timestamp,
      downstreamQueueId: reconciliation.post!.id,
      reconciliationOutcome: "unique",
      reconciliationResult: reconciliation,
      runtimeObservation: null,
    });
    journal.transition(approved.missionId, "recovery_in_progress", {
      actor: "chanter-operator",
      reason: "The legacy process claimed attachment of the unique result before restart.",
      timestamp: approval.timestamp,
    });
    deleteLedger(first.database, approved.missionId);
    closeHarness(first);

    const restarted = openHarness(databasePath, executor);
    await expect(restarted.service.reconcileMission(approved.missionId))
      .rejects.toThrow("Legacy test reconciliation is not configured.");
    const statuses = restarted.ledger.getRun(approved.missionId).transitions
      .map((entry) => entry.status);
    expect(statuses).toEqual([
      "created",
      "approval_required",
      "approved",
      "running",
      "reconciliation_required",
      "running",
      "validating",
      "reconciliation_required",
      "running",
    ]);
    const validatingIndex = statuses.indexOf("validating");
    expect(statuses[validatingIndex + 1]).toBe("reconciliation_required");
    expect(executor.reconciliationCalls).toBe(1);
    expect(executor.recoveredCalls).toBe(0);
  });

  it("stops a legacy approved mission without claiming a Runtime tool execution", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "chanter-legacy-ledger-stop-"));
    roots.push(root);
    const databasePath = path.join(root, "operator.sqlite");
    const executor = new LegacyExecutor();
    const first = openHarness(databasePath, executor, "after_approval_persistence");
    const approved = await createApprovedMission(first);
    deleteLedger(first.database, approved.missionId);
    closeHarness(first);

    const restarted = openHarness(databasePath, executor);
    const stopped = restarted.service.stopAndEscalate(approved.missionId);
    const detail = restarted.ledger.getRun(approved.missionId);
    expect(stopped.execution?.state).toBe("failed_terminal");
    expect(detail.transitions.map((entry) => entry.status)).toEqual([
      "created",
      "approval_required",
      "approved",
      "failed",
    ]);
    expect(detail.entry.tools_used).toEqual([]);
    expect(executor.executeCalls).toBe(0);
    expect(executor.recoveredCalls).toBe(0);
  });
});
