import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";
import express from "express";
import type { LoopGovernorMissionPort } from "chanter-agent-runtime";

const originalEnvironment = {
  operatorSubmit: process.env.OPERATOR_MISSION_SUBMIT_TOKEN,
  operatorControl: process.env.OPERATOR_CONTROL_TOKEN,
  operatorLedger: process.env.OPERATOR_LEDGER_INGEST_TOKEN,
  runtimeToken: process.env.RUNTIME_CONTROL_TOKEN,
  defaultUser: process.env.APP_DEFAULT_USER_ID,
  adminPassword: process.env.ADMIN_PASSWORD,
  encryptionKey: process.env.TOKEN_ENCRYPTION_KEY,
  youtubeClientId: process.env.YOUTUBE_CLIENT_ID,
  youtubeClientSecret: process.env.YOUTUBE_CLIENT_SECRET,
  youtubeRedirect: process.env.YOUTUBE_REDIRECT_URI,
};

const submitToken = `phase2e-submit-${randomUUID()}`;
const controlToken = `phase2e-control-${randomUUID()}`;
const ledgerToken = `phase2e-ledger-${randomUUID()}`;
const runtimeToken = `phase2e-runtime-${randomUUID()}`;
process.env.OPERATOR_MISSION_SUBMIT_TOKEN = submitToken;
process.env.OPERATOR_CONTROL_TOKEN = controlToken;
process.env.OPERATOR_LEDGER_INGEST_TOKEN = ledgerToken;
process.env.RUNTIME_CONTROL_TOKEN = runtimeToken;
process.env.APP_DEFAULT_USER_ID = "owner";
process.env.ADMIN_PASSWORD = "phase2e-test-admin-password";
process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
process.env.YOUTUBE_CLIENT_ID = "phase2e.apps.googleusercontent.com";
process.env.YOUTUBE_CLIENT_SECRET = "phase2e-test-client-secret";
process.env.YOUTUBE_REDIRECT_URI = "http://localhost:10000/auth/youtube/callback";

const [
  { createApp },
  { AuditLogger },
  { AgentRunLedgerService },
  { createDatabase },
  { GenericMissionService },
  { MissionGraphChildDispatcher },
  { MissionGraphService },
  { createLoopGovernorMissionExecutor },
  { MockRunner },
  { AutoPosterMissionService },
  { createAutoPosterRuntimeMissionExecutor },
  { OperatorService },
  { ensureWorkspace },
] = await Promise.all([
  import("../../apps/backend/src/app.js"),
  import("../../apps/backend/src/audit/auditLogger.js"),
  import("../../apps/backend/src/agentRunLedger/agentRunLedgerService.js"),
  import("../../apps/backend/src/db/database.js"),
  import("../../apps/backend/src/missions/genericMissionService.js"),
  import("../../apps/backend/src/missions/missionGraphChildDispatcher.js"),
  import("../../apps/backend/src/missions/missionGraphService.js"),
  import("../../apps/backend/src/missions/loopGovernorRuntime.js"),
  import("../../apps/backend/src/runners/mockRunner.js"),
  import("../../apps/backend/src/runtimeMissions/autoPosterMissionService.js"),
  import("../../apps/backend/src/runtimeMissions/autoPosterRuntime.js"),
  import("../../apps/backend/src/services/operatorService.js"),
  import("../../apps/backend/src/workspace/pathGuard.js"),
]);

const require = createRequire(import.meta.url);
const autoPosterRoot = path.resolve(import.meta.dirname, "../../../chanter-auto-poster");
const applicationServiceModule = require(
  path.join(autoPosterRoot, "src", "autoposterApplicationService.js"),
) as Record<string, any>;
const runtimeControlRoutes = require(
  path.join(autoPosterRoot, "src", "runtimeControlRoutes.js"),
);
const autoPosterConfig = require(path.join(autoPosterRoot, "src", "config.js"));
const mediaPolicy = require(path.join(autoPosterRoot, "src", "mediaPolicy.js"));
const { createCommercialFixture } = require(
  path.join(autoPosterRoot, "test", "helpers", "commercial-fixture.js"),
);

