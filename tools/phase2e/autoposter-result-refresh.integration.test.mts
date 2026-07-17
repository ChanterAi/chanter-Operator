/**
 * Phase 2E-B real-contract integration: manual AutoPoster result refresh and
 * durable Operator projection over the genuine boundaries — the real
 * AutoPoster runtime control routes (token-guarded HTTP), the real Agent
 * Runtime strict status parser, and the real Operator projection service,
 * route, and SQLite persistence. Only the Firestore storage adapter and
 * commercial context are test fixtures; provider modules are never invoked.
 */
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

const submitToken = `phase2eb-submit-${randomUUID()}`;
const controlToken = `phase2eb-control-${randomUUID()}`;
const ledgerToken = `phase2eb-ledger-${randomUUID()}`;
const runtimeToken = `phase2eb-runtime-${randomUUID()}`;
process.env.OPERATOR_MISSION_SUBMIT_TOKEN = submitToken;
process.env.OPERATOR_CONTROL_TOKEN = controlToken;
process.env.OPERATOR_LEDGER_INGEST_TOKEN = ledgerToken;
process.env.RUNTIME_CONTROL_TOKEN = runtimeToken;
process.env.APP_DEFAULT_USER_ID = "owner";
process.env.ADMIN_PASSWORD = "phase2eb-test-admin-password";
process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
process.env.YOUTUBE_CLIENT_ID = "phase2eb.apps.googleusercontent.com";
process.env.YOUTUBE_CLIENT_SECRET = "phase2eb-test-client-secret";
process.env.YOUTUBE_REDIRECT_URI = "http://localhost:10000/auth/youtube/callback";

const [
  { createApp },
  { AuditLogger },
  { AgentRunLedgerService },
  { createDatabase },
  { AutoPosterResultProjectionService },
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
  import("../../apps/backend/src/missions/autoPosterResultProjectionService.js"),
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
const WORKSPACE_ID = "workspace-phase2eb-integration";
const TIKTOK_ACCOUNT = "tt-phase2eb";
const YOUTUBE_ACCOUNT = "UC-phase2eb";
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
  status: string;
  approved: boolean;
  approvalState?: "approved" | "unapproved";
  approvedAt: string | null;
  approvedBy: string;
  postedAt?: string | null;
  publishId?: string;
  providerStatus?: string;
  lockedAt?: string | null;
  claimAttempts?: number;
  lastResult?: Record<string, unknown> | null;
  history?: Array<{ at?: string; event: string; detail?: string }>;
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
  statusReads: number;
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
    username: "phase2eb_tiktok",
    displayName: "Phase 2E-B TikTok",
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
    username: "phase2eb_youtube",
    displayName: "Phase 2E-B YouTube",
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
  const boundary: StorageBoundary = {
    posts,
    addCalls,
    statusReads: 0,
    providerPublishCalls: 0,
    adapter: {},
  };
  boundary.adapter = {
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
      boundary.statusReads += 1;
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
        approvalState: "unapproved",
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
  return boundary;
}

/**
 * Simulates AutoPoster's own canonical writers (human approval, scheduler,
 * provider adapters) mutating the job document. This is the ONLY place job
 * state changes; the Operator refresh path is read-only by contract.
 */
function autoPosterWrites(storage: StorageBoundary, postId: string, patch: Partial<StoredPost>): void {
  const post = storage.posts.find((candidate) => candidate.id === postId);
  assert.ok(post, `canonical job ${postId} exists`);
  Object.assign(post!, patch);
}

interface RunningAutoPoster {
  baseUrl: string;
  stop(): Promise<void>;
}

async function startAutoPoster(storage: StorageBoundary): Promise<RunningAutoPoster> {
  const commercial = createCommercialFixture(storage.adapter, {
    accounts: Object.values(accountFixtures()),
    posts: storage.posts,
  });
  const service = applicationServiceModule.createAutoPosterApplicationService({
    storage: storage.adapter,
    mediaPolicy,
    commercialService: commercial,
  });
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
        taskId: "phase2eb-unused-task",
        loopId: "phase2eb-unused-loop",
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
  const results = new AutoPosterResultProjectionService(database, autoPosterExecutor);
  const app = createApp(operatorService, autoPoster, ledger, generic, graph, results);
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
      caption: `Phase 2E-B ${provider} caption`,
      hashtags: "#chanter #phase2eb",
      ...(youtube ? { title: "Phase 2E-B private upload", description: "Private only." } : {}),
      scheduledAt,
    },
    dependsOn: [],
  };
}

