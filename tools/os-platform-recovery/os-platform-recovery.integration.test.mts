/**
 * CHANTER OS — unified Platform-lane recovery proof.
 *
 * The generic lane's recovery is proven by `test:os-recovery`. This closes the
 * matching gap for the Platform AutoPoster lane, whose recovery spans three
 * durable authorities at once — the Platform command, the Phase 2D mission
 * graph, and the child AutoPoster mission — and whose downstream side effect is
 * a real product draft rather than a relay loop.
 *
 * The claim: a Platform mission interrupted at a real durable boundary recovers
 * through `/api/os/missions/:osMissionId/{reconcile,resume,stop}` without
 * creating a second draft, without changing downstream identity, and without
 * ever enabling publication.
 *
 * Boundary mapping (all names are repository-native; none are invented):
 *
 *   semantic #1  after graph approval persisted, before child execution
 *                -> graph  `after_graph_approval_persistence`
 *   semantic #2  after node running, before the child result is persisted
 *                -> graph  `after_child_mission_created`
 *   semantic #3  after the child created the draft, before node completion
 *                -> child  `after_operator_observes_runtime_result_before_persistence`
 *   semantic #4  after node completion, before graph completion is persisted
 *                -> graph  `after_node_completed_persistence`
 *
 * Semantic #3 — the mandatory case — has no graph-level boundary, because the
 * graph hands the whole child execution to the AutoPoster mission spine in one
 * call. It is reachable through that spine's own existing boundary, which fires
 * after the Runtime observed the real queue draft and after the queue id is
 * durably journaled, but before the child result, the node completion, and the
 * graph completion are persisted. That is exactly the required interruption
 * point, reached without inventing a boundary or touching production code.
 *
 * Durability discipline (see the brief's §10 distinction):
 *   - interruptions here are injected exceptions, not process kills;
 *   - after every interruption the Operator services and their database handle
 *     are torn down and **reconstructed against the same SQLite file**, so
 *     recovery is proven to read durable state rather than process memory;
 *   - genuine process-kill durability is proven separately by `os:unified`.
 *     Nothing in this file claims it.
 */
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import type { LoopGovernorMissionPort } from "chanter-agent-runtime";

const SUBMIT_TOKEN = "os-platform-recovery-submit-capability";
const CONTROL_TOKEN = "os-platform-recovery-control-capability";
const LEDGER_TOKEN = "os-platform-recovery-ledger-capability";
const RUNTIME_TOKEN = "os-platform-recovery-runtime-capability";

const OWNER_ID = "owner";
const TENANT_ID = "workspace-os-platform-recovery";
const ACTOR_ID = "os-platform-recovery-actor";
const ACCOUNT_ID = "tt-os-platform-recovery";

const originalEnvironment = {
  submitToken: process.env.OPERATOR_MISSION_SUBMIT_TOKEN,
  controlToken: process.env.OPERATOR_CONTROL_TOKEN,
  ledgerToken: process.env.OPERATOR_LEDGER_INGEST_TOKEN,
  runtimeToken: process.env.RUNTIME_CONTROL_TOKEN,
  defaultUser: process.env.APP_DEFAULT_USER_ID,
  adminPassword: process.env.ADMIN_PASSWORD,
  encryptionKey: process.env.TOKEN_ENCRYPTION_KEY,
  youtubeClientId: process.env.YOUTUBE_CLIENT_ID,
  youtubeClientSecret: process.env.YOUTUBE_CLIENT_SECRET,
  youtubeRedirect: process.env.YOUTUBE_REDIRECT_URI,
};
process.env.OPERATOR_MISSION_SUBMIT_TOKEN = SUBMIT_TOKEN;
process.env.OPERATOR_CONTROL_TOKEN = CONTROL_TOKEN;
process.env.OPERATOR_LEDGER_INGEST_TOKEN = LEDGER_TOKEN;
process.env.RUNTIME_CONTROL_TOKEN = RUNTIME_TOKEN;
process.env.APP_DEFAULT_USER_ID = OWNER_ID;
process.env.ADMIN_PASSWORD = "os-platform-recovery-local-admin-password";
process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 13).toString("base64");
process.env.YOUTUBE_CLIENT_ID = "os-platform-recovery.apps.googleusercontent.com";
process.env.YOUTUBE_CLIENT_SECRET = "os-platform-recovery-local-secret";
process.env.YOUTUBE_REDIRECT_URI = "http://localhost:10000/auth/youtube/callback";

const [
  { createApp },
  { AuditLogger },
  { AgentRunLedgerService },
  { createDatabase },
  { AutoPosterMissionEvidenceService },
  { AutoPosterObservationService },
  { AutoPosterResultProjectionService },
  { GenericMissionService },
  { MissionGraphChildDispatcher },
  { MissionGraphService },
  { createLoopGovernorMissionExecutor },
  { derivePlatformAutoPosterCommandId, PlatformAutoPosterCommandService },
  { MockRunner },
  { AutoPosterMissionService },
  { createAutoPosterRuntimeMissionExecutor },
  { OperatorService },
  { ensureWorkspace },
  { OsMissionControlService },
  { approvalAuthorityFixtureFor, cleanupApprovalAuthorityFixtures },
] = await Promise.all([
  import("../../apps/backend/src/app.js"),
  import("../../apps/backend/src/audit/auditLogger.js"),
  import("../../apps/backend/src/agentRunLedger/agentRunLedgerService.js"),
  import("../../apps/backend/src/db/database.js"),
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
  import("../../apps/backend/src/os/osMissionControlService.js"),
  import("../../apps/backend/tests/helpers/approvalAuthorityFixture.js"),
]);

type GraphBoundary =
  import("../../apps/backend/src/missions/missionGraphService.js").MissionGraphFailureBoundary;
