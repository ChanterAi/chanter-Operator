/**
 * CHANTER OS — unified mission control plane proof.
 *
 * One real Operator process, driven end to end through `/api/os/missions`
 * alone, carrying both already-proven execution lanes:
 *
 *   Scenario A — generic governed task
 *     chanter.mission.v1 envelope
 *     -> unified OS intake -> durable operator_missions spine
 *     -> persisted, signed approval bound to an exact repository revision
 *     -> real chanter-agent-runtime executeMission + Loop Governor adapter
 *     -> real `python -m governor.mission_intake` child process (no shell)
 *     -> exactly one Loop Governor manual (agent-frozen) task + relay loop
 *
 *   Scenario B — Platform AutoPoster command
 *     chanter.platform.autoposter.create-work.v1 command
 *     -> unified OS intake -> durable command + Phase 2D mission graph
 *     -> control approval bound to the exact graph hash
 *     -> real chanter-agent-runtime HTTP adapter
 *     -> real AutoPoster runtime route + application service
 *     -> exactly one unapproved queue draft; publication stays human-gated
 *
 *   Scenario C — unified observation
 *     one canonical list, one contract shape, lane-typed downstream identity,
 *     authoritative evidence, and no cross-lane identity collision.
 *
 * Both lanes are restarted abruptly, replayed, and offered a changed payload
 * under the same identity, which must be refused with a typed conflict.
 *
 * The Operator runs as a genuine child process, so the kill is a real
 * interruption rather than a simulated one. The AutoPoster boundary runs inside
 * this runner instead, so it survives every Operator restart and its durable
 * draft count stays independently observable across them.
 *
 * Everything runs against disposable temporary directories. Nothing publishes,
 * deploys, or touches a live product checkout. No provider adapter is installed
 * or invoked, and real coding-agent execution stays frozen end to end.
 *
 * Usage:
 *   npm run os:unified
 *   npm run os:unified -- --out <dir> --keep
 */
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { Buffer } from "node:buffer";
import { generateKeyPairSync } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import type { Server } from "node:http";
import { createRequire } from "node:module";
import net from "node:net";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const operatorRoot = path.resolve(here, "../..");
const governorRoot = path.resolve(operatorRoot, "../chanter-loop.governor");
const autoPosterRoot = path.resolve(operatorRoot, "../chanter-auto-poster");
const serverEntry = path.join(operatorRoot, "apps", "backend", "src", "server.ts");

const APPROVER = "founder";
const ISSUER_AUTHORITY_ID = "chanter.operator.os-unified";
const ISSUER_KEY_ID = "os-unified-key-1";
const AUTHORIZED_POLICY_IDS = ["chanter.operator.human-approval.v1"];
const HEALTH_TIMEOUT_MS = 60_000;

const OWNER_ID = "owner";
const TENANT_ID = "workspace-os-unified";
const PLATFORM_ACTOR_ID = "os-unified-platform-actor";
const ACCOUNT_ID = "tt-os-unified";

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
function argValue(flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}
const keepArtifacts = argv.includes("--keep");
const outputDir = path.resolve(argValue("--out") ?? path.join(operatorRoot, "var", "os-unified"));

// ---------------------------------------------------------------------------
// AutoPoster boundary environment
//
// The AutoPoster config module reads these at require time, so they are set
// before the first require below. They are disposable test values that never
// reach a provider: no provider adapter is installed in this proof.
// ---------------------------------------------------------------------------

const RUNTIME_TOKEN = `os-unified-runtime-${Math.random().toString(36).slice(2)}`;
process.env.APP_DEFAULT_USER_ID = OWNER_ID;
process.env.ADMIN_PASSWORD = "os-unified-local-proof-admin-password";
process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 11).toString("base64");
process.env.YOUTUBE_CLIENT_ID = "os-unified.apps.googleusercontent.com";
process.env.YOUTUBE_CLIENT_SECRET = "os-unified-local-proof-secret";
process.env.YOUTUBE_REDIRECT_URI = "http://localhost:10000/auth/youtube/callback";

// ---------------------------------------------------------------------------
// Step recording — every claim in the terminal result is an observation
// ---------------------------------------------------------------------------

interface StepRecord {
  scenario: string;
  step: number;
  name: string;
  outcome: "passed" | "failed";
  observed: Record<string, unknown>;
  error?: string;
}

const steps: StepRecord[] = [];
let stepNumber = 0;
let currentScenario = "setup";

async function step(
  name: string,
  run: () => Promise<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  stepNumber += 1;
  const current = stepNumber;
  const scenario = currentScenario;
  try {
    const observed = await run();
    steps.push({ scenario, step: current, name, outcome: "passed", observed });
    console.log(`  [${String(current).padStart(2, "0")}] PASS  (${scenario}) ${name}`);
    return observed;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    steps.push({ scenario, step: current, name, outcome: "failed", observed: {}, error: message });
    console.error(`  [${String(current).padStart(2, "0")}] FAIL  (${scenario}) ${name}`);
    console.error(`        ${message.split("\n")[0]}`);
    throw error;
  }
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

// ---------------------------------------------------------------------------
// Provisioning: approval authority repository + signing identity
// ---------------------------------------------------------------------------

function git(repositoryRoot: string, args: readonly string[]): void {
  execFileSync("git", ["-C", repositoryRoot, ...args], {
    stdio: "ignore",
    windowsHide: true,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
  });
}

/**
 * The Runtime binds every approval to a real repository identity, an exact
 * committed HEAD, and a strictly clean worktree, so the proof needs a real Git
 * checkout. A disposable one is used deliberately: binding directly to a live
 * product checkout is permanently fail-closed under the Runtime's
 * `tracked_and_untracked` clean-state policy.
 */
function createApprovalRepository(root: string): { repositoryRoot: string; head: string } {
  const repositoryRoot = path.join(root, "approval-authority-repo");
  mkdirSync(repositoryRoot, { recursive: true });
  git(repositoryRoot, ["init", "--quiet"]);
  git(repositoryRoot, ["config", "user.name", "CHANTER OS Unified"]);
  git(repositoryRoot, ["config", "user.email", "os-unified@invalid.local"]);
  git(repositoryRoot, ["config", "commit.gpgsign", "false"]);
  writeFileSync(
    path.join(repositoryRoot, "APPROVAL_AUTHORITY.md"),
    "os unified approval authority\n",
    "utf8",
  );
  git(repositoryRoot, ["add", "--", "APPROVAL_AUTHORITY.md"]);
  git(repositoryRoot, ["commit", "--quiet", "-m", "approval authority"]);
  const head = execFileSync("git", ["-C", repositoryRoot, "rev-parse", "HEAD"], {
    encoding: "utf8",
    windowsHide: true,
  }).trim();
  return { repositoryRoot, head };
}

/** A disposable Ed25519 signing identity, supplied exactly as a deployment does. */
function createIssuer(root: string): { privateKeyFile: string; trustedIssuersFile: string } {
  const issuerDir = path.join(root, "approval-issuer");
  mkdirSync(issuerDir, { recursive: true });
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const privateKeyFile = path.join(issuerDir, "issuer.key.pem");
  writeFileSync(privateKeyFile, privateKey.export({ type: "pkcs8", format: "pem" }).toString(), {
    encoding: "utf8",
    mode: 0o600,
  });
  const trustedIssuersFile = path.join(issuerDir, "trusted-issuers.json");
  writeFileSync(
    trustedIssuersFile,
    JSON.stringify({
      issuers: [{
        authorityId: ISSUER_AUTHORITY_ID,
        authorizedPolicyIds: AUTHORIZED_POLICY_IDS,
        keys: [{
          keyId: ISSUER_KEY_ID,
          publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
        }],
      }],
    }),
    "utf8",
  );
  return { privateKeyFile, trustedIssuersFile };
}

function resolvePython(): string {
  const configured = process.env.LOOP_GOVERNOR_PYTHON?.trim();
  if (configured && path.isAbsolute(configured)) return configured;
  const probe = spawnSync(process.platform === "win32" ? "where" : "which", [configured || "python"], {
    encoding: "utf8",
    windowsHide: true,
  });
  const found = probe.stdout
    ?.split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0 && path.isAbsolute(line));
  assert.ok(found, "An absolute python executable is required for the unified proof.");
  return found;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => (port ? resolve(port) : reject(new Error("No free port available."))));
    });
  });
}

