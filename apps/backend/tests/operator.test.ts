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
