import { randomUUID } from "node:crypto";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { requiresApproval } from "../approvals/approvalGate.js";
import { AuditLogger } from "../audit/auditLogger.js";
import { mapEvidence, mapStep, mapTask, withTransaction } from "../db/database.js";
import type { Runner } from "../runners/runner.js";
import type {
  ActionType,
  Evidence,
  ExecutionStep,
  TaskDetail,
  TaskIntent,
  TaskStatus,
} from "../types.js";
import { validateRunnerResult } from "../validation/stepValidation.js";
import { resolveWorkspacePath } from "../workspace/pathGuard.js";

export class OperatorError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
  }
}

export interface CreateTaskInput {
  rawInput: string;
  actionType: ActionType;
  priority?: number;
  workspaceRelativePath?: string;
}

export class OperatorService {
  constructor(
    private readonly database: DatabaseSync,
    private readonly audit: AuditLogger,
    private readonly runner: Runner,
    private readonly workspaceRoot: string,
  ) {}

  createTask(input: CreateTaskInput): TaskDetail {
    const rawInput = input.rawInput.trim();
    if (!rawInput) {
      throw new OperatorError("Task description is required.", 400);
    }
    if (rawInput.length > 4_000) {
      throw new OperatorError("Task description must be 4,000 characters or fewer.", 400);
    }

    const now = new Date().toISOString();
    const taskId = randomUUID();
    const stepId = randomUUID();
    const approvalRequired = requiresApproval(input.actionType);
    const taskStatus: TaskStatus = approvalRequired ? "awaiting_approval" : "queued";
    const priority = Number.isInteger(input.priority)
      ? Math.max(0, Math.min(input.priority ?? 0, 2))
      : 0;
    const actionPayload: Record<string, unknown> = { description: rawInput };

    if (input.workspaceRelativePath?.trim()) {
      resolveWorkspacePath(this.workspaceRoot, input.workspaceRelativePath);
      actionPayload.workspace_relative_path = input.workspaceRelativePath
        .split(path.sep)
        .join("/");
    } else if (input.actionType === "file_write" || input.actionType === "file_edit") {
      resolveWorkspacePath(this.workspaceRoot, "mock-output.txt");
      actionPayload.workspace_relative_path = "mock-output.txt";
    }

    withTransaction(this.database, () => {
      this.database
        .prepare(
          `INSERT INTO task_intents
            (id, raw_input, parsed_description, status, priority, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(taskId, rawInput, rawInput.replace(/\s+/g, " "), taskStatus, priority, now, now);

      this.database
        .prepare(
          `INSERT INTO execution_steps
            (id, task_id, step_number, action_type, action_payload, status, requires_approval, created_at, updated_at)
           VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          stepId,
          taskId,
          input.actionType,
          JSON.stringify(actionPayload),
          approvalRequired ? "pending_approval" : "approved",
          approvalRequired ? 1 : 0,
          now,
          now,
        );

      this.audit.append("task_created", taskId, undefined, { status: taskStatus, priority });
      this.audit.append("step_created", taskId, stepId, {
        action_type: input.actionType,
        requires_approval: approvalRequired,
      });
      if (approvalRequired) {
        this.audit.append("approval_required", taskId, stepId, {
          action_type: input.actionType,
        });
      }
    });

    if (!approvalRequired) {
      this.executeApprovedStep(taskId, stepId);
    }

    return this.getTaskDetail(taskId);
  }

  listTasks(): TaskIntent[] {
    return this.database
      .prepare("SELECT * FROM task_intents ORDER BY priority DESC, created_at DESC")
      .all()
      .map(mapTask);
  }

  getTaskDetail(taskId: string): TaskDetail {
    const taskRow = this.database.prepare("SELECT * FROM task_intents WHERE id = ?").get(taskId);
    if (!taskRow) {
      throw new OperatorError("Task was not found.", 404);
    }

    const steps = this.database
      .prepare("SELECT * FROM execution_steps WHERE task_id = ? ORDER BY step_number ASC")
      .all(taskId)
      .map(mapStep);
    const evidence = this.database
      .prepare("SELECT * FROM evidence WHERE task_id = ? ORDER BY created_at DESC")
      .all(taskId)
      .map(mapEvidence);

    return {
      task: mapTask(taskRow),
      steps,
      evidence,
      audit_events: this.audit.readRecent(100, taskId),
    };
  }

