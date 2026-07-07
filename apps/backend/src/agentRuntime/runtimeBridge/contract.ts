// ── CHANTER Operator P1A: Runtime Bridge — Contract Mirror ──
//
// Structural mirror of `chanter-agent-runtime`'s public contract types and
// transition rules (apps/chanter-agent-runtime/src/types.ts + transitions.ts,
// as of commit bd1f310). Field names, unions, and rules are copied verbatim
// and verified against that source.
//
// WHY MIRRORED, NOT IMPORTED: chanter-agent-runtime is a sibling repository
// with its own independent package.json/dist output. chanter-Operator's npm
// workspaces are scoped to its own `apps/*` only, so there is no existing
// workspace link to depend on, and adding a `file:../../chanter-agent-runtime`
// dependency would reach outside this repo's boundary and assume a specific
// sibling-directory layout that may not hold on every machine/CI that clones
// chanter-Operator independently. This matches the existing, sanctioned
// "contract-only, no cross-repo imports" convention already used by every
// adapter in `../adapters/` (see safeCommitAdapter.ts) — and by
// chanter-agent-runtime's own `safeCommitAdapter.ts`, which mirrors
// SafeCommit's contract for the identical reason. When a real workspace/package
// link becomes available, this file (and its siblings in runtimeBridge/) can
// be deleted and replaced with direct imports without changing the public API
// surface in operatorRuntimeBridge.ts.
//
// No execution. No network. No cross-repo imports.

/** JSON-safe value. Every field that must survive serialization to disk/wire is built from this. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** CHANTER product that can own a runtime task. */
export type RuntimeProduct =
  | "loop_governor"
  | "safecommit"
  | "operator"
  | "mcp_server"
  | "auto_poster"
  | "clean_engine";

/** Ordered task lifecycle status. See getAllowedNextStatuses for the allowed edges. */
export type RuntimeStatus =
  | "draft"
  | "planned"
  | "approval_required"
  | "approved"
  | "executing"
  | "validating"
  | "completed"
  | "failed"
  | "blocked"
  | "cancelled";

/** Risk classification driving approval-gate behavior. */
export type RuntimeRiskLevel = "low" | "medium" | "high" | "critical";

/**
 * Execution policy attached to a task. Guarded policies (everything except
 * local_only/advisory_only) force an approval gate regardless of risk level.
 */
export type RuntimeExecutionPolicy =
  | "local_only"
  | "advisory_only"
  | "requires_approval"
  | "requires_safecommit_review"
  | "publish_guarded"
  | "deploy_guarded"
  | "commit_guarded";

/** Single step inside a RuntimePlan. */
export interface RuntimePlanStep {
  id: string;
  description: string;
  done: boolean;
}

/** Attached plan describing how a task intends to reach its objective. */
export interface RuntimePlan {
  summary: string;
  steps: RuntimePlanStep[];
  createdAt: string;
}

/** Discriminant for how a piece of evidence should be interpreted. */
export type RuntimeEvidenceType = "file" | "log" | "artifact" | "command_output" | "url" | "note";

/** One inspectable artifact produced while working a task. */
export interface RuntimeEvidence {
  id: string;
  type: RuntimeEvidenceType;
  label: string;
  detail: string;
  source?: string;
  createdAt: string;
}

/** Result of a single validation command/check. */
export interface RuntimeValidationCheck {
  command: string;
  passed: boolean;
  message?: string;
}

/** Aggregate validation outcome attached while a task is `validating`. */
export interface RuntimeValidationResult {
  passed: boolean;
  checks: RuntimeValidationCheck[];
  summary: string;
  validatedAt: string;
}

/** Final, terminal outcome of a task (set by completeTask/failTask/cancelTask). */
export interface RuntimeResult {
  success: boolean;
  summary: string;
  output?: JsonValue;
  completedAt: string;
}

/** Suggested next action, attachable at any point — including after a terminal outcome. */
export type RuntimeRecommendationAction = "proceed" | "retry" | "escalate" | "request_changes" | "block" | "stop";

export interface RuntimeRecommendation {
  action: RuntimeRecommendationAction;
  reason: string;
  confidence?: "low" | "medium" | "high";
  createdAt: string;
}

/** Every event type the runtime can append to a task's audit log. */
export type RuntimeEventType =
  | "TASK_CREATED"
  | "PLAN_ATTACHED"
  | "APPROVAL_REQUIRED"
  | "TASK_APPROVED"
  | "EXECUTION_STARTED"
  | "EVIDENCE_ATTACHED"
  | "VALIDATION_STARTED"
  | "VALIDATION_PASSED"
  | "VALIDATION_FAILED"
  | "TASK_COMPLETED"
  | "TASK_FAILED"
  | "TASK_BLOCKED"
  | "TASK_CANCELLED"
  | "RECOMMENDATION_ATTACHED"
  | "SAFECOMMIT_REVIEW_REQUIRED"
  | "SAFECOMMIT_REVIEW_ATTACHED"
  | "PUBLISH_GUARD_ATTACHED"
  | "DEPLOY_GUARD_ATTACHED"
  | "COMMIT_GUARD_ATTACHED";

