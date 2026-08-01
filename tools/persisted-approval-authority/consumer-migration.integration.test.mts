/**
 * Cross-repository controlled integration proof for the persisted approval
 * authority consumer migration.
 *
 * Real, not mocked:
 *   - chanter-Operator services and durable SQLite mission spine;
 *   - chanter-agent-runtime `executeMission`, durable claim store, durable run
 *     ledger, and the authoritative pre-adapter approval guard;
 *   - chanter-loop.governor running as a real `python -m governor.mission_intake`
 *     child process against a disposable data directory;
 *   - a real Git checkout supplying repository identity, committed HEAD, and
 *     clean state for the approval binding.
 *
 * The only substituted boundary is the AutoPoster queue port, replaced by a
 * faithful no-side-effect adapter that records every entry. Nothing here
 * publishes content or mutates production state.
 *
 * `adapter_started` is counted from the durable run ledger, so "exactly once"
 * is measured rather than inferred.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";

import {
  FakeTemporalClock,
  createDurableIdempotencyStore,
  createDurableMissionRunLedger,
  createInMemoryIdempotencyStore,
  createMissionAdapterRegistry,
  createLoopGovernorMissionAdapter,
  createLoopGovernorProcessPort,
  executeMission,
  type AutoPosterOperationsPort,
  type AutoPosterScheduleParams,
  type RuntimeMissionRequest,
} from "chanter-agent-runtime";

import { AgentRunLedgerService } from "../../apps/backend/src/agentRunLedger/agentRunLedgerService.js";
import { createDatabase } from "../../apps/backend/src/db/database.js";
import { GenericMissionService } from "../../apps/backend/src/missions/genericMissionService.js";
import { createLoopGovernorMissionExecutor } from "../../apps/backend/src/missions/loopGovernorRuntime.js";
import { AutoPosterMissionService } from "../../apps/backend/src/runtimeMissions/autoPosterMissionService.js";
import { createAutoPosterRuntimeMissionExecutor } from "../../apps/backend/src/runtimeMissions/autoPosterRuntime.js";
import type { OperatorApprovalAuthorityConfiguration } from "../../apps/backend/src/runtimeMissions/persistedApprovalAuthority.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const operatorRoot = path.resolve(here, "../..");
const LOOP_GOVERNOR_ROOT = path.resolve(operatorRoot, "../chanter-loop.governor");
/**
 * The Runtime's process port only accepts an absolute, fixed executable, so a
 * bare `python` on PATH is resolved once here rather than relaxing that rule.
 */
function resolvePython(): string {
  const configured = process.env.LOOP_GOVERNOR_PYTHON?.trim();
  if (configured && path.isAbsolute(configured)) return configured;
  const locator = process.platform === "win32" ? "where" : "which";
  const found = execFileSync(locator, [configured || "python"], {
    encoding: "utf8",
    windowsHide: true,
  })
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0 && path.isAbsolute(line));
  if (!found) throw new Error("No absolute Python executable is available for the proof.");
  return found;
}

const PYTHON = resolvePython();

const APPROVER = "founder";
const APPROVAL_INSTANT = "2026-08-01T00:00:00.000Z";
const APPROVAL_MS = Date.parse(APPROVAL_INSTANT);
const EXPIRY_INSTANT = new Date(APPROVAL_MS + 60_000).toISOString();

const disposableRoots: string[] = [];
after(() => {
  for (const root of disposableRoots.splice(0)) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // A temp root Windows still holds open is inert.
    }
  }
});

function disposableRoot(prefix: string): string {
  const root = mkdtempSync(path.join(os.tmpdir(), prefix));
  disposableRoots.push(root);
  return root;
}

function git(repositoryRoot: string, args: readonly string[]): void {
  execFileSync("git", ["-C", repositoryRoot, ...args], {
    stdio: "ignore",
    windowsHide: true,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
  });
}