  approveStep(stepId: string): TaskDetail {
    const step = this.requireStep(stepId);
    if (!step.requires_approval || step.status !== "pending_approval") {
      throw new OperatorError("This step is not awaiting approval.", 409);
    }

    const now = new Date().toISOString();
    withTransaction(this.database, () => {
      this.database
        .prepare("UPDATE execution_steps SET status = 'approved', updated_at = ? WHERE id = ?")
        .run(now, stepId);
      this.database
        .prepare("UPDATE task_intents SET status = 'queued', updated_at = ? WHERE id = ?")
        .run(now, step.task_id);
      this.audit.append("step_approved", step.task_id, step.id);
    });
    this.executeApprovedStep(step.task_id, step.id);
    return this.getTaskDetail(step.task_id);
  }

  rejectStep(stepId: string, reason = "Rejected by user."): TaskDetail {
    const step = this.requireStep(stepId);
    if (step.status !== "pending_approval") {
      throw new OperatorError("This step is not awaiting approval.", 409);
    }

    const safeReason = reason.trim().slice(0, 500) || "Rejected by user.";
    const now = new Date().toISOString();
    withTransaction(this.database, () => {
      this.database
        .prepare("UPDATE execution_steps SET status = 'rejected', updated_at = ? WHERE id = ?")
        .run(now, stepId);
      this.database
        .prepare("UPDATE task_intents SET status = 'rejected', updated_at = ? WHERE id = ?")
        .run(now, step.task_id);
      this.audit.append("step_rejected", step.task_id, step.id, { reason: safeReason });
    });
    return this.getTaskDetail(step.task_id);
  }

  listAuditEvents(limit = 50) {
    return this.audit.readRecent(limit);
  }

  private requireStep(stepId: string): ExecutionStep {
    const row = this.database.prepare("SELECT * FROM execution_steps WHERE id = ?").get(stepId);
    if (!row) {
      throw new OperatorError("Execution step was not found.", 404);
    }
    return mapStep(row);
  }

  private executeApprovedStep(taskId: string, stepId: string): void {
    const task = this.getTaskDetail(taskId).task;
    const step = this.requireStep(stepId);
    if (step.status !== "approved") {
      throw new OperatorError("Only approved steps can be executed.", 409);
    }

    const executingAt = new Date().toISOString();
    withTransaction(this.database, () => {
      this.database
        .prepare("UPDATE execution_steps SET status = 'executing', updated_at = ? WHERE id = ?")
        .run(executingAt, stepId);
      this.database
        .prepare("UPDATE task_intents SET status = 'executing', updated_at = ? WHERE id = ?")
        .run(executingAt, taskId);
    });

    let result;
    try {
      result = this.runner.run(task, { ...step, status: "executing", updated_at: executingAt });
    } catch {
      const failedAt = new Date().toISOString();
      withTransaction(this.database, () => {
        this.database
          .prepare("UPDATE execution_steps SET status = 'failed', updated_at = ? WHERE id = ?")
          .run(failedAt, stepId);
        this.database
          .prepare("UPDATE task_intents SET status = 'failed', updated_at = ? WHERE id = ?")
          .run(failedAt, taskId);
        this.audit.append("task_failed", taskId, stepId, { reason: "mock_runner_error" });
      });
      throw new OperatorError("The mock runner could not complete this step.", 500);
    }

    const validation = validateRunnerResult(result);
    const completedAt = new Date().toISOString();
    const evidence: Evidence = {
      id: randomUUID(),
      task_id: taskId,
      step_id: stepId,
      stdout: result.stdout,
      stderr: result.stderr,
      exit_code: result.exitCode,
      diff: result.diff,
      validation_passed: validation.passed,
      validation_summary: validation.summary,
      created_at: completedAt,
    };

    withTransaction(this.database, () => {
      this.database
        .prepare(
          `INSERT INTO evidence
            (id, task_id, step_id, stdout, stderr, exit_code, diff, validation_passed, validation_summary, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          evidence.id,
          evidence.task_id,
          evidence.step_id,
          evidence.stdout,
          evidence.stderr,
          evidence.exit_code,
          evidence.diff,
          evidence.validation_passed ? 1 : 0,
          evidence.validation_summary,
          evidence.created_at,
        );
      this.database
        .prepare("UPDATE execution_steps SET status = ?, updated_at = ? WHERE id = ?")
        .run(validation.passed ? "completed" : "failed", completedAt, stepId);
      this.database
        .prepare("UPDATE task_intents SET status = ?, updated_at = ? WHERE id = ?")
        .run(validation.passed ? "completed" : "failed", completedAt, taskId);
      this.audit.append("step_executed", taskId, stepId, { exit_code: result.exitCode });
      this.audit.append("evidence_recorded", taskId, stepId, { evidence_id: evidence.id });
      this.audit.append(validation.passed ? "validation_passed" : "validation_failed", taskId, stepId, {
        summary: validation.summary,
      });
      this.audit.append(validation.passed ? "task_completed" : "task_failed", taskId, stepId);
    });
  }
}
