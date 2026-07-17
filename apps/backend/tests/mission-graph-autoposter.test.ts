import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type {
  AutoPosterOperationsPort,
  AutoPosterScheduleParams,
  AutoPosterScheduleReconciliationParams,
  LoopGovernorMissionPort,
  RuntimeMissionRequest,
} from "chanter-agent-runtime";
import { AgentRunLedgerService } from "../src/agentRunLedger/agentRunLedgerService.js";
import { createDatabase } from "../src/db/database.js";
import { GenericMissionService } from "../src/missions/genericMissionService.js";
import { MissionGraphChildDispatcher } from "../src/missions/missionGraphChildDispatcher.js";
import {
  compileMissionGraph,
  missionGraphChildMissionId,
} from "../src/missions/missionGraphCompiler.js";
import {
  MissionGraphService,
  type MissionGraphFailureBoundary,
} from "../src/missions/missionGraphService.js";
import { createLoopGovernorMissionExecutor } from "../src/missions/loopGovernorRuntime.js";
import {
  AutoPosterMissionService,
  type MissionFailureBoundary,
} from "../src/runtimeMissions/autoPosterMissionService.js";
import { createAutoPosterRuntimeMissionExecutor } from "../src/runtimeMissions/autoPosterRuntime.js";

const TEST_NOW_MS = Date.now();
const NOW = new Date(TEST_NOW_MS).toISOString();
const REQUESTED_AT = new Date(TEST_NOW_MS + 60_000).toISOString();
const TIKTOK_AT = new Date(TEST_NOW_MS + 2 * 60 * 60_000).toISOString();
const YOUTUBE_AT = new Date(TEST_NOW_MS + 3 * 60 * 60_000).toISOString();
const WORKSPACE_ID = "workspace-phase2e";
const OWNER_ID = "owner";
const TIKTOK_ACCOUNT = "tt-account";
const YOUTUBE_ACCOUNT = "UC-phase2e";

interface QueueDraft {
  id: string;
  accountId: string;
  provider: "tiktok" | "youtube";
  status: "scheduled";
  scheduledAt: string;
  approved: false;
  idempotencyKey: string;
  missionId: string;
  action: string;
  missionPayloadHash: string;
}

interface FakeAutoPosterBoundary {
  port: AutoPosterOperationsPort;
  jobs: Map<string, QueueDraft>;
  scheduleCalls: AutoPosterScheduleParams[];
  reconciliationCalls: AutoPosterScheduleReconciliationParams[];
  failNextAccounts: Set<string>;
  providerPublishCalls: number;
}

function connectedAccount(provider: "tiktok" | "youtube", accountId: string) {
  return {
    connectedAccountId: `${provider}:${accountId}`,
    accountId,
    provider,
    providerDisplayName: provider === "youtube" ? "YouTube" : "TikTok",
    username: provider === "youtube" ? "phase2e_youtube" : "phase2e_tiktok",
    displayName: "Phase 2E Account",
    connectionStatus: "connected" as const,
    publishingReady: true,
    readinessBlockers: [],
    lastVerifiedAt: NOW,
  };
}

