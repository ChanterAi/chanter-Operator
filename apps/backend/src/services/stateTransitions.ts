import type { StepStatus, TaskStatus } from "../types.js";

const taskTransitions: Record<TaskStatus, ReadonlySet<TaskStatus>> = {
  pending: new Set<TaskStatus>(["queued", "awaiting_approval", "cancelled"]),
  queued: new Set<TaskStatus>(["executing", "cancelled"]),
  awaiting_approval: new Set<TaskStatus>(["queued", "rejected", "cancelled"]),
  executing: new Set<TaskStatus>(["completed", "failed"]),
  completed: new Set<TaskStatus>(),
  failed: new Set<TaskStatus>(["queued", "awaiting_approval"]),
  rejected: new Set<TaskStatus>(["queued", "awaiting_approval"]),
  cancelled: new Set<TaskStatus>(["queued", "awaiting_approval"]),
};

const stepTransitions: Record<StepStatus, ReadonlySet<StepStatus>> = {
  pending_approval: new Set<StepStatus>(["approved", "rejected"]),
  approved: new Set<StepStatus>(["executing"]),
  executing: new Set<StepStatus>(["completed", "failed"]),
  completed: new Set<StepStatus>(),
  failed: new Set<StepStatus>(),
  rejected: new Set<StepStatus>(),
};

export function canTransitionTask(from: TaskStatus, to: TaskStatus): boolean {
  return taskTransitions[from].has(to);
}

export function canTransitionStep(from: StepStatus, to: StepStatus): boolean {
  return stepTransitions[from].has(to);
}

/** States from which a task can be cancelled. */
export const cancellableTaskStates = new Set<TaskStatus>(["pending", "queued", "awaiting_approval"]);

/** Terminal states from which a task can be retried/reopened. */
export const retryableTaskStates = new Set<TaskStatus>(["failed", "rejected", "cancelled"]);