const OWNER_ID = "owner";
const WORKSPACE_ID = "workspace-phase2e-integration";
const TIKTOK_ACCOUNT = "tt-phase2e";
const YOUTUBE_ACCOUNT = "UC-phase2e";
const UPLOAD_SCOPE = "https://www.googleapis.com/auth/youtube.upload";
const READONLY_SCOPE = "https://www.googleapis.com/auth/youtube.readonly";

interface StoredPost {
  id: string;
  userId: string;
  workspaceId: string;
  provider: "tiktok" | "youtube";
  platform: "tiktok" | "youtube";
  accountId: string;
  connectedAccountId: string;
  username: string;
  mediaType: "video";
  mediaUrl: string;
  caption: string;
  hashtags: string;
  scheduledAt: string;
  status: "scheduled";
  approved: false;
  approvedAt: null;
  approvedBy: "";
  idempotencyKey: string;
  runtimeIdempotencyKey: string;
  runtimeScheduledBy: string;
  runtimeMissionId: string;
  runtimeAction: string;
  runtimePayloadHash: string;
  createdAt: string;
  updatedAt: string;
}

interface StorageBoundary {
  posts: StoredPost[];
  addCalls: Array<Record<string, unknown>>;
  providerPublishCalls: number;
  adapter: Record<string, (...args: any[]) => any>;
}

function accountFixtures() {
  const tiktok = {
    accountId: TIKTOK_ACCOUNT,
    userId: OWNER_ID,
    workspaceId: WORKSPACE_ID,
    provider: "tiktok",
    platform: "tiktok",
    open_id: TIKTOK_ACCOUNT,
    username: "phase2e_tiktok",
    displayName: "Phase 2E TikTok",
    connected: true,
    access_token: "test-access-value",
    refresh_token: "test-refresh-value",
    scope: "user.info.basic,video.publish",
  };
  const youtube = {
    accountId: YOUTUBE_ACCOUNT,
    id: YOUTUBE_ACCOUNT,
    userId: OWNER_ID,
    workspaceId: WORKSPACE_ID,
    provider: "youtube",
    platform: "youtube",
    channelId: YOUTUBE_ACCOUNT,
    username: "phase2e_youtube",
    displayName: "Phase 2E YouTube",
    connected: true,
    tokenPresent: true,
    refreshTokenPresent: true,
    accessTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    grantedScopes: `${UPLOAD_SCOPE} ${READONLY_SCOPE}`,
    scope: `${UPLOAD_SCOPE} ${READONLY_SCOPE}`,
    reauthorizationRequired: false,
    connectedAt: new Date().toISOString(),
  };
  return { tiktok, youtube };
}

