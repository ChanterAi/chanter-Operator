import { randomUUID } from "node:crypto";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { requiresApproval } from "../approvals/approvalGate.js";
import { AuditLogger } from "../audit/auditLogger.js";
import { mapCommitReview, mapEvidence, mapStep, mapTask, mapValidationEvidence, withTransaction } from "../db/database.js";
import { normalizeProductLane } from "../db/schema.js";
import { runIntegrityCheck } from "../integrity/integrityChecker.js";
import type { IntegrityReport } from "../integrity/integrityChecker.js";
import type { Runner } from "../runners/runner.js";
import type {
  ActionType,
  Evidence,
  ExecutionStep,
  ProductLane,
  StepStatus,
  TaskDetail,
  TaskIntent,
  TaskStatus,
  CommitReview,
  ValidationEvidence,
} from "../types.js";
import { validateRunnerResult } from "../validation/stepValidation.js";
import { resolveWorkspacePath, WorkspacePathError } from "../workspace/pathGuard.js";
import {
  cancellableTaskStates,
  canTransitionStep,
  canTransitionTask,
  retryableTaskStates,
} from "./stateTransitions.js";

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
  productLane?: string;
}

/** Valid manual validation evidence statuses. */
const validationStatuses = new Set<string>(["passed", "failed", "warning", "not_run"]);

/** Maximum length for pasted validation output. */
const MAX_VALIDATION_OUTPUT_LENGTH = 10_000;
const MAX_REVIEW_FIELD_LENGTH = 10_000;

const blockedTriggers: { pattern: RegExp; reason: string }[] = [
  { pattern: /test.*fail|failing.*test|tests?:\s*\d+\s*failed/i, reason: "Failing tests reported" },
  { pattern: /build.*fail|failed.*build|typecheck.*fail/i, reason: "Build or typecheck failure reported" },
  { pattern: /git diff.*fail|diff.?check.*fail/i, reason: "git diff --check failure reported" },
  {
    pattern: /(?:added|enabled|introduced|implemented|wired|new)\s+(?:real.?execution|shell.?exec|external.?api)|(?:real.?execution|shell.?exec|external.?api)\s+(?:added|enabled|introduced|implemented|wired)/i,
    reason: "Real execution or external API detected",
  },
  { pattern: /\.fixed\.ts|stray.*files|temp.*files/i, reason: "Stray or temp files detected" },
  {
    pattern: /(?:added|enabled|introduced|implemented|wired|in place|present).*(?:destructive.*repair|approval.*bypass|hidden.*agent)|(?:destructive.*repair|approval.*bypass|hidden.*agent).*(?:added|enabled|introduced|implemented|wired|in place|present)/i,
    reason: "Destructive repair or approval bypass detected",
  },
  {
    pattern: /(?:added|enabled|introduced|implemented|wired|new).*(?:\bcodex\b|\bollama\b|\bgit\s+automation\b|\bloop\s+governor\b)|(?:\bcodex\b|\bollama\b|\bgit\s+automation\b|\bloop\s+governor\b).*(?:added|enabled|introduced|implemented|wired|automation)/i,
    reason: "Prohibited capability mentioned",
  },
  { pattern: /validation.*missing|no.*validation|untested/i, reason: "Validation claims missing" },
];

const needsReviewTriggers: { pattern: RegExp; reason: string }[] = [
  { pattern: /vague|unclear|broad/i, reason: "Validation claims appear vague or broad" },
  { pattern: /files.*changed.*\d{2,}[^0-9]/i, reason: "High number of changed files" },
  { pattern: /readme.*mismatch|doc.*outdated/i, reason: "README or doc mismatch noted" },
  { pattern: /scope.*unclear|unknown.*limitation|incomplete.*evidence/i, reason: "Scope unclear or evidence incomplete" },
  { pattern: /known.*limitation.*safety|limitation.*affects/i, reason: "Known limitation may affect safety" },
];