type ChildBoundary =
  import("../../apps/backend/src/runtimeMissions/autoPosterMissionService.js").MissionFailureBoundary;

// ---------------------------------------------------------------------------
// Real AutoPoster boundary, owned by the test process
//
// It deliberately outlives every Operator reconstruction, so the durable draft
// count is observed independently of Operator's own state.
// ---------------------------------------------------------------------------

interface ConnectedAccountFixture {
  accountId: string;
  connectionId: string;
  userId: string;
  workspaceId: string;
  provider: "tiktok";
  platform: "tiktok";
  open_id: string;
  username: string;
  displayName: string;
  connected: true;
  publishingReady: true;
  access_token: string;
  refresh_token: string;
  scope: string;
}

interface StoredPost extends Record<string, unknown> {
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
  soundMode: string;
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

interface AutoPosterStorageAdapter {
  getCanonicalTikTokAccount(u: string, a: string): Promise<ConnectedAccountFixture | null>;
  getCanonicalTikTokAccounts(u: string): Promise<ConnectedAccountFixture[]>;
  getTikTokAccount(u: string, a: string): Promise<ConnectedAccountFixture | null>;
  getTikTokAccounts(u: string): Promise<ConnectedAccountFixture[]>;
  listConnectedAccountReferencesForOwner(
    u: string,
  ): Promise<Array<{ provider: string; accountId: string; workspaceId: string }>>;
  getPosts(u: string, a?: string): Promise<StoredPost[]>;
  getPost(u: string, id: string, a?: string): Promise<StoredPost | null>;
  addUploadedPosts(
    u: string,
    files: unknown[],
    defaults: Record<string, unknown>,
  ): Promise<StoredPost[]>;
}

type AutoPosterServiceMethod = (...args: never[]) => unknown;
type AutoPosterApplicationService = Record<string, AutoPosterServiceMethod>;
type AutoPosterApplicationModule = Record<string, unknown> & {
  createAutoPosterApplicationService(options: {
    storage: AutoPosterStorageAdapter;
    mediaPolicy: unknown;
    commercialService: unknown;
  }): AutoPosterApplicationService;
};

const require_ = createRequire(import.meta.url);
const autoPosterRoot = path.resolve(import.meta.dirname, "../../../chanter-auto-poster");
const applicationServiceModule = require_(
  path.join(autoPosterRoot, "src", "autoposterApplicationService.js"),
) as AutoPosterApplicationModule;
const runtimeControlRoutes = require_(
  path.join(autoPosterRoot, "src", "runtimeControlRoutes.js"),
) as import("express").RequestHandler;
const autoPosterConfig = require_(
  path.join(autoPosterRoot, "src", "config.js"),
) as { runtimeControl: { token: string }; defaultUserId: string };
const mediaPolicy: unknown = require_(path.join(autoPosterRoot, "src", "mediaPolicy.js"));
const { createCommercialFixture } = require_(
  path.join(autoPosterRoot, "test", "helpers", "commercial-fixture.js"),
) as {
  createCommercialFixture(
    adapter: AutoPosterStorageAdapter,
    options: { accounts: ConnectedAccountFixture[]; posts: StoredPost[] },
  ): unknown;
};
const express = (await import("express")).default;

function accountFixture(): ConnectedAccountFixture {
  return {
    accountId: ACCOUNT_ID,
    connectionId: `tiktok:${ACCOUNT_ID}`,
    userId: OWNER_ID,
    workspaceId: TENANT_ID,
    provider: "tiktok",
    platform: "tiktok",
    open_id: ACCOUNT_ID,
    username: "os_platform_recovery",
    displayName: "OS Platform Recovery",
    connected: true,
    publishingReady: true,
    access_token: "redacted-local-proof-access-value",
    refresh_token: "redacted-local-proof-refresh-value",
    scope: "user.info.basic,video.publish",
  };
}

interface AutoPosterBoundary {
  readonly posts: StoredPost[];
  durableCreateCalls: number;
  scheduleContractCalls: number;
  accountValidationCalls: number;
  /** Zero by construction: no provider adapter exists in this proof. */
  providerPublishCalls: number;
  readonly adapter: AutoPosterStorageAdapter;
}

function requiredText(defaults: Record<string, unknown>, key: string): string {
  const value = defaults[key];
  assert.equal(typeof value, "string", `AutoPoster defaults.${key} must be a string.`);
  return value as string;
}

function optionalText(defaults: Record<string, unknown>, key: string): string {
  const value = defaults[key];
  return typeof value === "string" ? value : "";
}

function createAutoPosterBoundary(): AutoPosterBoundary {
  const posts: StoredPost[] = [];
  const account = accountFixture();
  const matches = (u: string, a: string) => account.userId === u && account.accountId === a;
  const boundary: AutoPosterBoundary = {
    posts,
    durableCreateCalls: 0,
    scheduleContractCalls: 0,
    accountValidationCalls: 0,
    providerPublishCalls: 0,
    adapter: {
      async getCanonicalTikTokAccount(u, a) { return matches(u, a) ? account : null; },
      async getCanonicalTikTokAccounts(u) { return u === OWNER_ID ? [account] : []; },
      async getTikTokAccount(u, a) { return matches(u, a) ? account : null; },
      async getTikTokAccounts(u) { return u === OWNER_ID ? [account] : []; },
      async listConnectedAccountReferencesForOwner(u) {
        return u === OWNER_ID
          ? [{ provider: account.provider, accountId: account.accountId, workspaceId: account.workspaceId }]
          : [];
      },
      async getPosts(u, a) {
        return posts.filter((post) => post.userId === u && (!a || post.accountId === a));
      },
      async getPost(u, id, a) {
        return posts.find((post) =>
          post.userId === u && post.id === id && (!a || post.accountId === a)) ?? null;
      },
      async addUploadedPosts(u, _files, defaults) {
        boundary.durableCreateCalls += 1;
        const id = requiredText(defaults, "documentId");
        if (posts.some((post) => post.id === id)) {
          const error = new Error("already exists") as Error & { code?: number };
          error.code = 6;
          throw error;
        }
        const timestamp = new Date().toISOString();
        posts.push({
          id,
          userId: u,
          workspaceId: requiredText(defaults, "workspaceId"),
          provider: "tiktok",
          platform: "tiktok",
          connectedAccountId: `tiktok:${ACCOUNT_ID}`,
          accountId: ACCOUNT_ID,
          username: account.username,
          mediaType: "video",
          mediaUrl: requiredText(defaults, "publicMediaUrl"),
          caption: requiredText(defaults, "caption"),
          hashtags: requiredText(defaults, "hashtags"),
          scheduledAt: requiredText(defaults, "scheduledAt"),
          status: "scheduled",
          approved: false,
          approvalState: "unapproved",
          approvedAt: null,
          approvedBy: "",
          privacyLevel: "SELF_ONLY",
          soundMode: requiredText(defaults, "soundMode"),
          campaignId: optionalText(defaults, "campaignId")
            || `autoposter-campaign:${requiredText(defaults, "runtimeMissionId")}`,
          approvalId: requiredText(defaults, "approvalId"),
          evidenceBundleId: requiredText(defaults, "evidenceBundleId"),
          idempotencyKey: optionalText(defaults, "idempotencyKey"),
          runtimeIdempotencyKey: optionalText(defaults, "runtimeIdempotencyKey"),
          runtimeScheduledBy: optionalText(defaults, "runtimeScheduledBy"),
          runtimeMissionId: requiredText(defaults, "runtimeMissionId"),
          runtimeGraphId: requiredText(defaults, "runtimeGraphId"),
          runtimeAction: optionalText(defaults, "runtimeAction"),
          runtimePayloadHash: optionalText(defaults, "runtimePayloadHash"),
          createdAt: timestamp,
          updatedAt: timestamp,
        });
        return [posts[posts.length - 1]!];
      },
    },
  };
  return boundary;
}

interface RunningAutoPoster {
  baseUrl: string;
  stop(): Promise<void>;
}

async function startAutoPoster(boundary: AutoPosterBoundary): Promise<RunningAutoPoster> {
  const commercial = createCommercialFixture(boundary.adapter, {
    accounts: [accountFixture()],
    posts: boundary.posts,
  });
  const service = applicationServiceModule.createAutoPosterApplicationService({
    storage: boundary.adapter,
    mediaPolicy,
    commercialService: commercial,
  });
  const schedulePost = service.schedulePost.bind(service);
  service.schedulePost = ((...args: never[]) => {
    boundary.scheduleContractCalls += 1;
    return schedulePost(...args);
  }) as AutoPosterServiceMethod;
  const validateConnectedAccount = service.validateConnectedAccount.bind(service);
  service.validateConnectedAccount = ((...args: never[]) => {
    boundary.accountValidationCalls += 1;
    return validateConnectedAccount(...args);
  }) as AutoPosterServiceMethod;

  const methodNames = [
    "listConnectedAccounts", "validateConnectedAccount", "listQueue", "getPostStatus",
    "validateMedia", "schedulePost", "reconcileRuntimeSchedule",
  ] as const;
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
  app.use((
    error: { status?: number; code?: string; message?: string },
    _request: import("express").Request,
    response: import("express").Response,
    _next: import("express").NextFunction,
  ) => {
    response.status(error?.status || 500).json({
      ok: false,
      code: error?.code || "internal",
      reason: error?.message || "Unexpected AutoPoster boundary error.",
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
        server.close((error) => (error ? reject(error) : resolve()));
      });
      Object.assign(applicationServiceModule, originals);
      autoPosterConfig.runtimeControl.token = originalRuntimeToken;
      autoPosterConfig.defaultUserId = originalDefaultUser;
    },
  };
}

/** The Loop Governor lane is unused here and must never be reached. */
function unusedLoopPort(): LoopGovernorMissionPort {
  return {
    async createManualLoop() {
      throw new Error("The Loop Governor lane must not be reached by a Platform mission.");
    },
    async lookupManualLoop() {
      return { ok: true, outcome: "not_found", binding: null };
    },
  };
}

// ---------------------------------------------------------------------------
// Operator harness, reconstructible against one durable database
// ---------------------------------------------------------------------------

interface OperatorHarness {
  baseUrl: string;
  stop(): Promise<void>;
}

interface Injectors {
  graph?: (boundary: GraphBoundary, graphId: string, nodeId: string | null) => void;
  child?: (boundary: ChildBoundary, missionId: string) => void;
}

async function startOperator(
  root: string,
  autoPosterBaseUrl: string,
  injectors: Injectors = {},
): Promise<OperatorHarness> {
  const databasePath = path.join(root, "operator.sqlite");
  const database = createDatabase(databasePath);
  // Keyed by database path, so a reconstruction against the same durable
  // universe reuses the same checkpoints, observations, and claims.
  const approvalAuthority = approvalAuthorityFixtureFor(databasePath);
  const protectedValues = [SUBMIT_TOKEN, CONTROL_TOKEN, LEDGER_TOKEN, RUNTIME_TOKEN];

  const operatorService = new OperatorService(
    database,
    new AuditLogger(path.join(root, "audit.jsonl")),
    new MockRunner(),
    ensureWorkspace(path.join(root, "workspace")),
  );
  const ledger = new AgentRunLedgerService(database, protectedValues);
  const executor = createAutoPosterRuntimeMissionExecutor({
    baseUrl: autoPosterBaseUrl,
    serviceToken: RUNTIME_TOKEN,
    userId: OWNER_ID,
    timeoutMs: 10_000,
    timeoutValid: true,
    approvalAuthority,
  });
  const autoPosterMissions = new AutoPosterMissionService(database, executor, {
    agentRunLedgerService: ledger,
    protectedValues,
    ...(injectors.child ? { failureInjector: injectors.child } : {}),
  });
  const genericMissions = new GenericMissionService(
    database,
    createLoopGovernorMissionExecutor(
      { pythonExecutable: "", governorRoot: "", dataDir: "", timeoutValid: true, approvalAuthority },
      { port: unusedLoopPort() },
    ),
    { agentRunLedgerService: ledger, protectedValues },
  );
  const results = new AutoPosterResultProjectionService(database, executor);
  const observation = new AutoPosterObservationService(database, results);
  const graphs = new MissionGraphService(
    database,
    new MissionGraphChildDispatcher(genericMissions, autoPosterMissions),
    {
      protectedValues,
      observationScheduler: observation,
      ...(injectors.graph ? { failureInjector: injectors.graph } : {}),
    },
  );
  const evidence = new AutoPosterMissionEvidenceService(
    graphs, autoPosterMissions, results, observation, executor,
    path.join(root, "evidence"), protectedValues,
  );
  const platformCommands = new PlatformAutoPosterCommandService(
    database, graphs, autoPosterMissions, executor, evidence, { protectedValues },
  );
  const osMissions = new OsMissionControlService({
    genericMissions,
    autoPosterMissions,
    platformCommands,
    missionGraphs: graphs,
    loopGovernorExecutor: createLoopGovernorMissionExecutor(
      { pythonExecutable: "", governorRoot: "", dataDir: "", timeoutValid: true, approvalAuthority },
      { port: unusedLoopPort() },
    ),
    autoPosterExecutor: executor,
  });

  const app = createApp(
    operatorService, autoPosterMissions, ledger, genericMissions, graphs,
    results, observation, undefined, undefined, evidence, platformCommands, osMissions,
  );
  const server = await new Promise<Server>((resolve, reject) => {
    const listening: Server = app.listen(0, "127.0.0.1", () => resolve(listening));
    listening.once("error", reject);
  });
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    async stop() {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      database.close();
    },
  };
}

