import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { AuditLogger } from "../src/audit/auditLogger.js";
import { createDatabase } from "../src/db/database.js";
import { MockRunner } from "../src/runners/mockRunner.js";
import { OperatorService } from "../src/services/operatorService.js";
import type { ActionType } from "../src/types.js";
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

  it("enforces valid status transitions and rejects repeat decisions", () => {
    const created = service.createTask({ rawInput: "One decision only", actionType: "shell_command" });
    expect(created.task.status).toBe("awaiting_approval");

    const completed = service.approveStep(created.steps[0].id);
    expect(completed.task.status).toBe("completed");
    expect(() => service.rejectStep(created.steps[0].id)).toThrow("not awaiting approval");
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
});

