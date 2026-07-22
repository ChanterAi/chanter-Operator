/**
 * Phase 2E-B: manual AutoPoster result refresh + durable Operator projection.
 *
 * Proves the exact idempotency/ordering contract (first refresh, exact
 * replay, restart, stale protection, same-revision contradiction), the
 * provider-specific projection states, identity fail-closed behavior,
 * partial-batch preservation, capability isolation, and the hard safety
 * invariants: zero AutoPoster writes, zero provider calls, zero child
 * re-execution, and byte-identical Phase 2E-A graph/node truth.
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
  AutoPosterPortFailure,
  AutoPosterPostStatusParams,
  AutoPosterPostStatusView,
  AutoPosterScheduleParams,
} from "chanter-agent-runtime";
import { AuditLogger } from "../src/audit/auditLogger.js";
import { AgentRunLedgerService } from "../src/agentRunLedger/agentRunLedgerService.js";
import { createApp } from "../src/app.js";
import { createDatabase } from "../src/db/database.js";
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

const TEST_NOW_MS = Date.now();
const NOW = new Date(TEST_NOW_MS).toISOString();
const REQUESTED_AT = new Date(TEST_NOW_MS + 60_000).toISOString();
const TIKTOK_AT = new Date(TEST_NOW_MS + 2 * 60 * 60_000).toISOString();
const YOUTUBE_AT = new Date(TEST_NOW_MS + 3 * 60 * 60_000).toISOString();
const WORKSPACE_ID = "workspace-phase2eb";
const OWNER_ID = "owner";
const TIKTOK_ACCOUNT = "tt-account";
const YOUTUBE_ACCOUNT = "UC-phase2eb";
const CONTROL_TOKEN = "test-operator-control-token";
const SUBMIT_TOKEN = "test-mission-submit-token";
const LEDGER_TOKEN = "test-ledger-ingest-token";
const RUNTIME_TOKEN = "phase2eb-service-token";

/** Source revision helper: minutes after the base test instant. */
function sourceRevision(minutes: number): string {
  return new Date(TEST_NOW_MS + minutes * 60_000).toISOString();
}

interface QueueDraft {
  id: string;
  accountId: string;
  provider: "tiktok" | "youtube";
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
  reconciliationCalls: AutoPosterPostStatusParams[];
  providerPublishCalls: number;
  jobByNode(suffix: "tiktok_node" | "youtube_node", graphId?: string): QueueDraft;
  defaultView(job: QueueDraft): AutoPosterPostStatusView;
  setStatus(postId: string, overrides: Partial<AutoPosterPostStatusView>): void;
}

