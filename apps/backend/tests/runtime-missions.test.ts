import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  AutoPosterConnectedAccountListParams,
  AutoPosterConnectedAccountValidationParams,
  AutoPosterOperationsPort,
  AutoPosterScheduleParams,
} from "chanter-agent-runtime";
import { createApp } from "../src/app.js";
import { AgentRunLedgerService } from "../src/agentRunLedger/agentRunLedgerService.js";
import { AuditLogger } from "../src/audit/auditLogger.js";
import { createDatabase } from "../src/db/database.js";
import { MockRunner } from "../src/runners/mockRunner.js";
import {
  AutoPosterMissionService,
  type AutoPosterRuntimeMission,
} from "../src/runtimeMissions/autoPosterMissionService.js";
import {
  createAutoPosterRuntimeMissionExecutor,
  type AutoPosterRuntimeConfiguration,
} from "../src/runtimeMissions/autoPosterRuntime.js";
import { OperatorService } from "../src/services/operatorService.js";
import { ensureWorkspace } from "../src/workspace/pathGuard.js";

const TOKEN_CANARY = "short-token-9";
const MISSION_SUBMIT_TOKEN = "test-mission-submit-token";
const MISSION_CONTROL_TOKEN = "test-operator-control-token";
const SAFECOMMIT_EXECUTOR_TOKEN = "test-safecommit-executor-token";
const LEDGER_INGEST_TOKEN = "test-ledger-ingest-token";

function withSubmitAuth(req: ReturnType<typeof request>) {
  return req.set("Authorization", `Bearer ${MISSION_SUBMIT_TOKEN}`);
}

function withControlAuth(req: ReturnType<typeof request>) {
  return req.set("Authorization", `Bearer ${MISSION_CONTROL_TOKEN}`);
}

function futureIso(minutes = 60): string {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

function validConfiguration(
  overrides: Partial<AutoPosterRuntimeConfiguration> = {},
): AutoPosterRuntimeConfiguration {
  return {
    baseUrl: "https://autoposter.test",
    serviceToken: TOKEN_CANARY,
    userId: "owner",
    timeoutValid: true,
    ...overrides,
  };
}

function validInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    workspaceId: "workspace-a-00000001",
    accountId: "account-a",
    provider: "tiktok",
    mediaUrl: "https://cdn.example.com/video.mp4",
    caption: "Launch clip",
    hashtags: "#launch #chanter",
    scheduledAt: futureIso(),
    ...overrides,
  };
}