// ---------------------------------------------------------------------------
// HTTP + observation helpers
// ---------------------------------------------------------------------------

interface HttpResult {
  status: number;
  body: Record<string, unknown>;
}

async function call(
  baseUrl: string,
  method: "GET" | "POST",
  pathname: string,
  token: string | null,
  body?: unknown,
): Promise<HttpResult> {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

function record(value: unknown): Record<string, unknown> {
  assert.ok(
    value !== null && typeof value === "object" && !Array.isArray(value),
    "Expected an object.",
  );
  return value as Record<string, unknown>;
}

function text(value: unknown): string {
  assert.equal(typeof value, "string", `Expected a string, got ${typeof value}.`);
  return value as string;
}

/**
 * The complete observability record the brief requires, read in one call, with
 * every identity taken from a named field — never from an array position.
 */
interface OsObservation {
  osMissionId: string;
  commandId: string | null;
  graphId: string | null;
  graphHash: string | null;
  childMissionId: string | null;
  runtimeExecutionId: string | null;
  jobId: string | null;
  campaignId: string | null;
  approvalId: string | null;
  evidenceBundleId: string | null;
  status: string;
  laneState: string;
  recoveryClassification: unknown;
  lastConfirmedBoundary: unknown;
  evidenceStatus: string;
  evidenceReference: unknown;
  nextPermittedActions: string[];
  typedError: unknown;
  authorityApproved: boolean;
}

function observe(body: Record<string, unknown>): OsObservation {
  const identity = record(body.identity);
  const outcome = record(body.outcome);
  const laneReference = record(body.laneReference);
  const authority = record(body.authority);
  const downstream = outcome.downstreamIdentity === null
    ? null
    : record(outcome.downstreamIdentity);
  const jobIds = (downstream?.jobIds ?? []) as string[];
  return {
    osMissionId: text(identity.osMissionId),
    commandId: laneReference.commandId as string | null,
    graphId: laneReference.graphId as string | null,
    graphHash: laneReference.graphHash as string | null,
    childMissionId: laneReference.missionId as string | null,
    runtimeExecutionId: identity.runtimeExecutionId as string | null,
    jobId: jobIds.length > 0 ? jobIds[0]! : null,
    campaignId: (downstream?.campaignId ?? null) as string | null,
    approvalId: (downstream?.approvalId ?? null) as string | null,
    evidenceBundleId: (downstream?.evidenceBundleId ?? null) as string | null,
    status: text(body.status),
    laneState: text(body.laneState),
    recoveryClassification: outcome.recoveryClassification,
    lastConfirmedBoundary: outcome.lastConfirmedBoundary,
    evidenceStatus: text(outcome.evidenceStatus),
    evidenceReference: outcome.evidenceReference,
    nextPermittedActions: outcome.nextPermittedActions as string[],
    typedError: outcome.typedError,
    authorityApproved: authority.approved === true,
  };
}

async function readOs(baseUrl: string, osMissionId: string): Promise<OsObservation> {
  const read = await call(baseUrl, "GET", `/api/os/missions/${osMissionId}`, null);
  assert.equal(read.status, 200, JSON.stringify(read.body));
  return observe(read.body);
}

/** Graph and node truth read from the canonical graph route, not inferred. */
async function readGraph(
  baseUrl: string,
  graphId: string,
): Promise<{ status: string; nodeStatus: string; childMissionId: string }> {
  const read = await call(baseUrl, "GET", `/api/mission-graphs/${graphId}`, null);
  assert.equal(read.status, 200, JSON.stringify(read.body));
  const nodes = read.body.nodes as Array<Record<string, unknown>>;
  const node = nodes.find((entry) => entry.nodeId === "autoposter_schedule");
  assert.ok(node, "the canonical AutoPoster node must exist");
  return {
    status: text(read.body.status),
    nodeStatus: text(node.status),
    childMissionId: text(node.childMissionId),
  };
}

interface SideEffects {
  scheduleContractCalls: number;
  durableCreateCalls: number;
  drafts: number;
  providerPublishCalls: number;
}

function sideEffects(boundary: AutoPosterBoundary): SideEffects {
  return {
    scheduleContractCalls: boundary.scheduleContractCalls,
    durableCreateCalls: boundary.durableCreateCalls,
    drafts: boundary.posts.length,
    providerPublishCalls: boundary.providerPublishCalls,
  };
}

// ---------------------------------------------------------------------------
// Canonical command
// ---------------------------------------------------------------------------

const INTAKE_KEY = "os-platform-recovery-intake-0001";
const COMMAND_ID = `platform-autoposter-${
  createHash("sha256")
    .update(`${TENANT_ID}\n${ACTOR_ID}\n${INTAKE_KEY}`, "utf8")
    .digest("hex").slice(0, 40)
}`;
const OS_MISSION_ID = `os:platform_autoposter_command:${COMMAND_ID}`;

const REQUESTED_AT = new Date().toISOString();
const SCHEDULED_AT = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

function commandBody(): Record<string, unknown> {
  return {
    schemaVersion: "chanter.platform.autoposter.create-work.v1",
    commandId: COMMAND_ID,
    tenantId: TENANT_ID,
    actorId: ACTOR_ID,
    intakeKey: INTAKE_KEY,
    media: {
      kind: "public_url",
      url: "https://cdn.example.com/os-platform-recovery.mp4",
      mediaType: "video",
    },
    destinations: [{ provider: "tiktok", accountId: ACCOUNT_ID, soundMode: "tiktok_recommended" }],
    copy: {
      caption: "CHANTER OS unified Platform-lane recovery proof",
      hashtags: "#chanter #os",
      youtube: { title: "", description: "" },
    },
    schedule: {
      mode: "explicit",
      scheduledAt: SCHEDULED_AT,
      timezoneName: "UTC",
      timezoneOffsetMinutes: 0,
    },
    approvalPolicy: {
      draftExecution: "operator_control_required",
      publication: "human_required",
    },
    requestedAt: REQUESTED_AT,
  };
}

const temporaryRoots: string[] = [];

function disposableRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "chanter-os-platform-recovery-"));
  temporaryRoots.push(root);
  return root;
}

