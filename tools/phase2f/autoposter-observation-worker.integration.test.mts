// Phase 2F-B operational proof: the autonomous observation worker claims and
// processes a real, durably scheduled AutoPoster observation job with no
// manual /api/autoposter-observations/run call anywhere in this script, then
// resumes correctly after a real Operator process restart without
// duplicating evidence.
//
// Real code exercised: chanter-mcp-server's actual handleAutoposterSchedulePost
// -> the real unified Phase 2F-A graph route -> real MissionGraphService ->
// real AutoPosterMissionService -> real Agent Runtime AutoPoster adapter ->
// the real, unmodified AutoPosterObservationService, driven only by the new
// AutoPosterObservationWorker's real setInterval ticking (not a fake timer).
//
// Faked boundary (same established pattern as every prior real-contract
// proof in this repository): only AutoPoster's own storage adapter, via a
// hand-held AutoPosterOperationsPort. No live provider calls, no production
// Firestore, no direct database state injection, zero commits.
//
// The observation retry policy's first delay is shortened to 1 second (a
// legitimate use of the existing, unmodified AutoPosterObservationPolicy
// override mechanism — the same one OPERATOR_OBSERVATION_RETRY_DELAYS_SECONDS
// exposes in production) purely so this proof does not need to wait out the
// full 15-second production default; the worker's own poll interval stays at
// its real 1-second floor (OBSERVATION_WORKER_MIN_POLL_INTERVAL_MS) — no
// sub-second busy polling anywhere.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import type { AutoPosterOperationsPort, AutoPosterScheduleParams, RuntimeMissionResult } from "chanter-agent-runtime";

const originalEnvironment = {
  operatorBaseUrl: process.env.OPERATOR_BASE_URL,
  missionSubmitToken: process.env.OPERATOR_MISSION_SUBMIT_TOKEN,
  missionControlToken: process.env.OPERATOR_CONTROL_TOKEN,
  ledgerToken: process.env.OPERATOR_LEDGER_INGEST_TOKEN,
  operatorTimeout: process.env.OPERATOR_TIMEOUT_MS,
};

const missionSubmitToken = `phase2fb-submit-${randomUUID()}`;
const missionControlToken = `phase2fb-control-${randomUUID()}`;
const ledgerToken = `phase2fb-ledger-${randomUUID()}`;
const providerToken = `phase2fb-provider-${randomUUID()}`;
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
  { AutoPosterObservationWorker },
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
  import("../../apps/backend/src/missions/autoPosterObservationWorker.js"),
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
  worker: InstanceType<typeof AutoPosterObservationWorker>;
}

const scheduleCalls: AutoPosterScheduleParams[] = [];
const canonicalWorkspaceId = "workspace-phase2fb-0001";
const canonicalAccountId = "account-phase2fb-0001";
const queueDraftId = "phase2fb-queue-draft-0001";
const workerEvents: unknown[] = [];

function connectedAccount(provider: "tiktok" | "youtube") {
  return {
    connectedAccountId: `${provider}:${canonicalAccountId}`,
    accountId: canonicalAccountId,
    provider,
    providerDisplayName: provider === "youtube" ? "YouTube" : "TikTok",
    username: "phase2fb_creator",
    displayName: "Phase 2F-B Creator",
    connectionStatus: "connected" as const,
    publishingReady: true,
    readinessBlockers: [],
    lastVerifiedAt: "2026-07-18T08:00:00.000Z",
  };
}

