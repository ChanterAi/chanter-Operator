/**
 * Phase 2E-C: autonomous AutoPoster result observation, convergence, and
 * escalation.
 *
 * Proves automatic idempotent observation-job scheduling on durable node
 * completion (plus deterministic backfill after an interrupted hook),
 * atomic lease-based claiming with safe recovery, the exact bounded backoff
 * policy, deterministic outcome classification (continue / converged /
 * escalation / terminal / transport retry with window exhaustion), durable
 * one-per-job escalations with control-authority acknowledge/resolve,
 * restart and crash safety around every persistence boundary, workspace and
 * graph isolation, fail-closed handling of malformed provider truth,
 * capability isolation of the whole observation surface, and full backward
 * compatibility of the Phase 2E-B manual refresh.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import type {
  AutoPosterOperationsPort,
  AutoPosterPortFailure,
  AutoPosterPostStatusParams,
  AutoPosterPostStatusView,
  AutoPosterScheduleParams,
} from "chanter-agent-runtime";
import { AuditLogger } from "../src/audit/auditLogger.js";
import { AgentRunLedgerService } from "../src/agentRunLedger/agentRunLedgerService.js";
import { createApp } from "../src/app.js";
import { createDatabase, migrateAutoPosterObservationTables } from "../src/db/database.js";
import {
  AutoPosterObservationService,
  DEFAULT_OBSERVATION_POLICY,
  type AutoPosterObservationPolicy,
} from "../src/missions/autoPosterObservationService.js";
import { AutoPosterResultProjectionService } from "../src/missions/autoPosterResultProjectionService.js";
import { GenericMissionService } from "../src/missions/genericMissionService.js";
import { MissionGraphChildDispatcher } from "../src/missions/missionGraphChildDispatcher.js";
import { MissionGraphService } from "../src/missions/missionGraphService.js";
import { createLoopGovernorMissionExecutor } from "../src/missions/loopGovernorRuntime.js";
import { MockRunner } from "../src/runners/mockRunner.js";
import { AutoPosterMissionService } from "../src/runtimeMissions/autoPosterMissionService.js";
import { createAutoPosterRuntimeMissionExecutor } from "../src/runtimeMissions/autoPosterRuntime.js";
import { OperatorService } from "../src/services/operatorService.js";
import { ensureWorkspace } from "../src/workspace/pathGuard.js";

const TEST_NOW_MS = Date.parse("2026-07-17T09:00:00.000Z");
const NOW = new Date(TEST_NOW_MS).toISOString();
const REQUESTED_AT = new Date(TEST_NOW_MS + 60_000).toISOString();
const TIKTOK_AT = new Date(TEST_NOW_MS + 2 * 60 * 60_000).toISOString();
const YOUTUBE_AT = new Date(TEST_NOW_MS + 3 * 60 * 60_000).toISOString();
const WORKSPACE_ID = "workspace-phase2ec";
const OWNER_ID = "owner";
const TIKTOK_ACCOUNT = "tt-account";
const YOUTUBE_ACCOUNT = "UC-phase2ec";
const CONTROL_TOKEN = "test-operator-control-token";
const SUBMIT_TOKEN = "test-mission-submit-token";
const LEDGER_TOKEN = "test-ledger-ingest-token";
const RUNTIME_TOKEN = "phase2ec-service-token";
const OBSERVATION_SCHEMA_VERSION = "chanter.autoposter.observation.v1";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sourceRevision(minutes: number): string {
  return new Date(TEST_NOW_MS + minutes * 60_000).toISOString();
}

interface QueueDraft {
  id: string;
  accountId: string;
  provider: "tiktok" | "youtube";
  workspaceId: string;
  scheduledAt: string;
  idempotencyKey: string;
  missionId: string;
  action: string;
  missionPayloadHash: string;
}

interface Boundary {
  port: AutoPosterOperationsPort;
  jobs: Map<string, QueueDraft>;
  scheduleCalls: AutoPosterScheduleParams[];
  statusCalls: AutoPosterPostStatusParams[];
  statusViews: Map<string, AutoPosterPostStatusView>;
  statusFailures: Map<string, AutoPosterPortFailure>;
  jobByNode(nodeId: string, graphId?: string): QueueDraft;
  defaultView(job: QueueDraft): AutoPosterPostStatusView;
  setStatus(postId: string, overrides: Partial<AutoPosterPostStatusView>): void;
}

function connectedAccount(provider: "tiktok" | "youtube", accountId: string) {
  return {
    connectedAccountId: `${provider}:${accountId}`,
    accountId,
    provider,
    providerDisplayName: provider === "youtube" ? "YouTube" : "TikTok",
    username: `phase2ec_${provider}`,
    displayName: "Phase 2E-C Account",
    connectionStatus: "connected" as const,
    publishingReady: true,
    readinessBlockers: [],
    lastVerifiedAt: NOW,
  };
}

function makeBoundary(): Boundary {
  const jobs = new Map<string, QueueDraft>();
  const scheduleCalls: AutoPosterScheduleParams[] = [];
  const statusCalls: AutoPosterPostStatusParams[] = [];
  const statusViews = new Map<string, AutoPosterPostStatusView>();
  const statusFailures = new Map<string, AutoPosterPortFailure>();

  const boundary: Boundary = {
    jobs,
    scheduleCalls,
    statusCalls,
    statusViews,
    statusFailures,
    port: undefined as unknown as AutoPosterOperationsPort,
    jobByNode(nodeId, graphId = "phase2ec-graph") {
      const job = [...jobs.values()].find(
        (candidate) => candidate.missionId === `graph:${graphId}:node:${nodeId}`,
      );
      if (!job) throw new Error(`no queue job bound to ${graphId}/${nodeId}`);
      return job;
    },
    defaultView(job) {
      return {
        id: job.id,
        provider: job.provider,
        connectedAccountId: `${job.provider}:${job.accountId}`,
        accountId: job.accountId,
        username: `phase2ec_${job.provider}`,
        workspaceId: job.workspaceId,
        status: "scheduled",
        scheduledAt: job.scheduledAt,
        approved: false,
        approvalState: "unapproved",
        approvedAt: null,
        approvedBy: "",
        mediaType: "video",
        captionSummary: "",
        createdAt: NOW,
        updatedAt: sourceRevision(0),
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
      };
    },
    setStatus(postId, overrides) {
      const job = [...jobs.values()].find((candidate) => candidate.id === postId);
      if (!job) throw new Error(`no queue job ${postId}`);
      const current = statusViews.get(postId) ?? boundary.defaultView(job);
      statusViews.set(postId, { ...current, ...overrides });
    },
  };

  boundary.port = {
    async listConnectedAccounts(params) {
      const accounts = [
        connectedAccount("tiktok", TIKTOK_ACCOUNT),
        connectedAccount("youtube", YOUTUBE_ACCOUNT),
      ];
      return { ok: true, workspaceId: params.workspaceId ?? WORKSPACE_ID, accounts, count: accounts.length };
    },
    async validateConnectedAccount(params) {
      return {
        ok: true,
        workspaceId: params.workspaceId ?? WORKSPACE_ID,
        account: connectedAccount(params.provider as "tiktok" | "youtube", params.accountId),
      };
    },
    async listQueue() {
      return { ok: true, items: [], count: 0, scope: { accountId: "all" } };
    },
    async getPostStatus(params) {
      statusCalls.push(params);
      const failure = statusFailures.get(params.postId);
      if (failure) return failure;
      const job = [...jobs.values()].find((candidate) => candidate.id === params.postId);
      if (!job) return { ok: false, code: "not_found", message: "not found" };
      return { ok: true, post: statusViews.get(params.postId) ?? boundary.defaultView(job) };
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
      const asPost = (job: QueueDraft) => ({
        id: job.id,
        accountId: job.accountId,
        provider: job.provider,
        status: "scheduled",
        scheduledAt: job.scheduledAt,
        approved: false,
      });
      if (existing) return { ok: true, duplicate: true, post: asPost(existing) };
      const job: QueueDraft = {
        id: `queue-draft-${jobs.size + 1}`,
        accountId: params.accountId,
        provider: (params.provider ?? "tiktok") as "tiktok" | "youtube",
        workspaceId: params.workspaceId ?? WORKSPACE_ID,
        scheduledAt: params.scheduledAt,
        idempotencyKey: params.idempotencyKey,
        missionId: params.missionId ?? "",
        action: params.action ?? "",
        missionPayloadHash: params.missionPayloadHash ?? "",
      };
      jobs.set(params.idempotencyKey, job);
      return { ok: true, duplicate: false, post: asPost(job) };
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

interface HarnessOptions {
  databasePath?: string;
  policy?: Partial<AutoPosterObservationPolicy>;
  withoutScheduler?: boolean;
  graphFailureInjector?: (boundary: string, graphId: string, nodeId: string | null) => void;
  projectionFailureInjector?: (boundary: string, graphId: string, nodeId: string) => void;
  observationFailureInjector?: (boundary: string, observationJobId: string) => void;
}

interface Harness {
  database: DatabaseSync;
  databasePath: string;
  graphs: MissionGraphService;
  results: AutoPosterResultProjectionService;
  observation: AutoPosterObservationService;
  app: express.Express;
  nowMs(): number;
  advanceSeconds(seconds: number): void;
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

function createHarness(boundary: Boundary, options: HarnessOptions = {}): Harness {
  const root = options.databasePath
    ? path.dirname(options.databasePath)
    : mkdtempSync(path.join(os.tmpdir(), "chanter-phase2ec-observation-"));
  if (!options.databasePath) temporaryRoots.push(root);
  const resolvedPath = options.databasePath ?? path.join(root, "operator.sqlite");
  const database = createDatabase(resolvedPath);
  let clockMs = TEST_NOW_MS;
  const now = () => new Date(clockMs);
  const ledger = new AgentRunLedgerService(database, []);
  const executor = createAutoPosterRuntimeMissionExecutor(
    {
      baseUrl: "https://autoposter.phase2ec.test",
      serviceToken: RUNTIME_TOKEN,
      userId: OWNER_ID,
      timeoutValid: true,
    },
    { port: boundary.port },
  );
  const autoPoster = new AutoPosterMissionService(database, executor, {
    agentRunLedgerService: ledger,
    now,
  });
  const generic = new GenericMissionService(
    database,
    createLoopGovernorMissionExecutor(
      { pythonExecutable: "", governorRoot: "", dataDir: "", timeoutValid: true },
      {
        port: {
          async createManualLoop() {
            return { ok: true, created: true, taskId: "t", loopId: "l", realAgentExecution: false };
          },
          async lookupManualLoop() {
            return { ok: true, outcome: "not_found", binding: null };
          },
        },
      },
    ),
    { agentRunLedgerService: ledger, now },
  );
  const results = new AutoPosterResultProjectionService(database, executor, {
    now,
    ...(options.projectionFailureInjector
      ? { failureInjector: options.projectionFailureInjector as never }
      : {}),
  });
  const observation = new AutoPosterObservationService(database, results, {
    now,
    ...(options.policy ? { policy: options.policy } : {}),
    ...(options.observationFailureInjector
      ? { failureInjector: options.observationFailureInjector as never }
      : {}),
  });
  const graphs = new MissionGraphService(
    database,
    new MissionGraphChildDispatcher(generic, autoPoster),
    {
      now,
      ...(options.withoutScheduler ? {} : { observationScheduler: observation }),
      ...(options.graphFailureInjector
        ? { failureInjector: options.graphFailureInjector as never }
        : {}),
    },
  );
  const operatorService = new OperatorService(
    database,
    new AuditLogger(path.join(root, "data", "audit.jsonl")),
    new MockRunner(),
    ensureWorkspace(path.join(root, "workspace")),
  );
  const app = express();
  app.use(createApp(operatorService, autoPoster, ledger, generic, graphs, results, observation));

  let closed = false;
  const harness: Harness = {
    database,
    databasePath: resolvedPath,
    graphs,
    results,
    observation,
    app,
    nowMs: () => clockMs,
    advanceSeconds: (seconds: number) => {
      clockMs += seconds * 1000;
    },
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

function scheduleNode(nodeId: string, provider: "tiktok" | "youtube") {
  const youtube = provider === "youtube";
  return {
    nodeId,
    target: { product: "auto_poster", action: "autoposter.post.schedule" },
    objective: `Create the ${provider} unapproved queue draft.`,
    input: {
      accountId: youtube ? YOUTUBE_ACCOUNT : TIKTOK_ACCOUNT,
      provider,
      mediaUrl: `https://cdn.example.com/${provider}-${nodeId}.mp4`,
      caption: `${provider} caption`,
      hashtags: "#chanter #phase2ec",
      ...(youtube ? { title: "Phase 2E-C private upload", description: "Private-only." } : {}),
      scheduledAt: youtube ? YOUTUBE_AT : TIKTOK_AT,
    },
    dependsOn: [],
  };
}

function graphEnvelope(
  graphId = "phase2ec-graph",
  workspaceId = WORKSPACE_ID,
  nodes: Array<ReturnType<typeof scheduleNode>> = [
    scheduleNode("tiktok_node", "tiktok"),
    scheduleNode("youtube_node", "youtube"),
  ],
) {
  return {
    schemaVersion: "chanter.mission.graph.v1",
    graphId,
    traceId: `${graphId}-trace`,
    idempotencyKey: `${graphId}-key`,
    source: { system: "operator", requestedBy: "founder-phase2ec" },
    objective: "Schedule the bounded AutoPoster draft batch for autonomous observation.",
    tenant: { userId: OWNER_ID, workspaceId },
    nodes,
    requestedAt: REQUESTED_AT,
  };
}

async function completedGraph(
  harness: Harness,
  graphId = "phase2ec-graph",
  workspaceId = WORKSPACE_ID,
  nodes?: Array<ReturnType<typeof scheduleNode>>,
): Promise<void> {
  const submitted = harness.graphs.submitGraph(graphEnvelope(graphId, workspaceId, nodes));
  const approved = await harness.graphs.approveGraph(submitted.graphId, {
    approvedBy: "founder-phase2ec",
    graphHash: submitted.graphHash,
  });
  expect(approved.status).toBe("completed");
}

function jobRows(database: DatabaseSync, graphId?: string): Array<Record<string, unknown>> {
  const rows = graphId
    ? database.prepare(
      "SELECT * FROM operator_autoposter_observation_jobs WHERE graph_id = ? ORDER BY node_id ASC",
    ).all(graphId)
    : database.prepare(
      "SELECT * FROM operator_autoposter_observation_jobs ORDER BY graph_id ASC, node_id ASC",
    ).all();
  return rows as unknown as Array<Record<string, unknown>>;
}

function escalationRows(database: DatabaseSync): Array<Record<string, unknown>> {
  return database.prepare(
    "SELECT * FROM operator_autoposter_observation_escalations ORDER BY graph_id ASC, node_id ASC",
  ).all() as unknown as Array<Record<string, unknown>>;
}

function attemptRows(database: DatabaseSync, observationJobId: string): Array<Record<string, unknown>> {
  return database.prepare(
    "SELECT * FROM operator_autoposter_observation_attempts WHERE observation_job_id = ? ORDER BY attempt_number ASC",
  ).all(observationJobId) as unknown as Array<Record<string, unknown>>;
}

function eventCount(database: DatabaseSync, graphId: string): number {
  const row = database.prepare(
    "SELECT COUNT(*) AS count FROM operator_autoposter_result_events WHERE graph_id = ?",
  ).get(graphId) as { count: number };
  return Number(row.count);
}

function tableRows(database: DatabaseSync, table: string): unknown[] {
  return database.prepare(`SELECT * FROM ${table} ORDER BY 1, 2`).all();
}

function observationJobId(graphId: string, nodeId: string): string {
  return sha256(`${OBSERVATION_SCHEMA_VERSION}|job|${graphId}|${nodeId}`);
}

describe("Phase 2E-C migration", () => {
  it("creates the three observation tables, replays idempotently, and refuses unknown variants", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "chanter-phase2ec-migration-"));
    temporaryRoots.push(root);

    const freshPath = path.join(root, "fresh.sqlite");
    const fresh = createDatabase(freshPath);
    const tables = fresh.prepare(
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name LIKE 'operator_autoposter_observation%' ORDER BY name",
    ).all() as Array<{ name: string }>;
    expect(tables.map((table) => table.name)).toEqual([
      "operator_autoposter_observation_attempts",
      "operator_autoposter_observation_escalations",
      "operator_autoposter_observation_jobs",
    ]);
    expect(migrateAutoPosterObservationTables(fresh)).toBe(false);
    fresh.close();

    // Reopen: restart-safe idempotent replay.
    const reopened = createDatabase(freshPath);
    reopened.close();

    // An unknown pre-existing table variant refuses migration fail-closed.
    const bogusPath = path.join(root, "bogus.sqlite");
    const bogus = new DatabaseSync(bogusPath);
    bogus.exec("CREATE TABLE operator_autoposter_observation_jobs (bogus TEXT);");
    bogus.close();
    expect(() => createDatabase(bogusPath)).toThrow(
      /Phase 2E-C migration refused an unknown operator_autoposter_observation_jobs schema/,
    );
  });
});

describe("Phase 2E-C automatic observation scheduling", () => {
  it("creates exactly one durable pending job per completed schedule node, idempotently", async () => {
    const boundary = makeBoundary();
    const harness = createHarness(boundary);
    await completedGraph(harness);

    const rows = jobRows(harness.database, "phase2ec-graph");
    expect(rows).toHaveLength(2);
    const tiktokJob = rows[0]!;
    expect(tiktokJob.node_id).toBe("tiktok_node");
    expect(tiktokJob.observation_job_id).toBe(observationJobId("phase2ec-graph", "tiktok_node"));
    expect(tiktokJob.status).toBe("pending");
    expect(tiktokJob.attempt_count).toBe(0);
    expect(tiktokJob.max_attempts).toBe(8);
    expect(tiktokJob.mission_id).toBe("graph:phase2ec-graph:node:tiktok_node");
    expect(tiktokJob.workspace_id).toBe(WORKSPACE_ID);
    expect(tiktokJob.provider).toBe("tiktok");
    expect(tiktokJob.account_id).toBe(TIKTOK_ACCOUNT);
    expect(tiktokJob.connected_account_id).toBe(`tiktok:${TIKTOK_ACCOUNT}`);
    expect(tiktokJob.queue_job_id).toBe(boundary.jobByNode("tiktok_node").id);
    // First attempt becomes due exactly one initial delay (15s) after creation.
    expect(tiktokJob.next_attempt_at).toBe(new Date(TEST_NOW_MS + 15_000).toISOString());
    expect(String(tiktokJob.source_binding_hash)).toMatch(/^[0-9a-f]{64}$/);

    // Exact approval replay and direct scheduling replay create nothing new.
    const before = jobRows(harness.database);
    const submitted = harness.graphs.submitGraph(graphEnvelope());
    await harness.graphs.approveGraph(submitted.graphId, {
      approvedBy: "founder-phase2ec",
      graphHash: submitted.graphHash,
    });
    const replay = harness.observation.scheduleObservationForNode("phase2ec-graph", "tiktok_node");
    expect(replay.created).toBe(false);
    expect(replay.job!.observationJobId).toBe(tiktokJob.observation_job_id);
    expect(jobRows(harness.database)).toEqual(before);

    // No provider status read happened during scheduling.
    expect(boundary.statusCalls).toHaveLength(0);
  });

  it("backfills a job lost to a crash between node completion and hook execution", async () => {
    const boundary = makeBoundary();
    let crashes = 0;
    const harness = createHarness(boundary, {
      graphFailureInjector: (injectionBoundary, _graphId, nodeId) => {
        if (
          injectionBoundary === "after_node_completed_persistence"
          && nodeId === "youtube_node"
          && crashes === 0
        ) {
          crashes += 1;
          throw new Error("simulated crash before observation scheduling");
        }
      },
    });

    const submitted = harness.graphs.submitGraph(graphEnvelope());
    await expect(harness.graphs.approveGraph(submitted.graphId, {
      approvedBy: "founder-phase2ec",
      graphHash: submitted.graphHash,
    })).rejects.toThrow(/simulated crash/);

    // The youtube node completed durably, but its observation job is missing.
    const nodes = harness.database.prepare(
      "SELECT node_id, status FROM operator_mission_graph_nodes WHERE graph_id = ? ORDER BY node_id",
    ).all("phase2ec-graph") as Array<{ node_id: string; status: string }>;
    expect(nodes.find((node) => node.node_id === "youtube_node")!.status).toBe("completed");
    expect(jobRows(harness.database).map((row) => row.node_id)).toEqual(["tiktok_node"]);

    // The bounded backfill inside the next observation batch recreates it.
    const batch = await harness.observation.runObservationBatch({});
    expect(batch.backfilledJobs).toBe(1);
    expect(jobRows(harness.database).map((row) => row.node_id))
      .toEqual(["tiktok_node", "youtube_node"]);
  });

  it("never observes nodes that lack a valid downstream binding", async () => {
    const boundary = makeBoundary();
    const harness = createHarness(boundary, { withoutScheduler: true });
    await completedGraph(harness);
    expect(jobRows(harness.database)).toHaveLength(0);

    // Simulate a node that never reached a durable downstream queue binding.
    harness.database.prepare(
      "UPDATE autoposter_mission_executions SET downstream_queue_id = NULL WHERE mission_id = ?",
    ).run("graph:phase2ec-graph:node:tiktok_node");
    harness.database.prepare(
      "UPDATE operator_mission_graph_nodes SET result_summary_json = NULL WHERE graph_id = ? AND node_id = ?",
    ).run("phase2ec-graph", "tiktok_node");

    const skipped = harness.observation.scheduleObservationForNode("phase2ec-graph", "tiktok_node");
    expect(skipped).toEqual({ created: false, skippedReason: "downstream_binding_missing", job: null });

    const batch = await harness.observation.runObservationBatch({});
    expect(batch.backfilledJobs).toBe(1);
    expect(jobRows(harness.database).map((row) => row.node_id)).toEqual(["youtube_node"]);
    // Only the validly bound node was observed.
    expect(boundary.statusCalls.map((call) => call.postId))
      .not.toContain(boundary.jobByNode("tiktok_node").id);
  });
});

describe("Phase 2E-C claiming, leases, and concurrency", () => {
  it("claims due jobs atomically with deterministic ordering and no double claim", async () => {
    const boundary = makeBoundary();
    const harness = createHarness(boundary);
    await completedGraph(harness);
    harness.advanceSeconds(15);

    const first = harness.observation.claimDueJobs({ leaseOwner: "worker-a", batchSize: 1 });
    expect(first).toHaveLength(1);
    expect(first[0]!.nodeId).toBe("tiktok_node"); // deterministic order
    expect(first[0]!.status).toBe("leased");
    expect(first[0]!.leaseOwner).toBe("worker-a");

    const second = harness.observation.claimDueJobs({ leaseOwner: "worker-b", batchSize: 4 });
    expect(second).toHaveLength(1);
    expect(second[0]!.nodeId).toBe("youtube_node");

    // Everything due is leased: a third concurrent worker gets nothing.
    expect(harness.observation.claimDueJobs({ leaseOwner: "worker-c", batchSize: 4 })).toHaveLength(0);
  });

  it("recovers expired leases safely and never claims terminal or cancelled jobs", async () => {
    const boundary = makeBoundary();
    const harness = createHarness(boundary);
    await completedGraph(harness);
    harness.advanceSeconds(15);

    const claimed = harness.observation.claimDueJobs({ leaseOwner: "worker-a", batchSize: 4 });
    expect(claimed).toHaveLength(2);
    // While the lease is live, nobody else can claim.
    expect(harness.observation.claimDueJobs({ leaseOwner: "worker-b", batchSize: 4 })).toHaveLength(0);

    // After lease expiry (60s), the jobs recover to a new owner.
    harness.advanceSeconds(61);
    const recovered = harness.observation.claimDueJobs({ leaseOwner: "worker-b", batchSize: 4 });
    expect(recovered).toHaveLength(2);
    expect(recovered.every((job) => job.leaseOwner === "worker-b")).toBe(true);

    // A cancelled job is terminal and never claimable again.
    const cancelled = harness.observation.cancelJob(recovered[0]!.observationJobId, {
      cancelledBy: "founder-phase2ec",
      reason: "test cancellation",
    });
    expect(cancelled.status).toBe("cancelled");
    harness.advanceSeconds(3600);
    const afterCancel = harness.observation.claimDueJobs({ leaseOwner: "worker-c", batchSize: 4 });
    expect(afterCancel.map((job) => job.observationJobId))
      .toEqual([recovered[1]!.observationJobId]);
  });
});

describe("Phase 2E-C bounded backoff and outcome convergence", () => {
  it("re-observes non-terminal truth on the exact 15/30/60/120 policy and converges terminal success", async () => {
    const boundary = makeBoundary();
    const harness = createHarness(boundary);
    await completedGraph(harness);
    // Canonical state model baseline: mission graph/node execution state is
    // captured once, immediately after successful execution, and must never
    // be rewritten by later provider-outcome convergence.
    const executionStateAfterGraphCompletion = tableRows(
      harness.database,
      "operator_mission_graph_nodes",
    );

    // Human approval landed in AutoPoster for both drafts (class A follows).
    for (const nodeId of ["tiktok_node", "youtube_node"]) {
      boundary.setStatus(boundary.jobByNode(nodeId).id, {
        approved: true,
        approvalState: "approved",
        approvedAt: sourceRevision(1),
        approvedBy: "founder@chanter",
        updatedAt: sourceRevision(2),
      });
    }

    harness.advanceSeconds(15);
    const first = await harness.observation.runObservationBatch({});
    expect(first.claimed).toBe(2);
    expect(first.results.map((result) => result.outcomeClass))
      .toEqual(["continue_observing", "continue_observing"]);
    expect(first.results.map((result) => result.projectionStatus))
      .toEqual(["approved_for_publish", "approved_for_publish"]);
    expect(first.results[0]!.retryDelaySeconds).toBe(30);

    // Not due yet: nothing claims before the 30s backoff elapses.
    harness.advanceSeconds(10);
    expect((await harness.observation.runObservationBatch({})).claimed).toBe(0);

    harness.advanceSeconds(20);
    const second = await harness.observation.runObservationBatch({});
    expect(second.claimed).toBe(2);
    expect(second.results[0]!.retryDelaySeconds).toBe(60);

    harness.advanceSeconds(60);
    // Terminal truth arrived: YouTube private upload, TikTok still processing.
    const youtubeJob = boundary.jobByNode("youtube_node");
    boundary.setStatus(youtubeJob.id, {
      status: "posted",
      providerStatus: "uploaded_private",
      publishId: "yt-video-1",
      postedAt: sourceRevision(90),
      updatedAt: sourceRevision(90),
      lastResult: { mode: "scheduler", code: "uploaded", message: "private upload complete" },
    });
    boundary.setStatus(boundary.jobByNode("tiktok_node").id, {
      status: "processing",
      updatedAt: sourceRevision(91),
    });
    const third = await harness.observation.runObservationBatch({});
    const youtubeRun = third.results.find((result) => result.nodeId === "youtube_node")!;
    expect(youtubeRun.outcomeClass).toBe("converged");
    expect(youtubeRun.projectionStatus).toBe("uploaded_private");
    expect(youtubeRun.retryDelaySeconds).toBeNull();
    const tiktokRun = third.results.find((result) => result.nodeId === "tiktok_node")!;
    expect(tiktokRun.outcomeClass).toBe("continue_observing");
    expect(tiktokRun.retryDelaySeconds).toBe(120);

    // Canonical state model, part 1: terminal success converges the durable
    // observation JOB (this table) — never the mission graph/node execution
    // record. "Converges the node" in earlier reporting language referred to
    // this job/result layer, not to operator_mission_graph_nodes.
    const convergedJob = harness.observation.getJobDetail(youtubeRun.observationJobId);
    expect(convergedJob.job.status).toBe("converged");
    expect(convergedJob.job.convergenceReason).toBe("uploaded_private");
    expect(convergedJob.job.lastSuccessAt).not.toBeNull();
    expect(convergedJob.job.nextAttemptAt).toBeNull();
    expect(convergedJob.attempts).toHaveLength(3);
    expect(convergedJob.attempts.map((attempt) => attempt.retryDelaySeconds))
      .toEqual([30, 60, null]);

    // Canonical state model, part 2: the graph-level RESULT/OUTCOME
    // projection (Phase 2E-B's durable per-node read model, read here
    // through the exact same service the manual refresh route uses) reflects
    // the terminal success for youtube_node and the still-open state for
    // tiktok_node — this is the "graph-level result projection" that
    // converges; it is derived from operator_autoposter_result_projections,
    // never from operator_mission_graph_nodes.
    const projectionsAfterConvergence = harness.results.getProjections("phase2ec-graph");
    const youtubeProjection = projectionsAfterConvergence.nodes
      .find((node) => node.nodeId === "youtube_node")!.projection!;
    expect(youtubeProjection.projectionStatus).toBe("uploaded_private");
    const tiktokProjection = projectionsAfterConvergence.nodes
      .find((node) => node.nodeId === "tiktok_node")!.projection!;
    expect(tiktokProjection.projectionStatus).toBe("processing"); // still open per the truth set just above

    // Canonical state model, part 3: mission graph/node EXECUTION state is
    // byte-identical to the moment the graph durably completed — successful
    // execution is immutable and is never rewritten by any later provider
    // outcome, including this node's own terminal success.
    expect(tableRows(harness.database, "operator_mission_graph_nodes"))
      .toEqual(executionStateAfterGraphCompletion);

    // A converged job is never claimed or re-polled again.
    const callsAfter = boundary.statusCalls.length;
    harness.advanceSeconds(3600);
    const fourth = await harness.observation.runObservationBatch({});
    expect(fourth.results.map((result) => result.nodeId)).toEqual(["tiktok_node"]);
    expect(
      boundary.statusCalls.slice(callsAfter).every(
        (call) => call.postId === boundary.jobByNode("tiktok_node").id,
      ),
    ).toBe(true);
  });

  it("escalates human-required truth exactly once and classifies terminal provider failure deterministically", async () => {
    const boundary = makeBoundary();
    const harness = createHarness(boundary);
    await completedGraph(harness);
    // Canonical state model baseline (see the terminal-success test above):
    // captured once, immediately after successful execution.
    const executionStateAfterGraphCompletion = tableRows(
      harness.database,
      "operator_mission_graph_nodes",
    );

    // TikTok node stays an unapproved draft (approval requires a human);
    // YouTube node fails terminally in AutoPoster.
    boundary.setStatus(boundary.jobByNode("youtube_node").id, {
      status: "failed",
      updatedAt: sourceRevision(2),
      lastResult: { code: "provider_rejected", message: "The provider rejected the upload payload." },
      lastErrorMessage: "The provider rejected the upload payload.",
    });

    harness.advanceSeconds(15);
    const batch = await harness.observation.runObservationBatch({});
    const tiktokRun = batch.results.find((result) => result.nodeId === "tiktok_node")!;
    expect(tiktokRun.outcomeClass).toBe("escalation_required");
    expect(tiktokRun.reasonCode).toBe("publish_approval_required");
    expect(tiktokRun.escalationId).not.toBeNull();
    const youtubeRun = batch.results.find((result) => result.nodeId === "youtube_node")!;
    expect(youtubeRun.outcomeClass).toBe("failed_terminal");
    expect(youtubeRun.reasonCode).toBe("publish_failed");

    const escalations = escalationRows(harness.database);
    expect(escalations).toHaveLength(1);
    expect(escalations[0]!.reason_code).toBe("publish_approval_required");
    expect(escalations[0]!.severity).toBe("info");
    expect(escalations[0]!.status).toBe("open");
    expect(escalations[0]!.human_action_required).toBe(1);

    // Canonical state model, part 1: terminal failure converges the durable
    // observation JOB (this table) — never the mission graph/node execution
    // record.
    const failedJob = harness.observation.getJobDetail(youtubeRun.observationJobId);
    expect(failedJob.job.status).toBe("failed_terminal");
    expect(failedJob.job.convergenceReason).toBe("publish_failed");
    expect(failedJob.escalation).toBeNull();

    // Terminal jobs are never re-claimed: no duplicate escalation is possible.
    harness.advanceSeconds(3600);
    const replay = await harness.observation.runObservationBatch({});
    expect(replay.claimed).toBe(0);
    expect(escalationRows(harness.database)).toHaveLength(1);

    // Canonical state model, part 2: the graph-level RESULT/OUTCOME
    // projection reflects both outcomes independently — youtube_node's
    // terminal failure and tiktok_node's escalation reason — without ever
    // rewriting graph/node execution truth. The TikTok node is still a
    // legitimately non-terminal unapproved draft, so the reviewed Phase 2E-B
    // batch summary reports awaiting_results rather than fabricating a
    // graph-wide failure from one node's terminal proof; escalation
    // visibility at the graph level is the separate, authoritative
    // `operator_autoposter_observation_escalations` table (already asserted
    // above), not a batch-summary bucket.
    const projections = harness.results.getProjections("phase2ec-graph");
    expect(projections.batch.status).toBe("awaiting_results");
    const youtubeProjection = projections.nodes
      .find((node) => node.nodeId === "youtube_node")!.projection!;
    expect(youtubeProjection.projectionStatus).toBe("failed");
    const tiktokProjection = projections.nodes
      .find((node) => node.nodeId === "tiktok_node")!.projection!;
    expect(tiktokProjection.projectionStatus).toBe("awaiting_publish_approval");
    expect(tiktokProjection.escalationReason).toBe("publish_approval_required");

    // Canonical state model, part 3: mission graph/node EXECUTION state is
    // byte-identical to the moment the graph durably completed.
    expect(tableRows(harness.database, "operator_mission_graph_nodes"))
      .toEqual(executionStateAfterGraphCompletion);
  });

  it("classifies reauthorization, manual reconciliation, unverified acceptance, and outcome_unknown as human escalations", async () => {
    const cases: Array<{
      overrides: Partial<AutoPosterPostStatusView>;
      reason: string;
      severity: string;
    }> = [
      {
        overrides: {
          status: "failed",
          updatedAt: sourceRevision(2),
          lastResult: { code: "auth_failed", message: "reauthorize the account" },
          lastErrorMessage: "unauthorized: reauthorize the account",
        },
        reason: "provider_reauthorization_required",
        severity: "high",
      },
      {
        overrides: {
          status: "posted",
          updatedAt: sourceRevision(2),
          postedAt: sourceRevision(2),
          lastResult: { mode: "manual", message: "marked posted by founder" },
        },
        reason: "manually_reconciled",
        severity: "info",
      },
      {
        overrides: {
          status: "posted",
          approved: true,
          approvalState: "approved",
          approvedAt: sourceRevision(1),
          approvedBy: "founder@chanter",
          postedAt: sourceRevision(2),
          updatedAt: sourceRevision(2),
          publishId: "tt-publish-1",
          providerStatus: "provider_accepted",
        },
        reason: "provider_accepted_unverified",
        severity: "warning",
      },
      {
        overrides: {
          status: "outcome_unknown",
          updatedAt: sourceRevision(2),
          lastResult: { outcomeUnknown: true, message: "publish outcome unknown" },
        },
        reason: "outcome_unknown",
        severity: "critical",
      },
    ];

    for (const testCase of cases) {
      const boundary = makeBoundary();
      const harness = createHarness(boundary);
      await completedGraph(harness);
      boundary.setStatus(boundary.jobByNode("tiktok_node").id, testCase.overrides);
      harness.advanceSeconds(15);
      const batch = await harness.observation.runObservationBatch({});
      const run = batch.results.find((result) => result.nodeId === "tiktok_node")!;
      expect(run.outcomeClass, testCase.reason).toBe("escalation_required");
      expect(run.reasonCode, testCase.reason).toBe(testCase.reason);
      const escalation = harness.observation.getEscalation(run.escalationId!);
      expect(escalation.severity, testCase.reason).toBe(testCase.severity);
      expect(escalation.status).toBe("open");
      harness.close();
    }
  });

  it("exhausts the bounded window into escalation_required and fails closed on malformed provider truth", async () => {
    const boundary = makeBoundary();
    const harness = createHarness(boundary, { policy: { maxAttempts: 2 } });
    await completedGraph(harness);

    // TikTok: perpetually processing (class A until the window exhausts).
    boundary.setStatus(boundary.jobByNode("tiktok_node").id, {
      status: "processing",
      updatedAt: sourceRevision(2),
    });
    // YouTube: the strict read boundary keeps returning a malformed response.
    boundary.statusFailures.set(boundary.jobByNode("youtube_node").id, {
      ok: false,
      code: "invalid_response",
      message: "AutoPoster returned a malformed status document.",
    });

    harness.advanceSeconds(15);
    const first = await harness.observation.runObservationBatch({});
    expect(first.results.map((result) => result.outcomeClass).sort())
      .toEqual(["continue_observing", "transport_retry"]);

    harness.advanceSeconds(30);
    const second = await harness.observation.runObservationBatch({});
    for (const run of second.results) {
      expect(run.outcomeClass).toBe("escalation_required");
      expect(run.reasonCode).toBe("observation_window_exhausted");
      expect(run.attemptNumber).toBe(2);
    }
    expect(escalationRows(harness.database)).toHaveLength(2);

    // Fail-closed: the malformed reads never fabricated a projection.
    const projections = harness.results.getProjections("phase2ec-graph");
    const youtubeProjection = projections.nodes
      .find((node) => node.nodeId === "youtube_node")!.projection;
    expect(youtubeProjection).toBeNull();
    expect(eventCount(harness.database, "phase2ec-graph")).toBe(1); // tiktok only

    // A malformed identity answer fails terminally on the first attempt.
    const identityBoundary = makeBoundary();
    const identityHarness = createHarness(identityBoundary);
    await completedGraph(identityHarness, "phase2ec-identity-graph");
    identityBoundary.statusFailures.set(
      identityBoundary.jobByNode("tiktok_node", "phase2ec-identity-graph").id,
      {
        ok: false,
        code: "invalid_response",
        message: "The status response identifies a different queue job.",
        reasonCode: "status_identity_mismatch",
      },
    );
    identityHarness.advanceSeconds(15);
    const identityBatch = await identityHarness.observation.runObservationBatch({});
    const identityRun = identityBatch.results.find((result) => result.nodeId === "tiktok_node")!;
    expect(identityRun.outcomeClass).toBe("failed_terminal");
    expect(identityRun.reasonCode).toBe("result_identity_mismatch");
  });
});

describe("Phase 2E-C restart and crash safety", () => {
  it("preserves pending jobs across a restart before the first observation", async () => {
    const boundary = makeBoundary();
    const harness = createHarness(boundary);
    await completedGraph(harness);
    const before = jobRows(harness.database);
    const databasePath = harness.databasePath;
    harness.close();

    const restarted = createHarness(boundary, { databasePath });
    expect(jobRows(restarted.database)).toEqual(before);
    restarted.advanceSeconds(15);
    const batch = await restarted.observation.runObservationBatch({});
    expect(batch.claimed).toBe(2);
    expect(batch.backfilledJobs).toBe(0);
  });

  it("crash after the provider read but before projection persistence duplicates nothing", async () => {
    const boundary = makeBoundary();
    let crash = true;
    const harness = createHarness(boundary, {
      policy: { batchSize: 1 },
      projectionFailureInjector: (injectionBoundary, _graphId, nodeId) => {
        if (
          injectionBoundary === "after_status_read_before_persistence"
          && nodeId === "tiktok_node"
          && crash
        ) {
          throw new Error("simulated crash after provider read");
        }
      },
    });
    await completedGraph(harness);
    harness.advanceSeconds(15);

    await expect(harness.observation.runObservationBatch({ batchSize: 1 }))
      .rejects.toThrow(/simulated crash after provider read/);

    // Nothing durable was projected; the burned attempt is durably counted.
    expect(eventCount(harness.database, "phase2ec-graph")).toBe(0);
    expect(tableRows(harness.database, "operator_autoposter_result_projections")).toEqual([]);
    const interrupted = jobRows(harness.database, "phase2ec-graph")[0]!;
    expect(interrupted.status).toBe("observing");
    expect(interrupted.attempt_count).toBe(1);
    expect(attemptRows(harness.database, String(interrupted.observation_job_id))).toHaveLength(0);
    const readsAfterCrash = boundary.statusCalls.length;
    expect(readsAfterCrash).toBe(1);

    // Recovery: after lease expiry, one bounded replay read persists exactly
    // one evidence row — no duplicates from the crashed attempt.
    crash = false;
    harness.advanceSeconds(61);
    const recovery = await harness.observation.runObservationBatch({ batchSize: 1 });
    const run = recovery.results.find((result) => result.nodeId === "tiktok_node")!;
    expect(run.attemptNumber).toBe(2);
    expect(eventCount(harness.database, "phase2ec-graph")).toBe(1);
    expect(boundary.statusCalls.length).toBe(readsAfterCrash + 1);
  });

  it("crash after projection but before job convergence resumes deterministically without duplicate evidence or escalations", async () => {
    const boundary = makeBoundary();
    let crash = true;
    const harness = createHarness(boundary, {
      policy: { batchSize: 1 },
      observationFailureInjector: (injectionBoundary) => {
        if (injectionBoundary === "after_projection_before_job_convergence" && crash) {
          throw new Error("simulated crash before job convergence");
        }
      },
    });
    // Single-node graph: isolates this crash boundary from any interaction
    // with a second, untouched observation job during the final replay step.
    await completedGraph(harness, "phase2ec-graph", WORKSPACE_ID, [
      scheduleNode("tiktok_node", "tiktok"),
    ]);
    harness.advanceSeconds(15);

    await expect(harness.observation.runObservationBatch({ batchSize: 1 }))
      .rejects.toThrow(/simulated crash before job convergence/);

    // The Phase 2E-B projection and evidence persisted; the job is still
    // lease-protected in `observing` with its attempt durably burned.
    expect(eventCount(harness.database, "phase2ec-graph")).toBe(1);
    const interrupted = jobRows(harness.database, "phase2ec-graph")[0]!;
    expect(interrupted.status).toBe("observing");
    expect(interrupted.attempt_count).toBe(1);
    expect(escalationRows(harness.database)).toHaveLength(0);
    const readsAfterCrash = boundary.statusCalls.length;

    // Recovery replays the observation (one bounded read, zero new evidence)
    // and converges: the unapproved draft escalates exactly once.
    crash = false;
    harness.advanceSeconds(61);
    const recovery = await harness.observation.runObservationBatch({ batchSize: 1 });
    const run = recovery.results.find((result) => result.nodeId === "tiktok_node")!;
    expect(run.outcomeClass).toBe("escalation_required");
    expect(run.attemptNumber).toBe(2);
    expect(eventCount(harness.database, "phase2ec-graph")).toBe(1);
    expect(boundary.statusCalls.length).toBe(readsAfterCrash + 1);
    expect(escalationRows(harness.database)).toHaveLength(1);

    // Escalation replay safety: nothing new after the job went terminal.
    harness.advanceSeconds(3600);
    await harness.observation.runObservationBatch({});
    expect(escalationRows(harness.database)).toHaveLength(1);
    expect(eventCount(harness.database, "phase2ec-graph")).toBe(1);
  });

  it("keeps graph and node execution truth byte-identical through the whole loop", async () => {
    const boundary = makeBoundary();
    const harness = createHarness(boundary);
    await completedGraph(harness);
    const graphsBefore = tableRows(harness.database, "operator_mission_graphs");
    const nodesBefore = tableRows(harness.database, "operator_mission_graph_nodes");
    const missionsBefore = tableRows(harness.database, "autoposter_runtime_missions");
    const executionsBefore = tableRows(harness.database, "autoposter_mission_executions");
    const scheduleCallsBefore = boundary.scheduleCalls.length;

    harness.advanceSeconds(15);
    await harness.observation.runObservationBatch({});
    harness.advanceSeconds(3600);
    await harness.observation.runObservationBatch({});

    expect(tableRows(harness.database, "operator_mission_graphs")).toEqual(graphsBefore);
    expect(tableRows(harness.database, "operator_mission_graph_nodes")).toEqual(nodesBefore);
    expect(tableRows(harness.database, "autoposter_runtime_missions")).toEqual(missionsBefore);
    expect(tableRows(harness.database, "autoposter_mission_executions")).toEqual(executionsBefore);
    expect(boundary.scheduleCalls.length).toBe(scheduleCallsBefore); // zero AutoPoster writes
  });
});

describe("Phase 2E-C workspace and graph isolation", () => {
  it("observes every job strictly inside its own graph/workspace binding", async () => {
    const boundary = makeBoundary();
    const harness = createHarness(boundary);
    await completedGraph(harness, "phase2ec-graph-a", "workspace-a");
    await completedGraph(harness, "phase2ec-graph-b", "workspace-b");

    const rows = jobRows(harness.database);
    expect(rows).toHaveLength(4);
    expect(new Set(rows.map((row) => row.workspace_id))).toEqual(
      new Set(["workspace-a", "workspace-b"]),
    );

    harness.advanceSeconds(15);
    const batch = await harness.observation.runObservationBatch({ batchSize: 8 });
    expect(batch.claimed).toBe(4);

    // Every strict read carried exactly its own job's identity binding.
    for (const row of rows) {
      const call = boundary.statusCalls.find((candidate) => candidate.postId === row.queue_job_id);
      expect(call, String(row.queue_job_id)).toBeDefined();
      expect(call!.workspaceId).toBe(row.workspace_id);
      expect(call!.accountId).toBe(row.account_id);
    }
    // Projections and evidence stayed in their own graphs.
    const projectionGraphs = harness.database.prepare(
      "SELECT DISTINCT graph_id FROM operator_autoposter_result_projections ORDER BY graph_id",
    ).all() as Array<{ graph_id: string }>;
    expect(projectionGraphs.map((row) => row.graph_id))
      .toEqual(["phase2ec-graph-a", "phase2ec-graph-b"]);
    expect(eventCount(harness.database, "phase2ec-graph-a")).toBe(2);
    expect(eventCount(harness.database, "phase2ec-graph-b")).toBe(2);
  });
});

describe("Phase 2E-C capability isolation and escalation control", () => {
  it("gates the entire observation surface behind the operator control capability", async () => {
    const boundary = makeBoundary();
    const harness = createHarness(boundary);
    await completedGraph(harness);
    harness.advanceSeconds(15);

    const refusals: Array<[string, string | null]> = [
      ["missing token", null],
      ["mission submit token", SUBMIT_TOKEN],
      ["runtime service token", RUNTIME_TOKEN],
      ["ledger ingest token", LEDGER_TOKEN],
      ["wrong token", "not-a-real-token"],
    ];
    const surfaces: Array<["get" | "post", string]> = [
      ["post", "/api/autoposter-observations/run"],
      ["get", "/api/autoposter-observations/jobs"],
      ["get", "/api/autoposter-observations/jobs/some-job"],
      ["get", "/api/autoposter-observations/escalations"],
      ["post", "/api/autoposter-observations/escalations/some-escalation/acknowledge"],
      ["post", "/api/autoposter-observations/escalations/some-escalation/resolve"],
    ];
    for (const [method, url] of surfaces) {
      for (const [label, token] of refusals) {
        const req = request(harness.app)[method](url);
        const response = await (token === null ? req : req.set("Authorization", `Bearer ${token}`))
          .send({});
        expect(response.status, `${label} ${method} ${url}`).toBe(401);
        expect(response.body.code, `${label} ${method} ${url}`).toBe("CAPABILITY_TOKEN_INVALID");
      }
    }
    // The refused calls mutated nothing and read nothing from AutoPoster.
    expect(boundary.statusCalls).toHaveLength(0);
    expect(jobRows(harness.database).every((row) => row.status === "pending")).toBe(true);

    // The control capability runs one bounded batch through the route.
    const run = await request(harness.app)
      .post("/api/autoposter-observations/run")
      .set("Authorization", `Bearer ${CONTROL_TOKEN}`)
      .send({ batchSize: 8 });
    expect(run.status).toBe(200);
    expect(run.body.claimed).toBe(2);

    const list = await request(harness.app)
      .get("/api/autoposter-observations/jobs?status=escalation_required")
      .set("Authorization", `Bearer ${CONTROL_TOKEN}`);
    expect(list.status).toBe(200);
    expect(list.body.jobs).toHaveLength(2);

    const detail = await request(harness.app)
      .get(`/api/autoposter-observations/jobs/${list.body.jobs[0].observationJobId}`)
      .set("Authorization", `Bearer ${CONTROL_TOKEN}`);
    expect(detail.status).toBe(200);
    expect(detail.body.job.status).toBe("escalation_required");
    expect(detail.body.attempts).toHaveLength(1);
    expect(detail.body.escalation.status).toBe("open");
  });

  it("acknowledges and resolves escalations idempotently under control authority only", async () => {
    const boundary = makeBoundary();
    const harness = createHarness(boundary);
    await completedGraph(harness);
    harness.advanceSeconds(15);
    const batch = await harness.observation.runObservationBatch({});
    const escalationId = batch.results[0]!.escalationId!;
    const otherEscalationId = batch.results[1]!.escalationId!;

    const acknowledged = await request(harness.app)
      .post(`/api/autoposter-observations/escalations/${escalationId}/acknowledge`)
      .set("Authorization", `Bearer ${CONTROL_TOKEN}`)
      .send({ acknowledgedBy: "founder-phase2ec" });
    expect(acknowledged.status).toBe(200);
    expect(acknowledged.body.status).toBe("acknowledged");
    expect(acknowledged.body.acknowledgedBy).toBe("founder-phase2ec");

    // Idempotent replay keeps the original acknowledgement.
    const replayed = await request(harness.app)
      .post(`/api/autoposter-observations/escalations/${escalationId}/acknowledge`)
      .set("Authorization", `Bearer ${CONTROL_TOKEN}`)
      .send({ acknowledgedBy: "someone-else" });
    expect(replayed.status).toBe(200);
    expect(replayed.body.acknowledgedBy).toBe("founder-phase2ec");

    const resolved = await request(harness.app)
      .post(`/api/autoposter-observations/escalations/${escalationId}/resolve`)
      .set("Authorization", `Bearer ${CONTROL_TOKEN}`)
      .send({ resolvedBy: "founder-phase2ec", note: "Approved the draft in AutoPoster." });
    expect(resolved.status).toBe(200);
    expect(resolved.body.status).toBe("resolved");
    expect(resolved.body.resolutionNote).toBe("Approved the draft in AutoPoster.");

    // Terminal escalation state refuses acknowledgement.
    const lateAck = await request(harness.app)
      .post(`/api/autoposter-observations/escalations/${escalationId}/acknowledge`)
      .set("Authorization", `Bearer ${CONTROL_TOKEN}`)
      .send({ acknowledgedBy: "founder-phase2ec" });
    expect(lateAck.status).toBe(409);
    expect(lateAck.body.code).toBe("OPERATOR_ESCALATION_STATE_TERMINAL");

    // Dismissal is the explicit alternative disposition.
    const dismissed = await request(harness.app)
      .post(`/api/autoposter-observations/escalations/${otherEscalationId}/resolve`)
      .set("Authorization", `Bearer ${CONTROL_TOKEN}`)
      .send({ resolvedBy: "founder-phase2ec", disposition: "dismissed" });
    expect(dismissed.status).toBe(200);
    expect(dismissed.body.status).toBe("dismissed");

    const invalidDisposition = await request(harness.app)
      .post(`/api/autoposter-observations/escalations/${otherEscalationId}/resolve`)
      .set("Authorization", `Bearer ${CONTROL_TOKEN}`)
      .send({ resolvedBy: "founder-phase2ec", disposition: "duplicate" });
    expect(invalidDisposition.status).toBe(400);

    const listOpen = await request(harness.app)
      .get("/api/autoposter-observations/escalations?status=open")
      .set("Authorization", `Bearer ${CONTROL_TOKEN}`);
    expect(listOpen.body.escalations).toHaveLength(0);
  });
});

describe("Phase 2E-C manual refresh backward compatibility", () => {
  it("keeps the Phase 2E-B manual refresh authoritative and side-effect-free for observation jobs", async () => {
    const boundary = makeBoundary();
    const harness = createHarness(boundary);
    await completedGraph(harness);
    harness.advanceSeconds(15);
    await harness.observation.runObservationBatch({});
    const jobsAfterLoop = jobRows(harness.database);
    const escalationsAfterLoop = escalationRows(harness.database);
    const eventsAfterLoop = eventCount(harness.database, "phase2ec-graph");

    // The manual founder-triggered refresh still works exactly as reviewed.
    const refresh = await request(harness.app)
      .post("/api/mission-graphs/phase2ec-graph/autoposter-results/refresh")
      .set("Authorization", `Bearer ${CONTROL_TOKEN}`)
      .send({});
    expect(refresh.status).toBe(200);
    expect(refresh.body.results.map((result: { outcome: string }) => result.outcome))
      .toEqual(["replayed", "replayed"]);

    // Manual refresh never mutates observation jobs, escalations, or attempts.
    expect(jobRows(harness.database)).toEqual(jobsAfterLoop);
    expect(escalationRows(harness.database)).toEqual(escalationsAfterLoop);
    expect(eventCount(harness.database, "phase2ec-graph")).toBe(eventsAfterLoop);

    const stored = await request(harness.app).get("/api/mission-graphs/phase2ec-graph/autoposter-results");
    expect(stored.status).toBe(200);
    expect(stored.body.nodes[0].projection.projectionStatus).toBe("awaiting_publish_approval");
  });
});

describe("Phase 2E-C policy validation", () => {
  it("refuses out-of-bounds polling configuration fail-closed", () => {
    const boundary = makeBoundary();
    const database = createDatabase(":memory:");
    const executor = createAutoPosterRuntimeMissionExecutor(
      {
        baseUrl: "https://autoposter.phase2ec.test",
        serviceToken: RUNTIME_TOKEN,
        userId: OWNER_ID,
        timeoutValid: true,
      },
      { port: boundary.port },
    );
    const results = new AutoPosterResultProjectionService(database, executor);
    const invalidPolicies: Array<Partial<AutoPosterObservationPolicy>> = [
      { retryDelaysSeconds: [] },
      { retryDelaysSeconds: [0] },
      { retryDelaysSeconds: [601] },
      { maxAttempts: 0 },
      { maxAttempts: 13 },
      { leaseSeconds: 1 },
      { leaseSeconds: 601 },
      { batchSize: 0 },
      { batchSize: 17 },
    ];
    for (const policy of invalidPolicies) {
      expect(
        () => new AutoPosterObservationService(database, results, { policy }),
        JSON.stringify(policy),
      ).toThrow(/OPERATOR_OBSERVATION_POLICY|must be/);
    }
    expect(new AutoPosterObservationService(database, results).getPolicy())
      .toEqual(DEFAULT_OBSERVATION_POLICY);
    database.close();
  });
});