after(() => {
  const restore = (name: string, value: string | undefined) => {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };
  restore("OPERATOR_MISSION_SUBMIT_TOKEN", originalEnvironment.submitToken);
  restore("OPERATOR_CONTROL_TOKEN", originalEnvironment.controlToken);
  restore("OPERATOR_LEDGER_INGEST_TOKEN", originalEnvironment.ledgerToken);
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

/**
 * Submits the canonical command and attempts execution under the supplied
 * interruption, then tears the Operator down and reconstructs it against the
 * same database with no injectors armed.
 *
 * Returns the graph hash and the reconstructed harness, so every later
 * assertion reads durable state through a service graph that never saw the
 * interrupted execution.
 */
async function interruptThenReconstruct(
  root: string,
  autoPosterBaseUrl: string,
  injectors: Injectors,
): Promise<{ operator: OperatorHarness; graphHash: string; executeStatus: number }> {
  const first = await startOperator(root, autoPosterBaseUrl, injectors);
  const submitted = await call(
    first.baseUrl, "POST", "/api/os/missions", SUBMIT_TOKEN, commandBody());
  assert.equal(submitted.status, 201, JSON.stringify(submitted.body));
  const graphHash = text(record(submitted.body.laneReference).graphHash);

  const executed = await call(
    first.baseUrl, "POST", `/api/os/missions/${OS_MISSION_ID}/approve`, CONTROL_TOKEN, { graphHash });
  const executeStatus = executed.status;
  assert.notEqual(executeStatus, 200, "the injected interruption must prevent clean completion");

  // Durability discipline: nothing from the interrupted run may survive in
  // memory. The database file is the only thing carried forward.
  await first.stop();
  const operator = await startOperator(root, autoPosterBaseUrl);
  return { operator, graphHash, executeStatus };
}

// ---------------------------------------------------------------------------
// P1 — interrupted after graph approval, before any child dispatch
// ---------------------------------------------------------------------------

test(
  "P1 recovers a Platform mission interrupted before child dispatch into exactly one draft",
  { timeout: 120_000 },
  async (context) => {
    const boundary = createAutoPosterBoundary();
    const autoPoster = await startAutoPoster(boundary);
    const root = disposableRoot();
    context.after(async () => { await autoPoster.stop().catch(() => undefined); });

    const { operator, graphHash } = await interruptThenReconstruct(root, autoPoster.baseUrl, {
      graph: (graphBoundary) => {
        if (graphBoundary === "after_graph_approval_persistence") {
          throw new Error("injected interruption after graph approval, before child dispatch");
        }
      },
    });
    context.after(async () => { await operator.stop().catch(() => undefined); });

    // Nothing was dispatched, so no draft can exist.
    assert.deepEqual(sideEffects(boundary), {
      scheduleContractCalls: 0,
      durableCreateCalls: 0,
      drafts: 0,
      providerPublishCalls: 0,
    });

    const interrupted = await readOs(operator.baseUrl, OS_MISSION_ID);
    assert.equal(
      interrupted.status,
      "failed_recoverable",
      "an attempted execution that did not complete must not project as a pre-attempt state",
    );
    assert.equal(interrupted.evidenceStatus, "reconciliation_required");
    assert.equal(interrupted.jobId, null, "no downstream identity may exist yet");
    assert.ok(
      interrupted.nextPermittedActions.includes("resume"),
      "the operator must be told how to continue",
    );

    // The graph itself is still merely approved: approval persisted, no node ran.
    const graph = await readGraph(operator.baseUrl, text(interrupted.graphId));
    assert.equal(graph.status, "approved");

    const resumed = await call(
      operator.baseUrl, "POST", `/api/os/missions/${OS_MISSION_ID}/resume`, CONTROL_TOKEN, { graphHash });
    assert.equal(resumed.status, 200, JSON.stringify(resumed.body));
    const completed = observe(resumed.body);
    assert.equal(completed.status, "completed");
    assert.ok(completed.jobId, "recovery produced the downstream draft");

    assert.deepEqual(sideEffects(boundary), {
      scheduleContractCalls: 1,
      durableCreateCalls: 1,
      drafts: 1,
      providerPublishCalls: 0,
    });
    const draft = boundary.posts[0]!;
    assert.equal(draft.id, completed.jobId);
    assert.equal(draft.approved, false);
    assert.equal(draft.approvalState, "unapproved");
  },
);

// ---------------------------------------------------------------------------
// P2 — CORE: draft created, graph completion never persisted
// ---------------------------------------------------------------------------

test(
  "P2 recovers a Platform mission interrupted after the draft was created onto the same jobId",
  { timeout: 120_000 },
  async (context) => {
    const boundary = createAutoPosterBoundary();
    const autoPoster = await startAutoPoster(boundary);
    const root = disposableRoot();
    context.after(async () => { await autoPoster.stop().catch(() => undefined); });

    // Semantic boundary #3: the Runtime has observed the real queue draft and
    // the queue id is durably journaled, but the child result, the node
    // completion, and the graph completion are all unpersisted.
    const { operator, graphHash } = await interruptThenReconstruct(root, autoPoster.baseUrl, {
      child: (childBoundary) => {
        if (childBoundary === "after_operator_observes_runtime_result_before_persistence") {
          throw new Error("injected interruption after the draft was created");
        }
      },
    });
    context.after(async () => { await operator.stop().catch(() => undefined); });

    // --- Immediately after interruption -----------------------------------
    const beforeRecovery = sideEffects(boundary);
    assert.deepEqual(beforeRecovery, {
      scheduleContractCalls: 1,
      durableCreateCalls: 1,
      drafts: 1,
      providerPublishCalls: 0,
    }, "exactly one draft exists and nothing was published");

    const interrupted = await readOs(operator.baseUrl, OS_MISSION_ID);
    assert.ok(interrupted.childMissionId, "the child mission exists");
    assert.equal(
      interrupted.status,
      "failed_recoverable",
      "the interrupted mission is truthful and recoverable, and never falsely completed",
    );
    assert.equal(
      interrupted.evidenceStatus,
      "reconciliation_required",
      "evidence cannot be authoritative before the result is persisted",
    );
    assert.ok(
      interrupted.nextPermittedActions.includes("resume"),
      "the operator is told how to continue",
    );

    const graphBefore = await readGraph(operator.baseUrl, text(interrupted.graphId));
    assert.notEqual(graphBefore.status, "completed", "graph completion was never persisted");

    const identityBefore = {
      commandId: interrupted.commandId,
      graphId: interrupted.graphId,
      graphHash: interrupted.graphHash,
      childMissionId: interrupted.childMissionId,
    };
    const draftId = boundary.posts[0]!.id;

    // --- Reconcile: must observe, never act -------------------------------
    const reconciled = await call(
      operator.baseUrl, "POST", `/api/os/missions/${OS_MISSION_ID}/reconcile`, CONTROL_TOKEN, {});
    assert.deepEqual(
      sideEffects(boundary),
      beforeRecovery,
      "reconciliation must create no draft and make no provider call",
    );
    const afterReconcile = await readOs(operator.baseUrl, OS_MISSION_ID);
    assert.equal(afterReconcile.commandId, identityBefore.commandId);
    assert.equal(afterReconcile.graphId, identityBefore.graphId);
    assert.equal(afterReconcile.childMissionId, identityBefore.childMissionId);
    assert.ok(
      afterReconcile.nextPermittedActions.length > 0,
      "reconciliation must classify a permitted next action",
    );
    // Whether reconciliation is performed or refused is the child authority's
    // decision, not the OS layer's; both are recorded, and either way it must
    // have produced no side effect.
    assert.ok(
      reconciled.status === 200 || reconciled.status === 409,
      `reconcile returned an unexpected status ${reconciled.status}`,
    );

    // --- Resume: must converge, never duplicate ---------------------------
    const resumed = await call(
      operator.baseUrl, "POST", `/api/os/missions/${OS_MISSION_ID}/resume`, CONTROL_TOKEN, { graphHash });
    assert.equal(resumed.status, 200, JSON.stringify(resumed.body));
    const completed = observe(resumed.body);

    assert.equal(completed.status, "completed");
    assert.equal(completed.evidenceStatus, "authoritative");
    assert.equal(completed.jobId, draftId, "resume converged on the same jobId");
    assert.equal(completed.commandId, identityBefore.commandId);
    assert.equal(completed.graphId, identityBefore.graphId);
    assert.equal(completed.graphHash, identityBefore.graphHash);
    assert.equal(completed.childMissionId, identityBefore.childMissionId);
    assert.ok(completed.runtimeExecutionId, "a runtime execution identity is exposed");

    assert.deepEqual(
      sideEffects(boundary),
      beforeRecovery,
      "the whole recovery created no second draft and published nothing",
    );

    const graphAfter = await readGraph(operator.baseUrl, text(completed.graphId));
    assert.equal(graphAfter.status, "completed");
    assert.equal(graphAfter.nodeStatus, "completed");
    assert.equal(graphAfter.childMissionId, identityBefore.childMissionId);

    // Publication was never enabled by recovery.
    const draft = boundary.posts[0]!;
    assert.equal(draft.approved, false);
    assert.equal(draft.approvalState, "unapproved");
    assert.equal(draft.status, "scheduled");

    // A repeated read changes nothing.
    const reread = await readOs(operator.baseUrl, OS_MISSION_ID);
    assert.equal(reread.status, "completed");
    assert.equal(reread.jobId, draftId);
    assert.deepEqual(sideEffects(boundary), beforeRecovery);

    // The full observability record the recovery contract requires, printed so
    // every run's evidence is quotable rather than reconstructed by hand.
    console.log(`P2 observed evidence:\n${JSON.stringify({
      interrupted: {
        status: interrupted.status,
        laneState: interrupted.laneState,
        evidenceStatus: interrupted.evidenceStatus,
        graphStatus: graphBefore.status,
        nodeStatus: graphBefore.nodeStatus,
        nextPermittedActions: interrupted.nextPermittedActions,
        recoveryClassification: interrupted.recoveryClassification,
        lastConfirmedBoundary: interrupted.lastConfirmedBoundary,
      },
      recovered: {
        status: completed.status,
        laneState: completed.laneState,
        evidenceStatus: completed.evidenceStatus,
        evidenceReference: completed.evidenceReference,
        graphStatus: graphAfter.status,
        nodeStatus: graphAfter.nodeStatus,
        nextPermittedActions: completed.nextPermittedActions,
      },
      identity: {
        osMissionId: completed.osMissionId,
        commandId: completed.commandId,
        graphId: completed.graphId,
        graphHash: completed.graphHash,
        childMissionId: completed.childMissionId,
        runtimeExecutionId: completed.runtimeExecutionId,
        jobId: completed.jobId,
        campaignId: completed.campaignId,
        approvalId: completed.approvalId,
        evidenceBundleId: completed.evidenceBundleId,
      },
      sideEffects: { before: beforeRecovery, after: sideEffects(boundary) },
      reconcileStatus: reconciled.status,
      draftApprovalState: draft.approvalState,
    }, null, 2)}`);
  },
);

// ---------------------------------------------------------------------------
// P3 — node completed, graph completion interrupted
// ---------------------------------------------------------------------------

test(
  "P3 finalizes graph state after a post-node-completion interruption without redispatch",
  { timeout: 120_000 },
  async (context) => {
    const boundary = createAutoPosterBoundary();
    const autoPoster = await startAutoPoster(boundary);
    const root = disposableRoot();
    context.after(async () => { await autoPoster.stop().catch(() => undefined); });

    const { operator, graphHash } = await interruptThenReconstruct(root, autoPoster.baseUrl, {
      graph: (graphBoundary) => {
        if (graphBoundary === "after_node_completed_persistence") {
          throw new Error("injected interruption after node completion, before graph completion");
        }
      },
    });
    context.after(async () => { await operator.stop().catch(() => undefined); });

    const beforeRecovery = sideEffects(boundary);
    assert.deepEqual(beforeRecovery, {
      scheduleContractCalls: 1,
      durableCreateCalls: 1,
      drafts: 1,
      providerPublishCalls: 0,
    }, "the child result and draft are already authoritative");

    const interrupted = await readOs(operator.baseUrl, OS_MISSION_ID);
    const draftId = boundary.posts[0]!.id;
    const childBefore = interrupted.childMissionId;

    // The child finished, but the command's own linkage and evidence never
    // did, so the mission as a whole is not complete and must not say it is.
    assert.equal(
      interrupted.status,
      "failed_recoverable",
      "a finished child must not make an unfinished command project as completed",
    );
    const graphBefore = await readGraph(operator.baseUrl, text(interrupted.graphId));
    assert.equal(graphBefore.nodeStatus, "completed", "node completion was persisted");
    assert.notEqual(graphBefore.status, "completed", "graph completion was not");

    const resumed = await call(
      operator.baseUrl, "POST", `/api/os/missions/${OS_MISSION_ID}/resume`, CONTROL_TOKEN, { graphHash });
    assert.equal(resumed.status, 200, JSON.stringify(resumed.body));
    const completed = observe(resumed.body);

    assert.equal(completed.status, "completed");
    assert.equal(completed.jobId, draftId, "the same downstream identity is preserved");
    assert.equal(completed.childMissionId, childBefore, "the child mission was never re-minted");
    assert.deepEqual(
      sideEffects(boundary),
      beforeRecovery,
      "finalizing graph state must not redispatch child execution",
    );

    const graph = await readGraph(operator.baseUrl, text(completed.graphId));
    assert.equal(graph.status, "completed");
    assert.equal(graph.nodeStatus, "completed");
  },
);

// ---------------------------------------------------------------------------
// P4 — stop from a recoverable Platform state
// ---------------------------------------------------------------------------

test(
  "P4 stops a recoverable Platform mission and refuses to resume it afterwards",
  { timeout: 120_000 },
  async (context) => {
    const boundary = createAutoPosterBoundary();
    const autoPoster = await startAutoPoster(boundary);
    const root = disposableRoot();
    context.after(async () => { await autoPoster.stop().catch(() => undefined); });

    const { operator, graphHash } = await interruptThenReconstruct(root, autoPoster.baseUrl, {
      graph: (graphBoundary) => {
        if (graphBoundary === "after_graph_approval_persistence") {
          throw new Error("injected interruption after graph approval, before child dispatch");
        }
      },
    });
    context.after(async () => { await operator.stop().catch(() => undefined); });

    const beforeStop = sideEffects(boundary);
    assert.equal(beforeStop.drafts, 0);

    const stopped = await call(
      operator.baseUrl, "POST", `/api/os/missions/${OS_MISSION_ID}/stop`, CONTROL_TOKEN,
      { cancelledBy: "founder", reason: "Escalated during the recovery proof." });
    assert.equal(stopped.status, 200, JSON.stringify(stopped.body));
    const observation = observe(stopped.body);
    assert.equal(observation.status, "stopped");
    assert.deepEqual(observation.nextPermittedActions, []);
    assert.deepEqual(sideEffects(boundary), beforeStop, "stopping changes no downstream count");

    // The stop is durable, and resume is refused by the owning lane authority.
    const reread = await readOs(operator.baseUrl, OS_MISSION_ID);
    assert.equal(reread.status, "stopped");

    const resumeAfterStop = await call(
      operator.baseUrl, "POST", `/api/os/missions/${OS_MISSION_ID}/resume`, CONTROL_TOKEN, { graphHash });
    assert.equal(resumeAfterStop.status, 409, JSON.stringify(resumeAfterStop.body));
    assert.ok(
      text(resumeAfterStop.body.code).length > 0,
      "the refusal carries a typed, lane-owned error code",
    );
    assert.deepEqual(sideEffects(boundary), beforeStop, "a refused resume changes nothing");
    assert.equal((await readOs(operator.baseUrl, OS_MISSION_ID)).status, "stopped");
  },
);

// ---------------------------------------------------------------------------
// P5 — redundant and invalid recovery actions are typed refusals
// ---------------------------------------------------------------------------

test(
  "P5 refuses redundant and invalid recovery actions without any downstream effect",
  { timeout: 120_000 },
  async (context) => {
    const boundary = createAutoPosterBoundary();
    const autoPoster = await startAutoPoster(boundary);
    const root = disposableRoot();
    context.after(async () => { await autoPoster.stop().catch(() => undefined); });

    // A clean completed mission is the strongest base for "already terminal".
    const operator = await startOperator(root, autoPoster.baseUrl);
    context.after(async () => { await operator.stop().catch(() => undefined); });

    const submitted = await call(
      operator.baseUrl, "POST", "/api/os/missions", SUBMIT_TOKEN, commandBody());
    assert.equal(submitted.status, 201, JSON.stringify(submitted.body));
    const graphHash = text(record(submitted.body.laneReference).graphHash);

    const executed = await call(
      operator.baseUrl, "POST", `/api/os/missions/${OS_MISSION_ID}/approve`, CONTROL_TOKEN, { graphHash });
    assert.equal(executed.status, 200, JSON.stringify(executed.body));
    const completed = observe(executed.body);
    assert.equal(completed.status, "completed");
    const settled = sideEffects(boundary);
    assert.deepEqual(settled, {
      scheduleContractCalls: 1,
      durableCreateCalls: 1,
      drafts: 1,
      providerPublishCalls: 0,
    });

    // Reconcile when an authoritative child result is already held.
    const redundantReconcile = await call(
      operator.baseUrl, "POST", `/api/os/missions/${OS_MISSION_ID}/reconcile`, CONTROL_TOKEN, {});
    assert.equal(redundantReconcile.status, 409, JSON.stringify(redundantReconcile.body));
    assert.equal(redundantReconcile.body.code, "RECOVERY_ACTION_NOT_PERMITTED");
    assert.deepEqual(sideEffects(boundary), settled);

    // Stop after terminal completion.
    const stopAfterCompletion = await call(
      operator.baseUrl, "POST", `/api/os/missions/${OS_MISSION_ID}/stop`, CONTROL_TOKEN,
      { cancelledBy: "founder" });
    assert.equal(stopAfterCompletion.status, 409, JSON.stringify(stopAfterCompletion.body));
    assert.equal(stopAfterCompletion.body.code, "OPERATOR_GRAPH_STATE_TERMINAL");
    assert.deepEqual(sideEffects(boundary), settled);

    // Resume after terminal completion is an idempotent replay, never a second
    // draft: the lane authority owns that decision and returns durable truth.
    const resumeAfterCompletion = await call(
      operator.baseUrl, "POST", `/api/os/missions/${OS_MISSION_ID}/resume`, CONTROL_TOKEN, { graphHash });
    assert.equal(resumeAfterCompletion.status, 200, JSON.stringify(resumeAfterCompletion.body));
    const replayed = observe(resumeAfterCompletion.body);
    assert.equal(replayed.status, "completed");
    assert.equal(replayed.jobId, completed.jobId, "replay returns the same jobId");
    assert.deepEqual(sideEffects(boundary), settled, "replay creates nothing and publishes nothing");

    // A resume carrying the wrong graph hash is refused before anything runs.
    const wrongHash = await call(
      operator.baseUrl, "POST", `/api/os/missions/${OS_MISSION_ID}/resume`, CONTROL_TOKEN,
      { graphHash: "0".repeat(64) });
    assert.equal(wrongHash.status, 409, JSON.stringify(wrongHash.body));
    assert.equal(wrongHash.body.code, "OPERATOR_GRAPH_APPROVAL_HASH_MISMATCH");
    assert.deepEqual(sideEffects(boundary), settled);

    // An unknown identity never falls through to another lane.
    const unknown = await call(
      operator.baseUrl, "GET", "/api/os/missions/os:platform_autoposter_command:not-a-command", null);
    assert.equal(unknown.status, 404);
  },
);