/** One clean committed checkout: the repository identity approvals bind to. */
function approvalRepository(): string {
  const repositoryRoot = disposableRoot("chanter-migration-repo-");
  git(repositoryRoot, ["init", "--quiet"]);
  git(repositoryRoot, ["config", "user.name", "CHANTER Migration Proof"]);
  git(repositoryRoot, ["config", "user.email", "migration-proof@invalid.local"]);
  git(repositoryRoot, ["config", "commit.gpgsign", "false"]);
  writeFileSync(path.join(repositoryRoot, "APPROVAL.md"), "controlled integration proof\n", "utf8");
  git(repositoryRoot, ["add", "--", "APPROVAL.md"]);
  git(repositoryRoot, ["commit", "--quiet", "-m", "controlled integration proof"]);
  return repositoryRoot;
}

interface Universe {
  root: string;
  databasePath: string;
  approvalAuthority: OperatorApprovalAuthorityConfiguration;
  loopDataDir: string;
}

function createUniverse(label: string, repositoryRoot: string): Universe {
  const root = disposableRoot(`chanter-migration-${label}-`);
  return {
    root,
    databasePath: path.join(root, "operator.sqlite"),
    approvalAuthority: {
      stateDir: path.join(root, "authority"),
      repositoryRoot,
      ownerId: "migration-proof-owner",
    },
    loopDataDir: path.join(root, "loop-governor-data"),
  };
}

/** Every adapter entry that reached the durable run ledger, across all runs. */
function adapterStarts(universe: Universe, missionId: string): number {
  const ledger = createDurableMissionRunLedger({ stateDir: universe.approvalAuthority.stateDir });
  return ledger
    .listRunsByMission(missionId)
    .flatMap((run) => run.events)
    .filter((event) => event.type === "adapter_started")
    .length;
}

// ---------------------------------------------------------------------------
// Loop Governor consumer — real cross-repository child process
// ---------------------------------------------------------------------------

function openLoopService(universe: Universe, clock?: FakeTemporalClock) {
  const database = createDatabase(universe.databasePath);
  const executor = createLoopGovernorMissionExecutor(
    {
      pythonExecutable: PYTHON,
      governorRoot: LOOP_GOVERNOR_ROOT,
      dataDir: universe.loopDataDir,
      timeoutValid: true,
      approvalAuthority: universe.approvalAuthority,
    },
    {
      // The real process port is used; only the clock is injected so expiry
      // proofs never depend on wall-clock timing.
      port: createLoopGovernorProcessPort({
        pythonExecutable: PYTHON,
        governorRoot: LOOP_GOVERNOR_ROOT,
        dataDir: universe.loopDataDir,
      }),
      ...(clock ? { clock } : {}),
    },
  );
  const service = new GenericMissionService(database, executor, {
    agentRunLedgerService: new AgentRunLedgerService(database),
    now: () => new Date(APPROVAL_MS),
  });
  return { database, service, executor };
}

function loopEnvelope(missionId: string): Record<string, unknown> {
  return {
    schemaVersion: "chanter.mission.v1",
    missionId,
    traceId: `${missionId}-trace`,
    idempotencyKey: `${missionId}-key`,
    source: { system: "mission_compiler", requestedBy: "founder-cli" },
    objective: "Prove the migrated persisted approval authority end to end.",
    target: { product: "loop_governor", action: "loop_governor.manual_loop.create" },
    tenant: { userId: "founder" },
    input: {
      appName: "chanter-operator",
      taskType: "review",
      goal: "Review the persisted approval authority consumer migration.",
      scope: "operator backend missions only",
    },
    constraints: ["No real agent execution"],
    acceptanceCriteria: ["One manual relay loop exists"],
    requestedAt: APPROVAL_INSTANT,
  };
}

// ---------------------------------------------------------------------------
// AutoPoster consumer — faithful no-side-effect adapter
// ---------------------------------------------------------------------------