// ---------------------------------------------------------------------------
// Real AutoPoster boundary (hosted inside this runner)
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
  /**
   * Cross-repository correlation metadata AutoPoster persists at schedule
   * time. The schedule-result contract re-reads these to rebuild the linkage
   * identities, so a boundary that drops them is rejected as invalid linkage.
   */
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
  getCanonicalTikTokAccount(userId: string, accountId: string): Promise<ConnectedAccountFixture | null>;
  getCanonicalTikTokAccounts(userId: string): Promise<ConnectedAccountFixture[]>;
  getTikTokAccount(userId: string, accountId: string): Promise<ConnectedAccountFixture | null>;
  getTikTokAccounts(userId: string): Promise<ConnectedAccountFixture[]>;
  listConnectedAccountReferencesForOwner(
    userId: string,
  ): Promise<Array<{ provider: string; accountId: string; workspaceId: string }>>;
  getPosts(userId: string, accountId?: string): Promise<StoredPost[]>;
  getPost(userId: string, id: string, accountId?: string): Promise<StoredPost | null>;
  addUploadedPosts(
    userId: string,
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

interface AutoPosterConfigModule {
  runtimeControl: { token: string };
  defaultUserId: string;
}

const require_ = createRequire(import.meta.url);
const applicationServiceModule = require_(
  path.join(autoPosterRoot, "src", "autoposterApplicationService.js"),
) as AutoPosterApplicationModule;
const runtimeControlRoutes = require_(
  path.join(autoPosterRoot, "src", "runtimeControlRoutes.js"),
) as import("express").RequestHandler;
const autoPosterConfig = require_(
  path.join(autoPosterRoot, "src", "config.js"),
) as AutoPosterConfigModule;
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
    username: "os_unified",
    displayName: "OS Unified",
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
  /**
   * Stays zero by construction: no provider adapter is installed in this
   * proof, so there is no code path that could publish. The counter exists so
   * "nothing published" is an observed number rather than an assumption.
   */
  providerPublishCalls: number;
  readonly adapter: AutoPosterStorageAdapter;
}

function requiredText(defaults: Record<string, unknown>, key: string): string {
  const value = defaults[key];
  assert.equal(typeof value, "string", `AutoPoster defaults.${key} must be a string.`);
  return value as string;
}

/** A field the schedule contract treats as optional at persistence time. */
function optionalText(defaults: Record<string, unknown>, key: string): string {
  const value = defaults[key];
  return typeof value === "string" ? value : "";
}

