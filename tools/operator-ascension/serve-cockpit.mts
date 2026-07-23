#!/usr/bin/env node
// CHANTER OS — Operator Ascension I — local Mission Workspace cockpit host.
//
// Purpose: boot the REAL Operator control plane (real Express app, real
// capability-token middleware, real MissionGraphService / result-projection /
// autonomous-observation / retained-evidence services, real node:sqlite
// persistence) on a fixed loopback port so the founder-facing Mission
// Workspace UI can be driven against genuine durable state, then restarted to
// prove resumability.
//
// Faked boundary — and ONLY this boundary — is AutoPoster's own storage
// adapter, via a hand-held AutoPosterOperationsPort. This is the same
// established seam every prior real-contract proof in this repository uses
// (see tools/phase2f/autoposter-unified-ingress.integration.test.mts). There
// are no live provider calls, no production Firestore, no publishing, and no
// direct database state injection: the one seed mission is submitted over real
// HTTP through the real unified ingress and left unapproved for a human.
//
// Safety: this host refuses to start unless it was pointed at an isolated
// database path (it must never touch the founder's real data/operator.sqlite).
import { mkdirSync } from "node:fs";
import path from "node:path";
import type { Server } from "node:http";
import type {
  AutoPosterOperationsPort,
  AutoPosterScheduleParams,
} from "chanter-agent-runtime";
import { config } from "../../apps/backend/src/config.js";
import { createApp } from "../../apps/backend/src/app.js";
import { createDatabase } from "../../apps/backend/src/db/database.js";
import { AuditLogger } from "../../apps/backend/src/audit/auditLogger.js";
import { MockRunner } from "../../apps/backend/src/runners/mockRunner.js";
import { OperatorService } from "../../apps/backend/src/services/operatorService.js";
import { ensureWorkspace } from "../../apps/backend/src/workspace/pathGuard.js";
import { AgentRunLedgerService } from "../../apps/backend/src/agentRunLedger/agentRunLedgerService.js";
import { AutoPosterMissionService } from "../../apps/backend/src/runtimeMissions/autoPosterMissionService.js";
import { createAutoPosterRuntimeMissionExecutor } from "../../apps/backend/src/runtimeMissions/autoPosterRuntime.js";
import { GenericMissionService } from "../../apps/backend/src/missions/genericMissionService.js";
import { createLoopGovernorMissionExecutor } from "../../apps/backend/src/missions/loopGovernorRuntime.js";
import { MissionGraphChildDispatcher } from "../../apps/backend/src/missions/missionGraphChildDispatcher.js";
import { MissionGraphService } from "../../apps/backend/src/missions/missionGraphService.js";
import { AutoPosterGraphIntakeService } from "../../apps/backend/src/missions/autoPosterGraphIntake.js";
import { AutoPosterResultProjectionService } from "../../apps/backend/src/missions/autoPosterResultProjectionService.js";
import { AutoPosterObservationService } from "../../apps/backend/src/missions/autoPosterObservationService.js";
import { AutoPosterMissionEvidenceService } from "../../apps/backend/src/missions/autoPosterMissionEvidenceService.js";
import { SafeCommitCloseoutService } from "../../apps/backend/src/safeCommit/safeCommitCloseoutService.js";

// ---- Safety gate: never write to the founder's real durable database. ------
if (!config.databasePath.includes("ascension-cockpit")) {
  console.error(
    "REFUSING TO START: OPERATOR_DATABASE_PATH must point at an isolated " +
      "'ascension-cockpit' path. Got: " + config.databasePath,
  );
  process.exit(1);
}
if (!config.missionSubmit.token || !config.missionControl.token) {
  console.error(
    "REFUSING TO START: set OPERATOR_MISSION_SUBMIT_TOKEN and " +
      "OPERATOR_CONTROL_TOKEN (they must match the Vite proxy's tokens).",
  );
  process.exit(1);
}
mkdirSync(path.dirname(config.databasePath), { recursive: true });
mkdirSync(config.evidenceDir, { recursive: true });

// ---- Faked AutoPoster storage seam (the one documented boundary). ----------
const SEED_ACCOUNT_ID = "founder-demo-account";
const SEED_WORKSPACE_ID = "founder-demo-workspace";

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
const scheduleCalls: AutoPosterScheduleParams[] = [];

function connectedAccount(provider: "tiktok" | "youtube", accountId: string) {
  return {
    connectedAccountId: `${provider}:${accountId}`,
    accountId,
    provider,
    providerDisplayName: provider === "youtube" ? "YouTube" : "TikTok",
    username: "founder_demo",
    displayName: "Founder Demo Channel",
    connectionStatus: "connected" as const,
    publishingReady: true,
    readinessBlockers: [],
    lastVerifiedAt: "2026-07-23T08:00:00.000Z",
  };
}

