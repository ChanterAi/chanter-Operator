/**
 * Phase 2F-A: unified AutoPoster mission ingress.
 *
 * Proves that the new MCP-facing intake adapter (AutoPosterGraphIntakeService)
 * compiles a flat AutoPoster schedule intent into exactly one durable,
 * approval-required mission graph node, that nothing executes before an
 * independent control-token approval bound to the exact graph hash, that the
 * approved graph dispatches through the existing AutoPosterMissionService
 * child lane, that exact replay is idempotent while a changed payload under
 * the same identity is rejected, that identity survives a process restart,
 * that the route-level capability-token isolation matches every other
 * submission endpoint, and that the existing Phase 2E-C observation hook
 * still fires for a graph reached through this new front door.
 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import type {
  AutoPosterOperationsPort,
  AutoPosterScheduleParams,
} from "chanter-agent-runtime";
import { AgentRunLedgerService } from "../src/agentRunLedger/agentRunLedgerService.js";
import { AuditLogger } from "../src/audit/auditLogger.js";
import { createApp } from "../src/app.js";
import { createDatabase } from "../src/db/database.js";
import { AutoPosterGraphIntakeService } from "../src/missions/autoPosterGraphIntake.js";
import { AutoPosterObservationService } from "../src/missions/autoPosterObservationService.js";
import { AutoPosterResultProjectionService } from "../src/missions/autoPosterResultProjectionService.js";
import { GenericMissionService } from "../src/missions/genericMissionService.js";
import { MissionGraphChildDispatcher } from "../src/missions/missionGraphChildDispatcher.js";
import { missionGraphChildMissionId } from "../src/missions/missionGraphCompiler.js";
import { MissionGraphService } from "../src/missions/missionGraphService.js";
import { createLoopGovernorMissionExecutor } from "../src/missions/loopGovernorRuntime.js";
import { MockRunner } from "../src/runners/mockRunner.js";
import { AutoPosterMissionService } from "../src/runtimeMissions/autoPosterMissionService.js";
import { createAutoPosterRuntimeMissionExecutor } from "../src/runtimeMissions/autoPosterRuntime.js";
import { OperatorService } from "../src/services/operatorService.js";
import { ensureWorkspace } from "../src/workspace/pathGuard.js";

const TEST_NOW_MS = Date.now();
const NOW = new Date(TEST_NOW_MS).toISOString();
const SCHEDULED_AT = new Date(TEST_NOW_MS + 60 * 60_000).toISOString();
const WORKSPACE_ID = "workspace-phase2f-a";
const OWNER_ID = "owner";
const TIKTOK_ACCOUNT = "tt-phase2fa";
const RUNTIME_TOKEN = "phase2fa-service-token";
// These must match tests/setup.ts, which seeds process.env before any test
// file's imports run.
const SUBMIT_TOKEN = "test-mission-submit-token";
const CONTROL_TOKEN = "test-operator-control-token";

interface QueueDraft {
  id: string;
  accountId: string;
  provider: "tiktok" | "youtube";
  status: "scheduled";
  scheduledAt: string;
  approved: false;
  idempotencyKey: string;
  missionId: string;
  action: string;
  missionPayloadHash: string;
}

interface FakeAutoPosterBoundary {
  port: AutoPosterOperationsPort;
  jobs: Map<string, QueueDraft>;
  scheduleCalls: AutoPosterScheduleParams[];
  providerPublishCalls: number;
}

function connectedAccount() {
  return {
    connectedAccountId: `tiktok:${TIKTOK_ACCOUNT}`,
    accountId: TIKTOK_ACCOUNT,
    provider: "tiktok" as const,
    providerDisplayName: "TikTok",
    username: "phase2fa_tiktok",
    displayName: "Phase 2F-A Account",
    connectionStatus: "connected" as const,
    publishingReady: true,
    readinessBlockers: [],
    lastVerifiedAt: NOW,
  };
}

function makeAutoPosterBoundary(): FakeAutoPosterBoundary {
  const jobs = new Map<string, QueueDraft>();
  const scheduleCalls: AutoPosterScheduleParams[] = [];
  const boundary: FakeAutoPosterBoundary = {
    jobs,
    scheduleCalls,
    providerPublishCalls: 0,
    port: undefined as unknown as AutoPosterOperationsPort,
  };
  boundary.port = {
    async listConnectedAccounts(params) {
      const accounts = [connectedAccount()];
      return { ok: true, workspaceId: params.workspaceId, accounts, count: accounts.length };
    },
    async validateConnectedAccount(params) {
      if (params.accountId !== TIKTOK_ACCOUNT || params.provider !== "tiktok") {
        return {
          ok: false,
          code: "conflict",
          reasonCode: "unknown_account_id",
          message: "The selected account is not connected.",
        };
      }
      return { ok: true, workspaceId: params.workspaceId ?? WORKSPACE_ID, account: connectedAccount() };
    },
    async listQueue() {
      return { ok: true, items: [], count: 0, scope: { accountId: "all" } };
    },
    async getPostStatus(params) {
      const job = [...jobs.values()].find((candidate) => candidate.id === params.postId);
      if (!job) return { ok: false, code: "not_found", message: "not found" };
      return {
        ok: true,
        post: {
          id: job.id,
          provider: job.provider,
          connectedAccountId: `${job.provider}:${job.accountId}`,
          accountId: job.accountId,
          username: "phase2fa",
          workspaceId: params.workspaceId ?? WORKSPACE_ID,
          status: job.status,
          scheduledAt: job.scheduledAt,
          approved: job.approved,
          approvalState: "unapproved",
          approvedAt: null,
          approvedBy: "",
          mediaType: "video",
          captionSummary: "",
          createdAt: NOW,
          updatedAt: NOW,
          postedAt: null,
          publishId: "",
          providerStatus: "",
          lockedAt: null,
          claimAttempts: 0,
          runtimeMissionId: job.missionId,
          runtimeIdempotencyKey: job.idempotencyKey,
          runtimeAction: job.action,
          runtimePayloadHash: job.missionPayloadHash,
          lastResult: null,
          history: [],
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
      const existing = jobs.get(params.idempotencyKey);
      if (existing) return { ok: true, duplicate: true, post: existing };
      const job: QueueDraft = {
        id: `queue-draft-${jobs.size + 1}`,
        accountId: params.accountId,
        provider: params.provider ?? "tiktok",
        status: "scheduled",
        scheduledAt: params.scheduledAt,
        approved: false,
        idempotencyKey: params.idempotencyKey,
        missionId: params.missionId,
        action: params.action,
        missionPayloadHash: params.missionPayloadHash,
      };
      jobs.set(params.idempotencyKey, job);
      return { ok: true, duplicate: false, post: job };
    },
    async reconcileSchedule() {
      return {
        ok: true,
        outcome: "not_found",
        count: 0,
        unique: true,
        safeToReuse: false,
        approvalState: "not_started",
        publishingState: "not_started",
        evidenceStatus: "not_found",
      };
    },
  };
  return boundary;
}

function loopPort() {
  return {
    async createManualLoop() {
      return { ok: true, created: true, taskId: "phase2fa-task", loopId: "phase2fa-loop", realAgentExecution: false };
    },
    async lookupManualLoop() {
      return { ok: true, outcome: "not_found", binding: null };
    },
  };
}

interface Harness {
  database: DatabaseSync;
  databasePath: string;
  intake: AutoPosterGraphIntakeService;
  graphs: MissionGraphService;
  autoPoster: AutoPosterMissionService;
  observation: AutoPosterObservationService;
  app: express.Express;
  close(): void;
}

const temporaryRoots: string[] = [];
const activeHarnesses = new Set<Harness>();

afterEach(() => {
  for (const harness of [...activeHarnesses]) harness.close();
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function createHarness(
  boundary: FakeAutoPosterBoundary,
  databasePath?: string,
  intakeNow: () => Date = () => new Date(NOW),
): Harness {
  const root = databasePath
    ? path.dirname(databasePath)
    : mkdtempSync(path.join(os.tmpdir(), "chanter-phase2fa-intake-"));
  if (!databasePath) temporaryRoots.push(root);
  const resolvedPath = databasePath ?? path.join(root, "operator.sqlite");
  const database = createDatabase(resolvedPath);
  const ledger = new AgentRunLedgerService(database, []);
  const executor = createAutoPosterRuntimeMissionExecutor(
    {
      baseUrl: "https://autoposter.phase2fa.test",
      serviceToken: RUNTIME_TOKEN,
      userId: OWNER_ID,
      timeoutValid: true,
    },
    { port: boundary.port },
  );
  const autoPoster = new AutoPosterMissionService(database, executor, {
    agentRunLedgerService: ledger,
    now: () => new Date(NOW),
  });
  const generic = new GenericMissionService(
    database,
    createLoopGovernorMissionExecutor(
      { pythonExecutable: "", governorRoot: "", dataDir: "", timeoutValid: true },
      { port: loopPort() },
    ),
    { agentRunLedgerService: ledger, now: () => new Date(NOW) },
  );
  const results = new AutoPosterResultProjectionService(database, executor, { now: () => new Date(NOW) });
  const observation = new AutoPosterObservationService(database, results, { now: () => new Date(NOW) });
  const graphs = new MissionGraphService(
    database,
    new MissionGraphChildDispatcher(generic, autoPoster),
    { now: () => new Date(NOW), observationScheduler: observation },
  );
  const intake = new AutoPosterGraphIntakeService(graphs, autoPoster, executor, intakeNow);
  const operatorService = new OperatorService(
    database,
    new AuditLogger(path.join(root, "data", "audit.jsonl")),
    new MockRunner(),
    ensureWorkspace(path.join(root, "workspace")),
  );
  const app = express();
  app.use(createApp(operatorService, autoPoster, ledger, generic, graphs, results, observation, undefined, intake));

  let closed = false;
  const harness: Harness = {
    database,
    databasePath: resolvedPath,
    intake,
    graphs,
    autoPoster,
    observation,
    app,
    close: () => {
      if (closed) return;
      closed = true;
      database.close();
      activeHarnesses.delete(harness);
    },
  };
  activeHarnesses.add(harness);
  return harness;
}

function scheduleBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    accountId: TIKTOK_ACCOUNT,
    provider: "tiktok",
    mediaUrl: "https://cdn.example.com/phase2fa.mp4",
    caption: "Phase 2F-A intake proof",
    hashtags: "#chanter #phase2fa",
    scheduledAt: SCHEDULED_AT,
    idempotencyKey: "phase2fa-key-0001",
    requestedBy: "chanter-mcp-server",
    ...overrides,
  };
}

describe("Phase 2F-A AutoPoster graph intake — durable submission and dispatch", () => {
  it("compiles one node, stays approval_required with zero execution, then dispatches on approval", async () => {
    const boundary = makeAutoPosterBoundary();
    const harness = createHarness(boundary);

    const submitted = await harness.intake.submitScheduleIntent(scheduleBody());
    expect(submitted.graph.status).toBe("approval_required");
    expect(submitted.graph.nodeCount).toBe(1);
    expect(submitted.graph.approvedBy).toBeNull();
    expect(submitted.childMission).toBeNull();
    expect(boundary.scheduleCalls).toHaveLength(0);
    expect(boundary.jobs.size).toBe(0);
    expect(submitted.childMissionId).toBe(
      missionGraphChildMissionId(submitted.graph.graphId, "autoposter_schedule"),
    );

    const approved = await harness.graphs.approveGraph(submitted.graph.graphId, {
      approvedBy: "founder-phase2fa",
      graphHash: submitted.graph.graphHash,
    });
    expect(approved.status).toBe("completed");
    expect(boundary.scheduleCalls).toHaveLength(1);
    expect(boundary.jobs.size).toBe(1);

    const replay = await harness.intake.submitScheduleIntent(scheduleBody());
    expect(replay.graph.replayed).toBe(true);
    expect(replay.graph.graphId).toBe(submitted.graph.graphId);
    expect(replay.childMission).not.toBeNull();
    expect(replay.childMission?.runtimeResult?.status).toMatch(/succeeded|duplicate/);
    expect(boundary.scheduleCalls).toHaveLength(1);
  });

  it("stays replay-stable under a real advancing clock (requestedAt must not drift between submissions)", async () => {
    // requestedAt is part of the compiled/hashed graph content. A naive
    // intake that mints a fresh wall-clock requestedAt on every call would
    // make an otherwise byte-identical replay hash differently from the
    // original submission and be rejected as a false payload mismatch —
    // this test uses a real, monotonically advancing clock (never fixed) to
    // catch exactly that regression.
    const boundary = makeAutoPosterBoundary();
    const harness = createHarness(boundary, undefined, () => new Date());
    const body = scheduleBody({ idempotencyKey: "phase2fa-advancing-clock-key" });

    const first = await harness.intake.submitScheduleIntent(body);
    expect(first.graph.status).toBe("approval_required");

    await new Promise((resolve) => setTimeout(resolve, 5));
    const replay = await harness.intake.submitScheduleIntent(body);
    expect(replay.graph.replayed).toBe(true);
    expect(replay.graph.graphId).toBe(first.graph.graphId);
    expect(replay.graph.graphHash).toBe(first.graph.graphHash);
  });

  it("resolves workspaceId automatically when the caller omits it (auto-discovery parity with the legacy path)", async () => {
    const boundary = makeAutoPosterBoundary();
    const harness = createHarness(boundary);
    const submitted = await harness.intake.submitScheduleIntent(scheduleBody());
    expect(submitted.graph.tenant.workspaceId).toBe(WORKSPACE_ID);
  });

  it("rejects an unknown/disconnected account before any durable write", async () => {
    const boundary = makeAutoPosterBoundary();
    const harness = createHarness(boundary);
    await expect(
      harness.intake.submitScheduleIntent(scheduleBody({ accountId: "not-connected" })),
    ).rejects.toMatchObject({ code: "unknown_account_id" });
    expect(boundary.scheduleCalls).toHaveLength(0);
  });

  it("rejects a changed payload replayed under the same idempotency key", async () => {
    const boundary = makeAutoPosterBoundary();
    const harness = createHarness(boundary);
    await harness.intake.submitScheduleIntent(scheduleBody());
    await expect(
      harness.intake.submitScheduleIntent(scheduleBody({ caption: "a different caption" })),
    ).rejects.toMatchObject({ code: "OPERATOR_GRAPH_PAYLOAD_MISMATCH" });
  });

  it("preserves identity and result truth across a full process restart", async () => {
    const boundary = makeAutoPosterBoundary();
    let harness = createHarness(boundary);
    const submitted = await harness.intake.submitScheduleIntent(scheduleBody({ idempotencyKey: "phase2fa-restart-key" }));
    await harness.graphs.approveGraph(submitted.graph.graphId, {
      approvedBy: "founder-phase2fa",
      graphHash: submitted.graph.graphHash,
    });
    const databasePath = harness.databasePath;
    harness.close();

    harness = createHarness(boundary, databasePath);
    const replay = await harness.intake.submitScheduleIntent(scheduleBody({ idempotencyKey: "phase2fa-restart-key" }));
    expect(replay.graph.replayed).toBe(true);
    expect(replay.graph.graphId).toBe(submitted.graph.graphId);
    expect(replay.childMission?.runtimeResult).not.toBeNull();
    expect(boundary.scheduleCalls).toHaveLength(1);
  });

  it("creates a Phase 2E-C observation job once the node completes", async () => {
    const boundary = makeAutoPosterBoundary();
    const harness = createHarness(boundary);
    const submitted = await harness.intake.submitScheduleIntent(scheduleBody({ idempotencyKey: "phase2fa-observe-key" }));
    await harness.graphs.approveGraph(submitted.graph.graphId, {
      approvedBy: "founder-phase2fa",
      graphHash: submitted.graph.graphHash,
    });
    const jobs = harness.observation.listJobs({ graphId: submitted.graph.graphId });
    expect(jobs.jobs.length).toBeGreaterThan(0);
    expect(jobs.jobs[0]?.nodeId).toBe("autoposter_schedule");
  });
});

describe("Phase 2F-A AutoPoster graph intake — route-level capability isolation", () => {
  it("rejects submission with no token and with the wrong (control) token", async () => {
    const harness = createHarness(makeAutoPosterBoundary());
    const noToken = await request(harness.app)
      .post("/api/mission-graphs/autoposter-schedule")
      .send(scheduleBody());
    expect(noToken.status).toBe(401);

    const wrongToken = await request(harness.app)
      .post("/api/mission-graphs/autoposter-schedule")
      .set("Authorization", `Bearer ${CONTROL_TOKEN}`)
      .send(scheduleBody());
    expect(wrongToken.status).toBe(401);
  });

  it("accepts the submit token: 201 on first submission, 200 on exact replay", async () => {
    const harness = createHarness(makeAutoPosterBoundary());
    const first = await request(harness.app)
      .post("/api/mission-graphs/autoposter-schedule")
      .set("Authorization", `Bearer ${SUBMIT_TOKEN}`)
      .send(scheduleBody({ idempotencyKey: "phase2fa-http-key" }));
    expect(first.status).toBe(201);
    expect(first.body.graph.status).toBe("approval_required");

    const replay = await request(harness.app)
      .post("/api/mission-graphs/autoposter-schedule")
      .set("Authorization", `Bearer ${SUBMIT_TOKEN}`)
      .send(scheduleBody({ idempotencyKey: "phase2fa-http-key" }));
    expect(replay.status).toBe(200);
    expect(replay.body.graph.graphId).toBe(first.body.graph.graphId);
  });

  it("never allows the submit token to approve the graph it created", async () => {
    const harness = createHarness(makeAutoPosterBoundary());
    const submitted = await request(harness.app)
      .post("/api/mission-graphs/autoposter-schedule")
      .set("Authorization", `Bearer ${SUBMIT_TOKEN}`)
      .send(scheduleBody({ idempotencyKey: "phase2fa-noapprove-key" }));
    expect(submitted.status).toBe(201);

    const approveAttempt = await request(harness.app)
      .post(`/api/mission-graphs/${submitted.body.graph.graphId}/approve`)
      .set("Authorization", `Bearer ${SUBMIT_TOKEN}`)
      .send({ approvedBy: "mcp-client", graphHash: submitted.body.graph.graphHash });
    expect(approveAttempt.status).toBe(401);
  });
});
