import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type {
  AutoPosterOperationsPort,
  AutoPosterScheduleParams,
} from "chanter-agent-runtime";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { AgentRunLedgerService } from "../src/agentRunLedger/agentRunLedgerService.js";
import { AuditLogger } from "../src/audit/auditLogger.js";
import { createApp } from "../src/app.js";
import { createDatabase } from "../src/db/database.js";
import { AutoPosterGraphIntakeService } from "../src/missions/autoPosterGraphIntake.js";
import { AutoPosterMissionEvidenceService } from "../src/missions/autoPosterMissionEvidenceService.js";
import { AutoPosterObservationService } from "../src/missions/autoPosterObservationService.js";
import { AutoPosterResultProjectionService } from "../src/missions/autoPosterResultProjectionService.js";
import { GenericMissionService } from "../src/missions/genericMissionService.js";
import { MissionGraphChildDispatcher } from "../src/missions/missionGraphChildDispatcher.js";
import { MissionGraphService } from "../src/missions/missionGraphService.js";
import { createLoopGovernorMissionExecutor } from "../src/missions/loopGovernorRuntime.js";
import {
  derivePlatformAutoPosterCommandId,
  PlatformAutoPosterCommandService,
} from "../src/platform/platformAutoPosterCommandService.js";
import { MockRunner } from "../src/runners/mockRunner.js";
import { AutoPosterMissionService } from "../src/runtimeMissions/autoPosterMissionService.js";
import { createAutoPosterRuntimeMissionExecutor } from "../src/runtimeMissions/autoPosterRuntime.js";
import { OperatorError, OperatorService } from "../src/services/operatorService.js";
import { ensureWorkspace } from "../src/workspace/pathGuard.js";
import {
  approvalAuthorityFixture,
  approvalAuthorityFixtureFor,
  cleanupApprovalAuthorityFixtures,
} from "./helpers/approvalAuthorityFixture.js";

const NOW = "2099-07-26T09:00:00.000Z";
const SCHEDULED_AT = "2099-07-27T12:00:00+03:00";
const TENANT_ID = "workspace-platform-p0";
const ACTOR_ID = "platform-user-0001";
const ACCOUNT_ID = "tt:opaque/account@01";
const SUBMIT_TOKEN = "test-mission-submit-token";
const CONTROL_TOKEN = "test-operator-control-token";
const RUNTIME_TOKEN = "platform-runtime-service-token";

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
  campaignId: string;
  approvalId: string;
  evidenceBundleId: string;
}

interface FakeBoundary {
  port: AutoPosterOperationsPort;
  jobs: Map<string, QueueDraft>;
  scheduleCalls: AutoPosterScheduleParams[];
  accountValidationCalls: number;
  providerPublishCalls: number;
  accountConnected: boolean;
  statusUnavailable: boolean;
  evidenceGenerationFails: boolean;
  evidenceOperatorErrorCode: string | null;
  graphDispatchFailures: number;
}

function connectedAccount() {
  return {
    connectedAccountId: `tiktok:${ACCOUNT_ID}`,
    accountId: ACCOUNT_ID,
    provider: "tiktok" as const,
    providerDisplayName: "TikTok",
    username: "platform_p0",
    displayName: "Platform P0",
    connectionStatus: "connected" as const,
    publishingReady: true,
    readinessBlockers: [],
    lastVerifiedAt: NOW,
  };
}