const fakeAutoPosterPort: AutoPosterOperationsPort = {
  async listConnectedAccounts(params) {
    return {
      ok: true,
      workspaceId: params.workspaceId ?? SEED_WORKSPACE_ID,
      accounts: [connectedAccount("tiktok", SEED_ACCOUNT_ID)],
      count: 1,
    };
  },
  async validateConnectedAccount(params) {
    return {
      ok: true,
      workspaceId: params.workspaceId ?? SEED_WORKSPACE_ID,
      account: connectedAccount(params.provider as "tiktok" | "youtube", params.accountId),
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
        username: "founder_demo",
        workspaceId: params.workspaceId ?? SEED_WORKSPACE_ID,
        status: "scheduled",
        scheduledAt: job.scheduledAt,
        approved: false,
        approvalState: "unapproved",
        approvedAt: null,
        approvedBy: "",
        mediaType: "video",
        captionSummary: "",
        createdAt: "2026-07-23T08:00:00.000Z",
        updatedAt: "2026-07-23T08:00:00.000Z",
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
      id: `cockpit-queue-${scheduledJobs.size + 1}`,
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

// ---- Real Operator wiring (mirrors createRuntime, swapped executor). --------
const database = createDatabase(config.databasePath);
const workspaceRoot = ensureWorkspace(config.workspaceRoot);
const service = new OperatorService(database, new AuditLogger(config.auditPath), new MockRunner(), workspaceRoot);
const executor = createAutoPosterRuntimeMissionExecutor(
  { baseUrl: "https://cockpit.local.invalid", serviceToken: config.autoPosterRuntime.serviceToken || "cockpit-provider-token", userId: "owner", timeoutValid: true },
  { port: fakeAutoPosterPort },
);
const protectedValues = [
  config.autoPosterRuntime.serviceToken || "cockpit-provider-token",
  config.missionSubmit.token,
  config.missionControl.token,
  config.safeCommitExecutor.token,
  config.ledgerIngest.token,
];
const ledger = new AgentRunLedgerService(database, protectedValues);
const runtimeMissionService = new AutoPosterMissionService(database, executor, { agentRunLedgerService: ledger, protectedValues });
const genericMissionService = new GenericMissionService(
  database,
  createLoopGovernorMissionExecutor({ pythonExecutable: "", governorRoot: "", dataDir: "", timeoutValid: true }, {
    port: {
      async createManualLoop() {
        return { ok: true, created: true, taskId: "t", loopId: "l", realAgentExecution: false };
      },
      async lookupManualLoop() {
        return { ok: true, outcome: "not_found", binding: null };
      },
    },
  }),
  { agentRunLedgerService: ledger, protectedValues },
);
const autoPosterResultService = new AutoPosterResultProjectionService(database, executor);
const autoPosterObservationService = new AutoPosterObservationService(database, autoPosterResultService, {});
const missionGraphService = new MissionGraphService(
  database,
  new MissionGraphChildDispatcher(genericMissionService, runtimeMissionService),
  { protectedValues, observationScheduler: autoPosterObservationService },
);
const autoPosterGraphIntakeService = new AutoPosterGraphIntakeService(missionGraphService, runtimeMissionService, executor);
const autoPosterMissionEvidenceService = new AutoPosterMissionEvidenceService(
  missionGraphService,
  runtimeMissionService,
  autoPosterResultService,
  autoPosterObservationService,
  executor,
  config.evidenceDir,
  protectedValues,
);
const safeCommitCloseoutService = new SafeCommitCloseoutService(database, { protectedValues });

const app = createApp(
  service,
  runtimeMissionService,
  ledger,
  genericMissionService,
  missionGraphService,
  autoPosterResultService,
  autoPosterObservationService,
  safeCommitCloseoutService,
  autoPosterGraphIntakeService,
  autoPosterMissionEvidenceService,
);

const server: Server = await new Promise((resolve, reject) => {
  const listening = app.listen(config.port, config.host, () => resolve(listening));
  listening.once("error", reject);
});
const baseUrl = `http://${config.host}:${config.port}`;
console.log(`Operator Ascension cockpit host: ${baseUrl}`);
console.log(`Isolated database: ${config.databasePath}`);

// ---- Seed exactly one durable mission over real HTTP (idempotent). ---------
// Stable payload across restarts so a replay is a byte-identical no-op, never a
// changed-payload rejection. Left unapproved: a human approves it in the UI.
const SEED_IDEMPOTENCY_KEY = "operator-ascension-i-seed-0001";
const SEED_SCHEDULED_AT = "2026-12-01T12:00:00.000Z";
try {
  const response = await fetch(`${baseUrl}/api/mission-graphs/autoposter-schedule`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.missionSubmit.token}`,
      origin: baseUrl,
    },
    body: JSON.stringify({
      idempotencyKey: SEED_IDEMPOTENCY_KEY,
      requestedBy: "chanter-mcp-server",
      accountId: SEED_ACCOUNT_ID,
      provider: "tiktok",
      mediaUrl: "https://cdn.example.com/operator-ascension-seed.mp4",
      caption: "Operator Ascension I — founder cockpit seed mission",
      hashtags: "#chanter #ascension",
      scheduledAt: SEED_SCHEDULED_AT,
    }),
  });
  const body = (await response.json()) as { graph?: { graphId?: string; status?: string; replayed?: boolean } };
  if (response.ok && body.graph) {
    console.log(
      `Seed mission ${body.graph.replayed ? "replayed (durable)" : "created"}: ` +
        `${body.graph.graphId} [${body.graph.status}]`,
    );
  } else {
    console.warn(`Seed submission returned HTTP ${response.status}: ${JSON.stringify(body)}`);
  }
} catch (error) {
  console.warn("Seed submission failed (host still serving durable state):", error);
}

function shutdown(): void {
  server.close(() => {
    database.close();
    process.exit(0);
  });
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