function createStorageBoundary(): StorageBoundary {
  const posts: StoredPost[] = [];
  const addCalls: Array<Record<string, unknown>> = [];
  const accounts = accountFixtures();
  const matches = (candidate: any, userId: string, accountId: string) =>
    candidate.userId === userId && candidate.accountId === accountId;
  const adapter = {
    async getCanonicalTikTokAccount(userId: string, accountId: string) {
      return matches(accounts.tiktok, userId, accountId) ? accounts.tiktok : null;
    },
    async getCanonicalTikTokAccounts(userId: string) {
      return userId === OWNER_ID ? [accounts.tiktok] : [];
    },
    async getTikTokAccount(userId: string, accountId: string) {
      return matches(accounts.tiktok, userId, accountId) ? accounts.tiktok : null;
    },
    async getTikTokAccounts(userId: string) {
      return userId === OWNER_ID ? [accounts.tiktok] : [];
    },
    async getYouTubeAccount(userId: string, accountId: string) {
      return matches(accounts.youtube, userId, accountId) ? accounts.youtube : null;
    },
    async getYouTubeAccounts(userId: string) {
      return userId === OWNER_ID ? [accounts.youtube] : [];
    },
    async listConnectedAccountReferencesForOwner(userId: string) {
      return userId === OWNER_ID
        ? [accounts.tiktok, accounts.youtube].map((account) => ({
            provider: account.provider,
            accountId: account.accountId,
            workspaceId: account.workspaceId,
          }))
        : [];
    },
    async getPosts(userId: string, accountId?: string) {
      return posts.filter((post) =>
        post.userId === userId && (!accountId || post.accountId === accountId));
    },
    async getPost(userId: string, id: string, accountId?: string) {
      return posts.find((post) =>
        post.userId === userId
        && post.id === id
        && (!accountId || post.accountId === accountId)) ?? null;
    },
    async addUploadedPosts(userId: string, _files: unknown[], defaults: Record<string, any>) {
      addCalls.push({ userId, defaults: structuredClone(defaults) });
      const id = String(defaults.documentId || `post-${posts.length + 1}`);
      if (posts.some((post) => post.id === id)) {
        const error = new Error("already exists") as Error & { code?: number };
        error.code = 6;
        throw error;
      }
      const provider = defaults.provider as "tiktok" | "youtube";
      const account = defaults.accounts[0];
      const timestamp = new Date().toISOString();
      const post: StoredPost = {
        id,
        userId,
        workspaceId: defaults.workspaceId,
        provider,
        platform: provider,
        accountId: account.accountId,
        connectedAccountId: `${provider}:${account.accountId}`,
        username: account.username,
        mediaType: "video",
        mediaUrl: defaults.publicMediaUrl,
        caption: defaults.caption,
        hashtags: defaults.hashtags,
        scheduledAt: defaults.scheduledAt,
        status: "scheduled",
        approved: false,
        approvedAt: null,
        approvedBy: "",
        idempotencyKey: defaults.idempotencyKey,
        runtimeIdempotencyKey: defaults.runtimeIdempotencyKey,
        runtimeScheduledBy: defaults.runtimeScheduledBy,
        runtimeMissionId: defaults.runtimeMissionId,
        runtimeAction: defaults.runtimeAction,
        runtimePayloadHash: defaults.runtimePayloadHash,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      posts.push(post);
      return [post];
    },
  };
  return { posts, addCalls, providerPublishCalls: 0, adapter };
}

interface RunningAutoPoster {
  baseUrl: string;
  reconciliationCalls: number;
  stop(): Promise<void>;
}

async function startAutoPoster(
  storage: StorageBoundary,
  failureInjector?: (boundary: string, details: Record<string, unknown>) => void,
): Promise<RunningAutoPoster> {
  const commercial = createCommercialFixture(storage.adapter, {
    accounts: Object.values(accountFixtures()),
    posts: storage.posts,
  });
  const service = applicationServiceModule.createAutoPosterApplicationService({
    storage: storage.adapter,
    mediaPolicy,
    commercialService: commercial,
    failureInjector,
  });
  let reconciliationCalls = 0;
  const reconcile = service.reconcileRuntimeSchedule.bind(service);
  service.reconcileRuntimeSchedule = async (...args: unknown[]) => {
    reconciliationCalls += 1;
    return reconcile(...args);
  };
  const methodNames = [
    "listConnectedAccounts",
    "validateConnectedAccount",
    "listQueue",
    "getPostStatus",
    "validateMedia",
    "schedulePost",
    "reconcileRuntimeSchedule",
  ];
  const originals = Object.fromEntries(
    methodNames.map((name) => [name, applicationServiceModule[name]]),
  );
  for (const name of methodNames) applicationServiceModule[name] = service[name];
  autoPosterConfig.runtimeControl.token = runtimeToken;
  autoPosterConfig.defaultUserId = OWNER_ID;

  const app = express();
  app.use("/api/runtime", runtimeControlRoutes);
  app.use((error: any, _request: any, response: any, _next: any) => {
    response.status(error?.status || 500).json({
      ok: false,
      code: error?.code || "internal",
      reason: error?.message || "Unexpected AutoPoster test-boundary error.",
    });
  });
  const server = await new Promise<Server>((resolve, reject) => {
    const listening: Server = app.listen(0, "127.0.0.1", () => resolve(listening));
    listening.once("error", reject);
  });
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    get reconciliationCalls() { return reconciliationCalls; },
    async stop() {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
      Object.assign(applicationServiceModule, originals);
    },
  };
}

function loopPort(): LoopGovernorMissionPort {
  return {
    async createManualLoop() {
      return {
        ok: true,
        created: true,
        taskId: "phase2e-unused-task",
        loopId: "phase2e-unused-loop",
        realAgentExecution: false,
      };
    },
    async lookupManualLoop() {
      return { ok: true, outcome: "not_found", binding: null };
    },
  };
}

