import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";
import express from "express";
// Type-only: erased at runtime, so the deliberate dynamic import order below
// is unaffected.
import type { LoopGovernorMissionPort } from "chanter-agent-runtime";

/*
 * Canonical Platform cross-repository proof:
 *
 * Platform command HTTP -> real Operator command/graph persistence
 * -> real installed chanter-agent-runtime HTTP adapter
 * -> real AutoPoster runtime route + application service
 * -> AutoPoster's established in-memory storage seam.
 *
 * No provider adapter is installed or called. The proof stops at one
 * scheduled, unapproved product draft and verifies stable replay linkage.
 */

const originalEnvironment = {
  submitToken: process.env.OPERATOR_MISSION_SUBMIT_TOKEN,
  controlToken: process.env.OPERATOR_CONTROL_TOKEN,
  ledgerToken: process.env.OPERATOR_LEDGER_INGEST_TOKEN,
  safeCommitToken: process.env.OPERATOR_SAFECOMMIT_EXECUTOR_TOKEN,
  runtimeToken: process.env.RUNTIME_CONTROL_TOKEN,
  defaultUser: process.env.APP_DEFAULT_USER_ID,
  adminPassword: process.env.ADMIN_PASSWORD,
  encryptionKey: process.env.TOKEN_ENCRYPTION_KEY,
  youtubeClientId: process.env.YOUTUBE_CLIENT_ID,
  youtubeClientSecret: process.env.YOUTUBE_CLIENT_SECRET,
  youtubeRedirect: process.env.YOUTUBE_REDIRECT_URI,
};

const SUBMIT_TOKEN = "platform-canonical-submit-capability";
const CONTROL_TOKEN = "platform-canonical-control-capability";
const LEDGER_TOKEN = "platform-canonical-ledger-capability";
const SAFECOMMIT_TOKEN = "platform-canonical-safecommit-capability";
const RUNTIME_TOKEN = "platform-canonical-runtime-capability";
process.env.OPERATOR_MISSION_SUBMIT_TOKEN = SUBMIT_TOKEN;
process.env.OPERATOR_CONTROL_TOKEN = CONTROL_TOKEN;
process.env.OPERATOR_LEDGER_INGEST_TOKEN = LEDGER_TOKEN;
process.env.OPERATOR_SAFECOMMIT_EXECUTOR_TOKEN = SAFECOMMIT_TOKEN;
process.env.RUNTIME_CONTROL_TOKEN = RUNTIME_TOKEN;
process.env.APP_DEFAULT_USER_ID = "owner";
process.env.ADMIN_PASSWORD = "platform-canonical-test-admin-password";
process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
process.env.YOUTUBE_CLIENT_ID = "platform-canonical.apps.googleusercontent.com";
process.env.YOUTUBE_CLIENT_SECRET = "platform-canonical-youtube-secret";
process.env.YOUTUBE_REDIRECT_URI =
  "http://localhost:10000/auth/youtube/callback";

const [
  { createApp },
  { AuditLogger },
  { AgentRunLedgerService },
  { createDatabase },
  { AutoPosterGraphIntakeService },
  { AutoPosterMissionEvidenceService },
  { AutoPosterObservationService },
  { AutoPosterResultProjectionService },
  { GenericMissionService },
  { MissionGraphChildDispatcher },
  { MissionGraphService },
  { createLoopGovernorMissionExecutor },
  {
    derivePlatformAutoPosterCommandId,
    PlatformAutoPosterCommandService,
  },
  { MockRunner },
  { AutoPosterMissionService },
  { createAutoPosterRuntimeMissionExecutor },
  { OperatorService },
  { ensureWorkspace },
  { approvalAuthorityFixtureFor, cleanupApprovalAuthorityFixtures },
] = await Promise.all([
  import("../../apps/backend/src/app.js"),
  import("../../apps/backend/src/audit/auditLogger.js"),
  import("../../apps/backend/src/agentRunLedger/agentRunLedgerService.js"),
  import("../../apps/backend/src/db/database.js"),
  import("../../apps/backend/src/missions/autoPosterGraphIntake.js"),
  import("../../apps/backend/src/missions/autoPosterMissionEvidenceService.js"),
  import("../../apps/backend/src/missions/autoPosterObservationService.js"),
  import("../../apps/backend/src/missions/autoPosterResultProjectionService.js"),
  import("../../apps/backend/src/missions/genericMissionService.js"),
  import("../../apps/backend/src/missions/missionGraphChildDispatcher.js"),
  import("../../apps/backend/src/missions/missionGraphService.js"),
  import("../../apps/backend/src/missions/loopGovernorRuntime.js"),
  import("../../apps/backend/src/platform/platformAutoPosterCommandService.js"),
  import("../../apps/backend/src/runners/mockRunner.js"),
  import("../../apps/backend/src/runtimeMissions/autoPosterMissionService.js"),
  import("../../apps/backend/src/runtimeMissions/autoPosterRuntime.js"),
  import("../../apps/backend/src/services/operatorService.js"),
  import("../../apps/backend/src/workspace/pathGuard.js"),
  import("../../apps/backend/tests/helpers/approvalAuthorityFixture.js"),
]);

