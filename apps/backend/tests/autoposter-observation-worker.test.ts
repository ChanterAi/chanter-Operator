/**
 * Phase 2F-B: autonomous AutoPoster observation worker.
 *
 * Proves the worker itself — disabled mode, bounded interval ticking,
 * in-process overlap prevention, batch-size forwarding, telemetry
 * classification (converged/rescheduled/escalated), error isolation, and
 * clean shutdown — using a stubbed observation-batch runner so these are
 * fast, deterministic, and independent of real timers or SQLite.
 *
 * Business logic (claim/observe/converge/reschedule/escalate correctness,
 * restart-safety, lease recovery) is exhaustively covered by the existing,
 * unmodified tests/autoposter-observation-loop.test.ts and is intentionally
 * NOT re-derived here — the one integration-style test below only proves
 * the worker's tick reaches that real, unmodified machinery automatically,
 * without ever calling the manual /api/autoposter-observations/run route.
 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AutoPosterOperationsPort } from "chanter-agent-runtime";
import { AgentRunLedgerService } from "../src/agentRunLedger/agentRunLedgerService.js";
import { createDatabase } from "../src/db/database.js";
import { GenericMissionService } from "../src/missions/genericMissionService.js";
import { MissionGraphChildDispatcher } from "../src/missions/missionGraphChildDispatcher.js";
import { MissionGraphService } from "../src/missions/missionGraphService.js";
import { createLoopGovernorMissionExecutor } from "../src/missions/loopGovernorRuntime.js";
import { AutoPosterResultProjectionService } from "../src/missions/autoPosterResultProjectionService.js";
import { AutoPosterObservationService } from "../src/missions/autoPosterObservationService.js";
import {
  AutoPosterObservationWorker,
  type AutoPosterObservationWorkerEvent,
} from "../src/missions/autoPosterObservationWorker.js";
import { AutoPosterMissionService } from "../src/runtimeMissions/autoPosterMissionService.js";
import { createAutoPosterRuntimeMissionExecutor } from "../src/runtimeMissions/autoPosterRuntime.js";
import type { AutoPosterObservationBatchResult } from "../src/missions/autoPosterObservationService.js";

const TEST_NOW_MS = Date.now();
const NOW = new Date(TEST_NOW_MS).toISOString();
const REQUESTED_AT = new Date(TEST_NOW_MS + 60_000).toISOString();
const SCHEDULED_AT = new Date(TEST_NOW_MS + 60 * 60_000).toISOString();
const WORKSPACE_ID = "workspace-phase2fb";
const OWNER_ID = "owner";
const TIKTOK_ACCOUNT = "tt-phase2fb";
const RUNTIME_TOKEN = "phase2fb-service-token";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function fakeTimers() {
  const handles: Array<{ handler: () => void; ms: number; cleared: boolean }> = [];
  return {
    setIntervalFn: (handler: () => void, ms: number) => {
      const handle = { handler, ms, cleared: false };
      handles.push(handle);
      return handle as unknown as NodeJS.Timeout;
    },
    clearIntervalFn: (handle: NodeJS.Timeout) => {
      (handle as unknown as { cleared: boolean }).cleared = true;
    },
    fireLatestTick(): void {
      const active = [...handles].reverse().find((h) => !h.cleared);
      active?.handler();
    },
    activeCount(): number {
      return handles.filter((h) => !h.cleared).length;
    },
  };
}

function batchResult(overrides: Partial<AutoPosterObservationBatchResult> = {}): AutoPosterObservationBatchResult {
  return {
    ranAt: NOW,
    leaseOwner: "operator-observation-worker",
    backfilledJobs: 0,
    claimed: 0,
    results: [],
    ...overrides,
  };
}

describe("Phase 2F-B AutoPosterObservationWorker — unit behaviour", () => {
  it("stays fully inert when disabled: no timer, no runObservationBatch call", () => {
    const runObservationBatch = vi.fn();
    const events: AutoPosterObservationWorkerEvent[] = [];
    const timers = fakeTimers();
    const worker = new AutoPosterObservationWorker(
      { runObservationBatch },
      {
        enabled: false,
        pollIntervalMs: 5_000,
        onEvent: (event) => events.push(event),
        setIntervalFn: timers.setIntervalFn,
        clearIntervalFn: timers.clearIntervalFn,
      },
    );
    worker.start();
    expect(timers.activeCount()).toBe(0);
    expect(events).toEqual([{ type: "worker_disabled" }]);
    expect(runObservationBatch).not.toHaveBeenCalled();
  });

  it("rejects invalid poll interval/batch size only when enabled (fail closed at construction)", () => {
    const runObservationBatch = vi.fn();
    expect(() => new AutoPosterObservationWorker(
      { runObservationBatch },
      { enabled: true, pollIntervalMs: 100 },
    )).toThrow(/poll interval/i);
    expect(() => new AutoPosterObservationWorker(
      { runObservationBatch },
      { enabled: true, pollIntervalMs: 5_000, batchSize: 17 },
    )).toThrow(/batch size/i);
    // Disabled: the same invalid values never reach validation at all.
    expect(() => new AutoPosterObservationWorker(
      { runObservationBatch },
      { enabled: false, pollIntervalMs: 100 },
    )).not.toThrow();
  });

  it("an empty due-job tick mutates nothing and reports zeroed telemetry", async () => {
    const runObservationBatch = vi.fn().mockResolvedValue(batchResult());
    const events: AutoPosterObservationWorkerEvent[] = [];
    const timers = fakeTimers();
    const worker = new AutoPosterObservationWorker(
      { runObservationBatch },
      {
        enabled: true,
        pollIntervalMs: 5_000,
        onEvent: (event) => events.push(event),
        setIntervalFn: timers.setIntervalFn,
        clearIntervalFn: timers.clearIntervalFn,
      },
    );
    worker.start();
    timers.fireLatestTick();
    await vi.waitFor(() => expect(events.some((e) => e.type === "run_completed")).toBe(true));
    expect(runObservationBatch).toHaveBeenCalledTimes(1);
    expect(events).toContainEqual({
      type: "run_completed",
      leaseOwner: "operator-observation-worker",
      backfilledJobs: 0,
      claimed: 0,
      processed: 0,
      converged: 0,
      rescheduled: 0,
      escalated: 0,
      failedTerminal: 0,
      durationMs: expect.any(Number),
    });
  });

  it("forwards the configured batch size and lease owner to every run", async () => {
    const runObservationBatch = vi.fn().mockResolvedValue(batchResult());
    const timers = fakeTimers();
    const worker = new AutoPosterObservationWorker(
      { runObservationBatch },
      {
        enabled: true,
        pollIntervalMs: 5_000,
        batchSize: 4,
        leaseOwner: "custom-worker-owner",
        setIntervalFn: timers.setIntervalFn,
        clearIntervalFn: timers.clearIntervalFn,
      },
    );
    worker.start();
    timers.fireLatestTick();
    await vi.waitFor(() => expect(runObservationBatch).toHaveBeenCalledTimes(1));
    expect(runObservationBatch).toHaveBeenCalledWith({ leaseOwner: "custom-worker-owner", batchSize: 4 });
  });

  it("never lets two rapid ticks process concurrently in one process", async () => {
    const gate = deferred<AutoPosterObservationBatchResult>();
    const runObservationBatch = vi.fn().mockReturnValue(gate.promise);
    const events: AutoPosterObservationWorkerEvent[] = [];
    const timers = fakeTimers();
    const worker = new AutoPosterObservationWorker(
      { runObservationBatch },
      {
        enabled: true,
        pollIntervalMs: 5_000,
        onEvent: (event) => events.push(event),
        setIntervalFn: timers.setIntervalFn,
        clearIntervalFn: timers.clearIntervalFn,
      },
    );
    worker.start();
    timers.fireLatestTick(); // first tick: in flight, gated on `gate`
    timers.fireLatestTick(); // second tick while the first hasn't resolved
    expect(runObservationBatch).toHaveBeenCalledTimes(1);
    expect(events).toContainEqual({ type: "run_skipped_overlap" });

    gate.resolve(batchResult());
    await vi.waitFor(() => expect(events.some((e) => e.type === "run_completed")).toBe(true));
    timers.fireLatestTick(); // now that the first run finished, a new tick must run
    await vi.waitFor(() => expect(runObservationBatch).toHaveBeenCalledTimes(2));
  });

  it("classifies converged, rescheduled, and escalated outcomes correctly in telemetry", async () => {
    const runObservationBatch = vi.fn().mockResolvedValue(batchResult({
      claimed: 4,
      backfilledJobs: 1,
      results: [
        { observationJobId: "a", graphId: "g", nodeId: "n1", attemptNumber: 1, outcomeClass: "converged", jobStatus: "converged", projectionStatus: "uploaded_private", reasonCode: "uploaded_private", retryDelaySeconds: null, nextAttemptAt: null, escalationId: null },
        { observationJobId: "b", graphId: "g", nodeId: "n2", attemptNumber: 1, outcomeClass: "continue_observing", jobStatus: "waiting", projectionStatus: "processing", reasonCode: null, retryDelaySeconds: 15, nextAttemptAt: NOW, escalationId: null },
        { observationJobId: "c", graphId: "g", nodeId: "n3", attemptNumber: 1, outcomeClass: "escalation_required", jobStatus: "escalation_required", projectionStatus: "awaiting_publish_approval", reasonCode: "publish_approval_required", retryDelaySeconds: null, nextAttemptAt: null, escalationId: "esc-1" },
        { observationJobId: "d", graphId: "g", nodeId: "n4", attemptNumber: 8, outcomeClass: "failed_terminal", jobStatus: "failed_terminal", projectionStatus: null, reasonCode: "observation_failed_unclassified", retryDelaySeconds: null, nextAttemptAt: null, escalationId: null },
      ],
    }));
    const events: AutoPosterObservationWorkerEvent[] = [];
    const timers = fakeTimers();
    const worker = new AutoPosterObservationWorker(
      { runObservationBatch },
      {
        enabled: true,
        pollIntervalMs: 5_000,
        onEvent: (event) => events.push(event),
        setIntervalFn: timers.setIntervalFn,
        clearIntervalFn: timers.clearIntervalFn,
      },
    );
    worker.start();
    timers.fireLatestTick();
    await vi.waitFor(() => expect(events.some((e) => e.type === "run_completed")).toBe(true));
    const completed = events.find((e) => e.type === "run_completed");
    expect(completed).toMatchObject({
      claimed: 4,
      processed: 4,
      converged: 1,
      rescheduled: 1,
      escalated: 1,
      failedTerminal: 1,
      backfilledJobs: 1,
    });
  });

  it("isolates a thrown/rejected batch run: reports run_failed, never crashes, keeps working afterward", async () => {
    const runObservationBatch = vi.fn()
      .mockRejectedValueOnce(new Error("simulated AutoPoster transport failure"))
      .mockResolvedValueOnce(batchResult());
    const events: AutoPosterObservationWorkerEvent[] = [];
    const timers = fakeTimers();
    const worker = new AutoPosterObservationWorker(
      { runObservationBatch },
      {
        enabled: true,
        pollIntervalMs: 5_000,
        onEvent: (event) => events.push(event),
        setIntervalFn: timers.setIntervalFn,
        clearIntervalFn: timers.clearIntervalFn,
      },
    );
    worker.start();
    timers.fireLatestTick();
    await vi.waitFor(() => expect(events.some((e) => e.type === "run_failed")).toBe(true));
    expect(events).toContainEqual({
      type: "run_failed",
      leaseOwner: "operator-observation-worker",
      error: "simulated AutoPoster transport failure",
      durationMs: expect.any(Number),
    });
    // The worker must still be usable after a failure: no crash, no stuck "ticking" flag.
    timers.fireLatestTick();
    await vi.waitFor(() => expect(runObservationBatch).toHaveBeenCalledTimes(2));
    await expect(worker.stop()).resolves.toBeUndefined();
  });

  it("stops cleanly: clears the timer, waits for the in-flight run, emits worker_stopped, and never ticks again", async () => {
    const gate = deferred<AutoPosterObservationBatchResult>();
    const runObservationBatch = vi.fn().mockReturnValueOnce(gate.promise).mockResolvedValue(batchResult());
    const events: AutoPosterObservationWorkerEvent[] = [];
    const timers = fakeTimers();
    const worker = new AutoPosterObservationWorker(
      { runObservationBatch },
      {
        enabled: true,
        pollIntervalMs: 5_000,
        onEvent: (event) => events.push(event),
        setIntervalFn: timers.setIntervalFn,
        clearIntervalFn: timers.clearIntervalFn,
      },
    );
    worker.start();
    timers.fireLatestTick();

    let stopped = false;
    const stopPromise = worker.stop().then(() => { stopped = true; });
    expect(stopped).toBe(false); // must not resolve while the run is still in flight
    gate.resolve(batchResult());
    await stopPromise;
    expect(stopped).toBe(true);
    expect(events).toContainEqual({ type: "worker_stopped" });
    expect(timers.activeCount()).toBe(0);

    timers.fireLatestTick(); // the timer is cleared, so this must be a no-op
    expect(runObservationBatch).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Integration-style: the worker's tick reaches the real, unmodified
// AutoPosterObservationService end to end, automatically, without ever
// calling the manual batch endpoint.
// ---------------------------------------------------------------------------

interface FakeAutoPosterBoundary {
  port: AutoPosterOperationsPort;
  scheduleCalls: number;
}

function connectedAccount() {
  return {
    connectedAccountId: `tiktok:${TIKTOK_ACCOUNT}`,
    accountId: TIKTOK_ACCOUNT,
    provider: "tiktok" as const,
    providerDisplayName: "TikTok",
    username: "phase2fb_tiktok",
    displayName: "Phase 2F-B Account",
    connectionStatus: "connected" as const,
    publishingReady: true,
    readinessBlockers: [],
    lastVerifiedAt: NOW,
  };
}

function makeAutoPosterBoundary(): FakeAutoPosterBoundary {
  const jobs = new Map<string, { id: string; accountId: string; provider: "tiktok"; scheduledAt: string; missionId: string; idempotencyKey: string; action: string; missionPayloadHash: string }>();
  const boundary: FakeAutoPosterBoundary = { scheduleCalls: 0, port: undefined as unknown as AutoPosterOperationsPort };
  boundary.port = {
    async listConnectedAccounts(params) {
      return { ok: true, workspaceId: params.workspaceId, accounts: [connectedAccount()], count: 1 };
    },
    async validateConnectedAccount(params) {
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
          username: "phase2fb",
          workspaceId: params.workspaceId ?? WORKSPACE_ID,
          status: "scheduled",
          scheduledAt: job.scheduledAt,
          approved: false,
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
      return { ok: true, valid: true, classification: "video", policy: { videoOnly: true, allowedExtensions: [".mp4"] } };
    },
    async schedulePost(params) {
      boundary.scheduleCalls += 1;
      const existing = jobs.get(params.idempotencyKey);
      const asPost = (job: typeof existing extends undefined ? never : NonNullable<typeof existing>) => ({
        id: job.id, accountId: job.accountId, provider: job.provider, status: "scheduled", scheduledAt: job.scheduledAt, approved: false,
      });
      if (existing) return { ok: true, duplicate: true, post: asPost(existing) };
      const job = {
        id: "phase2fb-queue-draft-0001",
        accountId: params.accountId,
        provider: (params.provider ?? "tiktok") as "tiktok",
        scheduledAt: params.scheduledAt,
        idempotencyKey: params.idempotencyKey,
        missionId: params.missionId,
        action: params.action,
        missionPayloadHash: params.missionPayloadHash,
      };
      jobs.set(params.idempotencyKey, job);
      return { ok: true, duplicate: false, post: asPost(job) };
    },
    async reconcileSchedule() {
      return { ok: true, outcome: "not_found", count: 0, unique: true, safeToReuse: false, approvalState: "not_started", publishingState: "not_started", evidenceStatus: "not_found" };
    },
  };
  return boundary;
}

const temporaryRoots: string[] = [];
const activeDatabases = new Set<DatabaseSync>();
afterEach(() => {
  for (const database of [...activeDatabases]) database.close();
  activeDatabases.clear();
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function realHarness() {
  const root = mkdtempSync(path.join(os.tmpdir(), "chanter-phase2fb-worker-"));
  temporaryRoots.push(root);
  const database = createDatabase(path.join(root, "operator.sqlite"));
  activeDatabases.add(database);
  const boundary = makeAutoPosterBoundary();
  const ledger = new AgentRunLedgerService(database, []);
  // A controllable, advanceable clock (never real wall-clock waiting): a
  // freshly scheduled observation job's next_attempt_at is now()+15s (the
  // first bounded retry delay), so the test must advance past it before a
  // tick can find the job due — exactly the existing harness pattern in
  // tests/autoposter-observation-loop.test.ts.
  let clockMs = TEST_NOW_MS;
  const now = () => new Date(clockMs);
  const executor = createAutoPosterRuntimeMissionExecutor(
    { baseUrl: "https://autoposter.phase2fb.test", serviceToken: RUNTIME_TOKEN, userId: OWNER_ID, timeoutValid: true },
    { port: boundary.port },
  );
  const autoPoster = new AutoPosterMissionService(database, executor, { agentRunLedgerService: ledger, now });
  const generic = new GenericMissionService(
    database,
    createLoopGovernorMissionExecutor(
      { pythonExecutable: "", governorRoot: "", dataDir: "", timeoutValid: true },
      { port: { async createManualLoop() { return { ok: true, created: true, taskId: "t", loopId: "l", realAgentExecution: false }; }, async lookupManualLoop() { return { ok: true, outcome: "not_found", binding: null }; } } },
    ),
    { agentRunLedgerService: ledger, now },
  );
  const results = new AutoPosterResultProjectionService(database, executor, { now });
  const observation = new AutoPosterObservationService(database, results, { now });
  const graphs = new MissionGraphService(
    database,
    new MissionGraphChildDispatcher(generic, autoPoster),
    { now, observationScheduler: observation },
  );
  return {
    graphs,
    observation,
    boundary,
    advanceSeconds(seconds: number): void {
      clockMs += seconds * 1_000;
    },
  };
}

function scheduleGraphEnvelope() {
  return {
    schemaVersion: "chanter.mission.graph.v1",
    graphId: "phase2fb-worker-graph",
    traceId: "phase2fb-worker-graph-trace",
    idempotencyKey: "phase2fb-worker-graph-key",
    source: { system: "operator", requestedBy: "founder-phase2fb" },
    objective: "Schedule the bounded AutoPoster draft for the observation worker proof.",
    tenant: { userId: OWNER_ID, workspaceId: WORKSPACE_ID },
    nodes: [{
      nodeId: "tiktok_node",
      target: { product: "auto_poster", action: "autoposter.post.schedule" },
      objective: "Create the tiktok unapproved queue draft.",
      input: {
        accountId: TIKTOK_ACCOUNT,
        provider: "tiktok",
        mediaUrl: "https://cdn.example.com/phase2fb-worker.mp4",
        caption: "Phase 2F-B worker proof",
        hashtags: "#chanter #phase2fb",
        scheduledAt: SCHEDULED_AT,
      },
      dependsOn: [],
    }],
    requestedAt: REQUESTED_AT,
  };
}

describe("Phase 2F-B AutoPosterObservationWorker — real service integration", () => {
  it("automatically claims and processes a due observation job without calling the manual batch endpoint", async () => {
    const { graphs, observation, boundary, advanceSeconds } = realHarness();
    const submitted = graphs.submitGraph(scheduleGraphEnvelope());
    const completed = await graphs.approveGraph(submitted.graphId, {
      approvedBy: "founder-phase2fb",
      graphHash: submitted.graphHash,
    });
    expect(completed.status).toBe("completed");
    expect(boundary.scheduleCalls).toBe(1);

    const beforeTick = observation.listJobs({ graphId: submitted.graphId });
    expect(beforeTick.jobs).toHaveLength(1);
    expect(beforeTick.jobs[0]?.status).toBe("pending");
    expect(beforeTick.jobs[0]?.attemptCount).toBe(0);

    // The freshly scheduled job's first attempt isn't due for 15s (the
    // reviewed first bounded retry delay); advance the fake clock past it
    // so the worker's tick finds it due, exactly as real elapsed time would.
    advanceSeconds(16);

    const events: AutoPosterObservationWorkerEvent[] = [];
    const timers = fakeTimers();
    const worker = new AutoPosterObservationWorker(
      observation,
      {
        enabled: true,
        pollIntervalMs: 5_000,
        onEvent: (event) => events.push(event),
        setIntervalFn: timers.setIntervalFn,
        clearIntervalFn: timers.clearIntervalFn,
      },
    );
    // The worker is started and ticked directly — the manual
    // POST /api/autoposter-observations/run route is never invoked anywhere
    // in this test.
    worker.start();
    timers.fireLatestTick();
    await vi.waitFor(() => expect(events.some((e) => e.type === "run_completed")).toBe(true));

    const afterTick = observation.listJobs({ graphId: submitted.graphId });
    expect(afterTick.jobs[0]?.attemptCount).toBe(1);
    expect(afterTick.jobs[0]?.status).not.toBe("pending");

    const runCompleted = events.find((e) => e.type === "run_completed");
    expect(runCompleted).toMatchObject({ claimed: 1, processed: 1 });

    await worker.stop();
  });
});
