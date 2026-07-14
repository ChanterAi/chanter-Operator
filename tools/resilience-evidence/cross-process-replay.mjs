import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { createDatabase } from "../../apps/backend/src/db/database.ts";
import { AutoPosterMissionService } from "../../apps/backend/src/runtimeMissions/autoPosterMissionService.ts";
import { createAutoPosterRuntimeMissionExecutor } from "../../apps/backend/src/runtimeMissions/autoPosterRuntime.ts";

if (process.env.CHANTER_CLEAN_SOURCE !== "1" || !process.env.CHANTER_FRESH_RUNTIME_ENTRY) {
  throw new Error("Cross-process evidence must run through clean-source-validation.mjs.");
}

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const operatorRoot = path.resolve(import.meta.dirname, "../..");
const appsRoot = path.resolve(operatorRoot, "..");
const runtimeEntry = path.resolve(process.env.CHANTER_FRESH_RUNTIME_ENTRY);
const autoPosterRoot = path.join(appsRoot, "chanter-auto-poster");
const { createAutoPosterApplicationService, createExecutionContext } = require(
  path.join(autoPosterRoot, "src", "autoposterApplicationService.js"),
);
const mediaPolicy = require(path.join(autoPosterRoot, "src", "mediaPolicy.js"));
const { createCommercialFixture } = require(
  path.join(autoPosterRoot, "test", "helpers", "commercial-fixture.js"),
);

const workspaceId = "workspace-cross-process";
const accountId = "account-cross-process";
const token = "local-harness-token";
const jobs = [];
let createAttempts = 0;
let providerEndpointInvocations = 0;

const account = {
  accountId,
  open_id: accountId,
  userId: "owner",
  platform: "tiktok",
  provider: "tiktok",
  username: "cross_process_creator",
  displayName: "Cross Process Creator",
  connected: true,
};

const storage = {
  async getCanonicalTikTokAccount(userId, requestedAccountId) {
    return userId === "owner" && requestedAccountId === accountId ? account : null;
  },
  async getCanonicalTikTokAccounts(userId) {
    return userId === "owner" ? [account] : [];
  },
  async getTikTokAccount(userId, requestedAccountId) {
    return userId === "owner" && requestedAccountId === accountId ? account : null;
  },
  async listConnectedAccountReferencesForOwner(userId) {
    return userId === "owner"
      ? [{ provider: "tiktok", accountId, workspaceId }]
      : [];
  },
  async getPosts(userId) {
    return userId === "owner" ? [...jobs] : [];
  },
  async getPost(userId, postId, requestedAccountId) {
    return userId === "owner"
      ? jobs.find((job) => job.id === postId && job.accountId === requestedAccountId) ?? null
      : null;
  },
  async addUploadedPosts(userId, _files, defaults) {
    createAttempts += 1;
    if (jobs.some((job) => job.id === defaults.documentId)) {
      const error = new Error("deterministic queue document already exists");
      error.code = 6;
      throw error;
    }
    const post = {
      id: defaults.documentId,
      userId,
      workspaceId: defaults.workspaceId,
      accountId: defaults.accounts[0].accountId,
      provider: defaults.provider,
      platform: defaults.provider,
      username: defaults.accounts[0].username,
      mediaType: "video",
      mediaUrl: defaults.publicMediaUrl,
      caption: defaults.caption,
      hashtags: defaults.hashtags,
      status: "scheduled",
      scheduledAt: defaults.scheduledAt,
      approved: false,
      approvedAt: null,
      approvedBy: "",
      idempotencyKey: defaults.idempotencyKey,
      runtimeIdempotencyKey: defaults.runtimeIdempotencyKey,
      runtimeScheduledBy: defaults.runtimeScheduledBy,
      runtimeMissionId: defaults.runtimeMissionId,
      runtimeAction: defaults.runtimeAction,
      runtimePayloadHash: defaults.runtimePayloadHash,
    };
    jobs.push(post);
    return [post];
  },
};

const autoPoster = createAutoPosterApplicationService({
  storage,
  mediaPolicy,
  commercialService: createCommercialFixture(storage),
});

function jsonResponse(response, status, payload) {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(payload));
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

