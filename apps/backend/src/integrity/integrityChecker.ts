import type { DatabaseSync } from "node:sqlite";
import { actionTypes, type ActionType, type Evidence, type ExecutionStep, type StepStatus, type TaskIntent, type TaskStatus } from "../types.js";
import { scanAuditLog, type AuditScanReport } from "./auditScanner.js";

// ── Types ───────────────────────────────────────────────────────────

export interface DatabaseIssue {
  kind: "invalid_task_status" | "invalid_step_status" | "invalid_action_type" | "step_orphan" | "evidence_orphan_task" | "evidence_orphan_step";
  detail: string;
}

export interface ReferenceIssue {
  kind: "audit_refers_to_missing_task" | "audit_refers_to_missing_step";
  auditLine: number;
  detail: string;
}

export interface IntegrityReport {
  timestamp: string;
  database: {
    taskCount: number;
    stepCount: number;
    evidenceCount: number;
    issues: DatabaseIssue[];
  };
  audit: {
    totalLines: number;
    validEvents: number;
    parseErrors: number;
    missingFieldErrors: number;
    invalidTypeErrors: number;
    crossRefIssues: ReferenceIssue[];
  };
  healthy: boolean;
}

const validTaskStates = new Set<string>([
  "pending", "queued", "awaiting_approval", "executing", "completed", "failed", "rejected",
]);

const validStepStates = new Set<string>([
  "pending_approval", "approved", "rejected", "executing", "completed", "failed",
]);

const validActionTypes = new Set<string>(actionTypes as readonly string[]);

// ── Main ────────────────────────────────────────────────────────────

/**
 * Read-only integrity checker. Never modifies data.
 * Scans the database and audit log and returns a structured report.
 */
export function runIntegrityCheck(
  database: DatabaseSync,
  auditPath: string,
): IntegrityReport {
  const dbIssues: DatabaseIssue[] = [];
  const auditReport = scanAuditLog(auditPath);
  const crossRefIssues: ReferenceIssue[] = [];

  // ── Database checks ───────────────────────────────────────────

  const tasks = database
    .prepare("SELECT * FROM task_intents")
    .all() as unknown as (TaskIntent & { status: TaskStatus })[];

  const steps = database
    .prepare("SELECT * FROM execution_steps")
    .all() as unknown as (ExecutionStep & { status: StepStatus; action_type: ActionType })[];

  const evidenceRows = database
    .prepare("SELECT * FROM evidence")
    .all() as unknown as Evidence[];

  const taskIdSet = new Set(tasks.map((t) => t.id));

  // Task status validity
  for (const task of tasks) {
    if (!validTaskStates.has(task.status)) {
      dbIssues.push({
        kind: "invalid_task_status",
        detail: `Task "${task.id}" has invalid status "${task.status}".`,
      });
    }
  }

  // Step checks
  for (const step of steps) {
    if (!validStepStates.has(step.status)) {
      dbIssues.push({
        kind: "invalid_step_status",
        detail: `Step "${step.id}" has invalid status "${step.status}".`,
      });
    }
    if (!validActionTypes.has(step.action_type)) {
      dbIssues.push({
        kind: "invalid_action_type",
        detail: `Step "${step.id}" has invalid action_type "${step.action_type}".`,
      });
    }
    if (!taskIdSet.has(step.task_id)) {
      dbIssues.push({
        kind: "step_orphan",
        detail: `Step "${step.id}" references missing task "${step.task_id}".`,
      });
    }
  }

  // Evidence checks
  const stepIdSet = new Set(steps.map((s) => s.id));
  for (const ev of evidenceRows) {
    if (!taskIdSet.has(ev.task_id)) {
      dbIssues.push({
        kind: "evidence_orphan_task",
        detail: `Evidence "${ev.id}" references missing task "${ev.task_id}".`,
      });
    }
    if (!stepIdSet.has(ev.step_id)) {
      dbIssues.push({
        kind: "evidence_orphan_step",
        detail: `Evidence "${ev.id}" references missing step "${ev.step_id}".`,
      });
    }
  }

  // ── Cross-reference: audit events vs database ─────────────────────

  for (const taskId of auditReport.referencedTaskIds) {
    if (!taskIdSet.has(taskId)) {
      crossRefIssues.push({
        kind: "audit_refers_to_missing_task",
        auditLine: 0, // aggregate — we don't trace individual lines
        detail: `Audit log references task "${taskId}" which does not exist in the database.`,
      });
    }
  }
  for (const stepId of auditReport.referencedStepIds) {
    if (!stepIdSet.has(stepId)) {
      crossRefIssues.push({
        kind: "audit_refers_to_missing_step",
        auditLine: 0,
        detail: `Audit log references step "${stepId}" which does not exist in the database.`,
      });
    }
  }

  const healthy =
    dbIssues.length === 0 &&
    auditReport.parseErrors === 0 &&
    auditReport.missingFieldErrors === 0 &&
    auditReport.invalidTypeErrors === 0 &&
    crossRefIssues.length === 0;

  return {
    timestamp: new Date().toISOString(),
    database: {
      taskCount: tasks.length,
      stepCount: steps.length,
      evidenceCount: evidenceRows.length,
      issues: dbIssues,
    },
    audit: {
      totalLines: auditReport.totalLines,
      validEvents: auditReport.validEvents,
      parseErrors: auditReport.parseErrors,
      missingFieldErrors: auditReport.missingFieldErrors,
      invalidTypeErrors: auditReport.invalidTypeErrors,
      crossRefIssues,
    },
    healthy,
  };
}
