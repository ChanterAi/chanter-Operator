export type ActionType =
  | "analysis"
  | "read_file"
  | "file_write"
  | "file_edit"
  | "shell_command"
  | "unknown";

export type ProductLane =
  | "AutoPoster"
  | "Loop Governor"
  | "Clean Engine"
  | "Crypto Radar"
  | "Premium Site"
  | "CHANTER Operator";

export interface TaskIntent {
  id: string;
  raw_input: string;
  parsed_description: string;
  status: string;
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
  status: string;
  requires_approval: boolean;
  created_at: string;
  updated_at: string;
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

export interface AuditEvent {
  id: string;
  event_type: string;
  task_id: string;
  step_id?: string;
  data: Record<string, unknown>;
  created_at: string;
}

export interface ValidationEvidence {
  id: string;
  task_id: string;
  command_label: string;
  status: "passed" | "failed" | "warning" | "not_run";
  output: string;
  created_at: string;
}

export interface CommitReview {
  id: string;
  task_id: string;
  summary_text: string;
  changed_files_text: string;
  validation_text: string;
  risk_notes_text: string;
  verdict: "blocked" | "needs_review" | "safe_to_review";
  reasons: string[];
  created_at: string;
}

export interface RunnerPolicyPreview {
  id: string;
  task_id: string;
  proposed_command: string;
  proposed_purpose: string;
  verdict: "allowed_readonly" | "requires_approval" | "blocked";
  reasons: string[];
  created_at: string;
}

export interface AddCommitReviewInput {
  summaryText: string;
  changedFilesText: string;
  validationText: string;
  riskNotesText: string;
}

export interface AddValidationInput {
  commandLabel: string;
  status: "passed" | "failed" | "warning" | "not_run";
  output: string;
}

export interface TaskDetail {
  task: TaskIntent;
  steps: ExecutionStep[];
  evidence: Evidence[];
  audit_events: AuditEvent[];
  validation_evidence: ValidationEvidence[];
  commit_reviews: CommitReview[];
  runner_policy_previews: RunnerPolicyPreview[];
}

export interface CreateTaskInput {
  rawInput: string;
  actionType: ActionType;
  priority: number;
  workspaceRelativePath?: string;
  productLane?: ProductLane;
}

export type RecommendedAction =
  | "Approve mock simulation"
  | "Review evidence"
  | "Task complete"
  | "Rejected"
  | "Cancelled"
  | "Blocked / invalid"
  | "Retry available";

export function recommendNextAction(detail: TaskDetail): RecommendedAction {
  const task = detail.task;
  const step = detail.steps[0];

  if (canRetryTask(task.status)) return "Retry available";
  if (task.status === "completed" && step?.status === "completed") return "Task complete";
  if (task.status === "awaiting_approval" && step?.status === "pending_approval") {
    return "Approve mock simulation";
  }
  if (task.status === "completed" || task.status === "executing" || task.status === "queued") {
    return "Review evidence";
  }
  return "Blocked / invalid";
}

export function canCancelTask(status: string): boolean {
  return status === "pending" || status === "queued" || status === "awaiting_approval";
}

export function canRetryTask(status: string): boolean {
  return status === "failed" || status === "rejected" || status === "cancelled";
}

// P1.0 Readonly Command Result
export interface ReadonlyCommandResult {
  id: string;
  command: string;
  executable: string;
  args: string[];
  verdict: "allowed_readonly" | "blocked";
  stdout: string | null;
  stderr: string | null;
  exitCode: number | null;
  durationMs: number | null;
  workspaceRoot: string;
  timestamp: string;
  error: string | null;
}

export interface HealthIntegrity {
  healthy: boolean;
  database: {
    tasks: number;
    steps: number;
    evidence: number;
    issues: number;
  };
  audit: {
    totalLines: number;
    validEvents: number;
    parseErrors: number;
    missingFieldErrors: number;
    invalidTypeErrors: number;
    crossRefIssues: number;
  };
  checkedAt: string;
}

export interface HealthResponse {
  status: string;
  runner: string;
  mode: string;
  execution: string;
  real_execution_enabled: boolean;
  network_execution_enabled: boolean;
  runtimeMissions: {
    autoposter: {
      configured: boolean;
      executionScope: "schedule_unapproved_draft_only";
      actions: ["autoposter.post.schedule"];
      publishingEnabled: false;
    };
  };
  integrity: HealthIntegrity;
}

export type ReadinessState =
  | { kind: "loading" }
  | { kind: "unavailable"; error: string }
  | { kind: "healthy"; health: HealthResponse }
  | { kind: "unhealthy"; health: HealthResponse }
  | { kind: "error"; error: string };

export interface EvidenceBundleResponse {
  taskId: string;
  markdown: string;
}

export type AutoPosterProvider = "tiktok" | "youtube";

export type RuntimeMissionStatus =
  | "approval_required"
  | "pending_approval"
  | "executing"
  | "succeeded"
  | "duplicate"
  | "denied"
  | "validation_failed"
  | "unavailable"
  | "failed";

export type RuntimeJsonValue =
  | string
  | number
  | boolean
  | null
  | RuntimeJsonValue[]
  | { [key: string]: RuntimeJsonValue };

export interface RuntimeMissionEvidenceItem {
  id: string;
  type: string;
  label: string;
  detail: string;
  source?: string;
  createdAt: string;
}

export interface RuntimeMissionEvidenceBundle {
  evidence: RuntimeMissionEvidenceItem[];
  validationResult?: {
    passed: boolean;
    summary: string;
  } | null;
  result?: {
    success: boolean;
    summary: string;
  } | null;
}

export interface RuntimeMissionResult {
  status: RuntimeMissionStatus;
  output: RuntimeJsonValue | null;
  evidence: RuntimeMissionEvidenceBundle | null;
  warnings: string[];
  errors: Array<{ code: string; message: string }>;
  policyDecision: {
    allowed: boolean;
    approvalRequired: boolean;
    blocked: boolean;
    reasons: string[];
    requiredPolicy?: string;
  } | null;
  approvalDecision: {
    required: boolean;
    approved: boolean;
    approvedBy: string | null;
  };
  idempotency: {
    key: string | null;
    outcome: "not_applicable" | "first_execution" | "duplicate";
    originalMissionId?: string;
  };
}

export interface RuntimeMission {
  missionId: string;
  traceId: string;
  product: string;
  action: string;
  actorId: string;
  workspaceId: string;
  accountId: string;
  provider: AutoPosterProvider;
  mediaUrl: string;
  caption: string;
  hashtags: string;
  title: string | null;
  description: string | null;
  scheduledAt: string;
  idempotencyKey: string;
  status: RuntimeMissionStatus;
  approvalRequired: boolean;
  approvedBy: string | null;
  createdAt: string;
  updatedAt: string;
  runtimeResult: RuntimeMissionResult | null;
}

export interface CreateAutoPosterScheduleMissionInput {
  workspaceId: string;
  accountId: string;
  provider: AutoPosterProvider;
  mediaUrl: string;
  caption: string;
  hashtags: string;
  title?: string;
  description?: string;
  scheduledAt: string;
}