function connectedAccount(provider: "tiktok" | "youtube", accountId: string) {
  return {
    connectedAccountId: `${provider}:${accountId}`,
    accountId,
    provider,
    providerDisplayName: provider === "youtube" ? "YouTube" : "TikTok",
    username: `phase2eb_${provider}`,
    displayName: "Phase 2E-B Account",
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
  const reconciliationCalls: AutoPosterPostStatusParams[] = [];

  const boundary: Boundary = {
    jobs,
    scheduleCalls,
    statusCalls,
    statusViews,
    statusFailures,
    reconciliationCalls,
    providerPublishCalls: 0,
    port: undefined as unknown as AutoPosterOperationsPort,
    jobByNode(suffix, graphId = "phase2eb-graph") {
      const job = [...jobs.values()].find(
        (candidate) => candidate.missionId === `graph:${graphId}:node:${suffix}`,
      );
      if (!job) throw new Error(`no queue job bound to ${suffix}`);
      return job;
    },
    defaultView(job) {
      return {
        id: job.id,
        provider: job.provider,
        connectedAccountId: `${job.provider}:${job.accountId}`,
        accountId: job.accountId,
        username: `phase2eb_${job.provider}`,
        workspaceId: WORKSPACE_ID,
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
        providerVerification: null,
        providerOperation: null,
        lockedAt: null,
        claimAttempts: 0,
        publishAttemptBudget: 5,
        attemptBudgetExhausted: false,
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
    async reconcileProviderOperation(params) {
      reconciliationCalls.push(params);
      const job = [...jobs.values()].find((candidate) => candidate.id === params.postId);
      if (!job) return { ok: false, code: "not_found", message: "not found" };
      const post = statusViews.get(params.postId) ?? boundary.defaultView(job);
      return {
        ok: true,
        classification: post.providerOperation?.operationState ?? "provider_operation_not_found",
        post,
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

interface Harness {
  database: DatabaseSync;
  databasePath: string;
  graphs: MissionGraphService;
  results: AutoPosterResultProjectionService;
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

function createHarness(boundary: Boundary, databasePath?: string): Harness {
  const root = databasePath
    ? path.dirname(databasePath)
    : mkdtempSync(path.join(os.tmpdir(), "chanter-phase2eb-results-"));
  if (!databasePath) temporaryRoots.push(root);
  const resolvedPath = databasePath ?? path.join(root, "operator.sqlite");
  const database = createDatabase(resolvedPath);
  const ledger = new AgentRunLedgerService(database, []);
  const executor = createAutoPosterRuntimeMissionExecutor(
    {
      baseUrl: "https://autoposter.phase2eb.test",
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
    { agentRunLedgerService: ledger, now: () => new Date(NOW) },
  );
  const graphs = new MissionGraphService(
    database,
    new MissionGraphChildDispatcher(generic, autoPoster),
    { now: () => new Date(NOW) },
  );
  const results = new AutoPosterResultProjectionService(database, executor, {
    now: () => new Date(NOW),
  });
  const operatorService = new OperatorService(
    database,
    new AuditLogger(path.join(root, "data", "audit.jsonl")),
    new MockRunner(),
    ensureWorkspace(path.join(root, "workspace")),
  );
  const app = express();
  app.use(createApp(operatorService, autoPoster, ledger, generic, graphs, results));

  let closed = false;
  const harness: Harness = {
    database,
    databasePath: resolvedPath,
    graphs,
    results,
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
      hashtags: "#chanter #phase2eb",
      ...(youtube ? {
        title: "Phase 2E-B private upload",
        description: "Private-only.",
        providerProofMode: true,
        approvedMedia: { sha256: "a".repeat(64), byteSize: 100, mimeType: "video/mp4", fileName: "reviewed.mp4", container: "mp4" },
      } : {}),
      scheduledAt: youtube ? YOUTUBE_AT : TIKTOK_AT,
    },
    dependsOn: [],
  };
}

function graphEnvelope(graphId = "phase2eb-graph") {
  return {
    schemaVersion: "chanter.mission.graph.v1",
    graphId,
    traceId: `${graphId}-trace`,
    idempotencyKey: `${graphId}-key`,
    source: { system: "operator", requestedBy: "founder-phase2eb" },
    objective: "Schedule the bounded AutoPoster draft batch for result collection.",
    tenant: { userId: OWNER_ID, workspaceId: WORKSPACE_ID },
    nodes: [scheduleNode("tiktok_node", "tiktok"), scheduleNode("youtube_node", "youtube")],
    requestedAt: REQUESTED_AT,
  };
}

function youtubeProviderOperation(
  job: QueueDraft,
  state: NonNullable<AutoPosterPostStatusView["providerOperation"]>["operationState"],
  revision: number,
): NonNullable<AutoPosterPostStatusView["providerOperation"]> {
  const providerOperationId = "ytop_phase2eb_exact";
  const providerAttemptId = "ytattempt_phase2eb_exact";
  const mediaSha256 = "a".repeat(64);
  const completed = state === "completed_private";
  const artifactObserved = completed || state === "contradictory_public";
  const sessionStarted = !["operation_pending", "media_preflighted", "terminal_failure"].includes(state);
  return {
    schemaVersion: "chanter.autoposter.youtube-provider-operation.v1",
    providerOperationId,
    providerAttemptId,
    provider: "youtube",
    operationState: state,
    queueId: job.id,
    userId: OWNER_ID,
    workspaceId: WORKSPACE_ID,
    accountId: YOUTUBE_ACCOUNT,
    connectedAccountId: `youtube:${YOUTUBE_ACCOUNT}`,
    approvalActorId: "founder-provider-proof",
    approvalTimestamp: sourceRevision(1),
    approvedAttemptNumber: 1,
    runtimeMissionId: job.missionId,
    graphId: job.missionId.slice("graph:".length, job.missionId.indexOf(":node:")),
    runtimeAction: job.action,
    runtimePayloadHash: job.missionPayloadHash,
    approvedMediaSha256: mediaSha256,
    providerProofMode: true,
    approvedMedia: { sha256: mediaSha256, byteSize: 100, mimeType: "video/mp4", fileName: "reviewed.mp4", container: "mp4" },
    bindingSha256: "b".repeat(64),
    mediaSha256,
    mediaByteSize: 100,
    mediaMimeType: "video/mp4",
    mediaContainer: "mp4",
    mediaFileName: "reviewed.mp4",
    mediaSourceId: "https://cdn.example.com/youtube-reviewed.mp4",
    sessionCreatedAt: sessionStarted ? sourceRevision(revision) : null,
    uploadStartedAt: sessionStarted ? sourceRevision(revision) : null,
    uploadCompletedAt: completed ? sourceRevision(revision) : null,
    acceptedByteOffset: artifactObserved ? 100 : 0,
    externalVideoId: artifactObserved ? "yt-provider-operation-video" : null,
    providerResponseSha256: completed ? "c".repeat(64) : null,
    providerStatusReceiptSha256: completed ? "d".repeat(64) : null,
    providerStatusReceipt: completed ? {
      provider: "youtube",
      queueId: job.id,
      providerOperationId,
      providerAttemptId,
      userId: OWNER_ID,
      workspaceId: WORKSPACE_ID,
      runtimeMissionId: job.missionId,
      graphId: job.missionId.slice("graph:".length, job.missionId.indexOf(":node:")),
      mediaSha256,
      approvedMedia: { sha256: mediaSha256, byteSize: 100, mimeType: "video/mp4", fileName: "reviewed.mp4", container: "mp4" },
      providerProofMode: true,
      configuredAccountId: YOUTUBE_ACCOUNT,
      connectedAccountId: `youtube:${YOUTUBE_ACCOUNT}`,
      verifiedChannelId: YOUTUBE_ACCOUNT,
      authenticatedChannelId: YOUTUBE_ACCOUNT,
      safeChannelTitle: "CHANTER",
      safeChannelHandle: "@chanter",
      externalVideoId: "yt-provider-operation-video",
      expectedTitle: "Phase 2E-B private upload",
      exactTitleMatch: true,
      artifactExists: true,
      privacyStatus: "private",
      uploadStatus: "processed",
      processingStatus: "succeeded",
      verificationMethod: "youtube.videos.list+youtube.channels.list",
      verificationTimestamp: sourceRevision(revision),
      canonicalResponseSha256: "e".repeat(64),
    } : null,
    mutationSummary: {
      providerSessionInitiationCount: sessionStarted ? 1 : 0,
      mediaUploadAttemptCount: sessionStarted ? 1 : 0,
      confirmedVideoArtifactCount: artifactObserved ? 1 : 0,
      existingResourceUpdateCount: 0,
      deleteCount: 0,
      reconciliationStatusReadCount: sessionStarted ? 1 : 0,
    },
    reconciliationAttemptCount: sessionStarted ? 1 : 0,
    reconciliationAttemptBudget: 3,
    reconciliationLease: null,
    reconciliationFencingToken: 1,
    lastReconciledAt: sessionStarted ? sourceRevision(revision) : null,
    lastOperationErrorCode: completed ? null : state.toUpperCase(),
    eventCount: sessionStarted ? 6 : 2,
    eventDigestSha256: "f".repeat(64),
  };
}

async function completedGraph(harness: Harness, graphId = "phase2eb-graph"): Promise<void> {
  const submitted = harness.graphs.submitGraph(graphEnvelope(graphId));
  const approved = await harness.graphs.approveGraph(submitted.graphId, {
    approvedBy: "founder-phase2eb",
    graphHash: submitted.graphHash,
  });
  expect(approved.status, JSON.stringify(approved.nodes)).toBe("completed");
}

function tableRows(database: DatabaseSync, table: string): unknown[] {
  return database.prepare(`SELECT * FROM ${table} ORDER BY 1, 2`).all();
}

function eventCount(database: DatabaseSync, graphId: string): number {
  const row = database.prepare(
    "SELECT COUNT(*) AS count FROM operator_autoposter_result_events WHERE graph_id = ?",
  ).get(graphId) as { count: number };
  return Number(row.count);
}

describe("Phase 2E-B result refresh route capability isolation", () => {
  it("accepts only the operator control capability and mutates nothing on refusal", async () => {
    const boundary = makeBoundary();
    const harness = createHarness(boundary);
    await completedGraph(harness);
    const statusCallsBefore = boundary.statusCalls.length;

    const refusals: Array<[string, string | null]> = [
      ["missing token", null],
      ["mission submit token", SUBMIT_TOKEN],
      ["runtime service token", RUNTIME_TOKEN],
      ["ledger ingest token", LEDGER_TOKEN],
      ["wrong token", "not-a-real-token"],
    ];
    for (const [label, token] of refusals) {
      const req = request(harness.app).post("/api/mission-graphs/phase2eb-graph/autoposter-results/refresh");
      const response = await (token === null ? req : req.set("Authorization", `Bearer ${token}`)).send({});
      expect(response.status, label).toBe(401);
      expect(response.body.code, label).toBe("CAPABILITY_TOKEN_INVALID");
    }
    expect(boundary.statusCalls.length).toBe(statusCallsBefore);
    expect(eventCount(harness.database, "phase2eb-graph")).toBe(0);

    const accepted = await request(harness.app)
      .post("/api/mission-graphs/phase2eb-graph/autoposter-results/refresh")
      .set("Authorization", `Bearer ${CONTROL_TOKEN}`)
      .send({});
    expect(accepted.status).toBe(200);
    expect(accepted.body.graphId).toBe("phase2eb-graph");
    expect(accepted.body.results).toHaveLength(2);

    // The stored read model needs no capability and never touches the network.
    const callsAfterRefresh = boundary.statusCalls.length;
    const stored = await request(harness.app).get("/api/mission-graphs/phase2eb-graph/autoposter-results");
    expect(stored.status).toBe(200);
    expect(stored.body.nodes).toHaveLength(2);
    expect(stored.body.nodes[0].projection.projectionStatus).toBe("awaiting_publish_approval");
    expect(boundary.statusCalls.length).toBe(callsAfterRefresh);

    const missing = await request(harness.app)
      .post("/api/mission-graphs/unknown-graph/autoposter-results/refresh")
      .set("Authorization", `Bearer ${CONTROL_TOKEN}`)
      .send({});
    expect(missing.status).toBe(404);
  });

  it("refuses graphs without AutoPoster schedule nodes", async () => {
    const boundary = makeBoundary();
    const harness = createHarness(boundary);
    harness.graphs.submitGraph({
      schemaVersion: "chanter.mission.graph.v1",
      graphId: "phase2eb-loop-graph",
      traceId: "phase2eb-loop-trace",
      idempotencyKey: "phase2eb-loop-key",
      source: { system: "operator", requestedBy: "founder-phase2eb" },
      objective: "Loop-only graph without publishing results.",
      tenant: { userId: OWNER_ID },
      requestedAt: REQUESTED_AT,
      nodes: [{
        nodeId: "loop_node",
        target: { product: "loop_governor", action: "loop_governor.manual_loop.create" },
        objective: "Create one manual loop.",
        input: {
          appName: "chanter-operator",
          taskType: "review",
          goal: "No autoposter results here",
          scope: "phase2eb",
        },
        dependsOn: [],
      }],
    });
    await expect(harness.results.refreshGraphResults("phase2eb-loop-graph"))
      .rejects.toMatchObject({ code: "OPERATOR_GRAPH_RESULTS_NOT_APPLICABLE" });
  });
});

describe("Phase 2E-B idempotency and ordering contract", () => {
  it("first refresh persists, exact replay appends nothing, and graph truth stays byte-identical", async () => {
    const boundary = makeBoundary();
    const harness = createHarness(boundary);
    await completedGraph(harness);

    const graphsBefore = tableRows(harness.database, "operator_mission_graphs");
    const nodesBefore = tableRows(harness.database, "operator_mission_graph_nodes");
    const missionsBefore = tableRows(harness.database, "autoposter_runtime_missions");
    const executionsBefore = tableRows(harness.database, "autoposter_mission_executions");
    const journalBefore = tableRows(harness.database, "autoposter_mission_journal");
    const scheduleCallsBefore = boundary.scheduleCalls.length;

    const first = await harness.results.refreshGraphResults("phase2eb-graph");
    expect(first.results.map((result) => result.outcome)).toEqual(["refreshed", "refreshed"]);
    expect(first.results.map((result) => result.projectionStatus)).toEqual([
      "awaiting_publish_approval",
      "awaiting_publish_approval",
    ]);
    expect(first.batch.status).toBe("awaiting_results");
    expect(first.escalations.map((escalation) => escalation.reasonCode)).toEqual([
      "publish_approval_required",
      "publish_approval_required",
    ]);
    expect(first.escalations[0]!.severity).toBe("info");
    expect(first.escalations[0]!.canonicalInspection.adminRoutes).toEqual([
      "/private/autoposter",
      "/private/autoposter/dashboard",
    ]);
    expect(eventCount(harness.database, "phase2eb-graph")).toBe(2);

    // The executor preserved exact identity bytes on the read.
    const tiktokJob = boundary.jobByNode("tiktok_node");
    expect(boundary.statusCalls[0]).toEqual({
      userId: OWNER_ID,
      workspaceId: WORKSPACE_ID,
      postId: tiktokJob.id,
      accountId: TIKTOK_ACCOUNT,
    });

    const projectionsAfterFirst = tableRows(harness.database, "operator_autoposter_result_projections");
    const replay = await harness.results.refreshGraphResults("phase2eb-graph");
    expect(replay.results.map((result) => result.outcome)).toEqual(["replayed", "replayed"]);
    expect(replay.escalations).toEqual([]);
    expect(eventCount(harness.database, "phase2eb-graph")).toBe(2);
    expect(tableRows(harness.database, "operator_autoposter_result_projections"))
      .toEqual(projectionsAfterFirst);

    // Hard safety invariants: zero AutoPoster writes, zero provider calls,
    // zero child re-execution, graph/node execution truth untouched.
    expect(boundary.scheduleCalls.length).toBe(scheduleCallsBefore);
    expect(boundary.providerPublishCalls).toBe(0);
    expect(tableRows(harness.database, "operator_mission_graphs")).toEqual(graphsBefore);
    expect(tableRows(harness.database, "operator_mission_graph_nodes")).toEqual(nodesBefore);
    expect(tableRows(harness.database, "autoposter_runtime_missions")).toEqual(missionsBefore);
    expect(tableRows(harness.database, "autoposter_mission_executions")).toEqual(executionsBefore);
    expect(tableRows(harness.database, "autoposter_mission_journal")).toEqual(journalBefore);

    // The stored evidence is the canonical allowlisted snapshot — never the
    // full AutoPoster job (no caption, media, or lock-owner fields).
    const storedEvidence = JSON.stringify(projectionsAfterFirst);
    for (const forbidden of ["mediaUrl", "caption\":", "lockedBy", "hashtags"]) {
      expect(storedEvidence.includes(forbidden), forbidden).toBe(false);
    }
  });

  it("survives a process restart as exact replay", async () => {
    const boundary = makeBoundary();
    const harness = createHarness(boundary);
    await completedGraph(harness);
    const first = await harness.results.refreshGraphResults("phase2eb-graph");
    expect(first.results.map((result) => result.outcome)).toEqual(["refreshed", "refreshed"]);
    const projections = tableRows(harness.database, "operator_autoposter_result_projections");
    const databasePath = harness.databasePath;
    harness.close();

    const restarted = createHarness(boundary, databasePath);
    const replay = await restarted.results.refreshGraphResults("phase2eb-graph");
    expect(replay.results.map((result) => result.outcome)).toEqual(["replayed", "replayed"]);
    expect(eventCount(restarted.database, "phase2eb-graph")).toBe(2);
    expect(tableRows(restarted.database, "operator_autoposter_result_projections")).toEqual(projections);
  });

  it("adopts newer revisions, refuses older ones, and escalates same-revision contradictions", async () => {
    const boundary = makeBoundary();
    const harness = createHarness(boundary);
    await completedGraph(harness);
    await harness.results.refreshGraphResults("phase2eb-graph");
    const job = boundary.jobByNode("tiktok_node");

    // Newer revision: human approval landed in AutoPoster.
    boundary.setStatus(job.id, {
      approved: true,
      approvalState: "approved",
      approvedAt: sourceRevision(1),
      approvedBy: "founder@chanter",
      updatedAt: sourceRevision(2),
    });
    const approved = await harness.results.refreshGraphResults("phase2eb-graph");
    const approvedNode = approved.results.find((result) => result.nodeId === "tiktok_node")!;
    expect(approvedNode.outcome).toBe("refreshed");
    expect(approvedNode.projectionStatus).toBe("approved_for_publish");

    // Older revision must never overwrite the newer confirmed projection.
    boundary.setStatus(job.id, {
      approved: false,
      approvalState: "unapproved",
      approvedAt: null,
      approvedBy: "",
      updatedAt: sourceRevision(0),
    });
    const stale = await harness.results.refreshGraphResults("phase2eb-graph");
    const staleNode = stale.results.find((result) => result.nodeId === "tiktok_node")!;
    expect(staleNode.outcome).toBe("stale");
    expect(staleNode.projection!.projectionStatus).toBe("approved_for_publish");
    expect(staleNode.projection!.sourceUpdatedAt).toBe(sourceRevision(2));

    // Same revision, different canonical snapshot: contradiction, retained
    // confirmed evidence, manual review, exactly one contradiction event.
    boundary.setStatus(job.id, {
      approved: true,
      approvalState: "approved",
      approvedAt: sourceRevision(1),
      approvedBy: "founder@chanter",
      claimAttempts: 1,
      updatedAt: sourceRevision(2),
    });
    const eventsBefore = eventCount(harness.database, "phase2eb-graph");
    const contradiction = await harness.results.refreshGraphResults("phase2eb-graph");
    const contradictionNode = contradiction.results.find((result) => result.nodeId === "tiktok_node")!;
    expect(contradictionNode.outcome).toBe("failed");
    expect(contradictionNode.reasonCode).toBe("observation_contradiction");
    expect(contradictionNode.projection!.projectionStatus).toBe("manual_review_required");
    expect(contradictionNode.projection!.sourceStatus).toBe("scheduled");
    expect(contradictionNode.projection!.sourceUpdatedAt).toBe(sourceRevision(2));
    expect(contradiction.escalations.some(
      (escalation) => escalation.reasonCode === "observation_contradiction" && escalation.severity === "critical",
    )).toBe(true);
    expect(eventCount(harness.database, "phase2eb-graph")).toBe(eventsBefore + 1);

    // The identical contradicting read replays without a second event.
    await harness.results.refreshGraphResults("phase2eb-graph");
    expect(eventCount(harness.database, "phase2eb-graph")).toBe(eventsBefore + 1);

    // A genuinely newer valid observation recovers the projection.
    boundary.setStatus(job.id, {
      status: "processing",
      lockedAt: sourceRevision(3),
      claimAttempts: 1,
      updatedAt: sourceRevision(4),
    });
    const recovered = await harness.results.refreshGraphResults("phase2eb-graph");
    const recoveredNode = recovered.results.find((result) => result.nodeId === "tiktok_node")!;
    expect(recoveredNode.outcome).toBe("refreshed");
    expect(recoveredNode.projectionStatus).toBe("processing");
  });
});

describe("Phase 2E-B provider-specific projection and batch truth", () => {
  it("derives every projection state and the truthful batch summaries for mixed providers", async () => {
    const boundary = makeBoundary();
    const harness = createHarness(boundary);
    await completedGraph(harness);
    const tiktok = boundary.jobByNode("tiktok_node");
    const youtube = boundary.jobByNode("youtube_node");
    const refresh = () => harness.results.refreshGraphResults("phase2eb-graph");
    const statusOf = (response: Awaited<ReturnType<typeof refresh>>, nodeId: string) =>
      response.results.find((result) => result.nodeId === nodeId)!.projectionStatus;

    // Unapproved drafts -> awaiting approval; batch awaits results.
    const drafts = await refresh();
    expect(statusOf(drafts, "tiktok_node")).toBe("awaiting_publish_approval");
    expect(statusOf(drafts, "youtube_node")).toBe("awaiting_publish_approval");
    expect(drafts.batch.status).toBe("awaiting_results");

    const approvedFields = {
      approved: true,
      approvalState: "approved" as const,
      approvedAt: sourceRevision(1),
      approvedBy: "founder@chanter",
    };

    // Retry evidence and processing remain nonterminal.
    boundary.setStatus(tiktok.id, {
      ...approvedFields,
      claimAttempts: 1,
      lastResult: { code: "PROVIDER_5XX", message: "HTTP 502", willRetry: true },
      history: [{ at: sourceRevision(2), event: "retry_scheduled", detail: "Retrying in 5 minutes." }],
      updatedAt: sourceRevision(2),
    });
    boundary.setStatus(youtube.id, {
      ...approvedFields,
      status: "processing",
      lockedAt: sourceRevision(2),
      claimAttempts: 1,
      updatedAt: sourceRevision(2),
    });
    const inflight = await refresh();
    expect(statusOf(inflight, "tiktok_node")).toBe("retry_scheduled");
    expect(statusOf(inflight, "youtube_node")).toBe("processing");
    expect(inflight.batch.status).toBe("awaiting_results");
    expect(inflight.escalations).toEqual([]);

    // Reauthorization failure and ambiguous outcome escalate; the batch is
    // ambiguous whenever any node is ambiguous.
    boundary.setStatus(tiktok.id, {
      status: "failed",
      claimAttempts: 3,
      lastResult: { code: "PROVIDER_AUTH", message: "Reauthorize the TikTok account." },
      lastErrorMessage: "Reauthorize the TikTok account.",
      updatedAt: sourceRevision(3),
    });
    boundary.setStatus(youtube.id, {
      status: "outcome_unknown",
      providerStatus: "provider_reconciliation_required",
      lastResult: { code: "PROVIDER_RECONCILIATION_REQUIRED", outcomeUnknown: true },
      updatedAt: sourceRevision(3),
    });
    const troubled = await refresh();
    expect(statusOf(troubled, "tiktok_node")).toBe("failed");
    expect(statusOf(troubled, "youtube_node")).toBe("outcome_unknown");
    expect(troubled.batch.status).toBe("outcome_unknown");
    expect(troubled.escalations.map((escalation) => escalation.reasonCode).sort()).toEqual([
      "outcome_unknown",
      "provider_reauthorization_required",
    ]);
    expect(troubled.escalations.find((escalation) => escalation.reasonCode === "outcome_unknown")!.severity)
      .toBe("critical");

    // Posted YouTube work without private-upload proof fails closed.
    boundary.setStatus(youtube.id, {
      status: "posted",
      postedAt: sourceRevision(4),
      publishId: "",
      providerStatus: "",
      lastResult: { completedAt: sourceRevision(4) },
      updatedAt: sourceRevision(4),
    });
    const unproven = await refresh();
    expect(statusOf(unproven, "youtube_node")).toBe("manual_review_required");
    expect(unproven.batch.status).toBe("outcome_unknown");

    // Historical YouTube fields without a durable completed-private provider
    // operation remain explicitly legacy/unproven.
    boundary.setStatus(tiktok.id, {
      status: "posted",
      postedAt: sourceRevision(5),
      publishId: "tt-publish-9",
      lastResult: { mode: "api", completedAt: sourceRevision(5) },
      updatedAt: sourceRevision(5),
    });
    boundary.setStatus(youtube.id, {
      status: "posted",
      postedAt: sourceRevision(5),
      publishId: "yt-video-123",
      providerStatus: "uploaded_private",
      providerVerification: {
        provider: "youtube",
        externalVideoId: "yt-video-123",
        channelId: YOUTUBE_ACCOUNT,
        channelTitle: "CHANTER",
        channelHandle: "@chantercy",
        title: "Phase 2E-B private upload",
        privacyStatus: "private",
        uploadStatus: "processed",
        processingStatus: "succeeded",
        verifiedAt: sourceRevision(5),
        uploadMethod: "resumable",
      },
      lastResult: { completedAt: sourceRevision(5) },
      updatedAt: sourceRevision(5),
    });
    const terminal = await refresh();
    expect(statusOf(terminal, "tiktok_node")).toBe("provider_accepted_unverified");
    expect(statusOf(terminal, "youtube_node")).toBe("manual_review_required");
    expect(terminal.batch.status).toBe("outcome_unknown");
    expect(terminal.escalations.map((item) => item.reasonCode)).toContain("legacy_unproven");

    // A later human manual assertion is a manual reconciliation, not
    // provider verification.
    boundary.setStatus(tiktok.id, {
      lastResult: { mode: "manual", message: "Marked posted manually", completedAt: sourceRevision(6) },
      history: [{ at: sourceRevision(6), event: "marked_posted", detail: "Human assertion." }],
      updatedAt: sourceRevision(6),
    });
    const manual = await refresh();
    expect(statusOf(manual, "tiktok_node")).toBe("manually_reconciled");
    expect(manual.batch.status).toBe("outcome_unknown");

    const totals = manual.batch.totals;
    expect(totals.manually_reconciled).toBe(1);
    expect(totals.manual_review_required).toBe(1);
  });

  it("reconciles one exact durable provider operation and escalates provider contradictions", async () => {
    const boundary = makeBoundary();
    let harness = createHarness(boundary);
    await completedGraph(harness, "phase2eb-provider-operation");
    const youtube = boundary.jobByNode("youtube_node", "phase2eb-provider-operation");
    const completed = youtubeProviderOperation(youtube, "completed_private", 1);
    boundary.setStatus(youtube.id, {
      approved: true,
      approvalState: "approved",
      approvedAt: sourceRevision(1),
      approvedBy: "founder-provider-proof",
      status: "posted",
      postedAt: sourceRevision(1),
      publishId: "yt-provider-operation-video",
      providerStatus: "uploaded_private",
      providerOperation: completed,
      providerVerification: {
        provider: "youtube",
        externalVideoId: "yt-provider-operation-video",
        channelId: YOUTUBE_ACCOUNT,
        channelTitle: "CHANTER",
        channelHandle: "@chanter",
        title: "Phase 2E-B private upload",
        privacyStatus: "private",
        uploadStatus: "processed",
        processingStatus: "succeeded",
        verifiedAt: sourceRevision(1),
        uploadMethod: "resumable",
      },
      claimAttempts: 1,
      publishAttemptBudget: 1,
      attemptBudgetExhausted: true,
      lastResult: { completedAt: sourceRevision(1), willRetry: false },
      updatedAt: sourceRevision(1),
    });

    const first = await harness.results.refreshGraphResults("phase2eb-provider-operation");
    const firstNode = first.results.find((result) => result.nodeId === "youtube_node")!;
    expect(firstNode.projectionStatus, JSON.stringify(firstNode)).toBe("uploaded_private");
    expect(boundary.reconciliationCalls).toEqual([]);
    const persisted = harness.results.getProjections("phase2eb-provider-operation").nodes
      .find((node) => node.nodeId === "youtube_node")!.projection!;
    const snapshot = (persisted.evidence as { snapshot: AutoPosterPostStatusView }).snapshot;
    expect(snapshot.providerOperation?.providerStatusReceiptSha256).toBe("d".repeat(64));
    expect(snapshot.providerOperation?.providerStatusReceipt?.externalVideoId).toBe("yt-provider-operation-video");

    const eventsAfterFirst = eventCount(harness.database, "phase2eb-provider-operation");
    const replay = await harness.results.refreshGraphResults("phase2eb-provider-operation");
    expect(replay.results.find((result) => result.nodeId === "youtube_node")!.outcome).toBe("replayed");
    expect(eventCount(harness.database, "phase2eb-provider-operation")).toBe(eventsAfterFirst);

    const databasePath = harness.databasePath;
    harness.close();
    harness = createHarness(boundary, databasePath);
    const restarted = await harness.results.refreshGraphResults("phase2eb-provider-operation");
    expect(restarted.results.find((result) => result.nodeId === "youtube_node")!.outcome).toBe("replayed");

    const badReceipt = youtubeProviderOperation(youtube, "completed_private", 2);
    badReceipt.providerStatusReceipt!.externalVideoId = "different-video";
    boundary.setStatus(youtube.id, { providerOperation: badReceipt, updatedAt: sourceRevision(2) });
    const identityMismatch = await harness.results.refreshGraphResults("phase2eb-provider-operation");
    const mismatchNode = identityMismatch.results.find((result) => result.nodeId === "youtube_node")!;
    expect(mismatchNode.reasonCode).toBe("result_identity_mismatch");
    expect(mismatchNode.projectionStatus).toBe("manual_review_required");

    boundary.setStatus(youtube.id, {
      status: "outcome_unknown",
      postedAt: null,
      publishId: "",
      providerStatus: "provider_missing",
      providerOperation: youtubeProviderOperation(youtube, "provider_missing", 3),
      updatedAt: sourceRevision(3),
    });
    const missing = await harness.results.refreshGraphResults("phase2eb-provider-operation");
    const missingNode = missing.results.find((result) => result.nodeId === "youtube_node")!;
    expect(missingNode.projectionStatus).toBe("outcome_unknown");
    expect(missing.escalations.some((item) => item.reasonCode === "provider_missing")).toBe(true);

    boundary.setStatus(youtube.id, {
      status: "posted",
      postedAt: sourceRevision(4),
      publishId: "yt-provider-operation-video",
      providerStatus: "contradictory_public",
      providerOperation: youtubeProviderOperation(youtube, "contradictory_public", 4),
      updatedAt: sourceRevision(4),
    });
    const publicResult = await harness.results.refreshGraphResults("phase2eb-provider-operation");
    const publicNode = publicResult.results.find((result) => result.nodeId === "youtube_node")!;
    expect(publicNode.projectionStatus).toBe("manual_review_required");
    expect(publicResult.escalations.some((item) => item.reasonCode === "provider_visibility_contradiction")).toBe(true);

    boundary.setStatus(youtube.id, {
      status: "outcome_unknown",
      postedAt: null,
      publishId: "",
      providerStatus: "provider_reconciliation_required",
      providerOperation: youtubeProviderOperation(youtube, "outcome_unknown", 5),
      updatedAt: sourceRevision(5),
    });
    const ambiguous = await harness.results.refreshGraphResults("phase2eb-provider-operation");
    const ambiguousNode = ambiguous.results.find((result) => result.nodeId === "youtube_node")!;
    expect(ambiguousNode.projectionStatus).toBe("outcome_unknown");
    expect(ambiguous.escalations.some((item) => item.reasonCode === "provider_operation_ambiguous")).toBe(true);
  });

  it("classifies media failures and revoked approvals with their exact reasons", async () => {
    const boundary = makeBoundary();
    const harness = createHarness(boundary);
    await completedGraph(harness, "phase2eb-reasons");
    const tiktok = boundary.jobByNode("tiktok_node", "phase2eb-reasons");
    const youtube = boundary.jobByNode("youtube_node", "phase2eb-reasons");

    boundary.setStatus(tiktok.id, {
      status: "failed",
      lastResult: { code: "MEDIA_DOWNLOAD_FAILED", message: "The media file could not be downloaded." },
      lastErrorMessage: "The media file could not be downloaded.",
      updatedAt: sourceRevision(1),
    });
    boundary.setStatus(youtube.id, {
      history: [{ at: sourceRevision(1), event: "approval_revoked", detail: "Approval removed." }],
      updatedAt: sourceRevision(1),
    });
    const response = await harness.results.refreshGraphResults("phase2eb-reasons");
    const reasons = response.escalations.map((escalation) => escalation.reasonCode).sort();
    expect(reasons).toEqual(["media_unavailable", "publish_approval_revoked"]);
    const media = response.escalations.find((escalation) => escalation.reasonCode === "media_unavailable")!;
    expect(media.errorCode).toBe("MEDIA_DOWNLOAD_FAILED");
    expect(media.recommendedHumanAction).toMatch(/repair or replace the media/i);
    expect(media.queueJobId).toBe(tiktok.id);
  });
});

describe("Phase 2E-B identity fail-closed behavior", () => {
  it("persists manual review on queue/identity substitution and recovers on later valid truth", async () => {
    const boundary = makeBoundary();
    const harness = createHarness(boundary);
    await completedGraph(harness);
    const tiktok = boundary.jobByNode("tiktok_node");

    // A missing bound job is a durable identity verdict, not a transient error.
    boundary.statusFailures.set(tiktok.id, { ok: false, code: "not_found", message: "not found" });
    const missing = await harness.results.refreshGraphResults("phase2eb-graph");
    const missingNode = missing.results.find((result) => result.nodeId === "tiktok_node")!;
    expect(missingNode.outcome).toBe("failed");
    expect(missingNode.reasonCode).toBe("result_identity_mismatch");
    expect(missingNode.projection!.projectionStatus).toBe("manual_review_required");
    expect(missing.escalations.some(
      (escalation) => escalation.reasonCode === "result_identity_mismatch",
    )).toBe(true);
    // The other node's observation succeeded independently (partial batch).
    expect(missing.results.find((result) => result.nodeId === "youtube_node")!.outcome).toBe("refreshed");
    expect(missing.escalations.some((escalation) => escalation.reasonCode === "partial_batch")).toBe(true);
    boundary.statusFailures.delete(tiktok.id);

    // Later valid truth recovers the projection from the mismatch verdict.
    boundary.setStatus(tiktok.id, { updatedAt: sourceRevision(1) });
    const recovered = await harness.results.refreshGraphResults("phase2eb-graph");
    expect(recovered.results.find((result) => result.nodeId === "tiktok_node")!.projectionStatus)
      .toBe("awaiting_publish_approval");

    const substitutions: Array<[string, Partial<AutoPosterPostStatusView>]> = [
      ["account substitution", { accountId: "other-account", connectedAccountId: "tiktok:other-account" }],
      ["workspace substitution", { workspaceId: "workspace-other" }],
      ["provider substitution", { provider: "youtube", connectedAccountId: `youtube:${TIKTOK_ACCOUNT}` }],
      ["runtime mission substitution", { runtimeMissionId: "graph:other:node:x" }],
      ["runtime idempotency substitution", { runtimeIdempotencyKey: "graph:other:node:x" }],
      ["runtime action substitution", { runtimeAction: "autoposter.queue.list" }],
    ];
    for (const [index, [label, overrides]] of substitutions.entries()) {
      boundary.setStatus(tiktok.id, { ...overrides, updatedAt: sourceRevision(10 + index * 2) });
      const mismatch = await harness.results.refreshGraphResults("phase2eb-graph");
      const node = mismatch.results.find((result) => result.nodeId === "tiktok_node")!;
      expect(node.outcome, label).toBe("failed");
      expect(node.reasonCode, label).toBe("result_identity_mismatch");
      expect(node.projection!.projectionStatus, label).toBe("manual_review_required");
      // A strictly newer valid observation recovers the projection before
      // the next substitution case.
      boundary.statusViews.delete(tiktok.id);
      boundary.setStatus(tiktok.id, { updatedAt: sourceRevision(11 + index * 2) });
      const reset = await harness.results.refreshGraphResults("phase2eb-graph");
      expect(reset.results.find((result) => result.nodeId === "tiktok_node")!.outcome, label)
        .toBe("refreshed");
    }
  });

  it("fails closed when local schedule evidence disagrees about the queue binding", async () => {
    const boundary = makeBoundary();
    const harness = createHarness(boundary);
    await completedGraph(harness);
    harness.database.prepare(`
      UPDATE operator_mission_graph_nodes
         SET result_summary_json = json_set(result_summary_json, '$.queueDraftId', 'tampered-queue-id')
       WHERE graph_id = 'phase2eb-graph' AND node_id = 'tiktok_node'
    `).run();

    const statusCallsBefore = boundary.statusCalls.length;
    const response = await harness.results.refreshGraphResults("phase2eb-graph");
    const node = response.results.find((result) => result.nodeId === "tiktok_node")!;
    expect(node.outcome).toBe("failed");
    expect(node.reasonCode).toBe("result_identity_mismatch");
    expect(node.projection!.projectionStatus).toBe("manual_review_required");
    // The contradiction was detected before any network read for that node.
    expect(boundary.statusCalls.filter((call) => call.postId === "tampered-queue-id")).toHaveLength(0);
    expect(boundary.statusCalls.length - statusCallsBefore).toBe(1);
  });

  it("requires completed schedule evidence before collecting anything", async () => {
    const boundary = makeBoundary();
    const harness = createHarness(boundary);
    harness.graphs.submitGraph(graphEnvelope("phase2eb-unapproved"));
    const response = await harness.results.refreshGraphResults("phase2eb-unapproved");
    expect(response.results.map((result) => result.outcome)).toEqual(["failed", "failed"]);
    expect(response.results.map((result) => result.reasonCode)).toEqual([
      "schedule_evidence_missing",
      "schedule_evidence_missing",
    ]);
    expect(boundary.statusCalls).toHaveLength(0);
    expect(eventCount(harness.database, "phase2eb-unapproved")).toBe(0);
    expect(response.batch.status).toBe("awaiting_results");
  });
});

describe("Phase 2E-B collection failure independence", () => {
  it("preserves confirmed projections through transport and contract failures", async () => {
    const boundary = makeBoundary();
    const harness = createHarness(boundary);
    await completedGraph(harness);
    await harness.results.refreshGraphResults("phase2eb-graph");
    const tiktok = boundary.jobByNode("tiktok_node");
    const projectionsBefore = tableRows(harness.database, "operator_autoposter_result_projections");
    const eventsBefore = eventCount(harness.database, "phase2eb-graph");

    const failures: AutoPosterPortFailure[] = [
      { ok: false, code: "unavailable", message: "AutoPoster timed out after 10000ms." },
      {
        ok: false,
        code: "invalid_response",
        reasonCode: "status_contract_violation",
        message: "AutoPoster returned an unknown queue lifecycle status.",
      },
      { ok: false, code: "unauthorized", message: "A valid runtime control token is required." },
    ];
    for (const failure of failures) {
      boundary.statusFailures.set(tiktok.id, failure);
      const response = await harness.results.refreshGraphResults("phase2eb-graph");
      const node = response.results.find((result) => result.nodeId === "tiktok_node")!;
      expect(node.outcome, failure.code).toBe("failed");
      expect(node.reasonCode, failure.code).toBe("result_collection_unavailable");
      // Last confirmed projection is preserved and returned, never relabeled.
      expect(node.projection!.projectionStatus, failure.code).toBe("awaiting_publish_approval");
      expect(response.results.find((result) => result.nodeId === "youtube_node")!.outcome).toBe("replayed");
      expect(response.escalations.map((escalation) => escalation.reasonCode).sort()).toEqual([
        "partial_batch",
        "result_collection_unavailable",
      ]);
      expect(tableRows(harness.database, "operator_autoposter_result_projections"))
        .toEqual(projectionsBefore);
      expect(eventCount(harness.database, "phase2eb-graph")).toBe(eventsBefore);
    }
  });
});