function createAutoPosterBoundary(): AutoPosterBoundary {
  const posts: StoredPost[] = [];
  const account = accountFixture();
  const matches = (userId: string, accountId: string) =>
    account.userId === userId && account.accountId === accountId;

  const boundary: AutoPosterBoundary = {
    posts,
    durableCreateCalls: 0,
    scheduleContractCalls: 0,
    accountValidationCalls: 0,
    providerPublishCalls: 0,
    adapter: {
      async getCanonicalTikTokAccount(userId, accountId) {
        return matches(userId, accountId) ? account : null;
      },
      async getCanonicalTikTokAccounts(userId) {
        return userId === OWNER_ID ? [account] : [];
      },
      async getTikTokAccount(userId, accountId) {
        return matches(userId, accountId) ? account : null;
      },
      async getTikTokAccounts(userId) {
        return userId === OWNER_ID ? [account] : [];
      },
      async listConnectedAccountReferencesForOwner(userId) {
        return userId === OWNER_ID
          ? [{
            provider: account.provider,
            accountId: account.accountId,
            workspaceId: account.workspaceId,
          }]
          : [];
      },
      async getPosts(userId, accountId) {
        return posts.filter((post) =>
          post.userId === userId && (!accountId || post.accountId === accountId));
      },
      async getPost(userId, id, accountId) {
        return posts.find((post) =>
          post.userId === userId
          && post.id === id
          && (!accountId || post.accountId === accountId)) ?? null;
      },
      async addUploadedPosts(userId, _files, defaults) {
        boundary.durableCreateCalls += 1;
        const id = requiredText(defaults, "documentId");
        if (posts.some((post) => post.id === id)) {
          // The real storage layer signals an existing document this way, and
          // the idempotent create above it depends on that exact signal.
          const error = new Error("already exists") as Error & { code?: number };
          error.code = 6;
          throw error;
        }
        const timestamp = new Date().toISOString();
        const post: StoredPost = {
          id,
          userId,
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
          // AutoPoster derives a campaign when the caller supplies none, and
          // its schedule-result contract refuses a blank one, so the boundary
          // persists the same fallback the real storage layer does.
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
        };
        posts.push(post);
        return [post];
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

  // Counters wrap the real contract methods, so every number reported below is
  // a count of genuine application-service calls.
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
    "listConnectedAccounts",
    "validateConnectedAccount",
    "listQueue",
    "getPostStatus",
    "validateMedia",
    "schedulePost",
    "reconcileRuntimeSchedule",
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

// ---------------------------------------------------------------------------
// Operator server process control
// ---------------------------------------------------------------------------

interface OperatorProcess {
  child: ChildProcess;
  baseUrl: string;
  pid: number;
}

async function startOperator(
  environment: Record<string, string>,
  port: number,
): Promise<OperatorProcess> {
  const child = spawn(process.execPath, ["--import", "tsx", serverEntry], {
    cwd: operatorRoot,
    env: { ...process.env, ...environment, OPERATOR_PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    shell: false,
  });
  const logs: string[] = [];
  child.stdout?.on("data", (chunk: Buffer) => logs.push(chunk.toString("utf8")));
  child.stderr?.on("data", (chunk: Buffer) => logs.push(chunk.toString("utf8")));
  let exited = false;
  child.once("exit", () => (exited = true));

  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (exited) {
      throw new Error(`Operator server exited before becoming healthy.\n${logs.join("")}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return { child, baseUrl, pid: child.pid ?? -1 };
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  child.kill();
  throw new Error(
    `Operator server did not become healthy within ${HEALTH_TIMEOUT_MS}ms.\n${logs.join("")}`,
  );
}

/**
 * An abrupt kill, not a graceful shutdown: durable state must survive a real
 * interruption, which is exactly the property under test.
 */
function killOperator(operator: OperatorProcess): Promise<void> {
  return new Promise((resolve) => {
    if (operator.child.exitCode !== null || operator.child.signalCode !== null) {
      resolve();
      return;
    }
    operator.child.once("exit", () => resolve());
    operator.child.kill();
  });
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

interface HttpResult {
  status: number;
  body: Record<string, unknown>;
}

async function postJson(
  baseUrl: string,
  route: string,
  token: string | null,
  body: unknown,
): Promise<HttpResult> {
  const response = await fetch(`${baseUrl}${route}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function getJson(baseUrl: string, route: string): Promise<HttpResult> {
  const response = await fetch(`${baseUrl}${route}`);
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

// ---------------------------------------------------------------------------
// Loop Governor state observation (read directly from its isolated data dir)
// ---------------------------------------------------------------------------

function governorTaskIds(governorDataDir: string): string[] {
  const tasksDir = path.join(governorDataDir, "tasks");
  if (!existsSync(tasksDir)) return [];
  return readdirSync(tasksDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function governorLoopCount(governorDataDir: string): number {
  const loopsFile = path.join(governorDataDir, "loops.json");
  if (!existsSync(loopsFile)) return 0;
  const parsed = JSON.parse(readFileSync(loopsFile, "utf8")) as unknown;
  if (Array.isArray(parsed)) return parsed.length;
  if (parsed && typeof parsed === "object") return Object.keys(parsed).length;
  return 0;
}

// ---------------------------------------------------------------------------
// Canonical OS view assertions shared by both lanes
// ---------------------------------------------------------------------------

const OS_VIEW_TOP_LEVEL_KEYS = [
  "schemaVersion", "replayed", "identity", "lane", "laneCapability", "status",
  "laneState", "authority", "outcome", "laneReference", "requestedAt",
  "createdAt", "updatedAt",
].sort();

const OS_IDENTITY_KEYS = [
  "osMissionId", "missionRevision", "payloadHash", "traceId", "product",
  "action", "lane", "workspaceId", "actorId", "authorityRevision",
  "runtimeExecutionId", "downstreamIdentity",
].sort();

const OS_OUTCOME_KEYS = [
  "status", "evidenceStatus", "evidenceReference", "valueObservation",
  "downstreamIdentity", "replayOutcome", "recoveryClassification",
  "lastConfirmedBoundary", "nextPermittedActions", "typedError",
].sort();

const OS_AUTHORITY_KEYS = [
  "required", "configured", "trusted", "approved", "approvedBy", "approvalId",
  "authorityRevision", "repositoryBinding", "expiresAt", "refusalCode",
  // Every lane reports what an approval binds, even the lanes that bind a
  // request rather than an output — those report `null`. A field that appeared
  // on some lanes and not others would break the one property this shape check
  // exists to hold: that an OS mission looks the same whichever lane it came
  // from.
  "candidateOutputHash", "approvedOutputHash",
].sort();

/** Every OS mission must expose one identical top-level contract shape. */
function assertCanonicalOsShape(view: Record<string, unknown>, label: string): void {
  assert.deepEqual(Object.keys(view).sort(), OS_VIEW_TOP_LEVEL_KEYS, `${label} top-level shape`);
  assert.deepEqual(Object.keys(record(view.identity)).sort(), OS_IDENTITY_KEYS, `${label} identity`);
  assert.deepEqual(Object.keys(record(view.outcome)).sort(), OS_OUTCOME_KEYS, `${label} outcome`);
  assert.deepEqual(Object.keys(record(view.authority)).sort(), OS_AUTHORITY_KEYS, `${label} authority`);
  assert.equal(view.schemaVersion, "chanter.os.mission.view.v1", `${label} schema version`);
}

// ---------------------------------------------------------------------------
// Proof
// ---------------------------------------------------------------------------

const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), "chanter-os-unified-"));
let operator: OperatorProcess | null = null;
let autoPoster: RunningAutoPoster | null = null;
let verdict: "PASS" | "FAIL" = "FAIL";
let failure: string | null = null;

const startedAt = new Date().toISOString();
const runId = Date.now().toString(36);
const genericMissionId = `chanter-os-unified-generic-${runId}`;
const intakeKey = `os-unified-intake-${runId}`;
const submitToken = `os-unified-submit-${Math.random().toString(36).slice(2)}`;
const controlToken = `os-unified-control-${Math.random().toString(36).slice(2)}`;
const ledgerToken = `os-unified-ledger-${Math.random().toString(36).slice(2)}`;

const governorDataDir = path.join(temporaryRoot, "governor-data");
const approvalStateDir = path.join(temporaryRoot, "approval-state");
mkdirSync(governorDataDir, { recursive: true });
mkdirSync(approvalStateDir, { recursive: true });

// One fixed request instant and one fixed future schedule instant, reused for
// every submission so a replay presents byte-identical payload bytes.
const requestedAt = new Date().toISOString();
const scheduledAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

const genericEnvelopeInput = {
  appName: "chanter-operator",
  taskType: "review",
  goal: "Review the CHANTER OS unified mission control plane.",
  scope: "unified mission control proof only",
};

function genericEnvelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: "chanter.mission.v1",
    missionId: genericMissionId,
    traceId: `${genericMissionId}-trace`,
    idempotencyKey: `${genericMissionId}-key`,
    source: { system: "mission_compiler", requestedBy: "founder-cli" },
    objective: "Create one governed manual review loop through the unified CHANTER OS plane.",
    target: { product: "loop_governor", action: "loop_governor.manual_loop.create" },
    tenant: { userId: "founder" },
    input: genericEnvelopeInput,
    constraints: ["No real agent execution", "Human approval required before any downstream side effect"],
    acceptanceCriteria: [
      "Exactly one Loop Governor manual relay loop exists",
      "Replay after restart creates no second task or loop",
    ],
    requestedAt,
    ...overrides,
  };
}

/**
 * The canonical Platform command id is derived from (tenant, actor, intake)
 * exactly as the Operator derives it, so the proof supplies the same identity
 * the service will independently compute.
 */
function platformCommandId(): string {
  const { createHash } = require_("node:crypto") as typeof import("node:crypto");
  const digest = createHash("sha256")
    .update(`${TENANT_ID}\n${PLATFORM_ACTOR_ID}\n${intakeKey}`, "utf8")
    .digest("hex")
    .slice(0, 40);
  return `platform-autoposter-${digest}`;
}

function platformCommand(overrides: { caption?: string } = {}): Record<string, unknown> {
  return {
    schemaVersion: "chanter.platform.autoposter.create-work.v1",
    commandId: platformCommandId(),
    tenantId: TENANT_ID,
    actorId: PLATFORM_ACTOR_ID,
    intakeKey,
    media: {
      kind: "public_url",
      url: "https://cdn.example.com/os-unified.mp4",
      mediaType: "video",
    },
    destinations: [{ provider: "tiktok", accountId: ACCOUNT_ID, soundMode: "tiktok_recommended" }],
    copy: {
      caption: overrides.caption ?? "CHANTER OS unified mission control proof",
      hashtags: "#chanter #os",
      youtube: { title: "", description: "" },
    },
    schedule: {
      mode: "explicit",
      scheduledAt,
      timezoneName: "UTC",
      timezoneOffsetMinutes: 0,
    },
    approvalPolicy: {
      draftExecution: "operator_control_required",
      publication: "human_required",
    },
    requestedAt,
  };
}

const genericOsId = `os:generic_governed_task:${genericMissionId}`;
const platformOsId = `os:platform_autoposter_command:${platformCommandId()}`;
const observedIds: Record<string, unknown> = {
  genericOsMissionId: genericOsId,
  platformOsMissionId: platformOsId,
};

try {
  console.log("CHANTER OS — unified mission control plane proof");
  console.log(`  temporary root: ${temporaryRoot}`);

  const python = resolvePython();
  const { repositoryRoot, head } = createApprovalRepository(temporaryRoot);
  const { privateKeyFile, trustedIssuersFile } = createIssuer(temporaryRoot);
  observedIds.approvalRepositoryHead = head;

  const boundary = createAutoPosterBoundary();
  autoPoster = await startAutoPoster(boundary);

  const environment: Record<string, string> = {
    OPERATOR_DATABASE_PATH: path.join(temporaryRoot, "operator.sqlite"),
    OPERATOR_AUDIT_PATH: path.join(temporaryRoot, "audit.jsonl"),
    OPERATOR_WORKSPACE_ROOT: path.join(temporaryRoot, "workspace"),
    OPERATOR_EVIDENCE_DIR: path.join(temporaryRoot, "evidence"),
    OPERATOR_MISSION_SUBMIT_TOKEN: submitToken,
    OPERATOR_CONTROL_TOKEN: controlToken,
    OPERATOR_LEDGER_INGEST_TOKEN: ledgerToken,
    AUTOPOSTER_BASE_URL: autoPoster.baseUrl,
    AUTOPOSTER_RUNTIME_TOKEN: RUNTIME_TOKEN,
    OPERATOR_RUNTIME_USER_ID: OWNER_ID,
    AUTOPOSTER_RUNTIME_TIMEOUT_MS: "20000",
    LOOP_GOVERNOR_PYTHON: python,
    LOOP_GOVERNOR_ROOT: governorRoot,
    LOOP_GOVERNOR_MISSION_DATA_DIR: governorDataDir,
    LOOP_GOVERNOR_TIMEOUT_MS: "60000",
    OPERATOR_APPROVAL_AUTHORITY_STATE_DIR: approvalStateDir,
    OPERATOR_APPROVAL_AUTHORITY_REPOSITORY_ROOT: repositoryRoot,
    OPERATOR_APPROVAL_AUTHORITY_ISSUER_ID: ISSUER_AUTHORITY_ID,
    OPERATOR_APPROVAL_AUTHORITY_SIGNING_KEY_ID: ISSUER_KEY_ID,
    OPERATOR_APPROVAL_AUTHORITY_SIGNING_KEY_FILE: privateKeyFile,
    OPERATOR_APPROVAL_AUTHORITY_TRUSTED_ISSUERS_FILE: trustedIssuersFile,
  };

  operator = await startOperator(environment, await freePort());
  const firstPid = operator.pid;
  observedIds.firstOperatorPid = firstPid;

  // =========================================================================
  // Scenario A — generic governed task
  // =========================================================================
  currentScenario = "A/governor";

  await step("Submit one generic governed task through the unified OS intake", async () => {
    const created = await postJson(operator!.baseUrl, "/api/os/missions", submitToken, genericEnvelope());
    assert.equal(created.status, 201, `Expected 201, got ${created.status}: ${JSON.stringify(created.body)}`);
    assertCanonicalOsShape(created.body, "generic submit");
    const identity = record(created.body.identity);
    assert.equal(identity.osMissionId, genericOsId);
    assert.equal(identity.lane, "generic_governed_task");
    assert.equal(created.body.replayed, false);
    assert.equal(governorTaskIds(governorDataDir).length, 0, "Submission must not create a downstream side effect.");
    observedIds.genericPayloadHash = identity.payloadHash;
    return {
      httpStatus: created.status,
      osMissionId: identity.osMissionId,
      lane: identity.lane,
      status: created.body.status,
      payloadHash: identity.payloadHash,
      governorTasksAfterSubmit: 0,
    };
  });

  await step("Observe approval_required with no downstream authority yet granted", async () => {
    const read = await getJson(operator!.baseUrl, `/api/os/missions/${genericOsId}`);
    assert.equal(read.status, 200);
    assert.equal(read.body.status, "approval_required");
    const authority = record(read.body.authority);
    assert.equal(authority.required, true);
    assert.equal(authority.configured, true);
    assert.equal(authority.approved, false, "No approval may exist before a human grants one.");
    const outcome = record(read.body.outcome);
    assert.deepEqual(outcome.nextPermittedActions, ["approve"]);
    assert.equal(outcome.evidenceStatus, "pending");
    return {
      status: read.body.status,
      laneState: read.body.laneState,
      authorityConfigured: authority.configured,
      authorityApproved: authority.approved,
      authorityTrusted: authority.trusted,
      refusalCode: authority.refusalCode,
      nextPermittedActions: outcome.nextPermittedActions,
    };
  });

  await step("Refuse execution without the independent control capability", async () => {
    const withSubmit = await postJson(
      operator!.baseUrl, `/api/os/missions/${genericOsId}/approve`, submitToken, { approvedBy: APPROVER });
    assert.equal(withSubmit.status, 401, "The submit capability must not be able to approve.");
    const anonymous = await postJson(
      operator!.baseUrl, `/api/os/missions/${genericOsId}/approve`, null, { approvedBy: APPROVER });
    assert.equal(anonymous.status, 401);
    assert.equal(governorTaskIds(governorDataDir).length, 0, "A refused approval must not execute.");
    return {
      submitTokenStatus: withSubmit.status,
      anonymousStatus: anonymous.status,
      governorTaskCount: 0,
    };
  });

  const governorTerminal = await step(
    "Approve through the unified plane and create exactly one Governor task/loop",
    async () => {
      const approved = await postJson(
        operator!.baseUrl, `/api/os/missions/${genericOsId}/approve`, controlToken, { approvedBy: APPROVER });
      assert.equal(approved.status, 200, `Expected 200, got ${approved.status}: ${JSON.stringify(approved.body)}`);
      assertCanonicalOsShape(approved.body, "generic approve");
      assert.equal(approved.body.status, "completed");

      const authority = record(approved.body.authority);
      assert.equal(authority.approved, true);
      assert.equal(authority.approvedBy, APPROVER);
      assert.equal(authority.trusted, true);
      assert.equal(authority.refusalCode, null);
      assert.equal(authority.authorityRevision, head, "The approval must bind the exact committed HEAD.");
      assert.ok(text(authority.repositoryBinding).length > 0);

      const outcome = record(approved.body.outcome);
      assert.equal(outcome.evidenceStatus, "authoritative");
      assert.equal(outcome.typedError, null);
      const downstream = record(outcome.downstreamIdentity);
      assert.equal(downstream.kind, "loop_governor_manual_loop");
      assert.equal(downstream.created, true);

      // The task and loop genuinely exist in the isolated Loop Governor state.
      const taskIds = governorTaskIds(governorDataDir);
      assert.deepEqual(taskIds, [text(downstream.taskId)], "Exactly one Governor task must exist.");
      assert.equal(governorLoopCount(governorDataDir), 1, "Exactly one Governor loop must exist.");
      const taskJson = JSON.parse(
        readFileSync(path.join(governorDataDir, "tasks", text(downstream.taskId), "task.json"), "utf8"),
      ) as Record<string, unknown>;
      assert.ok(
        text(taskJson.scope).includes(`[chanter-mission:${genericMissionId}]`),
        "The Governor task must carry its exact mission marker.",
      );
      assert.equal(taskJson.loop_id, downstream.loopId);

      observedIds.governorTaskId = downstream.taskId;
      observedIds.governorLoopId = downstream.loopId;
      observedIds.genericAuthorityRevision = authority.authorityRevision;

      return {
        httpStatus: approved.status,
        status: approved.body.status,
        laneState: approved.body.laneState,
        approvedBy: authority.approvedBy,
        authorityRevision: authority.authorityRevision,
        repositoryBinding: authority.repositoryBinding,
        evidenceStatus: outcome.evidenceStatus,
        evidenceReference: outcome.evidenceReference,
        replayOutcome: outcome.replayOutcome,
        taskId: downstream.taskId,
        loopId: downstream.loopId,
        governorTaskCount: taskIds.length,
        governorLoopCount: 1,
        realAgentExecution: false,
      };
    },
  );

  // =========================================================================
  // Scenario B — Platform AutoPoster command
  // =========================================================================
  currentScenario = "B/autoposter";

  const platformSubmitted = await step(
    "Submit one Platform AutoPoster mission through the unified OS intake",
    async () => {
      const created = await postJson(
        operator!.baseUrl, "/api/os/missions", submitToken, platformCommand());
      assert.equal(created.status, 201, `Expected 201, got ${created.status}: ${JSON.stringify(created.body)}`);
      assertCanonicalOsShape(created.body, "platform submit");
      const identity = record(created.body.identity);
      assert.equal(identity.osMissionId, platformOsId);
      assert.equal(identity.lane, "platform_autoposter_command");
      assert.equal(created.body.status, "approval_required");

      const laneReference = record(created.body.laneReference);
      assert.match(text(laneReference.graphHash), /^[0-9a-f]{64}$/);
      assert.equal(boundary.accountValidationCalls, 1, "Submission validates the connected account exactly once.");
      assert.equal(boundary.scheduleContractCalls, 0, "Submission must not schedule anything.");
      assert.equal(boundary.posts.length, 0, "Submission must not create a draft.");
      observedIds.platformGraphId = laneReference.graphId;
      observedIds.platformGraphHash = laneReference.graphHash;
      observedIds.platformCommandHash = identity.payloadHash;

      return {
        httpStatus: created.status,
        osMissionId: identity.osMissionId,
        lane: identity.lane,
        status: created.body.status,
        graphId: laneReference.graphId,
        graphHash: laneReference.graphHash,
        commandHash: identity.payloadHash,
        accountValidationCalls: 1,
        draftsAfterSubmit: 0,
      };
    },
  );
  const graphHash = text(record(platformSubmitted).graphHash);

  await step("Observe approval_required for the Platform lane before any draft exists", async () => {
    const read = await getJson(operator!.baseUrl, `/api/os/missions/${platformOsId}`);
    assert.equal(read.status, 200);
    assert.equal(read.body.status, "approval_required");
    const outcome = record(read.body.outcome);
    assert.deepEqual(outcome.nextPermittedActions, ["approve"]);
    assert.equal(outcome.downstreamIdentity, null, "No downstream identity may exist before execution.");
    const capability = record(read.body.laneCapability);
    assert.equal(capability.approvalRequirement, "operator_control_approval_bound_to_graph_hash");
    assert.equal(capability.executionScope, "autoposter_unapproved_draft_only");
    return {
      status: read.body.status,
      laneState: read.body.laneState,
      approvalRequirement: capability.approvalRequirement,
      executionScope: capability.executionScope,
      downstreamIdentity: null,
    };
  });

  await step("Refuse Platform execution without the independent control capability", async () => {
    const withSubmit = await postJson(
      operator!.baseUrl, `/api/os/missions/${platformOsId}/approve`, submitToken, { graphHash });
    assert.equal(withSubmit.status, 401, "The submit capability must not be able to approve.");
    const anonymous = await postJson(
      operator!.baseUrl, `/api/os/missions/${platformOsId}/approve`, null, { graphHash });
    assert.equal(anonymous.status, 401);
    const wrongHash = await postJson(
      operator!.baseUrl, `/api/os/missions/${platformOsId}/approve`, controlToken, { graphHash: "0".repeat(64) });
    assert.equal(wrongHash.status, 409, "A mismatched graph hash must be refused.");
    assert.equal(wrongHash.body.code, "OPERATOR_GRAPH_APPROVAL_HASH_MISMATCH");
    assert.equal(boundary.scheduleContractCalls, 0);
    assert.equal(boundary.posts.length, 0);
    return {
      submitTokenStatus: withSubmit.status,
      anonymousStatus: anonymous.status,
      wrongHashStatus: wrongHash.status,
      wrongHashCode: wrongHash.body.code,
      draftsAfterRefusals: 0,
    };
  });

  const platformTerminal = await step(
    "Approve through the unified plane and create exactly one unapproved AutoPoster draft",
    async () => {
      const approved = await postJson(
        operator!.baseUrl, `/api/os/missions/${platformOsId}/approve`, controlToken, { graphHash });
      assert.equal(approved.status, 200, `Expected 200, got ${approved.status}: ${JSON.stringify(approved.body)}`);
      assertCanonicalOsShape(approved.body, "platform approve");
      assert.equal(approved.body.status, "completed");

      const outcome = record(approved.body.outcome);
      assert.equal(outcome.evidenceStatus, "authoritative");
      assert.equal(outcome.typedError, null);
      const downstream = record(outcome.downstreamIdentity);
      assert.equal(downstream.kind, "autoposter_unapproved_draft");
      assert.equal(downstream.publicationApprovalState, "human_required");
      const jobIds = downstream.jobIds as string[];
      assert.equal(jobIds.length, 1, "Exactly one queue job must exist.");

      const authority = record(approved.body.authority);
      assert.equal(authority.approved, true);
      assert.equal(authority.trusted, true);
      assert.equal(authority.authorityRevision, head);

      // The real AutoPoster application service was called exactly once, and
      // the durable product record is one unapproved, unpublished draft.
      assert.equal(boundary.scheduleContractCalls, 1);
      assert.equal(boundary.durableCreateCalls, 1);
      assert.equal(boundary.posts.length, 1);
      assert.equal(boundary.providerPublishCalls, 0, "No provider publish path may be invoked.");
      const draft = boundary.posts[0]!;
      assert.equal(draft.id, jobIds[0]);
      assert.equal(draft.approved, false);
      assert.equal(draft.approvalState, "unapproved");
      assert.equal(draft.status, "scheduled");
      assert.equal(draft.privacyLevel, "SELF_ONLY");

      observedIds.autoPosterJobId = jobIds[0];
      observedIds.autoPosterCampaignId = downstream.campaignId;
      observedIds.autoPosterApprovalId = downstream.approvalId;
      observedIds.platformAuthorityRevision = authority.authorityRevision;

      return {
        httpStatus: approved.status,
        status: approved.body.status,
        laneState: approved.body.laneState,
        evidenceStatus: outcome.evidenceStatus,
        evidenceReference: outcome.evidenceReference,
        replayOutcome: outcome.replayOutcome,
        jobIds,
        campaignId: downstream.campaignId,
        approvalId: downstream.approvalId,
        evidenceBundleId: downstream.evidenceBundleId,
        publicationApprovalState: downstream.publicationApprovalState,
        scheduleContractCalls: 1,
        durableCreateCalls: 1,
        draftCount: 1,
        providerPublishCalls: 0,
        draftApproved: false,
        draftStatus: draft.status,
      };
    },
  );

  // =========================================================================
  // Restart 1 -> Scenario A replay and conflict
  // =========================================================================
  currentScenario = "A/governor";

  await step("Restart the Operator process abruptly against the same durable state", async () => {
    await killOperator(operator!);
    operator = await startOperator(environment, await freePort());
    assert.notEqual(operator.pid, firstPid, "A genuinely new process must serve the replay.");
    observedIds.secondOperatorPid = operator.pid;
    return { killedPid: firstPid, restartedPid: operator.pid, sameDurableState: true };
  });

  await step("Replay the generic mission after restart with no duplicate task or loop", async () => {
    const resubmitted = await postJson(
      operator!.baseUrl, "/api/os/missions", submitToken, genericEnvelope());
    assert.equal(resubmitted.status, 200, "A duplicate submission must return the same durable identity.");
    assert.equal(resubmitted.body.replayed, true);
    assert.equal(record(resubmitted.body.identity).osMissionId, genericOsId);

    const read = await getJson(operator!.baseUrl, `/api/os/missions/${genericOsId}`);
    assert.equal(read.status, 200);
    assert.equal(read.body.status, "completed");
    const downstream = record(record(read.body.outcome).downstreamIdentity);
    assert.equal(downstream.taskId, governorTerminal.taskId, "Replay must return the same task identity.");
    assert.equal(downstream.loopId, governorTerminal.loopId, "Replay must return the same loop identity.");

    const taskIds = governorTaskIds(governorDataDir);
    assert.deepEqual(taskIds, [String(governorTerminal.taskId)], "Replay must not create a second task.");
    assert.equal(governorLoopCount(governorDataDir), 1, "Replay must not create a second loop.");

    return {
      resubmitStatus: resubmitted.status,
      replayed: resubmitted.body.replayed,
      taskId: downstream.taskId,
      loopId: downstream.loopId,
      governorTaskCount: taskIds.length,
      governorLoopCount: 1,
    };
  });

  await step("Refuse the same generic identity carrying a changed payload", async () => {
    const conflicting = await postJson(
      operator!.baseUrl,
      "/api/os/missions",
      submitToken,
      genericEnvelope({
        input: { ...genericEnvelopeInput, goal: "A different goal that changes the exact payload hash." },
      }),
    );
    assert.equal(conflicting.status, 409, `Expected 409, got ${conflicting.status}.`);
    assert.equal(conflicting.body.code, "OPERATOR_MISSION_PAYLOAD_MISMATCH");
    assert.deepEqual(governorTaskIds(governorDataDir), [String(governorTerminal.taskId)]);
    assert.equal(governorLoopCount(governorDataDir), 1);
    return {
      httpStatus: conflicting.status,
      code: conflicting.body.code,
      governorTaskCount: 1,
      governorLoopCount: 1,
    };
  });

  // =========================================================================
  // Restart 2 -> Scenario B replay and conflict
  // =========================================================================
  currentScenario = "B/autoposter";

  await step("Restart the Operator process again against the same durable state", async () => {
    const previousPid = operator!.pid;
    await killOperator(operator!);
    operator = await startOperator(environment, await freePort());
    assert.notEqual(operator.pid, previousPid, "A genuinely new process must serve the replay.");
    observedIds.thirdOperatorPid = operator.pid;
    return { killedPid: previousPid, restartedPid: operator.pid, sameDurableState: true };
  });

  await step("Replay the Platform mission after restart with no duplicate draft", async () => {
    const resubmitted = await postJson(
      operator!.baseUrl, "/api/os/missions", submitToken, platformCommand());
    assert.equal(resubmitted.status, 200, "A duplicate submission must return the same durable identity.");
    assert.equal(resubmitted.body.replayed, true);
    assert.equal(record(resubmitted.body.identity).osMissionId, platformOsId);

    const reapproved = await postJson(
      operator!.baseUrl, `/api/os/missions/${platformOsId}/approve`, controlToken, { graphHash });
    assert.equal(reapproved.status, 200);
    assert.equal(reapproved.body.replayed, true);
    assert.equal(reapproved.body.status, "completed");
    const downstream = record(record(reapproved.body.outcome).downstreamIdentity);
    assert.deepEqual(downstream.jobIds, platformTerminal.jobIds, "Replay must return the same job identity.");
    assert.equal(downstream.campaignId, platformTerminal.campaignId);
    assert.equal(downstream.approvalId, platformTerminal.approvalId);
    assert.equal(record(reapproved.body.laneReference).graphHash, graphHash);

    assert.equal(boundary.scheduleContractCalls, 1, "Replay must not call the schedule contract again.");
    assert.equal(boundary.durableCreateCalls, 1, "Replay must not create a second durable draft.");
    assert.equal(boundary.posts.length, 1);
    assert.equal(boundary.providerPublishCalls, 0);

    return {
      resubmitStatus: resubmitted.status,
      replayed: reapproved.body.replayed,
      jobIds: downstream.jobIds,
      campaignId: downstream.campaignId,
      scheduleContractCalls: 1,
      durableCreateCalls: 1,
      draftCount: 1,
      providerPublishCalls: 0,
    };
  });

  await step("Refuse the same Platform identity carrying a changed payload", async () => {
    const conflicting = await postJson(
      operator!.baseUrl,
      "/api/os/missions",
      submitToken,
      platformCommand({ caption: "A different caption that changes the canonical command bytes." }),
    );
    assert.equal(conflicting.status, 409, `Expected 409, got ${conflicting.status}.`);
    assert.equal(conflicting.body.code, "PLATFORM_COMMAND_PAYLOAD_MISMATCH");
    assert.equal(boundary.durableCreateCalls, 1, "A refused payload must not create a draft.");
    assert.equal(boundary.posts.length, 1);
    return {
      httpStatus: conflicting.status,
      code: conflicting.body.code,
      durableCreateCalls: 1,
      draftCount: 1,
    };
  });

  // =========================================================================
  // Scenario C — unified observation
  // =========================================================================
  currentScenario = "C/unified";

  await step("Return exactly both OS missions from the one canonical list", async () => {
    const listed = await getJson(operator!.baseUrl, "/api/os/missions");
    assert.equal(listed.status, 200);
    const missions = listed.body.missions as Array<Record<string, unknown>>;
    const ids = missions.map((mission) => text(record(mission.identity).osMissionId)).sort();
    assert.deepEqual(ids, [genericOsId, platformOsId].sort(), "The list must contain exactly both OS missions.");

    // The AutoPoster mission owned by the Platform command must not also
    // surface as a direct-lane mission: one downstream draft, one OS identity.
    assert.equal(new Set(ids).size, 2, "No cross-lane identity collision may exist.");
    for (const mission of missions) {
      assertCanonicalOsShape(mission, `list entry ${text(record(mission.identity).osMissionId)}`);
      assert.equal(mission.status, "completed");
      assert.equal(record(mission.outcome).evidenceStatus, "authoritative");
      assert.ok(record(mission.outcome).downstreamIdentity, "Each lane must expose downstream identity.");
      assert.equal(record(mission.authority).approved, true);
      assert.equal(record(mission.authority).authorityRevision, head);
    }

    // Nothing leaks the disposable working path into the read model.
    assert.equal(
      JSON.stringify(listed.body).includes(temporaryRoot),
      false,
      "No temporary path may leak into the unified read model.",
    );

    return {
      httpStatus: listed.status,
      missionCount: missions.length,
      osMissionIds: ids,
      distinctIdentities: new Set(ids).size,
      temporaryPathLeak: false,
    };
  });

  await step("Filter the canonical list deterministically by lane, status, and workspace", async () => {
    const byGeneric = await getJson(
      operator!.baseUrl, "/api/os/missions?lane=generic_governed_task");
    const byPlatform = await getJson(
      operator!.baseUrl, "/api/os/missions?lane=platform_autoposter_command");
    const byDirect = await getJson(
      operator!.baseUrl, "/api/os/missions?lane=autoposter_direct_mission");
    const byWorkspace = await getJson(
      operator!.baseUrl, `/api/os/missions?workspaceId=${TENANT_ID}`);
    const byPendingStatus = await getJson(
      operator!.baseUrl, "/api/os/missions?status=approval_required");
    const byApproval = await getJson(operator!.baseUrl, "/api/os/missions?approvalState=approved");
    const invalidFilter = await getJson(operator!.baseUrl, "/api/os/missions?lane=not_a_lane");

    const ids = (result: HttpResult) =>
      (result.body.missions as Array<Record<string, unknown>>)
        .map((mission) => text(record(mission.identity).osMissionId));

    assert.deepEqual(ids(byGeneric), [genericOsId]);
    assert.deepEqual(ids(byPlatform), [platformOsId]);
    assert.deepEqual(
      ids(byDirect),
      [],
      "The Platform command's child mission must not appear as a direct AutoPoster mission.",
    );
    assert.deepEqual(ids(byWorkspace), [platformOsId]);
    assert.deepEqual(ids(byPendingStatus), [], "Both missions are completed, so none is approval_required.");
    assert.deepEqual(ids(byApproval).sort(), [genericOsId, platformOsId].sort());
    assert.equal(invalidFilter.status, 400);
    assert.equal(invalidFilter.body.code, "OS_MISSION_FILTER_INVALID");

    return {
      genericLane: ids(byGeneric),
      platformLane: ids(byPlatform),
      directLane: ids(byDirect),
      byWorkspace: ids(byWorkspace),
      byApprovalState: ids(byApproval).sort(),
      invalidFilterStatus: invalidFilter.status,
      invalidFilterCode: invalidFilter.body.code,
    };
  });

  await step("Refuse an unknown identity instead of falling through to another lane", async () => {
    const unknownGeneric = await getJson(
      operator!.baseUrl, `/api/os/missions/os:generic_governed_task:${platformCommandId()}`);
    assert.equal(unknownGeneric.status, 404, "A Platform id must not resolve inside the generic lane.");
    const unknownPlatform = await getJson(
      operator!.baseUrl, `/api/os/missions/os:platform_autoposter_command:${genericMissionId}`);
    assert.equal(unknownPlatform.status, 404, "A generic id must not resolve inside the Platform lane.");
    const malformed = await getJson(operator!.baseUrl, "/api/os/missions/not-an-os-identity");
    assert.equal(malformed.status, 400);
    assert.equal(malformed.body.code, "OS_MISSION_IDENTITY_INVALID");
    const unregisteredLane = await getJson(operator!.baseUrl, "/api/os/missions/os:no_such_lane:abc");
    assert.equal(unregisteredLane.status, 400);
    assert.equal(unregisteredLane.body.code, "OS_MISSION_IDENTITY_INVALID");

    return {
      crossLaneGenericStatus: unknownGeneric.status,
      crossLanePlatformStatus: unknownPlatform.status,
      malformedStatus: malformed.status,
      malformedCode: malformed.body.code,
      unregisteredLaneStatus: unregisteredLane.status,
    };
  });

  await step("Refuse a control action through the owning lane authority, not an OS echo", async () => {
    // Both missions are completed, so no recovery action can advance them.
    // The unified plane adds no second gate: each refusal below is the typed
    // 409 raised by the lane authority that actually owns the decision.
    const resume = await postJson(
      operator!.baseUrl, `/api/os/missions/${genericOsId}/resume`, controlToken, {});
    assert.equal(resume.status, 409);
    assert.equal(resume.body.code, "RECOVERY_ACTION_NOT_PERMITTED");
    const reconcile = await postJson(
      operator!.baseUrl, `/api/os/missions/${genericOsId}/reconcile`, controlToken, {});
    assert.equal(reconcile.status, 409);
    assert.equal(reconcile.body.code, "RECOVERY_ACTION_NOT_PERMITTED");
    const stop = await postJson(
      operator!.baseUrl, `/api/os/missions/${platformOsId}/stop`, controlToken, { cancelledBy: APPROVER });
    assert.equal(stop.status, 409);
    assert.equal(stop.body.code, "OPERATOR_GRAPH_STATE_TERMINAL");

    // A refused control action changes nothing downstream.
    assert.equal(governorLoopCount(governorDataDir), 1);
    assert.equal(boundary.durableCreateCalls, 1);
    assert.equal(boundary.posts.length, 1);

    // And the advisory projection agrees that nothing can advance them.
    const generic = await getJson(operator!.baseUrl, `/api/os/missions/${genericOsId}`);
    const platform = await getJson(operator!.baseUrl, `/api/os/missions/${platformOsId}`);
    assert.deepEqual(record(generic.body.outcome).nextPermittedActions, []);
    assert.deepEqual(record(platform.body.outcome).nextPermittedActions, []);

    return {
      resumeStatus: resume.status,
      resumeCode: resume.body.code,
      reconcileStatus: reconcile.status,
      reconcileCode: reconcile.body.code,
      stopStatus: stop.status,
      stopCode: stop.body.code,
      genericNextPermittedActions: [],
      platformNextPermittedActions: [],
      governorLoopCount: 1,
      draftCount: 1,
    };
  });

  await step("Project the canonical lane/capability registry", async () => {
    const lanes = await getJson(operator!.baseUrl, "/api/os/lanes");
    assert.equal(lanes.status, 200);
    const registry = lanes.body.lanes as Array<Record<string, unknown>>;
    assert.deepEqual(registry.map((entry) => entry.lane), [
      "generic_governed_task",
      "platform_autoposter_command",
      "autoposter_direct_mission",
      "governed_agentic_mission",
    ]);
    const generic = registry.find((entry) => entry.lane === "generic_governed_task");
    const platform = registry.find((entry) => entry.lane === "platform_autoposter_command");
    const agentic = registry.find((entry) => entry.lane === "governed_agentic_mission");
    assert.equal(record(generic).downstreamOperationType, "loop_governor.task.create_manual_loop");
    assert.equal(record(generic).realExternalExecutionAllowed, false);
    assert.equal(record(platform).downstreamOperationType, "autoposter.queue.create_unapproved_draft");
    assert.equal(record(platform).approvalRequirement, "operator_control_approval_bound_to_graph_hash");
    // Every lane reports how its execution is realized. A dispatch lane reads
    // its downstream identity from the reviewed action registry; a plan-governed
    // lane has no single action to read one from and must declare its own.
    for (const entry of registry) {
      assert.ok(
        entry.executionModel === "downstream_product_action"
        || entry.executionModel === "governed_agentic_plan",
        `${String(entry.lane)} must declare a known execution model`,
      );
      assert.ok(
        String(entry.downstreamOperationType).length > 0,
        `${String(entry.lane)} must name a downstream operation type`,
      );
    }
    assert.equal(record(agentic).executionModel, "governed_agentic_plan");
    assert.equal(record(agentic).realExternalExecutionAllowed, false);
    assert.equal(
      record(agentic).approvalRequirement,
      "operator_control_approval_bound_to_plan_and_candidate_hash",
    );
    return {
      httpStatus: lanes.status,
      lanes: registry.map((entry) => entry.lane),
      executionModels: registry.map((entry) => entry.executionModel),
      genericDownstreamOperationType: record(generic).downstreamOperationType,
      platformDownstreamOperationType: record(platform).downstreamOperationType,
      agenticDownstreamOperationType: record(agentic).downstreamOperationType,
    };
  });

  await step("Keep every legacy lane-specific route working unchanged", async () => {
    const legacyMission = await getJson(
      operator!.baseUrl, `/api/runtime-missions/${genericMissionId}`);
    assert.equal(legacyMission.status, 200);
    assert.equal(legacyMission.body.status, "succeeded");
    const legacyCommands = await getJson(operator!.baseUrl, "/api/platform/autoposter-commands");
    assert.equal(legacyCommands.status, 200);
    assert.equal((legacyCommands.body.commands as unknown[]).length, 1);
    const legacyGraphs = await getJson(operator!.baseUrl, "/api/mission-graphs");
    assert.equal(legacyGraphs.status, 200);
    assert.equal((legacyGraphs.body.graphs as unknown[]).length, 1);
    return {
      legacyMissionStatus: legacyMission.status,
      legacyMissionState: legacyMission.body.status,
      legacyCommandCount: 1,
      legacyGraphCount: 1,
    };
  });

  verdict = "PASS";
} catch (error) {
  verdict = "FAIL";
  failure = error instanceof Error ? (error.stack ?? error.message) : String(error);
} finally {
  if (operator) await killOperator(operator);
  if (autoPoster) await autoPoster.stop().catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Machine-readable terminal result + evidence artifact
// ---------------------------------------------------------------------------

mkdirSync(outputDir, { recursive: true });

const terminalResult = {
  schema: "chanter.os.unified.result.v1",
  verdict,
  startedAt,
  completedAt: new Date().toISOString(),
  missionPath:
    "unified os intake -> canonical identity -> lane routing -> persisted human approval -> agent runtime -> "
    + "(loop governor manual loop | autoposter unapproved draft) -> durable evidence -> restart, replay, typed conflict",
  lanes: ["generic_governed_task", "platform_autoposter_command", "autoposter_direct_mission"],
  observedIds,
  realAgentExecution: false,
  providerPublication: false,
  steps,
  ...(failure ? { failure } : {}),
};

const resultPath = path.join(outputDir, "terminal-result.json");
writeFileSync(resultPath, `${JSON.stringify(terminalResult, null, 2)}\n`, "utf8");

const evidenceLines = [
  "# CHANTER OS — Unified Mission Control Plane Evidence",
  "",
  `- Verdict: **${verdict}**`,
  `- Started: ${terminalResult.startedAt}`,
  `- Completed: ${terminalResult.completedAt}`,
  `- Generic OS mission: \`${observedIds.genericOsMissionId}\``,
  `- Platform OS mission: \`${observedIds.platformOsMissionId}\``,
  `- Governor task / loop: \`${observedIds.governorTaskId ?? "(not observed)"}\` / \`${observedIds.governorLoopId ?? "(not observed)"}\``,
  `- AutoPoster job: \`${observedIds.autoPosterJobId ?? "(not observed)"}\``,
  `- Approval authority revision: \`${observedIds.approvalRepositoryHead}\``,
  "- Real coding-agent execution: frozen (`false`)",
  "- Provider publication: none (`false`)",
  "",
  "| # | Scenario | Step | Outcome |",
  "| --- | --- | --- | --- |",
  ...steps.map((entry) =>
    `| ${entry.step} | ${entry.scenario} | ${entry.name} | ${entry.outcome.toUpperCase()} |`),
  "",
  ...(failure ? ["## Failure", "", "```", failure, "```", ""] : []),
];
const evidencePath = path.join(outputDir, "unified-evidence.md");
writeFileSync(evidencePath, `${evidenceLines.join("\n")}\n`, "utf8");

if (!keepArtifacts) {
  try {
    rmSync(temporaryRoot, { recursive: true, force: true });
  } catch {
    // A disposable temp root Windows still holds open is inert.
  }
}

console.log("");
console.log(`Verdict: ${verdict}`);
console.log(`Terminal result: ${resultPath}`);
console.log(`Evidence: ${evidencePath}`);
if (keepArtifacts) console.log(`Retained working state: ${temporaryRoot}`);
if (failure) console.error(`\n${failure}`);

process.exit(verdict === "PASS" ? 0 : 1);
