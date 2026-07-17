// Phase 2F-A operational proof: real MCP AutoPoster schedule submission
// unified into Operator's existing mission-graph lifecycle.
//
// Real code exercised: chanter-mcp-server's actual handleAutoposterSchedulePost
// -> executeAutoPosterMission -> submitScheduleGraphToOperator -> real HTTP ->
// chanter-Operator's actual AutoPosterGraphIntakeService, MissionGraphService,
// MissionGraphChildDispatcher, AutoPosterMissionService, AutoPosterResultProjectionService,
// AutoPosterObservationService, and the real Express app/router with real
// capability-token middleware, over real node:sqlite persistence.
//
// Faked boundary (same established pattern as every prior real-contract proof
// in this repository): only AutoPoster's own storage adapter, via a
// hand-held AutoPosterOperationsPort. No live provider calls, no production
// Firestore, no direct database state injection, zero commits.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { AutoPosterOperationsPort, AutoPosterScheduleParams, RuntimeMissionResult } from "chanter-agent-runtime";

const originalEnvironment = {
  operatorBaseUrl: process.env.OPERATOR_BASE_URL,
  missionSubmitToken: process.env.OPERATOR_MISSION_SUBMIT_TOKEN,
  missionControlToken: process.env.OPERATOR_CONTROL_TOKEN,
  ledgerToken: process.env.OPERATOR_LEDGER_INGEST_TOKEN,
  operatorTimeout: process.env.OPERATOR_TIMEOUT_MS,
};

const missionSubmitToken = `phase2f-submit-${randomUUID()}`;
const missionControlToken = `phase2f-control-${randomUUID()}`;
const ledgerToken = `phase2f-ledger-${randomUUID()}`;
const providerToken = `phase2f-provider-${randomUUID()}`;
process.env.OPERATOR_MISSION_SUBMIT_TOKEN = missionSubmitToken;
process.env.OPERATOR_CONTROL_TOKEN = missionControlToken;
process.env.OPERATOR_LEDGER_INGEST_TOKEN = ledgerToken;
process.env.OPERATOR_TIMEOUT_MS = "5000";

const [
  { createApp },
  { AuditLogger },
  { AgentRunLedgerService },
  { createDatabase },
  { MockRunner },
  { GenericMissionService },
  { MissionGraphChildDispatcher },
  { MissionGraphService },
  { AutoPosterGraphIntakeService },
  { AutoPosterResultProjectionService },
  { AutoPosterObservationService },
  { createLoopGovernorMissionExecutor },
  { AutoPosterMissionService },
  { createAutoPosterRuntimeMissionExecutor },
  { OperatorService },
  { ensureWorkspace },
  { handleAutoposterSchedulePost },
  { configureOperatorClientForTestingMcp },
] = await Promise.all([
  import("../../apps/backend/src/app.js"),
  import("../../apps/backend/src/audit/auditLogger.js"),
  import("../../apps/backend/src/agentRunLedger/agentRunLedgerService.js"),
  import("../../apps/backend/src/db/database.js"),
  import("../../apps/backend/src/runners/mockRunner.js"),
  import("../../apps/backend/src/missions/genericMissionService.js"),
  import("../../apps/backend/src/missions/missionGraphChildDispatcher.js"),
  import("../../apps/backend/src/missions/missionGraphService.js"),
  import("../../apps/backend/src/missions/autoPosterGraphIntake.js"),
  import("../../apps/backend/src/missions/autoPosterResultProjectionService.js"),
  import("../../apps/backend/src/missions/autoPosterObservationService.js"),
  import("../../apps/backend/src/missions/loopGovernorRuntime.js"),
  import("../../apps/backend/src/runtimeMissions/autoPosterMissionService.js"),
  import("../../apps/backend/src/runtimeMissions/autoPosterRuntime.js"),
  import("../../apps/backend/src/services/operatorService.js"),
  import("../../apps/backend/src/workspace/pathGuard.js"),
  import("../../../chanter-mcp-server/src/tools/autoposterRuntimeTools.js"),
  import("../../../chanter-mcp-server/src/runtime/autoposterGateway.js"),
]);

interface RunningOperator {
  appBaseUrl: string;
  database: DatabaseSync;
  server: Server;
}

const scheduleCalls: AutoPosterScheduleParams[] = [];
const canonicalWorkspaceId = "workspace-phase2f-0001";
const canonicalAccountId = "account-phase2f-0001";
const queueDraftId = "phase2f-queue-draft-0001";