function makePort(overrides: Partial<AutoPosterOperationsPort> = {}): {
  port: AutoPosterOperationsPort;
  scheduleCalls: AutoPosterScheduleParams[];
  accountListCalls: AutoPosterConnectedAccountListParams[];
  accountValidationCalls: AutoPosterConnectedAccountValidationParams[];
} {
  const scheduleCalls: AutoPosterScheduleParams[] = [];
  const accountListCalls: AutoPosterConnectedAccountListParams[] = [];
  const accountValidationCalls: AutoPosterConnectedAccountValidationParams[] = [];
  const accountView = (accountId: string, provider: "tiktok" | "youtube") => ({
    connectedAccountId: `${provider}:${accountId}`,
    accountId,
    provider,
    providerDisplayName: provider === "youtube" ? "YouTube" : "TikTok",
    username: "creator",
    displayName: "Creator",
    connectionStatus: "connected" as const,
    publishingReady: true,
    readinessBlockers: [],
    lastVerifiedAt: "2026-07-14T08:00:00.000Z",
  });
  const port: AutoPosterOperationsPort = {
    async listConnectedAccounts(params) {
      accountListCalls.push(params);
      const accounts = [accountView("account-a", "tiktok"), accountView("UC-ExactCase", "youtube")];
      return { ok: true, workspaceId: params.workspaceId, accounts, count: accounts.length };
    },
    async validateConnectedAccount(params) {
      accountValidationCalls.push(params);
      return {
        ok: true,
        workspaceId: params.workspaceId ?? "workspace-a-00000001",
        account: accountView(params.accountId, params.provider as "tiktok" | "youtube"),
      };
    },
    async listQueue() {
      return { ok: true, items: [], count: 0, scope: { accountId: "all" } };
    },
    async getPostStatus(params) {
      return {
        ok: true,
        post: {
          id: params.postId,
          accountId: params.accountId ?? "account-a",
          username: "creator",
          status: "scheduled",
          scheduledAt: futureIso(),
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
    async schedulePost(params) {
      scheduleCalls.push(params);
      return {
        ok: true,
        duplicate: false,
        post: {
          id: "queue-draft-1",
          accountId: params.accountId,
          provider: params.provider ?? "tiktok",
          status: "scheduled",
          scheduledAt: params.scheduledAt,
          approved: false,
        },
      };
    },
    ...overrides,
  };
  return { port, scheduleCalls, accountListCalls, accountValidationCalls };
}

interface Harness {
  database: DatabaseSync;
  auditPath: string;
  ledger: AgentRunLedgerService;
  missionService: AutoPosterMissionService;
  app: ReturnType<typeof createApp>;
  rawApp: ReturnType<typeof createApp>;
}

function createHarness(
  temporaryRoot: string,
  port: AutoPosterOperationsPort,
  configuration = validConfiguration(),
): Harness {
  const database = createDatabase(path.join(temporaryRoot, "data", "operator.sqlite"));
  const auditPath = path.join(temporaryRoot, "data", "audit.jsonl");
  const workspaceRoot = ensureWorkspace(path.join(temporaryRoot, "workspace"));
  const operatorService = new OperatorService(
    database,
    new AuditLogger(auditPath),
    new MockRunner(),
    workspaceRoot,
  );
  const executor = createAutoPosterRuntimeMissionExecutor(configuration, { port });
  const protectedValues = [
    configuration.serviceToken,
    MISSION_SUBMIT_TOKEN,
    MISSION_CONTROL_TOKEN,
    LEDGER_INGEST_TOKEN,
  ];
  const agentRunLedgerService = new AgentRunLedgerService(database, protectedValues);
  const missionService = new AutoPosterMissionService(database, executor, {
    agentRunLedgerService,
    protectedValues,
  });
  // Phase 2A: wrap createApp with a test-only middleware that injects only the
  // capability owned by each exact route class.
  const rawApp = createApp(operatorService, missionService, agentRunLedgerService);
  const testApp = express();
  testApp.use((req, _res, next) => {
    if (!req.headers["authorization"] && !req.headers["x-chanter-capability-token"]) {
      const token = req.method === "POST" && (
        req.path === "/api/runtime-missions" ||
        req.path === "/api/runtime-missions/autoposter/schedule"
      )
        ? MISSION_SUBMIT_TOKEN
        : req.method === "POST" && /^\/api\/runtime-missions\/[^/]+\/(?:approve|reconcile|resume|stop)$/.test(req.path)
          ? MISSION_CONTROL_TOKEN
          : "";
      if (token) req.headers["authorization"] = `Bearer ${token}`;
    }
    next();
  });
  testApp.use(rawApp);
  return {
    database,
    auditPath,
    ledger: agentRunLedgerService,
    missionService,
    app: testApp,
    rawApp,
  };
}

describe("Operator -> Runtime -> AutoPoster schedule mission P0", () => {
  let temporaryRoot: string;
  let database: DatabaseSync | undefined;

  beforeEach(() => {
    temporaryRoot = mkdtempSync(path.join(os.tmpdir(), "chanter-runtime-mission-"));
  });

  afterEach(() => {
    database?.close();
    database = undefined;
    rmSync(temporaryRoot, { recursive: true, force: true });
  });

  it("validates the canonical account before persisting an approval-required mission", async () => {
    const { port, scheduleCalls, accountValidationCalls } = makePort();
    const harness = createHarness(temporaryRoot, port);
    database = harness.database;

    const response = await withSubmitAuth(request(harness.app)
      .post("/api/runtime-missions/autoposter/schedule"))
      .send(validInput());

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      replayed: false,
      product: "auto_poster",
      action: "autoposter.post.schedule",
      status: "approval_required",
      approvalRequired: true,
      approvedBy: null,
      runtimeResult: null,
      evidenceSummary: {
        canonicalAccountReference: "tiktok:account-a",
        policyDecision: "not_evaluated",
        idempotencyOutcome: "not_applicable",
        queueDraftId: null,
        operatorApprovalState: "required",
        releaseApprovalState: "not_started",
        publishingState: "not_started",
        typedError: null,
      },
    });
    expect(response.body.missionId).toBeTruthy();
    expect(response.body.traceId).toBeTruthy();
    expect(response.body.idempotencyKey).toBe(
      `operator-autoposter:${response.body.missionId}`,
    );
    expect(accountValidationCalls).toEqual([
      {
        userId: "owner",
        workspaceId: "workspace-a-00000001",
        accountId: "account-a",
        provider: "tiktok",
      },
    ]);
    expect(scheduleCalls).toHaveLength(0);

    const stored = harness.database
      .prepare("SELECT status, runtime_result_json FROM autoposter_runtime_missions")
      .get() as { status: string; runtime_result_json: string | null };
    expect(stored).toEqual({ status: "approval_required", runtime_result_json: null });
  });

  it("creates once with caller identity and returns a 200 replay before account preflight", async () => {
    const { port, accountValidationCalls, scheduleCalls } = makePort();
    const harness = createHarness(temporaryRoot, port);
    database = harness.database;
    const input = validInput({
      workspaceId: undefined,
      missionId: "mission-stable-001",
      traceId: "trace-stable-001",
      idempotencyKey: "caller-key-stable-001",
      requestedBy: "mcp-client",
    });

    const first = await withSubmitAuth(request(harness.app)
      .post("/api/runtime-missions/autoposter/schedule"))
      .send(input);
    const { missionId: _omittedMissionId, ...retry } = input;
    const replay = await withSubmitAuth(request(harness.app)
      .post("/api/runtime-missions/autoposter/schedule"))
      .send(retry);

    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({
      replayed: false,
      missionId: "mission-stable-001",
      traceId: "trace-stable-001",
      idempotencyKey: "caller-key-stable-001",
      actorId: "mcp-client",
      workspaceId: "workspace-a-00000001",
      status: "approval_required",
    });
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({
      replayed: true,
      missionId: first.body.missionId,
      traceId: first.body.traceId,
      idempotencyKey: first.body.idempotencyKey,
    });
    expect(accountValidationCalls).toEqual([{
      userId: "owner",
      accountId: "account-a",
      provider: "tiktok",
    }]);
    expect(scheduleCalls).toHaveLength(0);
    expect(harness.database.prepare("SELECT COUNT(*) AS count FROM autoposter_runtime_missions").get())
      .toEqual({ count: 1 });
    expect(harness.database.prepare("SELECT COUNT(*) AS count FROM autoposter_mission_journal").get())
      .toEqual({ count: 1 });
  });

  it("records one canonical ledger lineage and appends nothing on exact replay or mismatch", async () => {
    const { port, accountValidationCalls, scheduleCalls } = makePort();
    const harness = createHarness(temporaryRoot, port);
    database = harness.database;
    const input = validInput({
      missionId: "ledger-lineage-mission",
      traceId: "ledger-lineage-trace",
      idempotencyKey: "ledger-lineage-key",
      requestedBy: "mcp-client",
    });

    const created = await harness.missionService.createScheduleMission(input);
    const initialLedger = harness.ledger.getRun(created.missionId);
    expect(initialLedger.transitions.map((entry) => entry.status)).toEqual([
      "created",
      "approval_required",
    ]);

    const completed = await harness.missionService.approveAndExecute(created.missionId, "founder");
    const completedLedger = harness.ledger.getRun(created.missionId);
    expect(completedLedger.transitions.map((entry) => entry.status)).toEqual([
      "created",
      "approval_required",
      "approved",
      "running",
      "validating",
      "completed",
    ]);
    expect(new Set(completedLedger.transitions.map((entry) => entry.run_id))).toEqual(
      new Set([created.missionId]),
    );
    expect(new Set(completedLedger.transitions.map((entry) => entry.trace_id))).toEqual(
      new Set([created.traceId]),
    );
    expect(new Set(completedLedger.transitions.map((entry) => entry.attempt_id)).size).toBe(1);
    expect(completedLedger.transitions.every((entry) => entry.provider === "tiktok")).toBe(true);
    expect(completedLedger.transitions.every((entry) => entry.model === "not_applicable")).toBe(true);
    expect(completedLedger.entry).toMatchObject({
      run_id: created.missionId,
      trace_id: created.traceId,
      status: "completed",
      approval_status: "approved",
      approval_actor: "founder",
      approval_timestamp: expect.any(String),
      validation_result: "passed",
      evidence_count: 1,
      evidence_integrity_status: "verified",
    });

    const stored = harness.database.prepare(
      "SELECT runtime_result_json FROM autoposter_runtime_missions WHERE mission_id = ?",
    ).get(created.missionId) as { runtime_result_json: string };
    const expectedEvidenceHash = createHash("sha256")
      .update(stored.runtime_result_json, "utf8")
      .digest("hex");
    expect(completedLedger.entry.evidence_refs).toEqual([expect.objectContaining({
      sha256: expectedEvidenceHash,
      uri: `operator://runtime-missions/${created.missionId}/runtime-result`,
    })]);

    const exactCreateReplay = await harness.missionService.createScheduleMission(input);
    const exactExecutionReplay = await harness.missionService.approveAndExecute(
      created.missionId,
      "founder",
    );
    expect(exactCreateReplay).toMatchObject({ replayed: true, status: "succeeded" });
    expect(exactExecutionReplay).toMatchObject({ status: "succeeded" });
    expect(harness.ledger.getRun(created.missionId)).toEqual(completedLedger);

    await expect(harness.missionService.createScheduleMission({
      ...input,
      caption: "Changed caption must conflict",
    })).rejects.toMatchObject({
      statusCode: 409,
      code: "OPERATOR_MISSION_PAYLOAD_MISMATCH",
    });
    expect(harness.ledger.getRun(created.missionId)).toEqual(completedLedger);
    expect(accountValidationCalls).toHaveLength(1);
    expect(scheduleCalls).toHaveLength(1);
    expect(completed.runtimeResult).toBeDefined();
  });

  it("returns typed non-leaking 409 conflicts for changed durable bindings", async () => {
    const { port, accountValidationCalls } = makePort();
    const harness = createHarness(temporaryRoot, port);
    database = harness.database;
    const input = validInput({
      missionId: "mission-binding-a",
      traceId: "trace-binding-a",
      idempotencyKey: "key-binding-a",
      requestedBy: "mcp-client",
    });
    const created = await withSubmitAuth(request(harness.app)
      .post("/api/runtime-missions/autoposter/schedule"))
      .send(input);
    expect(created.status).toBe(201);

    const cases: Array<{
      label: string;
      body: Record<string, unknown>;
      code: string;
    }> = [
      {
        label: "changed key",
        body: { ...input, idempotencyKey: "key-binding-changed" },
        code: "OPERATOR_IDEMPOTENCY_MISMATCH",
      },
      {
        label: "changed trace",
        body: { ...input, missionId: undefined, traceId: "trace-binding-changed" },
        code: "OPERATOR_TRACE_MISMATCH",
      },
      {
        label: "changed workspace",
        body: { ...input, missionId: undefined, traceId: undefined, workspaceId: "workspace-b" },
        code: "OPERATOR_MISSION_SCOPE_MISMATCH",
      },
      {
        label: "changed account",
        body: { ...input, missionId: undefined, traceId: undefined, accountId: "account-b" },
        code: "OPERATOR_MISSION_SCOPE_MISMATCH",
      },
      {
        label: "changed provider",
        body: { ...input, missionId: undefined, traceId: undefined, provider: "youtube", title: "Video" },
        code: "OPERATOR_MISSION_SCOPE_MISMATCH",
      },
      {
        label: "changed payload",
        body: { ...input, missionId: undefined, traceId: undefined, caption: "Changed caption" },
        code: "OPERATOR_MISSION_PAYLOAD_MISMATCH",
      },
      {
        label: "changed product",
        body: { ...input, product: "clean_engine" },
        code: "OPERATOR_MISSION_TARGET_MISMATCH",
      },
      {
        label: "changed action",
        body: { ...input, action: "autoposter.post.publish" },
        code: "OPERATOR_MISSION_TARGET_MISMATCH",
      },
    ];

    for (const conflict of cases) {
      const response = await withSubmitAuth(request(harness.app)
        .post("/api/runtime-missions/autoposter/schedule"))
        .send(conflict.body);
      expect(response.status, conflict.label).toBe(409);
      expect(response.body, conflict.label).toEqual({
        error: expect.any(String),
        code: conflict.code,
      });
      expect(JSON.stringify(response.body), conflict.label).not.toMatch(
        /runtimeResult|evidenceSummary|queue-draft|mission-binding-a/,
      );
    }

    const secondInput = validInput({
      missionId: "mission-binding-b",
      traceId: "trace-binding-b",
      idempotencyKey: "key-binding-b",
      requestedBy: "mcp-client",
      caption: "Second mission",
    });
    expect((await withSubmitAuth(request(harness.app)
      .post("/api/runtime-missions/autoposter/schedule"))
      .send(secondInput)).status).toBe(201);

    const splitIdentity = await withSubmitAuth(request(harness.app)
      .post("/api/runtime-missions/autoposter/schedule"))
      .send({ ...input, idempotencyKey: "key-binding-b", traceId: undefined });
    expect(splitIdentity.status).toBe(409);
    expect(splitIdentity.body.code).toBe("OPERATOR_MISSION_IDENTITY_MISMATCH");

    const traceCollision = await withSubmitAuth(request(harness.app)
      .post("/api/runtime-missions/autoposter/schedule"))
      .send({
        ...input,
        missionId: "mission-binding-c",
        idempotencyKey: "key-binding-c",
      });
    expect(traceCollision.status).toBe(409);
    expect(traceCollision.body.code).toBe("OPERATOR_TRACE_MISMATCH");
    expect(accountValidationCalls).toHaveLength(2);
    expect(harness.database.prepare("SELECT COUNT(*) AS count FROM autoposter_runtime_missions").get())
      .toEqual({ count: 2 });
  });

  it("accepts the canonical envelope ingress and rejects an unsupported target", async () => {
    const { port, accountValidationCalls } = makePort();
    const harness = createHarness(temporaryRoot, port);
    database = harness.database;
    const scheduledAt = futureIso();
    const envelope = {
      schemaVersion: "chanter.mission.v1",
      missionId: "envelope-mission-001",
      traceId: "envelope-trace-001",
      idempotencyKey: "envelope-key-001",
      source: { system: "mcp", requestedBy: "mcp-envelope-client" },
      objective: "Create one unapproved AutoPoster schedule draft.",
      target: { product: "auto_poster", action: "autoposter.post.schedule" },
      tenant: { userId: "owner", accountId: "account-a" },
      input: {
        accountId: "account-a",
        provider: "tiktok",
        mediaUrl: "https://cdn.example.com/video.mp4",
        caption: "Envelope clip",
        hashtags: "#chanter",
        scheduledAt,
      },
      constraints: ["No publishing"],
      acceptanceCriteria: ["One unapproved draft"],
      requestedAt: new Date().toISOString(),
    };

    const first = await withSubmitAuth(request(harness.app)
      .post("/api/runtime-missions"))
      .send(envelope);
    const replay = await withSubmitAuth(request(harness.app)
      .post("/api/runtime-missions"))
      .send(envelope);
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({
      replayed: false,
      missionId: envelope.missionId,
      traceId: envelope.traceId,
      actorId: "mcp-envelope-client",
      workspaceId: "workspace-a-00000001",
    });
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ replayed: true, missionId: envelope.missionId });
    expect(accountValidationCalls).toHaveLength(1);

    const unsupportedInput = await withSubmitAuth(request(harness.app)
      .post("/api/runtime-missions"))
      .send({
        ...envelope,
        input: { ...envelope.input, unregisteredControl: "must-not-be-ignored" },
      });
    expect(unsupportedInput.status).toBe(400);
    expect(unsupportedInput.body).toEqual({
      error: "The mission input contains a field that is not registered for this action.",
      code: "OPERATOR_MISSION_INPUT_UNSUPPORTED_FIELD",
    });
    expect(accountValidationCalls).toHaveLength(1);
    expect(harness.database.prepare(
      "SELECT COUNT(*) AS count FROM autoposter_runtime_missions",
    ).get()).toEqual({ count: 1 });

    const unsupported = await withSubmitAuth(request(harness.app)
      .post("/api/runtime-missions"))
      .send({
        ...envelope,
        target: { product: "clean_engine", action: "clean_engine.image.clean" },
      });
    expect(unsupported.status).toBe(409);
    expect(unsupported.body).toEqual({
      error: "The mission target is not registered with the Operator gateway.",
      code: "OPERATOR_MISSION_TARGET_MISMATCH",
    });
  });

  it("protects every real mission-write and ledger-ingest route before domain handling", async () => {
    const { port } = makePort();
    const harness = createHarness(temporaryRoot, port);
    database = harness.database;
    const routes = [
      { path: "/api/runtime-missions", token: MISSION_SUBMIT_TOKEN },
      { path: "/api/runtime-missions/autoposter/schedule", token: MISSION_SUBMIT_TOKEN },
      { path: "/api/runtime-missions/missing/approve", token: MISSION_CONTROL_TOKEN },
      { path: "/api/runtime-missions/missing/reconcile", token: MISSION_CONTROL_TOKEN },
      { path: "/api/runtime-missions/missing/resume", token: MISSION_CONTROL_TOKEN },
      { path: "/api/runtime-missions/missing/stop", token: MISSION_CONTROL_TOKEN },
      { path: "/api/agent-run-ledger/entries", token: LEDGER_INGEST_TOKEN },
    ];

    for (const route of routes) {
      const missing = await request(harness.rawApp).post(route.path).send({});
      expect(missing.status, route.path).toBe(401);
      expect(missing.body.code, route.path).toBe("CAPABILITY_TOKEN_INVALID");

      const wrong = await request(harness.rawApp)
        .post(route.path)
        .set("Authorization", "Bearer wrong-capability-token")
        .send({});
      expect(wrong.status, route.path).toBe(401);
      expect(wrong.body.code, route.path).toBe("CAPABILITY_TOKEN_INVALID");

      const valid = await request(harness.rawApp)
        .post(route.path)
        .set("Authorization", `Bearer ${route.token}`)
        .send({});
      expect(valid.status, route.path).not.toBe(401);
      expect(valid.status, route.path).not.toBe(503);
    }
  });

  it("keeps submit, Operator control, AutoPoster service, and ledger capabilities non-substitutable", async () => {
    const { port, scheduleCalls } = makePort();
    const harness = createHarness(temporaryRoot, port);
    database = harness.database;

    const controlCannotSubmit = await request(harness.rawApp)
      .post("/api/runtime-missions/autoposter/schedule")
      .set("Authorization", `Bearer ${MISSION_CONTROL_TOKEN}`)
      .send(validInput());
    expect(controlCannotSubmit.status).toBe(401);

    const created = await request(harness.rawApp)
      .post("/api/runtime-missions/autoposter/schedule")
      .set("Authorization", `Bearer ${MISSION_SUBMIT_TOKEN}`)
      .send(validInput());
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ status: "approval_required", approvedBy: null });
    expect(scheduleCalls).toHaveLength(0);

    const controlPaths = ["approve", "reconcile", "resume", "stop"];
    const nonControlTokens = [MISSION_SUBMIT_TOKEN, TOKEN_CANARY, LEDGER_INGEST_TOKEN];
    for (const action of controlPaths) {
      for (const [tokenIndex, token] of nonControlTokens.entries()) {
        const rejected = await request(harness.rawApp)
          .post(`/api/runtime-missions/${created.body.missionId}/${action}`)
          .set("Authorization", `Bearer ${token}`)
          .send(action === "approve" ? { approvedBy: "founder" } : {});
        expect(rejected.status, `${action}:token-${tokenIndex}`).toBe(401);
        expect(rejected.body.code, `${action}:token-${tokenIndex}`).toBe("CAPABILITY_TOKEN_INVALID");
      }
    }

    expect(harness.missionService.getMission(created.body.missionId)).toMatchObject({
      status: "approval_required",
      approvedBy: null,
      runtimeResult: null,
    });
    expect(scheduleCalls).toHaveLength(0);

    const approved = await request(harness.rawApp)
      .post(`/api/runtime-missions/${created.body.missionId}/approve`)
      .set("Authorization", `Bearer ${MISSION_CONTROL_TOKEN}`)
      .send({ approvedBy: "founder" });
    expect(approved.status).toBe(200);
    expect(approved.body).toMatchObject({ status: "succeeded", approvedBy: "founder" });
    expect(scheduleCalls).toHaveLength(1);
  });

  it("replays an executed mission after database and service recreation", async () => {
    const { port, accountValidationCalls, scheduleCalls } = makePort();
    const input = validInput({
      missionId: "restart-create-mission",
      traceId: "restart-create-trace",
      idempotencyKey: "restart-create-key",
      requestedBy: "mcp-client",
    });
    const first = createHarness(temporaryRoot, port);
    database = first.database;
    const created = await first.missionService.createScheduleMission(input);
    const completed = await first.missionService.approveAndExecute(created.missionId, "founder");
    const ledgerBeforeRestart = first.ledger.getRun(created.missionId);
    first.database.close();
    database = undefined;

    const restarted = createHarness(temporaryRoot, port);
    database = restarted.database;
    const { missionId: _omittedMissionId, ...retry } = input;
    const replay = await withSubmitAuth(request(restarted.app)
      .post("/api/runtime-missions/autoposter/schedule"))
      .send(retry);
    const executionReplay = await restarted.missionService.approveAndExecute(
      created.missionId,
      "founder",
    );

    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({
      replayed: true,
      missionId: created.missionId,
      traceId: created.traceId,
      status: "succeeded",
      runtimeResult: completed.runtimeResult,
    });
    expect(accountValidationCalls).toHaveLength(1);
    expect(scheduleCalls).toHaveLength(1);
    expect(executionReplay.runtimeResult).toEqual(completed.runtimeResult);
    expect(restarted.ledger.getRun(created.missionId)).toEqual(ledgerBeforeRestart);
  });

  it("recovers a typed commercial denial only through explicit reconcile and resume", async () => {
    let commercialAllowed = false;
    let scheduleAttempts = 0;
    const { port, accountValidationCalls } = makePort({
      async schedulePost(params) {
        scheduleAttempts += 1;
        if (!commercialAllowed) {
          return {
            ok: false,
            code: "forbidden",
            message: "Runtime scheduling is not included in this plan.",
            details: {
              reasonCode: "runtime_scheduling_not_allowed",
              planId: "starter",
              workspaceId: params.workspaceId,
            },
          };
        }
        return {
          ok: true,
          duplicate: false,
          post: {
            id: "commercial-recovery-draft",
            accountId: params.accountId,
            provider: params.provider ?? "tiktok",
            status: "scheduled",
            scheduledAt: params.scheduledAt,
            approved: false,
          },
        };
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
    });
    const harness = createHarness(temporaryRoot, port);
    database = harness.database;
    const input = validInput({
      missionId: "commercial-recovery-mission",
      traceId: "commercial-recovery-trace",
      idempotencyKey: "commercial-recovery-key",
      requestedBy: "mcp-client",
    });

    const created = await harness.missionService.createScheduleMission(input);
    const denied = await harness.missionService.approveAndExecute(created.missionId, "founder");
    expect(denied).toMatchObject({
      status: "denied",
      execution: {
        state: "failed_recoverable",
        recoveryClassification: "RECOVERY_COMMERCIAL_DENIAL",
        nextPermittedActions: ["Reconcile", "Stop / escalate"],
      },
    });

    const rawReplay = await harness.missionService.createScheduleMission(input);
    expect(rawReplay).toMatchObject({ replayed: true, status: "denied" });
    expect(scheduleAttempts).toBe(1);
    expect(accountValidationCalls).toHaveLength(1);
    expect(harness.ledger.getRun(created.missionId).transitions.map((entry) => entry.status)).toEqual([
      "created",
      "approval_required",
      "approved",
      "running",
      "reconciliation_required",
    ]);

    commercialAllowed = true;
    const reconciled = await harness.missionService.reconcileMission(created.missionId);
    expect(reconciled.execution).toMatchObject({
      state: "failed_recoverable",
      reconciliationOutcome: "not_found",
      nextPermittedActions: ["Reconcile", "Resume safely", "Stop / escalate"],
    });
    const recovered = await harness.missionService.resumeSafely(created.missionId);
    expect(recovered).toMatchObject({
      status: "succeeded",
      execution: { state: "completed", recoveryClassification: "SAFE_RETRY_COMPLETED" },
    });
    const stableReplay = await harness.missionService.createScheduleMission(input);
    expect(stableReplay).toMatchObject({ replayed: true, status: "succeeded" });
    expect(scheduleAttempts).toBe(2);
    expect(accountValidationCalls).toHaveLength(1);
    const recoveredLedger = harness.ledger.getRun(created.missionId);
    expect(recoveredLedger.transitions.map((entry) => entry.status)).toEqual([
      "created",
      "approval_required",
      "approved",
      "running",
      "reconciliation_required",
      "running",
      "reconciliation_required",
      "running",
      "validating",
      "completed",
    ]);
    expect(new Set(recoveredLedger.transitions.map((entry) => entry.attempt_id)).size).toBe(1);
  });

  it("loads the workspace-scoped canonical account registry through the existing Runtime port", async () => {
    const { port, accountListCalls } = makePort();
    const harness = createHarness(temporaryRoot, port);
    database = harness.database;

    const response = await request(harness.app)
      .get("/api/runtime-missions/autoposter/connected-accounts")
      .query({ workspaceId: "workspace-a-00000001" });

    expect(response.status).toBe(200);
    expect(accountListCalls).toEqual([
      { userId: "owner", workspaceId: "workspace-a-00000001" },
    ]);
    expect(response.body).toMatchObject({
      ok: true,
      workspaceId: "workspace-a-00000001",
      count: 2,
      accounts: [
        {
          connectedAccountId: "tiktok:account-a",
          provider: "tiktok",
          accountId: "account-a",
          connectionStatus: "connected",
          publishingReady: true,
        },
        {
          connectedAccountId: "youtube:UC-ExactCase",
          provider: "youtube",
          accountId: "UC-ExactCase",
          connectionStatus: "connected",
          publishingReady: true,
        },
      ],
    });
    expect(JSON.stringify(response.body)).not.toMatch(/access.?token|refresh.?token|credential/i);
  });

  it.each([
    ["ACCOUNT-A", "account_id_case_mismatch", 409],
    ["missing-account", "unknown_account_id", 404],
    ["account-a", "account_workspace_mismatch", 409],
    ["account-a", "provider_account_mismatch", 409],
    ["account-a", "account_disconnected", 409],
    ["account-a", "account_not_publishing_ready", 409],
  ] as const)(
    "rejects %s with typed %s before any approval-ready mission is persisted",
    async (accountId, reasonCode, expectedStatus) => {
      const { port, scheduleCalls } = makePort({
        async validateConnectedAccount() {
          return {
            ok: false,
            code: reasonCode === "unknown_account_id" ? "not_found" : "validation_failed",
            message: `Rejected with ${reasonCode}.`,
            details: { reasonCode },
          };
        },
      });
      const harness = createHarness(path.join(temporaryRoot, reasonCode), port);

      const response = await request(harness.app)
        .post("/api/runtime-missions/autoposter/schedule")
        .send(validInput({ accountId }));

      expect(response.status).toBe(expectedStatus);
      expect(response.body).toMatchObject({ code: reasonCode });
      expect(scheduleCalls).toHaveLength(0);
      expect(harness.missionService.listMissions()).toHaveLength(0);
      harness.database.close();
    },
  );

  it("rejects whitespace-changing account IDs locally instead of normalizing opaque identity", async () => {
    const { port, accountValidationCalls, scheduleCalls } = makePort();
    const harness = createHarness(temporaryRoot, port);
    database = harness.database;

    const response = await withSubmitAuth(request(harness.app)
      .post("/api/runtime-missions/autoposter/schedule"))
      .send(validInput({ accountId: " account-a " }));

    expect(response.status).toBe(409);
    expect(response.body.code).toBe("account_id_non_canonical");
    expect(accountValidationCalls).toHaveLength(0);
    expect(scheduleCalls).toHaveLength(0);
    expect(harness.missionService.listMissions()).toHaveLength(0);
  });

  it("validates the bounded provider, media URL, YouTube metadata, and schedule shape", async () => {
    const { port, scheduleCalls } = makePort();
    const harness = createHarness(temporaryRoot, port);
    database = harness.database;

    const invalidInputs = [
      validInput({ provider: "instagram" }),
      validInput({ mediaUrl: "http://cdn.example.com/video.mp4" }),
      validInput({ mediaUrl: "https://cdn.example.com/video.mp4?token=secret" }),
      validInput({ provider: "youtube" }),
      validInput({ scheduledAt: "2026-07-15T12:00:00" }),
      validInput({ scheduledAt: "2020-01-01T00:00:00Z" }),
      validInput({ caption: "x".repeat(2_201) }),
    ];

    for (const input of invalidInputs) {
      const response = await request(harness.app)
        .post("/api/runtime-missions/autoposter/schedule")
        .send(input);
      expect(response.status).toBe(400);
    }
    expect(scheduleCalls).toHaveLength(0);
    expect(harness.missionService.listMissions()).toHaveLength(0);
  });

  it("refuses missing or blank approval without executing", async () => {
    const { port, scheduleCalls } = makePort();
    const harness = createHarness(temporaryRoot, port);
    database = harness.database;
    const created = (
      await request(harness.app)
        .post("/api/runtime-missions/autoposter/schedule")
        .send(validInput())
    ).body as AutoPosterRuntimeMission;

    const missing = await withControlAuth(request(harness.app).post(
      `/api/runtime-missions/${created.missionId}/approve`),
    );
    const blank = await withControlAuth(request(harness.app)
      .post(`/api/runtime-missions/${created.missionId}/approve`))
      .send({ approvedBy: "   " });

    expect(missing.status).toBe(400);
    expect(blank.status).toBe(400);
    expect(scheduleCalls).toHaveLength(0);
    expect(harness.missionService.getMission(created.missionId).status).toBe(
      "approval_required",
    );
  });

  it("executes through the real Runtime adapter with stable trace, workspace, and exact fields", async () => {
    const { port, scheduleCalls } = makePort();
    const harness = createHarness(temporaryRoot, port);
    database = harness.database;
    const input = validInput({
      provider: "youtube",
      title: "Private launch",
      description: "Founder-supervised draft",
    });
    const created = (
      await request(harness.app)
        .post("/api/runtime-missions/autoposter/schedule")
        .send(input)
    ).body as AutoPosterRuntimeMission;

    const approved = await withControlAuth(request(harness.app)
      .post(`/api/runtime-missions/${created.missionId}/approve`))
      .send({ approvedBy: "founder" });

    expect(approved.status).toBe(200);
    expect(scheduleCalls).toHaveLength(1);
    expect(scheduleCalls[0]).toMatchObject({
      userId: "owner",
      workspaceId: created.workspaceId,
      accountId: created.accountId,
      provider: "youtube",
      mediaUrl: created.mediaUrl,
      caption: created.caption,
      hashtags: created.hashtags,
      title: "Private launch",
      description: "Founder-supervised draft",
      scheduledAt: created.scheduledAt,
      idempotencyKey: created.idempotencyKey,
      requestedBy: "chanter-operator",
      traceId: created.traceId,
    });
    expect(approved.body).toMatchObject({
      status: "succeeded",
      approvedBy: "founder",
      runtimeResult: {
        missionId: created.missionId,
        traceId: created.traceId,
        status: "succeeded",
        approvalDecision: { required: true, approved: true, approvedBy: "founder" },
        idempotency: { key: created.idempotencyKey, outcome: "first_execution" },
        output: {
          post: { id: "queue-draft-1", approved: false },
          publishing: "blocked_until_human_approval",
        },
      },
      evidenceSummary: {
        missionId: created.missionId,
        traceId: created.traceId,
        workspaceId: created.workspaceId,
        provider: "youtube",
        canonicalAccountReference: `youtube:${created.accountId}`,
        policyDecision: "allowed",
        idempotencyOutcome: "first_execution",
        queueDraftId: "queue-draft-1",
        persistedDraftStatus: "scheduled",
        operatorApprovalState: "approved",
        releaseApprovalState: "required",
        publishingState: "blocked_until_human_approval",
        typedError: null,
      },
    });
    expect(approved.body.runtimeResult.evidence).toBeTruthy();
  });

  it("fails closed when a successful-looking draft belongs to a different account", async () => {
    const { port } = makePort({
      async schedulePost(params) {
        return {
          ok: true,
          duplicate: false,
          post: {
            id: "wrong-account-draft",
            accountId: "account-b",
            provider: params.provider ?? "tiktok",
            status: "scheduled",
            scheduledAt: params.scheduledAt,
            approved: false,
          },
        };
      },
    });
    const harness = createHarness(temporaryRoot, port);
    database = harness.database;
    const mission = await harness.missionService.createScheduleMission(validInput());

    const result = await harness.missionService.approveAndExecute(
      mission.missionId,
      "founder",
    );

    expect(result.status).toBe("failed");
    expect(result.runtimeResult).toMatchObject({
      status: "failed",
      output: null,
      errors: [{ code: "AUTOPOSTER_UNSAFE_SCHEDULE_RESPONSE" }],
      evidence: { result: { success: false } },
    });
    expect(result.evidenceSummary).toMatchObject({
      queueDraftId: null,
      persistedDraftStatus: null,
      releaseApprovalState: "not_started",
      publishingState: "not_started",
      typedError: { code: "AUTOPOSTER_UNSAFE_SCHEDULE_RESPONSE" },
    });
  });

  it("stores downstream unavailable, commercial denial, and validation failure truthfully", async () => {
    const scenarios = [
      {
        suffix: "unavailable",
        failure: { ok: false as const, code: "unavailable" as const, message: "AutoPoster is unreachable." },
        expected: "unavailable",
      },
      {
        suffix: "denied",
        failure: {
          ok: false as const,
          code: "forbidden" as const,
          message: "Runtime scheduling is not included in this plan.",
          details: {
            reasonCode: "runtime_scheduling_not_allowed",
            current: 0,
            limit: 0,
            remaining: 0,
            planId: "starter",
            workspaceId: "workspace-a-00000001",
          },
        },
        expected: "denied",
      },
      {
        suffix: "invalid",
        failure: { ok: false as const, code: "validation_failed" as const, message: "Media was rejected." },
        expected: "validation_failed",
      },
    ];

    for (const scenario of scenarios) {
      const scenarioRoot = path.join(temporaryRoot, scenario.suffix);
      const { port } = makePort({
        async schedulePost() {
          return scenario.failure;
        },
      });
      const harness = createHarness(scenarioRoot, port);
      const created = await harness.missionService.createScheduleMission(validInput());
      const result = await harness.missionService.approveAndExecute(
        created.missionId,
        "founder",
      );
      expect(result.status).toBe(scenario.expected);
      expect(result.runtimeResult?.status).toBe(scenario.expected);
      expect(result.runtimeResult?.evidence).toBeTruthy();
      expect(result.evidenceSummary).toMatchObject({
        operatorApprovalState: "approved",
        releaseApprovalState: "not_started",
        publishingState: "not_started",
        typedError: { code: expect.stringMatching(/^AUTOPOSTER_/) },
      });
      if (scenario.expected === "denied") {
        expect(result.runtimeResult?.output).toMatchObject({
          reasonCode: "runtime_scheduling_not_allowed",
          planId: "starter",
        });
      }
      harness.database.close();
    }
  });

  it("refuses to persist an approval-ready mission when account validation is unconfigured", async () => {
    const { port } = makePort();
    const harness = createHarness(temporaryRoot, port, {
      baseUrl: "",
      serviceToken: "",
      userId: "",
      timeoutValid: true,
    });
    database = harness.database;
    expect(harness.missionService.getReadiness().configured).toBe(false);
    await expect(harness.missionService.createScheduleMission(validInput())).rejects.toMatchObject({
      statusCode: 503,
      code: "autoposter_unavailable",
    });
    expect(harness.missionService.listMissions()).toHaveLength(0);
  });

  it("fails closed for each missing or invalid configuration field", async () => {
    const configurations = [
      validConfiguration({ baseUrl: "" }),
      validConfiguration({ serviceToken: "" }),
      validConfiguration({ userId: "" }),
      validConfiguration({ timeoutMs: 0 }),
      validConfiguration({ timeoutValid: false }),
    ];

    for (const [index, configuration] of configurations.entries()) {
      const { port, scheduleCalls } = makePort();
      const harness = createHarness(
        path.join(temporaryRoot, `unconfigured-${index}`),
        port,
        configuration,
      );
      await expect(harness.missionService.createScheduleMission(validInput())).rejects.toMatchObject({
        code: "autoposter_unavailable",
      });

      expect(harness.missionService.getReadiness().configured).toBe(false);
      expect(scheduleCalls).toHaveLength(0);
      expect(harness.missionService.listMissions()).toHaveLength(0);
      harness.database.close();
    }
  });

  it("returns the stored terminal result on repeated approval without creating twice", async () => {
    const { port, scheduleCalls } = makePort();
    const harness = createHarness(temporaryRoot, port);
    database = harness.database;
    const created = await harness.missionService.createScheduleMission(validInput());

    const first = await harness.missionService.approveAndExecute(
      created.missionId,
      "founder",
    );
    await expect(harness.missionService.approveAndExecute(
      created.missionId,
      "another-founder",
    )).rejects.toMatchObject({ code: "OPERATOR_APPROVAL_BINDING_MISMATCH" });
    const second = await harness.missionService.approveAndExecute(
      created.missionId,
      "founder",
    );

    expect(scheduleCalls).toHaveLength(1);
    expect(second.runtimeResult).toEqual(first.runtimeResult);
    expect(second.execution?.state).toBe("completed");
    expect(second.execution?.authoritativeQueueId).toBe("queue-draft-1");
    expect(second.execution?.recoveryClassification).toBe("DURABLE_REPLAY");
    expect(second.executionJournal).toHaveLength(first.executionJournal.length + 1);
    expect(second.approvedBy).toBe("founder");
  });

  it("serializes concurrent approvals before the network boundary", async () => {
    let releaseSchedule: (() => void) | undefined;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseSchedule = resolve;
    });
    let calls = 0;
    const { port } = makePort({
      async schedulePost(params) {
        calls += 1;
        markStarted?.();
        await release;
        return {
          ok: true,
          duplicate: false,
          post: {
            id: "queue-concurrent",
            accountId: params.accountId,
            provider: params.provider ?? "tiktok",
            status: "scheduled",
            scheduledAt: params.scheduledAt,
            approved: false,
          },
        };
      },
    });
    const harness = createHarness(temporaryRoot, port);
    database = harness.database;
    const created = await harness.missionService.createScheduleMission(validInput());

    const firstPromise = withControlAuth(request(harness.app)
      .post(`/api/runtime-missions/${created.missionId}/approve`))
      .send({ approvedBy: "founder-a" })
      .then((response) => response);
    await started;
    const second = await withControlAuth(request(harness.app)
      .post(`/api/runtime-missions/${created.missionId}/approve`))
      .send({ approvedBy: "founder-b" });
    releaseSchedule?.();
    const first = await firstPromise;

    expect(first.status).toBe(200);
    expect(first.body.status).toBe("succeeded");
    expect(second.status).toBe(409);
    expect(calls).toBe(1);
  });

  it("survives database and service recreation with immutable inputs and result", async () => {
    const databasePath = path.join(temporaryRoot, "data", "operator.sqlite");
    const { port } = makePort();
    const firstDatabase = createDatabase(databasePath);
    const executor = createAutoPosterRuntimeMissionExecutor(validConfiguration(), { port });
    const firstService = new AutoPosterMissionService(firstDatabase, executor, {
      agentRunLedgerService: new AgentRunLedgerService(firstDatabase),
    });
    const created = await firstService.createScheduleMission(validInput());
    const completed = await firstService.approveAndExecute(created.missionId, "founder");
    firstDatabase.close();

    const reopenedDatabase = createDatabase(databasePath);
    database = reopenedDatabase;
    const reopenedService = new AutoPosterMissionService(reopenedDatabase, executor, {
      agentRunLedgerService: new AgentRunLedgerService(reopenedDatabase),
    });
    const reopened = reopenedService.getMission(created.missionId);

    expect(reopened).toEqual(completed);
    expect(reopened.mediaUrl).toBe(created.mediaUrl);
    expect(reopened.workspaceId).toBe(created.workspaceId);
    expect(reopened.runtimeResult?.output).toMatchObject({
      post: { id: "queue-draft-1", approved: false },
    });
  });

  it("redacts downstream secrets from result, database, API, and audit surfaces", async () => {
    const { port } = makePort({
      async schedulePost() {
        return {
          ok: false,
          code: "internal",
          message: `Queue failure echoed ${TOKEN_CANARY}`,
        };
      },
    });
    const harness = createHarness(temporaryRoot, port);
    database = harness.database;
    const created = await harness.missionService.createScheduleMission(validInput({
      ignoredToken: TOKEN_CANARY,
      planId: "caller-supplied-plan",
    }));
    const approved = await withControlAuth(request(harness.app)
      .post(`/api/runtime-missions/${created.missionId}/approve`))
      .send({ approvedBy: "founder", token: TOKEN_CANARY });
    const rawRows = JSON.stringify(
      harness.database.prepare("SELECT * FROM autoposter_runtime_missions").all(),
    );
    const auditContents = existsSync(harness.auditPath)
      ? readFileSync(harness.auditPath, "utf8")
      : "";
    const serialized = [JSON.stringify(approved.body), rawRows, auditContents].join("\n");

    expect(approved.status).toBe(200);
    expect(serialized).not.toContain(TOKEN_CANARY);
    expect(serialized).not.toContain("caller-supplied-plan");
    expect(serialized).toContain("[REDACTED]");
  });

  it("rejects every configured capability token before mission input or approval can persist", async () => {
    const { port } = makePort();
    const harness = createHarness(temporaryRoot, port);
    database = harness.database;

    const protectedValues = [
      TOKEN_CANARY,
      MISSION_SUBMIT_TOKEN,
      MISSION_CONTROL_TOKEN,
      LEDGER_INGEST_TOKEN,
    ];
    const rejectedCreations = [];
    for (const protectedValue of protectedValues) {
      rejectedCreations.push(await withSubmitAuth(request(harness.app)
        .post("/api/runtime-missions/autoposter/schedule"))
        .send(validInput({ caption: `Never store ${protectedValue}` })));
    }
    const mission = await harness.missionService.createScheduleMission(validInput());
    const rejectedApprovals = [];
    for (const protectedValue of protectedValues) {
      rejectedApprovals.push(await withControlAuth(request(harness.app)
        .post(`/api/runtime-missions/${mission.missionId}/approve`))
        .send({ approvedBy: protectedValue }));
    }
    const rawRows = JSON.stringify(
      harness.database.prepare("SELECT * FROM autoposter_runtime_missions").all(),
    );
    const serializedResponses = JSON.stringify([
      ...rejectedCreations.map((response) => response.body),
      ...rejectedApprovals.map((response) => response.body),
    ]);

    for (const response of [...rejectedCreations, ...rejectedApprovals]) {
      expect(response.status).toBe(400);
    }
    for (const protectedValue of protectedValues) {
      expect(serializedResponses).not.toContain(protectedValue);
      expect(rawRows).not.toContain(protectedValue);
    }
    expect(harness.missionService.listMissions()).toHaveLength(1);
    expect(harness.missionService.getMission(mission.missionId)).toMatchObject({
      status: "approval_required",
      approvedBy: null,
      runtimeResult: null,
    });
  });

  it("reports generic mock truth separately from bounded AutoPoster readiness", async () => {
    const { port } = makePort();
    const harness = createHarness(temporaryRoot, port);
    database = harness.database;

    const response = await request(harness.app).get("/api/health");

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      runner: "mock",
      mode: "safe / review-only",
      execution: "contained_simulation",
      real_execution_enabled: false,
      network_execution_enabled: false,
      missionSubmit: {
        configured: true,
        endpoints: [
          "/api/runtime-missions",
          "/api/runtime-missions/autoposter/schedule",
          "/api/safecommit-closeouts",
          "/api/safecommit-closeouts/:requestId",
        ],
      },
      missionControl: {
        configured: true,
        isolated: true,
        ready: true,
        endpoints: [
          "/api/runtime-missions/:missionId/approve",
          "/api/runtime-missions/:missionId/reconcile",
          "/api/runtime-missions/:missionId/resume",
          "/api/runtime-missions/:missionId/stop",
          "/api/safecommit-closeouts/:requestId/approve",
          "/api/safecommit-closeouts/:requestId/revoke",
        ],
      },
      safeCommitExecutor: {
        configured: true,
        isolated: true,
        ready: true,
        endpoints: [
          "/api/safecommit-closeouts/:requestId/claim",
          "/api/safecommit-closeouts/:requestId/invalidate",
          "/api/safecommit-closeouts/:requestId/complete",
        ],
      },
      ledgerIngest: {
        configured: true,
        endpoints: ["/api/agent-run-ledger/entries"],
      },
      runtimeMissions: {
        autoposter: {
          configured: true,
          executionScope: "schedule_unapproved_draft_only",
          actions: ["autoposter.post.schedule"],
          publishingEnabled: false,
        },
      },
    });
    const serializedHealth = JSON.stringify(response.body);
    for (const protectedValue of [
      TOKEN_CANARY,
      MISSION_SUBMIT_TOKEN,
      MISSION_CONTROL_TOKEN,
      SAFECOMMIT_EXECUTOR_TOKEN,
      LEDGER_INGEST_TOKEN,
    ]) {
      expect(serializedHealth).not.toContain(protectedValue);
    }
  });

  it("lists missions newest-first and keeps immutable execution inputs read-only", async () => {
    const { port } = makePort();
    const harness = createHarness(temporaryRoot, port);
    database = harness.database;
    const first = await harness.missionService.createScheduleMission(validInput({ caption: "first" }));
    const second = await harness.missionService.createScheduleMission(validInput({ caption: "second" }));
    harness.database
      .prepare("UPDATE autoposter_runtime_missions SET created_at = ? WHERE mission_id = ?")
      .run("2026-01-01T00:00:00.000Z", first.missionId);
    harness.database
      .prepare("UPDATE autoposter_runtime_missions SET created_at = ? WHERE mission_id = ?")
      .run("2026-01-02T00:00:00.000Z", second.missionId);

    const listed = await request(harness.app).get("/api/runtime-missions?limit=1");
    const attemptedUpdate = await request(harness.app)
      .put(`/api/runtime-missions/${first.missionId}`)
      .send({ caption: "mutated" });

    expect(listed.status).toBe(200);
    expect(listed.body.missions).toHaveLength(1);
    expect(listed.body.missions[0].missionId).toBe(second.missionId);
    expect(attemptedUpdate.status).toBe(404);
    expect(harness.missionService.getMission(first.missionId).caption).toBe("first");
  });

  it("exposes bounded reconcile, resume safely, and stop/escalate recovery controls", async () => {
    let scheduleAttempts = 0;
    let durablePost: {
      id: string;
      accountId: string;
      provider: string;
      status: string;
      scheduledAt: string;
      approved: boolean;
    } | null = null;
    const reconciliationCalls: unknown[] = [];
    const { port } = makePort({
      async schedulePost(params) {
        scheduleAttempts += 1;
        durablePost = {
          id: `recovered-queue-${scheduleAttempts}`,
          accountId: params.accountId,
          provider: params.provider ?? "tiktok",
          status: "scheduled",
          scheduledAt: params.scheduledAt,
          approved: false,
        };
        throw new Error("Simulated Runtime interruption after durable queue creation.");
      },
      async reconcileSchedule(params) {
        reconciliationCalls.push(params);
        if (!durablePost) throw new Error("Expected durable downstream truth.");
        return {
          ok: true,
          outcome: "unique",
          count: 1,
          unique: true,
          safeToReuse: true,
          approvalState: "required",
          publishingState: "blocked_until_human_approval",
          evidenceStatus: "authoritative",
          post: durablePost,
        };
      },
    });
    const harness = createHarness(temporaryRoot, port);
    database = harness.database;

    const created = await withSubmitAuth(request(harness.app)
      .post("/api/runtime-missions/autoposter/schedule"))
      .send(validInput());
    const interrupted = await request(harness.app)
      .post(`/api/runtime-missions/${created.body.missionId}/approve`)
      .send({ approvedBy: "founder" });
    expect(interrupted.status).toBe(200);
    expect(interrupted.body.execution).toMatchObject({
      state: "failed_recoverable",
      nextPermittedActions: ["Reconcile", "Stop / escalate"],
    });

    const reconciled = await request(harness.app)
      .post(`/api/runtime-missions/${created.body.missionId}/reconcile`)
      .send({});
    expect(reconciled.status).toBe(200);
    expect(reconciled.body.execution).toMatchObject({
      state: "downstream_result_observed",
      authoritativeQueueId: "recovered-queue-1",
      nextPermittedActions: ["Resume safely"],
    });
    expect(reconciliationCalls).toHaveLength(1);

    const rejectedStop = await request(harness.app)
      .post(`/api/runtime-missions/${created.body.missionId}/stop`)
      .send({});
    expect(rejectedStop.status).toBe(409);
    expect(rejectedStop.body.code).toBe("RECOVERY_ACTION_NOT_PERMITTED");

    const resumed = await request(harness.app)
      .post(`/api/runtime-missions/${created.body.missionId}/resume`)
      .send({});
    expect(resumed.status).toBe(200);
    expect(resumed.body.execution).toMatchObject({
      state: "completed",
      authoritativeQueueId: "recovered-queue-1",
      recoveryClassification: "RECOVERED_EXISTING_DOWNSTREAM_RESULT",
    });
    expect(scheduleAttempts).toBe(1);

    const second = await withSubmitAuth(request(harness.app)
      .post("/api/runtime-missions/autoposter/schedule"))
      .send(validInput({ caption: "stop this recovery" }));
    await withControlAuth(request(harness.app)
      .post(`/api/runtime-missions/${second.body.missionId}/approve`))
      .send({ approvedBy: "founder" });
    const stopped = await request(harness.app)
      .post(`/api/runtime-missions/${second.body.missionId}/stop`)
      .send({});
    expect(stopped.status).toBe(200);
    expect(stopped.body.execution).toMatchObject({
      state: "failed_terminal",
      recoveryClassification: "STOPPED_FOR_ESCALATION",
      nextPermittedActions: [],
    });
  });

  it("keeps route and mission service source free of direct HTTP and AutoPoster routes", () => {
    const root = path.resolve(import.meta.dirname, "..");
    const routeSource = readFileSync(path.join(root, "src", "routes", "api.ts"), "utf8");
    const serviceSource = readFileSync(
      path.join(root, "src", "runtimeMissions", "autoPosterMissionService.ts"),
      "utf8",
    );

    for (const source of [routeSource, serviceSource]) {
      expect(source).not.toMatch(/\bfetch\s*\(/);
      expect(source).not.toContain("/api/runtime/schedule");
      expect(source).not.toContain("x-chanter-runtime-token");
    }
  });
});