interface RunningOperator {
  baseUrl: string;
  database: DatabaseSync;
  stop(): Promise<void>;
}

async function startOperator(
  root: string,
  databasePath: string,
  autoPosterBaseUrl: string,
): Promise<RunningOperator> {
  const database = createDatabase(databasePath);
  const operatorService = new OperatorService(
    database,
    new AuditLogger(path.join(root, "operator-audit.jsonl")),
    new MockRunner(),
    ensureWorkspace(path.join(root, "workspace")),
  );
  const protectedValues = [submitToken, controlToken, ledgerToken, runtimeToken];
  const ledger = new AgentRunLedgerService(database, protectedValues);
  const autoPosterExecutor = createAutoPosterRuntimeMissionExecutor({
    baseUrl: autoPosterBaseUrl,
    serviceToken: runtimeToken,
    userId: OWNER_ID,
    timeoutMs: 5_000,
    timeoutValid: true,
  });
  const autoPoster = new AutoPosterMissionService(database, autoPosterExecutor, {
    agentRunLedgerService: ledger,
    protectedValues,
  });
  const generic = new GenericMissionService(
    database,
    createLoopGovernorMissionExecutor(
      { pythonExecutable: "", governorRoot: "", dataDir: "", timeoutValid: true },
      { port: loopPort() },
    ),
    { agentRunLedgerService: ledger, protectedValues },
  );
  const graph = new MissionGraphService(
    database,
    new MissionGraphChildDispatcher(generic, autoPoster),
    { protectedValues },
  );
  const app = createApp(operatorService, autoPoster, ledger, generic, graph);
  const server = await new Promise<Server>((resolve, reject) => {
    const listening: Server = app.listen(0, "127.0.0.1", () => resolve(listening));
    listening.once("error", reject);
  });
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    database,
    async stop() {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
      database.close();
    },
  };
}

function scheduleNode(
  nodeId: string,
  provider: "tiktok" | "youtube",
  scheduledAt: string,
) {
  const youtube = provider === "youtube";
  return {
    nodeId,
    target: { product: "auto_poster", action: "autoposter.post.schedule" },
    objective: `Schedule the explicit ${provider} unapproved draft.`,
    input: {
      provider,
      accountId: youtube ? YOUTUBE_ACCOUNT : TIKTOK_ACCOUNT,
      mediaUrl: `https://cdn.example.com/${provider}-${nodeId}.mp4`,
      caption: `Phase 2E ${provider} caption`,
      hashtags: "#chanter #phase2e",
      ...(youtube ? { title: "Phase 2E private upload", description: "Private only." } : {}),
      scheduledAt,
    },
    dependsOn: [],
  };
}

function graphEnvelope(graphId: string, nodes?: ReturnType<typeof scheduleNode>[]) {
  const now = Date.now();
  return {
    schemaVersion: "chanter.mission.graph.v1",
    graphId,
    traceId: `${graphId}-trace`,
    idempotencyKey: `${graphId}-key`,
    source: { system: "operator", requestedBy: "founder-phase2e" },
    objective: "Schedule the bounded explicit AutoPoster draft batch.",
    tenant: { userId: OWNER_ID, workspaceId: WORKSPACE_ID },
    nodes: nodes ?? [
      scheduleNode("tiktok_node", "tiktok", new Date(now + 3_600_000).toISOString()),
      scheduleNode("youtube_node", "youtube", new Date(now + 7_200_000).toISOString()),
    ],
    requestedAt: new Date(now).toISOString(),
  };
}

async function operatorCall(
  baseUrl: string,
  method: string,
  pathname: string,
  token: string | null,
  body?: unknown,
) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    redirect: "error",
  });
  return { response, body: await response.json() as Record<string, any> };
}

function countRows(database: DatabaseSync, table: string): number {
  const row = database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
    count: number;
  };
  return Number(row.count);
}

const roots: string[] = [];

