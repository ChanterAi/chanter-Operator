/**
 * Consumer migration proofs: Operator authorizes execution only through the
 * Agent Runtime's persisted approval checkpoint authority.
 *
 * Every proof drives the real Operator services and the real Runtime. The only
 * fakes are the downstream product ports (AutoPoster queue, Loop Governor
 * process), which perform no external side effect and count adapter entries so
 * "exactly once" is measured rather than inferred.
 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  FakeTemporalClock,
  createAutoPosterMissionAdapter,
  createDurableIdempotencyStore,
  createInMemoryIdempotencyStore,
  createMissionAdapterRegistry,
  executeMission,
  type AutoPosterOperationsPort,
  type AutoPosterScheduleParams,
  type LoopGovernorMissionPort,
  type RuntimeMissionApprovalAuthorityInput,
  type RuntimeMissionRequest,
} from "chanter-agent-runtime";
import { AgentRunLedgerService } from "../src/agentRunLedger/agentRunLedgerService.js";
import { createDatabase } from "../src/db/database.js";
import { GenericMissionService } from "../src/missions/genericMissionService.js";
import { createLoopGovernorMissionExecutor } from "../src/missions/loopGovernorRuntime.js";
import { AutoPosterMissionService } from "../src/runtimeMissions/autoPosterMissionService.js";
import { createAutoPosterRuntimeMissionExecutor } from "../src/runtimeMissions/autoPosterRuntime.js";
import type { OperatorApprovalAuthorityConfiguration } from "../src/runtimeMissions/persistedApprovalAuthority.js";
import {
  approvalAuthorityFixture,
  cleanupApprovalAuthorityFixtures,
  nonRepositoryApprovalAuthorityFixture,
} from "./helpers/approvalAuthorityFixture.js";

const APPROVER = "founder";
const OWNER_ID = "owner";
const WORKSPACE_ID = "workspace-a-00000001";
const ACCOUNT_ID = "account-a";
/** Fixed so `observedAt`, expiry, and the injected clock are all deterministic. */
const APPROVAL_INSTANT = "2026-08-01T00:00:00.000Z";
const APPROVAL_MS = Date.parse(APPROVAL_INSTANT);

const temporaryRoots: string[] = [];
const openDatabases: DatabaseSync[] = [];

afterEach(() => {
  for (const database of openDatabases.splice(0)) {
    try {
      database.close();
    } catch {
      // Already closed by a restart proof.
    }
  }
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
  cleanupApprovalAuthorityFixtures();
});