function graphEnvelope(graphId: string) {
  const now = Date.now();
  return {
    schemaVersion: "chanter.mission.graph.v1",
    graphId,
    traceId: `${graphId}-trace`,
    idempotencyKey: `${graphId}-key`,
    source: { system: "operator", requestedBy: "founder-phase2eb" },
    objective: "Schedule the bounded AutoPoster draft batch for result collection.",
    tenant: { userId: OWNER_ID, workspaceId: WORKSPACE_ID },
    nodes: [
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

function countRows(database: DatabaseSync, table: string, graphId?: string): number {
  const row = (graphId
    ? database.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE graph_id = ?`).get(graphId)
    : database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()) as { count: number };
  return Number(row.count);
}

function graphTruth(database: DatabaseSync, graphId: string): unknown[] {
  return [
    database.prepare(
      "SELECT * FROM operator_mission_graphs WHERE graph_id = ? ORDER BY graph_id",
    ).all(graphId),
    database.prepare(
      "SELECT * FROM operator_mission_graph_nodes WHERE graph_id = ? ORDER BY node_id",
    ).all(graphId),
  ];
}

function nodeOutcome(body: Record<string, any>, nodeId: string): Record<string, any> {
  const result = (body.results as Array<Record<string, any>>).find(
    (candidate) => candidate.nodeId === nodeId,
  );
  assert.ok(result, `refresh result for ${nodeId}`);
  return result!;
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

test("Phase 2E-B real contract: manual refresh, durable projection, replay, restart, lifecycle truth", async (context) => {
  const storage = createStorageBoundary();
  const autoPoster = await startAutoPoster(storage);
  const root = temporaryRoot("chanter-phase2eb-integration-");
  const databasePath = path.join(root, "operator.sqlite");
  let operator = await startOperator(root, databasePath, autoPoster.baseUrl);
  context.after(async () => {
    await operator.stop().catch(() => undefined);
    await autoPoster.stop();
  });

  // ── Phase 2E-A precondition: one completed schedule graph ────────────────
  const envelope = graphEnvelope("phase2eb-results");
  const refreshPath = `/api/mission-graphs/${envelope.graphId}/autoposter-results/refresh`;
  const submitted = await operatorCall(operator.baseUrl, "POST", "/api/mission-graphs", submitToken, envelope);
  assert.equal(submitted.response.status, 201);
  const approved = await operatorCall(
    operator.baseUrl,
    "POST",
    `/api/mission-graphs/${envelope.graphId}/approve`,
    controlToken,
    { approvedBy: "founder-phase2eb", graphHash: submitted.body.graphHash },
  );
  assert.equal(approved.response.status, 200);
  assert.equal(approved.body.status, "completed");
  assert.equal(storage.posts.length, 2);
  const scheduleWrites = storage.addCalls.length;
  const tiktokJobId = approved.body.nodes
    .find((node: any) => node.nodeId === "tiktok_node").resultSummary.queueDraftId as string;
  const youtubeJobId = approved.body.nodes
    .find((node: any) => node.nodeId === "youtube_node").resultSummary.queueDraftId as string;
  const truthAfterApproval = graphTruth(operator.database, envelope.graphId);

  // ── Capability isolation: only the control token may refresh ────────────
  const readsBeforeRefusals = storage.statusReads;
  for (const [label, token] of [
    ["missing token", null],
    ["submit capability", submitToken],
    ["runtime service token", runtimeToken],
    ["ledger capability", ledgerToken],
  ] as const) {
    const refused = await operatorCall(operator.baseUrl, "POST", refreshPath, token, {});
    assert.equal(refused.response.status, 401, label);
  }
  assert.equal(storage.statusReads, readsBeforeRefusals, "refused refreshes never read AutoPoster");
  assert.equal(countRows(operator.database, "operator_autoposter_result_events", envelope.graphId), 0);

  // ── First refresh: durable awaiting-approval truth ───────────────────────
  const first = await operatorCall(operator.baseUrl, "POST", refreshPath, controlToken, {});
  assert.equal(first.response.status, 200);
  assert.equal(nodeOutcome(first.body, "tiktok_node").outcome, "refreshed");
  assert.equal(nodeOutcome(first.body, "youtube_node").outcome, "refreshed");
  assert.equal(nodeOutcome(first.body, "tiktok_node").projectionStatus, "awaiting_publish_approval");
  assert.equal(first.body.batch.status, "awaiting_results");
  assert.deepEqual(
    first.body.escalations.map((escalation: any) => escalation.reasonCode),
    ["publish_approval_required", "publish_approval_required"],
  );
  assert.equal(countRows(operator.database, "operator_autoposter_result_events", envelope.graphId), 2);
  const serializedFirst = JSON.stringify(first.body);
  for (const secret of [submitToken, controlToken, ledgerToken, runtimeToken,
    "test-access-value", "test-refresh-value", "phase2eb-test-client-secret"]) {
    assert.equal(serializedFirst.includes(secret), false, "no secret reaches the refresh response");
  }
  assert.doesNotMatch(serializedFirst, /mediaUrl|"caption"|lockedBy|access_token|refresh_token/);

  // ── Exact replay and restart replay append nothing ───────────────────────
  const replay = await operatorCall(operator.baseUrl, "POST", refreshPath, controlToken, {});
  assert.equal(nodeOutcome(replay.body, "tiktok_node").outcome, "replayed");
  assert.equal(nodeOutcome(replay.body, "youtube_node").outcome, "replayed");
  assert.equal(countRows(operator.database, "operator_autoposter_result_events", envelope.graphId), 2);

  await operator.stop();
  operator = await startOperator(root, databasePath, autoPoster.baseUrl);
  const afterRestart = await operatorCall(operator.baseUrl, "POST", refreshPath, controlToken, {});
  assert.equal(nodeOutcome(afterRestart.body, "tiktok_node").outcome, "replayed");
  assert.equal(countRows(operator.database, "operator_autoposter_result_events", envelope.graphId), 2);

  // ── AutoPoster human approval lands (canonical writer, not Operator) ─────
  const approvalInstant = new Date(Date.now() + 1_000).toISOString();
  for (const jobId of [tiktokJobId, youtubeJobId]) {
    autoPosterWrites(storage, jobId, {
      approved: true,
      approvalState: "approved",
      approvedAt: approvalInstant,
      approvedBy: "founder@chanter",
      updatedAt: approvalInstant,
    });
  }
  const approvedRefresh = await operatorCall(operator.baseUrl, "POST", refreshPath, controlToken, {});
  assert.equal(nodeOutcome(approvedRefresh.body, "tiktok_node").outcome, "refreshed");
  assert.equal(nodeOutcome(approvedRefresh.body, "tiktok_node").projectionStatus, "approved_for_publish");
  assert.equal(approvedRefresh.body.batch.status, "awaiting_results");
  assert.deepEqual(approvedRefresh.body.escalations, []);

  // ── Older revisions can never overwrite newer confirmed truth ───────────
  const staleInstant = new Date(Date.parse(approvalInstant) - 60_000).toISOString();
  autoPosterWrites(storage, tiktokJobId, {
    approved: false,
    approvalState: "unapproved",
    approvedAt: null,
    approvedBy: "",
    updatedAt: staleInstant,
  });
  const stale = await operatorCall(operator.baseUrl, "POST", refreshPath, controlToken, {});
  assert.equal(nodeOutcome(stale.body, "tiktok_node").outcome, "stale");
  assert.equal(
    nodeOutcome(stale.body, "tiktok_node").projection.projectionStatus,
    "approved_for_publish",
  );
  autoPosterWrites(storage, tiktokJobId, {
    approved: true,
    approvalState: "approved",
    approvedAt: approvalInstant,
    approvedBy: "founder@chanter",
    updatedAt: approvalInstant,
  });

  // ── Provider-specific terminal truth (scheduler/adapters wrote it) ───────
  const postedInstant = new Date(Date.parse(approvalInstant) + 120_000).toISOString();
  autoPosterWrites(storage, tiktokJobId, {
    status: "posted",
    postedAt: postedInstant,
    publishId: "tt-publish-9",
    claimAttempts: 1,
    lastResult: { ok: true, mode: "api", completedAt: postedInstant },
    history: [{ at: postedInstant, event: "posted", detail: "Provider accepted the publish call." }],
    updatedAt: postedInstant,
  });
  autoPosterWrites(storage, youtubeJobId, {
    status: "posted",
    postedAt: postedInstant,
    publishId: "yt-video-123",
    providerStatus: "uploaded_private",
    claimAttempts: 1,
    lastResult: { ok: true, published: true, completedAt: postedInstant },
    history: [{ at: postedInstant, event: "posted", detail: "Uploaded privately." }],
    updatedAt: postedInstant,
  });
  const terminal = await operatorCall(operator.baseUrl, "POST", refreshPath, controlToken, {});
  assert.equal(nodeOutcome(terminal.body, "tiktok_node").projectionStatus, "provider_accepted_unverified");
  assert.equal(nodeOutcome(terminal.body, "youtube_node").projectionStatus, "uploaded_private");
  assert.equal(terminal.body.batch.status, "completed_with_warning");
  assert.deepEqual(terminal.body.escalations, []);
  assert.doesNotMatch(JSON.stringify(terminal.body), /"completed"[^_]/);

  // ── Stored read model serves the same truth without network work ────────
  const readsBeforeGet = storage.statusReads;
  const stored = await operatorCall(
    operator.baseUrl,
    "GET",
    `/api/mission-graphs/${envelope.graphId}/autoposter-results`,
    null,
  );
  assert.equal(stored.response.status, 200);
  assert.equal(stored.body.batch.status, "completed_with_warning");
  assert.equal(storage.statusReads, readsBeforeGet, "the GET read model never reads AutoPoster");

  // ── Hard safety invariants across the whole session ─────────────────────
  assert.equal(storage.addCalls.length, scheduleWrites, "refresh created no queue writes");
  assert.equal(storage.providerPublishCalls, 0, "no provider call ever happened");
  assert.deepEqual(
    graphTruth(operator.database, envelope.graphId),
    truthAfterApproval,
    "Phase 2E-A graph/node execution truth stayed byte-identical",
  );
  assert.equal(countRows(operator.database, "autoposter_runtime_missions"), 2);

  console.log(`PHASE2EB_AUTPOSTER_RESULT_EVIDENCE ${JSON.stringify({
    graphId: envelope.graphId,
    tiktokJobId,
    youtubeJobId,
    firstRefresh: "refreshed/refreshed awaiting_publish_approval",
    replays: "no additional events (incl. restart)",
    finalBatch: terminal.body.batch.status,
    observationEvents: countRows(operator.database, "operator_autoposter_result_events", envelope.graphId),
    autoposterWritesFromRefresh: 0,
    providerCalls: storage.providerPublishCalls,
  })}`);
});

test("Phase 2E-B real contract: failures and identity loss stay independent and fail closed", async (context) => {
  const storage = createStorageBoundary();
  const autoPoster = await startAutoPoster(storage);
  const root = temporaryRoot("chanter-phase2eb-failures-");
  const operator = await startOperator(root, path.join(root, "operator.sqlite"), autoPoster.baseUrl);
  context.after(async () => {
    await operator.stop();
    await autoPoster.stop();
  });

  const envelope = graphEnvelope("phase2eb-failures");
  const refreshPath = `/api/mission-graphs/${envelope.graphId}/autoposter-results/refresh`;
  const submitted = await operatorCall(operator.baseUrl, "POST", "/api/mission-graphs", submitToken, envelope);
  const approved = await operatorCall(
    operator.baseUrl,
    "POST",
    `/api/mission-graphs/${envelope.graphId}/approve`,
    controlToken,
    { approvedBy: "founder-phase2eb", graphHash: submitted.body.graphHash },
  );
  assert.equal(approved.body.status, "completed");
  const tiktokJobId = approved.body.nodes
    .find((node: any) => node.nodeId === "tiktok_node").resultSummary.queueDraftId as string;
  const youtubeJobId = approved.body.nodes
    .find((node: any) => node.nodeId === "youtube_node").resultSummary.queueDraftId as string;

  // ── Definitive failure and ambiguous outcome through the real parser ────
  const failureInstant = new Date(Date.now() + 1_000).toISOString();
  autoPosterWrites(storage, tiktokJobId, {
    status: "failed",
    approved: true,
    approvalState: "approved",
    approvedAt: failureInstant,
    approvedBy: "founder@chanter",
    claimAttempts: 3,
    lastResult: {
      ok: false,
      code: "PROVIDER_AUTH",
      reason: "Reauthorize the TikTok account.",
      definitiveFailure: true,
    },
    history: [{ at: failureInstant, event: "failed", detail: "Reauthorize the TikTok account." }],
    updatedAt: failureInstant,
  });
  autoPosterWrites(storage, youtubeJobId, {
    status: "outcome_unknown",
    approved: true,
    approvalState: "approved",
    approvedAt: failureInstant,
    approvedBy: "founder@chanter",
    providerStatus: "provider_reconciliation_required",
    claimAttempts: 1,
    lastResult: {
      ok: false,
      code: "PROVIDER_RECONCILIATION_REQUIRED",
      reason: "Upload session ended without a definitive result.",
      outcomeUnknown: true,
    },
    history: [{ at: failureInstant, event: "outcome_unknown", detail: "No definitive provider result." }],
    updatedAt: failureInstant,
  });
  const troubled = await operatorCall(operator.baseUrl, "POST", refreshPath, controlToken, {});
  assert.equal(nodeOutcome(troubled.body, "tiktok_node").projectionStatus, "failed");
  assert.equal(nodeOutcome(troubled.body, "youtube_node").projectionStatus, "outcome_unknown");
  assert.equal(troubled.body.batch.status, "outcome_unknown");
  const troubledReasons = troubled.body.escalations
    .map((escalation: any) => escalation.reasonCode).sort();
  assert.deepEqual(troubledReasons, ["outcome_unknown", "provider_reauthorization_required"]);
  const unknownEscalation = troubled.body.escalations
    .find((escalation: any) => escalation.reasonCode === "outcome_unknown");
  assert.equal(unknownEscalation.severity, "critical");
  assert.deepEqual(unknownEscalation.canonicalInspection, {
    adminRoutes: ["/private/autoposter", "/private/autoposter/dashboard"],
    queueJobId: youtubeJobId,
  });

  // ── A vanished bound job is a durable identity verdict, not a retry ─────
  const youtubeIndex = storage.posts.findIndex((post) => post.id === youtubeJobId);
  const [removed] = storage.posts.splice(youtubeIndex, 1);
  const missing = await operatorCall(operator.baseUrl, "POST", refreshPath, controlToken, {});
  const missingNode = nodeOutcome(missing.body, "youtube_node");
  assert.equal(missingNode.outcome, "failed");
  assert.equal(missingNode.reasonCode, "result_identity_mismatch");
  assert.equal(missingNode.projection.projectionStatus, "manual_review_required");
  assert.equal(nodeOutcome(missing.body, "tiktok_node").outcome, "replayed");
  assert.ok(missing.body.escalations.some(
    (escalation: any) => escalation.reasonCode === "partial_batch",
  ));
  assert.equal(missing.body.batch.status, "outcome_unknown");

  // ── Restored canonical truth with a newer revision recovers the node ────
  const restoredInstant = new Date(Date.parse(failureInstant) + 120_000).toISOString();
  storage.posts.push({ ...removed!, updatedAt: restoredInstant });
  const recovered = await operatorCall(operator.baseUrl, "POST", refreshPath, controlToken, {});
  assert.equal(nodeOutcome(recovered.body, "youtube_node").outcome, "refreshed");
  assert.equal(nodeOutcome(recovered.body, "youtube_node").projectionStatus, "outcome_unknown");

  assert.equal(storage.providerPublishCalls, 0);
});
