import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  AutoPosterOperationsPort,
  AutoPosterScheduleParams,
} from "chanter-agent-runtime";
import { createApp } from "../src/app.js";
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
} {
  const scheduleCalls: AutoPosterScheduleParams[] = [];
  const port: AutoPosterOperationsPort = {
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
  return { port, scheduleCalls };
}

interface Harness {
  database: DatabaseSync;
  auditPath: string;
  missionService: AutoPosterMissionService;
  app: ReturnType<typeof createApp>;
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
  const missionService = new AutoPosterMissionService(database, executor, {
    protectedValues: [configuration.serviceToken],
  });
  return {
    database,
    auditPath,
    missionService,
    app: createApp(operatorService, missionService),
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

  it("persists an approval-required mission without invoking AutoPoster", async () => {
    const { port, scheduleCalls } = makePort();
    const harness = createHarness(temporaryRoot, port);
    database = harness.database;

    const response = await request(harness.app)
      .post("/api/runtime-missions/autoposter/schedule")
      .send(validInput());

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      product: "auto_poster",
      action: "autoposter.post.schedule",
      status: "approval_required",
      approvalRequired: true,
      approvedBy: null,
      runtimeResult: null,
    });
    expect(response.body.missionId).toBeTruthy();
    expect(response.body.traceId).toBeTruthy();
    expect(response.body.idempotencyKey).toBe(
      `operator-autoposter:${response.body.missionId}`,
    );
    expect(scheduleCalls).toHaveLength(0);

    const stored = harness.database
      .prepare("SELECT status, runtime_result_json FROM autoposter_runtime_missions")
      .get() as { status: string; runtime_result_json: string | null };
    expect(stored).toEqual({ status: "approval_required", runtime_result_json: null });
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

    const missing = await request(harness.app).post(
      `/api/runtime-missions/${created.missionId}/approve`,
    );
    const blank = await request(harness.app)
      .post(`/api/runtime-missions/${created.missionId}/approve`)
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

    const approved = await request(harness.app)
      .post(`/api/runtime-missions/${created.missionId}/approve`)
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
    const mission = harness.missionService.createScheduleMission(validInput());

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
      const created = harness.missionService.createScheduleMission(validInput());
      const result = await harness.missionService.approveAndExecute(
        created.missionId,
        "founder",
      );
      expect(result.status).toBe(scenario.expected);
      expect(result.runtimeResult?.status).toBe(scenario.expected);
      expect(result.runtimeResult?.evidence).toBeTruthy();
      if (scenario.expected === "denied") {
        expect(result.runtimeResult?.output).toMatchObject({
          reasonCode: "runtime_scheduling_not_allowed",
          planId: "starter",
        });
      }
      harness.database.close();
    }
  });

  it("returns a persisted unavailable result when runtime wiring is unconfigured", async () => {
    const { port } = makePort();
    const harness = createHarness(temporaryRoot, port, {
      baseUrl: "",
      serviceToken: "",
      userId: "",
      timeoutValid: true,
    });
    database = harness.database;
    expect(harness.missionService.getReadiness().configured).toBe(false);
    const created = harness.missionService.createScheduleMission(validInput());

    const result = await harness.missionService.approveAndExecute(
      created.missionId,
      "founder",
    );

    expect(result.status).toBe("unavailable");
    expect(result.runtimeResult).toMatchObject({
      status: "unavailable",
      errors: [{ code: "AUTOPOSTER_UNAVAILABLE" }],
    });
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
      const created = harness.missionService.createScheduleMission(validInput());
      const result = await harness.missionService.approveAndExecute(
        created.missionId,
        "founder",
      );

      expect(harness.missionService.getReadiness().configured).toBe(false);
      expect(result.status).toBe("unavailable");
      expect(scheduleCalls).toHaveLength(0);
      harness.database.close();
    }
  });

  it("returns the stored terminal result on repeated approval without creating twice", async () => {
    const { port, scheduleCalls } = makePort();
    const harness = createHarness(temporaryRoot, port);
    database = harness.database;
    const created = harness.missionService.createScheduleMission(validInput());

    const first = await harness.missionService.approveAndExecute(
      created.missionId,
      "founder",
    );
    const second = await harness.missionService.approveAndExecute(
      created.missionId,
      "another-founder",
    );

    expect(scheduleCalls).toHaveLength(1);
    expect(second).toEqual(first);
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
    const created = harness.missionService.createScheduleMission(validInput());

    const firstPromise = request(harness.app)
      .post(`/api/runtime-missions/${created.missionId}/approve`)
      .send({ approvedBy: "founder-a" })
      .then((response) => response);
    await started;
    const second = await request(harness.app)
      .post(`/api/runtime-missions/${created.missionId}/approve`)
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
    const firstService = new AutoPosterMissionService(firstDatabase, executor);
    const created = firstService.createScheduleMission(validInput());
    const completed = await firstService.approveAndExecute(created.missionId, "founder");
    firstDatabase.close();

    const reopenedDatabase = createDatabase(databasePath);
    database = reopenedDatabase;
    const reopenedService = new AutoPosterMissionService(reopenedDatabase, executor);
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
    const created = harness.missionService.createScheduleMission(validInput({
      ignoredToken: TOKEN_CANARY,
      planId: "caller-supplied-plan",
    }));
    const approved = await request(harness.app)
      .post(`/api/runtime-missions/${created.missionId}/approve`)
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

  it("rejects the configured service token before accepted inputs or approval identity can persist", async () => {
    const { port } = makePort();
    const harness = createHarness(temporaryRoot, port);
    database = harness.database;

    const rejectedCreation = await request(harness.app)
      .post("/api/runtime-missions/autoposter/schedule")
      .send(validInput({ caption: `Never store ${TOKEN_CANARY}` }));
    const mission = harness.missionService.createScheduleMission(validInput());
    const rejectedApproval = await request(harness.app)
      .post(`/api/runtime-missions/${mission.missionId}/approve`)
      .send({ approvedBy: TOKEN_CANARY });
    const rawRows = JSON.stringify(
      harness.database.prepare("SELECT * FROM autoposter_runtime_missions").all(),
    );
    const serializedResponses = JSON.stringify([
      rejectedCreation.body,
      rejectedApproval.body,
    ]);

    expect(rejectedCreation.status).toBe(400);
    expect(rejectedApproval.status).toBe(400);
    expect(serializedResponses).not.toContain(TOKEN_CANARY);
    expect(rawRows).not.toContain(TOKEN_CANARY);
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
      runtimeMissions: {
        autoposter: {
          configured: true,
          executionScope: "schedule_unapproved_draft_only",
          actions: ["autoposter.post.schedule"],
          publishingEnabled: false,
        },
      },
    });
  });

  it("lists missions newest-first and keeps immutable execution inputs read-only", async () => {
    const { port } = makePort();
    const harness = createHarness(temporaryRoot, port);
    database = harness.database;
    const first = harness.missionService.createScheduleMission(validInput({ caption: "first" }));
    const second = harness.missionService.createScheduleMission(validInput({ caption: "second" }));
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