const server = http.createServer(async (request, response) => {
  if (request.method !== "POST" || request.headers["x-chanter-runtime-token"] !== token) {
    jsonResponse(response, 401, { ok: false, code: "unauthorized", reason: "Unauthorized." });
    return;
  }
  try {
    const body = await readJson(request);
    const context = createExecutionContext({
      userId: "owner",
      source: "runtime",
      actorId: body.requestedBy,
      accountId: body.accountId,
      workspaceId: body.workspaceId,
      correlationId: body.traceId,
      idempotency: { key: body.idempotencyKey },
    });
    if (request.url === "/api/runtime/schedule") {
      const result = await autoPoster.schedulePost(context, {
        provider: body.provider,
        accountId: body.accountId,
        mediaUrl: body.mediaUrl,
        caption: body.caption,
        hashtags: body.hashtags,
        requestedBy: body.requestedBy,
        runtimeMissionId: body.missionId,
        runtimeAction: body.action,
        runtimePayloadHash: body.missionPayloadHash,
        requireSingle: true,
        schedule: {
          mode: "explicit",
          scheduledAt: body.scheduledAt,
          requireExplicitTimezone: true,
          requireFuture: true,
        },
      });
      jsonResponse(response, result.duplicate ? 200 : 201, {
        ok: true,
        duplicate: result.duplicate,
        post: result.post,
      });
      return;
    }
    if (request.url === "/api/runtime/schedule/reconcile") {
      const result = await autoPoster.reconcileRuntimeSchedule(context, {
        provider: body.provider,
        accountId: body.accountId,
        scheduledAt: body.scheduledAt,
        runtimeMissionId: body.missionId,
        runtimeAction: body.action,
        runtimePayloadHash: body.missionPayloadHash,
      });
      jsonResponse(response, 200, { ok: true, ...result });
      return;
    }
    jsonResponse(response, 404, { ok: false, code: "not_found", reason: "Not found." });
  } catch (error) {
    jsonResponse(response, Number(error.status) || 500, {
      ok: false,
      code: error.code || "internal",
      reason: error.message || "Unexpected harness error.",
      details: error.details || {},
    });
  }
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
const baseUrl = `http://127.0.0.1:${address.port}`;
const root = mkdtempSync(path.join(os.tmpdir(), "chanter-cross-process-operator-"));
const databasePath = path.join(root, "operator.sqlite");
let database;

const connectedAccount = {
  connectedAccountId: `tiktok:${accountId}`,
  accountId,
  provider: "tiktok",
  providerDisplayName: "TikTok",
  username: account.username,
  displayName: account.displayName,
  connectionStatus: "connected",
  publishingReady: true,
  readinessBlockers: [],
  lastVerifiedAt: "2026-07-14T08:00:00.000Z",
};
const preparationExecutor = {
  configured: true,
  tenantUserId: "owner",
  async listConnectedAccounts() {
    return { ok: true, workspaceId, count: 1, accounts: [connectedAccount] };
  },
  async validateConnectedAccount() {
    return { ok: true, workspaceId, account: connectedAccount };
  },
  async execute() {
    throw new Error("Preparation executor must never cross the downstream boundary.");
  },
  async reconcileSchedule() {
    throw new Error("Preparation executor does not reconcile.");
  },
  async executeRecovered() {
    throw new Error("Preparation executor does not recover.");
  },
};

let mission;
try {
  database = createDatabase(databasePath);
  let injected = false;
  const service = new AutoPosterMissionService(database, preparationExecutor, {
    failureInjector(boundary) {
      if (!injected && boundary === "after_downstream_request_preparation_persistence") {
        injected = true;
        throw new Error(`INJECTED_PROCESS_TERMINATION:${boundary}`);
      }
    },
  });
  mission = await service.createScheduleMission({
    workspaceId,
    accountId,
    provider: "tiktok",
    mediaUrl: "https://cdn.example.com/cross-process.mp4",
    caption: "Cross-process proof",
    hashtags: "#recovery",
    scheduledAt: new Date(Date.now() + 60 * 60_000).toISOString(),
  });
  try {
    await service.approveAndExecute(mission.missionId, "founder");
    throw new Error("The preparation crash boundary did not fire.");
  } catch (error) {
    if (!String(error.message).includes("after_downstream_request_preparation_persistence")) {
      throw error;
    }
  }
  const durableBeforeChildren = service.getMission(mission.missionId);
  if (durableBeforeChildren.execution?.state !== "downstream_request_prepared") {
    throw new Error("Operator did not durably stop at downstream_request_prepared.");
  }
  database.close();
  database = undefined;

  const runtimeRequest = {
    missionId: mission.missionId,
    traceId: mission.traceId,
    product: "auto_poster",
    action: "autoposter.post.schedule",
    actor: { id: mission.actorId, kind: "service" },
    tenant: { userId: "owner", workspaceId, accountId },
    input: {
      provider: "tiktok",
      accountId,
      mediaUrl: mission.mediaUrl,
      caption: mission.caption,
      hashtags: mission.hashtags,
      scheduledAt: mission.scheduledAt,
    },
    approval: { approved: true, approvedBy: "founder" },
    idempotencyKey: mission.idempotencyKey,
    requestedAt: mission.createdAt,
    policyContext: {
      reason: "Founder approved creation of one unapproved AutoPoster queue draft.",
    },
  };

  const childSource = `
const config = JSON.parse(process.argv[1]);
const runtime = await import(config.runtimeEntry);
const port = runtime.createAutoPosterHttpPort({
  baseUrl: config.baseUrl,
  serviceToken: config.token,
  timeoutMs: 5000
});
const registry = runtime.createMissionAdapterRegistry([
  runtime.createAutoPosterMissionAdapter(port)
]);
const result = await runtime.executeMission(config.request, {
  registry,
  idempotencyStore: runtime.createInMemoryIdempotencyStore()
});
process.stdout.write(JSON.stringify({ pid: process.pid, result }));
`;
  const childConfig = JSON.stringify({
    runtimeEntry: pathToFileURL(runtimeEntry).href,
    baseUrl,
    token,
    request: runtimeRequest,
  });
  const childResults = await Promise.all([
    execFileAsync(process.execPath, ["--input-type=module", "--eval", childSource, childConfig], {
      cwd: appsRoot,
      windowsHide: true,
    }),
    execFileAsync(process.execPath, ["--input-type=module", "--eval", childSource, childConfig], {
      cwd: appsRoot,
      windowsHide: true,
    }),
  ]);
  const callers = childResults.map(({ stdout }) => JSON.parse(stdout));

  database = createDatabase(databasePath);
  const recoveredService = new AutoPosterMissionService(
    database,
    createAutoPosterRuntimeMissionExecutor({
      baseUrl,
      serviceToken: token,
      userId: "owner",
      timeoutValid: true,
      timeoutMs: 5000,
    }),
  );
  const reconciled = await recoveredService.reconcileMission(mission.missionId);
  const finalMission = await recoveredService.resumeSafely(mission.missionId);
  const journal = finalMission.executionJournal;
  const queueIds = callers.map(({ result }) => result.output?.post?.id ?? null);
  const statuses = callers.map(({ result }) => result.status).sort();
  const queueId = jobs[0]?.id ?? null;
  const exactJournalBinding = journal.every((transition, index) =>
    transition.sequence === index + 1
    && transition.missionId === mission.missionId
    && transition.action === mission.action
    && transition.workspaceId === workspaceId
    && transition.provider === "tiktok"
    && transition.accountId === accountId
    && transition.idempotencyKey === mission.idempotencyKey
  );
  const completedTransitions = journal.filter((transition) => transition.newState === "completed");
  const persistedTransitions = journal.filter((transition) => transition.newState === "result_persisted");
  const oneEvidenceChain = exactJournalBinding
    && completedTransitions.length === 1
    && persistedTransitions.length === 1
    && finalMission.execution?.state === "completed"
    && finalMission.execution?.authoritativeQueueId === queueId
    && finalMission.evidenceSummary.queueDraftId === queueId
    && finalMission.runtimeResult?.output?.post?.id === queueId;
  const noSplitBrain = new Set(queueIds).size === 1
    && queueIds[0] === queueId
    && finalMission.status === finalMission.runtimeResult?.status
    && persistedTransitions.length === 1
    && completedTransitions.length === 1
    && journal.at(-1)?.newState === "completed";
  const passed = new Set(callers.map(({ pid }) => pid)).size === 2
    && createAttempts === 1
    && jobs.length === 1
    && Boolean(queueId)
    && Math.max(0, jobs.length - 1) === 0
    && statuses.join(",") === "duplicate,succeeded"
    && oneEvidenceChain
    && noSplitBrain
    && jobs[0].approved === false
    && providerEndpointInvocations === 0;
  const evidenceChainId = createHash("sha256").update(JSON.stringify({
    missionId: mission.missionId,
    queueId,
    transitions: journal.map((transition) => transition.transitionId),
  })).digest("hex");

  console.log(JSON.stringify({
    scenario: "F",
    verdict: passed ? "PASS" : "FAIL",
    cleanRuntimeEntry: runtimeEntry,
    independentRuntimeProcessIds: callers.map(({ pid }) => pid),
    downstreamCreateAttempts: createAttempts,
    downstreamJobCount: jobs.length,
    authoritativeQueueId: queueId,
    duplicateCount: Math.max(0, jobs.length - 1),
    callerStatuses: callers.map(({ result }) => result.status),
    callerQueueIds: queueIds,
    callersConverged: new Set(queueIds).size === 1 && queueIds[0] === queueId,
    operatorStateBeforeChildren: durableBeforeChildren.execution?.state,
    reconciliationOutcome: reconciled.execution?.reconciliationOutcome,
    recoveryClassification: finalMission.execution?.recoveryClassification,
    finalOperatorState: finalMission.execution?.state,
    finalOperatorResultStatus: finalMission.runtimeResult?.status,
    operatorJournalTransitions: journal.length,
    authoritativeEvidenceChains: oneEvidenceChain ? 1 : 0,
    evidenceChainId,
    noSplitBrain,
    publishingState: jobs[0]?.approved === false ? "blocked_until_human_approval" : "unsafe",
    providerEndpointInvocations,
  }, null, 2));
  if (!passed) process.exitCode = 1;
} finally {
  if (database) database.close();
  await new Promise((resolve) => server.close(resolve));
  rmSync(root, { recursive: true, force: true });
}
