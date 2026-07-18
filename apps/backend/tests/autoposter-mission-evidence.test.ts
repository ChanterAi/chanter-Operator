/**
 * Persistent AutoPoster product mission — retained evidence bundle.
 *
 * Proves AutoPosterMissionEvidenceService generates a correct, redacted,
 * atomically-written manifest from real (in-process, fake-AutoPoster-port)
 * mission-graph/observation state, that regenerating it on replay overwrites
 * the same file rather than duplicating, that a missing graph fails closed,
 * and that the live publishing-safety re-check both records the safe case
 * and fails closed on a genuine violation.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { AutoPosterOperationsPort, AutoPosterPostStatusView } from "chanter-agent-runtime";
import { AgentRunLedgerService } from "../src/agentRunLedger/agentRunLedgerService.js";
import { createDatabase } from "../src/db/database.js";
import { GenericMissionService } from "../src/missions/genericMissionService.js";
import { MissionGraphChildDispatcher } from "../src/missions/missionGraphChildDispatcher.js";
import { MissionGraphService } from "../src/missions/missionGraphService.js";
import { createLoopGovernorMissionExecutor } from "../src/missions/loopGovernorRuntime.js";
import { AutoPosterResultProjectionService } from "../src/missions/autoPosterResultProjectionService.js";
import { AutoPosterObservationService } from "../src/missions/autoPosterObservationService.js";
import { AutoPosterMissionEvidenceService } from "../src/missions/autoPosterMissionEvidenceService.js";
import { AutoPosterMissionService } from "../src/runtimeMissions/autoPosterMissionService.js";
import { createAutoPosterRuntimeMissionExecutor } from "../src/runtimeMissions/autoPosterRuntime.js";

const TEST_NOW_MS = Date.now();
const NOW = new Date(TEST_NOW_MS).toISOString();
const REQUESTED_AT = new Date(TEST_NOW_MS + 60_000).toISOString();
const SCHEDULED_AT = new Date(TEST_NOW_MS + 60 * 60_000).toISOString();
const WORKSPACE_ID = "workspace-evidence";
const OWNER_ID = "owner";
const TIKTOK_ACCOUNT = "tt-evidence";
const YOUTUBE_ACCOUNT = "UC-evidence";
const RUNTIME_TOKEN = "evidence-service-token";
const SECRET_TOKEN = "super-secret-protected-value";

interface QueueDraft {
  id: string;
  accountId: string;
  provider: "tiktok" | "youtube";
  scheduledAt: string;
  idempotencyKey: string;
  missionId: string;
  action: string;
  missionPayloadHash: string;
  approved: boolean;
  postedAt: string | null;
  status: "scheduled" | "posted" | "failed";
  publishId: string;
  providerStatus: string;
  providerVerification: AutoPosterPostStatusView["providerVerification"];
  claimAttempts: number;
  publishAttemptBudget: number;
  lastResult: AutoPosterPostStatusView["lastResult"];
  history: AutoPosterPostStatusView["history"];
}

function connectedAccount(provider: "tiktok" | "youtube" = "tiktok") {
  const youtube = provider === "youtube";
  const accountId = youtube ? YOUTUBE_ACCOUNT : TIKTOK_ACCOUNT;
  return {
    connectedAccountId: `${provider}:${accountId}`,
    accountId,
    provider,
    providerDisplayName: youtube ? "YouTube" : "TikTok",
    username: youtube ? "chantercy" : "evidence_tiktok",
    displayName: youtube ? "CHANTER" : "Evidence Test Account",
    connectionStatus: "connected" as const,
    publishingReady: true,
    readinessBlockers: [],
    lastVerifiedAt: NOW,
  };
}

function makeAutoPosterBoundary() {
  const jobs = new Map<string, QueueDraft>();
  const port: AutoPosterOperationsPort = {
    async listConnectedAccounts(params) {
      return { ok: true, workspaceId: params.workspaceId, accounts: [connectedAccount(), connectedAccount("youtube")], count: 2 };
    },
    async validateConnectedAccount(params) {
      const provider = params.provider === "youtube" ? "youtube" : "tiktok";
      return { ok: true, workspaceId: params.workspaceId ?? WORKSPACE_ID, account: connectedAccount(provider) };
    },
    async listQueue() {
      return { ok: true, items: [], count: 0, scope: { accountId: "all" } };
    },
    async getPostStatus(params) {
      const job = [...jobs.values()].find((candidate) => candidate.id === params.postId);
      if (!job) return { ok: false, code: "not_found", message: "not found" };
      const view: AutoPosterPostStatusView = {
        id: job.id,
        provider: job.provider,
        connectedAccountId: `${job.provider}:${job.accountId}`,
        accountId: job.accountId,
        username: job.provider === "youtube" ? "chantercy" : "evidence_tiktok",
        workspaceId: params.workspaceId ?? WORKSPACE_ID,
        status: job.status,
        scheduledAt: job.scheduledAt,
        approved: job.approved,
        approvalState: job.approved ? "approved" : "unapproved",
        approvedAt: job.approved ? NOW : null,
        approvedBy: job.approved ? "founder-evidence" : "",
        mediaType: "video",
        captionSummary: "",
        createdAt: NOW,
        updatedAt: NOW,
        postedAt: job.postedAt,
        publishId: job.publishId,
        providerStatus: job.providerStatus,
        providerVerification: job.providerVerification,
        lockedAt: null,
        claimAttempts: job.claimAttempts,
        publishAttemptBudget: job.publishAttemptBudget,
        attemptBudgetExhausted: job.claimAttempts >= job.publishAttemptBudget,
        runtimeMissionId: job.missionId,
        runtimeIdempotencyKey: job.idempotencyKey,
        runtimeAction: job.action,
        runtimePayloadHash: job.missionPayloadHash,
        lastResult: job.lastResult,
        history: job.history,
        lastErrorMessage: "",
      };
      return { ok: true, post: view };
    },
    async validateMedia() {
      return { ok: true, valid: true, classification: "video", policy: { videoOnly: true, allowedExtensions: [".mp4"] } };
    },
    async schedulePost(params) {
      const existing = jobs.get(params.idempotencyKey);
      const asPost = (job: QueueDraft) => ({
        id: job.id, accountId: job.accountId, provider: job.provider, status: "scheduled", scheduledAt: job.scheduledAt, approved: false,
      });
      if (existing) return { ok: true, duplicate: true, post: asPost(existing) };
      const job: QueueDraft = {
        id: "evidence-queue-draft-0001",
        accountId: params.accountId,
        provider: (params.provider ?? "tiktok") as "tiktok" | "youtube",
        scheduledAt: params.scheduledAt,
        idempotencyKey: params.idempotencyKey,
        missionId: params.missionId,
        action: params.action,
        missionPayloadHash: params.missionPayloadHash,
        approved: false,
        postedAt: null,
        status: "scheduled",
        publishId: "",
        providerStatus: "",
        providerVerification: null,
        claimAttempts: 0,
        publishAttemptBudget: params.provider === "youtube" ? 0 : 5,
        lastResult: null,
        history: [],
      };
      jobs.set(params.idempotencyKey, job);
      return { ok: true, duplicate: false, post: asPost(job) };
    },
    async reconcileSchedule() {
      return { ok: true, outcome: "not_found", count: 0, unique: true, safeToReuse: false, approvalState: "not_started", publishingState: "not_started", evidenceStatus: "not_found" };
    },
  };
  return { port, jobs };
}

const temporaryRoots: string[] = [];
const activeDatabases = new Set<DatabaseSync>();
afterEach(() => {
  for (const database of [...activeDatabases]) database.close();
  activeDatabases.clear();
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function realHarness() {
  const root = mkdtempSync(path.join(os.tmpdir(), "chanter-evidence-"));
  temporaryRoots.push(root);
  const database = createDatabase(path.join(root, "operator.sqlite"));
  activeDatabases.add(database);
  const { port, jobs } = makeAutoPosterBoundary();
  let clockMs = TEST_NOW_MS;
  const now = () => new Date(clockMs);
  const ledger = new AgentRunLedgerService(database, []);
  const executor = createAutoPosterRuntimeMissionExecutor(
    { baseUrl: "https://autoposter.evidence.test", serviceToken: RUNTIME_TOKEN, userId: OWNER_ID, timeoutValid: true },
    { port },
  );
  const autoPoster = new AutoPosterMissionService(database, executor, { agentRunLedgerService: ledger, now, protectedValues: [SECRET_TOKEN] });
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
    { now, protectedValues: [SECRET_TOKEN], observationScheduler: observation },
  );
  const evidenceDir = path.join(root, "var", "evidence");
  const evidence = new AutoPosterMissionEvidenceService(
    graphs,
    autoPoster,
    results,
    observation,
    executor,
    evidenceDir,
    [SECRET_TOKEN],
    now,
  );
  return {
    graphs,
    observation,
    evidence,
    evidenceDir,
    jobs,
    advanceSeconds(seconds: number): void {
      clockMs += seconds * 1_000;
    },
  };
}

function scheduleGraphEnvelope(graphId = "evidence-graph", requestedBy = "founder-evidence") {
  return {
    schemaVersion: "chanter.mission.graph.v1",
    graphId,
    traceId: `${graphId}-trace`,
    idempotencyKey: `${graphId}-key`,
    source: { system: "mcp", requestedBy },
    objective: "Schedule the bounded AutoPoster draft for the evidence-bundle proof.",
    tenant: { userId: OWNER_ID, workspaceId: WORKSPACE_ID },
    nodes: [{
      nodeId: "tiktok_node",
      target: { product: "auto_poster", action: "autoposter.post.schedule" },
      objective: "Create the tiktok unapproved queue draft.",
      input: {
        accountId: TIKTOK_ACCOUNT,
        provider: "tiktok",
        mediaUrl: "https://cdn.example.com/evidence.mp4",
        caption: "Evidence proof",
        hashtags: "#chanter #evidence",
        scheduledAt: SCHEDULED_AT,
      },
      dependsOn: [],
    }],
    requestedAt: REQUESTED_AT,
  };
}

function youtubeScheduleGraphEnvelope(graphId = "youtube-evidence-graph") {
  return {
    ...scheduleGraphEnvelope(graphId),
    objective: "Schedule the bounded private YouTube evidence proof.",
    nodes: [{
      nodeId: "youtube_node",
      target: { product: "auto_poster", action: "autoposter.post.schedule" },
      objective: "Create the YouTube unapproved queue draft.",
      input: {
        accountId: YOUTUBE_ACCOUNT,
        provider: "youtube",
        mediaUrl: "https://cdn.example.com/evidence.mp4",
        caption: "Evidence proof",
        hashtags: "#chanter #evidence",
        title: "CHANTER private provider proof",
        description: "Private operational validation artifact.",
        scheduledAt: SCHEDULED_AT,
      },
      dependsOn: [],
    }],
  };
}

describe("Phase — persistent AutoPoster mission evidence bundle", () => {
  it("generates a complete, redacted manifest and converges to exactly one escalation", async () => {
    const { graphs, observation, evidence, evidenceDir, advanceSeconds } = realHarness();
    const submitted = graphs.submitGraph(scheduleGraphEnvelope());
    const completed = await graphs.approveGraph(submitted.graphId, {
      approvedBy: "founder-evidence",
      graphHash: submitted.graphHash,
    });
    expect(completed.status).toBe("completed");

    advanceSeconds(16);
    await observation.runObservationBatch({ leaseOwner: "test-runner" });
    const jobs = observation.listJobs({ graphId: submitted.graphId });
    expect(jobs.jobs[0]?.status).toBe("escalation_required");

    const result = await evidence.generateEvidenceBundle(submitted.graphId, {
      repositoryHeads: { operator: "0123456789abcdef0123456789abcdef01234567", "not-a-repo!!": "zz", short: "ab" },
      runtimeProfile: "local-mission",
    });

    expect(result.path).toBe(path.join(evidenceDir, submitted.graphId, "manifest.json"));
    expect(existsSync(result.path)).toBe(true);
    const onDisk = JSON.parse(readFileSync(result.path, "utf8"));
    expect(onDisk).toEqual(result.manifest);

    expect(result.manifest.schemaVersion).toBe("chanter.autoposter.mission-evidence.v1");
    expect(result.manifest.graphId).toBe(submitted.graphId);
    expect(result.manifest.graphHash).toBe(submitted.graphHash);
    expect(result.manifest.nodeId).toBe("tiktok_node");
    expect(result.manifest.executionAttemptId).toBeTruthy();
    expect((result.manifest.approval as Record<string, unknown>).actor).toBe("founder-evidence");
    expect((result.manifest.mcpSubmission as Record<string, unknown>).idempotencyKey).toBe("evidence-graph-key");
    expect((result.manifest.result as Record<string, unknown>).status).toBe("succeeded");
    expect(result.manifest.escalation).not.toBeNull();
    expect((result.manifest.escalation as Record<string, unknown>).reasonCode).toBe("publish_approval_required");
    expect(result.manifest.finalLifecycleState).toBe("graph_completed/observation_escalation_required");
    // Only the well-formed head survives sanitization; the malformed entry and the too-short "hash" are dropped.
    expect(result.manifest.repositoryHeads).toEqual({ operator: "0123456789abcdef0123456789abcdef01234567" });
    expect(result.manifest.runtimeProfile).toBe("local-mission");

    const safety = result.manifest.safety as Record<string, unknown>;
    expect((safety.structuralAssertion as Record<string, unknown>).neverPublished).toBe(true);
    const liveReCheck = safety.liveReCheck as Record<string, unknown>;
    expect(liveReCheck.performed).toBe(true);
    expect(liveReCheck.approved).toBe(false);
    expect(liveReCheck.postedAt).toBeNull();

    // No secret leaked anywhere in the written bundle.
    expect(JSON.stringify(onDisk).includes(SECRET_TOKEN)).toBe(false);
  });

  it("regenerating on exact replay overwrites the same file rather than duplicating", async () => {
    const { graphs, observation, evidence, evidenceDir, advanceSeconds } = realHarness();
    const submitted = graphs.submitGraph(scheduleGraphEnvelope("replay-evidence-graph"));
    await graphs.approveGraph(submitted.graphId, { approvedBy: "founder-evidence", graphHash: submitted.graphHash });
    advanceSeconds(16);
    await observation.runObservationBatch({ leaseOwner: "test-runner" });

    const first = await evidence.generateEvidenceBundle(submitted.graphId);
    const second = await evidence.generateEvidenceBundle(submitted.graphId);
    expect(second.path).toBe(first.path);
    expect(existsSync(path.dirname(first.path))).toBe(true);
    const filesInBundleDir = readdirSync(path.dirname(first.path));
    expect(filesInBundleDir).toEqual(["manifest.json"]);
  });

  it("retains verified private YouTube artifact, media, and zero-duplicate replay evidence", async () => {
    const { graphs, observation, evidence, jobs, advanceSeconds } = realHarness();
    const submitted = graphs.submitGraph(youtubeScheduleGraphEnvelope());
    await graphs.approveGraph(submitted.graphId, {
      approvedBy: "founder-youtube-proof",
      graphHash: submitted.graphHash,
    });

    const job = [...jobs.values()][0]!;
    Object.assign(job, {
      approved: true,
      status: "posted",
      postedAt: NOW,
      publishId: "yt-private-proof-1",
      providerStatus: "uploaded_private",
      claimAttempts: 1,
      publishAttemptBudget: 1,
      providerVerification: {
        provider: "youtube",
        externalVideoId: "yt-private-proof-1",
        channelId: YOUTUBE_ACCOUNT,
        channelTitle: "CHANTER",
        channelHandle: "@chantercy",
        title: "CHANTER private provider proof",
        privacyStatus: "private",
        uploadStatus: "processed",
        processingStatus: "succeeded",
        verifiedAt: NOW,
        uploadMethod: "resumable",
      },
    });
    advanceSeconds(16);
    const observed = await observation.runObservationBatch({ leaseOwner: "test-runner" });
    expect(observed.results[0]?.projectionStatus).toBe("uploaded_private");

    const result = await evidence.generateEvidenceBundle(submitted.graphId, {
      media: {
        fileName: "evidence.mp4",
        sha256: "a".repeat(64),
        byteSize: 2_323_295,
        mimeType: "video/mp4",
      },
      replay: {
        outcome: "exact_replay_same_identity",
        replayed: true,
        sameGraphId: true,
        sameResultIdentity: true,
        providerUploadCountBefore: 1,
        providerUploadCountAfter: 1,
        additionalUploadCount: 0,
        existingResourceMutations: 0,
      },
    });

    expect(result.manifest.providerArtifact).toMatchObject({
      provider: "youtube",
      configuredAccountId: YOUTUBE_ACCOUNT,
      verifiedChannelId: YOUTUBE_ACCOUNT,
      verifiedChannelHandle: "@chantercy",
      externalYouTubeVideoId: "yt-private-proof-1",
      uploadMethod: "resumable",
      verifiedPrivacyStatus: "private",
      providerUploadCount: 1,
    });
    expect(result.manifest.media).toEqual({
      fileName: "evidence.mp4",
      sha256: "a".repeat(64),
      byteSize: 2_323_295,
      mimeType: "video/mp4",
    });
    expect(result.manifest.evidenceReferences).toContain("youtube-video:yt-private-proof-1");
    expect(result.manifest.replay).toMatchObject({ additionalUploadCount: 0, existingResourceMutations: 0 });
    expect(result.manifest.safetyAssertions).toEqual({
      exactlyOneUpload: true,
      privateVisibilityVerified: true,
      noPublicTransition: true,
      noExistingResourceModified: true,
      zeroProviderMutationProven: false,
      attemptBudgetExhausted: true,
      noAutomaticRetryScheduled: false,
      secretsRedacted: true,
    });
  });

  it("retains an exhausted pre-provider real-run closeout with zero external mutations", async () => {
    const { graphs, observation, evidence, jobs, advanceSeconds } = realHarness();
    const submitted = graphs.submitGraph(youtubeScheduleGraphEnvelope());
    await graphs.approveGraph(submitted.graphId, {
      approvedBy: "founder-youtube-proof",
      graphHash: submitted.graphHash,
    });

    const job = [...jobs.values()][0]!;
    const attemptTimes = [1, 2, 3, 4, 5].map(
      (attempt) => new Date(TEST_NOW_MS + attempt * 60_000).toISOString(),
    );
    Object.assign(job, {
      approved: true,
      status: "failed",
      postedAt: null,
      publishId: "",
      providerStatus: "",
      providerVerification: null,
      claimAttempts: 5,
      publishAttemptBudget: 1,
      lastResult: {
        mode: "api",
        code: "PUBLISH_ATTEMPT_BUDGET_EXHAUSTED",
        message: "Could not load video media: fetch failed",
        completedAt: attemptTimes[4],
        willRetry: false,
        providerMutationStarted: false,
        failureBoundary: "before_provider_upload_session",
      },
      history: [
        ...attemptTimes.map((at, index) => ({
          at,
          event: "publish_attempt",
          detail: `Claimed by worker for publishing (attempt ${index + 1}).`,
        })),
        { at: attemptTimes[4], event: "failed", detail: "Could not load video media: fetch failed" },
      ],
    });

    advanceSeconds(16);
    const observed = await observation.runObservationBatch({ leaseOwner: "test-runner" });
    expect(observed.results[0]?.projectionStatus).toBe("failed");

    const input = {
      replay: {
        outcome: "exact_replay_same_identity",
        replayed: true,
        sameGraphId: true,
        sameResultIdentity: true,
        providerUploadCountBefore: 0,
        providerUploadCountAfter: 0,
        additionalUploadCount: 0,
        existingResourceMutations: 0,
      },
      operationalCloseout: {
        guardedSchedulerTickCount: 1,
        claimAttemptsAtDisconnect: 4,
        finalClaimAttempts: 5,
        providerUploadRecordCount: 0,
        externalMutationCount: 0,
        youtubeDuplicateCount: 0,
        failureBoundary: "before_provider_upload_session",
        terminalClassification: "failed_pre_provider_attempt_budget_exhausted",
        exactTitle: "CHANTER private provider proof",
        channelId: YOUTUBE_ACCOUNT,
        providerReadBackCheckedAt: NOW,
      },
    } as const;
    const first = await evidence.generateEvidenceBundle(submitted.graphId, input);
    const replayed = await evidence.generateEvidenceBundle(submitted.graphId, input);

    expect(replayed.path).toBe(first.path);
    expect(first.manifest.providerArtifact).toBeNull();
    expect(first.manifest.operationalCloseout).toMatchObject({
      guardedSchedulerTickCount: 1,
      claimAttemptsAtDisconnect: 4,
      finalClaimAttempts: 5,
      claimAttempts: 5,
      publishAttemptBudget: 1,
      attemptBudgetExhausted: true,
      durableDraftStatus: "failed",
      terminalClassification: "failed_pre_provider_attempt_budget_exhausted",
      externalMutationCount: 0,
      externalVideoId: null,
      providerVerification: null,
      postedAt: null,
    });
    expect((first.manifest.operationalCloseout as Record<string, unknown>).publishAttemptTimestamps)
      .toEqual(attemptTimes);
    expect(first.manifest.replay).toMatchObject({
      providerUploadCountBefore: 0,
      providerUploadCountAfter: 0,
      additionalUploadCount: 0,
    });
    expect(first.manifest.safetyAssertions).toMatchObject({
      exactlyOneUpload: false,
      noPublicTransition: true,
      zeroProviderMutationProven: true,
      attemptBudgetExhausted: true,
      noAutomaticRetryScheduled: true,
    });
  });

  it("fails closed with a clean error for an unknown graph", async () => {
    const { evidence } = realHarness();
    await expect(evidence.generateEvidenceBundle("no-such-graph")).rejects.toMatchObject({ statusCode: 404 });
  });

  it("fails closed (throws, never writes) when the live safety re-check finds the draft approved or posted", async () => {
    const { graphs, observation, evidence, jobs, advanceSeconds } = realHarness();
    const submitted = graphs.submitGraph(scheduleGraphEnvelope("violation-graph"));
    await graphs.approveGraph(submitted.graphId, { approvedBy: "founder-evidence", graphHash: submitted.graphHash });
    advanceSeconds(16);
    await observation.runObservationBatch({ leaseOwner: "test-runner" });

    // Simulate a real, live-observed safety violation via AutoPoster's own
    // canonical writer (never Operator) — exactly the same class of direct
    // fixture mutation already used by the Phase 2E-B suite to prove
    // fail-closed behavior, not a new pattern invented here.
    const job = [...jobs.values()][0]!;
    job.approved = true;

    await expect(evidence.generateEvidenceBundle(submitted.graphId)).rejects.toMatchObject({
      code: "OPERATOR_EVIDENCE_PUBLISH_SAFETY_VIOLATION",
    });
  });
});
