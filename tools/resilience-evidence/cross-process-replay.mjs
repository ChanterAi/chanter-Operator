import { execFile, execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { AgentRunLedgerService } from "../../apps/backend/src/agentRunLedger/agentRunLedgerService.ts";
import { createDatabase } from "../../apps/backend/src/db/database.ts";
import { AutoPosterMissionService } from "../../apps/backend/src/runtimeMissions/autoPosterMissionService.ts";
import { createAutoPosterRuntimeMissionExecutor } from "../../apps/backend/src/runtimeMissions/autoPosterRuntime.ts";
import { missionScopedStateDir } from "../../apps/backend/src/runtimeMissions/persistedApprovalAuthority.ts";

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
      runtimeGraphId: defaults.runtimeGraphId,
      runtimeAction: defaults.runtimeAction,
      runtimePayloadHash: defaults.runtimePayloadHash,
      campaignId:
        defaults.campaignId
        || `autoposter-campaign:${defaults.runtimeMissionId || defaults.documentId}`,
      approvalId: defaults.approvalId,
      evidenceBundleId: defaults.evidenceBundleId,
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
        runtimeGraphId: body.graphId,
        runtimeAction: body.action,
        runtimePayloadHash: body.missionPayloadHash,
        soundMode: body.soundMode,
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
        runtimeGraphId: body.graphId,
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

function git(repositoryRoot, args) {
  return execFileSync("git", ["-C", repositoryRoot, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
  }).trim();
}

/**
 * The Runtime binds approval authority to a real repository identity, exact
 * committed HEAD, and a strictly clean worktree. This evidence run therefore
 * needs a real checkout; a disposable one keeps the binding honest without
 * dragging in managed-checkout lifecycle, which is proven separately.
 */
function disposableAuthorityRepository() {
  const repositoryRoot = path.join(root, "authority-repository");
  mkdirSync(repositoryRoot, { recursive: true });
  git(repositoryRoot, ["init", "--quiet"]);
  git(repositoryRoot, ["config", "user.name", "CHANTER Resilience Evidence"]);
  git(repositoryRoot, ["config", "user.email", "resilience-evidence@invalid.local"]);
  git(repositoryRoot, ["config", "commit.gpgsign", "false"]);
  writeFileSync(path.join(repositoryRoot, "AUTHORITY.md"), "cross-process replay evidence", "utf8");
  git(repositoryRoot, ["add", "--", "AUTHORITY.md"]);
  git(repositoryRoot, ["commit", "--quiet", "-m", "cross-process replay evidence"]);
  return repositoryRoot;
}

/**
 * One disposable Ed25519 issuer. The private key exists only as a mode-0600
 * temporary file inside this run's root and is deleted with it; the trust file
 * and everything crossing a process boundary carry public material only.
 */
function disposableIssuer() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const privateKeyFile = path.join(root, "issuer.key.pem");
  writeFileSync(privateKeyFile, privateKey.export({ type: "pkcs8", format: "pem" }).toString(), {
    encoding: "utf8",
    mode: 0o600,
  });
  const issuers = [{
    authorityId: "chanter.operator.resilience-evidence",
    authorizedPolicyIds: ["chanter.operator.human-approval.v1"],
    keys: [{
      keyId: "resilience-evidence-key-1",
      publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
    }],
  }];
  const trustedIssuersFile = path.join(root, "trusted-issuers.json");
  writeFileSync(trustedIssuersFile, JSON.stringify({ issuers }), "utf8");
  return {
    issuer: {
      authorityId: issuers[0].authorityId,
      keyId: issuers[0].keys[0].keyId,
      privateKeyFile,
    },
    trustedIssuersFile,
    /** Public-only trust material, safe to hand to a child process. */
    trustedIssuers: issuers,
  };
}