const scheduledJobs = new Map<string, { id: string; accountId: string; provider: "tiktok" | "youtube"; scheduledAt: string; missionId: string; idempotencyKey: string; action: string; missionPayloadHash: string }>();

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
        username: "phase2fb_creator",
        workspaceId: params.workspaceId ?? canonicalWorkspaceId,
        status: "scheduled",
        scheduledAt: job.scheduledAt,
        approved: false,
        approvalState: "unapproved",
        approvedAt: null,
        approvedBy: "",
        mediaType: "video",
        captionSummary: "",
        createdAt: "2026-07-18T08:00:00.000Z",
        updatedAt: "2026-07-18T08:00:00.000Z",
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
    const asPost = (job: NonNullable<typeof existing>) => ({
      id: job.id, accountId: job.accountId, provider: job.provider, status: "scheduled", scheduledAt: job.scheduledAt, approved: false,
    });
    if (existing) return { ok: true, duplicate: true, post: asPost(existing) };
    const job = {
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
    { baseUrl: "https://autoposter.phase2fb.test", serviceToken: providerToken, userId: "owner", timeoutValid: true },
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
  // Shortened first retry delay (1s instead of the 15s production default) —
  // a legitimate use of the existing, unmodified policy override mechanism,
  // purely so this proof does not need to wait out real production timing.
  const autoPosterObservationService = new AutoPosterObservationService(database, autoPosterResultService, {
    policy: { retryDelaysSeconds: [1], leaseSeconds: 10, maxAttempts: 3, batchSize: 8 },
  });
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
  const worker = new AutoPosterObservationWorker(autoPosterObservationService, {
    enabled: true,
    pollIntervalMs: 1_000,
    onEvent: (event) => workerEvents.push(event),
  });
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
  worker.start();
  return { appBaseUrl: `http://127.0.0.1:${address.port}`, database, server, worker };
}