/** Check that all four validation gates are explicitly reported as passed. */
function allFourGatesPassed(validationText: string): { allPassed: boolean; missing: string[] } {
  const missing: string[] = [];
  if (!/typecheck.*(?:pass|ok|success|exit\s*0)|(?:pass|ok|success).*typecheck/i.test(validationText)) {
    missing.push("Typecheck not explicitly reported as passing");
  }
  if (!/tests?\s*(?::|–|—|-)\s*(?:\d+\s*)*pass|all\s+(?:tests|specs).*pass/i.test(validationText)) {
    missing.push("Tests not explicitly reported as passing");
  }
  if (!/build.*(?:pass|ok|success|exit\s*0)|(?:pass|ok|success).*build/i.test(validationText)) {
    missing.push("Build not explicitly reported as passing");
  }
  if (!/git\s*diff\s*(?:--check)?.*(?:pass|ok|clean|exit\s*0)|diff.?check.*(?:pass|ok|clean|exit\s*0)/i.test(validationText)) {
    missing.push("git diff --check not explicitly reported as passing");
  }
  return { allPassed: missing.length === 0, missing };
}

export class OperatorService {
  constructor(
    private readonly database: DatabaseSync,
    private readonly audit: AuditLogger,
    private readonly runner: Runner,
    private readonly workspaceRoot: string,
  ) {}

  /** Run a read-only integrity check across the database and audit log. Never modifies data. */
  checkIntegrity(): IntegrityReport {
    return runIntegrityCheck(this.database, this.audit.path);
  }

  // â”€â”€ Lifecycle: Cancel task â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  /**
   * Cancel a task that is in a cancellable state.
   * Allowed from: pending, queued, awaiting_approval.
   * Rejected for: completed, executing, failed, rejected, cancelled.
   * Pending steps are rejected. Audit records are appended.
   */
  cancelTask(taskId: string): TaskDetail {
    const task = this.requireTask(taskId);

    if (!cancellableTaskStates.has(task.status)) {
      throw new OperatorError(
        `Task cannot be cancelled from "${task.status}". Only pending, queued, or awaiting-approval tasks can be cancelled.`,
        409,
      );
    }

    const now = new Date().toISOString();
    const steps = this.getStepsForTask(taskId);

    withTransaction(this.database, () => {
      this.transitionTask(task, "cancelled", now);

      // Reject any pending-approval steps
      for (const step of steps) {
        if (step.status === "pending_approval") {
          this.transitionStep(step, "rejected", now);
        }
      }

      this.audit.append("task_cancelled", taskId, undefined, {
        previous_status: task.status,
      });
    });

    return this.getTaskDetail(taskId);
  }

