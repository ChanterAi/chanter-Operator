export const productLanes = [
  "AutoPoster",
  "Loop Governor",
  "Clean Engine",
  "Crypto Radar",
  "Premium Site",
  "CHANTER Operator",
] as const;

export type ProductLane = (typeof productLanes)[number];

export const actionTypes = [
  "analysis",
  "read_file",
  "file_write",
  "file_edit",
  "shell_command",
  "unknown",
] as const;

export type ActionType = (typeof actionTypes)[number];

export type TaskStatus =
  | "pending"
  | "queued"
  | "awaiting_approval"
  | "executing"
  | "completed"
  | "failed"
  | "rejected"
  | "cancelled";

export type StepStatus =
  | "pending_approval"
  | "approved"
  | "rejected"
  | "executing"
  | "completed"
  | "failed";

export interface TaskIntent {
  id: string;
  raw_input: string;
  parsed_description: string;
  status: TaskStatus;
  priority: number;
  product_lane: ProductLane;
  created_at: string;
  updated_at: string;
}

export interface ExecutionStep {
  id: string;
  task_id: string;
  step_number: number;
  action_type: ActionType;
  action_payload: Record<string, unknown>;
  status: StepStatus;
  requires_approval: boolean;
  created_at: string;
  updated_at: string;
}

export interface ValidationEvidence {
  id: string;
  task_id: string;
  command_label: string;
  status: "passed" | "failed" | "warning" | "not_run";
  output: string;
  created_at: string;
}

export interface Evidence {
  id: string;
  task_id: string;
  step_id: string;
  stdout: string;
  stderr: string;
  exit_code: number;
  diff: string;
  validation_passed: boolean;
  validation_summary: string;
  created_at: string;
}

export const auditEventTypes = [
  "task_created",
  "step_created",
  "approval_required",
  "step_approved",
  "step_rejected",
  "step_execution_started",
  "step_executed",
  "evidence_recorded",
  "validation_passed",
  "validation_failed",
  "task_completed",
  "task_failed",
  "task_cancelled",
  "task_reopened",
  "validation_evidence_added",
] as const;

export type AuditEventType = (typeof auditEventTypes)[number];

export interface AuditEvent {
  id: string;
  event_type: AuditEventType;
  task_id: string;
  step_id?: string;
  data: Record<string, unknown>;
  created_at: string;
}

export interface TaskDetail {
  task: TaskIntent;
  steps: ExecutionStep[];
  evidence: Evidence[];
  audit_events: AuditEvent[];
  validation_evidence: ValidationEvidence[];
}