function noSideEffectAutoPosterPort(): {
  port: AutoPosterOperationsPort;
  scheduleCalls: AutoPosterScheduleParams[];
} {
  const scheduleCalls: AutoPosterScheduleParams[] = [];
  const account = {
    connectedAccountId: "tiktok:account-a",
    accountId: "account-a",
    provider: "tiktok" as const,
    providerDisplayName: "TikTok",
    username: "creator",
    displayName: "Creator",
    connectionStatus: "connected" as const,
    publishingReady: true,
    readinessBlockers: [],
    lastVerifiedAt: APPROVAL_INSTANT,
  };
  const port: AutoPosterOperationsPort = {
    async listConnectedAccounts(params) {
      return { ok: true, workspaceId: params.workspaceId, accounts: [account], count: 1 };
    },
    async validateConnectedAccount(params) {
      return { ok: true, workspaceId: params.workspaceId ?? "workspace-proof-0001", account };
    },
    async listQueue() {
      return { ok: true, items: [], count: 0, scope: { accountId: "all" } };
    },
    async getPostStatus(params) {
      return {
        ok: true,
        post: {
          id: params.postId,
          accountId: "account-a",
          username: "creator",
          status: "scheduled",
          scheduledAt: new Date(Date.now() + 7_200_000).toISOString(),
          approved: false,
          mediaType: "video",
          captionSummary: "",
          createdAt: null,
          updatedAt: null,
          approvedAt: null,
          approvedBy: "",
          postedAt: null,
          publishId: "",
          claimAttempts: 0,
          lastErrorMessage: "",
        },
      };
    },
    async validateMedia() {
      return {
        ok: true,
        valid: true,
        classification: "video",
        policy: { videoOnly: true, allowedExtensions: [".mp4"] },
      };
    },
    // Records the exact controlled request and creates nothing anywhere.
    async schedulePost(params) {
      scheduleCalls.push(params);
      return {
        ok: true,
        duplicate: false,
        post: {
          id: "controlled-queue-draft-1",
          accountId: params.accountId,
          provider: params.provider ?? "tiktok",
          status: "scheduled",
          scheduledAt: params.scheduledAt,
          approved: false,
          campaignId: `autoposter-campaign:${params.missionId}`,
          approvalId: `autoposter-approval:${params.missionId}`,
          evidenceBundleId: `autoposter-evidence:${params.missionId}`,
        },
      };
    },
  };
  return { port, scheduleCalls };
}

function openAutoPosterService(
  universe: Universe,
  port: AutoPosterOperationsPort,
  options: { clock?: FakeTemporalClock; failureInjector?: (boundary: string) => void } = {},
) {
  const database = createDatabase(universe.databasePath);
  const executor = createAutoPosterRuntimeMissionExecutor(
    {
      baseUrl: "https://autoposter.controlled.invalid",
      serviceToken: "controlled-proof-token",
      userId: "owner",
      timeoutValid: true,
      approvalAuthority: universe.approvalAuthority,
    },
    { port, ...(options.clock ? { clock: options.clock } : {}) },
  );
  const service = new AutoPosterMissionService(database, executor, {
    agentRunLedgerService: new AgentRunLedgerService(database),
    now: () => new Date(APPROVAL_MS),
    ...(options.failureInjector ? { failureInjector: options.failureInjector as never } : {}),
  });
  return { database, service, executor };
}

function scheduleInput(): Record<string, unknown> {
  return {
    workspaceId: "workspace-proof-0001",
    accountId: "account-a",
    provider: "tiktok",
    mediaUrl: "https://cdn.example.com/controlled.mp4",
    caption: "Controlled integration proof",
    hashtags: "#chanter",
    scheduledAt: new Date(Date.now() + 7_200_000).toISOString(),
  };
}

// ---------------------------------------------------------------------------