async function stopOperator(running: RunningOperator): Promise<void> {
  await running.worker.stop();
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

test("Phase 2F-B: autonomous observation worker claims and converges a real job with no manual endpoint call, then resumes cleanly after restart", { timeout: 30_000 }, async (context) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "chanter-phase2fb-worker-proof-"));
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

  const idempotencyKey = "phase2fb-worker-proof-key-0001";
  const scheduledAtUtc = new Date(Date.now() + 3_600_000).toISOString();
  const request = {
    accountId: canonicalAccountId,
    provider: "tiktok",
    mediaUrl: "https://cdn.example.com/phase2fb-worker-proof.mp4",
    scheduledAtUtc,
    idempotencyKey,
    caption: "Phase 2F-B autonomous observation worker proof",
    hashtags: "#chanter #phase2fb",
    requestedBy: "chanter-mcp-server",
  };

  // 1-2. Real MCP submission through the unified Phase 2F-A graph route.
  const submitted = await handleAutoposterSchedulePost(request);
  assert.equal(submitted.status, "approval_required");
  assert.equal(scheduleCalls.length, 0);

  const listed = await authedJson(`${running.appBaseUrl}/api/mission-graphs?limit=50`, undefined);
  const graph = (listed.body.graphs as Array<Record<string, unknown>>).find((g) => g.idempotencyKey === idempotencyKey);
  assert.ok(graph, "the submitted graph must be durably listed");
  const graphId = graph!.graphId as string;
  const graphHash = graph!.graphHash as string;

  // 3-4. Independent Operator control approval dispatches the node for real.
  const approval = await authedJson(
    `${running.appBaseUrl}/api/mission-graphs/${graphId}/approve`,
    missionControlToken,
    { method: "POST", body: JSON.stringify({ approvedBy: "founder-phase2fb", graphHash }) },
  );
  assert.equal(approval.status, 200);
  assert.equal(approval.body.status, "completed");
  assert.equal(scheduleCalls.length, 1, "exactly one real AutoPoster adapter dispatch");

  // 5. An observation job now exists, created through the existing completion hook.
  const jobsBeforeWorker = await authedJson(
    `${running.appBaseUrl}/api/autoposter-observations/jobs?graphId=${graphId}`,
    missionControlToken,
  );
  const jobBefore = (jobsBeforeWorker.body.jobs as Array<Record<string, unknown>>)[0];
  assert.ok(jobBefore, "an observation job must be durably scheduled");
  assert.equal(jobBefore!.status, "pending");
  assert.equal(jobBefore!.attemptCount, 0);
  const observationJobId = jobBefore!.observationJobId as string;

  // 6-7. Never call the manual endpoint. Only real elapsed wall-clock time
  // (the shortened 1s first retry delay) plus the worker's own real
  // setInterval ticking may cause the job to be claimed and processed.
  await sleep(3_000);

  const jobsAfterWorker = await authedJson(
    `${running.appBaseUrl}/api/autoposter-observations/jobs?graphId=${graphId}`,
    missionControlToken,
  );
  const jobAfter = (jobsAfterWorker.body.jobs as Array<Record<string, unknown>>)[0];
  assert.ok(jobAfter);
  assert.equal(jobAfter!.attemptCount, 1, "the worker must have processed exactly one attempt automatically");
  assert.equal(jobAfter!.status, "escalation_required", "an unapproved-publish draft converges to exactly one human escalation");

  const escalationsAfterWorker = await authedJson(
    `${running.appBaseUrl}/api/autoposter-observations/escalations?graphId=${graphId}`,
    missionControlToken,
  );
  const escalations = escalationsAfterWorker.body.escalations as Array<Record<string, unknown>>;
  assert.equal(escalations.length, 1, "exactly one escalation must be created");
  const escalationId = escalations[0]!.escalationId as string;

  const runCompletedEvents = workerEvents.filter((event) => (event as { type: string }).type === "run_completed");
  assert.ok(runCompletedEvents.length >= 1, "worker run evidence must be captured");
  const firstRunThatClaimed = runCompletedEvents.find((event) => (event as { claimed: number }).claimed > 0);
  assert.ok(firstRunThatClaimed, "at least one worker run must report having claimed the job");

  // 9. Restart Operator against the same SQLite database.
  await stopOperator(running);
  running = undefined;
  running = await startOperator(root, databasePath);
  process.env.OPERATOR_BASE_URL = running.appBaseUrl;
  configureOperatorClientForTestingMcp({
    config: { baseUrl: running.appBaseUrl, token: missionSubmitToken, timeoutMs: 5_000 },
  });

  // 10. Give the restarted worker time to tick; the already-terminal job
  // must not be reclaimed, re-attempted, or re-escalated.
  await sleep(3_000);

  const jobsAfterRestart = await authedJson(
    `${running.appBaseUrl}/api/autoposter-observations/jobs?graphId=${graphId}`,
    missionControlToken,
  );
  const jobAfterRestart = (jobsAfterRestart.body.jobs as Array<Record<string, unknown>>)[0];
  assert.equal(jobAfterRestart!.attemptCount, 1, "restart must not duplicate the observation attempt");
  assert.equal(jobAfterRestart!.status, "escalation_required");

  const escalationsAfterRestart = await authedJson(
    `${running.appBaseUrl}/api/autoposter-observations/escalations?graphId=${graphId}`,
    missionControlToken,
  );
  assert.equal(
    (escalationsAfterRestart.body.escalations as unknown[]).length,
    1,
    "restart must not duplicate the escalation",
  );
  assert.equal(scheduleCalls.length, 1, "restart must never re-dispatch to the AutoPoster adapter");

  console.log("PHASE2F_B_AUTONOMOUS_OBSERVATION_WORKER_EVIDENCE " + JSON.stringify({
    mcpToolRequest: { tool: "chanter.autoposter_schedule_post", idempotencyKey, accountId: canonicalAccountId },
    graphId,
    graphHash,
    observationJobId,
    workerRunEventsCaptured: workerEvents.length,
    attemptCountAfterFirstRun: jobAfter!.attemptCount,
    jobStatusAfterFirstRun: jobAfter!.status,
    escalationId,
    attemptCountAfterRestart: jobAfterRestart!.attemptCount,
    jobStatusAfterRestart: jobAfterRestart!.status,
    escalationCountAfterRestart: (escalationsAfterRestart.body.escalations as unknown[]).length,
    manualObservationEndpointInvoked: false,
    scheduleCallsTotal: scheduleCalls.length,
    providerPublishCalls: 0,
  }));
});