  // â”€â”€ Lifecycle: Retry / reopen task â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  /**
   * Retry a task from a terminal state.
   * Allowed from: failed, rejected, cancelled.
   * Creates a new execution step, reusing the original action payload.
   * Safe actions execute immediately; guarded actions await approval.
   */
  retryTask(taskId: string): TaskDetail {
    const task = this.requireTask(taskId);

    if (!retryableTaskStates.has(task.status)) {
      throw new OperatorError(
        `Task cannot be retried from "${task.status}". Only failed, rejected, or cancelled tasks can be retried.`,
        409,
      );
    }

    // Get the most recent step to reuse its action type and payload
    const steps = this.getStepsForTask(taskId);
    const latestStep = steps[steps.length - 1];
    if (!latestStep) {
      throw new OperatorError("Cannot retry a task that has no execution steps.", 409);
    }

    const now = new Date().toISOString();
    const stepId = randomUUID();
    const approvalRequired = requiresApproval(latestStep.action_type);
    const taskStatus: TaskStatus = approvalRequired ? "awaiting_approval" : "queued";
    const previousStatus = task.status;

    withTransaction(this.database, () => {
      this.transitionTask(task, taskStatus, now);

      this.database
        .prepare(
          `INSERT INTO execution_steps
            (id, task_id, step_number, action_type, action_payload, status, requires_approval, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          stepId,
          taskId,
          steps.length + 1,
          latestStep.action_type,
          JSON.stringify(latestStep.action_payload),
          approvalRequired ? "pending_approval" : "approved",
          approvalRequired ? 1 : 0,
          now,
          now,
        );

      this.audit.append("task_reopened", taskId, stepId, {
        previous_status: previousStatus,
        new_status: taskStatus,
        action_type: latestStep.action_type,
        requires_approval: approvalRequired,
      });

      if (approvalRequired) {
        this.audit.append("approval_required", taskId, stepId, {
          action_type: latestStep.action_type,
        });
      }
    });

    if (!approvalRequired) {
      this.executeApprovedStep(taskId, stepId);
    }

    return this.getTaskDetail(taskId);
  }

  // â”€â”€ Task CRUD â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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
    const productLane: ProductLane = normalizeProductLane(input.productLane);
    const actionPayload: Record<string, unknown> = { description: rawInput };

    const requestedPath = input.workspaceRelativePath?.trim()
      || ((input.actionType === "file_write" || input.actionType === "file_edit")
        ? "mock-output.txt"
        : undefined);
    if (requestedPath) {
      try {
        const resolvedPath = resolveWorkspacePath(this.workspaceRoot, requestedPath);
        actionPayload.workspace_relative_path = path.relative(this.workspaceRoot, resolvedPath)
          .split(path.sep)
          .join("/");
      } catch (error) {
        if (error instanceof WorkspacePathError) {
          throw new OperatorError(error.message, 400);
        }
        throw error;
      }
    }

    withTransaction(this.database, () => {
      this.database
        .prepare(
          `INSERT INTO task_intents
            (id, raw_input, parsed_description, status, priority, product_lane, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(taskId, rawInput, rawInput.replace(/\s+/g, " "), taskStatus, priority, productLane, now, now);

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

      this.audit.append("task_created", taskId, undefined, { status: taskStatus, priority, product_lane: productLane });
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

    const steps = this.getStepsForTask(taskId);
    const evidence = this.database
      .prepare("SELECT * FROM evidence WHERE task_id = ? ORDER BY created_at DESC")
      .all(taskId)
      .map(mapEvidence);

    const validation_evidence = this.database
      .prepare("SELECT * FROM validation_evidence WHERE task_id = ? ORDER BY created_at DESC")
      .all(taskId)
      .map(mapValidationEvidence);

    const commit_reviews = this.database
      .prepare("SELECT * FROM commit_reviews WHERE task_id = ? ORDER BY created_at DESC")
      .all(taskId)
      .map(mapCommitReview);

    return {
      task: mapTask(taskRow),
      steps,
      evidence,
      audit_events: this.audit.readRecent(100, taskId),
      validation_evidence,
      commit_reviews,
    };
  }

  approveStep(stepId: string): TaskDetail {
    const step = this.requireStep(stepId);
    const task = this.requireTask(step.task_id);
    if (!step.requires_approval || step.status !== "pending_approval") {
      throw new OperatorError("This step is not awaiting approval.", 409);
    }
    if (task.status !== "awaiting_approval") {
      throw new OperatorError("The task state no longer permits approval.", 409);
    }

    const now = new Date().toISOString();
    withTransaction(this.database, () => {
      this.transitionStep(step, "approved", now);
      this.transitionTask(task, "queued", now);
      this.audit.append("step_approved", step.task_id, step.id);
    });
    this.executeApprovedStep(step.task_id, step.id);
    return this.getTaskDetail(step.task_id);
  }

  rejectStep(stepId: string, reason = "Rejected by user."): TaskDetail {
    const step = this.requireStep(stepId);
    const task = this.requireTask(step.task_id);
    if (!step.requires_approval || step.status !== "pending_approval") {
      throw new OperatorError("This step is not awaiting approval.", 409);
    }
    if (task.status !== "awaiting_approval") {
      throw new OperatorError("The task state no longer permits rejection.", 409);
    }

    const safeReason = reason.trim().slice(0, 500) || "Rejected by user.";
    const now = new Date().toISOString();
    withTransaction(this.database, () => {
      this.transitionStep(step, "rejected", now);
      this.transitionTask(task, "rejected", now);
      this.audit.append("step_rejected", step.task_id, step.id, { reason: safeReason });
    });
    return this.getTaskDetail(step.task_id);
  }

  listAuditEvents(limit = 50) {
    return this.audit.readRecent(limit);
  }

  /**
   * Record manual validation evidence for a task.
   * Does NOT run any command — purely records human-pasted results.
   */
  addValidationEvidence(
    taskId: string,
    commandLabel: string,
    status: string,
    output: string,
  ): TaskDetail {
    this.requireTask(taskId);

    const trimmedLabel = commandLabel.trim();
    if (!trimmedLabel) {
      throw new OperatorError("A command label is required.", 400);
    }
    if (trimmedLabel.length > 200) {
      throw new OperatorError("Command label must be 200 characters or fewer.", 400);
    }

    if (!validationStatuses.has(status)) {
      throw new OperatorError(
        'Invalid validation status "' + status + '". Must be passed, failed, warning, or not_run.',
        400,
      );
    }

    if (output.length > MAX_VALIDATION_OUTPUT_LENGTH) {
      throw new OperatorError("Validation output must be 10,000 characters or fewer.", 400);
    }

    const now = new Date().toISOString();
    const evidenceId = randomUUID();

    withTransaction(this.database, () => {
      this.database
        .prepare(
          `INSERT INTO validation_evidence
            (id, task_id, command_label, status, output, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(evidenceId, taskId, trimmedLabel, status, output, now);

      this.audit.append(
        "validation_evidence_added",
        taskId,
        undefined,
        {
          evidence_id: evidenceId,
          command_label: trimmedLabel,
          status,
          output_length: output.length,
        },
      );
    });

    return this.getTaskDetail(taskId);
  }

  private classifyVerdict(
    summaryText: string,
    changedFilesText: string,
    validationText: string,
    riskNotesText: string,
  ): { verdict: "blocked" | "needs_review" | "safe_to_review"; reasons: string[] } {
    const combined = [summaryText, changedFilesText, validationText, riskNotesText].join("\n");
    const reasons: string[] = [];

    for (const rule of blockedTriggers) {
      if (rule.pattern.test(combined)) {
        reasons.push(rule.reason);
      }
    }
    if (reasons.length > 0) {
      return { verdict: "blocked", reasons };
    }

    for (const rule of needsReviewTriggers) {
      if (rule.pattern.test(combined)) {
        reasons.push(rule.reason);
      }
    }
    if (reasons.length > 0) {
      return { verdict: "needs_review", reasons };
    }

    // SAFE_TO_REVIEW requires explicit evidence of all four validation gates
    const gates = allFourGatesPassed(validationText);
    if (!gates.allPassed) {
      return { verdict: "needs_review", reasons: gates.missing };
    }

    return { verdict: "safe_to_review", reasons: ["All four validation gates pass explicitly (typecheck, tests, build, git diff --check). Review manually before commit."] };
  }

  /**
   * Record a safe commit review for a task.
   * Does NOT run git or any command — purely records human-pasted analysis.
   */
  addCommitReview(
    taskId: string,
    summaryText: string,
    changedFilesText: string,
    validationText: string,
    riskNotesText: string,
  ): TaskDetail {
    const task = this.requireTask(taskId);

    if (summaryText.length > MAX_REVIEW_FIELD_LENGTH) {
      throw new OperatorError("Summary text must be 10,000 characters or fewer.", 400);
    }
    if (changedFilesText.length > MAX_REVIEW_FIELD_LENGTH) {
      throw new OperatorError("Changed files text must be 10,000 characters or fewer.", 400);
    }
    if (validationText.length > MAX_REVIEW_FIELD_LENGTH) {
      throw new OperatorError("Validation text must be 10,000 characters or fewer.", 400);
    }
    if (riskNotesText.length > MAX_REVIEW_FIELD_LENGTH) {
      throw new OperatorError("Risk notes text must be 10,000 characters or fewer.", 400);
    }

    const { verdict, reasons } = this.classifyVerdict(summaryText, changedFilesText, validationText, riskNotesText);

    const now = new Date().toISOString();
    const reviewId = randomUUID();

    withTransaction(this.database, () => {
      this.database
        .prepare(
          `INSERT INTO commit_reviews
            (id, task_id, summary_text, changed_files_text, validation_text, risk_notes_text, verdict, reasons, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(reviewId, taskId, summaryText, changedFilesText, validationText, riskNotesText, verdict, JSON.stringify(reasons), now);

      this.audit.append(
        "commit_review_added",
        taskId,
        undefined,
        {
          review_id: reviewId,
          verdict,
          reason_count: reasons.length,
          summary_length: summaryText.length,
          files_length: changedFilesText.length,
          validation_length: validationText.length,
          risk_notes_length: riskNotesText.length,
        },
      );
    });

    return this.getTaskDetail(taskId);
  }

    // Private helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€


  private getStepsForTask(taskId: string): ExecutionStep[] {
    return this.database
      .prepare("SELECT * FROM execution_steps WHERE task_id = ? ORDER BY step_number ASC")
      .all(taskId)
      .map(mapStep);
  }

  private requireStep(stepId: string): ExecutionStep {
    const row = this.database.prepare("SELECT * FROM execution_steps WHERE id = ?").get(stepId);
    if (!row) {
      throw new OperatorError("Execution step was not found.", 404);
    }
    return mapStep(row);
  }

  private requireTask(taskId: string): TaskIntent {
    const row = this.database.prepare("SELECT * FROM task_intents WHERE id = ?").get(taskId);
    if (!row) {
      throw new OperatorError("Task was not found.", 404);
    }
    return mapTask(row);
  }

  private transitionStep(step: ExecutionStep, nextStatus: StepStatus, updatedAt: string): void {
    if (!canTransitionStep(step.status, nextStatus)) {
      throw new OperatorError(
        `Execution step cannot transition from ${step.status} to ${nextStatus}.`,
        409,
      );
    }
    const result = this.database
      .prepare("UPDATE execution_steps SET status = ?, updated_at = ? WHERE id = ? AND status = ?")
      .run(nextStatus, updatedAt, step.id, step.status);
    if (Number(result.changes) !== 1) {
      throw new OperatorError("Execution step state changed before the transition could be saved.", 409);
    }
  }

  private transitionTask(task: TaskIntent, nextStatus: TaskStatus, updatedAt: string): void {
    if (!canTransitionTask(task.status, nextStatus)) {
      throw new OperatorError(
        `Task cannot transition from ${task.status} to ${nextStatus}.`,
        409,
      );
    }
    const result = this.database
      .prepare("UPDATE task_intents SET status = ?, updated_at = ? WHERE id = ? AND status = ?")
      .run(nextStatus, updatedAt, task.id, task.status);
    if (Number(result.changes) !== 1) {
      throw new OperatorError("Task state changed before the transition could be saved.", 409);
    }
  }

  private executeApprovedStep(taskId: string, stepId: string): void {
    const task = this.requireTask(taskId);
    const step = this.requireStep(stepId);
    if (step.status !== "approved") {
      throw new OperatorError("Only approved steps can be executed.", 409);
    }
    if (task.status !== "queued") {
      throw new OperatorError("Only queued tasks can begin execution.", 409);
    }

    const executingAt = new Date().toISOString();
    withTransaction(this.database, () => {
      this.transitionStep(step, "executing", executingAt);
      this.transitionTask(task, "executing", executingAt);
      this.audit.append("step_execution_started", taskId, stepId, { runner: "mock" });
    });

    const executingStep: ExecutionStep = { ...step, status: "executing", updated_at: executingAt };
    const executingTask: TaskIntent = { ...task, status: "executing", updated_at: executingAt };

    let result;
    try {
      result = this.runner.run(executingTask, executingStep);
    } catch {
      const failedAt = new Date().toISOString();
      withTransaction(this.database, () => {
        this.transitionStep(executingStep, "failed", failedAt);
        this.transitionTask(executingTask, "failed", failedAt);
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
      this.transitionStep(executingStep, validation.passed ? "completed" : "failed", completedAt);
      this.transitionTask(executingTask, validation.passed ? "completed" : "failed", completedAt);
      this.audit.append("step_executed", taskId, stepId, { exit_code: result.exitCode });
      this.audit.append("evidence_recorded", taskId, stepId, { evidence_id: evidence.id });
      this.audit.append(validation.passed ? "validation_passed" : "validation_failed", taskId, stepId, {
        summary: validation.summary,
      });
      this.audit.append(validation.passed ? "task_completed" : "task_failed", taskId, stepId);
    });
  }
}