describe("CHANTER OS persisted approval authority — controlled cross-repository proof", () => {
  const repositoryRoot = approvalRepository();

  it("executes the whole chain exactly once under valid persisted authority", async () => {
    const universe = createUniverse("chain", repositoryRoot);
    const missionId = "migration-chain-loop-0001";

    // 1. Operator submission — durable, approval-required, nothing executed.
    const loop = openLoopService(universe);
    const created = await loop.service.createMissionFromEnvelope(loopEnvelope(missionId));
    assert.equal(created.status, "approval_required");
    assert.equal(adapterStarts(universe, missionId), 0);

    // 2. Operator approval -> persisted authority -> real Loop Governor process.
    const completed = await loop.service.approveAndExecute(missionId, APPROVER);
    assert.equal(completed.status, "succeeded", JSON.stringify(completed.runtimeResult?.errors));
    assert.equal(adapterStarts(universe, missionId), 1);

    // 3. The authority that authorized it is durable and content-addressed.
    const store = createDurableIdempotencyStore({ stateDir: universe.approvalAuthority.stateDir });
    const manifest = store.getApprovalCheckpointManifest(missionId);
    const observation = store.getApprovalObservation(missionId);
    assert.ok(manifest, "checkpoint manifest is persisted");
    assert.ok(observation, "approval observation is persisted");
    assert.equal(observation.status, "approved");
    assert.equal(observation.approverId, APPROVER);
    assert.equal(observation.checkpointManifestHash, manifest.manifestHash);
    assert.equal(manifest.expectedHead.length >= 40, true);
    assert.equal(
      completed.runtimeResult?.approvalDecision.authority?.state,
      "approved",
    );

    // 4. A real loop was created downstream, exactly one.
    const loopIds = completed.execution?.downstreamIds;
    assert.ok(loopIds && typeof loopIds === "object", "downstream loop identity exists");

    // 5. Duplicate resume replays durable truth; no second adapter entry.
    const replayed = await loop.service.approveAndExecute(missionId, APPROVER);
    assert.equal(replayed.execution?.state, "completed");
    assert.equal(adapterStarts(universe, missionId), 1);
    loop.database.close();

    // 6. The AutoPoster consumer completes the same chain through a controlled
    //    no-side-effect adapter, also exactly once.
    const autoUniverse = createUniverse("chain-autoposter", repositoryRoot);
    const { port, scheduleCalls } = noSideEffectAutoPosterPort();
    const auto = openAutoPosterService(autoUniverse, port);
    const autoCreated = await auto.service.createScheduleMission(scheduleInput());
    const autoCompleted = await auto.service.approveAndExecute(autoCreated.missionId, APPROVER);
    assert.equal(autoCompleted.status, "succeeded", JSON.stringify(autoCompleted.runtimeResult?.errors));
    assert.equal(scheduleCalls.length, 1);
    assert.equal(adapterStarts(autoUniverse, autoCreated.missionId), 1);
    auto.database.close();
  });

  it("produces zero adapter starts with no approval", async () => {
    const universe = createUniverse("no-approval", repositoryRoot);
    const missionId = "migration-no-approval-0001";
    const loop = openLoopService(universe);
    const created = await loop.service.createMissionFromEnvelope(loopEnvelope(missionId));
    assert.equal(created.status, "approval_required");
    assert.equal(created.approvedBy, null);
    assert.equal(adapterStarts(universe, missionId), 0);
    const store = createDurableIdempotencyStore({ stateDir: universe.approvalAuthority.stateDir });
    assert.equal(store.getApprovalObservation(missionId), undefined);
    loop.database.close();
  });

  it("produces zero adapter starts for a legacy transient approval", async () => {
    const universe = createUniverse("transient", repositoryRoot);
    const port = createLoopGovernorProcessPort({
      pythonExecutable: PYTHON,
      governorRoot: LOOP_GOVERNOR_ROOT,
      dataDir: universe.loopDataDir,
    });
    const registry = createMissionAdapterRegistry([createLoopGovernorMissionAdapter(port)]);
    const legacyRequest: RuntimeMissionRequest = {
      missionId: "migration-transient-0001",
      traceId: "migration-transient-trace",
      product: "loop_governor",
      action: "loop_governor.manual_loop.create",
      actor: { id: "chanter-operator", kind: "service" },
      tenant: { userId: "founder" },
      input: {
        appName: "chanter-operator",
        taskType: "review",
        goal: "Legacy transient approval must not authorize execution.",
        scope: "operator backend missions only",
      },
      approval: { approved: true, approvedBy: APPROVER },
      idempotencyKey: "migration-transient-key",
      requestedAt: APPROVAL_INSTANT,
    };

    const result = await executeMission(legacyRequest, {
      registry,
      idempotencyStore: createInMemoryIdempotencyStore(),
    });

    assert.equal(result.status, "failed");
    assert.equal(result.errors[0]?.code, "RUNTIME_APPROVAL_PERSISTED_AUTHORITY_REQUIRED");
    assert.equal(result.approvalDecision.approved, false);
  });

  it("produces zero adapter starts for an expired approval", async () => {
    const universe = createUniverse("expired", repositoryRoot);
    const missionId = "migration-expired-0001";
    const loop = openLoopService(universe, new FakeTemporalClock(new Date(APPROVAL_MS + 60_000)));
    await loop.service.createMissionFromEnvelope(loopEnvelope(missionId));
    const published = await loop.executor.prepareApproval(
      loop.service.runtimeRequestFor(missionId),
      { approverId: APPROVER, observedAt: APPROVAL_INSTANT, approvalExpiresAt: EXPIRY_INSTANT },
    );
    assert.equal(published.ok, true);

    const refused = await loop.service.approveAndExecute(missionId, APPROVER);
    assert.equal(refused.status, "denied");
    assert.equal(refused.runtimeResult?.errors[0]?.code, "RUNTIME_APPROVAL_EXPIRED");
    assert.equal(adapterStarts(universe, missionId), 0);
    loop.database.close();
  });

  it("preserves valid authority across a restart between approval and execution", async () => {
    const universe = createUniverse("restart", repositoryRoot);
    const { port, scheduleCalls } = noSideEffectAutoPosterPort();

    let injected = false;
    const first = openAutoPosterService(universe, port, {
      failureInjector: (boundary) => {
        if (!injected && boundary === "after_approval_persistence") {
          injected = true;
          throw new Error("INJECTED_PROCESS_TERMINATION");
        }
      },
    });
    const created = await first.service.createScheduleMission(scheduleInput());
    await assert.rejects(
      first.service.approveAndExecute(created.missionId, APPROVER),
      /INJECTED_PROCESS_TERMINATION/,
    );
    first.database.close();
    assert.equal(scheduleCalls.length, 0);
    assert.equal(adapterStarts(universe, created.missionId), 0);

    // A new process, same durable database and same durable authority.
    const restarted = openAutoPosterService(universe, port);
    const resumed = await restarted.service.resumeSafely(created.missionId);
    assert.equal(resumed.status, "succeeded", JSON.stringify(resumed.runtimeResult?.errors));
    assert.equal(scheduleCalls.length, 1);
    assert.equal(adapterStarts(universe, created.missionId), 1);

    // Duplicate resume after the restart still produces at most one entry.
    const duplicate = await restarted.service.approveAndExecute(created.missionId, APPROVER);
    assert.equal(duplicate.execution?.state, "completed");
    assert.equal(scheduleCalls.length, 1);
    assert.equal(adapterStarts(universe, created.missionId), 1);
    restarted.database.close();
  });

  it("refuses execution after a restart once the approval has expired", async () => {
    const universe = createUniverse("restart-expired", repositoryRoot);
    const { port, scheduleCalls } = noSideEffectAutoPosterPort();

    let injected = false;
    const first = openAutoPosterService(universe, port, {
      clock: new FakeTemporalClock(new Date(APPROVAL_MS + 10_000)),
      failureInjector: (boundary) => {
        if (!injected && boundary === "after_approval_persistence") {
          injected = true;
          throw new Error("INJECTED_PROCESS_TERMINATION");
        }
      },
    });
    const created = await first.service.createScheduleMission(scheduleInput());
    // The bounded approval becomes durable before the interruption.
    const published = await first.executor.prepareApproval(
      first.service.runtimeRequestFor(created.missionId),
      { approverId: APPROVER, observedAt: APPROVAL_INSTANT, approvalExpiresAt: EXPIRY_INSTANT },
    );
    assert.equal(published.ok, true);
    await assert.rejects(
      first.service.approveAndExecute(created.missionId, APPROVER),
      /INJECTED_PROCESS_TERMINATION/,
    );
    first.database.close();

    // The restart happens after the bound has passed: the same immutable
    // observation is read back and refused.
    const restarted = openAutoPosterService(universe, port, {
      clock: new FakeTemporalClock(new Date(APPROVAL_MS + 3_600_000)),
    });
    const resumed = await restarted.service.resumeSafely(created.missionId);
    assert.notEqual(resumed.status, "succeeded");
    assert.equal(scheduleCalls.length, 0);
    assert.equal(adapterStarts(universe, created.missionId), 0);
    restarted.database.close();
  });
});
