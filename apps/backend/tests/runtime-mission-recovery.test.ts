import { mkdtempSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type {
  AutoPosterOperationsPort,
  AutoPosterScheduleParams,
  AutoPosterScheduleReconciliationParams,
  AutoPosterScheduleSuccess,
} from "chanter-agent-runtime";
import { createDatabase } from "../src/db/database.js";
import { AgentRunLedgerService } from "../src/agentRunLedger/agentRunLedgerService.js";
import {
  AutoPosterMissionService,
  type MissionFailureBoundary,
} from "../src/runtimeMissions/autoPosterMissionService.js";
import {
  createAutoPosterRuntimeMissionExecutor,
  type AutoPosterRuntimeMissionExecutor,
} from "../src/runtimeMissions/autoPosterRuntime.js";
import { MissionExecutionJournal } from "../src/runtimeMissions/missionExecutionJournal.js";

interface DurableJob extends AutoPosterScheduleSuccess["post"] {
  workspaceId: string;
  idempotencyKey: string;
  missionId: string;
  action: string;
  missionPayloadHash: string;
}

const activeDatabases = new Set<DatabaseSync>();

function futureIso(minutes = 60): string {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

function missionInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    workspaceId: "workspace-a-00000001",
    accountId: "account-a",
    provider: "tiktok",
    mediaUrl: "https://cdn.example.com/recovery.mp4",
    caption: "Recovery evidence",
    hashtags: "#recovery",
    scheduledAt: futureIso(),
    ...overrides,
  };
}

class DurableAutoPosterPort implements AutoPosterOperationsPort {
  readonly jobs: DurableJob[] = [];
  scheduleCalls = 0;
  reconciliationCalls = 0;
  private failureBoundary: MissionFailureBoundary | undefined;
  private failureInjected = false;

  configureFailure(boundary?: MissionFailureBoundary): void {
    this.failureBoundary = boundary;
    this.failureInjected = false;
  }

  private inject(boundary: MissionFailureBoundary): void {
    if (!this.failureInjected && this.failureBoundary === boundary) {
      this.failureInjected = true;
      throw new Error(`INJECTED_PROCESS_TERMINATION:${boundary}`);
    }
  }

  async listConnectedAccounts(params: { workspaceId: string }) {
    return {
      ok: true as const,
      workspaceId: params.workspaceId,
      count: 1,
      accounts: [this.account("account-a", "tiktok")],
    };
  }

  async validateConnectedAccount(params: {
    workspaceId: string;
    accountId: string;
    provider: string;
  }) {
    if (params.accountId !== "account-a" || params.provider !== "tiktok") {
      return {
        ok: false as const,
        code: "validation_failed" as const,
        message: "Exact account scope mismatch.",
        reasonCode: "recovery_scope_mismatch",
      };
    }
    return {
      ok: true as const,
      workspaceId: params.workspaceId,
      account: this.account(params.accountId, "tiktok"),
    };
  }

  async listQueue() {
    return { ok: true as const, items: [], count: 0, scope: { accountId: "all" } };
  }

  async getPostStatus(params: { postId: string; accountId?: string }) {
    const job = this.jobs.find((candidate) => candidate.id === params.postId);
    if (!job) return { ok: false as const, code: "not_found" as const, message: "Not found." };
    return {
      ok: true as const,
      post: {
        ...job,
        username: "creator",
        mediaType: "video",
        captionSummary: "",
        createdAt: null,
        updatedAt: null,
        approvedAt: null,
        approvedBy: "",
        postedAt: null,
        publishId: "",
        claimAttempts: 0,
        lastErrorMessage: "",
      },
    };
  }

  async validateMedia() {
    return {
      ok: true as const,
      valid: true,
      classification: "video" as const,
      policy: { videoOnly: true, allowedExtensions: [".mp4"] },
    };
  }