function connectedAccount(provider: "tiktok" | "youtube") {
  return {
    connectedAccountId: `${provider}:${canonicalAccountId}`,
    accountId: canonicalAccountId,
    provider,
    providerDisplayName: provider === "youtube" ? "YouTube" : "TikTok",
    username: "phase2f_creator",
    displayName: "Phase 2F-A Creator",
    connectionStatus: "connected" as const,
    publishingReady: true,
    readinessBlockers: [],
    lastVerifiedAt: "2026-07-17T08:00:00.000Z",
  };
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

const scheduledJobs = new Map<string, QueueDraft>();

const fakeAutoPosterPort: AutoPosterOperationsPort = {
  async listConnectedAccounts(params) {
    return { ok: true, workspaceId: params.workspaceId, accounts: [connectedAccount("tiktok")], count: 1 };
  },
  async validateConnectedAccount(params) {
    return {
      ok: true,
      workspaceId: params.workspaceId ?? canonicalWorkspaceId,
      account: connectedAccount(params.provider as "tiktok" | "youtube"),
    };
  },
  async listQueue() {
    return { ok: true, items: [], count: 0, scope: { accountId: "all" } };
  },
  async getPostStatus(params) {
    const job = [...scheduledJobs.values()].find((candidate) => candidate.id === params.postId);
    if (!job) return { ok: false, code: "not_found", message: "not found" };
    return {
      ok: true,
      post: {
        id: job.id,
        provider: job.provider,
        connectedAccountId: `${job.provider}:${job.accountId}`,
        accountId: job.accountId,
        username: "phase2f_creator",
        workspaceId: params.workspaceId ?? canonicalWorkspaceId,
        status: "scheduled",
        scheduledAt: job.scheduledAt,
        approved: false,
        approvalState: "unapproved",
        approvedAt: null,
        approvedBy: "",
        mediaType: "video",
        captionSummary: "",
        createdAt: "2026-07-17T08:00:00.000Z",
        updatedAt: "2026-07-17T08:00:00.000Z",
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
    scheduleCalls.push(params);
    const existing = scheduledJobs.get(params.idempotencyKey);
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
      id: queueDraftId,
      accountId: params.accountId,
      provider: (params.provider ?? "tiktok") as "tiktok" | "youtube",
      scheduledAt: params.scheduledAt,
      idempotencyKey: params.idempotencyKey,
      missionId: params.missionId,
      action: params.action,
      missionPayloadHash: params.missionPayloadHash,
    };
    scheduledJobs.set(params.idempotencyKey, job);
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

async function startOperator(root: string, databasePath: string): Promise<RunningOperator> {
  const database = createDatabase(databasePath);
  const auditPath = path.join(root, "operator-audit.jsonl");
  const operatorService = new OperatorService(
    database,
    new AuditLogger(auditPath),
    new MockRunner(),
    ensureWorkspace(path.join(root, "workspace")),
  );
  const protectedValues = [providerToken, missionSubmitToken, missionControlToken, ledgerToken];
  const ledger = new AgentRunLedgerService(database, protectedValues);
  const executor = createAutoPosterRuntimeMissionExecutor(
    { baseUrl: "https://autoposter.phase2f.test", serviceToken: providerToken, userId: "owner", timeoutValid: true },
    { port: fakeAutoPosterPort },
  );
  const runtimeMissionService = new AutoPosterMissionService(database, executor, {
    agentRunLedgerService: ledger,
    protectedValues,
  });
  const genericMissionService = new GenericMissionService(
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
    { agentRunLedgerService: ledger, protectedValues },
  );
  const autoPosterResultService = new AutoPosterResultProjectionService(database, executor, {});
  const autoPosterObservationService = new AutoPosterObservationService(database, autoPosterResultService, {});
  const missionGraphService = new MissionGraphService(
    database,
    new MissionGraphChildDispatcher(genericMissionService, runtimeMissionService),
    { protectedValues, observationScheduler: autoPosterObservationService },
  );
  const autoPosterGraphIntakeService = new AutoPosterGraphIntakeService(
    missionGraphService,
    runtimeMissionService,
    executor,
  );
  const app = createApp(
    operatorService,
    runtimeMissionService,
    ledger,
    genericMissionService,
    missionGraphService,
    autoPosterResultService,
    autoPosterObservationService,
    undefined,
    autoPosterGraphIntakeService,
  );
  const server = await new Promise<Server>((resolve, reject) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
    listening.once("error", reject);
  });
  const address = server.address() as AddressInfo;
  return { appBaseUrl: `http://127.0.0.1:${address.port}`, database, server };
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
  restore("OPERATOR_BASE_URL", originalEnvironment.operatorBaseUrl);
  restore("OPERATOR_MISSION_SUBMIT_TOKEN", originalEnvironment.missionSubmitToken);
  restore("OPERATOR_CONTROL_TOKEN", originalEnvironment.missionControlToken);
  restore("OPERATOR_LEDGER_INGEST_TOKEN", originalEnvironment.ledgerToken);
  restore("OPERATOR_TIMEOUT_MS", originalEnvironment.operatorTimeout);
}

async function authedJson(
  url: string,
  token: string | undefined,
  init: RequestInit = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = { "content-type": "application/json", ...(init.headers as Record<string, string> ?? {}) };
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(url, { ...init, headers, redirect: "error" });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

test("Phase 2F-A: unified AutoPoster mission ingress — real MCP submission through Operator's mission-graph lifecycle", { timeout: 30_000 }, async (context) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "chanter-phase2f-unified-"));
  const databasePath = path.join(root, "operator.sqlite");
  let running: RunningOperator | undefined;

  context.after(async () => {
    configureOperatorClientForTestingMcp(null);
    if (running) await stopOperator(running);
    restoreEnvironment();
    rmSync(root, { recursive: true, force: true });
  });

  running = await startOperator(root, databasePath);
  process.env.OPERATOR_BASE_URL = running.appBaseUrl;
  configureOperatorClientForTestingMcp({
    config: { baseUrl: running.appBaseUrl, token: missionSubmitToken, timeoutMs: 5_000 },
  });

  const idempotencyKey = "phase2f-unified-key-0001";
  const scheduledAtUtc = new Date(Date.now() + 3_600_000).toISOString();
  // Deliberately omits workspaceId, proving the unified route still
  // auto-discovers it from the connected account, matching the legacy path.
  const request = {
    accountId: canonicalAccountId,
    provider: "tiktok",
    mediaUrl: "https://cdn.example.com/phase2f-unified-proof.mp4",
    scheduledAtUtc,
    idempotencyKey,
    caption: "Phase 2F-A unified ingress proof",
    hashtags: "#chanter #phase2fa",
    requestedBy: "chanter-mcp-server",
  };

  // 1. MCP submits the real AutoPoster scheduling intent.
  const submitted = await handleAutoposterSchedulePost(request);
  assert.equal(submitted.status, "approval_required");
  assert.equal(submitted.output, null);
  assert.equal(submitted.evidence, null);
  assert.equal(scheduleCalls.length, 0, "no execution before approval");

  // 2. Operator durably persisted exactly one canonical one-node mission
  // graph, discoverable via its own real listing route (no direct DB read).
  const listed = await authedJson(`${running.appBaseUrl}/api/mission-graphs?limit=50`, undefined);
  assert.equal(listed.status, 200);
  const graphs = listed.body.graphs as Array<Record<string, unknown>>;
  const graph = graphs.find((candidate) => candidate.idempotencyKey === idempotencyKey);
  assert.ok(graph, "the submitted graph must be durably listed");
  const graphId = graph!.graphId as string;
  const graphHash = graph!.graphHash as string;
  assert.equal(graph!.status, "approval_required");
  assert.equal(graph!.approvedBy, null);
  assert.equal(graph!.nodeCount, 1);
  assert.equal((graph!.tenant as Record<string, unknown>).workspaceId, canonicalWorkspaceId, "workspaceId auto-discovered");

  // 3. MCP cannot approve: the submit token is rejected on the approve route.
  const submitTokenApproval = await authedJson(
    `${running.appBaseUrl}/api/mission-graphs/${graphId}/approve`,
    missionSubmitToken,
    { method: "POST", body: JSON.stringify({ approvedBy: "founder-phase2fa", graphHash }) },
  );
  assert.equal(submitTokenApproval.status, 401);
  const noTokenApproval = await authedJson(
    `${running.appBaseUrl}/api/mission-graphs/${graphId}/approve`,
    undefined,
    { method: "POST", body: JSON.stringify({ approvedBy: "founder-phase2fa", graphHash }) },
  );
  assert.equal(noTokenApproval.status, 401);
  assert.equal(scheduleCalls.length, 0);

  // 4. Independent Operator control authority approves the exact graph hash.
  const approvalActor = "founder-phase2fa";
  const approval = await authedJson(
    `${running.appBaseUrl}/api/mission-graphs/${graphId}/approve`,
    missionControlToken,
    { method: "POST", body: JSON.stringify({ approvedBy: approvalActor, graphHash }) },
  );
  assert.equal(approval.status, 200);
  assert.equal(approval.body.status, "completed");
  assert.equal(approval.body.approvedBy, approvalActor);
  const approvedNodes = approval.body.nodes as Array<Record<string, unknown>>;
  assert.equal(approvedNodes.length, 1);
  assert.equal(approvedNodes[0]!.status, "completed");
  const childMissionId = approvedNodes[0]!.childMissionId as string;
  assert.equal(scheduleCalls.length, 1, "exactly one node dispatched to the real AutoPoster adapter");

  // 5. The typed result is correlated to graph ID, node ID, and execution attempt.
  const childMission = await authedJson(`${running.appBaseUrl}/api/runtime-missions/${childMissionId}`, undefined);
  assert.equal(childMission.status, 200);
  const runtimeResult = childMission.body.runtimeResult as RuntimeMissionResult;
  assert.equal(runtimeResult.status, "succeeded");
  const executionAttemptId = (childMission.body.execution as Record<string, unknown>).executionAttemptId as string;
  assert.ok(executionAttemptId);
  const post = (runtimeResult.output as { post: { id: string } }).post;
  assert.equal(post.id, queueDraftId);

  // 6. MCP replay is idempotent: exact same submission, zero re-execution.
  const replay = await handleAutoposterSchedulePost(request);
  assert.equal(replay.status, "duplicate");
  assert.equal(scheduleCalls.length, 1, "MCP replay must not re-execute");

  // 7. Changed payload under the same idempotency identity is rejected.
  const mismatch = await handleAutoposterSchedulePost({ ...request, caption: "a substituted caption" });
  assert.equal(mismatch.status, "validation_failed");
  assert.equal(scheduleCalls.length, 1);

  // 8. Phase 2E-B result projection ingests the real result.
  const refresh = await authedJson(
    `${running.appBaseUrl}/api/mission-graphs/${graphId}/autoposter-results/refresh`,
    missionControlToken,
    { method: "POST", body: "{}" },
  );
  assert.equal(refresh.status, 200);
  const refreshResults = refresh.body.results as Array<Record<string, unknown>> | undefined;
  const projectionOutcome = refreshResults?.[0]?.outcome ?? refresh.body.outcome;
  assert.ok(projectionOutcome, "result projection must report an ingestion outcome");

  // 9. Phase 2E-C observation job was created through the existing completion hook.
  const jobs = await authedJson(
    `${running.appBaseUrl}/api/autoposter-observations/jobs?graphId=${graphId}`,
    missionControlToken,
  );
  assert.equal(jobs.status, 200);
  const jobList = jobs.body.jobs as Array<Record<string, unknown>>;
  assert.ok(jobList.length >= 1, "an observation job must exist for the completed node");
  const observationJob = jobList.find((job) => job.nodeId === "autoposter_schedule") ?? jobList[0];

  // 10. Exact replay after a fresh Operator process (restart) preserves identity.
  await stopOperator(running);
  running = undefined;
  running = await startOperator(root, databasePath);
  process.env.OPERATOR_BASE_URL = running.appBaseUrl;
  configureOperatorClientForTestingMcp({
    config: { baseUrl: running.appBaseUrl, token: missionSubmitToken, timeoutMs: 5_000 },
  });
  const afterRestart = await handleAutoposterSchedulePost(request);
  assert.equal(afterRestart.status, "duplicate");
  assert.equal(scheduleCalls.length, 1, "restart replay must not re-execute");

  console.log("PHASE2F_A_UNIFIED_INGRESS_EVIDENCE " + JSON.stringify({
    mcpToolRequest: { tool: "chanter.autoposter_schedule_post", idempotencyKey, accountId: canonicalAccountId },
    graphId,
    graphHash,
    nodeId: "autoposter_schedule",
    approvalActor,
    childMissionId,
    executionAttemptId,
    resultIdentity: { status: runtimeResult.status, queueDraftId: post.id },
    resultProjectionOutcome: projectionOutcome,
    observationJobId: observationJob?.observationJobId ?? observationJob?.id ?? null,
    observationJobStatus: observationJob?.status ?? null,
    finalLifecycleState: "completed",
    scheduleCallsTotal: scheduleCalls.length,
    providerPublishCalls: 0,
  }));
});