function temporaryRoot(prefix: string): string {
  const root = mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

/**
 * The AutoPoster adapter validates `scheduledAt` against the real wall clock,
 * so this stays wall-clock relative. Approval expiry never uses it: expiry is
 * evaluated only between `observedAt` and the injected `FakeTemporalClock`.
 */
function futureIso(minutes = 90): string {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

// ---------------------------------------------------------------------------
// AutoPoster consumer harness
// ---------------------------------------------------------------------------

interface AutoPosterBoundary {
  port: AutoPosterOperationsPort;
  /** Every adapter entry that reached the downstream schedule boundary. */
  scheduleCalls: AutoPosterScheduleParams[];
}

function makeAutoPosterBoundary(): AutoPosterBoundary {
  const scheduleCalls: AutoPosterScheduleParams[] = [];
  const accountView = (accountId: string, provider: "tiktok" | "youtube") => ({
    connectedAccountId: `${provider}:${accountId}`,
    accountId,
    provider,
    providerDisplayName: provider === "youtube" ? "YouTube" : "TikTok",
    username: "creator",
    displayName: "Creator",
    connectionStatus: "connected" as const,
    publishingReady: true,
    readinessBlockers: [],
    lastVerifiedAt: APPROVAL_INSTANT,
  });
  const port: AutoPosterOperationsPort = {
    async listConnectedAccounts(params) {
      const accounts = [accountView(ACCOUNT_ID, "tiktok")];
      return { ok: true, workspaceId: params.workspaceId, accounts, count: accounts.length };
    },
    async validateConnectedAccount(params) {
      return {
        ok: true,
        workspaceId: params.workspaceId ?? WORKSPACE_ID,
        account: accountView(params.accountId, params.provider as "tiktok" | "youtube"),
      };
    },
    async listQueue() {
      return { ok: true, items: [], count: 0, scope: { accountId: "all" } };
    },
    async getPostStatus(params) {
      return {
        ok: true,
        post: {
          id: params.postId,
          accountId: params.accountId ?? ACCOUNT_ID,
          username: "creator",
          status: "scheduled",
          scheduledAt: futureIso(),
          approved: false,
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
    },
    async validateMedia() {
      return {
        ok: true,
        valid: true,
        classification: "video",
        policy: { videoOnly: true, allowedExtensions: [".mp4"] },
      };
    },
    async schedulePost(params) {
      scheduleCalls.push(params);
      return {
        ok: true,
        duplicate: false,
        post: {
          id: "queue-draft-1",
          accountId: params.accountId,
          provider: params.provider ?? "tiktok",
          status: "scheduled",
          scheduledAt: params.scheduledAt,
          approved: false,
          campaignId: `autoposter-campaign:${params.missionId}`,
          approvalId: `autoposter-approval:${params.missionId}`,
          evidenceBundleId: `autoposter-evidence:${params.missionId}`,
        },
      };
    },
  };
  return { port, scheduleCalls };
}

interface AutoPosterHarness {
  service: AutoPosterMissionService;
  executor: ReturnType<typeof createAutoPosterRuntimeMissionExecutor>;
  database: DatabaseSync;
}

function openAutoPosterHarness(input: {
  databasePath: string;
  boundary: AutoPosterBoundary;
  approvalAuthority?: OperatorApprovalAuthorityConfiguration;
  clock?: FakeTemporalClock;
  failureInjector?: (boundary: string, missionId: string) => void;
}): AutoPosterHarness {
  const database = createDatabase(input.databasePath);
  openDatabases.push(database);
  const executor = createAutoPosterRuntimeMissionExecutor(
    {
      baseUrl: "https://autoposter.migration.test",
      serviceToken: "migration-service-token",
      userId: OWNER_ID,
      timeoutValid: true,
      ...(input.approvalAuthority ? { approvalAuthority: input.approvalAuthority } : {}),
    },
    { port: input.boundary.port, ...(input.clock ? { clock: input.clock } : {}) },
  );
  const service = new AutoPosterMissionService(database, executor, {
    agentRunLedgerService: new AgentRunLedgerService(database),
    now: () => new Date(APPROVAL_MS),
    ...(input.failureInjector
      ? { failureInjector: input.failureInjector as never }
      : {}),
  });
  return { service, executor, database };
}

/**
 * Publishes the human decision with an explicit temporal bound through the one
 * seam that persists it immutably. Expiry lives in the published observation,
 * never in transient consumer state.
 */
function publishBoundedApproval(harness: AutoPosterHarness, missionId: string) {
  return harness.executor.prepareApproval(harness.service.runtimeRequestFor(missionId), {
    approverId: APPROVER,
    observedAt: APPROVAL_INSTANT,
    approvalExpiresAt: new Date(APPROVAL_MS + 60_000).toISOString(),
  });
}

function scheduleInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    workspaceId: WORKSPACE_ID,
    accountId: ACCOUNT_ID,
    provider: "tiktok",
    mediaUrl: "https://cdn.example.com/video.mp4",
    caption: "Migration proof clip",
    hashtags: "#chanter",
    scheduledAt: futureIso(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Loop Governor consumer harness
// ---------------------------------------------------------------------------

function makeLoopBoundary(): { port: LoopGovernorMissionPort; createCalls: unknown[] } {
  const createCalls: unknown[] = [];
  const port: LoopGovernorMissionPort = {
    async createManualLoop(params) {
      createCalls.push(params);
      return {
        ok: true,
        created: true,
        taskId: "task-migration-1",
        loopId: "loop-migration-1",
        realAgentExecution: false,
      };
    },
    async lookupManualLoop() {
      return { ok: true, outcome: "not_found", binding: null };
    },
  };
  return { port, createCalls };
}

function loopEnvelope(): Record<string, unknown> {
  return {
    schemaVersion: "chanter.mission.v1",
    missionId: "migration-mission-0001",
    traceId: "migration-trace-0001",
    idempotencyKey: "migration-key-0001",
    source: { system: "mission_compiler", requestedBy: "founder-cli" },
    objective: "Prove the migrated persisted approval authority path.",
    target: { product: "loop_governor", action: "loop_governor.manual_loop.create" },
    tenant: { userId: "founder" },
    input: {
      appName: "chanter-operator",
      taskType: "review",
      goal: "Review the persisted approval authority consumer migration.",
      scope: "operator backend missions only",
    },
    constraints: ["No real agent execution"],
    acceptanceCriteria: ["One manual relay loop exists"],
    requestedAt: APPROVAL_INSTANT,
  };
}

function openLoopHarness(input: {
  databasePath: string;
  port: LoopGovernorMissionPort;
  approvalAuthority?: OperatorApprovalAuthorityConfiguration;
  clock?: FakeTemporalClock;
}): {
  service: GenericMissionService;
  executor: ReturnType<typeof createLoopGovernorMissionExecutor>;
  database: DatabaseSync;
} {
  const database = createDatabase(input.databasePath);
  openDatabases.push(database);
  const executor = createLoopGovernorMissionExecutor(
    {
      pythonExecutable: "",
      governorRoot: "",
      dataDir: "",
      timeoutValid: true,
      ...(input.approvalAuthority ? { approvalAuthority: input.approvalAuthority } : {}),
    },
    { port: input.port, ...(input.clock ? { clock: input.clock } : {}) },
  );
  const service = new GenericMissionService(database, executor, {
    agentRunLedgerService: new AgentRunLedgerService(database),
    now: () => new Date(APPROVAL_MS),
  });
  return { service, executor, database };
}

// ---------------------------------------------------------------------------

describe("Operator persisted approval authority migration", () => {
  it("accepts a valid persisted approval and binds durable checkpoint + observation evidence", async () => {
    const root = temporaryRoot("chanter-approval-accept-");
    const approvalAuthority = approvalAuthorityFixture();
    const boundary = makeAutoPosterBoundary();
    const { service } = openAutoPosterHarness({
      databasePath: path.join(root, "operator.sqlite"),
      boundary,
      approvalAuthority,
    });

    const created = await service.createScheduleMission(scheduleInput());
    const completed = await service.approveAndExecute(created.missionId, APPROVER);

    expect(completed.status).toBe("succeeded");
    expect(completed.execution?.state).toBe("completed");
    expect(boundary.scheduleCalls).toHaveLength(1);
    expect(completed.runtimeResult?.approvalDecision).toMatchObject({
      required: true,
      approved: true,
      approvedBy: APPROVER,
    });

    // The authority is durable, content-addressed, and bound to this mission.
    const store = createDurableIdempotencyStore({ stateDir: approvalAuthority.stateDir });
    const manifest = store.getApprovalCheckpointManifest(created.missionId);
    const observation = store.getApprovalObservation(created.missionId);
    expect(manifest?.missionId).toBe(created.missionId);
    expect(manifest?.operationId).toBe("autoposter.queue.create_unapproved_draft");
    expect(observation?.status).toBe("approved");
    expect(observation?.approverId).toBe(APPROVER);
    expect(observation?.checkpointManifestHash).toBe(manifest?.manifestHash);
    expect(observation?.approvalExpiresAt).toBeUndefined();
    expect(completed.runtimeResult?.approvalDecision.authority).toMatchObject({
      state: "approved",
      manifestHash: manifest?.manifestHash,
      observationHash: observation?.observationHash,
    });
  });

  it("refuses execution when no persisted authority binding is configured", async () => {
    const root = temporaryRoot("chanter-approval-unbound-");
    const boundary = makeAutoPosterBoundary();
    const { service } = openAutoPosterHarness({
      databasePath: path.join(root, "operator.sqlite"),
      boundary,
    });

    const created = await service.createScheduleMission(scheduleInput());
    const refused = await service.approveAndExecute(created.missionId, APPROVER);

    expect(refused.status).toBe("failed");
    expect(refused.runtimeResult?.errors[0]?.code).toBe(
      "OPERATOR_APPROVAL_AUTHORITY_NOT_CONFIGURED",
    );
    expect(refused.runtimeResult?.approvalDecision).toMatchObject({
      required: true,
      approved: false,
      approvedBy: null,
    });
    expect(boundary.scheduleCalls).toHaveLength(0);
  });

  it("refuses a legacy transient approval object on the real Runtime path", async () => {
    const boundary = makeAutoPosterBoundary();
    const registry = createMissionAdapterRegistry([createAutoPosterMissionAdapter(boundary.port)]);
    const legacyRequest: RuntimeMissionRequest = {
      missionId: "legacy-transient-mission",
      traceId: "legacy-transient-trace",
      product: "auto_poster",
      action: "autoposter.post.schedule",
      actor: { id: "chanter-operator", kind: "service" },
      tenant: { userId: OWNER_ID, workspaceId: WORKSPACE_ID, accountId: ACCOUNT_ID },
      input: {
        accountId: ACCOUNT_ID,
        provider: "tiktok",
        mediaUrl: "https://cdn.example.com/video.mp4",
        caption: "Legacy transient approval",
        hashtags: "#chanter",
        scheduledAt: futureIso(),
      },
      // Exactly the pre-migration shape this task removes as an authority.
      approval: { approved: true, approvedBy: APPROVER },
      idempotencyKey: "legacy-transient-key",
      requestedAt: APPROVAL_INSTANT,
    };

    const result = await executeMission(legacyRequest, {
      registry,
      idempotencyStore: createInMemoryIdempotencyStore(),
    });

    expect(result.status).toBe("failed");
    expect(result.errors[0]?.code).toBe("RUNTIME_APPROVAL_PERSISTED_AUTHORITY_REQUIRED");
    expect(result.approvalDecision.approved).toBe(false);
    expect(boundary.scheduleCalls).toHaveLength(0);
  });

  it("refuses when the persisted observation rejected the checkpoint", async () => {
    const root = temporaryRoot("chanter-approval-rejected-");
    const approvalAuthority = approvalAuthorityFixture();
    const boundary = makeAutoPosterBoundary();
    const { service, executor } = openAutoPosterHarness({
      databasePath: path.join(root, "operator.sqlite"),
      boundary,
      approvalAuthority,
    });

    const created = await service.createScheduleMission(scheduleInput());
    // The human decision is a rejection, published as durable authority.
    const published = await executor.prepareApproval(service.runtimeRequestFor(created.missionId), {
      approverId: APPROVER,
      note: "Rejected by the founder.",
      observedAt: APPROVAL_INSTANT,
      status: "rejected",
    });
    expect(published.ok).toBe(true);

    const refused = await service.approveAndExecute(created.missionId, APPROVER);

    expect(refused.status).toBe("denied");
    expect(refused.runtimeResult?.errors[0]?.code).toBe("RUNTIME_APPROVAL_REJECTED");
    expect(boundary.scheduleCalls).toHaveLength(0);
  });

  it("refuses an expired approval and refuses again at the exact expiry boundary", async () => {
    for (const [label, evaluatedMs] of [
      ["exact boundary", APPROVAL_MS + 60_000],
      ["after expiry", APPROVAL_MS + 120_000],
    ] as const) {
      const root = temporaryRoot("chanter-approval-expired-");
      const approvalAuthority = approvalAuthorityFixture();
      const boundary = makeAutoPosterBoundary();
      const clock = new FakeTemporalClock(new Date(evaluatedMs));
      const harness = openAutoPosterHarness({
        databasePath: path.join(root, "operator.sqlite"),
        boundary,
        approvalAuthority,
        clock,
      });
      const { service } = harness;

      const created = await service.createScheduleMission(scheduleInput());
      const published = await publishBoundedApproval(harness, created.missionId);
      expect(published.ok, label).toBe(true);
      const refused = await service.approveAndExecute(created.missionId, APPROVER);

      expect(refused.status, label).toBe("denied");
      expect(refused.runtimeResult?.errors[0]?.code, label).toBe("RUNTIME_APPROVAL_EXPIRED");
      expect(refused.runtimeResult?.approvalDecision.approved, label).toBe(false);
      expect(boundary.scheduleCalls, label).toHaveLength(0);
    }
  });

  it("accepts a bounded approval that has not yet expired", async () => {
    const root = temporaryRoot("chanter-approval-live-");
    const approvalAuthority = approvalAuthorityFixture();
    const boundary = makeAutoPosterBoundary();
    const clock = new FakeTemporalClock(new Date(APPROVAL_MS + 30_000));
    const harness = openAutoPosterHarness({
      databasePath: path.join(root, "operator.sqlite"),
      boundary,
      approvalAuthority,
      clock,
    });
    const { service } = harness;

    const created = await service.createScheduleMission(scheduleInput());
    expect((await publishBoundedApproval(harness, created.missionId)).ok).toBe(true);
    const completed = await service.approveAndExecute(created.missionId, APPROVER);

    expect(completed.status).toBe("succeeded");
    expect(boundary.scheduleCalls).toHaveLength(1);
    const store = createDurableIdempotencyStore({ stateDir: approvalAuthority.stateDir });
    expect(store.getApprovalObservation(created.missionId)?.approvalExpiresAt)
      .toBe(new Date(APPROVAL_MS + 60_000).toISOString());
  });

  it("refuses authority that belongs to another mission's checkpoint", async () => {
    const root = temporaryRoot("chanter-approval-mismatch-");
    const approvalAuthority = approvalAuthorityFixture();
    const boundary = makeAutoPosterBoundary();
    const { service, executor } = openAutoPosterHarness({
      databasePath: path.join(root, "operator.sqlite"),
      boundary,
      approvalAuthority,
    });

    const first = await service.createScheduleMission(scheduleInput());
    const second = await service.createScheduleMission(
      scheduleInput({ caption: "Second migration proof clip" }),
    );
    const firstAuthority = await executor.prepareApproval(
      service.runtimeRequestFor(first.missionId),
      { approverId: APPROVER, observedAt: APPROVAL_INSTANT },
    );
    expect(firstAuthority.ok).toBe(true);
    if (!firstAuthority.ok) throw new Error("unreachable");

    // The other mission's exact authority tuple must not authorize this one.
    const result = await executor.execute(
      service.runtimeRequestFor(second.missionId),
      firstAuthority.authority,
    );

    expect(result.status).not.toBe("succeeded");
    expect(result.errors[0]?.code).toBe("RUNTIME_APPROVAL_CHECKPOINT_MISSING");
    expect(boundary.scheduleCalls).toHaveLength(0);
  });

  it("refuses tampered evidence, expected HEAD, and repository identity", async () => {
    const root = temporaryRoot("chanter-approval-tamper-");
    const approvalAuthority = approvalAuthorityFixture();
    const boundary = makeAutoPosterBoundary();
    const { service, executor } = openAutoPosterHarness({
      databasePath: path.join(root, "operator.sqlite"),
      boundary,
      approvalAuthority,
    });

    const created = await service.createScheduleMission(scheduleInput());
    const request = service.runtimeRequestFor(created.missionId);
    const prepared = await executor.prepareApproval(request, {
      approverId: APPROVER,
      observedAt: APPROVAL_INSTANT,
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) throw new Error("unreachable");
    const authority = prepared.authority;

    const tampered: Array<[string, RuntimeMissionApprovalAuthorityInput, string]> = [
      [
        "evidence hash",
        {
          ...authority,
          evidenceReferences: authority.evidenceReferences.map((reference) => ({
            ...reference,
            sha256: "b".repeat(64),
          })),
        },
        "RUNTIME_APPROVAL_EVIDENCE_REFERENCE_MISMATCH",
      ],
      [
        "expected HEAD",
        { ...authority, expectedHead: "0".repeat(40) },
        "RUNTIME_APPROVAL_EXPECTED_HEAD_MISMATCH",
      ],
      [
        "repository identity",
        { ...authority, repositoryId: "c".repeat(64) },
        "RUNTIME_APPROVAL_REPOSITORY_MISMATCH",
      ],
      [
        "observation hash",
        { ...authority, observationHash: "d".repeat(64) },
        "RUNTIME_APPROVAL_AUTHORITY_BINDING_MISMATCH",
      ],
    ];

    for (const [label, input, code] of tampered) {
      const result = await executor.execute(request, input);
      expect(result.status, label).not.toBe("succeeded");
      expect(result.errors[0]?.code, label).toBe(code);
    }
    expect(boundary.scheduleCalls).toHaveLength(0);
  });

  it("refuses when the approval-bound repository is not a real worktree", async () => {
    const root = temporaryRoot("chanter-approval-norepo-");
    const boundary = makeAutoPosterBoundary();
    const { service } = openAutoPosterHarness({
      databasePath: path.join(root, "operator.sqlite"),
      boundary,
      approvalAuthority: nonRepositoryApprovalAuthorityFixture(),
    });

    const created = await service.createScheduleMission(scheduleInput());
    const refused = await service.approveAndExecute(created.missionId, APPROVER);

    expect(refused.status).toBe("failed");
    expect(refused.runtimeResult?.errors[0]?.code).toBe(
      "OPERATOR_APPROVAL_REPOSITORY_UNAVAILABLE",
    );
    expect(boundary.scheduleCalls).toHaveLength(0);
  });

  it("resumes a still-valid persisted approval after a restart, and only once", async () => {
    const root = temporaryRoot("chanter-approval-restart-");
    const databasePath = path.join(root, "operator.sqlite");
    const approvalAuthority = approvalAuthorityFixture();
    const boundary = makeAutoPosterBoundary();

    let injected = false;
    const first = openAutoPosterHarness({
      databasePath,
      boundary,
      approvalAuthority,
      failureInjector: (name) => {
        if (!injected && name === "after_approval_persistence") {
          injected = true;
          throw new Error("INJECTED_PROCESS_TERMINATION");
        }
      },
    });
    const created = await first.service.createScheduleMission(scheduleInput());
    await expect(first.service.approveAndExecute(created.missionId, APPROVER)).rejects.toThrow(
      /INJECTED_PROCESS_TERMINATION/,
    );
    first.database.close();
    expect(boundary.scheduleCalls).toHaveLength(0);

    // A brand new process, same durable database and same durable authority.
    const restarted = openAutoPosterHarness({ databasePath, boundary, approvalAuthority });
    const resumed = await restarted.service.resumeSafely(created.missionId);
    expect(resumed.status).toBe("succeeded");
    expect(resumed.execution?.state).toBe("completed");
    expect(boundary.scheduleCalls).toHaveLength(1);

    // A duplicate resume/approval must replay durable truth, never re-execute.
    const replayed = await restarted.service.approveAndExecute(created.missionId, APPROVER);
    expect(replayed.execution?.state).toBe("completed");
    expect(replayed.execution?.recoveryClassification).toBe("DURABLE_REPLAY");
    expect(boundary.scheduleCalls).toHaveLength(1);
  });

  it("refuses a restart resume once the persisted approval has expired", async () => {
    const root = temporaryRoot("chanter-approval-restart-expired-");
    const databasePath = path.join(root, "operator.sqlite");
    const approvalAuthority = approvalAuthorityFixture();
    const boundary = makeAutoPosterBoundary();

    let injected = false;
    const first = openAutoPosterHarness({
      databasePath,
      boundary,
      approvalAuthority,
      clock: new FakeTemporalClock(new Date(APPROVAL_MS + 10_000)),
      failureInjector: (name) => {
        if (!injected && name === "after_approval_persistence") {
          injected = true;
          throw new Error("INJECTED_PROCESS_TERMINATION");
        }
      },
    });
    const created = await first.service.createScheduleMission(scheduleInput());
    // The bounded approval is durable *before* the crash, so the restart reads
    // back the same immutable observation rather than publishing a new one.
    expect((await publishBoundedApproval(first, created.missionId)).ok).toBe(true);
    await expect(
      first.service.approveAndExecute(created.missionId, APPROVER),
    ).rejects.toThrow(/INJECTED_PROCESS_TERMINATION/);
    first.database.close();
    const restarted = openAutoPosterHarness({
      databasePath,
      boundary,
      approvalAuthority,
      clock: new FakeTemporalClock(new Date(APPROVAL_MS + 3_600_000)),
    });
    const resumed = await restarted.service.resumeSafely(created.missionId);
    expect(resumed.status).not.toBe("succeeded");
    expect(boundary.scheduleCalls).toHaveLength(0);
  });

  it("keeps unrelated Operator mission behavior unchanged", async () => {
    const root = temporaryRoot("chanter-approval-unrelated-");
    const approvalAuthority = approvalAuthorityFixture();
    const boundary = makeAutoPosterBoundary();
    const { service } = openAutoPosterHarness({
      databasePath: path.join(root, "operator.sqlite"),
      boundary,
      approvalAuthority,
    });

    // Input validation still refuses before anything persists or executes.
    await expect(
      service.createScheduleMission(scheduleInput({ provider: "facebook" })),
    ).rejects.toThrow();
    // Exact duplicate submission still replays instead of creating twice.
    const identified = scheduleInput({
      missionId: "unrelated-behavior-mission",
      idempotencyKey: "unrelated-behavior-key",
    });
    const created = await service.createScheduleMission(identified);
    const replayed = await service.createScheduleMission(identified);
    expect(replayed.missionId).toBe(created.missionId);
    expect(created.status).toBe("approval_required");
    // A blank approver is still a 400 before any authority is published.
    await expect(service.approveAndExecute(created.missionId, "  ")).rejects.toThrow();
    expect(boundary.scheduleCalls).toHaveLength(0);
  });

  it("refuses a non-canonical approver identity rather than binding it", async () => {
    const root = temporaryRoot("chanter-approval-approver-");
    const approvalAuthority = approvalAuthorityFixture();
    const boundary = makeAutoPosterBoundary();
    const { service } = openAutoPosterHarness({
      databasePath: path.join(root, "operator.sqlite"),
      boundary,
      approvalAuthority,
    });

    const created = await service.createScheduleMission(scheduleInput());
    const refused = await service.approveAndExecute(created.missionId, "founder with spaces");

    expect(refused.status).toBe("failed");
    expect(refused.runtimeResult?.errors[0]?.code).toBe(
      "OPERATOR_APPROVAL_APPROVER_ID_NON_CANONICAL",
    );
    expect(boundary.scheduleCalls).toHaveLength(0);
  });

  it("refuses a non-canonical approval expiry before anything is published", async () => {
    const root = temporaryRoot("chanter-approval-expiry-shape-");
    const approvalAuthority = approvalAuthorityFixture();
    const boundary = makeAutoPosterBoundary();
    const harness = openAutoPosterHarness({
      databasePath: path.join(root, "operator.sqlite"),
      boundary,
      approvalAuthority,
    });
    const { service } = harness;

    const created = await service.createScheduleMission(scheduleInput());
    await expect(
      harness.executor.prepareApproval(service.runtimeRequestFor(created.missionId), {
        approverId: APPROVER,
        observedAt: APPROVAL_INSTANT,
        approvalExpiresAt: "2026-08-01T00:01:00Z",
      }),
    ).rejects.toThrow(/canonical UTC instant/);
    expect(boundary.scheduleCalls).toHaveLength(0);
    const store = createDurableIdempotencyStore({ stateDir: approvalAuthority.stateDir });
    expect(store.getApprovalObservation(created.missionId)).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Loop Governor consumer
  // -------------------------------------------------------------------------

  it("executes the Loop Governor consumer only under persisted authority", async () => {
    const root = temporaryRoot("chanter-approval-loop-");
    const approvalAuthority = approvalAuthorityFixture();
    const { port, createCalls } = makeLoopBoundary();
    const { service } = openLoopHarness({
      databasePath: path.join(root, "operator.sqlite"),
      port,
      approvalAuthority,
    });

    const created = await service.createMissionFromEnvelope(loopEnvelope());
    const completed = await service.approveAndExecute(created.missionId, APPROVER);

    expect(completed.status).toBe("succeeded");
    expect(createCalls).toHaveLength(1);
    const store = createDurableIdempotencyStore({ stateDir: approvalAuthority.stateDir });
    const manifest = store.getApprovalCheckpointManifest(created.missionId);
    expect(manifest?.operationId).toBe("loop_governor.task.create_manual_loop");
    expect(store.getApprovalObservation(created.missionId)?.approverId).toBe(APPROVER);

    // Repeated approval replays durable truth without a second downstream loop.
    const replayed = await service.approveAndExecute(created.missionId, APPROVER);
    expect(replayed.execution?.state).toBe("completed");
    expect(createCalls).toHaveLength(1);
  });

  it("refuses the Loop Governor consumer with no persisted authority binding", async () => {
    const root = temporaryRoot("chanter-approval-loop-unbound-");
    const { port, createCalls } = makeLoopBoundary();
    const { service } = openLoopHarness({
      databasePath: path.join(root, "operator.sqlite"),
      port,
    });

    const created = await service.createMissionFromEnvelope(loopEnvelope());
    const refused = await service.approveAndExecute(created.missionId, APPROVER);

    expect(refused.status).toBe("failed");
    expect(refused.runtimeResult?.errors[0]?.code).toBe(
      "OPERATOR_APPROVAL_AUTHORITY_NOT_CONFIGURED",
    );
    expect(createCalls).toHaveLength(0);
  });

  it("refuses an expired Loop Governor approval at the exact boundary", async () => {
    const root = temporaryRoot("chanter-approval-loop-expired-");
    const approvalAuthority = approvalAuthorityFixture();
    const { port, createCalls } = makeLoopBoundary();
    const { service, executor } = openLoopHarness({
      databasePath: path.join(root, "operator.sqlite"),
      port,
      approvalAuthority,
      clock: new FakeTemporalClock(new Date(APPROVAL_MS + 60_000)),
    });

    const created = await service.createMissionFromEnvelope(loopEnvelope());
    const published = await executor.prepareApproval(
      service.runtimeRequestFor(created.missionId),
      {
        approverId: APPROVER,
        observedAt: APPROVAL_INSTANT,
        approvalExpiresAt: new Date(APPROVAL_MS + 60_000).toISOString(),
      },
    );
    expect(published.ok).toBe(true);
    const refused = await service.approveAndExecute(created.missionId, APPROVER);

    expect(refused.status).toBe("denied");
    expect(refused.runtimeResult?.errors[0]?.code).toBe("RUNTIME_APPROVAL_EXPIRED");
    expect(createCalls).toHaveLength(0);
  });
});