const authorityRepositoryRoot = disposableAuthorityRepository();
const { issuer, trustedIssuersFile, trustedIssuers } = disposableIssuer();
const approvalStateDir = path.join(root, "approval-authority");
const approvalAuthority = {
  stateDir: approvalStateDir,
  repositoryRoot: authorityRepositoryRoot,
  issuer,
  trustedIssuersFile,
  ownerId: "resilience-evidence-owner",
};

/** Adapter entries the Runtime durably recorded — measured, never inferred. */
async function adapterStartsFor(missionId, stateDir = approvalStateDir) {
  const runtime = await import(pathToFileURL(runtimeEntry).href);
  return runtime
    .createDurableMissionRunLedger({ stateDir })
    .listRunsByMission(missionId)
    .flatMap((run) => run.events)
    .filter((event) => event.type === "adapter_started")
    .length;
}

async function authorityEventsFor(missionId, stateDir = approvalStateDir) {
  const runtime = await import(pathToFileURL(runtimeEntry).href);
  return runtime
    .createDurableMissionRunLedger({ stateDir })
    .listRunsByMission(missionId)
    .flatMap((run) => run.events)
    .filter((event) => event.type.startsWith("approval_authority_"));
}

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
    // Required by the service contract. Omitting it is what made this tool
    // crash in `createScheduleMission` long before the approval contract.
    agentRunLedgerService: new AgentRunLedgerService(database),
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
  // The exact request this mission is durably bound to, read back from Operator
  // rather than hand-assembled, so the payload hash the checkpoint binds is the
  // one the children execute.
  const runtimeRequest = service.runtimeRequestFor(mission.missionId);

  // Publish the checkpoint and an Ed25519-signed approval observation through
  // the canonical issuer boundary. This is the only signing step in the run.
  const issuingExecutor = createAutoPosterRuntimeMissionExecutor({
    baseUrl,
    serviceToken: token,
    userId: "owner",
    timeoutValid: true,
    timeoutMs: 5000,
    approvalAuthority,
  });
  const prepared = await issuingExecutor.prepareApproval(runtimeRequest, {
    approverId: "founder",
    note: "Founder approval published as signed persisted authority.",
    observedAt: new Date().toISOString(),
  });
  if (!prepared.ok) {
    throw new Error(`Signed approval authority could not be published: ${prepared.code} ${prepared.message}`);
  }
  const signedAuthority = prepared.authority;
  const runtimeModule = await import(pathToFileURL(runtimeEntry).href);
  const approvalStore = runtimeModule.createDurableIdempotencyStore({ stateDir: approvalStateDir });
  const signedObservation = approvalStore.getApprovalObservation(mission.missionId);
  if (!signedObservation?.authenticity?.signature) {
    throw new Error("The published approval observation carries no issuer signature.");
  }
  // Captured before the process boundary so the post-restart comparison is
  // against bytes that existed before any child ran.
  const signatureBeforeRestart = signedObservation.authenticity.signature;
  const observationHashBeforeRestart = signedObservation.observationHash;
  const issuerBeforeRestart = {
    issuerAuthorityId: signedObservation.authenticity.issuerAuthorityId,
    issuerKeyId: signedObservation.authenticity.issuerKeyId,
    scheme: signedObservation.authenticity.scheme,
  };
  const downstreamCreatesAfterIssuance = createAttempts;

  database.close();
  database = undefined;


  // Each child is a genuinely independent OS process that reconstructs the
  // durable store, the run ledger, and an explicit trust store built from
  // public key material only, then resumes with the exact persisted authority.
  // It never signs, re-authors, or repairs approval state.
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
const store = runtime.createDurableIdempotencyStore({ stateDir: config.stateDir });
const observationBefore = store.getApprovalObservation(config.request.missionId);
const result = await runtime.executeMission(config.request, {
  registry,
  idempotencyStore: store,
  runLedger: runtime.createDurableMissionRunLedger({ stateDir: config.stateDir }),
  approvalAuthority: config.approvalAuthority,
  approvalTrustStore: runtime.createRuntimeApprovalTrustStore(config.trustedIssuers)
});
const observationAfter = store.getApprovalObservation(config.request.missionId);
process.stdout.write(JSON.stringify({
  pid: process.pid,
  result,
  signatureSeen: observationBefore?.authenticity?.signature ?? null,
  signatureAfter: observationAfter?.authenticity?.signature ?? null
}));
`;
  const childConfig = JSON.stringify({
    runtimeEntry: pathToFileURL(runtimeEntry).href,
    baseUrl,
    token,
    stateDir: approvalStateDir,
    request: runtimeRequest,
    approvalAuthority: signedAuthority,
    // Public verification material only. No private key crosses this boundary.
    trustedIssuers,
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
      approvalAuthority,
    }),
    { agentRunLedgerService: new AgentRunLedgerService(database) },
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
  // Convergence now allows the losing child to carry no queue id at all.
  // Before signed authority the two callers used *separate in-memory* stores,
  // so both reached the downstream boundary and the loser was deduplicated
  // there, always returning the same queue id as `duplicate`. They now share
  // one durable claim, so the loser is refused *before* the adapter and
  // truthfully returns no queue id. Convergence therefore means: at least one
  // caller produced a queue id, and every caller that produced one produced
  // the authoritative one. This is a strictly stronger outcome — the duplicate
  // is stopped a boundary earlier — and the assertion was widened only to
  // describe it, never to accept divergence.
  const producedQueueIds = queueIds.filter((value) => value !== null);
  const callersConverged = producedQueueIds.length >= 1
    && producedQueueIds.every((value) => value === queueId);
  const noSplitBrain = callersConverged
    && finalMission.status === finalMission.runtimeResult?.status
    && persistedTransitions.length === 1
    && completedTransitions.length === 1
    && journal.at(-1)?.newState === "completed";

  // Exactly one caller may execute. The other is either a durable replay of the
  // completed record or a refusal because the winner held the claim; both mean
  // "did not execute a second time".
  const succeededCallers = statuses.filter((status) => status === "succeeded");
  const nonExecutingCallers = statuses.filter(
    (status) => status === "duplicate" || status === "unavailable",
  );
  const exactlyOneExecutingCaller = succeededCallers.length === 1
    && nonExecutingCallers.length === callers.length - 1;

  // Authenticity, measured rather than assumed.
  const adapterStarts = await adapterStartsFor(mission.missionId);
  const authorityEvents = await authorityEventsFor(mission.missionId);
  const acceptedAuthorityDecisions = authorityEvents
    .filter((event) => event.type === "approval_authority_accepted");
  const observationAfterRestart = runtimeModule
    .createDurableIdempotencyStore({ stateDir: approvalStateDir })
    .getApprovalObservation(mission.missionId);
  const signatureUnchanged = observationAfterRestart?.authenticity?.signature === signatureBeforeRestart
    && observationAfterRestart?.observationHash === observationHashBeforeRestart
    && observationAfterRestart?.authenticity?.issuerAuthorityId === issuerBeforeRestart.issuerAuthorityId
    && observationAfterRestart?.authenticity?.issuerKeyId === issuerBeforeRestart.issuerKeyId
    && observationAfterRestart?.authenticity?.scheme === issuerBeforeRestart.scheme;
  // Every child observed the identical signature on both sides of its own run,
  // so no process re-signed, regenerated, or replaced the approval.
  const childrenSawSameSignature = callers.every(
    (caller) => caller.signatureSeen === signatureBeforeRestart
      && caller.signatureAfter === signatureBeforeRestart,
  );

  const validReplayPassed = new Set(callers.map(({ pid }) => pid)).size === 2
    && createAttempts === 1
    && jobs.length === 1
    && Boolean(queueId)
    && Math.max(0, jobs.length - 1) === 0
    && exactlyOneExecutingCaller
    && adapterStarts === 1
    && acceptedAuthorityDecisions.length === 1
    && signatureUnchanged
    && childrenSawSameSignature
    && downstreamCreatesAfterIssuance === 0
    && oneEvidenceChain
    && noSplitBrain
    && jobs[0].approved === false
    && providerEndpointInvocations === 0;
  // ---------------------------------------------------------------------
  // Focused negative proof: the same replay path, one unsigned approval.
  //
  // Deliberately minimal — the broad authenticity matrix lives in the two
  // focused suites. This exists only to prove that *this* evidence tool
  // consumes the real contract instead of bypassing it.
  // ---------------------------------------------------------------------
  const unsignedStateDir = path.join(root, "approval-authority-unsigned");
  const unsignedMissionId = `${mission.missionId}-unsigned`;
  const unsignedRequest = {
    ...runtimeRequest,
    missionId: unsignedMissionId,
    idempotencyKey: `${mission.idempotencyKey}-unsigned`,
  };
  const unsignedIdentity = {
    ...signedAuthority,
    checkpointId: `checkpoint:${unsignedMissionId}`,
    approvalRequestId: `approval:${unsignedMissionId}`,
    evidenceReferences: [{
      evidenceId: `operator-mission-payload:${unsignedMissionId}`,
      kind: "operator-mission-payload",
      sha256: runtimeModule.createRuntimeMissionPayloadHash(unsignedRequest),
    }],
    manifestHash: undefined,
    observationHash: undefined,
  };
  const unsignedStore = runtimeModule.createDurableIdempotencyStore({ stateDir: unsignedStateDir });
  const unsignedLedger = runtimeModule.createDurableMissionRunLedger({ stateDir: unsignedStateDir });
  const unsignedRegistry = runtimeModule.createMissionAdapterRegistry([
    runtimeModule.createAutoPosterMissionAdapter(
      runtimeModule.createAutoPosterHttpPort({ baseUrl, serviceToken: token, timeoutMs: 5000 }),
    ),
  ]);
  const unsignedTrustStore = runtimeModule.createRuntimeApprovalTrustStore(trustedIssuers);
  const unsignedPending = await runtimeModule.executeMission(unsignedRequest, {
    registry: unsignedRegistry,
    idempotencyStore: unsignedStore,
    runLedger: unsignedLedger,
    approvalAuthority: unsignedIdentity,
    approvalTrustStore: unsignedTrustStore,
  });
  if (unsignedPending.status !== "approval_required") {
    throw new Error(`Unsigned scenario checkpoint was not published: ${unsignedPending.status}`);
  }
  const unsignedManifest = unsignedStore.getApprovalCheckpointManifest(unsignedMissionId);
  // A state-directory writer with no signing key authors a structurally
  // perfect, correctly hashed, correctly bound approval.
  const unsignedObservation = runtimeModule.createRuntimeApprovalObservation({
    approvalRequestId: unsignedManifest.approvalRequestId,
    checkpointId: unsignedManifest.checkpointId,
    missionId: unsignedManifest.missionId,
    operationId: unsignedManifest.operationId,
    action: unsignedManifest.action,
    stepId: unsignedManifest.stepId,
    repositoryId: unsignedManifest.repositoryId,
    expectedHead: unsignedManifest.expectedHead,
    approvalPolicyId: unsignedManifest.approvalPolicyId,
    status: "approved",
    approverId: "unsigned-writer",
    note: "authored directly in durable storage without a signing key",
    evidenceReferences: unsignedManifest.evidenceReferences,
    checkpointManifestHash: unsignedManifest.manifestHash,
    observedAt: new Date().toISOString(),
  });
  if (unsignedObservation.authenticity !== undefined) {
    throw new Error("The unsigned scenario observation unexpectedly carries authenticity.");
  }
  unsignedStore.persistApprovalObservation(unsignedObservation);
  const downstreamCreatesBeforeUnsignedChild = createAttempts;
  const unsignedChildConfig = JSON.stringify({
    runtimeEntry: pathToFileURL(runtimeEntry).href,
    baseUrl,
    token,
    stateDir: unsignedStateDir,
    request: unsignedRequest,
    approvalAuthority: {
      ...unsignedIdentity,
      manifestHash: unsignedManifest.manifestHash,
      observationHash: unsignedObservation.observationHash,
    },
    trustedIssuers,
  });
  const unsignedChild = JSON.parse(
    (await execFileAsync(
      process.execPath,
      ["--input-type=module", "--eval", childSource, unsignedChildConfig],
      { cwd: appsRoot, windowsHide: true },
    )).stdout,
  );
  const unsignedRefusalCode = unsignedChild.result.errors?.[0]?.code ?? null;
  const unsignedAdapterStarts = await adapterStartsFor(unsignedMissionId, unsignedStateDir);
  const unsignedRefusalEvents = runtimeModule
    .createDurableMissionRunLedger({ stateDir: unsignedStateDir })
    .listRunsByMission(unsignedMissionId)
    .flatMap((run) => run.events)
    .filter((event) => event.detail?.code === "RUNTIME_APPROVAL_AUTHENTICITY_MISSING");
  const unsignedFailedClosed = unsignedRefusalCode === "RUNTIME_APPROVAL_AUTHENTICITY_MISSING"
    && unsignedAdapterStarts === 0
    && unsignedRefusalEvents.length >= 1
    && createAttempts === downstreamCreatesBeforeUnsignedChild
    // The refusal never repaired or re-signed the persisted approval.
    && unsignedStore.getApprovalObservation(unsignedMissionId)?.authenticity === undefined;

  // The run is evidence only if both halves hold: the authentic replay
  // executed exactly once, and the unsigned replay executed not at all.
  const passed = validReplayPassed && unsignedFailedClosed;

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
    callersConverged,
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
    // Signed-approval-authority evidence, all measured from durable state.
    approvalIssuerAuthorityId: issuerBeforeRestart.issuerAuthorityId,
    approvalIssuerKeyId: issuerBeforeRestart.issuerKeyId,
    approvalAuthenticityScheme: issuerBeforeRestart.scheme,
    approvalObservationHash: observationHashBeforeRestart,
    approvalSignatureSha256: createHash("sha256").update(signatureBeforeRestart).digest("hex"),
    approvalSignatureUnchangedAcrossRestart: signatureUnchanged,
    childrenObservedIdenticalSignature: childrenSawSameSignature,
    downstreamCreatesDuringIssuance: downstreamCreatesAfterIssuance,
    measuredAdapterStarts: adapterStarts,
    acceptedAuthorityDecisions: acceptedAuthorityDecisions.length,
    authorityDecisionEvidenceHashes: acceptedAuthorityDecisions
      .map((event) => event.approvalAuthority?.evidenceHash ?? null),
    // Operator's "resume safely" re-materializes the already-observed result
    // through a no-side-effect adapter in its own claim scope. Reported
    // separately so the single main-scope adapter start is not mistaken for
    // "no adapter was ever entered again anywhere".
    recoveredScopeAdapterStarts: await adapterStartsFor(
      mission.missionId,
      missionScopedStateDir(approvalStateDir, "recovered-missions", mission.missionId),
    ),
    validReplayVerdict: validReplayPassed ? "PASS" : "FAIL",
    // Focused negative proof: same replay path, unsigned persisted approval.
    unsignedReplayVerdict: unsignedFailedClosed ? "PASS" : "FAIL",
    unsignedReplayRefusalCode: unsignedRefusalCode,
    unsignedReplayAdapterStarts: unsignedAdapterStarts,
    unsignedReplayDurableRefusalEvents: unsignedRefusalEvents.length,
    unsignedReplayStayedUnsigned:
      unsignedStore.getApprovalObservation(unsignedMissionId)?.authenticity === undefined,
  }, null, 2));
  if (!passed) process.exitCode = 1;
} finally {
  if (database) database.close();
  await new Promise((resolve) => server.close(resolve));
  rmSync(root, { recursive: true, force: true });
}
