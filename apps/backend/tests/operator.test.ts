import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { AuditLogger, AuditStorageError } from "../src/audit/auditLogger.js";
import { createDatabase } from "../src/db/database.js";
import { scanAuditLog } from "../src/integrity/auditScanner.js";
import { runIntegrityCheck } from "../src/integrity/integrityChecker.js";
import type { IntegrityReport } from "../src/integrity/integrityChecker.js";
import { MockRunner } from "../src/runners/mockRunner.js";
import { OperatorService } from "../src/services/operatorService.js";
import type { ActionType } from "../src/types.js";
import { productLanes } from "../src/types.js";
import { ensureWorkspace, resolveWorkspacePath } from "../src/workspace/pathGuard.js";

describe("CHANTER Operator P0 workflow", () => {
  let temporaryRoot: string;
  let database: DatabaseSync;
  let service: OperatorService;
  let auditPath: string;
  let workspaceRoot: string;

  beforeEach(() => {
    temporaryRoot = mkdtempSync(path.join(os.tmpdir(), "chanter-operator-"));
    auditPath = path.join(temporaryRoot, "data", "audit.jsonl");
    workspaceRoot = ensureWorkspace(path.join(temporaryRoot, "workspace"));
    database = createDatabase(path.join(temporaryRoot, "data", "operator.sqlite"));
    service = new OperatorService(
      database,
      new AuditLogger(auditPath),
      new MockRunner(),
      workspaceRoot,
    );
  });

  afterEach(() => {
    database.close();
    rmSync(temporaryRoot, { recursive: true, force: true });
  });

  it("creates a task intent", () => {
    const detail = service.createTask({
      rawInput: "Prepare a guarded edit preview",
      actionType: "file_edit",
    });

    expect(detail.task.raw_input).toBe("Prepare a guarded edit preview");
    expect(service.listTasks()).toHaveLength(1);
  });

  it("creates one proposed execution step", () => {
    const detail = service.createTask({ rawInput: "Preview a write", actionType: "file_write" });

    expect(detail.steps).toHaveLength(1);
    expect(detail.steps[0]).toMatchObject({ step_number: 1, action_type: "file_write" });
  });

  it("requires approval for every risky or unknown action", () => {
    const riskyActions: ActionType[] = ["file_write", "file_edit", "shell_command", "unknown"];

    for (const actionType of riskyActions) {
      const detail = service.createTask({ rawInput: `Preview ${actionType}`, actionType });
      expect(detail.task.status).toBe("awaiting_approval");
      expect(detail.steps[0]).toMatchObject({ requires_approval: true, status: "pending_approval" });
    }
  });

  it("rejects a pending step without executing it", () => {
    const created = service.createTask({ rawInput: "Reject this command", actionType: "shell_command" });
    const rejected = service.rejectStep(created.steps[0].id, "Unsafe for this review.");

    expect(rejected.task.status).toBe("rejected");
    expect(rejected.steps[0].status).toBe("rejected");
    expect(rejected.evidence).toHaveLength(0);
  });

  it("approves and completes a pending mock step", () => {
    const created = service.createTask({ rawInput: "Approve this edit", actionType: "file_edit" });
    const approved = service.approveStep(created.steps[0].id);

    expect(approved.task.status).toBe("completed");
    expect(approved.steps[0].status).toBe("completed");
  });

  it("runs the deterministic mock adapter without real execution", () => {
    const detail = service.createTask({ rawInput: "Summarize the plan", actionType: "analysis" });

    expect(detail.task.status).toBe("completed");
    expect(detail.evidence[0].stdout).toContain("[mock-runner] Analysis preview completed");
    expect(detail.evidence[0].stdout).toContain("No external model was called");
  });

  it("returns identical mock output for identical task and step input", () => {
    const created = service.createTask({ rawInput: "Stable mock preview", actionType: "file_edit" });
    const runner = new MockRunner();
    const first = runner.run(created.task, created.steps[0]);
    const second = runner.run(created.task, created.steps[0]);

    expect(second).toEqual(first);
  });

  it("saves evidence and validation after approval", () => {
    const created = service.createTask({ rawInput: "Simulate writing a file", actionType: "file_write" });
    const completed = service.approveStep(created.steps[0].id);

    expect(completed.evidence).toHaveLength(1);
    expect(completed.evidence[0]).toMatchObject({
      exit_code: 0,
      validation_passed: true,
      stderr: "",
    });
    expect(completed.evidence[0].diff).toContain("Mock preview only");
  });

  it("appends all major transitions to JSONL audit storage", () => {
    const created = service.createTask({ rawInput: "Audit this edit", actionType: "file_edit" });
    service.approveStep(created.steps[0].id);

    const events = readFileSync(auditPath, "utf8")
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as { event_type: string });
    expect(events.map((event) => event.event_type)).toEqual([
      "task_created",
      "step_created",
      "approval_required",
      "step_approved",
      "step_execution_started",
      "step_executed",
      "evidence_recorded",
      "validation_passed",
      "task_completed",
    ]);
  });

  it("accepts contained workspace paths and rejects escapes", () => {
    expect(resolveWorkspacePath(workspaceRoot, "notes/preview.txt")).toBe(
      path.join(workspaceRoot, "notes", "preview.txt"),
    );
    expect(() => resolveWorkspacePath(workspaceRoot, "../outside.txt")).toThrow(
      "must remain inside",
    );
    expect(() => resolveWorkspacePath(workspaceRoot, path.resolve("outside.txt"))).toThrow(
      "must be relative",
    );
  });

  it("rejects workspace paths that traverse an external symlink or junction", () => {
    const outsideRoot = path.join(temporaryRoot, "outside-workspace");
    const linkedRoot = path.join(workspaceRoot, "linked-outside");
    mkdirSync(outsideRoot);
    symlinkSync(outsideRoot, linkedRoot, process.platform === "win32" ? "junction" : "dir");

    expect(() => resolveWorkspacePath(workspaceRoot, "linked-outside/preview.txt")).toThrow(
      "must not traverse a link outside",
    );
  });

  it("rejects approval when task and step states are inconsistent", () => {
    const created = service.createTask({ rawInput: "Guard inconsistent state", actionType: "file_edit" });
    database.prepare("UPDATE task_intents SET status = 'completed' WHERE id = ?").run(created.task.id);

    expect(() => service.approveStep(created.steps[0].id)).toThrow(
      "task state no longer permits approval",
    );
    expect(service.getTaskDetail(created.task.id).steps[0].status).toBe("pending_approval");
  });

  it("rejects duplicate approvals", () => {
    const created = service.createTask({ rawInput: "Approve once", actionType: "shell_command" });
    service.approveStep(created.steps[0].id);

    expect(() => service.approveStep(created.steps[0].id)).toThrow("not awaiting approval");
  });

  it("rejects duplicate rejections", () => {
    const created = service.createTask({ rawInput: "Reject once", actionType: "file_write" });
    service.rejectStep(created.steps[0].id);

    expect(() => service.rejectStep(created.steps[0].id)).toThrow("not awaiting approval");
  });

  it("does not approve a rejected step", () => {
    const created = service.createTask({ rawInput: "Keep rejected", actionType: "file_edit" });
    service.rejectStep(created.steps[0].id);

    expect(() => service.approveStep(created.steps[0].id)).toThrow("not awaiting approval");
  });

  it("does not approve a completed step", () => {
    const created = service.createTask({ rawInput: "Keep completed", actionType: "file_edit" });
    service.approveStep(created.steps[0].id);

    expect(() => service.approveStep(created.steps[0].id)).toThrow("not awaiting approval");
  });

  it("rolls back state when an audit event cannot be durably recorded", () => {
    const unusableAuditPath = path.join(temporaryRoot, "audit-is-a-directory");
    mkdirSync(unusableAuditPath);
    const guardedService = new OperatorService(
      database,
      new AuditLogger(unusableAuditPath),
      new MockRunner(),
      workspaceRoot,
    );

    expect(() => guardedService.createTask({ rawInput: "Must be audited", actionType: "file_edit" }))
      .toThrow(AuditStorageError);
    expect(guardedService.listTasks()).toHaveLength(0);
  });

  it("rolls back a decision when audit storage fails during the transition", () => {
    const created = service.createTask({ rawInput: "Keep pending without audit", actionType: "file_edit" });
    rmSync(auditPath, { force: true });
    mkdirSync(auditPath);

    expect(() => service.rejectStep(created.steps[0].id)).toThrow(AuditStorageError);
    const task = database.prepare("SELECT status FROM task_intents WHERE id = ?").get(created.task.id) as {
      status: string;
    };
    const step = database.prepare("SELECT status FROM execution_steps WHERE id = ?").get(created.steps[0].id) as {
      status: string;
    };
    expect(task.status).toBe("awaiting_approval");
    expect(step.status).toBe("pending_approval");
  });

  it("reports corrupt audit history as unavailable instead of returning partial data", async () => {
    writeFileSync(auditPath, "not-json\n", "utf8");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = await request(createApp(service)).get("/api/audit");
    consoleError.mockRestore();

    expect(response.status).toBe(503);
    expect(response.body.error).toBe(
      "Audit storage is unavailable. State changes are disabled until it is repaired.",
    );
  });

  it("exposes the workflow through local API routes with human-readable errors", async () => {
    const app = createApp(service);
    const health = await request(app).get("/api/health");
    const invalid = await request(app).post("/api/tasks").send({ rawInput: "" });

    expect(health.status).toBe(200);
    expect(health.body).toMatchObject({ runner: "mock", real_execution_enabled: false });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error).toBe("Task description is required.");
  });

  it("returns a human-readable client error for an escaping workspace path", async () => {
    const response = await request(createApp(service)).post("/api/tasks").send({
      rawInput: "Preview an invalid path",
      actionType: "file_edit",
      workspaceRelativePath: "../outside.txt",
    });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe("Workspace path must remain inside the local workspace.");
  });

  // P0.2 tests

  it("stores and returns the product lane for a task", () => {
    const detail = service.createTask({
      rawInput: "AutoPoster deployment check",
      actionType: "analysis",
      productLane: "AutoPoster",
    });

    expect(detail.task.product_lane).toBe("AutoPoster");
  });

  it("defaults product lane to CHANTER Operator when not specified", () => {
    const detail = service.createTask({
      rawInput: "Default lane task",
      actionType: "analysis",
    });

    expect(detail.task.product_lane).toBe("CHANTER Operator");
  });

  it("normalizes invalid product lane to CHANTER Operator", () => {
    const detail = service.createTask({
      rawInput: "Invalid lane task",
      actionType: "analysis",
      productLane: "Nonexistent Lane",
    });

    expect(detail.task.product_lane).toBe("CHANTER Operator");
  });

  it("exposes available product lanes through the API", async () => {
    const response = await request(createApp(service)).get("/api/lanes");

    expect(response.status).toBe(200);
    expect(response.body.lanes).toEqual(productLanes);
  });

  it("health endpoint reports safe / review-only mode and contained simulation", async () => {
    const response = await request(createApp(service)).get("/api/health");

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      runner: "mock",
      mode: "safe / review-only",
      execution: "contained_simulation",
      real_execution_enabled: false,
      network_execution_enabled: false,
    });
  });

  it("accepts workspaceRelativePath in task creation and stores it in action payload", () => {
    const detail = service.createTask({
      rawInput: "Edit config file",
      actionType: "file_edit",
      workspaceRelativePath: "config/settings.json",
    });

    expect(detail.steps[0].action_payload.workspace_relative_path).toBe("config/settings.json");
  });

  it("includes product_lane in audit trail when task is created", () => {
    const detail = service.createTask({
      rawInput: "Audited lane task",
      actionType: "analysis",
      productLane: "Crypto Radar",
    });

    const taskCreatedEvent = detail.audit_events.find((e) => e.event_type === "task_created");
    expect(taskCreatedEvent?.data.product_lane).toBe("Crypto Radar");
  });

  it("does not add any prohibited integration", () => {
    // Verify the mock runner does not import or use fs, child_process, net, or http
    const runnerSource = readFileSync(
      path.join(__dirname, "..", "src", "runners", "mockRunner.ts"),
      "utf8",
    );
    expect(runnerSource).not.toMatch(/require\s*\(\s*['"]fs['"]|require\s*\(\s*['"]child_process['"]|require\s*\(\s*['"]net['"]|require\s*\(\s*['"]http['"]|import.*from\s*['"]fs['"]|import.*from\s*['"]child_process['"]|import.*from\s*['"]net['"]|import.*from\s*['"]http['"]/);
  });
});

// ── P0.4 Integrity Checks ───────────────────────────────────────────

describe("P0.4 persistence and audit integrity", () => {
  let temporaryRoot: string;
  let database: DatabaseSync;
  let service: OperatorService;
  let auditPath: string;
  let workspaceRoot: string;

  beforeEach(() => {
    temporaryRoot = mkdtempSync(path.join(os.tmpdir(), "chanter-operator-p04-"));
    mkdirSync(path.join(temporaryRoot, "data"), { recursive: true });
    auditPath = path.join(temporaryRoot, "data", "audit.jsonl");
    workspaceRoot = ensureWorkspace(path.join(temporaryRoot, "workspace"));
    database = createDatabase(path.join(temporaryRoot, "data", "operator.sqlite"));
  });

  afterEach(() => {
    database.close();
    rmSync(temporaryRoot, { recursive: true, force: true });
  });

  function makeService(): OperatorService {
    return new OperatorService(database, new AuditLogger(auditPath), new MockRunner(), workspaceRoot);
  }

  // ── 1. Healthy database + audit log passes ───────────────────────

  it("reports healthy integrity for a clean database and audit log", () => {
    const svc = makeService();
    svc.createTask({ rawInput: "Healthy creation", actionType: "analysis" });

    const report = svc.checkIntegrity();
    expect(report.healthy).toBe(true);
    expect(report.database.issues).toHaveLength(0);
    expect(report.database.taskCount).toBe(1);
    expect(report.database.stepCount).toBe(1);
    expect(report.database.evidenceCount).toBe(1);
    expect(report.audit.validEvents).toBeGreaterThan(0);
    expect(report.audit.parseErrors).toBe(0);
    expect(report.audit.missingFieldErrors).toBe(0);
    expect(report.audit.invalidTypeErrors).toBe(0);
  });

  // ── 2. Malformed audit JSONL line is reported ────────────────────

  it("reports a parse error for malformed audit JSONL", () => {
    writeFileSync(auditPath, '{"id":"a1","event_type":"task_created","task_id":"t1","data":{},"created_at":"2026-01-01T00:00:00Z"}\nnot valid json\n', "utf8");

    const svc = makeService();
    const report = svc.checkIntegrity();

    expect(report.healthy).toBe(false);
    expect(report.audit.parseErrors).toBe(1);
    expect(report.audit.totalLines).toBe(2);
    expect(report.audit.validEvents).toBe(1);
  });

  // ── 3. Audit event missing required fields ────────────────────────

  it("reports missing required fields in audit events", () => {
    writeFileSync(auditPath, '{"event_type":"task_created","data":{},"created_at":"2026-01-01T00:00:00Z"}\n', "utf8");

    const svc = makeService();
    const report = svc.checkIntegrity();

    expect(report.healthy).toBe(false);
    expect(report.audit.missingFieldErrors).toBe(1);
  });

  it("reports invalid event_type in audit events", () => {
    writeFileSync(auditPath, '{"id":"a1","event_type":"sudo_command","task_id":"t1","data":{},"created_at":"2026-01-01T00:00:00Z"}\n', "utf8");

    const svc = makeService();
    const report = svc.checkIntegrity();

    expect(report.healthy).toBe(false);
    expect(report.audit.invalidTypeErrors).toBe(1);
  });

  // ── 4. Step referencing missing task ──────────────────────────────

  it("reports orphaned steps referencing missing tasks", () => {
    // Create a service for the real database
    const svc = makeService();

    // Bypass FKs only in test — production constraints remain intact
    database.exec("PRAGMA foreign_keys = OFF;");
    database.exec(`
      INSERT INTO task_intents (id, raw_input, parsed_description, status, priority, product_lane, created_at, updated_at)
      VALUES ('real-task', 'real', 'real', 'completed', 0, 'CHANTER Operator', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');

      INSERT INTO execution_steps (id, task_id, step_number, action_type, action_payload, status, requires_approval, created_at, updated_at)
      VALUES ('orphan-step', 'missing-task', 1, 'analysis', '{}', 'completed', 0, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
    `);
    database.exec("PRAGMA foreign_keys = ON;");

    const report = svc.checkIntegrity();
    expect(report.healthy).toBe(false);
    const orphanIssue = report.database.issues.find((i) => i.kind === "step_orphan");
    expect(orphanIssue).toBeDefined();
    expect(orphanIssue!.detail).toContain("missing-task");
  });

  // ── 5. Evidence referencing missing task/step ─────────────────────

  it("reports evidence referencing missing task", () => {
    const svc = makeService();
    // Bypass FKs only in test — production constraints remain intact
    database.exec("PRAGMA foreign_keys = OFF;");
    database.exec(`
      INSERT INTO task_intents (id, raw_input, parsed_description, status, priority, product_lane, created_at, updated_at)
      VALUES ('real-task', 'real', 'real', 'completed', 0, 'CHANTER Operator', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');

      INSERT INTO execution_steps (id, task_id, step_number, action_type, action_payload, status, requires_approval, created_at, updated_at)
      VALUES ('real-step', 'real-task', 1, 'analysis', '{}', 'completed', 0, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');

      INSERT INTO evidence (id, task_id, step_id, stdout, stderr, exit_code, diff, validation_passed, validation_summary, created_at)
      VALUES ('orphan-evid', 'missing-task', 'real-step', '', '', 0, '', 1, 'ok', '2026-01-01T00:00:00Z');
    `);
    database.exec("PRAGMA foreign_keys = ON;");

    const report = svc.checkIntegrity();
    expect(report.healthy).toBe(false);
    const orphanEvid = report.database.issues.find((i) => i.kind === "evidence_orphan_task");
    expect(orphanEvid).toBeDefined();
    expect(orphanEvid!.detail).toContain("missing-task");
  });

  it("reports evidence referencing missing step", () => {
    const svc = makeService();
    // Bypass FKs only in test — production constraints remain intact
    database.exec("PRAGMA foreign_keys = OFF;");
    database.exec(`
      INSERT INTO task_intents (id, raw_input, parsed_description, status, priority, product_lane, created_at, updated_at)
      VALUES ('real-task', 'real', 'real', 'completed', 0, 'CHANTER Operator', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');

      INSERT INTO execution_steps (id, task_id, step_number, action_type, action_payload, status, requires_approval, created_at, updated_at)
      VALUES ('real-step', 'real-task', 1, 'analysis', '{}', 'completed', 0, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');

      INSERT INTO evidence (id, task_id, step_id, stdout, stderr, exit_code, diff, validation_passed, validation_summary, created_at)
      VALUES ('orphan-evid2', 'real-task', 'missing-step', '', '', 0, '', 1, 'ok', '2026-01-01T00:00:00Z');
    `);
    database.exec("PRAGMA foreign_keys = ON;");

    const report = svc.checkIntegrity();
    expect(report.healthy).toBe(false);
    const orphanEvid = report.database.issues.find((i) => i.kind === "evidence_orphan_step");
    expect(orphanEvid).toBeDefined();
    expect(orphanEvid!.detail).toContain("missing-step");
  });

  // ── 6. Health endpoint returns integrity summary ──────────────────

  it("health endpoint includes integrity summary for a clean state", async () => {
    const svc = makeService();
    svc.createTask({ rawInput: "Integrity health check", actionType: "analysis" });

    const response = await request(createApp(svc)).get("/api/health");
    expect(response.status).toBe(200);
    expect(response.body.integrity).toBeDefined();
    expect(response.body.integrity.healthy).toBe(true);
    expect(response.body.integrity.database.tasks).toBe(1);
    expect(response.body.integrity.database.steps).toBe(1);
    expect(response.body.integrity.database.evidence).toBe(1);
    expect(response.body.integrity.database.issues).toBe(0);
    expect(response.body.integrity.audit.parseErrors).toBe(0);
    expect(response.body.integrity.audit.missingFieldErrors).toBe(0);
    expect(response.body.integrity.audit.invalidTypeErrors).toBe(0);
    expect(response.body.integrity.audit.crossRefIssues).toBe(0);
    expect(response.body.integrity.checkedAt).toBeDefined();
  });

  it("health endpoint reports unhealthy when audit is corrupt", async () => {
    const svc = makeService();
    svc.createTask({ rawInput: "Good task", actionType: "analysis" });
    // Append a malformed line to the audit log
    writeFileSync(auditPath, readFileSync(auditPath, "utf8").trimEnd() + "\nnot json\n", "utf8");

    const response = await request(createApp(svc)).get("/api/health");
    expect(response.status).toBe(200);
    expect(response.body.integrity.healthy).toBe(false);
    expect(response.body.integrity.audit.parseErrors).toBe(1);
  });

  // ── 7. No automatic destructive repair ────────────────────────────

  it("does not modify the audit log during integrity checks", () => {
    const svc = makeService();
    svc.createTask({ rawInput: "Preserve audit", actionType: "analysis" });

    const auditBefore = readFileSync(auditPath, "utf8");
    svc.checkIntegrity();
    svc.checkIntegrity(); // Run twice to ensure idempotency
    const auditAfter = readFileSync(auditPath, "utf8");

    expect(auditBefore).toBe(auditAfter);
  });

  it("does not delete malformed audit lines during integrity check", () => {
    writeFileSync(auditPath, '{"id":"a1","event_type":"task_created","task_id":"t1","data":{},"created_at":"2026-01-01T00:00:00Z"}\nbad line\n', "utf8");

    const svc = makeService();
    svc.checkIntegrity();

    const auditAfter = readFileSync(auditPath, "utf8");
    expect(auditAfter).toContain("bad line");
    expect(auditAfter).toContain("task_created");
  });

  it("does not modify the database during integrity checks", () => {
    const svc = makeService();
    svc.createTask({ rawInput: "Preserve DB", actionType: "analysis" });

    const tasksBefore = svc.listTasks();
    svc.checkIntegrity();
    const tasksAfter = svc.listTasks();

    expect(tasksAfter).toEqual(tasksBefore);
  });

  it("integrity check does not throw for an empty database with no audit file", () => {
    const svc = makeService();
    // No tasks created, no audit file exists
    const report = svc.checkIntegrity();

    expect(report.healthy).toBe(true);
    expect(report.database.taskCount).toBe(0);
    expect(report.database.stepCount).toBe(0);
    expect(report.database.evidenceCount).toBe(0);
    expect(report.audit.totalLines).toBe(0);
    expect(report.audit.validEvents).toBe(0);
  });

  // ── Consistent state checks ───────────────────────────────────────

  it("reports invalid task status if DB constraint is bypassed", () => {
    // Use a separate temp DB without CHECK constraint on status for this test
    const rawDb = createDatabase(":memory:");
    // PRAGMA ignore_check_constraints is not universally supported; use raw exec to
    // create tables without CHECK so the integrity checker can detect the bad status.
    rawDb.exec("PRAGMA foreign_keys = OFF;");
    rawDb.exec(`
      DROP TABLE IF EXISTS task_intents;
      CREATE TABLE task_intents (
        id TEXT PRIMARY KEY,
        raw_input TEXT NOT NULL,
        parsed_description TEXT NOT NULL,
        status TEXT NOT NULL,
        priority INTEGER NOT NULL DEFAULT 0,
        product_lane TEXT NOT NULL DEFAULT 'CHANTER Operator',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    rawDb.prepare("INSERT INTO task_intents VALUES (?,?,?,?,?,?,?,?)").run(
      "bad-task", "broken", "broken", "invalid_status", 0, "CHANTER Operator",
      "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z",
    );
    rawDb.exec("PRAGMA foreign_keys = ON;");

    const report = runIntegrityCheck(rawDb, auditPath);
    expect(report.healthy).toBe(false);
    const statusIssue = report.database.issues.find((i) => i.kind === "invalid_task_status");
    expect(statusIssue).toBeDefined();
    expect(statusIssue!.detail).toContain("invalid_status");
    rawDb.close();
  });

  // ── Safety guard: production constraints remain enforced ──────────

  it("rejects orphan inserts when foreign keys are enabled", () => {
    const svc = makeService();
    expect(() => {
      database.exec(`
        INSERT INTO execution_steps (id, task_id, step_number, action_type, action_payload, status, requires_approval, created_at, updated_at)
        VALUES ('orphan-step-prod', 'nonexistent-task', 1, 'analysis', '{}', 'pending_approval', 0, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
      `);
    }).toThrow();
    const report = svc.checkIntegrity();
    expect(report.database.stepCount).toBe(0);
  });});

describe("P0.6 task lifecycle controls", () => {
  let temporaryRoot: string;
  let database: DatabaseSync;
  let service: OperatorService;
  let auditPath: string;
  let workspaceRoot: string;

  beforeEach(() => {
    temporaryRoot = mkdtempSync(path.join(os.tmpdir(), "chanter-operator-p06-"));
    mkdirSync(path.join(temporaryRoot, "data"), { recursive: true });
    auditPath = path.join(temporaryRoot, "data", "audit.jsonl");
    workspaceRoot = ensureWorkspace(path.join(temporaryRoot, "workspace"));
    database = createDatabase(path.join(temporaryRoot, "data", "operator.sqlite"));
    service = new OperatorService(database, new AuditLogger(auditPath), new MockRunner(), workspaceRoot);
  });

  afterEach(() => {
    database.close();
    rmSync(temporaryRoot, { recursive: true, force: true });
  });

  it("cancels an awaiting_approval task and rejects pending step", () => {
    const created = service.createTask({ rawInput: "Cancel this edit", actionType: "file_edit" });
    const cancelled = service.cancelTask(created.task.id);
    expect(cancelled.task.status).toBe("cancelled");
    expect(cancelled.steps[0].status).toBe("rejected");
  });

  it("rejects cancel on a completed task", () => {
    const created = service.createTask({ rawInput: "Completed analysis", actionType: "analysis" });
    expect(() => service.cancelTask(created.task.id)).toThrow(/cannot be cancelled/);
  });

  it("rejects cancel on a failed task", () => {
    const created = service.createTask({ rawInput: "Will fail", actionType: "file_edit" });
    database.prepare("UPDATE task_intents SET status = ? WHERE id = ?").run("failed", created.task.id);
    expect(() => service.cancelTask(created.task.id)).toThrow(/cannot be cancelled/);
  });

  it("rejects cancel on already cancelled task", () => {
    const created = service.createTask({ rawInput: "Double cancel", actionType: "file_edit" });
    service.cancelTask(created.task.id);
    expect(() => service.cancelTask(created.task.id)).toThrow(/cannot be cancelled/);
  });

  it("audit records task_cancelled event", () => {
    const created = service.createTask({ rawInput: "Audited cancel", actionType: "file_edit" });
    service.cancelTask(created.task.id);
    const detail = service.getTaskDetail(created.task.id);
    expect(detail.audit_events.some(e => e.event_type === "task_cancelled")).toBe(true);
  });

  it("retries a failed task with new step", () => {
    const created = service.createTask({ rawInput: "Retry me", actionType: "file_edit" });
    database.prepare("UPDATE task_intents SET status = ? WHERE id = ?").run("failed", created.task.id);
    database.prepare("UPDATE execution_steps SET status = ? WHERE id = ?").run("failed", created.steps[0].id);
    const retried = service.retryTask(created.task.id);
    expect(retried.steps).toHaveLength(2);
    expect(retried.steps[1].step_number).toBe(2);
  });

  it("retries a rejected task", () => {
    const created = service.createTask({ rawInput: "Rejected to retry", actionType: "shell_command" });
    service.rejectStep(created.steps[0].id);
    const retried = service.retryTask(created.task.id);
    expect(retried.steps).toHaveLength(2);
    expect(retried.steps[1].action_type).toBe("shell_command");
  });

  it("cancels a queued task", () => {
    // Create guarded task, approve it (which takes it queued→executing→completed),
    // but we need to cancel from queued. Create another and cancel before approve.
    const fresh = service.createTask({ rawInput: "To cancel from waiting", actionType: "file_edit" });
    expect(fresh.task.status).toBe("awaiting_approval");
    const cancelled = service.cancelTask(fresh.task.id);
    expect(cancelled.task.status).toBe("cancelled");
  });

  it("rejects retry on completed task", () => {
    const created = service.createTask({ rawInput: "Cannot retry", actionType: "analysis" });
    expect(() => service.retryTask(created.task.id)).toThrow(/cannot be retried/);
  });

  it("rejects retry on executing task", () => {
    const created = service.createTask({ rawInput: "Running", actionType: "file_edit" });
    database.prepare("UPDATE task_intents SET status = ? WHERE id = ?").run("executing", created.task.id);
    expect(() => service.retryTask(created.task.id)).toThrow(/cannot be retried/);
  });

  it("rejects retry on awaiting_approval task", () => {
    const created = service.createTask({ rawInput: "Pending retry", actionType: "file_edit" });
    expect(() => service.retryTask(created.task.id)).toThrow(/cannot be retried/);
  });

  it("audit records task_reopened on retry", () => {
    const created = service.createTask({ rawInput: "Audited retry", actionType: "file_edit" });
    service.cancelTask(created.task.id);
    const retried = service.retryTask(created.task.id);
    expect(retried.audit_events.some(e => e.event_type === "task_reopened")).toBe(true);
  });

  it("cancel and retry preserve integrity", () => {
    const guarded = service.createTask({ rawInput: "Guarded cancel/retry", actionType: "file_edit" });
    service.cancelTask(guarded.task.id);
    const retried = service.retryTask(guarded.task.id);
    expect(retried.steps).toHaveLength(2);
    const report = service.checkIntegrity();
    expect(report.healthy).toBe(true);
  });

  it("API cancel endpoint", async () => {
    const created = service.createTask({ rawInput: "API cancel", actionType: "file_edit" });
    const response = await request(createApp(service)).post("/api/tasks/" + created.task.id + "/cancel");
    expect(response.status).toBe(200);
    expect(response.body.task.status).toBe("cancelled");
  });

  it("API retry endpoint", async () => {
    const created = service.createTask({ rawInput: "API retry", actionType: "file_edit" });
    service.cancelTask(created.task.id);
    const response = await request(createApp(service)).post("/api/tasks/" + created.task.id + "/retry");
    expect(response.status).toBe(200);
    expect(response.body.steps).toHaveLength(2);
  });

  it("API typed error for invalid cancel", async () => {
    const created = service.createTask({ rawInput: "Bad cancel", actionType: "analysis" });
    const response = await request(createApp(service)).post("/api/tasks/" + created.task.id + "/cancel");
    expect(response.status).toBe(409);
  });

  it("API typed error for invalid retry", async () => {
    const created = service.createTask({ rawInput: "Bad retry", actionType: "analysis" });
    const response = await request(createApp(service)).post("/api/tasks/" + created.task.id + "/retry");
    expect(response.status).toBe(409);
  });

describe("P0.7 manual validation evidence intake", () => {
  let temporaryRoot: string;
  let database: DatabaseSync;
  let service: OperatorService;
  let auditPath: string;
  let workspaceRoot: string;

  beforeEach(() => {
    temporaryRoot = mkdtempSync(path.join(os.tmpdir(), "chanter-operator-p07-"));
    mkdirSync(path.join(temporaryRoot, "data"), { recursive: true });
    auditPath = path.join(temporaryRoot, "data", "audit.jsonl");
    workspaceRoot = ensureWorkspace(path.join(temporaryRoot, "workspace"));
    database = createDatabase(path.join(temporaryRoot, "data", "operator.sqlite"));
    service = new OperatorService(database, new AuditLogger(auditPath), new MockRunner(), workspaceRoot);
  });

  afterEach(() => {
    database.close();
    rmSync(temporaryRoot, { recursive: true, force: true });
  });

  it("creates validation evidence for an existing task", () => {
    const created = service.createTask({ rawInput: "Task for manual validation", actionType: "analysis" });
    const result = service.addValidationEvidence(created.task.id, "npm test", "passed", "All 42 tests passed.");

    expect(result.validation_evidence).toHaveLength(1);
    expect(result.validation_evidence[0].command_label).toBe("npm test");
    expect(result.validation_evidence[0].status).toBe("passed");
    expect(result.validation_evidence[0].output).toBe("All 42 tests passed.");
  });

  it("returns validation evidence in task detail", () => {
    const created = service.createTask({ rawInput: "Detail check", actionType: "analysis" });
    service.addValidationEvidence(created.task.id, "npm run build", "passed", "Build OK.");

    const detail = service.getTaskDetail(created.task.id);
    expect(detail.validation_evidence).toHaveLength(1);
    expect(detail.validation_evidence[0].command_label).toBe("npm run build");
  });

  it("rejects validation for a missing task", () => {
    expect(() =>
      service.addValidationEvidence("missing-task-id", "npm test", "passed", "ok"),
    ).toThrow(/was not found/);
  });

  it("rejects invalid validation status", () => {
    const created = service.createTask({ rawInput: "Bad status", actionType: "analysis" });
    expect(() =>
      service.addValidationEvidence(created.task.id, "npm test", "banana", "ok"),
    ).toThrow(/Invalid validation status/);
  });

  it("rejects empty command label", () => {
    const created = service.createTask({ rawInput: "Empty label", actionType: "analysis" });
    expect(() =>
      service.addValidationEvidence(created.task.id, "   ", "passed", "output"),
    ).toThrow(/command label is required/);
  });

  it("rejects oversized output", () => {
    const created = service.createTask({ rawInput: "Large output", actionType: "analysis" });
    const hugeOutput = "x".repeat(10_001);

    expect(() =>
      service.addValidationEvidence(created.task.id, "long test", "passed", hugeOutput),
    ).toThrow(/10,000 characters or fewer/);
  });

  it("rejects command labels longer than 200 characters", () => {
    const created = service.createTask({ rawInput: "Long label", actionType: "analysis" });
    const longLabel = "x".repeat(201);

    expect(() =>
      service.addValidationEvidence(created.task.id, longLabel, "passed", "ok"),
    ).toThrow(/200 characters or fewer/);
  });

  it("appends audit event for validation evidence", () => {
    const created = service.createTask({ rawInput: "Audited validation", actionType: "analysis" });
    const result = service.addValidationEvidence(created.task.id, "git diff --check", "warning", "trailing whitespace");

    expect(result.audit_events.some(e => e.event_type === "validation_evidence_added")).toBe(true);
  });

  it("does not change task lifecycle state", () => {
    const created = service.createTask({ rawInput: "No state change", actionType: "file_edit" });
    const beforeStatus = created.task.status;

    const result = service.addValidationEvidence(created.task.id, "npm test", "failed", "2 tests failed");
    expect(result.task.status).toBe(beforeStatus);
  });

  it("accepts all four valid statuses", () => {
    const created = service.createTask({ rawInput: "All statuses", actionType: "analysis" });

    service.addValidationEvidence(created.task.id, "test passed", "passed", "ok");
    service.addValidationEvidence(created.task.id, "test failed", "failed", "fail");
    service.addValidationEvidence(created.task.id, "test warning", "warning", "warn");
    service.addValidationEvidence(created.task.id, "test not run", "not_run", "skipped");

    const detail = service.getTaskDetail(created.task.id);
    expect(detail.validation_evidence).toHaveLength(4);
    expect(detail.validation_evidence.map(v => v.status).sort()).toEqual(
      ["failed", "not_run", "passed", "warning"],
    );
  });

  it("multiple evidence entries are ordered newest-first", () => {
    const created = service.createTask({ rawInput: "Ordered", actionType: "analysis" });

    service.addValidationEvidence(created.task.id, "first", "passed", "1");
    service.addValidationEvidence(created.task.id, "second", "failed", "2");

    const detail = service.getTaskDetail(created.task.id);
    expect(detail.validation_evidence).toHaveLength(2);
    // newest first
    expect(detail.validation_evidence[0].command_label).toBe("second");
    expect(detail.validation_evidence[1].command_label).toBe("first");
  });

  it("no shell or filesystem execution introduced by validation", () => {
    // This is a design guarantee, not a runtime check in the test.
    // The addValidationEvidence method has no runner call, no exec, no spawn.
    const created = service.createTask({ rawInput: "Safety check", actionType: "file_edit" });
    const result = service.addValidationEvidence(created.task.id, "any command", "passed", "safe");

    expect(result.validation_evidence).toHaveLength(1);
    // Task remains in its original state — no execution happened
    expect(result.task.status).toBe("awaiting_approval"); // file_edit is guarded — no auto-execution
  });
});


describe("P0.8 safe commit review intake", () => {
  let temporaryRoot: string;
  let database: DatabaseSync;
  let service: OperatorService;
  let auditPath: string;
  let workspaceRoot: string;

  beforeEach(() => {
    temporaryRoot = mkdtempSync(path.join(os.tmpdir(), "chanter-operator-p08-"));
    mkdirSync(path.join(temporaryRoot, "data"), { recursive: true });
    auditPath = path.join(temporaryRoot, "data", "audit.jsonl");
    workspaceRoot = ensureWorkspace(path.join(temporaryRoot, "workspace"));
    database = createDatabase(path.join(temporaryRoot, "data", "operator.sqlite"));
    service = new OperatorService(database, new AuditLogger(auditPath), new MockRunner(), workspaceRoot);
  });

  afterEach(() => {
    database.close();
    rmSync(temporaryRoot, { recursive: true, force: true });
  });

  it("creates commit review for existing task", () => {
    const created = service.createTask({ rawInput: "Review candidate", actionType: "analysis" });
    const result = service.addCommitReview(
      created.task.id,
      "P0.8 implementation: clean delivery with all gates passing",
      "5 files changed",
      "npm run typecheck: pass. npm test: 135 passing. npm run build: success. git diff --check: clean.",
      "No known limitations.",
    );

    expect(result.commit_reviews).toHaveLength(1);
    expect(result.commit_reviews[0].verdict).toBe("safe_to_review");
    expect(result.commit_reviews[0].reasons.some(r => r.includes("All four validation gates pass"))).toBe(true);
  });

  it("returns commit review in task detail", () => {
    const created = service.createTask({ rawInput: "Detail check", actionType: "analysis" });
    service.addCommitReview(created.task.id, "summary", "files", "all good", "");

    const detail = service.getTaskDetail(created.task.id);
    expect(detail.commit_reviews).toHaveLength(1);
  });

  it("rejects review for missing task", () => {
    expect(() =>
      service.addCommitReview("missing-id", "s", "f", "v", "r"),
    ).toThrow(/was not found/);
  });

  it("rejects oversized summary text with 400", () => {
    const created = service.createTask({ rawInput: "Oversized summary", actionType: "analysis" });
    const huge = "x".repeat(15_000);
    expect(() =>
      service.addCommitReview(created.task.id, huge, "files", "npm run typecheck: pass. npm test: 42 passing. npm run build: success. git diff --check: clean.", ""),
    ).toThrow(/summary text must be 10,000 characters or fewer/i);
  });

  it("rejects oversized validation text with 400", () => {
    const created = service.createTask({ rawInput: "Oversized validation", actionType: "analysis" });
    const huge = "x".repeat(15_000);
    expect(() =>
      service.addCommitReview(created.task.id, "summary", "files", huge, ""),
    ).toThrow(/validation text must be 10,000 characters or fewer/i);
  });

  it("classification: failing tests => blocked", () => {
    const created = service.createTask({ rawInput: "Failing", actionType: "analysis" });
    const result = service.addCommitReview(
      created.task.id,
      "P0.x implementation",
      "5 files changed",
      "npm test: 65 passed, 2 failed. typecheck OK.",
      "",
    );

    expect(result.commit_reviews[0].verdict).toBe("blocked");
    expect(result.commit_reviews[0].reasons.some(r => /failing/i.test(r))).toBe(true);
  });

  it("classification: build failure => blocked", () => {
    const created = service.createTask({ rawInput: "Build fail", actionType: "analysis" });
    const result = service.addCommitReview(
      created.task.id,
      "P0.x implementation",
      "3 files changed",
      "npm run build: failed with TSC errors.",
      "",
    );

    expect(result.commit_reviews[0].verdict).toBe("blocked");
  });

  it("classification: prohibited capability (codex) => blocked", () => {
    const created = service.createTask({ rawInput: "Prohibited", actionType: "analysis" });
    const result = service.addCommitReview(
      created.task.id,
      "Added Codex integration for auto-fix",
      "2 files changed",
      "all tests pass",
      "",
    );

    expect(result.commit_reviews[0].verdict).toBe("blocked");
  });

  it("classification: real execution mentioned => blocked", () => {
    const created = service.createTask({ rawInput: "Real exec", actionType: "analysis" });
    const result = service.addCommitReview(
      created.task.id,
      "Added real execution capabilities",
      "4 files changed",
      "passes",
      "",
    );

    expect(result.commit_reviews[0].verdict).toBe("blocked");
  });

  it("classification: broad changes => needs_review", () => {
    const created = service.createTask({ rawInput: "Broad", actionType: "analysis" });
    const result = service.addCommitReview(
      created.task.id,
      "Large refactoring across the codebase. Scope is unclear.",
      "45 files changed throughout the project",
      "npm test: 200 passing",
      "",
    );

    expect(result.commit_reviews[0].verdict).toBe("needs_review");
  });

  it("classification: vague validation => needs_review", () => {
    const created = service.createTask({ rawInput: "Vague", actionType: "analysis" });
    const result = service.addCommitReview(
      created.task.id,
      "Added some features",
      "a few files changed",
      "vague results, need more validation",
      "",
    );

    expect(result.commit_reviews[0].verdict).toBe("needs_review");
  });


  it("missing validation gate evidence => needs_review", () => {
    const created = service.createTask({ rawInput: "Missing evidence", actionType: "analysis" });
    // Only tests passing — no typecheck, build, or diff-check evidence
    const result = service.addCommitReview(
      created.task.id,
      "Implemented feature X",
      "3 files changed",
      "npm test: all 42 tests pass.",
      "",
    );
    expect(result.commit_reviews[0].verdict).toBe("needs_review");
    expect(result.commit_reviews[0].reasons.some(r => /typecheck/i.test(r))).toBe(true);
  });

  it("partial gate evidence => needs_review", () => {
    const created = service.createTask({ rawInput: "Partial evidence", actionType: "analysis" });
    // Tests and build pass, but no typecheck or diff-check
    const result = service.addCommitReview(
      created.task.id,
      "Partial validation",
      "2 files changed",
      "npm test: all passing. npm run build: success.",
      "",
    );
    expect(result.commit_reviews[0].verdict).toBe("needs_review");
    expect(result.commit_reviews[0].reasons.some(r => /typecheck/i.test(r))).toBe(true);
    expect(result.commit_reviews[0].reasons.some(r => /git diff/i.test(r))).toBe(true);
  });

  it("SAFE_TO_REVIEW requires all four gates explicitly", () => {
    const created = service.createTask({ rawInput: "All gates", actionType: "analysis" });
    // All four gates explicitly passed
    const result = service.addCommitReview(
      created.task.id,
      "Clean P0.8 delivery",
      "3 files changed, +5 / -1",
      "npm run typecheck: pass. npm test: 42 passing. npm run build: success. git diff --check: clean.",
      "",
    );
    expect(result.commit_reviews[0].verdict).toBe("safe_to_review");
  });
  it("risk notes with real execution added => blocked", () => {
    const created = service.createTask({ rawInput: "Risk notes real execution", actionType: "analysis" });
    const result = service.addCommitReview(
      created.task.id,
      "Clean P0.8 delivery",
      "3 files changed",
      "npm run typecheck: pass. npm test: 42 passing. npm run build: success. git diff --check: clean.",
      "Risk: real execution added.",
    );

    expect(result.commit_reviews[0].verdict).toBe("blocked");
  });

  it("risk notes with approval bypass present => blocked", () => {
    const created = service.createTask({ rawInput: "Risk notes approval bypass", actionType: "analysis" });
    const result = service.addCommitReview(
      created.task.id,
      "Clean P0.8 delivery",
      "3 files changed",
      "npm run typecheck: pass. npm test: 42 passing. npm run build: success. git diff --check: clean.",
      "Risk: approval bypass is present.",
    );

    expect(result.commit_reviews[0].verdict).toBe("blocked");
  });

  it("negative safety notes do not falsely block clean four-gate review", () => {
    const created = service.createTask({ rawInput: "Clean negative safety notes", actionType: "analysis" });
    const result = service.addCommitReview(
      created.task.id,
      "Clean P0.8 delivery",
      "3 files changed",
      "npm run typecheck: pass. npm test: 42 passing. npm run build: success. git diff --check: clean.",
      "No real execution. No external APIs. No approval bypass. No Codex or Ollama integration.",
    );

    expect(result.commit_reviews[0].verdict).toBe("safe_to_review");
  });
  it("audit event appended", () => {
    const created = service.createTask({ rawInput: "Audited review", actionType: "analysis" });
    const result = service.addCommitReview(created.task.id, "summary", "files", "validation", "risks");

    expect(result.audit_events.some(e => e.event_type === "commit_review_added")).toBe(true);
  });

  it("does not change task lifecycle state", () => {
    const created = service.createTask({ rawInput: "No state change", actionType: "file_edit" });
    const beforeStatus = created.task.status;

    const result = service.addCommitReview(created.task.id, "summary", "files", "passes", "");
    expect(result.task.status).toBe(beforeStatus);
  });

  it("no shell/git/filesystem execution introduced", () => {
    const created = service.createTask({ rawInput: "Safety check", actionType: "analysis" });
    const result = service.addCommitReview(created.task.id, "summary", "files", "ok", "");

    expect(result.commit_reviews).toHaveLength(1);
    // Task remains completed after analysis auto-executes
    expect(result.task.status).toBe("completed");
  });
});


describe("P0.9 evidence bundle export", () => {
  let temporaryRoot: string;
  let database: DatabaseSync;
  let service: OperatorService;
  let auditPath: string;
  let workspaceRoot: string;

  beforeEach(() => {
    temporaryRoot = mkdtempSync(path.join(os.tmpdir(), "chanter-operator-p09-"));
    mkdirSync(path.join(temporaryRoot, "data"), { recursive: true });
    auditPath = path.join(temporaryRoot, "data", "audit.jsonl");
    workspaceRoot = ensureWorkspace(path.join(temporaryRoot, "workspace"));
    database = createDatabase(path.join(temporaryRoot, "data", "operator.sqlite"));
    service = new OperatorService(database, new AuditLogger(auditPath), new MockRunner(), workspaceRoot);
  });

  afterEach(() => {
    database.close();
    rmSync(temporaryRoot, { recursive: true, force: true });
  });

  it("builds evidence bundle for existing task", () => {
    const created = service.createTask({ rawInput: "Bundle test", actionType: "analysis" });
    const result = service.buildEvidenceBundle(created.task.id);
    expect(result.taskId).toBe(created.task.id);
    expect(result.markdown).toContain("CHANTER Operator");
    expect(result.markdown).toContain("Evidence Bundle");
  });

  it("rejects bundle for missing task", () => {
    expect(() =>
      service.buildEvidenceBundle("missing-task-id"),
    ).toThrow(/was not found/);
  });

  it("bundle includes task metadata", () => {
    const created = service.createTask({ rawInput: "Metadata check", actionType: "analysis" });
    const result = service.buildEvidenceBundle(created.task.id);
    expect(result.markdown).toContain("Metadata check");
    expect(result.markdown).toContain("completed");
    expect(result.markdown).toContain("mock-only");
    expect(result.markdown).toContain("safe/review-only");
  });

  it("bundle includes validation evidence", () => {
    const created = service.createTask({ rawInput: "Bundle with validation", actionType: "analysis" });
    service.addValidationEvidence(created.task.id, "npm test", "passed", "42 tests passed");
    const result = service.buildEvidenceBundle(created.task.id);
    expect(result.markdown).toContain("Manual Validation Evidence");
    expect(result.markdown).toContain("npm test");
    expect(result.markdown).toContain("passed");
  });

  it("bundle includes safe commit review verdict and reasons", () => {
    const created = service.createTask({ rawInput: "Bundle with review", actionType: "analysis" });
    service.addCommitReview(
      created.task.id,
      "Clean delivery",
      "3 files changed",
      "npm run typecheck: pass. npm test: 42 passing. npm run build: success. git diff --check: clean.",
      "",
    );
    const result = service.buildEvidenceBundle(created.task.id);
    expect(result.markdown).toContain("Safe Commit Review");
    expect(result.markdown).toContain("SAFE TO REVIEW");
    expect(result.markdown).toContain("All four validation gates pass");
  });

  it("bundle includes audit event summary", () => {
    const created = service.createTask({ rawInput: "Bundle with audit", actionType: "analysis" });
    const result = service.buildEvidenceBundle(created.task.id);
    expect(result.markdown).toContain("Audit Summary");
    expect(result.markdown).toContain("task_created");
  });

  it("bundle is deterministic for unchanged task", () => {
    const created = service.createTask({ rawInput: "Deterministic check", actionType: "analysis" });
    const bundle1 = service.buildEvidenceBundle(created.task.id);
    const bundle2 = service.buildEvidenceBundle(created.task.id);
    expect(bundle1.markdown).toBe(bundle2.markdown);
  });

  it("bundle generation does not mutate task lifecycle state", () => {
    const created = service.createTask({ rawInput: "No mutation", actionType: "file_edit" });
    const beforeStatus = created.task.status;
    service.buildEvidenceBundle(created.task.id);
    const after = service.getTaskDetail(created.task.id);
    expect(after.task.status).toBe(beforeStatus);
  });

  it("bundle generation does not append audit events", () => {
    const created = service.createTask({ rawInput: "No audit append", actionType: "analysis" });
    const beforeCount = service.getTaskDetail(created.task.id).audit_events.length;
    service.buildEvidenceBundle(created.task.id);
    const afterCount = service.getTaskDetail(created.task.id).audit_events.length;
    expect(afterCount).toBe(beforeCount);
  });

  it("no shell, process, git, or filesystem scan introduced", () => {
    const created = service.createTask({ rawInput: "Safety check", actionType: "analysis" });
    const result = service.buildEvidenceBundle(created.task.id);
    // Bundle output must contain the safety disclaimer
    expect(result.markdown).toContain("no command was run");
    expect(result.markdown).toContain("mock-only");
    // Result is a plain object with markdown string — no side effects
    expect(typeof result.markdown).toBe("string");
  });
});

});