function makeAutoPosterBoundary(): FakeAutoPosterBoundary {
  const jobs = new Map<string, QueueDraft>();
  const scheduleCalls: AutoPosterScheduleParams[] = [];
  const reconciliationCalls: AutoPosterScheduleReconciliationParams[] = [];
  const failNextAccounts = new Set<string>();
  const boundary: FakeAutoPosterBoundary = {
    jobs,
    scheduleCalls,
    reconciliationCalls,
    failNextAccounts,
    providerPublishCalls: 0,
    port: undefined as unknown as AutoPosterOperationsPort,
  };
  boundary.port = {
    async listConnectedAccounts(params) {
      const accounts = [
        connectedAccount("tiktok", TIKTOK_ACCOUNT),
        connectedAccount("youtube", YOUTUBE_ACCOUNT),
      ];
      return { ok: true, workspaceId: params.workspaceId, accounts, count: accounts.length };
    },
    async validateConnectedAccount(params) {
      const expected = params.provider === "youtube" ? YOUTUBE_ACCOUNT : TIKTOK_ACCOUNT;
      if (params.accountId !== expected) {
        return {
          ok: false,
          code: "conflict",
          reasonCode: "provider_account_mismatch",
          message: "The selected account does not match the provider.",
        };
      }
      return {
        ok: true,
        workspaceId: params.workspaceId ?? WORKSPACE_ID,
        account: connectedAccount(params.provider, params.accountId),
      };
    },
    async listQueue() {
      return { ok: true, items: [], count: 0, scope: { accountId: "all" } };
    },
    async getPostStatus(params) {
      const job = [...jobs.values()].find((candidate) => candidate.id === params.postId);
      if (!job) return { ok: false, code: "not_found", message: "not found" };
      return {
        ok: true,
        post: {
          id: job.id,
          provider: job.provider,
          connectedAccountId: `${job.provider}:${job.accountId}`,
          accountId: job.accountId,
          username: "phase2e",
          workspaceId: params.workspaceId ?? WORKSPACE_ID,
          status: job.status,
          scheduledAt: job.scheduledAt,
          approved: job.approved,
          approvalState: "unapproved",
          approvedAt: null,
          approvedBy: "",
          mediaType: "video",
          captionSummary: "",
          createdAt: NOW,
          updatedAt: NOW,
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
      return {
        ok: true,
        valid: true,
        classification: "video",
        policy: { videoOnly: true, allowedExtensions: [".mp4"] },
      };
    },
    async schedulePost(params) {
      scheduleCalls.push(params);
      if (failNextAccounts.delete(params.accountId)) {
        return { ok: false, code: "unavailable", message: "temporary schedule outage" };
      }
      const existing = jobs.get(params.idempotencyKey);
      if (existing) {
        return { ok: true, duplicate: true, post: existing };
      }
      const job: QueueDraft = {
        id: `queue-draft-${jobs.size + 1}`,
        accountId: params.accountId,
        provider: params.provider ?? "tiktok",
        status: "scheduled",
        scheduledAt: params.scheduledAt,
        approved: false,
        idempotencyKey: params.idempotencyKey,
        missionId: params.missionId,
        action: params.action,
        missionPayloadHash: params.missionPayloadHash,
      };
      jobs.set(params.idempotencyKey, job);
      return { ok: true, duplicate: false, post: job };
    },
    async reconcileSchedule(params) {
      reconciliationCalls.push(params);
      const matches = [...jobs.values()].filter((job) => job.missionId === params.missionId);
      if (matches.length === 0) {
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
      }
      const job = matches[0]!;
      if (job.idempotencyKey !== params.idempotencyKey) {
        return {
          ok: true,
          outcome: "idempotency_mismatch",
          count: 1,
          unique: true,
          safeToReuse: false,
          approvalState: "unknown",
          publishingState: "not_started",
          evidenceStatus: "idempotency_mismatch",
        };
      }
      if (
        job.provider !== params.provider
        || job.accountId !== params.accountId
        || job.scheduledAt !== params.scheduledAt
        || job.action !== params.action
        || job.missionPayloadHash !== params.missionPayloadHash
      ) {
        return {
          ok: true,
          outcome: "scope_mismatch",
          count: 1,
          unique: true,
          safeToReuse: false,
          approvalState: "unknown",
          publishingState: "not_started",
          evidenceStatus: "scope_mismatch",
        };
      }
      return {
        ok: true,
        outcome: "unique",
        count: 1,
        unique: true,
        safeToReuse: true,
        approvalState: "required",
        publishingState: "blocked_until_human_approval",
        evidenceStatus: "authoritative",
        post: job,
      };
    },
  };
  return boundary;
}

function loopPort(): LoopGovernorMissionPort {
  return {
    async createManualLoop() {
      return {
        ok: true,
        created: true,
        taskId: "phase2e-generic-task",
        loopId: "phase2e-generic-loop",
        realAgentExecution: false,
      };
    },
    async lookupManualLoop() {
      return { ok: true, outcome: "not_found", binding: null };
    },
  };
}

interface HarnessOptions {
  databasePath?: string;
  graphFailureInjector?: (
    boundary: MissionGraphFailureBoundary,
    graphId: string,
    nodeId: string | null,
  ) => void;
  missionFailureInjector?: (boundary: MissionFailureBoundary, missionId: string) => void;
  runtimeFailureInjector?: (
    boundary:
      | "after_runtime_receives_queue_id_before_result_persistence"
      | "after_runtime_result_persistence",
    request: RuntimeMissionRequest,
  ) => void;
}

interface Harness {
  database: DatabaseSync;
  databasePath: string;
  autoPoster: AutoPosterMissionService;
  graphs: MissionGraphService;
  close(): void;
}

const temporaryRoots: string[] = [];
const activeHarnesses = new Set<Harness>();

afterEach(() => {
  for (const harness of [...activeHarnesses]) harness.close();
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function createHarness(
  boundary: FakeAutoPosterBoundary,
  options: HarnessOptions = {},
): Harness {
  const root = options.databasePath
    ? path.dirname(options.databasePath)
    : mkdtempSync(path.join(os.tmpdir(), "chanter-phase2e-graph-"));
  if (!options.databasePath) temporaryRoots.push(root);
  const databasePath = options.databasePath ?? path.join(root, "operator.sqlite");
  const database = createDatabase(databasePath);
  const ledger = new AgentRunLedgerService(database, []);
  const executor = createAutoPosterRuntimeMissionExecutor(
    {
      baseUrl: "https://autoposter.phase2e.test",
      serviceToken: "phase2e-service-token",
      userId: OWNER_ID,
      timeoutValid: true,
    },
    {
      port: boundary.port,
      failureInjector: options.runtimeFailureInjector,
    },
  );
  const autoPoster = new AutoPosterMissionService(database, executor, {
    agentRunLedgerService: ledger,
    now: () => new Date(NOW),
    failureInjector: options.missionFailureInjector,
  });
  const generic = new GenericMissionService(
    database,
    createLoopGovernorMissionExecutor(
      { pythonExecutable: "", governorRoot: "", dataDir: "", timeoutValid: true },
      { port: loopPort() },
    ),
    { agentRunLedgerService: ledger, now: () => new Date(NOW) },
  );
  const graphs = new MissionGraphService(
    database,
    new MissionGraphChildDispatcher(generic, autoPoster),
    {
      now: () => new Date(NOW),
      failureInjector: options.graphFailureInjector,
    },
  );
  let closed = false;
  const harness: Harness = {
    database,
    databasePath,
    autoPoster,
    graphs,
    close: () => {
      if (closed) return;
      closed = true;
      database.close();
      activeHarnesses.delete(harness);
    },
  };
  activeHarnesses.add(harness);
  return harness;
}

function scheduleNode(
  nodeId: string,
  provider: "tiktok" | "youtube",
  dependsOn: string[] = [],
) {
  const youtube = provider === "youtube";
  return {
    nodeId,
    target: { product: "auto_poster", action: "autoposter.post.schedule" },
    objective: `Create the ${provider} unapproved queue draft.`,
    input: {
      accountId: youtube ? YOUTUBE_ACCOUNT : TIKTOK_ACCOUNT,
      provider,
      mediaUrl: `https://cdn.example.com/${provider}-${nodeId}.mp4`,
      caption: `${provider} caption`,
      hashtags: "#chanter #phase2e",
      ...(youtube ? { title: "Phase 2E private upload", description: "Private-only." } : {}),
      scheduledAt: youtube ? YOUTUBE_AT : TIKTOK_AT,
    },
    dependsOn,
  };
}

function graphEnvelope(
  graphId = "phase2e-autoposter-graph",
  nodes = [scheduleNode("tiktok_node", "tiktok"), scheduleNode("youtube_node", "youtube")],
) {
  return {
    schemaVersion: "chanter.mission.graph.v1",
    graphId,
    traceId: `${graphId}-trace`,
    idempotencyKey: `${graphId}-key`,
    source: { system: "operator", requestedBy: "founder-phase2e" },
    objective: "Schedule an explicit bounded AutoPoster draft batch.",
    tenant: { userId: OWNER_ID, workspaceId: WORKSPACE_ID },
    nodes,
    requestedAt: REQUESTED_AT,
  };
}

function tableCount(database: DatabaseSync, table: string): number {
  const row = database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
    count: number;
  };
  return Number(row.count);
}

describe("Phase 2E-A AutoPoster graph compiler", () => {
  it("makes only the reviewed schedule action eligible and canonicalizes mixed providers", () => {
    const first = compileMissionGraph(graphEnvelope());
    const second = compileMissionGraph(graphEnvelope());
    expect(first.ok).toBe(true);
    expect(second).toEqual(first);
    if (!first.ok) return;
    expect(first.compiled.nodes).toHaveLength(2);
    expect(first.compiled.nodes.find((node) => node.nodeId === "tiktok_node")?.input.scheduledAt)
      .toBe(new Date(TIKTOK_AT).toISOString());
    expect(first.compiled.nodes.find((node) => node.nodeId === "youtube_node")?.input)
      .toMatchObject({ provider: "youtube", title: "Phase 2E private upload" });

    const unknown = graphEnvelope("phase2e-unknown-action", [{
      ...scheduleNode("bad", "tiktok"),
      target: { product: "auto_poster", action: "autoposter.post.publish" },
    }]);
    const rejected = compileMissionGraph(unknown);
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.errors[0]?.code).toBe("GRAPH_NODE_TARGET_UNREGISTERED");
    }
  });

  it.each([
    ["approval field", { approved: true }, "OPERATOR_MISSION_INPUT_UNSUPPORTED_FIELD"],
    ["publish field", { publishNow: true }, "OPERATOR_MISSION_INPUT_UNSUPPORTED_FIELD"],
    ["plan field", { planId: "studio" }, "OPERATOR_MISSION_INPUT_UNSUPPORTED_FIELD"],
    ["quota field", { scheduledPostsPerCycle: 999 }, "OPERATOR_MISSION_INPUT_UNSUPPORTED_FIELD"],
    ["retry field", { retry: true }, "OPERATOR_MISSION_INPUT_UNSUPPORTED_FIELD"],
    ["unknown provider", { provider: "instagram" }, "AUTOPOSTER_PROVIDER_INVALID"],
    ["noncanonical account", { accountId: " tt-account" }, "AUTOPOSTER_ACCOUNT_ID_NON_CANONICAL"],
    ["unsafe media", { mediaUrl: "http://cdn.example.com/video.mp4" }, "AUTOPOSTER_MEDIA_URL_INVALID"],
    ["signed media", { mediaUrl: "https://cdn.example.com/video.mp4?token=secret" }, "AUTOPOSTER_MEDIA_URL_SENSITIVE"],
    ["past schedule", { scheduledAt: REQUESTED_AT }, "AUTOPOSTER_SCHEDULED_AT_NOT_FUTURE"],
  ])("rejects %s before persistence", (_label, override, expectedCode) => {
    const node = scheduleNode("invalid", "tiktok");
    node.input = { ...node.input, ...override } as typeof node.input;
    const result = compileMissionGraph(graphEnvelope(`phase2e-${String(_label).replace(/\s/g, "-")}`, [node]));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]?.code).toBe(expectedCode);
  });

  it("requires graph workspace scope and exact provider metadata", () => {
    const missingWorkspace = graphEnvelope("phase2e-no-workspace");
    missingWorkspace.tenant = { userId: OWNER_ID, workspaceId: undefined } as never;
    const noWorkspace = compileMissionGraph(missingWorkspace);
    expect(noWorkspace.ok).toBe(false);
    if (!noWorkspace.ok) expect(noWorkspace.errors[0]?.code).toBe("OPERATOR_MISSION_SCOPE_INVALID");

    const noTitle = scheduleNode("youtube", "youtube");
    noTitle.input = { ...noTitle.input, title: "" };
    const youtube = compileMissionGraph(graphEnvelope("phase2e-no-title", [noTitle]));
    expect(youtube.ok).toBe(false);
    if (!youtube.ok) expect(youtube.errors[0]?.code).toBe("AUTOPOSTER_YOUTUBE_TITLE_REQUIRED");

    const tiktokMetadata = scheduleNode("tiktok", "tiktok");
    tiktokMetadata.input = { ...tiktokMetadata.input, title: "not allowed" } as never;
    const tiktok = compileMissionGraph(graphEnvelope("phase2e-tiktok-title", [tiktokMetadata]));
    expect(tiktok.ok).toBe(false);
    if (!tiktok.ok) expect(tiktok.errors[0]?.code).toBe("AUTOPOSTER_PROVIDER_METADATA_INVALID");
  });
});