const require = createRequire(import.meta.url);
const autoPosterRoot = path.resolve(
  import.meta.dirname,
  "../../../chanter-auto-poster",
);
const applicationServiceModule = require(
  path.join(autoPosterRoot, "src", "autoposterApplicationService.js"),
) as Record<string, any>;
const runtimeControlRoutes = require(
  path.join(autoPosterRoot, "src", "runtimeControlRoutes.js"),
);
const autoPosterConfig = require(
  path.join(autoPosterRoot, "src", "config.js"),
);
const mediaPolicy = require(
  path.join(autoPosterRoot, "src", "mediaPolicy.js"),
);
const { createCommercialFixture } = require(
  path.join(autoPosterRoot, "test", "helpers", "commercial-fixture.js"),
);

const NOW = "2099-07-26T09:00:00.000Z";
const SCHEDULED_AT = "2099-07-27T12:00:00+03:00";
const OWNER_ID = "owner";
const WORKSPACE_ID = "workspace-platform-canonical";
const ACTOR_ID = "platform-actor-canonical";
const ACCOUNT_ID = "tt-platform-canonical";
const INTAKE_KEY = "platform-canonical-intake-0001";

interface StoredPost {
  id: string;
  userId: string;
  workspaceId: string;
  provider: "tiktok";
  platform: "tiktok";
  connectedAccountId: string;
  accountId: string;
  username: string;
  mediaType: "video";
  mediaUrl: string;
  caption: string;
  hashtags: string;
  scheduledAt: string;
  status: "scheduled";
  approved: false;
  approvalState: "unapproved";
  approvedAt: null;
  approvedBy: "";
  privacyLevel: "SELF_ONLY";
  soundMode: "keep_original" | "mute" | "tiktok_recommended";
  campaignId: string;
  approvalId: string;
  evidenceBundleId: string;
  idempotencyKey: string;
  runtimeIdempotencyKey: string;
  runtimeScheduledBy: string;
  runtimeMissionId: string;
  runtimeGraphId: string;
  runtimeAction: string;
  runtimePayloadHash: string;
  createdAt: string;
  updatedAt: string;
}

interface AutoPosterBoundary {
  posts: StoredPost[];
  durableCreateCalls: number;
  scheduleContractCalls: number;
  accountValidationCalls: number;
  providerPublishCalls: number;
  adapter: Record<string, (...args: any[]) => any>;
}

function accountFixture() {
  return {
    accountId: ACCOUNT_ID,
    connectionId: `tiktok:${ACCOUNT_ID}`,
    userId: OWNER_ID,
    workspaceId: WORKSPACE_ID,
    provider: "tiktok",
    platform: "tiktok",
    open_id: ACCOUNT_ID,
    username: "platform_canonical",
    displayName: "Platform Canonical",
    connected: true,
    publishingReady: true,
    access_token: "redacted-test-access-value",
    refresh_token: "redacted-test-refresh-value",
    scope: "user.info.basic,video.publish",
  };
}