function temporaryRoot(prefix: string): string {
  const root = mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

after(() => {
  const restore = (name: string, value: string | undefined) => {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };
  restore("OPERATOR_MISSION_SUBMIT_TOKEN", originalEnvironment.operatorSubmit);
  restore("OPERATOR_CONTROL_TOKEN", originalEnvironment.operatorControl);
  restore("OPERATOR_LEDGER_INGEST_TOKEN", originalEnvironment.operatorLedger);
  restore("RUNTIME_CONTROL_TOKEN", originalEnvironment.runtimeToken);
  restore("APP_DEFAULT_USER_ID", originalEnvironment.defaultUser);
  restore("ADMIN_PASSWORD", originalEnvironment.adminPassword);
  restore("TOKEN_ENCRYPTION_KEY", originalEnvironment.encryptionKey);
  restore("YOUTUBE_CLIENT_ID", originalEnvironment.youtubeClientId);
  restore("YOUTUBE_CLIENT_SECRET", originalEnvironment.youtubeClientSecret);
  restore("YOUTUBE_REDIRECT_URI", originalEnvironment.youtubeRedirect);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("Phase 2E-A real contract: capability/hash gates, mixed drafts, replay, and restart", async (context) => {
  const storage = createStorageBoundary();
  const autoPoster = await startAutoPoster(storage);
  const root = temporaryRoot("chanter-phase2e-integration-");
  const databasePath = path.join(root, "operator.sqlite");
  let operator = await startOperator(root, databasePath, autoPoster.baseUrl);
  context.after(async () => {
    await operator.stop().catch(() => undefined);
    await autoPoster.stop();
  });

  const envelope = graphEnvelope("phase2e-real-contract");
  const missing = await operatorCall(operator.baseUrl, "POST", "/api/mission-graphs", null, envelope);
  const wrong = await operatorCall(operator.baseUrl, "POST", "/api/mission-graphs", "wrong", envelope);
  assert.equal(missing.response.status, 401);
  assert.equal(wrong.response.status, 401);
  assert.equal(storage.addCalls.length, 0);

  const submitted = await operatorCall(
    operator.baseUrl,
    "POST",
    "/api/mission-graphs",
    submitToken,
    envelope,
  );
  assert.equal(submitted.response.status, 201);
  assert.equal(submitted.body.status, "approval_required");
  assert.equal(storage.addCalls.length, 0);

  const submitCannotApprove = await operatorCall(
    operator.baseUrl,
    "POST",
    `/api/mission-graphs/${envelope.graphId}/approve`,
    submitToken,
    { approvedBy: "founder-phase2e", graphHash: submitted.body.graphHash },
  );
  assert.equal(submitCannotApprove.response.status, 401);
  const wrongHash = await operatorCall(
    operator.baseUrl,
    "POST",
    `/api/mission-graphs/${envelope.graphId}/approve`,
    controlToken,
    { approvedBy: "founder-phase2e", graphHash: "0".repeat(64) },
  );
  assert.equal(wrongHash.response.status, 409);
  assert.equal(storage.addCalls.length, 0);

  const approved = await operatorCall(
    operator.baseUrl,
    "POST",
    `/api/mission-graphs/${envelope.graphId}/approve`,
    controlToken,
    { approvedBy: "founder-phase2e", graphHash: submitted.body.graphHash },
  );
  assert.equal(approved.response.status, 200);
  assert.equal(approved.body.status, "completed");
  assert.equal(storage.posts.length, 2);
  assert.equal(storage.addCalls.length, 2);
  assert.equal(storage.providerPublishCalls, 0);
  assert.equal(countRows(operator.database, "autoposter_runtime_missions"), 2);
  assert.equal(countRows(operator.database, "operator_missions"), 0);
  for (const post of storage.posts) {
    assert.equal(post.status, "scheduled");
    assert.equal(post.approved, false);
    assert.equal(post.approvedAt, null);
    assert.equal(post.approvedBy, "");
  }
  for (const node of approved.body.nodes) {
    assert.equal(node.resultSummary.status, "scheduled");
    assert.equal(node.resultSummary.approved, false);
    assert.equal(node.resultSummary.publishing, "blocked_until_human_approval");
    assert.doesNotMatch(JSON.stringify(node.resultSummary), /posted|published|provider-complete/i);
  }
  const serializedGraph = JSON.stringify(approved.body);
  for (const protectedValue of [
    submitToken,
    controlToken,
    ledgerToken,
    runtimeToken,
    "test-access-value",
    "test-refresh-value",
    "phase2e-test-client-secret",
  ]) {
    assert.equal(serializedGraph.includes(protectedValue), false);
  }
  assert.doesNotMatch(
    serializedGraph,
    /access_token|refresh_token|open_id|grantedScopes|providerMetadata/i,
  );

  const replay = await operatorCall(
    operator.baseUrl,
    "POST",
    `/api/mission-graphs/${envelope.graphId}/approve`,
    controlToken,
    { approvedBy: "founder-phase2e", graphHash: submitted.body.graphHash },
  );
  assert.equal(replay.response.status, 200);
  assert.equal(replay.body.replayed, true);
  assert.equal(storage.addCalls.length, 2);

  await operator.stop();
  operator = await startOperator(root, databasePath, autoPoster.baseUrl);
  const afterRestart = await operatorCall(
    operator.baseUrl,
    "POST",
    `/api/mission-graphs/${envelope.graphId}/approve`,
    controlToken,
    { approvedBy: "founder-phase2e", graphHash: submitted.body.graphHash },
  );
  assert.equal(afterRestart.response.status, 200);
  assert.equal(afterRestart.body.status, "completed");
  assert.equal(afterRestart.body.replayed, true);
  assert.equal(storage.addCalls.length, 2);
  assert.equal(storage.posts.length, 2);

  console.log(`PHASE2E_AUTPOSTER_GRAPH_EVIDENCE ${JSON.stringify({
    graphId: envelope.graphId,
    graphHash: submitted.body.graphHash,
    nodes: approved.body.nodes.map((node: any) => ({
      nodeId: node.nodeId,
      childMissionId: node.childMissionId,
      queueDraftId: node.resultSummary.queueDraftId,
      status: node.resultSummary.status,
      approved: node.resultSummary.approved,
      publishing: node.resultSummary.publishing,
    })),
    submissionWrites: 0,
    wrongCapabilityWrites: 0,
    wrongHashWrites: 0,
    exactApprovalWrites: 2,
    replayAdditionalWrites: 0,
    restartAdditionalWrites: 0,
    providerPublishCalls: storage.providerPublishCalls,
  })}`);
});

test("Phase 2E-A real contract: crash after durable queue create reconciles the existing draft", async (context) => {
  const storage = createStorageBoundary();
  let injected = false;
  const autoPoster = await startAutoPoster(storage, (boundary) => {
    if (!injected && boundary === "after_autoposter_durable_create_before_response") {
      injected = true;
      throw new Error("simulated AutoPoster response loss after durable create");
    }
  });
  const root = temporaryRoot("chanter-phase2e-crash-");
  const operator = await startOperator(root, path.join(root, "operator.sqlite"), autoPoster.baseUrl);
  context.after(async () => {
    await operator.stop();
    await autoPoster.stop();
  });
  const envelope = graphEnvelope("phase2e-real-crash", [
    scheduleNode("only", "tiktok", new Date(Date.now() + 3_600_000).toISOString()),
  ]);
  const submitted = await operatorCall(operator.baseUrl, "POST", "/api/mission-graphs", submitToken, envelope);
  const first = await operatorCall(
    operator.baseUrl,
    "POST",
    `/api/mission-graphs/${envelope.graphId}/approve`,
    controlToken,
    { approvedBy: "founder-phase2e", graphHash: submitted.body.graphHash },
  );
  assert.equal(first.response.status, 200);
  assert.equal(first.body.status, "failed_recoverable");
  assert.equal(storage.posts.length, 1);
  assert.equal(storage.addCalls.length, 1);
  assert.equal(storage.posts[0]?.approved, false);

  const resumed = await operatorCall(
    operator.baseUrl,
    "POST",
    `/api/mission-graphs/${envelope.graphId}/resume`,
    controlToken,
    {},
  );
  assert.equal(resumed.response.status, 200);
  assert.equal(resumed.body.status, "completed");
  assert.equal(storage.posts.length, 1);
  assert.equal(storage.addCalls.length, 1);
  assert.equal(autoPoster.reconciliationCalls, 1);
  assert.equal(resumed.body.nodes[0].resultSummary.approved, false);
  assert.equal(storage.providerPublishCalls, 0);
});

test("Phase 2E-A real contract: partial resume and idempotency conflict create no extra drafts", async (context) => {
  const storage = createStorageBoundary();
  let youtubeFailureInjected = false;
  const autoPoster = await startAutoPoster(storage, (boundary, details) => {
    if (
      !youtubeFailureInjected
      && boundary === "before_autoposter_durable_create"
      && String(details.missionId).includes("youtube_node")
    ) {
      youtubeFailureInjected = true;
      throw new Error("simulated one-time YouTube storage outage");
    }
  });
  const root = temporaryRoot("chanter-phase2e-partial-");
  const operator = await startOperator(root, path.join(root, "operator.sqlite"), autoPoster.baseUrl);
  context.after(async () => {
    await operator.stop();
    await autoPoster.stop();
  });
  const partial = graphEnvelope("phase2e-real-partial");
  const submitted = await operatorCall(operator.baseUrl, "POST", "/api/mission-graphs", submitToken, partial);
  const first = await operatorCall(
    operator.baseUrl,
    "POST",
    `/api/mission-graphs/${partial.graphId}/approve`,
    controlToken,
    { approvedBy: "founder-phase2e", graphHash: submitted.body.graphHash },
  );
  assert.equal(first.body.status, "failed_recoverable");
  assert.equal(storage.posts.length, 1);
  assert.equal(storage.addCalls.length, 1);

  const resumed = await operatorCall(
    operator.baseUrl,
    "POST",
    `/api/mission-graphs/${partial.graphId}/resume`,
    controlToken,
    {},
  );
  assert.equal(resumed.body.status, "completed");
  assert.equal(storage.posts.length, 2);
  assert.equal(storage.addCalls.length, 2);

  const conflict = graphEnvelope("phase2e-real-conflict", [
    scheduleNode("conflict", "tiktok", new Date(Date.now() + 10_800_000).toISOString()),
  ]);
  const conflictSubmitted = await operatorCall(
    operator.baseUrl,
    "POST",
    "/api/mission-graphs",
    submitToken,
    conflict,
  );
  const childMissionId = `graph:${conflict.graphId}:node:conflict`;
  const seedTimestamp = new Date().toISOString();
  storage.posts.push({
    id: "conflicting-existing-draft",
    userId: OWNER_ID,
    workspaceId: WORKSPACE_ID,
    provider: "tiktok",
    platform: "tiktok",
    accountId: TIKTOK_ACCOUNT,
    connectedAccountId: `tiktok:${TIKTOK_ACCOUNT}`,
    username: "phase2e_tiktok",
    mediaType: "video",
    mediaUrl: "https://cdn.example.com/conflict.mp4",
    caption: "conflict",
    hashtags: "#conflict",
    scheduledAt: new Date(conflict.nodes[0]!.input.scheduledAt).toISOString(),
    status: "scheduled",
    approved: false,
    approvedAt: null,
    approvedBy: "",
    idempotencyKey: childMissionId,
    runtimeIdempotencyKey: childMissionId,
    runtimeScheduledBy: "other-caller",
    runtimeMissionId: "different-mission-binding",
    runtimeAction: "autoposter.post.schedule",
    runtimePayloadHash: "0".repeat(64),
    createdAt: seedTimestamp,
    updatedAt: seedTimestamp,
  });
  const beforeConflictPosts = storage.posts.length;
  const beforeConflictAdds = storage.addCalls.length;
  const refused = await operatorCall(
    operator.baseUrl,
    "POST",
    `/api/mission-graphs/${conflict.graphId}/approve`,
    controlToken,
    { approvedBy: "founder-phase2e", graphHash: conflictSubmitted.body.graphHash },
  );
  assert.equal(refused.response.status, 200);
  assert.equal(refused.body.status, "failed_terminal");
  assert.equal(refused.body.nodes[0].typedError.code, "AUTOPOSTER_VALIDATION_FAILED");
  assert.equal(storage.posts.length, beforeConflictPosts);
  assert.equal(storage.addCalls.length, beforeConflictAdds);
  assert.equal(storage.providerPublishCalls, 0);
});