/** One immutable audit-log entry. */
export interface RuntimeEvent {
  type: RuntimeEventType;
  taskId: string;
  timestamp: string;
  message: string;
  data?: JsonValue;
}

/** The core unit of work: one task moving through the shared execution contract. */
export interface RuntimeTask {
  id: string;
  product: RuntimeProduct;
  objective: string;
  status: RuntimeStatus;
  riskLevel: RuntimeRiskLevel;
  executionPolicy: RuntimeExecutionPolicy;
  /** Derived from riskLevel + executionPolicy at creation time; see requiresApprovalBeforeExecution. */
  approvalRequired: boolean;
  inputs: Record<string, JsonValue>;
  plan?: RuntimePlan;
  evidence: RuntimeEvidence[];
  validationCommands: string[];
  validationResult?: RuntimeValidationResult;
  result?: RuntimeResult;
  nextRecommendation?: RuntimeRecommendation;
  logs: RuntimeEvent[];
  createdAt: string;
  updatedAt: string;
}

// ── Transition rules (mirror of transitions.ts) ──

/** Execution policies that force an approval gate regardless of risk level. */
const GUARDED_POLICIES: ReadonlySet<RuntimeExecutionPolicy> = new Set([
  "requires_approval",
  "requires_safecommit_review",
  "publish_guarded",
  "deploy_guarded",
  "commit_guarded",
]);

const HIGH_RISK_LEVELS: ReadonlySet<RuntimeRiskLevel> = new Set(["high", "critical"]);

const TERMINAL_STATUSES: ReadonlySet<RuntimeStatus> = new Set(["completed", "failed", "cancelled"]);

/**
 * True if a task of this risk level / execution policy must be approved
 * before it is allowed to enter `executing`.
 */
export function requiresApprovalBeforeExecution(
  input: Pick<RuntimeTask, "riskLevel" | "executionPolicy">,
): boolean {
  if (HIGH_RISK_LEVELS.has(input.riskLevel)) return true;
  return GUARDED_POLICIES.has(input.executionPolicy);
}

/** Terminal statuses never accept further transitions; a new task must be created instead. */
export function isTerminalStatus(status: RuntimeStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

/**
 * Full transition table. `planned` is the only status whose outgoing edges
 * depend on task state (approvalRequired) rather than being fixed by status alone.
 */
export function getAllowedNextStatuses(task: RuntimeTask): RuntimeStatus[] {
  switch (task.status) {
    case "draft":
      return ["planned", "blocked", "cancelled"];
    case "planned":
      return task.approvalRequired
        ? ["approval_required", "blocked", "cancelled"]
        : ["executing", "blocked", "cancelled"];
    case "approval_required":
      return ["approved", "blocked", "cancelled"];
    case "approved":
      return ["executing", "blocked", "cancelled"];
    case "executing":
      return ["validating", "blocked", "cancelled"];
    case "validating":
      return ["completed", "failed", "blocked", "cancelled"];
    case "blocked":
      return ["planned", "cancelled"];
    case "completed":
    case "failed":
    case "cancelled":
      return [];
  }
}

/** Thrown by assertTransitionAllowed. Carries structured context for programmatic handling. */
export class RuntimeTransitionError extends Error {
  readonly taskId: string;
  readonly from: RuntimeStatus;
  readonly to: RuntimeStatus;
  readonly allowed: RuntimeStatus[];

  constructor(task: RuntimeTask, to: RuntimeStatus, allowed: RuntimeStatus[]) {
    super(
      `Invalid transition for task ${task.id} (${task.product}): "${task.status}" -> "${to}" is not allowed.` +
        (allowed.length > 0
          ? ` Allowed next status(es): ${allowed.join(", ")}.`
          : ` "${task.status}" is a terminal status; create a new task instead.`) +
        explainReason(task, to),
    );
    this.name = "RuntimeTransitionError";
    this.taskId = task.id;
    this.from = task.status;
    this.to = to;
    this.allowed = allowed;
  }
}

/** Best-effort human-readable hint appended to transition errors for the common approval-gate cases. */
function explainReason(task: RuntimeTask, to: RuntimeStatus): string {
  if (to === "executing" && task.status === "planned" && task.approvalRequired) {
    return (
      " Reason: this task requires approval (riskLevel=" +
      task.riskLevel +
      ", executionPolicy=" +
      task.executionPolicy +
      ") — call requireApproval then approveTask before startExecution."
    );
  }
  if (to === "executing" && task.status === "approval_required") {
    return " Reason: this task is awaiting approval; call approveTask first.";
  }
  if (to === "approval_required" && task.status === "planned" && !task.approvalRequired) {
    return " Reason: this task does not require approval; call startExecution directly.";
  }
  if (isTerminalStatus(task.status)) {
    return ` Reason: "${task.status}" is terminal and cannot mutate further.`;
  }
  return "";
}

/** Throws RuntimeTransitionError if `to` is not a valid next status for `task`. */
export function assertTransitionAllowed(task: RuntimeTask, to: RuntimeStatus): void {
  const allowed = getAllowedNextStatuses(task);
  if (!allowed.includes(to)) {
    throw new RuntimeTransitionError(task, to, allowed);
  }
}