  async schedulePost(params: AutoPosterScheduleParams) {
    this.scheduleCalls += 1;
    const matches = this.jobs.filter((job) => job.idempotencyKey === params.idempotencyKey);
    if (matches.length > 1) {
      return {
        ok: false as const,
        code: "validation_failed" as const,
        message: "Conflicting downstream truth.",
        reasonCode: "reconciliation_required",
      };
    }
    if (matches.length === 1) {
      return this.exactJobMatches(matches[0]!, params)
        ? { ok: true as const, duplicate: true, post: this.publicJob(matches[0]!) }
        : {
            ok: false as const,
            code: "validation_failed" as const,
            message: "Exact recovery scope mismatch.",
            reasonCode: "recovery_scope_mismatch",
          };
    }
    const job: DurableJob = {
      id: `queue-${this.jobs.length + 1}`,
      workspaceId: params.workspaceId ?? "",
      accountId: params.accountId,
      provider: params.provider ?? "tiktok",
      status: "scheduled",
      scheduledAt: params.scheduledAt,
      approved: false,
      idempotencyKey: params.idempotencyKey,
      missionId: params.missionId ?? "",
      action: params.action ?? "",
      missionPayloadHash: params.missionPayloadHash ?? "",
    };
    this.inject("before_autoposter_durable_create");
    this.jobs.push(job);
    this.inject("after_autoposter_durable_create_before_response");
    return { ok: true as const, duplicate: false, post: this.publicJob(job) };
  }

  async reconcileSchedule(params: AutoPosterScheduleReconciliationParams) {
    this.reconciliationCalls += 1;
    const matches = this.jobs.filter((job) => job.idempotencyKey === params.idempotencyKey);
    if (matches.length === 0) {
      return {
        ok: true as const,
        outcome: "not_found" as const,
        count: 0,
        unique: true,
        safeToReuse: false,
        approvalState: "not_started" as const,
        publishingState: "not_started" as const,
        evidenceStatus: "not_found" as const,
      };
    }
    if (!matches.every((job) => this.exactJobMatches(job, params))) {
      return {
        ok: false as const,
        code: "validation_failed" as const,
        message: "Exact recovery scope mismatch.",
        reasonCode: "recovery_scope_mismatch",
      };
    }
    if (matches.length > 1) {
      return {
        ok: true as const,
        outcome: "conflict" as const,
        count: matches.length,
        unique: false,
        safeToReuse: false,
        approvalState: "unknown" as const,
        publishingState: "unknown" as const,
        evidenceStatus: "conflict" as const,
        conflictingPostIds: matches.map((job) => job.id).sort(),
      };
    }
    return {
      ok: true as const,
      outcome: "unique" as const,
      count: 1,
      unique: true,
      safeToReuse: true,
      approvalState: "required" as const,
      publishingState: "blocked_until_human_approval" as const,
      evidenceStatus: "authoritative" as const,
      post: this.publicJob(matches[0]!),
    };
  }

  addConflict(): void {
    const original = this.jobs[0];
    if (!original) throw new Error("A source job is required before adding a conflict.");
    this.jobs.push({ ...original, id: "queue-conflict" });
  }

  private account(accountId: string, provider: "tiktok") {
    return {
      connectedAccountId: `${provider}:${accountId}`,
      accountId,
      provider,
      providerDisplayName: "TikTok",
      username: "creator",
      displayName: "Creator",
      connectionStatus: "connected" as const,
      publishingReady: true,
      readinessBlockers: [],
      lastVerifiedAt: "2026-07-14T08:00:00.000Z",
    };
  }

  private publicJob(job: DurableJob): AutoPosterScheduleSuccess["post"] {
    return {
      id: job.id,
      accountId: job.accountId,
      provider: job.provider,
      status: job.status,
      scheduledAt: job.scheduledAt,
      approved: job.approved,
    };
  }

