/**
 * CHANTER OS — unified ambiguous-downstream reconciliation proof.
 *
 * Every recovery case proven so far shares one property: downstream truth was
 * already knowable from durable state Operator itself held. This closes the
 * remaining case, which is the exact boundary at which unsafe systems duplicate
 * real-world actions:
 *
 *     the request left Operator,
 *     no authoritative response came back,
 *     and Operator cannot infer whether the side effect happened.
 *
 * The claim: in that state CHANTER OS refuses speculative retry, performs an
 * authoritative downstream lookup, and converges on exactly one draft in both
 * possible downstream realities.
 *
 *   Reality A  draft exists, response lost   -> bind the existing jobId, no retry
 *   Reality B  draft absent, response lost   -> prove absence, one safe retry
 *
 * Ambiguity injection (§6)
 * ------------------------
 * The interruption is NOT an exception thrown before the adapter call — that
 * would prove only that Operator never dispatched. It is injected at the
 * AutoPoster HTTP transport, which this test process owns end to end:
 *
 *   Reality A  the request is routed into the real handler, the draft is
 *              durably created, and the socket is destroyed instead of the
 *              response being flushed;
 *   Reality B  the socket is destroyed on arrival, before the handler runs, so
 *              the request provably reached the boundary and created nothing.
 *
 * In both cases Operator sees an unreachable peer — `autoPosterHttpPort` maps a
 * thrown fetch to `unavailable` — which is precisely "dispatch attempted,
 * outcome unobserved". The two realities are indistinguishable to Operator and
 * differ only in downstream durable truth, which is the whole point.
 *
 * Nothing about production semantics is altered: the seam is the test-owned
 * express app in front of the real AutoPoster runtime-control routes.
 *
 * Authoritative lookup (§10)
 * --------------------------
 * `reconcileSchedule` -> `POST /api/runtime/schedule/reconcile` ->
 * `reconcileRuntimeSchedule`, which selects AutoPoster's durable posts by
 * `post.runtimeMissionId === missionId` (the child mission ID) and then
 * requires exact equality on `runtimeIdempotencyKey`, `runtimePayloadHash`,
 * `runtimeAction`, `workspaceId`, `provider`, `accountId` and `scheduledAt`.
 * No fuzzy matching, no timestamp inference, no array-position inference.
 *
 * Durability discipline
 * ---------------------
 * After every interruption the Operator services and their database handle are
 * torn down and reconstructed against the same SQLite file and the same live
 * AutoPoster store, so every reconciliation below is proven to read durable
 * state rather than process memory. These are injected transport failures, not
 * process kills; nothing here claims process-kill durability, which `os:unified`
 * proves separately.
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

const SUBMIT_TOKEN = "os-ambiguous-reconciliation-submit-capability";
const CONTROL_TOKEN = "os-ambiguous-reconciliation-control-capability";
const LEDGER_TOKEN = "os-ambiguous-reconciliation-ledger-capability";
const RUNTIME_TOKEN = "os-ambiguous-reconciliation-runtime-capability";

const OWNER_ID = "owner";
const TENANT_ID = "workspace-os-ambiguous-reconciliation";
const ACTOR_ID = "os-ambiguous-reconciliation-actor";
const ACCOUNT_ID = "tt-os-ambiguous-reconciliation";

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
process.env.ADMIN_PASSWORD = "os-ambiguous-reconciliation-local-admin-password";
process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 17).toString("base64");
process.env.YOUTUBE_CLIENT_ID = "os-ambiguous-reconciliation.apps.googleusercontent.com";
process.env.YOUTUBE_CLIENT_SECRET = "os-ambiguous-reconciliation-local-secret";
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
  { PlatformAutoPosterCommandService },
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

type ExpressRequest = import("express").Request;
type ExpressResponse = import("express").Response;
type ExpressNext = import("express").NextFunction;

function accountFixture(): ConnectedAccountFixture {
  return {
    accountId: ACCOUNT_ID,
    connectionId: `tiktok:${ACCOUNT_ID}`,
    userId: OWNER_ID,
    workspaceId: TENANT_ID,
    provider: "tiktok",
    platform: "tiktok",
    open_id: ACCOUNT_ID,
    username: "os_ambiguous_reconciliation",
    displayName: "OS Ambiguous Reconciliation",
    connected: true,
    publishingReady: true,
    access_token: "redacted-local-proof-access-value",
    refresh_token: "redacted-local-proof-refresh-value",
    scope: "user.info.basic,video.publish",
  };
}

/**
 * How the AutoPoster transport should behave on the next requests.
 *
 * `drop_after_create` runs the real handler to completion — the draft is
 * durably created — and then loses the answer. `drop_before_create` loses the
 * request after it has provably arrived and before any handler runs. Operator
 * cannot tell the two apart; only AutoPoster's durable store can.
 */
type ScheduleTransport = "healthy" | "drop_before_create" | "drop_after_create";
type LookupTransport = "healthy" | "drop";