function makeBoundary(): FakeBoundary {
  const boundary: FakeBoundary = {
    port: undefined as unknown as AutoPosterOperationsPort,
    jobs: new Map(),
    scheduleCalls: [],
    accountValidationCalls: 0,
    providerPublishCalls: 0,
    accountConnected: true,
    statusUnavailable: false,
    evidenceGenerationFails: false,
    evidenceOperatorErrorCode: null,
    graphDispatchFailures: 0,
  };
  boundary.port = {
    async listConnectedAccounts(params) {
      const accounts = boundary.accountConnected ? [connectedAccount()] : [];
      return { ok: true, workspaceId: params.workspaceId, accounts, count: accounts.length };
    },
    async validateConnectedAccount(params) {
      boundary.accountValidationCalls += 1;
      if (
        !boundary.accountConnected
        || params.workspaceId !== TENANT_ID
        || params.accountId !== ACCOUNT_ID
        || params.provider !== "tiktok"
      ) {
        return {
          ok: false,
          code: "conflict",
          reasonCode: "unknown_account_id",
          message: "The selected account is not connected.",
        };
      }
      return { ok: true, workspaceId: TENANT_ID, account: connectedAccount() };
    },
    async listQueue() {
      return { ok: true, items: [], count: 0, scope: { accountId: "all" } };
    },
    async getPostStatus(params) {
      if (boundary.statusUnavailable) {
        return { ok: false, code: "unavailable", message: "status unavailable" };
      }
      const job = [...boundary.jobs.values()].find((candidate) => candidate.id === params.postId);
      if (!job) return { ok: false, code: "not_found", message: "not found" };
      return {
        ok: true,
        post: {
          id: job.id,
          provider: job.provider,
          connectedAccountId: `${job.provider}:${job.accountId}`,
          accountId: job.accountId,
          username: "platform_p0",
          workspaceId: TENANT_ID,
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
        policy: {
          videoOnly: true,
          allowedExtensions: [".mp4", ".mov", ".webm"],
        },
      };
    },
    async schedulePost(params) {
      boundary.scheduleCalls.push(params);
      const existing = boundary.jobs.get(params.idempotencyKey);
      if (existing) return { ok: true, duplicate: true, post: existing };
      if (!params.graphId) throw new Error("Canonical graphId was not forwarded.");
      const job: QueueDraft = {
        id: `autoposter-job-${boundary.jobs.size + 1}`,
        accountId: params.accountId,
        provider: params.provider ?? "tiktok",
        status: "scheduled",
        scheduledAt: params.scheduledAt,
        approved: false,
        idempotencyKey: params.idempotencyKey,
        missionId: params.missionId,
        action: params.action,
        missionPayloadHash: params.missionPayloadHash,
        campaignId: `autoposter-campaign:${params.missionId}`,
        approvalId: `autoposter-approval:${params.missionId}`,
        evidenceBundleId: `autoposter-evidence:${params.graphId}`,
      };
      boundary.jobs.set(params.idempotencyKey, job);
      return { ok: true, duplicate: false, post: job };
    },
    async reconcileSchedule() {
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
    },
  };
  return boundary;
}

function loopPort() {
  return {
    async createManualLoop() {
      return {
        ok: true,
        created: true,
        taskId: "platform-task",
        loopId: "platform-loop",
        realAgentExecution: false,
      };
    },
    async lookupManualLoop() {
      return { ok: true, outcome: "not_found", binding: null };
    },
  };
}

interface Harness {
  root: string;
  database: DatabaseSync;
  app: ReturnType<typeof createApp>;
  service: PlatformAutoPosterCommandService;
  graphs: MissionGraphService;
  close(): void;
}

const harnesses = new Set<Harness>();

afterEach(() => {
  cleanupApprovalAuthorityFixtures();
  for (const harness of [...harnesses]) harness.close();
});

function createHarness(boundary: FakeBoundary): Harness {
  const root = mkdtempSync(path.join(os.tmpdir(), "chanter-platform-command-"));
  const databasePath = path.join(root, "operator.sqlite");
  const approvalAuthority = approvalAuthorityFixtureFor(databasePath);
  const database = createDatabase(databasePath);
  const ledger = new AgentRunLedgerService(database, []);
  const executor = createAutoPosterRuntimeMissionExecutor({
    baseUrl: "https://autoposter.platform.test",
    serviceToken: RUNTIME_TOKEN,
    userId: "owner",
    timeoutValid: true,
      approvalAuthority,
  }, { port: boundary.port });
  const autoPoster = new AutoPosterMissionService(database, executor, {
    agentRunLedgerService: ledger,
    now: () => new Date(NOW),
  });
  const generic = new GenericMissionService(
    database,
    createLoopGovernorMissionExecutor(
      { pythonExecutable: "", governorRoot: "", dataDir: "", timeoutValid: true, approvalAuthority },
      { port: loopPort() },
    ),
    { agentRunLedgerService: ledger, now: () => new Date(NOW) },
  );
  const results = new AutoPosterResultProjectionService(database, executor, {
    now: () => new Date(NOW),
  });
  const observation = new AutoPosterObservationService(database, results, {
    now: () => new Date(NOW),
  });
  const graphs = new MissionGraphService(
    database,
    new MissionGraphChildDispatcher(generic, autoPoster),
    {
      now: () => new Date(NOW),
      observationScheduler: observation,
      failureInjector(boundaryName) {
        if (
          boundaryName === "after_child_mission_created"
          && boundary.graphDispatchFailures > 0
        ) {
          boundary.graphDispatchFailures -= 1;
          throw new OperatorError(
            "simulated recoverable Platform graph dispatch interruption",
            503,
            "PLATFORM_TEST_GRAPH_INTERRUPTED",
          );
        }
      },
    },
  );
  const intake = new AutoPosterGraphIntakeService(
    graphs,
    autoPoster,
    executor,
    () => new Date(NOW),
  );
  const evidence = new AutoPosterMissionEvidenceService(
    graphs,
    autoPoster,
    results,
    observation,
    executor,
    path.join(root, "evidence"),
    [],
    () => new Date(NOW),
  );
  const platform = new PlatformAutoPosterCommandService(
    database,
    graphs,
    autoPoster,
    executor,
    {
      async generateEvidenceBundle(graphId, input) {
        if (boundary.evidenceOperatorErrorCode) {
          throw new OperatorError(
            "simulated explicit evidence integrity failure",
            409,
            boundary.evidenceOperatorErrorCode,
          );
        }
        if (boundary.evidenceGenerationFails) {
          throw new Error("simulated retained evidence storage failure");
        }
        return evidence.generateEvidenceBundle(graphId, input);
      },
    } as unknown as AutoPosterMissionEvidenceService,
    { now: () => new Date(NOW) },
  );
  const operator = new OperatorService(
    database,
    new AuditLogger(path.join(root, "audit.jsonl")),
    new MockRunner(),
    ensureWorkspace(path.join(root, "workspace")),
  );
  const app = createApp(
    operator,
    autoPoster,
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
  let closed = false;
  const harness: Harness = {
    root,
    database,
    app,
    service: platform,
    graphs,
    close() {
      if (closed) return;
      closed = true;
      database.close();
      rmSync(root, { recursive: true, force: true });
      harnesses.delete(harness);
    },
  };
  harnesses.add(harness);
  return harness;
}

function commandBody(
  intakeKey = "platform-intake-0001",
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const commandId = derivePlatformAutoPosterCommandId(TENANT_ID, ACTOR_ID, intakeKey);
  return {
    schemaVersion: "chanter.platform.autoposter.create-work.v1",
    commandId,
    tenantId: TENANT_ID,
    actorId: ACTOR_ID,
    intakeKey,
    media: {
      kind: "public_url",
      url: "https://cdn.example.com/platform-p0.mp4",
      mediaType: "video",
    },
    destinations: [{
      provider: "tiktok",
      accountId: ACCOUNT_ID,
      soundMode: "tiktok_recommended",
    }],
    copy: {
      caption: "Canonical Platform work",
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
    ...overrides,
  };
}

function submit(harness: Harness, body: Record<string, unknown>) {
  return request(harness.app)
    .post("/api/platform/autoposter-commands")
    .set("Authorization", `Bearer ${SUBMIT_TOKEN}`)
    .send(body);
}

function stagedReference(input: {
  commandId: string;
  fileName: string;
  mimeType: string;
  byteSize: number;
  sha256: string;
  extension: string;
}): string {
  const encoded = Buffer.from(JSON.stringify({
    schemaVersion: "chanter.autoposter.staged-media.v1",
    ...input,
  })).toString("base64url");
  return `chanter-autoposter-staged://v1/${encoded}.${"a".repeat(64)}`;
}

describe("canonical Platform AutoPoster command/linkage authority", () => {
  it("persists the exact command before graph execution and replays without another preflight", async () => {
    const boundary = makeBoundary();
    const harness = createHarness(boundary);
    const body = commandBody();

    const created = await submit(harness, body);
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      commandId: body.commandId,
      lifecycleState: "approval_required",
      productState: "not_started",
      draftExecutionApprovalState: "required",
      publicationApprovalState: "human_required",
      evidenceAvailable: false,
    });
    expect(created.body.graphHash).toMatch(/^[0-9a-f]{64}$/);
    expect(created.body.missionId).toMatch(/^graph:/);
    expect(boundary.scheduleCalls).toHaveLength(0);
    expect(boundary.jobs.size).toBe(0);
    expect(boundary.accountValidationCalls).toBe(1);

    const counts = {
      commands: Number((harness.database.prepare(
        "SELECT COUNT(*) AS count FROM operator_platform_autoposter_commands",
      ).get() as { count: number }).count),
      graphs: Number((harness.database.prepare(
        "SELECT COUNT(*) AS count FROM operator_mission_graphs",
      ).get() as { count: number }).count),
      missions: Number((harness.database.prepare(
        "SELECT COUNT(*) AS count FROM autoposter_runtime_missions",
      ).get() as { count: number }).count),
    };
    expect(counts).toEqual({ commands: 1, graphs: 1, missions: 0 });

    const replay = await submit(harness, body);
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({
      replayed: true,
      commandId: created.body.commandId,
      graphId: created.body.graphId,
      graphHash: created.body.graphHash,
      requestedAt: NOW,
    });
    expect(boundary.accountValidationCalls).toBe(1);

    const changedRequestedAt = await submit(harness, {
      ...body,
      requestedAt: "2026-07-26T09:05:00.000Z",
    });
    expect(changedRequestedAt.status).toBe(409);
    expect(changedRequestedAt.body.code).toBe("PLATFORM_COMMAND_PAYLOAD_MISMATCH");

    const changed = await submit(harness, {
      ...body,
      copy: {
        ...(body.copy as Record<string, unknown>),
        caption: "Changed canonical payload",
      },
    });
    expect(changed.status).toBe(409);
    expect(changed.body.code).toBe("PLATFORM_COMMAND_PAYLOAD_MISMATCH");
  });

  it("requires exact control hash, creates one draft, links real evidence, and never publishes", async () => {
    const boundary = makeBoundary();
    const harness = createHarness(boundary);
    const created = await submit(harness, commandBody("platform-execute-0001"));
    expect(created.status).toBe(201);

    const wrongCapability = await request(harness.app)
      .post(`/api/platform/autoposter-commands/${created.body.commandId}/execute`)
      .set("Authorization", `Bearer ${SUBMIT_TOKEN}`)
      .send({ graphHash: created.body.graphHash });
    expect(wrongCapability.status).toBe(401);

    const wrongHash = await request(harness.app)
      .post(`/api/platform/autoposter-commands/${created.body.commandId}/execute`)
      .set("Authorization", `Bearer ${CONTROL_TOKEN}`)
      .send({ graphHash: "0".repeat(64) });
    expect(wrongHash.status).toBe(409);
    expect(boundary.scheduleCalls).toHaveLength(0);

    const executed = await request(harness.app)
      .post(`/api/platform/autoposter-commands/${created.body.commandId}/execute`)
      .set("Authorization", `Bearer ${CONTROL_TOKEN}`)
      .send({ graphHash: created.body.graphHash });
    expect(executed.status).toBe(200);
    expect(executed.body).toMatchObject({
      commandId: created.body.commandId,
      graphId: created.body.graphId,
      graphHash: created.body.graphHash,
      lifecycleState: "completed",
      productState: "draft_created",
      draftExecutionApprovalState: "approved",
      publicationApprovalState: "human_required",
      jobIds: ["autoposter-job-1"],
      approvalId: `autoposter-approval:${created.body.missionId}`,
      evidenceBundleId: `autoposter-evidence:${created.body.graphId}`,
      evidenceAvailable: true,
      error: null,
    });
    expect(executed.body.runtimeExecutionId).toBeTruthy();
    expect(executed.body.campaignId).toBe(
      `autoposter-campaign:${created.body.missionId}`,
    );
    expect(executed.body.evidenceReference).toMatch(/\.json$/);
    expect(boundary.scheduleCalls).toHaveLength(1);
    expect(boundary.jobs.size).toBe(1);
    expect(boundary.providerPublishCalls).toBe(0);

    boundary.evidenceGenerationFails = true;
    const replay = await request(harness.app)
      .post(`/api/platform/autoposter-commands/${created.body.commandId}/execute`)
      .set("Authorization", `Bearer ${CONTROL_TOKEN}`)
      .send({ graphHash: created.body.graphHash });
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({
      replayed: true,
      runtimeExecutionId: executed.body.runtimeExecutionId,
      campaignId: executed.body.campaignId,
      jobIds: executed.body.jobIds,
      evidenceBundleId: executed.body.evidenceBundleId,
      evidenceAvailable: true,
      evidenceReference: executed.body.evidenceReference,
      error: { code: "PLATFORM_EVIDENCE_UNAVAILABLE" },
    });
    expect(boundary.scheduleCalls).toHaveLength(1);
    expect(boundary.providerPublishCalls).toBe(0);

    const list = await request(harness.app).get("/api/platform/autoposter-commands");
    const detail = await request(harness.app)
      .get(`/api/platform/autoposter-commands/${created.body.commandId}`);
    expect(list.status).toBe(200);
    expect(list.body.commands).toHaveLength(1);
    expect(detail.body.commandId).toBe(created.body.commandId);
    expect(JSON.stringify(detail.body)).not.toContain(harness.root);
  });

  it("passes the exact staged reference and explicit sound mode through the graph", async () => {
    const boundary = makeBoundary();
    const harness = createHarness(boundary);
    const intakeKey = "platform-staged-0001";
    const commandId = derivePlatformAutoPosterCommandId(TENANT_ID, ACTOR_ID, intakeKey);
    const reference = stagedReference({
      commandId,
      fileName: "canonical.mov",
      mimeType: "video/quicktime",
      byteSize: 42_000,
      sha256: "b".repeat(64),
      extension: ".mov",
    });
    const created = await submit(harness, commandBody(intakeKey, {
      media: {
        kind: "autoposter_staged_upload",
        reference,
        fileName: "canonical.mov",
        mimeType: "video/quicktime",
        byteSize: 42_000,
        sha256: "b".repeat(64),
      },
      destinations: [{
        provider: "tiktok",
        accountId: ACCOUNT_ID,
        soundMode: "mute",
      }],
    }));
    expect(created.status).toBe(201);
    const graph = harness.graphs.getGraph(created.body.graphId);
    expect(graph.normalizedGraph.nodes[0]?.input).toMatchObject({
      mediaUrl: reference,
      soundMode: "mute",
    });

    const mismatchedIntake = "platform-staged-mismatch";
    const mismatch = await submit(harness, commandBody(mismatchedIntake, {
      media: {
        kind: "autoposter_staged_upload",
        reference,
        fileName: "canonical.mov",
        mimeType: "video/quicktime",
        byteSize: 42_000,
        sha256: "b".repeat(64),
      },
    }));
    expect(mismatch.status).toBe(409);
    expect(mismatch.body.code).toBe("PLATFORM_COMMAND_MEDIA_BINDING_MISMATCH");
  });

  it("retains product linkage when evidence refresh fails after draft creation", async () => {
    const boundary = makeBoundary();
    boundary.evidenceGenerationFails = true;
    const harness = createHarness(boundary);
    const created = await submit(harness, commandBody("platform-evidence-degraded"));

    const executed = await request(harness.app)
      .post(`/api/platform/autoposter-commands/${created.body.commandId}/execute`)
      .set("Authorization", `Bearer ${CONTROL_TOKEN}`)
      .send({ graphHash: created.body.graphHash });
    expect(executed.status).toBe(200);
    expect(executed.body).toMatchObject({
      lifecycleState: "completed",
      productState: "draft_created",
      publicationApprovalState: "human_required",
      jobIds: ["autoposter-job-1"],
      evidenceAvailable: false,
      error: { code: "PLATFORM_EVIDENCE_UNAVAILABLE" },
    });
    expect(boundary.scheduleCalls).toHaveLength(1);
    expect(boundary.providerPublishCalls).toBe(0);
  });

  it("fails closed on explicit evidence integrity errors without erasing product linkage", async () => {
    const boundary = makeBoundary();
    boundary.evidenceOperatorErrorCode = "OPERATOR_EVIDENCE_MEDIA_INVALID";
    const harness = createHarness(boundary);
    const created = await submit(harness, commandBody("platform-evidence-safety"));

    const refused = await request(harness.app)
      .post(`/api/platform/autoposter-commands/${created.body.commandId}/execute`)
      .set("Authorization", `Bearer ${CONTROL_TOKEN}`)
      .send({ graphHash: created.body.graphHash });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("OPERATOR_EVIDENCE_MEDIA_INVALID");

    const retained = await request(harness.app)
      .get(`/api/platform/autoposter-commands/${created.body.commandId}`);
    expect(retained.body).toMatchObject({
      lifecycleState: "failed",
      productState: "failed",
      jobIds: ["autoposter-job-1"],
      approvalId: `autoposter-approval:${created.body.missionId}`,
      evidenceBundleId: `autoposter-evidence:${created.body.graphId}`,
      error: { code: "OPERATOR_EVIDENCE_MEDIA_INVALID" },
    });
    expect(boundary.scheduleCalls).toHaveLength(1);
    expect(boundary.providerPublishCalls).toBe(0);
  });

  it("resumes a recoverable graph through exact execute replay under the durable approval", async () => {
    const boundary = makeBoundary();
    boundary.graphDispatchFailures = 1;
    const harness = createHarness(boundary);
    const created = await submit(harness, commandBody("platform-recoverable-replay"));

    const interrupted = await request(harness.app)
      .post(`/api/platform/autoposter-commands/${created.body.commandId}/execute`)
      .set("Authorization", `Bearer ${CONTROL_TOKEN}`)
      .send({ graphHash: created.body.graphHash });
    expect(interrupted.status).toBe(409);
    expect(interrupted.body.code).toBe("PLATFORM_COMMAND_EXECUTION_INCOMPLETE");

    const recoverable = await request(harness.app)
      .get(`/api/platform/autoposter-commands/${created.body.commandId}`);
    expect(recoverable.body).toMatchObject({
      lifecycleState: "failed_recoverable",
      productState: "recovery_required",
      draftExecutionApprovalState: "approved",
      jobIds: [],
    });

    const recovered = await request(harness.app)
      .post(`/api/platform/autoposter-commands/${created.body.commandId}/execute`)
      .set("Authorization", `Bearer ${CONTROL_TOKEN}`)
      .send({ graphHash: created.body.graphHash });
    expect(recovered.status).toBe(200);
    expect(recovered.body).toMatchObject({
      lifecycleState: "completed",
      productState: "draft_created",
      jobIds: ["autoposter-job-1"],
      approvalId: `autoposter-approval:${created.body.missionId}`,
      evidenceBundleId: `autoposter-evidence:${created.body.graphId}`,
    });
    expect(boundary.scheduleCalls).toHaveLength(1);
    expect(boundary.jobs.size).toBe(1);
    expect(boundary.providerPublishCalls).toBe(0);
  });

  it("retains a valid command before preflight failure and safely retries only while unbound", async () => {
    const boundary = makeBoundary();
    boundary.accountConnected = false;
    const harness = createHarness(boundary);
    const body = commandBody("platform-preflight-retry");

    const refused = await submit(harness, body);
    expect(refused.status).toBe(409);
    expect(Number((harness.database.prepare(
      "SELECT COUNT(*) AS count FROM operator_platform_autoposter_commands",
    ).get() as { count: number }).count)).toBe(1);
    expect(Number((harness.database.prepare(
      "SELECT COUNT(*) AS count FROM operator_mission_graphs",
    ).get() as { count: number }).count)).toBe(0);

    boundary.accountConnected = true;
    const retried = await submit(harness, body);
    expect(retried.status).toBe(200);
    expect(retried.body).toMatchObject({
      replayed: true,
      lifecycleState: "approval_required",
      requestedAt: NOW,
    });
    expect(boundary.accountValidationCalls).toBe(2);
  });

  it("fails closed on aliasing, unknown fields, secret-shaped material, and timezone mismatch", async () => {
    const boundary = makeBoundary();
    const harness = createHarness(boundary);
    const body = commandBody("platform-fail-closed");

    const alias = await submit(harness, { ...body, commandId: "caller-chosen-id" });
    expect(alias.status).toBe(409);
    expect(alias.body.code).toBe("PLATFORM_COMMAND_IDENTITY_MISMATCH");

    const unknown = await submit(harness, { ...body, publishNow: true });
    expect(unknown.status).toBe(400);
    expect(unknown.body.code).toBe("PLATFORM_COMMAND_SCHEMA_INVALID");

    const secret = await submit(harness, {
      ...body,
      copy: {
        ...(body.copy as Record<string, unknown>),
        youtube: {
          title: "",
          description: "Bearer abcdefghijklmnopqrstuvwxyz123456",
        },
      },
    });
    expect(secret.status).toBe(400);
    expect(secret.body.code).toBe("PLATFORM_COMMAND_SECRET_MATERIAL");

    const timezone = await submit(harness, {
      ...body,
      schedule: {
        ...(body.schedule as Record<string, unknown>),
        timezoneOffsetMinutes: 180,
      },
    });
    expect(timezone.status).toBe(400);
    expect(timezone.body.code).toBe("PLATFORM_COMMAND_SCHEDULE_TIMEZONE_MISMATCH");

    expect(Number((harness.database.prepare(
      "SELECT COUNT(*) AS count FROM operator_platform_autoposter_commands",
    ).get() as { count: number }).count)).toBe(0);
    expect(boundary.scheduleCalls).toHaveLength(0);
    expect(boundary.providerPublishCalls).toBe(0);
  });
});