  private exactJobMatches(
    job: DurableJob,
    params: AutoPosterScheduleParams | AutoPosterScheduleReconciliationParams,
  ): boolean {
    return job.workspaceId === (params.workspaceId ?? "")
      && job.accountId === params.accountId
      && job.provider === (params.provider ?? "tiktok")
      && job.scheduledAt === params.scheduledAt
      && job.missionId === (params.missionId ?? "")
      && job.action === (params.action ?? "")
      && job.missionPayloadHash === (params.missionPayloadHash ?? "");
  }
}

function executor(
  port: DurableAutoPosterPort,
  failureBoundary?: MissionFailureBoundary,
): AutoPosterRuntimeMissionExecutor {
  port.configureFailure(failureBoundary);
  return createAutoPosterRuntimeMissionExecutor(
    {
      baseUrl: "https://autoposter.test",
      serviceToken: "test-runtime-token",
      userId: "owner",
      timeoutValid: true,
    },
    {
      port,
      failureInjector: (boundary) => {
        if (boundary === failureBoundary) {
          throw new Error(`INJECTED_PROCESS_TERMINATION:${boundary}`);
        }
      },
    },
  );
}

function openService(
  databasePath: string,
  port: DurableAutoPosterPort,
  failureBoundary?: MissionFailureBoundary,
): { database: DatabaseSync; service: AutoPosterMissionService } {
  const database = createDatabase(databasePath);
  activeDatabases.add(database);
  let injected = false;
  const service = new AutoPosterMissionService(database, executor(port, failureBoundary), {
    agentRunLedgerService: new AgentRunLedgerService(database),
    failureInjector: failureBoundary
      ? (boundary) => {
          if (!injected && boundary === failureBoundary) {
            injected = true;
            throw new Error(`INJECTED_PROCESS_TERMINATION:${boundary}`);
          }
        }
      : undefined,
  });
  return { database, service };
}

async function finishAfterRestart(service: AutoPosterMissionService, missionId: string) {
  let mission = service.getMission(missionId);
  if (mission.execution?.state === "approved") return service.resumeSafely(missionId);
  if (["execution_started", "downstream_request_prepared", "failed_recoverable", "recovery_in_progress"].includes(mission.execution?.state ?? "")) {
    mission = await service.reconcileMission(missionId);
  }
  if (["downstream_result_observed", "failed_recoverable", "result_persisted"].includes(mission.execution?.state ?? "")) {
    mission = await service.resumeSafely(missionId);
  }
  return mission;
}