function createAutoPosterBoundary(): AutoPosterBoundary {
  const posts: StoredPost[] = [];
  const account = accountFixture();
  const boundary: AutoPosterBoundary = {
    posts,
    durableCreateCalls: 0,
    scheduleContractCalls: 0,
    accountValidationCalls: 0,
    providerPublishCalls: 0,
    adapter: {},
  };
  const matches = (candidate: typeof account, userId: string, accountId: string) =>
    candidate.userId === userId && candidate.accountId === accountId;
  boundary.adapter = {
    async getCanonicalTikTokAccount(userId: string, accountId: string) {
      return matches(account, userId, accountId) ? account : null;
    },
    async getCanonicalTikTokAccounts(userId: string) {
      return userId === OWNER_ID ? [account] : [];
    },
    async getTikTokAccount(userId: string, accountId: string) {
      return matches(account, userId, accountId) ? account : null;
    },
    async getTikTokAccounts(userId: string) {
      return userId === OWNER_ID ? [account] : [];
    },
    async listConnectedAccountReferencesForOwner(userId: string) {
      return userId === OWNER_ID
        ? [{
            provider: account.provider,
            accountId: account.accountId,
            workspaceId: account.workspaceId,
          }]
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
    async addUploadedPosts(
      userId: string,
      _files: unknown[],
      defaults: Record<string, any>,
    ) {
      boundary.durableCreateCalls += 1;
      const id = String(defaults.documentId);
      if (posts.some((post) => post.id === id)) {
        const error = new Error("already exists") as Error & { code?: number };
        error.code = 6;
        throw error;
      }
      const timestamp = new Date().toISOString();
      const post: StoredPost = {
        id,
        userId,
        workspaceId: defaults.workspaceId,
        provider: "tiktok",
        platform: "tiktok",
        connectedAccountId: `tiktok:${ACCOUNT_ID}`,
        accountId: ACCOUNT_ID,
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
        privacyLevel: "SELF_ONLY",
        soundMode: defaults.soundMode,
        campaignId:
          defaults.campaignId
          || `autoposter-campaign:${defaults.runtimeMissionId}`,
        approvalId: defaults.approvalId,
        evidenceBundleId: defaults.evidenceBundleId,
        idempotencyKey: defaults.idempotencyKey,
        runtimeIdempotencyKey: defaults.runtimeIdempotencyKey,
        runtimeScheduledBy: defaults.runtimeScheduledBy,
        runtimeMissionId: defaults.runtimeMissionId,
        runtimeGraphId: defaults.runtimeGraphId,
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

interface RunningAutoPoster {
  baseUrl: string;
  stop(): Promise<void>;
}

async function startAutoPoster(
  boundary: AutoPosterBoundary,
): Promise<RunningAutoPoster> {
  const account = accountFixture();
  const commercial = createCommercialFixture(boundary.adapter, {
    accounts: [account],
    posts: boundary.posts,
  });
  const service = applicationServiceModule.createAutoPosterApplicationService({
    storage: boundary.adapter,
    mediaPolicy,
    commercialService: commercial,
  });
  const schedulePost = service.schedulePost.bind(service);
  service.schedulePost = async (...args: unknown[]) => {
    boundary.scheduleContractCalls += 1;
    return schedulePost(...args);
  };
  const validateConnectedAccount = service.validateConnectedAccount.bind(service);
  service.validateConnectedAccount = async (...args: unknown[]) => {
    boundary.accountValidationCalls += 1;
    return validateConnectedAccount(...args);
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
  const originalRuntimeToken = autoPosterConfig.runtimeControl.token;
  const originalDefaultUser = autoPosterConfig.defaultUserId;
  for (const name of methodNames) applicationServiceModule[name] = service[name];
  autoPosterConfig.runtimeControl.token = RUNTIME_TOKEN;
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
      autoPosterConfig.runtimeControl.token = originalRuntimeToken;
      autoPosterConfig.defaultUserId = originalDefaultUser;
    },
  };
}

function loopPort(): LoopGovernorMissionPort {
  return {
    async createManualLoop() {
      return {
        ok: true,
        created: true,
        taskId: "platform-canonical-unused-task",
        loopId: "platform-canonical-unused-loop",
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
  runtimeMissions: InstanceType<typeof AutoPosterMissionService>;
  stop(): Promise<void>;
}

async function startOperator(
  root: string,
  autoPosterBaseUrl: string,
): Promise<RunningOperator> {
  const databasePath = path.join(root, "operator.sqlite");
  const database = createDatabase(databasePath);
  // Approval-required execution is authorized only by a persisted, signed
  // approval bound to an exact repository revision. Production wires one
  // authority into both mission executors (runtime.ts); this mirrors that.
  // Keyed by database path so a replay against the same durable mission
  // universe reuses the same checkpoints, observations, and claims.
  const approvalAuthority = approvalAuthorityFixtureFor(databasePath);
  const protectedValues = [
    SUBMIT_TOKEN,
    CONTROL_TOKEN,
    LEDGER_TOKEN,
    SAFECOMMIT_TOKEN,
    RUNTIME_TOKEN,
  ];
  const operatorService = new OperatorService(
    database,
    new AuditLogger(path.join(root, "operator-audit.jsonl")),
    new MockRunner(),
    ensureWorkspace(path.join(root, "workspace")),
  );
  const ledger = new AgentRunLedgerService(database, protectedValues);
  const executor = createAutoPosterRuntimeMissionExecutor({
    baseUrl: autoPosterBaseUrl,
    serviceToken: RUNTIME_TOKEN,
    userId: OWNER_ID,
    timeoutMs: 5_000,
    timeoutValid: true,
    approvalAuthority,
  });
  const runtimeMissions = new AutoPosterMissionService(database, executor, {
    agentRunLedgerService: ledger,
    protectedValues,
    now: () => new Date(NOW),
  });
  const generic = new GenericMissionService(
    database,
    createLoopGovernorMissionExecutor(
      {
        pythonExecutable: "",
        governorRoot: "",
        dataDir: "",
        timeoutValid: true,
        approvalAuthority,
      },
      { port: loopPort() },
    ),
    {
      agentRunLedgerService: ledger,
      protectedValues,
      now: () => new Date(NOW),
    },
  );
  const results = new AutoPosterResultProjectionService(database, executor, {
    now: () => new Date(NOW),
  });
  const observation = new AutoPosterObservationService(database, results, {
    now: () => new Date(NOW),
  });
  const graphs = new MissionGraphService(
    database,
    new MissionGraphChildDispatcher(generic, runtimeMissions),
    {
      protectedValues,
      now: () => new Date(NOW),
      observationScheduler: observation,
    },
  );
  const intake = new AutoPosterGraphIntakeService(
    graphs,
    runtimeMissions,
    executor,
    () => new Date(NOW),
  );
  const evidence = new AutoPosterMissionEvidenceService(
    graphs,
    runtimeMissions,
    results,
    observation,
    executor,
    path.join(root, "evidence"),
    protectedValues,
    () => new Date(NOW),
  );
  const platform = new PlatformAutoPosterCommandService(
    database,
    graphs,
    runtimeMissions,
    executor,
    evidence,
    { protectedValues, now: () => new Date(NOW) },
  );
  const app = createApp(
    operatorService,
    runtimeMissions,
    ledger,
    generic,
    graphs,
    results,
    observation,
    undefined,
    intake,
    evidence,
    platform,
  );
  const server = await new Promise<Server>((resolve, reject) => {
    const listening: Server = app.listen(0, "127.0.0.1", () => resolve(listening));
    listening.once("error", reject);
  });
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    database,
    runtimeMissions,
    async stop() {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
      database.close();
    },
  };
}

function commandBody() {
  const commandId = derivePlatformAutoPosterCommandId(
    WORKSPACE_ID,
    ACTOR_ID,
    INTAKE_KEY,
  );
  return {
    schemaVersion: "chanter.platform.autoposter.create-work.v1",
    commandId,
    tenantId: WORKSPACE_ID,
    actorId: ACTOR_ID,
    intakeKey: INTAKE_KEY,
    media: {
      kind: "public_url",
      url: "https://cdn.example.com/platform-canonical.mp4",
      mediaType: "video",
    },
    destinations: [{
      provider: "tiktok",
      accountId: ACCOUNT_ID,
      soundMode: "tiktok_recommended",
    }],
    copy: {
      caption: "Canonical Platform cross-repository proof",
      hashtags: "#chanter #platform",
      youtube: { title: "", description: "" },
    },
    schedule: {
      mode: "explicit",
      scheduledAt: SCHEDULED_AT,
      timezoneName: "Europe/Nicosia",
      timezoneOffsetMinutes: -180,
    },
    approvalPolicy: {
      draftExecution: "operator_control_required",
      publication: "human_required",
    },
    requestedAt: NOW,
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
  return {
    response,
    body: await response.json() as Record<string, any>,
  };
}

function countRows(database: DatabaseSync, table: string): number {
  const row = database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
    count: number;
  };
  return Number(row.count);
}

const temporaryRoots: string[] = [];

after(() => {
  const restore = (name: string, value: string | undefined) => {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };
  restore(
    "OPERATOR_MISSION_SUBMIT_TOKEN",
    originalEnvironment.submitToken,
  );
  restore("OPERATOR_CONTROL_TOKEN", originalEnvironment.controlToken);
  restore("OPERATOR_LEDGER_INGEST_TOKEN", originalEnvironment.ledgerToken);
  restore(
    "OPERATOR_SAFECOMMIT_EXECUTOR_TOKEN",
    originalEnvironment.safeCommitToken,
  );
  restore("RUNTIME_CONTROL_TOKEN", originalEnvironment.runtimeToken);
  restore("APP_DEFAULT_USER_ID", originalEnvironment.defaultUser);
  restore("ADMIN_PASSWORD", originalEnvironment.adminPassword);
  restore("TOKEN_ENCRYPTION_KEY", originalEnvironment.encryptionKey);
  restore("YOUTUBE_CLIENT_ID", originalEnvironment.youtubeClientId);
  restore("YOUTUBE_CLIENT_SECRET", originalEnvironment.youtubeClientSecret);
  restore("YOUTUBE_REDIRECT_URI", originalEnvironment.youtubeRedirect);
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
  cleanupApprovalAuthorityFixtures();
});

test(
  "canonical Platform command reaches one real AutoPoster draft with stable replay and no publish",
  { timeout: 30_000 },
  async (context) => {
    const boundary = createAutoPosterBoundary();
    const autoPoster = await startAutoPoster(boundary);
    const root = mkdtempSync(
      path.join(os.tmpdir(), "chanter-platform-canonical-integration-"),
    );
    temporaryRoots.push(root);
    let operator = await startOperator(root, autoPoster.baseUrl);
    context.after(async () => {
      await operator.stop().catch(() => undefined);
      await autoPoster.stop().catch(() => undefined);
    });

    const command = commandBody();
    const submitted = await operatorCall(
      operator.baseUrl,
      "POST",
      "/api/platform/autoposter-commands",
      SUBMIT_TOKEN,
      command,
    );
    assert.equal(submitted.response.status, 201);
    assert.equal(submitted.body.commandId, command.commandId);
    assert.equal(submitted.body.lifecycleState, "approval_required");
    assert.equal(submitted.body.productState, "not_started");
    assert.equal(submitted.body.draftExecutionApprovalState, "required");
    assert.equal(submitted.body.publicationApprovalState, "human_required");
    assert.match(submitted.body.graphHash, /^[a-f0-9]{64}$/);
    assert.equal(boundary.accountValidationCalls, 1);
    assert.equal(boundary.scheduleContractCalls, 0);
    assert.equal(boundary.durableCreateCalls, 0);
    assert.equal(boundary.posts.length, 0);
    assert.equal(countRows(
      operator.database,
      "operator_platform_autoposter_commands",
    ), 1);
    assert.equal(countRows(operator.database, "operator_mission_graphs"), 1);
    assert.equal(countRows(operator.database, "autoposter_runtime_missions"), 0);

    const changedTimestampReplay = await operatorCall(
      operator.baseUrl,
      "POST",
      "/api/platform/autoposter-commands",
      SUBMIT_TOKEN,
      { ...command, requestedAt: "2099-07-26T09:05:00.000Z" },
    );
    assert.equal(changedTimestampReplay.response.status, 409);
    assert.equal(
      changedTimestampReplay.body.code,
      "PLATFORM_COMMAND_PAYLOAD_MISMATCH",
    );

    const submitReplay = await operatorCall(
      operator.baseUrl,
      "POST",
      "/api/platform/autoposter-commands",
      SUBMIT_TOKEN,
      command,
    );
    assert.equal(submitReplay.response.status, 200);
    assert.equal(submitReplay.body.replayed, true);
    assert.equal(submitReplay.body.commandId, submitted.body.commandId);
    assert.equal(submitReplay.body.graphId, submitted.body.graphId);
    assert.equal(submitReplay.body.graphHash, submitted.body.graphHash);
    assert.equal(submitReplay.body.requestedAt, NOW);
    assert.equal(boundary.accountValidationCalls, 1);

    const submitTokenCannotExecute = await operatorCall(
      operator.baseUrl,
      "POST",
      `/api/platform/autoposter-commands/${submitted.body.commandId}/execute`,
      SUBMIT_TOKEN,
      { graphHash: submitted.body.graphHash },
    );
    assert.equal(submitTokenCannotExecute.response.status, 401);
    const wrongHash = await operatorCall(
      operator.baseUrl,
      "POST",
      `/api/platform/autoposter-commands/${submitted.body.commandId}/execute`,
      CONTROL_TOKEN,
      { graphHash: "0".repeat(64) },
    );
    assert.equal(wrongHash.response.status, 409);
    assert.equal(boundary.scheduleContractCalls, 0);
    assert.equal(boundary.posts.length, 0);

    const executed = await operatorCall(
      operator.baseUrl,
      "POST",
      `/api/platform/autoposter-commands/${submitted.body.commandId}/execute`,
      CONTROL_TOKEN,
      { graphHash: submitted.body.graphHash },
    );
    assert.equal(executed.response.status, 200);
    assert.equal(executed.body.commandId, submitted.body.commandId);
    assert.equal(executed.body.graphId, submitted.body.graphId);
    assert.equal(executed.body.graphHash, submitted.body.graphHash);
    assert.equal(executed.body.lifecycleState, "completed");
    assert.equal(executed.body.productState, "draft_created");
    assert.equal(executed.body.draftExecutionApprovalState, "approved");
    assert.equal(executed.body.publicationApprovalState, "human_required");
    assert.equal(executed.body.evidenceAvailable, true);
    assert.equal(executed.body.error, null);
    assert.equal(executed.body.jobIds.length, 1);
    assert.ok(executed.body.runtimeExecutionId);
    assert.ok(executed.body.campaignId);
    assert.equal(
      executed.body.approvalId,
      `autoposter-approval:${executed.body.missionId}`,
    );
    assert.equal(
      executed.body.evidenceBundleId,
      `autoposter-evidence:${executed.body.graphId}`,
    );
    assert.ok(executed.body.traceId);
    assert.match(executed.body.evidenceReference, /\.json$/);

    assert.equal(boundary.scheduleContractCalls, 1);
    assert.equal(boundary.durableCreateCalls, 1);
    assert.equal(boundary.posts.length, 1);
    assert.equal(boundary.providerPublishCalls, 0);
    const draft = boundary.posts[0]!;
    assert.equal(draft.id, executed.body.jobIds[0]);
    assert.equal(draft.campaignId, executed.body.campaignId);
    assert.equal(draft.approvalId, executed.body.approvalId);
    assert.equal(draft.evidenceBundleId, executed.body.evidenceBundleId);
    assert.equal(draft.runtimeGraphId, executed.body.graphId);
    assert.equal(draft.approved, false);
    assert.equal(draft.approvalState, "unapproved");
    assert.equal(draft.status, "scheduled");
    assert.equal(draft.scheduledAt, new Date(SCHEDULED_AT).toISOString());
    assert.equal(draft.privacyLevel, "SELF_ONLY");
    assert.equal(draft.soundMode, "tiktok_recommended");

    const runtimeMission = operator.runtimeMissions.getMission(
      executed.body.missionId,
    );
    assert.equal(runtimeMission.execution?.state, "completed");
    const runtimeOutput = runtimeMission.runtimeResult?.output as
      | Record<string, any>
      | undefined;
    assert.equal(runtimeOutput?.duplicate, false);
    assert.equal(
      runtimeOutput?.publishing,
      "blocked_until_human_approval",
    );
    assert.deepEqual(runtimeOutput?.post, {
      id: executed.body.jobIds[0],
      accountId: ACCOUNT_ID,
      provider: "tiktok",
      status: "scheduled",
      scheduledAt: new Date(SCHEDULED_AT).toISOString(),
      approved: false,
      campaignId: executed.body.campaignId,
      approvalId: executed.body.approvalId,
      evidenceBundleId: executed.body.evidenceBundleId,
    });

    const executeReplay = await operatorCall(
      operator.baseUrl,
      "POST",
      `/api/platform/autoposter-commands/${submitted.body.commandId}/execute`,
      CONTROL_TOKEN,
      { graphHash: submitted.body.graphHash },
    );
    assert.equal(executeReplay.response.status, 200);
    assert.equal(executeReplay.body.replayed, true);
    for (const field of [
      "commandId",
      "graphId",
      "graphHash",
      "missionId",
      "runtimeExecutionId",
      "campaignId",
      "approvalId",
      "evidenceBundleId",
      "traceId",
    ]) {
      assert.equal(executeReplay.body[field], executed.body[field]);
    }
    assert.deepEqual(executeReplay.body.jobIds, executed.body.jobIds);
    assert.equal(boundary.scheduleContractCalls, 1);
    assert.equal(boundary.durableCreateCalls, 1);
    assert.equal(boundary.posts.length, 1);
    assert.equal(boundary.providerPublishCalls, 0);

    await operator.stop();
    operator = await startOperator(root, autoPoster.baseUrl);
    const restartReplay = await operatorCall(
      operator.baseUrl,
      "POST",
      `/api/platform/autoposter-commands/${submitted.body.commandId}/execute`,
      CONTROL_TOKEN,
      { graphHash: submitted.body.graphHash },
    );
    assert.equal(restartReplay.response.status, 200);
    assert.equal(restartReplay.body.replayed, true);
    for (const field of [
      "commandId",
      "graphId",
      "graphHash",
      "missionId",
      "runtimeExecutionId",
      "campaignId",
      "approvalId",
      "evidenceBundleId",
      "traceId",
    ]) {
      assert.equal(restartReplay.body[field], executed.body[field]);
    }
    assert.deepEqual(restartReplay.body.jobIds, executed.body.jobIds);
    assert.equal(boundary.scheduleContractCalls, 1);
    assert.equal(boundary.durableCreateCalls, 1);
    assert.equal(boundary.posts.length, 1);
    assert.equal(boundary.providerPublishCalls, 0);

    const list = await operatorCall(
      operator.baseUrl,
      "GET",
      "/api/platform/autoposter-commands",
      null,
    );
    const detail = await operatorCall(
      operator.baseUrl,
      "GET",
      `/api/platform/autoposter-commands/${submitted.body.commandId}`,
      null,
    );
    assert.equal(list.response.status, 200);
    assert.equal(list.body.commands.length, 1);
    assert.equal(detail.response.status, 200);
    assert.equal(detail.body.commandId, executed.body.commandId);
    assert.equal(JSON.stringify(detail.body).includes(root), false);
    assert.equal(countRows(
      operator.database,
      "operator_platform_autoposter_commands",
    ), 1);
    assert.equal(countRows(operator.database, "operator_mission_graphs"), 1);
    assert.equal(countRows(operator.database, "autoposter_runtime_missions"), 1);
  },
);