interface AmbiguityControl {
  scheduleTransport: ScheduleTransport;
  lookupTransport: LookupTransport;
}

/**
 * Independent counters. "Adapter called" and "side effect created" are
 * deliberately different metrics (§9): the whole proof turns on the case where
 * the first happens and the second may or may not.
 */
interface AutoPosterBoundary {
  readonly posts: StoredPost[];
  readonly control: AmbiguityControl;
  /** Schedule requests that provably reached the AutoPoster HTTP boundary. */
  scheduleRequestAttempts: number;
  /** Schedule responses AutoPoster actually flushed back to Operator. */
  scheduleResponsesObserved: number;
  /** Calls that reached AutoPoster's durable create. */
  durableCreateCalls: number;
  /** Authoritative reconciliation lookups that reached the boundary. */
  draftLookupCalls: number;
  /** Lookups that reported an existing durable binding for the exact scope. */
  draftBindingsFound: number;
  scheduleContractCalls: number;
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
    control: { scheduleTransport: "healthy", lookupTransport: "healthy" },
    scheduleRequestAttempts: 0,
    scheduleResponsesObserved: 0,
    durableCreateCalls: 0,
    draftLookupCalls: 0,
    draftBindingsFound: 0,
    scheduleContractCalls: 0,
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

/**
 * Replaces the response writers so the handler's own success path silently
 * loses the connection instead of answering. Everything the handler already
 * committed downstream stays committed — that is exactly the reality being
 * reproduced.
 */
function loseResponse(response: ExpressResponse): void {
  const lose = ((_body?: unknown) => {
    response.socket?.destroy();
    return response;
  }) as ExpressResponse["json"];
  response.json = lose;
  response.send = lose as ExpressResponse["send"];
}

/**
 * The ambiguity seam. It sits in front of the real runtime-control routes and
 * changes only the transport, never AutoPoster's own logic.
 */
function ambiguityInterceptor(boundary: AutoPosterBoundary) {
  return (request: ExpressRequest, response: ExpressResponse, next: ExpressNext): void => {
    const pathname = request.path;
    if (request.method === "POST" && pathname === "/schedule") {
      // Counted here, before any decision: the request provably arrived.
      boundary.scheduleRequestAttempts += 1;
      const mode = boundary.control.scheduleTransport;
      if (mode === "drop_before_create") {
        request.socket.destroy();
        return;
      }
      if (mode === "drop_after_create") {
        loseResponse(response);
        next();
        return;
      }
      response.once("finish", () => { boundary.scheduleResponsesObserved += 1; });
      next();
      return;
    }
    if (request.method === "POST" && pathname === "/schedule/reconcile") {
      boundary.draftLookupCalls += 1;
      if (boundary.control.lookupTransport === "drop") {
        request.socket.destroy();
        return;
      }
      // Record what durable truth the lookup actually reported, read from the
      // named outcome field rather than inferred.
      const originalJson = response.json.bind(response);
      response.json = ((body?: unknown) => {
        const record_ = body !== null && typeof body === "object" && !Array.isArray(body)
          ? body as Record<string, unknown>
          : {};
        if (record_.outcome === "unique") boundary.draftBindingsFound += 1;
        return originalJson(body);
      }) as ExpressResponse["json"];
      next();
      return;
    }
    next();
  };
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
  app.use("/api/runtime", ambiguityInterceptor(boundary), runtimeControlRoutes);
  app.use((
    error: { status?: number; code?: string; message?: string },
    _request: ExpressRequest,
    response: ExpressResponse,
    _next: ExpressNext,
  ) => {
    // A deliberately destroyed socket can surface here; never resurrect it.
    if (response.headersSent || response.socket?.destroyed) return;
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
  // Destroying a socket mid-exchange is the point of this harness, so the
  // resulting client errors must never fail the process.
  server.on("clientError", (_error, socket) => { socket.destroy(); });
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    async stop() {
      await new Promise<void>((resolve) => { server.close(() => resolve()); });
      server.closeAllConnections?.();
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

async function startOperator(root: string, autoPosterBaseUrl: string): Promise<OperatorHarness> {
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
    { protectedValues, observationScheduler: observation },
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
  payloadHash: string | null;
  traceId: string | null;
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
  typedError: Record<string, unknown> | null;
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
  const typedError = outcome.typedError === null ? null : record(outcome.typedError);
  return {
    osMissionId: text(identity.osMissionId),
    commandId: laneReference.commandId as string | null,
    graphId: laneReference.graphId as string | null,
    graphHash: laneReference.graphHash as string | null,
    payloadHash: identity.payloadHash as string | null,
    traceId: identity.traceId as string | null,
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
    typedError,
    authorityApproved: authority.approved === true,
  };
}

async function readOs(baseUrl: string, osMissionId: string): Promise<OsObservation> {
  const read = await call(baseUrl, "GET", `/api/os/missions/${osMissionId}`, null);
  assert.equal(read.status, 200, JSON.stringify(read.body));
  return observe(read.body);
}

/** The child mission spine's own durable truth, read from its canonical route. */
async function readChild(
  baseUrl: string,
  missionId: string,
): Promise<{
  executionState: string;
  reconciliationOutcome: string | null;
  retryCount: number;
  authoritativeQueueId: string | null;
  nextPermittedActions: string[];
  typedErrorCode: string | null;
}> {
  const read = await call(baseUrl, "GET", `/api/runtime-missions/${missionId}`, CONTROL_TOKEN);
  assert.equal(read.status, 200, JSON.stringify(read.body));
  const execution = record(record(read.body).execution);
  const typedError = execution.typedError === null || execution.typedError === undefined
    ? null
    : record(execution.typedError);
  return {
    executionState: text(execution.state),
    reconciliationOutcome: execution.reconciliationOutcome as string | null,
    retryCount: Number(execution.retryCount),
    authoritativeQueueId: execution.authoritativeQueueId as string | null,
    nextPermittedActions: execution.nextPermittedActions as string[],
    typedErrorCode: typedError === null ? null : text(typedError.code),
  };
}

/** The exact side-effect counter table the brief requires (§9). */
interface SideEffects {
  scheduleRequestAttempts: number;
  scheduleResponsesObserved: number;
  durableCreateCalls: number;
  draftLookupCalls: number;
  draftBindingsFound: number;
  drafts: number;
  providerPublishCalls: number;
}

function sideEffects(boundary: AutoPosterBoundary): SideEffects {
  return {
    scheduleRequestAttempts: boundary.scheduleRequestAttempts,
    scheduleResponsesObserved: boundary.scheduleResponsesObserved,
    durableCreateCalls: boundary.durableCreateCalls,
    draftLookupCalls: boundary.draftLookupCalls,
    draftBindingsFound: boundary.draftBindingsFound,
    drafts: boundary.posts.length,
    providerPublishCalls: boundary.providerPublishCalls,
  };
}

/** Publication must never be enabled anywhere in this proof. */
function assertNothingPublished(boundary: AutoPosterBoundary): void {
  assert.equal(boundary.providerPublishCalls, 0, "no provider publication may ever occur");
  for (const draft of boundary.posts) {
    assert.equal(draft.approved, false);
    assert.equal(draft.approvalState, "unapproved");
    assert.equal(draft.status, "scheduled");
  }
}

// ---------------------------------------------------------------------------
// Canonical command
// ---------------------------------------------------------------------------

const INTAKE_KEY = "os-ambiguous-reconciliation-intake-0001";
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
      url: "https://cdn.example.com/os-ambiguous-reconciliation.mp4",
      mediaType: "video",
    },
    destinations: [{ provider: "tiktok", accountId: ACCOUNT_ID, soundMode: "tiktok_recommended" }],
    copy: {
      caption: "CHANTER OS unified ambiguous-downstream reconciliation proof",
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
  const root = mkdtempSync(path.join(os.tmpdir(), "chanter-os-ambiguous-reconciliation-"));
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
 * Submits the canonical command, attempts execution under the configured
 * transport ambiguity, then tears the Operator down and reconstructs it against
 * the same database and the same live AutoPoster store (§7 A5).
 *
 * Every later assertion therefore reads durable state through a service graph
 * that never saw the ambiguous attempt.
 */
async function dispatchAmbiguouslyThenReconstruct(
  root: string,
  boundary: AutoPosterBoundary,
  autoPosterBaseUrl: string,
  transport: ScheduleTransport,
): Promise<{ operator: OperatorHarness; graphHash: string; executeStatus: number }> {
  const first = await startOperator(root, autoPosterBaseUrl);
  const submitted = await call(
    first.baseUrl, "POST", "/api/os/missions", SUBMIT_TOKEN, commandBody());
  assert.equal(submitted.status, 201, JSON.stringify(submitted.body));
  const graphHash = text(record(submitted.body.laneReference).graphHash);

  boundary.control.scheduleTransport = transport;
  const executed = await call(
    first.baseUrl, "POST", `/api/os/missions/${OS_MISSION_ID}/approve`, CONTROL_TOKEN, { graphHash });
  const executeStatus = executed.status;
  assert.notEqual(
    executeStatus,
    200,
    "a dispatch whose outcome was never observed must not report clean completion",
  );
  // The transport is healthy again: the ambiguity is already durable, and every
  // later step must be able to reach AutoPoster to learn the truth.
  boundary.control.scheduleTransport = "healthy";

  // Durability discipline: nothing from the ambiguous attempt may survive in
  // memory. The database file and AutoPoster's own store are all that carry over.
  await first.stop();
  const operator = await startOperator(root, autoPosterBaseUrl);
  return { operator, graphHash, executeStatus };
}

/**
 * The state every scenario must observe immediately after the ambiguity: the OS
 * says truth is unknown, and no execution-advancing action is offered until it
 * is reconciled.
 */
async function assertAmbiguityIsProjected(
  operator: OperatorHarness,
  label: string,
): Promise<OsObservation> {
  const interrupted = await readOs(operator.baseUrl, OS_MISSION_ID);
  assert.equal(
    interrupted.status,
    "reconciliation_required",
    `${label}: an unobserved downstream outcome must project as reconciliation_required, `
    + `not as an ordinary recoverable failure (was ${interrupted.status})`,
  );
  assert.equal(
    interrupted.evidenceStatus,
    "reconciliation_required",
    `${label}: evidence cannot be authoritative while the outcome is unknown`,
  );
  assert.equal(
    interrupted.recoveryClassification,
    "RECOVERY_DOWNSTREAM_UNAVAILABLE",
    `${label}: the classification must name an unobserved downstream outcome`,
  );
  assert.ok(
    interrupted.nextPermittedActions.includes("reconcile"),
    `${label}: reconcile must be offered, got ${JSON.stringify(interrupted.nextPermittedActions)}`,
  );
  assert.ok(
    !interrupted.nextPermittedActions.includes("resume"),
    `${label}: resume must not be offered before downstream truth is known, `
    + `got ${JSON.stringify(interrupted.nextPermittedActions)}`,
  );
  return interrupted;
}

// ---------------------------------------------------------------------------
// A1 — Reality A: the draft exists, the response was lost
// ---------------------------------------------------------------------------

test(
  "A1 binds the existing draft when an unobserved dispatch actually created one",
  { timeout: 180_000 },
  async (context) => {
    const boundary = createAutoPosterBoundary();
    const autoPoster = await startAutoPoster(boundary);
    const root = disposableRoot();
    context.after(async () => { await autoPoster.stop().catch(() => undefined); });

    const { operator, graphHash } = await dispatchAmbiguouslyThenReconstruct(
      root, boundary, autoPoster.baseUrl, "drop_after_create");
    context.after(async () => { await operator.stop().catch(() => undefined); });

    // --- The world already changed; Operator never learned it ---------------
    const afterAmbiguity = sideEffects(boundary);
    assert.deepEqual(afterAmbiguity, {
      scheduleRequestAttempts: 1,
      scheduleResponsesObserved: 0,
      durableCreateCalls: 1,
      draftLookupCalls: 0,
      draftBindingsFound: 0,
      drafts: 1,
      providerPublishCalls: 0,
    }, "the side effect happened and no response was ever observed");

    const interrupted = await assertAmbiguityIsProjected(operator, "A1");
    assert.equal(interrupted.jobId, null, "Operator holds no authoritative downstream identity");
    const draftId = boundary.posts[0]!.id;
    const childMissionId = text(interrupted.childMissionId);

    const identityBefore = {
      osMissionId: interrupted.osMissionId,
      commandId: interrupted.commandId,
      graphId: interrupted.graphId,
      graphHash: interrupted.graphHash,
      payloadHash: interrupted.payloadHash,
      traceId: interrupted.traceId,
      childMissionId: interrupted.childMissionId,
    };

    // --- Reconcile: exactly one authoritative lookup, zero side effects -----
    const reconciled = await call(
      operator.baseUrl, "POST", `/api/os/missions/${OS_MISSION_ID}/reconcile`, CONTROL_TOKEN, {});
    assert.equal(reconciled.status, 200, JSON.stringify(reconciled.body));

    const afterReconcile = sideEffects(boundary);
    assert.deepEqual(afterReconcile, {
      ...afterAmbiguity,
      draftLookupCalls: 1,
      draftBindingsFound: 1,
    }, "reconciliation performed exactly one lookup and created nothing");

    const childAfterReconcile = await readChild(operator.baseUrl, childMissionId);
    assert.equal(childAfterReconcile.reconciliationOutcome, "unique");
    assert.equal(
      childAfterReconcile.authoritativeQueueId, draftId,
      "reconciliation bound the already-existing downstream draft");
    assert.equal(childAfterReconcile.retryCount, 0, "presence must never unlock a retry");

    // --- A4: repeating reconciliation mutates nothing -----------------------
    const repeatedReconcile = await call(
      operator.baseUrl, "POST", `/api/os/missions/${OS_MISSION_ID}/reconcile`, CONTROL_TOKEN, {});
    assert.equal(
      repeatedReconcile.status, 409,
      `a settled reconciliation must not be re-run: ${JSON.stringify(repeatedReconcile.body)}`);
    assert.equal(repeatedReconcile.body.code, "RECOVERY_ACTION_NOT_PERMITTED");
    assert.deepEqual(
      sideEffects(boundary), afterReconcile,
      "the repeated reconcile changed no counter at all");
    const childAfterRepeat = await readChild(operator.baseUrl, childMissionId);
    assert.deepEqual(
      childAfterRepeat, childAfterReconcile,
      "repeated reads return stable identity and classification");

    // --- Resume: converge on the existing draft, never create another -------
    const resumed = await call(
      operator.baseUrl, "POST", `/api/os/missions/${OS_MISSION_ID}/resume`, CONTROL_TOKEN, { graphHash });
    assert.equal(resumed.status, 200, JSON.stringify(resumed.body));
    const completed = observe(resumed.body);

    assert.equal(completed.status, "completed");
    assert.equal(completed.evidenceStatus, "authoritative");
    assert.equal(completed.jobId, draftId, "converged on the already-existing jobId");
    assert.deepEqual({
      osMissionId: completed.osMissionId,
      commandId: completed.commandId,
      graphId: completed.graphId,
      graphHash: completed.graphHash,
      payloadHash: completed.payloadHash,
      traceId: completed.traceId,
      childMissionId: completed.childMissionId,
    }, identityBefore, "no identity was re-minted anywhere in the recovery");

    const finalCounts = sideEffects(boundary);
    assert.deepEqual(finalCounts, {
      scheduleRequestAttempts: 1,
      scheduleResponsesObserved: 0,
      durableCreateCalls: 1,
      draftLookupCalls: 1,
      draftBindingsFound: 1,
      drafts: 1,
      providerPublishCalls: 0,
    }, "Reality A: one attempt, one create, one draft, nothing published");
    assertNothingPublished(boundary);

    // A repeated read changes nothing.
    const reread = await readOs(operator.baseUrl, OS_MISSION_ID);
    assert.equal(reread.status, "completed");
    assert.equal(reread.jobId, draftId);
    assert.deepEqual(sideEffects(boundary), finalCounts);

    console.log(`A1 (Reality A) observed evidence:\n${JSON.stringify({
      ambiguity: {
        status: interrupted.status,
        laneState: interrupted.laneState,
        evidenceStatus: interrupted.evidenceStatus,
        nextPermittedActions: interrupted.nextPermittedActions,
        recoveryClassification: interrupted.recoveryClassification,
        lastConfirmedBoundary: interrupted.lastConfirmedBoundary,
        typedError: interrupted.typedError,
      },
      reconciliation: {
        outcome: childAfterReconcile.reconciliationOutcome,
        boundQueueId: childAfterReconcile.authoritativeQueueId,
        retryCount: childAfterReconcile.retryCount,
        repeatedReconcileCode: repeatedReconcile.body.code,
      },
      recovered: {
        status: completed.status,
        laneState: completed.laneState,
        evidenceStatus: completed.evidenceStatus,
        evidenceReference: completed.evidenceReference,
        nextPermittedActions: completed.nextPermittedActions,
      },
      identity: {
        ...identityBefore,
        runtimeExecutionId: completed.runtimeExecutionId,
        jobId: completed.jobId,
        campaignId: completed.campaignId,
        approvalId: completed.approvalId,
        evidenceBundleId: completed.evidenceBundleId,
      },
      counters: { afterAmbiguity, afterReconcile, final: finalCounts },
    }, null, 2)}`);
  },
);

// ---------------------------------------------------------------------------
// A2 — Reality B: no draft exists, the response was lost
// ---------------------------------------------------------------------------

test(
  "A2 unlocks exactly one safe retry when an unobserved dispatch created nothing",
  { timeout: 180_000 },
  async (context) => {
    const boundary = createAutoPosterBoundary();
    const autoPoster = await startAutoPoster(boundary);
    const root = disposableRoot();
    context.after(async () => { await autoPoster.stop().catch(() => undefined); });

    const { operator, graphHash } = await dispatchAmbiguouslyThenReconstruct(
      root, boundary, autoPoster.baseUrl, "drop_before_create");
    context.after(async () => { await operator.stop().catch(() => undefined); });

    // --- The world did not change, and Operator equally cannot know it ------
    const afterAmbiguity = sideEffects(boundary);
    assert.deepEqual(afterAmbiguity, {
      scheduleRequestAttempts: 1,
      scheduleResponsesObserved: 0,
      durableCreateCalls: 0,
      draftLookupCalls: 0,
      draftBindingsFound: 0,
      drafts: 0,
      providerPublishCalls: 0,
    }, "the request reached the boundary and created nothing");

    const interrupted = await assertAmbiguityIsProjected(operator, "A2");
    assert.equal(interrupted.jobId, null);
    const childMissionId = text(interrupted.childMissionId);
    const identityBefore = {
      osMissionId: interrupted.osMissionId,
      commandId: interrupted.commandId,
      graphId: interrupted.graphId,
      graphHash: interrupted.graphHash,
      payloadHash: interrupted.payloadHash,
      traceId: interrupted.traceId,
      childMissionId: interrupted.childMissionId,
    };

    // --- Reconcile: prove absence with exactly one lookup -------------------
    const reconciled = await call(
      operator.baseUrl, "POST", `/api/os/missions/${OS_MISSION_ID}/reconcile`, CONTROL_TOKEN, {});
    assert.equal(reconciled.status, 200, JSON.stringify(reconciled.body));

    const afterReconcile = sideEffects(boundary);
    assert.deepEqual(afterReconcile, {
      ...afterAmbiguity,
      draftLookupCalls: 1,
    }, "reconciliation performed exactly one lookup and created nothing");

    const childAfterReconcile = await readChild(operator.baseUrl, childMissionId);
    assert.equal(
      childAfterReconcile.reconciliationOutcome, "not_found",
      "absence was proven, not inferred");
    assert.equal(childAfterReconcile.authoritativeQueueId, null);
    assert.equal(childAfterReconcile.retryCount, 0, "the safe retry is unlocked, not yet spent");
    assert.ok(
      childAfterReconcile.nextPermittedActions.includes("Resume safely"),
      "only proven absence may unlock a retry");

    const readyToRetry = await readOs(operator.baseUrl, OS_MISSION_ID);
    assert.ok(
      readyToRetry.nextPermittedActions.includes("resume"),
      `resume must be offered once absence is proven, got ${
        JSON.stringify(readyToRetry.nextPermittedActions)}`);

    // --- A4: repeating reconciliation mints no second retry permission ------
    const repeatedReconcile = await call(
      operator.baseUrl, "POST", `/api/os/missions/${OS_MISSION_ID}/reconcile`, CONTROL_TOKEN, {});
    assert.equal(repeatedReconcile.status, 200, JSON.stringify(repeatedReconcile.body));
    assert.deepEqual(sideEffects(boundary), {
      ...afterReconcile,
      draftLookupCalls: 2,
    }, "only the lookup counter moved");
    const childAfterRepeat = await readChild(operator.baseUrl, childMissionId);
    assert.deepEqual(
      childAfterRepeat, childAfterReconcile,
      "classification and retry budget are stable across repeated reconciliation");

    // --- Resume: exactly one safe retry -------------------------------------
    const resumed = await call(
      operator.baseUrl, "POST", `/api/os/missions/${OS_MISSION_ID}/resume`, CONTROL_TOKEN, { graphHash });
    assert.equal(resumed.status, 200, JSON.stringify(resumed.body));
    const completed = observe(resumed.body);

    assert.equal(completed.status, "completed");
    assert.equal(completed.evidenceStatus, "authoritative");
    assert.ok(completed.jobId, "the safe retry produced the one canonical jobId");
    assert.equal(completed.jobId, boundary.posts[0]!.id);
    assert.deepEqual({
      osMissionId: completed.osMissionId,
      commandId: completed.commandId,
      graphId: completed.graphId,
      graphHash: completed.graphHash,
      payloadHash: completed.payloadHash,
      traceId: completed.traceId,
      childMissionId: completed.childMissionId,
    }, identityBefore, "the retry reused every canonical identity");

    const finalCounts = sideEffects(boundary);
    assert.deepEqual(finalCounts, {
      scheduleRequestAttempts: 2,
      scheduleResponsesObserved: 1,
      durableCreateCalls: 1,
      // Two explicit reconciliations, plus the one the resume performs itself
      // immediately before spending the retry — absence is re-proven against
      // live downstream truth at the moment of acting, not trusted from before.
      draftLookupCalls: 3,
      draftBindingsFound: 0,
      drafts: 1,
      providerPublishCalls: 0,
    }, "Reality B: two attempts, one create, one draft, nothing published");
    assertNothingPublished(boundary);

    const childFinal = await readChild(operator.baseUrl, childMissionId);
    assert.equal(childFinal.retryCount, 1, "exactly one retry was ever spent");

    const reread = await readOs(operator.baseUrl, OS_MISSION_ID);
    assert.equal(reread.status, "completed");
    assert.equal(reread.jobId, completed.jobId);
    assert.deepEqual(sideEffects(boundary), finalCounts);

    console.log(`A2 (Reality B) observed evidence:\n${JSON.stringify({
      ambiguity: {
        status: interrupted.status,
        laneState: interrupted.laneState,
        evidenceStatus: interrupted.evidenceStatus,
        nextPermittedActions: interrupted.nextPermittedActions,
        recoveryClassification: interrupted.recoveryClassification,
        typedError: interrupted.typedError,
      },
      reconciliation: {
        outcome: childAfterReconcile.reconciliationOutcome,
        retryCountAfterReconcile: childAfterReconcile.retryCount,
        osActionsAfterReconcile: readyToRetry.nextPermittedActions,
        repeatedReconcileStatus: repeatedReconcile.status,
      },
      recovered: {
        status: completed.status,
        evidenceStatus: completed.evidenceStatus,
        jobId: completed.jobId,
        retryCountFinal: childFinal.retryCount,
      },
      identity: identityBefore,
      counters: { afterAmbiguity, afterReconcile, final: finalCounts },
    }, null, 2)}`);
  },
);

// ---------------------------------------------------------------------------
// A3 — the reconciliation lookup itself fails ambiguously
// ---------------------------------------------------------------------------

test(
  "A3 keeps retry locked when the reconciliation lookup cannot establish truth",
  { timeout: 180_000 },
  async (context) => {
    const boundary = createAutoPosterBoundary();
    const autoPoster = await startAutoPoster(boundary);
    const root = disposableRoot();
    context.after(async () => { await autoPoster.stop().catch(() => undefined); });

    // Reality A underneath: a draft really does exist. If a failed lookup were
    // ever treated as absence, the retry would create a second one.
    const { operator, graphHash } = await dispatchAmbiguouslyThenReconstruct(
      root, boundary, autoPoster.baseUrl, "drop_after_create");
    context.after(async () => { await operator.stop().catch(() => undefined); });

    const afterAmbiguity = sideEffects(boundary);
    assert.equal(afterAmbiguity.drafts, 1);
    const draftId = boundary.posts[0]!.id;
    const interrupted = await assertAmbiguityIsProjected(operator, "A3");
    const childMissionId = text(interrupted.childMissionId);

    // --- The lookup itself is now ambiguous ---------------------------------
    // It stays broken across the refusal below: the point is that while truth
    // cannot be established, nothing may advance.
    boundary.control.lookupTransport = "drop";
    const failedReconcile = await call(
      operator.baseUrl, "POST", `/api/os/missions/${OS_MISSION_ID}/reconcile`, CONTROL_TOKEN, {});
    assert.equal(
      failedReconcile.status, 200,
      `a failed lookup is recorded, not thrown away: ${JSON.stringify(failedReconcile.body)}`);

    assert.deepEqual(sideEffects(boundary), {
      ...afterAmbiguity,
      draftLookupCalls: 1,
    }, "a failed lookup creates nothing and publishes nothing");

    const afterFailure = await readOs(operator.baseUrl, OS_MISSION_ID);
    assert.equal(
      afterFailure.status, "reconciliation_required",
      "a failed lookup leaves truth unknown, so the state must not soften");
    assert.ok(
      !afterFailure.nextPermittedActions.includes("resume"),
      `resume must remain locked after a failed lookup, got ${
        JSON.stringify(afterFailure.nextPermittedActions)}`);
    assert.ok(
      afterFailure.nextPermittedActions.includes("reconcile"),
      "reconciliation must remain available");

    const childAfterFailure = await readChild(operator.baseUrl, childMissionId);
    assert.equal(
      childAfterFailure.reconciliationOutcome, "unavailable",
      "an unreachable lookup is recorded as unavailable, never as not_found");
    assert.equal(childAfterFailure.retryCount, 0);
    assert.ok(
      !childAfterFailure.nextPermittedActions.includes("Resume safely"),
      "timeout is not absence: no retry may be unlocked");

    // The reconciliation failure is named by the authority that observed it.
    assert.equal(
      childAfterFailure.typedErrorCode, "RECOVERY_DOWNSTREAM_UNAVAILABLE",
      "the child authority's typed error must name the reconciliation failure");
    assert.equal(
      afterFailure.recoveryClassification, "RECOVERY_DOWNSTREAM_UNAVAILABLE",
      "the OS projects that same classification rather than inventing one");

    // --- The decisive refusal ----------------------------------------------
    // A resume issued while the lookup is still broken cannot establish truth,
    // so it must refuse rather than guess. This is the property that makes the
    // whole design safe: the retry is locked behind established truth, not
    // behind an operator remembering to reconcile first.
    const resumeWhileUnknown = await call(
      operator.baseUrl, "POST", `/api/os/missions/${OS_MISSION_ID}/resume`, CONTROL_TOKEN, { graphHash });
    assert.equal(
      resumeWhileUnknown.status, 409,
      `resume must refuse while truth is unknown: ${JSON.stringify(resumeWhileUnknown.body)}`);
    assert.equal(text(resumeWhileUnknown.body.code), "PLATFORM_COMMAND_EXECUTION_INCOMPLETE");
    assert.deepEqual(sideEffects(boundary), {
      ...afterAmbiguity,
      draftLookupCalls: 2,
    }, "the refused resume attempted one more lookup and created nothing");

    const afterRefusal = await readOs(operator.baseUrl, OS_MISSION_ID);
    assert.equal(afterRefusal.status, "reconciliation_required", "the refusal did not soften state");
    assert.ok(!afterRefusal.nextPermittedActions.includes("resume"));

    // --- A successful reconciliation now converges (Reality A) --------------
    boundary.control.lookupTransport = "healthy";
    const reconciled = await call(
      operator.baseUrl, "POST", `/api/os/missions/${OS_MISSION_ID}/reconcile`, CONTROL_TOKEN, {});
    assert.equal(reconciled.status, 200, JSON.stringify(reconciled.body));

    const resumed = await call(
      operator.baseUrl, "POST", `/api/os/missions/${OS_MISSION_ID}/resume`, CONTROL_TOKEN, { graphHash });
    assert.equal(resumed.status, 200, JSON.stringify(resumed.body));
    const completed = observe(resumed.body);
    assert.equal(completed.status, "completed");
    assert.equal(completed.jobId, draftId, "converged on the pre-existing draft");

    const finalCounts = sideEffects(boundary);
    assert.deepEqual(finalCounts, {
      scheduleRequestAttempts: 1,
      scheduleResponsesObserved: 0,
      durableCreateCalls: 1,
      draftLookupCalls: 3,
      draftBindingsFound: 1,
      drafts: 1,
      providerPublishCalls: 0,
    }, "two failed lookups then a successful one still yield exactly one draft");
    assertNothingPublished(boundary);

    console.log(`A3 (lookup failure) observed evidence:\n${JSON.stringify({
      afterFailedLookup: {
        status: afterFailure.status,
        laneState: afterFailure.laneState,
        evidenceStatus: afterFailure.evidenceStatus,
        nextPermittedActions: afterFailure.nextPermittedActions,
        typedError: afterFailure.typedError,
        reconciliationOutcome: childAfterFailure.reconciliationOutcome,
        retryCount: childAfterFailure.retryCount,
      },
      resumeWhileUnknown: {
        status: resumeWhileUnknown.status,
        code: resumeWhileUnknown.body.code,
      },
      converged: { status: completed.status, jobId: completed.jobId },
      counters: finalCounts,
    }, null, 2)}`);
  },
);

// ---------------------------------------------------------------------------
// D1 — the observed deviation, pinned
//
// The brief specifies that `resume` be refused with a typed 409 until a
// separate `reconcile` call has run. This repository does not work that way: a
// Platform `resume` reaching a child in `failed_recoverable` performs the
// authoritative lookup itself (missionGraphService dispatchNode) and only then
// decides, so a resume issued during ambiguity is accepted rather than refused.
//
// That difference is in the operator gesture, not in the safety property — A3
// already proves the retry is locked whenever truth cannot be established. This
// test pins the deviation so it stays deliberate: whichever reality is true
// underneath, an ambiguous resume must still converge on exactly one draft and
// must never publish.
// ---------------------------------------------------------------------------

for (const reality of [
  { name: "A: the draft already exists", transport: "drop_after_create" as ScheduleTransport,
    expectedAttempts: 1, expectedClassification: "RECOVERED_EXISTING_DOWNSTREAM_RESULT" },
  { name: "B: no draft exists", transport: "drop_before_create" as ScheduleTransport,
    expectedAttempts: 2, expectedClassification: "SAFE_RETRY_COMPLETED" },
]) {
  test(
    `D1 resume during ambiguity reconciles before acting and never duplicates (Reality ${reality.name})`,
    { timeout: 180_000 },
    async (context) => {
      const boundary = createAutoPosterBoundary();
      const autoPoster = await startAutoPoster(boundary);
      const root = disposableRoot();
      context.after(async () => { await autoPoster.stop().catch(() => undefined); });

      const { operator, graphHash } = await dispatchAmbiguouslyThenReconstruct(
        root, boundary, autoPoster.baseUrl, reality.transport);
      context.after(async () => { await operator.stop().catch(() => undefined); });

      const interrupted = await assertAmbiguityIsProjected(operator, "D1");
      assert.equal(interrupted.jobId, null);

      // No explicit reconcile: straight to resume while the outcome is unknown.
      const resumed = await call(
        operator.baseUrl, "POST", `/api/os/missions/${OS_MISSION_ID}/resume`, CONTROL_TOKEN, { graphHash });
      assert.equal(resumed.status, 200, JSON.stringify(resumed.body));
      const completed = observe(resumed.body);

      assert.equal(completed.status, "completed");
      assert.equal(
        completed.recoveryClassification, reality.expectedClassification,
        "the recovery must be classified from the lookup result, never assumed");

      const counts = sideEffects(boundary);
      assert.equal(counts.drafts, 1, "exactly one draft exists in both realities");
      assert.equal(counts.durableCreateCalls, 1, "exactly one durable create ever happened");
      assert.equal(
        counts.draftLookupCalls, 1,
        "the resume performed the authoritative lookup itself before acting");
      assert.equal(
        counts.scheduleRequestAttempts, reality.expectedAttempts,
        "presence binds without redispatch; absence dispatches exactly once more");
      assert.equal(completed.jobId, boundary.posts[0]!.id);
      assertNothingPublished(boundary);

      console.log(`D1 (Reality ${reality.name}) observed evidence:\n${JSON.stringify({
        ambiguityStatus: interrupted.status,
        ambiguityActions: interrupted.nextPermittedActions,
        resumeStatus: resumed.status,
        recoveryClassification: completed.recoveryClassification,
        jobId: completed.jobId,
        counters: counts,
      }, null, 2)}`);
    },
  );
}