describe("durable Operator mission recovery", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const database of activeDatabases) {
      try { database.close(); } catch { /* already closed */ }
    }
    activeDatabases.clear();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("rolls back the execution row when its journal append cannot commit", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "chanter-journal-atomic-"));
    roots.push(root);
    const opened = openService(path.join(root, "operator.sqlite"), new DurableAutoPosterPort());
    const created = await opened.service.createScheduleMission(missionInput());
    const initial = opened.database
      .prepare("SELECT transition_id FROM autoposter_mission_journal WHERE mission_id = ?")
      .get(created.missionId) as { transition_id: string };
    const journal = new MissionExecutionJournal(opened.database, () => initial.transition_id);

    expect(() => journal.transition(created.missionId, "approved", {
      actor: "founder",
      reason: "Atomicity probe.",
      timestamp: new Date().toISOString(),
    })).toThrow();
    expect(journal.requireExecution(created.missionId).currentState).toBe("approval_required");
    expect(journal.listTransitions(created.missionId)).toHaveLength(1);
    opened.database.close();
  });

  it("proves normal execution and exact replay after a complete database/service/runtime restart", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "chanter-replay-"));
    roots.push(root);
    const databasePath = path.join(root, "operator.sqlite");
    const port = new DurableAutoPosterPort();
    const first = openService(databasePath, port);
    const created = await first.service.createScheduleMission(missionInput());
    const completed = await first.service.approveAndExecute(created.missionId, "founder");
    expect(completed.execution).toMatchObject({
      state: "completed",
      authoritativeQueueId: "queue-1",
      evidenceStatus: "authoritative",
    });
    expect(completed.executionJournal.map((transition) => transition.newState)).toEqual([
      "approval_required",
      "approved",
      "execution_started",
      "downstream_request_prepared",
      "downstream_result_observed",
      "result_persisted",
      "completed",
    ]);
    for (const [index, transition] of completed.executionJournal.entries()) {
      expect(transition.sequence).toBe(index + 1);
      expect(transition).toMatchObject({
        missionId: created.missionId,
        idempotencyKey: created.idempotencyKey,
        action: "autoposter.post.schedule",
        workspaceId: "workspace-a-00000001",
        provider: "tiktok",
        accountId: "account-a",
      });
      if (index > 0) {
        expect(Date.parse(transition.timestamp)).toBeGreaterThanOrEqual(
          Date.parse(completed.executionJournal[index - 1]!.timestamp),
        );
      }
    }
    first.database.close();

    const restarted = openService(databasePath, port);
    const replayed = await restarted.service.approveAndExecute(created.missionId, "founder");
    expect(replayed.runtimeResult).toEqual(completed.runtimeResult);
    expect(replayed.execution?.recoveryClassification).toBe("DURABLE_REPLAY");
    expect(port.jobs).toHaveLength(1);
    expect(port.scheduleCalls).toBe(1);
    restarted.database.close();
  });

  it("revalidates every completed durable binding before returning prior evidence", async () => {
    const mutations: Array<{
      label: string;
      expectedCode: string;
      apply(database: DatabaseSync, missionId: string): void;
      replayApprovedBy?: string;
    }> = [
      {
        label: "mission",
        expectedCode: "OPERATOR_REPLAY_SCOPE_MISMATCH",
        apply(database, missionId) {
          const row = database.prepare("SELECT runtime_result_json FROM autoposter_runtime_missions WHERE mission_id = ?").get(missionId) as { runtime_result_json: string };
          const result = JSON.parse(row.runtime_result_json) as Record<string, unknown>;
          result.missionId = "changed-mission";
          database.prepare("UPDATE autoposter_runtime_missions SET runtime_result_json = ? WHERE mission_id = ?").run(JSON.stringify(result), missionId);
        },
      },
      {
        label: "action",
        expectedCode: "OPERATOR_REPLAY_SCOPE_MISMATCH",
        apply(database, missionId) {
          const row = database.prepare("SELECT runtime_result_json FROM autoposter_runtime_missions WHERE mission_id = ?").get(missionId) as { runtime_result_json: string };
          const result = JSON.parse(row.runtime_result_json) as Record<string, unknown>;
          result.action = "autoposter.queue.list";
          database.prepare("UPDATE autoposter_runtime_missions SET runtime_result_json = ? WHERE mission_id = ?").run(JSON.stringify(result), missionId);
        },
      },
      { label: "workspace", expectedCode: "OPERATOR_PAYLOAD_MISMATCH", apply: (database, missionId) => { database.prepare("UPDATE autoposter_runtime_missions SET workspace_id = 'workspace-b-00000002' WHERE mission_id = ?").run(missionId); } },
      { label: "provider", expectedCode: "OPERATOR_PAYLOAD_MISMATCH", apply: (database, missionId) => { database.prepare("UPDATE autoposter_runtime_missions SET provider = 'youtube' WHERE mission_id = ?").run(missionId); } },
      { label: "account-value", expectedCode: "OPERATOR_PAYLOAD_MISMATCH", apply: (database, missionId) => { database.prepare("UPDATE autoposter_runtime_missions SET account_id = 'account-b' WHERE mission_id = ?").run(missionId); } },
      { label: "account-case", expectedCode: "OPERATOR_PAYLOAD_MISMATCH", apply: (database, missionId) => { database.prepare("UPDATE autoposter_runtime_missions SET account_id = 'Account-A' WHERE mission_id = ?").run(missionId); } },
      { label: "account-whitespace", expectedCode: "OPERATOR_PAYLOAD_MISMATCH", apply: (database, missionId) => { database.prepare("UPDATE autoposter_runtime_missions SET account_id = ' account-a' WHERE mission_id = ?").run(missionId); } },
      { label: "payload", expectedCode: "OPERATOR_PAYLOAD_MISMATCH", apply: (database, missionId) => { database.prepare("UPDATE autoposter_runtime_missions SET caption = 'changed payload' WHERE mission_id = ?").run(missionId); } },
      { label: "idempotency-key", expectedCode: "OPERATOR_IDEMPOTENCY_MISMATCH", apply: (database, missionId) => { database.prepare("UPDATE autoposter_runtime_missions SET idempotency_key = 'changed-key' WHERE mission_id = ?").run(missionId); } },
      { label: "schedule", expectedCode: "OPERATOR_PAYLOAD_MISMATCH", apply: (database, missionId) => { database.prepare("UPDATE autoposter_runtime_missions SET scheduled_at = '2030-07-20T12:00:00+00:00' WHERE mission_id = ?").run(missionId); } },
      { label: "approval-identity", expectedCode: "OPERATOR_APPROVAL_BINDING_MISMATCH", apply: () => {}, replayApprovedBy: "different-founder" },
      { label: "approval-state", expectedCode: "OPERATOR_APPROVAL_BINDING_MISMATCH", apply: (database, missionId) => { database.prepare("UPDATE autoposter_runtime_missions SET approved_by = NULL WHERE mission_id = ?").run(missionId); } },
      { label: "runtime-attempt-result", expectedCode: "OPERATOR_RUNTIME_RESULT_BINDING_MISMATCH", apply: (database, missionId) => { database.prepare("UPDATE autoposter_mission_executions SET runtime_observation_json = NULL WHERE mission_id = ?").run(missionId); } },
    ];

    for (const mutation of mutations) {
      const root = mkdtempSync(path.join(os.tmpdir(), `chanter-completed-binding-${mutation.label}-`));
      roots.push(root);
      const port = new DurableAutoPosterPort();
      const opened = openService(path.join(root, "operator.sqlite"), port);
      const created = await opened.service.createScheduleMission(missionInput());
      await opened.service.approveAndExecute(created.missionId, "founder");
      mutation.apply(opened.database, created.missionId);
      await expect(opened.service.approveAndExecute(
        created.missionId,
        mutation.replayApprovedBy ?? "founder",
      )).rejects.toMatchObject({ code: mutation.expectedCode });
      expect(port.jobs, mutation.label).toHaveLength(1);
      expect(port.scheduleCalls, mutation.label).toBe(1);
      opened.database.close();
      activeDatabases.delete(opened.database);
    }
  }, 15_000);

  const interruptionCases: Array<{
    boundary: MissionFailureBoundary;
    preCrashState: string;
    classification: string;
    retryCount: number;
    throws: boolean;
  }> = [
    { boundary: "after_approval_persistence", preCrashState: "approved", classification: "RESUMED_BEFORE_DOWNSTREAM", retryCount: 0, throws: true },
    { boundary: "after_runtime_execution_start_persistence", preCrashState: "execution_started", classification: "SAFE_RETRY_COMPLETED", retryCount: 1, throws: true },
    { boundary: "after_downstream_request_preparation_persistence", preCrashState: "downstream_request_prepared", classification: "SAFE_RETRY_COMPLETED", retryCount: 1, throws: true },
    { boundary: "before_autoposter_durable_create", preCrashState: "failed_recoverable", classification: "SAFE_RETRY_COMPLETED", retryCount: 1, throws: false },
    { boundary: "after_autoposter_durable_create_before_response", preCrashState: "failed_recoverable", classification: "RECOVERED_EXISTING_DOWNSTREAM_RESULT", retryCount: 0, throws: false },
    { boundary: "after_runtime_receives_queue_id_before_result_persistence", preCrashState: "failed_recoverable", classification: "RECOVERED_EXISTING_DOWNSTREAM_RESULT", retryCount: 0, throws: false },
    { boundary: "after_runtime_result_persistence", preCrashState: "failed_recoverable", classification: "RECOVERED_EXISTING_DOWNSTREAM_RESULT", retryCount: 0, throws: false },
    { boundary: "after_operator_observes_runtime_result_before_persistence", preCrashState: "downstream_result_observed", classification: "RECOVERED_RUNTIME_RESULT", retryCount: 0, throws: true },
  ];

  for (const scenario of interruptionCases) {
    it(`recovers deterministically at ${scenario.boundary}`, async () => {
      const root = mkdtempSync(path.join(os.tmpdir(), "chanter-boundary-"));
      roots.push(root);
      const databasePath = path.join(root, "operator.sqlite");
      const port = new DurableAutoPosterPort();
      const crashing = openService(databasePath, port, scenario.boundary);
      const created = await crashing.service.createScheduleMission(missionInput());
      const execution = crashing.service.approveAndExecute(created.missionId, "founder");
      if (scenario.throws) {
        await expect(execution).rejects.toThrow(`INJECTED_PROCESS_TERMINATION:${scenario.boundary}`);
      } else {
        await expect(execution).resolves.toMatchObject({
          execution: { state: "failed_recoverable" },
        });
      }
      expect(crashing.service.getMission(created.missionId).execution?.state).toBe(scenario.preCrashState);
      crashing.database.close();

      const restarted = openService(databasePath, port);
      const recovered = await finishAfterRestart(restarted.service, created.missionId);
      expect(recovered.execution).toMatchObject({
        state: "completed",
        authoritativeQueueId: "queue-1",
        recoveryClassification: scenario.classification,
        retryCount: scenario.retryCount,
      });
      expect(recovered.executionJournal.at(-1)?.newState).toBe("completed");
      expect(port.jobs).toHaveLength(1);
      restarted.database.close();
    });
  }

  for (const boundary of [
    "during_restart_claim_recovery",
    "after_reconciliation_starts_before_lookup",
    "after_reconciliation_result_before_state_persistence",
  ] as const) {
    it(`survives a second restart at ${boundary}`, async () => {
      const root = mkdtempSync(path.join(os.tmpdir(), "chanter-recovery-boundary-"));
      roots.push(root);
      const databasePath = path.join(root, "operator.sqlite");
      const port = new DurableAutoPosterPort();
      const initial = openService(databasePath, port, "after_downstream_request_preparation_persistence");
      const created = await initial.service.createScheduleMission(missionInput());
      await expect(initial.service.approveAndExecute(created.missionId, "founder")).rejects.toThrow();
      initial.database.close();

      const interruptedRecovery = openService(databasePath, port, boundary);
      await expect(interruptedRecovery.service.reconcileMission(created.missionId))
        .rejects.toThrow(`INJECTED_PROCESS_TERMINATION:${boundary}`);
      const inProgress = interruptedRecovery.service.getMission(created.missionId);
      expect(inProgress.execution).toMatchObject({
        state: "recovery_in_progress",
        nextPermittedActions: ["Reconcile"],
      });
      await expect(interruptedRecovery.service.resumeSafely(created.missionId))
        .rejects.toMatchObject({ code: "RECOVERY_ACTION_NOT_PERMITTED" });
      expect(() => interruptedRecovery.service.stopAndEscalate(created.missionId))
        .toThrow(expect.objectContaining({ code: "RECOVERY_ACTION_NOT_PERMITTED" }));
      interruptedRecovery.database.close();

      const restartedAgain = openService(databasePath, port);
      const recovered = await finishAfterRestart(restartedAgain.service, created.missionId);
      expect(recovered.execution).toMatchObject({
        state: "completed",
        recoveryClassification: "SAFE_RETRY_COMPLETED",
        retryCount: 1,
      });
      expect(port.jobs).toHaveLength(1);
      restartedAgain.database.close();
    });
  }

  it("keeps a completed durable result authoritative when duplicate replay crashes", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "chanter-duplicate-replay-"));
    roots.push(root);
    const databasePath = path.join(root, "operator.sqlite");
    const port = new DurableAutoPosterPort();
    const first = openService(databasePath, port);
    const created = await first.service.createScheduleMission(missionInput());
    await first.service.approveAndExecute(created.missionId, "founder");
    first.database.close();

    const interruptedReplay = openService(databasePath, port, "during_duplicate_replay_after_completion");
    await expect(interruptedReplay.service.approveAndExecute(created.missionId, "founder"))
      .rejects.toThrow("INJECTED_PROCESS_TERMINATION:during_duplicate_replay_after_completion");
    interruptedReplay.database.close();

    const restarted = openService(databasePath, port);
    const replayed = await restarted.service.approveAndExecute(created.missionId, "founder");
    expect(replayed.execution).toMatchObject({ state: "completed", recoveryClassification: "DURABLE_REPLAY" });
    expect(port.jobs).toHaveLength(1);
    expect(port.scheduleCalls).toBe(1);
    restarted.database.close();
  });

  it("allows only one cross-connection claim of the bounded safe retry", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "chanter-safe-retry-claim-"));
    roots.push(root);
    const databasePath = path.join(root, "operator.sqlite");
    const port = new DurableAutoPosterPort();
    const initial = openService(databasePath, port, "after_downstream_request_preparation_persistence");
    const created = await initial.service.createScheduleMission(missionInput());
    await expect(initial.service.approveAndExecute(created.missionId, "founder")).rejects.toThrow();
    initial.database.close();

    const reconciler = openService(databasePath, port);
    const reconciled = await reconciler.service.reconcileMission(created.missionId);
    expect(reconciled.execution).toMatchObject({
      state: "failed_recoverable",
      reconciliationOutcome: "not_found",
      retryCount: 0,
    });
    reconciler.database.close();

    const firstProcess = openService(databasePath, port);
    const secondProcess = openService(databasePath, port);
    const results = await Promise.allSettled([
      firstProcess.service.resumeSafely(created.missionId),
      secondProcess.service.resumeSafely(created.missionId),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(firstProcess.service.getMission(created.missionId).execution).toMatchObject({
      state: "completed",
      retryCount: 1,
      authoritativeQueueId: "queue-1",
    });
    expect(port.scheduleCalls).toBe(1);
    expect(port.jobs).toHaveLength(1);
    firstProcess.database.close();
    secondProcess.database.close();
  });

  it("stops on conflicting downstream truth without creating another queue job", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "chanter-conflict-"));
    roots.push(root);
    const databasePath = path.join(root, "operator.sqlite");
    const port = new DurableAutoPosterPort();
    const crashing = openService(databasePath, port, "after_autoposter_durable_create_before_response");
    const created = await crashing.service.createScheduleMission(missionInput());
    await expect(crashing.service.approveAndExecute(created.missionId, "founder"))
      .resolves.toMatchObject({ execution: { state: "failed_recoverable" } });
    crashing.database.close();
    port.addConflict();

    const restarted = openService(databasePath, port);
    const conflict = await restarted.service.reconcileMission(created.missionId);
    expect(conflict.execution).toMatchObject({
      state: "reconciliation_required",
      reconciliationOutcome: "conflict",
      recoveryClassification: "RECONCILIATION_REQUIRED",
      evidenceStatus: "reconciliation_required",
    });
    expect(conflict.execution?.nextPermittedActions).toEqual(["Stop / escalate"]);
    expect(conflict.execution?.typedError?.code).toBe("RECONCILIATION_REQUIRED");
    expect(port.jobs).toHaveLength(2);
    expect(port.scheduleCalls).toBe(1);
    restarted.database.close();
  });

  it("emits deterministic scenario A-E/G evidence summaries", async () => {
    const evidenceChainId = (mission: Awaited<ReturnType<typeof finishAfterRestart>>) =>
      createHash("sha256").update(JSON.stringify({
        missionId: mission.missionId,
        transitions: mission.executionJournal.map((transition) => transition.transitionId),
      })).digest("hex");
    const summary = (scenario: string, mission: Awaited<ReturnType<typeof finishAfterRestart>>, port: DurableAutoPosterPort) => ({
      scenario,
      jobs: port.jobs.length,
      createAttempts: port.scheduleCalls,
      queueId: mission.execution?.authoritativeQueueId ?? null,
      downstreamQueueIds: port.jobs.map((job) => job.id),
      finalOperatorState: mission.execution?.state ?? null,
      duplicateCount: Math.max(0, port.jobs.length - 1),
      recoveryClassification: mission.execution?.recoveryClassification ?? "NONE",
      evidenceChainId: evidenceChainId(mission),
    });
    const matrix: ReturnType<typeof summary>[] = [];

    const rootA = mkdtempSync(path.join(os.tmpdir(), "chanter-scenario-a-b-"));
    roots.push(rootA);
    const pathA = path.join(rootA, "operator.sqlite");
    const portA = new DurableAutoPosterPort();
    const serviceA = openService(pathA, portA);
    const createdA = await serviceA.service.createScheduleMission(missionInput());
    const completedA = await serviceA.service.approveAndExecute(createdA.missionId, "founder");
    matrix.push(summary("A", completedA, portA));
    serviceA.database.close();
    activeDatabases.delete(serviceA.database);
    const replayA = openService(pathA, portA);
    const replayedA = await replayA.service.approveAndExecute(createdA.missionId, "founder");
    matrix.push(summary("B", replayedA, portA));
    replayA.database.close();
    activeDatabases.delete(replayA.database);

    const recoverScenario = async (
      scenario: string,
      boundary: MissionFailureBoundary,
      mutate?: (port: DurableAutoPosterPort) => void,
    ) => {
      const root = mkdtempSync(path.join(os.tmpdir(), `chanter-scenario-${scenario.toLowerCase()}-`));
      roots.push(root);
      const databasePath = path.join(root, "operator.sqlite");
      const port = new DurableAutoPosterPort();
      const first = openService(databasePath, port, boundary);
      const created = await first.service.createScheduleMission(missionInput());
      try { await first.service.approveAndExecute(created.missionId, "founder"); } catch { /* injected Operator boundary */ }
      first.database.close();
      activeDatabases.delete(first.database);
      mutate?.(port);
      const restarted = openService(databasePath, port);
      let finalMission = await restarted.service.reconcileMission(created.missionId);
      if (["downstream_result_observed", "failed_recoverable", "result_persisted"].includes(finalMission.execution?.state ?? "")) {
        finalMission = await restarted.service.resumeSafely(created.missionId);
      }
      matrix.push(summary(scenario, finalMission, port));
      restarted.database.close();
      activeDatabases.delete(restarted.database);
    };

    await recoverScenario("C", "after_autoposter_durable_create_before_response");
    await recoverScenario("D", "after_downstream_request_preparation_persistence");
    await recoverScenario("E", "after_autoposter_durable_create_before_response", (port) => {
      port.jobs[0]!.missionPayloadHash = "b".repeat(64);
    });
    await recoverScenario("G", "after_autoposter_durable_create_before_response", (port) => {
      port.addConflict();
    });

    expect(matrix.map((item) => item.finalOperatorState)).toEqual([
      "completed",
      "completed",
      "completed",
      "completed",
      "failed_terminal",
      "reconciliation_required",
    ]);
    console.log(`SCENARIO_MATRIX ${JSON.stringify(matrix)}`);
  });
});