describe("Phase 2E-A AutoPoster graph authority", () => {
  it("submits with zero writes, binds exact approval, and creates one unapproved draft per node", async () => {
    const boundary = makeAutoPosterBoundary();
    const harness = createHarness(boundary);
    const submitted = harness.graphs.submitGraph(graphEnvelope());
    expect(submitted.status).toBe("approval_required");
    expect(boundary.jobs.size).toBe(0);
    expect(tableCount(harness.database, "autoposter_runtime_missions")).toBe(0);

    await expect(harness.graphs.approveGraph(submitted.graphId, {
      approvedBy: "founder-phase2e",
      graphHash: "0".repeat(64),
    })).rejects.toMatchObject({ code: "OPERATOR_GRAPH_APPROVAL_HASH_MISMATCH" });
    expect(boundary.jobs.size).toBe(0);

    const completed = await harness.graphs.approveGraph(submitted.graphId, {
      approvedBy: "founder-phase2e",
      graphHash: submitted.graphHash,
    });
    expect(completed.status).toBe("completed");
    expect(boundary.jobs.size).toBe(2);
    expect(boundary.scheduleCalls).toHaveLength(2);
    expect(boundary.providerPublishCalls).toBe(0);
    expect(tableCount(harness.database, "autoposter_runtime_missions")).toBe(2);
    expect(tableCount(harness.database, "autoposter_mission_executions")).toBe(2);
    expect(tableCount(harness.database, "autoposter_mission_journal")).toBeGreaterThan(2);
    expect(tableCount(harness.database, "operator_missions")).toBe(0);
    for (const node of completed.nodes) {
      expect(node.childMissionId).toBe(missionGraphChildMissionId(completed.graphId, node.nodeId));
      expect(node.resultSummary).toMatchObject({
        queueDraftId: expect.stringMatching(/^queue-draft-/),
        status: "scheduled",
        approved: false,
        publishing: "blocked_until_human_approval",
      });
      expect(JSON.stringify(node.resultSummary)).not.toMatch(/published|posted|oauth|token/i);
    }
    harness.close();
  });

  it("replays approval and a full process restart without another queue draft", async () => {
    const boundary = makeAutoPosterBoundary();
    let harness = createHarness(boundary);
    const submitted = harness.graphs.submitGraph(graphEnvelope("phase2e-restart"));
    const completed = await harness.graphs.approveGraph(submitted.graphId, {
      approvedBy: "founder-phase2e",
      graphHash: submitted.graphHash,
    });
    expect(completed.status).toBe("completed");
    const databasePath = harness.databasePath;
    const calls = boundary.scheduleCalls.length;

    const replay = await harness.graphs.approveGraph(submitted.graphId, {
      approvedBy: "founder-phase2e",
      graphHash: submitted.graphHash,
    });
    expect(replay.replayed).toBe(true);
    expect(boundary.scheduleCalls).toHaveLength(calls);
    harness.close();

    harness = createHarness(boundary, { databasePath });
    const restarted = await harness.graphs.approveGraph(submitted.graphId, {
      approvedBy: "founder-phase2e",
      graphHash: submitted.graphHash,
    });
    expect(restarted.status).toBe("completed");
    expect(restarted.replayed).toBe(true);
    expect(boundary.scheduleCalls).toHaveLength(calls);
    expect(boundary.jobs.size).toBe(2);
    harness.close();
  });

  it.each([
    "after_node_running_persistence",
    "after_child_mission_created",
  ] as MissionGraphFailureBoundary[])("recovers %s without duplicate child or draft", async (failureBoundary) => {
    const boundary = makeAutoPosterBoundary();
    let injected = false;
    const harness = createHarness(boundary, {
      graphFailureInjector(boundaryName) {
        if (!injected && boundaryName === failureBoundary) {
          injected = true;
          throw new Error(`simulated ${failureBoundary}`);
        }
      },
    });
    const submitted = harness.graphs.submitGraph(
      graphEnvelope(`phase2e-${failureBoundary}`, [scheduleNode("only", "tiktok")]),
    );
    await expect(harness.graphs.approveGraph(submitted.graphId, {
      approvedBy: "founder-phase2e",
      graphHash: submitted.graphHash,
    })).rejects.toThrow(`simulated ${failureBoundary}`);

    const resumed = await harness.graphs.resumeGraph(submitted.graphId);
    expect(resumed.status).toBe("completed");
    expect(boundary.jobs.size).toBe(1);
    expect(tableCount(harness.database, "autoposter_runtime_missions")).toBe(1);
    harness.close();
  });

  it("reconciles a crash after queue creation and reuses the existing unapproved draft", async () => {
    const boundary = makeAutoPosterBoundary();
    let injected = false;
    const harness = createHarness(boundary, {
      runtimeFailureInjector(boundaryName) {
        if (!injected && boundaryName === "after_runtime_receives_queue_id_before_result_persistence") {
          injected = true;
          throw new Error("simulated Runtime crash after queue creation");
        }
      },
    });
    const submitted = harness.graphs.submitGraph(
      graphEnvelope("phase2e-after-queue", [scheduleNode("only", "tiktok")]),
    );
    const first = await harness.graphs.approveGraph(submitted.graphId, {
      approvedBy: "founder-phase2e",
      graphHash: submitted.graphHash,
    });
    expect(first.status).toBe("failed_recoverable");
    expect(boundary.jobs.size).toBe(1);

    const resumed = await harness.graphs.resumeGraph(submitted.graphId);
    expect(resumed.status).toBe("completed");
    expect(boundary.jobs.size).toBe(1);
    expect(boundary.reconciliationCalls).toHaveLength(1);
    expect(resumed.nodes[0]?.resultSummary).toMatchObject({ approved: false });
    harness.close();
  });

  it("preserves successful drafts across partial failure and resumes only incomplete work", async () => {
    const boundary = makeAutoPosterBoundary();
    boundary.failNextAccounts.add(YOUTUBE_ACCOUNT);
    const harness = createHarness(boundary);
    const submitted = harness.graphs.submitGraph(graphEnvelope("phase2e-partial"));
    const first = await harness.graphs.approveGraph(submitted.graphId, {
      approvedBy: "founder-phase2e",
      graphHash: submitted.graphHash,
    });
    expect(first.status).toBe("failed_recoverable");
    expect(boundary.jobs.size).toBe(1);
    const completedNode = first.nodes.find((node) => node.status === "completed");
    expect(completedNode?.resultSummary).toMatchObject({ approved: false });

    const resumed = await harness.graphs.resumeGraph(submitted.graphId);
    expect(resumed.status).toBe("completed");
    expect(boundary.jobs.size).toBe(2);
    expect(boundary.scheduleCalls.filter((call) => call.accountId === TIKTOK_ACCOUNT)).toHaveLength(1);
    expect(boundary.scheduleCalls.filter((call) => call.accountId === YOUTUBE_ACCOUNT)).toHaveLength(2);
    harness.close();
  });

  it("turns a pre-existing child payload mismatch into a terminal refusal with zero queue writes", async () => {
    const boundary = makeAutoPosterBoundary();
    const harness = createHarness(boundary);
    const envelope = graphEnvelope("phase2e-mismatch", [scheduleNode("only", "tiktok")]);
    const submitted = harness.graphs.submitGraph(envelope);
    const childId = missionGraphChildMissionId(submitted.graphId, "only");
    await harness.autoPoster.createScheduleMission({
      missionId: childId,
      traceId: `graph:${submitted.traceId}:node:only`,
      idempotencyKey: childId,
      requestedBy: "founder-phase2e",
      tenantUserId: OWNER_ID,
      workspaceId: WORKSPACE_ID,
      accountId: TIKTOK_ACCOUNT,
      provider: "tiktok",
      mediaUrl: "https://cdn.example.com/conflicting.mp4",
      caption: "conflicting payload",
      hashtags: "#conflict",
      scheduledAt: TIKTOK_AT,
    });

    const result = await harness.graphs.approveGraph(submitted.graphId, {
      approvedBy: "founder-phase2e",
      graphHash: submitted.graphHash,
    });
    expect(result.status).toBe("failed_terminal");
    expect(result.nodes[0]?.typedError?.code).toBe("OPERATOR_MISSION_PAYLOAD_MISMATCH");
    expect(boundary.jobs.size).toBe(0);
    expect(boundary.scheduleCalls).toHaveLength(0);
    harness.close();
  });
});
